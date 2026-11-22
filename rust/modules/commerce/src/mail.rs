//! The shop's emails (phase 6): the sign-in code, a buyer's invitation, the
//! order confirmation, the approval request and its decision.
//!
//! They are system emails from `weldsuite-emails` (templates exported from
//! `@weldsuite/emails`), sent through the `SystemMail` port the project
//! portal's sign-in codes use on the Rust edition, from the install's system
//! address under the shop's (the channel's) name. Mail is best effort: a
//! failure is logged and never fails the request, and a server without a
//! transport sends nothing. Nothing that is in an email (a code, a link, an
//! address) is ever logged.
//!
//! Every send happens after the request's transaction committed and with no
//! connection held.

use std::sync::Arc;

use http::HeaderMap;
use serde_json::Value;
use weldsuite_emails::commerce::{
    ApprovalDecided, ApprovalRequested, BuyerInvitation, OrderConfirmation, OrderConfirmationLine,
    approval_decided, approval_requested, buyer_invitation, order_confirmation,
};
use weldsuite_emails::portal::{PortalSignIn, sign_in};
use weldsuite_emails::{
    EmailBrand, EmailError, EmailLocale, RenderedEmail, SystemEmail, send_system_email,
};
use weldsuite_kit::portal::signin::CODE_TTL_SECONDS;
use weldsuite_ports::DynSystemMail;

/// The transport, when the server has one.
pub(crate) type Mail = Option<Arc<dyn DynSystemMail>>;

/// The recipient's language: an explicit `en` or `nl`, else the request's
/// `Accept-Language`, else English.
pub(crate) fn locale(explicit: Option<&str>, headers: Option<&HeaderMap>) -> EmailLocale {
    let wants_dutch = |tag: &str| tag.trim().to_ascii_lowercase().starts_with("nl");
    if let Some(tag) = explicit.filter(|t| !t.trim().is_empty()) {
        return if wants_dutch(tag) {
            EmailLocale::Nl
        } else {
            EmailLocale::En
        };
    }
    let header = headers
        .and_then(|h| h.get(http::header::ACCEPT_LANGUAGE))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next());
    if header.is_some_and(wants_dutch) {
        EmailLocale::Nl
    } else {
        EmailLocale::En
    }
}

fn brand(shop: &str) -> EmailBrand {
    EmailBrand::Workspace {
        name: shop.to_owned(),
        logo_url: None,
        accent_color: None,
    }
}

/// Hand the rendered email to the transport; a failure is logged by kind.
async fn deliver(
    mail: &Mail,
    kind: &str,
    rendered: Result<RenderedEmail, EmailError>,
    shop: &str,
    to: &str,
) -> bool {
    let Some(transport) = mail else {
        return false;
    };
    if to.trim().is_empty() {
        return false;
    }
    let rendered = match rendered {
        Ok(rendered) => rendered,
        Err(error) => {
            tracing::warn!(%error, kind, "[commerce] an email could not be rendered");
            return false;
        }
    };
    let mut email = SystemEmail::to(rendered, brand(shop), to.trim());
    email.from_name = Some(shop.to_owned());
    match send_system_email(transport.as_ref(), email).await {
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(%error, kind, "[commerce] an email could not be sent");
            false
        }
    }
}

/// The sign-in code: a code, no link.
pub(crate) async fn code(mail: &Mail, shop: &str, to: &str, code: &str, locale: EmailLocale) {
    let rendered = sign_in(
        locale,
        &brand(shop),
        &PortalSignIn {
            portal_name: shop.to_owned(),
            code: code.to_owned(),
            url: None,
            expires_in_minutes: Some(u32::try_from(CODE_TTL_SECONDS / 60).unwrap_or(15)),
        },
    );
    deliver(mail, "sign-in code", rendered, shop, to).await;
}

/// A buyer's invitation; `shop_url` is the shop's home (no code or token).
pub(crate) async fn invitation(mail: &Mail, props: BuyerInvitation, to: &str, locale: EmailLocale) {
    let rendered = buyer_invitation(locale, &brand(&props.shop_name), &props);
    deliver(mail, "buyer invitation", rendered, &props.shop_name, to).await;
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The order confirmation, from the storefront's view of the order.
pub(crate) async fn confirmation(
    mail: &Mail,
    shop: &str,
    to: &str,
    order: &Value,
    order_url: Option<String>,
    locale: EmailLocale,
) {
    let lines = order
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| OrderConfirmationLine {
                    name: match text(item, "variantName") {
                        "" => text(item, "name").to_owned(),
                        variant => format!("{} ({variant})", text(item, "name")),
                    },
                    quantity: item.get("quantity").and_then(Value::as_i64).unwrap_or(0),
                    total: text(item, "total").to_owned(),
                })
                .collect()
        })
        .unwrap_or_default();
    let props = OrderConfirmation {
        shop_name: shop.to_owned(),
        order_number: text(order, "orderNumber").to_owned(),
        currency: text(order, "currency").to_owned(),
        lines,
        subtotal: text(order, "subtotal").to_owned(),
        shipping_total: text(order, "shippingTotal").to_owned(),
        tax_total: text(order, "taxTotal").to_owned(),
        total: text(order, "total").to_owned(),
        order_url,
        awaiting_approval: text(order, "approvalStatus") == "pending",
        on_invoice: text(order, "paymentStatus") == "on_invoice",
    };
    let rendered = order_confirmation(locale, &brand(shop), &props);
    deliver(mail, "order confirmation", rendered, shop, to).await;
}

/// An order waits for an approval (to an approver).
pub(crate) async fn approval_request(
    mail: &Mail,
    props: ApprovalRequested,
    to: &str,
    locale: EmailLocale,
) {
    let rendered = approval_requested(locale, &brand(&props.shop_name), &props);
    deliver(mail, "approval request", rendered, &props.shop_name, to).await;
}

/// The decision on an order (to the buyer).
pub(crate) async fn approval_decision(
    mail: &Mail,
    props: ApprovalDecided,
    to: &str,
    locale: EmailLocale,
) {
    let rendered = approval_decided(locale, &brand(&props.shop_name), &props);
    deliver(mail, "approval decision", rendered, &props.shop_name, to).await;
}

/// `https://…{orderId}…{token}…` filled in; `{token}` is empty for a
/// signed-in shopper. `None` without a template.
pub(crate) fn fill_order_url(
    template: Option<&str>,
    order_id: &str,
    token: &str,
) -> Option<String> {
    let encode =
        |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    template.map(|t| {
        t.replace("{orderId}", &encode(order_id))
            .replace("{token}", &encode(token))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_language_follows_the_request() {
        let mut headers = HeaderMap::new();
        assert_eq!(locale(None, Some(&headers)), EmailLocale::En);
        headers.insert(
            "accept-language",
            "nl-NL,nl;q=0.9,en;q=0.8".parse().expect("h"),
        );
        assert_eq!(locale(None, Some(&headers)), EmailLocale::Nl);
        assert_eq!(locale(Some("en"), Some(&headers)), EmailLocale::En);
        assert_eq!(locale(Some("NL"), None), EmailLocale::Nl);
        assert_eq!(locale(Some(""), None), EmailLocale::En);
    }

    #[test]
    fn an_order_url_is_filled_in() {
        assert_eq!(
            fill_order_url(
                Some("https://shop.test/o/{orderId}?t={token}"),
                "ord_1",
                "a b"
            ),
            Some("https://shop.test/o/ord_1?t=a+b".to_owned())
        );
        assert_eq!(
            fill_order_url(Some("https://shop.test/o/{orderId}?t={token}"), "ord_1", ""),
            Some("https://shop.test/o/ord_1?t=".to_owned())
        );
        assert_eq!(fill_order_url(None, "ord_1", "x"), None);
    }
}
