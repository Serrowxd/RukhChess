//! Reads game text (PGN) as sites export it and as people paste it.

use std::ops::ControlFlow;

use serde::Serialize;
use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
use shakmaty::uci::UciMove;
use shakmaty::{Bitboard, Board, CastlingMode, Chess, Color, EnPassantMode, Position, Square};

use crate::{chess960, make_fen, san_move, shown_text, Variant, INITIAL_FEN};

/// Tags read from one game; any after these are counted and ignored.
pub const MAX_TAGS: usize = 64;

/// A tag value is cut to this many characters.
pub const MAX_TAG_CHARS: usize = 255;

const MAX_TAG_NAME_BYTES: usize = 64;

/// Room for the longest UTF-8 value that still cuts to the character limit.
const MAX_TAG_VALUE_BYTES: usize = MAX_TAG_CHARS * 4;

const MAX_SHOWN_VARIANT_CHARS: usize = 40;

/// Daily games reach three digits of hours.
const MAX_CLOCK_HOUR_DIGITS: usize = 4;

const BYTE_ORDER_MARK: &[u8] = b"\xEF\xBB\xBF";

const NO_BREAK_SPACE: &[u8] = b"\xC2\xA0";

const HALF_DRAW: &[u8] = "\u{bd}-\u{bd}".as_bytes();

const GLYPH_TOKENS: [&[u8]; 16] = [
    b"!", b"?", b"!!", b"??", b"!?", b"?!", b"+-", b"-+", b"+/-", b"-/+", b"+=", b"=+", b"+/=",
    b"=/+", b"=", b"~",
];

/// The kept tags, as written (cut, not cleaned). A tag given twice keeps its first value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct KeptTags {
    pub site: Option<String>,
    pub date: Option<String>,
    pub utc_date: Option<String>,
    pub utc_time: Option<String>,
    pub start_time: Option<String>,
    pub white: Option<String>,
    pub black: Option<String>,
    pub white_elo: Option<String>,
    pub black_elo: Option<String>,
    pub white_title: Option<String>,
    pub black_title: Option<String>,
    pub time_control: Option<String>,
    pub result: Option<String>,
    pub termination: Option<String>,
    pub link: Option<String>,
    pub game_id: Option<String>,
    pub variant: Option<String>,
    pub set_up: Option<String>,
    pub fen: Option<String>,
}

impl KeptTags {
    fn slot(&mut self, name: &str) -> Option<&mut Option<String>> {
        Some(match name {
            "Site" => &mut self.site,
            "Date" => &mut self.date,
            "UTCDate" => &mut self.utc_date,
            "UTCTime" => &mut self.utc_time,
            "StartTime" => &mut self.start_time,
            "White" => &mut self.white,
            "Black" => &mut self.black,
            "WhiteElo" => &mut self.white_elo,
            "BlackElo" => &mut self.black_elo,
            "WhiteTitle" => &mut self.white_title,
            "BlackTitle" => &mut self.black_title,
            "TimeControl" => &mut self.time_control,
            "Result" => &mut self.result,
            "Termination" => &mut self.termination,
            "Link" => &mut self.link,
            "GameId" => &mut self.game_id,
            "Variant" => &mut self.variant,
            "SetUp" => &mut self.set_up,
            "FEN" => &mut self.fen,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum GameResult {
    #[serde(rename = "1-0")]
    WhiteWins,
    #[serde(rename = "0-1")]
    BlackWins,
    #[serde(rename = "1/2-1/2")]
    Draw,
    #[serde(rename = "*")]
    Unfinished,
}

impl GameResult {
    pub fn as_str(self) -> &'static str {
        match self {
            GameResult::WhiteWins => "1-0",
            GameResult::BlackWins => "0-1",
            GameResult::Draw => "1/2-1/2",
            GameResult::Unfinished => "*",
        }
    }

    /// Exactly one of the four results, nothing around it.
    pub fn from_text(text: &str) -> Option<GameResult> {
        GameResult::from_bytes(text.as_bytes())
    }

    fn from_bytes(text: &[u8]) -> Option<GameResult> {
        match text {
            b"1-0" => Some(GameResult::WhiteWins),
            b"0-1" => Some(GameResult::BlackWins),
            b"1/2-1/2" => Some(GameResult::Draw),
            b"*" => Some(GameResult::Unfinished),
            _ => None,
        }
    }

    /// The four results, and the draw as people also write it after the moves.
    fn from_marker(token: &[u8]) -> Option<GameResult> {
        if token == b"1/2" || token == HALF_DRAW {
            return Some(GameResult::Draw);
        }

        GameResult::from_bytes(token)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadMove {
    /// With `+` or `#`, as the rules write it.
    pub san: String,
    /// Castling is king-to-rook when [`ReadGame::chess960_castling`] is set.
    pub uci: String,
    /// The mover's clock after the move, in milliseconds, when a `%clk` gave one.
    pub clock_ms: Option<u64>,
}

/// How the position after the last move stands.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct FinalStatus {
    pub checkmate: bool,
    pub stalemate: bool,
    pub insufficient_material: bool,
    pub fifty_moves: bool,
    /// How many times the final position has stood, itself included.
    pub repetition: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadGame {
    /// Byte offset of the game's first tag (or first move number) in the input.
    pub start: usize,
    /// Byte offset just past the game's last token.
    pub end: usize,
    pub tags: KeptTags,
    pub variant: Variant,
    /// The position the moves were replayed from.
    pub start_fen: String,
    /// True when the start is not the variant's own start position.
    pub from_position: bool,
    pub chess960_number: Option<u16>,
    /// Castling is Chess960 castling: a Chess960 game, or a set-up position whose rights need it.
    pub chess960_castling: bool,
    /// Empty when the game is [`ReadGame::too_long`].
    pub moves: Vec<ReadMove>,
    /// The main line had more moves than the reader was asked to replay.
    pub too_long: bool,
    /// The marker at the end of the moves, else the `Result` tag.
    pub result: Option<GameResult>,
    /// Default when the game is too long.
    pub last: FinalStatus,
    pub variations_skipped: u32,
    /// Tags past [`MAX_TAGS`].
    pub tags_dropped: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Problem {
    /// An unknown `Variant` tag, in printable ASCII.
    Variant { name: String },
    /// The `FEN` tag is missing for Chess960, unreadable, or breaks the rules.
    BadStart { why: String },
    /// `ply` counts from 1 at the game's first move; `text` is printable ASCII only.
    IllegalMove {
        ply: u32,
        move_number: u32,
        side: &'static str,
        text: String,
    },
    /// The game ends inside a tag, a comment or a variation: `tag`, `comment` or `variation`.
    CutOff { inside: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Unreadable {
    pub start: usize,
    pub end: usize,
    pub tags: KeptTags,
    pub problem: Problem,
}

/// One game of the text, handed over as soon as it is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Game(ReadGame),
    Unreadable(Unreadable),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ReadText {
    pub games: Vec<ReadGame>,
    pub unreadable: Vec<Unreadable>,
}

/// Reads every game in the text, replaying any number of moves. Never panics.
pub fn read_games(input: &[u8]) -> ReadText {
    let mut out = ReadText::default();

    read_each(input, usize::MAX, |item| {
        match item {
            Item::Game(game) => out.games.push(game),
            Item::Unreadable(bad) => out.unreadable.push(bad),
        }
        ControlFlow::Continue(())
    });

    out
}

/// Hands each game to `each` as it is read; a game past `most_plies` moves is marked too long.
pub fn read_each(input: &[u8], most_plies: usize, each: impl FnMut(Item) -> ControlFlow<()>) {
    let floor = if input.starts_with(BYTE_ORDER_MARK) {
        BYTE_ORDER_MARK.len()
    } else {
        0
    };

    let mut reader = Reader {
        bytes: input,
        at: floor,
        floor,
        most_plies,
        each,
        stopped: false,
    };
    reader.run();
}

/// True when the text starts with a UTF-16 byte-order mark.
pub fn is_utf16(input: &[u8]) -> bool {
    input.starts_with(b"\xFF\xFE") || input.starts_with(b"\xFE\xFF")
}

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0B | 0x0C)
}

/// The width of the space at `at`: an ASCII space or a UTF-8 no-break space.
fn space_at(bytes: &[u8], at: usize) -> usize {
    if bytes.get(at).copied().is_some_and(is_space) {
        1
    } else if bytes[at..].starts_with(NO_BREAK_SPACE) {
        NO_BREAK_SPACE.len()
    } else {
        0
    }
}

fn space_before(bytes: &[u8], at: usize) -> bool {
    is_space(bytes[at - 1]) || bytes[..at].ends_with(NO_BREAK_SPACE)
}

fn ends_token(bytes: &[u8], at: usize) -> bool {
    let c = bytes[at];

    space_at(bytes, at) > 0
        || matches!(
            c,
            b'{' | b'}' | b'(' | b')' | b'[' | b']' | b';' | b'$' | b'"'
        )
}

fn is_line_end(c: u8) -> bool {
    c == b'\n' || c == b'\r'
}

fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(e) if e.error_len().is_none() => {
            String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned()
        }
        Err(_) => bytes.iter().map(|b| char::from(*b)).collect(),
    }
}

struct Tag {
    name: String,
    value: String,
    end: usize,
}

enum TagRead {
    Pair(Tag),
    Bad { resume: usize },
    Cut,
}

fn after_line(bytes: &[u8], from: usize) -> usize {
    let mut at = from;

    while at < bytes.len() && !is_line_end(bytes[at]) {
        at += 1;
    }

    if at < bytes.len() && bytes[at] == b'\r' {
        at += 1;
    }
    if at < bytes.len() && bytes[at] == b'\n' {
        at += 1;
    }

    at
}

fn line_end(bytes: &[u8], from: usize) -> usize {
    let mut at = from;

    while at < bytes.len() && !is_line_end(bytes[at]) {
        at += 1;
    }

    at
}

/// Past the next `]` or to the end of the line, whichever comes first.
fn past_bad_tag(bytes: &[u8], from: usize) -> usize {
    let mut at = from;

    while at < bytes.len() && !is_line_end(bytes[at]) {
        if bytes[at] == b']' {
            return at + 1;
        }
        at += 1;
    }

    at
}

fn skip_blanks(bytes: &[u8], from: usize) -> usize {
    let mut at = from;

    loop {
        if at < bytes.len() && matches!(bytes[at], b' ' | b'\t') {
            at += 1;
        } else if bytes[at.min(bytes.len())..].starts_with(NO_BREAK_SPACE) {
            at += NO_BREAK_SPACE.len();
        } else {
            return at;
        }
    }
}

/// Reads `[Name "value"]` starting at the `[`.
fn read_tag(bytes: &[u8], open: usize) -> TagRead {
    let len = bytes.len();
    let name_start = skip_blanks(bytes, open + 1);

    let mut at = name_start;
    while at < len && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_') {
        at += 1;
    }
    let name_end = at;

    if name_end == name_start || name_end - name_start > MAX_TAG_NAME_BYTES {
        return TagRead::Bad {
            resume: past_bad_tag(bytes, name_end.max(open + 1)),
        };
    }

    at = skip_blanks(bytes, at);
    if at >= len {
        return TagRead::Cut;
    }
    if bytes[at] != b'"' {
        return TagRead::Bad {
            resume: past_bad_tag(bytes, at),
        };
    }
    at += 1;

    let mut value = Vec::new();
    loop {
        if at >= len {
            return TagRead::Cut;
        }

        let c = bytes[at];
        if c == b'"' {
            at += 1;
            break;
        }
        if is_line_end(c) {
            return TagRead::Bad { resume: at };
        }

        let (byte, width) = match (c, bytes.get(at + 1)) {
            (b'\\', Some(&next)) if next == b'"' || next == b'\\' => (next, 2),
            _ => (c, 1),
        };
        if value.len() < MAX_TAG_VALUE_BYTES {
            value.push(byte);
        }
        at += width;
    }

    at = skip_blanks(bytes, at);
    if at >= len {
        return TagRead::Cut;
    }
    if bytes[at] != b']' {
        return TagRead::Bad {
            resume: past_bad_tag(bytes, at),
        };
    }

    let value: String = decode(&value).chars().take(MAX_TAG_CHARS).collect();

    TagRead::Pair(Tag {
        name: String::from_utf8_lossy(&bytes[name_start..name_end]).into_owned(),
        value,
        end: at + 1,
    })
}

fn read_digits(bytes: &[u8], from: usize, most: usize) -> Option<(u64, usize)> {
    let mut at = from;
    let mut value: u64 = 0;

    while at < bytes.len() && bytes[at].is_ascii_digit() && at - from < most {
        value = value * 10 + u64::from(bytes[at] - b'0');
        at += 1;
    }

    if at == from || (at < bytes.len() && bytes[at].is_ascii_digit()) {
        return None;
    }

    Some((value, at))
}

/// Exactly two digits below 60.
fn sixty(bytes: &[u8], from: usize) -> Option<(u64, usize)> {
    let (value, end) = read_digits(bytes, from, 2)?;
    (end - from == 2 && value < 60).then_some((value, end))
}

/// Reads `h:mm:ss` or `h:mm:ss.f` (up to three decimals, four hour digits) followed by `]`.
fn clock_at(bytes: &[u8], from: usize) -> Option<u64> {
    let at = skip_blanks(bytes, from);

    let (hours, at) = read_digits(bytes, at, MAX_CLOCK_HOUR_DIGITS)?;
    if bytes.get(at) != Some(&b':') {
        return None;
    }

    let (minutes, at) = sixty(bytes, at + 1)?;
    if bytes.get(at) != Some(&b':') {
        return None;
    }

    let (seconds, mut at) = sixty(bytes, at + 1)?;

    let mut millis = 0;
    if bytes.get(at) == Some(&b'.') {
        let (fraction, end) = read_digits(bytes, at + 1, 3)?;
        millis = fraction * 10u64.pow(3 - (end - at - 1) as u32);
        at = end;
    }

    if bytes.get(skip_blanks(bytes, at)) != Some(&b']') {
        return None;
    }

    Some(((hours * 60 + minutes) * 60 + seconds) * 1000 + millis)
}

/// The first well-formed `[%clk ...]` in a comment.
fn clock_in(comment: &[u8]) -> Option<u64> {
    const COMMAND: &[u8] = b"[%clk";

    let mut at = 0;
    while at + COMMAND.len() <= comment.len() {
        if &comment[at..at + COMMAND.len()] == COMMAND {
            let after = at + COMMAND.len();
            let spaced = matches!(comment.get(after), Some(b' ' | b'\t'));

            if spaced {
                if let Some(ms) = clock_at(comment, after) {
                    return Some(ms);
                }
            }
        }
        at += 1;
    }

    None
}

fn is_zero_castle(token: &[u8]) -> bool {
    let mut end = token.len();
    while end > 0 && matches!(token[end - 1], b'!' | b'?' | b'+' | b'#') {
        end -= 1;
    }

    matches!(&token[..end], b"0-0" | b"0-0-0")
}

/// The move inside a token, with any move number in front taken off; `None` for a bare number.
fn move_in_token(token: &[u8]) -> Option<&[u8]> {
    if !token[0].is_ascii_digit() || is_zero_castle(token) {
        return Some(token);
    }

    let digits = token.iter().take_while(|c| c.is_ascii_digit()).count();
    let rest = &token[digits..];

    if rest.is_empty() {
        return None;
    }
    if rest[0] != b'.' {
        return Some(token);
    }

    let dots = rest.iter().take_while(|c| **c == b'.').count();
    let san = &rest[dots..];

    if san.is_empty() {
        None
    } else {
        Some(san)
    }
}

/// Standard chess or Chess960 by the `Variant` tag; `None` for any other variant.
fn rules_of(tag: Option<&str>) -> Option<Variant> {
    let tag = tag.map(str::trim).unwrap_or_default();
    if tag.is_empty() {
        return Some(Variant::Standard);
    }

    let name: String = tag
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();

    match name.as_str() {
        "standard" | "normal" | "chess" | "fromposition" => Some(Variant::Standard),
        "chess960" | "960" | "fischerandom" | "fischerrandom" => Some(Variant::Chess960),
        _ => None,
    }
}

/// What a repetition compares: pieces, turn, castling rights and en passant.
type PositionKey = (Board, Color, Bitboard, Option<Square>);

fn key_of(pos: &Chess) -> PositionKey {
    (
        pos.board().clone(),
        pos.turn(),
        pos.castles().castling_rights(),
        pos.ep_square(EnPassantMode::Legal),
    )
}

struct Replay {
    pos: Chess,
    mode: CastlingMode,
    /// Positions since the last capture or pawn move, the current one last.
    since_reset: Vec<PositionKey>,
}

impl Replay {
    fn new(pos: Chess, mode: CastlingMode) -> Replay {
        let since_reset = vec![key_of(&pos)];
        Replay {
            pos,
            mode,
            since_reset,
        }
    }

    fn played(&mut self) {
        if self.pos.halfmoves() == 0 {
            self.since_reset.clear();
        }
        self.since_reset.push(key_of(&self.pos));
    }

    fn status(&self) -> FinalStatus {
        let pos = &self.pos;
        let checkmate = pos.is_checkmate();

        let now = self.since_reset.last();
        let repetition = self
            .since_reset
            .iter()
            .filter(|key| Some(*key) == now)
            .count();

        FinalStatus {
            checkmate,
            stalemate: pos.is_stalemate(),
            insufficient_material: pos.is_insufficient_material(),
            fifty_moves: !checkmate && pos.halfmoves() >= 100,
            repetition: u32::try_from(repetition).unwrap_or(u32::MAX),
        }
    }
}

struct Start {
    replay: Replay,
    variant: Variant,
    start_fen: String,
    from_position: bool,
    chess960_number: Option<u16>,
}

/// A position from a FEN; too much material is allowed, as set-up games on the sites allow it.
fn load_start(fen: &str, mode: CastlingMode) -> Result<Chess, String> {
    let parsed = Fen::from_ascii(fen.as_bytes()).map_err(|e| format!("invalid FEN: {e}"))?;

    match parsed.into_position::<Chess>(mode) {
        Ok(pos) => Ok(pos),
        Err(e) => e
            .ignore_too_much_material()
            .map_err(|e| format!("illegal position: {e}")),
    }
}

/// The Chess960 number when the whole position is that start, not only its back ranks.
fn own_chess960_start(start_fen: &str) -> Option<u16> {
    let number = chess960::number_of(start_fen)?;
    let own = load_start(&chess960::fen(number)?, CastlingMode::Chess960).ok()?;

    (make_fen(&own) == start_fen).then_some(number)
}

fn chess960_start(pos: Chess) -> Start {
    let start_fen = make_fen(&pos);
    let own = own_chess960_start(&start_fen);

    Start {
        replay: Replay::new(pos, CastlingMode::Chess960),
        variant: Variant::Chess960,
        from_position: own.is_none(),
        chess960_number: chess960::number_of(&start_fen),
        start_fen,
    }
}

fn standard_start(pos: Chess, mode: CastlingMode) -> Start {
    let start_fen = make_fen(&pos);

    Start {
        replay: Replay::new(pos, mode),
        variant: Variant::Standard,
        from_position: start_fen != INITIAL_FEN,
        chess960_number: None,
        start_fen,
    }
}

fn start_of(variant: Variant, fen: Option<&str>) -> Result<Start, String> {
    let fen = fen.map(str::trim).filter(|f| !f.is_empty());

    let Some(fen) = fen else {
        return match variant {
            Variant::Standard => Ok(standard_start(Chess::default(), CastlingMode::Standard)),
            Variant::Chess960 => Err("a Chess960 game needs a FEN tag".into()),
        };
    };

    if variant == Variant::Chess960 {
        return load_start(fen, CastlingMode::Chess960).map(chess960_start);
    }

    let refused = match load_start(fen, CastlingMode::Standard) {
        Ok(pos) => return Ok(standard_start(pos, CastlingMode::Standard)),
        Err(why) => why,
    };

    // Castling rights that only Chess960 castling can hold.
    let Ok(pos) = load_start(fen, CastlingMode::Chess960) else {
        return Err(refused);
    };

    let start = chess960_start(pos.clone());
    if !start.from_position {
        return Ok(start);
    }

    Ok(standard_start(pos, CastlingMode::Chess960))
}

/// One game while it is being read.
struct Draft {
    start: usize,
    end: usize,
    tags: KeptTags,
    tag_count: usize,
    tags_dropped: u32,
    variations: u32,
    moves: Vec<ReadMove>,
    too_long: bool,
    marker: Option<GameResult>,
    problem: Option<Problem>,
    begun: Option<Start>,
    clock_open: bool,
}

impl Draft {
    fn new(start: usize) -> Draft {
        Draft {
            start,
            end: start,
            tags: KeptTags::default(),
            tag_count: 0,
            tags_dropped: 0,
            variations: 0,
            moves: Vec::new(),
            too_long: false,
            marker: None,
            problem: None,
            begun: None,
            clock_open: false,
        }
    }

    fn add_tag(&mut self, tag: Tag) {
        self.end = tag.end;

        if self.tag_count >= MAX_TAGS {
            self.tags_dropped = self.tags_dropped.saturating_add(1);
            return;
        }
        self.tag_count += 1;

        if let Some(slot) = self.tags.slot(&tag.name) {
            if slot.is_none() {
                *slot = Some(tag.value);
            }
        }
    }

    fn begin_moves(&mut self) {
        if self.begun.is_some() || self.problem.is_some() {
            return;
        }

        let Some(variant) = rules_of(self.tags.variant.as_deref()) else {
            let name = self.tags.variant.as_deref().unwrap_or_default();
            self.problem = Some(Problem::Variant {
                name: shown_text(name.as_bytes(), MAX_SHOWN_VARIANT_CHARS),
            });
            return;
        };

        match start_of(variant, self.tags.fen.as_deref()) {
            Ok(start) => self.begun = Some(start),
            Err(why) => self.problem = Some(Problem::BadStart { why }),
        }
    }

    fn token(&mut self, token: &[u8], most_plies: usize) {
        if token == BYTE_ORDER_MARK || GLYPH_TOKENS.contains(&token) {
            return;
        }

        if let Some(san) = move_in_token(token) {
            self.play(san, most_plies);
        }
    }

    fn play(&mut self, token: &[u8], most_plies: usize) {
        if self.problem.is_some() || self.too_long {
            return;
        }
        let Some(start) = self.begun.as_mut() else {
            return;
        };

        if self.moves.len() >= most_plies {
            self.too_long = true;
            self.moves = Vec::new();
            return;
        }

        let replay = &mut start.replay;
        let found = std::str::from_utf8(token)
            .ok()
            .and_then(|text| san_move(&replay.pos, text));

        let Some(found) = found else {
            let side = match replay.pos.turn() {
                Color::White => "white",
                Color::Black => "black",
            };

            self.problem = Some(Problem::IllegalMove {
                ply: (self.moves.len() as u32).saturating_add(1),
                move_number: replay.pos.fullmoves().get(),
                side,
                text: shown_text(token, crate::MAX_SHOWN_MOVE_CHARS),
            });
            return;
        };

        let uci = UciMove::from_move(found, replay.mode).to_string();
        let san = SanPlus::from_move_and_play_unchecked(&mut replay.pos, found).to_string();
        replay.played();

        self.moves.push(ReadMove {
            san,
            uci,
            clock_ms: None,
        });
        self.clock_open = true;
    }

    fn comment(&mut self, text: &[u8]) {
        if !self.clock_open {
            return;
        }

        if let Some(ms) = clock_in(text) {
            if let Some(last) = self.moves.last_mut() {
                last.clock_ms = Some(ms);
            }
            self.clock_open = false;
        }
    }

    fn finish(mut self) -> Option<Item> {
        self.begin_moves();

        if let Some(problem) = self.problem {
            return Some(Item::Unreadable(Unreadable {
                start: self.start,
                end: self.end,
                tags: self.tags,
                problem,
            }));
        }

        let start = self.begun?;

        let result = self.marker.or_else(|| {
            self.tags
                .result
                .as_deref()
                .and_then(|r| GameResult::from_text(r.trim()))
        });

        let last = if self.too_long {
            FinalStatus::default()
        } else {
            start.replay.status()
        };

        Some(Item::Game(ReadGame {
            start: self.start,
            end: self.end,
            tags: self.tags,
            variant: start.variant,
            start_fen: start.start_fen,
            from_position: start.from_position,
            chess960_number: start.chess960_number,
            chess960_castling: start.replay.mode == CastlingMode::Chess960,
            moves: self.moves,
            too_long: self.too_long,
            result,
            last,
            variations_skipped: self.variations,
            tags_dropped: self.tags_dropped,
        }))
    }
}

struct Reader<'a, F> {
    bytes: &'a [u8],
    at: usize,
    floor: usize,
    most_plies: usize,
    each: F,
    stopped: bool,
}

impl<F: FnMut(Item) -> ControlFlow<()>> Reader<'_, F> {
    fn at_line_start(&self) -> bool {
        self.at == self.floor || is_line_end(self.bytes[self.at - 1])
    }

    fn token_end(&self, from: usize) -> usize {
        let mut at = from;

        while at < self.bytes.len() && !ends_token(self.bytes, at) {
            at += 1;
        }

        at
    }

    /// Steps over a space or a `%` escape line; false when neither is here.
    fn skip_filler(&mut self) -> bool {
        let width = space_at(self.bytes, self.at);
        if width > 0 {
            self.at += width;
            return true;
        }

        if self.bytes[self.at] == b'%' && self.at_line_start() {
            self.at = after_line(self.bytes, self.at);
            return true;
        }

        false
    }

    fn emit(&mut self, draft: Draft) {
        let Some(item) = draft.finish() else {
            return;
        };

        if (self.each)(item).is_break() {
            self.stopped = true;
        }
    }

    /// A first move number followed by a legal first move: `1. e4`, `1.e4`.
    fn starts_bare_moves(&self) -> bool {
        let bytes = self.bytes;
        let at = self.at;

        let at_token_start = at == self.floor || space_before(bytes, at);
        if !at_token_start || bytes[at] != b'1' || bytes.get(at + 1) != Some(&b'.') {
            return false;
        }

        let mut first = at + 1;
        while first < bytes.len() && bytes[first] == b'.' {
            first += 1;
        }
        first = skip_blanks(bytes, first);

        let san = &bytes[first..self.token_end(first)];

        std::str::from_utf8(san)
            .ok()
            .and_then(|text| san_move(&Chess::default(), text))
            .is_some()
    }

    fn run(&mut self) {
        while self.at < self.bytes.len() && !self.stopped {
            if self.skip_filler() {
                continue;
            }

            if self.bytes[self.at] == b'[' {
                self.tag_outside_game();
                continue;
            }

            if self.starts_bare_moves() {
                let draft = Draft::new(self.at);
                self.read_moves(draft);
                continue;
            }

            let end = self.token_end(self.at);
            self.at = end.max(self.at + 1);
        }
    }

    fn cut_in_tag(&mut self, mut draft: Draft) {
        draft.end = self.bytes.len();
        draft.problem = Some(Problem::CutOff { inside: "tag" });
        self.at = self.bytes.len();
        self.emit(draft);
    }

    fn tag_outside_game(&mut self) {
        let open = self.at;

        match read_tag(self.bytes, open) {
            TagRead::Pair(tag) => {
                let mut draft = Draft::new(open);
                self.at = tag.end;
                draft.add_tag(tag);
                self.read_game(draft);
            }
            TagRead::Bad { resume } => self.at = resume.max(open + 1),
            TagRead::Cut => self.cut_in_tag(Draft::new(open)),
        }
    }

    /// Skips a `{...}` comment; false when it never closes, after marking the draft cut off.
    fn skip_comment(&mut self, draft: &mut Draft, keep: bool) -> bool {
        let at = self.at;
        let close = self.bytes[at + 1..].iter().position(|b| *b == b'}');

        let Some(close) = close.map(|p| at + 1 + p) else {
            draft.end = self.bytes.len();
            draft
                .problem
                .get_or_insert(Problem::CutOff { inside: "comment" });
            self.at = self.bytes.len();
            return false;
        };

        if keep {
            draft.comment(&self.bytes[at + 1..close]);
        }
        self.at = close + 1;
        true
    }

    fn read_game(&mut self, mut draft: Draft) {
        let len = self.bytes.len();

        while self.at < len {
            if self.skip_filler() {
                continue;
            }

            match self.bytes[self.at] {
                b'{' => {
                    if !self.skip_comment(&mut draft, false) {
                        self.emit(draft);
                        return;
                    }
                    continue;
                }
                b';' => {
                    self.at = line_end(self.bytes, self.at);
                    continue;
                }
                b'[' => {}
                _ => break,
            }

            match read_tag(self.bytes, self.at) {
                TagRead::Pair(tag) => {
                    self.at = tag.end;
                    draft.add_tag(tag);
                }
                TagRead::Bad { resume } => self.at = resume.max(self.at + 1),
                TagRead::Cut => {
                    self.cut_in_tag(draft);
                    return;
                }
            }
        }

        self.read_moves(draft);
    }

    /// A `[` among the moves: a `[%...]` command is read as a comment; a tag ends the game.
    fn bracket_in_moves(&mut self, draft: &mut Draft, depth: u32) -> ControlFlow<()> {
        let at = self.at;

        if self.bytes.get(at + 1) == Some(&b'%') {
            let stop = past_bad_tag(self.bytes, at + 1);
            if depth == 0 {
                draft.comment(&self.bytes[at..stop]);
            }
            self.at = stop;
            return ControlFlow::Continue(());
        }

        match read_tag(self.bytes, at) {
            TagRead::Pair(_) | TagRead::Cut => ControlFlow::Break(()),
            TagRead::Bad { resume } => {
                self.at = resume.max(at + 1);
                ControlFlow::Continue(())
            }
        }
    }

    fn read_moves(&mut self, mut draft: Draft) {
        let len = self.bytes.len();
        let mut depth: u32 = 0;

        draft.begin_moves();

        while self.at < len {
            if self.skip_filler() {
                continue;
            }

            let at = self.at;
            match self.bytes[at] {
                b'[' => {
                    if self.bracket_in_moves(&mut draft, depth).is_break() {
                        break;
                    }
                }
                b'{' => {
                    if !self.skip_comment(&mut draft, depth == 0) {
                        break;
                    }
                }
                b';' => {
                    let stop = line_end(self.bytes, at);
                    if depth == 0 {
                        draft.comment(&self.bytes[at + 1..stop]);
                    }
                    self.at = stop;
                }
                b'(' => {
                    if depth == 0 {
                        draft.variations = draft.variations.saturating_add(1);
                    }
                    depth = depth.saturating_add(1);
                    self.at += 1;
                }
                b')' => {
                    depth = depth.saturating_sub(1);
                    self.at += 1;
                }
                b'$' => {
                    let mut stop = at + 1;
                    while stop < len && self.bytes[stop].is_ascii_digit() {
                        stop += 1;
                    }
                    self.at = stop;
                }
                b'}' | b']' | b'"' => self.at += 1,
                _ => {
                    let stop = self.token_end(at);
                    let token = &self.bytes[at..stop];
                    self.at = stop;
                    draft.end = stop;

                    if depth > 0 {
                        continue;
                    }

                    if let Some(result) = GameResult::from_marker(token) {
                        draft.marker = Some(result);
                        break;
                    }

                    draft.token(token, self.most_plies);
                    continue;
                }
            }

            draft.end = self.at;
        }

        if depth > 0 {
            draft.problem.get_or_insert(Problem::CutOff {
                inside: "variation",
            });
        }

        self.emit(draft);
    }
}
