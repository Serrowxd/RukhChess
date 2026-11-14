//! Who is looking at the board and which AI clients are connected.
//!
//! Presence is not game state: it never touches `rev` or `board_rev`. It is published on its own
//! watch channel as the `{"t":"presence",...}` message every view receives.
//!
//! An HTTP MCP client counts as present while it is inside a `wait`, for [`AI_PRESENT_FOR`]
//! after its last request, and for [`AI_OWES_MOVE_FOR`] while it holds the seat whose move the
//! match is waiting for (a model may think for longer than that before it plays).
//!
//! Which client holds which AI seat is kept apart from the expiring client list, and the hub
//! re-reads it against the match after every change, so a seat the person took back or a match
//! the person stopped is never shown as still held.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rukh_core::Side;
use serde_json::json;
use tokio::sync::watch;

/// How long an HTTP MCP client stays listed after its last request.
pub const AI_PRESENT_FOR: Duration = Duration::from_secs(90);

/// How long a client that owes the match a move stays listed after its last request.
pub const AI_OWES_MOVE_FOR: Duration = Duration::from_secs(300);

/// How often the ticker drops clients that went quiet.
pub const TICK: Duration = Duration::from_secs(5);

/// A presence message is sent again at least this often, so `idle_s` does not go stale for long.
const REFRESH_EVERY: Duration = Duration::from_secs(15);

/// Longest client name kept, in characters.
const MAX_NAME_CHARS: usize = 64;

struct Ai {
    name: String,
    /// Number of `wait` calls this client has open right now.
    waiting: u32,
    last_seen: Instant,
}

struct Inner {
    views: u32,
    /// Keyed by the `by` string the client acts as (`ai:<name>`).
    ais: BTreeMap<String, Ai>,
    /// Every `by` handed out, with the MCP session it belongs to. Never reused.
    sessions: BTreeMap<String, u64>,
    /// The client (`by`) holding each AI seat of the running match: white, then black.
    holders: [Option<String>; 2],
    /// The AI seat the running match is waiting on, if any. Its holder is never expired.
    owed: Option<Side>,
    /// The last published message without `idle_s`, to tell a real change from the clock moving.
    shape: String,
    published_at: Instant,
}

pub struct Presence {
    inner: Mutex<Inner>,
    tx: watch::Sender<Arc<String>>,
}

/// Counts one open view while it lives.
pub struct ViewGuard {
    presence: Arc<Presence>,
}

impl Drop for ViewGuard {
    fn drop(&mut self) {
        let mut inner = self.presence.lock();
        inner.views = inner.views.saturating_sub(1);
        self.presence.publish(&mut inner, false);
    }
}

/// Marks one client as inside a `wait` while it lives.
pub struct WaitGuard {
    presence: Arc<Presence>,
    by: String,
}

impl Drop for WaitGuard {
    fn drop(&mut self) {
        let mut inner = self.presence.lock();
        if let Some(ai) = inner.ais.get_mut(&self.by) {
            ai.waiting = ai.waiting.saturating_sub(1);
            ai.last_seen = Instant::now();
        }
        self.presence.publish(&mut inner, false);
    }
}

/// Characters that change how text around them is shown without being visible themselves:
/// bidirectional controls, zero-width characters and other format characters. A client name
/// must not carry them, or it could show reversed or as something it is not.
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{17B4}'
            | '\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0000}'..='\u{E007F}'
    )
}

/// A client name as shown to people: control and invisible format characters dropped, runs of
/// whitespace made one space, trimmed, cut short.
pub fn clean_name(name: &str) -> String {
    let visible: String = name
        .chars()
        .filter(|c| !c.is_control() && !is_invisible_format(*c))
        .collect();
    let cleaned: String = visible
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    if cleaned.is_empty() {
        "AI client".to_string()
    } else {
        cleaned
    }
}

fn slot(side: Side) -> usize {
    match side {
        Side::White => 0,
        Side::Black => 1,
    }
}

impl Inner {
    /// The seat `by` holds: the one the match is waiting on if it holds both, else either.
    fn seat_of(&self, by: &str) -> Option<Side> {
        let holds = |side: Side| self.holders[slot(side)].as_deref() == Some(by);
        match (holds(Side::White), holds(Side::Black)) {
            (true, true) => Some(self.owed.unwrap_or(Side::White)),
            (true, false) => Some(Side::White),
            (false, true) => Some(Side::Black),
            (false, false) => None,
        }
    }

    /// The listed clients as `(by, shown name, entry)`. Two clients with the same name are told
    /// apart as `name`, `name (2)`, ...
    fn listed(&self) -> Vec<(&str, String, &Ai)> {
        let mut seen: BTreeMap<&str, u32> = BTreeMap::new();
        let mut in_order: Vec<(&String, &Ai)> = self.ais.iter().collect();
        in_order.sort_by_key(|(by, _)| self.sessions.get(*by).copied().unwrap_or(u64::MAX));
        in_order
            .into_iter()
            .map(|(by, ai)| {
                let n = seen.entry(ai.name.as_str()).or_insert(0);
                *n += 1;
                let shown = if *n == 1 {
                    ai.name.clone()
                } else {
                    format!("{} ({n})", ai.name)
                };
                (by.as_str(), shown, ai)
            })
            .collect()
    }

    fn entries(&self, now: Instant) -> Vec<serde_json::Value> {
        self.listed()
            .into_iter()
            .map(|(by, shown, ai)| {
                json!({
                    "name": shown,
                    "transport": "http",
                    "seat": self.seat_of(by).map(Side::name),
                    "waiting": ai.waiting > 0,
                    "idle_s": now.saturating_duration_since(ai.last_seen).as_secs(),
                })
            })
            .collect()
    }

    fn shape(&self) -> String {
        let ais: Vec<_> = self
            .listed()
            .into_iter()
            .map(|(by, shown, ai)| (shown, self.seat_of(by).map(Side::name), ai.waiting > 0))
            .collect();
        format!("{}|{ais:?}", self.views)
    }

    fn message(&self, now: Instant) -> String {
        json!({"t": "presence", "views": self.views, "ais": self.entries(now)}).to_string()
    }

    /// Drops clients that are not waiting and have been quiet for [`AI_PRESENT_FOR`], or for
    /// [`AI_OWES_MOVE_FOR`] when they hold the seat the match is waiting on.
    fn expire(&mut self, now: Instant) {
        let owed_holder = self.owed.and_then(|side| self.holders[slot(side)].clone());
        self.ais.retain(|by, ai| {
            let quiet = now.saturating_duration_since(ai.last_seen);
            let allowed = if owed_holder.as_deref() == Some(by.as_str()) {
                AI_OWES_MOVE_FOR
            } else {
                AI_PRESENT_FOR
            };
            ai.waiting > 0 || quiet < allowed
        });
    }
}

impl Presence {
    pub fn new() -> Arc<Presence> {
        let now = Instant::now();
        let mut inner = Inner {
            views: 0,
            ais: BTreeMap::new(),
            sessions: BTreeMap::new(),
            holders: [None, None],
            owed: None,
            shape: String::new(),
            published_at: now,
        };
        inner.shape = inner.shape();
        let first = inner.message(now);
        let (tx, _rx) = watch::channel(Arc::new(first));
        Arc::new(Presence {
            inner: Mutex::new(inner),
            tx,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Presence is a few counters; after a panic elsewhere they are still usable.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Publishes the current presence when something a person would see changed: the number of
    /// views, or a client's name, seat or waiting flag. With `refresh`, it is also sent when the
    /// last message is older than [`REFRESH_EVERY`], so `idle_s` moves on.
    fn publish(&self, inner: &mut Inner, refresh: bool) {
        let now = Instant::now();
        let shape = inner.shape();
        let due = refresh && now.saturating_duration_since(inner.published_at) >= REFRESH_EVERY;
        if shape == inner.shape && !due {
            return;
        }
        inner.shape = shape;
        inner.published_at = now;
        self.tx.send_replace(Arc::new(inner.message(now)));
    }

    /// A receiver for presence messages, starting on the latest one.
    pub fn subscribe(&self) -> watch::Receiver<Arc<String>> {
        self.tx.subscribe()
    }

    /// The presence message as it stands now.
    pub fn message(&self) -> String {
        self.lock().message(Instant::now())
    }

    /// Number of open views.
    pub fn views(&self) -> u32 {
        self.lock().views
    }

    /// Counts a view until the guard is dropped.
    pub fn view_joined(self: &Arc<Presence>) -> ViewGuard {
        let mut inner = self.lock();
        inner.views += 1;
        self.publish(&mut inner, false);
        drop(inner);
        ViewGuard {
            presence: self.clone(),
        }
    }

    fn touch<'a>(inner: &'a mut Inner, by: &str, name: &str) -> &'a mut Ai {
        let ai = inner.ais.entry(by.to_string()).or_insert_with(|| Ai {
            name: name.to_string(),
            waiting: 0,
            last_seen: Instant::now(),
        });
        ai.name = name.to_string();
        ai.last_seen = Instant::now();
        ai
    }

    /// Records a request from an AI client.
    pub fn seen(&self, by: &str, name: &str) {
        let mut inner = self.lock();
        Presence::touch(&mut inner, by, name);
        self.publish(&mut inner, false);
    }

    /// Records that `by` holds `seat` (an AI seat of the running match), taking it over from any
    /// other client.
    pub fn set_seat(&self, by: &str, name: &str, seat: Side) {
        let mut inner = self.lock();
        Presence::touch(&mut inner, by, name);
        inner.holders[slot(seat)] = Some(by.to_string());
        self.publish(&mut inner, false);
    }

    /// The seat this client holds in the running match, if any.
    pub fn seat_of(&self, by: &str) -> Option<Side> {
        self.lock().seat_of(by)
    }

    /// The listed client holding `seat`, as `(by, shown name)`. A holder that is no longer
    /// listed does not count, so a client that went away cannot keep a seat from another.
    pub fn holder_of(&self, seat: Side) -> Option<(String, String)> {
        let inner = self.lock();
        let by = inner.holders[slot(seat)].as_deref()?;
        inner
            .listed()
            .into_iter()
            .find(|(b, _, _)| *b == by)
            .map(|(b, shown, _)| (b.to_string(), shown))
    }

    /// The `by` string for a new MCP session of a client called `name`, and lists it. The first
    /// session with that name is `ai:<name>`, every later one `ai:<name>#<session>`, so no
    /// session ever acts as another, even one that has gone quiet.
    pub fn identify(&self, name: &str, session: u64) -> String {
        let mut inner = self.lock();
        let mut by = format!("ai:{name}");
        while inner.sessions.contains_key(&by) {
            by = format!("{by}#{session}");
        }
        inner.sessions.insert(by.clone(), session);
        Presence::touch(&mut inner, &by, name);
        self.publish(&mut inner, false);
        by
    }

    /// Re-reads the seats against the match after a change: a seat that is no longer an AI seat
    /// of an active match is held by nobody. `owed` is the AI seat the match waits on now.
    pub fn reconcile(&self, active: bool, ai_seats: [bool; 2], owed: Option<Side>) {
        let mut inner = self.lock();
        for (holder, is_ai) in inner.holders.iter_mut().zip(ai_seats) {
            if !active || !is_ai {
                *holder = None;
            }
        }
        inner.owed = owed;
        self.publish(&mut inner, false);
    }

    /// True while the client has a `wait` open.
    pub fn is_waiting(&self, by: &str) -> bool {
        self.lock().ais.get(by).is_some_and(|ai| ai.waiting > 0)
    }

    /// Marks the client as waiting until the guard is dropped.
    pub fn wait_started(self: &Arc<Presence>, by: &str, name: &str) -> WaitGuard {
        let mut inner = self.lock();
        Presence::touch(&mut inner, by, name).waiting += 1;
        self.publish(&mut inner, false);
        drop(inner);
        WaitGuard {
            presence: self.clone(),
            by: by.to_string(),
        }
    }

    /// Drops quiet clients and refreshes the message now and then. Called by the ticker.
    pub fn tick(&self) {
        self.tick_at(Instant::now());
    }

    /// As [`Presence::tick`], as if it were `now`.
    pub fn tick_at(&self, now: Instant) {
        let mut inner = self.lock();
        inner.expire(now);
        self.publish(&mut inner, true);
    }
}

/// Runs [`Presence::tick`] every [`TICK`] until `stop` turns true.
pub async fn run_ticker(presence: Arc<Presence>, mut stop: watch::Receiver<bool>) {
    let mut every = tokio::time::interval(TICK);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = every.tick() => presence.tick(),
            _ = stop.wait_for(|stopping| *stopping) => break,
        }
    }
}
