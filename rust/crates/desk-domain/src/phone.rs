//! The phone channel (`@weldsuite/db/lib/desk`, `ingestDeskPhone` and the
//! lookups it threads with): an inbound call starts a `desk_conversations`
//! row (channel `phone`) for the caller's number, or lands on the open one
//! that number already has.
//!
//! The TypeScript append also re-derives the conversation's SLA clocks
//! (`refreshDeskSla`) and returns when they next come due; this crate has no
//! SLA engine yet, so neither is done here.

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::js_trim;
use weldsuite_schema::tenant::{desk_conversations, desk_visitors};

use crate::row;

use crate::email::Ingested;
use crate::webchat::{
    Append, AppendError, ChannelConversation, NewConversation, VisitorInput, append,
    create_on_channel_for, upsert_visitor,
};

/// `findDeskVisitorByPhone(db, phone)`.
pub async fn find_visitor_by_phone(db: &PgPool, phone: &str) -> Result<Option<Value>, DbErr> {
    let visitor = desk_visitors::Entity::find()
        .filter(desk_visitors::Column::Phone.eq(phone))
        .one(&orm(db))
        .await?;
    Ok(visitor.map(row))
}

/// `findOpenPhoneConversationByPhone(db, phone)`: the visitor's open phone
/// conversation that moved last.
pub async fn find_open_by_phone(db: &PgPool, phone: &str) -> Result<Option<Value>, DbErr> {
    use desk_conversations::Column;
    let Some(visitor) = find_visitor_by_phone(db, phone).await? else {
        return Ok(None);
    };
    let visitor_id = visitor["id"].as_str().unwrap_or_default().to_owned();
    let conversation = desk_conversations::Entity::find()
        .filter(Column::VisitorId.eq(visitor_id))
        .filter(Column::Channel.eq("phone"))
        .filter(Column::State.eq("open"))
        .order_by_desc(Column::LastMessageAt)
        .one(&orm(db))
        .await?;
    Ok(conversation.map(row))
}

/// `IngestDeskPhoneInput` (without `body` and `title`, which the call
/// webhook leaves to their defaults).
#[derive(Debug, Clone, Copy)]
pub struct IngestPhone<'a> {
    pub from_number: &'a str,
    pub to_number: &'a str,
    /// `voip_calls.id`.
    pub call_id: &'a str,
    pub call_control_id: Option<&'a str>,
    pub name: Option<&'a str>,
    pub contact_id: Option<&'a str>,
}

/// `input.name?.trim() || fallback`.
fn trimmed_or(name: Option<&str>, fallback: &str) -> String {
    name.map(js_trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

/// `ingestDeskPhone(db, input)`: the conversation after the call's first
/// message, the message, and whether the conversation is new.
pub async fn ingest_desk_phone(
    db: &PgPool,
    input: IngestPhone<'_>,
) -> Result<Ingested, AppendError> {
    let from_number = js_trim(input.from_number).to_owned();
    let display_name = trimmed_or(input.name, &from_number);
    let title = format!("Call from {display_name}");
    let body = format!("Inbound call from {display_name} to {}", input.to_number);

    let conversation = find_open_by_phone(db, &from_number).await?;
    let visitor = find_visitor_by_phone(db, &from_number).await?;
    let visitor_id = visitor
        .as_ref()
        .and_then(|v| v["id"].as_str())
        .map_or_else(|| weldsuite_kit::generate_id("dvis"), str::to_owned);
    let stored_name = visitor
        .as_ref()
        .and_then(|v| v["name"].as_str())
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    let name = input
        .name
        .map(js_trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .or(stored_name)
        .unwrap_or_else(|| from_number.clone());
    let visitor = upsert_visitor(
        db,
        VisitorInput {
            id: &visitor_id,
            name: Some(name),
            phone: Some(from_number.clone()),
            ..VisitorInput::default()
        },
    )
    .await?;
    let visitor_id = visitor["id"].as_str().unwrap_or(&visitor_id).to_owned();

    let mut meta = Map::new();
    meta.insert("callId".to_owned(), json!(input.call_id));
    if let Some(call_control_id) = input.call_control_id {
        meta.insert("callControlId".to_owned(), json!(call_control_id));
    }
    meta.insert("fromNumber".to_owned(), json!(from_number));
    meta.insert("toNumber".to_owned(), json!(input.to_number));
    meta.insert("event".to_owned(), json!("call_started"));

    if let Some(conversation) = conversation {
        let id = conversation["id"].as_str().unwrap_or_default().to_owned();
        let appended = append(
            db,
            Append {
                conversation_id: &id,
                kind: "message",
                author_type: "visitor",
                author_id: Some(&visitor_id),
                body: Some(body),
                attachments: None,
                metadata: Some(meta),
                assignee_id: None,
            },
        )
        .await?;
        return Ok(Ingested {
            sla_check_at: appended.sla_check_at,
            conversation: appended.conversation,
            message: appended.message,
            created: false,
        });
    }

    let appended = create_on_channel_for(
        db,
        ChannelConversation {
            channel: "phone",
            title: json!(title),
            attachments: None,
            conversation: NewConversation {
                visitor_id: &visitor_id,
                name: json!(display_name),
                email: Value::Null,
                body,
                author_type: "visitor",
                author_id: Some(&visitor_id),
                metadata: Some(meta),
            },
        },
        input.contact_id,
    )
    .await?;
    Ok(Ingested {
        sla_check_at: appended.sla_check_at,
        conversation: appended.conversation,
        message: appended.message,
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::trimmed_or;

    #[test]
    fn names_fall_back_like_the_typescript_or() {
        assert_eq!(trimmed_or(Some("  Ann "), "+31"), "Ann");
        assert_eq!(trimmed_or(Some("   "), "+31"), "+31");
        assert_eq!(trimmed_or(None, "+31"), "+31");
    }
}
