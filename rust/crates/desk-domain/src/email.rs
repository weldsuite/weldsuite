//! The email channel (`@weldsuite/db/lib/desk`, `ingestDeskEmail` and the
//! lookups it threads with): a customer email starts a `desk_conversations`
//! row (channel `email`) or lands on the one it continues.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use crate::webchat::{
    Append, AppendError, ChannelConversation, DESK_CONVERSATIONS, NewConversation, VisitorInput,
    append, create_on_channel, preview_of, upsert_visitor,
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

/// Reply and forward prefixes mail clients put before a subject (en, nl, de,
/// nordic): `SUBJECT_PREFIX`, `/^(?:re|fwd|fw|aw|antw|wg|sv|vs|doorst)\s?:/i`.
const SUBJECT_PREFIXES: [&str; 9] = ["re", "fwd", "fw", "aw", "antw", "wg", "sv", "vs", "doorst"];

/// JavaScript's `\s`: Unicode `White_Space` without U+0085, plus U+FEFF.
fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// The length of the reply/forward prefix `text` starts with, if any. The
/// regex's `i` without `u` folds ASCII letters only.
fn subject_prefix_len(text: &str) -> Option<usize> {
    SUBJECT_PREFIXES.iter().find_map(|prefix| {
        if !text.get(..prefix.len())?.eq_ignore_ascii_case(prefix) {
            return None;
        }
        // `\s?:`
        let mut rest = text[prefix.len()..].chars();
        match rest.next()? {
            ':' => Some(prefix.len() + 1),
            c if is_js_whitespace(c) => {
                (rest.next()? == ':').then(|| prefix.len() + c.len_utf8() + 1)
            }
            _ => None,
        }
    })
}

/// `normalizeEmailSubject(subject)`: the subject without its reply/forward
/// prefixes ("Re: Fwd: AW: x" → "x").
pub fn normalize_email_subject(subject: Option<&str>) -> String {
    let Some(subject) = subject.filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let mut rest = weldsuite_kit::validation::js_trim(subject);
    while let Some(len) = subject_prefix_len(rest) {
        rest = weldsuite_kit::validation::js_trim(&rest[len..]);
    }
    rest.to_owned()
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

/// `findDeskEmailConversation(db, email)`: the conversation an inbound email
/// belongs to, the one its In-Reply-To / References point at, else a recent
/// one from the same sender with the same subject (a client that dropped the
/// headers). Never by sender alone: a new subject from the same customer is a
/// new conversation.
pub async fn find_desk_email_conversation(
    db: &PgPool,
    from_email: &str,
    subject: Option<&str>,
    in_reply_to: Option<&str>,
    references: &[String],
) -> Result<Option<Value>, sqlx::Error> {
    let title = normalize_email_subject(subject);
    let mut ids: Vec<Option<&str>> = vec![in_reply_to];
    ids.extend(references.iter().map(|r| Some(r.as_str())));
    if let Some(found) = find_by_rfc_message_ids(db, &ids).await? {
        return Ok(Some(found));
    }
    find_recent(db, from_email, &title).await
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
    /// `slaCheckAt` (see [`crate::webchat::Appended`]).
    pub sla_check_at: Option<i64>,
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

    let conversation = find_desk_email_conversation(
        db,
        &from_email,
        Some(input.subject),
        input.in_reply_to,
        input.references,
    )
    .await?;

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
        let appended = append(
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
            sla_check_at: appended.sla_check_at,
            conversation: appended.conversation,
            message: appended.message,
            created: false,
        });
    }

    let appended = create_on_channel(
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
        sla_check_at: appended.sla_check_at,
        conversation: appended.conversation,
        message: appended.message,
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
        assert_eq!(normalize_email_subject(Some("Re: Fwd: Hello ")), "Hello");
        assert_eq!(normalize_email_subject(Some("FW:Hello")), "Hello");
        assert_eq!(
            normalize_email_subject(Some("AW: Antw: WG: Doorst: Hallo")),
            "Hallo"
        );
        assert_eq!(normalize_email_subject(Some("sv :vs: Hej")), "Hej");
        assert_eq!(normalize_email_subject(Some("re\u{a0}: x")), "x");
        assert_eq!(normalize_email_subject(Some("Re[2]: Hi")), "Re[2]: Hi");
        assert_eq!(
            normalize_email_subject(Some("Reminder: invoice")),
            "Reminder: invoice"
        );
        assert_eq!(normalize_email_subject(Some("Re:")), "");
        assert_eq!(normalize_email_subject(Some("Hello Re: x")), "Hello Re: x");
        assert_eq!(normalize_email_subject(None), "");
    }
}
