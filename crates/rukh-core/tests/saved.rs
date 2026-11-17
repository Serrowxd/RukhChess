use rukh_core::{
    tab_id_in_file_name, Damaged, Desk, Game, SavedBody, SavedIndex, SavedTab, Stopped, Tab, TabId,
    TabKind, Table, Unsaved, Variant,
};
use serde_json::{json, Value};

const VIEW: &str = "view:1";
const AI: &str = "ai:claude-code";
const NOW: u64 = 1000;

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

fn id(text: &str) -> TabId {
    text.parse().expect("a tab id")
}

fn intent(table: &mut Table, by: &str, intent: Value) {
    table
        .apply(by, &intent.to_string(), NOW)
        .unwrap_or_else(|e| panic!("{intent}: {e}"));
}

fn on(desk: &mut Desk, tab: &str, by: &str, intent: Value) -> Value {
    desk.apply_on(id(tab), by, &intent.to_string(), NOW, None)
        .unwrap_or_else(|e| panic!("{intent}: {e}"))
        .result
}

fn tab_intent(desk: &mut Desk, intent: Value) -> Value {
    desk.apply(VIEW, &intent.to_string(), NOW)
        .unwrap_or_else(|e| panic!("{intent}: {e}"))
        .result
}

fn load(text: &str) -> Result<Tab, Damaged> {
    Tab::from_saved(&SavedTab::from_text(text)?)
}

fn damage(text: &str) -> String {
    load(text).expect_err("the file should be refused").0
}

/// The wire state without what is not saved.
fn wire(table: &Table) -> Value {
    let mut state = serde_json::to_value(table.state()).expect("state is JSON");
    state.as_object_mut().expect("an object").remove("recent");
    state
}

fn node_ids(table: &Table) -> Vec<(u32, Option<u32>, Option<String>)> {
    table
        .game()
        .snapshot()
        .nodes
        .iter()
        .map(|n| (n.id, n.parent, n.uci.clone()))
        .collect()
}

fn round_trip(table: &Table) -> Table {
    let text = SavedTab {
        id: id("t1"),
        name: "Board 1".into(),
        body: SavedBody::Free {
            source: None,
            table: Box::new(table.to_saved()),
        },
    }
    .to_text();

    match SavedTab::from_text(&text).expect("readable").body {
        SavedBody::Free { table, .. } => Table::from_saved("again", &table).expect("replays"),
        other => panic!("not a free tab: {other:?}"),
    }
}

/// A side line, notes, arrows, highlights, evaluations, a running match, and a tip off screen.
fn busy_table() -> Table {
    let mut t = Table::new("first");

    intent(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    intent(&mut t, VIEW, json!({"op": "play", "move": "e5"}));
    intent(
        &mut t,
        VIEW,
        json!({"op": "play", "move": "Nf3", "note": "The main move."}),
    );
    intent(&mut t, VIEW, json!({"op": "play", "move": "Nc6"}));
    intent(
        &mut t,
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );
    intent(
        &mut t,
        AI,
        json!({"op": "annotate", "node": 3, "arrows": [{"from": "f3", "to": "e5", "color": "red"}]}),
    );
    intent(&mut t, VIEW, json!({"op": "goto", "node": 2}));
    intent(&mut t, VIEW, json!({"op": "play", "move": "Bc4"}));
    intent(
        &mut t,
        VIEW,
        json!({"op": "annotate", "node": 5, "nag": "?!", "highlights": [{"square": "c4", "color": "blue"}]}),
    );
    intent(
        &mut t,
        VIEW,
        json!({"op": "set_eval", "node": 5, "eval": {"cp": 12, "depth": 18, "pv": ["g8f6", "d2d3"], "best": "g8f6"}}),
    );
    intent(
        &mut t,
        VIEW,
        json!({"op": "set_eval", "node": 4, "eval": {"mate": -3, "depth": 22, "pv": []}}),
    );
    intent(
        &mut t,
        VIEW,
        json!({"op": "annotate", "node": 0, "note": "Start here.", "arrows": [{"from": "e2", "to": "e4"}]}),
    );

    t
}

#[test]
fn the_example_tab_file_loads_as_written() {
    let tab = load(EXAMPLE_TAB).expect("the example loads");
    let table = tab.table();
    let game = table.game();

    assert_eq!(tab.id(), id("t4"));
    assert_eq!(tab.name(), "Italian, the Bc5 line");
    assert_eq!(tab.kind(), TabKind::Free);
    assert_eq!(tab.source(), None);

    assert_eq!(table.game_id(), 7);
    assert_eq!(table.board_rev(), 31);
    assert_eq!(table.stopped_by_person(), None);
    assert_eq!(game.current(), 5);
    assert_eq!(game.history(), vec!["e4", "e5", "Bc4"]);
    assert_eq!(game.node(2).unwrap().children, vec![3, 5]);

    let m = table.match_state();
    assert!(m.active);
    assert_eq!(m.tip, 4);
    assert_eq!(
        serde_json::to_value(m.seats).unwrap(),
        json!({"white": "human", "black": "ai"})
    );
    assert_eq!(table.tip_result(), None);

    let nf3 = game.node(3).unwrap();
    assert_eq!(nf3.note, "The main move.");
    assert_eq!(
        serde_json::to_value(&nf3.arrows).unwrap(),
        json!([{"from": "f3", "to": "e5", "color": "red", "knight": true, "source": "ai"}])
    );

    let bc4 = game.node(5).unwrap();
    assert_eq!(bc4.nag, "?!");
    assert_eq!(
        bc4.fen,
        "rnbqkbnr/pppp1ppp/8/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR b KQkq - 1 2"
    );
    assert_eq!(
        serde_json::to_value(&bc4.eval).unwrap(),
        json!({"cp": 12, "depth": 18, "pv": ["g8f6", "d2d3"], "best": "g8f6"})
    );

    let state = serde_json::to_value(table.state()).unwrap();
    assert_eq!(state["match"]["to_move"], Value::Null);
    assert_eq!(state["match"]["live"], json!(false));
    assert_eq!(state["game"]["path"], json!([0, 1, 2, 5]));
}

#[test]
fn the_example_tab_file_writes_back_byte_for_byte() {
    let expected = format!("{EXAMPLE_TAB}\n");

    assert_eq!(
        SavedTab::from_text(EXAMPLE_TAB).unwrap().to_text(),
        expected
    );
    assert_eq!(load(EXAMPLE_TAB).unwrap().to_saved().to_text(), expected);
}

#[test]
fn a_busy_table_comes_back_with_the_same_wire_state_and_node_ids() {
    let table = busy_table();

    assert_eq!(table.game().current(), 5);
    assert_eq!(table.match_state().tip, 4);
    assert!(table.recent().len() > 1);

    let back = round_trip(&table);

    assert_eq!(wire(&back), wire(&table));
    assert_eq!(node_ids(&back), node_ids(&table));
    assert_eq!(back.instance(), "again");
    assert_eq!(back.rev(), 0);
    assert!(back.recent().is_empty());

    let root = back.game().node(0).unwrap();
    assert_eq!(root.note, "Start here.");
    assert_eq!(
        serde_json::to_value(&root.arrows).unwrap(),
        json!([{"from": "e2", "to": "e4", "color": "green", "knight": false, "source": "user"}])
    );
}

#[test]
fn a_restored_table_plays_on_from_its_tip() {
    let mut back = round_trip(&busy_table());
    intent(&mut back, VIEW, json!({"op": "goto", "node": 4}));
    intent(&mut back, VIEW, json!({"op": "play", "move": "Bb5"}));
    assert_eq!(back.match_state().tip, 6);

    let applied = back
        .apply(AI, &json!({"op": "play", "move": "Nf6"}).to_string(), NOW)
        .expect("the AI moves at the tip");

    assert_eq!(applied.result["node"], json!(7));
    assert_eq!(back.match_state().tip, 7);
    assert_eq!(back.game().node(7).unwrap().parent, Some(6));
}

#[test]
fn a_chess960_game_round_trips() {
    let mut t = Table::new("");
    intent(&mut t, VIEW, json!({"op": "new_game", "chess960": 100}));
    intent(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    intent(&mut t, VIEW, json!({"op": "play", "move": "e5"}));
    intent(&mut t, VIEW, json!({"op": "back"}));
    intent(&mut t, VIEW, json!({"op": "play", "move": "d5"}));

    let saved = t.to_saved();
    assert_eq!(saved.game.variant, Variant::Chess960);
    assert_eq!(saved.game.chess960, Some(100));

    let back = round_trip(&t);
    assert_eq!(back.game().chess960_number(), Some(100));
    assert_eq!(back.game().start_fen(), t.game().start_fen());
    assert_eq!(wire(&back), wire(&t));
    assert_eq!(node_ids(&back), node_ids(&t));
}

#[test]
fn a_chess960_castling_move_round_trips() {
    let fen = "1r2k1r1/6p1/8/8/8/8/8/1R2K1R1 w GBgb - 0 1";
    let mut t = Table::new("");
    intent(&mut t, VIEW, json!({"op": "new_game", "fen": fen}));
    intent(&mut t, VIEW, json!({"op": "play", "move": "O-O"}));

    assert_eq!(t.game().node(1).unwrap().uci.as_deref(), Some("e1g1"));

    let back = round_trip(&t);
    assert_eq!(back.game().variant(), Variant::Chess960);
    assert_eq!(wire(&back), wire(&t));
}

#[test]
fn a_game_from_a_custom_fen_round_trips() {
    let fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 10";
    let mut t = Table::new("");
    intent(&mut t, VIEW, json!({"op": "new_game", "fen": fen}));
    intent(&mut t, VIEW, json!({"op": "play", "move": "Bb5"}));
    intent(&mut t, VIEW, json!({"op": "play", "move": "a6"}));
    intent(&mut t, VIEW, json!({"op": "to_start"}));
    intent(&mut t, VIEW, json!({"op": "play", "move": "d4"}));

    let saved = t.to_saved();
    assert_eq!(saved.game.start_fen, fen);
    assert_eq!(saved.game.variant, Variant::Standard);
    assert_eq!(saved.game.current, 3);

    let back = round_trip(&t);
    assert_eq!(back.game().node(0).unwrap().ply, 18);
    assert_eq!(wire(&back), wire(&t));
    assert_eq!(node_ids(&back), node_ids(&t));
}

#[test]
fn game_saved_form_keeps_node_ids() {
    let mut game = Game::standard();
    game.play("e4").unwrap();
    game.play("c5").unwrap();
    game.back();
    game.play("e5").unwrap();
    game.goto(0).unwrap();
    game.play("d4").unwrap();

    let back = Game::from_saved(&game.to_saved()).unwrap();

    assert_eq!(back.current(), 4);
    assert_eq!(back.node(1).unwrap().children, vec![2, 3]);
    assert_eq!(back.node(0).unwrap().children, vec![1, 4]);
    assert_eq!(
        serde_json::to_value(back.snapshot()).unwrap(),
        serde_json::to_value(game.snapshot()).unwrap()
    );
}

#[test]
fn an_illegal_move_is_refused_by_name() {
    let text = EXAMPLE_TAB.replace(r#""uci":"b8c6""#, r#""uci":"b8b6""#);
    assert_eq!(
        damage(&text),
        "move id 4 (Nc6): b8b6 is not a legal move after node 3"
    );
}

#[test]
fn a_gap_in_the_ids_is_refused_by_name() {
    let text = EXAMPLE_TAB.replace(r#"{"id":5,"#, r#"{"id":6,"#);
    assert_eq!(
        damage(&text),
        "move id 6 (Bc4) comes out as node 5; ids count up from 1 with no gaps"
    );
}

#[test]
fn a_missing_from_node_is_refused_by_name() {
    let text = EXAMPLE_TAB.replace(r#""id":5,"from":2"#, r#""id":5,"from":9"#);
    assert_eq!(
        damage(&text),
        "move id 5 (Bc4) is played from node 9, which is not in the game"
    );
}

#[test]
fn a_san_that_differs_from_the_replay_is_refused_by_name() {
    let text = EXAMPLE_TAB.replace(r#""uci":"e7e5","san":"e5""#, r#""uci":"e7e5","san":"e6""#);
    assert_eq!(
        damage(&text),
        "move id 2 (e6): e7e5 is e5 in this position, not e6"
    );
}

#[test]
fn a_duplicate_id_is_refused_by_name() {
    let text = EXAMPLE_TAB.replace(r#"{"id":4,"#, r#"{"id":3,"#);
    assert_eq!(damage(&text), "move id 3 appears twice");
}

#[test]
fn the_same_move_twice_from_one_node_is_refused_by_name() {
    let text = EXAMPLE_TAB.replace(
        "\n  ] }",
        ",\n    {\"id\":6,\"from\":0,\"uci\":\"e2e4\",\"san\":\"e4\"}\n  ] }",
    );
    assert_eq!(
        damage(&text),
        "move id 6 (e4) repeats move id 1, the same move from the same node"
    );
}

#[test]
fn a_move_written_in_another_form_is_refused_by_name() {
    let text = EXAMPLE_TAB.replace(r#""uci":"e2e4""#, r#""uci":"E2E4""#);
    assert_eq!(
        damage(&text),
        "move id 1 (e4): the move is written E2E4 but plays as e2e4"
    );
}

#[test]
fn a_bad_glyph_is_refused_by_name() {
    let text = EXAMPLE_TAB.replace(r#""nag":"?!""#, r#""nag":"?!?""#);
    assert_eq!(
        damage(&text),
        "move id 5 (Bc4): ?!? is not a move glyph; use one of ! ? !! ?? !? ?!"
    );
}

#[test]
fn a_shown_node_or_tip_outside_the_game_is_refused() {
    let text = EXAMPLE_TAB.replace(r#""current": 5"#, r#""current": 9"#);
    assert_eq!(damage(&text), "current is node 9, which is not in the game");

    let text = EXAMPLE_TAB.replace(r#""tip": 4"#, r#""tip": 9"#);
    assert_eq!(
        damage(&text),
        "the match tip is node 9, which is not in the game"
    );
}

#[test]
fn an_unknown_version_or_unreadable_text_is_refused() {
    let text = EXAMPLE_TAB.replace(r#""v": 1"#, r#""v": 2"#);
    assert_eq!(
        damage(&text),
        "the file is version 2, and this Rukh reads version 1"
    );

    let text = EXAMPLE_TAB.replace(r#""v": 1, "#, "");
    assert_eq!(damage(&text), "the file has no version field \"v\"");

    assert!(damage(&EXAMPLE_TAB[..200]).starts_with("the file is not readable JSON: "));
    assert_eq!(damage("[1, 2]"), "the file is not a JSON object");

    let text = EXAMPLE_TAB.replace(r#""kind": "free""#, r#""kind": "study""#);
    assert_eq!(
        damage(&text),
        "kind is \"study\"; it is \"free\", \"game\" or \"reps\""
    );

    let text = EXAMPLE_TAB.replace(r#""game_id": 7"#, r#""game_id": "seven""#);
    assert!(damage(&text).starts_with("a field is missing or of the wrong type: "));

    let text = EXAMPLE_TAB.replace(r#"{"id":4,"from":3,"#, r#"{"id":4,"from":"three","#);
    assert!(damage(&text).starts_with("move 4 of the list cannot be read: "));

    let text = EXAMPLE_TAB.replace(r#""current": 5,"#, r#""current": 5, "stopped": "paused","#);
    assert!(damage(&text).starts_with("a field is missing or of the wrong type: "));
}

#[test]
fn a_chess960_number_on_a_standard_game_is_refused() {
    let text = EXAMPLE_TAB.replace(r#""chess960": null"#, r#""chess960": 5"#);
    assert_eq!(
        damage(&text),
        "chess960 is 5 on a game whose variant is standard"
    );
}

#[test]
fn a_stopped_match_stays_stopped() {
    let mut desk = Desk::restore("first", &SavedIndex::default(), Vec::new());
    on(
        &mut desk,
        "t1",
        AI,
        json!({"op": "claim_seat", "seat": "black"}),
    );
    on(&mut desk, "t1", VIEW, json!({"op": "match_stop"}));

    let text = desk.saved_tab(id("t1")).unwrap().to_text();
    assert!(text.contains("\n  \"stopped\": \"match_stop\",\n"));

    let tab = load(&text).unwrap();
    assert_eq!(tab.table().stopped_by_person(), Some("match_stop"));
    assert_eq!(tab.to_saved().to_text(), text);

    let mut desk = Desk::restore("second", &desk.saved_index(), vec![tab]);
    let err = desk
        .apply_on(
            id("t1"),
            AI,
            &json!({"op": "claim_seat", "seat": "black"}).to_string(),
            NOW,
            None,
        )
        .expect_err("the person's Stop holds");

    assert_eq!(err.code(), "bad_input");
    assert!(err.to_string().starts_with(
        "The person stopped the match on the board, so wait does not start another one."
    ));
    assert!(!desk.table(id("t1")).unwrap().match_state().active);
}

#[test]
fn stopped_is_left_out_when_unset_and_reads_all_three_values() {
    let text = load(EXAMPLE_TAB).unwrap().to_saved().to_text();
    assert!(!text.contains("stopped"));

    for (name, value) in [
        ("match_stop", Stopped::MatchStop),
        ("new_game", Stopped::NewGame),
        ("seats", Stopped::Seats),
    ] {
        let edited = EXAMPLE_TAB.replace(
            "\n  \"moves\"",
            &format!("\n  \"stopped\": \"{name}\",\n  \"moves\""),
        );

        let saved = SavedTab::from_text(&edited).unwrap();
        match &saved.body {
            SavedBody::Free { table, .. } => assert_eq!(table.stopped, Some(value)),
            other => panic!("{other:?}"),
        }

        assert_eq!(saved.to_text(), format!("{edited}\n"));
        assert_eq!(
            load(&edited).unwrap().table().stopped_by_person(),
            Some(name)
        );
    }
}

#[test]
fn two_tabs_are_saved_as_these_three_files() {
    let mut desk = Desk::restore("first", &SavedIndex::default(), Vec::new());
    on(&mut desk, "t1", VIEW, json!({"op": "play", "move": "e4"}));
    on(&mut desk, "t1", VIEW, json!({"op": "play", "move": "e5"}));
    on(
        &mut desk,
        "t1",
        VIEW,
        json!({"op": "annotate", "note": "Open game.", "highlights": [{"square": "e5", "color": "blue"}]}),
    );
    tab_intent(&mut desk, json!({"op": "tab_new", "name": "Endgame"}));
    on(&mut desk, "t2", VIEW, json!({"op": "play", "move": "d4"}));

    assert_eq!(desk.saved_index().to_text(), TWO_TABS_INDEX);
    assert_eq!(desk.saved_tab(id("t1")).unwrap().to_text(), TWO_TABS_T1);
    assert_eq!(desk.saved_tab(id("t2")).unwrap().to_text(), TWO_TABS_T2);
}

#[test]
fn two_tabs_come_back_with_their_order_and_selection() {
    let index = SavedIndex::from_text(TWO_TABS_INDEX).unwrap();
    let tabs = vec![load(TWO_TABS_T2).unwrap(), load(TWO_TABS_T1).unwrap()];

    let desk = Desk::restore("second", &index, tabs);

    let order: Vec<String> = desk.tabs().iter().map(|t| t.id().to_string()).collect();
    assert_eq!(order, vec!["t1", "t2"]);
    assert_eq!(desk.selected(), id("t2"));
    assert_eq!(desk.rev(), 0);
    assert_eq!(desk.instance(), "second");
    assert_eq!(desk.saved_index().to_text(), TWO_TABS_INDEX);

    let frame: Value = serde_json::from_str(&desk.frame(NOW)).unwrap();
    assert_eq!(frame["instance"], json!("second"));
    assert_eq!(frame["rev"], json!(0));
    assert_eq!(frame["tab"], json!("t2"));
    assert_eq!(frame["state"]["game_id"], json!(2));
    assert_eq!(
        frame["tabs"],
        json!([
            {"id": "t1", "name": "Board 1", "kind": "free", "mark": null},
            {"id": "t2", "name": "Endgame", "kind": "free", "mark": null}
        ])
    );
}

#[test]
fn the_example_index_reads_and_writes_back() {
    let text =
        "{ \"v\": 1, \"selected\": \"t4\", \"order\": [\"t1\", \"t2\", \"t4\"], \"next_tab\": 5, \"next_game_id\": 9 }";

    let index = SavedIndex::from_text(text).unwrap();
    assert_eq!(index.selected, Some(id("t4")));
    assert_eq!(index.order, vec![id("t1"), id("t2"), id("t4")]);
    assert_eq!(index.next_tab, 5);
    assert_eq!(index.next_game_id, 9);
    assert_eq!(index.to_text(), format!("{text}\n"));
}

#[test]
fn a_damaged_index_is_refused() {
    let good = "{ \"v\": 1, \"selected\": \"t4\", \"order\": [\"t1\"], \"next_tab\": 5, \"next_game_id\": 9 }";
    let refuse = |text: &str| SavedIndex::from_text(text).expect_err(text).0;

    assert_eq!(
        refuse(&good.replace("\"v\": 1", "\"v\": 3")),
        "the file is version 3, and this Rukh reads version 1"
    );
    assert!(refuse("{ \"v\": 1, ").starts_with("the file is not readable JSON: "));
    assert!(
        refuse(&good.replace("\"next_tab\": 5", "\"next_tab\": \"5\""))
            .starts_with("a field is missing or of the wrong type: ")
    );
    assert!(refuse(&good.replace("[\"t1\"]", "[\"board\"]"))
        .starts_with("a field is missing or of the wrong type: \"board\" is not a board id"));
    assert!(
        refuse(&good.replace("\"selected\": \"t4\"", "\"selected\": 4"))
            .starts_with("a field is missing or of the wrong type: ")
    );
}

#[test]
fn the_rebuilt_index_matches_the_example() {
    let t1 = load(&TWO_TABS_T1.replace("\"game_id\": 1", "\"game_id\": 3")).unwrap();
    let t2 = load("{ \"v\": 1, \"id\": \"t2\", \"name\": \"Reps\", \"kind\": \"reps\" }").unwrap();
    let t4 = load(EXAMPLE_TAB).unwrap();

    let mut index = SavedIndex::default();
    for name in [
        "t1.json",
        "t2.json",
        "t4.json",
        "t3.1763230000000.json",
        "t5.1763239999999.json",
    ] {
        index.note_seen(tab_id_in_file_name(name).unwrap());
    }

    index.next_game_id = 8;
    assert_eq!(index.next_tab, 6);

    let desk = Desk::restore("", &index, vec![t4, t2, t1]);

    // The Reps tab takes game id 8 as it loads, so the desk's counter ends one higher.
    assert_eq!(
        desk.saved_index().to_text(),
        "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\", \"t2\", \"t4\"], \"next_tab\": 6, \"next_game_id\": 9 }\n"
    );
    assert_eq!(desk.table(id("t4")).unwrap().game_id(), 7);
    assert_eq!(desk.table(id("t1")).unwrap().game_id(), 3);
    assert_eq!(desk.table(id("t2")).unwrap().game_id(), 8);
    assert_eq!(desk.next_game_id(), 9);
}

#[test]
fn a_desk_rebuilt_with_low_counters_raises_them() {
    let index = SavedIndex::from_text(
        "{ \"v\": 1, \"selected\": \"t4\", \"order\": [\"t4\"], \"next_tab\": 2, \"next_game_id\": 1 }",
    )
    .unwrap();

    let mut desk = Desk::restore("", &index, vec![load(EXAMPLE_TAB).unwrap()]);

    assert_eq!(desk.saved_index().next_tab, 5);
    assert_eq!(desk.next_game_id(), 8);
    assert_eq!(desk.table(id("t4")).unwrap().game_id(), 7);

    let made = tab_intent(&mut desk, json!({"op": "tab_new"}));
    assert_eq!(made, json!({"tab": "t5"}));
    assert_eq!(desk.table(id("t5")).unwrap().game_id(), 8);
}

#[test]
fn the_index_order_holds_and_unnamed_tabs_follow_by_id() {
    let index = SavedIndex::from_text(
        "{ \"v\": 1, \"selected\": \"t9\", \"order\": [\"t4\", \"t9\", \"t1\"], \"next_tab\": 10, \"next_game_id\": 9 }",
    )
    .unwrap();

    let t1 = load(TWO_TABS_T1).unwrap();
    let t2 = load(TWO_TABS_T2).unwrap();
    let t3 = load(
        &TWO_TABS_T2
            .replace("\"t2\"", "\"t3\"")
            .replace("\"game_id\": 2", "\"game_id\": 7"),
    )
    .unwrap();
    let t4 = load(EXAMPLE_TAB).unwrap();

    let desk = Desk::restore("", &index, vec![t3, t2, t1, t4]);

    let order: Vec<String> = desk.tabs().iter().map(|t| t.id().to_string()).collect();
    assert_eq!(order, vec!["t4", "t1", "t2", "t3"]);
    assert_eq!(desk.selected(), id("t4"));

    let ids: Vec<u64> = desk.tabs().iter().map(|t| t.table().game_id()).collect();
    assert_eq!(ids, vec![7, 1, 2, 9]);
    assert_eq!(desk.next_game_id(), 10);
}

#[test]
fn the_desk_is_never_empty() {
    let index = SavedIndex {
        next_tab: 6,
        selected: Some(id("t2")),
        ..SavedIndex::default()
    };

    let desk = Desk::restore("", &index, Vec::new());

    assert_eq!(desk.tabs().len(), 1);
    assert_eq!(desk.selected(), id("t6"));
    assert_eq!(desk.shown_tab().name(), "Board 1");
    assert_eq!(desk.shown_tab().kind(), TabKind::Free);
    assert_eq!(desk.shown().game().node_count(), 1);
}

#[test]
fn a_game_stub_is_not_loaded_but_its_id_is_never_reused() {
    let stub = "{ \"v\": 1, \"id\": \"t5\", \"name\": \"Rook: game 24\", \"kind\": \"game\", \"coach_game\": \"g0024\" }";

    let saved = SavedTab::from_text(stub).unwrap();
    assert_eq!(saved.kind(), TabKind::Game);
    assert_eq!(saved.to_text(), format!("{stub}\n"));
    assert_eq!(
        saved.body,
        SavedBody::Game {
            coach_game: Some("g0024".into()),
            extra: Default::default()
        }
    );

    let desk = Desk::restore(
        "",
        &SavedIndex::default(),
        vec![Tab::from_saved(&saved).unwrap()],
    );

    assert_eq!(desk.tabs().len(), 1);
    assert_eq!(desk.selected(), id("t6"));
    assert_eq!(desk.shown_tab().kind(), TabKind::Free);
}

#[test]
fn a_reps_stub_comes_back_as_an_empty_reps_tab() {
    let stub = "{ \"v\": 1, \"id\": \"t2\", \"name\": \"Reps\", \"kind\": \"reps\" }";
    let tab = load(stub).unwrap();

    assert_eq!(tab.kind(), TabKind::Reps);
    assert_eq!(tab.name(), "Reps");
    assert_eq!(tab.table().game().node_count(), 1);
    assert_eq!(tab.to_saved().to_text(), format!("{stub}\n"));
}

#[test]
fn unknown_fields_are_kept_on_rewrite() {
    let text = EXAMPLE_TAB
        .replace(
            "\n  \"moves\"",
            "\n  \"colour\": {\"board\":\"walnut\"},\n  \"moves\"",
        )
        .replace(r#""san":"e5"}"#, r#""san":"e5","clock_ms":4100}"#);

    let tab = load(&text).unwrap();
    assert_eq!(tab.to_saved().to_text(), format!("{text}\n"));

    let stub =
        "{ \"v\": 1, \"id\": \"t2\", \"name\": \"Reps\", \"kind\": \"reps\", \"later\": [1, 2] }";
    assert_eq!(
        load(stub).unwrap().to_saved().to_text(),
        "{ \"v\": 1, \"id\": \"t2\", \"name\": \"Reps\", \"kind\": \"reps\", \"later\": [1,2] }\n"
    );

    let index = "{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\"], \"next_tab\": 2, \"next_game_id\": 2, \"sort\": \"manual\" }";
    let desk = Desk::restore(
        "",
        &SavedIndex::from_text(index).unwrap(),
        vec![load(TWO_TABS_T1).unwrap()],
    );
    assert_eq!(desk.saved_index().to_text(), format!("{index}\n"));
}

#[test]
fn a_new_game_drops_unknown_fields_of_the_old_moves() {
    let text = EXAMPLE_TAB.replace(r#""san":"e5"}"#, r#""san":"e5","clock_ms":4100}"#);
    let index = SavedIndex::from_text(
        "{ \"v\": 1, \"selected\": \"t4\", \"order\": [\"t4\"], \"next_tab\": 5, \"next_game_id\": 9 }",
    )
    .unwrap();

    let mut desk = Desk::restore("", &index, vec![load(&text).unwrap()]);
    on(&mut desk, "t4", VIEW, json!({"op": "new_game"}));
    on(&mut desk, "t4", VIEW, json!({"op": "play", "move": "e4"}));
    on(&mut desk, "t4", VIEW, json!({"op": "play", "move": "e5"}));

    assert!(!desk
        .saved_tab(id("t4"))
        .unwrap()
        .to_text()
        .contains("clock_ms"));
}

#[test]
fn a_reopened_tab_never_shares_a_game_id_with_an_open_one() {
    let mut desk = Desk::restore("", &SavedIndex::default(), Vec::new());
    on(&mut desk, "t1", VIEW, json!({"op": "play", "move": "e4"}));
    tab_intent(&mut desk, json!({"op": "tab_new"}));
    tab_intent(&mut desk, json!({"op": "tab_close", "tab": "t1"}));
    on(&mut desk, "t2", VIEW, json!({"op": "new_game"}));
    tab_intent(&mut desk, json!({"op": "tab_new"}));

    let mut unsaved = desk.take_unsaved();
    assert_eq!(unsaved.closed.len(), 1);
    assert_eq!(unsaved.removed, vec![id("t1")]);

    let closed = unsaved.closed.remove(0);
    assert_eq!(closed.id, id("t1"));

    let text = closed.to_text();
    let tab = load(&text).unwrap();
    assert_eq!(tab.table().game_id(), 1);

    let rev = desk.rev();
    let applied = desk.reopen(tab, VIEW, NOW, Some(9)).unwrap();

    assert_eq!(applied.result, json!({"tab": "t1", "selected": "t1"}));
    assert_eq!(applied.rev, rev + 1);
    assert_eq!(applied.frame_json, desk.frame(NOW));
    assert_eq!(desk.selected(), id("t1"));

    let order: Vec<String> = desk.tabs().iter().map(|t| t.id().to_string()).collect();
    assert_eq!(order, vec!["t2", "t3", "t1"]);

    let ids: Vec<u64> = desk.tabs().iter().map(|t| t.table().game_id()).collect();
    assert_eq!(ids, vec![3, 4, 5]);
    assert_eq!(desk.table(id("t1")).unwrap().game().history(), vec!["e4"]);

    let frame: Value = serde_json::from_str(&applied.frame_json).unwrap();
    assert_eq!(
        frame["hint"],
        json!({"reason": "tab_reopen", "by": VIEW, "intent_id": 9})
    );

    let unsaved = desk.take_unsaved();
    assert_eq!(unsaved.now, vec![id("t1")]);
    assert!(unsaved.index);
}

#[test]
fn reopen_is_refused_for_an_open_id_an_ai_or_a_full_strip() {
    let mut desk = Desk::restore("", &SavedIndex::default(), Vec::new());
    let open = desk.shown_tab().clone();

    let err = desk.reopen(open.clone(), VIEW, NOW, None).unwrap_err();
    assert_eq!(err.to_string(), "Board t1 is already open.");

    let err = desk.reopen(open, AI, NOW, None).unwrap_err();
    assert_eq!(err.code(), "bad_input");

    for _ in 1..12 {
        tab_intent(&mut desk, json!({"op": "tab_new"}));
    }

    let rev = desk.rev();
    let far = load(&EXAMPLE_TAB.replace(r#""id": "t4""#, r#""id": "t40""#)).unwrap();
    let err = desk.reopen(far, VIEW, NOW, None).unwrap_err();
    assert_eq!(
        (err.code(), err.to_string().as_str()),
        ("tab_limit", "Close a board first.")
    );
    assert_eq!(desk.rev(), rev);
}

#[test]
fn a_change_says_which_tabs_to_write_and_how_soon() {
    let mut desk = Desk::restore("", &SavedIndex::default(), Vec::new());
    let first = desk.take_unsaved();
    assert_eq!(first.now, vec![id("t1")]);
    assert!(first.index);

    on(&mut desk, "t1", VIEW, json!({"op": "play", "move": "e4"}));
    assert_eq!(
        desk.take_unsaved(),
        Unsaved {
            now: vec![id("t1")],
            ..Unsaved::default()
        }
    );

    on(
        &mut desk,
        "t1",
        VIEW,
        json!({"op": "annotate", "note": "Best by test."}),
    );
    on(
        &mut desk,
        "t1",
        VIEW,
        json!({"op": "set_eval", "node": 1, "eval": {"cp": 30, "depth": 10}}),
    );
    on(&mut desk, "t1", VIEW, json!({"op": "back"}));
    assert_eq!(
        desk.take_unsaved(),
        Unsaved {
            quiet: vec![id("t1")],
            ..Unsaved::default()
        }
    );

    on(&mut desk, "t1", VIEW, json!({"op": "goto", "node": 1}));
    on(&mut desk, "t1", VIEW, json!({"op": "play", "move": "e5"}));
    let both = desk.take_unsaved();
    assert_eq!(both.now, vec![id("t1")]);
    assert!(both.quiet.is_empty());

    on(&mut desk, "t1", VIEW, json!({"op": "new_game"}));
    let new_game = desk.take_unsaved();
    assert_eq!(new_game.now, vec![id("t1")]);
    assert!(new_game.index);

    on(&mut desk, "t1", VIEW, json!({"op": "back"}));
    assert!(desk.take_unsaved().is_empty());

    tab_intent(&mut desk, json!({"op": "tab_new"}));
    assert_eq!(
        desk.take_unsaved(),
        Unsaved {
            now: vec![id("t2")],
            index: true,
            ..Unsaved::default()
        }
    );

    tab_intent(&mut desk, json!({"op": "tab_select", "tab": "t1"}));
    tab_intent(&mut desk, json!({"op": "tab_move", "tab": "t1", "to": 1}));
    assert_eq!(
        desk.take_unsaved(),
        Unsaved {
            index: true,
            ..Unsaved::default()
        }
    );

    tab_intent(
        &mut desk,
        json!({"op": "tab_rename", "tab": "t2", "name": "Sicilian"}),
    );
    assert_eq!(
        desk.take_unsaved(),
        Unsaved {
            now: vec![id("t2")],
            ..Unsaved::default()
        }
    );

    on(
        &mut desk,
        "t2",
        VIEW,
        json!({"op": "annotate", "node": 0, "note": "x"}),
    );
    tab_intent(&mut desk, json!({"op": "tab_close", "tab": "t2"}));
    let closed = desk.take_unsaved();
    assert!(closed.now.is_empty());
    assert!(closed.quiet.is_empty());
    assert!(closed.index);
    assert_eq!(closed.removed, vec![id("t2")]);
    assert_eq!(closed.closed.len(), 1);
    assert_eq!(closed.closed[0].name, "Sicilian");

    tab_intent(&mut desk, json!({"op": "tab_close", "tab": "t1"}));
    let last = desk.take_unsaved();
    assert_eq!(last.now, vec![id("t3")]);
    assert_eq!(last.removed, vec![id("t1")]);
}

#[test]
fn a_stop_that_changes_only_the_flag_is_written_at_once() {
    let mut desk = Desk::restore("", &SavedIndex::default(), Vec::new());
    on(
        &mut desk,
        "t1",
        AI,
        json!({"op": "claim_seat", "seat": "black"}),
    );
    on(
        &mut desk,
        "t1",
        VIEW,
        json!({"op": "set_seats", "white": "human", "black": "human"}),
    );
    assert_eq!(
        desk.table(id("t1")).unwrap().stopped_by_person(),
        Some("seats")
    );
    desk.take_unsaved();

    let rev = desk.rev();
    on(
        &mut desk,
        "t1",
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "human"}}),
    );

    assert_eq!(desk.rev(), rev);
    assert_eq!(desk.table(id("t1")).unwrap().stopped_by_person(), None);
    assert_eq!(desk.take_unsaved().now, vec![id("t1")]);
}

#[test]
fn a_desk_that_is_not_saved_records_nothing() {
    let mut desk = Desk::new("");
    assert!(!desk.saving());

    on(&mut desk, "t1", VIEW, json!({"op": "play", "move": "e4"}));
    tab_intent(&mut desk, json!({"op": "tab_new"}));
    tab_intent(&mut desk, json!({"op": "tab_close", "tab": "t1"}));

    assert!(desk.take_unsaved().is_empty());
    assert!(Desk::restore("", &SavedIndex::default(), Vec::new()).saving());
}

#[test]
fn names_are_cleaned_on_load() {
    let text = TWO_TABS_T2.replace("\"Endgame\"", "\"  End\\u0007 game  \"");
    let desk = Desk::restore("", &SavedIndex::default(), vec![load(&text).unwrap()]);
    assert_eq!(desk.shown_tab().name(), "End game");

    let text = TWO_TABS_T2.replace("\"Endgame\"", "\"\\u200b\"");
    let desk = Desk::restore("", &SavedIndex::default(), vec![load(&text).unwrap()]);
    assert_eq!(desk.shown_tab().name(), "Board 1");
}

#[test]
fn tab_ids_are_read_from_file_names() {
    assert_eq!(tab_id_in_file_name("t4.json"), Some(id("t4")));
    assert_eq!(tab_id_in_file_name("t3.1763230000000.json"), Some(id("t3")));
    assert_eq!(tab_id_in_file_name("index.json"), None);
    assert_eq!(tab_id_in_file_name("index.1763230000000.json"), None);
    assert_eq!(tab_id_in_file_name("README.txt"), None);
    assert_eq!(tab_id_in_file_name("t04.json"), None);
}

#[test]
fn board_numbers_above_the_largest_are_refused_where_they_are_read() {
    assert_eq!(id("t999999999").number(), 999_999_999);
    assert!("t1000000000".parse::<TabId>().is_err());
    assert!("t4294967295".parse::<TabId>().is_err());
    assert_eq!(tab_id_in_file_name("t4294967295.json"), None);

    let huge = TWO_TABS_T1.replace("\"t1\"", "\"t4294967295\"");
    assert!(damage(&huge).contains("t4294967295"), "{}", damage(&huge));

    let index = |next_tab: u64| {
        format!(
            "{{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\"], \"next_tab\": {next_tab}, \"next_game_id\": 2 }}"
        )
    };
    assert!(SavedIndex::from_text(&index(1_000_000_000)).is_ok());
    assert_eq!(
        SavedIndex::from_text(&index(1_000_000_001)).unwrap_err().0,
        "next_tab is 1000000001; the largest it may be is 1000000000"
    );
    assert!(SavedIndex::from_text(&index(4_294_967_295)).is_err());
}

#[test]
fn a_desk_at_the_largest_board_number_refuses_a_new_board_instead_of_reusing_one() {
    let top = TWO_TABS_T1.replace("\"t1\"", "\"t999999999\"");
    let mut desk = Desk::restore("", &SavedIndex::default(), vec![load(&top).unwrap()]);

    let full = "No new board can be made: the board numbers have run out.";
    for refused in [
        json!({"op": "tab_new"}),
        json!({"op": "tab_close", "tab": "t999999999"}),
    ] {
        let err = desk.apply(VIEW, &refused.to_string(), NOW).unwrap_err();
        assert_eq!((err.code(), err.to_string().as_str()), ("tab_limit", full));
    }

    let ids: Vec<TabId> = desk.tabs().iter().map(|t| t.id()).collect();
    assert_eq!(ids, vec![id("t999999999")]);

    let text = desk.saved_tab(id("t999999999")).unwrap().to_text();
    assert!(load(&text).is_ok());
    assert!(SavedIndex::from_text(&desk.saved_index().to_text()).is_ok());
}

#[test]
fn a_desk_whose_numbers_have_run_out_still_has_a_board() {
    let index = SavedIndex {
        next_tab: 1_000_000_000,
        ..SavedIndex::default()
    };

    let desk = Desk::restore("", &index, Vec::new());
    let ids: Vec<TabId> = desk.tabs().iter().map(|t| t.id()).collect();
    assert_eq!(ids, vec![id("t999999999")]);
}

#[test]
fn counts_too_large_for_a_board_are_refused() {
    let largest = rukh_core::MAX_SAVED_COUNT;

    for (field, line) in [
        ("game_id", "\"game_id\": 1,"),
        ("board_rev", "\"board_rev\": 3,"),
    ] {
        for value in [largest + 1, u64::MAX] {
            let text = TWO_TABS_T1.replace(line, &format!("\"{field}\": {value},"));
            assert_eq!(
                damage(&text),
                format!("{field} is {value}; the largest it may be is {largest}")
            );
        }
    }

    let index = format!(
        "{{ \"v\": 1, \"selected\": \"t1\", \"order\": [\"t1\"], \"next_tab\": 2, \"next_game_id\": {} }}",
        u64::MAX
    );
    assert!(SavedIndex::from_text(&index).is_err());
}

#[test]
fn a_board_at_the_largest_count_plays_on_without_overflow() {
    let largest = rukh_core::MAX_SAVED_COUNT;
    let text = TWO_TABS_T1
        .replace("\"game_id\": 1,", &format!("\"game_id\": {largest},"))
        .replace("\"board_rev\": 3,", &format!("\"board_rev\": {largest},"));

    let mut desk = Desk::restore("", &SavedIndex::default(), vec![load(&text).unwrap()]);
    assert_eq!(desk.next_game_id(), largest + 1);

    on(&mut desk, "t1", VIEW, json!({"op": "play", "move": "Nf3"}));
    tab_intent(&mut desk, json!({"op": "tab_new"}));
    on(&mut desk, "t1", VIEW, json!({"op": "new_game"}));

    let ids: Vec<u64> = desk.tabs().iter().map(|t| t.table().game_id()).collect();
    assert_eq!(ids, vec![largest + 2, largest + 1]);
}

#[test]
fn a_huge_fullmove_number_does_not_overflow() {
    for fullmove in ["2147483649", "4294967295"] {
        let fen = format!("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 {fullmove}");
        let text = TWO_TABS_T1.replace(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &fen,
        );

        let tab = load(&text).unwrap();
        assert_eq!(tab.table().game().history(), vec!["e4", "e5"]);
    }
}

#[test]
fn a_byte_order_mark_before_the_text_is_ignored() {
    let with_mark = format!("\u{feff}{TWO_TABS_T1}");
    assert_eq!(load(&with_mark).unwrap().to_saved().to_text(), TWO_TABS_T1);

    let index = format!("\u{feff}{TWO_TABS_INDEX}");
    assert!(SavedIndex::from_text(&index).is_ok());
}

#[test]
fn a_chess960_number_that_does_not_name_the_start_position_is_refused() {
    let classical = TWO_TABS_T1
        .replace("\"variant\": \"standard\"", "\"variant\": \"chess960\"")
        .replace("\"chess960\": null", "\"chess960\": 5");
    assert_eq!(
        damage(&classical),
        "chess960 is 5, but the start position is not Chess960 position 5"
    );

    let right = classical.replace("\"chess960\": 5", "\"chess960\": 518");
    assert_eq!(
        load(&right).unwrap().table().game().chess960_number(),
        Some(518)
    );
}

#[test]
fn unknown_fields_inside_match_study_and_root_are_kept() {
    let text = EXAMPLE_TAB
        .replace(
            "\"style\": \"annotate\" }",
            "\"style\": \"annotate\", \"since\": 1700 }",
        )
        .replace(
            "\"notes\": \"\" }",
            "\"notes\": \"\", \"author\": \"the coach\" }",
        )
        .replace(
            "\n  \"moves\"",
            "\n  \"root\": {\"note\":\"Start.\",\"mood\":\"calm\"},\n  \"moves\"",
        );

    let tab = load(&text).unwrap();
    assert_eq!(tab.table().game().node(0).unwrap().note, "Start.");
    assert_eq!(tab.to_saved().to_text(), format!("{text}\n"));
}

#[test]
fn reopen_is_refused_for_a_game_or_reps_tab() {
    let mut desk = Desk::restore("", &SavedIndex::default(), Vec::new());

    for stub in [
        "{ \"v\": 1, \"id\": \"t7\", \"name\": \"Reps\", \"kind\": \"reps\" }",
        "{ \"v\": 1, \"id\": \"t8\", \"name\": \"Rook: game 24\", \"kind\": \"game\", \"coach_game\": \"g0024\" }",
    ] {
        let tab = load(stub).unwrap();
        let shown = tab.id();
        let err = desk.reopen(tab, VIEW, NOW, None).unwrap_err();

        assert_eq!(
            err.to_string(),
            format!("Board {shown} is not a free board, so it cannot be reopened.")
        );
    }

    assert_eq!(desk.tabs().len(), 1);
}
