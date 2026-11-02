//! `/api/tickets` (`routes/tickets/index.ts`): the flat ticket surface over
//! `helpdesk_tickets`, with typed custom field values, the agent reply and
//! the tag merge. Permissions `tickets:read|create|update|delete`.

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
use weldsuite_db::PgPool;
use weldsuite_desk_domain::notify::EntityKind;
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id, random_string};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::{Filter, Listing, fetch, page_of, soft_delete, write_failed};
use crate::custom_fields::{definitions_for_ticket, hydrate_tickets, sync_ticket};
use crate::js::text;
use crate::link::{Link, link_conversation_to_ticket};
use crate::notify::{Assigned, assigned};
use crate::tables::{HELPDESK_TICKET_MESSAGES, HELPDESK_TICKETS};
use crate::{Caller, DeskState, Refusal, now, validate};

const TICKET_LIST: (&str, &str) = listing!("helpdesk_tickets";
    "($2::boolean or t.status = $3::text)",
    "($4::boolean or t.priority = $5::text)",
    "($6::boolean or t.assignee_id = $7::text)",
    "($8::boolean or t.department_id = $9::text)",
    "($10::boolean or t.contact_id = $11::text)",
    "($12::boolean or t.channel = $13::text)",
    "($14::boolean or t.category = $15::text)",
    "($16::boolean or t.ticket_type_id = $17::text)",
    "($18::boolean or (t.subject like $19::text or t.customer_email like $19::text or t.customer_name like $19::text or t.ticket_number like $19::text))";
    20, 21, 22; "$23");

const LISTING: Listing = Listing {
    table: &HELPDESK_TICKETS,
    filters: &[
        Filter::eq("status"),
        Filter::eq("priority"),
        Filter::eq("assigneeId"),
        Filter::eq("departmentId"),
        Filter::eq("contactId"),
        Filter::eq("channel"),
        Filter::eq("category"),
        Filter::eq("ticketTypeId"),
        Filter::like("search"),
    ],
    list_sql: TICKET_LIST.0,
    count_sql: TICKET_LIST.1,
    slice_count: true,
};

const STATUSES: &[&str] = &[
    "new",
    "open",
    "pending",
    "on_hold",
    "in_progress",
    "resolved",
    "closed",
    "cancelled",
];
const PRIORITIES: &[&str] = &["low", "medium", "high", "urgent", "critical"];

/// The routes, each with its `requirePermission`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need(perm::TICKETS_READ)))
        .route("/", post(create).route_layer(need(perm::TICKETS_CREATE)))
        .route("/{id}", get(detail).route_layer(need(perm::TICKETS_READ)))
        .route(
            "/{id}",
            patch(update).route_layer(need(perm::TICKETS_UPDATE)),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need(perm::TICKETS_DELETE)),
        )
        .route(
            "/{id}/tags",
            patch(add_tags).route_layer(need(perm::TICKETS_UPDATE)),
        )
        .route(
            "/{id}/messages",
            post(reply).route_layer(need(perm::TICKETS_UPDATE)),
        )
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const MESSAGE: &str = "Failed to list tickets";
    let fetched = match fetch(LISTING, &caller.db, query.as_deref()).await {
        Ok(fetched) => fetched,
        Err(error) => return error.respond(MESSAGE),
    };
    let (data, has_more, cursor) = page_of(fetched.rows, fetched.limit, |row| text(row, "id"));
    match hydrate_tickets(&caller.db, data).await {
        Ok(data) => weldsuite_kit::List::new(
            data,
            weldsuite_kit::Pagination::new(
                u64::try_from(fetched.total).unwrap_or(0),
                has_more,
                cursor,
            ),
        )
        .into_response(),
        Err(error) => Refusal::Database(error).respond(MESSAGE),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const MESSAGE: &str = "Failed to fetch ticket";
    let row = match HELPDESK_TICKETS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Ticket", &id).respond(MESSAGE),
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    match hydrate_tickets(&caller.db, vec![row]).await {
        Ok(mut rows) => Data(rows.remove(0)).into_response(),
        Err(error) => Refusal::Database(error).respond(MESSAGE),
    }
}

/// `createTicketSchema` (`@weldsuite/app-api-client/schemas/tickets`),
/// widened as the route does: `priority` also takes `normal`, and on create
/// `customerName` may be empty, `conversationId` and `source` are read.
fn ticket_schema(issues: &mut Issues, body: &Map<String, Value>, partial: bool) {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let opt = Presence::Optional;
    let nullish = Presence::Nullish;
    let text = |issues: &mut Issues,
                key: &str,
                presence: Presence,
                min: Option<usize>,
                max: Option<usize>| {
        issues.text(body, key, presence, min, max);
    };
    text(issues, "ticketNumber", opt, None, Some(50));
    text(issues, "reference", opt, None, Some(100));
    text(issues, "contactId", nullish, None, None);
    if partial {
        text(issues, "customerName", opt, Some(1), Some(255));
    } else {
        text(issues, "customerName", opt, None, Some(255));
    }
    issues.text_with(
        body,
        "customerEmail",
        required,
        Text {
            format: Some(Format::Email),
            max: Some(255),
            ..Text::default()
        },
    );
    text(issues, "customerPhone", opt, None, Some(50));
    text(issues, "customerCompany", opt, None, Some(255));
    text(issues, "subject", required, Some(1), Some(500));
    text(issues, "description", opt, None, None);
    text(issues, "category", opt, None, Some(50));
    text(issues, "subcategory", opt, None, Some(100));
    issues.choice(body, "status", opt, STATUSES);
    issues.enum_or_literal(body, "priority", opt, PRIORITIES, "normal");
    text(issues, "severity", opt, None, Some(20));
    text(issues, "assigneeId", nullish, None, None);
    text(issues, "assigneeName", opt, None, Some(255));
    text(issues, "departmentId", nullish, None, None);
    text(issues, "teamId", nullish, None, None);
    text(issues, "channel", opt, None, Some(20));
    text(issues, "sourceEmail", opt, None, Some(255));
    text(issues, "sourceUrl", opt, None, Some(500));
    text(issues, "type", opt, None, Some(30));
    text(issues, "ticketTypeId", nullish, None, None);
    text(issues, "issueType", opt, None, Some(50));
    text(issues, "slaId", nullish, None, None);
    text(issues, "productId", nullish, None, None);
    text(issues, "productName", opt, None, Some(255));
    issues.list(body, "tags", opt, None, None, |issues, item| {
        issues.item_text(item, Text::default())
    });
    text(issues, "parentTicketId", nullish, None, None);
    issues.boolean(body, "isPublic", opt);
    if !partial {
        text(issues, "conversationId", opt, None, None);
        text(issues, "source", opt, None, Some(20));
    }
}

/// The keys `createTicketSchema` keeps (Zod strips the rest).
const CREATE_KEYS: &[&str] = &[
    "ticketNumber",
    "reference",
    "contactId",
    "customerName",
    "customerEmail",
    "customerPhone",
    "customerCompany",
    "subject",
    "description",
    "category",
    "subcategory",
    "status",
    "priority",
    "severity",
    "assigneeId",
    "assigneeName",
    "departmentId",
    "teamId",
    "channel",
    "sourceEmail",
    "sourceUrl",
    "type",
    "ticketTypeId",
    "issueType",
    "slaId",
    "productId",
    "productName",
    "tags",
    "customFields",
    "parentTicketId",
    "isPublic",
    "metadata",
];

/// The body as the schema let it through: the schema's keys only.
fn read(headers: &HeaderMap, body: &Bytes, partial: bool) -> Result<Map<String, Value>, Refusal> {
    validate(headers, body, |issues, fields| {
        ticket_schema(issues, fields, partial);
        let mut keys: Vec<&str> = CREATE_KEYS.to_vec();
        if !partial {
            keys.extend(["conversationId", "source"]);
        }
        fields
            .iter()
            .filter(|(key, _)| keys.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    })
}

/// `TKT-<Date.now() in base 36, upper case>-<4 random base-36 capitals>`.
fn generated_ticket_number() -> String {
    format!(
        "TKT-{}-{}",
        base36_now(),
        random_string(4, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    )
}

/// `Date.now().toString(36).toUpperCase()`.
pub(crate) fn base36_now() -> String {
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let mut rest = u128::try_from(millis).unwrap_or_default();
    let mut digits = Vec::new();
    while rest > 0 {
        let digit = u32::try_from(rest % 36).unwrap_or_default();
        digits.push(
            char::from_digit(digit, 36)
                .unwrap_or('0')
                .to_ascii_uppercase(),
        );
        rest /= 36;
    }
    digits.iter().rev().collect()
}

/// `resolveContactId`: the caller's `contactId`, else the live person with
/// the customer's email; a failed lookup leaves the ticket unlinked.
async fn resolve_contact(
    db: &PgPool,
    provided: Option<&str>,
    email: Option<&str>,
) -> Option<String> {
    if let Some(provided) = provided.filter(|p| !p.is_empty()) {
        return Some(provided.to_owned());
    }
    let email = email.filter(|e| !e.is_empty())?;
    let found: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("select id from people where email = $1 and deleted_at is null limit 1")
            .bind(email)
            .fetch_optional(db)
            .await;
    found.unwrap_or_else(|error| {
        tracing::error!(%error, "[app-api/tickets] contact auto-resolve failed");
        None
    })
}

/// A field of the body, when it is there (`data.x` not `undefined`).
fn field(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key).cloned()
}

#[allow(clippy::too_many_lines)] // the route is one long handler in TypeScript too
async fn create(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to create ticket";
    let mut data = match read(&headers, &body, false) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let conversation_id = data.remove("conversationId");
    let source = data.remove("source");
    let id = generate_id("tkt");
    let now = now();
    let ticket_number = match data.get("ticketNumber") {
        Some(Value::String(number)) if !number.is_empty() => number.clone(),
        _ => generated_ticket_number(),
    };
    let customer_name = match data.get("customerName") {
        Some(Value::String(name)) if !weldsuite_kit::validation::js_trim(name).is_empty() => {
            name.clone()
        }
        _ => {
            let email = text(&Value::Object(data.clone()), "customerEmail")
                .unwrap_or_default()
                .to_owned();
            let local = email.split('@').next().unwrap_or_default().to_owned();
            if local.is_empty() {
                "Customer".to_owned()
            } else {
                local
            }
        }
    };
    // `data.channel ?? source ?? 'web'`.
    let channel = data
        .get("channel")
        .filter(|v| !v.is_null())
        .cloned()
        .or_else(|| source.clone().filter(|v| !v.is_null()))
        .unwrap_or_else(|| json!("web"));
    let as_value = Value::Object(data.clone());
    let contact_id = resolve_contact(
        &caller.db,
        text(&as_value, "contactId"),
        text(&as_value, "customerEmail"),
    )
    .await;

    let table = &HELPDESK_TICKETS;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(id));
    values.extend(table.values(&data));
    table.set(&mut values, "ticketNumber", json!(ticket_number));
    table.set(&mut values, "customerName", json!(customer_name));
    table.set(&mut values, "channel", channel);
    table.set(&mut values, "contactId", json!(contact_id));
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = table
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    let definitions =
        match definitions_for_ticket(&caller.db, text(&as_value, "ticketTypeId")).await {
            Ok(definitions) => definitions,
            Err(error) => return Refusal::Database(error).respond(MESSAGE),
        };
    sync_ticket(
        &caller.db,
        &id,
        data.get("customFields"),
        &definitions,
        &now,
    )
    .await;

    let subject = text(&as_value, "subject").unwrap_or_default().to_owned();
    if let Some(conversation_id) = conversation_id
        .as_ref()
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
    {
        let link = Link {
            conversation_id,
            ticket_id: &id,
            ticket_number: &ticket_number,
            subject: &subject,
            priority: text(&as_value, "priority"),
            customer_name: &customer_name,
            customer_email: text(&as_value, "customerEmail").unwrap_or_default(),
            contact_id: contact_id.as_deref(),
            now: &now,
        };
        link_conversation_to_ticket(&state, &caller.db, &link).await;
    }

    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert("ticketNumber".to_owned(), json!(ticket_number));
    for key in ["subject", "status", "priority", "assigneeId"] {
        if let Some(value) = field(&data, key) {
            event.insert(key.to_owned(), value);
        }
    }
    event.insert("contactId".to_owned(), json!(contact_id));
    if let Some(value) = field(&data, "departmentId") {
        event.insert("departmentId".to_owned(), value);
    }
    caller.publish(&state, ev::TICKET_CREATED, &id, &Value::Object(event));
    assigned(
        &state,
        &caller,
        Assigned {
            assignee_id: text(&as_value, "assigneeId").map(str::to_owned),
            previous: None,
            kind: EntityKind::Ticket,
            entity_id: id.clone(),
            subject: Some(subject.clone()),
            reference: Some(ticket_number.clone()),
            by: Some(caller.user_id.clone()),
        },
    );
    let mut answer = Map::new();
    answer.insert("id".to_owned(), json!(id));
    answer.insert("ticketNumber".to_owned(), json!(ticket_number));
    answer.insert("subject".to_owned(), json!(subject));
    answer.insert(
        "status".to_owned(),
        data.get("status")
            .filter(|s| !s.is_null())
            .cloned()
            .unwrap_or_else(|| json!("new")),
    );
    if let Some(priority) = field(&data, "priority") {
        answer.insert("priority".to_owned(), priority);
    }
    answer.insert("createdAt".to_owned(), json!(now));
    Created(Value::Object(answer)).into_response()
}

/// `(update.f as T | null | undefined) ?? existing.f`.
fn or_existing(data: &Map<String, Value>, existing: &Value, key: &str) -> Value {
    data.get(key)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| existing[key].clone())
}

async fn update(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update ticket";
    let data = match read(&headers, &body, true) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let existing = match HELPDESK_TICKETS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Ticket", &id).respond(MESSAGE),
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let now = now();
    let table = &HELPDESK_TICKETS;
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now));
    values.extend(table.values(&data));
    if let Err(error) = table
        .patch(&caller.db, &id, values, true, &["updatedAt"])
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    let type_id = or_existing(&data, &existing, "ticketTypeId");
    let definitions = match definitions_for_ticket(&caller.db, type_id.as_str()).await {
        Ok(definitions) => definitions,
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    sync_ticket(
        &caller.db,
        &id,
        data.get("customFields"),
        &definitions,
        &now,
    )
    .await;
    let subject = or_existing(&data, &existing, "subject");
    let event = json!({
        "id": id,
        "ticketNumber": existing["ticketNumber"],
        "subject": subject,
        "status": or_existing(&data, &existing, "status"),
        "priority": or_existing(&data, &existing, "priority"),
        "assigneeId": or_existing(&data, &existing, "assigneeId"),
        "contactId": existing["contactId"],
        "departmentId": or_existing(&data, &existing, "departmentId"),
    });
    caller.publish(&state, ev::TICKET_UPDATED, &id, &event);
    assigned(
        &state,
        &caller,
        Assigned {
            assignee_id: text(&Value::Object(data.clone()), "assigneeId").map(str::to_owned),
            previous: text(&existing, "assigneeId").map(str::to_owned),
            kind: EntityKind::Ticket,
            entity_id: id.clone(),
            subject: subject.as_str().map(str::to_owned),
            reference: text(&existing, "ticketNumber").map(str::to_owned),
            by: Some(caller.user_id.clone()),
        },
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const MESSAGE: &str = "Failed to delete ticket";
    let existing = match HELPDESK_TICKETS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Ticket", &id).respond(MESSAGE),
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    if let Err(error) = soft_delete(&caller.db, &HELPDESK_TICKETS, &id).await {
        return write_failed(&error, MESSAGE);
    }
    let event = json!({
        "id": id,
        "ticketNumber": existing["ticketNumber"],
        "subject": existing["subject"],
        "status": existing["status"],
    });
    caller.publish(&state, ev::TICKET_DELETED, &id, &event);
    NoContent.into_response()
}

async fn add_tags(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to add tags";
    let tags = match validate(&headers, &body, |issues, fields| {
        issues
            .list(
                fields,
                "tags",
                Presence::Required,
                None,
                None,
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(tags) => tags,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let existing: Option<Option<Value>> = match sqlx::query_scalar(
        "select tags from helpdesk_tickets where id = $1 and deleted_at is null limit 1",
    )
    .bind(&id)
    .fetch_optional(&caller.db)
    .await
    {
        Ok(row) => row,
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let Some(existing) = existing else {
        return Refusal::not_found("Ticket", &id).respond(MESSAGE);
    };
    // `[...new Set([...(existing.tags || []), ...tags])]`.
    let mut merged: Vec<Value> = Vec::new();
    let current = match existing {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    for tag in current
        .into_iter()
        .chain(tags.into_iter().map(Value::String))
    {
        if !merged.contains(&tag) {
            merged.push(tag);
        }
    }
    let result = sqlx::query(
        "update helpdesk_tickets set tags = $2, updated_at = $3::timestamp where id = $1 and deleted_at is null",
    )
    .bind(&id)
    .bind(Value::Array(merged.clone()))
    .bind(now())
    .execute(&caller.db)
    .await;
    if let Err(error) = result {
        return Refusal::Database(error).respond(MESSAGE);
    }
    caller.publish(&state, ev::TICKET_UPDATED, &id, &json!({ "id": id }));
    Data(json!({ "id": id, "tags": merged })).into_response()
}

/// A roster row's name and email.
type NameAndEmail = (Option<String>, Option<String>);

/// `resolveAgentIdentity`: the replying agent's roster name and email,
/// `'Agent'` / `''` without one (or when the lookup fails).
async fn agent_identity(db: &PgPool, user_id: &str) -> (String, String) {
    let row: Result<Option<NameAndEmail>, sqlx::Error> = sqlx::query_as(
        "select name, email from helpdesk_agents where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await;
    match row {
        Ok(row) => {
            let (name, email) = row.unwrap_or_default();
            (
                name.filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "Agent".to_owned()),
                email.filter(|e| !e.is_empty()).unwrap_or_default(),
            )
        }
        Err(error) => {
            tracing::error!(%error, "[app-api/tickets] agent identity lookup failed");
            ("Agent".to_owned(), String::new())
        }
    }
}

async fn reply(
    State(state): State<DeskState>,
    caller: Caller,
    Path(ticket_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to add message";
    let (content, html, internal) = match validate(&headers, &body, |issues, fields| {
        let content = issues.text(fields, "content", Presence::Required, Some(1), None);
        let html = issues.text(fields, "contentHtml", Presence::Optional, None, None);
        let internal = issues.boolean(fields, "isInternal", Presence::Optional);
        (
            content.into_option().unwrap_or_default(),
            html.into_option(),
            internal.into_option().unwrap_or(false),
        )
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let found: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        "select id from helpdesk_tickets where id = $1 and deleted_at is null limit 1",
    )
    .bind(&ticket_id)
    .fetch_optional(&caller.db)
    .await;
    match found {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Ticket", &ticket_id).respond(MESSAGE),
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    }
    let (author_name, author_email) = agent_identity(&caller.db, &caller.user_id).await;
    let id = generate_id("tkm");
    let now = now();
    let table = &HELPDESK_TICKET_MESSAGES;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(id));
    table.set(&mut values, "ticketId", json!(ticket_id));
    table.set(&mut values, "body", json!(content));
    if let Some(html) = html {
        table.set(&mut values, "htmlBody", json!(html));
    }
    table.set(&mut values, "authorType", json!("agent"));
    table.set(&mut values, "authorId", json!(caller.user_id));
    table.set(&mut values, "authorName", json!(author_name));
    table.set(&mut values, "authorEmail", json!(author_email));
    table.set(
        &mut values,
        "type",
        json!(if internal { "note" } else { "reply" }),
    );
    table.set(&mut values, "isPublic", json!(!internal));
    table.set(&mut values, "isInternal", json!(internal));
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    let message = match table
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        Ok(message) => message,
        Err(error) => return write_failed(&error, MESSAGE),
    };
    let touched =
        sqlx::query("update helpdesk_tickets set updated_at = $2::timestamp where id = $1")
            .bind(&ticket_id)
            .bind(&now)
            .execute(&caller.db)
            .await;
    if let Err(error) = touched {
        return Refusal::Database(error).respond(MESSAGE);
    }
    let event = json!({
        "id": id,
        "ticketId": ticket_id,
        "authorId": caller.user_id,
        "subject": message["subject"],
    });
    caller.publish(&state, ev::HELPDESK_MESSAGE_CREATED, &id, &event);
    Created(message).into_response()
}
