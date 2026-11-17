//! The table: a [`Session`] plus its counters, where intents are applied and frames produced.

use std::collections::{BTreeMap, VecDeque};

use serde::Serialize;
use serde_json::{json, Value};

use crate::intent::{AnnotateMode, Intent};
use crate::saved::{Damaged, Extra, InnerExtra, SavedMatch, SavedTable, Stopped};
use crate::session::{MatchState, Seat, Seats, Session, Side, Study, Style, StyleInfo};
use crate::{
    Arrow, Error, Eval, Game, Highlight, Node, NodeId, Snapshot, Status, DRAW_COLORS, NAG_GLYPHS,
};

pub const RECENT_MAX: usize = 16;

pub const MAX_ARROWS: usize = 64;

pub const MAX_HIGHLIGHTS: usize = 64;

pub const MAX_NOTE_CHARS: usize = 10_000;

/// Who sent an intent, read from its `by` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    /// `view:<k>`: a page.
    View,
    /// `ai:<name>`: an MCP client.
    Ai,
    /// Anything else, such as the program itself.
    Other,
}

impl Actor {
    pub fn of(by: &str) -> Actor {
        if by.starts_with("view:") {
            Actor::View
        } else if by.starts_with("ai:") {
            Actor::Ai
        } else {
            Actor::Other
        }
    }

    /// The `source` tag put on arrows this actor draws.
    fn arrow_source(self) -> Option<&'static str> {
        match self {
            Actor::View => Some("user"),
            Actor::Ai => Some("ai"),
            Actor::Other => None,
        }
    }
}

/// One board change, as listed in `recent`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    pub board_rev: u64,
    pub by: String,
    /// `move`, `new_game`, `annotate` or `navigate`.
    pub reason: &'static str,
    pub node: NodeId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub san: Option<String>,
    /// Not sent; tells apart changes that share a `board_rev`.
    #[serde(skip)]
    pub rev: u64,
    /// Not sent; entries that did not bump `board_rev` are dropped first when `recent` is full.
    #[serde(skip)]
    pub bumped: bool,
}

/// How many board_rev bumps are remembered with who made them.
const BUMP_LOG_MAX: usize = 256;

/// What a `wait(for: any_change)` would report now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeReport {
    /// Oldest first.
    pub changes: Vec<Change>,
    /// True when the wait should end, even if `recent` no longer lists the change.
    pub wake: bool,
    /// True when some board changes after `since` are no longer listed.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ResultBody {
    pub outcome: &'static str,
    pub reason: &'static str,
}

/// What a successful [`Table::apply`] produced.
#[derive(Debug, Clone)]
pub struct Applied {
    /// The same text [`Table::frame`] returns.
    pub frame_json: String,
    pub result_json: String,
    pub result: Value,
    pub rev: u64,
    /// False when the intent was accepted but changed nothing; `rev` did not move then.
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchBody {
    pub active: bool,
    pub seats: Seats,
    pub tip: NodeId,
    pub live: bool,
    /// Computed, never stored. See [`Session::to_move`].
    pub to_move: Option<Seat>,
    pub style: Style,
    /// Always `null` until clocks exist.
    pub time_control: Option<()>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StateBody {
    pub game_id: u64,
    pub board_rev: u64,
    pub recent: Vec<Change>,
    pub game: Snapshot,
    pub study: Study,
    #[serde(rename = "match")]
    pub play: MatchBody,
    /// Always `null` until clocks exist.
    pub clock: Option<()>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Hint {
    pub(crate) reason: &'static str,
    pub(crate) by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) intent_id: Option<u64>,
}

#[derive(Serialize)]
struct FrameOut<'a> {
    t: &'static str,
    instance: &'a str,
    rev: u64,
    now_ms: u64,
    hint: &'a Hint,
    state: StateBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LastMove {
    pub san: String,
    pub uci: String,
}

/// The game status as an AI reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatusBody {
    /// One sentence, such as `Black to move, in check.`
    pub text: String,
    pub outcome: Option<&'static str>,
    pub reason: &'static str,
    pub check: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathStep {
    pub node: NodeId,
    pub ply: u32,
    pub san: String,
}

/// The position body used by `get_game`, `wait` and other AI-facing results.
#[derive(Debug, Clone, Serialize)]
pub struct PositionBody {
    pub node: NodeId,
    pub fen: String,
    pub turn: &'static str,
    pub ply: u32,
    pub move_number: u32,
    /// Numbered moves from the start: `1. e4 e5 2. Nf3`.
    pub line: String,
    pub last_move: Option<LastMove>,
    pub status: StatusBody,
    /// In SAN.
    pub legal_moves: Vec<String>,
    /// Always `null` until clocks exist.
    pub clock: Option<()>,
    pub seats: Seats,
    pub to_move: Option<Seat>,
    pub your_seat: Option<Side>,
    /// `null` when no match is active.
    pub tip: Option<NodeId>,
    /// While false the person is browsing, and an AI's match move is still played at `tip`.
    pub live: bool,
    pub style: StyleInfo,
    pub note: String,
    pub nag: String,
    pub arrows: Vec<Arrow>,
    pub highlights: Vec<Highlight>,
    pub path: Vec<PathStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval: Option<Eval>,
    pub board_rev: u64,
    /// Number of open boards, supplied by the caller.
    pub views: u32,
}

/// `get_game` with `detail: "tree"`.
#[derive(Debug, Clone, Serialize)]
pub struct TreeBody {
    #[serde(flatten)]
    pub position: PositionBody,
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitFor {
    /// Level-triggered.
    MyTurn(Side),
    /// `since` is a `board_rev` the caller has seen; `None` or a future value means "from now".
    AnyChange { since: Option<u64> },
}

/// A `wait` result: an event with the position, or `timeout` as `{event, board_rev}`.
#[derive(Debug, Clone, Serialize)]
pub struct WaitEvent {
    pub event: &'static str,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub position: Option<PositionBody>,
    /// Oldest first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_last: Option<Vec<Change>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_last_truncated: Option<bool>,
    /// The result at the tip of the match, even if the person is browsing elsewhere.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ResultBody>,
    /// `match_stop`, `new_game` or `seats` when the person ended the match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<&'static str>,
    /// On `seat_changed`: the seat the person moved the AI to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seat: Option<Side>,
    /// Only on `timeout`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board_rev: Option<u64>,
}

impl WaitEvent {
    pub fn timeout(board_rev: u64) -> WaitEvent {
        WaitEvent {
            event: "timeout",
            position: None,
            since_last: None,
            since_last_truncated: None,
            result: None,
            stopped: None,
            seat: None,
            board_rev: Some(board_rev),
        }
    }

    fn with_position(event: &'static str, position: PositionBody) -> WaitEvent {
        WaitEvent {
            event,
            position: Some(position),
            since_last: None,
            since_last_truncated: None,
            result: None,
            stopped: None,
            seat: None,
            board_rev: None,
        }
    }
}

/// One annotation item that was not applied, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rejected {
    /// `arrow`, `highlight`, `nag` or `note`.
    pub item: &'static str,
    pub value: Value,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct AppliedCounts {
    /// Added, replaced or removed.
    pub arrows: usize,
    /// Added, replaced or removed.
    pub highlights: usize,
    pub note: bool,
    pub nag: bool,
}

struct AnnotationInput<'a> {
    note: Option<&'a str>,
    nag: Option<&'a str>,
    arrows: Option<&'a [Value]>,
    highlights: Option<&'a [Value]>,
}

struct AnnotationOutcome {
    applied: AppliedCounts,
    rejected: Vec<Rejected>,
    changed: bool,
}

/// The session with its counters. All changes go through [`Table::apply`].
#[derive(Debug, Clone)]
pub struct Table {
    session: Session,
    rev: u64,
    board_rev: u64,
    game_id: u64,
    next_game_id: u64,
    recent: VecDeque<Change>,
    /// `(board_rev, by)` of the last [`BUMP_LOG_MAX`] changes that bumped `board_rev`.
    bumps: VecDeque<(u64, String)>,
    /// While set, an AI's seat claim does not start a match, so the person's Stop sticks.
    stopped_by_person: Option<&'static str>,
    seat_moved_to: Option<Side>,
    /// Cached so a waiting AI can be told the game is over without copying the game.
    tip_status: Option<Status>,
    instance: String,
    hint: Hint,
    extra: SavedExtra,
}

/// Unknown fields read from a tab file, kept so a save writes them back.
#[derive(Debug, Clone, Default)]
struct SavedExtra {
    header: Extra,
    inner: InnerExtra,
    moves: BTreeMap<NodeId, Extra>,
}

impl Default for Table {
    fn default() -> Table {
        Table::new("")
    }
}

fn square_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && (b'a'..=b'h').contains(&b[0]) && (b'1'..=b'8').contains(&b[1])
}

/// Missing or null is green; a known name in any case is kept; anything else is an error.
fn read_color(v: Option<&Value>) -> Result<String, String> {
    match v {
        None | Some(Value::Null) => Ok("green".to_string()),
        Some(Value::String(s)) => {
            let c = s.trim().to_ascii_lowercase();

            if DRAW_COLORS.contains(&c.as_str()) {
                Ok(c)
            } else {
                Err(format!(
                    "{s:?} is not a drawing colour; use green, red, blue or yellow"
                ))
            }
        }
        Some(_) => Err("color must be a string: green, red, blue or yellow".to_string()),
    }
}

fn read_square(v: Option<&Value>, field: &str) -> Result<String, String> {
    match v {
        Some(Value::String(s)) => {
            let sq = s.trim().to_ascii_lowercase();

            if square_ok(&sq) {
                Ok(sq)
            } else {
                Err(format!("{s:?} is not a square (a1..h8)"))
            }
        }
        Some(_) => Err(format!("{field} must be a square name such as e4")),
        None => Err(format!("{field} is missing")),
    }
}

fn read_arrow(v: &Value, source: Option<&str>) -> Result<Arrow, String> {
    if !v.is_object() {
        return Err("an arrow is an object {from, to, color}".to_string());
    }

    let from = read_square(v.get("from"), "from")?;
    let to = read_square(v.get("to"), "to")?;
    if from == to {
        return Err("an arrow needs two different squares".to_string());
    }

    let color = read_color(v.get("color"))?;

    Ok(Arrow {
        knight: crate::is_knight_jump(&from, &to),
        from,
        to,
        color,
        source: source.map(str::to_string),
    })
}

/// An arrow given for removal: only its squares are read.
fn read_arrow_squares(v: &Value, source: Option<&str>) -> Result<Arrow, String> {
    if !v.is_object() {
        return Err("an arrow is an object {from, to, color}".to_string());
    }

    let from = read_square(v.get("from"), "from")?;
    let to = read_square(v.get("to"), "to")?;

    Ok(Arrow {
        knight: false,
        from,
        to,
        color: "green".to_string(),
        source: source.map(str::to_string),
    })
}

/// A highlight given for removal: only its square is read.
fn read_highlight_square(v: &Value) -> Result<Highlight, String> {
    if !v.is_object() {
        return Err("a highlight is an object {square, color}".to_string());
    }

    let square = read_square(v.get("square"), "square")?;

    Ok(Highlight {
        square,
        color: "green".to_string(),
    })
}

fn read_highlight(v: &Value) -> Result<Highlight, String> {
    if !v.is_object() {
        return Err("a highlight is an object {square, color}".to_string());
    }

    let square = read_square(v.get("square"), "square")?;
    let color = read_color(v.get("color"))?;

    Ok(Highlight { square, color })
}

/// One of the six glyphs, or its PGN number `$1`..`$6`.
fn read_nag(text: &str) -> Result<String, String> {
    let t = text.trim();
    if NAG_GLYPHS.contains(&t) {
        return Ok(t.to_string());
    }

    if let Some(n) = t.strip_prefix('$').and_then(|n| n.parse::<usize>().ok()) {
        if (1..=NAG_GLYPHS.len()).contains(&n) {
            return Ok(NAG_GLYPHS[n - 1].to_string());
        }
    }

    Err(format!(
        "{t:?} is not a move glyph; use one of ! ? !! ?? !? ?!"
    ))
}

/// Move text with a leading move number (`12.`, `3...`) and trailing `!`/`?` removed.
fn clean_move_text(text: &str) -> String {
    let t = text.trim();
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();

    let mut rest = t;
    if digits > 0 {
        let after = &t[digits..];
        let dots = after.bytes().take_while(|b| *b == b'.').count();

        if dots > 0 {
            rest = after[dots..].trim_start();
        }
    }

    let rest = rest.trim_end_matches(['!', '?']);
    if rest.is_empty() {
        t.to_string()
    } else {
        rest.to_string()
    }
}

/// `5. Nf3` or `5... Nf6` for the move that led to a node at `ply`.
fn numbered(ply: u32, san: &str) -> String {
    let mover = ply.saturating_sub(1);
    let number = mover / 2 + 1;

    if mover.is_multiple_of(2) {
        format!("{number}. {san}")
    } else {
        format!("{number}... {san}")
    }
}

fn status_body(status: &Status, turn: Side) -> StatusBody {
    let text = match status.outcome {
        Some(outcome) => format!("Game over: {outcome}, {}.", status.reason),
        None if status.check => format!("{} to move, in check.", turn.title()),
        None => format!("{} to move.", turn.title()),
    };

    StatusBody {
        text,
        outcome: status.outcome,
        reason: status.reason,
        check: status.check,
    }
}

fn annotations_of(node: &Node) -> (String, String, Vec<Arrow>, Vec<Highlight>) {
    (
        node.note.clone(),
        node.nag.clone(),
        node.arrows.clone(),
        node.highlights.clone(),
    )
}

/// Only an unknown node fails as a whole; bad items are collected in `rejected`.
fn annotate_node(
    game: &mut Game,
    id: NodeId,
    mode: AnnotateMode,
    input: &AnnotationInput<'_>,
    source: Option<&str>,
) -> Result<AnnotationOutcome, Error> {
    let node = game.node(id).ok_or(Error::UnknownNode(id))?;
    let before = annotations_of(node);
    let (mut note, mut nag, mut arrows, mut highlights) = before.clone();

    let mut applied = AppliedCounts::default();
    let mut rejected = Vec::new();

    let nothing_given = input.note.is_none()
        && input.nag.is_none()
        && input.arrows.is_none()
        && input.highlights.is_none();

    match (mode, input.note) {
        (AnnotateMode::Clear, Some(_)) => {
            note.clear();
            applied.note = true;
        }
        (AnnotateMode::Clear, None) if nothing_given => {
            note.clear();
            applied.note = true;
        }
        (_, Some(text)) if text.chars().count() > MAX_NOTE_CHARS => rejected.push(Rejected {
            item: "note",
            value: Value::String(text.chars().take(80).collect()),
            reason: format!("a note can hold at most {MAX_NOTE_CHARS} characters"),
        }),
        (AnnotateMode::Add, Some(text)) if !text.trim().is_empty() => {
            note = text.to_string();
            applied.note = true;
        }
        (AnnotateMode::Replace, Some(text)) => {
            note = text.to_string();
            applied.note = true;
        }
        _ => {}
    }

    match (mode, input.nag) {
        (AnnotateMode::Clear, Some(_)) => {
            nag.clear();
            applied.nag = true;
        }
        (AnnotateMode::Clear, None) if nothing_given => {
            nag.clear();
            applied.nag = true;
        }
        (AnnotateMode::Replace, Some(text)) if text.trim().is_empty() => {
            nag.clear();
            applied.nag = true;
        }
        (AnnotateMode::Add, Some(text)) if text.trim().is_empty() => {}
        (_, Some(text)) => match read_nag(text) {
            Ok(glyph) => {
                nag = glyph;
                applied.nag = true;
            }
            Err(reason) => rejected.push(Rejected {
                item: "nag",
                value: Value::String(text.to_string()),
                reason,
            }),
        },
        _ => {}
    }

    if mode == AnnotateMode::Clear && nothing_given {
        applied.arrows += arrows.len();
        arrows.clear();
    } else if let Some(items) = input.arrows {
        let mut valid = Vec::new();

        for v in items {
            // A removal is matched by its squares alone, so its colour is not checked.
            let read = if mode == AnnotateMode::Clear {
                read_arrow_squares(v, source)
            } else {
                read_arrow(v, source)
            };

            match read {
                Ok(a) => valid.push((v, a)),
                Err(reason) => rejected.push(Rejected {
                    item: "arrow",
                    value: v.clone(),
                    reason,
                }),
            }
        }

        match mode {
            AnnotateMode::Clear if items.is_empty() => {
                applied.arrows += arrows.len();
                arrows.clear();
            }
            AnnotateMode::Clear => {
                for (_, a) in &valid {
                    let n = arrows.len();
                    arrows.retain(|x| !(x.from == a.from && x.to == a.to));
                    applied.arrows += n - arrows.len();
                }
            }
            // Nothing readable: keep what the move holds rather than wiping it over a typo.
            AnnotateMode::Replace if valid.is_empty() && !items.is_empty() => {}
            AnnotateMode::Replace => {
                let old_arrows = std::mem::take(&mut arrows);

                for (v, mut a) in valid {
                    // An unchanged arrow keeps who drew it when a page echoes the list back.
                    if let Some(old) = old_arrows
                        .iter()
                        .find(|x| x.from == a.from && x.to == a.to && x.color == a.color)
                    {
                        a.source.clone_from(&old.source);
                    }

                    if let Some(old) = arrows.iter_mut().find(|x| x.from == a.from && x.to == a.to)
                    {
                        *old = a;
                    } else if arrows.len() < MAX_ARROWS {
                        arrows.push(a);
                    } else {
                        rejected.push(Rejected {
                            item: "arrow",
                            value: v.clone(),
                            reason: format!("a move can hold at most {MAX_ARROWS} arrows"),
                        });
                        continue;
                    }

                    applied.arrows += 1;
                }

                if items.is_empty() {
                    applied.arrows += before.2.len();
                }
            }
            AnnotateMode::Add => {
                for (v, a) in valid {
                    if let Some(old) = arrows.iter_mut().find(|x| x.from == a.from && x.to == a.to)
                    {
                        *old = a;
                    } else if arrows.len() < MAX_ARROWS {
                        arrows.push(a);
                    } else {
                        rejected.push(Rejected {
                            item: "arrow",
                            value: v.clone(),
                            reason: format!("a move can hold at most {MAX_ARROWS} arrows"),
                        });
                        continue;
                    }

                    applied.arrows += 1;
                }
            }
        }
    }

    if mode == AnnotateMode::Clear && nothing_given {
        applied.highlights += highlights.len();
        highlights.clear();
    } else if let Some(items) = input.highlights {
        let mut valid = Vec::new();

        for v in items {
            let read = if mode == AnnotateMode::Clear {
                read_highlight_square(v)
            } else {
                read_highlight(v)
            };

            match read {
                Ok(h) => valid.push((v, h)),
                Err(reason) => rejected.push(Rejected {
                    item: "highlight",
                    value: v.clone(),
                    reason,
                }),
            }
        }

        match mode {
            AnnotateMode::Clear if items.is_empty() => {
                applied.highlights += highlights.len();
                highlights.clear();
            }
            AnnotateMode::Clear => {
                for (_, h) in &valid {
                    let n = highlights.len();
                    highlights.retain(|x| x.square != h.square);
                    applied.highlights += n - highlights.len();
                }
            }
            AnnotateMode::Replace if valid.is_empty() && !items.is_empty() => {}
            AnnotateMode::Replace | AnnotateMode::Add => {
                if mode == AnnotateMode::Replace {
                    if items.is_empty() {
                        applied.highlights += highlights.len();
                    }
                    highlights.clear();
                }

                for (v, h) in valid {
                    if let Some(old) = highlights.iter_mut().find(|x| x.square == h.square) {
                        *old = h;
                    } else if highlights.len() < MAX_HIGHLIGHTS {
                        highlights.push(h);
                    } else {
                        rejected.push(Rejected {
                            item: "highlight",
                            value: v.clone(),
                            reason: format!(
                                "a move can hold at most {MAX_HIGHLIGHTS} highlighted squares"
                            ),
                        });
                        continue;
                    }

                    applied.highlights += 1;
                }
            }
        }
    }

    let after = (note, nag, arrows, highlights);
    let changed = after != before;

    if changed {
        game.set_note(id, &after.0)?;
        game.set_nag(id, &after.1)?;
        game.set_arrows(id, &after.2)?;
        game.set_highlights(id, &after.3)?;
    }

    Ok(AnnotationOutcome {
        applied,
        rejected,
        changed,
    })
}

impl Table {
    /// `instance` identifies this program start in frames.
    pub fn new(instance: &str) -> Table {
        Table::with_session(instance, Session::default())
    }

    pub fn with_session(instance: &str, session: Session) -> Table {
        let mut table = Table {
            session,
            rev: 0,
            board_rev: 0,
            game_id: 1,
            next_game_id: 2,
            recent: VecDeque::new(),
            bumps: VecDeque::new(),
            stopped_by_person: None,
            seat_moved_to: None,
            tip_status: None,
            instance: instance.to_string(),
            hint: Hint {
                reason: "init",
                by: "rukh".to_string(),
                intent_id: None,
            },
            extra: SavedExtra::default(),
        };

        table.refresh_tip_status();
        table
    }

    /// The saved form: what cannot be recomputed, without `rev`, `recent` or the hint.
    pub fn to_saved(&self) -> SavedTable {
        let mut game = self.session.game.to_saved();

        for m in &mut game.moves {
            if let Some(extra) = self.extra.moves.get(&m.id) {
                m.extra.clone_from(extra);
            }
        }

        let play = &self.session.play;

        SavedTable {
            game_id: self.game_id,
            board_rev: self.board_rev,
            game,
            play: SavedMatch {
                active: play.active,
                seats: play.seats,
                tip: play.tip,
                style: play.style,
            },
            study: self.session.study.clone(),
            stopped: self.stopped_by_person.and_then(Stopped::from_name),
            extra: self.extra.header.clone(),
            inner_extra: self.extra.inner.clone(),
        }
    }

    /// Rebuilds the game through the rules and recomputes the status at the tip.
    pub fn from_saved(instance: &str, saved: &SavedTable) -> Result<Table, Damaged> {
        let game = Game::from_saved(&saved.game)?;

        let tip = saved.play.tip;
        if game.node(tip).is_none() {
            return Err(Damaged(format!(
                "the match tip is node {tip}, which is not in the game"
            )));
        }

        let session = Session {
            game,
            study: saved.study.clone(),
            play: MatchState {
                active: saved.play.active,
                seats: saved.play.seats,
                tip,
                style: saved.play.style,
            },
        };

        let mut table = Table::with_session(instance, session);
        table.board_rev = saved.board_rev;
        table.set_game_id(saved.game_id);
        table.stopped_by_person = saved.stopped.map(Stopped::name);

        table.extra = SavedExtra {
            header: saved.extra.clone(),
            inner: saved.inner_extra.clone(),
            moves: saved
                .game
                .moves
                .iter()
                .filter(|m| !m.extra.is_empty())
                .map(|m| (m.id, m.extra.clone()))
                .collect(),
        };

        Ok(table)
    }

    /// `match_stop`, `new_game` or `seats` while the person's Stop holds.
    pub fn stopped_by_person(&self) -> Option<&'static str> {
        self.stopped_by_person
    }

    pub(crate) fn saved_header_extra(&self) -> &Extra {
        &self.extra.header
    }

    pub(crate) fn keep_header_extra(&mut self, header: Extra) {
        self.extra.header = header;
    }

    fn refresh_tip_status(&mut self) {
        let m = &self.session.play;

        self.tip_status = if m.active {
            self.session.status_at(m.tip)
        } else {
            None
        };
    }

    /// True when a match is active and its game has no outcome at the tip.
    fn match_in_progress(&self) -> bool {
        self.session.play.active && self.tip_result().is_none()
    }

    /// The result of the game at the match tip, if it has ended.
    pub fn tip_result(&self) -> Option<ResultBody> {
        self.tip_status.as_ref().and_then(|s| {
            s.outcome.map(|outcome| ResultBody {
                outcome,
                reason: s.reason,
            })
        })
    }

    /// The seat a view just moved the AI to from the other colour, while that move stands.
    pub fn seat_moved_to(&self) -> Option<Side> {
        let seats = self.session.play.seats;

        self.seat_moved_to.filter(|to| {
            self.session.play.active
                && seats.get(*to) == Seat::Ai
                && seats.get(to.other()) != Seat::Ai
        })
    }

    pub fn set_instance(&mut self, instance: &str) {
        self.instance = instance.to_string();
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    /// The next change lands on `rev + 1`.
    pub fn set_rev(&mut self, rev: u64) {
        self.rev = rev;
    }

    pub(crate) fn set_game_id(&mut self, game_id: u64) {
        self.game_id = game_id;
        self.next_game_id = self.next_game_id.max(game_id.saturating_add(1));
    }

    /// The `game_id` the next new game takes.
    pub(crate) fn next_game_id(&self) -> u64 {
        self.next_game_id
    }

    pub(crate) fn set_next_game_id(&mut self, next: u64) {
        self.next_game_id = next;
    }

    pub(crate) fn hint(&self) -> &Hint {
        &self.hint
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn game(&self) -> &Game {
        &self.session.game
    }

    pub fn match_state(&self) -> &MatchState {
        &self.session.play
    }

    pub fn rev(&self) -> u64 {
        self.rev
    }

    pub fn board_rev(&self) -> u64 {
        self.board_rev
    }

    pub fn game_id(&self) -> u64 {
        self.game_id
    }

    /// Oldest first.
    pub fn recent(&self) -> &VecDeque<Change> {
        &self.recent
    }

    pub fn live(&self) -> bool {
        self.session.live()
    }

    pub fn to_move(&self) -> Option<Seat> {
        self.session.to_move()
    }

    pub fn is_ai_turn(&self, side: Side) -> bool {
        self.session.is_ai_turn(side)
    }

    /// Changes in `recent` with `board_rev > since` that `by` did not make, oldest first.
    pub fn changes_since(&self, since: u64, by: &str) -> Vec<Change> {
        self.recent
            .iter()
            .filter(|c| c.by != by && c.board_rev > since)
            .cloned()
            .collect()
    }

    /// The changes that end a `wait(for: any_change)` for `by`, oldest first.
    pub fn changes_for(&self, by: &str, since: Option<u64>, start_rev: u64) -> Vec<Change> {
        self.change_report(by, since, start_rev).changes
    }

    /// The full answer for a `wait(for: any_change)`, from the bump log as well as `recent`.
    pub fn change_report(&self, by: &str, since: Option<u64>, start_rev: u64) -> ChangeReport {
        let since = since.filter(|s| *s <= self.board_rev);

        let changes: Vec<Change> = self
            .recent
            .iter()
            .filter(|c| c.by != by)
            .filter(|c| since.is_some_and(|s| c.board_rev > s) || c.rev > start_rev)
            .cloned()
            .collect();

        let mut wake = !changes.is_empty();
        let mut truncated = false;

        if let Some(s) = since {
            if s < self.board_rev {
                // The log holds the bumps board_rev - len + 1 ..= board_rev, one per value.
                let covered = s >= self.board_rev.saturating_sub(self.bumps.len() as u64);

                let others = self
                    .bumps
                    .iter()
                    .filter(|(rev, who)| *rev > s && who != by)
                    .count();

                let listed = changes
                    .iter()
                    .filter(|c| c.bumped && c.board_rev > s)
                    .count();

                if !covered || others > 0 {
                    wake = true;
                }
                truncated = !covered || listed < others;
            }
        }

        ChangeReport {
            changes,
            wake,
            truncated,
        }
    }

    pub fn match_body(&self) -> MatchBody {
        let m = &self.session.play;

        MatchBody {
            active: m.active,
            seats: m.seats,
            tip: m.tip,
            live: self.session.live(),
            to_move: self.session.to_move(),
            style: m.style,
            time_control: None,
        }
    }

    pub fn state(&self) -> StateBody {
        StateBody {
            game_id: self.game_id,
            board_rev: self.board_rev,
            recent: self.recent.iter().cloned().collect(),
            game: self.session.game.snapshot(),
            study: self.session.study.clone(),
            play: self.match_body(),
            clock: None,
        }
    }

    /// The full `{"t":"state",...}` frame sent to views.
    pub fn frame(&self, now_ms: u64) -> String {
        let out = FrameOut {
            t: "state",
            instance: &self.instance,
            rev: self.rev,
            now_ms,
            hint: &self.hint,
            state: self.state(),
        };

        // Cannot fail in practice; if it did, views get a readable error instead of a broken frame.
        serde_json::to_string(&out).unwrap_or_else(|e| {
            json!({"t": "error", "message": format!("could not encode the game state: {e}")})
                .to_string()
        })
    }

    pub fn position(&self, your_seat: Option<Side>, views: u32) -> PositionBody {
        let game = &self.session.game;
        let play = &self.session.play;
        let node = game.current_node();
        let turn = Side::to_move_in(&node.fen);

        let path: Vec<PathStep> = game
            .path()
            .iter()
            .filter_map(|id| game.node(*id))
            .filter_map(|n| {
                n.san.as_ref().map(|san| PathStep {
                    node: n.id,
                    ply: n.ply,
                    san: san.clone(),
                })
            })
            .collect();

        let mut line = Vec::new();
        for (i, step) in path.iter().enumerate() {
            let white_moved = step.ply.saturating_sub(1).is_multiple_of(2);

            if white_moved || i == 0 {
                line.push(numbered(step.ply, &step.san));
            } else {
                line.push(step.san.clone());
            }
        }

        let last_move = match (&node.san, &node.uci) {
            (Some(san), Some(uci)) => Some(LastMove {
                san: san.clone(),
                uci: uci.clone(),
            }),
            _ => None,
        };

        PositionBody {
            node: node.id,
            fen: node.fen.clone(),
            turn: turn.name(),
            ply: node.ply,
            move_number: node.ply / 2 + 1,
            line: line.join(" "),
            last_move,
            status: status_body(&game.status(), turn),
            legal_moves: game.legal_moves().into_iter().map(|m| m.san).collect(),
            clock: None,
            seats: self.session.play.seats,
            to_move: self.session.to_move(),
            your_seat,
            tip: play.active.then_some(play.tip),
            live: self.session.live(),
            style: self.session.play.style.info(),
            note: node.note.clone(),
            nag: node.nag.clone(),
            arrows: node.arrows.clone(),
            highlights: node.highlights.clone(),
            path,
            eval: node.eval.clone(),
            board_rev: self.board_rev,
            views,
        }
    }

    pub fn tree(&self, your_seat: Option<Side>, views: u32) -> TreeBody {
        TreeBody {
            position: self.position(your_seat, views),
            nodes: self.session.game.snapshot().nodes,
        }
    }

    /// Decides a `wait` from the current state alone. `None` means keep waiting.
    pub fn wait_event(
        &self,
        by: &str,
        what: WaitFor,
        start_rev: u64,
        views: u32,
    ) -> Option<WaitEvent> {
        self.wait_event_seated(by, what, start_rev, views, None)
    }

    /// As [`Table::wait_event`], with the caller's seat for an `AnyChange` body.
    pub fn wait_event_seated(
        &self,
        by: &str,
        what: WaitFor,
        start_rev: u64,
        views: u32,
        your_seat: Option<Side>,
    ) -> Option<WaitEvent> {
        match what {
            WaitFor::MyTurn(side) => {
                let play = &self.session.play;
                let seated = play.active && play.seats.get(side) == Seat::Ai;

                if !play.active {
                    let mut ev = WaitEvent::with_position("game_over", self.position(None, views));
                    ev.stopped = self.stopped_by_person;
                    return Some(ev);
                }

                if let Some(result) = self.tip_result() {
                    let mut ev = WaitEvent::with_position(
                        "game_over",
                        self.position(seated.then_some(side), views),
                    );
                    ev.result = Some(result);
                    return Some(ev);
                }

                if !seated {
                    if let Some(to) = self.seat_moved_to().filter(|to| *to == side.other()) {
                        let mut ev = WaitEvent::with_position(
                            "seat_changed",
                            self.position(Some(to), views),
                        );
                        ev.seat = Some(to);
                        return Some(ev);
                    }

                    let mut ev = WaitEvent::with_position("game_over", self.position(None, views));
                    ev.stopped = Some("seats");
                    return Some(ev);
                }

                if !self.is_ai_turn(side) {
                    return None;
                }

                Some(WaitEvent::with_position(
                    "your_turn",
                    self.position(Some(side), views),
                ))
            }
            WaitFor::AnyChange { since } => {
                let report = self.change_report(by, since, start_rev);
                if !report.wake {
                    return None;
                }

                let event = if self.session.game.status().outcome.is_some() {
                    "game_over"
                } else {
                    "changed"
                };

                let mut ev = WaitEvent::with_position(event, self.position(your_seat, views));
                ev.since_last = Some(report.changes);
                ev.since_last_truncated = report.truncated.then_some(true);

                Some(ev)
            }
        }
    }

    /// Applies one intent (JSON text tagged by `op`) on behalf of `by`.
    pub fn apply(&mut self, by: &str, intent_json: &str, now_ms: u64) -> Result<Applied, Error> {
        self.apply_with_id(by, intent_json, now_ms, None)
    }

    /// As [`Table::apply`], recording `intent_id` in the frame's hint.
    pub fn apply_with_id(
        &mut self,
        by: &str,
        intent_json: &str,
        now_ms: u64,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        let intent = Intent::from_json(intent_json)?;
        self.apply_intent(by, intent, now_ms, intent_id)
    }

    /// As [`Table::apply_with_id`], for an intent already read.
    pub fn apply_intent(
        &mut self,
        by: &str,
        intent: Intent,
        now_ms: u64,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        let actor = Actor::of(by);

        let (result, change) = match intent {
            Intent::Play {
                mv,
                from_node,
                note,
                nag,
                arrows,
                highlights,
            } => {
                let input = AnnotationInput {
                    note: note.as_deref(),
                    nag: nag.as_deref(),
                    arrows: arrows.as_deref(),
                    highlights: highlights.as_deref(),
                };
                self.play(actor, &mv, from_node, &input)?
            }
            Intent::Goto { node } => self.navigate(actor, |g| g.goto(node))?,
            Intent::Back => self.navigate(actor, |g| {
                g.back();
                Ok(())
            })?,
            Intent::Forward => self.navigate(actor, |g| {
                g.forward();
                Ok(())
            })?,
            Intent::ToStart => self.navigate(actor, |g| {
                g.to_start();
                Ok(())
            })?,
            Intent::ToEnd => self.navigate(actor, |g| {
                g.to_end();
                Ok(())
            })?,
            Intent::Annotate {
                node,
                note,
                nag,
                arrows,
                highlights,
                mode,
            } => {
                let input = AnnotationInput {
                    note: note.as_deref(),
                    nag: nag.as_deref(),
                    arrows: arrows.as_deref(),
                    highlights: highlights.as_deref(),
                };
                self.annotate(actor, node, mode, &input)?
            }
            Intent::SetEval { node, eval } => {
                let before = self
                    .session
                    .game
                    .node(node)
                    .ok_or(Error::UnknownNode(node))?
                    .eval
                    .clone();

                self.session.game.set_eval(node, eval)?;

                let after = self.session.game.node(node).and_then(|n| n.eval.clone());
                let changed = before != after;

                (
                    json!({"node": node}),
                    changed.then_some(Pending::state("eval")),
                )
            }
            Intent::NewGame { fen, chess960 } => {
                let was_active = self.session.play.active;
                let in_progress = self.match_in_progress();

                let out = self.new_game(fen.as_deref(), chess960)?;

                if was_active && actor == Actor::View {
                    self.stopped_by_person = in_progress.then_some("new_game");
                }
                self.seat_moved_to = None;

                out
            }
            Intent::MatchStart { seats, style } => {
                if actor == Actor::View {
                    self.stopped_by_person = None;
                }
                self.seat_moved_to = None;

                let before = self.session.play;
                let m = &mut self.session.play;
                m.active = true;
                m.seats = seats;
                m.tip = self.session.game.current();
                if let Some(style) = style {
                    m.style = Style::normalize(&style);
                }

                let changed = before != self.session.play;
                (
                    json!({"match": self.match_body()}),
                    changed.then_some(Pending::state("match")),
                )
            }
            Intent::MatchStop => {
                let changed = self.session.play.active;
                let in_progress = self.match_in_progress();

                self.session.play.active = false;
                if changed && actor == Actor::View {
                    self.stopped_by_person = in_progress.then_some("match_stop");
                }
                self.seat_moved_to = None;

                (
                    json!({"match": self.match_body()}),
                    changed.then_some(Pending::state("match")),
                )
            }
            Intent::SetSeats(seats) => {
                let before = self.session.play.seats;
                let changed = before != seats;

                if changed && actor == Actor::View {
                    let ai_only = |s: &Seats, side: Side| {
                        s.get(side) == Seat::Ai && s.get(side.other()) != Seat::Ai
                    };

                    let moved_to = [Side::White, Side::Black]
                        .into_iter()
                        .find(|to| ai_only(&before, to.other()) && ai_only(&seats, *to));

                    let removed = [Side::White, Side::Black]
                        .into_iter()
                        .any(|side| before.get(side) == Seat::Ai && seats.get(side) != Seat::Ai);

                    if moved_to.is_none() && removed && self.match_in_progress() {
                        self.stopped_by_person = Some("seats");
                    }
                    self.seat_moved_to = moved_to;
                }

                self.session.play.seats = seats;
                (
                    json!({"match": self.match_body()}),
                    changed.then_some(Pending::state("seats")),
                )
            }
            Intent::SetStyle { style } => {
                let style = Style::normalize(&style);
                let changed = self.session.play.style != style;

                self.session.play.style = style;
                (
                    json!({"style": style.info(), "match": self.match_body()}),
                    changed.then_some(Pending::state("style")),
                )
            }
            Intent::ClaimSeat { seat } => self.claim_seat(actor, seat)?,
        };

        let changed = change.is_some();
        if let Some(pending) = change {
            self.rev += 1;

            if pending.bump_board {
                self.board_rev = self.board_rev.saturating_add(1);
                self.bumps.push_back((self.board_rev, by.to_string()));

                while self.bumps.len() > BUMP_LOG_MAX {
                    self.bumps.pop_front();
                }
            }

            if let Some((node, san)) = pending.record {
                self.recent.push_back(Change {
                    board_rev: self.board_rev,
                    by: by.to_string(),
                    reason: pending.reason,
                    node,
                    san,
                    rev: self.rev,
                    bumped: pending.bump_board,
                });

                while self.recent.len() > RECENT_MAX {
                    // Non-bumping entries go first, so an AI's notes never push a move out.
                    match self.recent.iter().position(|c| !c.bumped) {
                        Some(i) => {
                            self.recent.remove(i);
                        }
                        None => {
                            self.recent.pop_front();
                        }
                    }
                }
            }

            self.refresh_tip_status();
            self.hint = Hint {
                reason: pending.reason,
                by: by.to_string(),
                intent_id,
            };
        }

        // Results that report board_rev get the value after the change.
        let mut result = result;
        if let Some(obj) = result.as_object_mut() {
            if obj.contains_key("board_rev") {
                obj.insert("board_rev".into(), json!(self.board_rev));
            }
        }

        Ok(Applied {
            frame_json: self.frame(now_ms),
            result_json: result.to_string(),
            result,
            rev: self.rev,
            changed,
        })
    }

    fn play(
        &mut self,
        actor: Actor,
        text: &str,
        from_node: Option<NodeId>,
        input: &AnnotationInput<'_>,
    ) -> Result<(Value, Option<Pending>), Error> {
        let s = &mut self.session;
        let in_match = actor == Actor::Ai && s.play.active;
        let from = if in_match {
            s.play.tip
        } else {
            s.game.current()
        };

        if actor == Actor::Ai {
            if let Some(status) = s.status_at(from).filter(|st| st.outcome.is_some()) {
                return Err(Error::GameOver(format!(
                    "The game is over ({}, {}). No move can be played; the person can start a \
                     new game on the board.",
                    status.outcome.unwrap_or(""),
                    status.reason
                )));
            }
        }

        let stale = from_node.filter(|given| *given != from).map(|given| {
            let after = s
                .game
                .node(from)
                .and_then(|n| n.san.as_ref().map(|san| numbered(n.ply, san)))
                .map(|m| format!("after {m}"))
                .unwrap_or_else(|| "the start position".to_string());

            format!(
                "The board has moved on: the move would be played from node {from} ({after}), \
                 not node {given}."
            )
        });

        if in_match {
            let side = s.turn_at_tip();
            let seat = s.play.seats.get(side);

            if seat != Seat::Ai {
                let who = match seat {
                    Seat::Human => "the person",
                    Seat::Engine => "the engine",
                    Seat::Ai => "an AI",
                };
                let moved_on = stale.map(|t| format!(" {t}")).unwrap_or_default();

                return Err(Error::NotYourTurn(format!(
                    "It is not your turn: {} is to move and {} plays {}.{moved_on} Call wait and \
                     play when it returns your_turn.",
                    side.title(),
                    who,
                    side.title()
                )));
            }
        }

        if let Some(text) = stale {
            return Err(Error::Stale(format!(
                "{text} Read the position again and choose a move from there."
            )));
        }

        let back_to = s.game.current();
        if from != back_to {
            s.game.goto(from)?;
        }

        let cleaned = clean_move_text(text);
        let played = match s.game.play(&cleaned) {
            Ok(p) => p,
            Err(_) => {
                let legal: Vec<String> = s.game.legal_moves().into_iter().map(|m| m.san).collect();
                let shown: String = text.trim().chars().take(40).collect();

                let message = format!(
                    "{} is not a legal move here. {} is to move. Legal moves: {}.",
                    if shown.is_empty() {
                        "An empty move".to_string()
                    } else {
                        shown
                    },
                    Side::to_move_in(s.game.fen()).title(),
                    legal.join(", ")
                );

                let _ = s.game.goto(back_to);
                return Err(Error::IllegalMove(message));
            }
        };

        if s.play.active && from == s.play.tip {
            s.play.tip = played.node;
        }

        let outcome = annotate_node(
            &mut s.game,
            played.node,
            AnnotateMode::Add,
            input,
            actor.arrow_source(),
        )?;

        let turn = Side::to_move_in(&played.fen);
        let status = status_body(&s.game.status(), turn);

        let result = json!({
            "node": played.node,
            "san": played.san,
            "uci": played.uci,
            "fen": played.fen,
            "turn": turn.name(),
            "status": status,
            "reused": played.reused,
            "applied": outcome.applied,
            "rejected": outcome.rejected,
            "board_rev": 0,
        });

        Ok((
            result,
            Some(Pending::board(
                "move",
                true,
                played.node,
                Some(played.san.clone()),
            )),
        ))
    }

    fn navigate(
        &mut self,
        actor: Actor,
        step: impl FnOnce(&mut Game) -> Result<(), Error>,
    ) -> Result<(Value, Option<Pending>), Error> {
        let before = self.session.game.current();
        step(&mut self.session.game)?;

        let game = &self.session.game;
        let node = game.current_node();
        let result = json!({
            "node": node.id,
            "fen": node.fen,
            "turn": Side::to_move_in(&node.fen).name(),
            "ply": node.ply,
            "live": self.session.live(),
        });

        if node.id == before {
            return Ok((result, None));
        }

        let pending = match actor {
            Actor::View => Pending::board("navigate", true, node.id, node.san.clone()),
            Actor::Ai => Pending::board("navigate", false, node.id, node.san.clone()),
            Actor::Other => Pending::state("navigate"),
        };

        Ok((result, Some(pending)))
    }

    fn annotate(
        &mut self,
        actor: Actor,
        node: Option<NodeId>,
        mode: AnnotateMode,
        input: &AnnotationInput<'_>,
    ) -> Result<(Value, Option<Pending>), Error> {
        let id = node.unwrap_or_else(|| self.session.game.current());

        let outcome = annotate_node(
            &mut self.session.game,
            id,
            mode,
            input,
            actor.arrow_source(),
        )?;

        let result = json!({
            "node": id,
            "applied": outcome.applied,
            "rejected": outcome.rejected,
            "board_rev": 0,
        });

        if !outcome.changed {
            return Ok((result, None));
        }

        let pending = match actor {
            Actor::View => Pending::board("annotate", true, id, None),
            Actor::Ai => Pending::board("annotate", false, id, None),
            Actor::Other => Pending::state("annotate"),
        };

        Ok((result, Some(pending)))
    }

    fn new_game(
        &mut self,
        fen: Option<&str>,
        chess960: Option<u16>,
    ) -> Result<(Value, Option<Pending>), Error> {
        let game = match (fen, chess960) {
            (Some(_), Some(_)) => {
                return Err(Error::BadInput(
                    "give either fen or chess960 for a new game, not both".into(),
                ))
            }
            (Some(fen), None) => Game::from_fen(fen, None)?,
            (None, Some(n)) => Game::chess960(n)?,
            (None, None) => Game::standard(),
        };

        self.session.game = game;
        self.extra.moves.clear();
        self.extra.inner.root.clear();
        self.session.play.active = false;
        self.session.play.tip = 0;
        self.game_id = self.next_game_id;
        self.next_game_id = self.next_game_id.saturating_add(1);

        let g = &self.session.game;
        let result = json!({
            "node": 0,
            "fen": g.fen(),
            "turn": g.turn(),
            "variant": g.variant(),
            "chess960_number": g.chess960_number(),
            "game_id": self.game_id,
        });

        Ok((result, Some(Pending::board("new_game", true, 0, None))))
    }

    fn claim_seat(&mut self, actor: Actor, seat: Side) -> Result<(Value, Option<Pending>), Error> {
        if actor != Actor::Ai {
            return Err(Error::BadInput(
                "claim_seat is for AI clients; a board sets seats with match_start or set_seats"
                    .into(),
            ));
        }

        let stopped = self.stopped_by_person;
        let moved_away = self.seat_moved_to() == Some(seat.other());
        let m = &mut self.session.play;

        let (claimed, started) = if moved_away {
            // The wait that follows reports the new seat.
            (false, false)
        } else if !m.active {
            if let Some(how) = stopped {
                let what = if how == "new_game" {
                    "The person started a new game on the board, which ended the match"
                } else {
                    "The person stopped the match on the board"
                };

                return Err(Error::BadInput(format!(
                    "{what}, so wait does not start another one. Stop and tell them. If they want \
                     to play again, ask them to press Start on the board with Opponent: AI, then \
                     call wait with seat=\"{}\".",
                    seat.name()
                )));
            }

            m.seats.set(seat, Seat::Ai);
            m.seats.set(seat.other(), Seat::Human);
            m.active = true;
            m.tip = self.session.game.current();

            (true, true)
        } else {
            match (m.seats.get(seat), m.seats.get(seat.other())) {
                (Seat::Ai, _) => (false, false),
                (Seat::Engine, _) => {
                    return Err(Error::BadInput(format!(
                        "{} is played by the engine in this match. Ask the person to change the \
                         seats on the board.",
                        seat.title()
                    )))
                }
                (Seat::Human, Seat::Ai) => {
                    return Err(Error::BadInput(format!(
                        "In this match the AI plays {}, not {}. Call wait with seat=\"{}\", or \
                         ask the person to change the seats on the board.",
                        seat.other().title(),
                        seat.title(),
                        seat.other().name()
                    )))
                }
                (Seat::Human, _) => {
                    // The person chose a human for this seat; an AI does not take it over.
                    return Err(Error::BadInput(format!(
                        "In this match the person has {} played by a person, not by an AI. Stop \
                         and tell them; if they want you to play, ask them to set Opponent: AI on \
                         the board. To follow the game without playing, call wait with \
                         for=\"any_change\".",
                        seat.title()
                    )));
                }
            }
        };

        let result = json!({
            "seat": seat,
            "claimed": claimed,
            "started": started,
            "match": self.match_body(),
        });

        Ok((result, claimed.then_some(Pending::state("seats"))))
    }
}

/// A change about to be counted.
struct Pending {
    reason: &'static str,
    bump_board: bool,
    /// Listed in `recent` as `(node, san)` when set.
    record: Option<(NodeId, Option<String>)>,
}

impl Pending {
    /// `rev` moves, nothing is listed.
    fn state(reason: &'static str) -> Pending {
        Pending {
            reason,
            bump_board: false,
            record: None,
        }
    }

    /// Listed in `recent`; `bump_board` says whether `board_rev` moves.
    fn board(reason: &'static str, bump_board: bool, node: NodeId, san: Option<String>) -> Pending {
        Pending {
            reason,
            bump_board,
            record: Some((node, san)),
        }
    }
}
