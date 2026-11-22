//! What follows a payment's state being applied, after its transaction
//! committed: the entity events, and WeldBooks.
//!
//! - the first `paid` read: `order:paid`, then the invoice (a finalised
//!   invoice with the payment recorded);
//! - each refund that reached `refunded`: `order:refunded`, then the credit
//!   note;
//! - any change to the order: `order:updated`.
//!
//! WeldBooks failures never undo a payment: the domain keeps the message on
//! the order (`metadata.invoiceError`) and the invoice route runs it again.

use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{ORDER_PAID, ORDER_REFUNDED, ORDER_UPDATED};
use weldsuite_commerce_domain::payments::books::{self, Actor};
use weldsuite_commerce_domain::payments::service::{Applied, Refunded};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};

use crate::config::PaymentsConfig;

/// Who the effects are for.
pub(crate) struct Settle<'a> {
    pub(crate) events: &'a EntityEventPublisher,
    pub(crate) ctx: &'a EventContext,
    pub(crate) db: &'a PgPool,
    pub(crate) config: &'a PaymentsConfig,
    /// `workspaces.id`.
    pub(crate) workspace_id: &'a str,
    /// The staff member, or `system` for a webhook.
    pub(crate) user_id: &'a str,
}

impl Settle<'_> {
    fn actor(&self) -> Actor<'_> {
        Actor {
            db: self.db,
            workspace_id: self.workspace_id,
            // The id events carry: the org id where there is one.
            clerk_org_id: Some(&self.ctx.workspace_id),
            user_id: self.user_id,
        }
    }

    fn publish(&self, event: weldsuite_catalogs::entity_events::EventName, id: &str, data: &Value) {
        publish_entity_event(self.events, self.ctx, event, id, data);
    }

    async fn order_data(&self, order_id: &str) -> Value {
        match crate::orders::fetch(self.db, order_id).await {
            Ok(Some(order)) => crate::orders::event(&order),
            Ok(None) => json!({ "id": order_id }),
            Err(error) => {
                tracing::error!(%error, order_id, "[commerce] could not read the order for its event");
                json!({ "id": order_id })
            }
        }
    }

    async fn invoice(&self, order_id: &str) {
        if let Some(invoicing) = &self.config.invoicing {
            // The failure is kept on the order; nothing more to do here.
            let _ =
                books::invoice_order(invoicing.as_ref(), self.actor(), order_id, true, false).await;
        }
    }

    async fn credit(&self, refund_id: &str) {
        if let Some(invoicing) = &self.config.invoicing {
            let _ = books::credit_refund(invoicing.as_ref(), self.actor(), refund_id, false).await;
        }
    }
}

/// Effects of a read-back or webhook.
pub(crate) async fn settle_after_apply(settle: &Settle<'_>, applied: &Applied) {
    let changed = applied.order_changed || applied.status_changed;
    if !changed && !applied.newly_paid && applied.refunds_completed.is_empty() {
        return;
    }
    let order_id = applied.order_id.as_str();
    let data = settle.order_data(order_id).await;
    if applied.newly_paid {
        settle.publish(ORDER_PAID, order_id, &data);
        settle.invoice(order_id).await;
    }
    for refund_id in &applied.refunds_completed {
        let mut refunded = data.clone();
        refunded["refundId"] = json!(refund_id);
        settle.publish(ORDER_REFUNDED, order_id, &refunded);
        settle.credit(refund_id).await;
    }
    if changed {
        // Once invoicing ran the order has moved on: read it again.
        let data = settle.order_data(order_id).await;
        settle.publish(ORDER_UPDATED, order_id, &data);
    }
}

/// Effects of a refund made by staff.
pub(crate) async fn settle_refund(settle: &Settle<'_>, made: &Refunded) {
    let order_id = made.order_id.as_str();
    let data = settle.order_data(order_id).await;
    if made.completed {
        let refund_id = made.refund["id"].as_str().unwrap_or_default();
        let mut refunded = data.clone();
        refunded["refundId"] = json!(refund_id);
        settle.publish(ORDER_REFUNDED, order_id, &refunded);
        settle.credit(refund_id).await;
    }
    let data = settle.order_data(order_id).await;
    settle.publish(ORDER_UPDATED, order_id, &data);
}

/// Effects of a payment created for an order (a payment link, a retry).
pub(crate) async fn settle_created(settle: &Settle<'_>, order_id: &str) {
    let data = settle.order_data(order_id).await;
    settle.publish(ORDER_UPDATED, order_id, &data);
}
