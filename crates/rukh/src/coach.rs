//! The coach's folder, `<data dir>/coach/`: games imported from text, their batches and keys.

mod join;
pub mod routes;
pub mod store;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{Mutex as Turn, OwnedMutexGuard};

use crate::hub::{now_ms, Hub};
use store::{Failure, Store};

/// Why the coach stores nothing in this program.
#[derive(Debug, Clone)]
pub struct Refusal {
    pub code: &'static str,
    pub text: String,
}

pub struct Coach {
    /// Set when this program does not hold a data folder's lock.
    off: Option<Refusal>,
    data_dir: PathBuf,
    hub: Arc<Hub>,
    /// Opened on first use; held only on blocking threads.
    store: Mutex<Option<Store>>,
    /// One text is received, read and stored at a time, so large texts never add up.
    importing: Arc<Turn<()>>,
    closed: AtomicBool,
}

pub const STOPPING: &str = "Rukh is stopping, so nothing more is stored.";

/// What this program holds of the data folder.
pub enum Holding<'a> {
    NoFolder,
    Ours(&'a Path),
    /// Another live Rukh holds it, on this port.
    Another(u16),
    Failed,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Coach {
    pub fn new(holding: Holding, hub: Arc<Hub>) -> Coach {
        let refusal = |code, text: String| Some(Refusal { code, text });

        let (off, data_dir) = match holding {
            Holding::Ours(dir) => (None, dir.to_path_buf()),
            Holding::NoFolder => (
                refusal(
                    "no_data_folder",
                    "Rukh has no data folder, so games cannot be stored. Start it with \
                     --data-dir <folder>."
                        .to_string(),
                ),
                PathBuf::new(),
            ),
            Holding::Another(port) => {
                let text = format!(
                    "Another Rukh (on port {port}) is using this data folder, so games are not \
                     stored here."
                );
                (refusal("second_program", text), PathBuf::new())
            }
            Holding::Failed => (
                refusal(
                    "folder_failed",
                    "The data folder could not be used, so games cannot be stored.".to_string(),
                ),
                PathBuf::new(),
            ),
        };

        Coach {
            off,
            data_dir,
            hub,
            store: Mutex::new(None),
            importing: Arc::new(Turn::new(())),
            closed: AtomicBool::new(false),
        }
    }

    /// Answered without waiting, so an async thread may ask.
    pub fn refusal(&self) -> Option<Refusal> {
        if self.closed.load(Ordering::Acquire) {
            return Some(Refusal {
                code: "stopping",
                text: STOPPING.to_string(),
            });
        }

        self.off.clone()
    }

    /// Waits for the turn to receive, read and store one text; the turn ends when the guard drops.
    pub async fn one_import(&self) -> OwnedMutexGuard<()> {
        self.importing.clone().lock_owned().await
    }

    /// Runs `f` on the store, making the folder on first use. Blocks: call it on a blocking thread.
    pub fn with_store<T>(
        &self,
        f: impl FnOnce(&mut Store, u64) -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        let mut store = lock(&self.store);

        if self.off.is_some() || self.closed.load(Ordering::Acquire) {
            return Err(Failure::Closed);
        }

        let now = now_ms();
        if store.is_none() {
            *store = Some(Store::open(&self.data_dir, self.hub.clone(), now)?);
        }

        match store.as_mut() {
            Some(store) => f(store, now),
            None => Err(Failure::Closed),
        }
    }

    /// Like [`Coach::with_store`], but answers `absent` when there is no coach folder.
    pub fn with_made_store<T>(
        &self,
        absent: Failure,
        f: impl FnOnce(&mut Store, u64) -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        if self.off.is_none() && !self.data_dir.join("coach").is_dir() {
            return Err(absent);
        }

        self.with_store(f)
    }

    /// Waits for the call in progress, then refuses every later one. Blocks.
    pub fn close(&self) {
        let _store = lock(&self.store);
        self.closed.store(true, Ordering::Release);
    }
}
