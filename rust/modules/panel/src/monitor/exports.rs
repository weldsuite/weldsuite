//! Raw exports: `/api/panel/exports` (`routes/exports/index.ts`,
//! `services/exports.ts`, ADR PANEL-011). A project's events, people, groups
//! and identity links written to the customer's S3-compatible bucket as
//! gzipped JSON Lines, hourly or daily; `weldsuite cron panel-schedule` runs
//! [`run_export`]. Everything here is `panel_projects:manage`.
//!
//!   GET    /                → the project's exports (?projectId)
//!   POST   /                → new export (backfills from `startAt`)
//!   POST   /test            → write and delete `_weldpanel_test.txt` at a destination
//!   GET    /:id             → one export
//!   PATCH  /:id             → name, destination, secret key, tables, frequency
//!   DELETE /:id             → soft delete
//!   GET    /:id/runs        → one row per table and window (?cursor, ?limit)
//!   POST   /:id/pause       → stop writing
//!   POST   /:id/resume      → carry on from where it stopped
//!
//! The runner walks windows of at most an hour from `exported_until` (or
//! `start_at`, never before the plan's retention) up to now − 15 minutes,
//! and writes every chosen table of a window before the cursor moves, so a
//! failure is retried from the same window. Three failures in a row mark the
//! export `failing` and mail the member who set it up.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_EXPORT_CREATED, PANEL_EXPORT_DELETED, PANEL_EXPORT_UPDATED,
};
use weldsuite_emails::panel_monitor::ExportFailingProps;
use weldsuite_db::orm;
use weldsuite_emails::{EmailBrand, SystemEmail, send_system_email};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::export::{
    ExportCursor, ExportPageInput, PANEL_EXPORT_PAGE_SIZE, PanelExportTableName, export_cursor_of,
    export_page_query,
};
use weldsuite_panel_domain::query::{PanelQueryContext, PanelSqlQuery, normalize_rows};
use weldsuite_ports::{BoxFuture, OutboundHttp};
use weldsuite_schema::tenant::{
    panel_export_runs as export_runs, panel_exports as exports, panel_projects,
};

use super::delivery::{Delivery, member_recipients};
use super::s3::{self, Credentials, Destination};
use super::schedule::{
    DAY, EXPORT_LAG_MS, HOUR, delete_schedule, next_export_run, next_runs_of, upsert_schedule,
};
use super::schemas::{
    CREATE_EXPORT, EXPORT_LIST_QUERY, EXPORT_PAGE_QUERY, TEST_EXPORT, UPDATE_EXPORT,
    is_public_hostname,
};
use super::secrets::{self, SecretError};
use super::{MonitorState, master_of, store_failure};
use crate::saved::{field, instant, js_row, project_exists, text};
use crate::{Caller, unexpected};

/// Most windows one run writes for one export (a day of hours).
pub(crate) const MAX_WINDOWS_PER_RUN: i64 = 24;
/// Most pages one table writes for one window.
pub(crate) const MAX_PAGES_PER_WINDOW: i64 = 200;
/// Failed attempts in a row before an export is marked failing.
pub(crate) const FAILURES_BEFORE_FAILING: i64 = 3;

// ---------------------------------------------------------------------------
// Rows and DTOs
// ---------------------------------------------------------------------------

/// `toExportDto(e, nextRunAt)`.
pub(crate) fn dto(row: &Value, next_run_at: Option<&str>) -> Value {
    let d = field(row, "destination");
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "destination": {
            "provider": field(&d, "provider"),
            "endpoint": field(&d, "endpoint"),
            "region": field(&d, "region"),
            "bucket": field(&d, "bucket"),
            "prefix": field(&d, "prefix"),
            "accessKeyId": field(&d, "accessKeyId"),
            "pathStyle": field(&d, "pathStyle"),
        },
        "tables": field(row, "tables"),
        "frequency": field(row, "frequency"),
        "startAt": field(row, "startAt"),
        "exportedUntil": field(row, "exportedUntil"),
        "status": field(row, "status"),
        "lastRunAt": field(row, "lastRunAt"),
        "lastError": field(row, "lastError"),
        "nextRunAt": if text(row, "status") == "paused" { Value::Null } else { next_run_at.map_or(Value::Null, |at| json!(at)) },
        "createdByUserId": field(row, "createdByUserId"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `toExportRunDto(r)`.
fn run_dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "exportId": field(row, "exportId"),
        "table": field(row, "tableName"),
        "windowFrom": field(row, "windowFrom"),
        "windowTo": field(row, "windowTo"),
        "status": field(row, "status"),
        "rows": field(row, "rows"),
        "bytes": field(row, "bytes"),
        "files": field(row, "files"),
        "error": field(row, "error"),
        "startedAt": field(row, "startedAt"),
        "finishedAt": field(row, "finishedAt"),
    })
}

/// `exportEventData(e)`: never the credentials.
fn event_data(row: &Value) -> Value {
    let d = field(row, "destination");
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "provider": field(&d, "provider"),
        "bucket": field(&d, "bucket"),
        "status": field(row, "status"),
    })
}

/// `nextRunOf(e, now)`: `None` while paused or deleted.
pub(crate) fn next_run_of(row: &Value, now: i64) -> Option<i64> {
    if text(row, "status") == "paused" || row.get("deletedAt").is_some_and(|d| !d.is_null()) {
        return None;
    }
    Some(next_export_run(text(row, "frequency"), now))
}

/// The first row a `returning` statement gave, as Drizzle returns it.
fn first_row(rows: Vec<exports::Model>) -> Result<Option<Value>, DbErr> {
    rows.into_iter().next().map(js_row).transpose()
}

/// `getExport(db, id)`.
pub(crate) async fn get_export(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    exports::Entity::find_by_id(id)
        .filter(exports::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(js_row)
        .transpose()
}

/// `destinationOf(d)`: the stored destination of a parsed one.
fn destination_of(d: &Value) -> Value {
    json!({
        "provider": field(d, "provider"),
        "endpoint": field(d, "endpoint"),
        "region": field(d, "region"),
        "bucket": field(d, "bucket"),
        "prefix": field(d, "prefix"),
        "accessKeyId": field(d, "accessKeyId"),
        "pathStyle": field(d, "pathStyle"),
    })
}

fn s3_destination(d: &Value) -> Destination {
    Destination {
        endpoint: d.get("endpoint").and_then(Value::as_str).map(str::to_owned),
        region: text(d, "region").to_owned(),
        bucket: text(d, "bucket").to_owned(),
        path_style: d.get("pathStyle").and_then(Value::as_bool) == Some(true),
    }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/// `basicIso(date)`: `20261114T100000Z`.
pub(crate) fn basic_iso(millis: i64) -> String {
    let iso = js::iso_string(millis);
    let compact: String = iso.chars().filter(|c| *c != '-' && *c != ':').collect();
    match compact.find('.') {
        Some(dot) => format!("{}{}", &compact[..dot], &compact[dot + 4..]),
        None => compact,
    }
}

/// `exportObjectKey(prefix, table, exportId, windowFrom, page)`.
pub(crate) fn export_object_key(
    prefix: &str,
    table: &str,
    export_id: &str,
    window_from: i64,
    page: i64,
) -> String {
    let iso = js::iso_string(window_from);
    let part = if page > 0 {
        format!("-{page}")
    } else {
        String::new()
    };
    let name = format!("{export_id}-{}{part}.jsonl.gz", basic_iso(window_from));
    let path = format!("{table}/dt={}/hour={}/{name}", &iso[..10], &iso[11..13]);
    if prefix.is_empty() {
        path
    } else {
        format!("{prefix}/{path}")
    }
}

/// `toJsonLines(rows)`: one object per row (in `columns` order),
/// `properties` parsed back into an object.
pub(crate) fn to_json_lines(rows: &[Map<String, Value>], columns: &[String]) -> String {
    let mut out = String::new();
    for row in rows {
        let mut keys: Vec<&String> = columns
            .iter()
            .filter(|c| row.contains_key(c.as_str()))
            .collect();
        keys.extend(row.keys().filter(|k| !columns.contains(k)));
        let fields: Vec<String> = keys
            .iter()
            .map(|key| {
                let mut value = row.get(key.as_str()).cloned().unwrap_or(Value::Null);
                if key.as_str() == "properties"
                    && let Value::String(raw) = &value
                    && let Ok(parsed) = serde_json::from_str::<Value>(raw)
                {
                    value = parsed;
                }
                format!("{}:{}", Value::String((*key).clone()), value)
            })
            .collect();
        out.push('{');
        out.push_str(&fields.join(","));
        out.push_str("}\n");
    }
    out
}

/// `windowEnd(from, end)`: the end of the hour `from` falls in, or `end`.
pub(crate) fn window_end(from: i64, end: i64) -> i64 {
    (from.div_euclid(HOUR) * HOUR + HOUR).min(end)
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/// What a run uses besides the database (`ExportRunDeps`).
pub(crate) trait ExportPorts: Send + Sync {
    /// The read scope (`exportContext`); an error is not the destination's.
    fn context(&self) -> BoxFuture<'_, Result<PanelQueryContext, String>>;
    /// Runs one statement on the analytics engine.
    fn execute(&self, query: PanelSqlQuery) -> BoxFuture<'_, Result<Vec<Value>, String>>;
    /// The store's HTTP (public addresses only).
    fn http(&self) -> Option<OutboundHttp>;
    /// Tells the member who set the export up that it is failing.
    fn notify_failing<'a>(&'a self, export: &'a Value, error: &'a str) -> BoxFuture<'a, ()>;
}

/// `ExportRunResult`.
#[derive(Debug, Clone)]
pub(crate) struct RunResult {
    pub(crate) export: Value,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) windows: i64,
    /// Everything up to now − lag is written.
    pub(crate) caught_up: bool,
    pub(crate) error: Option<String>,
}

fn table_of(name: &str) -> PanelExportTableName {
    match name {
        "people" => PanelExportTableName::People,
        "groups" => PanelExportTableName::Groups,
        "identities" => PanelExportTableName::Identities,
        _ => PanelExportTableName::Events,
    }
}

/// `writeTableWindow`: one table's pages of one window, and its run row.
#[allow(clippy::too_many_arguments)]
async fn write_table_window(
    db: &PgPool,
    ports: &dyn ExportPorts,
    export: &Value,
    ctx: &PanelQueryContext,
    credentials: &Credentials,
    table: &str,
    from: i64,
    to: i64,
) -> Result<(), String> {
    let run_id = weldsuite_kit::generate_id("pner");
    export_runs::Entity::insert(export_runs::ActiveModel {
        id: Set(run_id.clone()),
        export_id: Set(text(export, "id").to_owned()),
        project_id: Set(text(export, "projectId").to_owned()),
        table_name: Set(table.to_owned()),
        window_from: Set(instant(from)),
        window_to: Set(instant(to)),
        status: Set("running".to_owned()),
        started_at: Set(instant(js::now_millis())),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await
    .map_err(|error| error.to_string())?;
    let (mut rows, mut bytes, mut files) = (0_i64, 0_i64, 0_i64);
    let outcome = write_pages(
        ports,
        export,
        ctx,
        credentials,
        table,
        from,
        to,
        &mut rows,
        &mut bytes,
        &mut files,
    )
    .await;
    let finished = instant(js::now_millis());
    let (status, error) = match &outcome {
        Ok(()) => ("succeeded", None),
        Err(error) => ("failed", Some(js::slice_utf16(error, 0, 1000))),
    };
    export_runs::Entity::update_many()
        .col_expr(export_runs::Column::Status, Expr::value(status))
        .col_expr(
            export_runs::Column::Rows,
            Expr::value(i32::try_from(rows).unwrap_or(i32::MAX)),
        )
        .col_expr(export_runs::Column::Bytes, Expr::value(bytes))
        .col_expr(
            export_runs::Column::Files,
            Expr::value(i32::try_from(files).unwrap_or(i32::MAX)),
        )
        .col_expr(export_runs::Column::Error, Expr::value(error))
        .col_expr(export_runs::Column::FinishedAt, Expr::value(finished))
        .filter(export_runs::Column::Id.eq(&run_id))
        .exec(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn write_pages(
    ports: &dyn ExportPorts,
    export: &Value,
    ctx: &PanelQueryContext,
    credentials: &Credentials,
    table: &str,
    from: i64,
    to: i64,
    rows: &mut i64,
    bytes: &mut i64,
    files: &mut i64,
) -> Result<(), String> {
    let destination = field(export, "destination");
    let dest = s3_destination(&destination);
    let prefix = text(&destination, "prefix");
    let http = ports.http().ok_or_else(|| "fetch failed".to_owned())?;
    let mut after: Option<ExportCursor> = None;
    for page in 0..MAX_PAGES_PER_WINDOW {
        let query = export_page_query(
            ctx,
            &ExportPageInput {
                table: table_of(table),
                from,
                to,
                after: after.clone(),
                limit: None,
            },
        )
        .map_err(|error| error.message)?;
        let columns = query.columns.clone();
        let result = ports.execute(query).await?;
        let page_rows = normalize_rows(&result, &columns);
        if !page_rows.is_empty() {
            let body = s3::gzip(&to_json_lines(&page_rows, &columns));
            let size = i64::try_from(body.len()).unwrap_or(i64::MAX);
            s3::put_object(
                &http,
                &dest,
                credentials,
                &export_object_key(prefix, table, text(export, "id"), from, page),
                body,
                &[
                    ("content-type", "application/x-ndjson"),
                    ("content-encoding", "gzip"),
                ],
                js::now_millis(),
            )
            .await
            .map_err(|error| error.message)?;
            *rows += i64::try_from(page_rows.len()).unwrap_or(i64::MAX);
            *bytes += size;
            *files += 1;
        }
        if i64::try_from(page_rows.len()).unwrap_or(i64::MAX) < PANEL_EXPORT_PAGE_SIZE {
            return Ok(());
        }
        after = page_rows
            .last()
            .map(|row| export_cursor_of(table_of(table), row));
    }
    Err("Too many rows in one hour for one export run".to_owned())
}

/// `failuresAt(db, exportId, windowFrom)`: failed attempts at the window
/// the export is stuck on, the failures in a row.
async fn failures_at(db: &PgPool, export_id: &str, window_from: i64) -> Result<i64, DbErr> {
    let failures = export_runs::Entity::find()
        .filter(export_runs::Column::ExportId.eq(export_id))
        .filter(export_runs::Column::WindowFrom.eq(instant(window_from)))
        .filter(export_runs::Column::Status.eq("failed"))
        .count(&orm(db))
        .await?;
    Ok(i64::try_from(failures).unwrap_or(i64::MAX))
}

/// `recordFailure(deps, exp, error, windowFrom)`.
async fn record_failure(
    db: &PgPool,
    now: i64,
    ports: &dyn ExportPorts,
    export: &Value,
    error: String,
    window_from: i64,
) -> Result<RunResult, DbErr> {
    let failing = text(export, "status") != "failing"
        && failures_at(db, text(export, "id"), window_from).await? >= FAILURES_BEFORE_FAILING;
    let now = instant(now);
    let mut update = exports::Entity::update_many()
        .col_expr(
            exports::Column::LastError,
            Expr::value(js::slice_utf16(&error, 0, 1000)),
        )
        .col_expr(exports::Column::LastRunAt, Expr::value(now))
        .col_expr(exports::Column::UpdatedAt, Expr::value(now));
    if failing {
        update = update.col_expr(exports::Column::Status, Expr::value("failing"));
    }
    let row = update
        .filter(exports::Column::Id.eq(text(export, "id")))
        .exec_with_returning(&orm(db))
        .await
        .and_then(first_row)?;
    if failing && let Some(row) = &row {
        ports.notify_failing(row, &error).await;
    }
    Ok(RunResult {
        export: row.unwrap_or_else(|| export.clone()),
        windows: 0,
        caught_up: false,
        error: Some(error),
    })
}

/// `runExport(deps, exp)`: writes the export's due windows (bounded per run).
/// A failure is recorded on the export, not returned.
#[allow(clippy::too_many_lines)] // the runner, step by step as the worker's
pub(crate) async fn run_export(
    db: &PgPool,
    now: i64,
    deadline: i64,
    keyring: &weldsuite_db::Keyring,
    ports: &dyn ExportPorts,
    export: &Value,
) -> Result<RunResult, DbErr> {
    let id = text(export, "id").to_owned();
    if text(export, "status") == "paused" || export.get("deletedAt").is_some_and(|d| !d.is_null()) {
        return Ok(RunResult {
            export: export.clone(),
            windows: 0,
            caught_up: true,
            error: None,
        });
    }
    // `prepare`: the scope and the opened key; a failure adds no run row.
    let prepared = match ports.context().await {
        Err(error) => Err(error),
        Ok(ctx) => secrets::open(keyring, text(export, "secretCiphertext"))
            .map(|secret| {
                let credentials = Credentials {
                    access_key_id: text(&field(export, "destination"), "accessKeyId").to_owned(),
                    secret_access_key: secret,
                };
                (ctx, credentials)
            })
            .map_err(|error| error.to_string()),
    };
    let (ctx, credentials) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            exports::Entity::update_many()
                .col_expr(
                    exports::Column::LastError,
                    Expr::value(js::slice_utf16(&error, 0, 1000)),
                )
                .col_expr(exports::Column::LastRunAt, Expr::value(instant(now)))
                .col_expr(exports::Column::UpdatedAt, Expr::value(instant(now)))
                .filter(exports::Column::Id.eq(&id))
                .exec(&orm(db))
                .await?;
            return Ok(RunResult {
                export: export.clone(),
                windows: 0,
                caught_up: false,
                error: Some(error),
            });
        }
    };

    // `now - retentionDays * DAY`, in milliseconds (well inside f64's integers).
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    let floor = now - (ctx.retention_days * DAY as f64) as i64;
    let end = now - EXPORT_LAG_MS;
    let start = export
        .get("exportedUntil")
        .and_then(Value::as_str)
        .or_else(|| export.get("startAt").and_then(Value::as_str))
        .and_then(js::parse_iso)
        .unwrap_or(now);
    let mut cursor = start.max(floor);
    let mut windows = 0;
    let mut current = export.clone();
    let tables: Vec<String> = export["tables"]
        .as_array()
        .map(|t| {
            t.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    while cursor < end && windows < MAX_WINDOWS_PER_RUN && js::now_millis() < deadline {
        let to = window_end(cursor, end);
        let mut failed = None;
        for table in &tables {
            if let Err(error) =
                write_table_window(db, ports, &current, &ctx, &credentials, table, cursor, to).await
            {
                failed = Some(error);
                break;
            }
        }
        if let Some(error) = failed {
            return record_failure(db, now, ports, &current, error, cursor).await;
        }
        let row = exports::Entity::update_many()
            .col_expr(exports::Column::ExportedUntil, Expr::value(instant(to)))
            .col_expr(exports::Column::LastRunAt, Expr::value(instant(now)))
            .col_expr(
                exports::Column::LastError,
                Expr::value(Option::<String>::None),
            )
            .col_expr(exports::Column::UpdatedAt, Expr::value(instant(now)))
            .col_expr(
                exports::Column::Status,
                Expr::case(exports::Column::Status.eq("failing"), "active")
                    .finally(Expr::col(exports::Column::Status))
                    .into(),
            )
            .filter(exports::Column::Id.eq(&id))
            .exec_with_returning(&orm(db))
            .await
            .and_then(first_row)?;
        if let Some(row) = row {
            current = row;
        }
        cursor = to;
        windows += 1;
    }

    if windows == 0 {
        let row = exports::Entity::update_many()
            .col_expr(exports::Column::LastRunAt, Expr::value(instant(now)))
            .col_expr(exports::Column::UpdatedAt, Expr::value(instant(now)))
            .filter(exports::Column::Id.eq(&id))
            .exec_with_returning(&orm(db))
            .await
            .and_then(first_row)?;
        if let Some(row) = row {
            current = row;
        }
    }
    Ok(RunResult {
        export: current,
        windows,
        caught_up: cursor >= end,
        error: None,
    })
}

/// `testDestination(destination, credentials)`: writes
/// `_weldpanel_test.txt` under the prefix and deletes it again.
pub(crate) async fn test_destination(
    http: Option<&OutboundHttp>,
    destination: &Value,
    credentials: &Credentials,
) -> Value {
    let prefix = text(destination, "prefix");
    let key = if prefix.is_empty() {
        "_weldpanel_test.txt".to_owned()
    } else {
        format!("{prefix}/_weldpanel_test.txt")
    };
    let body = b"WeldPanel export test. This file is deleted right after it is written.\n".to_vec();
    let dest = s3_destination(destination);
    let refused = |wrote: bool, error: String| json!({ "ok": false, "wrote": wrote, "deleted": false, "error": error });
    let Some(http) = http else {
        return refused(false, "fetch failed".to_owned());
    };
    let now = js::now_millis();
    if let Err(error) = s3::put_object(
        http,
        &dest,
        credentials,
        &key,
        body,
        &[("content-type", "text/plain")],
        now,
    )
    .await
    {
        return refused(false, error.message);
    }
    if let Err(error) = s3::delete_object(http, &dest, credentials, &key, now).await {
        return refused(true, error.message);
    }
    json!({ "ok": true, "wrote": true, "deleted": true, "error": null })
}

/// `exportsPath()`.
fn exports_path() -> &'static str {
    "/settings/apps/weldpanel?tab=exports"
}

/// `sendExportFailingMail(ctx, exp, lastError)`: in the member's language.
pub(crate) async fn send_failing_mail(
    ctx: &Delivery,
    export: &Value,
    last_error: &str,
) -> Result<u32, String> {
    let Some(transport) = ctx.mail.clone() else {
        return Ok(0);
    };
    let recipients = member_recipients(&ctx.db, &[text(export, "createdByUserId").to_owned()])
        .await
        .map_err(|error| error.to_string())?;
    let Some(recipient) = recipients.first() else {
        return Ok(0);
    };
    let Some(email) = recipient.email.as_deref().filter(|e| !e.is_empty()) else {
        return Ok(0);
    };
    let project: Option<String> = panel_projects::Entity::find_by_id(text(export, "projectId"))
        .select_only()
        .column(panel_projects::Column::Name)
        .into_tuple()
        .one(&orm(&ctx.db))
        .await
        .map_err(|error| error.to_string())?;
    let destination = field(export, "destination");
    let prefix = text(&destination, "prefix");
    let bucket = text(&destination, "bucket");
    let props = ExportFailingProps {
        export_name: text(export, "name").to_owned(),
        project_name: project.unwrap_or_default(),
        bucket: if prefix.is_empty() {
            bucket.to_owned()
        } else {
            format!("{bucket}/{prefix}")
        },
        failures: u32::try_from(FAILURES_BEFORE_FAILING).unwrap_or(3),
        last_error: Some(js::slice_utf16(last_error, 0, 300)),
        url: ctx.app_url(exports_path()),
    };
    let brand = EmailBrand::weldsuite("WeldPanel");
    let rendered =
        weldsuite_emails::panel_monitor::export_failing(recipient.locale, &brand, &props)
            .map_err(|error| error.to_string())?;
    send_system_email(transport.as_ref(), SystemEmail::to(rendered, brand, email))
        .await
        .map_err(|error| error.to_string())?;
    Ok(1)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

fn publish(caller: &Caller, state: &MonitorState, export: &Value, event: EventName) {
    caller.publish(&state.panel, event, text(export, "id"), &event_data(export));
}

async fn export_dto(
    caller: &Caller,
    state: &MonitorState,
    export: &Value,
) -> Result<Value, DbErr> {
    let next = match master_of(caller, state) {
        Some(master) => next_runs_of(&master, "export", &[text(export, "id").to_owned()]).await?,
        None => Vec::new(),
    };
    Ok(dto(export, next.first().map(|(_, at)| at.as_str())))
}

async fn schedule(
    caller: &Caller,
    state: &MonitorState,
    export: &Value,
    next: Option<i64>,
) -> Result<(), DbErr> {
    let Some(master) = master_of(caller, state) else {
        return Ok(());
    };
    upsert_schedule(
        &master,
        &caller.workspace_id,
        "export",
        text(export, "id"),
        next,
    )
    .await
}

/// `unsafeEndpoint(endpoint)`: `checkSafeUrl`'s refusal of a store's
/// endpoint. The schema already refuses anything but a public `https://`
/// origin, so this answers only for what it lets through.
fn unsafe_endpoint(endpoint: Option<&str>) -> Option<String> {
    let endpoint = endpoint.filter(|e| !e.is_empty())?;
    let reason = match url::Url::parse(js::trim(endpoint)) {
        Err(_) => "The URL is not valid",
        Ok(url) if url.scheme() != "https" => "The URL must start with https://",
        Ok(url) if !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) => {
            "The URL must not contain credentials"
        }
        Ok(url) if !is_public_hostname(url.host_str().unwrap_or_default()) => {
            "The URL points at a private or local address"
        }
        Ok(_) => return None,
    };
    Some(format!("The endpoint is not allowed: {reason}"))
}

fn http_of(caller: &Caller, state: &MonitorState) -> Option<OutboundHttp> {
    if caller.conformance() {
        return caller.outbound.clone();
    }
    state.http.clone()
}

/// `GET /`.
pub(crate) async fn list(
    State(state): State<MonitorState>,
    caller: Caller,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&EXPORT_LIST_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let found = exports::Entity::find()
        .filter(exports::Column::ProjectId.eq(query.text("projectId").unwrap_or_default()))
        .filter(exports::Column::DeletedAt.is_null())
        .order_by_desc(exports::Column::CreatedAt)
        .limit(100)
        .all(&orm(&caller.db))
        .await
        .and_then(|found| found.into_iter().map(js_row).collect::<Result<Vec<_>, _>>());
    let exports: Vec<Value> = match found {
        Ok(found) => found,
        Err(error) => return unexpected(&error, "list exports"),
    };
    let ids: Vec<String> = exports.iter().map(|e| text(e, "id").to_owned()).collect();
    let next = match master_of(&caller, &state) {
        Some(master) => match next_runs_of(&master, "export", &ids).await {
            Ok(next) => next,
            Err(error) => return unexpected(&error, "list exports"),
        },
        None => Vec::new(),
    };
    let data: Vec<Value> = exports
        .iter()
        .map(|e| {
            dto(
                e,
                next.iter()
                    .find(|(id, _)| id == text(e, "id"))
                    .map(|(_, at)| at.as_str()),
            )
        })
        .collect();
    let count = data.len() as u64;
    List::new(data, Pagination::new(count, false, None)).into_response()
}

fn sealed(caller: &Caller, secret: &str) -> Result<String, Box<Response>> {
    secrets::seal(&super::keyring_of(caller), secret).map_err(store_failure)
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<MonitorState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let input = match weldsuite_zod::json(&CREATE_EXPORT, &headers, &body) {
        Ok(parsed) => Value::Object(parsed.body),
        Err(response) => return response,
    };
    let project_id = text(&input, "projectId").to_owned();
    match project_exists(&caller.db, &project_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "create export"),
    }
    let destination = field(&input, "destination");
    if let Some(reason) = unsafe_endpoint(destination.get("endpoint").and_then(Value::as_str)) {
        return ApiError::bad_request(reason).into_response();
    }
    let now = js::now_millis();
    let start_at = input
        .get("startAt")
        .and_then(Value::as_str)
        .and_then(js::parse_iso)
        .map_or(now, |at| at.min(now));
    let secret = match sealed(&caller, text(&input, "secretAccessKey")) {
        Ok(secret) => secret,
        Err(response) => return *response,
    };
    let row = exports::Entity::insert(exports::ActiveModel {
        id: Set(weldsuite_kit::generate_id("pnex")),
        project_id: Set(project_id.clone()),
        name: Set(text(&input, "name").to_owned()),
        destination: Set(destination_of(&destination)),
        secret_ciphertext: Set(secret),
        tables: Set(field(&input, "tables")),
        frequency: Set(text(&input, "frequency").to_owned()),
        start_at: Set(instant(start_at)),
        status: Set("active".to_owned()),
        created_by_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row);
    let export = match row {
        Ok(row) => row,
        Err(error) => return unexpected(&error, "create export"),
    };
    // Due at once: the first run (and any backfill) starts with the next cron.
    if let Err(error) = schedule(&caller, &state, &export, Some(now)).await {
        return unexpected(&error, "create export");
    }
    publish(&caller, &state, &export, PANEL_EXPORT_CREATED);
    match export_dto(&caller, &state, &export).await {
        Ok(dto) => Created(dto).into_response(),
        Err(error) => unexpected(&error, "create export"),
    }
}

/// `POST /test`.
pub(crate) async fn test(
    State(state): State<MonitorState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&TEST_EXPORT, &headers, &body) {
        Ok(parsed) => Value::Object(parsed.body),
        Err(response) => return response,
    };
    let mut saved = None;
    if let Some(export_id) = input
        .get("exportId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        match get_export(&caller.db, export_id).await {
            Ok(Some(export)) => saved = Some(export),
            Ok(None) => return ApiError::not_found("Export", Some(export_id)).into_response(),
            Err(error) => return unexpected(&error, "test export"),
        }
    } else if let Some(project_id) = input
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        match project_exists(&caller.db, project_id).await {
            Ok(true) => {}
            Ok(false) => return ApiError::not_found("Project", Some(project_id)).into_response(),
            Err(error) => return unexpected(&error, "test export"),
        }
    }
    let destination = match input.get("destination") {
        Some(destination) => destination.clone(),
        None => match &saved {
            Some(export) => field(export, "destination"),
            None => return ApiError::bad_request("Send a destination").into_response(),
        },
    };
    if let Some(reason) = unsafe_endpoint(destination.get("endpoint").and_then(Value::as_str)) {
        return ApiError::bad_request(reason).into_response();
    }
    let mut secret = input
        .get("secretAccessKey")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if secret.is_none()
        && let Some(export) = &saved
    {
        match secrets::open(
            &super::keyring_of(&caller),
            text(export, "secretCiphertext"),
        ) {
            Ok(opened) => secret = Some(opened),
            Err(SecretError::Unavailable) => {
                return ApiError::unavailable(secrets::UNAVAILABLE).into_response();
            }
            Err(error) => return unexpected(&error, "test export"),
        }
    }
    let Some(secret) = secret else {
        return ApiError::bad_request("Send the secret access key").into_response();
    };
    let credentials = Credentials {
        access_key_id: text(&destination, "accessKeyId").to_owned(),
        secret_access_key: secret,
    };
    Data(
        test_destination(
            http_of(&caller, &state).as_ref(),
            &destination,
            &credentials,
        )
        .await,
    )
    .into_response()
}

async fn found(caller: &Caller, id: &str) -> Result<Value, Response> {
    match get_export(&caller.db, id).await {
        Ok(Some(export)) => Ok(export),
        Ok(None) => Err(ApiError::not_found("Export", Some(id)).into_response()),
        Err(error) => Err(unexpected(&error, "get export")),
    }
}

/// `GET /:id`.
pub(crate) async fn detail(
    State(state): State<MonitorState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let export = match found(&caller, &id).await {
        Ok(export) => export,
        Err(response) => return response,
    };
    match export_dto(&caller, &state, &export).await {
        Ok(dto) => Data(dto).into_response(),
        Err(error) => unexpected(&error, "get export"),
    }
}

/// `PATCH /:id`.
pub(crate) async fn update(
    State(state): State<MonitorState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&UPDATE_EXPORT, &headers, &body) {
        Ok(parsed) => parsed.body,
        Err(response) => return response,
    };
    if let Err(response) = found(&caller, &id).await {
        return response;
    }
    let endpoint = input
        .get("destination")
        .and_then(|d| d.get("endpoint"))
        .and_then(Value::as_str);
    if let Some(reason) = unsafe_endpoint(endpoint) {
        return ApiError::bad_request(reason).into_response();
    }
    let secret = match input
        .get("secretAccessKey")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        Some(plain) => match sealed(&caller, plain) {
            Ok(secret) => Some(secret),
            Err(response) => return *response,
        },
        None => None,
    };
    let now = js::now_millis();
    let text_of = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let mut update = exports::Entity::update_many();
    if input.contains_key("name") {
        update = update.col_expr(exports::Column::Name, Expr::value(text_of("name")));
    }
    if input.contains_key("destination") {
        let destination = input.get("destination").map(destination_of);
        update = update.col_expr(exports::Column::Destination, Expr::value(destination));
    }
    if let Some(secret) = &secret {
        update = update.col_expr(exports::Column::SecretCiphertext, Expr::value(secret));
    }
    if input.contains_key("tables") {
        update = update.col_expr(exports::Column::Tables, Expr::value(input.get("tables").cloned()));
    }
    if input.contains_key("frequency") {
        update = update.col_expr(exports::Column::Frequency, Expr::value(text_of("frequency")));
    }
    let row = update
        .col_expr(exports::Column::UpdatedAt, Expr::value(instant(now)))
        .filter(exports::Column::Id.eq(&id))
        .filter(exports::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(first_row);
    let export = match row {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Export", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "update export"),
    };
    // A new destination or key may fix what was failing: try again with the next cron.
    if text(&export, "status") != "paused" {
        let next = if input.contains_key("destination") || secret.is_some() {
            Some(now)
        } else {
            next_run_of(&export, now)
        };
        if let Err(error) = schedule(&caller, &state, &export, next).await {
            return unexpected(&error, "update export");
        }
    }
    publish(&caller, &state, &export, PANEL_EXPORT_UPDATED);
    match export_dto(&caller, &state, &export).await {
        Ok(dto) => Data(dto).into_response(),
        Err(error) => unexpected(&error, "update export"),
    }
}

/// `DELETE /:id`.
pub(crate) async fn remove(
    State(state): State<MonitorState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let now = instant(js::now_millis());
    let row = exports::Entity::update_many()
        .col_expr(exports::Column::DeletedAt, Expr::value(now))
        .col_expr(exports::Column::UpdatedAt, Expr::value(now))
        .filter(exports::Column::Id.eq(&id))
        .filter(exports::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(first_row);
    let export = match row {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Export", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "delete export"),
    };
    if let Some(master) = master_of(&caller, &state)
        && let Err(error) = delete_schedule(&master, "export", &id).await
    {
        return unexpected(&error, "delete export");
    }
    publish(&caller, &state, &export, PANEL_EXPORT_DELETED);
    NoContent.into_response()
}

/// `GET /:id/runs`.
pub(crate) async fn runs(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&EXPORT_PAGE_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    if let Err(response) = found(&caller, &id).await {
        return response;
    }
    let limit = query.get("limit").and_then(Value::as_i64).unwrap_or(50);
    let mut find = export_runs::Entity::find().filter(export_runs::Column::ExportId.eq(&id));
    if let Some(cursor) = query.text("cursor").and_then(js::parse_iso) {
        find = find.filter(export_runs::Column::StartedAt.lt(instant(cursor)));
    }
    let rows = find
        .order_by_desc(export_runs::Column::StartedAt)
        .limit(u64::try_from(limit + 1).unwrap_or_default())
        .all(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().map(js_row).collect::<Result<Vec<_>, _>>());
    match rows {
        Ok(rows) => super::alerts::page(rows, limit, "startedAt", run_dto),
        Err(error) => unexpected(&error, "export runs"),
    }
}

/// `setExportStatus(db, id, status)`.
async fn set_status(db: &PgPool, id: &str, status: &str) -> Result<Option<Value>, DbErr> {
    let mut update = exports::Entity::update_many()
        .col_expr(exports::Column::Status, Expr::value(status))
        .col_expr(
            exports::Column::UpdatedAt,
            Expr::value(instant(js::now_millis())),
        );
    if status == "active" {
        update = update.col_expr(
            exports::Column::LastError,
            Expr::value(Option::<String>::None),
        );
    }
    update
        .filter(exports::Column::Id.eq(id))
        .filter(exports::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await
        .and_then(first_row)
}

/// `POST /:id/pause`.
pub(crate) async fn pause(
    State(state): State<MonitorState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let export = match set_status(&caller.db, &id, "paused").await {
        Ok(Some(export)) => export,
        Ok(None) => return ApiError::not_found("Export", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "pause export"),
    };
    if let Some(master) = master_of(&caller, &state)
        && let Err(error) = delete_schedule(&master, "export", &id).await
    {
        return unexpected(&error, "pause export");
    }
    publish(&caller, &state, &export, PANEL_EXPORT_UPDATED);
    match export_dto(&caller, &state, &export).await {
        Ok(dto) => Data(dto).into_response(),
        Err(error) => unexpected(&error, "pause export"),
    }
}

/// `POST /:id/resume`.
pub(crate) async fn resume(
    State(state): State<MonitorState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let existing = match found(&caller, &id).await {
        Ok(export) => export,
        Err(response) => return response,
    };
    let export = if text(&existing, "status") == "paused" {
        match set_status(&caller.db, &id, "active").await {
            Ok(Some(export)) => export,
            Ok(None) => return ApiError::not_found("Export", Some(&id)).into_response(),
            Err(error) => return unexpected(&error, "resume export"),
        }
    } else {
        existing
    };
    if let Err(error) = schedule(&caller, &state, &export, Some(js::now_millis())).await {
        return unexpected(&error, "resume export");
    }
    publish(&caller, &state, &export, PANEL_EXPORT_UPDATED);
    match export_dto(&caller, &state, &export).await {
        Ok(dto) => Data(dto).into_response(),
        Err(error) => unexpected(&error, "resume export"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> i64 {
        js::parse_iso(iso).expect("iso")
    }

    // `exports.test.ts`: keys and lines.
    #[test]
    fn names_files_by_table_day_hour_export_and_window_start() {
        let from = at("2026-11-16T10:00:00Z");
        assert_eq!(basic_iso(from), "20261116T100000Z");
        assert_eq!(
            export_object_key("raw/weldpanel", "events", "pnex_1", from, 0),
            "raw/weldpanel/events/dt=2026-11-16/hour=10/pnex_1-20261116T100000Z.jsonl.gz"
        );
        assert_eq!(
            export_object_key("", "people", "pnex_1", from, 2),
            "people/dt=2026-11-16/hour=10/pnex_1-20261116T100000Z-2.jsonl.gz"
        );
    }

    #[test]
    fn writes_one_json_object_per_line_properties_as_an_object() {
        let rows: Vec<Map<String, Value>> = vec![
            json!({ "a": 1, "properties": "{\"plan\":\"pro\"}" })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            json!({ "a": 2, "properties": "not json" })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        ];
        let columns = vec!["a".to_owned(), "properties".to_owned()];
        assert_eq!(
            to_json_lines(&rows, &columns),
            "{\"a\":1,\"properties\":{\"plan\":\"pro\"}}\n{\"a\":2,\"properties\":\"not json\"}\n"
        );
        assert_eq!(to_json_lines(&[], &columns), "");
    }

    #[test]
    fn cuts_windows_at_the_hour_or_at_the_end() {
        let now = at("2026-11-16T12:00:00Z");
        assert_eq!(
            js::iso_string(window_end(at("2026-11-16T10:20:00Z"), now)),
            "2026-11-16T11:00:00.000Z"
        );
        assert_eq!(
            js::iso_string(window_end(
                at("2026-11-16T11:00:00Z"),
                at("2026-11-16T11:45:00Z")
            )),
            "2026-11-16T11:45:00.000Z"
        );
    }

    #[test]
    fn refuses_only_what_check_safe_url_refuses() {
        assert_eq!(unsafe_endpoint(Some("https://minio.example.com")), None);
        assert_eq!(unsafe_endpoint(None), None);
        assert_eq!(
            unsafe_endpoint(Some("http://minio.example.com")).as_deref(),
            Some("The endpoint is not allowed: The URL must start with https://")
        );
    }
}
