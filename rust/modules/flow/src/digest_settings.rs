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
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::DIGEST_SETTINGS_UPDATED;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::{digest_schedules, workspaces};
use weldsuite_schema::tenant::{task_digest_settings as digest, workspace_settings};

use crate::{Caller, FlowState, Refusal, reply, row_json, validate};

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
            let row = digest::Entity::find()
                .one(&orm(&caller.db))
                .await?
                .map(row_json)
                .transpose()?;
            Ok(Data(row.unwrap_or_else(|| {
                json!({
                    "id": null,
                    "enabled": true,
                    "sendHour": 8,
                    "taskTypes": { "projectTasks": true, "personalTasks": true },
                    "sections": { "overdue": true, "dueToday": true, "dueThisWeek": true },
                    "createdAt": null,
                    "updatedAt": null,
                })
            }))
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
    let db = orm(&caller.db);
    let send_hour = i32::try_from(input.send_hour).unwrap_or(0);
    let existing: Option<String> = digest::Entity::find()
        .select_only()
        .column(digest::Column::Id)
        .into_tuple()
        .one(&db)
        .await?;
    let settings = if let Some(id) = existing {
        digest::Entity::update_many()
            .col_expr(digest::Column::Enabled, Expr::value(input.enabled))
            .col_expr(digest::Column::SendHour, Expr::value(send_hour))
            .col_expr(
                digest::Column::TaskTypes,
                Expr::value(input.task_types.clone()),
            )
            .col_expr(
                digest::Column::Sections,
                Expr::value(input.sections.clone()),
            )
            .col_expr(
                digest::Column::UpdatedAt,
                Expr::value(utc_now().assume_utc()),
            )
            .filter(digest::Column::Id.eq(&id))
            .exec_with_returning(&db)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| DbErr::RecordNotFound("task_digest_settings".to_owned()))?
    } else {
        digest::Entity::insert(digest::ActiveModel {
            id: Set(generate_id("tds")),
            enabled: Set(input.enabled),
            send_hour: Set(send_hour),
            task_types: Set(input.task_types.clone()),
            sections: Set(input.sections.clone()),
            ..Default::default()
        })
        .exec_with_returning(&db)
        .await?
    };
    let settings = row_json(settings)?;
    let timezone: Option<Option<String>> = workspace_settings::Entity::find()
        .select_only()
        .column(workspace_settings::Column::Timezone)
        .into_tuple()
        .one(&db)
        .await?;
    let timezone = timezone
        .flatten()
        .filter(|tz| !tz.is_empty())
        .unwrap_or_else(|| "UTC".to_owned());
    // The master database: `getMasterDb(c.env)` fails without one.
    let Some(master) = caller.master(state) else {
        return Err(Refusal::Internal("no master database".to_owned()));
    };
    let master = orm(&master);
    let workspace: Option<String> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .filter(workspaces::Column::ClerkOrgId.eq(org_id))
        .into_tuple()
        .one(&master)
        .await?;
    if let Some(workspace) = workspace {
        let schedule: Option<String> = digest_schedules::Entity::find()
            .select_only()
            .column(digest_schedules::Column::Id)
            .filter(digest_schedules::Column::WorkspaceId.eq(&workspace))
            .into_tuple()
            .one(&master)
            .await?;
        if let Some(schedule) = schedule {
            digest_schedules::Entity::update_many()
                .col_expr(
                    digest_schedules::Column::Enabled,
                    Expr::value(input.enabled),
                )
                .col_expr(digest_schedules::Column::SendHour, Expr::value(send_hour))
                .col_expr(digest_schedules::Column::Timezone, Expr::value(&timezone))
                .col_expr(
                    digest_schedules::Column::UpdatedAt,
                    Expr::value(utc_now().assume_utc()),
                )
                .filter(digest_schedules::Column::Id.eq(&schedule))
                .exec(&master)
                .await?;
        } else {
            digest_schedules::Entity::insert(digest_schedules::ActiveModel {
                id: Set(generate_id("ds")),
                workspace_id: Set(workspace),
                enabled: Set(input.enabled),
                send_hour: Set(send_hour),
                timezone: Set(timezone),
                ..Default::default()
            })
            .exec_without_returning(&master)
            .await?;
        }
    }
    let id = settings["id"].as_str().unwrap_or_default().to_owned();
    caller.publish(state, DIGEST_SETTINGS_UPDATED, &id, &settings);
    Ok(Data(settings).into_response())
}
