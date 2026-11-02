//! Version history (`routes/docs/versions.ts`): saved copies of a document,
//! each a snapshot next to its checkpoint. The room holds the live document,
//! so it writes the snapshots and runs restores.

use std::io::Read;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::header::CACHE_CONTROL;
use http::{HeaderMap, HeaderValue};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{DOC_UPDATED, DOC_VERSION_CREATED, DOC_VERSION_UPDATED};
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};

use crate::records::{
    self, DocRecord, NewVersion, get_version, room_name, to_version, version_event_data,
    version_key_for,
};
use crate::routes::{VIEW_ONLY, find_doc};
use crate::{Caller, DocsState, Refusal, answer, now, validate, validate_query};

const DEFAULT_LIMIT: i64 = 50;

/// The document, if the caller may change it (`editableDoc`).
async fn editable_doc(caller: &Caller, id: &str) -> Result<DocRecord, Refusal> {
    let (doc, role) = find_doc(caller, id).await?;
    if !caller.may_edit(role) {
        return Err(Refusal::forbidden(VIEW_ONLY));
    }
    Ok(doc)
}

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
            let (doc, _) = find_doc(&caller, &id).await?;
            let limit = limit.unwrap_or(DEFAULT_LIMIT);
            let total = records::count_versions(&caller.db, &doc.id).await?;
            let after = match cursor.as_deref() {
                Some(after) => match get_version(&caller.db, &doc.id, after).await? {
                    Some(last) => Some(last),
                    // An unknown cursor is an empty page.
                    None => return Ok(page(&[], total, false)),
                },
                None => None,
            };
            let mut rows =
                records::list_versions(&caller.db, &doc.id, limit, after.as_ref()).await?;
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
    State(state): State<DocsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let name = version_name(&headers, &body)?;
            let org = caller.org()?.to_owned();
            let doc = editable_doc(&caller, &id).await?;
            let meta = doc.room_meta(&org);
            let version_id = generate_id("docv");
            let snapshot_key = version_key_for(&doc.snapshot_key_in(&org), &version_id);
            let saved = caller
                .room(
                    &state,
                    &room_name(&org, &doc.id),
                    "saveVersion",
                    json!([meta, snapshot_key]),
                )
                .await?;
            let row = records::insert_version(
                &caller.db,
                &NewVersion {
                    id: &version_id,
                    doc_id: &doc.id,
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
                DOC_VERSION_CREATED,
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
    State(state): State<DocsState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let name = version_name(&headers, &body)?;
            let doc = editable_doc(&caller, &id).await?;
            let Some(previous) = get_version(&caller.db, &doc.id, &version_id).await? else {
                return Err(Refusal::not_found("Version", &version_id));
            };
            let Some(row) =
                records::rename_version(&caller.db, &doc.id, &version_id, &name).await?
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
                DOC_VERSION_UPDATED,
                &version_id,
                &version_event_data(&row),
                changes,
            );
            Ok(Data(to_version(&row)).into_response())
        }
        .await,
    )
}

// ── GET /:versionId/snapshot ────────────────────────────────────────────────

/// A stored snapshot (`readSnapshot`): gzipped JSON `{ revision, doc }`.
fn read_snapshot(bytes: &[u8]) -> Option<Value> {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .ok()?;
    serde_json::from_str(&text).ok()
}

pub(crate) async fn snapshot(
    State(state): State<DocsState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
) -> Response {
    answer(
        async {
            let (doc, _) = find_doc(&caller, &id).await?;
            let stored = match get_version(&caller.db, &doc.id, &version_id).await? {
                Some(version) => {
                    let key = version["snapshotKey"].as_str().unwrap_or_default();
                    let files = caller
                        .files(&state)
                        .ok_or_else(|| Refusal::from(ApiError::internal()))?;
                    let object = files.private.get_boxed(key).await.map_err(|error| {
                        tracing::error!(%error, "[docs-api] reading a version failed");
                        Refusal::from(ApiError::internal())
                    })?;
                    match object {
                        Some(object) => Some(read_snapshot(&object.bytes).ok_or_else(|| {
                            tracing::error!(key, "[docs-api] a version's snapshot does not read");
                            Refusal::from(ApiError::internal())
                        })?),
                        None => None,
                    }
                }
                None => None,
            };
            let Some(stored) = stored else {
                return Err(Refusal::not_found("Version", &version_id));
            };
            let mut response = Data(json!({
                "revision": stored["revision"],
                "snapshot": stored["doc"],
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

// ── POST /:versionId/restore ────────────────────────────────────────────────

pub(crate) async fn restore(
    State(state): State<DocsState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let doc = editable_doc(&caller, &id).await?;
            let Some(version) = get_version(&caller.db, &doc.id, &version_id).await? else {
                return Err(Refusal::not_found("Version", &version_id));
            };
            let auto_version_id = generate_id("docv");
            let outcome = caller
                .room(
                    &state,
                    &room_name(&org, &doc.id),
                    "restoreVersion",
                    json!([{
                        "doc": doc.room_meta(&org),
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
            let Some(auto_version) = get_version(&caller.db, &doc.id, &auto_version_id).await?
            else {
                tracing::error!(
                    auto_version_id,
                    "[docs-api] the automatic version is missing after a restore"
                );
                return Err(ApiError::internal().into());
            };
            let updated = records::get_doc(&caller.db, &doc.id).await?.unwrap_or(doc);
            caller.publish(
                &state,
                DOC_VERSION_CREATED,
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
            caller.publish_changes(&state, DOC_UPDATED, &updated.id, &data, changes);
            Ok(Data(json!({
                "revision": outcome["revision"],
                "autoVersion": to_version(&auto_version),
            }))
            .into_response())
        }
        .await,
    )
}
