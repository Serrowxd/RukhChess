//! rukh-core: the game behind Rukh, with no I/O and no clock of its own.

use std::fmt;

use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::san::{San, SanPlus};
use shakmaty::uci::UciMove;
use shakmaty::{
    CastlingMode, CastlingSide, Chess, Color, EnPassantMode, Move, Position, Rank, Role, Square,
};

pub mod chess960;
pub mod desk;
pub mod intent;
pub mod session;
pub mod table;

pub use desk::{
    clean_tab_name, Desk, Mark, Tab, TabEntry, TabId, TabIntent, TabKind, MAX_FREE_TABS,
    MAX_TAB_NAME_CHARS,
};
pub use intent::{AnnotateMode, Intent};
pub use session::{MatchState, Seat, Seats, Session, Side, Study, Style, StyleInfo};
pub use table::{
    Actor, Applied, AppliedCounts, Change, ChangeReport, LastMove, MatchBody, PathStep,
    PositionBody, Rejected, ResultBody, StateBody, StatusBody, Table, TreeBody, WaitEvent, WaitFor,
};

pub const INITIAL_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/// Move glyphs a node can carry, in PGN numeric order ($1..$6).
pub const NAG_GLYPHS: [&str; 6] = ["!", "?", "!!", "??", "!?", "?!"];

pub const DRAW_COLORS: [&str; 4] = ["green", "red", "blue", "yellow"];

/// A node in the move tree. The root is `0`; ids are never reused within a game.
pub type NodeId = u32;

/// What went wrong, written for a person or an AI to read and act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidFen(String),
    /// The FEN was readable but the position breaks the rules.
    IllegalPosition(String),
    IllegalMove(String),
    UnknownNode(NodeId),
    BadInput(String),
    /// The move was sent for a position the board is no longer on.
    Stale(String),
    GameOver(String),
    /// During a match, an AI tried to move for a side it does not hold.
    NotYourTurn(String),
    /// No open board has this id.
    UnknownTab(String),
    /// The free-board limit is reached.
    TabLimit(String),
    /// There is no closed board to reopen.
    NothingClosed(String),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::IllegalMove(_) => "illegal",
            Error::Stale(_) => "stale",
            Error::GameOver(_) => "game_over",
            Error::NotYourTurn(_) => "not_your_turn",
            Error::UnknownTab(_) => "unknown_tab",
            Error::TabLimit(_) => "tab_limit",
            Error::NothingClosed(_) => "nothing_closed",
            Error::InvalidFen(_)
            | Error::IllegalPosition(_)
            | Error::UnknownNode(_)
            | Error::BadInput(_) => "bad_input",
        }
    }

    /// The refusal for text that is not a readable intent, with the parser's message cut short.
    pub(crate) fn unreadable(e: impl fmt::Display) -> Error {
        let why = e.to_string();
        let mut cut: String = why.chars().take(MAX_UNREADABLE_CHARS).collect();

        if cut.len() < why.len() {
            cut.push_str("...");
        }

        Error::BadInput(format!("the intent could not be read: {cut}"))
    }
}

/// Longest part of a parser's message that a refusal repeats.
const MAX_UNREADABLE_CHARS: usize = 400;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidFen(why) => write!(f, "invalid FEN: {why}"),
            Error::IllegalPosition(why) => write!(f, "illegal position: {why}"),
            Error::IllegalMove(why) => write!(f, "illegal move: {why}"),
            Error::UnknownNode(id) => write!(f, "no move with id {id} in this game"),
            Error::BadInput(why)
            | Error::Stale(why)
            | Error::GameOver(why)
            | Error::NotYourTurn(why)
            | Error::UnknownTab(why)
            | Error::TabLimit(why)
            | Error::NothingClosed(why) => write!(f, "{why}"),
        }
    }
}

impl std::error::Error for Error {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Variant {
    Standard,
    Chess960,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Arrow {
    pub from: String,
    pub to: String,
    #[serde(default = "default_color")]
    pub color: String,
    /// True when the arrow spans a knight's jump, so a view can draw it as an L.
    #[serde(default)]
    pub knight: bool,
    /// Who drew it: `user`, `engine` or `ai`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Highlight {
    pub square: String,
    #[serde(default = "default_color")]
    pub color: String,
}

fn default_color() -> String {
    "green".to_string()
}

/// A stored engine evaluation, always from White's side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Eval {
    /// Absent when `mate` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cp: Option<i32>,
    /// Negative when Black mates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mate: Option<i32>,
    #[serde(default)]
    pub depth: u32,
    /// The engine's line, as UCI moves.
    #[serde(default)]
    pub pv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best: Option<String>,
}

/// One position in the move tree, with the move that led here and its annotations.
#[derive(Debug, Clone, Serialize)]
pub struct Node {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    /// `children[0]` is the main line; the rest are variations.
    pub children: Vec<NodeId>,
    /// Half-moves from the start of a standard game, so a FEN at move 10 starts at ply 18.
    pub ply: u32,
    /// With `+` or `#`. `None` on the root.
    pub san: Option<String>,
    /// Castling is `e1g1` in standard chess and king-to-rook (`e1h1`) in Chess960.
    pub uci: Option<String>,
    /// The position after the move.
    pub fen: String,
    pub check: bool,
    pub checkmate: bool,
    pub captured: Option<&'static str>,
    pub note: String,
    /// One of [`NAG_GLYPHS`], or empty.
    pub nag: String,
    pub arrows: Vec<Arrow>,
    pub highlights: Vec<Highlight>,
    pub eval: Option<Eval>,
}

/// What [`Game::play`] did.
#[derive(Debug, Clone, Serialize)]
pub struct Played {
    pub node: NodeId,
    pub san: String,
    pub uci: String,
    pub fen: String,
    pub captured: Option<&'static str>,
    /// `king` or `queen`.
    pub castle: Option<&'static str>,
    pub en_passant: bool,
    pub promotion: Option<&'static str>,
    pub check: bool,
    pub checkmate: bool,
    /// True when the move was already in the tree and the game stepped onto it.
    pub reused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegalMove {
    pub san: String,
    pub uci: String,
    pub from: String,
    pub to: String,
    pub promotion: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub check: bool,
    pub checkmate: bool,
    pub stalemate: bool,
    pub insufficient_material: bool,
    pub fifty_moves: bool,
    /// How often this position has occurred on the way here, this time included.
    pub repetition: u32,
    /// `1-0`, `0-1` or `1/2-1/2` when the game is over.
    pub outcome: Option<&'static str>,
    pub reason: &'static str,
}

/// Everything a view or an AI needs to show the game.
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub variant: Variant,
    pub chess960_number: Option<u16>,
    pub start_fen: String,
    pub fen: String,
    pub turn: &'static str,
    pub ply: u32,
    pub current: NodeId,
    /// Node ids from the root to the current node.
    pub path: Vec<NodeId>,
    pub status: Status,
    pub legal_moves: Vec<LegalMove>,
    pub nodes: Vec<Node>,
}

/// A game: the rules, the move tree and its annotations.
#[derive(Debug, Clone)]
pub struct Game {
    variant: Variant,
    chess960_number: Option<u16>,
    start_fen: String,
    mode: CastlingMode,
    nodes: Vec<Option<Node>>,
    current: NodeId,
    /// Kept so moves do not re-read a FEN.
    pos: Chess,
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Pawn => "pawn",
        Role::Knight => "knight",
        Role::Bishop => "bishop",
        Role::Rook => "rook",
        Role::Queen => "queen",
        Role::King => "king",
    }
}

fn color_name(color: Color) -> &'static str {
    match color {
        Color::White => "white",
        Color::Black => "black",
    }
}

fn parse_square(name: &str) -> Option<Square> {
    Square::from_ascii(name.as_bytes()).ok()
}

pub fn is_knight_jump(from: &str, to: &str) -> bool {
    match (parse_square(from), parse_square(to)) {
        (Some(a), Some(b)) => {
            let dx = (a.file() as i32 - b.file() as i32).abs();
            let dy = (a.rank() as i32 - b.rank() as i32).abs();

            (dx == 1 && dy == 2) || (dx == 2 && dy == 1)
        }
        _ => false,
    }
}

fn clean_color(color: &str) -> String {
    if DRAW_COLORS.contains(&color) {
        color.to_string()
    } else {
        default_color()
    }
}

fn clean_arrow(a: &Arrow) -> Option<Arrow> {
    if parse_square(&a.from).is_none() || parse_square(&a.to).is_none() || a.from == a.to {
        return None;
    }

    Some(Arrow {
        from: a.from.clone(),
        to: a.to.clone(),
        color: clean_color(&a.color),
        knight: is_knight_jump(&a.from, &a.to),
        source: a
            .source
            .clone()
            .filter(|s| matches!(s.as_str(), "user" | "engine" | "ai")),
    })
}

fn clean_highlight(h: &Highlight) -> Option<Highlight> {
    parse_square(&h.square)?;

    Some(Highlight {
        square: h.square.clone(),
        color: clean_color(&h.color),
    })
}

fn clean_eval(e: Eval) -> Option<Eval> {
    match (e.mate, e.cp) {
        (Some(mate), _) => Some(Eval {
            cp: None,
            mate: Some(mate),
            ..e
        }),
        (None, Some(_)) => Some(e),
        (None, None) => None,
    }
}

/// The FEN fields that identify a position for repetition: pieces, turn, castling, en passant.
fn fen_key(fen: &str) -> String {
    fen.split(' ').take(4).collect::<Vec<_>>().join(" ")
}

fn load_position(fen: &str, mode: Option<CastlingMode>) -> Result<(Chess, CastlingMode), Error> {
    let parsed =
        Fen::from_ascii(fen.trim().as_bytes()).map_err(|e| Error::InvalidFen(e.to_string()))?;
    let mode = mode.unwrap_or_else(|| CastlingMode::detect(parsed.as_setup()));

    let pos = parsed
        .into_position::<Chess>(mode)
        .map_err(|e| Error::IllegalPosition(e.to_string()))?;

    Ok((pos, mode))
}

fn make_fen(pos: &Chess) -> String {
    Fen::from_position(pos, EnPassantMode::Legal).to_string()
}

fn ply_of(pos: &Chess) -> u32 {
    (pos.fullmoves().get() - 1) * 2 + u32::from(pos.turn() == Color::Black)
}

impl Game {
    pub fn standard() -> Game {
        Game::from_fen(INITIAL_FEN, Some(Variant::Standard)).expect("the start position is legal")
    }

    /// With `variant` left out, the castling rights decide whether it is Chess960.
    pub fn from_fen(fen: &str, variant: Option<Variant>) -> Result<Game, Error> {
        if fen.trim().is_empty() {
            return Err(Error::InvalidFen("empty".into()));
        }

        let forced = match variant {
            Some(Variant::Chess960) => Some(CastlingMode::Chess960),
            Some(Variant::Standard) => Some(CastlingMode::Standard),
            None => None,
        };
        let (pos, mode) = load_position(fen, forced)?;

        let variant = variant.unwrap_or(if mode.is_chess960() {
            Variant::Chess960
        } else {
            Variant::Standard
        });

        let start_fen = make_fen(&pos);
        let chess960_number = match variant {
            Variant::Chess960 => chess960::number_of(&start_fen),
            Variant::Standard => None,
        };

        let root = Node {
            id: 0,
            parent: None,
            children: Vec::new(),
            ply: ply_of(&pos),
            san: None,
            uci: None,
            fen: start_fen.clone(),
            check: pos.is_check(),
            checkmate: pos.is_checkmate(),
            captured: None,
            note: String::new(),
            nag: String::new(),
            arrows: Vec::new(),
            highlights: Vec::new(),
            eval: None,
        };

        Ok(Game {
            variant,
            chess960_number,
            start_fen,
            mode,
            nodes: vec![Some(root)],
            current: 0,
            pos,
        })
    }

    pub fn chess960(n: u16) -> Result<Game, Error> {
        let fen = chess960::fen(n)
            .ok_or_else(|| Error::BadInput(format!("Chess960 number must be 0..959 (got {n})")))?;

        let mut game = Game::from_fen(&fen, Some(Variant::Chess960))?;
        game.chess960_number = Some(n);

        Ok(game)
    }

    pub fn variant(&self) -> Variant {
        self.variant
    }

    pub fn chess960_number(&self) -> Option<u16> {
        self.chess960_number
    }

    pub fn start_fen(&self) -> &str {
        &self.start_fen
    }

    pub fn fen(&self) -> &str {
        &self.current_node().fen
    }

    pub fn turn(&self) -> &'static str {
        color_name(self.pos.turn())
    }

    /// For callers that need the rules library directly (perft, engines).
    pub fn position(&self) -> &Chess {
        &self.pos
    }

    pub fn current(&self) -> NodeId {
        self.current
    }

    pub fn current_node(&self) -> &Node {
        self.nodes[self.current as usize]
            .as_ref()
            .expect("the current node always exists")
    }

    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(id as usize).and_then(Option::as_ref)
    }

    fn node_mut(&mut self, id: NodeId) -> Result<&mut Node, Error> {
        self.nodes
            .get_mut(id as usize)
            .and_then(Option::as_mut)
            .ok_or(Error::UnknownNode(id))
    }

    pub fn node_count(&self) -> usize {
        self.nodes.iter().flatten().count()
    }

    /// Node ids from the root to the current node.
    pub fn path(&self) -> Vec<NodeId> {
        self.path_to(self.current)
    }

    fn path_to(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut at = self.node(id);

        while let Some(n) = at {
            out.push(n.id);
            at = n.parent.and_then(|p| self.node(p));
        }

        out.reverse();
        out
    }

    /// Node ids from the root along `children[0]` to the end of the main line.
    pub fn mainline(&self) -> Vec<NodeId> {
        let mut out = vec![0];
        let mut at = self.node(0);

        while let Some(next) = at.and_then(|n| n.children.first()).copied() {
            out.push(next);
            at = self.node(next);
        }

        out
    }

    /// The SAN moves from the root to the current node.
    pub fn history(&self) -> Vec<String> {
        self.path()
            .iter()
            .filter_map(|id| self.node(*id).and_then(|n| n.san.clone()))
            .collect()
    }

    pub fn legal_moves(&self) -> Vec<LegalMove> {
        self.pos
            .legal_moves()
            .iter()
            .map(|m| {
                let uci = UciMove::from_move(*m, self.mode);

                LegalMove {
                    san: SanPlus::from_move(self.pos.clone(), *m).to_string(),
                    uci: uci.to_string(),
                    from: uci.from().map(|s| s.to_string()).unwrap_or_default(),
                    to: uci.to().map(|s| s.to_string()).unwrap_or_default(),
                    promotion: m.promotion().map(role_name),
                }
            })
            .collect()
    }

    pub fn status(&self) -> Status {
        let pos = &self.pos;
        let check = pos.is_check();
        let checkmate = pos.is_checkmate();
        let stalemate = pos.is_stalemate();
        let insufficient_material = pos.is_insufficient_material();
        let fifty_moves = !checkmate && pos.halfmoves() >= 100;

        let key = fen_key(self.fen());
        let repetition = self
            .path()
            .iter()
            .filter(|id| {
                self.node(**id)
                    .map(|n| fen_key(&n.fen) == key)
                    .unwrap_or(false)
            })
            .count() as u32;

        let (outcome, reason) = if checkmate {
            (
                Some(if pos.turn() == Color::White {
                    "0-1"
                } else {
                    "1-0"
                }),
                "checkmate",
            )
        } else if stalemate {
            (Some("1/2-1/2"), "stalemate")
        } else if insufficient_material {
            (Some("1/2-1/2"), "insufficient material")
        } else if repetition >= 3 {
            (Some("1/2-1/2"), "threefold repetition")
        } else if fifty_moves {
            (Some("1/2-1/2"), "fifty-move rule")
        } else if check {
            (None, "check")
        } else {
            (None, "playing")
        };

        Status {
            check,
            checkmate,
            stalemate,
            insufficient_material,
            fifty_moves,
            repetition,
            outcome,
            reason,
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            variant: self.variant,
            chess960_number: self.chess960_number,
            start_fen: self.start_fen.clone(),
            fen: self.fen().to_string(),
            turn: self.turn(),
            ply: self.current_node().ply,
            current: self.current,
            path: self.path(),
            status: self.status(),
            legal_moves: self.legal_moves(),
            nodes: self.nodes.iter().flatten().cloned().collect(),
        }
    }

    /// Reads a UCI or SAN move and checks it against the current position.
    pub fn parse_move(&self, text: &str) -> Result<Move, Error> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::IllegalMove("no move given".into()));
        }

        if let Ok(uci) = UciMove::from_ascii(text.to_ascii_lowercase().as_bytes()) {
            // A pawn reaching the last rank with no piece named promotes to a queen.
            let uci = match uci {
                UciMove::Normal {
                    from,
                    to,
                    promotion: None,
                } if self.pos.board().role_at(from) == Some(Role::Pawn)
                    && matches!(to.rank(), Rank::First | Rank::Eighth) =>
                {
                    UciMove::Normal {
                        from,
                        to,
                        promotion: Some(Role::Queen),
                    }
                }
                other => other,
            };

            if let Ok(m) = uci.to_move(&self.pos) {
                return Ok(m);
            }
        }

        let mut san: String = text.trim_end_matches(['!', '?', '+', '#']).to_string();
        if san.starts_with("0-0") {
            san = san.replace('0', "O");
        }

        // Tolerate a promotion written without the equals sign: e8Q.
        let bytes = san.as_bytes();
        if bytes.len() >= 3
            && matches!(bytes[bytes.len() - 1], b'Q' | b'R' | b'B' | b'N')
            && matches!(bytes[bytes.len() - 2], b'1' | b'8')
        {
            san.insert(san.len() - 1, '=');
        }

        San::from_ascii(san.as_bytes())
            .ok()
            .and_then(|s| s.to_move(&self.pos).ok())
            .ok_or_else(|| {
                Error::IllegalMove(format!(
                    "{text} is not legal here ({} to move)",
                    self.turn()
                ))
            })
    }

    /// Plays a move and steps onto it, reusing a matching continuation instead of duplicating it.
    pub fn play(&mut self, text: &str) -> Result<Played, Error> {
        let m = self.parse_move(text)?;
        let uci = UciMove::from_move(m, self.mode).to_string();

        let captured = if m.is_en_passant() {
            Some("pawn")
        } else {
            m.capture().map(role_name)
        };
        let castle = m.castling_side().map(|side| match side {
            CastlingSide::KingSide => "king",
            CastlingSide::QueenSide => "queen",
        });
        let promotion = m.promotion().map(role_name);

        let mut next = self.pos.clone();
        let san = SanPlus::from_move_and_play_unchecked(&mut next, m).to_string();

        let existing = self
            .current_node()
            .children
            .iter()
            .copied()
            .find(|c| self.node(*c).and_then(|n| n.uci.as_deref()) == Some(uci.as_str()));
        let reused = existing.is_some();

        let id = match existing {
            Some(id) => id,
            None => {
                let id = self.nodes.len() as NodeId;
                let node = Node {
                    id,
                    parent: Some(self.current),
                    children: Vec::new(),
                    ply: self.current_node().ply + 1,
                    san: Some(san.clone()),
                    uci: Some(uci.clone()),
                    fen: make_fen(&next),
                    check: next.is_check(),
                    checkmate: next.is_checkmate(),
                    captured,
                    note: String::new(),
                    nag: String::new(),
                    arrows: Vec::new(),
                    highlights: Vec::new(),
                    eval: None,
                };

                self.nodes.push(Some(node));
                let parent = self.current;
                self.node_mut(parent)?.children.push(id);

                id
            }
        };

        self.current = id;
        self.pos = next;

        let node = self.current_node();
        Ok(Played {
            node: id,
            san,
            uci,
            fen: node.fen.clone(),
            captured,
            castle,
            en_passant: m.is_en_passant(),
            promotion,
            check: node.check,
            checkmate: node.checkmate,
            reused,
        })
    }

    pub fn goto(&mut self, id: NodeId) -> Result<(), Error> {
        let fen = self.node(id).ok_or(Error::UnknownNode(id))?.fen.clone();

        if id != self.current {
            self.pos = load_position(&fen, Some(self.mode))?.0;
            self.current = id;
        }

        Ok(())
    }

    /// Steps to the parent. False at the root.
    pub fn back(&mut self) -> bool {
        match self.current_node().parent {
            Some(p) => self.goto(p).is_ok(),
            None => false,
        }
    }

    /// Steps to the main continuation. False at the end of a line.
    pub fn forward(&mut self) -> bool {
        match self.current_node().children.first().copied() {
            Some(c) => self.goto(c).is_ok(),
            None => false,
        }
    }

    pub fn to_start(&mut self) {
        let _ = self.goto(0);
    }

    pub fn to_end(&mut self) {
        while self.forward() {}
    }

    /// Makes a node the first continuation of its parent. Returns false for the root.
    pub fn promote_variation(&mut self, id: NodeId) -> Result<bool, Error> {
        let Some(parent) = self.node(id).ok_or(Error::UnknownNode(id))?.parent else {
            return Ok(false);
        };

        let siblings = &mut self.node_mut(parent)?.children;
        if let Some(i) = siblings.iter().position(|c| *c == id) {
            siblings.remove(i);
            siblings.insert(0, id);
        }

        Ok(true)
    }

    /// Removes a node and everything after it (every move, on the root). Returns the current node.
    pub fn delete_from(&mut self, id: NodeId) -> Result<NodeId, Error> {
        let parent = self.node(id).ok_or(Error::UnknownNode(id))?.parent;
        let mut doomed: Vec<NodeId> = match parent {
            Some(_) => vec![id],
            None => self.node(0).map(|n| n.children.clone()).unwrap_or_default(),
        };

        let mut i = 0;
        while i < doomed.len() {
            if let Some(n) = self.node(doomed[i]) {
                doomed.extend(n.children.iter().copied());
            }
            i += 1;
        }

        for d in &doomed {
            self.nodes[*d as usize] = None;
        }

        let keep = parent.unwrap_or(0);
        self.node_mut(keep)?
            .children
            .retain(|c| !doomed.contains(c));

        if doomed.contains(&self.current) {
            // Set directly: `goto` would compare against a current id that no longer exists.
            self.current = keep;
            let fen = self.current_node().fen.clone();
            self.pos = load_position(&fen, Some(self.mode))?.0;
        }

        Ok(self.current)
    }

    pub fn set_note(&mut self, id: NodeId, text: &str) -> Result<(), Error> {
        self.node_mut(id)?.note = text.to_string();
        Ok(())
    }

    /// An empty string clears the glyph; anything outside [`NAG_GLYPHS`] is refused.
    pub fn set_nag(&mut self, id: NodeId, nag: &str) -> Result<(), Error> {
        if !nag.is_empty() && !NAG_GLYPHS.contains(&nag) {
            return Err(Error::BadInput(format!(
                "{nag} is not a move glyph; use one of ! ? !! ?? !? ?!"
            )));
        }

        self.node_mut(id)?.nag = nag.to_string();
        Ok(())
    }

    /// Arrows with bad squares are dropped; unknown colours become green.
    pub fn set_arrows(&mut self, id: NodeId, arrows: &[Arrow]) -> Result<(), Error> {
        self.node_mut(id)?.arrows = arrows.iter().filter_map(clean_arrow).collect();
        Ok(())
    }

    pub fn set_highlights(&mut self, id: NodeId, highlights: &[Highlight]) -> Result<(), Error> {
        self.node_mut(id)?.highlights = highlights.iter().filter_map(clean_highlight).collect();
        Ok(())
    }

    pub fn set_eval(&mut self, id: NodeId, eval: Option<Eval>) -> Result<(), Error> {
        self.node_mut(id)?.eval = eval.and_then(clean_eval);
        Ok(())
    }
}
