//! Hours to invoice (Rust only, edition feature `books-time-billing`, plan
//! weldbooks-connected-ux phase 6, migration M4): WeldFlow's billable time
//! entries, priced and sorted out per customer, and the link that keeps an
//! entry from being billed twice (`time_entries.invoice_id`).
//!
//! # Which entries count
//!
//! A time entry is unbilled when it is live, `billable`, has a project and no
//! `invoice_id`, and its status is neither `rejected` nor `billed`. Approval
//! is **not** required: a workspace that never approves time would otherwise
//! have nothing to invoice, and an entry that is invoiced becomes read-only
//! in WeldFlow anyway (the Rust flow routes refuse to change it). The
//! project must be billable too (`projects.is_billable`).
//!
//! # The customer
//!
//! A project names its customer in `counterparty_id` (the WeldBooks party,
//! as in every WeldCRM table) or the older `customer_id`. Either may hold the
//! party's own id or the id of the CRM company or person the party wraps; the
//! project's `counterparty_id` wins, then `customer_id`, party id before
//! company or person id.
//!
//! # The rate
//!
//! The entry's own `rate`, else the project's `hourly_rate`, else the
//! member's rate on the project (`project_members.hourly_rate`). A rate of
//! zero or none is no rate: the entry is listed with `rateSource: "none"` and
//! an amount of 0, so it is seen and can be priced by hand. `duration` is in
//! minutes, so the hours are `duration / 60`.
//!
//! The currency is the project's `budget_currency`, else the entity's base
//! currency.

use std::collections::{BTreeMap, HashMap, HashSet};

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use time::Date;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_schema::tenant::{
    parties, project_members, projects, time_entries, workspace_members,
};

/// The statuses of a time entry that is not up for invoicing.
pub const NOT_BILLABLE_STATUSES: [&str; 2] = ["rejected", "billed"];

/// Where an entry's rate came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateSource {
    Entry,
    Project,
    Member,
    None,
}

impl RateSource {
    pub fn code(self) -> &'static str {
        match self {
            Self::Entry => "entry",
            Self::Project => "project",
            Self::Member => "member",
            Self::None => "none",
        }
    }
}

/// A time entry with everything an invoice line needs.
#[derive(Debug, Clone)]
pub struct Priced {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    /// The WeldBooks contact the project belongs to.
    pub contact_id: Option<String>,
    pub contact_name: Option<String>,
    pub user_id: String,
    pub user_name: String,
    pub date: Date,
    pub description: Option<String>,
    pub activity: Option<String>,
    pub minutes: f64,
    /// Per hour, in `currency`.
    pub rate: f64,
    pub rate_source: RateSource,
    pub currency: String,
    /// The invoice the entry is already on, if any.
    pub invoice_id: Option<String>,
    pub billable: bool,
    pub status: String,
}

impl Priced {
    pub fn hours(&self) -> f64 {
        self.minutes / 60.0
    }

    /// `hours × rate`, in cents.
    pub fn amount_cents(&self) -> i64 {
        #[allow(clippy::cast_possible_truncation)]
        let cents = (self.minutes / 60.0 * self.rate * 100.0).round() as i64;
        cents
    }

    /// Whether the entry can be invoiced now.
    pub fn is_unbilled(&self) -> bool {
        self.billable
            && self.invoice_id.is_none()
            && !NOT_BILLABLE_STATUSES.contains(&self.status.as_str())
    }
}

/// Cents as `12.50`.
pub fn cents_text(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

/// Hours as `12.5` (at most two decimals, no trailing zeros).
pub fn hours_text(hours: f64) -> String {
    let rounded = (hours * 100.0).round() / 100.0;
    let text = format!("{rounded:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

fn number(value: &sea_orm::prelude::BigDecimal) -> f64 {
    value.to_plain_string().parse::<f64>().unwrap_or(0.0)
}

fn positive(value: Option<&sea_orm::prelude::BigDecimal>) -> Option<f64> {
    value.map(number).filter(|rate| *rate > 0.0)
}

/// What narrows the entries looked at.
#[derive(Debug, Default, Clone)]
pub struct Filter<'a> {
    /// A WeldBooks contact (party).
    pub contact_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    /// Entries up to and including this day.
    pub to: Option<Date>,
}

/// The ids a party goes by in WeldFlow and WeldCRM: its own, its company's
/// and its person's.
async fn identity_ids(db: &PgPool, contact_id: &str) -> Result<Vec<String>, DbErr> {
    let party = parties::Entity::find_by_id(contact_id.to_owned())
        .filter(parties::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    let mut ids = vec![contact_id.to_owned()];
    if let Some(party) = party {
        ids.extend(party.company_id.filter(|id| !id.is_empty()));
        ids.extend(party.person_id.filter(|id| !id.is_empty()));
    }
    Ok(ids)
}

/// The base query: live, billable-looking entries of a project.
fn base_rows() -> sea_orm::Select<time_entries::Entity> {
    time_entries::Entity::find()
        .filter(time_entries::Column::DeletedAt.is_null())
        .filter(time_entries::Column::ProjectId.is_not_null())
}

/// The party each of `projects` is for: the project's `counterparty_id`, then
/// its `customer_id`, as the party's own id first and then as the id of the
/// company or person the party wraps. Projects with no such party are left
/// out.
async fn contacts_of(
    db: &PgPool,
    projects: &[projects::Model],
) -> Result<HashMap<String, (String, String)>, DbErr> {
    let mut keys: HashSet<String> = HashSet::new();
    for project in projects {
        keys.extend(project.counterparty_id.clone().filter(|k| !k.is_empty()));
        keys.extend(project.customer_id.clone().filter(|k| !k.is_empty()));
    }
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let keys: Vec<String> = keys.into_iter().collect();
    let found = parties::Entity::find()
        .filter(parties::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(parties::Column::Id.is_in(keys.clone()))
                .add(parties::Column::CompanyId.is_in(keys.clone()))
                .add(parties::Column::PersonId.is_in(keys)),
        )
        .order_by_asc(parties::Column::CreatedAt)
        .all(&orm(db))
        .await?;
    let mut by_id: HashMap<&str, &parties::Model> = HashMap::new();
    let mut by_company: HashMap<&str, &parties::Model> = HashMap::new();
    let mut by_person: HashMap<&str, &parties::Model> = HashMap::new();
    for party in &found {
        by_id.insert(party.id.as_str(), party);
        if let Some(company) = party.company_id.as_deref() {
            by_company.entry(company).or_insert(party);
        }
        if let Some(person) = party.person_id.as_deref() {
            by_person.entry(person).or_insert(party);
        }
    }
    let mut out = HashMap::new();
    for project in projects {
        for key in [&project.counterparty_id, &project.customer_id]
            .into_iter()
            .flatten()
            .filter(|k| !k.is_empty())
        {
            let party = by_id
                .get(key.as_str())
                .or_else(|| by_company.get(key.as_str()))
                .or_else(|| by_person.get(key.as_str()));
            if let Some(party) = party {
                out.insert(
                    project.id.clone(),
                    (
                        party.id.clone(),
                        party.display_name.clone().unwrap_or_default(),
                    ),
                );
                break;
            }
        }
    }
    Ok(out)
}

/// `rows` with their project, customer, member and rate.
async fn priced(
    db: &PgPool,
    rows: Vec<time_entries::Model>,
    fallback_currency: &str,
) -> Result<Vec<Priced>, DbErr> {
    let project_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.project_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if project_ids.is_empty() {
        return Ok(Vec::new());
    }
    let project_rows = projects::Entity::find()
        .filter(projects::Column::Id.is_in(project_ids.clone()))
        .filter(projects::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    let contacts = contacts_of(db, &project_rows).await?;
    let projects_by_id: HashMap<&str, &projects::Model> = project_rows
        .iter()
        .map(|project| (project.id.as_str(), project))
        .collect();
    let users: Vec<String> = rows
        .iter()
        .map(|row| row.user_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let members = project_members::Entity::find()
        .filter(project_members::Column::ProjectId.is_in(project_ids))
        .filter(project_members::Column::UserId.is_in(users.clone()))
        .filter(project_members::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    let member_rates: HashMap<(&str, &str), f64> = members
        .iter()
        .filter_map(|member| {
            Some((
                (member.project_id.as_str(), member.user_id.as_str()),
                positive(member.hourly_rate.as_ref())?,
            ))
        })
        .collect();
    let names: HashMap<String, String> = workspace_members::Entity::find()
        .filter(workspace_members::Column::UserId.is_in(users))
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|member| {
            let name = member
                .name
                .filter(|n| !n.is_empty())
                .or(member.email)
                .unwrap_or_default();
            (member.user_id, name)
        })
        .collect();
    let mut out = Vec::new();
    for row in rows {
        let Some(project_id) = row.project_id.clone() else {
            continue;
        };
        let Some(project) = projects_by_id.get(project_id.as_str()) else {
            continue;
        };
        let (rate, rate_source) = if let Some(rate) = positive(row.rate.as_ref()) {
            (rate, RateSource::Entry)
        } else if let Some(rate) = positive(project.hourly_rate.as_ref()) {
            (rate, RateSource::Project)
        } else if let Some(rate) = member_rates.get(&(project_id.as_str(), row.user_id.as_str())) {
            (*rate, RateSource::Member)
        } else {
            (0.0, RateSource::None)
        };
        let contact = contacts.get(&project_id);
        out.push(Priced {
            id: row.id,
            project_name: project.name.clone(),
            project_id,
            contact_id: contact.map(|c| c.0.clone()),
            contact_name: contact.map(|c| c.1.clone()),
            user_name: names.get(&row.user_id).cloned().unwrap_or_default(),
            user_id: row.user_id,
            date: row.date,
            description: row.description.filter(|d| !d.trim().is_empty()),
            activity: row.activity.filter(|a| !a.trim().is_empty()),
            minutes: number(&row.duration),
            rate,
            rate_source,
            currency: project
                .budget_currency
                .clone()
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| fallback_currency.to_owned()),
            invoice_id: row.invoice_id,
            billable: row.billable && project.is_billable,
            status: row.status,
        });
    }
    Ok(out)
}

/// The unbilled entries that pass `filter`, oldest first, each with a customer.
///
/// # Errors
///
/// The database's.
pub async fn unbilled_entries(
    db: &PgPool,
    filter: &Filter<'_>,
    fallback_currency: &str,
) -> Result<Vec<Priced>, DbErr> {
    let mut query = base_rows()
        .filter(time_entries::Column::Billable.eq(true))
        .filter(time_entries::Column::InvoiceId.is_null())
        .filter(time_entries::Column::Status.is_not_in(NOT_BILLABLE_STATUSES));
    if let Some(project) = filter.project_id {
        query = query.filter(time_entries::Column::ProjectId.eq(project));
    }
    if let Some(to) = filter.to {
        query = query.filter(time_entries::Column::Date.lte(to));
    }
    if let Some(contact) = filter.contact_id {
        let ids = identity_ids(db, contact).await?;
        let project_ids: Vec<String> = projects::Entity::find()
            .filter(projects::Column::DeletedAt.is_null())
            .filter(
                Condition::any()
                    .add(projects::Column::CounterpartyId.is_in(ids.clone()))
                    .add(projects::Column::CustomerId.is_in(ids)),
            )
            .all(&orm(db))
            .await?
            .into_iter()
            .map(|project| project.id)
            .collect();
        if project_ids.is_empty() {
            return Ok(Vec::new());
        }
        query = query.filter(time_entries::Column::ProjectId.is_in(project_ids));
    }
    let rows = query
        .order_by_asc(time_entries::Column::Date)
        .order_by_asc(time_entries::Column::CreatedAt)
        .order_by_asc(time_entries::Column::Id)
        .all(&orm(db))
        .await?;
    let mut entries = priced(db, rows, fallback_currency).await?;
    entries.retain(|entry| {
        entry.contact_id.is_some()
            && entry.is_unbilled()
            && filter
                .contact_id
                .is_none_or(|wanted| entry.contact_id.as_deref() == Some(wanted))
    });
    Ok(entries)
}

/// The live entries named by `ids`, invoiced or not, in the order of `ids`
/// (missing ones are left out).
///
/// # Errors
///
/// The database's.
pub async fn entries_by_ids(
    db: &PgPool,
    ids: &[String],
    fallback_currency: &str,
) -> Result<Vec<Priced>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = base_rows()
        .filter(time_entries::Column::Id.is_in(ids.to_vec()))
        .all(&orm(db))
        .await?;
    let mut found = priced(db, rows, fallback_currency).await?;
    found.sort_by_key(|entry| ids.iter().position(|id| *id == entry.id));
    Ok(found)
}

/// The unbilled entries as customers, projects and entries
/// (`GET /api/accounting-time/unbilled`). A customer whose projects bill in
/// several currencies is listed once per currency.
pub fn grouped(entries: &[Priced]) -> Vec<Value> {
    type ByProject<'a> = BTreeMap<&'a str, Vec<&'a Priced>>;
    let mut customers: BTreeMap<(String, String, String), ByProject<'_>> = BTreeMap::new();
    for entry in entries {
        let Some(contact) = &entry.contact_id else {
            continue;
        };
        customers
            .entry((
                entry
                    .contact_name
                    .clone()
                    .unwrap_or_default()
                    .to_lowercase(),
                contact.clone(),
                entry.currency.clone(),
            ))
            .or_default()
            .entry(entry.project_id.as_str())
            .or_default()
            .push(entry);
    }
    customers
        .into_iter()
        .map(|((_, contact, currency), by_project)| {
            let mut customer_minutes = 0.0;
            let mut customer_cents = 0;
            let mut name = String::new();
            let mut project_rows = Vec::new();
            for (project_id, list) in by_project {
                let minutes: f64 = list.iter().map(|e| e.minutes).sum();
                let cents: i64 = list.iter().map(|e| e.amount_cents()).sum();
                customer_minutes += minutes;
                customer_cents += cents;
                name = list[0].contact_name.clone().unwrap_or_default();
                project_rows.push(json!({
                    "projectId": project_id,
                    "name": list[0].project_name,
                    "hours": hours_text(minutes / 60.0),
                    "amount": cents_text(cents),
                    "entries": list.iter().map(|e| entry_json(e)).collect::<Vec<_>>(),
                }));
            }
            json!({
                "customer": { "contactId": contact, "name": name },
                "hours": hours_text(customer_minutes / 60.0),
                "amount": cents_text(customer_cents),
                "currency": currency,
                "projects": project_rows,
            })
        })
        .collect()
}

fn entry_json(entry: &Priced) -> Value {
    json!({
        "id": entry.id,
        "date": entry.date.to_string(),
        "userId": entry.user_id,
        "userName": entry.user_name,
        "description": entry.description,
        "activity": entry.activity,
        "hours": hours_text(entry.hours()),
        "rate": cents_text(
            #[allow(clippy::cast_possible_truncation)]
            { (entry.rate * 100.0).round() as i64 }
        ),
        "rateSource": entry.rate_source.code(),
        "amount": cents_text(entry.amount_cents()),
    })
}

/// A contact's unbilled hours for its page: the hours and amount in the
/// currency with the most hours, `None` when there are none.
///
/// # Errors
///
/// The database's.
pub async fn contact_unbilled(
    db: &PgPool,
    contact_id: &str,
    fallback_currency: &str,
) -> Result<Option<Value>, DbErr> {
    let entries = unbilled_entries(
        db,
        &Filter {
            contact_id: Some(contact_id),
            ..Filter::default()
        },
        fallback_currency,
    )
    .await?;
    let mut by_currency: BTreeMap<&str, (f64, i64)> = BTreeMap::new();
    for entry in &entries {
        let slot = by_currency.entry(entry.currency.as_str()).or_default();
        slot.0 += entry.minutes;
        slot.1 += entry.amount_cents();
    }
    Ok(by_currency
        .into_iter()
        .max_by(|a, b| a.1.0.total_cmp(&b.1.0))
        .map(|(currency, (minutes, cents))| {
            json!({
                "hours": hours_text(minutes / 60.0),
                "amount": cents_text(cents),
                "currency": currency,
            })
        }))
}

/// Free the time entries an invoice (or one of its lines) had billed.
///
/// # Errors
///
/// The database's.
pub async fn release_entries<C: sea_orm::ConnectionTrait>(
    conn: &C,
    invoice_id: &str,
    item_ids: Option<&[String]>,
) -> Result<u64, DbErr> {
    let mut update = time_entries::Entity::update_many()
        .col_expr(
            time_entries::Column::InvoiceId,
            Expr::value(Option::<String>::None),
        )
        .col_expr(
            time_entries::Column::InvoiceItemId,
            Expr::value(Option::<String>::None),
        )
        .col_expr(time_entries::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(time_entries::Column::InvoiceId.eq(invoice_id));
    if let Some(items) = item_ids {
        if items.is_empty() {
            return Ok(0);
        }
        update = update.filter(time_entries::Column::InvoiceItemId.is_in(items.to_vec()));
    }
    Ok(update.exec(conn).await?.rows_affected)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    fn entry(id: &str, project: &str, contact: &str, minutes: f64, rate: f64) -> Priced {
        Priced {
            id: id.to_owned(),
            project_id: project.to_owned(),
            project_name: format!("Project {project}"),
            contact_id: Some(contact.to_owned()),
            contact_name: Some(format!("Customer {contact}")),
            user_id: "u1".to_owned(),
            user_name: "Ann".to_owned(),
            date: Date::from_calendar_date(2026, time::Month::November, 24).unwrap(),
            description: Some("Work".to_owned()),
            activity: None,
            minutes,
            rate,
            rate_source: RateSource::Entry,
            currency: "EUR".to_owned(),
            invoice_id: None,
            billable: true,
            status: "draft".to_owned(),
        }
    }

    #[test]
    fn hours_and_cents_are_text() {
        assert_eq!(hours_text(12.5), "12.5");
        assert_eq!(hours_text(2.0), "2");
        assert_eq!(hours_text(0.333_333), "0.33");
        assert_eq!(cents_text(1250), "12.50");
        assert_eq!(cents_text(-5), "-0.05");
    }

    #[test]
    fn an_amount_is_hours_times_rate_in_cents() {
        let e = entry("a", "p", "c", 90.0, 80.0);
        assert!((e.hours() - 1.5).abs() < f64::EPSILON);
        assert_eq!(e.amount_cents(), 12_000);
    }

    #[test]
    fn invoiced_rejected_and_unbillable_entries_are_not_unbilled() {
        let mut e = entry("a", "p", "c", 60.0, 1.0);
        assert!(e.is_unbilled());
        e.invoice_id = Some("inv_1".to_owned());
        assert!(!e.is_unbilled());
        e.invoice_id = None;
        e.status = "rejected".to_owned();
        assert!(!e.is_unbilled());
        e.status = "approved".to_owned();
        assert!(e.is_unbilled());
        e.billable = false;
        assert!(!e.is_unbilled());
    }

    #[test]
    fn entries_group_per_customer_and_project() {
        let entries = vec![
            entry("a", "p1", "c1", 60.0, 100.0),
            entry("b", "p1", "c1", 30.0, 100.0),
            entry("c", "p2", "c1", 60.0, 50.0),
            entry("d", "p3", "c2", 120.0, 10.0),
        ];
        let groups = grouped(&entries);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["customer"]["contactId"], "c1");
        assert_eq!(groups[0]["hours"], "2.5");
        assert_eq!(groups[0]["amount"], "200.00");
        assert_eq!(groups[0]["projects"].as_array().unwrap().len(), 2);
        assert_eq!(
            groups[0]["projects"][0]["entries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(groups[1]["amount"], "20.00");
    }
}
