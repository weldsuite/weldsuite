//! `/api/integrations` (`routes/integrations/index.ts`,
//! `services/integrations/connections.ts`): integration connections
//! (`integration_connections`), backing the original object CRUD and the
//! connections surface: MCP servers (create, tool discovery, connectivity
//! test), the Attio / HubSpot / Google Calendar OAuth connect flows,
//! disconnect, manual sync (the `CRM_SYNC` Workflow, hosted by
//! integration-webhook-worker on Global, which the Kubernetes editions do not
//! run yet: the route then answers as Global does without the binding),
//! Google Calendar watch renewal, sync logs, field mappings, conflicts and
//! entity mappings. The internal (`X-Internal-Secret`) routes are
//! [`internal`]. Global keeps the CRM sync schedule in a D1 index
//! (`CONNECTOR_SYNC_INDEX`); nothing reads one here, so these routes write
//! none.

pub(crate) mod internal;
pub(crate) mod oauth;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, HttpRequest, OutboundHttp};

use self::oauth::{Provider, Tokens, hubspot_portal_id, webhook_worker_url};
use crate::js::{next_cursor, page, page_limit, query_truthy, total, truthy};
use crate::runs::ProjectSyncRuns;
use crate::{Caller, ConnectState, Refusal, internal as internal_error, now, validate};

/// The `CRM_SYNC` Workflow binding (`CrmSyncWorkflow`, hosted by
/// integration-webhook-worker on Global): `create({ id, params })`, the
/// same shape as `GITHUB_PROJECT_SYNC`. A request's own binding
/// (conformance): the test's, or none.
#[derive(Clone)]
pub struct RequestCrmSyncRuns(pub Option<Arc<dyn ProjectSyncRuns>>);

const STATE_TTL: Duration = Duration::from_secs(300);
const MAPPING_TTL: Duration = Duration::from_secs(86_400 * 365);
const STALE_SYNC_MINUTES: i64 = 15;
const DIRECTIONS: &[&str] = &["inbound", "outbound", "bidirectional"];
const TRANSPORTS: &[&str] = &["streamable-http", "sse", "stdio"];
const AUTH_TYPES: &[&str] = &["none", "bearer", "api_key", "header"];

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::INTEGRATIONS_READ]);
    let create = || gate.require([perm::INTEGRATIONS_CREATE]);
    let update = || gate.require([perm::INTEGRATIONS_UPDATE]);
    let delete_gate = || gate.require([perm::INTEGRATIONS_DELETE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create_integration).route_layer(create()))
        .route("/connections", get(list_connections).route_layer(read()))
        .route(
            "/connections",
            post(create_connection).route_layer(create()),
        )
        .route(
            "/connections/attio/authorize",
            post(attio_authorize).route_layer(create()),
        )
        .route(
            "/connections/attio/callback",
            post(attio_callback).route_layer(create()),
        )
        .route(
            "/connections/{provider}/authorize",
            post(generic_authorize).route_layer(create()),
        )
        .route(
            "/connections/{provider}/callback",
            post(generic_callback).route_layer(create()),
        )
        .route("/connections/{id}", get(get_connection).route_layer(read()))
        .route(
            "/connections/{id}",
            patch(update_connection).route_layer(update()),
        )
        .route(
            "/connections/{id}",
            delete(disconnect).route_layer(delete_gate()),
        )
        .route(
            "/connections/{id}/discover-tools",
            post(discover_tools).route_layer(update()),
        )
        .route(
            "/connections/{id}/test",
            post(test_connection).route_layer(update()),
        )
        .route("/connections/{id}/sync", post(sync).route_layer(update()))
        .route(
            "/connections/{id}/renew-watch",
            post(renew_watch).route_layer(update()),
        )
        .route("/connections/{id}/logs", get(logs).route_layer(read()))
        .route(
            "/connections/{id}/field-mappings",
            get(field_mappings).route_layer(read()),
        )
        .route(
            "/connections/{id}/field-mappings",
            put(replace_field_mappings).route_layer(update()),
        )
        .route(
            "/connections/{id}/field-mappings/defaults",
            get(default_field_mappings).route_layer(read()),
        )
        .route(
            "/connections/{id}/conflicts",
            get(conflicts).route_layer(read()),
        )
        .route(
            "/connections/{id}/conflicts/resolve-all",
            post(resolve_all).route_layer(update()),
        )
        .route(
            "/connections/{id}/conflicts/{conflict_id}/resolve",
            post(resolve_conflict).route_layer(update()),
        )
        .route("/entity-mappings", get(entity_mappings).route_layer(read()))
        .route("/{id}", get(get_integration).route_layer(read()))
        .route("/{id}", patch(update_integration).route_layer(update()))
        .route(
            "/{id}",
            delete(delete_integration).route_layer(delete_gate()),
        )
}

// ── Shared pieces ───────────────────────────────────────────────────────────

/// A JSON number as JavaScript writes it: integral values as integers.
#[allow(clippy::cast_possible_truncation)]
fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `crypto.randomUUID()`.
pub(crate) fn uuid() -> String {
    let hex = weldsuite_kit::random_string(32, "0123456789abcdef");
    let variant = ["8", "9", "a", "b"][usize::from(hex.as_bytes()[16]) % 4];
    format!(
        "{}-{}-4{}-{}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        variant,
        &hex[17..20],
        &hex[20..32]
    )
}

fn db_error(error: impl std::fmt::Display) -> Refusal {
    Refusal::Database(sqlx::Error::Protocol(error.to_string()))
}

/// The connection row (`to_jsonb`, snake_case), not deleted.
pub(crate) async fn connection_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select to_jsonb(t) from integration_connections t
         where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

/// `{ ...connection, oauthTokens: undefined, webhookSecret: undefined }`.
fn sanitized(row: Value) -> Value {
    let mut row = js_row(row);
    if let Value::Object(map) = &mut row {
        map.remove("oauthTokens");
        map.remove("webhookSecret");
    }
    row
}

/// `{ ...(current || {}), ...patch }`.
fn merged(current: Option<&Value>, patch: &Map<String, Value>) -> Value {
    let mut out = match current {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    for (key, value) in patch {
        out.insert(key.clone(), value.clone());
    }
    Value::Object(out)
}

fn text_of(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

impl Caller {
    /// `env[name]`, empty counting as unset.
    fn env_value(&self, state: &ConnectState, name: &str) -> Option<String> {
        self.overrides.env(state, name).filter(|v| !v.is_empty())
    }

    fn workspace_cache(&self, state: &ConnectState) -> Result<Arc<dyn DynCache>, Refusal> {
        self.overrides
            .kv(state)
            .ok_or_else(|| db_error("WORKSPACE_CACHE is not bound"))
    }
}

/// `providerCredentials(env, provider)`: `<PROVIDER>_CLIENT_ID` and `_SECRET`.
fn provider_credentials(
    caller: &Caller,
    state: &ConnectState,
    provider: &str,
) -> (Option<String>, Option<String>) {
    let upper = provider.to_uppercase();
    (
        caller
            .overrides
            .env(state, &format!("{upper}_CLIENT_ID"))
            .filter(|v| !v.is_empty()),
        caller
            .overrides
            .env(state, &format!("{upper}_CLIENT_SECRET"))
            .filter(|v| !v.is_empty()),
    )
}

/// `triggerCrmSync(env, payload)`: start the `CRM_SYNC` Workflow, or skip it
/// without the binding.
pub(crate) async fn trigger_crm_sync(
    runs: Option<&Arc<dyn ProjectSyncRuns>>,
    connection_id: &str,
    workspace_id: &str,
    provider: &str,
    sync_type: &str,
) -> Result<(), String> {
    let Some(runs) = runs else {
        tracing::warn!(
            "[Integrations] CRM_SYNC workflow binding not available; skipping sync dispatch"
        );
        return Ok(());
    };
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let id = format!("{connection_id}-{millis}");
    let params = json!({
        "connectionId": connection_id,
        "workspaceId": workspace_id,
        "provider": provider,
        "syncType": sync_type,
    });
    runs.create(&id, &params).await
}

/// `ConnectionActionResult` off the happy path.
pub(crate) enum ActionError {
    NotFound,
    Conflict(String),
    /// `no_token` / `internal`: the message.
    Other(String),
    /// Thrown: the route's catch answers its own 500.
    Thrown(String),
}

impl From<sqlx::Error> for ActionError {
    fn from(error: sqlx::Error) -> Self {
        Self::Thrown(error.to_string())
    }
}

/// `triggerConnectionSync`: the stale-lock-aware guard, `syncing`, then the
/// `CRM_SYNC` Workflow.
pub(crate) async fn trigger_connection_sync(
    db: &PgPool,
    runs: Option<&Arc<dyn ProjectSyncRuns>>,
    clerk_org_id: &str,
    connection_id: &str,
    sync_type: &str,
) -> Result<&'static str, ActionError> {
    let stamp = now();
    let found: Option<(Value, bool)> = sqlx::query_as(
        "select to_jsonb(t), coalesce($2::timestamp - coalesce(t.updated_at, t.created_at)
                < make_interval(mins => $3::int), false)
         from integration_connections t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(connection_id)
    .bind(&stamp)
    .bind(i32::try_from(STALE_SYNC_MINUTES).unwrap_or(15))
    .fetch_optional(db)
    .await?;
    let Some((connection, fresh)) = found else {
        return Err(ActionError::NotFound);
    };
    if connection["status"].as_str() == Some("syncing") {
        if fresh {
            return Err(ActionError::Conflict(
                "A sync is already in progress".to_owned(),
            ));
        }
        tracing::warn!(
            connection_id,
            "[Integrations] connection stuck in 'syncing'; treating as stale and re-running"
        );
    }
    if !connection["oauth_tokens"]
        .get("accessToken")
        .is_some_and(truthy)
    {
        return Err(ActionError::Other("No access token available".to_owned()));
    }
    sqlx::query(
        "update integration_connections set status = 'syncing', updated_at = $2::timestamp where id = $1",
    )
    .bind(connection_id)
    .bind(now())
    .execute(db)
    .await?;
    trigger_crm_sync(
        runs,
        connection_id,
        clerk_org_id,
        connection["provider"].as_str().unwrap_or_default(),
        sync_type,
    )
    .await
    .map_err(ActionError::Thrown)?;
    Ok("Sync started")
}

/// What Google Calendar's watch renewal needs besides the database.
pub(crate) struct WatchRenewal<'a> {
    pub(crate) http: &'a OutboundHttp,
    pub(crate) client_id: Option<String>,
    pub(crate) client_secret: Option<String>,
    pub(crate) environment: Option<String>,
}

/// `renewGoogleCalendarWatch`: refresh the token when possible, stop the old
/// channel, register a new one and keep its id and secret.
pub(crate) async fn renew_google_calendar_watch(
    db: &PgPool,
    renewal: WatchRenewal<'_>,
    connection_id: &str,
) -> Result<&'static str, ActionError> {
    let connection: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from integration_connections t
         where t.id = $1 and t.provider = 'google_calendar' and t.deleted_at is null limit 1",
    )
    .bind(connection_id)
    .fetch_optional(db)
    .await?;
    let Some(connection) = connection else {
        return Err(ActionError::NotFound);
    };
    let tokens = &connection["oauth_tokens"];
    let Some(mut access_token) = tokens
        .get("accessToken")
        .filter(|t| truthy(t))
        .map(|t| crate::js::js_string(Some(t)))
    else {
        return Err(ActionError::Other("No access token".to_owned()));
    };
    let adapter = Provider::GoogleCalendar;
    if let (Some(refresh_token), Some(client_id), Some(client_secret)) = (
        tokens.get("refreshToken").filter(|t| truthy(t)),
        &renewal.client_id,
        &renewal.client_secret,
    ) {
        let refresh_token = crate::js::js_string(Some(refresh_token));
        if let Ok(fresh) = adapter
            .refresh(renewal.http, client_id, client_secret, &refresh_token)
            .await
        {
            access_token = fresh.bearer().to_owned();
            sqlx::query(
                "update integration_connections set oauth_tokens = $2::jsonb, updated_at = $3::timestamp where id = $1",
            )
            .bind(connection_id)
            .bind(fresh.to_json())
            .bind(now())
            .execute(db)
            .await?;
        }
    }
    if let Some(webhook_id) = connection["webhook_id"].as_str().filter(|w| !w.is_empty())
        && let Err(error) = adapter
            .delete_webhooks(
                renewal.http,
                &access_token,
                webhook_id,
                connection["webhook_secret"]
                    .as_str()
                    .filter(|s| !s.is_empty()),
            )
            .await
    {
        tracing::warn!(%error, "[Integrations] Failed to stop old watch channel");
    }
    let target = format!(
        "{}/webhook/gcal/{connection_id}",
        webhook_worker_url(renewal.environment.as_deref())
    );
    let registration = adapter
        .register_webhooks(renewal.http, &access_token, &target)
        .await
        .map_err(ActionError::Thrown)?;
    sqlx::query(
        "update integration_connections set webhook_id = $2, webhook_secret = $3, updated_at = $4::timestamp where id = $1",
    )
    .bind(connection_id)
    .bind(&registration.webhook_id)
    .bind(&registration.secret)
    .bind(now())
    .execute(db)
    .await?;
    Ok("Watch channel renewed")
}

/// A sync or renewal's answer, as both routers map it.
pub(crate) fn action_response(
    result: Result<&'static str, ActionError>,
    id: &str,
    sync: bool,
    failed: &str,
) -> Response {
    match result {
        Ok(message) => Data(json!({ "message": message })).into_response(),
        Err(ActionError::NotFound) => ApiError::not_found("Connection", Some(id)).into_response(),
        Err(ActionError::Conflict(message)) if sync => ApiError::conflict(message).into_response(),
        Err(ActionError::Conflict(message) | ActionError::Other(message)) => {
            if sync {
                ApiError::bad_request(message).into_response()
            } else {
                ApiError::internal().with_message(message).into_response()
            }
        }
        Err(ActionError::Thrown(error)) => internal_error(&error, failed),
    }
}

// ── Object CRUD ─────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let provider = query_truthy(query, "provider");
    let status = query_truthy(query, "status");
    let cursor = query_truthy(query, "cursor");
    // The cursor row is read before the try, as TypeScript does.
    let cursor_row: Option<(Option<String>, String)> = match &cursor {
        Some(cursor) => match sqlx::query_as(
            "select to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.US'), id
             from integration_connections where id = $1 limit 1",
        )
        .bind(cursor)
        .fetch_optional(&caller.db)
        .await
        {
            Ok(row) => row,
            Err(error) => return internal_error(&error, "Failed to list integrations"),
        },
        None => None,
    };
    let (cursor_at, cursor_id) = match cursor_row {
        Some((Some(at), id)) => (Some(at), Some(id)),
        _ => (None, None),
    };
    const FILTER: &str = "t.deleted_at is null and ($1::text is null or t.provider = $1)
        and ($2::text is null or t.status = $2)";
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from integration_connections t where {FILTER}
           and ($3::timestamp is null or t.created_at < $3::timestamp
                or (t.created_at = $3::timestamp and t.id < $4))
         order by t.created_at desc, t.id desc limit $5"
    )))
    .bind(&provider)
    .bind(&status)
    .bind(&cursor_at)
    .bind(&cursor_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from integration_connections t where {FILTER}"
    )))
    .bind(&provider)
    .bind(&status)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(js_row).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal_error(&error, "Failed to list integrations"),
    }
}

async fn get_integration(caller: Caller, Path(id): Path<String>) -> Response {
    match connection_row(&caller.db, &id).await {
        Ok(Some(row)) => Data(js_row(row)).into_response(),
        Ok(None) => ApiError::not_found("Integration", Some(&id)).into_response(),
        Err(error) => internal_error(&error, "Failed to fetch integration"),
    }
}

/// `integration_connections`' columns, camelCase → snake_case: the keys a
/// passthrough body can set (Drizzle ignores the rest).
const COLUMNS: &[(&str, &str)] = &[
    ("id", "id"),
    ("createdAt", "created_at"),
    ("updatedAt", "updated_at"),
    ("deletedAt", "deleted_at"),
    ("provider", "provider"),
    ("name", "name"),
    ("status", "status"),
    ("direction", "direction"),
    ("externalAccountId", "external_account_id"),
    ("oauthTokens", "oauth_tokens"),
    ("webhookId", "webhook_id"),
    ("webhookSecret", "webhook_secret"),
    ("settings", "settings"),
    ("syncSettings", "sync_settings"),
    ("fieldMappings", "field_mappings"),
    ("entityConfig", "entity_config"),
    ("syncCursor", "sync_cursor"),
    ("conflictStrategy", "conflict_strategy"),
    ("lastSyncAt", "last_sync_at"),
    ("lastSyncStatus", "last_sync_status"),
    ("lastError", "last_error"),
    ("lastErrorAt", "last_error_at"),
    ("companiesSynced", "companies_synced"),
    ("peopleSynced", "people_synced"),
    ("tasksSynced", "tasks_synced"),
    ("listsSynced", "lists_synced"),
    ("leadsSynced", "leads_synced"),
    ("opportunitiesSynced", "opportunities_synced"),
    ("activitiesSynced", "activities_synced"),
    ("connectedAt", "connected_at"),
    ("connectedBy", "connected_by"),
    ("triggerScheduleId", "trigger_schedule_id"),
];

/// Every column, for `jsonb_populate_record`.
const ALL_COLUMNS: &str = "id, created_at, updated_at, deleted_at, provider, name, status, direction, \
    external_account_id, oauth_tokens, webhook_id, webhook_secret, settings, sync_settings, \
    field_mappings, entity_config, sync_cursor, conflict_strategy, last_sync_at, last_sync_status, \
    last_error, last_error_at, companies_synced, people_synced, tasks_synced, lists_synced, \
    leads_synced, opportunities_synced, activities_synced, connected_at, connected_by, \
    trigger_schedule_id";

const ALL_FROM_R: &str = "r.id, r.created_at, r.updated_at, r.deleted_at, r.provider, r.name, \
    r.status, r.direction, r.external_account_id, r.oauth_tokens, r.webhook_id, r.webhook_secret, \
    r.settings, r.sync_settings, r.field_mappings, r.entity_config, r.sync_cursor, \
    r.conflict_strategy, r.last_sync_at, r.last_sync_status, r.last_error, r.last_error_at, \
    r.companies_synced, r.people_synced, r.tasks_synced, r.lists_synced, r.leads_synced, \
    r.opportunities_synced, r.activities_synced, r.connected_at, r.connected_by, \
    r.trigger_schedule_id";

/// The body's column values, by column name.
fn column_values(body: &Map<String, Value>) -> Map<String, Value> {
    COLUMNS
        .iter()
        .filter_map(|(camel, snake)| body.get(*camel).map(|v| ((*snake).to_owned(), v.clone())))
        .collect()
}

/// `createIntegrationSchema` (`.partial()` for an update), passthrough.
fn integration_body(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(body, "provider", required, Some(1), Some(50));
    issues.text(body, "name", Presence::Optional, None, Some(255));
    issues.text(body, "status", Presence::Optional, None, Some(30));
    body.clone()
}

async fn create_integration(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create integration";
    let data = match validate(&headers, &body, |issues, b| {
        integration_body(issues, b, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let id = generate_id("int");
    let stamp = now();
    // `{ id, ...data, createdAt: now, updatedAt: now }` over the columns' defaults.
    let mut record = Map::new();
    record.insert("status".to_owned(), json!("inactive"));
    record.insert("direction".to_owned(), json!("inbound"));
    record.insert("conflict_strategy".to_owned(), json!("last_write_wins"));
    for counter in [
        "companies_synced",
        "people_synced",
        "tasks_synced",
        "lists_synced",
        "leads_synced",
        "opportunities_synced",
        "activities_synced",
    ] {
        record.insert(counter.to_owned(), json!(0));
    }
    record.insert("id".to_owned(), json!(id));
    record.extend(column_values(&data));
    record.insert("created_at".to_owned(), json!(stamp));
    record.insert("updated_at".to_owned(), json!(stamp));
    let inserted = sqlx::query(sqlx::AssertSqlSafe(format!(
        "insert into integration_connections ({ALL_COLUMNS})
         select {ALL_FROM_R} from jsonb_populate_record(null::integration_connections, $1::jsonb) r"
    )))
    .bind(Value::Object(record))
    .execute(&caller.db)
    .await;
    match inserted {
        Ok(_) => Created(json!({ "id": id })).into_response(),
        Err(error) => internal_error(&error, FAILED),
    }
}

async fn update_integration(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update integration";
    let data = match validate(&headers, &body, |issues, b| {
        integration_body(issues, b, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result: Result<Response, sqlx::Error> = async {
        if connection_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Integration", Some(&id)).into_response());
        }
        let mut patch = column_values(&data);
        patch.insert("updated_at".to_owned(), json!(now()));
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "update integration_connections t set ({ALL_COLUMNS}) =
                 (select {ALL_FROM_R} from jsonb_populate_record(t, $2::jsonb) r)
             where t.id = $1 and t.deleted_at is null"
        )))
        .bind(&id)
        .bind(Value::Object(patch))
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal_error(&error, FAILED))
}

async fn delete_integration(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        if connection_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Integration", Some(&id)).into_response());
        }
        let stamp = now();
        sqlx::query(
            "update integration_connections set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal_error(&error, "Failed to delete integration"))
}

// ── Connections ─────────────────────────────────────────────────────────────

async fn list_connections(caller: Caller) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from integration_connections t where t.deleted_at is null
         order by t.created_at desc",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(sanitized).collect::<Vec<_>>()).into_response(),
        Err(error) => internal_error(&error, "Failed to list connections"),
    }
}

/// The MCP `settings` object, as Zod outputs it (known keys only).
fn mcp_settings(issues: &mut Issues, s: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let mut out = Map::new();
    let transport = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    if let Field::Set(v) = issues.choice(s, "transportType", transport, TRANSPORTS) {
        out.insert("transportType".to_owned(), json!(v));
    }
    let url = Text {
        format: Some(Format::Url),
        ..Text::default()
    };
    if let Field::Set(v) = issues.text_with(s, "url", Presence::Optional, url) {
        out.insert("url".to_owned(), json!(v));
    }
    if let Field::Set(v) = issues.text(s, "command", Presence::Optional, None, None) {
        out.insert("command".to_owned(), json!(v));
    }
    if let Field::Set(v) = issues.list(s, "args", Presence::Optional, None, None, |issues, item| {
        issues.item_text(item, Text::default())
    }) {
        out.insert("args".to_owned(), json!(v));
    }
    if let Field::Set(v) = issues.choice(s, "authType", Presence::Optional, AUTH_TYPES) {
        out.insert("authType".to_owned(), json!(v));
    }
    if let Field::Set(v) = issues.text(s, "headerName", Presence::Optional, None, None) {
        out.insert("headerName".to_owned(), json!(v));
    }
    out
}

async fn create_connection(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create connection";
    let input = match validate(&headers, &body, |issues, b| {
        let provider = issues.choice(b, "provider", Presence::Required, &["mcp_server"]);
        let name = issues.text(b, "name", Presence::Required, Some(1), Some(255));
        let settings = issues.nested(b, "settings", Presence::Required, |issues, s| {
            mcp_settings(issues, s, false)
        });
        let token = issues.text(b, "accessToken", Presence::Optional, None, None);
        (
            provider.into_option().unwrap_or_default(),
            name.into_option().unwrap_or_default(),
            settings.into_option().unwrap_or_default(),
            token.into_option(),
        )
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let (provider, name, settings, token) = input;
    let id = generate_id("intc");
    let tokens = token
        .filter(|t| !t.is_empty())
        .map(|t| json!({ "accessToken": t }));
    let inserted = sqlx::query(
        "insert into integration_connections
            (id, provider, name, status, direction, settings, oauth_tokens, connected_at, connected_by)
         values ($1, $2, $3, 'active', 'bidirectional', $4::jsonb, $5::jsonb, $6::timestamp, $7)",
    )
    .bind(&id)
    .bind(&provider)
    .bind(&name)
    .bind(Value::Object(settings))
    .bind(tokens)
    .bind(now())
    .bind(&caller.user_id)
    .execute(&caller.db)
    .await;
    match inserted {
        Ok(_) => Created(json!({
            "id": id,
            "provider": provider,
            "name": name,
            "status": "active",
            "connectedAt": now(),
        }))
        .into_response(),
        Err(error) => internal_error(&error, FAILED),
    }
}

async fn get_connection(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        let Some(row) = connection_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Connection", Some(&id)).into_response());
        };
        let logs: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(l) from sync_logs l where l.connection_id = $1
             order by l.created_at desc limit 20",
        )
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        let mut detail = sanitized(row);
        detail["recentLogs"] = Value::Array(logs.into_iter().map(js_row).collect());
        Ok(Data(detail).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal_error(&error, "Failed to fetch connection"))
}

/// What `updateConnectionSchema` reads.
struct ConnectionPatch {
    name: Option<String>,
    direction: Option<String>,
    entity_config: Option<Map<String, Value>>,
    settings: Option<Map<String, Value>>,
    access_token: Option<String>,
    sync_settings: Option<Map<String, Value>>,
}

fn connection_patch(issues: &mut Issues, b: &Map<String, Value>) -> ConnectionPatch {
    let name = issues
        .text(b, "name", Presence::Optional, Some(1), Some(255))
        .into_option();
    let direction = issues
        .choice(b, "direction", Presence::Optional, DIRECTIONS)
        .into_option();
    let entity_config = issues
        .nested(b, "entityConfig", Presence::Optional, |issues, inner| {
            let mut out = Map::new();
            for key in inner.keys() {
                if let Field::Set(v) = issues.choice(inner, key, Presence::Required, DIRECTIONS) {
                    out.insert(key.clone(), json!(v));
                }
            }
            out
        })
        .into_option();
    let settings = issues
        .nested(b, "settings", Presence::Optional, |issues, s| {
            mcp_settings(issues, s, true)
        })
        .into_option();
    let access_token = issues
        .text(b, "accessToken", Presence::Optional, None, None)
        .into_option();
    let sync_settings = issues
        .nested(b, "syncSettings", Presence::Optional, |issues, s| {
            let mut out = Map::new();
            for key in [
                "syncCompanies",
                "syncPeople",
                "syncLeads",
                "syncOpportunities",
                "syncActivities",
                "syncCalendarEvents",
            ] {
                if let Field::Set(v) = issues.boolean(s, key, Presence::Optional) {
                    out.insert(key.to_owned(), json!(v));
                }
            }
            if let Field::Set(v) = issues.number(
                s,
                "syncIntervalHours",
                Presence::Optional,
                weldsuite_kit::validation::Number {
                    min: Some(1.0),
                    max: Some(168.0),
                    ..Default::default()
                },
            ) {
                out.insert("syncIntervalHours".to_owned(), number_value(v));
            }
            out
        })
        .into_option();
    ConnectionPatch {
        name,
        direction,
        entity_config,
        settings,
        access_token,
        sync_settings,
    }
}

async fn update_connection(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update connection";
    let patch = match validate(&headers, &body, connection_patch) {
        Ok(patch) => patch,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result: Result<Response, sqlx::Error> = async {
        let Some(connection) = connection_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Connection", Some(&id)).into_response());
        };
        let entity_config = patch
            .entity_config
            .as_ref()
            .map(|p| merged(connection.get("entity_config"), p));
        let settings = patch
            .settings
            .as_ref()
            .map(|p| merged(connection.get("settings"), p));
        let sync_settings = patch
            .sync_settings
            .as_ref()
            .map(|p| merged(connection.get("sync_settings"), p));
        // `accessToken ? { accessToken } : null` when it was sent.
        let tokens = patch.access_token.as_ref().map(|token| {
            if token.is_empty() {
                Value::Null
            } else {
                json!({ "accessToken": token })
            }
        });
        sqlx::query(
            "update integration_connections set
                 updated_at = $2::timestamp,
                 name = case when $3::text is null then name else $3 end,
                 direction = case when $4::text is null then direction else $4 end,
                 entity_config = case when $5::jsonb is null then entity_config else $5 end,
                 settings = case when $6::jsonb is null then settings else $6 end,
                 oauth_tokens = case when $7 then $8::jsonb else oauth_tokens end,
                 sync_settings = case when $9::jsonb is null then sync_settings else $9 end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(patch.name.filter(|n| !n.is_empty()))
        .bind(patch.direction.filter(|d| !d.is_empty()))
        .bind(entity_config)
        .bind(settings)
        .bind(tokens.is_some())
        .bind(tokens.filter(|t| !t.is_null()))
        .bind(sync_settings)
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({ "id": id, "updated": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal_error(&error, FAILED))
}

async fn disconnect(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, Refusal> = async {
        let Some(connection) = connection_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Connection", &id));
        };
        let token = connection["oauth_tokens"]
            .get("accessToken")
            .filter(|t| truthy(t))
            .map(|t| crate::js::js_string(Some(t)));
        let webhook_id = connection["webhook_id"].as_str().filter(|w| !w.is_empty());
        let provider = connection["provider"].as_str().and_then(Provider::of);
        if let (Some(token), Some(webhook_id), Some(provider)) = (token, webhook_id, provider)
            && let Err(error) = provider
                .delete_webhooks(
                    &caller.http(&state),
                    &token,
                    webhook_id,
                    connection["webhook_secret"]
                        .as_str()
                        .filter(|s| !s.is_empty()),
                )
                .await
        {
            tracing::warn!(%error, "[app-api/integrations] failed to delete remote webhooks");
        }
        caller
            .workspace_cache(&state)?
            .delete_boxed(&format!("intconn:{id}"))
            .await
            .map_err(db_error)?;
        let stamp = now();
        sqlx::query(
            "update integration_connections set status = 'inactive', deleted_at = $2::timestamp,
                 updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|refusal| refusal.respond("Failed to disconnect"))
}

// ── OAuth connect flows ─────────────────────────────────────────────────────

/// `authorizeSchema`.
fn redirect_uri(issues: &mut Issues, b: &Map<String, Value>) -> String {
    issues
        .text_with(
            b,
            "redirectUri",
            Presence::Required,
            Text {
                format: Some(Format::Url),
                ..Text::default()
            },
        )
        .into_option()
        .unwrap_or_default()
}

/// `callbackSchema`: `(code, state, redirectUri)`.
fn callback_body(issues: &mut Issues, b: &Map<String, Value>) -> (String, String, String) {
    let code = issues
        .text(b, "code", Presence::Required, Some(1), None)
        .into_option();
    let state = issues
        .text(b, "state", Presence::Required, Some(1), None)
        .into_option();
    let redirect = redirect_uri(issues, b);
    (
        code.unwrap_or_default(),
        state.unwrap_or_default(),
        redirect,
    )
}

/// `JSON.stringify({ orgId, userId[, provider] })`.
fn state_record(org_id: &str, user_id: &str, provider: Option<&str>) -> String {
    let mut out = format!(
        "{{\"orgId\":{},\"userId\":{}",
        json!(org_id),
        json!(user_id)
    );
    if let Some(provider) = provider {
        out.push_str(&format!(",\"provider\":{}", json!(provider)));
    }
    out.push('}');
    out
}

async fn attio_authorize(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to start Attio OAuth";
    let redirect = match validate(&headers, &body, redirect_uri) {
        Ok(redirect) => redirect,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let Some(client_id) = caller.env_value(&state, "ATTIO_CLIENT_ID") else {
        return ApiError::internal()
            .with_message("Attio client ID not configured")
            .into_response();
    };
    let result: Result<Response, Refusal> = async {
        let oauth_state = uuid();
        caller
            .workspace_cache(&state)?
            .put_boxed(
                &format!("attio_oauth_state:{oauth_state}"),
                &state_record(&org_id, &caller.user_id, None),
                Some(STATE_TTL),
            )
            .await
            .map_err(db_error)?;
        let url = Provider::Attio.authorize_url(&client_id, &redirect, &oauth_state);
        Ok(Data(json!({ "authorizeUrl": url, "state": oauth_state })).into_response())
    }
    .await;
    result.unwrap_or_else(|refusal| refusal.respond(FAILED))
}

async fn generic_authorize(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(provider): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to start OAuth";
    let redirect = match validate(&headers, &body, redirect_uri) {
        Ok(redirect) => redirect,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let Some(adapter) = Provider::of(&provider) else {
        return ApiError::bad_request(format!("Provider {provider} is not supported"))
            .into_response();
    };
    let (Some(client_id), _) = provider_credentials(&caller, &state, &provider) else {
        return ApiError::bad_request(format!("Provider {provider} is not configured"))
            .into_response();
    };
    let result: Result<Response, Refusal> = async {
        let oauth_state = uuid();
        caller
            .workspace_cache(&state)?
            .put_boxed(
                &format!("oauth_state:{oauth_state}"),
                &state_record(&org_id, &caller.user_id, Some(&provider)),
                Some(STATE_TTL),
            )
            .await
            .map_err(db_error)?;
        let url = adapter.authorize_url(&client_id, &redirect, &oauth_state);
        Ok(Data(json!({ "authorizeUrl": url, "state": oauth_state })).into_response())
    }
    .await;
    result.unwrap_or_else(|refusal| refusal.respond(FAILED))
}

/// A KV value read as JSON (`get(key, 'json')`): `None` when missing.
async fn kv_json(cache: &Arc<dyn DynCache>, key: &str) -> Result<Option<Value>, Refusal> {
    match cache.get_boxed(key).await.map_err(db_error)? {
        None => Ok(None),
        Some(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| db_error(error.to_string())),
    }
}

/// A connect flow's failure: `error.internal(c, err.message)`.
fn thrown(message: impl Into<String>) -> Refusal {
    Refusal::Response(Box::new(
        ApiError::internal().with_message(message).into_response(),
    ))
}

/// The CRM sync binding the request carries (conformance), else none.
fn crm_runs(extensions: &http::Extensions) -> Option<Arc<dyn ProjectSyncRuns>> {
    extensions
        .get::<RequestCrmSyncRuns>()
        .and_then(|runs| runs.0.clone())
}

/// What a connect flow writes once the tokens are in.
struct NewConnection<'a> {
    id: &'a str,
    provider: &'a str,
    name: &'a str,
    direction: &'a str,
    external_account_id: Option<String>,
    tokens: &'a Tokens,
    webhook_id: &'a str,
    webhook_secret: &'a str,
    settings: Option<Value>,
    sync_settings: Value,
    connected_by: &'a str,
}

async fn insert_connection(db: &PgPool, c: NewConnection<'_>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into integration_connections
            (id, provider, name, status, direction, external_account_id, oauth_tokens, webhook_id,
             webhook_secret, settings, sync_settings, connected_at, connected_by)
         values ($1, $2, $3, 'active', $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb,
                 $11::timestamp, $12)",
    )
    .bind(c.id)
    .bind(c.provider)
    .bind(c.name)
    .bind(c.direction)
    .bind(c.external_account_id)
    .bind(c.tokens.to_json())
    .bind(c.webhook_id)
    .bind(c.webhook_secret)
    .bind(c.settings)
    .bind(c.sync_settings)
    .bind(now())
    .bind(c.connected_by)
    .execute(db)
    .await?;
    Ok(())
}

/// `intconn:<id>` → `{ workspaceId, provider }` for integration-webhook-worker.
async fn put_connection_mapping(
    cache: &Arc<dyn DynCache>,
    id: &str,
    workspace_id: &str,
    provider: &str,
) -> Result<(), Refusal> {
    let value = format!(
        "{{\"workspaceId\":{},\"provider\":{}}}",
        json!(workspace_id),
        json!(provider)
    );
    cache
        .put_boxed(&format!("intconn:{id}"), &value, Some(MAPPING_TTL))
        .await
        .map_err(db_error)
}

#[allow(clippy::too_many_arguments)]
async fn attio_callback(
    State(state): State<ConnectState>,
    caller: Caller,
    extensions: http::Extensions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (code, oauth_state, redirect) = match validate(&headers, &body, callback_body) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("OAuth callback failed"),
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let result: Result<Response, Refusal> = async {
        let cache = caller.workspace_cache(&state)?;
        let key = format!("attio_oauth_state:{oauth_state}");
        let stored = kv_json(&cache, &key).await?;
        if stored
            .as_ref()
            .and_then(|s| s.get("orgId"))
            .and_then(Value::as_str)
            != Some(org_id.as_str())
        {
            return Err(Refusal::bad_request("Invalid or expired OAuth state"));
        }
        let stored = stored.unwrap_or(Value::Null);
        cache.delete_boxed(&key).await.map_err(db_error)?;
        let (Some(client_id), Some(client_secret)) = (
            caller.env_value(&state, "ATTIO_CLIENT_ID"),
            caller.env_value(&state, "ATTIO_CLIENT_SECRET"),
        ) else {
            return Err(thrown("Attio credentials not configured"));
        };
        let http = caller.http(&state);
        let adapter = Provider::Attio;
        let tokens = adapter
            .exchange_code(&http, &client_id, &client_secret, &code, &redirect)
            .await
            .map_err(thrown)?;
        let id = generate_id("intc");
        let environment = caller.overrides.env(&state, "ENVIRONMENT");
        let target = format!("{}/webhook/{id}", webhook_worker_url(environment.as_deref()));
        let registration = adapter
            .register_webhooks(&http, tokens.bearer(), &target)
            .await
            .map_err(thrown)?;
        let connected_by = text_of(&stored, "userId").unwrap_or_default();
        insert_connection(
            &caller.db,
            NewConnection {
                id: &id,
                provider: "attio",
                name: "Attio CRM",
                direction: "inbound",
                external_account_id: None,
                tokens: &tokens,
                webhook_id: &registration.webhook_id,
                webhook_secret: &registration.secret,
                settings: None,
                sync_settings: json!({ "syncCompanies": true, "syncPeople": true, "syncIntervalHours": 6 }),
                connected_by: &connected_by,
            },
        )
        .await
        .map_err(|error| thrown(error.to_string()))?;
        put_connection_mapping(&cache, &id, &caller.workspace_id, "attio").await?;
        if let Err(error) =
            trigger_crm_sync(crm_runs(&extensions).as_ref(), &id, &org_id, "attio", "full").await
        {
            tracing::error!(%error, "[app-api/integrations] failed to trigger initial Attio sync");
        }
        Ok(Created(json!({
            "id": id,
            "provider": "attio",
            "status": "active",
            "connectedAt": now(),
        }))
        .into_response())
    }
    .await;
    result.unwrap_or_else(|refusal| refusal.respond("OAuth callback failed"))
}

/// `connectionProfile(provider)`: display name, direction, sync settings.
fn connection_profile(provider: &str) -> (String, &'static str, Value) {
    if provider == "google_calendar" {
        return (
            "Google Calendar".to_owned(),
            "bidirectional",
            json!({ "syncCalendarEvents": true, "syncIntervalHours": 1 }),
        );
    }
    let mut chars = provider.chars();
    let name = chars.next().map_or_else(String::new, |first| {
        format!("{}{} CRM", first.to_uppercase(), chars.as_str())
    });
    (
        name,
        "inbound",
        json!({ "syncCompanies": true, "syncPeople": true, "syncIntervalHours": 6 }),
    )
}

async fn generic_callback(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(provider): Path<String>,
    extensions: http::Extensions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (code, oauth_state, redirect) = match validate(&headers, &body, callback_body) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("OAuth callback failed"),
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let Some(adapter) = Provider::of(&provider) else {
        return ApiError::bad_request(format!("Provider {provider} is not supported"))
            .into_response();
    };
    let result: Result<Response, Refusal> = async {
        let cache = caller.workspace_cache(&state)?;
        // `consumeOAuthState`.
        let key = format!("oauth_state:{oauth_state}");
        let stored = kv_json(&cache, &key).await?;
        let matches = stored.as_ref().is_some_and(|s| {
            s.get("orgId").and_then(Value::as_str) == Some(org_id.as_str())
                && s.get("provider").and_then(Value::as_str) == Some(provider.as_str())
        });
        if !matches {
            return Err(Refusal::bad_request("Invalid or expired OAuth state"));
        }
        let stored = stored.unwrap_or(Value::Null);
        cache.delete_boxed(&key).await.map_err(db_error)?;
        let (Some(client_id), Some(client_secret)) =
            provider_credentials(&caller, &state, &provider)
        else {
            return Err(thrown(format!("{provider} credentials not configured")));
        };
        let http = caller.http(&state);
        let tokens = adapter
            .exchange_code(&http, &client_id, &client_secret, &code, &redirect)
            .await
            .map_err(thrown)?;
        let id = generate_id("intc");
        let calendar = adapter == Provider::GoogleCalendar;
        let (name, direction, sync_settings) = connection_profile(&provider);
        let path = if calendar {
            format!("gcal/{id}")
        } else {
            id.clone()
        };
        let environment = caller.overrides.env(&state, "ENVIRONMENT");
        let target = format!(
            "{}/webhook/{path}",
            webhook_worker_url(environment.as_deref())
        );
        let registration = adapter
            .register_webhooks(&http, tokens.bearer(), &target)
            .await
            .map_err(thrown)?;
        let webhook_secret = if adapter == Provider::Hubspot {
            client_secret.clone()
        } else {
            registration.secret.clone()
        };
        let external_account_id = if adapter == Provider::Hubspot {
            hubspot_portal_id(&http, tokens.bearer()).await
        } else {
            None
        };
        let connected_by = text_of(&stored, "userId").unwrap_or_default();
        let settings = if calendar {
            let calendar_id = generate_id("cal");
            sqlx::query(
                "insert into calendars (id, name, color, owner_id, is_default)
                 values ($1, 'Google Calendar', '#4285f4', $2, false)",
            )
            .bind(&calendar_id)
            .bind(&connected_by)
            .execute(&caller.db)
            .await
            .map_err(|error| thrown(error.to_string()))?;
            Some(json!({ "googleCalendarId": calendar_id }))
        } else {
            None
        };
        insert_connection(
            &caller.db,
            NewConnection {
                id: &id,
                provider: &provider,
                name: &name,
                direction,
                external_account_id,
                tokens: &tokens,
                webhook_id: &registration.webhook_id,
                webhook_secret: &webhook_secret,
                settings,
                sync_settings,
                connected_by: &connected_by,
            },
        )
        .await
        .map_err(|error| thrown(error.to_string()))?;
        if !calendar {
            insert_default_mappings(&caller.db, adapter, &id)
                .await
                .map_err(|error| thrown(error.to_string()))?;
        }
        put_connection_mapping(&cache, &id, &caller.workspace_id, &provider).await?;
        if let Err(error) = trigger_crm_sync(
            crm_runs(&extensions).as_ref(),
            &id,
            &org_id,
            &provider,
            "full",
        )
        .await
        {
            tracing::error!(%error, "[app-api/integrations] failed to trigger initial sync");
        }
        Ok(Created(json!({
            "id": id,
            "provider": provider,
            "status": "active",
            "connectedAt": now(),
        }))
        .into_response())
    }
    .await;
    result.unwrap_or_else(|refusal| refusal.respond("OAuth callback failed"))
}

/// `buildDefaultFieldMappings`: every supported entity's defaults, one
/// statement (rows share their creation time).
async fn insert_default_mappings(
    db: &PgPool,
    adapter: Provider,
    connection_id: &str,
) -> Result<(), sqlx::Error> {
    let mut rows = Vec::new();
    for entity in adapter.supported_entities() {
        for (position, mapping) in adapter
            .default_field_mappings(entity)
            .into_iter()
            .enumerate()
        {
            rows.push(json!({
                "id": generate_id("ifm"),
                "entity_type": entity,
                "external_field_path": mapping["externalFieldPath"],
                "internal_field_path": mapping["internalFieldPath"],
                "direction": mapping["direction"],
                "transform_type": mapping["transformType"],
                "transform_config": mapping.get("transformConfig").cloned().unwrap_or(Value::Null),
                "is_required": mapping.get("isRequired").is_some_and(truthy),
                "position": position,
            }));
        }
    }
    insert_mappings(db, connection_id, &rows, true).await
}

/// Multi-row insert of `integration_field_mappings` (snake_case objects).
async fn insert_mappings(
    db: &PgPool,
    connection_id: &str,
    rows: &[Value],
    is_default: bool,
) -> Result<(), sqlx::Error> {
    if rows.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "insert into integration_field_mappings
            (id, connection_id, entity_type, external_field_path, internal_field_path, direction,
             transform_type, transform_config, is_required, is_default, position)
         select r.id, $1, r.entity_type, r.external_field_path, r.internal_field_path, r.direction,
                r.transform_type, r.transform_config, r.is_required, $3, r.position
         from jsonb_to_recordset($2::jsonb) as r(id text, entity_type text, external_field_path text,
              internal_field_path text, direction text, transform_type text, transform_config jsonb,
              is_required boolean, position int)",
    )
    .bind(connection_id)
    .bind(Value::Array(rows.to_vec()))
    .bind(is_default)
    .execute(db)
    .await?;
    Ok(())
}

// ── MCP tool discovery and connectivity ─────────────────────────────────────

async fn discover_tools(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, Refusal> = async {
        let Some(connection) = connection_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Connection", &id));
        };
        if connection["provider"].as_str() != Some("mcp_server") {
            return Err(Refusal::bad_request(
                "Tool discovery is only supported for MCP server integrations",
            ));
        }
        let settings = match &connection["settings"] {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        let Some(url) = settings
            .get("url")
            .filter(|u| truthy(u))
            .map(|u| crate::js::js_string(Some(u)))
        else {
            return Err(Refusal::bad_request(
                "No URL configured for this MCP server",
            ));
        };
        let mut request = HttpRequest::empty("POST", &url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json");
        let token = connection["oauth_tokens"]
            .get("accessToken")
            .filter(|t| truthy(t))
            .map(|t| crate::js::js_string(Some(t)));
        let auth_type = settings.get("authType").and_then(Value::as_str);
        if let Some(token) = &token {
            match auth_type {
                Some("bearer") => {
                    request = request.header("Authorization", format!("Bearer {token}"))
                }
                Some("api_key") => request = request.header("X-API-Key", token.clone()),
                Some("header") => {
                    if let Some(name) = settings.get("headerName").filter(|n| truthy(n)) {
                        request = request.header(&crate::js::js_string(Some(name)), token.clone());
                    }
                }
                _ => {}
            }
        }
        request.body =
            Some(br#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#.to_vec());
        let response = match caller.http(&state).send(request).await {
            Ok(response) => response,
            Err(error) => {
                return Err(Refusal::bad_request(format!(
                    "Failed to connect to MCP server: {error}"
                )));
            }
        };
        if !response.ok() {
            let text = response.text();
            return Err(Refusal::bad_request(format!(
                "MCP server returned {}: {}",
                response.status,
                weldsuite_subscribers_slice(&text, 200)
            )));
        }
        let rpc: Value = serde_json::from_slice(&response.body).map_err(|error| {
            Refusal::bad_request(format!("Failed to connect to MCP server: {error}"))
        })?;
        if let Some(error) = rpc.get("error").filter(|e| truthy(e)) {
            return Err(Refusal::bad_request(format!(
                "MCP server error: {}",
                crate::js::js_string(error.get("message"))
            )));
        }
        let tools: Vec<Value> = crate::js::array(rpc.get("result").and_then(|r| r.get("tools")))
            .iter()
            .map(|tool| {
                let mut out = Map::new();
                if let Some(name) = tool.get("name").filter(|n| !n.is_null()) {
                    out.insert("name".to_owned(), name.clone());
                }
                out.insert(
                    "description".to_owned(),
                    tool.get("description")
                        .filter(|d| truthy(d))
                        .cloned()
                        .unwrap_or_else(|| json!("")),
                );
                out.insert(
                    "inputSchema".to_owned(),
                    tool.get("inputSchema")
                        .filter(|s| truthy(s))
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                );
                Value::Object(out)
            })
            .collect();
        let discovered_at = now();
        let mut next = settings.clone();
        next.insert("discoveredTools".to_owned(), Value::Array(tools.clone()));
        next.insert("lastDiscoveredAt".to_owned(), json!(discovered_at));
        sqlx::query(
            "update integration_connections set settings = $2::jsonb, status = 'active',
                 last_error = null, last_error_at = null, updated_at = $3::timestamp where id = $1",
        )
        .bind(&id)
        .bind(Value::Object(next))
        .bind(now())
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({ "tools": tools, "lastDiscoveredAt": discovered_at })).into_response())
    }
    .await;
    result.unwrap_or_else(|refusal| refusal.respond("Failed to discover tools"))
}

/// `text.slice(0, n)` in UTF-16 units.
fn weldsuite_subscribers_slice(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

async fn test_connection(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        let Some(connection) = connection_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Connection", Some(&id)).into_response());
        };
        if connection["provider"].as_str() != Some("mcp_server") {
            return Ok(Data(
                json!({ "connected": true, "message": "Test not implemented for this provider" }),
            )
            .into_response());
        }
        let Some(url) = connection["settings"]
            .get("url")
            .filter(|u| truthy(u))
            .map(|u| crate::js::js_string(Some(u)))
        else {
            return Ok(
                Data(json!({ "connected": false, "error": "No URL configured" })).into_response(),
            );
        };
        // `testMcpConnection`: a HEAD request; 405 is fine.
        match caller
            .http(&state)
            .send(HttpRequest::empty("HEAD", &url))
            .await
        {
            Ok(response) => {
                let connected = response.ok() || response.status == 405;
                sqlx::query(
                    "update integration_connections set status = $2, last_error = $3,
                         last_error_at = case when $4 then null else $5::timestamp end,
                         updated_at = $5::timestamp where id = $1",
                )
                .bind(&id)
                .bind(if connected { "active" } else { "error" })
                .bind((!connected).then(|| format!("HTTP {}", response.status)))
                .bind(connected)
                .bind(now())
                .execute(&caller.db)
                .await?;
                Ok(
                    Data(json!({ "connected": connected, "status": response.status }))
                        .into_response(),
                )
            }
            Err(error) => {
                let message = error.to_string();
                sqlx::query(
                    "update integration_connections set status = 'error', last_error = $2,
                         last_error_at = $3::timestamp, updated_at = $3::timestamp where id = $1",
                )
                .bind(&id)
                .bind(&message)
                .bind(now())
                .execute(&caller.db)
                .await?;
                Ok(Data(json!({ "connected": false, "error": message })).into_response())
            }
        }
    }
    .await;
    result.unwrap_or_else(|error| internal_error(&error, "Failed to test connection"))
}

// ── Sync and watch renewal ──────────────────────────────────────────────────

async fn sync(caller: Caller, Path(id): Path<String>, extensions: http::Extensions) -> Response {
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let result = trigger_connection_sync(
        &caller.db,
        crm_runs(&extensions).as_ref(),
        &org_id,
        &id,
        "full",
    )
    .await;
    action_response(result, &id, true, "Failed to trigger sync")
}

async fn renew_watch(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    if caller.org_id.is_none() {
        return ApiError::org_required().into_response();
    }
    let http = caller.http(&state);
    let renewal = WatchRenewal {
        http: &http,
        client_id: caller.env_value(&state, "GOOGLE_CALENDAR_CLIENT_ID"),
        client_secret: caller.env_value(&state, "GOOGLE_CALENDAR_CLIENT_SECRET"),
        environment: caller.overrides.env(&state, "ENVIRONMENT"),
    };
    let result = renew_google_calendar_watch(&caller.db, renewal, &id).await;
    action_response(result, &id, false, "Failed to renew watch channel")
}

// ── Logs, field mappings, conflicts, entity mappings ────────────────────────

async fn logs(caller: Caller, Path(id): Path<String>) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(l) from sync_logs l where l.connection_id = $1
         order by l.created_at desc limit 50",
    )
    .bind(&id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => internal_error(&error, "Failed to fetch sync logs"),
    }
}

async fn field_mappings(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let entity_type = query_truthy(query.as_deref(), "entityType");
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(m) from integration_field_mappings m
         where m.connection_id = $1 and ($2::text is null or m.entity_type = $2)",
    )
    .bind(&id)
    .bind(&entity_type)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => internal_error(&error, "Failed to fetch field mappings"),
    }
}

async fn default_field_mappings(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(entity_type) = query_truthy(query.as_deref(), "entityType") else {
        return ApiError::bad_request("entityType query param required").into_response();
    };
    let result: Result<Response, sqlx::Error> = async {
        let Some(connection) = connection_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Connection", Some(&id)).into_response());
        };
        let provider = connection["provider"].as_str().unwrap_or_default();
        let Some(adapter) = Provider::of(provider) else {
            return Ok(ApiError::bad_request(format!(
                "Provider {provider} has no default field mappings"
            ))
            .into_response());
        };
        Ok(Data(adapter.default_field_mappings(&entity_type)).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal_error(&error, "Failed to fetch default field mappings"))
}

/// `updateFieldMappingsSchema`: `(entityType, mappings)`, each mapping as
/// its row's columns.
pub(crate) fn field_mappings_body(
    issues: &mut Issues,
    b: &Map<String, Value>,
) -> (String, Vec<Value>) {
    let entity_type = issues
        .text(b, "entityType", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    let mappings = issues
            .list(b, "mappings", Presence::Required, None, None, |issues, item| {
                let fields = issues.object(item)?;
                let external = issues.text(fields, "externalFieldPath", Presence::Required, Some(1), None);
                let internal = issues.text(fields, "internalFieldPath", Presence::Required, Some(1), None);
                let direction = issues.choice(fields, "direction", Presence::Optional, DIRECTIONS);
                let transform = issues.choice(
                    fields,
                    "transformType",
                    Presence::Optional,
                    &["direct", "lookup", "format_date", "custom"],
                );
                let config = issues.nested(fields, "transformConfig", Presence::Optional, |_, inner| {
                    Value::Object(inner.clone())
                });
                let required = issues.boolean(fields, "isRequired", Presence::Optional);
                Some(json!({
                    "external_field_path": external.into_option(),
                    "internal_field_path": internal.into_option(),
                    "direction": direction.into_option().unwrap_or_else(|| "bidirectional".to_owned()),
                    "transform_type": transform.into_option().unwrap_or_else(|| "direct".to_owned()),
                    "transform_config": config.into_option(),
                    "is_required": required.into_option().unwrap_or(false),
                }))
            })
            .into_option()
            .unwrap_or_default();
    (entity_type, mappings)
}

/// The connection's mappings of `entity_type` replaced by `mappings`.
pub(crate) async fn replace_mappings(
    db: &PgPool,
    id: &str,
    entity_type: &str,
    mappings: &[Value],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "delete from integration_field_mappings where connection_id = $1 and entity_type = $2",
    )
    .bind(id)
    .bind(entity_type)
    .execute(db)
    .await?;
    let rows: Vec<Value> = mappings
        .iter()
        .enumerate()
        .map(|(position, m)| {
            let mut row = m.clone();
            row["id"] = json!(generate_id("ifm"));
            row["entity_type"] = json!(entity_type);
            row["position"] = json!(position);
            row
        })
        .collect();
    insert_mappings(db, id, &rows, false).await?;
    Ok(())
}

async fn replace_field_mappings(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update field mappings";
    let read = validate(&headers, &body, field_mappings_body);
    let (entity_type, mappings) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result: Result<Response, sqlx::Error> = async {
        replace_mappings(&caller.db, &id, &entity_type, &mappings).await?;
        Ok(Data(json!({ "entityType": entity_type, "count": mappings.len() })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal_error(&error, FAILED))
}

async fn conflicts(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let resolution = query_truthy(query, "resolution").unwrap_or_else(|| "pending".to_owned());
    let entity_type = query_truthy(query, "entityType");
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(c) from integration_sync_conflicts c
         where c.connection_id = $1 and c.resolution = $2 and ($3::text is null or c.entity_type = $3)
         order by c.created_at desc limit 100",
    )
    .bind(&id)
    .bind(&resolution)
    .bind(&entity_type)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => internal_error(&error, "Failed to fetch conflicts"),
    }
}

async fn resolve_conflict(
    caller: Caller,
    Path((_id, conflict_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to resolve conflict";
    let resolution = match validate(&headers, &body, |issues, b| {
        issues
            .choice(
                b,
                "resolution",
                Presence::Required,
                &["keep_internal", "keep_external", "merged", "dismissed"],
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(resolution) => resolution,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let updated = sqlx::query(
        "update integration_sync_conflicts set resolution = $2, resolved_at = $3::timestamp,
             resolved_by = $4 where id = $1",
    )
    .bind(&conflict_id)
    .bind(&resolution)
    .bind(now())
    .bind(&caller.user_id)
    .execute(&caller.db)
    .await;
    match updated {
        Ok(_) => Data(json!({ "resolved": true })).into_response(),
        Err(error) => internal_error(&error, FAILED),
    }
}

async fn resolve_all(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to resolve conflicts";
    let (resolution, entity_type) = match validate(&headers, &body, |issues, b| {
        let resolution = issues
            .choice(
                b,
                "resolution",
                Presence::Required,
                &["keep_internal", "keep_external", "dismissed"],
            )
            .into_option()
            .unwrap_or_default();
        let entity_type = issues
            .text(b, "entityType", Presence::Optional, None, None)
            .into_option();
        (resolution, entity_type)
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let updated = sqlx::query(
        "update integration_sync_conflicts set resolution = $2, resolved_at = $3::timestamp,
             resolved_by = $4
         where connection_id = $1 and resolution = 'pending' and ($5::text is null or entity_type = $5)",
    )
    .bind(&id)
    .bind(&resolution)
    .bind(now())
    .bind(&caller.user_id)
    .bind(entity_type.filter(|e| !e.is_empty()))
    .execute(&caller.db)
    .await;
    match updated {
        Ok(_) => Data(json!({ "resolved": true })).into_response(),
        Err(error) => internal_error(&error, FAILED),
    }
}

async fn entity_mappings(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let (Some(entity_type), Some(entity_id)) = (
        query_truthy(query, "internalEntityType"),
        query_truthy(query, "internalEntityId"),
    ) else {
        return ApiError::bad_request("internalEntityType and internalEntityId are required")
            .into_response();
    };
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(m) from integration_entity_mappings m
         where m.internal_entity_type = $1 and m.internal_entity_id = $2",
    )
    .bind(&entity_type)
    .bind(&entity_id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => internal_error(&error, "Failed to fetch entity mappings"),
    }
}
