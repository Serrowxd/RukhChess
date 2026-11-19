//! The two keys on every game, and the index of them in `derived/keys.json`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hash::Fnv128;
use crate::names::folded;
use crate::text::TextTags;
use crate::version::{load, Loaded};

pub const KEYS_VERSION: u32 = 1;

const LICHESS_ID_CHARS: usize = 8;

const MAX_CHESS_COM_DIGITS: usize = 20;

/// Where a game says it was played, and its id there. Text proves neither.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteKey {
    pub site: &'static str,
    pub key: String,
}

fn lichess_id(text: &str) -> Option<&str> {
    let ok = text.len() == LICHESS_ID_CHARS && text.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then_some(text)
}

fn without_scheme(url: &str) -> Option<&str> {
    url.strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
}

fn lichess_url(url: &str) -> Option<SiteKey> {
    let id = without_scheme(url.trim())?.strip_prefix("lichess.org/")?;

    Some(SiteKey {
        site: "lichess",
        key: format!("lichess:{}", lichess_id(id)?),
    })
}

fn chess_com_url(url: &str) -> Option<SiteKey> {
    let rest = without_scheme(url.trim())?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let rest = rest.strip_prefix("chess.com/game/")?;

    let (kind, number) = rest.split_once('/')?;
    let digits_ok = !number.is_empty()
        && number.len() <= MAX_CHESS_COM_DIGITS
        && number.bytes().all(|b| b.is_ascii_digit());

    if !digits_ok || !matches!(kind, "live" | "daily") {
        return None;
    }

    Some(SiteKey {
        site: "chess.com",
        key: format!("chess.com:{kind}:{number}"),
    })
}

/// Taken by strict pattern from `Link`, then `Site`, then a Lichess `GameId`.
pub fn site_key(tags: &TextTags) -> Option<SiteKey> {
    let from_url = |tag: &Option<String>| {
        tag.as_deref()
            .and_then(|url| chess_com_url(url).or_else(|| lichess_url(url)))
    };

    if let Some(key) = from_url(&tags.link).or_else(|| from_url(&tags.site)) {
        return Some(key);
    }

    let site_says_lichess = tags
        .site
        .as_deref()
        .is_none_or(|site| site.to_ascii_lowercase().contains("lichess"));

    let id = lichess_id(tags.game_id.as_deref()?.trim())?;
    site_says_lichess.then(|| SiteKey {
        site: "lichess",
        key: format!("lichess:{id}"),
    })
}

/// The hash of start position, moves, start time and both names without case.
pub fn move_key<'a>(
    start_fen: &str,
    moves: impl IntoIterator<Item = &'a str>,
    started: &str,
    white: &str,
    black: &str,
) -> String {
    let mut hash = Fnv128::new();

    hash.field(start_fen);
    for uci in moves {
        hash.field(uci);
    }

    // An empty field ends the moves, so a move can never be read as the time.
    hash.field("");
    hash.field(started);
    hash.field(&folded(white));
    hash.field(&folded(black));

    hash.hex()
}

/// Which game holds each move key, and which games name each site key.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Keys {
    pub v: u32,
    /// Every game file numbered below this is in the index.
    pub covers_below: u64,
    pub moves: BTreeMap<String, String>,
    pub sites: BTreeMap<String, Vec<String>>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Keys {
    pub fn new() -> Keys {
        Keys {
            v: KEYS_VERSION,
            ..Keys::default()
        }
    }

    pub fn from_text(text: &str) -> Option<Keys> {
        match Keys::loaded(text) {
            Loaded::Read(read) => Some(read),
            Loaded::Newer(_) | Loaded::Unreadable => None,
        }
    }

    pub fn loaded(text: &str) -> Loaded<Keys> {
        load(text, u64::from(KEYS_VERSION), |_| true)
    }

    pub fn to_text(&self) -> String {
        let mut text = serde_json::to_string(self).unwrap_or_default();
        text.push('\n');
        text
    }

    /// The game already stored under this move key.
    pub fn holder(&self, move_key: &str) -> Option<&str> {
        self.moves.get(move_key).map(String::as_str)
    }

    pub fn add(&mut self, id: &str, move_key: &str, site_key: Option<&str>) {
        self.moves.insert(move_key.to_string(), id.to_string());

        if let Some(site_key) = site_key {
            let ids = self.sites.entry(site_key.to_string()).or_default();
            if !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.moves.retain(|_, holder| holder != id);

        for ids in self.sites.values_mut() {
            ids.retain(|known| known != id);
        }
        self.sites.retain(|_, ids| !ids.is_empty());
    }

    /// Keeps only games whose id passes `present`.
    pub fn keep(&mut self, present: impl Fn(&str) -> bool) {
        self.moves.retain(|_, holder| present(holder));

        for ids in self.sites.values_mut() {
            ids.retain(|known| present(known));
        }
        self.sites.retain(|_, ids| !ids.is_empty());
    }

    /// Adds a stored game file's keys; false when the file has no move key.
    pub fn add_file(&mut self, file: &Value) -> bool {
        let id = file.get("id").and_then(Value::as_str);
        let move_key = file.get("move_key").and_then(Value::as_str);
        let site_key = file
            .get("source")
            .and_then(|s| s.get("site_key"))
            .and_then(Value::as_str);

        match (id, move_key) {
            (Some(id), Some(move_key)) => {
                self.add(id, move_key, site_key);
                true
            }
            _ => false,
        }
    }
}
