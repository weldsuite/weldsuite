//! `/api/digest-settings` (`routes/digest-settings/index.ts`): the
//! workspace's daily task digest settings, a singleton in the tenant
//! database, with the schedule (enabled, hour, timezone) mirrored into the
//! master database's `digest_schedules` for the hourly sweep.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::DIGEST_SETTINGS_UPDATED;
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, FlowState, Refusal, now, reply, validate};

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(settings).route_layer(need("settings:read")))
        .route("/", put(save).route_layer(need("settings:manage")))
        .with_state(state)
}

async fn settings(caller: Caller) -> Response {
    reply(
        async {
            let row: Option<Value> =
                sqlx::query_scalar("select to_jsonb(s) from task_digest_settings s limit 1")
                    .fetch_optional(&caller.db)
                    .await?;
            Ok(Data(row.map_or_else(
                || {
                    json!({
                        "id": null,
                        "enabled": true,
                        "sendHour": 8,
                        "taskTypes": { "projectTasks": true, "personalTasks": true },
                        "sections": { "overdue": true, "dueToday": true, "dueThisWeek": true },
                        "createdAt": null,
                        "updatedAt": null,
                    })
                },
                js_row,
            ))
            .into_response())
        }
        .await,
        "Failed to fetch digest settings",
    )
}

/// `updateDigestSettingsSchema`.
struct DigestBody {
    enabled: bool,
    send_hour: i64,
    task_types: Value,
    sections: Value,
}

async fn save(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let enabled = issues.boolean(fields, "enabled", Presence::Required);
        let send_hour = issues.whole_number(
            fields,
            "sendHour",
            Presence::Required,
            Number {
                coerce: false,
                int: true,
                min: Some(0.0),
                max: Some(23.0),
            },
        );
        let task_types = issues.nested(fields, "taskTypes", Presence::Required, |issues, f| {
            let project = issues.boolean(f, "projectTasks", Presence::Required);
            let personal = issues.boolean(f, "personalTasks", Presence::Required);
            json!({ "projectTasks": project.into_option(), "personalTasks": personal.into_option() })
        });
        let sections = issues.nested(fields, "sections", Presence::Required, |issues, f| {
            let overdue = issues.boolean(f, "overdue", Presence::Required);
            let today = issues.boolean(f, "dueToday", Presence::Required);
            let week = issues.boolean(f, "dueThisWeek", Presence::Required);
            json!({
                "overdue": overdue.into_option(),
                "dueToday": today.into_option(),
                "dueThisWeek": week.into_option(),
            })
        });
        DigestBody {
            enabled: enabled.into_option().unwrap_or_default(),
            send_hour: send_hour.into_option().unwrap_or_default(),
            task_types: task_types.into_option().unwrap_or(Value::Null),
            sections: sections.into_option().unwrap_or(Value::Null),
        }
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    reply(
        save_settings(&state, &caller, &org_id, &input).await,
        "Failed to update digest settings",
    )
}

async fn save_settings(
    state: &FlowState,
    caller: &Caller,
    org_id: &str,
    input: &DigestBody,
) -> crate::Reply {
    let db = &caller.db;
    let send_hour = i32::try_from(input.send_hour).unwrap_or(0);
    let existing: Option<String> =
        sqlx::query_scalar("select id from task_digest_settings limit 1")
            .fetch_optional(db)
            .await?;
    let settings: Value = if let Some(id) = existing {
        sqlx::query_scalar(
            "update task_digest_settings set enabled = $2, send_hour = $3, task_types = $4,
                    sections = $5, updated_at = $6::timestamptz
             where id = $1 returning to_jsonb(task_digest_settings)",
        )
        .bind(&id)
        .bind(input.enabled)
        .bind(send_hour)
        .bind(&input.task_types)
        .bind(&input.sections)
        .bind(now())
        .fetch_one(db)
        .await?
    } else {
        sqlx::query_scalar(
            "insert into task_digest_settings (id, enabled, send_hour, task_types, sections)
             values ($1, $2, $3, $4, $5) returning to_jsonb(task_digest_settings)",
        )
        .bind(generate_id("tds"))
        .bind(input.enabled)
        .bind(send_hour)
        .bind(&input.task_types)
        .bind(&input.sections)
        .fetch_one(db)
        .await?
    };
    let settings = js_row(settings);
    let timezone: Option<Option<String>> =
        sqlx::query_scalar("select timezone from workspace_settings limit 1")
            .fetch_optional(db)
            .await?;
    let timezone = timezone
        .flatten()
        .filter(|tz| !tz.is_empty())
        .unwrap_or_else(|| "UTC".to_owned());
    // The master database: `getMasterDb(c.env)` fails without one.
    let Some(master) = caller.master(state) else {
        return Err(Refusal::Internal("no master database".to_owned()));
    };
    let workspace: Option<String> =
        sqlx::query_scalar("select id from workspaces where clerk_org_id = $1 limit 1")
            .bind(org_id)
            .fetch_optional(&master)
            .await?;
    if let Some(workspace) = workspace {
        let schedule: Option<String> =
            sqlx::query_scalar("select id from digest_schedules where workspace_id = $1 limit 1")
                .bind(&workspace)
                .fetch_optional(&master)
                .await?;
        if let Some(schedule) = schedule {
            sqlx::query(
                "update digest_schedules set enabled = $2, send_hour = $3, timezone = $4,
                        updated_at = $5::timestamptz
                 where id = $1",
            )
            .bind(&schedule)
            .bind(input.enabled)
            .bind(send_hour)
            .bind(&timezone)
            .bind(now())
            .execute(&master)
            .await?;
        } else {
            sqlx::query(
                "insert into digest_schedules (id, workspace_id, enabled, send_hour, timezone)
                 values ($1, $2, $3, $4, $5)",
            )
            .bind(generate_id("ds"))
            .bind(&workspace)
            .bind(input.enabled)
            .bind(send_hour)
            .bind(&timezone)
            .execute(&master)
            .await?;
        }
    }
    let id = settings["id"].as_str().unwrap_or_default().to_owned();
    caller.publish(state, DIGEST_SETTINGS_UPDATED, &id, &settings);
    Ok(Data(settings).into_response())
}
