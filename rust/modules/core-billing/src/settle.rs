//! Applying what Mollie says about a billing payment, once (ADR BILL-014,
//! "The webhook"). Called by `POST /api/webhooks/mollie` (shared with the
//! credit top-up, which grants a `kind: credit_topup` payment's credits
//! before its charge row is settled here), by the return pages
//! (`GET /api/billing/checkout/:id`, `GET /api/credits/checkout/:id`) and by
//! the renewal job, always with a payment the server read back from Mollie.
//!
//! The payment's metadata names its charge row (`paymentRowId`; a top-up's
//! `billingChargeId`, [`crate::top_up`]). Nothing is
//! applied unless the row is a Mollie charge of the same workspace, sent as
//! this payment, for the same amount. Every effect is keyed on the row's
//! state under a row lock, so a second delivery, or the return page settling
//! first, changes nothing.

use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_mollie::{Payment, PaymentStatus};

use crate::account::{self, Account};
use crate::engine::{self, BRAND};
use crate::notify::{self, BillingMail, BillingMailKind};
use crate::period::{Cycle, anchor_day, first_period, parse_iso};
use crate::plans::Plan;
use crate::store::{ChargeMeta, ChargeRow, InvoiceMirror, Purpose, mirror_invoice, status_of};
use crate::workspace::{self, Workspace};
use crate::{BillingError, BillingResult, BillingState, IssueRequest, Language, credits, seats};

/// What settling did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settled {
    /// A first payment started the subscription.
    Activated,
    /// A plan or seat change was applied.
    Changed,
    /// A renewal was paid.
    Renewed,
    /// A past-due charge was paid.
    PastDuePaid,
    /// A new payment method was saved.
    MandateSaved,
    /// A credit top-up was paid (its credits are the top-up's to grant).
    CreditsBought,
    /// An add-on added between anchors (a WeldReach inbox) was paid.
    AddonPaid,
    /// A second checkout was paid while a subscription already ran (two
    /// tabs, a double submit): not applied, refunded in full.
    DuplicateCheckout,
    /// The charge failed; the account is past due on it.
    PastDue,
    /// Recorded; nothing else follows from it.
    Recorded(&'static str),
    /// Not a billing payment of ours, or it doesn't match its row.
    Ignored(&'static str),
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|v| !v.is_empty())
}

/// Applies `payment` to its charge. `Err` only when something should be
/// retried (the database unreachable); the webhook then answers 5xx.
#[allow(clippy::too_many_lines)] // one state machine, one place
pub async fn settle_payment(
    state: &BillingState,
    payment: &Payment,
    now: OffsetDateTime,
) -> BillingResult<Settled> {
    // A plan charge names its row as `paymentRowId`; a credit top-up priced
    // by plan billing ([`crate::top_up`]) as `billingChargeId`.
    let top_up = match text(payment.metadata.get("kind")) {
        Some("billing") => false,
        Some("credit_topup") => true,
        _ => return Ok(Settled::Ignored("not a billing payment")),
    };
    let row_field = if top_up {
        "billingChargeId"
    } else {
        "paymentRowId"
    };
    let Some(row_id) = text(payment.metadata.get(row_field)) else {
        return Ok(Settled::Ignored("no charge row in the metadata"));
    };
    let master = &state.master;
    let mut tx = master.begin().await?;
    let Some(row) = ChargeRow::lock(&mut tx, row_id).await? else {
        return Ok(Settled::Ignored("unknown charge row"));
    };
    if text(payment.metadata.get("workspaceId")) != Some(row.workspace_id.as_str()) {
        tracing::warn!(payment = %payment.id, row = %row.id, "billing: payment and row name different workspaces");
        return Ok(Settled::Ignored("workspace mismatch"));
    }
    if row
        .provider_payment_id
        .as_deref()
        .is_some_and(|id| id != payment.id)
    {
        tracing::warn!(payment = %payment.id, row = %row.id, "billing: the row was sent as another payment");
        return Ok(Settled::Ignored("payment mismatch"));
    }
    let amount = payment.amount.as_ref().map_or(-1, |money| money.cents);
    if amount != i64::from(row.amount) {
        tracing::warn!(payment = %payment.id, row = %row.id, amount, expected = row.amount, "billing: amount mismatch");
        return Ok(Settled::Ignored("amount mismatch"));
    }
    let Some(meta) = row.meta() else {
        return Ok(Settled::Ignored("the row has no metadata"));
    };
    if top_up != (meta.purpose == Purpose::Credits) {
        tracing::warn!(payment = %payment.id, row = %row.id, "billing: a top-up and a plan charge crossed");
        return Ok(Settled::Ignored("purpose mismatch"));
    }
    // A duplicate checkout is settled for good: refunded, never applied.
    // Mollie calls again (when the refund goes through, say); that changes
    // nothing, and asks for no second refund.
    if row.status == "duplicate" {
        return Ok(Settled::Recorded("duplicate"));
    }
    if row.provider_payment_id.is_none() {
        sqlx::query("update billing_payments set provider_payment_id = $2 where id = $1")
            .bind(&row.id)
            .bind(&payment.id)
            .execute(&mut *tx)
            .await?;
    }
    let paid_at = payment
        .paid_at
        .as_deref()
        .and_then(parse_iso)
        .unwrap_or(now);
    let reversed = payment.reversed_cents();

    let settled = if payment.status == PaymentStatus::Paid && !row.is_paid() {
        ChargeRow::record(
            &mut tx,
            &row.id,
            "succeeded",
            &payment.details,
            None,
            Some(paid_at),
            reversed,
        )
        .await?;
        paid(state, &mut tx, &row, &meta, payment, paid_at, now).await?
    } else if payment.status == PaymentStatus::Paid {
        ChargeRow::record(
            &mut tx,
            &row.id,
            "succeeded",
            &payment.details,
            None,
            None,
            reversed,
        )
        .await?;
        if payment.charged_back() && meta.charged_back != Some(true) && reopens(meta.purpose) {
            sqlx::query(
                "update billing_payments set metadata = jsonb_set(metadata, '{chargedBack}', 'true') where id = $1",
            )
            .bind(&row.id)
            .execute(&mut *tx)
            .await?;
            go_past_due(&mut tx, &row.workspace_id, &row.id, now).await?;
            Settled::PastDue
        } else {
            Settled::Recorded("already paid")
        }
    } else if payment.status.is_final_failure() && !row.is_paid() {
        ChargeRow::record(
            &mut tx,
            &row.id,
            status_of(&payment.status),
            &payment.details,
            payment.failure_reason.as_deref(),
            None,
            0,
        )
        .await?;
        let applied_on_acceptance = meta.applied == Some(true);
        match meta.purpose {
            Purpose::Renewal => {
                go_past_due(&mut tx, &row.workspace_id, &row.id, now).await?;
                Settled::PastDue
            }
            // Granted at acceptance (the plan change, the inbox): the charge
            // that fails afterwards is owed.
            Purpose::Change | Purpose::Addon if applied_on_acceptance => {
                go_past_due(&mut tx, &row.workspace_id, &row.id, now).await?;
                Settled::PastDue
            }
            _ => Settled::Recorded("not paid"),
        }
    } else {
        if !row.is_paid() {
            ChargeRow::record(
                &mut tx,
                &row.id,
                status_of(&payment.status),
                &payment.details,
                None,
                None,
                0,
            )
            .await?;
        }
        Settled::Recorded("in progress")
    };
    tx.commit().await?;

    match &settled {
        Settled::PastDue => notify_failed(state, &row.workspace_id, &row.id, now).await,
        Settled::Activated
        | Settled::Changed
        | Settled::Renewed
        | Settled::PastDuePaid
        | Settled::CreditsBought
        | Settled::AddonPaid
            if meta.charge.gross > 0 =>
        {
            if let Some(row) = ChargeRow::load(master, &row.id).await? {
                issue_invoice(state, &row).await;
            }
        }
        Settled::MandateSaved => after_mandate(state, &row.workspace_id, payment, now).await,
        Settled::DuplicateCheckout => refund_duplicate(state, &row.id, payment).await,
        _ => {}
    }
    Ok(settled)
}

/// Refunds a duplicate checkout in full. A refusal is logged loudly: staff
/// refund it with `weldsuite admin billing refund`.
async fn refund_duplicate(state: &BillingState, row_id: &str, payment: &Payment) {
    let (Some(http), Some(amount)) = (state.http.clone(), payment.amount.clone()) else {
        tracing::error!(row = row_id, payment = %payment.id, "billing: duplicate checkout not refunded (no client or amount)");
        return;
    };
    match state
        .mollie
        .refund(
            &http,
            &payment.id,
            &amount,
            "WeldSuite: duplicate checkout",
            &format!("refund:duplicate:{row_id}"),
        )
        .await
    {
        Ok(refund) => {
            if let Err(error) = sqlx::query(
                "update billing_payments set refunded_amount = amount, updated_at = now() where id = $1",
            )
            .bind(row_id)
            .execute(&state.master)
            .await
            {
                tracing::error!(%error, row = row_id, "billing: duplicate refund not recorded");
            }
            tracing::warn!(row = row_id, payment = %payment.id, refund = %refund.id, "billing: duplicate checkout refunded");
        }
        Err(error) => tracing::error!(
            %error,
            row = row_id,
            payment = %payment.id,
            "billing: duplicate checkout NOT refunded; refund it with weldsuite admin billing refund"
        ),
    }
}

/// Charges whose failure (or chargeback) after the fact reopens them.
fn reopens(purpose: Purpose) -> bool {
    matches!(
        purpose,
        Purpose::Renewal | Purpose::Change | Purpose::PayLink | Purpose::Checkout | Purpose::Addon
    )
}

/// The effects of a paid charge, inside the row's transaction.
#[allow(clippy::too_many_lines)] // one arm per purpose
async fn paid(
    state: &BillingState,
    tx: &mut sqlx::PgConnection,
    row: &ChargeRow,
    meta: &ChargeMeta,
    payment: &Payment,
    paid_at: OffsetDateTime,
    now: OffsetDateTime,
) -> BillingResult<Settled> {
    let workspace_id = &row.workspace_id;
    match meta.purpose {
        Purpose::Checkout => {
            let Some(workspace) = Workspace::lock(tx, workspace_id).await? else {
                return Ok(Settled::Ignored("workspace gone"));
            };
            // Another checkout already started the subscription: this one
            // pays for an overlapping period. It isn't applied, and isn't
            // invoiced; the payment is refunded once this commits.
            let charging: bool = sqlx::query_scalar(
                "select exists (select 1 from billing_accounts
                                where workspace_id = $1 and next_charge_at is not null)",
            )
            .bind(workspace_id)
            .fetch_one(&mut *tx)
            .await?;
            if charging && workspace.has_running_subscription(now) {
                sqlx::query(
                    "update billing_payments set status = 'duplicate',
                         failure_message = 'A subscription was already running: refunded',
                         updated_at = now()
                     where id = $1",
                )
                .bind(&row.id)
                .execute(&mut *tx)
                .await?;
                return Ok(Settled::DuplicateCheckout);
            }
            let (Some(plan_id), Some(seats), Some(cycle), Some(unit)) = (
                meta.plan_id.clone(),
                meta.seats,
                meta.cycle.as_deref().and_then(Cycle::parse),
                meta.unit_amount,
            ) else {
                return Ok(Settled::Ignored("checkout without a plan"));
            };
            let period = first_period(paid_at, cycle);
            let anchor = anchor_day(paid_at);
            workspace::set_subscription(
                tx,
                workspace_id,
                &plan_id,
                seats,
                "active",
                cycle,
                period,
                now,
            )
            .await?;
            account::start(
                tx,
                workspace_id,
                unit,
                anchor,
                crate::period::add_months_on_anchor(paid_at, 1, anchor),
            )
            .await?;
            save_mandate(tx, workspace_id, payment).await?;
            // Inboxes paused when an earlier plan ended send again.
            crate::addons::resume_inboxes(tx, workspace_id).await?;
            let plan = Plan::load(&state.master, &plan_id).await?;
            let plan_credits = plan
                .as_ref()
                .and_then(|p| p.monthly_credits)
                .map_or(0, i64::from);
            credits::grant_monthly(
                tx,
                workspace_id,
                plan_credits,
                paid_at,
                crate::period::add_months_on_anchor(paid_at, 1, anchor),
            )
            .await?;
            if let Some(plan) = &plan {
                let organization = workspace.organization().to_owned();
                let identity = state.identity.clone();
                let cap = seats::seat_cap(plan, seats);
                // After the commit would be cleaner; a cap is advisory here.
                tokio_spawn_cap(identity, organization, cap);
            }
            tracing::info!(workspace = %workspace_id, plan = %plan_id, seats, "billing: subscription started");
            Ok(Settled::Activated)
        }
        Purpose::Change => {
            if meta.applied != Some(true) {
                let (Some(plan_id), Some(seats), Some(unit)) =
                    (meta.plan_id.clone(), meta.seats, meta.unit_amount)
                else {
                    return Ok(Settled::Ignored("change without a plan"));
                };
                engine::apply_change(tx, workspace_id, &plan_id, seats, unit).await?;
                engine::mark_applied(tx, &row.id).await?;
                if let (Some(plan), Some(workspace)) = (
                    Plan::load(&state.master, &plan_id).await?,
                    Workspace::lock(tx, workspace_id).await?,
                ) {
                    tokio_spawn_cap(
                        state.identity.clone(),
                        workspace.organization().to_owned(),
                        seats::seat_cap(&plan, seats),
                    );
                }
            }
            if payment.sequence_type.as_deref() == Some("first") {
                save_mandate(tx, workspace_id, payment).await?;
            }
            clear_past_due_on(tx, workspace_id, &row.id).await?;
            Ok(Settled::Changed)
        }
        Purpose::Renewal => {
            clear_past_due_on(tx, workspace_id, &row.id).await?;
            Ok(Settled::Renewed)
        }
        Purpose::PayLink => {
            save_mandate(tx, workspace_id, payment).await?;
            if let Some(settles) = &meta.settles {
                clear_past_due_on(tx, workspace_id, settles).await?;
                sqlx::query(
                    "update billing_payments set failure_message = coalesce(failure_message, '') || ' (paid by ' || $2 || ')',
                         updated_at = now()
                     where id = $1",
                )
                .bind(settles)
                .bind(&row.id)
                .execute(&mut *tx)
                .await?;
            }
            Ok(Settled::PastDuePaid)
        }
        Purpose::Mandate => {
            save_mandate(tx, workspace_id, payment).await?;
            Ok(Settled::MandateSaved)
        }
        // A one-off payment: no mandate, no plan, no past due to clear.
        Purpose::Credits => Ok(Settled::CreditsBought),
        // The inbox was granted when the charge was accepted.
        Purpose::Addon => {
            clear_past_due_on(tx, workspace_id, &row.id).await?;
            Ok(Settled::AddonPaid)
        }
    }
}

/// Stores the mandate a paid first payment left as the default.
async fn save_mandate(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    payment: &Payment,
) -> Result<(), sqlx::Error> {
    let Some(mandate) = &payment.mandate_id else {
        return Ok(());
    };
    // iDEAL, Bancontact and the like leave a SEPA Direct Debit mandate.
    let method = match payment.details.method.as_deref() {
        Some("ideal" | "bancontact" | "sofort" | "eps" | "belfius" | "kbc") => Some("directdebit"),
        other => other,
    };
    account::set_mandate(
        tx,
        workspace_id,
        mandate,
        method,
        payment.details.label.as_deref(),
    )
    .await
}

fn tokio_spawn_cap(
    identity: Option<std::sync::Arc<dyn weldsuite_ports::Identity>>,
    organization: String,
    cap: i64,
) {
    if identity.is_none() {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    handle.spawn(async move {
        seats::write_cap(identity.as_ref(), &organization, cap).await;
    });
}

/// Paying the open charge ends past due (and `past_due` on the workspace).
async fn clear_past_due_on(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    row_id: &str,
) -> Result<(), sqlx::Error> {
    let open: Option<Option<String>> = sqlx::query_scalar(
        "select past_due_payment_id from billing_accounts where workspace_id = $1 for update",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await?;
    if open.flatten().as_deref() != Some(row_id) {
        return Ok(());
    }
    account::clear_past_due(tx, workspace_id).await?;
    sqlx::query(
        "update workspaces set subscription_status = 'active', updated_at = now()
         where id = $1 and subscription_status = 'past_due'",
    )
    .bind(workspace_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// The charge `row_id` is open: past due, the plan keeps working.
pub(crate) async fn go_past_due(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    row_id: &str,
    now: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    account::set_past_due(tx, workspace_id, row_id, now).await?;
    sqlx::query(
        "update workspaces set subscription_status = 'past_due', updated_at = now()
         where id = $1 and subscription_status in ('active', 'trialing', 'past_due')",
    )
    .bind(workspace_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// The billing owners' email, with the pay link.
pub(crate) async fn notify_failed(
    state: &BillingState,
    workspace_id: &str,
    row_id: &str,
    now: OffsetDateTime,
) {
    if let Err(error) = mail(
        state,
        workspace_id,
        row_id,
        BillingMailKind::PaymentFailed,
        now,
    )
    .await
    {
        tracing::error!(
            ?error,
            workspace = workspace_id,
            "billing: payment-failed email not built"
        );
    }
}

/// Builds and sends one of the dunning emails.
pub(crate) async fn mail(
    state: &BillingState,
    workspace_id: &str,
    row_id: &str,
    kind: BillingMailKind,
    now: OffsetDateTime,
) -> BillingResult<()> {
    let master = &state.master;
    let Some(workspace) = Workspace::load(master, workspace_id).await? else {
        return Ok(());
    };
    let row = ChargeRow::load(master, row_id).await?;
    let meta = row.as_ref().and_then(ChargeRow::meta);
    let language = Language::parse(meta.as_ref().and_then(|m| m.language.as_deref()));
    let billing_email = meta
        .as_ref()
        .and_then(|m| m.customer.as_ref())
        .and_then(|c| c.email.clone());
    let recipients = notify::recipients(master, workspace_id, billing_email.as_deref()).await?;
    let plan_name = match &workspace.plan_id {
        Some(id) => Plan::load(master, id).await?.map(|p| p.name),
        None => None,
    }
    .unwrap_or_else(|| BRAND.to_owned());
    let account = Account::load(master, workspace_id).await?;
    let ends = account
        .as_ref()
        .and_then(Account::past_due_since)
        .map(|since| since + time::Duration::days(state.settings.grace_days));
    let pay_url = (kind != BillingMailKind::PlanEnded).then(|| {
        state
            .settings
            .pay_links
            .url(&state.settings.public_url, row_id, now.unix_timestamp())
    });
    let message = BillingMail {
        kind,
        workspace_id: workspace_id.to_owned(),
        workspace_name: workspace.name.clone(),
        recipients,
        language,
        plan_name,
        amount: meta
            .as_ref()
            .map(|m| notify::money_text(m.charge.gross, &m.charge.currency, language)),
        pay_url,
        ends_on: ends.map(|at| notify::date_text(at, language)),
        billing_url: state.settings.return_url.clone(),
    };
    notify::send(state.mailer.as_ref(), &message).await;
    Ok(())
}

/// A new mandate was saved: revoke the one it replaces, and charge a
/// past-due charge on it right away.
async fn after_mandate(
    state: &BillingState,
    workspace_id: &str,
    payment: &Payment,
    now: OffsetDateTime,
) {
    let master = &state.master;
    let Ok(Some(account)) = Account::load(master, workspace_id).await else {
        return;
    };
    let Some(http) = state.http.clone() else {
        return;
    };
    if let (Some(customer), Some(new)) = (&account.customer_id, &payment.mandate_id)
        && let Ok(mandates) = state.mollie.mandates(&http, customer).await
    {
        for old in mandates.iter().filter(|m| &m.id != new && m.is_usable()) {
            if let Err(error) = state.mollie.revoke_mandate(&http, customer, &old.id).await {
                tracing::warn!(%error, mandate = %old.id, "billing: old mandate not revoked");
            }
        }
    }
    if let Some(open) = &account.past_due_payment_id
        && let Err(error) = crate::renewals::retry_open_charge(state, workspace_id, open, now).await
    {
        tracing::warn!(
            ?error,
            workspace = workspace_id,
            "billing: past-due charge not retried on the new mandate"
        );
    }
}

/// Issues the invoice of a paid charge through the issuer and mirrors it.
/// A failure is logged; the renewal job retries paid charges without one.
pub(crate) async fn issue_invoice(state: &BillingState, row: &ChargeRow) {
    if let Err(error) = try_issue_invoice(state, row).await {
        tracing::error!(?error, row = %row.id, "billing: invoice not issued yet, the renewal job retries");
    }
}

async fn try_issue_invoice(state: &BillingState, row: &ChargeRow) -> BillingResult<()> {
    if row.invoice_id.is_some() || !row.is_paid() {
        return Ok(());
    }
    let (Some(meta), Some(payment_id)) = (row.meta(), row.provider_payment_id.clone()) else {
        return Ok(());
    };
    if meta.charge.gross <= 0 {
        return Ok(());
    }
    let Some(customer) = meta.customer.clone() else {
        return Err(BillingError::internal(
            "Failed to issue the invoice",
            "the charge has no billing details",
        ));
    };
    let paid_at = row
        .paid_at
        .as_deref()
        .and_then(parse_iso)
        .unwrap_or_else(OffsetDateTime::now_utc);
    let request = IssueRequest {
        workspace_id: row.workspace_id.clone(),
        customer,
        charge: meta.charge.clone(),
        payment_id: payment_id.clone(),
        paid_at,
        method_label: None,
        language: Language::parse(meta.language.as_deref()),
    };
    let issued = state
        .issuer
        .issue_paid(&request)
        .await
        .map_err(|error| BillingError::internal("Failed to issue the invoice", error))?;
    let mut document_key = None;
    if let (Some((bytes, content_type)), Some(files)) = (&issued.document, &state.files) {
        let safe: String = issued
            .number
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let extension = if *content_type == "application/pdf" {
            "pdf"
        } else {
            "html"
        };
        let key = format!("billing/invoices/{}/{safe}.{extension}", row.workspace_id);
        let options = weldsuite_ports::PutOptions {
            content_type: Some((*content_type).to_owned()),
            ..weldsuite_ports::PutOptions::default()
        };
        match files.put_boxed(&key, bytes.clone(), &options).await {
            Ok(_) => document_key = Some(key),
            Err(error) => tracing::warn!(%error, key, "billing: invoice document not stored"),
        }
    }
    let period = meta
        .charge
        .lines
        .iter()
        .find_map(|line| Some((line.period_start.clone()?, line.period_end.clone()?)))
        .or_else(|| Some((meta.period_start.clone()?, meta.period_end.clone()?)));
    let reason = match meta.purpose {
        Purpose::Checkout => "subscription_create",
        Purpose::Renewal => "subscription_cycle",
        Purpose::Change | Purpose::Addon => "subscription_update",
        Purpose::PayLink | Purpose::Credits => "manual",
        Purpose::Mandate => "setup",
    };
    mirror_invoice(
        &state.master,
        &row.id,
        &InvoiceMirror {
            workspace_id: &row.workspace_id,
            provider_invoice_id: &issued.provider_invoice_id,
            provider_payment_id: &payment_id,
            number: &issued.number,
            charge: &meta.charge,
            period,
            billing_reason: reason,
            document_key: document_key.as_deref(),
            paid_at,
        },
    )
    .await?;
    tracing::info!(row = %row.id, number = %issued.number, "billing: invoice issued");
    Ok(())
}

/// Reads the payment of `row` back from Mollie and settles it (the return
/// page, a missed webhook).
pub(crate) async fn refresh(
    state: &BillingState,
    http: &weldsuite_ports::OutboundHttp,
    row: &ChargeRow,
    now: OffsetDateTime,
) -> BillingResult<Option<Payment>> {
    let Some(payment_id) = &row.provider_payment_id else {
        return Ok(None);
    };
    let payment = match state.mollie.payment(http, payment_id).await {
        Ok(payment) => payment,
        Err(error) => {
            tracing::warn!(%error, row = %row.id, "billing: payment unreadable");
            return Ok(None);
        }
    };
    settle_payment(state, &payment, now).await?;
    Ok(Some(payment))
}
