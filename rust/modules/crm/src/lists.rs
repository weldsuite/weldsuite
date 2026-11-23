//! `/api/lists` (`routes/lists/index.ts`): company and person lists
//! (`lists`, `list_members`). A list's `kind` is fixed at create time and
//! decides which identity table its members are.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CUSTOMER_LIST_CREATED, CUSTOMER_LIST_DELETED, CUSTOMER_LIST_UPDATED,
};
use weldsuite_crm_domain::tables::LISTS;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{companies, list_members, lists, people};

use crate::orm_rows::{before, cursor_row, insert_values, js_date, json, probe_limit, set_values};
use crate::schema::{Kind, OPT, REQ, Spec, partial, s};
use crate::{Answer, Caller, CrmState, Refusal, answer, cut, now, page, validate_specs};

const LOG: &str = "lists";

/// `lists`, written from a body as Drizzle wrote it.
const LISTS_TABLE: JsonTable = JsonTable::of::<lists::Entity>();

const KINDS: &[&str] = &["company", "person"];

/// `createListSchemaV2`.
const CREATE: [Spec; 7] = [
    Spec::new("name", s(Some(1), Some(255)), REQ),
    Spec::new("kind", Kind::Enum(KINDS), REQ),
    Spec::new("type", Kind::Enum(&["static", "smart"]), OPT).with_default("\"static\""),
    Spec::new("color", s(None, Some(50)), OPT).with_default("\"bg-blue-500\""),
    Spec::new("icon", s(None, Some(100)), OPT).with_default("\"List\""),
    Spec::new("description", s(None, Some(1000)), OPT),
    Spec::new("filterRules", Kind::Record, OPT),
];

/// `updateListSchemaV2`: the create schema without `kind`, partial.
fn update_schema() -> Vec<Spec> {
    let without_kind: Vec<Spec> = CREATE.iter().filter(|s| s.key != "kind").copied().collect();
    partial(&without_kind)
}

/// `listListsQueryV2`.
struct ListQuery {
    cursor: Option<String>,
    limit: i64,
    search: Option<String>,
    kind: Option<String>,
}

fn list_query(raw: Option<&str>) -> Answer<ListQuery> {
    let values = query_values(raw);
    let mut issues = Issues::default();
    let cursor = issues
        .text_with(&values, "cursor", Presence::Optional, Text::default())
        .into_option();
    #[allow(clippy::cast_possible_truncation)]
    let limit = issues
        .number(
            &values,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: false,
                min: Some(1.0),
                max: Some(200.0),
            },
        )
        .into_option()
        .unwrap_or(100.0);
    let search = issues
        .text_with(&values, "search", Presence::Optional, Text::default())
        .into_option();
    let kind = issues
        .choice(&values, "kind", Presence::Optional, KINDS)
        .into_option();
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    // `.limit(q.limit + 1)` with a fractional limit fails in Postgres.
    if limit.fract() != 0.0 {
        return Err(Refusal::Failed("LIMIT must be an integer".to_owned()));
    }
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit as i64;
    Ok(ListQuery {
        cursor,
        limit,
        search,
        kind,
    })
}

async fn live(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = lists::Entity::find_by_id(id.to_owned())
        .filter(lists::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    row.map(|row| json(serde_json::to_value(row))).transpose()
}

async fn by_id(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = lists::Entity::find_by_id(id.to_owned())
        .one(&orm(&caller.db))
        .await?;
    row.map(|row| json(serde_json::to_value(row))).transpose()
}

/// `countMembersByList`: member counts for these lists.
async fn member_counts(
    caller: &Caller,
    ids: &[String],
) -> Result<std::collections::HashMap<String, i64>, DbErr> {
    use list_members::Column;
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows: Vec<(String, i64)> = list_members::Entity::find()
        .select_only()
        .column(Column::ListId)
        .expr(Func::count(Expr::col(Asterisk)))
        .filter(Column::ListId.is_in(ids.iter().map(String::as_str)))
        .group_by(Column::ListId)
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    Ok(rows.into_iter().collect())
}

/// The list's columns the list route returns (`select({ id, name, kind,
/// type, color, icon, description, linkedListId, createdAt, updatedAt })`).
const LIST_KEYS: [&str; 10] = [
    "id",
    "name",
    "kind",
    "type",
    "color",
    "icon",
    "description",
    "linkedListId",
    "createdAt",
    "updatedAt",
];

/// The fields of a list named in [`LIST_KEYS`].
fn list_fields(row: lists::Model) -> Result<Value, DbErr> {
    let row = json(serde_json::to_value(row))?;
    Ok(Value::Object(
        LIST_KEYS
            .iter()
            .map(|key| {
                let value = row.get(*key).cloned().unwrap_or(Value::Null);
                ((*key).to_owned(), value)
            })
            .collect(),
    ))
}

/// The list conditions that are `on` (live, search, kind), in TypeScript's
/// order.
fn list_filters(on: [bool; 3], search: Option<&String>, kind: Option<&String>) -> Condition {
    use lists::Column;
    let mut filters = Condition::all();
    if on[0] {
        filters = filters.add(Column::DeletedAt.is_null());
    }
    if on[1]
        && let Some(search) = search
    {
        filters = filters.add(Column::Name.like(search.as_str()));
    }
    if on[2]
        && let Some(kind) = kind
    {
        filters = filters.add(Column::Kind.eq(kind.as_str()));
    }
    filters
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let q = match list_query(query.as_deref()) {
        Ok(q) => q,
        Err(refusal) => return refusal.respond(LOG, "Invalid query"),
    };
    answer(run_list(&caller, q).await, LOG, "Failed to list lists")
}

async fn run_list(caller: &Caller, q: ListQuery) -> Answer {
    use lists::{Column, Entity};
    let mut cursor = None;
    if let Some(id) = q.cursor.as_ref().filter(|c| !c.is_empty()) {
        cursor = cursor_row::<Entity>(&caller.db, Column::CreatedAt, Column::Id, id).await?;
    }
    let search = q
        .search
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let kind = q.kind.clone();
    // Count: with a cursor given, the last condition is dropped
    // (`conditions.slice(0, -1)`), found or not.
    let mut on = [true, search.is_some(), kind.is_some()];
    if q.cursor.as_ref().is_some_and(|c| !c.is_empty())
        && cursor.is_none()
        && let Some(last) = on.iter().rposition(|f| *f)
    {
        on[last] = false;
    }
    let page_on = [true, search.is_some(), kind.is_some()];
    let mut rows = Entity::find().filter(list_filters(page_on, search.as_ref(), kind.as_ref()));
    if let Some(cursor) = &cursor {
        rows = rows.filter(before(Column::CreatedAt, Column::Id, cursor));
    }
    let db = orm(&caller.db);
    let rows = rows
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(probe_limit(q.limit)?)
        .all(&db)
        .await?;
    let total = Entity::find()
        .filter(list_filters(on, search.as_ref(), kind.as_ref()))
        .count(&db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows = rows
        .into_iter()
        .map(list_fields)
        .collect::<Result<Vec<_>, DbErr>>()?;
    let (data, has_more, next) = cut(rows, q.limit);
    let ids: Vec<String> = data
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let counts = member_counts(caller, &ids).await?;
    let data = data
        .into_iter()
        .map(|mut row| {
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if let Value::Object(fields) = &mut row {
                fields.insert(
                    "memberCount".into(),
                    json!(counts.get(&id).copied().unwrap_or(0)),
                );
            }
            row
        })
        .collect();
    Ok(page(data, total, has_more, next))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(mut row) = live(&caller, &id).await? else {
            return Ok(ApiError::not_found("List", Some(&id)).into_response());
        };
        let counts = member_counts(&caller, std::slice::from_ref(&id)).await?;
        if let Value::Object(fields) = &mut row {
            fields.insert(
                "memberCount".into(),
                json!(counts.get(&id).copied().unwrap_or(0)),
            );
        }
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, LOG, "Failed to fetch list")
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, &CREATE) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let id = generate_id("list");
        let now = now();
        let mut values = Map::new();
        values.insert("id".into(), json!(id));
        for key in ["name", "kind", "type", "color", "icon"] {
            if let Some(value) = data.get(key) {
                values.insert(key.into(), value.clone());
            }
        }
        values.insert(
            "description".into(),
            data.get("description").cloned().unwrap_or(Value::Null),
        );
        values.insert(
            "filterRules".into(),
            data.get("filterRules").cloned().unwrap_or(Value::Null),
        );
        values.insert("createdAt".into(), json!(now));
        values.insert("updatedAt".into(), json!(now));
        let row = LISTS_TABLE
            .insert(&orm(&caller.db), insert_values(&LISTS, &values))
            .await?;
        caller.publish(
            &state,
            CUSTOMER_LIST_CREATED,
            &id,
            &json!({ "id": id, "name": data.get("name"), "kind": data.get("kind") }),
        );
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, LOG, "Failed to create list")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, &update_schema()) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let Some(existing) = live(&caller, &id).await? else {
            return Ok(ApiError::not_found("List", Some(&id)).into_response());
        };
        let mut update = Map::new();
        update.insert("updatedAt".into(), json!(now()));
        for (key, value) in &data {
            update.insert(key.clone(), value.clone());
        }
        LISTS_TABLE
            .update(&orm(&caller.db), &id, set_values(&LISTS, &update), true)
            .await?;
        let row = by_id(&caller, &id).await?;
        let name = match update.get("name") {
            Some(name) if !name.is_null() => name.clone(),
            _ => existing.get("name").cloned().unwrap_or(Value::Null),
        };
        caller.publish(
            &state,
            CUSTOMER_LIST_UPDATED,
            &id,
            &json!({ "id": id, "name": name, "kind": existing.get("kind") }),
        );
        Ok(Data(row.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update list")
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if live(&caller, &id).await?.is_none() {
            return Ok(ApiError::not_found("List", Some(&id)).into_response());
        }
        let at = utc_now();
        lists::Entity::update_many()
            .col_expr(lists::Column::DeletedAt, Expr::value(at))
            .col_expr(lists::Column::UpdatedAt, Expr::value(at))
            .filter(lists::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, CUSTOMER_LIST_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete list")
}

/// The live list's `kind`, or `None`.
async fn kind_of(caller: &Caller, id: &str) -> Result<Option<String>, DbErr> {
    lists::Entity::find()
        .select_only()
        .column(lists::Column::Kind)
        .filter(lists::Column::Id.eq(id))
        .filter(lists::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await
}

/// The list's members joined to their records in `E` (`companies` or
/// `people`, by `id`), newest first: `{ memberId, entityId, addedAt,
/// entity }`.
async fn members_of<E: EntityTrait>(
    db: &DatabaseConnection,
    list_id: &str,
    id: E::Column,
    entity_json: fn(E::Model) -> Result<Value, serde_json::Error>,
) -> Result<Vec<Value>, DbErr> {
    use list_members::Column;
    let rows = list_members::Entity::find()
        .select_also(E::default())
        .join(
            JoinType::InnerJoin,
            list_members::Entity::belongs_to(E::default())
                .from(Column::EntityId)
                .to(id)
                .into(),
        )
        .filter(Column::ListId.eq(list_id))
        .order_by_desc(Column::AddedAt)
        .all(db)
        .await?;
    rows.into_iter()
        .map(|(member, entity)| {
            let entity = match entity {
                Some(entity) => json(entity_json(entity))?,
                None => Value::Null,
            };
            Ok(json!({
                "memberId": member.id,
                "entityId": member.entity_id,
                "addedAt": js_date(member.added_at),
                "entity": entity,
            }))
        })
        .collect()
}

/// The ids among `ids` of live records in `E` (`companies` or `people`).
async fn live_ids<E: EntityTrait>(
    db: &DatabaseConnection,
    id: E::Column,
    deleted_at: E::Column,
    ids: &[String],
) -> Result<Vec<String>, DbErr> {
    E::find()
        .select_only()
        .column(id)
        .filter(id.is_in(ids.iter().map(String::as_str)))
        .filter(deleted_at.is_null())
        .into_tuple()
        .all(db)
        .await
}

// ── GET /:id/members ────────────────────────────────────────────────────────

pub(crate) async fn members(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(kind) = kind_of(&caller, &id).await? else {
            return Ok(ApiError::not_found("List", Some(&id)).into_response());
        };
        let db = orm(&caller.db);
        let rows = if kind == "company" {
            members_of::<companies::Entity>(
                &db,
                &id,
                companies::Column::Id,
                serde_json::to_value::<companies::Model>,
            )
            .await?
        } else {
            members_of::<people::Entity>(
                &db,
                &id,
                people::Column::Id,
                serde_json::to_value::<people::Model>,
            )
            .await?
        };
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, LOG, "Failed to fetch list members")
}

// ── POST /:id/members ───────────────────────────────────────────────────────

pub(crate) async fn add_members(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let entity_ids = match crate::validate(&headers, &body, |issues, fields| {
        issues
            .list(
                fields,
                "entityIds",
                Presence::Required,
                Some(1),
                None,
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(ids) => ids,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let Some(kind) = kind_of(&caller, &id).await? else {
            return Ok(ApiError::not_found("List", Some(&id)).into_response());
        };
        // `Array.from(new Set(entityIds))`
        let mut deduped: Vec<String> = Vec::new();
        for entity_id in entity_ids {
            if !deduped.contains(&entity_id) {
                deduped.push(entity_id);
            }
        }
        let db = orm(&caller.db);
        let valid = if kind == "company" {
            live_ids::<companies::Entity>(
                &db,
                companies::Column::Id,
                companies::Column::DeletedAt,
                &deduped,
            )
            .await?
        } else {
            live_ids::<people::Entity>(&db, people::Column::Id, people::Column::DeletedAt, &deduped)
                .await?
        };
        let existing: Vec<String> = list_members::Entity::find()
            .select_only()
            .column(list_members::Column::EntityId)
            .filter(list_members::Column::ListId.eq(id.as_str()))
            .filter(list_members::Column::EntityId.is_in(deduped.iter().map(String::as_str)))
            .into_tuple()
            .all(&db)
            .await?;
        let to_add: Vec<String> = deduped
            .into_iter()
            .filter(|entity| valid.contains(entity) && !existing.contains(entity))
            .collect();
        if !to_add.is_empty() {
            let now = utc_now();
            let rows = to_add.iter().map(|entity| list_members::ActiveModel {
                id: Set(generate_id("lm")),
                added_at: Set(now),
                added_by: Set(None),
                list_id: Set(id.clone()),
                entity_id: Set(entity.clone()),
            });
            // One statement for every row, like Drizzle's multi-row insert.
            list_members::Entity::insert_many(rows)
                .exec_without_returning(&db)
                .await?;
            caller.publish(
                &state,
                CUSTOMER_LIST_UPDATED,
                &id,
                &json!({ "id": id, "kind": kind, "added": to_add.len() }),
            );
        }
        Ok(Data(json!({ "id": id, "added": to_add.len() })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to add list members")
}

// ── DELETE /:id/members/:entityId ───────────────────────────────────────────

pub(crate) async fn remove_member(
    State(state): State<CrmState>,
    caller: Caller,
    Path((id, entity_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let Some(kind) = kind_of(&caller, &id).await? else {
            return Ok(ApiError::not_found("List", Some(&id)).into_response());
        };
        let deleted = list_members::Entity::delete_many()
            .filter(list_members::Column::ListId.eq(id.as_str()))
            .filter(list_members::Column::EntityId.eq(entity_id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        if deleted.rows_affected > 0 {
            caller.publish(
                &state,
                CUSTOMER_LIST_UPDATED,
                &id,
                &json!({ "id": id, "kind": kind, "removedEntityId": entity_id }),
            );
        }
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to remove member from list")
}
