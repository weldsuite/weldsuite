//! The hand-rolled cursor lists of DNS zones, domain transfers and email
//! forwards: newest first (`createdAt`, then `id`), `limit + 1` rows, and a
//! count whose conditions are `conditions.slice(0, -1)` when a `?cursor=`
//! was given (the cursor's own condition, or, when the cursor row is gone,
//! the last filter), as the services count.

use serde_json::Value;
use weldsuite_db::{PgPool, js_row, js_timestamp};

/// One list's statements. Parameters: `$1` skips the live-only condition,
/// each filter `(skip, value)`, the cursor `(skip, createdAt, id)`; the page
/// takes the limit last.
pub(crate) struct ListSql {
    /// `select to_jsonb(t.created_at)#>>'{}', t.id … where t.id = $1`.
    pub(crate) cursor: &'static str,
    pub(crate) page: &'static str,
    pub(crate) count: &'static str,
    /// Whether the first condition is `deleted_at is null`.
    pub(crate) live: bool,
}

/// One page: rows, total, whether there is more, and the next cursor.
pub(crate) struct Page {
    pub(crate) rows: Vec<Value>,
    pub(crate) total: i64,
    pub(crate) has_more: bool,
    pub(crate) cursor: Option<String>,
}

pub(crate) async fn list(
    db: &PgPool,
    sql: &ListSql,
    filters: &[Option<String>],
    cursor: Option<&str>,
    limit: i64,
) -> Result<Page, sqlx::Error> {
    let at = match cursor {
        Some(cursor) => {
            let row: Option<(Option<String>, String)> = sqlx::query_as(sql.cursor)
                .bind(cursor)
                .fetch_optional(db)
                .await?;
            row.and_then(|(created, id)| {
                created
                    .and_then(|stamp| js_timestamp(&stamp))
                    .map(|stamp| (stamp, id))
            })
        }
        None => None,
    };
    // Which conditions are present: live, each filter, the cursor.
    let mut present = vec![sql.live];
    present.extend(filters.iter().map(Option::is_some));
    present.push(at.is_some());
    let mut counted = present.clone();
    if cursor.is_some()
        && let Some(last) = counted.iter().rposition(|p| *p)
    {
        counted[last] = false;
    }
    let (created, id) = at.unwrap_or_default();
    let page = {
        let mut query = sqlx::query_scalar::<_, Value>(sql.page).bind(!present[0]);
        for (index, filter) in filters.iter().enumerate() {
            query = query.bind(!present[index + 1]).bind(filter.clone());
        }
        query
            .bind(!present[filters.len() + 1])
            .bind(created.clone())
            .bind(id.clone())
            .bind(limit + 1)
            .fetch_all(db)
            .await?
    };
    let total = {
        let mut query = sqlx::query_scalar::<_, i32>(sql.count).bind(!counted[0]);
        for (index, filter) in filters.iter().enumerate() {
            query = query.bind(!counted[index + 1]).bind(filter.clone());
        }
        query
            .bind(!counted[filters.len() + 1])
            .bind(created)
            .bind(id)
            .fetch_one(db)
            .await?
    };
    let mut rows: Vec<Value> = page.into_iter().map(js_row).collect();
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
        total: i64::from(total),
        has_more,
        cursor,
    })
}

/// `?cursor` keyset condition at `$a` (skip), `$b` (createdAt), `$c` (id).
macro_rules! keyset {
    ($a:literal, $b:literal, $c:literal) => {
        concat!(
            "($",
            $a,
            "::boolean or (t.created_at < $",
            $b,
            "::timestamp or (t.created_at = $",
            $b,
            "::timestamp and t.id < $",
            $c,
            "::text)))"
        )
    };
}
pub(crate) use keyset;
