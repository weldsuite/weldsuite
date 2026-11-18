//! What the newer spec options compile to and how engine rows become
//! results for every newer kind and option: the port of
//! `packages/domains/panel/src/query/analysis.test.ts`, same contexts, specs,
//! canned rows and expected values. (Its schema-refusal cases are Zod's and
//! belong to the routes.)

// The expectations are the TypeScript's, compared exactly as JavaScript does.
#![allow(clippy::float_cmp)]

mod common;

use common::{num, refusal, run_with, spec};
use serde_json::{Value, json};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::PanelQueryContext;
use weldsuite_panel_domain::query::breakdowns::auto_edges;
use weldsuite_panel_domain::query::explain::{
    ExplainDimension, ExplainInput, explain_dimensions, explain_from, explain_queries,
    explain_windows,
};
use weldsuite_panel_domain::query::paths::{apply_path_rules, path_rule_problem};
use weldsuite_panel_domain::query::refs::{SpecReferences, spec_references};
use weldsuite_panel_domain::query::signal::signal_candidate;
use weldsuite_panel_domain::query::time::resolve_range;
use weldsuite_panel_domain::query::vitals::vitals_score;
use weldsuite_panel_domain::schemas::{PanelBreakdown, PanelQuerySpec, PathRule, VitalsMetric};

fn ctx() -> PanelQueryContext {
    serde_json::from_value(json!({
        "workspaceId": "ws_1",
        "projectId": "pnp_1",
        "retentionDays": 365,
        "hasIdentifiedUsers": false,
        "erasedIds": [],
        "now": "2026-11-14T12:00:00.000Z",
        "customEvents": {
            "pnce_signup": {
                "match": [
                    { "event": "Signed up", "filters": [] },
                    { "event": "$pageview", "filters": [{ "source": "column", "field": "path", "operator": "eq", "value": "/welcome" }] }
                ]
            }
        },
        "computedProperties": {
            "pncp_revenue": { "kind": "formula", "expression": "price * quantity / 100" },
            "pncp_label": { "kind": "coalesce", "keys": [{ "source": "event", "key": "label" }, { "source": "column", "field": "title" }] },
            "pncp_broken": { "kind": "formula", "expression": "price *" }
        },
        "pathRules": [
            { "pattern": "^/users/\\d+", "replacement": "/users/:id" },
            { "pattern": "/o'rders/[0-9]+", "replacement": "/orders/:id" }
        ],
        "groupTypes": ["company"]
    }))
    .expect("a context")
}

async fn run(spec_json: Value, canned: Value) -> common::Ran {
    run_with(spec_json, canned, &ctx()).await
}

#[test]
fn saved_specs_from_before_parse_and_gain_no_new_keys() {
    let old = [
        json!({ "kind": "web", "projectId": "p", "dateRange": { "preset": "30d" }, "compare": true, "limit": 10, "filters": [] }),
        json!({
            "kind": "trends",
            "projectId": "p",
            "series": [{ "event": "$pageview", "math": "unique_users" }, { "event": "Purchase", "math": "sum", "property": "amount" }],
            "breakdown": { "source": "person", "key": "plan", "limit": 5 },
            "interval": "week",
            "display": "bar"
        }),
        json!({ "kind": "funnel", "projectId": "p", "steps": [{ "event": "A" }, { "event": "B" }], "window": { "value": 2, "unit": "hour" }, "order": "strict", "breakdown": { "source": "column", "field": "country" } }),
        json!({ "kind": "retention", "projectId": "p", "firstEvent": "Signed up", "returnEvent": "Login", "interval": "month", "periods": 6 }),
        json!({ "kind": "flows", "projectId": "p", "anchor": { "event": "Purchase" }, "direction": "before", "depth": 4, "scope": "pageviews" }),
    ];
    let new_keys = [
        "breakdowns",
        "formulas",
        "formulaOnly",
        "cleanPaths",
        "panels",
        "goals",
        "exclusions",
        "holdConstant",
        "aggregateBy",
        "mode",
        "unbounded",
    ];
    for raw in old {
        let parsed = serde_json::to_value(spec(raw)).expect("serializes");
        for key in new_keys {
            assert!(parsed.get(key).is_none(), "{}.{key}", parsed["kind"]);
        }
        for step in parsed
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            assert!(step.get("optional").is_none());
        }
    }
}

#[tokio::test]
async fn expands_a_custom_event_into_its_events_and_filters_and_prefilters_by_name() {
    let ran = run(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "@pnce_signup" }] }),
        json!({}),
    )
    .await;
    let sql = ran.sql("trends.series");
    assert!(sql.contains(
        "COUNT(CASE WHEN ((e.name = 'Signed up') OR (e.name = '$pageview' AND (e.path = '/welcome'))) THEN 1 END)"
    ));
    assert!(sql.contains("e.name IN ('Signed up', '$pageview')"));
}

#[tokio::test]
async fn refuses_a_custom_event_or_computed_property_the_context_does_not_hold() {
    let message = refusal(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "@pnce_other" }] }),
        &ctx(),
    )
    .await;
    assert!(message.contains("custom event does not exist"));
    let message = refusal(
        json!({ "kind": "web", "projectId": "pnp_1", "filters": [{ "source": "event", "key": "@pncp_other", "operator": "is_set" }] }),
        &ctx(),
    )
    .await;
    assert!(message.contains("computed property does not exist"));
    let message = refusal(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "A", "math": "sum", "property": "@pncp_broken" }] }),
        &ctx(),
    )
    .await;
    assert!(message.starts_with("A computed property's formula does not parse"));
}

#[tokio::test]
async fn writes_a_formula_computed_property_through_the_expression_compiler() {
    let ran = run(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "Purchase", "math": "sum", "property": "@pncp_revenue" }] }),
        json!({}),
    )
    .await;
    assert!(ran.sql("trends.series").contains(
        "SUM(CASE WHEN e.name = 'Purchase' THEN (((json_get_float(e.properties, 'price')) * (json_get_float(e.properties, 'quantity'))) / NULLIF(100.0, 0)) END)"
    ));
}

#[tokio::test]
async fn writes_a_coalesce_computed_property_over_properties_and_columns() {
    let ran = run(
        json!({ "kind": "web", "projectId": "pnp_1", "filters": [{ "source": "event", "key": "@pncp_label", "operator": "eq", "value": "it's" }] }),
        json!({}),
    )
    .await;
    assert!(ran.sent[0].sql.contains(
        "(COALESCE(json_get_str(e.properties, 'label'), CAST(e.title AS VARCHAR)) = 'it''s')"
    ));
}

#[tokio::test]
async fn joins_the_latest_group_profile_and_refuses_unknown_group_types() {
    let ran = run(
        json!({
            "kind": "trends",
            "projectId": "pnp_1",
            "filters": [{ "source": "group", "groupType": "company", "key": "plan", "operator": "eq", "value": "pro" }],
            "series": [{ "event": "A", "math": "unique_groups", "groupType": "company" }]
        }),
        json!({}),
    )
    .await;
    let sql = ran.sql("trends.series");
    assert!(sql.contains("FROM panel.groups_v1 WHERE workspace_id = "));
    assert!(sql.contains("group_type = 'company'"));
    assert!(sql.contains(
        "g_company ON g_company.group_key = json_get_str(e.properties, '$group_company')"
    ));
    assert!(sql.contains("(json_get_str(g_company.properties, 'plan') = 'pro')"));
    assert!(sql.contains(
        "COUNT(DISTINCT CASE WHEN e.name = 'A' AND json_get_str(e.properties, '$group_company') IS NOT NULL THEN json_get_str(e.properties, '$group_company') END)"
    ));
    let message = refusal(
        json!({ "kind": "web", "projectId": "pnp_1", "filters": [{ "source": "group_key", "groupType": "team", "operator": "is_set" }] }),
        &ctx(),
    )
    .await;
    assert!(message.contains("group type does not exist"));
}

#[tokio::test]
async fn cleans_paths_with_the_rules_in_order_unless_switched_off() {
    let ran = run(json!({ "kind": "web", "projectId": "pnp_1" }), json!({})).await;
    assert!(ran.sql("web.topPages").contains(
        "regexp_replace(regexp_replace(e.path, ('^/users/' || chr(92) || 'd+'), '/users/:id', 'g'), '/o''rders/[0-9]+', '/orders/:id', 'g')"
    ));
    assert!(ran.sql("web.entryExit").contains("regexp_replace("));
    let off = run(
        json!({ "kind": "web", "projectId": "pnp_1", "cleanPaths": false }),
        json!({}),
    )
    .await;
    assert!(!off.sent.iter().any(|q| q.sql.contains("regexp_replace")));
}

#[tokio::test]
async fn refuses_path_rules_the_engine_cannot_run() {
    for pattern in ["(?=x)", "(a)\\1", "[", "x*"] {
        let context = PanelQueryContext {
            path_rules: Some(vec![PathRule {
                pattern: pattern.to_owned(),
                replacement: String::new(),
            }]),
            ..ctx()
        };
        let message = refusal(
            json!({ "kind": "flows", "projectId": "pnp_1", "anchor": { "event": "A" } }),
            &context,
        )
        .await;
        assert!(
            message.starts_with("A path rule cannot be used"),
            "{pattern}: {message}"
        );
    }
    let rule = |pattern: &str, replacement: &str| PathRule {
        pattern: pattern.to_owned(),
        replacement: replacement.to_owned(),
    };
    assert!(
        path_rule_problem(&rule("/a", "$&"))
            .expect("refused")
            .contains("$1")
    );
    assert_eq!(path_rule_problem(&rule("^/users/\\d+", "/users/:id")), None);
    assert_eq!(
        apply_path_rules(
            "/users/42/settings",
            ctx().path_rules.as_deref().unwrap_or_default()
        ),
        "/users/:id/settings"
    );
}

#[tokio::test]
async fn buckets_numbers_with_custom_edges_and_auto_edges_from_a_first_statement() {
    let custom = run(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "A" }], "breakdown": { "source": "event", "key": "amount", "bucket": { "kind": "custom", "edges": [10, 50] } } }),
        json!({}),
    )
    .await;
    assert!(custom.sql("trends.breakdownValues").contains(
        "CASE WHEN json_get_float(e.properties, 'amount') IS NULL THEN '(none)' WHEN json_get_float(e.properties, 'amount') < 10 THEN '< 10' WHEN json_get_float(e.properties, 'amount') < 50 THEN '10 – 50' ELSE '≥ 50' END"
    ));
    let auto = run(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "A" }], "breakdown": { "source": "event", "key": "amount", "bucket": { "kind": "auto", "count": 4 } } }),
        json!({ "trends.breakdownRange": [{ "min0": 3, "max0": 97 }] }),
    )
    .await;
    assert_eq!(
        auto.names(),
        [
            "trends.breakdownRange",
            "trends.breakdownValues",
            "trends.series",
            "trends.totals"
        ]
    );
    assert!(
        auto.sql("trends.breakdownValues")
            .contains("< 25 THEN '< 25'")
    );
    assert_eq!(auto_edges(3.0, 97.0, 4), [25.0, 50.0, 75.0]);
    assert_eq!(auto_edges(5.0, 5.0, 4), [5.0]);
}

#[test]
fn collects_what_a_spec_refers_to_for_panel_api_to_load() {
    let refs = spec_references(&spec(json!({
        "kind": "funnel",
        "projectId": "p",
        "filters": [{ "source": "cohort", "cohortId": "pnc_1" }],
        "steps": [{ "event": "@pnce_a" }, { "event": "B", "filters": [{ "source": "event", "key": "@pncp_x", "operator": "is_set" }] }],
        "exclusions": [{ "event": "@pnce_b", "fromStep": 0, "toStep": 1 }],
        "breakdowns": [{ "source": "column", "field": "path" }],
        "aggregateBy": { "groupType": "company" }
    })));
    assert_eq!(
        refs,
        SpecReferences {
            cohort_ids: vec!["pnc_1".to_owned()],
            custom_event_ids: vec!["pnce_a".to_owned(), "pnce_b".to_owned()],
            computed_property_ids: vec!["pncp_x".to_owned()],
            group_types: vec!["company".to_owned()],
            uses_path_rules: true,
        }
    );
}

#[tokio::test]
async fn trends_evaluates_formulas_per_bucket_and_on_the_totals_null_where_it_divides_by_zero() {
    let ran = run(
        json!({
            "kind": "trends",
            "projectId": "pnp_1",
            "dateRange": { "from": "2026-11-10", "to": "2026-11-11" },
            "series": [{ "event": "A" }, { "event": "B" }],
            "formulas": [{ "expression": "B / A * 100", "label": "Rate" }]
        }),
        json!({
            "trends.series": [{ "bucket": "2026-11-10", "s0_v": 4, "s1_v": 1 }, { "bucket": "2026-11-11", "s0_v": 0, "s1_v": 3 }],
            "trends.totals": [{ "s0_v": 4, "s1_v": 4 }]
        }),
    )
    .await;
    assert_eq!(ran.out()["series"].as_array().map(Vec::len), Some(2));
    assert_eq!(
        ran.out()["formulas"],
        json!([{
            "formulaIndex": 0,
            "label": "Rate",
            "expression": "B / A * 100",
            "breakdownValue": null,
            "total": 100,
            "points": [{ "bucket": "2026-11-10", "value": 25 }, { "bucket": "2026-11-11", "value": null }],
            "previous": null
        }])
    );
}

#[tokio::test]
async fn trends_shows_only_the_formulas_and_refuses_a_letter_past_the_series() {
    let ran = run(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "A" }], "formulas": [{ "expression": "A * 2" }], "formulaOnly": true }),
        json!({}),
    )
    .await;
    assert_eq!(ran.out()["series"], json!([]));
    assert_eq!(ran.out()["formulas"].as_array().map(Vec::len), Some(1));
    let message = refusal(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "A" }], "formulas": [{ "expression": "A / B" }] }),
        &ctx(),
    )
    .await;
    assert!(message.contains("no series B"));
}

#[tokio::test]
async fn trends_runs_cumulative_totals_summed_for_counts_first_seen_for_people() {
    let ran = run(
        json!({
            "kind": "trends",
            "projectId": "pnp_1",
            "dateRange": { "from": "2026-11-10", "to": "2026-11-12" },
            "series": [{ "event": "A" }, { "event": "A", "math": "unique_users" }],
            "display": "cumulative"
        }),
        json!({
            "trends.series": [
                { "bucket": "2026-11-10", "s0_v": 2, "s1_v": 2 },
                { "bucket": "2026-11-11", "s0_v": 3, "s1_v": 2 },
                { "bucket": "2026-11-12", "s0_v": 1, "s1_v": 1 }
            ],
            "trends.firstSeen.s1": [{ "bucket": "2026-11-10", "n": 2 }, { "bucket": "2026-11-11", "n": 1 }]
        }),
    )
    .await;
    let values = |i: usize| -> Vec<f64> {
        ran.out()["series"][i]["points"]
            .as_array()
            .expect("points")
            .iter()
            .map(|p| num(&p["value"]))
            .collect()
    };
    assert_eq!(ran.out()["cumulative"], json!(true));
    assert_eq!(values(0), [2.0, 5.0, 6.0]);
    assert_eq!(values(1), [2.0, 3.0, 3.0]);
    assert!(ran.names().contains(&"trends.firstSeen.s1".to_owned()));
    assert!(!ran.names().contains(&"trends.firstSeen.s0".to_owned()));
}

#[tokio::test]
async fn trends_joins_several_breakdowns_and_keeps_their_parts() {
    let ran = run(
        json!({
            "kind": "trends",
            "projectId": "pnp_1",
            "dateRange": { "from": "2026-11-10", "to": "2026-11-10" },
            "series": [{ "event": "A" }],
            "breakdowns": [{ "source": "column", "field": "country" }, { "source": "column", "field": "browser" }]
        }),
        json!({
            "trends.breakdownValues": [{ "value": "NL / Chrome", "v0": "NL", "v1": "Chrome", "n": 5 }],
            "trends.series": [{ "bucket": "2026-11-10", "bd": "NL / Chrome", "s0_v": 5 }, { "bucket": "2026-11-10", "bd": "Other", "s0_v": 1 }],
            "trends.totals": [{ "bd": "NL / Chrome", "s0_v": 5 }, { "bd": "Other", "s0_v": 1 }]
        }),
    )
    .await;
    let lines: Vec<Value> = ran.out()["series"]
        .as_array()
        .expect("series")
        .iter()
        .map(|s| json!([s["breakdownValue"], s["breakdownParts"], s["total"]]))
        .collect();
    assert_eq!(
        lines,
        vec![
            json!(["NL / Chrome", ["NL", "Chrome"], 5]),
            json!(["Other", null, 1])
        ]
    );
}

#[tokio::test]
async fn funnel_measures_conversion_after_an_optional_step_against_the_last_required_one() {
    let ran = run(
        json!({ "kind": "funnel", "projectId": "pnp_1", "steps": [{ "event": "A" }, { "event": "B", "optional": true }, { "event": "C" }] }),
        json!({ "funnel.steps": [{ "step": 1, "bd": "", "persons": 10 }, { "step": 2, "bd": "", "persons": 2 }, { "step": 3, "bd": "", "persons": 5, "avg_secs": 60 }] }),
    )
    .await;
    let steps: Vec<Value> = ran.out()["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .map(|s| {
            json!([
                s["count"],
                s["conversionFromPrevious"],
                s.get("optional").cloned().unwrap_or(json!(false))
            ])
        })
        .collect();
    assert_eq!(
        steps,
        vec![
            json!([10, 1, false]),
            json!([2, 0.2, true]),
            json!([5, 0.5, false])
        ]
    );
    assert_eq!(num(&ran.out()["overallConversion"]), 0.5);
}

#[tokio::test]
async fn funnel_adds_time_to_convert_per_step_and_overall() {
    let ran = run(
        json!({ "kind": "funnel", "projectId": "pnp_1", "steps": [{ "event": "A" }, { "event": "B" }], "display": "time_to_convert" }),
        json!({
            "funnel.steps": [{ "step": 1, "bd": "", "persons": 4 }, { "step": 2, "bd": "", "persons": 2 }],
            "funnel.timeToConvert": [
                { "step": 0, "n": 2, "p50": 45.4, "p90": 80, "avg_secs": 50, "h0": 0, "h1": 1, "h2": 1 },
                { "step": 2, "n": 2, "p50": 45.4, "p90": 80, "avg_secs": 50, "h1": 1, "h3": 1 }
            ]
        }),
    )
    .await;
    let ttc = &ran.out()["timeToConvert"];
    assert_eq!(ttc["overall"]["count"], json!(2));
    assert_eq!(ttc["overall"]["medianSeconds"], json!(45));
    assert_eq!(ttc["overall"]["p90Seconds"], json!(80));
    assert_eq!(ttc["overall"]["avgSeconds"], json!(50));
    assert_eq!(
        ttc["overall"]["histogram"].as_array().map(Vec::len),
        Some(11)
    );
    assert_eq!(
        ttc["overall"]["histogram"][1],
        json!({ "fromSeconds": 10, "toSeconds": 30, "count": 1 })
    );
    assert_eq!(
        ttc["overall"]["histogram"][10],
        json!({ "fromSeconds": 604_800, "toSeconds": null, "count": 0 })
    );
    assert_eq!(ttc["steps"].as_array().map(Vec::len), Some(1));
    assert_eq!(ttc["steps"][0]["index"], json!(1));
}

#[tokio::test]
async fn funnel_adds_conversion_per_entry_bucket_for_the_trends_display() {
    let ran = run(
        json!({ "kind": "funnel", "projectId": "pnp_1", "dateRange": { "from": "2026-11-10", "to": "2026-11-11" }, "steps": [{ "event": "A" }, { "event": "B" }], "display": "trends" }),
        json!({ "funnel.trend": [{ "bucket": "2026-11-10 00:00:00", "entered": 4, "converted": 1 }] }),
    )
    .await;
    assert_eq!(ran.out()["interval"], json!("day"));
    assert_eq!(
        ran.out()["trend"],
        json!([
            { "bucket": "2026-11-10", "entered": 4, "converted": 1, "conversion": 0.25 },
            { "bucket": "2026-11-11", "entered": 0, "converted": 0, "conversion": 0 }
        ])
    );
}

#[tokio::test]
async fn funnel_correlation_ranks_by_odds_ratio_with_the_group_sizes_from_the_total_row() {
    let ran = run(
        json!({ "kind": "funnel_correlation", "projectId": "pnp_1", "steps": [{ "event": "A" }, { "event": "B" }], "limit": 1 }),
        json!({
            "correlation.events": [
                { "value": "Watched demo", "success": 40, "failure": 10 },
                { "value": "Opened help", "success": 5, "failure": 45 },
                { "value": "Rare", "success": 1, "failure": 0 },
                { "value": "Neutral", "success": 25, "failure": 25 }
            ],
            "correlation.properties": [
                { "prop": "$total", "value": "", "success": 50, "failure": 50 },
                { "prop": "country", "value": "NL", "success": 30, "failure": 10 }
            ]
        }),
    )
    .await;
    let out = ran.out();
    assert_eq!(out["converted"], json!(50));
    assert_eq!(out["dropped"], json!(50));
    let events: Vec<Value> = out["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(|r| json!([r["value"], r["correlation"]]))
        .collect();
    assert_eq!(
        events,
        vec![
            json!(["Opened help", "negative"]),
            json!(["Watched demo", "positive"])
        ]
    );
    let demo = out["events"]
        .as_array()
        .expect("events")
        .iter()
        .find(|r| r["value"] == json!("Watched demo"))
        .expect("demo");
    assert_eq!(num(&demo["successRateWith"]), 0.8);
    assert_eq!(num(&demo["successRateWithout"]), 0.2);
    let property = &out["properties"][0];
    assert_eq!(property["type"], json!("property"));
    assert_eq!(property["property"], json!("country"));
    assert_eq!(property["value"], json!("NL"));
    assert_eq!(property["correlation"], json!("positive"));
}

#[tokio::test]
async fn retention_counts_people_in_period_n_or_later_when_unbounded() {
    let ran = run(
        json!({ "kind": "retention", "projectId": "pnp_1", "dateRange": { "from": "2026-11-02", "to": "2026-11-14" }, "firstEvent": "A", "interval": "week", "periods": 2, "unbounded": true }),
        json!({
            "retention.sizes": [{ "cohort": "2026-11-02", "size": 10 }],
            "retention.returns": [
                { "cohort": "2026-11-02", "period": 0, "n": 3 },
                { "cohort": "2026-11-02", "period": 2, "n": 2 },
                { "cohort": "2026-11-02", "period": 5, "n": 1 }
            ]
        }),
    )
    .await;
    assert_eq!(ran.out()["cohorts"][0]["counts"], json!([6, 3, 3]));
    assert_eq!(ran.out()["unbounded"], json!(true));
}

#[tokio::test]
async fn retention_splits_the_table_by_breakdown_value() {
    let ran = run(
        json!({ "kind": "retention", "projectId": "pnp_1", "dateRange": { "from": "2026-11-02", "to": "2026-11-14" }, "firstEvent": "A", "periods": 1, "breakdown": { "source": "column", "field": "country" }, "mode": "first_time" }),
        json!({
            "retention.breakdownValues": [{ "value": "NL", "n": 4 }],
            "retention.sizes": [{ "cohort": "2026-11-02", "bd": "NL", "size": 4 }, { "cohort": "2026-11-02", "bd": "Other", "size": 2 }],
            "retention.returns": [{ "cohort": "2026-11-02", "bd": "NL", "period": 1, "n": 2 }]
        }),
    )
    .await;
    assert_eq!(ran.out()["cohorts"][0]["size"], json!(6));
    let tables: Vec<Value> = ran.out()["breakdowns"]
        .as_array()
        .expect("breakdowns")
        .iter()
        .map(|b| {
            json!([
                b["value"],
                b["cohorts"][0]["size"],
                b["cohorts"][0]["counts"]
            ])
        })
        .collect();
    assert_eq!(
        tables,
        vec![json!(["NL", 4, [0, 2]]), json!(["Other", 2, [0, 0]])]
    );
    assert!(
        ran.sql("retention.sizes")
            .contains("HAVING MIN(e.ts) >= TIMESTAMP")
    );
    assert_eq!(ran.out()["mode"], json!("first_time"));
}

#[tokio::test]
async fn stickiness_people_per_number_of_active_days_every_day_listed() {
    let ran = run(
        json!({ "kind": "stickiness", "projectId": "pnp_1", "dateRange": { "from": "2026-11-10", "to": "2026-11-12" }, "event": "A" }),
        json!({ "stickiness.units": [{ "n": 1, "units": 6 }, { "n": 3, "units": 2 }] }),
    )
    .await;
    assert_eq!(ran.out()["total"], json!(8));
    assert_eq!(ran.out()["intervalsInRange"], json!(3));
    let buckets: Vec<Value> = ran.out()["buckets"]
        .as_array()
        .expect("buckets")
        .iter()
        .map(|b| json!([b["label"], b["count"], b["share"]]))
        .collect();
    assert_eq!(
        buckets,
        vec![
            json!(["1", 6, 0.75]),
            json!(["2", 0, 0]),
            json!(["3", 2, 0.25])
        ]
    );
}

#[tokio::test]
async fn stickiness_times_done_in_buckets() {
    let ran = run(
        json!({ "kind": "stickiness", "projectId": "pnp_1", "event": "A", "measure": "count" }),
        json!({ "stickiness.units": [{ "n": 4, "units": 3 }, { "n": 8, "units": 1 }] }),
    )
    .await;
    let buckets = ran.out()["buckets"].as_array().expect("buckets");
    let labels: Vec<&str> = buckets
        .iter()
        .map(|b| b["label"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        labels,
        [
            "1", "2", "3", "4–5", "6–10", "11–20", "21–50", "51–100", "101+"
        ]
    );
    assert_eq!(buckets[4]["count"], json!(3));
    assert_eq!(buckets[8]["count"], json!(1));
}

#[tokio::test]
async fn lifecycle_new_returning_resurrecting_per_bucket_dormant_in_the_bucket_after() {
    let ran = run(
        json!({ "kind": "lifecycle", "projectId": "pnp_1", "dateRange": { "from": "2026-11-10", "to": "2026-11-11" }, "event": "A" }),
        json!({
            "lifecycle.buckets": [
                { "bucket": "2026-11-09", "status": "returning", "n": 4, "dormant_next": 3 },
                { "bucket": "2026-11-10", "status": "new", "n": 2, "dormant_next": 1 },
                { "bucket": "2026-11-10", "status": "returning", "n": 1, "dormant_next": 0 },
                { "bucket": "2026-11-11", "status": "resurrecting", "n": 5, "dormant_next": 5 }
            ]
        }),
    )
    .await;
    assert_eq!(
        ran.out()["buckets"],
        json!([
            { "bucket": "2026-11-10", "new": 2, "returning": 1, "resurrecting": 0, "dormant": 3 },
            { "bucket": "2026-11-11", "new": 0, "returning": 0, "resurrecting": 5, "dormant": 1 }
        ])
    );
    assert_eq!(
        ran.out()["totals"],
        json!({ "new": 2, "returning": 1, "resurrecting": 5, "dormant": 4 })
    );
}

#[tokio::test]
async fn vitals_percentile_shares_score_and_element_list_only_where_there_is_one() {
    let ran = run(
        json!({ "kind": "vitals", "projectId": "pnp_1", "metric": "lcp" }),
        json!({
            "vitals.summary": [{ "value": 2500, "samples": 10, "good": 6, "poor": 1 }],
            "vitals.paths": [{ "value": "/users/:id", "metric": 4200, "samples": 3 }]
        }),
    )
    .await;
    let out = ran.out();
    assert_eq!(out["value"], json!(2500));
    assert_eq!(out["rating"], json!("good"));
    assert_eq!(out["samples"], json!(10));
    assert_eq!(out["score"], json!(90));
    assert_eq!(out["unit"], json!("ms"));
    assert_eq!(
        out["shares"],
        json!({ "good": 0.6, "needsImprovement": 0.3, "poor": 0.1 })
    );
    assert_eq!(
        out["paths"],
        json!([{ "value": "/users/:id", "metric": 4200, "samples": 3, "rating": "poor" }])
    );
    assert!(
        ran.sql("vitals.summary")
            .contains("approx_percentile_cont(json_get_float(e.properties, '$lcp'), 0.75)")
    );
    assert!(ran.names().contains(&"vitals.elements".to_owned()));
    let ttfb = run(
        json!({ "kind": "vitals", "projectId": "pnp_1", "metric": "ttfb" }),
        json!({}),
    )
    .await;
    assert!(!ttfb.names().contains(&"vitals.elements".to_owned()));
    assert_eq!(vitals_score(VitalsMetric::Lcp, Some(4000.0)), Some(50.0));
    assert_eq!(vitals_score(VitalsMetric::Cls, Some(0.1)), Some(90.0));
    assert!(vitals_score(VitalsMetric::Inp, Some(50.0)).is_some_and(|s| s > 98.0));
}

#[tokio::test]
async fn impact_adopters_against_everyone_else_before_against_after() {
    let ran = run(
        json!({ "kind": "impact", "projectId": "pnp_1", "launchEvent": "Used AI", "launchDate": "2026-11-10", "metric": { "event": "Purchase" }, "windowDays": 3 }),
        json!({
            "impact.groups": [
                { "adopted": 1, "users": 10, "mb": 10, "ma": 30, "active_after": 10 },
                { "adopted": 0, "users": 30, "mb": 30, "ma": 36, "active_after": 20 }
            ],
            "impact.adoption": [{ "bucket": "2026-11-10", "n": 6 }, { "bucket": "2026-11-12", "n": 4 }]
        }),
    )
    .await;
    let out = ran.out();
    assert_eq!(
        out["adopters"],
        json!({ "users": 10, "before": 1, "after": 3, "change": 2 })
    );
    assert_eq!(
        out["nonAdopters"],
        json!({ "users": 30, "before": 1, "after": 1.2, "change": 0.2 })
    );
    assert_eq!(num(&out["differenceInDifferences"]), 1.8);
    assert_eq!(num(&out["relativeImpact"]), 1.8);
    let adoption: Vec<Value> = out["adoption"]
        .as_array()
        .expect("adoption")
        .iter()
        .map(|a| json!([a["bucket"], a["adopters"], a["rate"]]))
        .collect();
    assert_eq!(
        adoption,
        vec![
            json!(["2026-11-10", 6, 0.2]),
            json!(["2026-11-11", 6, 0.2]),
            json!(["2026-11-12", 10, 1.0 / 3.0])
        ]
    );
    // The launch is written literal-first, so the scope's bounds stay the only `e.ts >=` of the statement.
    assert!(
        ran.sql("impact.groups")
            .contains("TIMESTAMP '2026-11-10 00:00:00' <= e.ts")
    );
    let message = refusal(
        json!({ "kind": "impact", "projectId": "pnp_1", "launchEvent": "A", "launchDate": "2026-12-01", "metric": { "event": "B" } }),
        &ctx(),
    )
    .await;
    assert!(message.contains("in the future"));
}

#[tokio::test]
async fn signal_goal_rate_with_and_without_lift_and_phi() {
    let candidate =
        serde_json::to_value(signal_candidate("A", 100.0, 30.0, 15.0, 5.0)).expect("json");
    assert_eq!(
        js::json_numbers(candidate),
        json!({ "event": "A", "didUsers": 30, "didGoalRate": 0.5, "didNotUsers": 70, "didNotGoalRate": 0.0714, "lift": 7, "correlation": 0.491 })
    );
    assert_eq!(signal_candidate("B", 10.0, 5.0, 0.0, 0.0).correlation, None);

    let ran = run(
        json!({ "kind": "signal", "projectId": "pnp_1", "goal": { "event": "Purchase" }, "topN": 2 }),
        json!({
            "signal.candidates": [{ "name": "Login", "n": 9 }, { "name": "bad name\n", "n": 3 }],
            "signal.main": [{ "users": 100, "goal_users": 20, "c0_n": 30, "c0_g": 15, "c0_ng": 5 }]
        }),
    )
    .await;
    let events: Vec<&Value> = ran.out()["candidates"]
        .as_array()
        .expect("candidates")
        .iter()
        .map(|c| &c["event"])
        .collect();
    assert_eq!(events, [&json!("Login")]);
    assert_eq!(ran.out()["candidates"][0]["lift"], json!(7));
    assert_eq!(num(&ran.out()["goalRate"]), 0.2);
    assert!(
        ran.sql("signal.candidates")
            .contains("e.name NOT IN ('Purchase', '$pageleave'")
    );
    // A doer counts as reaching the goal only after their first candidate event.
    assert!(ran.sql("signal.main").contains("lg > f0"));
}

#[tokio::test]
async fn web_computes_goals_against_visitors_and_returns_the_asked_panels_only() {
    let ran = run(
        json!({
            "kind": "web",
            "projectId": "pnp_1",
            "panels": ["channels", "screenSizes"],
            "goals": [{ "label": "Signup", "event": "@pnce_signup" }, { "label": "Pricing", "pathPattern": "/pricing*" }]
        }),
        json!({
            "web.summary": [{ "visitors": 50, "visits": 60 }],
            "web.goals": [{ "g0_n": 12, "g0_u": 10, "g1_n": 30, "g1_u": 25 }],
            "web.channels": [{ "value": "Organic Search", "visitors": 20, "events": 40 }]
        }),
    )
    .await;
    let out = ran.out();
    assert_eq!(
        out["goals"],
        json!([
            { "label": "Signup", "conversions": 12, "uniqueConverters": 10, "conversionRate": 0.2 },
            { "label": "Pricing", "conversions": 30, "uniqueConverters": 25, "conversionRate": 0.5 }
        ])
    );
    assert_eq!(
        out["channels"],
        json!([{ "value": "Organic Search", "visitors": 20, "events": 40 }])
    );
    assert_eq!(out["screenSizes"], json!([]));
    assert!(out.get("hostnames").is_none());
    let mut names = ran.names();
    names.sort();
    assert_eq!(
        names,
        [
            "web.channels",
            "web.goals",
            "web.screenSizes",
            "web.series",
            "web.summary"
        ]
    );
    assert!(
        ran.sql("web.goals")
            .contains("e.path LIKE '/pricing%' ESCAPE '!'")
    );
    assert!(ran.sql("web.channels").contains("THEN 'Organic Search'"));
}

fn explain_spec() -> weldsuite_panel_domain::schemas::TrendsSpec {
    match spec(
        json!({ "kind": "trends", "projectId": "pnp_1", "dateRange": { "from": "2026-11-08", "to": "2026-11-14" }, "series": [{ "event": "A" }] }),
    ) {
        PanelQuerySpec::Trends(spec) => spec,
        _ => unreachable!("a trends spec"),
    }
}

#[test]
fn explain_picks_the_window() {
    let spec = explain_spec();
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, &ctx()).expect("range");
    let bucket = explain_windows(
        &ctx(),
        &range,
        spec.interval,
        ExplainInput {
            bucket: Some("2026-11-12"),
            period: None,
        },
    )
    .expect("windows");
    assert_eq!(
        js::iso_string(bucket.current.from),
        "2026-11-12T00:00:00.000Z"
    );
    assert_eq!(
        js::iso_string(bucket.current.to),
        "2026-11-13T00:00:00.000Z"
    );
    assert_eq!(
        js::iso_string(bucket.baseline.from),
        "2026-11-11T00:00:00.000Z"
    );
    let whole =
        explain_windows(&ctx(), &range, spec.interval, ExplainInput::default()).expect("windows");
    assert_eq!(whole.baseline.to, whole.current.from);
    let err = explain_windows(
        &ctx(),
        &range,
        spec.interval,
        ExplainInput {
            bucket: Some("2026-12-01"),
            period: None,
        },
    )
    .expect_err("refused");
    assert!(err.message.contains("not started"));
}

#[test]
fn explain_reads_both_windows_in_one_scan_per_dimension_literal_first() {
    let spec = explain_spec();
    let context = ctx();
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, &context).expect("range");
    let windows = explain_windows(
        &context,
        &range,
        spec.interval,
        ExplainInput {
            bucket: Some("2026-11-12"),
            period: None,
        },
    )
    .expect("windows");
    let properties: Vec<PanelBreakdown> =
        serde_json::from_value(json!([{ "source": "person", "key": "plan", "limit": 10 }]))
            .expect("properties");
    let dims = explain_dimensions(&context, &properties, None).expect("dimensions");
    let queries =
        explain_queries(&spec, &context, &range, &windows, &dims, &properties).expect("queries");
    assert_eq!(queries.len(), 1 + 8);
    for q in &queries {
        assert!(
            q.sql
                .contains("e.workspace_id = 'ws_1' AND e.project_id = 'pnp_1'")
        );
        assert_eq!(q.sql.matches("e.ts >= TIMESTAMP").count(), 1);
        assert!(q.sql.contains("TIMESTAMP '2026-11-12 00:00:00' <= e.ts"));
    }
    assert!(queries[7].sql.contains("regexp_replace(e.path"));
    assert!(queries[8].sql.contains("panel.people_v1"));
}

#[test]
fn explain_ranks_dimensions_by_how_much_more_of_the_change_their_top_value_carries() {
    let rows = |value: Value| -> Vec<serde_json::Map<String, Value>> {
        value
            .as_array()
            .expect("rows")
            .iter()
            .map(|r| r.as_object().expect("row").clone())
            .collect()
    };
    let dimension = |name: &str| ExplainDimension {
        name: name.to_owned(),
        expr: String::new(),
    };
    let totals = json!({ "cur": 150, "base": 100 });
    let out = explain_from(
        &[dimension("country"), dimension("browser")],
        totals.as_object(),
        &[
            rows(
                json!([{ "value": "NL", "cur": 75, "base": 50 }, { "value": "BE", "cur": 75, "base": 50 }]),
            ),
            rows(
                json!([{ "value": "Safari", "cur": 55, "base": 10 }, { "value": "Chrome", "cur": 95, "base": 90 }]),
            ),
        ],
        5,
    );
    let out = js::json_numbers(serde_json::to_value(out).expect("json"));
    assert_eq!(
        out["metric"],
        json!({ "current": 150, "baseline": 100, "change": 50, "changePercent": 0.5 })
    );
    let dimensions: Vec<&Value> = out["dimensions"]
        .as_array()
        .expect("dimensions")
        .iter()
        .map(|d| &d["dimension"])
        .collect();
    assert_eq!(dimensions, [&json!("browser"), &json!("country")]);
    assert_eq!(
        out["dimensions"][0]["values"][0],
        json!({ "value": "Safari", "current": 55, "baseline": 10, "change": 45, "changePercent": 4.5, "contributionShare": 0.9 })
    );
    assert_eq!(out["dimensions"][0]["explained"], json!(0.8));
    assert_eq!(out["dimensions"][1]["explained"], json!(0));
}
