//! Who a document is with: books-api's `services/billing-contact` (the
//! contact person of a company customer or supplier, stored in the CRM as
//! the company's active `person_companies` link with role `billing`) and
//! `lib/contact-snapshot` (the name and email a document keeps of its
//! contact).
//!
//! Sales and purchases fill `contactName` / `contactEmail` on invoices and
//! bills from here, reports read the names of documents stored without one.

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::http::now;
use crate::jurisdictions::js_trim;
use crate::tables::PEOPLE;

/// `BILLING_CONTACT_ROLE`.
pub const BILLING_CONTACT_ROLE: &str = "billing";

/// Distinct ids in first-seen order (`[...new Set(ids)]`).
fn distinct(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.iter()
        .filter(|id| seen.insert(id.as_str()))
        .cloned()
        .collect()
}

/// `loadBillingContacts(db, companyIds)`: the billing contact of each company
/// (its newest live billing link whose person isn't deleted), as the person
/// row Drizzle returns, by company id.
pub async fn load_billing_contacts(
    db: &PgPool,
    company_ids: &[String],
) -> Result<HashMap<String, Value>, sqlx::Error> {
    let ids = distinct(company_ids);
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let links: Vec<(String, String)> = sqlx::query_as(
        "select company_id, person_id from person_companies \
         where company_id = any($1) and role = 'billing' and ended_at is null \
         order by updated_at desc",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    if links.is_empty() {
        return Ok(HashMap::new());
    }
    let person_ids = distinct(&links.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>());
    let people: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(people),
        " from people t where t.id = any($1) and t.deleted_at is null"
    ))
    .bind(&person_ids)
    .fetch_all(db)
    .await?;
    let by_id: HashMap<String, Value> = PEOPLE
        .js_rows(people)
        .into_iter()
        .filter_map(|row| Some((row["id"].as_str()?.to_owned(), row)))
        .collect();
    let mut result = HashMap::new();
    for (company_id, person_id) in links {
        if result.contains_key(&company_id) {
            continue;
        }
        if let Some(person) = by_id.get(&person_id) {
            result.insert(company_id, person.clone());
        }
    }
    Ok(result)
}

/// What [`set_billing_contact`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BillingContactLink {
    pub link_id: String,
    /// A new `person_companies` row was inserted.
    pub created: bool,
    /// Anything changed: the link, or another person's role.
    pub changed: bool,
    /// People at the company who lost the billing role.
    pub demoted_person_ids: Vec<String>,
}

/// `setBillingContact(db, companyId, personId)`: make the person the
/// company's billing contact, linking them when they don't work there yet (a
/// new link is their primary employment when they have none).
pub async fn set_billing_contact(
    db: &PgPool,
    company_id: &str,
    person_id: &str,
) -> Result<BillingContactLink, sqlx::Error> {
    let now = now();
    let demoted: Vec<String> = sqlx::query_scalar(
        "update person_companies set role = null, updated_at = $3::timestamp \
         where company_id = $1 and role = 'billing' and ended_at is null and person_id <> $2 \
         returning person_id",
    )
    .bind(company_id)
    .bind(person_id)
    .bind(&now)
    .fetch_all(db)
    .await?;

    let link: Option<(String, Option<String>)> = sqlx::query_as(
        "select id, role from person_companies \
         where company_id = $1 and person_id = $2 and ended_at is null \
         order by updated_at desc limit 1",
    )
    .bind(company_id)
    .bind(person_id)
    .fetch_optional(db)
    .await?;

    if let Some((link_id, role)) = link {
        let role_changed = role.as_deref() != Some(BILLING_CONTACT_ROLE);
        if role_changed {
            sqlx::query(
                "update person_companies set role = 'billing', updated_at = $2::timestamp where id = $1",
            )
            .bind(&link_id)
            .bind(&now)
            .execute(db)
            .await?;
        }
        let changed = role_changed || !demoted.is_empty();
        return Ok(BillingContactLink {
            link_id,
            created: false,
            changed,
            demoted_person_ids: demoted,
        });
    }

    let primary: Option<String> = sqlx::query_scalar(
        "select id from person_companies where person_id = $1 and is_primary = true and ended_at is null limit 1",
    )
    .bind(person_id)
    .fetch_optional(db)
    .await?;
    let id = generate_id("pc");
    sqlx::query(
        "insert into person_companies (id, created_at, updated_at, person_id, company_id, role, is_primary) \
         values ($1, $2::timestamp, $2::timestamp, $3, $4, 'billing', $5)",
    )
    .bind(&id)
    .bind(&now)
    .bind(person_id)
    .bind(company_id)
    .bind(primary.is_none())
    .execute(db)
    .await?;
    Ok(BillingContactLink {
        link_id: id,
        created: true,
        changed: true,
        demoted_person_ids: demoted,
    })
}

/// `clearBillingContact(db, companyId)`: who lost the role (they stay
/// linked).
pub async fn clear_billing_contact(
    db: &PgPool,
    company_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "update person_companies set role = null, updated_at = $2::timestamp \
         where company_id = $1 and role = 'billing' and ended_at is null returning person_id",
    )
    .bind(company_id)
    .bind(now())
    .fetch_all(db)
    .await
}

/// `ContactSnapshot`: what a document keeps of its contact.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContactSnapshot {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// A non-empty string (`value || null`).
fn filled(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

/// `loadContactSnapshot(db, contactId)`: name and email of an accounting
/// contact (the party and the company or person it wraps).
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

    let mut identity: Option<(Option<String>, Option<String>)> = None;
    if let Some(company_id) = company_id.as_deref().filter(|id| !id.is_empty()) {
        identity =
            sqlx::query_as("select display_name, email from companies where id = $1 limit 1")
                .bind(company_id)
                .fetch_optional(db)
                .await?;
        // A company without an email of its own is reached through its contact person.
        if let Some((name, email)) = &identity
            && filled(email.clone()).is_none()
        {
            let contacts = load_billing_contacts(db, &[company_id.to_owned()]).await?;
            if let Some(person_email) = contacts
                .get(company_id)
                .and_then(|person| person["email"].as_str())
                .filter(|e| !e.is_empty())
            {
                identity = Some((name.clone(), Some(person_email.to_owned())));
            }
        }
    } else if let Some(person_id) = person_id.as_deref().filter(|id| !id.is_empty()) {
        identity = sqlx::query_as("select display_name, email from people where id = $1 limit 1")
            .bind(person_id)
            .fetch_optional(db)
            .await?;
    }

    let (identity_name, identity_email) = identity.unwrap_or_default();
    Ok(ContactSnapshot {
        name: filled(display_name).or_else(|| filled(identity_name)),
        email: filled(identity_email),
    })
}

/// `sent.contactName?.trim() || null`.
fn sent_text(value: Option<&str>) -> Option<String> {
    value
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// `documentContactFields(db, contactId, sent)`: the name and email to store
/// on a document, what the client sent, else the contact's own.
pub async fn document_contact_fields(
    db: &PgPool,
    contact_id: Option<&str>,
    sent_name: Option<&str>,
    sent_email: Option<&str>,
) -> Result<ContactSnapshot, sqlx::Error> {
    let name = sent_text(sent_name);
    let email = sent_text(sent_email);
    if name.is_some() && email.is_some() {
        return Ok(ContactSnapshot { name, email });
    }
    let snapshot = load_contact_snapshot(db, contact_id).await?;
    Ok(ContactSnapshot {
        name: name.or(snapshot.name),
        email: email.or(snapshot.email),
    })
}

/// `withContactNames(db, rows)`: `contactName` filled on documents stored
/// without one, from their contacts' current names (one query for the lot).
pub async fn with_contact_names(
    db: &PgPool,
    mut rows: Vec<Value>,
) -> Result<Vec<Value>, sqlx::Error> {
    let missing = |row: &Value| -> Option<String> {
        let name_set = row["contactName"].as_str().is_some_and(|n| !n.is_empty());
        if name_set {
            return None;
        }
        row["contactId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
    };
    let ids = distinct(&rows.iter().filter_map(missing).collect::<Vec<_>>());
    if ids.is_empty() {
        return Ok(rows);
    }
    let parties: Vec<(String, Option<String>)> =
        sqlx::query_as("select id, display_name from parties where id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?;
    let names: HashMap<String, String> = parties
        .into_iter()
        .filter_map(|(id, name)| Some((id, name?)))
        .collect();
    for row in &mut rows {
        if let Some(id) = missing(row)
            && let Some(name) = names.get(&id).filter(|n| !n.is_empty())
            && let Value::Object(map) = row
        {
            map.insert("contactName".to_owned(), Value::String(name.clone()));
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_keeps_first_seen_order() {
        let ids = ["b", "a", "b", "c", "a"].map(str::to_owned);
        assert_eq!(distinct(&ids), ["b", "a", "c"]);
    }

    #[test]
    fn sent_text_trims_and_drops_blanks() {
        assert_eq!(sent_text(Some("  Acme ")), Some("Acme".to_owned()));
        assert_eq!(sent_text(Some("   ")), None);
        assert_eq!(sent_text(None), None);
    }
}
