//! `services/helpdesk/conversation-to-ticket.ts`: attach a new ticket to the
//! conversation it was raised from. Shared by `POST /api/tickets
//! { conversationId }` and `POST /api/conversations/:id/convert-to-ticket`.
//!
//! Copies the public transcript onto the ticket, drops a "Ticket created"
//! system message into the conversation and publishes it to the
//! conversation room. Never fails the request: each half logs its error.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::realtime::{conversation_system, defined};
use weldsuite_kit::generate_id;

use crate::DeskState;
use crate::js::{or_else, text};
use crate::tables::{HELPDESK_CONVERSATION_MESSAGES, HELPDESK_TICKET_MESSAGES};

/// `LinkConversationToTicketInput`.
pub(crate) struct Link<'a> {
    pub(crate) conversation_id: &'a str,
    pub(crate) ticket_id: &'a str,
    pub(crate) ticket_number: &'a str,
    pub(crate) subject: &'a str,
    pub(crate) priority: Option<&'a str>,
    pub(crate) customer_name: &'a str,
    pub(crate) customer_email: &'a str,
    pub(crate) contact_id: Option<&'a str>,
    pub(crate) now: &'a str,
}

/// `linkConversationToTicket(env, db, args)`.
pub(crate) async fn link_conversation_to_ticket(state: &DeskState, db: &PgPool, link: &Link<'_>) {
    if let Err(error) = copy_transcript(db, link).await {
        tracing::error!(%error, "[app-api/helpdesk] failed to copy conversation messages");
    }
    if let Err(error) = annotate(state, db, link).await {
        tracing::error!(%error, "[app-api/helpdesk] failed to link conversation to ticket");
    }
}

/// 1. The public transcript, oldest first, as ticket messages (one insert
///    for all, as Drizzle's multi-row insert).
async fn copy_transcript(db: &PgPool, link: &Link<'_>) -> Result<(), crate::table::WriteError> {
    let messages: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from helpdesk_conversation_messages m
         where m.conversation_id = $1 and m.is_public = true and m.deleted_at is null
         order by m.created_at asc",
    )
    .bind(link.conversation_id)
    .fetch_all(db)
    .await?;
    if messages.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    for message in messages {
        let message = HELPDESK_CONVERSATION_MESSAGES.js(message);
        let mut values = Map::new();
        let table = &HELPDESK_TICKET_MESSAGES;
        table.set(&mut values, "id", json!(generate_id("tkm")));
        table.set(&mut values, "ticketId", json!(link.ticket_id));
        table.set(&mut values, "body", message["content"].clone());
        table.set(&mut values, "htmlBody", message["htmlContent"].clone());
        table.set(
            &mut values,
            "authorType",
            json!(or_else(text(&message, "authorType"), Some("customer"))),
        );
        table.set(
            &mut values,
            "authorId",
            json!(or_else(
                or_else(text(&message, "authorId"), link.contact_id),
                Some("unknown")
            )),
        );
        table.set(
            &mut values,
            "authorName",
            json!(or_else(
                or_else(text(&message, "authorName"), Some(link.customer_name)),
                Some("Customer")
            )),
        );
        table.set(
            &mut values,
            "authorEmail",
            json!(or_else(
                text(&message, "authorEmail"),
                Some(link.customer_email)
            )),
        );
        table.set(&mut values, "isInternal", json!(false));
        table.set(
            &mut values,
            "createdAt",
            json!(text(&message, "createdAt").unwrap_or(link.now)),
        );
        table.set(
            &mut values,
            "updatedAt",
            json!(text(&message, "updatedAt").unwrap_or(link.now)),
        );
        table
            .insert(&mut *tx, values, &["createdAt", "updatedAt"])
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 2. The "Ticket created" system message, and its realtime event.
async fn annotate(
    state: &DeskState,
    db: &PgPool,
    link: &Link<'_>,
) -> Result<(), crate::table::WriteError> {
    let content = format!("Ticket created: {}", link.subject);
    let priority = link.priority.map(|p| json!(p));
    let metadata = defined(&[
        ("ticketId", Some(json!(link.ticket_id))),
        ("ticketNumber", Some(json!(link.ticket_number))),
        ("ticketSubject", Some(json!(link.subject))),
        ("ticketStatus", Some(json!("open"))),
        ("ticketPriority", priority.clone()),
    ]);
    let table = &HELPDESK_CONVERSATION_MESSAGES;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(generate_id("cvm")));
    table.set(&mut values, "conversationId", json!(link.conversation_id));
    table.set(&mut values, "authorId", json!("system"));
    table.set(&mut values, "authorName", json!("System"));
    table.set(&mut values, "authorType", json!("system"));
    table.set(&mut values, "content", json!(content));
    table.set(&mut values, "type", json!("system"));
    table.set(&mut values, "isPublic", json!(true));
    table.set(&mut values, "isInternal", json!(false));
    table.set(&mut values, "isRead", json!(false));
    table.set(&mut values, "metadata", metadata);
    table.set(&mut values, "createdAt", json!(link.now));
    table.set(&mut values, "updatedAt", json!(link.now));
    table
        .insert(db, values, &["createdAt", "updatedAt"])
        .await?;
    if let Some(realtime) = &state.realtime {
        let data = defined(&[
            ("text", Some(json!(content))),
            ("ticketId", Some(json!(link.ticket_id))),
            ("ticketNumber", Some(json!(link.ticket_number))),
            ("ticketSubject", Some(json!(link.subject))),
            ("ticketStatus", Some(json!("open"))),
            ("ticketPriority", priority),
        ]);
        let message = conversation_system(link.conversation_id, "ticket_linked", data);
        // `conversationPublish` logs a failed POST and resolves.
        if let Err(error) = realtime.publish_boxed(&message).await {
            tracing::error!(%error, "[realtime] conversation publish failed");
        }
    }
    Ok(())
}
