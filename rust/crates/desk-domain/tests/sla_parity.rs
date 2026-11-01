//! Parity with the TypeScript SLA engine (`@weldsuite/db/lib/desk-sla` and
//! `desk-sla-calendar`). `packages/core/db/src/lib/desk-sla.rust-fixtures.test.ts`
//! ran it on seeded inputs and wrote what it answered into
//! `tests/fixtures/desk_sla.json`: business-time arithmetic on calendars in
//! several time zones, policy selection (and where it throws), targets,
//! the calendar a policy counts on, and timeline replays with their summary
//! and scheduling. These tests run the Rust port on the same inputs.
//! Regenerate the fixtures with `pnpm rust:desk-sla-fixtures`.

use serde_json::{Value, json};
use weldsuite_desk_domain::sla::{
    ClockStatus, ClockTimes, Metric, Policy, Target, TimelineEntry, business_hours, derive_clocks,
    next_check_at, select_policy, summarize, targets,
};
use weldsuite_desk_domain::sla_calendar::{add_business_ms, business_ms_between, to_calendar};

fn fixture() -> Value {
    let path = format!(
        "{}/tests/fixtures/desk_sla.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).expect("the fixture exists");
    serde_json::from_str(&text).expect("the fixture is JSON")
}

#[allow(clippy::cast_possible_truncation)] // integral time values
fn int(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|f| f as i64))
        .expect("an integer")
}

fn opt_int(value: &Value) -> Option<i64> {
    if value.is_null() {
        None
    } else {
        Some(int(value))
    }
}

/// A `Target` list as `deskSlaTargets` returns it (`{ first_response: … }`).
fn targets_json(targets: &[(Metric, Target)]) -> Value {
    let mut out = serde_json::Map::new();
    for (metric, target) in targets {
        out.insert(
            metric.as_str().to_owned(),
            json!({
                "targetMinutes": target.target_minutes,
                "warnBeforeMinutes": target.warn_before_minutes,
            }),
        );
    }
    Value::Object(out)
}

/// Numbers compare as numbers (`60` and `60.0` alike).
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| same_json(v, w)))
        }
        _ => a == b,
    }
}

fn parse_targets(value: &Value) -> Vec<(Metric, Target)> {
    let mut out = Vec::new();
    for metric in Metric::ALL {
        if let Some(target) = value.get(metric.as_str()) {
            out.push((
                metric,
                Target {
                    target_minutes: target["targetMinutes"].as_f64().expect("the fixture"),
                    warn_before_minutes: target["warnBeforeMinutes"].as_f64(),
                },
            ));
        }
    }
    out
}

#[test]
fn calendars_count_business_time_like_typescript() {
    let fixture = fixture();
    let mut checked = 0;
    for case in fixture["calendars"].as_array().expect("the fixture") {
        let name = case["name"].as_str().expect("the fixture");
        let calendar = to_calendar(&case["hours"]);
        assert_eq!(
            calendar.is_some(),
            case["isCalendar"].as_bool().expect("the fixture"),
            "{name}: calendar or 24x7"
        );
        for op in case["ops"].as_array().expect("the fixture") {
            let from = int(&op["from"]);
            let got = match op["op"].as_str().expect("the fixture") {
                "between" => business_ms_between(calendar.as_ref(), from, int(&op["to"])),
                _ => add_business_ms(
                    calendar.as_ref(),
                    from,
                    op["ms"].as_f64().expect("the fixture"),
                ),
            };
            assert_eq!(got, int(&op["result"]), "{name}: {op}");
            checked += 1;
        }
    }
    assert!(checked > 100);
}

#[test]
fn policies_are_selected_like_typescript() {
    let fixture = fixture();
    let policies: Vec<Policy> = fixture["selection"]["policies"]
        .as_array()
        .expect("the fixture")
        .iter()
        .map(Policy::from_js)
        .collect();
    for case in fixture["selection"]["cases"]
        .as_array()
        .expect("the fixture")
    {
        let drop = usize::try_from(int(&case["drop"])).expect("the fixture");
        let chosen = select_policy(&policies[drop..], &case["conversation"]).expect("the fixture");
        assert_eq!(
            chosen.map(|p| p.id.as_str()),
            case["chosen"].as_str(),
            "{case}"
        );
    }
}

#[test]
fn malformed_policies_fail_where_typescript_throws() {
    let fixture = fixture();
    let conversation = &fixture["selection"]["cases"][0]["conversation"];
    for case in fixture["malformed"].as_array().expect("the fixture") {
        let policies: Vec<Policy> = case["candidates"]
            .as_array()
            .expect("the fixture")
            .iter()
            .map(Policy::from_js)
            .collect();
        let result = select_policy(&policies, conversation).and_then(|chosen| {
            if case["targets"].as_bool().expect("the fixture") {
                chosen
                    .map(|p| targets(p, None).map(|t| targets_json(&t)))
                    .transpose()
                    .map(|t| t.unwrap_or(Value::Null))
            } else {
                Ok(chosen.map_or(Value::Null, |p| json!(p.id)))
            }
        });
        match result {
            Ok(value) => {
                assert!(
                    !case["threw"].as_bool().expect("the fixture"),
                    "{case}: TypeScript threw"
                );
                assert!(same_json(&value, &case["result"]), "{case}: got {value}");
            }
            Err(error) => assert!(
                case["threw"].as_bool().expect("the fixture"),
                "{case}: Rust failed with {error}"
            ),
        }
    }
}

#[test]
fn targets_match_typescript() {
    let fixture = fixture();
    for case in fixture["targets"].as_array().expect("the fixture") {
        let policy = Policy::from_js(&case["policy"]);
        let priority = &case["priority"];
        let got = targets_json(&targets(&policy, Some(priority)).expect("the fixture"));
        assert!(same_json(&got, &case["targets"]), "{case}: got {got}");
    }
}

#[test]
fn business_hours_match_typescript() {
    let fixture = fixture();
    for case in fixture["businessHours"].as_array().expect("the fixture") {
        let policy = Policy::from_js(&case["policy"]);
        let got = business_hours(&policy, &case["workspaceHours"]);
        assert_eq!(got, case["result"], "{case}");
    }
}

fn status(text: &str) -> ClockStatus {
    match text {
        "running" => ClockStatus::Running,
        "paused" => ClockStatus::Paused,
        "completed" => ClockStatus::Completed,
        _ => ClockStatus::Cancelled,
    }
}

#[test]
fn replays_match_typescript() {
    let fixture = fixture();
    let calendars: std::collections::HashMap<String, Value> = fixture["calendars"]
        .as_array()
        .expect("the fixture")
        .iter()
        .map(|c| {
            (
                c["name"].as_str().expect("the fixture").to_owned(),
                c["hours"].clone(),
            )
        })
        .collect();
    for (index, case) in fixture["replays"]
        .as_array()
        .expect("the fixture")
        .iter()
        .enumerate()
    {
        let calendar = to_calendar(&calendars[case["calendar"].as_str().expect("the fixture")]);
        let targets = parse_targets(&case["targets"]);
        let timeline: Vec<TimelineEntry> = case["timeline"]
            .as_array()
            .expect("the fixture")
            .iter()
            .map(|e| TimelineEntry {
                at: int(&e["at"]),
                kind: e["kind"].as_str().expect("the fixture").to_owned(),
                author_type: e["authorType"].as_str().expect("the fixture").to_owned(),
                event_type: e["eventType"].as_str().map(str::to_owned),
            })
            .collect();
        let now = int(&case["now"]);
        let derived = derive_clocks(&timeline, &targets, calendar.as_ref(), now);
        let expected = case["clocks"].as_array().expect("the fixture");
        assert_eq!(derived.len(), expected.len(), "replay {index}: clocks");
        let mut times = Vec::new();
        for (clock, want) in derived.iter().zip(expected) {
            let context = format!("replay {index} {}", clock.metric.as_str());
            assert_eq!(clock.metric.as_str(), want["metric"], "{context}");
            assert_eq!(
                clock.status,
                status(want["status"].as_str().expect("the fixture")),
                "{context}"
            );
            assert_eq!(clock.started_at, int(&want["startedAt"]), "{context}");
            assert_eq!(
                clock.elapsed_seconds,
                int(&want["elapsedSeconds"]),
                "{context}"
            );
            assert_eq!(clock.due_at, opt_int(&want["dueAt"]), "{context}: dueAt");
            assert_eq!(clock.warn_at, opt_int(&want["warnAt"]), "{context}: warnAt");
            assert_eq!(
                clock.breached_at,
                opt_int(&want["breachedAt"]),
                "{context}: breachedAt"
            );
            assert_eq!(
                clock.completed_at,
                opt_int(&want["completedAt"]),
                "{context}"
            );
            let time = ClockTimes {
                metric: clock.metric,
                status: clock.status,
                due_at: clock.due_at,
                warn_at: clock.warn_at,
                breached_at: clock.breached_at,
                warned_at: opt_int(&want["warnedAt"]),
                breach_notified_at: opt_int(&want["breachNotifiedAt"]),
            };
            assert_eq!(
                next_check_at(&time),
                opt_int(&want["nextCheckAt"]),
                "{context}: nextCheckAt"
            );
            times.push(time);
        }
        let summary = summarize(&times, now);
        let want = &case["summary"];
        assert_eq!(
            summary.status,
            want["slaStatus"].as_str(),
            "replay {index}: status"
        );
        assert_eq!(
            summary.due_at,
            opt_int(&want["slaDueAt"]),
            "replay {index}: due"
        );
        assert_eq!(
            summary.metric.map(Metric::as_str),
            want["slaMetric"].as_str(),
            "replay {index}: metric"
        );
    }
}
