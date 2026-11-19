//! `state.json`: the program's counters.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::batch::MAX_ID;
use crate::version::{load, Loaded};

pub const STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub v: u32,
    /// The number the next game file gets.
    pub next_game: u64,
    pub next_batch: u64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for State {
    fn default() -> State {
        State {
            v: STATE_VERSION,
            next_game: 1,
            next_batch: 1,
            extra: BTreeMap::new(),
        }
    }
}

impl State {
    /// Counters past the highest id a file name can hold are not readable.
    pub fn from_text(text: &str) -> Option<State> {
        match State::loaded(text) {
            Loaded::Read(read) => Some(read),
            Loaded::Newer(_) | Loaded::Unreadable => None,
        }
    }

    pub fn loaded(text: &str) -> Loaded<State> {
        load(text, u64::from(STATE_VERSION), |state: &State| {
            let sane = |n: u64| (1..=MAX_ID).contains(&n);
            sane(state.next_game) && sane(state.next_batch)
        })
    }

    pub fn to_text(&self) -> String {
        let mut text = serde_json::to_string(self).unwrap_or_default();
        text.push('\n');
        text
    }

    /// Raises the counters above the highest numbers found on disk; true when either moved.
    pub fn raise(&mut self, highest_game: u64, highest_batch: u64) -> bool {
        let before = (self.next_game, self.next_batch);

        self.next_game = self.next_game.max(highest_game.saturating_add(1)).max(1);
        self.next_batch = self.next_batch.max(highest_batch.saturating_add(1)).max(1);

        before != (self.next_game, self.next_batch)
    }

    /// The next game number, and the counter moved past it; `None` once the ids are used up.
    pub fn take_game(&mut self) -> Option<u64> {
        take(&mut self.next_game)
    }

    pub fn take_batch(&mut self) -> Option<u64> {
        take(&mut self.next_batch)
    }
}

fn take(counter: &mut u64) -> Option<u64> {
    let n = *counter;
    if n == 0 || n > MAX_ID {
        return None;
    }

    *counter = n + 1;
    Some(n)
}
