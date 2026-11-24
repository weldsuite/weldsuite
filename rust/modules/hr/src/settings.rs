//! The My HR switches (`routes/weldhr/settings.ts`, `services/weldhr/settings.ts`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::response::IntoResponse;
use axum::routing::{get, put};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Value, json};
use weldsuite_catalogs::permission_keys::{EMPLOYEES_MANAGE, EMPLOYEES_READ};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::hr_settings;

use crate::fields::change;
use crate::shared::row_json;
use crate::{Caller, HrError, HrResult, HrState, hr_json};

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
    let db = orm(db);
    if let Some(row) = hr_settings::Entity::find().one(&db).await? {
        return Ok(row_json(row)?);
    }
    let created = hr_settings::Entity::insert(hr_settings::ActiveModel {
        id: Set(generate_id("hrset")),
        ..Default::default()
    })
    .exec_with_returning(&db)
    .await?;
    Ok(row_json(created)?)
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
    let columns = [
        hr_settings::Column::EmployeeSelfClockIn,
        hr_settings::Column::ClockInRequiresLocation,
        hr_settings::Column::EmployeeLeaveRequests,
        hr_settings::Column::EmployeeDeclarations,
    ];
    let mut update = hr_settings::Entity::update_many();
    for (column, field) in columns.into_iter().zip(&input) {
        if let (true, value) = change(field) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    let row = update
        .col_expr(hr_settings::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(hr_settings::Column::Id.eq(id))
        .exec_with_returning(&orm(&caller.db))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound("hr_settings".to_owned()))?;
    let fields: Vec<&str> = KEYS
        .iter()
        .zip(&input)
        .filter(|(_, field)| !field.is_absent())
        .map(|(key, _)| *key)
        .collect();
    caller
        .audit("settings.updated", None, json!({ "fields": fields }))
        .await?;
    Ok(Data(row_json(row)?).into_response())
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
