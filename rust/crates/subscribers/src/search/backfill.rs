//! `backfillBatch` (`services/search/indexer.ts`): one bounded page of the
//! semantic backfill behind `POST /api/search/reindex`. The caller loops,
//! handing back the cursor, until `done`; the cursor is the whole state, so a
//! failed walk resumes where it stopped.
//!
//! The walk goes through the static types in registry order
//! ([`INDEXED_ENTITY_TYPES`]), then the tenant's searchable custom objects.
//! Each page reads up to [`BACKFILL_PAGE_SIZE`] visible rows of one type by
//! id, and indexes those that make a document with the indexer's own code
//! ([`index_document`]): unchanged chunks are skipped, so walking an indexed
//! corpus again costs nothing. One failing record is logged and passed, never
//! the end of the walk.

use weldsuite_db::PgPool;
use weldsuite_ports::Embeddings;

use super::documents::{INDEXED_ENTITY_TYPES, Loaded, load_document};
use super::{BoxError, index_document};

/// Records read per page (`BACKFILL_PAGE_SIZE`): each may cost an embed call.
pub const BACKFILL_PAGE_SIZE: usize = 25;

/// `BackfillCursor`: where the next page starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackfillCursor {
    pub entity_type: String,
    pub after_id: Option<String>,
}

impl BackfillCursor {
    /// `initialBackfillCursor()`: the first indexed type, from the start.
    pub fn initial() -> Self {
        Self {
            entity_type: INDEXED_ENTITY_TYPES[0].to_owned(),
            after_id: None,
        }
    }

    /// `{ entityType, afterId }`.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "entityType": self.entity_type, "afterId": self.after_id })
    }
}

/// `BackfillProgress` (`ReindexProgress`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BackfillProgress {
    /// The next page's cursor; `None` when the walk is over.
    pub cursor: Option<BackfillCursor>,
    pub done: bool,
    /// Rows read (scanned, mapped to a document or not).
    pub processed: usize,
    pub embedded: usize,
    pub skipped: usize,
}

impl BackfillProgress {
    /// `{ cursor, done, processed, embedded, skipped }`.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "cursor": self.cursor.as_ref().map(BackfillCursor::to_json),
            "done": self.done,
            "processed": self.processed,
            "embedded": self.embedded,
            "skipped": self.skipped,
        })
    }
}

/// The visible rows of a static type, by id (each loader's `after` query,
/// ids only: the documents are loaded one by one with `load_document`).
fn static_page_sql(entity_type: &str) -> Option<&'static str> {
    Some(match entity_type {
        "knowledge_page" => {
            "select p.id from knowledge_pages p \
             inner join knowledge_spaces s on p.space_id = s.id \
             where p.deleted_at is null and s.deleted_at is null and s.kind = 'team' \
             and s.visibility = 'open' and ($1::text is null or p.id > $1) \
             order by p.id limit $2"
        }
        "article" => {
            "select id from helpdesk_articles where deleted_at is null \
             and ($1::text is null or id > $1) order by id limit $2"
        }
        "ticket" => {
            "select id from helpdesk_tickets where deleted_at is null \
             and ($1::text is null or id > $1) order by id limit $2"
        }
        "project" => {
            "select id from projects where deleted_at is null \
             and ($1::text is null or id > $1) order by id limit $2"
        }
        "task" => {
            "select id from tasks where deleted_at is null \
             and ($1::text is null or id > $1) order by id limit $2"
        }
        "contact" => {
            "select id from people where deleted_at is null \
             and ($1::text is null or id > $1) order by id limit $2"
        }
        "customer" => {
            "select id from companies where deleted_at is null \
             and ($1::text is null or id > $1) order by id limit $2"
        }
        "lead" => {
            "select id from crm_leads where deleted_at is null \
             and ($1::text is null or id > $1) order by id limit $2"
        }
        "opportunity" => {
            "select id from crm_opportunities where deleted_at is null \
             and ($1::text is null or id > $1) order by id limit $2"
        }
        "merge_issue" => {
            "select i.id from merge_issues i inner join merge_teams t on t.id = i.team_id \
             where i.deleted_at is null and t.deleted_at is null \
             and ($1::text is null or i.id > $1) order by i.id limit $2"
        }
        _ => return None,
    })
}

/// `listSearchableCustomObjectKeys`: every object opted into search; none
/// for a tenant without the WeldObjects tables.
async fn searchable_custom_object_keys(db: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    match sqlx::query_scalar(
        "select entity_key from custom_objects \
         where enable_search = true and status = 'active' and deleted_at is null",
    )
    .fetch_all(db)
    .await
    {
        Ok(keys) => Ok(keys),
        Err(error) if weldsuite_db::is_missing_table(&error) => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// Whether a `co_<slug>` key is an object with search on
/// (`getCustomObjectLoader` is not null).
async fn searchable_custom_object(db: &PgPool, entity_key: &str) -> Result<bool, sqlx::Error> {
    match sqlx::query_scalar::<_, bool>(
        "select enable_search from custom_objects \
         where entity_key = $1 and deleted_at is null limit 1",
    )
    .bind(entity_key)
    .fetch_optional(db)
    .await
    {
        Ok(enabled) => Ok(enabled == Some(true)),
        Err(error) if weldsuite_db::is_missing_table(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

/// One page of ids of `entity_type` after `after_id`; `None` when the type
/// has no loader.
async fn page_ids(
    db: &PgPool,
    entity_type: &str,
    after_id: Option<&str>,
) -> Result<Option<Vec<String>>, sqlx::Error> {
    let limit = i64::try_from(BACKFILL_PAGE_SIZE).unwrap_or(i64::MAX);
    if weldsuite_events::is_custom_object_entity_key(entity_type) {
        if !searchable_custom_object(db, entity_type).await? {
            return Ok(None);
        }
        let ids = sqlx::query_scalar(
            "select id from custom_object_records \
             where entity_key = $1 and deleted_at is null and ($2::text is null or id > $2) \
             order by id limit $3",
        )
        .bind(entity_type)
        .bind(after_id)
        .bind(limit)
        .fetch_all(db)
        .await?;
        return Ok(Some(ids));
    }
    let Some(sql) = static_page_sql(entity_type) else {
        return Ok(None);
    };
    let ids = sqlx::query_scalar(sql)
        .bind(after_id)
        .bind(limit)
        .fetch_all(db)
        .await?;
    Ok(Some(ids))
}

/// `nextEntityType`: the cursor for the type after `current`, or `None`
/// when the walk is over. After the static types come the searchable custom
/// objects; a type in neither list (an object deleted or switched off
/// mid-walk) restarts at the head of the custom list, which no longer holds
/// it, so the walk can't loop.
async fn next_entity_type(
    db: &PgPool,
    current: &str,
) -> Result<Option<BackfillCursor>, sqlx::Error> {
    let start = |entity_type: &str| BackfillCursor {
        entity_type: entity_type.to_owned(),
        after_id: None,
    };
    if let Some(at) = INDEXED_ENTITY_TYPES.iter().position(|t| *t == current) {
        if let Some(next) = INDEXED_ENTITY_TYPES.get(at + 1) {
            return Ok(Some(start(next)));
        }
        let custom = searchable_custom_object_keys(db).await?;
        return Ok(custom.first().map(|key| start(key)));
    }
    let custom = searchable_custom_object_keys(db).await?;
    let next = match custom.iter().position(|key| key == current) {
        Some(at) => custom.get(at + 1),
        None => custom.first(),
    };
    Ok(next.map(|key| start(key)))
}

/// `backfillBatch(db, embedder, cursor)`: index one page, and the cursor
/// for the next.
pub async fn backfill_batch(
    db: &PgPool,
    embeddings: &dyn Embeddings,
    cursor: &BackfillCursor,
) -> Result<BackfillProgress, BoxError> {
    let finished = |next: Option<BackfillCursor>| BackfillProgress {
        done: next.is_none(),
        cursor: next,
        ..BackfillProgress::default()
    };
    let Some(ids) = page_ids(db, &cursor.entity_type, cursor.after_id.as_deref()).await? else {
        return Ok(finished(next_entity_type(db, &cursor.entity_type).await?));
    };
    if ids.is_empty() {
        return Ok(finished(next_entity_type(db, &cursor.entity_type).await?));
    }

    let mut embedded = 0;
    let mut skipped = 0;
    for id in &ids {
        // One failing record must not end the page: the cursor would stall
        // on it for good.
        let indexed = match load_document(db, &cursor.entity_type, id).await {
            Ok(Loaded::Document(doc)) => index_document(db, embeddings, &doc).await,
            Ok(Loaded::Missing | Loaded::NoLoader) => continue,
            Err(error) => Err(error.into()),
        };
        match indexed {
            Ok(result) => {
                embedded += result.embedded;
                skipped += result.skipped;
            }
            Err(error) => tracing::error!(
                entity_type = cursor.entity_type,
                entity_id = id,
                %error,
                "[search-indexer] failed to index"
            ),
        }
    }

    // From the rows read, never the documents: a row that maps to no
    // document still moves the cursor on.
    let next = if ids.len() < BACKFILL_PAGE_SIZE {
        next_entity_type(db, &cursor.entity_type).await?
    } else {
        Some(BackfillCursor {
            entity_type: cursor.entity_type.clone(),
            after_id: ids.last().cloned(),
        })
    };
    Ok(BackfillProgress {
        done: next.is_none(),
        cursor: next,
        processed: ids.len(),
        embedded,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_static_type_pages() {
        for entity_type in INDEXED_ENTITY_TYPES {
            assert!(static_page_sql(entity_type).is_some(), "{entity_type}");
        }
        assert!(static_page_sql("product").is_none());
    }

    #[test]
    fn progress_reads_as_typescript_answers_it() {
        let progress = BackfillProgress {
            cursor: Some(BackfillCursor {
                entity_type: "article".to_owned(),
                after_id: None,
            }),
            done: false,
            processed: 1,
            embedded: 1,
            skipped: 0,
        };
        assert_eq!(
            progress.to_json(),
            serde_json::json!({
                "cursor": { "entityType": "article", "afterId": null },
                "done": false, "processed": 1, "embedded": 1, "skipped": 0,
            })
        );
        assert_eq!(BackfillCursor::initial().entity_type, "knowledge_page");
    }
}
