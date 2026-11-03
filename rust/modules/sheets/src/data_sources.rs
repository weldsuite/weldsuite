//! Connected tables (`routes/sheets/data-sources.ts`): WeldSuite records
//! listed into a sheet. The rows are kept here; what a table lists now is
//! the sheets engine's `listDataTable` (the worker's `buildRefresh`, run with
//! the workspace's database), and the room writes it into the workbook as an
//! edit everyone sees. Scheduled refreshes run on the room's alarm.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    SHEET_DATA_SOURCE_CREATED, SHEET_DATA_SOURCE_DELETED, SHEET_DATA_SOURCE_UPDATED,
};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};

use crate::records::{
    self, DataSourcePatch, NewDataSource, SheetRecord, data_source_event_data, file_ref_json,
    room_name, to_data_source,
};
use crate::routes::{editable_sheet, find_sheet};
use crate::sheet_data::{self, REFRESH, aborts};
use crate::{Caller, Refusal, SheetsState, answer, now, validate};

const NO_READ: &str = "You cannot read this kind of record";

/// Tab id in the editor's format (`newTabId`).
fn new_tab_id() -> String {
    format!(
        "sh_{}",
        weldsuite_kit::random_string(16, "0123456789abcdef")
    )
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let (sheet, _) = find_sheet(&caller, &id).await?;
            let rows = records::list_data_sources(&caller.db, &sheet.id).await?;
            let total = u64::try_from(rows.len()).unwrap_or(0);
            Ok(List::new(
                rows.iter().map(to_data_source).collect(),
                Pagination::new(total, false, None),
            )
            .into_response())
        }
        .await,
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct CreateSource {
    object_type: String,
    definition: Value,
    refresh: String,
    /// Where a table not in the workbook yet goes (`DataTablePlace`).
    at: Value,
}

/// `createSheetDataSourceSchema`'s `target`: `z.union([{ tabId, row, col }, { newTab }])`.
/// The option that parsed (its place), or its issues, settled after the
/// body's synchronous checks as Zod settles an async union.
fn target(issues: &Issues, body: &Map<String, Value>) -> (Option<Value>, Vec<Value>) {
    let mut cell = Issues::default();
    let at_cell = cell.nested(body, "target", Presence::Required, |issues, fields| {
        let tab = issues
            .text(fields, "tabId", Presence::Required, Some(1), Some(200))
            .into_option();
        let row = issues
            .integer(fields, "row", Presence::Required, Some(0))
            .into_option();
        let col = issues
            .integer(fields, "col", Presence::Required, Some(0))
            .into_option();
        json!({ "sheetId": tab, "row": row, "col": col })
    });
    let mut tab = Issues::default();
    let at_tab = tab.nested(body, "target", Presence::Required, |issues, fields| {
        let name = issues
            .text_with(
                fields,
                "newTab",
                Presence::Required,
                Text::trimmed(Some(1), Some(100)),
            )
            .into_option();
        json!({ "newSheet": { "id": new_tab_id(), "name": name } })
    });
    // Each option's issues, with the path the body sits at (the root here).
    let prefix = issues.path_here();
    let rebase = |found: &[Value]| -> Vec<Value> {
        found
            .iter()
            .map(|issue| {
                let mut issue = issue.clone();
                if let (Value::Array(base), Value::Array(path)) = (&prefix, &issue["path"]) {
                    let mut full = base.clone();
                    full.extend(path.iter().cloned());
                    issue["path"] = Value::Array(full);
                }
                issue
            })
            .collect()
    };
    let options = [
        (at_cell, rebase(cell.issues_since(0))),
        (at_tab, rebase(tab.issues_since(0))),
    ];
    if let Some((Field::Set(at), _)) = options.iter().find(|(_, found)| found.is_empty()) {
        return (Some(at.clone()), Vec::new());
    }
    if let Some((_, found)) = options.iter().find(|(_, found)| !found.iter().any(aborts)) {
        return (None, found.clone());
    }
    let union = json!({
        "code": "invalid_union",
        "unionErrors": options
            .iter()
            .map(|(_, found)| json!({ "issues": found, "name": "ZodError" }))
            .collect::<Vec<_>>(),
        "path": issues.path_of("target"),
        "message": "Invalid input",
    });
    (None, vec![union])
}

fn create_source(headers: &HeaderMap, body: &Bytes) -> Result<CreateSource, Refusal> {
    validate(headers, body, |issues, body| {
        let keys = sheet_data::object_keys();
        let object_type = issues
            .choice(body, "objectType", Presence::Required, &keys)
            .into_option();
        let definition = sheet_data::definition(issues, body, "definition", Presence::Required);
        let refresh = issues
            .choice(body, "refresh", Presence::Optional, &REFRESH)
            .into_option();
        let (at, target_issues) = target(issues, body);
        let definition = definition.into_option();
        let mut later = Vec::new();
        if let Some(read) = &definition {
            later.extend(read.refined.iter().cloned());
        }
        later.extend(target_issues);
        let aborted = issues.issues_since(0).iter().chain(&later).any(aborts)
            || definition.as_ref().is_none_or(|read| read.raw.is_none());
        for issue in later {
            issues.push_raw(issue);
        }
        // The schema's `superRefine`, once the rest parsed.
        if !aborted
            && let (Some(object_type), Some(raw)) = (
                &object_type,
                definition.as_ref().and_then(|read| read.raw.as_ref()),
            )
            && let Some(problem) = sheet_data::check_definition(object_type, raw)
        {
            issues.custom("definition", &problem);
        }
        CreateSource {
            object_type: object_type.unwrap_or_default(),
            definition: definition.and_then(|read| read.value).unwrap_or_default(),
            refresh: refresh.unwrap_or_else(|| "manual".to_owned()),
            at: at.unwrap_or_default(),
        }
    })
}

pub(crate) async fn create(
    State(state): State<SheetsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = create_source(&headers, &body)?;
            let org = caller.org()?.to_owned();
            let sheet = editable_sheet(&caller, &id).await?;
            let permission = sheet_data::permission_of(&input.object_type).unwrap_or_default();
            if !caller.can(permission) {
                return Err(Refusal::forbidden(NO_READ));
            }
            let source_id = generate_id("shds");
            let row = records::insert_data_source(
                &caller.db,
                &NewDataSource {
                    id: &source_id,
                    sheet_id: &sheet.id,
                    object_type: &input.object_type,
                    definition: &input.definition,
                    refresh: &input.refresh,
                    created_by_id: &caller.user_id,
                },
                &now(),
            )
            .await?;
            caller.publish(
                &state,
                SHEET_DATA_SOURCE_CREATED,
                &source_id,
                &data_source_event_data(&row),
            );
            let result = refresh_now(&state, &caller, &org, &sheet, &row, Some(input.at)).await?;
            reschedule(&state, &caller, &org, &sheet).await?;
            Ok(Created(result).into_response())
        }
        .await,
    )
}

// ── PATCH /:sourceId ────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<SheetsState>,
    caller: Caller,
    Path((id, source_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (definition, refresh) = validate(&headers, &body, |issues, body| {
                let definition =
                    sheet_data::definition(issues, body, "definition", Presence::Optional);
                let refresh = issues
                    .choice(body, "refresh", Presence::Optional, &REFRESH)
                    .into_option();
                let definition = definition.into_option();
                if let Some(read) = &definition {
                    for issue in &read.refined {
                        issues.push_raw(issue.clone());
                    }
                }
                (definition.and_then(|read| read.value), refresh)
            })?;
            let org = caller.org()?.to_owned();
            let sheet = editable_sheet(&caller, &id).await?;
            let Some(previous) =
                records::get_data_source(&caller.db, &sheet.id, &source_id).await?
            else {
                return Err(Refusal::not_found("Data source", &source_id));
            };
            let object_type = previous["objectType"].as_str().unwrap_or_default();
            if let Some(definition) = &definition {
                let fields = definition.as_object().cloned().unwrap_or_default();
                if let Some(problem) = sheet_data::check_definition(object_type, &fields) {
                    return Err(ApiError::bad_request(problem).into());
                }
                // Whoever decides what it lists lists it with their own access.
                let allowed = sheet_data::permission_of(object_type)
                    .is_some_and(|permission| caller.can(permission));
                if !allowed {
                    return Err(Refusal::forbidden(NO_READ));
                }
            }
            let Some(row) = records::update_data_source(
                &caller.db,
                &sheet.id,
                &source_id,
                &DataSourcePatch {
                    definition: definition.as_ref(),
                    created_by_id: definition.as_ref().map(|_| caller.user_id.as_str()),
                    refresh: refresh.as_deref(),
                },
                &now(),
            )
            .await?
            else {
                return Err(Refusal::not_found("Data source", &source_id));
            };
            caller.publish(
                &state,
                SHEET_DATA_SOURCE_UPDATED,
                &source_id,
                &data_source_event_data(&row),
            );
            let result = refresh_now(&state, &caller, &org, &sheet, &row, None).await?;
            reschedule(&state, &caller, &org, &sheet).await?;
            Ok(Data(result).into_response())
        }
        .await,
    )
}

// ── POST /:sourceId/refresh ─────────────────────────────────────────────────

pub(crate) async fn refresh(
    State(state): State<SheetsState>,
    caller: Caller,
    Path((id, source_id)): Path<(String, String)>,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let sheet = editable_sheet(&caller, &id).await?;
            let Some(source) = records::get_data_source(&caller.db, &sheet.id, &source_id).await?
            else {
                return Err(Refusal::not_found("Data source", &source_id));
            };
            let result = refresh_now(&state, &caller, &org, &sheet, &source, None).await?;
            reschedule(&state, &caller, &org, &sheet).await?;
            Ok(Data(result).into_response())
        }
        .await,
    )
}

// ── DELETE /:sourceId ───────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<SheetsState>,
    caller: Caller,
    Path((id, source_id)): Path<(String, String)>,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let sheet = editable_sheet(&caller, &id).await?;
            let Some(row) = records::delete_data_source(&caller.db, &sheet.id, &source_id).await?
            else {
                return Err(Refusal::not_found("Data source", &source_id));
            };
            caller
                .room(
                    &state,
                    &room_name(&org, &sheet.id),
                    "dropDataTable",
                    json!([sheet.room_meta(&org), row["id"], caller.user_id]),
                )
                .await?;
            reschedule(&state, &caller, &org, &sheet).await?;
            caller.publish(
                &state,
                SHEET_DATA_SOURCE_DELETED,
                &source_id,
                &data_source_event_data(&row),
            );
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── refreshes ───────────────────────────────────────────────────────────────

/// Lists the records and has the room write them, recording how it went
/// (`refreshNow`). A table not in the workbook yet goes at `at`.
async fn refresh_now(
    state: &SheetsState,
    caller: &Caller,
    org: &str,
    sheet: &SheetRecord,
    source: &Value,
    at: Option<Value>,
) -> Result<Value, Refusal> {
    let plan = caller
        .engine(
            state,
            "listDataTable",
            json!([
                org,
                {
                    "id": source["id"],
                    "objectType": source["objectType"],
                    "definition": source["definition"],
                    "createdById": source["createdById"],
                },
                file_ref_json(&sheet.file),
            ]),
        )
        .await?;
    let mut failure = if plan["ok"] == Value::Bool(true) {
        None
    } else {
        Some(plan["error"].as_str().unwrap_or("failed").to_owned())
    };
    if failure.is_none() {
        let mut write = plan["write"].clone();
        if let (Value::Object(fields), Some(at)) = (&mut write, at) {
            fields.insert("at".into(), at);
        }
        let written = caller
            .room(
                state,
                &room_name(org, &sheet.id),
                "writeDataTable",
                json!([sheet.room_meta(org), write, caller.user_id]),
            )
            .await?;
        if written["ok"] != Value::Bool(true) {
            failure = Some("unplaced".to_owned());
        }
    }
    let row_count = if failure.is_none() {
        plan["rowCount"].as_i64().unwrap_or(0)
    } else {
        0
    };
    let row = records::record_refresh(&caller.db, source, &now(), row_count, failure.as_deref())
        .await?
        .unwrap_or_else(|| source.clone());
    caller.publish(
        state,
        SHEET_DATA_SOURCE_UPDATED,
        row["id"].as_str().unwrap_or_default(),
        &data_source_event_data(&row),
    );
    Ok(json!({ "source": to_data_source(&row), "refreshed": failure.is_none() }))
}

/// Tells the room when the sheet's next scheduled refresh is due (`reschedule`).
async fn reschedule(
    state: &SheetsState,
    caller: &Caller,
    org: &str,
    sheet: &SheetRecord,
) -> Result<(), Refusal> {
    let next = records::next_due_at(&caller.db, &sheet.id).await?;
    caller
        .room(
            state,
            &room_name(org, &sheet.id),
            "scheduleRefresh",
            json!([sheet.room_meta(org), next]),
        )
        .await?;
    Ok(())
}
