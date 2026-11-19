//! The game file `games/g0007.json` for a game imported from text.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::batch::RAW_PART;
use crate::ending::{ending, Reason};
use crate::keys::{move_key, site_key};
use crate::names::{clean_name, same_name};
use crate::skip::{skip_of, Skip};
use crate::text::{TextGame, TextTags, Variant};

pub const GAME_VERSION: u32 = 1;

pub const KIND_IMPORTED: &str = "imported";

const MAX_RATING_DIGITS: usize = 5;

const MAX_SECONDS_DIGITS: usize = 7;

/// The order of a game file's fields; others follow in name order.
const FIELD_ORDER: [&str; 21] = [
    "v",
    "id",
    "kind",
    "started",
    "date",
    "variant",
    "start_fen",
    "from_position",
    "chess960_castling",
    "you",
    "you_rating",
    "white",
    "black",
    "opponent",
    "tc",
    "result",
    "reason",
    "plies",
    "source",
    "move_key",
    "moves",
];

const MOVE_FIELD_ORDER: [&str; 4] = ["uci", "san", "clk", "ms"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    White,
    Black,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Player {
    pub name: Option<String>,
    pub rating: Option<u32>,
    pub bot: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpponentKind {
    Person,
    Bot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Opponent {
    #[serde(rename = "type")]
    pub kind: OpponentKind,
    pub name: Option<String>,
    pub rating: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeControl {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_s: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inc_s: Option<u32>,
    /// Days-per-move games: seconds a move may take.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily_s: Option<u32>,
}

/// Where the game sits in the raw text kept for its batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawPlace {
    pub part: String,
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub site: Option<String>,
    pub site_key: Option<String>,
    /// Always false for text: nothing in it proves where it came from.
    pub verified: bool,
    pub batch: String,
    pub raw: RawPlace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveRecord {
    pub uci: String,
    pub san: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clk: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GameRecord {
    pub v: u32,
    pub id: String,
    pub kind: String,
    pub started: Option<String>,
    /// Only when there is no UTC start: the `Date` tag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub variant: Variant,
    pub start_fen: String,
    pub from_position: bool,
    /// Only on a standard game whose castling moves are written king-to-rook.
    #[serde(default, skip_serializing_if = "is_false")]
    pub chess960_castling: bool,
    pub you: Option<Side>,
    pub you_rating: Option<u32>,
    pub white: Player,
    pub black: Player,
    pub opponent: Option<Opponent>,
    pub tc: Option<TimeControl>,
    pub result: String,
    pub reason: Option<Reason>,
    pub plies: u32,
    pub source: Source,
    pub move_key: String,
    pub moves: Vec<MoveRecord>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl GameRecord {
    pub fn to_text(&self) -> String {
        game_text(&serde_json::to_value(self).unwrap_or(Value::Null))
    }
}

fn all_digits(text: &str, most: usize) -> bool {
    !text.is_empty() && text.len() <= most && text.bytes().all(|b| b.is_ascii_digit())
}

/// A rating only when it is a plain number.
pub fn parse_rating(text: &str) -> Option<u32> {
    let text = text.trim();
    all_digits(text, MAX_RATING_DIGITS)
        .then(|| text.parse().ok())
        .flatten()
}

fn seconds(text: &str) -> Option<u32> {
    all_digits(text, MAX_SECONDS_DIGITS)
        .then(|| text.parse().ok())
        .flatten()
}

/// `900+10`, `180`, or `1/86400` for a days-per-move game.
pub fn parse_time_control(text: &str) -> Option<TimeControl> {
    let text = text.trim();

    if let Some(daily) = text.strip_prefix("1/") {
        return Some(TimeControl {
            base_s: None,
            inc_s: None,
            daily_s: Some(seconds(daily)?),
        });
    }

    let (base, inc) = text.split_once('+').unwrap_or((text, "0"));
    Some(TimeControl {
        base_s: Some(seconds(base)?),
        inc_s: Some(seconds(inc)?),
        daily_s: None,
    })
}

fn numbers<const N: usize>(text: &str, separator: char, widths: [usize; N]) -> Option<[u32; N]> {
    let parts: Vec<&str> = text.trim().split(separator).collect();
    if parts.len() != N {
        return None;
    }

    let mut out = [0u32; N];
    for (i, (part, width)) in parts.iter().zip(widths).enumerate() {
        if part.len() != width || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        out[i] = part.parse().ok()?;
    }

    Some(out)
}

/// `2026-10-12` from `2026.10.12`.
pub fn parse_date(text: &str) -> Option<String> {
    let [year, month, day] = numbers(text, '.', [4, 2, 2])?;
    let ok = (1..=12).contains(&month) && (1..=31).contains(&day);

    ok.then(|| format!("{year:04}-{month:02}-{day:02}"))
}

/// `2026-10-12T19:02:11Z` from the `UTCDate` and `UTCTime` tags.
pub fn utc_start(date: &str, time: &str) -> Option<String> {
    let date = parse_date(date)?;
    let [hour, minute, second] = numbers(time, ':', [2, 2, 2])?;
    let ok = hour < 24 && minute < 60 && second < 61;

    ok.then(|| format!("{date}T{hour:02}:{minute:02}:{second:02}Z"))
}

fn is_bot(title: Option<&str>) -> bool {
    title.is_some_and(|t| t.trim().eq_ignore_ascii_case("BOT"))
}

fn player(name: Option<&str>, rating: Option<&str>, title: Option<&str>) -> Player {
    Player {
        name: name.and_then(clean_name),
        rating: rating.and_then(parse_rating),
        bot: is_bot(title),
    }
}

/// The side whose name is one of `names`; none when neither or both are.
pub fn side_of(white: Option<&str>, black: Option<&str>, names: &[String]) -> Option<Side> {
    let mine = |name: Option<&str>| name.is_some_and(|n| names.iter().any(|m| same_name(m, n)));

    match (mine(white), mine(black)) {
        (true, false) => Some(Side::White),
        (false, true) => Some(Side::Black),
        _ => None,
    }
}

fn opponent_of(player: &Player) -> Opponent {
    Opponent {
        kind: if player.bot {
            OpponentKind::Bot
        } else {
            OpponentKind::Person
        },
        name: player.name.clone(),
        rating: player.rating,
    }
}

/// The thinking time of each move from two clocks and the increment, never below 0.
fn with_times(game: &TextGame, tc: Option<TimeControl>) -> Vec<MoveRecord> {
    let timing =
        tc.and_then(|tc| Some((u64::from(tc.base_s?) * 1000, u64::from(tc.inc_s?) * 1000)));

    game.moves
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let before = match (i, timing) {
                (_, None) => None,
                (0 | 1, Some((base, _))) => Some(base),
                (_, Some(_)) => game.moves[i - 2].clock_ms,
            };

            let ms = match (before, m.clock_ms, timing) {
                (Some(before), Some(after), Some((_, inc))) => {
                    Some(before.saturating_add(inc).saturating_sub(after))
                }
                _ => None,
            };

            MoveRecord {
                uci: m.uci.clone(),
                san: m.san.clone(),
                clk: m.clock_ms,
                ms,
            }
        })
        .collect()
}

fn names_in(tags: &TextTags) -> Vec<&str> {
    [tags.white.as_deref(), tags.black.as_deref()]
        .into_iter()
        .flatten()
        .collect()
}

/// The game file for a game read from text; its `id` and `source.batch` are left empty.
pub fn build(game: &TextGame, names: &[String]) -> Result<GameRecord, Skip> {
    if let Some(skip) = skip_of(game) {
        return Err(skip);
    }

    let tags = &game.tags;
    let result = game.result.clone().unwrap_or_default();

    let white = player(
        tags.white.as_deref(),
        tags.white_elo.as_deref(),
        tags.white_title.as_deref(),
    );
    let black = player(
        tags.black.as_deref(),
        tags.black_elo.as_deref(),
        tags.black_title.as_deref(),
    );

    let you = side_of(white.name.as_deref(), black.name.as_deref(), names);
    let (you_rating, opponent) = match you {
        Some(Side::White) => (white.rating, Some(opponent_of(&black))),
        Some(Side::Black) => (black.rating, Some(opponent_of(&white))),
        None => (None, None),
    };

    let started = match (tags.utc_date.as_deref(), tags.utc_time.as_deref()) {
        (Some(date), Some(time)) => utc_start(date, time),
        _ => None,
    };
    let date = match started {
        Some(_) => None,
        None => tags.date.as_deref().and_then(parse_date),
    };

    let tc = tags.time_control.as_deref().and_then(parse_time_control);
    let reason = ending(
        tags.termination.as_deref(),
        &names_in(tags),
        &result,
        &game.last,
    );

    let site = site_key(tags);
    let key = move_key(
        &game.start_fen,
        game.moves.iter().map(|m| m.uci.as_str()),
        started.as_deref().or(date.as_deref()).unwrap_or(""),
        white.name.as_deref().unwrap_or(""),
        black.name.as_deref().unwrap_or(""),
    );

    Ok(GameRecord {
        v: GAME_VERSION,
        id: String::new(),
        kind: KIND_IMPORTED.to_string(),
        started,
        date,
        variant: game.variant,
        start_fen: game.start_fen.clone(),
        from_position: game.from_position,
        chess960_castling: game.variant == Variant::Standard && game.chess960_castling,
        you,
        you_rating,
        white,
        black,
        opponent,
        tc,
        result,
        reason,
        plies: u32::try_from(game.moves.len()).unwrap_or(u32::MAX),
        source: Source {
            site: site.as_ref().map(|s| s.site.to_string()),
            site_key: site.map(|s| s.key),
            verified: false,
            batch: String::new(),
            raw: RawPlace {
                part: RAW_PART.to_string(),
                start: game.start as u64,
                end: game.end as u64,
            },
        },
        move_key: key,
        moves: with_times(game, tc),
        extra: BTreeMap::new(),
    })
}

fn this_version(file: &Value) -> bool {
    file.get("v").and_then(Value::as_u64) == Some(u64::from(GAME_VERSION))
}

/// Fills `you`, `you_rating` and `opponent` in a stored game whose side was not known.
pub fn give_side(file: &mut Value, names: &[String]) -> bool {
    if !this_version(file) || !file.get("you").is_some_and(Value::is_null) {
        return false;
    }

    let name = |side: &str| file.get(side)?.get("name")?.as_str().map(str::to_string);
    let Some(you) = side_of(name("white").as_deref(), name("black").as_deref(), names) else {
        return false;
    };

    let (mine, theirs) = match you {
        Side::White => ("white", "black"),
        Side::Black => ("black", "white"),
    };

    let rating = file.get(mine).and_then(|p| p.get("rating")).cloned();
    let other = file.get(theirs).cloned().unwrap_or(Value::Null);
    let bot = other.get("bot").and_then(Value::as_bool).unwrap_or(false);

    file["you"] = json!(you);
    file["you_rating"] = rating.unwrap_or(Value::Null);
    file["opponent"] = json!({
        "type": if bot { "bot" } else { "person" },
        "name": other.get("name").cloned().unwrap_or(Value::Null),
        "rating": other.get("rating").cloned().unwrap_or(Value::Null),
    });

    true
}

/// Forgets the side of a stored game whose own name is not one of `names`.
pub fn clear_side(file: &mut Value, names: &[String]) -> bool {
    if !this_version(file) {
        return false;
    }

    let mine = match file.get("you").and_then(Value::as_str) {
        Some(side @ ("white" | "black")) => side,
        _ => return false,
    };

    let name = file
        .get(mine)
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str);
    if name.is_some_and(|n| names.iter().any(|known| same_name(known, n))) {
        return false;
    }

    file["you"] = Value::Null;
    file["you_rating"] = Value::Null;
    file["opponent"] = Value::Null;
    true
}

fn rank(order: &[&str], key: &str) -> usize {
    order.iter().position(|k| *k == key).unwrap_or(order.len())
}

fn ordered<'a>(
    map: &'a serde_json::Map<String, Value>,
    order: &[&str],
) -> Vec<(&'a String, &'a Value)> {
    let mut fields: Vec<(&String, &Value)> = map.iter().collect();
    fields.sort_by(|(a, _), (b, _)| (rank(order, a), *a).cmp(&(rank(order, b), *b)));
    fields
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn move_line(value: &Value) -> String {
    let Value::Object(map) = value else {
        return compact(value);
    };

    let fields: Vec<String> = ordered(map, &MOVE_FIELD_ORDER)
        .into_iter()
        .map(|(key, value)| format!("{}:{}", compact(&json!(key)), compact(value)))
        .collect();

    format!("{{{}}}", fields.join(","))
}

/// The file's text: one field a line, one move a line, in a fixed order.
pub fn game_text(file: &Value) -> String {
    let Value::Object(map) = file else {
        return format!("{}\n", compact(file));
    };

    let mut lines = Vec::new();
    for (key, value) in ordered(map, &FIELD_ORDER) {
        let name = compact(&json!(key));

        let line = match value {
            Value::Array(moves) if key == "moves" && !moves.is_empty() => {
                let rows: Vec<String> = moves
                    .iter()
                    .map(|m| format!("    {}", move_line(m)))
                    .collect();
                format!("  {name}: [\n{}\n  ]", rows.join(",\n"))
            }
            _ => format!("  {name}: {}", compact(value)),
        };
        lines.push(line);
    }

    format!("{{\n{}\n}}\n", lines.join(",\n"))
}
