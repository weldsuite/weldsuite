//! `/api/accounting-todo`: what needs the bookkeeper's attention in one
//! legal entity, on request. Rust-only (edition feature `books-todo`).
//!
//! Nothing is stored as a task: every kind is a question asked of the books
//! (unreconciled bank lines, inbox documents, bills waiting for approval, …)
//! and the answer is a count and a sum (`/summary`) or the rows themselves
//! (`/`). A kind is only included when the caller may read what it counts.
//!
//! - `GET /summary`: `{ total, currency, kinds: { <kind>: { count, amount,
//!   currency, mixedCurrency } } }`; counts and sums only, no scoring.
//! - `GET /?kind=&cursor=&limit=`: items of one kind, or of every kind (most
//!   urgent kind first) when `kind` is omitted. The cursor is `<kind>:<offset>`:
//!   the position of the first item of the next page.
//!
//! Item titles and subtitles are data (a counterparty, a number); the `hint`
//! is a machine code the platform translates.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::RawQuery;
use axum::response::Response;
use axum::routing::get;
use sea_orm::sea_query::{Condition, Expr, Func};
use sea_orm::{
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    Select, prelude::BigDecimal,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::bank_matching::{Candidates, find_matches, load_candidates};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::http::{BooksState, Caller, Query, Refusal, Reply, paged, reply};
use weldsuite_books_domain::js::days_from_civil;
use weldsuite_books_domain::jurisdictions;
use weldsuite_books_domain::reports_basis::today_for;
use weldsuite_legal_entities::{LegalEntityApp, default_entity_id_for};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    bank_accounts, bank_connections, bank_transactions, bills, documents, entities, invoices,
    parties, payments, vat_returns,
};

use crate::rows::{js, js_rows, timestamp_of_millis};

const DAY_MS: i64 = 86_400_000;
/// A bank line scores as a good match from here (`auto_reconcile_batch`'s bar).
const GOOD_MATCH: f64 = 0.8;
/// Consent is flagged this many days before it lapses (the feed sync's own window).
const CONSENT_DAYS: i64 = 14;
/// Bills are "due" this many days ahead.
const BILL_DUE_DAYS: i64 = 7;
const DEFAULT_LIMIT: i64 = 25;
const MAX_LIMIT: i64 = 100;

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    // The kinds check their own permissions, so the routes only resolve the member.
    Router::new()
        .route("/summary", get(summary).route_layer(gate.resolve()))
        .route("/", get(list).route_layer(gate.resolve()))
        .with_state(state)
}

/// What can need attention, most urgent first (the order of an unfiltered list).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    VatReturn,
    BankFeeds,
    InvoicesOverdue,
    BillsDue,
    BillsToApprove,
    Documents,
    Duplicates,
    BankLines,
    UnappliedCredit,
    /// Accountant-facing (Rust only, edition feature `books-receipts`):
    /// bank lines booked to an expense with VAT and no receipt. Not part of
    /// the owner's total or of the list with no `kind`.
    MissingReceipts,
}

const KINDS: [Kind; 10] = [
    Kind::VatReturn,
    Kind::BankFeeds,
    Kind::InvoicesOverdue,
    Kind::BillsDue,
    Kind::BillsToApprove,
    Kind::Documents,
    Kind::Duplicates,
    Kind::BankLines,
    Kind::UnappliedCredit,
    Kind::MissingReceipts,
];

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::VatReturn => "vat_return",
            Self::BankFeeds => "bank_feeds",
            Self::InvoicesOverdue => "invoices_overdue",
            Self::BillsDue => "bills_due",
            Self::BillsToApprove => "bills_to_approve",
            Self::Documents => "documents",
            Self::Duplicates => "duplicates",
            Self::BankLines => "bank_lines",
            Self::UnappliedCredit => "unapplied_credit",
            Self::MissingReceipts => "missing_receipts",
        }
    }

    /// Whether the kind is part of the owner's "to process" (the summary's
    /// `total` and the list with no `kind`). Missing receipts are the
    /// accountant's question, asked for by name.
    fn is_owner_work(self) -> bool {
        self != Self::MissingReceipts
    }

    fn parse(name: &str) -> Option<Self> {
        KINDS.into_iter().find(|kind| kind.as_str() == name)
    }

    /// The permission that reads what the kind counts (the key of the route
    /// that lists those records).
    fn permission(self) -> &'static str {
        match self {
            Self::VatReturn | Self::MissingReceipts => "reports:read",
            Self::BankFeeds | Self::Duplicates | Self::BankLines | Self::UnappliedCredit => {
                "banking:read"
            }
            Self::InvoicesOverdue | Self::Documents => "invoices:read",
            Self::BillsDue | Self::BillsToApprove => "bills:read",
        }
    }
}

/// What every query of a request shares.
struct Ctx {
    db: PgPool,
    orm: DatabaseConnection,
    entity_id: String,
    /// The entity's base currency; sums are in it.
    base: String,
    now_ms: i64,
    /// Midnight of the entity's today, in the columns' clock (UTC wall time).
    today_ms: i64,
    /// Documents with no entity belong to the default one.
    is_default_entity: bool,
    /// The entity's jurisdiction has a VAT return.
    has_vat_return: bool,
}

impl Ctx {
    async fn load(caller: &Caller) -> Result<Self, Refusal> {
        let Some(entity_id) = resolve_entity_id(caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let orm = weldsuite_db::orm(&caller.db);
        let entity = entities::Entity::find_by_id(entity_id.clone())
            .filter(entities::Column::DeletedAt.is_null())
            .one(&orm)
            .await?;
        let Some(entity) = entity.map(|row| js!(row)).transpose()? else {
            return Err(Refusal::not_found("Accounting entity", &entity_id));
        };
        let text = |key: &str| entity.get(key).and_then(Value::as_str);
        let now_ms = caller.now_ms();
        let today = today_for(text("timezone"), now_ms);
        let part = |range: std::ops::Range<usize>, fallback: i64| {
            today
                .get(range)
                .and_then(|p| p.parse().ok())
                .unwrap_or(fallback)
        };
        let today_ms = days_from_civil(part(0..4, 1970), part(5..7, 1), part(8..10, 1)) * DAY_MS;
        let default = default_entity_id_for(&caller.db, Some(LegalEntityApp::Weldbooks)).await?;
        Ok(Self {
            db: caller.db.clone(),
            orm,
            base: text("baseCurrency").unwrap_or_default().to_owned(),
            now_ms,
            today_ms,
            is_default_entity: default.as_deref() == Some(entity_id.as_str()),
            has_vat_return: jurisdictions::features(text("jurisdictionCode"))["vatReturn"]
                .as_bool()
                .unwrap_or(false),
            entity_id,
        })
    }
}

// ── What each kind counts ───────────────────────────────────────────────────

/// The entity's bank lines to book: unreconciled (so not excluded), on a live
/// account of the entity.
fn bank_lines_cond(ctx: &Ctx) -> Condition {
    use bank_transactions::Column as C;
    Condition::all()
        .add(C::EntityId.eq(ctx.entity_id.as_str()))
        .add(C::DeletedAt.is_null())
        .add(C::Status.eq("unreconciled"))
        .add(Expr::cust(
            "EXISTS (SELECT 1 FROM bank_accounts b WHERE b.id = bank_transactions.bank_account_id \
             AND b.entity_id = bank_transactions.entity_id AND b.deleted_at IS NULL)",
        ))
}

fn duplicates_cond(ctx: &Ctx) -> Condition {
    bank_lines_cond(ctx).add(bank_transactions::Column::PossibleDuplicateOfId.is_not_null())
}

/// The `bank_lines` kind: lines to book that aren't flagged as a possible
/// duplicate. A flagged line is under `duplicates` only, so the total counts
/// every line once.
fn to_book_cond(ctx: &Ctx) -> Condition {
    bank_lines_cond(ctx).add(bank_transactions::Column::PossibleDuplicateOfId.is_null())
}

/// Inbox documents still to process; those with no entity count for the
/// default entity only.
fn documents_cond(ctx: &Ctx) -> Condition {
    use documents::Column as C;
    let mut entity = Condition::any().add(C::EntityId.eq(ctx.entity_id.as_str()));
    if ctx.is_default_entity {
        entity = entity.add(C::EntityId.is_null());
    }
    Condition::all()
        .add(C::DeletedAt.is_null())
        .add(C::Status.is_in(["pending", "processing", "processed", "failed"]))
        .add(entity)
}

/// Bills posted by nobody yet: a draft nobody approved or rejected (a rejected
/// bill is cancelled).
fn bills_to_approve_cond(ctx: &Ctx) -> Condition {
    use bills::Column as C;
    Condition::all()
        .add(C::EntityId.eq(ctx.entity_id.as_str()))
        .add(C::DeletedAt.is_null())
        .add(C::Status.eq("draft"))
        .add(C::JournalEntryId.is_null())
        .add(
            Condition::any()
                .add(C::ApprovalStatus.is_null())
                .add(C::ApprovalStatus.eq("pending")),
        )
}

/// Approved bills with a balance, overdue or due within a week.
fn bills_due_cond(ctx: &Ctx) -> Result<Condition, DbErr> {
    use bills::Column as C;
    Ok(Condition::all()
        .add(C::EntityId.eq(ctx.entity_id.as_str()))
        .add(C::DeletedAt.is_null())
        .add(C::Status.is_in(["approved", "partial", "overdue"]))
        .add(C::BalanceDue.gt(0))
        .add(C::DueDate.lt(timestamp_of_millis(
            ctx.today_ms + (BILL_DUE_DAYS + 1) * DAY_MS,
        )?)))
}

/// Posted invoices past their due date with a balance; `partial` counts.
fn invoices_overdue_cond(ctx: &Ctx) -> Result<Condition, DbErr> {
    use invoices::Column as C;
    Ok(Condition::all()
        .add(C::EntityId.eq(ctx.entity_id.as_str()))
        .add(C::DeletedAt.is_null())
        .add(C::BalanceDue.gt(0))
        .add(C::Status.is_not_in([
            "draft",
            "cancelled",
            "void",
            "paid",
            "uncollectible",
            "written_off",
        ]))
        .add(C::Type.is_not_in(["credit_note", "proforma"]))
        .add(C::DueDate.lt(timestamp_of_millis(ctx.today_ms)?)))
}

/// A VAT return the books hold that is not filed, for a period that has ended
/// (a return exists once someone calculated it; the entity does not store a
/// filing frequency, so a period nobody calculated yet is not known).
fn vat_return_cond(ctx: &Ctx) -> Result<Condition, DbErr> {
    use vat_returns::Column as C;
    Ok(Condition::all()
        .add(C::EntityId.eq(ctx.entity_id.as_str()))
        .add(C::DeletedAt.is_null())
        .add(C::Status.is_not_in(["filed", "submitted", "accepted"]))
        .add(C::PeriodEnd.lt(timestamp_of_millis(ctx.today_ms)?)))
}

/// Bank connections that need the member: failed, or about to lose consent,
/// with at least one account of the entity on them (the panel to open).
fn bank_feeds_cond(ctx: &Ctx) -> Result<Condition, DbErr> {
    use bank_connections::Column as C;
    Ok(Condition::all()
        .add(C::EntityId.eq(ctx.entity_id.as_str()))
        .add(C::DeletedAt.is_null())
        .add(Expr::cust(
            "EXISTS (SELECT 1 FROM bank_accounts b WHERE b.feed_connection_id = bank_connections.id \
             AND b.deleted_at IS NULL)",
        ))
        .add(
            Condition::any()
                .add(C::Status.is_in(["error", "reauth_required", "expiring"]))
                .add(
                    Condition::all()
                        .add(C::Status.is_not_in(["revoked", "disconnected"]))
                        .add(C::ConsentExpiresAt.is_not_null())
                        .add(C::ConsentExpiresAt.lte(timestamp_of_millis(
                            ctx.now_ms + CONSENT_DAYS * DAY_MS,
                        )?)),
                ),
        ))
}

/// What a live payment did not allocate to a document.
const UNALLOCATED: &str = "payments.amount - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a \
     WHERE a.payment_id = payments.id AND a.deleted_at IS NULL), 0)";

/// Payments with an unallocated remainder, not voided. A payment tied to a
/// document by the old single `invoice_id`/`bill_id` with no allocation rows
/// counts as applied, and so does one paid through payroll.
fn unapplied_credit_cond(ctx: &Ctx) -> Condition {
    use payments::Column as C;
    Condition::all()
        .add(C::EntityId.eq(ctx.entity_id.as_str()))
        .add(C::DeletedAt.is_null())
        .add(Expr::cust("COALESCE(payments.paid_through_payroll, false) = false"))
        .add(Expr::cust(format!("{UNALLOCATED} > 0.005")))
        .add(Expr::cust(
            "((payments.invoice_id IS NULL AND payments.bill_id IS NULL) OR EXISTS (SELECT 1 \
             FROM payment_allocations a2 WHERE a2.payment_id = payments.id AND a2.deleted_at IS NULL))",
        ))
}

/// Bank lines booked to an expense with VAT claimed, by hand or by a rule,
/// money out, with no document attached to the line and no bill behind the
/// payment (a line settled through a bill's payment has its receipt there).
/// Three `EXISTS` on indexed ids keep the count cheap; nothing is scored.
fn missing_receipts_cond(ctx: &Ctx) -> Condition {
    use bank_transactions::Column as C;
    Condition::all()
        .add(C::EntityId.eq(ctx.entity_id.as_str()))
        .add(C::DeletedAt.is_null())
        .add(C::Status.eq("reconciled"))
        .add(C::ReconciliationType.is_in(["manual", "auto"]))
        .add(C::JournalEntryId.is_not_null())
        .add(C::ReconciledPaymentId.is_null())
        .add(C::ReconciledBillId.is_null())
        .add(C::ReconciledInvoiceId.is_null())
        .add(C::DepositId.is_null())
        .add(Expr::cust("bank_transactions.amount < 0"))
        .add(Expr::cust(
            "EXISTS (SELECT 1 FROM tax_lines t WHERE t.journal_entry_id = bank_transactions.journal_entry_id \
             AND t.direction = 'purchase' AND t.tax_amount > 0)",
        ))
        .add(Expr::cust(
            "EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id \
             WHERE l.journal_entry_id = bank_transactions.journal_entry_id AND l.deleted_at IS NULL \
             AND a.type = 'expense')",
        ))
        .add(Expr::cust(
            "NOT EXISTS (SELECT 1 FROM documents d WHERE d.deleted_at IS NULL \
             AND d.linked_entity_type = 'bank_transaction' AND d.linked_entity_id = bank_transactions.id)",
        ))
}

// ── Counts and sums ─────────────────────────────────────────────────────────

/// A kind's count and sum, for the summary.
struct Tally {
    count: i64,
    amount: Option<BigDecimal>,
    /// Some rows are in another currency and are not in `amount`.
    mixed: bool,
}

/// `count(*)`, `sum(amount)` and `count(foreign)` of the rows.
async fn aggregate<E: EntityTrait>(
    orm: &DatabaseConnection,
    rows: Select<E>,
    amount: Option<Expr>,
    foreign: Option<Expr>,
) -> Result<Tally, DbErr> {
    let mut select = rows
        .select_only()
        .expr_as(Func::count(Expr::cust("*")), "count");
    select = select.expr_as(
        amount.map_or_else(|| Expr::cust("NULL::numeric"), |a| Func::sum(a).into()),
        "amount",
    );
    select = select.expr_as(
        foreign.map_or_else(|| Expr::cust("0::bigint"), |f| Func::count(f).into()),
        "foreign",
    );
    let (count, amount, foreign) = select
        .into_tuple::<(i64, Option<BigDecimal>, i64)>()
        .one(orm)
        .await?
        .unwrap_or((0, None, 0));
    Ok(Tally {
        count,
        amount,
        mixed: foreign > 0,
    })
}

/// `inner` in the base currency: a foreign document's rate is foreign units
/// per base unit (`balance_in_base`).
fn in_base(table: &str, inner: &str, base: &str) -> Expr {
    Expr::cust_with_values(
        format!(
            "CASE WHEN COALESCE({table}.currency, $1) IN ($1, $2) OR COALESCE({table}.exchange_rate, 0) <= 0 \
             THEN ({inner}) ELSE ({inner}) / {table}.exchange_rate END"
        ),
        // $1 is the empty text and $2 the base currency (no quoted literals in the text).
        ["", base],
    )
}

#[allow(clippy::too_many_lines)] // one arm per kind
async fn tally(kind: Kind, ctx: &Ctx) -> Result<Tally, DbErr> {
    let orm = &ctx.orm;
    match kind {
        Kind::BankLines | Kind::Duplicates => {
            let cond = if kind == Kind::BankLines {
                to_book_cond(ctx)
            } else {
                duplicates_cond(ctx)
            };
            // A line has no rate: only the base currency's lines are summed.
            let account_currency = "COALESCE((SELECT b.currency FROM bank_accounts b \
                 WHERE b.id = bank_transactions.bank_account_id), $1)";
            let amount = Expr::cust_with_values(
                format!(
                    "CASE WHEN {account_currency} IN ($1, $2) THEN ABS(bank_transactions.amount) END"
                ),
                ["", ctx.base.as_str()],
            );
            let foreign = Expr::cust_with_values(
                format!("CASE WHEN {account_currency} NOT IN ($1, $2) THEN 1 END"),
                ["", ctx.base.as_str()],
            );
            aggregate(
                orm,
                bank_transactions::Entity::find().filter(cond),
                Some(amount),
                Some(foreign),
            )
            .await
        }
        Kind::Documents => {
            aggregate(
                orm,
                documents::Entity::find().filter(documents_cond(ctx)),
                None,
                None,
            )
            .await
        }
        Kind::BillsToApprove => {
            let amount = in_base("bills", "bills.total", &ctx.base);
            aggregate(
                orm,
                bills::Entity::find().filter(bills_to_approve_cond(ctx)),
                Some(amount),
                None,
            )
            .await
        }
        Kind::BillsDue => {
            let amount = in_base("bills", "bills.balance_due", &ctx.base);
            aggregate(
                orm,
                bills::Entity::find().filter(bills_due_cond(ctx)?),
                Some(amount),
                None,
            )
            .await
        }
        Kind::InvoicesOverdue => {
            let amount = in_base("invoices", "invoices.balance_due", &ctx.base);
            aggregate(
                orm,
                invoices::Entity::find().filter(invoices_overdue_cond(ctx)?),
                Some(amount),
                None,
            )
            .await
        }
        Kind::VatReturn => {
            if !ctx.has_vat_return {
                return Ok(Tally {
                    count: 0,
                    amount: None,
                    mixed: false,
                });
            }
            aggregate(
                orm,
                vat_returns::Entity::find().filter(vat_return_cond(ctx)?),
                None,
                None,
            )
            .await
        }
        Kind::BankFeeds => {
            aggregate(
                orm,
                bank_connections::Entity::find().filter(bank_feeds_cond(ctx)?),
                None,
                None,
            )
            .await
        }
        Kind::UnappliedCredit => {
            let amount = in_base("payments", UNALLOCATED, &ctx.base);
            aggregate(
                orm,
                payments::Entity::find().filter(unapplied_credit_cond(ctx)),
                Some(amount),
                None,
            )
            .await
        }
        Kind::MissingReceipts => {
            let account_currency = "COALESCE((SELECT b.currency FROM bank_accounts b \
                 WHERE b.id = bank_transactions.bank_account_id), $1)";
            let amount = Expr::cust_with_values(
                format!(
                    "CASE WHEN {account_currency} IN ($1, $2) THEN ABS(bank_transactions.amount) END"
                ),
                ["", ctx.base.as_str()],
            );
            let foreign = Expr::cust_with_values(
                format!("CASE WHEN {account_currency} NOT IN ($1, $2) THEN 1 END"),
                ["", ctx.base.as_str()],
            );
            aggregate(
                orm,
                bank_transactions::Entity::find().filter(missing_receipts_cond(ctx)),
                Some(amount),
                Some(foreign),
            )
            .await
        }
    }
}

/// The kinds the caller may read, in order.
fn readable(caller: &Caller) -> Vec<Kind> {
    KINDS
        .into_iter()
        .filter(|kind| caller.can(kind.permission()))
        .collect()
}

fn amount_text(amount: Option<&BigDecimal>) -> Value {
    amount.map_or(Value::Null, |a| json!(a.with_scale(2).to_plain_string()))
}

// ── GET /summary ────────────────────────────────────────────────────────────

async fn summary(caller: Caller) -> Response {
    reply(
        build_summary(&caller).await,
        "Failed to fetch the to-process counts",
    )
}

async fn build_summary(caller: &Caller) -> Reply {
    let ctx = Ctx::load(caller).await?;
    let mut total = 0_i64;
    let mut kinds = serde_json::Map::new();
    for kind in readable(caller) {
        let tally = tally(kind, &ctx).await?;
        if kind.is_owner_work() {
            total += tally.count;
        }
        let mut entry = json!({
            "count": tally.count,
            "amount": amount_text(tally.amount.as_ref()),
        });
        if tally.amount.is_some() {
            entry["currency"] = json!(ctx.base);
            entry["mixedCurrency"] = json!(tally.mixed);
        }
        kinds.insert(kind.as_str().to_owned(), entry);
    }
    Ok(weldsuite_books_domain::http::ok(json!({
        "total": total,
        "currency": ctx.base,
        "kinds": kinds,
    })))
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// One thing to do, as the list returns it.
struct Item {
    object_type: &'static str,
    object_id: String,
    title: Option<String>,
    subtitle: Option<String>,
    amount: Option<String>,
    currency: Option<String>,
    date: Option<String>,
    due_date: Option<String>,
    severity: &'static str,
    hint: Option<&'static str>,
}

impl Item {
    fn json(&self, kind: Kind) -> Value {
        json!({
            "kind": kind.as_str(),
            "objectType": self.object_type,
            "objectId": self.object_id,
            "title": self.title,
            "subtitle": self.subtitle,
            "amount": self.amount,
            "currency": self.currency,
            "date": self.date,
            "dueDate": self.due_date,
            "severity": self.severity,
            "hint": self.hint,
        })
    }
}

/// A non-empty text of a row.
fn s(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
}

/// A non-empty text at a path of a row's JSON column.
fn at(row: &Value, path: &[&str]) -> Option<String> {
    let found = path.iter().try_fold(row, |value, key| value.get(*key))?;
    match found {
        Value::String(text) => Some(text.clone()).filter(|v| !v.trim().is_empty()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Whole days between a timestamp text and midnight today (positive: past).
fn days_past(ctx: &Ctx, iso: Option<&str>) -> Option<i64> {
    let millis = weldsuite_books_domain::js::js_date_millis(iso?)?;
    Some((ctx.today_ms - millis).div_euclid(DAY_MS))
}

async fn account_names(
    ctx: &Ctx,
) -> Result<HashMap<String, (Option<String>, Option<String>)>, DbErr> {
    let rows: Vec<(String, String, Option<String>)> = bank_accounts::Entity::find()
        .select_only()
        .columns([
            bank_accounts::Column::Id,
            bank_accounts::Column::Name,
            bank_accounts::Column::Currency,
        ])
        .filter(bank_accounts::Column::EntityId.eq(ctx.entity_id.as_str()))
        .into_tuple()
        .all(&ctx.orm)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, currency)| (id, (Some(name), currency)))
        .collect())
}

async fn contact_names(ctx: &Ctx, ids: &[String]) -> Result<HashMap<String, String>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>)> = parties::Entity::find()
        .select_only()
        .columns([parties::Column::Id, parties::Column::DisplayName])
        .filter(parties::Column::Id.is_in(ids))
        .into_tuple()
        .all(&ctx.orm)
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, name)| Some((id, name.filter(|n| !n.trim().is_empty())?)))
        .collect())
}

/// A bank line as an item; `good_match` marks one the matcher is sure of.
fn bank_line_item(
    row: &Value,
    accounts: &HashMap<String, (Option<String>, Option<String>)>,
    hint: Option<&'static str>,
    severity: &'static str,
) -> Item {
    let currency = s(row, "bankAccountId")
        .and_then(|id| accounts.get(&id).and_then(|(_, currency)| currency.clone()));
    Item {
        object_type: "bank_transaction",
        object_id: s(row, "id").unwrap_or_default(),
        title: s(row, "counterpartyName")
            .or_else(|| s(row, "merchantName"))
            .or_else(|| s(row, "description")),
        subtitle: s(row, "reference").or_else(|| s(row, "description")),
        amount: s(row, "amount"),
        currency,
        date: s(row, "date"),
        due_date: None,
        severity,
        hint,
    }
}

#[allow(clippy::too_many_lines)] // one arm per kind
async fn items(kind: Kind, ctx: &Ctx, offset: u64, limit: u64) -> Result<Vec<Item>, DbErr> {
    let orm = &ctx.orm;
    match kind {
        Kind::BankLines | Kind::Duplicates => {
            use bank_transactions::Column as C;
            let duplicates = kind == Kind::Duplicates;
            let cond = if duplicates {
                duplicates_cond(ctx)
            } else {
                to_book_cond(ctx)
            };
            let rows = bank_transactions::Entity::find()
                .filter(cond)
                .order_by_desc(C::Date)
                .order_by_asc(C::Id)
                .offset(offset)
                .limit(limit)
                .all(orm)
                .await?;
            let rows = js_rows!(rows)?;
            let accounts = account_names(ctx).await?;
            let mut out = Vec::with_capacity(rows.len());
            // One candidate pool for the page, not one per line.
            let pool: Option<Candidates> = if duplicates || rows.is_empty() {
                None
            } else {
                Some(load_candidates(&ctx.db, Some(&ctx.entity_id), None, None, None).await?)
            };
            for row in &rows {
                if duplicates {
                    out.push(bank_line_item(
                        row,
                        &accounts,
                        Some("possible_duplicate"),
                        "warning",
                    ));
                    continue;
                }
                let good = find_matches(&ctx.db, row, pool.as_ref())
                    .await?
                    .first()
                    .is_some_and(|best| best.confidence >= GOOD_MATCH);
                out.push(bank_line_item(
                    row,
                    &accounts,
                    good.then_some("possible_match"),
                    "info",
                ));
            }
            Ok(out)
        }
        Kind::Documents => {
            use documents::Column as C;
            let rows = documents::Entity::find()
                .filter(documents_cond(ctx))
                .order_by_desc(C::CreatedAt)
                .order_by_asc(C::Id)
                .offset(offset)
                .limit(limit)
                .all(orm)
                .await?;
            Ok(js_rows!(rows)?
                .iter()
                .map(|row| {
                    let failed = s(row, "status").as_deref() == Some("failed");
                    let ocr = row.get("ocrResult").unwrap_or(&Value::Null);
                    Item {
                        object_type: "accounting_document",
                        object_id: s(row, "id").unwrap_or_default(),
                        title: at(ocr, &["vendor", "name"]).or_else(|| s(row, "fileName")),
                        subtitle: at(ocr, &["invoiceNumber"]),
                        amount: at(ocr, &["total"]),
                        currency: at(ocr, &["currency"]).filter(|_| ocr.get("total").is_some()),
                        date: at(ocr, &["invoiceDate"]).or_else(|| s(row, "createdAt")),
                        due_date: at(ocr, &["dueDate"]),
                        severity: if failed { "warning" } else { "info" },
                        hint: failed.then_some("ocr_failed"),
                    }
                })
                .collect())
        }
        Kind::BillsToApprove | Kind::BillsDue => {
            use bills::Column as C;
            let due = kind == Kind::BillsDue;
            let cond = if due {
                bills_due_cond(ctx)?
            } else {
                bills_to_approve_cond(ctx)
            };
            let rows = bills::Entity::find()
                .filter(cond)
                .order_by_asc(C::DueDate)
                .order_by_asc(C::Id)
                .offset(offset)
                .limit(limit)
                .all(orm)
                .await?;
            Ok(js_rows!(rows)?
                .iter()
                .map(|row| {
                    let overdue =
                        days_past(ctx, s(row, "dueDate").as_deref()).is_some_and(|d| d > 0);
                    let (severity, hint) = if !due {
                        ("info", "awaiting_approval")
                    } else if overdue {
                        ("danger", "overdue")
                    } else {
                        ("warning", "due_soon")
                    };
                    Item {
                        object_type: "bill",
                        object_id: s(row, "id").unwrap_or_default(),
                        title: s(row, "contactName"),
                        subtitle: s(row, "billNumber"),
                        amount: s(row, if due { "balanceDue" } else { "total" }),
                        currency: s(row, "currency"),
                        date: s(row, "issueDate"),
                        due_date: s(row, "dueDate"),
                        severity,
                        hint: Some(hint),
                    }
                })
                .collect())
        }
        Kind::InvoicesOverdue => {
            use invoices::Column as C;
            let rows = invoices::Entity::find()
                .filter(invoices_overdue_cond(ctx)?)
                .order_by_asc(C::DueDate)
                .order_by_asc(C::Id)
                .offset(offset)
                .limit(limit)
                .all(orm)
                .await?;
            Ok(js_rows!(rows)?
                .iter()
                .map(|row| {
                    let days = days_past(ctx, s(row, "dueDate").as_deref()).unwrap_or(0);
                    Item {
                        object_type: "invoice",
                        object_id: s(row, "id").unwrap_or_default(),
                        title: s(row, "contactName"),
                        subtitle: s(row, "invoiceNumber"),
                        amount: s(row, "balanceDue"),
                        currency: s(row, "currency"),
                        date: s(row, "issueDate"),
                        due_date: s(row, "dueDate"),
                        severity: if days > 30 { "danger" } else { "warning" },
                        hint: Some(if s(row, "status").as_deref() == Some("partial") {
                            "overdue_partial"
                        } else {
                            "overdue"
                        }),
                    }
                })
                .collect())
        }
        Kind::VatReturn => {
            use vat_returns::Column as C;
            if !ctx.has_vat_return {
                return Ok(Vec::new());
            }
            let rows = vat_returns::Entity::find()
                .filter(vat_return_cond(ctx)?)
                .order_by_asc(C::PeriodEnd)
                .order_by_asc(C::Id)
                .offset(offset)
                .limit(limit)
                .all(orm)
                .await?;
            Ok(js_rows!(rows)?
                .iter()
                .map(|row| {
                    // The only deadline the books hold is a correction's.
                    let due_date = s(row, "suppletieDeadline");
                    let late = due_date
                        .as_deref()
                        .and_then(|d| days_past(ctx, Some(d)))
                        .is_some_and(|d| d > 0);
                    Item {
                        object_type: "vat_return",
                        object_id: s(row, "id").unwrap_or_default(),
                        title: s(row, "periodLabel"),
                        subtitle: s(row, "periodType"),
                        amount: None,
                        currency: None,
                        date: s(row, "periodEnd"),
                        due_date,
                        severity: if late { "danger" } else { "warning" },
                        hint: Some(if s(row, "status").as_deref() == Some("rejected") {
                            "rejected"
                        } else {
                            "not_filed"
                        }),
                    }
                })
                .collect())
        }
        Kind::BankFeeds => {
            use bank_connections::Column as C;
            let rows = bank_connections::Entity::find()
                .filter(bank_feeds_cond(ctx)?)
                .order_by_desc(C::UpdatedAt)
                .order_by_asc(C::Id)
                .offset(offset)
                .limit(limit)
                .all(orm)
                .await?;
            let rows = js_rows!(rows)?;
            let ids: Vec<String> = rows.iter().filter_map(|r| s(r, "id")).collect();
            // The first live account on each connection is the panel to open.
            let accounts: Vec<(String, Option<String>)> = bank_accounts::Entity::find()
                .select_only()
                .columns([
                    bank_accounts::Column::Id,
                    bank_accounts::Column::FeedConnectionId,
                ])
                .filter(bank_accounts::Column::FeedConnectionId.is_in(&ids))
                .filter(bank_accounts::Column::DeletedAt.is_null())
                .order_by_asc(bank_accounts::Column::CreatedAt)
                .order_by_asc(bank_accounts::Column::Id)
                .into_tuple()
                .all(orm)
                .await?;
            let mut first: HashMap<String, String> = HashMap::new();
            for (account, connection) in accounts {
                if let Some(connection) = connection {
                    first.entry(connection).or_insert(account);
                }
            }
            Ok(rows
                .iter()
                .filter_map(|row| {
                    let status = s(row, "status").unwrap_or_default();
                    let (severity, hint) = match status.as_str() {
                        "error" => ("danger", "connection_error"),
                        "reauth_required" => ("danger", "reauth_required"),
                        _ => ("warning", "consent_expiring"),
                    };
                    Some(Item {
                        object_type: "bank_account",
                        object_id: first.get(&s(row, "id")?)?.clone(),
                        title: s(row, "institutionName"),
                        subtitle: s(row, "provider"),
                        amount: None,
                        currency: None,
                        date: s(row, "lastSyncedAt"),
                        due_date: s(row, "consentExpiresAt"),
                        severity,
                        hint: Some(hint),
                    })
                })
                .collect())
        }
        Kind::MissingReceipts => {
            use bank_transactions::Column as C;
            let rows = bank_transactions::Entity::find()
                .filter(missing_receipts_cond(ctx))
                .order_by_desc(C::Date)
                .order_by_asc(C::Id)
                .offset(offset)
                .limit(limit)
                .all(orm)
                .await?;
            let rows = js_rows!(rows)?;
            let accounts = account_names(ctx).await?;
            Ok(rows
                .iter()
                .map(|row| bank_line_item(row, &accounts, Some("missing_receipt"), "info"))
                .collect())
        }
        Kind::UnappliedCredit => {
            use payments::Column as C;
            let rows = payments::Entity::find()
                .filter(unapplied_credit_cond(ctx))
                .order_by_desc(C::Date)
                .order_by_asc(C::Id)
                .offset(offset)
                .limit(limit)
                .all(orm)
                .await?;
            let rows = js_rows!(rows)?;
            let ids: Vec<String> = rows.iter().filter_map(|r| s(r, "contactId")).collect();
            let names = contact_names(ctx, &ids).await?;
            // The remainder of every payment of the page, in one read.
            let payment_ids: Vec<String> = rows.iter().filter_map(|r| s(r, "id")).collect();
            let remainders: Vec<(String, BigDecimal)> = payments::Entity::find()
                .select_only()
                .column(C::Id)
                .expr_as(Expr::cust(UNALLOCATED), "remainder")
                .filter(C::Id.is_in(&payment_ids))
                .into_tuple()
                .all(orm)
                .await?;
            let remainders: HashMap<String, BigDecimal> = remainders.into_iter().collect();
            Ok(rows
                .iter()
                .map(|row| {
                    let id = s(row, "id").unwrap_or_default();
                    Item {
                        object_type: "payment",
                        title: s(row, "contactId").and_then(|c| names.get(&c).cloned()),
                        subtitle: s(row, "reference"),
                        amount: remainders
                            .get(&id)
                            .map(|r| r.with_scale(2).to_plain_string()),
                        currency: s(row, "currency").or_else(|| Some(ctx.base.clone())),
                        date: s(row, "date"),
                        due_date: None,
                        severity: "info",
                        hint: Some("unapplied_credit"),
                        object_id: id,
                    }
                })
                .collect())
        }
    }
}

/// `<kind>:<offset>`.
fn parse_cursor(raw: &str) -> Option<(usize, u64)> {
    let (name, offset) = raw.split_once(':')?;
    let kind = Kind::parse(name)?;
    Some((KINDS.iter().position(|k| *k == kind)?, offset.parse().ok()?))
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        list_items(&caller, &q).await,
        "Failed to fetch the to-process items",
    )
}

async fn list_items(caller: &Caller, q: &Query) -> Reply {
    let only = match q.present("kind") {
        Some(name) => {
            let Some(kind) = Kind::parse(name) else {
                return Err(Refusal::bad_request(format!("Unknown kind: {name}")));
            };
            if !caller.can(kind.permission()) {
                return Err(Refusal::forbidden(
                    "You do not have permission to see these items",
                ));
            }
            Some(kind)
        }
        None => None,
    };
    let limit = weldsuite_books_domain::http::list_limit(q, DEFAULT_LIMIT, MAX_LIMIT)
        .filter(|n| *n >= 1)
        .ok_or_else(|| Refusal::bad_request("limit must be a positive number"))?;
    let limit = u64::try_from(limit).unwrap_or(1);
    let (start_kind, start_offset) = match q.present("cursor") {
        Some(raw) => parse_cursor(raw).ok_or_else(|| Refusal::bad_request("Invalid cursor"))?,
        None => (0, 0),
    };
    let ctx = Ctx::load(caller).await?;
    let kinds: Vec<Kind> = match only {
        Some(kind) => vec![kind],
        None => readable(caller)
            .into_iter()
            .filter(|kind| kind.is_owner_work())
            .collect(),
    };
    let mut total = 0_i64;
    for kind in &kinds {
        total += tally(*kind, &ctx).await?.count;
    }
    // Walk the kinds in order, taking one more item than the page holds: the
    // extra one is where the next page starts.
    let mut taken: Vec<(Kind, u64, Item)> = Vec::new();
    let want = usize::try_from(limit)
        .unwrap_or(usize::MAX)
        .saturating_add(1);
    for kind in kinds {
        let at_kind = KINDS.iter().position(|k| *k == kind).unwrap_or(0);
        if at_kind < start_kind {
            continue;
        }
        let offset = if at_kind == start_kind {
            start_offset
        } else {
            0
        };
        let room = u64::try_from(want - taken.len()).unwrap_or(0);
        if room == 0 {
            break;
        }
        for (i, item) in items(kind, &ctx, offset, room)
            .await?
            .into_iter()
            .enumerate()
        {
            taken.push((kind, offset + i as u64, item));
        }
        if taken.len() >= want {
            break;
        }
    }
    let has_more = taken.len() > usize::try_from(limit).unwrap_or(usize::MAX);
    let cursor = has_more
        .then(|| taken.get(usize::try_from(limit).unwrap_or(0)))
        .flatten()
        .map(|(kind, offset, _)| format!("{}:{offset}", kind.as_str()));
    let data = taken
        .iter()
        .take(usize::try_from(limit).unwrap_or(usize::MAX))
        .map(|(kind, _, item)| item.json(*kind))
        .collect();
    Ok(paged(data, total, has_more, cursor))
}

/// The kinds against the real tenant schema (built from the journaled
/// migrations by `scripts/rust-test-db.ts`): each kind's positive, negative
/// and entity-isolation rows, the permissions and the paging.
///
/// Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.
#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    reason = "test fixtures are written in SQL, one scenario per test"
)]
mod db_tests {
    use std::collections::BTreeSet;

    use serde_json::Map;
    use weldsuite_kit::generate_id;
    use weldsuite_permissions::{Permissions, ResolvedPermissions};

    use super::*;

    const ALL: [&str; 4] = [
        "banking:read",
        "bills:read",
        "invoices:read",
        "reports:read",
    ];

    fn pool() -> Option<PgPool> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
            return None;
        };
        Some(weldsuite_db::master_pool(&url, 2).expect("tenant pool"))
    }

    async fn run(db: &PgPool, sql: &'static str, binds: &[&str]) {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(db).await.expect(sql);
    }

    async fn entity(db: &PgPool, jurisdiction: &str) -> String {
        let id = generate_id("ent");
        run(
            db,
            "insert into entities (id, name, jurisdiction_code, base_currency, is_active) \
             values ($1, 'To process test', $2, 'EUR', true)",
            &[&id, jurisdiction],
        )
        .await;
        id
    }

    async fn bank_account(db: &PgPool, entity: &str, currency: &str) -> String {
        let id = generate_id("bac");
        run(
            db,
            "insert into bank_accounts (id, entity_id, name, currency) values ($1, $2, 'Account', $3)",
            &[&id, entity, currency],
        )
        .await;
        id
    }

    async fn line(
        db: &PgPool,
        entity: &str,
        bank: &str,
        amount: &str,
        description: &str,
        status: &str,
        duplicate_of: Option<&str>,
    ) -> String {
        let id = generate_id("btx");
        sqlx::query(
            "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
               counterparty_name, status, possible_duplicate_of_id) \
             values ($1, $2, $3, now(), $4::numeric, $5, 'ACME TRADING BV', $6, $7)",
        )
        .bind(&id)
        .bind(entity)
        .bind(bank)
        .bind(amount)
        .bind(description)
        .bind(status)
        .bind(duplicate_of)
        .execute(db)
        .await
        .expect("bank line");
        id
    }

    async fn party(db: &PgPool) -> String {
        let id = generate_id("acn");
        run(
            db,
            "insert into parties (id, kind, display_name, role) values ($1, 'company', 'Acme Trading', 'both')",
            &[&id],
        )
        .await;
        id
    }

    /// An invoice due `due_in_days` from today (negative: past).
    async fn invoice(
        db: &PgPool,
        entity: &str,
        party: &str,
        number: &str,
        kind: &str,
        status: &str,
        due_in_days: i32,
        balance: &str,
    ) -> String {
        let id = generate_id("inv");
        sqlx::query(
            "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, \
               issue_date, due_date, currency, total, amount_paid, balance_due) \
             values ($1, $2, $3, $4, $5, $6, 'Acme Trading', now() - interval '60 days', \
               current_date + $7::int, 'EUR', 121, 0, $8::numeric)",
        )
        .bind(&id)
        .bind(entity)
        .bind(number)
        .bind(kind)
        .bind(status)
        .bind(party)
        .bind(due_in_days)
        .bind(balance)
        .execute(db)
        .await
        .expect("invoice");
        id
    }

    async fn bill(
        db: &PgPool,
        entity: &str,
        party: &str,
        number: &str,
        status: &str,
        approval: Option<&str>,
        due_in_days: i32,
        balance: &str,
    ) -> String {
        let id = generate_id("bil");
        sqlx::query(
            "insert into bills (id, entity_id, bill_number, type, status, approval_status, contact_id, \
               contact_name, issue_date, due_date, currency, total, amount_paid, balance_due) \
             values ($1, $2, $3, 'standard', $4, $5, $6, 'Acme Trading', now() - interval '30 days', \
               current_date + $7::int, 'EUR', 100, 0, $8::numeric)",
        )
        .bind(&id)
        .bind(entity)
        .bind(number)
        .bind(status)
        .bind(approval)
        .bind(party)
        .bind(due_in_days)
        .bind(balance)
        .execute(db)
        .await
        .expect("bill");
        id
    }

    async fn document(db: &PgPool, entity: Option<&str>, status: &str) -> String {
        let id = generate_id("doc");
        sqlx::query(
            "insert into documents (id, entity_id, type, file_name, file_key, source, status) \
             values ($1, $2, 'purchase_invoice', 'scan.pdf', 'key', 'upload', $3)",
        )
        .bind(&id)
        .bind(entity)
        .bind(status)
        .execute(db)
        .await
        .expect("document");
        id
    }

    async fn vat_return(db: &PgPool, entity: &str, status: &str, period_end_days: i32) {
        sqlx::query(
            "insert into vat_returns (id, entity_id, period_type, period_start, period_end, period_label, status) \
             values ($1, $2, 'quarterly', current_date + $3::int - 90, current_date + $3::int, 'Q', $4)",
        )
        .bind(generate_id("vat"))
        .bind(entity)
        .bind(period_end_days)
        .bind(status)
        .execute(db)
        .await
        .expect("vat return");
    }

    /// A feed connection with consent ending in `consent_in_days` (`None`: no
    /// date) and, when `linked`, one account of the entity on it.
    async fn connection(
        db: &PgPool,
        entity: &str,
        status: &str,
        consent_in_days: Option<i32>,
        linked: bool,
    ) {
        let id = generate_id("bcn");
        sqlx::query(
            "insert into bank_connections (id, entity_id, provider, provider_connection_id, status, \
               institution_name, consent_expires_at) \
             values ($1, $2, 'ponto', $1, $3, 'Test Bank', now() + make_interval(days => $4::int))",
        )
        .bind(&id)
        .bind(entity)
        .bind(status)
        .bind(consent_in_days)
        .execute(db)
        .await
        .expect("connection");
        if linked {
            sqlx::query(
                "insert into bank_accounts (id, entity_id, name, currency, feed_connection_id) \
                 values ($1, $2, 'Feed account', 'EUR', $3)",
            )
            .bind(generate_id("bac"))
            .bind(entity)
            .bind(&id)
            .execute(db)
            .await
            .expect("feed account");
        }
    }

    async fn payment(
        db: &PgPool,
        entity: &str,
        party: &str,
        amount: &str,
        allocated: Option<&str>,
        invoice_id: Option<&str>,
        voided: bool,
    ) {
        let id = generate_id("pay");
        sqlx::query(
            "insert into payments (id, entity_id, type, amount, currency, date, contact_id, invoice_id, \
               deleted_at) \
             values ($1, $2, 'received', $3::numeric, 'EUR', now(), $4, $5, \
               case when $6 then now() end)",
        )
        .bind(&id)
        .bind(entity)
        .bind(amount)
        .bind(party)
        .bind(invoice_id)
        .bind(voided)
        .execute(db)
        .await
        .expect("payment");
        if let Some(allocated) = allocated {
            sqlx::query(
                "insert into payment_allocations (id, entity_id, payment_id, invoice_id, amount) \
                 values ($1, $2, $3, 'inv_x', $4::numeric)",
            )
            .bind(generate_id("pal"))
            .bind(entity)
            .bind(&id)
            .bind(allocated)
            .execute(db)
            .await
            .expect("allocation");
        }
    }

    fn caller(db: &PgPool, entity: &str, keys: &[&str]) -> Caller {
        let mut caller =
            Caller::in_process(db.clone(), "ws_test", "ws_test", "user_todo", entity, None);
        caller.permissions = Permissions::new(
            ResolvedPermissions {
                permissions: keys.iter().map(|k| (*k).to_owned()).collect(),
                ..ResolvedPermissions::default()
            },
            None,
            false,
            "user_todo".to_owned(),
        );
        caller
    }

    async fn body(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn summary_of(caller: &Caller) -> Value {
        let answer = build_summary(caller).await;
        if let Err(refusal) = &answer {
            eprintln!("{refusal:?}");
        }
        let (status, json) = body(reply(answer, "summary")).await;
        assert_eq!(status, 200, "{json}");
        json["data"].clone()
    }

    async fn list_of(caller: &Caller, query: &str) -> (u16, Value) {
        let q = Query::parse(Some(query));
        let answer = list_items(caller, &q).await;
        if let Err(refusal) = &answer {
            eprintln!("{refusal:?}");
        }
        body(reply(answer, "list")).await
    }

    /// Everything in entity A that counts, and look-alikes that do not; entity
    /// B gets one of each kind, to stay out of A's answers.
    async fn world(db: &PgPool) -> (String, String) {
        let (a, b) = (entity(db, "NL").await, entity(db, "NL").await);
        let party = party(db).await;

        let eur = bank_account(db, &b, "EUR").await;
        line(db, &b, &eur, "10.00", "other", "unreconciled", None).await;
        document(db, Some(&b), "pending").await;
        bill(db, &b, &party, "B-1", "draft", Some("pending"), -5, "100").await;
        bill(
            db,
            &b,
            &party,
            "B-2",
            "approved",
            Some("approved"),
            -5,
            "100",
        )
        .await;
        invoice(db, &b, &party, "B-I", "invoice", "sent", -5, "100").await;
        vat_return(db, &b, "calculated", -10).await;
        connection(db, &b, "error", None, true).await;
        payment(db, &b, &party, "100", None, None, false).await;

        // Bank lines: a good match and a plain one count; a flagged duplicate
        // counts under duplicates only;
        // booked and excluded ones do not; a USD line counts, outside the sum.
        let eur = bank_account(db, &a, "EUR").await;
        let usd = bank_account(db, &a, "USD").await;
        invoice(db, &a, &party, "INV-0001", "invoice", "sent", 10, "121.00").await;
        line(
            db,
            &a,
            &eur,
            "121.00",
            "Payment INV-0001",
            "unreconciled",
            None,
        )
        .await;
        let plain = line(db, &a, &eur, "50.00", "something", "unreconciled", None).await;
        line(
            db,
            &a,
            &eur,
            "50.00",
            "something",
            "unreconciled",
            Some(&plain),
        )
        .await;
        line(db, &a, &eur, "-9.00", "booked", "reconciled", None).await;
        line(db, &a, &eur, "-8.00", "excluded", "excluded", None).await;
        line(db, &a, &usd, "10.00", "dollars", "unreconciled", None).await;
        // Documents: four to process; linked, rejected and deleted do not count.
        for status in [
            "pending",
            "processing",
            "processed",
            "failed",
            "linked",
            "rejected",
        ] {
            document(db, Some(&a), status).await;
        }
        let gone = document(db, Some(&a), "pending").await;
        run(
            db,
            "update documents set deleted_at = now() where id = $1",
            &[&gone],
        )
        .await;
        // Bills: two to approve; two due (one overdue); the rest do not count.
        bill(db, &a, &party, "BL-1", "draft", Some("pending"), 20, "100").await;
        bill(db, &a, &party, "BL-2", "draft", None, 20, "100").await;
        bill(
            db,
            &a,
            &party,
            "BL-3",
            "cancelled",
            Some("rejected"),
            20,
            "100",
        )
        .await;
        bill(
            db,
            &a,
            &party,
            "BL-4",
            "approved",
            Some("approved"),
            3,
            "100.00",
        )
        .await;
        bill(
            db,
            &a,
            &party,
            "BL-5",
            "partial",
            Some("approved"),
            -4,
            "40.00",
        )
        .await;
        bill(
            db,
            &a,
            &party,
            "BL-6",
            "approved",
            Some("approved"),
            30,
            "100",
        )
        .await;
        bill(db, &a, &party, "BL-7", "paid", Some("approved"), -4, "0").await;
        // Invoices: an overdue one and a partial one past due; the rest do not count.
        invoice(db, &a, &party, "OV-1", "invoice", "sent", -3, "100.00").await;
        invoice(db, &a, &party, "OV-2", "invoice", "partial", -40, "30.00").await;
        invoice(db, &a, &party, "OV-3", "invoice", "sent", 5, "100").await;
        invoice(db, &a, &party, "OV-4", "invoice", "paid", -3, "0").await;
        invoice(db, &a, &party, "OV-5", "invoice", "draft", -3, "100").await;
        invoice(db, &a, &party, "OV-6", "credit_note", "sent", -3, "100").await;
        // VAT: an unfiled return of an ended period; filed and future ones do not count.
        vat_return(db, &a, "calculated", -10).await;
        vat_return(db, &a, "filed", -100).await;
        vat_return(db, &a, "calculated", 20).await;
        // Feeds: one failed, one whose consent ends in five days; the rest do not count.
        connection(db, &a, "error", None, true).await;
        connection(db, &a, "active", Some(5), true).await;
        connection(db, &a, "active", Some(60), true).await;
        connection(db, &a, "active", None, true).await;
        connection(db, &a, "revoked", Some(3), true).await;
        connection(db, &a, "error", None, false).await;
        // Payments: 100 unapplied and 40 left of 100; allocated, tied to an
        // invoice and voided ones do not count.
        payment(db, &a, &party, "100", None, None, false).await;
        payment(db, &a, &party, "100", Some("60"), None, false).await;
        payment(db, &a, &party, "100", Some("100"), None, false).await;
        payment(db, &a, &party, "100", None, Some("inv_x"), false).await;
        payment(db, &a, &party, "100", None, None, true).await;
        (a, b)
    }

    fn count(summary: &Value, kind: &str) -> i64 {
        summary["kinds"][kind]["count"].as_i64().unwrap_or(-1)
    }

    fn kind_names(summary: &Value) -> Vec<String> {
        let mut keys: Vec<String> = summary["kinds"]
            .as_object()
            .map(Map::keys)
            .map(|k| k.cloned().collect())
            .unwrap_or_default();
        keys.sort();
        keys
    }

    #[tokio::test]
    async fn every_kind_counts_its_own_entity_only() {
        let Some(db) = pool() else { return };
        let (a, b) = world(&db).await;

        let summary = summary_of(&caller(&db, &a, &ALL)).await;
        for (kind, n) in [
            ("bank_lines", 3),
            ("documents", 4),
            ("bills_to_approve", 2),
            ("bills_due", 2),
            ("invoices_overdue", 2),
            ("vat_return", 1),
            ("bank_feeds", 2),
            ("duplicates", 1),
            ("unapplied_credit", 2),
        ] {
            assert_eq!(count(&summary, kind), n, "{kind}: {summary}");
        }
        assert_eq!(summary["total"], 19);
        assert_eq!(summary["currency"], "EUR");
        let amount = |kind: &str| summary["kinds"][kind]["amount"].clone();
        // The USD line is left out of the sum and flagged.
        assert_eq!(amount("bank_lines"), "171.00");
        assert_eq!(summary["kinds"]["bank_lines"]["mixedCurrency"], true);
        assert_eq!(amount("duplicates"), "50.00");
        assert_eq!(summary["kinds"]["duplicates"]["mixedCurrency"], false);
        assert_eq!(amount("bills_to_approve"), "200.00");
        assert_eq!(amount("bills_due"), "140.00");
        assert_eq!(amount("invoices_overdue"), "130.00");
        assert_eq!(amount("unapplied_credit"), "140.00");
        assert!(amount("documents").is_null());

        // B sees its own single rows, none of A's.
        let other = summary_of(&caller(&db, &b, &ALL)).await;
        for (kind, n) in [
            ("bank_lines", 1),
            ("documents", 1),
            ("bills_to_approve", 1),
            ("bills_due", 1),
            ("invoices_overdue", 1),
            ("vat_return", 1),
            ("bank_feeds", 1),
            ("duplicates", 0),
            ("unapplied_credit", 1),
        ] {
            assert_eq!(count(&other, kind), n, "{kind}: {other}");
        }
    }

    #[tokio::test]
    async fn a_jurisdiction_without_a_vat_return_has_none_to_file() {
        let Some(db) = pool() else { return };
        let us = entity(&db, "US").await;
        vat_return(&db, &us, "calculated", -10).await;
        let caller = caller(&db, &us, &["reports:read"]);
        assert_eq!(count(&summary_of(&caller).await, "vat_return"), 0);
        let (_, list) = list_of(&caller, "kind=vat_return").await;
        assert_eq!(list["data"], json!([]));
    }

    #[tokio::test]
    async fn documents_without_an_entity_belong_to_the_default_entity() {
        let Some(db) = pool() else { return };
        let (a, b) = (entity(&db, "NL").await, entity(&db, "NL").await);
        run(
            &db,
            "update entities set is_default = false where is_default",
            &[],
        )
        .await;
        run(
            &db,
            "update entities set is_default = true where id = $1",
            &[&a],
        )
        .await;
        for id in [&a, &b] {
            run(
                &db,
                "insert into accounting_entity_settings (entity_id) values ($1)",
                &[id],
            )
            .await;
        }
        document(&db, None, "pending").await;
        document(&db, Some(&a), "pending").await;
        let of = |entity: &str| {
            let caller = caller(&db, entity, &["invoices:read"]);
            async move { count(&summary_of(&caller).await, "documents") }
        };
        let (default_count, other_count) = (of(&a).await, of(&b).await);
        // Its own and every unassigned one (other tests may have left some).
        assert!(default_count >= 2, "{default_count}");
        assert_eq!(other_count, 0);
        run(
            &db,
            "update entities set is_default = false where id = $1",
            &[&a],
        )
        .await;
        run(
            &db,
            "update entities set is_default = true where id = $1",
            &[&b],
        )
        .await;
        assert_eq!(of(&a).await, 1, "no longer the default: only its own");
        assert_eq!(of(&b).await, default_count - 1);
        run(
            &db,
            "update entities set is_default = false where id = $1",
            &[&b],
        )
        .await;
    }

    #[tokio::test]
    async fn a_kind_is_left_out_unless_the_caller_can_read_it() {
        let Some(db) = pool() else { return };
        let (a, _) = world(&db).await;
        let banking = summary_of(&caller(&db, &a, &["banking:read"])).await;
        assert_eq!(
            kind_names(&banking),
            ["bank_feeds", "bank_lines", "duplicates", "unapplied_credit"]
        );
        assert_eq!(banking["total"], 3 + 2 + 1 + 2);
        let bills = summary_of(&caller(&db, &a, &["bills:read"])).await;
        assert_eq!(kind_names(&bills), ["bills_due", "bills_to_approve"]);
        let invoices = summary_of(&caller(&db, &a, &["invoices:read"])).await;
        assert_eq!(kind_names(&invoices), ["documents", "invoices_overdue"]);
        let reports = summary_of(&caller(&db, &a, &["reports:read"])).await;
        assert_eq!(kind_names(&reports), ["missing_receipts", "vat_return"]);
        let nothing = summary_of(&caller(&db, &a, &[])).await;
        assert_eq!(nothing["total"], 0);
        assert_eq!(kind_names(&nothing), Vec::<String>::new());

        // The list leaves them out too, and refuses a kind asked for by name.
        let (status, list) = list_of(&caller(&db, &a, &["bills:read"]), "limit=100").await;
        assert_eq!(status, 200);
        let kinds: BTreeSet<&str> = list["data"]
            .as_array()
            .map(|items| items.iter().filter_map(|i| i["kind"].as_str()).collect())
            .unwrap_or_default();
        assert_eq!(kinds, BTreeSet::from(["bills_due", "bills_to_approve"]));
        let (status, _) = list_of(&caller(&db, &a, &["bills:read"]), "kind=bank_lines").await;
        assert_eq!(status, 403);
        let (status, _) = list_of(&caller(&db, &a, &ALL), "kind=nope").await;
        assert_eq!(status, 400);
    }

    #[tokio::test]
    async fn items_say_what_to_open_and_why() {
        let Some(db) = pool() else { return };
        let (a, _) = world(&db).await;
        let caller = caller(&db, &a, &ALL);
        let items = |kind: &str| {
            let query = format!("kind={kind}&limit=100");
            let caller = &caller;
            async move {
                let (status, list) = list_of(caller, &query).await;
                assert_eq!(status, 200, "{list}");
                list["data"].as_array().cloned().unwrap_or_default()
            }
        };
        let strs = |item: &Value| {
            (
                item["subtitle"].as_str().unwrap_or_default().to_owned(),
                item["hint"].as_str().unwrap_or_default().to_owned(),
                item["severity"].as_str().unwrap_or_default().to_owned(),
            )
        };
        let own = |a: &str, b: &str, c: &str| (a.to_owned(), b.to_owned(), c.to_owned());

        let lines = items("bank_lines").await;
        assert_eq!(lines.len(), 3);
        let matched: Vec<&Value> = lines
            .iter()
            .filter(|i| i["hint"] == "possible_match")
            .collect();
        assert_eq!(matched.len(), 1, "{lines:?}");
        assert_eq!(matched[0]["objectType"], "bank_transaction");
        assert_eq!(matched[0]["amount"], "121.00");
        assert_eq!(matched[0]["currency"], "EUR");
        assert_eq!(matched[0]["title"], "ACME TRADING BV");
        assert_eq!(matched[0]["subtitle"], "Payment INV-0001");
        assert_eq!(matched[0]["severity"], "info");
        assert!(lines.iter().any(|i| i["currency"] == "USD"));

        let duplicates = items("duplicates").await;
        assert_eq!(duplicates.len(), 1);
        assert_eq!(duplicates[0]["hint"], "possible_duplicate");
        assert_eq!(duplicates[0]["severity"], "warning");

        let documents = items("documents").await;
        assert_eq!(documents.len(), 4);
        let failed: Vec<&Value> = documents
            .iter()
            .filter(|i| i["hint"] == "ocr_failed")
            .collect();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0]["objectType"], "accounting_document");
        assert_eq!(failed[0]["severity"], "warning");
        assert_eq!(failed[0]["title"], "scan.pdf");

        let approve = items("bills_to_approve").await;
        assert_eq!(approve.len(), 2);
        assert!(
            approve
                .iter()
                .all(|i| i["hint"] == "awaiting_approval" && i["objectType"] == "bill")
        );

        // Most overdue first.
        let due = items("bills_due").await;
        assert_eq!(due.len(), 2);
        assert_eq!(strs(&due[0]), own("BL-5", "overdue", "danger"));
        assert_eq!(strs(&due[1]), own("BL-4", "due_soon", "warning"));
        assert_eq!(due[0]["amount"], "40.00");

        let overdue = items("invoices_overdue").await;
        assert_eq!(overdue.len(), 2);
        assert_eq!(strs(&overdue[0]), own("OV-2", "overdue_partial", "danger"));
        assert_eq!(strs(&overdue[1]), own("OV-1", "overdue", "warning"));
        assert_eq!(overdue[0]["objectType"], "invoice");

        let vat = items("vat_return").await;
        assert_eq!(vat.len(), 1);
        assert_eq!(vat[0]["objectType"], "vat_return");
        assert_eq!(vat[0]["hint"], "not_filed");
        assert_eq!(vat[0]["title"], "Q");

        let feeds = items("bank_feeds").await;
        assert_eq!(feeds.len(), 2);
        assert!(feeds.iter().all(|i| i["objectType"] == "bank_account"));
        let hints: BTreeSet<&str> = feeds.iter().filter_map(|i| i["hint"].as_str()).collect();
        assert_eq!(
            hints,
            BTreeSet::from(["connection_error", "consent_expiring"])
        );

        let credit = items("unapplied_credit").await;
        assert_eq!(credit.len(), 2);
        let amounts: BTreeSet<&str> = credit.iter().filter_map(|i| i["amount"].as_str()).collect();
        assert_eq!(amounts, BTreeSet::from(["100.00", "40.00"]));
        assert!(
            credit
                .iter()
                .all(|i| i["objectType"] == "payment" && i["title"] == "Acme Trading")
        );
    }

    #[tokio::test]
    async fn the_list_pages_through_every_kind_without_repeats() {
        let Some(db) = pool() else { return };
        let (a, _) = world(&db).await;
        let caller = caller(&db, &a, &ALL);
        let mut seen: Vec<(String, String)> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            let query = match &cursor {
                Some(c) => format!("limit=4&cursor={c}"),
                None => "limit=4".to_owned(),
            };
            let (status, list) = list_of(&caller, &query).await;
            assert_eq!(status, 200, "{list}");
            assert_eq!(list["pagination"]["totalCount"], 19);
            let page = list["data"].as_array().cloned().unwrap_or_default();
            assert!(page.len() <= 4);
            seen.extend(page.iter().map(|i| {
                (
                    i["kind"].as_str().unwrap_or_default().to_owned(),
                    i["objectId"].as_str().unwrap_or_default().to_owned(),
                )
            }));
            pages += 1;
            let has_more = list["pagination"]["hasMore"].as_bool().unwrap_or(false);
            cursor = list["pagination"]["cursor"].as_str().map(str::to_owned);
            assert_eq!(has_more, cursor.is_some());
            if !has_more {
                break;
            }
            assert!(pages < 20, "paging does not end");
        }
        assert_eq!(seen.len(), 19);
        let unique: BTreeSet<&(String, String)> = seen.iter().collect();
        assert_eq!(unique.len(), 19, "an item came twice: {seen:?}");
        // Kinds come in order of urgency.
        let order: Vec<&str> = KINDS.iter().map(|k| k.as_str()).collect();
        let positions: Vec<usize> = seen
            .iter()
            .filter_map(|(kind, _)| order.iter().position(|k| k == kind))
            .collect();
        assert!(positions.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
        // A bad cursor is refused.
        let (status, _) = list_of(&caller, "cursor=nope").await;
        assert_eq!(status, 400);
    }

    /// An entity with a bank account on a ledger account, an expense account
    /// and a 21% input VAT rate: (entity, bank account, expense, rate).
    async fn bookable(db: &PgPool) -> (String, String, String, String) {
        let entity = entity(db, "NL").await;
        let account = |code: &'static str,
                       kind: &'static str,
                       side: &'static str,
                       role: Option<&'static str>| {
            let (db, entity) = (db.clone(), entity.clone());
            async move {
                let id = generate_id("acc");
                sqlx::query(
                    "insert into accounts (id, entity_id, code, name, type, normal_side, metadata) \
                     values ($1, $2, $3, $3, $4, $5, case when $6::text is null then null else jsonb_build_object('systemRole', $6::text) end)",
                )
                .bind(&id)
                .bind(&entity)
                .bind(code)
                .bind(kind)
                .bind(side)
                .bind(role)
                .execute(&db)
                .await
                .expect("account");
                id
            }
        };
        account("1600", "liability", "credit", None).await;
        let ledger = account("1100", "asset", "debit", None).await;
        let input = account("1730", "asset", "debit", Some("tax_input")).await;
        let expense = account("4300", "expense", "debit", None).await;
        let rate = generate_id("tax");
        sqlx::query(
            "insert into tax_rates (id, entity_id, jurisdiction_code, name, rate, type, ledger_account_id) \
             values ($1, $2, 'NL', 'VAT 21%', 21, 'purchase', $3)",
        )
        .bind(&rate)
        .bind(&entity)
        .bind(&input)
        .execute(db)
        .await
        .expect("rate");
        let bank = generate_id("bac");
        sqlx::query(
            "insert into bank_accounts (id, entity_id, name, currency, ledger_account_id) \
             values ($1, $2, 'Bank', 'EUR', $3)",
        )
        .bind(&bank)
        .bind(&entity)
        .bind(&ledger)
        .execute(db)
        .await
        .expect("bank");
        (entity, bank, expense, rate)
    }

    /// Book the line to `expense`, with `rate` when there is one.
    async fn book(db: &PgPool, line: &str, expense: &str, rate: Option<&str>, amount: f64) {
        use weldsuite_books_domain::bank_split::{Split, SplitLine, book_split};
        let txn = weldsuite_books_domain::tables::BANK_TRANSACTIONS
            .find_live(db, line)
            .await
            .expect("read")
            .expect("line");
        book_split(
            db,
            &txn,
            Split {
                lines: &[SplitLine {
                    account_id: expense.to_owned(),
                    tax_rate_id: rate.map(str::to_owned),
                    contact_id: None,
                    project_id: None,
                    amount,
                    description: None,
                }],
                kind: "manual",
                user_id: Some("user_todo"),
            },
        )
        .await
        .expect("booked");
    }

    #[tokio::test]
    async fn missing_receipts_are_lines_booked_to_an_expense_with_vat_and_no_document() {
        let Some(db) = pool() else { return };
        let (a, bank, expense, rate) = bookable(&db).await;
        let (b, bank_b, expense_b, rate_b) = bookable(&db).await;
        let missing = line(
            &db,
            &a,
            &bank,
            "-121.00",
            "Hardware store",
            "unreconciled",
            None,
        )
        .await;
        book(&db, &missing, &expense, Some(&rate), 121.0).await;
        let covered = line(&db, &a, &bank, "-60.50", "Printer", "unreconciled", None).await;
        book(&db, &covered, &expense, Some(&rate), 60.5).await;
        // A receipt attached to the line (the phase 2 bridge) covers it.
        sqlx::query(
            "insert into documents (id, entity_id, type, file_name, file_key, source, status, \
               linked_entity_type, linked_entity_id) \
             values ($1, $2, 'receipt', 'bon.pdf', 'key', 'upload', 'linked', 'bank_transaction', $3)",
        )
        .bind(generate_id("doc"))
        .bind(&a)
        .bind(&covered)
        .execute(&db)
        .await
        .expect("document");
        // No VAT on it, still to book, money in: none of them is missing a receipt.
        let no_vat = line(&db, &a, &bank, "-30.00", "Stamps", "unreconciled", None).await;
        book(&db, &no_vat, &expense, None, 30.0).await;
        line(
            &db,
            &a,
            &bank,
            "-40.00",
            "Not booked yet",
            "unreconciled",
            None,
        )
        .await;
        // The other entity has one of its own.
        let theirs = line(
            &db,
            &b,
            &bank_b,
            "-12.10",
            "Their shop",
            "unreconciled",
            None,
        )
        .await;
        book(&db, &theirs, &expense_b, Some(&rate_b), 12.1).await;

        let accountant = summary_of(&caller(&db, &a, &ALL)).await;
        assert_eq!(count(&accountant, "missing_receipts"), 1);
        assert_eq!(accountant["kinds"]["missing_receipts"]["amount"], "121.00");
        assert_eq!(accountant["kinds"]["missing_receipts"]["currency"], "EUR");
        assert_eq!(
            count(
                &summary_of(&caller(&db, &b, &ALL)).await,
                "missing_receipts"
            ),
            1,
            "each entity counts its own"
        );

        // The owner's total is what it was: this is the accountant's question.
        let owner_total: i64 = [
            "bank_lines",
            "documents",
            "bills_to_approve",
            "bills_due",
            "invoices_overdue",
            "vat_return",
            "bank_feeds",
            "duplicates",
            "unapplied_credit",
        ]
        .iter()
        .map(|kind| count(&accountant, kind).max(0))
        .sum();
        assert_eq!(accountant["total"], owner_total);

        // Asked for by name: the line, with why. Not in the list with no kind.
        let (status, list) = list_of(&caller(&db, &a, &ALL), "kind=missing_receipts").await;
        assert_eq!(status, 200, "{list}");
        let items = list["data"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["objectType"], "bank_transaction");
        assert_eq!(items[0]["objectId"], json!(missing));
        assert_eq!(items[0]["hint"], "missing_receipt");
        assert_eq!(items[0]["kind"], "missing_receipts");
        let (_, everything) = list_of(&caller(&db, &a, &ALL), "limit=100").await;
        assert!(
            everything["data"]
                .as_array()
                .expect("items")
                .iter()
                .all(|item| item["kind"] != "missing_receipts")
        );
        // It takes reports:read.
        let banker = summary_of(&caller(
            &db,
            &a,
            &["banking:read", "bills:read", "invoices:read"],
        ))
        .await;
        assert!(banker["kinds"].get("missing_receipts").is_none());
        let (status, _) =
            list_of(&caller(&db, &a, &["banking:read"]), "kind=missing_receipts").await;
        assert_eq!(status, 403);

        // Once its receipt is attached, it is no longer missing.
        sqlx::query(
            "insert into documents (id, entity_id, type, file_name, file_key, source, status, \
               linked_entity_type, linked_entity_id) \
             values ($1, $2, 'receipt', 'bon2.pdf', 'key', 'upload', 'linked', 'bank_transaction', $3)",
        )
        .bind(generate_id("doc"))
        .bind(&a)
        .bind(&missing)
        .execute(&db)
        .await
        .expect("document");
        assert_eq!(
            count(
                &summary_of(&caller(&db, &a, &ALL)).await,
                "missing_receipts"
            ),
            0
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_round_trip_and_cursors_name_one() {
        for kind in KINDS {
            assert_eq!(Kind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(Kind::parse("nope"), None);
        assert_eq!(parse_cursor("bills_due:20"), Some((3, 20)));
        assert_eq!(parse_cursor("bills_due"), None);
        assert_eq!(parse_cursor("nope:1"), None);
        assert_eq!(parse_cursor("bills_due:x"), None);
    }
}
