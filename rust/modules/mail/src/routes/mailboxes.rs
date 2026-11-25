//! `/api/mailboxes` (`routes/mailboxes/index.ts`, `services/mail/mailboxes.ts`):
//! every workspace mailbox the signed-in user can open, grouped by
//! workspace, without switching the active one. Session only (no workspace
//! of its own): each workspace's tenant database is looked up by its
//! reference. A workspace that cannot be read lists no accounts; a failed
//! lookup of the workspaces answers an empty list.

use axum::Router;
use axum::extract::{FromRequestParts, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::request::Parts;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect,
    RelationDef,
};
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::{ApiError, Data};
use weldsuite_mail_domain::access::is_admin_or_owner;
use weldsuite_schema::master::enums::MembershipStatus;
use weldsuite_schema::master::{user_workspaces, workspaces};
use weldsuite_schema::tenant::enums::{MailAccountStatus, MailProvider};
use weldsuite_schema::tenant::mail_accounts::{self, Column};

use crate::caller::Bindings;
use crate::{MailState, RequestTenantDatabases};

/// `/api/mailboxes`, relative to `/api`, for the session-only routes.
pub(crate) fn routes<S>(state: MailState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/mailboxes", get(list))
        .with_state(state)
}

/// The signed-in user and the request's bindings.
struct SignedIn {
    user_id: String,
    bindings: Bindings,
    tenants: Option<RequestTenantDatabases>,
}

impl<S: Send + Sync> FromRequestParts<S> for SignedIn {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let signed_in = parts
            .extensions
            .get::<AuthContext>()
            .map(|auth| Self {
                user_id: auth.user_id.clone(),
                bindings: Bindings::from_parts(parts),
                tenants: parts.extensions.get::<RequestTenantDatabases>().cloned(),
            })
            .ok_or_else(ApiError::unauthorized);
        std::future::ready(signed_in)
    }
}

/// A workspace's tenant database and whether it is suspended: the test's in
/// conformance builds, else the deployment's lookup.
async fn tenant(
    state: &MailState,
    caller: &SignedIn,
    reference: &str,
) -> Result<(PgPool, bool), String> {
    if let Some(tenants) = &caller.tenants {
        return tenants
            .0
            .get(reference)
            .cloned()
            .map(|db| (db, false))
            .ok_or_else(|| format!("no tenant database for {reference}"));
    }
    if caller.bindings.env.is_some() {
        return Err(format!("no tenant database for {reference}"));
    }
    match &state.workspace_tenants {
        Some(lookup) => lookup(reference.to_owned()).await,
        None => Err("no tenant lookup".to_owned()),
    }
}

/// A mailbox row: id, email, display name, name, provider, default, status.
type MailboxRow = (
    String,
    String,
    Option<String>,
    String,
    MailProvider,
    Option<bool>,
    MailAccountStatus,
);

/// A membership: Clerk org id, workspace id, name, slug, image, role.
type MembershipRow = (
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    String,
);

/// `accountsForWorkspace`: the first 100 mailboxes the user may open there
/// (`listMailAccounts(db, userId, { limit: 100 })`), as directory entries.
async fn accounts(db: &PgPool, user_id: &str) -> Result<Vec<Value>, DbErr> {
    let admin = is_admin_or_owner(db, user_id).await?;
    // Shared, assigned to the user (`assigned_user_ids @> [user]`), or, for
    // an admin or owner, assigned to nobody (`coalesce(…, '[]')` is `[]` or
    // JSON `null`).
    let mut open = Condition::any().add(Column::IsShared.eq(true)).add(
        sea_orm::sea_query::extension::postgres::PgExpr::contains(
            Expr::col(Column::AssignedUserIds),
            Expr::value(json!([user_id])),
        ),
    );
    if admin {
        open = open.add(sea_orm::ExprTrait::is_in(
            Expr::from(Func::coalesce([
                Expr::col(Column::AssignedUserIds),
                Expr::value(json!([])),
            ])),
            [json!([]), Value::Null],
        ));
    }
    let rows: Vec<MailboxRow> = mail_accounts::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::Email,
            Column::DisplayName,
            Column::Name,
            Column::Provider,
            Column::IsDefault,
            Column::Status,
        ])
        .filter(Column::DeletedAt.is_null())
        .filter(open)
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(101)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .take(100)
        .map(
            |(id, email, display_name, name, provider, is_default, status)| {
                json!({
                    "id": id,
                    "email": email,
                    "displayName": display_name.unwrap_or(name),
                    "provider": provider,
                    "isDefault": is_default.unwrap_or(false),
                    "status": status,
                })
            },
        )
        .collect())
}

/// `innerJoin(workspaces, eq(userWorkspaces.workspaceId, workspaces.id))`.
fn membership_workspace() -> RelationDef {
    user_workspaces::Entity::belongs_to(workspaces::Entity)
        .from(user_workspaces::Column::WorkspaceId)
        .to(workspaces::Column::Id)
        .into()
}

/// `GET /` (`listUserMailboxes`).
async fn list(State(state): State<MailState>, caller: SignedIn) -> Response {
    let Some(master) = caller.bindings.master(&state) else {
        tracing::error!("[app-api/mailboxes] list failed: no master database");
        return Data(json!([])).into_response();
    };
    let rows: Result<Vec<MembershipRow>, DbErr> = user_workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::ClerkOrgId)
        .column(workspaces::Column::Id)
        .column(workspaces::Column::Name)
        .column(workspaces::Column::Slug)
        .column(workspaces::Column::ImageUrl)
        .column(user_workspaces::Column::Role)
        .join(JoinType::InnerJoin, membership_workspace())
        .filter(user_workspaces::Column::UserId.eq(&caller.user_id))
        .filter(user_workspaces::Column::Status.eq(MembershipStatus::ACTIVE))
        .filter(workspaces::Column::IsActive.eq(true))
        .into_tuple()
        .all(&orm(&master))
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "[app-api/mailboxes] list failed");
            return Data(json!([])).into_response();
        }
    };
    let mut groups = Vec::with_capacity(rows.len());
    for (clerk_org_id, workspace_id, name, slug, image_url, role) in rows {
        let reference = clerk_org_id.unwrap_or_else(|| workspace_id.clone());
        let found = match tenant(&state, &caller, &reference).await {
            Ok((_, true)) => Ok(Vec::new()),
            Ok((db, false)) => accounts(&db, &caller.user_id)
                .await
                .map_err(|e| e.to_string()),
            Err(error) => Err(error),
        };
        let mailboxes = found.unwrap_or_else(|error| {
            tracing::error!("[mailboxes] failed to list accounts for {reference}: {error}");
            Vec::new()
        });
        groups.push(json!({
            "clerkOrgId": reference,
            "workspaceId": workspace_id,
            "workspaceName": name,
            "slug": slug,
            "imageUrl": image_url,
            "role": role,
            "accounts": mailboxes,
        }));
    }
    Data(Value::Array(groups)).into_response()
}
