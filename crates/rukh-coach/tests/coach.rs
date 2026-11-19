//! The coach's records and rules, on hand-made data with invented names.

use rukh_coach::batch::{
    batch_id, batch_number, game_file_number, game_id, game_number, sort, BatchRecord, Part,
    PlayerCount, Undone, MAX_CHOICES,
};
use rukh_coach::ending::{ending, read_termination, FinalPosition, Reason, Said};
use rukh_coach::game::{
    build, clear_side, game_text, give_side, parse_date, parse_rating, parse_time_control,
    utc_start, GameRecord, OpponentKind, Side, TimeControl,
};
use rukh_coach::hash::{fnv128_hex, Fnv128};
use rukh_coach::keys::{move_key, site_key, Keys};
use rukh_coach::names::{clean_name, same_name};
use rukh_coach::profile::{add_names, default_profile, my_names, profile_text, read_profile};
use rukh_coach::skip::{skip_of, Skip, Skipped};
use rukh_coach::state::State;
use rukh_coach::text::{TextGame, TextMove, TextTags, Variant};
use rukh_coach::time::utc_text;
use rukh_coach::version::Loaded;
use serde_json::{json, Value};

const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

fn moves(plies: usize) -> Vec<TextMove> {
    (0..plies)
        .map(|i| TextMove {
            san: format!("m{i}"),
            uci: format!("u{i}"),
            clock_ms: None,
        })
        .collect()
}

fn tags() -> TextTags {
    TextTags {
        site: Some("https://lichess.org/AbCd1234".into()),
        white: Some("Maren Holt".into()),
        black: Some("quill_fox".into()),
        white_elo: Some("1510".into()),
        black_elo: Some("1488".into()),
        time_control: Some("180+2".into()),
        termination: Some("Normal".into()),
        utc_date: Some("2026.10.12".into()),
        utc_time: Some("19:02:11".into()),
        ..TextTags::default()
    }
}

fn game(plies: usize) -> TextGame {
    TextGame {
        tags: tags(),
        variant: Variant::Standard,
        start_fen: START.into(),
        from_position: false,
        chess960_castling: false,
        moves: moves(plies),
        result: Some("1-0".into()),
        last: FinalPosition::default(),
        start: 0,
        end: 100,
    }
}

fn mine() -> Vec<String> {
    vec!["MAREN holt".to_string()]
}

// ------------------------------------------------------------------ hash and time

#[test]
fn the_hash_is_fnv1a_128() {
    assert_eq!(fnv128_hex(b""), "6c62272e07bb014262b821756295c58d");
    assert_eq!(fnv128_hex(b"a"), "d228cb696f1a8caf78912b704e4a8964");

    let mut split = Fnv128::new();
    split.bytes(b"fo");
    split.bytes(b"obar");
    assert_eq!(split.hex(), fnv128_hex(b"foobar"));
}

#[test]
fn fields_cannot_run_into_each_other() {
    let mut a = Fnv128::new();
    a.field("ab");
    a.field("c");

    let mut b = Fnv128::new();
    b.field("a");
    b.field("bc");

    assert_ne!(a.hex(), b.hex());
}

#[test]
fn utc_text_writes_calendar_times() {
    assert_eq!(utc_text(0), "1970-01-01T00:00:00Z");
    assert_eq!(utc_text(1_791_831_731_000), "2026-10-12T19:02:11Z");
    assert_eq!(utc_text(951_868_799_999), "2000-02-29T23:59:59Z");
}

// ------------------------------------------------------------------ names

#[test]
fn names_lose_control_bidi_and_zero_width_characters() {
    assert_eq!(
        clean_name("Ma\u{202E}ren\u{200B} \u{0007}Holt\u{2066}").as_deref(),
        Some("Maren Holt")
    );
    assert_eq!(clean_name("  a\n\tb  ").as_deref(), Some("a b"));
    assert_eq!(clean_name("\u{200B}\u{FEFF}\u{0000}"), None);
    assert_eq!(clean_name(""), None);
}

#[test]
fn names_are_cut_to_thirty_characters_and_markup_stays_text() {
    let long = "x".repeat(50);
    assert_eq!(clean_name(&long).map(|n| n.chars().count()), Some(30));

    assert_eq!(
        clean_name("<img src=x onerror=alert(1)>").as_deref(),
        Some("<img src=x onerror=alert(1)>")
    );
    assert_eq!(
        clean_name("\u{00e9}\u{00e9}\u{00e9}").as_deref(),
        Some("\u{00e9}\u{00e9}\u{00e9}")
    );
}

#[test]
fn names_compare_without_case() {
    assert!(same_name("Quill_Fox", "quill_FOX"));
    assert!(!same_name("quill_fox", "quill_fox2"));
}

// ------------------------------------------------------------------ endings

#[test]
fn a_termination_naming_a_player_is_matched_to_fixed_words() {
    let names = ["checkmate_kid", "Timeout Tom"];

    assert_eq!(
        read_termination("checkmate_kid won by resignation", &names),
        Said::Reason(Reason::Resign)
    );
    assert_eq!(
        read_termination("Timeout Tom won by checkmate", &names),
        Said::Reason(Reason::Checkmate)
    );
    assert_eq!(
        read_termination("checkmate_kid won on time", &names),
        Said::Reason(Reason::Flag)
    );
}

#[test]
fn a_short_or_word_like_name_never_hides_a_fixed_word() {
    let cases = [
        ("on", "Ann won on time", Said::Reason(Reason::Flag)),
        ("time", "time won on time", Said::Reason(Reason::Flag)),
        (
            "mate",
            "mate won by checkmate",
            Said::Reason(Reason::Checkmate),
        ),
        ("e", "Bo won by resignation", Said::Reason(Reason::Resign)),
        (
            "e",
            "Game drawn by stalemate",
            Said::Reason(Reason::Stalemate),
        ),
        ("al", "Normal", Said::Normal),
        ("Normal", "Normal", Said::Nothing),
    ];

    for (name, text, said) in cases {
        assert_eq!(
            read_termination(text, &[name, "Bo"]),
            said,
            "{name}: {text}"
        );
    }
}

#[test]
fn every_fixed_word_is_read() {
    let cases = [
        ("Game drawn by agreement", Said::Reason(Reason::Agreed)),
        ("Game drawn by repetition", Said::Reason(Reason::Repetition)),
        ("Game drawn by stalemate", Said::Reason(Reason::Stalemate)),
        (
            "Game drawn by insufficient material",
            Said::Reason(Reason::Insufficient),
        ),
        (
            "Game drawn by timeout vs insufficient material",
            Said::Reason(Reason::Flag),
        ),
        (
            "Game drawn by 50-move rule",
            Said::Reason(Reason::FiftyMove),
        ),
        ("Ann won - game abandoned", Said::Reason(Reason::Abandoned)),
        ("Time forfeit", Said::Reason(Reason::Flag)),
        ("Abandoned", Said::Reason(Reason::Abandoned)),
        ("Normal", Said::Normal),
        ("Rules infraction", Said::Nothing),
        ("<b>anything</b>", Said::Nothing),
    ];

    for (text, said) in cases {
        assert_eq!(read_termination(text, &["Ann", "Bo"]), said, "{text}");
    }
}

#[test]
fn normal_is_completed_from_the_final_position() {
    let mate = FinalPosition {
        checkmate: true,
        ..FinalPosition::default()
    };
    let stalemate = FinalPosition {
        stalemate: true,
        ..FinalPosition::default()
    };
    let none = FinalPosition::default();

    assert_eq!(
        ending(Some("Normal"), &[], "1-0", &mate),
        Some(Reason::Checkmate)
    );
    assert_eq!(
        ending(Some("Normal"), &[], "0-1", &none),
        Some(Reason::Resign)
    );
    assert_eq!(
        ending(Some("Normal"), &[], "1/2-1/2", &stalemate),
        Some(Reason::Stalemate)
    );
    assert_eq!(
        ending(Some("Normal"), &[], "1/2-1/2", &none),
        Some(Reason::Agreed)
    );
    assert_eq!(ending(None, &[], "1-0", &mate), Some(Reason::Checkmate));
    assert_eq!(ending(None, &[], "1-0", &none), None);
    assert_eq!(ending(Some("Rules infraction"), &[], "1-0", &none), None);
}

// ------------------------------------------------------------------ skipped games

#[test]
fn skipped_reasons_follow_one_order() {
    let mut chess960_set_up = game(20);
    chess960_set_up.variant = Variant::Chess960;
    chess960_set_up.from_position = true;
    chess960_set_up.result = None;
    assert_eq!(skip_of(&chess960_set_up), Some(Skip::Variant));

    let mut chess960 = game(20);
    chess960.variant = Variant::Chess960;
    assert_eq!(skip_of(&chess960), None);

    let mut unfinished = game(4);
    unfinished.result = Some("*".into());
    assert_eq!(skip_of(&unfinished), Some(Skip::Unfinished));

    let mut no_result = game(40);
    no_result.result = None;
    assert_eq!(skip_of(&no_result), Some(Skip::Unfinished));

    assert_eq!(skip_of(&game(9)), Some(Skip::TooShort));
    assert_eq!(skip_of(&game(10)), None);
    assert_eq!(skip_of(&game(600)), None);
    assert_eq!(skip_of(&game(601)), Some(Skip::TooLong));

    let mut set_up = game(20);
    set_up.from_position = true;
    assert_eq!(skip_of(&set_up), None);
}

#[test]
fn skipped_counts_add_up() {
    let mut skipped = Skipped::default();
    for skip in [
        Skip::Variant,
        Skip::Variant,
        Skip::TooShort,
        Skip::TooLong,
        Skip::Unreadable,
        Skip::Unfinished,
        Skip::Unfinished,
    ] {
        skipped.add(skip);
    }

    assert_eq!(
        serde_json::to_value(skipped).expect("json"),
        json!({"variant": 2, "too_short": 1, "too_long": 1, "unreadable": 1, "unfinished": 2})
    );
    assert_eq!(skipped.total(), 7);
}

// ------------------------------------------------------------------ keys

#[test]
fn site_keys_come_from_strict_patterns() {
    let with = |site: Option<&str>, link: Option<&str>, id: Option<&str>| TextTags {
        site: site.map(str::to_string),
        link: link.map(str::to_string),
        game_id: id.map(str::to_string),
        ..TextTags::default()
    };
    let key = |tags: TextTags| site_key(&tags).map(|k| (k.site, k.key));

    assert_eq!(
        key(with(Some("https://lichess.org/AbCd1234"), None, None)),
        Some(("lichess", "lichess:AbCd1234".to_string()))
    );
    assert_eq!(
        key(with(
            Some("Chess.com"),
            Some("https://www.chess.com/game/live/123456789"),
            None
        )),
        Some(("chess.com", "chess.com:live:123456789".to_string()))
    );
    assert_eq!(
        key(with(
            None,
            Some("https://www.chess.com/game/daily/777"),
            None
        )),
        Some(("chess.com", "chess.com:daily:777".to_string()))
    );
    assert_eq!(
        key(with(
            Some("https://lichess.org/AbCd1234"),
            None,
            Some("AbCd1234")
        )),
        Some(("lichess", "lichess:AbCd1234".to_string()))
    );
    assert_eq!(
        key(with(None, None, Some("ZyXw9876"))),
        Some(("lichess", "lichess:ZyXw9876".to_string()))
    );

    let refused = [
        with(Some("https://lichess.org/AbCd123"), None, None),
        with(Some("https://lichess.org/AbCd1234?x=1"), None, None),
        with(
            Some("https://lichess.org.evil.example/AbCd1234"),
            None,
            None,
        ),
        with(
            Some("https://evil.example/lichess.org/AbCd1234"),
            None,
            None,
        ),
        with(None, Some("https://www.chess.com/game/live/12a"), None),
        with(None, Some("https://www.chess.com/game/blitz/123"), None),
        with(None, Some("javascript:alert(1)"), None),
        with(Some("Chess.com"), None, Some("AbCd1234")),
        with(None, None, Some("AbCd-234")),
    ];
    for tags in refused {
        assert_eq!(site_key(&tags), None, "{tags:?}");
    }
}

#[test]
fn the_move_key_ignores_name_case_and_nothing_else() {
    let base = move_key(START, ["e2e4", "e7e5"], "2026-10-12T19:02:11Z", "Ann", "Bo");

    assert_eq!(
        base,
        move_key(START, ["e2e4", "e7e5"], "2026-10-12T19:02:11Z", "aNN", "BO")
    );
    assert_ne!(
        base,
        move_key(START, ["e2e4", "e7e6"], "2026-10-12T19:02:11Z", "Ann", "Bo")
    );
    assert_ne!(
        base,
        move_key(START, ["e2e4", "e7e5"], "2026-10-12T19:02:12Z", "Ann", "Bo")
    );
    assert_ne!(
        base,
        move_key(START, ["e2e4", "e7e5"], "2026-10-12T19:02:11Z", "Bo", "Ann")
    );
    assert_ne!(
        base,
        move_key(
            "8/8/8/8/8/8/8/K1k5 w - - 0 1",
            ["e2e4", "e7e5"],
            "2026-10-12T19:02:11Z",
            "Ann",
            "Bo"
        )
    );
}

#[test]
fn the_move_key_is_pinned_across_builds() {
    let key = move_key(START, ["e2e4", "e7e5"], "2026-10-12T19:02:11Z", "Ann", "Bo");
    assert_eq!(key, PINNED_MOVE_KEY);
}

const PINNED_MOVE_KEY: &str = "6bc7d5b2225398264b921a254426c8c2";

#[test]
fn the_keys_index_adds_removes_and_keeps_unknown_fields() {
    let mut keys = Keys::new();
    keys.add("g0001", "k1", Some("lichess:AbCd1234"));
    keys.add("g0002", "k2", Some("lichess:AbCd1234"));
    keys.add("g0003", "k3", None);
    keys.covers_below = 4;

    assert_eq!(keys.holder("k2"), Some("g0002"));
    assert_eq!(keys.sites["lichess:AbCd1234"], vec!["g0001", "g0002"]);

    keys.remove("g0001");
    assert_eq!(keys.holder("k1"), None);
    assert_eq!(keys.sites["lichess:AbCd1234"], vec!["g0002"]);

    keys.keep(|id| id != "g0002");
    assert!(keys.sites.is_empty());
    assert_eq!(keys.moves.len(), 1);

    let mut text = keys.to_text();
    text = text.replacen('{', "{\"later\":[1,2],", 1);
    let read = Keys::from_text(&text).expect("read");
    assert_eq!(read.extra["later"], json!([1, 2]));
    assert_eq!(Keys::from_text(&read.to_text()), Some(read));

    assert_eq!(
        Keys::from_text("{\"v\":2,\"covers_below\":1,\"moves\":{},\"sites\":{}}"),
        None
    );
}

// ------------------------------------------------------------------ the game file

#[test]
fn time_controls_ratings_and_dates_are_read_strictly() {
    assert_eq!(
        parse_time_control("900+10"),
        Some(TimeControl {
            base_s: Some(900),
            inc_s: Some(10),
            daily_s: None
        })
    );
    assert_eq!(
        parse_time_control("180"),
        Some(TimeControl {
            base_s: Some(180),
            inc_s: Some(0),
            daily_s: None
        })
    );
    assert_eq!(
        parse_time_control("1/86400"),
        Some(TimeControl {
            base_s: None,
            inc_s: None,
            daily_s: Some(86400)
        })
    );
    for bad in ["-", "?", "", "+5", "10+", "1e3", "99999999"] {
        assert_eq!(parse_time_control(bad), None, "{bad}");
    }

    assert_eq!(parse_rating(" 1500 "), Some(1500));
    for bad in ["?", "", "-5", "1500.5", "123456", "15OO"] {
        assert_eq!(parse_rating(bad), None, "{bad}");
    }

    assert_eq!(parse_date("2026.10.12").as_deref(), Some("2026-10-12"));
    assert_eq!(parse_date("2026.??.??"), None);
    assert_eq!(parse_date("2026.13.01"), None);
    assert_eq!(
        utc_start("2026.10.12", "19:02:11").as_deref(),
        Some("2026-10-12T19:02:11Z")
    );
    assert_eq!(utc_start("2026.10.12", "24:00:00"), None);
    assert_eq!(utc_start("2026.10.12", "9:02:11"), None);
}

#[test]
fn a_built_game_carries_the_kept_fields_only() {
    let mut text = game(12);
    text.tags.termination = Some("quill_fox won by resignation".into());
    text.tags.black_title = Some("BOT".into());

    let record = build(&text, &mine()).expect("built");

    assert_eq!(record.kind, "imported");
    assert_eq!(record.started.as_deref(), Some("2026-10-12T19:02:11Z"));
    assert_eq!(record.date, None);
    assert_eq!(record.you, Some(Side::White));
    assert_eq!(record.you_rating, Some(1510));
    let opponent = record.opponent.clone().expect("opponent");
    assert_eq!(opponent.kind, OpponentKind::Bot);
    assert_eq!(opponent.name.as_deref(), Some("quill_fox"));
    assert_eq!(opponent.rating, Some(1488));
    assert_eq!(record.reason, Some(Reason::Resign));
    assert_eq!(record.plies, 12);
    assert_eq!(record.source.site.as_deref(), Some("lichess"));
    assert_eq!(record.source.site_key.as_deref(), Some("lichess:AbCd1234"));
    assert!(!record.source.verified);
    assert_eq!(record.source.raw.part, "part-001.pgn");

    let text = record.to_text();
    assert!(!text.contains("won by"), "{text}");
    assert!(!text.contains("resignation"), "{text}");
}

#[test]
fn an_unknown_side_leaves_you_and_opponent_empty() {
    let record = build(&game(12), &["someone else".to_string()]).expect("built");

    assert_eq!(record.you, None);
    assert_eq!(record.you_rating, None);
    assert_eq!(record.opponent, None);

    let mut both = game(12);
    both.tags.black = Some("maren HOLT".into());
    assert_eq!(build(&both, &mine()).expect("built").you, None);
}

#[test]
fn thinking_time_comes_from_two_clocks_and_the_increment() {
    let mut text = game(12);
    let clocks = [
        Some(180_000),
        Some(180_000),
        Some(175_000),
        None,
        Some(190_000),
        Some(170_000),
    ];
    for (m, clock) in text.moves.iter_mut().zip(clocks) {
        m.clock_ms = clock;
    }

    let record = build(&text, &mine()).expect("built");
    let ms: Vec<Option<u64>> = record.moves.iter().map(|m| m.ms).collect();
    let clk: Vec<Option<u64>> = record.moves.iter().map(|m| m.clk).collect();

    assert_eq!(&clk[..6], &clocks);
    assert_eq!(ms[0], Some(2_000));
    assert_eq!(ms[1], Some(2_000));
    assert_eq!(ms[2], Some(7_000));
    assert_eq!(ms[3], None);
    assert_eq!(ms[4], Some(0), "never below 0");
    assert_eq!(ms[5], None);
    assert_eq!(ms[6], None);

    let line = record.to_text();
    assert!(line.contains("{\"uci\":\"u3\",\"san\":\"m3\"}"), "{line}");
    assert!(
        line.contains("{\"uci\":\"u0\",\"san\":\"m0\",\"clk\":180000,\"ms\":2000}"),
        "{line}"
    );
}

#[test]
fn a_daily_or_untimed_game_has_clocks_but_no_times() {
    let mut text = game(12);
    text.tags.time_control = Some("1/86400".into());
    text.moves[0].clock_ms = Some(86_400_000);
    text.moves[2].clock_ms = Some(80_000_000);

    let record = build(&text, &mine()).expect("built");
    assert_eq!(record.moves[2].clk, Some(80_000_000));
    assert!(record.moves.iter().all(|m| m.ms.is_none()));
}

#[test]
fn a_game_file_round_trips_byte_for_byte() {
    let mut text = game(14);
    text.moves[0].clock_ms = Some(179_000);
    text.tags.white = Some("Ma\u{200B}ren \"the\" <Holt>".into());

    let mut record = build(&text, &mine()).expect("built");
    record.id = "g0007".into();
    record.source.batch = "b0002".into();

    let written = record.to_text();
    assert!(
        written.starts_with("{\n  \"v\": 1,\n  \"id\": \"g0007\",\n  \"kind\": \"imported\",\n"),
        "{written}"
    );
    assert!(written.ends_with("\n  ]\n}\n"), "{written}");

    let value: Value = serde_json::from_str(&written).expect("json");
    assert_eq!(game_text(&value), written);

    let read: GameRecord = serde_json::from_str(&written).expect("record");
    assert_eq!(read, record);
    assert_eq!(read.to_text(), written);
}

#[test]
fn unknown_fields_in_a_game_file_are_kept_on_rewrite() {
    let mut record = build(&game(12), &[]).expect("built");
    record.id = "g0001".into();

    let mut value: Value = serde_json::from_str(&record.to_text()).expect("json");
    value["later"] = json!({"z": 1, "a": [2]});
    value["moves"][0]["note"] = json!("kept");
    let text = game_text(&value);

    let read: GameRecord = serde_json::from_str(&text).expect("record");
    assert_eq!(read.extra["later"], json!({"z": 1, "a": [2]}));

    // The program rewrites a stored game as a JSON value, so fields inside a move survive too.
    let again: Value = serde_json::from_str(&text).expect("json");
    assert_eq!(game_text(&again), text);
    assert!(
        text.contains("{\"uci\":\"u0\",\"san\":\"m0\",\"note\":\"kept\"}"),
        "{text}"
    );
}

#[test]
fn a_stored_game_learns_its_side_from_new_names() {
    let mut record = build(&game(12), &[]).expect("built");
    record.id = "g0001".into();
    let mut value: Value = serde_json::from_str(&record.to_text()).expect("json");

    assert!(!give_side(&mut value, &["nobody".to_string()]));
    assert!(give_side(&mut value, &["QUILL_FOX".to_string()]));

    assert_eq!(value["you"], "black");
    assert_eq!(value["you_rating"], 1488);
    assert_eq!(
        value["opponent"],
        json!({"type": "person", "name": "Maren Holt", "rating": 1510})
    );

    assert!(
        !give_side(&mut value, &["Maren Holt".to_string()]),
        "a known side stays"
    );
}

#[test]
fn chess960_and_set_up_games_are_kept_with_their_start() {
    let mut chess960 = game(12);
    chess960.variant = Variant::Chess960;
    chess960.start_fen = "rkbbnnqr/pppppppp/8/8/8/8/PPPPPPPP/RKBBNNQR w KQkq - 0 1".into();
    let record = build(&chess960, &[]).expect("built");
    assert_eq!(record.variant, Variant::Chess960);
    assert!(!record.from_position);

    let mut set_up = game(12);
    set_up.from_position = true;
    set_up.start_fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1".into();
    let record = build(&set_up, &[]).expect("built");
    assert!(record.from_position);
    assert_eq!(record.start_fen, "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1");
}

#[test]
fn a_game_with_no_utc_time_keys_on_its_date() {
    let mut text = game(12);
    text.tags.utc_date = None;
    text.tags.utc_time = None;
    text.tags.date = Some("2026.10.12".into());

    let record = build(&text, &[]).expect("built");
    assert_eq!(record.started, None);
    assert_eq!(record.date.as_deref(), Some("2026-10-12"));

    let mut other_day = text.clone();
    other_day.tags.date = Some("2026.10.13".into());
    assert_ne!(
        record.move_key,
        build(&other_day, &[]).expect("built").move_key
    );
}

// ------------------------------------------------------------------ sorting an import

#[test]
fn an_import_sorts_new_already_here_and_skipped() {
    let first = game(12);
    let mut second = game(14);
    second.tags.site = Some("https://lichess.org/AbCd1234".into());
    let mut short = game(3);
    short.tags.white = Some("Pip".into());
    let mut variant = game(20);
    variant.variant = Variant::Chess960;
    variant.from_position = true;

    let stored = build(&first, &[]).expect("built");
    let mut keys = Keys::new();
    keys.add("g0001", &stored.move_key, stored.source.site_key.as_deref());

    let mut unreadable = Skipped::default();
    unreadable.add(Skip::Unreadable);

    let games = vec![first.clone(), second.clone(), second, short, variant];
    let sorted = sort(&games, unreadable, &keys, &[]);

    assert_eq!(sorted.new.len(), 1);
    assert_eq!(sorted.summary.added, 1);
    assert_eq!(
        sorted.summary.already_here, 2,
        "stored once and repeated once"
    );
    assert_eq!(
        sorted.summary.skipped,
        Skipped {
            variant: 1,
            too_short: 1,
            too_long: 0,
            unreadable: 1,
            unfinished: 0
        }
    );
    assert_eq!(sorted.summary.skipped_total, 3);
    assert_eq!(sorted.summary.side_unknown, 3);
    assert_eq!(
        sorted.summary.choose,
        vec![
            PlayerCount {
                name: "Maren Holt".into(),
                games: 3
            },
            PlayerCount {
                name: "quill_fox".into(),
                games: 3
            },
        ]
    );
}

#[test]
fn a_pasted_site_id_does_not_stop_a_different_game() {
    let stored = build(&game(12), &[]).expect("built");
    let mut keys = Keys::new();
    keys.add("g0001", &stored.move_key, stored.source.site_key.as_deref());

    let mut other = game(16);
    other.tags.white = Some("Someone New".into());
    let sorted = sort(&[other], Skipped::default(), &keys, &[]);

    assert_eq!(sorted.summary.added, 1);
    assert_eq!(sorted.new[0].source.site_key, stored.source.site_key);
}

#[test]
fn the_choices_are_capped_and_ranked() {
    let games: Vec<TextGame> = (0..30)
        .map(|i| {
            let mut g = game(12);
            g.tags.white = Some(format!("player{i:02}"));
            g.tags.utc_time = Some(format!("10:{i:02}:00"));
            g
        })
        .collect();

    let sorted = sort(&games, Skipped::default(), &Keys::new(), &[]);
    assert_eq!(sorted.summary.choose.len(), MAX_CHOICES);
    assert_eq!(
        sorted.summary.choose[0],
        PlayerCount {
            name: "quill_fox".into(),
            games: 30
        }
    );

    let known = sort(
        &games,
        Skipped::default(),
        &Keys::new(),
        &["Quill_Fox".to_string()],
    );
    assert_eq!(known.summary.side_unknown, 0);
    assert!(known.summary.choose.is_empty());
}

// ------------------------------------------------------------------ ids, batches, profile, state

#[test]
fn ids_are_read_only_in_their_exact_form() {
    assert_eq!(game_id(7), "g0007");
    assert_eq!(game_id(12345), "g12345");
    assert_eq!(game_number("g0007"), Some(7));
    assert_eq!(game_number("g12345"), Some(12345));
    assert_eq!(game_file_number("g0007.json"), Some(7));
    assert_eq!(batch_id(3), "b0003");
    assert_eq!(batch_number("b0003"), Some(3));

    for bad in [
        "g007", "g00007", "g0000", "g+007", "G0007", "g0007x", "g", "b0001",
    ] {
        assert_eq!(game_number(bad), None, "{bad}");
    }
    for bad in ["b0001/..", "..", "b-001", "b0000", "b0001.json"] {
        assert_eq!(batch_number(bad), None, "{bad}");
    }
    assert_eq!(game_file_number("g0007.json.tmp-12"), None);
}

#[test]
fn a_batch_record_round_trips_and_keeps_unknown_fields() {
    let record = BatchRecord {
        v: 1,
        id: "b0001".into(),
        kind: "text".into(),
        received: Some("2026-10-12T19:02:11Z".into()),
        parts: vec![Part {
            name: "part-001.pgn".into(),
            bytes: 1234,
        }],
        added: vec!["g0001".into()],
        already_here: 2,
        skipped: Skipped::default(),
        undone: Some(Undone {
            at: "2026-10-13T00:00:00Z".into(),
            moved: vec!["g0001".into()],
        }),
        extra: Default::default(),
    };

    let text = record.to_text();
    assert_eq!(BatchRecord::from_text(&text), Some(record.clone()));

    let with_more = text.replacen('{', "{\n  \"note\": \"x\",", 1);
    let read = BatchRecord::from_text(&with_more).expect("read");
    assert_eq!(read.extra["note"], "x");
    assert!(read.to_text().contains("\"note\": \"x\""));
}

#[test]
fn the_default_profile_has_every_field_and_no_names() {
    let profile = default_profile();

    for field in [
        "v",
        "name",
        "share_name_with_ai",
        "experience",
        "goal",
        "learning_style",
        "format",
        "direction",
        "minutes_per_day",
        "day_starts_at",
        "share_with_ai",
        "record_other_games",
        "opponent",
        "assessment",
        "outside",
        "my_names",
    ] {
        assert!(profile.get(field).is_some(), "{field}");
    }
    assert_eq!(profile["share_with_ai"], "off");
    assert!(my_names(&profile).is_empty());
    assert_eq!(read_profile(&profile_text(&profile)), Some(profile));
}

#[test]
fn names_are_added_once_without_case_and_other_fields_are_kept() {
    let mut profile = default_profile();
    profile["goal"] = json!("reach 1400");
    profile["later"] = json!(true);

    let list = add_names(
        &mut profile,
        &[
            "Maren Holt".into(),
            "maren holt".into(),
            "\u{200B}".into(),
            "Quill\u{202E}_fox".into(),
        ],
    );
    assert_eq!(list, vec!["Maren Holt", "Quill_fox"]);

    let list = add_names(&mut profile, &["QUILL_FOX".into()]);
    assert_eq!(list, vec!["Maren Holt", "Quill_fox"]);

    assert_eq!(profile["goal"], "reach 1400");
    assert_eq!(profile["later"], true);
    assert_eq!(my_names(&profile), list);
}

#[test]
fn the_state_counters_rise_and_keep_unknown_fields() {
    let mut state =
        State::from_text("{\"v\":1,\"next_game\":3,\"next_batch\":1,\"tz_offset_min\":-300}")
            .expect("state");

    assert!(state.raise(7, 0));
    assert_eq!((state.next_game, state.next_batch), (8, 1));
    assert!(!state.raise(2, 0), "a lower number never lowers it");

    let text = state.to_text();
    assert!(text.contains("\"tz_offset_min\":-300"), "{text}");
    assert_eq!(State::from_text(&text), Some(state));
}

#[test]
fn the_default_persona_and_soul_read_as_written() {
    assert_eq!(
        rukh_coach::defaults::PERSONA,
        "# Coach persona
Name: Rook
Voice: plain, dry, warm underneath. Short sentences. No exclamation marks.
Method: ask what I was thinking before telling me the answer.
Praise: rare and specific. Never \"great move\".
Never: engine jargon (centipawns, depth). More than three points in one debrief.
Language: English
"
    );
    assert_eq!(
        rukh_coach::defaults::SOUL,
        "# Soul
I coach one person. I play them before I advise them.
I would rather be useful than impressive.

## Learned
"
    );
}

#[test]
fn a_removed_name_clears_only_the_side_it_gave() {
    let mut game = json!({
        "v": 1,
        "you": "black",
        "you_rating": 1488,
        "white": {"name": "Maren Holt", "rating": 1510, "bot": false},
        "black": {"name": "quill_fox", "rating": 1488, "bot": false},
        "opponent": {"type": "person", "name": "Maren Holt", "rating": 1510},
    });

    assert!(!clear_side(&mut game, &["QUILL_FOX".to_string()]));
    assert_eq!(game["you"], "black");

    assert!(clear_side(&mut game, &["Maren Holt".to_string()]));
    assert_eq!(game["you"], Value::Null);
    assert_eq!(game["opponent"], Value::Null);
    assert!(give_side(&mut game, &["Maren Holt".to_string()]));
    assert_eq!(game["you"], "white");

    let mut newer = json!({"v": 2, "you": "white", "white": {"name": "a"}});
    assert!(!clear_side(&mut newer, &[]));
}

#[test]
fn counters_above_the_highest_id_do_not_read() {
    for text in [
        "{\"v\":1,\"next_game\":1000000000000,\"next_batch\":1}",
        "{\"v\":1,\"next_game\":1,\"next_batch\":0}",
        "{\"v\":1,\"next_game\":18446744073709551615,\"next_batch\":1}",
    ] {
        assert_eq!(State::loaded(text), Loaded::Unreadable, "{text}");
    }

    assert_eq!(
        State::loaded("{\"v\":2,\"next_game\":1,\"next_batch\":1}"),
        Loaded::Newer(2)
    );

    let mut last = State::from_text("{\"v\":1,\"next_game\":999999999999,\"next_batch\":1}")
        .expect("the highest id reads");
    assert_eq!(last.take_game(), Some(999_999_999_999));
    assert_eq!(last.take_game(), None);
}
