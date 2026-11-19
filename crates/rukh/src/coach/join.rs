//! Reads a text and hands its games to the coach, dropping skipped ones at once.

use std::ops::ControlFlow;

use rukh_coach::batch::MAX_GAMES_PER_TEXT;
use rukh_coach::ending::FinalPosition;
use rukh_coach::skip::{skip_of, Skip, Skipped, MAX_PLIES};
use rukh_coach::text::{TextGame, TextMove, TextTags, Variant};
use rukh_core::pgn::{read_each, FinalStatus, Item, KeptTags, Problem, ReadGame};

use super::store::Failure;

/// The games of a text worth keeping, and a count of the others by reason.
pub fn read_text(bytes: &[u8]) -> Result<(Vec<TextGame>, Skipped), Failure> {
    let mut games = Vec::new();
    let mut skipped = Skipped::default();
    let mut seen = false;
    let mut too_many = false;

    read_each(bytes, MAX_PLIES, |item| {
        seen = true;

        match kept(item) {
            Ok(_) if games.len() >= MAX_GAMES_PER_TEXT => {
                too_many = true;
                return ControlFlow::Break(());
            }
            Ok(game) => games.push(game),
            Err(skip) => skipped.add(skip),
        }
        ControlFlow::Continue(())
    });

    if too_many {
        return Err(Failure::TooManyGames);
    }
    if !seen {
        return Err(Failure::NoGames);
    }

    Ok((games, skipped))
}

fn kept(item: Item) -> Result<TextGame, Skip> {
    let game = match item {
        Item::Unreadable(bad) => {
            return Err(match bad.problem {
                Problem::Variant { .. } => Skip::Variant,
                _ => Skip::Unreadable,
            });
        }
        Item::Game(game) => game,
    };

    if game.too_long {
        return Err(Skip::TooLong);
    }

    let game = text_game(game);
    match skip_of(&game) {
        Some(skip) => Err(skip),
        None => Ok(game),
    }
}

fn tags(kept: KeptTags) -> TextTags {
    TextTags {
        site: kept.site,
        link: kept.link,
        game_id: kept.game_id,
        white: kept.white,
        black: kept.black,
        white_elo: kept.white_elo,
        black_elo: kept.black_elo,
        white_title: kept.white_title,
        black_title: kept.black_title,
        time_control: kept.time_control,
        termination: kept.termination,
        utc_date: kept.utc_date,
        utc_time: kept.utc_time,
        date: kept.date,
    }
}

fn final_position(last: FinalStatus) -> FinalPosition {
    FinalPosition {
        checkmate: last.checkmate,
        stalemate: last.stalemate,
        insufficient: last.insufficient_material,
        repetition: last.repetition >= 3,
        fifty_move: last.fifty_moves,
    }
}

fn text_game(game: ReadGame) -> TextGame {
    let variant = match game.variant {
        rukh_core::Variant::Standard => Variant::Standard,
        rukh_core::Variant::Chess960 => Variant::Chess960,
    };

    let moves = game
        .moves
        .into_iter()
        .map(|m| TextMove {
            san: m.san,
            uci: m.uci,
            clock_ms: m.clock_ms,
        })
        .collect();

    TextGame {
        tags: tags(game.tags),
        variant,
        start_fen: game.start_fen,
        from_position: game.from_position,
        chess960_castling: game.chess960_castling,
        moves,
        result: game.result.map(|r| r.as_str().to_string()),
        last: final_position(game.last),
        start: game.start,
        end: game.end,
    }
}
