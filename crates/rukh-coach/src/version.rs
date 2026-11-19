//! Reading a stored file by its `v`: this version, a newer one, or not readable.

use serde::de::DeserializeOwned;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum Loaded<T> {
    Read(T),
    /// Written by a newer program, which knows this version.
    Newer(u64),
    Unreadable,
}

/// A JSON object of version `known`, read as `T` and passing `sound`.
pub fn load<T: DeserializeOwned>(text: &str, known: u64, sound: impl Fn(&T) -> bool) -> Loaded<T> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Loaded::Unreadable;
    };

    match value.get("v").and_then(Value::as_u64) {
        Some(v) if v > known => return Loaded::Newer(v),
        Some(v) if v == known => {}
        _ => return Loaded::Unreadable,
    }

    match serde_json::from_value::<T>(value) {
        Ok(read) if sound(&read) => Loaded::Read(read),
        _ => Loaded::Unreadable,
    }
}
