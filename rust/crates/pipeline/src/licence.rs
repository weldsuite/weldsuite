//! `licenceGate()` (`worker-kit/src/middleware/licence-gate.ts`) and the
//! read-only rules (`worker-kit/src/read-only.ts`).
//!
//! A partner-managed workspace may use only the apps in its licence: a path
//! owned by a module none of them opens is refused with 403
//! `APP_NOT_LICENSED`. A read-only workspace (partner suspended, licence not
//! active) refuses writes with 403 `WORKSPACE_READ_ONLY`; one whose database
//! is being moved answers 503 `WORKSPACE_MOVING` with `Retry-After`. Reads,
//! search and the user-level paths always pass.

use axum::extract::{OriginalUri, Request};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::{Method, StatusCode};
use serde_json::json;
use weldsuite_catalogs::missing_licensed_app_for_path;
use weldsuite_db::{ReadOnlyReason, Tenant};
use weldsuite_kit::ApiError;

/// User-level core paths: they change the caller's own settings, never
/// workspace data.
const READ_ONLY_ALLOWED_PREFIXES: [&str; 5] = [
    "/api/search",
    "/api/me",
    "/api/user-preferences",
    "/api/notification-preferences",
    "/api/push-tokens",
];

/// `POST /api/docs/:id/session` and `POST /api/sheets/:id/session` only mint
/// a ticket for the room socket; the handler downgrades to view mode itself.
fn is_session_ticket(path: &str) -> bool {
    let path = path.strip_suffix('/').unwrap_or(path);
    let mut segments = path.split('/');
    matches!(
        (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ),
        (Some(""), Some("api"), Some("docs" | "sheets"), Some(id), Some("session"), None) if !id.is_empty()
    )
}

/// May this request run in a read-only workspace (`isReadOnlyRequestAllowed`)?
/// Reads always; a write only on the side-effect-free paths. Prefixes match on
/// a segment boundary, so `/api/me` does not open `/api/members`.
pub fn is_read_only_request_allowed(method: &Method, path: &str) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return true;
    }
    if READ_ONLY_ALLOWED_PREFIXES.iter().any(|prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    }) {
        return true;
    }
    *method == Method::POST && is_session_ticket(path)
}

/// 403 `APP_NOT_LICENSED` (`appNotLicensedBody`).
pub fn app_not_licensed(app: &str) -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "APP_NOT_LICENSED",
        format!("This workspace is not licensed for {app}."),
    )
    .with_details(json!({ "app": app }))
}

/// 403 `WORKSPACE_READ_ONLY` (`workspaceReadOnlyBody`).
pub fn workspace_read_only(reason: Option<ReadOnlyReason>) -> ApiError {
    let partner_suspended = reason == Some(ReadOnlyReason::PartnerSuspended);
    let message = if partner_suspended {
        "This workspace is read-only because the account that manages it is suspended. You can view and export your data."
    } else {
        "This workspace is read-only because its licence is not active. You can view and export your data."
    };
    let reason = if partner_suspended {
        ReadOnlyReason::PartnerSuspended
    } else {
        ReadOnlyReason::LicenceInactive
    };
    ApiError::new(StatusCode::FORBIDDEN, "WORKSPACE_READ_ONLY", message)
        .with_details(json!({ "reason": reason.as_str() }))
}

/// The gate's decision for one request; `None` lets it through.
pub fn licence_decision(tenant: &Tenant, method: &Method, path: &str) -> Option<ApiError> {
    if let Some(licensed) = tenant.licensed_apps()
        && let Some(missing) = missing_licensed_app_for_path(path, licensed)
    {
        return Some(app_not_licensed(missing));
    }
    if tenant.restrictions.read_only && !is_read_only_request_allowed(method, path) {
        return Some(match tenant.read_only_reason() {
            Some(ReadOnlyReason::DatabaseMove) => ApiError::workspace_moving(),
            reason => workspace_read_only(reason),
        });
    }
    None
}

/// Middleware: `axum::middleware::from_fn(licence_gate)`, after `workspace_db`.
/// Checks the full path, also inside a nested router.
pub async fn licence_gate(request: Request, next: Next) -> Response {
    let path = request
        .extensions()
        .get::<OriginalUri>()
        .map_or_else(|| request.uri().path(), |uri| uri.0.path())
        .to_owned();
    if let Some(tenant) = request.extensions().get::<Tenant>()
        && let Some(refusal) = licence_decision(tenant, request.method(), &path)
    {
        return refusal.into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_exceptions_match_the_workers() {
        let allowed = |method: Method, path: &str| is_read_only_request_allowed(&method, path);
        assert!(allowed(Method::GET, "/api/companies"));
        assert!(allowed(Method::POST, "/api/search"));
        assert!(allowed(Method::PATCH, "/api/me/profile"));
        assert!(!allowed(Method::POST, "/api/members"));
        assert!(!allowed(Method::POST, "/api/merge"));
        assert!(allowed(Method::POST, "/api/docs/doc_1/session"));
        assert!(allowed(Method::POST, "/api/sheets/sh_1/session/"));
        assert!(!allowed(Method::PUT, "/api/docs/doc_1/session"));
        assert!(!allowed(Method::POST, "/api/docs/doc_1/session/extra"));
        assert!(!allowed(Method::POST, "/api/docs//session"));
        assert!(!allowed(Method::POST, "/api/weldagent/templates/export"));
    }

    fn tenant(restrictions: weldsuite_db::WorkspaceRestrictions) -> Tenant {
        Tenant {
            workspace_id: "ws_1".to_owned(),
            clerk_org_id: Some("org_1".to_owned()),
            db: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://u:p@127.0.0.1:1/db")
                .expect("url"),
            suspended: false,
            restrictions,
        }
    }

    #[tokio::test]
    async fn licence_and_read_only_decisions() {
        let crm = weldsuite_catalogs::api_module("crm").expect("crm");
        let crm_path = format!("{}/1", crm.prefixes[0]);
        let own_app = crm.apps.as_ref().expect("gated")[0].clone();

        let direct = tenant(weldsuite_db::WorkspaceRestrictions::default());
        assert!(licence_decision(&direct, &Method::POST, &crm_path).is_none());

        let unlicensed = tenant(weldsuite_db::WorkspaceRestrictions {
            licensed_apps: Some(vec!["weldpass".to_owned()]),
            ..weldsuite_db::WorkspaceRestrictions::default()
        });
        let refusal = licence_decision(&unlicensed, &Method::GET, &crm_path).expect("refused");
        assert_eq!(refusal.code(), "APP_NOT_LICENSED");
        assert_eq!(refusal.details(), Some(&json!({ "app": own_app })));
        assert!(licence_decision(&unlicensed, &Method::GET, "/api/me/permissions").is_none());

        let moving = tenant(weldsuite_db::WorkspaceRestrictions {
            licensed_apps: None,
            read_only: true,
            read_only_reason: Some(ReadOnlyReason::DatabaseMove),
        });
        let refusal = licence_decision(&moving, &Method::POST, &crm_path).expect("refused");
        assert_eq!(
            (refusal.status().as_u16(), refusal.code()),
            (503, "WORKSPACE_MOVING")
        );
        assert_eq!(refusal.retry_after(), Some(30));
        assert!(licence_decision(&moving, &Method::GET, &crm_path).is_none());

        let suspended = tenant(weldsuite_db::WorkspaceRestrictions {
            licensed_apps: Some(vec![own_app.clone()]),
            read_only: true,
            read_only_reason: Some(ReadOnlyReason::PartnerSuspended),
        });
        let refusal = licence_decision(&suspended, &Method::DELETE, &crm_path).expect("refused");
        assert_eq!(
            (refusal.status().as_u16(), refusal.code()),
            (403, "WORKSPACE_READ_ONLY")
        );
    }

    #[test]
    fn read_only_bodies() {
        let partner = workspace_read_only(Some(ReadOnlyReason::PartnerSuspended));
        assert_eq!(partner.code(), "WORKSPACE_READ_ONLY");
        assert_eq!(
            partner.details(),
            Some(&json!({ "reason": "partner_suspended" }))
        );
        assert_eq!(
            workspace_read_only(None).details(),
            Some(&json!({ "reason": "licence_inactive" }))
        );
        assert_eq!(
            app_not_licensed("weldcrm").message(),
            "This workspace is not licensed for weldcrm."
        );
    }
}
