//! `GET /api/panel/usage` (`routes/usage`): this month's events and
//! recordings against the plan allowance, the overage charged to the wallet,
//! the quota state the collector applies and what the plan keeps for how
//! long. `panel_projects:manage`, as for keys and privacy settings.
//!
//! Reading it also settles when the quota is not `ok` ([`settle_usage`]):
//! after a wallet top-up the unpaid blocks are charged again here, and the
//! collector stops dropping data without waiting for the next settlement.
//! The per-project split comes from the analytics engine
//! (`services/usage-projects.ts`), best effort: zeros without it.

use std::collections::HashMap;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use weldsuite_kit::{ApiError, Data};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::scope::{events_table, replay_chunks_table};
use weldsuite_panel_domain::query::sql::{lit, ts};
use weldsuite_panel_domain::query::{PanelSqlQuery, normalize_rows};
use weldsuite_ports::Cache;

use crate::engine::AnalyticsSql;
use crate::usage_mail::mail_notice;
use crate::usage_settlement::{
    FAVORITE_RETENTION_MONTHS, Settlement, SettlementInput, UsageMonth, load_workspace_plan,
    month_of, parse_quota_state, quota_cache_key, quota_for, settle_usage, usage_row,
};
use crate::{Caller, PanelState, unexpected};

/// `Number(value) || 0`.
fn count_of(value: Option<&Value>) -> f64 {
    let n = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => js::string_to_number(s),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    };
    if n.is_nan() { 0.0 } else { n }
}

/// `projectUsage`: events and recordings per project in one month, from the
/// engine (events by `received_at`, recordings as the sessions whose first
/// chunk arrived). `None` without an engine or when a statement fails.
async fn project_usage(
    engine: Option<std::sync::Arc<dyn AnalyticsSql>>,
    workspace_id: &str,
    month: &str,
) -> Option<HashMap<String, (f64, f64)>> {
    let engine = engine?;
    let (year, month_no) = month.split_once('-')?;
    let year: i64 = year.parse().ok()?;
    let month_no: i64 = month_no.parse().ok()?;
    let from = js::date_utc(year, month_no - 1, 1);
    let to = js::date_utc(year, month_no, 1);
    let workspace = lit(workspace_id).ok()?;
    let scope = |column: &str| {
        format!(
            "workspace_id = {workspace} AND {column} >= {} AND {column} < {}",
            ts(from),
            ts(to)
        )
    };
    let names: Vec<String> = ["project_id", "n"].map(str::to_owned).to_vec();
    let statement = |name: &str, sql: String| PanelSqlQuery {
        name: name.to_owned(),
        sql,
        columns: names.clone(),
    };
    let events = statement(
        "usage.events",
        format!(
            "SELECT project_id, COUNT(*) AS n FROM {} WHERE {} GROUP BY project_id",
            events_table(),
            scope("received_at")
        ),
    );
    let recordings = statement(
        "usage.recordings",
        format!(
            "SELECT project_id, COUNT(*) AS n FROM {} WHERE {} AND seq = 0 GROUP BY project_id",
            replay_chunks_table(),
            scope("ts_start")
        ),
    );
    let (events, recordings) =
        futures_util::join!(engine.execute(events), engine.execute(recordings));
    let (events, recordings) = match (events, recordings) {
        (Ok(events), Ok(recordings)) => (events, recordings),
        (Err(error), _) | (_, Err(error)) => {
            tracing::warn!(%error, workspace = workspace_id, "[panel-api] per-project usage lookup failed");
            return None;
        }
    };
    let mut counts: HashMap<String, (f64, f64)> = HashMap::new();
    for (rows, recordings_column) in [(events.rows, false), (recordings.rows, true)] {
        for row in normalize_rows(&rows, &names) {
            let id = match row.get("project_id") {
                Some(Value::Null) | None => String::new(),
                Some(value) => js::value_text(value),
            };
            if id.is_empty() {
                continue;
            }
            let entry = counts.entry(id).or_insert((0.0, 0.0));
            let n = count_of(row.get("n"));
            if recordings_column {
                entry.1 = n;
            } else {
                entry.0 = n;
            }
        }
    }
    Some(counts)
}

/// `GET /`.
#[allow(
    clippy::too_many_lines,
    reason = "the TypeScript's one handler, step by step"
)]
pub(crate) async fn usage(State(state): State<PanelState>, caller: Caller) -> Response {
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let Some(master) = caller.master(&state) else {
        return unexpected(&"no master database", "usage");
    };
    let cache = caller.cache(&state);
    let now = caller.now().unwrap_or_else(js::now_millis);
    let month = month_of(now);

    let workspace = match load_workspace_plan(&master, &caller.workspace_id).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => {
            return ApiError::not_found("Workspace", Some(&caller.workspace_id)).into_response();
        }
        Err(error) => return unexpected(&error, "load workspace plan"),
    };
    let mut usage = match usage_row(&master, &caller.workspace_id, &month).await {
        Ok(row) => row.unwrap_or_default(),
        Err(error) => return unexpected(&error, "usage row"),
    };
    let mut quota = quota_for(&workspace.limits, &usage, state.bill_overage);

    let collector_state = match &cache {
        Some(cache) => match cache.get(&quota_cache_key(&caller.workspace_id)).await {
            Ok(raw) => parse_quota_state(raw.as_deref()),
            Err(error) => return unexpected(&error, "quota state"),
        },
        None => "ok",
    };
    if quota != "ok" || collector_state != "ok" {
        let settlement = Settlement {
            master: &master,
            cache: cache.as_ref(),
            now,
            bill: state.bill_overage,
        };
        let input = SettlementInput {
            workspace_id: caller.workspace_id.clone(),
            month: month.clone(),
            events: usage.events,
            recordings: usage.recordings,
        };
        match settle_usage(&settlement, &input).await {
            Ok(Some(settled)) => {
                // `notify`: the owners of this workspace are mailed where the
                // server has mail; without it the notice is claimed only, as
                // panel-api claims it without a mail binding.
                if let (Some(notice), Some(transport)) = (&settled.notice, &state.mail) {
                    mail_notice(
                        transport.as_ref(),
                        &caller.db,
                        notice,
                        caller.env("PLATFORM_URL").as_deref(),
                    )
                    .await;
                }
                usage = settled.usage;
                quota = settled.quota;
            }
            Ok(None) => {}
            Err(error) => return unexpected(&error, "settle usage"),
        }
    }

    let projects: Result<Vec<(String, String)>, sqlx::Error> = sqlx::query_as(
        "select id, name from panel_projects where deleted_at is null order by created_at asc, id asc",
    )
    .fetch_all(&caller.db)
    .await;
    let projects = match projects {
        Ok(projects) => projects,
        Err(error) => return unexpected(&error, "list projects"),
    };
    let counts = project_usage(caller.analytics(&state), &caller.workspace_id, &month).await;
    let mut rows: Vec<(f64, f64, String, Value)> = projects
        .into_iter()
        .map(|(id, name)| {
            let (events, recordings) = counts
                .as_ref()
                .and_then(|c| c.get(&id))
                .copied()
                .unwrap_or((0.0, 0.0));
            let row = json!({ "projectId": id, "name": name, "events": events, "recordings": recordings });
            (events, recordings, name, row)
        })
        .collect();
    rows.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then(b.1.total_cmp(&a.1))
            .then_with(|| js::locale_compare(&a.2, &b.2))
    });

    let meter = |used: i64, allowance: i64, blocks: i64, credits: i64| json!({ "used": used, "allowance": allowance, "blocksCharged": blocks, "creditsCharged": credits });
    let UsageMonth {
        events,
        recordings,
        event_blocks_charged,
        recording_blocks_charged,
        event_credits_charged,
        recording_credits_charged,
        ..
    } = usage;
    let limits = workspace.limits;
    Data(js::json_numbers(json!({
        "month": month,
        "planSlug": workspace.plan_slug.as_deref().unwrap_or("free"),
        "events": meter(events, limits.events, event_blocks_charged, event_credits_charged),
        "recordings": meter(recordings, limits.recordings, recording_blocks_charged, recording_credits_charged),
        "quota": quota,
        "retention": {
            "eventsMonths": limits.event_retention_months,
            "recordingsDays": limits.recording_retention_days,
            "favoritesMonths": FAVORITE_RETENTION_MONTHS,
        },
        "projects": rows.into_iter().map(|(_, _, _, row)| row).collect::<Vec<_>>(),
    })))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_read_like_javascript_numbers() {
        assert_eq!(count_of(Some(&json!("900"))), 900.0);
        assert_eq!(count_of(Some(&json!(40))), 40.0);
        assert_eq!(count_of(Some(&json!("x"))), 0.0);
        assert_eq!(count_of(None), 0.0);
    }
}
