//! `legalEntityContext()` (`middleware.ts`): the one place a WeldBooks or
//! WeldHR request learns which legal entity it is about, and the one place
//! per-entity access is enforced for it.
//!
//! Resolution: `X-Legal-Entity-Id`, then `X-Accounting-Entity-Id` (kept for
//! old mobile binaries and API clients), then `?entityId`, then (with
//! [`LegalEntityContextOptions::fallback_to_default`]) the default entity. An
//! id that is unknown, deleted, not enabled for the app or not visible to the
//! member resolves to no entity: the route then lists nothing or refuses,
//! exactly as an unknown id did before, and a restricted entity's existence
//! is never confirmed. A named id never falls back to the default.
//!
//! With [`LegalEntityContextOptions::scoped`] the member then acts with their
//! entity role: the layer inserts a [`PresetPermissions`] with that role's
//! permissions, which every route gate behind it checks instead of the
//! workspace role.
//!
//! Mount it on the module's router (`.layer(...)`, so it runs before the
//! routes' `route_layer` gates), behind the session and tenant layers:
//!
//! ```ignore
//! router.layer(legal_entity_context(
//!     gate,
//!     LegalEntityContextOptions::new()
//!         .app(LegalEntityApp::Weldbooks)
//!         .scoped()
//!         .skip(|request| request.uri().path() == "/accounting-entities"),
//! ))
//! ```
//!
//! Handlers read the outcome with the [`RequestEntity`] extractor.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::extract::{FromRequestParts, OptionalFromRequestParts, Request};
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use http::{Extensions, HeaderMap};
use serde_json::Value;
use sqlx::PgPool;
use tower::{Layer, Service};
use weldsuite_auth::AuthContext;
use weldsuite_db::Tenant;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{js_trim, query_values};
use weldsuite_permissions::{
    PermissionGate, PermissionQueries, Permissions, PresetPermissions, ResolvedPermissions,
};

use crate::access::{
    EntityAccess, can_see_entity, entity_role_id, load_entity_access, permissions_in_entity_with,
};
use crate::extensions::LegalEntityApp;

pub const LEGAL_ENTITY_HEADER: &str = "x-legal-entity-id";
pub const ACCOUNTING_ENTITY_HEADER: &str = "x-accounting-entity-id";

/// `c.req.query(key)`: the key's first value.
fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    match query_values(query).remove(key)? {
        Value::String(text) => Some(text),
        Value::Array(values) => values.into_iter().find_map(|value| match value {
            Value::String(text) => Some(text),
            _ => None,
        }),
        _ => None,
    }
}

/// The entity id the request names (`requestedEntityId`): the header or
/// `?entityId`, trimmed, at most 30 characters, before any check.
pub fn requested_entity_id(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let raw = header(LEGAL_ENTITY_HEADER)
        .or_else(|| header(ACCOUNTING_ENTITY_HEADER))
        .or_else(|| query_param(query, "entityId").filter(|value| !value.is_empty()))
        .unwrap_or_default();
    let id = js_trim(&raw);
    let length = id.encode_utf16().count();
    (length > 0 && length <= 30).then(|| id.to_owned())
}

async fn enabled_for(
    db: &PgPool,
    app: Option<LegalEntityApp>,
    entity_id: &str,
) -> Result<bool, sqlx::Error> {
    match app {
        None => Ok(true),
        Some(app) => app.is_enabled_for(db, entity_id).await,
    }
}

/// The default entity for an app (`defaultEntityIdFor`): the core default
/// when the app is enabled for it, else (WeldBooks, release 1) the deprecated
/// `settings.default_entity_id` when it is.
pub async fn default_entity_id_for(
    db: &PgPool,
    app: Option<LegalEntityApp>,
) -> Result<Option<String>, sqlx::Error> {
    let core: Option<String> = sqlx::query_scalar(
        "select id from entities where is_default = true and deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    if let Some(id) = core
        && enabled_for(db, app, &id).await?
    {
        return Ok(Some(id));
    }
    if app == Some(LegalEntityApp::Weldbooks) {
        let settings: Option<Option<String>> =
            sqlx::query_scalar("select default_entity_id from settings limit 1")
                .fetch_optional(db)
                .await?;
        if let Some(id) = settings.flatten().filter(|id| !id.is_empty())
            && enabled_for(db, app, &id).await?
        {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// Resolve the request's entity against the member's access
/// (`resolveRequestEntity`): `requested` is [`requested_entity_id`]'s answer.
pub async fn resolve_request_entity(
    db: &PgPool,
    access: &EntityAccess,
    requested: Option<&str>,
    app: Option<LegalEntityApp>,
    fallback_to_default: bool,
) -> Result<Option<String>, sqlx::Error> {
    let candidate = match requested {
        Some(id) => Some(id.to_owned()),
        None if fallback_to_default => default_entity_id_for(db, app).await?,
        None => None,
    };
    let Some(candidate) = candidate.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    if !can_see_entity(access, Some(&candidate)) {
        return Ok(None);
    }
    if !enabled_for(db, app, &candidate).await? {
        return Ok(None);
    }
    Ok(Some(candidate))
}

/// What [`legal_entity_context`] settled for a request: the member's access
/// snapshot and the entity the request is about. A request extension, and an
/// extractor (500 when the layer did not run; `Option<RequestEntity>` for
/// routes that may run without it).
#[derive(Debug, Clone)]
pub struct RequestEntity {
    access: Arc<EntityAccess>,
    entity_id: Option<String>,
    requested: Option<String>,
}

impl RequestEntity {
    /// What the layer settled: the snapshot, the resolved entity (`None`
    /// when it resolved none) and the id the request named.
    pub fn new(
        access: Arc<EntityAccess>,
        entity_id: Option<String>,
        requested: Option<String>,
    ) -> Self {
        Self {
            access,
            entity_id,
            requested,
        }
    }

    /// For a route the layer skipped that still needs the request helpers
    /// (TypeScript loads the snapshot lazily there): no resolved entity.
    pub fn unresolved(access: Arc<EntityAccess>, requested: Option<String>) -> Self {
        Self::new(access, None, requested)
    }

    /// [`RequestEntity::unresolved`] with the snapshot loaded now from the
    /// member's workspace permissions and the request's headers and query.
    pub async fn load_unresolved(
        db: &PgPool,
        user_id: &str,
        workspace_permissions: ResolvedPermissions,
        headers: &HeaderMap,
        query: Option<&str>,
    ) -> Result<Self, sqlx::Error> {
        let access = load_entity_access(db, user_id, workspace_permissions).await?;
        Ok(Self::unresolved(
            Arc::new(access),
            requested_entity_id(headers, query),
        ))
    }

    /// The member's access snapshot (`getEntityAccess(c)`).
    pub fn access(&self) -> &EntityAccess {
        &self.access
    }

    /// A shared handle on the snapshot.
    pub fn access_arc(&self) -> Arc<EntityAccess> {
        Arc::clone(&self.access)
    }

    /// The entity the request is about (`c.get('legalEntityId')`); `None`
    /// when it resolved none.
    pub fn entity_id(&self) -> Option<&str> {
        self.entity_id.as_deref()
    }

    /// The id the request named, before any check (`requestedEntityId(c)`).
    pub fn requested(&self) -> Option<&str> {
        self.requested.as_deref()
    }

    /// The layer's answer, if it ran on this request.
    pub fn of(extensions: &Extensions) -> Option<&Self> {
        extensions.get::<Self>()
    }
}

impl<S: Send + Sync> FromRequestParts<S> for RequestEntity {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(parts.extensions.get::<Self>().cloned().ok_or_else(|| {
            tracing::error!(
                "legal entities: RequestEntity extracted on a route without legal_entity_context"
            );
            ApiError::internal()
        }))
    }
}

impl<S: Send + Sync> OptionalFromRequestParts<S> for RequestEntity {
    type Rejection = Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Option<Self>, Self::Rejection>> + Send {
        std::future::ready(Ok(parts.extensions.get::<Self>().cloned()))
    }
}

/// The entity the layer resolved for this request (`getRequestEntityId(c)`):
/// `None` when the layer did not run (callers then use their own fallback),
/// `Some(None)` when it resolved none.
pub fn request_entity_id(extensions: &Extensions) -> Option<Option<&str>> {
    RequestEntity::of(extensions).map(RequestEntity::entity_id)
}

/// For a route that loaded a record by id: may this request touch a record of
/// `record_entity_id` (`recordInRequestEntity`)? True when the member sees
/// that entity and acts there with the same role the request was checked
/// with (the request's entity role, or the workspace role when the request
/// has no entity). Members whose access is the same everywhere always pass,
/// so deep links keep working; a record without an entity passes too. Answer
/// 404 when this is false.
pub fn record_in_request_entity(request: &RequestEntity, record_entity_id: Option<&str>) -> bool {
    let access = request.access();
    if access.uniform {
        return true;
    }
    let Some(record) = record_entity_id.filter(|id| !id.is_empty()) else {
        return true;
    };
    if !can_see_entity(access, Some(record)) {
        return false;
    }
    let request_entity = request.entity_id();
    if request_entity == Some(record) {
        return true;
    }
    entity_role_id(access, Some(record)) == entity_role_id(access, request_entity)
}

/// Filter for list routes that span entities (`visibleEntityFilter`): the
/// entity ids the member sees, or `None` when they see every entity and no
/// filter is needed.
pub fn visible_entity_filter(access: &EntityAccess) -> Option<Vec<String>> {
    if access.sees_all {
        return None;
    }
    let mut visible = Vec::new();
    let mut hidden = false;
    for id in access.entity_ids() {
        if can_see_entity(access, Some(id)) {
            visible.push(id.to_owned());
        } else {
            hidden = true;
        }
    }
    hidden.then_some(visible)
}

/// Which entities a list route may return rows of (`requestEntityScope`):
///
/// - `None`: no filter (the member's access is the same everywhere and the
///   request named no entity);
/// - `[id]`: the entity the request is scoped to;
/// - `[]`: the request named an entity it may not see (list nothing);
/// - several ids: no entity named, so every visible entity where the member
///   acts with their workspace role (the role the request was checked with).
///   Entities where they have an entity role are left out, so leaving the
///   header off never bypasses an entity role.
pub fn request_entity_scope(request: &RequestEntity) -> Option<Vec<String>> {
    if let Some(entity_id) = request.entity_id().filter(|id| !id.is_empty()) {
        return Some(vec![entity_id.to_owned()]);
    }
    if request.requested().is_some() {
        return Some(Vec::new());
    }
    let access = request.access();
    if access.uniform {
        return None;
    }
    Some(
        access
            .entity_ids()
            .filter(|id| {
                can_see_entity(access, Some(id)) && entity_role_id(access, Some(id)).is_none()
            })
            .map(str::to_owned)
            .collect(),
    )
}

/// [`request_entity_scope`] as a SQL condition on a `legal_entity_id`-style
/// column (`entityScopeCondition`). Rows without an entity (from before a
/// workspace had one) count as the default entity's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntityScopeCondition {
    /// No filter (`undefined`).
    All,
    /// Matches nothing (a `false` condition).
    Nothing,
    /// `column in (ids)`, plus `or column is null` when the default entity is
    /// among them.
    In {
        ids: Vec<String>,
        include_unassigned: bool,
    },
}

impl EntityScopeCondition {
    /// The condition over `column`, reading two parameters: `$ids` (`text[]`,
    /// [`EntityScopeCondition::ids_bind`]) and `$unassigned` (`boolean`,
    /// [`EntityScopeCondition::unassigned_bind`]). Static for a given column
    /// and positions, so it fits a hand-written query:
    ///
    /// ```ignore
    /// let sql = format!("select ... from hr_employees t where t.deleted_at is null and {}",
    ///     EntityScopeCondition::sql("t.legal_entity_id", 1, 2));
    /// sqlx::query(&sql).bind(scope.ids_bind()).bind(scope.unassigned_bind())
    /// ```
    pub fn sql(column: &str, ids_param: usize, unassigned_param: usize) -> String {
        format!(
            "(${ids_param}::text[] is null or {column} = any(${ids_param}) \
             or (${unassigned_param}::boolean and {column} is null))"
        )
    }

    /// The `$ids` parameter of [`EntityScopeCondition::sql`]: `None` for no
    /// filter, an empty list for nothing.
    pub fn ids_bind(&self) -> Option<Vec<String>> {
        match self {
            Self::All => None,
            Self::Nothing => Some(Vec::new()),
            Self::In { ids, .. } => Some(ids.clone()),
        }
    }

    /// The `$unassigned` parameter of [`EntityScopeCondition::sql`].
    pub fn unassigned_bind(&self) -> bool {
        matches!(
            self,
            Self::In {
                include_unassigned: true,
                ..
            }
        )
    }

    /// Whether a filter applies at all.
    pub fn is_filtered(&self) -> bool {
        !matches!(self, Self::All)
    }

    /// The condition applied to a row already loaded (its entity, `None` when
    /// it has none).
    pub fn matches(&self, entity_id: Option<&str>) -> bool {
        match self {
            Self::All => true,
            Self::Nothing => false,
            Self::In {
                ids,
                include_unassigned,
            } => match entity_id {
                Some(id) => ids.iter().any(|candidate| candidate == id),
                None => *include_unassigned,
            },
        }
    }
}

/// `entityScopeCondition(column, scope, defaultEntityId)`.
pub fn entity_scope_condition(
    scope: Option<&[String]>,
    default_entity_id: Option<&str>,
) -> EntityScopeCondition {
    match scope {
        None => EntityScopeCondition::All,
        Some([]) => EntityScopeCondition::Nothing,
        Some(ids) => EntityScopeCondition::In {
            include_unassigned: default_entity_id
                .filter(|id| !id.is_empty())
                .is_some_and(|default| ids.iter().any(|id| id == default)),
            ids: ids.to_vec(),
        },
    }
}

type Skip = dyn Fn(&Request) -> bool + Send + Sync;

/// `LegalEntityContextOptions`.
#[derive(Clone)]
pub struct LegalEntityContextOptions {
    /// Only entities this app is enabled for resolve (WeldBooks needs its
    /// extension row).
    pub app: Option<LegalEntityApp>,
    /// Swap in the member's entity role for the request.
    pub scoped: bool,
    /// Use the default entity when the request names none (default true, the
    /// WeldBooks behaviour). WeldHR turns it off: a request without an entity
    /// spans every entity the member acts in with their workspace role, see
    /// [`request_entity_scope`].
    pub fallback_to_default: bool,
    /// Skip the request entirely (no resolution, no swap) when this answers
    /// true, e.g. the entity list the switcher reads, or My HR. It sees the
    /// request as the layer does: inside a nested router `uri().path()` is
    /// relative to the nest, and `axum::extract::OriginalUri` (an extension)
    /// holds the full path.
    pub skip: Option<Arc<Skip>>,
}

impl Default for LegalEntityContextOptions {
    fn default() -> Self {
        Self {
            app: None,
            scoped: false,
            fallback_to_default: true,
            skip: None,
        }
    }
}

impl std::fmt::Debug for LegalEntityContextOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LegalEntityContextOptions")
            .field("app", &self.app)
            .field("scoped", &self.scoped)
            .field("fallback_to_default", &self.fallback_to_default)
            .field("skip", &self.skip.is_some())
            .finish()
    }
}

impl LegalEntityContextOptions {
    /// `{}`: no app, not scoped, the default entity when none is named.
    pub fn new() -> Self {
        Self::default()
    }

    /// `{ app }`.
    #[must_use]
    pub fn app(mut self, app: LegalEntityApp) -> Self {
        self.app = Some(app);
        self
    }

    /// `{ scoped: true }`.
    #[must_use]
    pub fn scoped(mut self) -> Self {
        self.scoped = true;
        self
    }

    /// `{ fallbackToDefault }`.
    #[must_use]
    pub fn fallback_to_default(mut self, fallback: bool) -> Self {
        self.fallback_to_default = fallback;
        self
    }

    /// `{ skip }`.
    #[must_use]
    pub fn skip(mut self, skip: impl Fn(&Request) -> bool + Send + Sync + 'static) -> Self {
        self.skip = Some(Arc::new(skip));
        self
    }
}

/// `legalEntityContext(options)`: a layer for the module's router. `gate` is
/// the module's permission gate: the layer resolves the member's workspace
/// permissions with it once (unless a [`PresetPermissions`] or
/// [`Permissions`] is already on the request) and stores them as the
/// request's [`PresetPermissions`], so the route gates don't resolve again,
/// and it resolves the entity role's permissions through its lookups.
pub fn legal_entity_context<Q>(
    gate: &Arc<PermissionGate<Q>>,
    options: LegalEntityContextOptions,
) -> LegalEntityContextLayer<Q> {
    LegalEntityContextLayer {
        gate: Arc::clone(gate),
        options: Arc::new(options),
    }
}

/// The layer [`legal_entity_context`] returns.
pub struct LegalEntityContextLayer<Q> {
    gate: Arc<PermissionGate<Q>>,
    options: Arc<LegalEntityContextOptions>,
}

impl<Q> Clone for LegalEntityContextLayer<Q> {
    fn clone(&self) -> Self {
        Self {
            gate: Arc::clone(&self.gate),
            options: Arc::clone(&self.options),
        }
    }
}

impl<Q> std::fmt::Debug for LegalEntityContextLayer<Q> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LegalEntityContextLayer")
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

impl<S, Q> Layer<S> for LegalEntityContextLayer<Q> {
    type Service = LegalEntityContextService<S, Q>;

    fn layer(&self, inner: S) -> Self::Service {
        LegalEntityContextService {
            inner,
            layer: self.clone(),
        }
    }
}

/// The service behind [`LegalEntityContextLayer`].
pub struct LegalEntityContextService<S, Q> {
    inner: S,
    layer: LegalEntityContextLayer<Q>,
}

impl<S: Clone, Q> Clone for LegalEntityContextService<S, Q> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            layer: self.layer.clone(),
        }
    }
}

impl<S, Q> Service<Request> for LegalEntityContextService<S, Q>
where
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + 'static,
    S::Future: Send,
    Q: PermissionQueries + 'static,
{
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut request: Request) -> Self::Future {
        // The clone that was polled ready handles this request.
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        let layer = self.layer.clone();
        Box::pin(async move {
            if let Err(error) = settle(&layer.gate, &layer.options, &mut request).await {
                return Ok(error.into_response());
            }
            inner.call(request).await
        })
    }
}

fn database_failure(error: &sqlx::Error) -> ApiError {
    tracing::error!(%error, "legal entities: resolving the request's entity failed");
    ApiError::internal()
}

/// The layer's work on one request.
async fn settle<Q: PermissionQueries + 'static>(
    gate: &PermissionGate<Q>,
    options: &LegalEntityContextOptions,
    request: &mut Request,
) -> Result<(), ApiError> {
    if options.skip.as_ref().is_some_and(|skip| skip(request)) {
        return Ok(());
    }
    // Anything without a member (internal, public) is not about an entity.
    let Some(user_id) = request
        .extensions()
        .get::<AuthContext>()
        .map(|auth| auth.user_id.clone())
        .filter(|id| !id.is_empty())
    else {
        return Ok(());
    };
    let Some(db) = request
        .extensions()
        .get::<Tenant>()
        .map(|tenant| tenant.db.clone())
    else {
        return Ok(());
    };

    // `getEntityAccess(c)`: the workspace permissions, settled once.
    let had_permissions = request.extensions().get::<Permissions>().is_some();
    let Some(workspace) = gate.settle(request.extensions()).await? else {
        return Ok(());
    };
    if !had_permissions {
        request
            .extensions_mut()
            .insert(PresetPermissions(workspace.clone()));
    }
    let access = load_entity_access(&db, &user_id, workspace.resolved().clone())
        .await
        .map_err(|error| database_failure(&error))?;

    let requested = requested_entity_id(request.headers(), request.uri().query());
    let entity_id = resolve_request_entity(
        &db,
        &access,
        requested.as_deref(),
        options.app,
        options.fallback_to_default,
    )
    .await
    .map_err(|error| database_failure(&error))?;

    if options.scoped
        && let Some(entity) = entity_id.as_deref()
        && entity_role_id(&access, Some(entity)).is_some()
    {
        let queries = gate.queries(request.extensions())?;
        let resolved = permissions_in_entity_with(&queries, &access, entity)
            .await
            .map_err(|error| {
                tracing::error!(%error, "legal entities: resolving the entity role failed");
                ApiError::internal()
            })?;
        let scoped = workspace.with_resolved(resolved);
        if had_permissions {
            request.extensions_mut().insert(scoped.clone());
        }
        request.extensions_mut().insert(PresetPermissions(scoped));
    }

    request
        .extensions_mut()
        .insert(RequestEntity::new(Arc::new(access), entity_id, requested));
    Ok(())
}

#[cfg(test)]
mod tests {
    use http::HeaderValue;
    use weldsuite_permissions::ResolvedPermissions;

    use super::*;
    use crate::access::{EntityAccessRow, build_entity_access};

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            if let Ok(value) = HeaderValue::from_str(value) {
                map.insert(*name, value);
            }
        }
        map
    }

    #[test]
    fn the_request_names_its_entity_by_header_then_query() {
        let both = headers(&[
            (LEGAL_ENTITY_HEADER, "ent_new"),
            (ACCOUNTING_ENTITY_HEADER, "ent_old"),
        ]);
        assert_eq!(
            requested_entity_id(&both, Some("entityId=ent_query")).as_deref(),
            Some("ent_new")
        );
        let old = headers(&[(ACCOUNTING_ENTITY_HEADER, "ent_old")]);
        assert_eq!(
            requested_entity_id(&old, Some("entityId=ent_query")).as_deref(),
            Some("ent_old")
        );
        // An empty header falls through, as `||` does.
        let empty = headers(&[(LEGAL_ENTITY_HEADER, "")]);
        assert_eq!(
            requested_entity_id(&empty, Some("entityId=ent_query&entityId=ent_2")).as_deref(),
            Some("ent_query")
        );
        assert_eq!(requested_entity_id(&HeaderMap::new(), None), None);
        assert_eq!(
            requested_entity_id(&HeaderMap::new(), Some("entityId=")),
            None
        );
    }

    #[test]
    fn a_named_id_is_trimmed_and_at_most_30_characters() {
        let padded = headers(&[(LEGAL_ENTITY_HEADER, "  ent_1 ")]);
        assert_eq!(requested_entity_id(&padded, None).as_deref(), Some("ent_1"));
        let blank = headers(&[(LEGAL_ENTITY_HEADER, "   ")]);
        assert_eq!(requested_entity_id(&blank, None), None);
        let thirty = "e".repeat(30);
        let long = headers(&[(LEGAL_ENTITY_HEADER, &thirty)]);
        assert_eq!(requested_entity_id(&long, None), Some(thirty.clone()));
        let too_long = headers(&[(LEGAL_ENTITY_HEADER, &format!("{thirty}x"))]);
        assert_eq!(requested_entity_id(&too_long, None), None);
    }

    fn member_access() -> Arc<EntityAccess> {
        Arc::new(build_entity_access(
            "u_member",
            ResolvedPermissions {
                permissions: vec!["invoices:read".to_owned()],
                role: "MEMBER".to_owned(),
                ..ResolvedPermissions::default()
            },
            vec![
                EntityAccessRow::new("ent_open", false, false, None),
                EntityAccessRow::new("ent_secret", true, false, None),
                EntityAccessRow::new("ent_role", false, true, Some("role_viewer")),
            ],
        ))
    }

    fn admin_access() -> Arc<EntityAccess> {
        Arc::new(build_entity_access(
            "u_admin",
            ResolvedPermissions {
                permissions: vec!["*".to_owned()],
                role: "ADMIN".to_owned(),
                ..ResolvedPermissions::default()
            },
            vec![
                EntityAccessRow::new("ent_open", false, false, None),
                EntityAccessRow::new("ent_secret", true, false, None),
            ],
        ))
    }

    #[test]
    fn records_are_touched_only_with_the_role_the_request_was_checked_with() {
        let in_role = RequestEntity::new(
            member_access(),
            Some("ent_role".to_owned()),
            Some("ent_role".to_owned()),
        );
        assert!(record_in_request_entity(&in_role, Some("ent_role")));
        // Checked with the workspace role (open entity), record in the entity
        // with a Viewer role.
        let open = RequestEntity::new(
            member_access(),
            Some("ent_open".to_owned()),
            Some("ent_open".to_owned()),
        );
        assert!(!record_in_request_entity(&open, Some("ent_role")));
        assert!(!record_in_request_entity(&open, Some("ent_secret")));
        assert!(record_in_request_entity(&open, Some("ent_open")));
        assert!(record_in_request_entity(&open, None));
        // An admin's access is uniform.
        let admin = RequestEntity::new(
            admin_access(),
            Some("ent_open".to_owned()),
            Some("ent_open".to_owned()),
        );
        assert!(record_in_request_entity(&admin, Some("ent_secret")));
        // No entity on the request: the workspace role's entities only.
        let none = RequestEntity::unresolved(member_access(), None);
        assert!(record_in_request_entity(&none, Some("ent_open")));
        assert!(!record_in_request_entity(&none, Some("ent_role")));
    }

    #[test]
    fn the_scope_of_a_request_that_names_no_entity() {
        let none = RequestEntity::unresolved(member_access(), None);
        assert_eq!(
            request_entity_scope(&none),
            Some(vec!["ent_open".to_owned()])
        );
        let admin = RequestEntity::unresolved(admin_access(), None);
        assert_eq!(request_entity_scope(&admin), None);
        let hidden = RequestEntity::new(member_access(), None, Some("ent_secret".to_owned()));
        assert_eq!(request_entity_scope(&hidden), Some(Vec::new()));
        let named = RequestEntity::new(
            member_access(),
            Some("ent_role".to_owned()),
            Some("ent_role".to_owned()),
        );
        assert_eq!(
            request_entity_scope(&named),
            Some(vec!["ent_role".to_owned()])
        );
    }

    #[test]
    fn the_visible_filter_is_none_when_nothing_is_hidden() {
        assert_eq!(visible_entity_filter(&admin_access()), None);
        assert_eq!(
            visible_entity_filter(&member_access()),
            Some(vec!["ent_open".to_owned(), "ent_role".to_owned()])
        );
    }

    #[test]
    fn scope_conditions_count_unassigned_rows_as_the_default_entity() {
        assert_eq!(
            entity_scope_condition(None, Some("ent_open")),
            EntityScopeCondition::All
        );
        assert_eq!(
            entity_scope_condition(Some(&[]), Some("ent_open")),
            EntityScopeCondition::Nothing
        );
        let with_default = entity_scope_condition(Some(&["ent_open".to_owned()]), Some("ent_open"));
        assert!(with_default.matches(None));
        assert!(with_default.matches(Some("ent_open")));
        assert!(!with_default.matches(Some("ent_role")));
        assert!(with_default.unassigned_bind());
        let without = entity_scope_condition(Some(&["ent_role".to_owned()]), Some("ent_open"));
        assert!(!without.matches(None));
        assert_eq!(without.ids_bind(), Some(vec!["ent_role".to_owned()]));
        assert_eq!(EntityScopeCondition::Nothing.ids_bind(), Some(Vec::new()));
        assert_eq!(EntityScopeCondition::All.ids_bind(), None);
        assert_eq!(
            EntityScopeCondition::sql("t.legal_entity_id", 3, 4),
            "($3::text[] is null or t.legal_entity_id = any($3) or ($4::boolean and t.legal_entity_id is null))"
        );
    }
}
