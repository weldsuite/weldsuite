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

use sea_orm::sea_query::SelectStatement;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, JoinType, QueryFilter,
    QueryOrder, QuerySelect, QueryTrait, Select,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_ports::Embeddings;
use weldsuite_schema::tenant::{
    companies, crm_leads, crm_opportunities, custom_object_records, custom_objects,
    helpdesk_articles, helpdesk_tickets, knowledge_pages, knowledge_spaces, merge_issues,
    merge_teams, people, projects, tasks,
};

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

/// Records read per page, as the `limit` of a page query.
fn page_limit() -> u64 {
    u64::try_from(BACKFILL_PAGE_SIZE).unwrap_or(u64::MAX)
}

/// `select id from … where deleted_at is null and ($1 is null or id > $1)
/// order by id limit $2`.
fn live_ids<E: EntityTrait>(
    id: E::Column,
    deleted_at: E::Column,
    after_id: Option<&str>,
) -> Select<E> {
    let select = E::find()
        .select_only()
        .column(id)
        .filter(deleted_at.is_null());
    let select = match after_id {
        Some(after) => select.filter(id.gt(after)),
        None => select,
    };
    select.order_by_asc(id).limit(page_limit())
}

/// The visible rows of a static type, by id (each loader's `after` query,
/// ids only: the documents are loaded one by one with `load_document`).
fn static_page(entity_type: &str, after_id: Option<&str>) -> Option<SelectStatement> {
    Some(match entity_type {
        "knowledge_page" => {
            use knowledge_pages::Column as P;
            use knowledge_spaces::Column as S;
            live_ids::<knowledge_pages::Entity>(P::Id, P::DeletedAt, after_id)
                .join(
                    JoinType::InnerJoin,
                    knowledge_pages::Entity::belongs_to(knowledge_spaces::Entity)
                        .from(P::SpaceId)
                        .to(S::Id)
                        .into(),
                )
                .filter(S::DeletedAt.is_null())
                .filter(S::Kind.eq("team"))
                .filter(S::Visibility.eq("open"))
                .into_query()
        }
        "article" => {
            use helpdesk_articles::Column;
            live_ids::<helpdesk_articles::Entity>(Column::Id, Column::DeletedAt, after_id)
                .into_query()
        }
        "ticket" => {
            use helpdesk_tickets::Column;
            live_ids::<helpdesk_tickets::Entity>(Column::Id, Column::DeletedAt, after_id)
                .into_query()
        }
        "project" => {
            use projects::Column;
            live_ids::<projects::Entity>(Column::Id, Column::DeletedAt, after_id).into_query()
        }
        "task" => {
            use tasks::Column;
            live_ids::<tasks::Entity>(Column::Id, Column::DeletedAt, after_id).into_query()
        }
        "contact" => {
            use people::Column;
            live_ids::<people::Entity>(Column::Id, Column::DeletedAt, after_id).into_query()
        }
        "customer" => {
            use companies::Column;
            live_ids::<companies::Entity>(Column::Id, Column::DeletedAt, after_id).into_query()
        }
        "lead" => {
            use crm_leads::Column;
            live_ids::<crm_leads::Entity>(Column::Id, Column::DeletedAt, after_id).into_query()
        }
        "opportunity" => {
            use crm_opportunities::Column;
            live_ids::<crm_opportunities::Entity>(Column::Id, Column::DeletedAt, after_id)
                .into_query()
        }
        "merge_issue" => {
            use merge_issues::Column as I;
            use merge_teams::Column as T;
            live_ids::<merge_issues::Entity>(I::Id, I::DeletedAt, after_id)
                .join(
                    JoinType::InnerJoin,
                    merge_issues::Entity::belongs_to(merge_teams::Entity)
                        .from(I::TeamId)
                        .to(T::Id)
                        .into(),
                )
                .filter(T::DeletedAt.is_null())
                .into_query()
        }
        _ => return None,
    })
}

/// `listSearchableCustomObjectKeys`: every object opted into search; none
/// for a tenant without the WeldObjects tables.
async fn searchable_custom_object_keys(db: &DatabaseConnection) -> Result<Vec<String>, DbErr> {
    use custom_objects::Column;
    match custom_objects::Entity::find()
        .select_only()
        .column(Column::EntityKey)
        .filter(Column::EnableSearch.eq(true))
        .filter(Column::Status.eq("active"))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(db)
        .await
    {
        Ok(keys) => Ok(keys),
        Err(error) if weldsuite_db::is_missing_table(&error) => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// Whether a `co_<slug>` key is an object with search on
/// (`getCustomObjectLoader` is not null).
async fn searchable_custom_object(
    db: &DatabaseConnection,
    entity_key: &str,
) -> Result<bool, DbErr> {
    use custom_objects::Column;
    match custom_objects::Entity::find()
        .select_only()
        .column(Column::EnableSearch)
        .filter(Column::EntityKey.eq(entity_key))
        .filter(Column::DeletedAt.is_null())
        .into_tuple::<bool>()
        .one(db)
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
    db: &DatabaseConnection,
    entity_type: &str,
    after_id: Option<&str>,
) -> Result<Option<Vec<String>>, DbErr> {
    if weldsuite_events::is_custom_object_entity_key(entity_type) {
        use custom_object_records::Column;
        if !searchable_custom_object(db, entity_type).await? {
            return Ok(None);
        }
        let ids = live_ids::<custom_object_records::Entity>(Column::Id, Column::DeletedAt, after_id)
            .filter(Column::EntityKey.eq(entity_type))
            .into_tuple()
            .all(db)
            .await?;
        return Ok(Some(ids));
    }
    let Some(page) = static_page(entity_type, after_id) else {
        return Ok(None);
    };
    let ids = db
        .query_all(&page)
        .await?
        .iter()
        .map(|row| row.try_get_by_index::<String>(0))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(ids))
}

/// `nextEntityType`: the cursor for the type after `current`, or `None`
/// when the walk is over. After the static types come the searchable custom
/// objects; a type in neither list (an object deleted or switched off
/// mid-walk) restarts at the head of the custom list, which no longer holds
/// it, so the walk can't loop.
async fn next_entity_type(
    db: &DatabaseConnection,
    current: &str,
) -> Result<Option<BackfillCursor>, DbErr> {
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
    let conn = orm(db);
    let Some(ids) = page_ids(&conn, &cursor.entity_type, cursor.after_id.as_deref()).await? else {
        return Ok(finished(next_entity_type(&conn, &cursor.entity_type).await?));
    };
    if ids.is_empty() {
        return Ok(finished(next_entity_type(&conn, &cursor.entity_type).await?));
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
        next_entity_type(&conn, &cursor.entity_type).await?
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
            assert!(static_page(entity_type, None).is_some(), "{entity_type}");
        }
        assert!(static_page("product", Some("prd_1")).is_none());
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
