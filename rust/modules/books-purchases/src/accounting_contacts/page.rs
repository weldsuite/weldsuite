//! The contact page's routes (Rust only, edition feature
//! `books-contact-page`; plan weldbooks-connected-ux phase 5):
//!
//! - `GET /:id/timeline?cursor=&limit=`: everything about the contact by date;
//! - `GET /:id/summary`: what is to receive, overdue, to pay, credit, quoted
//!   and unbilled;
//! - `GET /:id/statement?asOf=&format=`: the open items as a PDF or JSON;
//! - `GET`, `PATCH /:id/defaults`: the contact's stored defaults;
//! - `GET /by-crm?companyId=|personId=`: the contact of a WeldCRM company or
//!   person, with its summary.
//!
//! `/balance`, `/invoices` and `/bills` keep answering as the TypeScript
//! worker does: these are new routes, and the paging of the lists is opt-in.
//!
//! Documents with a legal entity are read in the entities the request may see
//! (as `/invoices` and `/balance` do); quotes belong to no entity and are the
//! contact's wherever they are read.

use std::collections::BTreeMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, StatusCode};
use sea_orm::sea_query::{Expr, Query as Sql};
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_books_domain::contact_page::{contact_paused, set_contact_paused};
use weldsuite_books_domain::entity_context::{resolve_entity_base_currency, resolve_entity_id};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, json_of, ok, paged, reply};
use weldsuite_books_domain::time_billing;
use weldsuite_books_domain::vendor_tax::strip_tax_fields_for_event;
use weldsuite_catalogs::entity_events::ACCOUNTING_CONTACT_UPDATED;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_legal_entities::EntityScopeCondition;
use weldsuite_schema::tenant::{
    accounts, bank_accounts, bank_transactions, bills, crm_quotes, documents, invoices, parties,
    payments, tax_rates,
};

use super::{entity_scope, load_contact_view, parse_payment_terms_days, text};
use crate::rows::{iso_of, money_text, timestamp_of_millis};

const DEFAULT_LIMIT: u64 = 25;
const MAX_LIMIT: u64 = 100;

/// Statuses of an invoice that still takes money.
const OPEN_INVOICE: [&str; 4] = ["sent", "finalized", "partial", "overdue"];
/// Statuses of a bill that can still be paid.
const OPEN_BILL: [&str; 3] = ["approved", "partial", "overdue"];

// ── The timeline ────────────────────────────────────────────────────────────

/// What the caller may read: invoices, quotes, credit notes, inbox documents
/// and invoice e-mails with `invoices:read`; bills and receipts with
/// `bills:read`; payments and bank lines with `banking:read`.
#[derive(Debug, Clone, Copy)]
pub(super) struct Readable {
    pub documents: bool,
    pub bills: bool,
    pub banking: bool,
}

impl Readable {
    pub(super) fn of(caller: &Caller) -> Self {
        Self {
            documents: caller.can("invoices:read"),
            bills: caller.can("bills:read"),
            banking: caller.can("banking:read"),
        }
    }
}

/// Where the last page ended: the item's time in milliseconds and its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Cursor {
    pub millis: i64,
    pub key: String,
}

impl Cursor {
    pub(super) fn parse(raw: &str) -> Option<Self> {
        let (millis, key) = raw.split_once(':')?;
        Some(Self {
            millis: millis.parse().ok()?,
            key: key.to_owned(),
        })
    }

    fn text(millis: i64, key: &str) -> String {
        format!("{millis}:{key}")
    }

    /// Whether an item at `millis` with `key` comes after the cursor in the
    /// order (newest first, then the larger key first).
    fn precedes(&self, millis: i64, key: &str) -> bool {
        millis < self.millis || (millis == self.millis && key < self.key.as_str())
    }
}

/// One timeline entry before the merge.
#[derive(Debug, Clone)]
pub(super) struct Candidate {
    pub millis: i64,
    pub key: String,
    pub item: Value,
}

fn millis_of(at: PrimitiveDateTime) -> i64 {
    i64::try_from(at.assume_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

#[allow(
    clippy::too_many_arguments,
    clippy::needless_pass_by_value,
    reason = "the item's ten fields, as the contract lists them, each built by the caller"
)]
fn item(
    kind: &str,
    object_type: &str,
    object_id: &str,
    date: String,
    title: Option<String>,
    subtitle: Option<String>,
    amount: Option<String>,
    currency: Option<String>,
    status: Option<String>,
    hint: Option<String>,
) -> Value {
    json!({
        "type": kind,
        "objectType": object_type,
        "objectId": object_id,
        "date": date,
        "title": title,
        "subtitle": subtitle,
        "amount": amount,
        "currency": currency,
        "status": status,
        "hint": hint,
    })
}

fn filled(value: Option<&String>) -> Option<String> {
    value.filter(|v| !v.is_empty()).cloned()
}

/// `select` newest first from the cursor on, with `limit + 1` rows older than
/// it and every row of the cursor's own millisecond (the key decides which of
/// those were shown), and the count of all the select matches.
async fn fetch<E>(
    db: &DatabaseConnection,
    select: Select<E>,
    date: E::Column,
    cursor: Option<&Cursor>,
    limit: u64,
) -> Result<(Vec<E::Model>, u64), DbErr>
where
    E: EntityTrait,
    E::Model: Sync,
{
    let total = select.clone().count(db).await?;
    let rows = match cursor {
        None => select.order_by_desc(date).limit(limit + 1).all(db).await?,
        Some(cursor) => {
            let from = timestamp_of_millis(cursor.millis);
            let to = timestamp_of_millis(cursor.millis + 1);
            let (Some(from), Some(to)) = (from, to) else {
                return Ok((Vec::new(), total));
            };
            let mut same = select
                .clone()
                .filter(date.gte(from))
                .filter(date.lt(to))
                .all(db)
                .await?;
            let older = select
                .filter(date.lt(from))
                .order_by_desc(date)
                .limit(limit + 1)
                .all(db)
                .await?;
            same.extend(older);
            same
        }
    };
    Ok((rows, total))
}

/// The WeldCRM quotes of a party: written with its id in `customer_id`, or
/// for its company or person.
fn quotes_of(party: &parties::Model) -> Select<crm_quotes::Entity> {
    let mut any = Condition::any().add(crm_quotes::Column::CustomerId.eq(party.id.as_str()));
    if let Some(company) = party.company_id.as_deref().filter(|c| !c.is_empty()) {
        any = any
            .add(crm_quotes::Column::CounterpartyId.eq(company))
            .add(crm_quotes::Column::CustomerId.eq(company));
    }
    if let Some(person) = party.person_id.as_deref().filter(|p| !p.is_empty()) {
        any = any
            .add(crm_quotes::Column::PersonId.eq(person))
            .add(crm_quotes::Column::CustomerId.eq(person));
    }
    crm_quotes::Entity::find()
        .filter(crm_quotes::Column::DeletedAt.is_null())
        .filter(any)
}

/// The merged, cursor-paged timeline of a contact.
pub(super) struct Timeline {
    pub items: Vec<Value>,
    pub total: u64,
    pub has_more: bool,
    pub cursor: Option<String>,
}

#[allow(
    clippy::too_many_lines,
    reason = "one source after another, then the merge"
)]
pub(super) async fn build_timeline(
    pool: &PgPool,
    scope: &EntityScopeCondition,
    party: &parties::Model,
    readable: Readable,
    cursor: Option<&Cursor>,
    limit: u64,
    now_ms: i64,
) -> Result<Timeline, DbErr> {
    let db = orm(pool);
    let contact = party.id.as_str();
    let mut found: Vec<Candidate> = Vec::new();
    let mut total = 0_u64;

    if readable.documents {
        // Quotes: no entity.
        let (rows, count) = fetch(
            &db,
            quotes_of(party),
            crm_quotes::Column::CreatedAt,
            cursor,
            limit,
        )
        .await?;
        total += count;
        for quote in rows {
            let expired = matches!(quote.status.as_str(), "sent" | "viewed")
                && millis_of(quote.valid_until) < now_ms;
            found.push(Candidate {
                millis: millis_of(quote.created_at),
                key: format!("quote:{}", quote.id),
                item: item(
                    "quote",
                    "quote",
                    &quote.id,
                    iso_of(quote.created_at),
                    Some(quote.quote_number.clone()),
                    Some(quote.name.clone()).filter(|n| !n.is_empty()),
                    Some(money_text(&quote.total)),
                    filled(quote.currency.as_ref()),
                    Some(quote.status.clone()),
                    expired.then(|| "expired".to_owned()),
                ),
            });
        }

        // Invoices and credit notes.
        let invoice_rows = invoices::Entity::find()
            .filter(invoices::Column::ContactId.eq(contact))
            .filter(invoices::Column::DeletedAt.is_null())
            .filter(scope.condition(invoices::Column::EntityId));
        let (rows, count) = fetch(
            &db,
            invoice_rows.clone(),
            invoices::Column::IssueDate,
            cursor,
            limit,
        )
        .await?;
        total += count;
        for invoice in rows {
            let credit = invoice.type_ == "credit_note";
            let open = OPEN_INVOICE.contains(&invoice.status.as_str()) && !credit;
            let overdue = open && millis_of(invoice.due_date) < now_ms;
            found.push(Candidate {
                millis: millis_of(invoice.issue_date),
                key: format!("invoice:{}", invoice.id),
                item: item(
                    if credit { "credit_note" } else { "invoice" },
                    "invoice",
                    &invoice.id,
                    iso_of(invoice.issue_date),
                    filled(invoice.invoice_number.as_ref()),
                    filled(invoice.reference.as_ref()),
                    invoice.total.as_ref().map(money_text),
                    filled(invoice.currency.as_ref()),
                    Some(invoice.status.clone()),
                    overdue.then(|| "overdue".to_owned()),
                ),
            });
        }

        // E-mail and reminder events, from the invoices' histories.
        let with_history = invoice_rows
            .filter(invoices::Column::EmailHistory.is_not_null())
            .all(&db)
            .await?;
        let mut events = 0_u64;
        for invoice in &with_history {
            let Some(history) = invoice.email_history.as_ref().and_then(Value::as_array) else {
                continue;
            };
            for (index, entry) in history.iter().enumerate() {
                let kind = match text(entry, "type") {
                    Some("sent") => "email_sent",
                    Some("viewed") => "email_viewed",
                    Some("reminder") => "reminder",
                    Some("bounced") => "email_bounced",
                    _ => continue,
                };
                let Some(at) = text(entry, "at").and_then(weldsuite_books_domain::js::millis_of)
                else {
                    continue;
                };
                events += 1;
                let to = match entry.get("to") {
                    Some(Value::String(to)) => Some(to.clone()),
                    Some(Value::Array(list)) => {
                        let joined: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
                        (!joined.is_empty()).then(|| joined.join(", "))
                    }
                    _ => None,
                };
                let hint = (kind == "reminder")
                    .then(|| entry.get("level").and_then(Value::as_i64))
                    .flatten()
                    .map(|level| format!("level:{level}"));
                found.push(Candidate {
                    millis: at,
                    key: format!("email:{}:{index:05}", invoice.id),
                    item: item(
                        kind,
                        "invoice",
                        &invoice.id,
                        text(entry, "at").unwrap_or_default().to_owned(),
                        filled(invoice.invoice_number.as_ref()),
                        to,
                        None,
                        None,
                        None,
                        hint,
                    ),
                });
            }
        }
        total += events;

        // Inbox documents: matched to the contact, or behind one of its bills.
        let its_bills = Sql::select()
            .column(bills::Column::Id)
            .from(bills::Entity)
            .and_where(bills::Column::ContactId.eq(contact))
            .and_where(bills::Column::DeletedAt.is_null())
            .to_owned();
        let doc_rows = documents::Entity::find()
            .filter(documents::Column::DeletedAt.is_null())
            .filter(scope.condition(documents::Column::EntityId))
            .filter(
                Condition::any()
                    .add(documents::Column::MatchedContactId.eq(contact))
                    .add(
                        Condition::all()
                            .add(documents::Column::LinkedEntityType.eq("bill"))
                            .add(documents::Column::LinkedEntityId.in_subquery(its_bills)),
                    ),
            );
        let (rows, count) =
            fetch(&db, doc_rows, documents::Column::CreatedAt, cursor, limit).await?;
        total += count;
        for document in rows {
            found.push(Candidate {
                millis: millis_of(document.created_at),
                key: format!("document:{}", document.id),
                item: item(
                    "document",
                    "document",
                    &document.id,
                    iso_of(document.created_at),
                    Some(
                        document
                            .original_file_name
                            .clone()
                            .unwrap_or(document.file_name.clone()),
                    ),
                    filled(document.email_from.as_ref()),
                    None,
                    None,
                    Some(document.status.clone()),
                    Some(document.type_.clone()),
                ),
            });
        }
    }

    if readable.bills {
        let bill_rows = bills::Entity::find()
            .filter(bills::Column::ContactId.eq(contact))
            .filter(bills::Column::DeletedAt.is_null())
            .filter(scope.condition(bills::Column::EntityId));
        let (rows, count) = fetch(&db, bill_rows, bills::Column::IssueDate, cursor, limit).await?;
        total += count;
        for bill in rows {
            let kind = match bill.type_.as_str() {
                "receipt" => "receipt",
                "credit_note" => "credit_note",
                _ => "bill",
            };
            let open = OPEN_BILL.contains(&bill.status.as_str()) && kind != "credit_note";
            found.push(Candidate {
                millis: millis_of(bill.issue_date),
                key: format!("bill:{}", bill.id),
                item: item(
                    kind,
                    "bill",
                    &bill.id,
                    iso_of(bill.issue_date),
                    filled(bill.bill_number.as_ref())
                        .or_else(|| filled(bill.external_reference.as_ref())),
                    filled(bill.reference.as_ref()),
                    bill.total.as_ref().map(money_text),
                    filled(bill.currency.as_ref()),
                    Some(bill.status.clone()),
                    (open && millis_of(bill.due_date) < now_ms).then(|| "overdue".to_owned()),
                ),
            });
        }
    }

    if readable.banking {
        let payment_rows = payments::Entity::find()
            .filter(payments::Column::ContactId.eq(contact))
            .filter(payments::Column::DeletedAt.is_null())
            .filter(scope.condition(payments::Column::EntityId));
        let (rows, count) = fetch(&db, payment_rows, payments::Column::Date, cursor, limit).await?;
        total += count;
        for payment in rows {
            found.push(Candidate {
                millis: millis_of(payment.date),
                key: format!("payment:{}", payment.id),
                item: item(
                    "payment",
                    "payment",
                    &payment.id,
                    iso_of(payment.date),
                    filled(payment.reference.as_ref()),
                    filled(payment.payment_method.as_ref()),
                    Some(money_text(&payment.amount)),
                    filled(payment.currency.as_ref()),
                    None,
                    Some(payment.type_.clone()),
                ),
            });
        }

        let line_rows = bank_transactions::Entity::find()
            .filter(bank_transactions::Column::DeletedAt.is_null())
            .filter(scope.condition(bank_transactions::Column::EntityId))
            .filter(weldsuite_books_domain::contact_page::bank_line_condition(
                contact,
            ));
        let (rows, count) = fetch(
            &db,
            line_rows,
            bank_transactions::Column::Date,
            cursor,
            limit,
        )
        .await?;
        total += count;
        let account_ids: Vec<String> = rows.iter().map(|r| r.bank_account_id.clone()).collect();
        let currencies: BTreeMap<String, String> = if account_ids.is_empty() {
            BTreeMap::new()
        } else {
            bank_accounts::Entity::find()
                .filter(bank_accounts::Column::Id.is_in(account_ids))
                .all(&db)
                .await?
                .into_iter()
                .filter_map(|account| Some((account.id, account.currency?)))
                .collect()
        };
        for line in rows {
            let incoming = !line.amount.to_string().starts_with('-');
            found.push(Candidate {
                millis: millis_of(line.date),
                key: format!("bank_line:{}", line.id),
                item: item(
                    "bank_line",
                    "bank_transaction",
                    &line.id,
                    iso_of(line.date),
                    filled(line.counterparty_name.as_ref())
                        .or_else(|| filled(line.description.as_ref())),
                    filled(line.description.as_ref()),
                    Some(money_text(&line.amount)),
                    currencies.get(&line.bank_account_id).cloned(),
                    Some(line.status.clone()),
                    Some(if incoming { "in" } else { "out" }.to_owned()),
                ),
            });
        }
    }

    // Newest first, the larger key first among the same millisecond; past the
    // cursor; one page and a look at whether there is another.
    found.sort_by(|a, b| b.millis.cmp(&a.millis).then_with(|| b.key.cmp(&a.key)));
    found.retain(|c| cursor.is_none_or(|cursor| cursor.precedes(c.millis, &c.key)));
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = found.len() > limit;
    found.truncate(limit);
    let next = if has_more {
        found.last().map(|c| Cursor::text(c.millis, &c.key))
    } else {
        None
    };
    Ok(Timeline {
        items: found.into_iter().map(|c| c.item).collect(),
        total,
        has_more,
        cursor: next,
    })
}

pub(super) async fn timeline(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(party) = live_party(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Contact", &id));
            };
            let q = caller.query();
            let limit = match q.present("limit") {
                None => DEFAULT_LIMIT,
                Some(raw) => weldsuite_books_domain::js::parse_int(raw)
                    .filter(|n| *n >= 1)
                    .map(|n| u64::try_from(n).unwrap_or(1).min(MAX_LIMIT))
                    .ok_or_else(|| Refusal::bad_request("limit must be a positive number"))?,
            };
            let cursor = match q.present("cursor") {
                None => None,
                Some(raw) => {
                    Some(Cursor::parse(raw).ok_or_else(|| Refusal::bad_request("Invalid cursor"))?)
                }
            };
            let scope = entity_scope(&caller).await?;
            let page = build_timeline(
                &caller.db,
                &scope,
                &party,
                Readable::of(&caller),
                cursor.as_ref(),
                limit,
                caller.now_ms(),
            )
            .await?;
            Ok(paged(
                page.items,
                i64::try_from(page.total).unwrap_or(i64::MAX),
                page.has_more,
                page.cursor,
            ))
        }
        .await,
        "Failed to fetch the contact timeline",
    )
}

async fn live_party(db: &PgPool, id: &str) -> Result<Option<parties::Model>, DbErr> {
    parties::Entity::find_by_id(id.to_owned())
        .filter(parties::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

// ── The summary ─────────────────────────────────────────────────────────────

fn cents(amount: Option<&sea_orm::prelude::BigDecimal>) -> i64 {
    amount
        .and_then(|a| {
            (a * sea_orm::prelude::BigDecimal::from(100))
                .round(0)
                .to_plain_string()
                .parse::<i64>()
                .ok()
        })
        .unwrap_or(0)
}

fn amount_text(cents: i64) -> String {
    time_billing::cents_text(cents)
}

/// Sums per currency: `[{ currency, amount, count }]`, by currency.
#[derive(Default)]
struct Sums(BTreeMap<String, (i64, u64)>);

impl Sums {
    fn add(&mut self, currency: &str, cents: i64) {
        let slot = self.0.entry(currency.to_owned()).or_default();
        slot.0 += cents;
        slot.1 += 1;
    }

    fn json(&self) -> Value {
        Value::Array(
            self.0
                .iter()
                .map(|(currency, (cents, count))| {
                    json!({ "currency": currency, "amount": amount_text(*cents), "count": count })
                })
                .collect(),
        )
    }
}

/// `GET /:id/summary` and the summary of `by-crm`.
pub(super) async fn summary_of(caller: &Caller, party: &parties::Model) -> Result<Value, DbErr> {
    let scope = entity_scope(caller).await?;
    summary_in(caller, &scope, party).await
}

/// [`summary_of`] over the documents of the entities `scope` allows.
#[allow(clippy::too_many_lines, reason = "one sum after another")]
pub(super) async fn summary_in(
    caller: &Caller,
    scope: &EntityScopeCondition,
    party: &parties::Model,
) -> Result<Value, DbErr> {
    let db = orm(&caller.db);
    let contact = party.id.as_str();
    let readable = Readable::of(caller);
    let entity = resolve_entity_id(caller).await?;
    let base = match &entity {
        Some(entity) => resolve_entity_base_currency(&caller.db, entity)
            .await
            .unwrap_or_else(|_| "EUR".to_owned()),
        None => "EUR".to_owned(),
    };
    let now = utc_now();
    let mut to_receive = Sums::default();
    let mut overdue = Sums::default();
    let mut to_pay = Sums::default();
    let mut credit = Sums::default();
    let mut quotes = Sums::default();

    if readable.documents {
        let rows = invoices::Entity::find()
            .filter(invoices::Column::ContactId.eq(contact))
            .filter(invoices::Column::DeletedAt.is_null())
            .filter(invoices::Column::Status.is_in(OPEN_INVOICE))
            .filter(invoices::Column::Type.ne("proforma"))
            .filter(invoices::Column::BalanceDue.gt(0))
            .filter(scope.condition(invoices::Column::EntityId))
            .all(&db)
            .await?;
        for invoice in rows {
            let currency = invoice.currency.clone().unwrap_or_else(|| base.clone());
            let balance = cents(invoice.balance_due.as_ref());
            if invoice.type_ == "credit_note" {
                credit.add(&currency, balance);
            } else {
                to_receive.add(&currency, balance);
                if invoice.due_date < now {
                    overdue.add(&currency, balance);
                }
            }
        }
        let open_quotes = quotes_of(party)
            .filter(crm_quotes::Column::Status.is_in(["sent", "viewed"]))
            .filter(crm_quotes::Column::ValidUntil.gte(now))
            .all(&db)
            .await?;
        for quote in open_quotes {
            quotes.add(
                &quote.currency.clone().unwrap_or_else(|| base.clone()),
                cents(Some(&quote.total)),
            );
        }
    }
    if readable.bills {
        let rows = bills::Entity::find()
            .filter(bills::Column::ContactId.eq(contact))
            .filter(bills::Column::DeletedAt.is_null())
            .filter(bills::Column::Status.is_in(OPEN_BILL))
            .filter(bills::Column::BalanceDue.gt(0))
            .filter(scope.condition(bills::Column::EntityId))
            .all(&db)
            .await?;
        for bill in rows {
            let currency = bill.currency.clone().unwrap_or_else(|| base.clone());
            let balance = cents(bill.balance_due.as_ref());
            if bill.type_ == "credit_note" {
                credit.add(&currency, balance);
            } else {
                to_pay.add(&currency, balance);
            }
        }
    }
    if readable.banking
        && let Some(entity) = &entity
    {
        let credits = weldsuite_books_domain::unapplied_credit::credits_of_contact(
            &caller.db, entity, contact,
        )
        .await
        .map_err(|error| DbErr::Custom(error.to_string()))?;
        for payment in credits {
            let currency = text(&payment, "currency").unwrap_or(&base).to_owned();
            let remaining = text(&payment, "unallocatedAmount")
                .and_then(|a| a.parse::<f64>().ok())
                .unwrap_or(0.0);
            #[allow(clippy::cast_possible_truncation)]
            credit.add(&currency, (remaining * 100.0).round() as i64);
        }
    }

    let mut out = Map::new();
    out.insert("toReceive".into(), to_receive.json());
    out.insert("overdue".into(), overdue.json());
    out.insert("toPay".into(), to_pay.json());
    out.insert("unappliedCredit".into(), credit.json());
    out.insert(
        "openQuotes".into(),
        json!({
            "count": quotes.0.values().map(|(_, count)| count).sum::<u64>(),
            "amount": quotes.json(),
        }),
    );
    if caller.can("time:read") {
        let unbilled = time_billing::contact_unbilled(&caller.db, contact, &base).await?;
        out.insert(
            "unbilledHours".into(),
            unbilled.unwrap_or_else(|| json!({ "hours": "0", "amount": "0.00", "currency": base })),
        );
    }
    Ok(Value::Object(out))
}

pub(super) async fn summary(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(party) = live_party(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Contact", &id));
            };
            Ok(ok(summary_of(&caller, &party).await?))
        }
        .await,
        "Failed to fetch the contact summary",
    )
}

// ── By CRM record ───────────────────────────────────────────────────────────

/// `GET /by-crm?companyId=|personId=`: `{ contact, summary }` for the party
/// wrapping the CRM company or person, `null` when there is none.
pub(super) async fn by_crm(caller: Caller) -> Response {
    reply(
        async {
            let q = caller.query();
            let company = q.present("companyId");
            let person = q.present("personId");
            let column = match (company, person) {
                (Some(company), None) => parties::Column::CompanyId.eq(company),
                (None, Some(person)) => parties::Column::PersonId.eq(person),
                _ => {
                    return Err(Refusal::bad_request("Give either companyId or personId"));
                }
            };
            let party = parties::Entity::find()
                .filter(parties::Column::DeletedAt.is_null())
                .filter(column)
                .order_by_asc(parties::Column::CreatedAt)
                .one(&orm(&caller.db))
                .await?;
            let Some(party) = party else {
                return Ok(ok(Value::Null));
            };
            let Some(contact) = load_contact_view(&caller.db, &party.id).await? else {
                return Ok(ok(Value::Null));
            };
            let summary = summary_of(&caller, &party).await?;
            Ok(ok(json!({ "contact": contact, "summary": summary })))
        }
        .await,
        "Failed to fetch the contact",
    )
}

// ── The statement ───────────────────────────────────────────────────────────

pub(super) async fn statement(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let q = caller.query();
    let as_of = match q.present("asOf") {
        None => Ok(OffsetDateTime::now_utc().date()),
        Some(raw) => crate::rows::date_of(raw)
            .map_err(|_| Refusal::bad_request("asOf must be a date (YYYY-MM-DD)")),
    };
    let result: Result<Response, Refusal> = async {
        let as_of = as_of?;
        let json_format = match q.present("format") {
            None | Some("pdf") => false,
            Some("json") => true,
            Some(_) => return Err(Refusal::bad_request("format must be pdf or json")),
        };
        let Some(party) = live_party(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Contact", &id));
        };
        let Some(entity) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let keyring = caller.keyring(&state);
        let today = OffsetDateTime::now_utc().date();
        let Some(statement) = weldsuite_books_domain::statement::build(
            &caller.db, &keyring, &entity, &id, as_of, today,
        )
        .await?
        else {
            return Err(Refusal::not_found("Accounting entity", &entity));
        };
        if json_format {
            return Ok(ok(statement.json));
        }
        let name = party.display_name.clone().unwrap_or_default();
        let safe: String = format!("statement-{name}-{as_of}")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        let mut response = (
            StatusCode::OK,
            weldsuite_books_domain::simple_pdf::render_statement(&statement.pdf),
        )
            .into_response();
        let headers = response.headers_mut();
        headers.insert(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/pdf"),
        );
        if let Ok(value) = HeaderValue::from_str(&format!("inline; filename=\"{safe}.pdf\"")) {
            headers.insert(http::header::CONTENT_DISPOSITION, value);
        }
        Ok(response)
    }
    .await;
    match result {
        Ok(response) => response,
        Err(refusal) => refusal.respond("Failed to build the statement"),
    }
}

// ── Defaults ────────────────────────────────────────────────────────────────

/// The stored defaults of a party; `reminders_paused` is whether the
/// request's entity holds the contact's reminders.
pub(super) fn defaults_view(party: &parties::Model, reminders_paused: bool) -> Value {
    json!({
        "contactId": party.id,
        "defaultExpenseAccountId": party.default_expense_account_id.clone().filter(|id| !id.is_empty()),
        "defaultTaxRateId": party.default_tax_rate_id.clone().filter(|id| !id.is_empty()),
        "paymentTermsDays": parse_payment_terms_days(party.payment_terms.as_deref()),
        "remindersPaused": reminders_paused,
    })
}

/// Whether the request's entity holds the contact's reminders (false when no
/// entity resolves).
async fn paused_in_request_entity(caller: &Caller, contact_id: &str) -> Result<bool, Refusal> {
    match resolve_entity_id(caller).await? {
        Some(entity) => Ok(contact_paused(&caller.db, &entity, contact_id).await?),
        None => Ok(false),
    }
}

pub(super) async fn defaults(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            match live_party(&caller.db, &id).await? {
                Some(party) => {
                    let paused = paused_in_request_entity(&caller, &id).await?;
                    Ok(ok(defaults_view(&party, paused)))
                }
                None => Err(Refusal::not_found("Contact", &id)),
            }
        }
        .await,
        "Failed to fetch the contact defaults",
    )
}

/// What `PATCH /:id/defaults` changes.
#[derive(Debug, Default, PartialEq, Eq)]
#[allow(
    clippy::option_option,
    reason = "absent (leave), null (clear) and a value are three different requests"
)]
pub(super) struct DefaultsPatch {
    /// `Some(None)` clears.
    pub expense_account: Option<Option<String>>,
    pub tax_rate: Option<Option<String>>,
    pub payment_terms_days: Option<Option<i64>>,
    pub reminders_paused: Option<bool>,
}

#[allow(
    clippy::option_option,
    reason = "absent (leave), null (clear) and a value are three different requests"
)]
fn id_field(body: &Map<String, Value>, key: &str) -> Result<Option<Option<String>>, Refusal> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(id)) if !id.trim().is_empty() && id.len() <= 30 => {
            Ok(Some(Some(id.trim().to_owned())))
        }
        Some(_) => Err(Refusal::bad_request(format!("{key} must be an id or null"))),
    }
}

/// The keys `PATCH /:id/defaults` knows.
const DEFAULT_KEYS: [&str; 4] = [
    "defaultExpenseAccountId",
    "defaultTaxRateId",
    "paymentTermsDays",
    "remindersPaused",
];

pub(super) fn read_defaults(body: &Value) -> Result<DefaultsPatch, Refusal> {
    let Some(map) = body.as_object() else {
        return Err(Refusal::bad_request("The body must be an object"));
    };
    if let Some(unknown) = map.keys().find(|k| !DEFAULT_KEYS.contains(&k.as_str())) {
        return Err(Refusal::bad_request(format!(
            "Unrecognized key: '{unknown}'"
        )));
    }
    let mut patch = DefaultsPatch {
        expense_account: id_field(map, "defaultExpenseAccountId")?,
        tax_rate: id_field(map, "defaultTaxRateId")?,
        ..DefaultsPatch::default()
    };
    patch.payment_terms_days = match map.get("paymentTermsDays") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(value) => {
            let days = value
                .as_i64()
                .filter(|d| (0..=9999).contains(d))
                .ok_or_else(|| {
                    Refusal::bad_request("paymentTermsDays must be a whole number of days or null")
                })?;
            Some(Some(days))
        }
    };
    patch.reminders_paused = match map.get("remindersPaused") {
        None => None,
        Some(Value::Bool(paused)) => Some(*paused),
        Some(_) => {
            return Err(Refusal::bad_request(
                "remindersPaused must be true or false",
            ));
        }
    };
    if patch == DefaultsPatch::default() {
        return Err(Refusal::bad_request("Nothing to update"));
    }
    Ok(patch)
}

pub(super) async fn update_defaults(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    reply(
        async {
            let patch = read_defaults(&json_of(&headers, &raw)?)?;
            apply_defaults(&caller, &state, &id, &patch).await
        }
        .await,
        "Failed to update the contact defaults",
    )
}

async fn apply_defaults(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    patch: &DefaultsPatch,
) -> Reply {
    let db = orm(&caller.db);
    let Some(party) = live_party(&caller.db, id).await? else {
        return Err(Refusal::not_found("Contact", id));
    };
    if let Some(Some(account)) = &patch.expense_account {
        let found = accounts::Entity::find_by_id(account.clone())
            .filter(accounts::Column::DeletedAt.is_null())
            .one(&db)
            .await?;
        if found.is_none() {
            return Err(Refusal::bad_request("Expense account not found"));
        }
    }
    if let Some(Some(rate)) = &patch.tax_rate {
        let found = tax_rates::Entity::find_by_id(rate.clone())
            .filter(tax_rates::Column::DeletedAt.is_null())
            .one(&db)
            .await?;
        if found.is_none() {
            return Err(Refusal::bad_request("Tax rate not found"));
        }
    }
    let mut update =
        parties::Entity::update_many().col_expr(parties::Column::UpdatedAt, Expr::value(utc_now()));
    let mut changes = Map::new();
    let mut change = |key: &str, before: Value, after: Value| {
        changes.insert(key.to_owned(), json!({ "from": before, "to": after }));
    };
    if let Some(account) = &patch.expense_account {
        update = update.col_expr(
            parties::Column::DefaultExpenseAccountId,
            Expr::value(account.clone()),
        );
        change(
            "defaultExpenseAccountId",
            json!(party.default_expense_account_id),
            json!(account),
        );
    }
    if let Some(rate) = &patch.tax_rate {
        update = update.col_expr(parties::Column::DefaultTaxRateId, Expr::value(rate.clone()));
        change(
            "defaultTaxRateId",
            json!(party.default_tax_rate_id),
            json!(rate),
        );
    }
    if let Some(days) = &patch.payment_terms_days {
        update = update.col_expr(
            parties::Column::PaymentTerms,
            Expr::value(days.map(|d| d.to_string())),
        );
        change(
            "paymentTermsDays",
            parse_payment_terms_days(party.payment_terms.as_deref()),
            json!(days),
        );
    }
    if let Some(paused) = patch.reminders_paused {
        // Per legal entity: the entity's own list (and an old pause of the
        // contact moves there first).
        let Some(entity) = resolve_entity_id(caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let was = set_contact_paused(&caller.db, &entity, id, paused).await?;
        change("remindersPaused", json!(was), json!(paused));
    }
    update.filter(parties::Column::Id.eq(id)).exec(&db).await?;
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: None,
            entity_type: "accounting_contact",
            entity_id: id,
            action: "updated",
            changes: Some(changes),
        },
    )
    .await;
    let updated = load_contact_view(&caller.db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Contact", id))?;
    caller.publish(
        state,
        ACCOUNTING_CONTACT_UPDATED,
        id,
        strip_tax_fields_for_event(&updated),
    );
    let fresh = live_party(&caller.db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Contact", id))?;
    let paused = paused_in_request_entity(caller, id).await?;
    Ok(ok(defaults_view(&fresh, paused)))
}

/// Paging of `/invoices` and `/bills`, opt-in: `None` without `page` and
/// `pageSize` (the list answers as it always did).
pub(super) fn page_window(caller: &Caller) -> Result<Option<(u64, u64)>, Refusal> {
    let q = caller.query();
    if q.present("page").is_none() && q.present("pageSize").is_none() {
        return Ok(None);
    }
    let parse = |key: &str, fallback: i64| {
        weldsuite_books_domain::js::parse_int(q.present(key).unwrap_or(&fallback.to_string()))
            .ok_or_else(|| Refusal::bad_request("page and pageSize must be numbers"))
    };
    let page = u64::try_from(parse("page", 1)?.max(1)).unwrap_or(1);
    let size = u64::try_from(parse("pageSize", 25)?.clamp(1, 100)).unwrap_or(25);
    Ok(Some((page, size)))
}

/// A page of `select` (newest first by `date`, then id) as the list envelope.
pub(super) async fn page_of<E>(
    db: &DatabaseConnection,
    select: Select<E>,
    date: E::Column,
    id: E::Column,
    (page, size): (u64, u64),
    row_json: fn(E::Model) -> Result<Value, DbErr>,
) -> Result<Response, Refusal>
where
    E: EntityTrait,
    E::Model: Sync,
{
    let total = select.clone().count(db).await?;
    let rows = select
        .order_by_desc(date)
        .order_by_desc(id)
        .limit(size)
        .offset((page - 1) * size)
        .all(db)
        .await?;
    let rows = rows
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<Value>, DbErr>>()?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    Ok(paged(
        rows,
        total,
        i64::try_from(page * size).unwrap_or(i64::MAX) < total,
        None,
    ))
}

#[cfg(test)]
mod db_tests;
