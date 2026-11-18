//! What WeldPanel's Zod schemas compute in JavaScript: the `.refine()` and
//! `.superRefine()` checks the generated schemas (`schemas_gen.rs`) call,
//! each named after its schema (`weldpanel-query.ts`, `weldpanel-collab.ts`,
//! `weldpanel-objects.ts`). Each gets the value its schema parsed (defaults
//! filled in) and adds Zod's `custom` issues with the TypeScript's messages
//! and paths.

use serde_json::{Value, json};
use weldsuite_panel_domain::wire::{
    COMPUTED_PROPERTY_REF, CUSTOM_EVENT_NAME, CUSTOM_EVENT_REF, PROPERTY_KEY, SYSTEM_EVENT_NAME,
};
use weldsuite_zod::Hook;

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// `PANEL_PROPERTY_KEY.test(v.startsWith('$') ? v.slice(1) : v)`.
fn property_key(key: &str) -> bool {
    PROPERTY_KEY.is_match(key.strip_prefix('$').unwrap_or(key))
}

/// `panelEventNameSchema`: a custom event name or a `$` system event.
pub(crate) fn refine_panel_event_name(value: Option<&Value>, hook: &mut Hook) {
    if let Some(name) = text(value)
        && !(CUSTOM_EVENT_NAME.is_match(name) || SYSTEM_EVENT_NAME.is_match(name))
    {
        hook.fail("Not a valid event name");
    }
}

/// `panelEventRefSchema`: an event name, or a custom event (`@pnce_…`).
pub(crate) fn refine_panel_event_ref(value: Option<&Value>, hook: &mut Hook) {
    if let Some(name) = text(value)
        && !(CUSTOM_EVENT_NAME.is_match(name)
            || SYSTEM_EVENT_NAME.is_match(name)
            || CUSTOM_EVENT_REF.is_match(name))
    {
        hook.fail("Not a valid event name");
    }
}

/// `panelPropertyKeySchema`.
pub(crate) fn refine_panel_property_key(value: Option<&Value>, hook: &mut Hook) {
    if let Some(key) = text(value)
        && !property_key(key)
    {
        hook.fail("Not a valid property key");
    }
}

/// `panelEventPropertyRefSchema`: a property key, or a computed property
/// (`@pncp_…`).
pub(crate) fn refine_panel_event_property_ref(value: Option<&Value>, hook: &mut Hook) {
    if let Some(key) = text(value)
        && !(property_key(key) || COMPUTED_PROPERTY_REF.is_match(key))
    {
        hook.fail("Not a valid property key");
    }
}

/// `panelDateRangeSchema`'s custom range: `v.from <= v.to` (JavaScript's
/// string order).
pub(crate) fn refine_panel_date_range_or1(value: Option<&Value>, hook: &mut Hook) {
    let (Some(from), Some(to)) = (text(field(value, "from")), text(field(value, "to"))) else {
        return;
    };
    if from.encode_utf16().cmp(to.encode_utf16()) == std::cmp::Ordering::Greater {
        hook.fail("`from` must not be after `to`");
    }
}

/// `panelFilterSchema`'s `superRefine`: `checkOperatorValue` for every
/// source but `cohort`.
pub(crate) fn refine_panel_filter(value: Option<&Value>, hook: &mut Hook) {
    if text(field(value, "source")) == Some("cohort") {
        return;
    }
    let Some(operator) = text(field(value, "operator")) else {
        return;
    };
    let given = field(value, "value");
    let path = [json!("value")];
    let needs_value = operator != "is_set" && operator != "is_not_set";
    if needs_value && given.is_none() {
        hook.fail_at(&path, "A value is required");
    }
    let is_list = given.is_some_and(Value::is_array);
    if operator == "in" && !is_list {
        hook.fail_at(&path, "Use a list of values");
    }
    if operator != "in" && is_list {
        hook.fail_at(&path, "Only `in` takes a list");
    }
    if (operator == "gt" || operator == "lt") && given.is_some_and(Value::is_boolean) {
        hook.fail_at(&path, "Use a number or text");
    }
}

/// `panelBreakdownBucketSchema`'s custom edges: from low to high.
pub(crate) fn refine_panel_breakdown_bucket_or1_edges(value: Option<&Value>, hook: &mut Hook) {
    let Some(edges) = value.and_then(Value::as_array) else {
        return;
    };
    let numbers: Vec<f64> = edges
        .iter()
        .map(|v| v.as_f64().unwrap_or(f64::NAN))
        .collect();
    if !numbers.windows(2).all(|pair| pair[1] > pair[0]) {
        hook.fail("List the edges from low to high");
    }
}

/// `panelWebGoalSchema`: an event or a page, not both.
pub(crate) fn refine_panel_web_goal(value: Option<&Value>, hook: &mut Hook) {
    let event = field(value, "event").is_some();
    let page = field(value, "pathPattern").is_some();
    if event == page {
        hook.fail_at(&[json!("event")], "Choose an event or a page");
    }
}

/// `panelTrendSeriesSchema`'s first refine: `sum`, `avg`, `min` and `max`
/// need a property.
pub(crate) fn refine_panel_trend_series_inner(value: Option<&Value>, hook: &mut Hook) {
    let math = text(field(value, "math")).unwrap_or_default();
    if matches!(math, "sum" | "avg" | "min" | "max") && field(value, "property").is_none() {
        hook.fail_at(&[json!("property")], "Choose the property to calculate");
    }
}

/// `panelTrendSeriesSchema`'s second refine: `unique_groups` needs a group type.
pub(crate) fn refine_panel_trend_series(value: Option<&Value>, hook: &mut Hook) {
    if text(field(value, "math")) == Some("unique_groups") && field(value, "groupType").is_none() {
        hook.fail_at(&[json!("groupType")], "Choose the group type to count");
    }
}

/// `checkBreakdownPair`.
fn check_breakdown_pair(value: Option<&Value>, hook: &mut Hook) {
    if field(value, "breakdown").is_some() && field(value, "breakdowns").is_some() {
        hook.fail_at(
            &[json!("breakdowns")],
            "Use `breakdowns` or `breakdown`, not both",
        );
    }
}

/// `trendsSpecSchema`'s `superRefine`.
pub(crate) fn refine_trends_spec(value: Option<&Value>, hook: &mut Hook) {
    check_breakdown_pair(value, hook);
    let formula_only = field(value, "formulaOnly").and_then(Value::as_bool) == Some(true);
    let has_formulas = field(value, "formulas")
        .and_then(Value::as_array)
        .is_some_and(|formulas| !formulas.is_empty());
    if formula_only && !has_formulas {
        hook.fail_at(&[json!("formulaOnly")], "Add a formula first");
    }
}

/// `panelFunnelExclusionSchema`: the end step after the start step.
pub(crate) fn refine_panel_funnel_exclusion(value: Option<&Value>, hook: &mut Hook) {
    let from = field(value, "fromStep").and_then(Value::as_f64);
    let to = field(value, "toStep").and_then(Value::as_f64);
    if let (Some(from), Some(to)) = (from, to)
        && from >= to
    {
        hook.fail_at(
            &[json!("toStep")],
            "The end step must come after the start step",
        );
    }
}

/// A step count as a number (a funnel has at most ten steps).
fn clamp_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// `refineFunnel`: the breakdown pair, optional steps only in the middle,
/// exclusions within the steps and only for ordered funnels.
fn refine_funnel(value: Option<&Value>, hook: &mut Hook) {
    check_breakdown_pair(value, hook);
    let steps = field(value, "steps")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let last = steps.len().checked_sub(1);
    for (i, step) in steps.iter().enumerate() {
        let optional = step.get("optional").and_then(Value::as_bool) == Some(true);
        if optional && (i == 0 || Some(i) == last) {
            hook.fail_at(
                &[json!("steps"), json!(i), json!("optional")],
                "The first and the last step cannot be optional",
            );
        }
    }
    let exclusions = field(value, "exclusions")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    for (i, exclusion) in exclusions.iter().enumerate() {
        if exclusion
            .get("toStep")
            .and_then(Value::as_f64)
            .is_some_and(|to| last.map_or(to > -1.0, |last| to > f64::from(clamp_u32(last))))
        {
            hook.fail_at(
                &[json!("exclusions"), json!(i), json!("toStep")],
                "The funnel has no such step",
            );
        }
    }
    if text(field(value, "order")) == Some("any") && !exclusions.is_empty() {
        hook.fail_at(&[json!("exclusions")], "Exclusions need the steps in order");
    }
}

/// `funnelSpecSchema`'s `superRefine(refineFunnel)`.
pub(crate) fn refine_funnel_spec(value: Option<&Value>, hook: &mut Hook) {
    refine_funnel(value, hook);
}

/// `funnelCorrelationSpecSchema`'s `superRefine(refineFunnel)`.
pub(crate) fn refine_funnel_correlation_spec(value: Option<&Value>, hook: &mut Hook) {
    refine_funnel(value, hook);
}

/// `impactSpecSchema`: `sum` and `avg` need a property.
pub(crate) fn refine_impact_spec(value: Option<&Value>, hook: &mut Hook) {
    let metric = field(value, "metric");
    let math = text(field(metric, "math")).unwrap_or_default();
    if matches!(math, "sum" | "avg") && field(metric, "property").is_none() {
        hook.fail_at(
            &[json!("metric"), json!("property")],
            "Choose the property to calculate",
        );
    }
}

/// `heatmapSpecSchema`: a page group or a URL pattern.
pub(crate) fn refine_heatmap_spec(value: Option<&Value>, hook: &mut Hook) {
    if field(value, "pageGroupId").is_none() && field(value, "urlPattern").is_none() {
        hook.fail_at(
            &[json!("pageGroupId")],
            "Choose a page group or a URL pattern",
        );
    }
}

/// `panelCohortConditionSchema`'s `performed` filters: no cohort in a cohort.
pub(crate) fn refine_panel_cohort_condition_or1_filters(value: Option<&Value>, hook: &mut Hook) {
    let nested = value.and_then(Value::as_array).is_some_and(|filters| {
        filters
            .iter()
            .any(|f| f.get("source").and_then(Value::as_str) == Some("cohort"))
    });
    if nested {
        hook.fail("Cohorts cannot nest");
    }
}

/// `panelCustomEventMatchSchema`'s event: never another custom event.
pub(crate) fn refine_panel_custom_event_match_event(value: Option<&Value>, hook: &mut Hook) {
    if text(value).is_some_and(|name| name.starts_with('@')) {
        hook.fail("A custom event cannot include another custom event");
    }
}

/// `updatePanelLexiconSchema`: something to change.
pub(crate) fn refine_update_panel_lexicon(value: Option<&Value>, hook: &mut Hook) {
    if ["description", "hidden", "verified"]
        .iter()
        .all(|key| field(value, key).is_none())
    {
        hook.fail("Nothing to update");
    }
}

/// The generated schemas against Zod itself: `zod_cases.json` holds bodies
/// with what `safeParseAsync` answered (`tools/zod-cases.mts`).
#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use weldsuite_zod::Z;

    use crate::schemas_gen::{
        PANEL_COHORT_FILTER, PANEL_COMPUTED_PROPERTY_DEFINITION, PANEL_CUSTOM_EVENT_DEFINITION,
        PANEL_QUERY_SPEC, UPDATE_PANEL_LEXICON,
    };

    fn schema(name: &str) -> &'static Z {
        match name {
            "PANEL_QUERY_SPEC" => &PANEL_QUERY_SPEC,
            "PANEL_COHORT_FILTER" => &PANEL_COHORT_FILTER,
            "PANEL_CUSTOM_EVENT_DEFINITION" => &PANEL_CUSTOM_EVENT_DEFINITION,
            "PANEL_COMPUTED_PROPERTY_DEFINITION" => &PANEL_COMPUTED_PROPERTY_DEFINITION,
            "UPDATE_PANEL_LEXICON" => &UPDATE_PANEL_LEXICON,
            other => panic!("no schema {other}"),
        }
    }

    #[test]
    fn parse_as_zod_does() {
        let cases: Value = serde_json::from_str(include_str!("zod_cases.json")).expect("the cases");
        let mut failures = Vec::new();
        for case in cases["cases"].as_array().expect("a list") {
            let name = case["name"].as_str().unwrap_or("?");
            let found = match weldsuite_zod::parse_issues(
                schema(case["schema"].as_str().unwrap_or_default()),
                &case["input"],
            ) {
                Ok(parsed) => json!({ "success": true, "data": Value::Object(parsed.body) }),
                Err(issues) => json!({
                    "success": false,
                    "error": { "issues": issues, "name": "ZodError" }
                }),
            };
            if found != case["output"] {
                failures.push(format!(
                    "{name}:\n  zod:  {}\n  rust: {found}",
                    case["output"]
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    /// What the compiler reads: a parsed spec in the domain's types.
    #[test]
    fn a_parsed_spec_reads_as_the_compilers() {
        let parsed = weldsuite_zod::parse_issues(
            &PANEL_QUERY_SPEC,
            &json!({ "kind": "sessions", "projectId": "pnp_a", "favoritesOnly": true }),
        )
        .expect("a spec");
        let spec: weldsuite_panel_domain::schemas::PanelQuerySpec =
            serde_json::from_value(Value::Object(parsed.body)).expect("the compiler's spec");
        assert_eq!(spec.project_id(), "pnp_a");
    }
}
