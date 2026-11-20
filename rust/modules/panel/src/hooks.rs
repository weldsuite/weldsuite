//! What WeldPanel's Zod schemas compute in JavaScript: the `.refine()` and
//! `.superRefine()` checks the generated schemas (`schemas_gen.rs`) call,
//! each named after its schema (`weldpanel-query.ts`, `weldpanel-collab.ts`,
//! `weldpanel-objects.ts`). Each gets the value its schema parsed (defaults
//! filled in) and adds Zod's `custom` issues with the TypeScript's messages
//! and paths.

use serde_json::{Value, json};
use weldsuite_panel_domain::schemas::collab::{
    panel_path_pattern_problem, panel_path_replacement_problem,
};
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

/// `.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to
/// update')`: the parsed object holds a key.
fn something_to_update(value: Option<&Value>, hook: &mut Hook) {
    if value
        .and_then(Value::as_object)
        .is_some_and(serde_json::Map::is_empty)
    {
        hook.fail("Nothing to update");
    }
}

/// `updatePanelReportSchema`.
pub(crate) fn refine_update_panel_report(value: Option<&Value>, hook: &mut Hook) {
    something_to_update(value, hook);
}

/// `updatePanelDashboardSchema`.
pub(crate) fn refine_update_panel_dashboard(value: Option<&Value>, hook: &mut Hook) {
    something_to_update(value, hook);
}

/// `updatePanelDashboardTileSchema`.
pub(crate) fn refine_update_panel_dashboard_tile(value: Option<&Value>, hook: &mut Hook) {
    something_to_update(value, hook);
}

/// `updatePanelCohortSchema`.
pub(crate) fn refine_update_panel_cohort(value: Option<&Value>, hook: &mut Hook) {
    something_to_update(value, hook);
}

/// `updatePanelCustomEventSchema`.
pub(crate) fn refine_update_panel_custom_event(value: Option<&Value>, hook: &mut Hook) {
    something_to_update(value, hook);
}

/// `updatePanelComputedPropertySchema`.
pub(crate) fn refine_update_panel_computed_property(value: Option<&Value>, hook: &mut Hook) {
    something_to_update(value, hook);
}

/// `updatePanelAnnotationSchema`.
pub(crate) fn refine_update_panel_annotation(value: Option<&Value>, hook: &mut Hook) {
    something_to_update(value, hook);
}

/// `updatePanelMetricTreeSchema`.
pub(crate) fn refine_update_panel_metric_tree(value: Option<&Value>, hook: &mut Hook) {
    something_to_update(value, hook);
}

/// `createPanelReportSchema`: a kind a report may have
/// (`PANEL_REPORT_SPEC_KINDS`), at `spec`.
pub(crate) fn refine_create_panel_report(value: Option<&Value>, hook: &mut Hook) {
    let kind = text(field(field(value, "spec"), "kind")).unwrap_or_default();
    if !crate::saved::REPORT_SPEC_KINDS.contains(&kind) {
        hook.fail_at(&[json!("spec")], "Unsupported report kind");
    }
}

/// `panelPathRuleInputSchema`'s pattern: `panelPathPatternProblem`.
pub(crate) fn refine_panel_path_rule_input_pattern(value: Option<&Value>, hook: &mut Hook) {
    if let Some(problem) = text(value).and_then(panel_path_pattern_problem) {
        hook.fail(&problem);
    }
}

/// `panelPathRuleInputSchema`'s replacement: `panelPathReplacementProblem`.
pub(crate) fn refine_panel_path_rule_input_replacement(value: Option<&Value>, hook: &mut Hook) {
    if let Some(problem) = text(value).and_then(panel_path_replacement_problem) {
        hook.fail(&problem);
    }
}

/// `testPanelPathRulesSchema`: rules, or a project to read them from.
pub(crate) fn refine_test_panel_path_rules(value: Option<&Value>, hook: &mut Hook) {
    if field(value, "rules").is_none() && field(value, "projectId").is_none() {
        hook.fail_at(&[json!("rules")], "Send rules or a project");
    }
}

/// `panelSingleSeriesTrendsSpecSchema`: one series.
pub(crate) fn refine_panel_single_series_trends_spec(value: Option<&Value>, hook: &mut Hook) {
    let series = field(value, "series")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if series != 1 {
        hook.fail_at(&[json!("series")], "A metric is one series");
    }
}

/// `panelMetricTreeNodesSchema`: `panelMetricTreeProblem`.
pub(crate) fn refine_panel_metric_tree_nodes(value: Option<&Value>, hook: &mut Hook) {
    let nodes = value
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    if let Some(problem) = metric_tree_problem(nodes) {
        hook.fail(&problem);
    }
}

/// `panelMetricTreeProblem(nodes)`: unique ids, one root without a
/// relation, parents that exist, no cycles.
pub(crate) fn metric_tree_problem(nodes: &[Value]) -> Option<String> {
    let id = |node: &Value| text(node.get("id")).unwrap_or_default().to_owned();
    let parent = |node: &Value| text(node.get("parentId")).map(str::to_owned);
    let mut ids: Vec<String> = Vec::with_capacity(nodes.len());
    for node in nodes {
        let node_id = id(node);
        if ids.contains(&node_id) {
            return Some(format!("Two nodes have the id \"{node_id}\""));
        }
        ids.push(node_id);
    }
    let roots: Vec<&Value> = nodes.iter().filter(|n| parent(n).is_none()).collect();
    if roots.len() != 1 {
        return Some("A tree has exactly one root".to_owned());
    }
    if !roots[0].get("relation").is_some_and(Value::is_null) {
        return Some("The root has no relation".to_owned());
    }
    // `new Map(nodes.map((n) => [n.id, n.parentId]))`: the ids are unique here.
    let parent_of = |at: &str| nodes.iter().find(|n| id(n) == at).and_then(parent);
    for node in nodes {
        if let Some(parent_id) = parent(node)
            && !ids.contains(&parent_id)
        {
            return Some(format!("Node \"{}\" has an unknown parent", id(node)));
        }
        let mut seen: Vec<String> = Vec::new();
        let mut at = Some(id(node));
        while let Some(current) = at {
            if seen.contains(&current) {
                return Some("The nodes form a cycle".to_owned());
            }
            at = parent_of(&current);
            seen.push(current);
        }
    }
    None
}

/// `panelGroupMatchPropertySchema`: a property key, `$` allowed.
pub(crate) fn refine_panel_group_match_property(value: Option<&Value>, hook: &mut Hook) {
    if let Some(key) = text(value)
        && !property_key(key)
    {
        hook.fail("Not a valid property key");
    }
}

/// `updatePanelGroupTypeSchema`: a name or the CRM match to change.
pub(crate) fn refine_update_panel_group_type(value: Option<&Value>, hook: &mut Hook) {
    if ["nameSingular", "namePlural", "crmMatchProperty"]
        .iter()
        .all(|key| field(value, key).is_none())
    {
        hook.fail("Nothing to change");
    }
}

/// `explainPanelChangeSchema`'s `period`: `from <= to` (JavaScript's string
/// order).
pub(crate) fn refine_explain_panel_change_inner_period(value: Option<&Value>, hook: &mut Hook) {
    refine_panel_date_range_or1(value, hook);
}

/// `explainPanelChangeSchema`'s `properties`: event or person properties only.
pub(crate) fn refine_explain_panel_change_inner_properties(value: Option<&Value>, hook: &mut Hook) {
    let all_props = value.and_then(Value::as_array).is_none_or(|list| {
        list.iter()
            .all(|b| matches!(text(b.get("source")), Some("event" | "person")))
    });
    if !all_props {
        hook.fail("Use event or person properties");
    }
}

/// `PANEL_EXPLAINABLE_MATHS`: maths whose parts add up to the whole.
const EXPLAINABLE_MATHS: [&str; 5] = ["total", "unique_users", "unique_groups", "sessions", "sum"];

/// `explainPanelChangeSchema`'s `superRefine`: the request's project, one
/// series of a math that can be split, a bucket or a period.
pub(crate) fn refine_explain_panel_change(value: Option<&Value>, hook: &mut Hook) {
    let spec = field(value, "spec");
    if text(field(spec, "projectId")) != text(field(value, "projectId")) {
        hook.fail_at(
            &[json!("spec"), json!("projectId")],
            "The spec names another project",
        );
    }
    let series = field(spec, "series")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    if series.len() != 1 {
        hook.fail_at(
            &[json!("spec"), json!("series")],
            "Explain one series at a time",
        );
    }
    if let Some(math) = series.first().and_then(|s| text(s.get("math")))
        && !math.is_empty()
        && !EXPLAINABLE_MATHS.contains(&math)
    {
        hook.fail_at(
            &[json!("spec"), json!("series"), json!(0), json!("math")],
            "Root cause works on counts and sums",
        );
    }
    let bucket = text(field(value, "bucket")).is_some_and(|b| !b.is_empty());
    if bucket && field(value, "period").is_some_and(|p| !p.is_null()) {
        hook.fail_at(&[json!("period")], "Choose a bucket or a period, not both");
    }
}

/// The generated schemas against Zod itself: `zod_cases.json` holds bodies
/// with what `safeParseAsync` answered (`tools/zod-cases.mts`).
#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use weldsuite_zod::Z;

    use crate::schemas_gen::{
        ADD_PANEL_DASHBOARD_TILE, CREATE_PANEL_DASHBOARD, CREATE_PANEL_GROUP_TYPE,
        CREATE_PANEL_METRIC_TREE, CREATE_PANEL_REPORT, CREATE_PANEL_SHARE_LINK,
        EXPLAIN_PANEL_CHANGE, PANEL_ANNOTATION_LIST_QUERY, PANEL_COHORT_FILTER,
        PANEL_COMPUTED_PROPERTY_DEFINITION, PANEL_CUSTOM_EVENT_DEFINITION, PANEL_QUERY_SPEC,
        SET_PANEL_PATH_RULES, SUMMARISE_PANEL_SET, TEST_PANEL_PATH_RULES, UPDATE_PANEL_GROUP_TYPE,
        UPDATE_PANEL_LEXICON, UPDATE_PANEL_REPORT,
    };

    fn schema(name: &str) -> &'static Z {
        match name {
            "PANEL_QUERY_SPEC" => &PANEL_QUERY_SPEC,
            "PANEL_COHORT_FILTER" => &PANEL_COHORT_FILTER,
            "PANEL_CUSTOM_EVENT_DEFINITION" => &PANEL_CUSTOM_EVENT_DEFINITION,
            "PANEL_COMPUTED_PROPERTY_DEFINITION" => &PANEL_COMPUTED_PROPERTY_DEFINITION,
            "UPDATE_PANEL_LEXICON" => &UPDATE_PANEL_LEXICON,
            "CREATE_PANEL_REPORT" => &CREATE_PANEL_REPORT,
            "UPDATE_PANEL_REPORT" => &UPDATE_PANEL_REPORT,
            "CREATE_PANEL_DASHBOARD" => &CREATE_PANEL_DASHBOARD,
            "ADD_PANEL_DASHBOARD_TILE" => &ADD_PANEL_DASHBOARD_TILE,
            "CREATE_PANEL_METRIC_TREE" => &CREATE_PANEL_METRIC_TREE,
            "SET_PANEL_PATH_RULES" => &SET_PANEL_PATH_RULES,
            "TEST_PANEL_PATH_RULES" => &TEST_PANEL_PATH_RULES,
            "CREATE_PANEL_SHARE_LINK" => &CREATE_PANEL_SHARE_LINK,
            "PANEL_ANNOTATION_LIST_QUERY" => &PANEL_ANNOTATION_LIST_QUERY,
            "CREATE_PANEL_GROUP_TYPE" => &CREATE_PANEL_GROUP_TYPE,
            "UPDATE_PANEL_GROUP_TYPE" => &UPDATE_PANEL_GROUP_TYPE,
            "EXPLAIN_PANEL_CHANGE" => &EXPLAIN_PANEL_CHANGE,
            "SUMMARISE_PANEL_SET" => &SUMMARISE_PANEL_SET,
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
