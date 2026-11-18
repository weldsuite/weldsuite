//! Phone-number text of a customer's own phone system
//! (`lib/sip-trunk-number.ts`): what a member types and what arrives in a
//! call's `to` (`+3120…`, `0031 20…`, `sip:31201234567@host`).

use crate::desk_phone::is_e164;

/// `toTrunkE164(raw)`: `+<digits>` from a typed or dialled number,
/// tolerating a missing `+` and a `00` prefix; `None` when it is not a
/// plausible E.164 number.
pub(crate) fn to_trunk_e164(raw: &str) -> Option<String> {
    let text = weldsuite_kit::validation::js_trim(raw);
    if text.is_empty() {
        return None;
    }
    let has_plus = text.starts_with('+');
    // `/\D/g`: everything but the ASCII digits goes.
    let mut digits: String = text.chars().filter(char::is_ascii_digit).collect();
    if !has_plus && digits.starts_with("00") {
        digits.drain(..2);
    }
    let number = format!("+{digits}");
    is_e164(&number).then_some(number)
}

/// A line terminator, which `.` does not match.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `value.replace(/>.*$/, '')`: cut at the first `>` that only has
/// characters `.` matches up to the end of the text.
fn cut_after_bracket(value: &str) -> &str {
    let after_last_terminator = value
        .char_indices()
        .rev()
        .find(|(_, c)| is_line_terminator(*c))
        .map_or(0, |(index, c)| index + c.len_utf8());
    match value[after_last_terminator..].find('>') {
        Some(index) => &value[..after_last_terminator + index],
        None => value,
    }
}

/// `value.replace(/^(sips?|tel):/i, '')`.
fn without_scheme(value: &str) -> &str {
    for scheme in ["sips:", "sip:", "tel:"] {
        if let Some(head) = value.get(..scheme.len())
            && head.eq_ignore_ascii_case(scheme)
        {
            return &value[scheme.len()..];
        }
    }
    value
}

/// `dialedNumberOf(raw)`: the number in a call's `to`: a bare number,
/// `tel:` or the user part of a `sip:` URI (parameters and `<>` dropped).
pub(crate) fn dialed_number_of(raw: &str) -> Option<String> {
    let trimmed = weldsuite_kit::validation::js_trim(raw);
    // `/^[^<]*</`: everything up to the first `<`.
    let value = trimmed
        .find('<')
        .map_or(trimmed, |index| &trimmed[index + 1..]);
    let value = without_scheme(cut_after_bracket(value));
    let value = value.find('@').map_or(value, |at| &value[..at]);
    let value = value.split(';').next().unwrap_or_default();
    to_trunk_e164(value)
}

/// `COUNTRY_PREFIXES`, longest first.
const COUNTRY_PREFIXES: [(&str, &str); 18] = [
    ("+351", "PT"),
    ("+352", "LU"),
    ("+353", "IE"),
    ("+358", "FI"),
    ("+31", "NL"),
    ("+32", "BE"),
    ("+33", "FR"),
    ("+34", "ES"),
    ("+39", "IT"),
    ("+41", "CH"),
    ("+43", "AT"),
    ("+44", "GB"),
    ("+45", "DK"),
    ("+46", "SE"),
    ("+47", "NO"),
    ("+48", "PL"),
    ("+49", "DE"),
    ("+1", "US"),
];

/// `countryOfE164(e164)`: a best-effort country for a number row (`INTL`
/// when the prefix is not one we know).
pub(crate) fn country_of_e164(e164: &str) -> &'static str {
    COUNTRY_PREFIXES
        .iter()
        .find(|(prefix, _)| e164.starts_with(prefix))
        .map_or("INTL", |(_, country)| country)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_numbers_become_e164() {
        assert_eq!(
            to_trunk_e164("0031 20 130 0001").as_deref(),
            Some("+31201300001")
        );
        assert_eq!(
            to_trunk_e164(" +31 (20) 130-0001 ").as_deref(),
            Some("+31201300001")
        );
        assert_eq!(
            to_trunk_e164("31201300001").as_deref(),
            Some("+31201300001")
        );
        // A `+` keeps a leading `00`, which is then no E.164 number.
        assert_eq!(to_trunk_e164("+0031201300001"), None);
        assert_eq!(to_trunk_e164("12"), None);
        assert_eq!(to_trunk_e164("   "), None);
        assert_eq!(to_trunk_e164("0123456789"), None);
        assert_eq!(to_trunk_e164("+1234567890123456"), None);
    }

    #[test]
    fn dialled_numbers_are_read_from_sip_addresses() {
        assert_eq!(
            dialed_number_of("sip:31201280001@sip.telnyx.com").as_deref(),
            Some("+31201280001")
        );
        assert_eq!(
            dialed_number_of("sip:+31612345002@pbx.example.nl;user=phone").as_deref(),
            Some("+31612345002")
        );
        assert_eq!(
            dialed_number_of("<sip:0031201280001@host>").as_deref(),
            Some("+31201280001")
        );
        assert_eq!(
            dialed_number_of("\"Front desk\" <SIPS:+31201280001;ext=1@host>;tag=1").as_deref(),
            Some("+31201280001")
        );
        assert_eq!(
            dialed_number_of("tel:+31201280001").as_deref(),
            Some("+31201280001")
        );
        assert_eq!(
            dialed_number_of("0031612345003").as_deref(),
            Some("+31612345003")
        );
        assert_eq!(dialed_number_of("sip:anna@host"), None);
        assert_eq!(dialed_number_of(""), None);
        // `.` stops at a line break: only a `>` on the last line cuts.
        assert_eq!(cut_after_bracket("a>b\nc>d"), "a>b\nc");
        assert_eq!(cut_after_bracket("a>b\nc"), "a>b\nc");
    }

    #[test]
    fn countries_come_from_the_prefix() {
        assert_eq!(country_of_e164("+31201300001"), "NL");
        assert_eq!(country_of_e164("+3511234567"), "PT");
        assert_eq!(country_of_e164("+12125550100"), "US");
        assert_eq!(country_of_e164("+81312345678"), "INTL");
    }
}
