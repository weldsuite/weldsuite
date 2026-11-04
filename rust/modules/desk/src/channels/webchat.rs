//! The webchat inbox's data layer (`@weldsuite/db/lib/desk`,
//! `packages/core/db/src/lib/desk.ts`): the inbox list and email threading
//! the desk API's routes use. The writer (`appendDeskMessage`, the only
//! writer of a conversation's state, waiting time and last message) and the
//! public payloads are in `weldsuite_desk_domain::webchat`, shared with the
//! helpdesk widget API.

use serde_json::{Value, json};
use weldsuite_db::PgPool;

pub(crate) use weldsuite_desk_domain::webchat::{
    Append, AppendError, Author, append, author_from_member, collapse_whitespace, get, is_public,
    public_conversation, public_message,
};

pub(crate) use weldsuite_desk_domain::list::{ListQuery, list};

/// `getDeskEmailReplyContext`: where an email reply is sent from, and what
/// it threads on.
pub(crate) struct EmailThread {
    pub(crate) helpdesk_address: Option<String>,
    pub(crate) last_email_message_id: Option<String>,
    pub(crate) references: Vec<String>,
    pub(crate) subject: Option<String>,
}

pub(crate) async fn email_thread(
    db: &PgPool,
    id: &str,
) -> Result<Option<EmailThread>, sqlx::Error> {
    let Some((conversation, messages)) = get(db, id, true).await? else {
        return Ok(None);
    };
    let mut thread = EmailThread {
        helpdesk_address: None,
        last_email_message_id: None,
        references: Vec::new(),
        subject: conversation["title"].as_str().map(str::to_owned),
    };
    for message in &messages {
        let meta = &message["metadata"];
        if let Some(address) = meta["helpdeskAddress"].as_str().filter(|a| !a.is_empty()) {
            thread.helpdesk_address = Some(address.to_owned());
        }
        if let Some(id) = meta["emailMessageId"].as_str().filter(|a| !a.is_empty()) {
            thread.last_email_message_id = Some(id.to_owned());
            thread.references.push(id.to_owned());
        }
    }
    let keep = thread.references.len().saturating_sub(20);
    thread.references.drain(..keep);
    Ok(Some(thread))
}

/// `normalizeRfcMessageId`: without its angle brackets.
fn normalize_rfc_message_id(id: &str) -> Option<String> {
    let trimmed = weldsuite_kit::validation::js_trim(id);
    let trimmed = trimmed.strip_prefix('<').unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix('>').unwrap_or(trimmed);
    let trimmed = weldsuite_kit::validation::js_trim(trimmed);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `stampDeskMessageEmailId`: the sent RFC Message-ID on the message.
pub(crate) async fn stamp_email_id(
    db: &PgPool,
    message_id: &str,
    email_message_id: &str,
) -> Result<(), sqlx::Error> {
    let rfc =
        normalize_rfc_message_id(email_message_id).unwrap_or_else(|| email_message_id.to_owned());
    let metadata: Option<Option<Value>> =
        sqlx::query_scalar("select metadata from desk_messages where id = $1 limit 1")
            .bind(message_id)
            .fetch_optional(db)
            .await?;
    let Some(metadata) = metadata else {
        return Ok(());
    };
    let mut next = metadata
        .and_then(|m| m.as_object().cloned())
        .unwrap_or_default();
    next.insert("emailMessageId".to_owned(), json!(rfc));
    sqlx::query("update desk_messages set metadata = $2 where id = $1")
        .bind(message_id)
        .bind(Value::Object(next))
        .execute(db)
        .await?;
    Ok(())
}
