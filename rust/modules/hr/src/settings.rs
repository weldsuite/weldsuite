//! The My HR switches (`routes/weldhr/settings.ts`, `services/weldhr/settings.ts`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::response::IntoResponse;
use axum::routing::{get, put};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::permission_keys::{EMPLOYEES_MANAGE, EMPLOYEES_READ};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::fields::change;
use crate::{Caller, HrError, HrResult, HrState, hr_json, now};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/settings",
            get(read).route_layer(gate.require([EMPLOYEES_READ])),
        )
        .route(
            "/settings",
            put(update).route_layer(gate.require([EMPLOYEES_MANAGE])),
        )
}

/// `loadHrSettings(db)`: the singleton row, created with the defaults on
/// first read.
pub(crate) async fn load_hr_settings(db: &PgPool) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(s) from hr_settings s limit 1")
        .fetch_optional(db)
        .await?;
    if let Some(row) = row {
        return Ok(js_row(row));
    }
    let created: Value = sqlx::query_scalar(
        "insert into hr_settings (id) values ($1) returning to_jsonb(hr_settings)",
    )
    .bind(generate_id("hrset"))
    .fetch_one(db)
    .await?;
    Ok(js_row(created))
}

async fn read(caller: Caller) -> HrResult {
    Ok(Data(load_hr_settings(&caller.db).await?).into_response())
}

const KEYS: [&str; 4] = [
    "employeeSelfClockIn",
    "clockInRequiresLocation",
    "employeeLeaveRequests",
    "employeeDeclarations",
];

async fn update(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input: Vec<Field<bool>> = hr_json(&headers, &body, |issues, fields| {
        KEYS.iter()
            .map(|key| issues.boolean(fields, key, Presence::Optional))
            .collect()
    })?;
    let current = load_hr_settings(&caller.db).await?;
    let id = current["id"].as_str().unwrap_or_default().to_owned();
    let [self_clock, location, leave, declarations] = [0, 1, 2, 3].map(|i| change(&input[i]));
    let row: Value = sqlx::query_scalar(
        "update hr_settings set
             employee_self_clock_in = case when $2 then $3 else employee_self_clock_in end,
             clock_in_requires_location = case when $4 then $5 else clock_in_requires_location end,
             employee_leave_requests = case when $6 then $7 else employee_leave_requests end,
             employee_declarations = case when $8 then $9 else employee_declarations end,
             updated_at = $10::timestamp
         where id = $1 returning to_jsonb(hr_settings)",
    )
    .bind(&id)
    .bind(self_clock.0)
    .bind(self_clock.1)
    .bind(location.0)
    .bind(location.1)
    .bind(leave.0)
    .bind(leave.1)
    .bind(declarations.0)
    .bind(declarations.1)
    .bind(now())
    .fetch_one(&caller.db)
    .await?;
    let fields: Vec<&str> = KEYS
        .iter()
        .zip(&input)
        .filter(|(_, field)| !field.is_absent())
        .map(|(key, _)| *key)
        .collect();
    caller
        .audit("settings.updated", None, json!({ "fields": fields }))
        .await?;
    Ok(Data(js_row(row)).into_response())
}

/// The switches `/me` reads (`features(c)` in me.ts).
pub(crate) struct HrFeatures {
    pub(crate) self_clock_in: bool,
    pub(crate) clock_in_requires_location: bool,
    pub(crate) leave_requests: bool,
    pub(crate) declarations: bool,
}

impl HrFeatures {
    pub(crate) async fn load(db: &PgPool) -> Result<Self, HrError> {
        let settings = load_hr_settings(db).await?;
        Ok(Self {
            self_clock_in: settings["employeeSelfClockIn"] == true,
            clock_in_requires_location: settings["clockInRequiresLocation"] == true,
            leave_requests: settings["employeeLeaveRequests"] == true,
            declarations: settings["employeeDeclarations"] == true,
        })
    }

    pub(crate) fn json(&self) -> Value {
        json!({
            "selfClockIn": self.self_clock_in,
            "clockInRequiresLocation": self.clock_in_requires_location,
            "leaveRequests": self.leave_requests,
            "declarations": self.declarations,
        })
    }
}
