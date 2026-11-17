//! Saved forms of a game, a table, a tab and the list of tabs, with their file text.

use std::fmt;
use std::fmt::Write;

use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::desk::{TabId, TabKind, MAX_TAB_NUMBER};
use crate::session::{Seats, Study, Style};
use crate::{Arrow, Eval, Game, Highlight, Node, NodeId, Variant};

/// The `v` every saved file carries.
pub const SAVED_VERSION: u64 = 1;

/// The largest `game_id`, `board_rev` or `next_game_id` a file may hold: far below 2^53, where JavaScript stops being exact.
pub const MAX_SAVED_COUNT: u64 = 1 << 50;

/// Why a saved board could not be read, in words a person can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Damaged(pub String);

impl fmt::Display for Damaged {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for Damaged {}

/// Fields a file holds that this version does not know, written back on the next save.
pub type Extra = Map<String, Value>;

/// The annotations of one node, each left out of the file when empty.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SavedNotes {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub nag: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arrows: Vec<Arrow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub highlights: Vec<Highlight>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eval: Option<Eval>,
}

impl SavedNotes {
    fn of(node: &Node) -> SavedNotes {
        SavedNotes {
            note: node.note.clone(),
            nag: node.nag.clone(),
            arrows: node.arrows.clone(),
            highlights: node.highlights.clone(),
            eval: node.eval.clone(),
        }
    }

    pub fn is_empty(&self) -> bool {
        *self == SavedNotes::default()
    }
}

/// One move of a saved game: one line of the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedMove {
    pub id: NodeId,
    pub from: NodeId,
    pub uci: String,
    /// For a person reading the file; checked against the replay on load.
    pub san: String,
    #[serde(flatten)]
    pub notes: SavedNotes,
    #[serde(flatten)]
    pub extra: Extra,
}

/// What a game needs to be rebuilt through the rules.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedGame {
    pub variant: Variant,
    pub chess960: Option<u16>,
    pub start_fen: String,
    /// The node shown.
    pub current: NodeId,
    /// Annotations on the start position.
    pub root: SavedNotes,
    pub moves: Vec<SavedMove>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SavedMatch {
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub seats: Seats,
    #[serde(default)]
    pub tip: NodeId,
    #[serde(default)]
    pub style: Style,
}

/// How the person ended the last match, kept so an AI's seat claim does not start another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stopped {
    MatchStop,
    NewGame,
    Seats,
}

impl Stopped {
    pub fn name(self) -> &'static str {
        match self {
            Stopped::MatchStop => "match_stop",
            Stopped::NewGame => "new_game",
            Stopped::Seats => "seats",
        }
    }

    pub fn from_name(name: &str) -> Option<Stopped> {
        match name {
            "match_stop" => Some(Stopped::MatchStop),
            "new_game" => Some(Stopped::NewGame),
            "seats" => Some(Stopped::Seats),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SavedTable {
    pub game_id: u64,
    pub board_rev: u64,
    pub game: SavedGame,
    pub play: SavedMatch,
    pub study: Study,
    pub stopped: Option<Stopped>,
    pub extra: Extra,
    pub inner_extra: InnerExtra,
}

/// Unknown fields inside `match`, `study` and `root`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InnerExtra {
    pub play: Extra,
    pub study: Extra,
    pub root: Extra,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SavedBody {
    Free {
        source: Option<String>,
        table: Box<SavedTable>,
    },
    /// A stub: the coach's own files hold the game.
    Game {
        coach_game: Option<String>,
        extra: Extra,
    },
    /// A stub with no position.
    Reps { extra: Extra },
}

/// One tab file.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedTab {
    pub id: TabId,
    pub name: String,
    pub body: SavedBody,
}

/// `index.json`: the order, the selection and the counters.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedIndex {
    pub selected: Option<TabId>,
    pub order: Vec<TabId>,
    pub next_tab: u32,
    pub next_game_id: u64,
    pub extra: Extra,
}

impl Default for SavedIndex {
    /// The index of an empty folder, and the start of a rebuilt one.
    fn default() -> SavedIndex {
        SavedIndex {
            selected: None,
            order: Vec::new(),
            next_tab: 1,
            next_game_id: 1,
            extra: Extra::new(),
        }
    }
}

/// The tab id at the start of a file name: `t4.json`, `t3.1763230000000.json`.
pub fn tab_id_in_file_name(name: &str) -> Option<TabId> {
    name.split('.').next()?.parse().ok()
}

fn json_text<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn not_json(e: serde_json::Error) -> Damaged {
    Damaged(format!("the file is not readable JSON: {e}"))
}

fn bad_field(e: serde_json::Error) -> Damaged {
    Damaged(format!("a field is missing or of the wrong type: {e}"))
}

/// Reads the text as an object whose `v` is one this version knows.
fn versioned(text: &str) -> Result<Value, Damaged> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let value: Value = serde_json::from_str(text).map_err(not_json)?;

    if !value.is_object() {
        return Err(Damaged("the file is not a JSON object".into()));
    }

    match value.get("v") {
        Some(v) if v.as_u64() == Some(SAVED_VERSION) => Ok(value),
        Some(v) => Err(Damaged(format!(
            "the file is version {v}, and this Rukh reads version {SAVED_VERSION}"
        ))),
        None => Err(Damaged("the file has no version field \"v\"".into())),
    }
}

fn apply_notes(game: &mut Game, id: NodeId, notes: &SavedNotes) -> Result<(), crate::Error> {
    game.set_note(id, &notes.note)?;
    game.set_nag(id, &notes.nag)?;
    game.set_arrows(id, &notes.arrows)?;
    game.set_highlights(id, &notes.highlights)?;
    game.set_eval(id, notes.eval.clone())
}

impl Game {
    /// Only what cannot be recomputed: the start, and each move with its annotations.
    pub fn to_saved(&self) -> SavedGame {
        let moves = self
            .nodes
            .iter()
            .flatten()
            .filter_map(|n| {
                Some(SavedMove {
                    id: n.id,
                    from: n.parent?,
                    uci: n.uci.clone().unwrap_or_default(),
                    san: n.san.clone().unwrap_or_default(),
                    notes: SavedNotes::of(n),
                    extra: Extra::new(),
                })
            })
            .collect();

        SavedGame {
            variant: self.variant,
            chess960: self.chess960_number,
            start_fen: self.start_fen.clone(),
            current: self.current,
            root: self.node(0).map(SavedNotes::of).unwrap_or_default(),
            moves,
        }
    }

    /// Replays the moves in ascending id; any move that does not come out as written is refused.
    pub fn from_saved(saved: &SavedGame) -> Result<Game, Damaged> {
        let mut game = Game::from_fen(&saved.start_fen, Some(saved.variant))
            .map_err(|e| Damaged(format!("the start position cannot be used: {e}")))?;

        match (saved.variant, saved.chess960) {
            (Variant::Standard, Some(n)) => {
                return Err(Damaged(format!(
                    "chess960 is {n} on a game whose variant is standard"
                )))
            }
            (Variant::Chess960, Some(n)) if n >= 960 => {
                return Err(Damaged(format!(
                    "chess960 is {n}; a Chess960 number is 0 to 959"
                )))
            }
            (Variant::Chess960, Some(n)) if game.chess960_number != Some(n) => {
                return Err(Damaged(format!(
                    "chess960 is {n}, but the start position is not Chess960 position {n}"
                )))
            }
            (Variant::Chess960, _) | (Variant::Standard, None) => {}
        }

        apply_notes(&mut game, 0, &saved.root)
            .map_err(|e| Damaged(format!("the start position's annotations: {e}")))?;

        let mut moves: Vec<&SavedMove> = saved.moves.iter().collect();
        moves.sort_by_key(|m| m.id);

        if let Some(pair) = moves.windows(2).find(|w| w[0].id == w[1].id) {
            return Err(Damaged(format!("move id {} appears twice", pair[0].id)));
        }

        for m in moves {
            replay(&mut game, m)?;
        }

        game.goto(saved.current).map_err(|_| {
            Damaged(format!(
                "current is node {}, which is not in the game",
                saved.current
            ))
        })?;

        Ok(game)
    }
}

fn replay(game: &mut Game, m: &SavedMove) -> Result<(), Damaged> {
    let name = format!("move id {} ({})", m.id, m.san);

    if m.id == 0 {
        return Err(Damaged(format!(
            "{name}: id 0 is the start position; moves count from 1"
        )));
    }

    game.goto(m.from).map_err(|_| {
        Damaged(format!(
            "{name} is played from node {}, which is not in the game",
            m.from
        ))
    })?;

    let played = game.play(&m.uci).map_err(|_| {
        Damaged(format!(
            "{name}: {} is not a legal move after node {}",
            m.uci, m.from
        ))
    })?;

    if played.reused {
        return Err(Damaged(format!(
            "{name} repeats move id {}, the same move from the same node",
            played.node
        )));
    }

    if played.node != m.id {
        return Err(Damaged(format!(
            "{name} comes out as node {}; ids count up from 1 with no gaps",
            played.node
        )));
    }

    if played.uci != m.uci {
        return Err(Damaged(format!(
            "{name}: the move is written {} but plays as {}",
            m.uci, played.uci
        )));
    }

    if played.san != m.san {
        return Err(Damaged(format!(
            "{name}: {} is {} in this position, not {}",
            m.uci, played.san, m.san
        )));
    }

    apply_notes(game, m.id, &m.notes).map_err(|e| Damaged(format!("{name}: {e}")))
}

#[derive(Deserialize)]
struct FreeFile {
    #[serde(rename = "v")]
    _version: IgnoredAny,
    #[serde(rename = "kind")]
    _kind: IgnoredAny,
    id: TabId,
    name: String,
    #[serde(default)]
    source: Option<String>,
    game_id: u64,
    board_rev: u64,
    variant: Variant,
    #[serde(default)]
    chess960: Option<u16>,
    start_fen: String,
    current: NodeId,
    #[serde(rename = "match", default)]
    play: WithExtra<SavedMatch>,
    #[serde(default)]
    study: WithExtra<Study>,
    #[serde(default)]
    stopped: Option<Stopped>,
    #[serde(default)]
    root: WithExtra<SavedNotes>,
    moves: Vec<Value>,
    #[serde(flatten)]
    extra: Extra,
}

/// An object read into its known shape, with the fields it does not know kept beside it.
#[derive(Deserialize, Default)]
struct WithExtra<T: Default> {
    #[serde(flatten)]
    known: T,
    #[serde(flatten)]
    extra: Extra,
}

#[derive(Deserialize)]
struct GameStub {
    #[serde(rename = "v")]
    _version: IgnoredAny,
    #[serde(rename = "kind")]
    _kind: IgnoredAny,
    id: TabId,
    name: String,
    #[serde(default)]
    coach_game: Option<String>,
    #[serde(flatten)]
    extra: Extra,
}

#[derive(Deserialize)]
struct RepsStub {
    #[serde(rename = "v")]
    _version: IgnoredAny,
    #[serde(rename = "kind")]
    _kind: IgnoredAny,
    id: TabId,
    name: String,
    #[serde(flatten)]
    extra: Extra,
}

impl SavedTab {
    pub fn kind(&self) -> TabKind {
        match self.body {
            SavedBody::Free { .. } => TabKind::Free,
            SavedBody::Game { .. } => TabKind::Game,
            SavedBody::Reps { .. } => TabKind::Reps,
        }
    }

    /// Reads a tab file. The game is not replayed here; [`crate::Tab::from_saved`] does that.
    pub fn from_text(text: &str) -> Result<SavedTab, Damaged> {
        let value = versioned(text)?;

        let kind = match value.get("kind") {
            Some(Value::String(kind)) => kind.clone(),
            Some(other) => {
                return Err(Damaged(format!(
                    "kind is {other}; it is \"free\", \"game\" or \"reps\""
                )))
            }
            None => return Err(Damaged("the file has no kind".into())),
        };

        match kind.as_str() {
            "free" => read_free(value),
            "game" => {
                let stub: GameStub = serde_json::from_value(value).map_err(bad_field)?;

                Ok(SavedTab {
                    id: stub.id,
                    name: stub.name,
                    body: SavedBody::Game {
                        coach_game: stub.coach_game,
                        extra: stub.extra,
                    },
                })
            }
            "reps" => {
                let stub: RepsStub = serde_json::from_value(value).map_err(bad_field)?;

                Ok(SavedTab {
                    id: stub.id,
                    name: stub.name,
                    body: SavedBody::Reps { extra: stub.extra },
                })
            }
            other => Err(Damaged(format!(
                "kind is {other:?}; it is \"free\", \"game\" or \"reps\""
            ))),
        }
    }

    /// The header pretty-printed and each move on one line, ending in a newline.
    pub fn to_text(&self) -> String {
        let head = format!(
            "{{ \"v\": {SAVED_VERSION}, \"id\": {}, \"name\": {}",
            json_text(&self.id),
            json_text(&self.name)
        );

        match &self.body {
            SavedBody::Free { source, table } => free_text(&head, source.as_deref(), table),
            SavedBody::Game { coach_game, extra } => format!(
                "{head}, \"kind\": \"game\", \"coach_game\": {}{} }}\n",
                json_text(coach_game),
                inline_extra(extra)
            ),
            SavedBody::Reps { extra } => {
                format!("{head}, \"kind\": \"reps\"{} }}\n", inline_extra(extra))
            }
        }
    }
}

fn within_count(name: &str, value: u64) -> Result<u64, Damaged> {
    if value > MAX_SAVED_COUNT {
        return Err(Damaged(format!(
            "{name} is {value}; the largest it may be is {MAX_SAVED_COUNT}"
        )));
    }

    Ok(value)
}

fn read_free(value: Value) -> Result<SavedTab, Damaged> {
    let file: FreeFile = serde_json::from_value(value).map_err(bad_field)?;

    let game_id = within_count("game_id", file.game_id)?;
    let board_rev = within_count("board_rev", file.board_rev)?;

    let moves = file
        .moves
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            serde_json::from_value::<SavedMove>(m)
                .map_err(|e| Damaged(format!("move {} of the list cannot be read: {e}", i + 1)))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let game = SavedGame {
        variant: file.variant,
        chess960: file.chess960,
        start_fen: file.start_fen,
        current: file.current,
        root: file.root.known,
        moves,
    };

    Ok(SavedTab {
        id: file.id,
        name: file.name,
        body: SavedBody::Free {
            source: file.source,
            table: Box::new(SavedTable {
                game_id,
                board_rev,
                game,
                play: file.play.known,
                study: file.study.known,
                stopped: file.stopped,
                extra: file.extra,
                inner_extra: InnerExtra {
                    play: file.play.extra,
                    study: file.study.extra,
                    root: file.root.extra,
                },
            }),
        },
    })
}

fn inline_extra(extra: &Extra) -> String {
    extra
        .iter()
        .map(|(k, v)| format!(", {}: {}", json_text(k), json_text(v)))
        .collect()
}

fn free_text(head: &str, source: Option<&str>, table: &SavedTable) -> String {
    let game = &table.game;
    let play = &table.play;
    let inner = &table.inner_extra;
    let mut out = String::new();

    let _ = writeln!(
        out,
        "{head}, \"kind\": \"free\", \"source\": {},",
        json_text(&source)
    );
    let _ = writeln!(
        out,
        "  \"game_id\": {}, \"board_rev\": {}, \"variant\": {}, \"chess960\": {},",
        table.game_id,
        table.board_rev,
        json_text(&game.variant),
        json_text(&game.chess960)
    );
    let _ = writeln!(out, "  \"start_fen\": {},", json_text(&game.start_fen));
    let _ = writeln!(out, "  \"current\": {},", game.current);
    let _ = writeln!(
        out,
        "  \"match\": {{ \"active\": {}, \"seats\": {{ \"white\": {}, \"black\": {} }}, \"tip\": {}, \"style\": {}{} }},",
        play.active,
        json_text(&play.seats.white),
        json_text(&play.seats.black),
        play.tip,
        json_text(&play.style),
        inline_extra(&inner.play)
    );
    let _ = writeln!(
        out,
        "  \"study\": {{ \"title\": {}, \"notes\": {}{} }},",
        json_text(&table.study.title),
        json_text(&table.study.notes),
        inline_extra(&inner.study)
    );

    if let Some(stopped) = table.stopped {
        let _ = writeln!(out, "  \"stopped\": {},", json_text(&stopped));
    }

    if !game.root.is_empty() || !inner.root.is_empty() {
        let mut root = json_text(&game.root);
        let unknown: Vec<String> = inner
            .root
            .iter()
            .map(|(key, value)| format!("{}:{}", json_text(key), json_text(value)))
            .collect();

        if !unknown.is_empty() {
            root.pop();
            if root.len() > 1 {
                root.push(',');
            }
            root.push_str(&unknown.join(","));
            root.push('}');
        }

        let _ = writeln!(out, "  \"root\": {root},");
    }

    for (key, value) in &table.extra {
        let _ = writeln!(out, "  {}: {},", json_text(key), json_text(value));
    }

    if game.moves.is_empty() {
        out.push_str("  \"moves\": [] }\n");
        return out;
    }

    let lines: Vec<String> = game
        .moves
        .iter()
        .map(|m| format!("    {}", json_text(m)))
        .collect();

    out.push_str("  \"moves\": [\n");
    out.push_str(&lines.join(",\n"));
    out.push_str("\n  ] }\n");

    out
}

#[derive(Deserialize)]
struct IndexFile {
    #[serde(rename = "v")]
    _version: IgnoredAny,
    #[serde(default)]
    selected: Option<TabId>,
    order: Vec<TabId>,
    next_tab: u32,
    next_game_id: u64,
    #[serde(flatten)]
    extra: Extra,
}

impl SavedIndex {
    pub fn from_text(text: &str) -> Result<SavedIndex, Damaged> {
        let file: IndexFile = serde_json::from_value(versioned(text)?).map_err(bad_field)?;

        if file.next_tab > MAX_TAB_NUMBER + 1 {
            return Err(Damaged(format!(
                "next_tab is {}; the largest it may be is {}",
                file.next_tab,
                MAX_TAB_NUMBER + 1
            )));
        }

        Ok(SavedIndex {
            selected: file.selected,
            order: file.order,
            next_tab: file.next_tab,
            next_game_id: within_count("next_game_id", file.next_game_id)?,
            extra: file.extra,
        })
    }

    /// One line, ending in a newline.
    pub fn to_text(&self) -> String {
        let order: Vec<String> = self.order.iter().map(json_text).collect();

        format!(
            "{{ \"v\": {SAVED_VERSION}, \"selected\": {}, \"order\": [{}], \"next_tab\": {}, \"next_game_id\": {}{} }}\n",
            json_text(&self.selected),
            order.join(", "),
            self.next_tab,
            self.next_game_id,
            inline_extra(&self.extra)
        )
    }

    /// Raises `next_tab` above an id seen anywhere, such as a file in `closed/` or `broken/`.
    pub fn note_seen(&mut self, id: TabId) {
        self.next_tab = self.next_tab.max(id.number().saturating_add(1));
    }
}
