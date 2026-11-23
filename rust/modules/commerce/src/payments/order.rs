//! The payments of an order: `GET /api/orders/:id/payments`, the payment
//! link, refunds and the invoice (`orders:read` / `orders:update`).
//!
//! These routes are merged into the orders router. A refund and a payment
//! link call Mollie with no database connection held; whatever they change
//! is published as `order:updated` afterwards.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_catalogs::permission_keys::{ORDERS_READ, ORDERS_UPDATE};
use weldsuite_commerce_domain::payments::books::{self, Actor};
use weldsuite_commerce_domain::payments::service::{self, NewOrderPayment, NewRefund};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::orders;

use super::settle::{Settle, settle_after_apply, settle_created, settle_refund};
use super::{http, present_payment, present_refund, refuse};
use crate::wire::{body_or_empty, read_money, read_text};
use crate::{Caller, CommerceState, Refusal, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let update = || gate.require([ORDERS_UPDATE]);
    Router::new()
        .route(
            "/{id}/payments",
            get(list).route_layer(gate.require([ORDERS_READ])),
        )
        .route(
            "/{id}/payment-link",
            post(payment_link).route_layer(update()),
        )
        .route("/{id}/refunds", post(refund).route_layer(update()))
        .route("/{id}/invoice", post(invoice).route_layer(update()))
}

async fn order_exists(db: &PgPool, id: &str) -> Result<(), Refusal> {
    let found: Option<String> = orders::Entity::find_by_id(id)
        .select_only()
        .column(orders::Column::Id)
        .filter(orders::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    found
        .map(|_| ())
        .ok_or_else(|| Refusal::not_found("Order", id))
}

fn settle<'a>(state: &'a CommerceState, caller: &'a Caller) -> Settle<'a> {
    Settle {
        events: &state.events,
        ctx: &caller.events,
        db: &caller.db,
        config: &state.payments,
        workspace_id: &caller.workspace_id,
        user_id: &caller.user_id,
    }
}

async fn payments_and_refunds(
    db: &PgPool,
    id: &str,
) -> Result<Value, weldsuite_commerce_domain::DbErr> {
    let (payments, refunds) = service::list(db, id).await?;
    Ok(json!({
        "payments": payments.iter().map(present_payment).collect::<Vec<_>>(),
        "refunds": refunds.iter().map(present_refund).collect::<Vec<_>>(),
    }))
}

/// `GET /:id/payments`. A payment still open after a minute is read back from
/// Mollie first (on read only: nothing polls).
async fn list(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to fetch the payments of the order";
    let result = async {
        order_exists(&caller.db, &id).await?;
        if let Ok(http) = http(&state) {
            let env = state.payments.env(&caller.db, http);
            for payment in service::stale_open(&caller.db, &id).await? {
                match service::read_back(&env, &payment).await {
                    Ok(applied) => settle_after_apply(&settle(&state, &caller), &applied).await,
                    Err(error) => {
                        tracing::warn!(%error, "[commerce] a payment could not be read back");
                    }
                }
            }
        }
        Ok::<_, Refusal>(payments_and_refunds(&caller.db, &id).await?)
    }
    .await;
    match result {
        Ok(data) => Data(data).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// `POST /:id/payment-link`: a Mollie payment for what is outstanding.
async fn payment_link(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to create the payment link";
    let result = async {
        order_exists(&caller.db, &id).await?;
        let http = http(&state)?;
        let env = state.payments.env(&caller.db, http);
        let Some(public_url) = state.payments.public_url.as_deref() else {
            return Err(Refusal::from(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "PUBLIC_URL_NOT_CONFIGURED",
                "This install has no public URL for payment webhooks",
            )));
        };
        let app = state.payments.app_url.as_deref().unwrap_or(public_url);
        let redirect =
            weldsuite_mollie::with_query(&format!("{}/", app.trim_end_matches('/')), "order", &id)
                .unwrap_or_else(|| app.to_owned());
        let created = service::create_for_order(
            &env,
            &NewOrderPayment {
                order_id: &id,
                workspace_id: &caller.workspace_id,
                redirect_url: &redirect,
                public_url,
                locale: None,
            },
        )
        .await
        .map_err(refuse)?;
        Ok::<_, Refusal>(created)
    }
    .await;
    match result {
        Ok(payment) => {
            settle_created(&settle(&state, &caller), &id).await;
            Created(present_payment(&payment)).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// `POST /:id/refunds`: `{ amount, reason?, paymentId? }`.
async fn refund(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to refund the order";
    let (headers, body) = body_or_empty(&headers, &body);
    let (amount, reason, payment_id) = match validate(&headers, &body, |issues, fields| {
        (
            read_money(issues, fields, "amount", Presence::Required).into_option(),
            read_text(issues, fields, "reason", 500).into_option(),
            issues
                .text_with(
                    fields,
                    "paymentId",
                    Presence::Optional,
                    Text::trimmed(Some(1), Some(30)),
                )
                .into_option(),
        )
    }) {
        Ok((Some(amount), reason, payment_id)) => (amount, reason, payment_id),
        Ok(_) => return Refusal::from(ApiError::internal()).respond(FAILED),
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        order_exists(&caller.db, &id).await?;
        let http = http(&state)?;
        let env = state.payments.env(&caller.db, http);
        service::refund(
            &env,
            &NewRefund {
                order_id: &id,
                amount,
                reason: reason.as_deref(),
                payment_id: payment_id.as_deref(),
                created_by: &caller.user_id,
            },
        )
        .await
        .map_err(refuse)
    }
    .await;
    match result {
        Ok(made) => {
            settle_refund(&settle(&state, &caller), &made).await;
            // The credit note, when it was made, is on the refund now.
            let row = service::list(&caller.db, &id)
                .await
                .ok()
                .and_then(|(_, refunds)| refunds.into_iter().find(|r| r["id"] == made.refund["id"]))
                .unwrap_or(made.refund);
            Created(present_refund(&row)).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// `POST /:id/invoice`: runs the invoicing again (an invoice for a paid
/// order, or the unpaid one of an order on invoice) and the credit notes of
/// refunds still waiting for one.
async fn invoice(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to create the invoice";
    let result = async {
        let or = |column: orders::Column, fallback: &str| {
            Expr::from(Func::coalesce([
                Expr::col((orders::Entity, column)),
                Expr::val(fallback),
            ]))
        };
        let row: Option<(String, String)> = orders::Entity::find_by_id(id.as_str())
            .select_only()
            .column_as(or(orders::Column::PaymentStatus, "pending"), "payment_status")
            .column_as(
                or(orders::Column::ApprovalStatus, "not_required"),
                "approval_status",
            )
            .filter(orders::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
            .await?;
        let (status, approval) = row.ok_or_else(|| Refusal::not_found("Order", &id))?;
        // An order waiting for approval is held from invoicing (as from
        // WeldStash); a rejected one was cancelled.
        match approval.as_str() {
            "pending" => {
                return Err(Refusal::from(ApiError::new(
                    StatusCode::CONFLICT,
                    "APPROVAL_PENDING",
                    "The order is waiting for approval and cannot move on yet",
                )));
            }
            "rejected" => {
                return Err(Refusal::from(ApiError::new(
                    StatusCode::CONFLICT,
                    "ORDER_NOT_INVOICEABLE",
                    "A rejected order is not invoiced",
                )));
            }
            _ => {}
        }
        let paid = weldsuite_commerce_domain::status::is_paid(&status);
        if !paid && status != "on_invoice" {
            return Err(Refusal::from(ApiError::new(
                StatusCode::CONFLICT,
                "ORDER_NOT_INVOICEABLE",
                "Only a paid order or an order on invoice can be invoiced",
            )));
        }
        let Some(invoicing) = state.payments.invoicing.as_ref() else {
            return Err(Refusal::from(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "INVOICING_UNAVAILABLE",
                "WeldBooks is not available on this server",
            )));
        };
        let actor = Actor {
            db: &caller.db,
            workspace_id: &caller.workspace_id,
            clerk_org_id: Some(&caller.events.workspace_id),
            user_id: &caller.user_id,
        };
        let made = books::invoice_order(invoicing.as_ref(), actor, &id, paid, true)
            .await
            .map_err(|message| {
                Refusal::from(ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    "INVOICE_FAILED",
                    message,
                ))
            })?
            .ok_or_else(|| Refusal::from(ApiError::internal()))?;
        // Refunds that were paid back without a credit note.
        let (_, refunds) = service::list(&caller.db, &id).await?;
        for refund in refunds
            .iter()
            .filter(|r| r["status"] == "refunded" && r["creditNoteId"].is_null())
        {
            let refund_id = refund["id"].as_str().unwrap_or_default();
            books::credit_refund(invoicing.as_ref(), actor, refund_id, true)
                .await
                .map_err(|message| {
                    Refusal::from(ApiError::new(
                        StatusCode::BAD_GATEWAY,
                        "INVOICE_FAILED",
                        message,
                    ))
                })?;
        }
        Ok::<_, Refusal>(made)
    }
    .await;
    match result {
        Ok(made) => {
            settle_created(&settle(&state, &caller), &id).await;
            Data(json!({ "id": made.id, "number": made.number, "status": made.status }))
                .into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}
