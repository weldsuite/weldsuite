//! People (`@weldsuite/crm-domain/people`): the identity layer for
//! individuals. Stamps `displayName` on every write; keeps the wrapping
//! `parties` row (WeldBooks customer/supplier) in step with the person, as
//! [`crate::companies`] does for companies.

use std::collections::HashMap;

use sea_orm::sea_query::{Expr, Func, NullOrdering};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, EntityTrait, FromQueryResult, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde::Serialize;
use serde_json::{Map, Value, json, to_value};
use time::PrimitiveDateTime;
use weldsuite_core_domain::custom_field_values as cfv;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_trim;
use weldsuite_schema::tenant::{
    companies, crm_activities, helpdesk_tickets, list_members, lists, parties, people,
    person_companies,
};

use crate::companies::{BulkFields, list_kind, list_member_ids};
use crate::tables::{PARTIES, PEOPLE, insert_row, update_rows};
use crate::validation::{
    assert_valid_member_fields, before_row, compute_changes, count, decode_list_cursor,
    encode_list_cursor, probe_limit, search_match, sort_order, sort_value,
};
use crate::{DomainError, DomainResult, js_date, now, to_iso};

/// `PersonDuplicateEmailError`'s message.
pub const DUPLICATE_EMAIL: &str = "A person with this email already exists.";
/// `PersonVersionConflictError`'s message.
pub const VERSION_CONFLICT: &str =
    "This record was changed by someone else. Reload to see the latest version.";

fn duplicate(existing_person_id: &str) -> DomainError {
    DomainError::DuplicateEmail {
        message: DUPLICATE_EMAIL.to_owned(),
        existing_person_id: existing_person_id.to_owned(),
    }
}

/// A string field of a JSON object.
fn text<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// The id of a row.
fn id_of(row: &Value) -> String {
    row.get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// `deriveDisplayName({ firstName, lastName, fullName, email })`.
pub fn derive_display_name(
    first_name: Option<&str>,
    last_name: Option<&str>,
    full_name: Option<&str>,
    email: Option<&str>,
) -> String {
    let combined = format!(
        "{} {}",
        first_name.unwrap_or_default(),
        last_name.unwrap_or_default()
    );
    let combined = js_trim(&combined);
    if !combined.is_empty() {
        return combined.to_owned();
    }
    for candidate in [full_name, email].into_iter().flatten() {
        let trimmed = js_trim(candidate);
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    "Unnamed".to_owned()
}

/// `withSupplierRole(role)`.
fn with_supplier_role(role: Option<&str>) -> &'static str {
    match role {
        Some("customer" | "both") => "both",
        _ => "supplier",
    }
}

/// `ensureWrappingParty(db, person)`: keep the `parties` row in step,
/// creating it when the person is first flagged a supplier.
async fn ensure_wrapping_party(db: &PgPool, person: &Value) -> DomainResult<()> {
    let id = id_of(person);
    let existing: Option<(String, Option<String>, Option<Value>)> = parties::Entity::find()
        .select_only()
        .columns([
            parties::Column::Id,
            parties::Column::Role,
            parties::Column::BillingAddress,
        ])
        .filter(parties::Column::PersonId.eq(id.as_str()))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let supplier = person.get("isSupplier") == Some(&json!(true));
    let field = |key: &str| person.get(key).cloned().unwrap_or(Value::Null);
    if let Some((party_id, role, billing)) = existing {
        let mut set = Map::new();
        set.insert("displayName".into(), field("displayName"));
        if supplier {
            set.insert("role".into(), json!(with_supplier_role(role.as_deref())));
            set.insert("partyCode".into(), field("partyCode"));
            set.insert("archivedAt".into(), field("archivedAt"));
            if billing.is_none_or(|b| b.is_null()) {
                set.insert("billingAddress".into(), field("primaryAddress"));
            }
        }
        set.insert("updatedAt".into(), json!(now()));
        update_rows::<parties::Entity>(
            &orm(db),
            &PARTIES,
            &set,
            Condition::all().add(parties::Column::Id.eq(party_id)),
        )
        .await?;
        return Ok(());
    }
    if !supplier {
        return Ok(());
    }
    let now = now();
    let mut values = Map::new();
    values.insert("id".into(), json!(generate_id("party")));
    values.insert("kind".into(), json!("person"));
    values.insert("personId".into(), json!(id));
    values.insert("role".into(), json!("supplier"));
    values.insert("displayName".into(), field("displayName"));
    values.insert("partyCode".into(), field("partyCode"));
    values.insert("billingAddress".into(), field("primaryAddress"));
    values.insert("archivedAt".into(), field("archivedAt"));
    values.insert("createdAt".into(), json!(now));
    values.insert("updatedAt".into(), json!(now));
    insert_row::<parties::Entity>(&orm(db), &PARTIES, &values).await?;
    Ok(())
}

// ── List and export ─────────────────────────────────────────────────────────

/// The list and export filters (`PeopleFilter`).
#[derive(Debug, Clone, Default)]
pub struct PeopleFilter {
    pub search: Option<String>,
    pub status: Option<String>,
    pub owner_id: Option<String>,
    pub is_supplier: Option<bool>,
    pub is_lead: Option<bool>,
    pub company_id: Option<String>,
    pub list_id: Option<String>,
    pub in_crm: Option<bool>,
    pub has_phone: Option<bool>,
}

/// What `buildPeopleConditions` looked up before the page: the people linked
/// to `companyId` and the members of `listId`.
#[derive(Debug, Clone, Default)]
struct Resolved {
    linked: Option<Vec<String>>,
    members: Option<Vec<String>>,
}

/// `buildPeopleConditions`: `None` when the filter can only match nothing.
async fn resolve_filter(db: &PgPool, filter: &PeopleFilter) -> DomainResult<Option<Resolved>> {
    let mut resolved = Resolved::default();
    if let Some(company_id) = filter.company_id.as_deref().filter(|c| !c.is_empty()) {
        let linked: Vec<String> = person_companies::Entity::find()
            .select_only()
            .column(person_companies::Column::PersonId)
            .filter(person_companies::Column::CompanyId.eq(company_id))
            .filter(person_companies::Column::EndedAt.is_null())
            .into_tuple()
            .all(&orm(db))
            .await?;
        if linked.is_empty() {
            return Ok(None);
        }
        resolved.linked = Some(linked);
    }
    if let Some(list_id) = filter.list_id.as_deref().filter(|l| !l.is_empty()) {
        if list_kind(db, list_id).await?.as_deref() != Some("person") {
            return Ok(None);
        }
        let members = list_member_ids(db, list_id).await?;
        if members.is_empty() {
            return Ok(None);
        }
        resolved.members = Some(members);
    }
    Ok(Some(resolved))
}

/// `buildPeopleConditions`'s `where` of a people list or export: live,
/// within the owner scope, the search and column filters, the company's
/// people and the list's members.
fn person_condition(scope: Option<&str>, filter: &PeopleFilter, resolved: &Resolved) -> Condition {
    use people::Column as P;
    let given = |value: &Option<String>| value.clone().filter(|v| !v.is_empty());
    let mut condition = Condition::all().add(P::DeletedAt.is_null());
    if let Some(owner) = scope {
        condition = condition.add(P::OwnerId.eq(owner));
    }
    if let Some(search) = given(&filter.search) {
        condition = condition.add(search_match(
            &[P::DisplayName, P::FullName, P::FirstName, P::LastName, P::Email],
            &crate::validation::contains_pattern(&search),
        ));
    }
    if let Some(status) = given(&filter.status) {
        condition = condition.add(P::Status.eq(status));
    }
    if let Some(owner) = given(&filter.owner_id) {
        condition = condition.add(P::OwnerId.eq(owner));
    }
    if let Some(supplier) = filter.is_supplier {
        condition = condition.add(P::IsSupplier.eq(supplier));
    }
    if let Some(lead) = filter.is_lead {
        condition = condition.add(P::IsLead.eq(lead));
    }
    if let Some(in_crm) = filter.in_crm {
        condition = condition.add(P::InCrm.eq(in_crm));
    }
    if let Some(has_phone) = filter.has_phone {
        condition = condition.add(has_phone_is(has_phone));
    }
    if let Some(linked) = &resolved.linked {
        condition = condition.add(P::Id.is_in(linked.clone()));
    }
    if let Some(members) = &resolved.members {
        condition = condition.add(P::Id.is_in(members.clone()));
    }
    condition
}

/// `$8 = (coalesce(nullif(trim(direct_phone), ''), nullif(trim(mobile_phone),
/// '')) is not null)`: whether the person has a phone number.
fn has_phone_is(has_phone: bool) -> Expr {
    use sea_orm::ExprTrait as _;
    let number = |column: people::Column| {
        Expr::expr(Func::cust("nullif").args([
            Expr::expr(Func::cust("trim").arg(column.into_expr())),
            Expr::val(""),
        ]))
    };
    let phone = Expr::expr(Func::coalesce([
        number(people::Column::DirectPhone),
        number(people::Column::MobilePhone),
    ]));
    if has_phone {
        phone.is_not_null()
    } else {
        phone.is_null()
    }
}

/// `resolveBuiltInPersonSort`: grid key → sort family (`text` sorts
/// `lower(col::text)`, the rest the column itself).
pub const PERSON_SORTS: [(&str, &str); 20] = [
    ("name", "text"),
    ("title", "text"),
    ("department", "text"),
    ("email", "text"),
    ("directPhone", "text"),
    ("mobilePhone", "text"),
    ("status", "text"),
    ("role", "text"),
    ("isSupplier", "bool"),
    ("isLead", "bool"),
    ("isDecisionMaker", "bool"),
    ("isBillingContact", "bool"),
    ("lifecycleStage", "text"),
    ("source", "text"),
    ("leadScore", "int"),
    ("preferredLanguage", "text"),
    ("ownerId", "text"),
    ("lastContactedAt", "time"),
    ("nextFollowUpDate", "time"),
    ("createdAt", "time"),
];

/// What a built-in person sort orders by ([`PERSON_SORTS`]).
fn person_sort_value(key: &str, family: &str) -> Option<Expr> {
    use people::Column as P;
    let column = match key {
        "name" => P::DisplayName,
        "title" => P::Title,
        "department" => P::Department,
        "email" => P::Email,
        "directPhone" => P::DirectPhone,
        "mobilePhone" => P::MobilePhone,
        "status" => P::Status,
        "role" => P::Role,
        "isSupplier" => P::IsSupplier,
        "isLead" => P::IsLead,
        "isDecisionMaker" => P::IsDecisionMaker,
        "isBillingContact" => P::IsBillingContact,
        "lifecycleStage" => P::LifecycleStage,
        "source" => P::Source,
        "leadScore" => P::LeadScore,
        "preferredLanguage" => P::PreferredLanguage,
        "ownerId" => P::OwnerId,
        "lastContactedAt" => P::LastContactedAt,
        "nextFollowUpDate" => P::NextFollowUpDate,
        "createdAt" => P::CreatedAt,
        _ => return None,
    };
    Some(sort_value(column, family))
}

/// One page of people (`ListResult`).
#[derive(Debug, Clone)]
pub struct ListPage {
    pub data: Vec<Value>,
    pub total_count: i64,
    pub has_more: bool,
    pub cursor: Option<String>,
}

/// The list's paging and sort.
#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    pub limit: i64,
    pub cursor: Option<String>,
    pub sort: Option<String>,
    pub sort_dir: Option<String>,
}

const EMPTY_PAGE: ListPage = ListPage {
    data: Vec::new(),
    total_count: 0,
    has_more: false,
    cursor: None,
};

/// `listPeople(db, params, ownerScope)`.
#[allow(clippy::too_many_lines)] // the one list query, as TypeScript builds it
pub async fn list_people(
    db: &PgPool,
    filter: &PeopleFilter,
    options: &ListOptions,
    scope: Option<&str>,
) -> DomainResult<ListPage> {
    let limit = options.limit.min(100);
    let Some(resolved) = resolve_filter(db, filter).await? else {
        return Ok(EMPTY_PAGE);
    };
    let cursor = decode_list_cursor(options.cursor.as_deref());
    let builtin = options
        .sort
        .as_deref()
        .and_then(|sort| PERSON_SORTS.iter().find(|(key, _)| *key == sort));
    let offset = match (&cursor, builtin) {
        (Some(c), Some(_)) => crate::js::parse_int(&c.position).unwrap_or(0).max(0),
        _ => 0,
    };
    let keyset = if builtin.is_some() {
        None
    } else {
        cursor.as_ref().map(|c| c.position.clone())
    };
    let order = sort_order(options.sort_dir.as_deref().unwrap_or("asc"));
    let mut select = people::Entity::find().filter(person_condition(scope, filter, &resolved));
    if let Some(keyset) = &keyset {
        select = select.filter(before_row::<people::Entity>(
            people::Column::CreatedAt,
            people::Column::Id,
            keyset,
        ));
    }
    if let (Some((key, family)), Some(order)) = (builtin, order) {
        if let Some(value) = person_sort_value(key, family) {
            select = select.order_by_with_nulls(value, order.clone(), NullOrdering::Last);
        }
        // The tie-break, in the sort's own direction.
        select = select.order_by(people::Column::Id, order);
    }
    let conn = orm(db);
    let rows = select
        .order_by_desc(people::Column::CreatedAt)
        .order_by_desc(people::Column::Id)
        .limit(probe_limit(limit)?)
        .offset(u64::try_from(offset).unwrap_or(0))
        .all(&conn)
        .await?;
    let total_count = if let Some(total) = cursor.as_ref().and_then(|c| c.total_count) {
        total
    } else {
        count(
            people::Entity::find()
                .filter(person_condition(scope, filter, &resolved))
                .count(&conn)
                .await?,
        )
    };
    let definitions = cfv::definitions(db, "person").await?;
    let has_more = usize::try_from(limit).is_ok_and(|limit| rows.len() > limit);
    let mut page = rows
        .into_iter()
        .map(to_value)
        .collect::<Result<Vec<_>, _>>()?;
    page.truncate(usize::try_from(limit).unwrap_or(0));
    let data = cfv::hydrate(db, "person", page, Some(&definitions)).await?;
    let position = if builtin.is_some() {
        Some((offset + limit).to_string())
    } else {
        data.last()
            .and_then(|r| r.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let cursor = match (has_more, position) {
        (true, Some(position)) if !position.is_empty() => {
            Some(encode_list_cursor(&position, total_count))
        }
        _ => None,
    };
    Ok(ListPage {
        data,
        total_count,
        has_more,
        cursor,
    })
}

/// `exportPeople(db, filter, ownerScope)`: every match, newest first,
/// capped at 50 000.
pub async fn export_people(
    db: &PgPool,
    filter: &PeopleFilter,
    scope: Option<&str>,
) -> DomainResult<Vec<Value>> {
    let Some(resolved) = resolve_filter(db, filter).await? else {
        return Ok(Vec::new());
    };
    let rows = people::Entity::find()
        .filter(person_condition(scope, filter, &resolved))
        .order_by_desc(people::Column::CreatedAt)
        .order_by_desc(people::Column::Id)
        .limit(50_000)
        .all(&orm(db))
        .await?;
    let rows = rows
        .into_iter()
        .map(to_value)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(cfv::hydrate(db, "person", rows, None).await?)
}

// ── Reads ───────────────────────────────────────────────────────────────────

/// The live person row, within the owner scope, as Drizzle reads it.
///
/// Spike S7 of the ORM plan (`rust/docs/spikes.md`): read through the
/// `people` entity, which serializes to the Drizzle row itself.
async fn raw_person(db: &PgPool, id: &str, scope: Option<&str>) -> DomainResult<Option<Value>> {
    let mut query =
        people::Entity::find_by_id(id.to_owned()).filter(people::Column::DeletedAt.is_null());
    if let Some(owner) = scope {
        query = query.filter(people::Column::OwnerId.eq(owner));
    }
    let row = query.one(&orm(db)).await?;
    Ok(row.map(to_value).transpose()?)
}

/// `getPerson(db, id, ownerScope)`: the live row with its custom fields.
pub async fn get_person(db: &PgPool, id: &str, scope: Option<&str>) -> DomainResult<Option<Value>> {
    let row = raw_person(db, id, scope).await?;
    Ok(cfv::hydrate_one(db, "person", row).await?)
}

/// `getPerson` after a write: the row must be there.
async fn reread(db: &PgPool, id: &str, message: &str) -> DomainResult<Value> {
    get_person(db, id, None)
        .await?
        .ok_or_else(|| DomainError::Other(message.to_owned()))
}

// ── Create ──────────────────────────────────────────────────────────────────

/// `value ?? fallback`.
fn or_default(input: &Map<String, Value>, key: &str, fallback: Value) -> Value {
    match input.get(key) {
        Some(value) if !value.is_null() => value.clone(),
        _ => fallback,
    }
}

/// The input columns `insertPersonRow` copies with `?? null`, in its order.
const COPIED: [&str; 18] = [
    "gender",
    "title",
    "department",
    "role",
    "alternateEmails",
    "directPhone",
    "mobilePhone",
    "extension",
    "primaryAddress",
    "addresses",
    "avatarUrl",
    "linkedinUrl",
    "twitterHandle",
    "ownerId",
    "accountManagerId",
    "lifecycleStage",
    "rating",
    "source",
];

/// The input columns `insertPersonRow` copies with `?? false`.
const FLAGS: [&str; 10] = [
    "isSupplier",
    "isLead",
    "isFavorite",
    "isDecisionMaker",
    "isBillingContact",
    "isTechnicalContact",
    "marketingConsent",
    "emailOptIn",
    "smsOptIn",
    "doNotCall",
];

/// The input columns after the flags, with `?? null`.
const TAIL: [&str; 9] = [
    "influenceLevel",
    "preferredContactMethod",
    "preferredLanguage",
    "bestTimeToContact",
    "tags",
    "interests",
    "customFields",
    "notes",
    "internalNotes",
];

/// `insertPersonRow(db, input)`: insert, re-read, and sync the party.
async fn insert_person_row(db: &PgPool, input: &Map<String, Value>) -> DomainResult<Value> {
    let id = generate_id("person");
    let now = now();
    let first = text(input, "firstName");
    let last = text(input, "lastName");
    // `input.fullName?.trim() || `${first ?? ''} ${last ?? ''}`.trim() || null`
    let combined = format!("{} {}", first.unwrap_or_default(), last.unwrap_or_default());
    let full_name = text(input, "fullName")
        .map(js_trim)
        .filter(|f| !f.is_empty())
        .or_else(|| Some(js_trim(&combined)).filter(|c| !c.is_empty()))
        .map(str::to_owned);
    let display_name =
        derive_display_name(first, last, text(input, "fullName"), text(input, "email"));
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.insert("createdAt".into(), json!(now));
    values.insert("updatedAt".into(), json!(now));
    values.insert("version".into(), json!(1));
    let party_code = text(input, "partyCode")
        .map(js_trim)
        .filter(|c| !c.is_empty());
    values.insert("partyCode".into(), json!(party_code));
    values.insert(
        "firstName".into(),
        or_default(input, "firstName", Value::Null),
    );
    values.insert(
        "lastName".into(),
        or_default(input, "lastName", Value::Null),
    );
    values.insert("fullName".into(), json!(full_name));
    values.insert("displayName".into(), json!(display_name));
    values.insert(
        "dateOfBirth".into(),
        match text(input, "dateOfBirth") {
            Some(date) if !date.is_empty() => json!(to_iso(date)?),
            _ => Value::Null,
        },
    );
    // `input.email || null`
    values.insert(
        "email".into(),
        json!(text(input, "email").filter(|e| !e.is_empty())),
    );
    for key in COPIED {
        values.insert(key.into(), or_default(input, key, Value::Null));
    }
    values.insert(
        "status".into(),
        or_default(input, "status", json!("active")),
    );
    for key in FLAGS {
        values.insert(key.into(), or_default(input, key, json!(false)));
    }
    // Omitted → the column default (`true`).
    if let Some(in_crm) = input.get("inCrm").filter(|v| !v.is_null()) {
        values.insert("inCrm".into(), in_crm.clone());
    }
    for key in TAIL {
        values.insert(key.into(), or_default(input, key, Value::Null));
    }
    insert_row::<people::Entity>(&orm(db), &PEOPLE, &values).await?;
    let created = reread(db, &id, "Person disappeared after insert").await?;
    ensure_wrapping_party(db, &created).await?;
    Ok(created)
}

/// `lower(email)`.
fn lower_email() -> Expr {
    Expr::expr(Func::lower(people::Column::Email.into_expr()))
}

/// Non-deleted people whose email equals `email` (case-insensitive),
/// optionally without one id: `(id, inCrm)`.
async fn find_people_by_email(
    db: &PgPool,
    email: &str,
    exclude: Option<&str>,
) -> DomainResult<Vec<(String, bool)>> {
    use sea_orm::ExprTrait as _;
    let mut query = people::Entity::find()
        .select_only()
        .columns([people::Column::Id, people::Column::InCrm])
        .filter(lower_email().eq(email.to_lowercase()))
        .filter(people::Column::DeletedAt.is_null());
    if let Some(exclude) = exclude {
        query = query.filter(people::Column::Id.ne(exclude));
    }
    Ok(query.into_tuple().all(&orm(db)).await?)
}

/// Link a person to companies, `isPrimary` on `primary`.
async fn link_companies(
    db: &PgPool,
    person_id: &str,
    company_ids: &[String],
    primary: Option<&str>,
) -> DomainResult<()> {
    let now = utc_now();
    let conn = orm(db);
    for company_id in company_ids {
        person_companies::Entity::insert(person_companies::ActiveModel {
            id: Set(generate_id("pc")),
            created_at: Set(now),
            updated_at: Set(now),
            person_id: Set(person_id.to_owned()),
            company_id: Set(company_id.clone()),
            is_primary: Set(primary == Some(company_id.as_str())),
            ..Default::default()
        })
        .exec_without_returning(&conn)
        .await?;
    }
    Ok(())
}

/// The `companyIds` of an input.
fn company_ids(input: &Map<String, Value>) -> Vec<String> {
    match input.get("companyIds") {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter_map(|id| id.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// `update people set in_crm = true, owner_id = owner, updated_at = now()`.
async fn add_to_crm(db: &PgPool, id: &str, owner: Option<&str>) -> DomainResult<()> {
    people::Entity::update_many()
        .col_expr(people::Column::InCrm, Expr::value(true))
        .col_expr(people::Column::OwnerId, Expr::value(owner.map(str::to_owned)))
        .col_expr(people::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(people::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `promoteHiddenPerson(db, existingId, input)`.
async fn promote_hidden_person(
    db: &PgPool,
    existing_id: &str,
    input: &Map<String, Value>,
) -> DomainResult<Value> {
    let mut fields = input.clone();
    for key in [
        "companyIds",
        "primaryCompanyId",
        "ownerId",
        "inCrm",
        "email",
    ] {
        fields.remove(key);
    }
    let Some((updated, _)) = update_person(db, existing_id, &fields, None).await? else {
        return Err(DomainError::Other(
            "Person disappeared during promotion".to_owned(),
        ));
    };
    let owner = updated
        .get("ownerId")
        .filter(|v| !v.is_null())
        .or_else(|| input.get("ownerId").filter(|v| !v.is_null()))
        .cloned()
        .unwrap_or(Value::Null);
    add_to_crm(db, existing_id, owner.as_str()).await?;
    let ids = company_ids(input);
    if !ids.is_empty() {
        let linked: Vec<String> = person_companies::Entity::find()
            .select_only()
            .column(person_companies::Column::CompanyId)
            .filter(person_companies::Column::PersonId.eq(existing_id))
            .into_tuple()
            .all(&orm(db))
            .await?;
        let missing: Vec<String> = ids.into_iter().filter(|id| !linked.contains(id)).collect();
        link_companies(db, existing_id, &missing, text(input, "primaryCompanyId")).await?;
    }
    reread(db, existing_id, "Person disappeared during promotion").await
}

/// `createPersonDetailed(db, input)`: the row, and whether a hidden
/// (non-CRM) identity with the email was promoted instead of a new row.
pub async fn create_person_detailed(
    db: &PgPool,
    input: &Map<String, Value>,
) -> DomainResult<(Value, bool)> {
    create_person_with(db, input, false).await
}

/// `createPersonDetailed(db, input, { allowDuplicateEmail })`: with
/// `allow_duplicate_email` the email is not looked up, so a second person
/// with it is inserted (WeldConnect's `create_contact` without
/// `skipIfEmailExists`).
pub async fn create_person_with(
    db: &PgPool,
    input: &Map<String, Value>,
    allow_duplicate_email: bool,
) -> DomainResult<(Value, bool)> {
    assert_valid_member_fields(db, input).await?;
    let email = text(input, "email").map(js_trim).unwrap_or_default();
    if !email.is_empty() && !allow_duplicate_email {
        let matches = find_people_by_email(db, email, None).await?;
        if let Some((id, _)) = matches.iter().find(|(_, in_crm)| *in_crm) {
            return Err(duplicate(id));
        }
        if let Some((hidden, _)) = matches.first() {
            if input.get("inCrm") == Some(&json!(false)) {
                return Err(duplicate(hidden));
            }
            return Ok((promote_hidden_person(db, hidden, input).await?, true));
        }
    }
    let created = insert_person_row(db, input).await?;
    let id = id_of(&created);
    let ids = company_ids(input);
    if !ids.is_empty() {
        link_companies(db, &id, &ids, text(input, "primaryCompanyId")).await?;
    }
    cfv::sync_values_for_entity(db, "person", &id, input.get("customFields")).await;
    Ok((created, false))
}

// ── Update ──────────────────────────────────────────────────────────────────

/// `updatePerson(db, id, input, ownerScope)`: the row and the field changes,
/// or `None` when the person isn't there.
#[allow(clippy::too_many_lines)] // one write, as TypeScript has it
pub async fn update_person(
    db: &PgPool,
    id: &str,
    input: &Map<String, Value>,
    scope: Option<&str>,
) -> DomainResult<Option<(Value, Option<Map<String, Value>>)>> {
    let Some(existing) = raw_person(db, id, scope).await? else {
        return Ok(None);
    };
    let version = existing.get("version").and_then(Value::as_i64).unwrap_or(1);
    let expected = input
        .get("ifVersion")
        .filter(|v| !v.is_null())
        .or_else(|| input.get("version").filter(|v| !v.is_null()))
        .and_then(Value::as_i64);
    if expected.is_some_and(|expected| expected != version) {
        return Err(DomainError::VersionConflict(VERSION_CONFLICT.to_owned()));
    }
    assert_valid_member_fields(db, input).await?;
    let next_email = text(input, "email").map(js_trim).unwrap_or_default();
    let current_email = existing
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    if !next_email.is_empty() && next_email.to_lowercase() != current_email {
        let matches = find_people_by_email(db, next_email, Some(id)).await?;
        if let Some((other, _)) = matches.iter().find(|(_, in_crm)| *in_crm) {
            return Err(duplicate(other));
        }
    }
    let mut updates = Map::new();
    updates.insert("updatedAt".into(), json!(now()));
    updates.insert("version".into(), json!(version + 1));
    let mut rest = input.clone();
    for key in ["ifVersion", "version", "companyIds", "primaryCompanyId"] {
        rest.remove(key);
    }
    let date_of_birth = rest.remove("dateOfBirth");
    let next_follow_up = rest.remove("nextFollowUpDate");
    for (key, value) in &rest {
        updates.insert(key.clone(), value.clone());
    }
    for (key, value) in [
        ("dateOfBirth", date_of_birth),
        ("nextFollowUpDate", next_follow_up),
    ] {
        match value {
            None => {}
            Some(Value::String(date)) if !date.is_empty() => {
                updates.insert(key.into(), json!(to_iso(&date)?));
            }
            Some(_) => {
                updates.insert(key.into(), Value::Null);
            }
        }
    }
    if ["firstName", "lastName", "fullName"]
        .iter()
        .any(|key| rest.contains_key(*key))
    {
        // `rest.x ?? existing.x`
        let pick = |key: &str| {
            rest.get(key)
                .filter(|v| !v.is_null())
                .or_else(|| existing.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let first = pick("firstName");
        let last = pick("lastName");
        let full_name = match rest.get("fullName").filter(|v| !v.is_null()) {
            Some(full) => full.as_str().map(str::to_owned),
            None => {
                if first.as_deref().is_some_and(|f| !f.is_empty())
                    || last.as_deref().is_some_and(|l| !l.is_empty())
                {
                    let combined = format!(
                        "{} {}",
                        first.as_deref().unwrap_or_default(),
                        last.as_deref().unwrap_or_default()
                    );
                    Some(js_trim(&combined).to_owned())
                } else {
                    existing
                        .get("fullName")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                }
            }
        };
        let email = pick("email");
        updates.insert("fullName".into(), json!(full_name));
        updates.insert(
            "displayName".into(),
            json!(derive_display_name(
                first.as_deref(),
                last.as_deref(),
                full_name.as_deref(),
                email.as_deref(),
            )),
        );
    }
    let mut written = Condition::all().add(people::Column::Id.eq(id));
    if expected.is_some() {
        written =
            written.add(people::Column::Version.eq(i32::try_from(version).unwrap_or(i32::MAX)));
    }
    let written = update_rows::<people::Entity>(&orm(db), &PEOPLE, &updates, written).await?;
    if written.is_empty() {
        if expected.is_some() {
            return Err(DomainError::VersionConflict(VERSION_CONFLICT.to_owned()));
        }
        return Ok(None);
    }
    let Some(fresh) = get_person(db, id, None).await? else {
        return Ok(None);
    };
    ensure_wrapping_party(db, &fresh).await?;
    cfv::sync_values_for_entity(db, "person", id, rest.get("customFields")).await;
    let changes = compute_changes(&existing, &fresh);
    Ok(Some((fresh, changes)))
}

// ── Import ──────────────────────────────────────────────────────────────────

/// `importNorm(s)`: trimmed, `''` for none.
fn norm(input: &Map<String, Value>, key: &str) -> String {
    text(input, key).map(js_trim).unwrap_or_default().to_owned()
}

/// One created or updated row of an import (`ImportChangedRow`).
#[derive(Debug, Clone)]
pub struct ImportedRow {
    pub id: String,
    pub created: bool,
    pub row: Value,
}

/// `ImportPeopleResult`.
#[derive(Debug, Clone, Default)]
pub struct ImportResult {
    pub imported: usize,
    pub updated: usize,
    pub failed: usize,
    pub total: usize,
    pub errors: Vec<Value>,
    pub changed: Vec<ImportedRow>,
}

/// `ImportLookups`, kept current as the batch writes.
#[derive(Default)]
struct Lookups {
    by_party_code: HashMap<String, Value>,
    by_email: HashMap<String, Value>,
}

impl Lookups {
    /// `indexImportedPerson`.
    fn index(&mut self, row: &Value) {
        if let Some(code) = row
            .get("partyCode")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
        {
            self.by_party_code.insert(code.to_owned(), row.clone());
        }
        if let Some(email) = row
            .get("email")
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
        {
            self.by_email.insert(email.to_lowercase(), row.clone());
        }
    }
}

/// `loadImportLookups(db, records)`.
async fn load_lookups(db: &PgPool, records: &[Map<String, Value>]) -> DomainResult<Lookups> {
    let mut codes: Vec<String> = Vec::new();
    let mut emails: Vec<String> = Vec::new();
    for record in records {
        let code = norm(record, "partyCode");
        if !code.is_empty() && !codes.contains(&code) {
            codes.push(code);
        }
        let email = norm(record, "email").to_lowercase();
        if !email.is_empty() && !emails.contains(&email) {
            emails.push(email);
        }
    }
    let mut lookups = Lookups::default();
    let conn = orm(db);
    if !codes.is_empty() {
        let rows = people::Entity::find()
            .filter(people::Column::DeletedAt.is_null())
            .filter(people::Column::PartyCode.is_in(codes))
            .all(&conn)
            .await?;
        for row in rows.into_iter().map(to_value) {
            let row = row?;
            if let Some(code) = row
                .get("partyCode")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
            {
                lookups.by_party_code.insert(code.to_owned(), row.clone());
            }
        }
    }
    if !emails.is_empty() {
        let rows = people::Entity::find()
            .filter(people::Column::DeletedAt.is_null())
            .filter(sea_orm::ExprTrait::is_in(lower_email(), emails))
            .all(&conn)
            .await?;
        for row in rows.into_iter().map(to_value) {
            let row = row?;
            if let Some(email) = row
                .get("email")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
            {
                lookups.by_email.insert(email.to_lowercase(), row.clone());
            }
        }
    }
    Ok(lookups)
}

/// `importRowRef(rec, index)`.
fn row_ref(record: &Map<String, Value>, index: usize) -> String {
    let combined = format!("{} {}", norm(record, "firstName"), norm(record, "lastName"));
    [
        norm(record, "partyCode"),
        norm(record, "email"),
        norm(record, "fullName"),
        js_trim(&combined).to_owned(),
    ]
    .into_iter()
    .find(|r| !r.is_empty())
    .unwrap_or_else(|| format!("#{}", index + 1))
}

/// One record: `Ok(None)` written, `Ok(Some(error))` a row error.
async fn import_one(
    db: &PgPool,
    lookups: &mut Lookups,
    result: &mut ImportResult,
    record: &Map<String, Value>,
) -> DomainResult<Option<String>> {
    let code = norm(record, "partyCode");
    let email = norm(record, "email").to_lowercase();
    let matched = (!code.is_empty())
        .then(|| lookups.by_party_code.get(&code).cloned())
        .flatten()
        .or_else(|| {
            (!email.is_empty())
                .then(|| lookups.by_email.get(&email).cloned())
                .flatten()
        });
    if let Some(found) = matched {
        let mut input = record.clone();
        if let Some(Value::Object(custom)) = record.get("customFields") {
            let mut merged = match found.get("customFields") {
                Some(Value::Object(existing)) => existing.clone(),
                _ => Map::new(),
            };
            for (key, value) in custom {
                merged.insert(key.clone(), value.clone());
            }
            input.insert("customFields".into(), Value::Object(merged));
        }
        let Some((row, _)) = update_person(db, &id_of(&found), &input, None).await? else {
            return Ok(Some("Matched person no longer exists".to_owned()));
        };
        result.updated += 1;
        lookups.index(&row);
        result.changed.push(ImportedRow {
            id: id_of(&row),
            created: false,
            row,
        });
        return Ok(None);
    }
    let has_name = ["firstName", "lastName", "fullName", "email"]
        .iter()
        .any(|key| !norm(record, key).is_empty());
    if !has_name {
        return Ok(Some(
            "Missing a name or email to create a person".to_owned(),
        ));
    }
    let created = insert_person_row(db, record).await?;
    let id = id_of(&created);
    cfv::sync_values_for_entity(db, "person", &id, created.get("customFields")).await;
    result.imported += 1;
    lookups.index(&created);
    result.changed.push(ImportedRow {
        id,
        created: true,
        row: created,
    });
    Ok(None)
}

/// `importPeople(db, records)`: upsert each record, matched by `partyCode`
/// then email; per-row failures are collected, never fatal.
pub async fn import_people(
    db: &PgPool,
    records: &[Map<String, Value>],
) -> DomainResult<ImportResult> {
    let mut result = ImportResult {
        total: records.len(),
        ..ImportResult::default()
    };
    let mut lookups = load_lookups(db, records).await?;
    for (index, record) in records.iter().enumerate() {
        let reference = row_ref(record, index);
        let error = match import_one(db, &mut lookups, &mut result, record).await {
            Ok(None) => continue,
            Ok(Some(error)) => error,
            Err(error) => error.message(),
        };
        result.failed += 1;
        result
            .errors
            .push(json!({ "row": index + 1, "ref": reference, "error": error }));
    }
    Ok(result)
}

// ── Delete, archive, add to CRM ─────────────────────────────────────────────

/// `deletePerson`: soft-delete a live person in the owner scope; `false`
/// when not found.
pub async fn delete_person(db: &PgPool, id: &str, scope: Option<&str>) -> DomainResult<bool> {
    if raw_person(db, id, scope).await?.is_none() {
        return Ok(false);
    }
    let now = utc_now();
    people::Entity::update_many()
        .col_expr(people::Column::DeletedAt, Expr::value(now))
        .col_expr(people::Column::UpdatedAt, Expr::value(now))
        .filter(people::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(true)
}

/// `archivePerson` (`archived = true`) or `unarchivePerson`.
pub async fn set_archived(
    db: &PgPool,
    id: &str,
    archived: bool,
    scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    if raw_person(db, id, scope).await?.is_none() {
        return Ok(None);
    }
    let now = utc_now();
    people::Entity::update_many()
        .col_expr(people::Column::ArchivedAt, Expr::value(archived.then_some(now)))
        .col_expr(people::Column::UpdatedAt, Expr::value(now))
        .filter(people::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    let updated = get_person(db, id, None).await?;
    if let Some(updated) = &updated {
        ensure_wrapping_party(db, updated).await?;
    }
    Ok(updated)
}

/// `addPersonToCrm(db, id, actingUserId, ownerScope)`: flip `inCrm` on; an
/// unowned person gets the acting user as owner. With a scope, the caller's
/// own and unowned people only.
pub async fn add_person_to_crm(
    db: &PgPool,
    id: &str,
    acting_user: Option<&str>,
    scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    let mut query = people::Entity::find()
        .select_only()
        .columns([people::Column::Id, people::Column::OwnerId])
        .filter(people::Column::Id.eq(id))
        .filter(people::Column::DeletedAt.is_null());
    if let Some(owner) = scope {
        query = query.filter(
            Condition::any()
                .add(people::Column::OwnerId.eq(owner))
                .add(people::Column::OwnerId.is_null()),
        );
    }
    let existing: Option<(String, Option<String>)> = query.into_tuple().one(&orm(db)).await?;
    let Some((_, owner)) = existing else {
        return Ok(None);
    };
    add_to_crm(db, id, owner.as_deref().or(acting_user)).await?;
    let updated = get_person(db, id, None).await?;
    if let Some(updated) = &updated {
        ensure_wrapping_party(db, updated).await?;
    }
    Ok(updated)
}

// ── Companies, detail, navigation ───────────────────────────────────────────

/// A `person_companies` link with the live company's card.
#[derive(Debug, FromQueryResult)]
struct PersonCompany {
    id: String,
    created_at: PrimitiveDateTime,
    updated_at: PrimitiveDateTime,
    person_id: String,
    company_id: String,
    role: Option<String>,
    is_primary: bool,
    started_at: Option<PrimitiveDateTime>,
    ended_at: Option<PrimitiveDateTime>,
    display_name: Option<String>,
    name: Option<String>,
    industry: Option<String>,
    avatar_url: Option<String>,
}

impl PersonCompany {
    /// The link as Drizzle returns it, with its `company`.
    fn json(self) -> Value {
        json!({
            "id": self.id,
            "createdAt": js_date(self.created_at),
            "updatedAt": js_date(self.updated_at),
            "personId": self.person_id,
            "companyId": self.company_id,
            "role": self.role,
            "isPrimary": self.is_primary,
            "startedAt": self.started_at.map(js_date),
            "endedAt": self.ended_at.map(js_date),
            "company": {
                "id": self.company_id,
                "displayName": self.display_name,
                "name": self.name,
                "industry": self.industry,
                "avatarUrl": self.avatar_url,
            },
        })
    }
}

/// `listPersonCompanies(db, personId, ownerScope)`: the person's company
/// links with the live company's card, primary first.
pub async fn list_person_companies(
    db: &PgPool,
    person_id: &str,
    scope: Option<&str>,
) -> DomainResult<Vec<Value>> {
    use person_companies::Column as Pc;
    if scope.is_some() && get_person(db, person_id, scope).await?.is_none() {
        return Ok(Vec::new());
    }
    let rows: Vec<PersonCompany> = person_companies::Entity::find()
        .select_only()
        .columns([
            Pc::Id,
            Pc::CreatedAt,
            Pc::UpdatedAt,
            Pc::PersonId,
            Pc::CompanyId,
            Pc::Role,
            Pc::IsPrimary,
            Pc::StartedAt,
            Pc::EndedAt,
        ])
        .column_as(companies::Column::DisplayName, "display_name")
        .column_as(companies::Column::Name, "name")
        .column_as(companies::Column::Industry, "industry")
        .column_as(companies::Column::AvatarUrl, "avatar_url")
        .join(
            JoinType::LeftJoin,
            person_companies::Entity::belongs_to(companies::Entity)
                .from(Pc::CompanyId)
                .to(companies::Column::Id)
                .on_condition(|_, company| {
                    Condition::all().add(sea_orm::ExprTrait::is_null(Expr::col((
                        company,
                        companies::Column::DeletedAt,
                    ))))
                })
                .into(),
        )
        .filter(Pc::PersonId.eq(person_id))
        .filter(companies::Column::DisplayName.is_not_null())
        .order_by_desc(Pc::IsPrimary)
        .order_by_desc(Pc::CreatedAt)
        .into_model()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(PersonCompany::json).collect())
}

/// The limits of the detail read (`PersonDetailOptions`).
#[derive(Debug, Clone, Copy)]
pub struct DetailLimits {
    pub activities: i64,
    pub tickets: i64,
    pub companies: i64,
}

/// `getPersonDetail(db, personId, options, ownerScope)`.
pub async fn get_person_detail(
    db: &PgPool,
    person_id: &str,
    limits: DetailLimits,
    scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    let Some(person) = get_person(db, person_id, scope).await? else {
        return Ok(None);
    };
    let mut companies = list_person_companies(db, person_id, None).await?;
    companies.truncate(usize::try_from(limits.companies.min(50)).unwrap_or(0));
    // Spike S7 of the ORM plan: the two lists through their entities.
    let db_orm = orm(db);
    let activities = crm_activities::Entity::find()
        .filter(crm_activities::Column::PersonId.eq(person_id))
        .filter(crm_activities::Column::DeletedAt.is_null())
        .order_by_desc(crm_activities::Column::CreatedAt)
        .limit(u64::try_from(limits.activities.min(50)).unwrap_or(0))
        .all(&db_orm)
        .await?;
    let tickets = helpdesk_tickets::Entity::find()
        .filter(helpdesk_tickets::Column::PersonId.eq(person_id))
        .filter(helpdesk_tickets::Column::DeletedAt.is_null())
        .order_by_desc(helpdesk_tickets::Column::CreatedAt)
        .limit(u64::try_from(limits.tickets.min(50)).unwrap_or(0))
        .all(&db_orm)
        .await?;
    let person_activities = |kind: Option<&str>| {
        let query = crm_activities::Entity::find()
            .filter(crm_activities::Column::PersonId.eq(person_id))
            .filter(crm_activities::Column::DeletedAt.is_null());
        match kind {
            Some(kind) => query.filter(crm_activities::Column::Type.eq(kind)),
            None => query,
        }
    };
    let counts = (
        count(
            person_companies::Entity::find()
                .filter(person_companies::Column::PersonId.eq(person_id))
                .count(&db_orm)
                .await?,
        ),
        count(person_activities(None).count(&db_orm).await?),
        count(
            helpdesk_tickets::Entity::find()
                .filter(helpdesk_tickets::Column::PersonId.eq(person_id))
                .filter(helpdesk_tickets::Column::DeletedAt.is_null())
                .count(&db_orm)
                .await?,
        ),
        count(person_activities(Some("note")).count(&db_orm).await?),
        count(person_activities(Some("task")).count(&db_orm).await?),
    );
    let activities = activities
        .into_iter()
        .map(to_value)
        .collect::<Result<Vec<_>, _>>()?;
    let tickets = tickets
        .into_iter()
        .map(to_value)
        .collect::<Result<Vec<_>, _>>()?;
    let last_activity = activities
        .first()
        .and_then(|row| row.get("createdAt"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(Some(json!({
        "person": person,
        "companies": companies,
        "activities": activities,
        "tickets": tickets,
        "counts": {
            "companies": counts.0,
            "activities": counts.1,
            "tickets": counts.2,
            "notes": counts.3,
            "tasks": counts.4,
        },
        "lastActivity": last_activity,
    })))
}

/// `getPersonNavigation(db, personId, { listId }, ownerScope)`; `None` when
/// the person isn't there (outside a list).
pub async fn get_person_navigation(
    db: &PgPool,
    person_id: &str,
    list_id: Option<&str>,
    scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    let conn = orm(db);
    if let Some(list_id) = list_id {
        let name: Option<String> = lists::Entity::find()
            .select_only()
            .column(lists::Column::Name)
            .filter(lists::Column::Id.eq(list_id))
            .filter(lists::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&conn)
            .await?;
        let context = name.unwrap_or_else(|| "People List".to_owned());
        let mut members = list_members::Entity::find()
            .select_only()
            .column(list_members::Column::EntityId)
            .join(
                JoinType::InnerJoin,
                list_members::Entity::belongs_to(people::Entity)
                    .from(list_members::Column::EntityId)
                    .to(people::Column::Id)
                    .into(),
            )
            .filter(list_members::Column::ListId.eq(list_id))
            .filter(people::Column::DeletedAt.is_null());
        if let Some(owner) = scope {
            members = members.filter(people::Column::OwnerId.eq(owner));
        }
        let members: Vec<String> = members
            .order_by_desc(list_members::Column::AddedAt)
            .into_tuple()
            .all(&conn)
            .await?;
        let total = members.len();
        return Ok(Some(match members.iter().position(|m| m == person_id) {
            None => {
                json!({ "currentIndex": 0, "totalCount": total, "previousId": null, "nextId": null, "contextName": context })
            }
            Some(index) => json!({
                "currentIndex": index + 1,
                "totalCount": total,
                "previousId": index.checked_sub(1).map(|i| members[i].clone()),
                "nextId": members.get(index + 1),
                "contextName": context,
            }),
        }));
    }
    let live = || {
        let query = people::Entity::find().filter(people::Column::DeletedAt.is_null());
        match scope {
            Some(owner) => query.filter(people::Column::OwnerId.eq(owner)),
            None => query,
        }
    };
    let created: Option<PrimitiveDateTime> = live()
        .select_only()
        .column(people::Column::CreatedAt)
        .filter(people::Column::Id.eq(person_id))
        .into_tuple()
        .one(&conn)
        .await?;
    let Some(created) = created else {
        return Ok(None);
    };
    // The person's `createdAt` as the route reads it back: to the millisecond.
    let created = weldsuite_db::utc_timestamp(created.assume_utc());
    let total = count(live().count(&conn).await?);
    let previous: Option<String> = live()
        .select_only()
        .column(people::Column::Id)
        .filter(people::Column::CreatedAt.gt(created))
        .order_by_asc(people::Column::CreatedAt)
        .into_tuple()
        .one(&conn)
        .await?;
    let next: Option<String> = live()
        .select_only()
        .column(people::Column::Id)
        .filter(people::Column::CreatedAt.lt(created))
        .order_by_desc(people::Column::CreatedAt)
        .into_tuple()
        .one(&conn)
        .await?;
    let after = count(
        live()
            .filter(people::Column::CreatedAt.gt(created))
            .count(&conn)
            .await?,
    );
    Ok(Some(json!({
        "currentIndex": after + 1,
        "totalCount": total,
        "previousId": previous,
        "nextId": next,
        "contextName": "All People",
    })))
}

// ── Mail recipient resolvers ────────────────────────────────────────────────

/// `PersonSummary`: the card a mail recipient picker shows.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonSummary {
    id: String,
    display_name: String,
    first_name: Option<String>,
    last_name: Option<String>,
    email: Option<String>,
    avatar_url: Option<String>,
}

/// `select id, display_name, … from people`, as [`PersonSummary`]s.
fn summaries() -> Select<people::Entity> {
    people::Entity::find().select_only().columns([
        people::Column::Id,
        people::Column::DisplayName,
        people::Column::FirstName,
        people::Column::LastName,
        people::Column::Email,
        people::Column::AvatarUrl,
    ])
}

/// The summaries as JSON.
fn summary_json(rows: Vec<PersonSummary>) -> DomainResult<Vec<Value>> {
    Ok(rows
        .into_iter()
        .map(to_value)
        .collect::<Result<Vec<_>, _>>()?)
}

/// `resolveByEmails(db, emails)`: the live people with one of the addresses
/// (case-insensitive). Not owner-scoped.
pub async fn resolve_by_emails(db: &PgPool, emails: &[String]) -> DomainResult<Vec<Value>> {
    if emails.is_empty() {
        return Ok(Vec::new());
    }
    let mut normalised: Vec<String> = Vec::new();
    for email in emails {
        let email = js_trim(email).to_lowercase();
        if !normalised.contains(&email) {
            normalised.push(email);
        }
    }
    let rows: Vec<PersonSummary> = summaries()
        .filter(people::Column::DeletedAt.is_null())
        .filter(sea_orm::ExprTrait::is_in(lower_email(), normalised))
        .into_model()
        .all(&orm(db))
        .await?;
    summary_json(rows)
}

/// `listRecentCorrespondents(db, { emails, limit })`: recently touched,
/// unarchived people, within `emails` when given. Not owner-scoped.
pub async fn list_recent_correspondents(
    db: &PgPool,
    emails: Option<&[String]>,
    limit: i64,
) -> DomainResult<Vec<Value>> {
    let limit = limit.min(50);
    if emails.is_some_and(<[String]>::is_empty) {
        return Ok(Vec::new());
    }
    let mut query = summaries()
        .filter(people::Column::DeletedAt.is_null())
        .filter(people::Column::ArchivedAt.is_null());
    if let Some(emails) = emails {
        query = query.filter(sea_orm::ExprTrait::is_in(lower_email(), emails.to_vec()));
    }
    let rows: Vec<PersonSummary> = query
        .order_by_desc(people::Column::UpdatedAt)
        .limit(u64::try_from(limit).map_err(|_| {
            sea_orm::DbErr::Custom("LIMIT must not be negative".to_owned())
        })?)
        .into_model()
        .all(&orm(db))
        .await?;
    summary_json(rows)
}

// ── Bulk update ─────────────────────────────────────────────────────────────

/// The fields a bulk update may set.
const BULK_FIELDS: [&str; 4] = ["ownerId", "accountManagerId", "status", "lifecycleStage"];

/// `bulkUpdatePeople(db, { personIds, updates }, ownerScope)`:
/// `(updated, failed, changed rows as (id, before, after))`.
pub async fn bulk_update_people(
    db: &PgPool,
    person_ids: &[String],
    set_fields: &Map<String, Value>,
    scope: Option<&str>,
) -> DomainResult<(
    usize,
    Vec<Value>,
    Vec<(String, Map<String, Value>, Map<String, Value>)>,
)> {
    let mut ids: Vec<String> = Vec::new();
    for id in person_ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Ok((0, Vec::new(), Vec::new()));
    }
    if !BULK_FIELDS.iter().any(|f| set_fields.contains_key(*f)) {
        let failed = ids
            .iter()
            .map(|id| json!({ "id": id, "reason": "No fields to update" }))
            .collect();
        return Ok((0, failed, Vec::new()));
    }
    assert_valid_member_fields(db, set_fields).await?;
    let conn = orm(db);
    let mut live = Condition::all().add(people::Column::DeletedAt.is_null());
    if let Some(owner) = scope {
        live = live.add(people::Column::OwnerId.eq(owner));
    }
    let before: Vec<BulkFields> = people::Entity::find()
        .select_only()
        .columns([
            people::Column::Id,
            people::Column::OwnerId,
            people::Column::AccountManagerId,
            people::Column::Status,
            people::Column::LifecycleStage,
        ])
        .filter(live.clone())
        .into_model()
        .all(&conn)
        .await?;
    let before: HashMap<String, Value> = before
        .into_iter()
        .map(|row| {
            let row = row.json();
            (id_of(&row), row)
        })
        .collect();
    let mut updates = Map::new();
    updates.insert("updatedAt".into(), json!(now()));
    for field in BULK_FIELDS {
        if let Some(value) = set_fields.get(field) {
            updates.insert(field.into(), value.clone());
        }
    }
    let written = update_rows::<people::Entity>(
        &conn,
        &PEOPLE,
        &updates,
        live.add(people::Column::Id.is_in(ids.clone())),
    )
    .await?;
    let failed = ids
        .iter()
        .filter(|id| !written.contains(id))
        .map(|id| json!({ "id": id, "reason": "Not found or already deleted" }))
        .collect();
    let changed = written
        .iter()
        .map(|id| {
            let prev = before
                .get(id)
                .map(|row| {
                    BULK_FIELDS
                        .iter()
                        .map(|f| ((*f).to_owned(), row.get(*f).cloned().unwrap_or(Value::Null)))
                        .collect::<Map<String, Value>>()
                })
                .unwrap_or_default();
            (id.clone(), prev, set_fields.clone())
        })
        .collect();
    Ok((written.len(), failed, changed))
}
