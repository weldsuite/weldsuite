//! WeldFlow's sheets on the public API: `/v1/project-sheets`
//! (`routes/v1/project-sheets/index.ts`), a read-only list of the files that
//! are a project's spreadsheets.

use axum::Router;
use axum::extract::RawQuery;
use axum::routing::get;
use sea_orm::{ColumnTrait, Condition};
use serde_json::{Value, json};
use weldsuite_schema::tenant::files;

use crate::ExternalApiState;
use crate::crud::{Answer, Caller, page, text};
use crate::list::when;
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

/// A project's spreadsheets (`entityType = 'project'`, `fileType =
/// 'spreadsheet'`), live, of the project when one is named.
fn sheets_list(f: &Value) -> Condition {
    Condition::all()
        .add(files::Column::EntityType.eq("project"))
        .add(files::Column::FileType.eq("spreadsheet"))
        .add(files::Column::DeletedAt.is_null())
        .add_option(when(f, "projectId", |v| files::Column::EntityId.eq(v)))
}

async fn list_sheets(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_PROJECT_SHEETS, raw.as_deref())?;
    let filters = json!({ "projectId": text(&q, "projectId") });
    page(&caller.db, sheets_list, &FILES, &q, filters).await
}
