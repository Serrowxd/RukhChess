//! Intents: the requests views and AI clients send to change the table.

use serde::Deserialize;
use serde_json::Value;

use crate::session::Seats;
use crate::{Eval, NodeId};

/// How an annotation is combined with what the node already holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnnotateMode {
    #[default]
    Add,
    Replace,
    Clear,
}

/// One request to change the table, tagged by `op`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Intent {
    Play {
        #[serde(rename = "move")]
        mv: String,
        #[serde(default)]
        from_node: Option<NodeId>,
        #[serde(default)]
        note: Option<String>,
        #[serde(default)]
        nag: Option<String>,
        /// Each item `{from, to, color?}`, checked one by one.
        #[serde(default)]
        arrows: Option<Vec<Value>>,
        /// Each item `{square, color?}`.
        #[serde(default)]
        highlights: Option<Vec<Value>>,
    },
    Goto {
        node: NodeId,
    },
    Back,
    Forward,
    ToStart,
    ToEnd,
    /// Annotate a node (the current one when `node` is left out) without moving the board.
    Annotate {
        #[serde(default)]
        node: Option<NodeId>,
        #[serde(default)]
        note: Option<String>,
        #[serde(default)]
        nag: Option<String>,
        #[serde(default)]
        arrows: Option<Vec<Value>>,
        #[serde(default)]
        highlights: Option<Vec<Value>>,
        #[serde(default)]
        mode: AnnotateMode,
    },
    /// Store (or clear, with `null`) an engine evaluation on a node.
    SetEval {
        node: NodeId,
        #[serde(default)]
        eval: Option<Eval>,
    },
    /// Start a new game from a FEN, a Chess960 number (0..959), or the classical position.
    NewGame {
        #[serde(default)]
        fen: Option<String>,
        #[serde(default)]
        chess960: Option<u16>,
    },
    MatchStart {
        seats: Seats,
        #[serde(default)]
        style: Option<String>,
    },
    MatchStop,
    SetSeats(Seats),
    SetStyle {
        style: String,
    },
    /// An AI takes a seat, starting a match with the other seat human if none is active.
    ClaimSeat {
        seat: crate::session::Side,
    },
}

impl Intent {
    pub fn from_json(text: &str) -> Result<Intent, crate::Error> {
        serde_json::from_str(text)
            .map_err(|e| crate::Error::BadInput(format!("the intent could not be read: {e}")))
    }
}
