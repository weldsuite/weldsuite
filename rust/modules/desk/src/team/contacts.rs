//! `/api/helpdesk-contacts` (`routes/helpdesk-contacts/index.ts`): the
//! helpdesk view of the shared `people` table. Permissions
//! `conversations:read|create|update`; no DELETE.
//!
//! TypeScript quirks kept: the list's `conversationCount` subquery compares
//! `hc.contact_id` with an unqualified `"id"` (Drizzle drops the table name
//! in a single-table select), which is the conversation's own id, so the
//! count does not depend on the person; and `POST /` never sets
//! `people.display_name` (NOT NULL), so it is always the route's 500.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::orm;
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::helpdesk_conversations;
use weldsuite_schema::tenant::people::{self, Column};

use crate::crud::{CursorRow, Slots, page_list, write_failed};
use crate::js::{js_limit, query_param, sql_limit};
use crate::tables::PEOPLE;
use crate::{Caller, DeskState, Refusal, now, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CONVERSATIONS_READ.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/search", get(search).route_layer(read()))
        .route("/{id}", get(detail).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([perm::CONVERSATIONS_CREATE.to_owned()])),
        )
        .route(
            "/{id}",
            patch(update).route_layer(gate.require([perm::CONVERSATIONS_UPDATE.to_owned()])),
        )
}

/// The columns the list picks, in its order.
const LIST_FIELDS: [&str; 14] = [
    "id",
    "firstName",
    "lastName",
    "fullName",
    "email",
    "directPhone",
    "mobilePhone",
    "status",
    "notes",
    "interests",
    "lastContactedAt",
    "avatarUrl",
    "createdAt",
    "updatedAt",
];

/// The columns `/search` picks.
const SEARCH_FIELDS: [&str; 9] = [
    "id",
    "firstName",
    "lastName",
    "fullName",
    "email",
    "directPhone",
    "mobilePhone",
    "status",
    "avatarUrl",
];

fn pick(row: &Value, fields: &[&str]) -> Map<String, Value> {
    fields
        .iter()
        .map(|field| ((*field).to_owned(), row[*field].clone()))
        .collect()
}

/// The cursor row's `updatedAt` (as JavaScript read it) and id.
async fn cursor_row(db: &DatabaseConnection, id: &str) -> Result<Option<CursorRow>, DbErr> {
    let row: Option<(PrimitiveDateTime, String)> = people::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(Column::UpdatedAt)
        .column(Column::Id)
        .into_tuple()
        .one(db)
        .await?;
    Ok(row.map(|(updated_at, id)| (weldsuite_db::utc_timestamp(updated_at.assume_utc()), id)))
}

/// `or(like(t.firstName, term), like(t.lastName, term), like(t.fullName,
/// term), like(t.email, term))`.
fn matches(term: &str) -> Condition {
    Condition::any()
        .add(Column::FirstName.like(term))
        .add(Column::LastName.like(term))
        .add(Column::FullName.like(term))
        .add(Column::Email.like(term))
}

/// The list's conditions the slots keep: live only, `status`, the search,
/// then the cursor (newest `updatedAt` first).
fn conditions(
    slots: &Slots,
    status: Option<&str>,
    search: Option<&str>,
    cursor: Option<&CursorRow>,
) -> Condition {
    let mut all = Condition::all();
    if !slots.skip[0] {
        all = all.add(Column::DeletedAt.is_null());
    }
    if !slots.skip[1]
        && let Some(status) = status
    {
        all = all.add(Column::Status.eq(status));
    }
    if !slots.skip[2]
        && let Some(search) = search
    {
        all = all.add(matches(search));
    }
    if !slots.skip[3]
        && let Some((at, id)) = cursor
    {
        all = all.add(
            Condition::any().add(Column::UpdatedAt.lt(*at)).add(
                Condition::all()
                    .add(Column::UpdatedAt.eq(*at))
                    .add(Column::Id.lt(id.as_str())),
            ),
        );
    }
    all
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const MESSAGE: &str = "Failed to list helpdesk contacts";
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let status = query_param(query, "status").filter(|s| !s.is_empty());
    let search = query_param(query, "search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let db = orm(&caller.db);
    let cursor = query_param(query, "cursor").filter(|c| !c.is_empty());
    // The cursor lookup runs before the route's `try`: the app's 500.
    let cursor_row = match &cursor {
        Some(cursor) => match cursor_row(&db, cursor).await {
            Ok(row) => row,
            Err(error) => {
                tracing::error!(%error, "desk: contact cursor lookup failed");
                return ApiError::internal().into_response();
            }
        },
        None => None,
    };
    let active = [
        true,
        status.is_some(),
        search.is_some(),
        cursor_row.is_some(),
    ];
    let (page, count) = Slots::page_and_count(&active, cursor.is_some());
    let (status, search) = (status.as_deref(), search.as_deref());
    let cursor_row = cursor_row.as_ref();
    let mut rows = people::Entity::find()
        .filter(conditions(&page, status, search, cursor_row))
        .order_by_desc(Column::UpdatedAt)
        .order_by_desc(Column::Id);
    if let Some(limit) = sql_limit(limit) {
        rows = rows.limit(u64::try_from(limit).unwrap_or(0));
    }
    let listed = async {
        let rows = rows.all(&db).await?;
        // The `conversationCount` subquery doesn't depend on the person (see
        // the module docs): the one count, on every row.
        let conversations = if rows.is_empty() {
            0
        } else {
            helpdesk_conversations::Entity::find()
                .filter(sea_orm::ExprTrait::eq(
                    Expr::col(helpdesk_conversations::Column::ContactId),
                    Expr::col(helpdesk_conversations::Column::Id),
                ))
                .filter(helpdesk_conversations::Column::DeletedAt.is_null())
                .count(&db)
                .await?
        };
        let total = people::Entity::find()
            .filter(conditions(&count, status, search, cursor_row))
            .count(&db)
            .await?;
        Ok::<_, DbErr>((rows, conversations, total))
    };
    let (rows, conversations, total) = match listed.await {
        Ok(listed) => listed,
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let rows = rows
        .into_iter()
        .map(|person| {
            let mut out = pick(&person_json(person), &LIST_FIELDS);
            out.insert("conversationCount".to_owned(), json!(conversations));
            Value::Object(out)
        })
        .collect();
    page_list(rows, limit, i64::try_from(total).unwrap_or(i64::MAX))
}

/// A `people` row as Drizzle's `select()` returns it.
fn person_json(person: people::Model) -> Value {
    serde_json::to_value(person).unwrap_or(Value::Null)
}

async fn search(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let Some(q) = query_param(query.as_deref(), "q").filter(|q| !q.is_empty()) else {
        return Data(json!([])).into_response();
    };
    let term = format!("%{q}%");
    let rows = people::Entity::find()
        .filter(Column::DeletedAt.is_null())
        .filter(matches(&term))
        .order_by_desc(Column::UpdatedAt)
        .limit(20)
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .map(|person| Value::Object(pick(&person_json(person), &SEARCH_FIELDS)))
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to search helpdesk contacts"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const MESSAGE: &str = "Failed to fetch helpdesk contact";
    match PEOPLE.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Helpdesk contact", &id).respond(MESSAGE),
        Err(error) => Refusal::from(error).respond(MESSAGE),
    }
}

/// `createContactSchema`, as parsed.
struct NewContact {
    name: String,
    email: String,
    phone: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    direct_phone: Option<String>,
    notes: Option<String>,
    tags: Option<Vec<String>>,
    metadata: Option<Value>,
    status: String,
}

async fn create(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to create helpdesk contact";
    let opt = Presence::Optional;
    let data = match validate(&headers, &body, |issues, fields| {
        let name = issues.text(fields, "name", Presence::Required, Some(1), Some(255));
        let email = issues.text_with(
            fields,
            "email",
            Presence::Required,
            Text {
                format: Some(Format::Email),
                ..Text::default()
            },
        );
        let phone = issues.text(fields, "phone", opt, None, None);
        let first_name = issues.text(fields, "firstName", opt, None, None);
        let last_name = issues.text(fields, "lastName", opt, None, None);
        let direct_phone = issues.text(fields, "directPhone", opt, None, None);
        let notes = issues.text(fields, "notes", opt, None, None);
        let tags = issues.list(fields, "tags", opt, None, None, |issues, item| {
            issues.item_text(item, Text::default())
        });
        let metadata = issues.nested(fields, "metadata", opt, |_, map| Value::Object(map.clone()));
        let status = issues.text(fields, "status", opt, None, None);
        NewContact {
            name: name.into_option().unwrap_or_default(),
            email: email.into_option().unwrap_or_default(),
            phone: phone.into_option(),
            first_name: first_name.into_option(),
            last_name: last_name.into_option(),
            direct_phone: direct_phone.into_option(),
            notes: notes.into_option(),
            tags: tags.into_option(),
            metadata: metadata.into_option(),
            status: status.into_option().unwrap_or_else(|| "active".to_owned()),
        }
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let id = generate_id("con");
    let now = now();
    let mut first = data.first_name.clone().unwrap_or_default();
    let mut last = data.last_name.clone().unwrap_or_default();
    if first.is_empty() && last.is_empty() && !data.name.is_empty() {
        let mut parts = data.name.split(' ');
        first = parts.next().unwrap_or_default().to_owned();
        last = parts.collect::<Vec<_>>().join(" ");
    }
    // `data.name || \`${firstName} ${lastName}\`.trim()`: the name is never empty.
    let full_name = if data.name.is_empty() {
        format!("{first} {last}").trim().to_owned()
    } else {
        data.name.clone()
    };
    let table = &PEOPLE;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(id));
    table.set(&mut values, "firstName", json!(first));
    table.set(&mut values, "lastName", json!(last));
    table.set(&mut values, "fullName", json!(full_name));
    table.set(&mut values, "email", json!(data.email));
    if let Some(phone) = data.direct_phone.as_ref().or(data.phone.as_ref()) {
        table.set(&mut values, "directPhone", json!(phone));
    }
    table.set(&mut values, "status", json!(data.status));
    if let Some(notes) = &data.notes {
        table.set(&mut values, "notes", json!(notes));
    }
    if let Some(tags) = &data.tags {
        table.set(&mut values, "interests", json!(tags));
    }
    if let Some(metadata) = &data.metadata {
        table.set(&mut values, "customFields", metadata.clone());
    }
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = table
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_CONTACT_CREATED,
        &id,
        &json!({ "id": id, "name": data.name, "email": data.email }),
    );
    Created(json!({ "id": id })).into_response()
}

/// `updateContactSchema`'s keys, in its order.
const UPDATE_KEYS: [&str; 6] = [
    "firstName",
    "lastName",
    "email",
    "phone",
    "notes",
    "avatarUrl",
];

async fn update(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update helpdesk contact";
    let opt = Presence::Optional;
    let data = match validate(&headers, &body, |issues, fields| {
        let mut data = Map::new();
        for key in UPDATE_KEYS {
            let field = if key == "email" {
                issues.text_with(
                    fields,
                    key,
                    opt,
                    Text {
                        format: Some(Format::Email),
                        ..Text::default()
                    },
                )
            } else {
                issues.text(fields, key, opt, None, None)
            };
            if let Some(value) = field.into_option() {
                data.insert(key.to_owned(), json!(value));
            }
        }
        data
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let existing = match PEOPLE.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Helpdesk contact", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let given = |key: &str| data.get(key).and_then(Value::as_str);
    let table = &PEOPLE;
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now()));
    if let Some(first) = given("firstName") {
        table.set(&mut values, "firstName", json!(first));
    }
    if let Some(last) = given("lastName") {
        table.set(&mut values, "lastName", json!(last));
    }
    if given("firstName").is_some() || given("lastName").is_some() {
        let first = given("firstName")
            .or_else(|| existing["firstName"].as_str())
            .unwrap_or_default();
        let last = given("lastName")
            .or_else(|| existing["lastName"].as_str())
            .unwrap_or_default();
        table.set(
            &mut values,
            "fullName",
            json!(format!("{first} {last}").trim()),
        );
    }
    if let Some(email) = given("email") {
        table.set(&mut values, "email", json!(email));
    }
    if let Some(phone) = given("phone") {
        table.set(&mut values, "directPhone", json!(phone));
    }
    if let Some(notes) = given("notes") {
        table.set(&mut values, "notes", json!(notes));
    }
    if let Some(avatar) = given("avatarUrl") {
        table.set(&mut values, "avatarUrl", json!(avatar));
    }
    if let Err(error) = table
        .patch(&caller.db, &id, values, true, &["updatedAt"])
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.extend(data);
    caller.publish(
        &state,
        ev::HELPDESK_CONTACT_UPDATED,
        &id,
        &Value::Object(event),
    );
    Data(json!({ "id": id })).into_response()
}
