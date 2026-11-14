//! The table: intents, counters, seats, turns and annotations, with no I/O and no clock.

use rukh_core::session::RULE_ANNOTATE;
use rukh_core::{Seat, Side, Style, Table, WaitFor};
use serde_json::{json, Value};

const VIEW: &str = "view:1";
const AI: &str = "ai:claude-code";
const OTHER_AI: &str = "ai:other";

fn apply(t: &mut Table, by: &str, intent: Value) -> Value {
    let applied = t
        .apply(by, &intent.to_string(), 1000)
        .unwrap_or_else(|e| panic!("{intent}: {e}"));
    let parsed: Value = serde_json::from_str(&applied.result_json).expect("result is JSON");
    assert_eq!(parsed, applied.result);
    applied.result
}

fn refuse(t: &mut Table, by: &str, intent: Value) -> &'static str {
    let before = t.frame(1000);
    let err = t
        .apply(by, &intent.to_string(), 1000)
        .expect_err("the intent should be refused");
    assert_eq!(t.frame(1000), before, "a refused intent changes nothing");
    err.code()
}

fn frame(t: &Table) -> Value {
    serde_json::from_str(&t.frame(1000)).expect("frame is JSON")
}

/// A match with the person on White and the AI on Black, started from the current node.
fn match_vs_ai_black(t: &mut Table) {
    apply(
        t,
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );
}

// ---------------------------------------------------------------- turns

#[test]
fn after_an_ai_plays_it_is_not_its_turn_until_the_other_side_moves() {
    let mut t = Table::new("i");
    apply(
        &mut t,
        VIEW,
        json!({"op": "match_start", "seats": {"white": "ai", "black": "human"}}),
    );
    assert!(t.is_ai_turn(Side::White));
    apply(&mut t, AI, json!({"op": "play", "move": "e4"}));
    assert!(!t.is_ai_turn(Side::White));
    assert_eq!(t.to_move(), Some(Seat::Human));
    assert!(t
        .wait_event(AI, WaitFor::MyTurn(Side::White), t.rev(), 1)
        .is_none());
    // An evaluation and the AI's own note change nothing about whose turn it is.
    let node = t.game().current();
    apply(
        &mut t,
        "view:engine",
        json!({"op": "set_eval", "node": node, "eval": {"cp": 30, "depth": 12}}),
    );
    apply(
        &mut t,
        AI,
        json!({"op": "annotate", "note": "central pawn"}),
    );
    assert!(!t.is_ai_turn(Side::White));
    apply(&mut t, VIEW, json!({"op": "play", "move": "e5"}));
    assert!(t.is_ai_turn(Side::White));
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::White), t.rev(), 1)
        .expect("its turn");
    assert_eq!(ev.event, "your_turn");
}

#[test]
fn a_move_by_the_person_makes_it_the_ais_turn_at_once() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    assert_eq!(t.to_move(), Some(Seat::Human));
    assert!(!t.is_ai_turn(Side::Black));
    apply(&mut t, VIEW, json!({"op": "play", "move": "d4"}));
    assert_eq!(t.to_move(), Some(Seat::Ai));
    assert!(t.is_ai_turn(Side::Black));
    // Level-triggered: asking again still says so.
    for _ in 0..2 {
        let ev = t
            .wait_event(AI, WaitFor::MyTurn(Side::Black), 0, 2)
            .expect("its turn");
        assert_eq!(ev.event, "your_turn");
        let body = serde_json::to_value(&ev).unwrap();
        assert_eq!(body["your_seat"], "black");
        assert_eq!(body["to_move"], "ai");
        assert_eq!(body["views"], 2);
    }
    assert_eq!(frame(&t)["state"]["match"]["to_move"], "ai");
}

#[test]
fn browsing_away_from_the_tip_pauses_the_match_and_returning_restores_it() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    assert!(t.live());
    assert_eq!(t.to_move(), Some(Seat::Ai));
    apply(&mut t, VIEW, json!({"op": "back"}));
    assert!(!t.live());
    assert_eq!(t.to_move(), None);
    let f = frame(&t);
    assert_eq!(f["state"]["match"]["live"], false);
    assert_eq!(f["state"]["match"]["to_move"], Value::Null);
    assert!(t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), 0, 1)
        .is_none());
    apply(&mut t, VIEW, json!({"op": "forward"}));
    assert!(t.live());
    assert_eq!(t.to_move(), Some(Seat::Ai));
    apply(&mut t, VIEW, json!({"op": "to_start"}));
    assert_eq!(t.to_move(), None);
    apply(&mut t, VIEW, json!({"op": "to_end"}));
    assert_eq!(t.to_move(), Some(Seat::Ai));
}

#[test]
fn an_ai_move_while_browsing_lands_on_the_tip() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    let tip = t.game().current();
    apply(&mut t, VIEW, json!({"op": "to_start"}));
    assert_eq!(t.game().current(), 0);
    let r = apply(&mut t, AI, json!({"op": "play", "move": "c5"}));
    let node = r["node"].as_u64().unwrap() as u32;
    assert_eq!(t.game().node(node).unwrap().parent, Some(tip));
    assert_eq!(t.match_state().tip, node);
    assert_eq!(t.game().current(), node);
    assert!(t.live());
    assert_eq!(t.to_move(), Some(Seat::Human));
}

#[test]
fn an_eval_or_an_ais_own_note_refuses_nothing_and_leaves_board_rev() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    let seen = t.game().current();
    let board_rev = t.board_rev();
    let rev = t.rev();
    apply(
        &mut t,
        "view:engine",
        json!({"op": "set_eval", "node": seen, "eval": {"cp": 25, "depth": 18, "pv": ["e7e5"]}}),
    );
    apply(
        &mut t,
        AI,
        json!({"op": "annotate", "node": seen, "note": "Her king pawn.",
               "arrows": [{"from": "e7", "to": "e5"}]}),
    );
    assert_eq!(t.board_rev(), board_rev);
    assert_eq!(t.rev(), rev + 2);
    let r = apply(
        &mut t,
        AI,
        json!({"op": "play", "move": "e5", "from_node": seen}),
    );
    assert_eq!(r["san"], "e5");
    assert_eq!(t.board_rev(), board_rev + 1);
}

#[test]
fn an_eval_wakes_nobody() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    let start = t.rev();
    apply(
        &mut t,
        "view:engine",
        json!({"op": "set_eval", "node": 0, "eval": {"cp": 20, "depth": 10}}),
    );
    assert!(t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), start, 1)
        .is_none());
    assert!(t
        .wait_event(
            AI,
            WaitFor::AnyChange {
                since: Some(t.board_rev())
            },
            start,
            1
        )
        .is_none());
    assert!(t.changes_since(0, AI).is_empty());
}

#[test]
fn an_ais_annotation_is_news_to_others_but_not_to_itself() {
    let mut t = Table::new("i");
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    let since = t.board_rev();
    let start = t.rev();
    apply(&mut t, AI, json!({"op": "annotate", "note": "Open game."}));
    assert_eq!(t.board_rev(), since, "an AI's note does not bump board_rev");
    assert!(t
        .wait_event(AI, WaitFor::AnyChange { since: Some(since) }, start, 1)
        .is_none());
    assert!(t.changes_for(AI, Some(since), start).is_empty());
    let other = t.changes_for(OTHER_AI, Some(since), start);
    assert_eq!(other.len(), 1);
    assert_eq!(other[0].by, AI);
    assert_eq!(other[0].reason, "annotate");
    let ev = t
        .wait_event(
            OTHER_AI,
            WaitFor::AnyChange { since: Some(since) },
            start,
            1,
        )
        .expect("another reader is told");
    assert_eq!(ev.event, "changed");
    assert_eq!(ev.since_last.as_ref().map(Vec::len), Some(1));
    // A view's annotation bumps board_rev and is news to the AI.
    let start = t.rev();
    apply(&mut t, VIEW, json!({"op": "annotate", "nag": "!"}));
    assert_eq!(t.board_rev(), since + 1);
    let mine = t.changes_since(since, AI);
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].by, VIEW);
    assert!(t
        .wait_event(AI, WaitFor::AnyChange { since: None }, start, 1)
        .is_some());
}

#[test]
fn any_change_without_since_waits_for_the_next_change() {
    let mut t = Table::new("i");
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    let start = t.rev();
    let ahead = Some(t.board_rev() + 5);
    assert!(t
        .wait_event(AI, WaitFor::AnyChange { since: None }, start, 1)
        .is_none());
    assert!(t
        .wait_event(AI, WaitFor::AnyChange { since: ahead }, start, 1)
        .is_none());
    apply(&mut t, VIEW, json!({"op": "play", "move": "e5"}));
    let ev = t
        .wait_event(AI, WaitFor::AnyChange { since: ahead }, start, 1)
        .expect("woken");
    let body = serde_json::to_value(&ev).unwrap();
    assert_eq!(body["event"], "changed");
    assert_eq!(body["since_last"][0]["san"], "e5");
    assert_eq!(body["since_last"][0]["reason"], "move");
}

#[test]
fn timeout_is_one_line() {
    let body = serde_json::to_value(rukh_core::WaitEvent::timeout(7)).unwrap();
    assert_eq!(body, json!({"event": "timeout", "board_rev": 7}));
}

#[test]
fn game_over_is_reported_to_a_waiting_ai() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    for (by, mv) in [(VIEW, "f3"), (AI, "e5"), (VIEW, "g4"), (AI, "Qh4#")] {
        apply(&mut t, by, json!({"op": "play", "move": mv}));
    }
    assert_eq!(t.to_move(), None);
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), 0, 1)
        .expect("game over");
    assert_eq!(ev.event, "game_over");
    let body = serde_json::to_value(&ev).unwrap();
    assert_eq!(body["status"]["outcome"], "0-1");
    assert_eq!(
        refuse(&mut t, AI, json!({"op": "play", "move": "a6"})),
        "game_over"
    );
}

// ---------------------------------------------------------------- seats and style

#[test]
fn a_seat_claim_starts_a_match() {
    let mut t = Table::new("i");
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    let here = t.game().current();
    let r = apply(&mut t, AI, json!({"op": "claim_seat", "seat": "black"}));
    assert_eq!(r["claimed"], true);
    assert_eq!(r["started"], true);
    let m = t.match_state();
    assert!(m.active);
    assert_eq!(m.seats.black, Seat::Ai);
    assert_eq!(m.seats.white, Seat::Human);
    assert_eq!(m.tip, here);
    assert_eq!(m.style, Style::Annotate);
    assert!(t.is_ai_turn(Side::Black));
    // Claiming again is harmless and changes nothing.
    let rev = t.rev();
    let r = apply(&mut t, AI, json!({"op": "claim_seat", "seat": "black"}));
    assert_eq!(r["claimed"], false);
    assert_eq!(t.rev(), rev);
    // The other colour is refused with a sentence that names the AI's seat.
    let err = t
        .apply(
            AI,
            &json!({"op": "claim_seat", "seat": "white"}).to_string(),
            0,
        )
        .unwrap_err();
    assert_eq!(err.code(), "bad_input");
    assert!(err.to_string().contains("Black"), "{err}");
    // A view cannot claim.
    assert_eq!(
        refuse(&mut t, VIEW, json!({"op": "claim_seat", "seat": "white"})),
        "bad_input"
    );
}

#[test]
fn style_junk_becomes_annotate_and_rules_ride_along() {
    let mut t = Table::new("i");
    let r = apply(&mut t, VIEW, json!({"op": "set_style", "style": "coach"}));
    assert_eq!(r["style"]["name"], "coach");
    assert_eq!(t.match_state().style, Style::Coach);
    apply(
        &mut t,
        VIEW,
        json!({"op": "set_style", "style": "grandmaster"}),
    );
    assert_eq!(t.match_state().style, Style::Annotate);
    apply(
        &mut t,
        VIEW,
        json!({"op": "set_style", "style": " SILENT "}),
    );
    assert_eq!(t.match_state().style, Style::Silent);
    apply(
        &mut t,
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}, "style": "x"}),
    );
    let body = serde_json::to_value(t.position(Some(Side::Black), 1)).unwrap();
    assert_eq!(body["style"]["name"], "annotate");
    assert_eq!(body["style"]["rule"], RULE_ANNOTATE);
    assert_eq!(Style::normalize(""), Style::Annotate);
    assert_eq!(frame(&t)["state"]["match"]["style"], "annotate");
}

#[test]
fn seat_and_style_changes_bump_rev_but_not_board_rev() {
    let mut t = Table::new("i");
    let (rev, board_rev) = (t.rev(), t.board_rev());
    apply(
        &mut t,
        VIEW,
        json!({"op": "set_seats", "white": "human", "black": "engine"}),
    );
    apply(&mut t, VIEW, json!({"op": "set_style", "style": "coach"}));
    apply(
        &mut t,
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );
    apply(&mut t, VIEW, json!({"op": "match_stop"}));
    assert_eq!(t.rev(), rev + 4);
    assert_eq!(t.board_rev(), board_rev);
    assert!(t.recent().is_empty());
    // Stopping again changes nothing.
    apply(&mut t, VIEW, json!({"op": "match_stop"}));
    assert_eq!(t.rev(), rev + 4);
    assert_eq!(
        refuse(
            &mut t,
            VIEW,
            json!({"op": "set_seats", "white": "robot", "black": "ai"})
        ),
        "bad_input"
    );
}

// ---------------------------------------------------------------- moves

#[test]
fn a_mismatched_from_node_is_stale_and_changes_nothing() {
    let mut t = Table::new("i");
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    assert_eq!(
        refuse(
            &mut t,
            VIEW,
            json!({"op": "play", "move": "e5", "from_node": 0})
        ),
        "stale"
    );
    assert_eq!(
        refuse(
            &mut t,
            AI,
            json!({"op": "play", "move": "e5", "from_node": 99})
        ),
        "stale"
    );
    let here = t.game().current();
    let r = apply(
        &mut t,
        AI,
        json!({"op": "play", "move": "1... e5!", "from_node": here}),
    );
    assert_eq!(r["san"], "e5");
}

#[test]
fn an_ai_out_of_turn_in_a_match_is_refused() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    assert_eq!(
        refuse(&mut t, AI, json!({"op": "play", "move": "e4"})),
        "not_your_turn"
    );
    // With no match the AI may move either side.
    apply(&mut t, VIEW, json!({"op": "match_stop"}));
    apply(&mut t, AI, json!({"op": "play", "move": "e4"}));
    apply(&mut t, AI, json!({"op": "play", "move": "e5"}));
}

#[test]
fn a_view_may_move_either_side_and_a_tip_move_moves_the_tip() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    apply(&mut t, VIEW, json!({"op": "play", "move": "e5"}));
    assert_eq!(t.match_state().tip, t.game().current());
    assert_eq!(t.to_move(), Some(Seat::Human));
    // A hand move away from the tip starts a variation and leaves the tip alone.
    let tip = t.match_state().tip;
    apply(&mut t, VIEW, json!({"op": "back"}));
    apply(&mut t, VIEW, json!({"op": "play", "move": "c5"}));
    assert_eq!(t.match_state().tip, tip);
    assert!(!t.live());
}

#[test]
fn an_illegal_move_names_the_legal_ones_and_keeps_the_board() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    apply(&mut t, VIEW, json!({"op": "to_start"}));
    let before = t.frame(1000);
    let err = t
        .apply(AI, &json!({"op": "play", "move": "Ke2"}).to_string(), 1000)
        .unwrap_err();
    assert_eq!(err.code(), "illegal");
    assert!(err.to_string().contains("Black is to move"), "{err}");
    assert!(err.to_string().contains("e5"), "{err}");
    assert_eq!(t.frame(1000), before);
    assert_eq!(t.game().current(), 0);
}

#[test]
fn play_carries_annotations_in_one_change() {
    let mut t = Table::new("i");
    let rev = t.rev();
    let r = apply(
        &mut t,
        AI,
        json!({"op": "play", "move": "Nf3", "note": "Flexible.", "nag": "!",
               "arrows": [{"from": "f3", "to": "e5", "color": "red"}, {"from": "z9", "to": "e5"}],
               "highlights": [{"square": "e5"}]}),
    );
    assert_eq!(t.rev(), rev + 1);
    assert_eq!(r["applied"]["arrows"], 1);
    assert_eq!(r["applied"]["note"], true);
    assert_eq!(r["rejected"].as_array().unwrap().len(), 1);
    assert_eq!(r["board_rev"], t.board_rev());
    let node = t.game().current_node();
    assert_eq!(node.note, "Flexible.");
    assert_eq!(node.nag, "!");
    assert_eq!(node.arrows[0].source.as_deref(), Some("ai"));
    assert_eq!(node.arrows[0].color, "red");
    assert_eq!(node.highlights[0].color, "green");
}

// ---------------------------------------------------------------- annotate

#[test]
fn annotate_add_appends_arrows_merges_highlights_and_replaces_a_note() {
    let mut t = Table::new("i");
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "note": "first", "arrows": [{"from": "e2", "to": "e4"}],
               "highlights": [{"square": "e4", "color": "red"}]}),
    );
    let r = apply(
        &mut t,
        AI,
        json!({"op": "annotate", "note": "", "arrows": [{"from": "g1", "to": "f3", "color": "blue"}],
               "highlights": [{"square": "e4", "color": "yellow"}, {"square": "d4"}]}),
    );
    assert_eq!(
        r["applied"],
        json!({"arrows": 1, "highlights": 2, "note": false, "nag": false})
    );
    let node = t.game().current_node();
    assert_eq!(
        node.note, "first",
        "an empty note does not replace in add mode"
    );
    assert_eq!(node.arrows.len(), 2);
    assert_eq!(node.arrows[0].source.as_deref(), Some("user"));
    assert_eq!(node.arrows[1].source.as_deref(), Some("ai"));
    assert!(node.arrows[1].knight);
    assert_eq!(node.highlights.len(), 2);
    assert_eq!(node.highlights[0].square, "e4");
    assert_eq!(node.highlights[0].color, "yellow");
    apply(&mut t, AI, json!({"op": "annotate", "note": "second"}));
    assert_eq!(t.game().current_node().note, "second");
}

#[test]
fn annotate_replace_and_clear() {
    let mut t = Table::new("i");
    apply(&mut t, VIEW, json!({"op": "play", "move": "d4"}));
    let node = t.game().current();
    apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "node": node, "note": "n", "nag": "?!",
               "arrows": [{"from": "d2", "to": "d4"}, {"from": "c2", "to": "c4"}],
               "highlights": [{"square": "d4"}, {"square": "c4"}]}),
    );
    apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "node": node, "mode": "replace",
               "arrows": [{"from": "e2", "to": "e4", "color": "yellow"}]}),
    );
    let n = t.game().node(node).unwrap();
    assert_eq!(n.arrows.len(), 1);
    assert_eq!(n.arrows[0].from, "e2");
    assert_eq!(n.note, "n", "fields not given are kept by replace");
    assert_eq!(n.highlights.len(), 2);
    apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "node": node, "mode": "clear", "highlights": [{"square": "c4"}]}),
    );
    let n = t.game().node(node).unwrap();
    assert_eq!(n.highlights.len(), 1);
    assert_eq!(n.highlights[0].square, "d4");
    let r = apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "node": node, "mode": "clear"}),
    );
    assert_eq!(r["applied"]["note"], true);
    let n = t.game().node(node).unwrap();
    assert!(
        n.note.is_empty() && n.nag.is_empty() && n.arrows.is_empty() && n.highlights.is_empty()
    );
    // Clearing an already empty node changes nothing.
    let rev = t.rev();
    apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "node": node, "mode": "clear"}),
    );
    assert_eq!(t.rev(), rev);
}

#[test]
fn annotate_reports_bad_items_in_rejected() {
    let mut t = Table::new("i");
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    let rev = t.rev();
    let r = apply(
        &mut t,
        AI,
        json!({"op": "annotate", "nag": "!!!",
               "arrows": [{"from": "e2", "to": "e9"}, {"from": "e2", "to": "e4", "color": "pink"},
                          {"from": "e4", "to": "e4"}, "e2e4"],
               "highlights": [{"square": "i1"}, {"square": "a1", "color": 3}]}),
    );
    let rejected = r["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 7);
    let items: Vec<&str> = rejected
        .iter()
        .map(|x| x["item"].as_str().unwrap())
        .collect();
    assert_eq!(
        items,
        [
            "nag",
            "arrow",
            "arrow",
            "arrow",
            "arrow",
            "highlight",
            "highlight"
        ]
    );
    assert!(rejected
        .iter()
        .all(|x| !x["reason"].as_str().unwrap().is_empty()));
    assert_eq!(rejected[0]["value"], "!!!");
    assert_eq!(t.rev(), rev, "nothing valid, nothing changed");
    // The six glyphs and their PGN numbers are accepted.
    apply(&mut t, AI, json!({"op": "annotate", "nag": "$4"}));
    assert_eq!(t.game().current_node().nag, "??");
    // An unknown node is refused as a whole.
    assert_eq!(
        refuse(
            &mut t,
            AI,
            json!({"op": "annotate", "node": 77, "note": "x"})
        ),
        "bad_input"
    );
}

// ---------------------------------------------------------------- counters and new games

#[test]
fn new_game_stops_the_match_and_bumps_game_id() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    let (game_id, board_rev) = (t.game_id(), t.board_rev());
    let r = apply(&mut t, AI, json!({"op": "new_game", "chess960": 0}));
    assert_eq!(r["variant"], "chess960");
    assert_eq!(t.game_id(), game_id + 1);
    assert_eq!(t.board_rev(), board_rev + 1);
    assert!(!t.match_state().active);
    assert_eq!(t.to_move(), None);
    assert_eq!(t.recent().back().unwrap().reason, "new_game");
    assert_eq!(
        refuse(&mut t, VIEW, json!({"op": "new_game", "fen": "8/8/8 w"})),
        "bad_input"
    );
    assert_eq!(
        refuse(&mut t, VIEW, json!({"op": "new_game", "chess960": 960})),
        "bad_input"
    );
}

#[test]
fn recent_keeps_at_most_sixteen() {
    let mut t = Table::new("i");
    let moves = "Nf3 Nf6 Ng1 Ng8 Nc3 Nc6 Nb1 Nb8 e4 e5 d4 d5 c4 c5 b4 b5 a4 a5 h4 h5";
    for m in moves.split_whitespace() {
        apply(&mut t, VIEW, json!({"op": "play", "move": m}));
    }
    assert_eq!(t.recent().len(), 16);
    assert_eq!(t.recent().back().unwrap().san.as_deref(), Some("h5"));
    assert_eq!(t.recent().front().unwrap().board_rev, t.board_rev() - 15);
}

#[test]
fn rev_moves_on_every_change_and_board_rev_only_on_board_changes() {
    let mut t = Table::new("i");
    let mut rev = t.rev();
    let mut board_rev = t.board_rev();
    let steps: Vec<(&str, Value, bool)> = vec![
        (VIEW, json!({"op": "play", "move": "e4"}), true),
        (VIEW, json!({"op": "annotate", "note": "x"}), true),
        (AI, json!({"op": "annotate", "note": "y"}), false),
        (VIEW, json!({"op": "back"}), true),
        (AI, json!({"op": "forward"}), false),
        (VIEW, json!({"op": "goto", "node": 0}), true),
        (
            "view:2",
            json!({"op": "set_eval", "node": 0, "eval": {"cp": 5}}),
            false,
        ),
        (VIEW, json!({"op": "set_style", "style": "silent"}), false),
        (AI, json!({"op": "claim_seat", "seat": "white"}), false),
        (AI, json!({"op": "play", "move": "d4"}), true),
        (VIEW, json!({"op": "new_game"}), true),
    ];
    for (by, intent, board) in steps {
        apply(&mut t, by, intent.clone());
        rev += 1;
        if board {
            board_rev += 1;
        }
        assert_eq!(t.rev(), rev, "{intent}");
        assert_eq!(t.board_rev(), board_rev, "{intent}");
    }
    // Stepping back at the start changes nothing and counts nothing.
    apply(&mut t, VIEW, json!({"op": "back"}));
    assert_eq!(t.rev(), rev);
}

#[test]
fn the_frame_has_the_agreed_shape() {
    let mut t = Table::new("abc");
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    let applied = t
        .apply_with_id(
            VIEW,
            &json!({"t": "intent", "id": 9, "op": "play", "move": "e5"}).to_string(),
            5,
            Some(9),
        )
        .unwrap();
    let f: Value = serde_json::from_str(&applied.frame_json).unwrap();
    assert_eq!(f["t"], "state");
    assert_eq!(f["instance"], "abc");
    assert_eq!(f["rev"], applied.rev);
    assert_eq!(f["now_ms"], 5);
    assert_eq!(
        f["hint"],
        json!({"reason": "move", "by": VIEW, "intent_id": 9})
    );
    let s = &f["state"];
    assert_eq!(s["game_id"], 1);
    assert_eq!(s["board_rev"], 2);
    assert_eq!(
        s["recent"][1],
        json!({"board_rev": 2, "by": VIEW, "reason": "move", "node": 2, "san": "e5"})
    );
    assert_eq!(s["game"]["current"], 2);
    assert_eq!(s["study"], json!({"title": "", "notes": ""}));
    assert_eq!(
        s["match"],
        json!({"active": false, "seats": {"white": "human", "black": "human"}, "tip": 0,
               "live": false, "to_move": null, "style": "annotate", "time_control": null})
    );
    assert_eq!(s["clock"], Value::Null);
}

#[test]
fn the_position_body_has_the_agreed_fields() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    let body = serde_json::to_value(t.position(Some(Side::Black), 1)).unwrap();
    let keys: Vec<&str> = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    for k in [
        "node",
        "fen",
        "turn",
        "ply",
        "move_number",
        "line",
        "last_move",
        "status",
        "legal_moves",
        "clock",
        "seats",
        "to_move",
        "your_seat",
        "style",
        "note",
        "nag",
        "arrows",
        "highlights",
        "path",
        "board_rev",
        "views",
    ] {
        assert!(keys.contains(&k), "missing {k}");
    }
    assert!(!keys.contains(&"eval"), "eval only when stored");
    assert_eq!(body["turn"], "black");
    assert_eq!(body["move_number"], 1);
    assert_eq!(body["line"], "1. e4");
    assert_eq!(body["last_move"], json!({"san": "e4", "uci": "e2e4"}));
    assert_eq!(body["status"]["text"], "Black to move.");
    assert_eq!(body["path"], json!([{"node": 1, "ply": 1, "san": "e4"}]));
    assert_eq!(body["legal_moves"].as_array().unwrap().len(), 20);
    let tree = serde_json::to_value(t.tree(None, 0)).unwrap();
    assert_eq!(tree["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(tree["your_seat"], Value::Null);
}

#[test]
fn intents_that_cannot_be_read_are_bad_input() {
    let mut t = Table::new("i");
    assert_eq!(refuse(&mut t, VIEW, json!({"op": "launch"})), "bad_input");
    assert_eq!(refuse(&mut t, VIEW, json!({"move": "e4"})), "bad_input");
    let err = t.apply(VIEW, "not json", 0).unwrap_err();
    assert_eq!(err.code(), "bad_input");
}

// ---------------------------------------------------------------- the person ends a match

/// A match the AI started by claiming Black, with the person to move.
fn ai_claims_black(t: &mut Table) {
    let r = apply(t, AI, json!({"op": "claim_seat", "seat": "black"}));
    assert_eq!(r["started"], true);
}

fn claim_error(t: &mut Table, seat: &str) -> String {
    let err = t
        .apply(
            AI,
            &json!({"op": "claim_seat", "seat": seat}).to_string(),
            0,
        )
        .expect_err("the claim should be refused");
    assert_eq!(err.code(), "bad_input");
    err.to_string()
}

#[test]
fn stop_ends_a_waiting_ais_loop_and_sticks() {
    let mut t = Table::new("i");
    ai_claims_black(&mut t);
    assert!(t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), t.rev(), 1)
        .is_none());
    apply(&mut t, VIEW, json!({"op": "match_stop"}));
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), t.rev(), 1)
        .expect("the open wait is told");
    assert_eq!(ev.event, "game_over");
    assert_eq!(ev.stopped, Some("match_stop"));
    // The next wait(seat) does not start a new match behind the person's back.
    let text = claim_error(&mut t, "black");
    assert!(text.contains("stopped the match"), "{text}");
    assert!(!t.match_state().active);
    // The person pressing Start again lets the AI back in.
    match_vs_ai_black(&mut t);
    let r = apply(&mut t, AI, json!({"op": "claim_seat", "seat": "black"}));
    assert_eq!(r["claimed"], false);
    assert!(t.match_state().active);
}

#[test]
fn a_new_game_from_the_board_ends_a_waiting_ais_loop_and_sticks() {
    let mut t = Table::new("i");
    ai_claims_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    apply(&mut t, AI, json!({"op": "play", "move": "e5"}));
    apply(&mut t, VIEW, json!({"op": "new_game"}));
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), t.rev(), 1)
        .expect("the open wait is told");
    assert_eq!(ev.event, "game_over");
    assert_eq!(ev.stopped, Some("new_game"));
    let text = claim_error(&mut t, "black");
    assert!(text.contains("new game"), "{text}");
    // A new game on an idle analysis board does not block a later claim.
    let mut idle = Table::new("i");
    apply(&mut idle, VIEW, json!({"op": "new_game"}));
    let r = apply(&mut idle, AI, json!({"op": "claim_seat", "seat": "white"}));
    assert_eq!(r["started"], true);
}

#[test]
fn opponent_nobody_ends_a_waiting_ais_loop_and_the_seat_is_not_retaken() {
    let mut t = Table::new("i");
    ai_claims_black(&mut t);
    apply(
        &mut t,
        VIEW,
        json!({"op": "set_seats", "white": "human", "black": "human"}),
    );
    assert!(t.match_state().active);
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), t.rev(), 1)
        .expect("the open wait is told");
    assert_eq!(ev.event, "game_over");
    assert_eq!(ev.stopped, Some("seats"));
    let body = serde_json::to_value(&ev).unwrap();
    assert_eq!(body["your_seat"], Value::Null);
    let text = claim_error(&mut t, "black");
    assert!(text.contains("played by a person"), "{text}");
    assert_eq!(t.match_state().seats.black, Seat::Human);
    // Start with Opponent: Nobody is the same choice.
    let mut t = Table::new("i");
    apply(
        &mut t,
        VIEW,
        json!({"op": "match_start", "seats": {"white": "human", "black": "human"}}),
    );
    claim_error(&mut t, "white");
}

fn ai_mates_as_black(t: &mut Table) {
    for (by, mv) in [(VIEW, "f3"), (AI, "e5"), (VIEW, "g4"), (AI, "Qh4#")] {
        apply(t, by, json!({"op": "play", "move": mv}));
    }
}

#[test]
fn a_new_game_after_a_finished_game_leaves_the_seat_open() {
    let mut t = Table::new("i");
    ai_claims_black(&mut t);
    ai_mates_as_black(&mut t);
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), t.rev(), 1)
        .expect("game over");
    assert_eq!(ev.event, "game_over");
    assert_eq!(ev.stopped, None);
    assert!(ev.result.is_some());

    apply(&mut t, VIEW, json!({"op": "new_game"}));
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), t.rev(), 1)
        .expect("the match has ended");
    assert_eq!(ev.stopped, None);
    let r = apply(&mut t, AI, json!({"op": "claim_seat", "seat": "black"}));
    assert_eq!(r["started"], true);
    assert!(t.match_state().active);
}

#[test]
fn stop_or_opponent_nobody_after_a_finished_game_leaves_the_seat_open() {
    let mut t = Table::new("i");
    ai_claims_black(&mut t);
    ai_mates_as_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "match_stop"}));
    apply(&mut t, VIEW, json!({"op": "new_game"}));
    let r = apply(&mut t, AI, json!({"op": "claim_seat", "seat": "black"}));
    assert_eq!(r["started"], true);

    let mut t = Table::new("i");
    ai_claims_black(&mut t);
    ai_mates_as_black(&mut t);
    apply(
        &mut t,
        VIEW,
        json!({"op": "set_seats", "white": "human", "black": "human"}),
    );
    apply(&mut t, VIEW, json!({"op": "new_game"}));
    let r = apply(&mut t, AI, json!({"op": "claim_seat", "seat": "black"}));
    assert_eq!(r["started"], true);
}

#[test]
fn opponent_nobody_mid_game_sticks_after_the_match_ends() {
    let mut t = Table::new("i");
    ai_claims_black(&mut t);
    apply(
        &mut t,
        VIEW,
        json!({"op": "set_seats", "white": "human", "black": "human"}),
    );
    apply(&mut t, VIEW, json!({"op": "match_stop"}));
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), t.rev(), 1)
        .expect("the match has ended");
    assert!(ev.stopped.is_some());
    claim_error(&mut t, "black");
}

#[test]
fn swapping_sides_mid_match_tells_the_ai_its_new_seat() {
    let mut t = Table::new("i");
    ai_claims_black(&mut t);
    apply(
        &mut t,
        VIEW,
        json!({"op": "set_seats", "white": "ai", "black": "human"}),
    );
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), t.rev(), 1)
        .expect("the open wait is told");
    assert_eq!(ev.event, "seat_changed");
    assert_eq!(ev.seat, Some(Side::White));
    assert_eq!(ev.stopped, None);
    let body = serde_json::to_value(&ev).unwrap();
    assert_eq!(body["seat"], "white");
    assert_eq!(body["your_seat"], "white");

    let rev = t.rev();
    let r = apply(&mut t, AI, json!({"op": "claim_seat", "seat": "black"}));
    assert_eq!(r["claimed"], false);
    assert_eq!(t.rev(), rev);
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), t.rev(), 1)
        .expect("the next wait is told too");
    assert_eq!(ev.event, "seat_changed");

    apply(&mut t, AI, json!({"op": "claim_seat", "seat": "white"}));
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::White), t.rev(), 1)
        .expect("white to move");
    assert_eq!(ev.event, "your_turn");
}

#[test]
fn game_over_while_browsing_carries_the_result_at_the_tip() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    for (by, mv) in [(VIEW, "f3"), (AI, "e5"), (VIEW, "g4"), (AI, "Qh4#")] {
        apply(&mut t, by, json!({"op": "play", "move": mv}));
    }
    apply(&mut t, VIEW, json!({"op": "goto", "node": 1}));
    let ev = t
        .wait_event(AI, WaitFor::MyTurn(Side::Black), 0, 1)
        .expect("game over");
    let body = serde_json::to_value(&ev).unwrap();
    assert_eq!(body["event"], "game_over");
    assert_eq!(
        body["result"],
        json!({"outcome": "0-1", "reason": "checkmate"})
    );
    assert_eq!(body["live"], false);
    assert_eq!(body["tip"], 4);
}

// ---------------------------------------------------------------- any_change and the ring

#[test]
fn a_coachs_own_notes_never_push_the_persons_move_out_of_recent() {
    let mut t = Table::new("i");
    let since = t.board_rev();
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    for i in 0..20 {
        apply(
            &mut t,
            AI,
            json!({"op": "annotate", "note": format!("note {i}")}),
        );
    }
    let start = t.rev();
    let ev = t
        .wait_event(AI, WaitFor::AnyChange { since: Some(since) }, start, 1)
        .expect("the person's move is still news");
    assert_eq!(ev.event, "changed");
    let listed = ev.since_last.expect("listed");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].san.as_deref(), Some("e4"));
    assert_eq!(ev.since_last_truncated, None);
}

#[test]
fn more_changes_than_recent_holds_wake_and_say_so() {
    let mut t = Table::new("i");
    let moves = [
        "Nf3", "Nf6", "Ng1", "Ng8", "Nc3", "Nc6", "Nb1", "Nb8", "Nf3", "Nf6", "Ng1", "Ng8", "e3",
        "e6", "d3", "d6", "c3", "c6", "b3", "b6",
    ];
    for mv in moves {
        apply(&mut t, VIEW, json!({"op": "play", "move": mv}));
    }
    let start = t.rev();
    let report = t.change_report(AI, Some(0), start);
    assert!(report.wake);
    assert!(report.truncated);
    assert_eq!(report.changes.len(), 16);
    let body = serde_json::to_value(
        t.wait_event(AI, WaitFor::AnyChange { since: Some(0) }, start, 1)
            .expect("woken"),
    )
    .unwrap();
    assert_eq!(body["since_last_truncated"], true);
    // Changes after since that were all made by the caller do not wake it.
    let mut own = Table::new("i");
    let since = own.board_rev();
    apply(&mut own, AI, json!({"op": "play", "move": "e4"}));
    let report = own.change_report(AI, Some(since), own.rev());
    assert!(!report.wake);
}

// ---------------------------------------------------------------- annotations

fn arrows_of(t: &Table) -> Vec<(String, String, Option<String>)> {
    t.game()
        .current_node()
        .arrows
        .iter()
        .map(|a| (a.from.clone(), a.to.clone(), a.source.clone()))
        .collect()
}

#[test]
fn replace_with_only_bad_items_keeps_what_is_there() {
    let mut t = Table::new("i");
    apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "arrows": [{"from": "e2", "to": "e4"}],
               "highlights": [{"square": "d4"}]}),
    );
    let r = apply(
        &mut t,
        AI,
        json!({"op": "annotate", "mode": "replace", "arrows": [{"from": "z9", "to": "e4"}],
               "highlights": [{"square": "q1"}]}),
    );
    assert_eq!(r["rejected"].as_array().map(Vec::len), Some(2));
    assert_eq!(arrows_of(&t).len(), 1);
    assert_eq!(t.game().current_node().highlights.len(), 1);
    // An empty list still clears.
    apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "mode": "replace", "arrows": []}),
    );
    assert!(arrows_of(&t).is_empty());
}

#[test]
fn clear_matches_by_square_and_ignores_the_colour() {
    let mut t = Table::new("i");
    apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "arrows": [{"from": "e2", "to": "e4", "color": "red"}],
               "highlights": [{"square": "d4", "color": "blue"}]}),
    );
    let r = apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "mode": "clear",
               "arrows": [{"from": "e2", "to": "e4", "color": "purple"}],
               "highlights": [{"square": "d4", "color": "nope"}]}),
    );
    assert_eq!(r["applied"]["arrows"], 1);
    assert_eq!(r["applied"]["highlights"], 1);
    assert!(arrows_of(&t).is_empty());
    assert!(t.game().current_node().highlights.is_empty());
}

#[test]
fn replace_keeps_who_drew_an_unchanged_arrow() {
    let mut t = Table::new("i");
    apply(
        &mut t,
        AI,
        json!({"op": "annotate", "arrows": [{"from": "g8", "to": "f6"}]}),
    );
    apply(
        &mut t,
        VIEW,
        json!({"op": "annotate", "mode": "replace",
               "arrows": [{"from": "g8", "to": "f6", "color": "green"}, {"from": "g1", "to": "f3"}]}),
    );
    assert_eq!(
        arrows_of(&t),
        vec![
            ("g8".into(), "f6".into(), Some("ai".into())),
            ("g1".into(), "f3".into(), Some("user".into())),
        ]
    );
}

// ---------------------------------------------------------------- refusals and rules

#[test]
fn out_of_turn_with_a_stale_node_says_both() {
    let mut t = Table::new("i");
    match_vs_ai_black(&mut t);
    apply(&mut t, VIEW, json!({"op": "play", "move": "e4"}));
    apply(&mut t, AI, json!({"op": "play", "move": "e5"}));
    let err = t
        .apply(
            AI,
            &json!({"op": "play", "move": "Nf6", "from_node": 1}).to_string(),
            0,
        )
        .unwrap_err();
    assert_eq!(err.code(), "not_your_turn");
    let text = err.to_string();
    assert!(text.contains("The board has moved on"), "{text}");
    assert!(text.contains("not node 1"), "{text}");
}

#[test]
fn the_coach_rule_in_results_carries_the_annotate_rule() {
    let rule = Style::Coach.rule();
    assert!(rule.starts_with(RULE_ANNOTATE), "{rule}");
    assert!(rule.ends_with(rukh_core::session::RULE_COACH), "{rule}");
}
