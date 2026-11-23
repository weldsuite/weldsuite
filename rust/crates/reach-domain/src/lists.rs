//! `lists.ts` (prospect lists and their members) and `list-query.ts` (the
//! cursor pages every reach list shares).

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, JoinType, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, RelationDef, Set,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    reach_prospect_list_members as members, reach_prospect_lists as lists, reach_prospects,
};

use crate::{ReachError, ReachResult, field, js, js_all, now, stamp};

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

/// The `(createdAt, id)` a cursor continues after (`cursorCondition`).
pub type CursorRow = (OffsetDateTime, String);

/// The cursor row of a table (`created_at`, `id`), the time cut to the
/// millisecond as Drizzle reads it back; `None` for the first page or an
/// unknown cursor.
pub async fn cursor_row<E: EntityTrait>(
    db: &PgPool,
    created_at: E::Column,
    id: E::Column,
    cursor: Option<&str>,
) -> ReachResult<Option<CursorRow>> {
    let Some(cursor) = cursor.filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    let row: Option<CursorRow> = E::find()
        .select_only()
        .column(created_at)
        .column(id)
        .filter(id.eq(cursor))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(|(at, id)| (stamp(at), id)))
}

/// `created_at < cursor or (created_at = cursor and id < cursorId)`: past
/// the cursor, newest first.
pub fn before<C: ColumnTrait>(created_at: C, id: C, (at, cursor_id): &CursorRow) -> Condition {
    Condition::any().add(created_at.lt(*at)).add(
        Condition::all()
            .add(created_at.eq(*at))
            .add(id.lt(cursor_id.as_str())),
    )
}

/// `.limit(limit + 1)`: one row past the page tells whether there is more.
pub fn probe(limit: i64) -> u64 {
    u64::try_from(limit + 1).unwrap_or_default()
}

/// `pageResult(rows, limit, total, toDto)` over rows fetched with `limit + 1`.
pub fn page_result(
    rows: &[Value],
    limit: i64,
    total: i64,
    to_dto: impl Fn(&Value) -> Value,
) -> Page {
    let limit = usize::try_from(limit).unwrap_or_default();
    let has_more = rows.len() > limit;
    let data: Vec<Value> = rows
        .iter()
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .map(&to_dto)
        .collect();
    let cursor = if has_more {
        rows.get(limit.saturating_sub(1))
            .and_then(|r| r.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
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
    let row = lists::Entity::find_by_id(id)
        .filter(lists::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(serde_json::to_value).map(js).transpose()?)
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
    let row = lists::Entity::insert(lists::ActiveModel {
        id: Set(generate_id("rpl")),
        name: Set(name.to_owned()),
        description: Set(description.map(str::to_owned)),
        source: Set(source.to_owned()),
        source_ref: Set(source_ref.map(str::to_owned)),
        created_by: Set(created_by.map(str::to_owned)),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(js(serde_json::to_value(row))?)
}

/// `innerJoin(reachProspects, eq(members.prospectId, reachProspects.id))`.
pub(crate) fn member_prospect() -> RelationDef {
    members::Entity::belongs_to(reach_prospects::Entity)
        .from(members::Column::ProspectId)
        .to(reach_prospects::Column::Id)
        .into()
}

/// `recountList(db, listId)`.
pub async fn recount_list(db: &PgPool, list_id: &str) -> ReachResult<i64> {
    let db = orm(db);
    let n = members::Entity::find()
        .join(JoinType::InnerJoin, member_prospect())
        .filter(members::Column::ListId.eq(list_id))
        .filter(reach_prospects::Column::DeletedAt.is_null())
        .count(&db)
        .await?;
    lists::Entity::update_many()
        .col_expr(
            lists::Column::ProspectCount,
            Expr::value(i32::try_from(n).unwrap_or(i32::MAX)),
        )
        .col_expr(lists::Column::UpdatedAt, Expr::value(now()))
        .filter(lists::Column::Id.eq(list_id))
        .exec(&db)
        .await?;
    Ok(i64::try_from(n).unwrap_or(i64::MAX))
}

/// `addProspectsToList(db, listId, prospectIds)`: how many joined.
pub async fn add_to_list(db: &PgPool, list_id: &str, prospect_ids: &[String]) -> ReachResult<i64> {
    let unique = crate::unique(prospect_ids);
    let mut added = 0i64;
    let conn = orm(db);
    for chunk in unique.chunks(500) {
        let live: Vec<String> = reach_prospects::Entity::find()
            .select_only()
            .column(reach_prospects::Column::Id)
            .filter(reach_prospects::Column::Id.is_in(chunk))
            .filter(reach_prospects::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&conn)
            .await?;
        if live.is_empty() {
            continue;
        }
        let inserted = members::Entity::insert_many(live.into_iter().map(|prospect_id| {
            members::ActiveModel {
                id: Set(generate_id("rplm")),
                list_id: Set(list_id.to_owned()),
                prospect_id: Set(prospect_id),
                ..Default::default()
            }
        }))
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&conn)
        .await?;
        added += i64::try_from(inserted).unwrap_or_default();
    }
    recount_list(db, list_id).await?;
    Ok(added)
}

/// `removeProspectsFromList(db, listId, prospectIds)`: how many left.
pub async fn remove_from_list(
    db: &PgPool,
    list_id: &str,
    prospect_ids: &[String],
) -> ReachResult<i64> {
    let unique = crate::unique(prospect_ids);
    let mut removed = 0i64;
    let conn = orm(db);
    for chunk in unique.chunks(500) {
        let gone = members::Entity::delete_many()
            .filter(members::Column::ListId.eq(list_id))
            .filter(members::Column::ProspectId.is_in(chunk))
            .exec(&conn)
            .await?;
        removed += i64::try_from(gone.rows_affected).unwrap_or_default();
    }
    recount_list(db, list_id).await?;
    Ok(removed)
}

/// `listProspectLists(db, q)`.
pub async fn list_lists(db: &PgPool, query: &PageQuery) -> ReachResult<Page> {
    use lists::Column;
    let limit = parse_limit(query.limit.as_deref());
    let cursor = cursor_row::<lists::Entity>(
        db,
        Column::CreatedAt,
        Column::Id,
        query.cursor.as_deref(),
    )
    .await?;
    let conn = orm(db);
    let mut page = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(cursor) = &cursor {
        page = page.add(before(Column::CreatedAt, Column::Id, cursor));
    }
    let rows = lists::Entity::find()
        .filter(page)
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(probe(limit))
        .all(&conn)
        .await?;
    let total = lists::Entity::find()
        .filter(Column::DeletedAt.is_null())
        .count(&conn)
        .await?;
    let rows = js_all(rows.into_iter().map(serde_json::to_value))?;
    Ok(page_result(
        &rows,
        limit,
        i64::try_from(total).unwrap_or(i64::MAX),
        to_list,
    ))
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
    use lists::Column;
    let mut update = lists::Entity::update_many();
    if let Some(name) = name {
        update = update.col_expr(Column::Name, Expr::value(name));
    }
    if let Some(description) = description {
        update = update.col_expr(Column::Description, Expr::value(description));
    }
    let row = update
        .col_expr(Column::UpdatedAt, Expr::value(now()))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    match row {
        Some(row) => Ok(to_list(&js(serde_json::to_value(row))?)),
        None => Err(ReachError::not_found("List", Some(id))),
    }
}

/// `deleteProspectList(db, id)`: soft-delete, memberships dropped.
pub async fn delete_list(db: &PgPool, id: &str) -> ReachResult<()> {
    let at = now();
    let db = orm(db);
    let deleted = lists::Entity::update_many()
        .col_expr(lists::Column::DeletedAt, Expr::value(at))
        .col_expr(lists::Column::UpdatedAt, Expr::value(at))
        .filter(lists::Column::Id.eq(id))
        .filter(lists::Column::DeletedAt.is_null())
        .exec(&db)
        .await?;
    if deleted.rows_affected == 0 {
        return Err(ReachError::not_found("List", Some(id)));
    }
    members::Entity::delete_many()
        .filter(members::Column::ListId.eq(id))
        .exec(&db)
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
