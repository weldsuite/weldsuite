//! `/api/integrations` (`routes/integrations/index.ts`,
//! `services/integrations/connections.ts`): integration connections
//! (`integration_connections`), backing the original object CRUD and the
//! connections surface: MCP servers (create, tool discovery, connectivity
//! test), the Attio, `HubSpot` and Google Calendar OAuth connect flows,
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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm, orm_error, utc_now};
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, HttpRequest, OutboundHttp};
use weldsuite_schema::tenant::integration_connections::{self as connections, Column, Model};
use weldsuite_schema::tenant::{
    calendars, integration_entity_mappings, integration_field_mappings, integration_sync_conflicts,
    sync_logs,
};

use self::oauth::{Provider, Tokens, hubspot_portal_id, webhook_worker_url};
use crate::js::{next_cursor, page, page_limit, query_truthy, truthy};
use crate::runs::ProjectSyncRuns;
use crate::{Caller, ConnectState, Refusal, internal as internal_error, now, validate};

/// The `CRM_SYNC` Workflow binding (`CrmSyncWorkflow`, hosted by
/// integration-webhook-worker on Global): `create({ id, params })`, the
/// same shape as `GITHUB_PROJECT_SYNC`. A request's own binding
/// (conformance): the test's, or none.
#[derive(Clone)]
pub struct RequestCrmSyncRuns(pub Option<Arc<dyn ProjectSyncRuns>>);

const STATE_TTL: Duration = Duration::from_secs(300);
const MAPPING_TTL: Duration = Duration::from_hours(8760);
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
    Refusal::from(sqlx::Error::Protocol(error.to_string()))
}

/// The database's own message, where a route's answer carries it
/// (`err.message`).
fn db_message(error: &DbErr) -> String {
    match error {
        DbErr::Conn(inner) | DbErr::Exec(inner) | DbErr::Query(inner) => inner.to_string(),
        other => other.to_string(),
    }
}

/// `integration_connections`, written from a body's columns.
const INTEGRATION_CONNECTIONS: JsonTable = JsonTable::of::<connections::Entity>();

/// A row as Drizzle returned it.
fn js<M: serde::Serialize>(model: M) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// The connection row, not deleted.
pub(crate) async fn connection_row(db: &PgPool, id: &str) -> Result<Option<Model>, DbErr> {
    connections::Entity::find_by_id(id.to_owned())
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

/// `tokens.accessToken` of a connection's `oauth_tokens`.
fn access_token(connection: &Model) -> Option<&Value> {
    connection
        .oauth_tokens
        .as_ref()
        .and_then(|tokens| tokens.get("accessToken"))
}

/// `{ ...connection, oauthTokens: undefined, webhookSecret: undefined }`.
fn sanitized(row: Model) -> Value {
    let mut row = js(row);
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

/// `upsertCrmIndex(..., dueNow: true)`: Global schedules the connection in
/// the D1 `crm_sync_index`; the Kubernetes editions mark the workspace due
/// in the master `workspace_due_index` (kind `crm_sync`), which the
/// `crm-due` cron reads (`weldsuite_integrations::crm::due`). Best effort,
/// and only with the app's own master database (conformance builds have
/// none, as Global's tests bind no D1 index).
async fn mark_crm_due(master: Option<&PgPool>, workspace_id: &str) {
    if let Some(master) = master {
        weldsuite_db::due_index::mark_due(
            master,
            CRM_SYNC_DUE_KIND,
            workspace_id,
            time::OffsetDateTime::now_utc(),
        )
        .await;
    }
}

/// The `workspace_due_index` kind of the CRM syncs (the same as
/// `weldsuite_integrations::crm::due::CRM_SYNC_DUE_KIND`).
const CRM_SYNC_DUE_KIND: &str = "crm_sync";

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
    /// The provider is outside the EU and the workspace hasn't switched it
    /// on (ADR OPS-026): 403.
    OutsideEu(weldsuite_outside_eu::OutsideEuError),
}

impl From<DbErr> for ActionError {
    fn from(error: DbErr) -> Self {
        Self::Thrown(db_message(&error))
    }
}

/// ADR OPS-026: Attio, `HubSpot` and Google Calendar are outside the EU, so
/// on the EU edition a workspace connects, syncs and calls them only once it
/// has switched the company on. `provider` is the connection's (`attio`,
/// `hubspot`, `google_calendar`; MCP servers and unknown providers pass).
#[allow(clippy::result_large_err)] // the refusal is answered as it is
pub(crate) async fn outside_eu(db: &PgPool, provider: &str) -> Result<(), Response> {
    weldsuite_outside_eu::require_integration(db, provider)
        .await
        .map_err(|error| error.to_api_error().into_response())
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
    let stamp = utc_now();
    let Some(connection) = connection_row(db, connection_id).await? else {
        return Err(ActionError::NotFound);
    };
    weldsuite_outside_eu::require_integration(db, &connection.provider)
        .await
        .map_err(ActionError::OutsideEu)?;
    // `now - updated_at < STALE_SYNC_MINUTES`.
    let fresh = stamp - connection.updated_at < time::Duration::minutes(STALE_SYNC_MINUTES);
    if connection.status == "syncing" {
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
    if !access_token(&connection).is_some_and(truthy) {
        return Err(ActionError::Other("No access token available".to_owned()));
    }
    connections::Entity::update_many()
        .col_expr(Column::Status, Expr::value("syncing"))
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(connection_id))
        .exec(&orm(db))
        .await?;
    trigger_crm_sync(
        runs,
        connection_id,
        clerk_org_id,
        &connection.provider,
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
    /// `APP_API_PUBLIC_URL`: this server's public origin (Kubernetes).
    pub(crate) public_url: Option<String>,
}

/// `renewGoogleCalendarWatch`: refresh the token when possible, stop the old
/// channel, register a new one and keep its id and secret.
pub(crate) async fn renew_google_calendar_watch(
    db: &PgPool,
    renewal: WatchRenewal<'_>,
    connection_id: &str,
) -> Result<&'static str, ActionError> {
    let pool = db;
    let db = orm(pool);
    let connection = connections::Entity::find_by_id(connection_id.to_owned())
        .filter(Column::Provider.eq("google_calendar"))
        .filter(Column::DeletedAt.is_null())
        .one(&db)
        .await?;
    let Some(connection) = connection else {
        return Err(ActionError::NotFound);
    };
    weldsuite_outside_eu::require(pool, weldsuite_outside_eu::ServiceId::Google)
        .await
        .map_err(ActionError::OutsideEu)?;
    let tokens = connection.oauth_tokens.as_ref().unwrap_or(&Value::Null);
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
            connections::Entity::update_many()
                .col_expr(Column::OauthTokens, Expr::value(fresh.to_json()))
                .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
                .filter(Column::Id.eq(connection_id))
                .exec(&db)
                .await?;
        }
    }
    if let Some(webhook_id) = connection.webhook_id.as_deref().filter(|w| !w.is_empty())
        && let Err(error) = adapter
            .delete_webhooks(
                renewal.http,
                &access_token,
                webhook_id,
                connection
                    .webhook_secret
                    .as_deref()
                    .filter(|s| !s.is_empty()),
            )
            .await
    {
        tracing::warn!(%error, "[Integrations] Failed to stop old watch channel");
    }
    let target = format!(
        "{}/webhook/gcal/{connection_id}",
        webhook_worker_url(
            renewal.public_url.as_deref(),
            renewal.environment.as_deref()
        )
    );
    let registration = adapter
        .register_webhooks(renewal.http, &access_token, &target)
        .await
        .map_err(ActionError::Thrown)?;
    connections::Entity::update_many()
        .col_expr(Column::WebhookId, Expr::value(&registration.webhook_id))
        .col_expr(Column::WebhookSecret, Expr::value(&registration.secret))
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(connection_id))
        .exec(&db)
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
        Err(ActionError::OutsideEu(error)) => error.to_api_error().into_response(),
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
    let cursor_row: Option<(PrimitiveDateTime, String)> = match &cursor {
        Some(cursor) => match connections::Entity::find()
            .select_only()
            .columns([Column::CreatedAt, Column::Id])
            .filter(Column::Id.eq(cursor))
            .limit(1)
            .into_tuple()
            .one(&orm(&caller.db))
            .await
        {
            Ok(row) => row,
            Err(error) => return internal_error(&error, "Failed to list integrations"),
        },
        None => None,
    };
    let filtered = || -> Select<connections::Entity> {
        let mut filter = Condition::all().add(Column::DeletedAt.is_null());
        if let Some(provider) = &provider {
            filter = filter.add(Column::Provider.eq(provider));
        }
        if let Some(status) = &status {
            filter = filter.add(Column::Status.eq(status));
        }
        connections::Entity::find().filter(filter)
    };
    let db = orm(&caller.db);
    let mut rows = filtered();
    if let Some((at, id)) = cursor_row {
        rows = rows.filter(
            Condition::any().add(Column::CreatedAt.lt(at)).add(
                Condition::all()
                    .add(Column::CreatedAt.eq(at))
                    .add(Column::Id.lt(id)),
            ),
        );
    }
    let rows = rows
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await;
    let count = filtered().count(&db).await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(js).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal_error(&error, "Failed to list integrations"),
    }
}

async fn get_integration(caller: Caller, Path(id): Path<String>) -> Response {
    match connection_row(&caller.db, &id).await {
        Ok(Some(row)) => Data(js(row)).into_response(),
        Ok(None) => ApiError::not_found("Integration", Some(&id)).into_response(),
        Err(error) => internal_error(&error, "Failed to fetch integration"),
    }
}

/// `integration_connections`' columns, `camelCase` → `snake_case`: the keys a
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
    // Every column is written: the ones the record leaves out are NULL.
    for (_, column) in COLUMNS {
        record.entry(*column).or_insert(Value::Null);
    }
    let inserted = INTEGRATION_CONNECTIONS
        .insert(&orm(&caller.db), record)
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
    let result: Result<Response, DbErr> = async {
        if connection_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Integration", Some(&id)).into_response());
        }
        let mut patch = column_values(&data);
        patch.insert("updated_at".to_owned(), json!(now()));
        write_patch(&caller.db, &id, patch).await?;
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal_error(&error, FAILED))
}

/// `db.update(integrationConnections).set({ ...data, updatedAt })` over the
/// live row `id`: every column the patch names, `id` included.
#[allow(
    clippy::disallowed_methods,
    reason = "the passthrough body may rewrite any column, `id` included, which `JsonTable::update` never does: every column set from `jsonb_populate_record` over the row itself"
)]
async fn write_patch(db: &PgPool, id: &str, patch: Map<String, Value>) -> Result<(), DbErr> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "update integration_connections t set ({ALL_COLUMNS}) =
             (select {ALL_FROM_R} from jsonb_populate_record(t, $2::jsonb) r)
         where t.id = $1 and t.deleted_at is null"
    )))
    .bind(id)
    .bind(Value::Object(patch))
    .execute(db)
    .await
    .map_err(orm_error)?;
    Ok(())
}

async fn delete_integration(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, DbErr> = async {
        if connection_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Integration", Some(&id)).into_response());
        }
        let stamp = utc_now();
        connections::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal_error(&error, "Failed to delete integration"))
}

// ── Connections ─────────────────────────────────────────────────────────────

async fn list_connections(caller: Caller) -> Response {
    let rows = connections::Entity::find()
        .filter(Column::DeletedAt.is_null())
        .order_by_desc(Column::CreatedAt)
        .all(&orm(&caller.db))
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
    let inserted = connections::Entity::insert(connections::ActiveModel {
        id: Set(id.clone()),
        provider: Set(provider.clone()),
        name: Set(Some(name.clone())),
        status: Set("active".to_owned()),
        direction: Set("bidirectional".to_owned()),
        settings: Set(Some(Value::Object(settings))),
        oauth_tokens: Set(tokens),
        connected_at: Set(Some(utc_now())),
        connected_by: Set(Some(caller.user_id.clone())),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
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
    let result: Result<Response, DbErr> = async {
        let Some(row) = connection_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Connection", Some(&id)).into_response());
        };
        let logs = sync_logs::Entity::find()
            .filter(sync_logs::Column::ConnectionId.eq(&id))
            .order_by_desc(sync_logs::Column::CreatedAt)
            .limit(20)
            .all(&orm(&caller.db))
            .await?;
        let mut detail = sanitized(row);
        detail["recentLogs"] = Value::Array(logs.into_iter().map(js).collect());
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
    let result: Result<Response, DbErr> = async {
        let Some(connection) = connection_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Connection", Some(&id)).into_response());
        };
        let entity_config = patch
            .entity_config
            .as_ref()
            .map(|p| merged(connection.entity_config.as_ref(), p));
        let settings = patch
            .settings
            .as_ref()
            .map(|p| merged(connection.settings.as_ref(), p));
        let sync_settings = patch
            .sync_settings
            .as_ref()
            .map(|p| merged(connection.sync_settings.as_ref(), p));
        // `accessToken ? { accessToken } : null` when it was sent.
        let tokens = patch.access_token.as_ref().map(|token| {
            if token.is_empty() {
                Value::Null
            } else {
                json!({ "accessToken": token })
            }
        });
        let mut update =
            connections::Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        if let Some(name) = patch.name.filter(|n| !n.is_empty()) {
            update = update.col_expr(Column::Name, Expr::value(name));
        }
        if let Some(direction) = patch.direction.filter(|d| !d.is_empty()) {
            update = update.col_expr(Column::Direction, Expr::value(direction));
        }
        if let Some(entity_config) = entity_config {
            update = update.col_expr(Column::EntityConfig, Expr::value(entity_config));
        }
        if let Some(settings) = settings {
            update = update.col_expr(Column::Settings, Expr::value(settings));
        }
        if let Some(tokens) = tokens {
            let tokens = Some(tokens).filter(|t| !t.is_null());
            update = update.col_expr(Column::OauthTokens, Expr::value(tokens));
        }
        if let Some(sync_settings) = sync_settings {
            update = update.col_expr(Column::SyncSettings, Expr::value(sync_settings));
        }
        update
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
        let token = access_token(&connection)
            .filter(|t| truthy(t))
            .map(|t| crate::js::js_string(Some(t)));
        let webhook_id = connection.webhook_id.as_deref().filter(|w| !w.is_empty());
        let provider = Provider::of(&connection.provider);
        // A provider outside the EU the workspace has switched off is not
        // called, not even to remove its webhooks (ADR OPS-026).
        let reachable = outside_eu(&caller.db, &connection.provider).await.is_ok();
        if let (Some(token), Some(webhook_id), Some(provider), true) =
            (token, webhook_id, provider, reachable)
            && let Err(error) = provider
                .delete_webhooks(
                    &caller.http(&state),
                    &token,
                    webhook_id,
                    connection
                        .webhook_secret
                        .as_deref()
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
        let stamp = utc_now();
        connections::Entity::update_many()
            .col_expr(Column::Status, Expr::value("inactive"))
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
        out.push_str(",\"provider\":");
        out.push_str(&json!(provider).to_string());
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
    if let Err(refusal) = outside_eu(&caller.db, "attio").await {
        return refusal;
    }
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
    if let Err(refusal) = outside_eu(&caller.db, &provider).await {
        return refusal;
    }
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

async fn insert_connection(db: &PgPool, c: NewConnection<'_>) -> Result<(), DbErr> {
    connections::Entity::insert(connections::ActiveModel {
        id: Set(c.id.to_owned()),
        provider: Set(c.provider.to_owned()),
        name: Set(Some(c.name.to_owned())),
        status: Set("active".to_owned()),
        direction: Set(c.direction.to_owned()),
        external_account_id: Set(c.external_account_id),
        oauth_tokens: Set(Some(c.tokens.to_json())),
        webhook_id: Set(Some(c.webhook_id.to_owned())),
        webhook_secret: Set(Some(c.webhook_secret.to_owned())),
        settings: Set(c.settings),
        sync_settings: Set(Some(c.sync_settings)),
        connected_at: Set(Some(utc_now())),
        connected_by: Set(Some(c.connected_by.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
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
    if let Err(refusal) = outside_eu(&caller.db, "attio").await {
        return refusal;
    }
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
        let public_url = caller.overrides.env(&state, "APP_API_PUBLIC_URL");
        let target = format!(
            "{}/webhook/{id}",
            webhook_worker_url(public_url.as_deref(), environment.as_deref())
        );
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
        .map_err(|error| thrown(db_message(&error)))?;
        put_connection_mapping(&cache, &id, &caller.workspace_id, "attio").await?;
        mark_crm_due(state.master.as_ref(), &caller.workspace_id).await;
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
    if let Err(refusal) = outside_eu(&caller.db, &provider).await {
        return refusal;
    }
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
        let public_url = caller.overrides.env(&state, "APP_API_PUBLIC_URL");
        let target = format!(
            "{}/webhook/{path}",
            webhook_worker_url(public_url.as_deref(), environment.as_deref())
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
            calendars::Entity::insert(calendars::ActiveModel {
                id: Set(calendar_id.clone()),
                name: Set("Google Calendar".to_owned()),
                color: Set(Some("#4285f4".to_owned())),
                owner_id: Set(connected_by.clone()),
                is_default: Set(Some(false)),
                ..Default::default()
            })
            .exec_without_returning(&orm(&caller.db))
            .await
            .map_err(|error| thrown(db_message(&error)))?;
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
        .map_err(|error| thrown(db_message(&error)))?;
        if !calendar {
            insert_default_mappings(&caller.db, adapter, &id)
                .await
                .map_err(|error| thrown(db_message(&error)))?;
        }
        put_connection_mapping(&cache, &id, &caller.workspace_id, &provider).await?;
        mark_crm_due(state.master.as_ref(), &caller.workspace_id).await;
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
) -> Result<(), DbErr> {
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

/// `r->>'key'` of a mapping built as JSON (`jsonb_to_recordset`'s `text`):
/// a string as it is, null or missing as NULL, anything else as its JSON
/// text.
fn row_text(row: &Value, key: &str) -> Option<String> {
    match row.get(key)? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

/// A NOT NULL column of a mapping row: the insert fails without it, as the
/// column refuses the NULL `jsonb_to_recordset` reads.
fn required<T>(value: Option<T>, column: &str) -> Result<T, DbErr> {
    value.ok_or_else(|| DbErr::Custom(format!("integration_field_mappings.{column} is null")))
}

/// One `integration_field_mappings` row from its `snake_case` object.
fn mapping_row(
    connection_id: &str,
    row: &Value,
    is_default: bool,
) -> Result<integration_field_mappings::ActiveModel, DbErr> {
    let flag = row.get("is_required").and_then(Value::as_bool);
    let position = row
        .get("position")
        .and_then(Value::as_i64)
        .and_then(|p| i32::try_from(p).ok());
    Ok(integration_field_mappings::ActiveModel {
        id: Set(required(row_text(row, "id"), "id")?),
        connection_id: Set(connection_id.to_owned()),
        entity_type: Set(required(row_text(row, "entity_type"), "entity_type")?),
        external_field_path: Set(required(
            row_text(row, "external_field_path"),
            "external_field_path",
        )?),
        internal_field_path: Set(required(
            row_text(row, "internal_field_path"),
            "internal_field_path",
        )?),
        direction: Set(required(row_text(row, "direction"), "direction")?),
        transform_type: Set(required(row_text(row, "transform_type"), "transform_type")?),
        transform_config: Set(row
            .get("transform_config")
            .filter(|c| !c.is_null())
            .cloned()),
        is_required: Set(required(flag, "is_required")?),
        is_default: Set(is_default),
        position: Set(required(position, "position")?),
        ..Default::default()
    })
}

/// Multi-row insert of `integration_field_mappings` (`snake_case` objects).
async fn insert_mappings(
    db: &PgPool,
    connection_id: &str,
    rows: &[Value],
    is_default: bool,
) -> Result<(), DbErr> {
    if rows.is_empty() {
        return Ok(());
    }
    let rows = rows
        .iter()
        .map(|row| mapping_row(connection_id, row, is_default))
        .collect::<Result<Vec<_>, _>>()?;
    integration_field_mappings::Entity::insert_many(rows)
        .exec_without_returning(&orm(db))
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
        if connection.provider != "mcp_server" {
            return Err(Refusal::bad_request(
                "Tool discovery is only supported for MCP server integrations",
            ));
        }
        let settings = match &connection.settings {
            Some(Value::Object(map)) => map.clone(),
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
        let token = access_token(&connection)
            .filter(|t| truthy(t))
            .map(|t| crate::js::js_string(Some(t)));
        let auth_type = settings.get("authType").and_then(Value::as_str);
        if let Some(token) = &token {
            match auth_type {
                Some("bearer") => {
                    request = request.header("Authorization", format!("Bearer {token}"));
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
        connections::Entity::update_many()
            .col_expr(Column::Settings, Expr::value(Value::Object(next)))
            .col_expr(Column::Status, Expr::value("active"))
            .col_expr(Column::LastError, Expr::value(Option::<String>::None))
            .col_expr(
                Column::LastErrorAt,
                Expr::value(Option::<PrimitiveDateTime>::None),
            )
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
    let result: Result<Response, DbErr> = async {
        let Some(connection) = connection_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Connection", Some(&id)).into_response());
        };
        if connection.provider != "mcp_server" {
            return Ok(Data(
                json!({ "connected": true, "message": "Test not implemented for this provider" }),
            )
            .into_response());
        }
        let Some(url) = connection
            .settings
            .as_ref()
            .and_then(|settings| settings.get("url"))
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
                let stamp = utc_now();
                connections::Entity::update_many()
                    .col_expr(
                        Column::Status,
                        Expr::value(if connected { "active" } else { "error" }),
                    )
                    .col_expr(
                        Column::LastError,
                        Expr::value((!connected).then(|| format!("HTTP {}", response.status))),
                    )
                    .col_expr(
                        Column::LastErrorAt,
                        Expr::value((!connected).then_some(stamp)),
                    )
                    .col_expr(Column::UpdatedAt, Expr::value(stamp))
                    .filter(Column::Id.eq(&id))
                    .exec(&orm(&caller.db))
                    .await?;
                Ok(
                    Data(json!({ "connected": connected, "status": response.status }))
                        .into_response(),
                )
            }
            Err(error) => {
                let message = error.to_string();
                let stamp = utc_now();
                connections::Entity::update_many()
                    .col_expr(Column::Status, Expr::value("error"))
                    .col_expr(Column::LastError, Expr::value(&message))
                    .col_expr(Column::LastErrorAt, Expr::value(stamp))
                    .col_expr(Column::UpdatedAt, Expr::value(stamp))
                    .filter(Column::Id.eq(&id))
                    .exec(&orm(&caller.db))
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
        public_url: caller.overrides.env(&state, "APP_API_PUBLIC_URL"),
    };
    let result = renew_google_calendar_watch(&caller.db, renewal, &id).await;
    action_response(result, &id, false, "Failed to renew watch channel")
}

// ── Logs, field mappings, conflicts, entity mappings ────────────────────────

async fn logs(caller: Caller, Path(id): Path<String>) -> Response {
    let rows = sync_logs::Entity::find()
        .filter(sync_logs::Column::ConnectionId.eq(&id))
        .order_by_desc(sync_logs::Column::CreatedAt)
        .limit(50)
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js).collect::<Vec<_>>()).into_response(),
        Err(error) => internal_error(&error, "Failed to fetch sync logs"),
    }
}

async fn field_mappings(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let entity_type = query_truthy(query.as_deref(), "entityType");
    use integration_field_mappings::Column as Mapping;
    let mut rows = integration_field_mappings::Entity::find().filter(Mapping::ConnectionId.eq(&id));
    if let Some(entity_type) = &entity_type {
        rows = rows.filter(Mapping::EntityType.eq(entity_type));
    }
    let rows = rows.all(&orm(&caller.db)).await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js).collect::<Vec<_>>()).into_response(),
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
    let result: Result<Response, DbErr> = async {
        let Some(connection) = connection_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Connection", Some(&id)).into_response());
        };
        let provider = connection.provider.as_str();
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
) -> Result<(), DbErr> {
    use integration_field_mappings::Column as Mapping;
    integration_field_mappings::Entity::delete_many()
        .filter(Mapping::ConnectionId.eq(id))
        .filter(Mapping::EntityType.eq(entity_type))
        .exec(&orm(db))
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
    let result: Result<Response, DbErr> = async {
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
    use integration_sync_conflicts::Column as Conflict;
    let mut rows = integration_sync_conflicts::Entity::find()
        .filter(Conflict::ConnectionId.eq(&id))
        .filter(Conflict::Resolution.eq(&resolution));
    if let Some(entity_type) = &entity_type {
        rows = rows.filter(Conflict::EntityType.eq(entity_type));
    }
    let rows = rows
        .order_by_desc(Conflict::CreatedAt)
        .limit(100)
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js).collect::<Vec<_>>()).into_response(),
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
    use integration_sync_conflicts::Column as Conflict;
    let updated = integration_sync_conflicts::Entity::update_many()
        .col_expr(Conflict::Resolution, Expr::value(&resolution))
        .col_expr(Conflict::ResolvedAt, Expr::value(utc_now()))
        .col_expr(Conflict::ResolvedBy, Expr::value(&caller.user_id))
        .filter(Conflict::Id.eq(&conflict_id))
        .exec(&orm(&caller.db))
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
    use integration_sync_conflicts::Column as Conflict;
    let mut update = integration_sync_conflicts::Entity::update_many()
        .col_expr(Conflict::Resolution, Expr::value(&resolution))
        .col_expr(Conflict::ResolvedAt, Expr::value(utc_now()))
        .col_expr(Conflict::ResolvedBy, Expr::value(&caller.user_id))
        .filter(Conflict::ConnectionId.eq(&id))
        .filter(Conflict::Resolution.eq("pending"));
    if let Some(entity_type) = entity_type.filter(|e| !e.is_empty()) {
        update = update.filter(Conflict::EntityType.eq(entity_type));
    }
    let updated = update.exec(&orm(&caller.db)).await;
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
    use integration_entity_mappings::Column as Mapped;
    let rows = integration_entity_mappings::Entity::find()
        .filter(Mapped::InternalEntityType.eq(&entity_type))
        .filter(Mapped::InternalEntityId.eq(&entity_id))
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js).collect::<Vec<_>>()).into_response(),
        Err(error) => internal_error(&error, "Failed to fetch entity mappings"),
    }
}
