//! One game as read from text, in the neutral form the program hands over.

use serde::{Deserialize, Serialize};

use crate::ending::FinalPosition;

/// The tags an import reads, as written in the text: cut, not cleaned.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextTags {
    pub site: Option<String>,
    pub link: Option<String>,
    pub game_id: Option<String>,
    pub white: Option<String>,
    pub black: Option<String>,
    pub white_elo: Option<String>,
    pub black_elo: Option<String>,
    pub white_title: Option<String>,
    pub black_title: Option<String>,
    pub time_control: Option<String>,
    pub termination: Option<String>,
    pub utc_date: Option<String>,
    pub utc_time: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Variant {
    Standard,
    Chess960,
}

impl Variant {
    pub fn as_str(self) -> &'static str {
        match self {
            Variant::Standard => "standard",
            Variant::Chess960 => "chess960",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextMove {
    pub san: String,
    pub uci: String,
    /// The mover's clock after the move, in milliseconds.
    pub clock_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextGame {
    pub tags: TextTags,
    pub variant: Variant,
    pub start_fen: String,
    /// True when the start is not the variant's own start position.
    pub from_position: bool,
    /// Castling moves are written king-to-rook.
    pub chess960_castling: bool,
    pub moves: Vec<TextMove>,
    /// `1-0`, `0-1`, `1/2-1/2` or `*`, as the text gave it.
    pub result: Option<String>,
    pub last: FinalPosition,
    /// Byte offsets of the game in the text as received.
    pub start: usize,
    pub end: usize,
}
