//! The WeldData service (`apps/workers/data-api/src/services/welddata.ts`):
//! lists of saved leads, converting leads into CRM people and companies,
//! enrichment columns and cells. No HTTP here.

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_crm_domain::DomainError;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::id::generate_id;
use weldsuite_schema::tenant::welddata_cells::{self, Column as Cell};
use weldsuite_schema::tenant::welddata_columns::{self, Column as Col};
use weldsuite_schema::tenant::welddata_leads::{self, Column as Lead};
use weldsuite_schema::tenant::welddata_lists::{self, Column as List};
use weldsuite_schema::tenant::{companies, list_members, lists};

use crate::js::{is_js_space, js_lowercase, js_trim, text, truthy};

/// What a service call fails with.
#[derive(Debug)]
pub(crate) enum ServiceError {
    Db(DbErr),
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

impl From<DbErr> for ServiceError {
    fn from(error: DbErr) -> Self {
        Self::Db(error)
    }
}

impl From<DomainError> for ServiceError {
    fn from(error: DomainError) -> Self {
        Self::Crm(error)
    }
}

pub(crate) type ServiceResult<T> = Result<T, ServiceError>;

// ── Rows through the entities ───────────────────────────────────────────────

/// A row as the routes return it: Drizzle's JSON shape, decided by the
/// entity.
pub(crate) fn js<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// [`js`] of every row.
pub(crate) fn js_rows<M: serde::Serialize>(models: Vec<M>) -> Result<Vec<Value>, DbErr> {
    models.into_iter().map(js).collect()
}

/// `$n::int` of a JavaScript integer: Postgres refuses one out of range.
pub(crate) fn int4(value: i64) -> Result<i32, DbErr> {
    i32::try_from(value).map_err(|_| DbErr::Custom("integer out of range".to_owned()))
}

/// A keyset page's cursor: the cursor row's `createdAt` as a `Date` holds
/// it (milliseconds), and its id.
pub(crate) type CursorRow = (PrimitiveDateTime, String);

/// The keyset of the cursor row `id` of a table, when the row is there.
pub(crate) async fn cursor_row<E: EntityTrait>(
    db: &DatabaseConnection,
    created_at: E::Column,
    id_column: E::Column,
    id: &str,
) -> Result<Option<CursorRow>, DbErr> {
    let created: Option<PrimitiveDateTime> = E::find()
        .select_only()
        .column(created_at)
        .filter(id_column.eq(id))
        .into_tuple()
        .one(db)
        .await?;
    Ok(created.map(|at| (weldsuite_db::utc_timestamp(at.assume_utc()), id.to_owned())))
}

/// `created_at < cursor or (created_at = cursor and id < cursorId)`: past
/// the cursor, newest first.
pub(crate) fn before<C: ColumnTrait>(created_at: C, id: C, (at, cursor): &CursorRow) -> Condition {
    Condition::any().add(created_at.lt(*at)).add(
        Condition::all()
            .add(created_at.eq(*at))
            .add(id.lt(cursor.as_str())),
    )
}

/// A `count(*)` as the page's `totalCount`.
fn count_of(total: u64) -> i64 {
    i64::try_from(total).unwrap_or(i64::MAX)
}

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
    let db = orm(db);
    let pattern = search.filter(|s| !s.is_empty()).map(|s| format!("%{s}%"));
    let keyset = match cursor.filter(|c| !c.is_empty()) {
        Some(id) => cursor_row::<welddata_lists::Entity>(&db, List::CreatedAt, List::Id, id).await?,
        None => None,
    };
    let live = || {
        let mut live = Condition::all().add(List::DeletedAt.is_null());
        if let Some(pattern) = &pattern {
            live = live.add(List::Name.ilike(pattern.as_str()));
        }
        live
    };
    let mut found = welddata_lists::Entity::find().filter(live());
    if let Some(keyset) = &keyset {
        found = found.filter(before(List::CreatedAt, List::Id, keyset));
    }
    let found = found
        .order_by_desc(List::CreatedAt)
        .order_by_desc(List::Id)
        .limit(u64::try_from(take).unwrap_or_default())
        .all(&db)
        .await?;
    let total = welddata_lists::Entity::find()
        .filter(live())
        .count(&db)
        .await?;
    let mut page = paged(js_rows(found)?, take - 1, count_of(total));
    let ids: Vec<String> = page
        .rows
        .iter()
        .filter_map(|row| text(row, "id").map(str::to_owned))
        .collect();
    let counts: Vec<(String, i64)> = if ids.is_empty() {
        Vec::new()
    } else {
        welddata_leads::Entity::find()
            .select_only()
            .column(Lead::ListId)
            .column_as(Lead::Id.count(), "count")
            .filter(Lead::ListId.is_in(ids))
            .filter(Lead::DeletedAt.is_null())
            .group_by(Lead::ListId)
            .into_tuple()
            .all(&db)
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
    let db = orm(db);
    let row = welddata_lists::Entity::find_by_id(id)
        .filter(List::DeletedAt.is_null())
        .one(&db)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let count = welddata_leads::Entity::find()
        .filter(Lead::ListId.eq(id))
        .filter(Lead::DeletedAt.is_null())
        .count(&db)
        .await?;
    let mut row = js(row)?;
    row["leadCount"] = json!(count);
    Ok(Some(row))
}

async fn list_row(db: &DatabaseConnection, id: &str) -> ServiceResult<Option<Value>> {
    let row = welddata_lists::Entity::find_by_id(id).one(db).await?;
    Ok(row.map(js).transpose()?)
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
    let db = orm(db);
    let id = generate_id("wdlist");
    let at = utc_now();
    welddata_lists::Entity::insert(welddata_lists::ActiveModel {
        id: Set(id.clone()),
        created_at: Set(at),
        updated_at: Set(at),
        kind: Set(input.kind),
        name: Set(input.name),
        description: Set(input.description),
        color: Set(input.color.unwrap_or_else(|| "bg-blue-500".to_owned())),
        icon: Set(input.icon.unwrap_or_else(|| "Database".to_owned())),
        created_by: Set(Some(created_by.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    list_row(&db, &id)
        .await?
        .ok_or_else(|| ServiceError::Other("List disappeared after insert".to_owned()))
}

async fn live_list_kind(db: &DatabaseConnection, id: &str) -> ServiceResult<Option<String>> {
    Ok(welddata_lists::Entity::find()
        .select_only()
        .column(List::Kind)
        .filter(List::Id.eq(id))
        .filter(List::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?)
}

/// `updateList(db, id, input)`: the fields given (`name`, `description`,
/// `color`, `icon`), or `None` when the list isn't there.
pub(crate) async fn update_list(
    db: &PgPool,
    id: &str,
    fields: &[(&'static str, String)],
) -> ServiceResult<Option<Value>> {
    let db = orm(db);
    if live_list_kind(&db, id).await?.is_none() {
        return Ok(None);
    }
    let mut update =
        welddata_lists::Entity::update_many().col_expr(List::UpdatedAt, Expr::value(utc_now()));
    for (column, value) in fields {
        let column = match *column {
            "name" => List::Name,
            "description" => List::Description,
            "color" => List::Color,
            "icon" => List::Icon,
            other => {
                return Err(ServiceError::Other(format!(
                    "column \"{other}\" of relation \"welddata_lists\" does not exist"
                )));
            }
        };
        update = update.col_expr(column, Expr::value(value.as_str()));
    }
    update.filter(List::Id.eq(id)).exec(&db).await?;
    list_row(&db, id).await
}

/// `deleteList(db, id)`: the list and its leads, soft.
pub(crate) async fn delete_list(db: &PgPool, id: &str) -> ServiceResult<bool> {
    let db = orm(db);
    if live_list_kind(&db, id).await?.is_none() {
        return Ok(false);
    }
    let at = utc_now();
    welddata_lists::Entity::update_many()
        .col_expr(List::DeletedAt, Expr::value(at))
        .col_expr(List::UpdatedAt, Expr::value(at))
        .filter(List::Id.eq(id))
        .exec(&db)
        .await?;
    welddata_leads::Entity::update_many()
        .col_expr(Lead::DeletedAt, Expr::value(at))
        .col_expr(Lead::UpdatedAt, Expr::value(at))
        .filter(Lead::ListId.eq(id))
        .filter(Lead::DeletedAt.is_null())
        .exec(&db)
        .await?;
    Ok(true)
}

// ── Saved leads ─────────────────────────────────────────────────────────────

/// A saved lead's row from its input (the fields given, the rest `null`).
fn lead_model(
    lead: &Map<String, Value>,
    list_id: &str,
    kind: &str,
    added_by: &str,
    at: PrimitiveDateTime,
) -> welddata_leads::ActiveModel {
    let text = |key: &str| lead.get(key).and_then(Value::as_str).map(str::to_owned);
    welddata_leads::ActiveModel {
        id: Set(generate_id("wdlead")),
        created_at: Set(at),
        updated_at: Set(at),
        list_id: Set(list_id.to_owned()),
        added_by: Set(Some(added_by.to_owned())),
        kind: Set(kind.to_owned()),
        lemlist_id: Set(text("lemlistId")),
        data: Set(lead.get("data").filter(|data| !data.is_null()).cloned()),
        name: Set(text("name")),
        email: Set(text("email")),
        title: Set(text("title")),
        company_name: Set(text("companyName")),
        domain: Set(text("domain")),
        industry: Set(text("industry")),
        location: Set(text("location")),
        country: Set(text("country")),
        company_size: Set(text("companySize")),
        linkedin_url: Set(text("linkedinUrl")),
        converted_status: Set("pending".to_owned()),
        ..Default::default()
    }
}

/// `addLeads(db, listId, input, addedBy)`: `(added, skipped)`, or `None`
/// when the list isn't there. Leads of the other kind are skipped, and so
/// are those already saved (same list, kind and Lemlist id).
pub(crate) async fn add_leads(
    db: &PgPool,
    list_id: &str,
    leads: &[Map<String, Value>],
    added_by: &str,
) -> ServiceResult<Option<(usize, usize)>> {
    let db = orm(db);
    let Some(kind) = live_list_kind(&db, list_id).await? else {
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
    let at = utc_now();
    let records = matching
        .iter()
        .map(|lead| lead_model(lead, list_id, &kind, added_by, at));
    let inserted: Vec<String> = welddata_leads::Entity::insert_many(records)
        .on_conflict(
            OnConflict::columns([Lead::ListId, Lead::Kind, Lead::LemlistId])
                .do_nothing()
                .to_owned(),
        )
        .exec_with_returning_keys(&db)
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

/// The live leads of the list that match the listing's filters.
fn lead_filters(list_id: &str, query: &LeadQuery, pattern: Option<&str>) -> Condition {
    let mut filters = Condition::all()
        .add(Lead::ListId.eq(list_id))
        .add(Lead::DeletedAt.is_null());
    if let Some(kind) = query.kind.as_deref().filter(|s| !s.is_empty()) {
        filters = filters.add(Lead::Kind.eq(kind));
    }
    if let Some(status) = query.converted_status.as_deref().filter(|s| !s.is_empty()) {
        filters = filters.add(Lead::ConvertedStatus.eq(status));
    }
    if let Some(pattern) = pattern {
        filters = filters.add(
            Condition::any()
                .add(Lead::Name.ilike(pattern))
                .add(Lead::Email.ilike(pattern))
                .add(Lead::CompanyName.ilike(pattern)),
        );
    }
    filters
}

/// `listLeads(db, listId, params)`: the page, or `None` when the list
/// isn't there.
pub(crate) async fn list_leads(
    db: &PgPool,
    list_id: &str,
    query: &LeadQuery,
) -> ServiceResult<Option<Page>> {
    let db = orm(db);
    if live_list_kind(&db, list_id).await?.is_none() {
        return Ok(None);
    }
    let take = page_limit(query.limit.min(100.0))?;
    let pattern = query
        .search
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let keyset = match query.cursor.as_deref().filter(|c| !c.is_empty()) {
        Some(id) => cursor_row::<welddata_leads::Entity>(&db, Lead::CreatedAt, Lead::Id, id).await?,
        None => None,
    };
    let mut found =
        welddata_leads::Entity::find().filter(lead_filters(list_id, query, pattern.as_deref()));
    if let Some(keyset) = &keyset {
        found = found.filter(before(Lead::CreatedAt, Lead::Id, keyset));
    }
    let found = found
        .order_by_desc(Lead::CreatedAt)
        .order_by_desc(Lead::Id)
        .limit(u64::try_from(take).unwrap_or_default())
        .all(&db)
        .await?;
    let total = welddata_leads::Entity::find()
        .filter(lead_filters(list_id, query, pattern.as_deref()))
        .count(&db)
        .await?;
    Ok(Some(paged(js_rows(found)?, take - 1, count_of(total))))
}

/// `getLead(db, id)`: a live saved lead.
pub(crate) async fn get_lead(db: &PgPool, id: &str) -> ServiceResult<Option<Value>> {
    let row = welddata_leads::Entity::find_by_id(id)
        .filter(Lead::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(js).transpose()?)
}

/// `removeLead(db, id)`: soft.
pub(crate) async fn remove_lead(db: &PgPool, id: &str) -> ServiceResult<bool> {
    if get_lead(db, id).await?.is_none() {
        return Ok(false);
    }
    let at = utc_now();
    welddata_leads::Entity::update_many()
        .col_expr(Lead::DeletedAt, Expr::value(at))
        .col_expr(Lead::UpdatedAt, Expr::value(at))
        .filter(Lead::Id.eq(id))
        .exec(&orm(db))
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
    let saved: Vec<String> = welddata_leads::Entity::find()
        .select_only()
        .column(Lead::LemlistId)
        .filter(Lead::ListId.is_in(ids))
        .filter(Lead::LemlistId.is_not_null())
        .filter(Lead::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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
    let same_name = sea_orm::ExprTrait::eq(
        Func::lower(Expr::col((companies::Entity, companies::Column::Name))),
        js_lowercase(name),
    );
    let existing: Option<String> = companies::Entity::find()
        .select_only()
        .column(companies::Column::Id)
        .filter(same_name)
        .filter(companies::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
    let at = utc_now();
    welddata_leads::Entity::update_many()
        .col_expr(Lead::ConvertedStatus, Expr::value("converted"))
        .col_expr(Lead::ConvertedAt, Expr::value(at))
        .col_expr(Lead::ConvertedPersonId, Expr::value(made.person_id.clone()))
        .col_expr(Lead::ConvertedCompanyId, Expr::value(made.company_id.clone()))
        .col_expr(Lead::UpdatedAt, Expr::value(at))
        .filter(Lead::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(Converted {
        made,
        already: false,
    })
}

/// `getCrmList(db, id)`: a live CRM list's kind.
pub(crate) async fn crm_list_kind(db: &PgPool, id: &str) -> ServiceResult<Option<String>> {
    Ok(lists::Entity::find()
        .select_only()
        .column(lists::Column::Kind)
        .filter(lists::Column::Id.eq(id))
        .filter(lists::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?)
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
    let db = orm(db);
    let existing: Vec<String> = list_members::Entity::find()
        .select_only()
        .column(list_members::Column::EntityId)
        .filter(list_members::Column::ListId.eq(list_id))
        .filter(list_members::Column::EntityId.is_in(deduped.iter().map(String::as_str)))
        .into_tuple()
        .all(&db)
        .await?;
    let to_add: Vec<String> = deduped
        .into_iter()
        .filter(|id| !existing.contains(id))
        .collect();
    if to_add.is_empty() {
        return Ok(0);
    }
    let at = utc_now();
    let members = to_add.iter().map(|entity_id| list_members::ActiveModel {
        id: Set(generate_id("lm")),
        list_id: Set(list_id.to_owned()),
        entity_id: Set(entity_id.clone()),
        added_at: Set(at),
        ..Default::default()
    });
    list_members::Entity::insert_many(members)
        .exec_without_returning(&db)
        .await?;
    Ok(to_add.len())
}

// ── Enrichment columns and cells ────────────────────────────────────────────

/// `listColumns(db, listId)`.
pub(crate) async fn list_columns(db: &PgPool, list_id: &str) -> ServiceResult<Vec<Value>> {
    let found = welddata_columns::Entity::find()
        .filter(Col::ListId.eq(list_id))
        .filter(Col::DeletedAt.is_null())
        .order_by_asc(Col::SortOrder)
        .order_by_asc(Col::CreatedAt)
        .all(&orm(db))
        .await?;
    Ok(js_rows(found)?)
}

async fn column_row(db: &DatabaseConnection, id: &str) -> ServiceResult<Option<Value>> {
    let row = welddata_columns::Entity::find_by_id(id)
        .filter(Col::DeletedAt.is_null())
        .one(db)
        .await?;
    Ok(row.map(js).transpose()?)
}

/// `getColumn(db, id)`: a live column.
pub(crate) async fn get_column(db: &PgPool, id: &str) -> ServiceResult<Option<Value>> {
    column_row(&orm(db), id).await
}

/// The column type a config names (`config.type`, which the schema
/// requires); the column is NOT NULL.
fn config_type(config: &Value) -> ServiceResult<String> {
    config
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            ServiceError::Other(
                "null value in column \"type\" of relation \"welddata_columns\" violates not-null constraint"
                    .to_owned(),
            )
        })
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
    let db = orm(db);
    if live_list_kind(&db, list_id).await?.is_none() {
        return Ok(None);
    }
    let max: Option<Option<i32>> = welddata_columns::Entity::find()
        .select_only()
        .column_as(Col::SortOrder.max(), "max")
        .filter(Col::ListId.eq(list_id))
        .filter(Col::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await?;
    let max = max.flatten().unwrap_or(-1);
    let id = generate_id("wdcol");
    let at = utc_now();
    welddata_columns::Entity::insert(welddata_columns::ActiveModel {
        id: Set(id.clone()),
        created_at: Set(at),
        updated_at: Set(at),
        list_id: Set(list_id.to_owned()),
        name: Set(name.to_owned()),
        type_: Set(config_type(config)?),
        config: Set(Some(config.clone())),
        sort_order: Set(max + 1),
        created_by: Set(Some(created_by.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    column_row(&db, &id).await
}

/// `updateColumn(db, id, input)`: `None` when the column isn't there.
pub(crate) async fn update_column(
    db: &PgPool,
    id: &str,
    name: Option<&str>,
    sort_order: Option<i64>,
    config: Option<&Value>,
) -> ServiceResult<Option<Value>> {
    let db = orm(db);
    if column_row(&db, id).await?.is_none() {
        return Ok(None);
    }
    let mut update =
        welddata_columns::Entity::update_many().col_expr(Col::UpdatedAt, Expr::value(utc_now()));
    if let Some(name) = name {
        update = update.col_expr(Col::Name, Expr::value(name));
    }
    if let Some(order) = sort_order {
        update = update.col_expr(Col::SortOrder, Expr::value(int4(order)?));
    }
    if let Some(config) = config {
        update = update
            .col_expr(Col::Config, Expr::value(config.clone()))
            .col_expr(Col::Type, Expr::value(config_type(config)?));
    }
    update.filter(Col::Id.eq(id)).exec(&db).await?;
    column_row(&db, id).await
}

/// `deleteColumn(db, id)`: the column soft, its cells for good.
pub(crate) async fn delete_column(db: &PgPool, id: &str) -> ServiceResult<bool> {
    let db = orm(db);
    if column_row(&db, id).await?.is_none() {
        return Ok(false);
    }
    let at = utc_now();
    welddata_columns::Entity::update_many()
        .col_expr(Col::DeletedAt, Expr::value(at))
        .col_expr(Col::UpdatedAt, Expr::value(at))
        .filter(Col::Id.eq(id))
        .exec(&db)
        .await?;
    welddata_cells::Entity::delete_many()
        .filter(Cell::ColumnId.eq(id))
        .exec(&db)
        .await?;
    Ok(true)
}

/// `STUCK_RUNNING_MS`: a cell still running ten minutes after its last
/// update is an orphan of a run that died.
const STUCK_RUNNING_MS: i64 = 10 * 60 * 1000;

async fn live_column_ids(db: &DatabaseConnection, list_id: &str) -> ServiceResult<Vec<String>> {
    Ok(welddata_columns::Entity::find()
        .select_only()
        .column(Col::Id)
        .filter(Col::ListId.eq(list_id))
        .filter(Col::DeletedAt.is_null())
        .into_tuple()
        .all(db)
        .await?)
}

/// `reclaimStuckRunningCells(db, { listId })`: orphaned running cells of
/// the list become errors, re-runnable.
async fn reclaim_stuck_running_cells(db: &DatabaseConnection, list_id: &str) -> ServiceResult<()> {
    let columns = live_column_ids(db, list_id).await?;
    if columns.is_empty() {
        return Ok(());
    }
    let cutoff = weldsuite_db::utc_timestamp(
        time::OffsetDateTime::now_utc() - time::Duration::milliseconds(STUCK_RUNNING_MS),
    );
    welddata_cells::Entity::update_many()
        .col_expr(Cell::Status, Expr::value("error"))
        .col_expr(Cell::Error, Expr::value("Timed out — please re-run."))
        .col_expr(Cell::UpdatedAt, Expr::value(utc_now()))
        .filter(Cell::Status.eq("running"))
        .filter(Cell::UpdatedAt.lt(cutoff))
        .filter(Cell::ColumnId.is_in(columns))
        .exec(db)
        .await?;
    Ok(())
}

/// `listCells(db, listId)`: every cell of the list's live columns, after
/// timing out the stuck ones (best effort).
pub(crate) async fn list_cells(db: &PgPool, list_id: &str) -> ServiceResult<Vec<Value>> {
    let db = orm(db);
    if let Err(error) = reclaim_stuck_running_cells(&db, list_id).await {
        tracing::warn!(%error, "welddata: reclaiming stuck cells failed");
    }
    let columns = live_column_ids(&db, list_id).await?;
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let found = welddata_cells::Entity::find()
        .filter(Cell::ColumnId.is_in(columns))
        .all(&db)
        .await?;
    Ok(js_rows(found)?)
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
    let db = orm(db);
    let mut ids = match lead_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => {
            welddata_leads::Entity::find()
                .select_only()
                .column(Lead::Id)
                .filter(Lead::ListId.eq(list_id))
                .filter(Lead::DeletedAt.is_null())
                .into_tuple()
                .all(&db)
                .await?
        }
    };
    if only_missing && !ids.is_empty() {
        let done: Vec<String> = welddata_cells::Entity::find()
            .select_only()
            .column(Cell::LeadId)
            .filter(Cell::ColumnId.eq(column_id))
            .filter(Cell::Status.eq("done"))
            .into_tuple()
            .all(&db)
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
    let db = orm(db);
    let at = utc_now();
    for chunk in lead_ids.chunks(500) {
        let cells = chunk.iter().map(|lead_id| welddata_cells::ActiveModel {
            id: Set(generate_id("wdcell")),
            created_at: Set(at),
            updated_at: Set(at),
            column_id: Set(column_id.to_owned()),
            lead_id: Set(lead_id.clone()),
            status: Set("pending".to_owned()),
            ..Default::default()
        });
        welddata_cells::Entity::insert_many(cells)
            .on_conflict(
                OnConflict::columns([Cell::ColumnId, Cell::LeadId])
                    .value(Cell::Status, Expr::value("pending"))
                    .value(Cell::Error, Expr::value(Option::<String>::None))
                    .value(Cell::UpdatedAt, Expr::value(at))
                    .to_owned(),
            )
            .exec_without_returning(&db)
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

#[cfg(test)]
mod sql_preview_tmp {
    use super::*;
    use sea_orm::{DbBackend, QueryTrait};

    #[test]
    fn sql_preview_tmp() {
        let same_name = sea_orm::ExprTrait::eq(
            Func::lower(Expr::col((companies::Entity, companies::Column::Name))),
            js_lowercase("ACME"),
        );
        let q = companies::Entity::find()
            .select_only()
            .column(companies::Column::Id)
            .filter(same_name)
            .filter(companies::Column::DeletedAt.is_null())
            .build(DbBackend::Postgres);
        println!("COMPANY {q}");
        let q = welddata_leads::Entity::find()
            .select_only()
            .column(Lead::ListId)
            .column_as(Lead::Id.count(), "count")
            .filter(Lead::ListId.is_in(vec!["a".to_owned()]))
            .filter(Lead::DeletedAt.is_null())
            .group_by(Lead::ListId)
            .build(DbBackend::Postgres);
        println!("COUNTS {q}");
        let at = utc_now();
        let cells = ["a", "b"].iter().map(|lead_id| welddata_cells::ActiveModel {
            id: Set("x".into()),
            created_at: Set(at),
            updated_at: Set(at),
            column_id: Set("c".to_owned()),
            lead_id: Set((*lead_id).to_owned()),
            status: Set("pending".to_owned()),
            ..Default::default()
        });
        let q = welddata_cells::Entity::insert_many(cells)
            .on_conflict(
                OnConflict::columns([Cell::ColumnId, Cell::LeadId])
                    .value(Cell::Status, Expr::value("pending"))
                    .value(Cell::Error, Expr::value(Option::<String>::None))
                    .value(Cell::UpdatedAt, Expr::value(at))
                    .to_owned(),
            )
            .build(DbBackend::Postgres);
        println!("PENDING {q}");
        let lead = serde_json::Map::from_iter([
            ("kind".to_owned(), json!("person")),
            ("name".to_owned(), json!("Ada")),
        ]);
        let q = welddata_leads::Entity::insert_many([lead_model(&lead, "l", "person", "u", at)])
            .on_conflict(
                OnConflict::columns([Lead::ListId, Lead::Kind, Lead::LemlistId])
                    .do_nothing()
                    .to_owned(),
            )
            .build(DbBackend::Postgres);
        println!("LEADS {q}");
        let q = welddata_columns::Entity::update_many()
            .col_expr(Col::UpdatedAt, Expr::value(utc_now()))
            .col_expr(Col::Config, Expr::value(json!({"type":"ai"})))
            .col_expr(Col::Type, Expr::value("ai".to_owned()))
            .filter(Col::Id.eq("x"))
            .build(DbBackend::Postgres);
        println!("COLUPDATE {q}");
        let q = welddata_columns::Entity::find()
            .select_only()
            .column_as(Col::SortOrder.max(), "max")
            .filter(Col::ListId.eq("l"))
            .build(DbBackend::Postgres);
        println!("MAX {q}");
        let keyset: CursorRow = (at, "id1".into());
        let q = welddata_lists::Entity::find()
            .filter(Condition::all().add(List::DeletedAt.is_null()).add(List::Name.ilike("%a%")))
            .filter(before(List::CreatedAt, List::Id, &keyset))
            .order_by_desc(List::CreatedAt)
            .order_by_desc(List::Id)
            .limit(51)
            .build(DbBackend::Postgres);
        println!("LISTS {q}");
        let q = welddata_leads::Entity::find()
            .filter(lead_filters("l", &LeadQuery { cursor: None, limit: 50.0, search: None, kind: Some("person".into()), converted_status: None }, Some("%x%")))
            .build(DbBackend::Postgres);
        println!("LEADFILTERS {q}");
        let q = Condition::all().add(Condition::all());
        let q2 = welddata_leads::Entity::find().filter(q).build(DbBackend::Postgres);
        println!("EMPTY {q2}");
    }
}
