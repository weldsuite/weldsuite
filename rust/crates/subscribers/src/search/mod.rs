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
//! Embeddings come from the install's AI when it has an embedding model
//! ([`ai`]: `search-index`, charged once per workspace and batch), else from
//! an OpenAI-compatible endpoint the install configured (`EMBEDDINGS_URL`,
//! the `Embeddings` port, unmetered). With neither the subscriber does not run
//! (TypeScript retries every batch until the AI Gateway is configured).

pub mod ai;
pub mod backfill;
mod chunks;
mod documents;

use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::sea_query::{Expr, OnConflict, Query};
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_db::{PgPool, orm};
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition, Embeddings};
use weldsuite_schema::tenant::search_index;

pub use chunks::{MAX_CHUNKS_PER_ENTITY, chunk_text, compose, hash_content};
pub use documents::{
    INDEXED_ENTITY_TYPES, IndexableDocument, Loaded, load_document, resolve_indexed_type,
    result_url,
};

use crate::event::HubEvent;
use crate::js;
use crate::tenants::{TenantError, Tenants};

/// The width of `search_index.embedding` (`vector(1024)`: bge-m3 on Global,
/// `mistral-embed` on EU).
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
) -> Result<usize, DbErr> {
    use search_index::Column;
    let removed = search_index::Entity::delete_many()
        .filter(Column::EntityType.eq(entity_type))
        .filter(Column::EntityId.eq(entity_id))
        .exec(&orm(db))
        .await?;
    Ok(usize::try_from(removed.rows_affected).unwrap_or(usize::MAX))
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

    let existing: Vec<(i32, String, String)> = search_index::Entity::find()
        .select_only()
        .columns([
            search_index::Column::ChunkIndex,
            search_index::Column::ContentHash,
            search_index::Column::EmbedModel,
        ])
        .filter(search_index::Column::EntityType.eq(doc.entity_type.as_str()))
        .filter(search_index::Column::EntityId.eq(doc.entity_id.as_str()))
        .into_tuple()
        .all(&orm(db))
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
        search_index::Entity::delete_many()
            .filter(search_index::Column::EntityType.eq(doc.entity_type.as_str()))
            .filter(search_index::Column::EntityId.eq(doc.entity_id.as_str()))
            .filter(search_index::Column::ChunkIndex.is_in(surplus.iter().copied()))
            .exec(&orm(db))
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

    let rows: Vec<StaleChunk<'_>> = stale
        .iter()
        .zip(&vectors)
        .map(|((index, content, hash), vector)| StaleChunk {
            index: *index,
            content,
            hash,
            embedding: vector_text(vector),
        })
        .collect();
    upsert_chunks(db, doc, model, rows).await?;
    result.embedded = stale.len();
    Ok(result)
}

/// A chunk to (re)write, with its embedding as `pgvector` text.
struct StaleChunk<'a> {
    index: i32,
    content: &'a str,
    hash: &'a str,
    embedding: String,
}

/// The chunks' rows, in one statement for every chunk, as Drizzle's
/// multi-row insert: `on conflict (entity_type, entity_id, chunk_index) do
/// update`.
async fn upsert_chunks(
    db: &PgPool,
    doc: &IndexableDocument,
    model: &str,
    chunks: Vec<StaleChunk<'_>>,
) -> Result<(), DbErr> {
    use sea_orm::ExprTrait as _;
    use search_index::Column;
    let title = js::slice_to(&doc.title, 500);
    let subtitle = doc
        .subtitle
        .as_deref()
        .map(|subtitle| js::slice_to(subtitle, 500));
    let url = js::slice_to(&doc.url, 500);
    let mut insert = Query::insert();
    insert.into_table(search_index::Entity).columns([
        Column::Id,
        Column::EntityType,
        Column::EntityId,
        Column::ChunkIndex,
        Column::Content,
        Column::ContentHash,
        Column::Embedding,
        Column::EmbedModel,
        Column::Title,
        Column::Subtitle,
        Column::Url,
    ]);
    for chunk in chunks {
        insert
            .values([
                Expr::value(weldsuite_kit::generate_id("sidx")),
                Expr::value(doc.entity_type.clone()),
                Expr::value(doc.entity_id.clone()),
                Expr::value(chunk.index),
                Expr::value(chunk.content.to_owned()),
                Expr::value(chunk.hash.to_owned()),
                Expr::val(chunk.embedding).cast_as("vector"),
                Expr::value(model.to_owned()),
                Expr::value(title.clone()),
                Expr::value(subtitle.clone()),
                Expr::value(url.clone()),
            ])
            .map_err(|error| DbErr::Custom(error.to_string()))?;
    }
    insert.on_conflict(
        OnConflict::columns([Column::EntityType, Column::EntityId, Column::ChunkIndex])
            .update_columns([
                Column::Content,
                Column::ContentHash,
                Column::Embedding,
                Column::EmbedModel,
                Column::Title,
                Column::Subtitle,
                Column::Url,
            ])
            .value(Column::UpdatedAt, Expr::current_timestamp())
            .to_owned(),
    );
    orm(db).execute(&insert).await?;
    Ok(())
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

/// Where the vectors come from.
#[derive(Clone)]
enum Embedder {
    /// An endpoint the install configured (`EMBEDDINGS_URL`), or a test
    /// double: unmetered.
    Port(Arc<dyn Embeddings>),
    /// The install's AI, charged per workspace and batch on `master`.
    Ai {
        ai: weldsuite_ai::Ai,
        model: String,
        master: Option<PgPool>,
    },
}

/// The search-index subscriber.
#[derive(Clone)]
pub struct SearchSubscriber {
    tenants: Arc<dyn Tenants>,
    embedder: Embedder,
}

impl std::fmt::Debug for SearchSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchSubscriber")
            .field("model", &self.model())
            .finish_non_exhaustive()
    }
}

impl SearchSubscriber {
    /// Vectors from `embeddings`, unmetered.
    pub fn new(tenants: Arc<dyn Tenants>, embeddings: Arc<dyn Embeddings>) -> Self {
        Self {
            tenants,
            embedder: Embedder::Port(embeddings),
        }
    }

    /// Vectors from the install's AI (`search-index`), each workspace charged
    /// once per batch in `master`'s wallet (unmetered without it). `None`
    /// when the AI has no embedding model.
    pub fn with_ai(
        tenants: Arc<dyn Tenants>,
        ai: weldsuite_ai::Ai,
        master: Option<PgPool>,
    ) -> Option<Self> {
        let model = ai::index_model(&ai)?;
        Some(Self {
            tenants,
            embedder: Embedder::Ai { ai, model, master },
        })
    }

    /// The model stored with each vector.
    pub fn model(&self) -> &str {
        match &self.embedder {
            Embedder::Port(embeddings) => embeddings.model(),
            Embedder::Ai { model, .. } => model,
        }
    }

    /// One workspace's embeddings for this batch, and its meter.
    fn workspace_embeddings(
        &self,
        workspace: &str,
    ) -> (Arc<dyn Embeddings>, Option<Arc<ai::WorkspaceEmbeddings>>) {
        match &self.embedder {
            Embedder::Port(embeddings) => (Arc::clone(embeddings), None),
            Embedder::Ai { ai, model, .. } => {
                let metered = Arc::new(ai::WorkspaceEmbeddings::new(
                    ai.clone(),
                    model.clone(),
                    workspace,
                ));
                (Arc::clone(&metered) as Arc<dyn Embeddings>, Some(metered))
            }
        }
    }

    /// Charge what the workspace's records cost in this batch.
    async fn settle(&self, metered: Option<Arc<ai::WorkspaceEmbeddings>>) {
        if let (Some(metered), Embedder::Ai { master, .. }) = (metered, &self.embedder) {
            metered.settle(master.as_ref()).await;
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
            let (embeddings, metered) = self.workspace_embeddings(&workspace);
            for job in jobs {
                match index_entity(&db, &*embeddings, &job.entity_type, &job.entity_id).await {
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
            self.settle(metered).await;
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
