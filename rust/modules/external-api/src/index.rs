//! `GET /v1` (what the key reaches) and `GET /v1/health/db` (the tenant
//! database answers), `routes/v1/index.ts`.

use axum::Json;
use axum::extract::Request;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::ApiError;

use crate::session::{ApiSession, Key, internal, internal_with};

/// Every object group the public API documents, in the worker's order.
const ENDPOINTS: [&str; 89] = [
    "/v1/accounting-contacts",
    "/v1/accounting-documents",
    "/v1/accounting-entities",
    "/v1/accounting-settings",
    "/v1/activities",
    "/v1/app-storage",
    "/v1/articles",
    "/v1/bank-accounts",
    "/v1/bank-transactions",
    "/v1/bills",
    "/v1/calendar-events",
    "/v1/calendars",
    "/v1/categories",
    "/v1/channel-members",
    "/v1/channels",
    "/v1/chat-bookmarks",
    "/v1/chat-drafts",
    "/v1/chat-messages",
    "/v1/chat-sections",
    "/v1/companies",
    "/v1/custom-objects",
    "/v1/conversations",
    "/v1/domains",
    "/v1/drive/all",
    "/v1/drive/stats",
    "/v1/files",
    "/v1/fiscal-periods",
    "/v1/fx-rates",
    "/v1/gl-accounts",
    "/v1/icp-declarations",
    "/v1/invoices",
    "/v1/journal-entries",
    "/v1/folders",
    "/v1/goals",
    "/v1/knowledge-pages",
    "/v1/knowledge-spaces",
    "/v1/leads",
    "/v1/mail-accounts",
    "/v1/mail-attachments",
    "/v1/mail-drafts",
    "/v1/mail-folders",
    "/v1/mail-labels",
    "/v1/mail-messages",
    "/v1/mail-threads",
    "/v1/milestones",
    "/v1/opportunities",
    "/v1/orders",
    "/v1/people",
    "/v1/payments",
    "/v1/pipeline-stages",
    "/v1/pipelines",
    "/v1/products",
    "/v1/project-documents",
    "/v1/project-files",
    "/v1/project-labels",
    "/v1/project-members",
    "/v1/project-messages",
    "/v1/project-sheets",
    "/v1/projects",
    "/v1/quotes",
    "/v1/reach/access",
    "/v1/reach/campaigns",
    "/v1/reach/domains",
    "/v1/reach/lists",
    "/v1/reach/mailboxes",
    "/v1/reach/overview",
    "/v1/reach/prospects",
    "/v1/reach/suppressions",
    "/v1/reach/threads",
    "/v1/reconciliation-rules",
    "/v1/recurring-invoices",
    "/v1/settings",
    "/v1/social-accounts",
    "/v1/social-analytics",
    "/v1/social-campaigns",
    "/v1/social-media",
    "/v1/social-posts",
    "/v1/sprints",
    "/v1/tax-rates",
    "/v1/task-comments",
    "/v1/task-tags",
    "/v1/tasks",
    "/v1/tickets",
    "/v1/time-entries",
    "/v1/user-apps",
    "/v1/vat-returns",
    "/v1/webhooks",
    "/v1/whiteboards",
    "/v1/workflows",
];

/// `GET /v1`. The list is the worker's, whatever this edition serves.
pub(crate) async fn describe(request: Request) -> Response {
    // The worker reads the session unguarded: without one it throws (500).
    let Some(session) = request.extensions().get::<ApiSession>() else {
        return internal().into_response();
    };
    Json(json!({
        "data": {
            "version": "v1",
            "workspace": { "id": session.workspace_id, "tier": session.tier },
            "endpoints": &ENDPOINTS[..],
        }
    }))
    .into_response()
}

/// `GET /v1/health/db`: `select 1` on the tenant database.
pub(crate) async fn health_db(key: Key) -> Result<Response, ApiError> {
    if sqlx::query("select 1").execute(&key.db).await.is_err() {
        return Err(internal_with("Database connection failed"));
    }
    Ok(Json(json!({
        "data": {
            "status": "connected",
            "workspace": { "id": key.session.workspace_id, "tier": key.session.tier },
            "timestamp": iso_timestamp(time::OffsetDateTime::now_utc()),
        }
    }))
    .into_response())
}
