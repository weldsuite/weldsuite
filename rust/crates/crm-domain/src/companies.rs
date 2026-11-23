//! Companies (`@weldsuite/crm-domain/companies`): the identity layer for
//! organisations. Stamps `displayName` on every write; keeps the wrapping
//! `parties` row (WeldBooks customer/supplier) in step with the company.

use std::collections::HashMap;

use sea_orm::sea_query::{Expr, Func, NullOrdering, Query, SelectStatement};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, FromQueryResult, JoinType, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_core_domain::custom_field_query::{
    CustomFilter, custom_field_filter, parse_custom_field_key,
};
use weldsuite_core_domain::custom_field_values::{self as cfv, Definition};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_trim;
use weldsuite_schema::tenant::{
    companies, custom_field_values, list_members, lists, parties, people, person_companies,
};

use crate::tables::{COMPANIES, PARTIES, insert_row, update_rows};
use crate::validation::{
    StatusLookup, assert_valid_member_fields, assert_valid_status, before_row, compute_changes,
    contains_pattern, count, decode_list_cursor, encode_list_cursor, load_status_lookup,
    probe_limit, search_match, sort_order, sort_value,
};
use crate::{DomainError, DomainResult, js_date, now, to_iso};

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
    let existing: Option<(String, Option<String>, Option<Value>)> = parties::Entity::find()
        .select_only()
        .columns([
            parties::Column::Id,
            parties::Column::Role,
            parties::Column::BillingAddress,
        ])
        .filter(parties::Column::CompanyId.eq(id))
        .into_tuple()
        .one(&orm(db))
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
    values.insert("kind".into(), json!("company"));
    values.insert("companyId".into(), json!(id));
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

/// The kind of the live list `list_id`.
pub(crate) async fn list_kind(db: &PgPool, list_id: &str) -> DomainResult<Option<String>> {
    Ok(lists::Entity::find()
        .select_only()
        .column(lists::Column::Kind)
        .filter(lists::Column::Id.eq(list_id))
        .filter(lists::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?)
}

/// The entity ids on the list `list_id`.
pub(crate) async fn list_member_ids(db: &PgPool, list_id: &str) -> DomainResult<Vec<String>> {
    Ok(list_members::Entity::find()
        .select_only()
        .column(list_members::Column::EntityId)
        .filter(list_members::Column::ListId.eq(list_id))
        .into_tuple()
        .all(&orm(db))
        .await?)
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
        if list_kind(db, list_id).await?.as_deref() != Some(entity_type) {
            return Ok(None);
        }
        let members = list_member_ids(db, list_id).await?;
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

/// `buildCompanyConditions`'s `where` of a company list or export: live,
/// within the owner scope, the search and column filters, the list members
/// and the custom-field filter.
fn company_condition(
    scope: Option<&str>,
    filter: &CompanyFilter,
    resolved: &Resolved,
) -> Condition {
    use companies::Column as C;
    let given = |value: &Option<String>| value.clone().filter(|v| !v.is_empty());
    let mut condition = Condition::all().add(C::DeletedAt.is_null());
    if let Some(owner) = scope {
        condition = condition.add(C::OwnerId.eq(owner));
    }
    if let Some(search) = given(&filter.search) {
        condition = condition.add(search_match(
            &[
                C::DisplayName,
                C::Name,
                C::TradingName,
                C::Email,
                C::VatNumber,
            ],
            &contains_pattern(&search),
        ));
    }
    if let Some(status) = given(&filter.status) {
        condition = condition.add(C::Status.eq(status));
    }
    if let Some(owner) = given(&filter.owner_id) {
        condition = condition.add(C::OwnerId.eq(owner));
    }
    if let Some(industry) = given(&filter.industry) {
        condition = condition.add(C::Industry.eq(industry));
    }
    if let Some(supplier) = filter.is_supplier {
        condition = condition.add(C::IsSupplier.eq(supplier));
    }
    if let Some(lead) = filter.is_lead {
        condition = condition.add(C::IsLead.eq(lead));
    }
    if let Some(members) = &resolved.members {
        condition = condition.add(C::Id.is_in(members.clone()));
    }
    if let Some(custom) = &resolved.custom {
        condition = condition.add(C::Id.in_subquery(custom_field_match("company", custom)));
    }
    condition
}

/// `customFieldFilter`: the ids of the `entity_type` rows whose value of the
/// field matches (`v.value_number = n`, `v.value_date::date =
/// d::timestamp::date`, `v.value_bool = b`, `v.value_json @> j`,
/// `v.value_ref = r`, `v.value_text ilike p`).
fn custom_field_match(entity_type: &str, custom: &CustomFilter) -> SelectStatement {
    use custom_field_values::Column as V;
    use sea_orm::ExprTrait as _;
    let matches = match custom.kind {
        "number" => V::ValueNumber.eq(custom.number),
        "date" => V::ValueDate
            .into_expr()
            .cast_as("date")
            .eq(Expr::val(custom.date.clone())
                .cast_as("timestamp")
                .cast_as("date")),
        "bool" => V::ValueBool.eq(custom.flag),
        "json" => sea_orm::sea_query::extension::postgres::PgExpr::contains(
            V::ValueJson.into_expr(),
            Expr::val(custom.json.clone()),
        ),
        "ref" => V::ValueRef.eq(custom.reference.clone()),
        _ => match &custom.pattern {
            Some(pattern) => V::ValueText.ilike(pattern),
            None => V::ValueText.eq(Option::<String>::None),
        },
    };
    Query::select()
        .column(V::EntityId)
        .from(custom_field_values::Entity)
        .cond_where(
            Condition::all()
                .add(V::EntityType.eq(entity_type))
                .add(V::FieldId.eq(custom.field_id.as_str()))
                .add(matches),
        )
        .to_owned()
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

/// A custom field's value of the listed company, for a sort by it:
/// `coalesce(value_text, value_ref)` for text and references, the typed
/// column for the rest.
fn custom_sort_value(
    entity_type: &str,
    sort: &weldsuite_core_domain::custom_field_query::CustomSort,
) -> Expr {
    use custom_field_values::Column as V;
    use sea_orm::ExprTrait as _;
    let value = match sort.kind {
        "text" | "ref" => Expr::expr(Func::coalesce([
            V::ValueText.into_expr(),
            V::ValueRef.into_expr(),
        ])),
        "number" => V::ValueNumber.into_expr(),
        "date" => V::ValueDate.into_expr(),
        "bool" => V::ValueBool.into_expr(),
        _ => V::ValueJson.into_expr(),
    };
    Expr::from(
        Query::select()
            .expr(value)
            .from(custom_field_values::Entity)
            .cond_where(
                Condition::all()
                    .add(V::EntityType.eq(entity_type))
                    .add(
                        Expr::col((custom_field_values::Entity, V::EntityId))
                            .equals((companies::Entity, companies::Column::Id)),
                    )
                    .add(V::FieldId.eq(sort.field_id.as_str())),
            )
            .to_owned(),
    )
}

/// The column a built-in company sort orders by: `lower(col::text)` for
/// the `text` family, the column itself for the rest.
fn company_sort_value(key: &str, family: &str) -> Option<Expr> {
    use companies::Column as C;
    let column = match key {
        "name" => C::DisplayName,
        "email" => C::Email,
        "phone" => C::Phone,
        "industry" => C::Industry,
        "status" => C::Status,
        "website" => C::Website,
        "vatNumber" => C::VatNumber,
        "registrationNumber" => C::RegistrationNumber,
        "employeeCount" => C::EmployeeCount,
        "lifecycleStage" => C::LifecycleStage,
        "segment" => C::Segment,
        "source" => C::Source,
        "preferredLanguage" => C::PreferredLanguage,
        "ownerId" => C::OwnerId,
        "isSupplier" => C::IsSupplier,
        "isLead" => C::IsLead,
        "leadScore" => C::LeadScore,
        "lastContactDate" => C::LastContactDate,
        "nextFollowUpDate" => C::NextFollowUpDate,
        "createdAt" => C::CreatedAt,
        _ => return None,
    };
    Some(sort_value(column, family))
}

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
    let order = sort_order(&dir);
    let mut select = companies::Entity::find().filter(company_condition(scope, filter, &resolved));
    if let Some(keyset) = &keyset {
        select = select.filter(before_row::<companies::Entity>(
            companies::Column::CreatedAt,
            companies::Column::Id,
            keyset,
        ));
    }
    if let (Some(definition), Some(order)) = (custom_sort, order.clone()) {
        let sort = weldsuite_core_domain::custom_field_query::CustomSort::of(definition);
        select = select.order_by_with_nulls(
            custom_sort_value("company", &sort),
            order,
            NullOrdering::Last,
        );
    }
    if let (Some((key, family)), Some(order)) = (builtin, order.clone())
        && let Some(value) = company_sort_value(key, family)
    {
        select = select.order_by_with_nulls(value, order, NullOrdering::Last);
    }
    // The tie-break: newest id first for a custom field, the sort's own
    // direction for a column.
    if custom_sort.is_some() {
        select = select.order_by_desc(companies::Column::Id);
    } else if let (Some(_), Some(order)) = (builtin, order) {
        select = select.order_by(companies::Column::Id, order);
    }
    let conn = orm(db);
    let rows = select
        .order_by_desc(companies::Column::CreatedAt)
        .order_by_desc(companies::Column::Id)
        .limit(probe_limit(limit)?)
        .offset(u64::try_from(offset).unwrap_or(0))
        .all(&conn)
        .await?;
    let total_count = if let Some(total) = cursor.as_ref().and_then(|c| c.total_count) {
        total
    } else {
        count(
            companies::Entity::find()
                .filter(company_condition(scope, filter, &resolved))
                .count(&conn)
                .await?,
        )
    };
    let has_more = usize::try_from(limit).is_ok_and(|limit| rows.len() > limit);
    let mut page = rows
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()?;
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
    let rows = companies::Entity::find()
        .filter(company_condition(scope, filter, &resolved))
        .order_by_desc(companies::Column::CreatedAt)
        .order_by_desc(companies::Column::Id)
        .limit(50_000)
        .all(&orm(db))
        .await?;
    let rows = rows
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(cfv::hydrate(db, "company", rows, None).await?)
}

/// The live company row, within the owner scope, as Drizzle reads it.
pub async fn raw_company(
    db: &PgPool,
    id: &str,
    scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    let mut query =
        companies::Entity::find_by_id(id.to_owned()).filter(companies::Column::DeletedAt.is_null());
    if let Some(owner) = scope {
        query = query.filter(companies::Column::OwnerId.eq(owner));
    }
    let row = query.one(&orm(db)).await?;
    Ok(row.map(serde_json::to_value).transpose()?)
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
    insert_row::<companies::Entity>(&orm(db), &COMPANIES, &values).await?;
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
    let mut written = Condition::all().add(companies::Column::Id.eq(id));
    if expected.is_some() {
        written =
            written.add(companies::Column::Version.eq(i32::try_from(version).unwrap_or(i32::MAX)));
    }
    let written = update_rows::<companies::Entity>(&orm(db), &COMPANIES, &updates, written).await?;
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
    let now = utc_now();
    companies::Entity::update_many()
        .col_expr(companies::Column::DeletedAt, Expr::value(now))
        .col_expr(companies::Column::UpdatedAt, Expr::value(now))
        .filter(companies::Column::Id.eq(id))
        .exec(&orm(db))
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
    let now = utc_now();
    companies::Entity::update_many()
        .col_expr(
            companies::Column::ArchivedAt,
            Expr::value(archived.then_some(now)),
        )
        .col_expr(companies::Column::UpdatedAt, Expr::value(now))
        .filter(companies::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    let updated = get_company(db, id, None).await?;
    if let Some(updated) = &updated {
        ensure_wrapping_party(db, updated).await?;
    }
    Ok(updated)
}

/// A `person_companies` link with the live person's card.
#[derive(Debug, FromQueryResult)]
struct CompanyPerson {
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
    first_name: Option<String>,
    last_name: Option<String>,
    email: Option<String>,
    avatar_url: Option<String>,
}

impl CompanyPerson {
    /// The link as Drizzle returns it, with its `person`.
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
            "person": {
                "id": self.person_id,
                "displayName": self.display_name,
                "firstName": self.first_name,
                "lastName": self.last_name,
                "email": self.email,
                "avatarUrl": self.avatar_url,
            },
        })
    }
}

/// `listCompanyPeople(db, companyId, ownerScope)`: the company's people
/// links with the live person's card, primary first.
pub async fn list_company_people(
    db: &PgPool,
    company_id: &str,
    scope: Option<&str>,
) -> DomainResult<Vec<Value>> {
    use person_companies::Column as Pc;
    if scope.is_some() && get_company(db, company_id, scope).await?.is_none() {
        return Ok(Vec::new());
    }
    let rows: Vec<CompanyPerson> = person_companies::Entity::find()
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
        .column_as(people::Column::DisplayName, "display_name")
        .column_as(people::Column::FirstName, "first_name")
        .column_as(people::Column::LastName, "last_name")
        .column_as(people::Column::Email, "email")
        .column_as(people::Column::AvatarUrl, "avatar_url")
        .join(
            JoinType::LeftJoin,
            person_companies::Entity::belongs_to(people::Entity)
                .from(Pc::PersonId)
                .to(people::Column::Id)
                .on_condition(|_, person| {
                    Condition::all().add(sea_orm::ExprTrait::is_null(Expr::col((
                        person,
                        people::Column::DeletedAt,
                    ))))
                })
                .into(),
        )
        .filter(Pc::CompanyId.eq(company_id))
        .filter(people::Column::DisplayName.is_not_null())
        .order_by_desc(Pc::IsPrimary)
        .order_by_desc(Pc::CreatedAt)
        .into_model()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(CompanyPerson::json).collect())
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
    let conn = orm(db);
    let mut live = Condition::all().add(companies::Column::DeletedAt.is_null());
    if let Some(owner) = scope {
        live = live.add(companies::Column::OwnerId.eq(owner));
    }
    let before: Vec<BulkFields> = companies::Entity::find()
        .select_only()
        .columns([
            companies::Column::Id,
            companies::Column::OwnerId,
            companies::Column::AccountManagerId,
            companies::Column::Status,
            companies::Column::LifecycleStage,
        ])
        .filter(live.clone())
        .into_model()
        .all(&conn)
        .await?;
    let before: HashMap<String, Value> = before
        .into_iter()
        .map(|row| (row.id.clone(), row.json()))
        .collect();
    let mut updates = Map::new();
    updates.insert("updatedAt".into(), json!(now()));
    for field in FIELDS {
        if let Some(value) = set_fields.get(field) {
            updates.insert(field.into(), value.clone());
        }
    }
    let written = update_rows::<companies::Entity>(
        &conn,
        &COMPANIES,
        &updates,
        live.add(companies::Column::Id.is_in(ids.clone())),
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

/// A row's [`FIELDS`] before a bulk update.
#[derive(Debug, FromQueryResult)]
pub(crate) struct BulkFields {
    id: String,
    owner_id: Option<String>,
    account_manager_id: Option<String>,
    status: Option<String>,
    lifecycle_stage: Option<String>,
}

impl BulkFields {
    /// The fields by Drizzle key.
    pub(crate) fn json(self) -> Value {
        json!({
            "id": self.id,
            "ownerId": self.owner_id,
            "accountManagerId": self.account_manager_id,
            "status": self.status,
            "lifecycleStage": self.lifecycle_stage,
        })
    }
}

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
