//! `/api/panel/share-links` (`routes/share-links/index.ts`,
//! `services/share-links.ts`): public links to a report or a dashboard.
//!
//!   GET    /       → ?targetType&targetId: the target's links (revoked ones too), newest first
//!   POST   /       → new link: answers the token and the URL, once
//!   DELETE /:id    → revoke (tenant row and master registry); safe to repeat
//!
//! The token (`wpsh_` + 32 letters and digits) is shown once; only its
//! SHA-256 is kept, in the tenant row and in the master
//! `panel_share_registry` (which the public routes read to find the
//! workspace). People data never leaves through a link: a report whose kind
//! is not an aggregate, or that breaks down by a person property, the full
//! URL or element text, is refused (422 `NOT_SHAREABLE`).

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_SHARE_LINK_CREATED, PANEL_SHARE_LINK_DELETED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::id::{ALPHANUMERIC, random_string};
use weldsuite_kit::{ApiError, Created, List, NoContent, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_permissions::Permissions;

use crate::keys::sha256_hex;
use weldsuite_schema::master::panel_share_registry;
use weldsuite_schema::tenant::panel_share_links;

use crate::saved::{
    Actor, Target, can_change, can_see, field, get_target, instant, js_row, js_rows, list_tiles,
    target_label, text, tile_reports,
};
use crate::schemas_gen::{CREATE_PANEL_SHARE_LINK, PANEL_TARGET_QUERY};
use crate::{Caller, PanelState, unexpected};

/// `wpsh_` and the first four characters: what the list shows.
const PREFIX_LENGTH: usize = 9;
/// Live links one report or dashboard may have at once.
const MAX_ACTIVE_LINKS_PER_TARGET: u64 = 20;
/// Links listed per target, newest first.
const MAX_LISTED: u64 = 100;
const DEFAULT_PLATFORM_URL: &str = "https://app.weldsuite.org";

/// `PANEL_SHAREABLE_KINDS`: aggregates only.
const SHAREABLE_KINDS: &[&str] = &[
    "web",
    "trends",
    "funnel",
    "retention",
    "flows",
    "stickiness",
    "lifecycle",
    "vitals",
];

/// `PANEL_UNSHAREABLE_COLUMNS`: free text and full URLs can carry personal data.
const UNSHAREABLE_COLUMNS: &[&str] = &["el_text", "url"];

/// `generateShareToken()`.
fn generate_share_token() -> String {
    format!("wpsh_{}", random_string(32, ALPHANUMERIC))
}

/// `PANEL_SHARE_TOKEN.test(token)`: `wpsh_` and 32 letters and digits.
pub(crate) fn is_share_token(token: &str) -> bool {
    token.len() == 37
        && token.starts_with("wpsh_")
        && token[5..].bytes().all(|b| b.is_ascii_alphanumeric())
}

/// `toShareLinkDto(row)`.
fn dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "targetType": field(row, "targetType"),
        "targetId": field(row, "targetId"),
        "prefix": format!("{}…", text(row, "tokenPrefix")),
        "allowEmbed": field(row, "allowEmbed"),
        "allowDateChange": field(row, "allowDateChange"),
        "expiresAt": field(row, "expiresAt"),
        "revokedAt": field(row, "revokedAt"),
        "lastViewedAt": field(row, "lastViewedAt"),
        "viewCount": field(row, "viewCount"),
        "createdByUserId": field(row, "createdByUserId"),
        "createdAt": field(row, "createdAt"),
    })
}

/// `shareLinkEventData(row)`: the token's prefix, never the token.
fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "targetType": field(row, "targetType"),
        "targetId": field(row, "targetId"),
        "prefix": format!("{}…", text(row, "tokenPrefix")),
    })
}

fn publish(caller: &Caller, state: &PanelState, link: &Value, event: EventName) {
    caller.publish(state, event, text(link, "id"), &event_data(link));
}

// ---------------------------------------------------------------------------
// What may be shared
// ---------------------------------------------------------------------------

/// `breakdownsOf(spec)`: every breakdown a stored spec keeps.
fn breakdowns_of(spec: &Value) -> Vec<&Value> {
    let mut out = Vec::new();
    for key in ["breakdown", "holdConstant"] {
        if let Some(value) = spec.get(key).filter(|v| v.is_object()) {
            out.push(value);
        }
    }
    if let Some(list) = spec.get("breakdowns").and_then(Value::as_array) {
        out.extend(list.iter().filter(|v| v.is_object()));
    }
    out
}

/// `shareRefusals(report)`: why a report may not be shown on a public link.
pub(crate) fn share_refusals(report: &Value) -> Vec<&'static str> {
    let mut reasons: Vec<&'static str> = Vec::new();
    let mut add = |reason: &'static str| {
        if !reasons.contains(&reason) {
            reasons.push(reason);
        }
    };
    let spec = field(report, "spec");
    let spec_kind = spec.get("kind").and_then(Value::as_str);
    if !SHAREABLE_KINDS.contains(&text(report, "kind"))
        || spec_kind.is_some_and(|kind| !SHAREABLE_KINDS.contains(&kind))
    {
        add("kind");
    }
    for breakdown in breakdowns_of(&spec) {
        let source = breakdown.get("source").and_then(Value::as_str);
        if source == Some("person") {
            add("person_breakdown");
        }
        if source == Some("column")
            && breakdown
                .get("field")
                .and_then(Value::as_str)
                .is_some_and(|field| UNSHAREABLE_COLUMNS.contains(&field))
        {
            add("column_breakdown");
        }
    }
    reasons
}

/// `targetRefusals(db, target)`: every reason the target (a report, or each
/// report on a dashboard) may not be shared.
async fn target_refusals(db: &PgPool, target: &Target) -> Result<Vec<Value>, DbErr> {
    let reports = if target.target_type == "report" {
        vec![target.row.clone()]
    } else {
        let tiles = list_tiles(db, text(&target.row, "id")).await?;
        tile_reports(db, &tiles).await?
    };
    Ok(reports
        .iter()
        .flat_map(|report| {
            share_refusals(report)
                .into_iter()
                .map(|reason| json!({ "reportId": field(report, "id"), "reason": reason }))
        })
        .collect())
}

/// `publicSpec(spec)`: the project id, every filter value and every cohort
/// id taken out (the filters stay, so the page can say it is filtered).
pub(crate) fn public_spec(spec: &Value) -> Value {
    fn strip(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(strip).collect()),
            Value::Object(object) => {
                let is_filter = object.contains_key("source")
                    && (object.contains_key("operator")
                        || object.get("source").and_then(Value::as_str) == Some("cohort"));
                let out: Map<String, Value> = object
                    .iter()
                    .filter(|(key, _)| !(is_filter && (*key == "value" || *key == "cohortId")))
                    .map(|(key, inner)| (key.clone(), strip(inner)))
                    .collect();
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    let mut rest = spec.as_object().cloned().unwrap_or_default();
    rest.remove("projectId");
    strip(&Value::Object(rest))
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/// `GET /`.
pub(crate) async fn list(
    caller: Caller,
    permissions: Permissions,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&PANEL_TARGET_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let target_type = query.text("targetType").unwrap_or_default().to_owned();
    let target_id = query.text("targetId").unwrap_or_default().to_owned();
    let actor = Actor::of(&caller, &permissions);
    match get_target(&caller.db, &target_type, &target_id).await {
        Ok(Some(target)) if can_see(&target.row, &actor) => {}
        Ok(_) => {
            return ApiError::not_found(target_label(&target_type), Some(&target_id))
                .into_response();
        }
        Err(error) => return unexpected(&error, "list share links"),
    }
    let found = panel_share_links::Entity::find()
        .filter(panel_share_links::Column::TargetType.eq(&target_type))
        .filter(panel_share_links::Column::TargetId.eq(&target_id))
        .order_by_desc(panel_share_links::Column::CreatedAt)
        .order_by_asc(panel_share_links::Column::Id)
        .limit(MAX_LISTED)
        .all(&orm(&caller.db))
        .await
        .and_then(js_rows);
    match found {
        Ok(found) => {
            let links: Vec<Value> = found.iter().map(dto).collect();
            let count = links.len() as u64;
            List::new(links, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list share links"),
    }
}

/// What creating a link can refuse or fail with (`ShareLinkError`).
enum CreateFailure {
    Bad(String),
    Conflict(String),
    Failed(DbErr),
}

impl From<DbErr> for CreateFailure {
    fn from(error: DbErr) -> Self {
        Self::Failed(error)
    }
}

/// `createShareLink`: the tenant row, then the master registry row (the
/// tenant row is taken out again when that fails). The row and the token,
/// which is never stored.
async fn create_link(
    caller: &Caller,
    master: &PgPool,
    target: &Target,
    input: &Map<String, Value>,
) -> Result<(Value, String), CreateFailure> {
    let now = caller.now().unwrap_or_else(js::now_millis);
    let expires_at = input
        .get("expiresAt")
        .and_then(Value::as_str)
        .and_then(js::parse_iso);
    if expires_at.is_some_and(|at| at <= now) {
        return Err(CreateFailure::Bad(
            "The expiry date must be in the future".to_owned(),
        ));
    }
    let active = panel_share_links::Entity::find()
        .filter(panel_share_links::Column::TargetType.eq(target.target_type))
        .filter(panel_share_links::Column::TargetId.eq(text(&target.row, "id")))
        .filter(panel_share_links::Column::RevokedAt.is_null())
        .count(&orm(&caller.db))
        .await?;
    if active >= MAX_ACTIVE_LINKS_PER_TARGET {
        return Err(CreateFailure::Conflict(format!(
            "At most {MAX_ACTIVE_LINKS_PER_TARGET} links per {}; revoke one first",
            target.target_type
        )));
    }
    let token = generate_share_token();
    let token_hash = sha256_hex(&token);
    let expires_at = expires_at.map(instant);
    let created = panel_share_links::Entity::insert(panel_share_links::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id("pnsl")),
        project_id: Set(text(&target.row, "projectId").to_owned()),
        target_type: Set(target.target_type.to_owned()),
        target_id: Set(text(&target.row, "id").to_owned()),
        token_hash: Set(token_hash.clone()),
        token_prefix: Set(token[..PREFIX_LENGTH].to_owned()),
        allow_embed: Set(input
            .get("allowEmbed")
            .and_then(Value::as_bool)
            .unwrap_or(false)),
        allow_date_change: Set(input
            .get("allowDateChange")
            .and_then(Value::as_bool)
            .unwrap_or(false)),
        expires_at: Set(expires_at),
        created_by_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await?;
    let registered = panel_share_registry::Entity::insert(panel_share_registry::ActiveModel {
        token_hash: Set(token_hash),
        workspace_id: Set(caller.workspace_id.clone()),
        project_id: Set(created.project_id.clone()),
        link_id: Set(created.id.clone()),
        expires_at: Set(expires_at),
        ..Default::default()
    })
    .exec_without_returning(&orm(master))
    .await;
    if let Err(error) = registered {
        panel_share_links::Entity::delete_by_id(created.id)
            .exec(&orm(&caller.db))
            .await?;
        return Err(CreateFailure::Failed(error));
    }
    Ok((js_row(created)?, token))
}

/// `panelShareUrl(platformUrl, token)`.
fn share_url(platform_url: &str, token: &str) -> String {
    format!("{}/s/panel/{token}", platform_url.trim_end_matches('/'))
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_SHARE_LINK, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let target_type = input.text("targetType").unwrap_or_default().to_owned();
    let target_id = input.text("targetId").unwrap_or_default().to_owned();
    let actor = Actor::of(&caller, &permissions);
    let target = match get_target(&caller.db, &target_type, &target_id).await {
        Ok(Some(target)) if can_see(&target.row, &actor) => target,
        Ok(_) => {
            return ApiError::not_found(target_label(&target_type), Some(&target_id))
                .into_response();
        }
        Err(error) => return unexpected(&error, "create share link"),
    };
    if !can_change(&target.row, &actor) {
        return ApiError::forbidden()
            .with_message(format!("Only the owner can share this {target_type}"))
            .into_response();
    }
    let reasons = match target_refusals(&caller.db, &target).await {
        Ok(reasons) => reasons,
        Err(error) => return unexpected(&error, "create share link"),
    };
    if !reasons.is_empty() {
        return ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "NOT_SHAREABLE",
            "People data cannot be shared publicly: remove person, URL and element-text breakdowns",
        )
        .with_details(json!({ "reasons": reasons }))
        .into_response();
    }
    let Some(master) = caller.master(&state) else {
        return unexpected(&"no master database", "create share link");
    };
    let (link, token) = match create_link(&caller, &master, &target, &input.body).await {
        Ok(created) => created,
        Err(CreateFailure::Bad(message)) => return ApiError::bad_request(message).into_response(),
        Err(CreateFailure::Conflict(message)) => {
            return ApiError::conflict(message).into_response();
        }
        Err(CreateFailure::Failed(error)) => return unexpected(&error, "create share link"),
    };
    publish(&caller, &state, &link, PANEL_SHARE_LINK_CREATED);
    let platform_url = caller
        .env("PLATFORM_URL")
        .unwrap_or_else(|| DEFAULT_PLATFORM_URL.to_owned());
    let mut body = dto(&link);
    body["url"] = Value::String(share_url(&platform_url, &token));
    body["token"] = Value::String(token);
    Created(body).into_response()
}

/// `DELETE /:id`: the link's creator, or who may change the target.
pub(crate) async fn revoke(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let found = panel_share_links::Entity::find_by_id(&id)
        .one(&orm(&caller.db))
        .await
        .and_then(|row| row.map(js_row).transpose());
    let link = match found {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Share link", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "revoke share link"),
    };
    let actor = Actor::of(&caller, &permissions);
    let target = match get_target(
        &caller.db,
        text(&link, "targetType"),
        text(&link, "targetId"),
    )
    .await
    {
        Ok(target) => target,
        Err(error) => return unexpected(&error, "revoke share link"),
    };
    if target.as_ref().is_some_and(|t| !can_see(&t.row, &actor)) {
        return ApiError::not_found("Share link", Some(&id)).into_response();
    }
    let may_revoke = text(&link, "createdByUserId") == actor.user_id
        || target
            .as_ref()
            .map_or(actor.can_manage, |t| can_change(&t.row, &actor));
    if !may_revoke {
        return ApiError::forbidden()
            .with_message("Only the creator or the owner can revoke this link")
            .into_response();
    }
    let Some(master) = caller.master(&state) else {
        return unexpected(&"no master database", "revoke share link");
    };
    // `link.revokedAt ?? now`, the same moment in the tenant row and the registry.
    let revoked_at = instant(
        link.get("revokedAt")
            .and_then(Value::as_str)
            .and_then(js::parse_iso)
            .unwrap_or_else(|| caller.now().unwrap_or_else(js::now_millis)),
    );
    let revoked = async {
        let row = panel_share_links::Entity::update_many()
            .col_expr(
                panel_share_links::Column::RevokedAt,
                Expr::value(revoked_at),
            )
            .filter(panel_share_links::Column::Id.eq(text(&link, "id")))
            .exec_with_returning(&orm(&caller.db))
            .await?
            .into_iter()
            .next();
        panel_share_registry::Entity::update_many()
            .col_expr(
                panel_share_registry::Column::RevokedAt,
                Expr::value(revoked_at),
            )
            .filter(panel_share_registry::Column::TokenHash.eq(text(&link, "tokenHash")))
            .filter(panel_share_registry::Column::WorkspaceId.eq(&caller.workspace_id))
            .exec(&orm(&master))
            .await?;
        row.map(js_row).transpose()
    }
    .await;
    match revoked {
        Ok(row) => {
            publish(
                &caller,
                &state,
                &row.unwrap_or(link),
                PANEL_SHARE_LINK_DELETED,
            );
            NoContent.into_response()
        }
        Err(error) => unexpected(&error, "revoke share link"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_people_data() {
        let report = |spec: Value| json!({ "kind": spec["kind"].clone(), "spec": spec });
        assert_eq!(
            share_refusals(&report(json!({ "kind": "signal" }))),
            ["kind"]
        );
        assert_eq!(
            share_refusals(&report(
                json!({ "kind": "trends", "breakdowns": [{ "source": "column", "field": "os" }, { "source": "person", "key": "plan" }] })
            )),
            ["person_breakdown"]
        );
        assert_eq!(
            share_refusals(&report(
                json!({ "kind": "funnel", "holdConstant": { "source": "person", "key": "plan" } })
            )),
            ["person_breakdown"]
        );
        let none: [&str; 0] = [];
        assert_eq!(
            share_refusals(&report(
                json!({ "kind": "trends", "breakdown": { "source": "column", "field": "country" } })
            )),
            none
        );
    }

    #[test]
    fn public_specs_lose_values_cohorts_and_the_project() {
        let stripped = public_spec(&json!({
            "kind": "funnel",
            "projectId": "pnp_a",
            "steps": [{ "event": "A", "filters": [{ "source": "person", "key": "$email", "operator": "eq", "value": "a@b.c" }] }],
            "filters": [{ "source": "cohort", "cohortId": "pnc_vip" }]
        }));
        let text = stripped.to_string();
        assert!(!text.contains("a@b.c") && !text.contains("pnp_a") && !text.contains("pnc_vip"));
        assert_eq!(stripped["steps"][0]["filters"][0]["operator"], "eq");
    }

    #[test]
    fn tokens_and_urls() {
        let token = generate_share_token();
        assert!(is_share_token(&token));
        assert!(!is_share_token("not-a-token"));
        assert_eq!(
            share_url("https://app.test/", "wpsh_x"),
            "https://app.test/s/panel/wpsh_x"
        );
    }
}
