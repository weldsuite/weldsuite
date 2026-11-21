//! Path cleaning (`paths.ts`, `panel_path_rules`): `/users/123/settings` →
//! `/users/:id/settings` wherever a report groups or shows pages by path,
//! each rule applied in order with `regexp_replace(path, pattern,
//! replacement, 'g')`. Patterns and replacements reach SQL only through
//! [`lit`].

use regex::Regex;

use super::context::PanelQueryContext;
use super::sql::{PanelQueryError, QueryResult, lit};
use crate::schemas::{
    PANEL_MAX_PATH_RULE_LENGTH, PANEL_MAX_PATH_RULES, PathRule, panel_path_pattern_problem,
    panel_path_replacement_problem, replace_all_js,
};

/// Longest pattern or replacement.
pub const MAX_PATH_RULE_LENGTH: usize = PANEL_MAX_PATH_RULE_LENGTH;

/// `pathRuleProblem`: why a rule cannot be used, or `None`.
pub fn path_rule_problem(rule: &PathRule) -> Option<String> {
    panel_path_pattern_problem(&rule.pattern)
        .or_else(|| panel_path_replacement_problem(&rule.replacement))
}

/// `applyPathRules`: the rules applied to one path (previews and tests); a
/// rule whose pattern does not compile is skipped.
pub fn apply_path_rules(path: &str, rules: &[PathRule]) -> String {
    rules.iter().fold(path.to_owned(), |value, rule| {
        match Regex::new(&rule.pattern) {
            Ok(regex) => replace_all_js(&regex, &value, &rule.replacement),
            Err(_) => value,
        }
    })
}

/// `activePathRules`: the context's rules, unless the spec switched cleaning
/// off. Each one checked.
pub fn active_path_rules(
    ctx: &PanelQueryContext,
    clean_paths: Option<bool>,
) -> QueryResult<&[PathRule]> {
    if clean_paths == Some(false) {
        return Ok(&[]);
    }
    let rules = ctx.path_rules.as_deref().unwrap_or_default();
    if rules.len() > PANEL_MAX_PATH_RULES {
        return Err(PanelQueryError::new(format!(
            "At most {PANEL_MAX_PATH_RULES} path rules are applied"
        )));
    }
    for rule in rules {
        if let Some(problem) = path_rule_problem(rule) {
            return Err(PanelQueryError::new(format!(
                "A path rule cannot be used: {problem}"
            )));
        }
    }
    Ok(rules)
}

/// `cleanedPathSql`: `column` with the path rules applied.
pub fn cleaned_path_sql(
    ctx: &PanelQueryContext,
    clean_paths: Option<bool>,
    column: &str,
) -> QueryResult<String> {
    let mut expr = column.to_owned();
    for rule in active_path_rules(ctx, clean_paths)? {
        expr = format!(
            "regexp_replace({expr}, {}, {}, 'g')",
            lit(&rule.pattern)?,
            lit(&rule.replacement)?
        );
    }
    Ok(expr)
}

/// [`cleaned_path_sql`] of `e.path`.
pub fn cleaned_path(ctx: &PanelQueryContext, clean_paths: Option<bool>) -> QueryResult<String> {
    cleaned_path_sql(ctx, clean_paths, "e.path")
}
