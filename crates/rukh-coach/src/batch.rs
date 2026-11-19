//! Batches: one pasted or dropped text each, its record and what an import answers.

use std::borrow::Borrow;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::game::{build, GameRecord};
use crate::keys::Keys;
use crate::names::{clean_name, folded};
use crate::skip::Skipped;
use crate::text::TextGame;
use crate::version::{load, Loaded};

pub const BATCH_VERSION: u32 = 1;

/// The one raw part of a text import, kept exactly as received.
pub const RAW_PART: &str = "part-001.pgn";

/// Games kept from one text; a text with more is refused whole, so nothing is half imported.
pub const MAX_GAMES_PER_TEXT: usize = 50_000;

/// Player names offered when the side is not known.
pub const MAX_CHOICES: usize = 20;

const MAX_ID_DIGITS: usize = 12;

/// The highest number an id may carry, so it always fits [`MAX_ID_DIGITS`].
pub const MAX_ID: u64 = 999_999_999_999;

fn numbered(prefix: char, n: u64) -> String {
    format!("{prefix}{n:04}")
}

/// Only the exact form `numbered` writes, so a name like `g007` or `g0007x` is never an id.
fn number_in(prefix: char, text: &str) -> Option<u64> {
    let digits = text.strip_prefix(prefix)?;
    if digits.len() > MAX_ID_DIGITS || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }

    let n: u64 = digits.parse().ok()?;
    (n > 0 && numbered(prefix, n) == text).then_some(n)
}

pub fn game_id(n: u64) -> String {
    numbered('g', n)
}

pub fn game_number(id: &str) -> Option<u64> {
    number_in('g', id)
}

/// The number of a game file name, `g0007.json`.
pub fn game_file_number(name: &str) -> Option<u64> {
    game_number(name.strip_suffix(".json")?)
}

pub fn batch_id(n: u64) -> String {
    numbered('b', n)
}

pub fn batch_number(id: &str) -> Option<u64> {
    number_in('b', id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Undone {
    pub at: String,
    pub moved: Vec<String>,
}

/// `imports/<batch>/batch.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BatchRecord {
    pub v: u32,
    pub id: String,
    pub kind: String,
    pub received: Option<String>,
    pub parts: Vec<Part>,
    pub added: Vec<String>,
    pub already_here: u32,
    pub skipped: Skipped,
    pub undone: Option<Undone>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl BatchRecord {
    pub fn from_text(text: &str) -> Option<BatchRecord> {
        match BatchRecord::loaded(text) {
            Loaded::Read(read) => Some(read),
            Loaded::Newer(_) | Loaded::Unreadable => None,
        }
    }

    pub fn loaded(text: &str) -> Loaded<BatchRecord> {
        load(text, u64::from(BATCH_VERSION), |_| true)
    }

    pub fn to_text(&self) -> String {
        let mut text = serde_json::to_string_pretty(self).unwrap_or_default();
        text.push('\n');
        text
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerCount {
    pub name: String,
    pub games: u32,
}

/// What an import answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    /// None when nothing new was stored, so no batch was made.
    pub batch: Option<String>,
    pub added: u32,
    pub already_here: u32,
    /// Of those, games with no date, so matched by moves and names alone.
    pub already_here_undated: u32,
    pub skipped: Skipped,
    pub skipped_total: u32,
    /// Added games that start from a set-up position.
    pub set_up: u32,
    /// Games of this text, added or already here, whose side is not known.
    pub side_unknown: u32,
    /// The players of those games, most games first.
    pub choose: Vec<PlayerCount>,
}

/// The games of one text sorted into new, already here and skipped.
#[derive(Debug, Clone, Default)]
pub struct Sorted {
    pub new: Vec<GameRecord>,
    pub summary: Summary,
}

/// Decides each game against the stored keys and the earlier games of the same text.
pub fn sort<G: Borrow<TextGame>>(
    games: impl IntoIterator<Item = G>,
    skipped: Skipped,
    keys: &Keys,
    names: &[String],
) -> Sorted {
    let mut sorted = Sorted::default();
    sorted.summary.skipped = skipped;

    let mut seen = BTreeSet::new();
    let mut players: BTreeMap<String, (String, u32)> = BTreeMap::new();

    // Games given by value are dropped one by one, so a text never sits in memory twice.
    for game in games {
        let record = match build(game.borrow(), names) {
            Ok(record) => record,
            Err(skip) => {
                sorted.summary.skipped.add(skip);
                continue;
            }
        };

        if record.you.is_none() {
            sorted.summary.side_unknown += 1;
            count_players(&record, &mut players);
        }

        let here = keys.holder(&record.move_key).is_some() || seen.contains(&record.move_key);
        if here {
            sorted.summary.already_here += 1;
            if record.started.is_none() && record.date.is_none() {
                sorted.summary.already_here_undated += 1;
            }
            continue;
        }

        seen.insert(record.move_key.clone());
        if record.from_position {
            sorted.summary.set_up += 1;
        }
        sorted.summary.added += 1;
        sorted.new.push(record);
    }

    sorted.summary.skipped_total = sorted.summary.skipped.total();
    sorted.summary.choose = choices(players);
    sorted
}

fn count_players(record: &GameRecord, players: &mut BTreeMap<String, (String, u32)>) {
    let mut in_game = BTreeSet::new();

    for name in [&record.white.name, &record.black.name]
        .into_iter()
        .flatten()
    {
        let key = folded(name);
        if !in_game.insert(key.clone()) {
            continue;
        }

        players.entry(key).or_insert_with(|| (name.clone(), 0)).1 += 1;
    }
}

fn choices(players: BTreeMap<String, (String, u32)>) -> Vec<PlayerCount> {
    let mut list: Vec<PlayerCount> = players
        .into_values()
        .map(|(name, games)| PlayerCount { name, games })
        .collect();

    list.sort_by(|a, b| b.games.cmp(&a.games).then_with(|| a.name.cmp(&b.name)));
    list.truncate(MAX_CHOICES);
    list
}

/// Names a person sent, cleaned; empty ones left out.
pub fn cleaned_names(raw: &[String]) -> Vec<String> {
    raw.iter().filter_map(|name| clean_name(name)).collect()
}
