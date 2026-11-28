//! A contact's statement (Rust only, edition feature `books-contact-page`):
//! what the contact has open with one legal entity on a day, as JSON for the
//! screen and as the PDF a customer gets
//! (`GET /api/accounting-contacts/:id/statement`).
//!
//! The open items are the entity's invoices and credit notes of the contact
//! that are issued up to the day and still have a balance (status `sent`,
//! `finalized`, `partial` or `overdue`; proformas are not claims). The
//! balance is today's: the books keep no history of balances, so an `asOf` in
//! the past lists the documents issued by then with what is left of them now.
//! A credit note counts negative, and the totals are per currency.

use std::collections::BTreeMap;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use time::{Date, Duration};
use weldsuite_db::{Keyring, PgPool, orm};
use weldsuite_schema::tenant::{companies, invoices, parties, people};

use crate::accounting_entity::load_invoice_entity;
use crate::address::format_postal_address_lines;
use crate::contacts::load_contact_snapshot;
use crate::email_templates::locale_of;
use crate::simple_pdf::{PdfParty, StatementLabels, StatementPdf, StatementRow};

/// The statuses of a document that still has an open balance.
const OPEN: [&str; 4] = ["sent", "finalized", "partial", "overdue"];

/// The statement, ready to answer with.
#[derive(Debug, Clone)]
pub struct Statement {
    pub json: Value,
    pub pdf: StatementPdf,
}

fn cents_of(amount: Option<&sea_orm::prelude::BigDecimal>) -> i64 {
    amount
        .and_then(|a| {
            (a * sea_orm::prelude::BigDecimal::from(100))
                .round(0)
                .to_plain_string()
                .parse::<i64>()
                .ok()
        })
        .unwrap_or(0)
}

/// `12345` as `123.45`.
fn plain(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
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
fn money(cents: i64, currency: &str, locale: &str) -> String {
    let abs = cents.unsigned_abs();
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
    let sign = if cents < 0 { "-" } else { "" };
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

/// `27-11-2026` (nl) or `27 Nov 2026` (en).
fn date_text(date: Date, locale: &str) -> String {
    if locale == "nl" {
        format!(
            "{:02}-{:02}-{}",
            date.day(),
            u8::from(date.month()),
            date.year()
        )
    } else {
        format!(
            "{} {} {}",
            date.day(),
            MONTHS_EN[usize::from(u8::from(date.month())) - 1],
            date.year()
        )
    }
}

/// The contact's preferred language: the person's, else the company's.
async fn language_of(db: &PgPool, contact_id: &str) -> Result<Option<String>, DbErr> {
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

fn labels(locale: &str) -> (&'static str, &'static str, &'static str, StatementLabels) {
    if locale == "nl" {
        (
            "Overzicht openstaande posten",
            "Factuur",
            "Creditnota",
            StatementLabels {
                document: "Document".into(),
                date: "Datum".into(),
                due_date: "Vervaldatum".into(),
                amount: "Bedrag".into(),
                balance: "Openstaand".into(),
                total: "Totaal openstaand".into(),
                from: "Van".into(),
                to: "Aan".into(),
                nothing_open: "Er staat niets open.".into(),
            },
        )
    } else {
        (
            "Statement of open items",
            "Invoice",
            "Credit note",
            StatementLabels {
                document: "Document".into(),
                date: "Date".into(),
                due_date: "Due date".into(),
                amount: "Amount".into(),
                balance: "Balance".into(),
                total: "Total due".into(),
                from: "From".into(),
                to: "To".into(),
                nothing_open: "Nothing is open.".into(),
            },
        )
    }
}

/// The statement of `contact_id` with `entity_id` as of `as_of`; `None` when
/// the entity or the contact is not there.
///
/// # Errors
///
/// The database's.
#[allow(
    clippy::too_many_lines,
    reason = "the rows, then the JSON and the PDF from them"
)]
pub async fn build(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: &str,
    contact_id: &str,
    as_of: Date,
    today: Date,
) -> Result<Option<Statement>, DbErr> {
    let entity = match load_invoice_entity(db, entity_id, Some(keyring)).await {
        Ok(Some(entity)) => entity,
        Ok(None) => return Ok(None),
        Err(error) => return Err(DbErr::Custom(error.to_string())),
    };
    let Some(party) = parties::Entity::find_by_id(contact_id.to_owned())
        .filter(parties::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
    else {
        return Ok(None);
    };
    let language = language_of(db, contact_id).await?;
    let locale = match language.as_deref() {
        Some(language) => locale_of(Some(language)),
        None => locale_of(entity.get("locale").and_then(Value::as_str)),
    };
    let (title, invoice_word, credit_word, words) = labels(locale);
    let base = entity
        .get("baseCurrency")
        .and_then(Value::as_str)
        .unwrap_or("EUR")
        .to_owned();

    let after = as_of
        .checked_add(Duration::days(1))
        .unwrap_or(as_of)
        .with_hms(0, 0, 0)
        .unwrap_or_else(|_| as_of.midnight());
    let documents = invoices::Entity::find()
        .filter(invoices::Column::EntityId.eq(entity_id))
        .filter(invoices::Column::ContactId.eq(contact_id))
        .filter(invoices::Column::DeletedAt.is_null())
        .filter(invoices::Column::Status.is_in(OPEN))
        .filter(invoices::Column::Type.ne("proforma"))
        .filter(invoices::Column::BalanceDue.gt(0))
        .filter(invoices::Column::IssueDate.lt(after))
        .order_by_asc(invoices::Column::IssueDate)
        .order_by_asc(invoices::Column::InvoiceNumber)
        .order_by_asc(invoices::Column::Id)
        .all(&orm(db))
        .await?;

    let mut rows = Vec::new();
    let mut pdf_rows = Vec::new();
    let mut totals: BTreeMap<String, i64> = BTreeMap::new();
    for document in &documents {
        let credit = document.type_ == "credit_note";
        let sign = if credit { -1 } else { 1 };
        let currency = document.currency.clone().unwrap_or_else(|| base.clone());
        let amount = sign * cents_of(document.total.as_ref());
        let balance = sign * cents_of(document.balance_due.as_ref());
        let issued = document.issue_date.date();
        let due = document.due_date.date();
        let number = document
            .invoice_number
            .clone()
            .unwrap_or_else(|| document.id.clone());
        let overdue_days = if credit || due >= today {
            0
        } else {
            (today - due).whole_days()
        };
        *totals.entry(currency.clone()).or_default() += balance;
        rows.push(json!({
            "kind": if credit { "credit_note" } else { "invoice" },
            "objectType": "invoice",
            "objectId": document.id,
            "number": number,
            "date": issued.to_string(),
            "dueDate": if credit { Value::Null } else { json!(due.to_string()) },
            "currency": currency,
            "amount": plain(amount),
            "balance": plain(balance),
            "overdueDays": overdue_days,
        }));
        pdf_rows.push(StatementRow {
            document: format!(
                "{} {number}",
                if credit { credit_word } else { invoice_word }
            ),
            date: date_text(issued, locale),
            due: if credit {
                String::new()
            } else {
                date_text(due, locale)
            },
            amount: money(amount, &currency, locale),
            balance: money(balance, &currency, locale),
        });
    }

    let snapshot = load_contact_snapshot(db, Some(contact_id)).await?;
    let name = party
        .display_name
        .clone()
        .filter(|n| !n.is_empty())
        .or(snapshot.name)
        .unwrap_or_default();
    let seller_name = entity
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut seller_lines = format_postal_address_lines(entity.get("address"), None);
    if let Some(vat) = entity
        .pointer("/taxIdentifiers/vatNumber")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
    {
        seller_lines.push(format!(
            "{}: {vat}",
            if locale == "nl" {
                "BTW-nummer"
            } else {
                "VAT number"
            }
        ));
    }
    let totals_json: Vec<Value> = totals
        .iter()
        .map(|(currency, cents)| json!({ "currency": currency, "amount": plain(*cents) }))
        .collect();
    let json = json!({
        "contact": { "contactId": contact_id, "name": name },
        "entityId": entity_id,
        "asOf": as_of.to_string(),
        "locale": locale,
        "rows": rows,
        "totals": totals_json,
    });
    let pdf = StatementPdf {
        title: title.to_owned(),
        as_of: date_text(as_of, locale),
        seller: PdfParty {
            name: seller_name,
            lines: seller_lines,
        },
        buyer: PdfParty {
            name,
            lines: format_postal_address_lines(party.billing_address.as_ref(), None),
        },
        labels: words,
        rows: pdf_rows,
        totals: totals
            .iter()
            .map(|(currency, cents)| (currency.clone(), money(*cents, currency, locale)))
            .collect(),
    };
    Ok(Some(Statement { json, pdf }))
}

#[cfg(test)]
mod tests {
    use time::macros::date;

    use super::*;

    #[test]
    fn money_and_dates_read_in_the_language() {
        assert_eq!(money(123_450, "EUR", "nl"), "€ 1.234,50");
        assert_eq!(money(123_450, "USD", "en"), "$1,234.50");
        assert_eq!(money(-500, "EUR", "en"), "-€5.00");
        assert_eq!(date_text(date!(2026 - 11 - 27), "nl"), "27-11-2026");
        assert_eq!(date_text(date!(2026 - 11 - 7), "en"), "7 Nov 2026");
        assert_eq!(plain(-5), "-0.05");
    }
}
