//! WeldDesk's inbox through the public API: `/v1/conversations`
//! (`routes/v1/conversations/index.ts`, the live inbox agents work in) and
//! `/v1/tickets` (`routes/v1/tickets/index.ts`): reads of the old
//! `helpdesk_tickets` rows for the published app SDK, and `POST`, which opens
//! an inbox conversation. Every inbox write goes through
//! `weldsuite_desk_domain::inbox`, which also assigns, notifies the team and
//! emits the entity events.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::HeaderValue;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{HELPDESK_MESSAGE_CREATED, TICKET_DELETED, TICKET_UPDATED};
use weldsuite_core_domain::custom_field_values::{self as values, Definition};
use weldsuite_core_domain::js::Js;
use weldsuite_db::PgPool;
use weldsuite_desk_domain::assignment::Picker;
use weldsuite_desk_domain::attributes::Update;
use weldsuite_desk_domain::inbox::{
    self, Actor, InboxDeps, InboxEmitter, InboxError, InboxEvent, IngestApi, OpenConversation,
    UpdateConversation,
};
use weldsuite_desk_domain::list::{self, ListQuery};
use weldsuite_events::{EntityEvent, EventType};
use weldsuite_kit::id::generate_id;
use weldsuite_kit::validation::Field;
use weldsuite_notifications::Notifier;
use weldsuite_ports::BoxFuture;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, Fail, created, dates, field, like, list_query, no_content, now, ok, page,
    soft_delete, table_list_sql, text, with_id, with_updated,
};
use crate::schemas::LIST_TICKET_MESSAGES;
use crate::schemas_gen::{
    ADD_CONVERSATION_MESSAGE, CREATE_TICKET_MESSAGE, GET_CONVERSATION_QUERY,
    LIST_CONVERSATION_MESSAGES, LIST_CONVERSATIONS, LIST_TICKETS, OPEN_CONVERSATION, OPEN_TICKET,
    UPDATE_CONVERSATION, UPDATE_TICKET,
};
use crate::session::{bad_request, conflict, internal, not_found};
use crate::simple::scoped;
use crate::tables_gen::{HELPDESK_TICKET_MESSAGES, HELPDESK_TICKETS};
use crate::zod;

type S = State<ExternalApiState>;

/// The inbox's and the tickets' routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    // helpdesk_tickets has no screen: agents work the inbox. Every answer
    // under /v1/tickets says so.
    let tickets = Router::new()
        .route(
            "/tickets",
            scoped(get(list_tickets), "tickets:read")
                .merge(scoped(post(open_ticket), "tickets:write")),
        )
        .route(
            "/tickets/{id}",
            scoped(get(get_ticket), "tickets:read").merge(scoped(
                patch(update_ticket).delete(delete_ticket),
                "tickets:write",
            )),
        )
        .route(
            "/tickets/{id}/messages",
            scoped(get(list_ticket_messages), "tickets:read")
                .merge(scoped(post(create_ticket_message), "tickets:write")),
        )
        .layer(axum::middleware::map_response(deprecated));
    router
        .merge(tickets)
        .route(
            "/conversations",
            scoped(get(list_conversations), "conversations:read")
                .merge(scoped(post(open_conversation), "conversations:write")),
        )
        .route(
            "/conversations/{id}",
            scoped(get(get_conversation), "conversations:read")
                .merge(scoped(patch(update_conversation), "conversations:write")),
        )
        .route(
            "/conversations/{id}/messages",
            scoped(get(list_conversation_messages), "conversations:read").merge(scoped(
                post(add_conversation_message),
                "conversations:write",
            )),
        )
}

/// `Deprecation: true` and the successor link on every ticket answer.
async fn deprecated(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert("Deprecation", HeaderValue::from_static("true"));
    headers.insert(
        "Link",
        HeaderValue::from_static("</v1/conversations>; rel=\"successor-version\""),
    );
    response
}

// ── the inbox's dependencies ─────────────────────────────────────────────────

/// `emit: (event) => publishEntityEvent({ c, ...event })`.
struct Emitter<'a> {
    state: &'a ExternalApiState,
    caller: &'a Caller,
}

impl InboxEmitter for Emitter<'_> {
    fn emit<'a>(&'a self, event: &'a InboxEvent) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let kind =
                EventType::catalog(event.entity_type, event.action).map_err(|e| e.to_string())?;
            self.state.events.publish(
                &self.caller.events,
                EntityEvent::new(kind, event.entity_id.clone(), event.data.clone()),
            );
            Ok(())
        })
    }
}

/// `deskInboxDeps(c)`'s parts that outlive the borrow.
struct Inbox<'a> {
    emitter: Emitter<'a>,
    notifier: Notifier,
    clerk_org_id: &'a str,
}

impl<'a> Inbox<'a> {
    fn new(state: &'a ExternalApiState, caller: &'a Caller) -> Self {
        Self {
            emitter: Emitter { state, caller },
            notifier: Notifier {
                realtime: state.realtime.clone(),
                ..Notifier::default()
            },
            clerk_org_id: caller
                .session
                .clerk_org_id
                .as_deref()
                .unwrap_or(&caller.session.workspace_id),
        }
    }

    /// `deskInboxDeps(c)`: the request's database, realtime, notifier and
    /// publisher; the SLA due index on the master database.
    fn deps(&'a self, master: &'a PgPool) -> InboxDeps<'a> {
        let caller = self.emitter.caller;
        let picker = match &self.emitter.state.assignment {
            Some(router) => Picker::Router {
                router,
                workspace_id: &caller.session.workspace_id,
            },
            None => Picker::Local,
        };
        InboxDeps {
            db: &caller.db,
            clerk_org_id: self.clerk_org_id,
            emitter: &self.emitter,
            // The worker passes no `publishRoom`.
            rooms: None,
            notifier: &self.notifier,
            picker,
            due: Some((master, caller.session.workspace_id.as_str())),
        }
    }
}

/// `deskInboxActor(c)`: a personal key acts as its member, any other key as
/// a bot.
fn actor(caller: &Caller) -> Actor<'_> {
    match caller.session.user_id.as_deref() {
        Some(user) => Actor {
            author_type: "agent",
            author_id: Some(user),
        },
        None => Actor {
            author_type: "bot",
            author_id: Some(&caller.session.key_id),
        },
    }
}

/// What the routes answer for an inbox error they catch; anything else is
/// the worker's 500.
fn inbox_error(error: InboxError, conversation_id: &str) -> Fail {
    let message = error.to_string();
    match error {
        InboxError::NotFound(_) => not_found("Conversation", conversation_id).into(),
        InboxError::Rejected { field, message } => bad_request(message)
            .with_details(json!({ "field": field }))
            .into(),
        InboxError::ReplyChannel(_) => conflict(message).into(),
        InboxError::EmptyUpdate | InboxError::Failed(_) => {
            tracing::error!(%message, "external-api: an inbox write failed");
            internal().into()
        }
    }
}

/// A body string, when set.
fn opt_text(body: &Map<String, Value>, key: &str) -> Option<String> {
    body.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// An optional nullable field: absent, `null` or a value.
fn nullable(body: &Map<String, Value>, key: &str) -> Field<String> {
    match body.get(key) {
        None => Field::Absent,
        Some(Value::Null) => Field::Null,
        Some(value) => Field::Set(value.as_str().unwrap_or_default().to_owned()),
    }
}

fn tags(body: &Map<String, Value>) -> Option<Vec<String>> {
    body.get("tags").and_then(Value::as_array).map(|tags| {
        tags.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

/// `{ ticketTypeId, priority, tags, departmentId }` of an open: `undefined`
/// (or `null`) leaves a field alone.
fn open_fields(
    ticket_type: Option<String>,
    priority: Option<String>,
    body: &Map<String, Value>,
    department: Option<String>,
) -> Update {
    let set = |value: Option<String>| value.map_or(Field::Absent, Field::Set);
    Update {
        ticket_type_id: set(ticket_type),
        priority: set(priority),
        tags: tags(body),
        department_id: set(department),
        custom_fields: Vec::new(),
    }
}

// ── conversations ────────────────────────────────────────────────────────────

/// A list page's answer.
#[allow(clippy::unnecessary_wraps, clippy::needless_pass_by_value)] // a handler's answer
fn page_of(data: Vec<Value>, total: i64, has_more: bool, cursor: Option<String>) -> Answer {
    Ok(axum::Json(json!({
        "data": data,
        "pagination": { "totalCount": total, "hasMore": has_more, "cursor": cursor },
    }))
    .into_response())
}

async fn list_conversations(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_CONVERSATIONS, raw.as_deref())?;
    let string = |key: &str| q.get(key).and_then(Value::as_str).map(str::to_owned);
    let query = ListQuery {
        state: string("state"),
        assignee_id: string("assigneeId"),
        unassigned: q.get("unassigned") == Some(&Value::Bool(true)),
        channel: string("channel"),
        visitor_id: string("visitorId"),
        email: string("email"),
        // `query.q ?? search`
        q: string("q").or_else(|| string("search")),
        priority: string("priority"),
        ticket_type_id: string("ticketTypeId"),
        department_id: string("departmentId"),
        tag: string("tag"),
        external_id: string("externalId"),
        sort: string("sort"),
        cursor: string("cursor"),
        limit: q.get("limit").and_then(Value::as_f64),
    };
    let (rows, total, has_more, cursor) = list::list(&caller.db, &query).await?;
    page_of(rows, total, has_more, cursor)
}

async fn get_conversation(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let q = zod::query(&GET_CONVERSATION_QUERY, raw.as_deref())?;
    let with_messages = q.text("include") == Some("messages");
    let Some((mut conversation, messages)) =
        weldsuite_desk_domain::webchat::get(&caller.db, &id, with_messages).await?
    else {
        return Err(not_found("Conversation", &id).into());
    };
    if with_messages && let Some(object) = conversation.as_object_mut() {
        object.insert("messages".into(), Value::Array(messages));
    }
    ok(conversation)
}

async fn open_conversation(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&OPEN_CONVERSATION, &headers, &body)?;
    let body = &parsed.body;
    let input = OpenConversation {
        ingest: IngestApi {
            via: "api".into(),
            external_id: opt_text(body, "externalId"),
            title: opt_text(body, "title"),
            body: opt_text(body, "body").unwrap_or_default(),
            name: opt_text(body, "name"),
            email: opt_text(body, "email"),
            contact_id: opt_text(body, "contactId"),
            metadata: Map::new(),
        },
        fields: open_fields(
            opt_text(body, "ticketTypeId"),
            opt_text(body, "priority"),
            body,
            opt_text(body, "departmentId"),
        ),
        assignee_id: None,
    };
    open(&state, &caller, &input).await
}

/// `openDeskApiConversation`: 201 when new, 200 when `externalId` matched.
async fn open(state: &ExternalApiState, caller: &Caller, input: &OpenConversation) -> Answer {
    let master = crate::master_db_of(state, caller);
    let inbox = Inbox::new(state, caller);
    let result =
        inbox::open_desk_api_conversation(&inbox.deps(&master), input, Some(actor(caller)))
            .await
            .map_err(|error| inbox_error(error, ""))?;
    if result.created {
        created(result.conversation)
    } else {
        ok(result.conversation)
    }
}

async fn update_conversation(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_CONVERSATION, &headers, &body)?;
    let body = &parsed.body;
    let custom_fields = match body.get("customFields") {
        Some(Value::Object(fields)) => fields
            .iter()
            .map(|(slug, value)| (slug.clone(), Js::from_jsonb(value)))
            .collect(),
        _ => Vec::new(),
    };
    let input = UpdateConversation {
        conversation_id: id.clone(),
        state: opt_text(body, "state"),
        assignee_id: nullable(body, "assigneeId"),
        fields: Update {
            ticket_type_id: nullable(body, "ticketTypeId"),
            priority: nullable(body, "priority"),
            tags: tags(body),
            department_id: nullable(body, "departmentId"),
            custom_fields,
        },
    };
    let master = crate::master_db_of(&state, &caller);
    let inbox = Inbox::new(&state, &caller);
    let updated =
        inbox::update_desk_conversation_from_api(&inbox.deps(&master), &input, actor(&caller))
            .await
            .map_err(|error| inbox_error(error, &id))?;
    let mut conversation = updated.conversation;
    if let (Some(fields), Some(object)) = (updated.custom_fields, conversation.as_object_mut()) {
        object.insert("customFields".into(), Value::Object(fields));
    }
    ok(conversation)
}

async fn list_conversation_messages(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let q = zod::query(&LIST_CONVERSATION_MESSAGES, raw.as_deref())?;
    if weldsuite_desk_domain::webchat::get(&caller.db, &id, false)
        .await?
        .is_none()
    {
        return Err(not_found("Conversation", &id).into());
    }
    let found = list::messages_page(
        &caller.db,
        &id,
        q.text("cursor"),
        q.get("limit").and_then(Value::as_f64),
    )
    .await?;
    let total = i64::try_from(found.data.len()).unwrap_or(i64::MAX);
    page_of(found.data, total, found.has_more, found.cursor)
}

async fn add_conversation_message(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&ADD_CONVERSATION_MESSAGE, &headers, &body)?;
    let kind = parsed.text("kind").unwrap_or("note").to_owned();
    let text = parsed
        .body
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let master = crate::master_db_of(&state, &caller);
    let inbox = Inbox::new(&state, &caller);
    let (message, _) = inbox::add_desk_conversation_message_from_api(
        &inbox.deps(&master),
        &id,
        &kind,
        &text,
        actor(&caller),
    )
    .await
    .map_err(|error| inbox_error(error, &id))?;
    created(message)
}

// ── tickets ──────────────────────────────────────────────────────────────────

const TICKETS_LIST: (&str, &str) = table_list_sql!(
    helpdesk_tickets,
    "t.deleted_at is null \
     and ($3->>'search' is null or (t.subject like $3->>'search' or t.customer_email like $3->>'search' \
          or t.customer_name like $3->>'search' or t.ticket_number like $3->>'search')) \
     and ($3->>'status' is null or t.status::text = $3->>'status') \
     and ($3->>'priority' is null or t.priority::text = $3->>'priority') \
     and ($3->>'assigneeId' is null or t.assignee_id = $3->>'assigneeId') \
     and ($3->>'departmentId' is null or t.department_id = $3->>'departmentId') \
     and ($3->>'channel' is null or t.channel::text = $3->>'channel') \
     and ($3->>'category' is null or t.category = $3->>'category')"
);

async fn list_tickets(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_TICKETS, raw.as_deref())?;
    let filters = json!({
        "search": like(&q, "search"),
        "status": text(&q, "status"),
        "priority": text(&q, "priority"),
        "assigneeId": text(&q, "assigneeId"),
        "departmentId": text(&q, "departmentId"),
        "channel": text(&q, "channel"),
        "category": text(&q, "category"),
    });
    let mut found =
        crate::list::list_rows(&caller.db, TICKETS_LIST, &list_query(&q), &filters).await?;
    let rows = std::mem::take(&mut found.rows)
        .into_iter()
        .map(|row| HELPDESK_TICKETS.js(row))
        .collect();
    // Custom field values come from the typed table (blob fallback).
    found.rows = values::hydrate(&caller.db, "ticket", rows, None).await?;
    Ok(found.respond())
}

async fn get_ticket(caller: Caller, Path(id): Path<String>) -> Answer {
    let row = HELPDESK_TICKETS
        .find_live(&caller.db, &id)
        .await?
        .ok_or_else(|| not_found("Ticket", &id))?;
    let row = values::hydrate_one(&caller.db, "ticket", Some(row)).await?;
    ok(row.unwrap_or(Value::Null))
}

/// `isEmptyValue`: `undefined`, `null`, or an object (or array) with no keys.
fn is_empty_value(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Object(object)) => object.is_empty(),
        Some(Value::Array(items)) => items.is_empty(),
        Some(_) => false,
    }
}

/// The ticket fields that are not mapped onto the conversation.
const MAPPED: [&str; 12] = [
    "externalId",
    "subject",
    "description",
    "customerName",
    "customerEmail",
    "contactId",
    "ticketTypeId",
    "departmentId",
    "priority",
    "tags",
    "assigneeId",
    "customFields",
];

async fn open_ticket(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&OPEN_TICKET, &headers, &body)?;
    let body = &parsed.body;
    if !is_empty_value(body.get("customFields")) {
        return Err(bad_request(
            "Set custom fields with PATCH /v1/conversations/:id once the conversation is open",
        )
        .with_details(json!({ "field": "customFields" }))
        .into());
    }
    let ticket: Map<String, Value> = body
        .iter()
        .filter(|(key, value)| !MAPPED.contains(&key.as_str()) && !is_empty_value(Some(value)))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let subject = opt_text(body, "subject");
    let description = body
        .get("description")
        .and_then(Value::as_str)
        .map(weldsuite_kit::validation::js_trim)
        .filter(|d| !d.is_empty())
        .map(str::to_owned);
    let mut metadata = Map::new();
    if !ticket.is_empty() {
        metadata.insert("ticket".into(), Value::Object(ticket));
    }
    // The inbox's top priority is urgent.
    let priority = opt_text(body, "priority").map(|p| {
        if p == "critical" {
            "urgent".to_owned()
        } else {
            p
        }
    });
    let input = OpenConversation {
        ingest: IngestApi {
            via: "api".into(),
            external_id: opt_text(body, "externalId"),
            title: subject.clone(),
            body: description.or_else(|| subject.clone()).unwrap_or_default(),
            name: opt_text(body, "customerName"),
            email: opt_text(body, "customerEmail"),
            contact_id: opt_text(body, "contactId"),
            metadata,
        },
        fields: open_fields(
            opt_text(body, "ticketTypeId"),
            priority,
            body,
            opt_text(body, "departmentId"),
        ),
        assignee_id: opt_text(body, "assigneeId"),
    };
    open(&state, &caller, &input).await
}

/// id, slug, field type, options, required.
type DefinitionRow = (String, String, String, Option<Value>, Option<bool>);

/// `getDefinitionsForTicket(db, ticketTypeId)`: the ticket's custom fields,
/// those of its type and the untyped ones.
async fn ticket_definitions(
    db: &PgPool,
    ticket_type_id: Option<&str>,
) -> Result<Vec<Definition>, sqlx::Error> {
    let rows: Vec<DefinitionRow> = sqlx::query_as(
        "select id, slug, field_type, options, required from custom_field_definitions
         where entity_type = 'ticket'
           and (case when $1::text is not null and $1 <> '' then (ticket_type_id = $1 or ticket_type_id is null)
                     else ticket_type_id is null end)
           and deleted_at is null",
    )
    .bind(ticket_type_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, slug, field_type, options, required)| Definition {
            id,
            slug,
            field_type,
            options,
            required: required.unwrap_or(false),
        })
        .collect())
}

async fn update_ticket(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_TICKET, &headers, &body)?;
    let row = HELPDESK_TICKETS
        .patch(
            &caller.db,
            &id,
            &with_updated(&parsed.body, &now()),
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("Ticket", &id))?;
    // The typed custom field values, scoped to the (possibly new) type.
    let definitions = ticket_definitions(&caller.db, row["ticketTypeId"].as_str()).await?;
    if let Some(custom_fields) = parsed.body.get("customFields") {
        let fields: Vec<(String, Js)> = match custom_fields {
            Value::Object(map) => map
                .iter()
                .map(|(key, value)| (key.clone(), Js::from_jsonb(value)))
                .collect(),
            _ => Vec::new(),
        };
        if let Err(error) = values::set_values(
            &caller.db,
            "ticket",
            &id,
            &fields,
            &definitions,
            false,
            false,
        )
        .await
        {
            tracing::warn!(%error, "[custom-field-values] dual-write mirror failed for ticket:{id}");
        }
    }
    caller.publish(
        &state.events,
        TICKET_UPDATED,
        &id,
        json!({
            "id": id,
            "ticketNumber": field(&row, "ticketNumber"),
            "subject": field(&row, "subject"),
            "status": field(&row, "status"),
            "priority": field(&row, "priority"),
            "channel": field(&row, "channel"),
            "assigneeId": field(&row, "assigneeId"),
            "contactId": field(&row, "contactId"),
            "departmentId": field(&row, "departmentId"),
        }),
    );
    ok(row)
}

async fn delete_ticket(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let row = soft_delete(&caller.db, &HELPDESK_TICKETS, &id)
        .await?
        .ok_or_else(|| not_found("Ticket", &id))?;
    caller.publish(
        &state.events,
        TICKET_DELETED,
        &id,
        json!({
            "id": id,
            "ticketNumber": field(&row, "ticketNumber"),
            "subject": field(&row, "subject"),
            "status": field(&row, "status"),
        }),
    );
    no_content()
}

const TICKET_MESSAGES_LIST: (&str, &str) =
    table_list_sql!(helpdesk_ticket_messages, "t.ticket_id = $3->>'ticketId'");

async fn list_ticket_messages(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let q = zod::query(&LIST_TICKET_MESSAGES, raw.as_deref())?;
    page(
        &caller.db,
        TICKET_MESSAGES_LIST,
        &HELPDESK_TICKET_MESSAGES,
        &q,
        json!({ "ticketId": id }),
    )
    .await
}

async fn create_ticket_message(
    State(state): S,
    caller: Caller,
    Path(ticket_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_TICKET_MESSAGE, &headers, &body)?;
    let body = &parsed.body;
    let filled = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
    };
    // body, authorName and authorEmail are NOT NULL with no default.
    if !filled("body") {
        return Err(bad_request("body is required").into());
    }
    if !filled("authorName") || !filled("authorEmail") {
        return Err(bad_request("authorName and authorEmail are required").into());
    }
    if HELPDESK_TICKETS
        .find_live(&caller.db, &ticket_id)
        .await?
        .is_none()
    {
        return Err(not_found("Ticket", &ticket_id).into());
    }
    let id = generate_id("tmsg");
    let mut values = Map::new();
    values.insert("ticketId".into(), json!(ticket_id));
    values.extend(body.clone());
    let values = with_id(&values, &id, &now());
    let row = HELPDESK_TICKET_MESSAGES
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    // `{ id, ticketId, authorId: body.authorId, subject: body.subject }`:
    // an absent value is left out of the JSON.
    let mut data = Map::new();
    data.insert("id".into(), json!(id));
    data.insert("ticketId".into(), json!(ticket_id));
    for key in ["authorId", "subject"] {
        if let Some(value) = body.get(key) {
            data.insert(key.into(), value.clone());
        }
    }
    caller.publish(
        &state.events,
        HELPDESK_MESSAGE_CREATED,
        &id,
        Value::Object(data),
    );
    created(row)
}
