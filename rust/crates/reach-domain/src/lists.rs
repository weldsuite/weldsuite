//! `lists.ts` (prospect lists and their members) and `list-query.ts` (the
//! cursor pages every reach list shares).

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::{ReachError, ReachResult, field, iso, js_rows, now};

/// The raw query of a list (`PageQuery` and the filters the lists take).
#[derive(Debug, Clone, Default)]
pub struct PageQuery {
    pub cursor: Option<String>,
    pub limit: Option<String>,
    pub search: Option<String>,
    pub status: Option<String>,
    pub validation: Option<String>,
    pub list_id: Option<String>,
}

impl PageQuery {
    /// `c.req.query()`: the first value of each key.
    pub fn from_query(raw: Option<&str>) -> Self {
        let mut out = Self::default();
        for (key, value) in form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
            let slot = match key.as_ref() {
                "cursor" => &mut out.cursor,
                "limit" => &mut out.limit,
                "search" => &mut out.search,
                "status" => &mut out.status,
                "validation" => &mut out.validation,
                "listId" => &mut out.list_id,
                _ => continue,
            };
            if slot.is_none() {
                *slot = Some(value.into_owned());
            }
        }
        out
    }
}

/// One page (`Page<T>`).
#[derive(Debug, Clone)]
pub struct Page {
    pub data: Vec<Value>,
    pub total_count: i64,
    pub has_more: bool,
    pub cursor: Option<String>,
}

/// `parseLimit(raw, 25, 100)`: `Number.parseInt` of the raw text.
pub fn parse_limit(raw: Option<&str>) -> i64 {
    let fallback = 25;
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return fallback;
    };
    let trimmed = crate::text::js_trim(raw);
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    let Ok(n) = digits.parse::<i64>() else {
        return fallback;
    };
    let n = sign * n;
    if n < 1 { fallback } else { n.min(100) }
}

/// `likePattern(term)`.
pub fn like_pattern(term: &str) -> String {
    let mut out = String::from("%");
    for c in crate::text::js_trim(term).chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// The `(createdAt, id)` a cursor continues after (`cursorCondition`), the
/// time cut to the millisecond as Drizzle reads it back; `None`
/// for the first page or an unknown cursor.
pub async fn cursor_row(db: &PgPool, table: &str, cursor: Option<&str>) -> ReachResult<Option<(String, String)>> {
    let Some(cursor) = cursor.filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    let sql = match table {
        "reach_campaigns" => "select date_trunc('milliseconds', created_at)::text, id from reach_campaigns where id = $1 limit 1",
        "reach_prospects" => "select date_trunc('milliseconds', created_at)::text, id from reach_prospects where id = $1 limit 1",
        "reach_prospect_lists" => "select date_trunc('milliseconds', created_at)::text, id from reach_prospect_lists where id = $1 limit 1",
        "reach_suppressions" => "select date_trunc('milliseconds', created_at)::text, id from reach_suppressions where id = $1 limit 1",
        "reach_enrollments" => "select date_trunc('milliseconds', created_at)::text, id from reach_enrollments where id = $1 limit 1",
        _ => return Ok(None),
    };
    Ok(sqlx::query_as(sql).bind(cursor).fetch_optional(db).await?)
}

/// `pageResult(rows, limit, total, toDto)` over rows fetched with `limit + 1`.
pub fn page_result(rows: &[Value], limit: i64, total: i64, to_dto: impl Fn(&Value) -> Value) -> Page {
    let limit = usize::try_from(limit).unwrap_or_default();
    let has_more = rows.len() > limit;
    let data: Vec<Value> = rows.iter().take(limit).collect::<Vec<_>>().into_iter().map(&to_dto).collect();
    let cursor = if has_more {
        rows.get(limit.saturating_sub(1)).and_then(|r| r.get("id")).and_then(Value::as_str).map(str::to_owned)
    } else {
        None
    };
    Page {
        data,
        total_count: total,
        has_more,
        cursor,
    }
}

/// `toProspectList(row)`.
pub fn to_list(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "name": field(row, "name"),
        "description": field(row, "description"),
        "source": field(row, "source"),
        "sourceRef": field(row, "sourceRef"),
        "prospectCount": field(row, "prospectCount"),
        "createdAt": field(row, "createdAt"),
    })
}

/// `findList(db, id)`.
pub async fn find_list(db: &PgPool, id: &str) -> ReachResult<Option<Value>> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from reach_prospect_lists t where t.id = $1 and t.deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `createList(db, input)`.
pub async fn create_list(
    db: &PgPool,
    name: &str,
    description: Option<&str>,
    source: &str,
    source_ref: Option<&str>,
    created_by: Option<&str>,
) -> ReachResult<Value> {
    let row: Value = sqlx::query_scalar(
        "insert into reach_prospect_lists (id, name, description, source, source_ref, created_by)
         values ($1, $2, $3, $4, $5, $6) returning to_jsonb(reach_prospect_lists)",
    )
    .bind(generate_id("rpl"))
    .bind(name)
    .bind(description)
    .bind(source)
    .bind(source_ref)
    .bind(created_by)
    .fetch_one(db)
    .await?;
    Ok(weldsuite_db::js_row(row))
}

/// `recountList(db, listId)`.
pub async fn recount_list(db: &PgPool, list_id: &str) -> ReachResult<i64> {
    let n: i64 = sqlx::query_scalar(
        "select count(*) from reach_prospect_list_members m
         join reach_prospects p on p.id = m.prospect_id
         where m.list_id = $1 and p.deleted_at is null",
    )
    .bind(list_id)
    .fetch_one(db)
    .await?;
    sqlx::query("update reach_prospect_lists set prospect_count = $2, updated_at = $3::timestamptz where id = $1")
        .bind(list_id)
        .bind(i32::try_from(n).unwrap_or(i32::MAX))
        .bind(iso(now()))
        .execute(db)
        .await?;
    Ok(n)
}

/// `addProspectsToList(db, listId, prospectIds)`: how many joined.
pub async fn add_to_list(db: &PgPool, list_id: &str, prospect_ids: &[String]) -> ReachResult<i64> {
    let unique = crate::unique(prospect_ids);
    let mut added = 0i64;
    for chunk in unique.chunks(500) {
        let live: Vec<String> =
            sqlx::query_scalar("select id from reach_prospects where id = any($1) and deleted_at is null")
                .bind(chunk)
                .fetch_all(db)
                .await?;
        if live.is_empty() {
            continue;
        }
        let ids: Vec<String> = live.iter().map(|_| generate_id("rplm")).collect();
        let inserted: Vec<String> = sqlx::query_scalar(
            "insert into reach_prospect_list_members (id, list_id, prospect_id)
             select id, $2, prospect_id from unnest($1::varchar[], $3::varchar[]) as v(id, prospect_id)
             on conflict do nothing returning id",
        )
        .bind(&ids)
        .bind(list_id)
        .bind(&live)
        .fetch_all(db)
        .await?;
        added += i64::try_from(inserted.len()).unwrap_or_default();
    }
    recount_list(db, list_id).await?;
    Ok(added)
}

/// `removeProspectsFromList(db, listId, prospectIds)`: how many left.
pub async fn remove_from_list(db: &PgPool, list_id: &str, prospect_ids: &[String]) -> ReachResult<i64> {
    let unique = crate::unique(prospect_ids);
    let mut removed = 0i64;
    for chunk in unique.chunks(500) {
        let gone: Vec<String> = sqlx::query_scalar(
            "delete from reach_prospect_list_members where list_id = $1 and prospect_id = any($2) returning id",
        )
        .bind(list_id)
        .bind(chunk)
        .fetch_all(db)
        .await?;
        removed += i64::try_from(gone.len()).unwrap_or_default();
    }
    recount_list(db, list_id).await?;
    Ok(removed)
}

/// `listProspectLists(db, q)`.
pub async fn list_lists(db: &PgPool, query: &PageQuery) -> ReachResult<Page> {
    let limit = parse_limit(query.limit.as_deref());
    let cursor = cursor_row(db, "reach_prospect_lists", query.cursor.as_deref()).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_prospect_lists t
         where t.deleted_at is null
           and ($1::timestamptz is null or t.created_at < $1::timestamptz or (t.created_at = $1::timestamptz and t.id < $2))
         order by t.created_at desc, t.id desc limit $3",
    )
    .bind(cursor.as_ref().map(|c| c.0.clone()))
    .bind(cursor.as_ref().map(|c| c.1.clone()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar("select count(*) from reach_prospect_lists where deleted_at is null")
        .fetch_one(db)
        .await?;
    Ok(page_result(&js_rows(rows), limit, total, to_list))
}

/// `getProspectList(db, id)`.
pub async fn get_list(db: &PgPool, id: &str) -> ReachResult<Value> {
    match find_list(db, id).await? {
        Some(row) => Ok(to_list(&row)),
        None => Err(ReachError::not_found("List", Some(id))),
    }
}

/// `updateProspectList(db, id, input)`: `None` leaves a field as it is.
pub async fn update_list(
    db: &PgPool,
    id: &str,
    name: Option<&str>,
    description: Option<Option<&str>>,
) -> ReachResult<Value> {
    let row: Option<Value> = sqlx::query_scalar(
        "update reach_prospect_lists set
             name = case when $2 then $3 else name end,
             description = case when $4 then $5 else description end,
             updated_at = $6::timestamptz
         where id = $1 and deleted_at is null
         returning to_jsonb(reach_prospect_lists)",
    )
    .bind(id)
    .bind(name.is_some())
    .bind(name)
    .bind(description.is_some())
    .bind(description.flatten())
    .bind(iso(now()))
    .fetch_optional(db)
    .await?;
    match row {
        Some(row) => Ok(to_list(&weldsuite_db::js_row(row))),
        None => Err(ReachError::not_found("List", Some(id))),
    }
}

/// `deleteProspectList(db, id)`: soft-delete, memberships dropped.
pub async fn delete_list(db: &PgPool, id: &str) -> ReachResult<()> {
    let at = iso(now());
    let row: Option<String> = sqlx::query_scalar(
        "update reach_prospect_lists set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
         where id = $1 and deleted_at is null returning id",
    )
    .bind(id)
    .bind(&at)
    .fetch_optional(db)
    .await?;
    if row.is_none() {
        return Err(ReachError::not_found("List", Some(id)));
    }
    sqlx::query("delete from reach_prospect_list_members where list_id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// `addProspectListMembers(db, id, prospectIds)`.
pub async fn add_members(db: &PgPool, id: &str, prospect_ids: &[String]) -> ReachResult<Value> {
    if find_list(db, id).await?.is_none() {
        return Err(ReachError::not_found("List", Some(id)));
    }
    Ok(json!({ "added": add_to_list(db, id, prospect_ids).await? }))
}

/// `removeProspectListMembers(db, id, prospectIds)`.
pub async fn remove_members(db: &PgPool, id: &str, prospect_ids: &[String]) -> ReachResult<Value> {
    if find_list(db, id).await?.is_none() {
        return Err(ReachError::not_found("List", Some(id)));
    }
    Ok(json!({ "removed": remove_from_list(db, id, prospect_ids).await? }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_parse_like_parse_int() {
        assert_eq!(parse_limit(None), 25);
        assert_eq!(parse_limit(Some("10")), 10);
        assert_eq!(parse_limit(Some("500")), 100);
        assert_eq!(parse_limit(Some("0")), 25);
        assert_eq!(parse_limit(Some("12abc")), 12);
        assert_eq!(parse_limit(Some("abc")), 25);
        assert_eq!(like_pattern(" a%b_ "), "%a\\%b\\_%");
    }
}
