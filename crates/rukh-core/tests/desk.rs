use rukh_core::{
    clean_tab_name, Desk, Mark, TabId, TabKind, Table, MAX_FREE_TABS, MAX_TAB_NAME_CHARS,
};
use serde_json::{json, Value};

const VIEW: &str = "view:1";
const AI: &str = "ai:claude-code";
const NOW: u64 = 1000;

fn id(text: &str) -> TabId {
    text.parse().expect("a tab id")
}

fn apply(d: &mut Desk, by: &str, intent: Value) -> Value {
    let applied = d
        .apply(by, &intent.to_string(), NOW)
        .unwrap_or_else(|e| panic!("{intent}: {e}"));

    let parsed: Value = serde_json::from_str(&applied.result_json).expect("result is JSON");
    assert_eq!(parsed, applied.result);
    assert_eq!(applied.frame_json, d.frame(NOW));
    assert_eq!(applied.rev, d.rev());

    applied.result
}

fn apply_on(d: &mut Desk, tab: &str, by: &str, intent: Value) -> Value {
    let applied = d
        .apply_on(id(tab), by, &intent.to_string(), NOW, None)
        .unwrap_or_else(|e| panic!("{intent}: {e}"));

    assert_eq!(applied.frame_json, d.frame(NOW));
    applied.result
}

fn refuse(d: &mut Desk, by: &str, intent: Value) -> (&'static str, String) {
    let before = d.frame(NOW);
    let rev = d.rev();
    let next_game_id = d.next_game_id();

    let err = d
        .apply(by, &intent.to_string(), NOW)
        .expect_err("the intent should be refused");

    assert_eq!(d.frame(NOW), before, "a refused intent changes nothing");
    assert_eq!(d.rev(), rev);
    assert_eq!(d.next_game_id(), next_game_id);

    (err.code(), err.to_string())
}

fn frame(d: &Desk) -> Value {
    serde_json::from_str(&d.frame(NOW)).expect("frame is JSON")
}

fn state_text(d: &Desk, tab: &str) -> String {
    let table = d.table(id(tab)).expect("an open tab");
    serde_json::to_string(&table.state()).expect("state is JSON")
}

fn order(d: &Desk) -> Vec<String> {
    d.tabs().iter().map(|t| t.id().to_string()).collect()
}

fn new_tab(d: &mut Desk) -> String {
    let result = apply(d, VIEW, json!({"op": "tab_new"}));
    result["tab"].as_str().expect("a tab id").to_string()
}

fn without_tabs(mut frame: Value) -> Value {
    let obj = frame.as_object_mut().expect("frame is an object");
    obj.remove("tab");
    obj.remove("tabs");
    frame
}

#[test]
fn a_new_desk_is_one_standard_board() {
    let d = Desk::new("i1");

    assert_eq!(d.rev(), 0);
    assert_eq!(d.selected(), id("t1"));
    assert_eq!(d.next_game_id(), 2);
    assert_eq!(order(&d), ["t1"]);

    let f = frame(&d);
    assert_eq!(f["tab"], "t1");
    assert_eq!(
        f["tabs"],
        json!([{"id": "t1", "name": "Board 1", "kind": "free", "mark": null}])
    );

    let table: Value = serde_json::from_str(&Table::new("i1").frame(NOW)).unwrap();
    assert_eq!(without_tabs(f), table);
}

#[test]
fn tab_ids_read_and_print_as_t_and_a_number() {
    assert_eq!(id("t4").to_string(), "t4");
    assert_eq!(id("t4").number(), 4);
    assert_eq!(serde_json::to_value(id("t12")).unwrap(), json!("t12"));

    for bad in ["", "t", "4", "t0", "t04", "T4", "t+4", "t4 ", "tx"] {
        assert!(bad.parse::<TabId>().is_err(), "{bad:?}");
    }
}

#[test]
fn with_one_tab_the_desk_behaves_as_the_table() {
    let mut d = Desk::new("i1");
    let mut t = Table::new("i1");

    let intents = [
        (VIEW, json!({"op": "play", "move": "e4"})),
        (VIEW, json!({"op": "play", "move": "e5"})),
        (VIEW, json!({"op": "back"})),
        (VIEW, json!({"op": "forward"})),
        (VIEW, json!({"op": "forward"})),
        (
            VIEW,
            json!({"op": "annotate", "note": "Open game.", "arrows": [{"from": "g1", "to": "f3"}]}),
        ),
        (AI, json!({"op": "annotate", "node": 1, "nag": "!"})),
        (
            VIEW,
            json!({"op": "set_eval", "node": 2, "eval": {"cp": 20, "depth": 12}}),
        ),
        (
            VIEW,
            json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
        ),
        (AI, json!({"op": "claim_seat", "seat": "black"})),
        (VIEW, json!({"op": "play", "move": "Nf3"})),
        (AI, json!({"op": "play", "move": "Nc6"})),
        (VIEW, json!({"op": "set_style", "style": "coach"})),
        (VIEW, json!({"op": "match_stop"})),
        (VIEW, json!({"op": "new_game"})),
        (VIEW, json!({"op": "new_game", "chess960": 518})),
    ];

    for (i, (by, intent)) in intents.iter().enumerate() {
        let text = intent.to_string();
        let a = d.apply_with_id(by, &text, NOW, Some(i as u64)).unwrap();
        let b = t.apply_with_id(by, &text, NOW, Some(i as u64)).unwrap();

        assert_eq!(a.result, b.result, "{intent}");
        assert_eq!(a.rev, b.rev, "{intent}");
        assert_eq!(a.changed, b.changed, "{intent}");

        let a_frame: Value = serde_json::from_str(&a.frame_json).unwrap();
        let b_frame: Value = serde_json::from_str(&b.frame_json).unwrap();
        assert_eq!(without_tabs(a_frame), b_frame, "{intent}");
    }

    assert_eq!(d.rev(), 14);
    assert_eq!(d.shown().game_id(), 3);
    assert_eq!(d.next_game_id(), 4);

    let bad = d.apply(VIEW, "{not json", NOW).unwrap_err();
    let bad_table = t.apply(VIEW, "{not json", NOW).unwrap_err();
    assert_eq!(bad, bad_table);
}

#[test]
fn a_move_on_a_hidden_tab_changes_that_tab_and_never_the_shown_one() {
    let mut d = Desk::new("i1");
    assert_eq!(new_tab(&mut d), "t2");
    assert_eq!(d.selected(), id("t2"));

    let shown_before = state_text(&d, "t2");

    let result = apply_on(&mut d, "t1", VIEW, json!({"op": "play", "move": "e4"}));
    assert_eq!(result["san"], "e4");
    assert_eq!(result["board_rev"], 1);

    let result = apply(
        &mut d,
        VIEW,
        json!({"op": "play", "move": "e5", "tab": "t1"}),
    );
    assert_eq!(result["san"], "e5");

    assert_eq!(state_text(&d, "t2"), shown_before);
    assert_eq!(d.selected(), id("t2"));
    assert_eq!(d.rev(), 3);

    let t1 = d.table(id("t1")).unwrap();
    assert_eq!(t1.board_rev(), 2);
    assert_eq!(t1.game().current(), 2);

    let f = frame(&d);
    assert_eq!(f["rev"], 3);
    assert_eq!(f["tab"], "t2");
    assert_eq!(f["state"]["board_rev"], 0);
    assert_eq!(f["state"]["game"]["current"], 0);
    assert_eq!(f["hint"], json!({"reason": "move", "by": "view:1"}));
}

#[test]
fn an_intent_with_no_tab_lands_on_the_shown_tab() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);

    apply(&mut d, VIEW, json!({"op": "play", "move": "d4"}));

    assert_eq!(d.table(id("t2")).unwrap().board_rev(), 1);
    assert_eq!(d.table(id("t1")).unwrap().board_rev(), 0);

    apply(
        &mut d,
        VIEW,
        json!({"op": "play", "move": "d5", "tab": null}),
    );
    assert_eq!(d.table(id("t2")).unwrap().board_rev(), 2);
}

#[test]
fn a_select_raises_rev_and_no_board_rev() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);
    apply_on(&mut d, "t1", VIEW, json!({"op": "play", "move": "e4"}));
    assert_eq!(d.rev(), 2);

    let result = apply(&mut d, VIEW, json!({"op": "tab_select", "tab": "t1"}));
    assert_eq!(result, json!({"selected": "t1"}));
    assert_eq!(d.rev(), 3);
    assert_eq!(d.table(id("t1")).unwrap().board_rev(), 1);
    assert_eq!(d.table(id("t2")).unwrap().board_rev(), 0);

    let f = frame(&d);
    assert_eq!(f["tab"], "t1");
    assert_eq!(f["state"]["board_rev"], 1);

    let applied = d
        .apply_with_id(VIEW, r#"{"op":"tab_select","tab":"t2"}"#, NOW, Some(41))
        .unwrap();
    assert_eq!(applied.rev, 4);

    let f = frame(&d);
    assert_eq!(
        f["hint"],
        json!({"reason": "tab_select", "by": "view:1", "intent_id": 41})
    );
    assert_eq!(f["state"]["board_rev"], 0);

    let again = d
        .apply(VIEW, r#"{"op":"tab_select","tab":"t2"}"#, NOW)
        .unwrap();
    assert!(!again.changed);
    assert_eq!(again.rev, 4);
    assert_eq!(d.rev(), 4);
}

#[test]
fn rev_rises_by_exactly_one_per_change_wherever_it_lands() {
    let mut d = Desk::new("i1");
    let mut expected = 0;

    let steps: Vec<(Option<&str>, Value, bool)> = vec![
        (None, json!({"op": "tab_new"}), true),
        (Some("t1"), json!({"op": "play", "move": "e4"}), true),
        (None, json!({"op": "back"}), false),
        (None, json!({"op": "play", "move": "c4"}), true),
        (None, json!({"op": "tab_select", "tab": "t1"}), true),
        (None, json!({"op": "tab_select", "tab": "t1"}), false),
        (
            Some("t2"),
            json!({"op": "annotate", "note": "English."}),
            true,
        ),
        (
            Some("t2"),
            json!({"op": "annotate", "note": "English."}),
            false,
        ),
        (
            None,
            json!({"op": "tab_rename", "tab": "t2", "name": "English"}),
            true,
        ),
        (
            None,
            json!({"op": "tab_rename", "tab": "t2", "name": "English"}),
            false,
        ),
        (None, json!({"op": "tab_move", "tab": "t2", "to": 0}), true),
        (None, json!({"op": "tab_move", "tab": "t2", "to": 0}), false),
        (None, json!({"op": "new_game"}), true),
        (None, json!({"op": "tab_new", "copy_of": "t2"}), true),
        (None, json!({"op": "tab_close", "tab": "t3"}), true),
    ];

    for (tab, intent, changes) in steps {
        let text = intent.to_string();
        let applied = match tab {
            Some(tab) => d.apply_on(id(tab), VIEW, &text, NOW, None).unwrap(),
            None => d.apply(VIEW, &text, NOW).unwrap(),
        };

        if changes {
            expected += 1;
        }

        assert_eq!(applied.changed, changes, "{intent}");
        assert_eq!(applied.rev, expected, "{intent}");
        assert_eq!(d.rev(), expected, "{intent}");
        assert_eq!(frame(&d)["rev"], expected, "{intent}");
    }

    assert_eq!(expected, 10);

    d.open_tab(TabKind::Reps, "Reps", None, "rukh").unwrap();
    assert_eq!(d.rev(), 11);
}

#[test]
fn rev_never_falls_across_selects_and_moves() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);
    new_tab(&mut d);

    let moves = ["e4", "d4", "c4", "e5", "d5", "e5", "Nf3", "c4"];
    let mut last = d.rev();

    for (i, mv) in moves.iter().enumerate() {
        let tab = format!("t{}", i % 3 + 1);
        let other = format!("t{}", (i + 1) % 3 + 1);

        let played = d
            .apply_on(
                id(&tab),
                VIEW,
                &json!({"op": "play", "move": mv}).to_string(),
                NOW,
                None,
            )
            .unwrap();
        assert_eq!(played.rev, last + 1);
        last = played.rev;

        let selected = d
            .apply(
                VIEW,
                &json!({"op": "tab_select", "tab": other}).to_string(),
                NOW,
            )
            .unwrap();
        assert_eq!(selected.rev, last + 1);
        last = selected.rev;

        let f = frame(&d);
        assert_eq!(f["rev"], last);
        assert_eq!(f["tab"], other.as_str());
    }

    assert_eq!(last, 18);

    let t1 = d.table(id("t1")).unwrap();
    let revs: Vec<u64> = t1.recent().iter().map(|c| c.rev).collect();
    assert_eq!(revs, [3, 9, 15]);
}

#[test]
fn every_table_carries_the_desk_rev() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);
    new_tab(&mut d);

    let moves = ["e4", "d4", "c4", "e5", "d5", "e5", "Nf3", "c4", "Nf3"];

    for (i, mv) in moves.iter().enumerate() {
        let tab = format!("t{}", i % 3 + 1);
        apply_on(&mut d, &tab, VIEW, json!({"op": "play", "move": mv}));

        for t in d.tabs() {
            assert_eq!(t.table().rev(), d.rev(), "{} after {mv}", t.id());

            let own: Value = serde_json::from_str(&t.table().frame(NOW)).unwrap();
            assert_eq!(own["rev"], d.rev(), "{} after {mv}", t.id());
        }
    }

    apply(&mut d, VIEW, json!({"op": "tab_select", "tab": "t1"}));
    d.open_tab(TabKind::Reps, "Reps", None, "rukh").unwrap();

    assert_eq!(d.rev(), 13);
    for t in d.tabs() {
        assert_eq!(t.table().rev(), 13, "{}", t.id());
    }
}

#[test]
fn game_ids_never_repeat_across_tabs_or_after_a_close() {
    let mut d = Desk::new("i1");
    assert_eq!(d.shown().game_id(), 1);

    new_tab(&mut d);
    assert_eq!(d.shown().game_id(), 2);

    let result = apply_on(&mut d, "t1", VIEW, json!({"op": "new_game"}));
    assert_eq!(result["game_id"], 3);
    assert_eq!(d.table(id("t1")).unwrap().game_id(), 3);

    apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t2"}));
    new_tab(&mut d);
    assert_eq!(d.table(id("t3")).unwrap().game_id(), 4);

    let result = apply(&mut d, VIEW, json!({"op": "new_game"}));
    assert_eq!(result["game_id"], 5);

    apply(&mut d, VIEW, json!({"op": "tab_new", "copy_of": "t1"}));
    assert_eq!(d.table(id("t4")).unwrap().game_id(), 6);

    let game = d
        .open_tab(TabKind::Game, "Rook: game 24", None, "rukh")
        .unwrap();
    assert_eq!(d.table(game).unwrap().game_id(), 7);
    assert_eq!(d.next_game_id(), 8);

    let mut ids: Vec<u64> = d.tabs().iter().map(|t| t.table().game_id()).collect();
    ids.sort_unstable();
    assert_eq!(ids, [3, 5, 6, 7]);
}

#[test]
fn tab_ids_are_never_reused_after_a_close() {
    let mut d = Desk::new("i1");
    assert_eq!(new_tab(&mut d), "t2");
    assert_eq!(new_tab(&mut d), "t3");

    apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t3"}));
    assert_eq!(new_tab(&mut d), "t4");

    apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t1"}));
    apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t2"}));
    apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t4"}));
    assert_eq!(order(&d), ["t5"]);

    assert_eq!(new_tab(&mut d), "t6");

    let (code, _) = refuse(&mut d, VIEW, json!({"op": "tab_select", "tab": "t3"}));
    assert_eq!(code, "unknown_tab");
}

#[test]
fn closing_the_last_tab_leaves_a_fresh_board_1() {
    let mut d = Desk::new("i1");
    apply(&mut d, VIEW, json!({"op": "play", "move": "e4"}));
    apply(
        &mut d,
        VIEW,
        json!({"op": "tab_rename", "tab": "t1", "name": "Mine"}),
    );
    assert_eq!(d.rev(), 2);

    let result = apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t1"}));
    assert_eq!(result, json!({"closed": "t1", "selected": "t2"}));
    assert_eq!(d.rev(), 3);

    let f = frame(&d);
    assert_eq!(f["tab"], "t2");
    assert_eq!(
        f["tabs"],
        json!([{"id": "t2", "name": "Board 1", "kind": "free", "mark": null}])
    );
    assert_eq!(f["state"]["game_id"], 2);
    assert_eq!(f["state"]["board_rev"], 0);
    assert_eq!(f["state"]["game"]["current"], 0);
    assert_eq!(f["hint"], json!({"reason": "tab_close", "by": "view:1"}));
}

#[test]
fn closing_the_shown_tab_shows_its_right_neighbour_or_else_its_left() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);
    new_tab(&mut d);
    apply(&mut d, VIEW, json!({"op": "tab_select", "tab": "t2"}));

    let result = apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t2"}));
    assert_eq!(result, json!({"closed": "t2", "selected": "t3"}));

    let result = apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t3"}));
    assert_eq!(result, json!({"closed": "t3", "selected": "t1"}));

    new_tab(&mut d);
    apply(&mut d, VIEW, json!({"op": "tab_select", "tab": "t1"}));

    let result = apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t4"}));
    assert_eq!(result, json!({"closed": "t4", "selected": "t1"}));
    assert_eq!(order(&d), ["t1"]);
}

#[test]
fn tab_new_is_refused_at_the_free_tab_limit() {
    let mut d = Desk::new("i1");
    assert_eq!(MAX_FREE_TABS, 12);

    for n in 2..=12 {
        assert_eq!(new_tab(&mut d), format!("t{n}"));
    }
    assert_eq!(d.free_tabs(), 12);
    assert_eq!(d.rev(), 11);

    let (code, message) = refuse(&mut d, VIEW, json!({"op": "tab_new"}));
    assert_eq!(code, "tab_limit");
    assert_eq!(message, "Close a board first.");

    let (code, _) = refuse(&mut d, VIEW, json!({"op": "tab_new", "copy_of": "t1"}));
    assert_eq!(code, "tab_limit");

    let err = d
        .open_tab(TabKind::Free, "Game 7", None, "rukh")
        .unwrap_err();
    assert_eq!(err.code(), "tab_limit");
    assert_eq!(d.rev(), 11);

    let game = d
        .open_tab(TabKind::Game, "Rook: game 24", None, "rukh")
        .unwrap();
    let reps = d.open_tab(TabKind::Reps, "Reps", None, "rukh").unwrap();
    assert_eq!(game.to_string(), "t13");
    assert_eq!(reps.to_string(), "t14");
    assert_eq!(d.tabs().len(), 14);
    assert_eq!(d.free_tabs(), 12);
    assert_eq!(d.rev(), 13);
    assert_eq!(d.selected(), id("t12"));

    let f = frame(&d);
    assert_eq!(
        f["tabs"][12],
        json!({"id": "t13", "name": "Rook: game 24", "kind": "game", "mark": null})
    );
    assert_eq!(
        f["tabs"][13],
        json!({"id": "t14", "name": "Reps", "kind": "reps", "mark": null})
    );

    let (code, _) = refuse(&mut d, VIEW, json!({"op": "tab_new"}));
    assert_eq!(code, "tab_limit");

    apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t5"}));
    assert_eq!(new_tab(&mut d), "t15");
}

#[test]
fn an_unknown_tab_is_refused() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);

    for intent in [
        json!({"op": "tab_select", "tab": "t9"}),
        json!({"op": "tab_select", "tab": "board"}),
        json!({"op": "tab_rename", "tab": "t9", "name": "x"}),
        json!({"op": "tab_close", "tab": "t9"}),
        json!({"op": "tab_move", "tab": "t9", "to": 0}),
        json!({"op": "tab_new", "copy_of": "t9"}),
        json!({"op": "play", "move": "e4", "tab": "t9"}),
    ] {
        let (code, _) = refuse(&mut d, VIEW, intent);
        assert_eq!(code, "unknown_tab");
    }

    let (code, message) = refuse(&mut d, VIEW, json!({"op": "tab_select", "tab": "t9"}));
    assert_eq!(code, "unknown_tab");
    assert_eq!(
        message,
        "There is no open board \"t9\"; it may have been closed."
    );

    let err = d
        .apply_on(id("t9"), VIEW, r#"{"op":"play","move":"e4"}"#, NOW, None)
        .unwrap_err();
    assert_eq!(err.code(), "unknown_tab");

    let long = format!("t{}", "1".repeat(40));
    let (code, message) = refuse(&mut d, VIEW, json!({"op": "tab_select", "tab": long}));
    assert_eq!(code, "unknown_tab");
    assert_eq!(
        message,
        format!(
            "There is no open board \"t{}\"; it may have been closed.",
            "1".repeat(19)
        )
    );

    assert_eq!(d.rev(), 1);
}

#[test]
fn a_bad_tab_intent_is_refused() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);

    for intent in [
        json!({"op": "play", "move": "e4", "tab": 1}),
        json!({"op": "tab_move", "tab": "t1", "to": 2}),
        json!({"op": "tab_dance", "tab": "t1"}),
        json!({"op": "tab_select"}),
        json!({"op": "tab_select", "tab": null}),
        json!({"op": "tab_select", "tab": 1}),
        json!({"op": "tab_rename", "tab": "t1"}),
        json!({"op": "tab_rename", "tab": "t1", "name": 5}),
        json!({"op": "tab_new", "name": 5}),
        json!({"op": "tab_close"}),
        json!({"op": "tab_close", "tab": "t1", "abandon": "yes"}),
        json!({"op": "tab_move", "tab": "t1"}),
        json!({"op": "tab_move", "tab": "t1", "to": -1}),
        json!({"op": "tab_move", "tab": "t1", "to": "0"}),
        json!({"op": "tab_move", "tab": "t1", "to": 0.5}),
    ] {
        let (code, _) = refuse(&mut d, VIEW, intent.clone());
        assert_eq!(code, "bad_input", "{intent}");
    }

    assert_eq!(d.rev(), 1);
}

#[test]
fn a_repeated_tab_key_is_refused() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);
    new_tab(&mut d);
    assert_eq!(d.selected(), id("t3"));

    for text in [
        r#"{"op":"play","move":"e4","tab":"t1","tab":"t2"}"#,
        r#"{"op":"play","move":"e4","tab":"t9","tab":"t9"}"#,
        r#"{"op":"play","move":"e4","tab":"t3","tab":"t3"}"#,
    ] {
        let before = d.frame(NOW);

        let err = d.apply(VIEW, text, NOW).expect_err(text);
        assert_eq!(err.code(), "bad_input", "{text}");
        assert_eq!(d.frame(NOW), before, "{text}");
    }

    for t in d.tabs() {
        assert_eq!(t.table().board_rev(), 0, "{}", t.id());
    }
    assert_eq!(d.rev(), 2);
}

#[test]
fn a_refused_intent_on_a_hidden_tab_changes_nothing() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);

    let before = d.frame(NOW);
    let hidden = state_text(&d, "t1");
    let next_game_id = d.next_game_id();

    for (by, intent) in [
        (VIEW, json!({"op": "play", "move": "e5"})),
        (VIEW, json!({"op": "annotate", "node": 99, "note": "x"})),
        (AI, json!({"op": "play", "move": "e4", "from_node": 5})),
    ] {
        let text = intent.to_string();
        assert!(
            d.apply_on(id("t1"), by, &text, NOW, None).is_err(),
            "{text}"
        );
    }

    assert_eq!(d.frame(NOW), before);
    assert_eq!(state_text(&d, "t1"), hidden);
    assert_eq!(d.next_game_id(), next_game_id);
    assert_eq!(d.rev(), 1);
}

#[test]
fn an_ai_plays_on_a_hidden_tab() {
    let mut d = Desk::new("i1");
    apply(
        &mut d,
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );
    new_tab(&mut d);
    let shown = state_text(&d, "t2");

    apply_on(
        &mut d,
        "t1",
        AI,
        json!({"op": "claim_seat", "seat": "black"}),
    );
    apply_on(&mut d, "t1", VIEW, json!({"op": "play", "move": "e4"}));

    let result = apply_on(&mut d, "t1", AI, json!({"op": "play", "move": "e5"}));
    assert_eq!(result["san"], "e5");

    let err = d
        .apply_on(id("t1"), AI, r#"{"op":"play","move":"Nf3"}"#, NOW, None)
        .unwrap_err();
    assert_eq!(err.code(), "not_your_turn");

    assert_eq!(state_text(&d, "t2"), shown);
    assert_eq!(d.selected(), id("t2"));
    assert_eq!(d.table(id("t1")).unwrap().game().current(), 2);
    assert_eq!(frame(&d)["tabs"][0]["mark"], "your_move");
}

#[test]
fn an_ai_cannot_send_a_tab_intent() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);

    for intent in [
        json!({"op": "tab_select", "tab": "t1"}),
        json!({"op": "tab_new"}),
        json!({"op": "tab_rename", "tab": "t1", "name": "Mine"}),
        json!({"op": "tab_close", "tab": "t1"}),
        json!({"op": "tab_move", "tab": "t1", "to": 1}),
        json!({"op": "tab_reopen"}),
    ] {
        let (code, _) = refuse(&mut d, AI, intent);
        assert_eq!(code, "bad_input");
    }

    let result = apply(&mut d, "rukh", json!({"op": "tab_select", "tab": "t1"}));
    assert_eq!(result, json!({"selected": "t1"}));
}

#[test]
fn tab_reopen_is_refused_with_nothing_closed() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);
    apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t2"}));

    let (code, message) = refuse(&mut d, VIEW, json!({"op": "tab_reopen"}));
    assert_eq!(code, "nothing_closed");
    assert_eq!(message, "There is no closed board to reopen.");
}

#[test]
fn tab_intents_answer_with_their_result_shapes() {
    let mut d = Desk::new("i1");

    assert_eq!(
        apply(
            &mut d,
            VIEW,
            json!({"op": "tab_new", "name": null, "copy_of": null})
        ),
        json!({"tab": "t2"})
    );
    assert_eq!(
        apply(&mut d, VIEW, json!({"op": "tab_new", "name": "Italian"})),
        json!({"tab": "t3"})
    );

    assert_eq!(
        apply(
            &mut d,
            VIEW,
            json!({"op": "tab_rename", "tab": "t3", "name": "Italian, the Bc5 line"})
        ),
        json!({"tab": "t3", "name": "Italian, the Bc5 line"})
    );

    assert_eq!(
        apply(
            &mut d,
            VIEW,
            json!({"op": "tab_move", "tab": "t3", "to": 0})
        ),
        json!({"tab": "t3", "order": ["t3", "t1", "t2"]})
    );

    assert_eq!(
        apply(&mut d, VIEW, json!({"op": "tab_select", "tab": "t1"})),
        json!({"selected": "t1"})
    );

    assert_eq!(
        apply(
            &mut d,
            VIEW,
            json!({"op": "tab_close", "tab": "t2", "abandon": true})
        ),
        json!({"closed": "t2", "selected": "t1"})
    );

    assert_eq!(
        frame(&d)["tabs"],
        json!([
            {"id": "t3", "name": "Italian, the Bc5 line", "kind": "free", "mark": null},
            {"id": "t1", "name": "Board 1", "kind": "free", "mark": null},
        ])
    );
}

#[test]
fn names_are_cleaned_and_cut() {
    assert_eq!(
        clean_tab_name("  Italian \t\n line  ").as_deref(),
        Some("Italian line")
    );
    assert_eq!(
        clean_tab_name("Ruy\u{200B}\u{0007} Lopez").as_deref(),
        Some("Ruy Lopez")
    );
    assert_eq!(clean_tab_name(" \u{200B}\u{FEFF} "), None);
    assert_eq!(clean_tab_name(""), None);

    let long = "a".repeat(39) + " bcdef";
    assert_eq!(
        clean_tab_name(&long).as_deref(),
        Some("a".repeat(39).as_str())
    );
    assert_eq!(MAX_TAB_NAME_CHARS, 40);

    let wide = "\u{00E9}".repeat(50);
    assert_eq!(clean_tab_name(&wide).unwrap().chars().count(), 40);

    let mut d = Desk::new("i1");

    let result = apply(
        &mut d,
        VIEW,
        json!({"op": "tab_rename", "tab": "t1", "name": "x".repeat(60)}),
    );
    assert_eq!(result["name"], "x".repeat(40));
    assert_eq!(d.tab(id("t1")).unwrap().name(), "x".repeat(40));

    let (code, _) = refuse(
        &mut d,
        VIEW,
        json!({"op": "tab_rename", "tab": "t1", "name": " \u{200B} "}),
    );
    assert_eq!(code, "bad_input");

    apply(&mut d, VIEW, json!({"op": "tab_new", "name": "   "}));
    assert_eq!(d.tab(id("t2")).unwrap().name(), "Board 1");

    apply(&mut d, VIEW, json!({"op": "tab_new", "name": "Board 1"}));
    assert_eq!(d.tab(id("t3")).unwrap().name(), "Board 1");
}

#[test]
fn default_names_take_the_lowest_free_number() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);
    new_tab(&mut d);

    let names: Vec<&str> = d.tabs().iter().map(|t| t.name()).collect();
    assert_eq!(names, ["Board 1", "Board 2", "Board 3"]);

    apply(&mut d, VIEW, json!({"op": "tab_close", "tab": "t2"}));
    new_tab(&mut d);
    assert_eq!(d.tab(id("t4")).unwrap().name(), "Board 2");

    new_tab(&mut d);
    assert_eq!(d.tab(id("t5")).unwrap().name(), "Board 4");
}

#[test]
fn each_mark_comes_from_its_table() {
    let mut d = Desk::new("i1");
    for _ in 0..4 {
        new_tab(&mut d);
    }

    apply_on(
        &mut d,
        "t2",
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );

    apply_on(
        &mut d,
        "t3",
        VIEW,
        json!({"op": "match_start", "seats": {"white": "ai", "black": "human"}}),
    );

    apply_on(
        &mut d,
        "t4",
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "human"}}),
    );
    for mv in ["f3", "e5", "g4", "Qh4#"] {
        apply_on(&mut d, "t4", VIEW, json!({"op": "play", "move": mv}));
    }

    apply_on(
        &mut d,
        "t5",
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "engine"}}),
    );
    apply_on(&mut d, "t5", VIEW, json!({"op": "play", "move": "e4"}));
    apply_on(&mut d, "t5", VIEW, json!({"op": "back"}));

    let marks: Vec<Option<Mark>> = d.tabs().iter().map(|t| Mark::of(t.table())).collect();
    assert_eq!(
        marks,
        [
            None,
            Some(Mark::YourMove),
            Some(Mark::Waiting),
            Some(Mark::Over),
            Some(Mark::Waiting),
        ]
    );

    let f = frame(&d);
    let sent: Vec<Value> = f["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["mark"].clone())
        .collect();
    assert_eq!(
        sent,
        [
            json!(null),
            json!("your_move"),
            json!("waiting"),
            json!("over"),
            json!("waiting")
        ]
    );

    apply_on(&mut d, "t2", VIEW, json!({"op": "match_stop"}));
    assert_eq!(frame(&d)["tabs"][1]["mark"], json!(null));
}

#[test]
fn a_copy_takes_the_game_and_study_but_not_the_match() {
    let mut d = Desk::new("i1");
    apply(
        &mut d,
        VIEW,
        json!({"op": "play", "move": "e4", "note": "King's pawn."}),
    );
    apply(
        &mut d,
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );

    let result = apply(&mut d, VIEW, json!({"op": "tab_new", "copy_of": "t1"}));
    assert_eq!(result, json!({"tab": "t2"}));
    assert_eq!(d.selected(), id("t2"));

    let copy = d.table(id("t2")).unwrap();
    let source = d.table(id("t1")).unwrap();

    assert_eq!(
        serde_json::to_value(copy.game().snapshot()).unwrap(),
        serde_json::to_value(source.game().snapshot()).unwrap()
    );
    assert!(!copy.match_state().active);
    assert!(source.match_state().active);
    assert_eq!(copy.board_rev(), 0);
    assert_eq!(copy.game_id(), 2);
    assert_eq!(d.tab(id("t2")).unwrap().name(), "Board 2");

    apply(&mut d, VIEW, json!({"op": "play", "move": "e5"}));
    assert_eq!(d.table(id("t1")).unwrap().game().current(), 1);
    assert_eq!(d.table(id("t2")).unwrap().game().current(), 2);
}

#[test]
fn set_instance_reaches_every_tab() {
    let mut d = Desk::new("i1");
    new_tab(&mut d);

    d.set_instance("i2");

    assert_eq!(d.instance(), "i2");
    assert_eq!(frame(&d)["instance"], "i2");
    for tab in d.tabs() {
        assert_eq!(tab.table().instance(), "i2");
    }

    let reps = d.open_tab(TabKind::Reps, "Reps", None, "rukh").unwrap();
    assert_eq!(d.table(reps).unwrap().instance(), "i2");
}

#[test]
fn a_program_tab_keeps_its_source_and_kind() {
    let mut d = Desk::new("i1");

    let source = d
        .open_tab(
            TabKind::Free,
            "Game 7: lost to Rook",
            Some("g0007".into()),
            "rukh",
        )
        .unwrap();
    let tab = d.tab(source).unwrap();
    assert_eq!(tab.source(), Some("g0007"));
    assert_eq!(tab.kind(), TabKind::Free);
    assert_eq!(tab.name(), "Game 7: lost to Rook");
    assert_eq!(d.selected(), id("t1"));
}

#[test]
fn a_program_tab_needs_a_visible_name() {
    let mut d = Desk::new("i1");

    for kind in [TabKind::Free, TabKind::Game, TabKind::Reps] {
        for name in ["", "   ", " \u{200B}\u{FEFF} "] {
            let err = d.open_tab(kind, name, None, "rukh").unwrap_err();
            assert_eq!(err.code(), "bad_input", "{kind:?} {name:?}");
        }
    }

    assert_eq!(order(&d), ["t1"]);
    assert_eq!(d.rev(), 0);
    assert_eq!(d.next_game_id(), 2);
}

#[test]
fn a_new_tab_names_its_change_in_the_hint() {
    let mut d = Desk::new("i1");

    d.apply_with_id(VIEW, r#"{"op":"tab_new"}"#, NOW, Some(7))
        .unwrap();
    assert_eq!(
        frame(&d)["hint"],
        json!({"reason": "tab_new", "by": "view:1", "intent_id": 7})
    );

    d.open_tab(TabKind::Reps, "Reps", None, "rukh").unwrap();
    assert_eq!(
        frame(&d)["hint"],
        json!({"reason": "tab_new", "by": "rukh"})
    );
}

#[test]
fn with_one_tab_the_frame_is_the_table_frame_and_two_keys() {
    let mut d = Desk::new("i1");
    let mut t = Table::new("i1");

    let head = r#"{"t":"state","instance":"i1","rev":0,"now_ms":1000,"hint":{"reason":"init","by":"rukh"},"tab":"t1","tabs":[{"id":"t1","name":"Board 1","kind":"free","mark":null}],"state":{"#;
    assert!(d.frame(NOW).starts_with(head), "{}", d.frame(NOW));

    for intent in [
        json!({"op": "play", "move": "e4"}),
        json!({"op": "annotate", "note": "Open."}),
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
        json!({"op": "new_game"}),
    ] {
        let text = intent.to_string();
        let a = d.apply(VIEW, &text, NOW).unwrap();
        let b = t.apply(VIEW, &text, NOW).unwrap();

        let start = a.frame_json.find(r#","tab":"#).expect("a tab key");
        let end = a.frame_json.find(r#","state":"#).expect("a state key");
        let without = format!("{}{}", &a.frame_json[..start], &a.frame_json[end..]);

        assert_eq!(without, b.frame_json, "{intent}");
    }
}
