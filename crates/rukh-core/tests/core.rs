use rukh_core::{chess960, Arrow, Error, Eval, Game, Highlight, Variant, INITIAL_FEN};
use shakmaty::perft;

const KIWIPETE: &str = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";

fn play_all(game: &mut Game, moves: &str) {
    for m in moves.split_whitespace() {
        game.play(m).unwrap_or_else(|e| panic!("{m}: {e}"));
    }
}

#[test]
fn perft_start_position() {
    let game = Game::standard();

    assert_eq!(perft(game.position(), 1), 20);
    assert_eq!(perft(game.position(), 2), 400);
    assert_eq!(perft(game.position(), 3), 8902);
    assert_eq!(perft(game.position(), 4), 197_281);
}

#[test]
fn perft_kiwipete() {
    let game = Game::from_fen(KIWIPETE, None).unwrap();
    assert_eq!(game.variant(), Variant::Standard);

    assert_eq!(perft(game.position(), 1), 48);
    assert_eq!(perft(game.position(), 2), 2039);
    assert_eq!(perft(game.position(), 3), 97_862);
}

#[test]
fn perft_cpw_positions_3_to_5() {
    let p3 = Game::from_fen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", None).unwrap();
    assert_eq!(perft(p3.position(), 4), 43_238);

    let p4 = Game::from_fen(
        "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
        None,
    )
    .unwrap();
    assert_eq!(perft(p4.position(), 3), 9467);

    let p5 = Game::from_fen(
        "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
        None,
    )
    .unwrap();
    assert_eq!(perft(p5.position(), 3), 62_379);
}

#[test]
fn every_chess960_start_loads_and_round_trips_its_number() {
    for n in 0..960u16 {
        let game = Game::chess960(n).unwrap_or_else(|e| panic!("#{n}: {e}"));

        assert_eq!(game.variant(), Variant::Chess960);
        assert_eq!(game.chess960_number(), Some(n));
        assert_eq!(chess960::number_of(game.start_fen()), Some(n), "#{n}");
        assert_eq!(game.legal_moves().len(), perft(game.position(), 1) as usize);
    }

    assert_eq!(
        chess960::back_rank(chess960::STANDARD).as_deref(),
        Some("rnbqkbnr")
    );
    assert!(chess960::back_rank(960).is_none());
    assert!(Game::chess960(960).is_err());
}

#[test]
fn chess960_518_has_the_same_moves_as_standard() {
    let a = Game::chess960(518).unwrap();
    let b = Game::standard();

    assert_eq!(perft(a.position(), 3), perft(b.position(), 3));
}

#[test]
fn plays_san_and_uci_and_reports_what_happened() {
    let mut game = Game::standard();

    let e4 = game.play("e4").unwrap();
    assert_eq!(
        (e4.san.as_str(), e4.uci.as_str(), e4.reused),
        ("e4", "e2e4", false)
    );

    let e5 = game.play("e7e5").unwrap();
    assert_eq!(e5.san, "e5");

    play_all(&mut game, "Nf3 Nc6 Bb5 a6");
    let take = game.play("Bxc6").unwrap();
    assert_eq!(take.captured, Some("knight"));

    assert_eq!(game.turn(), "black");
    assert_eq!(
        game.history(),
        ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6"]
    );
    assert_eq!(game.current_node().ply, 7);
}

#[test]
fn an_illegal_move_is_refused_and_changes_nothing() {
    let mut game = Game::standard();

    for bad in ["e5", "e2e5", "Nf6", "O-O", "", "hello", "e1g1"] {
        match game.play(bad) {
            Err(Error::IllegalMove(_)) => {}
            other => panic!("{bad:?} should be illegal, got {other:?}"),
        }
    }

    assert_eq!(game.fen(), INITIAL_FEN);
    assert_eq!(game.node_count(), 1);
}

#[test]
fn castling_is_accepted_in_every_spelling() {
    let fen = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1";

    for (text, side, uci) in [
        ("O-O", "king", "e1g1"),
        ("0-0", "king", "e1g1"),
        ("e1g1", "king", "e1g1"),
        ("e1h1", "king", "e1g1"),
        ("O-O-O", "queen", "e1c1"),
        ("e1a1", "queen", "e1c1"),
    ] {
        let mut game = Game::from_fen(fen, None).unwrap();
        let played = game.play(text).unwrap_or_else(|e| panic!("{text}: {e}"));

        assert_eq!(played.castle, Some(side), "{text}");
        assert_eq!(played.uci, uci, "{text}");
    }
}

#[test]
fn chess960_castling_is_written_king_to_rook() {
    // #518 is the classical arrangement, played as Chess960.
    let mut game = Game::chess960(518).unwrap();
    play_all(&mut game, "e4 e5 Nf3 Nf6 Bc4 Bc5");

    let played = game.play("O-O").unwrap();
    assert_eq!(played.castle, Some("king"));
    assert_eq!(played.uci, "e1h1");

    // The king-to-destination spelling is still accepted on the way in.
    assert!(game.back());
    assert!(game.play("e1g1").unwrap().reused);

    // #0 is bbqnnrkr: short castling is blocked by the other rook on f1.
    let mut blocked = Game::chess960(0).unwrap();
    assert_eq!(blocked.start_fen().split('/').next(), Some("bbqnnrkr"));

    play_all(&mut blocked, "g3 g6");
    assert!(blocked.play("O-O").is_err());
}

#[test]
fn promotion_defaults_to_a_queen_and_accepts_other_pieces() {
    let fen = "8/P6k/8/8/8/8/8/K7 w - - 0 1";

    let mut game = Game::from_fen(fen, None).unwrap();
    let q = game.play("a7a8").unwrap();
    assert_eq!((q.promotion, q.san.as_str()), (Some("queen"), "a8=Q"));

    for (text, role) in [
        ("a8=N", "knight"),
        ("a8R", "rook"),
        ("a7a8b", "bishop"),
        ("A7A8Q", "queen"),
    ] {
        let mut game = Game::from_fen(fen, None).unwrap();
        assert_eq!(game.play(text).unwrap().promotion, Some(role), "{text}");
    }
}

#[test]
fn en_passant_reports_the_pawn_it_took() {
    let mut game = Game::standard();
    play_all(&mut game, "e4 a6 e5 d5");

    let ep = game.play("exd6").unwrap();
    assert!(ep.en_passant);
    assert_eq!(ep.captured, Some("pawn"));
}

#[test]
fn checkmate_stalemate_and_draws_are_named() {
    let mut game = Game::standard();
    play_all(&mut game, "f3 e5 g4");

    let mate = game.play("Qh4").unwrap();
    assert!(mate.checkmate);
    assert_eq!(mate.san, "Qh4#");

    let s = game.status();
    assert_eq!((s.reason, s.outcome), ("checkmate", Some("0-1")));
    assert!(game.legal_moves().is_empty());

    let stale = Game::from_fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", None)
        .unwrap()
        .status();
    assert_eq!(
        (stale.reason, stale.outcome),
        ("stalemate", Some("1/2-1/2"))
    );

    let bare = Game::from_fen("7k/8/6K1/8/8/8/8/8 w - - 0 1", None)
        .unwrap()
        .status();
    assert_eq!(bare.reason, "insufficient material");

    let fifty = Game::from_fen("7k/8/6K1/8/8/8/8/R7 w - - 100 80", None)
        .unwrap()
        .status();
    assert_eq!(fifty.reason, "fifty-move rule");

    let check = Game::from_fen("4k3/8/8/8/8/8/8/4RK2 b - - 0 1", None)
        .unwrap()
        .status();
    assert_eq!((check.reason, check.outcome), ("check", None));
}

#[test]
fn threefold_repetition_is_counted_along_the_line_played() {
    let mut game = Game::standard();

    play_all(&mut game, "Nf3 Nf6 Ng1 Ng8");
    assert_eq!(game.status().repetition, 2);
    assert_eq!(game.status().reason, "playing");

    play_all(&mut game, "Nf3 Nf6 Ng1 Ng8");
    let s = game.status();
    assert_eq!(
        (s.repetition, s.reason, s.outcome),
        (3, "threefold repetition", Some("1/2-1/2"))
    );
}

#[test]
fn a_bad_start_position_says_why() {
    assert!(matches!(
        Game::from_fen("", None),
        Err(Error::InvalidFen(_))
    ));
    assert!(matches!(
        Game::from_fen("not a fen", None),
        Err(Error::InvalidFen(_))
    ));
    assert!(matches!(
        Game::from_fen("8/8/8/8/8/8/8/8 w - - 0 1", None),
        Err(Error::IllegalPosition(_))
    ));
}

#[test]
fn a_fen_from_mid_game_keeps_its_move_number() {
    let game = Game::from_fen(
        "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
        None,
    )
    .unwrap();

    assert_eq!(game.current_node().ply, 5);
    assert_eq!(game.turn(), "black");
}

#[test]
fn replaying_a_move_reuses_it_and_a_different_move_branches() {
    let mut game = Game::standard();
    play_all(&mut game, "e4 e5 Nf3");
    let nf3 = game.current();

    assert!(game.back());
    let again = game.play("g1f3").unwrap();
    assert!(again.reused);
    assert_eq!(again.node, nf3);

    assert!(game.back());
    let bc4 = game.play("Bc4").unwrap();
    assert!(!bc4.reused);
    assert_eq!(game.node_count(), 5);

    let e5 = game.node(bc4.node).unwrap().parent.unwrap();
    assert_eq!(game.node(e5).unwrap().children, [nf3, bc4.node]);
    assert_eq!(game.mainline().last(), Some(&nf3));

    assert!(game.promote_variation(bc4.node).unwrap());
    assert_eq!(game.node(e5).unwrap().children, [bc4.node, nf3]);
    assert_eq!(game.mainline().last(), Some(&bc4.node));
    assert!(!game.promote_variation(0).unwrap());
}

#[test]
fn navigation_walks_the_main_line() {
    let mut game = Game::standard();
    play_all(&mut game, "d4 d5 c4");
    let end = game.current();

    game.to_start();
    assert_eq!(game.current(), 0);
    assert_eq!(game.fen(), INITIAL_FEN);
    assert!(!game.back());

    assert!(game.forward());
    assert_eq!(game.history(), ["d4"]);

    game.to_end();
    assert_eq!(game.current(), end);
    assert!(!game.forward());
    assert!(matches!(game.goto(999), Err(Error::UnknownNode(999))));

    // After a jump, moves are judged in the position jumped to.
    game.goto(game.path()[1]).unwrap();
    assert_eq!(game.turn(), "black");
    assert!(game.play("Nf6").is_ok());
}

#[test]
fn deleting_a_line_moves_the_game_out_of_it() {
    let mut game = Game::standard();
    play_all(&mut game, "e4 e5 Nf3 Nc6");

    let path = game.path();
    let (e5, nf3) = (path[2], path[3]);

    assert_eq!(game.delete_from(nf3).unwrap(), e5);
    assert_eq!(game.current(), e5);
    assert_eq!(game.node_count(), 3);
    assert!(game.node(nf3).is_none());
    assert!(game.node(e5).unwrap().children.is_empty());
    assert!(
        game.play("Nf3").is_ok(),
        "the position after a delete is the parent's"
    );

    // Deleting a line the game is not in leaves the game where it is.
    game.to_start();
    assert_eq!(game.delete_from(e5).unwrap(), 0);
    assert_eq!(game.node_count(), 2);

    game.to_end();
    assert_eq!(game.delete_from(0).unwrap(), 0);
    assert_eq!(game.node_count(), 1);
    assert_eq!(game.fen(), INITIAL_FEN);
    assert!(matches!(game.delete_from(e5), Err(Error::UnknownNode(_))));
}

fn arrow(from: &str, to: &str, color: &str, source: Option<&str>) -> Arrow {
    Arrow {
        from: from.into(),
        to: to.into(),
        color: color.into(),
        knight: false,
        source: source.map(Into::into),
    }
}

#[test]
fn notes_glyphs_and_drawings_attach_to_a_node() {
    let mut game = Game::standard();
    let id = game.play("Nf3").unwrap().node;

    game.set_note(id, "Develops and eyes e5.").unwrap();
    game.set_nag(id, "!").unwrap();
    assert!(matches!(game.set_nag(id, "good"), Err(Error::BadInput(_))));

    game.set_arrows(
        id,
        &[
            arrow("g1", "f3", "green", Some("ai")),
            arrow("c4", "f7", "purple", Some("someone")),
            arrow("z9", "f7", "red", None),
            arrow("e4", "e4", "red", None),
        ],
    )
    .unwrap();

    game.set_highlights(
        id,
        &[
            Highlight {
                square: "e5".into(),
                color: "red".into(),
            },
            Highlight {
                square: "x1".into(),
                color: "red".into(),
            },
        ],
    )
    .unwrap();

    let node = game.node(id).unwrap();
    assert_eq!(node.note, "Develops and eyes e5.");
    assert_eq!(node.nag, "!");
    assert_eq!(node.arrows.len(), 2, "arrows with bad squares are dropped");
    assert!(node.arrows[0].knight, "g1 to f3 is a knight's jump");
    assert_eq!(node.arrows[0].source.as_deref(), Some("ai"));
    assert_eq!(
        node.arrows[1].color, "green",
        "an unknown colour falls back to green"
    );
    assert_eq!(node.arrows[1].source, None, "an unknown source is dropped");
    assert_eq!(node.highlights.len(), 1);

    game.set_nag(id, "").unwrap();
    assert_eq!(game.node(id).unwrap().nag, "");
    assert!(matches!(
        game.set_note(999, "x"),
        Err(Error::UnknownNode(999))
    ));
}

#[test]
fn an_eval_needs_a_score() {
    let mut game = Game::standard();
    let eval = |cp, mate| Eval {
        cp,
        mate,
        depth: 20,
        pv: vec!["e2e4".into()],
        best: Some("e2e4".into()),
    };

    game.set_eval(0, Some(eval(Some(35), None))).unwrap();
    assert_eq!(game.node(0).unwrap().eval.as_ref().unwrap().cp, Some(35));

    game.set_eval(0, Some(eval(Some(900), Some(3)))).unwrap();
    let stored = game.node(0).unwrap().eval.clone().unwrap();
    assert_eq!(
        (stored.cp, stored.mate),
        (None, Some(3)),
        "a mate score replaces centipawns"
    );

    game.set_eval(0, Some(eval(None, None))).unwrap();
    assert!(game.node(0).unwrap().eval.is_none());
}

#[test]
fn the_snapshot_carries_the_whole_game_as_json() {
    let mut game = Game::standard();
    play_all(&mut game, "e4 c5");

    let json = serde_json::to_value(game.snapshot()).unwrap();
    assert_eq!(json["variant"], "standard");
    assert_eq!(json["turn"], "white");
    assert_eq!(json["ply"], 2);
    assert_eq!(json["path"], serde_json::json!([0, 1, 2]));
    assert_eq!(json["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(json["nodes"][2]["san"], "c5");
    assert_eq!(json["status"]["reason"], "playing");
    assert_eq!(
        json["legal_moves"].as_array().unwrap().len(),
        game.legal_moves().len()
    );
}
