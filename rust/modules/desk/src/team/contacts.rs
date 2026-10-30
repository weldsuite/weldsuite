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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::{Slots, page_list, write_failed};
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

/// `$1` live-only skip, `($2, $3)` status, `($4, $5)` search, the cursor
/// `($6, $7 updatedAt, $8 id)`, `$9` the limit.
const LIST: &str = "select to_jsonb(t), coalesce((
        select count(*)::int from helpdesk_conversations hc
        where hc.contact_id = hc.id and hc.deleted_at is null
    ), 0)
    from people t
    where ($1::boolean or t.deleted_at is null)
      and ($2::boolean or t.status = $3::text)
      and ($4::boolean or (t.first_name like $5::text or t.last_name like $5::text
           or t.full_name like $5::text or t.email like $5::text))
      and ($6::boolean or (t.updated_at < $7::timestamp
           or (t.updated_at = $7::timestamp and t.id < $8::text)))
    order by t.updated_at desc, t.id desc limit $9";

const COUNT: &str = "select count(*) from people t
    where ($1::boolean or t.deleted_at is null)
      and ($2::boolean or t.status = $3::text)
      and ($4::boolean or (t.first_name like $5::text or t.last_name like $5::text
           or t.full_name like $5::text or t.email like $5::text))
      and ($6::boolean or (t.updated_at < $7::timestamp
           or (t.updated_at = $7::timestamp and t.id < $8::text)))";

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
async fn cursor_row(
    db: &weldsuite_db::PgPool,
    id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as("select to_jsonb(updated_at)#>>'{}', id from people where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.and_then(|(stamp, id)| {
        stamp
            .and_then(|stamp| weldsuite_db::js_timestamp(&stamp))
            .map(|stamp| (stamp, id))
    }))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const MESSAGE: &str = "Failed to list helpdesk contacts";
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let status = query_param(query, "status").filter(|s| !s.is_empty());
    let search = query_param(query, "search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let cursor = query_param(query, "cursor").filter(|c| !c.is_empty());
    // The cursor lookup runs before the route's `try`: the app's 500.
    let cursor_row = match &cursor {
        Some(cursor) => match cursor_row(&caller.db, cursor).await {
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
    let (stamp, id) = match &cursor_row {
        Some((stamp, id)) => (Some(stamp.as_str()), Some(id.as_str())),
        None => (None, None),
    };
    let rows: Result<Vec<(Value, i32)>, _> = sqlx::query_as(LIST)
        .bind(page.skip[0])
        .bind(page.skip[1])
        .bind(status.as_deref())
        .bind(page.skip[2])
        .bind(search.as_deref())
        .bind(page.skip[3])
        .bind(stamp)
        .bind(id)
        .bind(sql_limit(limit))
        .fetch_all(&caller.db)
        .await;
    let total: Result<i64, _> = sqlx::query_scalar(COUNT)
        .bind(count.skip[0])
        .bind(count.skip[1])
        .bind(status.as_deref())
        .bind(count.skip[2])
        .bind(search.as_deref())
        .bind(count.skip[3])
        .bind(stamp)
        .bind(id)
        .fetch_one(&caller.db)
        .await;
    let (rows, total) = match (rows, total) {
        (Ok(rows), Ok(total)) => (rows, total),
        (Err(error), _) | (_, Err(error)) => return Refusal::Database(error).respond(MESSAGE),
    };
    let rows = rows
        .into_iter()
        .map(|(row, conversations)| {
            let mut out = pick(&PEOPLE.js(row), &LIST_FIELDS);
            out.insert("conversationCount".to_owned(), json!(conversations));
            Value::Object(out)
        })
        .collect();
    page_list(rows, limit, total)
}

async fn search(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let Some(q) = query_param(query.as_deref(), "q").filter(|q| !q.is_empty()) else {
        return Data(json!([])).into_response();
    };
    let term = format!("%{q}%");
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from people t
         where t.deleted_at is null
           and (t.first_name like $1 or t.last_name like $1 or t.full_name like $1 or t.email like $1)
         order by t.updated_at desc limit 20",
    )
    .bind(&term)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .map(|row| Value::Object(pick(&PEOPLE.js(row), &SEARCH_FIELDS)))
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to search helpdesk contacts"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const MESSAGE: &str = "Failed to fetch helpdesk contact";
    match PEOPLE.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Helpdesk contact", &id).respond(MESSAGE),
        Err(error) => Refusal::Database(error).respond(MESSAGE),
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
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
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
