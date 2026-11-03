//! WeldFlow's sheets on the public API: `/v1/project-sheets`
//! (`routes/v1/project-sheets/index.ts`), a read-only list of the files that
//! are a project's spreadsheets.

use axum::Router;
use axum::extract::RawQuery;
use axum::routing::get;
use serde_json::json;

use crate::ExternalApiState;
use crate::crud::{Answer, Caller, page, table_list_sql, text};
use crate::schemas::LIST_PROJECT_SHEETS;
use crate::simple::scoped;
use crate::tables_gen::FILES;
use crate::zod;

/// The sheets' route.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router.route(
        "/project-sheets",
        scoped(get(list_sheets), "project_sheets:read"),
    )
}

const SHEETS_LIST: (&str, &str) = table_list_sql!(
    files,
    "t.entity_type = 'project' and t.file_type = 'spreadsheet' and t.deleted_at is null \
     and ($3->>'projectId' is null or t.entity_id = $3->>'projectId')"
);

async fn list_sheets(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_PROJECT_SHEETS, raw.as_deref())?;
    let filters = json!({ "projectId": text(&q, "projectId") });
    page(&caller.db, SHEETS_LIST, &FILES, &q, filters).await
}
