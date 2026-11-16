//! The one place the games change.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rukh_core::{Applied, Desk, Error, Seat, Side, TabId, TabKind, Table};
use tokio::sync::watch;

use crate::presence::Presence;

/// Why [`Hub::apply_seated`] changed nothing.
#[derive(Debug)]
pub enum Refused {
    /// An AI plays a match on the tab with this name.
    Elsewhere(String),
    Core(Error),
}

#[derive(Debug)]
pub struct Frame {
    pub rev: u64,
    pub json: String,
}

pub struct Hub {
    inner: Mutex<Desk>,
    tx: watch::Sender<Arc<Frame>>,
    instance: String,
    presence: Arc<Presence>,
    sessions: AtomicU64,
}

/// Milliseconds since the Unix epoch, as frames carry it.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Lets a view tell a restarted program from the old one.
pub fn new_instance_id() -> String {
    let mut hasher = RandomState::new().build_hasher();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    hasher.write_u128(nanos);
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

/// True while a match is running and its game has no result at the tip.
pub fn in_progress(table: &Table) -> bool {
    table.match_state().active && table.tip_result().is_none()
}

/// The AI seat of an active match when exactly one seat is an AI.
pub fn only_ai_seat(table: &Table) -> Option<Side> {
    let m = table.match_state();
    if !m.active {
        return None;
    }

    match (m.seats.white == Seat::Ai, m.seats.black == Seat::Ai) {
        (true, false) => Some(Side::White),
        (false, true) => Some(Side::Black),
        _ => None,
    }
}

/// The AI seat whose turn it is at the tip.
fn owed_seat(table: &Table) -> Option<Side> {
    [Side::White, Side::Black]
        .into_iter()
        .find(|side| table.is_ai_turn(*side))
}

impl Hub {
    pub fn new(instance: String) -> Hub {
        let desk = Desk::new(&instance);
        let first = Frame {
            rev: desk.rev(),
            json: desk.frame(now_ms()),
        };

        let (tx, _rx) = watch::channel(Arc::new(first));

        Hub {
            inner: Mutex::new(desk),
            tx,
            instance,
            presence: Presence::new(),
            sessions: AtomicU64::new(0),
        }
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    pub fn presence(&self) -> &Arc<Presence> {
        &self.presence
    }

    /// Frames of the shown tab; a change on any tab sends one.
    pub fn subscribe(&self) -> watch::Receiver<Arc<Frame>> {
        self.tx.subscribe()
    }

    pub fn latest(&self) -> Arc<Frame> {
        self.tx.borrow().clone()
    }

    fn lock(&self) -> MutexGuard<'_, Desk> {
        // The desk stays consistent across a panic: see docs/program.md.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads the selected tab's table under the lock. `f` must not wait on anything.
    pub fn read<T>(&self, f: impl FnOnce(&Table) -> T) -> T {
        f(self.lock().shown())
    }

    /// Reads one tab's table; `None` when the tab is not open.
    pub fn read_on<T>(&self, tab: TabId, f: impl FnOnce(&Table) -> T) -> Option<T> {
        self.lock().table(tab).map(f)
    }

    /// Reads the whole desk under the lock.
    pub fn read_desk<T>(&self, f: impl FnOnce(&Desk) -> T) -> T {
        f(&self.lock())
    }

    pub fn selected(&self) -> TabId {
        self.lock().selected()
    }

    pub fn has_tab(&self, tab: TabId) -> bool {
        self.lock().tab(tab).is_some()
    }

    pub fn tab_name(&self, tab: TabId) -> Option<String> {
        self.lock().tab(tab).map(|t| t.name().to_string())
    }

    /// A game intent for the selected tab. `by` is `view:<k>` or `ai:<name>`.
    pub fn apply(
        &self,
        by: &str,
        intent_json: &str,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        let mut desk = self.lock();
        let tab = desk.selected();
        let applied = desk.apply_on(tab, by, intent_json, now_ms(), intent_id)?;

        self.publish(&desk, &applied);
        Ok(applied)
    }

    /// A game intent for one tab, shown or not.
    pub fn apply_on(
        &self,
        tab: TabId,
        by: &str,
        intent_json: &str,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        let mut desk = self.lock();
        let applied = desk.apply_on(tab, by, intent_json, now_ms(), intent_id)?;

        self.publish(&desk, &applied);
        Ok(applied)
    }

    /// A tab intent, or a game intent for the tab it names (the selected tab when it names none).
    pub fn apply_desk(
        &self,
        by: &str,
        intent_json: &str,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        let mut desk = self.lock();
        let applied = desk.apply_with_id(by, intent_json, now_ms(), intent_id)?;

        self.publish(&desk, &applied);
        Ok(applied)
    }

    /// A game intent by an AI that plays `seat` on `tab`, which it then holds; see docs/program.md.
    pub fn apply_seated(
        &self,
        tab: TabId,
        by: &str,
        name: &str,
        seat: Side,
        intent_json: &str,
    ) -> Result<Applied, Refused> {
        let mut desk = self.lock();

        if let Some(other) = self.held_match_besides(&desk, tab) {
            return Err(Refused::Elsewhere(other));
        }

        let applied = desk
            .apply_on(tab, by, intent_json, now_ms(), None)
            .map_err(Refused::Core)?;
        self.publish(&desk, &applied);

        if let Some(table) = desk.table(tab) {
            let m = table.match_state();
            if m.active && m.seats.get(seat) == Seat::Ai {
                self.presence
                    .hold_seat(by, name, seat, tab, owed_seat(table));
            }
        }

        Ok(applied)
    }

    /// Sends the shown frame before the lock is released, then brings presence up to date.
    fn publish(&self, desk: &Desk, applied: &Applied) {
        if !applied.changed {
            return;
        }

        self.tx.send_replace(Arc::new(Frame {
            rev: applied.rev,
            json: applied.frame_json.clone(),
        }));

        // Only the AI match's own table decides who still holds its seats.
        let Some(tab) = self.presence.ai_tab() else {
            return;
        };

        match desk.table(tab) {
            Some(table) => {
                let m = table.match_state();
                self.presence.reconcile(
                    m.active,
                    [m.seats.white == Seat::Ai, m.seats.black == Seat::Ai],
                    owed_seat(table),
                );
            }
            None => self.presence.forget_tab(tab),
        }
    }

    /// The `(by, shown name)` holding `seat` on `tab`.
    pub fn holder_on(&self, tab: TabId, seat: Side) -> Option<(String, String)> {
        if self.presence.ai_tab() != Some(tab) {
            return None;
        }

        self.presence.holder_of(seat)
    }

    /// The seat `by` holds on `tab`, while it is an AI seat of an active match.
    pub fn held_seat(&self, tab: TabId, by: &str) -> Option<Side> {
        let desk = self.lock();
        self.held_seat_in(&desk, tab, by)
    }

    /// As [`Hub::held_seat`], inside [`Hub::read_desk`].
    pub fn held_seat_in(&self, desk: &Desk, tab: TabId, by: &str) -> Option<Side> {
        let table = desk.table(tab)?;

        if self.presence.ai_tab() != Some(tab) {
            return None;
        }

        let m = table.match_state();
        self.presence
            .seat_of(by)
            .filter(|side| m.active && m.seats.get(*side) == Seat::Ai)
    }

    /// An AI seat of a match in progress on `tab` that nobody but `by` holds.
    pub fn seat_open(&self, tab: TabId, seat: Side, by: &str) -> bool {
        let desk = self.lock();
        self.seat_open_in(&desk, tab, seat, by)
    }

    fn seat_open_in(&self, desk: &Desk, tab: TabId, seat: Side, by: &str) -> bool {
        let Some(table) = desk.table(tab) else {
            return false;
        };

        in_progress(table)
            && table.match_state().seats.get(seat) == Seat::Ai
            && self
                .holder_on(tab, seat)
                .is_none_or(|(holder, _)| holder == by)
    }

    /// Every tab with an open AI seat, `seat` or else its one AI seat, in strip order.
    pub fn open_seats(&self, seat: Option<Side>, by: &str) -> Vec<(TabId, Side)> {
        let desk = self.lock();

        desk.tabs()
            .iter()
            .filter_map(|tab| {
                let side = seat.or_else(|| only_ai_seat(tab.table()))?;
                self.seat_open_in(&desk, tab.id(), side, by)
                    .then_some((tab.id(), side))
            })
            .collect()
    }

    /// A free tab with no stored game and no active match: a seat claim starts a match there.
    pub fn is_free_board(&self, tab: TabId) -> bool {
        self.lock().tab(tab).is_some_and(|t| {
            t.kind() == TabKind::Free && t.source().is_none() && !t.table().match_state().active
        })
    }

    /// The name of another tab whose match in progress has an AI seat someone holds.
    pub fn ai_playing_elsewhere(&self, tab: TabId) -> Option<String> {
        let desk = self.lock();
        self.held_match_besides(&desk, tab)
    }

    fn held_match_besides(&self, desk: &Desk, tab: TabId) -> Option<String> {
        let other = self.presence.ai_tab().filter(|t| *t != tab)?;
        let held = desk.tab(other)?;

        let seats = held.table().match_state().seats;
        let holds = [Side::White, Side::Black]
            .into_iter()
            .any(|side| seats.get(side) == Seat::Ai && self.presence.holder_of(side).is_some());

        (in_progress(held.table()) && holds).then(|| held.name().to_string())
    }

    /// Records that `by` holds `seat` on `tab`; refused with the other tab's name while an AI plays there.
    pub fn hold_seat(&self, tab: TabId, by: &str, name: &str, seat: Side) -> Result<(), String> {
        let desk = self.lock();

        if let Some(other) = self.held_match_besides(&desk, tab) {
            return Err(other);
        }

        if let Some(table) = desk.table(tab) {
            self.presence
                .hold_seat(by, name, seat, tab, owed_seat(table));
        }
        Ok(())
    }

    /// Unique for this program start.
    pub fn next_session(&self) -> u64 {
        self.sessions.fetch_add(1, Ordering::Relaxed) + 1
    }
}
