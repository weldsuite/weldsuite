//! Definitions the query context carries (`weldpanel-collab.ts`): custom
//! events, computed properties, and the path-rule checks and preview.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};

use super::query::{FilterColumn, PanelFilter, PathRule};
use crate::js;

/// One event (with its own filters) that counts as the custom event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomEventMatch {
    pub event: String,
    #[serde(default)]
    pub filters: Vec<PanelFilter>,
}

/// `{ match: [{ event, filters }] }`: any of these events counts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomEventDefinition {
    #[serde(rename = "match")]
    pub match_: Vec<CustomEventMatch>,
}

/// One input of a `coalesce`: an event property or a standard column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum ComputedPropertySource {
    Event { key: String },
    Column { field: FilterColumn },
}

/// `formula`: arithmetic over numeric event properties; `coalesce`: the
/// first of 2-5 inputs that is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComputedPropertyDefinition {
    Formula { expression: String },
    Coalesce { keys: Vec<ComputedPropertySource> },
}

/// Rules a project may hold; applied in order.
pub const PANEL_MAX_PATH_RULES: usize = 30;
/// Longest pattern or replacement.
pub const PANEL_MAX_PATH_RULE_LENGTH: usize = 500;

/// Lookarounds and backreferences, which the query engine's regular
/// expressions (Rust's `regex` crate in Basin SQL and DataFusion) refuse.
static UNSUPPORTED_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\?<?[=!]|\\[1-9]|\\k<").expect("a valid pattern"));

fn has_control_character(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

/// `panelPathPatternProblem`: why `pattern` cannot be a path rule, or `None`
/// when it can.
///
/// The TypeScript compiles the pattern with JavaScript's `RegExp`; this
/// compiles it with the `regex` crate, the engine that runs it in SQL. The
/// two differ only on patterns one of them refuses.
pub fn panel_path_pattern_problem(pattern: &str) -> Option<String> {
    if pattern.is_empty() {
        return Some("Enter a pattern".to_owned());
    }
    if js::utf16_len(pattern) > PANEL_MAX_PATH_RULE_LENGTH {
        return Some(format!(
            "Use at most {PANEL_MAX_PATH_RULE_LENGTH} characters"
        ));
    }
    if has_control_character(pattern) {
        return Some("Control characters are not allowed".to_owned());
    }
    if UNSUPPORTED_REGEX.is_match(pattern) {
        return Some("Lookarounds and backreferences are not supported".to_owned());
    }
    let Ok(regex) = Regex::new(pattern) else {
        return Some("Not a valid regular expression".to_owned());
    };
    if regex.is_match("") {
        return Some("The pattern must not match an empty path".to_owned());
    }
    None
}

/// `panelPathReplacementProblem`: why `replacement` cannot be a path rule's
/// replacement, or `None` when it can.
pub fn panel_path_replacement_problem(replacement: &str) -> Option<String> {
    if js::utf16_len(replacement) > PANEL_MAX_PATH_RULE_LENGTH {
        return Some(format!(
            "Use at most {PANEL_MAX_PATH_RULE_LENGTH} characters"
        ));
    }
    if has_control_character(replacement) {
        return Some("Control characters are not allowed".to_owned());
    }
    if ["$&", "$`", "$'"]
        .iter()
        .any(|bad| replacement.contains(bad))
    {
        return Some("Use $1 or ${name} in the replacement, not $& or $` or $'".to_owned());
    }
    None
}

/// `path.replace(new RegExp(pattern, 'g'), replacement)` with JavaScript's
/// replacement patterns (`$1`..`$99`, `$<name>`, `$&`, `` $` ``, `$'`, `$$`).
pub fn replace_all_js(regex: &Regex, text: &str, replacement: &str) -> String {
    let named = regex.capture_names().any(|name| name.is_some());
    regex
        .replace_all(text, |caps: &Captures<'_>| {
            expand_js(caps, text, replacement, named)
        })
        .into_owned()
}

fn expand_js(caps: &Captures<'_>, text: &str, replacement: &str, named: bool) -> String {
    let whole = caps.get(0).map_or(0..0, |m| m.range());
    let group_count = caps.len() - 1;
    let bytes = replacement.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < replacement.len() {
        if bytes[i] != b'$' || i + 1 >= replacement.len() {
            let c = replacement[i..].chars().next().unwrap_or('$');
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        match bytes[i + 1] {
            b'$' => {
                out.push('$');
                i += 2;
            }
            b'&' => {
                out.push_str(&text[whole.clone()]);
                i += 2;
            }
            b'`' => {
                out.push_str(&text[..whole.start]);
                i += 2;
            }
            b'\'' => {
                out.push_str(&text[whole.end..]);
                i += 2;
            }
            b'0'..=b'9' => {
                let one = usize::from(bytes[i + 1] - b'0');
                let two = bytes
                    .get(i + 2)
                    .filter(|b| b.is_ascii_digit())
                    .map(|b| one * 10 + usize::from(b - b'0'));
                if let Some(two) = two.filter(|n| (1..=group_count).contains(n)) {
                    out.push_str(caps.get(two).map_or("", |m| m.as_str()));
                    i += 3;
                } else if (1..=group_count).contains(&one) {
                    out.push_str(caps.get(one).map_or("", |m| m.as_str()));
                    i += 2;
                } else {
                    out.push('$');
                    i += 1;
                }
            }
            b'<' => {
                let close = replacement[i + 2..].find('>');
                match close {
                    Some(close) if named => {
                        let name = &replacement[i + 2..i + 2 + close];
                        out.push_str(caps.name(name).map_or("", |m| m.as_str()));
                        i += close + 3;
                    }
                    _ => {
                        out.push('$');
                        i += 1;
                    }
                }
            }
            _ => {
                out.push('$');
                i += 1;
            }
        }
    }
    out
}

/// What [`apply_panel_path_rules`] gives: the cleaned path and the
/// positions of the rules that changed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathRulesApplied {
    pub cleaned: String,
    pub matched: Vec<usize>,
}

/// `applyPanelPathRules`: applies `rules` in order (each replaces every
/// match), skipping a rule that cannot be used. For previews; the query
/// engine does the same in SQL.
pub fn apply_panel_path_rules(path: &str, rules: &[PathRule]) -> PathRulesApplied {
    let mut cleaned = path.to_owned();
    let mut matched = Vec::new();
    for (index, rule) in rules.iter().enumerate() {
        if panel_path_pattern_problem(&rule.pattern).is_some()
            || panel_path_replacement_problem(&rule.replacement).is_some()
        {
            continue;
        }
        let Ok(regex) = Regex::new(&rule.pattern) else {
            continue;
        };
        let next = replace_all_js(&regex, &cleaned, &rule.replacement);
        if next != cleaned {
            matched.push(index);
        }
        cleaned = next;
    }
    PathRulesApplied { cleaned, matched }
}
