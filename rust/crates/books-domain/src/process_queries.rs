//! What "to process" counts, as conditions on the books' tables: one place
//! for the rule, used by the To process list (`books-reports`), the VAT
//! return's Check step (`books-tax`) and the lock-date suggestion
//! (`accounting-entities`), so the three never disagree about what is open.
//!
//! Every condition is for one legal entity ([`Scope`]); nothing is stored as a
//! task (ADR BOOKS-010).

use sea_orm::sea_query::{Condition, Expr, Func};
use sea_orm::{
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QuerySelect, Select, prelude::BigDecimal,
};
use weldsuite_db::PgPool;
use weldsuite_legal_entities::{LegalEntityApp, default_entity_id_for};
use weldsuite_schema::tenant::{bank_transactions, documents};

/// The entity a query is about.
#[derive(Debug, Clone, Copy)]
pub struct Scope<'a> {
    pub entity_id: &'a str,
    /// Documents with no entity belong to the default one.
    pub is_default_entity: bool,
}

impl<'a> Scope<'a> {
    /// The scope of `entity_id`, asking the workspace whether it is the default.
    ///
    /// # Errors
    ///
    /// The database's.
    pub async fn load(db: &PgPool, entity_id: &'a str) -> Result<Self, DbErr> {
        let default = default_entity_id_for(db, Some(LegalEntityApp::Weldbooks)).await?;
        Ok(Self {
            entity_id,
            is_default_entity: default.as_deref() == Some(entity_id),
        })
    }
}

/// The entity's bank lines to book: unreconciled (so not excluded), on a live
/// account of the entity.
pub fn bank_lines(scope: &Scope) -> Condition {
    use bank_transactions::Column as C;
    Condition::all()
        .add(C::EntityId.eq(scope.entity_id))
        .add(C::DeletedAt.is_null())
        .add(C::Status.eq("unreconciled"))
        .add(Expr::cust(
            "EXISTS (SELECT 1 FROM bank_accounts b WHERE b.id = bank_transactions.bank_account_id \
             AND b.entity_id = bank_transactions.entity_id AND b.deleted_at IS NULL)",
        ))
}

/// Bank lines flagged as a possible duplicate of another.
pub fn duplicates(scope: &Scope) -> Condition {
    bank_lines(scope).add(bank_transactions::Column::PossibleDuplicateOfId.is_not_null())
}

/// The `bank_lines` kind: lines to book that aren't flagged as a possible
/// duplicate. A flagged line is under `duplicates` only, so the total counts
/// every line once.
pub fn to_book(scope: &Scope) -> Condition {
    bank_lines(scope).add(bank_transactions::Column::PossibleDuplicateOfId.is_null())
}

/// Inbox documents still to process; those with no entity count for the
/// default entity only.
pub fn unbooked_documents(scope: &Scope) -> Condition {
    use documents::Column as C;
    let mut entity = Condition::any().add(C::EntityId.eq(scope.entity_id));
    if scope.is_default_entity {
        entity = entity.add(C::EntityId.is_null());
    }
    Condition::all()
        .add(C::DeletedAt.is_null())
        .add(C::Status.is_in(["pending", "processing", "processed", "failed"]))
        .add(entity)
}

/// Bank lines booked to an expense with VAT claimed, by hand or by a rule,
/// money out, with no document attached to the line and no bill behind the
/// payment (a line settled through a bill's payment has its receipt there).
/// Three `EXISTS` on indexed ids keep the count cheap; nothing is scored.
pub fn missing_receipts(scope: &Scope) -> Condition {
    use bank_transactions::Column as C;
    Condition::all()
        .add(C::EntityId.eq(scope.entity_id))
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

/// A kind's count and sum.
pub struct Tally {
    pub count: i64,
    pub amount: Option<BigDecimal>,
    /// Some rows are in another currency and are not in `amount`.
    pub mixed: bool,
}

/// `count(*)`, `sum(amount)` and `count(foreign)` of the rows.
///
/// # Errors
///
/// The database's.
pub async fn aggregate<E: EntityTrait>(
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
pub fn in_base(table: &str, inner: &str, base: &str) -> Expr {
    Expr::cust_with_values(
        format!(
            "CASE WHEN COALESCE({table}.currency, $1) IN ($1, $2) OR COALESCE({table}.exchange_rate, 0) <= 0 \
             THEN ({inner}) ELSE ({inner}) / {table}.exchange_rate END"
        ),
        // $1 is the empty text and $2 the base currency (no quoted literals in the text).
        ["", base],
    )
}

/// A bank line's amount (absolute) when its account is in the base currency,
/// and a marker for the lines that are not: a line has no rate, so only the
/// base currency's lines are summed.
pub fn bank_line_amounts(base: &str) -> (Expr, Expr) {
    let account_currency = "COALESCE((SELECT b.currency FROM bank_accounts b \
         WHERE b.id = bank_transactions.bank_account_id), $1)";
    let amount = Expr::cust_with_values(
        format!("CASE WHEN {account_currency} IN ($1, $2) THEN ABS(bank_transactions.amount) END"),
        ["", base],
    );
    let foreign = Expr::cust_with_values(
        format!("CASE WHEN {account_currency} NOT IN ($1, $2) THEN 1 END"),
        ["", base],
    );
    (amount, foreign)
}
