//! Tests against the real server on a free port: hub, guard, static files, socket and MCP.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use rukh_core::INITIAL_FEN;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

use crate::hub::Hub;
use crate::{start, Running};

mod tabs;

const WAIT: Duration = Duration::from_secs(10);

/// A request in the guard test: method, path, extra headers, body.
type Route<'a> = (&'a str, &'a str, Vec<(&'static str, String)>, &'a str);

fn testdata(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join(name)
}

async fn serve(web: &str) -> Running {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind a test port");
    start(listener, testdata(web)).expect("start the test server")
}

/// One HTTP/1.1 request written by hand, so the test controls the exact path and Host header.
async fn raw(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: &str,
) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");

    let mut request = format!("{method} {path} HTTP/1.1\r\n");
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("connection"))
    {
        request.push_str("Connection: close\r\n");
    }
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("host"))
    {
        request.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if !body.is_empty() {
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }

    request.push_str("\r\n");
    request.push_str(body);

    stream
        .write_all(request.as_bytes())
        .await
        .expect("send request");

    // A WebSocket upgrade keeps the connection open, so end of stream is not the signal.
    let mut response = Vec::new();
    let mut buf = [0u8; 8192];

    loop {
        let text = String::from_utf8_lossy(&response).to_string();
        if let Some((head, body)) = text.split_once("\r\n\r\n") {
            let head = head.to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok());
            if head.starts_with("http/1.1 101") || length.is_some_and(|n| body.len() >= n) {
                break;
            }
        }
        match tokio::time::timeout(WAIT, stream.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => response.extend_from_slice(&buf[..n]),
            _ => break,
        }
    }

    let text = String::from_utf8_lossy(&response).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (status, head.to_ascii_lowercase(), body.to_string())
}

fn frame_value(hub: &Hub) -> Value {
    serde_json::from_str(&hub.latest().json).expect("frame is JSON")
}

// ------------------------------------------------------------------ hub

#[tokio::test]
async fn two_watch_receivers_see_the_same_rev_after_a_move() {
    let hub = Hub::new("test".into());
    let mut a = hub.subscribe();
    let mut b = hub.subscribe();

    let applied = hub
        .apply("view:1", r#"{"op":"play","move":"e4"}"#, Some(3))
        .expect("e4 is legal");
    assert_eq!(applied.rev, 1);

    tokio::time::timeout(WAIT, a.changed())
        .await
        .expect("a woke")
        .expect("open");
    tokio::time::timeout(WAIT, b.changed())
        .await
        .expect("b woke")
        .expect("open");

    let (fa, fb) = (a.borrow_and_update().clone(), b.borrow_and_update().clone());
    assert_eq!(fa.rev, 1);
    assert_eq!(fa.rev, fb.rev);
    assert_eq!(fa.json, fb.json);

    let frame: Value = serde_json::from_str(&fa.json).expect("JSON");
    assert_eq!(frame["t"], "state");
    assert_eq!(frame["instance"], "test");
    assert_eq!(
        frame["hint"],
        json!({"reason": "move", "by": "view:1", "intent_id": 3})
    );
    assert_eq!(frame["state"]["game"]["turn"], "black");
    assert_eq!(frame["state"]["board_rev"], 1);
    assert_eq!(frame["state"]["match"]["active"], false);
}

#[test]
fn a_refused_intent_publishes_nothing() {
    let hub = Hub::new("test".into());
    hub.apply("view:1", r#"{"op":"play","move":"e4","from_node":0}"#, None)
        .expect("fresh position plays");
    let before = hub.latest();
    let stale = hub
        .apply("view:2", r#"{"op":"play","move":"d4","from_node":0}"#, None)
        .expect_err("the board moved on");
    assert_eq!(stale.code(), "stale");
    let illegal = hub
        .apply("view:2", r#"{"op":"play","move":"e4"}"#, None)
        .expect_err("black cannot play e4");
    assert_eq!(illegal.code(), "illegal");
    assert!(
        illegal.to_string().contains("Black is to move"),
        "{illegal}"
    );
    let after = hub.latest();
    assert_eq!(after.rev, before.rev);
    assert_eq!(after.json, before.json);
}

#[test]
fn an_intent_that_changes_nothing_publishes_nothing() {
    let hub = Hub::new("test".into());

    let applied = hub
        .apply("view:1", r#"{"op":"back"}"#, None)
        .expect("back at the start is accepted");
    assert!(!applied.changed);
    assert_eq!(hub.latest().rev, 0);
    assert_eq!(frame_value(&hub)["hint"]["reason"], "init");
}

// ------------------------------------------------------------------ guard

#[tokio::test]
async fn foreign_host_and_origin_get_403_on_every_route() {
    let server = serve("web").await;
    let port = server.port;
    let good_host = format!("127.0.0.1:{port}");
    let ws = |extra: Vec<(&'static str, String)>| {
        let mut h = vec![
            ("Upgrade", "websocket".to_string()),
            ("Connection", "Upgrade".to_string()),
            ("Sec-WebSocket-Version", "13".to_string()),
            ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==".to_string()),
        ];
        h.extend(extra);
        h
    };

    let mcp_body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let mcp = |extra: Vec<(&'static str, String)>| {
        let mut h = vec![
            ("Content-Type", "application/json".to_string()),
            ("Accept", "application/json, text/event-stream".to_string()),
        ];
        h.extend(extra);
        h
    };

    // The guard's own text proves the guard refused it, not a later layer.
    let routes: Vec<Route> = vec![
        ("GET", "/api/hello", vec![], ""),
        ("GET", "/api/ws", ws(vec![]), ""),
        ("POST", "/mcp", mcp(vec![]), mcp_body),
        ("GET", "/", vec![], ""),
        ("GET", "/app.js", vec![], ""),
    ];

    let bad_headers: Vec<Vec<(&'static str, String)>> = vec![
        vec![("Origin", "http://evil.example".to_string())],
        vec![(
            "Origin",
            format!("http://127.0.0.1:{}", port.wrapping_add(1)),
        )],
        vec![("Origin", "null".to_string())],
        vec![("Host", "evil.example".to_string())],
        vec![("Host", format!("evil.example:{port}"))],
        vec![("Host", format!("127.0.0.1:{port}.evil.com"))],
        vec![("Host", "127.0.0.1".to_string())],
        vec![("Host", format!("LOCALHOST:{port}"))],
        // A good value followed by a foreign one must not slip through.
        vec![
            ("Host", good_host.clone()),
            ("Host", "evil.example".to_string()),
        ],
        vec![
            ("Origin", format!("http://127.0.0.1:{port}")),
            ("Origin", "http://evil.example".to_string()),
        ],
    ];

    for bad in &bad_headers {
        for (method, path, base, body) in &routes {
            let mut headers = base.clone();
            headers.extend(bad.iter().cloned());
            let (status, head, text) = raw(port, method, path, &headers, body).await;
            assert_eq!(status, 403, "{method} {path} with {bad:?}: {text}");
            assert!(
                text.contains("Rukh only answers"),
                "{method} {path} with {bad:?} was not refused by the guard: {text}"
            );
            assert!(head.contains("x-content-type-options: nosniff"), "{head}");
        }
    }
    // The same requests from our own names pass the guard.
    let ours = ("Origin", format!("http://localhost:{port}"));
    let (status, head, body) =
        raw(port, "GET", "/api/hello", std::slice::from_ref(&ours), "").await;
    assert_eq!(status, 200, "{body}");
    assert!(
        !head.contains("access-control-allow-origin"),
        "no CORS headers: {head}"
    );

    let localhost = ("Host", format!("localhost:{port}"));
    assert_eq!(
        raw(port, "GET", "/api/hello", &[localhost], "").await.0,
        200
    );
    let (status, _, _) = raw(
        port,
        "GET",
        "/api/ws",
        &ws(vec![ours, ("Host", good_host)]),
        "",
    )
    .await;
    assert_eq!(status, 101);

    server.stop().await;
}

#[tokio::test]
async fn hello_names_the_app() {
    let server = serve("web").await;
    let (status, _, body) = raw(server.port, "GET", "/api/hello", &[], "").await;
    assert_eq!(status, 200);
    let hello: Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(hello["app"], "rukh");
    assert_eq!(hello["proto"], 2);
    assert_eq!(hello["port"], server.port);
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(hello["instance"], server.hub.instance());
    assert_eq!(hello["link"], format!("http://127.0.0.1:{}/", server.port));

    server.stop().await;
}

// ------------------------------------------------------------------ static files

#[tokio::test]
async fn static_files_are_served_with_their_types() {
    let server = serve("web").await;
    let port = server.port;
    let (status, head, body) = raw(port, "GET", "/", &[], "").await;
    assert_eq!(status, 200);
    assert!(head.contains("content-type: text/html"), "{head}");
    assert!(body.contains("test board"));
    let (status, head, _) = raw(port, "GET", "/app.js", &[], "").await;
    assert_eq!(status, 200);
    assert!(head.contains("content-type: text/javascript"), "{head}");
    let (status, head, _) = raw(port, "GET", "/mod.wasm", &[], "").await;
    assert_eq!(status, 200);
    assert!(head.contains("content-type: application/wasm"), "{head}");
    assert_eq!(raw(port, "GET", "/sub/page.txt", &[], "").await.0, 200);
    assert_eq!(raw(port, "GET", "/missing.js", &[], "").await.0, 404);

    server.stop().await;
}

#[tokio::test]
async fn static_files_refuse_path_traversal() {
    let server = serve("web").await;
    let port = server.port;
    for path in [
        "/../secret.txt",
        "/sub/../../secret.txt",
        "/%2e%2e/secret.txt",
        "/%2E%2E%2Fsecret.txt",
        "/..%5csecret.txt",
        "/sub/..%5c..%5csecret.txt",
        "/..\\secret.txt",
        "//secret.txt",
        "/./index.html",
        "/%00",
        "/%zz",
        "/C:/Windows/win.ini",
    ] {
        let (status, _, body) = raw(port, "GET", path, &[], "").await;
        assert_ne!(status, 200, "{path} must not be served");
        assert!(
            !body.contains("SECRET-OUTSIDE-WEB-DIR"),
            "{path} leaked a file"
        );
    }

    server.stop().await;
}

#[tokio::test]
async fn root_explains_how_to_build_when_the_board_is_missing() {
    for web in ["no-board", "does-not-exist"] {
        let server = serve(web).await;
        let (status, head, body) = raw(server.port, "GET", "/", &[], "").await;
        assert_eq!(status, 200);
        assert!(head.contains("content-type: text/plain"), "{head}");
        assert!(body.contains("node build.mjs --no-single"), "{body}");
        assert_eq!(raw(server.port, "GET", "/app.js", &[], "").await.0, 404);
        server.stop().await;
    }
}

// ------------------------------------------------------------------ WebSocket

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

async fn connect(port: u16) -> Socket {
    let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/api/ws"))
        .await
        .expect("WebSocket connects");
    socket
}

/// The next message of any kind: hello, state, ack or presence.
async fn next_any(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("a message in time")
            .expect("socket open")
            .expect("readable message");
        if let Message::Text(text) = message {
            return serde_json::from_str(text.as_str()).expect("JSON message");
        }
    }
}

/// The next hello, state or ack message; presence messages are skipped.
async fn next_json(socket: &mut Socket) -> Value {
    loop {
        let message = next_any(socket).await;
        if message["t"] != "presence" {
            return message;
        }
    }
}

async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("send intent");
}

/// Reads messages until the ack with `id`, skipping frames and presence. Returns the ack.
async fn ack_for(socket: &mut Socket, id: u64) -> Value {
    loop {
        let message = next_any(socket).await;
        if message["t"] == "ack" && message["id"] == id {
            return message;
        }
    }
}

/// A connected page: hello, the first frame and the first presence message already read.
async fn view(port: u16) -> (Socket, Value) {
    let mut socket = connect(port).await;
    let hello = next_any(&mut socket).await;
    assert_eq!(hello["t"], "hello");
    assert_eq!(next_any(&mut socket).await["t"], "state");
    assert_eq!(next_any(&mut socket).await["t"], "presence");

    (socket, hello)
}

/// Sends one intent and returns its ack.
async fn intent(socket: &mut Socket, id: u64, mut body: Value) -> Value {
    body["t"] = json!("intent");
    body["id"] = json!(id);
    if body.get("tab").is_none() {
        body["tab"] = json!("t1");
    }

    send(socket, body).await;
    ack_for(socket, id).await
}

#[tokio::test]
async fn socket_gets_hello_then_state_and_acks_never_precede_their_frame() {
    let server = serve("web").await;
    let mut a = connect(server.port).await;
    let mut b = connect(server.port).await;

    let hello = next_any(&mut a).await;
    assert_eq!(hello["t"], "hello");
    assert_eq!(hello["proto"], 2);
    assert_eq!(hello["instance"], server.hub.instance());
    assert!(hello["you"]
        .as_str()
        .is_some_and(|y| y.starts_with("view:")));
    let first = next_any(&mut a).await;
    assert_eq!(first["t"], "state");
    assert_eq!(first["rev"], 0);
    assert_eq!(first["hint"]["reason"], "init");
    assert_eq!(first["state"]["match"]["to_move"], Value::Null);
    let presence = next_any(&mut a).await;
    assert_eq!(presence["t"], "presence");
    assert!(presence["views"].as_u64().is_some_and(|n| n >= 1));

    // Send a whole opening without waiting, then check every ack came after a frame that new.
    let moves = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"];
    for (i, mv) in moves.iter().enumerate() {
        send(
            &mut a,
            json!({"t": "intent", "id": i + 1, "tab": "t1", "op": "play", "move": mv, "from_node": i}),
        )
        .await;
    }
    let mut seen_rev = 0;
    let mut acks = 0;
    while acks < moves.len() {
        let message = next_any(&mut a).await;
        match message["t"].as_str() {
            Some("state") => seen_rev = seen_rev.max(message["rev"].as_u64().expect("rev")),
            Some("ack") => {
                assert_eq!(message["ok"], true, "{message}");
                let rev = message["rev"].as_u64().expect("ack rev");
                assert!(
                    seen_rev >= rev,
                    "ack for rev {rev} arrived before its frame"
                );
                assert!(message["result"]["san"].is_string(), "{message}");
                acks += 1;
            }
            Some("presence") => {}
            other => panic!("unexpected message {other:?}"),
        }
    }
    assert_eq!(seen_rev, moves.len() as u64);

    // The other socket may skip frames but ends on the latest one.
    let mut last = Value::Null;
    while last["rev"] != json!(moves.len()) {
        last = next_json(&mut b).await;
    }
    assert_eq!(last["state"]["game"]["current"], moves.len());
    assert_eq!(last["state"]["board_rev"], moves.len());
    assert_eq!(last["hint"]["by"], hello["you"]);

    server.stop().await;
}

#[tokio::test]
async fn socket_refusals_change_nothing() {
    let server = serve("web").await;
    let (mut a, _) = view(server.port).await;

    let ack = intent(
        &mut a,
        1,
        json!({"op": "play", "move": "e2e4", "from_node": 0}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    assert_eq!(ack["rev"], 1);
    assert_eq!(ack["result"]["node"], 1);

    // Stale: sent from the start position, but the game has moved on.
    let ack = intent(
        &mut a,
        2,
        json!({"op": "play", "move": "d2d4", "from_node": 0}),
    )
    .await;
    assert_eq!(ack["ok"], false);
    assert_eq!(ack["error"]["code"], "stale");
    assert!(
        ack["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("The board has moved on")),
        "{ack}"
    );
    assert_eq!(server.hub.latest().rev, 1);

    // Illegal: from the right node, but not a legal move.
    let ack = intent(
        &mut a,
        3,
        json!({"op": "play", "move": "e4", "from_node": 1}),
    )
    .await;
    assert_eq!(ack["error"]["code"], "illegal");
    assert!(ack["error"]["message"]
        .as_str()
        .is_some_and(|m| m.contains("Black is to move")));

    // Malformed, unknown, and a seat claim, which only an AI may send.
    let ack = intent(&mut a, 4, json!({"op": "fly"})).await;
    assert_eq!(ack["error"]["code"], "bad_input");
    let ack = intent(&mut a, 5, json!({"op": "play"})).await;
    assert_eq!(ack["error"]["code"], "bad_input");
    let ack = intent(&mut a, 6, json!({"op": "claim_seat", "seat": "white"})).await;
    assert_eq!(ack["error"]["code"], "bad_input");
    a.send(Message::Text("{not json".into()))
        .await
        .expect("send");
    assert_eq!(next_json(&mut a).await["error"]["code"], "bad_input");
    assert_eq!(server.hub.latest().rev, 1);

    // New game: frame first, then the ack.
    send(
        &mut a,
        json!({"t": "intent", "id": 7, "tab": "t1", "op": "new_game"}),
    )
    .await;
    let frame = next_json(&mut a).await;
    assert_eq!(frame["rev"], 2);
    assert_eq!(frame["hint"]["reason"], "new_game");
    assert_eq!(frame["hint"]["intent_id"], 7);
    assert_eq!(frame["state"]["game"]["fen"], INITIAL_FEN);
    assert_eq!(frame["state"]["game_id"], 2);
    assert_eq!(next_json(&mut a).await["ok"], true);

    server.stop().await;
}

#[tokio::test]
async fn socket_carries_navigation_and_match_intents() {
    let server = serve("web").await;
    let (mut a, _) = view(server.port).await;
    for (i, mv) in ["e4", "e5", "Nf3"].iter().enumerate() {
        let ack = intent(
            &mut a,
            i as u64 + 1,
            json!({"op": "play", "move": mv, "from_node": i}),
        )
        .await;
        assert_eq!(ack["ok"], true, "{ack}");
    }
    let ack = intent(
        &mut a,
        10,
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}, "style": "Coach"}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    let m = &frame_value(&server.hub)["state"]["match"];
    assert_eq!(
        *m,
        json!({"active": true, "seats": {"white": "human", "black": "ai"}, "tip": 3,
               "live": true, "to_move": "ai", "style": "coach", "time_control": null})
    );

    let ack = intent(&mut a, 11, json!({"op": "back"})).await;
    assert_eq!(ack["result"]["node"], 2);
    assert_eq!(ack["result"]["live"], false);
    let frame = frame_value(&server.hub);
    assert_eq!(frame["state"]["match"]["live"], false);
    assert_eq!(frame["state"]["match"]["to_move"], Value::Null);
    assert_eq!(frame["hint"]["reason"], "navigate");
    assert_eq!(
        intent(&mut a, 12, json!({"op": "to_start"})).await["result"]["node"],
        0
    );
    assert_eq!(
        intent(&mut a, 13, json!({"op": "forward"})).await["result"]["node"],
        1
    );
    assert_eq!(
        intent(&mut a, 14, json!({"op": "to_end"})).await["result"]["node"],
        3
    );
    assert_eq!(
        intent(&mut a, 15, json!({"op": "goto", "node": 2})).await["result"]["node"],
        2
    );
    let ack = intent(&mut a, 16, json!({"op": "goto", "node": 3})).await;
    assert_eq!(ack["result"]["live"], true);
    let ack = intent(&mut a, 17, json!({"op": "goto", "node": 99})).await;
    assert_eq!(ack["error"]["code"], "bad_input");

    let ack = intent(&mut a, 18, json!({"op": "set_style", "style": "nonsense"})).await;
    assert_eq!(ack["result"]["style"]["name"], "annotate");
    let ack = intent(
        &mut a,
        19,
        json!({"op": "annotate", "note": "Development first.", "arrows": [{"from": "g1", "to": "f3"}]}),
    )
    .await;
    assert_eq!(ack["result"]["applied"]["note"], true, "{ack}");
    let ack = intent(
        &mut a,
        20,
        json!({"op": "set_seats", "white": "ai", "black": "human"}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    let ack = intent(&mut a, 21, json!({"op": "match_stop"})).await;
    assert_eq!(ack["result"]["match"]["active"], false);
    let frame = frame_value(&server.hub);
    assert_eq!(frame["state"]["match"]["active"], false);
    assert_eq!(
        frame["state"]["game"]["nodes"][3]["note"],
        "Development first."
    );

    server.stop().await;
}

#[tokio::test]
async fn an_oversized_message_gets_a_readable_refusal() {
    let server = serve("web").await;
    let (mut a, _) = view(server.port).await;
    let huge = json!({"t": "intent", "id": 7, "tab": "t1", "op": "play", "move": "Z".repeat(200_000),
                      "from_node": 0});
    send(&mut a, huge).await;
    let ack = next_json(&mut a).await;
    assert_eq!(ack["id"], 7, "{ack}");
    assert_eq!(ack["ok"], false);
    assert_eq!(ack["error"]["code"], "bad_input");
    assert!(
        ack["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("the limit is 65536")),
        "{ack}"
    );

    // The socket and the game carry on.
    send(
        &mut a,
        json!({"t": "intent", "id": 8, "tab": "t1", "op": "play", "move": "e4", "from_node": 0}),
    )
    .await;
    assert_eq!(next_json(&mut a).await["rev"], 1);
    assert_eq!(next_json(&mut a).await["ok"], true);

    server.stop().await;
}

// ------------------------------------------------------------------ MCP

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(100);

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// For a request, returns every SSE message up to and including its response.
async fn rpc(
    client: &reqwest::Client,
    port: u16,
    session: Option<&str>,
    body: Value,
    within: Duration,
) -> (reqwest::StatusCode, Option<String>, Vec<Value>) {
    let mut request = client
        .post(format!("http://127.0.0.1:{port}/mcp"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(body.to_string());

    if let Some(session) = session {
        request = request
            .header("mcp-session-id", session)
            .header("mcp-protocol-version", "2025-06-18");
    }

    let mut response = request.send().await.expect("POST /mcp");
    let status = response.status();
    let session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let Some(id) = body.get("id").cloned() else {
        return (status, session_id, Vec::new());
    };

    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + within;

    loop {
        let messages: Vec<Value> = text
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
            .collect();
        if messages.iter().any(|m| m.get("id") == Some(&id)) {
            return (status, session_id, messages);
        }

        let chunk = tokio::time::timeout_at(deadline, response.chunk())
            .await
            .expect("MCP answered in time")
            .expect("readable body");
        match chunk {
            Some(bytes) => text.push_str(&String::from_utf8_lossy(&bytes)),
            None => panic!("stream ended without a response to {id}: {text}"),
        }
    }
}

/// One MCP client session over real HTTP.
#[derive(Clone)]
struct Ai {
    client: reqwest::Client,
    port: u16,
    session: String,
    by: String,
}

impl Ai {
    async fn connect(port: u16, name: &str) -> (Ai, Value) {
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("HTTP client");

        let (status, session, messages) = rpc(
            &client,
            port,
            None,
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": name, "version": "0"}}}),
            WAIT,
        )
        .await;
        assert_eq!(status, 200);

        let ai = Ai {
            client,
            port,
            session: session.expect("a session id"),
            by: format!("ai:{name}"),
        };
        let init = messages.last().cloned().expect("initialize result");

        let (status, _, _) = rpc(
            &ai.client,
            port,
            Some(&ai.session),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            WAIT,
        )
        .await;
        assert_eq!(status, 202);

        (ai, init)
    }

    /// A request; returns its `result` and every message that came before it on the stream.
    async fn request(&self, method: &str, params: Value) -> (Value, Vec<Value>) {
        let id = next_id();
        let (_, _, mut messages) = rpc(
            &self.client,
            self.port,
            Some(&self.session),
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
            Duration::from_secs(30),
        )
        .await;

        let last = messages.pop().expect("a response");
        assert!(last.get("error").is_none(), "{last}");
        (last["result"].clone(), messages)
    }

    async fn call(&self, tool: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name": tool, "arguments": arguments}))
            .await
            .0
    }

    async fn notify(&self, body: Value) {
        let (status, _, _) = rpc(&self.client, self.port, Some(&self.session), body, WAIT).await;
        assert_eq!(status, 202);
    }
}

fn structured(result: &Value) -> &Value {
    &result["structuredContent"]
}

fn prose(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap_or("")
}

/// Polls `check` until it holds, failing the test after [`WAIT`].
async fn until(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn mcp_lists_four_tools_two_prompts_and_the_style_rules() {
    let server = serve("web").await;
    let (ai, init) = Ai::connect(server.port, "lister").await;
    assert_eq!(init["result"]["serverInfo"]["name"], "rukh");
    let instructions = init["result"]["instructions"]
        .as_str()
        .expect("instructions");
    for rule in [
        rukh_core::session::RULE_SILENT,
        rukh_core::session::RULE_ANNOTATE,
        rukh_core::session::RULE_COACH,
    ] {
        assert!(instructions.contains(rule), "{instructions}");
    }
    assert!(
        instructions.contains("read style.name and style.rule in each result"),
        "{instructions}"
    );

    let (list, _) = ai.request("tools/list", json!({})).await;
    let tools = list["tools"].as_array().expect("tool list");
    let mut found: Vec<(String, String)> = tools
        .iter()
        .map(|t| {
            (
                t["name"].as_str().unwrap_or("").to_string(),
                t["description"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    found.sort();
    let mut expected = vec![
        ("get_game", "Read the game on the Rukh board: position, legal moves, seats, the style rule you must follow, and the notes and arrows on the current move. detail=tree returns every move with its variations."),
        ("wait", "Block until it is your turn. To play a game, loop: call wait(seat), then call play, then call wait again. event=timeout is normal and means nobody has moved yet: call wait again. event=game_over or flag means stop and tell the person the result. The result contains the position and style.rule, which you must follow. Use for=any_change with since=<board_rev> to be told about anything the person does (coaching)."),
        ("play", "Play a move for the side you hold, in SAN (Nf3) or UCI (g1f3). Optionally attach a note, a glyph and arrows to the move in the same call; follow style.rule for whether to do so. Choose the move by your own judgement."),
        ("annotate", "Add a note, glyph, arrows or highlights to a move without moving the board. Defaults to the current move. Everyone looking at the board sees it."),
    ]
    .into_iter()
    .map(|(n, d)| (n.to_string(), d.to_string()))
    .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(found, expected);
    let wait = tools.iter().find(|t| t["name"] == "wait").expect("wait");
    let props = &wait["inputSchema"]["properties"];
    for key in ["seat", "for", "since", "timeout_s"] {
        assert!(props[key].is_object(), "{wait}");
    }
    let play = tools.iter().find(|t| t["name"] == "play").expect("play");
    for key in ["move", "from_node", "note", "nag", "arrows", "highlights"] {
        assert!(play["inputSchema"]["properties"][key].is_object(), "{play}");
    }

    let (prompts, _) = ai.request("prompts/list", json!({})).await;
    let mut names: Vec<&str> = prompts["prompts"]
        .as_array()
        .expect("prompt list")
        .iter()
        .filter_map(|p| p["name"].as_str())
        .collect();
    names.sort();
    assert_eq!(names, ["play", "review"]);
    let (prompt, _) = ai
        .request(
            "prompts/get",
            json!({"name": "play", "arguments": {"side": "white"}}),
        )
        .await;
    let text = prompt["messages"][0]["content"]["text"]
        .as_str()
        .expect("prompt text");
    assert!(text.contains("seat=\"white\""), "{text}");
    let (prompt, _) = ai.request("prompts/get", json!({"name": "review"})).await;
    let text = prompt["messages"][0]["content"]["text"]
        .as_str()
        .expect("prompt text");
    assert!(text.contains("for=\"any_change\""), "{text}");

    server.stop().await;
}

#[tokio::test]
async fn an_ai_is_not_woken_by_its_own_move_and_a_move_between_waits_returns_at_once() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "alpha").await;

    // The seat claim starts a match; White (the person) is to move, so the wait times out.
    let started = Instant::now();
    let result = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    let took = started.elapsed();
    assert_eq!(
        *structured(&result),
        json!({"event": "timeout", "board_rev": 0})
    );
    assert!(
        took >= Duration::from_millis(900) && took < Duration::from_secs(3),
        "{took:?}"
    );
    assert!(prose(&result).contains("a match has started"), "{result}");
    let frame = frame_value(&hub);
    assert_eq!(
        frame["state"]["match"],
        json!({"active": true, "seats": {"white": "human", "black": "ai"}, "tip": 0,
               "live": true, "to_move": "human", "style": "annotate", "time_control": null})
    );
    assert_eq!(frame["hint"]["by"], "ai:alpha");

    // The person moves between two waits: the next wait returns at once, no seat needed.
    let ack = intent(
        &mut page,
        1,
        json!({"op": "play", "move": "e4", "from_node": 0}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    let started = Instant::now();
    let result = ai.call("wait", json!({"timeout_s": 5})).await;
    assert!(started.elapsed() < Duration::from_secs(1));
    let event = structured(&result);
    assert_eq!(event["event"], "your_turn", "{result}");
    assert_eq!(event["your_seat"], "black");
    assert_eq!(event["node"], 1);
    assert_eq!(event["to_move"], "ai");
    assert_eq!(event["style"]["name"], "annotate");
    assert_eq!(event["style"]["rule"], rukh_core::session::RULE_ANNOTATE);

    // Level-triggered: asking again before moving is answered again.
    let again = ai.call("wait", json!({"timeout_s": 5})).await;
    assert_eq!(structured(&again)["event"], "your_turn");

    let played = ai
        .call(
            "play",
            json!({"move": "e5", "from_node": 1, "note": "Claiming the centre."}),
        )
        .await;
    assert_ne!(played["isError"], true, "{played}");
    assert_eq!(structured(&played)["node"], 2);
    assert_eq!(structured(&played)["views"], 1);
    assert_eq!(prose(&played), "Played e5 (e7e5). White to move.");

    // Its own move does not wake it.
    let result = ai.call("wait", json!({"timeout_s": 1})).await;
    assert_eq!(structured(&result)["event"], "timeout");

    // A move by the other side does.
    let waiter = ai.clone();
    let pending = tokio::spawn(async move { waiter.call("wait", json!({"timeout_s": 10})).await });
    until("the wait to start", || hub.presence().is_waiting(&ai.by)).await;
    let ack = intent(
        &mut page,
        2,
        json!({"op": "play", "move": "Nf3", "from_node": 2}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    let result = tokio::time::timeout(WAIT, pending)
        .await
        .expect("the wait returned")
        .expect("the task ran");
    assert_eq!(structured(&result)["event"], "your_turn", "{result}");
    assert_eq!(structured(&result)["node"], 3);

    // Out of turn after its move: refused, nothing changes.
    ai.call("play", json!({"move": "Nc6"})).await;
    let rev = hub.latest().rev;
    let refused = ai.call("play", json!({"move": "Nf6"})).await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(prose(&refused).contains("It is not your turn"), "{refused}");
    assert_eq!(hub.latest().rev, rev);

    server.stop().await;
}

#[tokio::test]
async fn browsing_away_from_tip_never_fires_your_turn_and_play_lands_on_the_tip() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "beta").await;

    // White is to move at the start, so claiming White is the AI's turn at once.
    let result = ai
        .call("wait", json!({"seat": "white", "timeout_s": 5}))
        .await;
    assert_eq!(structured(&result)["event"], "your_turn", "{result}");
    let played = ai.call("play", json!({"move": "e4", "from_node": 0})).await;
    assert_ne!(played["isError"], true, "{played}");

    // A hand move from the tip moves the tip.
    let ack = intent(
        &mut page,
        1,
        json!({"op": "play", "move": "e5", "from_node": 1}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    assert_eq!(frame_value(&hub)["state"]["match"]["tip"], 2);

    // The person browses back: not live, no turn for anyone.
    let ack = intent(&mut page, 2, json!({"op": "goto", "node": 1})).await;
    assert_eq!(ack["result"]["live"], false);
    let frame = frame_value(&hub);
    assert_eq!(frame["state"]["match"]["live"], false);
    assert_eq!(frame["state"]["match"]["to_move"], Value::Null);
    let result = ai.call("wait", json!({"timeout_s": 1})).await;
    assert_eq!(structured(&result)["event"], "timeout", "{result}");

    // Returning to the tip wakes the waiting AI.
    let waiter = ai.clone();
    let pending = tokio::spawn(async move { waiter.call("wait", json!({"timeout_s": 10})).await });
    until("the wait to start", || hub.presence().is_waiting(&ai.by)).await;
    let ack = intent(&mut page, 3, json!({"op": "goto", "node": 2})).await;
    assert_eq!(ack["result"]["live"], true);
    let result = tokio::time::timeout(WAIT, pending)
        .await
        .expect("the wait returned")
        .expect("the task ran");
    assert_eq!(structured(&result)["event"], "your_turn", "{result}");

    // Browse back again, then the AI plays: the move goes on the tip, not where the page is.
    let ack = intent(&mut page, 4, json!({"op": "goto", "node": 0})).await;
    assert_eq!(ack["ok"], true);
    let played = ai
        .call("play", json!({"move": "Nf3", "from_node": 2}))
        .await;
    assert_ne!(played["isError"], true, "{played}");
    let node = structured(&played)["node"].as_u64().expect("node");
    let frame = frame_value(&hub);
    let nodes = frame["state"]["game"]["nodes"].as_array().expect("nodes");
    let new = nodes.iter().find(|n| n["id"] == node).expect("new node");
    assert_eq!(new["parent"], 2);
    assert_eq!(frame["state"]["match"]["tip"], node);
    assert_eq!(frame["state"]["game"]["current"], node);

    server.stop().await;
}

#[tokio::test]
async fn an_ai_annotation_between_wait_and_play_refuses_nothing() {
    let server = serve("web").await;
    let (mut page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "gamma").await;
    ai.call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    intent(
        &mut page,
        1,
        json!({"op": "play", "move": "d4", "from_node": 0}),
    )
    .await;
    let seen = ai.call("wait", json!({"timeout_s": 5})).await;
    let seen = structured(&seen).clone();
    assert_eq!(seen["event"], "your_turn");
    let node = seen["node"].clone();

    let annotated = ai
        .call(
            "annotate",
            json!({"node": node, "note": "The queen's pawn.", "nag": "!",
                   "arrows": [{"from": "d7", "to": "d5"}, {"from": "z9", "to": "a1"}],
                   "highlights": [{"square": "d4", "color": "yellow"}]}),
        )
        .await;
    assert_ne!(annotated["isError"], true, "{annotated}");
    let body = structured(&annotated);
    assert_eq!(body["applied"]["arrows"], 1);
    assert_eq!(body["applied"]["note"], true);
    assert_eq!(body["rejected"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        body["board_rev"], seen["board_rev"],
        "AI notes leave board_rev"
    );
    assert!(
        prose(&annotated).contains("1 item was not applied"),
        "{annotated}"
    );

    let played = ai
        .call("play", json!({"move": "d5", "from_node": node}))
        .await;
    assert_ne!(played["isError"], true, "{played}");
    assert_eq!(structured(&played)["san"], "d5");

    // A stale from_node is refused with a readable message.
    intent(
        &mut page,
        2,
        json!({"op": "play", "move": "c4", "from_node": 2}),
    )
    .await;
    let stale = ai.call("play", json!({"move": "e6", "from_node": 1})).await;
    assert_eq!(stale["isError"], true, "{stale}");
    assert!(prose(&stale).contains("The board has moved on"), "{stale}");

    server.stop().await;
}

#[tokio::test]
async fn a_coach_is_not_woken_by_its_own_annotation_but_another_client_is() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let (coach, _) = Ai::connect(server.port, "coach").await;
    let (other, _) = Ai::connect(server.port, "other").await;

    let c = coach.clone();
    let coach_wait = tokio::spawn(async move {
        c.call("wait", json!({"for": "any_change", "timeout_s": 2}))
            .await
    });
    let o = other.clone();
    let other_wait = tokio::spawn(async move {
        o.call("wait", json!({"for": "any_change", "timeout_s": 10}))
            .await
    });
    until("both waits to start", || {
        hub.presence().is_waiting(&coach.by) && hub.presence().is_waiting(&other.by)
    })
    .await;
    let annotated = coach
        .call("annotate", json!({"note": "The start position."}))
        .await;
    assert_ne!(annotated["isError"], true, "{annotated}");

    let other_result = tokio::time::timeout(WAIT, other_wait)
        .await
        .expect("returned")
        .expect("ran");
    let event = structured(&other_result);
    assert_eq!(event["event"], "changed", "{other_result}");
    assert_eq!(event["since_last"][0]["by"], "ai:coach");
    assert_eq!(event["since_last"][0]["reason"], "annotate");
    assert_eq!(event["note"], "The start position.");

    let coach_result = tokio::time::timeout(WAIT, coach_wait)
        .await
        .expect("returned")
        .expect("ran");
    assert_eq!(
        structured(&coach_result)["event"],
        "timeout",
        "{coach_result}"
    );

    // A move by the person, made before the coach asks, is reported at once with since.
    let board_rev = hub.read(|t| t.board_rev());
    intent(
        &mut page,
        1,
        json!({"op": "play", "move": "e4", "from_node": 0}),
    )
    .await;
    let started = Instant::now();
    let result = coach
        .call(
            "wait",
            json!({"for": "any_change", "since": board_rev, "timeout_s": 5}),
        )
        .await;
    assert!(started.elapsed() < Duration::from_secs(1));
    let event = structured(&result);
    assert_eq!(event["event"], "changed", "{result}");
    assert_eq!(event["since_last"][0]["san"], "e4");
    assert_eq!(
        event["since_last"][0]["by"]
            .as_str()
            .map(|b| b.starts_with("view:")),
        Some(true)
    );

    server.stop().await;
}

#[tokio::test]
async fn get_game_and_wait_without_a_seat() {
    let server = serve("web").await;
    let (ai, _) = Ai::connect(server.port, "reader").await;
    let result = ai.call("get_game", json!({})).await;
    let body = structured(&result);
    assert_eq!(body["fen"], INITIAL_FEN);
    assert_eq!(body["style"]["name"], "annotate");
    assert_eq!(body["views"], 0);
    assert!(
        prose(&result).contains("No board is open; ask the person to open http://127.0.0.1:"),
        "{result}"
    );
    assert!(body.get("nodes").is_none());
    let tree = ai.call("get_game", json!({"detail": "tree"})).await;
    assert_eq!(structured(&tree)["nodes"].as_array().map(Vec::len), Some(1));

    let refused = ai.call("wait", json!({"timeout_s": 1})).await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(prose(&refused).contains("seat=\"white\""), "{refused}");
    assert_eq!(server.hub.latest().rev, 0);

    server.stop().await;
}

#[tokio::test]
async fn presence_shows_a_waiting_client_and_bumps_no_rev() {
    let server = serve("web").await;
    let (mut page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "watcher").await;
    let waiter = ai.clone();
    let pending = tokio::spawn(async move {
        waiter
            .call("wait", json!({"for": "any_change", "timeout_s": 2}))
            .await
    });
    let entry = loop {
        let message = next_any(&mut page).await;
        assert_ne!(
            message["t"], "state",
            "presence must not send a frame: {message}"
        );
        if message["t"] == "presence" {
            if let Some(entry) = message["ais"]
                .as_array()
                .and_then(|ais| ais.iter().find(|a| a["waiting"] == true))
            {
                assert_eq!(message["views"], 1);
                break entry.clone();
            }
        }
    };
    assert_eq!(entry["name"], "watcher");
    assert_eq!(entry["transport"], "http");
    assert_eq!(entry["seat"], Value::Null);
    assert!(entry["idle_s"].is_u64(), "{entry}");
    assert_eq!(server.hub.latest().rev, 0);

    let result = tokio::time::timeout(WAIT, pending)
        .await
        .expect("returned")
        .expect("ran");
    assert_eq!(structured(&result)["event"], "timeout");

    // When the wait ends, the page hears that too.
    loop {
        let message = next_any(&mut page).await;
        assert_ne!(message["t"], "state", "{message}");
        if message["t"] == "presence" && message["ais"][0]["waiting"] == false {
            break;
        }
    }
    assert_eq!(server.hub.latest().rev, 0);

    server.stop().await;
}

#[tokio::test]
async fn a_foreign_origin_is_refused_on_a_long_wait() {
    let server = serve("web").await;
    let port = server.port;
    let (ai, _) = Ai::connect(port, "victim").await;
    let body = json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                      "params": {"name": "wait", "arguments": {"for": "any_change", "timeout_s": 240}}})
    .to_string();
    for bad in [
        ("Origin", "http://evil.example".to_string()),
        ("Host", "evil.example".to_string()),
    ] {
        let headers = vec![
            ("Content-Type", "application/json".to_string()),
            ("Accept", "application/json, text/event-stream".to_string()),
            ("mcp-session-id", ai.session.clone()),
            ("mcp-protocol-version", "2025-06-18".to_string()),
            bad.clone(),
        ];
        let started = Instant::now();
        let (status, _, text) = raw(port, "POST", "/mcp", &headers, &body).await;
        assert_eq!(status, 403, "{bad:?}: {text}");
        assert!(text.contains("Rukh only answers"), "{text}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    assert!(!server.hub.presence().is_waiting("ai:victim"));

    server.stop().await;
}

#[tokio::test]
async fn cancelling_a_wait_frees_it() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "canceller").await;
    let id = next_id();
    let waiter = ai.clone();
    let pending = tokio::spawn(async move {
        rpc(
            &waiter.client,
            waiter.port,
            Some(&waiter.session),
            json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
                   "params": {"name": "wait", "arguments": {"for": "any_change", "timeout_s": 60}}}),
            Duration::from_secs(60),
        )
        .await
    });
    until("the wait to start", || hub.presence().is_waiting(&ai.by)).await;
    ai.notify(
        json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
                     "params": {"requestId": id, "reason": "the test cancelled it"}}),
    )
    .await;
    let started = Instant::now();
    until("the wait to end", || !hub.presence().is_waiting(&ai.by)).await;
    assert!(started.elapsed() < Duration::from_secs(5));
    pending.abort();

    server.stop().await;
}

#[tokio::test]
async fn a_long_wait_reports_progress_when_asked() {
    let server = serve("web").await;
    let (ai, _) = Ai::connect(server.port, "patient").await;
    let (result, before) = ai
        .request(
            "tools/call",
            json!({"name": "wait", "arguments": {"for": "any_change", "timeout_s": 2},
                   "_meta": {"progressToken": "p-1"}}),
        )
        .await;
    assert_eq!(structured(&result)["event"], "timeout");
    let progress: Vec<&Value> = before
        .iter()
        .filter(|m| m["method"] == "notifications/progress")
        .collect();
    assert!(!progress.is_empty(), "{before:?}");
    assert_eq!(progress[0]["params"]["progressToken"], "p-1");

    server.stop().await;
}

#[tokio::test]
async fn a_seat_the_person_gave_the_ai_cannot_be_swapped_by_wait() {
    let server = serve("web").await;
    let (mut page, _) = view(server.port).await;
    let ack = intent(
        &mut page,
        1,
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    )
    .await;
    assert_eq!(ack["ok"], true);
    let (ai, _) = Ai::connect(server.port, "delta").await;
    let refused = ai
        .call("wait", json!({"seat": "white", "timeout_s": 1}))
        .await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(prose(&refused).contains("seat=\"black\""), "{refused}");
    let ok = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(structured(&ok)["event"], "timeout", "{ok}");

    server.stop().await;
}

// ------------------------------------------------------------------ the person ends a match

/// Starts a wait for Black in the background once the AI holds Black, and returns it.
async fn pending_black_wait(hub: &std::sync::Arc<Hub>, ai: &Ai) -> tokio::task::JoinHandle<Value> {
    let waiter = ai.clone();
    let pending = tokio::spawn(async move { waiter.call("wait", json!({"timeout_s": 20})).await });
    until("the wait to start", || hub.presence().is_waiting(&ai.by)).await;
    pending
}

/// A control during an open wait ends it with game_over; the next wait(seat) does not undo it.
async fn a_control_ends_the_loop(control: Value, stopped: &str, refusal: &str) {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, &format!("looper-{stopped}")).await;
    let first = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(structured(&first)["event"], "timeout", "{first}");
    let pending = pending_black_wait(&hub, &ai).await;
    let started = Instant::now();
    let ack = intent(&mut page, 1, control.clone()).await;
    assert_eq!(ack["ok"], true, "{ack}");
    let result = tokio::time::timeout(WAIT, pending)
        .await
        .expect("the wait returned")
        .expect("the task ran");
    assert!(started.elapsed() < Duration::from_secs(5));
    let event = structured(&result);
    assert_eq!(event["event"], "game_over", "{result}");
    assert_eq!(event["stopped"], stopped, "{result}");
    assert!(prose(&result).starts_with("The person"), "{result}");
    assert!(prose(&result).contains("press Start"), "{result}");
    assert!(!prose(&result).contains("call wait"), "{result}");

    let rev = hub.latest().rev;
    let again = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(again["isError"], true, "{again}");
    assert!(prose(&again).contains(refusal), "{again}");
    assert_eq!(hub.latest().rev, rev, "the refused claim changed nothing");

    // The seat shown in presence went with the match.
    let presence: Value = serde_json::from_str(&hub.presence().message()).expect("presence");
    assert_eq!(presence["ais"][0]["seat"], Value::Null, "{presence}");

    server.stop().await;
}

#[tokio::test]
async fn stop_during_a_wait_ends_the_ais_loop() {
    a_control_ends_the_loop(
        json!({"op": "match_stop"}),
        "match_stop",
        "stopped the match",
    )
    .await;
}

#[tokio::test]
async fn a_new_game_during_a_wait_ends_the_ais_loop() {
    a_control_ends_the_loop(json!({"op": "new_game"}), "new_game", "new game").await;
}

#[tokio::test]
async fn opponent_nobody_during_a_wait_ends_the_ais_loop() {
    a_control_ends_the_loop(
        json!({"op": "set_seats", "white": "human", "black": "human"}),
        "seats",
        "played by a person",
    )
    .await;
}

// ------------------------------------------------------------------ evaluations

#[tokio::test]
async fn set_eval_while_waits_are_open_wakes_nobody_and_refuses_nothing() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let (player, _) = Ai::connect(server.port, "eval-player").await;
    let (coach, _) = Ai::connect(server.port, "eval-coach").await;
    player
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    intent(
        &mut page,
        1,
        json!({"op": "play", "move": "e4", "from_node": 0}),
    )
    .await;
    let seen = player.call("wait", json!({"timeout_s": 5})).await;
    assert_eq!(structured(&seen)["event"], "your_turn");
    let node = structured(&seen)["node"].clone();
    let board_rev = structured(&seen)["board_rev"].clone();

    let c = coach.clone();
    let since = board_rev.clone();
    let coach_wait = tokio::spawn(async move {
        c.call(
            "wait",
            json!({"for": "any_change", "since": since, "timeout_s": 2}),
        )
        .await
    });
    until("the coach to wait", || hub.presence().is_waiting(&coach.by)).await;

    // An engine result lands between "saw the position" and "played".
    let rev = hub.latest().rev;
    let ack = intent(
        &mut page,
        2,
        json!({"op": "set_eval", "node": node, "eval": {"cp": 30, "depth": 14}}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    assert_eq!(hub.latest().rev, rev + 1);
    assert_eq!(hub.read(|t| t.board_rev()), board_rev.as_u64().unwrap_or(0));

    let coach_result = tokio::time::timeout(WAIT, coach_wait)
        .await
        .expect("returned")
        .expect("ran");
    assert_eq!(
        structured(&coach_result)["event"],
        "timeout",
        "{coach_result}"
    );
    let played = player
        .call("play", json!({"move": "e5", "from_node": node}))
        .await;
    assert_ne!(played["isError"], true, "{played}");

    server.stop().await;
}

// ------------------------------------------------------------------ results a model reads

#[tokio::test]
async fn results_carry_the_json_in_content_and_the_prose_in_structured() {
    let server = serve("web").await;
    let (ai, _) = Ai::connect(server.port, "half-reader").await;
    let result = ai
        .call("wait", json!({"seat": "white", "timeout_s": 5}))
        .await;
    let body = structured(&result);
    assert_eq!(body["event"], "your_turn");
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|m| m.contains("a match has started") && m.contains("from_node=0")),
        "{result}"
    );
    let json_block: Value = serde_json::from_str(
        result["content"][1]["text"]
            .as_str()
            .expect("a second text block"),
    )
    .expect("the second block is JSON");
    assert_eq!(json_block["legal_moves"].as_array().map(Vec::len), Some(20));
    assert_eq!(json_block["node"], 0);
    let timeout = ai.call("wait", json!({"timeout_s": 1})).await;
    let json_block: Value =
        serde_json::from_str(timeout["content"][1]["text"].as_str().unwrap_or(""))
            .unwrap_or_default();
    assert_eq!(json_block, *structured(&timeout));

    server.stop().await;
}

#[tokio::test]
async fn tool_schemas_are_plain() {
    let server = serve("web").await;
    let (ai, _) = Ai::connect(server.port, "schema-reader").await;
    let (list, _) = ai.request("tools/list", json!({})).await;
    let text = list.to_string();
    for banned in ["$defs", "$ref", "anyOf", "\"null\"", "uint", "$schema"] {
        assert!(!text.contains(banned), "{banned} in {text}");
    }
    let tools = list["tools"].as_array().expect("tools");
    let wait = tools.iter().find(|t| t["name"] == "wait").expect("wait");
    let props = &wait["inputSchema"]["properties"];
    assert_eq!(props["seat"]["enum"], json!(["white", "black"]));
    assert_eq!(props["for"]["enum"], json!(["my_turn", "any_change"]));
    assert_eq!(props["since"]["type"], "integer");
    let play = tools.iter().find(|t| t["name"] == "play").expect("play");
    let arrow = &play["inputSchema"]["properties"]["arrows"]["items"];
    assert_eq!(arrow["type"], "object", "{play}");
    assert_eq!(arrow["description"], "An arrow from one square to another.");
    assert_eq!(play["inputSchema"]["required"], json!(["move"]));

    server.stop().await;
}

// ------------------------------------------------------------------ who is who

#[tokio::test]
async fn a_client_is_listed_as_soon_as_it_connects() {
    let server = serve("web").await;
    let (_ai, _) = Ai::connect(server.port, "early-bird").await;
    let presence: Value = serde_json::from_str(&server.hub.presence().message()).expect("presence");
    assert_eq!(presence["ais"][0]["name"], "early-bird", "{presence}");

    server.stop().await;
}

#[tokio::test]
async fn a_coach_with_the_same_name_as_the_player_is_told_about_its_moves() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let (player, _) = Ai::connect(server.port, "twin").await;
    let (coach, _) = Ai::connect(server.port, "twin").await;
    player
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    intent(
        &mut page,
        1,
        json!({"op": "play", "move": "e4", "from_node": 0}),
    )
    .await;
    let since = hub.read(|t| t.board_rev());
    let c = coach.clone();
    let coach_wait = tokio::spawn(async move {
        c.call(
            "wait",
            json!({"for": "any_change", "since": since, "seat": "black", "timeout_s": 10}),
        )
        .await
    });
    until("the coach to wait", || {
        let presence: Value = serde_json::from_str(&hub.presence().message()).unwrap_or_default();
        presence["ais"].as_array().is_some_and(|ais| {
            ais.iter()
                .any(|a| a["name"] == "twin (2)" && a["waiting"] == true)
        })
    })
    .await;
    let played = player.call("play", json!({"move": "e5"})).await;
    assert_ne!(played["isError"], true, "{played}");
    let result = tokio::time::timeout(WAIT, coach_wait)
        .await
        .expect("returned")
        .expect("ran");
    let event = structured(&result);
    assert_eq!(event["event"], "changed", "{result}");
    assert_eq!(event["since_last"][0]["san"], "e5");

    // Passing seat with any_change took nothing, and the coach holds no seat.
    assert_eq!(event["your_seat"], Value::Null, "{result}");
    assert_eq!(
        hub.read(|t| t.match_state().seats.white),
        rukh_core::Seat::Human
    );
    assert!(prose(&result).contains("played e5"), "{result}");

    // The person moves; the coach may not move for the player's seat.
    intent(
        &mut page,
        2,
        json!({"op": "play", "move": "Nf3", "from_node": 2}),
    )
    .await;
    let refused = coach.call("play", json!({"move": "Nc6"})).await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(prose(&refused).contains("is played by twin"), "{refused}");

    server.stop().await;
}

#[tokio::test]
async fn a_play_without_from_node_is_guarded_by_the_last_your_turn() {
    let server = serve("web").await;
    let (mut page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "forgetful").await;
    ai.call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    intent(
        &mut page,
        1,
        json!({"op": "play", "move": "e4", "from_node": 0}),
    )
    .await;
    let turn = ai.call("wait", json!({"timeout_s": 5})).await;
    assert_eq!(structured(&turn)["node"], 1);

    // The person plays a move for each side by hand while the AI thinks.
    intent(
        &mut page,
        2,
        json!({"op": "play", "move": "e5", "from_node": 1}),
    )
    .await;
    intent(
        &mut page,
        3,
        json!({"op": "play", "move": "Qh5", "from_node": 2}),
    )
    .await;
    let refused = ai.call("play", json!({"move": "Nf6"})).await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(
        prose(&refused).contains("The board has moved on"),
        "{refused}"
    );

    // After reading the position again it can play.
    let turn = ai.call("wait", json!({"timeout_s": 5})).await;
    assert_eq!(structured(&turn)["node"], 3);
    let played = ai.call("play", json!({"move": "Nc6"})).await;
    assert_ne!(played["isError"], true, "{played}");

    server.stop().await;
}

// ------------------------------------------------------------------ rematch, seats, identity

#[tokio::test]
async fn after_the_ai_mates_a_new_game_lets_it_play_again() {
    let server = serve("web").await;
    let (mut page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "rematcher").await;
    ai.call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    let mut id = 0;
    for (person, reply) in [("f3", "e5"), ("g4", "Qh4#")] {
        id += 1;
        let ack = intent(&mut page, id, json!({"op": "play", "move": person})).await;
        assert_eq!(ack["ok"], true, "{ack}");
        let turn = ai.call("wait", json!({"timeout_s": 5})).await;
        assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
        let played = ai.call("play", json!({"move": reply})).await;
        assert_ne!(played["isError"], true, "{played}");
    }

    let over = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(structured(&over)["event"], "game_over", "{over}");
    assert_eq!(structured(&over)["stopped"], Value::Null, "{over}");
    let text = prose(&over);
    assert!(text.contains("0-1, checkmate"), "{over}");
    assert!(
        text.contains("call wait with seat=\"black\" again"),
        "{over}"
    );
    assert!(!text.contains("press Start"), "{over}");

    let ack = intent(&mut page, 10, json!({"op": "new_game"})).await;
    assert_eq!(ack["ok"], true, "{ack}");
    let again = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_ne!(again["isError"], true, "{again}");
    assert!(
        prose(&again).starts_with("You play Black; a match has started"),
        "{again}"
    );
    assert!(server.hub.read(|t| t.match_state().active));

    server.stop().await;
}

#[tokio::test]
async fn swapping_sides_mid_match_tells_the_ai_its_new_seat() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "swapper").await;
    ai.call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    let pending = pending_black_wait(&hub, &ai).await;
    let ack = intent(
        &mut page,
        1,
        json!({"op": "set_seats", "white": "ai", "black": "human"}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    let result = tokio::time::timeout(WAIT, pending)
        .await
        .expect("the wait returned")
        .expect("the task ran");
    assert_ne!(result["isError"], true, "{result}");
    assert_eq!(structured(&result)["event"], "seat_changed", "{result}");
    assert_eq!(structured(&result)["seat"], "white", "{result}");
    assert!(
        prose(&result).contains("call wait with seat=\"white\""),
        "{result}"
    );
    assert!(!prose(&result).contains("Stop"), "{result}");

    let old_seat = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_ne!(old_seat["isError"], true, "{old_seat}");
    assert_eq!(structured(&old_seat)["event"], "seat_changed", "{old_seat}");

    let turn = ai
        .call("wait", json!({"seat": "white", "timeout_s": 5}))
        .await;
    assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
    let presence: Value = serde_json::from_str(&hub.presence().message()).expect("presence");
    assert_eq!(presence["ais"][0]["seat"], "white", "{presence}");

    server.stop().await;
}

#[tokio::test]
async fn a_refused_play_or_a_fresh_read_replaces_the_implied_from_node() {
    let server = serve("web").await;
    let (mut page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "rereader").await;
    ai.call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    intent(&mut page, 1, json!({"op": "play", "move": "e4"})).await;
    let turn = ai.call("wait", json!({"timeout_s": 5})).await;
    assert_eq!(structured(&turn)["node"], 1, "{turn}");
    intent(&mut page, 2, json!({"op": "play", "move": "e5"})).await;
    intent(&mut page, 3, json!({"op": "play", "move": "Qh5"})).await;
    let refused = ai.call("play", json!({"move": "Nf6"})).await;
    assert_eq!(refused["isError"], true, "{refused}");

    // The refusal let go of node 1, so the next move is played at the tip.
    let played = ai.call("play", json!({"move": "Nc6"})).await;
    assert_ne!(played["isError"], true, "{played}");

    intent(&mut page, 4, json!({"op": "play", "move": "Bc4"})).await;
    let turn = ai.call("wait", json!({"timeout_s": 5})).await;
    assert_eq!(structured(&turn)["node"], 5, "{turn}");
    intent(&mut page, 5, json!({"op": "play", "move": "a6"})).await;
    intent(&mut page, 6, json!({"op": "play", "move": "d3"})).await;
    let read = ai.call("get_game", json!({})).await;
    assert_eq!(structured(&read)["node"], 7, "{read}");
    let played = ai.call("play", json!({"move": "b5"})).await;
    assert_ne!(played["isError"], true, "{played}");

    let stale = ai
        .call("play", json!({"move": "Nf3", "from_node": 0}))
        .await;
    assert_eq!(stale["isError"], true, "{stale}");

    server.stop().await;
}

/// The `by` of every recent change made on node `node` by an AI.
fn ai_changes_on(hub: &Hub, node: u64) -> Vec<String> {
    let frame = frame_value(hub);
    frame["state"]["recent"]
        .as_array()
        .map(|recent| {
            recent
                .iter()
                .filter(|c| c["node"] == node)
                .filter_map(|c| c["by"].as_str())
                .filter(|by| by.starts_with("ai:"))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_second_session_with_the_same_name_never_takes_over_the_first() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (first, _) = Ai::connect(server.port, "same").await;
    first.call("get_game", json!({})).await;
    hub.presence()
        .tick_at(Instant::now() + Duration::from_secs(100));
    let presence: Value = serde_json::from_str(&hub.presence().message()).expect("presence");
    assert_eq!(presence["ais"], json!([]), "{presence}");

    let (second, _) = Ai::connect(server.port, "same").await;
    second
        .call("annotate", json!({"node": 0, "note": "from the second"}))
        .await;
    first
        .call("annotate", json!({"node": 0, "note": "from the first"}))
        .await;
    let by = ai_changes_on(&hub, 0);
    assert_eq!(by.len(), 2, "{by:?}");
    assert_ne!(by[0], by[1], "{by:?}");

    let presence: Value = serde_json::from_str(&hub.presence().message()).expect("presence");
    let names: Vec<&str> = presence["ais"]
        .as_array()
        .map(|ais| ais.iter().filter_map(|a| a["name"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(names, ["same", "same (2)"], "{presence}");

    server.stop().await;
}

#[tokio::test]
async fn a_client_that_quits_while_it_owes_a_move_expires() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let (quitter, _) = Ai::connect(server.port, "quitter").await;
    quitter
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    intent(&mut page, 1, json!({"op": "play", "move": "e4"})).await;
    let ais = |hub: &Hub| -> Value {
        let presence: Value = serde_json::from_str(&hub.presence().message()).expect("presence");
        presence["ais"].clone()
    };

    hub.presence()
        .tick_at(Instant::now() + Duration::from_secs(120));
    assert_eq!(ais(&hub)[0]["seat"], "black", "a thinking client stays");
    hub.presence()
        .tick_at(Instant::now() + Duration::from_secs(301));
    assert_eq!(ais(&hub), json!([]));
    assert!(
        hub.read(|t| t.match_state().active),
        "the match is left alone"
    );

    quitter.call("get_game", json!({})).await;
    assert_eq!(ais(&hub)[0]["name"], "quitter");
    assert_eq!(ais(&hub)[0]["seat"], "black", "the same session resumes");

    hub.presence()
        .tick_at(Instant::now() + Duration::from_secs(301));
    let (fresh, _) = Ai::connect(server.port, "quitter").await;
    let turn = fresh
        .call("wait", json!({"seat": "black", "timeout_s": 5}))
        .await;
    assert_ne!(turn["isError"], true, "{turn}");
    assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
    let played = fresh.call("play", json!({"move": "e5"})).await;
    assert_ne!(played["isError"], true, "{played}");

    server.stop().await;
}

#[test]
fn client_names_are_cleaned_for_people() {
    use crate::presence::clean_name;

    assert_eq!(clean_name("claude-code"), "claude-code");
    assert_eq!(clean_name("a\u{0}b\u{7}c\u{1b}[31md"), "abc[31md");
    assert_eq!(clean_name("\u{202E}evil\u{200B} name"), "evil name");
    assert_eq!(clean_name("  two   words  "), "two words");

    assert_eq!(clean_name(&"x".repeat(200)).chars().count(), 64);
    assert_eq!(clean_name(&"\u{e9}".repeat(100)), "\u{e9}".repeat(64));

    assert_eq!(clean_name(""), "AI client");
    assert_eq!(clean_name("   "), "AI client");
    assert_eq!(clean_name("\u{200B}\u{7}\u{FEFF}"), "AI client");

    let html = "<img src=x onerror=alert(1)>&amp;";
    assert_eq!(clean_name(html), html);
}
