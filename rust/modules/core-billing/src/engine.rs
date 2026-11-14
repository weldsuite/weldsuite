//! What the routes and the renewal job do to a subscription: start one with
//! a first payment, change plan or seats, schedule what waits for the period
//! end, save a new payment method, pay a past-due charge, and end a plan.

use http::StatusCode;
use serde_json::json;
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_mollie::{
    Money, NewCustomer, NewPayment, Payment, Sequence, checkout_locale, with_query,
};
use weldsuite_ports::OutboundHttp;

use crate::account::{self, Account, Scheduled};
use crate::buyer::{self, BillingDetails};
use crate::lines::{Charge, Line, LineKind, plan_description};
use crate::period::{Cycle, iso, prorate};
use crate::plans::{CURRENCY, Plan};
use crate::store::{ChargeMeta, ChargeRow, Purpose, status_of};
use crate::vat::{Treatment, VatDecision};
use crate::workspace::{self, Workspace};
use crate::{BillingError, BillingResult, BillingState, Language, credits, seats};

/// The brand on Mollie's checkout and the customer's statement.
pub const BRAND: &str = "WeldSuite";

/// Who acts: a member through a route, or the system (renewals, webhook).
#[derive(Debug, Clone)]
pub struct Actor {
    pub workspace_id: String,
    pub user_id: Option<String>,
    pub tenant: Option<PgPool>,
}

/// What `POST /checkout` (and `/seats`) answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckoutAnswer {
    /// Pay on Mollie's hosted checkout.
    Redirect(String),
    /// Applied now (`scheduled: false`) or at `effective_at`.
    Changed {
        scheduled: bool,
        effective_at: Option<String>,
        purchased_seats: i64,
    },
    /// The mandate couldn't be charged: pay on a hosted checkout instead.
    PaymentRequired { url: String, purchased_seats: i64 },
}

/// What the checkout body asked for.
#[derive(Debug, Clone)]
pub struct CheckoutInput {
    pub plan_id: String,
    pub seats: i64,
    pub cycle: Cycle,
    pub success_url: Option<String>,
    pub cancel_url: Option<String>,
}

pub(crate) fn http_of(
    state: &BillingState,
    request: Option<OutboundHttp>,
) -> BillingResult<OutboundHttp> {
    request.or_else(|| state.http.clone()).ok_or_else(|| {
        BillingError::internal("Payment provider unavailable", "no outbound HTTP client")
    })
}

fn unreachable(error: impl std::fmt::Display) -> BillingError {
    tracing::error!(%error, "billing: Mollie call failed");
    BillingError::Api(ApiError::new(
        StatusCode::BAD_GATEWAY,
        "PAYMENT_PROVIDER_ERROR",
        "The payment provider couldn't be reached. Try again in a moment.",
    ))
}

/// `blockPartnerManaged()`: a partner workspace's billing is its partner's.
pub(crate) fn refuse_partner(workspace: &Workspace) -> BillingResult<()> {
    if workspace.is_partner() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "PARTNER_MANAGED",
            "This workspace is billed by its partner. Contact them to change your subscription.",
        )
        .into());
    }
    Ok(())
}

/// The workspace's Mollie customer, created on its first checkout.
pub(crate) async fn ensure_customer(
    state: &BillingState,
    master: &PgPool,
    http: &OutboundHttp,
    workspace: &Workspace,
    details: Option<&BillingDetails>,
) -> BillingResult<(Account, String)> {
    let account = Account::ensure(master, &workspace.id).await?;
    if let Some(customer) = account.customer_id.clone() {
        return Ok((account, customer));
    }
    let customer = NewCustomer {
        name: details.map_or_else(|| workspace.name.clone(), |d| d.name.clone()),
        email: details.and_then(|d| d.email.clone()),
        locale: checkout_locale(details.and_then(|d| d.language.as_deref())),
        metadata: json!({ "workspaceId": workspace.id }),
    };
    let id = state
        .mollie
        .create_customer(http, &customer, &account.id)
        .await
        .map_err(unreachable)?;
    Account::set_customer(master, &workspace.id, &id).await?;
    let account = Account::load(master, &workspace.id)
        .await?
        .unwrap_or(account);
    let customer = account.customer_id.clone().unwrap_or(id);
    Ok((account, customer))
}

fn payment_metadata(row: &ChargeRow) -> serde_json::Value {
    json!({ "kind": "billing", "paymentRowId": row.id, "workspaceId": row.workspace_id })
}

/// A first payment on the hosted checkout for `row`: its checkout URL.
#[allow(clippy::too_many_arguments)] // one per part of the payment
pub(crate) async fn first_payment(
    state: &BillingState,
    master: &PgPool,
    http: &OutboundHttp,
    customer_id: &str,
    row: &ChargeRow,
    charge: &Charge,
    return_url: Option<&str>,
    cancel_url: Option<&str>,
    language: Option<&str>,
    methods: Vec<String>,
) -> BillingResult<String> {
    let return_to = return_url.unwrap_or(&state.settings.return_url);
    let redirect = with_query(return_to, "checkout", &row.id).ok_or_else(|| {
        BillingError::internal("Failed to start checkout", "the return URL is invalid")
    })?;
    let amount = Money::from_cents(&charge.currency, charge.gross);
    let description = charge.description(BRAND);
    let payment = NewPayment {
        amount: &amount,
        description: &description,
        redirect_url: Some(&redirect),
        cancel_url,
        webhook_url: &state.settings.webhook_url,
        metadata: payment_metadata(row),
        sequence: Sequence::First {
            customer_id: customer_id.to_owned(),
        },
        methods,
        locale: checkout_locale(language),
    };
    let created = state
        .mollie
        .create(http, &payment, &row.id)
        .await
        .map_err(unreachable)?;
    ChargeRow::set_payment(master, &row.id, &created.id).await?;
    created.checkout_url.ok_or_else(|| {
        BillingError::internal(
            "Failed to start checkout",
            format!("Mollie gave payment {} no checkout", created.id),
        )
    })
}

/// A recurring payment on the account's mandate for `row`.
pub(crate) async fn recurring_payment(
    state: &BillingState,
    master: &PgPool,
    http: &OutboundHttp,
    account: &Account,
    row: &ChargeRow,
    charge: &Charge,
) -> Result<Payment, weldsuite_mollie::MollieError> {
    let (Some(customer), Some(mandate)) = (account.customer_id.clone(), account.mandate_id.clone())
    else {
        return Err(weldsuite_mollie::MollieError::Refused {
            status: 422,
            detail: "no mandate".to_owned(),
        });
    };
    let amount = Money::from_cents(&charge.currency, charge.gross);
    let description = charge.description(BRAND);
    let payment = NewPayment {
        amount: &amount,
        description: &description,
        redirect_url: None,
        cancel_url: None,
        webhook_url: &state.settings.webhook_url,
        metadata: payment_metadata(row),
        sequence: Sequence::Recurring {
            customer_id: customer,
            mandate_id: mandate,
        },
        methods: Vec::new(),
        locale: None,
    };
    let created = state.mollie.create(http, &payment, &row.id).await?;
    if let Err(error) = ChargeRow::set_payment(master, &row.id, &created.id).await {
        tracing::error!(%error, row = %row.id, payment = %created.id, "billing: payment id not stored");
    }
    Ok(created)
}

/// The plan line for `seats` on `plan` at `unit` cents a seat.
pub(crate) fn plan_line(
    plan: &Plan,
    seats: i64,
    cycle: Cycle,
    unit: i64,
    period: Option<(OffsetDateTime, OffsetDateTime)>,
    language: Language,
) -> Line {
    Line {
        kind: LineKind::Plan,
        description: plan_description(&plan.name, seats, cycle.as_str(), language == Language::Nl),
        quantity: seats,
        unit_amount: unit,
        amount: unit * seats,
        period_start: period.map(|p| iso(p.0)),
        period_end: period.map(|p| iso(p.1)),
        plan_id: Some(plan.id.clone()),
        addon: None,
    }
}

/// Members plus open invitations: what seats may not drop below.
async fn seats_in_use(
    state: &BillingState,
    master: &PgPool,
    workspace: &Workspace,
) -> BillingResult<i64> {
    let members = workspace::active_members(master, &workspace.id).await?;
    let pending =
        seats::pending_invitations(state.identity.as_ref(), workspace.organization()).await;
    Ok(members + pending)
}

fn plan_cap_violation(plan: &Plan, seats: i64) -> Option<ApiError> {
    plan.max_users
        .filter(|max| *max > 0 && seats > i64::from(*max))
        .map(|max| {
            ApiError::bad_request(format!(
                "The {} plan allows a maximum of {max} seats. Please reduce your seat count or choose a higher plan.",
                plan.name
            ))
        })
}

/// `POST /checkout`: a new subscription (hosted checkout), or a change of a
/// running one.
#[allow(clippy::too_many_lines)] // the checks, then one of two flows
pub async fn checkout(
    state: &BillingState,
    master: &PgPool,
    http: Option<OutboundHttp>,
    actor: &Actor,
    input: &CheckoutInput,
    now: OffsetDateTime,
) -> BillingResult<CheckoutAnswer> {
    let Some(workspace) = Workspace::load(master, &actor.workspace_id).await? else {
        return Err(ApiError::not_found("Workspace", None).into());
    };
    refuse_partner(&workspace)?;
    let Some(plan) = Plan::load(master, &input.plan_id).await? else {
        return Err(ApiError::not_found("Plan", None).into());
    };
    if plan.is_free() {
        return Err(ApiError::bad_request(
            "The Free plan has no checkout. Cancel your subscription to return to Free.",
        )
        .into());
    }
    let Some(unit) = plan.unit_amount(input.cycle) else {
        if plan.on_request() {
            return Err(ApiError::bad_request(format!(
                "The {} plan is available on request. Please contact sales.",
                plan.name
            ))
            .into());
        }
        return Err(ApiError::bad_request(format!(
            "The {} plan has no {CURRENCY} price for {} billing.",
            plan.name,
            input.cycle.as_str()
        ))
        .into());
    };
    if let Some(refusal) = plan_cap_violation(&plan, input.seats) {
        return Err(refusal.into());
    }
    let in_use = seats_in_use(state, master, &workspace).await?;
    if input.seats < in_use {
        return Err(ApiError::bad_request(format!(
            "Cannot purchase {} seats — you have {in_use} active members. Remove members first.",
            input.seats
        ))
        .into());
    }
    let Some(tenant) = &actor.tenant else {
        return Err(BillingError::internal(
            "Failed to start checkout",
            "no tenant database",
        ));
    };
    let details = match buyer::load(tenant, &workspace.name).await? {
        Ok(details) => details,
        Err(missing) => return Err(buyer::details_required(&missing).into()),
    };
    let http = http_of(state, http)?;
    let account = Account::load(master, &workspace.id).await?;
    if workspace.has_running_subscription(now)
        && let Some(account) = account.filter(|a| a.next_charge_at.is_some())
    {
        return change(
            state,
            master,
            &http,
            actor,
            &workspace,
            &account,
            &plan,
            input.seats,
            input.cycle,
            &details,
            now,
        )
        .await;
    }

    let vat = buyer::vat_for(Some(&http), &state.settings.seller_country, &details).await;
    let language = details.language();
    let charge = Charge::new(
        CURRENCY,
        vec![plan_line(
            &plan,
            input.seats,
            input.cycle,
            unit,
            None,
            language,
        )],
        vat,
    );
    let (_, customer) = ensure_customer(state, master, &http, &workspace, Some(&details)).await?;
    let meta = ChargeMeta {
        purpose: Purpose::Checkout,
        charge: charge.clone(),
        plan_id: Some(plan.id.clone()),
        seats: Some(input.seats),
        cycle: Some(input.cycle.as_str().to_owned()),
        unit_amount: Some(unit),
        period_start: None,
        period_end: None,
        settles: None,
        user_id: actor.user_id.clone(),
        language: Some(language.as_str().to_owned()),
        customer: Some(details.clone()),
        applied: None,
        charged_back: None,
        credits: None,
        package_id: None,
    };
    let row = ChargeRow::create(
        master,
        &workspace.id,
        &format!("checkout:{}", generate_id("chk")),
        &meta,
    )
    .await?;
    let url = first_payment(
        state,
        master,
        &http,
        &customer,
        &row,
        &charge,
        input.success_url.as_deref(),
        input.cancel_url.as_deref(),
        Some(language.as_str()),
        Vec::new(),
    )
    .await?;
    tracing::info!(workspace = %workspace.id, row = %row.id, plan = %plan.id, seats = input.seats, "billing: checkout started");
    Ok(CheckoutAnswer::Redirect(url))
}

/// Refuses changes while a charge is open.
fn refuse_past_due(account: &Account) -> BillingResult<()> {
    if account.past_due_payment_id.is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "PAYMENT_OUTSTANDING",
            "A payment is outstanding. Pay it first, then change your plan.",
        )
        .into());
    }
    Ok(())
}

/// A change of a running subscription (ADR BILL-014, decision 6): dearer
/// now and prorated, cheaper or another cycle at the period end.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)] // one flow, one place
pub(crate) async fn change(
    state: &BillingState,
    master: &PgPool,
    http: &OutboundHttp,
    actor: &Actor,
    workspace: &Workspace,
    account: &Account,
    plan: &Plan,
    seats: i64,
    cycle: Cycle,
    details: &BillingDetails,
    now: OffsetDateTime,
) -> BillingResult<CheckoutAnswer> {
    refuse_past_due(account)?;
    let current_seats = i64::from(workspace.purchased_seats);
    let Some((start, end)) = workspace.period() else {
        return Err(BillingError::internal(
            "Failed to change the plan",
            "no period",
        ));
    };
    let current_plan = match &workspace.plan_id {
        Some(id) => Plan::load(master, id).await?,
        None => None,
    };
    let current_cycle = workspace.cycle();
    let current_unit = account
        .unit_amount
        .map(i64::from)
        .or_else(|| {
            current_plan
                .as_ref()
                .and_then(|p| p.unit_amount(current_cycle))
        })
        .unwrap_or(0);
    let same_plan = workspace.plan_id.as_deref() == Some(plan.id.as_str());
    let scheduled_answer = |effective: OffsetDateTime| CheckoutAnswer::Changed {
        scheduled: true,
        effective_at: Some(iso(effective)),
        purchased_seats: current_seats,
    };

    if cycle != current_cycle {
        let mut tx = master.begin().await?;
        account::schedule(
            &mut tx,
            &workspace.id,
            Some(&Scheduled {
                plan_id: (!same_plan).then(|| plan.id.clone()),
                seats: (seats != current_seats).then_some(seats),
                cycle: Some(cycle),
            }),
        )
        .await?;
        clear_cancel(&mut tx, &workspace.id).await?;
        tx.commit().await?;
        return Ok(scheduled_answer(end));
    }

    let unit = if same_plan {
        current_unit
    } else {
        plan.unit_amount(cycle).unwrap_or(0)
    };
    let old_total = current_unit * current_seats;
    let new_total = unit * seats;
    if new_total < old_total {
        let mut tx = master.begin().await?;
        account::schedule(
            &mut tx,
            &workspace.id,
            Some(&Scheduled {
                plan_id: (!same_plan).then(|| plan.id.clone()),
                seats: (seats != current_seats).then_some(seats),
                cycle: None,
            }),
        )
        .await?;
        clear_cancel(&mut tx, &workspace.id).await?;
        tx.commit().await?;
        return Ok(scheduled_answer(end));
    }

    let prorated = prorate(new_total - old_total, start, end, now);
    let language = details.language();
    let meta = |charge: Charge, purpose: Purpose| ChargeMeta {
        purpose,
        charge,
        plan_id: Some(plan.id.clone()),
        seats: Some(seats),
        cycle: Some(cycle.as_str().to_owned()),
        unit_amount: Some(unit),
        period_start: Some(iso(now)),
        period_end: Some(iso(end)),
        settles: None,
        user_id: actor.user_id.clone(),
        language: Some(language.as_str().to_owned()),
        customer: Some(details.clone()),
        applied: None,
        charged_back: None,
        credits: None,
        package_id: None,
    };
    if prorated <= 0 {
        let mut tx = master.begin().await?;
        apply_change(&mut tx, &workspace.id, &plan.id, seats, unit).await?;
        clear_cancel(&mut tx, &workspace.id).await?;
        tx.commit().await?;
        seats::write_cap(
            state.identity.as_ref(),
            workspace.organization(),
            seats::seat_cap(plan, seats),
        )
        .await;
        return Ok(CheckoutAnswer::Changed {
            scheduled: false,
            effective_at: None,
            purchased_seats: seats,
        });
    }

    let vat = buyer::vat_for(Some(http), &state.settings.seller_country, details).await;
    let description = if same_plan {
        match language {
            Language::Nl => format!(
                "{}: van {current_seats} naar {seats} gebruikers, rest van de periode",
                plan.name
            ),
            Language::En => format!(
                "{}: {current_seats} to {seats} seats, rest of the period",
                plan.name
            ),
        }
    } else {
        match language {
            Language::Nl => format!(
                "Overstap naar {} ({seats} gebruikers), rest van de periode",
                plan.name
            ),
            Language::En => format!(
                "Upgrade to {} ({seats} seats), rest of the period",
                plan.name
            ),
        }
    };
    let line = Line {
        kind: LineKind::Proration,
        description,
        quantity: 1,
        unit_amount: prorated,
        amount: prorated,
        period_start: Some(iso(now)),
        period_end: Some(iso(end)),
        plan_id: Some(plan.id.clone()),
        addon: None,
    };
    let charge = Charge::new(CURRENCY, vec![line], vat);
    // One row per change of this period, from what it was to what it becomes,
    // on this day: a double click or two admins at once reuse the same row,
    // and so the same Mollie payment (its id is the idempotency key), instead
    // of charging the proration twice.
    let today = iso(now);
    let change_key = format!(
        "change:{}:{}:{}:{current_seats}:{}:{seats}:{}:{}",
        workspace.id,
        iso(start),
        workspace.plan_id.as_deref().unwrap_or("-"),
        plan.id,
        &today[..10.min(today.len())],
        // The amount too: a retry the same day with other VAT (VIES back,
        // billing details fixed) is another charge, not the stored row.
        charge.gross,
    );
    let row = ChargeRow::create(
        master,
        &workspace.id,
        &change_key,
        &meta(charge.clone(), Purpose::Change),
    )
    .await?;

    let accepted = if account.can_charge() {
        match recurring_payment(state, master, http, account, &row, &charge).await {
            Ok(payment) => Some(payment),
            Err(error) if error.is_refusal() => {
                tracing::warn!(%error, workspace = %workspace.id, "billing: mandate refused the change charge");
                None
            }
            Err(error) => return Err(unreachable(error)),
        }
    } else {
        None
    };
    if let Some(payment) = accepted.filter(|p| p.status.is_accepted()) {
        let mut tx = master.begin().await?;
        apply_change(&mut tx, &workspace.id, &plan.id, seats, unit).await?;
        clear_cancel(&mut tx, &workspace.id).await?;
        mark_applied(&mut tx, &row.id).await?;
        if payment.status != weldsuite_mollie::PaymentStatus::Paid {
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
        tx.commit().await?;
        // Paid at once (a card): settled here, invoice included; otherwise
        // the webhook settles it.
        if payment.status == weldsuite_mollie::PaymentStatus::Paid {
            crate::settle::settle_payment(state, &payment, now).await?;
        }
        seats::write_cap(
            state.identity.as_ref(),
            workspace.organization(),
            seats::seat_cap(plan, seats),
        )
        .await;
        tracing::info!(workspace = %workspace.id, row = %row.id, prorated, "billing: change charged and applied");
        return Ok(CheckoutAnswer::Changed {
            scheduled: false,
            effective_at: None,
            purchased_seats: seats,
        });
    }

    // The mandate couldn't be charged: the same charge on a hosted checkout,
    // which also leaves a new mandate.
    let retry = ChargeRow::create(
        master,
        &workspace.id,
        &format!("{change_key}:checkout"),
        &meta(charge.clone(), Purpose::Change),
    )
    .await?;
    let customer = account
        .customer_id
        .clone()
        .ok_or_else(|| BillingError::internal("Failed to change the plan", "no Mollie customer"))?;
    let url = first_payment(
        state,
        master,
        http,
        &customer,
        &retry,
        &charge,
        None,
        None,
        Some(language.as_str()),
        Vec::new(),
    )
    .await?;
    Ok(CheckoutAnswer::PaymentRequired {
        url,
        purchased_seats: current_seats,
    })
}

/// `POST /seats`: the seat count, through [`change`].
pub async fn set_seats(
    state: &BillingState,
    master: &PgPool,
    http: Option<OutboundHttp>,
    actor: &Actor,
    seat_count: i64,
    now: OffsetDateTime,
) -> BillingResult<CheckoutAnswer> {
    let Some(workspace) = Workspace::load(master, &actor.workspace_id).await? else {
        return Err(ApiError::not_found("Workspace", None).into());
    };
    refuse_partner(&workspace)?;
    let account = Account::load(master, &workspace.id).await?;
    let (Some(account), Some(plan_id)) = (
        account.filter(|a| a.next_charge_at.is_some() && workspace.has_running_subscription(now)),
        workspace.plan_id.clone(),
    ) else {
        return Err(ApiError::bad_request("No active subscription").into());
    };
    let in_use = seats_in_use(state, master, &workspace).await?;
    if seat_count < in_use {
        return Err(ApiError::bad_request(format!(
            "Cannot reduce to {seat_count} seats — you have {in_use} active members. Remove members first."
        ))
        .into());
    }
    let Some(plan) = Plan::load(master, &plan_id).await? else {
        return Err(ApiError::not_found("Plan", None).into());
    };
    if let Some(max) = plan
        .max_users
        .filter(|max| *max > 0 && seat_count > i64::from(*max))
    {
        return Err(ApiError::bad_request(format!(
            "The {} plan allows a maximum of {max} seats. Please upgrade your plan for more seats.",
            plan.name
        ))
        .into());
    }
    if seat_count == i64::from(workspace.purchased_seats) && account.scheduled_seats.is_none() {
        return Ok(CheckoutAnswer::Changed {
            scheduled: false,
            effective_at: None,
            purchased_seats: seat_count,
        });
    }
    let Some(tenant) = &actor.tenant else {
        return Err(BillingError::internal(
            "Failed to update seats",
            "no tenant database",
        ));
    };
    let details = match buyer::load(tenant, &workspace.name).await? {
        Ok(details) => details,
        Err(missing) => return Err(buyer::details_required(&missing).into()),
    };
    let http = http_of(state, http)?;
    change(
        state,
        master,
        &http,
        actor,
        &workspace,
        &account,
        &plan,
        seat_count,
        workspace.cycle(),
        &details,
        now,
    )
    .await
}

/// Plan, seats and seat price now; the period stays.
pub(crate) async fn apply_change(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    plan_id: &str,
    seats: i64,
    unit: i64,
) -> Result<(), sqlx::Error> {
    // What was scheduled for the period end stays, except what this change
    // replaces now: the seats always, the plan when it changes. A scheduled
    // cycle switch is never replaced (a cycle change is always scheduled).
    sqlx::query(
        "update billing_accounts set scheduled_seats = null,
             scheduled_plan_id = case
                 when (select plan_id from workspaces where id = $1) is distinct from $2 then null
                 else scheduled_plan_id end,
             updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(plan_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update workspaces set plan_id = $2, purchased_seats = $3, updated_at = now() where id = $1",
    )
    .bind(workspace_id)
    .bind(plan_id)
    .bind(i32::try_from(seats).unwrap_or(i32::MAX))
    .execute(&mut *tx)
    .await?;
    account::set_unit_amount(tx, workspace_id, unit).await?;
    Ok(())
}

async fn clear_cancel(tx: &mut sqlx::PgConnection, workspace_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update workspaces set subscription_cancel_at_period_end = false, updated_at = now() where id = $1",
    )
    .bind(workspace_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

pub(crate) async fn mark_applied(
    tx: &mut sqlx::PgConnection,
    row_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update billing_payments set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{applied}', 'true'),
             updated_at = now()
         where id = $1",
    )
    .bind(row_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// `POST /cancel`: ends at the period end.
pub async fn cancel(master: &PgPool, workspace_id: &str, now: OffsetDateTime) -> BillingResult<()> {
    let Some(workspace) = Workspace::load(master, workspace_id).await? else {
        return Err(ApiError::not_found("Workspace", None).into());
    };
    refuse_partner(&workspace)?;
    if !workspace.has_running_subscription(now) {
        return Err(ApiError::bad_request("No active subscription").into());
    }
    sqlx::query(
        "update workspaces set subscription_cancel_at_period_end = true, updated_at = now() where id = $1",
    )
    .bind(&workspace.id)
    .execute(master)
    .await?;
    Ok(())
}

/// `POST /reactivate`: keeps a subscription that was set to end.
pub async fn reactivate(
    master: &PgPool,
    workspace_id: &str,
    now: OffsetDateTime,
) -> BillingResult<()> {
    let Some(workspace) = Workspace::load(master, workspace_id).await? else {
        return Err(ApiError::not_found("Workspace", None).into());
    };
    refuse_partner(&workspace)?;
    if !workspace.has_running_subscription(now) || !workspace.cancel_at_period_end {
        return Err(ApiError::bad_request("No subscription to reactivate").into());
    }
    sqlx::query(
        "update workspaces set subscription_cancel_at_period_end = false, updated_at = now() where id = $1",
    )
    .bind(&workspace.id)
    .execute(master)
    .await?;
    Ok(())
}

fn empty_charge(country: &str) -> Charge {
    Charge::new(
        CURRENCY,
        Vec::new(),
        VatDecision {
            treatment: Treatment::OutsideEu,
            rate_bps: 0,
            country: country.to_owned(),
        },
    )
}

/// `POST /payment-methods/setup-intent`: a zero-amount first payment by card
/// that leaves a new mandate (iDEAL and SEPA Direct Debit mandates come from
/// paying: a checkout, or a past-due charge).
pub async fn mandate_checkout(
    state: &BillingState,
    master: &PgPool,
    http: Option<OutboundHttp>,
    actor: &Actor,
) -> BillingResult<String> {
    let Some(workspace) = Workspace::load(master, &actor.workspace_id).await? else {
        return Err(ApiError::not_found("Workspace", None).into());
    };
    refuse_partner(&workspace)?;
    let details = match &actor.tenant {
        Some(tenant) => buyer::load(tenant, &workspace.name).await?.ok(),
        None => None,
    };
    let http = http_of(state, http)?;
    let (_, customer) = ensure_customer(state, master, &http, &workspace, details.as_ref()).await?;
    let language = details
        .as_ref()
        .map_or(Language::En, BillingDetails::language);
    let charge = empty_charge(details.as_ref().map_or("", |d| d.country.as_str()));
    let meta = ChargeMeta {
        purpose: Purpose::Mandate,
        charge: charge.clone(),
        plan_id: None,
        seats: None,
        cycle: None,
        unit_amount: None,
        period_start: None,
        period_end: None,
        settles: None,
        user_id: actor.user_id.clone(),
        language: Some(language.as_str().to_owned()),
        customer: details.clone(),
        applied: None,
        charged_back: None,
        credits: None,
        package_id: None,
    };
    let row = ChargeRow::create(
        master,
        &workspace.id,
        &format!("mandate:{}", generate_id("mnd")),
        &meta,
    )
    .await?;
    first_payment(
        state,
        master,
        &http,
        &customer,
        &row,
        &charge,
        None,
        None,
        Some(language.as_str()),
        vec!["creditcard".to_owned()],
    )
    .await
}

/// A hosted checkout for the workspace's past-due charge (the billing page's
/// "Pay now" and the emailed pay link). `expected` is the row a pay link
/// names: a link for a charge that is no longer open answers `None`.
pub async fn outstanding_checkout(
    state: &BillingState,
    master: &PgPool,
    http: Option<OutboundHttp>,
    workspace_id: &str,
    expected: Option<&str>,
) -> BillingResult<Option<String>> {
    let Some(account) = Account::load(master, workspace_id).await? else {
        return Ok(None);
    };
    let Some(open_id) = account.past_due_payment_id.clone() else {
        return Ok(None);
    };
    if expected.is_some_and(|expected| expected != open_id) {
        return Ok(None);
    }
    let Some(open) = ChargeRow::load(master, &open_id).await? else {
        return Ok(None);
    };
    let Some(open_meta) = open.meta() else {
        return Err(BillingError::internal(
            "Failed to start checkout",
            "the open charge has no metadata",
        ));
    };
    let Some(customer) = account.customer_id.clone() else {
        return Err(BillingError::internal(
            "Failed to start checkout",
            "no Mollie customer",
        ));
    };
    let http = http_of(state, http)?;
    // A checkout opened for this charge in the last hour that can still be
    // paid is reused: mail scanners open links before people do.
    let recent: Option<String> = sqlx::query_scalar(
        "select provider_payment_id from billing_payments
         where workspace_id = $1 and kind = 'pay_link' and status = 'processing'
           and metadata ->> 'settles' = $2 and provider_payment_id is not null
           and created_at > now() - interval '1 hour'
         order by created_at desc limit 1",
    )
    .bind(workspace_id)
    .bind(&open.id)
    .fetch_optional(master)
    .await?;
    if let Some(payment_id) = recent
        && let Ok(payment) = state.mollie.payment(&http, &payment_id).await
        && payment.status == weldsuite_mollie::PaymentStatus::Open
        && let Some(url) = payment.checkout_url
    {
        return Ok(Some(url));
    }
    let meta = ChargeMeta {
        purpose: Purpose::PayLink,
        settles: Some(open.id.clone()),
        applied: None,
        charged_back: None,
        credits: None,
        package_id: None,
        ..open_meta.clone()
    };
    let row = ChargeRow::create(
        master,
        workspace_id,
        &format!("pay_link:{}:{}", open.id, generate_id("pay")),
        &meta,
    )
    .await?;
    let url = first_payment(
        state,
        master,
        &http,
        &customer,
        &row,
        &open_meta.charge,
        None,
        None,
        open_meta.language.as_deref(),
        Vec::new(),
    )
    .await?;
    Ok(Some(url))
}

/// What ending a subscription did (`applySubscriptionEnded`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    SkippedPartner,
    SkippedInactive,
    GracePeriod,
    DowngradedToFree,
}

/// Days a `paid_plan_required` workspace has to pay before it is deleted.
const DELETION_GRACE_DAYS: i64 = 30;

/// The subscription ended (cancelled at the period end, or past due beyond
/// the grace period): Global's `applySubscriptionEnded`. A
/// `paid_plan_required` workspace gets the 30-day window before deletion;
/// any other goes to Free, its seats to 0 and its cap to Free's.
pub async fn end_subscription(
    state: &BillingState,
    master: &PgPool,
    workspace_id: &str,
    now: OffsetDateTime,
) -> BillingResult<Ended> {
    let mut tx = master.begin().await?;
    let Some(workspace) = Workspace::lock(&mut tx, workspace_id).await? else {
        return Ok(Ended::SkippedInactive);
    };
    if workspace.is_partner() {
        return Ok(Ended::SkippedPartner);
    }
    account::end(&mut tx, workspace_id).await?;
    if workspace.paid_plan_required {
        if !workspace.is_active {
            tx.commit().await?;
            return Ok(Ended::SkippedInactive);
        }
        let trial_expired = workspace
            .trial_expired_at
            .as_deref()
            .and_then(crate::period::parse_iso)
            .unwrap_or(now);
        let deletion = workspace
            .scheduled_deletion_at
            .as_deref()
            .and_then(crate::period::parse_iso)
            .unwrap_or(trial_expired + time::Duration::days(DELETION_GRACE_DAYS));
        sqlx::query(
            "update workspaces set subscription_status = 'canceled',
                 subscription_cancel_at_period_end = false, trial_expired_at = $2::timestamp,
                 scheduled_deletion_at = $3::timestamp, updated_at = now()
             where id = $1",
        )
        .bind(workspace_id)
        .bind(iso(trial_expired))
        .bind(iso(deletion))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Ended::GracePeriod);
    }
    let free = Plan::free(master).await?;
    sqlx::query(
        "update workspaces set plan_id = $2, purchased_seats = 0, subscription_status = 'canceled',
             subscription_cycle = null, subscription_current_period_start = null,
             subscription_current_period_end = null, subscription_cancel_at_period_end = false,
             updated_at = now()
         where id = $1",
    )
    .bind(workspace_id)
    .bind(free.as_ref().map(|plan| plan.id.clone()))
    .execute(&mut *tx)
    .await?;
    credits::reset_allocation(
        &mut tx,
        workspace_id,
        free.as_ref()
            .and_then(|p| p.monthly_credits)
            .map_or(0, i64::from),
    )
    .await?;
    tx.commit().await?;
    if let Some(free) = &free {
        seats::write_cap(
            state.identity.as_ref(),
            workspace.organization(),
            seats::seat_cap(free, 0),
        )
        .await;
    }
    tracing::info!(
        workspace = workspace_id,
        "billing: subscription ended, now on Free"
    );
    Ok(Ended::DowngradedToFree)
}
