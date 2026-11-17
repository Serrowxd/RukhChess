//! A session: the game, the seats, the tip of the game being played, and the AI's style.

use serde::{Deserialize, Serialize};

use crate::{Game, NodeId, Status};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    White,
    Black,
}

impl Side {
    pub fn name(self) -> &'static str {
        match self {
            Side::White => "white",
            Side::Black => "black",
        }
    }

    /// `White` or `Black`, for sentences.
    pub fn title(self) -> &'static str {
        match self {
            Side::White => "White",
            Side::Black => "Black",
        }
    }

    pub fn other(self) -> Side {
        match self {
            Side::White => Side::Black,
            Side::Black => Side::White,
        }
    }

    /// The side to move in a FEN. Anything unreadable counts as White.
    pub fn to_move_in(fen: &str) -> Side {
        match fen.split(' ').nth(1) {
            Some("b") => Side::Black,
            _ => Side::White,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Seat {
    #[default]
    Human,
    Ai,
    Engine,
}

impl Seat {
    pub fn name(self) -> &'static str {
        match self {
            Seat::Human => "human",
            Seat::Ai => "ai",
            Seat::Engine => "engine",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Seats {
    pub white: Seat,
    pub black: Seat,
}

impl Seats {
    pub fn get(&self, side: Side) -> Seat {
        match side {
            Side::White => self.white,
            Side::Black => self.black,
        }
    }

    pub fn set(&mut self, side: Side, seat: Seat) {
        match side {
            Side::White => self.white = seat,
            Side::Black => self.black = seat,
        }
    }
}

/// What kind of opponent an AI is. The board owns the style; the AI obeys [`Style::rule`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    Silent,
    #[default]
    Annotate,
    Coach,
}

// Macros so RULE_COACH_IN_FULL can be built from the same literals at compile time.
macro_rules! rule_annotate {
    () => {
        "play the move, and attach to *that* node one short note (why) plus at most two arrows \
         and two highlights. Never annotate any other node."
    };
}

macro_rules! rule_coach {
    () => {
        "`annotate`, plus: if the player's previous move was a clear mistake, say so in the note and \
         draw the refutation. Judgement call, not an engine verdict; silence is correct when the move \
         was fine."
    };
}

pub const RULE_SILENT: &str =
    "play the move. Do not annotate, do not note. Nothing on the board but the move.";

pub const RULE_ANNOTATE: &str = rule_annotate!();

/// Only complete next to [`RULE_ANNOTATE`], as in the server instructions.
pub const RULE_COACH: &str = rule_coach!();

/// The annotate rule then the coach rule, for tool results where the annotate rule is not shown.
pub const RULE_COACH_IN_FULL: &str = concat!(
    rule_annotate!(),
    " As coach, also follow this (\"`annotate`\" is the rule just given, not the tool): ",
    rule_coach!()
);

impl Style {
    /// `silent`, `annotate` or `coach`, case and spaces ignored; anything else is `annotate`.
    pub fn normalize(text: &str) -> Style {
        match text.trim().to_ascii_lowercase().as_str() {
            "silent" => Style::Silent,
            "coach" => Style::Coach,
            _ => Style::Annotate,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Style::Silent => "silent",
            Style::Annotate => "annotate",
            Style::Coach => "coach",
        }
    }

    /// What an AI playing in this style must do, complete on its own.
    pub fn rule(self) -> &'static str {
        match self {
            Style::Silent => RULE_SILENT,
            Style::Annotate => RULE_ANNOTATE,
            Style::Coach => RULE_COACH_IN_FULL,
        }
    }

    pub fn info(self) -> StyleInfo {
        StyleInfo {
            name: self.name(),
            rule: self.rule(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StyleInfo {
    pub name: &'static str,
    pub rule: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MatchState {
    pub active: bool,
    pub seats: Seats,
    /// The end of the game being played. A move played from the tip moves it.
    pub tip: NodeId,
    pub style: Style,
}

/// Study metadata. Empty until study editing exists.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Study {
    pub title: String,
    pub notes: String,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub game: Game,
    pub study: Study,
    pub play: MatchState,
}

impl Default for Session {
    fn default() -> Session {
        Session::new(Game::standard())
    }
}

impl Session {
    /// Both seats human and no match: the analysis board.
    pub fn new(game: Game) -> Session {
        Session {
            game,
            study: Study::default(),
            play: MatchState::default(),
        }
    }

    /// True when a match is active and the board shows its tip.
    pub fn live(&self) -> bool {
        self.play.active && self.game.current() == self.play.tip
    }

    pub fn turn_at_tip(&self) -> Side {
        self.game
            .node(self.play.tip)
            .map(|n| Side::to_move_in(&n.fen))
            .unwrap_or(Side::White)
    }

    /// The game status at any node, without moving the board.
    pub fn status_at(&self, node: NodeId) -> Option<Status> {
        if node == self.game.current() {
            return Some(self.game.status());
        }

        let mut probe = self.game.clone();
        probe.goto(node).ok()?;

        Some(probe.status())
    }

    /// The seat owed a move, when live and the game is not over. Never stored.
    pub fn to_move(&self) -> Option<Seat> {
        if !self.live() || self.game.status().outcome.is_some() {
            return None;
        }

        Some(self.play.seats.get(self.turn_at_tip()))
    }

    pub fn is_ai_turn(&self, side: Side) -> bool {
        self.to_move() == Some(Seat::Ai) && self.turn_at_tip() == side
    }
}
