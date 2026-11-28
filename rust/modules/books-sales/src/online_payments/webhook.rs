//! The two public routes of online payments, outside the session:
//!
//! - `POST /public/weldbooks/mollie/webhook/{signedRef}`: Mollie's webhook.
//!   It has no credential but the signed reference
//!   ([`weldsuite_books_domain::payment_refs`]) and believes nothing it is told:
//!   the body names a payment id, and the payment is read back from Mollie with
//!   the entity's own credentials. It answers 404 for a reference that is not
//!   ours and 200 once it is, also for what it ignores (a payment that is not
//!   this invoice's, an entity that disconnected). It answers 5xx only when
//!   something may work next time (Mollie unreachable, a posting refused by a
//!   closed period), so that Mollie, which retries, tries again.
//! - `GET /public/weldbooks/mollie/callback`: where Mollie Connect sends the
//!   merchant back. The signed `state` says whose connection it is.
//!
//! A payment is booked on the entity's Mollie money account through the same
//! posting as `POST /api/payments`, once per Mollie payment: the payment's id
//! is derived from Mollie's, so a webhook delivered twice records one payment.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderValue, StatusCode};
use sea_orm::EntityTrait;
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_books_domain::guards::{AuditInput, change, write_audit};
use weldsuite_books_domain::http::{BooksState, Caller, now, now_ms};
use weldsuite_books_domain::payment_refs::{self, PayRef};
use weldsuite_books_domain::payments::{AllocationInput, RecordPaymentInput, record_payment};
use weldsuite_books_domain::system_accounts::ensure_payment_provider_account;
use weldsuite_books_domain::vendor_tax::sha256_hex;
use weldsuite_catalogs::entity_events::{INVOICE_PAID, INVOICE_UPDATED, PAYMENT_CREATED};
use weldsuite_db::{Tenant, Workspaces, orm};
use weldsuite_mollie::connect::Tokens;
use weldsuite_mollie::{Mollie, Payment, PaymentStatus};
use weldsuite_ports::{DynCache, MemoryCache, RequestCache};
use weldsuite_schema::tenant::payments;

use super::connection::{self, NewConnection, Row};
use super::pay::{balance_cents, currency_of, started_payments};
use super::routes::{finish_connect, return_target};
use super::{ACCOUNT_NAME, Ctx, PROVIDER, PayError};
use crate::delivery::public::{client_ip, limited};
use crate::delivery::{append_history, entry, history_of};
use crate::finalize::load_invoice;
use crate::persist::{owned, text};

/// Webhook calls per minute for one reference (every payment of an invoice
/// shares it).
const REF_LIMIT: i64 = 60;
const MAX_BODY_BYTES: usize = 10 * 1024;
/// Where the callback sends the merchant back to when the state is lost.
const DEFAULT_RETURN: &str = "/settings/apps/weldbooks?tab=payments";

#[derive(Clone)]
struct PublicState {
    books: BooksState,
    workspaces: Option<Arc<Workspaces>>,
}

/// The webhook and the callback, at their full paths.
pub(crate) fn public_routes<S>(state: &BooksState, workspaces: Option<Arc<Workspaces>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let routes = Router::new()
        .route("/webhook/{signed_ref}", post(webhook))
        .route("/callback", get(callback))
        .layer(axum::middleware::map_response(no_store))
        .with_state(PublicState {
            books: state.clone(),
            workspaces,
        });
    Router::new().nest("/public/weldbooks/mollie", routes)
}

async fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        "x-robots-tag",
        HeaderValue::from_static("noindex, nofollow"),
    );
    headers.insert(
        http::header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

fn status(code: StatusCode) -> Response {
    code.into_response()
}

fn fallback_cache() -> Arc<dyn DynCache> {
    static CACHE: std::sync::OnceLock<Arc<MemoryCache>> = std::sync::OnceLock::new();
    Arc::clone(CACHE.get_or_init(|| Arc::new(MemoryCache::new()))) as Arc<dyn DynCache>
}

/// The 429, when this reference has used up its minute.
async fn limited_ref(
    cache: Option<Arc<dyn DynCache>>,
    reference: &str,
    limit: i64,
) -> Option<Response> {
    let cache = cache.unwrap_or_else(fallback_cache);
    let minute = now_ms().div_euclid(60_000);
    let key: String = weldsuite_books_domain::vendor_tax::sha256_hex(reference)
        .chars()
        .take(16)
        .collect();
    match cache
        .increment_boxed(
            &format!("rl:bm:ref:{key}:{minute}"),
            1,
            Some(Duration::from_secs(120)),
        )
        .await
    {
        Ok(count) if count > limit => Some(status(StatusCode::TOO_MANY_REQUESTS)),
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(%error, "[books/mollie] webhook rate limit failed");
            None
        }
    }
}

/// The tenant a reference leads to.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
async fn tenant_of(
    state: &PublicState,
    parts: &Parts,
    workspace: &str,
) -> Result<Tenant, Response> {
    let tenant = if let Some(tenant) = parts.extensions.get::<Tenant>().cloned() {
        tenant
    } else {
        let Some(workspaces) = &state.workspaces else {
            return Err(status(StatusCode::NOT_FOUND));
        };
        workspaces.tenant(workspace).await.map_err(|error| {
            tracing::warn!(?error, "[books/mollie] workspace not found");
            status(StatusCode::NOT_FOUND)
        })?
    };
    // A reference only opens the workspace it names.
    if tenant.suspended || tenant.workspace_id != workspace {
        return Err(status(StatusCode::NOT_FOUND));
    }
    Ok(tenant)
}

fn now_secs() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

// ── the webhook ─────────────────────────────────────────────────────────────

async fn webhook(
    State(state): State<PublicState>,
    Path(signed_ref): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let cache = parts
        .extensions
        .get::<RequestCache>()
        .map(|c| Arc::clone(&c.0))
        .or_else(|| state.books.cache.clone());
    if let Some(refusal) = limited_ref(cache, &signed_ref, REF_LIMIT).await {
        return refusal;
    }
    let Some(secret) = crate::delivery::Links::secret(&state.books) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Some(reference) =
        payment_refs::verify(&secret, &signed_ref, payment_refs::WEBHOOK, now_secs())
    else {
        return status(StatusCode::NOT_FOUND);
    };
    let tenant = match tenant_of(&state, &parts, &reference.ws).await {
        Ok(tenant) => tenant,
        Err(response) => return response,
    };
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY_BYTES + 1).await else {
        return status(StatusCode::OK);
    };
    // Mollie posts `id=tr_…` as a form.
    let payment_id = url::form_urlencoded::parse(&bytes)
        .find(|(name, _)| name == "id")
        .map(|(_, value)| value.into_owned())
        .filter(|id| weldsuite_mollie::is_payment_id(id));
    let Some(payment_id) = payment_id else {
        return status(StatusCode::OK);
    };
    match process(&state.books, &tenant, &reference, &payment_id).await {
        Ok(_) => status(StatusCode::OK),
        Err(PayError::Transient(why) | PayError::Refused(why)) => {
            tracing::error!(%why, payment = payment_id, "[books/mollie] webhook: Mollie failed");
            status(StatusCode::INTERNAL_SERVER_ERROR)
        }
        Err(error @ (PayError::Db(_) | PayError::Post(_))) => {
            tracing::error!(%error, payment = payment_id, "[books/mollie] webhook: the payment was not booked");
            status(StatusCode::INTERNAL_SERVER_ERROR)
        }
        Err(error) => {
            tracing::warn!(%error, payment = payment_id, "[books/mollie] webhook ignored");
            status(StatusCode::OK)
        }
    }
}

/// What a webhook came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Applied {
    /// Not ours to act on: another invoice's or workspace's payment, an entity
    /// that disconnected, an invoice that is gone.
    Ignored,
    /// Mollie's status was kept; nothing to book yet (or any more).
    Noted,
    /// The payment was booked by this call.
    Booked,
    /// The payment had been booked before.
    AlreadyBooked,
}

/// Reads the payment back from Mollie and acts on what it says.
pub(crate) async fn process(
    books: &BooksState,
    tenant: &Tenant,
    reference: &PayRef,
    payment_id: &str,
) -> Result<Applied, PayError> {
    let db = orm(&tenant.db);
    let (Some(invoice_id), entity) = (reference.i.as_deref(), reference.e.as_str()) else {
        return Ok(Applied::Ignored);
    };
    let Some(invoice) = load_invoice(&tenant.db, invoice_id).await? else {
        return Ok(Applied::Ignored);
    };
    if text(&invoice, "entityId") != Some(entity) {
        return Ok(Applied::Ignored);
    }
    let Some(conn) = connection::connected(&db, entity).await? else {
        return Ok(Applied::Ignored);
    };
    let Some(ctx) = Ctx::new(books, &tenant.db, None) else {
        return Err(PayError::Unavailable("Outbound HTTP is not available"));
    };
    let http = &ctx.http;
    let id = payment_id.to_owned();
    let payment = match connection::call(&ctx, &conn, |mollie| {
        let id = id.clone();
        async move { mollie.payment(http, &id).await }
    })
    .await
    {
        Ok(payment) => payment,
        // Mollie has no such payment for this connection: not ours.
        Err(PayError::Refused(_)) => return Ok(Applied::Ignored),
        Err(error) => return Err(error),
    };
    // What Mollie says it was made for must be this reference's.
    let meta = |key: &str| payment.metadata.get(key).and_then(Value::as_str);
    if meta("ws") != Some(reference.ws.as_str())
        || meta("entityId") != Some(entity)
        || meta("invoiceId") != Some(invoice_id)
    {
        return Ok(Applied::Ignored);
    }
    note_status(&tenant.db, &invoice, &payment).await?;
    if payment.status != PaymentStatus::Paid {
        return Ok(Applied::Noted);
    }
    let event_workspace = tenant
        .clerk_org_id
        .clone()
        .unwrap_or_else(|| tenant.workspace_id.clone());
    let system = Caller::in_process(
        tenant.db.clone(),
        &tenant.workspace_id,
        &event_workspace,
        "",
        entity,
        Some(ctx.http.clone()),
    );
    book_payment(&ctx, &system, &conn, invoice_id, &payment).await
}

/// Keeps what Mollie reported in the invoice's history: a changed status, and
/// a refund or chargeback (which the owner books; see [`Applied`]).
async fn note_status(
    db: &weldsuite_db::PgPool,
    invoice: &Value,
    payment: &Payment,
) -> Result<(), PayError> {
    let invoice_id = text(invoice, "id").unwrap_or_default();
    let history = history_of(invoice);
    let known = started_payments(&history)
        .into_iter()
        .find(|s| s.payment_id == payment.id)
        .map(|s| s.status);
    let reported = payment.status.as_str();
    if known.as_deref() != Some(reported) {
        append_history(
            db,
            invoice_id,
            entry(
                "payment_status",
                json!({ "paymentId": payment.id, "status": reported }),
            ),
            Vec::new(),
        )
        .await?;
    }
    let refunded = payment.amount_refunded.as_ref().map_or(0, |m| m.cents);
    let charged_back = payment.amount_charged_back.as_ref().map_or(0, |m| m.cents);
    if refunded + charged_back > 0 {
        let already = history.iter().rev().find(|e| {
            text(e, "type") == Some("payment_reversed") && text(e, "paymentId") == Some(&payment.id)
        });
        let same = already.is_some_and(|e| {
            e.get("refundedCents").and_then(Value::as_i64) == Some(refunded)
                && e.get("chargedBackCents").and_then(Value::as_i64) == Some(charged_back)
        });
        if !same {
            append_history(
                db,
                invoice_id,
                entry(
                    "payment_reversed",
                    json!({
                        "paymentId": payment.id,
                        "refundedCents": refunded,
                        "chargedBackCents": charged_back,
                    }),
                ),
                Vec::new(),
            )
            .await?;
        }
    }
    Ok(())
}

/// The id of the payment a Mollie payment is booked as: derived from Mollie's,
/// so recording it twice is one payment.
pub(crate) fn booked_payment_id(mollie_id: &str) -> String {
    let digest = sha256_hex(mollie_id);
    format!("pay_mol_{}", &digest[..16])
}

fn payment_method(method: Option<&str>) -> &'static str {
    match method {
        Some("creditcard" | "applepay") => "credit_card",
        Some(
            "ideal" | "bancontact" | "banktransfer" | "directdebit" | "eps" | "przelewy24" | "kbc"
            | "belfius" | "trustly" | "bancomatpay",
        ) => "bank_transfer",
        _ => "other",
    }
}

fn iso_of(at: Option<&str>) -> String {
    at.and_then(|text| OffsetDateTime::parse(text, &Rfc3339).ok())
        .map_or_else(now, weldsuite_events::iso_timestamp)
}

/// Records a paid Mollie payment on the invoice, against the Mollie money
/// account, once.
#[allow(
    clippy::too_many_lines,
    reason = "the checks, the posting and its events, in order"
)]
async fn book_payment(
    ctx: &Ctx,
    system: &Caller,
    conn: &Row,
    invoice_id: &str,
    payment: &Payment,
) -> Result<Applied, PayError> {
    let id = booked_payment_id(&payment.id);
    if payments::Entity::find_by_id(id.clone())
        .one(&orm(&ctx.db))
        .await?
        .is_some_and(|row| row.deleted_at.is_none())
    {
        return Ok(Applied::AlreadyBooked);
    }
    let Some(invoice) = load_invoice(&ctx.db, invoice_id).await? else {
        return Ok(Applied::Ignored);
    };
    let Some(paid) = payment.amount.as_ref().filter(|m| m.cents > 0) else {
        return Ok(Applied::Ignored);
    };
    if paid.currency != currency_of(&invoice) {
        tracing::warn!(
            payment = payment.id,
            "[books/mollie] a payment in another currency than its invoice"
        );
        return Ok(Applied::Ignored);
    }
    let account =
        ensure_payment_provider_account(&ctx.db, &conn.entity_id, PROVIDER, ACCOUNT_NAME).await?;
    if conn.bank_account_id.as_deref() != Some(account.bank_account_id.as_str()) {
        connection::set_bank_account(&orm(&ctx.db), &conn.id, &account.bank_account_id).await?;
    }
    // What the invoice still owes: more than that is a credit on the customer.
    let applied = balance_cents(&invoice).min(paid.cents);
    let allocations = if applied > 0 {
        vec![AllocationInput {
            invoice_id: Some(invoice_id.to_owned()),
            bill_id: None,
            amount: cents_to_amount(applied),
        }]
    } else {
        Vec::new()
    };
    let method = payment.details.method.as_deref();
    let result = record_payment(
        &ctx.db,
        Some(&ctx.http),
        RecordPaymentInput {
            id: Some(id.clone()),
            entity_id: conn.entity_id.clone(),
            received: true,
            amount: cents_to_amount(paid.cents),
            currency: Some(paid.currency.clone()),
            date: iso_of(payment.paid_at.as_deref()),
            payment_method: Some(payment_method(method).to_owned()),
            deposit_to: Some("bank".to_owned()),
            reference: Some(payment.id.clone()),
            notes: Some(format!(
                "Paid online with Mollie{}",
                method.map(|m| format!(" ({m})")).unwrap_or_default()
            )),
            contact_id: owned(&invoice, "contactId"),
            bank_account_id: Some(account.bank_account_id.clone()),
            allocations,
            ..RecordPaymentInput::default()
        },
    )
    .await?;
    let mut changes = serde_json::Map::new();
    changes.insert(
        "journalEntryId".into(),
        change(Value::Null, json!(result.journal_entry_id)),
    );
    write_audit(
        &ctx.db,
        AuditInput {
            accounting_entity_id: Some(&conn.entity_id),
            entity_type: "payment",
            entity_id: &result.payment_id,
            action: "created",
            changes: Some(changes),
        },
        None,
        None,
    )
    .await;
    system.publish_system(
        &ctx.books,
        PAYMENT_CREATED,
        &result.payment_id,
        json!({
            "id": result.payment_id,
            "amount": to_amount_text(paid.cents),
            "currency": paid.currency,
            "invoiceId": invoice_id,
            "method": "mollie",
        }),
    );
    if let Some(after) = load_invoice(&ctx.db, invoice_id).await? {
        let data = json!({
            "id": invoice_id,
            "invoiceNumber": after["invoiceNumber"],
            "status": after["status"],
            "total": after["total"],
            "amountPaid": after["amountPaid"],
            "balanceDue": after["balanceDue"],
            "currency": after["currency"],
            "contactId": after["contactId"],
        });
        system.publish_system(&ctx.books, INVOICE_UPDATED, invoice_id, data.clone());
        if text(&after, "status") == Some("paid") {
            system.publish_system(&ctx.books, INVOICE_PAID, invoice_id, data);
        }
    }
    Ok(Applied::Booked)
}

#[allow(
    clippy::cast_precision_loss,
    reason = "cents of an invoice fit f64 exactly"
)]
fn cents_to_amount(cents: i64) -> f64 {
    cents as f64 / 100.0
}

fn to_amount_text(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

// ── the OAuth callback ──────────────────────────────────────────────────────

/// A 302 to `target` with the outcome in its query.
fn back(target: &str, outcome: &[(&str, &str)]) -> Response {
    let mut location = target.to_owned();
    for (name, value) in outcome {
        location.push(if location.contains('?') { '&' } else { '?' });
        location.push_str(name);
        location.push('=');
        location.extend(url::form_urlencoded::byte_serialize(value.as_bytes()));
    }
    let mut response = status(StatusCode::FOUND);
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(http::header::LOCATION, value);
    }
    response
}

/// `access_denied` and the like: a short code, nothing else.
fn short_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_lowercase() || *c == '_')
        .take(40)
        .collect()
}

async fn callback(
    State(state): State<PublicState>,
    RawQuery(query): RawQuery,
    request: axum::extract::Request,
) -> Response {
    let (parts, _) = request.into_parts();
    let settings = super::Settings::of(&state.books);
    let default_target = settings
        .app_url
        .as_deref()
        .map(|app| format!("{}{DEFAULT_RETURN}", app.trim_end_matches('/')));
    let failure = |target: Option<&str>, reason: &str| match target.or(default_target.as_deref()) {
        Some(target) => back(target, &[("mollie", "error"), ("reason", reason)]),
        None => status(StatusCode::BAD_REQUEST),
    };
    let ip = client_ip(&parts.headers, state.books.trusted_proxies);
    let cache = parts
        .extensions
        .get::<RequestCache>()
        .map(|c| Arc::clone(&c.0))
        .or_else(|| state.books.cache.clone());
    if let Some(refusal) = limited(cache, ip.as_deref(), "mollie-callback", false).await {
        return refusal;
    }
    let params: Vec<(String, String)> =
        url::form_urlencoded::parse(query.as_deref().unwrap_or_default().as_bytes())
            .into_owned()
            .collect();
    let param = |name: &str| {
        params
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    let claims = settings
        .secret
        .as_deref()
        .zip(param("state"))
        .and_then(|(secret, token)| {
            payment_refs::verify(secret, token, payment_refs::CONNECT, now_secs())
        });
    let Some(claims) = claims else {
        return failure(None, "invalid_state");
    };
    // The return address was checked when the connection started; it is
    // signed, and checked again.
    let target = settings
        .app_url
        .as_deref()
        .zip(claims.r.as_deref())
        .and_then(|(app, wanted)| return_target(app, wanted));
    let target = target.as_deref();
    if let Some(error) = param("error") {
        let code = short_code(error);
        return failure(target, if code.is_empty() { "denied" } else { &code });
    }
    let Some(code) = param("code").filter(|c| !c.is_empty()) else {
        return failure(target, "missing_code");
    };
    let Ok(tenant) = tenant_of(&state, &parts, &claims.ws).await else {
        return failure(target, "workspace");
    };
    let (Some(app), Some(callback_url), Some(ctx)) = (
        settings.connect.as_ref(),
        settings.callback_url(),
        Ctx::new(&state.books, &tenant.db, None),
    ) else {
        return failure(target, "not_configured");
    };
    let tokens = match app.exchange_code(&ctx.http, code, &callback_url).await {
        Ok(tokens) => tokens,
        Err(error) => {
            tracing::warn!(%error, "[books/mollie] callback: Mollie refused the code");
            return failure(target, "token_exchange_failed");
        }
    };
    match store_oauth(&ctx, &tenant, &claims, &tokens).await {
        Ok(()) => match target {
            Some(target) => back(target, &[("mollie", "connected")]),
            None => status(StatusCode::OK),
        },
        Err(error) => {
            tracing::error!(%error, "[books/mollie] callback: the connection was not stored");
            failure(target, "store_failed")
        }
    }
}

/// Stores a connection made with Mollie Connect: the organisation and the
/// profile payments are made on (the live one, else the first), then what
/// follows every connection.
async fn store_oauth(
    ctx: &Ctx,
    tenant: &Tenant,
    claims: &PayRef,
    tokens: &Tokens,
) -> Result<(), PayError> {
    let mollie = Mollie::new(&ctx.settings.api_url, &tokens.access_token);
    let organization = mollie.organization(&ctx.http).await.ok();
    let profiles = mollie.profiles(&ctx.http).await.unwrap_or_default();
    let profile = profiles
        .iter()
        .find(|p| p.mode.as_deref() == Some("live"))
        .or_else(|| profiles.first());
    let row = connection::save(
        ctx,
        &NewConnection {
            entity_id: &claims.e,
            auth_method: "oauth",
            tokens: Some(tokens),
            api_key: None,
            testmode: profile.is_some_and(|p| p.mode.as_deref() == Some("test")),
            profile_id: profile.map(|p| p.id.as_str()),
            profile_name: profile.map(|p| p.name.as_str()),
            organization_id: organization.as_ref().map(|o| o.id.as_str()),
            organization_name: organization.as_ref().and_then(|o| o.name.as_deref()),
            methods: None,
            connected_by: claims.u.as_deref(),
        },
    )
    .await?;
    let event_workspace = tenant
        .clerk_org_id
        .clone()
        .unwrap_or_else(|| tenant.workspace_id.clone());
    let member = Caller::in_process(
        tenant.db.clone(),
        &tenant.workspace_id,
        &event_workspace,
        claims.u.as_deref().unwrap_or(""),
        &claims.e,
        Some(ctx.http.clone()),
    );
    finish_connect(ctx, &member, row).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mollie_payment_is_booked_under_one_id() {
        let id = booked_payment_id("tr_7UhSN1zuXS");
        assert_eq!(id, booked_payment_id("tr_7UhSN1zuXS"));
        assert_ne!(id, booked_payment_id("tr_other"));
        assert!(id.starts_with("pay_mol_") && id.len() <= 30);
    }

    #[test]
    fn the_method_decides_the_payment_method() {
        assert_eq!(payment_method(Some("creditcard")), "credit_card");
        assert_eq!(payment_method(Some("ideal")), "bank_transfer");
        assert_eq!(payment_method(Some("paypal")), "other");
        assert_eq!(payment_method(None), "other");
    }

    #[test]
    fn money_is_read_back_without_float_noise() {
        assert!((cents_to_amount(12100) - 121.0).abs() < f64::EPSILON);
        assert_eq!(to_amount_text(12105), "121.05");
        assert_eq!(to_amount_text(5), "0.05");
    }
}
