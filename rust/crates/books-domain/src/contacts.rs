//! Who a document is with: books-api's `services/billing-contact` (the
//! contact person of a company customer or supplier, stored in the CRM as
//! the company's active `person_companies` link with role `billing`) and
//! `lib/contact-snapshot` (the name and email a document keeps of its
//! contact).
//!
//! Sales and purchases fill `contactName` / `contactEmail` on invoices and
//! bills from here, reports read the names of documents stored without one.

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::Value;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{companies, parties, people, person_companies};

use crate::db_values::to_json_rows;
use crate::jurisdictions::js_trim;

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
) -> Result<HashMap<String, Value>, DbErr> {
    let ids = distinct(company_ids);
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let db = orm(db);
    let links: Vec<(String, String)> = person_companies::Entity::find()
        .select_only()
        .columns([
            person_companies::Column::CompanyId,
            person_companies::Column::PersonId,
        ])
        .filter(person_companies::Column::CompanyId.is_in(ids))
        .filter(person_companies::Column::Role.eq(BILLING_CONTACT_ROLE))
        .filter(person_companies::Column::EndedAt.is_null())
        .order_by_desc(person_companies::Column::UpdatedAt)
        .into_tuple()
        .all(&db)
        .await?;
    if links.is_empty() {
        return Ok(HashMap::new());
    }
    let person_ids = distinct(&links.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>());
    let people = people::Entity::find()
        .filter(people::Column::Id.is_in(person_ids))
        .filter(people::Column::DeletedAt.is_null())
        .all(&db)
        .await?;
    let by_id: HashMap<String, Value> = to_json_rows(people)?
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
) -> Result<BillingContactLink, DbErr> {
    use person_companies::Column;
    let now = utc_now();
    let db = orm(db);
    let demoted: Vec<String> = person_companies::Entity::update_many()
        .col_expr(Column::Role, Expr::value(Option::<String>::None))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::CompanyId.eq(company_id))
        .filter(Column::Role.eq(BILLING_CONTACT_ROLE))
        .filter(Column::EndedAt.is_null())
        .filter(Column::PersonId.ne(person_id))
        .exec_with_returning(&db)
        .await?
        .into_iter()
        .map(|link| link.person_id)
        .collect();

    let link: Option<(String, Option<String>)> = person_companies::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Role])
        .filter(Column::CompanyId.eq(company_id))
        .filter(Column::PersonId.eq(person_id))
        .filter(Column::EndedAt.is_null())
        .order_by_desc(Column::UpdatedAt)
        .into_tuple()
        .one(&db)
        .await?;

    if let Some((link_id, role)) = link {
        let role_changed = role.as_deref() != Some(BILLING_CONTACT_ROLE);
        if role_changed {
            person_companies::Entity::update_many()
                .col_expr(Column::Role, Expr::value(BILLING_CONTACT_ROLE))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::Id.eq(&link_id))
                .exec(&db)
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

    let primary: Option<String> = person_companies::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::PersonId.eq(person_id))
        .filter(Column::IsPrimary.eq(true))
        .filter(Column::EndedAt.is_null())
        .into_tuple()
        .one(&db)
        .await?;
    let id = generate_id("pc");
    person_companies::Entity::insert(person_companies::ActiveModel {
        id: Set(id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        person_id: Set(person_id.to_owned()),
        company_id: Set(company_id.to_owned()),
        role: Set(Some(BILLING_CONTACT_ROLE.to_owned())),
        is_primary: Set(primary.is_none()),
        ..Default::default()
    })
    .exec_without_returning(&db)
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
) -> Result<Vec<String>, DbErr> {
    use person_companies::Column;
    let cleared = person_companies::Entity::update_many()
        .col_expr(Column::Role, Expr::value(Option::<String>::None))
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::CompanyId.eq(company_id))
        .filter(Column::Role.eq(BILLING_CONTACT_ROLE))
        .filter(Column::EndedAt.is_null())
        .exec_with_returning(&orm(db))
        .await?;
    Ok(cleared.into_iter().map(|link| link.person_id).collect())
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
) -> Result<ContactSnapshot, DbErr> {
    let Some(contact_id) = contact_id.filter(|id| !id.is_empty()) else {
        return Ok(ContactSnapshot::default());
    };
    let party: Option<(Option<String>, Option<String>, Option<String>)> = parties::Entity::find()
        .select_only()
        .columns([
            parties::Column::DisplayName,
            parties::Column::CompanyId,
            parties::Column::PersonId,
        ])
        .filter(parties::Column::Id.eq(contact_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some((display_name, company_id, person_id)) = party else {
        return Ok(ContactSnapshot::default());
    };

    let mut identity: Option<(Option<String>, Option<String>)> = None;
    if let Some(company_id) = company_id.as_deref().filter(|id| !id.is_empty()) {
        identity = companies::Entity::find()
            .select_only()
            .columns([companies::Column::DisplayName, companies::Column::Email])
            .filter(companies::Column::Id.eq(company_id))
            .into_tuple()
            .one(&orm(db))
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
        identity = people::Entity::find()
            .select_only()
            .columns([people::Column::DisplayName, people::Column::Email])
            .filter(people::Column::Id.eq(person_id))
            .into_tuple()
            .one(&orm(db))
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
) -> Result<ContactSnapshot, DbErr> {
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

/// `withContactEmail(db, row)`: `contactEmail` filled on a document stored
/// without one, from its contact's current address (the PDF does the same).
pub async fn with_contact_email(db: &PgPool, mut row: Value) -> Result<Value, DbErr> {
    let email_set = row["contactEmail"]
        .as_str()
        .is_some_and(|email| !js_trim(email).is_empty());
    let contact_id = row["contactId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let Some(contact_id) = contact_id.filter(|_| !email_set) else {
        return Ok(row);
    };
    if let Some(email) = load_contact_snapshot(db, Some(&contact_id)).await?.email
        && let Value::Object(map) = &mut row
    {
        map.insert("contactEmail".to_owned(), Value::String(email));
    }
    Ok(row)
}

/// `withContactNames(db, rows)`: `contactName` filled on documents stored
/// without one, from their contacts' current names (one query for the lot).
pub async fn with_contact_names(
    db: &PgPool,
    mut rows: Vec<Value>,
) -> Result<Vec<Value>, DbErr> {
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
    let parties: Vec<(String, Option<String>)> = parties::Entity::find()
        .select_only()
        .columns([parties::Column::Id, parties::Column::DisplayName])
        .filter(parties::Column::Id.is_in(ids))
        .into_tuple()
        .all(&orm(db))
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
