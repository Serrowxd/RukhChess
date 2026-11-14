//! The one place the game changes.
//!
//! Every view and every AI client goes through [`Hub`]. It holds the table (the game, the match
//! and the counters) behind one lock and publishes the full frame after each change on a watch
//! channel, so a late or slow reader always ends up on the latest frame. Nothing is awaited while
//! the lock is held.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rukh_core::{Applied, Error, Seat, Side, Table};
use tokio::sync::watch;

use crate::presence::Presence;

/// One published state: its counter and the JSON text sent to views.
#[derive(Debug)]
pub struct Frame {
    pub rev: u64,
    pub json: String,
}

pub struct Hub {
    inner: Mutex<Table>,
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

/// A random id for this program start, so a view can tell a restarted program from the old one.
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

impl Hub {
    pub fn new(instance: String) -> Hub {
        let table = Table::new(&instance);
        let first = Frame {
            rev: table.rev(),
            json: table.frame(now_ms()),
        };
        let (tx, _rx) = watch::channel(Arc::new(first));
        Hub {
            inner: Mutex::new(table),
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

    /// A receiver that starts on the latest frame and sees every later one (or at least the last).
    pub fn subscribe(&self) -> watch::Receiver<Arc<Frame>> {
        self.tx.subscribe()
    }

    /// The latest published frame.
    pub fn latest(&self) -> Arc<Frame> {
        self.tx.borrow().clone()
    }

    fn lock(&self) -> MutexGuard<'_, Table> {
        // A refused intent changes nothing and an applied one is published before the lock is
        // released, so after a panic elsewhere the table is still a consistent state.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads the table under the lock. `f` must not wait on anything.
    pub fn read<T>(&self, f: impl FnOnce(&Table) -> T) -> T {
        f(&self.lock())
    }

    /// Applies one intent (JSON text tagged by `op`) for `by` (`view:<k>` or `ai:<name>`). When it
    /// changed something, the new frame is published before the lock is released, so frames leave
    /// in the same order as the changes that made them.
    pub fn apply(
        &self,
        by: &str,
        intent_json: &str,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        let mut table = self.lock();
        let applied = table.apply_with_id(by, intent_json, now_ms(), intent_id)?;
        if applied.changed {
            self.tx.send_replace(Arc::new(Frame {
                rev: applied.rev,
                json: applied.frame_json.clone(),
            }));
            // Seats shown in presence follow the match: the person may have stopped it, started a
            // new game or given a seat to someone else.
            let m = table.match_state();
            let owed = [Side::White, Side::Black]
                .into_iter()
                .find(|side| table.is_ai_turn(*side));
            self.presence.reconcile(
                m.active,
                [m.seats.white == Seat::Ai, m.seats.black == Seat::Ai],
                owed,
            );
        }
        Ok(applied)
    }

    /// A number for a new MCP session, unique for this program start.
    pub fn next_session(&self) -> u64 {
        self.sessions.fetch_add(1, Ordering::Relaxed) + 1
    }
}
