//! `/api/ws`: the socket a board page keeps open.
//!
//! The server sends `hello`, then the current state frame, then every later frame (a slow socket
//! may skip some, but always ends on the latest). The page sends intents and gets one `ack` each.
//! Presence messages (`{"t":"presence",...}`) are sent after the first frame and whenever presence
//! changes; they are not state and carry no rev.
//! One loop per socket does all the writing, and it sends a frame at least as new as an ack before
//! the ack itself, so when the page sees an ack its board already shows the result.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::http::{AppState, PROTO};
use crate::hub::{Frame, Hub};

/// Largest message a page may send. Intents are small. A bigger message that is still under
/// [`HARD_LIMIT_BYTES`] is read whole and refused with an ack, so the page can say why.
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Largest message the socket reads at all. Above this the socket is closed with code 1009.
const HARD_LIMIT_BYTES: usize = 1024 * 1024;

/// How long one send may wait on a page that stopped reading before the socket is dropped.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn upgrade(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> Response {
    let k = state.next_view.fetch_add(1, Ordering::Relaxed) + 1;
    ws.max_message_size(HARD_LIMIT_BYTES)
        .max_frame_size(HARD_LIMIT_BYTES)
        .on_upgrade(move |socket| run(socket, state, format!("view:{k}")))
}

/// The answer to one message: the ack text, and the rev the page must have seen before it.
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

/// Applies one message from a page. Returns None for messages that need no answer.
///
/// An intent is the whole message, `{"t":"intent","id":n,"op":...}`: the table reads `op` and
/// its fields and ignores `t` and `id`.
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
        // Other message types belong to later versions of the page; ignoring them keeps an older
        // program working with a newer page.
        return None;
    }
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    Some(match hub.apply(who, text, id.as_u64()) {
        Ok(applied) => Ack {
            json: json!({
                "t": "ack", "id": id, "ok": true, "rev": applied.rev, "result": applied.result,
            })
            .to_string(),
            rev: Some(applied.rev),
        },
        Err(e) => refused(&id, e.code(), e.to_string()),
    })
}

/// Sends one message. False when the socket failed or the page did not take the message within
/// [`SEND_TIMEOUT`]; either way the socket is finished.
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

/// True when a receive error is a message over [`HARD_LIMIT_BYTES`].
fn is_too_large(error: &axum::Error) -> bool {
    use std::error::Error as _;
    matches!(
        error
            .source()
            .and_then(|e| e.downcast_ref::<tungstenite::Error>()),
        Some(tungstenite::Error::Capacity(_))
    )
}

/// The close frame for a page that sent a message over the size limit, so it can say why.
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
    let hello = json!({"t": "hello", "proto": PROTO, "instance": state.hub.instance(), "you": who});
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
                let Some(ack) = handle_text(&state.hub, &who, text.as_str()) else {
                    continue;
                };
                // The hub published the frame for this change before answering, so the latest
                // frame is at least as new as the ack.
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
