//! Engine rows in, result shapes out, per kind: the port of
//! `packages/domains/panel/src/query/results.test.ts`, same canned rows and
//! expected values.

// The expectations are the TypeScript's, compared exactly as JavaScript does.
#![allow(clippy::float_cmp)]

mod common;

use common::{num, run, run_with, try_run_with};
use serde_json::{Value, json};
use weldsuite_panel_domain::query::activity::lexicon_from_rows;
use weldsuite_panel_domain::query::{RunStats, normalize_rows};

#[tokio::test]
async fn web_turns_the_summary_series_and_lists_into_the_result_zero_filling_empty_days() {
    let ran = run(
        json!({ "kind": "web", "projectId": "pnp_1", "dateRange": { "from": "2026-11-10", "to": "2026-11-12" }, "compare": true }),
        json!({
            "web.summary": [{ "visitors": 10, "visits": 20, "pageviews": 50, "bounces": 5, "duration_seconds": 1200 }],
            "web.summary.previous": [[8, 10, 30, 5, 300]],
            "web.series": [
                { "bucket": "2026-11-10T00:00:00", "visitors": 4, "pageviews": 9 },
                { "bucket": "2026-11-12 00:00:00", "visitors": 6, "pageviews": 12 }
            ],
            "web.topPages": [{ "value": "/", "visitors": 7, "events": 20 }],
            "web.entryExit": [{ "path": "/", "entries": 6, "exits": 2 }]
        }),
    )
    .await;
    let out = ran.out();
    assert_eq!(
        out["totals"],
        json!({ "visitors": 10, "visits": 20, "pageviews": 50, "bounceRate": 0.25, "avgVisitDurationSeconds": 60 })
    );
    assert_eq!(out["previousTotals"]["visitors"], json!(8));
    assert_eq!(
        out["series"],
        json!([
            { "bucket": "2026-11-10", "visitors": 4, "pageviews": 9 },
            { "bucket": "2026-11-11", "visitors": 0, "pageviews": 0 },
            { "bucket": "2026-11-12", "visitors": 6, "pageviews": 12 }
        ])
    );
    assert_eq!(out["previousSeries"].as_array().map(Vec::len), Some(3));
    assert_eq!(
        out["topPages"],
        json!([{ "value": "/", "visitors": 7, "events": 20 }])
    );
    assert_eq!(
        out["entryExitPages"],
        json!([{ "value": "/", "entries": 6, "exits": 2 }])
    );
    assert_eq!(out["range"]["previousTo"], out["range"]["from"]);
}

#[tokio::test]
async fn web_answers_zeros_not_nan_for_a_project_with_no_data() {
    let ran = run(json!({ "kind": "web", "projectId": "pnp_1" }), json!({})).await;
    assert_eq!(
        ran.out()["totals"],
        json!({ "visitors": 0, "visits": 0, "pageviews": 0, "bounceRate": 0, "avgVisitDurationSeconds": 0 })
    );
    assert_eq!(ran.out()["previousTotals"], Value::Null);
}

#[tokio::test]
async fn trends_splits_a_series_by_breakdown_value_with_other_last_and_compares() {
    let ran = run(
        json!({
            "kind": "trends",
            "projectId": "pnp_1",
            "dateRange": { "from": "2026-11-10", "to": "2026-11-11" },
            "series": [{ "event": "Purchase", "math": "avg_per_user" }],
            "breakdown": { "source": "column", "field": "country", "limit": 1 },
            "compare": true
        }),
        json!({
            "trends.breakdownValues": [{ "value": "NL", "n": 5 }],
            "trends.series": [
                { "bucket": "2026-11-10", "bd": "NL", "s0_v": 6, "s0_u": 3 },
                { "bucket": "2026-11-11", "bd": "Other", "s0_v": 1, "s0_u": 1 }
            ],
            "trends.totals": [{ "bd": "NL", "s0_v": 6, "s0_u": 3 }, { "bd": "Other", "s0_v": 1, "s0_u": 1 }],
            "trends.series.previous": [{ "bucket": "2026-11-08", "bd": "NL", "s0_v": 2, "s0_u": 1 }],
            "trends.totals.previous": [{ "bd": "NL", "s0_v": 2, "s0_u": 1 }]
        }),
    )
    .await;
    let series = ran.out()["series"].as_array().expect("series").clone();
    let pairs: Vec<Value> = series
        .iter()
        .map(|s| json!([s["breakdownValue"], s["total"]]))
        .collect();
    assert_eq!(pairs, vec![json!(["NL", 2]), json!(["Other", 1])]);
    assert_eq!(
        series[0]["points"],
        json!([{ "bucket": "2026-11-10", "value": 2 }, { "bucket": "2026-11-11", "value": 0 }])
    );
    assert_eq!(series[0]["previous"]["total"], json!(2));
    assert_eq!(series[0]["label"], json!("Purchase"));
}

#[tokio::test]
async fn trends_answers_one_empty_line_per_series_without_data() {
    let ran = run(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "A" }, { "event": "B" }] }),
        json!({}),
    )
    .await;
    let series = ran.out()["series"].as_array().expect("series");
    assert_eq!(series.len(), 2);
    assert!(
        series
            .iter()
            .all(|s| s["total"] == json!(0) && s["breakdownValue"].is_null())
    );
}

#[tokio::test]
async fn trends_coarsens_hourly_buckets_on_long_ranges() {
    let ran = run(
        json!({ "kind": "trends", "projectId": "pnp_1", "dateRange": { "preset": "90d" }, "interval": "hour", "series": [{ "event": "A" }] }),
        json!({}),
    )
    .await;
    assert_eq!(ran.out()["interval"], json!("day"));
}

fn funnel_steps() -> Value {
    json!([{ "event": "A" }, { "event": "B", "label": "Step B" }, { "event": "C" }, { "event": "D" }])
}

#[tokio::test]
async fn funnel_computes_conversion_drop_off_and_time_to_convert_from_the_per_step_counts() {
    let ran = run(
        json!({ "kind": "funnel", "projectId": "pnp_1", "steps": funnel_steps() }),
        json!({
            "funnel.steps": [
                { "step": 1, "bd": "", "persons": 100, "avg_secs": 0 },
                { "step": 2, "bd": "", "persons": 50, "avg_secs": 120.4 },
                { "step": 3, "bd": "", "persons": 25, "avg_secs": 30 },
                { "step": 4, "bd": "", "persons": 5, "avg_secs": 3600 }
            ]
        }),
    )
    .await;
    let steps = ran.out()["steps"].as_array().expect("steps").clone();
    let counts: Vec<f64> = steps.iter().map(|s| num(&s["count"])).collect();
    assert_eq!(counts, [100.0, 50.0, 25.0, 5.0]);
    assert_eq!(steps[1]["label"], json!("Step B"));
    assert_eq!(num(&steps[1]["conversionFromPrevious"]), 0.5);
    assert_eq!(num(&steps[1]["conversionFromFirst"]), 0.5);
    assert_eq!(num(&steps[1]["droppedOff"]), 50.0);
    assert_eq!(num(&steps[1]["avgSecondsFromPrevious"]), 120.0);
    assert_eq!(num(&steps[3]["conversionFromPrevious"]), 0.2);
    assert_eq!(num(&steps[3]["conversionFromFirst"]), 0.05);
    assert_eq!(num(&steps[3]["droppedOff"]), 20.0);
    assert!(steps[0]["avgSecondsFromPrevious"].is_null());
    assert_eq!(num(&ran.out()["overallConversion"]), 0.05);
    assert!(ran.out()["breakdowns"].is_null());
}

#[tokio::test]
async fn funnel_answers_a_result_per_breakdown_value() {
    let steps = funnel_steps().as_array().expect("steps")[..2].to_vec();
    let ran = run(
        json!({ "kind": "funnel", "projectId": "pnp_1", "steps": steps, "breakdown": { "source": "event", "key": "plan" } }),
        json!({
            "funnel.breakdownValues": [{ "value": "pro", "n": 10 }],
            "funnel.steps": [
                { "step": 1, "bd": "pro", "persons": 10, "avg_secs": 0 },
                { "step": 2, "bd": "pro", "persons": 5, "avg_secs": 60 },
                { "step": 1, "bd": "Other", "persons": 4, "avg_secs": 0 },
                { "step": 2, "bd": "Other", "persons": 1, "avg_secs": 10 }
            ]
        }),
    )
    .await;
    let counts: Vec<f64> = ran.out()["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .map(|s| num(&s["count"]))
        .collect();
    assert_eq!(counts, [14.0, 6.0]);
    let breakdowns: Vec<Value> = ran.out()["breakdowns"]
        .as_array()
        .expect("breakdowns")
        .iter()
        .map(|b| json!([b["value"], b["overallConversion"]]))
        .collect();
    assert_eq!(
        breakdowns,
        vec![json!(["pro", 0.5]), json!(["Other", 0.25])]
    );
}

#[tokio::test]
async fn funnel_does_not_divide_by_zero_for_an_empty_funnel() {
    let ran = run(
        json!({ "kind": "funnel", "projectId": "pnp_1", "steps": funnel_steps() }),
        json!({}),
    )
    .await;
    assert_eq!(num(&ran.out()["overallConversion"]), 0.0);
    assert!(
        ran.out()["steps"]
            .as_array()
            .expect("steps")
            .iter()
            .all(|s| {
                let first = s["index"] == json!(0);
                num(&s["count"]) == 0.0
                    && num(&s["conversionFromPrevious"]) == if first { 1.0 } else { 0.0 }
            })
    );
}

#[tokio::test]
async fn retention_lines_up_returns_per_cohort_and_period_and_averages_only_cohorts_old_enough() {
    let ran = run(
        json!({
            "kind": "retention",
            "projectId": "pnp_1",
            "dateRange": { "from": "2026-10-26", "to": "2026-11-14" },
            "firstEvent": "Signed up",
            "interval": "week",
            "periods": 2
        }),
        json!({
            "retention.sizes": [
                { "cohort": "2026-10-26T00:00:00", "size": 10 },
                { "cohort": "2026-11-02T00:00:00", "size": 20 },
                { "cohort": "2026-11-09T00:00:00", "size": 40 }
            ],
            "retention.returns": [
                { "cohort": "2026-10-26T00:00:00", "period": 0, "n": 10 },
                { "cohort": "2026-10-26T00:00:00", "period": 1, "n": 5 },
                { "cohort": "2026-10-26T00:00:00", "period": 2, "n": 2 },
                { "cohort": "2026-11-02T00:00:00", "period": 0, "n": 20 },
                { "cohort": "2026-11-02T00:00:00", "period": 1, "n": 10 },
                { "cohort": "2026-11-09T00:00:00", "period": 0, "n": 40 },
                { "cohort": "2026-10-26T00:00:00", "period": 9, "n": 1 }
            ]
        }),
    )
    .await;
    assert_eq!(
        ran.out()["cohorts"],
        json!([
            { "cohort": "2026-10-26", "size": 10, "counts": [10, 5, 2] },
            { "cohort": "2026-11-02", "size": 20, "counts": [20, 10, 0] },
            { "cohort": "2026-11-09", "size": 40, "counts": [40, 0, 0] }
        ])
    );
    // Period 1 exists for the first two cohorts only (15 of 30); period 2 for the first (2 of 10).
    assert_eq!(ran.out()["averageRetention"], json!([1, 0.5, 0.2]));
}

#[tokio::test]
async fn flows_keeps_the_spec_limit_and_counts_the_anchor_from_every_path_read() {
    let ran = run(
        json!({ "kind": "flows", "projectId": "pnp_1", "anchor": { "event": "Signed up" }, "depth": 2, "limit": 1 }),
        json!({ "flows.paths": [{ "n1": "/welcome", "n2": null, "cnt": 7 }, { "n1": "/home", "n2": "/pricing", "cnt": 3 }] }),
    )
    .await;
    assert_eq!(
        ran.out()["paths"],
        json!([{ "steps": ["/welcome", null], "count": 7 }])
    );
    assert_eq!(ran.out()["anchorCount"], json!(10));
    assert_eq!(ran.out()["direction"], json!("after"));
}

fn session_row(id: &str) -> Value {
    json!({
        "session_id": id,
        "started": "2026-11-14 10:00:00",
        "ended": "2026-11-14T10:05:00Z",
        "duration_seconds": 300,
        "pageviews": 4,
        "clicks": 9,
        "events": 20,
        "rage": 1,
        "dead": 0,
        "quickback": 0,
        "excessive": 0,
        "errors": 2,
        "entry_page": "/",
        "exit_page": "/pricing",
        "device": "mobile",
        "browser": "Safari",
        "os": "iOS",
        "country": "NL",
        "person": "user_1",
        "user_id": "user_1"
    })
}

#[tokio::test]
async fn sessions_maps_rows_marks_the_sessions_that_have_chunks_and_issues_a_cursor() {
    let ran = run(
        json!({ "kind": "sessions", "projectId": "pnp_1", "limit": 2 }),
        json!({
            "sessions.list": [session_row("s_1"), session_row("s_2"), session_row("s_3")],
            "sessions.chunks": [{ "session_id": "s_2", "chunks": 3 }]
        }),
    )
    .await;
    let sessions = ran.out()["sessions"].as_array().expect("sessions").clone();
    let marks: Vec<Value> = sessions
        .iter()
        .map(|s| json!([s["sessionId"], s["hasRecording"], s["chunkCount"]]))
        .collect();
    assert_eq!(
        marks,
        vec![json!(["s_1", false, 0]), json!(["s_2", true, 3])]
    );
    let first = &sessions[0];
    assert_eq!(first["startedAt"], json!("2026-11-14T10:00:00.000Z"));
    assert_eq!(first["endedAt"], json!("2026-11-14T10:05:00.000Z"));
    assert_eq!(first["durationSeconds"], json!(300));
    assert_eq!(first["deviceType"], json!("mobile"));
    assert_eq!(first["rageClicks"], json!(1));
    assert_eq!(first["errors"], json!(2));
    assert_eq!(first["favorite"], json!(false));
    assert_eq!(ran.out()["hasMore"], json!(true));
    assert_eq!(ran.out()["nextCursor"], json!("o2"));
}

#[tokio::test]
async fn sessions_ends_the_list_without_a_cursor_and_skips_the_chunk_lookup_when_empty() {
    let ran = run(
        json!({ "kind": "sessions", "projectId": "pnp_1" }),
        json!({}),
    )
    .await;
    assert_eq!(ran.names(), ["sessions.list"]);
    assert_eq!(ran.out()["sessions"], json!([]));
    assert_eq!(ran.out()["hasMore"], json!(false));
    assert_eq!(ran.out()["nextCursor"], Value::Null);
}

#[tokio::test]
async fn heatmap_area_shares_of_the_clicks_per_element() {
    let ran = run(
        json!({ "kind": "heatmap", "projectId": "pnp_1", "type": "area", "deviceClass": "desktop", "urlPattern": "/" }),
        json!({
            "heatmap.pageviews": [{ "pageviews": 100 }],
            "heatmap.elements": [
                { "selector": "#buy", "text": "Buy", "clicks": 30, "rel_x": 0.4, "rel_y": 1.7 },
                { "selector": "a.logo", "text": null, "clicks": 10, "rel_x": 0.5, "rel_y": 0.5 }
            ]
        }),
    )
    .await;
    assert_eq!(ran.out()["pageviews"], json!(100));
    assert_eq!(ran.out()["clicks"], json!(40));
    assert_eq!(
        ran.out()["elements"][0],
        json!({ "selector": "#buy", "text": "Buy", "clicks": 30, "share": 0.75, "relX": 0.4, "relY": 1 })
    );
}

#[tokio::test]
async fn heatmap_scroll_share_of_leaves_that_got_at_least_that_far() {
    let ran = run(
        json!({ "kind": "heatmap", "projectId": "pnp_1", "type": "scroll", "deviceClass": "mobile", "urlPattern": "/" }),
        json!({ "heatmap.scroll": [{ "depth": 0, "leaves": 20 }, { "depth": 50, "leaves": 60 }, { "depth": 100, "leaves": 20 }] }),
    )
    .await;
    let buckets = ran.out()["scroll"]["buckets"]
        .as_array()
        .expect("buckets")
        .clone();
    let at = |depth: f64| {
        buckets
            .iter()
            .find(|b| num(&b["depth"]) == depth)
            .map(|b| num(&b["reachedShare"]))
    };
    assert_eq!(ran.out()["scroll"]["leaves"], json!(100));
    assert_eq!(at(0.0), Some(1.0));
    assert_eq!(at(10.0), Some(0.8));
    assert_eq!(at(50.0), Some(0.8));
    assert_eq!(at(60.0), Some(0.2));
    assert_eq!(at(100.0), Some(0.2));
}

#[tokio::test]
async fn heatmap_click_points_per_element_position() {
    let ran = run(
        json!({ "kind": "heatmap", "projectId": "pnp_1", "type": "click", "deviceClass": "tablet", "urlPattern": "/" }),
        json!({ "heatmap.points": [{ "selector": "#a", "rel_x": 0.1, "rel_y": 0.9, "clicks": 4 }] }),
    )
    .await;
    assert_eq!(
        ran.out()["points"],
        json!([{ "selector": "#a", "relX": 0.1, "relY": 0.9, "count": 4 }])
    );
    assert_eq!(ran.out()["clicks"], json!(4));
}

#[tokio::test]
async fn adds_up_the_bytes_scanned_and_counts_the_statements() {
    let ran = try_run_with(
        json!({ "kind": "web", "projectId": "pnp_1" }),
        json!({}),
        &common::ctx(),
        Some(100.0),
    )
    .await
    .expect("runs");
    // Summary, series, entry and exit pages, 9 lists and channels.
    assert_eq!(
        ran.stats,
        RunStats {
            queries: 13,
            bytes_scanned: Some(1300.0)
        }
    );
}

#[test]
fn reads_positional_and_keyed_rows_alike() {
    let rows = normalize_rows(
        &[json!([1, "a"]), json!({ "N": 2, "B": "b" })],
        &["n".to_owned(), "b".to_owned()],
    );
    let rows: Vec<Value> = rows.into_iter().map(Value::Object).collect();
    assert_eq!(
        rows,
        vec![json!({ "n": 1, "b": "a" }), json!({ "n": 2, "b": "b" })]
    );
}

#[test]
fn lexicon_collects_event_names_and_property_keys_dropping_what_the_collector_would_refuse() {
    let rows = |value: Value| -> Vec<serde_json::Map<String, Value>> {
        value
            .as_array()
            .expect("rows")
            .iter()
            .map(|r| r.as_object().expect("row").clone())
            .collect()
    };
    let scan = lexicon_from_rows(
        &rows(
            json!([{ "name": "Signed up", "n": 5 }, { "name": "$pageview", "n": 9 }, { "name": "bad'name", "n": 1 }]),
        ),
        &rows(json!([
            { "properties": "{\"plan\":\"pro\",\"$action\":\"click\",\"bad key\":1}", "n": 3 },
            { "properties": "not json", "n": 1 }
        ])),
        &rows(
            json!([{ "user_id": "u", "properties": "{\"$email\":\"a@b.c\",\"company\":\"X\"}" }]),
        ),
    );
    let names: Vec<&str> = scan.events.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["Signed up", "$pageview"]);
    assert_eq!(scan.properties, ["$action", "$email", "company", "plan"]);
}

#[tokio::test]
async fn runs_against_a_context_with_identified_users() {
    let ctx = weldsuite_panel_domain::query::PanelQueryContext {
        has_identified_users: true,
        erased_ids: vec!["gone".to_owned(), "gone".to_owned()],
        ..common::ctx()
    };
    let ran = run_with(
        json!({ "kind": "web", "projectId": "pnp_1" }),
        json!({}),
        &ctx,
    )
    .await;
    let summary = ran.sql("web.summary");
    assert!(summary.contains("LEFT JOIN (SELECT anon_id, user_id FROM (SELECT anon_id, user_id"));
    assert!(summary.contains("e.anon_id NOT IN ('gone')"));
    assert!(summary.contains("COALESCE(i.user_id, e.distinct_id) AS person"));
}

#[test]
fn a_run_is_a_send_future_for_the_server() {
    fn assert_send<T: Send>(_: &T) {}
    let parsed = common::spec(
        json!({ "kind": "trends", "projectId": "pnp_1", "series": [{ "event": "A" }] }),
    );
    let context = common::ctx();
    let executor = |_: weldsuite_panel_domain::query::PanelSqlQuery| async {
        Ok::<_, weldsuite_panel_domain::query::EngineError>(
            weldsuite_panel_domain::query::PanelSqlResult::default(),
        )
    };
    let run = weldsuite_panel_domain::query::run_panel_query(&parsed, &context, &executor);
    assert_send(&run);
}
