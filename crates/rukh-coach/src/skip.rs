//! Games an import leaves out, and the count by reason.

use serde::{Deserialize, Serialize};

use crate::text::{TextGame, Variant};

pub const MIN_PLIES: usize = 10;

pub const MAX_PLIES: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Skip {
    /// Not standard chess, and not Chess960 from its own start.
    Variant,
    TooShort,
    TooLong,
    /// The text does not replay: an illegal move, a bad start, or text cut off.
    Unreadable,
    /// No result yet.
    Unfinished,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Skipped {
    pub variant: u32,
    pub too_short: u32,
    pub too_long: u32,
    pub unreadable: u32,
    pub unfinished: u32,
}

impl Skipped {
    pub fn add(&mut self, skip: Skip) {
        let count = match skip {
            Skip::Variant => &mut self.variant,
            Skip::TooShort => &mut self.too_short,
            Skip::TooLong => &mut self.too_long,
            Skip::Unreadable => &mut self.unreadable,
            Skip::Unfinished => &mut self.unfinished,
        };
        *count = count.saturating_add(1);
    }

    pub fn total(&self) -> u32 {
        [
            self.variant,
            self.too_short,
            self.too_long,
            self.unreadable,
            self.unfinished,
        ]
        .iter()
        .fold(0u32, |sum, n| sum.saturating_add(*n))
    }
}

/// Each game gets one reason, the first that applies in this order.
pub fn skip_of(game: &TextGame) -> Option<Skip> {
    let finished = matches!(game.result.as_deref(), Some("1-0" | "0-1" | "1/2-1/2"));

    if game.variant == Variant::Chess960 && game.from_position {
        Some(Skip::Variant)
    } else if !finished {
        Some(Skip::Unfinished)
    } else if game.moves.len() < MIN_PLIES {
        Some(Skip::TooShort)
    } else if game.moves.len() > MAX_PLIES {
        Some(Skip::TooLong)
    } else {
        None
    }
}
