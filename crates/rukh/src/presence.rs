//! Who is looking at the board and which AI clients are connected. Not game state.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rukh_core::{Side, TabId};
use serde_json::json;
use tokio::sync::watch;

/// How long an HTTP MCP client stays listed after its last request.
pub const AI_PRESENT_FOR: Duration = Duration::from_secs(90);

/// The same for a client that owes the match a move.
pub const AI_OWES_MOVE_FOR: Duration = Duration::from_secs(300);

pub const TICK: Duration = Duration::from_secs(5);

/// Keeps `idle_s` from going stale for long.
const REFRESH_EVERY: Duration = Duration::from_secs(15);

const MAX_NAME_CHARS: usize = 64;

struct Ai {
    name: String,
    /// Open `wait` calls.
    waiting: u32,
    last_seen: Instant,
}

struct Inner {
    views: u32,
    /// Keyed by `by` (`ai:<name>`).
    ais: BTreeMap<String, Ai>,
    /// Every `by` handed out, with its MCP session. Never reused.
    sessions: BTreeMap<String, u64>,
    /// White, then black, on `ai_tab`.
    holders: [Option<String>; 2],
    /// The tab of the AI match; one at a time.
    ai_tab: Option<TabId>,
    /// The AI seat the running match is waiting on.
    owed: Option<Side>,
    /// The last message without `idle_s`, to tell a real change from the clock moving.
    shape: String,
    published_at: Instant,
}

pub struct Presence {
    inner: Mutex<Inner>,
    tx: watch::Sender<Arc<String>>,
}

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

/// Bidi controls, zero-width and other format characters that could disguise a name.
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
    /// When `by` holds both seats, the one the match is waiting on.
    fn seat_of(&self, by: &str) -> Option<Side> {
        let holds = |side: Side| self.holders[slot(side)].as_deref() == Some(by);

        match (holds(Side::White), holds(Side::Black)) {
            (true, true) => Some(self.owed.unwrap_or(Side::White)),
            (true, false) => Some(Side::White),
            (false, true) => Some(Side::Black),
            (false, false) => None,
        }
    }

    /// `(by, shown name, entry)`; repeated names are shown as `name (2)`, ...
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
                    "tab": self.seat_of(by).and(self.ai_tab),
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
        let tab = self.ai_tab.map(|t| t.to_string());

        format!("{}|{tab:?}|{ais:?}", self.views)
    }

    fn message(&self, now: Instant) -> String {
        json!({"t": "presence", "views": self.views, "ais": self.entries(now)}).to_string()
    }

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
            ai_tab: None,
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

    /// Sends only when something a person would see changed, or with `refresh` once it is stale.
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

    pub fn subscribe(&self) -> watch::Receiver<Arc<String>> {
        self.tx.subscribe()
    }

    pub fn message(&self) -> String {
        self.lock().message(Instant::now())
    }

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

    pub fn seen(&self, by: &str, name: &str) {
        let mut inner = self.lock();
        Presence::touch(&mut inner, by, name);
        self.publish(&mut inner, false);
    }

    /// Takes `seat` on `tab` over from any other client; holders on another tab are dropped.
    pub fn hold_seat(&self, by: &str, name: &str, seat: Side, tab: TabId, owed: Option<Side>) {
        let mut inner = self.lock();
        Presence::touch(&mut inner, by, name);

        if inner.ai_tab != Some(tab) {
            inner.holders = [None, None];
            inner.ai_tab = Some(tab);
        }

        inner.holders[slot(seat)] = Some(by.to_string());
        inner.owed = owed;
        self.publish(&mut inner, false);
    }

    pub fn ai_tab(&self) -> Option<TabId> {
        self.lock().ai_tab
    }

    /// The AI match's tab was closed: nobody holds a seat any more.
    pub fn forget_tab(&self, tab: TabId) {
        let mut inner = self.lock();
        if inner.ai_tab != Some(tab) {
            return;
        }

        inner.holders = [None, None];
        inner.ai_tab = None;
        inner.owed = None;
        self.publish(&mut inner, false);
    }

    pub fn seat_of(&self, by: &str) -> Option<Side> {
        self.lock().seat_of(by)
    }

    /// `(by, shown name)`; a holder that is no longer listed does not count.
    pub fn holder_of(&self, seat: Side) -> Option<(String, String)> {
        let inner = self.lock();
        let by = inner.holders[slot(seat)].as_deref()?;

        inner
            .listed()
            .into_iter()
            .find(|(b, _, _)| *b == by)
            .map(|(b, shown, _)| (b.to_string(), shown))
    }

    /// `ai:<name>` for the first session with that name, then `ai:<name>#<session>`.
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

    /// From the AI match's table: a seat no longer an AI seat of an active match is held by nobody.
    pub fn reconcile(&self, active: bool, ai_seats: [bool; 2], owed: Option<Side>) {
        let mut inner = self.lock();

        for (holder, is_ai) in inner.holders.iter_mut().zip(ai_seats) {
            if !active || !is_ai {
                *holder = None;
            }
        }

        if inner.holders.iter().all(Option::is_none) {
            inner.ai_tab = None;
        }

        inner.owed = owed;
        self.publish(&mut inner, false);
    }

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

    pub fn tick(&self) {
        self.tick_at(Instant::now());
    }

    pub fn tick_at(&self, now: Instant) {
        let mut inner = self.lock();
        inner.expire(now);
        self.publish(&mut inner, true);
    }
}

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
