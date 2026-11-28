//! Mollie's settlements (the payouts) booked in WeldBooks (ADR BOOKS-013).
//!
//! A customer's payment is booked on the entity's Mollie money account when
//! Mollie's webhook says it is paid (`webhook`). Mollie then pays out what it
//! holds, less its fees, to the entity's bank in one settlement. For each
//! settlement Mollie reports as paid out, these lines go on the Mollie
//! account (`bank_transactions`, one per item, each its own id):
//!
//! | line | amount | booked |
//! |---|---|---|
//! | a payment WeldBooks did not record (made outside an invoice) | in | to process |
//! | a refund, a chargeback | out | to process: the owner books the credit note |
//! | Mollie's fees | out | to bank costs |
//! | a difference, when the items do not add up to the payout | either | to process |
//! | the payout | out | a transfer, through transfers in transit |
//!
//! With these the Mollie account balances to nothing: what was paid in, less
//! refunds, fees and the payout. The payout is booked like any transfer between
//! the entity's own accounts: the incoming line on the bank, when it is there,
//! is booked against transit with it and the two pair.
//!
//! Idempotent per settlement: a line's `provider_transaction_id`
//! (`mollie:{settlement}:{kind}[:{item}]`, unique per bank account) is its
//! identity, so a settlement read twice adds nothing. Only an OAuth
//! connection can read settlements (an organisation's data, scope
//! `settlements.read`); an API key cannot.

use std::collections::HashSet;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::bank_processing::book_transfer;
use weldsuite_books_domain::bank_split::{Split, SplitLine, book_split};
use weldsuite_books_domain::differences;
use weldsuite_books_domain::document_posting::find_default_bank_account;
use weldsuite_books_domain::http::{Caller, now};
use weldsuite_books_domain::js::to_fixed;
use weldsuite_books_domain::posting::load_entity_accounts;
use weldsuite_books_domain::system_accounts::{ProviderAccount, ensure_payment_provider_account};
use weldsuite_books_domain::tables::BANK_TRANSACTIONS;
use weldsuite_catalogs::entity_events::{BANK_TRANSACTION_CREATED, BANK_TRANSACTION_PROCESSED};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_mollie::{Settlement, SettlementItem};
use weldsuite_schema::tenant::{
    accounting_payment_connections as connections, bank_accounts, bank_transactions, payments,
};

use super::connection::{self, Row};
use super::webhook::booked_payment_id;
use super::{ACCOUNT_NAME, Ctx, PROVIDER, PayError};

/// What a line on the Mollie account is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Payment,
    Refund,
    Chargeback,
    Fees,
    Difference,
    Payout,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Self::Payment => "payment",
            Self::Refund => "refund",
            Self::Chargeback => "chargeback",
            Self::Fees => "fees",
            Self::Difference => "difference",
            Self::Payout => "payout",
        }
    }
}

/// One line to put on the Mollie account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Planned {
    /// `mollie:{settlement}:{kind}[:{item}]`: the line's identity.
    pub key: String,
    pub kind: Kind,
    /// Signed: in is positive.
    pub cents: i64,
    pub at: Option<String>,
    pub description: String,
    /// The reference on the line: the item's id, or the bank statement's.
    pub reference: Option<String>,
}

/// The lines of a settlement, in the order they are booked (the payout last:
/// it marks the settlement done).
///
/// `booked` says whether a payment is already recorded in WeldBooks (on its
/// invoice, by the webhook); only the others become lines. The difference
/// line makes the lines add up to what the Mollie account holds: what was
/// paid in, less refunds, chargebacks, fees and the payout.
pub(crate) fn plan(
    settlement: &Settlement,
    payments: &[SettlementItem],
    refunds: &[SettlementItem],
    chargebacks: &[SettlementItem],
    booked: &dyn Fn(&str) -> bool,
) -> Vec<Planned> {
    let id = &settlement.id;
    let at = settlement
        .settled_at
        .clone()
        .or_else(|| settlement.created_at.clone());
    let reference = settlement.reference.clone();
    let label = reference.clone().unwrap_or_else(|| id.clone());
    let mut lines = Vec::new();
    for item in payments.iter().filter(|p| !booked(&p.id)) {
        lines.push(Planned {
            key: format!("mollie:{id}:payment:{}", item.id),
            kind: Kind::Payment,
            cents: item.cents,
            at: item.at.clone().or_else(|| at.clone()),
            description: match &item.description {
                Some(text) => format!("Mollie payment {}: {text}", item.id),
                None => format!("Mollie payment {}", item.id),
            },
            reference: Some(item.id.clone()),
        });
    }
    for (kind, items) in [(Kind::Refund, refunds), (Kind::Chargeback, chargebacks)] {
        for item in items {
            lines.push(Planned {
                key: format!("mollie:{id}:{}:{}", kind.word(), item.id),
                kind,
                cents: -item.cents.abs(),
                at: item.at.clone().or_else(|| at.clone()),
                description: format!("Mollie {} {}", kind.word(), item.id),
                reference: Some(item.id.clone()),
            });
        }
    }
    let flow: i64 = payments.iter().map(|p| p.cents).sum::<i64>()
        - refunds.iter().map(|r| r.cents.abs()).sum::<i64>()
        - chargebacks.iter().map(|c| c.cents.abs()).sum::<i64>();
    let fees = settlement.costs_cents.max(0);
    let payout = settlement.amount_cents.max(0);
    if fees > 0 {
        lines.push(Planned {
            key: format!("mollie:{id}:fees"),
            kind: Kind::Fees,
            cents: -fees,
            at: at.clone(),
            description: format!("Mollie fees {label}"),
            reference: reference.clone(),
        });
    }
    // What the account needs to come to nothing.
    let difference = fees + payout - flow;
    if difference != 0 {
        lines.push(Planned {
            key: format!("mollie:{id}:difference"),
            kind: Kind::Difference,
            cents: difference,
            at: at.clone(),
            description: format!("Mollie settlement {label}: difference"),
            reference: reference.clone(),
        });
    }
    if payout > 0 {
        lines.push(Planned {
            key: format!("mollie:{id}:payout"),
            kind: Kind::Payout,
            cents: -payout,
            at,
            description: format!("Mollie payout {label}"),
            reference,
        });
    }
    lines
}

/// What a sync did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Outcome {
    /// Settlements read for the first time.
    pub imported: usize,
    /// Settlements already read.
    pub skipped: usize,
    /// Lines put on the Mollie account.
    pub lines: usize,
    /// Lines booked by themselves (fees, payouts).
    pub booked: usize,
    /// Lines that wait in To process.
    pub to_process: usize,
    pub fees_cents: i64,
    pub payout_cents: i64,
}

impl Outcome {
    pub(crate) fn json(&self) -> Value {
        json!({
            "imported": self.imported,
            "skipped": self.skipped,
            "lines": self.lines,
            "booked": self.booked,
            "toProcess": self.to_process,
            "fees": amount_text(self.fees_cents),
            "payouts": amount_text(self.payout_cents),
        })
    }

    fn add(&mut self, other: &Self) {
        self.imported += other.imported;
        self.skipped += other.skipped;
        self.lines += other.lines;
        self.booked += other.booked;
        self.to_process += other.to_process;
        self.fees_cents += other.fees_cents;
        self.payout_cents += other.payout_cents;
    }
}

fn amount_text(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    format!("{sign}{}.{:02}", cents.abs() / 100, cents.abs() % 100)
}

#[allow(
    clippy::cast_precision_loss,
    reason = "cents of a payout fit f64 exactly"
)]
fn amount_of(cents: i64) -> f64 {
    cents as f64 / 100.0
}

/// Reads the connection's settlements and books each one not yet read.
pub(crate) async fn sync(ctx: &Ctx, caller: &Caller, conn: &Row) -> Result<Outcome, PayError> {
    if !connection::settlements_available(conn) {
        return Err(PayError::Invalid(
            "Settlements can only be read from a Mollie account connected with Mollie Connect"
                .to_owned(),
        ));
    }
    let account =
        ensure_payment_provider_account(&ctx.db, &conn.entity_id, PROVIDER, ACCOUNT_NAME).await?;
    let http = &ctx.http;
    let mut settlements =
        connection::call(
            ctx,
            conn,
            |mollie| async move { mollie.settlements(http).await },
        )
        .await?;
    settlements.retain(|s| s.status == "paidout");
    settlements.sort_by(|a, b| {
        a.settled_at
            .as_deref()
            .or(a.created_at.as_deref())
            .cmp(&b.settled_at.as_deref().or(b.created_at.as_deref()))
    });
    let mut outcome = Outcome::default();
    for settlement in &settlements {
        let one = import_one(ctx, caller, conn, &account, settlement).await?;
        outcome.add(&one);
    }
    connection::mark_synced(&orm(&ctx.db), &conn.id).await?;
    Ok(outcome)
}

/// The line `key` of the Mollie account, when it exists.
async fn find_line(
    db: &PgPool,
    account_id: &str,
    key: &str,
) -> Result<Option<Value>, sea_orm::DbErr> {
    bank_transactions::Entity::find()
        .filter(bank_transactions::Column::BankAccountId.eq(account_id))
        .filter(bank_transactions::Column::FeedProvider.eq(PROVIDER))
        .filter(bank_transactions::Column::ProviderTransactionId.eq(key))
        .one(&orm(db))
        .await?
        .map(|row| serde_json::to_value(row).map_err(|e| sea_orm::DbErr::Json(e.to_string())))
        .transpose()
}

/// Whether the settlement's payout is on the account and booked.
async fn settlement_done(
    db: &PgPool,
    account_id: &str,
    settlement: &Settlement,
) -> Result<bool, sea_orm::DbErr> {
    if settlement.amount_cents <= 0 {
        return Ok(false);
    }
    let key = format!("mollie:{}:payout", settlement.id);
    Ok(find_line(db, account_id, &key)
        .await?
        .is_some_and(|line| line["status"].as_str() != Some("unreconciled")))
}

async fn items(
    ctx: &Ctx,
    conn: &Row,
    settlement: &str,
    kind: &'static str,
) -> Result<Vec<SettlementItem>, PayError> {
    let http = &ctx.http;
    let id = settlement.to_owned();
    connection::call(ctx, conn, |mollie| {
        let id = id.clone();
        async move { mollie.settlement_items(http, &id, kind).await }
    })
    .await
}

/// Which of these Mollie payments are recorded in WeldBooks.
async fn recorded(
    db: &PgPool,
    payments: &[SettlementItem],
) -> Result<HashSet<String>, sea_orm::DbErr> {
    let ids: Vec<String> = payments.iter().map(|p| booked_payment_id(&p.id)).collect();
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let found: Vec<String> = payments::Entity::find()
        .select_only()
        .column(payments::Column::Id)
        .filter(payments::Column::Id.is_in(ids))
        .filter(payments::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(found.into_iter().collect())
}

async fn import_one(
    ctx: &Ctx,
    caller: &Caller,
    conn: &Row,
    account: &ProviderAccount,
    settlement: &Settlement,
) -> Result<Outcome, PayError> {
    let mut outcome = Outcome::default();
    if settlement_done(&ctx.db, &account.bank_account_id, settlement).await? {
        outcome.skipped = 1;
        return Ok(outcome);
    }
    // The account holds the entity's currency; another is not booked.
    let currency: Option<Option<String>> =
        bank_accounts::Entity::find_by_id(account.bank_account_id.clone())
            .select_only()
            .column(bank_accounts::Column::Currency)
            .into_tuple()
            .one(&orm(&ctx.db))
            .await?;
    if currency
        .flatten()
        .is_some_and(|c| !c.eq_ignore_ascii_case(&settlement.currency))
    {
        tracing::warn!(
            settlement = settlement.id,
            "[books/mollie] a settlement in another currency is left alone"
        );
        outcome.skipped = 1;
        return Ok(outcome);
    }
    let payments = items(ctx, conn, &settlement.id, "payments").await?;
    let refunds = items(ctx, conn, &settlement.id, "refunds").await?;
    let chargebacks = items(ctx, conn, &settlement.id, "chargebacks").await?;
    let known = recorded(&ctx.db, &payments).await?;
    let lines = plan(settlement, &payments, &refunds, &chargebacks, &|id| {
        known.contains(&booked_payment_id(id))
    });
    let mut fresh_any = false;
    for planned in &lines {
        let (line, fresh) = insert_line(ctx, caller, conn, account, settlement, planned).await?;
        if fresh {
            fresh_any = true;
            outcome.lines += 1;
            match planned.kind {
                Kind::Fees => outcome.fees_cents += planned.cents.abs(),
                Kind::Payout => outcome.payout_cents += planned.cents.abs(),
                _ => {}
            }
        }
        let mut waiting = line["status"].as_str() == Some("unreconciled");
        if waiting {
            let booked = match planned.kind {
                Kind::Fees => book_fees(ctx, &conn.entity_id, &line).await,
                Kind::Payout => book_payout(ctx, &conn.entity_id, &line).await,
                _ => None,
            };
            if let Some(how) = booked {
                waiting = false;
                outcome.booked += 1;
                caller.publish_system(
                    &ctx.books,
                    BANK_TRANSACTION_PROCESSED,
                    line["id"].as_str().unwrap_or_default(),
                    json!({
                        "id": line["id"],
                        "bankAccountId": account.bank_account_id,
                        "amount": line["amount"],
                        "description": line["description"],
                        "status": "reconciled",
                        "how": how,
                    }),
                );
            }
        }
        if waiting && fresh {
            outcome.to_process += 1;
        }
    }
    if fresh_any {
        outcome.imported = 1;
    } else {
        outcome.skipped = 1;
    }
    Ok(outcome)
}

/// Puts a line on the Mollie account, once; the row and whether it is new.
async fn insert_line(
    ctx: &Ctx,
    caller: &Caller,
    conn: &Row,
    account: &ProviderAccount,
    settlement: &Settlement,
    planned: &Planned,
) -> Result<(Value, bool), PayError> {
    if let Some(existing) = find_line(&ctx.db, &account.bank_account_id, &planned.key).await? {
        return Ok((existing, false));
    }
    let stamp = now();
    let mut row = Map::new();
    let mut put = |prop: &str, value: Value| BANK_TRANSACTIONS.set(&mut row, prop, value);
    put("id", json!(generate_id("bt")));
    put("entityId", json!(conn.entity_id));
    put("bankAccountId", json!(account.bank_account_id));
    put(
        "date",
        json!(planned.at.clone().unwrap_or_else(|| stamp.clone())),
    );
    put("description", json!(planned.description));
    put("amount", json!(to_fixed(amount_of(planned.cents), 2)));
    put("counterpartyName", json!(ACCOUNT_NAME));
    put("reference", json!(planned.reference));
    put("externalId", json!(settlement.id));
    put("status", json!("unreconciled"));
    put("source", json!(PROVIDER));
    put("feedProvider", json!(PROVIDER));
    put("providerTransactionId", json!(planned.key));
    put(
        "rawData",
        json!({
            "provider": PROVIDER,
            "settlementId": settlement.id,
            "settlementReference": settlement.reference,
            "kind": planned.kind.word(),
        }),
    );
    put("createdAt", json!(stamp));
    put("updatedAt", json!(stamp));
    let inserted = match BANK_TRANSACTIONS.insert_raw(&ctx.db, row).await {
        Ok(line) => line,
        Err(error) => {
            // Another run put it there in the meantime: that one is the line.
            if let Some(existing) =
                find_line(&ctx.db, &account.bank_account_id, &planned.key).await?
            {
                return Ok((existing, false));
            }
            return Err(error.into());
        }
    };
    bank_accounts::Entity::update_many()
        .col_expr(
            bank_accounts::Column::CurrentBalance,
            Expr::cust_with_values(
                "coalesce(\"current_balance\", 0)::numeric + $1::numeric",
                [to_fixed(amount_of(planned.cents), 2)],
            ),
        )
        .col_expr(bank_accounts::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(bank_accounts::Column::Id.eq(account.bank_account_id.as_str()))
        .exec(&orm(&ctx.db))
        .await?;
    caller.publish_system(
        &ctx.books,
        BANK_TRANSACTION_CREATED,
        inserted["id"].as_str().unwrap_or_default(),
        json!({
            "id": inserted["id"],
            "bankAccountId": account.bank_account_id,
            "amount": inserted["amount"],
            "description": inserted["description"],
            "status": "unreconciled",
        }),
    );
    Ok((inserted, true))
}

/// The account Mollie's fees are booked to: the entity's bank costs account
/// (phase 2, the differences settings), else the chart's own (`Bankkosten`,
/// `Bank charges`, `Bank service charges`).
async fn bank_costs_account(
    db: &PgPool,
    entity_id: &str,
) -> Result<Option<String>, sea_orm::DbErr> {
    let accounts = load_entity_accounts(db, entity_id).await?;
    let live = |a: &&Value| a.get("isActive") != Some(&Value::Bool(false));
    let settings = differences::load(db, entity_id).await?;
    if let Some(id) = settings.bank_costs_account_id.as_deref()
        && let Some(account) = accounts.by_id(Some(id)).filter(live)
    {
        return Ok(account["id"].as_str().map(str::to_owned));
    }
    Ok(accounts
        .rows()
        .iter()
        .filter(live)
        .find(|a| {
            a["type"].as_str() == Some("expense")
                && a["name"].as_str().is_some_and(|name| {
                    matches!(
                        name.to_lowercase().as_str(),
                        "bankkosten" | "bank charges" | "bank service charges" | "bank fees"
                    )
                })
        })
        .and_then(|a| a["id"].as_str().map(str::to_owned)))
}

/// Mollie's fees to bank costs. `None` when there is no such account or the
/// booking was refused (a closed period): the line waits in To process.
async fn book_fees(ctx: &Ctx, entity_id: &str, line: &Value) -> Option<&'static str> {
    let account = match bank_costs_account(&ctx.db, entity_id).await {
        Ok(Some(account)) => account,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(%error, "[books/mollie] the bank costs account was not read");
            return None;
        }
    };
    let amount = line["amount"]
        .as_str()
        .map(|a| weldsuite_books_domain::js::parse_float(a).abs())?;
    match book_split(
        &ctx.db,
        line,
        Split {
            lines: &[SplitLine {
                account_id: account,
                amount,
                description: Some("Mollie fees".to_owned()),
                ..SplitLine::default()
            }],
            kind: "auto",
            user_id: None,
        },
    )
    .await
    {
        Ok(_) => Some("auto"),
        Err(error) => {
            tracing::warn!(%error, "[books/mollie] the fees were left to process");
            None
        }
    }
}

/// The payout as a transfer through transfers in transit. The entity's bank
/// account is named when it has one, so that the incoming line, if it is
/// already there, is booked with it.
async fn book_payout(ctx: &Ctx, entity_id: &str, line: &Value) -> Option<&'static str> {
    let bank = match find_default_bank_account(&ctx.db, entity_id).await {
        Ok(bank) => bank.map(|(id, _)| id),
        Err(error) => {
            tracing::warn!(%error, "[books/mollie] the bank account was not read");
            None
        }
    };
    match book_transfer(&ctx.db, line, bank.as_deref(), "auto", None).await {
        Ok(_) => Some("transfer"),
        Err(error) => {
            tracing::warn!(%error, "[books/mollie] the payout was left to process");
            None
        }
    }
}

/// What the daily sweep did for one workspace.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SweepSettlements {
    pub connections: usize,
    pub settlements: usize,
    pub failed: usize,
}

/// The daily run: reads the settlements of every entity of this workspace
/// that connected Mollie with Mollie Connect. It runs in a workspace the
/// books sweep already opened, so it wakes nothing. A failing connection is
/// logged and never fails the others.
pub async fn sync_workspace(
    books: &weldsuite_books_domain::http::BooksState,
    db: &PgPool,
    workspace_id: &str,
    event_workspace_id: &str,
) -> Result<SweepSettlements, sea_orm::DbErr> {
    let rows = connections::Entity::find()
        .filter(connections::Column::Status.eq("connected"))
        .filter(connections::Column::AuthMethod.eq("oauth"))
        .filter(connections::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    let mut result = SweepSettlements::default();
    let Some(ctx) = Ctx::new(books, db, None) else {
        return Ok(result);
    };
    for conn in rows.iter().filter(|c| connection::settlements_available(c)) {
        result.connections += 1;
        let caller = Caller::in_process(
            db.clone(),
            workspace_id,
            event_workspace_id,
            "system",
            &conn.entity_id,
            Some(ctx.http.clone()),
        );
        match sync(&ctx, &caller, conn).await {
            Ok(done) => result.settlements += done.imported,
            Err(error) => {
                result.failed += 1;
                tracing::warn!(entity = conn.entity_id, %error, "[books/mollie] settlements were not read");
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settlement(amount: i64, costs: i64) -> Settlement {
        Settlement {
            id: "stl_1".into(),
            reference: Some("1234567.2601.03".into()),
            status: "paidout".into(),
            currency: "EUR".into(),
            amount_cents: amount,
            settled_at: Some("2026-01-05T08:00:00.000Z".into()),
            created_at: None,
            costs_cents: costs,
        }
    }

    fn item(id: &str, cents: i64) -> SettlementItem {
        SettlementItem {
            id: id.into(),
            currency: "EUR".into(),
            cents,
            description: None,
            at: None,
            payment_id: None,
        }
    }

    fn sum(lines: &[Planned]) -> i64 {
        lines.iter().map(|l| l.cents).sum()
    }

    #[test]
    fn a_settlement_of_recorded_payments_is_fees_and_a_payout() {
        // Two payments of 121.00 and 60.50, both recorded; fees 2.51 gross.
        let payments = [item("tr_a", 12100), item("tr_b", 6050)];
        let lines = plan(&settlement(17899, 251), &payments, &[], &[], &|_| true);
        assert_eq!(
            lines.iter().map(|l| (l.kind, l.cents)).collect::<Vec<_>>(),
            vec![(Kind::Fees, -251), (Kind::Payout, -17899)]
        );
        // Together with the payments the webhook recorded (+18150) the
        // Mollie account comes to nothing.
        assert_eq!(18150 + sum(&lines), 0);
        assert_eq!(lines[1].key, "mollie:stl_1:payout");
    }

    #[test]
    fn payments_not_recorded_refunds_and_differences_wait_for_the_owner() {
        // A recorded payment of 100.00, an outside payment of 50.00, a refund
        // of 20.00; fees 1.50; but Mollie pays out 128.00, 0.50 less.
        let payments = [item("tr_a", 10000), item("tr_b", 5000)];
        let refunds = [item("re_1", 2000)];
        let lines = plan(&settlement(12800, 150), &payments, &refunds, &[], &|id| {
            id == "tr_a"
        });
        let kinds: Vec<_> = lines.iter().map(|l| (l.kind, l.cents)).collect();
        assert_eq!(
            kinds,
            vec![
                (Kind::Payment, 5000),
                (Kind::Refund, -2000),
                (Kind::Fees, -150),
                (Kind::Difference, 150 + 12800 - 13000),
                (Kind::Payout, -12800),
            ]
        );
        assert_eq!(10000 + sum(&lines), 0);
    }

    #[test]
    fn a_settlement_without_items_still_balances() {
        // Mollie's items could not be read: everything is one difference.
        let lines = plan(&settlement(9000, 100), &[], &[], &[], &|_| false);
        assert_eq!(sum(&lines), 0);
        assert!(
            lines
                .iter()
                .any(|l| l.kind == Kind::Difference && l.cents == 9100)
        );
    }

    #[test]
    fn a_negative_settlement_has_no_payout() {
        // Refunds exceed payments: Mollie pays out nothing, and holds the debt.
        let lines = plan(
            &settlement(-500, 0),
            &[],
            &[item("re_1", 500)],
            &[],
            &|_| false,
        );
        assert!(lines.iter().all(|l| l.kind != Kind::Payout));
        assert_eq!(sum(&lines), 0);
    }

    #[test]
    fn every_line_has_its_own_identity() {
        let payments = [item("tr_a", 100), item("tr_b", 100)];
        let lines = plan(
            &settlement(200, 0),
            &payments,
            &[],
            &[item("chb_1", 0)],
            &|_| false,
        );
        let keys: HashSet<_> = lines.iter().map(|l| l.key.clone()).collect();
        assert_eq!(keys.len(), lines.len());
        assert!(keys.contains("mollie:stl_1:payment:tr_a"));
        assert!(keys.contains("mollie:stl_1:chargeback:chb_1"));
    }

    #[test]
    fn amounts_are_written_with_two_decimals() {
        assert_eq!(amount_text(17899), "178.99");
        assert_eq!(amount_text(-5), "-0.05");
        assert_eq!(amount_text(0), "0.00");
    }
}
