//! `profile.json`: the student, and the player's own names in imported games.

use serde_json::{json, Value};

use crate::names::{clean_name, same_name};
use crate::version::{load, Loaded};

pub const PROFILE_VERSION: u64 = 1;

pub const MAX_MY_NAMES: usize = 100;

/// The profile a new coach folder starts with.
pub fn default_profile() -> Value {
    json!({
        "v": PROFILE_VERSION,
        "name": "",
        "share_name_with_ai": false,
        "experience": "",
        "goal": "",
        "learning_style": "",
        "format": { "time_control": { "base_s": 900, "inc_s": 10 }, "session": null, "text": "" },
        "direction": { "lead": null, "emphasis": null, "text": "" },
        "minutes_per_day": 30,
        "day_starts_at": "04:00",
        "share_with_ai": "off",
        "record_other_games": true,
        "opponent": { "mode": "auto", "rung": null, "steer": true },
        "assessment": { "state": "not_started", "games": [] },
        "outside": [],
        "my_names": [],
    })
}

pub fn profile_text(profile: &Value) -> String {
    let mut text = serde_json::to_string_pretty(profile).unwrap_or_default();
    text.push('\n');
    text
}

/// A profile only when it is an object of this version.
pub fn read_profile(text: &str) -> Option<Value> {
    match load_profile(text) {
        Loaded::Read(profile) => Some(profile),
        Loaded::Newer(_) | Loaded::Unreadable => None,
    }
}

pub fn load_profile(text: &str) -> Loaded<Value> {
    load(text, PROFILE_VERSION, Value::is_object)
}

/// The stored names, cleaned; anything that is not a name is passed over.
pub fn my_names(profile: &Value) -> Vec<String> {
    profile
        .get("my_names")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .filter_map(clean_name)
                .collect()
        })
        .unwrap_or_default()
}

/// Adds names not already there, compared without case; keeps every other field.
pub fn add_names(profile: &mut Value, names: &[String]) -> Vec<String> {
    let mut list = my_names(profile);

    for name in names.iter().filter_map(|n| clean_name(n)) {
        if list.len() >= MAX_MY_NAMES {
            break;
        }
        if !list.iter().any(|known| same_name(known, &name)) {
            list.push(name);
        }
    }

    set_names(profile, &list);
    list
}

/// Takes names out, compared without case; keeps every other field.
pub fn remove_names(profile: &mut Value, names: &[String]) -> Vec<String> {
    let mut list = my_names(profile);
    list.retain(|known| !names.iter().any(|gone| same_name(known, gone)));

    set_names(profile, &list);
    list
}

fn set_names(profile: &mut Value, list: &[String]) {
    if let Value::Object(map) = profile {
        map.insert("my_names".to_string(), json!(list));
    }
}
