//! People (`@weldsuite/crm-domain/people`): the identity layer for
//! individuals. Stamps `displayName` on every write; keeps the wrapping
//! `parties` row (WeldBooks customer/supplier) in step with the person, as
//! [`crate::companies`] does for companies.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_core_domain::custom_field_values as cfv;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_trim;

use crate::tables::{PARTIES, PEOPLE};
use crate::validation::{
    assert_valid_member_fields, compute_changes, decode_list_cursor, encode_list_cursor,
};
use crate::{DomainError, DomainResult, drizzle_row, insert_sql, now, to_iso, update_sql};

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
    let existing: Option<(String, Option<String>, Option<Value>)> = sqlx::query_as(
        "select id, role, billing_address from parties where person_id = $1 limit 1",
    )
    .bind(&id)
    .fetch_optional(db)
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
        sqlx::query(update_sql!(parties, "where t.id = $1"))
            .bind(&party_id)
            .bind(PARTIES.set(&set))
            .execute(db)
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
    sqlx::query(insert_sql!(parties))
        .bind(PARTIES.values(&values))
        .execute(db)
        .await?;
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
        let linked: Vec<String> = sqlx::query_scalar(
            "select person_id from person_companies where company_id = $1 and ended_at is null",
        )
        .bind(company_id)
        .fetch_all(db)
        .await?;
        if linked.is_empty() {
            return Ok(None);
        }
        resolved.linked = Some(linked);
    }
    if let Some(list_id) = filter.list_id.as_deref().filter(|l| !l.is_empty()) {
        let kind: Option<String> = sqlx::query_scalar(
            "select kind from lists where id = $1 and deleted_at is null limit 1",
        )
        .bind(list_id)
        .fetch_optional(db)
        .await?;
        if kind.as_deref() != Some("person") {
            return Ok(None);
        }
        let members: Vec<String> =
            sqlx::query_scalar("select entity_id from list_members where list_id = $1")
                .bind(list_id)
                .fetch_all(db)
                .await?;
        if members.is_empty() {
            return Ok(None);
        }
        resolved.members = Some(members);
    }
    Ok(Some(resolved))
}

/// The `where` of a people list or export: `$1` owner scope, `$2` search
/// pattern, `$3`–`$8` the column filters, `$9` the company's people, `$10`
/// the list's members.
macro_rules! person_where {
    () => {
        "t.deleted_at is null
           and ($1::text is null or t.owner_id = $1)
           and ($2::text is null or (coalesce(t.display_name, '') || E'\\n' || coalesce(t.full_name, '')
                || E'\\n' || coalesce(t.first_name, '') || E'\\n' || coalesce(t.last_name, '')
                || E'\\n' || coalesce(t.email, '')) ilike $2)
           and ($3::text is null or t.status = $3)
           and ($4::text is null or t.owner_id = $4)
           and ($5::bool is null or t.is_supplier = $5)
           and ($6::bool is null or t.is_lead = $6)
           and ($7::bool is null or t.in_crm = $7)
           and ($8::bool is null or $8 = (coalesce(nullif(trim(t.direct_phone), ''), nullif(trim(t.mobile_phone), '')) is not null))
           and ($9::text[] is null or t.id = any($9))
           and ($10::text[] is null or t.id = any($10))"
    };
}

/// Bind the ten parameters of [`person_where`].
macro_rules! bind_person_filter {
    ($query:expr, $scope:expr, $filter:expr, $resolved:expr) => {{
        $query
            .bind($scope)
            .bind(
                $filter
                    .search
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map($crate::validation::contains_pattern),
            )
            .bind($filter.status.as_deref().filter(|s| !s.is_empty()))
            .bind($filter.owner_id.as_deref().filter(|s| !s.is_empty()))
            .bind($filter.is_supplier)
            .bind($filter.is_lead)
            .bind($filter.in_crm)
            .bind($filter.has_phone)
            .bind($resolved.linked.as_ref())
            .bind($resolved.members.as_ref())
    }};
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
    let (sort_key, family) =
        builtin.map_or((None, None), |(key, family)| (Some(*key), Some(*family)));
    let dir = options.sort_dir.clone().unwrap_or_else(|| "asc".to_owned());
    let query = sqlx::query_scalar::<_, Value>(concat!(
        "select to_jsonb(t) from people t where ",
        person_where!(),
        " and ($11::text is null or (t.created_at, t.id) < (select c.created_at, c.id from people c where c.id = $11))
         order by
           case when $12 = 'text' and $14 = 'asc' then lower((case $13
               when 'name' then t.display_name when 'title' then t.title when 'department' then t.department
               when 'email' then t.email when 'directPhone' then t.direct_phone when 'mobilePhone' then t.mobile_phone
               when 'status' then t.status when 'role' then t.role when 'lifecycleStage' then t.lifecycle_stage
               when 'source' then t.source when 'preferredLanguage' then t.preferred_language
               when 'ownerId' then t.owner_id end)::text) end asc nulls last,
           case when $12 = 'text' and $14 = 'desc' then lower((case $13
               when 'name' then t.display_name when 'title' then t.title when 'department' then t.department
               when 'email' then t.email when 'directPhone' then t.direct_phone when 'mobilePhone' then t.mobile_phone
               when 'status' then t.status when 'role' then t.role when 'lifecycleStage' then t.lifecycle_stage
               when 'source' then t.source when 'preferredLanguage' then t.preferred_language
               when 'ownerId' then t.owner_id end)::text) end desc nulls last,
           case when $12 = 'bool' and $14 = 'asc' then (case $13 when 'isSupplier' then t.is_supplier
               when 'isLead' then t.is_lead when 'isDecisionMaker' then t.is_decision_maker
               when 'isBillingContact' then t.is_billing_contact end) end asc nulls last,
           case when $12 = 'bool' and $14 = 'desc' then (case $13 when 'isSupplier' then t.is_supplier
               when 'isLead' then t.is_lead when 'isDecisionMaker' then t.is_decision_maker
               when 'isBillingContact' then t.is_billing_contact end) end desc nulls last,
           case when $12 = 'int' and $14 = 'asc' then t.lead_score end asc nulls last,
           case when $12 = 'int' and $14 = 'desc' then t.lead_score end desc nulls last,
           case when $12 = 'time' and $14 = 'asc' then (case $13 when 'lastContactedAt' then t.last_contacted_at
               when 'nextFollowUpDate' then t.next_follow_up_date when 'createdAt' then t.created_at end) end asc nulls last,
           case when $12 = 'time' and $14 = 'desc' then (case $13 when 'lastContactedAt' then t.last_contacted_at
               when 'nextFollowUpDate' then t.next_follow_up_date when 'createdAt' then t.created_at end) end desc nulls last,
           case when $12 is not null and $14 = 'asc' then t.id end asc,
           case when $12 is not null and $14 = 'desc' then t.id end desc,
           t.created_at desc, t.id desc
         limit $15 offset $16"
    ));
    let rows: Vec<Value> = bind_person_filter!(query, scope, filter, resolved)
        .bind(&keyset)
        .bind(family)
        .bind(sort_key)
        .bind(&dir)
        .bind(limit + 1)
        .bind(offset)
        .fetch_all(db)
        .await?;
    let total_count = if let Some(total) = cursor.as_ref().and_then(|c| c.total_count) {
        total
    } else {
        let query = sqlx::query_scalar::<_, i64>(concat!(
            "select count(*) from people t where ",
            person_where!()
        ));
        bind_person_filter!(query, scope, filter, resolved)
            .fetch_one(db)
            .await?
    };
    let definitions = cfv::definitions(db, "person").await?;
    let has_more = usize::try_from(limit).is_ok_and(|limit| rows.len() > limit);
    let mut page: Vec<Value> = rows.into_iter().map(drizzle_row).collect();
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
    let query = sqlx::query_scalar::<_, Value>(concat!(
        "select to_jsonb(t) from people t where ",
        person_where!(),
        " order by t.created_at desc, t.id desc limit 50000"
    ));
    let rows: Vec<Value> = bind_person_filter!(query, scope, filter, resolved)
        .fetch_all(db)
        .await?;
    Ok(cfv::hydrate(
        db,
        "person",
        rows.into_iter().map(drizzle_row).collect(),
        None,
    )
    .await?)
}

// ── Reads ───────────────────────────────────────────────────────────────────

/// The live person row, within the owner scope, as Drizzle reads it.
async fn raw_person(db: &PgPool, id: &str, scope: Option<&str>) -> DomainResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from people t
         where id = $1 and deleted_at is null and ($2::text is null or owner_id = $2) limit 1",
    )
    .bind(id)
    .bind(scope)
    .fetch_optional(db)
    .await?;
    Ok(row.map(drizzle_row))
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
    sqlx::query(insert_sql!(people))
        .bind(PEOPLE.values(&values))
        .execute(db)
        .await?;
    let created = reread(db, &id, "Person disappeared after insert").await?;
    ensure_wrapping_party(db, &created).await?;
    Ok(created)
}

/// Non-deleted people whose email equals `email` (case-insensitive),
/// optionally without one id: `(id, inCrm)`.
async fn find_people_by_email(
    db: &PgPool,
    email: &str,
    exclude: Option<&str>,
) -> DomainResult<Vec<(String, bool)>> {
    Ok(sqlx::query_as(
        "select id, in_crm from people
         where lower(email) = $1 and deleted_at is null and ($2::text is null or id <> $2)",
    )
    .bind(email.to_lowercase())
    .bind(exclude)
    .fetch_all(db)
    .await?)
}

/// Link a person to companies, `isPrimary` on `primary`.
async fn link_companies(
    db: &PgPool,
    person_id: &str,
    company_ids: &[String],
    primary: Option<&str>,
) -> DomainResult<()> {
    let now = now();
    for company_id in company_ids {
        sqlx::query(
            "insert into person_companies (id, created_at, updated_at, person_id, company_id, is_primary)
             values ($1, $2::timestamp, $2::timestamp, $3, $4, $5)",
        )
        .bind(generate_id("pc"))
        .bind(&now)
        .bind(person_id)
        .bind(company_id)
        .bind(primary == Some(company_id.as_str()))
        .execute(db)
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
    sqlx::query(
        "update people set in_crm = true, owner_id = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(existing_id)
    .bind(owner.as_str())
    .bind(now())
    .execute(db)
    .await?;
    let ids = company_ids(input);
    if !ids.is_empty() {
        let linked: Vec<String> =
            sqlx::query_scalar("select company_id from person_companies where person_id = $1")
                .bind(existing_id)
                .fetch_all(db)
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
/// `allow_duplicate_email` a new row is written even when someone has the
/// email (WeldBooks creates a separate person when asked to).
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
    let written: Vec<String> = sqlx::query_scalar(update_sql!(
        people,
        "where t.id = $1 and ($3::int is null or t.version = $3) returning t.id"
    ))
    .bind(id)
    .bind(PEOPLE.set(&updates))
    .bind(expected.map(|_| i32::try_from(version).unwrap_or(i32::MAX)))
    .fetch_all(db)
    .await?;
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
    if !codes.is_empty() {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from people t where deleted_at is null and party_code = any($1)",
        )
        .bind(&codes)
        .fetch_all(db)
        .await?;
        for row in rows.into_iter().map(drizzle_row) {
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
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from people t where deleted_at is null and lower(email) = any($1)",
        )
        .bind(&emails)
        .fetch_all(db)
        .await?;
        for row in rows.into_iter().map(drizzle_row) {
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
    sqlx::query(
        "update people set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(now())
    .execute(db)
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
    sqlx::query(
        "update people set archived_at = case when $3 then $2::timestamp else null end,
             updated_at = $2::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(now())
    .bind(archived)
    .execute(db)
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
    let existing: Option<(String, Option<String>)> = sqlx::query_as(
        "select id, owner_id from people
         where id = $1 and deleted_at is null and ($2::text is null or owner_id = $2 or owner_id is null)
         limit 1",
    )
    .bind(id)
    .bind(scope)
    .fetch_optional(db)
    .await?;
    let Some((_, owner)) = existing else {
        return Ok(None);
    };
    sqlx::query(
        "update people set in_crm = true, owner_id = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(id)
    .bind(owner.as_deref().or(acting_user))
    .bind(now())
    .execute(db)
    .await?;
    let updated = get_person(db, id, None).await?;
    if let Some(updated) = &updated {
        ensure_wrapping_party(db, updated).await?;
    }
    Ok(updated)
}

// ── Companies, detail, navigation ───────────────────────────────────────────

/// `listPersonCompanies(db, personId, ownerScope)`: the person's company
/// links with the live company's card, primary first.
pub async fn list_person_companies(
    db: &PgPool,
    person_id: &str,
    scope: Option<&str>,
) -> DomainResult<Vec<Value>> {
    if scope.is_some() && get_person(db, person_id, scope).await?.is_none() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
                 'id', pc.id, 'created_at', pc.created_at, 'updated_at', pc.updated_at,
                 'person_id', pc.person_id, 'company_id', pc.company_id, 'role', pc.role,
                 'is_primary', pc.is_primary, 'started_at', pc.started_at, 'ended_at', pc.ended_at,
                 'company', jsonb_build_object('id', pc.company_id, 'displayName', c.display_name,
                     'name', c.name, 'industry', c.industry, 'avatarUrl', c.avatar_url))
         from person_companies pc
         left join companies c on c.id = pc.company_id and c.deleted_at is null
         where pc.person_id = $1 and c.display_name is not null
         order by pc.is_primary desc, pc.created_at desc",
    )
    .bind(person_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(drizzle_row).collect())
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
    let activities: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_activities t where person_id = $1 and deleted_at is null
         order by created_at desc limit $2",
    )
    .bind(person_id)
    .bind(limits.activities.min(50))
    .fetch_all(db)
    .await?;
    let tickets: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_tickets t where person_id = $1 and deleted_at is null
         order by created_at desc limit $2",
    )
    .bind(person_id)
    .bind(limits.tickets.min(50))
    .fetch_all(db)
    .await?;
    let counts: (i64, i64, i64, i64, i64) = sqlx::query_as(
        "select
           (select count(*) from person_companies where person_id = $1),
           (select count(*) from crm_activities where person_id = $1 and deleted_at is null),
           (select count(*) from helpdesk_tickets where person_id = $1 and deleted_at is null),
           (select count(*) from crm_activities where person_id = $1 and type = 'note' and deleted_at is null),
           (select count(*) from crm_activities where person_id = $1 and type = 'task' and deleted_at is null)",
    )
    .bind(person_id)
    .fetch_one(db)
    .await?;
    let activities: Vec<Value> = activities.into_iter().map(drizzle_row).collect();
    let last_activity = activities
        .first()
        .and_then(|row| row.get("createdAt"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(Some(json!({
        "person": person,
        "companies": companies,
        "activities": activities,
        "tickets": tickets.into_iter().map(drizzle_row).collect::<Vec<_>>(),
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
    if let Some(list_id) = list_id {
        let name: Option<String> = sqlx::query_scalar(
            "select name from lists where id = $1 and deleted_at is null limit 1",
        )
        .bind(list_id)
        .fetch_optional(db)
        .await?;
        let context = name.unwrap_or_else(|| "People List".to_owned());
        let members: Vec<String> = sqlx::query_scalar(
            "select lm.entity_id from list_members lm inner join people p on p.id = lm.entity_id
             where lm.list_id = $1 and p.deleted_at is null and ($2::text is null or p.owner_id = $2)
             order by lm.added_at desc",
        )
        .bind(list_id)
        .bind(scope)
        .fetch_all(db)
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
    let created: Option<String> = sqlx::query_scalar(
        "select to_char(date_trunc('milliseconds', created_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS')
         from people where id = $1 and deleted_at is null and ($2::text is null or owner_id = $2) limit 1",
    )
    .bind(person_id)
    .bind(scope)
    .fetch_optional(db)
    .await?;
    let Some(created) = created else {
        return Ok(None);
    };
    let (total, previous, next, after): (i64, Option<String>, Option<String>, i64) = sqlx::query_as(
        "select
           (select count(*) from people where deleted_at is null and ($1::text is null or owner_id = $1)),
           (select id from people where deleted_at is null and ($1::text is null or owner_id = $1)
              and created_at > $2::timestamp order by created_at limit 1),
           (select id from people where deleted_at is null and ($1::text is null or owner_id = $1)
              and created_at < $2::timestamp order by created_at desc limit 1),
           (select count(*) from people where deleted_at is null and ($1::text is null or owner_id = $1)
              and created_at > $2::timestamp)",
    )
    .bind(scope)
    .bind(&created)
    .fetch_one(db)
    .await?;
    Ok(Some(json!({
        "currentIndex": after + 1,
        "totalCount": total,
        "previousId": previous,
        "nextId": next,
        "contextName": "All People",
    })))
}

// ── Mail recipient resolvers ────────────────────────────────────────────────

/// `PersonSummary`'s columns.
macro_rules! summary {
    () => {
        "select jsonb_build_object('id', id, 'displayName', display_name, 'firstName', first_name,
             'lastName', last_name, 'email', email, 'avatarUrl', avatar_url) from people "
    };
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
    Ok(sqlx::query_scalar(concat!(
        summary!(),
        "where deleted_at is null and lower(email) = any($1)"
    ))
    .bind(&normalised)
    .fetch_all(db)
    .await?)
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
    Ok(sqlx::query_scalar(concat!(
        summary!(),
        "where deleted_at is null and archived_at is null
           and ($1::text[] is null or lower(email) = any($1))
         order by updated_at desc limit $2"
    ))
    .bind(emails)
    .bind(limit)
    .fetch_all(db)
    .await?)
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
    let before: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'ownerId', owner_id, 'accountManagerId', account_manager_id,
                 'status', status, 'lifecycleStage', lifecycle_stage)
         from people where deleted_at is null and ($1::text is null or owner_id = $1)",
    )
    .bind(scope)
    .fetch_all(db)
    .await?;
    let before: HashMap<String, Value> = before.into_iter().map(|row| (id_of(&row), row)).collect();
    let mut updates = Map::new();
    updates.insert("updatedAt".into(), json!(now()));
    for field in BULK_FIELDS {
        if let Some(value) = set_fields.get(field) {
            updates.insert(field.into(), value.clone());
        }
    }
    let written: Vec<String> = sqlx::query_scalar(update_sql!(
        people,
        "where t.id = any($1) and t.deleted_at is null and ($3::text is null or t.owner_id = $3) returning t.id"
    ))
    .bind(&ids)
    .bind(PEOPLE.set(&updates))
    .bind(scope)
    .fetch_all(db)
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
