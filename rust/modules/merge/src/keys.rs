//! Issue keys in pull requests (`@weldsuite/merge-domain/keys`, ADR
//! MERGE-003).
//!
//! A pull request links to an issue when its branch, title or body names the
//! issue's key (`PLAT-209`, case-insensitive: `plat-209-fix-tabs` counts).
//! Whether merging closes the issue depends on the words just before the
//! key: after "refs", "ref", "references", "part of", "related to" or
//! "relates to" it doesn't. A key in the branch name always closes. When a
//! key appears more than once, one closing mention is enough.
//!
//! The TypeScript reads keys with a regular expression with lookarounds
//! (`(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})(?![A-Za-z0-9])`),
//! over UTF-16 code units; this scans the same units by hand, which the
//! expression amounts to: a match starts only where an ASCII letter or
//! digit run starts.

/// One key a pull request mentions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueKeyMention {
    /// Upper-case team key, `PLAT`.
    pub team_key: String,
    pub number: i64,
    /// `PLAT-209`.
    pub key: String,
    /// Merging the pull request moves the issue to Done.
    pub closes: bool,
}

/// The longest key prefix a team can have; also caps how far back the
/// keyword search looks.
const LOOKBEHIND: usize = 24;

fn is_alnum(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|b| b.is_ascii_alphanumeric())
}

fn is_letter(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|b| b.is_ascii_alphabetic())
}

fn is_digit(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|b| b.is_ascii_digit())
}

/// JavaScript's `\s`.
pub(crate) fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `\w` (no `u` flag): ASCII letters, digits and `_`.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `/(?:\b(?:refs?|references|part\s+of|related\s+to|relates\s+to))[\s:]*$/i`
/// on the text just before a key.
fn is_reference_only(before: &str) -> bool {
    let chars: Vec<char> = before.chars().collect();
    let mut end = chars.len();
    while end > 0 && (js_space(chars[end - 1]) || chars[end - 1] == ':') {
        end -= 1;
    }
    let text = &chars[..end];
    // Where a keyword ending at `end` starts, if one does.
    let ends_with = |word: &str, upto: usize| -> Option<usize> {
        let word: Vec<char> = word.chars().collect();
        if upto < word.len() {
            return None;
        }
        let start = upto - word.len();
        text[start..upto]
            .iter()
            .zip(&word)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
            .then_some(start)
    };
    // `first\s+second`.
    let two_words = |first: &str, second: &str| -> Option<usize> {
        let mut at = ends_with(second, end)?;
        let gap_end = at;
        while at > 0 && js_space(text[at - 1]) {
            at -= 1;
        }
        if at == gap_end {
            return None;
        }
        ends_with(first, at)
    };
    let starts = [
        ends_with("refs", end),
        ends_with("ref", end),
        ends_with("references", end),
        two_words("part", "of"),
        two_words("related", "to"),
        two_words("relates", "to"),
    ];
    starts
        .into_iter()
        .flatten()
        .any(|start| start == 0 || !is_word(text[start - 1]))
}

fn scan(text: &str, closing_by_default: bool, out: &mut Vec<IssueKeyMention>, check_keyword: bool) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut i = 0;
    while i < units.len() {
        if i > 0 && is_alnum(units[i - 1]) || !is_letter(units[i]) {
            i += 1;
            continue;
        }
        let mut team_end = i;
        while team_end < units.len() && is_alnum(units[team_end]) {
            team_end += 1;
        }
        let team_len = team_end - i;
        if !(2..=10).contains(&team_len) || units.get(team_end) != Some(&u16::from(b'-')) {
            i += 1;
            continue;
        }
        let digits_start = team_end + 1;
        let mut digits_end = digits_start;
        while digits_end < units.len() && is_digit(units[digits_end]) {
            digits_end += 1;
        }
        let digits = digits_end - digits_start;
        let followed_by_alnum = units.get(digits_end).is_some_and(|u| is_alnum(*u));
        if !(1..=9).contains(&digits) || followed_by_alnum {
            i += 1;
            continue;
        }
        let team_key = String::from_utf16_lossy(&units[i..team_end]).to_ascii_uppercase();
        let number: i64 = String::from_utf16_lossy(&units[digits_start..digits_end])
            .parse()
            .unwrap_or(0);
        if number > 0 {
            let key = format!("{team_key}-{number}");
            let mut closes = closing_by_default;
            if check_keyword {
                let before = String::from_utf16_lossy(&units[i.saturating_sub(LOOKBEHIND)..i]);
                if is_reference_only(&before) {
                    closes = false;
                }
            }
            if let Some(existing) = out.iter_mut().find(|m| m.key == key) {
                existing.closes = existing.closes || closes;
            } else {
                out.push(IssueKeyMention {
                    team_key,
                    number,
                    key,
                    closes,
                });
            }
        }
        // `matchAll` goes on after the match.
        i = digits_end;
    }
}

/// `findIssueKeyMentions({ headRef, title, body })`: every issue key a pull
/// request mentions, in first-seen order (branch, then title, then body).
pub fn find_issue_key_mentions(
    head_ref: Option<&str>,
    title: Option<&str>,
    body: Option<&str>,
) -> Vec<IssueKeyMention> {
    let mut out = Vec::new();
    // `if (input.headRef)`: an empty string is skipped.
    if let Some(text) = head_ref.filter(|t| !t.is_empty()) {
        scan(text, true, &mut out, false);
    }
    if let Some(text) = title.filter(|t| !t.is_empty()) {
        scan(text, true, &mut out, true);
    }
    if let Some(text) = body.filter(|t| !t.is_empty()) {
        scan(text, true, &mut out, true);
    }
    out
}

/// A parsed key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueKey {
    pub team_key: String,
    pub number: i64,
    pub key: String,
}

/// `parseIssueKey(value)`: `PLAT-209` (any case, trimmed), or `None` when it
/// isn't a key.
pub fn parse_issue_key(value: &str) -> Option<IssueKey> {
    let text = weldsuite_kit::validation::js_trim(value);
    let (team, digits) = text.split_once('-')?;
    let team_ok = team.len() >= 2
        && team.len() <= 10
        && team.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
        && team.bytes().all(|b| b.is_ascii_alphanumeric());
    let digits_ok =
        !digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit());
    if !team_ok || !digits_ok {
        return None;
    }
    let number: i64 = digits.parse().ok()?;
    if number <= 0 {
        return None;
    }
    let team_key = team.to_ascii_uppercase();
    Some(IssueKey {
        key: format!("{team_key}-{number}"),
        team_key,
        number,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
#[allow(clippy::assert_is_empty)]
mod tests {
    use super::*;

    fn keys(found: &[IssueKeyMention]) -> Vec<&str> {
        found.iter().map(|m| m.key.as_str()).collect()
    }

    #[test]
    fn finds_a_key_in_a_branch_name_case_insensitively() {
        assert_eq!(
            find_issue_key_mentions(Some("gert/plat-209-fix-tab-writes"), None, None),
            vec![IssueKeyMention {
                team_key: "PLAT".to_owned(),
                number: 209,
                key: "PLAT-209".to_owned(),
                closes: true,
            }]
        );
    }

    #[test]
    fn collects_branch_title_and_body_in_first_seen_order_without_duplicates() {
        let found = find_issue_key_mentions(
            Some("plat-209-tabs"),
            Some("PLAT-209: restrict tab writes (API-97)"),
            Some("Also touches MOB-12."),
        );
        assert_eq!(keys(&found), ["PLAT-209", "API-97", "MOB-12"]);
    }

    #[test]
    fn does_not_close_after_reference_words() {
        let found = find_issue_key_mentions(
            None,
            Some("Refactor tabs"),
            Some("Refs PLAT-1\nPart of: PLAT-2\nrelated to PLAT-3\nFixes PLAT-4"),
        );
        let closes: Vec<(&str, bool)> = found.iter().map(|m| (m.key.as_str(), m.closes)).collect();
        assert_eq!(
            closes,
            [
                ("PLAT-1", false),
                ("PLAT-2", false),
                ("PLAT-3", false),
                ("PLAT-4", true)
            ]
        );
    }

    #[test]
    fn closes_when_any_mention_closes() {
        let found = find_issue_key_mentions(None, Some("PLAT-5 tabs"), Some("refs PLAT-5"));
        assert_eq!(found.len(), 1);
        assert!(found[0].closes);
    }

    #[test]
    fn ignores_digits_first_tokens_zero_numbers_and_glued_keys() {
        assert!(
            find_issue_key_mentions(
                None,
                Some("2024-11 release, PLAT-0, PLAT-3x, PLAT_3, sha256-abc"),
                None
            )
            .is_empty()
        );
    }

    #[test]
    fn ignores_github_issue_references() {
        assert!(find_issue_key_mentions(None, None, Some("Fixes #1460")).is_empty());
    }

    #[test]
    fn a_keyword_glued_to_a_word_still_closes() {
        let found = find_issue_key_mentions(None, Some("preferences PLAT-1, xrefs PLAT-2"), None);
        assert!(found.iter().all(|m| m.closes));
        let refs = find_issue_key_mentions(None, Some("relates   to:  PLAT-3"), None);
        assert!(!refs[0].closes);
    }

    #[test]
    fn parses_and_upper_cases_a_key() {
        assert_eq!(
            parse_issue_key(" plat-209 ").unwrap(),
            IssueKey {
                team_key: "PLAT".to_owned(),
                number: 209,
                key: "PLAT-209".to_owned(),
            }
        );
    }

    #[test]
    fn rejects_ids_and_malformed_values() {
        assert!(parse_issue_key("mis_abc123").is_none());
        assert!(parse_issue_key("PLAT-").is_none());
        assert!(parse_issue_key("P-1").is_none());
        assert!(parse_issue_key("PLAT-0").is_none());
    }
}
