//! Companies (`@weldsuite/crm-domain/companies`): the identity layer for
//! organisations. Stamps `displayName` on every write; keeps the wrapping
//! `parties` row (WeldBooks customer/supplier) in step with the company.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_core_domain::custom_field_query::{
    CustomFilter, custom_field_filter, parse_custom_field_key,
};
use weldsuite_core_domain::custom_field_values::{self as cfv, Definition};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_trim;

use crate::tables::{COMPANIES, PARTIES};
use crate::validation::{
    StatusLookup, assert_valid_member_fields, assert_valid_status, compute_changes,
    contains_pattern, decode_list_cursor, encode_list_cursor, load_status_lookup,
};
use crate::{DomainError, DomainResult, drizzle_row, insert_sql, now, to_iso, update_sql};

/// `deriveDisplayName({ name, tradingName })`.
pub fn derive_display_name(name: Option<&str>, trading_name: Option<&str>) -> String {
    let trimmed = |text: Option<&str>| {
        text.map(js_trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
    };
    trimmed(trading_name)
        .or_else(|| trimmed(name))
        .unwrap_or_else(|| "Unnamed Company".to_owned())
}

/// `withSupplierRole(role)`.
fn with_supplier_role(role: Option<&str>) -> &'static str {
    match role {
        Some("customer" | "both") => "both",
        _ => "supplier",
    }
}

/// `ensureWrappingParty(db, company)`: keep the `parties` row in step,
/// creating it when the company is first flagged a supplier.
pub async fn ensure_wrapping_party(db: &PgPool, company: &Value) -> DomainResult<()> {
    let id = company
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let existing: Option<(String, Option<String>, Option<Value>)> = sqlx::query_as(
        "select id, role, billing_address from parties where company_id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let supplier = company.get("isSupplier") == Some(&json!(true));
    let field = |key: &str| company.get(key).cloned().unwrap_or(Value::Null);
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
    values.insert("kind".into(), json!("company"));
    values.insert("companyId".into(), json!(id));
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

/// The list and export filters (`CompanyFilter`).
#[derive(Debug, Clone, Default)]
pub struct CompanyFilter {
    pub search: Option<String>,
    pub status: Option<String>,
    pub owner_id: Option<String>,
    pub industry: Option<String>,
    pub is_supplier: Option<bool>,
    pub is_lead: Option<bool>,
    pub list_id: Option<String>,
    pub custom_filter: Option<String>,
}

/// What `buildCompanyConditions` resolved: the list members and the
/// custom-field filter, looked up before the page.
#[derive(Debug, Clone, Default)]
pub struct Resolved {
    pub members: Option<Vec<String>>,
    pub custom: Option<CustomFilter>,
}

/// `buildCompanyConditions`: `None` when the filter can only match nothing.
pub async fn resolve_filter(
    db: &PgPool,
    filter: &CompanyFilter,
    entity_type: &str,
    definitions: Option<&[Definition]>,
) -> DomainResult<Option<Resolved>> {
    let mut resolved = Resolved::default();
    if let Some(list_id) = filter.list_id.as_deref().filter(|l| !l.is_empty()) {
        let kind: Option<String> = sqlx::query_scalar(
            "select kind from lists where id = $1 and deleted_at is null limit 1",
        )
        .bind(list_id)
        .fetch_optional(db)
        .await?;
        if kind.as_deref() != Some(entity_type) {
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
    if let Some(custom) = filter.custom_filter.as_deref().filter(|c| !c.is_empty()) {
        let Some(sep) = custom.find(':').filter(|sep| *sep > 0) else {
            return Ok(None);
        };
        let (slug, value) = (&custom[..sep], &custom[sep + 1..]);
        let loaded;
        let definitions = if let Some(definitions) = definitions {
            definitions
        } else {
            loaded = cfv::definitions(db, entity_type).await?;
            &loaded
        };
        let Some(definition) = definitions.iter().find(|d| d.slug == slug) else {
            return Ok(None);
        };
        let Some(filter) = custom_field_filter(definition, value) else {
            return Ok(None);
        };
        resolved.custom = Some(filter);
    }
    Ok(Some(resolved))
}

/// The `where` of a company list or export: `$1` owner scope, `$2` search
/// pattern, `$3`–`$7` the column filters, `$8` list members, `$9`–`$16`
/// the custom-field filter.
macro_rules! company_where {
    () => {
        "t.deleted_at is null
           and ($1::text is null or t.owner_id = $1)
           and ($2::text is null or (coalesce(t.display_name, '') || E'\\n' || coalesce(t.name, '')
                || E'\\n' || coalesce(t.trading_name, '') || E'\\n' || coalesce(t.email, '')
                || E'\\n' || coalesce(t.vat_number, '')) ilike $2)
           and ($3::text is null or t.status = $3)
           and ($4::text is null or t.owner_id = $4)
           and ($5::text is null or t.industry = $5)
           and ($6::bool is null or t.is_supplier = $6)
           and ($7::bool is null or t.is_lead = $7)
           and ($8::text[] is null or t.id = any($8))
           and ($9::text is null or t.id in (
                select v.entity_id from custom_field_values v
                where v.entity_type = 'company' and v.field_id = $10
                  and (case $9 when 'number' then v.value_number = $11
                               when 'date' then v.value_date::date = $12::timestamp::date
                               when 'bool' then v.value_bool = $13
                               when 'json' then v.value_json @> $14
                               when 'ref' then v.value_ref = $15
                               else v.value_text ilike $16 end)))"
    };
}

/// Bind the sixteen parameters of [`company_where`] / `person_where`.
#[macro_export]
macro_rules! bind_entity_filter {
    ($query:expr, $scope:expr, $filter:expr, $resolved:expr) => {{
        let custom = $resolved.custom.as_ref();
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
            .bind($filter.industry.as_deref().filter(|s| !s.is_empty()))
            .bind($filter.is_supplier)
            .bind($filter.is_lead)
            .bind($resolved.members.as_ref())
            .bind(custom.map(|c| c.kind))
            .bind(custom.map(|c| c.field_id.clone()))
            .bind(custom.and_then(|c| c.number))
            .bind(custom.and_then(|c| c.date.clone()))
            .bind(custom.and_then(|c| c.flag))
            .bind(custom.and_then(|c| c.json.clone()))
            .bind(custom.and_then(|c| c.reference.clone()))
            .bind(custom.and_then(|c| c.pattern.clone()))
    }};
}

/// Built-in sortable columns: grid key → (sort family, column).
/// `text` sorts `lower(col::text)`; the rest sort the column itself.
pub const COMPANY_SORTS: [(&str, &str); 20] = [
    ("name", "text"),
    ("email", "text"),
    ("phone", "text"),
    ("industry", "text"),
    ("status", "text"),
    ("website", "text"),
    ("isSupplier", "bool"),
    ("isLead", "bool"),
    ("vatNumber", "text"),
    ("registrationNumber", "text"),
    ("employeeCount", "text"),
    ("lifecycleStage", "text"),
    ("segment", "text"),
    ("source", "text"),
    ("leadScore", "int"),
    ("preferredLanguage", "text"),
    ("ownerId", "text"),
    ("lastContactDate", "time"),
    ("nextFollowUpDate", "time"),
    ("createdAt", "time"),
];

/// One page of a list (`ListResult`).
#[derive(Debug, Clone)]
pub struct ListPage {
    pub data: Vec<Value>,
    pub total_count: i64,
    pub has_more: bool,
    pub cursor: Option<String>,
}

/// The list's paging and sort (`ListCompaniesQuery` beyond the filter).
#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    pub limit: i64,
    pub cursor: Option<String>,
    pub sort: Option<String>,
    pub sort_dir: Option<String>,
    pub include_attributes: bool,
}

/// `listCompanies(db, params, ownerScope)`.
#[allow(clippy::too_many_lines)] // the one list query, as TypeScript builds it
pub async fn list_companies(
    db: &PgPool,
    filter: &CompanyFilter,
    options: &ListOptions,
    scope: Option<&str>,
) -> DomainResult<ListPage> {
    let limit = options.limit.min(100);
    let definitions = cfv::definitions(db, "company").await?;
    let Some(resolved) = resolve_filter(db, filter, "company", Some(&definitions)).await? else {
        return Ok(ListPage {
            data: Vec::new(),
            total_count: 0,
            has_more: false,
            cursor: None,
        });
    };
    let cursor = decode_list_cursor(options.cursor.as_deref());
    let custom_slug = parse_custom_field_key(options.sort.as_deref());
    let custom_sort = custom_slug.and_then(|slug| definitions.iter().find(|d| d.slug == slug));
    let builtin = if custom_sort.is_some() {
        None
    } else {
        options
            .sort
            .as_deref()
            .and_then(|sort| COMPANY_SORTS.iter().find(|(key, _)| *key == sort))
    };
    let explicit = custom_sort.is_some() || builtin.is_some();
    let dir = options.sort_dir.clone().unwrap_or_else(|| "asc".to_owned());
    let offset = match (&cursor, explicit) {
        (Some(c), true) => crate::js::parse_int(&c.position).unwrap_or(0).max(0),
        _ => 0,
    };
    let keyset = if explicit {
        None
    } else {
        cursor.as_ref().map(|c| c.position.clone())
    };
    let (sort_family, sort_key) =
        builtin.map_or((None, None), |(key, family)| (Some(*family), Some(*key)));
    let (custom_kind, custom_field) = custom_sort.map_or((None, None), |d| {
        let sort = weldsuite_core_domain::custom_field_query::CustomSort::of(d);
        (Some(sort.kind), Some(sort.field_id))
    });
    let tie_break = if custom_sort.is_some() {
        Some("desc".to_owned())
    } else if builtin.is_some() {
        Some(dir.clone())
    } else {
        None
    };
    let query = sqlx::query_scalar::<_, Value>(concat!(
        "select to_jsonb(t) from companies t where ",
        company_where!(),
        " and ($17::text is null or (t.created_at, t.id) < (select c.created_at, c.id from companies c where c.id = $17))
         order by
           (select case when $22 in ('text', 'ref') then coalesce(v.value_text, v.value_ref) end
              from custom_field_values v where $21 = 'asc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23
                and case $22 when 'text' then true when 'ref' then true else false end) asc nulls last,
           (select case when $22 in ('text', 'ref') then coalesce(v.value_text, v.value_ref) end
              from custom_field_values v where $21 = 'desc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23
                and case $22 when 'text' then true when 'ref' then true else false end) desc nulls last,
           (select v.value_number from custom_field_values v where $22 = 'number' and $21 = 'asc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23) asc nulls last,
           (select v.value_number from custom_field_values v where $22 = 'number' and $21 = 'desc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23) desc nulls last,
           (select v.value_date from custom_field_values v where $22 = 'date' and $21 = 'asc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23) asc nulls last,
           (select v.value_date from custom_field_values v where $22 = 'date' and $21 = 'desc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23) desc nulls last,
           (select v.value_bool from custom_field_values v where $22 = 'bool' and $21 = 'asc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23) asc nulls last,
           (select v.value_bool from custom_field_values v where $22 = 'bool' and $21 = 'desc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23) desc nulls last,
           (select v.value_json from custom_field_values v where $22 = 'json' and $21 = 'asc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23) asc nulls last,
           (select v.value_json from custom_field_values v where $22 = 'json' and $21 = 'desc' and v.entity_type = 'company' and v.entity_id = t.id and v.field_id = $23) desc nulls last,
           case when $18 = 'text' and $21 = 'asc' then lower((case $19
               when 'name' then t.display_name when 'email' then t.email when 'phone' then t.phone
               when 'industry' then t.industry when 'status' then t.status when 'website' then t.website
               when 'vatNumber' then t.vat_number when 'registrationNumber' then t.registration_number
               when 'employeeCount' then t.employee_count when 'lifecycleStage' then t.lifecycle_stage
               when 'segment' then t.segment when 'source' then t.source
               when 'preferredLanguage' then t.preferred_language when 'ownerId' then t.owner_id end)::text) end asc nulls last,
           case when $18 = 'text' and $21 = 'desc' then lower((case $19
               when 'name' then t.display_name when 'email' then t.email when 'phone' then t.phone
               when 'industry' then t.industry when 'status' then t.status when 'website' then t.website
               when 'vatNumber' then t.vat_number when 'registrationNumber' then t.registration_number
               when 'employeeCount' then t.employee_count when 'lifecycleStage' then t.lifecycle_stage
               when 'segment' then t.segment when 'source' then t.source
               when 'preferredLanguage' then t.preferred_language when 'ownerId' then t.owner_id end)::text) end desc nulls last,
           case when $18 = 'bool' and $21 = 'asc' then (case $19 when 'isSupplier' then t.is_supplier when 'isLead' then t.is_lead end) end asc nulls last,
           case when $18 = 'bool' and $21 = 'desc' then (case $19 when 'isSupplier' then t.is_supplier when 'isLead' then t.is_lead end) end desc nulls last,
           case when $18 = 'int' and $21 = 'asc' then t.lead_score end asc nulls last,
           case when $18 = 'int' and $21 = 'desc' then t.lead_score end desc nulls last,
           case when $18 = 'time' and $21 = 'asc' then (case $19 when 'lastContactDate' then t.last_contact_date
               when 'nextFollowUpDate' then t.next_follow_up_date when 'createdAt' then t.created_at end) end asc nulls last,
           case when $18 = 'time' and $21 = 'desc' then (case $19 when 'lastContactDate' then t.last_contact_date
               when 'nextFollowUpDate' then t.next_follow_up_date when 'createdAt' then t.created_at end) end desc nulls last,
           case when $24 = 'asc' then t.id end asc,
           case when $24 = 'desc' then t.id end desc,
           t.created_at desc, t.id desc
         limit $20 offset $25"
    ));
    let query = bind_entity_filter!(query, scope, filter, resolved);
    let rows: Vec<Value> = query
        .bind(&keyset)
        .bind(sort_family)
        .bind(sort_key)
        .bind(limit + 1)
        .bind(&dir)
        .bind(custom_kind)
        .bind(&custom_field)
        .bind(&tie_break)
        .bind(offset)
        .fetch_all(db)
        .await?;
    let total_count = if let Some(total) = cursor.as_ref().and_then(|c| c.total_count) {
        total
    } else {
        {
            let query = sqlx::query_scalar::<_, i64>(concat!(
                "select count(*) from companies t where ",
                company_where!()
            ));
            bind_entity_filter!(query, scope, filter, resolved)
                .fetch_one(db)
                .await?
        }
    };
    let has_more = usize::try_from(limit).is_ok_and(|limit| rows.len() > limit);
    let mut page: Vec<Value> = rows.into_iter().map(drizzle_row).collect();
    page.truncate(usize::try_from(limit).unwrap_or(0));
    let mut data = cfv::hydrate(db, "company", page, Some(&definitions)).await?;
    if options.include_attributes {
        let ids: Vec<String> = data
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        let attributes = crate::company_attributes::company_attributes(db, &ids).await?;
        for row in &mut data {
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if let (Value::Object(fields), Some(attrs)) = (row, attributes.get(&id)) {
                fields.insert("attributes".into(), attrs.clone());
            }
        }
    }
    let position = if explicit {
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

/// `exportCompanies(db, filter, ownerScope)`: every match, newest first,
/// capped at 50 000.
pub async fn export_companies(
    db: &PgPool,
    filter: &CompanyFilter,
    scope: Option<&str>,
) -> DomainResult<Vec<Value>> {
    let Some(resolved) = resolve_filter(db, filter, "company", None).await? else {
        return Ok(Vec::new());
    };
    let query = sqlx::query_scalar::<_, Value>(concat!(
        "select to_jsonb(t) from companies t where ",
        company_where!(),
        " order by t.created_at desc, t.id desc limit 50000"
    ));
    let rows: Vec<Value> = bind_entity_filter!(query, scope, filter, resolved)
        .fetch_all(db)
        .await?;
    Ok(cfv::hydrate(
        db,
        "company",
        rows.into_iter().map(drizzle_row).collect(),
        None,
    )
    .await?)
}

/// The live company row, within the owner scope, as Drizzle reads it.
pub async fn raw_company(
    db: &PgPool,
    id: &str,
    scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from companies t
         where id = $1 and deleted_at is null and ($2::text is null or owner_id = $2) limit 1",
    )
    .bind(id)
    .bind(scope)
    .fetch_optional(db)
    .await?;
    Ok(row.map(drizzle_row))
}

/// `getCompany(db, id, ownerScope)`: the live row with its custom fields.
pub async fn get_company(
    db: &PgPool,
    id: &str,
    scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    let row = raw_company(db, id, scope).await?;
    Ok(cfv::hydrate_one(db, "company", row).await?)
}

/// The create/import input columns copied as they are, in `insertCompanyRow`'s
/// order, with the default of each (`?? null` unless noted).
const COPIED: [(&str, Option<&str>); 36] = [
    ("registrationNumber", None),
    ("vatNumber", None),
    ("industry", None),
    ("employeeCount", None),
    ("website", None),
    ("description", None),
    ("annualRevenue", None),
    ("fundingRaised", None),
    ("alternateEmails", None),
    ("phone", None),
    ("mobile", None),
    ("fax", None),
    ("primaryAddress", None),
    ("addresses", None),
    ("avatarUrl", None),
    ("linkedinUrl", None),
    ("twitterHandle", None),
    ("facebookUrl", None),
    ("instagramUrl", None),
    ("angellistUrl", None),
    ("twitterFollowerCount", None),
    ("ownerId", None),
    ("accountManagerId", None),
    ("status", Some("\"prospect\"")),
    ("lifecycleStage", None),
    ("segment", None),
    ("rating", None),
    ("source", None),
    ("isSupplier", Some("false")),
    ("isLead", Some("false")),
    ("isFavorite", Some("false")),
    ("preferredContactMethod", None),
    ("preferredLanguage", None),
    ("timezone", None),
    ("marketingConsent", Some("false")),
    ("emailOptIn", Some("false")),
];

/// `value ?? fallback`.
fn or_null(input: &Map<String, Value>, key: &str, fallback: Option<&str>) -> Value {
    match input.get(key) {
        Some(value) if !value.is_null() => value.clone(),
        _ => fallback.map_or(Value::Null, |f| {
            serde_json::from_str(f).unwrap_or(Value::Null)
        }),
    }
}

/// `insertCompanyRow(db, input)`: insert, re-read, and sync the party.
async fn insert_company_row(
    db: &PgPool,
    input: &Map<String, Value>,
    created_by: Option<&str>,
) -> DomainResult<Value> {
    let id = generate_id("company");
    let now = now();
    let text = |key: &str| input.get(key).and_then(Value::as_str);
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.insert("createdAt".into(), json!(now));
    values.insert("updatedAt".into(), json!(now));
    values.insert("version".into(), json!(1));
    // `input.partyCode?.trim() || null`
    let party_code = text("partyCode").map(js_trim).filter(|c| !c.is_empty());
    values.insert(
        "partyCode".into(),
        party_code.map_or(Value::Null, |c| json!(c)),
    );
    values.insert(
        "name".into(),
        input.get("name").cloned().unwrap_or(Value::Null),
    );
    values.insert("tradingName".into(), or_null(input, "tradingName", None));
    values.insert(
        "displayName".into(),
        json!(derive_display_name(text("name"), text("tradingName"))),
    );
    for (key, fallback) in COPIED {
        values.insert(key.into(), or_null(input, key, fallback));
    }
    values.insert(
        "foundationDate".into(),
        match text("foundationDate") {
            Some(date) if !date.is_empty() => json!(to_iso(date)?),
            _ => Value::Null,
        },
    );
    // `input.email || null`
    values.insert(
        "email".into(),
        text("email")
            .filter(|e| !e.is_empty())
            .map_or(Value::Null, |e| json!(e)),
    );
    values.insert(
        "createdBy".into(),
        created_by.map_or(Value::Null, |c| json!(c)),
    );
    for (key, fallback) in [
        ("smsOptIn", Some("false")),
        ("doNotCall", Some("false")),
        ("tags", None),
        ("customFields", None),
        ("notes", None),
        ("internalNotes", None),
    ] {
        values.insert(key.into(), or_null(input, key, fallback));
    }
    sqlx::query(insert_sql!(companies))
        .bind(COMPANIES.values(&values))
        .execute(db)
        .await?;
    let created = get_company(db, &id, None)
        .await?
        .ok_or_else(|| DomainError::Other("Company disappeared after insert".to_owned()))?;
    ensure_wrapping_party(db, &created).await?;
    Ok(created)
}

/// `createCompany(db, input, { createdBy })`.
pub async fn create_company(
    db: &PgPool,
    input: &Map<String, Value>,
    created_by: Option<&str>,
) -> DomainResult<Value> {
    assert_valid_member_fields(db, input).await?;
    assert_valid_status(db, input.get("status"), None).await?;
    let created = insert_company_row(db, input, created_by).await?;
    let id = created
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    cfv::sync_values_for_entity(db, "company", &id, input.get("customFields")).await;
    Ok(created)
}

/// `CompanyVersionConflictError`'s message.
pub const VERSION_CONFLICT: &str =
    "This record was changed by someone else. Reload to see the latest version.";

/// `updateCompany(db, id, input, ownerScope, { statusLookup })`: the row and
/// the field changes, or `None` when the company isn't there.
pub async fn update_company(
    db: &PgPool,
    id: &str,
    input: &Map<String, Value>,
    scope: Option<&str>,
    statuses: Option<&StatusLookup>,
) -> DomainResult<Option<(Value, Option<Map<String, Value>>)>> {
    let Some(existing) = raw_company(db, id, scope).await? else {
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
    assert_valid_status(db, input.get("status"), statuses).await?;
    let mut updates = Map::new();
    updates.insert("updatedAt".into(), json!(now()));
    updates.insert("version".into(), json!(version + 1));
    for (key, value) in input {
        if matches!(
            key.as_str(),
            "ifVersion" | "version" | "lastContactDate" | "nextFollowUpDate" | "foundationDate"
        ) {
            continue;
        }
        updates.insert(key.clone(), value.clone());
    }
    for key in ["lastContactDate", "nextFollowUpDate", "foundationDate"] {
        match input.get(key) {
            None => {}
            Some(Value::String(date)) if !date.is_empty() => {
                updates.insert(key.into(), json!(to_iso(date)?));
            }
            Some(_) => {
                updates.insert(key.into(), Value::Null);
            }
        }
    }
    if input.contains_key("name") || input.contains_key("tradingName") {
        let pick = |key: &str| {
            input
                .get(key)
                .filter(|v| !v.is_null())
                .or_else(|| existing.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        updates.insert(
            "displayName".into(),
            json!(derive_display_name(
                pick("name").as_deref(),
                pick("tradingName").as_deref()
            )),
        );
    }
    let written: Vec<String> = sqlx::query_scalar(update_sql!(
        companies,
        "where t.id = $1 and ($3::int is null or t.version = $3) returning t.id"
    ))
    .bind(id)
    .bind(COMPANIES.set(&updates))
    .bind(expected.map(|_| i32::try_from(version).unwrap_or(i32::MAX)))
    .fetch_all(db)
    .await?;
    if written.is_empty() {
        if expected.is_some() {
            return Err(DomainError::VersionConflict(VERSION_CONFLICT.to_owned()));
        }
        return Ok(None);
    }
    let Some(fresh) = get_company(db, id, None).await? else {
        return Ok(None);
    };
    ensure_wrapping_party(db, &fresh).await?;
    cfv::sync_values_for_entity(db, "company", id, input.get("customFields")).await;
    let changes = compute_changes(&existing, &fresh);
    Ok(Some((fresh, changes)))
}

/// Soft-delete a live company in the owner scope; `false` when not found.
pub async fn delete_company(db: &PgPool, id: &str, scope: Option<&str>) -> DomainResult<bool> {
    if raw_company(db, id, scope).await?.is_none() {
        return Ok(false);
    }
    sqlx::query(
        "update companies set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(true)
}

/// `archiveCompany` (`archived = true`) or `unarchiveCompany`.
pub async fn set_archived(
    db: &PgPool,
    id: &str,
    archived: bool,
    scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    if raw_company(db, id, scope).await?.is_none() {
        return Ok(None);
    }
    let now = now();
    sqlx::query(
        "update companies set archived_at = case when $3 then $2::timestamp else null end,
             updated_at = $2::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(&now)
    .bind(archived)
    .execute(db)
    .await?;
    let updated = get_company(db, id, None).await?;
    if let Some(updated) = &updated {
        ensure_wrapping_party(db, updated).await?;
    }
    Ok(updated)
}

/// `listCompanyPeople(db, companyId, ownerScope)`: the company's people
/// links with the live person's card, primary first.
pub async fn list_company_people(
    db: &PgPool,
    company_id: &str,
    scope: Option<&str>,
) -> DomainResult<Vec<Value>> {
    if scope.is_some() && get_company(db, company_id, scope).await?.is_none() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
                 'id', pc.id, 'created_at', pc.created_at, 'updated_at', pc.updated_at,
                 'person_id', pc.person_id, 'company_id', pc.company_id, 'role', pc.role,
                 'is_primary', pc.is_primary, 'started_at', pc.started_at, 'ended_at', pc.ended_at,
                 'person', jsonb_build_object('id', pc.person_id, 'displayName', p.display_name,
                     'firstName', p.first_name, 'lastName', p.last_name, 'email', p.email,
                     'avatarUrl', p.avatar_url))
         from person_companies pc
         left join people p on p.id = pc.person_id and p.deleted_at is null
         where pc.company_id = $1 and p.display_name is not null
         order by pc.is_primary desc, pc.created_at desc",
    )
    .bind(company_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(drizzle_row).collect())
}

/// `bulkUpdateCompanies(db, { companyIds, updates }, ownerScope)`:
/// `(updated, failed, changed rows as (id, before, after))`.
pub async fn bulk_update_companies(
    db: &PgPool,
    company_ids: &[String],
    set_fields: &Map<String, Value>,
    scope: Option<&str>,
) -> DomainResult<(
    usize,
    Vec<Value>,
    Vec<(String, Map<String, Value>, Map<String, Value>)>,
)> {
    let mut ids: Vec<String> = Vec::new();
    for id in company_ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Ok((0, Vec::new(), Vec::new()));
    }
    if !FIELDS.iter().any(|f| set_fields.contains_key(*f)) {
        let failed = ids
            .iter()
            .map(|id| json!({ "id": id, "reason": "No fields to update" }))
            .collect();
        return Ok((0, failed, Vec::new()));
    }
    assert_valid_member_fields(db, set_fields).await?;
    assert_valid_status(db, set_fields.get("status"), None).await?;
    let before: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'ownerId', owner_id, 'accountManagerId', account_manager_id,
                 'status', status, 'lifecycleStage', lifecycle_stage)
         from companies where deleted_at is null and ($1::text is null or owner_id = $1)",
    )
    .bind(scope)
    .fetch_all(db)
    .await?;
    let before: HashMap<String, Value> = before
        .into_iter()
        .map(|row| (row["id"].as_str().unwrap_or_default().to_owned(), row))
        .collect();
    let mut updates = Map::new();
    updates.insert("updatedAt".into(), json!(now()));
    for field in FIELDS {
        if let Some(value) = set_fields.get(field) {
            updates.insert(field.into(), value.clone());
        }
    }
    let written: Vec<String> = sqlx::query_scalar(update_sql!(
        companies,
        "where t.id = any($1) and t.deleted_at is null and ($3::text is null or t.owner_id = $3) returning t.id"
    ))
    .bind(&ids)
    .bind(COMPANIES.set(&updates))
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
                    FIELDS
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

/// The fields a bulk update may set.
const FIELDS: [&str; 4] = ["ownerId", "accountManagerId", "status", "lifecycleStage"];

/// `loadCustomerStatusLookup`, re-exported for the importer's callers.
pub async fn status_lookup(db: &PgPool) -> DomainResult<StatusLookup> {
    load_status_lookup(db).await
}

/// Insert a company for the importer (`importAsNew`'s `insertCompanyRow`).
pub async fn insert_imported(
    db: &PgPool,
    record: &Map<String, Value>,
    owner: Option<&str>,
) -> DomainResult<Value> {
    let mut input = record.clone();
    input.insert("ownerId".into(), owner.map_or(Value::Null, |o| json!(o)));
    let created = insert_company_row(db, &input, owner).await?;
    let id = created
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    cfv::sync_values_for_entity(db, "company", &id, created.get("customFields")).await;
    Ok(created)
}

/// `refreshCompanyLogo`'s read: the live company within the scope.
pub async fn company_for_logo(
    db: &PgPool,
    id: &str,
    scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    raw_company(db, id, scope).await
}

/// `contains_pattern`, re-exported for the person list.
pub fn search_pattern(term: &str) -> String {
    contains_pattern(term)
}
