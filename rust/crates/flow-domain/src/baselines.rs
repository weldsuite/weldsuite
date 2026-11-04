//! Baselines (`@weldsuite/flow-domain/baselines`, FLOW-012): the snapshot a
//! version freezes, the variance between two plans, and the database reads
//! the routes and `apply_approved_change` share. Dates are ISO strings in a
//! snapshot, money and hours decimal strings with two decimals. Rows are read
//! as `weldsuite_db::js_row` gives them (camelCase, ISO timestamps).

use std::collections::HashMap;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::js_row;

use crate::js::{millis_of, to_fixed};

pub mod messages {
    pub const ALREADY_BASELINED: &str = "This project already has a baseline";
    pub const NOTHING_TO_BASELINE: &str =
        "Add a milestone, a deliverable or an end date before signing off the baseline";
    pub const DIFFERENT_PROJECTS: &str = "The two baselines belong to different projects";
    pub const NEEDS_PROJECT_OR_FROM: &str = "Choose a project or a baseline to compare";
}

const DAY_MS: f64 = 86_400_000.0;

// ── Decimals ────────────────────────────────────────────────────────────────

/// `toCents`: `12.5` or `'12.50'` as whole hundredths; `None` when not a number.
pub fn to_cents(text: &str) -> Option<i128> {
    let text = text.trim();
    let (negative, rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (whole, fraction) = match rest.split_once('.') {
        Some((w, f)) => (w, f),
        None => (rest, ""),
    };
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || (rest.contains('.') && fraction.is_empty())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let padded: String = format!("{fraction}00").chars().take(2).collect();
    let cents = whole.parse::<i128>().ok()? * 100 + padded.parse::<i128>().ok()?;
    Some(if negative { -cents } else { cents })
}

/// `fromCents`.
pub fn from_cents(cents: i128) -> String {
    let abs = cents.abs();
    format!(
        "{}{}.{:02}",
        if cents < 0 { "-" } else { "" },
        abs / 100,
        abs % 100
    )
}

/// `decimal(value)`: two decimals, `None` for null, blank or not a number.
pub fn decimal(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    to_cents(value).map(from_cents)
}

/// `decimal(number)`.
pub fn decimal_f64(value: f64) -> Option<String> {
    decimal(Some(&to_fixed(value, 2)))
}

/// `decimalDelta(from, to)`: `to - from` (a missing one counts as 0); `None` when both are missing.
pub fn decimal_delta(from: Option<&str>, to: Option<&str>) -> Option<String> {
    if from.is_none() && to.is_none() {
        return None;
    }
    let cents = |v: Option<&str>| to_cents(v.unwrap_or("0")).unwrap_or(0);
    Some(from_cents(cents(to) - cents(from)))
}

/// `decimalSum(current, delta)`.
pub fn decimal_sum(current: Option<&str>, delta: &str) -> String {
    from_cents(to_cents(current.unwrap_or("0")).unwrap_or(0) + to_cents(delta).unwrap_or(0))
}

// ── Plan state and snapshot ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct PlanMilestone {
    pub id: String,
    pub name: String,
    pub due_date: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanDeliverable {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub planned_start: Option<String>,
    pub planned_end: Option<String>,
}

/// The plan as the project holds it now (`PlanState`); dates are ISO strings.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlanState {
    pub go_live: Option<String>,
    pub milestones: Vec<PlanMilestone>,
    pub deliverables: Vec<PlanDeliverable>,
    pub budgeted_amount: Option<String>,
    pub budgeted_hours: Option<String>,
    pub budget_currency: Option<String>,
    pub scope_statement: Option<String>,
    pub project_manager_id: Option<String>,
}

fn ms(iso: &str) -> i64 {
    millis_of(iso).unwrap_or(0)
}

/// `buildSnapshot(plan)`: milestones by due date (then name, then id),
/// deliverables by number (then id).
pub fn build_snapshot(plan: &PlanState) -> Value {
    let mut milestones = plan.milestones.clone();
    milestones.sort_by(|a, b| {
        ms(&a.due_date)
            .cmp(&ms(&b.due_date))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut deliverables = plan.deliverables.clone();
    deliverables.sort_by(|a, b| a.number.cmp(&b.number).then_with(|| a.id.cmp(&b.id)));
    json!({
        "goLive": plan.go_live,
        "milestones": milestones.iter().map(|m| json!({"id": m.id, "name": m.name, "dueDate": m.due_date})).collect::<Vec<_>>(),
        "deliverables": deliverables.iter().map(|d| json!({
            "id": d.id, "number": d.number, "title": d.title,
            "plannedStart": d.planned_start, "plannedEnd": d.planned_end,
        })).collect::<Vec<_>>(),
        "budgetedAmount": decimal(plan.budgeted_amount.as_deref()),
        "budgetedHours": decimal(plan.budgeted_hours.as_deref()),
        "budgetCurrency": plan.budget_currency,
        "scopeStatement": plan.scope_statement,
    })
}

/// `baselineIsEmpty(plan)`.
pub fn baseline_is_empty(plan: &PlanState) -> bool {
    plan.go_live.is_none() && plan.milestones.is_empty() && plan.deliverables.is_empty()
}

// ── Variance ────────────────────────────────────────────────────────────────

/// `dayDelta(from, to)`: whole days `to` is after `from`; `None` when either is missing.
pub fn day_delta(from: Option<&str>, to: Option<&str>) -> Option<i64> {
    let a = millis_of(from.filter(|s| !s.is_empty())?)?;
    let b = millis_of(to.filter(|s| !s.is_empty())?)?;
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    Some(crate::js::math_round((b - a) as f64 / DAY_MS) as i64)
}

fn same_instant(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => ms(a) == ms(b),
        (None, None) => true,
        _ => false,
    }
}

fn variance(from: Option<&str>, to: Option<&str>) -> Value {
    json!({"from": from, "to": to, "deltaDays": day_delta(from, to)})
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn items<'a>(snapshot: &'a Value, key: &str) -> &'a [Value] {
    snapshot
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn with_variance(mut base: Value, from: Option<&str>, to: Option<&str>) -> Value {
    if let (Value::Object(map), Value::Object(extra)) = (&mut base, variance(from, to)) {
        map.extend(extra);
    }
    base
}

/// `compareSnapshots(from, to)`.
#[allow(clippy::too_many_lines)]
pub fn compare_snapshots(from: &Value, to: &Value) -> Value {
    let to_m: HashMap<&str, &Value> = items(to, "milestones")
        .iter()
        .filter_map(|m| text(m, "id").map(|id| (id, m)))
        .collect();
    let from_m: HashMap<&str, &Value> = items(from, "milestones")
        .iter()
        .filter_map(|m| text(m, "id").map(|id| (id, m)))
        .collect();
    let mut milestones: Vec<Value> = Vec::new();
    for old in items(from, "milestones") {
        let id = text(old, "id").unwrap_or_default();
        let old_due = text(old, "dueDate");
        match to_m.get(id) {
            None => milestones.push(with_variance(
                json!({"id": id, "name": text(old, "name"), "change": "removed"}),
                old_due,
                None,
            )),
            Some(now) => {
                let change = if same_instant(old_due, text(now, "dueDate")) {
                    "unchanged"
                } else {
                    "moved"
                };
                milestones.push(with_variance(
                    json!({"id": id, "name": text(now, "name"), "change": change}),
                    old_due,
                    text(now, "dueDate"),
                ));
            }
        }
    }
    for now in items(to, "milestones") {
        let id = text(now, "id").unwrap_or_default();
        if !from_m.contains_key(id) {
            milestones.push(with_variance(
                json!({"id": id, "name": text(now, "name"), "change": "added"}),
                None,
                text(now, "dueDate"),
            ));
        }
    }
    let when = |v: &Value| {
        let at = text(v, "to").or_else(|| text(v, "from"));
        at.map_or(0, ms)
    };
    milestones.sort_by(|a, b| {
        when(a)
            .cmp(&when(b))
            .then_with(|| text(a, "name").cmp(&text(b, "name")))
            .then_with(|| text(a, "id").cmp(&text(b, "id")))
    });

    let to_d: HashMap<&str, &Value> = items(to, "deliverables")
        .iter()
        .filter_map(|m| text(m, "id").map(|id| (id, m)))
        .collect();
    let from_d: HashMap<&str, &Value> = items(from, "deliverables")
        .iter()
        .filter_map(|m| text(m, "id").map(|id| (id, m)))
        .collect();
    let mut deliverables: Vec<Value> = Vec::new();
    let row = |d: &Value,
               change: &str,
               fs: Option<&str>,
               ts: Option<&str>,
               fe: Option<&str>,
               te: Option<&str>| {
        json!({
            "id": d["id"], "number": d["number"], "title": d["title"], "change": change,
            "start": variance(fs, ts), "end": variance(fe, te),
        })
    };
    for old in items(from, "deliverables") {
        let id = text(old, "id").unwrap_or_default();
        match to_d.get(id) {
            None => deliverables.push(row(
                old,
                "removed",
                text(old, "plannedStart"),
                None,
                text(old, "plannedEnd"),
                None,
            )),
            Some(now) => {
                let unchanged = same_instant(text(old, "plannedStart"), text(now, "plannedStart"))
                    && same_instant(text(old, "plannedEnd"), text(now, "plannedEnd"));
                deliverables.push(row(
                    now,
                    if unchanged { "unchanged" } else { "moved" },
                    text(old, "plannedStart"),
                    text(now, "plannedStart"),
                    text(old, "plannedEnd"),
                    text(now, "plannedEnd"),
                ));
            }
        }
    }
    for now in items(to, "deliverables") {
        if !from_d.contains_key(text(now, "id").unwrap_or_default()) {
            deliverables.push(row(
                now,
                "added",
                None,
                text(now, "plannedStart"),
                None,
                text(now, "plannedEnd"),
            ));
        }
    }
    deliverables.sort_by(|a, b| {
        a["number"]
            .as_i64()
            .cmp(&b["number"].as_i64())
            .then_with(|| text(a, "id").cmp(&text(b, "id")))
    });

    let money = |key: &str| {
        let (f, t) = (text(from, key), text(to, key));
        json!({"from": f, "to": t, "delta": decimal_delta(f, t)})
    };
    json!({
        "goLive": variance(text(from, "goLive"), text(to, "goLive")),
        "milestones": milestones,
        "deliverables": deliverables,
        "budget": money("budgetedAmount"),
        "hours": money("budgetedHours"),
    })
}

// ── Database ────────────────────────────────────────────────────────────────

/// `loadPlanState(db, projectId)`: the plan of a live project, or `None`.
pub async fn load_plan_state(
    db: &PgPool,
    project_id: &str,
) -> Result<Option<PlanState>, sqlx::Error> {
    let project: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) || jsonb_build_object('budgeted_amount', p.budgeted_amount::text,
             'budgeted_hours', p.budgeted_hours::text)
         from projects p where p.id = $1 and p.deleted_at is null limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let Some(project) = project.map(js_row) else {
        return Ok(None);
    };
    let milestones: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from milestones m where m.project_id = $1 and m.deleted_at is null
         order by m.due_date asc, m.id asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let deliverables: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from project_deliverables d
         where d.project_id = $1 and d.deleted_at is null order by d.number asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let scope: Option<String> =
        sqlx::query_scalar("select statement from project_scope where project_id = $1 limit 1")
            .bind(project_id)
            .fetch_optional(db)
            .await?
            .flatten();
    let owned = |v: &Value, k: &str| text(v, k).map(str::to_owned);
    Ok(Some(PlanState {
        go_live: owned(&project, "endDate"),
        milestones: milestones
            .into_iter()
            .map(js_row)
            .map(|m| PlanMilestone {
                id: owned(&m, "id").unwrap_or_default(),
                name: owned(&m, "name").unwrap_or_default(),
                due_date: owned(&m, "dueDate").unwrap_or_default(),
            })
            .collect(),
        deliverables: deliverables
            .into_iter()
            .map(js_row)
            .map(|d| PlanDeliverable {
                id: owned(&d, "id").unwrap_or_default(),
                number: d["number"].as_i64().unwrap_or(0),
                title: owned(&d, "title").unwrap_or_default(),
                planned_start: owned(&d, "plannedStart"),
                planned_end: owned(&d, "plannedEnd"),
            })
            .collect(),
        budgeted_amount: owned(&project, "budgetedAmount"),
        budgeted_hours: owned(&project, "budgetedHours"),
        budget_currency: owned(&project, "budgetCurrency"),
        scope_statement: scope,
        project_manager_id: owned(&project, "projectManagerId"),
    }))
}

/// `latestBaseline(db, projectId)`.
pub async fn latest_baseline(db: &PgPool, project_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(b) from project_baselines b where b.project_id = $1
         order by b.version desc limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `findBaseline(db, id)`.
pub async fn find_baseline(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(b) from project_baselines b where b.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

/// `presentBaseline(row, change)`: with the code and title of the change behind the version.
pub fn present_baseline(row: &Value, change: Option<(&str, &str)>) -> Value {
    json!({
        "id": row["id"],
        "projectId": row["projectId"],
        "version": row["version"],
        "changeRequestId": row["changeRequestId"],
        "changeRequestCode": change.map(|c| c.0),
        "changeRequestTitle": change.map(|c| c.1),
        "snapshot": row["snapshot"],
        "createdBy": row["createdBy"],
        "createdAt": row["createdAt"],
    })
}

/// `baselineEventData(row)`.
pub fn baseline_event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "projectId": row["projectId"],
        "version": row["version"],
        "changeRequestId": row["changeRequestId"],
        "createdBy": row["createdBy"],
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn plan() -> PlanState {
        PlanState {
            go_live: Some("2026-12-01T00:00:00.000Z".into()),
            milestones: vec![
                PlanMilestone {
                    id: "m2".into(),
                    name: "Beta".into(),
                    due_date: "2026-11-20T00:00:00.000Z".into(),
                },
                PlanMilestone {
                    id: "m1".into(),
                    name: "Alpha".into(),
                    due_date: "2026-11-10T00:00:00.000Z".into(),
                },
            ],
            deliverables: vec![
                PlanDeliverable {
                    id: "d2".into(),
                    number: 2,
                    title: "Manual".into(),
                    planned_start: Some("2026-11-05T00:00:00.000Z".into()),
                    planned_end: Some("2026-11-25T00:00:00.000Z".into()),
                },
                PlanDeliverable {
                    id: "d1".into(),
                    number: 1,
                    title: "App".into(),
                    planned_start: None,
                    planned_end: Some("2026-11-15T00:00:00.000Z".into()),
                },
            ],
            budgeted_amount: Some("12000.00".into()),
            budgeted_hours: Some("300.00".into()),
            budget_currency: Some("EUR".into()),
            scope_statement: Some("Ship the app".into()),
            project_manager_id: None,
        }
    }

    #[test]
    fn decimals_read_and_write_two_places() {
        assert_eq!(decimal(Some("12000")).as_deref(), Some("12000.00"));
        assert_eq!(decimal(Some("-3.1")).as_deref(), Some("-3.10"));
        assert_eq!(decimal(None), None);
        assert_eq!(decimal(Some("")), None);
        assert_eq!(decimal(Some("abc")), None);
        assert_eq!(to_cents("0.05"), Some(5));
        assert_eq!(decimal_sum(Some("0.10"), "0.20"), "0.30");
        assert_eq!(decimal_sum(None, "8000.00"), "8000.00");
        assert_eq!(decimal_sum(Some("100.00"), "-250.50"), "-150.50");
        assert_eq!(
            decimal_delta(Some("100.00"), Some("112.50")).as_deref(),
            Some("12.50")
        );
        assert_eq!(decimal_delta(None, Some("5.00")).as_deref(), Some("5.00"));
        assert_eq!(decimal_delta(None, None), None);
    }

    #[test]
    fn day_delta_counts_whole_days() {
        assert_eq!(
            day_delta(
                Some("2026-11-10T00:00:00.000Z"),
                Some("2026-11-18T00:00:00.000Z")
            ),
            Some(8)
        );
        assert_eq!(
            day_delta(
                Some("2026-11-18T00:00:00.000Z"),
                Some("2026-11-10T00:00:00.000Z")
            ),
            Some(-8)
        );
        assert_eq!(day_delta(None, Some("2026-11-10T00:00:00.000Z")), None);
    }

    #[test]
    fn snapshots_order_and_freeze() {
        let snapshot = build_snapshot(&plan());
        assert_eq!(snapshot["milestones"][0]["id"], "m1");
        assert_eq!(snapshot["deliverables"][0]["id"], "d1");
        assert_eq!(snapshot["budgetedAmount"], "12000.00");
        let mut shuffled = plan();
        shuffled.milestones.reverse();
        shuffled.deliverables.reverse();
        assert_eq!(build_snapshot(&shuffled), snapshot);
        assert!(!baseline_is_empty(&plan()));
        assert!(baseline_is_empty(&PlanState::default()));
    }

    #[test]
    fn comparison_shows_slip_added_removed_and_budget() {
        let from = build_snapshot(&plan());
        let mut later = plan();
        later.go_live = Some("2026-12-09T00:00:00.000Z".into());
        later.milestones[0].due_date = "2026-11-28T00:00:00.000Z".into();
        later.deliverables[0].planned_end = Some("2026-12-03T00:00:00.000Z".into());
        later.budgeted_amount = Some("20000.00".into());
        let diff = compare_snapshots(&from, &build_snapshot(&later));
        assert_eq!(diff["goLive"]["deltaDays"], 8);
        assert_eq!(diff["milestones"][1]["change"], "moved");
        assert_eq!(diff["milestones"][1]["deltaDays"], 8);
        assert_eq!(diff["deliverables"][1]["end"]["deltaDays"], 8);
        assert_eq!(diff["budget"]["delta"], "8000.00");
        assert_eq!(diff["hours"]["delta"], "0.00");

        let mut other = plan();
        other.milestones = vec![PlanMilestone {
            id: "m3".into(),
            name: "Gamma".into(),
            due_date: "2026-11-30T00:00:00.000Z".into(),
        }];
        other.deliverables.remove(0);
        other.deliverables.push(PlanDeliverable {
            id: "d3".into(),
            number: 3,
            title: "Training".into(),
            planned_start: None,
            planned_end: None,
        });
        let diff = compare_snapshots(&from, &build_snapshot(&other));
        let changes = |key: &str| {
            diff[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| {
                    (
                        m["id"].as_str().unwrap().to_owned(),
                        m["change"].as_str().unwrap().to_owned(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            changes("milestones"),
            [
                ("m1".into(), "removed".into()),
                ("m2".into(), "removed".into()),
                ("m3".into(), "added".into())
            ]
        );
        assert_eq!(
            changes("deliverables"),
            [
                ("d1".into(), "unchanged".into()),
                ("d2".into(), "removed".into()),
                ("d3".into(), "added".into())
            ]
        );
    }
}
