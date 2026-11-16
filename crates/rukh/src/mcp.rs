//! MCP over streamable HTTP at `/mcp`: tools, prompts and server instructions.

use std::borrow::Cow;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, PromptMessage, ProtocolVersion, Role,
    ServerCapabilities, ServerConfig,
};
use rmcp::service::{MaybeSendFuture, NotificationContext, RequestContext};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{
    prompt, prompt_handler, prompt_router, schemars, tool, tool_handler, tool_router, ErrorData,
    RoleServer, ServerHandler,
};
use rukh_core::session::{RULE_ANNOTATE, RULE_COACH, RULE_SILENT};
use rukh_core::{Seat, Side, TabId, WaitEvent, WaitFor};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::hub::{in_progress, only_ai_seat, Hub, Refused};
use crate::presence::clean_name;

pub type Service = StreamableHttpService<RukhMcp, LocalSessionManager>;

/// Default and bounds of wait's timeout_s, kept under the 300 s session keep-alive.
const WAIT_DEFAULT_S: u64 = 45;
const WAIT_MIN_S: u64 = 1;
const WAIT_MAX_S: u64 = 240;

const PROGRESS_EVERY: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(10)
};

/// A client that stopped reading must not hold a wait past its deadline.
const PROGRESS_SEND_LIMIT: Duration = Duration::from_secs(2);

/// Later versions have no session, so who a client is would be lost; see docs/program.md.
const MAX_PROTOCOL: ProtocolVersion = ProtocolVersion::V_2025_11_25;

const TAB_CLOSED: &str = "The person closed the board this game was on, so the game is over for \
     you. Stop and tell them; nothing more happens until they press Start on a board.";

const GAME_CLOSED: &str = "That game was closed.";

/// Which board a session acts on; see docs/program.md.
#[derive(Debug, Default)]
struct Place {
    /// The tab and seat a seated `wait` took; every call acts there while it lasts.
    bound: Option<(TabId, Side)>,
    /// The tab of the last result this session was given.
    seen: Option<TabId>,
    /// The tab of the newest binding, kept after it ends.
    last_bound: Option<TabId>,
    /// The person closed the bound tab, so no match starts on the shown board.
    closed: bool,
}

/// One per MCP session, so what is kept here belongs to that client alone.
#[derive(Clone)]
pub struct RukhMcp {
    hub: Arc<Hub>,
    /// For the no-board-open note.
    link: Arc<str>,
    session: u64,
    /// `(by, name)`, fixed at the first request.
    me: Arc<OnceLock<(String, String)>>,
    /// `(game_id, node)` last shown; stands in for a missing `from_node`. Cleared by any play.
    turn_seen: Arc<Mutex<Option<(u64, u32)>>>,
    /// The seat of this client's last `wait(for: my_turn)`.
    last_side: Arc<Mutex<Option<Side>>>,
    place: Arc<Mutex<Place>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SeatArg {
    White,
    Black,
}

impl From<SeatArg> for Side {
    fn from(seat: SeatArg) -> Side {
        match seat {
            SeatArg::White => Side::White,
            SeatArg::Black => Side::Black,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WaitForArg {
    /// Return when it is your turn (the default).
    MyTurn,
    /// Return when anyone else changes the board: a move, a new game, a note, an arrow.
    AnyChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DetailArg {
    /// The current position (the default).
    Position,
    /// The current position plus every move of the game, variations included.
    Tree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ModeArg {
    /// A note or glyph replaces the old one, arrows and highlights are added (the default).
    Add,
    /// Every field given replaces what the move holds; an empty value clears it.
    Replace,
    /// Removes the fields given, or everything when none is given.
    Clear,
}

// Schema only: the items arrive as raw JSON so the table can refuse a bad one alone.

/// An arrow from one square to another.
#[allow(dead_code)]
#[derive(Debug, schemars::JsonSchema)]
pub struct ArrowArg {
    /// Start square, a1..h8.
    pub from: String,
    /// End square, a1..h8.
    pub to: String,
    /// green (default), red, blue or yellow.
    pub color: Option<String>,
}

/// A highlighted square.
#[allow(dead_code)]
#[derive(Debug, schemars::JsonSchema)]
pub struct HighlightArg {
    /// The square, a1..h8.
    pub square: String,
    /// green (default), red, blue or yellow.
    pub color: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetGameArgs {
    /// position (default) or tree.
    #[serde(default)]
    pub detail: Option<DetailArg>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WaitArgs {
    /// The colour you play, for playing only (ignored with for=any_change). Passing it takes that
    /// seat if the person has not assigned it, and starts a match when none is running.
    #[serde(default)]
    pub seat: Option<SeatArg>,
    /// my_turn (default) or any_change.
    #[serde(default, rename = "for")]
    #[schemars(rename = "for")]
    pub what: Option<WaitForArg>,
    /// For any_change: the board_rev you last saw. Changes after it are reported.
    #[serde(default)]
    pub since: Option<u64>,
    /// Seconds to wait before returning event=timeout, 1 to 240 (default 45). The default suits
    /// most clients; use more only if your client allows tool calls that long.
    #[serde(default)]
    #[schemars(range(min = 1, max = 240))]
    pub timeout_s: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PlayArgs {
    /// The move, in SAN (Nf3, O-O, exd8=Q) or UCI (g1f3, e7e8q).
    #[serde(rename = "move")]
    #[schemars(rename = "move")]
    pub mv: String,
    /// The node the move must be played from (from the position you read). If the board has
    /// moved on, the move is refused as stale instead of being played somewhere else.
    #[serde(default)]
    pub from_node: Option<u32>,
    /// A note attached to the new move.
    #[serde(default)]
    pub note: Option<String>,
    /// A glyph for the new move: ! ? !! ?? !? ?!
    #[serde(default)]
    pub nag: Option<String>,
    /// Arrows to draw on the new move.
    #[serde(default)]
    #[schemars(with = "Option<Vec<ArrowArg>>")]
    pub arrows: Option<Vec<Value>>,
    /// Squares to highlight on the new move.
    #[serde(default)]
    #[schemars(with = "Option<Vec<HighlightArg>>")]
    pub highlights: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AnnotateArgs {
    /// The node to annotate. Defaults to the current move.
    #[serde(default)]
    pub node: Option<u32>,
    /// A note for the move.
    #[serde(default)]
    pub note: Option<String>,
    /// A glyph: ! ? !! ?? !? ?!
    #[serde(default)]
    pub nag: Option<String>,
    /// Arrows to draw.
    #[serde(default)]
    #[schemars(with = "Option<Vec<ArrowArg>>")]
    pub arrows: Option<Vec<Value>>,
    /// Squares to highlight.
    #[serde(default)]
    #[schemars(with = "Option<Vec<HighlightArg>>")]
    pub highlights: Option<Vec<Value>>,
    /// add (default), replace or clear.
    #[serde(default)]
    pub mode: Option<ModeArg>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PlayPromptArgs {
    /// white or black. Defaults to black.
    #[serde(default)]
    pub side: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReviewPromptArgs {
    /// The person's level, for example beginner, club or strong.
    #[serde(default)]
    pub level: Option<String>,
}

pub fn instructions() -> String {
    format!(
        "Rukh is a shared 3D chessboard: a person plays on it in the browser, and you join the same \
         game with these tools. To play, loop: call wait with your seat, then play, then wait \
         again; to coach, call wait with for=any_change and since=<board_rev> and annotate what \
         the person does. The board owns the style; read style.name and style.rule in each \
         result.\n\
         - silent: {RULE_SILENT}\n\
         - annotate: {RULE_ANNOTATE}\n\
         - coach: {RULE_COACH}"
    )
}

fn tool_error(text: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text.into())])
}

/// Readable whichever half the client passes on: content and structured value both carry the line.
fn tool_ok(mut value: Value, line: String) -> CallToolResult {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("message".into(), json!(line));
    }

    let mut result = CallToolResult::structured(value.clone());
    result.content = vec![
        ContentBlock::text(line),
        ContentBlock::text(value.to_string()),
    ];

    result
}

/// Structured content is exactly `{event, board_rev}`.
fn tool_timeout(board_rev: u64, line: String) -> CallToolResult {
    let value = serde_json::to_value(WaitEvent::timeout(board_rev))
        .unwrap_or_else(|_| json!({"event": "timeout", "board_rev": board_rev}));

    let mut result = CallToolResult::structured(value.clone());
    result.content = vec![
        ContentBlock::text(line),
        ContentBlock::text(value.to_string()),
    ];

    result
}

/// The JSON Schema subset some clients need; see docs/program.md.
fn plain_schema(schema: &Value) -> Value {
    fn walk(v: &Value, defs: &Map<String, Value>) -> Value {
        let Some(obj) = v.as_object() else {
            return v.clone();
        };

        // A reference: inline the definition, keeping the field's own description.
        if let Some(target) = obj
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|r| r.strip_prefix("#/$defs/"))
            .and_then(|name| defs.get(name))
        {
            let mut inlined = walk(target, defs);
            if let (Some(out), Some(desc)) = (inlined.as_object_mut(), obj.get("description")) {
                out.insert("description".into(), desc.clone());
            }

            return inlined;
        }

        // `anyOf: [X, {type: null}]` (an optional field): just X.
        if let Some(any) = obj.get("anyOf").and_then(Value::as_array) {
            let rest: Vec<&Value> = any
                .iter()
                .filter(|s| s.get("type").and_then(Value::as_str) != Some("null"))
                .collect();

            if rest.len() == 1 {
                let mut inner = walk(rest[0], defs);
                if let Some(out) = inner.as_object_mut() {
                    for (k, val) in obj {
                        if k != "anyOf" && k != "default" {
                            out.entry(k.clone()).or_insert_with(|| val.clone());
                        }
                    }
                }

                return inner;
            }
        }

        // A string enum written as `oneOf` of constants: a plain `enum`.
        if let Some(one) = obj.get("oneOf").and_then(Value::as_array) {
            let values: Option<Vec<Value>> = one
                .iter()
                .map(|s| s.get("const").or_else(|| s.get("enum")?.get(0)).cloned())
                .collect();

            if let Some(values) = values {
                let mut out = Map::new();
                out.insert("type".into(), json!("string"));
                out.insert("enum".into(), Value::Array(values));
                if let Some(desc) = obj.get("description") {
                    out.insert("description".into(), desc.clone());
                }

                return Value::Object(out);
            }
        }

        let mut out = Map::new();
        for (k, val) in obj {
            match k.as_str() {
                "$schema" | "$defs" | "definitions" => {}
                "format"
                    if val
                        .as_str()
                        .is_some_and(|f| f.starts_with("int") || f.starts_with("uint")) => {}
                "default" if val.is_null() => {}
                "type" => {
                    let t = match val.as_array() {
                        Some(types) => {
                            let kept: Vec<&Value> = types
                                .iter()
                                .filter(|t| t.as_str() != Some("null"))
                                .collect();

                            if kept.len() == 1 {
                                kept[0].clone()
                            } else {
                                Value::Array(kept.into_iter().cloned().collect())
                            }
                        }
                        None => val.clone(),
                    };
                    out.insert(k.clone(), t);
                }
                "properties" => {
                    let props = val
                        .as_object()
                        .map(|p| {
                            p.iter()
                                .map(|(name, s)| (name.clone(), walk(s, defs)))
                                .collect::<Map<String, Value>>()
                        })
                        .unwrap_or_default();
                    out.insert(k.clone(), Value::Object(props));
                }
                "items" => {
                    out.insert(k.clone(), walk(val, defs));
                }
                _ => {
                    out.insert(k.clone(), val.clone());
                }
            }
        }

        // A field that could be null is optional, never required.
        if let (Some(required), Some(props)) = (
            obj.get("required").and_then(Value::as_array),
            obj.get("properties").and_then(Value::as_object),
        ) {
            let nullable = |s: &Value| -> bool {
                let in_type = s
                    .get("type")
                    .and_then(Value::as_array)
                    .is_some_and(|t| t.iter().any(|x| x == "null"));
                let in_any = s
                    .get("anyOf")
                    .and_then(Value::as_array)
                    .is_some_and(|a| a.iter().any(|x| x.get("type") == Some(&json!("null"))));

                in_type || in_any
            };

            let kept: Vec<Value> = required
                .iter()
                .filter(|name| {
                    name.as_str()
                        .and_then(|n| props.get(n))
                        .is_none_or(|s| !nullable(s))
                })
                .cloned()
                .collect();

            out.insert("required".into(), Value::Array(kept));
        }

        Value::Object(out)
    }

    let defs = schema
        .get("$defs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    walk(schema, &defs)
}

/// Built once, with every input schema made plain.
fn plain_tool_router() -> &'static ToolRouter<RukhMcp> {
    static ROUTER: OnceLock<ToolRouter<RukhMcp>> = OnceLock::new();

    ROUTER.get_or_init(|| {
        let mut router = RukhMcp::tool_router();

        for route in router.map.values_mut() {
            let schema = Value::Object((*route.attr.input_schema).clone());
            if let Value::Object(plain) = plain_schema(&schema) {
                route.attr.input_schema = Arc::new(plain);
            }
        }

        router
    })
}

/// The newest change in a `changed` event, as a sentence.
fn change_sentence(change: &Value) -> String {
    let by = change["by"].as_str().unwrap_or("");

    let who = if by.starts_with("view:") {
        "The person".to_string()
    } else if let Some(name) = by.strip_prefix("ai:") {
        let name = name.split('#').next().unwrap_or(name);
        format!("Another AI client ({name})")
    } else {
        "Rukh".to_string()
    };

    let node = &change["node"];
    match change["reason"].as_str() {
        Some("move") => format!(
            "{who} played {} (node {node}).",
            change["san"].as_str().unwrap_or("a move")
        ),
        Some("navigate") => format!("{who} went to node {node}; nothing was played."),
        Some("annotate") => {
            format!("{who} changed the notes or drawings on node {node}; nothing was played.")
        }
        Some("new_game") => format!("{who} started a new game."),
        _ => format!("{who} changed the board."),
    }
}

/// `" 2 items were not applied: <reason>; <reason>."`, or nothing.
fn rejected_note(result: &Value) -> String {
    let Some(rejected) = result.get("rejected").and_then(Value::as_array) else {
        return String::new();
    };

    if rejected.is_empty() {
        return String::new();
    }

    let reasons: Vec<&str> = rejected
        .iter()
        .filter_map(|r| r.get("reason").and_then(Value::as_str))
        .collect();

    let count = if rejected.len() == 1 {
        "1 item was".to_string()
    } else {
        format!("{} items were", rejected.len())
    };

    format!(" {count} not applied: {}.", reasons.join("; "))
}

fn str_at<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    let mut v = value;

    for key in path {
        v = &v[*key];
    }

    v.as_str().unwrap_or("")
}

impl RukhMcp {
    /// Fixed at the first request and listed in presence.
    fn who(&self, client: Option<Implementation>) -> (String, String) {
        self.me
            .get_or_init(|| {
                let name = client
                    .map(|info| clean_name(&info.name))
                    .unwrap_or_else(|| clean_name(""));
                let by = self.hub.presence().identify(&name, self.session);
                (by, name)
            })
            .clone()
    }

    fn views_note(&self, views: u32, tab: TabId) -> String {
        if views > 0 {
            if self.hub.selected() == tab {
                String::new()
            } else {
                " The person is looking at another board.".to_string()
            }
        } else if self.link.is_empty() {
            " No board is open; ask the person to open the Rukh board.".to_string()
        } else {
            format!(
                " No board is open; ask the person to open {} in a browser.",
                self.link
            )
        }
    }

    fn place(&self) -> MutexGuard<'_, Place> {
        // A few ids; after a panic elsewhere they are still usable.
        self.place
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn bound(&self) -> Option<(TabId, Side)> {
        self.place().bound
    }

    fn bind(&self, tab: TabId, seat: Side) {
        let mut place = self.place();
        place.bound = Some((tab, seat));
        place.last_bound = Some(tab);
        place.closed = false;
    }

    fn unbind(&self) {
        self.place().bound = None;
    }

    /// True while `side` is an AI seat of a match in progress on `tab`.
    fn seat_lives(&self, tab: TabId, side: Side) -> bool {
        self.hub
            .read_on(tab, |t| {
                in_progress(t) && t.match_state().seats.get(side) == Seat::Ai
            })
            .unwrap_or(false)
    }

    /// Ends the binding once its seat is no longer an AI seat of a match in progress.
    fn end_dead_binding(&self) {
        let Some((tab, side)) = self.bound() else {
            return;
        };

        if !self.seat_lives(tab, side) {
            self.unbind();
        }
    }

    fn saw(&self, tab: TabId) {
        self.place().seen = Some(tab);
    }

    /// The person closed the bound tab: unbound, and no match starts on the shown board.
    fn mark_closed(&self) {
        {
            let mut place = self.place();
            place.bound = None;
            place.closed = true;
        }
        self.set_turn_seen(None);
    }

    /// The binding ends with `tab_closed`.
    fn tab_closed(&self) -> CallToolResult {
        self.mark_closed();

        let value = json!({"event": "game_over", "stopped": "tab_closed"});
        let line = wait_line(&value, None);
        tool_ok(value, line)
    }

    /// The tab a call acts on: the bound one, else the one last read, else the shown one.
    fn call_tab(&self) -> Result<TabId, CallToolResult> {
        let (bound, seen) = {
            let place = self.place();
            (place.bound, place.seen)
        };

        if let Some((tab, _)) = bound {
            if self.hub.has_tab(tab) {
                return Ok(tab);
            }

            self.mark_closed();
            return Err(tool_error(GAME_CLOSED));
        }

        match seen {
            Some(tab) if self.hub.has_tab(tab) => Ok(tab),
            Some(_) => Err(tool_error(GAME_CLOSED)),
            None => {
                let tab = self.hub.selected();
                self.saw(tab);
                Ok(tab)
            }
        }
    }

    fn set_turn_seen(&self, seen: Option<(u64, u32)>) {
        // The value is a plain pair; after a panic elsewhere it is still usable.
        let mut slot = self
            .turn_seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        *slot = seen;
    }

    fn turn_seen(&self) -> Option<(u64, u32)> {
        *self
            .turn_seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The tip during a match, the shown node otherwise.
    fn position_seen(&self, game_id: u64, body: &Value) {
        let node = body["tip"].as_u64().or_else(|| body["node"].as_u64());
        let seen = node.and_then(|n| u32::try_from(n).ok());
        self.set_turn_seen(seen.map(|n| (game_id, n)));
    }

    fn set_last_side(&self, side: Option<Side>) {
        *self
            .last_side
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = side;
    }

    /// The seat this client waited on before the person moved it to the other colour.
    fn moved_from_seat(&self, tab: TabId) -> Option<Side> {
        let last = *self
            .last_side
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let moved_to = self.hub.read_on(tab, |t| t.seat_moved_to()).flatten();
        last.filter(|side| moved_to == Some(side.other()))
    }

    /// With no seat passed: the one held before, or the only AI seat if nobody else holds it.
    fn implied_seat(&self, by: &str, tab: TabId) -> Option<Side> {
        self.hub.held_seat(tab, by).or_else(|| {
            let only = self.hub.read_on(tab, only_ai_seat).flatten()?;

            let other = self.hub.holder_on(tab, only);
            other.is_none_or(|(holder, _)| holder == by).then_some(only)
        })
    }

    /// Where a `wait` with `seat` plays, by the seat order in docs/program.md.
    fn seat_tab(&self, by: &str, seat: Side) -> Result<Seating, CallToolResult> {
        let (bound, last_bound, closed) = {
            let place = self.place();
            (place.bound, place.last_bound, place.closed)
        };
        let selected = self.hub.selected();

        if let Some((tab, side)) = bound {
            if !self.hub.has_tab(tab) {
                return Err(self.tab_closed());
            }

            if selected == tab {
                return Ok(Seating::play(tab));
            }

            // A hidden tab: its game goes on, and nothing is started there.
            if side == seat {
                return Ok(Seating {
                    tab,
                    claim: false,
                    hold: true,
                });
            }

            if self.seat_lives(tab, side) {
                let name = self.hub.tab_name(tab).unwrap_or_default();
                return Err(tool_error(format!(
                    "You are playing on \u{ab}{name}\u{bb}; finish it or ask the person to stop it."
                )));
            }

            self.unbind();
        }

        if self.hub.seat_open(selected, seat, by) {
            return Ok(Seating::play(selected));
        }

        if let [(tab, _)] = self.hub.open_seats(Some(seat), by)[..] {
            return Ok(Seating::play(tab));
        }

        if closed {
            return Err(self.tab_closed());
        }

        if self.hub.is_free_board(selected) {
            return Ok(Seating::play(selected));
        }

        match last_bound {
            Some(tab) if tab == selected => Ok(Seating::play(tab)),
            Some(tab) if self.hub.has_tab(tab) => Ok(Seating {
                tab,
                claim: false,
                hold: false,
            }),
            Some(_) => Err(tool_error(GAME_CLOSED)),
            None => Ok(Seating::play(selected)),
        }
    }

    /// Where a `wait` with no seat plays: the bound tab, else the one unheld AI seat.
    fn implied_tab(&self, by: &str) -> Result<(TabId, Option<Side>), CallToolResult> {
        if let Some((tab, _)) = self.bound() {
            if !self.hub.has_tab(tab) {
                return Err(self.tab_closed());
            }

            let side = self
                .moved_from_seat(tab)
                .or_else(|| self.implied_seat(by, tab));
            if side.is_some() {
                return Ok((tab, side));
            }

            self.unbind();
        }

        let selected = self.hub.selected();
        let found = match self
            .moved_from_seat(selected)
            .or_else(|| self.implied_seat(by, selected))
        {
            Some(side) => Some((selected, side)),
            None => match self.hub.open_seats(None, by)[..] {
                [(tab, side)] => Some((tab, side)),
                _ => None,
            },
        };

        let Some((tab, side)) = found else {
            return Ok((selected, None));
        };

        if let Some(name) = self.hub.ai_playing_elsewhere(tab) {
            return Err(tool_error(already_playing(&name)));
        }

        self.bind(tab, side);
        Ok((tab, Some(side)))
    }

    /// Where a `wait for=any_change` watches, and whether it follows the selection.
    fn watch_tab(
        &self,
        by: &str,
        since: Option<u64>,
    ) -> Result<(TabId, WaitFor, bool), CallToolResult> {
        let (bound, seen) = {
            let place = self.place();
            (place.bound, place.seen)
        };
        let selected = self.hub.selected();

        let (tab, follow) = match bound {
            Some((tab, _)) if self.hub.has_tab(tab) => (tab, false),
            Some(_) => return Err(self.tab_closed()),
            None => match seen {
                Some(tab) if tab != selected => return Err(self.switched(by, "")),
                _ => (selected, true),
            },
        };

        Ok((tab, WaitFor::AnyChange { since }, follow))
    }

    /// A changed event with the newly selected tab's position.
    fn switched(&self, by: &str, prefix: &str) -> CallToolResult {
        let views = self.hub.presence().views();

        let (tab, value, game_id) = self.hub.read_desk(|desk| {
            let tab = desk.selected();
            let seat = self.hub.held_seat_in(desk, tab, by);

            let event = WaitEvent {
                event: "changed",
                position: Some(desk.shown().position(seat, views)),
                since_last: Some(Vec::new()),
                since_last_truncated: None,
                result: None,
                stopped: None,
                seat: None,
                board_rev: None,
            };
            (tab, serde_json::to_value(event), desk.shown().game_id())
        });

        let mut value = match value {
            Ok(value) => value,
            Err(e) => return tool_error(format!("The game could not be encoded: {e}")),
        };

        self.position_seen(game_id, &value);
        self.saw(tab);
        value["tab"] = json!(tab);

        let line = format!(
            "{prefix}The person switched to another board. Node {}, board_rev {}. Style: {}.{}",
            value["node"],
            value["board_rev"],
            str_at(&value, &["style", "name"]),
            self.views_note(views, tab)
        );

        tool_ok(value, line)
    }

    fn wait_result(&self, event: &WaitEvent, end: WaitEnd, prefix: &str) -> CallToolResult {
        let mut value = match serde_json::to_value(event) {
            Ok(value) => value,
            Err(e) => return tool_error(format!("The game could not be encoded: {e}")),
        };

        self.saw(end.tab);
        if event.position.is_some() {
            self.position_seen(end.game_id, &value);
            value["tab"] = json!(end.tab);
        }

        if let (Some(seat), Some((by, name))) = (event.seat, self.me.get()) {
            let held = self.hub.hold_seat(end.tab, by, name, seat).is_ok();
            self.set_last_side(Some(seat));

            if held && end.seated {
                self.bind(end.tab, seat);
            }
        }

        // The wait that reports the end of a game is the last one that uses the binding.
        if end.seated && event.event == "game_over" {
            self.unbind();
        }

        let line = format!(
            "{prefix}{}{}",
            wait_line(&value, end.side),
            self.views_note(end.views, end.tab)
        );

        tool_ok(value, line)
    }

    fn apply(&self, by: &str, tab: TabId, intent: Value) -> Result<Value, rukh_core::Error> {
        self.hub
            .apply_on(tab, by, &intent.to_string(), None)
            .map(|applied| applied.result)
    }

    /// Returns the prose to put before the wait result, or the answer when nothing was claimed.
    fn claim(
        &self,
        by: &str,
        name: &str,
        seat: Side,
        tab: TabId,
    ) -> Result<String, CallToolResult> {
        let intent = json!({"op": "claim_seat", "seat": seat.name()}).to_string();

        let result = match self.hub.apply_seated(tab, by, name, seat, &intent) {
            Ok(applied) => applied.result,
            Err(Refused::Elsewhere(other)) => return Err(tool_error(already_playing(&other))),
            Err(Refused::Core(rukh_core::Error::UnknownTab(_)))
                if self.bound().is_some_and(|(bound, _)| bound == tab) =>
            {
                return Err(self.tab_closed());
            }
            Err(Refused::Core(e)) => {
                self.end_dead_binding();
                return Err(tool_error(core_refusal(&e)));
            }
        };

        let started = result["started"].as_bool().unwrap_or(false);
        let claimed = result["claimed"].as_bool().unwrap_or(false);

        Ok(if started {
            format!(
                "You play {}; a match has started from the current position, and the person plays {}. ",
                seat.title(),
                seat.other().title()
            )
        } else if claimed {
            format!("You now play {} in this match. ", seat.title())
        } else {
            String::new()
        })
    }
}

/// Where a seated `wait` goes, and what it does there.
struct Seating {
    tab: TabId,
    /// Send `claim_seat`, which may start a match.
    claim: bool,
    /// Count the seat as held while waiting on it.
    hold: bool,
}

impl Seating {
    fn play(tab: TabId) -> Seating {
        Seating {
            tab,
            claim: true,
            hold: true,
        }
    }
}

/// What a finished `wait` needs to word its result.
#[derive(Clone, Copy)]
struct WaitEnd {
    tab: TabId,
    side: Option<Side>,
    game_id: u64,
    views: u32,
    /// A `my_turn` wait, which can end or move the binding.
    seated: bool,
}

/// What one look at the desk found.
enum Look {
    Seen {
        event: Option<Box<WaitEvent>>,
        board_rev: u64,
        game_id: u64,
    },
    Switched,
    Gone,
}

fn already_playing(name: &str) -> String {
    format!("An AI is already playing on \u{ab}{name}\u{bb}.")
}

/// A refusal from the core in words; a tab that went away reads as a closed game.
pub(crate) fn core_refusal(e: &rukh_core::Error) -> String {
    match e {
        rukh_core::Error::UnknownTab(_) => GAME_CLOSED.to_string(),
        e => e.to_string(),
    }
}

fn wait_line(event: &Value, side: Option<Side>) -> String {
    let style = str_at(event, &["style", "name"]);
    let wait_again = match side {
        Some(side) => format!("call wait with seat=\"{}\" again", side.name()),
        None => "call wait again".to_string(),
    };

    match event["event"].as_str() {
        Some("your_turn") => {
            let seat = side.map(Side::title).unwrap_or("your side");
            let last = match event["last_move"]["san"].as_str() {
                Some(san) => format!(" The last move was {san}."),
                None => String::new(),
            };

            format!(
                "Your turn: you play {seat}.{last} Choose from legal_moves, call play with \
                 from_node={}, and follow style.rule ({style}).",
                event["node"]
            )
        }
        Some("seat_changed") => {
            let seat = event["seat"].as_str().unwrap_or("");
            let title = if seat == "white" { "White" } else { "Black" };

            format!(
                "Your seat changed: the person moved you to {title} in this match. Keep playing: \
                 call wait with seat=\"{seat}\"."
            )
        }
        Some("game_over") => {
            let wait_for_start =
                "Stop and tell them; nothing more happens until they press Start on the board.";
            let again =
                format!("If the person starts a new game or asks for another, {wait_again}.");

            match event["stopped"].as_str() {
                Some("tab_closed") => TAB_CLOSED.to_string(),
                Some("match_stop") => format!("The person stopped the match. {wait_for_start}"),
                Some("new_game") => format!(
                    "The person started a new game during the match, which ended it. \
                     {wait_for_start}"
                ),
                Some(_) => format!(
                    "The person took your seat away, so you no longer play in this match. \
                     {wait_for_start}"
                ),
                None => {
                    let (outcome, reason) = if event["result"].is_object() {
                        (
                            str_at(event, &["result", "outcome"]),
                            str_at(event, &["result", "reason"]),
                        )
                    } else {
                        (
                            str_at(event, &["status", "outcome"]),
                            str_at(event, &["status", "reason"]),
                        )
                    };

                    if outcome.is_empty() {
                        format!("The match has ended. {again}")
                    } else {
                        format!(
                            "The game is over: {outcome}, {reason}. Tell the person the result. \
                             {again}"
                        )
                    }
                }
            }
        }
        Some("changed") => {
            let listed = event["since_last"].as_array();
            let n = listed.map_or(0, Vec::len);

            let newest = match listed.and_then(|l| l.last()) {
                Some(change) => format!("{} ", change_sentence(change)),
                None => "The board changed, but the changes are no longer listed. ".to_string(),
            };
            let changes = if n == 1 {
                "1 change".to_string()
            } else {
                format!("{n} changes")
            };
            let older = if event["since_last_truncated"] == true {
                " Older changes are not listed; call get_game with detail=\"tree\" to see the \
                 whole game."
            } else {
                ""
            };

            format!(
                "{newest}{changes} in since_last; the board is now at board_rev {}. Style: \
                 {style}.{older}",
                event["board_rev"]
            )
        }
        _ => "Nobody has moved yet; call wait again.".to_string(),
    }
}

#[tool_router]
impl RukhMcp {
    pub fn new(hub: Arc<Hub>, link: &str) -> RukhMcp {
        let session = hub.next_session();

        RukhMcp {
            hub,
            link: Arc::from(link),
            session,
            me: Arc::new(OnceLock::new()),
            turn_seen: Arc::new(Mutex::new(None)),
            last_side: Arc::new(Mutex::new(None)),
            place: Arc::new(Mutex::new(Place::default())),
        }
    }

    #[tool(
        name = "get_game",
        description = "Read the game on the Rukh board: position, legal moves, seats, the style rule you must follow, and the notes and arrows on the current move. detail=tree returns every move with its variations."
    )]
    async fn get_game(
        &self,
        Parameters(args): Parameters<GetGameArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let (by, name) = self.who(context.client_info());
        self.hub.presence().seen(&by, &name);

        let tab = if self.bound().is_some() {
            match self.call_tab() {
                Ok(tab) => tab,
                Err(refused) => return Ok(refused),
            }
        } else {
            self.hub.selected()
        };

        let seat = self.hub.held_seat(tab, &by);
        let views = self.hub.presence().views();
        let tree = args.detail == Some(DetailArg::Tree);

        let read = self.hub.read_on(tab, |t| {
            let value = if tree {
                serde_json::to_value(t.tree(seat, views))
            } else {
                serde_json::to_value(t.position(seat, views))
            };
            (value, t.game_id())
        });

        let Some((value, game_id)) = read else {
            return Ok(tool_error(GAME_CLOSED));
        };

        let mut value = match value {
            Ok(value) => value,
            Err(e) => return Ok(tool_error(format!("The game could not be encoded: {e}"))),
        };

        self.saw(tab);
        self.position_seen(game_id, &value);
        value["tab"] = json!(tab);

        let browsing = if value["tip"].is_u64() && value["live"] == false {
            format!(
                " The person is browsing node {}; the match continues from node {}, where a move \
                 in it is played.",
                value["node"], value["tip"]
            )
        } else {
            String::new()
        };

        let line = format!(
            "{} Node {}, board_rev {}. Style: {}.{browsing}{}",
            str_at(&value, &["status", "text"]),
            value["node"],
            value["board_rev"],
            str_at(&value, &["style", "name"]),
            self.views_note(views, tab)
        );

        Ok(tool_ok(value, line))
    }

    #[tool(
        name = "wait",
        description = "Block until it is your turn. To play a game, loop: call wait(seat), then call play, then call wait again. event=timeout is normal and means nobody has moved yet: call wait again. event=game_over or flag means stop and tell the person the result. The result contains the position and style.rule, which you must follow. Use for=any_change with since=<board_rev> to be told about anything the person does (coaching)."
    )]
    async fn wait(
        &self,
        Parameters(args): Parameters<WaitArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let (by, name) = self.who(context.client_info());
        let presence = self.hub.presence().clone();
        presence.seen(&by, &name);

        let timeout_s = args
            .timeout_s
            .unwrap_or(WAIT_DEFAULT_S)
            .clamp(WAIT_MIN_S, WAIT_MAX_S);

        let mut prefix = String::new();
        let (tab, what, follow) = match args.what.unwrap_or(WaitForArg::MyTurn) {
            // Never takes a seat: a coach must not become the person's opponent.
            WaitForArg::AnyChange => match self.watch_tab(&by, args.since) {
                Ok(watch) => watch,
                Err(answer) => return Ok(answer),
            },
            WaitForArg::MyTurn => {
                let (tab, side, hold) = match args.seat.map(Side::from) {
                    Some(seat) => {
                        let seating = match self.seat_tab(&by, seat) {
                            Ok(seating) => seating,
                            Err(answer) => return Ok(answer),
                        };

                        if seating.claim {
                            match self.claim(&by, &name, seat, seating.tab) {
                                Ok(text) => prefix = text,
                                Err(answer) => return Ok(answer),
                            }

                            self.bind(seating.tab, seat);
                        }

                        // A claim holds its seat itself.
                        (seating.tab, seat, seating.hold && !seating.claim)
                    }
                    None => match self.implied_tab(&by) {
                        Ok((tab, Some(side))) => (tab, side, true),
                        Ok((tab, None)) => {
                            let running = self
                                .hub
                                .read_on(tab, |t| t.match_state().active)
                                .unwrap_or(false);
                            return Ok(tool_error(if running {
                                "A match is running but you hold no seat in it, so there is no \
                                 turn to wait for. To play, call wait with seat=\"white\" or \
                                 seat=\"black\" for a seat the person gave to an AI; to follow \
                                 the game without playing, call wait with for=\"any_change\"."
                            } else {
                                "No match is running and you hold no seat, so there is no turn \
                                 to wait for. Call wait with seat=\"white\" or seat=\"black\" to \
                                 take a side and start a match, or with for=\"any_change\" to \
                                 follow the board."
                            }));
                        }
                        Err(answer) => return Ok(answer),
                    },
                };

                let seated = self
                    .hub
                    .read_on(tab, |t| {
                        let m = t.match_state();
                        m.active && m.seats.get(side) == Seat::Ai
                    })
                    .unwrap_or(false);

                // Waiting on a seat is holding it.
                if seated && hold {
                    if let Err(other) = self.hub.hold_seat(tab, &by, &name, side) {
                        self.unbind();
                        return Ok(tool_error(already_playing(&other)));
                    }
                }

                self.set_last_side(Some(side));
                (tab, WaitFor::MyTurn(side), false)
            }
        };

        let side = match what {
            WaitFor::MyTurn(side) => Some(side),
            WaitFor::AnyChange { .. } => self.hub.held_seat(tab, &by),
        };
        let seated = matches!(what, WaitFor::MyTurn(_));
        self.saw(tab);

        // Subscribed before the first look, so a change in between still wakes this call.
        let mut frames = self.hub.subscribe();
        let start_rev = self.hub.read_desk(|d| d.rev());
        let _waiting = presence.wait_started(&by, &name);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_s);
        let progress_token = context.meta.get_progress_token();
        let mut progress =
            tokio::time::interval_at(tokio::time::Instant::now() + PROGRESS_EVERY, PROGRESS_EVERY);
        let mut reported = 0u32;

        // The event if the wait should end, and the counters from the same lock.
        let look = || {
            let views = presence.views();
            let seen = self.hub.read_desk(|desk| {
                let Some(t) = desk.table(tab) else {
                    return Look::Gone;
                };

                if follow && desk.selected() != tab {
                    return Look::Switched;
                }

                Look::Seen {
                    event: t
                        .wait_event_seated(&by, what, start_rev, views, side)
                        .map(Box::new),
                    board_rev: t.board_rev(),
                    game_id: t.game_id(),
                }
            });
            (seen, views)
        };

        // Ends the wait when the look says so; the timeout's board_rev comes with it.
        let answer = |seen: Look, views: u32| -> Result<CallToolResult, u64> {
            match seen {
                Look::Gone if follow => Ok(self.switched(&by, &prefix)),
                Look::Gone => Ok(self.tab_closed()),
                Look::Switched => Ok(self.switched(&by, &prefix)),
                Look::Seen {
                    event: Some(event),
                    game_id,
                    ..
                } => {
                    let end = WaitEnd {
                        tab,
                        side,
                        game_id,
                        views,
                        seated,
                    };
                    Ok(self.wait_result(&event, end, &prefix))
                }
                Look::Seen {
                    event: None,
                    board_rev,
                    ..
                } => Err(board_rev),
            }
        };

        loop {
            let (seen, views) = look();
            if let Ok(result) = answer(seen, views) {
                return Ok(result);
            }

            tokio::select! {
                // Frames before the deadline, so a change landing as the wait runs out is reported.
                biased;
                changed = frames.changed() => {
                    if changed.is_err() {
                        return Ok(tool_error("Rukh is shutting down; nothing more will change."));
                    }
                    frames.borrow_and_update();
                }
                _ = context.ct.cancelled() => {
                    return Ok(tool_error("The wait was cancelled."));
                }
                _ = tokio::time::sleep_until(deadline) => {
                    let (seen, views) = look();
                    let board_rev = match answer(seen, views) {
                        Ok(result) => return Ok(result),
                        Err(board_rev) => board_rev,
                    };

                    let line = format!(
                        "{prefix}{}{}",
                        wait_line(&json!({}), side),
                        self.views_note(views, tab)
                    );

                    return Ok(tool_timeout(board_rev, line));
                }
                _ = progress.tick(), if progress_token.is_some() => {
                    if let Some(token) = &progress_token {
                        reported += 1;
                        let param = rmcp::model::ProgressNotificationParam::new(
                            token.clone(),
                            f64::from(reported),
                        )
                        .with_message("Still waiting; nobody has moved yet.");

                        // A client that stopped reading cannot hold the wait here.
                        let _ = tokio::time::timeout(
                            PROGRESS_SEND_LIMIT,
                            context.peer.notify_progress(param),
                        )
                        .await;
                    }
                }
            }
        }
    }

    #[tool(
        name = "play",
        description = "Play a move for the side you hold, in SAN (Nf3) or UCI (g1f3). Optionally attach a note, a glyph and arrows to the move in the same call; follow style.rule for whether to do so. Choose the move by your own judgement."
    )]
    async fn play(
        &self,
        Parameters(args): Parameters<PlayArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let (by, name) = self.who(context.client_info());
        let presence = self.hub.presence();
        presence.seen(&by, &name);

        let tab = match self.call_tab() {
            Ok(tab) => tab,
            Err(refused) => return Ok(refused),
        };

        // In a match, an AI seat held by another connected client is not this client's to move.
        let read = self.hub.read_on(tab, |t| {
            let m = t.match_state();
            let side = t.session().turn_at_tip();
            let owed = (m.active && m.seats.get(side) == Seat::Ai).then_some(side);
            (owed, t.game_id())
        });

        let Some((owed, game_id)) = read else {
            return Ok(tool_error(GAME_CLOSED));
        };

        if let Some(side) = owed {
            if let Some((holder, shown)) = self.hub.holder_on(tab, side) {
                if holder != by {
                    self.set_turn_seen(None);
                    return Ok(tool_error(format!(
                        "{} is played by {shown} in this match, and you hold no seat in it, so do \
                         not move for it. If the person asked you to play {}, call wait with \
                         seat=\"{}\" first.",
                        side.title(),
                        side.title(),
                        side.name()
                    )));
                }
            }
        }

        let mut intent = Map::new();
        intent.insert("op".into(), json!("play"));
        intent.insert("move".into(), json!(args.mv));

        // Stale rather than played in a position this client never saw.
        let from_node = args.from_node.or_else(|| {
            self.turn_seen()
                .filter(|(game, _)| *game == game_id)
                .map(|(_, node)| node)
        });

        if let Some(node) = from_node {
            intent.insert("from_node".into(), json!(node));
        }
        if let Some(note) = args.note {
            intent.insert("note".into(), json!(note));
        }
        if let Some(nag) = args.nag {
            intent.insert("nag".into(), json!(nag));
        }
        if let Some(arrows) = args.arrows {
            intent.insert("arrows".into(), Value::Array(arrows));
        }
        if let Some(highlights) = args.highlights {
            intent.insert("highlights".into(), Value::Array(highlights));
        }

        // Moving for an AI seat of the match takes that seat.
        let intent = Value::Object(intent).to_string();
        let applied = match owed {
            Some(side) => self.hub.apply_seated(tab, &by, &name, side, &intent),
            None => self
                .hub
                .apply_on(tab, &by, &intent, None)
                .map_err(Refused::Core),
        };
        self.set_turn_seen(None);

        let mut result = match applied {
            Ok(applied) => applied.result,
            Err(Refused::Elsewhere(other)) => return Ok(tool_error(already_playing(&other))),
            Err(Refused::Core(e)) => return Ok(tool_error(core_refusal(&e))),
        };

        let views = presence.views();
        result["views"] = json!(views);

        let turn = str_at(&result, &["turn"]);

        let mut line = format!(
            "Played {} ({}).",
            str_at(&result, &["san"]),
            str_at(&result, &["uci"])
        );

        match result["status"]["outcome"].as_str() {
            Some(outcome) => line.push_str(&format!(
                " Game over: {outcome}, {}.",
                str_at(&result, &["status", "reason"])
            )),
            None => line.push_str(&format!(
                " {} to move.",
                if turn == "white" { "White" } else { "Black" }
            )),
        }

        line.push_str(&rejected_note(&result));
        line.push_str(&self.views_note(views, tab));

        Ok(tool_ok(result, line))
    }

    #[tool(
        name = "annotate",
        description = "Add a note, glyph, arrows or highlights to a move without moving the board. Defaults to the current move. Everyone looking at the board sees it."
    )]
    async fn annotate(
        &self,
        Parameters(args): Parameters<AnnotateArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let (by, name) = self.who(context.client_info());
        let presence = self.hub.presence();
        presence.seen(&by, &name);

        let tab = match self.call_tab() {
            Ok(tab) => tab,
            Err(refused) => return Ok(refused),
        };

        let mut intent = Map::new();
        intent.insert("op".into(), json!("annotate"));
        if let Some(node) = args.node {
            intent.insert("node".into(), json!(node));
        }
        if let Some(note) = args.note {
            intent.insert("note".into(), json!(note));
        }
        if let Some(nag) = args.nag {
            intent.insert("nag".into(), json!(nag));
        }
        if let Some(arrows) = args.arrows {
            intent.insert("arrows".into(), Value::Array(arrows));
        }
        if let Some(highlights) = args.highlights {
            intent.insert("highlights".into(), Value::Array(highlights));
        }

        let mode = match args.mode.unwrap_or(ModeArg::Add) {
            ModeArg::Add => "add",
            ModeArg::Replace => "replace",
            ModeArg::Clear => "clear",
        };
        intent.insert("mode".into(), json!(mode));

        let mut result = match self.apply(&by, tab, Value::Object(intent)) {
            Ok(result) => result,
            Err(e) => return Ok(tool_error(core_refusal(&e))),
        };

        let views = presence.views();
        result["views"] = json!(views);

        let applied = &result["applied"];
        let mut parts = Vec::new();
        if applied["note"].as_bool() == Some(true) {
            parts.push("note".to_string());
        }
        if applied["nag"].as_bool() == Some(true) {
            parts.push("glyph".to_string());
        }
        for (key, one, many) in [
            ("arrows", "arrow", "arrows"),
            ("highlights", "highlight", "highlights"),
        ] {
            match applied[key].as_u64() {
                Some(0) | None => {}
                Some(1) => parts.push(format!("1 {one}")),
                Some(n) => parts.push(format!("{n} {many}")),
            }
        }

        let what = if parts.is_empty() {
            "nothing changed".to_string()
        } else {
            parts.join(", ")
        };

        let mut line = format!("Annotated node {} ({mode}): {what}.", result["node"]);
        line.push_str(&rejected_note(&result));
        line.push_str(&self.views_note(views, tab));

        Ok(tool_ok(result, line))
    }
}

#[prompt_router]
impl RukhMcp {
    #[prompt(
        name = "play",
        description = "Play a game of chess against the person on the Rukh board."
    )]
    async fn play_prompt(
        &self,
        Parameters(args): Parameters<PlayPromptArgs>,
    ) -> Vec<PromptMessage> {
        let side = match args.side.as_deref().map(|s| s.trim().to_ascii_lowercase()) {
            Some(s) if s == "white" => "white",
            _ => "black",
        };

        vec![PromptMessage::new_text(
            Role::User,
            format!(
                "Play a game of chess against me on the Rukh board; you play {side}. Call wait \
                 with seat=\"{side}\", and when it returns event=your_turn call play with your \
                 move, following the style.rule in the result; then call wait again \
                 (event=timeout only means I have not moved yet). When wait returns \
                 event=game_over, stop and tell me the result."
            ),
        )]
    }

    #[prompt(
        name = "review",
        description = "Follow the game on the Rukh board and comment on the person's moves."
    )]
    async fn review_prompt(
        &self,
        Parameters(args): Parameters<ReviewPromptArgs>,
    ) -> Vec<PromptMessage> {
        let level = match args.level.as_deref().map(str::trim) {
            Some(level) if !level.is_empty() => {
                format!(" Pitch your comments for a {level} player.")
            }
            _ => String::new(),
        };

        vec![PromptMessage::new_text(
            Role::User,
            format!(
                "Watch the game on the Rukh board and comment on what I do. Call get_game to read \
                 the position and its board_rev. Then loop: call wait with for=\"any_change\" and \
                 since=<the last board_rev you saw>; when it returns event=changed, read \
                 since_last and the position, and use annotate to put a short note, a glyph, or \
                 arrows and highlights on the move I played, following style.rule (stay quiet \
                 when the move was fine). event=timeout means nothing changed: wait again. When \
                 wait returns event=game_over, stop and sum up the game.{level}"
            ),
        )]
    }
}

#[tool_handler(router = plain_tool_router())]
#[prompt_handler]
impl ServerHandler for RukhMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_prompts()
                .build(),
        )
        .with_server_info(Implementation::new("rukh", env!("CARGO_PKG_VERSION")))
        .with_instructions(instructions())
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(ProtocolVersion::known_up_to(&MAX_PROTOCOL))
    }

    /// Lists the client as soon as it has connected, before its first tool call.
    fn on_initialized(
        &self,
        context: NotificationContext<RoleServer>,
    ) -> impl std::future::Future<Output = ()> + MaybeSendFuture + '_ {
        let client = context
            .peer
            .peer_info()
            .map(|info| info.client_info.clone());

        let (by, name) = self.who(client);
        self.hub.presence().seen(&by, &name);

        std::future::ready(())
    }
}

/// The service, and a function that ends its open sessions at shutdown.
pub fn service(hub: Arc<Hub>, port: u16) -> (Service, impl Fn() + Send + Sync + 'static) {
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts([format!("127.0.0.1:{port}"), format!("localhost:{port}")])
        .with_allowed_origins([
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
        ]);

    let token = config.cancellation_token.clone();
    let link = format!("http://127.0.0.1:{port}/");
    let service = StreamableHttpService::new(
        move || Ok(RukhMcp::new(hub.clone(), &link)),
        Arc::new(LocalSessionManager::default()),
        config,
    );

    (service, move || token.cancel())
}
