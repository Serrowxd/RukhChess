//! The one place the game changes.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rukh_core::{Applied, Error, Seat, Side, Table};
use tokio::sync::watch;

use crate::presence::Presence;

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

    pub fn subscribe(&self) -> watch::Receiver<Arc<Frame>> {
        self.tx.subscribe()
    }

    pub fn latest(&self) -> Arc<Frame> {
        self.tx.borrow().clone()
    }

    fn lock(&self) -> MutexGuard<'_, Table> {
        // The table stays consistent across a panic: see docs/program.md.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads the table under the lock. `f` must not wait on anything.
    pub fn read<T>(&self, f: impl FnOnce(&Table) -> T) -> T {
        f(&self.lock())
    }

    /// `by` is `view:<k>` or `ai:<name>`; the frame is published before the lock is released.
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

            // The person may have stopped the match or handed a seat to someone else.
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

    /// Unique for this program start.
    pub fn next_session(&self) -> u64 {
        self.sessions.fetch_add(1, Ordering::Relaxed) + 1
    }
}
