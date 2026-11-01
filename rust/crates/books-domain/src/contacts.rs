//! The contact facts a document keeps (`lib/contact-snapshot.ts`): invoices
//! and bills store the contact's name (and an invoice its email) next to
//! `contactId`, so the PDF, lists and reports read them from the document
//! and a renamed contact doesn't rename old documents. Clients only send
//! `contactId`; the routes fill the rest from the contact here.
//!
//! The billing contact itself (`services/billing-contact.ts`: which person
//! of a company gets the invoices, and setting one) belongs to the purchases
//! area; only the read the snapshot needs ([`billing_contact_email`]) is
//! here.

use std::collections::HashMap;

use serde_json::Value;
use weldsuite_db::PgPool;

use crate::jurisdictions::js_trim;

/// `ContactSnapshot`: a contact's name and email.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContactSnapshot {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// `BILLING_CONTACT_ROLE`.
pub const BILLING_CONTACT_ROLE: &str = "billing";

/// The email of a company's billing contact (`loadBillingContacts`): the
/// most recently updated live `billing` link whose person still exists.
pub async fn billing_contact_email(
    db: &PgPool,
    company_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let email: Option<Option<String>> = sqlx::query_scalar(
        "select p.email from person_companies pc \
         join people p on p.id = pc.person_id and p.deleted_at is null \
         where pc.company_id = $1 and pc.role = $2 and pc.ended_at is null \
         order by pc.updated_at desc limit 1",
    )
    .bind(company_id)
    .bind(BILLING_CONTACT_ROLE)
    .fetch_optional(db)
    .await?;
    Ok(email.flatten())
}

fn filled(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

/// `loadContactSnapshot(db, contactId)`: name and email of an accounting
/// contact (a party and the company or person it wraps).
pub async fn load_contact_snapshot(
    db: &PgPool,
    contact_id: Option<&str>,
) -> Result<ContactSnapshot, sqlx::Error> {
    let Some(contact_id) = contact_id.filter(|id| !id.is_empty()) else {
        return Ok(ContactSnapshot::default());
    };
    let party: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select display_name, company_id, person_id from parties where id = $1 limit 1",
    )
    .bind(contact_id)
    .fetch_optional(db)
    .await?;
    let Some((display_name, company_id, person_id)) = party else {
        return Ok(ContactSnapshot::default());
    };

    // (displayName, email) of the wrapped identity.
    let mut identity: Option<(Option<String>, Option<String>)> = None;
    if let Some(company_id) = company_id.filter(|id| !id.is_empty()) {
        identity =
            sqlx::query_as("select display_name, email from companies where id = $1 limit 1")
                .bind(&company_id)
                .fetch_optional(db)
                .await?;
        // A company without an email of its own is reached through its contact person.
        if let Some((_, email)) = identity.as_mut()
            && email.as_deref().is_none_or(str::is_empty)
            && let Some(contact_email) = filled(billing_contact_email(db, &company_id).await?)
        {
            *email = Some(contact_email);
        }
    } else if let Some(person_id) = person_id.filter(|id| !id.is_empty()) {
        identity = sqlx::query_as("select display_name, email from people where id = $1 limit 1")
            .bind(&person_id)
            .fetch_optional(db)
            .await?;
    }
    let (identity_name, identity_email) = identity.unwrap_or((None, None));
    Ok(ContactSnapshot {
        name: filled(display_name).or_else(|| filled(identity_name)),
        email: filled(identity_email),
    })
}

/// `documentContactFields(db, contactId, sent)`: what the client sent
/// (trimmed), else the contact's own.
pub async fn document_contact_fields(
    db: &PgPool,
    contact_id: Option<&str>,
    sent_name: Option<&str>,
    sent_email: Option<&str>,
) -> Result<ContactSnapshot, sqlx::Error> {
    let trimmed = |value: Option<&str>| {
        value
            .map(|v| js_trim(v).to_owned())
            .filter(|v| !v.is_empty())
    };
    let name = trimmed(sent_name);
    let email = trimmed(sent_email);
    if name.is_some() && email.is_some() {
        return Ok(ContactSnapshot { name, email });
    }
    let snapshot = load_contact_snapshot(db, contact_id).await?;
    Ok(ContactSnapshot {
        name: name.or(snapshot.name),
        email: email.or(snapshot.email),
    })
}

/// `withContactNames(db, rows)`: `contactName` filled in on rows stored
/// without one, from the contacts' current names (one query).
pub async fn with_contact_names(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, sqlx::Error> {
    let unnamed = |row: &Value| !crate::js::truthy(row.get("contactName"));
    let mut missing: Vec<String> = Vec::new();
    for row in &rows {
        if let Some(id) = row["contactId"].as_str().filter(|id| !id.is_empty())
            && unnamed(row)
            && !missing.iter().any(|m| m == id)
        {
            missing.push(id.to_owned());
        }
    }
    if missing.is_empty() {
        return Ok(rows);
    }
    let parties: Vec<(String, Option<String>)> =
        sqlx::query_as("select id, display_name from parties where id = any($1)")
            .bind(&missing)
            .fetch_all(db)
            .await?;
    // `new Map(...)`: a repeated id keeps the last row.
    let mut names: HashMap<String, Option<String>> = HashMap::new();
    for (id, name) in parties {
        names.insert(id, name);
    }
    Ok(rows
        .into_iter()
        .map(|mut row| {
            if unnamed(&row)
                && let Some(name) = row["contactId"]
                    .as_str()
                    .and_then(|id| names.get(id))
                    .cloned()
                    .flatten()
                    .filter(|n| !n.is_empty())
            {
                row["contactName"] = Value::String(name);
            }
            row
        })
        .collect())
}
