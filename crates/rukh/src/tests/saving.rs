//! Saved boards: the folder, restore at start, the saver, closed and broken files, the lock.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rukh_core::{SavedTab, TabId};

use super::*;
use crate::boards::{INDEX_REBUILT, KEEP_CLOSED, README};
use crate::safe::{self, Lock, Locked, WriteFailure};

const STOPPED_ON_BOARD: &str = "The person stopped the match on the board, so wait does not start \
     another one. Stop and tell them. If they want to play again, ask them to press Start on the \
     board with Opponent: AI, then call wait with seat=\"black\".";

const EXAMPLE_TAB: &str = r#"{ "v": 1, "id": "t4", "name": "Italian, the Bc5 line", "kind": "free", "source": null,
  "game_id": 7, "board_rev": 31, "variant": "standard", "chess960": null,
  "start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "current": 5,
  "match": { "active": true, "seats": { "white": "human", "black": "ai" }, "tip": 4, "style": "annotate" },
  "study": { "title": "", "notes": "" },
  "moves": [
    {"id":1,"from":0,"uci":"e2e4","san":"e4"},
    {"id":2,"from":1,"uci":"e7e5","san":"e5"},
    {"id":3,"from":2,"uci":"g1f3","san":"Nf3","note":"The main move.","arrows":[{"from":"f3","to":"e5","color":"red","knight":true,"source":"ai"}]},
    {"id":4,"from":3,"uci":"b8c6","san":"Nc6"},
    {"id":5,"from":2,"uci":"f1c4","san":"Bc4","nag":"?!","eval":{"cp":12,"depth":18,"pv":["g8f6","d2d3"],"best":"g8f6"}}
  ] }"#;

const TWO_TABS_INDEX: &str =
    "{ \"v\": 1, \"selected\": \"t2\", \"order\": [\"t1\", \"t2\"], \"next_tab\": 3, \"next_game_id\": 3 }\n";

const TWO_TABS_T1: &str = r#"{ "v": 1, "id": "t1", "name": "Board 1", "kind": "free", "source": null,
  "game_id": 1, "board_rev": 3, "variant": "standard", "chess960": null,
  "start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "current": 2,
  "match": { "active": false, "seats": { "white": "human", "black": "human" }, "tip": 0, "style": "annotate" },
  "study": { "title": "", "notes": "" },
  "moves": [
    {"id":1,"from":0,"uci":"e2e4","san":"e4"},
    {"id":2,"from":1,"uci":"e7e5","san":"e5","note":"Open game.","highlights":[{"square":"e5","color":"blue"}]}
  ] }
"#;

const TWO_TABS_T2: &str = r#"{ "v": 1, "id": "t2", "name": "Endgame", "kind": "free", "source": null,
  "game_id": 2, "board_rev": 1, "variant": "standard", "chess960": null,
  "start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "current": 1,
  "match": { "active": false, "seats": { "white": "human", "black": "human" }, "tip": 0, "style": "annotate" },
  "study": { "title": "", "notes": "" },
  "moves": [
    {"id":1,"from":0,"uci":"d2d4","san":"d4"}
  ] }
"#;

const FRESH_T1: &str = r#"{ "v": 1, "id": "t1", "name": "Board 1", "kind": "free", "source": null,
  "game_id": 1, "board_rev": 1, "variant": "standard", "chess960": null,
  "start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "current": 1,
  "match": { "active": false, "seats": { "white": "human", "black": "human" }, "tip": 0, "style": "annotate" },
  "study": { "title": "", "notes": "" },
  "moves": [
    {"id":1,"from":0,"uci":"e2e4","san":"e4"}
  ] }
"#;

static NEXT_FOLDER: AtomicU64 = AtomicU64::new(0);

/// A fresh folder under the system temp folder, removed when the test ends.
struct TempFolder {
    path: PathBuf,
}

impl TempFolder {
    fn new(name: &str) -> TempFolder {
        let n = NEXT_FOLDER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "rukh-saving-{name}-{}-{n}-{}",
            std::process::id(),
            crate::hub::now_ms()
        ));

        fs::create_dir_all(&path).expect("make the test folder");
        TempFolder { path }
    }

    fn boards(&self) -> PathBuf {
        self.path.join("boards")
    }

    /// Writes a file under `boards/`, making its folder.
    fn put(&self, relative: &str, text: &str) {
        let path = self.boards().join(relative);
        fs::create_dir_all(path.parent().expect("a parent")).expect("make the folder");
        fs::write(path, text).expect("write the test file");
    }

    fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.boards().join(relative))
            .unwrap_or_else(|e| panic!("read boards/{relative}: {e}"))
    }

    fn exists(&self, relative: &str) -> bool {
        self.boards().join(relative).exists()
    }

    /// File names, leaving out a temp file a write in progress has open.
    fn names(&self, relative: &str) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.boards().join(relative))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|name| !name.contains(".tmp-"))
                    .collect()
            })
            .unwrap_or_default();

        names.sort();
        names
    }

    /// Every file under the folder with its bytes, for before-and-after checks.
    fn snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };

            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    let bytes = fs::read(&path).unwrap_or_default();
                    out.push((path, bytes));
                }
            }
        }

        let mut out = Vec::new();
        walk(&self.path, &mut out);
        out.sort();
        out
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

fn id(text: &str) -> TabId {
    text.parse().expect("a tab id")
}

fn on(hub: &Hub, tab: &str, body: Value) -> Value {
    hub.apply_on(id(tab), "view:1", &body.to_string(), None)
        .unwrap_or_else(|e| panic!("{body}: {e}"))
        .result
}

fn desk(hub: &Hub, body: Value) -> Value {
    hub.apply_desk("view:1", &body.to_string(), None)
        .unwrap_or_else(|e| panic!("{body}: {e}"))
        .result
}

fn notices(hub: &Hub) -> Vec<(String, String)> {
    hub.status()
        .borrow()
        .notices
        .iter()
        .map(|n| (n.code.to_string(), n.text.clone()))
        .collect()
}

fn notice(code: &str, text: &str) -> (String, String) {
    (code.to_string(), text.to_string())
}

/// Tabs, order, selection, counters and each tab's state without its recent list.
fn picture(hub: &Hub) -> Value {
    hub.read_desk(|d| {
        let tabs: Vec<Value> = d
            .tabs()
            .iter()
            .map(|t| {
                let mut state = serde_json::to_value(t.table().state()).expect("state");
                state.as_object_mut().expect("an object").remove("recent");
                json!({"entry": t.entry(), "state": state})
            })
            .collect();

        json!({"selected": d.selected(), "tabs": tabs, "next_game_id": d.next_game_id()})
    })
}

fn saved_text(hub: &Hub, tab: &str) -> String {
    hub.read_desk(|d| d.saved_tab(id(tab)).expect("the tab is open").to_text())
}

/// Waits until `boards/<relative>` reads exactly `expected`.
async fn until_file(folder: &TempFolder, relative: &str, expected: &str) {
    let path = folder.boards().join(relative);
    let deadline = Instant::now() + WAIT;

    loop {
        let now = fs::read_to_string(&path).ok();
        if now.as_deref() == Some(expected) {
            return;
        }

        assert!(
            Instant::now() < deadline,
            "boards/{relative} never became:\n{expected}\nit is:\n{now:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Waits until the saver has written nothing for a while.
async fn settle(hub: &Hub) {
    let mut last = hub.write_counts().0;

    loop {
        tokio::time::sleep(Duration::from_millis(150)).await;

        let now = hub.write_counts().0;
        if now == last {
            return;
        }
        last = now;
    }
}

/// The one file name in `boards/<dir>` that starts with `prefix`.
fn only_name(folder: &TempFolder, dir: &str, prefix: &str) -> String {
    let names: Vec<String> = folder
        .names(dir)
        .into_iter()
        .filter(|n| n.starts_with(prefix))
        .collect();

    assert_eq!(names.len(), 1, "{names:?}");
    names[0].clone()
}

fn damage_of(text: &str) -> String {
    let saved = SavedTab::from_text(text);
    match saved.and_then(|s| rukh_core::Tab::from_saved(&s)) {
        Ok(_) => panic!("the text was meant to be damaged"),
        Err(why) => why.0,
    }
}

/// Reads a socket until the ack with `id`; returns the last state frame before it and the ack.
async fn frame_then_ack(socket: &mut Socket, id: u64) -> (Option<Value>, Value) {
    let mut frame = None;

    loop {
        let message = next_any(socket).await;
        if message["t"] == "state" {
            frame = Some(message);
        } else if message["t"] == "ack" && message["id"] == id {
            return (frame, message);
        }
    }
}

// ------------------------------------------------------------------ restart

#[tokio::test]
async fn a_restart_brings_back_the_same_tabs_order_and_selection() {
    let folder = TempFolder::new("restart");
    let first = serve_in(&folder.path).await;
    let hub = first.hub.clone();

    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    on(&hub, "t1", json!({"op": "play", "move": "e5"}));
    on(
        &hub,
        "t1",
        json!({"op": "annotate", "note": "Open game.", "highlights": [{"square": "e5", "color": "blue"}]}),
    );
    desk(&hub, json!({"op": "tab_new", "name": "Endgame"}));
    on(&hub, "t2", json!({"op": "play", "move": "d4"}));

    let before = picture(&hub);
    let first_instance = hub.instance().to_string();
    first.stop().await;

    assert_eq!(folder.read("index.json"), TWO_TABS_INDEX);
    assert_eq!(folder.read("t1.json"), TWO_TABS_T1);
    assert_eq!(folder.read("t2.json"), TWO_TABS_T2);
    assert_eq!(folder.read("README.txt"), README);
    assert!(
        !folder.path.join(".lock").exists(),
        "the lock is removed at exit"
    );

    let second = serve_in(&folder.path).await;
    assert_eq!(picture(&second.hub), before);
    assert_ne!(second.hub.instance(), first_instance);
    assert_eq!(second.hub.latest().rev, 0);
    assert!(
        notices(&second.hub).is_empty(),
        "{:?}",
        notices(&second.hub)
    );

    let frame: Value = serde_json::from_str(&second.hub.latest().json).expect("frame");
    assert_eq!(frame["tab"], "t2");
    assert_eq!(
        frame["tabs"],
        json!([
            {"id": "t1", "name": "Board 1", "kind": "free", "mark": null},
            {"id": "t2", "name": "Endgame", "kind": "free", "mark": null},
        ])
    );

    second.stop().await;
}

#[tokio::test]
async fn the_example_tab_file_loads_as_written() {
    let folder = TempFolder::new("example");
    folder.put("t4.json", EXAMPLE_TAB);
    folder.put(
        "index.json",
        "{ \"v\": 1, \"selected\": \"t4\", \"order\": [\"t4\"], \"next_tab\": 5, \"next_game_id\": 9 }\n",
    );

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    assert!(notices(&hub).is_empty(), "{:?}", notices(&hub));

    assert_eq!(saved_text(&hub, "t4"), format!("{EXAMPLE_TAB}\n"));

    let state = hub
        .read_on(id("t4"), |t| {
            serde_json::to_value(t.state()).expect("state")
        })
        .expect("t4 is open");
    assert_eq!(state["game_id"], 7);
    assert_eq!(state["board_rev"], 31);
    assert_eq!(state["game"]["current"], 5);
    assert_eq!(state["match"]["active"], true);
    assert_eq!(state["match"]["tip"], 4);
    assert_eq!(
        state["match"]["seats"],
        json!({"white": "human", "black": "ai"})
    );

    let nodes = &state["game"]["nodes"];
    assert_eq!(nodes[3]["note"], "The main move.");
    assert_eq!(nodes[3]["arrows"][0]["source"], "ai");
    assert_eq!(nodes[5]["nag"], "?!");
    assert_eq!(nodes[5]["parent"], 2);

    let frame: Value = serde_json::from_str(&hub.latest().json).expect("frame");
    assert_eq!(frame["tab"], "t4");
    assert_eq!(
        frame["tabs"],
        json!([{"id": "t4", "name": "Italian, the Bc5 line", "kind": "free", "mark": "your_move"}])
    );

    server.stop().await;
    assert_eq!(
        folder.read("t4.json"),
        EXAMPLE_TAB,
        "loading never rewrites the file"
    );
}

// ------------------------------------------------------------------ damage

#[tokio::test]
async fn a_file_with_an_illegal_move_goes_to_broken_whole_and_the_others_load() {
    let folder = TempFolder::new("illegal");
    let illegal = TWO_TABS_T2.replace("d2d4", "d2d5");
    folder.put("index.json", TWO_TABS_INDEX);
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("t2.json", &illegal);

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    assert!(!folder.exists("t2.json"));
    let moved = only_name(&folder, "broken", "t2.");
    assert_eq!(folder.read(&format!("broken/{moved}")), illegal);

    assert_eq!(
        damage_of(&illegal),
        "move id 1 (d4): d2d5 is not a legal move after node 0"
    );
    assert_eq!(
        notices(&hub),
        vec![
            notice(
                "broken",
                &format!(
                    "The saved board t2.json could not be read: move id 1 (d4): d2d5 is not a \
                     legal move after node 0. It was moved to broken/{moved}."
                )
            ),
            notice(
                "selection_lost",
                "The board that was shown last time could not be loaded, so the first board is shown."
            ),
        ]
    );

    let order: Vec<String> =
        hub.read_desk(|d| d.tabs().iter().map(|t| t.id().to_string()).collect());
    assert_eq!(order, vec!["t1"]);
    assert_eq!(hub.selected(), id("t1"));
    assert_eq!(saved_text(&hub, "t1"), TWO_TABS_T1);

    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\"], \"next_tab\": 3, \"next_game_id\": 3 }\n",
    )
    .await;

    server.stop().await;
}

#[tokio::test]
async fn a_damaged_index_goes_to_broken_and_is_rebuilt() {
    let folder = TempFolder::new("index");
    folder.put("index.json", "{ \"v\": 1, \"order\": \"t1\" ");
    folder.put("t2.json", TWO_TABS_T2);
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("closed/t7.1000.json", "closed earlier");
    folder.put("broken/t9.2000.json", "broken earlier");

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    let moved = only_name(&folder, "broken", "index.");
    assert_eq!(
        folder.read(&format!("broken/{moved}")),
        "{ \"v\": 1, \"order\": \"t1\" "
    );
    assert_eq!(notices(&hub), vec![notice("index_rebuilt", INDEX_REBUILT)]);
    assert_eq!(hub.selected(), id("t1"));

    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\", \"t2\"], \"next_tab\": 10, \"next_game_id\": 3 }\n",
    )
    .await;

    assert_eq!(desk(&hub, json!({"op": "tab_new"})), json!({"tab": "t10"}));
    assert_eq!(folder.read("broken/t9.2000.json"), "broken earlier");
    assert_eq!(folder.read("closed/t7.1000.json"), "closed earlier");

    server.stop().await;
}

#[tokio::test]
async fn an_index_entry_with_no_file_is_skipped() {
    let folder = TempFolder::new("missing");
    folder.put(
        "index.json",
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\", \"t3\", \"t2\"], \"next_tab\": 4, \"next_game_id\": 3 }\n",
    );
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("t2.json", TWO_TABS_T2);

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    assert_eq!(
        notices(&hub),
        vec![notice(
            "missing",
            "Board t3 is in the list of boards, but its file t3.json is missing, so it was left out."
        )]
    );

    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\", \"t2\"], \"next_tab\": 4, \"next_game_id\": 3 }\n",
    )
    .await;

    server.stop().await;
}

#[tokio::test]
async fn a_selected_tab_that_was_lost_falls_to_the_first() {
    let folder = TempFolder::new("selected");
    folder.put("index.json", TWO_TABS_INDEX);
    folder.put("t1.json", TWO_TABS_T1);

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    assert_eq!(hub.selected(), id("t1"));
    assert_eq!(
        notices(&hub),
        vec![
            notice(
                "missing",
                "Board t2 is in the list of boards, but its file t2.json is missing, so it was left out."
            ),
            notice(
                "selection_lost",
                "The board that was shown last time could not be loaded, so the first board is shown."
            ),
        ]
    );

    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\"], \"next_tab\": 3, \"next_game_id\": 3 }\n",
    )
    .await;

    server.stop().await;
}

#[tokio::test]
async fn a_counter_that_is_too_low_in_a_readable_index_is_raised() {
    let folder = TempFolder::new("counter");
    folder.put(
        "index.json",
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\", \"t2\"], \"next_tab\": 1, \"next_game_id\": 1 }\n",
    );
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("t2.json", TWO_TABS_T2);

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    assert!(notices(&hub).is_empty(), "{:?}", notices(&hub));

    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\", \"t2\"], \"next_tab\": 3, \"next_game_id\": 3 }\n",
    )
    .await;

    assert_eq!(desk(&hub, json!({"op": "tab_new"})), json!({"tab": "t3"}));
    let game_id = hub.read_on(id("t3"), |t| t.game_id()).expect("t3 is open");
    assert_eq!(game_id, 3);

    server.stop().await;
}

#[tokio::test]
async fn a_tab_file_missing_from_the_index_is_recovered() {
    let folder = TempFolder::new("recovered");
    folder.put(
        "index.json",
        "{ \"v\": 1, \"selected\": \"t2\", \"order\": [\"t2\"], \"next_tab\": 3, \"next_game_id\": 3 }\n",
    );
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("t2.json", TWO_TABS_T2);

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    assert_eq!(
        notices(&hub),
        vec![notice(
            "added",
            "The saved board t1.json was not in the list of boards, so it was added at the end."
        )]
    );

    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t2\", \"order\": [\"t2\", \"t1\"], \"next_tab\": 3, \"next_game_id\": 3 }\n",
    )
    .await;

    server.stop().await;
}

#[tokio::test]
async fn a_kill_between_the_tab_write_and_the_index_write_loses_nothing() {
    let folder = TempFolder::new("kill");
    folder.put(
        "index.json",
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\"], \"next_tab\": 2, \"next_game_id\": 2 }\n",
    );
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("t2.json", TWO_TABS_T2);
    folder.put("t2.json.tmp-999", "{ \"v\": 1, \"id\": \"t2\", \"na");

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    assert_eq!(
        notices(&hub),
        vec![notice(
            "added",
            "The saved board t2.json was not in the list of boards, so it was added at the end."
        )]
    );
    assert_eq!(saved_text(&hub, "t1"), TWO_TABS_T1);
    assert_eq!(saved_text(&hub, "t2"), TWO_TABS_T2);

    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\", \"t2\"], \"next_tab\": 3, \"next_game_id\": 3 }\n",
    )
    .await;
    assert!(!folder.exists("t2.json.tmp-999"));
    assert_eq!(
        folder.read("broken/t2.json.tmp-999"),
        "{ \"v\": 1, \"id\": \"t2\", \"na"
    );

    server.stop().await;
}

#[tokio::test]
async fn nothing_that_loads_gives_one_fresh_board_and_the_hello_says_so() {
    let folder = TempFolder::new("hello");
    folder.put("t1.json", "not json");

    let server = serve_in(&folder.path).await;
    let moved = only_name(&folder, "broken", "t1.");
    let why = damage_of("not json");

    let (mut socket, hello) = view(server.port).await;
    assert_eq!(
        hello["boards"],
        json!({"saving": true, "notices": [
            {"id": 1, "code": "broken", "text": format!(
                "The saved board t1.json could not be read: {why}. It was moved to broken/{moved}."
            )},
            {"id": 2, "code": "fresh_board", "text": "No saved board could be loaded, so a fresh Board 1 was made."},
        ]})
    );

    let frame: Value = serde_json::from_str(&server.hub.latest().json).expect("frame");
    assert_eq!(
        frame["tabs"],
        json!([{"id": "t2", "name": "Board 1", "kind": "free", "mark": null}])
    );

    let ack = intent(
        &mut socket,
        1,
        json!({"op": "play", "move": "e4", "tab": "t2"}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t2\", \"order\": [\"t2\"], \"next_tab\": 3, \"next_game_id\": 2 }\n",
    )
    .await;

    server.stop().await;
}

#[tokio::test]
async fn a_game_stub_stays_on_disk_and_a_reps_stub_comes_back_empty() {
    let folder = TempFolder::new("stubs");
    let game = "{ \"v\": 1, \"id\": \"t5\", \"name\": \"Rook: game 24\", \"kind\": \"game\", \"coach_game\": \"g0024\" }\n";
    folder.put("t5.json", game);
    folder.put(
        "t2.json",
        "{ \"v\": 1, \"id\": \"t2\", \"name\": \"Reps\", \"kind\": \"reps\" }\n",
    );

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    assert_eq!(
        notices(&hub),
        vec![
            notice(
                "coach_game",
                "Board t5 (\u{ab}Rook: game 24\u{bb}) is a coach game, which this Rukh cannot open \
                 yet. Its file was left as it is."
            ),
            notice("index_rebuilt", INDEX_REBUILT),
        ]
    );

    let frame: Value = serde_json::from_str(&hub.latest().json).expect("frame");
    assert_eq!(
        frame["tabs"],
        json!([{"id": "t2", "name": "Reps", "kind": "reps", "mark": null}])
    );

    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t2\", \"order\": [\"t2\"], \"next_tab\": 6, \"next_game_id\": 2 }\n",
    )
    .await;
    assert_eq!(desk(&hub, json!({"op": "tab_new"})), json!({"tab": "t6"}));

    server.stop().await;
    assert_eq!(folder.read("t5.json"), game);
}

// ------------------------------------------------------------------ the saver

#[tokio::test]
async fn a_move_is_written_at_once_and_a_note_after_a_quiet_second() {
    let folder = TempFolder::new("timing");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    let played = Instant::now();
    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    until_file(&folder, "t1.json", FRESH_T1).await;
    assert!(
        played.elapsed() < Duration::from_millis(900),
        "{:?}",
        played.elapsed()
    );
    settle(&hub).await;

    let noted = Instant::now();
    on(
        &hub,
        "t1",
        json!({"op": "annotate", "note": "Best by test."}),
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(folder.read("t1.json"), FRESH_T1, "a note waits for quiet");

    let expected = saved_text(&hub, "t1");
    assert!(
        expected.contains("\"note\":\"Best by test.\""),
        "{expected}"
    );
    until_file(&folder, "t1.json", &expected).await;
    assert!(
        noted.elapsed() < Duration::from_millis(2500),
        "{:?}",
        noted.elapsed()
    );

    server.stop().await;
}

#[tokio::test]
async fn what_is_waiting_is_written_at_exit() {
    let folder = TempFolder::new("exit");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    on(
        &hub,
        "t1",
        json!({"op": "annotate", "note": "Written at exit."}),
    );
    let expected = saved_text(&hub, "t1");

    server.stop().await;
    assert_eq!(folder.read("t1.json"), expected);
}

#[tokio::test]
async fn a_file_edited_while_the_program_runs_is_overwritten_at_the_next_save() {
    let folder = TempFolder::new("edited");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    until_file(&folder, "t1.json", FRESH_T1).await;

    folder.put("t1.json", "edited by hand");
    on(&hub, "t1", json!({"op": "play", "move": "e5"}));
    let expected = saved_text(&hub, "t1");
    until_file(&folder, "t1.json", &expected).await;

    server.stop().await;
}

#[tokio::test]
async fn no_file_is_written_while_the_hub_lock_is_held() {
    let folder = TempFolder::new("unlocked");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    settle(&hub).await;
    desk(&hub, json!({"op": "tab_new"}));
    settle(&hub).await;
    on(&hub, "t2", json!({"op": "play", "move": "d4"}));
    settle(&hub).await;
    desk(&hub, json!({"op": "tab_close", "tab": "t1"}));
    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t2\", \"order\": [\"t2\"], \"next_tab\": 3, \"next_game_id\": 3 }\n",
    )
    .await;
    until("the closed file", || folder.names("closed").len() == 1).await;
    until("t1.json gone", || !folder.exists("t1.json")).await;

    let (writes, locked) = hub.write_counts();
    assert!(writes >= 5, "{writes}");
    assert_eq!(locked, 0);

    hub.read_desk(|_| hub.note_write());
    assert_eq!(
        hub.write_counts().1,
        1,
        "a write under the lock would be counted"
    );

    server.stop().await;
}

#[tokio::test]
async fn no_data_folder_writes_nothing() {
    let server = serve("web").await;
    let hub = server.hub.clone();

    let (mut socket, hello) = view(server.port).await;
    assert_eq!(hello["boards"], json!({"saving": false, "notices": []}));

    intent(&mut socket, 1, json!({"op": "play", "move": "e4"})).await;
    intent(
        &mut socket,
        2,
        json!({"op": "annotate", "note": "Nowhere."}),
    )
    .await;
    intent(&mut socket, 3, json!({"op": "tab_new"})).await;
    intent(&mut socket, 4, json!({"op": "tab_close", "tab": "t1"})).await;

    let reopen = intent(&mut socket, 5, json!({"op": "tab_reopen"})).await;
    assert_eq!(reopen["error"]["code"], "nothing_closed", "{reopen}");

    // With no folder there is no saver and no lock, so nothing can be written.
    assert!(!hub.saves());
    assert_eq!(hub.write_counts(), (0, 0));

    server.stop().await;
}

// ------------------------------------------------------------------ closed boards

#[tokio::test]
async fn a_reopened_tab_comes_back_under_its_old_id_with_a_fresh_game_id() {
    let folder = TempFolder::new("reopen");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    let (mut socket, _) = view(server.port).await;

    intent(&mut socket, 1, json!({"op": "play", "move": "e4"})).await;
    intent(&mut socket, 2, json!({"op": "tab_new"})).await;
    intent(&mut socket, 3, json!({"op": "tab_new"})).await;
    let closed = intent(&mut socket, 4, json!({"op": "tab_close", "tab": "t1"})).await;
    assert_eq!(closed["result"], json!({"closed": "t1", "selected": "t3"}));

    until("the closed file", || folder.names("closed").len() == 1).await;
    until("t1.json gone", || !folder.exists("t1.json")).await;
    let name = only_name(&folder, "closed", "t1.");
    assert_eq!(folder.read(&format!("closed/{name}")), FRESH_T1);

    send(
        &mut socket,
        json!({"t": "intent", "id": 5, "op": "tab_reopen"}),
    )
    .await;
    let (frame, ack) = frame_then_ack(&mut socket, 5).await;
    let frame = frame.expect("the frame precedes its ack");

    assert_eq!(ack["ok"], true, "{ack}");
    assert_eq!(ack["result"], json!({"tab": "t1", "selected": "t1"}));
    assert_eq!(ack["rev"], closed["rev"].as_u64().expect("a rev") + 1);
    assert_eq!(frame["rev"], ack["rev"]);
    assert_eq!(frame["hint"]["reason"], "tab_reopen");
    assert_eq!(frame["tab"], "t1");

    let order: Vec<String> =
        hub.read_desk(|d| d.tabs().iter().map(|t| t.id().to_string()).collect());
    assert_eq!(order, vec!["t2", "t3", "t1"]);

    let ids: Vec<u64> = hub.read_desk(|d| d.tabs().iter().map(|t| t.table().game_id()).collect());
    assert_eq!(ids, vec![2, 3, 4]);

    let expected = saved_text(&hub, "t1");
    assert_eq!(
        expected,
        FRESH_T1.replace("\"game_id\": 1,", "\"game_id\": 4,")
    );
    until_file(&folder, "t1.json", &expected).await;
    until("the closed file removed", || {
        folder.names("closed").is_empty()
    })
    .await;

    send(
        &mut socket,
        json!({"t": "intent", "id": 6, "op": "tab_reopen"}),
    )
    .await;
    let none = ack_for(&mut socket, 6).await;
    assert_eq!(
        none,
        json!({"t": "ack", "id": 6, "ok": false,
               "error": {"code": "nothing_closed", "message": "There is no closed board to reopen."}})
    );

    server.stop().await;
}

#[tokio::test]
async fn the_twenty_first_closed_file_removes_the_oldest() {
    let folder = TempFolder::new("closed");
    for i in 0..KEEP_CLOSED {
        folder.put(&format!("closed/t{}.{}.json", 100 + i, 1000 + i), "older");
    }

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    let shown = hub.selected().to_string();
    assert_eq!(shown, "t120");

    on(&hub, &shown, json!({"op": "play", "move": "e4"}));
    desk(&hub, json!({"op": "tab_close", "tab": shown}));

    until("the oldest removed", || {
        !folder.exists("closed/t100.1000.json")
    })
    .await;
    let names = folder.names("closed");
    assert_eq!(names.len(), KEEP_CLOSED, "{names:?}");
    assert!(folder.exists("closed/t101.1001.json"));
    assert_eq!(names.iter().filter(|n| n.starts_with("t120.")).count(), 1);

    server.stop().await;
}

// ------------------------------------------------------------------ the person's Stop

#[tokio::test]
async fn a_stopped_match_is_still_stopped_after_a_restart() {
    let folder = TempFolder::new("stopped");
    let first = serve_in(&folder.path).await;
    let hub = first.hub.clone();

    on(
        &hub,
        "t1",
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );
    on(&hub, "t1", json!({"op": "match_stop"}));
    first.stop().await;
    assert!(folder
        .read("t1.json")
        .contains("\n  \"stopped\": \"match_stop\",\n"));

    let second = serve_in(&folder.path).await;
    let (ai, _) = Ai::connect(second.port, "returning").await;
    let refused = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;

    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(prose(&refused), STOPPED_ON_BOARD);
    assert!(!second.hub.read(|t| t.match_state().active));

    second.stop().await;
}

// ------------------------------------------------------------------ the lock

#[tokio::test]
async fn a_second_program_on_the_same_folder_neither_loads_nor_saves() {
    let folder = TempFolder::new("second");
    let first = serve_in(&folder.path).await;

    on(&first.hub, "t1", json!({"op": "play", "move": "e4"}));
    desk(
        &first.hub,
        json!({"op": "tab_rename", "tab": "t1", "name": "Mine"}),
    );
    until_file(
        &folder,
        "t1.json",
        &FRESH_T1.replace("\"Board 1\"", "\"Mine\""),
    )
    .await;
    settle(&first.hub).await;
    let before = folder.snapshot();

    let second = serve_in(&folder.path).await;
    assert!(!second.hub.saves());
    assert_eq!(
        notices(&second.hub),
        vec![notice(
            "second_program",
            &format!(
                "Another Rukh (on port {}) is using this data folder, so these boards are not \
                 being saved.",
                first.port
            )
        )]
    );

    let (_socket, hello) = view(second.port).await;
    assert_eq!(hello["boards"]["saving"], false);

    let names: Vec<String> = second
        .hub
        .read_desk(|d| d.tabs().iter().map(|t| t.name().to_string()).collect());
    assert_eq!(names, vec!["Board 1"]);
    assert_eq!(second.hub.read(|t| t.state().board_rev), 0);

    on(&second.hub, "t1", json!({"op": "play", "move": "d4"}));
    desk(&second.hub, json!({"op": "tab_new"}));
    tokio::time::sleep(Duration::from_millis(1500)).await;

    second.stop().await;
    assert_eq!(folder.snapshot(), before);

    first.stop().await;
    assert!(!folder.path.join(".lock").exists());
}

#[tokio::test]
async fn the_lock_check_tells_a_live_owner_from_a_dead_port() {
    let live = serve("web").await;
    let folder = TempFolder::new("lock");
    let lock_path = folder.path.join(".lock");

    let held = format!(
        "{{\"pid\":1,\"port\":{},\"instance\":\"{}\",\"started\":5}}\n",
        live.port,
        live.hub.instance()
    );
    fs::write(&lock_path, &held).expect("write the lock");
    assert_eq!(
        safe::hello_instance(live.port).await.as_deref(),
        Some(live.hub.instance())
    );

    match Lock::acquire(&folder.path, 47480, "newcomer", 7).await {
        Locked::Held { port } => assert_eq!(port, live.port),
        other => panic!("a live owner keeps the lock: {other:?}"),
    }
    assert_eq!(fs::read_to_string(&lock_path).expect("the lock"), held);

    let other_instance = held.replace(live.hub.instance(), "not-the-owner");
    fs::write(&lock_path, &other_instance).expect("write the lock");
    let Locked::Ours(lock) = Lock::acquire(&folder.path, 47480, "newcomer", 7).await else {
        panic!("a different instance on that port is a stale lock");
    };
    lock.release();
    assert!(!lock_path.exists());

    let dead = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let dead_port = dead.local_addr().expect("an address").port();
    drop(dead);
    assert_eq!(safe::hello_instance(dead_port).await, None);

    fs::write(
        &lock_path,
        format!("{{\"pid\":1,\"port\":{dead_port},\"instance\":\"gone\",\"started\":5}}\n"),
    )
    .expect("write the lock");
    let Locked::Ours(lock) = Lock::acquire(&folder.path, 47480, "newcomer", 7).await else {
        panic!("a dead port is a stale lock");
    };

    let written: Value =
        serde_json::from_str(&fs::read_to_string(&lock_path).expect("the lock")).expect("JSON");
    assert_eq!(
        written,
        json!({"pid": std::process::id(), "port": 47480, "instance": "newcomer", "started": 7})
    );

    #[cfg(windows)]
    {
        assert!(
            fs::write(&lock_path, &other_instance).is_err(),
            "a held lock cannot be replaced"
        );
        lock.release();
        assert!(!lock_path.exists());
    }

    #[cfg(not(windows))]
    {
        fs::write(&lock_path, &other_instance).expect("write the lock");
        lock.release();
        assert!(
            lock_path.exists(),
            "a lock that names another program is left alone"
        );
    }

    live.stop().await;
}

// ------------------------------------------------------------------ the safe write

#[test]
fn a_rename_that_keeps_failing_leaves_name_pending_and_the_next_write_lands() {
    let folder = TempFolder::new("pending");
    let target = folder.path.join("t1.json");
    fs::write(&target, "old").expect("write the target");

    let tries = AtomicU64::new(0);
    let failed = safe::write_with(&target, b"new", |_, _| {
        tries.fetch_add(1, Ordering::Relaxed);
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    });

    assert!(matches!(failed, Err(WriteFailure::Held)), "{failed:?}");
    assert_eq!(tries.load(Ordering::Relaxed), 5);
    assert_eq!(fs::read_to_string(&target).expect("target"), "old");
    assert_eq!(
        fs::read_to_string(safe::pending_path(&target)).expect("pending"),
        "new"
    );

    safe::write(&target, b"newer").expect("the next write lands");
    assert_eq!(fs::read_to_string(&target).expect("target"), "newer");
    assert!(!safe::pending_path(&target).exists());

    let left: Vec<String> = fs::read_dir(&folder.path)
        .expect("the folder")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, vec!["t1.json"]);
}

#[cfg(windows)]
fn hold_open(path: &Path) -> fs::File {
    use std::os::windows::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(path)
        .expect("hold the file open")
}

#[cfg(windows)]
#[test]
fn a_file_held_open_keeps_name_pending_and_saves_at_the_next_write() {
    let folder = TempFolder::new("held");
    let target = folder.path.join("t1.json");
    fs::write(&target, "old").expect("write the target");

    let held = hold_open(&target);
    let failed = safe::write(&target, b"new");
    assert!(matches!(failed, Err(WriteFailure::Held)), "{failed:?}");
    assert_eq!(
        fs::read_to_string(safe::pending_path(&target)).expect("pending"),
        "new"
    );

    drop(held);
    assert_eq!(fs::read_to_string(&target).expect("target"), "old");

    safe::write(&target, b"newer").expect("the next write lands");
    assert_eq!(fs::read_to_string(&target).expect("target"), "newer");
    assert!(!safe::pending_path(&target).exists());
}

#[cfg(windows)]
#[tokio::test]
async fn a_board_file_held_open_is_reported_to_the_page_and_saved_later() {
    let folder = TempFolder::new("report");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    let (mut socket, _) = view(server.port).await;

    intent(&mut socket, 1, json!({"op": "play", "move": "e4"})).await;
    until_file(&folder, "t1.json", FRESH_T1).await;

    let held = hold_open(&folder.boards().join("t1.json"));
    intent(&mut socket, 2, json!({"op": "play", "move": "e5"})).await;

    let boards = loop {
        let message = next_any(&mut socket).await;
        if message["t"] == "boards" {
            break message;
        }
    };
    assert_eq!(
        boards,
        json!({"t": "boards", "saving": true, "notices": [
            {"id": 1, "code": "write_failed", "text": "Could not save boards/t1.json: another program has it open."}
        ]})
    );
    let expected = saved_text(&hub, "t1");
    assert_eq!(folder.read("t1.json.pending"), expected);

    drop(held);
    intent(&mut socket, 3, json!({"op": "play", "move": "Nf3"})).await;
    let expected = saved_text(&hub, "t1");
    until_file(&folder, "t1.json", &expected).await;
    until("the pending file gone", || {
        !folder.exists("t1.json.pending")
    })
    .await;

    server.stop().await;
}

// ------------------------------------------------------------------ files that are not quite right

/// Writes raw bytes under `boards/`, making its folder.
fn put_bytes(folder: &TempFolder, relative: &str, bytes: &[u8]) {
    let path = folder.boards().join(relative);
    fs::create_dir_all(path.parent().expect("a parent")).expect("make the folder");
    fs::write(path, bytes).expect("write the test file");
}

const NOT_UTF8: &[u8] = &[0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x7b, 0xff];

const ONE_TAB_INDEX: &str =
    "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\"], \"next_tab\": 2, \"next_game_id\": 2 }\n";

#[tokio::test]
async fn an_index_that_is_not_text_goes_to_broken_and_is_never_written_over() {
    let folder = TempFolder::new("index-bytes");
    folder.put("t1.json", FRESH_T1);
    put_bytes(&folder, "index.json", NOT_UTF8);

    let server = serve_in(&folder.path).await;
    assert_eq!(
        notices(&server.hub),
        vec![notice("index_rebuilt", INDEX_REBUILT)]
    );

    let moved = only_name(&folder, "broken", "index.");
    assert_eq!(
        fs::read(folder.boards().join("broken").join(moved)).expect("the moved index"),
        NOT_UTF8
    );

    server.stop().await;
    assert_eq!(folder.read("index.json"), ONE_TAB_INDEX);
}

#[tokio::test]
async fn a_tab_file_that_is_not_text_goes_to_broken_whole() {
    let folder = TempFolder::new("tab-bytes");
    folder.put("index.json", ONE_TAB_INDEX);
    folder.put("t1.json", FRESH_T1);
    put_bytes(&folder, "t2.json", NOT_UTF8);

    let server = serve_in(&folder.path).await;
    let moved = only_name(&folder, "broken", "t2.");

    assert_eq!(
        notices(&server.hub),
        vec![notice(
            "broken",
            &format!(
                "The saved board t2.json could not be read: the file is not UTF-8 text. It was \
                 moved to broken/{moved}."
            )
        )]
    );
    assert!(!folder.exists("t2.json"));
    assert_eq!(
        fs::read(folder.boards().join("broken").join(moved)).expect("the moved file"),
        NOT_UTF8
    );

    server.stop().await;
}

#[tokio::test]
async fn a_tab_file_saved_with_a_byte_order_mark_loads() {
    let folder = TempFolder::new("bom");
    folder.put("index.json", ONE_TAB_INDEX);
    folder.put("t1.json", &format!("\u{feff}{FRESH_T1}"));

    let server = serve_in(&folder.path).await;
    assert!(
        notices(&server.hub).is_empty(),
        "{:?}",
        notices(&server.hub)
    );
    assert_eq!(saved_text(&server.hub, "t1"), FRESH_T1);

    server.stop().await;
}

#[tokio::test]
async fn a_file_named_beyond_the_largest_board_number_goes_to_broken() {
    let folder = TempFolder::new("too-big");
    folder.put(
        "t4294967295.json",
        &FRESH_T1.replace("\"t1\"", "\"t4294967295\""),
    );

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    let moved = only_name(&folder, "broken", "t4294967295.");

    assert_eq!(
        notices(&hub),
        vec![notice(
            "broken",
            &format!(
                "The saved board t4294967295.json could not be read: its number is above \
                 t999999999, the largest a board may have. It was moved to broken/{moved}."
            )
        )]
    );

    assert_eq!(desk(&hub, json!({"op": "tab_new"})), json!({"tab": "t2"}));
    let ids: Vec<String> = hub.read_desk(|d| d.tabs().iter().map(|t| t.id().to_string()).collect());
    assert_eq!(ids, vec!["t1", "t2"]);

    server.stop().await;
}

#[tokio::test]
async fn a_newer_pending_copy_is_loaded_and_then_put_in_place() {
    let folder = TempFolder::new("pending-newer");
    folder.put("index.json", ONE_TAB_INDEX);
    folder.put("t1.json", FRESH_T1);
    tokio::time::sleep(Duration::from_millis(50)).await;
    folder.put("t1.json.pending", TWO_TABS_T1);

    let server = serve_in(&folder.path).await;
    assert!(
        notices(&server.hub).is_empty(),
        "{:?}",
        notices(&server.hub)
    );
    assert_eq!(saved_text(&server.hub, "t1"), TWO_TABS_T1);

    until_file(&folder, "t1.json", TWO_TABS_T1).await;
    until("the pending copy gone", || {
        !folder.exists("t1.json.pending")
    })
    .await;

    server.stop().await;
}

#[tokio::test]
async fn an_older_pending_copy_gives_way_to_the_tab_file() {
    let folder = TempFolder::new("pending-older");
    folder.put("index.json", ONE_TAB_INDEX);
    folder.put("t1.json.pending", FRESH_T1);
    tokio::time::sleep(Duration::from_millis(50)).await;
    folder.put("t1.json", TWO_TABS_T1);

    let server = serve_in(&folder.path).await;
    assert_eq!(saved_text(&server.hub, "t1"), TWO_TABS_T1);

    server.stop().await;
    assert_eq!(folder.read("t1.json"), TWO_TABS_T1);
}

#[tokio::test]
async fn a_pending_copy_with_no_tab_file_is_loaded() {
    let folder = TempFolder::new("pending-alone");
    folder.put("index.json", ONE_TAB_INDEX);
    folder.put("t1.json.pending", TWO_TABS_T1);

    let server = serve_in(&folder.path).await;
    assert!(
        notices(&server.hub).is_empty(),
        "{:?}",
        notices(&server.hub)
    );
    assert_eq!(saved_text(&server.hub, "t1"), TWO_TABS_T1);
    until_file(&folder, "t1.json", TWO_TABS_T1).await;

    server.stop().await;
}

#[tokio::test]
async fn a_damaged_pending_copy_goes_to_broken_and_the_tab_file_loads() {
    let folder = TempFolder::new("pending-damaged");
    folder.put("index.json", ONE_TAB_INDEX);
    folder.put("t1.json", FRESH_T1);
    tokio::time::sleep(Duration::from_millis(50)).await;
    folder.put("t1.json.pending", "{ \"v\": 1, \"id\": \"t1\", \"na");

    let server = serve_in(&folder.path).await;
    let moved = only_name(&folder, "broken", "t1.json.pending.");

    let codes: Vec<String> = notices(&server.hub).into_iter().map(|(c, _)| c).collect();
    assert_eq!(codes, vec!["broken"]);
    assert_eq!(saved_text(&server.hub, "t1"), FRESH_T1);
    assert_eq!(
        folder.read(&format!("broken/{moved}")),
        "{ \"v\": 1, \"id\": \"t1\", \"na"
    );

    server.stop().await;
}

const TWO_TABS_INDEX_SWAPPED: &str =
    "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t2\", \"t1\"], \"next_tab\": 3, \"next_game_id\": 3 }\n";

fn order(hub: &Hub) -> Vec<String> {
    hub.read_desk(|d| d.tabs().iter().map(|t| t.id().to_string()).collect())
}

#[tokio::test]
async fn a_newer_pending_index_gives_the_order_and_selection_and_is_then_put_in_place() {
    let folder = TempFolder::new("pending-index-newer");
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("t2.json", TWO_TABS_T2);
    folder.put("index.json", TWO_TABS_INDEX);
    tokio::time::sleep(Duration::from_millis(50)).await;
    folder.put("index.json.pending", TWO_TABS_INDEX_SWAPPED);

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    assert!(notices(&hub).is_empty(), "{:?}", notices(&hub));
    assert_eq!(order(&hub), vec!["t2", "t1"]);
    assert_eq!(hub.selected(), id("t1"));

    until_file(&folder, "index.json", TWO_TABS_INDEX_SWAPPED).await;
    until("the pending index gone", || {
        !folder.exists("index.json.pending")
    })
    .await;

    server.stop().await;
}

#[tokio::test]
async fn an_older_pending_index_gives_way_to_the_index() {
    let folder = TempFolder::new("pending-index-older");
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("t2.json", TWO_TABS_T2);
    folder.put("index.json.pending", TWO_TABS_INDEX_SWAPPED);
    tokio::time::sleep(Duration::from_millis(50)).await;
    folder.put("index.json", TWO_TABS_INDEX);

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    assert!(notices(&hub).is_empty(), "{:?}", notices(&hub));
    assert_eq!(order(&hub), vec!["t1", "t2"]);
    assert_eq!(hub.selected(), id("t2"));

    until("the older pending index gone", || {
        !folder.exists("index.json.pending")
    })
    .await;

    server.stop().await;
    assert_eq!(folder.read("index.json"), TWO_TABS_INDEX);
}

#[tokio::test]
async fn a_damaged_pending_index_goes_to_broken_and_the_index_is_used() {
    let folder = TempFolder::new("pending-index-damaged");
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("t2.json", TWO_TABS_T2);
    folder.put("index.json", TWO_TABS_INDEX);
    tokio::time::sleep(Duration::from_millis(50)).await;
    folder.put("index.json.pending", "{ \"v\": 1, \"order\": \"t2\" ");

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    let moved = only_name(&folder, "broken", "index.json.pending.");

    let codes: Vec<String> = notices(&hub).into_iter().map(|(c, _)| c).collect();
    assert_eq!(codes, vec!["broken"]);
    assert_eq!(order(&hub), vec!["t1", "t2"]);
    assert_eq!(hub.selected(), id("t2"));
    assert!(!folder.exists("index.json.pending"));
    assert_eq!(
        folder.read(&format!("broken/{moved}")),
        "{ \"v\": 1, \"order\": \"t2\" "
    );

    server.stop().await;
    assert_eq!(folder.read("index.json"), TWO_TABS_INDEX);
}

#[tokio::test]
async fn a_broken_folder_that_is_a_file_still_loads_the_boards_but_saves_nothing() {
    let folder = TempFolder::new("broken-file");
    folder.put("index.json", ONE_TAB_INDEX);
    folder.put("t1.json", FRESH_T1);
    folder.put("broken", "a file, not a folder");
    let before = folder.snapshot();

    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    assert!(!hub.saves());
    assert_eq!(saved_text(&hub, "t1"), FRESH_T1);

    let found = notices(&hub);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "folder_failed");
    assert!(
        found[0].1.starts_with(&format!(
            "Could not use the boards folder {}: ",
            folder.boards().join("broken").display()
        )),
        "{found:?}"
    );
    assert!(found[0].1.ends_with(". Boards are not being saved."));

    let (_socket, hello) = view(server.port).await;
    assert_eq!(hello["boards"]["saving"], false);

    on(&hub, "t1", json!({"op": "play", "move": "e5"}));
    server.stop().await;
    assert_eq!(folder.snapshot(), before);
}

#[cfg(windows)]
#[tokio::test]
async fn an_index_held_open_at_start_is_left_alone_and_nothing_is_saved() {
    let folder = TempFolder::new("index-held");
    folder.put("index.json", TWO_TABS_INDEX);
    folder.put("t1.json", TWO_TABS_T1);
    folder.put("t2.json", TWO_TABS_T2);
    let before = folder.snapshot();

    let held = hold_open(&folder.boards().join("index.json"));
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    assert!(!hub.saves());
    let found = notices(&hub);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "index_unreadable");
    assert!(found[0].1.starts_with("Could not read boards/index.json: "));
    assert!(found[0]
        .1
        .ends_with(". It was left as it is, and boards are not being saved."));

    on(&hub, "t1", json!({"op": "play", "move": "Nf3"}));
    server.stop().await;
    drop(held);
    assert_eq!(folder.snapshot(), before);
}

// ------------------------------------------------------------------ the saver, more

#[tokio::test]
async fn a_burst_of_changes_is_written_in_few_passes() {
    let folder = TempFolder::new("burst");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();
    settle(&hub).await;
    let start = hub.write_counts().0;

    for n in 0..200 {
        desk(
            &hub,
            json!({"op": "tab_rename", "tab": "t1", "name": format!("Name {n}")}),
        );
    }
    let expected = saved_text(&hub, "t1");
    until_file(&folder, "t1.json", &expected).await;
    settle(&hub).await;

    let writes = hub.write_counts().0 - start;
    assert!(writes < 100, "{writes} writes for 200 changes");

    server.stop().await;
}

#[test]
fn the_notices_keep_the_newest_twenty() {
    let many: Vec<(&'static str, String)> = (1..=25).map(|n| ("broken", format!("n{n}"))).collect();
    let status = crate::boards::Status::new(true, many);

    let ids: Vec<u64> = status.notices.iter().map(|n| n.id).collect();
    assert_eq!(ids, (6..=25).collect::<Vec<u64>>());
    assert_eq!(status.notices[0].text, "n6");
}

#[tokio::test]
async fn reopen_at_the_limit_is_refused_and_the_closed_file_stays() {
    let folder = TempFolder::new("reopen-limit");
    let server = serve_in(&folder.path).await;
    let (mut socket, _) = view(server.port).await;

    intent(&mut socket, 1, json!({"op": "play", "move": "e4"})).await;
    intent(&mut socket, 2, json!({"op": "tab_new"})).await;
    intent(&mut socket, 3, json!({"op": "tab_close", "tab": "t1"})).await;
    until("the closed file", || folder.names("closed").len() == 1).await;
    let closed = folder.names("closed");

    for n in 0..11 {
        intent(&mut socket, 10 + n, json!({"op": "tab_new"})).await;
    }

    send(
        &mut socket,
        json!({"t": "intent", "id": 30, "op": "tab_reopen"}),
    )
    .await;
    let ack = ack_for(&mut socket, 30).await;
    assert_eq!(ack["error"]["code"], "tab_limit", "{ack}");
    assert_eq!(ack["error"]["message"], "Close a board first.");

    settle(&server.hub).await;
    assert_eq!(folder.names("closed"), closed);

    server.stop().await;
}

#[tokio::test]
async fn a_damaged_closed_file_goes_to_broken_and_the_next_one_comes_back() {
    let folder = TempFolder::new("reopen-damaged");
    folder.put("closed/t5.2000.json", "not json");
    folder.put("closed/t4.1000.json", &FRESH_T1.replace("\"t1\"", "\"t4\""));

    let server = serve_in(&folder.path).await;
    let (mut socket, _) = view(server.port).await;

    send(
        &mut socket,
        json!({"t": "intent", "id": 1, "op": "tab_reopen"}),
    )
    .await;
    let ack = ack_for(&mut socket, 1).await;
    assert_eq!(
        ack["result"],
        json!({"tab": "t4", "selected": "t4"}),
        "{ack}"
    );

    let moved = only_name(&folder, "broken", "t5.");
    let why = damage_of("not json");
    assert_eq!(
        notices(&server.hub),
        vec![notice(
            "broken",
            &format!(
                "The saved board closed/t5.2000.json could not be read: {why}. It was moved to \
                 broken/{moved}."
            )
        )]
    );

    server.stop().await;
}

#[cfg(windows)]
#[tokio::test]
async fn a_tab_write_that_fails_holds_back_the_index() {
    let folder = TempFolder::new("order");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    until_file(&folder, "index.json", ONE_TAB_INDEX).await;
    settle(&hub).await;

    let held = hold_open(&folder.boards().join("t1.json"));
    on(&hub, "t1", json!({"op": "play", "move": "e5"}));
    desk(&hub, json!({"op": "tab_new"}));

    until("the failure reported", || {
        notices(&hub).iter().any(|(code, _)| code == "write_failed")
    })
    .await;
    assert!(folder.exists("t2.json"));
    assert_eq!(folder.read("index.json"), ONE_TAB_INDEX);

    drop(held);
    on(&hub, "t1", json!({"op": "play", "move": "Nf3"}));
    until_file(
        &folder,
        "index.json",
        "{ \"v\": 1, \"selected\": \"t2\", \"order\": [\"t1\", \"t2\"], \"next_tab\": 3, \"next_game_id\": 3 }\n",
    )
    .await;

    server.stop().await;
}

#[cfg(windows)]
#[tokio::test]
async fn closing_a_tab_removes_the_copy_a_held_write_left() {
    let folder = TempFolder::new("close-pending");
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    until_file(&folder, "t1.json", FRESH_T1).await;

    let held = hold_open(&folder.boards().join("t1.json"));
    on(&hub, "t1", json!({"op": "play", "move": "e5"}));
    until("the pending copy", || folder.exists("t1.json.pending")).await;
    settle(&hub).await;
    drop(held);

    desk(&hub, json!({"op": "tab_new"}));
    desk(&hub, json!({"op": "tab_close", "tab": "t1"}));
    until("t1.json gone", || !folder.exists("t1.json")).await;
    until("the pending copy gone", || {
        !folder.exists("t1.json.pending")
    })
    .await;

    let name = only_name(&folder, "closed", "t1.");
    assert!(folder
        .read(&format!("closed/{name}"))
        .contains("\"san\":\"e5\""));

    server.stop().await;
}

// ------------------------------------------------------------------ the lock, more

#[tokio::test]
async fn a_second_program_cannot_take_the_folder_while_the_first_is_still_starting() {
    let folder = TempFolder::new("race");
    folder.put("t1.json", FRESH_T1);

    let silent = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let silent_port = silent.local_addr().expect("an address").port();

    let Locked::Ours(first_lock) = Lock::acquire(&folder.path, silent_port, "first", 1).await
    else {
        panic!("the first program takes the lock");
    };

    let second = crate::boards::open(Some(folder.path.clone()), 47481, "second").await;
    let first = crate::boards::open_locked(&folder.path, first_lock, silent_port, "first").await;

    let saving = [first.saving.is_some(), second.saving.is_some()];
    assert_eq!(saving.iter().filter(|s| **s).count(), 1, "{saving:?}");

    #[cfg(windows)]
    {
        assert_eq!(saving, [true, false]);
        let found: Vec<(String, String)> = second
            .status
            .notices
            .iter()
            .map(|n| (n.code.to_string(), n.text.clone()))
            .collect();
        assert_eq!(
            found,
            vec![notice(
                "second_program",
                &format!(
                    "Another Rukh (on port {silent_port}) is using this data folder, so these \
                     boards are not being saved."
                )
            )]
        );
    }

    for opened in [first, second] {
        if let Some((_, lock)) = opened.saving {
            lock.release();
        }
    }
    drop(silent);
}

#[cfg(not(windows))]
#[tokio::test]
async fn a_program_whose_lock_was_replaced_while_it_started_does_not_save() {
    let folder = TempFolder::new("replaced");
    let Locked::Ours(lock) = Lock::acquire(&folder.path, 47482, "first", 1).await else {
        panic!("the lock is free");
    };

    fs::write(
        folder.path.join(".lock"),
        "{\"pid\":1,\"port\":47483,\"instance\":\"other\",\"started\":5}\n",
    )
    .expect("replace the lock");

    let opened = crate::boards::open_locked(&folder.path, lock, 47482, "first").await;
    assert!(opened.saving.is_none());
    assert_eq!(opened.status.notices[0].code, "second_program");
}

// ------------------------------------------------------------------ the safe write, more

#[test]
fn a_rename_that_fails_for_another_reason_says_so() {
    let folder = TempFolder::new("other-reason");
    let target = folder.path.join("t1.json");
    fs::write(&target, "old").expect("write the target");

    let failed = safe::write_with(&target, b"new", |_, _| {
        Err(std::io::Error::other("the disk is full"))
    });

    match failed {
        Err(failure @ WriteFailure::NotReplaced(_)) => {
            assert_eq!(failure.reason(), "the disk is full")
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        fs::read_to_string(safe::pending_path(&target)).expect("pending"),
        "new"
    );
}

#[test]
fn a_read_only_target_is_not_called_open_in_another_program() {
    let folder = TempFolder::new("read-only");
    let target = folder.path.join("t1.json");
    fs::write(&target, "old").expect("write the target");

    let mut permissions = fs::metadata(&target).expect("metadata").permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions.clone()).expect("make it read-only");

    let failed = safe::write_with(&target, b"new", |_, _| {
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    });

    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(&target, permissions).expect("make it writable again");

    assert!(
        matches!(failed, Err(WriteFailure::NotReplaced(_))),
        "{failed:?}"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn a_pending_copy_that_could_not_be_read_is_never_removed() {
    let folder = TempFolder::new("pending-held");
    folder.put("index.json", ONE_TAB_INDEX);
    folder.put("t1.json", FRESH_T1);
    tokio::time::sleep(Duration::from_millis(50)).await;
    folder.put("t1.json.pending", TWO_TABS_T1);

    let held = hold_open(&folder.boards().join("t1.json.pending"));
    let server = serve_in(&folder.path).await;
    let hub = server.hub.clone();

    let codes: Vec<String> = notices(&hub).into_iter().map(|(c, _)| c).collect();
    assert_eq!(codes, vec!["unreadable"]);
    assert_eq!(saved_text(&hub, "t1"), FRESH_T1);
    drop(held);

    on(&hub, "t1", json!({"op": "play", "move": "e5"}));
    let expected = saved_text(&hub, "t1");
    until_file(&folder, "t1.json", &expected).await;

    server.stop().await;
    assert_eq!(folder.read("t1.json.pending"), TWO_TABS_T1);
}
