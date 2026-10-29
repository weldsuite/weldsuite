//! `/api/lists` (`routes/lists/index.ts`): company and person lists
//! (`lists`, `list_members`). A list's `kind` is fixed at create time and
//! decides which identity table its members are.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CUSTOMER_LIST_CREATED, CUSTOMER_LIST_DELETED, CUSTOMER_LIST_UPDATED,
};
use weldsuite_crm_domain::tables::{LIST_MEMBERS, LISTS};
use weldsuite_crm_domain::{drizzle_row, insert_sql, update_sql};
use weldsuite_kit::validation::{Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::schema::{Kind, OPT, REQ, Spec, partial, s};
use crate::{Answer, Caller, CrmState, Refusal, answer, cut, now, page, validate_specs};

const LOG: &str = "lists";

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

async fn live(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from lists t where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(drizzle_row))
}

async fn by_id(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from lists t where id = $1 limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(row.map(drizzle_row))
}

/// `countMembersByList`: member counts for these lists.
async fn member_counts(
    caller: &Caller,
    ids: &[String],
) -> Result<std::collections::HashMap<String, i64>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "select list_id, count(*) from list_members where list_id = any($1) group by list_id",
    )
    .bind(ids)
    .fetch_all(&caller.db)
    .await?;
    Ok(rows.into_iter().collect())
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
    let mut cursor: Option<(String, String)> = None;
    if let Some(id) = q.cursor.as_ref().filter(|c| !c.is_empty()) {
        cursor = sqlx::query_as(
            "select to_char(date_trunc('milliseconds', created_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
             from lists where id = $1 limit 1",
        )
        .bind(id)
        .fetch_optional(&caller.db)
        .await
        .map_err(|e| Refusal::Failed(e.to_string()))?;
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
    let (cursor_at, cursor_id) = cursor.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'name', name, 'kind', kind, 'type', type,
                    'color', color, 'icon', icon, 'description', description,
                    'linked_list_id', linked_list_id, 'created_at', created_at,
                    'updated_at', updated_at)
         from lists
         where deleted_at is null
           and ($1::text is null or name like $1)
           and ($2::text is null or kind = $2)
           and ($3::timestamp is null
                or created_at < $3::timestamp or (created_at = $3::timestamp and id < $4))
         order by created_at desc, id desc
         limit $5",
    )
    .bind(&search)
    .bind(&kind)
    .bind(&cursor_at)
    .bind(&cursor_id)
    .bind(q.limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from lists
         where (not $3 or deleted_at is null)
           and (not $4 or name like $1)
           and (not $5 or kind = $2)",
    )
    .bind(&search)
    .bind(&kind)
    .bind(on[0])
    .bind(on[1])
    .bind(on[2])
    .fetch_one(&caller.db)
    .await?;
    let (data, has_more, next) = cut(rows.into_iter().map(drizzle_row).collect(), q.limit);
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
        sqlx::query(insert_sql!(lists))
            .bind(LISTS.values(&values))
            .execute(&caller.db)
            .await?;
        let row = by_id(&caller, &id).await?;
        caller.publish(
            &state,
            CUSTOMER_LIST_CREATED,
            &id,
            &json!({ "id": id, "name": data.get("name"), "kind": data.get("kind") }),
        );
        Ok(Created(row.unwrap_or(Value::Null)).into_response())
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
        sqlx::query(update_sql!(
            lists,
            "where t.id = $1 and t.deleted_at is null"
        ))
        .bind(&id)
        .bind(LISTS.set(&update))
        .execute(&caller.db)
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
        sqlx::query(
            "update lists set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        caller.publish(&state, CUSTOMER_LIST_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete list")
}

/// The live list's `kind`, or `None`.
async fn kind_of(caller: &Caller, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select kind from lists where id = $1 and deleted_at is null limit 1")
        .bind(id)
        .fetch_optional(&caller.db)
        .await
}

// ── GET /:id/members ────────────────────────────────────────────────────────

pub(crate) async fn members(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(kind) = kind_of(&caller, &id).await? else {
            return Ok(ApiError::not_found("List", Some(&id)).into_response());
        };
        let rows: Vec<Value> = if kind == "company" {
            sqlx::query_scalar(
                "select jsonb_build_object('memberId', lm.id, 'entityId', lm.entity_id,
                        'addedAt', lm.added_at, 'entity', to_jsonb(e))
                 from list_members lm inner join companies e on e.id = lm.entity_id
                 where lm.list_id = $1
                 order by lm.added_at desc",
            )
            .bind(&id)
            .fetch_all(&caller.db)
            .await?
        } else {
            sqlx::query_scalar(
                "select jsonb_build_object('memberId', lm.id, 'entityId', lm.entity_id,
                        'addedAt', lm.added_at, 'entity', to_jsonb(e))
                 from list_members lm inner join people e on e.id = lm.entity_id
                 where lm.list_id = $1
                 order by lm.added_at desc",
            )
            .bind(&id)
            .fetch_all(&caller.db)
            .await?
        };
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|mut row| {
                if let Value::Object(fields) = &mut row {
                    if let Some(entity) = fields.remove("entity") {
                        fields.insert("entity".into(), drizzle_row(entity));
                    }
                    if let Some(Value::String(at)) = fields.get("addedAt").cloned() {
                        fields.insert(
                            "addedAt".into(),
                            json!(weldsuite_db::js_timestamp(&at).unwrap_or(at)),
                        );
                    }
                }
                row
            })
            .collect();
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
        let valid: Vec<String> = if kind == "company" {
            sqlx::query_scalar("select id from companies where id = any($1) and deleted_at is null")
                .bind(&deduped)
                .fetch_all(&caller.db)
                .await?
        } else {
            sqlx::query_scalar("select id from people where id = any($1) and deleted_at is null")
                .bind(&deduped)
                .fetch_all(&caller.db)
                .await?
        };
        let existing: Vec<String> = sqlx::query_scalar(
            "select entity_id from list_members where list_id = $1 and entity_id = any($2)",
        )
        .bind(&id)
        .bind(&deduped)
        .fetch_all(&caller.db)
        .await?;
        let to_add: Vec<String> = deduped
            .into_iter()
            .filter(|entity| valid.contains(entity) && !existing.contains(entity))
            .collect();
        if !to_add.is_empty() {
            let now = now();
            let rows: Vec<Value> = to_add
                .iter()
                .map(|entity| {
                    let mut values = Map::new();
                    values.insert("id".into(), json!(generate_id("lm")));
                    values.insert("listId".into(), json!(id));
                    values.insert("entityId".into(), json!(entity));
                    values.insert("addedAt".into(), json!(now));
                    LIST_MEMBERS.values(&values)
                })
                .collect();
            // One statement for every row, like Drizzle's multi-row insert.
            sqlx::query(
                "insert into list_members (id, added_at, added_by, list_id, entity_id)
                 select r.id, r.added_at, r.added_by, r.list_id, r.entity_id
                 from jsonb_populate_recordset(null::list_members, $1::jsonb) r",
            )
            .bind(Value::Array(rows))
            .execute(&caller.db)
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
        let deleted: Vec<String> = sqlx::query_scalar(
            "delete from list_members where list_id = $1 and entity_id = $2 returning id",
        )
        .bind(&id)
        .bind(&entity_id)
        .fetch_all(&caller.db)
        .await?;
        if !deleted.is_empty() {
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
