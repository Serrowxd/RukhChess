//! Times as text, from milliseconds since the epoch.

const MS_PER_DAY: u64 = 86_400_000;

/// `2026-10-12T19:02:11Z`.
pub fn utc_text(ms: u64) -> String {
    let days = ms / MS_PER_DAY;
    let rest = (ms % MS_PER_DAY) / 1000;

    let (year, month, day) = civil(days);
    let (hour, minute, second) = (rest / 3600, (rest / 60) % 60, rest % 60);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days since 1970-01-01 to a calendar date.
fn civil(days: u64) -> (u64, u64, u64) {
    let shifted_days = days + 719_468;
    let era = shifted_days / 146_097;
    let day_of_era = shifted_days % 146_097;

    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);

    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };

    let year = year_of_era + era * 400 + u64::from(month <= 2);
    (year, month, day)
}
