//! What a customer sees of an invoice or a quote: the public document of the
//! pay portal's contract (`apps/web/pay-portal/lib/contract.ts`) and the PDF
//! that says the same. One builder feeds the public page, the PDF download
//! and the e-mail's attachment, so they never disagree.

use std::collections::BTreeMap;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_books_domain::accounting_entity::load_invoice_entity;
use weldsuite_books_domain::address::{format_postal_address_lines, normalize_postal_address};
use weldsuite_books_domain::contacts::load_contact_snapshot;
use weldsuite_books_domain::email_templates::locale_of;
use weldsuite_books_domain::js::millis_of;
use weldsuite_books_domain::reminders::{cents_text, parse_cents};
use weldsuite_books_domain::simple_pdf::{DocumentPdf, PdfLabels, PdfLine, PdfParty};
use weldsuite_db::{Keyring, PgPool, orm};
use weldsuite_schema::tenant::{companies, parties, people};

use crate::persist::{owned, text};

/// An invoice or quote ready to show.
pub(crate) struct Document {
    /// The pay portal's document.
    pub json: Value,
    pub pdf: DocumentPdf,
    pub number: String,
    pub locale: &'static str,
    /// The total (the balance due for an open invoice) as the customer reads it.
    pub amount_text: String,
    /// The due date, or the quote's validity, as the customer reads it.
    pub date_text: String,
    pub customer_name: String,
    pub company_name: String,
    /// The entity's e-mail address: where a customer's reply goes.
    pub reply_to: Option<String>,
    /// The entity's `jurisdictionSettings` (templates, reminder workflow).
    pub settings: Value,
}

/// A decimal the contract accepts (`-?\d+(\.\d+)?`): `fallback` for anything else.
pub(crate) fn decimal(value: Option<&Value>, fallback: &str) -> String {
    let text = match value {
        Some(Value::String(s)) => s.trim().to_owned(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return fallback.to_owned(),
    };
    let digits = text.strip_prefix('-').unwrap_or(&text);
    let valid = !digits.is_empty()
        && digits.split('.').count() <= 2
        && digits
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    if valid { text } else { fallback.to_owned() }
}

/// A number as plain text: `21`, `0.5` (no exponent, no `.0`).
pub(crate) fn plain(value: f64) -> String {
    format!("{value}")
}

/// `21.0000` as `21`, `9.50` as `9.5`.
pub(crate) fn trimmed(value: &str) -> String {
    if value.contains('.') {
        value.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        value.to_owned()
    }
}

fn cents(value: &str) -> i64 {
    parse_cents(value).unwrap_or(0)
}

fn day(iso: Option<&str>) -> Option<String> {
    iso.filter(|d| d.len() >= 10)
        .map(|d| d.chars().take(10).collect())
}

fn symbol(currency: &str) -> String {
    match currency {
        "EUR" => "€".to_owned(),
        "USD" => "$".to_owned(),
        "GBP" => "£".to_owned(),
        other => format!("{other} "),
    }
}

/// `1234.5` in `locale`: `€ 1.234,50` (nl) or `€1,234.50` (en).
pub(crate) fn money(amount: &str, currency: &str, locale: &str) -> String {
    let c = cents(amount);
    let abs = c.unsigned_abs();
    let whole = (abs / 100).to_string();
    let (thousands, decimal) = if locale == "nl" {
        ('.', ',')
    } else {
        (',', '.')
    };
    let mut grouped = String::new();
    for (i, ch) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            grouped.push(thousands);
        }
        grouped.push(ch);
    }
    let sign = if c < 0 { "-" } else { "" };
    let space = if locale == "nl" && symbol(currency).ends_with('€') {
        " "
    } else {
        ""
    };
    format!(
        "{sign}{}{space}{grouped}{decimal}{:02}",
        symbol(currency),
        abs % 100
    )
}

const MONTHS_EN: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `2026-11-27` as `27-11-2026` (nl) or `27 Nov 2026` (en).
pub(crate) fn date_text(iso: &str, locale: &str) -> String {
    let parts: Vec<&str> = iso.get(..10).unwrap_or("").split('-').collect();
    let [y, m, d] = parts.as_slice() else {
        return iso.to_owned();
    };
    let Ok(month) = m.parse::<usize>() else {
        return iso.to_owned();
    };
    if locale == "nl" {
        format!("{d}-{m}-{y}")
    } else {
        format!(
            "{} {} {y}",
            d.trim_start_matches('0'),
            MONTHS_EN.get(month.wrapping_sub(1)).unwrap_or(&"")
        )
    }
}

/// The status the portal shows for an invoice.
pub(crate) fn invoice_status(invoice: &Value, now_ms: i64) -> &'static str {
    let status = text(invoice, "status").unwrap_or_default();
    if matches!(
        status,
        "cancelled" | "void" | "uncollectible" | "written_off"
    ) {
        return "cancelled";
    }
    let total = cents(&decimal(invoice.get("total"), "0"));
    let balance = cents(&decimal(
        invoice.get("balanceDue"),
        &decimal(invoice.get("total"), "0"),
    ));
    let paid = cents(&decimal(invoice.get("amountPaid"), "0"));
    if status == "paid" || (balance <= 0 && total > 0) {
        return "paid";
    }
    if status == "partial" || (paid > 0 && balance > 0) {
        return "partially_paid";
    }
    let due = text(invoice, "dueDate").and_then(millis_of);
    if status == "overdue" || due.is_some_and(|due| due < now_ms) {
        return "overdue";
    }
    "open"
}

/// The status the portal shows for a quote, and whether it can be accepted.
pub(crate) fn quote_status(quote: &Value, now_ms: i64) -> (&'static str, bool) {
    let status = text(quote, "status").unwrap_or_default();
    let signed = quote.get("signedAt").is_some_and(|v| !v.is_null());
    if signed || matches!(status, "accepted" | "invoiced") {
        return ("accepted", false);
    }
    if matches!(status, "declined" | "rejected") {
        return ("declined", false);
    }
    if matches!(status, "cancelled" | "void") {
        return ("cancelled", false);
    }
    let until = text(quote, "validUntil").and_then(millis_of);
    // A quote is valid through the end of its last day.
    if status == "expired" || until.is_some_and(|u| u + 86_400_000 <= now_ms) {
        return ("expired", false);
    }
    ("open", true)
}

/// The contact's preferred language: the person's, else the company's.
pub(crate) async fn contact_language(
    db: &PgPool,
    contact_id: Option<&str>,
) -> Result<Option<String>, DbErr> {
    let Some(contact_id) = contact_id.filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    let db = orm(db);
    let party: Option<(Option<String>, Option<String>)> =
        parties::Entity::find_by_id(contact_id.to_owned())
            .select_only()
            .columns([parties::Column::PersonId, parties::Column::CompanyId])
            .into_tuple()
            .one(&db)
            .await?;
    let Some((person_id, company_id)) = party else {
        return Ok(None);
    };
    if let Some(person_id) = person_id {
        let language: Option<Option<String>> = people::Entity::find_by_id(person_id)
            .select_only()
            .column(people::Column::PreferredLanguage)
            .into_tuple()
            .one(&db)
            .await?;
        if let Some(language) = language.flatten().filter(|l| !l.is_empty()) {
            return Ok(Some(language));
        }
    }
    if let Some(company_id) = company_id {
        let language: Option<Option<String>> = companies::Entity::find_by_id(company_id)
            .select_only()
            .column(companies::Column::PreferredLanguage)
            .into_tuple()
            .one(&db)
            .await?;
        return Ok(language.flatten().filter(|l| !l.is_empty()));
    }
    Ok(None)
}

fn address_json(address: Option<&Value>) -> Value {
    let Some(a) = normalize_postal_address(address) else {
        return Value::Null;
    };
    let field = |key: &str| a.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "line1": field("line1"), "line2": field("line2"), "postalCode": field("postalCode"),
        "city": field("city"), "country": field("country"),
    })
}

fn safe_logo(url: Option<&str>) -> Value {
    url.filter(|u| u.starts_with("https://"))
        .map_or(Value::Null, |u| json!(u))
}

struct Words {
    labels: PdfLabels,
    invoice: &'static str,
    credit_note: &'static str,
    quote: &'static str,
    issue_date: &'static str,
    due_date: &'static str,
    valid_until: &'static str,
    reference: &'static str,
    vat: &'static str,
    registration: &'static str,
    pay_to: &'static str,
    pay_ref: &'static str,
    terms_days: fn(i64) -> String,
}

fn words(locale: &str) -> Words {
    if locale == "nl" {
        Words {
            labels: PdfLabels {
                description: "Omschrijving".into(),
                quantity: "Aantal".into(),
                unit_price: "Prijs".into(),
                tax: "BTW".into(),
                amount: "Bedrag".into(),
                subtotal: "Subtotaal".into(),
                total: "Totaal".into(),
                paid: "Betaald".into(),
                balance_due: "Openstaand".into(),
                notes: "Opmerkingen".into(),
                payment: "Betalen".into(),
                from: "Van".into(),
                to: "Aan".into(),
            },
            invoice: "Factuur",
            credit_note: "Creditnota",
            quote: "Offerte",
            issue_date: "Datum",
            due_date: "Vervaldatum",
            valid_until: "Geldig tot",
            reference: "Kenmerk",
            vat: "BTW-nummer",
            registration: "KvK-nummer",
            pay_to: "Maak het bedrag over naar IBAN",
            pay_ref: "onder vermelding van",
            terms_days: |n| format!("Betaling binnen {n} dagen"),
        }
    } else {
        Words {
            labels: PdfLabels {
                description: "Description".into(),
                quantity: "Qty".into(),
                unit_price: "Unit price".into(),
                tax: "VAT".into(),
                amount: "Amount".into(),
                subtotal: "Subtotal".into(),
                total: "Total".into(),
                paid: "Paid".into(),
                balance_due: "Balance due".into(),
                notes: "Notes".into(),
                payment: "Payment".into(),
                from: "From".into(),
                to: "To".into(),
            },
            invoice: "Invoice",
            credit_note: "Credit note",
            quote: "Quote",
            issue_date: "Date",
            due_date: "Due date",
            valid_until: "Valid until",
            reference: "Reference",
            vat: "VAT number",
            registration: "Registration number",
            pay_to: "Please transfer the amount to IBAN",
            pay_ref: "quoting",
            terms_days: |n| format!("Payment within {n} days"),
        }
    }
}

/// One document line.
struct Line {
    description: String,
    quantity: String,
    unit_price: String,
    tax_rate: String,
    /// Before tax.
    total: String,
    /// Tax on the line, in cents.
    tax_cents: i64,
}

/// Tax rows (`rate` text, amount in cents) grouped by rate, lowest first.
fn tax_rows(lines: &[Line]) -> Vec<(String, i64)> {
    let mut by_rate: BTreeMap<i64, (String, i64)> = BTreeMap::new();
    for line in lines {
        let key = cents(&line.tax_rate);
        let entry = by_rate
            .entry(key)
            .or_insert_with(|| (line.tax_rate.clone(), 0));
        entry.1 += line.tax_cents;
    }
    by_rate
        .into_values()
        .filter(|(rate, amount)| cents(rate) != 0 || *amount != 0)
        .collect()
}

struct Parts<'a> {
    kind: &'static str,
    title: &'a str,
    number: String,
    currency: String,
    locale: &'static str,
    entity: &'a Value,
    buyer_name: String,
    buyer_address: Value,
    lines: Vec<Line>,
    subtotal: String,
    total: String,
    paid: String,
    balance: String,
    status: &'static str,
    issue: Option<String>,
    due: Option<String>,
    valid_until: Option<String>,
    reference: Option<String>,
    notes: Option<String>,
    payment_terms: Option<String>,
    quote: Value,
    show_payment: bool,
}

#[allow(
    clippy::too_many_lines,
    reason = "the JSON and the PDF of one document, field by field"
)]
fn assemble(parts: Parts<'_>) -> Document {
    let Parts {
        kind,
        title,
        number,
        currency,
        locale,
        entity,
        buyer_name,
        buyer_address,
        lines,
        subtotal,
        total,
        paid,
        balance,
        status,
        issue,
        due,
        valid_until,
        reference,
        notes,
        payment_terms,
        quote,
        show_payment,
    } = parts;
    let w = words(locale);
    let tax_ids = entity.get("taxIdentifiers").cloned().unwrap_or(Value::Null);
    let bank = entity.get("bankDetails").cloned().unwrap_or(Value::Null);
    let contact = entity.get("contact").cloned().unwrap_or(Value::Null);
    let branding = entity.get("branding").cloned().unwrap_or(Value::Null);
    let company_name = owned(entity, "name").unwrap_or_default();
    let filled = |v: &Value, k: &str| owned(v, k).filter(|s| !s.trim().is_empty());
    let iban = filled(&bank, "iban");
    let taxes = tax_rows(&lines);
    let money_of = |amount: &str| money(amount, &currency, locale);

    let seller_address = entity.get("address");
    let json = json!({
        "kind": kind,
        "status": status,
        "number": number,
        "issueDate": issue.clone().unwrap_or_default(),
        "dueDate": due,
        "validUntil": valid_until,
        "currency": currency,
        "locale": locale,
        "seller": {
            "name": company_name,
            "address": address_json(seller_address),
            "email": filled(&contact, "email"),
            "phone": filled(&contact, "phone"),
            "vatNumber": filled(&tax_ids, "vatNumber"),
            "registrationNumber": filled(&tax_ids, "registrationNumber"),
            "iban": iban,
            "bic": filled(&bank, "bic"),
            "logoUrl": safe_logo(text(&branding, "logoUrl")),
        },
        "buyer": { "name": buyer_name, "address": buyer_address },
        "lines": lines.iter().map(|l| json!({
            "description": l.description, "quantity": l.quantity, "unitPrice": l.unit_price,
            "taxRate": l.tax_rate, "total": l.total,
        })).collect::<Vec<_>>(),
        "totals": {
            "subtotal": subtotal,
            "taxes": taxes.iter().map(|(rate, amount)| json!({ "rate": rate, "amount": cents_text(*amount) })).collect::<Vec<_>>(),
            "total": total,
            "paid": paid,
            "balanceDue": balance,
        },
        "notes": notes,
        "paymentTerms": payment_terms,
        // Online payment arrives with Mollie (phase 4b): until then the page
        // shows the bank details.
        "payment": {
            "enabled": false,
            "status": if status == "paid" { "paid" } else { "open" },
            "methods": [],
        },
        "quote": quote,
    });

    let mut seller_lines = format_postal_address_lines(seller_address, None);
    for (label, value) in [
        (w.vat, filled(&tax_ids, "vatNumber")),
        (w.registration, filled(&tax_ids, "registrationNumber")),
    ] {
        if let Some(value) = value {
            seller_lines.push(format!("{label}: {value}"));
        }
    }
    let mut meta = vec![(
        w.issue_date.to_owned(),
        date_text(issue.as_deref().unwrap_or(""), locale),
    )];
    if let Some(due) = &due {
        meta.push((w.due_date.to_owned(), date_text(due, locale)));
    }
    if let Some(valid) = &valid_until {
        meta.push((w.valid_until.to_owned(), date_text(valid, locale)));
    }
    if let Some(reference) = &reference {
        meta.push((w.reference.to_owned(), reference.clone()));
    }
    let mut payment_lines = Vec::new();
    if show_payment && let Some(iban) = &iban {
        payment_lines.push(format!("{} {iban} {} {number}", w.pay_to, w.pay_ref));
    }
    let open_invoice = kind == "invoice" && show_payment;
    let pdf = DocumentPdf {
        title: title.to_owned(),
        number: number.clone(),
        seller: PdfParty {
            name: company_name.clone(),
            lines: seller_lines,
        },
        buyer: PdfParty {
            name: buyer_name.clone(),
            lines: format_postal_address_lines(
                json.pointer("/buyer/address").filter(|a| !a.is_null()),
                None,
            ),
        },
        meta,
        labels: w.labels.clone(),
        lines: lines
            .iter()
            .map(|l| PdfLine {
                description: l.description.clone(),
                quantity: l.quantity.clone(),
                unit_price: money_of(&l.unit_price),
                tax_rate: l.tax_rate.clone(),
                total: money_of(&l.total),
            })
            .collect(),
        subtotal: money_of(&subtotal),
        taxes: taxes
            .iter()
            .map(|(rate, amount)| (rate.clone(), money_of(&cents_text(*amount))))
            .collect(),
        total: money_of(&total),
        paid: (open_invoice && cents(&paid) != 0).then(|| money_of(&paid)),
        balance_due: open_invoice.then(|| money_of(&balance)),
        notes: notes.clone(),
        payment_lines,
    };
    let amount = if kind == "invoice" && status != "paid" {
        &balance
    } else {
        &total
    };
    Document {
        amount_text: money_of(amount),
        date_text: date_text(
            due.as_deref().or(valid_until.as_deref()).unwrap_or(""),
            locale,
        ),
        json,
        pdf,
        number,
        locale,
        customer_name: buyer_name,
        company_name,
        reply_to: filled(&contact, "email"),
        settings: entity
            .get("jurisdictionSettings")
            .cloned()
            .unwrap_or(Value::Null),
    }
}

/// The language of the documents of `invoice`: its contact's, else its
/// entity's.
pub(crate) async fn invoice_locale(db: &PgPool, invoice: &Value) -> Result<&'static str, DbErr> {
    if let Some(language) = contact_language(db, text(invoice, "contactId")).await? {
        return Ok(locale_of(Some(&language)));
    }
    let entity: Option<Option<String>> = weldsuite_schema::tenant::entities::Entity::find_by_id(
        text(invoice, "entityId").unwrap_or_default().to_owned(),
    )
    .select_only()
    .column(weldsuite_schema::tenant::entities::Column::Locale)
    .into_tuple()
    .one(&orm(db))
    .await?;
    Ok(locale_of(entity.flatten().as_deref()))
}

fn locale_for(entity: &Value, contact_language: Option<&str>) -> &'static str {
    match contact_language {
        Some(language) => locale_of(Some(language)),
        None => locale_of(owned(entity, "locale").as_deref()),
    }
}

/// An invoice or credit note, with its lines (`load_items`), as the customer
/// sees it.
pub(crate) async fn invoice_document(
    db: &PgPool,
    keyring: &Keyring,
    invoice: &Value,
    items: &[Value],
    now_ms: i64,
) -> Result<Option<Document>, DbErr> {
    let entity_id = text(invoice, "entityId").unwrap_or_default();
    let entity = match load_invoice_entity(db, entity_id, Some(keyring)).await {
        Ok(Some(entity)) => entity,
        Ok(None) => return Ok(None),
        Err(error) => return Err(DbErr::Custom(error.to_string())),
    };
    let contact_id = text(invoice, "contactId");
    let snapshot = load_contact_snapshot(db, contact_id).await?;
    let language = contact_language(db, contact_id).await?;
    let locale = locale_for(&entity, language.as_deref());
    let currency = owned(invoice, "currency")
        .or_else(|| owned(&entity, "baseCurrency"))
        .unwrap_or_else(|| "EUR".to_owned());
    let w = words(locale);
    let credit = text(invoice, "type") == Some("credit_note");
    let lines: Vec<Line> = items
        .iter()
        .map(|i| {
            let total = decimal(i.get("lineTotal"), "0");
            Line {
                description: owned(i, "description").unwrap_or_default(),
                quantity: decimal(i.get("quantity"), "1"),
                unit_price: decimal(i.get("unitPrice"), "0"),
                tax_rate: trimmed(&decimal(i.get("taxRate"), "0")),
                tax_cents: cents(&decimal(i.get("taxAmount"), "0")),
                total,
            }
        })
        .collect();
    let total = decimal(invoice.get("total"), "0");
    let balance = decimal(invoice.get("balanceDue"), &total);
    let status = invoice_status(invoice, now_ms);
    let name = owned(invoice, "contactName")
        .filter(|n| !n.is_empty())
        .or(snapshot.name)
        .unwrap_or_default();
    let terms = invoice
        .get("paymentTermsDays")
        .and_then(Value::as_i64)
        .filter(|d| *d > 0)
        .map(w.terms_days);
    Ok(Some(assemble(Parts {
        kind: "invoice",
        title: if credit { w.credit_note } else { w.invoice },
        number: owned(invoice, "invoiceNumber")
            .unwrap_or_else(|| text(invoice, "id").unwrap_or_default().to_owned()),
        currency,
        locale,
        entity: &entity,
        buyer_name: name,
        buyer_address: address_json(invoice.get("billingAddress")),
        lines,
        subtotal: decimal(invoice.get("subtotal"), "0"),
        total: total.clone(),
        paid: decimal(invoice.get("amountPaid"), "0"),
        balance,
        status,
        issue: day(text(invoice, "issueDate")),
        due: if credit {
            None
        } else {
            day(text(invoice, "dueDate"))
        },
        valid_until: None,
        reference: owned(invoice, "reference").filter(|r| !r.is_empty()),
        notes: owned(invoice, "notes").filter(|n| !n.is_empty()),
        payment_terms: terms,
        quote: Value::Null,
        show_payment: !credit && !matches!(status, "paid" | "cancelled"),
    })))
}

/// A WeldCRM quote as the customer sees it, from `entity` (the workspace's
/// default legal entity: quotes belong to no entity until they are invoiced).
pub(crate) async fn quote_document(
    db: &PgPool,
    keyring: &Keyring,
    quote: &Value,
    entity_id: &str,
    now_ms: i64,
) -> Result<Option<Document>, DbErr> {
    let entity = match load_invoice_entity(db, entity_id, Some(keyring)).await {
        Ok(Some(entity)) => entity,
        Ok(None) => return Ok(None),
        Err(error) => return Err(DbErr::Custom(error.to_string())),
    };
    let contact_id = quote_party_id(db, quote).await?;
    let snapshot = load_contact_snapshot(db, contact_id.as_deref()).await?;
    let language = contact_language(db, contact_id.as_deref()).await?;
    let locale = locale_for(&entity, language.as_deref());
    let w = words(locale);
    let currency = owned(quote, "currency").unwrap_or_else(|| "EUR".to_owned());
    let lines = quote_lines(quote);
    let (status, can_accept) = quote_status(quote, now_ms);
    let signed_at = quote.get("signedAt").filter(|v| !v.is_null()).cloned();
    let accepted = status == "accepted";
    let total = decimal(quote.get("total"), "0");
    Ok(Some(assemble(Parts {
        kind: "quote",
        title: w.quote,
        number: owned(quote, "quoteNumber").unwrap_or_default(),
        currency,
        locale,
        entity: &entity,
        buyer_name: snapshot
            .name
            .clone()
            .filter(|n| !n.is_empty())
            .or_else(|| owned(quote, "name"))
            .unwrap_or_default(),
        buyer_address: Value::Null,
        lines,
        subtotal: decimal(quote.get("subtotal"), "0"),
        total,
        paid: "0".to_owned(),
        balance: "0".to_owned(),
        status,
        issue: day(text(quote, "validFrom")).or_else(|| day(text(quote, "createdAt"))),
        due: None,
        valid_until: day(text(quote, "validUntil")),
        reference: owned(quote, "name").filter(|n| !n.is_empty()),
        notes: owned(quote, "notes").filter(|n| !n.is_empty()),
        payment_terms: owned(quote, "paymentTerms").filter(|t| !t.is_empty()),
        quote: json!({
            "canAccept": can_accept,
            "acceptedAt": if accepted { signed_at } else { None },
            "acceptedBy": if accepted { owned(quote, "signedBy") } else { None },
        }),
        show_payment: false,
    })))
}

/// The WeldBooks contact (a party) of a quote: the party WeldBooks wrote in
/// `customerId`, else the party of the CRM company (`counterpartyId`) or
/// person (`personId`) a CRM quote is for.
pub(crate) async fn quote_party_id(db: &PgPool, quote: &Value) -> Result<Option<String>, DbErr> {
    let (customer, company, person) = quote_party(quote);
    let db = orm(db);
    if let Some(customer) = customer {
        let found: Option<String> = parties::Entity::find_by_id(customer)
            .select_only()
            .column(parties::Column::Id)
            .filter(parties::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&db)
            .await?;
        if found.is_some() {
            return Ok(found);
        }
    }
    for (column, id) in [
        (parties::Column::CompanyId, company),
        (parties::Column::PersonId, person),
    ] {
        if let Some(id) = id {
            let found: Option<String> = parties::Entity::find()
                .select_only()
                .column(parties::Column::Id)
                .filter(column.eq(id))
                .filter(parties::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&db)
                .await?;
            if found.is_some() {
                return Ok(found);
            }
        }
    }
    Ok(None)
}

/// `(customerId, counterpartyId, personId)` of a quote.
pub(crate) fn quote_party(quote: &Value) -> (Option<String>, Option<String>, Option<String>) {
    (
        owned(quote, "customerId").filter(|c| !c.is_empty()),
        owned(quote, "counterpartyId").filter(|c| !c.is_empty()),
        owned(quote, "personId").filter(|c| !c.is_empty()),
    )
}

fn number_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn first<'a>(line: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|k| line.get(*k))
        .find(|v| !v.is_null())
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "cents of document amounts"
)]
/// A quote's lines as the customer reads them; the CRM keeps them free-form,
/// so the usual names are tried.
fn quote_lines(quote: &Value) -> Vec<Line> {
    let Some(items) = quote.get("lineItems").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| {
            let quantity = number_of(first(item, &["quantity", "qty"])).unwrap_or(1.0);
            let price =
                number_of(first(item, &["unitPrice", "price", "unit_price"])).unwrap_or(0.0);
            let discount = number_of(first(item, &["discountPercent", "discount"])).unwrap_or(0.0);
            let rate = number_of(first(item, &["taxRate", "vatRate", "tax_rate"])).unwrap_or(0.0);
            #[allow(clippy::cast_possible_truncation)]
            let total_cents = number_of(first(item, &["lineTotal", "total", "amount"]))
                .map_or_else(
                    || (quantity * price * (1.0 - discount / 100.0) * 100.0).round() as i64,
                    |t| (t * 100.0).round() as i64,
                );
            #[allow(clippy::cast_possible_truncation)]
            let tax_cents = (total_cents as f64 * rate / 100.0).round() as i64;
            Line {
                description: first(item, &["description", "name", "title"])
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                quantity: plain(quantity),
                unit_price: cents_text((price * 100.0).round() as i64),
                tax_rate: plain(rate),
                total: cents_text(total_cents),
                tax_cents,
            }
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    const NOW: i64 = 1_795_000_000_000;

    #[test]
    fn decimals_follow_the_contract() {
        assert_eq!(decimal(Some(&json!("12.50")), "0"), "12.50");
        assert_eq!(decimal(Some(&json!("-3")), "0"), "-3");
        assert_eq!(decimal(Some(&json!(4.5)), "0"), "4.5");
        for bad in [
            json!(""),
            json!("1e3"),
            json!("1."),
            json!(".5"),
            json!("1.2.3"),
            json!(null),
            json!("abc"),
        ] {
            assert_eq!(decimal(Some(&bad), "0"), "0", "{bad}");
        }
        assert_eq!(decimal(None, "9"), "9");
    }

    #[test]
    fn money_and_dates_read_in_the_language() {
        assert_eq!(money("1234.5", "EUR", "nl"), "€ 1.234,50");
        assert_eq!(money("1234.5", "EUR", "en"), "€1,234.50");
        assert_eq!(money("-0.05", "USD", "en"), "-$0.05");
        assert_eq!(money("1000000", "CHF", "en"), "CHF 1,000,000.00");
        assert_eq!(date_text("2026-11-07", "nl"), "07-11-2026");
        assert_eq!(date_text("2026-11-07", "en"), "7 Nov 2026");
    }

    #[test]
    fn an_invoice_status_follows_status_balance_and_due_date() {
        let past = "2020-01-01T00:00:00.000Z";
        let future = "2099-01-01T00:00:00.000Z";
        let s = |v: Value| invoice_status(&v, NOW);
        assert_eq!(
            s(json!({ "status": "sent", "total": "100", "balanceDue": "100", "dueDate": future })),
            "open"
        );
        assert_eq!(
            s(json!({ "status": "sent", "total": "100", "balanceDue": "100", "dueDate": past })),
            "overdue"
        );
        assert_eq!(
            s(
                json!({ "status": "overdue", "total": "100", "balanceDue": "100", "dueDate": future })
            ),
            "overdue"
        );
        assert_eq!(
            s(
                json!({ "status": "partial", "total": "100", "balanceDue": "40", "amountPaid": "60", "dueDate": past })
            ),
            "partially_paid"
        );
        assert_eq!(
            s(json!({ "status": "paid", "total": "100", "balanceDue": "0" })),
            "paid"
        );
        assert_eq!(
            s(json!({ "status": "sent", "total": "100", "balanceDue": "0" })),
            "paid"
        );
        assert_eq!(
            s(json!({ "status": "cancelled", "total": "100" })),
            "cancelled"
        );
        assert_eq!(
            s(json!({ "status": "uncollectible", "total": "100" })),
            "cancelled"
        );
    }

    #[test]
    fn a_quote_status_follows_acceptance_and_validity() {
        let q = |v: Value| quote_status(&v, NOW);
        assert_eq!(
            q(json!({ "status": "sent", "validUntil": "2099-01-01T00:00:00.000Z" })),
            ("open", true)
        );
        assert_eq!(
            q(json!({ "status": "sent", "validUntil": "2020-01-01T00:00:00.000Z" })),
            ("expired", false)
        );
        assert_eq!(q(json!({ "status": "accepted" })), ("accepted", false));
        assert_eq!(
            q(json!({ "status": "sent", "signedAt": "2026-11-01T00:00:00.000Z" })),
            ("accepted", false)
        );
        assert_eq!(q(json!({ "status": "invoiced" })), ("accepted", false));
        assert_eq!(q(json!({ "status": "rejected" })), ("declined", false));
        assert_eq!(q(json!({ "status": "cancelled" })), ("cancelled", false));
        assert_eq!(
            q(json!({ "status": "expired", "validUntil": "2099-01-01T00:00:00.000Z" })),
            ("expired", false)
        );
    }

    #[test]
    fn quote_lines_are_read_whatever_the_crm_called_them() {
        let quote = json!({ "lineItems": [
            { "description": "Work", "quantity": 2, "unitPrice": "50", "taxRate": "21" },
            { "name": "Part", "qty": "1", "price": 10, "discount": 50, "vatRate": 9, "lineTotal": "5.00" },
        ] });
        let lines = quote_lines(&quote);
        assert_eq!(lines[0].total, "100.00");
        assert_eq!(lines[0].tax_cents, 2100);
        assert_eq!(lines[1].description, "Part");
        assert_eq!(lines[1].total, "5.00");
        assert_eq!(lines[1].tax_cents, 45);
        let rows = tax_rows(&lines);
        assert_eq!(rows, vec![("9".to_owned(), 45), ("21".to_owned(), 2100)]);
    }
}
