//! `/api/asset-sources` (`app-api/src/routes/asset-sources`): the device
//! sources of the asset register.
//!
//! Every route needs `weldobjects:manage`, the reads included. The client
//! secret is write-only: sealed with the keyring on its way in, never
//! returned, never in an event. These routes only manage the sources and
//! start imports; the sweep runs them, found through the due index, which
//! every route that changes when a source has work marks.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequestParts, Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::{
    ASSET_SOURCE_CREATED, ASSET_SOURCE_DELETED, ASSET_SOURCE_UPDATED, EventName,
};
use weldsuite_catalogs::permission_keys::WELDOBJECTS_MANAGE;
use weldsuite_db::{Keyring, MasterDb, PgPool, Tenant, decrypt_field, encrypt_field};
use weldsuite_events::{EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, RequestEnv, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::OutboundHttp;

use super::AssetSourcesState;
use super::microsoft::{ErrorCode, SourceError, is_valid_entra_tenant_id, refusal, test_source};
use super::source::{
    self, ASSET_OBJECT_SLUG, Changes, DUE_KIND, NewSource, Source, instant, to_millisecond,
};
use crate::objects::object_by_slug;
use crate::{Answer, Refusal, validate};

const RESOURCE: &str = "Asset source";
const SOURCE_TYPES: [&str; 1] = ["intune"];
const MIN_INTERVAL_HOURS: f64 = 1.0;
const MAX_INTERVAL_HOURS: f64 = 168.0;
const DEFAULT_INTERVAL_HOURS: i32 = 24;
const NOT_A_TENANT: &str = "Not a tenant id or domain name";
const DUPLICATE: &str = "This app registration is already connected";

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<AssetSourcesState>
where
    Q: PermissionQueries + 'static,
{
    let need = || gate.require([WELDOBJECTS_MANAGE.to_owned()]);
    Router::new()
        .route("/", get(list).post(create).route_layer(need()))
        // `POST /test` is declared before `/:id`; Hono answers the other
        // methods on that path with the `/:id` routes.
        .route(
            "/test",
            post(test_unsaved)
                .get(detail_named_test)
                .patch(update_named_test)
                .delete(remove_named_test)
                .route_layer(need()),
        )
        .route(
            "/{id}",
            get(detail).patch(update).delete(remove).route_layer(need()),
        )
        .route("/{id}/test", post(test_saved).route_layer(need()))
        .route("/{id}/sync", post(sync).route_layer(need()))
}

/// A signed-in member in a workspace, with the request's overrides
/// (conformance mode) of the state's ports.
struct Member {
    db: PgPool,
    user_id: String,
    /// `workspaces.id`: what the due index is keyed by here.
    workspace_id: String,
    events: EventContext,
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
}

impl Member {
    /// `keyringFromEnv(c.env)`: the request's keys when it brings its own
    /// env, else the deployment's.
    fn keyring(&self, state: &AssetSourcesState) -> Keyring {
        let Some(env) = &self.env else {
            return state.keyring.clone();
        };
        let key = |name: &str| {
            env.get(name)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        Keyring {
            v1: key("DATABASE_ENCRYPTION_KEY"),
            v2: key("DATABASE_ENCRYPTION_KEY_V2"),
        }
    }

    /// What Microsoft is called through.
    fn http(&self, state: &AssetSourcesState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }

    /// `publishEntityEvent({ c, entityType: 'asset_source', action, entityId, data })`.
    fn publish(&self, state: &AssetSourcesState, event: EventName, source: &Source) {
        publish_entity_event(
            &state.events,
            &self.events,
            event,
            &source.id,
            &source.view(),
        );
    }

    /// `markDue(c, row, now)`: tell the sweep when this workspace next has
    /// work for the source. Best effort, after the response.
    fn mark_due(&self, state: &AssetSourcesState, source: &Source, now: OffsetDateTime) {
        let Some(master) = self.master.clone().or_else(|| state.master.clone()) else {
            return;
        };
        let Some(at) = source.due_at(now) else {
            return;
        };
        let workspace_id = self.workspace_id.clone();
        state.events.tracker().spawn(async move {
            weldsuite_db::due_index::mark_due(&master, DUE_KIND, &workspace_id, at).await;
        });
    }
}

/// Behind the session and tenant layers; without them it is a routing
/// mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Member {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let member = if let (Some(auth), Some(tenant)) = (auth, tenant) {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                events: EventContext::for_request(auth, tenant),
                env: parts.extensions.get::<RequestEnv>().cloned(),
                master: parts.extensions.get::<MasterDb>().map(|m| m.0.clone()),
                http: parts.extensions.get::<OutboundHttp>().cloned(),
            })
        } else {
            tracing::error!("asset sources: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(member)
    }
}

/// The route's answer; a failure the route does not catch is the worker's
/// plain 500.
fn answer(result: Answer) -> Response {
    result.unwrap_or_else(|refusal| match refusal {
        Refusal::Response(response) => *response,
        Refusal::Database(error) => {
            tracing::error!(%error, "asset sources: database error");
            ApiError::internal().into_response()
        }
    })
}

fn not_found(id: &str) -> Refusal {
    Refusal::not_found(RESOURCE, id)
}

/// `encryptField(secret, keyringFromEnv(c.env))`; without a key the worker
/// throws.
fn seal(secret: &str, keyring: &Keyring) -> Result<String, Refusal> {
    encrypt_field(secret, keyring).map_err(|error| {
        tracing::error!(%error, "asset sources: the client secret could not be sealed");
        ApiError::internal().into()
    })
}

// ── bodies ──────────────────────────────────────────────────────────────────

/// `intuneConfigSchema`'s output.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Config {
    tenant_id: String,
    client_id: String,
}

impl Config {
    fn json(&self) -> Value {
        json!({ "tenantId": self.tenant_id, "clientId": self.client_id })
    }

    /// `sameApp(a, b)`: the same tenant and application, whatever the case.
    fn same_app(&self, tenant_id: &str, client_id: &str) -> bool {
        self.tenant_id.to_lowercase() == tenant_id.to_lowercase()
            && self.client_id.to_lowercase() == client_id.to_lowercase()
    }
}

/// `intuneConfigSchema` at the current path: the config, and whether the
/// tenant id failed its refinement (`isEntraTenantId`). The caller settles
/// that issue where Zod does: at once when it parses synchronously, after
/// every other check of the body when `zValidator` parses asynchronously.
fn read_config(issues: &mut Issues, fields: &Map<String, Value>) -> (Config, bool) {
    let trimmed = Text {
        trim: true,
        ..Text::default()
    };
    let tenant_id = issues
        .text_with(fields, "tenantId", Presence::Required, trimmed)
        .into_option();
    let refused = tenant_id
        .as_deref()
        .is_some_and(|tenant| !is_valid_entra_tenant_id(tenant));
    let client_id = issues
        .text_with(
            fields,
            "clientId",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option();
    let config = Config {
        tenant_id: tenant_id.unwrap_or_default(),
        client_id: client_id.unwrap_or_default(),
    };
    (config, refused)
}

/// `config: intuneConfigSchema` with `presence`, as `zValidator` reads it:
/// the refinement's issue is left for [`settle_tenant`].
fn read_config_field(
    issues: &mut Issues,
    body: &Map<String, Value>,
    presence: Presence,
    tenant_refused: &mut bool,
) -> Option<Config> {
    let mut read = None;
    issues.nested(body, "config", presence, |issues, fields| {
        let (config, refused) = read_config(issues, fields);
        *tenant_refused = refused;
        read = Some(config);
    });
    read
}

/// The tenant id's failed refinement, which Zod settles after the body's
/// synchronous checks.
fn settle_tenant(issues: &mut Issues, refused: bool) {
    if refused {
        issues.custom_at(&[json!("config"), json!("tenantId")], NOT_A_TENANT);
    }
}

fn secret_rules() -> Text {
    Text::trimmed(Some(1), Some(2048))
}

fn interval_rules() -> Number {
    Number {
        int: true,
        min: Some(MIN_INTERVAL_HOURS),
        max: Some(MAX_INTERVAL_HOURS),
        ..Number::default()
    }
}

/// `createAssetSourceSchema`'s output.
#[derive(Debug)]
struct CreateBody {
    kind: String,
    name: String,
    config: Config,
    secret: String,
    enabled: bool,
    interval_hours: i32,
}

fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> CreateBody {
    let kind = issues.choice(body, "type", Presence::Optional, &SOURCE_TYPES);
    let name = issues.text_with(
        body,
        "name",
        Presence::Required,
        Text::trimmed(Some(1), Some(255)),
    );
    let mut tenant_refused = false;
    let config = read_config_field(issues, body, Presence::Required, &mut tenant_refused);
    let secret = issues.text_with(body, "secret", Presence::Required, secret_rules());
    let enabled = issues.boolean(body, "enabled", Presence::Optional);
    let interval_hours =
        issues.whole_number(body, "intervalHours", Presence::Optional, interval_rules());
    settle_tenant(issues, tenant_refused);
    CreateBody {
        kind: kind.into_option().unwrap_or_else(|| "intune".to_owned()),
        name: name.into_option().unwrap_or_default(),
        config: config.unwrap_or_default(),
        secret: secret.into_option().unwrap_or_default(),
        enabled: enabled.into_option().unwrap_or(true),
        interval_hours: interval_hours
            .into_option()
            .and_then(|hours| i32::try_from(hours).ok())
            .unwrap_or(DEFAULT_INTERVAL_HOURS),
    }
}

/// `updateAssetSourceSchema`'s output: what the body names.
#[derive(Debug)]
struct UpdateBody {
    name: Option<String>,
    config: Option<Config>,
    secret: Option<String>,
    enabled: Option<bool>,
    interval_hours: Option<i32>,
}

fn read_update(issues: &mut Issues, body: &Map<String, Value>) -> UpdateBody {
    let name = issues.text_with(
        body,
        "name",
        Presence::Optional,
        Text::trimmed(Some(1), Some(255)),
    );
    let mut tenant_refused = false;
    let config = read_config_field(issues, body, Presence::Optional, &mut tenant_refused);
    let secret = issues.text_with(body, "secret", Presence::Optional, secret_rules());
    let enabled = issues.boolean(body, "enabled", Presence::Optional);
    let interval_hours =
        issues.whole_number(body, "intervalHours", Presence::Optional, interval_rules());
    settle_tenant(issues, tenant_refused);
    UpdateBody {
        name: name.into_option(),
        config,
        secret: secret.into_option(),
        enabled: enabled.into_option(),
        interval_hours: interval_hours
            .into_option()
            .and_then(|hours| i32::try_from(hours).ok()),
    }
}

/// `testAssetSourceSchema`'s output.
fn read_test(issues: &mut Issues, body: &Map<String, Value>) -> (Config, String) {
    let mut tenant_refused = false;
    let config = read_config_field(issues, body, Presence::Required, &mut tenant_refused);
    let secret = issues.text_with(body, "secret", Presence::Required, secret_rules());
    settle_tenant(issues, tenant_refused);
    (
        config.unwrap_or_default(),
        secret.into_option().unwrap_or_default(),
    )
}

/// `testSavedAssetSourceSchema.safeParse(body)`: a synchronous parse, so the
/// tenant id's refinement is settled where it stands.
fn read_saved_test(issues: &mut Issues, body: &Value) -> (Option<Config>, Option<String>) {
    let Some(fields) = issues.object(body) else {
        return (None, None);
    };
    let config = issues
        .nested(fields, "config", Presence::Optional, |issues, config| {
            let trimmed = Text {
                trim: true,
                ..Text::default()
            };
            let tenant_id = issues
                .text_with(config, "tenantId", Presence::Required, trimmed)
                .into_option();
            if tenant_id
                .as_deref()
                .is_some_and(|tenant| !is_valid_entra_tenant_id(tenant))
            {
                issues.custom("tenantId", NOT_A_TENANT);
            }
            let client_id = issues
                .text_with(
                    config,
                    "clientId",
                    Presence::Required,
                    Text::trimmed(Some(1), Some(255)),
                )
                .into_option();
            Config {
                tenant_id: tenant_id.unwrap_or_default(),
                client_id: client_id.unwrap_or_default(),
            }
        })
        .into_option();
    let secret = issues
        .text_with(fields, "secret", Presence::Optional, secret_rules())
        .into_option();
    (config, secret)
}

// ── handlers ────────────────────────────────────────────────────────────────

/// ADR OPS-026: Microsoft Intune is reached (tested, connected, imported
/// from) only once the workspace switched Microsoft on: 403
/// `OUTSIDE_EU_SERVICE_OFF` otherwise (enforced on the EU edition; elsewhere
/// this never reads the database). Listing, editing and removing a source
/// stay open.
async fn microsoft_off(member: &Member) -> Option<Response> {
    weldsuite_outside_eu::require(&member.db, weldsuite_outside_eu::ServiceId::Microsoft)
        .await
        .err()
        .map(|error| error.to_api_error().into_response())
}

/// `GET /`: the workspace's sources, oldest first. Not paged.
async fn list(member: Member) -> Response {
    answer(
        async {
            let rows = source::list(&member.db).await?;
            Ok(crate::all(rows.iter().map(Source::view).collect()))
        }
        .await,
    )
}

/// `POST /test`: try a connection that is not saved yet. Saves nothing; a
/// refusal is HTTP 200 `ok: false`.
async fn test_unsaved(
    State(state): State<AssetSourcesState>,
    member: Member,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (config, secret) = match validate(&headers, &body, read_test) {
        Ok(body) => body,
        Err(invalid) => return *invalid,
    };
    if let Some(off) = microsoft_off(&member).await {
        return off;
    }
    let http = member.http(&state);
    let result = test_source(http.as_ref(), &config.tenant_id, &config.client_id, &secret).await;
    Data(result).into_response()
}

/// `POST /`.
async fn create(
    State(state): State<AssetSourcesState>,
    member: Member,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, read_create) {
        Ok(body) => body,
        Err(invalid) => return *invalid,
    };
    if let Some(off) = microsoft_off(&member).await {
        return off;
    }
    answer(
        async {
            let db = &member.db;
            let Some(object) = object_by_slug(db, ASSET_OBJECT_SLUG).await? else {
                return Ok((
                    StatusCode::CONFLICT,
                    Json(json!({ "error": {
                        "code": "asset_register_missing",
                        "message": "The asset register is not set up. Set it up before connecting a device source.",
                    } })),
                )
                    .into_response());
            };

            let existing = source::of_type(db, &body.kind).await?;
            if existing
                .iter()
                .any(|row| body.config.same_app(row.tenant_id(), row.client_id()))
            {
                return Err(ApiError::conflict(DUPLICATE)
                    .with_details(json!({ "code": "duplicate_source" }))
                    .into());
            }

            let now = to_millisecond(OffsetDateTime::now_utc());
            let stamp = iso_timestamp(now);
            let sealed = seal(&body.secret, &member.keyring(&state))?;
            let id = generate_id("asrc");
            let row = source::insert(
                db,
                NewSource {
                    id: &id,
                    kind: &body.kind,
                    name: &body.name,
                    object_slug: &object.slug,
                    config: body.config.json(),
                    secret_encrypted: &sealed,
                    enabled: body.enabled,
                    interval_hours: body.interval_hours,
                    // The first import starts on the next tick.
                    next_sync_at: body.enabled.then_some(stamp.as_str()),
                    created_by_id: &member.user_id,
                    now: &stamp,
                },
            )
            .await?;

            member.mark_due(&state, &row, now);
            member.publish(&state, ASSET_SOURCE_CREATED, &row);
            Ok(Created(row.view()).into_response())
        }
        .await,
    )
}

/// `GET /:id`.
async fn detail(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let row = source::by_id(&member.db, &id)
                .await?
                .ok_or_else(|| not_found(&id))?;
            Ok(Data(row.view()).into_response())
        }
        .await,
    )
}

/// `PATCH /:id`.
async fn update(
    State(state): State<AssetSourcesState>,
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, read_update) {
        Ok(body) => body,
        Err(invalid) => return *invalid,
    };
    answer(
        async {
            let db = &member.db;
            let existing = source::by_id(db, &id)
                .await?
                .ok_or_else(|| not_found(&id))?;
            let now = to_millisecond(OffsetDateTime::now_utc());
            let stamp = iso_timestamp(now);

            if let Some(config) = &body.config
                && !config.same_app(existing.tenant_id(), existing.client_id())
            {
                // The stored secret belongs to the other app registration.
                if body.secret.is_none() {
                    return Err(ApiError::bad_request(
                        "A different tenant or application needs its client secret",
                    )
                    .with_details(json!({ "field": "secret" }))
                    .into());
                }
                let others = source::of_type(db, &existing.kind).await?;
                if others
                    .iter()
                    .any(|row| row.id != id && config.same_app(row.tenant_id(), row.client_id()))
                {
                    return Err(ApiError::conflict(DUPLICATE)
                        .with_details(json!({ "code": "duplicate_source" }))
                        .into());
                }
            }
            let sealed = match &body.secret {
                Some(secret) => Some(seal(secret, &member.keyring(&state))?),
                None => None,
            };

            let enabled = body.enabled.unwrap_or(existing.enabled);
            let interval_hours = body
                .interval_hours
                .map_or(existing.interval_hours, i64::from);
            // The next import is one interval after the last; never imported
            // yet: now.
            let next = if enabled {
                let after_last = existing
                    .last_sync_at
                    .as_deref()
                    .and_then(instant)
                    .map(|last| iso_timestamp(last + time::Duration::hours(interval_hours)));
                Some(after_last.unwrap_or_else(|| stamp.clone()))
            } else {
                None
            };
            let reschedule = body.enabled.is_some() || body.interval_hours.is_some();

            let row = source::update(
                db,
                &id,
                &stamp,
                Changes {
                    name: body.name.as_deref(),
                    config: body.config.as_ref().map(Config::json),
                    secret_encrypted: sealed.as_deref(),
                    enabled: body.enabled,
                    interval_hours: body.interval_hours,
                    next_sync_at: match (reschedule, next.as_deref()) {
                        (false, _) => Field::Absent,
                        (true, None) => Field::Null,
                        (true, Some(at)) => Field::Set(at),
                    },
                },
            )
            .await?
            .ok_or_else(|| Refusal::from(ApiError::internal()))?;

            member.mark_due(&state, &row, now);
            member.publish(&state, ASSET_SOURCE_UPDATED, &row);
            Ok(Data(row.view()).into_response())
        }
        .await,
    )
}

/// `DELETE /:id`: the source goes with its mappings; the asset records it
/// imported stay.
async fn remove(
    State(state): State<AssetSourcesState>,
    member: Member,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let existing = source::by_id(&member.db, &id)
                .await?
                .ok_or_else(|| not_found(&id))?;
            source::delete(&member.db, &id).await?;
            member.publish(&state, ASSET_SOURCE_DELETED, &existing);
            Ok(NoContent.into_response())
        }
        .await,
    )
}

/// Hono answers `GET /test` with `GET /:id`.
async fn detail_named_test(member: Member) -> Response {
    detail(member, Path("test".to_owned())).await
}

/// Hono answers `PATCH /test` with `PATCH /:id`.
async fn update_named_test(
    state: State<AssetSourcesState>,
    member: Member,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    update(state, member, Path("test".to_owned()), headers, body).await
}

/// Hono answers `DELETE /test` with `DELETE /:id`.
async fn remove_named_test(state: State<AssetSourcesState>, member: Member) -> Response {
    remove(state, member, Path("test".to_owned())).await
}

/// `{ ok: false, code: 'invalid_secret', message }`: the stored secret
/// cannot be used.
fn unusable_secret(message: &str) -> Response {
    Data(refusal(&SourceError::with_message(
        ErrorCode::InvalidSecret,
        message,
    )))
    .into_response()
}

/// `POST /:id/test`: try the saved connection (or, with a body, a
/// replacement secret or config) without saving anything. The answer is
/// Microsoft's, not ours: a refusal is HTTP 200 `{ ok: false, code, message }`.
async fn test_saved(
    State(state): State<AssetSourcesState>,
    member: Member,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    if let Some(off) = microsoft_off(&member).await {
        return off;
    }
    answer(
        async {
            let row = source::by_id(&member.db, &id)
                .await?
                .ok_or_else(|| not_found(&id))?;

            // `await c.req.json().catch(() => ({}))`, then a plain `safeParse`.
            let body: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
            let mut issues = Issues::default();
            let (config, secret) = read_saved_test(&mut issues, &body);
            if let Err(invalid) = issues.finish() {
                return Err(ApiError::bad_request("Invalid request body")
                    .with_details(invalid.flatten())
                    .into());
            }

            let secret = if let Some(secret) = secret {
                secret
            } else {
                let sealed = source::stored_secret(&member.db, &id)
                    .await?
                    .filter(|sealed| !sealed.is_empty());
                let Some(sealed) = sealed else {
                    return Ok(unusable_secret(
                        "No client secret is stored; enter it again.",
                    ));
                };
                let Ok(secret) = decrypt_field(&sealed, &member.keyring(&state)) else {
                    return Ok(unusable_secret(
                        "The stored client secret cannot be read; enter it again.",
                    ));
                };
                secret
            };
            let http = member.http(&state);
            let (tenant_id, client_id) = match &config {
                Some(config) => (config.tenant_id.as_str(), config.client_id.as_str()),
                None => (row.tenant_id(), row.client_id()),
            };
            let result = test_source(http.as_ref(), tenant_id, client_id, &secret).await;
            Ok(Data(result).into_response())
        }
        .await,
    )
}

/// `POST /:id/sync`: start an import now. 202 with the source; 409
/// `already_running` while one is under way.
async fn sync(
    State(state): State<AssetSourcesState>,
    member: Member,
    Path(id): Path<String>,
) -> Response {
    if let Some(off) = microsoft_off(&member).await {
        return off;
    }
    answer(
        async {
            let db = &member.db;
            let existing = source::by_id(db, &id)
                .await?
                .ok_or_else(|| not_found(&id))?;
            let now = to_millisecond(OffsetDateTime::now_utc());
            let started =
                source::start_import(db, &existing.id, &iso_timestamp(now), Some(&member.user_id))
                    .await?;
            let Some(row) = started else {
                return Ok((
                    StatusCode::CONFLICT,
                    Json(json!({ "error": {
                        "code": "already_running",
                        "message": "An import is already running for this source",
                    } })),
                )
                    .into_response());
            };
            member.mark_due(&state, &row, now);
            member.publish(&state, ASSET_SOURCE_UPDATED, &row);
            Ok((StatusCode::ACCEPTED, Json(json!({ "data": row.view() }))).into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    //! The request schemas of `@weldsuite/core-api-client/schemas/asset-sources`,
    //! against Zod's own output.

    use super::*;

    const TENANT: &str = "11111111-2222-3333-4444-555555555555";
    const CLIENT: &str = "cccccccc-2222-3333-4444-555555555555";

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
            "name": "Contoso Intune",
            "config": { "tenantId": TENANT, "clientId": CLIENT },
            "secret": "client-secret-very-secret",
        })
    }

    fn with(mut body: Value, key: &str, value: Value) -> Value {
        body[key] = value;
        body
    }

    #[test]
    fn a_create_body_reads_like_the_schema() {
        let body = json!({
            "name": " Contoso ",
            "config": { "tenantId": " Contoso.OnMicrosoft.com ", "clientId": " app " },
            "secret": " s3cret ",
        });
        let mut issues = Issues::default();
        let Some(fields) = body.as_object() else {
            panic!("an object");
        };
        let read = read_create(&mut issues, fields);
        assert!(issues.finish().is_ok());
        assert_eq!(read.kind, "intune");
        assert_eq!(read.name, "Contoso");
        assert_eq!(
            read.config,
            Config {
                tenant_id: "Contoso.OnMicrosoft.com".to_owned(),
                client_id: "app".to_owned()
            }
        );
        assert_eq!(read.secret, "s3cret");
        assert!(read.enabled);
        assert_eq!(read.interval_hours, 24);

        let paused = with(
            with(valid(), "enabled", json!(false)),
            "intervalHours",
            json!(6),
        );
        let mut issues = Issues::default();
        let Some(fields) = paused.as_object() else {
            panic!("an object");
        };
        let read = read_create(&mut issues, fields);
        assert!(issues.finish().is_ok());
        assert_eq!((read.enabled, read.interval_hours), (false, 6));
    }

    #[test]
    fn create_issues_are_zods() {
        // `createAssetSourceSchema.safeParseAsync(body)`, as `zValidator` runs it.
        assert_eq!(
            issues_of(&json!({}), read_create),
            [
                json!({ "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["name"], "message": "Required" }),
                json!({ "code": "invalid_type", "expected": "object", "received": "undefined", "path": ["config"], "message": "Required" }),
                json!({ "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["secret"], "message": "Required" }),
            ]
        );
        assert_eq!(
            issues_of(&with(valid(), "type", json!("jamf")), read_create),
            [json!({
                "received": "jamf", "code": "invalid_enum_value", "options": ["intune"], "path": ["type"],
                "message": "Invalid enum value. Expected 'intune', received 'jamf'",
            })]
        );
        assert_eq!(
            issues_of(
                &with(
                    valid(),
                    "config",
                    json!({ "tenantId": TENANT, "clientId": "" })
                ),
                read_create
            ),
            [json!({
                "code": "too_small", "minimum": 1, "type": "string", "inclusive": true, "exact": false,
                "message": "String must contain at least 1 character(s)", "path": ["config", "clientId"],
            })]
        );
        for (hours, issue) in [
            (
                json!(0),
                json!({
                    "code": "too_small", "minimum": 1, "type": "number", "inclusive": true, "exact": false,
                    "message": "Number must be greater than or equal to 1", "path": ["intervalHours"],
                }),
            ),
            (
                json!(169),
                json!({
                    "code": "too_big", "maximum": 168, "type": "number", "inclusive": true, "exact": false,
                    "message": "Number must be less than or equal to 168", "path": ["intervalHours"],
                }),
            ),
            (
                json!(1.5),
                json!({
                    "code": "invalid_type", "expected": "integer", "received": "float",
                    "message": "Expected integer, received float", "path": ["intervalHours"],
                }),
            ),
        ] {
            assert_eq!(
                issues_of(&with(valid(), "intervalHours", hours), read_create),
                [issue]
            );
        }
    }

    #[test]
    fn the_tenant_refinement_settles_after_every_other_check() {
        // A bad tenant id, an empty client id, an empty secret and a bad
        // interval: the refinement's issue comes last.
        let body = json!({
            "name": "x",
            "config": { "tenantId": "a/../b", "clientId": "" },
            "secret": "",
            "intervalHours": 0,
        });
        let issues = issues_of(&body, read_create);
        let paths: Vec<&Value> = issues.iter().map(|issue| &issue["path"]).collect();
        assert_eq!(
            paths,
            [
                &json!(["config", "clientId"]),
                &json!(["secret"]),
                &json!(["intervalHours"]),
                &json!(["config", "tenantId"]),
            ]
        );
        assert_eq!(
            issues[3],
            json!({ "code": "custom", "message": "Not a tenant id or domain name", "path": ["config", "tenantId"] })
        );
        // A tenant id that is not a string never reaches the refinement.
        assert_eq!(
            issues_of(
                &with(
                    valid(),
                    "config",
                    json!({ "tenantId": 7, "clientId": CLIENT })
                ),
                read_create
            ),
            [json!({
                "code": "invalid_type", "expected": "string", "received": "number",
                "path": ["config", "tenantId"], "message": "Expected string, received number",
            })]
        );
    }

    #[test]
    fn an_update_body_names_only_what_it_changes() {
        let body = json!({ "name": "Renamed", "intervalHours": 6, "secret": "new-secret" });
        let mut issues = Issues::default();
        let Some(fields) = body.as_object() else {
            panic!("an object");
        };
        let read = read_update(&mut issues, fields);
        assert!(issues.finish().is_ok());
        assert_eq!(read.name.as_deref(), Some("Renamed"));
        assert_eq!(read.secret.as_deref(), Some("new-secret"));
        assert_eq!(read.interval_hours, Some(6));
        assert_eq!((read.config, read.enabled), (None, None));

        assert_eq!(
            issues_of(&json!({ "intervalHours": 500 }), read_update),
            [json!({
                "code": "too_big", "maximum": 168, "type": "number", "inclusive": true, "exact": false,
                "message": "Number must be less than or equal to 168", "path": ["intervalHours"],
            })]
        );
        assert_eq!(
            issues_of(
                &json!({ "config": { "tenantId": "x/y", "clientId": "c" } }),
                read_update
            ),
            [
                json!({ "code": "custom", "message": "Not a tenant id or domain name", "path": ["config", "tenantId"] })
            ]
        );
    }

    #[test]
    fn a_saved_test_body_parses_synchronously() {
        let mut issues = Issues::default();
        assert_eq!(read_saved_test(&mut issues, &json!({})), (None, None));
        assert!(issues.finish().is_ok());

        let mut issues = Issues::default();
        let read = read_saved_test(&mut issues, &json!({ "secret": " replacement " }));
        assert!(issues.finish().is_ok());
        assert_eq!(read, (None, Some("replacement".to_owned())));

        // `safeParse`: the refinement's issue stands where the field does.
        let mut issues = Issues::default();
        read_saved_test(
            &mut issues,
            &json!({ "config": { "tenantId": "x/y", "clientId": "" }, "secret": "" }),
        );
        let Err(invalid) = issues.finish() else {
            panic!("an invalid body");
        };
        assert_eq!(
            invalid.flatten(),
            json!({
                "formErrors": [],
                "fieldErrors": {
                    "config": [
                        "Not a tenant id or domain name",
                        "String must contain at least 1 character(s)",
                    ],
                    "secret": ["String must contain at least 1 character(s)"],
                },
            })
        );

        let mut issues = Issues::default();
        read_saved_test(&mut issues, &json!([]));
        let Err(invalid) = issues.finish() else {
            panic!("an invalid body");
        };
        assert_eq!(
            invalid.flatten(),
            json!({ "formErrors": ["Expected object, received array"], "fieldErrors": {} })
        );
    }

    #[test]
    fn the_same_app_is_the_same_whatever_the_case() {
        let config = Config {
            tenant_id: TENANT.to_owned(),
            client_id: CLIENT.to_owned(),
        };
        assert!(config.same_app(&TENANT.to_uppercase(), CLIENT));
        assert!(!config.same_app(TENANT, "dddddddd-2222-3333-4444-555555555555"));
    }
}
