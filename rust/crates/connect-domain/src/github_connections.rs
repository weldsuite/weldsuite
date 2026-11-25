//! The workspace's GitHub App installation as WeldFlow and the integration
//! routes see it (`services/github/connections.ts`). The installation is a
//! WeldMerge connection: a `merge_connections` row with provider `github`
//! (ADR MERGE-002), recorded by the install flow through WeldMerge's
//! installation recorder. These read those rows and map them back to the
//! shape connect-api's routes have always answered (`installationId` as a
//! number, owner type `user` / `org`, `createdBy`), so their paths and
//! response shapes did not change with the move off `github_connections`.
//! Reads take the newest active connection first; the tenant database is the
//! workspace, so no query filters on one.
//!
//! Shared by WeldConnect's WeldFlow GitHub routes (`weldsuite-connect`) and
//! the core integration routes (`weldsuite-core-integrations`), which serve
//! `/api/github-connections`.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::js_number;
use weldsuite_schema::tenant::merge_connections::{self, Column, Model};

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
    if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
        return json!(number as i64);
    }
    json!(number)
}

/// `toGithubConnection(row, workspaceId)`: a `merge_connections` row (as
/// the entity serializes it) in the legacy shape, webhook secret included.
/// `needs_attention` is not a GitHub App state: to these callers the
/// connection is unusable, like a suspended one.
pub fn connection_view(row: &Value, workspace_id: &str) -> Value {
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
pub fn without_secret(mut view: Value) -> Value {
    if let Value::Object(map) = &mut view {
        map.remove("webhookSecret");
    }
    view
}

/// `getConnectionByWorkspace(db, workspaceId)`: the newest active GitHub
/// connection, else the newest of any state (the settings page still shows
/// a revoked one), in the legacy shape.
pub async fn connection_by_workspace(
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
}
