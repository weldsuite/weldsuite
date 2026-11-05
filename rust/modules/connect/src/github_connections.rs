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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Issues, Presence, js_number};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{next_cursor, page, page_limit, query_truthy, total};
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

const RESOURCE: &str = "GitHub connection";

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
/// [`js_row`] reads it) in the legacy shape, webhook secret included.
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
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from merge_connections t
         where t.provider = 'github' and t.deleted_at is null
         order by (t.status = 'active') desc, t.created_at desc, t.id desc limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| connection_view(&js_row(row), workspace_id)))
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
fn present(row: Value, caller: &Caller) -> Value {
    without_secret(connection_view(&js_row(row), &caller.clerk_org_id))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list github connections";
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let mut conditions = vec![
        "t.deleted_at is null".to_owned(),
        "t.provider = 'github'".to_owned(),
    ];
    let mut binds: Vec<String> = Vec::new();
    if let Some(status) = crate::js::query_param(query, "status").filter(|s| !s.is_empty()) {
        binds.push(status);
        conditions.push(format!("t.status = ${}", binds.len()));
    }
    let cursor = query_truthy(query, "cursor");
    // The count leaves out the last condition whenever a cursor is sent: the
    // cursor's own, or (when its row is gone) the last filter.
    let mut count_conditions = conditions.clone();
    let mut count_binds = binds.len();
    if let Some(cursor) = &cursor {
        let found: Result<Option<bool>, sqlx::Error> = sqlx::query_scalar(
            "select created_at is not null from merge_connections where id = $1 limit 1",
        )
        .bind(cursor)
        .fetch_optional(&caller.db)
        .await;
        match found {
            Ok(Some(true)) => {
                binds.push(cursor.clone());
                let n = binds.len();
                conditions.push(format!(
                    "(t.created_at < (select date_trunc('milliseconds', c.created_at) from merge_connections c where c.id = ${n})
                      or (t.created_at = (select date_trunc('milliseconds', c.created_at) from merge_connections c where c.id = ${n})
                          and t.id < ${n}))"
                ));
            }
            Ok(_) => {
                // The last filter is the status (with its bind), else the
                // provider.
                count_binds = count_binds.saturating_sub(1);
                count_conditions.pop();
            }
            Err(error) => return internal(&error, FAILED),
        }
    }
    let where_rows = conditions.join(" and ");
    let where_count = if count_conditions.is_empty() {
        "true".to_owned()
    } else {
        count_conditions.join(" and ")
    };
    let mut rows_query = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from merge_connections t where {where_rows}
         order by t.created_at desc, t.id desc limit {}",
        limit + 1
    )));
    for bind in &binds {
        rows_query = rows_query.bind(bind);
    }
    let mut count_query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
        "select count(*) from merge_connections t where {where_count}"
    )));
    for bind in binds.iter().take(count_binds) {
        count_query = count_query.bind(bind);
    }
    match (
        rows_query.fetch_all(&caller.db).await,
        count_query.fetch_one(&caller.db).await,
    ) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(
                rows.into_iter().map(|row| present(row, &caller)).collect(),
                limit,
            );
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

/// The live GitHub row `id`.
async fn live_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select to_jsonb(t) from merge_connections t
         where t.id = $1 and t.provider = 'github' and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
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

/// `toColumns(data)`: a body in the legacy shape as `merge_connections`
/// columns. Unknown keys are dropped; a value of the wrong type reaches the
/// column and the write fails, as it always did. `Err` for a timestamp that
/// is not null.
fn to_columns(data: &Map<String, Value>) -> Result<Map<String, Value>, ()> {
    let mut out = Map::new();
    match data.get("installationId") {
        None | Some(Value::Null) => {}
        Some(Value::String(id)) => {
            out.insert("external_account_id".into(), json!(id));
        }
        Some(other) => {
            out.insert("external_account_id".into(), json!(other.to_string()));
        }
    }
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
        ("status", "status"),
        ("scopes", "scopes"),
        ("installedAt", "installed_at"),
        ("revokedAt", "revoked_at"),
        ("webhookSecret", "webhook_secret"),
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

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create github connection";
    let data = match validate(&headers, &body, read_body) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let Ok(mut record) = to_columns(&data) else {
        return internal(&"value.toISOString is not a function", FAILED);
    };
    let id = generate_id("ghc");
    record.insert("id".into(), json!(id));
    record.insert("provider".into(), json!("github"));
    record.insert("created_by_user_id".into(), json!(caller.user_id));
    let columns: Vec<&str> = record.keys().map(String::as_str).collect();
    let list = columns.join(", ");
    let inserted = sqlx::query(sqlx::AssertSqlSafe(format!(
        "insert into merge_connections ({list}, created_at, updated_at)
         select {list}, $2::timestamptz, $2::timestamptz
         from jsonb_populate_record(null::merge_connections, $1)"
    )))
    .bind(Value::Object(record.clone()))
    .bind(now())
    .execute(&caller.db)
    .await;
    match inserted {
        Ok(_) => Created(json!({ "id": id })).into_response(),
        Err(error) => internal(&error, FAILED),
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
        let set: String = record
            .keys()
            .fold(String::new(), |set, c| set + ", " + c + " = r." + c);
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "update merge_connections t set updated_at = $3::timestamptz{set}
             from jsonb_populate_record(null::merge_connections, $2) r
             where t.id = $1 and t.deleted_at is null"
        )))
        .bind(&id)
        .bind(Value::Object(record))
        .bind(now())
        .execute(&caller.db)
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
        sqlx::query(
            "update merge_connections set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
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
        let columns = to_columns(&body).unwrap_or_default();
        assert_eq!(
            Value::Object(columns),
            json!({
                "external_account_id": "31337", "account_type": "organization",
                "account_login": "jane", "status": "active",
            })
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
