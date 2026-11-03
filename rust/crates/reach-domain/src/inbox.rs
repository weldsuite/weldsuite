//! `inbox.ts`: the reply inbox's threads, one thread's messages, and
//! answering a reply.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ports::BoxFuture;

use crate::access::may_send;
use crate::outbound::{OutboundDeps, SendInput, send_from_mailbox};
use crate::suppressions::load_index;
use crate::text::{html_to_text, reply_subject, strip_quoted_history};
use crate::{ReachError, ReachResult, field, iso, js_rows, now, text};

/// `DEFAULT_PAGE_SIZE`.
pub const DEFAULT_PAGE_SIZE: i64 = 25;
const MAX_BODIES: usize = 30;
const MAX_REFERENCES: usize = 20;

/// `toMessageDto(row, bodyText)`.
pub fn to_message_dto(row: &Value, body_text: Option<Value>) -> Value {
    json!({
        "id": field(row, "id"),
        "direction": field(row, "direction"),
        "campaignId": field(row, "campaignId"),
        "stepId": field(row, "stepId"),
        "mailboxId": field(row, "mailboxId"),
        "prospectId": field(row, "prospectId"),
        "threadKey": field(row, "threadKey"),
        "fromEmail": field(row, "fromEmail"),
        "toEmail": field(row, "toEmail"),
        "subject": field(row, "subject"),
        "snippet": field(row, "snippet"),
        "bodyText": body_text.unwrap_or_else(|| field(row, "bodyText")),
        "status": field(row, "status"),
        "kind": field(row, "kind"),
        "label": field(row, "label"),
        "labelSource": field(row, "labelSource"),
        "readAt": field(row, "readAt"),
        "handledAt": field(row, "handledAt"),
        "sentAt": field(row, "sentAt"),
        "receivedAt": field(row, "receivedAt"),
    })
}

/// `ReachInboxFilter` (validated by the route).
#[derive(Debug, Clone, Default)]
pub struct InboxFilter {
    pub label: Option<String>,
    pub kind: Option<String>,
    pub campaign_id: Option<String>,
    pub mailbox_id: Option<String>,
    pub state: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

/// `decodeCursor(cursor)`: (receivedAt ISO, id).
pub fn decode_cursor(cursor: Option<&str>) -> Option<(String, String)> {
    let cursor = cursor.filter(|c| !c.is_empty())?;
    let at = cursor.find('_').filter(|at| *at > 0)?;
    let ms: f64 = crate::text::js_trim(&cursor[..at]).parse().ok()?;
    let id = &cursor[at + 1..];
    if !ms.is_finite() || id.is_empty() {
        return None;
    }
    Some((iso(crate::from_epoch_ms(ms as i64)), id.to_owned()))
}

/// The latest inbound message per thread, as SQL (`latestInbound`).
macro_rules! latest_inbound {
    () => {
        "(select distinct on (thread_key) id, thread_key, received_at, kind, label, read_at, handled_at, campaign_id, mailbox_id
          from reach_messages where direction = 'in' and thread_key is not null
          order by thread_key, received_at desc, id desc) latest"
    };
}

macro_rules! inbox_filters {
    () => {
        " ($1::text is null or latest.label = $1) and ($2::text is null or latest.kind = $2)
          and ($3::text is null or latest.campaign_id = $3) and ($4::text is null or latest.mailbox_id = $4)
          and (case $5 when 'unread' then latest.read_at is null when 'open' then latest.handled_at is null
               when 'handled' then latest.handled_at is not null else true end)"
    };
}

async fn summarize(db: &PgPool, latest_rows: &[Value]) -> ReachResult<Vec<Value>> {
    if latest_rows.is_empty() {
        return Ok(Vec::new());
    }
    let thread_keys: Vec<String> = latest_rows
        .iter()
        .filter_map(|r| text(r, "threadKey").map(str::to_owned))
        .collect();
    let prospect_ids = crate::unique(
        &latest_rows
            .iter()
            .filter_map(|r| text(r, "prospectId").map(str::to_owned))
            .collect::<Vec<_>>(),
    );
    let campaign_ids = crate::unique(
        &latest_rows
            .iter()
            .filter_map(|r| text(r, "campaignId").map(str::to_owned))
            .collect::<Vec<_>>(),
    );
    let mailbox_ids = crate::unique(
        &latest_rows
            .iter()
            .filter_map(|r| text(r, "mailboxId").map(str::to_owned))
            .collect::<Vec<_>>(),
    );
    let counts: Vec<(Option<String>, i64)> =
        sqlx::query_as("select thread_key, count(*) from reach_messages where thread_key = any($1) group by thread_key")
            .bind(&thread_keys)
            .fetch_all(db)
            .await?;
    let prospects: Vec<Value> = if prospect_ids.is_empty() {
        Vec::new()
    } else {
        js_rows(
            sqlx::query_scalar("select to_jsonb(t) from reach_prospects t where t.id = any($1)")
                .bind(&prospect_ids)
                .fetch_all(db)
                .await?,
        )
    };
    let campaigns: Vec<(String, String)> = if campaign_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("select id, name from reach_campaigns where id = any($1)")
            .bind(&campaign_ids)
            .fetch_all(db)
            .await?
    };
    let mailboxes: Vec<(String, String)> =
        sqlx::query_as("select id, email from reach_mailboxes where id = any($1)")
            .bind(&mailbox_ids)
            .fetch_all(db)
            .await?;
    Ok(latest_rows
        .iter()
        .map(|row| {
            let prospect = text(row, "prospectId").and_then(|id| prospects.iter().find(|p| text(p, "id") == Some(id)));
            let campaign = text(row, "campaignId").and_then(|id| campaigns.iter().find(|c| c.0 == id));
            let mailbox_id = text(row, "mailboxId").unwrap_or_default();
            let mailbox_email = mailboxes
                .iter()
                .find(|m| m.0 == mailbox_id)
                .map_or_else(|| field(row, "toEmail"), |m| json!(m.1));
            let thread_key = text(row, "threadKey");
            json!({
                "threadKey": thread_key.map_or_else(|| field(row, "messageIdHeader"), |k| json!(k)),
                "prospect": prospect.map(|p| json!({
                    "id": field(p, "id"),
                    "email": field(p, "email"),
                    "firstName": field(p, "firstName"),
                    "lastName": field(p, "lastName"),
                    "companyName": field(p, "companyName"),
                    "personId": field(p, "personId"),
                })),
                "campaign": campaign.map(|c| json!({ "id": c.0, "name": c.1 })),
                "mailbox": { "id": mailbox_id, "email": mailbox_email },
                "lastInbound": {
                    "id": field(row, "id"),
                    "subject": field(row, "subject"),
                    "snippet": field(row, "snippet"),
                    "kind": row.get("kind").filter(|k| !k.is_null()).cloned().unwrap_or_else(|| json!("reply")),
                    "label": field(row, "label"),
                    "labelSource": field(row, "labelSource"),
                    "receivedAt": field(row, "receivedAt"),
                    "readAt": field(row, "readAt"),
                    "handledAt": field(row, "handledAt"),
                },
                "messageCount": counts.iter().find(|(k, _)| k.as_deref() == thread_key).map_or(1, |(_, n)| *n),
            })
        })
        .collect())
}

/// One page of threads (`ThreadPage`).
#[derive(Debug, Clone)]
pub struct ThreadPage {
    pub threads: Vec<Value>,
    pub total_count: i64,
    pub has_more: bool,
    pub cursor: Option<String>,
}

/// `listThreads(db, filter)`.
pub async fn list_threads(db: &PgPool, filter: &InboxFilter) -> ReachResult<ThreadPage> {
    let limit = filter.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let state = filter.state.clone().unwrap_or_else(|| "open".to_owned());
    let cursor = decode_cursor(filter.cursor.as_deref());
    let rows: Vec<(String,)> = sqlx::query_as(concat!(
        "select latest.id from ",
        latest_inbound!(),
        " where",
        inbox_filters!(),
        " and ($6::timestamptz is null or latest.received_at < $6::timestamptz
               or (latest.received_at = $6::timestamptz and latest.id < $7))
          order by latest.received_at desc, latest.id desc limit $8"
    ))
    .bind(&filter.label)
    .bind(&filter.kind)
    .bind(&filter.campaign_id)
    .bind(&filter.mailbox_id)
    .bind(&state)
    .bind(cursor.as_ref().map(|c| c.0.clone()))
    .bind(cursor.as_ref().map(|c| c.1.clone()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from ",
        latest_inbound!(),
        " where",
        inbox_filters!()
    ))
    .bind(&filter.label)
    .bind(&filter.kind)
    .bind(&filter.campaign_id)
    .bind(&filter.mailbox_id)
    .bind(&state)
    .fetch_one(db)
    .await?;
    let limit_usize = usize::try_from(limit).unwrap_or_default();
    let has_more = rows.len() > limit_usize;
    let page_ids: Vec<String> = rows.into_iter().take(limit_usize).map(|(id,)| id).collect();
    let messages: Vec<Value> = if page_ids.is_empty() {
        Vec::new()
    } else {
        js_rows(
            sqlx::query_scalar("select to_jsonb(t) from reach_messages t where t.id = any($1)")
                .bind(&page_ids)
                .fetch_all(db)
                .await?,
        )
    };
    let ordered: Vec<Value> = page_ids
        .iter()
        .filter_map(|id| {
            messages
                .iter()
                .find(|m| text(m, "id") == Some(id.as_str()))
                .cloned()
        })
        .collect();
    let cursor = if has_more {
        ordered.last().and_then(|last| {
            let received = text(last, "receivedAt").and_then(crate::parse_iso)?;
            Some(format!(
                "{}_{}",
                crate::epoch_ms(received),
                text(last, "id").unwrap_or_default()
            ))
        })
    } else {
        None
    };
    Ok(ThreadPage {
        threads: summarize(db, &ordered).await?,
        total_count: total,
        has_more,
        cursor,
    })
}

/// `countUnreadThreads(db)`.
pub async fn count_unread(db: &PgPool) -> ReachResult<i64> {
    Ok(sqlx::query_scalar(concat!(
        "select count(*) from ",
        latest_inbound!(),
        " where latest.read_at is null"
    ))
    .fetch_one(db)
    .await?)
}

/// `ThreadContext`.
#[derive(Debug, Clone)]
pub struct ThreadContext {
    pub thread_key: String,
    pub messages: Vec<Value>,
    pub latest_inbound: Value,
    pub prospect: Option<Value>,
    pub campaign: Option<Value>,
    pub mailbox: Option<Value>,
}

async fn one(db: &PgPool, sql: &'static str, id: &str) -> ReachResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(sql).bind(id).fetch_optional(db).await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `loadThread(db, threadKey)`: `None` without an inbound message.
pub async fn load_thread(db: &PgPool, thread_key: &str) -> ReachResult<Option<ThreadContext>> {
    let messages = js_rows(
        sqlx::query_scalar(
            "select to_jsonb(t) from reach_messages t where t.thread_key = $1
             order by coalesce(t.sent_at, t.received_at, t.created_at) asc, t.created_at asc, t.id asc",
        )
        .bind(thread_key)
        .fetch_all(db)
        .await?,
    );
    let Some(latest) = messages
        .iter()
        .rev()
        .find(|m| text(m, "direction") == Some("in"))
        .cloned()
    else {
        return Ok(None);
    };
    let prospect = match text(&latest, "prospectId") {
        Some(id) => {
            one(
                db,
                "select to_jsonb(t) from reach_prospects t where t.id = $1 limit 1",
                id,
            )
            .await?
        }
        None => None,
    };
    let campaign = match text(&latest, "campaignId") {
        Some(id) => {
            one(
                db,
                "select to_jsonb(t) from reach_campaigns t where t.id = $1 limit 1",
                id,
            )
            .await?
        }
        None => None,
    };
    let mailbox = one(
        db,
        "select to_jsonb(t) from reach_mailboxes t where t.id = $1 limit 1",
        text(&latest, "mailboxId").unwrap_or_default(),
    )
    .await?;
    Ok(Some(ThreadContext {
        thread_key: thread_key.to_owned(),
        messages,
        latest_inbound: latest,
        prospect,
        campaign,
        mailbox,
    }))
}

/// Where raw inbound replies are kept (`ReplyStorage`): the `STORAGE`
/// bucket; `None` without one.
pub trait ReplyStorage: Send + Sync {
    /// The object's bytes; `Ok(None)` when it is missing.
    fn get(&self, key: &str) -> BoxFuture<'_, Result<Option<Vec<u8>>, String>>;
}

/// `extractMessageText(raw)`: the text part, or the HTML part as text.
pub fn extract_message_text(raw: &[u8]) -> Result<String, String> {
    let email = weldsuite_mail_inbound::mime::parse(raw).map_err(|error| error.0)?;
    if let Some(text) = email.text.filter(|t| !crate::text::js_trim(t).is_empty()) {
        return Ok(text);
    }
    if let Some(html) = email.html.filter(|h| !crate::text::js_trim(h).is_empty()) {
        return Ok(html_to_text(&html));
    }
    Ok(String::new())
}

async fn inbound_body(storage: Option<&dyn ReplyStorage>, row: &Value) -> Value {
    let snippet = field(row, "snippet");
    let (Some(key), Some(storage)) = (text(row, "r2Key").filter(|k| !k.is_empty()), storage) else {
        return snippet;
    };
    match storage.get(key).await {
        Ok(Some(bytes)) => match extract_message_text(&bytes) {
            Ok(body) => {
                let text = strip_quoted_history(&body);
                if text.is_empty() {
                    snippet
                } else {
                    json!(text)
                }
            }
            Err(error) => {
                tracing::error!(%error, "[reach-inbox] reading a stored message failed");
                snippet
            }
        },
        Ok(None) => snippet,
        Err(error) => {
            tracing::error!(%error, "[reach-inbox] reading a stored message failed");
            snippet
        }
    }
}

/// `getThread(db, env, threadKey)`: (summary, messages).
pub async fn get_thread(
    db: &PgPool,
    storage: Option<&dyn ReplyStorage>,
    thread_key: &str,
) -> ReachResult<Option<(Value, Vec<Value>)>> {
    let Some(thread) = load_thread(db, thread_key).await? else {
        return Ok(None);
    };
    let Some(summary) = summarize(db, std::slice::from_ref(&thread.latest_inbound))
        .await?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let inbound: Vec<&Value> = thread
        .messages
        .iter()
        .filter(|m| text(m, "direction") == Some("in"))
        .collect();
    let recent: Vec<&str> = inbound
        .iter()
        .skip(inbound.len().saturating_sub(MAX_BODIES))
        .filter_map(|m| text(m, "id"))
        .collect();
    let mut messages = Vec::with_capacity(thread.messages.len());
    for row in &thread.messages {
        if text(row, "direction") == Some("in") {
            let body = if text(row, "id").is_some_and(|id| recent.contains(&id)) {
                inbound_body(storage, row).await
            } else {
                field(row, "snippet")
            };
            let body = if body.is_null() {
                field(row, "snippet")
            } else {
                body
            };
            messages.push(to_message_dto(row, Some(body)));
        } else {
            messages.push(to_message_dto(row, None));
        }
    }
    Ok(Some((summary, messages)))
}

/// `referenceChain(messages)`.
pub fn reference_chain(messages: &[Value]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for row in messages {
        if let Some(id) = text(row, "messageIdHeader")
            && !ids.iter().any(|i| i == id)
        {
            ids.push(id.to_owned());
        }
    }
    let skip = ids.len().saturating_sub(MAX_REFERENCES);
    ids.into_iter().skip(skip).collect()
}

fn recipient_name(prospect: Option<&Value>, email: &str) -> Option<String> {
    let prospect = prospect.filter(|p| text(p, "email") == Some(email))?;
    let name = [text(prospect, "firstName"), text(prospect, "lastName")]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!name.is_empty()).then_some(name)
}

/// The workspace's send permission (`maySend`'s input).
#[derive(Debug, Clone)]
pub struct AccessState {
    pub status: String,
    pub billing_status: String,
    pub billing_status_at: Option<String>,
}

/// `sendReply(deps, input)`: every check, then `replyToThread`; the sent
/// message's DTO.
pub async fn send_reply(
    deps: &OutboundDeps<'_>,
    access: &AccessState,
    sending_enabled: impl Future<Output = bool>,
    thread_key: &str,
    body: &str,
    user_id: &str,
) -> ReachResult<Value> {
    if let Err(reason) = may_send(access, (deps.now)()) {
        return Err(ReachError::forbidden(format!(
            "Sending is not available for this workspace ({reason})"
        )));
    }
    if !sending_enabled.await {
        return Err(ReachError::unavailable(
            "Sending is paused. Try again later.",
        ));
    }
    let db = deps.db;
    let Some(thread) = load_thread(db, thread_key).await? else {
        return Err(ReachError::not_found("Thread", Some(thread_key)));
    };
    let Some(answered) = thread
        .messages
        .iter()
        .rev()
        .find(|m| text(m, "direction") == Some("in") && text(m, "kind") == Some("reply"))
    else {
        return Err(ReachError::conflict("This thread has no reply to answer")
            .with_details(json!({ "reason": "NO_REPLY" })));
    };
    let to = text(answered, "fromEmail")
        .unwrap_or_default()
        .to_lowercase();
    if load_index(db, std::slice::from_ref(&to))
        .await?
        .check(&to)
        .is_some()
    {
        return Err(ReachError::conflict(
            "This address is on the suppression list; it cannot be emailed",
        )
        .with_details(json!({ "reason": "SUPPRESSED" })));
    }
    let subject_source = text(answered, "subject").or_else(|| {
        thread
            .messages
            .iter()
            .find_map(|m| text(m, "subject").filter(|s| !s.is_empty()))
    });
    let input = SendInput {
        mailbox_id: text(answered, "mailboxId").unwrap_or_default().to_owned(),
        to_name: recipient_name(thread.prospect.as_ref(), &to),
        to_email: to,
        subject: reply_subject(subject_source),
        text: body.to_owned(),
        append_footer: false,
        in_reply_to: text(answered, "messageIdHeader").map(str::to_owned),
        references: reference_chain(&thread.messages),
        thread_key: Some(thread.thread_key.clone()),
        campaign_id: text(answered, "campaignId").map(str::to_owned),
        enrollment_id: text(answered, "enrollmentId").map(str::to_owned),
        step_id: None,
        prospect_id: text(answered, "prospectId").map(str::to_owned),
        sent_by: Some(user_id.to_owned()),
    };
    let result = match send_from_mailbox(deps, &input).await {
        Ok(result) => result,
        Err(error) => {
            tracing::error!(%error, "[reach-inbox] reply send threw");
            return Err(ReachError::bad_gateway("The email could not be sent"));
        }
    };
    if !result.ok {
        return Err(ReachError::bad_gateway(result.error));
    }
    let at = iso(now());
    sqlx::query(
        "update reach_messages set read_at = $2::timestamptz, updated_at = $2::timestamptz
         where thread_key = $1 and direction = 'in' and read_at is null",
    )
    .bind(&thread.thread_key)
    .bind(&at)
    .execute(db)
    .await?;
    let message = result.message.unwrap_or(Value::Null);
    Ok(to_message_dto(&message, None))
}
