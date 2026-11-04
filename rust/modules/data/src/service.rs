//! The WeldData service (`apps/workers/data-api/src/services/welddata.ts`):
//! lists of saved leads, converting leads into CRM people and companies,
//! enrichment columns and cells. No HTTP here.

use std::fmt::Write as _;

use serde_json::{Map, Value, json};
use weldsuite_crm_domain::DomainError;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::id::generate_id;

use crate::js::{is_js_space, js_lowercase, js_trim, text, truthy};
use crate::now;

/// What a service call fails with.
#[derive(Debug)]
pub(crate) enum ServiceError {
    Db(sqlx::Error),
    /// A CRM write refused or failed (`InvalidMemberIdError`,
    /// `PersonDuplicateEmailError`, …).
    Crm(DomainError),
    /// `throw new Error(message)`.
    Other(String),
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(error) => write!(f, "{error}"),
            Self::Crm(error) => f.write_str(&error.message()),
            Self::Other(message) => f.write_str(message),
        }
    }
}

impl From<sqlx::Error> for ServiceError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

impl From<DomainError> for ServiceError {
    fn from(error: DomainError) -> Self {
        Self::Crm(error)
    }
}

pub(crate) type ServiceResult<T> = Result<T, ServiceError>;

/// One page of a list: the rows, the count, whether there is more, the
/// next cursor.
pub(crate) struct Page {
    pub(crate) rows: Vec<Value>,
    pub(crate) total_count: i64,
    pub(crate) has_more: bool,
    pub(crate) cursor: Option<String>,
}

/// `.limit(limit + 1)` of a validated page size (1–100, a fraction
/// allowed by the schema): Postgres refuses a fractional LIMIT, as it does
/// the worker's.
fn page_limit(limit: f64) -> ServiceResult<i64> {
    if limit.fract() != 0.0 {
        return Err(ServiceError::Other(format!(
            "invalid input syntax for type bigint: \"{}\"",
            limit + 1.0
        )));
    }
    #[allow(clippy::cast_possible_truncation)]
    Ok(limit as i64 + 1)
}

/// The page and cursor of `limit + 1` rows.
fn paged(mut rows: Vec<Value>, limit: i64, total_count: i64) -> Page {
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit;
    if has_more {
        rows.truncate(limit);
    }
    let cursor = if has_more {
        rows.last()
            .and_then(|row| text(row, "id"))
            .map(str::to_owned)
    } else {
        None
    };
    Page {
        rows,
        total_count,
        has_more,
        cursor,
    }
}

/// The keyset of a cursor row of `table` (`createdAt` as a `Date`
/// holds it, the id), when the row is there.
async fn cursor_of(
    db: &PgPool,
    table: &str,
    id: Option<&str>,
) -> ServiceResult<Option<(String, String)>> {
    let Some(id) = id else {
        return Ok(None);
    };
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t.created_at) from {table} t where t.id = $1 limit 1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|created| {
        js_row(json!({ "createdAt": created }))
            .get("createdAt")
            .and_then(Value::as_str)
            .map(|created| (created.to_owned(), id.to_owned()))
    }))
}

fn rows(values: Vec<Value>) -> Vec<Value> {
    values.into_iter().map(js_row).collect()
}

// ── Lists ───────────────────────────────────────────────────────────────────

/// `listLists(db, params)`: the page, each list with its live lead count.
pub(crate) async fn list_lists(
    db: &PgPool,
    cursor: Option<&str>,
    limit: f64,
    search: Option<&str>,
) -> ServiceResult<Page> {
    let limit = limit.min(100.0);
    let take = page_limit(limit)?;
    let pattern = search.filter(|s| !s.is_empty()).map(|s| format!("%{s}%"));
    let keyset = cursor_of(db, "welddata_lists", cursor.filter(|c| !c.is_empty())).await?;
    let (created, id) = keyset.clone().unzip();
    let found: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from welddata_lists t
         where t.deleted_at is null and ($1::text is null or t.name ilike $1)
           and ($2::timestamp is null or t.created_at < $2::timestamp
                or (t.created_at = $2::timestamp and t.id < $3))
         order by t.created_at desc, t.id desc limit $4",
    )
    .bind(&pattern)
    .bind(&created)
    .bind(&id)
    .bind(take)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from welddata_lists t
         where t.deleted_at is null and ($1::text is null or t.name ilike $1)",
    )
    .bind(&pattern)
    .fetch_one(db)
    .await?;
    let mut page = paged(rows(found), take - 1, total);
    let ids: Vec<String> = page
        .rows
        .iter()
        .filter_map(|row| text(row, "id").map(str::to_owned))
        .collect();
    let counts: Vec<(String, i32)> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "select list_id, count(*)::int from welddata_leads
             where list_id = any($1) and deleted_at is null group by list_id",
        )
        .bind(&ids)
        .fetch_all(db)
        .await?
    };
    for row in &mut page.rows {
        let count = text(row, "id")
            .and_then(|id| counts.iter().find(|(list, _)| list == id))
            .map_or(0, |(_, count)| *count);
        row["leadCount"] = json!(count);
    }
    Ok(page)
}

/// `getList(db, id)`: a live list with its lead count.
pub(crate) async fn get_list(db: &PgPool, id: &str) -> ServiceResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from welddata_lists t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let count: i32 = sqlx::query_scalar(
        "select count(*)::int from welddata_leads where list_id = $1 and deleted_at is null",
    )
    .bind(id)
    .fetch_one(db)
    .await?;
    let mut row = js_row(row);
    row["leadCount"] = json!(count);
    Ok(Some(row))
}

async fn list_row(db: &PgPool, id: &str) -> ServiceResult<Option<Value>> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from welddata_lists t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

/// A new list's fields, as the schema read them.
pub(crate) struct NewList {
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) description: Option<String>,
    pub(crate) color: Option<String>,
    pub(crate) icon: Option<String>,
}

/// `createList(db, input, createdBy)`.
pub(crate) async fn create_list(
    db: &PgPool,
    input: NewList,
    created_by: &str,
) -> ServiceResult<Value> {
    let id = generate_id("wdlist");
    let at = now();
    sqlx::query(
        "insert into welddata_lists (id, created_at, updated_at, kind, name, description, color, icon, created_by)
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(&at)
    .bind(&input.kind)
    .bind(&input.name)
    .bind(&input.description)
    .bind(input.color.as_deref().unwrap_or("bg-blue-500"))
    .bind(input.icon.as_deref().unwrap_or("Database"))
    .bind(created_by)
    .execute(db)
    .await?;
    list_row(db, &id)
        .await?
        .ok_or_else(|| ServiceError::Other("List disappeared after insert".to_owned()))
}

async fn live_list_kind(db: &PgPool, id: &str) -> ServiceResult<Option<String>> {
    Ok(sqlx::query_scalar(
        "select kind from welddata_lists where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?)
}

/// `updateList(db, id, input)`: the fields given (`name`, `description`,
/// `color`, `icon`), or `None` when the list isn't there.
pub(crate) async fn update_list(
    db: &PgPool,
    id: &str,
    fields: &[(&'static str, String)],
) -> ServiceResult<Option<Value>> {
    if live_list_kind(db, id).await?.is_none() {
        return Ok(None);
    }
    let mut sql = String::from("update welddata_lists set updated_at = $2::timestamp");
    for (index, (column, _)) in fields.iter().enumerate() {
        let _ = write!(sql, ", {column} = ${}", index + 3);
    }
    sql.push_str(" where id = $1");
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(id).bind(now());
    for (_, value) in fields {
        query = query.bind(value);
    }
    query.execute(db).await?;
    list_row(db, id).await
}

/// `deleteList(db, id)`: the list and its leads, soft.
pub(crate) async fn delete_list(db: &PgPool, id: &str) -> ServiceResult<bool> {
    if live_list_kind(db, id).await?.is_none() {
        return Ok(false);
    }
    let at = now();
    sqlx::query("update welddata_lists set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(id)
        .bind(&at)
        .execute(db)
        .await?;
    sqlx::query(
        "update welddata_leads set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where list_id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(&at)
    .execute(db)
    .await?;
    Ok(true)
}

// ── Saved leads ─────────────────────────────────────────────────────────────

/// The lead fields a saved lead takes from its input, `(input, column)`.
const LEAD_TEXT_FIELDS: [(&str, &str); 11] = [
    ("lemlistId", "lemlist_id"),
    ("name", "name"),
    ("email", "email"),
    ("title", "title"),
    ("companyName", "company_name"),
    ("domain", "domain"),
    ("industry", "industry"),
    ("location", "location"),
    ("country", "country"),
    ("companySize", "company_size"),
    ("linkedinUrl", "linkedin_url"),
];

/// `addLeads(db, listId, input, addedBy)`: `(added, skipped)`, or `None`
/// when the list isn't there. Leads of the other kind are skipped, and so
/// are those already saved (same list, kind and Lemlist id).
pub(crate) async fn add_leads(
    db: &PgPool,
    list_id: &str,
    leads: &[Map<String, Value>],
    added_by: &str,
) -> ServiceResult<Option<(usize, usize)>> {
    let Some(kind) = live_list_kind(db, list_id).await? else {
        return Ok(None);
    };
    let matching: Vec<&Map<String, Value>> = leads
        .iter()
        .filter(|lead| lead.get("kind").and_then(Value::as_str) == Some(kind.as_str()))
        .collect();
    let mismatched = leads.len() - matching.len();
    if matching.is_empty() {
        return Ok(Some((0, leads.len())));
    }
    let at = now();
    let records: Vec<Value> = matching
        .iter()
        .map(|lead| {
            let mut record = Map::new();
            record.insert("id".into(), json!(generate_id("wdlead")));
            record.insert("created_at".into(), json!(at));
            record.insert("updated_at".into(), json!(at));
            record.insert("list_id".into(), json!(list_id));
            record.insert("added_by".into(), json!(added_by));
            record.insert(
                "kind".into(),
                lead.get("kind").cloned().unwrap_or(Value::Null),
            );
            for (field, column) in LEAD_TEXT_FIELDS {
                record.insert(
                    column.into(),
                    lead.get(field).cloned().unwrap_or(Value::Null),
                );
            }
            record.insert(
                "data".into(),
                lead.get("data").cloned().unwrap_or(Value::Null),
            );
            record.insert("converted_status".into(), json!("pending"));
            Value::Object(record)
        })
        .collect();
    let inserted: Vec<String> = sqlx::query_scalar(
        "insert into welddata_leads (id, created_at, updated_at, list_id, added_by, kind, lemlist_id, data,
                                     name, email, title, company_name, domain, industry, location, country,
                                     company_size, linkedin_url, converted_status)
         select id, created_at, updated_at, list_id, added_by, kind, lemlist_id, data,
                name, email, title, company_name, domain, industry, location, country,
                company_size, linkedin_url, converted_status
         from jsonb_populate_recordset(null::welddata_leads, $1)
         on conflict (list_id, kind, lemlist_id) do nothing
         returning id",
    )
    .bind(Value::Array(records))
    .fetch_all(db)
    .await?;
    Ok(Some((
        inserted.len(),
        matching.len() - inserted.len() + mismatched,
    )))
}

/// The filters of a saved-lead listing.
pub(crate) struct LeadQuery {
    pub(crate) cursor: Option<String>,
    pub(crate) limit: f64,
    pub(crate) search: Option<String>,
    pub(crate) kind: Option<String>,
    pub(crate) converted_status: Option<String>,
}

/// `listLeads(db, listId, params)`: the page, or `None` when the list
/// isn't there.
pub(crate) async fn list_leads(
    db: &PgPool,
    list_id: &str,
    query: &LeadQuery,
) -> ServiceResult<Option<Page>> {
    if live_list_kind(db, list_id).await?.is_none() {
        return Ok(None);
    }
    let take = page_limit(query.limit.min(100.0))?;
    let pattern = query
        .search
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let keyset = cursor_of(
        db,
        "welddata_leads",
        query.cursor.as_deref().filter(|c| !c.is_empty()),
    )
    .await?;
    let (created, id) = keyset.unzip();
    let filters = "t.list_id = $1 and t.deleted_at is null
           and ($2::text is null or t.kind = $2)
           and ($3::text is null or t.converted_status = $3)
           and ($4::text is null or t.name ilike $4 or t.email ilike $4 or t.company_name ilike $4)";
    let found: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from welddata_leads t where {filters}
           and ($5::timestamp is null or t.created_at < $5::timestamp
                or (t.created_at = $5::timestamp and t.id < $6))
         order by t.created_at desc, t.id desc limit $7"
    )))
    .bind(list_id)
    .bind(query.kind.as_deref().filter(|s| !s.is_empty()))
    .bind(query.converted_status.as_deref().filter(|s| !s.is_empty()))
    .bind(&pattern)
    .bind(&created)
    .bind(&id)
    .bind(take)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from welddata_leads t where {filters}"
    )))
    .bind(list_id)
    .bind(query.kind.as_deref().filter(|s| !s.is_empty()))
    .bind(query.converted_status.as_deref().filter(|s| !s.is_empty()))
    .bind(&pattern)
    .fetch_one(db)
    .await?;
    Ok(Some(paged(rows(found), take - 1, total)))
}

/// `getLead(db, id)`: a live saved lead.
pub(crate) async fn get_lead(db: &PgPool, id: &str) -> ServiceResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from welddata_leads t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `removeLead(db, id)`: soft.
pub(crate) async fn remove_lead(db: &PgPool, id: &str) -> ServiceResult<bool> {
    if get_lead(db, id).await?.is_none() {
        return Ok(false);
    }
    let at = now();
    sqlx::query("update welddata_leads set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(id)
        .bind(&at)
        .execute(db)
        .await?;
    Ok(true)
}

/// `getSavedLemlistIds(db, listIds)`: the Lemlist ids saved in the lists.
pub(crate) async fn saved_lemlist_ids(
    db: &PgPool,
    list_ids: &[String],
) -> ServiceResult<Vec<String>> {
    let mut ids: Vec<String> = Vec::new();
    for id in list_ids.iter().filter(|id| !id.is_empty()) {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let saved: Vec<String> = sqlx::query_scalar(
        "select lemlist_id from welddata_leads
         where list_id = any($1) and lemlist_id is not null and deleted_at is null",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    Ok(saved.into_iter().filter(|id| !id.is_empty()).collect())
}

// ── Conversion into CRM ─────────────────────────────────────────────────────

/// What a conversion made.
#[derive(Debug, Clone, Default)]
pub(crate) struct Materialised {
    pub(crate) person_id: Option<String>,
    pub(crate) company_id: Option<String>,
    pub(crate) created_person: bool,
    pub(crate) created_company: bool,
}

/// `splitName(name)`: first word, and the rest.
fn split_name(name: Option<&str>) -> (Option<String>, Option<String>) {
    let trimmed = js_trim(name.unwrap_or_default());
    if trimmed.is_empty() {
        return (None, None);
    }
    let mut words = trimmed.split(is_js_space).filter(|word| !word.is_empty());
    let first = words.next().unwrap_or_default().to_owned();
    let rest = words.collect::<Vec<_>>().join(" ");
    (Some(first), (!rest.is_empty()).then_some(rest))
}

/// A string field, `null` and absent alike `None` (`value ?? undefined`).
fn field<'a>(lead: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    lead.get(key).and_then(Value::as_str)
}

/// `findOrCreateCompany(db, args)`: a live company of that name (any
/// case), else a new lead company. `(id, created)`.
async fn find_or_create_company(
    db: &PgPool,
    name: &str,
    extra: &[(&str, Option<&str>)],
    owner_id: &str,
) -> ServiceResult<(String, bool)> {
    let existing: Option<String> = sqlx::query_scalar(
        "select id from companies where lower(name) = $1 and deleted_at is null limit 1",
    )
    .bind(js_lowercase(name))
    .fetch_optional(db)
    .await?;
    if let Some(id) = existing {
        return Ok((id, false));
    }
    let mut input = Map::new();
    input.insert("name".into(), json!(name));
    for (key, value) in extra {
        if let Some(value) = value {
            input.insert((*key).into(), json!(value));
        }
    }
    input.insert("ownerId".into(), json!(owner_id));
    input.insert("isLead".into(), json!(true));
    input.insert("source".into(), json!("welddata/lemlist"));
    let company = weldsuite_crm_domain::companies::create_company(db, &input, None).await?;
    let id = text(&company, "id").unwrap_or_default().to_owned();
    Ok((id, true))
}

/// `convertSearchLead(db, lead, opts)`: find or create the company, create
/// the person and link them; no WeldData row is touched. `lead` is a saved
/// lead (its columns) or a search row (the input's fields).
pub(crate) async fn convert_search_lead(
    db: &PgPool,
    lead: &Map<String, Value>,
    create_company: bool,
    owner_id: &str,
) -> ServiceResult<Materialised> {
    let mut out = Materialised::default();
    if field(lead, "kind") == Some("company") {
        let Some(name) = truthy(field(lead, "companyName")).or_else(|| truthy(field(lead, "name")))
        else {
            return Err(ServiceError::Other(
                "Company lead has no name to convert".to_owned(),
            ));
        };
        let (id, created) = find_or_create_company(
            db,
            name,
            &[
                ("website", field(lead, "domain")),
                ("industry", field(lead, "industry")),
                ("linkedinUrl", field(lead, "linkedinUrl")),
            ],
            owner_id,
        )
        .await?;
        out.company_id = Some(id);
        out.created_company = created;
        return Ok(out);
    }
    if create_company && let Some(company) = truthy(field(lead, "companyName")) {
        let (id, created) = find_or_create_company(
            db,
            company,
            &[
                ("website", field(lead, "domain")),
                ("industry", field(lead, "industry")),
            ],
            owner_id,
        )
        .await?;
        out.company_id = Some(id);
        out.created_company = created;
    }
    let (first, last) = split_name(field(lead, "name"));
    let mut input = Map::new();
    if let Some(first) = first {
        input.insert("firstName".into(), json!(first));
    }
    if let Some(last) = last {
        input.insert("lastName".into(), json!(last));
    }
    for key in ["email", "title", "linkedinUrl"] {
        if let Some(value) = truthy(field(lead, key)) {
            input.insert(key.into(), json!(value));
        }
    }
    input.insert("ownerId".into(), json!(owner_id));
    input.insert("isLead".into(), json!(true));
    input.insert("source".into(), json!("welddata/lemlist"));
    if let Some(company) = &out.company_id {
        input.insert("companyIds".into(), json!([company]));
        input.insert("primaryCompanyId".into(), json!(company));
    }
    let (person, _) = weldsuite_crm_domain::people::create_person_detailed(db, &input).await?;
    out.person_id = text(&person, "id").map(str::to_owned);
    out.created_person = true;
    Ok(out)
}

/// What converting a saved lead did.
pub(crate) struct Converted {
    pub(crate) made: Materialised,
    /// The lead was already converted: nothing was done.
    pub(crate) already: bool,
}

/// `convertLead(db, lead, opts)`: idempotent; marks the lead converted.
pub(crate) async fn convert_lead(
    db: &PgPool,
    lead: &Map<String, Value>,
    create_company: bool,
    owner_id: &str,
) -> ServiceResult<Converted> {
    let id = field(lead, "id").unwrap_or_default();
    if field(lead, "convertedStatus") == Some("converted") {
        return Ok(Converted {
            made: Materialised {
                person_id: field(lead, "convertedPersonId").map(str::to_owned),
                company_id: field(lead, "convertedCompanyId").map(str::to_owned),
                created_person: false,
                created_company: false,
            },
            already: true,
        });
    }
    let made = convert_search_lead(db, lead, create_company, owner_id).await?;
    let at = now();
    sqlx::query(
        "update welddata_leads set converted_status = 'converted', converted_at = $2::timestamp,
                converted_person_id = $3, converted_company_id = $4, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(&at)
    .bind(&made.person_id)
    .bind(&made.company_id)
    .execute(db)
    .await?;
    Ok(Converted {
        made,
        already: false,
    })
}

/// `getCrmList(db, id)`: a live CRM list's kind.
pub(crate) async fn crm_list_kind(db: &PgPool, id: &str) -> ServiceResult<Option<String>> {
    Ok(
        sqlx::query_scalar("select kind from lists where id = $1 and deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

/// `addCrmListMembers(db, listId, entityIds)`: the members added (those
/// already on the list are skipped).
pub(crate) async fn add_crm_list_members(
    db: &PgPool,
    list_id: &str,
    entity_ids: &[String],
) -> ServiceResult<usize> {
    let mut deduped: Vec<String> = Vec::new();
    for id in entity_ids {
        if !deduped.contains(id) {
            deduped.push(id.clone());
        }
    }
    if deduped.is_empty() {
        return Ok(0);
    }
    let existing: Vec<String> = sqlx::query_scalar(
        "select entity_id from list_members where list_id = $1 and entity_id = any($2)",
    )
    .bind(list_id)
    .bind(&deduped)
    .fetch_all(db)
    .await?;
    let to_add: Vec<String> = deduped
        .into_iter()
        .filter(|id| !existing.contains(id))
        .collect();
    if to_add.is_empty() {
        return Ok(0);
    }
    let ids: Vec<String> = to_add.iter().map(|_| generate_id("lm")).collect();
    sqlx::query(
        "insert into list_members (id, list_id, entity_id, added_at)
         select member.id, $2, member.entity_id, $4::timestamp
         from unnest($1::text[], $3::text[]) as member(id, entity_id)",
    )
    .bind(&ids)
    .bind(list_id)
    .bind(&to_add)
    .bind(now())
    .execute(db)
    .await?;
    Ok(to_add.len())
}

// ── Enrichment columns and cells ────────────────────────────────────────────

/// `listColumns(db, listId)`.
pub(crate) async fn list_columns(db: &PgPool, list_id: &str) -> ServiceResult<Vec<Value>> {
    let found: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from welddata_columns t
         where t.list_id = $1 and t.deleted_at is null order by t.sort_order, t.created_at",
    )
    .bind(list_id)
    .fetch_all(db)
    .await?;
    Ok(rows(found))
}

/// `getColumn(db, id)`: a live column.
pub(crate) async fn get_column(db: &PgPool, id: &str) -> ServiceResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from welddata_columns t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `createColumn(db, listId, input, createdBy)`: at the end of the list's
/// columns; `None` when the list isn't there.
pub(crate) async fn create_column(
    db: &PgPool,
    list_id: &str,
    name: &str,
    config: &Value,
    created_by: &str,
) -> ServiceResult<Option<Value>> {
    if live_list_kind(db, list_id).await?.is_none() {
        return Ok(None);
    }
    let max: i32 = sqlx::query_scalar(
        "select coalesce(max(sort_order), -1) from welddata_columns where list_id = $1 and deleted_at is null",
    )
    .bind(list_id)
    .fetch_one(db)
    .await?;
    let id = generate_id("wdcol");
    let at = now();
    sqlx::query(
        "insert into welddata_columns (id, created_at, updated_at, list_id, name, type, config, sort_order, created_by)
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(&at)
    .bind(list_id)
    .bind(name)
    .bind(config.get("type").and_then(Value::as_str))
    .bind(config)
    .bind(max + 1)
    .bind(created_by)
    .execute(db)
    .await?;
    get_column(db, &id).await
}

/// `updateColumn(db, id, input)`: `None` when the column isn't there.
pub(crate) async fn update_column(
    db: &PgPool,
    id: &str,
    name: Option<&str>,
    sort_order: Option<i64>,
    config: Option<&Value>,
) -> ServiceResult<Option<Value>> {
    if get_column(db, id).await?.is_none() {
        return Ok(None);
    }
    sqlx::query(
        "update welddata_columns set updated_at = $2::timestamp,
                name = coalesce($3, name),
                sort_order = coalesce($4::int, sort_order),
                config = case when $5::boolean then $6 else config end,
                type = case when $5::boolean then $7 else type end
         where id = $1",
    )
    .bind(id)
    .bind(now())
    .bind(name)
    .bind(sort_order)
    .bind(config.is_some())
    .bind(config)
    .bind(config.and_then(|c| c.get("type")).and_then(Value::as_str))
    .execute(db)
    .await?;
    get_column(db, id).await
}

/// `deleteColumn(db, id)`: the column soft, its cells for good.
pub(crate) async fn delete_column(db: &PgPool, id: &str) -> ServiceResult<bool> {
    if get_column(db, id).await?.is_none() {
        return Ok(false);
    }
    let at = now();
    sqlx::query("update welddata_columns set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(id)
        .bind(&at)
        .execute(db)
        .await?;
    sqlx::query("delete from welddata_cells where column_id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(true)
}

/// `STUCK_RUNNING_MS`: a cell still running ten minutes after its last
/// update is an orphan of a run that died.
const STUCK_RUNNING_MS: i64 = 10 * 60 * 1000;

async fn live_column_ids(db: &PgPool, list_id: &str) -> ServiceResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "select id from welddata_columns where list_id = $1 and deleted_at is null",
    )
    .bind(list_id)
    .fetch_all(db)
    .await?)
}

/// `reclaimStuckRunningCells(db, { listId })`: orphaned running cells of
/// the list become errors, re-runnable.
async fn reclaim_stuck_running_cells(db: &PgPool, list_id: &str) -> ServiceResult<()> {
    let columns = live_column_ids(db, list_id).await?;
    if columns.is_empty() {
        return Ok(());
    }
    let cutoff = weldsuite_events::iso_timestamp(
        time::OffsetDateTime::now_utc() - time::Duration::milliseconds(STUCK_RUNNING_MS),
    );
    sqlx::query(
        "update welddata_cells set status = 'error', error = 'Timed out — please re-run.', updated_at = $3::timestamp
         where status = 'running' and updated_at < $2::timestamp and column_id = any($1)",
    )
    .bind(&columns)
    .bind(&cutoff)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// `listCells(db, listId)`: every cell of the list's live columns, after
/// timing out the stuck ones (best effort).
pub(crate) async fn list_cells(db: &PgPool, list_id: &str) -> ServiceResult<Vec<Value>> {
    if let Err(error) = reclaim_stuck_running_cells(db, list_id).await {
        tracing::warn!(%error, "welddata: reclaiming stuck cells failed");
    }
    let columns = live_column_ids(db, list_id).await?;
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let found: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(t) from welddata_cells t where t.column_id = any($1)")
            .bind(&columns)
            .fetch_all(db)
            .await?;
    Ok(rows(found))
}

/// `resolveTargetLeadIds(db, listId, columnId, opts)`: the leads given,
/// else every live lead of the list; without those whose cell is done when
/// `only_missing`.
pub(crate) async fn resolve_target_lead_ids(
    db: &PgPool,
    list_id: &str,
    column_id: &str,
    lead_ids: Option<Vec<String>>,
    only_missing: bool,
) -> ServiceResult<Vec<String>> {
    let mut ids = match lead_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => {
            sqlx::query_scalar(
                "select id from welddata_leads where list_id = $1 and deleted_at is null",
            )
            .bind(list_id)
            .fetch_all(db)
            .await?
        }
    };
    if only_missing && !ids.is_empty() {
        let done: Vec<String> = sqlx::query_scalar(
            "select lead_id from welddata_cells where column_id = $1 and status = 'done'",
        )
        .bind(column_id)
        .fetch_all(db)
        .await?;
        ids.retain(|id| !done.contains(id));
    }
    Ok(ids)
}

/// `markCellsPending(db, columnId, leadIds)`: queued state, at once.
pub(crate) async fn mark_cells_pending(
    db: &PgPool,
    column_id: &str,
    lead_ids: &[String],
) -> ServiceResult<()> {
    let at = now();
    for chunk in lead_ids.chunks(500) {
        let ids: Vec<String> = chunk.iter().map(|_| generate_id("wdcell")).collect();
        sqlx::query(
            "insert into welddata_cells (id, created_at, updated_at, column_id, lead_id, status)
             select cell.id, $2::timestamp, $2::timestamp, $3, cell.lead_id, 'pending'
             from unnest($1::text[], $4::text[]) as cell(id, lead_id)
             on conflict (column_id, lead_id)
             do update set status = 'pending', error = null, updated_at = $2::timestamp",
        )
        .bind(&ids)
        .bind(&at)
        .bind(column_id)
        .bind(chunk)
        .execute(db)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_split_like_the_worker() {
        assert_eq!(split_name(None), (None, None));
        assert_eq!(split_name(Some("  ")), (None, None));
        assert_eq!(split_name(Some("Ada")), (Some("Ada".into()), None));
        assert_eq!(
            split_name(Some(" Linus  Benedict\tTorvalds ")),
            (Some("Linus".into()), Some("Benedict Torvalds".into()))
        );
    }

    #[test]
    fn pages_cut_at_the_limit() {
        let page = paged(vec![json!({ "id": "a" }), json!({ "id": "b" })], 1, 2);
        assert!(page.has_more);
        assert_eq!(page.cursor.as_deref(), Some("a"));
        assert!(page_limit(2.5).is_err());
        assert_eq!(page_limit(50.0).ok(), Some(51));
    }
}
