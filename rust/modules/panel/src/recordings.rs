//! What the people, recordings, groups and heatmap routes share
//! (`services/recordings.ts`, `services/rows.ts` and `http.ts`'s
//! `queryFailure`): a session's chunk manifest, favourites and cached AI
//! summaries, the `sessions` spec a project's query context is built for,
//! and how a failed read answers.
//!
//! There is no session table. A session's metrics are an aggregate over
//! `events_v1` (the `sessions` query kind, filtered to one id), its chunks
//! are rows of `replay_chunks_v1`, and the bytes live in the replays bucket
//! under the `r2_key` the collector wrote (on the Kubernetes editions,
//! [`crate::PanelBucketReplays`] maps it into the panel bucket). Keys are
//! always read from that row, never rebuilt, and every key read from the
//! engine is checked against the request's workspace and project before it
//! is touched.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use regex::Regex;
use serde_json::{Map, Value, json};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::rows::{to_iso, to_number, to_text};
use weldsuite_panel_domain::query::scope::{replay_chunks_table, scope_conds};
use weldsuite_panel_domain::query::sql::{lit, ts};
use weldsuite_panel_domain::query::time::resolve_range;
use weldsuite_panel_domain::query::{
    PanelError, PanelQueryContext, PanelQueryError, PanelSqlQuery, Row, Runner, run_panel_query,
};
use weldsuite_panel_domain::schemas::{DateRange, PanelQuerySpec};
use weldsuite_ports::{Cache, DynFileStore};

use crate::collector::RequestCollector;
use crate::engine::Engine;
use crate::erasure::{ErasureQueue, RequestErasureQueue};
use crate::query::{QueryDeps, QueryFailure};
use crate::schemas_gen::PANEL_QUERY_SPEC;
use crate::{Caller, PanelState};

/// What the client names a session with: word characters and dashes (the
/// collector's rule).
pub(crate) static SESSION_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("a valid pattern"));

/// How long a session's chunk manifest is cached.
const MANIFEST_CACHE_TTL: Duration = Duration::from_secs(3600);
const MAX_CHUNKS: i64 = 5000;

/// The lifecycle tiers the collector writes (`REPLAY_TIERS`).
const REPLAY_TIERS: [&str; 3] = ["30d", "90d", "keep"];

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/// Why a read could not answer (`queryFailure` in `http.ts`).
#[derive(Debug)]
pub(crate) enum Failure {
    /// The compiler refused the statement or the spec (`PanelQueryError`): 400.
    Query(String),
    /// A binding or setting is missing here (`QueryUnavailableError`): 503.
    Unavailable(String),
    /// The engine, the project state, the bucket or a database failed: 502.
    Upstream(String),
}

impl Failure {
    pub(crate) fn upstream(error: impl std::fmt::Display) -> Self {
        Self::Upstream(error.to_string())
    }

    pub(crate) fn unavailable(message: &str) -> Self {
        Self::Unavailable(message.to_owned())
    }

    /// `queryFailure(c, err)`.
    pub(crate) fn into_response(self) -> Response {
        match self {
            Self::Query(message) => ApiError::bad_request(message).into_response(),
            Self::Unavailable(message) => ApiError::unavailable(message).into_response(),
            Self::Upstream(error) => {
                tracing::error!(%error, "[panel-api] query failed");
                ApiError::bad_gateway()
                    .with_message("The analytics store did not answer")
                    .into_response()
            }
        }
    }
}

impl From<QueryFailure> for Failure {
    fn from(failure: QueryFailure) -> Self {
        match failure {
            QueryFailure::Query(message) => Self::Query(message),
            QueryFailure::Unavailable => {
                Self::Unavailable("Analytics queries are not configured here".to_owned())
            }
            QueryFailure::Upstream(error) => Self::Upstream(error),
        }
    }
}

impl From<PanelError> for Failure {
    fn from(error: PanelError) -> Self {
        match error {
            PanelError::Query(error) => Self::Query(error.message),
            PanelError::Engine(error) => Self::Upstream(error.to_string()),
        }
    }
}

impl From<PanelQueryError> for Failure {
    fn from(error: PanelQueryError) -> Self {
        Self::Query(error.message)
    }
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::upstream(error)
    }
}

impl From<weldsuite_ports::PortError> for Failure {
    fn from(error: weldsuite_ports::PortError) -> Self {
        Self::upstream(error)
    }
}

// ---------------------------------------------------------------------------
// The request's bucket and erasure queue
// ---------------------------------------------------------------------------

/// What the visitor routes take from the request besides [`Caller`]: the
/// replays bucket (`PANEL_REPLAYS`) and where erasures are queued
/// (`PANEL_MAINTENANCE`), the test's in conformance builds.
pub(crate) struct Bindings {
    conformance: bool,
    replays: Option<Arc<dyn DynFileStore>>,
    erasure: Option<Arc<dyn ErasureQueue>>,
}

impl Bindings {
    /// `c.env.PANEL_REPLAYS`: the test's (conformance), else the panel bucket.
    pub(crate) fn replays(&self, state: &PanelState) -> Option<Arc<dyn DynFileStore>> {
        if self.conformance {
            return self.replays.clone();
        }
        state.replays.clone()
    }

    /// `c.env.PANEL_MAINTENANCE`: the test's queue (conformance), else the
    /// master `panel_erasure_ledger`.
    pub(crate) fn erasure(
        &self,
        caller: &Caller,
        state: &PanelState,
    ) -> Option<Arc<dyn ErasureQueue>> {
        if self.conformance {
            return self.erasure.clone();
        }
        caller.master(state).map(|master| {
            Arc::new(crate::erasure::MasterErasureLedger::new(master)) as Arc<dyn ErasureQueue>
        })
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Bindings {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        std::future::ready(Ok(Self {
            conformance: extensions.get::<RequestEnv>().is_some(),
            replays: extensions
                .get::<RequestCollector>()
                .and_then(|collector| collector.replays.clone()),
            erasure: extensions
                .get::<RequestErasureQueue>()
                .and_then(|queue| queue.0.clone()),
        }))
    }
}

// ---------------------------------------------------------------------------
// Rows (`rows.ts`)
// ---------------------------------------------------------------------------

/// `numberOf`.
pub(crate) fn number_of(value: Option<&Value>) -> f64 {
    to_number(value)
}

/// `textOf`.
pub(crate) fn text_of(value: Option<&Value>) -> String {
    to_text(value)
}

/// `isoOf`; an error where JavaScript throws (a number that is no date).
pub(crate) fn iso_of(value: Option<&Value>) -> Result<String, Failure> {
    to_iso(value).ok_or_else(|| Failure::Upstream("Invalid time value".to_owned()))
}

/// A whole number as JSON writes it; anything else as it is.
pub(crate) fn js_number(number: f64) -> Value {
    js::json_numbers(json!(number))
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// `<tier>/<workspace>/<project>/<day>/<session>/<seq>.json.gz` and nothing
/// else: the tier is one the collector writes, the workspace and project are
/// the request's, and no segment tries to climb out.
pub(crate) fn chunk_key_belongs(key: &str, workspace_id: &str, project_id: &str) -> bool {
    let parts: Vec<&str> = key.split('/').collect();
    parts.len() == 6
        && REPLAY_TIERS.contains(&parts[0])
        && parts[1] == workspace_id
        && parts[2] == project_id
        && parts.iter().all(|part| !matches!(*part, "" | "." | ".."))
}

/// `keepCopyKey`: a favourite's copy under `keep/`, which outlives the
/// lifecycle rule that removes the original.
pub(crate) fn keep_copy_key(key: &str) -> String {
    match key.split_once('/') {
        Some((_, rest)) => format!("keep/{rest}"),
        None => format!("keep/{key}"),
    }
}

fn manifest_cache_key(project_id: &str, session_id: &str) -> String {
    format!("panel:replay-manifest:{project_id}:{session_id}")
}

// ---------------------------------------------------------------------------
// The project's context
// ---------------------------------------------------------------------------

/// `today(now)`: `YYYY-MM-DD` of the day, UTC.
pub(crate) fn today(now: i64) -> String {
    js::iso_day(now)
}

/// `fullRange(now)`: everything the plan keeps, a range from long ago the
/// compiler clamps to the plan's retention.
pub(crate) fn full_range(now: Option<i64>) -> Value {
    json!({ "from": "2020-01-01", "to": today(now.unwrap_or_else(js::now_millis)) })
}

/// The same as a compiler range.
pub(crate) fn full_date_range(now: Option<i64>) -> DateRange {
    DateRange::Custom {
        from: "2020-01-01".to_owned(),
        to: today(now.unwrap_or_else(js::now_millis)),
    }
}

/// `sessionsSpec(projectId, overrides)`: a `sessions` spec, also what a
/// project's context is built for. A spec Zod refuses throws in TypeScript
/// (a `ZodError`, not a query error): 502.
pub(crate) fn sessions_spec(
    project_id: &str,
    overrides: Map<String, Value>,
) -> Result<PanelQuerySpec, Failure> {
    let mut raw = Map::new();
    raw.insert("kind".to_owned(), json!("sessions"));
    raw.insert("projectId".to_owned(), json!(project_id));
    raw.insert("dateRange".to_owned(), json!({ "preset": "90d" }));
    raw.extend(overrides);
    let parsed = weldsuite_zod::parse_issues(&PANEL_QUERY_SPEC, &Value::Object(raw))
        .map_err(|issues| Failure::Upstream(format!("a sessions spec Zod refuses: {issues:?}")))?;
    serde_json::from_value(Value::Object(parsed.body)).map_err(Failure::upstream)
}

/// `sessionContext(deps, projectId, overrides)`: the project's query
/// context, built for a `sessions` spec (`overrides` shape it: a `cohortId`
/// loads that cohort).
pub(crate) async fn session_context(
    deps: &QueryDeps,
    project_id: &str,
    overrides: Map<String, Value>,
) -> Result<PanelQueryContext, Failure> {
    let spec = sessions_spec(project_id, overrides)?;
    Ok(deps.context(project_id, &spec).await?)
}

/// A one-key override.
pub(crate) fn overrides<const N: usize>(pairs: [(&str, Value); N]) -> Map<String, Value> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

/// Runs a `sessions` spec and answers its rows as JSON (`result.sessions`).
pub(crate) async fn sessions_rows(
    spec: &PanelQuerySpec,
    ctx: &PanelQueryContext,
    engine: &Engine,
) -> Result<Vec<Value>, Failure> {
    let output = run_panel_query(spec, ctx, engine).await?;
    let mut result = output.result.to_json();
    if result["kind"] != "sessions" {
        return Ok(Vec::new());
    }
    Ok(match result["result"]["sessions"].take() {
        Value::Array(rows) => rows,
        _ => Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// Chunk manifests
// ---------------------------------------------------------------------------

/// `chunkManifestQuery`: the session's chunk rows, scoped and time-bound
/// like every other statement.
pub(crate) fn chunk_manifest_query(
    ctx: &PanelQueryContext,
    session_id: &str,
) -> Result<PanelSqlQuery, Failure> {
    let range = resolve_range(&full_date_range(ctx.now), "UTC", ctx)?;
    let mut conds = scope_conds(ctx, "")?;
    conds.push(format!("ts_start >= {}", ts(range.floor)));
    conds.push(format!("ts_start <= {}", ts(range.now)));
    conds.push(format!("session_id = {}", lit(session_id)?));
    Ok(PanelSqlQuery {
        name: "recordings.manifest".to_owned(),
        sql: format!(
            "SELECT seq, ts_start, ts_end, bytes, has_full_snapshot, r2_key FROM {} WHERE {} ORDER BY seq ASC LIMIT {MAX_CHUNKS}",
            replay_chunks_table(),
            conds.join(" AND ")
        ),
        columns: [
            "seq",
            "ts_start",
            "ts_end",
            "bytes",
            "has_full_snapshot",
            "r2_key",
        ]
        .map(str::to_owned)
        .to_vec(),
    })
}

/// One chunk of the manifest, with its storage key (`ChunkRecord`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ChunkRecord {
    pub(crate) seq: f64,
    pub(crate) ts_start: String,
    pub(crate) ts_end: String,
    pub(crate) bytes: f64,
    pub(crate) has_full_snapshot: bool,
    pub(crate) r2_key: String,
}

impl ChunkRecord {
    /// `PanelChunkManifestEntry`: without the storage key.
    pub(crate) fn entry(&self) -> Value {
        json!({
            "seq": js_number(self.seq),
            "tsStart": self.ts_start,
            "tsEnd": self.ts_end,
            "bytes": js_number(self.bytes),
            "hasFullSnapshot": self.has_full_snapshot,
        })
    }
}

/// `has_full_snapshot === true || === 'true' || === 1`.
fn is_true(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => text == "true",
        Some(Value::Number(number)) => number.as_f64() == Some(1.0),
        _ => false,
    }
}

/// `chunksFromRows`: one entry per seq (a re-sent chunk counts once), in
/// order, with keys that belong to the request only.
pub(crate) fn chunks_from_rows(
    rows: &[Row],
    workspace_id: &str,
    project_id: &str,
) -> Result<Vec<ChunkRecord>, Failure> {
    let mut by_seq: Vec<ChunkRecord> = Vec::new();
    for row in rows {
        let r2_key = text_of(row.get("r2_key"));
        if !chunk_key_belongs(&r2_key, workspace_id, project_id) {
            tracing::warn!(
                project = project_id,
                "[panel-api] ignoring a chunk row with a foreign or malformed key"
            );
            continue;
        }
        let seq = number_of(row.get("seq"));
        #[allow(
            clippy::float_cmp,
            reason = "a Map keyed by the number, as JavaScript's"
        )]
        let seen = by_seq.iter().any(|chunk| chunk.seq == seq);
        if seen {
            continue;
        }
        by_seq.push(ChunkRecord {
            seq,
            ts_start: iso_of(row.get("ts_start"))?,
            ts_end: iso_of(row.get("ts_end"))?,
            bytes: number_of(row.get("bytes")),
            has_full_snapshot: is_true(row.get("has_full_snapshot")),
            r2_key,
        });
    }
    by_seq.sort_by(|a, b| a.seq.total_cmp(&b.seq));
    Ok(by_seq)
}

/// `loadChunks`: runs the manifest statement for a session.
pub(crate) async fn load_chunks(
    engine: &Engine,
    ctx: &PanelQueryContext,
    session_id: &str,
) -> Result<Vec<ChunkRecord>, Failure> {
    let rows = Runner::new(engine)
        .run_one(chunk_manifest_query(ctx, session_id)?)
        .await?;
    chunks_from_rows(&rows, &ctx.workspace_id, &ctx.project_id)
}

/// `cacheManifest`: seq → key, an hour, so a chunk read skips the engine.
/// A cache that fails costs a lookup, never the request.
pub(crate) async fn cache_manifest(
    deps: &QueryDeps,
    project_id: &str,
    session_id: &str,
    chunks: &[ChunkRecord],
) {
    let Some(cache) = &deps.cache else {
        return;
    };
    if chunks.is_empty() {
        return;
    }
    // `JSON.stringify` of an object with whole-number keys: ascending.
    let entries: Vec<String> = chunks
        .iter()
        .map(|chunk| {
            format!(
                "{}:{}",
                Value::String(js::number_text(chunk.seq)),
                Value::String(chunk.r2_key.clone())
            )
        })
        .collect();
    let text = format!("{{{}}}", entries.join(","));
    if let Err(error) = cache
        .put(
            &manifest_cache_key(project_id, session_id),
            &text,
            Some(MANIFEST_CACHE_TTL),
        )
        .await
    {
        tracing::warn!(%error, "[panel-api] replay manifest cache write failed");
    }
}

/// `cachedKey`: the key of `seq` in the cached manifest, if any.
pub(crate) async fn cached_key(
    deps: &QueryDeps,
    project_id: &str,
    session_id: &str,
    seq: f64,
) -> Option<String> {
    let cache = deps.cache.as_ref()?;
    let text = match cache.get(&manifest_cache_key(project_id, session_id)).await {
        Ok(Some(text)) => text,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(%error, "[panel-api] replay manifest cache read failed");
            return None;
        }
    };
    let hit: Value = match serde_json::from_str(&text) {
        Ok(hit) => hit,
        Err(error) => {
            tracing::warn!(%error, "[panel-api] replay manifest cache read failed");
            return None;
        }
    };
    let name = js::number_text(seq);
    let key = match &hit {
        Value::Object(map) => map.get(&name),
        Value::Array(items) => name.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    };
    key.and_then(Value::as_str).map(str::to_owned)
}

// ---------------------------------------------------------------------------
// Favourites and summaries (tenant rows)
// ---------------------------------------------------------------------------

/// `getFavorite`: the session's favourite row, as Drizzle reads it.
pub(crate) async fn get_favorite(
    caller: &Caller,
    project_id: &str,
    session_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from panel_session_favorites f
         where f.project_id = $1 and f.session_id = $2 limit 1",
    )
    .bind(project_id)
    .bind(session_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `toFavoriteDto`.
pub(crate) fn favorite_dto(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "projectId": field("projectId"),
        "sessionId": field("sessionId"),
        "note": field("note"),
        "favoritedByUserId": field("favoritedByUserId"),
        "createdAt": field("createdAt"),
    })
}

/// `latestSessionSummary`: the newest cached AI summary of the session.
pub(crate) async fn latest_session_summary(
    caller: &Caller,
    project_id: &str,
    session_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from panel_ai_summaries s
         where s.project_id = $1 and s.scope = 'session' and s.session_id = $2
         order by s.created_at desc limit 1",
    )
    .bind(project_id)
    .bind(session_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `toSessionSummaryDto`.
pub(crate) fn session_summary_dto(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let session_id = match row.get("sessionId") {
        Some(Value::Null) | None => Value::String(String::new()),
        Some(id) => id.clone(),
    };
    json!({
        "id": field("id"),
        "projectId": field("projectId"),
        "sessionId": session_id,
        "summary": field("summary"),
        "modelId": field("modelId"),
        "creditsCharged": field("creditsCharged"),
        "createdAt": field("createdAt"),
    })
}

/// `markFavorites`: sets `favorite` on session rows from the project's
/// favourites (per project, never cached with the data).
pub(crate) async fn mark_favorites(
    caller: &Caller,
    project_id: &str,
    mut sessions: Vec<Value>,
) -> Result<Vec<Value>, sqlx::Error> {
    if sessions.is_empty() {
        return Ok(sessions);
    }
    let ids: Vec<String> = sessions
        .iter()
        .map(|s| s["sessionId"].as_str().unwrap_or_default().to_owned())
        .collect();
    let favourites: Vec<String> = sqlx::query_scalar(
        "select session_id from panel_session_favorites
         where project_id = $1 and session_id = any($2)",
    )
    .bind(project_id)
    .bind(&ids)
    .fetch_all(&caller.db)
    .await?;
    for session in sessions.iter_mut().filter_map(Value::as_object_mut) {
        let favourite = session
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|id| favourites.iter().any(|f| f == id));
        session.insert("favorite".to_owned(), Value::Bool(favourite));
    }
    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_belong_to_the_request_only() {
        let key = "30d/ws_a/pnp_a/2026-11-10/ses_1/0.json.gz";
        assert!(chunk_key_belongs(key, "ws_a", "pnp_a"));
        assert!(!chunk_key_belongs(key, "ws_b", "pnp_a"));
        assert!(!chunk_key_belongs(key, "ws_a", "pnp_b"));
        assert!(!chunk_key_belongs(
            "30d/ws_a/pnp_a/../../ws_b/0.json.gz",
            "ws_a",
            "pnp_a"
        ));
        assert!(!chunk_key_belongs(
            "7d/ws_a/pnp_a/2026-11-10/ses_1/0.json.gz",
            "ws_a",
            "pnp_a"
        ));
        assert_eq!(
            keep_copy_key(key),
            "keep/ws_a/pnp_a/2026-11-10/ses_1/0.json.gz"
        );
    }

    #[test]
    fn chunks_count_each_seq_once_in_order() {
        let row = |seq: i64, key: &str| -> Row {
            serde_json::from_value(json!({
                "seq": seq, "ts_start": "2026-11-10 10:00:00", "ts_end": "2026-11-10 10:01:00",
                "bytes": "900", "has_full_snapshot": "true", "r2_key": key
            }))
            .expect("a row")
        };
        let rows = [
            row(1, "30d/ws/p/2026-11-10/s/1.json.gz"),
            row(0, "30d/ws/p/2026-11-10/s/0.json.gz"),
            row(1, "30d/ws/p/2026-11-10/s/1.json.gz"),
            row(2, "30d/other/p/2026-11-10/s/2.json.gz"),
        ];
        let chunks = chunks_from_rows(&rows, "ws", "p").expect("chunks");
        assert_eq!(chunks.iter().map(|c| c.seq).collect::<Vec<_>>(), [0.0, 1.0]);
        assert_eq!(
            chunks[0].entry(),
            json!({ "seq": 0, "tsStart": "2026-11-10T10:00:00.000Z", "tsEnd": "2026-11-10T10:01:00.000Z", "bytes": 900, "hasFullSnapshot": true })
        );
        assert!(SESSION_ID.is_match("ses_1-a"));
        assert!(!SESSION_ID.is_match("a'b"));
    }
}
