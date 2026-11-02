//! The semantic search index subscriber: app-api's `search-index` queue
//! consumer (`queue/search-index-consumer.ts`) and the indexer behind it
//! (`services/search/indexer.ts`). It keeps `search_index` in the tenant
//! database in step with the records: chunks of each record's text, their
//! SHA-256, and an embedding per chunk.
//!
//! - A batch is grouped per workspace and coalesced per record: ten edits to
//!   one ticket are one re-index, and all ten messages share its outcome.
//! - The payload is never trusted: the record is read again, so a delete, a
//!   soft delete or a move into a private space all drop its chunks.
//! - Unchanged chunks (same hash, same model) are not embedded again.
//! - An event of a type that is not indexed is acked at once; a workspace
//!   that no longer resolves drops its jobs (acked); an indexing failure
//!   retries the record's messages.
//!
//! Embeddings come through the `Embeddings` port; without one configured the
//! subscriber does not run (TypeScript retries every batch until the AI
//! Gateway is configured).

mod chunks;
mod documents;

use std::collections::HashMap;
use std::sync::Arc;

use weldsuite_db::PgPool;
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition, Embeddings};

pub use chunks::{MAX_CHUNKS_PER_ENTITY, chunk_text, compose, hash_content};
pub use documents::{
    INDEXED_ENTITY_TYPES, IndexableDocument, Loaded, load_document, resolve_indexed_type,
    result_url,
};

use crate::event::HubEvent;
use crate::js;
use crate::tenants::{TenantError, Tenants};

/// The width of `search_index.embedding` (`vector(1024)`, bge-m3).
pub const EMBED_DIMENSIONS: usize = 1024;

/// What indexing one record did (`IndexResult`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexResult {
    pub entity_type: String,
    pub entity_id: String,
    pub embedded: usize,
    pub skipped: usize,
    pub removed: usize,
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// `removeFromIndex`: drop every chunk of a record.
pub async fn remove_from_index(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
) -> Result<usize, sqlx::Error> {
    let removed = sqlx::query("delete from search_index where entity_type = $1 and entity_id = $2")
        .bind(entity_type)
        .bind(entity_id)
        .execute(db)
        .await?;
    Ok(usize::try_from(removed.rows_affected()).unwrap_or(usize::MAX))
}

/// `pgvector`'s text form, `[0.1,0.2,…]`.
fn vector_text(vector: &[f32]) -> String {
    // The shortest text that reads back as the same `f32`.
    let parts: Vec<String> = vector.iter().map(ToString::to_string).collect();
    format!("[{}]", parts.join(","))
}

/// `indexDocument`: bring one record's chunks in line with its content.
#[allow(
    clippy::too_many_lines,
    reason = "one statement per step of indexDocument"
)]
pub async fn index_document(
    db: &PgPool,
    embeddings: &dyn Embeddings,
    doc: &IndexableDocument,
) -> Result<IndexResult, BoxError> {
    let mut result = IndexResult {
        entity_type: doc.entity_type.clone(),
        entity_id: doc.entity_id.clone(),
        ..IndexResult::default()
    };
    let chunks = chunk_text(&doc.content);
    if chunks.is_empty() {
        result.removed = remove_from_index(db, &doc.entity_type, &doc.entity_id).await?;
        return Ok(result);
    }

    let existing: Vec<(i32, String, String)> = sqlx::query_as(
        "select chunk_index, content_hash, embed_model from search_index \
         where entity_type = $1 and entity_id = $2",
    )
    .bind(&doc.entity_type)
    .bind(&doc.entity_id)
    .fetch_all(db)
    .await?;
    let model = embeddings.model();
    let hashes: Vec<String> = chunks.iter().map(|chunk| hash_content(chunk)).collect();

    let mut stale: Vec<(i32, &str, &str)> = Vec::new();
    for ((position, chunk), hash) in chunks.iter().enumerate().zip(&hashes) {
        let index = i32::try_from(position).unwrap_or(i32::MAX);
        let unchanged = existing
            .iter()
            .find(|(chunk_index, _, _)| *chunk_index == index)
            .is_some_and(|(_, prior, embed_model)| prior == hash && embed_model == model);
        if unchanged {
            result.skipped += 1;
        } else {
            stale.push((index, chunk, hash));
        }
    }

    let count = i32::try_from(chunks.len()).unwrap_or(i32::MAX);
    let surplus: Vec<i32> = existing
        .iter()
        .map(|(chunk_index, _, _)| *chunk_index)
        .filter(|chunk_index| *chunk_index >= count)
        .collect();
    if !surplus.is_empty() {
        sqlx::query("delete from search_index where entity_type = $1 and entity_id = $2 and chunk_index = any($3)")
            .bind(&doc.entity_type)
            .bind(&doc.entity_id)
            .bind(&surplus)
            .execute(db)
            .await?;
        result.removed = surplus.len();
    }
    if stale.is_empty() {
        return Ok(result);
    }

    let texts: Vec<String> = stale
        .iter()
        .map(|(_, text, _)| (*text).to_owned())
        .collect();
    let vectors = embeddings.embed(&texts).await?;
    if vectors.len() != stale.len() {
        return Err(format!(
            "[search-indexer] embedder returned {} vectors for {} chunks",
            vectors.len(),
            stale.len()
        )
        .into());
    }

    let ids: Vec<String> = stale
        .iter()
        .map(|_| weldsuite_kit::generate_id("sidx"))
        .collect();
    let indexes: Vec<i32> = stale.iter().map(|(index, _, _)| *index).collect();
    let hashes: Vec<String> = stale
        .iter()
        .map(|(_, _, hash)| (*hash).to_owned())
        .collect();
    let vectors: Vec<String> = vectors.iter().map(|v| vector_text(v)).collect();
    // One statement for every chunk, as Drizzle's multi-row insert.
    sqlx::query(
        "insert into search_index (id, entity_type, entity_id, chunk_index, content, content_hash, \
         embedding, embed_model, title, subtitle, url) \
         select t.id, $2, $3, t.chunk_index, t.content, t.content_hash, t.embedding::vector, $4, $5, $6, $7 \
         from unnest($1::text[], $8::int[], $9::text[], $10::text[], $11::text[]) \
         as t(id, chunk_index, content, content_hash, embedding) \
         on conflict (entity_type, entity_id, chunk_index) do update set \
         content = excluded.content, content_hash = excluded.content_hash, \
         embedding = excluded.embedding, embed_model = excluded.embed_model, \
         title = excluded.title, subtitle = excluded.subtitle, url = excluded.url, updated_at = now()",
    )
    .bind(&ids)
    .bind(&doc.entity_type)
    .bind(&doc.entity_id)
    .bind(model)
    .bind(js::slice_to(&doc.title, 500))
    .bind(doc.subtitle.as_deref().map(|subtitle| js::slice_to(subtitle, 500)))
    .bind(js::slice_to(&doc.url, 500))
    .bind(&indexes)
    .bind(&texts)
    .bind(&hashes)
    .bind(&vectors)
    .execute(db)
    .await?;
    result.embedded = stale.len();
    Ok(result)
}

/// `indexEntity`: re-read the record and index it, or drop its chunks when
/// it no longer loads. A type without a loader does nothing.
pub async fn index_entity(
    db: &PgPool,
    embeddings: &dyn Embeddings,
    entity_type: &str,
    entity_id: &str,
) -> Result<IndexResult, BoxError> {
    let empty = IndexResult {
        entity_type: entity_type.to_owned(),
        entity_id: entity_id.to_owned(),
        ..IndexResult::default()
    };
    match load_document(db, entity_type, entity_id).await? {
        Loaded::NoLoader => Ok(empty),
        Loaded::Missing => Ok(IndexResult {
            removed: remove_from_index(db, entity_type, entity_id).await?,
            ..empty
        }),
        Loaded::Document(doc) => index_document(db, embeddings, &doc).await,
    }
}

/// One coalesced record: the delivery positions it answers for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingIndex {
    pub entity_type: String,
    pub entity_id: String,
    pub positions: Vec<usize>,
}

/// `groupBatch`: one job per (workspace, search type, record), workspaces in
/// order of first appearance. Positions not in any job (malformed, or not an
/// indexed type) are acked.
pub fn group_batch(events: &[Option<HubEvent>]) -> Vec<(String, Vec<PendingIndex>)> {
    let mut workspaces: Vec<(String, Vec<PendingIndex>)> = Vec::new();
    for (position, event) in events.iter().enumerate() {
        let Some(event) = event else { continue };
        let workspace = event.metadata.workspace_id.as_str();
        let entity_type = (!event.entity_type.is_empty())
            .then(|| resolve_indexed_type(&event.entity_type))
            .flatten();
        let (Some(entity_type), false, false) = (
            entity_type,
            workspace.is_empty(),
            event.entity_id.is_empty(),
        ) else {
            continue;
        };
        let index = if let Some(index) = workspaces.iter().position(|(id, _)| id == workspace) {
            index
        } else {
            workspaces.push((workspace.to_owned(), Vec::new()));
            workspaces.len() - 1
        };
        let jobs = &mut workspaces[index].1;
        if let Some(job) = jobs
            .iter_mut()
            .find(|job| job.entity_type == entity_type && job.entity_id == event.entity_id)
        {
            job.positions.push(position);
        } else {
            jobs.push(PendingIndex {
                entity_type,
                entity_id: event.entity_id.clone(),
                positions: vec![position],
            });
        }
    }
    workspaces
}

/// The search-index subscriber.
#[derive(Clone)]
pub struct SearchSubscriber {
    tenants: Arc<dyn Tenants>,
    embeddings: Arc<dyn Embeddings>,
}

impl std::fmt::Debug for SearchSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchSubscriber")
            .field("model", &self.embeddings.model())
            .finish_non_exhaustive()
    }
}

impl SearchSubscriber {
    pub fn new(tenants: Arc<dyn Tenants>, embeddings: Arc<dyn Embeddings>) -> Self {
        Self {
            tenants,
            embeddings,
        }
    }

    /// `handleSearchIndexBatch`.
    pub async fn handle_batch(&self, batch: &[Delivery]) -> Vec<Disposition> {
        let events: Vec<Option<HubEvent>> = batch
            .iter()
            .map(|delivery| HubEvent::parse(&delivery.payload).ok())
            .collect();
        let mut out = vec![Disposition::Ack; batch.len()];
        let mut tenants: HashMap<String, Result<PgPool, TenantError>> = HashMap::new();
        for (workspace, jobs) in group_batch(&events) {
            let db = match tenants.remove(&workspace) {
                Some(db) => db,
                None => self
                    .tenants
                    .tenant(&workspace)
                    .await
                    .map(|tenant| tenant.db),
            };
            let db = match db {
                Ok(db) => db,
                Err(error) => {
                    // A workspace that cannot be resolved is usually deleted:
                    // ack rather than recycle its backlog.
                    tracing::error!(
                        workspace_id = workspace,
                        jobs = jobs.len(),
                        %error,
                        "search-index: cannot resolve workspace; dropping its jobs"
                    );
                    continue;
                }
            };
            for job in jobs {
                match index_entity(&db, &*self.embeddings, &job.entity_type, &job.entity_id).await {
                    Ok(result) => {
                        if result.embedded > 0 || result.removed > 0 {
                            tracing::info!(
                                entity_type = job.entity_type,
                                entity_id = job.entity_id,
                                embedded = result.embedded,
                                skipped = result.skipped,
                                removed = result.removed,
                                "search-index: indexed"
                            );
                        }
                    }
                    Err(error) => {
                        let reason =
                            format!("failed {}/{}: {error}", job.entity_type, job.entity_id);
                        for position in job.positions {
                            out[position] = Disposition::retry(reason.clone());
                        }
                    }
                }
            }
            tenants.insert(workspace, Ok(db));
        }
        out
    }
}

impl BatchHandler for SearchSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(self.handle_batch(batch))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(workspace: &str, entity_type: &str, id: &str) -> Option<HubEvent> {
        HubEvent::parse(
            format!(
                r#"{{"id":"evt","entityType":"{entity_type}","entityId":"{id}","action":"updated","metadata":{{"workspaceId":"{workspace}"}}}}"#
            )
            .as_bytes(),
        )
        .ok()
    }

    #[test]
    fn batches_coalesce_per_record() {
        let events = vec![
            event("org_a", "ticket", "t1"),
            event("org_a", "invoice", "i1"),
            event("org_a", "ticket", "t1"),
            event("org_b", "person", "p1"),
            event("org_a", "company", "c1"),
            None,
        ];
        let grouped = group_batch(&events);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].0, "org_a");
        assert_eq!(
            grouped[0].1,
            vec![
                PendingIndex {
                    entity_type: "ticket".to_owned(),
                    entity_id: "t1".to_owned(),
                    positions: vec![0, 2]
                },
                PendingIndex {
                    entity_type: "customer".to_owned(),
                    entity_id: "c1".to_owned(),
                    positions: vec![4]
                },
            ]
        );
        assert_eq!(grouped[1].1[0].entity_type, "contact");
    }

    #[test]
    fn vectors_print_for_pgvector() {
        assert_eq!(vector_text(&[1.0, 0.0, 0.5]), "[1,0,0.5]");
    }
}
