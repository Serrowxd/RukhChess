//! How a game ended, matched to fixed words only.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Checkmate,
    Resign,
    Flag,
    Stalemate,
    Repetition,
    FiftyMove,
    Insufficient,
    Agreed,
    Abandoned,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Checkmate => "checkmate",
            Reason::Resign => "resign",
            Reason::Flag => "flag",
            Reason::Stalemate => "stalemate",
            Reason::Repetition => "repetition",
            Reason::FiftyMove => "fifty_move",
            Reason::Insufficient => "insufficient",
            Reason::Agreed => "agreed",
            Reason::Abandoned => "abandoned",
        }
    }
}

/// The position after the last move, as the program's replay found it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FinalPosition {
    pub checkmate: bool,
    pub stalemate: bool,
    pub insufficient: bool,
    /// The position has stood three times.
    pub repetition: bool,
    pub fifty_move: bool,
}

/// What a `Termination` tag says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Said {
    Reason(Reason),
    /// Lichess's word for mate, resignation and draws alike.
    Normal,
    Nothing,
}

/// Every byte range where `needle` stands in `text`, overlapping ones included.
fn places(text: &str, needle: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut from = 0;

    while let Some(at) = text[from..].find(needle) {
        let start = from + at;
        found.push((start, start + needle.len()));

        let step = text[start..].chars().next().map_or(1, char::len_utf8);
        from = start + step;
    }

    found
}

/// Reads the fixed words only; a word standing wholly inside a player's name is not read.
pub fn read_termination(text: &str, names: &[&str]) -> Said {
    let text = text.to_lowercase();

    let named: Vec<(usize, usize)> = names
        .iter()
        .map(|name| name.trim().to_lowercase())
        .filter(|name| !name.is_empty())
        .flat_map(|name| places(&text, &name))
        .collect();

    let in_a_name =
        |(start, end): (usize, usize)| named.iter().any(|&(from, to)| from <= start && end <= to);

    let has = |words: &[&str]| {
        words
            .iter()
            .any(|word| places(&text, word).into_iter().any(|at| !in_a_name(at)))
    };

    let reason = if has(&["abandon"]) {
        Reason::Abandoned
    } else if has(&["checkmate"]) {
        Reason::Checkmate
    } else if has(&["resign"]) {
        Reason::Resign
    } else if has(&["time forfeit", "on time", "timeout"]) {
        Reason::Flag
    } else if has(&["stalemate"]) {
        Reason::Stalemate
    } else if has(&["repetition"]) {
        Reason::Repetition
    } else if has(&["agreement", "agreed"]) {
        Reason::Agreed
    } else if has(&["insufficient"]) {
        Reason::Insufficient
    } else if has(&["50-move", "50 move", "fifty"]) {
        Reason::FiftyMove
    } else if text.trim() == "normal" && has(&["normal"]) {
        return Said::Normal;
    } else {
        return Said::Nothing;
    };

    Said::Reason(reason)
}

/// The ending for a finished game; `None` when nothing in the text or on the board tells.
pub fn ending(
    termination: Option<&str>,
    names: &[&str],
    result: &str,
    last: &FinalPosition,
) -> Option<Reason> {
    let said = termination.map_or(Said::Nothing, |text| read_termination(text, names));
    let decisive = result == "1-0" || result == "0-1";

    let from_board = if decisive {
        last.checkmate.then_some(Reason::Checkmate)
    } else if last.stalemate {
        Some(Reason::Stalemate)
    } else if last.insufficient {
        Some(Reason::Insufficient)
    } else if last.repetition {
        Some(Reason::Repetition)
    } else if last.fifty_move {
        Some(Reason::FiftyMove)
    } else {
        None
    };

    match said {
        Said::Reason(reason) => Some(reason),
        Said::Normal if decisive => from_board.or(Some(Reason::Resign)),
        Said::Normal => from_board.or(Some(Reason::Agreed)),
        Said::Nothing => from_board,
    }
}
