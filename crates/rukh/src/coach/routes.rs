//! `/api/coach/*`: import game text, undo an import, store the player's own names.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes, HttpBody};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rukh_coach::batch::{cleaned_names, MAX_GAMES_PER_TEXT};
use rukh_coach::profile::MAX_MY_NAMES;
use rukh_core::pgn::is_utf16;
use serde::Deserialize;
use serde_json::{json, Value};

use super::join::read_text;
use super::store::Failure;
use super::{Coach, STOPPING};
use crate::http::AppState;

/// One pasted or dropped text.
pub const TEXT_LIMIT: usize = 32 * 1024 * 1024;

/// Every other coach body.
const JSON_LIMIT: usize = 64 * 1024;

const TEXT_TYPES: [&str; 4] = [
    "text/plain",
    "application/x-chess-pgn",
    "application/vnd.chess-pgn",
    "application/octet-stream",
];

const JSON_TYPES: [&str; 1] = ["application/json"];

const TOO_BIG_TEXT: &str = "That is too big for one import (32 MB).";

const TOO_BIG_JSON: &str = "That is more than 64 KB.";

/// Most bytes of a refused body read and thrown away, so the client is not reset before it reads the answer.
const DRAIN_LIMIT: usize = 64 * 1024 * 1024;

/// How long a refused body may pause before the rest of it is left unread.
const DRAIN_PAUSE: Duration = Duration::from_secs(5);

/// How long a body may pause while it is read.
#[cfg(not(test))]
const BODY_PAUSE: Duration = Duration::from_secs(30);

#[cfg(test)]
const BODY_PAUSE: Duration = Duration::from_secs(2);

/// How long one body may take to read in all, so a trickling client never keeps an import's turn.
#[cfg(not(test))]
const BODY_DEADLINE: Duration = Duration::from_secs(5 * 60);

#[cfg(test)]
const BODY_DEADLINE: Duration = Duration::from_secs(5);

/// An answer that ends the request early, boxed to keep results small.
type Refused = Box<Response>;

fn answer(status: StatusCode, body: Value) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        format!("{body}\n"),
    )
        .into_response()
}

fn refuse(status: StatusCode, code: &str, message: &str) -> Response {
    answer(status, json!({"error": {"code": code, "message": message}}))
}

fn too_big(message: &str) -> Refused {
    Box::new(refuse(StatusCode::PAYLOAD_TOO_LARGE, "too_big", message))
}

/// The header given exactly once, else `None`.
fn only_one(headers: &HeaderMap, name: impl header::AsHeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?;

    if values.next().is_some() {
        return None;
    }
    first.to_str().ok()
}

fn media_type(headers: &HeaderMap) -> Option<String> {
    let value = only_one(headers, header::CONTENT_TYPE)?;
    let main = value.split(';').next()?.trim().to_ascii_lowercase();
    Some(main)
}

/// The header, the content type, the declared length and the coach, all before the body is read.
fn check(
    state: &AppState,
    headers: &HeaderMap,
    types: &[&str],
    limit: usize,
    too_big_text: &str,
) -> Result<(), Refused> {
    if only_one(headers, "x-rukh") != Some("1") {
        return Err(Box::new(refuse(
            StatusCode::FORBIDDEN,
            "no_rukh_header",
            "Coach requests need the header X-Rukh: 1.",
        )));
    }

    let typed = media_type(headers).is_some_and(|t| types.contains(&t.as_str()));
    if !typed {
        return Err(Box::new(refuse(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "wrong_content_type",
            &format!("Send this as {}, given once.", types.join(" or ")),
        )));
    }

    if declared_length(headers).is_some_and(|n| n > limit as u64) {
        return Err(too_big(too_big_text));
    }

    if let Some(refusal) = state.coach.refusal() {
        return Err(Box::new(refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            refusal.code,
            &refusal.text,
        )));
    }

    Ok(())
}

fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
}

/// The next piece of a body's data: `None` at its end.
async fn next_piece(body: &mut Body) -> Option<Result<Bytes, axum::Error>> {
    loop {
        let frame = std::future::poll_fn(|cx| Pin::new(&mut *body).poll_frame(cx)).await?;

        match frame {
            Ok(frame) => {
                if let Ok(data) = frame.into_data() {
                    return Some(Ok(data));
                }
            }
            Err(e) => return Some(Err(e)),
        }
    }
}

/// Reads the rest of a refused body in the background while the answer goes out.
fn drain(mut body: Body) {
    tokio::spawn(async move {
        let mut thrown = 0;

        while thrown < DRAIN_LIMIT {
            match tokio::time::timeout(DRAIN_PAUSE, next_piece(&mut body)).await {
                Ok(Some(Ok(piece))) => thrown += piece.len(),
                _ => break,
            }
        }
    });
}

fn broken_body() -> Refused {
    Box::new(refuse(
        StatusCode::BAD_REQUEST,
        "broken_body",
        "The body did not arrive whole, so nothing is stored.",
    ))
}

/// Reads at most `limit` bytes; a longer body is refused part way and the rest drained.
async fn read_body(
    mut body: Body,
    headers: &HeaderMap,
    limit: usize,
    too_big_text: &str,
) -> Result<Vec<u8>, Refused> {
    let expected = declared_length(headers).map_or(0, |n| n.min(limit as u64) as usize);
    let mut bytes = Vec::with_capacity(expected);
    let deadline = tokio::time::Instant::now() + BODY_DEADLINE;

    loop {
        let waited = tokio::time::timeout_at(
            deadline,
            tokio::time::timeout(BODY_PAUSE, next_piece(&mut body)),
        )
        .await;

        let piece = match waited {
            Ok(Ok(None)) => return Ok(bytes),
            Ok(Ok(Some(Ok(piece)))) => piece,
            Ok(Ok(Some(Err(_)))) | Ok(Err(_)) => return Err(broken_body()),
            Err(_) => {
                drain(body);
                return Err(broken_body());
            }
        };

        if bytes.len() + piece.len() > limit {
            drain(body);
            return Err(too_big(too_big_text));
        }
        bytes.extend_from_slice(&piece);
    }
}

fn failed(failure: Failure, coach: &Coach) -> Response {
    match failure {
        Failure::NoGames => refuse(
            StatusCode::UNPROCESSABLE_ENTITY,
            "no_games",
            "No games were found in that text.",
        ),
        Failure::TooManyGames => refuse(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_many_games",
            &format!(
                "That text holds more than {MAX_GAMES_PER_TEXT} games, so nothing is stored. \
                 Import it in parts."
            ),
        ),
        Failure::UnknownBatch => refuse(
            StatusCode::NOT_FOUND,
            "unknown_batch",
            "There is no import with that name.",
        ),
        Failure::Closed => {
            let refusal = coach.refusal();
            let (code, text) = refusal
                .as_ref()
                .map_or(("stopping", STOPPING), |r| (r.code, r.text.as_str()));
            refuse(StatusCode::SERVICE_UNAVAILABLE, code, text)
        }
        Failure::Newer(text) => refuse(StatusCode::CONFLICT, "newer_version", &text),
        Failure::Io(text) => refuse(StatusCode::INTERNAL_SERVER_ERROR, "write_failed", &text),
    }
}

/// Runs `f` on a blocking thread, never under the hub lock.
async fn off_thread<T: Send + 'static>(
    state: &AppState,
    f: impl FnOnce(&Coach) -> Result<T, Failure> + Send + 'static,
) -> Result<T, Refused> {
    let coach = state.coach.clone();
    let run = tokio::task::spawn_blocking(move || f(&coach)).await;

    match run {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(failure)) => Err(Box::new(failed(failure, &state.coach))),
        Err(_) => Err(Box::new(refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "stopped",
            "The work stopped with an error. What was written before it is kept.",
        ))),
    }
}

fn bad_input(text: &str) -> Response {
    refuse(StatusCode::BAD_REQUEST, "bad_input", text)
}

pub async fn import_text(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(refused) = check(&state, &headers, &TEXT_TYPES, TEXT_LIMIT, TOO_BIG_TEXT) {
        drain(body);
        return *refused;
    }

    // The turn is taken before the body is read, so a waiting import holds no text in memory.
    let turn = state.coach.one_import().await;

    let bytes = match read_body(body, &headers, TEXT_LIMIT, TOO_BIG_TEXT).await {
        Ok(bytes) => bytes,
        Err(refused) => return *refused,
    };

    if is_utf16(&bytes) {
        return refuse(
            StatusCode::UNPROCESSABLE_ENTITY,
            "utf16_text",
            "That text is UTF-16. Save it as UTF-8 and import it again.",
        );
    }

    // Text with no game in it is refused before the coach folder is made or touched.
    let imported = off_thread(&state, move |coach| {
        let _turn = turn;
        let (games, skipped) = read_text(&bytes)?;

        coach.with_store(|store, now| store.import_text(&bytes, games, skipped, now))
    })
    .await;

    match imported {
        Ok(imported) => match &imported.failed {
            None => answer(StatusCode::OK, json!(imported)),
            Some(text) => answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": {"code": "write_failed", "message": text}, "stored": imported}),
            ),
        },
        Err(refused) => *refused,
    }
}

async fn json_body<T: for<'de> Deserialize<'de>>(
    state: &AppState,
    headers: &HeaderMap,
    body: Body,
    example: &str,
) -> Result<T, Refused> {
    if let Err(refused) = check(state, headers, &JSON_TYPES, JSON_LIMIT, TOO_BIG_JSON) {
        drain(body);
        return Err(refused);
    }

    let bytes = read_body(body, headers, JSON_LIMIT, TOO_BIG_JSON).await?;

    serde_json::from_slice(&bytes).map_err(|_| Box::new(bad_input(&format!("Send {example}."))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UndoBody {
    batch: String,
}

pub async fn undo(State(state): State<Arc<AppState>>, headers: HeaderMap, body: Body) -> Response {
    let asked: UndoBody = match json_body(&state, &headers, body, "{\"batch\": \"b0001\"}").await {
        Ok(asked) => asked,
        Err(refused) => return *refused,
    };

    let done = off_thread(&state, move |coach| {
        coach.with_made_store(Failure::UnknownBatch, |store, now| {
            store.undo(&asked.batch, now)
        })
    })
    .await;

    match done {
        Ok(done) => answer(StatusCode::OK, json!(done)),
        Err(refused) => *refused,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NamesBody {
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
}

pub async fn names(State(state): State<Arc<AppState>>, headers: HeaderMap, body: Body) -> Response {
    let example = "{\"names\": [\"your name\"]} or {\"remove\": [\"a name\"]}";
    let asked: NamesBody = match json_body(&state, &headers, body, example).await {
        Ok(asked) => asked,
        Err(refused) => return *refused,
    };

    let add = cleaned_names(&asked.names);
    let remove = cleaned_names(&asked.remove);

    let too_many = asked.names.len() > MAX_MY_NAMES || asked.remove.len() > MAX_MY_NAMES;
    if too_many || (add.is_empty() && remove.is_empty()) {
        return bad_input(&format!(
            "Send 1 to {MAX_MY_NAMES} names with something visible in each."
        ));
    }

    let done = off_thread(&state, move |coach| {
        coach.with_store(|store, now| store.change_names(&add, &remove, now))
    })
    .await;

    match done {
        Ok(done) => answer(StatusCode::OK, json!(done)),
        Err(refused) => *refused,
    }
}
