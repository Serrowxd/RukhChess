//! Intents: the requests views and AI clients send to change the table.
//!
//! An intent is a JSON object tagged by `op` (snake_case). Unknown fields are ignored, so a
//! transport may pass its whole message (for example a WebSocket `{"t":"intent","id":4,...}`)
//! without picking the intent out first.

use serde::Deserialize;
use serde_json::Value;

use crate::session::Seats;
use crate::{Eval, NodeId};

/// How an annotation is combined with what the node already holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnnotateMode {
    /// A non-empty note replaces the old one, a glyph replaces the old one, arrows are appended
    /// (an arrow on the same two squares is replaced), highlights are merged by square.
    #[default]
    Add,
    /// Every field that is given replaces what the node holds; an empty value clears it.
    Replace,
    /// Clears the fields that are given (all four when none is given). Given arrows or
    /// highlights remove only the matching ones; an empty list removes them all.
    Clear,
}

/// One request to change the table.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Intent {
    /// Play a move in SAN or UCI, optionally guarded by the node it must be played from, with
    /// annotations that land on the new move in the same change.
    Play {
        #[serde(rename = "move")]
        mv: String,
        #[serde(default)]
        from_node: Option<NodeId>,
        #[serde(default)]
        note: Option<String>,
        #[serde(default)]
        nag: Option<String>,
        /// Each item `{from, to, color?}`; checked one by one so a bad item is reported, not fatal.
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
    /// Start a match from the current node.
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
    /// An AI takes a seat. If no match is active this starts one with the other seat human.
    ClaimSeat {
        seat: crate::session::Side,
    },
}

impl Intent {
    /// Reads an intent from JSON text. The error text says what was wrong.
    pub fn from_json(text: &str) -> Result<Intent, crate::Error> {
        serde_json::from_str(text)
            .map_err(|e| crate::Error::BadInput(format!("the intent could not be read: {e}")))
    }
}
