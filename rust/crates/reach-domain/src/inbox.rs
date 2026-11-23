//! `inbox.ts`: the reply inbox's threads, one thread's messages, and
//! answering a reply.

use sea_orm::sea_query::{Alias, Asterisk, Expr, Func, Query, SelectStatement};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, Order, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_ports::BoxFuture;
use weldsuite_schema::tenant::{
    reach_campaigns, reach_mailboxes, reach_messages as messages, reach_prospects,
};

use crate::access::may_send;
use crate::outbound::{OutboundDeps, SendInput, send_from_mailbox};
use crate::suppressions::load_index;
use crate::text::{html_to_text, reply_subject, strip_quoted_history};
use crate::{ReachError, ReachResult, field, iso, js, js_all, now, text};

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

/// The alias of [`latest_inbound`] in the thread queries.
fn latest() -> Alias {
    Alias::new("latest")
}

/// `latest.<column>`.
fn latest_col(column: messages::Column) -> Expr {
    Expr::col((latest(), column))
}

/// The latest inbound message per thread (`latestInbound`): `select distinct
/// on (thread_key) … order by thread_key, received_at desc, id desc`.
fn latest_inbound() -> SelectStatement {
    use messages::Column;
    Query::select()
        .distinct_on([Column::ThreadKey])
        .columns([
            Column::Id,
            Column::ThreadKey,
            Column::ReceivedAt,
            Column::Kind,
            Column::Label,
            Column::ReadAt,
            Column::HandledAt,
            Column::CampaignId,
            Column::MailboxId,
        ])
        .from(messages::Entity)
        .and_where(Column::Direction.eq("in"))
        .and_where(Column::ThreadKey.is_not_null())
        .order_by(Column::ThreadKey, Order::Asc)
        .order_by(Column::ReceivedAt, Order::Desc)
        .order_by(Column::Id, Order::Desc)
        .to_owned()
}

/// `select … from (latestInbound) latest`.
fn from_latest() -> SelectStatement {
    Query::select()
        .from_subquery(latest_inbound(), latest())
        .to_owned()
}

/// The thread filters over [`latest_inbound`]; the state is `unread`, `open`
/// or `handled` (anything else filters nothing).
fn inbox_filters(filter: &InboxFilter, state: &str) -> Condition {
    use sea_orm::ExprTrait as _;
    use messages::Column;
    let mut filters = Condition::all();
    for (column, value) in [
        (Column::Label, &filter.label),
        (Column::Kind, &filter.kind),
        (Column::CampaignId, &filter.campaign_id),
        (Column::MailboxId, &filter.mailbox_id),
    ] {
        if let Some(value) = value {
            filters = filters.add(latest_col(column).eq(value.as_str()));
        }
    }
    match state {
        "unread" => filters.add(latest_col(Column::ReadAt).is_null()),
        "open" => filters.add(latest_col(Column::HandledAt).is_null()),
        "handled" => filters.add(latest_col(Column::HandledAt).is_not_null()),
        _ => filters,
    }
}

/// `count(*)` of the threads `filters` keeps.
async fn count_threads(db: &PgPool, filters: Condition) -> Result<i64, DbErr> {
    let count = from_latest()
        .expr_as(Func::count(Expr::col(Asterisk)), Alias::new("count"))
        .cond_where(filters)
        .to_owned();
    let row = orm(db)
        .query_one(&count)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("count".to_owned()))?;
    row.try_get("", "count")
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
    let conn = orm(db);
    let counts: Vec<(Option<String>, i64)> = messages::Entity::find()
        .select_only()
        .column(messages::Column::ThreadKey)
        .expr(Func::count(Expr::col(Asterisk)))
        .filter(messages::Column::ThreadKey.is_in(thread_keys))
        .group_by(messages::Column::ThreadKey)
        .into_tuple()
        .all(&conn)
        .await?;
    let prospects: Vec<Value> = if prospect_ids.is_empty() {
        Vec::new()
    } else {
        js_all(
            reach_prospects::Entity::find()
                .filter(reach_prospects::Column::Id.is_in(prospect_ids))
                .all(&conn)
                .await?
                .into_iter()
                .map(serde_json::to_value),
        )?
    };
    let campaigns: Vec<(String, String)> = if campaign_ids.is_empty() {
        Vec::new()
    } else {
        reach_campaigns::Entity::find()
            .select_only()
            .column(reach_campaigns::Column::Id)
            .column(reach_campaigns::Column::Name)
            .filter(reach_campaigns::Column::Id.is_in(campaign_ids))
            .into_tuple()
            .all(&conn)
            .await?
    };
    let mailboxes: Vec<(String, String)> = reach_mailboxes::Entity::find()
        .select_only()
        .column(reach_mailboxes::Column::Id)
        .column(reach_mailboxes::Column::Email)
        .filter(reach_mailboxes::Column::Id.is_in(mailbox_ids))
        .into_tuple()
        .all(&conn)
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
    let rows = thread_ids(db, filter, &state, cursor.as_ref(), limit).await?;
    let total = count_threads(db, inbox_filters(filter, &state)).await?;
    let limit_usize = usize::try_from(limit).unwrap_or_default();
    let has_more = rows.len() > limit_usize;
    let page_ids: Vec<String> = rows.into_iter().take(limit_usize).collect();
    let messages: Vec<Value> = if page_ids.is_empty() {
        Vec::new()
    } else {
        js_all(
            messages::Entity::find()
                .filter(messages::Column::Id.is_in(page_ids.clone()))
                .all(&orm(db))
                .await?
                .into_iter()
                .map(serde_json::to_value),
        )?
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

/// The ids of one page of threads' latest inbound messages, newest first,
/// `limit + 1` of them.
async fn thread_ids(
    db: &PgPool,
    filter: &InboxFilter,
    state: &str,
    cursor: Option<&(String, String)>,
    limit: i64,
) -> Result<Vec<String>, DbErr> {
    use sea_orm::ExprTrait as _;
    use messages::Column;
    let mut filters = inbox_filters(filter, state);
    if let Some((at, id)) = cursor {
        let at: Option<OffsetDateTime> = crate::parse_iso(at);
        filters = filters.add(
            Condition::any()
                .add(latest_col(Column::ReceivedAt).lt(at))
                .add(
                    Condition::all()
                        .add(latest_col(Column::ReceivedAt).eq(at))
                        .add(latest_col(Column::Id).lt(id.as_str())),
                ),
        );
    }
    let page = from_latest()
        .expr(latest_col(Column::Id))
        .cond_where(filters)
        .order_by((latest(), Column::ReceivedAt), Order::Desc)
        .order_by((latest(), Column::Id), Order::Desc)
        .limit(crate::lists::probe(limit))
        .to_owned();
    orm(db)
        .query_all(&page)
        .await?
        .iter()
        .map(|row| row.try_get_by_index(0))
        .collect()
}

/// `countUnreadThreads(db)`.
pub async fn count_unread(db: &PgPool) -> ReachResult<i64> {
    use sea_orm::ExprTrait as _;
    Ok(count_threads(
        db,
        Condition::all().add(latest_col(messages::Column::ReadAt).is_null()),
    )
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

/// `loadThread(db, threadKey)`: `None` without an inbound message.
pub async fn load_thread(db: &PgPool, thread_key: &str) -> ReachResult<Option<ThreadContext>> {
    use messages::Column;
    let conn = orm(db);
    let messages = js_all(
        messages::Entity::find()
            .filter(Column::ThreadKey.eq(thread_key))
            .order_by_asc(Expr::from(Func::coalesce([
                Expr::col((messages::Entity, Column::SentAt)),
                Expr::col((messages::Entity, Column::ReceivedAt)),
                Expr::col((messages::Entity, Column::CreatedAt)),
            ])))
            .order_by_asc(Column::CreatedAt)
            .order_by_asc(Column::Id)
            .all(&conn)
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
    let Some(latest) = messages
        .iter()
        .rev()
        .find(|m| text(m, "direction") == Some("in"))
        .cloned()
    else {
        return Ok(None);
    };
    let prospect = match text(&latest, "prospectId") {
        Some(id) => reach_prospects::Entity::find_by_id(id)
            .one(&conn)
            .await?
            .map(serde_json::to_value)
            .map(js)
            .transpose()?,
        None => None,
    };
    let campaign = match text(&latest, "campaignId") {
        Some(id) => reach_campaigns::Entity::find_by_id(id)
            .one(&conn)
            .await?
            .map(serde_json::to_value)
            .map(js)
            .transpose()?,
        None => None,
    };
    let mailbox = reach_mailboxes::Entity::find_by_id(text(&latest, "mailboxId").unwrap_or_default())
        .one(&conn)
        .await?
        .map(serde_json::to_value)
        .map(js)
        .transpose()?;
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
    let at = now();
    messages::Entity::update_many()
        .col_expr(messages::Column::ReadAt, Expr::value(at))
        .col_expr(messages::Column::UpdatedAt, Expr::value(at))
        .filter(messages::Column::ThreadKey.eq(thread.thread_key.as_str()))
        .filter(messages::Column::Direction.eq("in"))
        .filter(messages::Column::ReadAt.is_null())
        .exec(&orm(db))
        .await?;
    let message = result.message.unwrap_or(Value::Null);
    Ok(to_message_dto(&message, None))
}
