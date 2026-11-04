//! `services/inbound.ts`: one inbound message of a WeldReach mailbox.
//!
//!   1. parse, de-duplicate on Message-ID, ignore mail from our own mailboxes;
//!   2. decide the kind: `bounce`, `auto_reply` or `reply`;
//!   3. match it to what we sent (In-Reply-To / References / a bounce's
//!      original Message-ID, else the sender or failed recipient against the
//!      prospects with an enrollment on this mailbox);
//!   4. store the raw message in `STORAGE` and a `reach_messages` row;
//!   5. apply the effects: stop the sequence, suppress, move the counters;
//!   6. publish `reach_reply:received`, hand a human reply to the CRM and
//!      settle its label.
//!
//! Steps 1-5 fail on a database error (the handler then parks the raw
//! message) and are safe to run twice. Step 6 is best effort.
//!
//! The AI classification of step 6 is not available on these editions (no
//! AI port, as for WeldMail AI): a reply that would be classified gets the
//! label `unclassified`, as reach-api does when the model is not
//! configured, and a person labels it in the inbox.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    REACH_CAMPAIGN_COMPLETED, REACH_REPLY_CLASSIFIED, REACH_REPLY_RECEIVED,
};
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynFileStore, PutOptions};
use weldsuite_reach_domain::text::{make_snippet, strip_quoted_history};
use weldsuite_reach_domain::{
    EventSink, NoEvents, ReachError, ReachEvent, ReachResult, iso, js_slice, text,
};

use super::bounce::BounceInfo;
use super::parse::{ParsedInbound, parse_inbound, synthetic_message_id};
use super::rules::{classify_inbound, is_unsubscribe_request, looks_like_bulk};
use crate::effects::{
    Target, apply_unsubscribe, bump_campaign_stat, flag_prospects_suppressed,
    stop_other_enrollments, suppress_address, transition_enrollment,
};

const MAX_SUBJECT: usize = 500;
const MAX_EMAIL: usize = 320;
const SNIPPET: usize = 500;
const STOPPABLE: &[&str] = &["queued", "active", "paused", "completed"];
const LIVE: &[&str] = &["queued", "active", "paused"];

/// The mailbox a message arrived at (`InboundMailbox`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundMailbox {
    pub id: String,
    pub email: String,
}

/// `DeliverInboundResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliverResult {
    Stored {
        message_id: String,
        kind: &'static str,
        matched: bool,
        thread_key: String,
        label: Option<&'static str>,
    },
    Duplicate {
        message_id_header: String,
    },
    /// `own_mailbox`.
    Ignored {
        reason: &'static str,
    },
}

impl DeliverResult {
    /// As the TypeScript result object.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Stored {
                message_id,
                kind,
                matched,
                thread_key,
                label,
            } => json!({
                "status": "stored",
                "messageId": message_id,
                "kind": kind,
                "matched": matched,
                "threadKey": thread_key,
                "label": label,
            }),
            Self::Duplicate { message_id_header } => {
                json!({ "status": "duplicate", "messageIdHeader": message_id_header })
            }
            Self::Ignored { reason } => json!({ "status": "ignored", "reason": reason }),
        }
    }
}

/// What a delivery needs (`DeliverInboundInput`).
pub struct DeliverInput<'a> {
    pub db: &'a PgPool,
    /// The workspace's Clerk org id: the raw copy's key prefix.
    pub clerk_org_id: &'a str,
    pub mailbox: &'a InboundMailbox,
    pub raw: &'a [u8],
    /// `raw` parsed already (the handler parses it once for the warmup
    /// screen).
    pub parsed: Option<ParsedInbound>,
    /// `STORAGE`.
    pub storage: Option<Arc<dyn DynFileStore>>,
    pub events: &'a dyn EventSink,
    pub now: OffsetDateTime,
}

/// `InboundMatch`: rows as Drizzle reads them.
#[derive(Debug, Clone, Default)]
pub struct InboundMatch {
    pub message: Option<Value>,
    pub enrollment: Option<Value>,
    pub prospect: Option<Value>,
    pub campaign: Option<Value>,
    /// `header`, `sender` or `none`.
    pub how: &'static str,
}

/// `r2KeyFor(clerkOrgId, messageRowId)`.
pub fn r2_key_for(clerk_org_id: &str, message_row_id: &str) -> String {
    format!("reach/{clerk_org_id}/{message_row_id}.eml")
}

/// `candidateMessageIds(parsed, bounce)`: most specific first.
pub fn candidate_message_ids(parsed: &ParsedInbound, bounce: Option<&BounceInfo>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(id) = bounce.and_then(|b| b.original_message_id.clone()) {
        ids.push(id);
    }
    if let Some(id) = parsed.in_reply_to.clone() {
        ids.push(id);
    }
    ids.extend(parsed.references.iter().rev().cloned());
    weldsuite_reach_domain::unique(&ids)
}

async fn one(db: &PgPool, sql: &'static str, id: &str) -> ReachResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(sql).bind(id).fetch_optional(db).await?;
    Ok(row.map(weldsuite_db::js_row))
}

async fn find_stored_message(db: &PgPool, ids: &[String]) -> ReachResult<Option<Value>> {
    if ids.is_empty() {
        return Ok(None);
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_messages t where t.message_id_header = any($1)",
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    let rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
    Ok(ids.iter().find_map(|id| {
        rows.iter()
            .find(|row| text(row, "messageIdHeader") == Some(id.as_str()))
            .cloned()
    }))
}

async fn find_prospect_by_id(db: &PgPool, id: Option<&str>) -> ReachResult<Option<Value>> {
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    one(
        db,
        "select to_jsonb(t) from reach_prospects t where t.id = $1 and t.deleted_at is null limit 1",
        id,
    )
    .await
}

async fn find_prospect_by_email(db: &PgPool, emails: &[String]) -> ReachResult<Option<Value>> {
    if emails.is_empty() {
        return Ok(None);
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_prospects t where t.email = any($1) and t.deleted_at is null",
    )
    .bind(emails)
    .fetch_all(db)
    .await?;
    let rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
    Ok(emails.iter().find_map(|email| {
        rows.iter()
            .find(|row| text(row, "email") == Some(email.as_str()))
            .cloned()
    }))
}

async fn find_enrollment_by_id(db: &PgPool, id: Option<&str>) -> ReachResult<Option<Value>> {
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    one(
        db,
        "select to_jsonb(t) from reach_enrollments t where t.id = $1 limit 1",
        id,
    )
    .await
}

async fn find_enrollment_on_mailbox(
    db: &PgPool,
    prospect_id: &str,
    mailbox_id: &str,
) -> ReachResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_enrollments t where t.prospect_id = $1 and t.mailbox_id = $2
         order by t.updated_at desc, t.id desc limit 1",
    )
    .bind(prospect_id)
    .bind(mailbox_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

async fn find_campaign(db: &PgPool, id: Option<&str>) -> ReachResult<Option<Value>> {
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    one(
        db,
        "select to_jsonb(t) from reach_campaigns t where t.id = $1 limit 1",
        id,
    )
    .await
}

/// `matchInbound(db, input)`: by header first, else by the sender (or a
/// bounce's failed recipients) among the prospects.
pub async fn match_inbound(
    db: &PgPool,
    mailbox_id: &str,
    parsed: &ParsedInbound,
    bounce: Option<&BounceInfo>,
    sender_email: &str,
) -> ReachResult<InboundMatch> {
    let message = find_stored_message(db, &candidate_message_ids(parsed, bounce)).await?;
    let mut enrollment =
        find_enrollment_by_id(db, message.as_ref().and_then(|m| text(m, "enrollmentId"))).await?;
    let prospect_ref = message
        .as_ref()
        .and_then(|m| text(m, "prospectId"))
        .or_else(|| enrollment.as_ref().and_then(|e| text(e, "prospectId")))
        .map(str::to_owned);
    let mut prospect = find_prospect_by_id(db, prospect_ref.as_deref()).await?;
    let header_match = message.is_some();
    if prospect.is_none() {
        let emails = match bounce {
            Some(b) => b.recipients.clone(),
            None if sender_email.is_empty() => Vec::new(),
            None => vec![sender_email.to_owned()],
        };
        prospect = find_prospect_by_email(db, &emails).await?;
    }
    if let Some(p) = &prospect
        && enrollment.is_none()
    {
        enrollment =
            find_enrollment_on_mailbox(db, text(p, "id").unwrap_or_default(), mailbox_id).await?;
    }
    let campaign_ref = enrollment
        .as_ref()
        .and_then(|e| text(e, "campaignId"))
        .or_else(|| message.as_ref().and_then(|m| text(m, "campaignId")))
        .map(str::to_owned);
    let campaign = find_campaign(db, campaign_ref.as_deref()).await?;
    let how = if header_match {
        "header"
    } else if prospect.is_some() {
        "sender"
    } else {
        "none"
    };
    Ok(InboundMatch {
        message,
        enrollment,
        prospect,
        campaign,
        how,
    })
}

/// `resolveThreadKey(match, ownMessageId)`.
pub fn resolve_thread_key(matched: &InboundMatch, own_message_id: &str) -> String {
    if let Some(message) = &matched.message {
        return text(message, "threadKey")
            .or_else(|| text(message, "messageIdHeader"))
            .unwrap_or_default()
            .to_owned();
    }
    matched
        .enrollment
        .as_ref()
        .and_then(|e| text(e, "threadRootMessageId"))
        .unwrap_or(own_message_id)
        .to_owned()
}

fn bounce_snippet(bounce: &BounceInfo, body: &str) -> String {
    let target = bounce
        .recipients
        .first()
        .map_or("the recipient", String::as_str);
    let status = bounce
        .status
        .as_deref()
        .map(|s| format!(" ({s})"))
        .unwrap_or_default();
    let detail = bounce.diagnostic.as_deref().unwrap_or(body);
    make_snippet(
        &format!("Delivery to {target} failed{status}. {detail}"),
        SNIPPET,
    )
}

async fn message_id_taken(db: &PgPool, header: &str) -> ReachResult<bool> {
    let row: Option<String> =
        sqlx::query_scalar("select id from reach_messages where message_id_header = $1 limit 1")
            .bind(header)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

async fn is_own_mailbox(db: &PgPool, email: &str) -> ReachResult<bool> {
    if email.is_empty() {
        return Ok(false);
    }
    let row: Option<String> =
        sqlx::query_scalar("select id from reach_mailboxes where email = $1 limit 1")
            .bind(email)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

/// `readStopScope(db)`.
async fn read_stop_scope(db: &PgPool) -> ReachResult<String> {
    let scope: Option<Option<String>> =
        sqlx::query_scalar("select stop_on_reply_scope from reach_settings limit 1")
            .fetch_optional(db)
            .await?;
    Ok(scope.flatten().unwrap_or_else(|| "prospect".to_owned()))
}

/// Everything decided before anything is written (`Analysis`).
struct Analysis {
    parsed: ParsedInbound,
    message_id_header: String,
    sender_email: String,
    bounce: Option<BounceInfo>,
    matched: InboundMatch,
    kind: &'static str,
    reply_text: String,
    opt_out: bool,
    thread_key: String,
}

/// `analyze(input)`: parse, de-duplicate, classify and match.
async fn analyze(input: &mut DeliverInput<'_>) -> ReachResult<Result<Analysis, DeliverResult>> {
    let parsed = match input.parsed.take() {
        Some(parsed) => parsed,
        None => parse_inbound(input.raw).map_err(ReachError::internal)?,
    };
    let message_id_header = parsed
        .message_id
        .clone()
        .unwrap_or_else(|| synthetic_message_id(input.raw));
    if message_id_taken(input.db, &message_id_header).await? {
        return Ok(Err(DeliverResult::Duplicate { message_id_header }));
    }
    let sender_email = parsed
        .from
        .as_ref()
        .map(|f| f.email.clone())
        .unwrap_or_default();
    if is_own_mailbox(input.db, &sender_email).await? {
        return Ok(Err(DeliverResult::Ignored {
            reason: "own_mailbox",
        }));
    }
    let classification = classify_inbound(&parsed);
    let matched = match_inbound(
        input.db,
        &input.mailbox.id,
        &parsed,
        classification.bounce.as_ref(),
        &sender_email,
    )
    .await?;
    // Newsletters and list mail that answer nothing we sent are noise.
    let kind = if classification.kind == "reply"
        && matched.how == "none"
        && looks_like_bulk(&parsed.headers)
    {
        "auto_reply"
    } else {
        classification.kind
    };
    let reply_text = if kind == "bounce" {
        String::new()
    } else {
        strip_quoted_history(&parsed.text)
    };
    let opt_out = kind == "reply" && is_unsubscribe_request(&parsed.subject, &reply_text);
    let thread_key = resolve_thread_key(&matched, &message_id_header);
    Ok(Ok(Analysis {
        parsed,
        message_id_header,
        sender_email,
        bounce: classification.bounce,
        matched,
        kind,
        reply_text,
        opt_out,
        thread_key,
    }))
}

async fn put_raw(storage: Option<&Arc<dyn DynFileStore>>, key: &str, raw: &[u8]) -> Option<String> {
    let storage = storage?;
    let options = PutOptions {
        content_type: Some("message/rfc822".to_owned()),
        ..PutOptions::default()
    };
    match storage.put_boxed(key, raw.to_vec(), &options).await {
        Ok(_) => Some(key.to_owned()),
        Err(error) => {
            tracing::error!(%error, "[reach-inbound] raw message storage failed");
            None
        }
    }
}

/// `storeInbound(input, a, now)`: the raw copy and the row; `None` when a
/// second delivery of the same message won the race.
async fn store_inbound(input: &DeliverInput<'_>, a: &Analysis) -> ReachResult<Option<Value>> {
    let id = generate_id("rmsg");
    let key = put_raw(
        input.storage.as_ref(),
        &r2_key_for(input.clerk_org_id, &id),
        input.raw,
    )
    .await;
    let now = iso(input.now);
    let system = a.kind != "reply";
    let campaign_id = a
        .matched
        .campaign
        .as_ref()
        .and_then(|c| text(c, "id"))
        .or_else(|| {
            a.matched
                .message
                .as_ref()
                .and_then(|m| text(m, "campaignId"))
        });
    let snippet = match &a.bounce {
        Some(bounce) => bounce_snippet(bounce, &a.parsed.text),
        None => make_snippet(&a.reply_text, SNIPPET),
    };
    let from = if a.sender_email.is_empty() {
        "unknown"
    } else {
        a.sender_email.as_str()
    };
    let references = (!a.parsed.references.is_empty()).then(|| a.parsed.references.join(" "));
    let subject = (!a.parsed.subject.is_empty()).then(|| js_slice(&a.parsed.subject, MAX_SUBJECT));
    let row: Option<Value> = sqlx::query_scalar(
        "insert into reach_messages (id, direction, campaign_id, enrollment_id, mailbox_id, prospect_id,
             thread_key, message_id_header, in_reply_to, \"references\", from_email, to_email, subject,
             snippet, r2_key, kind, received_at, read_at, handled_at, handled_by, label, label_source,
             classified_at)
         values ($1, 'in', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16::timestamptz,
             case when $17 then $16::timestamptz end,
             case when $17 then $16::timestamptz end,
             case when $17 then 'system' end,
             case when $18 then 'unsubscribe' end,
             case when $18 then 'rule' end,
             case when $18 then $16::timestamptz end)
         on conflict (message_id_header) do nothing
         returning to_jsonb(reach_messages)",
    )
    .bind(&id)
    .bind(campaign_id)
    .bind(a.matched.enrollment.as_ref().and_then(|e| text(e, "id")))
    .bind(&input.mailbox.id)
    .bind(a.matched.prospect.as_ref().and_then(|p| text(p, "id")))
    .bind(js_slice(&a.thread_key, 255))
    .bind(&a.message_id_header)
    .bind(a.parsed.in_reply_to.as_deref())
    .bind(references)
    .bind(js_slice(from, MAX_EMAIL))
    .bind(js_slice(&input.mailbox.email, MAX_EMAIL))
    .bind(subject)
    .bind(snippet)
    .bind(key.as_deref())
    .bind(a.kind)
    .bind(&now)
    .bind(system)
    .bind(a.opt_out)
    .fetch_optional(input.db)
    .await?;
    if row.is_none()
        && let (Some(key), Some(storage)) = (&key, &input.storage)
    {
        let _ = storage.delete_boxed(key).await;
    }
    Ok(row.map(weldsuite_db::js_row))
}

fn prospect_target(prospect: Option<&Value>) -> Option<(String, String, Option<String>)> {
    prospect.map(|p| {
        (
            text(p, "id").unwrap_or_default().to_owned(),
            text(p, "email").unwrap_or_default().to_owned(),
            text(p, "companyDomain").map(str::to_owned),
        )
    })
}

fn id_of(row: Option<&Value>) -> Option<&str> {
    row.and_then(|r| text(r, "id"))
}

/// `applyReplyEffects`: end the sequence(s), or honour an opt-out.
async fn apply_reply_effects(db: &PgPool, message: &Value, a: &Analysis) -> ReachResult<()> {
    let m = &a.matched;
    if a.opt_out {
        return apply_unsubscribe(
            db,
            &Target {
                message_id: text(message, "id").unwrap_or_default().to_owned(),
                sender_email: a.sender_email.clone(),
                prospect: prospect_target(m.prospect.as_ref()),
                enrollment_id: id_of(m.enrollment.as_ref()).map(str::to_owned),
                campaign_id: id_of(m.campaign.as_ref()).map(str::to_owned),
                previous_label: None,
            },
        )
        .await;
    }
    if let Some(enrollment) = id_of(m.enrollment.as_ref())
        && transition_enrollment(db, enrollment, "replied", "replied", STOPPABLE).await?
    {
        bump_campaign_stat(db, id_of(m.campaign.as_ref()), "replied", 1).await?;
    }
    if let Some(prospect) = &m.prospect {
        let scope = read_stop_scope(db).await?;
        stop_other_enrollments(
            db,
            text(prospect, "id").unwrap_or_default(),
            text(prospect, "companyDomain"),
            &scope,
            id_of(m.enrollment.as_ref()),
            false,
        )
        .await?;
    }
    Ok(())
}

/// `applyBounceEffects`: end the sequence, suppress a bad address, count it
/// against the mailbox and the campaign.
async fn apply_bounce_effects(
    db: &PgPool,
    message: &Value,
    mailbox: &InboundMailbox,
    a: &Analysis,
    bounce: &BounceInfo,
    now: OffsetDateTime,
) -> ReachResult<()> {
    if !bounce.permanent {
        return Ok(());
    }
    let m = &a.matched;
    let reason = format!("bounced:{}", bounce.status.as_deref().unwrap_or("unknown"));
    if let Some(enrollment) = id_of(m.enrollment.as_ref())
        && transition_enrollment(db, enrollment, "bounced", &reason, STOPPABLE).await?
    {
        bump_campaign_stat(db, id_of(m.campaign.as_ref()), "bounced", 1).await?;
    }
    if bounce.address_rejected {
        let failed: Vec<String> = if bounce.recipients.is_empty() {
            m.prospect
                .as_ref()
                .map(|p| vec![text(p, "email").unwrap_or_default().to_owned()])
                .unwrap_or_default()
        } else {
            bounce.recipients.clone()
        };
        for email in &failed {
            suppress_address(db, email, "bounced", text(message, "id")).await?;
        }
        flag_prospects_suppressed(db, &failed).await?;
    }
    // After the enrollment is marked bounced: the guardrail counts them.
    // reach-api passes no hooks here, so a pause publishes nothing. The
    // window is measured from the delivery's own clock, as in reach-api.
    weldsuite_reach_domain::engine::guardrails::record_hard_bounce(
        db,
        Some(&mailbox.id),
        id_of(m.campaign.as_ref()),
        &NoEvents,
        now,
    )
    .await?;
    Ok(())
}

/// `applyAutoReplyEffects`: the sequence goes on unless the campaign stops
/// on auto-replies.
async fn apply_auto_reply_effects(db: &PgPool, a: &Analysis) -> ReachResult<()> {
    let m = &a.matched;
    let stops = m
        .campaign
        .as_ref()
        .is_some_and(|c| c.get("stopOnAutoReply") == Some(&Value::Bool(true)));
    if let (true, Some(enrollment)) = (stops, id_of(m.enrollment.as_ref())) {
        transition_enrollment(db, enrollment, "replied", "auto_reply", LIVE).await?;
    }
    Ok(())
}

async fn apply_effects(
    db: &PgPool,
    message: &Value,
    mailbox: &InboundMailbox,
    a: &Analysis,
    now: OffsetDateTime,
) -> ReachResult<()> {
    match (&a.bounce, a.kind) {
        (Some(bounce), "bounce") => {
            apply_bounce_effects(db, message, mailbox, a, bounce, now).await
        }
        (_, "auto_reply") => apply_auto_reply_effects(db, a).await,
        _ => apply_reply_effects(db, message, a).await,
    }
}

/// `replyEventData(message)`.
pub fn reply_event_data(message: &Value) -> Map<String, Value> {
    let mut data = Map::new();
    for key in [
        "id",
        "threadKey",
        "kind",
        "mailboxId",
        "campaignId",
        "enrollmentId",
        "prospectId",
        "fromEmail",
        "subject",
        "receivedAt",
    ] {
        data.insert(
            key.to_owned(),
            message.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    data
}

/// `deliverInbound(input)`.
pub async fn deliver_inbound(mut input: DeliverInput<'_>) -> ReachResult<DeliverResult> {
    let a = match analyze(&mut input).await? {
        Ok(a) => a,
        Err(skip) => return Ok(skip),
    };
    let Some(stored) = store_inbound(&input, &a).await? else {
        return Ok(DeliverResult::Duplicate {
            message_id_header: a.message_id_header,
        });
    };
    let stored_id = text(&stored, "id").unwrap_or_default().to_owned();
    if let Err(error) = apply_effects(input.db, &stored, input.mailbox, &a, input.now).await {
        // Not stored means redeliverable: drop the row so a replay is not
        // de-duplicated away.
        let _ = sqlx::query("delete from reach_messages where id = $1")
            .bind(&stored_id)
            .execute(input.db)
            .await;
        return Err(error);
    }
    finish_inbound(&input, &stored, &a).await;
    Ok(DeliverResult::Stored {
        message_id: stored_id,
        kind: a.kind,
        matched: a.matched.how != "none",
        thread_key: a.thread_key,
        label: a.opt_out.then_some("unsubscribe"),
    })
}

/// `completeCampaignIfFinished`: `reach_campaign:completed` with
/// `{ id, name, status }`.
async fn complete_campaign_if_finished(
    db: &PgPool,
    events: &dyn EventSink,
    campaign_id: Option<&str>,
) {
    let Some(campaign_id) = campaign_id else {
        return;
    };
    match weldsuite_reach_domain::campaigns::complete_if_done(db, campaign_id).await {
        Ok(Some(done)) => {
            let id = text(&done, "id").unwrap_or_default().to_owned();
            events.emit(ReachEvent::new(
                REACH_CAMPAIGN_COMPLETED,
                &id,
                json!({ "id": id, "name": done.get("name"), "status": done.get("status") }),
            ));
        }
        Ok(None) => {}
        Err(error) => {
            tracing::error!(error = %error.message, "[reach-inbound] campaign completion check failed");
        }
    }
}

/// The best-effort tail: campaign completion, events, the CRM hand-off and
/// the label of a reply that answers something we sent.
async fn finish_inbound(input: &DeliverInput<'_>, message: &Value, a: &Analysis) {
    let db = input.db;
    let m = &a.matched;
    complete_campaign_if_finished(db, input.events, id_of(m.campaign.as_ref())).await;
    let id = text(message, "id").unwrap_or_default().to_owned();
    input.events.emit(ReachEvent::new(
        REACH_REPLY_RECEIVED,
        &id,
        Value::Object(reply_event_data(message)),
    ));
    if a.opt_out {
        let mut data = reply_event_data(message);
        data.insert("label".to_owned(), json!("unsubscribe"));
        data.insert("labelSource".to_owned(), json!("rule"));
        input.events.emit(ReachEvent::new(
            REACH_REPLY_CLASSIFIED,
            &id,
            Value::Object(data),
        ));
    }
    if a.kind != "reply" || a.opt_out {
        return;
    }
    if let Some(prospect) = &m.prospect
        && let Err(error) =
            crate::crm::hand_off_reply(db, input.events, prospect, m.campaign.as_ref(), message)
                .await
    {
        tracing::error!(error = %error, "[reach-inbound] CRM hand-off failed");
    }
    if m.how != "none" {
        settle_unclassified(db, &id).await;
    }
}

/// `classifyStoredReply` with the model unavailable: an unlabelled reply
/// becomes `unclassified`.
async fn settle_unclassified(db: &PgPool, id: &str) {
    let result = sqlx::query(
        "update reach_messages set label = 'unclassified', updated_at = $2::timestamptz
         where id = $1 and (label_source is null or label_source = 'ai') and label is null",
    )
    .bind(id)
    .bind(iso(weldsuite_reach_domain::now()))
    .execute(db)
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "[reach-classify] could not record the outcome");
    }
}
