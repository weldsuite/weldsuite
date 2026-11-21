//! WeldCommerce's emails (`packages/core/emails/src/templates/commerce/`): a
//! company gives a buyer access (`commerce.buyer-invitation`), the buyer's
//! copy of an order (`commerce.order-confirmation`) and the two approval
//! mails (`commerce.approval-requested`, `commerce.approval-decided`).
//!
//! The recipients are outside the workspace, so callers pass the workspace
//! brand with the shop's name. Each function takes the template's props,
//! picks the variant its React component would render and fills it in. The
//! role and the reason are enums in the component; here each value is a flag
//! of the variant (`role_approver`, `role_admin`, `reason_company`), and an
//! unknown value counts as the first one (`buyer`, `buyer_limit`).

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// `value?.trim()`, with an empty result counting as absent.
fn trimmed(value: Option<&str>) -> Option<&str> {
    value
        .map(|v| v.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'))
        .filter(|v| !v.is_empty())
}

fn put(values: &mut BTreeMap<String, Value>, key: &str, value: &str) {
    values.insert(key.to_owned(), Value::from(value));
}

/// `CommerceBuyerInvitationEmailProps`.
#[derive(Debug, Clone, Default)]
pub struct BuyerInvitation {
    pub shop_name: String,
    pub company_name: String,
    /// The person who gave the access; without one the email names nobody.
    pub inviter_name: Option<String>,
    /// `buyer`, `approver` or `admin`.
    pub role: String,
    /// Absolute link to the shop; without one the email has no button.
    pub shop_url: Option<String>,
}

/// Render `commerce.buyer-invitation`.
pub fn buyer_invitation(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &BuyerInvitation,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    put(&mut values, "shop_name", &props.shop_name);
    put(&mut values, "company_name", &props.company_name);
    // `props.inviterName?.trim()`
    if let Some(name) = trimmed(props.inviter_name.as_deref()) {
        flags.push("inviter");
        put(&mut values, "inviter_name", name);
    }
    // `props.shopUrl?.trim() || undefined`
    if let Some(url) = trimmed(props.shop_url.as_deref()) {
        flags.push("url");
        put(&mut values, "shop_url", url);
    }
    match props.role.as_str() {
        "approver" => flags.push("role_approver"),
        "admin" => flags.push("role_admin"),
        _ => {}
    }
    render("commerce.buyer-invitation", locale, brand, &flags, values)
}

/// One line of an order (`{ name, quantity, total }`); `total` is a plain
/// decimal string such as `19.99`.
#[derive(Debug, Clone, Default)]
pub struct OrderConfirmationLine {
    pub name: String,
    pub quantity: i64,
    pub total: String,
}

/// `CommerceOrderConfirmationEmailProps`. Amounts are plain decimal strings
/// (`19.99`), shown with the currency code.
#[derive(Debug, Clone, Default)]
pub struct OrderConfirmation {
    pub shop_name: String,
    pub order_number: String,
    pub currency: String,
    pub lines: Vec<OrderConfirmationLine>,
    pub subtotal: String,
    pub shipping_total: String,
    pub tax_total: String,
    pub total: String,
    /// Absolute link to the order; absent, no link.
    pub order_url: Option<String>,
    /// The order waits for approval from a colleague at the buyer's company.
    pub awaiting_approval: bool,
    /// The buyer pays on invoice.
    pub on_invoice: bool,
}

/// Render `commerce.order-confirmation`.
pub fn order_confirmation(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &OrderConfirmation,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    put(&mut values, "shop_name", &props.shop_name);
    put(&mut values, "order_number", &props.order_number);
    put(&mut values, "currency", &props.currency);
    put(&mut values, "subtotal", &props.subtotal);
    put(&mut values, "shipping_total", &props.shipping_total);
    put(&mut values, "tax_total", &props.tax_total);
    put(&mut values, "total", &props.total);
    // `<Details rows>` renders nothing without rows.
    if !props.lines.is_empty() {
        flags.push("rows");
        let rows: Vec<Value> = props
            .lines
            .iter()
            .map(|line| {
                Value::from(BTreeMap::from([
                    ("name".to_owned(), Value::from(line.name.as_str())),
                    ("quantity".to_owned(), Value::from(line.quantity)),
                    ("total".to_owned(), Value::from(line.total.as_str())),
                    ("v".to_owned(), Value::from("")),
                ]))
            })
            .collect();
        values.insert("rows".to_owned(), Value::from(rows));
    }
    // `props.orderUrl?.trim() || undefined`
    if let Some(url) = trimmed(props.order_url.as_deref()) {
        flags.push("url");
        put(&mut values, "order_url", url);
    }
    if props.awaiting_approval {
        flags.push("approval");
    }
    if props.on_invoice {
        flags.push("invoice");
    }
    render("commerce.order-confirmation", locale, brand, &flags, values)
}

/// `CommerceApprovalRequestedEmailProps`: an order needs approval; goes to
/// the approvers and admins of the buyer's company.
#[derive(Debug, Clone, Default)]
pub struct ApprovalRequested {
    pub shop_name: String,
    pub order_number: String,
    pub currency: String,
    pub total: String,
    /// Who placed the order.
    pub requested_by: String,
    pub company_name: Option<String>,
    /// `buyer_limit` or `company_threshold`.
    pub reason: String,
    /// Absolute link to the order; without one the email has no button.
    pub shop_url: Option<String>,
}

/// Render `commerce.approval-requested`.
pub fn approval_requested(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &ApprovalRequested,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    put(&mut values, "shop_name", &props.shop_name);
    put(&mut values, "order_number", &props.order_number);
    put(&mut values, "currency", &props.currency);
    put(&mut values, "total", &props.total);
    put(&mut values, "requested_by", &props.requested_by);
    // `props.companyName?.trim()`
    if let Some(company) = trimmed(props.company_name.as_deref()) {
        flags.push("company");
        put(&mut values, "company_name", company);
    }
    // `props.shopUrl?.trim() || undefined`
    if let Some(url) = trimmed(props.shop_url.as_deref()) {
        flags.push("url");
        put(&mut values, "shop_url", url);
    }
    if props.reason == "company_threshold" {
        flags.push("reason_company");
    }
    render("commerce.approval-requested", locale, brand, &flags, values)
}

/// `CommerceApprovalDecidedEmailProps`: an approver approved or rejected the
/// buyer's order.
#[derive(Debug, Clone, Default)]
pub struct ApprovalDecided {
    pub shop_name: String,
    pub order_number: String,
    pub currency: String,
    pub total: String,
    pub approved: bool,
    /// The approver; without one the email names nobody.
    pub decided_by: Option<String>,
    /// The approver's comment, quoted; line breaks are kept.
    pub comment: Option<String>,
    /// Absolute link to pay the order; only an approved order shows it.
    pub payment_url: Option<String>,
}

/// Render `commerce.approval-decided`.
pub fn approval_decided(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &ApprovalDecided,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    put(&mut values, "shop_name", &props.shop_name);
    put(&mut values, "order_number", &props.order_number);
    put(&mut values, "currency", &props.currency);
    put(&mut values, "total", &props.total);
    if props.approved {
        flags.push("approved");
    }
    // `props.decidedBy?.trim()`
    if let Some(by) = trimmed(props.decided_by.as_deref()) {
        flags.push("by");
        put(&mut values, "decided_by", by);
    }
    // `props.comment?.trim()`
    if let Some(comment) = trimmed(props.comment.as_deref()) {
        flags.push("comment");
        put(&mut values, "comment", comment);
    }
    // `props.approved ? props.paymentUrl?.trim() || undefined : undefined`
    if props.approved
        && let Some(url) = trimmed(props.payment_url.as_deref())
    {
        flags.push("pay");
        put(&mut values, "payment_url", url);
    }
    render("commerce.approval-decided", locale, brand, &flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brand() -> EmailBrand {
        EmailBrand::Workspace {
            name: "Acme Wholesale".into(),
            logo_url: None,
            accent_color: Some("#2563eb".into()),
        }
    }

    const LOCALES: [EmailLocale; 2] = [EmailLocale::En, EmailLocale::Nl];

    fn invitation() -> BuyerInvitation {
        BuyerInvitation {
            shop_name: "Acme Wholesale".into(),
            company_name: "Jansen Bouw BV".into(),
            inviter_name: Some("Sanne Jansen".into()),
            role: "approver".into(),
            shop_url: Some("https://shop.acme.example/".into()),
        }
    }

    #[test]
    fn an_invitation_names_the_company_the_role_and_links_to_the_shop() {
        let en = buyer_invitation(EmailLocale::En, &brand(), &invitation()).expect("renders");
        let nl = buyer_invitation(EmailLocale::Nl, &brand(), &invitation()).expect("renders");
        assert_ne!(en.subject, nl.subject);
        assert!(en.subject.contains("Jansen Bouw BV"));
        assert!(en.text.contains("as an approver"));
        assert!(en.text.contains("Sanne Jansen gave you access"));
        assert!(en.text.contains("Open the shop"));
        assert!(en.html.contains("https://shop.acme.example/"));
        assert!(nl.text.contains("als fiatteur"));
        assert!(nl.text.contains("Open de shop"));
        assert!(nl.html.contains("#2563eb"));
        let admin = BuyerInvitation {
            role: "admin".into(),
            ..invitation()
        };
        let text = buyer_invitation(EmailLocale::En, &brand(), &admin)
            .expect("renders")
            .text;
        assert!(text.contains("as an admin"));
    }

    #[test]
    fn an_invitation_without_a_link_has_no_button_and_without_a_sender_names_nobody() {
        let props = BuyerInvitation {
            shop_url: Some("  ".into()),
            inviter_name: None,
            role: "buyer".into(),
            ..invitation()
        };
        for locale in LOCALES {
            let email = buyer_invitation(locale, &brand(), &props).expect("renders");
            assert!(!email.html.contains("shop.acme.example"), "{}", email.html);
            assert!(!email.text.contains("Sanne Jansen"));
        }
        let en = buyer_invitation(EmailLocale::En, &brand(), &props).expect("renders");
        assert!(en.text.contains("as a buyer"));
        assert!(en.text.contains("You were given access"));
        assert!(!en.text.contains("Open the shop"));
    }

    #[test]
    fn an_invitation_escapes_what_it_is_given() {
        let props = BuyerInvitation {
            company_name: "A <b>&</b> Co".into(),
            ..invitation()
        };
        let email = buyer_invitation(EmailLocale::En, &brand(), &props).expect("renders");
        assert!(email.html.contains("A &lt;b&gt;&amp;&lt;/b&gt; Co"));
        assert!(!email.html.contains("A <b>"));
    }

    fn order() -> OrderConfirmation {
        OrderConfirmation {
            shop_name: "Acme Wholesale".into(),
            order_number: "ORD-10042".into(),
            currency: "EUR".into(),
            lines: vec![
                OrderConfirmationLine {
                    name: "Safety helmet".into(),
                    quantity: 10,
                    total: "149.90".into(),
                },
                OrderConfirmationLine {
                    name: "Work gloves <L>".into(),
                    quantity: 24,
                    total: "119.76".into(),
                },
            ],
            subtotal: "269.66".into(),
            shipping_total: "9.95".into(),
            tax_total: "58.88".into(),
            total: "338.49".into(),
            order_url: Some("https://shop.acme.example/orders/ORD-10042".into()),
            awaiting_approval: false,
            on_invoice: false,
        }
    }

    #[test]
    fn an_order_lists_its_lines_and_totals_and_links_to_the_order() {
        let en = order_confirmation(EmailLocale::En, &brand(), &order()).expect("renders");
        let nl = order_confirmation(EmailLocale::Nl, &brand(), &order()).expect("renders");
        assert_ne!(en.subject, nl.subject);
        assert_eq!(en.subject, "Your order ORD-10042 at Acme Wholesale");
        assert!(en.text.contains("Order ORD-10042"));
        assert!(en.text.contains("10 × Safety helmet: EUR 149.90"));
        assert!(en.text.contains("24 × Work gloves <L>: EUR 119.76"));
        assert!(en.html.contains("Work gloves &lt;L&gt;"));
        assert!(en.text.contains("Subtotal: EUR 269.66"));
        assert!(en.text.contains("Shipping: EUR 9.95"));
        assert!(en.text.contains("Tax: EUR 58.88"));
        assert!(en.text.contains("Total: EUR 338.49"));
        assert!(en.text.contains("View your order"));
        assert!(
            en.html
                .contains("https://shop.acme.example/orders/ORD-10042")
        );
        assert!(!en.text.contains("waits for approval"));
        assert!(!en.text.contains("invoice"));
        assert!(nl.text.contains("Subtotaal: EUR 269.66"));
        assert!(nl.text.contains("Bekijk je bestelling"));
    }

    #[test]
    fn an_order_says_when_it_waits_for_approval_or_goes_on_invoice() {
        let props = OrderConfirmation {
            awaiting_approval: true,
            on_invoice: true,
            order_url: None,
            ..order()
        };
        let en = order_confirmation(EmailLocale::En, &brand(), &props).expect("renders");
        assert!(en.text.contains("waits for approval from a colleague"));
        assert!(en.text.contains("You will receive an invoice"));
        assert!(!en.text.contains("View your order"));
        assert!(!en.html.contains("shop.acme.example"));
        let nl = order_confirmation(EmailLocale::Nl, &brand(), &props).expect("renders");
        assert!(nl.text.contains("wacht op goedkeuring"));
        assert!(nl.text.contains("Je ontvangt een factuur"));
    }

    fn approval() -> ApprovalRequested {
        ApprovalRequested {
            shop_name: "Acme Wholesale".into(),
            order_number: "ORD-10043".into(),
            currency: "EUR".into(),
            total: "1250.00".into(),
            requested_by: "Femke de Vries".into(),
            company_name: Some("Jansen Bouw BV".into()),
            reason: "buyer_limit".into(),
            shop_url: Some("https://shop.acme.example/approvals/ORD-10043".into()),
        }
    }

    #[test]
    fn an_approval_request_says_why_and_links_to_the_order() {
        let en = approval_requested(EmailLocale::En, &brand(), &approval()).expect("renders");
        let nl = approval_requested(EmailLocale::Nl, &brand(), &approval()).expect("renders");
        assert_ne!(en.subject, nl.subject);
        assert!(en.subject.contains("ORD-10043"));
        assert!(en.text.contains("Femke de Vries from Jansen Bouw BV"));
        assert!(en.text.contains("EUR 1250.00"));
        assert!(en.text.contains("above this buyer's order limit"));
        assert!(en.text.contains("Review the order"));
        assert!(
            en.html
                .contains("https://shop.acme.example/approvals/ORD-10043")
        );
        assert!(nl.text.contains("bestellimiet van deze inkoper"));
        assert!(nl.text.contains("Bekijk de bestelling"));

        let threshold = ApprovalRequested {
            reason: "company_threshold".into(),
            company_name: None,
            shop_url: None,
            ..approval()
        };
        for locale in LOCALES {
            let email = approval_requested(locale, &brand(), &threshold).expect("renders");
            assert!(!email.html.contains("shop.acme.example"));
            assert!(!email.text.contains("Jansen Bouw BV"));
        }
        let en = approval_requested(EmailLocale::En, &brand(), &threshold).expect("renders");
        assert!(en.text.contains("above your company's approval threshold"));
        assert!(!en.text.contains("Review the order"));
    }

    fn decided() -> ApprovalDecided {
        ApprovalDecided {
            shop_name: "Acme Wholesale".into(),
            order_number: "ORD-10043".into(),
            currency: "EUR".into(),
            total: "1250.00".into(),
            approved: true,
            decided_by: Some("Sanne Jansen".into()),
            comment: Some("Fine for this project.\nOrder the rest <next> week.".into()),
            payment_url: Some("https://shop.acme.example/pay/ORD-10043".into()),
        }
    }

    #[test]
    fn an_approved_order_quotes_the_comment_and_offers_payment() {
        let en = approval_decided(EmailLocale::En, &brand(), &decided()).expect("renders");
        let nl = approval_decided(EmailLocale::Nl, &brand(), &decided()).expect("renders");
        assert_ne!(en.subject, nl.subject);
        assert_eq!(en.subject, "Order ORD-10043 was approved");
        assert_eq!(nl.subject, "Bestelling ORD-10043 is goedgekeurd");
        assert!(en.text.contains("Decided by Sanne Jansen."));
        assert!(en.text.contains("Fine for this project."));
        assert!(en.html.contains("Order the rest &lt;next&gt; week."));
        assert!(en.html.contains("<br"));
        assert!(en.text.contains("Pay now"));
        assert!(en.html.contains("https://shop.acme.example/pay/ORD-10043"));
        assert!(nl.text.contains("Nu betalen"));
        assert!(nl.text.contains("Opmerking"));
    }

    #[test]
    fn a_rejected_order_never_offers_payment_and_the_optional_parts_drop_out() {
        let rejected = ApprovalDecided {
            approved: false,
            ..decided()
        };
        let bare = ApprovalDecided {
            approved: true,
            decided_by: None,
            comment: Some(" ".into()),
            payment_url: None,
            ..decided()
        };
        for locale in LOCALES {
            let email = approval_decided(locale, &brand(), &rejected).expect("renders");
            assert!(!email.html.contains("shop.acme.example"));
            assert!(email.text.contains("Fine for this project."));
            let email = approval_decided(locale, &brand(), &bare).expect("renders");
            assert!(!email.html.contains("shop.acme.example"));
            assert!(!email.text.contains("Sanne Jansen"));
            assert!(!email.text.contains("Fine for this project."));
        }
        let en = approval_decided(EmailLocale::En, &brand(), &rejected).expect("renders");
        assert_eq!(en.subject, "Order ORD-10043 was rejected");
        assert!(en.text.contains("It will not be processed."));
        assert!(!en.text.contains("Pay now"));
        let nl = approval_decided(EmailLocale::Nl, &brand(), &rejected).expect("renders");
        assert_eq!(nl.subject, "Bestelling ORD-10043 is afgewezen");
    }
}
