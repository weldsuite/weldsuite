//! The hand-rolled cursor lists of DNS zones, domain transfers and email
//! forwards: newest first (`createdAt`, then `id`), `limit + 1` rows, and a
//! count whose conditions are `conditions.slice(0, -1)` when a `?cursor=`
//! was given (the cursor's own condition, or, when the cursor row is gone,
//! the last filter), as the services count.

use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::Value;
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_timestamp};

use crate::rows::js;

/// One page: rows, total, whether there is more, and the next cursor.
pub(crate) struct Page {
    pub(crate) rows: Vec<Value>,
    pub(crate) total: u64,
    pub(crate) has_more: bool,
    pub(crate) cursor: Option<String>,
}

/// One list of `E`, paged by its `created_at` and `id` columns.
/// `conditions` are the service's, in its order (the live-only condition
/// first where the table has one), `None` where a filter wasn't given.
pub(crate) async fn list<E>(
    db: &PgPool,
    (created_at, id): (E::Column, E::Column),
    conditions: Vec<Option<Condition>>,
    cursor: Option<&str>,
    limit: i64,
) -> Result<Page, DbErr>
where
    E: EntityTrait,
    E::Model: serde::Serialize + Sync,
{
    let db = orm(db);
    let at = match cursor {
        Some(cursor) => {
            let row: Option<(PrimitiveDateTime, String)> = E::find()
                .select_only()
                .column(created_at)
                .column(id)
                .filter(id.eq(cursor))
                .into_tuple()
                .one(&db)
                .await?;
            // The cursor row's `createdAt` as Drizzle read it: milliseconds.
            row.map(|(created, id)| (utc_timestamp(created.assume_utc()), id))
        }
        None => None,
    };
    let mut present: Vec<Condition> = conditions.into_iter().flatten().collect();
    if let Some((created, cursor_id)) = &at {
        present.push(
            Condition::any().add(created_at.lt(*created)).add(
                Condition::all()
                    .add(created_at.eq(*created))
                    .add(id.lt(cursor_id.as_str())),
            ),
        );
    }
    let mut counted = present.clone();
    if cursor.is_some() {
        counted.pop();
    }
    let all = |conditions: Vec<Condition>| {
        conditions
            .into_iter()
            .fold(Condition::all(), |all, condition| all.add(condition))
    };
    let page = E::find()
        .filter(all(present))
        .order_by_desc(created_at)
        .order_by_desc(id)
        .limit(u64::try_from(limit.saturating_add(1)).unwrap_or(0))
        .all(&db)
        .await?;
    let total = E::find().filter(all(counted)).count(&db).await?;
    let mut rows: Vec<Value> = page.into_iter().map(js).collect::<Result<_, _>>()?;
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    rows.truncate(usize::try_from(limit).unwrap_or(0));
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row.get("id").and_then(Value::as_str))
            .map(str::to_owned)
    } else {
        None
    };
    Ok(Page {
        rows,
        total,
        has_more,
        cursor,
    })
}
