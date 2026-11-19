//! Player names from text written by strangers.

pub const MAX_NAME_CHARS: usize = 30;

/// Control, bidirectional and zero-width characters removed, spaces collapsed, cut to 30 characters.
pub fn clean_name(raw: &str) -> Option<String> {
    let visible: String = raw
        .chars()
        .filter(|c| c.is_whitespace() || (!c.is_control() && !is_invisible_format(*c)))
        .collect();

    let cleaned: String = visible
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();

    let cleaned = cleaned.trim_end().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// The form two names are compared in: case does not count.
pub fn folded(name: &str) -> String {
    name.to_lowercase()
}

pub fn same_name(a: &str, b: &str) -> bool {
    folded(a) == folded(b)
}

fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{17B4}'
            | '\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0000}'..='\u{E007F}'
    )
}
