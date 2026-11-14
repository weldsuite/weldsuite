//! `/api/billing/*` on Mollie: app-api's paths and response shapes
//! (`apps/workers/app-api/src/routes/billing/index.ts`), with the
//! differences ADR BILL-014 names:
//!
//! - `POST /checkout` answers `{ url }` for a new subscription, or
//!   `{ success, scheduled?, effectiveAt? }` / `{ paymentRequired, paymentUrl }`
//!   for a change of a running one; 400 `BILLING_DETAILS_REQUIRED` first
//!   when the invoice details are missing.
//! - `POST /seats` adds `effectiveAt` to a decrease that waits for the
//!   period end.
//! - `POST /payment-methods/setup-intent` answers `{ url }` (a Mollie hosted
//!   checkout) instead of a Stripe client secret.
//! - New: `GET /checkout/:id` (how a checkout ended), `POST
//!   /outstanding/checkout` (pay a past-due charge), `GET
//!   /invoices/:id/document` (the printable WeldBooks invoice), and the pay
//!   links at `/public/billing/pay/:token`.
//!
//! Permissions as on Global: `billing:manage` spends, `billing:read` views;
//! the subscription, plans and limits are open to every member.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::access::{answer, validate};
use crate::account::Account;
use crate::engine::{self, Actor, CheckoutAnswer, CheckoutInput, http_of};
use crate::period::Cycle;
use crate::plans::Plan;
use crate::store::ChargeRow;
use crate::workspace::{self, Workspace};
use crate::{BillingResult, BillingState, Caller};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<BillingState>
where
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require(["billing:manage"]);
    let read = || gate.require(["billing:read"]);
    Router::new()
        .route("/subscription", get(subscription))
        .route("/plans", get(plans))
        .route("/plans-page", get(plans_page))
        .route("/managed", get(managed))
        .route("/limits", get(limits))
        .route("/phone-numbers", get(empty_list))
        .route("/domains", get(empty_list))
        .route(
            "/phone-subscription",
            get(phone_subscription).route_layer(read()),
        )
        .route("/seat-price", get(seat_price).route_layer(read()))
        .route("/invoices", get(invoices).route_layer(read()))
        .route(
            "/invoices/{id}/document",
            get(invoice_document).route_layer(read()),
        )
        .route("/payments", get(payments).route_layer(read()))
        .route("/payment-methods", get(payment_methods).route_layer(read()))
        .route("/validate-downgrade", post(validate_downgrade))
        .route("/checkout", post(checkout).route_layer(manage()))
        .route("/checkout/{id}", get(checkout_status).route_layer(read()))
        .route("/seats", post(update_seats).route_layer(manage()))
        .route("/cancel", post(cancel).route_layer(manage()))
        .route("/reactivate", post(reactivate).route_layer(manage()))
        .route(
            "/payment-methods/setup-intent",
            post(setup_intent).route_layer(manage()),
        )
        .route(
            "/payment-methods/{id}/default",
            post(set_default_method).route_layer(manage()),
        )
        .route(
            "/payment-methods/{id}",
            delete(remove_method).route_layer(manage()),
        )
        .route(
            "/outstanding/checkout",
            post(outstanding_checkout).route_layer(manage()),
        )
}

pub(crate) fn public_router() -> Router<BillingState> {
    Router::new().route(
        &format!("{}/{{token}}", crate::paylink::PAY_PATH),
        get(pay_link),
    )
}

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

fn data(value: Value) -> Response {
    Data(value).into_response()
}

fn no_store(response: Response) -> Response {
    let mut response = response;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn workspace_of(state: &BillingState, caller: &Caller) -> BillingResult<Workspace> {
    Workspace::load(&caller.master(state), &caller.workspace_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Workspace", None).into())
}

fn actor(caller: &Caller) -> Actor {
    Actor {
        workspace_id: caller.workspace_id.clone(),
        user_id: Some(caller.user_id.clone()),
        tenant: Some(caller.db.clone()),
    }
}

// ── reads ───────────────────────────────────────────────────────────────────

/// The subscription, plus what only Mollie billing has: the change waiting
/// for the period end, and an open (past-due) charge with its pay link.
async fn subscription_value(state: &BillingState, caller: &Caller) -> BillingResult<Value> {
    let master = caller.master(state);
    let workspace = workspace_of(state, caller).await?;
    let plan = match &workspace.plan_id {
        Some(id) => Plan::load(&master, id).await?,
        None => None,
    };
    let used = workspace::active_members(&master, &workspace.id).await?;
    let mut body = workspace.subscription_json(plan.as_ref(), used);
    body["provider"] = json!("mollie");
    body["scheduledChange"] = Value::Null;
    body["outstanding"] = Value::Null;
    if let Some(account) = Account::load(&master, &workspace.id).await? {
        if let Some(change) = account.scheduled() {
            let plan_name = match &change.plan_id {
                Some(id) => Plan::load(&master, id).await?.map(|p| p.name),
                None => plan.as_ref().map(|p| p.name.clone()),
            };
            body["scheduledChange"] = json!({
                "planId": change.plan_id.clone().or_else(|| workspace.plan_id.clone()),
                "planName": plan_name,
                "seats": change.seats.unwrap_or_else(|| i64::from(workspace.purchased_seats)),
                "cycle": change.cycle.map_or_else(|| workspace.cycle().as_str(), Cycle::as_str),
                "effectiveAt": workspace.period_end,
            });
        }
        if let Some(open) = &account.past_due_payment_id
            && let Some(row) = ChargeRow::load(&master, open).await?
        {
            body["outstanding"] = json!({
                "amount": row.amount,
                "currency": row.currency,
                "since": account.past_due_since,
                "payUrl": state.settings.pay_links.url(
                    &state.settings.public_url,
                    &row.id,
                    now().unix_timestamp(),
                ),
            });
        }
    }
    Ok(body)
}

async fn subscription(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(subscription_value(&state, &caller).await.map(data))
}

async fn plans(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            let all = Plan::active(&caller.master(&state)).await?;
            Ok(data(Value::Array(
                all.iter()
                    .filter(|plan| !plan.is_free())
                    .map(Plan::list_json)
                    .collect(),
            )))
        }
        .await,
    )
}

async fn plans_page(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            let all = Plan::active(&caller.master(&state)).await?;
            let subscription = subscription_value(&state, &caller).await.ok();
            Ok(data(json!({
                "plans": all.iter().map(Plan::page_json).collect::<Vec<_>>(),
                "subscription": subscription,
                "pricing": { "country": Value::Null, "currency": crate::plans::CURRENCY, "taxIncluded": false },
                "partnerManaged": Value::Null,
            })))
        }
        .await,
    )
}

/// `GET /managed`: null for a directly billed workspace (every one on the
/// EU edition today); a partner workspace's partner and licence otherwise.
async fn managed(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            let partner: Option<(Value, String)> = sqlx::query_as(
                "select jsonb_build_object('id', p.id, 'name', p.name, 'logoUrl', p.logo_url,
                         'websiteUrl', p.website_url, 'supportEmail', p.support_email,
                         'supportUrl', p.support_url), p.status
                 from workspaces w join partners p on p.id = w.partner_id
                 where w.id = $1 and w.billing_mode = 'partner' limit 1",
            )
            .bind(&caller.workspace_id)
            .fetch_optional(&master)
            .await?;
            let Some((partner, partner_status)) = partner else {
                return Ok(data(Value::Null));
            };
            let licence: Option<Value> = sqlx::query_scalar(
                "select jsonb_build_object('status', status, 'allowedApps', allowed_apps,
                         'monthlyCredits', monthly_credits, 'maxSeats', max_seats)
                 from workspace_licences where workspace_id = $1 limit 1",
            )
            .bind(&caller.workspace_id)
            .fetch_optional(&master)
            .await?;
            let balance: Option<i32> = sqlx::query_scalar(
                "select current_balance from workspace_credits where workspace_id = $1",
            )
            .bind(&caller.workspace_id)
            .fetch_optional(&master)
            .await?;
            let members = workspace::active_members(&master, &caller.workspace_id).await?;
            let licence = licence.unwrap_or_else(
                || json!({ "status": "ended", "allowedApps": [], "monthlyCredits": 0, "maxSeats": null }),
            );
            let read_only = partner_status == "suspended" || licence["status"] != "active";
            Ok(data(json!({
                "partner": partner,
                "partnerStatus": partner_status,
                "licence": licence,
                "creditsUsedThisPeriod": 0,
                "creditBalance": balance.unwrap_or(0),
                "activeMembers": members,
                "readOnly": read_only,
            })))
        }
        .await,
    )
}

async fn limits(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            let workspace = workspace_of(&state, &caller).await?;
            let plan = match &workspace.plan_id {
                Some(id) => Plan::load(&master, id).await?,
                None => None,
            };
            let features = plan.as_ref().map_or_else(|| json!({}), Plan::features);
            let members = workspace::active_members(&master, &workspace.id).await?;
            let usage: Option<(i32, i32)> = sqlx::query_as(
                "select emails_sent_this_month, ai_credits_used_this_month from workspace_usage
                 where workspace_id = $1 limit 1",
            )
            .bind(&workspace.id)
            .fetch_optional(&master)
            .await
            .unwrap_or(None);
            let credits: Option<(i32, i32)> = sqlx::query_as(
                "select current_balance, monthly_allocation from workspace_credits where workspace_id = $1",
            )
            .bind(&workspace.id)
            .fetch_optional(&master)
            .await?;
            let number = |key: &str| features.get(key).and_then(Value::as_i64).unwrap_or(0);
            Ok(data(json!({
                "planId": plan.as_ref().map(|p| p.id.clone()),
                "planName": plan.as_ref().map_or("Free", |p| p.name.as_str()),
                "removeBranding": plan.as_ref().is_some_and(|p| p.remove_branding)
                    || features.get("removeBranding").and_then(Value::as_bool).unwrap_or(false),
                "maxMembers": plan.as_ref().and_then(|p| p.max_users),
                "purchasedSeats": workspace.purchased_seats,
                "emailsPerMonth": number("emailsPerMonth"),
                "aiCreditsPerMonth": number("aiCreditsPerMonth"),
                "monthlyCredits": plan.as_ref().and_then(|p| p.monthly_credits).unwrap_or(0),
                "currentUsage": {
                    "memberCount": members,
                    "emailsSentThisMonth": usage.map_or(0, |u| u.0),
                    "aiCreditsUsedThisMonth": usage.map_or(0, |u| u.1),
                    "creditsBalance": credits.map_or(0, |c| c.0),
                    "creditsMonthlyAllocation": credits.map_or(0, |c| c.1),
                },
                "meters": [],
            })))
        }
        .await,
    )
}

/// Phone numbers and domains aren't bought through billing on the EU
/// edition (`phone-number-purchase`, `domain-purchase` stay hidden).
async fn empty_list() -> Response {
    data(json!([]))
}

async fn phone_subscription() -> Response {
    no_store(data(Value::Null))
}

/// What one seat costs on the running period: the price it was bought at.
async fn seat_price(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            let workspace = workspace_of(&state, &caller).await?;
            let account = Account::load(&master, &workspace.id).await?;
            let value = match account.and_then(|a| a.unit_amount.map(|unit| (unit, a.currency))) {
                Some((unit, currency)) if workspace.has_running_subscription(now()) => json!({
                    "amount": unit,
                    "currency": currency,
                    "interval": workspace.cycle().interval(),
                }),
                _ => Value::Null,
            };
            Ok(no_store(data(value)))
        }
        .await,
    )
}

fn page_params(query: Option<&str>, default_limit: i64) -> (i64, i64) {
    let mut limit = default_limit;
    let mut page = 1;
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "limit" => limit = value.parse().unwrap_or(default_limit),
            "page" => page = value.parse().unwrap_or(1),
            _ => {}
        }
    }
    let limit = limit.clamp(1, 100);
    (limit, (page.max(1) - 1) * limit)
}

async fn invoices(
    State(state): State<BillingState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    answer(
        async {
            let (limit, offset) = page_params(query.as_deref(), 10);
            let rows: Vec<Value> = sqlx::query_scalar(
                "select jsonb_build_object(
                     'id', id, 'number', number,
                     'amount', coalesce(amount_paid, amount_due, 0), 'currency', currency, 'status', status,
                     'periodStart', to_char(period_start, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                     'periodEnd', to_char(period_end, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                     'pdfUrl', pdf_url, 'hostedUrl', hosted_url,
                     'createdAt', to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                     'taxAmount', coalesce(tax_amount, 0), 'subtotalAmount', coalesce(subtotal_amount, 0),
                     'customerCountry', customer_country, 'customerTaxExempt', customer_tax_exempt,
                     'lines', lines)
                 from billing_invoices where workspace_id = $1
                 order by created_at desc limit $2 offset $3",
            )
            .bind(&caller.workspace_id)
            .bind(limit)
            .bind(offset)
            .fetch_all(&caller.master(&state))
            .await?;
            Ok(data(Value::Array(rows)))
        }
        .await,
    )
}

/// The printable invoice: the copy in the files bucket.
async fn invoice_document(
    State(state): State<BillingState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                "select document_key, number from billing_invoices where id = $1 and workspace_id = $2",
            )
            .bind(&id)
            .bind(&caller.workspace_id)
            .fetch_optional(&caller.master(&state))
            .await?;
            let Some((Some(key), number)) = row else {
                return Err(ApiError::not_found("Invoice", None).into());
            };
            let Some(files) = &state.files else {
                return Err(ApiError::unavailable("Invoice documents are not stored on this install").into());
            };
            let object = files
                .get_boxed(&key)
                .await
                .map_err(|error| crate::BillingError::internal("Failed to read the invoice", error))?;
            let Some(object) = object else {
                return Err(ApiError::not_found("Invoice", None).into());
            };
            let content_type = object
                .info
                .content_type
                .clone()
                .unwrap_or_else(|| "text/html; charset=utf-8".to_owned());
            let name = number.unwrap_or(id).replace(['"', '\\', '/'], "_");
            let extension = if content_type.starts_with("application/pdf") { "pdf" } else { "html" };
            let mut response = object.bytes.into_response();
            let headers = response.headers_mut();
            if let Ok(value) = HeaderValue::from_str(&content_type) {
                headers.insert(CONTENT_TYPE, value);
            }
            if let Ok(value) = HeaderValue::from_str(&format!("inline; filename=\"{name}.{extension}\"")) {
                headers.insert(CONTENT_DISPOSITION, value);
            }
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
            // Printable HTML on the platform's own origin: no scripts, no
            // same-origin access, whatever the document holds.
            headers.insert(
                http::header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("sandbox allow-popups allow-modals; default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"),
            );
            headers.insert(
                http::header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            Ok(response)
        }
        .await,
    )
}

async fn payments(
    State(state): State<BillingState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    answer(
        async {
            let (limit, offset) = page_params(query.as_deref(), 20);
            let rows: Vec<Value> = sqlx::query_scalar(
                "select jsonb_build_object(
                     'id', id, 'amount', amount, 'currency', currency, 'status', status,
                     'paymentMethodType', payment_method_type, 'paymentMethodBrand', payment_method_brand,
                     'paymentMethodLast4', payment_method_last4, 'failureMessage', failure_message,
                     'refundedAmount', refunded_amount, 'invoiceId', invoice_id, 'kind', kind,
                     'createdAt', to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))
                 from billing_payments
                 where workspace_id = $1 and (provider <> 'mollie' or amount > 0)
                 order by created_at desc limit $2 offset $3",
            )
            .bind(&caller.workspace_id)
            .bind(limit)
            .bind(offset)
            .fetch_all(&caller.master(&state))
            .await?;
            Ok(data(Value::Array(rows)))
        }
        .await,
    )
}

/// The workspace's mandates, as Global's payment methods: `card` or
/// `sepa_debit`, the brand and the last four, and which renewals charge.
async fn payment_methods(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            let Some(account) = Account::load(&master, &caller.workspace_id).await? else {
                return Ok(no_store(data(json!([]))));
            };
            let Some(customer) = account.customer_id.clone() else {
                return Ok(no_store(data(json!([]))));
            };
            let http = http_of(&state, caller.http(&state))?;
            let mandates = state
                .mollie
                .mandates(&http, &customer)
                .await
                .map_err(|error| {
                    crate::BillingError::internal("Failed to load payment methods", error)
                })?;
            let methods: Vec<Value> = mandates
                .iter()
                .filter(|mandate| mandate.is_usable())
                .map(|mandate| {
                    let (exp_month, exp_year) = mandate
                        .details
                        .expiry
                        .as_deref()
                        .and_then(|date| {
                            let mut parts = date.split('-');
                            let year: i64 = parts.next()?.parse().ok()?;
                            let month: i64 = parts.next()?.parse().ok()?;
                            Some((Some(month), Some(year)))
                        })
                        .unwrap_or((None, None));
                    json!({
                        "id": mandate.id,
                        "type": match mandate.method.as_deref() {
                            Some("creditcard") => "card",
                            Some("directdebit") => "sepa_debit",
                            Some(other) => other,
                            None => "unknown",
                        },
                        "brand": mandate.details.brand.as_deref().map(str::to_ascii_lowercase),
                        "last4": mandate.details.last4,
                        "label": mandate.details.label,
                        "expMonth": exp_month,
                        "expYear": exp_year,
                        "isDefault": account.mandate_id.as_deref() == Some(mandate.id.as_str()),
                    })
                })
                .collect();
            Ok(no_store(data(Value::Array(methods))))
        }
        .await,
    )
}

async fn validate_downgrade(
    State(state): State<BillingState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let target = validate(&headers, &body, |issues, body| {
                issues
                    .text(body, "targetPlanId", Presence::Optional, Some(1), None)
                    .into_option()
                    .or_else(|| issues.text(body, "planId", Presence::Optional, Some(1), None).into_option())
            })?;
            let Some(target) = target else {
                return Err(ApiError::bad_request("targetPlanId is required").into());
            };
            let master = caller.master(&state);
            let Some(plan) = Plan::load(&master, &target).await? else {
                return Err(ApiError::not_found("Target plan", None).into());
            };
            let members = workspace::active_members(&master, &caller.workspace_id).await?;
            let mut blockers = Vec::new();
            if let Some(max) = plan.max_users.filter(|max| *max > 0 && members > i64::from(*max)) {
                let over = members - i64::from(max);
                blockers.push(format!(
                    "You have {members} member{} but the {} plan only allows {max}. Please remove {over} member{} first.",
                    if members == 1 { "" } else { "s" },
                    plan.name,
                    if over == 1 { "" } else { "s" },
                ));
            }
            Ok(data(json!({ "canDowngrade": blockers.is_empty(), "blockers": blockers })))
        }
        .await,
    )
}

// ── writes ──────────────────────────────────────────────────────────────────

/// A return address on the platform's own origin, or none (the default).
fn own_url(state: &BillingState, url: Option<String>) -> Option<String> {
    url.filter(|url| {
        url.starts_with(&format!("{}/", state.settings.public_url))
            || url == &state.settings.public_url
    })
}

fn checkout_body(answer: CheckoutAnswer) -> Value {
    match answer {
        CheckoutAnswer::Redirect(url) => json!({ "url": url }),
        CheckoutAnswer::Changed {
            scheduled,
            effective_at,
            purchased_seats,
        } => json!({
            "success": true,
            "scheduled": scheduled,
            "effectiveAt": effective_at,
            "purchasedSeats": purchased_seats,
        }),
        CheckoutAnswer::PaymentRequired {
            url,
            purchased_seats,
        } => json!({
            "paymentRequired": true,
            "paymentUrl": url,
            "purchasedSeats": purchased_seats,
        }),
    }
}

async fn checkout(
    State(state): State<BillingState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, body| {
                let plan_id = issues.text(body, "planId", Presence::Required, Some(1), None);
                let seats = issues.integer(body, "seats", Presence::Required, Some(1));
                let cycle =
                    issues.choice(body, "cycle", Presence::Required, &["monthly", "yearly"]);
                let success_url = issues.text(body, "successUrl", Presence::Optional, None, None);
                let cancel_url = issues.text(body, "cancelUrl", Presence::Optional, None, None);
                Some(CheckoutInput {
                    plan_id: plan_id.into_option()?,
                    seats: seats.into_option()?,
                    cycle: Cycle::parse(&cycle.into_option()?)?,
                    success_url: success_url.into_option(),
                    cancel_url: cancel_url.into_option(),
                })
            })?;
            let Some(mut input) = input else {
                return Err(ApiError::bad_request("Invalid checkout").into());
            };
            input.success_url = own_url(&state, input.success_url.take());
            input.cancel_url = own_url(&state, input.cancel_url.take());
            let master = caller.master(&state);
            let result = engine::checkout(
                &state,
                &master,
                caller.http(&state),
                &actor(&caller),
                &input,
                now(),
            )
            .await?;
            Ok(data(checkout_body(result)))
        }
        .await,
    )
}

async fn checkout_status(
    State(state): State<BillingState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            let row = ChargeRow::load(&master, &id)
                .await?
                .filter(|row| row.workspace_id == caller.workspace_id)
                .ok_or_else(|| ApiError::not_found("Checkout", None))?;
            let purpose = row.kind.clone().unwrap_or_default();
            let status = if row.is_paid() {
                "paid".to_owned()
            } else {
                match http_of(&state, caller.http(&state)) {
                    Ok(http) => match crate::settle::refresh(&state, &http, &row, now()).await? {
                        Some(payment) => match payment.status.as_str() {
                            "paid" => "paid",
                            "canceled" => "canceled",
                            "expired" => "expired",
                            "failed" => "failed",
                            _ => "pending",
                        }
                        .to_owned(),
                        None => "unknown".to_owned(),
                    },
                    Err(_) => "unknown".to_owned(),
                }
            };
            Ok(no_store(data(json!({
                "id": row.id,
                "status": status,
                "purpose": if purpose == "pay_link" { "pay_link".to_owned() } else { purpose },
            }))))
        }
        .await,
    )
}

async fn update_seats(
    State(state): State<BillingState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let seat_count = validate(&headers, &body, |issues, body| {
                issues
                    .integer(body, "seatCount", Presence::Required, Some(1))
                    .into_option()
            })?;
            let Some(seat_count) = seat_count else {
                return Err(ApiError::bad_request("Seat count must be at least 1").into());
            };
            let master = caller.master(&state);
            let result = engine::set_seats(
                &state,
                &master,
                caller.http(&state),
                &actor(&caller),
                seat_count,
                now(),
            )
            .await?;
            let body = match result {
                CheckoutAnswer::Changed {
                    scheduled,
                    effective_at,
                    purchased_seats,
                } => {
                    let mut body = Map::new();
                    body.insert("purchasedSeats".to_owned(), json!(purchased_seats));
                    if scheduled {
                        body.insert("effectiveAt".to_owned(), json!(effective_at));
                        body.insert("scheduledSeats".to_owned(), json!(seat_count));
                    }
                    Value::Object(body)
                }
                CheckoutAnswer::PaymentRequired {
                    url,
                    purchased_seats,
                } => json!({
                    "purchasedSeats": purchased_seats,
                    "paymentRequired": true,
                    "paymentUrl": url,
                }),
                CheckoutAnswer::Redirect(url) => json!({
                    "purchasedSeats": seat_count,
                    "paymentRequired": true,
                    "paymentUrl": url,
                }),
            };
            Ok(data(body))
        }
        .await,
    )
}

async fn cancel(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            engine::cancel(&caller.master(&state), &caller.workspace_id, now()).await?;
            Ok(data(json!({ "success": true })))
        }
        .await,
    )
}

async fn reactivate(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            engine::reactivate(&caller.master(&state), &caller.workspace_id, now()).await?;
            Ok(data(json!({ "success": true })))
        }
        .await,
    )
}

async fn setup_intent(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            let url = engine::mandate_checkout(
                &state,
                &caller.master(&state),
                caller.http(&state),
                &actor(&caller),
            )
            .await?;
            Ok(data(json!({ "url": url })))
        }
        .await,
    )
}

async fn set_default_method(
    State(state): State<BillingState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            let account = Account::load(&master, &caller.workspace_id)
                .await?
                .filter(|account| account.customer_id.is_some())
                .ok_or_else(|| ApiError::not_found("Payment method", None))?;
            let customer = account.customer_id.clone().unwrap_or_default();
            let http = http_of(&state, caller.http(&state))?;
            let mandate = state
                .mollie
                .mandate(&http, &customer, &id)
                .await
                .map_err(|error| {
                    if error.is_not_found() {
                        crate::BillingError::Api(ApiError::not_found("Payment method", None))
                    } else {
                        crate::BillingError::internal(
                            "Failed to set the default payment method",
                            error,
                        )
                    }
                })?;
            if !mandate.is_usable() {
                return Err(ApiError::bad_request(
                    "This payment method can't be charged any more.",
                )
                .into());
            }
            let mut tx = master.begin().await?;
            crate::account::set_mandate(
                &mut tx,
                &caller.workspace_id,
                &mandate.id,
                mandate.method.as_deref(),
                mandate.details.label.as_deref(),
            )
            .await?;
            tx.commit().await?;
            Ok(data(
                json!({ "success": true, "id": mandate.id, "partial": false }),
            ))
        }
        .await,
    )
}

async fn remove_method(
    State(state): State<BillingState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            let workspace = workspace_of(&state, &caller).await?;
            let account = Account::load(&master, &caller.workspace_id)
                .await?
                .filter(|account| account.customer_id.is_some())
                .ok_or_else(|| ApiError::not_found("Payment method", None))?;
            if account.mandate_id.as_deref() == Some(id.as_str())
                && workspace.has_running_subscription(now())
                && !workspace.cancel_at_period_end
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "MANDATE_IN_USE",
                    "Your plan renews with this payment method. Add another payment method first, or cancel your plan.",
                )
                .into());
            }
            let http = http_of(&state, caller.http(&state))?;
            let customer = account.customer_id.clone().unwrap_or_default();
            state
                .mollie
                .revoke_mandate(&http, &customer, &id)
                .await
                .map_err(|error| crate::BillingError::internal("Failed to remove the payment method", error))?;
            if account.mandate_id.as_deref() == Some(id.as_str()) {
                sqlx::query(
                    "update billing_accounts set mandate_id = null, mandate_method = null, mandate_label = null,
                         updated_at = now()
                     where workspace_id = $1",
                )
                .bind(&caller.workspace_id)
                .execute(&master)
                .await?;
            }
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        .await,
    )
}

async fn outstanding_checkout(State(state): State<BillingState>, caller: Caller) -> Response {
    answer(
        async {
            let url = engine::outstanding_checkout(
                &state,
                &caller.master(&state),
                caller.http(&state),
                &caller.workspace_id,
                None,
            )
            .await?
            .ok_or_else(|| ApiError::bad_request("Nothing is outstanding."))?;
            Ok(data(json!({ "url": url })))
        }
        .await,
    )
}

/// `GET /public/billing/pay/:token`: 303 to a Mollie checkout for the
/// charge the link names, or back to the billing page when it is no longer
/// open (already paid, or the link expired).
async fn pay_link(State(state): State<BillingState>, Path(token): Path<String>) -> Response {
    let back = |status: &str| {
        let url = weldsuite_mollie::with_query(&state.settings.return_url, "pay", status)
            .unwrap_or_else(|| state.settings.return_url.clone());
        Redirect::to(&url).into_response()
    };
    let Some(row_id) = state
        .settings
        .pay_links
        .verify(&token, now().unix_timestamp())
    else {
        return back("expired");
    };
    let row = match ChargeRow::load(&state.master, &row_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return back("expired"),
        Err(error) => {
            tracing::error!(%error, "billing: pay link row unreadable");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    match engine::outstanding_checkout(
        &state,
        &state.master,
        None,
        &row.workspace_id,
        Some(&row.id),
    )
    .await
    {
        Ok(Some(url)) => Redirect::to(&url).into_response(),
        Ok(None) => back("done"),
        Err(error) => {
            let response = error.respond();
            if response.status().is_server_error() {
                tracing::error!("billing: pay link checkout failed");
            }
            response
        }
    }
}
