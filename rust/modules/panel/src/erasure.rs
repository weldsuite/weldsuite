//! GDPR erasure of one tracked person (`services/erasure.ts`, plan
//! `weldpanel.md` "Privacy and GDPR"). In order:
//!
//! 1. the project state forgets the profile and identity links and adds
//!    every id to the erased list every query excludes from then on
//!    ([`PanelProjectState::erase`]);
//! 2. the person's sessions are found with the engine (without the
//!    exclusion: the ids are erased by now) and their recording chunks, and
//!    any `keep/` copy of a favourite, are deleted from the replays bucket;
//! 3. the favourites and AI summaries of those sessions are removed, and the
//!    set summaries that mention them;
//! 4. the erasure is queued for the table rewrite ([`ErasureQueue`]), which
//!    removes the rows from `events_v1`, `identities_v1`, `people_v1` and
//!    `replay_chunks_v1`.
//!
//! Step 1 comes first because it is what the law asks for "at once", and it
//! is idempotent, so when step 2 fails the caller is told to repeat the
//! request. Step 4 runs even then, so the rewrite never depends on the
//! bucket being reachable.
//!
//! Where step 4 goes: on Global the `PANEL_MAINTENANCE` queue, whose consumer
//! records the ids in its `MaintenanceLedger` Durable Object; here the master
//! `panel_erasure_ledger`, which `weldsuite cron panel-maintenance` reads
//! without opening a tenant database ([`MasterErasureLedger`]). Conformance
//! builds send the test's queue the same messages.

use std::sync::Arc;

use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde::Serialize;
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_panel_domain::query::scope::{
    ScopeOptions, events_scope, replay_chunks_table, scope_conds,
};
use weldsuite_panel_domain::query::sql::{in_list, ts};
use weldsuite_panel_domain::query::time::resolve_range;
use weldsuite_panel_domain::query::{PanelQueryContext, PanelSqlQuery, Runner};
use weldsuite_ports::{BoxFuture, DynFileStore, PortError};
use weldsuite_schema::master::panel_erasure_ledger as ledger;
use weldsuite_schema::tenant::{panel_ai_summaries as summaries, panel_session_favorites};

use crate::Caller;
use crate::engine::Engine;
use crate::project_state::{EraseInput, PanelProjectState, ProjectRef};
use crate::query::QueryDeps;
use crate::recordings::{
    Failure, chunk_key_belongs, full_date_range, keep_copy_key, session_context, text_of,
};

const MAX_SESSIONS: usize = 5000;
const MAX_CHUNK_ROWS: usize = 20_000;
const IN_LIST_BATCH: usize = 200;
/// Most ids one message holds (`PANEL_ERASE_MAX_IDS`): a bigger erasure is
/// sent as several.
const ERASE_MAX_IDS: usize = 1000;

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/// `PanelEraseMessage`: the ids of a person erased from one project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EraseMessage {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub workspace_id: String,
    pub project_id: String,
    pub ids: Vec<String>,
}

/// `eraseMessages`: the ids, unique and non-empty, in messages the
/// rewrite accepts.
pub fn erase_messages(workspace_id: &str, project_id: &str, ids: &[String]) -> Vec<EraseMessage> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !id.is_empty() && !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    unique
        .chunks(ERASE_MAX_IDS)
        .map(|chunk| EraseMessage {
            kind: "erase",
            workspace_id: workspace_id.to_owned(),
            project_id: project_id.to_owned(),
            ids: chunk.to_vec(),
        })
        .collect()
}

/// Where erasures wait for the table rewrite (`PANEL_MAINTENANCE`).
pub trait ErasureQueue: Send + Sync {
    /// `PANEL_MAINTENANCE.send(message)`.
    fn send<'a>(&'a self, message: &'a EraseMessage) -> BoxFuture<'a, Result<(), PortError>>;
}

/// The queue a request uses, when the request brings one (conformance: the
/// test's `PANEL_MAINTENANCE`, or `None` when the test binds none).
#[derive(Clone, Default)]
pub struct RequestErasureQueue(pub Option<Arc<dyn ErasureQueue>>);

impl std::fmt::Debug for RequestErasureQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("RequestErasureQueue")
            .field(&self.0.is_some())
            .finish()
    }
}

/// The Kubernetes editions' queue: one master `panel_erasure_ledger` row per
/// project and id. A repeated request sets `requested_at` again and clears
/// `applied_at`, so a rewrite that started before it doesn't count.
pub struct MasterErasureLedger {
    master: PgPool,
}

impl MasterErasureLedger {
    pub fn new(master: PgPool) -> Self {
        Self { master }
    }
}

impl ErasureQueue for MasterErasureLedger {
    fn send<'a>(&'a self, message: &'a EraseMessage) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            if message.ids.is_empty() {
                // `unnest('{}')`: nothing to record.
                return Ok(());
            }
            // `requested_at` is left to its default, `now()`, so the
            // conflict sets it again from `excluded`.
            let rows = message.ids.iter().map(|id| ledger::ActiveModel {
                workspace_id: Set(message.workspace_id.clone()),
                project_id: Set(message.project_id.clone()),
                erased_id: Set(id.clone()),
                applied_at: Set(None),
                ..Default::default()
            });
            ledger::Entity::insert_many(rows)
                .on_conflict(
                    OnConflict::columns([ledger::Column::ProjectId, ledger::Column::ErasedId])
                        .update_columns([
                            ledger::Column::WorkspaceId,
                            ledger::Column::RequestedAt,
                            ledger::Column::AppliedAt,
                        ])
                        .to_owned(),
                )
                .exec_without_returning(&orm(&self.master))
                .await
                .map(|_| ())
                .map_err(PortError::backend)
        })
    }
}

// ---------------------------------------------------------------------------
// The erasure
// ---------------------------------------------------------------------------

/// `PanelErasureResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErasureResult {
    pub(crate) user_id: Option<String>,
    pub(crate) erased_id_count: usize,
    pub(crate) recording_chunks_deleted: usize,
}

/// Why an erasure did not finish.
pub(crate) enum EraseFailure {
    /// Before the project state erased anything: answered as a query failure.
    Before(Failure),
    /// The profile is gone, but the recordings could not be fully removed or
    /// the rewrite queued (`ErasureIncompleteError`): 502, repeat the request.
    Incomplete(ErasureResult),
}

/// What [`erase_person`] works with.
pub(crate) struct EraseDeps<'a> {
    pub(crate) caller: &'a Caller,
    pub(crate) deps: &'a QueryDeps,
    pub(crate) state: Option<Arc<dyn PanelProjectState>>,
    pub(crate) replays: Option<Arc<dyn DynFileStore>>,
    pub(crate) queue: Option<Arc<dyn ErasureQueue>>,
}

/// What `lit` would turn into `chr()` pieces, and the rewrite matches by id
/// instead: a control character or a backslash.
fn not_queryable(id: &str) -> bool {
    id.chars()
        .any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}' | '\\'))
}

/// `sessionsOf`: the sessions any of `ids` took part in (as the visitor, the
/// identified user or the distinct id).
async fn sessions_of(
    engine: &Engine,
    base: &PanelQueryContext,
    ids: &[String],
) -> Result<Vec<String>, Failure> {
    // No exclusion and no identity join: the ids are erased by now, and the
    // columns named here are on the event itself.
    let ctx = PanelQueryContext {
        erased_ids: Vec::new(),
        has_identified_users: false,
        ..base.clone()
    };
    let range = resolve_range(&full_date_range(ctx.now), "UTC", &ctx)?;
    let scope = events_scope(&ctx, &range, range.bounds(), ScopeOptions::default())?;
    let list = in_list(ids)?;
    let id_match = format!(
        "(e.anon_id IN {list} OR e.distinct_id IN {list} OR COALESCE(e.user_id, '') IN {list})"
    );
    let sql = format!(
        "SELECT DISTINCT e.session_id AS session_id FROM {} {} LIMIT {MAX_SESSIONS}",
        scope.from,
        scope.where_sql(&["e.session_id IS NOT NULL", &id_match])
    );
    let rows = Runner::new(engine)
        .run_one(PanelSqlQuery {
            name: "erasure.sessions".to_owned(),
            sql,
            columns: vec!["session_id".to_owned()],
        })
        .await?;
    Ok(rows
        .iter()
        .map(|row| text_of(row.get("session_id")))
        .filter(|id| !id.is_empty())
        .collect())
}

/// `chunkKeysOf`: the storage keys of those sessions' chunks that belong to
/// the request's workspace and project.
async fn chunk_keys_of(
    engine: &Engine,
    ctx: &PanelQueryContext,
    session_ids: &[String],
) -> Result<Vec<String>, Failure> {
    let range = resolve_range(&full_date_range(ctx.now), "UTC", ctx)?;
    let runner = Runner::new(engine);
    let mut keys: Vec<String> = Vec::new();
    for batch in session_ids.chunks(IN_LIST_BATCH) {
        let mut conds = scope_conds(ctx, "")?;
        conds.push(format!("ts_start >= {}", ts(range.floor)));
        conds.push(format!("ts_start <= {}", ts(range.now)));
        conds.push(format!("session_id IN {}", in_list(batch)?));
        let rows = runner
            .run_one(PanelSqlQuery {
                name: "erasure.chunks".to_owned(),
                sql: format!(
                    "SELECT r2_key FROM {} WHERE {} LIMIT {MAX_CHUNK_ROWS}",
                    replay_chunks_table(),
                    conds.join(" AND ")
                ),
                columns: vec!["r2_key".to_owned()],
            })
            .await?;
        for row in &rows {
            let key = text_of(row.get("r2_key"));
            if chunk_key_belongs(&key, &ctx.workspace_id, &ctx.project_id) {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            } else {
                tracing::warn!(
                    project = ctx.project_id,
                    "[panel-api] erasure skipped a chunk row with a foreign or malformed key"
                );
            }
        }
    }
    Ok(keys)
}

async fn delete_favorites(
    caller: &Caller,
    project_id: &str,
    session_ids: &[String],
) -> Result<(), DbErr> {
    let db = orm(&caller.db);
    for batch in session_ids.chunks(500) {
        panel_session_favorites::Entity::delete_many()
            .filter(panel_session_favorites::Column::ProjectId.eq(project_id))
            .filter(
                panel_session_favorites::Column::SessionId.is_in(batch.iter().map(String::as_str)),
            )
            .exec(&db)
            .await?;
    }
    Ok(())
}

/// `JSON.stringify(id).slice(1, -1)`: how the id reads inside a JSON text.
fn json_inner(id: &str) -> String {
    let quoted = Value::String(id.to_owned()).to_string();
    quoted[1..quoted.len() - 1].to_owned()
}

/// The AI summaries that quote the sessions: the sessions' own, and the
/// project's set summaries whose themes mention any of them. A set summary
/// is cheap to make again; one that outlives the erasure is personal data.
async fn delete_ai_summaries(
    caller: &Caller,
    project_id: &str,
    session_ids: &[String],
) -> Result<(), DbErr> {
    let db = orm(&caller.db);
    for batch in session_ids.chunks(500) {
        summaries::Entity::delete_many()
            .filter(summaries::Column::ProjectId.eq(project_id))
            .filter(summaries::Column::Scope.eq("session"))
            .filter(summaries::Column::SessionId.is_in(batch.iter().map(String::as_str)))
            .exec(&db)
            .await?;
    }
    let sets: Vec<(String, Value)> = summaries::Entity::find()
        .select_only()
        .columns([summaries::Column::Id, summaries::Column::Summary])
        .filter(summaries::Column::ProjectId.eq(project_id))
        .filter(summaries::Column::Scope.eq("set"))
        .into_tuple()
        .all(&db)
        .await?;
    let needles: Vec<String> = session_ids.iter().map(|id| json_inner(id)).collect();
    let doomed: Vec<String> = sets
        .into_iter()
        .filter(|(_, summary)| {
            let text = summary.to_string();
            needles.iter().any(|needle| text.contains(needle.as_str()))
        })
        .map(|(id, _)| id)
        .collect();
    for batch in doomed.chunks(500) {
        summaries::Entity::delete_many()
            .filter(summaries::Column::ProjectId.eq(project_id))
            .filter(summaries::Column::Id.is_in(batch.iter().map(String::as_str)))
            .exec(&db)
            .await?;
    }
    Ok(())
}

/// Steps 2 and 3: the recordings, their favourites and their summaries.
/// The number of chunks deleted.
async fn delete_recordings(
    erase: &EraseDeps<'_>,
    bucket: &dyn DynFileStore,
    project_id: &str,
    ids: &[String],
) -> Result<usize, Failure> {
    let ctx = session_context(erase.deps, project_id, serde_json::Map::new()).await?;
    let queryable: Vec<String> = ids
        .iter()
        .filter(|id| !not_queryable(id))
        .cloned()
        .collect();
    let session_ids = if queryable.is_empty() {
        Vec::new()
    } else {
        let engine = erase.deps.engine()?;
        sessions_of(&engine, &ctx, &queryable).await?
    };
    if session_ids.is_empty() {
        return Ok(0);
    }
    let engine = erase.deps.engine()?;
    let keys = chunk_keys_of(&engine, &ctx, &session_ids).await?;
    // Originals and the `keep/` copies a favourite has: deleting a key that
    // is not there is a no-op.
    let all: Vec<String> = keys
        .iter()
        .cloned()
        .chain(keys.iter().map(|key| keep_copy_key(key)))
        .collect();
    for batch in all.chunks(1000) {
        bucket.delete_many_boxed(batch).await?;
    }
    delete_favorites(erase.caller, project_id, &session_ids).await?;
    delete_ai_summaries(erase.caller, project_id, &session_ids).await?;
    Ok(keys.len())
}

/// Step 4: the rewrite, whatever happened to the recordings.
async fn enqueue(
    queue: Option<&dyn ErasureQueue>,
    workspace_id: &str,
    project_id: &str,
    ids: &[String],
) -> Result<(), PortError> {
    let Some(queue) = queue else {
        tracing::warn!(
            "[panel-api] PANEL_MAINTENANCE is not bound: the Iceberg rewrite for an erasure was not queued"
        );
        return Ok(());
    };
    for message in erase_messages(workspace_id, project_id, ids) {
        queue.send(&message).await?;
    }
    Ok(())
}

/// `erasePerson`.
pub(crate) async fn erase_person(
    erase: EraseDeps<'_>,
    project_id: &str,
    distinct_id: &str,
) -> Result<ErasureResult, EraseFailure> {
    let workspace_id = erase.caller.workspace_id.clone();
    let Some(state) = erase.state.clone() else {
        return Err(EraseFailure::Before(Failure::unavailable(
            "People are not configured here",
        )));
    };

    // 1. At once, and the only step the law's "without undue delay" cannot wait for.
    let erasure = state
        .erase(
            ProjectRef {
                workspace_id: &workspace_id,
                project_id,
            },
            &EraseInput {
                workspace_id: workspace_id.clone(),
                project_id: project_id.to_owned(),
                user_id_or_anon_id: distinct_id.to_owned(),
            },
        )
        .await
        .map_err(|error| EraseFailure::Before(Failure::upstream(error)))?;
    let mut ids: Vec<String> = vec![distinct_id.to_owned()];
    for id in erasure.erased_ids {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut result = ErasureResult {
        user_id: erasure.user_id,
        erased_id_count: ids.len(),
        recording_chunks_deleted: 0,
    };

    // 2-3. Recordings. Without the bucket there are none; without the
    // engine they cannot be looked up.
    let mut failure: Option<String> = None;
    if let Some(bucket) = erase.replays.clone() {
        match delete_recordings(&erase, bucket.as_ref(), project_id, &ids).await {
            Ok(deleted) => result.recording_chunks_deleted = deleted,
            Err(Failure::Unavailable(_)) => tracing::warn!(
                "[panel-api] erasure: Basin is not configured, recordings were not looked up"
            ),
            Err(Failure::Query(error) | Failure::Upstream(error)) => failure = Some(error),
        }
    }

    // 4. The rewrite.
    if let Err(error) = enqueue(erase.queue.as_deref(), &workspace_id, project_id, &ids).await {
        tracing::error!(%error, "[panel-api] erasure: the maintenance message was not sent");
        failure.get_or_insert_with(|| error.to_string());
    }

    if let Some(error) = failure {
        tracing::error!(%error, "[panel-api] erasure incomplete");
        return Err(EraseFailure::Incomplete(result));
    }
    Ok(result)
}

/// The 502 of an erasure that left recordings or the rewrite to repeat.
pub(crate) fn incomplete(result: &ErasureResult) -> Value {
    json!({
        "error": {
            "code": "ERASURE_INCOMPLETE",
            "message": "The profile was erased, but its recordings could not be fully removed yet. Repeat the request.",
            "details": result,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_hold_unique_ids_a_thousand_at_a_time() {
        let ids: Vec<String> = (0..1500)
            .map(|i| format!("id_{i}"))
            .chain(["id_0".to_owned(), String::new()])
            .collect();
        let messages = erase_messages("ws", "pnp", &ids);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].ids.len(), 1000);
        assert_eq!(messages[1].ids.len(), 500);
        assert_eq!(
            serde_json::to_value(&messages[1]).expect("json")["type"],
            "erase"
        );
        assert!(not_queryable("CORP\\jdoe"));
        assert!(!not_queryable("user_1"));
        assert_eq!(json_inner("a\"b"), "a\\\"b");
    }
}
