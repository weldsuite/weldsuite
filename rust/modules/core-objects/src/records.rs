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
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Expr, NullOrdering, Query, SelectStatement, SubQueryStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, Order, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, QueryTrait, Select,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{OrmConn, PgPool, orm, utc_now};
use weldsuite_events::EventType;
use weldsuite_kit::validation::{Field, Presence, js_number};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    custom_field_values, custom_object_records as records, custom_object_relations as relations,
};

use crate::js::{Js, js_date, parse_body, stringify};
use crate::links::plan_target_delete;
use crate::objects::{CustomObject, object_by_slug};
use crate::values::{
    Column, Definition, ValuesError, definitions, resolve_title, set_values, values_for,
};
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, answer, json_row, query_param, validate,
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
            "/{slug}/records/import",
            get(detail_import).post(import).route_layer(resolve()),
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
) -> Result<Option<Value>, DbErr> {
    let found = records::Entity::find()
        .filter(records::Column::Id.eq(id))
        .filter(records::Column::EntityKey.eq(&object.entity_key))
        .filter(records::Column::DeletedAt.is_null())
        .apply_if(scope, |query, owner| {
            query.filter(records::Column::OwnerId.eq(owner))
        })
        .one(&orm(db))
        .await?;
    let Some(found) = found else {
        return Ok(None);
    };
    let mut record = json_row(found)?;
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

/// `custom:<slug>` → the slug (`parseCustomFieldKey`).
fn custom_field_key(key: &str) -> Option<&str> {
    key.strip_prefix("custom:").filter(|slug| !slug.is_empty())
}

/// `filter[<key>]` → the key (`/^filter\[(.+)\]$/`).
fn filter_key(name: &str) -> Option<&str> {
    let inner = name.strip_prefix("filter[")?.strip_suffix(']')?;
    (!inner.is_empty() && !inner.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(inner)
}

/// What one custom-field filter asks of the field's value
/// (`customFieldFilter`), by the column it lives in.
#[derive(Debug, Clone)]
enum Test {
    /// `value_number = n`.
    Number(f64),
    /// `value_date::date = iso::timestamp::date`.
    Day(String),
    /// `value_bool = flag`.
    Flag(bool),
    /// `value_json @> '["value"]'::jsonb`.
    Contains(String),
    /// `value_ref = id`.
    Ref(String),
    /// `value_text ilike '%value%'`.
    Like(String),
}

/// One custom-field filter: the field, and what its value must be.
#[derive(Debug, Clone)]
struct Filter {
    field_id: String,
    test: Test,
}

/// The custom-field filters of a list; a record matches every one.
#[derive(Default)]
struct Filters(Vec<Filter>);

impl Filters {
    /// Add one; `false` when the value can't match the field's type, which
    /// means no rows rather than no filter.
    fn push(&mut self, definition: &Definition, raw: &str) -> bool {
        let test = match Column::of(&definition.field_type) {
            Column::Number => {
                let n = js_number(raw);
                if n.is_nan() {
                    return false;
                }
                Test::Number(n)
            }
            Column::Date => match js_date(raw) {
                Some(iso) => Test::Day(iso),
                None => return false,
            },
            Column::Bool => match raw {
                "true" => Test::Flag(true),
                "false" => Test::Flag(false),
                _ => return false,
            },
            Column::Json => Test::Contains(stringify(&Js::Array(vec![Js::String(raw.to_owned())]))),
            Column::Ref => Test::Ref(raw.to_owned()),
            Column::Text => Test::Like(format!("%{raw}%")),
        };
        self.0.push(Filter {
            field_id: definition.id.clone(),
            test,
        });
        true
    }
}

/// `v.entity_type = key and v.entity_id = r.id and v.field_id = field`: the
/// value row of one field of the listed record (`custom_field_values` keeps
/// one per field and record).
fn value_of(entity_key: &str, field_id: &str) -> SelectStatement {
    use custom_field_values::Column as Cell;
    Query::select()
        .from(custom_field_values::Entity)
        .and_where(Cell::EntityType.eq(entity_key))
        .and_where(sea_orm::ExprTrait::equals(
            Expr::col((custom_field_values::Entity, Cell::EntityId)),
            (records::Entity, records::Column::Id),
        ))
        .and_where(Cell::FieldId.eq(field_id))
        .to_owned()
}

/// `exists (select 1 from custom_field_values v where … and <test>)`.
fn matches(entity_key: &str, filter: &Filter) -> Expr {
    use custom_field_values::Column as Cell;
    let cell = |column: Cell| Expr::col((custom_field_values::Entity, column));
    let test = match &filter.test {
        Test::Number(number) => Cell::ValueNumber.eq(*number),
        Test::Day(iso) => sea_orm::ExprTrait::eq(
            sea_orm::ExprTrait::cast_as(cell(Cell::ValueDate), "date"),
            sea_orm::ExprTrait::cast_as(
                sea_orm::ExprTrait::cast_as(Expr::val(iso.as_str()), "timestamp"),
                "date",
            ),
        ),
        Test::Flag(flag) => Cell::ValueBool.eq(*flag),
        Test::Contains(json) => PgExpr::contains(
            cell(Cell::ValueJson),
            sea_orm::ExprTrait::cast_as(Expr::val(json.as_str()), "jsonb"),
        ),
        Test::Ref(id) => Cell::ValueRef.eq(id.as_str()),
        Test::Like(pattern) => Cell::ValueText.ilike(pattern.as_str()),
    };
    let mut value = value_of(entity_key, &filter.field_id);
    value.expr(Expr::val(1)).and_where(test);
    Expr::exists(value)
}

/// `(select v.<column> from custom_field_values v where …)`: the sort
/// field's value of the listed record, for `order by`.
fn sort_value(entity_key: &str, kind: &str, field_id: &str) -> Option<Expr> {
    use custom_field_values::Column as Cell;
    let column = match kind {
        "text" => Cell::ValueText,
        "number" => Cell::ValueNumber,
        "date" => Cell::ValueDate,
        "bool" => Cell::ValueBool,
        "json" => Cell::ValueJson,
        "ref" => Cell::ValueRef,
        _ => return None,
    };
    let mut value = value_of(entity_key, field_id);
    value.column((custom_field_values::Entity, column));
    Some(Expr::SubQuery(
        None,
        Box::new(SubQueryStatement::SelectStatement(value)),
    ))
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
        .map(json_row)
        .collect::<Result<_, _>>()?;
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

impl PageQuery<'_> {
    /// The WHERE clause of the list and its count: the object's live
    /// records, the owner, the title search, and every custom-field filter.
    fn condition(&self) -> Condition {
        let mut condition = Condition::all()
            .add(records::Column::EntityKey.eq(self.entity_key))
            .add(records::Column::DeletedAt.is_null());
        if let Some(owner) = self.owner {
            condition = condition.add(records::Column::OwnerId.eq(owner));
        }
        if let Some(search) = self.search {
            condition = condition.add(records::Column::Title.ilike(search));
        }
        for filter in &self.filters.0 {
            condition = condition.add(matches(self.entity_key, filter));
        }
        condition
    }

    /// The list's order: a custom field's value (`customFieldOrderBy`,
    /// `nulls last` either way) or a built-in column (Postgres's default
    /// null order, as Drizzle's `asc(col)` / `desc(col)`), then the id.
    fn order(&self, query: Select<records::Entity>) -> Select<records::Entity> {
        let order = if self.ascending {
            Order::Asc
        } else {
            Order::Desc
        };
        let custom = self
            .sort_field
            .and_then(|field_id| sort_value(self.entity_key, self.sort_kind, field_id));
        let query = match (self.sort_kind, custom) {
            ("title", _) => query.order_by(records::Column::Title, order),
            ("updated", _) => query.order_by(records::Column::UpdatedAt, order),
            ("created", _) => query.order_by(records::Column::CreatedAt, order),
            (_, Some(value)) => query.order_by_with_nulls(value, order, NullOrdering::Last),
            (_, None) => query,
        };
        query.order_by_desc(records::Column::Id)
    }
}

/// The page's rows (up to `limit + 1`, to tell whether there is more) and
/// the total count.
async fn fetch_page(db: &PgPool, q: &PageQuery<'_>) -> Result<(Vec<records::Model>, i64), DbErr> {
    let db = &orm(db);
    let rows = q
        .order(records::Entity::find().filter(q.condition()))
        .limit(u64::try_from(q.limit + 1).unwrap_or(0))
        .offset(u64::try_from(q.offset).unwrap_or(0))
        .all(db)
        .await?;
    let total = records::Entity::find()
        .filter(q.condition())
        .count(db)
        .await?;
    Ok((rows, i64::try_from(total).unwrap_or(i64::MAX)))
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

/// `createRecord` as the caller.
async fn create_record(
    caller: &Caller,
    object: &CustomObject,
    definitions: &[Definition],
    fields: Vec<(String, Js)>,
    owner_id: Option<&str>,
) -> Result<Value, ValuesError> {
    create_record_as(
        &caller.db,
        &caller.user_id,
        object,
        definitions,
        fields,
        owner_id,
    )
    .await
}

/// `createRecord(db, object, { fields, ownerId }, userId)`: the record with
/// its fields. The shell goes in first, so the values have a parent, and is
/// deleted by hand when a value is refused (neon-http has no interactive
/// transactions). Also what the asset import creates a device's record with.
pub(crate) async fn create_record_as(
    db: &PgPool,
    user_id: &str,
    object: &CustomObject,
    definitions: &[Definition],
    fields: Vec<(String, Js)>,
    owner_id: Option<&str>,
) -> Result<Value, ValuesError> {
    let id = generate_id("cor");
    let now = utc_now();
    let conn = &orm(db);
    records::Entity::insert(records::ActiveModel {
        id: Set(id.clone()),
        object_id: Set(object.id.clone()),
        entity_key: Set(object.entity_key.clone()),
        title: Set(None),
        owner_id: Set(Some(owner_id.unwrap_or(user_id).to_owned())),
        created_by: Set(Some(user_id.to_owned())),
        updated_by: Set(Some(user_id.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(conn)
    .await?;
    if let Err(error) = set_values(
        db,
        &object.entity_key,
        &id,
        &fields,
        definitions,
        false,
        true,
    )
    .await
    {
        records::Entity::delete_by_id(id.as_str())
            .exec(conn)
            .await?;
        return Err(error);
    }
    let lookup = |slug: &str| {
        fields
            .iter()
            .find(|(key, _)| key == slug)
            .map(|(_, value)| value.clone())
    };
    let title = resolve_title(object.title_field_id.as_deref(), definitions, lookup);
    records::Entity::update_many()
        .col_expr(records::Column::Title, Expr::value(title))
        .filter(records::Column::Id.eq(&id))
        .exec(conn)
        .await?;
    let mut record = record_row(conn, &id).await?;
    record["fields"] = Js::Object(fields).to_value();
    Ok(record)
}

/// The record with this id as Drizzle returns it (`{}` when it is gone).
async fn record_row(db: &sea_orm::DatabaseConnection, id: &str) -> Result<Value, DbErr> {
    let record = records::Entity::find_by_id(id).one(db).await?;
    record.map_or_else(|| Ok(json!({})), json_row)
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
        let definitions = definitions(&caller.db, &object.entity_key).await?;
        let fields = input.fields.unwrap_or_default();
        let owner = input.owner_id.as_set().map(String::as_str);
        let record = create_record(&caller, object, &definitions, fields, owner)
            .await
            .map_err(values_refusal)?;
        let id = record["id"].as_str().unwrap_or_default().to_owned();
        emit(
            &state,
            &caller,
            object,
            "created",
            &id,
            record.clone(),
            None,
        );
        Ok(Created(record).into_response())
    }
    .await;
    answer(
        result,
        &format!("Failed to create {}", object.label_singular.to_lowercase()),
    )
}

// ── POST /:slug/records/import ─────────────────────────────────────────────

/// `importCustomObjectRecordsSchema`: 1 to 200 rows, each a create body:
/// the owners as validated, each row's `fields` from the body in its own
/// key order, as the create route reads them.
fn import_rows(headers: &HeaderMap, body: &Bytes) -> Result<Vec<RecordInput>, Rejected> {
    let owners = validate(headers, body, |issues, fields| {
        issues
            .list(
                fields,
                "rows",
                Presence::Required,
                Some(1),
                Some(200),
                |issues, item| {
                    let row = issues.object(item)?;
                    issues.nested(row, "fields", Presence::Optional, |_, _| ());
                    Some(issues.text(row, "ownerId", Presence::Nullish, None, Some(255)))
                },
            )
            .into_option()
            .unwrap_or_default()
    })?;
    let rows = match parse_body(body).get("rows") {
        Some(Js::Array(rows)) => rows.clone(),
        _ => Vec::new(),
    };
    Ok(owners
        .into_iter()
        .zip(rows)
        .map(|(owner_id, row)| RecordInput {
            fields: match row.get("fields") {
                Some(Js::Object(entries)) => Some(entries.clone()),
                _ => None,
            },
            owner_id,
        })
        .collect())
}

/// Every row created as `POST /records` creates one, in order; a row the
/// field validation refuses is reported by its 1-based position and the
/// rest go on.
async fn import(
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
    let rows = match import_rows(&headers, &body) {
        Ok(rows) => rows,
        Err(invalid) => return *invalid,
    };
    let object = &access.object;
    let fallback = format!("Failed to create {}", object.label_singular.to_lowercase());
    let result: Answer = async {
        let definitions = definitions(&caller.db, &object.entity_key).await?;
        let mut created = 0_usize;
        let mut errors = Vec::new();
        for (index, input) in rows.into_iter().enumerate() {
            let owner = input.owner_id.as_set().map(String::as_str);
            let fields = input.fields.unwrap_or_default();
            match create_record(&caller, object, &definitions, fields, owner).await {
                Ok(record) => {
                    let id = record["id"].as_str().unwrap_or_default().to_owned();
                    emit(&state, &caller, object, "created", &id, record, None);
                    created += 1;
                }
                Err(ValuesError::Invalid(message)) => {
                    errors.push(json!({ "row": index + 1, "message": message }));
                }
                Err(ValuesError::Database(error)) => {
                    tracing::error!(%error, row = index + 1, "[app-api/objects] import row failed");
                    errors.push(json!({ "row": index + 1, "message": fallback }));
                }
            }
        }
        Ok(Data(json!({ "created": created, "errors": errors })).into_response())
    }
    .await;
    answer(result, &fallback)
}

/// Hono answers `GET /:slug/records/import` with `GET /:slug/records/:id`.
async fn detail_import(caller: Caller, Path(slug): Path<String>) -> Response {
    detail(caller, Path((slug, "import".to_owned()))).await
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

/// `updateRecord(db, object, existing, { fields, ownerId }, userId)`: the
/// fields a patch names are written, then the whole value set is read back
/// (the title may hang on a field the patch left alone) and the record
/// answers with it. Also what the asset import updates a device's record
/// with.
pub(crate) async fn update_record_as(
    db: &PgPool,
    user_id: &str,
    object: &CustomObject,
    id: &str,
    fields: Option<&[(String, Js)]>,
    owner_id: &Field<String>,
) -> Result<Value, ValuesError> {
    let definitions = definitions(db, &object.entity_key).await?;
    if let Some(fields) = fields {
        set_values(
            db,
            &object.entity_key,
            id,
            fields,
            &definitions,
            true,
            false,
        )
        .await?;
    }
    let mut values = values_for(db, &object.entity_key, &[id.to_owned()], &definitions).await?;
    let fields = values.remove(id).unwrap_or_default();
    let title = resolve_title(object.title_field_id.as_deref(), &definitions, |slug| {
        fields.get(slug).map(Js::from_jsonb)
    });
    let mut update = records::Entity::update_many()
        .col_expr(records::Column::UpdatedAt, Expr::value(utc_now()))
        .col_expr(records::Column::UpdatedBy, Expr::value(user_id))
        .col_expr(records::Column::Title, Expr::value(title));
    if let (true, owner) = crate::change(owner_id) {
        update = update.col_expr(records::Column::OwnerId, Expr::value(owner));
    }
    let conn = &orm(db);
    update.filter(records::Column::Id.eq(id)).exec(conn).await?;
    let mut record = record_row(conn, id).await?;
    record["fields"] = Value::Object(fields);
    Ok(record)
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
        let record = update_record_as(
            db,
            &caller.user_id,
            object,
            &id,
            input.fields.as_deref(),
            &input.owner_id,
        )
        .await
        .map_err(values_refusal)?;
        let empty = Map::new();
        let changes = field_changes(
            existing["fields"].as_object().unwrap_or(&empty),
            record["fields"].as_object().unwrap_or(&empty),
        );
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
        delete_record(db, &object.entity_key, &id, &plan.cascaded_record_ids).await?;
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

/// Delete a record with its values and edges, and the records a `cascade`
/// link takes with it: the cascade and the delete commit together.
async fn delete_record(
    db: &PgPool,
    key: &str,
    id: &str,
    cascaded: &[String],
) -> Result<(), Refusal> {
    let now = utc_now();
    let soft_delete = || {
        records::Entity::update_many()
            .col_expr(records::Column::DeletedAt, Expr::value(now))
            .col_expr(records::Column::UpdatedAt, Expr::value(now))
    };
    let cascade = (!cascaded.is_empty()).then(|| {
        soft_delete().filter(records::Column::Id.is_in(cascaded.iter().map(String::as_str)))
    });
    let incoming = relations::Entity::delete_many()
        .filter(relations::Column::TargetEntityKey.eq(key))
        .filter(relations::Column::TargetId.eq(id));
    let record = soft_delete()
        .filter(records::Column::Id.eq(id))
        .filter(records::Column::EntityKey.eq(key));
    let values = custom_field_values::Entity::delete_many()
        .filter(custom_field_values::Column::EntityType.eq(key))
        .filter(custom_field_values::Column::EntityId.eq(id));
    let edges = relations::Entity::delete_many().filter(
        Condition::any()
            .add(
                Condition::all()
                    .add(relations::Column::SourceEntityKey.eq(key))
                    .add(relations::Column::SourceId.eq(id)),
            )
            .add(
                Condition::all()
                    .add(relations::Column::TargetEntityKey.eq(key))
                    .add(relations::Column::TargetId.eq(id)),
            ),
    );
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            if let Some(cascade) = cascade {
                cascade.exec(&tx).await?;
            }
            incoming.exec(&tx).await?;
            record.exec(&tx).await?;
            values.exec(&tx).await?;
            edges.exec(&tx).await?;
            Ok::<_, Refusal>(())
        })
    })
    .await
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test fixtures")]
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
        let ids = rows.into_iter().map(|r| r.id).collect();
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
