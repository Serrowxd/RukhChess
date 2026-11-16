//! Several tabs behind one board: the hub, presence and the MCP binding.

use rukh_core::{Error, Seat, TabId};

use super::*;

const TAB_CLOSED_LINE: &str = "The person closed the board this game was on, so the game is over \
     for you. Stop and tell them; nothing more happens until they press Start on a board.";

const NO_MATCH_NO_SEAT: &str = "No match is running and you hold no seat, so there is no turn to \
     wait for. Call wait with seat=\"white\" or seat=\"black\" to take a side and start a match, \
     or with for=\"any_change\" to follow the board.";

const STOPPED_ON_BOARD: &str = "The person stopped the match on the board, so wait does not start \
     another one. Stop and tell them. If they want to play again, ask them to press Start on the \
     board with Opponent: AI, then call wait with seat=\"black\".";

const BOARD_1_HELD: &str = "An AI is already playing on \u{ab}Board 1\u{bb}.";

fn tab(id: &str) -> TabId {
    id.parse().expect("a tab id")
}

/// A tab intent as the person would send it; returns its result.
fn desk(hub: &Hub, body: Value) -> Value {
    hub.apply_desk("view:1", &body.to_string(), None)
        .expect("the tab intent is accepted")
        .result
}

/// A game intent by the person on one tab; returns its result.
fn on(hub: &Hub, id: &str, body: Value) -> Value {
    hub.apply_on(tab(id), "view:1", &body.to_string(), None)
        .expect("the intent is accepted")
        .result
}

/// The state of one tab as a view would get it.
fn state_of(hub: &Hub, id: &str) -> String {
    hub.read_on(tab(id), |t| serde_json::to_string(&t.state()))
        .expect("the tab is open")
        .expect("state is JSON")
}

fn presence_ais(hub: &Hub) -> Value {
    let presence: Value = serde_json::from_str(&hub.presence().message()).expect("presence");
    presence["ais"].clone()
}

fn mark_of(frame: &Value, id: &str) -> Value {
    frame["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|t| t["id"] == id))
        .map(|t| t["mark"].clone())
        .unwrap_or(Value::Null)
}

fn spawn_wait(ai: &Ai, args: Value) -> tokio::task::JoinHandle<Value> {
    let waiter = ai.clone();
    tokio::spawn(async move { waiter.call("wait", args).await })
}

async fn finish(pending: tokio::task::JoinHandle<Value>) -> Value {
    tokio::time::timeout(WAIT, pending)
        .await
        .expect("the wait returned")
        .expect("the task ran")
}

/// The AI takes Black on the shown tab, which starts a match; White is to move.
async fn seat_black(ai: &Ai) {
    let first = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(structured(&first)["event"], "timeout", "{first}");
}

// ------------------------------------------------------------------ hub

#[test]
fn a_change_on_a_hidden_tab_republishes_the_shown_frame() {
    let hub = Hub::new("test".into());
    assert_eq!(frame_value(&hub)["tab"], "t1");

    assert_eq!(desk(&hub, json!({"op": "tab_new"})), json!({"tab": "t2"}));
    let shown = frame_value(&hub);
    assert_eq!(shown["rev"], 1);
    assert_eq!(shown["tab"], "t2");

    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    let frame = frame_value(&hub);
    assert_eq!(frame["rev"], 2);
    assert_eq!(frame["tab"], "t2");
    assert_eq!(frame["state"], shown["state"]);
    assert_eq!(frame["tabs"].as_array().map(Vec::len), Some(2));
    assert_eq!(hub.read_on(tab("t1"), |t| t.board_rev()), Some(1));

    // The entry points without a tab act on the selected one.
    hub.apply("view:1", r#"{"op":"play","move":"d4"}"#, None)
        .expect("d4 on the shown tab");
    assert_eq!(hub.read(|t| t.board_rev()), 1);
    assert_eq!(frame_value(&hub)["state"]["game"]["nodes"][1]["san"], "d4");
    assert_eq!(hub.read_on(tab("t1"), |t| t.game().current()), Some(1));
}

#[test]
fn the_selected_tab_entry_point_refuses_tab_intents() {
    let hub = Hub::new("test".into());
    let refused = hub
        .apply("view:1", r#"{"op":"tab_new"}"#, None)
        .expect_err("not a game intent");
    assert_eq!(refused.code(), "bad_input");
    assert_eq!(hub.latest().rev, 0);
    assert_eq!(hub.read_desk(|d| d.tabs().len()), 1);
}

#[tokio::test]
async fn the_socket_takes_tab_intents_and_applies_game_intents_to_the_tab_they_name() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;

    let ack = intent(&mut page, 1, json!({"op": "tab_new"})).await;
    assert_eq!(ack["result"], json!({"tab": "t2"}), "{ack}");
    assert_eq!(hub.latest().rev, 1);

    let ack = intent(
        &mut page,
        2,
        json!({"op": "play", "move": "e4", "from_node": 0}),
    )
    .await;
    assert_eq!(ack["ok"], true, "{ack}");
    assert_eq!(hub.selected(), tab("t2"));
    assert_eq!(hub.read_on(tab("t1"), |t| t.board_rev()), Some(1));
    assert_eq!(hub.read_on(tab("t2"), |t| t.board_rev()), Some(0));

    server.stop().await;
}

// ------------------------------------------------------------------ presence and the AI match's tab

#[tokio::test]
async fn a_move_on_another_tab_keeps_the_ai_seat_and_presence_names_its_tab() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "holder").await;
    seat_black(&ai).await;
    assert_eq!(presence_ais(&hub)[0]["tab"], "t1");
    assert_eq!(presence_ais(&hub)[0]["seat"], "black");

    desk(&hub, json!({"op": "tab_new"}));
    on(&hub, "t2", json!({"op": "play", "move": "d4"}));
    on(&hub, "t2", json!({"op": "new_game"}));
    let ais = presence_ais(&hub);
    assert_eq!(ais[0]["seat"], "black", "{ais}");
    assert_eq!(ais[0]["tab"], "t1", "{ais}");

    // Stopping the match on its own tab clears it.
    on(&hub, "t1", json!({"op": "match_stop"}));
    let ais = presence_ais(&hub);
    assert_eq!(ais[0]["seat"], Value::Null, "{ais}");
    assert_eq!(ais[0]["tab"], Value::Null, "{ais}");

    server.stop().await;
}

// ------------------------------------------------------------------ the bound tab

#[tokio::test]
async fn a_seated_wait_ignores_selects_and_moves_elsewhere_and_wakes_for_its_own_tab() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (_page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "steady").await;
    seat_black(&ai).await;
    desk(&hub, json!({"op": "tab_new"}));

    let pending = spawn_wait(&ai, json!({"seat": "black", "timeout_s": 20}));
    until("the wait to start", || hub.presence().is_waiting(&ai.by)).await;

    on(&hub, "t2", json!({"op": "play", "move": "d4"}));
    for i in 0..10 {
        let to = if i % 2 == 0 { "t1" } else { "t2" };
        desk(&hub, json!({"op": "tab_select", "tab": to}));
    }
    assert_eq!(hub.selected(), tab("t2"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!pending.is_finished(), "the wait returned for another tab");

    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    let result = finish(pending).await;
    let event = structured(&result);
    assert_eq!(event["event"], "your_turn", "{result}");
    assert_eq!(event["tab"], "t1", "{result}");
    assert_eq!(event["node"], 1);
    assert_eq!(event["last_move"]["san"], "e4", "{result}");
    assert!(
        prose(&result).ends_with(" The person is looking at another board."),
        "{result}"
    );

    server.stop().await;
}

#[tokio::test]
async fn an_ai_plays_its_tab_while_another_is_shown_and_neither_game_sees_the_other() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "elsewhere").await;
    seat_black(&ai).await;
    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    desk(&hub, json!({"op": "tab_new"}));
    on(&hub, "t2", json!({"op": "play", "move": "d4"}));

    let turn = ai.call("wait", json!({"timeout_s": 5})).await;
    assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
    assert_eq!(structured(&turn)["tab"], "t1");
    assert_eq!(structured(&turn)["last_move"]["san"], "e4");
    assert_eq!(
        structured(&turn)["legal_moves"].as_array().map(Vec::len),
        Some(20)
    );

    let before = state_of(&hub, "t2");
    let rev = hub.latest().rev;
    let played = ai.call("play", json!({"move": "e5"})).await;
    assert_ne!(played["isError"], true, "{played}");
    assert_eq!(structured(&played)["san"], "e5");

    assert_eq!(state_of(&hub, "t2"), before);
    assert_eq!(hub.read_on(tab("t1"), |t| t.game().current()), Some(2));

    let frame = frame_value(&hub);
    assert_eq!(frame["rev"], rev + 1);
    assert_eq!(frame["tab"], "t2");
    assert_eq!(frame["state"]["game"]["nodes"][1]["san"], "d4");
    assert_eq!(mark_of(&frame, "t1"), "your_move", "{frame}");
    assert_eq!(mark_of(&frame, "t2"), Value::Null, "{frame}");
    assert_eq!(presence_ais(&hub)[0]["tab"], "t1");

    server.stop().await;
}

#[tokio::test]
async fn closing_the_ais_tab_ends_its_wait_and_starts_nothing_on_the_shown_board() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "orphan").await;
    seat_black(&ai).await;
    desk(&hub, json!({"op": "tab_new"}));

    let pending = spawn_wait(&ai, json!({"seat": "black", "timeout_s": 20}));
    until("the wait to start", || hub.presence().is_waiting(&ai.by)).await;
    desk(&hub, json!({"op": "tab_close", "tab": "t1"}));

    let closed = json!({"event": "game_over", "stopped": "tab_closed",
                        "message": TAB_CLOSED_LINE});
    let result = finish(pending).await;
    assert_ne!(result["isError"], true, "{result}");
    assert_eq!(*structured(&result), closed, "{result}");
    assert_eq!(prose(&result), TAB_CLOSED_LINE);
    assert_eq!(presence_ais(&hub)[0]["seat"], Value::Null);

    // The next seated wait says the same and starts no match on the free tab shown.
    let rev = hub.latest().rev;
    let again = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(*structured(&again), closed, "{again}");
    let seatless = ai.call("wait", json!({"timeout_s": 1})).await;
    assert_eq!(seatless["isError"], true, "{seatless}");
    assert_eq!(prose(&seatless), NO_MATCH_NO_SEAT);
    assert_eq!(hub.latest().rev, rev);
    assert!(!hub.read(|t| t.match_state().active));

    let played = ai.call("play", json!({"move": "e4"})).await;
    assert_eq!(played["isError"], true, "{played}");
    assert_eq!(prose(&played), "That game was closed.");
    assert_eq!(hub.latest().rev, rev);

    // Once the person gives an AI a seat, the session plays again.
    on(
        &hub,
        "t2",
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );
    let seated = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(structured(&seated)["event"], "timeout", "{seated}");
    assert_eq!(presence_ais(&hub)[0]["tab"], "t2");

    server.stop().await;
}

#[tokio::test]
async fn a_bound_read_after_its_tab_closed_is_told_once_then_reads_the_shown_board() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "late").await;
    seat_black(&ai).await;
    desk(&hub, json!({"op": "tab_new"}));
    desk(&hub, json!({"op": "tab_close", "tab": "t1"}));

    let told = ai.call("get_game", json!({})).await;
    assert_eq!(told["isError"], true, "{told}");
    assert_eq!(prose(&told), "That game was closed.");

    let read = ai.call("get_game", json!({})).await;
    assert_ne!(read["isError"], true, "{read}");
    assert_eq!(structured(&read)["tab"], "t2", "{read}");

    let rev = hub.latest().rev;
    let again = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(prose(&again), TAB_CLOSED_LINE, "{again}");
    assert_eq!(hub.latest().rev, rev);
    assert!(!hub.read(|t| t.match_state().active));

    server.stop().await;
}

#[tokio::test]
async fn after_mate_the_session_answers_game_over_then_takes_a_seat_on_a_free_tab() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "mater").await;
    seat_black(&ai).await;
    for (person, reply) in [("f3", "e5"), ("g4", "Qh4#")] {
        hub.apply(
            "view:1",
            &json!({"op": "play", "move": person}).to_string(),
            None,
        )
        .expect("the person's move");
        let turn = ai.call("wait", json!({"timeout_s": 5})).await;
        assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
        let played = ai.call("play", json!({"move": reply})).await;
        assert_ne!(played["isError"], true, "{played}");
    }

    for _ in 0..2 {
        let over = ai
            .call("wait", json!({"seat": "black", "timeout_s": 1}))
            .await;
        assert_eq!(structured(&over)["event"], "game_over", "{over}");
        assert_eq!(structured(&over)["result"]["outcome"], "0-1", "{over}");
        assert_eq!(structured(&over)["tab"], "t1");
    }

    desk(&hub, json!({"op": "tab_new"}));
    let started = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert!(
        prose(&started).starts_with("You play Black; a match has started"),
        "{started}"
    );
    assert!(hub.read(|t| t.match_state().active));
    assert_eq!(hub.read(|t| t.match_state().seats.black), Seat::Ai);
    assert_eq!(presence_ais(&hub)[0]["tab"], "t2");

    server.stop().await;
}

#[tokio::test]
async fn a_finished_game_does_not_block_another_ais_seat_on_another_tab() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (winner, _) = Ai::connect(server.port, "winner").await;
    seat_black(&winner).await;
    for (person, reply) in [("f3", "e5"), ("g4", "Qh4#")] {
        on(&hub, "t1", json!({"op": "play", "move": person}));
        let turn = winner.call("wait", json!({"timeout_s": 5})).await;
        assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
        let played = winner.call("play", json!({"move": reply})).await;
        assert_ne!(played["isError"], true, "{played}");
    }
    assert_eq!(
        hub.read_on(tab("t1"), |t| t.tip_result().is_some()),
        Some(true)
    );

    desk(&hub, json!({"op": "tab_new"}));
    let (next, _) = Ai::connect(server.port, "next").await;
    let turn = next
        .call("wait", json!({"seat": "white", "timeout_s": 5}))
        .await;
    assert_ne!(turn["isError"], true, "{turn}");
    assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
    assert_eq!(structured(&turn)["tab"], "t2");

    server.stop().await;
}

#[tokio::test]
async fn one_ai_match_at_a_time_across_tabs() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (first, _) = Ai::connect(server.port, "first").await;
    let (second, _) = Ai::connect(server.port, "second").await;
    seat_black(&first).await;
    desk(&hub, json!({"op": "tab_new"}));

    let rev = hub.latest().rev;
    let refused = second
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(prose(&refused), BOARD_1_HELD);
    assert_eq!(hub.latest().rev, rev);
    assert!(!hub.read(|t| t.match_state().active));

    // A session asking for a second game while its own runs is told so.
    let greedy = first
        .call("wait", json!({"seat": "white", "timeout_s": 1}))
        .await;
    assert_eq!(greedy["isError"], true, "{greedy}");
    assert_eq!(
        prose(&greedy),
        "You are playing on \u{ab}Board 1\u{bb}; finish it or ask the person to stop it."
    );
    assert_eq!(hub.latest().rev, rev);

    server.stop().await;
}

#[tokio::test]
async fn a_bound_session_keeps_its_tab_while_an_unbound_one_follows_the_seat_order() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (bound, _) = Ai::connect(server.port, "bound").await;
    let (loose, _) = Ai::connect(server.port, "loose").await;
    seat_black(&bound).await;
    desk(&hub, json!({"op": "tab_new"}));

    let refused = loose
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(prose(&refused), BOARD_1_HELD);

    // The person stops the first match; the unbound session now starts one on the shown tab.
    on(&hub, "t1", json!({"op": "match_stop"}));
    let started = loose
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert!(
        prose(&started).starts_with("You play Black; a match has started"),
        "{started}"
    );
    assert_eq!(
        hub.read_on(tab("t2"), |t| t.match_state().active),
        Some(true)
    );

    // The bound session still answers from its own tab, which reports the stop.
    let over = bound
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(structured(&over)["event"], "game_over", "{over}");
    assert_eq!(structured(&over)["stopped"], "match_stop", "{over}");
    assert_eq!(structured(&over)["tab"], "t1");
    let ais = presence_ais(&hub);
    let loose_entry = ais
        .as_array()
        .and_then(|a| a.iter().find(|e| e["name"] == "loose"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(loose_entry["tab"], "t2", "{ais}");

    server.stop().await;
}

#[tokio::test]
async fn a_stopped_match_unbinds_the_session() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "released").await;
    seat_black(&ai).await;
    on(&hub, "t1", json!({"op": "match_stop"}));
    let refused = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(prose(&refused), STOPPED_ON_BOARD);

    desk(&hub, json!({"op": "tab_new"}));
    let started = ai
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert!(
        prose(&started).starts_with("You play Black; a match has started"),
        "{started}"
    );
    assert_eq!(
        hub.read_on(tab("t2"), |t| t.match_state().active),
        Some(true)
    );
    assert_eq!(
        hub.read_on(tab("t1"), |t| t.match_state().active),
        Some(false)
    );

    server.stop().await;
}

#[tokio::test]
async fn a_new_session_finds_an_unheld_ai_seat_on_a_hidden_tab() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (gone, _) = Ai::connect(server.port, "restarted").await;
    seat_black(&gone).await;
    hub.presence()
        .tick_at(Instant::now() + Duration::from_secs(100));
    assert_eq!(presence_ais(&hub), json!([]));
    desk(&hub, json!({"op": "tab_new"}));

    let (fresh, _) = Ai::connect(server.port, "returned").await;
    let found = fresh
        .call("wait", json!({"seat": "black", "timeout_s": 1}))
        .await;
    assert_eq!(structured(&found)["event"], "timeout", "{found}");
    assert!(!prose(&found).contains("a match has started"), "{found}");
    assert!(!hub.read(|t| t.match_state().active));
    assert_eq!(presence_ais(&hub)[0]["tab"], "t1");

    let pending = spawn_wait(&fresh, json!({"timeout_s": 10}));
    until("the wait to start", || hub.presence().is_waiting(&fresh.by)).await;
    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    let turn = finish(pending).await;
    assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
    assert_eq!(structured(&turn)["tab"], "t1");

    server.stop().await;
}

#[tokio::test]
async fn a_seatless_wait_finds_the_one_unheld_ai_seat_or_starts_nothing() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "implied").await;
    desk(&hub, json!({"op": "tab_new"}));

    let refused = ai.call("wait", json!({"timeout_s": 1})).await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(prose(&refused), NO_MATCH_NO_SEAT);
    assert_eq!(hub.latest().rev, 1);

    on(
        &hub,
        "t1",
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );
    let found = ai.call("wait", json!({"timeout_s": 1})).await;
    assert_eq!(structured(&found)["event"], "timeout", "{found}");
    assert_eq!(presence_ais(&hub)[0]["tab"], "t1");
    assert!(!hub.read(|t| t.match_state().active));

    // A bound seatless wait stays on its tab whatever is shown.
    desk(&hub, json!({"op": "tab_select", "tab": "t1"}));
    desk(&hub, json!({"op": "tab_select", "tab": "t2"}));
    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    let turn = ai.call("wait", json!({"timeout_s": 5})).await;
    assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
    assert_eq!(structured(&turn)["tab"], "t1");

    let (other, _) = Ai::connect(server.port, "latecomer").await;
    let rev = hub.latest().rev;
    let none = other.call("wait", json!({"timeout_s": 1})).await;
    assert_eq!(none["isError"], true, "{none}");
    assert_eq!(prose(&none), NO_MATCH_NO_SEAT);
    assert_eq!(hub.latest().rev, rev);

    server.stop().await;
}

#[tokio::test]
async fn a_seatless_wait_lets_a_dead_binding_go_and_finds_the_new_seat() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "moved-on").await;
    seat_black(&ai).await;
    on(&hub, "t1", json!({"op": "match_stop"}));
    desk(&hub, json!({"op": "tab_new"}));
    on(
        &hub,
        "t2",
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    );

    let found = ai.call("wait", json!({"timeout_s": 1})).await;
    assert_eq!(structured(&found)["event"], "timeout", "{found}");
    assert_eq!(presence_ais(&hub)[0]["tab"], "t2");

    on(&hub, "t2", json!({"op": "play", "move": "e4"}));
    let turn = ai.call("wait", json!({"timeout_s": 5})).await;
    assert_eq!(structured(&turn)["event"], "your_turn", "{turn}");
    assert_eq!(structured(&turn)["tab"], "t2");

    server.stop().await;
}

#[tokio::test]
async fn a_refused_colour_on_the_bound_tab_keeps_the_binding() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "keeper").await;
    seat_black(&ai).await;

    let refused = ai
        .call("wait", json!({"seat": "white", "timeout_s": 1}))
        .await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(prose(&refused).contains("seat=\"black\""), "{refused}");

    desk(&hub, json!({"op": "tab_new"}));
    let read = ai.call("get_game", json!({})).await;
    assert_eq!(structured(&read)["tab"], "t1", "{read}");
    assert_eq!(structured(&read)["your_seat"], "black", "{read}");

    server.stop().await;
}

#[tokio::test]
async fn the_other_colour_is_free_once_the_hidden_bound_match_is_stopped() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "switcher").await;
    seat_black(&ai).await;
    desk(&hub, json!({"op": "tab_new"}));
    on(&hub, "t1", json!({"op": "match_stop"}));

    let started = ai
        .call("wait", json!({"seat": "white", "timeout_s": 1}))
        .await;
    assert_ne!(started["isError"], true, "{started}");
    assert!(
        prose(&started).starts_with("You play White; a match has started"),
        "{started}"
    );
    assert_eq!(structured(&started)["tab"], "t2", "{started}");
    assert_eq!(hub.read(|t| t.match_state().seats.white), Seat::Ai);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_sessions_claiming_seats_on_two_tabs_at_once_get_one_match() {
    for round in 0..100 {
        let server = serve("web").await;
        let hub = server.hub.clone();
        on(
            &hub,
            "t1",
            json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
        );
        on(&hub, "t1", json!({"op": "play", "move": "e4"}));
        desk(&hub, json!({"op": "tab_new"}));
        on(
            &hub,
            "t2",
            json!({"op": "match_start", "seats": {"white": "ai", "black": "human"}}),
        );
        desk(&hub, json!({"op": "tab_select", "tab": "t1"}));

        // Both seats are to move, so neither wait sits out its timeout.
        let (x, _) = Ai::connect(server.port, "x").await;
        let (y, _) = Ai::connect(server.port, "y").await;
        let (black, white) = tokio::join!(
            spawn_wait(&x, json!({"seat": "black", "timeout_s": 1})),
            spawn_wait(&y, json!({"seat": "white", "timeout_s": 1})),
        );
        let results = [black.expect("x waited"), white.expect("y waited")];

        let refused: Vec<&Value> = results.iter().filter(|r| r["isError"] == true).collect();
        assert_eq!(refused.len(), 1, "round {round}: {results:?}");
        assert!(
            prose(refused[0]).starts_with("An AI is already playing on"),
            "round {round}: {results:?}"
        );

        let ais = presence_ais(&hub);
        let seated = ais
            .as_array()
            .map(|a| a.iter().filter(|e| e["seat"] != Value::Null).count());
        assert_eq!(seated, Some(1), "round {round}: {ais}");

        server.stop().await;
    }
}

// ------------------------------------------------------------------ calls without a seat

#[tokio::test]
async fn a_seatless_read_follows_the_selection_and_writes_land_where_it_read() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (_page, _) = view(server.port).await;
    let (ai, _) = Ai::connect(server.port, "reader").await;
    on(&hub, "t1", json!({"op": "play", "move": "e4"}));

    let first = ai.call("get_game", json!({})).await;
    assert_eq!(structured(&first)["tab"], "t1");
    assert_eq!(structured(&first)["node"], 1);

    desk(&hub, json!({"op": "tab_new"}));
    let second = ai.call("get_game", json!({})).await;
    assert_eq!(structured(&second)["tab"], "t2");
    assert_eq!(structured(&second)["fen"], INITIAL_FEN);

    desk(&hub, json!({"op": "tab_select", "tab": "t1"}));
    let noted = ai
        .call("annotate", json!({"note": "Where I was looking."}))
        .await;
    assert_ne!(noted["isError"], true, "{noted}");
    assert!(
        prose(&noted).ends_with(" The person is looking at another board."),
        "{noted}"
    );
    let note_on = |id: &str| {
        hub.read_on(tab(id), |t| {
            t.game().node(t.game().current()).map(|n| n.note.clone())
        })
        .flatten()
        .unwrap_or_default()
    };
    assert_eq!(note_on("t2"), "Where I was looking.");
    assert_eq!(note_on("t1"), "");

    // After a read of the shown tab, it is the one shown again.
    let back = ai.call("get_game", json!({})).await;
    assert_eq!(structured(&back)["tab"], "t1");
    assert!(!prose(&back).contains("another board"), "{back}");

    server.stop().await;
}

#[tokio::test]
async fn a_play_with_no_earlier_read_acts_on_the_selected_tab_and_stays_there() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "eager").await;
    desk(&hub, json!({"op": "tab_new"}));

    let played = ai.call("play", json!({"move": "e4"})).await;
    assert_ne!(played["isError"], true, "{played}");
    assert_eq!(hub.read_on(tab("t2"), |t| t.board_rev()), Some(1));
    assert_eq!(hub.read_on(tab("t1"), |t| t.board_rev()), Some(0));

    desk(&hub, json!({"op": "tab_select", "tab": "t1"}));
    let played = ai.call("play", json!({"move": "e5"})).await;
    assert_ne!(played["isError"], true, "{played}");
    assert_eq!(hub.read_on(tab("t2"), |t| t.board_rev()), Some(2));
    assert_eq!(hub.read_on(tab("t1"), |t| t.board_rev()), Some(0));

    // The tab it read is closed: its writes are refused.
    desk(&hub, json!({"op": "tab_close", "tab": "t2"}));
    let rev = hub.latest().rev;
    let refused = ai.call("annotate", json!({"note": "lost"})).await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(prose(&refused), "That game was closed.");
    assert_eq!(hub.latest().rev, rev);

    server.stop().await;
}

#[tokio::test]
async fn a_watcher_is_told_of_a_switch_and_a_since_from_the_old_tab_is_ignored() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (watcher, _) = Ai::connect(server.port, "watcher").await;
    on(&hub, "t1", json!({"op": "play", "move": "e4"}));
    desk(&hub, json!({"op": "tab_new"}));
    on(&hub, "t2", json!({"op": "play", "move": "d4"}));
    on(&hub, "t2", json!({"op": "play", "move": "d5"}));
    desk(&hub, json!({"op": "tab_select", "tab": "t1"}));

    let read = watcher.call("get_game", json!({})).await;
    assert_eq!(structured(&read)["tab"], "t1");

    let pending = spawn_wait(
        &watcher,
        json!({"for": "any_change", "since": 1, "timeout_s": 20}),
    );
    until("the wait to start", || {
        hub.presence().is_waiting(&watcher.by)
    })
    .await;
    desk(&hub, json!({"op": "tab_select", "tab": "t2"}));
    let switched = finish(pending).await;
    let event = structured(&switched);
    assert_eq!(event["event"], "changed", "{switched}");
    assert_eq!(event["tab"], "t2");
    assert_eq!(event["node"], 2);
    assert_eq!(event["since_last"], json!([]));
    assert!(
        prose(&switched).starts_with("The person switched to another board."),
        "{switched}"
    );

    // Back on t1, then the person shows t2 before the next wait: the old since does not list t2's moves.
    desk(&hub, json!({"op": "tab_select", "tab": "t1"}));
    let read = watcher.call("get_game", json!({})).await;
    assert_eq!(structured(&read)["board_rev"], 1);
    desk(&hub, json!({"op": "tab_select", "tab": "t2"}));
    let again = watcher
        .call(
            "wait",
            json!({"for": "any_change", "since": 0, "timeout_s": 5}),
        )
        .await;
    assert_eq!(structured(&again)["tab"], "t2", "{again}");
    assert_eq!(structured(&again)["since_last"], json!([]), "{again}");

    // On the same tab a since lists the moves after it.
    on(&hub, "t2", json!({"op": "play", "move": "c4"}));
    let changed = watcher
        .call(
            "wait",
            json!({"for": "any_change", "since": 2, "timeout_s": 5}),
        )
        .await;
    assert_eq!(
        structured(&changed)["since_last"][0]["san"],
        "c4",
        "{changed}"
    );

    server.stop().await;
}

#[tokio::test]
async fn a_play_for_an_unheld_ai_seat_is_refused_while_an_ai_plays_on_another_tab() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (x, _) = Ai::connect(server.port, "x").await;
    seat_black(&x).await;
    desk(&hub, json!({"op": "tab_new"}));
    on(
        &hub,
        "t2",
        json!({"op": "match_start", "seats": {"white": "ai", "black": "human"}}),
    );

    let (y, _) = Ai::connect(server.port, "y").await;
    let before = state_of(&hub, "t2");
    let rev = hub.latest().rev;
    let played = y.call("play", json!({"move": "d4"})).await;
    assert_eq!(played["isError"], true, "{played}");
    assert_eq!(prose(&played), BOARD_1_HELD);
    assert_eq!(state_of(&hub, "t2"), before);
    assert_eq!(hub.latest().rev, rev);
    assert_eq!(presence_ais(&hub)[0]["tab"], "t1");

    server.stop().await;
}

#[test]
fn a_tab_that_went_away_reads_as_a_closed_game() {
    let gone = Error::UnknownTab("There is no open board \"t9\"; it may have been closed.".into());
    assert_eq!(crate::mcp::core_refusal(&gone), "That game was closed.");

    let illegal = Error::IllegalMove("e5 is not legal here".into());
    assert_eq!(crate::mcp::core_refusal(&illegal), illegal.to_string());
}

// ------------------------------------------------------------------ the socket

const NO_TAB: &str = "The intent must name its board, as in \"tab\":\"t1\". Nothing was changed.";

const AI_TAB_INTENT: &str =
    "Boards are opened, chosen and closed by the person; an AI cannot do it.";

fn board(id: &str, name: &str) -> Value {
    json!({"id": id, "name": name, "kind": "free", "mark": null})
}

/// Sends an intent exactly as given, with only `t` and `id` added.
async fn ask(socket: &mut Socket, id: u64, mut body: Value) {
    body["t"] = json!("intent");
    body["id"] = json!(id);
    send(socket, body).await;
}

/// The frame and then the ack an applied intent brings.
async fn frame_then_ack(socket: &mut Socket, id: u64, body: Value) -> (Value, Value) {
    ask(socket, id, body).await;

    let frame = next_json(socket).await;
    assert_eq!(frame["t"], "state", "{frame}");

    let ack = next_json(socket).await;
    assert_eq!(ack["id"], id, "{ack}");
    (frame, ack)
}

/// The ack of an intent that brings no frame.
async fn only_ack(socket: &mut Socket, id: u64, body: Value) -> Value {
    ask(socket, id, body).await;

    let ack = next_json(socket).await;
    assert_eq!(ack["t"], "ack", "{ack}");
    assert_eq!(ack["id"], id, "{ack}");
    ack
}

fn refusal(id: u64, code: &str, message: &str) -> Value {
    json!({"t": "ack", "id": id, "ok": false, "error": {"code": code, "message": message}})
}

/// Reads frames until the one with `rev`.
async fn frame_at(socket: &mut Socket, rev: u64) -> Value {
    loop {
        let message = next_json(socket).await;
        if message["t"] == "state" && message["rev"] == rev {
            return message;
        }
    }
}

#[tokio::test]
async fn every_tab_intent_answers_with_its_result_after_its_frame() {
    let server = serve("web").await;
    let (mut page, _) = view(server.port).await;

    let (frame, ack) = frame_then_ack(
        &mut page,
        1,
        json!({"op": "tab_new", "name": null, "copy_of": null}),
    )
    .await;
    assert_eq!(
        ack,
        json!({"t": "ack", "id": 1, "ok": true, "rev": 1, "result": {"tab": "t2"}})
    );
    assert_eq!(frame["rev"], 1);
    assert_eq!(frame["tab"], "t2");
    assert_eq!(
        frame["hint"],
        json!({"reason": "tab_new", "by": "view:1", "intent_id": 1})
    );
    assert_eq!(
        frame["tabs"],
        json!([board("t1", "Board 1"), board("t2", "Board 2")])
    );
    assert_eq!(frame["state"]["game"]["fen"], INITIAL_FEN);

    let (frame, ack) = frame_then_ack(&mut page, 2, json!({"op": "tab_select", "tab": "t1"})).await;
    assert_eq!(
        ack,
        json!({"t": "ack", "id": 2, "ok": true, "rev": 2, "result": {"selected": "t1"}})
    );
    assert_eq!(frame["tab"], "t1");
    assert_eq!(frame["hint"]["reason"], "tab_select");

    let (frame, ack) = frame_then_ack(
        &mut page,
        3,
        json!({"op": "tab_rename", "tab": "t2", "name": "Italian, the Bc5 line"}),
    )
    .await;
    assert_eq!(
        ack,
        json!({"t": "ack", "id": 3, "ok": true, "rev": 3,
               "result": {"tab": "t2", "name": "Italian, the Bc5 line"}})
    );
    assert_eq!(frame["tab"], "t1");
    assert_eq!(
        frame["tabs"],
        json!([board("t1", "Board 1"), board("t2", "Italian, the Bc5 line")])
    );

    let (frame, ack) = frame_then_ack(
        &mut page,
        4,
        json!({"op": "tab_move", "tab": "t2", "to": 0}),
    )
    .await;
    assert_eq!(
        ack,
        json!({"t": "ack", "id": 4, "ok": true, "rev": 4,
               "result": {"tab": "t2", "order": ["t2", "t1"]}})
    );
    assert_eq!(frame["tabs"][0]["id"], "t2");

    let (frame, ack) = frame_then_ack(&mut page, 5, json!({"op": "tab_close", "tab": "t1"})).await;
    assert_eq!(
        ack,
        json!({"t": "ack", "id": 5, "ok": true, "rev": 5,
               "result": {"closed": "t1", "selected": "t2"}})
    );
    assert_eq!(frame["tab"], "t2");
    assert_eq!(frame["tabs"], json!([board("t2", "Italian, the Bc5 line")]));

    let ack = only_ack(&mut page, 6, json!({"op": "tab_reopen"})).await;
    assert_eq!(
        ack,
        refusal(6, "nothing_closed", "There is no closed board to reopen.")
    );

    // Selecting the tab already shown changes nothing and brings no frame.
    let ack = only_ack(&mut page, 7, json!({"op": "tab_select", "tab": "t2"})).await;
    assert_eq!(
        ack,
        json!({"t": "ack", "id": 7, "ok": true, "rev": 5, "result": {"selected": "t2"}})
    );
    assert_eq!(server.hub.latest().rev, 5);

    server.stop().await;
}

#[tokio::test]
async fn a_game_intent_without_its_tab_is_refused_and_changes_nothing() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let before = hub.latest().json.clone();

    let bodies = [
        json!({"op": "play", "move": "e4", "from_node": 0}),
        json!({"op": "play", "move": "e4", "from_node": 0, "tab": null}),
        json!({"op": "new_game"}),
        json!({"op": "back"}),
        json!({"op": "match_start", "seats": {"white": "human", "black": "ai"}}),
    ];
    for (i, body) in bodies.into_iter().enumerate() {
        let id = i as u64 + 1;
        let ack = only_ack(&mut page, id, body).await;
        assert_eq!(ack, refusal(id, "bad_input", NO_TAB));
    }

    let ack = only_ack(&mut page, 9, json!({"op": "play", "move": "e4", "tab": 1})).await;
    assert_eq!(
        ack,
        refusal(9, "bad_input", "tab must be a board id such as \"t1\"")
    );

    assert_eq!(hub.latest().json, before);
    assert_eq!(hub.read(|t| t.board_rev()), 0);

    server.stop().await;
}

#[tokio::test]
async fn an_unknown_or_closed_tab_is_refused() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;

    let ack = only_ack(
        &mut page,
        1,
        json!({"op": "play", "move": "e4", "tab": "t9"}),
    )
    .await;
    assert_eq!(
        ack,
        refusal(
            1,
            "unknown_tab",
            "There is no open board \"t9\"; it may have been closed."
        )
    );

    frame_then_ack(&mut page, 2, json!({"op": "tab_new"})).await;
    frame_then_ack(&mut page, 3, json!({"op": "tab_close", "tab": "t2"})).await;
    let before = hub.latest().json.clone();

    let ack = only_ack(
        &mut page,
        4,
        json!({"op": "play", "move": "e4", "tab": "t2"}),
    )
    .await;
    assert_eq!(
        ack,
        refusal(
            4,
            "unknown_tab",
            "There is no open board \"t2\"; it may have been closed."
        )
    );

    for (id, body) in [
        (5, json!({"op": "tab_select", "tab": "t2"})),
        (6, json!({"op": "tab_rename", "tab": "t2", "name": "Back"})),
        (7, json!({"op": "tab_close", "tab": "t2"})),
        (8, json!({"op": "goto", "node": 0, "tab": "T1"})),
    ] {
        let ack = only_ack(&mut page, id, body).await;
        assert_eq!(ack["error"]["code"], "unknown_tab", "{ack}");
    }

    assert_eq!(hub.latest().json, before);
    assert_eq!(hub.read_desk(|d| d.tabs().len()), 1);

    server.stop().await;
}

#[tokio::test]
async fn a_move_made_for_one_tab_lands_there_after_another_window_selects_another() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut a, _) = view(server.port).await;
    let (mut b, _) = view(server.port).await;

    frame_then_ack(&mut a, 1, json!({"op": "tab_new"})).await;
    frame_then_ack(&mut a, 2, json!({"op": "tab_select", "tab": "t1"})).await;
    frame_at(&mut b, 2).await;

    // B switches; A's move was made on t1 before A saw the switch.
    frame_then_ack(&mut b, 1, json!({"op": "tab_select", "tab": "t2"})).await;
    ask(
        &mut a,
        3,
        json!({"op": "play", "move": "e4", "from_node": 0, "tab": "t1"}),
    )
    .await;
    let ack = ack_for(&mut a, 3).await;
    assert_eq!(ack["ok"], true, "{ack}");
    assert_eq!(ack["rev"], 4);
    assert_eq!(ack["result"]["node"], 1);

    assert_eq!(hub.selected(), tab("t2"));
    assert_eq!(hub.read_on(tab("t1"), |t| t.board_rev()), Some(1));
    assert_eq!(hub.read_on(tab("t2"), |t| t.board_rev()), Some(0));

    let frame = frame_at(&mut b, 4).await;
    assert_eq!(frame["tab"], "t2");
    assert_eq!(frame["state"]["game"]["fen"], INITIAL_FEN);
    assert_eq!(frame["hint"]["reason"], "move");

    server.stop().await;
}

#[tokio::test]
async fn acks_never_precede_their_frame_when_tab_and_game_intents_are_mixed() {
    let server = serve("web").await;
    let (mut page, _) = view(server.port).await;

    let burst = [
        json!({"op": "tab_new"}),
        json!({"op": "play", "move": "e4", "from_node": 0, "tab": "t1"}),
        json!({"op": "play", "move": "d4", "from_node": 0, "tab": "t2"}),
        json!({"op": "tab_select", "tab": "t1"}),
        json!({"op": "play", "move": "e5", "from_node": 1, "tab": "t1"}),
        json!({"op": "tab_rename", "tab": "t2", "name": "Queen's pawn"}),
        json!({"op": "tab_new", "copy_of": "t1"}),
        json!({"op": "tab_close", "tab": "t2"}),
    ];
    let count = burst.len();
    for (i, body) in burst.into_iter().enumerate() {
        ask(&mut page, i as u64 + 1, body).await;
    }

    let mut seen_rev = 0;
    let mut acks = 0;
    while acks < count {
        let message = next_json(&mut page).await;
        match message["t"].as_str() {
            Some("state") => seen_rev = seen_rev.max(message["rev"].as_u64().expect("rev")),
            Some("ack") => {
                assert_eq!(message["ok"], true, "{message}");
                let rev = message["rev"].as_u64().expect("ack rev");
                assert!(seen_rev >= rev, "ack for rev {rev} came before its frame");
                acks += 1;
            }
            other => panic!("unexpected message {other:?}"),
        }
    }
    assert_eq!(seen_rev, count as u64);

    let frame = frame_value(&server.hub);
    assert_eq!(frame["tab"], "t3");
    assert_eq!(
        frame["tabs"],
        json!([board("t1", "Board 1"), board("t3", "Board 2")])
    );
    assert_eq!(frame["state"]["game"]["nodes"][2]["san"], "e5");

    server.stop().await;
}

#[test]
fn an_ai_cannot_send_a_tab_intent() {
    let hub = Hub::new("test".into());

    for body in [
        json!({"op": "tab_new"}),
        json!({"op": "tab_select", "tab": "t1"}),
        json!({"op": "tab_rename", "tab": "t1", "name": "Mine"}),
        json!({"op": "tab_close", "tab": "t1"}),
        json!({"op": "tab_move", "tab": "t1", "to": 0}),
    ] {
        let refused = hub
            .apply_desk("ai:guest", &body.to_string(), None)
            .expect_err("an AI sends no tab intent");
        assert_eq!(refused.code(), "bad_input");
        assert_eq!(refused.to_string(), AI_TAB_INTENT);
    }

    assert_eq!(hub.latest().rev, 0);
    assert_eq!(hub.read_desk(|d| d.tabs().len()), 1);
    assert_eq!(hub.tab_name(tab("t1")).as_deref(), Some("Board 1"));
}

#[tokio::test]
async fn closing_the_ais_tab_from_the_socket_ends_its_wait_and_moves_every_view() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (ai, _) = Ai::connect(server.port, "seated").await;
    seat_black(&ai).await;
    let (mut a, _) = view(server.port).await;
    let (mut b, _) = view(server.port).await;

    frame_then_ack(&mut a, 1, json!({"op": "tab_new"})).await;
    frame_then_ack(&mut a, 2, json!({"op": "tab_select", "tab": "t1"})).await;
    let shown = frame_at(&mut b, 3).await;
    assert_eq!(shown["tab"], "t1");
    assert_eq!(mark_of(&shown, "t1"), "your_move");

    let pending = spawn_wait(&ai, json!({"seat": "black", "timeout_s": 20}));
    until("the wait to start", || hub.presence().is_waiting(&ai.by)).await;

    let (_, ack) = frame_then_ack(&mut a, 3, json!({"op": "tab_close", "tab": "t1"})).await;
    assert_eq!(
        ack,
        json!({"t": "ack", "id": 3, "ok": true, "rev": 4,
               "result": {"closed": "t1", "selected": "t2"}})
    );

    let result = finish(pending).await;
    assert_ne!(result["isError"], true, "{result}");
    assert_eq!(
        *structured(&result),
        json!({"event": "game_over", "stopped": "tab_closed", "message": TAB_CLOSED_LINE})
    );

    let moved = frame_at(&mut b, 4).await;
    assert_eq!(moved["tab"], "t2");
    assert_eq!(
        moved["hint"],
        json!({"reason": "tab_close", "by": "view:1", "intent_id": 3})
    );
    assert_eq!(moved["tabs"], json!([board("t2", "Board 2")]));
    assert_eq!(moved["state"]["game"]["fen"], INITIAL_FEN);
    assert_eq!(moved["state"]["match"]["active"], false);
    assert_eq!(presence_ais(&hub)[0]["tab"], Value::Null);

    server.stop().await;
}

#[tokio::test]
async fn two_views_receive_the_same_frame_when_one_selects_a_tab() {
    let server = serve("web").await;
    let (mut a, _) = view(server.port).await;
    let (mut b, _) = view(server.port).await;

    frame_then_ack(&mut a, 1, json!({"op": "tab_new"})).await;
    ask(
        &mut a,
        2,
        json!({"op": "play", "move": "Nf3", "from_node": 0, "tab": "t2"}),
    )
    .await;
    ack_for(&mut a, 2).await;
    frame_at(&mut b, 2).await;

    let (on_b, _) = frame_then_ack(&mut b, 1, json!({"op": "tab_select", "tab": "t1"})).await;
    let on_a = frame_at(&mut a, 3).await;

    assert_eq!(on_a, on_b);
    assert_eq!(on_a["tab"], "t1");
    assert_eq!(
        on_a["hint"],
        json!({"reason": "tab_select", "by": "view:2", "intent_id": 1})
    );
    assert_eq!(on_a["state"]["game"]["fen"], INITIAL_FEN);

    server.stop().await;
}

#[tokio::test]
async fn a_new_tab_at_the_limit_is_refused() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;

    for id in 1..12 {
        let (_, ack) = frame_then_ack(&mut page, id, json!({"op": "tab_new"})).await;
        assert_eq!(ack["ok"], true, "{ack}");
    }
    assert_eq!(hub.read_desk(|d| d.tabs().len()), 12);
    let before = hub.latest().json.clone();

    let ack = only_ack(&mut page, 12, json!({"op": "tab_new"})).await;
    assert_eq!(ack, refusal(12, "tab_limit", "Close a board first."));
    let ack = only_ack(&mut page, 13, json!({"op": "tab_new", "copy_of": "t1"})).await;
    assert_eq!(ack, refusal(13, "tab_limit", "Close a board first."));

    assert_eq!(hub.latest().json, before);
    assert_eq!(hub.read_desk(|d| d.tabs().len()), 12);

    // Closing one makes room again, and the new tab takes a new id.
    frame_then_ack(&mut page, 14, json!({"op": "tab_close", "tab": "t5"})).await;
    let (_, ack) = frame_then_ack(&mut page, 15, json!({"op": "tab_new"})).await;
    assert_eq!(ack["result"], json!({"tab": "t13"}));

    server.stop().await;
}

#[tokio::test]
async fn a_rename_to_an_invisible_name_is_refused_and_names_are_cleaned() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;

    let ack = only_ack(
        &mut page,
        1,
        json!({"op": "tab_rename", "tab": "t1", "name": "\u{200B} \u{FEFF}\t\u{202E}"}),
    )
    .await;
    assert_eq!(
        ack,
        refusal(
            1,
            "bad_input",
            "A board needs a name with at least one visible character."
        )
    );
    assert_eq!(hub.latest().rev, 0);
    assert_eq!(hub.tab_name(tab("t1")).as_deref(), Some("Board 1"));

    let long = format!("  Ruy\u{0007}   {}", "L".repeat(60));
    let (_, ack) = frame_then_ack(
        &mut page,
        2,
        json!({"op": "tab_rename", "tab": "t1", "name": long}),
    )
    .await;
    let cleaned = format!("Ruy {}", "L".repeat(36));
    assert_eq!(ack["result"], json!({"tab": "t1", "name": cleaned}));
    assert_eq!(hub.tab_name(tab("t1")), Some(cleaned));

    server.stop().await;
}

#[tokio::test]
async fn oversized_and_malformed_tab_messages_leave_the_socket_open() {
    let server = serve("web").await;
    let hub = server.hub.clone();
    let (mut page, _) = view(server.port).await;
    let before = hub.latest().json.clone();

    ask(
        &mut page,
        1,
        json!({"op": "tab_rename", "tab": "t1", "name": "x".repeat(100_000)}),
    )
    .await;
    let ack = next_json(&mut page).await;
    assert_eq!(ack["id"], 1, "{ack}");
    assert_eq!(ack["error"]["code"], "bad_input");
    assert!(
        ack["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("the limit is 65536")),
        "{ack}"
    );

    let malformed = [
        json!({"op": "tab_select"}),
        json!({"op": "tab_select", "tab": 7}),
        json!({"op": "tab_select", "tab": null}),
        json!({"op": "tab_new", "name": 5}),
        json!({"op": "tab_rename", "tab": "t1"}),
        json!({"op": "tab_move", "tab": "t1", "to": -1}),
        json!({"op": "tab_move", "tab": "t1", "to": 1e30}),
        json!({"op": "tab_close", "tab": ["t1"]}),
        json!({"op": "tab_wander", "tab": "t1"}),
    ];
    for (i, body) in malformed.into_iter().enumerate() {
        let id = i as u64 + 2;
        let ack = only_ack(&mut page, id, body).await;
        assert_eq!(ack["ok"], false, "{ack}");
        assert_eq!(ack["error"]["code"], "bad_input", "{ack}");
    }

    let ack = only_ack(
        &mut page,
        20,
        json!({"op": "tab_move", "tab": "t1", "to": 1}),
    )
    .await;
    assert_eq!(
        ack,
        refusal(20, "bad_input", "to must be a place from 0 to 0")
    );

    for (id, text) in [
        (
            21,
            r#"{"t":"intent","id":21,"op":"tab_select","tab":"t1","tab":"t1"}"#,
        ),
        (
            22,
            r#"{"t":"intent","id":22,"tab":"t1","tab":"t1","op":"play","move":"e4"}"#,
        ),
        (
            23,
            r#"{"t":"intent","id":23,"op":"play","op":"tab_new","tab":"t1"}"#,
        ),
    ] {
        page.send(Message::Text(text.into())).await.expect("send");
        let ack = next_json(&mut page).await;
        assert_eq!(ack["id"], id, "{ack}");
        assert_eq!(ack["error"]["code"], "bad_input", "{ack}");
        assert!(
            ack["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("duplicate field")),
            "{ack}"
        );
    }

    assert_eq!(hub.latest().json, before);
    assert_eq!(hub.read_desk(|d| d.tabs().len()), 1);

    let (frame, ack) = frame_then_ack(
        &mut page,
        30,
        json!({"op": "play", "move": "e4", "from_node": 0, "tab": "t1"}),
    )
    .await;
    assert_eq!(frame["rev"], 1);
    assert_eq!(ack["ok"], true, "{ack}");

    server.stop().await;
}

// ------------------------------------------------------------------ the published surface

#[tokio::test]
async fn the_tool_definitions_and_instructions_keep_their_size() {
    let server = serve("web").await;
    let (ai, init) = Ai::connect(server.port, "measurer").await;
    let instructions = init["result"]["instructions"].as_str().unwrap_or("");
    assert_eq!(instructions.len(), 795);

    let (list, _) = ai.request("tools/list", json!({})).await;
    let bytes: usize = list["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|t| t.to_string().len())
        .sum();
    assert_eq!(bytes, 4349);

    server.stop().await;
}
