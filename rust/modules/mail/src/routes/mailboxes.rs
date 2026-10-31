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
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_db::PgPool;
use weldsuite_kit::{ApiError, Data};
use weldsuite_mail_domain::access::is_admin_or_owner;

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
    Option<String>,
    Option<bool>,
    String,
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
async fn accounts(db: &PgPool, user_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let admin = is_admin_or_owner(db, user_id).await?;
    let rows: Vec<MailboxRow> =
        sqlx::query_as(
            "select a.id, a.email, a.display_name, a.name, a.provider::text, a.is_default,
               a.status::text
             from mail_accounts a
             where a.deleted_at is null and (a.is_shared = true
               or a.assigned_user_ids @> jsonb_build_array($1::text)
               or ($2 and coalesce(a.assigned_user_ids, '[]'::jsonb) in ('[]'::jsonb, 'null'::jsonb)))
             order by a.created_at desc, a.id desc
             limit 101",
        )
        .bind(user_id)
        .bind(admin)
        .fetch_all(db)
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

/// `GET /` (`listUserMailboxes`).
async fn list(State(state): State<MailState>, caller: SignedIn) -> Response {
    let Some(master) = caller.bindings.master(&state) else {
        tracing::error!("[app-api/mailboxes] list failed: no master database");
        return Data(json!([])).into_response();
    };
    let rows: Result<Vec<MembershipRow>, sqlx::Error> = sqlx::query_as(
        "select w.clerk_org_id, w.id, w.name, w.slug, w.image_url, uw.role
             from user_workspaces uw
             inner join workspaces w on uw.workspace_id = w.id
             where uw.user_id = $1 and uw.status = 'ACTIVE' and w.is_active = true",
    )
    .bind(&caller.user_id)
    .fetch_all(&master)
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
