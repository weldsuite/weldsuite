//! The public share routes (`routes/public/index.ts`, `services/share-links.ts`),
//! `/public/panel/share/*`, with no session: the token in the path is the
//! only credential.
//!
//!   GET  /share/:token          → the link's page: names, the project's name, report
//!                                 kinds and specs (filter values, cohort ids and the
//!                                 project id taken out), the dashboard's layout and text tiles
//!   POST /share/:token/results  → `{ tileId?, dateRange? }`: one report's (or dashboard
//!                                 tile's) result, through the same cache and scope as
//!                                 `POST /api/panel/query`
//!
//! Anything wrong (a malformed, unknown, revoked or expired token, a
//! suspended or unknown workspace, a deleted target, a report that may no
//! longer be shared, a tile the link does not show) is the same 404.
//! Requests are limited per address ([`ShareRateLimit`]); answers are never
//! cached or indexed.
//!
//! The link's workspace comes from the master `panel_share_registry`, and
//! its tenant database from [`WorkspaceTenants`] (the server's workspaces;
//! in conformance, the test's own lookup).

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use http::{HeaderMap, HeaderValue, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use weldsuite_db::{MasterDb, PgPool, orm};
use weldsuite_kit::{ApiError, Data, RequestEnv};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::schemas::PanelQuerySpec;
use weldsuite_ports::{BoxFuture, DynCache, OutboundHttp, PortError, RequestCache};
use weldsuite_schema::master::panel_share_registry;
use weldsuite_schema::tenant::{panel_projects, panel_share_links};

use crate::engine::{AnalyticsSql, BasinSql};
use crate::keys::sha256_hex;
use crate::project_state::{PanelProjectState, RequestProjectState};
use crate::query::{QueryDeps, run_cached_query};
use crate::saved::{
    Actor, Target, apply_dashboard_filters, can_see, field, get_target, instant, js_row,
    list_tiles, parse_dashboard_filters, report_in, text, tile_reports, tile_spec,
};
use crate::schemas_gen::PANEL_PUBLIC_RESULTS;
use crate::share_links::{is_share_token, public_spec, share_refusals};
use crate::{PanelState, unexpected};

/// `PANEL_DATE_PRESETS`.
const DATE_PRESETS: &[&str] = &["today", "7d", "30d", "90d", "12m"];

/// Requests per address and minute (`PANEL_SHARE_RATE_LIMIT`: 300 a minute).
const RATE_LIMIT: i64 = 300;

/// A link's views are counted at most once a minute.
const VIEW_COUNT_INTERVAL_MS: i64 = 60_000;

/// A workspace's tenant database, as a public link opens it.
#[derive(Clone)]
pub struct OpenedWorkspace {
    pub db: PgPool,
    pub suspended: bool,
}

/// Opens a workspace's tenant database by `workspaces.id`
/// (`getWorkspaceContextForOrg`), outside a member's request. `None` when
/// there is no such workspace.
pub trait WorkspaceTenants: Send + Sync {
    fn open<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<OpenedWorkspace>, PortError>>;

    /// `getWorkspaceContextForOrg(env, reference)` by `workspaces.id` or the
    /// Clerk org id, with the ids it names (the internal read API, which acts
    /// in a workspace other workers name). `None` when there is no such
    /// workspace. Without its own lookup, [`Self::open`] with the
    /// reference as the id.
    fn find<'a>(
        &'a self,
        reference: &'a str,
    ) -> BoxFuture<'a, Result<Option<FoundWorkspace>, PortError>> {
        Box::pin(async move {
            Ok(self.open(reference).await?.map(|opened| FoundWorkspace {
                id: reference.to_owned(),
                clerk_org_id: None,
                db: opened.db,
                suspended: opened.suspended,
            }))
        })
    }
}

/// A workspace found by reference ([`WorkspaceTenants::find`]).
#[derive(Clone)]
pub struct FoundWorkspace {
    /// `workspaces.id`.
    pub id: String,
    pub clerk_org_id: Option<String>,
    pub db: PgPool,
    pub suspended: bool,
}

/// The workspaces a request opens (conformance: the test's lookup). Without
/// it the routes use [`PanelState::tenants`].
#[derive(Clone)]
pub struct RequestWorkspaceTenants(pub Arc<dyn WorkspaceTenants>);

/// `PANEL_SHARE_RATE_LIMIT.limit({ key })`: whether a request of the
/// address `key` (a hash) may go on.
pub trait ShareRateLimit: Send + Sync {
    fn limit<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, PortError>>;
}

/// The rate limiter a request uses (conformance: the test's binding, or
/// none, as the worker without it).
#[derive(Clone, Default)]
pub struct RequestShareRateLimit(pub Option<Arc<dyn ShareRateLimit>>);

/// The limit on the cache: a counter per address and minute.
pub struct CacheShareRateLimit {
    cache: Arc<dyn DynCache>,
}

impl CacheShareRateLimit {
    pub fn new(cache: Arc<dyn DynCache>) -> Self {
        Self { cache }
    }
}

impl ShareRateLimit for CacheShareRateLimit {
    fn limit<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(async move {
            let minute = js::now_millis().div_euclid(60_000);
            let count = self
                .cache
                .increment_boxed(
                    &format!("panel:share-rl:{key}:{minute}"),
                    1,
                    Some(Duration::from_secs(120)),
                )
                .await?;
            Ok(count <= RATE_LIMIT)
        })
    }
}

/// Who opens a link: what the request brings (conformance: the test's
/// bindings), else the state's.
pub(crate) struct Visitor {
    env: Option<RequestEnv>,
    cache: Option<Arc<dyn DynCache>>,
    master: Option<PgPool>,
    outbound: Option<OutboundHttp>,
    project_state: Option<RequestProjectState>,
    tenants: Option<RequestWorkspaceTenants>,
    limiter: Option<RequestShareRateLimit>,
}

impl<S: Send + Sync> FromRequestParts<S> for Visitor {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        std::future::ready(Ok(Self {
            env: extensions.get::<RequestEnv>().cloned(),
            cache: extensions
                .get::<RequestCache>()
                .map(|cache| Arc::clone(&cache.0)),
            master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
            outbound: extensions.get::<OutboundHttp>().cloned(),
            project_state: extensions.get::<RequestProjectState>().cloned(),
            tenants: extensions.get::<RequestWorkspaceTenants>().cloned(),
            limiter: extensions.get::<RequestShareRateLimit>().cloned(),
        }))
    }
}

impl Visitor {
    fn conformance(&self) -> bool {
        self.env.is_some()
    }

    fn env(&self, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(name).map(str::to_owned),
            None => std::env::var(name).ok(),
        }
        .filter(|value| !value.is_empty())
    }

    fn now(&self) -> Option<i64> {
        if !self.conformance() {
            return None;
        }
        self.env("CONFORMANCE_NOW")
            .and_then(|now| js::parse_iso(&now))
    }

    fn master(&self, state: &PanelState) -> Option<PgPool> {
        if self.conformance() {
            return self.master.clone();
        }
        state.master.clone()
    }

    fn cache(&self, state: &PanelState) -> Option<Arc<dyn DynCache>> {
        if self.conformance() {
            return self.cache.clone();
        }
        state.cache.clone()
    }

    fn tenants(&self, state: &PanelState) -> Option<Arc<dyn WorkspaceTenants>> {
        match &self.tenants {
            Some(tenants) => Some(Arc::clone(&tenants.0)),
            None => state.tenants.clone(),
        }
    }

    fn limiter(&self, state: &PanelState) -> Option<Arc<dyn ShareRateLimit>> {
        if let Some(limiter) = &self.limiter {
            return limiter.0.clone();
        }
        if self.conformance() {
            return None;
        }
        state
            .cache
            .clone()
            .map(|cache| Arc::new(CacheShareRateLimit::new(cache)) as Arc<dyn ShareRateLimit>)
    }

    fn analytics(&self, state: &PanelState) -> Option<Arc<dyn AnalyticsSql>> {
        if self.conformance() {
            let token = self.env("R2_SQL_API_TOKEN")?;
            let account_id = self.env("CF_ACCOUNT_ID")?;
            let bucket = self.env("PANEL_BASIN_BUCKET")?;
            let http = self.outbound.clone()?;
            return Some(Arc::new(BasinSql::new(http, token, account_id, bucket)));
        }
        state.sql.clone()
    }

    fn project_state(&self, state: &PanelState) -> Option<Arc<dyn PanelProjectState>> {
        if self.conformance() {
            return self.project_state.as_ref().and_then(|s| s.0.clone());
        }
        state.project_state.clone()
    }
}

/// The visitor's address: on Global Cloudflare's `CF-Connecting-IP`; here
/// the `X-Forwarded-For` entry the ingress appended (`trusted_proxies` from
/// the right), since a client could send a new `CF-Connecting-IP` with
/// every request. Conformance builds read the header the test's requests
/// carry, as the worker does.
fn address(headers: &HeaderMap, trusted_proxies: usize, conformance: bool) -> Option<String> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    if conformance {
        return header("cf-connecting-ip");
    }
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|hop| !hop.is_empty())
        .collect();
    hops.len()
        .checked_sub(trusted_proxies.max(1))
        .and_then(|at| hops.get(at))
        .map(|hop| (*hop).to_owned())
}

/// `addressKey(ip)`: the first eight bytes of the address's SHA-256, so the
/// address itself is never passed on.
fn address_key(ip: &str) -> String {
    hex::encode(&Sha256::digest(ip.as_bytes())[..8])
}

/// The per-address limit and the answer headers (`rateLimit`): a missing
/// limiter or address is not limited, a failing limiter lets the request
/// through; every answer after it is `no-store` and `noindex`.
pub(crate) async fn rate_limit(
    State(state): State<PanelState>,
    visitor: Visitor,
    request: Request,
    next: Next,
) -> Response {
    let limiter = visitor.limiter(&state);
    let ip = address(
        request.headers(),
        state.trusted_proxies,
        visitor.conformance(),
    );
    if let (Some(limiter), Some(ip)) = (limiter, ip) {
        let allowed = match limiter.limit(&address_key(&ip)).await {
            Ok(allowed) => allowed,
            Err(error) => {
                tracing::warn!(%error, "[panel-api] share rate limiter failed, not limiting");
                true
            }
        };
        if !allowed {
            return ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Too many requests. Try again in a minute.",
            )
            .into_response();
        }
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert(
        "x-robots-tag",
        HeaderValue::from_static("noindex, nofollow"),
    );
    response
}

/// An open link (`OpenedShare`).
struct Opened {
    workspace_id: String,
    db: PgPool,
    link: Value,
    project: Value,
    target: Target,
}

/// The link's creator as an actor: what the link shows is what they may see.
fn creator_of(link: &Value) -> Actor {
    Actor {
        user_id: text(link, "createdByUserId").to_owned(),
        can_manage: false,
    }
}

/// Whether `at` (an ISO moment, or none) is at or before `now`.
fn expired(at: Option<&str>, now: i64) -> bool {
    at.and_then(js::parse_iso).is_some_and(|at| at <= now)
}

/// `openShare(env, master, token)`: the link behind a token, its
/// workspace's tenant database, project and target, or `None` for
/// anything wrong.
async fn open_share(
    visitor: &Visitor,
    state: &PanelState,
    token: &str,
) -> Result<Option<Opened>, String> {
    if !is_share_token(token) {
        return Ok(None);
    }
    let now = visitor.now().unwrap_or_else(js::now_millis);
    let Some(master) = visitor.master(state) else {
        return Err("no master database".to_owned());
    };
    let token_hash = sha256_hex(token);
    let entry = panel_share_registry::Entity::find_by_id(&token_hash)
        .one(&orm(&master))
        .await
        .and_then(|entry| entry.map(js_row).transpose())
        .map_err(|error| error.to_string())?;
    let Some(entry) = entry else {
        return Ok(None);
    };
    if entry.get("revokedAt").is_some_and(|at| !at.is_null())
        || expired(entry.get("expiresAt").and_then(Value::as_str), now)
    {
        return Ok(None);
    }
    let workspace_id = text(&entry, "workspaceId").to_owned();
    let Some(tenants) = visitor.tenants(state) else {
        return Ok(None);
    };
    let db = match tenants.open(&workspace_id).await {
        Ok(Some(workspace)) if !workspace.suspended => workspace.db,
        Ok(_) => return Ok(None),
        Err(error) => {
            tracing::warn!(%error, "[panel-api] a shared link's workspace did not open");
            return Ok(None);
        }
    };
    let link = panel_share_links::Entity::find_by_id(text(&entry, "linkId"))
        .filter(panel_share_links::Column::TokenHash.eq(&token_hash))
        .one(&orm(&db))
        .await
        .and_then(|link| link.map(js_row).transpose())
        .map_err(|error| error.to_string())?;
    let Some(link) = link else {
        return Ok(None);
    };
    if link.get("revokedAt").is_some_and(|at| !at.is_null())
        || expired(link.get("expiresAt").and_then(Value::as_str), now)
    {
        return Ok(None);
    }
    let project = panel_projects::Entity::find_by_id(text(&link, "projectId"))
        .filter(panel_projects::Column::DeletedAt.is_null())
        .one(&orm(&db))
        .await
        .and_then(|project| project.map(js_row).transpose())
        .map_err(|error| error.to_string())?;
    let Some(project) = project else {
        return Ok(None);
    };
    let target = get_target(&db, text(&link, "targetType"), text(&link, "targetId"))
        .await
        .map_err(|error| error.to_string())?;
    let Some(target) = target else {
        return Ok(None);
    };
    if text(&target.row, "projectId") != text(&project, "id")
        || !can_see(&target.row, &creator_of(&link))
        || (target.target_type == "report" && !share_refusals(&target.row).is_empty())
    {
        return Ok(None);
    }
    Ok(Some(Opened {
        workspace_id,
        db,
        link,
        project,
        target,
    }))
}

/// `shownTiles`: a dashboard's tiles a link may show (text tiles, and
/// report tiles of live, visible, shareable reports), and those reports.
async fn shown_tiles(opened: &Opened) -> Result<(Vec<Value>, Vec<Value>), DbErr> {
    let tiles = list_tiles(&opened.db, text(&opened.target.row, "id")).await?;
    let creator = creator_of(&opened.link);
    let reports: Vec<Value> = tile_reports(&opened.db, &tiles)
        .await?
        .into_iter()
        .filter(|report| can_see(report, &creator) && share_refusals(report).is_empty())
        .collect();
    let tiles = tiles
        .into_iter()
        .filter(|tile| {
            text(tile, "kind") == "text"
                || tile
                    .get("reportId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| report_in(&reports, id).is_some())
        })
        .collect();
    Ok((tiles, reports))
}

/// `toPublicReport(report, spec)`.
fn public_report(report: &Value, spec: &Value) -> Value {
    json!({
        "name": field(report, "name"),
        "description": field(report, "description"),
        "kind": field(report, "kind"),
        "spec": public_spec(spec),
    })
}

/// `publicShareDto(opened)`.
async fn public_share_dto(opened: &Opened) -> Result<Value, DbErr> {
    let link = &opened.link;
    let allow_date_change = link.get("allowDateChange").and_then(Value::as_bool) == Some(true);
    let mut dto = json!({
        "targetType": opened.target.target_type,
        "name": field(&opened.target.row, "name"),
        "description": field(&opened.target.row, "description"),
        "projectName": field(&opened.project, "name"),
        "allowEmbed": field(link, "allowEmbed"),
        "allowDateChange": field(link, "allowDateChange"),
        "datePresets": if allow_date_change { DATE_PRESETS } else { &[] },
        "expiresAt": field(link, "expiresAt"),
    });
    if opened.target.target_type == "report" {
        dto["report"] = public_report(&opened.target.row, &field(&opened.target.row, "spec"));
        dto["tiles"] = json!([]);
        return Ok(dto);
    }
    let filters = parse_dashboard_filters(opened.target.row.get("filters"));
    let (tiles, reports) = shown_tiles(opened).await?;
    let shown: Vec<Value> = tiles
        .iter()
        .map(|tile| {
            let report = tile
                .get("reportId")
                .and_then(Value::as_str)
                .and_then(|id| report_in(&reports, id));
            let is_text = text(tile, "kind") == "text";
            json!({
                "id": field(tile, "id"),
                "kind": field(tile, "kind"),
                "layout": field(tile, "layout"),
                "text": if is_text { field(tile, "text") } else { Value::Null },
                "report": report.map_or(Value::Null, |report| {
                    public_report(report, &apply_dashboard_filters(&field(report, "spec"), filters.as_ref()))
                }),
            })
        })
        .collect();
    dto["report"] = Value::Null;
    dto["tiles"] = Value::Array(shown);
    Ok(dto)
}

/// `recordView(db, link)`: a view, counted at most once a minute.
async fn record_view(opened: &Opened, now: i64) -> Result<(), DbErr> {
    use panel_share_links::Column;
    panel_share_links::Entity::update_many()
        .col_expr(
            Column::ViewCount,
            sea_orm::ExprTrait::add(Expr::col(Column::ViewCount), 1),
        )
        .col_expr(Column::LastViewedAt, Expr::value(instant(now)))
        .filter(Column::Id.eq(text(&opened.link, "id")))
        .filter(
            Condition::any()
                .add(Column::LastViewedAt.is_null())
                .add(Column::LastViewedAt.lt(instant(now - VIEW_COUNT_INTERVAL_MS))),
        )
        .exec(&orm(&opened.db))
        .await?;
    Ok(())
}

fn not_found() -> Response {
    ApiError::not_found("Share link", None).into_response()
}

/// `GET /share/:token`.
pub(crate) async fn show(
    State(state): State<PanelState>,
    visitor: Visitor,
    Path(token): Path<String>,
) -> Response {
    let opened = match open_share(&visitor, &state, &token).await {
        Ok(Some(opened)) => opened,
        Ok(None) => return not_found(),
        Err(error) => return unexpected(&error, "open share link"),
    };
    let body = match public_share_dto(&opened).await {
        Ok(body) => body,
        Err(error) => return unexpected(&error, "open share link"),
    };
    let now = visitor.now().unwrap_or_else(js::now_millis);
    if let Err(error) = record_view(&opened, now).await {
        tracing::warn!(%error, "[panel-api] share view count failed");
    }
    Data(body).into_response()
}

/// `publicResultSpec(opened, input)`: the spec a results request runs, or
/// `None` when it names nothing the link shows. A preset counts only when
/// the link allows date changes.
async fn public_result_spec(
    opened: &Opened,
    input: &Map<String, Value>,
) -> Result<Option<Map<String, Value>>, DbErr> {
    let allow_date_change =
        opened.link.get("allowDateChange").and_then(Value::as_bool) == Some(true);
    let date_range = input.get("dateRange").filter(|_| allow_date_change);
    let tile_id = input.get("tileId").and_then(Value::as_str);
    if opened.target.target_type == "report" {
        if tile_id.is_some() {
            return Ok(None);
        }
        return Ok(tile_spec(
            &field(&opened.target.row, "spec"),
            None,
            date_range,
        ));
    }
    let Some(tile_id) = tile_id else {
        return Ok(None);
    };
    let (tiles, reports) = shown_tiles(opened).await?;
    let report = tiles
        .iter()
        .find(|tile| text(tile, "id") == tile_id && text(tile, "kind") == "report")
        .and_then(|tile| tile.get("reportId").and_then(Value::as_str))
        .and_then(|id| report_in(&reports, id));
    let Some(report) = report else {
        return Ok(None);
    };
    let filters = parse_dashboard_filters(opened.target.row.get("filters"));
    Ok(tile_spec(
        &field(report, "spec"),
        filters.as_ref(),
        date_range,
    ))
}

/// `POST /share/:token/results`.
pub(crate) async fn results(
    State(state): State<PanelState>,
    visitor: Visitor,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&PANEL_PUBLIC_RESULTS, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let opened = match open_share(&visitor, &state, &token).await {
        Ok(Some(opened)) => opened,
        Ok(None) => return not_found(),
        Err(error) => return unexpected(&error, "open share link"),
    };
    let parsed = match public_result_spec(&opened, &input.body).await {
        Ok(Some(parsed)) => Value::Object(parsed),
        Ok(None) => return not_found(),
        Err(error) => return unexpected(&error, "open share link"),
    };
    let spec: PanelQuerySpec = match serde_json::from_value(parsed.clone()) {
        Ok(spec) => spec,
        Err(error) => return unexpected(&error, "a parsed spec the compiler can't read"),
    };
    let deps = QueryDeps {
        tenant: opened.db.clone(),
        master: visitor.master(&state),
        cache: visitor.cache(&state),
        engine: visitor.analytics(&state),
        state: visitor.project_state(&state),
        workspace_id: opened.workspace_id.clone(),
        now: visitor.now(),
    };
    let entry = match run_cached_query(&deps, &parsed, &spec).await {
        Ok(entry) => entry,
        Err(failure) => return failure.into_response(),
    };
    let mut response = match entry.result {
        Value::Object(result) => result,
        _ => Map::new(),
    };
    if let Some(data_as_of) = entry.data_as_of {
        response.insert("dataAsOf".to_owned(), data_as_of);
    }
    response.insert("cached".to_owned(), Value::Bool(entry.cached));
    Data(Value::Object(response)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_hash_and_come_from_the_ingress() {
        assert_eq!(address_key("203.0.113.9").len(), 16);
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", HeaderValue::from_static("203.0.113.9"));
        assert_eq!(address(&headers, 1, false), None);
        assert_eq!(address(&headers, 1, true).as_deref(), Some("203.0.113.9"));
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("6.6.6.6, 198.51.100.7"),
        );
        assert_eq!(address(&headers, 1, false).as_deref(), Some("198.51.100.7"));
    }

    #[test]
    fn expiry_is_inclusive() {
        assert!(expired(
            Some("2026-01-01T00:00:00.000Z"),
            js::parse_iso("2026-01-01T00:00:00Z").unwrap_or(0)
        ));
        assert!(!expired(None, 0));
    }
}
