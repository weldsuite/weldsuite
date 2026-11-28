//! Payment reminders (Rust only, edition feature `books-reminders`):
//! `POST /api/invoices/:id/remind`, `POST /api/invoices/remind-bulk`,
//! `PATCH /api/invoices/:id/reminders`, and [`send_due_reminders`] for the
//! daily books sweep.
//!
//! The workflow of an entity (steps, templates, which steps send
//! themselves) is `jurisdiction_settings.reminders`
//! ([`weldsuite_books_domain::reminders`]). An invoice's own state is
//! `reminder_level` (how many went out), `last_reminded_at` and
//! `reminders_paused` (migration M2); each reminder is also an entry in
//! `email_history` with its level.
//!
//! One e-mail covers the open invoices of one contact that are due the same
//! step, listing them all. An invoice that carries the statutory claim is
//! always mailed alone.
//!
//! # Statutory costs (NL, optional)
//!
//! The final step can claim the collection costs and interest. They are a
//! claim *stated in the notice* (and kept in the reminder's history entry as
//! `claim`), not part of the invoice and not booked when sent: when the
//! customer pays them, the extra money is booked from the bank line as other
//! income. A consumer first gets the 14-day notice; the costs are claimed by
//! sending the final reminder once more after the term.

use std::collections::{BTreeMap, HashMap};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::contact_page::paused_contacts;
use weldsuite_books_domain::contacts::with_contact_email;
use weldsuite_books_domain::email_templates::{Template, statutory_template};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::entity_settings;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, json_of, ok, reply};
use weldsuite_books_domain::js::millis_of;
use weldsuite_books_domain::reminders::{
    Claim, Debtor, NOTICE_DAYS, ReminderSettings, Step, cents_text, parse_cents, statutory_claim,
};
use weldsuite_catalogs::entity_events::{INVOICE_REMINDED, INVOICE_UPDATED};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_schema::tenant::{entities, invoices, parties};

use crate::delivery::view::{decimal, money};
use crate::delivery::{self, DeliveryError, InvoiceMail, history_of};
use crate::finalize::load_invoice;
use crate::invoices::row_json;
use crate::persist::{owned, text};

const DAY_MS: i64 = 86_400_000;

/// The statuses of an invoice that is open for a reminder.
const OPEN_STATUSES: [&str; 4] = ["sent", "finalized", "partial", "overdue"];

/// Why an invoice gets no reminder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Skip {
    NotOpen,
    NoNextStep,
    NoRecipient,
    NotFound,
    /// The contact's reminders are held (`remindersPaused` on the contact).
    ContactPaused,
}

impl Skip {
    fn code(self) -> &'static str {
        match self {
            Self::NotOpen => "not_open",
            Self::NoNextStep => "no_next_step",
            Self::NoRecipient => "no_recipient",
            Self::NotFound => "not_found",
            Self::ContactPaused => "contact_paused",
        }
    }
}

fn days_overdue(invoice: &Value, now_ms: i64) -> i64 {
    text(invoice, "dueDate")
        .and_then(millis_of)
        .map_or(0, |due| (now_ms - due).div_euclid(DAY_MS).max(0))
}

fn level_of(invoice: &Value) -> i32 {
    invoice
        .get("reminderLevel")
        .and_then(Value::as_i64)
        .and_then(|l| i32::try_from(l).ok())
        .unwrap_or(0)
}

fn is_open(invoice: &Value) -> bool {
    OPEN_STATUSES.contains(&text(invoice, "status").unwrap_or_default())
        && !matches!(text(invoice, "type"), Some("credit_note" | "proforma"))
        && parse_cents(&decimal(invoice.get("balanceDue"), "0")).unwrap_or(0) > 0
}

/// How the debtor is treated: a consumer is a person with no company and no
/// tax number on the invoice, everyone else is a business.
async fn debtor_of(db: &PgPool, invoice: &Value) -> Result<Debtor, DbErr> {
    let Some(contact) = text(invoice, "contactId").filter(|c| !c.is_empty()) else {
        return Ok(Debtor::Business);
    };
    let ids: Option<(Option<String>, Option<String>)> =
        parties::Entity::find_by_id(contact.to_owned())
            .select_only()
            .columns([parties::Column::CompanyId, parties::Column::PersonId])
            .into_tuple()
            .one(&orm(db))
            .await?;
    let no_tax_number = owned(invoice, "contactTaxNumber").is_none_or(|n| n.trim().is_empty());
    Ok(match ids {
        Some((None, Some(_))) if no_tax_number => Debtor::Consumer,
        _ => Debtor::Business,
    })
}

/// When the consumer's 14-day notice went out, in days ago: the last
/// reminder entry that was a notice.
fn notice_age(invoice: &Value, now_ms: i64) -> Option<i64> {
    history_of(invoice)
        .iter()
        .rev()
        .filter(|e| text(e, "type") == Some("reminder"))
        .find(|e| e["claim"]["isNotice"] == json!(true))
        .and_then(|e| text(e, "at"))
        .and_then(millis_of)
        .map(|at| (now_ms - at).div_euclid(DAY_MS))
}

/// The claim the step makes for this invoice, when it carries one.
async fn claim_of(
    db: &PgPool,
    settings: &ReminderSettings,
    step: &Step,
    invoice: &Value,
    now_ms: i64,
) -> Result<Option<Claim>, DbErr> {
    if !settings.claims_statutory(step) {
        return Ok(None);
    }
    let principal = parse_cents(&decimal(invoice.get("balanceDue"), "0")).unwrap_or(0);
    let debtor = debtor_of(db, invoice).await?;
    Ok(Some(statutory_claim(
        principal,
        debtor,
        days_overdue(invoice, now_ms),
        notice_age(invoice, now_ms),
        &settings.statutory,
    )))
}

fn claim_json(claim: &Claim) -> Value {
    json!({
        "principal": cents_text(claim.principal),
        "costs": cents_text(claim.costs),
        "interest": cents_text(claim.interest),
        "total": cents_text(claim.total()),
        "costsDue": claim.costs_due,
        "isNotice": claim.is_notice,
    })
}

/// The step an invoice gets next: the one after its level, or (a consumer
/// whose 14-day term ran out) the final one again, to claim the costs.
async fn next_step_of<'a>(
    db: &PgPool,
    settings: &'a ReminderSettings,
    invoice: &Value,
    now_ms: i64,
) -> Result<Option<&'a Step>, DbErr> {
    let level = level_of(invoice);
    if let Some(step) = settings.next_step(level) {
        return Ok(Some(step));
    }
    // After the last step: a consumer's final notice can be followed by the claim.
    let Some(last) = settings
        .step(level)
        .filter(|s| settings.claims_statutory(s))
    else {
        return Ok(None);
    };
    let followed = notice_age(invoice, now_ms).is_some_and(|age| age > NOTICE_DAYS);
    let claimed = history_of(invoice)
        .iter()
        .any(|e| e["claim"]["costsDue"] == json!(true) && text(e, "type") == Some("reminder"));
    if followed && !claimed && debtor_of(db, invoice).await? == Debtor::Consumer {
        return Ok(Some(last));
    }
    Ok(None)
}

/// The mail for `group` (invoices of one contact, all at `step`): the
/// placeholders, the history extras and the default text of a statutory
/// notice.
struct Plan {
    vars: HashMap<&'static str, String>,
    extra: Map<String, Value>,
    fallback: Option<Template>,
}

fn plan_of(claim: Option<&Claim>, invoice: &Value, locale: &str) -> Plan {
    let currency = owned(invoice, "currency").unwrap_or_else(|| "EUR".to_owned());
    let mut vars = HashMap::new();
    let mut extra = Map::new();
    let mut fallback = None;
    let fmt = |cents: i64| money(&cents_text(cents), &currency, locale);
    vars.insert("noticeDays", NOTICE_DAYS.to_string());
    if let Some(claim) = claim {
        vars.insert("collectionCosts", fmt(claim.costs));
        vars.insert("interest", fmt(claim.interest));
        vars.insert("totalClaim", fmt(claim.total()));
        extra.insert("claim".into(), claim_json(claim));
        fallback = Some(statutory_template(locale, claim.is_notice));
    } else {
        let due = parse_cents(&decimal(invoice.get("balanceDue"), "0")).unwrap_or(0);
        vars.insert("totalClaim", fmt(due));
    }
    Plan {
        vars,
        extra,
        fallback,
    }
}

/// What went out for one group.
#[derive(Debug, Clone)]
pub(crate) struct Reminded {
    pub invoice_ids: Vec<String>,
    pub level: i32,
    pub sent: delivery::Sent,
    pub claim: Option<Value>,
}

/// Send the reminder of `step` for `group` (one contact's invoices) and
/// record it: level, time and history. The first invoice is what the text is
/// about.
pub(crate) async fn send_group(
    db: &PgPool,
    state: &BooksState,
    workspace_id: &str,
    settings: &ReminderSettings,
    step: &Step,
    group: Vec<Value>,
    now_ms: i64,
) -> Result<Reminded, DeliveryError> {
    let primary = group[0].clone();
    let primary = with_contact_email(db, primary).await?;
    let to = owned(&primary, "contactEmail").filter(|e| !e.trim().is_empty());
    let Some(to) = to else {
        return Err(DeliveryError::NoRecipient);
    };
    // A claim is never bundled.
    let claim = if group.len() == 1 {
        claim_of(db, settings, step, &primary, now_ms).await?
    } else {
        None
    };
    let locale = crate::delivery::view::invoice_locale(db, &primary).await?;
    let plan = plan_of(claim.as_ref(), &primary, locale);
    let mut extra = plan.extra;
    extra.insert("template".into(), json!(step.template));
    let sent = delivery::mail_invoices(
        db,
        state,
        workspace_id,
        InvoiceMail {
            invoices: group.clone(),
            to: vec![to],
            cc: Vec::new(),
            subject: None,
            body: None,
            attach_pdf: true,
            include_link: true,
            template: step.template.clone(),
            fallback: plan.fallback,
            history_type: "reminder",
            level: Some(step.level),
            vars: plan.vars,
            history_extra: extra,
        },
    )
    .await?;
    let ids: Vec<String> = group.iter().filter_map(|i| owned(i, "id")).collect();
    invoices::Entity::update_many()
        .col_expr(invoices::Column::ReminderLevel, Expr::value(step.level))
        .col_expr(invoices::Column::LastRemindedAt, Expr::current_timestamp())
        .col_expr(invoices::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(invoices::Column::Id.is_in(ids.clone()))
        .exec(&orm(db))
        .await?;
    Ok(Reminded {
        invoice_ids: ids,
        level: step.level,
        sent,
        claim: claim.as_ref().map(claim_json),
    })
}

fn reminded_event(invoice: &Value, level: i32, automatic: bool) -> Value {
    let mut data = crate::invoices::event_data(invoice, &invoice["status"]);
    data["level"] = json!(level);
    data["balanceDue"] = invoice["balanceDue"].clone();
    data["automatic"] = json!(automatic);
    data
}

fn refusal(error: DeliveryError) -> Refusal {
    match error {
        DeliveryError::NoMail => Refusal::unavailable("E-mail is not set up on this server"),
        DeliveryError::NoLink => Refusal::unavailable(
            "The public document link is not set up (PAY_PORTAL_PUBLIC_URL and a signing key)",
        ),
        DeliveryError::NoRecipient => Refusal::bad_request("The contact has no e-mail address"),
        DeliveryError::Database(error) => Refusal::Database(error),
        DeliveryError::Send => Refusal::unavailable("The e-mail could not be sent"),
    }
}

async fn entity_settings_of(db: &PgPool, entity_id: &str) -> Result<ReminderSettings, DbErr> {
    let all = entity_settings::load(db, entity_id).await?;
    Ok(ReminderSettings::of(all.as_ref()))
}

// ── POST /:id/remind ────────────────────────────────────────────────────────

pub(crate) async fn remind(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        remind_invoice(&caller, &state, &id).await,
        "Failed to send the reminder",
    )
}

pub(crate) async fn remind_invoice(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let db = &caller.db;
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id));
    };
    if !is_open(&invoice) {
        return Err(Refusal::conflict(
            "Only an open invoice with a balance can be reminded",
        ));
    }
    let now_ms = caller.now_ms();
    let settings = entity_settings_of(db, text(&invoice, "entityId").unwrap_or_default()).await?;
    let Some(step) = next_step_of(db, &settings, &invoice, now_ms).await? else {
        return Err(Refusal::conflict("All reminders have been sent"));
    };
    let reminded = send_group(
        db,
        state,
        &caller.workspace_id,
        &settings,
        step,
        vec![invoice.clone()],
        now_ms,
    )
    .await
    .map_err(refusal)?;
    let current = load_invoice(db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Invoice", id))?;
    audit(caller, db, &current, reminded.level).await;
    caller.publish(
        state,
        INVOICE_REMINDED,
        id,
        reminded_event(&current, reminded.level, false),
    );
    let mut out = current.as_object().cloned().unwrap_or_default();
    out.insert("reminder".into(), reminder_json(&reminded));
    Ok(ok(Value::Object(out)))
}

fn reminder_json(r: &Reminded) -> Value {
    json!({
        "level": r.level, "to": r.sent.to, "messageId": r.sent.message_id,
        "subject": r.sent.subject, "link": r.sent.link, "claim": r.claim,
    })
}

async fn audit(caller: &Caller, db: &PgPool, invoice: &Value, level: i32) {
    let mut changes = Map::new();
    changes.insert(
        "reminderLevel".into(),
        change(json!(level - 1), json!(level)),
    );
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: text(invoice, "entityId"),
            entity_type: "invoice",
            entity_id: text(invoice, "id").unwrap_or_default(),
            action: "reminded",
            changes: Some(changes),
        },
    )
    .await;
}

// ── POST /remind-bulk ───────────────────────────────────────────────────────

pub(crate) async fn remind_bulk(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let ids = read_bulk(&json_of(&headers, &body)?)?;
        remind_many(&caller, &state, ids).await
    }
    .await;
    reply(result, "Failed to send the reminders")
}

pub(crate) fn read_bulk(body: &Value) -> Result<Vec<String>, Refusal> {
    let list = body
        .get("invoiceIds")
        .and_then(Value::as_array)
        .ok_or_else(|| Refusal::bad_request("invoiceIds is required"))?;
    if list.is_empty() || list.len() > 100 {
        return Err(Refusal::bad_request("invoiceIds must hold 1 to 100 ids"));
    }
    let mut ids: Vec<String> = Vec::new();
    for id in list {
        let id = id
            .as_str()
            .filter(|i| !i.is_empty() && i.len() <= 30)
            .ok_or_else(|| Refusal::bad_request("invoiceIds must hold invoice ids"))?;
        if !ids.iter().any(|i| i == id) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

pub(crate) async fn remind_many(caller: &Caller, state: &BooksState, ids: Vec<String>) -> Reply {
    let db = &caller.db;
    let now_ms = caller.now_ms();
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let rows = invoices::Entity::find()
        .filter(invoices::Column::Id.is_in(ids.clone()))
        .filter(invoices::Column::EntityId.eq(entity_id.as_str()))
        .filter(invoices::Column::DeletedAt.is_null())
        .order_by_asc(invoices::Column::DueDate)
        .all(&orm(db))
        .await?;
    let rows: Vec<Value> = rows.into_iter().map(row_json).collect::<Result<_, _>>()?;
    let settings = entity_settings_of(db, &entity_id).await?;
    let contact_ids: Vec<String> = rows.iter().filter_map(|r| owned(r, "contactId")).collect();
    let paused = paused_contacts(db, &entity_id, &contact_ids).await?;
    let mut skipped: Vec<Value> = ids
        .iter()
        .filter(|id| !rows.iter().any(|r| text(r, "id") == Some(id.as_str())))
        .map(|id| json!({ "invoiceId": id, "reason": Skip::NotFound.code() }))
        .collect();
    // Group by contact and the step they are due.
    let mut groups: BTreeMap<(String, i32), (Vec<Value>, Step)> = BTreeMap::new();
    for invoice in rows {
        let id = owned(&invoice, "id").unwrap_or_default();
        if !is_open(&invoice) {
            skipped.push(json!({ "invoiceId": id, "reason": Skip::NotOpen.code() }));
            continue;
        }
        if owned(&invoice, "contactId").is_some_and(|contact| paused.contains(&contact)) {
            skipped.push(json!({ "invoiceId": id, "reason": Skip::ContactPaused.code() }));
            continue;
        }
        let Some(step) = next_step_of(db, &settings, &invoice, now_ms).await? else {
            skipped.push(json!({ "invoiceId": id, "reason": Skip::NoNextStep.code() }));
            continue;
        };
        // A claim is mailed alone: its own group.
        let contact = if settings.claims_statutory(step) {
            id.clone()
        } else {
            owned(&invoice, "contactId").unwrap_or_default()
        };
        groups
            .entry((contact, step.level))
            .or_insert_with(|| (Vec::new(), step.clone()))
            .0
            .push(invoice);
    }
    let mut sent = Vec::new();
    for (_, (group, step)) in groups {
        let ids: Vec<String> = group.iter().filter_map(|i| owned(i, "id")).collect();
        match send_group(
            db,
            state,
            &caller.workspace_id,
            &settings,
            &step,
            group,
            now_ms,
        )
        .await
        {
            Ok(reminded) => {
                for id in &reminded.invoice_ids {
                    if let Some(current) = load_invoice(db, id).await? {
                        audit(caller, db, &current, reminded.level).await;
                        caller.publish(
                            state,
                            INVOICE_REMINDED,
                            id,
                            reminded_event(&current, reminded.level, false),
                        );
                    }
                }
                sent.push(json!({
                    "invoiceIds": reminded.invoice_ids, "level": reminded.level, "to": reminded.sent.to,
                    "messageId": reminded.sent.message_id, "claim": reminded.claim,
                }));
            }
            Err(DeliveryError::NoRecipient) => {
                skipped.extend(
                    ids.iter()
                        .map(|id| json!({ "invoiceId": id, "reason": Skip::NoRecipient.code() })),
                );
            }
            Err(DeliveryError::NoMail | DeliveryError::NoLink) if sent.is_empty() => {
                return Err(refusal(DeliveryError::NoMail));
            }
            Err(DeliveryError::Database(error)) => return Err(Refusal::Database(error)),
            Err(_) => {
                skipped.extend(
                    ids.iter()
                        .map(|id| json!({ "invoiceId": id, "reason": "send_failed" })),
                );
            }
        }
    }
    Ok(ok(json!({ "sent": sent, "skipped": skipped })))
}

// ── PATCH /:id/reminders ────────────────────────────────────────────────────

pub(crate) async fn pause(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let body = json_of(&headers, &body)?;
        let Some(paused) = body.get("paused").and_then(Value::as_bool) else {
            return Err(Refusal::bad_request("paused must be true or false"));
        };
        pause_invoice(&caller, &state, &id, paused).await
    }
    .await;
    reply(result, "Failed to update the reminders of the invoice")
}

pub(crate) async fn pause_invoice(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    paused: bool,
) -> Reply {
    let db = &caller.db;
    let Some(before) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id));
    };
    invoices::Entity::update_many()
        .col_expr(invoices::Column::RemindersPaused, Expr::value(paused))
        .col_expr(invoices::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(invoices::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    let current = load_invoice(db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Invoice", id))?;
    let was = before.get("remindersPaused") == Some(&json!(true));
    if was != paused {
        let mut changes = Map::new();
        changes.insert("remindersPaused".into(), change(json!(was), json!(paused)));
        write_accounting_audit(
            caller,
            db,
            AuditInput {
                accounting_entity_id: text(&current, "entityId"),
                entity_type: "invoice",
                entity_id: id,
                action: "updated",
                changes: Some(changes),
            },
        )
        .await;
        let mut after = Map::new();
        after.insert("remindersPaused".into(), json!(paused));
        caller.publish(
            state,
            INVOICE_UPDATED,
            id,
            crate::invoices::event_data(&current, &current["status"]),
        );
    }
    // `remindersPaused` is left out of the JSON while it is false.
    let mut out = current.as_object().cloned().unwrap_or_default();
    out.insert("remindersPaused".into(), json!(paused));
    Ok(ok(Value::Object(out)))
}

// ── The daily sweep ─────────────────────────────────────────────────────────

/// What the sweep's reminders did in one workspace.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SweepReminders {
    pub sent: u64,
    pub failed: u64,
}

/// Send the reminder steps that are due and sent automatically, for the
/// entities of the workspace whose workflow is on. Steps that are not
/// automatic wait in To process (the `reminder_due` hint of
/// `invoices_overdue`). Nothing is opened that is not already: it runs
/// inside the daily books sweep of a workspace.
///
/// # Errors
///
/// The database's, for the entity list; a failing invoice is counted.
pub async fn send_due_reminders(
    db: &PgPool,
    state: &BooksState,
    workspace_id: &str,
    event_workspace_id: &str,
    now_ms: i64,
) -> Result<SweepReminders, DbErr> {
    let mut result = SweepReminders::default();
    let rows: Vec<(String, Option<Value>)> = entities::Entity::find()
        .select_only()
        .columns([entities::Column::Id, entities::Column::JurisdictionSettings])
        .filter(entities::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    for (entity_id, settings) in rows {
        let settings = ReminderSettings::of(settings.as_ref());
        if !settings.enabled || !settings.steps.iter().any(|s| s.auto) {
            continue;
        }
        let first_due = settings
            .steps
            .iter()
            .filter(|s| s.auto)
            .map(|s| s.days_after_due)
            .min()
            .unwrap_or(0);
        let cutoff = now_ms - first_due * DAY_MS;
        let cutoff = cutoff_timestamp(cutoff);
        let candidates = invoices::Entity::find()
            .filter(invoices::Column::EntityId.eq(entity_id.as_str()))
            .filter(invoices::Column::DeletedAt.is_null())
            .filter(invoices::Column::Status.is_in(OPEN_STATUSES))
            .filter(invoices::Column::Type.is_in(["standard", "correction"]))
            .filter(invoices::Column::BalanceDue.gt(0))
            .filter(invoices::Column::RemindersPaused.eq(false))
            .filter(invoices::Column::DueDate.lte(cutoff))
            .order_by_asc(invoices::Column::DueDate)
            .all(&orm(db))
            .await?;
        let contact_ids: Vec<String> = candidates.iter().map(|r| r.contact_id.clone()).collect();
        let paused = paused_contacts(db, &entity_id, &contact_ids).await?;
        let mut groups: BTreeMap<(String, i32), (Vec<Value>, Step)> = BTreeMap::new();
        for row in candidates {
            if paused.contains(&row.contact_id) {
                continue;
            }
            let invoice = row_json(row)?;
            let id = owned(&invoice, "id").unwrap_or_default();
            let Some(step) = settings.due_step(level_of(&invoice), days_overdue(&invoice, now_ms))
            else {
                continue;
            };
            if !step.auto {
                continue;
            }
            let contact = if settings.claims_statutory(step) {
                id
            } else {
                owned(&invoice, "contactId").unwrap_or_default()
            };
            groups
                .entry((contact, step.level))
                .or_insert_with(|| (Vec::new(), step.clone()))
                .0
                .push(invoice);
        }
        let caller = Caller::in_process(
            db.clone(),
            workspace_id,
            event_workspace_id,
            "system",
            &entity_id,
            None,
        );
        for (_, (group, step)) in groups {
            let count = group.len() as u64;
            match send_group(db, state, workspace_id, &settings, &step, group, now_ms).await {
                Ok(reminded) => {
                    result.sent += count;
                    for id in &reminded.invoice_ids {
                        if let Some(current) = load_invoice(db, id).await? {
                            caller.publish_system(
                                state,
                                INVOICE_REMINDED,
                                id,
                                reminded_event(&current, reminded.level, true),
                            );
                        }
                    }
                }
                Err(DeliveryError::Database(error)) => return Err(error),
                // No mail transport or address: nothing was sent, and the next run looks again.
                Err(error) => {
                    result.failed += count;
                    tracing::warn!(?error, entity = %entity_id, "books-sweep: a reminder was not sent");
                }
            }
        }
    }
    Ok(result)
}

/// A moment as the `timestamp` column compares it.
fn cutoff_timestamp(millis: i64) -> time::PrimitiveDateTime {
    crate::invoices::millis_timestamp(millis).unwrap_or_else(utc_now)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    #[test]
    fn days_overdue_counts_whole_days_and_never_goes_negative() {
        let due = "2026-11-01T00:00:00.000Z";
        let at = millis_of(due).unwrap();
        let invoice = json!({ "dueDate": due });
        assert_eq!(days_overdue(&invoice, at - 5 * DAY_MS), 0);
        assert_eq!(days_overdue(&invoice, at + 6 * DAY_MS + 3_600_000), 6);
        assert_eq!(days_overdue(&json!({}), at), 0);
    }

    #[test]
    fn an_invoice_is_open_with_a_balance_and_a_live_status() {
        let open = |status: &str, kind: &str, balance: &str| {
            is_open(&json!({ "status": status, "type": kind, "balanceDue": balance }))
        };
        assert!(open("sent", "standard", "10.00"));
        assert!(open("partial", "standard", "0.01"));
        assert!(open("overdue", "correction", "5"));
        assert!(!open("paid", "standard", "0"));
        assert!(!open("draft", "standard", "10"));
        assert!(!open("sent", "credit_note", "10"));
        assert!(!open("sent", "standard", "0.00"));
        assert!(!open("cancelled", "standard", "10"));
    }

    #[test]
    fn a_notice_is_found_in_the_history() {
        let now = millis_of("2026-12-20T00:00:00.000Z").unwrap();
        let invoice = json!({ "emailHistory": [
            { "type": "reminder", "at": "2026-12-01T00:00:00.000Z", "level": 3, "claim": { "isNotice": true, "costsDue": false } },
        ] });
        assert_eq!(notice_age(&invoice, now), Some(19));
        assert_eq!(
            notice_age(
                &json!({ "emailHistory": [{ "type": "sent", "at": "2026-12-01T00:00:00.000Z" }] }),
                now
            ),
            None
        );
    }

    #[test]
    fn the_bulk_body_is_checked() {
        assert_eq!(
            read_bulk(&json!({ "invoiceIds": ["a", "b", "a"] })).unwrap(),
            vec!["a", "b"]
        );
        for bad in [
            json!({}),
            json!({ "invoiceIds": [] }),
            json!({ "invoiceIds": [1] }),
            json!({ "invoiceIds": "a" }),
        ] {
            assert!(read_bulk(&bad).is_err(), "{bad}");
        }
        let many: Vec<String> = (0..101).map(|i| format!("inv_{i}")).collect();
        assert!(read_bulk(&json!({ "invoiceIds": many })).is_err());
    }

    #[test]
    fn a_claim_fills_the_placeholders_and_picks_the_notice_text() {
        let invoice = json!({ "currency": "EUR", "balanceDue": "1000.00" });
        let settings = ReminderSettings::default();
        let claim = statutory_claim(100_000, Debtor::Consumer, 40, None, &settings.statutory);
        let plan = plan_of(Some(&claim), &invoice, "nl");
        assert_eq!(plan.vars["collectionCosts"], "€ 150,00");
        assert_eq!(plan.vars["totalClaim"], "€ 1.000,00");
        assert_eq!(plan.vars["noticeDays"], "14");
        assert_eq!(plan.extra["claim"]["isNotice"], true);
        assert!(plan.fallback.unwrap().subject.contains("14-dagenbrief"));
        let none = plan_of(None, &invoice, "en");
        assert!(none.fallback.is_none());
        assert_eq!(none.vars["totalClaim"], "€1,000.00");
    }
}
