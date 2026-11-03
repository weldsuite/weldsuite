//! What the `/v1/<object>` routes share: the caller with its event context,
//! answers, the live-row read, the soft delete and the cursor list over a
//! generated table.

use axum::Json;
use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventType};
use weldsuite_kit::ApiError;

use crate::list::{ListQuery, clamp_limit, list_page_mapped};
use crate::session::{ApiSession, Key, database_error, internal, not_found};
use crate::table::{Table, WriteError};
use crate::zod::Parsed;

/// A handler's refusal: an error answer or a validation 400.
pub(crate) struct Fail(pub(crate) Response);

impl From<ApiError> for Fail {
    fn from(error: ApiError) -> Self {
        Self(error.into_response())
    }
}

impl From<Response> for Fail {
    fn from(response: Response) -> Self {
        Self(response)
    }
}

impl From<sqlx::Error> for Fail {
    fn from(error: sqlx::Error) -> Self {
        Self(database_error(&error).into_response())
    }
}

impl From<WriteError> for Fail {
    fn from(error: WriteError) -> Self {
        match error {
            WriteError::Database(error) => error.into(),
            WriteError::NoValues => {
                tracing::error!("external-api: an update with no values to set");
                Self(internal().into_response())
            }
            WriteError::NotADate(prop) => {
                tracing::error!(prop, "external-api: a date column got a string");
                Self(internal().into_response())
            }
        }
    }
}

impl IntoResponse for Fail {
    fn into_response(self) -> Response {
        self.0
    }
}

pub(crate) type Answer = Result<Response, Fail>;

/// `success(c, data)`.
#[allow(clippy::unnecessary_wraps, clippy::needless_pass_by_value)] // a handler's answer
pub(crate) fn ok(data: Value) -> Answer {
    Ok(Json(json!({ "data": data })).into_response())
}

/// `success(c, data, 201)`.
#[allow(clippy::unnecessary_wraps, clippy::needless_pass_by_value)]
pub(crate) fn created(data: Value) -> Answer {
    Ok((StatusCode::CREATED, Json(json!({ "data": data }))).into_response())
}

/// `noContent(c)`.
#[allow(clippy::unnecessary_wraps)]
pub(crate) fn no_content() -> Answer {
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `new Date()` as the routes write it.
pub(crate) fn now() -> String {
    weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc())
}

/// The caller: the key's session, the tenant database and the context its
/// entity events carry (`EventContext::from_ids(workspace, clerk org,
/// userId ?? keyId)`).
pub(crate) struct Caller {
    pub(crate) session: ApiSession,
    pub(crate) db: PgPool,
    pub(crate) events: EventContext,
    /// The request's master database, when it brings one (conformance
    /// builds give the test's); the state's otherwise.
    pub(crate) master: Option<PgPool>,
}

impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let key = Key::from_request_parts(parts, state).await?;
        let master = parts
            .extensions
            .get::<weldsuite_db::MasterDb>()
            .map(|master| master.0.clone());
        let events = EventContext::from_ids(
            &key.session.workspace_id,
            key.session.clerk_org_id.as_deref(),
            key.session.actor(),
        );
        Ok(Self {
            session: key.session,
            db: key.db,
            events,
            master,
        })
    }
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        publisher: &EntityEventPublisher,
        event: impl Into<EventType>,
        id: &str,
        data: Value,
    ) {
        publisher.publish(&self.events, EntityEvent::new(event, id, data));
    }

    /// The same with `changes` (`computeChanges(existing, update)`), when any.
    pub(crate) fn publish_changes(
        &self,
        publisher: &EntityEventPublisher,
        event: impl Into<EventType>,
        id: &str,
        data: Value,
        changes: Option<Map<String, Value>>,
    ) {
        let mut entity = EntityEvent::new(event, id, data);
        if let Some(changes) = changes {
            entity = entity.with_changes(changes);
        }
        publisher.publish(&self.events, entity);
    }
}

/// The live row `id`, or `error.notFound(c, label, id)`.
pub(crate) async fn live_or_404(
    db: &PgPool,
    table: &Table,
    label: &str,
    id: &str,
) -> Result<Value, Fail> {
    match table.find_live(db, id).await? {
        Some(row) => Ok(row),
        None => Err(not_found(label, id).into()),
    }
}

/// `GET /:id` of a soft-deleted table: the live row.
pub(crate) async fn get_live(db: &PgPool, table: &Table, label: &str, id: &str) -> Answer {
    ok(live_or_404(db, table, label, id).await?)
}

/// `db.update(t).set({ deletedAt: now, updatedAt: now }).where(id, live)`:
/// the removed row, if there was a live one.
pub(crate) async fn soft_delete(
    db: &PgPool,
    table: &Table,
    id: &str,
) -> Result<Option<Value>, Fail> {
    let stamp = now();
    let mut set = Map::new();
    set.insert("deletedAt".into(), json!(stamp));
    set.insert("updatedAt".into(), json!(stamp));
    Ok(table
        .patch(db, id, &set, true, &["deletedAt", "updatedAt"])
        .await?)
}

/// The cursor and limit of a parsed list query (`clampLimit`).
pub(crate) fn list_query(parsed: &Parsed) -> ListQuery {
    ListQuery {
        cursor: parsed
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_owned),
        limit: clamp_limit(parsed.get("limit").and_then(Value::as_f64)),
    }
}

/// One page of `table` (statements from `table_list_sql!`), each row as
/// Drizzle returns it.
pub(crate) async fn page(
    db: &PgPool,
    sql: (&'static str, &'static str),
    table: &'static Table,
    parsed: &Parsed,
    filters: Value,
) -> Answer {
    Ok(list_page_mapped(db, sql, &list_query(parsed), &filters, |row| table.js(row)).await?)
}

/// `%term%` for a `like` filter, when the term is not empty (`if (q.search)`).
pub(crate) fn like(parsed: &Parsed, key: &str) -> Value {
    parsed
        .text(key)
        .map_or(Value::Null, |term| json!(format!("%{term}%")))
}

/// A text filter: set when not empty (`if (q.status)`).
pub(crate) fn text(parsed: &Parsed, key: &str) -> Value {
    parsed.text(key).map_or(Value::Null, |v| json!(v))
}

/// A boolean filter: set when present (`q.flag !== undefined`).
pub(crate) fn flag(parsed: &Parsed, key: &str) -> Value {
    parsed
        .get(key)
        .filter(|v| v.is_boolean())
        .cloned()
        .unwrap_or(Value::Null)
}

/// A row's field, `null` when missing.
pub(crate) fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `row.x ?? fallback`.
pub(crate) fn field_or(row: &Value, key: &str, fallback: Value) -> Value {
    match row.get(key) {
        Some(Value::Null) | None => fallback,
        Some(value) => value.clone(),
    }
}

/// `{ id, a: row.a, b: row.b, … }` (an event's data).
pub(crate) fn pick(id: &str, row: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    for key in keys {
        out.insert((*key).to_owned(), field(row, key));
    }
    Value::Object(out)
}

/// `{ ...body, id, createdAt: now, updatedAt: now }`.
pub(crate) fn with_id(body: &Map<String, Value>, id: &str, stamp: &str) -> Map<String, Value> {
    let mut values = body.clone();
    values.insert("id".into(), json!(id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    values
}

/// `{ ...body, updatedAt: now }`.
pub(crate) fn with_updated(body: &Map<String, Value>, stamp: &str) -> Map<String, Value> {
    let mut values = body.clone();
    values.insert("updatedAt".into(), json!(stamp));
    values
}

/// The date properties of a write: the route's own timestamps and the
/// body's `Date`s.
pub(crate) fn dates<'a>(parsed: &'a Parsed, own: &[&'a str]) -> Vec<&'a str> {
    let mut out: Vec<&str> = own.to_vec();
    out.extend(parsed.dates.iter().map(String::as_str));
    out
}

/// `new Date(text)` as `toISOString()` (`None`: an invalid date, whose
/// `toISOString` throws).
pub(crate) fn js_date(text: &str) -> Option<String> {
    weldsuite_core_domain::js::js_date(text)
}

/// `new Date(value)` of a body string, for a column write: an invalid date
/// makes Drizzle's `toISOString` throw, the route's 500.
pub(crate) fn to_date(text: &str) -> Result<Value, Fail> {
    js_date(text).map(Value::String).ok_or_else(|| {
        tracing::error!("external-api: an invalid date reached a timestamp column");
        Fail(internal().into_response())
    })
}

/// `computeChanges(existing, update, ['updatedAt', 'version'])`.
pub(crate) fn changes(existing: &Value, update: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut out = Map::new();
    for (key, value) in update {
        if key == "updatedAt" || key == "version" {
            continue;
        }
        let before = existing.get(key);
        let differs = match before {
            None => true,
            Some(before) => before != value,
        };
        if differs {
            let mut change = Map::new();
            if let Some(before) = before {
                change.insert("old".into(), before.clone());
            }
            change.insert("new".into(), value.clone());
            out.insert(key.clone(), Value::Object(change));
        }
    }
    (!out.is_empty()).then_some(out)
}

/// `table_list_sql!(table, filter)`: a cursor list's statements over a
/// generated table, its rows as `row!` selects them.
macro_rules! table_list_sql {
    ($table:ident, $filter:literal) => {
        (
            concat!(
                "with cursor_row as (select date_trunc('milliseconds', created_at) as ts, id from ",
                stringify!($table),
                " where id = $1 limit 1) select ",
                $crate::tables_gen::row!($table),
                " from ",
                stringify!($table),
                " t where (",
                $filter,
                ") and (not exists (select 1 from cursor_row) or t.created_at < (select ts from cursor_row) \
                 or (t.created_at = (select ts from cursor_row) and t.id < (select id from cursor_row))) \
                 order by t.created_at desc, t.id desc limit $2"
            ),
            concat!(
                "select count(*) from ",
                stringify!($table),
                " t where (",
                $filter,
                ") and ($1::text is null or true) and ($2::bigint is null or true)"
            ),
        )
    };
}
pub(crate) use table_list_sql;
