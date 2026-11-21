//! B2B on the storefront (ADR COM-012): the approvals of a company's
//! approvers and admins, and a company admin's buyers.
//!
//! Everything works on the company the shopper is signed in for (their
//! active company). A buyer is shown as the staff API shows it (`Buyer`).

#![allow(
    clippy::result_large_err,
    clippy::option_option,
    reason = "a refusal is the response to send; a patch field is absent, null or a value"
)]

use axum::Extension;
use axum::body::Bytes;
use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    COMMERCE_BUYER_CREATED, COMMERCE_BUYER_DELETED, COMMERCE_BUYER_INVITED, COMMERCE_BUYER_UPDATED,
};
use weldsuite_commerce_domain::accounts::{self, BuyerPatch, NewBuyer};
use weldsuite_commerce_domain::approvals::{self, Decider};
use weldsuite_commerce_domain::checkout;
use weldsuite_commerce_domain::money;
use weldsuite_emails::commerce::BuyerInvitation;
use weldsuite_events::publish_entity_event;

use super::shopper::{self, Loaded};
use super::{Principal, body_object, created, data, domain, fail, internal, validation};
use crate::decide::{self, Followup};
use crate::mail;

fn forbidden(code: &'static str, message: &str) -> Response {
    fail(StatusCode::FORBIDDEN, code, message, None)
}

#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
fn approver(loaded: &Loaded) -> Result<&str, Response> {
    match loaded.active.as_ref() {
        Some(m) if matches!(m.role.as_str(), "approver" | "admin") => Ok(m.company_id.as_str()),
        _ => Err(forbidden(
            "NOT_AN_APPROVER",
            "You cannot approve orders of this company",
        )),
    }
}

#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
fn admin(loaded: &Loaded) -> Result<&str, Response> {
    match loaded.active.as_ref() {
        Some(m) if m.role == "admin" => Ok(m.company_id.as_str()),
        _ => Err(forbidden(
            "NOT_AN_ADMIN",
            "Only an admin of the company can manage its buyers",
        )),
    }
}

/// `GET /account/approvals`: the active company's orders waiting for a decision.
pub(crate) async fn approvals(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    let loaded = match shopper::require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let company = match approver(&loaded) {
        Ok(company) => company.to_owned(),
        Err(response) => return response,
    };
    let found = async {
        let mut conn = principal.db.acquire().await?;
        let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "select o.id, a.reason, a.requested_by_person_id from order_approvals a \
             join orders o on o.id = a.order_id join parties pa on pa.id = o.counterparty_id \
             where a.decision = 'pending' and pa.company_id = $1 and o.channel_id = $2 \
               and o.deleted_at is null order by a.created_at desc, a.id desc",
        )
        .bind(&company)
        .bind(&principal.channel.id)
        .fetch_all(&mut *conn)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for (order_id, reason, requested) in rows {
            let order = checkout::order_view(&mut conn, &order_id).await?;
            let by = match requested {
                Some(person) => accounts::person(&mut conn, &person).await?,
                None => None,
            };
            out.push(json!({
                "order": order,
                "reason": reason,
                "requestedBy": by.map(|p| json!({ "personId": p.id, "name": p.display() })),
            }));
        }
        Ok::<_, weldsuite_commerce_domain::Error>(out)
    }
    .await;
    match found {
        Ok(list) => data(Value::Array(list)),
        Err(error) => internal(&error, "The approvals could not be read"),
    }
}

fn comment_of(body: &serde_json::Map<String, Value>) -> Result<Option<String>, Response> {
    match body.get("comment") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.chars().count() <= 2000 => {
            Ok(Some(text.trim().to_owned()).filter(|t| !t.is_empty()))
        }
        _ => Err(validation(&[(
            "comment".to_owned(),
            "Must be text of at most 2000 characters".to_owned(),
        )])),
    }
}

async fn decide_order(
    principal: Principal,
    headers: HeaderMap,
    order_id: String,
    body: Bytes,
    approve: bool,
) -> Response {
    let loaded = match shopper::require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let comment = match comment_of(&body) {
        Ok(comment) => comment,
        Err(response) => return response,
    };
    // The order must be on this channel and a company the shopper approves for.
    let decided = async {
        let mut tx = principal.db.begin().await?;
        let company: Option<Option<String>> = sqlx::query_scalar(
            "select pa.company_id from orders o left join parties pa on pa.id = o.counterparty_id \
             where o.id = $1 and o.channel_id = $2 and o.deleted_at is null",
        )
        .bind(&order_id)
        .bind(&principal.channel.id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(company) = company else {
            return Ok(Err(None));
        };
        let allowed = loaded.companies.iter().any(|m| {
            Some(&m.company_id) == company.as_ref()
                && matches!(m.role.as_str(), "approver" | "admin")
        });
        if !allowed {
            return Ok(Err(Some(weldsuite_commerce_domain::Error::NotAnApprover)));
        }
        let by = Decider {
            person_id: Some(&loaded.person.id),
            staff: None,
        };
        match approvals::decide(&mut tx, &order_id, approve, comment.as_deref(), &by).await {
            Ok(decided) => {
                tx.commit().await?;
                Ok(Ok(decided))
            }
            Err(error @ weldsuite_commerce_domain::Error::Database(_)) => Err(error),
            Err(error) => Ok(Err(Some(error))),
        }
    }
    .await;
    let decided = match decided {
        Ok(Ok(decided)) => decided,
        Ok(Err(None)) => {
            return fail(StatusCode::NOT_FOUND, "NOT_FOUND", "Order not found", None);
        }
        Ok(Err(Some(error))) => return domain(error),
        Err(error) => return internal(&error, "The decision could not be saved"),
    };
    let name = loaded.person.display();
    let follow = Followup {
        db: &principal.db,
        events: &principal.state.events,
        ctx: &principal.events,
        config: &principal.state.payments,
        http: principal.state.http.as_ref(),
        mail: &principal.state.mail,
        workspace_id: &principal.workspace_id,
        user_id: "storefront",
        locale: mail::locale(None, Some(&headers)),
    };
    let payment = decide::after_decision(&follow, &decided, comment.as_deref(), Some(&name)).await;
    let view = async {
        let mut conn = principal
            .db
            .acquire()
            .await
            .map_err(weldsuite_commerce_domain::db::from_sqlx)?;
        checkout::order_view(&mut conn, &order_id).await
    }
    .await;
    match view {
        Ok(mut order) => {
            order["payment"] = payment.map_or(Value::Null, |p| {
                json!({ "id": p["id"], "status": p["status"], "checkoutUrl": p["checkoutUrl"] })
            });
            data(order)
        }
        Err(error) => internal(&error, "The order could not be read"),
    }
}

/// `POST /account/approvals/:orderId/approve`.
pub(crate) async fn approve(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(order_id): Path<String>,
    body: Bytes,
) -> Response {
    decide_order(principal, headers, order_id, body, true).await
}

/// `POST /account/approvals/:orderId/reject`.
pub(crate) async fn reject(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(order_id): Path<String>,
    body: Bytes,
) -> Response {
    decide_order(principal, headers, order_id, body, false).await
}

// ── buyers ──────────────────────────────────────────────────────────────────

/// `GET /account/buyers`.
pub(crate) async fn buyers(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    let loaded = match shopper::require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let company = match admin(&loaded) {
        Ok(company) => company.to_owned(),
        Err(response) => return response,
    };
    let list = async {
        let mut conn = principal.db.acquire().await?;
        accounts::buyers(&mut conn, Some(&company), None).await
    }
    .await;
    match list {
        Ok(list) => data(Value::Array(list)),
        Err(error) => internal(&error, "The buyers could not be read"),
    }
}

fn limit_of(
    body: &serde_json::Map<String, Value>,
    currency: &str,
) -> Result<Option<Option<(money::Cents, String)>>, Response> {
    match body.get("spendLimit") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(text)) => match money::parse(text) {
            Some(amount) => Ok(Some(Some((amount, currency.to_owned())))),
            None => Err(validation(&[(
                "spendLimit".to_owned(),
                "Must be an amount like 500.00".to_owned(),
            )])),
        },
        Some(_) => Err(validation(&[(
            "spendLimit".to_owned(),
            "Must be an amount like 500.00 or null".to_owned(),
        )])),
    }
}

fn name_of(body: &serde_json::Map<String, Value>, key: &str) -> Result<Option<String>, Response> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.chars().count() <= 100 => {
            Ok(Some(text.trim().to_owned()).filter(|t| !t.is_empty()))
        }
        _ => Err(validation(&[(
            key.to_owned(),
            "Must be text of at most 100 characters".to_owned(),
        )])),
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "check the body, add the buyer, publish, invite"
)]
/// `POST /account/buyers`: a person is found or made, linked to the company,
/// and invited by email.
pub(crate) async fn add_buyer(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let loaded = match shopper::require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let company = match admin(&loaded) {
        Ok(company) => company.to_owned(),
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let email = match body.get("email").and_then(Value::as_str).map(str::trim) {
        Some(email)
            if email.len() <= 255
                && email.split_once('@').is_some_and(|(l, d)| {
                    !l.is_empty() && d.contains('.') && !email.contains(char::is_whitespace)
                }) =>
        {
            email.to_lowercase()
        }
        _ => {
            return validation(&[("email".to_owned(), "Must be an email address".to_owned())]);
        }
    };
    let role = body
        .get("role")
        .and_then(Value::as_str)
        .filter(|r| accounts::ROLES.contains(r))
        .map(str::to_owned);
    let Some(role) = role else {
        return validation(&[(
            "role".to_owned(),
            "Must be buyer, approver or admin".to_owned(),
        )]);
    };
    let (first, last) = match (name_of(&body, "firstName"), name_of(&body, "lastName")) {
        (Ok(first), Ok(last)) => (first, last),
        (Err(response), _) | (_, Err(response)) => return response,
    };
    let limit = match limit_of(&body, &principal.channel.currency) {
        Ok(limit) => limit.flatten(),
        Err(response) => return response,
    };
    let made = async {
        let mut tx = principal.db.begin().await?;
        let result = accounts::create_buyer(
            &mut tx,
            &NewBuyer {
                company_id: &company,
                email: &email,
                first_name: first.as_deref(),
                last_name: last.as_deref(),
                role: &role,
                spend_limit: limit.as_ref().map(|(amount, _)| *amount),
                spend_limit_currency: limit.as_ref().map(|(_, c)| c.as_str()),
                invited_by: &loaded.person.id,
            },
        )
        .await;
        match result {
            Ok(buyer) => {
                tx.commit().await?;
                Ok(Ok(buyer))
            }
            Err(error @ weldsuite_commerce_domain::Error::Database(_)) => Err(error),
            Err(error) => Ok(Err(error)),
        }
    }
    .await;
    let buyer = match made {
        Ok(Ok(buyer)) => buyer,
        Ok(Err(error)) => return domain(error),
        Err(error) => return internal(&error, "The buyer could not be added"),
    };
    let id = buyer["id"].as_str().unwrap_or_default().to_owned();
    for event in [COMMERCE_BUYER_CREATED, COMMERCE_BUYER_INVITED] {
        publish_entity_event(
            &principal.state.events,
            &principal.events,
            event,
            id.clone(),
            &buyer_event(&buyer),
        );
    }
    let company_name = loaded
        .active
        .as_ref()
        .map(|m| m.name.clone())
        .unwrap_or_default();
    let inviter = loaded.person.display();
    mail::invitation(
        &principal.state.mail,
        BuyerInvitation {
            shop_name: principal.channel.name.clone(),
            company_name,
            inviter_name: Some(inviter),
            role: role.clone(),
            shop_url: decide::shop_url(&principal.db, &principal.channel.id).await,
        },
        &email,
        mail::locale(None, Some(&headers)),
    )
    .await;
    created(buyer)
}

/// The event data of a buyer: never a code, session or token.
pub(crate) fn buyer_event(buyer: &Value) -> Value {
    json!({
        "id": buyer["id"],
        "personId": buyer["personId"],
        "companyId": buyer["companyId"],
        "role": buyer["role"],
        "status": buyer["status"],
    })
}

/// A buyer of the shopper's company, or a 404.
async fn own_buyer(principal: &Principal, company: &str, id: &str) -> Result<bool, sqlx::Error> {
    let mut conn = principal.db.acquire().await?;
    let found = accounts::buyer(&mut conn, id).await?;
    Ok(found.is_some_and(|b| b["companyId"].as_str() == Some(company)))
}

/// `PATCH /account/buyers/:buyerId`.
pub(crate) async fn patch_buyer(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(buyer_id): Path<String>,
    body: Bytes,
) -> Response {
    let loaded = match shopper::require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let company = match admin(&loaded) {
        Ok(company) => company.to_owned(),
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let limit = match limit_of(&body, &principal.channel.currency) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let patch = BuyerPatch {
        role: body.get("role").and_then(Value::as_str).map(str::to_owned),
        spend_limit: limit,
        status: body
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    match own_buyer(&principal, &company, &buyer_id).await {
        Ok(true) => {}
        Ok(false) => return fail(StatusCode::NOT_FOUND, "NOT_FOUND", "Buyer not found", None),
        Err(error) => return internal(&error, "The buyer could not be read"),
    }
    let done = async {
        let mut tx = principal.db.begin().await?;
        match accounts::update_buyer(&mut tx, &buyer_id, &patch, true).await {
            Ok(buyer) => {
                tx.commit().await?;
                Ok(Ok(buyer))
            }
            Err(error @ weldsuite_commerce_domain::Error::Database(_)) => Err(error),
            Err(error) => Ok(Err(error)),
        }
    }
    .await;
    match done {
        Ok(Ok(buyer)) => {
            publish_entity_event(
                &principal.state.events,
                &principal.events,
                COMMERCE_BUYER_UPDATED,
                buyer_id,
                &buyer_event(&buyer),
            );
            data(buyer)
        }
        Ok(Err(error)) => domain(error),
        Err(error) => internal(&error, "The buyer could not be changed"),
    }
}

/// `DELETE /account/buyers/:buyerId`.
pub(crate) async fn remove_buyer(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(buyer_id): Path<String>,
) -> Response {
    let loaded = match shopper::require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let company = match admin(&loaded) {
        Ok(company) => company.to_owned(),
        Err(response) => return response,
    };
    match own_buyer(&principal, &company, &buyer_id).await {
        Ok(true) => {}
        Ok(false) => return fail(StatusCode::NOT_FOUND, "NOT_FOUND", "Buyer not found", None),
        Err(error) => return internal(&error, "The buyer could not be read"),
    }
    let done = async {
        let mut tx = principal.db.begin().await?;
        match accounts::delete_buyer(&mut tx, &buyer_id, true).await {
            Ok(buyer) => {
                tx.commit().await?;
                Ok(Ok(buyer))
            }
            Err(error @ weldsuite_commerce_domain::Error::Database(_)) => Err(error),
            Err(error) => Ok(Err(error)),
        }
    }
    .await;
    match done {
        Ok(Ok(buyer)) => {
            publish_entity_event(
                &principal.state.events,
                &principal.events,
                COMMERCE_BUYER_DELETED,
                buyer_id,
                &buyer_event(&buyer),
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Err(error)) => domain(error),
        Err(error) => internal(&error, "The buyer could not be removed"),
    }
}
