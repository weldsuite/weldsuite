//! `prospects.ts`: the outreach contact store, imports (rows, CRM lists,
//! WeldData lists) and the prospect operations.

use std::collections::HashSet;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{REACH_PROSPECT_CREATED, REACH_PROSPECT_DELETED, REACH_PROSPECT_UPDATED};
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;

use crate::campaigns::complete_and_publish;
use crate::lists::{Page, PageQuery, add_to_list, create_list, cursor_row, find_list, like_pattern, page_result, parse_limit, recount_list};
use crate::schemas::email_domain;
use crate::suppressions::load_index;
use crate::text::js_trim;
use crate::validation::validate_emails;
use crate::{EventSink, ReachError, ReachEvent, ReachResult, field, iso, js_rows, js_slice, now, text};

const CHUNK: usize = 500;
const VALIDATIONS: &[&str] = &["valid", "role", "consumer", "no_mx", "invalid", "suppressed"];

/// `MAX_SOURCE_LIST_ROWS`.
pub const MAX_SOURCE_LIST_ROWS: i64 = 10_000;
/// `MAX_IMPORT_EVENTS`.
pub const MAX_IMPORT_EVENTS: usize = 100;

/// `toProspect(row)`.
pub fn to_prospect(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "email": field(row, "email"),
        "firstName": field(row, "firstName"),
        "lastName": field(row, "lastName"),
        "companyName": field(row, "companyName"),
        "companyDomain": field(row, "companyDomain"),
        "title": field(row, "title"),
        "timezone": field(row, "timezone"),
        "customFields": row.get("customFields").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({})),
        "source": field(row, "source"),
        "sourceRef": field(row, "sourceRef"),
        "personId": field(row, "personId"),
        "validation": field(row, "validation"),
        "createdAt": field(row, "createdAt"),
    })
}

/// One row to import (`ImportRow`).
#[derive(Debug, Clone, Default)]
pub struct ImportRow {
    pub person_id: Option<String>,
    pub email: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub company_name: Option<String>,
    pub title: Option<String>,
    pub timezone: Option<String>,
    /// `customFields`, in the body's order; `None` when absent.
    pub custom_fields: Option<Map<String, Value>>,
}

/// A stored row (`StoredProspect`).
#[derive(Debug, Clone)]
pub struct StoredProspect {
    pub id: String,
    pub email: String,
    pub validation: String,
    pub is_new: bool,
}

/// `ImportOutcome`.
#[derive(Debug, Clone)]
pub struct ImportOutcome {
    pub stored: Vec<StoredProspect>,
    pub created: usize,
    pub updated: usize,
    pub skipped: Vec<(String, i64)>,
}

fn blank_to_null(value: Option<&str>) -> Option<String> {
    value.map(js_trim).filter(|t| !t.is_empty()).map(str::to_owned)
}

fn clip(value: Option<String>, max: usize) -> Option<String> {
    value.map(|v| js_slice(&v, max))
}

/// `reportSkipped(counts)`: by count, most first (a stable sort).
fn report_skipped(counts: Vec<(String, i64)>) -> Vec<(String, i64)> {
    let mut counts = counts;
    counts.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    counts
}

/// The options of one import (`ImportOptions`).
#[derive(Debug, Clone)]
pub struct ImportOptions<'a> {
    pub source: &'a str,
    pub source_ref: Option<&'a str>,
    pub created_by: Option<&'a str>,
    pub allow_consumer: bool,
}

/// `importProspects(db, rows, options)`.
pub async fn import_prospects(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    rows: &[ImportRow],
    options: &ImportOptions<'_>,
) -> ReachResult<ImportOutcome> {
    let mut skipped: Vec<(String, i64)> = Vec::new();
    let mut bump = |reason: &str| match skipped.iter_mut().find(|(r, _)| r == reason) {
        Some(entry) => entry.1 += 1,
        None => skipped.push((reason.to_owned(), 1)),
    };
    let mut emails: Vec<String> = Vec::new();
    let mut by_email: Vec<&ImportRow> = Vec::new();
    for row in rows {
        let email = js_trim(row.email.as_deref().unwrap_or_default()).to_lowercase();
        if email.is_empty() || !email.contains('@') || crate::js_len(&email) > 320 {
            bump("invalid_row");
            continue;
        }
        if emails.contains(&email) {
            bump("duplicate");
            continue;
        }
        emails.push(email);
        by_email.push(row);
    }
    if emails.is_empty() {
        return Ok(ImportOutcome {
            stored: Vec::new(),
            created: 0,
            updated: 0,
            skipped: report_skipped(skipped),
        });
    }
    let mut existing: HashSet<String> = HashSet::new();
    for chunk in emails.chunks(CHUNK) {
        let found: Vec<String> = sqlx::query_scalar("select email from reach_prospects where email = any($1)")
            .bind(chunk)
            .fetch_all(db)
            .await?;
        existing.extend(found);
    }
    let suppressed = load_index(db, &emails).await?;
    let verdicts = validate_emails(&emails, options.allow_consumer, &suppressed, http).await;
    let at = iso(now());
    let mut stored: Vec<StoredProspect> = Vec::new();
    for (chunk_index, chunk) in emails.chunks(CHUNK).enumerate() {
        let mut values: Vec<Value> = Vec::with_capacity(chunk.len());
        for (i, email) in chunk.iter().enumerate() {
            let row = by_email[chunk_index * CHUNK + i];
            let domain = email_domain(email);
            values.push(json!({
                "id": generate_id("rpro"),
                "email": email,
                "first_name": clip(blank_to_null(row.first_name.as_deref()), 100),
                "last_name": clip(blank_to_null(row.last_name.as_deref()), 100),
                "company_name": clip(blank_to_null(row.company_name.as_deref()), 200),
                "company_domain": if domain.is_empty() { None } else { Some(domain) },
                "person_id": blank_to_null(row.person_id.as_deref()),
                "title": clip(blank_to_null(row.title.as_deref()), 200),
                "timezone": clip(blank_to_null(row.timezone.as_deref()), 64),
                "custom_fields": row.custom_fields.clone().map_or_else(|| json!({}), Value::Object),
                "validation": verdicts.get(email).copied().unwrap_or("valid"),
            }));
        }
        let inserted: Vec<(String, String, String)> = sqlx::query_as(
            "insert into reach_prospects (id, email, first_name, last_name, company_name, company_domain, person_id,
                 title, timezone, custom_fields, source, source_ref, validation, created_by)
             select v->>'id', v->>'email', v->>'first_name', v->>'last_name', v->>'company_name', v->>'company_domain',
                 v->>'person_id', v->>'title', v->>'timezone', v->'custom_fields', $2, $3, v->>'validation', $4
             from jsonb_array_elements($1::jsonb) with ordinality as r(v, n) order by n
             on conflict (email) do update set
                 first_name = coalesce(excluded.first_name, reach_prospects.first_name),
                 last_name = coalesce(excluded.last_name, reach_prospects.last_name),
                 company_name = coalesce(excluded.company_name, reach_prospects.company_name),
                 title = coalesce(excluded.title, reach_prospects.title),
                 timezone = coalesce(excluded.timezone, reach_prospects.timezone),
                 person_id = coalesce(reach_prospects.person_id, excluded.person_id),
                 custom_fields = reach_prospects.custom_fields || excluded.custom_fields,
                 validation = excluded.validation,
                 deleted_at = null,
                 updated_at = $5::timestamptz
             returning id, email, validation",
        )
        .bind(Value::Array(values))
        .bind(options.source)
        .bind(options.source_ref)
        .bind(options.created_by)
        .bind(&at)
        .fetch_all(db)
        .await?;
        for (id, email, validation) in inserted {
            let is_new = !existing.contains(&email);
            stored.push(StoredProspect {
                id,
                email,
                validation,
                is_new,
            });
        }
    }
    for s in &stored {
        if s.validation != "valid" {
            bump(&s.validation);
        }
    }
    let created = stored.iter().filter(|s| s.is_new).count();
    let updated = stored.len() - created;
    Ok(ImportOutcome {
        stored,
        created,
        updated,
        skipped: report_skipped(skipped),
    })
}

/// `softDeleteProspect(db, id)`: the campaigns that lost an enrollment, or
/// `None` when there was no live prospect.
pub async fn soft_delete(db: &PgPool, id: &str) -> ReachResult<Option<Vec<String>>> {
    let at = iso(now());
    let row: Option<String> = sqlx::query_scalar(
        "update reach_prospects set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
         where id = $1 and deleted_at is null returning id",
    )
    .bind(id)
    .bind(&at)
    .fetch_optional(db)
    .await?;
    if row.is_none() {
        return Ok(None);
    }
    let lists: Vec<String> =
        sqlx::query_scalar("delete from reach_prospect_list_members where prospect_id = $1 returning list_id")
            .bind(id)
            .fetch_all(db)
            .await?;
    for list_id in crate::unique(&lists) {
        recount_list(db, &list_id).await?;
    }
    let stopped: Vec<String> = sqlx::query_scalar(
        "update reach_enrollments set status = 'failed', stopped_reason = 'prospect_deleted', claimed_at = null,
             next_send_at = null, updated_at = $2::timestamptz
         where prospect_id = $1 and status in ('queued', 'active') returning campaign_id",
    )
    .bind(id)
    .bind(&at)
    .fetch_all(db)
    .await?;
    Ok(Some(crate::unique(&stopped)))
}

/// Why a source list cannot be imported (`SourceListError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceListError {
    NotFound,
    WrongKind,
    SmartList,
    TooLarge,
}

impl SourceListError {
    fn message(self) -> &'static str {
        match self {
            Self::NotFound => "List not found",
            Self::WrongKind => "Only lists of people can be imported",
            Self::SmartList => "Smart lists cannot be imported; use a static list",
            Self::TooLarge => "This list is too large to import at once",
        }
    }
}

/// `splitName(full)`.
fn split_name(full: Option<&str>) -> (Option<String>, Option<String>) {
    let parts: Vec<&str> = full
        .unwrap_or_default()
        .split(crate::text::is_js_space)
        .filter(|p| !p.is_empty())
        .collect();
    match parts.as_slice() {
        [] => (None, None),
        [first] => (Some((*first).to_owned()), None),
        [first, rest @ ..] => (Some((*first).to_owned()), Some(rest.join(" "))),
    }
}

async fn current_company_names(db: &PgPool, person_ids: &[String]) -> ReachResult<Vec<(String, String)>> {
    let links: Vec<(String, String, Option<bool>)> = sqlx::query_as(
        "select person_id, company_id, is_primary from person_companies where person_id = any($1) and ended_at is null",
    )
    .bind(person_ids)
    .fetch_all(db)
    .await?;
    let company_ids = crate::unique(&links.iter().map(|l| l.1.clone()).collect::<Vec<_>>());
    let names: Vec<(String, String)> = if company_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("select id, display_name from companies where id = any($1) and deleted_at is null")
            .bind(&company_ids)
            .fetch_all(db)
            .await?
    };
    let mut ranked = links;
    ranked.sort_by_key(|l| std::cmp::Reverse(i32::from(l.2.unwrap_or(false))));
    let mut company_of: Vec<(String, String)> = Vec::new();
    for (person, company, _) in ranked {
        if let Some((_, name)) = names.iter().find(|(id, _)| *id == company)
            && !name.is_empty()
            && !company_of.iter().any(|(p, _)| *p == person)
        {
            company_of.push((person, name.clone()));
        }
    }
    Ok(company_of)
}

/// `loadCrmListRows(db, crmListId)`: (list name, rows).
pub async fn load_crm_list_rows(db: &PgPool, crm_list_id: &str) -> ReachResult<Result<(String, Vec<ImportRow>), SourceListError>> {
    let list: Option<(String, String, String)> =
        sqlx::query_as("select name, kind::text, type::text from lists where id = $1 and deleted_at is null limit 1")
            .bind(crm_list_id)
            .fetch_optional(db)
            .await?;
    let Some((name, kind, kind_type)) = list else {
        return Ok(Err(SourceListError::NotFound));
    };
    if kind != "person" {
        return Ok(Err(SourceListError::WrongKind));
    }
    if kind_type != "static" {
        return Ok(Err(SourceListError::SmartList));
    }
    let members: Vec<String> = sqlx::query_scalar("select entity_id from list_members where list_id = $1 limit $2")
        .bind(crm_list_id)
        .bind(MAX_SOURCE_LIST_ROWS + 1)
        .fetch_all(db)
        .await?;
    if i64::try_from(members.len()).unwrap_or_default() > MAX_SOURCE_LIST_ROWS {
        return Ok(Err(SourceListError::TooLarge));
    }
    let mut rows = Vec::new();
    for chunk in members.chunks(CHUNK) {
        let persons: Vec<(String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(
                "select id, email, first_name, last_name, display_name, title from people
                 where id = any($1) and deleted_at is null",
            )
            .bind(chunk)
            .fetch_all(db)
            .await?;
        let company_of = current_company_names(db, chunk).await?;
        for (id, email, first, last, display, title) in persons {
            let Some(email) = email.filter(|e| !e.is_empty()) else {
                continue;
            };
            let (fallback_first, fallback_last) = split_name(display.as_deref());
            rows.push(ImportRow {
                company_name: company_of.iter().find(|(p, _)| *p == id).map(|(_, n)| n.clone()),
                person_id: Some(id),
                email: Some(email),
                first_name: first.or(fallback_first),
                last_name: last.or(fallback_last),
                title,
                timezone: None,
                custom_fields: None,
            });
        }
    }
    Ok(Ok((name, rows)))
}

/// `loadWeldDataListRows(db, listId)`: (list name, rows).
pub async fn load_welddata_list_rows(db: &PgPool, list_id: &str) -> ReachResult<Result<(String, Vec<ImportRow>), SourceListError>> {
    let list: Option<(String, String)> =
        sqlx::query_as("select name, kind::text from welddata_lists where id = $1 and deleted_at is null limit 1")
            .bind(list_id)
            .fetch_optional(db)
            .await?;
    let Some((name, kind)) = list else {
        return Ok(Err(SourceListError::NotFound));
    };
    if kind != "person" {
        return Ok(Err(SourceListError::WrongKind));
    }
    let leads: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from welddata_leads t where t.list_id = $1 and t.deleted_at is null limit $2",
    )
    .bind(list_id)
    .bind(MAX_SOURCE_LIST_ROWS + 1)
    .fetch_all(db)
    .await?;
    if i64::try_from(leads.len()).unwrap_or_default() > MAX_SOURCE_LIST_ROWS {
        return Ok(Err(SourceListError::TooLarge));
    }
    let mut rows = Vec::new();
    for lead in js_rows(leads) {
        let Some(email) = text(&lead, "email").filter(|e| !e.is_empty()) else {
            continue;
        };
        let (first_name, last_name) = split_name(text(&lead, "name"));
        let mut custom = Map::new();
        for (key, column) in [
            ("country", "country"),
            ("industry", "industry"),
            ("location", "location"),
            ("companySize", "companySize"),
        ] {
            if let Some(value) = text(&lead, column).filter(|v| !v.is_empty()) {
                custom.insert(key.to_owned(), json!(value));
            }
        }
        rows.push(ImportRow {
            person_id: None,
            email: Some(email.to_owned()),
            first_name,
            last_name,
            company_name: text(&lead, "companyName").map(str::to_owned),
            title: text(&lead, "title").map(str::to_owned),
            timezone: None,
            custom_fields: Some(custom),
        });
    }
    Ok(Ok((name, rows)))
}

/// What a prospect operation needs (`ProspectDeps`).
pub struct ProspectDeps<'a> {
    pub db: &'a PgPool,
    pub emit: &'a dyn EventSink,
    pub user_id: &'a str,
    pub allow_consumer: bool,
    /// DNS-over-HTTPS for the MX check.
    pub http: Option<&'a OutboundHttp>,
}

fn emit_prospect(emit: &dyn EventSink, event: weldsuite_catalogs::entity_events::EventName, row: &Value) {
    let id = crate::text_or_empty(row, "id").to_owned();
    emit.emit(ReachEvent::new(event, id, row.clone()));
}

/// `listProspects(db, q)`.
pub async fn list(db: &PgPool, query: &PageQuery) -> ReachResult<Page> {
    let limit = parse_limit(query.limit.as_deref());
    let search = query
        .search
        .as_deref()
        .filter(|s| !js_trim(s).is_empty())
        .map(like_pattern);
    let validation = match query.validation.as_deref().filter(|v| !v.is_empty()) {
        Some(v) if VALIDATIONS.contains(&v) => Some(v.to_owned()),
        Some(_) => return Err(ReachError::bad_request("Unknown validation filter")),
        None => None,
    };
    let list_id = query.list_id.clone().filter(|l| !l.is_empty());
    let cursor = cursor_row(db, "reach_prospects", query.cursor.as_deref()).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_prospects t
         where t.deleted_at is null
           and ($1::text is null or t.email ilike $1 or t.first_name ilike $1 or t.last_name ilike $1 or t.company_name ilike $1)
           and ($2::text is null or t.validation = $2)
           and ($3::text is null or t.id in (select prospect_id from reach_prospect_list_members where list_id = $3))
           and ($4::timestamptz is null or t.created_at < $4::timestamptz or (t.created_at = $4::timestamptz and t.id < $5))
         order by t.created_at desc, t.id desc limit $6",
    )
    .bind(&search)
    .bind(&validation)
    .bind(&list_id)
    .bind(cursor.as_ref().map(|c| c.0.clone()))
    .bind(cursor.as_ref().map(|c| c.1.clone()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from reach_prospects t
         where t.deleted_at is null
           and ($1::text is null or t.email ilike $1 or t.first_name ilike $1 or t.last_name ilike $1 or t.company_name ilike $1)
           and ($2::text is null or t.validation = $2)
           and ($3::text is null or t.id in (select prospect_id from reach_prospect_list_members where list_id = $3))",
    )
    .bind(&search)
    .bind(&validation)
    .bind(&list_id)
    .fetch_one(db)
    .await?;
    Ok(page_result(&js_rows(rows), limit, total, to_prospect))
}

/// `getProspect(db, id)`.
pub async fn get(db: &PgPool, id: &str) -> ReachResult<Value> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from reach_prospects t where t.id = $1 and t.deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(|r| to_prospect(&weldsuite_db::js_row(r)))
        .ok_or_else(|| ReachError::not_found("Prospect", Some(id)))
}

/// `createProspect(deps, input)`.
pub async fn create(deps: &ProspectDeps<'_>, row: ImportRow, list_id: Option<&str>) -> ReachResult<Value> {
    let db = deps.db;
    let email = row.email.clone().unwrap_or_default();
    let existing: Option<Option<String>> =
        sqlx::query_scalar("select deleted_at::text from reach_prospects where email = $1 limit 1")
            .bind(&email)
            .fetch_optional(db)
            .await?;
    if matches!(existing, Some(None)) {
        return Err(ReachError::conflict("A prospect with this email already exists"));
    }
    if let Some(list_id) = list_id
        && find_list(db, list_id).await?.is_none()
    {
        return Err(ReachError::not_found("List", Some(list_id)));
    }
    let outcome = import_prospects(
        db,
        deps.http,
        std::slice::from_ref(&row),
        &ImportOptions {
            source: "manual",
            source_ref: None,
            created_by: Some(deps.user_id),
            allow_consumer: deps.allow_consumer,
        },
    )
    .await?;
    let Some(stored) = outcome.stored.first() else {
        return Err(ReachError::bad_request("The email address is not valid"));
    };
    if let Some(list_id) = list_id {
        add_to_list(db, list_id, std::slice::from_ref(&stored.id)).await?;
    }
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from reach_prospects t where t.id = $1 limit 1")
        .bind(&stored.id)
        .fetch_optional(db)
        .await?;
    let Some(row) = row.map(weldsuite_db::js_row) else {
        return Err(ReachError::internal("Failed to create the prospect"));
    };
    emit_prospect(deps.emit, REACH_PROSPECT_CREATED, &row);
    Ok(to_prospect(&row))
}

/// The body of `PATCH /:id` (`updateReachProspectSchema`): `None` leaves a
/// field as it is.
#[derive(Debug, Clone, Default)]
pub struct ProspectUpdate {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub company_name: Option<String>,
    pub title: Option<String>,
    pub timezone: Option<String>,
    pub custom_fields: Option<Map<String, Value>>,
}

/// `updateProspect(deps, id, input)`.
pub async fn update(db: &PgPool, emit: &dyn EventSink, id: &str, input: ProspectUpdate) -> ReachResult<Value> {
    let row: Option<Value> = sqlx::query_scalar(
        "update reach_prospects set
             first_name = case when $2 then $3 else first_name end,
             last_name = case when $4 then $5 else last_name end,
             company_name = case when $6 then $7 else company_name end,
             title = case when $8 then $9 else title end,
             timezone = case when $10 then $11 else timezone end,
             custom_fields = case when $12 then $13::jsonb else custom_fields end,
             updated_at = $14::timestamptz
         where id = $1 and deleted_at is null returning to_jsonb(reach_prospects)",
    )
    .bind(id)
    .bind(input.first_name.is_some())
    .bind(blank_to_null(input.first_name.as_deref()))
    .bind(input.last_name.is_some())
    .bind(blank_to_null(input.last_name.as_deref()))
    .bind(input.company_name.is_some())
    .bind(blank_to_null(input.company_name.as_deref()))
    .bind(input.title.is_some())
    .bind(blank_to_null(input.title.as_deref()))
    .bind(input.timezone.is_some())
    .bind(blank_to_null(input.timezone.as_deref()))
    .bind(input.custom_fields.is_some())
    .bind(input.custom_fields.map(Value::Object))
    .bind(iso(now()))
    .fetch_optional(db)
    .await?;
    let Some(row) = row.map(weldsuite_db::js_row) else {
        return Err(ReachError::not_found("Prospect", Some(id)));
    };
    emit_prospect(emit, REACH_PROSPECT_UPDATED, &row);
    Ok(to_prospect(&row))
}

/// `deleteProspect(deps, id)`.
pub async fn delete(db: &PgPool, emit: &dyn EventSink, id: &str) -> ReachResult<()> {
    let Some(campaigns) = soft_delete(db, id).await? else {
        return Err(ReachError::not_found("Prospect", Some(id)));
    };
    complete_and_publish(db, emit, &campaigns).await?;
    emit.emit(ReachEvent::new(REACH_PROSPECT_DELETED, id, json!({ "id": id })));
    Ok(())
}

/// `resolveImportList(deps, target, list)`.
async fn resolve_import_list(
    deps: &ProspectDeps<'_>,
    list_id: Option<&str>,
    list_name: Option<&str>,
    source: &str,
    source_ref: Option<&str>,
) -> ReachResult<Option<String>> {
    if let Some(list_id) = list_id.filter(|l| !l.is_empty()) {
        if find_list(deps.db, list_id).await?.is_none() {
            return Err(ReachError::not_found("List", Some(list_id)));
        }
        return Ok(Some(list_id.to_owned()));
    }
    if let Some(name) = list_name.filter(|n| !n.is_empty()) {
        let created = create_list(deps.db, name, None, source, source_ref, Some(deps.user_id)).await?;
        return Ok(text(&created, "id").map(str::to_owned));
    }
    Ok(None)
}

async fn finish_import(deps: &ProspectDeps<'_>, outcome: ImportOutcome, list_id: Option<String>) -> ReachResult<Value> {
    if let Some(list_id) = &list_id {
        let ids: Vec<String> = outcome.stored.iter().map(|s| s.id.clone()).collect();
        add_to_list(deps.db, list_id, &ids).await?;
    }
    let fresh: Vec<String> = outcome
        .stored
        .iter()
        .filter(|s| s.is_new)
        .take(MAX_IMPORT_EVENTS)
        .map(|s| s.id.clone())
        .collect();
    if !fresh.is_empty() {
        let rows: Vec<Value> = sqlx::query_scalar("select to_jsonb(t) from reach_prospects t where t.id = any($1)")
            .bind(&fresh)
            .fetch_all(deps.db)
            .await?;
        for row in js_rows(rows) {
            emit_prospect(deps.emit, REACH_PROSPECT_CREATED, &row);
        }
    }
    let skipped: Vec<Value> = outcome
        .skipped
        .iter()
        .map(|(reason, count)| json!({ "reason": reason, "count": count }))
        .collect();
    Ok(json!({
        "listId": list_id,
        "created": outcome.created,
        "updated": outcome.updated,
        "skipped": skipped,
    }))
}

/// `importProspectRows(deps, input)`.
pub async fn import_rows(
    deps: &ProspectDeps<'_>,
    rows: &[ImportRow],
    list_id: Option<&str>,
    list_name: Option<&str>,
    source_ref: Option<&str>,
) -> ReachResult<Value> {
    let list = resolve_import_list(deps, list_id, list_name, "csv", source_ref).await?;
    let outcome = import_prospects(
        deps.db,
        deps.http,
        rows,
        &ImportOptions {
            source: "csv",
            source_ref,
            created_by: Some(deps.user_id),
            allow_consumer: deps.allow_consumer,
        },
    )
    .await?;
    finish_import(deps, outcome, list).await
}

/// `importProspectsFromCrmList(deps, input)` and
/// `importProspectsFromWeldDataList(deps, input)`.
pub async fn import_source_list(
    deps: &ProspectDeps<'_>,
    source: &str,
    source_list_id: &str,
    list_name: Option<&str>,
) -> ReachResult<Value> {
    let (loaded, label) = if source == "crm_list" {
        (load_crm_list_rows(deps.db, source_list_id).await?, "CRM list")
    } else {
        (load_welddata_list_rows(deps.db, source_list_id).await?, "WeldData list")
    };
    let (name, rows) = match loaded {
        Ok(found) => found,
        Err(SourceListError::NotFound) => return Err(ReachError::not_found(label, Some(source_list_id))),
        Err(error) => return Err(ReachError::bad_request(error.message())),
    };
    let target = list_name.map_or(name, str::to_owned);
    let list = resolve_import_list(deps, None, Some(&target), source, Some(source_list_id)).await?;
    let outcome = import_prospects(
        deps.db,
        deps.http,
        &rows,
        &ImportOptions {
            source,
            source_ref: Some(source_list_id),
            created_by: Some(deps.user_id),
            allow_consumer: deps.allow_consumer,
        },
    )
    .await?;
    finish_import(deps, outcome, list).await
}
