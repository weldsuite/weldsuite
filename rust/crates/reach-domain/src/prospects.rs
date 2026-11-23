//! `prospects.ts`: the outreach contact store, imports (rows, CRM lists,
//! WeldData lists) and the prospect operations.

use std::collections::HashSet;

use sea_orm::sea_query::{Alias, Expr, Func, OnConflict, Query};
use sea_orm::{ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_schema::tenant::{
    companies, list_members, lists, people, person_companies,
    reach_enrollments as enrollments, reach_prospect_list_members as members,
    reach_prospects as prospects, welddata_leads, welddata_lists,
};
use weldsuite_catalogs::entity_events::{
    REACH_PROSPECT_CREATED, REACH_PROSPECT_DELETED, REACH_PROSPECT_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;

use crate::campaigns::complete_and_publish;
use crate::lists::{
    Page, PageQuery, add_to_list, before, create_list, cursor_row, find_list, like_pattern,
    page_result, parse_limit, probe, recount_list,
};
use crate::schemas::email_domain;
use crate::suppressions::load_index;
use crate::text::js_trim;
use crate::validation::validate_emails;
use crate::{
    EventSink, ReachError, ReachEvent, ReachResult, field, js, js_all, js_slice, now, text,
};

const CHUNK: usize = 500;
const VALIDATIONS: &[&str] = &[
    "valid",
    "role",
    "consumer",
    "no_mx",
    "invalid",
    "suppressed",
];

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
    value
        .map(js_trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
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
    let conn = orm(db);
    let mut existing: HashSet<String> = HashSet::new();
    for chunk in emails.chunks(CHUNK) {
        let found: Vec<String> = prospects::Entity::find()
            .select_only()
            .column(prospects::Column::Email)
            .filter(prospects::Column::Email.is_in(chunk))
            .into_tuple()
            .all(&conn)
            .await?;
        existing.extend(found);
    }
    let suppressed = load_index(db, &emails).await?;
    let verdicts = validate_emails(&emails, options.allow_consumer, &suppressed, http).await;
    let at = now();
    let mut stored: Vec<StoredProspect> = Vec::new();
    for (chunk_index, chunk) in emails.chunks(CHUNK).enumerate() {
        let rows = chunk.iter().enumerate().map(|(i, email)| {
            let row = by_email[chunk_index * CHUNK + i];
            let domain = email_domain(email);
            prospects::ActiveModel {
                id: Set(generate_id("rpro")),
                email: Set(email.clone()),
                first_name: Set(clip(blank_to_null(row.first_name.as_deref()), 100)),
                last_name: Set(clip(blank_to_null(row.last_name.as_deref()), 100)),
                company_name: Set(clip(blank_to_null(row.company_name.as_deref()), 200)),
                company_domain: Set((!domain.is_empty()).then_some(domain)),
                person_id: Set(blank_to_null(row.person_id.as_deref())),
                title: Set(clip(blank_to_null(row.title.as_deref()), 200)),
                timezone: Set(clip(blank_to_null(row.timezone.as_deref()), 64)),
                custom_fields: Set(row
                    .custom_fields
                    .clone()
                    .map_or_else(|| json!({}), Value::Object)),
                source: Set(options.source.to_owned()),
                source_ref: Set(options.source_ref.map(str::to_owned)),
                validation: Set(verdicts.get(email).copied().unwrap_or("valid").to_owned()),
                created_by: Set(options.created_by.map(str::to_owned)),
                ..Default::default()
            }
        });
        let inserted = prospects::Entity::insert_many(rows)
            .on_conflict(merge_on_email(at))
            .exec_with_returning(&conn)
            .await?
            .into_iter()
            .map(|row| (row.id, row.email, row.validation));
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

/// `onConflictDoUpdate({ target: email, set })` of an import: blanks keep
/// what the prospect had, the person link is kept, custom fields merge, and
/// a deleted prospect comes back.
fn merge_on_email(at: OffsetDateTime) -> OnConflict {
    use prospects::Column;
    let excluded = |column: Column| Expr::col((Alias::new("excluded"), column));
    let current = |column: Column| Expr::col((prospects::Entity, column));
    let keep_blank = |column: Column| Func::coalesce([excluded(column), current(column)]);
    OnConflict::column(Column::Email)
        .value(Column::FirstName, keep_blank(Column::FirstName))
        .value(Column::LastName, keep_blank(Column::LastName))
        .value(Column::CompanyName, keep_blank(Column::CompanyName))
        .value(Column::Title, keep_blank(Column::Title))
        .value(Column::Timezone, keep_blank(Column::Timezone))
        .value(
            Column::PersonId,
            Func::coalesce([current(Column::PersonId), excluded(Column::PersonId)]),
        )
        .value(
            Column::CustomFields,
            sea_orm::sea_query::extension::postgres::PgExpr::concat(
                current(Column::CustomFields),
                excluded(Column::CustomFields),
            ),
        )
        .value(Column::Validation, excluded(Column::Validation))
        .value(Column::DeletedAt, Expr::value(None::<OffsetDateTime>))
        .value(Column::UpdatedAt, Expr::value(at))
        .to_owned()
}

/// `softDeleteProspect(db, id)`: the campaigns that lost an enrollment, or
/// `None` when there was no live prospect.
pub async fn soft_delete(db: &PgPool, id: &str) -> ReachResult<Option<Vec<String>>> {
    let at = now();
    let conn = orm(db);
    let deleted = prospects::Entity::update_many()
        .col_expr(prospects::Column::DeletedAt, Expr::value(at))
        .col_expr(prospects::Column::UpdatedAt, Expr::value(at))
        .filter(prospects::Column::Id.eq(id))
        .filter(prospects::Column::DeletedAt.is_null())
        .exec(&conn)
        .await?;
    if deleted.rows_affected == 0 {
        return Ok(None);
    }
    let lists: Vec<String> = members::Entity::delete_many()
        .filter(members::Column::ProspectId.eq(id))
        .exec_with_returning(&conn)
        .await?
        .into_iter()
        .map(|member| member.list_id)
        .collect();
    for list_id in crate::unique(&lists) {
        recount_list(db, &list_id).await?;
    }
    let never: Option<OffsetDateTime> = None;
    let stopped: Vec<String> = enrollments::Entity::update_many()
        .col_expr(enrollments::Column::Status, Expr::value("failed"))
        .col_expr(
            enrollments::Column::StoppedReason,
            Expr::value("prospect_deleted"),
        )
        .col_expr(enrollments::Column::ClaimedAt, Expr::value(never))
        .col_expr(enrollments::Column::NextSendAt, Expr::value(never))
        .col_expr(enrollments::Column::UpdatedAt, Expr::value(at))
        .filter(enrollments::Column::ProspectId.eq(id))
        .filter(enrollments::Column::Status.is_in(["queued", "active"]))
        .exec_with_returning(&conn)
        .await?
        .into_iter()
        .map(|enrollment| enrollment.campaign_id)
        .collect();
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

async fn current_company_names(
    db: &PgPool,
    person_ids: &[String],
) -> ReachResult<Vec<(String, String)>> {
    let conn = orm(db);
    let links: Vec<(String, String, Option<bool>)> = person_companies::Entity::find()
        .select_only()
        .column(person_companies::Column::PersonId)
        .column(person_companies::Column::CompanyId)
        .column(person_companies::Column::IsPrimary)
        .filter(person_companies::Column::PersonId.is_in(person_ids))
        .filter(person_companies::Column::EndedAt.is_null())
        .into_tuple()
        .all(&conn)
        .await?;
    let company_ids = crate::unique(&links.iter().map(|l| l.1.clone()).collect::<Vec<_>>());
    let names: Vec<(String, String)> = if company_ids.is_empty() {
        Vec::new()
    } else {
        companies::Entity::find()
            .select_only()
            .column(companies::Column::Id)
            .column(companies::Column::DisplayName)
            .filter(companies::Column::Id.is_in(company_ids))
            .filter(companies::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&conn)
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
pub async fn load_crm_list_rows(
    db: &PgPool,
    crm_list_id: &str,
) -> ReachResult<Result<(String, Vec<ImportRow>), SourceListError>> {
    let conn = orm(db);
    let list: Option<(String, String, String)> = lists::Entity::find_by_id(crm_list_id)
        .select_only()
        .column(lists::Column::Name)
        .column(lists::Column::Kind)
        .column(lists::Column::Type)
        .filter(lists::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&conn)
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
    let members: Vec<String> = list_members::Entity::find()
        .select_only()
        .column(list_members::Column::EntityId)
        .filter(list_members::Column::ListId.eq(crm_list_id))
        .limit(probe(MAX_SOURCE_LIST_ROWS))
        .into_tuple()
        .all(&conn)
        .await?;
    if i64::try_from(members.len()).unwrap_or_default() > MAX_SOURCE_LIST_ROWS {
        return Ok(Err(SourceListError::TooLarge));
    }
    let mut rows = Vec::new();
    for chunk in members.chunks(CHUNK) {
        let persons: Vec<(
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = people::Entity::find()
            .select_only()
            .column(people::Column::Id)
            .column(people::Column::Email)
            .column(people::Column::FirstName)
            .column(people::Column::LastName)
            .column(people::Column::DisplayName)
            .column(people::Column::Title)
            .filter(people::Column::Id.is_in(chunk))
            .filter(people::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&conn)
            .await?;
        let company_of = current_company_names(db, chunk).await?;
        for (id, email, first, last, display, title) in persons {
            let Some(email) = email.filter(|e| !e.is_empty()) else {
                continue;
            };
            let (fallback_first, fallback_last) = split_name(display.as_deref());
            rows.push(ImportRow {
                company_name: company_of
                    .iter()
                    .find(|(p, _)| *p == id)
                    .map(|(_, n)| n.clone()),
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
pub async fn load_welddata_list_rows(
    db: &PgPool,
    list_id: &str,
) -> ReachResult<Result<(String, Vec<ImportRow>), SourceListError>> {
    let conn = orm(db);
    let list: Option<(String, String)> = welddata_lists::Entity::find_by_id(list_id)
        .select_only()
        .column(welddata_lists::Column::Name)
        .column(welddata_lists::Column::Kind)
        .filter(welddata_lists::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&conn)
        .await?;
    let Some((name, kind)) = list else {
        return Ok(Err(SourceListError::NotFound));
    };
    if kind != "person" {
        return Ok(Err(SourceListError::WrongKind));
    }
    let leads = welddata_leads::Entity::find()
        .filter(welddata_leads::Column::ListId.eq(list_id))
        .filter(welddata_leads::Column::DeletedAt.is_null())
        .limit(probe(MAX_SOURCE_LIST_ROWS))
        .all(&conn)
        .await?;
    if i64::try_from(leads.len()).unwrap_or_default() > MAX_SOURCE_LIST_ROWS {
        return Ok(Err(SourceListError::TooLarge));
    }
    let mut rows = Vec::new();
    for lead in js_all(leads.into_iter().map(serde_json::to_value))? {
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

fn emit_prospect(
    emit: &dyn EventSink,
    event: weldsuite_catalogs::entity_events::EventName,
    row: &Value,
) {
    let id = crate::text_or_empty(row, "id").to_owned();
    emit.emit(ReachEvent::new(event, id, row.clone()));
}

/// `listProspects(db, q)`.
pub async fn list(db: &PgPool, query: &PageQuery) -> ReachResult<Page> {
    use prospects::Column;
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
    let cursor = cursor_row::<prospects::Entity>(
        db,
        Column::CreatedAt,
        Column::Id,
        query.cursor.as_deref(),
    )
    .await?;
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(search) = &search {
        filters = filters.add(
            Condition::any()
                .add(Column::Email.ilike(search.as_str()))
                .add(Column::FirstName.ilike(search.as_str()))
                .add(Column::LastName.ilike(search.as_str()))
                .add(Column::CompanyName.ilike(search.as_str())),
        );
    }
    if let Some(validation) = &validation {
        filters = filters.add(Column::Validation.eq(validation.as_str()));
    }
    if let Some(list_id) = &list_id {
        filters = filters.add(
            Column::Id.in_subquery(
                Query::select()
                    .column(members::Column::ProspectId)
                    .from(members::Entity)
                    .and_where(members::Column::ListId.eq(list_id.as_str()))
                    .to_owned(),
            ),
        );
    }
    let page = match &cursor {
        Some(cursor) => filters
            .clone()
            .add(before(Column::CreatedAt, Column::Id, cursor)),
        None => filters.clone(),
    };
    let conn = orm(db);
    let rows = prospects::Entity::find()
        .filter(page)
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(probe(limit))
        .all(&conn)
        .await?;
    let total = prospects::Entity::find().filter(filters).count(&conn).await?;
    let rows = js_all(rows.into_iter().map(serde_json::to_value))?;
    Ok(page_result(
        &rows,
        limit,
        i64::try_from(total).unwrap_or(i64::MAX),
        to_prospect,
    ))
}

/// `getProspect(db, id)`.
pub async fn get(db: &PgPool, id: &str) -> ReachResult<Value> {
    let row = prospects::Entity::find_by_id(id)
        .filter(prospects::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .ok_or_else(|| ReachError::not_found("Prospect", Some(id)))?;
    Ok(to_prospect(&js(serde_json::to_value(row))?))
}

/// `createProspect(deps, input)`.
pub async fn create(
    deps: &ProspectDeps<'_>,
    row: ImportRow,
    list_id: Option<&str>,
) -> ReachResult<Value> {
    let db = deps.db;
    let email = row.email.clone().unwrap_or_default();
    let existing: Option<Option<OffsetDateTime>> = prospects::Entity::find()
        .select_only()
        .column(prospects::Column::DeletedAt)
        .filter(prospects::Column::Email.eq(email.as_str()))
        .into_tuple()
        .one(&orm(db))
        .await?;
    if matches!(existing, Some(None)) {
        return Err(ReachError::conflict(
            "A prospect with this email already exists",
        ));
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
    let row = prospects::Entity::find_by_id(stored.id.as_str())
        .one(&orm(db))
        .await?
        .map(serde_json::to_value)
        .map(js)
        .transpose()?;
    let Some(row) = row else {
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
pub async fn update(
    db: &PgPool,
    emit: &dyn EventSink,
    id: &str,
    input: ProspectUpdate,
) -> ReachResult<Value> {
    use prospects::Column;
    let mut update = prospects::Entity::update_many();
    for (column, value) in [
        (Column::FirstName, &input.first_name),
        (Column::LastName, &input.last_name),
        (Column::CompanyName, &input.company_name),
        (Column::Title, &input.title),
        (Column::Timezone, &input.timezone),
    ] {
        if let Some(value) = value {
            update = update.col_expr(column, Expr::value(blank_to_null(Some(value))));
        }
    }
    if let Some(custom_fields) = input.custom_fields {
        update = update.col_expr(
            Column::CustomFields,
            Expr::value(Value::Object(custom_fields)),
        );
    }
    let row = update
        .col_expr(Column::UpdatedAt, Expr::value(now()))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .map(serde_json::to_value)
        .map(js)
        .transpose()?;
    let Some(row) = row else {
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
    emit.emit(ReachEvent::new(
        REACH_PROSPECT_DELETED,
        id,
        json!({ "id": id }),
    ));
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
        let created =
            create_list(deps.db, name, None, source, source_ref, Some(deps.user_id)).await?;
        return Ok(text(&created, "id").map(str::to_owned));
    }
    Ok(None)
}

async fn finish_import(
    deps: &ProspectDeps<'_>,
    outcome: ImportOutcome,
    list_id: Option<String>,
) -> ReachResult<Value> {
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
        let rows = prospects::Entity::find()
            .filter(prospects::Column::Id.is_in(fresh))
            .all(&orm(deps.db))
            .await?;
        for row in js_all(rows.into_iter().map(serde_json::to_value))? {
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
        (
            load_crm_list_rows(deps.db, source_list_id).await?,
            "CRM list",
        )
    } else {
        (
            load_welddata_list_rows(deps.db, source_list_id).await?,
            "WeldData list",
        )
    };
    let (name, rows) = match loaded {
        Ok(found) => found,
        Err(SourceListError::NotFound) => {
            return Err(ReachError::not_found(label, Some(source_list_id)));
        }
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
