//! `/api/audit-log-streams` (`app-api/src/routes/audit-log-streams`): where a
//! workspace's audit log is pushed (a SIEM).
//!
//! Every route needs `general:update`, the list too: a collector URL can
//! carry a secret in its path or query. By default only OWNER and ADMIN hold
//! it: sending the audit log to an outside URL is an administrator action.
//!
//! The collector token is write-only: stored field-encrypted with the tenant
//! keyring (`token_encrypted`, as `encryptField` seals it, so either backend
//! opens what the other stored), never selected back out by these routes,
//! never put in an entity event or a log. Rows carry `hasToken` instead.
//! Entity events carry less still (`event_data`): the audit log they end
//! up in is open to `general:read`.
//!
//! Delivery itself runs in the audit subscriber
//! (`weldsuite_subscribers::audit_streams`); these routes only manage the
//! streams and send the test event, through [`AuditStreamGateway`], which
//! the server implements over that crate.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{
    Expr, InsertStatement, Order, Query, SelectStatement, UpdateStatement,
};
use sea_orm::{ConnectionTrait, DbErr, EntityTrait, PaginatorTrait, QueryResult, QuerySelect};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    AUDIT_LOG_STREAM_CREATED, AUDIT_LOG_STREAM_DELETED, AUDIT_LOG_STREAM_UPDATED,
};
use weldsuite_catalogs::permission_keys::GENERAL_UPDATE;
use weldsuite_db::{Keyring, encrypt_field, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{BoxFuture, OutboundHttp};
use weldsuite_schema::tenant::audit_log_streams;

use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, validate};

const RESOURCE: &str = "Audit log stream";

/// Streams a workspace may have; the next create answers 409
/// (`MAX_AUDIT_LOG_STREAMS`).
const MAX_AUDIT_LOG_STREAMS: i64 = 5;

const STREAM_TYPES: [&str; 2] = ["splunk_hec", "http"];
const STREAM_FORMATS: [&str; 2] = ["json", "ndjson"];
/// What a member may set; `disabled` is set by the platform only.
const SETTABLE_STATUSES: [&str; 2] = ["active", "paused"];

// ── the delivery side ───────────────────────────────────────────────────────

/// One test event to a stream's destination (`sendAuditLogStreamTest`'s
/// arguments).
#[derive(Debug, Clone)]
pub struct AuditStreamTest<'a> {
    /// `splunk_hec` or `http`.
    pub kind: &'a str,
    pub url: &'a str,
    /// The `settings` column as JSON text.
    pub settings: Option<&'a str>,
    pub token_encrypted: Option<&'a str>,
    pub keyring: &'a Keyring,
    pub workspace_id: &'a str,
    /// The request's outbound HTTP, when it brings one (conformance builds:
    /// the test's fetch stub); the gateway's own client otherwise.
    pub http: Option<OutboundHttp>,
}

/// What the destination answered to the test event
/// (`auditLogStreamTestResultSchema`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditStreamTestResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// What these routes need from audit log stream delivery
/// (`@weldsuite/worker-kit/safe-url` and
/// `@weldsuite/core-domain/audit-streams`).
pub trait AuditStreamGateway: Send + Sync {
    /// `checkSafeUrl(raw)`: the URL as `URL.toString()` writes it, or why
    /// the server may not call it, in words fit for a form.
    fn check_url(&self, raw: &str) -> Result<String, String>;

    /// `sendAuditLogStreamTest(stream, { keyring, workspaceId })`: one
    /// synthetic event to the destination now. Never fails: a refusal is in
    /// the result.
    fn send_test<'a>(&'a self, test: AuditStreamTest<'a>) -> BoxFuture<'a, AuditStreamTestResult>;
}

// ── routes ──────────────────────────────────────────────────────────────────

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    let need = || gate.require([GENERAL_UPDATE.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need()))
        .route("/", post(create).route_layer(need()))
        .route("/{id}", patch(update).route_layer(need()))
        .route("/{id}", delete(remove).route_layer(need()))
        .route("/{id}/test", post(send_test).route_layer(need()))
}

/// The row as the API shows it (`toView`): no `tokenEncrypted`, a `hasToken`
/// flag in its place. Timestamps as `toISOString()` writes the `Date`
/// Drizzle reads them as (cut to the millisecond, `null` when unset).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamView {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    url: String,
    has_token: bool,
    settings: Option<Value>,
    status: String,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    cursor_created_at: Option<PrimitiveDateTime>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    last_delivered_at: Option<PrimitiveDateTime>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    last_attempt_at: Option<PrimitiveDateTime>,
    last_error: Option<String>,
    consecutive_failures: i32,
    delivered_count: i32,
    created_by_id: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    updated_at: PrimitiveDateTime,
}

/// The view's columns, in [`StreamView::from_row`]'s order. The token
/// column is never selected: `token_encrypted is not null` stands in for it.
fn view_columns() -> Vec<Expr> {
    use audit_log_streams::Column as S;
    vec![
        Expr::col(S::Id),
        Expr::col(S::Name),
        Expr::col(S::Type),
        Expr::col(S::Url),
        sea_orm::ExprTrait::is_not_null(Expr::col(S::TokenEncrypted)),
        Expr::col(S::Settings),
        Expr::col(S::Status),
        Expr::col(S::CursorCreatedAt),
        Expr::col(S::LastDeliveredAt),
        Expr::col(S::LastAttemptAt),
        Expr::col(S::LastError),
        Expr::col(S::ConsecutiveFailures),
        Expr::col(S::DeliveredCount),
        Expr::col(S::CreatedById),
        Expr::col(S::CreatedAt),
        Expr::col(S::UpdatedAt),
    ]
}

impl StreamView {
    /// A row of [`view_columns`] (selected or returned), read by position.
    fn from_row(row: &QueryResult) -> Result<Self, DbErr> {
        Ok(Self {
            id: row.try_get_by_index(0)?,
            name: row.try_get_by_index(1)?,
            kind: row.try_get_by_index(2)?,
            url: row.try_get_by_index(3)?,
            has_token: row.try_get_by_index(4)?,
            settings: row.try_get_by_index(5)?,
            status: row.try_get_by_index(6)?,
            cursor_created_at: row.try_get_by_index(7)?,
            last_delivered_at: row.try_get_by_index(8)?,
            last_attempt_at: row.try_get_by_index(9)?,
            last_error: row.try_get_by_index(10)?,
            consecutive_failures: row.try_get_by_index(11)?,
            delivered_count: row.try_get_by_index(12)?,
            created_by_id: row.try_get_by_index(13)?,
            created_at: row.try_get_by_index(14)?,
            updated_at: row.try_get_by_index(15)?,
        })
    }

    /// The view as JSON (`jsonb_build_object(…)` before).
    fn json(row: &QueryResult) -> Result<Value, DbErr> {
        serde_json::to_value(Self::from_row(row)?).map_err(|error| DbErr::Json(error.to_string()))
    }
}

/// `select <view> from audit_log_streams s …`.
fn view_select() -> SelectStatement {
    let mut select = Query::select();
    select
        .exprs(view_columns())
        .from(audit_log_streams::Entity);
    select
}

/// The streams, oldest first.
fn list_statement() -> SelectStatement {
    let mut select = view_select();
    select
        .order_by(audit_log_streams::Column::CreatedAt, Order::Asc)
        .order_by(audit_log_streams::Column::Id, Order::Asc);
    select
}

/// A new stream starts at "now": the cursor is the creation time, so nothing
/// older is sent.
fn insert_statement(
    id: &str,
    body: &CreateBody,
    url: &str,
    token: Option<String>,
    user_id: &str,
) -> Result<InsertStatement, DbErr> {
    use audit_log_streams::Column as S;
    let at = utc_now();
    let mut insert = Query::insert();
    insert
        .into_table(audit_log_streams::Entity)
        .columns([
            S::Id,
            S::Name,
            S::Type,
            S::Url,
            S::TokenEncrypted,
            S::Settings,
            S::Status,
            S::CursorCreatedAt,
            S::CreatedById,
            S::CreatedAt,
            S::UpdatedAt,
        ])
        .values([
            Expr::value(id.to_owned()),
            Expr::value(body.name.clone()),
            Expr::value(body.kind.clone()),
            Expr::value(url.to_owned()),
            Expr::value(token),
            Expr::value(body.settings.clone()),
            Expr::value("active"),
            Expr::value(at),
            Expr::value(user_id.to_owned()),
            Expr::value(at),
            Expr::value(at),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .returning(Query::returning().exprs(view_columns()));
    Ok(insert)
}

/// The fields a body named; resuming (`status` back to `active`) starts the
/// failure count and the last error over.
fn update_statement(
    id: &str,
    body: &UpdateBody,
    url: Option<String>,
    token: Option<String>,
) -> UpdateStatement {
    use audit_log_streams::Column as S;
    let mut update = Query::update();
    update
        .table(audit_log_streams::Entity)
        .value(S::UpdatedAt, Expr::value(utc_now()));
    if let Some(name) = &body.name {
        update.value(S::Name, Expr::value(name.clone()));
    }
    if let Some(kind) = &body.kind {
        update.value(S::Type, Expr::value(kind.clone()));
    }
    if let Some(url) = url {
        update.value(S::Url, Expr::value(url));
    }
    if !body.settings.is_absent() {
        update.value(S::Settings, Expr::value(body.settings.as_set().cloned()));
    }
    if !body.token.is_absent() {
        update.value(S::TokenEncrypted, Expr::value(token));
    }
    if let Some(status) = &body.status {
        update.value(S::Status, Expr::value(status.clone()));
    }
    if body.status.as_deref() == Some("active") {
        update
            .value(S::ConsecutiveFailures, Expr::value(0))
            .value(S::LastError, Expr::value(Option::<String>::None));
    }
    update
        .and_where(sea_orm::ExprTrait::eq(Expr::col(S::Id), id))
        .returning(Query::returning().exprs(view_columns()));
    update
}

fn not_found(id: &str) -> PlatformError {
    ApiError::not_found(RESOURCE, Some(id)).into()
}

/// `error.badRequest(c, safe.reason, { field: 'url' })`.
fn unsafe_url(reason: String) -> PlatformError {
    ApiError::bad_request(reason)
        .with_details(json!({ "field": "url" }))
        .into()
}

/// `keyringFromEnv(c.env)`: the field-encryption keys, the request's
/// (conformance) or the process's.
fn keyring(caller: &Caller) -> Keyring {
    Keyring {
        v1: caller.env_value("DATABASE_ENCRYPTION_KEY"),
        v2: caller.env_value("DATABASE_ENCRYPTION_KEY_V2"),
    }
}

/// `encryptField(token, keyring)`; without a key the worker throws.
fn seal(token: &str, caller: &Caller) -> PlatformResult<String> {
    encrypt_field(token, &keyring(caller))
        .map_err(|error| PlatformError::internal("Internal server error", error))
}

async fn view_of(caller: &Caller, id: &str) -> PlatformResult<Option<Value>> {
    let mut select = view_select();
    select
        .and_where(sea_orm::ExprTrait::eq(
            Expr::col(audit_log_streams::Column::Id),
            id,
        ))
        .limit(1);
    let row = orm(&caller.db).query_one(&select).await?;
    Ok(row.as_ref().map(StreamView::json).transpose()?)
}

/// The view a write returned (`fetch_one`: no row is an error).
fn written(row: Option<QueryResult>) -> PlatformResult<Value> {
    let row = row.ok_or_else(|| DbErr::RecordNotFound("audit_log_streams".to_owned()))?;
    Ok(StreamView::json(&row)?)
}

/// What an entity event carries about a stream, on create, update and
/// delete alike (`toEventData`): which stream, and nothing a member may not
/// read. The audit log stores event data and `GET /api/audit-logs` shows it
/// to everyone with `general:read`, while these routes need
/// `general:update`: no `url` (it can carry a secret), no `settings`, no
/// `lastError` (it can quote what the destination answered), no cursor and
/// no counters.
fn event_data(view: &Value) -> Value {
    json!({
        "id": view["id"],
        "name": view["name"],
        "type": view["type"],
        "status": view["status"],
        "hasToken": view["hasToken"],
    })
}

// ── bodies ──────────────────────────────────────────────────────────────────

/// An HTTP header name: letters, digits and hyphens (`headerName`).
fn is_header_name(text: &str) -> bool {
    (1..=100).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `auditLogStreamSettingsSchema`: the settings as Zod parses them, the keys
/// it knows only, their strings trimmed.
fn read_settings(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut settings = Map::new();
    let label = Text::trimmed(Some(1), Some(255));
    for key in ["index", "source", "sourcetype", "host"] {
        if let Field::Set(value) = issues.text_with(fields, key, Presence::Optional, label) {
            settings.insert(key.to_owned(), Value::String(value));
        }
    }
    let trimmed = Text {
        trim: true,
        ..Text::default()
    };
    if let Field::Set(header) = issues.pattern_with(
        fields,
        "authHeader",
        Presence::Optional,
        trimmed,
        is_header_name,
        "Not a valid header name",
    ) {
        settings.insert("authHeader".to_owned(), Value::String(header));
    }
    if let Field::Set(format) = issues.choice(fields, "format", Presence::Optional, &STREAM_FORMATS)
    {
        settings.insert("format".to_owned(), Value::String(format));
    }
    Value::Object(settings)
}

/// `createAuditLogStreamSchema`.
struct CreateBody {
    name: String,
    kind: String,
    url: String,
    /// `body.token`, when it is a string.
    token: Option<String>,
    /// `body.settings ?? null`.
    settings: Option<Value>,
}

fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> CreateBody {
    let name = issues.text_with(
        body,
        "name",
        Presence::Required,
        Text::trimmed(Some(1), Some(255)),
    );
    let kind = issues.choice(body, "type", Presence::Required, &STREAM_TYPES);
    let url = issues.text_with(
        body,
        "url",
        Presence::Required,
        Text::trimmed(Some(1), Some(2048)),
    );
    let token = issues.text(body, "token", Presence::Nullish, Some(1), Some(2048));
    let settings = issues.nested(body, "settings", Presence::Nullish, read_settings);
    CreateBody {
        name: name.into_option().unwrap_or_default(),
        kind: kind.into_option().unwrap_or_default(),
        url: url.into_option().unwrap_or_default(),
        token: token.into_option(),
        settings: settings.into_option(),
    }
}

/// `updateAuditLogStreamSchema`: what the body names, and what it clears.
struct UpdateBody {
    name: Option<String>,
    kind: Option<String>,
    url: Option<String>,
    /// Omitted: keep the stored token. `null`: remove it. A string: replace
    /// it.
    token: Field<String>,
    /// Replaces the settings; `null` clears them.
    settings: Field<Value>,
    status: Option<String>,
}

fn read_update(issues: &mut Issues, body: &Map<String, Value>) -> UpdateBody {
    let name = issues.text_with(
        body,
        "name",
        Presence::Optional,
        Text::trimmed(Some(1), Some(255)),
    );
    let kind = issues.choice(body, "type", Presence::Optional, &STREAM_TYPES);
    let url = issues.text_with(
        body,
        "url",
        Presence::Optional,
        Text::trimmed(Some(1), Some(2048)),
    );
    let token = issues.text(body, "token", Presence::Nullish, Some(1), Some(2048));
    let settings = issues.nested(body, "settings", Presence::Nullish, read_settings);
    let status = issues.choice(body, "status", Presence::Optional, &SETTABLE_STATUSES);
    UpdateBody {
        name: name.into_option(),
        kind: kind.into_option(),
        url: url.into_option(),
        token,
        settings,
        status: status.into_option(),
    }
}

// ── handlers ────────────────────────────────────────────────────────────────

/// `GET /`: the workspace's streams, oldest first. Not paged.
async fn list(caller: Caller) -> Response {
    answer(
        async {
            let rows = orm(&caller.db).query_all(&list_statement()).await?;
            let rows = rows
                .iter()
                .map(StreamView::json)
                .collect::<Result<Vec<_>, _>>()?;
            let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
            Ok(List::new(rows, Pagination::new(total, false, None)).into_response())
        }
        .await,
    )
}

/// `POST /`.
async fn create(
    State(state): State<CorePlatformState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let body = validate(&headers, &body, read_create)?;
            let url = state
                .audit_streams
                .check_url(&body.url)
                .map_err(unsafe_url)?;

            let db = orm(&caller.db);
            let count = audit_log_streams::Entity::find().count(&db).await?;
            if i64::try_from(count).unwrap_or(i64::MAX) >= MAX_AUDIT_LOG_STREAMS {
                return Err(ApiError::conflict(format!(
                    "A workspace can have at most {MAX_AUDIT_LOG_STREAMS} audit log streams"
                ))
                .with_details(json!({ "limit": MAX_AUDIT_LOG_STREAMS }))
                .into());
            }

            // `body.token ? await encryptField(...) : null`.
            let token = match body.token.as_deref().filter(|token| !token.is_empty()) {
                Some(token) => Some(seal(token, &caller)?),
                None => None,
            };
            let id = generate_id("als");
            let insert = insert_statement(&id, &body, &url, token, &caller.user_id)?;
            let view = written(db.query_one(&insert).await?)?;
            caller.publish(&state, AUDIT_LOG_STREAM_CREATED, &id, &event_data(&view));
            Ok(Created(view).into_response())
        }
        .await,
    )
}

/// `PATCH /:id`.
async fn update(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let body = validate(&headers, &body, read_update)?;
            if view_of(&caller, &id).await?.is_none() {
                return Err(not_found(&id));
            }
            let url = match body.url.as_deref() {
                Some(raw) => Some(state.audit_streams.check_url(raw).map_err(unsafe_url)?),
                None => None,
            };
            let token = match &body.token {
                Field::Set(token) => Some(seal(token, &caller)?),
                Field::Absent | Field::Null => None,
            };
            // Resuming clears the failure count and the last error.
            let update = update_statement(&id, &body, url, token);
            let view = written(orm(&caller.db).query_one(&update).await?)?;
            caller.publish(&state, AUDIT_LOG_STREAM_UPDATED, &id, &event_data(&view));
            Ok(Data(view).into_response())
        }
        .await,
    )
}

/// `DELETE /:id`.
async fn remove(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let Some(existing) = view_of(&caller, &id).await? else {
                return Err(not_found(&id));
            };
            audit_log_streams::Entity::delete_by_id(id.clone())
                .exec(&orm(&caller.db))
                .await?;
            caller.publish(
                &state,
                AUDIT_LOG_STREAM_DELETED,
                &id,
                &event_data(&existing),
            );
            Ok(NoContent.into_response())
        }
        .await,
    )
}

/// `POST /:id/test`: send one synthetic event to the destination now. The
/// answer is the destination's, not ours: a refusal is `200 { ok: false,
/// status, error }`. Touches no cursor and no counter.
async fn send_test(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            use audit_log_streams::Column as S;
            // `settings::text`: the JSON as Postgres writes it.
            let settings = sea_orm::ExprTrait::cast_as(Expr::col(S::Settings), "text");
            let row: Option<(String, String, Option<String>, Option<String>)> =
                audit_log_streams::Entity::find_by_id(id.clone())
                    .select_only()
                    .columns([S::Type, S::Url])
                    .expr_as(settings, "settings")
                    .column(S::TokenEncrypted)
                    .into_tuple()
                    .one(&orm(&caller.db))
                    .await?;
            let Some((kind, url, settings, token_encrypted)) = row else {
                return Err(not_found(&id));
            };
            let keyring = keyring(&caller);
            let result = state
                .audit_streams
                .send_test(AuditStreamTest {
                    kind: &kind,
                    url: &url,
                    settings: settings.as_deref(),
                    token_encrypted: token_encrypted.as_deref(),
                    keyring: &keyring,
                    workspace_id: &caller.workspace_id,
                    http: caller.outbound(),
                })
                .await;
            Ok(Data(json!({
                "ok": result.ok,
                "status": result.status,
                "error": result.error,
                "durationMs": result.duration_ms,
            }))
            .into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issues_of<T>(
        body: &Value,
        read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
    ) -> Vec<Value> {
        let mut issues = Issues::default();
        let Some(fields) = body.as_object() else {
            panic!("an object");
        };
        read(&mut issues, fields);
        issues
            .finish()
            .err()
            .map(|invalid| invalid.issues().to_vec())
            .unwrap_or_default()
    }

    fn valid() -> Value {
        json!({
            "name": "Splunk prod",
            "type": "splunk_hec",
            "url": "https://splunk.example.com:8088/services/collector/event",
            "token": "hec-token-very-secret",
        })
    }

    fn with(mut body: Value, key: &str, value: Value) -> Value {
        body[key] = value;
        body
    }

    #[test]
    fn a_create_body_reads_like_the_schema() {
        let body = with(
            valid(),
            "settings",
            json!({ "index": " sec ", "source": "weld", "unknown": 1, "format": "ndjson" }),
        );
        let mut issues = Issues::default();
        let Some(fields) = body.as_object() else {
            panic!("an object");
        };
        let read = read_create(&mut issues, fields);
        assert!(issues.finish().is_ok());
        assert_eq!(read.name, "Splunk prod");
        assert_eq!(read.kind, "splunk_hec");
        assert_eq!(read.token.as_deref(), Some("hec-token-very-secret"));
        // Unknown keys are stripped, strings trimmed.
        assert_eq!(
            read.settings,
            Some(json!({ "index": "sec", "source": "weld", "format": "ndjson" }))
        );

        let open = json!({ "name": " Open ", "type": "http", "url": " https://c.example.com/in ", "token": null, "settings": null });
        let mut issues = Issues::default();
        let Some(fields) = open.as_object() else {
            panic!("an object");
        };
        let read = read_create(&mut issues, fields);
        assert!(issues.finish().is_ok());
        assert_eq!(
            (read.name.as_str(), read.url.as_str()),
            ("Open", "https://c.example.com/in")
        );
        assert_eq!((read.token, read.settings), (None, None));
    }

    #[test]
    fn create_issues_are_zods() {
        assert_eq!(
            issues_of(&json!({}), read_create),
            [
                json!({ "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["name"], "message": "Required" }),
                json!({ "code": "invalid_type", "expected": "'splunk_hec' | 'http'", "received": "undefined", "path": ["type"], "message": "Required" }),
                json!({ "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["url"], "message": "Required" }),
            ]
        );
        assert_eq!(
            issues_of(&with(valid(), "name", json!("  ")), read_create),
            [json!({
                "code": "too_small", "minimum": 1, "type": "string", "inclusive": true, "exact": false,
                "message": "String must contain at least 1 character(s)", "path": ["name"],
            })]
        );
        assert_eq!(
            issues_of(&with(valid(), "type", json!("syslog")), read_create),
            [json!({
                "received": "syslog", "code": "invalid_enum_value", "options": ["splunk_hec", "http"], "path": ["type"],
                "message": "Invalid enum value. Expected 'splunk_hec' | 'http', received 'syslog'",
            })]
        );
        assert_eq!(
            issues_of(
                &with(valid(), "settings", json!({ "format": "xml" })),
                read_create
            ),
            [json!({
                "received": "xml", "code": "invalid_enum_value", "options": ["json", "ndjson"], "path": ["settings", "format"],
                "message": "Invalid enum value. Expected 'json' | 'ndjson', received 'xml'",
            })]
        );
        assert_eq!(
            issues_of(
                &with(valid(), "settings", json!({ "authHeader": "bad header" })),
                read_create
            ),
            [json!({
                "validation": "regex", "code": "invalid_string", "message": "Not a valid header name",
                "path": ["settings", "authHeader"],
            })]
        );
        // The pattern sees the trimmed value.
        assert_eq!(
            issues_of(
                &with(valid(), "settings", json!({ "authHeader": " X-Api-Key " })),
                read_create
            ),
            Vec::<Value>::new()
        );
    }

    #[test]
    fn an_update_body_tells_omitted_from_null() {
        let body = json!({ "token": null, "settings": { "host": "h1" }, "status": "paused" });
        let mut issues = Issues::default();
        let Some(fields) = body.as_object() else {
            panic!("an object");
        };
        let read = read_update(&mut issues, fields);
        assert!(issues.finish().is_ok());
        assert_eq!(read.token, Field::Null);
        assert_eq!(read.settings, Field::Set(json!({ "host": "h1" })));
        assert_eq!(read.status.as_deref(), Some("paused"));
        assert_eq!((read.name, read.kind, read.url), (None, None, None));

        let empty = json!({});
        let mut issues = Issues::default();
        let Some(fields) = empty.as_object() else {
            panic!("an object");
        };
        let read = read_update(&mut issues, fields);
        assert!(issues.finish().is_ok());
        assert!(read.token.is_absent() && read.settings.is_absent());

        // `disabled` is the platform's to set.
        assert_eq!(
            issues_of(&json!({ "status": "disabled" }), read_update),
            [json!({
                "received": "disabled", "code": "invalid_enum_value", "options": ["active", "paused"], "path": ["status"],
                "message": "Invalid enum value. Expected 'active' | 'paused', received 'disabled'",
            })]
        );
    }

    #[test]
    fn the_token_column_is_never_selected_into_a_view() {
        use sea_orm::sea_query::PostgresQueryBuilder;
        let create = CreateBody {
            name: "n".to_owned(),
            kind: "http".to_owned(),
            url: "https://example.com".to_owned(),
            token: None,
            settings: None,
        };
        let insert = insert_statement("als_1", &create, "https://example.com", None, "user_1")
            .expect("an insert");
        let update = update_statement(
            "als_1",
            &UpdateBody {
                name: None,
                kind: None,
                url: None,
                token: Field::Set("t".to_owned()),
                settings: Field::Absent,
                status: None,
            },
            None,
            Some("sealed".to_owned()),
        );
        for statement in [
            list_statement().to_string(PostgresQueryBuilder),
            insert.to_string(PostgresQueryBuilder),
            update.to_string(PostgresQueryBuilder),
        ] {
            let view = statement
                .rsplit_once("RETURNING ")
                .map_or(statement.as_str(), |(_, view)| view);
            assert!(view.contains(r#""token_encrypted" IS NOT NULL"#), "{statement}");
            assert_eq!(view.matches("token_encrypted").count(), 1, "{statement}");
        }
        assert!(
            list_statement()
                .to_string(PostgresQueryBuilder)
                .ends_with(r#"ORDER BY "created_at" ASC, "id" ASC"#)
        );
    }

    #[test]
    fn an_event_names_the_stream_and_nothing_a_member_may_not_read() {
        let view = json!({
            "id": "als_1",
            "name": "Splunk prod",
            "type": "splunk_hec",
            "url": "https://splunk.example.com:8088/services/collector/event?key=in-the-url",
            "hasToken": true,
            "settings": { "index": "secret-index" },
            "status": "paused",
            "cursorCreatedAt": "2026-11-01T10:00:00.000Z",
            "lastDeliveredAt": null,
            "lastAttemptAt": "2026-11-01T10:05:00.000Z",
            "lastError": "HTTP 403: collector-said-no",
            "consecutiveFailures": 3,
            "deliveredCount": 12,
            "createdById": "user_1",
            "createdAt": "2026-11-01T09:00:00.000Z",
            "updatedAt": "2026-11-01T10:05:00.000Z",
        });
        let data = event_data(&view);
        assert_eq!(
            data,
            json!({
                "id": "als_1", "name": "Splunk prod", "type": "splunk_hec",
                "status": "paused", "hasToken": true,
            })
        );
        let text = data.to_string();
        for hidden in [
            "url",
            "https://",
            "in-the-url",
            "settings",
            "secret-index",
            "lastError",
            "collector-said-no",
            "cursor",
            "deliveredCount",
            "consecutiveFailures",
        ] {
            assert!(!text.contains(hidden), "{hidden}");
        }
    }
}
