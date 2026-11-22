//! The workspace's GitHub App installation as WeldFlow and WeldConnect see
//! it (`services/github/connections.ts`, `routes/github-connections`). The
//! installation is a WeldMerge connection: a `merge_connections` row with
//! provider `github` (ADR MERGE-002), recorded by the install flow through
//! WeldMerge's installation recorder. This module reads those rows and maps
//! them back to the shape connect-api's routes have always answered
//! (`installationId` as a number, owner type `user` / `org`, `createdBy`), so
//! their paths and response shapes did not change with the move off
//! `github_connections`. Reads take the newest active connection first; the
//! tenant database is the workspace, so no query filters on one.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_kit::validation::{Issues, Presence, js_number};
use weldsuite_kit::{ApiError, Data, List, NoContent, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::merge_connections::{self, Column, Model};

use crate::js::{next_cursor, page, page_limit, query_truthy};
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

const RESOURCE: &str = "GitHub connection";

/// `merge_connections`, written from a body's columns.
const MERGE_CONNECTIONS: JsonTable = JsonTable::of::<merge_connections::Entity>();

/// `Number(text)` as JSON: an integer stays one, `NaN` is `null`.
fn js_number_json(text: Option<&str>) -> Value {
    let Some(text) = text else {
        // `Number(null)` is 0; the column is never null.
        return json!(0);
    };
    let number = js_number(text);
    if !number.is_finite() {
        return Value::Null;
    }
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
        return json!(number as i64);
    }
    json!(number)
}

/// `toGithubConnection(row, workspaceId)`: a `merge_connections` row (as
/// the entity serializes it) in the legacy shape, webhook secret included.
/// `needs_attention` is not a GitHub App state: to these callers the
/// connection is unusable, like a suspended one.
pub(crate) fn connection_view(row: &Value, workspace_id: &str) -> Value {
    let text_or_empty = |key: &str| match &row[key] {
        Value::Null => Value::String(String::new()),
        other => other.clone(),
    };
    let status = match &row["status"] {
        Value::String(status) if status == "needs_attention" => json!("suspended"),
        other => other.clone(),
    };
    json!({
        "id": row["id"],
        "workspaceId": workspace_id,
        "installationId": js_number_json(row["externalAccountId"].as_str()),
        "appSlug": text_or_empty("appSlug"),
        "ownerType": if row["accountType"] == "organization" { "org" } else { "user" },
        "ownerLogin": text_or_empty("accountLogin"),
        "webhookSecret": row["webhookSecret"],
        "createdBy": row["createdByUserId"],
        "status": status,
        "scopes": row["scopes"],
        "installedAt": row["installedAt"],
        "revokedAt": row["revokedAt"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
        "deletedAt": row["deletedAt"],
    })
}

/// The view without its webhook secret (`present`, `formatConnection`).
pub(crate) fn without_secret(mut view: Value) -> Value {
    if let Value::Object(map) = &mut view {
        map.remove("webhookSecret");
    }
    view
}

/// `getConnectionByWorkspace(db, workspaceId)`: the newest active GitHub
/// connection, else the newest of any state (the settings page still shows
/// a revoked one), in the legacy shape.
pub(crate) async fn connection_by_workspace(
    db: &PgPool,
    workspace_id: &str,
) -> Result<Option<Value>, DbErr> {
    // `order by (status = 'active') desc`.
    let active_first = sea_orm::ExprTrait::eq(Expr::col(Column::Status), "active");
    let row = merge_connections::Entity::find()
        .filter(Column::Provider.eq("github"))
        .filter(Column::DeletedAt.is_null())
        .order_by_desc(active_first)
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .one(&orm(db))
        .await?;
    Ok(row.map(|row| connection_view(&js(row), workspace_id)))
}

/// A row as Drizzle returned it.
fn js(model: Model) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

// ── /api/github-connections ─────────────────────────────────────────────────

/// `/api/github-connections`: the generic object routes over the
/// workspace's WeldMerge GitHub connections.
pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::INTEGRATIONS_READ]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([perm::INTEGRATIONS_CREATE])),
        )
        .route("/{id}", get(detail).route_layer(read()))
        .route(
            "/{id}",
            patch(update).route_layer(gate.require([perm::INTEGRATIONS_UPDATE])),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(gate.require([perm::INTEGRATIONS_DELETE])),
        )
}

/// What a stored row answers: the legacy shape, without the webhook secret.
fn present(row: Model, caller: &Caller) -> Value {
    without_secret(connection_view(&js(row), &caller.clerk_org_id))
}

/// `date_trunc('milliseconds', at)`.
fn to_millis(at: OffsetDateTime) -> OffsetDateTime {
    at.replace_millisecond(at.millisecond()).unwrap_or(at)
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list github connections";
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let mut conditions = vec![Column::DeletedAt.is_null(), Column::Provider.eq("github")];
    if let Some(status) = crate::js::query_param(query, "status").filter(|s| !s.is_empty()) {
        conditions.push(Column::Status.eq(status));
    }
    let cursor = query_truthy(query, "cursor");
    let db = orm(&caller.db);
    // The count leaves out the last condition whenever a cursor is sent: the
    // cursor's own, or (when its row is gone) the last filter.
    let mut count_conditions = conditions.clone();
    if let Some(cursor) = &cursor {
        let found: Result<Option<OffsetDateTime>, DbErr> = merge_connections::Entity::find()
            .select_only()
            .column(Column::CreatedAt)
            .filter(Column::Id.eq(cursor))
            .limit(1)
            .into_tuple()
            .one(&db)
            .await;
        match found {
            Ok(Some(at)) => {
                // Before the cursor row's `created_at` (to the millisecond),
                // or at it with a smaller id.
                use sea_orm::ExprTrait as _;
                let at = to_millis(at);
                conditions.push(
                    Column::CreatedAt
                        .lt(at)
                        .or(Column::CreatedAt.eq(at).and(Column::Id.lt(cursor))),
                );
            }
            Ok(None) => {
                // The last filter is the status, else the provider.
                count_conditions.pop();
            }
            Err(error) => return internal(&error, FAILED),
        }
    }
    let all = |conditions: Vec<Expr>| {
        conditions
            .into_iter()
            .fold(Condition::all(), Condition::add)
    };
    let rows = merge_connections::Entity::find()
        .filter(all(conditions))
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await;
    let count = merge_connections::Entity::find()
        .filter(all(count_conditions))
        .count(&db)
        .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(
                rows.into_iter().map(|row| present(row, &caller)).collect(),
                limit,
            );
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

/// The live GitHub row `id`.
async fn live_row(db: &PgPool, id: &str) -> Result<Option<Model>, DbErr> {
    merge_connections::Entity::find_by_id(id.to_owned())
        .filter(Column::Provider.eq("github"))
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match live_row(&caller.db, &id).await {
        Ok(Some(row)) => Data(present(row, &caller)).into_response(),
        Ok(None) => ApiError::not_found(RESOURCE, Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch github connection"),
    }
}

/// `createGithubConnectionSchema` (`.partial()` for a PATCH, which changes
/// nothing here: every key is optional): the body as sent, passthrough.
fn read_body(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    issues.text(body, "installationId", Presence::Nullish, None, None);
    issues.text(body, "accountLogin", Presence::Optional, None, Some(255));
    issues.text(body, "status", Presence::Optional, None, Some(30));
    body.clone()
}

/// Timestamp columns: Drizzle refuses anything but a `Date` there
/// (`value.toISOString is not a function`).
const DATE_COLUMNS: [&str; 2] = ["installed_at", "revoked_at"];

/// Body keys only the install flow sets (`INSTALL_FLOW_KEYS`): which
/// installation a workspace is bound to is decided by `recordInstallation`,
/// after it has proved the member can reach the installation and claimed it
/// in the master index. Binding another workspace's installation here would
/// let this workspace mint that installation's App tokens.
const INSTALL_FLOW_KEYS: [&str; 3] = ["installationId", "status", "webhookSecret"];
const CREATE_REFUSED: &str = "A GitHub connection is created by installing the GitHub App";
const UPDATE_REFUSED: &str =
    "installationId, status and webhookSecret are set by the GitHub App install flow";

/// `toColumns(data)`: a body in the legacy shape as `merge_connections`
/// columns. Unknown keys and the install-flow keys are dropped; a value of
/// the wrong type reaches the column and the write fails, as it always did.
/// `Err` for a timestamp that is not null.
fn to_columns(data: &Map<String, Value>) -> Result<Map<String, Value>, ()> {
    let mut out = Map::new();
    if let Some(slug) = data.get("appSlug") {
        out.insert("app_slug".into(), slug.clone());
    }
    if let Some(owner_type) = data.get("ownerType") {
        let account_type = if owner_type == "org" {
            json!("organization")
        } else {
            owner_type.clone()
        };
        out.insert("account_type".into(), account_type);
    }
    // `data.ownerLogin ?? data.accountLogin`.
    let login = match data.get("ownerLogin") {
        None | Some(Value::Null) => data.get("accountLogin"),
        some => some,
    };
    if let Some(login) = login {
        out.insert("account_login".into(), login.clone());
    }
    for (key, column) in [
        ("scopes", "scopes"),
        ("installedAt", "installed_at"),
        ("revokedAt", "revoked_at"),
    ] {
        if let Some(value) = data.get(key) {
            if DATE_COLUMNS.contains(&column) && !value.is_null() {
                return Err(());
            }
            out.insert(column.into(), value.clone());
        }
    }
    Ok(out)
}

/// The install flow (`/api/workflow-github` callback, setup and recover) is
/// the only way in: the body is validated, then refused.
async fn create(_caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create github connection";
    match validate(&headers, &body, read_body) {
        Ok(_) => ApiError::bad_request(CREATE_REFUSED).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update github connection";
    let data = match validate(&headers, &body, read_body) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if INSTALL_FLOW_KEYS.iter().any(|key| data.contains_key(*key)) {
        return ApiError::bad_request(UPDATE_REFUSED).into_response();
    }
    let result = async {
        if live_row(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found(RESOURCE, &id));
        }
        let Ok(record) = to_columns(&data) else {
            return Err(Refusal::Response(Box::new(internal(
                &"value.toISOString is not a function",
                FAILED,
            ))));
        };
        // `set({ ...columns, updatedAt: new Date() })`, Postgres converting
        // each value to its column's type.
        let mut record = record;
        record.insert("updated_at".into(), json!(now()));
        MERGE_CONNECTIONS
            .update(&orm(&caller.db), &id, record, true)
            .await?;
        Ok(Data(json!({ "id": id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond(FAILED))
}

async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to delete github connection";
    let result = async {
        if live_row(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found(RESOURCE, &id));
        }
        let stamp = utc_timestamp(OffsetDateTime::now_utc()).assume_utc();
        merge_connections::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond(FAILED))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_read_in_the_legacy_shape() {
        let row = json!({
            "id": "mcn_1", "externalAccountId": "4242", "appSlug": null,
            "accountType": "organization", "accountLogin": "acme", "webhookSecret": "sealed",
            "createdByUserId": "user_1", "status": "needs_attention", "scopes": null,
            "installedAt": null, "revokedAt": null, "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z", "deletedAt": null,
        });
        let view = connection_view(&row, "org_1");
        assert_eq!(view["installationId"], json!(4242));
        assert_eq!(view["appSlug"], json!(""));
        assert_eq!(view["ownerType"], json!("org"));
        assert_eq!(view["status"], json!("suspended"));
        assert_eq!(view["workspaceId"], json!("org_1"));
        assert!(without_secret(view).get("webhookSecret").is_none());
        assert_eq!(js_number_json(Some("not a number")), Value::Null);
        assert_eq!(js_number_json(Some("")), json!(0));
    }

    #[test]
    fn bodies_map_to_columns() {
        let body = json!({
            "installationId": "31337", "ownerType": "org", "ownerLogin": "jane",
            "accountLogin": "not-a-column", "workspaceId": "org_x", "status": "active",
        });
        let Value::Object(body) = body else {
            unreachable!()
        };
        // The installation id and the status are the install flow's.
        let columns = to_columns(&body).unwrap_or_default();
        assert_eq!(
            Value::Object(columns),
            json!({ "account_type": "organization", "account_login": "jane" })
        );
        let Value::Object(dated) = json!({ "revokedAt": "2026-01-01T00:00:00Z" }) else {
            unreachable!()
        };
        assert!(to_columns(&dated).is_err());
        let Value::Object(cleared) = json!({ "revokedAt": null, "accountLogin": "a" }) else {
            unreachable!()
        };
        assert_eq!(
            Value::Object(to_columns(&cleared).unwrap_or_default()),
            json!({ "revoked_at": null, "account_login": "a" })
        );
    }
}
