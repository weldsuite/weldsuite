//! `/api/workflow-integrations` (`routes/workflow-integrations/index.ts`,
//! `oauth.ts`, `services/workflow-integrations/*`): the third-party
//! connections WeldConnect steps use (Slack, Google Sheets/Gmail/Calendar,
//! GitHub through the WeldFlow App installation, API-key providers), their
//! OAuth flow, connection tests and the step forms' pickers. Credentials and
//! tokens never leave the server.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_INTEGRATION_CREATED, WORKFLOW_INTEGRATION_DELETED, WORKFLOW_INTEGRATION_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{Keyring, PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, HttpRequest, OutboundHttp};

use crate::catalog::{integration, integrations};
use crate::crypto::{maybe_decrypt, seal_if_keyed};
use crate::github_app::{AppCredentials, installation_token, list_available_repos};
use crate::js::{next_cursor, page, page_limit, query_truthy, total};
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

const GOOGLE_TYPES: &[&str] = &["google_sheets", "gmail", "google_calendar"];
const STATE_TTL: Duration = Duration::from_secs(600);

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::INTEGRATIONS_READ]);
    let update = || gate.require([perm::INTEGRATIONS_UPDATE]);
    Router::new()
        .route("/catalog", get(catalog).route_layer(read()))
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([perm::INTEGRATIONS_CREATE])),
        )
        .route("/categories", get(categories).route_layer(read()))
        .route("/{id}", get(get_one).route_layer(read()))
        .route(
            "/{id}",
            axum::routing::put(update_route)
                .patch(update_route)
                .route_layer(update()),
        )
        .route(
            "/{id}",
            axum::routing::delete(delete).route_layer(gate.require([perm::INTEGRATIONS_DELETE])),
        )
        .route("/{id}/connect", patch(connect).route_layer(update()))
        .route("/{id}/disconnect", patch(disconnect).route_layer(update()))
        .route(
            "/{id}/test",
            post(test).route_layer(gate.require([perm::INTEGRATIONS_CREATE])),
        )
        .route(
            "/{id}/slack/channels",
            get(slack_channels).route_layer(read()),
        )
        .route("/{id}/github/repos", get(github_repos).route_layer(read()))
        .route(
            "/{id}/google_sheets/spreadsheet",
            get(google_spreadsheet).route_layer(read()),
        )
        .route(
            "/{id}/google_calendar/calendars",
            get(google_calendars).route_layer(read()),
        )
        .route("/{id}/authorize", post(authorize).route_layer(update()))
        .route("/{id}/callback", post(callback).route_layer(update()))
        .route("/{id}/apikey", post(apikey).route_layer(update()))
        .route("/{id}/link", post(link).route_layer(update()))
}

impl Caller {
    pub(crate) fn keyring(&self, state: &ConnectState) -> Keyring {
        let key = |name: &str| self.overrides.env(state, name).filter(|v| !v.is_empty());
        Keyring {
            v1: key("DATABASE_ENCRYPTION_KEY"),
            v2: key("DATABASE_ENCRYPTION_KEY_V2"),
        }
    }

    /// Third-party HTTP, or a client that can't connect.
    pub(crate) fn http(&self, state: &ConnectState) -> OutboundHttp {
        self.overrides
            .http(state)
            .unwrap_or_else(|| OutboundHttp(Arc::new(crate::Unreachable)))
    }

    /// Whether this request may cache third-party tokens in the process
    /// (not in conformance runs, which carry their own HTTP stub).
    pub(crate) fn caches_tokens(&self) -> bool {
        self.overrides.http.is_none()
    }

    /// `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`.
    pub(crate) fn github_app(&self, state: &ConnectState) -> Option<AppCredentials> {
        let app_id = self
            .overrides
            .env(state, "GITHUB_APP_ID")
            .filter(|v| !v.is_empty())?;
        let private_key = self
            .overrides
            .env(state, "GITHUB_APP_PRIVATE_KEY")
            .filter(|v| !v.is_empty())?;
        Some(AppCredentials {
            app_id,
            private_key,
        })
    }
}

async fn catalog() -> Response {
    Data(integrations()).into_response()
}

/// `stripCredentials(row)`.
fn strip(mut row: Value) -> Value {
    if let Value::Object(map) = &mut row {
        let has_credentials = map.remove("credentials").is_some_and(|v| !v.is_null());
        let has_tokens = map.remove("oauthTokens").is_some_and(|v| !v.is_null());
        map.insert("hasCredentials".into(), json!(has_credentials));
        map.insert("hasOauthTokens".into(), json!(has_tokens));
    }
    row
}

async fn integration_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from workflow_integrations t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(integration_js_row))
}

/// A `workflow_integrations` row as Drizzle reads it: `is_oauth` is the
/// property `isOAuth`, not the camel case of its column.
fn integration_js_row(row: Value) -> Value {
    let mut row = js_row(row);
    if let Value::Object(map) = &mut row
        && let Some(value) = map.remove("isOauth")
    {
        map.insert("isOAuth".into(), value);
    }
    row
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let search = query_truthy(query, "search").map(|s| format!("%{s}%"));
    let category = query_truthy(query, "category");
    let status = query_truthy(query, "status");
    let kind = query_truthy(query, "type");
    let cursor = query_truthy(query, "cursor");
    const FILTER: &str = "t.deleted_at is null and ($1::text is null or t.name like $1)
        and ($2::text is null or t.category = $2) and ($3::text is null or t.status = $3)
        and ($4::text is null or t.type = $4)";
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from workflow_integrations t where {FILTER} and ($5::text is null or t.id < $5)
         order by t.updated_at desc, t.id desc limit $6"
    )))
    .bind(&search)
    .bind(&category)
    .bind(&status)
    .bind(&kind)
    .bind(&cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from workflow_integrations t where {FILTER}"
    )))
    .bind(&search)
    .bind(&category)
    .bind(&status)
    .bind(&kind)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(
                rows.into_iter()
                    .map(integration_js_row)
                    .map(strip)
                    .collect(),
                limit,
            );
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => {
            internal(&error, "Failed to list workflow integrations")
        }
    }
}

async fn categories(caller: Caller) -> Response {
    let rows: Result<Vec<Option<String>>, sqlx::Error> =
        sqlx::query_scalar("select category from workflow_integrations where deleted_at is null")
            .fetch_all(&caller.db)
            .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return internal(&error, "Failed to fetch integration categories"),
    };
    let mut counts: Vec<(String, i64)> = Vec::new();
    for category in rows {
        let key = category
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "custom".into());
        match counts.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 += 1,
            None => counts.push((key, 1)),
        }
    }
    let data: Vec<Value> = counts
        .into_iter()
        .map(|(id, count)| {
            let mut chars = id.chars();
            let name = match chars.next() {
                Some(first) => format!(
                    "{}{}",
                    first.to_uppercase(),
                    chars.as_str().replace('_', " ")
                ),
                None => String::new(),
            };
            json!({ "id": id, "name": name, "count": count })
        })
        .collect();
    Data(data).into_response()
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    match integration_row(&caller.db, &id).await {
        Ok(Some(row)) => Data(strip(row)).into_response(),
        Ok(None) => ApiError::not_found("Integration", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch integration"),
    }
}

/// `createIntegrationSchema` (`partial` for the update).
struct IntegrationBody {
    name: Field<String>,
    description: Field<String>,
    kind: Field<String>,
    category: Field<String>,
    icon: Field<String>,
    credentials: Field<Value>,
    settings: Field<Value>,
    is_oauth: Field<bool>,
    oauth_provider: Field<String>,
}

fn record(issues: &mut Issues, b: &Map<String, Value>, key: &str) -> Field<Value> {
    issues.nested(b, key, Presence::Optional, |_, fields| {
        Value::Object(fields.clone())
    })
}

fn integration_body(issues: &mut Issues, b: &Map<String, Value>, partial: bool) -> IntegrationBody {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let name = issues.text(b, "name", required, Some(1), Some(255));
    let description = issues.text(b, "description", Presence::Optional, None, None);
    let mut kind = issues.text(b, "type", Presence::Optional, None, None);
    if !partial && !b.contains_key("type") {
        kind = Field::Set("custom".into());
    }
    IntegrationBody {
        name,
        description,
        kind,
        category: issues.text(b, "category", Presence::Optional, None, None),
        icon: issues.text(b, "icon", Presence::Optional, None, None),
        credentials: record(issues, b, "credentials"),
        settings: record(issues, b, "settings"),
        is_oauth: issues.boolean(b, "isOAuth", Presence::Optional),
        oauth_provider: issues.text(b, "oauthProvider", Presence::Optional, None, None),
    }
}

async fn create(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| {
        integration_body(issues, b, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create integration"),
    };
    let result = async {
        let id = generate_id("int");
        let stamp = now();
        let name = data.name.as_set().cloned().unwrap_or_default();
        let kind = data
            .kind
            .as_set()
            .cloned()
            .unwrap_or_else(|| "custom".into());
        sqlx::query(
            "insert into workflow_integrations
                (id, name, description, type, category, icon, credentials, settings, is_oauth,
                 oauth_provider, status, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'disconnected', $11::timestamp, $11::timestamp)",
        )
        .bind(&id)
        .bind(&name)
        .bind(data.description.as_set())
        .bind(&kind)
        .bind(data.category.as_set())
        .bind(data.icon.as_set())
        .bind(data.credentials.as_set())
        .bind(data.settings.as_set())
        .bind(data.is_oauth.as_set().copied().unwrap_or(false))
        .bind(data.oauth_provider.as_set())
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        let row = integration_row(&caller.db, &id)
            .await?
            .unwrap_or(Value::Null);
        let mut event = json!({ "id": id, "name": name, "type": kind });
        if let Some(category) = data.category.as_set() {
            event["category"] = json!(category);
        }
        caller.publish(&state, WORKFLOW_INTEGRATION_CREATED, &id, &event);
        Ok::<_, sqlx::Error>(Created(strip(row)).into_response())
    };
    result
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to create integration"))
}

async fn update_route(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| {
        integration_body(issues, b, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update integration"),
    };
    let result = async {
        if integration_row(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Integration", &id));
        }
        sqlx::query(
            "update workflow_integrations set updated_at = $2::timestamp,
                name = case when $3 then $4 else name end,
                description = case when $5 then $6 else description end,
                category = case when $7 then $8 else category end,
                icon = case when $9 then $10 else icon end,
                credentials = case when $11 then $12 else credentials end,
                settings = case when $13 then $14 else settings end,
                type = case when $15 then $16 else type end,
                is_oauth = case when $17 then $18 else is_oauth end,
                oauth_provider = case when $19 then $20 else oauth_provider end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(!data.name.is_absent())
        .bind(data.name.as_set())
        .bind(!data.description.is_absent())
        .bind(data.description.as_set())
        .bind(!data.category.is_absent())
        .bind(data.category.as_set())
        .bind(!data.icon.is_absent())
        .bind(data.icon.as_set())
        .bind(!data.credentials.is_absent())
        .bind(data.credentials.as_set())
        .bind(!data.settings.is_absent())
        .bind(data.settings.as_set())
        .bind(!data.kind.is_absent())
        .bind(data.kind.as_set())
        .bind(!data.is_oauth.is_absent())
        .bind(data.is_oauth.as_set().copied())
        .bind(!data.oauth_provider.is_absent())
        .bind(data.oauth_provider.as_set())
        .execute(&caller.db)
        .await?;
        let row = integration_row(&caller.db, &id)
            .await?
            .unwrap_or(Value::Null);
        caller.publish(
            &state,
            WORKFLOW_INTEGRATION_UPDATED,
            &id,
            &json!({ "id": id }),
        );
        Ok(Data(strip(row)).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to update integration"))
}

async fn connect(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let credentials = match validate(&headers, &body, |issues, b| {
        record(issues, b, "credentials").into_option()
    }) {
        Ok(credentials) => credentials,
        Err(refusal) => return refusal.respond("Failed to connect integration"),
    };
    let result = async {
        if integration_row(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Integration", &id));
        }
        sqlx::query(
            "update workflow_integrations set status = 'connected', connected_at = $2::timestamp,
                connected_by = $3, updated_at = $2::timestamp,
                credentials = case when $4::jsonb is not null then $4 else credentials end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(&caller.user_id)
        .bind(&credentials)
        .execute(&caller.db)
        .await?;
        caller.publish(
            &state,
            WORKFLOW_INTEGRATION_UPDATED,
            &id,
            &json!({ "id": id, "status": "connected" }),
        );
        Ok(Data(json!({ "id": id, "status": "connected" })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to connect integration"))
}

/// `c.env.WORKSPACE_CACHE`, which the OAuth flows require.
fn kv(caller: &Caller, state: &ConnectState) -> Result<Arc<dyn DynCache>, Refusal> {
    caller.overrides.kv(state).ok_or_else(|| {
        Refusal::Database(sqlx::Error::Protocol("WORKSPACE_CACHE is not bound".into()))
    })
}

async fn disconnect(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = integration_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Integration", &id));
        };
        sqlx::query("update workflow_integrations set status = 'disconnected', updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
        let cache = kv(&caller, &state)?;
        let gone = |error: weldsuite_ports::PortError| {
            Refusal::Database(sqlx::Error::Protocol(error.to_string()))
        };
        cache
            .delete_boxed(&format!("intconn:{id}"))
            .await
            .map_err(gone)?;
        if let Some(team) = existing["settings"]["teamId"]
            .as_str()
            .filter(|t| !t.is_empty())
        {
            cache
                .delete_boxed(&format!("slack_team:{team}"))
                .await
                .map_err(gone)?;
        }
        caller.publish(
            &state,
            WORKFLOW_INTEGRATION_UPDATED,
            &id,
            &json!({ "id": id, "status": "disconnected" }),
        );
        Ok(Data(json!({ "id": id, "status": "disconnected" })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to disconnect integration"))
}

/// A provider call's body as JSON (`await res.json()`, which throws on
/// anything else).
fn json_of(response: &weldsuite_ports::HttpResponse) -> Result<Value, String> {
    serde_json::from_slice(&response.body).map_err(|error| error.to_string())
}

/// `testSlackAuth(token)`.
async fn slack_auth_test(http: &OutboundHttp, token: &str) -> Result<(bool, String), String> {
    let response = http
        .send(
            HttpRequest::empty("POST", "https://slack.com/api/auth.test")
                .header("Authorization", format!("Bearer {token}")),
        )
        .await
        .map_err(|error| error.to_string())?;
    let body = json_of(&response)?;
    let ok = body["ok"].as_bool().unwrap_or(false);
    let message = if ok {
        format!("Connected to {}", body["team"].as_str().unwrap_or("Slack"))
    } else {
        body["error"]
            .as_str()
            .unwrap_or("auth.test failed")
            .to_owned()
    };
    Ok((ok, message))
}

/// `testGoogleAuth(token)`.
async fn google_auth_test(http: &OutboundHttp, token: &str) -> Result<(bool, String), String> {
    let response = http
        .send(
            HttpRequest::empty("GET", "https://www.googleapis.com/oauth2/v3/userinfo")
                .header("Authorization", format!("Bearer {token}")),
        )
        .await
        .map_err(|error| error.to_string())?;
    if !response.ok() {
        return Ok((false, format!("userinfo returned {}", response.status)));
    }
    let body = json_of(&response)?;
    Ok((
        true,
        match body["email"].as_str().filter(|e| !e.is_empty()) {
            Some(email) => format!("Connected as {email}"),
            None => "Google token valid".to_owned(),
        },
    ))
}

/// The installation id stored on a `github` integration's settings.
fn installation_id(settings: &Value) -> Result<i64, String> {
    let id = crate::js::js_number(settings.get("installationId"));
    #[allow(clippy::cast_possible_truncation)]
    if id.is_finite() && id.fract() == 0.0 && id > 0.0 && id <= 9_007_199_254_740_991.0 {
        Ok(id as i64)
    } else {
        Err("GitHub integration has no valid installation configured".to_owned())
    }
}

async fn test(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(row) = integration_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Integration", &id));
        };
        let http = caller.http(&state);
        let kind = row["type"].as_str().unwrap_or_default();
        if kind == "github" {
            let Some(creds) = caller.github_app(&state) else {
                return Err(ApiError::internal()
                    .with_message("GitHub App is not configured")
                    .into());
            };
            let outcome = match installation_id(&row["settings"]) {
                Ok(installation) => {
                    installation_token(&http, &creds, installation, caller.caches_tokens()).await
                }
                Err(message) => Err(message),
            };
            let (ok, message) = match outcome {
                Ok(_) => (
                    true,
                    format!(
                        "Connected to {}",
                        row["settings"]["ownerLogin"].as_str().unwrap_or("GitHub")
                    ),
                ),
                Err(message) => (false, message),
            };
            return Ok(Data(json!({ "success": ok, "message": message })).into_response());
        }
        let Some(token) = row["oauthTokens"]["accessToken"]
            .as_str()
            .filter(|t| !t.is_empty())
        else {
            return Ok(Data(
                json!({ "success": false, "message": "Integration is not connected (no token)" }),
            )
            .into_response());
        };
        let token = maybe_decrypt(token, &caller.keyring(&state));
        let outcome = if kind == "slack" {
            slack_auth_test(&http, &token).await
        } else if GOOGLE_TYPES.contains(&kind) {
            google_auth_test(&http, &token).await
        } else {
            Ok((true, "Token present".to_owned()))
        };
        match outcome {
            Ok((ok, message)) => {
                Ok(Data(json!({ "success": ok, "message": message })).into_response())
            }
            Err(error) => Err(Refusal::Response(Box::new(internal(
                &error,
                "Failed to test integration",
            )))),
        }
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to test integration"))
}

/// `listSlackChannels(token)`: up to 200, following the cursor.
async fn list_slack_channels(http: &OutboundHttp, token: &str) -> Result<Vec<Value>, String> {
    let mut channels = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let query = {
            let mut params = url::form_urlencoded::Serializer::new(String::new());
            params
                .append_pair("types", "public_channel,private_channel")
                .append_pair("exclude_archived", "true")
                .append_pair("limit", "200");
            if let Some(cursor) = &cursor {
                params.append_pair("cursor", cursor);
            }
            params.finish()
        };
        let response = http
            .send(
                HttpRequest::empty(
                    "GET",
                    format!("https://slack.com/api/conversations.list?{query}"),
                )
                .header("Authorization", format!("Bearer {token}")),
            )
            .await
            .map_err(|error| error.to_string())?;
        let body = json_of(&response)?;
        if body["ok"].as_bool() != Some(true) {
            return Err(format!(
                "Slack error: {}",
                body["error"].as_str().unwrap_or("unknown")
            ));
        }
        for c in body["channels"].as_array().into_iter().flatten() {
            channels.push(json!({
                "id": c["id"],
                "name": c["name"],
                "isPrivate": crate::js::truthy(&c["is_private"]),
                "isMember": crate::js::truthy(&c["is_member"]),
            }));
        }
        cursor = body["response_metadata"]["next_cursor"]
            .as_str()
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        if cursor.is_none() || channels.len() >= 200 {
            break;
        }
    }
    channels.truncate(200);
    Ok(channels)
}

async fn slack_channels(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(row) = integration_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Integration", &id));
        };
        if row["type"].as_str() != Some("slack") {
            return Err(Refusal::bad_request("Not a Slack integration"));
        }
        let Some(token) = row["oauthTokens"]["accessToken"]
            .as_str()
            .filter(|t| !t.is_empty())
        else {
            return Err(Refusal::bad_request("Integration is not connected"));
        };
        let token = maybe_decrypt(token, &caller.keyring(&state));
        match list_slack_channels(&caller.http(&state), &token).await {
            Ok(channels) => Ok(Data(channels).into_response()),
            Err(error) => Err(Refusal::Response(Box::new(internal(
                &error,
                "Failed to list Slack channels",
            )))),
        }
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to list Slack channels"))
}

async fn github_repos(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(row) = integration_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Integration", &id));
        };
        if row["type"].as_str() != Some("github") {
            return Err(Refusal::bad_request("Not a GitHub integration"));
        }
        let Some(creds) = caller.github_app(&state) else {
            return Err(ApiError::internal()
                .with_message("GitHub App is not configured")
                .into());
        };
        let http = caller.http(&state);
        let repos = async {
            let installation = installation_id(&row["settings"])?;
            let token =
                installation_token(&http, &creds, installation, caller.caches_tokens()).await?;
            list_available_repos(&http, &token).await
        };
        match repos.await {
            Ok(repos) => Ok(Data(repos).into_response()),
            Err(error) => Err(Refusal::Response(Box::new(internal(
                &error,
                "Failed to list GitHub repositories",
            )))),
        }
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to list GitHub repositories"))
}

/// `loadGoogleToken(c, id, expectedType)`.
async fn google_token(
    caller: &Caller,
    state: &ConnectState,
    id: &str,
    expected: &str,
) -> Result<String, Refusal> {
    let Some(row) = integration_row(&caller.db, id).await? else {
        return Err(Refusal::not_found("Integration", id));
    };
    if row["type"].as_str() != Some(expected) {
        return Err(Refusal::bad_request(format!(
            "Not a {expected} integration"
        )));
    }
    let Some(token) = row["oauthTokens"]["accessToken"]
        .as_str()
        .filter(|t| !t.is_empty())
    else {
        return Err(Refusal::bad_request("Integration is not connected"));
    };
    Ok(maybe_decrypt(token, &caller.keyring(state)))
}

/// `parseSpreadsheetId(raw)`.
fn spreadsheet_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(at) = trimmed.find("/spreadsheets/d/") {
        let rest = &trimmed[at + "/spreadsheets/d/".len()..];
        let id: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !id.is_empty() {
            return id;
        }
    }
    trimmed.to_owned()
}

async fn google_spreadsheet(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(raw) = query_truthy(query.as_deref(), "spreadsheetId") else {
        return ApiError::bad_request("spreadsheetId query param is required").into_response();
    };
    let token = match google_token(&caller, &state, &id, "google_sheets").await {
        Ok(token) => token,
        Err(Refusal::Database(error)) => {
            tracing::error!(%error, "[connect-api/workflow-integrations] google token lookup failed");
            return ApiError::internal().into_response();
        }
        Err(refusal) => return refusal.respond(""),
    };
    let sheet = spreadsheet_id(&raw);
    let fetched = async {
        let encoded: String = url::form_urlencoded::byte_serialize(sheet.as_bytes()).collect();
        let encoded = encoded.replace('+', "%20");
        let response = caller
            .http(&state)
            .send(
                HttpRequest::empty(
                    "GET",
                    format!(
                        "https://sheets.googleapis.com/v4/spreadsheets/{encoded}?fields=properties.title,spreadsheetUrl,sheets.properties"
                    ),
                )
                .header("Authorization", format!("Bearer {token}")),
            )
            .await
            .map_err(|error| error.to_string())?;
        if !response.ok() {
            return Err(format!(
                "Sheets API error {}: {}",
                response.status,
                response.text()
            ));
        }
        json_of(&response)
    };
    match fetched.await {
        Ok(body) => {
            let title = body["properties"]["title"]
                .as_str()
                .filter(|t| !t.is_empty())
                .unwrap_or(&sheet);
            let url = body["spreadsheetUrl"]
                .as_str()
                .filter(|u| !u.is_empty())
                .map_or_else(
                    || format!("https://docs.google.com/spreadsheets/d/{sheet}"),
                    str::to_owned,
                );
            let sheets: Vec<Value> = body["sheets"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| {
                    json!({
                        "sheetId": s["properties"]["sheetId"].as_i64().unwrap_or(0),
                        "title": s["properties"]["title"].as_str().unwrap_or(""),
                    })
                })
                .filter(|s| s["title"].as_str().is_some_and(|t| !t.is_empty()))
                .collect();
            Data(json!({ "spreadsheetId": sheet, "title": title, "url": url, "sheets": sheets }))
                .into_response()
        }
        Err(error) => {
            tracing::error!(%error, "[connect-api/workflow-integrations] google sheets spreadsheet lookup failed");
            ApiError::bad_request(
                "Could not read that spreadsheet. Check the id/URL and that this Google account can open it.",
            )
            .into_response()
        }
    }
}

async fn google_calendars(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let token = match google_token(&caller, &state, &id, "google_calendar").await {
        Ok(token) => token,
        Err(Refusal::Database(error)) => {
            tracing::error!(%error, "[connect-api/workflow-integrations] google token lookup failed");
            return ApiError::internal().into_response();
        }
        Err(refusal) => return refusal.respond(""),
    };
    let http = caller.http(&state);
    let listed = async {
        let mut calendars = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let query = {
                let mut params = url::form_urlencoded::Serializer::new(String::new());
                params
                    .append_pair("maxResults", "100")
                    .append_pair("minAccessRole", "writer");
                if let Some(token) = &page {
                    params.append_pair("pageToken", token);
                }
                params.finish()
            };
            let response = http
                .send(
                    HttpRequest::empty(
                        "GET",
                        format!(
                            "https://www.googleapis.com/calendar/v3/users/me/calendarList?{query}"
                        ),
                    )
                    .header("Authorization", format!("Bearer {token}")),
                )
                .await
                .map_err(|error| error.to_string())?;
            if !response.ok() {
                return Err(format!(
                    "Calendar API error {}: {}",
                    response.status,
                    response.text()
                ));
            }
            let body = json_of(&response)?;
            for item in body["items"].as_array().into_iter().flatten() {
                let id = item["id"].clone();
                calendars.push(json!({
                    "id": id,
                    "summary": item["summary"].as_str().filter(|s| !s.is_empty()).map_or(id.clone(), |s| json!(s)),
                    "primary": crate::js::truthy(&item["primary"]),
                    "accessRole": item["accessRole"].as_str().unwrap_or(""),
                }));
            }
            page = body["nextPageToken"]
                .as_str()
                .filter(|t| !t.is_empty())
                .map(str::to_owned);
            if page.is_none() || calendars.len() >= 100 {
                break;
            }
        }
        calendars.truncate(100);
        Ok::<_, String>(calendars)
    };
    match listed.await {
        Ok(calendars) => Data(calendars).into_response(),
        Err(error) => internal(&error, "Failed to list Google calendars"),
    }
}

async fn delete(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if integration_row(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Integration", &id));
        }
        let stamp = now();
        sqlx::query("update workflow_integrations set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&stamp)
            .execute(&caller.db)
            .await?;
        caller.publish(
            &state,
            WORKFLOW_INTEGRATION_DELETED,
            &id,
            &json!({ "id": id }),
        );
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete integration"))
}

// ── OAuth and the other connect flows (`oauth.ts`) ─────────────────────────

/// `redirectUri(env)`.
fn redirect_uri(caller: &Caller, state: &ConnectState) -> String {
    let base = caller
        .overrides
        .env(state, "PUBLIC_APP_URL")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://app.weldsuite.org".to_owned());
    format!(
        "{}/weldconnect/integrations/callback",
        base.strip_suffix('/').unwrap_or(&base)
    )
}

fn env_named(caller: &Caller, state: &ConnectState, def: &Value, field: &str) -> Option<String> {
    let name = def["auth"][field].as_str()?;
    caller.overrides.env(state, name).filter(|v| !v.is_empty())
}

/// `crypto.randomUUID()`.
fn random_uuid() -> String {
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

/// `authorizeParams` in the order TypeScript declares them.
fn authorize_params(def: &Value) -> Vec<(String, String)> {
    const ORDER: &[&str] = &["access_type", "prompt", "include_granted_scopes"];
    let Some(Value::Object(params)) = def["auth"].get("authorizeParams") else {
        return vec![];
    };
    let mut keys: Vec<&String> = params.keys().collect();
    keys.sort_by_key(|k| ORDER.iter().position(|o| o == k).unwrap_or(ORDER.len()));
    keys.into_iter()
        .map(|k| (k.clone(), crate::js::js_string(params.get(k))))
        .collect()
}

async fn authorize(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(provider): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let integration_id = match validate(&headers, &body, |issues, b| {
        issues
            .text(b, "integrationId", Presence::Optional, None, None)
            .into_option()
    }) {
        Ok(id) => id,
        Err(refusal) => return refusal.respond("Failed to authorize"),
    };
    let Some(def) = integration(&provider) else {
        return ApiError::not_found("Integration", Some(&provider)).into_response();
    };
    if def["auth"]["kind"].as_str() != Some("oauth2") {
        return ApiError::bad_request(format!("Integration \"{provider}\" does not use OAuth"))
            .into_response();
    }
    let Some(client_id) = env_named(&caller, &state, def, "clientIdEnv") else {
        return ApiError::internal()
            .with_message(format!("OAuth not configured for {provider}"))
            .into_response();
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::bad_request("No active workspace").into_response();
    };
    let Ok(cache) = kv(&caller, &state) else {
        return ApiError::internal().into_response();
    };
    let oauth_state = random_uuid();
    let mut stored = format!(
        "{{\"orgId\":{},\"userId\":{},\"provider\":{}",
        json!(org_id),
        json!(caller.user_id),
        json!(provider)
    );
    if let Some(id) = &integration_id {
        stored.push_str(",\"integrationId\":");
        stored.push_str(&json!(id).to_string());
    }
    stored.push('}');
    if let Err(error) = cache
        .put_boxed(
            &format!("wf_oauth_state:{oauth_state}"),
            &stored,
            Some(STATE_TTL),
        )
        .await
    {
        tracing::error!(%error, "[workflow-integrations] could not store the OAuth state");
        return ApiError::internal().into_response();
    }
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    params
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri(&caller, &state))
        .append_pair("response_type", "code")
        .append_pair("state", &oauth_state);
    for (key, value) in authorize_params(def) {
        params.append_pair(&key, &value);
    }
    let scopes: Vec<String> = crate::js::array(def["auth"].get("scopes"))
        .iter()
        .map(|s| crate::js::js_string(Some(s)))
        .collect();
    params.append_pair("scope", &scopes.join(" "));
    let url = format!(
        "{}?{}",
        def["auth"]["authUrl"].as_str().unwrap_or_default(),
        params.finish()
    );
    Data(json!({ "authorizeUrl": url, "state": oauth_state })).into_response()
}

async fn put_mapping(cache: &Arc<dyn DynCache>, key: &str, value: &str) -> Result<(), Refusal> {
    cache
        .put_boxed(key, value, None)
        .await
        .map_err(|error| Refusal::Database(sqlx::Error::Protocol(error.to_string())))
}

async fn callback(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(provider): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (code, oauth_state) = match validate(&headers, &body, |issues, b| {
        let code = issues
            .text(b, "code", Presence::Required, Some(1), None)
            .into_option();
        let state = issues
            .text(b, "state", Presence::Required, Some(1), None)
            .into_option();
        (code.unwrap_or_default(), state.unwrap_or_default())
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to connect"),
    };
    let result = async {
        let def = match integration(&provider) {
            Some(def) if def["auth"]["kind"].as_str() == Some("oauth2") => def,
            _ => return Err(Refusal::not_found("Integration", &provider)),
        };
        let cache = kv(&caller, &state)?;
        let key = format!("wf_oauth_state:{oauth_state}");
        let stored: Value = cache
            .get_boxed(&key)
            .await
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(Value::Null);
        if stored["provider"].as_str() != Some(provider.as_str())
            || stored["orgId"].as_str() != caller.org_id.as_deref()
        {
            return Err(Refusal::bad_request("Invalid or expired OAuth state"));
        }
        let _ = cache.delete_boxed(&key).await;
        let (Some(client_id), Some(client_secret)) = (
            env_named(&caller, &state, def, "clientIdEnv"),
            env_named(&caller, &state, def, "clientSecretEnv"),
        ) else {
            return Err(ApiError::internal()
                .with_message(format!("OAuth not configured for {provider}"))
                .into());
        };
        let form: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("code", &code)
            .append_pair("client_id", &client_id)
            .append_pair("client_secret", &client_secret)
            .append_pair("redirect_uri", &redirect_uri(&caller, &state))
            .append_pair("grant_type", "authorization_code")
            .finish();
        let mut request =
            HttpRequest::empty("POST", def["auth"]["tokenUrl"].as_str().unwrap_or_default())
                .header("Content-Type", "application/x-www-form-urlencoded");
        request.body = Some(form.into_bytes());
        let response = caller
            .http(&state)
            .send(request)
            .await
            .map_err(|error| Refusal::Database(sqlx::Error::Protocol(error.to_string())))?;
        let token =
            json_of(&response).map_err(|error| Refusal::Database(sqlx::Error::Protocol(error)))?;
        let token_error = token.get("error").filter(|e| crate::js::truthy(e));
        if token["ok"] == json!(false) || token_error.is_some() || !response.ok() {
            let reason = token_error.map_or_else(
                || response.status.to_string(),
                |e| crate::js::js_string(Some(e)),
            );
            return Err(Refusal::bad_request(format!(
                "Token exchange failed: {reason}"
            )));
        }
        let Some(access_token) = token["access_token"].as_str().filter(|t| !t.is_empty()) else {
            return Err(Refusal::bad_request("No access token in provider response"));
        };
        let keyring = caller.keyring(&state);
        let seal = |value: &str| {
            seal_if_keyed(value, &keyring)
                .map_err(|error| Refusal::Database(sqlx::Error::Protocol(error)))
        };
        let mut oauth_tokens = Map::new();
        oauth_tokens.insert("accessToken".into(), json!(seal(access_token)?));
        if let Some(refresh) = token["refresh_token"].as_str().filter(|t| !t.is_empty()) {
            oauth_tokens.insert("refreshToken".into(), json!(seal(refresh)?));
        }
        if crate::js::truthy(&token["expires_in"]) {
            let seconds = crate::js::js_number(token.get("expires_in"));
            let now_ms =
                i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
                    .unwrap_or(0);
            #[allow(clippy::cast_possible_truncation)]
            if let Some(at) = crate::cron::iso(now_ms + (seconds * 1000.0) as i64) {
                oauth_tokens.insert("expiresAt".into(), json!(at));
            }
        }
        let mut settings = Map::new();
        let team = token["team"]["id"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(str::to_owned);
        if let Some(team) = &team {
            settings.insert("teamId".into(), json!(team));
        }
        if crate::js::truthy(&token["bot_user_id"]) {
            settings.insert("botUserId".into(), token["bot_user_id"].clone());
        }
        let settings = (!settings.is_empty()).then_some(Value::Object(settings));
        let mut integration_id = stored["integrationId"]
            .as_str()
            .filter(|i| !i.is_empty())
            .map(str::to_owned);
        if integration_id.is_none() {
            integration_id = sqlx::query_scalar(
                "select id from workflow_integrations where type = $1 and deleted_at is null limit 1",
            )
            .bind(def["type"].as_str())
            .fetch_optional(&caller.db)
            .await?;
        }
        let stamp = now();
        let scopes = def["auth"]["scopes"].clone();
        let id = if let Some(id) = integration_id {
            sqlx::query(
                "update workflow_integrations set name = $2, type = $3, category = $4, icon = $5,
                    status = 'connected', is_oauth = true, oauth_provider = $6, oauth_scopes = $7,
                    oauth_tokens = $8, settings = case when $9::jsonb is not null then $9 else settings end,
                    connected_at = $10::timestamp, connected_by = $11, updated_at = $10::timestamp
                 where id = $1",
            )
            .bind(&id)
            .bind(def["label"].as_str())
            .bind(def["type"].as_str())
            .bind(def["category"].as_str())
            .bind(def["icon"].as_str())
            .bind(&provider)
            .bind(&scopes)
            .bind(Value::Object(oauth_tokens))
            .bind(&settings)
            .bind(&stamp)
            .bind(&caller.user_id)
            .execute(&caller.db)
            .await?;
            id
        } else {
            let id = generate_id("int");
            sqlx::query(
                "insert into workflow_integrations
                    (id, created_at, name, type, category, icon, status, is_oauth, oauth_provider, oauth_scopes,
                     oauth_tokens, settings, connected_at, connected_by, updated_at)
                 values ($1, $2::timestamp, $3, $4, $5, $6, 'connected', true, $7, $8, $9, $10, $2::timestamp, $11,
                         $2::timestamp)",
            )
            .bind(&id)
            .bind(&stamp)
            .bind(def["label"].as_str())
            .bind(def["type"].as_str())
            .bind(def["category"].as_str())
            .bind(def["icon"].as_str())
            .bind(&provider)
            .bind(&scopes)
            .bind(Value::Object(oauth_tokens))
            .bind(&settings)
            .bind(&caller.user_id)
            .execute(&caller.db)
            .await?;
            id
        };
        let org = json!(caller.org_id);
        put_mapping(
            &cache,
            &format!("intconn:{id}"),
            &format!("{{\"workspaceId\":{org},\"provider\":{}}}", json!(provider)),
        )
        .await?;
        if let Some(team) = &team {
            put_mapping(
                &cache,
                &format!("slack_team:{team}"),
                &format!("{{\"workspaceId\":{org},\"integrationId\":{}}}", json!(id)),
            )
            .await?;
        }
        Ok(Data(json!({ "id": id, "status": "connected", "provider": provider })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| match refusal {
            Refusal::Database(error) => {
                tracing::error!(%error, "[workflow-integrations] OAuth callback failed");
                ApiError::internal().into_response()
            }
            Refusal::Response(response) => *response,
        })
}

async fn apikey(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(provider): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let credentials = match validate(&headers, &body, |issues, b| {
        issues
            .nested(b, "credentials", Presence::Required, |issues, fields| {
                let mut out = Vec::new();
                for (key, value) in fields {
                    if let Some(text) = issues
                        .text_with(fields, key, Presence::Required, Text::default())
                        .into_option()
                    {
                        out.push((key.clone(), text));
                    }
                    let _ = value;
                }
                out
            })
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(credentials) => credentials,
        Err(refusal) => return refusal.respond("Failed to connect"),
    };
    let result = async {
        let def = match integration(&provider) {
            Some(def) if def["auth"]["kind"].as_str() == Some("api_key") => def,
            _ => return Err(Refusal::not_found("Integration", &provider)),
        };
        let keyring = caller.keyring(&state);
        let mut sealed = Map::new();
        for (key, value) in &credentials {
            let value = seal_if_keyed(value, &keyring)
                .map_err(|error| Refusal::Database(sqlx::Error::Protocol(error)))?;
            sealed.insert(key.clone(), json!(value));
        }
        let id = generate_id("int");
        let stamp = now();
        sqlx::query(
            "insert into workflow_integrations
                (id, created_at, updated_at, name, type, category, icon, status, credentials, connected_at, connected_by)
             values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, 'connected', $7, $2::timestamp, $8)",
        )
        .bind(&id)
        .bind(&stamp)
        .bind(def["label"].as_str())
        .bind(def["type"].as_str())
        .bind(def["category"].as_str())
        .bind(def["icon"].as_str())
        .bind(Value::Object(sealed))
        .bind(&caller.user_id)
        .execute(&caller.db)
        .await?;
        let cache = kv(&caller, &state)?;
        put_mapping(
            &cache,
            &format!("intconn:{id}"),
            &format!(
                "{{\"workspaceId\":{},\"provider\":{}}}",
                json!(caller.org_id),
                json!(provider)
            ),
        )
        .await?;
        Ok(
            Created(json!({ "id": id, "status": "connected", "provider": provider }))
                .into_response(),
        )
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| match refusal {
            Refusal::Database(error) => {
                tracing::error!(%error, "[workflow-integrations] API-key connect failed");
                ApiError::internal().into_response()
            }
            Refusal::Response(response) => *response,
        })
}

async fn link(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(provider): Path<String>,
) -> Response {
    let Some(def) = integration(&provider) else {
        return ApiError::not_found("Integration", Some(&provider)).into_response();
    };
    if def["auth"]["kind"].as_str() != Some("app_installation") {
        return ApiError::bad_request(format!(
            "Integration \"{provider}\" does not use an app installation"
        ))
        .into_response();
    }
    if provider != "github" {
        return ApiError::not_found("Integration", Some(&provider)).into_response();
    }
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::bad_request("No active workspace").into_response();
    };
    let result = async {
        let connection: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from github_connections t where t.workspace_id = $1 and t.deleted_at is null limit 1",
        )
        .bind(&org_id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(connection) = connection.filter(|c| c["status"].as_str() == Some("active")) else {
            return Ok(
                Data(json!({ "status": "needs_install", "provider": provider })).into_response(),
            );
        };
        let settings = json!({
            "installationId": connection["installation_id"],
            "ownerLogin": connection["owner_login"],
            "ownerType": connection["owner_type"],
            "appSlug": connection["app_slug"],
        });
        let stamp = now();
        let existing: Option<String> =
            sqlx::query_scalar("select id from workflow_integrations where type = 'github' and deleted_at is null limit 1")
                .fetch_optional(&caller.db)
                .await?;
        let id = if let Some(id) = existing {
            sqlx::query(
                "update workflow_integrations set status = 'connected', settings = $2, connected_at = $3::timestamp,
                    connected_by = $4, updated_at = $3::timestamp where id = $1",
            )
            .bind(&id)
            .bind(&settings)
            .bind(&stamp)
            .bind(&caller.user_id)
            .execute(&caller.db)
            .await?;
            id
        } else {
            let id = generate_id("int");
            sqlx::query(
                "insert into workflow_integrations
                    (id, created_at, updated_at, name, type, category, icon, status, settings, connected_at, connected_by)
                 values ($1, $2::timestamp, $2::timestamp, 'GitHub', 'github', 'developer', 'github', 'connected', $3,
                         $2::timestamp, $4)",
            )
            .bind(&id)
            .bind(&stamp)
            .bind(&settings)
            .bind(&caller.user_id)
            .execute(&caller.db)
            .await?;
            id
        };
        let cache = kv(&caller, &state)?;
        put_mapping(
            &cache,
            &format!("intconn:{id}"),
            &format!(
                "{{\"workspaceId\":{},\"provider\":{}}}",
                json!(org_id),
                json!(provider)
            ),
        )
        .await?;
        Ok(Data(json!({ "id": id, "status": "connected", "provider": provider })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| match refusal {
            Refusal::Database(error) => {
                tracing::error!(%error, "[workflow-integrations] GitHub link failed");
                ApiError::internal().into_response()
            }
            Refusal::Response(response) => *response,
        })
}
