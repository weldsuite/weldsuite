//! Version history (`routes/sheets/versions.ts`): saved copies of a sheet,
//! each a snapshot next to its checkpoint. The room holds the live workbook,
//! so it writes the snapshots and runs restores.

use std::io::Read;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::header::CACHE_CONTROL;
use http::{HeaderMap, HeaderValue};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    SHEET_UPDATED, SHEET_VERSION_CREATED, SHEET_VERSION_UPDATED,
};
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};
use weldsuite_ports::collab::value_bytes;

use crate::records::{
    self, NewVersion, get_version, room_name, to_version, version_event_data, version_key_for,
};
use crate::routes::{XLSX_TYPE, download, editable_sheet, find_sheet};
use crate::{Caller, Refusal, SheetsState, answer, now, validate, validate_query};

const DEFAULT_LIMIT: i64 = 50;

/// `{ name: z.string().trim().min(1).max(255) }`.
fn version_name(headers: &HeaderMap, body: &Bytes) -> Result<String, Refusal> {
    validate(headers, body, |issues, body| {
        issues
            .text_with(
                body,
                "name",
                Presence::Required,
                Text::trimmed(Some(1), Some(255)),
            )
            .into_option()
            .unwrap_or_default()
    })
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    answer(
        async {
            let (limit, cursor) = validate_query(raw.as_deref(), |issues, query| {
                let limit = issues.whole_number(
                    query,
                    "limit",
                    Presence::Optional,
                    Number {
                        coerce: true,
                        min: Some(1.0),
                        max: Some(200.0),
                        ..Number::default()
                    },
                );
                let cursor = issues.text(query, "cursor", Presence::Optional, Some(1), Some(255));
                (limit.into_option(), cursor.into_option())
            })?;
            let (sheet, _) = find_sheet(&caller, &id).await?;
            let limit = limit.unwrap_or(DEFAULT_LIMIT);
            let total = records::count_versions(&caller.db, &sheet.id).await?;
            let after = match cursor.as_deref() {
                Some(after) => match get_version(&caller.db, &sheet.id, after).await? {
                    Some(last) => Some(last),
                    // An unknown cursor is an empty page.
                    None => return Ok(page(&[], total, false)),
                },
                None => None,
            };
            let mut rows =
                records::list_versions(&caller.db, &sheet.id, limit, after.as_ref()).await?;
            let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
            rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
            Ok(page(&rows, total, has_more))
        }
        .await,
    )
}

fn page(rows: &[Value], total: i64, has_more: bool) -> Response {
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    List::new(
        rows.iter().map(to_version).collect(),
        Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<SheetsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let name = version_name(&headers, &body)?;
            let org = caller.org()?.to_owned();
            let sheet = editable_sheet(&caller, &id).await?;
            let meta = sheet.room_meta(&org);
            let version_id = generate_id("shtv");
            let snapshot_key = version_key_for(
                meta["snapshotKey"].as_str().unwrap_or_default(),
                &version_id,
            );
            let saved = caller
                .room(
                    &state,
                    &room_name(&org, &sheet.id),
                    "saveVersion",
                    json!([meta, snapshot_key]),
                )
                .await?;
            let row = records::insert_version(
                &caller.db,
                &NewVersion {
                    id: &version_id,
                    sheet_id: &sheet.id,
                    revision: &saved["revision"],
                    name: Some(&name),
                    snapshot_key: &snapshot_key,
                    size: &saved["size"],
                    created_by_id: &caller.user_id,
                },
                &now(),
            )
            .await?;
            caller.publish(
                &state,
                SHEET_VERSION_CREATED,
                &version_id,
                &version_event_data(&row),
            );
            Ok(Created(to_version(&row)).into_response())
        }
        .await,
    )
}

// ── PATCH /:versionId ───────────────────────────────────────────────────────

pub(crate) async fn rename(
    State(state): State<SheetsState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let name = version_name(&headers, &body)?;
            let sheet = editable_sheet(&caller, &id).await?;
            let Some(previous) = get_version(&caller.db, &sheet.id, &version_id).await? else {
                return Err(Refusal::not_found("Version", &version_id));
            };
            let Some(row) =
                records::rename_version(&caller.db, &sheet.id, &version_id, &name).await?
            else {
                return Err(Refusal::not_found("Version", &version_id));
            };
            let mut changes = Map::new();
            changes.insert(
                "name".into(),
                json!({ "old": previous["name"], "new": row["name"] }),
            );
            caller.publish_changes(
                &state,
                SHEET_VERSION_UPDATED,
                &version_id,
                &version_event_data(&row),
                changes,
            );
            Ok(Data(to_version(&row)).into_response())
        }
        .await,
    )
}

// ── GET /:versionId/snapshot and /export ────────────────────────────────────

/// A stored snapshot (`readSnapshot`): gzipped JSON `{ revision, workbook }`,
/// as its text.
fn read_snapshot(bytes: &[u8]) -> Option<String> {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

/// A version's stored workbook, if the caller may see the sheet (`storedVersion`).
async fn stored_version(
    state: &SheetsState,
    caller: &Caller,
    id: &str,
    version_id: &str,
) -> Result<(String, Value, Value, String), Refusal> {
    let (sheet, _) = find_sheet(caller, id).await?;
    let stored = match get_version(&caller.db, &sheet.id, version_id).await? {
        Some(version) => {
            let key = version["snapshotKey"].as_str().unwrap_or_default();
            let files = caller.files(state)?;
            let object = files.private.get_boxed(key).await.map_err(|error| {
                tracing::error!(%error, "[sheets-api] reading a version failed");
                Refusal::from(ApiError::internal())
            })?;
            match object {
                Some(object) => {
                    let text = read_snapshot(&object.bytes).unwrap_or_default();
                    let parsed = serde_json::from_str::<Value>(&text).ok();
                    // The workbook as stored, for the engine to read with its own key order.
                    let raw = serde_json::from_str::<
                        std::collections::HashMap<String, Box<serde_json::value::RawValue>>,
                    >(&text)
                    .ok()
                    .and_then(|fields| fields.get("workbook").map(|raw| raw.get().to_owned()));
                    let (Some(parsed), Some(raw)) = (parsed, raw) else {
                        tracing::error!(key, "[sheets-api] a version's snapshot does not read");
                        return Err(ApiError::internal().into());
                    };
                    Some((version, parsed, raw))
                }
                None => None,
            }
        }
        None => None,
    };
    let Some((version, stored, raw)) = stored else {
        return Err(Refusal::not_found("Version", version_id));
    };
    Ok((sheet.name, version, stored, raw))
}

pub(crate) async fn snapshot(
    State(state): State<SheetsState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
) -> Response {
    answer(
        async {
            let (_, _, stored, _) = stored_version(&state, &caller, &id, &version_id).await?;
            let mut response = Data(json!({
                "revision": stored["revision"],
                "snapshot": stored["workbook"],
            }))
            .into_response();
            response
                .headers_mut()
                .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
            Ok(response)
        }
        .await,
    )
}

pub(crate) async fn export(
    State(state): State<SheetsState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Response {
    answer(
        async {
            let (name, version, _, workbook) =
                stored_version(&state, &caller, &id, &version_id).await?;
            // `sheetFileLocaleSchema.safeParse(c.req.query('locale')).data`.
            let locale = weldsuite_kit::validation::query_values(raw.as_deref())
                .get("locale")
                .and_then(Value::as_str)
                .filter(|locale| matches!(*locale, "en" | "nl"))
                .map(str::to_owned);
            let bytes = caller
                .engine(&state, "exportWorkbook", json!([workbook, locale]))
                .await?;
            let bytes = value_bytes(&bytes).unwrap_or_default();
            // The version's name, or when it was saved (`yyyy-mm-dd hh:mm`).
            let label = match version["name"].as_str() {
                Some(label) => label.to_owned(),
                None => version["createdAt"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(16)
                    .collect::<String>()
                    .replacen('T', " ", 1),
            };
            let file_name = format!("{name} ({}).xlsx", label.replace(':', "."));
            Ok(download(bytes, XLSX_TYPE, &file_name))
        }
        .await,
    )
}

// ── POST /:versionId/restore ────────────────────────────────────────────────

pub(crate) async fn restore(
    State(state): State<SheetsState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let sheet = editable_sheet(&caller, &id).await?;
            let Some(version) = get_version(&caller.db, &sheet.id, &version_id).await? else {
                return Err(Refusal::not_found("Version", &version_id));
            };
            let auto_version_id = generate_id("shtv");
            let outcome = caller
                .room(
                    &state,
                    &room_name(&org, &sheet.id),
                    "restoreVersion",
                    json!([{
                        "sheet": sheet.room_meta(&org),
                        "versionId": version_id,
                        "versionKey": version["snapshotKey"],
                        "autoVersionId": auto_version_id,
                        "userId": caller.user_id,
                    }]),
                )
                .await?;
            if outcome["ok"] != Value::Bool(true) {
                return Err(Refusal::not_found("Version", &version_id));
            }
            let Some(auto_version) = get_version(&caller.db, &sheet.id, &auto_version_id).await?
            else {
                tracing::error!(
                    auto_version_id,
                    "[sheets-api] the automatic version is missing after a restore"
                );
                return Err(ApiError::internal().into());
            };
            let updated = records::get_sheet(&caller.db, &sheet.id)
                .await?
                .unwrap_or(sheet);
            caller.publish(
                &state,
                SHEET_VERSION_CREATED,
                &auto_version_id,
                &version_event_data(&auto_version),
            );
            let mut data = updated.event_data();
            data["revision"] = outcome["revision"].clone();
            data["updatedById"] = json!(caller.user_id);
            let mut changes = Map::new();
            changes.insert(
                "revision".into(),
                json!({ "old": auto_version["revision"], "new": outcome["revision"] }),
            );
            caller.publish_changes(&state, SHEET_UPDATED, &updated.id, &data, changes);
            Ok(Data(json!({
                "revision": outcome["revision"],
                "autoVersion": to_version(&auto_version),
            }))
            .into_response())
        }
        .await,
    )
}
