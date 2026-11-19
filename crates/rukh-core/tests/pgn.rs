use std::ops::ControlFlow;

use rukh_core::pgn::{
    is_utf16, read_each, read_games, GameResult, Item, Problem, ReadGame, ReadText, MAX_TAGS,
    MAX_TAG_CHARS,
};
use rukh_core::{Game, Variant, INITIAL_FEN};

const ITALIAN: &str = "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2 Bxd2+ Nbxd2 d5 exd5 Nxd5 Qb3 Nce7 O-O O-O Rfe1 c6";

const ITALIAN_UCI: &str = "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d4 e5d4 c3d4 c5b4 c1d2 b4d2 b1d2 d7d5 e4d5 f6d5 d1b3 c6e7 e1g1 e8g8 f1e1 c7c6";

const QUEENS_GAMBIT: &str =
    "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6 cxd5 Nxd5 Bxe7 Qxe7 Nxd5 exd5";

fn sans(game: &ReadGame) -> Vec<&str> {
    game.moves.iter().map(|m| m.san.as_str()).collect()
}

fn ucis(game: &ReadGame) -> Vec<&str> {
    game.moves.iter().map(|m| m.uci.as_str()).collect()
}

fn clocks(game: &ReadGame) -> Vec<Option<u64>> {
    game.moves.iter().map(|m| m.clock_ms).collect()
}

fn read(text: &str) -> ReadText {
    read_games(text.as_bytes())
}

fn only_game(text: &str) -> ReadGame {
    let out = read(text);
    assert_eq!(out.unreadable, vec![], "nothing should be unreadable");
    assert_eq!(out.games.len(), 1, "one game");

    out.games.into_iter().next().unwrap()
}

fn numbered(moves: &str) -> String {
    let mut text = String::new();

    for (i, m) in moves.split_whitespace().enumerate() {
        if i % 2 == 0 {
            text.push_str(&format!("{}. ", i / 2 + 1));
        }
        text.push_str(m);
        text.push(' ');
    }

    text
}

fn ms(hours: u64, minutes: u64, seconds: u64, tenths: u64) -> Option<u64> {
    Some(((hours * 60 + minutes) * 60 + seconds) * 1000 + tenths * 100)
}

#[test]
fn san_only_refuses_what_parse_move_reads_as_uci() {
    let game = Game::standard();

    assert!(game.parse_san("B1c3").is_err());
    assert!(game.parse_san("b1c3").is_err());
    assert!(game.parse_san("g1f3").is_err());

    let uci = game.parse_move("B1c3").unwrap();
    assert_eq!(uci, game.parse_san("Nc3").unwrap());
}

#[test]
fn san_only_reads_san_as_exports_write_it() {
    let mut game = Game::standard();

    for m in ["e4!", "e5?!", "Nf3!?", "Nc6??", "Bc4", "Nf6", "0-0", "Bc5"] {
        game.play_san(m).unwrap_or_else(|e| panic!("{m}: {e}"));
    }
    assert_eq!(
        game.history(),
        ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "O-O", "Bc5"]
    );

    let mut mate = Game::standard();
    for m in ["f3", "e5", "g4", "Qh4#"] {
        mate.play_san(m).unwrap();
    }
    assert!(mate.status().checkmate);

    let mut promote = Game::from_fen("8/4P3/8/8/8/8/k7/4K3 w - - 0 1", None).unwrap();
    assert!(promote.parse_san("e8Q").is_err());
    assert!(promote.parse_san("e8").is_err());
    assert_eq!(promote.play_san("e8=Q+").unwrap().san, "e8=Q");

    let mut long = Game::from_fen("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", None).unwrap();
    assert_eq!(long.play_san("0-0-0+").unwrap().uci, "e1c1");
}

#[test]
fn san_only_refuses_null_moves_drops_and_junk() {
    let game = Game::standard();

    for text in [
        "--", "Z0", "N@e4", "", "   ", "e4 e5", "Nf3=Q", "nf3", "1. e4", "e2-e4",
    ] {
        assert!(game.parse_san(text).is_err(), "{text:?} should be refused");
    }

    let long = "Q".repeat(500);
    let message = game.parse_san(&long).unwrap_err().to_string();
    assert!(message.len() < 100, "{message}");
}

#[test]
fn a_game_past_the_ply_limit_is_marked_too_long_without_its_moves() {
    let text = format!(
        "{}*

1. d4 d5 *",
        numbered(ITALIAN)
    );

    let mut items = Vec::new();
    read_each(text.as_bytes(), 4, |item| {
        items.push(item);
        ControlFlow::Continue(())
    });

    let Item::Game(long) = &items[0] else {
        panic!("a game: {:?}", items[0]);
    };
    assert!(long.too_long);
    assert!(long.moves.is_empty());

    let Item::Game(short) = &items[1] else {
        panic!("a game: {:?}", items[1]);
    };
    assert!(!short.too_long);
    assert_eq!(sans(short), ["d4", "d5"]);
}

const LICHESS: &str = r#"[Event "Rated Blitz game"]
[Site "https://lichess.org/Qx7mWz2p"]
[Date "2026.03.14"]
[White "quietfalcon"]
[Black "Mossy_Bishop"]
[Result "1-0"]
[GameId "Qx7mWz2p"]
[UTCDate "2026.03.14"]
[UTCTime "18:02:11"]
[WhiteElo "1612"]
[BlackElo "1590"]
[WhiteRatingDiff "+6"]
[BlackRatingDiff "-6"]
[BlackTitle "BOT"]
[Variant "Standard"]
[TimeControl "180+2"]
[ECO "C54"]
[Opening "Italian Game: Classical Variation"]
[Termination "Normal"]

1. e4 { [%clk 0:03:00] } 1... e5 { [%clk 0:03:00] } 2. Nf3 { [%clk 0:02:59] } 2... Nc6 { [%clk 0:02:58] } 3. Bc4 { [%clk 0:02:57] } 3... Bc5 { [%clk 0:02:57] } 4. c3 { [%clk 0:02:55] } 4... Nf6 { [%clk 0:02:56] } 5. d4 { [%clk 0:02:50] } 5... exd4 { [%clk 0:02:55] } 6. cxd4 { [%clk 0:02:49] } 6... Bb4+ { [%clk 0:02:54] } 7. Bd2 { [%clk 0:02:40] } 7... Bxd2+ { [%clk 0:02:53] } 8. Nbxd2 { [%clk 0:02:41] } 8... d5 { [%clk 0:02:50] } 9. exd5 { [%clk 0:02:39] } 9... Nxd5 { [%clk 0:02:49] } 10. Qb3 { [%clk 0:02:30] } 10... Nce7 { [%clk 0:02:40] } 11. O-O { [%clk 0:02:25] } 11... O-O { [%clk 0:02:38] } 12. Rfe1 { [%clk 0:02:20] } 12... c6 { [%clk 0:02:10] } 1-0


"#;

const CHESS_COM: &str = "[Event \"Live Chess\"]\r\n[Site \"Chess.com\"]\r\n[Date \"2026.03.15\"]\r\n[Round \"-\"]\r\n[White \"PaperLantern\"]\r\n[Black \"tidewater_77\"]\r\n[Result \"0-1\"]\r\n[CurrentPosition \"rnb2rk1/p1p1qpp1/1p5p/3p4/3P3B/4PN2/PP3PPP/R2QKB1R w KQ - 0 11\"]\r\n[Timezone \"UTC\"]\r\n[ECO \"D55\"]\r\n[ECOUrl \"https://www.chess.com/openings/Queens-Gambit-Declined\"]\r\n[UTCDate \"2026.03.15\"]\r\n[UTCTime \"09:41:07\"]\r\n[WhiteElo \"1201\"]\r\n[BlackElo \"1244\"]\r\n[TimeControl \"600\"]\r\n[Termination \"tidewater_77 won by resignation\"]\r\n[StartTime \"09:41:07\"]\r\n[EndDate \"2026.03.15\"]\r\n[EndTime \"09:52:30\"]\r\n[Link \"https://www.chess.com/game/live/123456789\"]\r\n\r\n1. d4 {[%clk 0:09:58.7]} 1... d5 {[%clk 0:09:57.1]} 2. c4 {[%clk 0:09:55]} 2... e6 {[%clk 0:09:52.9]} 3. Nc3 {[%clk 0:09:50.2]} 3... Nf6 {[%clk 0:09:49]} 4. Bg5 {[%clk 0:09:40.4]} 4... Be7 {[%clk 0:09:45.6]} 5. e3 {[%clk 0:09:31.8]} 5... O-O {[%clk 0:09:40]} 6. Nf3 {[%clk 0:09:20.1]} 6... h6 {[%clk 0:09:35.5]} 7. Bh4 {[%clk 0:09:12]} 7... b6 {[%clk 0:09:30.3]} 8. cxd5 {[%clk 0:09:01.9]} 8... Nxd5 {[%clk 0:09:25]} 9. Bxe7 {[%clk 0:08:55.5]} 9... Qxe7 {[%clk 0:09:20.8]} 10. Nxd5 {[%clk 0:08:40.1]} 10... exd5 {[%clk 0:09:15]} 0-1\r\n\r\n";

#[test]
fn reads_a_lichess_export() {
    let game = only_game(LICHESS);

    assert_eq!(sans(&game), ITALIAN.split_whitespace().collect::<Vec<_>>());
    assert_eq!(
        ucis(&game),
        ITALIAN_UCI.split_whitespace().collect::<Vec<_>>()
    );

    let expected: Vec<Option<u64>> = [
        180, 180, 179, 178, 177, 177, 175, 176, 170, 175, 169, 174, 160, 173, 161, 170, 159, 169,
        150, 160, 145, 158, 140, 130,
    ]
    .iter()
    .map(|s| Some(s * 1000))
    .collect();
    assert_eq!(clocks(&game), expected);

    assert_eq!(game.result, Some(GameResult::WhiteWins));
    assert_eq!(game.variant, Variant::Standard);
    assert!(!game.from_position);
    assert_eq!(game.start_fen, INITIAL_FEN);
    assert_eq!(game.variations_skipped, 0);

    let tags = &game.tags;
    assert_eq!(tags.white.as_deref(), Some("quietfalcon"));
    assert_eq!(tags.black.as_deref(), Some("Mossy_Bishop"));
    assert_eq!(tags.site.as_deref(), Some("https://lichess.org/Qx7mWz2p"));
    assert_eq!(tags.game_id.as_deref(), Some("Qx7mWz2p"));
    assert_eq!(tags.utc_date.as_deref(), Some("2026.03.14"));
    assert_eq!(tags.utc_time.as_deref(), Some("18:02:11"));
    assert_eq!(tags.white_elo.as_deref(), Some("1612"));
    assert_eq!(tags.black_elo.as_deref(), Some("1590"));
    assert_eq!(tags.black_title.as_deref(), Some("BOT"));
    assert_eq!(tags.white_title, None);
    assert_eq!(tags.time_control.as_deref(), Some("180+2"));
    assert_eq!(tags.termination.as_deref(), Some("Normal"));
    assert_eq!(tags.variant.as_deref(), Some("Standard"));
    assert_eq!(tags.link, None);

    assert!(LICHESS[game.start..].starts_with("[Event \"Rated Blitz game\"]"));
    assert!(LICHESS[..game.end].ends_with("12... c6 { [%clk 0:02:10] } 1-0"));
}

#[test]
fn reads_a_chess_com_export() {
    let game = only_game(CHESS_COM);

    assert_eq!(
        sans(&game),
        QUEENS_GAMBIT.split_whitespace().collect::<Vec<_>>()
    );
    assert_eq!(game.moves[9].uci, "e8g8");

    assert_eq!(
        clocks(&game),
        vec![
            ms(0, 9, 58, 7),
            ms(0, 9, 57, 1),
            ms(0, 9, 55, 0),
            ms(0, 9, 52, 9),
            ms(0, 9, 50, 2),
            ms(0, 9, 49, 0),
            ms(0, 9, 40, 4),
            ms(0, 9, 45, 6),
            ms(0, 9, 31, 8),
            ms(0, 9, 40, 0),
            ms(0, 9, 20, 1),
            ms(0, 9, 35, 5),
            ms(0, 9, 12, 0),
            ms(0, 9, 30, 3),
            ms(0, 9, 1, 9),
            ms(0, 9, 25, 0),
            ms(0, 8, 55, 5),
            ms(0, 9, 20, 8),
            ms(0, 8, 40, 1),
            ms(0, 9, 15, 0),
        ]
    );

    assert_eq!(game.result, Some(GameResult::BlackWins));

    let tags = &game.tags;
    assert_eq!(tags.white.as_deref(), Some("PaperLantern"));
    assert_eq!(tags.black.as_deref(), Some("tidewater_77"));
    assert_eq!(tags.site.as_deref(), Some("Chess.com"));
    assert_eq!(
        tags.link.as_deref(),
        Some("https://www.chess.com/game/live/123456789")
    );
    assert_eq!(
        tags.termination.as_deref(),
        Some("tidewater_77 won by resignation")
    );
    assert_eq!(tags.start_time.as_deref(), Some("09:41:07"));
    assert_eq!(tags.time_control.as_deref(), Some("600"));
    assert_eq!(tags.game_id, None);
    assert_eq!(tags.variant, None);

    assert!(CHESS_COM[..game.end].ends_with("10... exd5 {[%clk 0:09:15]} 0-1"));
}

#[test]
fn many_games_with_text_before_and_between() {
    let text = format!("Here are my games from last week:\r\n\r\n{LICHESS}\n--- and one more ---\n{CHESS_COM}\nThat is all.\n");
    let out = read(&text);

    assert_eq!(out.unreadable, vec![]);
    assert_eq!(out.games.len(), 2);
    assert_eq!(out.games[0].tags.white.as_deref(), Some("quietfalcon"));
    assert_eq!(out.games[1].tags.white.as_deref(), Some("PaperLantern"));
    assert_eq!(out.games[1].moves.len(), 20);
}

#[test]
fn every_move_number_form_is_read() {
    let text = "[White \"a\"]\n\n1. e4 1... e5 2.Nf3 2...Nc6 3 Bc4 3...Bc5 4.c3 Nf6 5... *";
    let game = only_game(text);

    assert_eq!(
        sans(&game),
        ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"]
    );
    assert_eq!(game.result, Some(GameResult::Unfinished));
}

#[test]
fn tags_with_escapes_and_latin1() {
    let mut text = b"[White \"Ann \\\"Ace\\\" \\\\ Doe\"]\n[Black \"M".to_vec();
    text.push(0xFC);
    text.extend_from_slice(b"ller\"]\n[Event \"A ] bracket\"]\n\n1. e4 e5 *\n");

    let out = read_games(&text);
    assert_eq!(out.unreadable, vec![]);

    let tags = &out.games[0].tags;
    assert_eq!(tags.white.as_deref(), Some("Ann \"Ace\" \\ Doe"));
    assert_eq!(tags.black.as_deref(), Some("M\u{fc}ller"));
    assert_eq!(out.games[0].moves.len(), 2);
}

#[test]
fn utf8_names_stay_utf8() {
    let game = only_game("[White \"Zo\u{eb} \u{2654}\"]\n\n1. d4 *");
    assert_eq!(game.tags.white.as_deref(), Some("Zo\u{eb} \u{2654}"));
}

#[test]
fn tags_past_the_limit_are_counted_and_long_values_cut() {
    let mut text = String::new();
    for i in 0..MAX_TAGS {
        text.push_str(&format!("[Extra{i} \"x\"]\n"));
    }
    text.push_str("[White \"late\"]\n[Black \"late\"]\n");
    text.push_str(&format!("[Termination \"{}\"]\n", "z".repeat(300)));
    text.push_str("\n1. e4 *\n");

    let game = only_game(&text);
    assert_eq!(game.tags.white, None);
    assert_eq!(game.tags_dropped, 3);

    let long = format!("[Termination \"{}\"]\n\n1. e4 *", "\u{e9}".repeat(300));
    let game = only_game(&long);
    assert_eq!(
        game.tags.termination.unwrap().chars().count(),
        MAX_TAG_CHARS
    );
}

#[test]
fn a_tag_given_twice_keeps_the_first() {
    let game = only_game("[White \"first\"]\n[White \"second\"]\n\n1. e4 *");
    assert_eq!(game.tags.white.as_deref(), Some("first"));
}

#[test]
fn comments_variations_and_glyphs_are_skipped() {
    let text = "[White \"a\"]\n\n1. e4! $1 {best by test} (1. d4 d5 (1... Nf6 {a (nested) comment} 2. c4) 2. c4) 1... e5 ?! ; to the end of the line 2. Qh5\n2. Nf3 Nc6 !! 3. Bb5 $14 +- 3... a6 (3... Nf6 4. O-O) 1/2-1/2";
    let game = only_game(text);

    assert_eq!(sans(&game), ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
    assert_eq!(game.variations_skipped, 2);
    assert_eq!(game.result, Some(GameResult::Draw));
    assert_eq!(clocks(&game), vec![None; 6]);
}

#[test]
fn clocks_among_other_commands_and_text() {
    let text = "[White \"a\"]\n\n1. e4 { [%eval 0.25] [%clk 0:02:58] } 1... e5 {[%clk 0:02:59.9][%timestamp 12]} 2. Nf3 { quick [%clk 1:00:00] then [%clk 0:00:01] } 2... Nc6 {[%clk 0:00:00.25]} 3. Bc4 {[%clkx 0:01:00] [%clk 0:61:00] [%clk 0:01] [%clk 0:01:00 ]} 3... Bc5 ; [%clk 0:00:07]\n4. c3 { no clock } { [%clk 0:00:03] } *";
    let game = only_game(text);

    assert_eq!(
        clocks(&game),
        vec![
            Some(178_000),
            Some(179_900),
            Some(3_600_000),
            Some(250),
            Some(60_000),
            Some(7_000),
            Some(3_000),
        ]
    );
}

#[test]
fn a_clock_in_a_variation_or_before_the_first_move_is_not_taken() {
    let text = "[White \"a\"]\n\n{ [%clk 0:05:00] } 1. e4 (1. d4 { [%clk 0:04:00] }) 1... e5 { [%clk 0:02:00] } *";
    let game = only_game(text);

    assert_eq!(clocks(&game), vec![None, Some(120_000)]);
}

#[test]
fn each_result_is_read_from_the_marker_else_the_tag() {
    let text = "[R \"1\"]\n1. e4 1-0\n[R \"2\"]\n1. e4 0-1\n[R \"3\"]\n1. e4 1/2-1/2\n[R \"4\"]\n1. e4 *\n[R \"5\"]\n1. e4\n[R \"6\"]\n[Result \"0-1\"]\n1. e4\n";
    let out = read(text);

    let results: Vec<Option<GameResult>> = out.games.iter().map(|g| g.result).collect();
    assert_eq!(
        results,
        [
            Some(GameResult::WhiteWins),
            Some(GameResult::BlackWins),
            Some(GameResult::Draw),
            Some(GameResult::Unfinished),
            None,
            Some(GameResult::BlackWins),
        ]
    );
    assert_eq!(GameResult::Draw.as_str(), "1/2-1/2");
}

#[test]
fn escape_lines_bom_and_line_endings() {
    let lf = "[White \"a\"]\n%escaped line 1. h4\n\n1. e4 e5\n2. Nf3 *\n";
    let crlf = lf.replace('\n', "\r\n");
    let cr = lf.replace('\n', "\r");
    let bom = format!("\u{feff}{lf}");

    for text in [lf.to_string(), crlf, cr, bom] {
        let game = only_game(&text);
        assert_eq!(sans(&game), ["e4", "e5", "Nf3"], "{text:?}");
        assert_eq!(game.tags.white.as_deref(), Some("a"));
    }

    let comment_cr = "[White \"a\"]\r1. e4 ; a note\r1... e5 *";
    assert_eq!(sans(&only_game(comment_cr)), ["e4", "e5"]);
}

#[test]
fn castling_written_with_zeros_is_read() {
    let text = "[White \"a\"]\n\n1. e4 e5 2. Nf3 Nf6 3. Be2 Be7 4. 0-0 0-0 *";
    let game = only_game(text);

    assert_eq!(game.moves[6].san, "O-O");
    assert_eq!(game.moves[6].uci, "e1g1");
    assert_eq!(game.moves[7].uci, "e8g8");
}

#[test]
fn a_game_with_no_moves_is_read_with_no_moves() {
    let out = read("[White \"a\"]\n[Black \"b\"]\n\n*\n\n[White \"c\"]\n[Black \"d\"]\n");

    assert_eq!(out.unreadable, vec![]);
    assert_eq!(out.games.len(), 2);
    assert!(out.games.iter().all(|g| g.moves.is_empty()));
    assert_eq!(out.games[0].result, Some(GameResult::Unfinished));
    assert_eq!(out.games[1].result, None);
}

#[test]
fn a_game_cut_off_in_a_tag_is_unreadable_and_keeps_its_tags() {
    let text = format!("{LICHESS}[Event \"x\"]\n[White \"Ann\"]\n[Black \"Bo");
    let out = read(&text);

    assert_eq!(out.games.len(), 1);
    assert_eq!(out.unreadable.len(), 1);

    let cut = &out.unreadable[0];
    assert_eq!(cut.problem, Problem::CutOff { inside: "tag" });
    assert_eq!(cut.tags.white.as_deref(), Some("Ann"));
    assert_eq!(cut.end, text.len());
    assert!(text[cut.start..].starts_with("[Event \"x\"]"));
}

#[test]
fn a_game_cut_off_in_a_move_or_a_comment() {
    let out = read("[White \"a\"]\n\n1. e4 e5 2. N");
    assert_eq!(
        out.unreadable[0].problem,
        Problem::IllegalMove {
            ply: 3,
            move_number: 2,
            side: "white",
            text: "N".into()
        }
    );

    let out = read("[White \"a\"]\n\n1. e4 e5 2. Nf3 { [%clk 0:01");
    assert_eq!(
        out.unreadable[0].problem,
        Problem::CutOff { inside: "comment" }
    );

    let out = read("[White \"a\"]\n\n1. e4 e5 2. Nf3");
    assert_eq!(out.games[0].moves.len(), 3);
    assert_eq!(out.games[0].result, None);
}

#[test]
fn bare_moves_start_a_game_only_at_a_legal_first_move() {
    let game = only_game("Look at this: 1.e4 e5 2. Nf3 Nc6 *");
    assert_eq!(sans(&game), ["e4", "e5", "Nf3", "Nc6"]);
    assert_eq!(game.tags, Default::default());

    let out = read("Version 1.2 of my notes, see item 1. above.");
    assert_eq!(out, ReadText::default());
}

#[test]
fn a_set_up_position_game_is_read_from_its_fen() {
    let text = "[White \"a\"]\n[SetUp \"1\"]\n[FEN \"4k3/8/8/8/8/8/4P3/4K3 b - - 0 30\"]\n\n30... Kd7 31. e4 Ke6 32. Ke2 *";
    let game = only_game(text);

    assert!(game.from_position);
    assert_eq!(game.variant, Variant::Standard);
    assert_eq!(game.start_fen, "4k3/8/8/8/8/8/4P3/4K3 b - - 0 30");
    assert_eq!(sans(&game), ["Kd7", "e4", "Ke6", "Ke2"]);

    let from = only_game("[Variant \"From Position\"]\n[FEN \"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\"]\n\n1. e4 *");
    assert!(!from.from_position);
}

#[test]
fn a_bad_start_position_makes_the_game_unreadable() {
    let out = read("[FEN \"not a position\"]\n\n1. e4 *\n[Variant \"Chess960\"]\n\n1. e4 *");
    assert_eq!(out.games.len(), 0);
    assert!(matches!(
        out.unreadable[0].problem,
        Problem::BadStart { .. }
    ));
    assert_eq!(
        out.unreadable[1].problem,
        Problem::BadStart {
            why: "a Chess960 game needs a FEN tag".into()
        }
    );
}

#[test]
fn a_chess960_game_with_its_castling() {
    let text = "[Variant \"Chess960\"]\n[SetUp \"1\"]\n[FEN \"rkbbnnqr/pppppppp/8/8/8/8/PPPPPPPP/RKBBNNQR w KQkq - 0 1\"]\n\n1. b3 b6 2. Bb2 Bb7 3. e3 e6 4. Be2 Be7 5. O-O-O O-O-O *";
    let game = only_game(text);

    assert_eq!(game.variant, Variant::Chess960);
    assert!(!game.from_position);
    assert!(game.chess960_number.is_some());
    assert_eq!(game.moves[8].san, "O-O-O");
    assert_eq!(game.moves[8].uci, "b1a1");
    assert_eq!(game.moves[9].uci, "b8a8");
}

#[test]
fn other_variants_are_named_not_replayed() {
    let text = "[Variant \"Crazyhouse\"]\n[White \"a\"]\n\n1. e4 e5 2. Nf3 Nc6 *\n\n[Variant \"Standard\"]\n\n1. e4 *";
    let out = read(text);

    assert_eq!(out.games.len(), 1);
    assert_eq!(
        out.unreadable[0].problem,
        Problem::Variant {
            name: "Crazyhouse".into()
        }
    );
    assert_eq!(out.unreadable[0].tags.white.as_deref(), Some("a"));
}

#[test]
fn an_illegal_move_names_itself_and_the_others_load() {
    let text = "[White \"one\"]\n\n1. e4 e5 *\n\n[White \"two\"]\n\n1. e4 e5 2. Ke3 Nc6 *\n\n[White \"three\"]\n\n1. d4 d5 *\n";
    let out = read(text);

    let names: Vec<_> = out
        .games
        .iter()
        .map(|g| g.tags.white.as_deref().unwrap())
        .collect();
    assert_eq!(names, ["one", "three"]);

    let bad = &out.unreadable[0];
    assert_eq!(bad.tags.white.as_deref(), Some("two"));
    assert_eq!(
        bad.problem,
        Problem::IllegalMove {
            ply: 3,
            move_number: 2,
            side: "white",
            text: "Ke3".into()
        }
    );
    assert!(text[bad.start..bad.end].starts_with("[White \"two\"]"));
    assert!(text[bad.start..bad.end].ends_with("Nc6 *"));
}

#[test]
fn two_hundred_games_point_at_their_own_text() {
    let moves = numbered(ITALIAN);
    let mut text = String::new();

    for i in 0..200 {
        text.push_str(&format!(
            "[Event \"Casual\"]\n[White \"player{i:03}\"]\n[Black \"rival{i:03}\"]\n[Result \"1-0\"]\n\n{moves}1-0\n\n"
        ));
    }

    let out = read(&text);
    assert_eq!(out.unreadable, vec![]);
    assert_eq!(out.games.len(), 200);

    for (i, game) in out.games.iter().enumerate() {
        let own = &text[game.start..game.end];

        assert!(own.starts_with("[Event \"Casual\"]"), "game {i}");
        assert!(
            own.contains(&format!("[White \"player{i:03}\"]")),
            "game {i}"
        );
        assert!(own.ends_with("12. Rfe1 c6 1-0"), "game {i}");
        assert_eq!(game.moves.len(), 24);
    }
}

#[test]
fn a_million_brackets_never_recurse() {
    let mut text = String::from("[White \"deep\"]\n\n1. e4 ");
    text.push_str(&"(".repeat(1_000_000));
    text.push_str(" e5 *\n[White \"after\"]\n\n1. d4 *\n");

    let out = read(&text);
    assert_eq!(out.games.len(), 1);
    assert_eq!(
        out.unreadable[0].problem,
        Problem::CutOff {
            inside: "variation"
        }
    );
    assert_eq!(out.games[0].tags.white.as_deref(), Some("after"));

    let closing = format!("1. e4 {} e5 *", ")".repeat(1_000_000));
    assert_eq!(sans(&only_game(&closing)), ["e4", "e5"]);
}

#[test]
fn a_hostile_comment_never_reaches_a_move_a_tag_or_a_clock() {
    let text = "[White \"plain\"]\n\n1. e4 { [White \"Mallory\"]\n[Black \"Mallory\"] 2. Qh5 Qxf7# [%clk 9:99:99] [%clk -1:00:00] [%clk 0:01:00x] (((( 1-0 } 1... e5 { <script>alert(1)</script> %clk 0:00:01 ; [%clk] } 2. Nf3 *";
    let game = only_game(text);

    assert_eq!(sans(&game), ["e4", "e5", "Nf3"]);
    assert_eq!(clocks(&game), vec![None, None, None]);
    assert_eq!(game.tags.white.as_deref(), Some("plain"));
    assert_eq!(game.tags.black, None);
    assert_eq!(game.variations_skipped, 0);
    assert_eq!(game.result, Some(GameResult::Unfinished));
}

struct Noise(u64);

impl Noise {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn check_bounds(out: &ReadText, len: usize) {
    for g in &out.games {
        assert!(g.start <= g.end && g.end <= len);
    }
    for u in &out.unreadable {
        assert!(u.start <= u.end && u.end <= len);
    }
}

#[test]
fn random_bytes_never_panic() {
    let mut noise = Noise(0x9E37_79B9_7F4A_7C15);
    let bytes: Vec<u8> = (0..2_000_000).map(|_| noise.next() as u8).collect();

    let out = read_games(&bytes);
    check_bounds(&out, bytes.len());
}

#[test]
fn random_printable_text_never_panics() {
    const ALPHABET: &[u8] =
        b"abcdefghNBRQKO0-123456789x=+#!?.{}()[];$%\"\\ \n\r\t*/12345678abcdefgh[Event \"";

    let mut noise = Noise(0x2545_F491_4F6C_DD1D);
    let mut bytes: Vec<u8> = (0..2_000_000)
        .map(|_| ALPHABET[(noise.next() % ALPHABET.len() as u64) as usize])
        .collect();

    let out = read_games(&bytes);
    check_bounds(&out, bytes.len());

    let mut inside = b"[White \"x\"]\n\n".to_vec();
    inside.append(&mut bytes);
    let out = read_games(&inside);
    check_bounds(&out, inside.len());
}

#[test]
fn san_only_refuses_a_pawn_move_written_from_square_to_square() {
    let game = Game::standard();

    for text in ["e2e4", "b2b4", "e2e3"] {
        assert!(game.parse_san(text).is_err(), "{text:?} should be refused");
    }

    let out = read("1. e4 e5 2. g1f3 *");
    assert!(matches!(
        out.unreadable[0].problem,
        Problem::IllegalMove { ply: 3, .. }
    ));

    let out = read("1. e2e4 e5 *");
    assert_eq!(out, ReadText::default());

    let capture = Game::from_fen("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1", None).unwrap();
    assert!(capture.parse_san("e4xd5").is_ok());
    assert!(capture.parse_san("exd5").is_ok());
}

#[test]
fn a_refused_move_and_a_variant_name_repeat_only_printable_ascii() {
    let game = Game::standard();
    let message = game
        .parse_san("\u{202e}evil\u{7}\n[White \"x\"]")
        .unwrap_err()
        .to_string();
    assert!(message.contains(": evil[White \"x\"] is not"), "{message}");
    assert!(
        message.chars().all(|c| (' '..='~').contains(&c)),
        "{message}"
    );

    let out = read("[White \"a\"]\n\n1. e4 \u{202e}\u{1b}Zz9 *");
    assert_eq!(
        out.unreadable[0].problem,
        Problem::IllegalMove {
            ply: 2,
            move_number: 1,
            side: "black",
            text: "Zz9".into()
        }
    );

    let name = format!("{}\u{202e}", "x".repeat(300));
    let out = read(&format!("[Variant \"{name}\"]\n\n1. e4 *"));
    let Problem::Variant { name } = &out.unreadable[0].problem else {
        panic!("a variant: {:?}", out.unreadable[0].problem);
    };
    assert_eq!(name, &"x".repeat(40));
}

#[test]
fn a_variant_named_without_ascii_letters_is_not_standard_chess() {
    for name in ["\u{410}\u{442}\u{43e}\u{43c}", "???"] {
        let out = read(&format!("[Variant \"{name}\"]\n\n1. e4 e5 *"));

        assert_eq!(out.games.len(), 0, "{name}");
        assert!(matches!(out.unreadable[0].problem, Problem::Variant { .. }));
    }

    let blank = only_game("[Variant \"  \"]\n\n1. e4 e5 *");
    assert_eq!(blank.variant, Variant::Standard);
}

#[test]
fn a_set_up_position_with_too_much_material_is_read() {
    let text = "[White \"Ivo Brand\"]\n[Variant \"From Position\"]\n[FEN \"nnnnknnn/pppppppp/8/8/8/8/PPPPPPPP/NNNNKNNN w - - 0 1\"]\n\n1. Na3 Na6 2. Nf3 Nf6 1-0";
    let game = only_game(text);

    assert_eq!(game.variant, Variant::Standard);
    assert!(game.from_position);
    assert!(!game.chess960_castling);
    assert_eq!(sans(&game), ["Na3", "Na6", "Nf3", "Nf6"]);
}

#[test]
fn castling_rights_only_chess960_castling_can_hold_are_read_with_it() {
    let text = "[Variant \"From Position\"]\n[FEN \"r1k4r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1\"]\n\n1. O-O O-O 2. Kh1 Kh8 *";
    let game = only_game(text);

    assert_eq!(game.variant, Variant::Standard);
    assert!(game.from_position);
    assert!(game.chess960_castling);
    assert_eq!(game.moves[0].uci, "e1h1");
    assert_eq!(game.moves[1].uci, "c8h8");

    let start = "[FEN \"nrknbbqr/pppppppp/8/8/8/8/PPPPPPPP/NRKNBBQR w KQkq - 0 1\"]\n\n1. d3 d6 2. Bd2 Bd7 *";
    let game = only_game(start);

    assert_eq!(game.variant, Variant::Chess960);
    assert!(!game.from_position);
    assert!(game.chess960_castling);
    assert_eq!(game.moves[2].uci, "e1d2");
}

#[test]
fn a_chess960_start_with_a_pawn_moved_is_from_a_position() {
    let text = "[Variant \"Chess960\"]\n[FEN \"rkbbnnqr/pppppppp/8/8/8/1P6/P1PPPPPP/RKBBNNQR b KQkq - 0 1\"]\n\n1... b6 2. Bb2 *";
    let game = only_game(text);

    assert_eq!(game.variant, Variant::Chess960);
    assert!(game.from_position);
    assert!(game.chess960_number.is_some());
}

#[test]
fn an_unclosed_variation_makes_the_game_unreadable() {
    let out = read("[Result \"1-0\"]\n\n1. e4 ( e5 2. Nf3 Nc6 3. Bb5 1-0");

    assert_eq!(out.games.len(), 0);
    assert_eq!(
        out.unreadable[0].problem,
        Problem::CutOff {
            inside: "variation"
        }
    );
}

#[test]
fn a_command_in_brackets_among_the_moves_is_a_comment() {
    let game = only_game(
        "[Result \"1-0\"]\n\n1. e4 [%clk 0:03:00] e5 [%eval 0.2] 2. Nf3 [ junk ] 2... Nc6 1-0",
    );

    assert_eq!(sans(&game), ["e4", "e5", "Nf3", "Nc6"]);
    assert_eq!(clocks(&game)[0], ms(0, 3, 0, 0));
}

#[test]
fn a_comment_between_two_tags_keeps_one_game() {
    let out = read("[White \"a\"]\n{ note }\n; a line\n[Black \"b\"]\n1. e4 e5 1-0");

    assert_eq!(out.unreadable, vec![]);
    assert_eq!(out.games.len(), 1);
    assert_eq!(out.games[0].tags.white.as_deref(), Some("a"));
    assert_eq!(out.games[0].tags.black.as_deref(), Some("b"));
    assert_eq!(out.games[0].moves.len(), 2);
}

#[test]
fn no_break_spaces_and_the_short_draw_marks_read() {
    let game = only_game("1.\u{a0}e4\u{a0}e5\u{a0}2.\u{a0}Nf3 Nc6 1/2");
    assert_eq!(sans(&game), ["e4", "e5", "Nf3", "Nc6"]);
    assert_eq!(game.result, Some(GameResult::Draw));

    let game = only_game("[White \"a\"]\n\n1. e4 e5 \u{bd}-\u{bd}");
    assert_eq!(game.result, Some(GameResult::Draw));
}

#[test]
fn utf16_text_is_named() {
    assert!(is_utf16(b"\xFF\xFE[\x00W\x00"));
    assert!(is_utf16(b"\xFE\xFF\x00["));
    assert!(!is_utf16(b"\xEF\xBB\xBF[White"));
    assert!(!is_utf16(b"[White"));
}

#[test]
fn a_clock_needs_two_digit_minutes_and_seconds_and_at_most_four_hour_digits() {
    let text = "1. e4 {[%clk 1:2:3]} e5 {[%clk 99999:00:00]} 2. Nf3 {[%clk 9999:59:59]} Nc6 {[%clk 0:05:07]} *";
    let game = only_game(text);

    assert_eq!(
        clocks(&game),
        [None, None, ms(9999, 59, 59, 0), ms(0, 5, 7, 0)]
    );
}

#[test]
fn the_final_position_is_reported() {
    let mate = only_game("1. f3 e5 2. g4 Qh4# 0-1");
    assert!(mate.last.checkmate);
    assert_eq!(mate.last.repetition, 1);

    let shuffle = only_game("1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2");
    assert!(!shuffle.last.checkmate);
    assert_eq!(shuffle.last.repetition, 3);

    let bare = only_game("[FEN \"4k3/8/8/8/8/8/8/4K3 w - - 0 1\"]\n\n1. Kd2 Kd7 1/2-1/2");
    assert!(bare.last.insufficient_material);
}

#[test]
fn reading_stops_when_the_caller_says_so() {
    let text = "1. e4 e5 *\n\n1. d4 d5 *\n\n1. c4 c5 *";
    let mut seen = 0;

    read_each(text.as_bytes(), usize::MAX, |_| {
        seen += 1;
        ControlFlow::Break(())
    });
    assert_eq!(seen, 1);
}
