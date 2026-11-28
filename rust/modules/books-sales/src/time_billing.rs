//! Hours to invoice (Rust only, edition feature `books-time-billing`; plan
//! weldbooks-connected-ux phase 6, migration M4). Which time entries count,
//! who the customer is and which rate applies is
//! [`weldsuite_books_domain::time_billing`].
//!
//! - `GET /api/accounting-time/unbilled?customerId=&projectId=&to=`: the
//!   unbilled entries per customer and project (`invoices:read` and
//!   `time:read`).
//! - `POST /api/invoices/from-time`: invoice chosen entries on a new draft or
//!   a draft of the same customer (`invoices:create` and `time:read`).
//! - `GET /api/accounting-projects/:projectId/finance`: invoiced, unbilled
//!   and costs of a project, per currency.
//!
//! An entry is invoiced once: the invoice and its line are written on the
//! entry (`invoice_id`, `invoice_item_id`) in the transaction that writes
//! the line, only while the entry has no invoice, so two requests cannot both
//! take it. The link is released when the draft is deleted or cancelled, or a
//! line carrying it is removed (see [`plan_carry`]).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};
use time::{Date, Month, OffsetDateTime};
use weldsuite_books_domain::entity_context::{
    request_entity, resolve_entity_base_currency, resolve_entity_id, resolve_requested_entity_id,
};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, json_of, ok, reply,
};
use weldsuite_books_domain::time_billing::{
    self as domain, Filter, Priced, cents_text, entries_by_ids, hours_text, unbilled_entries,
};
use weldsuite_catalogs::entity_events::PROJECT_TIME_ENTRY_UPDATED;
use weldsuite_db::{OrmConn, PgPool, orm, utc_now};
use weldsuite_legal_entities::{
    EntityScopeCondition, entity_scope_condition, request_entity_scope,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    bill_items, bills, entities, invoice_items, invoices, parties, projects, tax_rates,
    time_entries,
};

use crate::body::{InvoiceInput, LineInput, read_line};
use crate::errors::SalesError;
use crate::finalize::{load_invoice, load_items};
use crate::persist::{owned, text};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/unbilled",
            get(unbilled)
                .route_layer(need("time:read"))
                .route_layer(need("invoices:read")),
        )
        .with_state(state)
}

pub(crate) fn projects_router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/{project_id}/finance",
            get(project_finance).route_layer(need("invoices:read")),
        )
        .with_state(state)
}

// ── What is linked to an invoice line ───────────────────────────────────────

/// The entries an invoice line bills, and its project.
#[derive(Debug, Clone)]
pub(crate) struct LineLink {
    /// The line's position in the items the invoice is written with.
    pub index: usize,
    pub project_id: String,
    pub entry_ids: Vec<String>,
}

/// What a write of an invoice links to its new lines.
#[derive(Debug, Clone, Default)]
pub(crate) struct TimeLinks {
    pub lines: Vec<LineLink>,
}

/// The project each answered line carries: the lines `links` names and the
/// old lines that carry on.
pub(crate) fn mark_projects(
    records: &mut [Value],
    links: Option<&TimeLinks>,
    carry: Option<&Carry>,
) {
    let mut put = |index: usize, project: &str| {
        if let Some(Value::Object(record)) = records.get_mut(index) {
            record.insert("projectId".into(), json!(project));
        }
    };
    if let Some(carry) = carry {
        for (index, old) in &carry.inherit {
            if let Some(project) = &old.project_id {
                put(*index, project);
            }
        }
    }
    if let Some(links) = links {
        for line in &links.lines {
            put(line.index, &line.project_id);
        }
    }
}

/// Inside the transaction that wrote the lines `item_ids`: put the project on
/// each linked line and claim its entries, only those that have no invoice.
///
/// # Errors
///
/// A conflict (409) when an entry went to another invoice meanwhile; the
/// caller's transaction is then dropped, so nothing is written.
pub(crate) async fn link_lines(
    conn: &OrmConn<'_>,
    invoice_id: &str,
    item_ids: &[String],
    links: &TimeLinks,
) -> Result<(), Refusal> {
    for link in &links.lines {
        let Some(item_id) = item_ids.get(link.index) else {
            continue;
        };
        invoice_items::Entity::update_many()
            .col_expr(
                invoice_items::Column::ProjectId,
                Expr::value(link.project_id.clone()),
            )
            .filter(invoice_items::Column::Id.eq(item_id.as_str()))
            .exec(conn)
            .await?;
        let claimed = time_entries::Entity::update_many()
            .col_expr(
                time_entries::Column::InvoiceId,
                Expr::value(invoice_id.to_owned()),
            )
            .col_expr(
                time_entries::Column::InvoiceItemId,
                Expr::value(item_id.clone()),
            )
            .col_expr(time_entries::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(time_entries::Column::Id.is_in(link.entry_ids.clone()))
            .filter(time_entries::Column::InvoiceId.is_null())
            .filter(time_entries::Column::DeletedAt.is_null())
            .exec(conn)
            .await?;
        if usize::try_from(claimed.rows_affected).unwrap_or(0) != link.entry_ids.len() {
            return Err(Refusal::conflict(
                "One or more time entries are already invoiced",
            ));
        }
    }
    Ok(())
}

/// What an edit of a draft's lines does to the entries the old lines billed.
#[derive(Debug, Default)]
pub(crate) struct Carry {
    /// `(new line position, the old line it continues)`.
    pub inherit: Vec<(usize, invoice_items::Model)>,
    /// The old lines whose entries are released.
    pub release: Vec<String>,
}

/// A line of an old set and one of the new set are the same line when the
/// old one bills time (it has a project) and the description and the unit
/// price are equal: the form sent it back as it was (the hours may differ).
fn same_line(old: &invoice_items::Model, description: &str, unit_price: &str) -> bool {
    old.project_id.is_some()
        && old.description == description
        && old.unit_price.to_plain_string().parse::<f64>().ok()
            == unit_price.trim().parse::<f64>().ok()
}

/// Which old lines carry on in the new set of lines (`new`: description and
/// unit price by position; `explicit`: positions linked by this very write,
/// which need no old line), and which are gone.
pub(crate) fn plan_carry_of(
    old: &[invoice_items::Model],
    new: &[(String, String)],
    explicit: &HashSet<usize>,
) -> Carry {
    let mut taken: HashSet<usize> = HashSet::new();
    let mut inherit = Vec::new();
    for (index, (description, price)) in new.iter().enumerate() {
        if explicit.contains(&index) {
            continue;
        }
        if let Some(found) = old
            .iter()
            .enumerate()
            .find(|(i, line)| !taken.contains(i) && same_line(line, description, price))
            .map(|(i, _)| i)
        {
            taken.insert(found);
            inherit.push((index, old[found].clone()));
        }
    }
    let release = old
        .iter()
        .enumerate()
        .filter(|(i, _)| !taken.contains(i))
        .map(|(_, line)| line.id.clone())
        .collect();
    Carry { inherit, release }
}

/// Before an edit replaces the lines of a draft: how the entries it bills
/// carry over. `None` when the invoice bills no time (the common case): the
/// edit then does nothing extra.
///
/// # Errors
///
/// The database's.
pub(crate) async fn plan_carry(
    db: &PgPool,
    invoice_id: &str,
    new: &[(String, String)],
    explicit: &HashSet<usize>,
) -> Result<Option<Carry>, DbErr> {
    let billed = time_entries::Entity::find()
        .filter(time_entries::Column::InvoiceId.eq(invoice_id))
        .limit(1)
        .all(&orm(db))
        .await?;
    if billed.is_empty() {
        return Ok(None);
    }
    let old = invoice_items::Entity::find()
        .filter(invoice_items::Column::InvoiceId.eq(invoice_id))
        .filter(invoice_items::Column::DeletedAt.is_null())
        .order_by_asc(invoice_items::Column::SortOrder)
        .all(&orm(db))
        .await?;
    Ok(Some(plan_carry_of(&old, new, explicit)))
}

/// Inside the transaction, after the new lines `item_ids` are written: the
/// continuing lines get their project and their entries, the removed lines'
/// entries are freed.
///
/// # Errors
///
/// The database's.
pub(crate) async fn apply_carry(
    conn: &OrmConn<'_>,
    invoice_id: &str,
    item_ids: &[String],
    carry: &Carry,
) -> Result<(), DbErr> {
    for (index, old) in &carry.inherit {
        let Some(new_id) = item_ids.get(*index) else {
            continue;
        };
        if let Some(project) = &old.project_id {
            invoice_items::Entity::update_many()
                .col_expr(
                    invoice_items::Column::ProjectId,
                    Expr::value(project.clone()),
                )
                .filter(invoice_items::Column::Id.eq(new_id.as_str()))
                .exec(conn)
                .await?;
        }
        time_entries::Entity::update_many()
            .col_expr(
                time_entries::Column::InvoiceItemId,
                Expr::value(new_id.clone()),
            )
            .filter(time_entries::Column::InvoiceId.eq(invoice_id))
            .filter(time_entries::Column::InvoiceItemId.eq(old.id.as_str()))
            .exec(conn)
            .await?;
    }
    if !carry.release.is_empty() {
        domain::release_entries(conn, invoice_id, Some(&carry.release)).await?;
    }
    Ok(())
}

// ── GET /api/accounting-time/unbilled ───────────────────────────────────────

async fn base_currency(caller: &Caller) -> Result<String, DbErr> {
    Ok(match resolve_entity_id(caller).await? {
        Some(entity) => resolve_entity_base_currency(&caller.db, &entity)
            .await
            .unwrap_or_else(|_| "EUR".to_owned()),
        None => "EUR".to_owned(),
    })
}

async fn unbilled(caller: Caller) -> Response {
    reply(
        async {
            let q = caller.query();
            let to = match q.present("to") {
                None => None,
                Some(raw) => Some(
                    Date::parse(
                        raw,
                        time::macros::format_description!("[year]-[month]-[day]"),
                    )
                    .map_err(|_| Refusal::bad_request("to must be a date (YYYY-MM-DD)"))?,
                ),
            };
            let currency = base_currency(&caller).await?;
            let entries = unbilled_entries(
                &caller.db,
                &Filter {
                    contact_id: q.present("customerId"),
                    project_id: q.present("projectId"),
                    to,
                },
                &currency,
            )
            .await?;
            Ok(ok(Value::Array(domain::grouped(&entries))))
        }
        .await,
        "Failed to fetch the unbilled time",
    )
}

// ── POST /api/invoices/from-time ────────────────────────────────────────────

/// How the entries become lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Grouping {
    /// A line per project.
    Project,
    /// A line per project and person.
    Person,
    /// A line per project and activity.
    Activity,
    /// A line per entry.
    Entry,
}

/// The checked body of `from-time`.
#[derive(Debug)]
pub(crate) struct FromTime {
    pub entry_ids: Vec<String>,
    pub grouping: Grouping,
    pub invoice_id: Option<String>,
    pub entity_id: Option<String>,
}

pub(crate) fn read_from_time(body: &Value) -> Result<FromTime, Refusal> {
    let Some(fields) = body.as_object() else {
        return Err(Refusal::bad_request("The body must be an object"));
    };
    let ids = match fields.get("timeEntryIds") {
        Some(Value::Array(list)) if !list.is_empty() && list.len() <= 500 => {
            let mut ids: Vec<String> = Vec::new();
            for id in list {
                let id = id
                    .as_str()
                    .map(str::trim)
                    .filter(|id| !id.is_empty() && id.len() <= 255)
                    .ok_or_else(|| Refusal::bad_request("timeEntryIds must be ids"))?;
                if !ids.iter().any(|known| known == id) {
                    ids.push(id.to_owned());
                }
            }
            ids
        }
        _ => {
            return Err(Refusal::bad_request(
                "timeEntryIds must hold 1 to 500 time entry ids",
            ));
        }
    };
    let grouping = match fields.get("grouping").and_then(Value::as_str) {
        Some("project") => Grouping::Project,
        Some("person") => Grouping::Person,
        Some("activity") => Grouping::Activity,
        Some("entry") => Grouping::Entry,
        _ => {
            return Err(Refusal::bad_request(
                "grouping must be project, person, activity or entry",
            ));
        }
    };
    let optional_id = |key: &str| -> Result<Option<String>, Refusal> {
        match fields.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(id)) if !id.trim().is_empty() && id.len() <= 30 => {
                Ok(Some(id.trim().to_owned()))
            }
            Some(_) => Err(Refusal::bad_request(format!("{key} must be an id"))),
        }
    };
    Ok(FromTime {
        entry_ids: ids,
        grouping,
        invoice_id: optional_id("invoiceId")?,
        entity_id: optional_id("entityId")?,
    })
}

/// One invoice line made of entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Line {
    pub project_id: String,
    pub description: String,
    /// Hours, to four decimals without trailing zeros.
    pub quantity: String,
    pub unit_price: String,
    pub entry_ids: Vec<String>,
}

const MONTHS_EN: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_NL: [&str; 12] = [
    "jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec",
];

fn month_name(month: Month, locale: &str) -> &'static str {
    let names = if locale == "nl" {
        &MONTHS_NL
    } else {
        &MONTHS_EN
    };
    names[usize::from(u8::from(month)) - 1]
}

/// `24 Nov`, `24–26 Nov`, `28 Nov – 2 Dec`, `28 Dec 2025 – 2 Jan 2026`.
pub(crate) fn date_range(first: Date, last: Date, locale: &str) -> String {
    let day = |d: Date| format!("{} {}", d.day(), month_name(d.month(), locale));
    if first == last {
        return day(first);
    }
    if first.year() != last.year() {
        return format!(
            "{} {} – {} {}",
            day(first),
            first.year(),
            day(last),
            last.year()
        );
    }
    if first.month() == last.month() {
        return format!(
            "{}–{} {}",
            first.day(),
            last.day(),
            month_name(first.month(), locale)
        );
    }
    format!("{} – {}", day(first), day(last))
}

/// `minutes` as hours with at most four decimals: `12.5`, `0.1167`.
fn quantity_text(minutes: f64) -> String {
    let text = format!("{:.4}", (minutes / 60.0 * 10_000.0).round() / 10_000.0);
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// The entries as invoice lines: one per group of the `grouping` and per
/// rate (a line has one unit price), oldest group first within a project.
pub(crate) fn group_lines(entries: &[Priced], grouping: Grouping, locale: &str) -> Vec<Line> {
    type Key = (String, String, String, i64);
    let mut groups: BTreeMap<Key, Vec<&Priced>> = BTreeMap::new();
    for entry in entries {
        let sub = match grouping {
            Grouping::Project => String::new(),
            Grouping::Person => entry.user_id.clone(),
            Grouping::Activity => entry.activity.clone().unwrap_or_default(),
            Grouping::Entry => entry.id.clone(),
        };
        #[allow(clippy::cast_possible_truncation)]
        let rate = (entry.rate * 100.0).round() as i64;
        groups
            .entry((
                entry.project_name.clone(),
                entry.project_id.clone(),
                sub,
                rate,
            ))
            .or_default()
            .push(entry);
    }
    let mut lines: Vec<(Date, Line)> = Vec::new();
    for ((project_name, project_id, _, rate), mut list) in groups {
        list.sort_by_key(|e| (e.date, e.id.clone()));
        let (first, last) = (list[0].date, list[list.len() - 1].date);
        let minutes: f64 = list.iter().map(|e| e.minutes).sum();
        let hours = {
            let text = hours_text(minutes / 60.0);
            if locale == "nl" {
                text.replace('.', ",")
            } else {
                text
            }
        };
        let range = date_range(first, last, locale);
        let mut parts = vec![project_name];
        if grouping == Grouping::Person {
            parts.push(list[0].user_name.clone());
        } else if grouping == Grouping::Activity {
            parts.extend(list[0].activity.clone());
        }
        parts.push(range);
        if grouping == Grouping::Entry {
            let detail = list[0]
                .description
                .clone()
                .or_else(|| list[0].activity.clone())
                .or_else(|| Some(list[0].user_name.clone()).filter(|n| !n.is_empty()));
            parts.extend(detail);
        }
        parts.retain(|p| !p.is_empty());
        parts.push(format!("{hours} h"));
        lines.push((
            first,
            Line {
                project_id,
                description: parts.join(" · "),
                quantity: quantity_text(minutes),
                unit_price: cents_text(rate),
                entry_ids: list.iter().map(|e| e.id.clone()).collect(),
            },
        ));
    }
    // Projects stay together (the map's order); inside one, oldest first.
    let mut position: HashMap<String, usize> = HashMap::new();
    for (_, line) in &lines {
        let next = position.len();
        position.entry(line.project_id.clone()).or_insert(next);
    }
    lines.sort_by_key(|(first, line)| (position[&line.project_id], *first));
    lines.into_iter().map(|(_, line)| line).collect()
}

fn terms_days(terms: Option<&str>) -> i64 {
    terms
        .map(|t| t.chars().filter(char::is_ascii_digit).collect::<String>())
        .and_then(|d| d.parse::<i64>().ok())
        .filter(|d| (0..=365).contains(d))
        .unwrap_or(14)
}

pub(crate) async fn from_time(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let parsed = read_from_time(&json_of(&headers, &body)?)?;
        invoice_from_time(&caller, &state, parsed)
            .await
            .map_err(Refusal::from)
    }
    .await;
    reply(result, "Failed to create the invoice from time")
}

/// The sales tax rate the lines carry: the customer's stored default, else
/// the entity's default sales rate; none leaves the line untaxed for the
/// owner to set on the draft.
async fn line_tax_rate(
    db: &PgPool,
    entity_id: &str,
    party: &parties::Model,
) -> Result<Option<String>, DbErr> {
    if let Some(id) = party
        .default_tax_rate_id
        .clone()
        .filter(|id| !id.is_empty())
    {
        let found = tax_rates::Entity::find_by_id(id.clone())
            .filter(tax_rates::Column::DeletedAt.is_null())
            .filter(tax_rates::Column::EntityId.eq(entity_id))
            .one(&orm(db))
            .await?;
        if found.is_some() {
            return Ok(Some(id));
        }
    }
    Ok(tax_rates::Entity::find()
        .filter(tax_rates::Column::EntityId.eq(entity_id))
        .filter(tax_rates::Column::DeletedAt.is_null())
        .filter(tax_rates::Column::IsDefault.eq(true))
        .filter(tax_rates::Column::IsActive.eq(true))
        .filter(tax_rates::Column::Type.is_in(["sales", "both"]))
        .order_by_asc(tax_rates::Column::CreatedAt)
        .one(&orm(db))
        .await?
        .map(|rate| rate.id))
}

async fn entity_locale(db: &PgPool, entity_id: &str) -> Result<&'static str, DbErr> {
    let locale: Option<String> = entities::Entity::find_by_id(entity_id.to_owned())
        .select_only()
        .column(entities::Column::Locale)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(weldsuite_books_domain::email_templates::locale_of(
        locale.as_deref(),
    ))
}

#[allow(
    clippy::too_many_lines,
    reason = "the route's checks, lines and write in order"
)]
pub(crate) async fn invoice_from_time(
    caller: &Caller,
    state: &BooksState,
    body: FromTime,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    // The target: a draft of the request's choosing, or a new one.
    let existing = match &body.invoice_id {
        Some(id) => {
            let Some(invoice) = load_invoice(db, id).await? else {
                return Err(Refusal::not_found("Invoice", id).into());
            };
            let entity = text(&invoice, "entityId").unwrap_or_default().to_owned();
            if resolve_requested_entity_id(caller, Some(&entity))
                .await?
                .is_none()
            {
                return Err(Refusal::not_found("Invoice", id).into());
            }
            if text(&invoice, "status") != Some("draft") {
                return Err(Refusal::bad_request(
                    "Only a draft invoice can take more lines — finalized invoices are immutable.",
                )
                .into());
            }
            if text(&invoice, "type").is_some_and(|t| t != "standard") {
                return Err(
                    Refusal::bad_request("Hours can only be added to a standard invoice").into(),
                );
            }
            Some(invoice)
        }
        None => None,
    };
    let entity_id = match &existing {
        Some(invoice) => text(invoice, "entityId").unwrap_or_default().to_owned(),
        None => resolve_requested_entity_id(caller, body.entity_id.as_deref())
            .await?
            .ok_or_else(|| {
                Refusal::bad_request(
                    "No accounting entity resolved — name one in entityId or configure a default entity.",
                )
            })?,
    };
    if let (Some(named), Some(_)) = (&body.entity_id, &existing)
        && *named != entity_id
    {
        return Err(
            Refusal::bad_request("The invoice belongs to another accounting entity").into(),
        );
    }
    let base = resolve_entity_base_currency(db, &entity_id).await?;

    // The entries: all there, none invoiced, all billable, one customer.
    let entries = entries_by_ids(db, &body.entry_ids, &base).await?;
    let missing: Vec<&String> = body
        .entry_ids
        .iter()
        .filter(|id| !entries.iter().any(|e| e.id == **id))
        .collect();
    if !missing.is_empty() {
        return Err(Refusal::bad_request_with(
            "Some time entries were not found",
            json!({ "timeEntryIds": missing }),
        )
        .into());
    }
    let invoiced: Vec<&str> = entries
        .iter()
        .filter(|e| e.invoice_id.is_some())
        .map(|e| e.id.as_str())
        .collect();
    if !invoiced.is_empty() {
        return Err(Refusal::conflict_with(
            "Some time entries are already invoiced",
            json!({ "timeEntryIds": invoiced }),
        )
        .into());
    }
    let unbillable: Vec<&str> = entries
        .iter()
        .filter(|e| !e.is_unbilled())
        .map(|e| e.id.as_str())
        .collect();
    if !unbillable.is_empty() {
        return Err(Refusal::bad_request_with(
            "Some time entries cannot be invoiced (not billable, or rejected)",
            json!({ "timeEntryIds": unbillable }),
        )
        .into());
    }
    let customers: HashSet<Option<&str>> =
        entries.iter().map(|e| e.contact_id.as_deref()).collect();
    let Some(Some(contact_id)) = (customers.len() == 1)
        .then(|| customers.into_iter().next())
        .flatten()
    else {
        return Err(Refusal::bad_request(
            "The time entries must all belong to one customer (a project with a customer)",
        )
        .into());
    };
    let contact_id = contact_id.to_owned();
    let currencies: HashSet<&str> = entries.iter().map(|e| e.currency.as_str()).collect();
    if currencies.len() != 1 {
        return Err(Refusal::bad_request("The time entries must all bill in one currency").into());
    }
    let currency = entries[0].currency.clone();
    if let Some(invoice) = &existing {
        if text(invoice, "contactId") != Some(contact_id.as_str()) {
            return Err(Refusal::bad_request("The invoice is for another customer").into());
        }
        let invoice_currency = text(invoice, "currency").unwrap_or(&base);
        if invoice_currency != currency {
            return Err(Refusal::bad_request(format!(
                "The invoice is in {invoice_currency}, the time entries bill in {currency}"
            ))
            .into());
        }
    }

    let party = parties::Entity::find_by_id(contact_id.clone())
        .filter(parties::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .ok_or_else(|| Refusal::bad_request("The customer is not a WeldBooks contact"))?;
    let locale = entity_locale(db, &entity_id).await?;
    let tax_rate_id = line_tax_rate(db, &entity_id, &party).await?;
    let billed = group_lines(&entries, body.grouping, locale);
    let new_inputs: Vec<LineInput> = billed
        .iter()
        .map(|line| LineInput {
            description: line.description.clone(),
            quantity: line.quantity.clone(),
            unit_price: line.unit_price.clone(),
            unit: Some("h".to_owned()),
            discount_percent: "0".to_owned(),
            tax_rate_id: tax_rate_id.clone(),
            account_id: party
                .default_revenue_account_id
                .clone()
                .filter(|a| !a.is_empty()),
            ..LineInput::default()
        })
        .collect();

    let (response, invoice_id) = if let Some(invoice) = existing {
        // The lines already there go back as they are, the new ones after them.
        let id = text(&invoice, "id").unwrap_or_default().to_owned();
        let stored = load_items(db, &id, true).await?;
        let mut items: Vec<LineInput> = Vec::new();
        for stored_line in &stored {
            let mut issues = weldsuite_kit::validation::Issues::default();
            let Some(line) = read_line(&mut issues, stored_line) else {
                return Err(
                    Refusal::Internal("A stored invoice line could not be read".into()).into(),
                );
            };
            items.push(line);
        }
        let base_index = items.len();
        items.extend(new_inputs);
        let links = TimeLinks {
            lines: billed
                .iter()
                .enumerate()
                .map(|(i, line)| LineLink {
                    index: base_index + i,
                    project_id: line.project_id.clone(),
                    entry_ids: line.entry_ids.clone(),
                })
                .collect(),
        };
        let data = InvoiceInput {
            items: Some(items),
            ..InvoiceInput::default()
        };
        let response =
            crate::invoices::write::update_with_links(caller, state, &id, data, Some(&links))
                .await?;
        (response, id)
    } else {
        let today = OffsetDateTime::now_utc();
        let days = terms_days(party.payment_terms.as_deref());
        let links = TimeLinks {
            lines: billed
                .iter()
                .enumerate()
                .map(|(i, line)| LineLink {
                    index: i,
                    project_id: line.project_id.clone(),
                    entry_ids: line.entry_ids.clone(),
                })
                .collect(),
        };
        let input = InvoiceInput {
            status: Some("draft".to_owned()),
            contact_id: Some(contact_id.clone()),
            issue_date: Some(weldsuite_events::iso_timestamp(today)),
            due_date: Some(weldsuite_events::iso_timestamp(
                today + time::Duration::days(days),
            )),
            currency: Some(currency.clone()),
            payment_terms_days: Some(f64::from(u32::try_from(days).unwrap_or(14))),
            items: Some(new_inputs),
            ..InvoiceInput::default()
        };
        let invoice = crate::invoices::write::create_in_entity_with(
            caller,
            state,
            input,
            entity_id.clone(),
            Some(&links),
        )
        .await?;
        let id = owned(&invoice, "id").unwrap_or_default();
        (created(invoice), id)
    };

    // The entries changed: announce it (the invoice's own events came with the write).
    for entry in &entries {
        caller.publish(
            state,
            PROJECT_TIME_ENTRY_UPDATED,
            &entry.id,
            json!({
                "id": entry.id,
                "projectId": entry.project_id,
                "userId": entry.user_id,
                "duration": entry.minutes,
                "invoiceId": invoice_id,
            }),
        );
    }
    Ok(response)
}

// ── GET /api/accounting-projects/:projectId/finance ─────────────────────────

async fn entity_scope(caller: &Caller) -> Result<EntityScopeCondition, DbErr> {
    let request = request_entity(caller).await?;
    Ok(entity_scope_condition(
        request_entity_scope(&request).as_deref(),
        None,
    ))
}

fn cents(amount: Option<&sea_orm::prelude::BigDecimal>) -> i64 {
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

fn sums(map: &BTreeMap<String, (i64, u64)>) -> Value {
    Value::Array(
        map.iter()
            .map(|(currency, (amount, count))| {
                json!({ "currency": currency, "amount": cents_text(*amount), "count": count })
            })
            .collect(),
    )
}

/// Invoice statuses that count as invoiced: issued, not cancelled.
const ISSUED: [&str; 6] = [
    "sent",
    "finalized",
    "partial",
    "overdue",
    "paid",
    "uncollectible",
];
/// Bill statuses that count as cost.
const COUNTED_BILLS: [&str; 4] = ["approved", "partial", "overdue", "paid"];

async fn project_finance(caller: Caller, Path(project_id): Path<String>) -> Response {
    reply(
        finance_of(&caller, &project_id).await,
        "Failed to fetch the project finance",
    )
}

async fn finance_of(caller: &Caller, project_id: &str) -> Reply {
    let scope = entity_scope(caller).await?;
    finance_in(caller, &scope, project_id).await
}

/// [`finance_of`] over the documents of the entities `scope` allows.
#[allow(
    clippy::too_many_lines,
    reason = "invoiced, draft, unbilled and costs one after another"
)]
async fn finance_in(caller: &Caller, scope: &EntityScopeCondition, project_id: &str) -> Reply {
    let db = orm(&caller.db);
    let Some(project) = projects::Entity::find_by_id(project_id.to_owned())
        .filter(projects::Column::DeletedAt.is_null())
        .one(&db)
        .await?
    else {
        return Err(Refusal::not_found("Project", project_id));
    };
    let base = base_currency(caller).await?;

    let lines = invoice_items::Entity::find()
        .filter(invoice_items::Column::ProjectId.eq(project_id))
        .filter(invoice_items::Column::DeletedAt.is_null())
        .all(&db)
        .await?;
    let invoice_ids: Vec<String> = lines.iter().map(|l| l.invoice_id.clone()).collect();
    let documents: HashMap<String, invoices::Model> = if invoice_ids.is_empty() {
        HashMap::new()
    } else {
        invoices::Entity::find()
            .filter(invoices::Column::Id.is_in(invoice_ids))
            .filter(invoices::Column::DeletedAt.is_null())
            .filter(scope.condition(invoices::Column::EntityId))
            .all(&db)
            .await?
            .into_iter()
            .map(|invoice| (invoice.id.clone(), invoice))
            .collect()
    };
    let mut invoiced: BTreeMap<String, (i64, u64)> = BTreeMap::new();
    let mut draft: BTreeMap<String, (i64, u64)> = BTreeMap::new();
    for line in &lines {
        let Some(invoice) = documents.get(&line.invoice_id) else {
            continue;
        };
        let sign = if invoice.type_ == "credit_note" {
            -1
        } else {
            1
        };
        let currency = invoice.currency.clone().unwrap_or_else(|| base.clone());
        let target = if invoice.status == "draft" {
            &mut draft
        } else if ISSUED.contains(&invoice.status.as_str()) {
            &mut invoiced
        } else {
            continue;
        };
        let slot = target.entry(currency).or_default();
        slot.0 += sign * cents(line.line_total.as_ref());
        slot.1 += 1;
    }

    let mut out = Map::new();
    out.insert("projectId".into(), json!(project.id));
    out.insert("invoiced".into(), sums(&invoiced));
    out.insert("draft".into(), sums(&draft));

    if caller.can("time:read") {
        let entries = unbilled_entries(
            &caller.db,
            &Filter {
                project_id: Some(project_id),
                ..Filter::default()
            },
            &base,
        )
        .await?;
        let mut by_currency: BTreeMap<String, (f64, i64)> = BTreeMap::new();
        for entry in &entries {
            let slot = by_currency.entry(entry.currency.clone()).or_default();
            slot.0 += entry.minutes;
            slot.1 += entry.amount_cents();
        }
        out.insert(
            "unbilled".into(),
            Value::Array(
                by_currency
                    .into_iter()
                    .map(|(currency, (minutes, amount))| {
                        json!({
                            "currency": currency,
                            "hours": hours_text(minutes / 60.0),
                            "amount": cents_text(amount),
                        })
                    })
                    .collect(),
            ),
        );
    }

    if caller.can("bills:read") {
        let items = bill_items::Entity::find()
            .filter(bill_items::Column::ProjectId.eq(project_id))
            .filter(bill_items::Column::DeletedAt.is_null())
            .all(&db)
            .await?;
        let bill_ids: Vec<String> = items.iter().map(|i| i.bill_id.clone()).collect();
        let documents: HashMap<String, bills::Model> = if bill_ids.is_empty() {
            HashMap::new()
        } else {
            bills::Entity::find()
                .filter(bills::Column::Id.is_in(bill_ids))
                .filter(bills::Column::DeletedAt.is_null())
                .filter(bills::Column::Status.is_in(COUNTED_BILLS))
                .filter(scope.condition(bills::Column::EntityId))
                .all(&db)
                .await?
                .into_iter()
                .map(|bill| (bill.id.clone(), bill))
                .collect()
        };
        let mut costs: BTreeMap<String, (i64, u64)> = BTreeMap::new();
        for item in &items {
            let Some(bill) = documents.get(&item.bill_id) else {
                continue;
            };
            let sign = if bill.type_ == "credit_note" { -1 } else { 1 };
            let slot = costs
                .entry(bill.currency.clone().unwrap_or_else(|| base.clone()))
                .or_default();
            slot.0 += sign * cents(item.line_total.as_ref());
            slot.1 += 1;
        }
        out.insert("costs".into(), sums(&costs));
    }
    Ok(ok(Value::Object(out)))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use time::macros::date;

    use super::*;
    use weldsuite_books_domain::time_billing::RateSource;

    fn entry(id: &str, project: &str, user: &str, day: Date, minutes: f64, rate: f64) -> Priced {
        Priced {
            id: id.to_owned(),
            project_id: project.to_owned(),
            project_name: format!("Project {project}"),
            contact_id: Some("pty_1".to_owned()),
            contact_name: Some("Acme".to_owned()),
            user_id: user.to_owned(),
            user_name: user.to_uppercase(),
            date: day,
            description: Some(format!("Work {id}")),
            activity: Some("Design".to_owned()),
            minutes,
            rate,
            rate_source: RateSource::Entry,
            currency: "EUR".to_owned(),
            invoice_id: None,
            billable: true,
            status: "draft".to_owned(),
        }
    }

    fn sample() -> Vec<Priced> {
        vec![
            entry("a", "x", "ann", date!(2026 - 11 - 24), 240.0, 100.0),
            entry("b", "x", "bob", date!(2026 - 11 - 25), 270.0, 100.0),
            entry("c", "x", "ann", date!(2026 - 11 - 26), 240.0, 100.0),
            entry("d", "y", "ann", date!(2026 - 11 - 26), 60.0, 50.0),
        ]
    }

    #[test]
    fn a_date_range_reads_short() {
        assert_eq!(
            date_range(date!(2026 - 11 - 24), date!(2026 - 11 - 24), "en"),
            "24 Nov"
        );
        assert_eq!(
            date_range(date!(2026 - 11 - 24), date!(2026 - 11 - 26), "en"),
            "24–26 Nov"
        );
        assert_eq!(
            date_range(date!(2026 - 11 - 28), date!(2026 - 12 - 2), "nl"),
            "28 nov – 2 dec"
        );
        assert_eq!(
            date_range(date!(2025 - 12 - 28), date!(2026 - 1 - 2), "en"),
            "28 Dec 2025 – 2 Jan 2026"
        );
    }

    #[test]
    fn grouped_by_project_a_line_is_hours_times_rate() {
        let lines = group_lines(&sample(), Grouping::Project, "en");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].description, "Project x · 24–26 Nov · 12.5 h");
        assert_eq!(lines[0].quantity, "12.5");
        assert_eq!(lines[0].unit_price, "100.00");
        assert_eq!(lines[0].entry_ids, vec!["a", "b", "c"]);
        assert_eq!(lines[1].description, "Project y · 26 Nov · 1 h");
        assert_eq!(lines[1].project_id, "y");
    }

    #[test]
    fn grouped_by_person_activity_and_entry() {
        let by_person = group_lines(&sample(), Grouping::Person, "en");
        assert_eq!(by_person.len(), 3);
        assert_eq!(
            by_person[0].description,
            "Project x · ANN · 24–26 Nov · 8 h"
        );
        assert_eq!(by_person[0].entry_ids, vec!["a", "c"]);
        let by_activity = group_lines(&sample(), Grouping::Activity, "en");
        assert_eq!(by_activity.len(), 2);
        assert_eq!(
            by_activity[0].description,
            "Project x · Design · 24–26 Nov · 12.5 h"
        );
        let by_entry = group_lines(&sample(), Grouping::Entry, "nl");
        assert_eq!(by_entry.len(), 4);
        assert_eq!(
            by_entry[1].description,
            "Project x · 25 nov · Work b · 4,5 h"
        );
        assert_eq!(by_entry[1].quantity, "4.5");
    }

    #[test]
    fn another_rate_is_another_line() {
        let mut entries = sample();
        entries[1].rate = 120.0;
        let lines = group_lines(&entries, Grouping::Project, "en");
        assert_eq!(lines.len(), 3);
        assert!(
            lines
                .iter()
                .any(|l| l.unit_price == "120.00" && l.entry_ids == vec!["b"])
        );
    }

    #[test]
    fn quantities_keep_four_decimals() {
        assert_eq!(quantity_text(7.0), "0.1167");
        assert_eq!(quantity_text(150.0), "2.5");
        assert_eq!(quantity_text(60.0), "1");
    }

    #[test]
    fn the_body_is_checked() {
        let ok = read_from_time(&json!({ "timeEntryIds": ["a", "a", "b"], "grouping": "person" }))
            .unwrap();
        assert_eq!(ok.entry_ids, vec!["a", "b"]);
        assert_eq!(ok.grouping, Grouping::Person);
        for bad in [
            json!({}),
            json!({ "timeEntryIds": [], "grouping": "project" }),
            json!({ "timeEntryIds": ["a"] }),
            json!({ "timeEntryIds": ["a"], "grouping": "day" }),
            json!({ "timeEntryIds": [1], "grouping": "entry" }),
            json!({ "timeEntryIds": ["a"], "grouping": "entry", "invoiceId": 5 }),
        ] {
            assert!(read_from_time(&bad).is_err(), "{bad}");
        }
    }
}

#[cfg(test)]
mod db_tests;
