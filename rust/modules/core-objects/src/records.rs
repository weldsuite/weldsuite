//! `/api/objects/:slug/records`: the records of every custom object
//! (`routes/custom-object-records`, `middleware/custom-object.ts` and the
//! record functions of `@weldsuite/core-domain/custom-objects`).
//!
//! `:slug` resolves to a live, enabled object first (404), then the caller
//! needs `weldobjects:<slug>:<action>` (403). Without
//! `weldobjects:<slug>:scope:all` a caller sees only the records they own.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_events::EventType;
use weldsuite_kit::validation::{Field, Presence, js_number};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{Js, js_date, parse_body, stringify};
use crate::links::plan_target_delete;
use crate::objects::{CustomObject, object_by_slug};
use crate::values::{
    Column, Definition, ValuesError, definitions, resolve_title, set_values, values_for,
};
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, STAMPS, answer, now, query_param, row,
    validate,
};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreObjectsState>
where
    Q: PermissionQueries + 'static,
{
    // `requireCustomObject` checks the per-object permission in the handler;
    // the layer only resolves the caller's permissions.
    let resolve = || gate.resolve();
    Router::new()
        .route(
            "/{slug}/records",
            get(list).post(create).route_layer(resolve()),
        )
        .route(
            "/{slug}/records/{id}",
            get(detail)
                .patch(update)
                .delete(remove)
                .route_layer(resolve()),
        )
}

/// What a record route needs permission to do (`CustomObjectPermissionAction`).
#[derive(Debug, Clone, Copy)]
pub(crate) enum Action {
    Read,
    Create,
    Update,
    Delete,
}

impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

/// The resolved object, and the owner the caller is limited to (`None`
/// with `scope:all`).
pub(crate) struct ObjectAccess {
    pub(crate) object: CustomObject,
    pub(crate) scope: Option<String>,
}

/// `requireCustomObject(action)` + `customObjectScope(c)`.
pub(crate) async fn require_object(
    caller: &Caller,
    slug: &str,
    action: Action,
) -> Result<ObjectAccess, Rejected> {
    let object = match object_by_slug(&caller.db, slug).await {
        Ok(Some(object)) if object.status != "disabled" => object,
        Ok(_) => {
            return Err(crate::reject(ApiError::not_found(
                "Custom object",
                Some(slug),
            )));
        }
        Err(error) => {
            tracing::error!(%error, "core objects: resolving a custom object failed");
            return Err(crate::reject(ApiError::internal()));
        }
    };
    if !caller.can(&format!("weldobjects:{slug}:{}", action.name())) {
        let message = format!(
            "You do not have permission to {} {}",
            action.name(),
            object.label_plural.to_lowercase()
        );
        return Err(crate::reject(ApiError::forbidden().with_message(message)));
    }
    let scope = (!caller.can(&format!("weldobjects:{}:scope:all", object.slug)))
        .then(|| caller.user_id.clone());
    Ok(ObjectAccess { object, scope })
}

/// `getRecord`: the live record of this object, within the owner scope,
/// with its fields.
pub(crate) async fn get_record(
    db: &PgPool,
    object: &CustomObject,
    id: &str,
    scope: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    let raw: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from custom_object_records r
          where id = $1 and entity_key = $2 and deleted_at is null
            and ($3::text is null or owner_id = $3)
          limit 1",
    )
    .bind(id)
    .bind(&object.entity_key)
    .bind(scope)
    .fetch_optional(db)
    .await?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let mut record = row(raw, &STAMPS);
    let definitions = definitions(db, &object.entity_key).await?;
    let mut values = values_for(db, &object.entity_key, &[id.to_owned()], &definitions).await?;
    record["fields"] = Value::Object(values.remove(id).unwrap_or_default());
    Ok(Some(record))
}

/// `co_<slug>:<action>`, when the object publishes events.
fn emit(
    state: &CoreObjectsState,
    caller: &Caller,
    object: &CustomObject,
    action: &str,
    entity_id: &str,
    data: Value,
    changes: Option<Map<String, Value>>,
) {
    if !object.enable_events {
        return;
    }
    match EventType::custom_object(&object.entity_key, action) {
        Ok(event) => caller.publish_with_changes(state, event, entity_id, data, changes),
        Err(error) => tracing::error!(%error, "core objects: not a custom object key"),
    }
}

// ── GET /:slug/records ─────────────────────────────────────────────────────

/// The WHERE clause of the list and its count: the object's live records,
/// the owner, the title search, and every custom-field filter as one row of
/// the `unnest`ed arrays (`customFieldFilter`, as `entity_id in (…)`).
macro_rules! records_where {
    () => {
        "where r.entity_key = $1 and r.deleted_at is null
           and ($2::text is null or r.owner_id = $2)
           and ($3::text is null or r.title ilike $3)
           and not exists (
             select 1
               from unnest($4::text[], $5::text[], $6::float8[], $7::text[], $8::bool[], $9::text[])
                    as f(field_id, kind, num, day, flag, txt)
              where not exists (
                select 1 from custom_field_values v
                 where v.entity_type = $1 and v.entity_id = r.id and v.field_id = f.field_id
                   and case f.kind
                         when 'number' then v.value_number = f.num
                         when 'date' then v.value_date::date = f.day::timestamp::date
                         when 'bool' then v.value_bool = f.flag
                         when 'json' then v.value_json @> f.txt::jsonb
                         when 'ref' then v.value_ref = f.txt
                         else v.value_text ilike f.txt
                       end))"
    };
}

/// One custom-field sort expression per column and direction: only the one
/// `$10`/`$11` choose is non-null, so the others don't change the order
/// (`customFieldOrderBy`: a correlated lookup, `nulls last` either way).
macro_rules! custom_sort {
    ($kind:literal, $column:literal) => {
        concat!(
            "case when $10 = '", $kind, "' and $11 then (select v.", $column,
            " from custom_field_values v where v.entity_type = $1 and v.entity_id = r.id and v.field_id = $12)",
            " end asc nulls last, ",
            "case when $10 = '", $kind, "' and not $11 then (select v.", $column,
            " from custom_field_values v where v.entity_type = $1 and v.entity_id = r.id and v.field_id = $12)",
            " end desc nulls last, "
        )
    };
}

const LIST_SQL: &str = concat!(
    "select to_jsonb(r) from custom_object_records r ",
    records_where!(),
    " order by ",
    custom_sort!("text", "value_text"),
    custom_sort!("number", "value_number"),
    custom_sort!("date", "value_date"),
    custom_sort!("bool", "value_bool"),
    custom_sort!("json", "value_json"),
    custom_sort!("ref", "value_ref"),
    // The built-in columns keep Postgres's default null order, as Drizzle's
    // `asc(col)` / `desc(col)` do.
    "case when $10 = 'title' and $11 then r.title end asc,
     case when $10 = 'title' and not $11 then r.title end desc,
     case when $10 = 'updated' and $11 then r.updated_at end asc,
     case when $10 = 'updated' and not $11 then r.updated_at end desc,
     case when $10 = 'created' and $11 then r.created_at end asc,
     case when $10 = 'created' and not $11 then r.created_at end desc,
     r.id desc
     limit $13 offset $14"
);

const COUNT_SQL: &str = concat!(
    "select count(*) from custom_object_records r ",
    records_where!()
);

/// `custom:<slug>` → the slug (`parseCustomFieldKey`).
fn custom_field_key(key: &str) -> Option<&str> {
    key.strip_prefix("custom:").filter(|slug| !slug.is_empty())
}

/// `filter[<key>]` → the key (`/^filter\[(.+)\]$/`).
fn filter_key(name: &str) -> Option<&str> {
    let inner = name.strip_prefix("filter[")?.strip_suffix(']')?;
    (!inner.is_empty() && !inner.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(inner)
}

/// The custom-field filters as the arrays the query unnests.
#[derive(Default)]
struct Filters {
    field_ids: Vec<String>,
    kinds: Vec<String>,
    numbers: Vec<Option<f64>>,
    days: Vec<Option<String>>,
    flags: Vec<Option<bool>>,
    texts: Vec<Option<String>>,
}

impl Filters {
    /// Add one; `false` when the value can't match the field's type, which
    /// means no rows rather than no filter.
    fn push(&mut self, definition: &Definition, raw: &str) -> bool {
        let column = Column::of(&definition.field_type);
        let (mut number, mut day, mut flag, mut text) = (None, None, None, None);
        match column {
            Column::Number => {
                let n = js_number(raw);
                if n.is_nan() {
                    return false;
                }
                number = Some(n);
            }
            Column::Date => match js_date(raw) {
                Some(iso) => day = Some(iso),
                None => return false,
            },
            Column::Bool => match raw {
                "true" => flag = Some(true),
                "false" => flag = Some(false),
                _ => return false,
            },
            Column::Json => text = Some(stringify(&Js::Array(vec![Js::String(raw.to_owned())]))),
            Column::Ref => text = Some(raw.to_owned()),
            Column::Text => text = Some(format!("%{raw}%")),
        }
        self.field_ids.push(definition.id.clone());
        self.kinds.push(column.kind().to_owned());
        self.numbers.push(number);
        self.days.push(day);
        self.flags.push(flag);
        self.texts.push(text);
        true
    }
}

/// `ilike` pattern with `\`, `%` and `_` taken literally (`escapeLikeTerm`).
fn like_pattern(search: &str) -> String {
    let mut out = String::from("%");
    for c in search.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

async fn list(caller: Caller, Path(slug): Path<String>, RawQuery(query): RawQuery) -> Response {
    let access = match require_object(&caller, &slug, Action::Read).await {
        Ok(access) => access,
        Err(refused) => return *refused,
    };
    let fallback = format!(
        "Failed to list {}",
        access.object.label_plural.to_lowercase()
    );
    let result = list_records(&caller, &access, query.as_deref()).await;
    answer(result, &fallback)
}

async fn list_records(caller: &Caller, access: &ObjectAccess, query: Option<&str>) -> Answer {
    let db = &caller.db;
    let object = &access.object;
    let param = |name: &str| query_param(query, name);
    // `parseLimit`: unparseable is 25, then clamped to 1..=100.
    let limit =
        crate::js::parse_int(&param("limit").unwrap_or_default()).map_or(25, |n| n.clamp(1, 100));
    // `decodeCursor`: `o<offset>`, anything else is the first page.
    let offset = param("cursor")
        .and_then(|cursor| cursor.strip_prefix('o').and_then(crate::js::parse_int))
        .filter(|n| *n >= 0)
        .unwrap_or(0);
    let ascending = param("direction").as_deref() == Some("asc");
    let owner = access
        .scope
        .clone()
        .or_else(|| param("ownerId").filter(|id| !id.is_empty()));
    let search = param("search")
        .filter(|s| !s.is_empty())
        .map(|s| like_pattern(&s));

    let definitions = definitions(db, &object.entity_key).await?;
    let mut by_slug = std::collections::HashMap::new();
    for definition in &definitions {
        by_slug.insert(definition.slug.as_str(), definition);
    }

    // `c.req.query()`: each key once, with its first value.
    let mut seen = std::collections::HashSet::new();
    let mut filters = Filters::default();
    for (name, value) in crate::form_pairs(query) {
        if !seen.insert(name.clone()) {
            continue;
        }
        let Some(slug) = filter_key(&name).and_then(custom_field_key) else {
            continue;
        };
        let matched = by_slug
            .get(slug)
            .is_some_and(|definition| filters.push(definition, &value));
        if !matched {
            return Ok(crate::records::empty_page());
        }
    }

    let sort = param("sort").unwrap_or_default();
    let (sort_kind, sort_field) = match custom_field_key(&sort) {
        Some(slug) => match by_slug.get(slug) {
            Some(definition) => (
                Column::of(&definition.field_type).kind(),
                Some(definition.id.clone()),
            ),
            None => ("created", None),
        },
        None if sort == "title" => ("title", None),
        None if sort == "updatedAt" => ("updated", None),
        None => ("created", None),
    };

    let query = PageQuery {
        entity_key: &object.entity_key,
        owner: owner.as_deref(),
        search: search.as_deref(),
        filters: &filters,
        sort_kind,
        ascending,
        sort_field: sort_field.as_deref(),
        limit,
        offset,
    };
    let (rows, total) = fetch_page(db, &query).await?;

    let page_size = usize::try_from(limit).unwrap_or(25);
    let has_more = rows.len() > page_size;
    let mut page: Vec<Value> = rows
        .into_iter()
        .take(page_size)
        .map(|r| row(r, &STAMPS))
        .collect();
    let ids: Vec<String> = page
        .iter()
        .map(|r| r["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    let mut values = values_for(db, &object.entity_key, &ids, &definitions).await?;
    for (record, id) in page.iter_mut().zip(&ids) {
        record["fields"] = Value::Object(values.remove(id).unwrap_or_default());
    }
    let cursor = has_more.then(|| format!("o{}", offset + limit));
    Ok(weldsuite_kit::List::new(
        page,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response())
}

/// One page of the list query and the total it pages through.
struct PageQuery<'a> {
    entity_key: &'a str,
    owner: Option<&'a str>,
    search: Option<&'a str>,
    filters: &'a Filters,
    /// `text` … `ref` (a custom field's column), `title`, `updated` or `created`.
    sort_kind: &'a str,
    ascending: bool,
    sort_field: Option<&'a str>,
    limit: i64,
    offset: i64,
}

/// The page's rows (up to `limit + 1`, to tell whether there is more) and
/// the total count.
async fn fetch_page(db: &PgPool, q: &PageQuery<'_>) -> Result<(Vec<Value>, i64), sqlx::Error> {
    let f = q.filters;
    let rows: Vec<Value> = sqlx::query_scalar(LIST_SQL)
        .bind(q.entity_key)
        .bind(q.owner)
        .bind(q.search)
        .bind(&f.field_ids)
        .bind(&f.kinds)
        .bind(&f.numbers)
        .bind(&f.days)
        .bind(&f.flags)
        .bind(&f.texts)
        .bind(q.sort_kind)
        .bind(q.ascending)
        .bind(q.sort_field)
        .bind(q.limit + 1)
        .bind(q.offset)
        .fetch_all(db)
        .await?;
    let total: i64 = sqlx::query_scalar(COUNT_SQL)
        .bind(q.entity_key)
        .bind(q.owner)
        .bind(q.search)
        .bind(&f.field_ids)
        .bind(&f.kinds)
        .bind(&f.numbers)
        .bind(&f.days)
        .bind(&f.flags)
        .bind(&f.texts)
        .fetch_one(db)
        .await?;
    Ok((rows, total))
}

/// No rows: a filter that can't match.
pub(crate) fn empty_page() -> Response {
    weldsuite_kit::List::new(
        Vec::<Value>::new(),
        weldsuite_kit::Pagination::new(0, false, None),
    )
    .into_response()
}

// ── GET /:slug/records/:id ─────────────────────────────────────────────────

async fn detail(caller: Caller, Path((slug, id)): Path<(String, String)>) -> Response {
    let access = match require_object(&caller, &slug, Action::Read).await {
        Ok(access) => access,
        Err(refused) => return *refused,
    };
    let object = &access.object;
    let result: Answer = async {
        let record = get_record(&caller.db, object, &id, access.scope.as_deref())
            .await?
            .ok_or_else(|| Refusal::not_found(&object.label_singular, &id))?;
        Ok(Data(record).into_response())
    }
    .await;
    answer(
        result,
        &format!("Failed to fetch {}", object.label_singular.to_lowercase()),
    )
}

// ── POST /:slug/records, PATCH /:slug/records/:id ──────────────────────────

/// `createCustomObjectRecordSchema` (= the update one): the `fields` map in
/// the body's key order, and `ownerId`.
struct RecordInput {
    fields: Option<Vec<(String, Js)>>,
    owner_id: Field<String>,
}

fn record_input(headers: &HeaderMap, body: &Bytes) -> Result<RecordInput, Rejected> {
    let owner_id = validate(headers, body, |issues, fields| {
        issues.nested(fields, "fields", Presence::Optional, |_, _| ());
        issues.text(fields, "ownerId", Presence::Nullish, None, Some(255))
    })?;
    let fields = match parse_body(body).get("fields") {
        Some(Js::Object(entries)) => Some(entries.clone()),
        _ => None,
    };
    Ok(RecordInput { fields, owner_id })
}

fn values_refusal(error: ValuesError) -> Refusal {
    match error {
        ValuesError::Invalid(message) => Refusal::bad_request(message),
        ValuesError::Database(error) => Refusal::Database(error),
    }
}

async fn create(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(slug): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let access = match require_object(&caller, &slug, Action::Create).await {
        Ok(access) => access,
        Err(refused) => return *refused,
    };
    let input = match record_input(&headers, &body) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let object = &access.object;
    let result: Answer = async {
        let db = &caller.db;
        let definitions = definitions(db, &object.entity_key).await?;
        let fields = input.fields.unwrap_or_default();
        let id = generate_id("cor");
        let now = now();
        // The shell first, so the values have a parent; undone by hand when a
        // value is refused (neon-http has no interactive transactions).
        sqlx::query(
            "insert into custom_object_records
                 (id, object_id, entity_key, title, owner_id, created_by, updated_by, created_at, updated_at)
             values ($1, $2, $3, null, $4, $5, $5, $6::timestamp, $6::timestamp)",
        )
        .bind(&id)
        .bind(&object.id)
        .bind(&object.entity_key)
        .bind(input.owner_id.as_set().unwrap_or(&caller.user_id))
        .bind(&caller.user_id)
        .bind(&now)
        .execute(db)
        .await?;
        if let Err(error) = set_values(db, &object.entity_key, &id, &fields, &definitions, false, true).await {
            sqlx::query("delete from custom_object_records where id = $1").bind(&id).execute(db).await?;
            return Err(values_refusal(error));
        }
        let lookup = |slug: &str| fields.iter().find(|(key, _)| key == slug).map(|(_, value)| value.clone());
        let title = resolve_title(object.title_field_id.as_deref(), &definitions, lookup);
        sqlx::query("update custom_object_records set title = $2 where id = $1")
            .bind(&id)
            .bind(&title)
            .execute(db)
            .await?;
        let raw: Option<Value> = sqlx::query_scalar("select to_jsonb(r) from custom_object_records r where id = $1 limit 1")
            .bind(&id)
            .fetch_optional(db)
            .await?;
        let mut record = raw.map_or_else(|| json!({}), |r| row(r, &STAMPS));
        record["fields"] = Js::Object(fields).to_value();
        emit(&state, &caller, object, "created", &id, record.clone(), None);
        Ok(Created(record).into_response())
    }
    .await;
    answer(
        result,
        &format!("Failed to create {}", object.label_singular.to_lowercase()),
    )
}

/// `computeChanges(existing.fields, updated.fields)`: the fields whose JSON
/// differs, `old` left off where the field had no value.
fn field_changes(old: &Map<String, Value>, new: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut changes = Map::new();
    for (key, value) in new {
        if key == "updatedAt" {
            continue;
        }
        let before = old.get(key);
        let same = before.is_some_and(|before| {
            stringify(&Js::from_jsonb(before)) == stringify(&Js::from_jsonb(value))
        });
        if !same {
            let mut entry = Map::new();
            if let Some(before) = before {
                entry.insert("old".to_owned(), before.clone());
            }
            entry.insert("new".to_owned(), value.clone());
            changes.insert(key.clone(), Value::Object(entry));
        }
    }
    (!changes.is_empty()).then_some(changes)
}

async fn update(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path((slug, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let access = match require_object(&caller, &slug, Action::Update).await {
        Ok(access) => access,
        Err(refused) => return *refused,
    };
    let input = match record_input(&headers, &body) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let object = &access.object;
    let result: Answer = async {
        let db = &caller.db;
        let existing = get_record(db, object, &id, access.scope.as_deref())
            .await?
            .ok_or_else(|| Refusal::not_found(&object.label_singular, &id))?;
        let definitions = definitions(db, &object.entity_key).await?;
        if let Some(fields) = &input.fields {
            set_values(
                db,
                &object.entity_key,
                &id,
                fields,
                &definitions,
                true,
                false,
            )
            .await
            .map_err(values_refusal)?;
        }
        let mut values = values_for(
            db,
            &object.entity_key,
            std::slice::from_ref(&id),
            &definitions,
        )
        .await?;
        let fields = values.remove(&id).unwrap_or_default();
        let title = resolve_title(object.title_field_id.as_deref(), &definitions, |slug| {
            fields.get(slug).map(Js::from_jsonb)
        });
        let (set_owner, owner) = crate::change(&input.owner_id);
        sqlx::query(
            "update custom_object_records set
                 updated_at = $2::timestamp, updated_by = $3, title = $4,
                 owner_id = case when $5 then $6 else owner_id end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(&caller.user_id)
        .bind(&title)
        .bind(set_owner)
        .bind(owner)
        .execute(db)
        .await?;
        let raw: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(r) from custom_object_records r where id = $1 limit 1",
        )
        .bind(&id)
        .fetch_optional(db)
        .await?;
        let mut record = raw.map_or_else(|| json!({}), |r| row(r, &STAMPS));
        let empty = Map::new();
        let changes = field_changes(existing["fields"].as_object().unwrap_or(&empty), &fields);
        record["fields"] = Value::Object(fields);
        emit(
            &state,
            &caller,
            object,
            "updated",
            &id,
            record.clone(),
            changes,
        );
        Ok(Data(record).into_response())
    }
    .await;
    answer(
        result,
        &format!("Failed to update {}", object.label_singular.to_lowercase()),
    )
}

// ── DELETE /:slug/records/:id ──────────────────────────────────────────────

async fn remove(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path((slug, id)): Path<(String, String)>,
) -> Response {
    let access = match require_object(&caller, &slug, Action::Delete).await {
        Ok(access) => access,
        Err(refused) => return *refused,
    };
    let object = &access.object;
    let result: Answer = async {
        let db = &caller.db;
        let existing = get_record(db, object, &id, access.scope.as_deref())
            .await?
            .ok_or_else(|| Refusal::not_found(&object.label_singular, &id))?;
        let plan = plan_target_delete(db, &object.entity_key, &id).await?;
        if !plan.blocked_by.is_empty() {
            let message = format!(
                "This {} still has {} linked to it. Unlink them first, or change the relationship's delete rule.",
                object.label_singular.to_lowercase(),
                plan.blocked_by.join(", ")
            );
            return Err(ApiError::conflict(message)
                .with_details(json!({ "blockedBy": plan.blocked_by }))
                .into());
        }
        let now = now();
        let key = object.entity_key.as_str();
        // The cascade and the delete commit together.
        let mut statements = Vec::new();
        if !plan.cascaded_record_ids.is_empty() {
            statements.push(
                sqlx::query(
                    "update custom_object_records set deleted_at = $2::timestamp, updated_at = $2::timestamp
                      where id = any($1)",
                )
                .bind(&plan.cascaded_record_ids)
                .bind(&now),
            );
        }
        statements.extend([
            sqlx::query("delete from custom_object_relations where target_entity_key = $1 and target_id = $2")
                .bind(key)
                .bind(&id),
            sqlx::query(
                "update custom_object_records set deleted_at = $3::timestamp, updated_at = $3::timestamp
                  where id = $1 and entity_key = $2",
            )
            .bind(&id)
            .bind(key)
            .bind(&now),
            sqlx::query("delete from custom_field_values where entity_type = $1 and entity_id = $2")
                .bind(key)
                .bind(&id),
            sqlx::query(
                "delete from custom_object_relations
                  where (source_entity_key = $1 and source_id = $2) or (target_entity_key = $1 and target_id = $2)",
            )
            .bind(key)
            .bind(&id),
        ]);
        weldsuite_db::atomically(db, statements).await?;
        let mut data = json!({ "id": id, "title": existing["title"] });
        if !plan.cascaded_record_ids.is_empty() {
            data["cascadedRecordIds"] = json!(plan.cascaded_record_ids);
        }
        emit(&state, &caller, object, "deleted", &id, data, None);
        Ok(NoContent.into_response())
    }
    .await;
    answer(
        result,
        &format!("Failed to delete {}", object.label_singular.to_lowercase()),
    )
}

#[cfg(test)]
mod tests {
    //! The value store and the list query against the real tenant schema (a
    //! database built from the journaled migrations by
    //! `scripts/rust-test-db.ts`). Runs when `WELDSUITE_TEST_TENANT_URL` is
    //! set; otherwise it returns early.

    use super::*;

    fn js(text: &str) -> Js {
        serde_json::from_str(text).expect("json")
    }

    async fn ids(
        db: &PgPool,
        filters: &Filters,
        sort_kind: &str,
        ascending: bool,
        sort_field: Option<&str>,
    ) -> (Vec<String>, i64) {
        let query = PageQuery {
            entity_key: "co_rtest",
            owner: None,
            search: None,
            filters,
            sort_kind,
            ascending,
            sort_field,
            limit: 10,
            offset: 0,
        };
        let (rows, total) = fetch_page(db, &query).await.expect("page");
        let ids = rows
            .iter()
            .map(|r| r["id"].as_str().unwrap_or_default().to_owned())
            .collect();
        (ids, total)
    }

    const SEED: &str = r#"
        delete from custom_field_values where entity_type = 'co_rtest';
        delete from custom_object_records where entity_key = 'co_rtest';
        delete from custom_field_definitions where entity_type = 'co_rtest';
        insert into custom_field_definitions (id, entity_type, name, slug, field_type, options, sort_order) values
            ('cfld_rt_name', 'co_rtest', 'Name', 'name', 'text', null, 0),
            ('cfld_rt_power', 'co_rtest', 'Power', 'power', 'number', null, 1),
            ('cfld_rt_day', 'co_rtest', 'Day', 'day', 'date', null, 2),
            ('cfld_rt_on', 'co_rtest', 'On', 'on', 'boolean', null, 3),
            ('cfld_rt_tags', 'co_rtest', 'Tags', 'tags', 'multi_select',
             '[{"label":"Red","value":"red"},{"label":"Blue","value":"blue"}]', 4),
            ('cfld_rt_who', 'co_rtest', 'Who', 'who', 'user_ref', null, 5);
        insert into custom_object_records (id, object_id, entity_key, title, created_at, updated_at) values
            ('cor_rt_1', 'cobj_rt', 'co_rtest', 'Alpha', '2026-01-01T00:00:00', '2026-01-03T00:00:00'),
            ('cor_rt_2', 'cobj_rt', 'co_rtest', 'Beta', '2026-01-02T00:00:00', '2026-01-02T00:00:00'),
            ('cor_rt_3', 'cobj_rt', 'co_rtest', null, '2026-01-03T00:00:00', '2026-01-01T00:00:00');"#;

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn values_and_the_list_query_run_on_the_migrated_schema() {
        let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
            return;
        };
        let db = weldsuite_db::master_pool(&tenant_url, 2).expect("tenant pool");
        sqlx::raw_sql(SEED).execute(&db).await.expect("seed");
        let definitions = definitions(&db, "co_rtest").await.expect("definitions");
        assert_eq!(definitions.len(), 6);

        let first = [
            ("name".to_owned(), js(r#""Alpha""#)),
            ("power".to_owned(), js(r#""5""#)),
            ("day".to_owned(), js(r#""2026-03-04""#)),
            ("on".to_owned(), js("1")),
            ("tags".to_owned(), js(r#"["red","blue"]"#)),
            ("who".to_owned(), js(r#""user_x""#)),
        ];
        set_values(
            &db,
            "co_rtest",
            "cor_rt_1",
            &first,
            &definitions,
            false,
            true,
        )
        .await
        .expect("set");
        let second = [
            ("name".to_owned(), js(r#""Beta""#)),
            ("power".to_owned(), js("12.5")),
        ];
        set_values(
            &db,
            "co_rtest",
            "cor_rt_2",
            &second,
            &definitions,
            false,
            true,
        )
        .await
        .expect("set");
        // A patch updates one field and clears another.
        let patch = [("power".to_owned(), js("7")), ("who".to_owned(), Js::Null)];
        set_values(
            &db,
            "co_rtest",
            "cor_rt_1",
            &patch,
            &definitions,
            true,
            false,
        )
        .await
        .expect("patch");
        let invalid = [("power".to_owned(), js(r#""lots""#))];
        assert!(matches!(
            set_values(&db, "co_rtest", "cor_rt_1", &invalid, &definitions, true, false).await,
            Err(ValuesError::Invalid(message)) if message == "'power' must be a number"
        ));

        let wanted = ["cor_rt_1".to_owned(), "cor_rt_3".to_owned()];
        let values = values_for(&db, "co_rtest", &wanted, &definitions)
            .await
            .expect("values");
        assert_eq!(
            Value::Object(values["cor_rt_1"].clone()),
            json!({
                "name": "Alpha", "power": 7, "day": "2026-03-04T00:00:00.000Z",
                "on": true, "tags": ["red", "blue"]
            })
        );
        assert!(values["cor_rt_3"].is_empty());

        let none = Filters::default();
        let created = ids(&db, &none, "created", false, None).await;
        assert_eq!(created.0, ["cor_rt_3", "cor_rt_2", "cor_rt_1"]);
        assert_eq!(created.1, 3);
        let title = ids(&db, &none, "title", false, None).await.0;
        assert_eq!(title, ["cor_rt_3", "cor_rt_2", "cor_rt_1"]);
        let updated = ids(&db, &none, "updated", true, None).await.0;
        assert_eq!(updated, ["cor_rt_3", "cor_rt_2", "cor_rt_1"]);
        let power_up = ids(&db, &none, "number", true, Some("cfld_rt_power"))
            .await
            .0;
        assert_eq!(power_up, ["cor_rt_1", "cor_rt_2", "cor_rt_3"]);
        let power_down = ids(&db, &none, "number", false, Some("cfld_rt_power"))
            .await
            .0;
        assert_eq!(power_down, ["cor_rt_2", "cor_rt_1", "cor_rt_3"]);

        let by_slug: std::collections::HashMap<&str, &Definition> =
            definitions.iter().map(|d| (d.slug.as_str(), d)).collect();
        for (slug, raw, expected) in [
            ("power", "7", vec!["cor_rt_1"]),
            ("name", "et", vec!["cor_rt_2"]),
            ("day", "2026-03-04", vec!["cor_rt_1"]),
            ("on", "true", vec!["cor_rt_1"]),
            ("tags", "blue", vec!["cor_rt_1"]),
            ("who", "user_x", vec![]),
        ] {
            let mut filters = Filters::default();
            assert!(filters.push(by_slug[slug], raw));
            let (found, total) = ids(&db, &filters, "created", false, None).await;
            assert_eq!(found, expected, "{slug}={raw}");
            assert_eq!(total, i64::try_from(expected.len()).unwrap_or(0));
        }
        let mut both = Filters::default();
        assert!(both.push(by_slug["name"], "a"));
        assert!(both.push(by_slug["power"], "12.5"));
        assert_eq!(
            ids(&db, &both, "created", false, None).await.0,
            ["cor_rt_2"]
        );
        assert!(!Filters::default().push(by_slug["power"], "abc"));
    }
}
