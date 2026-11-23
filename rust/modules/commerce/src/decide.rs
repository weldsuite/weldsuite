//! What follows an approval decision (ADR COM-012), after the decision's
//! transaction committed and with no connection held: the entity events,
//! the order's release (an order on invoice becomes a finalised WeldBooks
//! invoice, an order to be paid by Mollie gets its payment) and the emails.
//!
//! Both the storefront's approvers and staff end up here.

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    ORDER_APPROVED, ORDER_CANCELLED, ORDER_REJECTED, ORDER_UPDATED,
};
use weldsuite_commerce_domain::accounts;
use weldsuite_commerce_domain::approvals::Decided;
use weldsuite_commerce_domain::payments::books::{self, Actor};
use weldsuite_commerce_domain::payments::service::{self, NewOrderPayment};
use weldsuite_db::{OrmConn, PgPool, orm};
use weldsuite_emails::commerce::{ApprovalDecided, ApprovalRequested};
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::{commerce_channel_keys, commerce_channels, companies};

use crate::args::{first_origin, has_origin};
use crate::config::PaymentsConfig;
use crate::mail::{self, Mail};

/// What the follow-up needs.
pub(crate) struct Followup<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) events: &'a EntityEventPublisher,
    pub(crate) ctx: &'a EventContext,
    pub(crate) config: &'a PaymentsConfig,
    pub(crate) http: Option<&'a OutboundHttp>,
    pub(crate) mail: &'a Mail,
    /// `workspaces.id`.
    pub(crate) workspace_id: &'a str,
    /// The staff member, or `storefront` for a company approver.
    pub(crate) user_id: &'a str,
    pub(crate) locale: weldsuite_emails::EmailLocale,
}

impl Followup<'_> {
    fn publish(&self, event: weldsuite_catalogs::entity_events::EventName, id: &str, data: &Value) {
        publish_entity_event(self.events, self.ctx, event, id, data);
    }

    async fn order(&self, id: &str) -> Value {
        match crate::orders::fetch(self.db, id).await {
            Ok(Some(order)) => order,
            Ok(None) => json!({ "id": id }),
            Err(error) => {
                tracing::error!(%error, order_id = id, "[commerce] could not read the order");
                json!({ "id": id })
            }
        }
    }

    /// The shop's name: the order's channel.
    async fn shop_name(&self, channel_id: Option<&str>) -> String {
        let Some(channel) = channel_id else {
            return "Shop".to_owned();
        };
        commerce_channels::Entity::find_by_id(channel)
            .select_only()
            .column(commerce_channels::Column::Name)
            .into_tuple::<String>()
            .one(&orm(self.db))
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "Shop".to_owned())
    }

    /// The buyer to tell: the person who placed the order, else the order's
    /// email.
    async fn buyer_email(&self, decided: &Decided, order: &Value) -> Option<String> {
        if let Some(person) = &decided.requested_by_person_id
            && let Ok(mut conn) = self.db.acquire().await
            && let Ok(Some(found)) = accounts::person(&mut conn, person).await
            && !found.email.is_empty()
        {
            return Some(found.email);
        }
        order
            .get("customerEmail")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// The Mollie payment of an approved order, when it is to be paid there.
    async fn start_payment(&self, decided: &Decided) -> Option<Value> {
        let http = self.http?;
        let public_url = self.config.public_url.as_deref()?;
        let redirect = decided.redirect_url.as_deref()?;
        let redirect = weldsuite_mollie::with_query(redirect, "order", &decided.order_id)
            .unwrap_or_else(|| redirect.to_owned());
        let env = self.config.env(self.db, http);
        match service::create_for_order(
            &env,
            &NewOrderPayment {
                order_id: &decided.order_id,
                workspace_id: self.workspace_id,
                redirect_url: &redirect,
                public_url,
                locale: None,
            },
        )
        .await
        {
            Ok(payment) => Some(payment),
            Err(error) => {
                // The order stays `pending`; a payment link can be made again.
                tracing::warn!(%error, order_id = %decided.order_id, "[commerce] the payment of an approved order could not be started");
                None
            }
        }
    }

    async fn invoice(&self, order_id: &str) {
        if let Some(invoicing) = &self.config.invoicing {
            let actor = Actor {
                db: self.db,
                workspace_id: self.workspace_id,
                clerk_org_id: Some(&self.ctx.workspace_id),
                user_id: self.user_id,
            };
            // A failure is kept on the order (`metadata.invoiceError`).
            let _ = books::invoice_order(invoicing.as_ref(), actor, order_id, false, false).await;
        }
    }
}

/// Events, release and emails after `decided` was committed; the payment
/// that was started for the buyer, if any.
pub(crate) async fn after_decision(
    follow: &Followup<'_>,
    decided: &Decided,
    comment: Option<&str>,
    decided_by: Option<&str>,
) -> Option<Value> {
    let mut payment = None;
    if decided.approved {
        match decided.payment_method.as_deref() {
            Some("invoice") => follow.invoice(&decided.order_id).await,
            _ => payment = follow.start_payment(decided).await,
        }
    }
    let order = follow.order(&decided.order_id).await;
    let data = crate::orders::event(&order);
    let id = decided.order_id.as_str();
    follow.publish(
        if decided.approved {
            ORDER_APPROVED
        } else {
            ORDER_REJECTED
        },
        id,
        &data,
    );
    if !decided.approved {
        follow.publish(ORDER_CANCELLED, id, &data);
    }
    follow.publish(ORDER_UPDATED, id, &data);

    let shop = follow
        .shop_name(order.get("channelId").and_then(Value::as_str))
        .await;
    if let Some(to) = follow.buyer_email(decided, &order).await {
        let props = ApprovalDecided {
            shop_name: shop,
            order_number: decided.order_number.clone(),
            currency: order["currency"].as_str().unwrap_or_default().to_owned(),
            total: order["total"].as_str().unwrap_or_default().to_owned(),
            approved: decided.approved,
            decided_by: decided_by.map(str::to_owned),
            comment: comment.map(str::to_owned),
            payment_url: payment
                .as_ref()
                .and_then(|p| p["checkoutUrl"].as_str())
                .map(str::to_owned),
        };
        mail::approval_decision(follow.mail, props, &to, follow.locale).await;
    }
    payment
}

/// Tell the company's approvers an order waits for them (not the buyer who
/// placed it, unless nobody else can approve).
#[allow(
    clippy::too_many_arguments,
    reason = "who to tell, about which order, in which language"
)]
pub(crate) async fn notify_approvers(
    db: &PgPool,
    mail: &Mail,
    shop: &str,
    company_id: &str,
    requested_by: Option<&str>,
    order: &Value,
    reason: &str,
    locale: weldsuite_emails::EmailLocale,
) {
    if mail.is_none() {
        return;
    }
    let Ok(mut conn) = db.acquire().await else {
        return;
    };
    let approvers = accounts::approvers(&mut conn, company_id)
        .await
        .unwrap_or_default();
    let company: Option<String> = companies::Entity::find_by_id(company_id)
        .select_only()
        .column(companies::Column::DisplayName)
        .into_tuple()
        .one(&OrmConn::new(&mut conn))
        .await
        .ok()
        .flatten();
    let requester: Option<String> = match requested_by {
        Some(person) => accounts::person(&mut conn, person)
            .await
            .ok()
            .flatten()
            .map(|p| p.display()),
        None => None,
    };
    drop(conn);
    let others: Vec<_> = approvers
        .iter()
        .filter(|(id, _, _)| Some(id.as_str()) != requested_by)
        .collect();
    let recipients = if others.is_empty() {
        approvers.iter().collect()
    } else {
        others
    };
    for (_, email, _) in recipients {
        let props = ApprovalRequested {
            shop_name: shop.to_owned(),
            order_number: order["orderNumber"].as_str().unwrap_or_default().to_owned(),
            currency: order["currency"].as_str().unwrap_or_default().to_owned(),
            total: order["total"].as_str().unwrap_or_default().to_owned(),
            requested_by: requester.clone().unwrap_or_default(),
            company_name: company.clone(),
            reason: reason.to_owned(),
            shop_url: None,
        };
        mail::approval_request(mail, props, email, locale).await;
    }
}

/// The shop's home, for the links in its emails: the first origin a live
/// publishable key of the channel allows. No code or token is ever in it.
pub(crate) async fn shop_url(db: &PgPool, channel_id: &str) -> Option<String> {
    let origin: Option<Option<String>> = commerce_channel_keys::Entity::find()
        .select_only()
        .column_as(first_origin(commerce_channel_keys::Entity), "origin")
        .filter(commerce_channel_keys::Column::ChannelId.eq(channel_id))
        .filter(has_origin(commerce_channel_keys::Entity))
        .order_by_asc(commerce_channel_keys::Column::CreatedAt)
        .order_by_asc(commerce_channel_keys::Column::Id)
        .into_tuple()
        .one(&orm(db))
        .await
        .ok()
        .flatten();
    origin.flatten()
}
