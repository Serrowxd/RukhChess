//! `/api/ws`: the socket a board page keeps open.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use rukh_core::{Applied, Error};

use crate::http::{AppState, PROTO};
use crate::hub::{Frame, Hub};

/// Larger messages under [`HARD_LIMIT_BYTES`] are refused with an ack.
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Above this the socket is closed with code 1009.
const HARD_LIMIT_BYTES: usize = 1024 * 1024;

/// A page that stops reading for this long is dropped.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn upgrade(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> Response {
    let k = state.next_view.fetch_add(1, Ordering::Relaxed) + 1;

    ws.max_message_size(HARD_LIMIT_BYTES)
        .max_frame_size(HARD_LIMIT_BYTES)
        .on_upgrade(move |socket| run(socket, state, format!("view:{k}")))
}

/// `rev` is the frame the page must have seen before the ack.
pub struct Ack {
    pub json: String,
    pub rev: Option<u64>,
}

fn refused(id: &Value, code: &str, message: String) -> Ack {
    Ack {
        json: json!({
            "t": "ack", "id": id, "ok": false,
            "error": {"code": code, "message": message},
        })
        .to_string(),
        rev: None,
    }
}

const NO_TAB: &str = "The intent must name its board, as in \"tab\":\"t1\". Nothing was changed.";

fn is_tab_intent(value: &Value) -> bool {
    value
        .get("op")
        .and_then(Value::as_str)
        .is_some_and(|op| op.starts_with("tab_"))
}

/// None for messages that need no answer.
pub fn handle_text(hub: &Hub, who: &str, text: &str) -> Option<Ack> {
    if text.len() > MAX_MESSAGE_BYTES {
        let id = serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.get("id").cloned())
            .unwrap_or(Value::Null);
        return Some(refused(
            &id,
            "bad_input",
            format!(
                "The message is {} bytes; the limit is {MAX_MESSAGE_BYTES}. Nothing was changed.",
                text.len()
            ),
        ));
    }

    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(e) => {
            return Some(refused(
                &Value::Null,
                "bad_input",
                format!("The message is not JSON: {e}"),
            ))
        }
    };

    if value.get("t").and_then(Value::as_str) != Some("intent") {
        // Keeps an older program working with a newer page.
        return None;
    }

    let id = value.get("id").cloned().unwrap_or(Value::Null);

    if !is_tab_intent(&value) && matches!(value.get("tab"), None | Some(Value::Null)) {
        return Some(refused(&id, "bad_input", NO_TAB.to_string()));
    }

    Some(answer(&id, hub.apply_desk(who, text, id.as_u64())))
}

fn answer(id: &Value, applied: Result<Applied, Error>) -> Ack {
    match applied {
        Ok(applied) => Ack {
            json: json!({
                "t": "ack", "id": id, "ok": true, "rev": applied.rev, "result": applied.result,
            })
            .to_string(),
            rev: Some(applied.rev),
        },
        Err(e) => refused(id, e.code(), e.to_string()),
    }
}

/// The id of a `tab_reopen` intent, which the saver answers from `closed/`.
fn reopen_id(text: &str) -> Option<Value> {
    if text.len() > MAX_MESSAGE_BYTES {
        return None;
    }

    let value: Value = serde_json::from_str(text).ok()?;
    let is_reopen = value.get("t").and_then(Value::as_str) == Some("intent")
        && value.get("op").and_then(Value::as_str) == Some("tab_reopen");

    is_reopen.then(|| value.get("id").cloned().unwrap_or(Value::Null))
}

/// Answers one message from a page; `tab_reopen` goes to the saver when boards are saved.
pub async fn handle_message(hub: &Hub, who: &str, text: &str) -> Option<Ack> {
    if let Some(id) = reopen_id(text) {
        if let Some(applied) = hub.reopen_closed(who, id.as_u64()).await {
            return Some(answer(&id, applied));
        }
    }

    handle_text(hub, who, text)
}

/// False means the socket is finished.
async fn send_message(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(SEND_TIMEOUT, socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn send_frame(socket: &mut WebSocket, frame: &Frame, sent_rev: &mut u64) -> bool {
    *sent_rev = frame.rev;
    send_message(socket, Message::Text(frame.json.clone().into())).await
}

/// A message over [`HARD_LIMIT_BYTES`].
fn is_too_large(error: &axum::Error) -> bool {
    use std::error::Error as _;
    matches!(
        error
            .source()
            .and_then(|e| e.downcast_ref::<tungstenite::Error>()),
        Some(tungstenite::Error::Capacity(_))
    )
}

fn too_large_close() -> Message {
    Message::Close(Some(CloseFrame {
        code: close_code::SIZE,
        reason: format!("Message too large: the limit is {MAX_MESSAGE_BYTES} bytes.").into(),
    }))
}

async fn run(mut socket: WebSocket, state: Arc<AppState>, who: String) {
    let _view = state.hub.presence().view_joined();
    let mut frames = state.hub.subscribe();
    let mut presence = state.hub.presence().subscribe();
    let mut shutdown = state.shutdown.clone();
    let mut boards = state.hub.status();

    let status = boards.borrow_and_update().clone();
    let hello = json!({
        "t": "hello", "proto": PROTO, "instance": state.hub.instance(), "you": who,
        "boards": status.boards(),
    });
    if !send_message(&mut socket, Message::Text(hello.to_string().into())).await {
        return;
    }

    let mut sent_rev = 0;
    let first = frames.borrow_and_update().clone();
    if !send_frame(&mut socket, &first, &mut sent_rev).await {
        return;
    }

    let now = presence.borrow_and_update().clone();
    if !send_message(&mut socket, Message::Text(now.as_str().into())).await {
        return;
    }

    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            changed = presence.changed() => {
                if changed.is_err() {
                    break;
                }

                let now = presence.borrow_and_update().clone();
                if !send_message(&mut socket, Message::Text(now.as_str().into())).await {
                    break;
                }
            }
            changed = boards.changed() => {
                if changed.is_err() {
                    break;
                }

                let message = boards.borrow_and_update().message();
                if !send_message(&mut socket, Message::Text(message.into())).await {
                    break;
                }
            }
            changed = frames.changed() => {
                if changed.is_err() {
                    break;
                }

                let frame = frames.borrow_and_update().clone();
                if frame.rev > sent_rev && !send_frame(&mut socket, &frame, &mut sent_rev).await {
                    break;
                }
            }
            message = socket.recv() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Err(error)) if is_too_large(&error) => {
                        send_message(&mut socket, too_large_close()).await;
                        return;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                };

                let Some(ack) = handle_message(&state.hub, &who, text.as_str()).await else {
                    continue;
                };

                // The hub published this change's frame before answering.
                if ack.rev.is_some_and(|rev| rev > sent_rev) {
                    let frame = frames.borrow_and_update().clone();
                    if !send_frame(&mut socket, &frame, &mut sent_rev).await {
                        break;
                    }
                }

                if !send_message(&mut socket, Message::Text(ack.json.into())).await {
                    break;
                }
            }
        }
    }

    send_message(&mut socket, Message::Close(None)).await;
}
