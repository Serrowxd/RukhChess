//! Chess960 (Fischer Random) start positions, Scharnagl numbering.

/// The Scharnagl number of the classical start position (RNBQKBNR).
pub const STANDARD: u16 = 518;

// Knight placements among the five free squares (the N5N table).
const KNIGHT_TABLE: [(usize, usize); 10] = [
    (0, 1),
    (0, 2),
    (0, 3),
    (0, 4),
    (1, 2),
    (1, 3),
    (1, 4),
    (2, 3),
    (2, 4),
    (3, 4),
];

fn free_squares(row: &[u8; 8]) -> Vec<usize> {
    (0..8).filter(|&i| row[i] == 0).collect()
}

/// Back rank for Scharnagl number `n` (0..=959), lower-case, file a first.
pub fn back_rank(n: u16) -> Option<String> {
    if n > 959 {
        return None;
    }

    let mut row = [0u8; 8];
    let mut k = n as usize;

    // Light-square bishop: files b, d, f, h.
    row[(k % 4) * 2 + 1] = b'b';
    k /= 4;

    // Dark-square bishop: files a, c, e, g.
    row[(k % 4) * 2] = b'b';
    k /= 4;

    let q = k % 6;
    k /= 6;
    row[free_squares(&row)[q]] = b'q';

    let (n1, n2) = KNIGHT_TABLE[k];
    let free = free_squares(&row);
    row[free[n1]] = b'n';
    row[free[n2]] = b'n';

    // Rook, king, rook in that order, so the king sits between the rooks.
    let rest = free_squares(&row);
    row[rest[0]] = b'r';
    row[rest[1]] = b'k';
    row[rest[2]] = b'r';

    Some(String::from_utf8_lossy(&row).into_owned())
}

/// Full FEN for Scharnagl number `n`, with Shredder castling letters (the rook files).
pub fn fen(n: u16) -> Option<String> {
    let black = back_rank(n)?;
    let white = black.to_uppercase();

    let files = b"abcdefgh";
    let rooks: Vec<u8> = black
        .bytes()
        .enumerate()
        .filter(|(_, c)| *c == b'r')
        .map(|(i, _)| files[i])
        .collect();

    // King side first, then queen side (h before a in the classical case).
    let (queen_side, king_side) = (rooks[0] as char, rooks[1] as char);
    let castling = format!(
        "{}{}{}{}",
        king_side.to_ascii_uppercase(),
        queen_side.to_ascii_uppercase(),
        king_side,
        queen_side
    );

    Some(format!(
        "{black}/pppppppp/8/8/8/8/PPPPPPPP/{white} w {castling} - 0 1"
    ))
}

/// The Scharnagl number matching ranks 8 and 1 of this FEN, when both sides mirror each other.
pub fn number_of(fen: &str) -> Option<u16> {
    let board = fen.split_whitespace().next()?;
    let ranks: Vec<&str> = board.split('/').collect();
    if ranks.len() != 8 {
        return None;
    }

    let (top, bottom) = (ranks[0], ranks[7]);
    if top.len() != 8
        || bottom.len() != 8
        || top != bottom.to_lowercase()
        || bottom != bottom.to_uppercase()
    {
        return None;
    }

    (0..960).find(|&i| back_rank(i).as_deref() == Some(top))
}
