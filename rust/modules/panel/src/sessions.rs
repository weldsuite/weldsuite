//! `/api/panel/sessions` (`routes/sessions/index.ts`,
//! `services/recordings.ts`): one recording. The list is the `sessions`
//! kind of `POST /api/panel/query`.
//!
//!   GET    /:id               → metadata, chunk manifest, timeline markers, person, favourite, cached summary
//!   GET    /:id/chunks/:seq   → one chunk's gzip bytes, from the replays bucket
//!   PUT    /:id/favorite      → favourite with a note; copies the chunks to `keep/`
//!   DELETE /:id/favorite      → unfavourite; deletes the copies
//!   GET    /:id/summary       → the cached AI summary, or `data: null` (never charges)
//!   POST   /:id/summary       → generate (and charge for) one unless cached (`crate::ai_summaries`)
//!
//! All of it needs `panel_recordings:read` (a recording shows what a visitor
//! saw and did); the person on the detail also needs `panel_people:read`.
//! Every route takes `?projectId` (the body for PUT) and answers 404 for a
//! project of another workspace. Sessions are tracked-visitor data:
//! favourites never go on the entity bus (EVT-005).

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::PANEL_PEOPLE_READ;
use weldsuite_db::orm;
use weldsuite_kit::{ApiError, Data, NoContent};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::activity::{ActivityOptions, activity_query};
use weldsuite_panel_domain::query::{PanelQueryContext, Runner};
use weldsuite_permissions::Permissions;
use weldsuite_ports::{DynFileStore, PutOptions, StoredObject};
use weldsuite_schema::tenant::panel_session_favorites as favorites;
use weldsuite_zod::{Keys, S, Z};

use crate::engine::Engine;
use crate::people::{PROJECT_QUERY, events_from};
use crate::project_state::ProjectRef;
use crate::projects::live_project;
use crate::query::QueryDeps;
use crate::recordings::{
    Bindings, ChunkRecord, Failure, SESSION_ID, cache_manifest, cached_key, chunk_key_belongs,
    chunk_manifest_query, chunks_from_rows, favorite_dto, full_range, get_favorite, keep_copy_key,
    latest_session_summary, load_chunks, mark_favorites, overrides, session_context,
    session_summary_dto, sessions_rows, sessions_spec,
};
use crate::saved::js_row;
use crate::{Caller, PanelState, unexpected};

const MAX_MARKERS: i64 = 1000;
const OTHER_SESSIONS: usize = 10;

/// `favoritePanelSessionSchema`.
const FAVORITE_BODY: Z = Z::Obj(
    &[
        ("projectId", Z::Str(&[S::Min(1, None), S::Max(30, None)])),
        ("note", Z::Opt(&Z::Nul(&Z::Str(&[S::Max(2000, None)])))),
    ],
    Keys::Strip,
);

/// `scoped(c)`: the session id, or the answer to give instead.
fn scoped(caller: &Caller, session_id: &str) -> Result<(), Box<Response>> {
    if caller.workspace_id.is_empty() {
        return Err(Box::new(ApiError::org_required().into_response()));
    }
    if !SESSION_ID.is_match(session_id) {
        return Err(Box::new(
            ApiError::bad_request("Invalid session id").into_response(),
        ));
    }
    Ok(())
}

/// The project (`getProject`) or its 404.
async fn require_project(caller: &Caller, project_id: &str) -> Result<(), Box<Response>> {
    match live_project(caller, project_id).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(Box::new(
            ApiError::not_found("Project", Some(project_id)).into_response(),
        )),
        Err(error) => Err(Box::new(unexpected(&error, "get project"))),
    }
}

/// `projectQuery` of the query string, or its 400.
fn project_query(raw: Option<&str>) -> Result<String, Box<Response>> {
    weldsuite_zod::query(&PROJECT_QUERY, raw)
        .map(|parsed| parsed.text("projectId").unwrap_or_default().to_owned())
        .map_err(Box::new)
}

/// `loadSessionRow`: the session's row (one id through the `sessions`
/// kind), wide when it is a favourite (older than the 90 days recordings
/// are kept for).
pub(crate) async fn load_session_row(
    engine: &Engine,
    ctx: &PanelQueryContext,
    session_id: &str,
    wide: bool,
) -> Result<Option<Value>, Failure> {
    let range = if wide {
        full_range(ctx.now)
    } else {
        json!({ "preset": "90d" })
    };
    let spec = sessions_spec(
        &ctx.project_id,
        overrides([
            ("sessionIds", json!([session_id])),
            ("limit", json!(1)),
            ("dateRange", range),
        ]),
    )?;
    Ok(sessions_rows(&spec, ctx, engine).await?.into_iter().next())
}

/// The events the player marks: pages, clicks and form submits,
/// frustration, errors and custom events (`isTimelineMarker`).
fn is_timeline_marker(name: &str) -> bool {
    matches!(
        name,
        "$pageview"
            | "$exception"
            | "$autocapture"
            | "$rageclick"
            | "$deadclick"
            | "$quickback"
            | "$excessivescroll"
    ) || !name.starts_with('$')
}

/// `loadSessionDetail`.
async fn load_session_detail(
    caller: &Caller,
    panel: &PanelState,
    deps: &QueryDeps,
    project_id: &str,
    session_id: &str,
) -> Result<Option<Value>, Failure> {
    let Some(state) = caller.project_state(panel) else {
        return Err(Failure::unavailable("Recordings are not configured here"));
    };
    let favorite = get_favorite(caller, project_id, session_id).await?;
    // A favourite can be older than the 90 days recordings are kept for.
    let wide = favorite.is_some();
    let ctx = session_context(deps, project_id, Map::new()).await?;
    let engine = deps.engine()?;

    let events = activity_query(
        &ctx,
        &ActivityOptions {
            session_id: Some(session_id.to_owned()),
            limit: MAX_MARKERS,
            days: Some(if wide { 365 } else { 90 }),
            exclude_names: Some(vec!["$pageleave".to_owned(), "$identify".to_owned()]),
            ..ActivityOptions::default()
        },
    )?;
    let statements = [chunk_manifest_query(&ctx, session_id)?, events];
    let runner = Runner::new(&engine);
    let (row, rows) = futures_util::join!(
        load_session_row(&engine, &ctx, session_id, wide),
        runner.run(&statements)
    );
    let rows = rows?;
    let Some(row) = row? else {
        return Ok(None);
    };

    let text = |key: &str| row[key].as_str().map(str::to_owned);
    let person_id = text("userId")
        .or_else(|| text("distinctId"))
        .unwrap_or_default();
    let others_spec = sessions_spec(
        project_id,
        overrides([
            ("distinctId", row["distinctId"].clone()),
            ("limit", json!(OTHER_SESSIONS + 1)),
        ]),
    )?;
    let project = ProjectRef {
        workspace_id: &caller.workspace_id,
        project_id,
    };
    let (person, others, summary) = futures_util::join!(
        state.get_person(project, &person_id),
        sessions_rows(&others_spec, &ctx, &engine),
        latest_session_summary(caller, project_id, session_id)
    );
    let person = person?;
    let others: Vec<Value> = others?
        .into_iter()
        .filter(|s| s["sessionId"].as_str() != Some(session_id))
        .take(OTHER_SESSIONS)
        .collect();
    let summary = summary?;

    let mut marked = mark_favorites(
        caller,
        project_id,
        std::iter::once(row.clone()).chain(others).collect(),
    )
    .await?;
    let chunk_rows = rows.first().map_or(&[][..], Vec::as_slice);
    let event_rows = rows.get(1).map_or(&[][..], Vec::as_slice);
    let chunks = chunks_from_rows(chunk_rows, &ctx.workspace_id, project_id)?;
    cache_manifest(deps, project_id, session_id, &chunks).await;

    let mut markers: Vec<Value> = events_from(event_rows)?
        .into_iter()
        .filter(|event| is_timeline_marker(event["name"].as_str().unwrap_or_default()))
        .collect();
    markers.reverse();
    let session = if marked.is_empty() {
        row
    } else {
        marked.remove(0)
    };
    Ok(Some(json!({
        "projectId": project_id,
        "session": session,
        "person": person.map(|p| serde_json::to_value(p).unwrap_or(Value::Null)),
        "chunks": chunks.iter().map(ChunkRecord::entry).collect::<Vec<_>>(),
        "events": markers,
        "favorite": favorite.as_ref().map(favorite_dto),
        "summary": summary.as_ref().map(session_summary_dto),
        "otherSessions": marked,
    })))
}

/// `GET /:id`.
pub(crate) async fn detail(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(session_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let project_id = match project_query(raw.as_deref()) {
        Ok(project_id) => project_id,
        Err(response) => return *response,
    };
    if let Err(response) = scoped(&caller, &session_id) {
        return *response;
    }
    if let Err(response) = require_project(&caller, &project_id).await {
        return *response;
    }
    let deps = QueryDeps::new(&caller, &state);
    match load_session_detail(&caller, &state, &deps, &project_id, &session_id).await {
        Ok(Some(mut detail)) => {
            // Profiles carry emails: without `panel_people:read` the player
            // shows the visit, not the person.
            if !detail["person"].is_null() && !permissions.has_any(&[PANEL_PEOPLE_READ]) {
                detail["person"] = Value::Null;
            }
            Data(detail).into_response()
        }
        Ok(None) => ApiError::not_found("Session", Some(&session_id)).into_response(),
        Err(failure) => failure.into_response(),
    }
}

// ---------------------------------------------------------------------------
// Chunk bytes
// ---------------------------------------------------------------------------

/// `z.coerce.number().int().min(0).max(100_000)` of the path's chunk number.
fn seq_of(raw: &str) -> Option<f64> {
    let seq = js::string_to_number(raw);
    (seq.is_finite() && seq.fract() == 0.0 && (0.0..=100_000.0).contains(&seq)).then_some(seq)
}

/// `chunkKeyFor`: the key of one chunk, from the cached manifest (filled
/// when the session detail was opened), else from the engine. `None` when
/// the session has no such chunk (or its key belongs to someone else).
async fn chunk_key_for(
    deps: &QueryDeps,
    project_id: &str,
    session_id: &str,
    seq: f64,
) -> Result<Option<String>, Failure> {
    if let Some(cached) = cached_key(deps, project_id, session_id, seq).await
        && chunk_key_belongs(&cached, &deps.workspace_id, project_id)
    {
        return Ok(Some(cached));
    }
    let ctx = session_context(deps, project_id, Map::new()).await?;
    let engine = deps.engine()?;
    let chunks = load_chunks(&engine, &ctx, session_id).await?;
    cache_manifest(deps, project_id, session_id, &chunks).await;
    #[allow(clippy::float_cmp, reason = "JavaScript's `===` of two numbers")]
    let found = chunks.into_iter().find(|chunk| chunk.seq == seq);
    Ok(found.map(|chunk| chunk.r2_key))
}

/// `openChunk`: the original, else (for a favourite whose original expired)
/// its `keep/` copy.
async fn open_chunk(
    caller: &Caller,
    bucket: &dyn DynFileStore,
    project_id: &str,
    session_id: &str,
    key: &str,
) -> Result<Option<StoredObject>, Failure> {
    if let Some(original) = bucket.get_boxed(key).await? {
        return Ok(Some(original));
    }
    if get_favorite(caller, project_id, session_id)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    Ok(bucket.get_boxed(&keep_copy_key(key)).await?)
}

/// `GET /:id/chunks/:seq`: raw gzip, deliberately without
/// `Content-Encoding` (the player decompresses it itself).
pub(crate) async fn chunk(
    State(state): State<PanelState>,
    caller: Caller,
    bindings: Bindings,
    Path((session_id, raw_seq)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Response {
    let project_id = match project_query(raw.as_deref()) {
        Ok(project_id) => project_id,
        Err(response) => return *response,
    };
    if let Err(response) = scoped(&caller, &session_id) {
        return *response;
    }
    let Some(seq) = seq_of(&raw_seq) else {
        return ApiError::bad_request("Invalid chunk number").into_response();
    };
    if let Err(response) = require_project(&caller, &project_id).await {
        return *response;
    }
    let Some(bucket) = bindings.replays(&state) else {
        return ApiError::not_found("Recording", Some(&session_id)).into_response();
    };
    let missing = || {
        ApiError::not_found(
            "Chunk",
            Some(&format!("{session_id}/{}", js::number_text(seq))),
        )
        .into_response()
    };
    let deps = QueryDeps::new(&caller, &state);
    let object = async {
        let Some(key) = chunk_key_for(&deps, &project_id, &session_id, seq).await? else {
            return Ok(None);
        };
        open_chunk(&caller, bucket.as_ref(), &project_id, &session_id, &key).await
    };
    match object.await {
        Ok(Some(object)) => chunk_response(object),
        Ok(None) => missing(),
        Err(failure) => failure.into_response(),
    }
}

fn chunk_response(object: StoredObject) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/gzip"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Some(etag) = object
        .info
        .etag
        .as_deref()
        .and_then(|etag| HeaderValue::from_str(&format!("\"{etag}\"")).ok())
    {
        headers.insert(header::ETAG, etag);
    }
    (StatusCode::OK, headers, Body::from(object.bytes)).into_response()
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

/// `copyChunksToKeep`: the session's chunks under `keep/`, six at a time;
/// chunks already expired are skipped. How many were copied.
async fn copy_chunks_to_keep(
    bucket: &Arc<dyn DynFileStore>,
    chunks: &[ChunkRecord],
) -> Result<usize, Failure> {
    let mut copied = 0;
    for batch in chunks.chunks(6) {
        let results = futures_util::future::try_join_all(batch.iter().map(|chunk| async move {
            let Some(object) = bucket.get_boxed(&chunk.r2_key).await? else {
                return Ok::<_, Failure>(false);
            };
            let options = PutOptions::content_type("application/gzip")
                .with_metadata("source", chunk.r2_key.clone());
            bucket
                .put_boxed(&keep_copy_key(&chunk.r2_key), object.bytes, &options)
                .await?;
            Ok(true)
        }))
        .await?;
        copied += results.into_iter().filter(|copied| *copied).count();
    }
    Ok(copied)
}

/// `upsertFavorite`: a new favourite, or the note of the one there is.
async fn upsert_favorite(
    caller: &Caller,
    project_id: &str,
    session_id: &str,
    note: Option<&str>,
) -> Result<Value, Failure> {
    let row = favorites::Entity::insert(favorites::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id("pnf")),
        project_id: Set(project_id.to_owned()),
        session_id: Set(session_id.to_owned()),
        note: Set(note.map(str::to_owned)),
        favorited_by_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([favorites::Column::ProjectId, favorites::Column::SessionId])
            .update_column(favorites::Column::Note)
            .to_owned(),
    )
    .exec_with_returning(&orm(&caller.db))
    .await?;
    Ok(js_row(row)?)
}

/// `PUT /:id/favorite`.
pub(crate) async fn favorite(
    State(state): State<PanelState>,
    caller: Caller,
    bindings: Bindings,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match weldsuite_zod::json(&FAVORITE_BODY, &headers, &body) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    if let Err(response) = scoped(&caller, &session_id) {
        return *response;
    }
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    if let Err(response) = require_project(&caller, &project_id).await {
        return *response;
    }
    let note = parsed.get("note").and_then(Value::as_str);
    let deps = QueryDeps::new(&caller, &state);
    let saved = async {
        let ctx = session_context(&deps, &project_id, Map::new()).await?;
        // Only a session that exists can be favourited, and the copies need its chunk keys.
        let known = get_favorite(&caller, &project_id, &session_id)
            .await?
            .is_some();
        let engine = deps.engine()?;
        if load_session_row(&engine, &ctx, &session_id, known)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        if let Some(bucket) = bindings.replays(&state) {
            let chunks = load_chunks(&engine, &ctx, &session_id).await?;
            if copy_chunks_to_keep(&bucket, &chunks).await? == 0 {
                tracing::warn!(
                    session = session_id.as_str(),
                    "[panel-api] favourite: no chunk was copied to keep/ (none stored, or already expired)"
                );
            }
        }
        upsert_favorite(&caller, &project_id, &session_id, note)
            .await
            .map(Some)
    };
    match saved.await {
        Ok(Some(row)) => Data(favorite_dto(&row)).into_response(),
        Ok(None) => ApiError::not_found("Session", Some(&session_id)).into_response(),
        Err(failure) => failure.into_response(),
    }
}

/// `DELETE /:id/favorite`: the copies first, the row last, so a failure
/// leaves the favourite there to repeat the request on.
pub(crate) async fn unfavorite(
    State(state): State<PanelState>,
    caller: Caller,
    bindings: Bindings,
    Path(session_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let project_id = match project_query(raw.as_deref()) {
        Ok(project_id) => project_id,
        Err(response) => return *response,
    };
    if let Err(response) = scoped(&caller, &session_id) {
        return *response;
    }
    if let Err(response) = require_project(&caller, &project_id).await {
        return *response;
    }
    match get_favorite(&caller, &project_id, &session_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Favorite", Some(&session_id)).into_response(),
        Err(error) => return unexpected(&error, "get favorite"),
    }
    let deps = QueryDeps::new(&caller, &state);
    let removed = async {
        if let Some(bucket) = bindings.replays(&state) {
            let ctx = session_context(&deps, &project_id, Map::new()).await?;
            let engine = deps.engine()?;
            let chunks = load_chunks(&engine, &ctx, &session_id).await?;
            let keys: Vec<String> = chunks
                .iter()
                .map(|chunk| keep_copy_key(&chunk.r2_key))
                .collect();
            for batch in keys.chunks(1000) {
                bucket.delete_many_boxed(batch).await?;
            }
        }
        favorites::Entity::delete_many()
            .filter(favorites::Column::ProjectId.eq(&project_id))
            .filter(favorites::Column::SessionId.eq(&session_id))
            .exec(&orm(&caller.db))
            .await?;
        Ok::<_, Failure>(())
    };
    match removed.await {
        Ok(()) => NoContent.into_response(),
        Err(failure) => failure.into_response(),
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/// `GET /:id/summary`: the cached AI summary, or `null`.
pub(crate) async fn summary(
    caller: Caller,
    Path(session_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let project_id = match project_query(raw.as_deref()) {
        Ok(project_id) => project_id,
        Err(response) => return *response,
    };
    if let Err(response) = scoped(&caller, &session_id) {
        return *response;
    }
    if let Err(response) = require_project(&caller, &project_id).await {
        return *response;
    }
    match latest_session_summary(&caller, &project_id, &session_id).await {
        Ok(row) => Data(row.as_ref().map(session_summary_dto)).into_response(),
        Err(error) => unexpected(&error, "session summary"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_numbers_read_like_zod_coerce() {
        assert_eq!(seq_of("0"), Some(0.0));
        assert_eq!(seq_of("1e2"), Some(100.0));
        assert_eq!(seq_of("-1"), None);
        assert_eq!(seq_of("abc"), None);
        assert_eq!(seq_of("1.5"), None);
        assert_eq!(seq_of("100001"), None);
        assert!(is_timeline_marker("$pageview"));
        assert!(is_timeline_marker("Added to cart"));
        assert!(!is_timeline_marker("$pageleave"));
    }
}
