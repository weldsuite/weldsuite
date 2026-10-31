//! The email channel (`@weldsuite/db/lib/desk`, `ingestDeskEmail` and the
//! lookups it threads with): a customer email starts a `desk_conversations`
//! row (channel `email`) or lands on the one it continues.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use crate::webchat::{
    Append, AppendError, ChannelConversation, DESK_CONVERSATIONS, NewConversation, VisitorInput,
    append_desk_message, create_on_channel, preview_of, upsert_visitor,
};

/// `normalizeRfcMessageId(id)`: angle brackets (one each side) and the
/// surrounding whitespace removed; `None` when nothing is left.
pub fn normalize_rfc_message_id(id: Option<&str>) -> Option<String> {
    let id = id.filter(|i| !i.is_empty())?;
    let trimmed = weldsuite_kit::validation::js_trim(id);
    let trimmed = trimmed.strip_prefix('<').unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix('>').unwrap_or(trimmed);
    let trimmed = weldsuite_kit::validation::js_trim(trimmed);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `normalizeEmailSubject(subject)`: leading `Re:`/`Fwd:`/`Fw:` prefixes
/// (each followed by optional whitespace) removed, then trimmed.
pub fn normalize_email_subject(subject: Option<&str>) -> String {
    let Some(mut rest) = subject.filter(|s| !s.is_empty()) else {
        return String::new();
    };
    // `/^(Re|Fwd|Fw):\s*/gi`: `^` without `m` matches at the start only, so
    // one prefix goes, even with `g`.
    let lower = rest.to_ascii_lowercase();
    if let Some(len) = ["re:", "fwd:", "fw:"]
        .into_iter()
        .find(|p| lower.starts_with(p))
        .map(str::len)
    {
        rest = rest[len..].trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    }
    weldsuite_kit::validation::js_trim(rest).to_owned()
}

/// `findDeskConversationByRfcMessageIds(db, ids)`: the conversation of the
/// first id a desk message carries as its email id.
pub async fn find_by_rfc_message_ids(
    db: &PgPool,
    ids: &[Option<&str>],
) -> Result<Option<Value>, sqlx::Error> {
    for id in ids.iter().filter_map(|id| normalize_rfc_message_id(*id)) {
        let conversation: Option<String> = sqlx::query_scalar(
            "select conversation_id from desk_messages
             where (metadata->>'emailMessageId' = $1 or metadata->>'emailThreadMessageId' = $1)
             limit 1",
        )
        .bind(&id)
        .fetch_optional(db)
        .await?;
        let Some(conversation) = conversation else {
            continue;
        };
        let row: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from desk_conversations t where t.id = $1 limit 1",
        )
        .bind(&conversation)
        .fetch_optional(db)
        .await?;
        if let Some(row) = row {
            return Ok(Some(DESK_CONVERSATIONS.js(row)));
        }
    }
    Ok(None)
}

/// `findOpenEmailConversationByEmail(db, email)`.
pub async fn find_open_by_email(db: &PgPool, email: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_conversations t
         where t.channel = 'email' and t.state = 'open' and t.email = $1
         order by t.last_message_at desc limit 1",
    )
    .bind(email.to_lowercase())
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DESK_CONVERSATIONS.js(row)))
}

/// `findRecentEmailConversation(db, email, title)`: the same sender and
/// subject within thirty days.
pub async fn find_recent(
    db: &PgPool,
    email: &str,
    title: &str,
) -> Result<Option<Value>, sqlx::Error> {
    if title.is_empty() {
        return Ok(None);
    }
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_conversations t
         where t.channel = 'email' and t.email = $1 and t.title = $2
           and t.last_message_at > now() - interval '30 days'
         order by t.last_message_at desc limit 1",
    )
    .bind(email.to_lowercase())
    .bind(title)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DESK_CONVERSATIONS.js(row)))
}

/// `IngestDeskEmailInput`.
#[derive(Debug, Clone, Default)]
pub struct IngestEmail<'a> {
    pub from_name: Option<&'a str>,
    pub from_email: &'a str,
    pub to_address: &'a str,
    pub subject: &'a str,
    pub body: &'a str,
    /// `DeskMessageAttachment`s, already stored.
    pub attachments: Option<Vec<Value>>,
    pub rfc_message_id: &'a str,
    pub in_reply_to: Option<&'a str>,
    pub references: &'a [String],
    pub to_emails: Option<Vec<String>>,
    pub cc_emails: Option<Vec<String>>,
}

/// What `ingestDeskEmail` returns: the conversation after the message, the
/// message, and whether the conversation is new.
#[derive(Debug, Clone)]
pub struct Ingested {
    pub conversation: Value,
    pub message: Value,
    pub created: bool,
}

/// `ingestDeskEmail(db, input)`.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub async fn ingest_desk_email(
    db: &PgPool,
    input: IngestEmail<'_>,
) -> Result<Ingested, AppendError> {
    let from_email = input.from_email.to_lowercase();
    let rfc_message_id = normalize_rfc_message_id(Some(input.rfc_message_id))
        .unwrap_or_else(|| input.rfc_message_id.to_owned());
    let normalized = normalize_email_subject(Some(input.subject));
    let title = [
        Some(normalized),
        Some(input.subject.to_owned()),
        preview_of(Some(input.body)),
        Some(from_email.clone()),
    ]
    .into_iter()
    .flatten()
    .find(|t| !t.is_empty())
    .unwrap_or_default();

    let mut thread_ids: Vec<Option<&str>> = vec![input.in_reply_to];
    thread_ids.extend(input.references.iter().map(|r| Some(r.as_str())));
    let mut conversation = find_by_rfc_message_ids(db, &thread_ids).await?;
    if conversation.is_none() {
        conversation = find_open_by_email(db, &from_email).await?;
    }
    if conversation.is_none() {
        conversation = find_recent(db, &from_email, &title).await?;
    }

    let visitor: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from desk_visitors t where t.email = $1 limit 1")
            .bind(&from_email)
            .fetch_optional(db)
            .await?;
    let visitor_id = visitor
        .as_ref()
        .and_then(|v| v["id"].as_str())
        .map_or_else(|| weldsuite_kit::generate_id("dvis"), str::to_owned);
    let name = input
        .from_name
        .map(str::to_owned)
        .or_else(|| {
            visitor
                .as_ref()
                .and_then(|v| v["name"].as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| from_email.clone());
    let visitor = upsert_visitor(
        db,
        VisitorInput {
            id: &visitor_id,
            name: Some(name),
            email: Some(from_email.clone()),
            ..VisitorInput::default()
        },
    )
    .await?;
    let visitor_id = visitor["id"].as_str().unwrap_or(&visitor_id).to_owned();

    let mut meta = Map::new();
    meta.insert("emailMessageId".to_owned(), json!(rfc_message_id));
    meta.insert("emailThreadMessageId".to_owned(), json!(rfc_message_id));
    meta.insert("helpdeskAddress".to_owned(), json!(input.to_address));
    meta.insert("emailFrom".to_owned(), json!(from_email));
    meta.insert(
        "emailTo".to_owned(),
        json!(
            input
                .to_emails
                .clone()
                .unwrap_or_else(|| vec![input.to_address.to_owned()])
        ),
    );
    meta.insert(
        "emailCc".to_owned(),
        json!(input.cc_emails.clone().unwrap_or_default()),
    );
    meta.insert("emailSubject".to_owned(), json!(input.subject));

    if let Some(conversation) = conversation {
        meta.remove("emailThreadMessageId");
        let id = conversation["id"].as_str().unwrap_or_default().to_owned();
        let (conversation, message) = append_desk_message(
            db,
            Append {
                conversation_id: &id,
                kind: "message",
                author_type: "visitor",
                author_id: Some(&visitor_id),
                body: Some(input.body.to_owned()),
                attachments: input.attachments,
                metadata: Some(meta),
                assignee_id: None,
            },
        )
        .await?;
        return Ok(Ingested {
            conversation,
            message,
            created: false,
        });
    }

    let (conversation, message) = create_on_channel(
        db,
        ChannelConversation {
            channel: "email",
            title: json!(title),
            attachments: input.attachments,
            conversation: NewConversation {
                visitor_id: &visitor_id,
                name: json!(
                    input
                        .from_name
                        .map_or_else(|| from_email.clone(), str::to_owned)
                ),
                email: json!(from_email),
                body: input.body.to_owned(),
                author_type: "visitor",
                author_id: Some(&visitor_id),
                metadata: Some(meta),
            },
        },
    )
    .await?;
    Ok(Ingested {
        conversation,
        message,
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(
            normalize_rfc_message_id(Some(" <a@b> ")).as_deref(),
            Some("a@b")
        );
        assert_eq!(normalize_rfc_message_id(Some("<>")), None);
        assert_eq!(
            normalize_email_subject(Some("Re: Fwd: Hello ")),
            "Fwd: Hello"
        );
        assert_eq!(normalize_email_subject(Some("FW:Hello")), "Hello");
        assert_eq!(normalize_email_subject(Some("Hello Re: x")), "Hello Re: x");
        assert_eq!(normalize_email_subject(None), "");
    }
}
