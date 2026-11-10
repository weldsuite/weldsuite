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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    AUDIT_LOG_STREAM_CREATED, AUDIT_LOG_STREAM_DELETED, AUDIT_LOG_STREAM_UPDATED,
};
use weldsuite_catalogs::permission_keys::GENERAL_UPDATE;
use weldsuite_db::{Keyring, encrypt_field};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{BoxFuture, OutboundHttp};

use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, now, validate};

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

/// A timestamp column as `toISOString()` writes the `Date` Drizzle reads it
/// as: cut to the millisecond, `null` when unset.
macro_rules! iso {
    ($column:literal) => {
        concat!(
            "to_char(date_trunc('milliseconds', ",
            $column,
            "), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

/// The row as the API shows it (`toView`): no `tokenEncrypted`, a `hasToken`
/// flag in its place. The token column is never selected.
macro_rules! view {
    () => {
        concat!(
            "jsonb_build_object('id', s.id, 'name', s.name, 'type', s.type, 'url', s.url, \
             'hasToken', s.token_encrypted is not null, 'settings', s.settings, \
             'status', s.status, 'cursorCreatedAt', ",
            iso!("s.cursor_created_at"),
            ", 'lastDeliveredAt', ",
            iso!("s.last_delivered_at"),
            ", 'lastAttemptAt', ",
            iso!("s.last_attempt_at"),
            ", 'lastError', s.last_error, 'consecutiveFailures', s.consecutive_failures, \
             'deliveredCount', s.delivered_count, 'createdById', s.created_by_id, 'createdAt', ",
            iso!("s.created_at"),
            ", 'updatedAt', ",
            iso!("s.updated_at"),
            ")"
        )
    };
}

const LIST: &str = concat!(
    "select ",
    view!(),
    " from audit_log_streams s order by s.created_at asc, s.id asc"
);

const SELECT: &str = concat!(
    "select ",
    view!(),
    " from audit_log_streams s where s.id = $1 limit 1"
);

/// A new stream starts at "now": the cursor is the creation time, so nothing
/// older is sent.
const INSERT: &str = concat!(
    "insert into audit_log_streams as s \
       (id, name, type, url, token_encrypted, settings, status, cursor_created_at, \
        created_by_id, created_at, updated_at) \
     values ($1, $2, $3, $4, $5, $6::jsonb, 'active', $7::timestamp, $8, $7::timestamp, \
             $7::timestamp) \
     returning ",
    view!()
);

/// The fields a body named, each behind its own flag; `$15` is "resumed":
/// the failure count and the last error start over.
const UPDATE: &str = concat!(
    "update audit_log_streams as s set \
       updated_at = $2::timestamp, \
       name = case when $3 then $4 else s.name end, \
       type = case when $5 then $6 else s.type end, \
       url = case when $7 then $8 else s.url end, \
       settings = case when $9 then $10::jsonb else s.settings end, \
       token_encrypted = case when $11 then $12 else s.token_encrypted end, \
       status = case when $13 then $14 else s.status end, \
       consecutive_failures = case when $15 then 0 else s.consecutive_failures end, \
       last_error = case when $15 then null else s.last_error end \
     where s.id = $1 returning ",
    view!()
);

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
    Ok(sqlx::query_scalar(SELECT)
        .bind(id)
        .fetch_optional(&caller.db)
        .await?)
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
            let rows: Vec<Value> = sqlx::query_scalar(LIST).fetch_all(&caller.db).await?;
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

            let count: i64 = sqlx::query_scalar("select count(*) from audit_log_streams")
                .fetch_one(&caller.db)
                .await?;
            if count >= MAX_AUDIT_LOG_STREAMS {
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
            let view: Value = sqlx::query_scalar(INSERT)
                .bind(&id)
                .bind(&body.name)
                .bind(&body.kind)
                .bind(&url)
                .bind(token)
                .bind(body.settings.as_ref().map(Value::to_string))
                .bind(now())
                .bind(&caller.user_id)
                .fetch_one(&caller.db)
                .await?;
            caller.publish(&state, AUDIT_LOG_STREAM_CREATED, &id, &view);
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
            let resumed = body.status.as_deref() == Some("active");
            let view: Value = sqlx::query_scalar(UPDATE)
                .bind(&id)
                .bind(now())
                .bind(body.name.is_some())
                .bind(body.name.as_deref())
                .bind(body.kind.is_some())
                .bind(body.kind.as_deref())
                .bind(url.is_some())
                .bind(url.as_deref())
                .bind(!body.settings.is_absent())
                .bind(body.settings.as_set().map(Value::to_string))
                .bind(!body.token.is_absent())
                .bind(token)
                .bind(body.status.is_some())
                .bind(body.status.as_deref())
                .bind(resumed)
                .fetch_one(&caller.db)
                .await?;
            caller.publish(&state, AUDIT_LOG_STREAM_UPDATED, &id, &view);
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
            sqlx::query("delete from audit_log_streams where id = $1")
                .bind(&id)
                .execute(&caller.db)
                .await?;
            caller.publish(&state, AUDIT_LOG_STREAM_DELETED, &id, &existing);
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
            let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
                "select s.type, s.url, s.settings::text, s.token_encrypted \
                 from audit_log_streams s where s.id = $1 limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
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
        for statement in [LIST, SELECT, INSERT, UPDATE] {
            let view = statement
                .split("jsonb_build_object(")
                .nth(1)
                .unwrap_or_default();
            assert!(view.contains("'hasToken', s.token_encrypted is not null"));
            assert_eq!(view.matches("token_encrypted").count(), 1, "{statement}");
        }
        assert!(LIST.ends_with("order by s.created_at asc, s.id asc"));
    }
}
