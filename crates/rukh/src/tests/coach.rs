//! The coach folder and the import routes, each test on its own temp folder with invented players.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use rukh_coach::defaults::{PERSONA, SOUL};
use rukh_coach::game::{game_text, GameRecord};
use rukh_coach::profile::{default_profile, profile_text};

use super::*;
use crate::coach::routes::TEXT_LIMIT;

const MATE: [&str; 14] = [
    "e4", "e5", "Nf3", "Nc6", "Bc4", "Nd4", "Nxe5", "Qg5", "Nxf7", "Qxg2", "Rf1", "Qxe4+", "Be2",
    "Nf3#",
];

const QUIET: [&str; 12] = [
    "d4", "d5", "c4", "e6", "Nc3", "Nf6", "Bg5", "Be7", "e3", "O-O", "Nf3", "Nbd7",
];

static NEXT_FOLDER: AtomicU64 = AtomicU64::new(0);

/// A fresh folder under the system temp folder, removed when the test ends.
struct TempFolder {
    path: PathBuf,
}

impl TempFolder {
    fn new(name: &str) -> TempFolder {
        let n = NEXT_FOLDER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "rukh-coach-{name}-{}-{n}-{}",
            std::process::id(),
            crate::hub::now_ms()
        ));

        fs::create_dir_all(&path).expect("make the test folder");
        TempFolder { path }
    }

    fn coach(&self) -> PathBuf {
        self.path.join("coach")
    }

    fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.coach().join(relative))
            .unwrap_or_else(|e| panic!("read coach/{relative}: {e}"))
    }

    fn json(&self, relative: &str) -> Value {
        serde_json::from_str(&self.read(relative)).expect("a JSON file")
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.coach().join(relative);
        fs::create_dir_all(path.parent().expect("a parent")).expect("make the folder");
        fs::write(path, text).expect("write the test file");
    }

    fn names(&self, relative: &str) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.coach().join(relative))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();

        names.sort();
        names
    }

    /// Every path under the folder, relative and with forward slashes, folders included.
    fn tree(&self) -> Vec<String> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };

            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                let shown = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");

                if path.is_dir() {
                    out.push(format!("{shown}/"));
                    walk(root, &path, out);
                } else {
                    out.push(shown);
                }
            }
        }

        let mut out = Vec::new();
        walk(&self.path, &self.path, &mut out);
        out.sort();
        out
    }

    fn snapshot(&self) -> Vec<(String, Vec<u8>)> {
        self.tree()
            .into_iter()
            .filter(|p| !p.ends_with('/'))
            .map(|p| {
                let bytes = fs::read(self.path.join(&p)).unwrap_or_default();
                (p, bytes)
            })
            .collect()
    }
}

impl Drop for TempFolder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

async fn serve_in(dir: &Path) -> Running {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind a test port");

    start(listener, testdata("web"), Some(dir.to_path_buf()))
        .await
        .expect("start the test server")
}

/// One request written by hand with a body of raw bytes.
async fn send(
    port: u16,
    path: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");

    let mut head = format!("POST {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("host")) {
        head.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    let framed = headers.iter().any(|(n, _)| {
        n.eq_ignore_ascii_case("content-length") || n.eq_ignore_ascii_case("transfer-encoding")
    });
    if !framed {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");

    stream.write_all(head.as_bytes()).await.expect("send head");
    let _ = stream.write_all(body).await;

    let mut response = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let text = String::from_utf8_lossy(&response).to_string();
        if let Some((head, body)) = text.split_once("\r\n\r\n") {
            let length = head
                .to_ascii_lowercase()
                .lines()
                .find_map(|l| l.strip_prefix("content-length:").map(str::to_string))
                .and_then(|v| v.trim().parse::<usize>().ok());
            if length.is_some_and(|n| body.len() >= n) {
                break;
            }
        }

        match tokio::time::timeout(Duration::from_secs(120), stream.read(&mut buf)).await {
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

fn text_headers() -> Vec<(&'static str, String)> {
    vec![
        ("X-Rukh", "1".to_string()),
        ("Content-Type", "text/plain; charset=utf-8".to_string()),
    ]
}

fn json_headers() -> Vec<(&'static str, String)> {
    vec![
        ("X-Rukh", "1".to_string()),
        ("Content-Type", "application/json".to_string()),
    ]
}

async fn import(port: u16, text: &[u8]) -> (u16, Value) {
    let (status, _, body) = send(port, "/api/coach/import/text", &text_headers(), text).await;
    (status, serde_json::from_str(&body).expect("a JSON answer"))
}

async fn post_json(port: u16, path: &str, body: Value) -> (u16, Value) {
    let (status, _, text) = send(port, path, &json_headers(), body.to_string().as_bytes()).await;
    (status, serde_json::from_str(&text).expect("a JSON answer"))
}

fn clock(ms: u64, tenths: bool) -> String {
    let (h, m, s) = (ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60);
    if tenths {
        format!("{h}:{m:02}:{s:02}.{}", (ms % 1000) / 100)
    } else {
        format!("{h}:{m:02}:{s:02}")
    }
}

/// Move text with a clock after every move, written as the site writes it.
fn movetext(sans: &[&str], tenths: bool, result: &str) -> String {
    let mut out = Vec::new();
    let mut left = [180_000u64, 180_000u64];

    for (i, san) in sans.iter().enumerate() {
        let side = i % 2;
        left[side] = left[side].saturating_sub(1_300 * (i as u64 % 5)) + 2_000;
        let number = i / 2 + 1;

        let mark = if side == 0 {
            format!("{number}.")
        } else {
            format!("{number}...")
        };
        let comment = if tenths {
            format!("{{[%clk {}]}}", clock(left[side], true))
        } else {
            format!("{{ [%clk {}] }}", clock(left[side], false))
        };
        out.push(format!("{mark} {san} {comment}"));
    }

    out.push(result.to_string());
    out.join(" ")
}

fn utc_time(i: usize) -> String {
    format!("{:02}:{:02}:{:02}", (i / 3600) % 24, (i / 60) % 60, i % 60)
}

struct Shape<'a> {
    white: &'a str,
    black: &'a str,
    sans: &'a [&'a str],
    result: &'a str,
    termination: &'a str,
    second: usize,
}

fn lichess(shape: &Shape) -> String {
    format!(
        "[Event \"Rated blitz game\"]\n[Site \"https://lichess.org/AbCd{:04}\"]\n[Date \"2026.10.12\"]\n\
         [White \"{}\"]\n[Black \"{}\"]\n[Result \"{}\"]\n[GameId \"AbCd{:04}\"]\n\
         [UTCDate \"2026.10.12\"]\n[UTCTime \"{}\"]\n[WhiteElo \"1510\"]\n[BlackElo \"1488\"]\n\
         [Variant \"Standard\"]\n[TimeControl \"180+2\"]\n[ECO \"C50\"]\n[Termination \"{}\"]\n\n{}\n\n\n",
        shape.second % 10_000,
        shape.white,
        shape.black,
        shape.result,
        shape.second % 10_000,
        utc_time(shape.second),
        shape.termination,
        movetext(shape.sans, false, shape.result)
    )
}

fn chess_com(shape: &Shape) -> String {
    let text = format!(
        "[Event \"Live Chess\"]\n[Site \"Chess.com\"]\n[Date \"2026.10.12\"]\n[Round \"-\"]\n\
         [White \"{}\"]\n[Black \"{}\"]\n[Result \"{}\"]\n[Timezone \"UTC\"]\n[ECO \"C50\"]\n\
         [UTCDate \"2026.10.12\"]\n[UTCTime \"{}\"]\n[WhiteElo \"1502\"]\n[BlackElo \"1490\"]\n\
         [TimeControl \"180+2\"]\n[Termination \"{}\"]\n[StartTime \"{}\"]\n\
         [Link \"https://www.chess.com/game/live/{}\"]\n\n{}\n\n",
        shape.white,
        shape.black,
        shape.result,
        utc_time(shape.second),
        shape.termination,
        utc_time(shape.second),
        900_000 + shape.second,
        movetext(shape.sans, true, shape.result)
    );
    text.replace('\n', "\r\n")
}

fn mate(second: usize) -> Shape<'static> {
    Shape {
        white: "Maren Holt",
        black: "quill_fox",
        sans: &MATE,
        result: "0-1",
        termination: "Normal",
        second,
    }
}

fn quiet(second: usize) -> Shape<'static> {
    Shape {
        white: "Maren Holt",
        black: "quill_fox",
        sans: &QUIET,
        result: "1-0",
        termination: "Normal",
        second,
    }
}

fn games_text(n: usize) -> String {
    (0..n).map(|i| lichess(&quiet(i))).collect()
}

fn game_files(folder: &TempFolder) -> Vec<String> {
    folder
        .names("games")
        .into_iter()
        .filter(|n| n.ends_with(".json"))
        .collect()
}

fn skipped(variant: u32, short: u32, long: u32, unreadable: u32, unfinished: u32) -> Value {
    json!({"variant": variant, "too_short": short, "too_long": long, "unreadable": unreadable, "unfinished": unfinished})
}

// ------------------------------------------------------------------ import

#[tokio::test]
async fn an_import_stores_its_games_and_answers_the_counts() {
    let folder = TempFolder::new("import");
    let server = serve_in(&folder.path).await;

    let text = format!("{}{}", lichess(&mate(1)), lichess(&quiet(2)));
    let (status, answer) = import(server.port, text.as_bytes()).await;

    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        answer,
        json!({
            "batch": "b0001", "added": 2, "already_here": 0, "already_here_undated": 0,
            "skipped": skipped(0, 0, 0, 0, 0), "skipped_total": 0, "set_up": 0,
            "side_unknown": 2,
            "choose": [{"name": "Maren Holt", "games": 2}, {"name": "quill_fox", "games": 2}]
        })
    );

    assert_eq!(game_files(&folder), vec!["g0001.json", "g0002.json"]);
    assert_eq!(folder.read("imports/b0001/part-001.pgn"), text);
    assert_eq!(
        folder.read("state.json"),
        "{\"v\":1,\"next_game\":3,\"next_batch\":2}\n"
    );

    let first = folder.json("games/g0001.json");
    assert_eq!(first["kind"], "imported");
    assert_eq!(first["reason"], "checkmate");
    assert_eq!(first["result"], "0-1");
    assert_eq!(first["plies"], 14);
    assert_eq!(first["started"], "2026-10-12T00:00:01Z");
    assert_eq!(first["source"]["site_key"], "lichess:AbCd0001");
    assert_eq!(first["source"]["verified"], false);
    assert_eq!(first["source"]["batch"], "b0001");
    assert_eq!(first["you"], Value::Null);
    assert_eq!(first["moves"][0]["clk"], 182_000);

    let second = folder.json("games/g0002.json");
    assert_eq!(second["reason"], "resign");
    let raw = second["source"]["raw"].clone();
    let (start, end) = (
        raw["start"].as_u64().expect("start") as usize,
        raw["end"].as_u64().expect("end") as usize,
    );
    assert!(text[start..end].starts_with("[Event"), "{raw}");
    assert!(text[start..end].ends_with("1-0"), "{raw}");

    let batch = folder.json("imports/b0001/batch.json");
    assert_eq!(batch["added"], json!(["g0001", "g0002"]));
    assert_eq!(batch["undone"], Value::Null);
    assert_eq!(
        batch["parts"],
        json!([{"name": "part-001.pgn", "bytes": text.len()}])
    );

    let keys = folder.json("derived/keys.json");
    assert_eq!(keys["covers_below"], 3);
    assert_eq!(keys["moves"].as_object().map(|m| m.len()), Some(2));

    server.stop().await;
}

#[tokio::test]
async fn the_coach_folder_is_made_on_first_use_with_its_defaults() {
    let folder = TempFolder::new("defaults");
    let server = serve_in(&folder.path).await;
    assert!(!folder.coach().exists(), "nothing before the first use");

    let (status, answer) = import(server.port, b"no games in here").await;
    assert_eq!(status, 422, "{answer}");
    assert_eq!(answer["error"]["code"], "no_games");
    assert!(
        !folder.coach().exists(),
        "a refusal before the store is opened writes nothing"
    );

    let (status, _) = import(server.port, lichess(&quiet(1)).as_bytes()).await;
    assert_eq!(status, 200);

    assert_eq!(folder.read("persona.md"), PERSONA);
    assert_eq!(folder.read("soul.md"), SOUL);
    assert_eq!(
        folder.read("profile.json"),
        profile_text(&default_profile())
    );

    server.stop().await;
}

#[tokio::test]
async fn a_game_file_round_trips_byte_for_byte() {
    let folder = TempFolder::new("round");
    let server = serve_in(&folder.path).await;

    import(server.port, chess_com(&mate(5)).as_bytes()).await;
    let written = folder.read("games/g0001.json");

    let value: Value = serde_json::from_str(&written).expect("json");
    assert_eq!(game_text(&value), written);

    let record: GameRecord = serde_json::from_str(&written).expect("a game record");
    assert_eq!(record.to_text(), written);

    server.stop().await;
}

#[tokio::test]
async fn the_same_text_twice_adds_nothing_and_says_already_here() {
    let folder = TempFolder::new("twice");
    let server = serve_in(&folder.path).await;
    let text = games_text(3);

    let (_, first) = import(server.port, text.as_bytes()).await;
    assert_eq!(first["added"], 3);
    let before = folder.snapshot();

    let (status, again) = import(server.port, text.as_bytes()).await;
    assert_eq!(status, 200);
    assert_eq!(again["batch"], Value::Null);
    assert_eq!(again["added"], 0);
    assert_eq!(again["already_here"], 3);

    assert_eq!(folder.snapshot(), before, "nothing on disk changed");
    assert_eq!(folder.names("imports"), vec!["b0001"]);

    server.stop().await;
}

#[tokio::test]
async fn two_exports_of_one_game_count_once() {
    let folder = TempFolder::new("exports");
    let server = serve_in(&folder.path).await;

    let mut other = mate(7);
    other.white = "MAREN HOLT";
    other.black = "Quill_Fox";
    other.termination = "quill_fox won by checkmate";

    let text = format!("{}{}", lichess(&mate(7)), chess_com(&other));
    let (_, answer) = import(server.port, text.as_bytes()).await;

    assert_eq!(answer["added"], 1);
    assert_eq!(answer["already_here"], 1);
    assert_eq!(game_files(&folder), vec!["g0001.json"]);

    let (_, again) = import(server.port, chess_com(&other).as_bytes()).await;
    assert_eq!(again["added"], 0);
    assert_eq!(again["already_here"], 1);

    server.stop().await;
}

#[tokio::test]
async fn a_pasted_site_id_does_not_stop_a_different_game() {
    let folder = TempFolder::new("site-id");
    let server = serve_in(&folder.path).await;

    import(server.port, lichess(&quiet(3)).as_bytes()).await;

    let mut stranger = mate(3);
    stranger.white = "Odo Brask";
    let (_, answer) = import(server.port, lichess(&stranger).as_bytes()).await;

    assert_eq!(answer["added"], 1);
    assert_eq!(answer["already_here"], 0);
    assert_eq!(
        folder.json("games/g0002.json")["source"]["site_key"],
        "lichess:AbCd0003"
    );

    let keys = folder.json("derived/keys.json");
    assert_eq!(keys["sites"]["lichess:AbCd0003"], json!(["g0001", "g0002"]));

    server.stop().await;
}

#[tokio::test]
async fn skipped_games_are_counted_by_reason() {
    let folder = TempFolder::new("skipped");
    let server = serve_in(&folder.path).await;

    let shuffle: Vec<&str> = ["Nf3", "Nf6", "Ng1", "Ng8"]
        .iter()
        .cycle()
        .take(601)
        .copied()
        .collect();
    let long = Shape {
        sans: &shuffle,
        result: "1/2-1/2",
        ..quiet(10)
    };
    let short = Shape {
        sans: &QUIET[..9],
        ..quiet(11)
    };
    let unfinished = Shape {
        result: "*",
        ..quiet(12)
    };
    let illegal = Shape {
        sans: &[
            "e4", "e5", "Ke3", "Nc6", "Nf3", "Nf6", "Bc4", "Bc5", "d3", "d6", "c3",
        ],
        ..quiet(13)
    };
    let atomic = lichess(&quiet(14)).replace("[Variant \"Standard\"]", "[Variant \"Atomic\"]");
    let after_d4 = Shape {
        sans: &QUIET[1..],
        ..quiet(15)
    };
    let chess960_set_up = lichess(&after_d4).replace(
        "[Variant \"Standard\"]",
        "[Variant \"Chess960\"]\n[SetUp \"1\"]\n[FEN \"rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1\"]",
    );
    let set_up = Shape {
        sans: &[
            "e5", "Nf3", "Nc6", "Bc4", "Nf6", "Nc3", "Bc5", "d3", "d6", "O-O",
        ],
        ..quiet(16)
    };
    let set_up = lichess(&set_up).replace(
        "[Variant \"Standard\"]",
        "[Variant \"From Position\"]\n[SetUp \"1\"]\n[FEN \"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1\"]",
    );

    let pawns = Shape {
        sans: &["a3", "a6", "b3", "b6", "c3", "c6", "d3", "d6", "e3", "e6"],
        ..quiet(18)
    };
    let chess960 = lichess(&pawns).replace(
        "[Variant \"Standard\"]",
        "[Variant \"Chess960\"]\n[FEN \"rkbbnnqr/pppppppp/8/8/8/8/PPPPPPPP/RKBBNNQR w KQkq - 0 1\"]",
    );

    let text = [
        lichess(&long),
        lichess(&short),
        lichess(&unfinished),
        lichess(&illegal),
        atomic,
        chess960_set_up,
        set_up,
        lichess(&quiet(17)),
        chess960,
    ]
    .concat();

    let (status, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 3, "{answer}");
    assert_eq!(answer["set_up"], 1);
    assert_eq!(answer["skipped"], skipped(2, 1, 1, 1, 1));
    assert_eq!(answer["skipped_total"], 6);

    let chess960 = folder.json("games/g0003.json");
    assert_eq!(chess960["variant"], "chess960");
    assert_eq!(chess960["from_position"], false);

    let set_up = folder.json("games/g0001.json");
    assert_eq!(set_up["from_position"], true);
    assert_eq!(
        set_up["start_fen"],
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    );
    assert_eq!(
        folder.json("imports/b0001/batch.json")["skipped"],
        skipped(2, 1, 1, 1, 1)
    );

    server.stop().await;
}

// ------------------------------------------------------------------ a kill part way

/// Leaves the folder as a kill after game `kept` would have left it.
fn roll_back_to(folder: &TempFolder, kept: usize, keys: Option<&str>) {
    for name in game_files(folder) {
        let number: usize = name[1..5].parse().expect("a game number");
        if number > kept {
            fs::remove_file(folder.coach().join("games").join(&name)).expect("remove");
        }
    }

    fs::remove_file(folder.coach().join("imports/b0001/batch.json")).expect("remove");
    folder.write("state.json", "{\"v\":1,\"next_game\":1,\"next_batch\":1}\n");

    match keys {
        Some(text) => folder.write("derived/keys.json", text),
        None => fs::remove_file(folder.coach().join("derived/keys.json")).expect("remove"),
    }
}

fn move_keys(folder: &TempFolder) -> Vec<String> {
    game_files(folder)
        .iter()
        .map(|name| {
            folder.json(&format!("games/{name}"))["move_key"]
                .as_str()
                .expect("a move key")
                .to_string()
        })
        .collect()
}

#[tokio::test]
async fn a_kill_after_game_k_of_n_then_the_same_import_loses_and_doubles_nothing() {
    for keys in [
        Some("{\"v\":1,\"covers_below\":1,\"moves\":{},\"sites\":{}}\n"),
        None,
    ] {
        let folder = TempFolder::new("kill");
        let text = games_text(6);

        let server = serve_in(&folder.path).await;
        import(server.port, text.as_bytes()).await;
        server.stop().await;

        roll_back_to(&folder, 3, keys);
        assert_eq!(game_files(&folder).len(), 3);

        let server = serve_in(&folder.path).await;
        let (status, answer) = import(server.port, text.as_bytes()).await;
        assert_eq!(status, 200, "{answer}");
        assert_eq!(answer["batch"], "b0002");
        assert_eq!(answer["added"], 3);
        assert_eq!(answer["already_here"], 3);

        assert_eq!(
            game_files(&folder),
            vec![
                "g0001.json",
                "g0002.json",
                "g0003.json",
                "g0004.json",
                "g0005.json",
                "g0006.json"
            ]
        );
        let mut keys_seen = move_keys(&folder);
        keys_seen.sort();
        keys_seen.dedup();
        assert_eq!(keys_seen.len(), 6, "no game twice");

        assert_eq!(
            folder.read("state.json"),
            "{\"v\":1,\"next_game\":7,\"next_batch\":3}\n"
        );
        assert_eq!(
            folder.json("derived/keys.json")["moves"]
                .as_object()
                .map(|m| m.len()),
            Some(6)
        );
        server.stop().await;
    }
}

#[tokio::test]
async fn a_kill_after_the_raw_part_only_then_the_same_import_stores_every_game() {
    let folder = TempFolder::new("raw-only");
    let text = games_text(4);

    let server = serve_in(&folder.path).await;
    import(server.port, text.as_bytes()).await;
    server.stop().await;

    roll_back_to(
        &folder,
        0,
        Some("{\"v\":1,\"covers_below\":1,\"moves\":{},\"sites\":{}}\n"),
    );
    assert_eq!(folder.names("imports/b0001"), vec!["part-001.pgn"]);

    let server = serve_in(&folder.path).await;
    let (_, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(answer["batch"], "b0002");
    assert_eq!(answer["added"], 4);
    assert_eq!(answer["already_here"], 0);

    assert_eq!(game_files(&folder).len(), 4);
    assert_eq!(
        folder.read("state.json"),
        "{\"v\":1,\"next_game\":5,\"next_batch\":3}\n"
    );
    assert_eq!(
        folder.read("imports/b0001/part-001.pgn"),
        text,
        "the first part stays"
    );

    server.stop().await;
}

#[tokio::test]
async fn the_counter_is_raised_to_the_highest_id_on_disk() {
    let folder = TempFolder::new("counter");
    folder.write("games/g0042.json", "not a game");
    folder.write("removed/b0007/g0050.json", "{}");
    folder.write("imports/b0009/part-001.pgn", "");

    let server = serve_in(&folder.path).await;
    let (_, answer) = import(server.port, lichess(&quiet(1)).as_bytes()).await;

    assert_eq!(answer["batch"], "b0010");
    assert_eq!(game_files(&folder), vec!["g0042.json", "g0051.json"]);
    assert_eq!(
        folder.read("games/g0042.json"),
        "not a game",
        "never touched"
    );

    server.stop().await;
}

#[tokio::test]
async fn a_missing_or_damaged_keys_index_is_rebuilt_from_the_game_files() {
    for damage in [None, Some("{ not json")] {
        let folder = TempFolder::new("keys");
        let text = games_text(2);

        let server = serve_in(&folder.path).await;
        import(server.port, text.as_bytes()).await;
        server.stop().await;

        let built = folder.read("derived/keys.json");
        match damage {
            None => fs::remove_file(folder.coach().join("derived/keys.json")).expect("remove"),
            Some(text) => folder.write("derived/keys.json", text),
        }

        let server = serve_in(&folder.path).await;
        let (_, answer) = import(server.port, text.as_bytes()).await;
        assert_eq!(answer["already_here"], 2);
        assert_eq!(folder.read("derived/keys.json"), built);

        if damage.is_some() {
            let broken = folder.names("broken");
            assert_eq!(broken.len(), 1, "{broken:?}");
            assert!(broken[0].starts_with("derived-keys.json."), "{broken:?}");
        }
        server.stop().await;
    }
}

// ------------------------------------------------------------------ undo

#[tokio::test]
async fn undo_moves_the_games_aside_and_an_import_again_brings_them_back() {
    let folder = TempFolder::new("undo");
    let server = serve_in(&folder.path).await;
    let text = games_text(3);

    import(server.port, text.as_bytes()).await;
    let first = folder.read("games/g0002.json");

    let (status, undone) = post_json(
        server.port,
        "/api/coach/import/undo",
        json!({"batch": "b0001"}),
    )
    .await;
    assert_eq!(status, 200, "{undone}");
    assert_eq!(
        undone,
        json!({"batch": "b0001", "moved": 3, "already_undone": false})
    );

    assert!(game_files(&folder).is_empty());
    assert_eq!(
        folder.names("removed/b0001"),
        vec!["g0001.json", "g0002.json", "g0003.json"]
    );
    assert_eq!(
        folder.read("removed/b0001/g0002.json"),
        first,
        "moved whole"
    );
    assert_eq!(
        folder.read("imports/b0001/part-001.pgn"),
        text,
        "the raw text stays"
    );
    let batch = folder.json("imports/b0001/batch.json");
    assert_eq!(batch["undone"]["moved"], json!(["g0001", "g0002", "g0003"]));
    assert_eq!(folder.json("derived/keys.json")["moves"], json!({}));

    let (_, again) = post_json(
        server.port,
        "/api/coach/import/undo",
        json!({"batch": "b0001"}),
    )
    .await;
    assert_eq!(
        again,
        json!({"batch": "b0001", "moved": 0, "already_undone": true})
    );

    let (_, back) = import(server.port, text.as_bytes()).await;
    assert_eq!(back["batch"], "b0002");
    assert_eq!(back["added"], 3);
    assert_eq!(
        game_files(&folder),
        vec!["g0004.json", "g0005.json", "g0006.json"]
    );
    assert_eq!(
        folder.names("removed/b0001").len(),
        3,
        "the removed copies stay"
    );

    for bad in ["b0099", "../games", "b0001/..", ""] {
        let (status, answer) =
            post_json(server.port, "/api/coach/import/undo", json!({"batch": bad})).await;
        assert_eq!(status, 404, "{bad}: {answer}");
        assert_eq!(answer["error"]["code"], "unknown_batch");
    }

    server.stop().await;
}

// ------------------------------------------------------------------ names

#[tokio::test]
async fn names_are_cleaned_and_never_reach_a_file_name_or_path() {
    let folder = TempFolder::new("names");
    let server = serve_in(&folder.path).await;

    let hostile = "<b>Ma\u{202E}ren</b>\u{200B}\u{0007}/../..";
    let game = Shape {
        white: hostile,
        black: "q\u{2066}uill\u{FEFF}_fox",
        ..quiet(4)
    };
    let (_, answer) = import(server.port, lichess(&game).as_bytes()).await;
    assert_eq!(
        answer["choose"],
        json!([{"name": "<b>Maren</b>/../..", "games": 1}, {"name": "quill_fox", "games": 1}])
    );

    let file = folder.json("games/g0001.json");
    assert_eq!(file["white"]["name"], "<b>Maren</b>/../..");
    assert_eq!(file["black"]["name"], "quill_fox");

    let raw = folder.read("games/g0001.json");
    for hidden in ['\u{202E}', '\u{200B}', '\u{0007}', '\u{2066}', '\u{FEFF}'] {
        assert!(!raw.contains(hidden), "{hidden:?}");
    }

    for path in folder.tree() {
        assert!(
            !path.contains("Maren") && !path.contains("quill") && !path.contains('<'),
            "{path}"
        );
    }

    server.stop().await;
}

#[tokio::test]
async fn a_termination_naming_a_player_is_matched_and_the_name_not_kept() {
    let folder = TempFolder::new("termination");
    let server = serve_in(&folder.path).await;

    let game = Shape {
        black: "resign_now",
        termination: "resign_now won by checkmate",
        ..mate(6)
    };
    import(server.port, chess_com(&game).as_bytes()).await;

    let raw = folder.read("games/g0001.json");
    let file: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(file["reason"], "checkmate");
    assert!(!raw.contains("won by"), "{raw}");
    assert!(!raw.contains("Termination"), "{raw}");

    server.stop().await;
}

#[tokio::test]
async fn my_names_give_stored_games_their_side() {
    let folder = TempFolder::new("my-names");
    let server = serve_in(&folder.path).await;

    let swapped = Shape {
        white: "quill_fox",
        black: "Maren Holt",
        ..quiet(9)
    };
    let stranger = Shape {
        white: "Odo Brask",
        black: "Pell Varn",
        ..quiet(10)
    };
    let text = [lichess(&mate(8)), lichess(&swapped), lichess(&stranger)].concat();

    let (_, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(answer["side_unknown"], 3);
    assert_eq!(
        answer["choose"],
        json!([
            {"name": "Maren Holt", "games": 2}, {"name": "quill_fox", "games": 2},
            {"name": "Odo Brask", "games": 1}, {"name": "Pell Varn", "games": 1}
        ])
    );

    let (status, named) = post_json(
        server.port,
        "/api/coach/names",
        json!({"names": ["maren HOLT"]}),
    )
    .await;
    assert_eq!(status, 200, "{named}");
    assert_eq!(
        named,
        json!({"names": ["maren HOLT"], "given_side": 2, "cleared_side": 0})
    );

    let first = folder.json("games/g0001.json");
    assert_eq!(first["you"], "white");
    assert_eq!(first["you_rating"], 1510);
    assert_eq!(
        first["opponent"],
        json!({"type": "person", "name": "quill_fox", "rating": 1488})
    );
    assert_eq!(folder.json("games/g0002.json")["you"], "black");
    assert_eq!(folder.json("games/g0003.json")["you"], Value::Null);
    assert_eq!(
        folder.json("profile.json")["my_names"],
        json!(["maren HOLT"])
    );

    let (_, again) = post_json(
        server.port,
        "/api/coach/names",
        json!({"names": ["Maren Holt"]}),
    )
    .await;
    assert_eq!(
        again,
        json!({"names": ["maren HOLT"], "given_side": 0, "cleared_side": 0})
    );

    let (_, next) = import(server.port, lichess(&quiet(11)).as_bytes()).await;
    assert_eq!(next["side_unknown"], 0);
    assert_eq!(next["choose"], json!([]));
    assert_eq!(folder.json("games/g0004.json")["you"], "white");

    for bad in [
        json!({"names": []}),
        json!({"names": ["\u{200B}"]}),
        json!({"name": "x"}),
        json!([1]),
    ] {
        let (status, answer) = post_json(server.port, "/api/coach/names", bad.clone()).await;
        assert_eq!(status, 400, "{bad}: {answer}");
        assert_eq!(answer["error"]["code"], "bad_input");
    }

    server.stop().await;
}

// ------------------------------------------------------------------ refusals

#[tokio::test]
async fn a_body_over_the_limit_is_refused_without_being_read() {
    let folder = TempFolder::new("limit");
    let server = serve_in(&folder.path).await;

    let mut headers = text_headers();
    headers.push(("Content-Length", (TEXT_LIMIT + 1).to_string()));
    let started = Instant::now();
    let (status, _, body) = send(server.port, "/api/coach/import/text", &headers, b"").await;

    assert_eq!(status, 413, "{body}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "answered before any body arrived"
    );
    let answer: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(
        answer,
        json!({"error": {"code": "too_big", "message": "That is too big for one import (32 MB)."}})
    );

    let big = json!({"names": ["x".repeat(70 * 1024)]}).to_string();
    let (status, _, body) = send(
        server.port,
        "/api/coach/names",
        &json_headers(),
        big.as_bytes(),
    )
    .await;
    assert_eq!(status, 413, "{body}");

    let mut chunked = json_headers();
    chunked.push(("Transfer-Encoding", "chunked".to_string()));
    let mut stream_body = Vec::new();
    for _ in 0..80 {
        stream_body.extend_from_slice(b"400\r\n");
        stream_body.extend_from_slice(&[b' '; 1024]);
        stream_body.extend_from_slice(b"\r\n");
    }
    stream_body.extend_from_slice(b"0\r\n\r\n");
    let (status, _, body) = send(server.port, "/api/coach/names", &chunked, &stream_body).await;
    assert_eq!(
        status, 413,
        "a body with no length is cut at the limit: {body}"
    );

    assert!(!folder.coach().exists());
    server.stop().await;
}

#[tokio::test]
async fn a_missing_header_a_foreign_origin_or_a_wrong_type_is_refused_and_writes_nothing() {
    let folder = TempFolder::new("refused");
    let server = serve_in(&folder.path).await;
    let port = server.port;
    let body = lichess(&quiet(1));

    let routes = [
        ("/api/coach/import/text", "text/plain", body.clone()),
        (
            "/api/coach/import/undo",
            "application/json",
            "{\"batch\":\"b0001\"}".to_string(),
        ),
        (
            "/api/coach/names",
            "application/json",
            "{\"names\":[\"Maren Holt\"]}".to_string(),
        ),
    ];

    for (path, kind, body) in &routes {
        let no_header = vec![("Content-Type", kind.to_string())];
        let (status, _, text) = send(port, path, &no_header, body.as_bytes()).await;
        assert_eq!(status, 403, "{path}: {text}");
        assert!(text.contains("no_rukh_header"), "{text}");

        let twice = vec![
            ("X-Rukh", "1".to_string()),
            ("X-Rukh", "1".to_string()),
            ("Content-Type", kind.to_string()),
        ];
        let (status, _, _) = send(port, path, &twice, body.as_bytes()).await;
        assert_eq!(status, 403, "{path}");

        let wrong_value = vec![
            ("X-Rukh", "yes".to_string()),
            ("Content-Type", kind.to_string()),
        ];
        let (status, _, _) = send(port, path, &wrong_value, body.as_bytes()).await;
        assert_eq!(status, 403, "{path}");

        for wrong in [
            "application/x-www-form-urlencoded",
            "multipart/form-data",
            "text/html",
            "",
        ] {
            let headers = vec![
                ("X-Rukh", "1".to_string()),
                ("Content-Type", wrong.to_string()),
            ];
            let (status, _, text) = send(port, path, &headers, body.as_bytes()).await;
            assert_eq!(status, 415, "{path} as {wrong}: {text}");
            assert!(text.contains("wrong_content_type"), "{text}");
        }

        let mut foreign = vec![
            ("X-Rukh", "1".to_string()),
            ("Content-Type", kind.to_string()),
        ];
        foreign.push(("Origin", "http://evil.example".to_string()));
        let (status, head, text) = send(port, path, &foreign, body.as_bytes()).await;
        assert_eq!(status, 403, "{path}: {text}");
        assert!(
            text.contains("Rukh only answers"),
            "the guard refused it: {text}"
        );
        assert!(head.contains("x-content-type-options: nosniff"), "{head}");

        let mut host = vec![
            ("X-Rukh", "1".to_string()),
            ("Content-Type", kind.to_string()),
        ];
        host.push(("Host", format!("evil.example:{port}")));
        let (status, _, text) = send(port, path, &host, body.as_bytes()).await;
        assert_eq!(status, 403, "{path}: {text}");
        assert!(text.contains("Rukh only answers"), "{text}");
    }

    let (status, _, _) = raw(port, "GET", "/api/coach/import/text", &[], "").await;
    assert_eq!(status, 405);

    for path in folder.tree() {
        assert!(path.starts_with("boards/") || path == ".lock", "{path}");
    }

    server.stop().await;
}

#[tokio::test]
async fn with_no_data_folder_every_coach_route_refuses_and_nothing_is_written() {
    let server = serve("web").await;
    let hub = server.hub.clone();

    let (status, answer) = import(server.port, lichess(&quiet(1)).as_bytes()).await;
    assert_eq!(status, 503);
    assert_eq!(answer["error"]["code"], "no_data_folder");

    let (status, answer) =
        post_json(server.port, "/api/coach/names", json!({"names": ["Maren"]})).await;
    assert_eq!(status, 503);
    assert_eq!(answer["error"]["code"], "no_data_folder");

    let (status, answer) = post_json(
        server.port,
        "/api/coach/import/undo",
        json!({"batch": "b0001"}),
    )
    .await;
    assert_eq!(status, 503);
    assert_eq!(answer["error"]["code"], "no_data_folder");

    assert_eq!(hub.write_counts(), (0, 0));
    server.stop().await;
}

#[tokio::test]
async fn a_second_program_on_the_same_folder_stores_nothing() {
    let folder = TempFolder::new("second");
    let first = serve_in(&folder.path).await;
    let second = serve_in(&folder.path).await;

    let (status, answer) = import(second.port, lichess(&quiet(1)).as_bytes()).await;
    assert_eq!(status, 503, "{answer}");
    assert_eq!(
        answer["error"],
        json!({"code": "second_program", "message": format!(
            "Another Rukh (on port {}) is using this data folder, so games are not stored here.",
            first.port
        )})
    );

    let (status, _) = post_json(second.port, "/api/coach/names", json!({"names": ["Maren"]})).await;
    assert_eq!(status, 503);

    assert!(!folder.coach().exists());

    second.stop().await;
    first.stop().await;
}

// ------------------------------------------------------------------ the hub lock and size

#[tokio::test]
async fn no_coach_file_is_written_under_the_hub_lock_and_an_import_never_waits_on_it() {
    let folder = TempFolder::new("hub-lock");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    import(server.port, lichess(&mate(50)).as_bytes()).await;

    let (writes, _) = hub.write_counts();
    import(server.port, games_text(3).as_bytes()).await;
    let (after, locked) = hub.write_counts();
    assert_eq!(
        after - writes,
        7,
        "the raw text, three games, the counter, the keys, the batch"
    );
    assert_eq!(locked, 0);

    let (inside, entered) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let held = Arc::new(AtomicBool::new(true));
    let holder = {
        let hub = hub.clone();
        let held = held.clone();
        std::thread::spawn(move || {
            hub.read_desk(|_| {
                let _ = inside.send(());
                let _ = released.recv_timeout(Duration::from_secs(60));
            });
            held.store(false, Ordering::SeqCst);
        })
    };
    entered.recv().expect("the holder took the lock");

    let (status, answer) = import(server.port, lichess(&mate(40)).as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 1);
    assert!(
        held.load(Ordering::SeqCst),
        "the import finished while the hub lock was held elsewhere"
    );

    let _ = release.send(());
    holder.join().expect("the holder thread");
    server.stop().await;
}

#[tokio::test]
#[ignore = "writes 2,000 files at once; see docs/testing.md"]
async fn two_thousand_games_import_and_every_file_parses() {
    let folder = TempFolder::new("thousands");
    let server = serve_in(&folder.path).await;

    let text: String = (0..2000)
        .map(|i| {
            if i % 2 == 0 {
                lichess(&mate(i))
            } else {
                chess_com(&quiet(i))
            }
        })
        .collect();

    let started = Instant::now();
    let (status, answer) = import(server.port, text.as_bytes()).await;
    let took = started.elapsed();
    println!(
        "2000 games, {} bytes, imported in {:.2} s",
        text.len(),
        took.as_secs_f64()
    );

    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 2000);
    assert!(took < Duration::from_secs(300), "{took:?}");

    let files = game_files(&folder);
    assert_eq!(files.len(), 2000);
    for name in &files {
        let text = folder.read(&format!("games/{name}"));
        let record: GameRecord = serde_json::from_str(&text).expect("a game record");
        assert_eq!(format!("{}.json", record.id), *name);
        assert_eq!(record.to_text(), text);
    }

    server.stop().await;
}

// ------------------------------------------------------------------ damage, counters and limits

async fn undo_batch(port: u16, batch: &str) -> (u16, Value) {
    post_json(port, "/api/coach/import/undo", json!({"batch": batch})).await
}

fn notice_codes(answer: &Value) -> Vec<String> {
    answer["notices"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|n| n["code"].as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn coach_files(folder: &TempFolder) -> Vec<(String, Vec<u8>)> {
    folder
        .snapshot()
        .into_iter()
        .filter(|(path, _)| path.starts_with("coach/"))
        .collect()
}

#[tokio::test]
async fn counters_past_the_highest_id_are_set_aside_and_no_stored_game_is_replaced() {
    for state in [
        "{\"v\":1,\"next_game\":18446744073709551615,\"next_batch\":2}\n",
        "{\"v\":1,\"next_game\":1000000000000,\"next_batch\":2}\n",
        "{\"v\":1,\"next_game\":4,\"next_batch\":18446744073709551615}\n",
    ] {
        let folder = TempFolder::new("counters");

        let server = serve_in(&folder.path).await;
        import(server.port, games_text(3).as_bytes()).await;
        server.stop().await;

        let stored: Vec<String> = game_files(&folder)
            .iter()
            .map(|name| folder.read(&format!("games/{name}")))
            .collect();
        folder.write("state.json", state);

        let server = serve_in(&folder.path).await;
        let text: String = (10..13).map(|i| lichess(&mate(i))).collect();
        let (status, answer) = import(server.port, text.as_bytes()).await;
        assert_eq!(status, 200, "{state}: {answer}");
        assert_eq!(answer["added"], 3, "{state}");
        assert_eq!(answer["batch"], "b0002", "{state}");
        assert_eq!(notice_codes(&answer), ["set_aside"], "{state}");

        assert_eq!(
            game_files(&folder),
            [
                "g0001.json",
                "g0002.json",
                "g0003.json",
                "g0004.json",
                "g0005.json",
                "g0006.json"
            ]
        );
        for (i, before) in stored.iter().enumerate() {
            assert_eq!(&folder.read(&format!("games/g000{}.json", i + 1)), before);
        }
        assert_eq!(
            folder.read("state.json"),
            "{\"v\":1,\"next_game\":7,\"next_batch\":3}\n"
        );
        server.stop().await;

        let server = serve_in(&folder.path).await;
        let (_, again) = import(server.port, text.as_bytes()).await;
        assert_eq!(again["added"], 0, "{state}: {again}");
        assert_eq!(again["already_here"], 3);
        server.stop().await;
    }
}

#[tokio::test]
async fn a_file_already_at_a_game_path_is_never_replaced() {
    let folder = TempFolder::new("in-the-way");
    let server = serve_in(&folder.path).await;

    import(server.port, lichess(&quiet(1)).as_bytes()).await;
    folder.write("games/g0002.json", "a file someone put here");

    let (status, answer) = import(server.port, games_text(3).as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 2);

    assert_eq!(folder.read("games/g0002.json"), "a file someone put here");
    assert_eq!(
        game_files(&folder),
        ["g0001.json", "g0002.json", "g0003.json", "g0004.json"]
    );

    server.stop().await;
}

#[tokio::test]
async fn a_game_file_missing_from_the_index_is_found_at_start() {
    let folder = TempFolder::new("unindexed");
    let text = games_text(2);

    let server = serve_in(&folder.path).await;
    import(server.port, text.as_bytes()).await;
    undo_batch(server.port, "b0001").await;
    server.stop().await;

    fs::rename(
        folder.coach().join("removed/b0001/g0001.json"),
        folder.coach().join("games/g0001.json"),
    )
    .expect("move a game back by hand");

    let server = serve_in(&folder.path).await;
    let (_, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(answer["added"], 1, "{answer}");
    assert_eq!(answer["already_here"], 1);

    let mut keys = move_keys(&folder);
    let files = keys.len();
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), files, "no game twice");

    server.stop().await;
}

#[tokio::test]
async fn damaged_files_are_set_aside_and_named_in_the_answer() {
    for (relative, damage) in [
        ("profile.json", "{ not json"),
        ("profile.json", "{\"v\": 0}"),
        ("state.json", "[]"),
    ] {
        let folder = TempFolder::new("damaged");

        let server = serve_in(&folder.path).await;
        import(server.port, lichess(&quiet(1)).as_bytes()).await;
        server.stop().await;

        folder.write(relative, damage);

        let server = serve_in(&folder.path).await;
        let (status, answer) = import(server.port, games_text(2).as_bytes()).await;
        assert_eq!(status, 200, "{relative}: {answer}");

        let broken = folder.names("broken");
        assert_eq!(broken.len(), 1, "{broken:?}");
        assert!(broken[0].starts_with(&format!("{relative}.")), "{broken:?}");
        assert_eq!(folder.read(&format!("broken/{}", broken[0])), damage);

        let notices = &answer["notices"];
        assert_eq!(notices[0]["code"], "set_aside", "{answer}");
        assert_eq!(
            notices[0]["message"],
            format!(
                "coach/{relative} could not be read. It was moved to coach/broken/{}.",
                broken[0]
            )
        );

        let (_, later) = import(server.port, lichess(&mate(30)).as_bytes()).await;
        assert!(later.get("notices").is_none(), "said once: {later}");
        server.stop().await;
    }
}

#[tokio::test]
async fn a_damaged_batch_record_is_set_aside_and_its_games_still_undo() {
    let folder = TempFolder::new("batch-record");
    let server = serve_in(&folder.path).await;

    import(server.port, games_text(2).as_bytes()).await;
    folder.write("imports/b0001/batch.json", "{ torn");

    let (status, answer) = undo_batch(server.port, "b0001").await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["moved"], 2);
    assert_eq!(notice_codes(&answer), ["set_aside"]);

    let broken = folder.names("broken");
    assert!(
        broken[0].starts_with("imports-b0001-batch.json."),
        "{broken:?}"
    );
    assert_eq!(
        folder.json("imports/b0001/batch.json")["undone"]["moved"],
        json!(["g0001", "g0002"])
    );

    server.stop().await;
}

#[tokio::test]
async fn a_folder_written_by_a_newer_rukh_is_left_untouched() {
    for relative in ["profile.json", "state.json", "derived/keys.json"] {
        let folder = TempFolder::new("newer");

        let server = serve_in(&folder.path).await;
        import(server.port, lichess(&quiet(1)).as_bytes()).await;
        server.stop().await;

        let mut newer = folder.json(relative);
        newer["v"] = json!(2);
        folder.write(relative, &newer.to_string());
        folder.write("games/g0005.json.tmp-77", "{");

        let before = coach_files(&folder);
        let server = serve_in(&folder.path).await;

        let (status, answer) = import(server.port, games_text(3).as_bytes()).await;
        assert_eq!(status, 409, "{relative}: {answer}");
        assert_eq!(answer["error"]["code"], "newer_version");
        assert_eq!(
            answer["error"]["message"],
            format!(
                "coach/{relative} was written by a newer Rukh (version 2), so nothing is stored here."
            )
        );

        let (status, _) = post_json(server.port, "/api/coach/names", json!({"names": ["x"]})).await;
        assert_eq!(status, 409);

        assert_eq!(coach_files(&folder), before, "{relative}");
        server.stop().await;
    }
}

#[tokio::test]
async fn temp_files_left_by_a_kill_are_set_aside_and_their_ids_never_reused() {
    let folder = TempFolder::new("temp-files");

    let server = serve_in(&folder.path).await;
    import(server.port, lichess(&quiet(1)).as_bytes()).await;
    server.stop().await;

    folder.write("games/g0009.json.tmp-4242", "{\"half\":");
    folder.write("imports/b0001/batch.json.tmp-4242", "{");

    let server = serve_in(&folder.path).await;
    let (_, answer) = import(server.port, lichess(&mate(2)).as_bytes()).await;
    assert_eq!(notice_codes(&answer), ["temp_files"], "{answer}");

    assert_eq!(
        folder.names("broken"),
        ["batch.json.tmp-4242", "g0009.json.tmp-4242"]
    );
    assert_eq!(game_files(&folder), ["g0001.json", "g0010.json"]);
    assert_eq!(
        folder.names("imports/b0001"),
        ["batch.json", "part-001.pgn"]
    );

    server.stop().await;
}

#[tokio::test]
async fn undo_with_no_coach_folder_makes_nothing() {
    let folder = TempFolder::new("undo-fresh");
    let server = serve_in(&folder.path).await;

    let (status, answer) = undo_batch(server.port, "b0001").await;
    assert_eq!(status, 404, "{answer}");
    assert_eq!(answer["error"]["code"], "unknown_batch");
    assert!(!folder.coach().exists());

    server.stop().await;
}

#[tokio::test]
async fn an_undo_stopped_half_way_finishes_when_asked_again() {
    let folder = TempFolder::new("undo-half");
    let server = serve_in(&folder.path).await;

    import(server.port, games_text(3).as_bytes()).await;
    folder.write("removed/b0001/g0001.json", &folder.read("games/g0001.json"));
    fs::remove_file(folder.coach().join("games/g0001.json")).expect("remove");

    let (status, answer) = undo_batch(server.port, "b0001").await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["moved"], 2);
    assert!(game_files(&folder).is_empty());
    assert_eq!(
        folder.json("imports/b0001/batch.json")["undone"]["moved"],
        json!(["g0001", "g0002", "g0003"])
    );

    server.stop().await;
}

#[tokio::test]
async fn a_removed_name_takes_back_the_side_it_gave() {
    let folder = TempFolder::new("remove-name");
    let server = serve_in(&folder.path).await;

    let stranger = Shape {
        white: "Odo Brask",
        black: "Pell Varn",
        ..quiet(10)
    };
    let text = [lichess(&mate(8)), lichess(&stranger)].concat();
    import(server.port, text.as_bytes()).await;

    let (_, named) = post_json(
        server.port,
        "/api/coach/names",
        json!({"names": ["Odo Brask", "Maren Holt"]}),
    )
    .await;
    assert_eq!(named["given_side"], 2);

    let (status, removed) = post_json(
        server.port,
        "/api/coach/names",
        json!({"remove": ["odo brask"]}),
    )
    .await;
    assert_eq!(status, 200, "{removed}");
    assert_eq!(
        removed,
        json!({"names": ["Maren Holt"], "given_side": 0, "cleared_side": 1})
    );

    let cleared = folder.json("games/g0002.json");
    assert_eq!(cleared["you"], Value::Null);
    assert_eq!(cleared["you_rating"], Value::Null);
    assert_eq!(cleared["opponent"], Value::Null);
    assert_eq!(folder.json("games/g0001.json")["you"], "white");

    server.stop().await;
}

#[tokio::test]
async fn names_past_the_cap_are_refused() {
    let folder = TempFolder::new("name-cap");
    let server = serve_in(&folder.path).await;

    let many: Vec<String> = (0..101).map(|i| format!("name{i}")).collect();
    let (status, answer) = post_json(server.port, "/api/coach/names", json!({"names": many})).await;
    assert_eq!(status, 400, "{answer}");
    assert_eq!(
        answer["error"]["message"],
        "Send 1 to 100 names with something visible in each."
    );

    let hundred: Vec<String> = (0..100).map(|i| format!("name{i}")).collect();
    let (status, answer) =
        post_json(server.port, "/api/coach/names", json!({"names": hundred})).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["names"].as_array().map(Vec::len), Some(100));

    server.stop().await;
}

#[tokio::test]
async fn every_text_type_is_taken_and_a_second_content_type_is_refused() {
    let folder = TempFolder::new("types");
    let server = serve_in(&folder.path).await;

    let kinds = [
        "application/x-chess-pgn",
        "application/vnd.chess-pgn",
        "application/octet-stream",
    ];
    for (i, kind) in kinds.iter().enumerate() {
        let headers = vec![
            ("X-Rukh", "1".to_string()),
            ("Content-Type", kind.to_string()),
        ];
        let body = lichess(&quiet(20 + i));
        let (status, _, text) = send(
            server.port,
            "/api/coach/import/text",
            &headers,
            body.as_bytes(),
        )
        .await;
        assert_eq!(status, 200, "{kind}: {text}");
    }

    let two = vec![
        ("X-Rukh", "1".to_string()),
        ("Content-Type", "text/plain".to_string()),
        ("Content-Type", "application/json".to_string()),
    ];
    let body = lichess(&quiet(30));
    let (status, _, text) =
        send(server.port, "/api/coach/import/text", &two, body.as_bytes()).await;
    assert_eq!(status, 415, "{text}");
    assert!(text.contains("wrong_content_type"), "{text}");

    server.stop().await;
}

#[tokio::test]
async fn a_chunked_text_past_the_limit_and_a_broken_body_are_refused() {
    let folder = TempFolder::new("chunked");
    let server = serve_in(&folder.path).await;

    let mut chunked = text_headers();
    chunked.push(("Transfer-Encoding", "chunked".to_string()));

    let chunk = vec![b' '; 1024 * 1024];
    let mut body = Vec::new();
    for _ in 0..33 {
        body.extend_from_slice(b"100000\r\n");
        body.extend_from_slice(&chunk);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(b"0\r\n\r\n");

    let (status, _, text) = send(server.port, "/api/coach/import/text", &chunked, &body).await;
    assert_eq!(status, 413, "{text}");
    assert!(text.contains("too_big"), "{text}");

    let (status, _, text) = send(
        server.port,
        "/api/coach/import/text",
        &chunked,
        b"5\r\nab\r\nzz\r\n\r\n",
    )
    .await;
    assert_eq!(status, 400, "{text}");
    assert!(text.contains("broken_body"), "{text}");

    assert!(!folder.coach().exists());
    server.stop().await;
}

#[tokio::test]
async fn a_declared_text_past_the_limit_sent_whole_still_gets_its_answer() {
    let folder = TempFolder::new("declared-whole");
    let server = serve_in(&folder.path).await;

    let body = vec![b' '; TEXT_LIMIT + 1024 * 1024];
    let (status, _, text) = send(
        server.port,
        "/api/coach/import/text",
        &text_headers(),
        &body,
    )
    .await;
    assert_eq!(status, 413, "{text}");
    assert!(text.contains("too_big"), "{text}");

    assert!(!folder.coach().exists());
    server.stop().await;
}

#[tokio::test]
async fn a_text_waiting_for_its_turn_is_not_read_yet() {
    let folder = TempFolder::new("turn");
    let server = serve_in(&folder.path).await;
    let port = server.port;

    let turn = server.coach.one_import().await;

    let mut chunked = text_headers();
    chunked.push(("Transfer-Encoding", "chunked".to_string()));
    let waiting = tokio::spawn(async move {
        send(
            port,
            "/api/coach/import/text",
            &chunked,
            b"5\r\nab\r\nzz\r\n\r\n",
        )
        .await
    });

    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !waiting.is_finished(),
        "a broken body was answered while another import held the turn"
    );

    drop(turn);
    let (status, _, text) = waiting.await.expect("the waiting import");
    assert_eq!(status, 400, "{text}");
    assert!(text.contains("broken_body"), "{text}");

    server.stop().await;
}

#[tokio::test]
async fn a_stalled_body_gives_up_its_turn() {
    let folder = TempFolder::new("stalled");
    let server = serve_in(&folder.path).await;
    let port = server.port;

    let mut stalled = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let head = format!(
        "POST /api/coach/import/text HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Rukh: 1\r\n\
         Content-Type: text/plain\r\nContent-Length: 1000\r\n\r\n[White \"Ivo"
    );
    stalled.write_all(head.as_bytes()).await.expect("send head");
    tokio::time::sleep(Duration::from_millis(300)).await;

    let after = tokio::time::timeout(
        Duration::from_secs(20),
        import(port, lichess(&quiet(1)).as_bytes()),
    )
    .await;
    let (status, answer) = after.expect("the next import got its turn");
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 1);

    let mut response = Vec::new();
    let mut buf = [0u8; 4096];
    while !String::from_utf8_lossy(&response).contains("broken_body") {
        match tokio::time::timeout(Duration::from_secs(20), stalled.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => response.extend_from_slice(&buf[..n]),
            _ => break,
        }
    }
    let text = String::from_utf8_lossy(&response);
    assert!(text.starts_with("HTTP/1.1 400"), "{text}");
    assert!(text.contains("broken_body"), "{text}");

    server.stop().await;
}

#[tokio::test]
async fn a_trickling_body_gives_up_its_turn() {
    let folder = TempFolder::new("trickling");
    let server = serve_in(&folder.path).await;
    let port = server.port;

    let stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let (mut reading, mut writing) = stream.into_split();

    let head = format!(
        "POST /api/coach/import/text HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Rukh: 1\r\n\
         Content-Type: text/plain\r\nContent-Length: 1000\r\n\r\n[White \"Ivo"
    );
    writing.write_all(head.as_bytes()).await.expect("send head");

    // One byte every half second stays well inside the pause limit for a minute.
    let trickle = tokio::spawn(async move {
        for _ in 0..120 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if writing.write_all(b" ").await.is_err() {
                break;
            }
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;

    let after = tokio::time::timeout(
        Duration::from_secs(20),
        import(port, lichess(&quiet(1)).as_bytes()),
    )
    .await;
    let (status, answer) = after.expect("the next import got its turn");
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 1);

    let mut response = Vec::new();
    let mut buf = [0u8; 4096];
    while !String::from_utf8_lossy(&response).contains("broken_body") {
        match tokio::time::timeout(Duration::from_secs(20), reading.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => response.extend_from_slice(&buf[..n]),
            _ => break,
        }
    }
    let text = String::from_utf8_lossy(&response);
    assert!(text.starts_with("HTTP/1.1 400"), "{text}");
    assert!(text.contains("broken_body"), "{text}");

    trickle.abort();
    server.stop().await;
}

#[tokio::test]
async fn utf16_text_and_too_many_games_are_refused_whole() {
    let folder = TempFolder::new("whole");
    let server = serve_in(&folder.path).await;

    let mut utf16 = vec![0xFF, 0xFE];
    for unit in lichess(&quiet(1)).encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    let (status, answer) = import(server.port, &utf16).await;
    assert_eq!(status, 422, "{answer}");
    assert_eq!(answer["error"]["code"], "utf16_text");

    let moves = movetext(&QUIET, false, "1-0");
    let text: String = (0..50_001)
        .map(|i| format!("[White \"p{i}\"]\n\n{moves}\n\n"))
        .collect();
    let (status, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(status, 413, "{answer}");
    assert_eq!(answer["error"]["code"], "too_many_games");

    assert!(!folder.coach().exists());
    server.stop().await;
}

#[tokio::test]
async fn text_whose_games_exist_nowhere_else_is_kept_once() {
    let folder = TempFolder::new("kept");
    let server = serve_in(&folder.path).await;

    let skipped_only = "[White \"a\"]\n\n1. e4 e5 1-0\n\n[Variant \"Atomic\"]\n\n1. e4 e5 *\n";
    let (_, answer) = import(server.port, skipped_only.as_bytes()).await;
    assert_eq!(answer["added"], 0);
    assert_eq!(answer["skipped_total"], 2);
    assert_eq!(answer["batch"], "b0001");
    assert_eq!(folder.read("imports/b0001/part-001.pgn"), skipped_only);
    assert_eq!(folder.json("imports/b0001/batch.json")["added"], json!([]));

    let (_, again) = import(server.port, skipped_only.as_bytes()).await;
    assert_eq!(again["batch"], Value::Null);

    let moves = movetext(&QUIET, false, "1-0");
    let undated = format!("[White \"Ann\"]\n[Black \"Bo\"]\n\n{moves}\n");
    let (_, first) = import(server.port, undated.as_bytes()).await;
    assert_eq!(first["added"], 1);

    let round_two = format!("[Round \"2\"]\n{undated}");
    let (_, second) = import(server.port, round_two.as_bytes()).await;
    assert_eq!(second["added"], 0);
    assert_eq!(second["already_here"], 1);
    assert_eq!(second["already_here_undated"], 1);
    assert_eq!(second["batch"], "b0003");
    assert_eq!(folder.read("imports/b0003/part-001.pgn"), round_two);

    server.stop().await;
}

#[tokio::test]
async fn set_up_games_from_the_sites_are_stored() {
    let folder = TempFolder::new("set-up");
    let server = serve_in(&folder.path).await;

    let material = "[White \"Ivo Brand\"]\n[Black \"Ada Rusk\"]\n[Variant \"From Position\"]\n[FEN \"nnnnknnn/pppppppp/8/8/8/8/PPPPPPPP/NNNNKNNN w - - 0 1\"]\n\n1. Na3 Na6 2. Nf3 Nf6 3. Nc4 Nc5 4. Ng5 Ng4 5. Ne5 Ne4 1-0\n\n";
    let castling = "[White \"Ivo Brand\"]\n[Black \"Ada Rusk\"]\n[Variant \"From Position\"]\n[FEN \"r1k4r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1\"]\n\n1. O-O O-O 2. Kh1 Kh8 3. a3 a6 4. b3 b6 5. c3 c6 0-1\n";

    let (status, answer) = import(server.port, [material, castling].concat().as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 2, "{answer}");
    assert_eq!(answer["set_up"], 2);

    let castled = folder.json("games/g0002.json");
    assert_eq!(castled["variant"], "standard");
    assert_eq!(castled["moves"][0]["uci"], "e1h1");

    server.stop().await;
}

#[tokio::test]
async fn a_set_up_game_castling_king_to_rook_says_so_in_its_file() {
    let folder = TempFolder::new("castling-flag");
    let server = serve_in(&folder.path).await;

    let castling = "[White \"Ivo Brand\"]\n[Black \"Ada Rusk\"]\n[Variant \"From Position\"]\n[FEN \"r1k4r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1\"]\n\n1. O-O O-O 2. Kh1 Kh8 3. a3 a6 4. b3 b6 5. c3 c6 0-1\n\n";
    let plain = "[White \"Ivo Brand\"]\n[Black \"Ada Rusk\"]\n[Variant \"From Position\"]\n[FEN \"r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1\"]\n\n1. O-O O-O 2. Kh1 Kh8 3. a3 a6 4. b3 b6 5. c3 c6 1-0\n";

    let (status, answer) = import(server.port, [castling, plain].concat().as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 2, "{answer}");

    let castled = folder.read("games/g0001.json");
    let record: GameRecord = serde_json::from_str(&castled).expect("a game record");
    assert!(record.chess960_castling);
    assert_eq!(record.to_text(), castled);
    assert!(
        castled.contains("\n  \"chess960_castling\": true,\n"),
        "{castled}"
    );

    let plain = folder.json("games/g0002.json");
    assert_eq!(plain["moves"][0]["uci"], "e1g1");
    assert!(plain.get("chess960_castling").is_none(), "{plain}");

    server.stop().await;
}

#[tokio::test]
async fn a_failed_write_after_the_games_answers_what_was_stored() {
    let folder = TempFolder::new("write-failed");
    let server = serve_in(&folder.path).await;

    import(server.port, lichess(&quiet(1)).as_bytes()).await;
    fs::remove_file(folder.coach().join("derived/keys.json")).expect("remove");
    fs::create_dir_all(folder.coach().join("derived/keys.json")).expect("a folder in the way");

    let (status, answer) = import(server.port, games_text(3).as_bytes()).await;
    assert_eq!(status, 500, "{answer}");
    assert_eq!(answer["error"]["code"], "write_failed");
    assert!(
        answer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.starts_with("Could not save coach/derived/keys.json: ")),
        "{answer}"
    );
    assert_eq!(answer["stored"]["added"], 2);
    assert_eq!(game_files(&folder).len(), 3);

    server.stop().await;
}

#[tokio::test]
async fn a_folder_that_cannot_be_used_or_a_stopping_program_stores_nothing() {
    let folder = TempFolder::new("unusable");
    let file = folder.path.join("a-file");
    fs::write(&file, "not a folder").expect("write");

    let server = serve_in(&file).await;
    let (status, answer) = import(server.port, lichess(&quiet(1)).as_bytes()).await;
    assert_eq!(status, 503, "{answer}");
    assert_eq!(
        answer["error"],
        json!({"code": "folder_failed", "message": "The data folder could not be used, so games cannot be stored."})
    );
    server.stop().await;

    let server = serve_in(&folder.path).await;
    let coach = server.coach.clone();
    tokio::task::spawn_blocking(move || coach.close())
        .await
        .expect("close");

    let (status, answer) = import(server.port, lichess(&quiet(1)).as_bytes()).await;
    assert_eq!(status, 503, "{answer}");
    assert_eq!(
        answer["error"],
        json!({"code": "stopping", "message": "Rukh is stopping, so nothing more is stored."})
    );
    assert!(!folder.coach().exists());

    server.stop().await;
}

/// Makes one path fail as a file or folder that cannot be looked at, until dropped.
struct Hidden(PathBuf);

impl Hidden {
    fn new(path: PathBuf) -> Hidden {
        crate::coach::store::HIDDEN
            .lock()
            .expect("the hidden paths")
            .insert(path.clone());
        Hidden(path)
    }
}

impl Drop for Hidden {
    fn drop(&mut self) {
        if let Ok(mut hidden) = crate::coach::store::HIDDEN.lock() {
            hidden.remove(&self.0);
        }
    }
}

#[tokio::test]
async fn a_game_folder_that_cannot_be_listed_refuses_and_writes_nothing() {
    let folder = TempFolder::new("unlisted");
    let text = games_text(2);

    let server = serve_in(&folder.path).await;
    let (status, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    server.stop().await;

    let before = coach_files(&folder);
    let server = serve_in(&folder.path).await;

    let hidden = Hidden::new(folder.coach().join("games"));
    let (status, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(status, 500, "{answer}");
    assert_eq!(answer["error"]["code"], "write_failed");
    assert!(
        answer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.starts_with("Could not list coach/games: ")),
        "{answer}"
    );
    assert_eq!(coach_files(&folder), before);
    drop(hidden);

    let (status, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 0);
    assert_eq!(answer["already_here"], 2);
    assert_eq!(game_files(&folder).len(), 2);

    server.stop().await;
}

#[tokio::test]
async fn a_game_file_that_cannot_be_read_while_the_index_is_rebuilt_refuses_and_writes_nothing() {
    let folder = TempFolder::new("unread-game");
    let text = games_text(2);

    let server = serve_in(&folder.path).await;
    let (status, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    server.stop().await;

    fs::remove_file(folder.coach().join("derived/keys.json")).expect("remove the key index");
    let before = coach_files(&folder);
    let server = serve_in(&folder.path).await;

    let hidden = Hidden::new(folder.coach().join("games/g0001.json"));
    let (status, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(status, 500, "{answer}");
    assert_eq!(answer["error"]["code"], "write_failed");
    assert!(
        answer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.starts_with("Could not read coach/games/g0001.json: ")),
        "{answer}"
    );
    assert_eq!(coach_files(&folder), before);
    drop(hidden);

    let (status, answer) = import(server.port, text.as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["added"], 0);
    assert_eq!(answer["already_here"], 2);
    assert_eq!(game_files(&folder).len(), 2);

    server.stop().await;
}

#[tokio::test]
async fn a_persona_that_cannot_be_looked_at_is_never_replaced() {
    let folder = TempFolder::new("persona");
    folder.write("persona.md", "My own persona.\n");
    let server = serve_in(&folder.path).await;

    let hidden = Hidden::new(folder.coach().join("persona.md"));
    let (status, answer) = import(server.port, lichess(&quiet(1)).as_bytes()).await;
    assert_eq!(status, 500, "{answer}");
    assert!(
        answer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.starts_with("Could not read coach/persona.md: ")),
        "{answer}"
    );
    assert_eq!(folder.read("persona.md"), "My own persona.\n");
    assert!(game_files(&folder).is_empty());
    drop(hidden);

    let (status, answer) = import(server.port, lichess(&quiet(1)).as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(folder.read("persona.md"), "My own persona.\n");
    assert_eq!(folder.read("soul.md"), SOUL);

    server.stop().await;
}
