//! `/api/opportunities` (`routes/opportunities/index.ts`): deals in
//! `crm_opportunities`. Without `opportunities:scope:all` a caller sees
//! only the deals they own.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, OPPORTUNITY_CREATED, OPPORTUNITY_DELETED, OPPORTUNITY_LOST,
    OPPORTUNITY_STAGE_CHANGED, OPPORTUNITY_UPDATED, OPPORTUNITY_WON,
};
use weldsuite_catalogs::permission_keys::OPPORTUNITIES_SCOPE_ALL;
use weldsuite_core_domain::custom_field_values::{hydrate, hydrate_one, sync_values_for_entity};
use weldsuite_crm_domain::opportunities::{
    build_update_payload, create_opportunity, live_opportunity, load_stage, lookup_company_name,
    opportunity_update_events, sync_status_with_stage,
};
use weldsuite_crm_domain::tables::CRM_OPPORTUNITIES;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::Issues;
use weldsuite_kit::{ApiError, Created, Data, NoContent};
use weldsuite_schema::tenant::{companies, crm_opportunities};

use crate::orm_rows::{before, cursor_row, json, probe_limit, set_values};
use crate::schema::{self, Kind, NULLISH, OPT, REQ, STRINGS, Spec, int, partial, refine, s};
use crate::{Answer, Caller, CrmState, Refusal, answer, cut, js_limit, page, query_map, validate};

const LOG: &str = "opportunities";

/// `crm_opportunities`, written from a body as Drizzle wrote it.
const OPPORTUNITIES: JsonTable = JsonTable::of::<crm_opportunities::Entity>();

/// `createOpportunitySchema`.
const CREATE: [Spec; 30] = [
    Spec::new("name", s(Some(1), Some(255)), REQ),
    Spec::new("customerId", s(None, None), REQ),
    Spec::new("primaryContactId", s(None, None), NULLISH),
    Spec::new("description", s(None, None), OPT),
    Spec::new("amount", Kind::StrOrNum, OPT),
    Spec::new("currency", s(None, Some(3)), OPT),
    Spec::new("expectedRevenue", Kind::StrOrNum, OPT),
    Spec::new("recurringRevenue", Kind::StrOrNum, OPT),
    Spec::new("contractLength", int(None, None), OPT),
    Spec::new("stage", s(None, None), OPT),
    Spec::new("stageId", s(None, None), NULLISH),
    Spec::new("status", s(None, None), OPT),
    Spec::new("probability", int(Some(0.0), Some(100.0)), OPT),
    Spec::new("pipeline", s(None, None), OPT),
    Spec::new("closeDate", s(None, None), NULLISH),
    Spec::new("startDate", s(None, None), OPT),
    Spec::new("ownerId", s(None, None), NULLISH),
    Spec::new("teamMembers", STRINGS, OPT),
    Spec::new("leadSource", s(None, None), OPT),
    Spec::new("campaign", s(None, None), OPT),
    Spec::new("type", s(None, None), OPT),
    Spec::new("category", s(None, None), OPT),
    Spec::new("nextStep", s(None, None), OPT),
    Spec::new("nextStepDate", s(None, None), OPT),
    Spec::new(
        "riskLevel",
        Kind::Enum(&["high", "medium", "low", "none"]),
        OPT,
    ),
    Spec::new("riskReason", s(None, None), OPT),
    Spec::new("proposalUrl", s(None, None), OPT),
    Spec::new("contractUrl", s(None, None), OPT),
    Spec::new("tags", STRINGS, OPT),
    Spec::new("customFields", Kind::Unknown, OPT),
];

fn fields() -> &'static [Spec] {
    &CREATE
}

/// ISO 4217 codes (`ISO_4217_CURRENCY_CODES`).
const CURRENCIES: &[&str] = &[
    "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT",
    "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD",
    "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP",
    "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF",
    "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK",
    "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK",
    "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU",
    "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR",
    "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR",
    "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC",
    "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX",
    "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF", "XPF", "YER",
    "ZAR", "ZMW", "ZWG", "ZWL",
];

/// `Date.parse(text)` succeeds.
fn date_parses(text: &str) -> bool {
    weldsuite_crm_domain::js::js_date(text).is_some()
}

/// The schema, or its `.partial()`, with its three refinements.
fn read_body(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial_schema: bool,
) -> Map<String, Value> {
    let specs = if partial_schema {
        partial(fields())
    } else {
        fields().to_vec()
    };
    let mut out = schema::read_sync(issues, body, &specs);
    refine(
        issues,
        body,
        "currency",
        |v| matches!(v, None | Some(Value::String(_))),
        |v| match v {
            Some(Value::String(code)) => code.is_empty() || CURRENCIES.contains(&code.as_str()),
            _ => true,
        },
        "Currency must be a valid 3-letter ISO 4217 code (e.g. USD, EUR)",
    );
    refine(
        issues,
        body,
        "closeDate",
        |v| matches!(v, None | Some(Value::Null | Value::String(_))),
        |v| match v {
            Some(Value::String(text)) => text.is_empty() || date_parses(text),
            _ => true,
        },
        "closeDate must be a valid date",
    );
    for (key, value) in schema::read_unions(issues, body, &specs) {
        out.insert(key, value);
    }
    // amount: a string or a number that reads as a number ≥ 0.
    refine(
        issues,
        body,
        "amount",
        |v| matches!(v, None | Some(Value::String(_) | Value::Number(_))),
        |v| match v {
            None => true,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n >= 0.0),
            Some(Value::String(text)) => {
                let n = weldsuite_kit::validation::js_number(text);
                !n.is_nan() && n >= 0.0
            }
            Some(_) => false,
        },
        "Amount must be zero or greater",
    );
    out
}

/// A deal and its company (`leftJoin(companies, eq(companies.id,
/// t.customerId))`).
#[derive(Debug, FromQueryResult)]
struct WithCompany {
    #[sea_orm(nested)]
    deal: crm_opportunities::Model,
    company_id: Option<String>,
    company_deleted_at: Option<PrimitiveDateTime>,
}

/// The deals joined to their companies.
fn with_company() -> sea_orm::Select<crm_opportunities::Entity> {
    let company: RelationDef = crm_opportunities::Entity::belongs_to(companies::Entity)
        .from(crm_opportunities::Column::CustomerId)
        .to(companies::Column::Id)
        .into();
    crm_opportunities::Entity::find()
        .column_as(companies::Column::Id, "company_id")
        .column_as(companies::Column::DeletedAt, "company_deleted_at")
        .join(JoinType::LeftJoin, company)
}

/// The deal as Drizzle returns it (amounts as their text), with
/// `companyDeleted`: it names a company that is gone or deleted.
fn deal_json(row: WithCompany) -> Result<Value, DbErr> {
    let deleted = !row.deal.customer_id.is_empty()
        && (row.company_id.is_none() || row.company_deleted_at.is_some());
    let mut deal = json(serde_json::to_value(row.deal))?;
    if let Value::Object(fields) = &mut deal {
        fields.insert("companyDeleted".into(), Value::Bool(deleted));
    }
    Ok(deal)
}

/// A deal with `companyDeleted`, within the owner scope.
async fn live_with_company(
    caller: &Caller,
    id: &str,
    scope: Option<&str>,
) -> Result<Option<Value>, DbErr> {
    use crm_opportunities::Column;
    let mut find = with_company()
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null());
    if let Some(scope) = scope {
        find = find.filter(Column::OwnerId.eq(scope));
    }
    let row = find
        .into_model::<WithCompany>()
        .one(&orm(&caller.db))
        .await?;
    row.map(deal_json).transpose()
}

/// The list's filters (its count's conditions), in TypeScript's order.
fn list_filters(
    scope: Option<&String>,
    param: &dyn Fn(&str) -> Option<String>,
    customer_ids: Option<Vec<String>>,
) -> Condition {
    use crm_opportunities::{Column, Entity};
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(scope) = scope {
        filters = filters.add(Column::OwnerId.eq(scope.as_str()));
    }
    for (key, column) in [
        ("status", Column::Status),
        ("stage", Column::Stage),
        ("pipeline", Column::Pipeline),
        ("ownerId", Column::OwnerId),
        ("customerId", Column::CustomerId),
    ] {
        if let Some(value) = param(key) {
            filters = filters.add(column.eq(value));
        }
    }
    if let Some(ids) = customer_ids {
        filters = filters.add(Column::CustomerId.is_in(ids));
    }
    if let Some(person) = param("personId") {
        // `@>` of a one-id array: the person is among the deal's people or
        // contacts.
        filters = filters.add(
            Condition::any()
                .add(PgExpr::contains(
                    Expr::col((Entity, Column::PersonIds)),
                    json!([person]),
                ))
                .add(PgExpr::contains(
                    Expr::col((Entity, Column::ContactIds)),
                    json!([person]),
                )),
        );
    }
    if let Some(search) = param("search") {
        let term = format!("%{search}%");
        filters = filters.add(
            Condition::any()
                .add(Column::Name.like(term.as_str()))
                .add(Column::CustomerName.like(term.as_str()))
                .add(Column::Description.like(term)),
        );
    }
    filters
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(
        run_list(&caller, query.as_deref()).await,
        LOG,
        "Failed to list opportunities",
    )
}

async fn run_list(caller: &Caller, query: Option<&str>) -> Answer {
    use crm_opportunities::{Column, Entity};
    let q = query_map(query);
    let limit = js_limit(q.get("limit"), 25, 100);
    let scope = caller.scope(OPPORTUNITIES_SCOPE_ALL);
    let param = |key: &str| q.get(key).filter(|v| !v.is_empty()).cloned();
    let customer_ids: Option<Vec<String>> = param("customerIds").and_then(|raw| {
        let ids: Vec<String> = raw
            .split(',')
            .map(|v| weldsuite_kit::validation::js_trim(v).to_owned())
            .filter(|v| !v.is_empty())
            .take(200)
            .collect();
        (!ids.is_empty()).then_some(ids)
    });
    let mut cursor = None;
    if let Some(id) = param("cursor") {
        cursor = cursor_row::<Entity>(&caller.db, Column::CreatedAt, Column::Id, &id).await?;
    }
    let limit = limit.ok_or_else(|| Refusal::Failed("limit is NaN".to_owned()))?;
    let filters = list_filters(scope.as_ref(), &param, customer_ids);
    let mut rows = with_company().filter(filters.clone());
    if let Some(cursor) = &cursor {
        rows = rows.filter(before(Column::CreatedAt, Column::Id, cursor));
    }
    let db = orm(&caller.db);
    let rows = rows
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(probe_limit(limit)?)
        .into_model::<WithCompany>()
        .all(&db)
        .await?;
    let total = Entity::find().filter(filters).count(&db).await?;
    let rows = rows
        .into_iter()
        .map(deal_json)
        .collect::<Result<Vec<_>, DbErr>>()?;
    let (data, has_more, next) = cut(rows, limit);
    let data = hydrate(&caller.db, "opportunity", data, None).await?;
    Ok(page(
        data,
        i64::try_from(total).unwrap_or(i64::MAX),
        has_more,
        next,
    ))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let scope = caller.scope(OPPORTUNITIES_SCOPE_ALL);
        let Some(row) = live_with_company(&caller, &id, scope.as_deref()).await? else {
            return Ok(ApiError::not_found("Opportunity", Some(&id)).into_response());
        };
        let row = hydrate_one(&caller.db, "opportunity", Some(row)).await?;
        Ok(Data(row.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to fetch opportunity")
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        read_body(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let created = match create_opportunity(&caller.db, &data, Some(&caller.user_id)).await {
            Ok(created) => created,
            Err(error) if error.message() == "ownerId required" => {
                return Ok(ApiError::bad_request(error.message()).into_response());
            }
            Err(error) => return Err(error.into()),
        };
        sync_values_for_entity(
            &caller.db,
            "opportunity",
            &created.id,
            data.get("customFields"),
        )
        .await;
        caller.publish(
            &state,
            OPPORTUNITY_CREATED,
            &created.id,
            &created.event_data,
        );
        Ok(Created(json!({ "id": created.id })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to create opportunity")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        read_body(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    answer(
        run_update(&state, &caller, &id, &data).await,
        LOG,
        "Failed to update opportunity",
    )
}

fn event_of(action: &str) -> EventName {
    match action {
        "stage_changed" => OPPORTUNITY_STAGE_CHANGED,
        "won" => OPPORTUNITY_WON,
        "lost" => OPPORTUNITY_LOST,
        _ => OPPORTUNITY_UPDATED,
    }
}

async fn run_update(
    state: &CrmState,
    caller: &Caller,
    id: &str,
    data: &Map<String, Value>,
) -> Answer {
    let scope = caller.scope(OPPORTUNITIES_SCOPE_ALL);
    let Some(existing) = live_opportunity(&caller.db, id, scope.as_deref()).await? else {
        return Ok(ApiError::not_found("Opportunity", Some(id)).into_response());
    };
    let mut update = build_update_payload(data)?;
    let mut target = None;
    if let Some(Value::String(stage_id)) = data.get("stageId")
        && existing.get("stageId").and_then(Value::as_str) != Some(stage_id.as_str())
    {
        let Some(flags) = load_stage(&caller.db, stage_id).await? else {
            return Ok(ApiError::bad_request("Unknown pipeline stage").into_response());
        };
        if !data.contains_key("stage") {
            update.insert("stage".into(), json!(flags.id));
        }
        target = Some(flags);
    }
    sync_status_with_stage(&caller.db, &existing, data, &mut update, target.as_ref()).await?;
    if let Some(Value::String(customer_id)) = data.get("customerId")
        && existing.get("customerId").and_then(Value::as_str) != Some(customer_id.as_str())
    {
        match lookup_company_name(&caller.db, Some(customer_id)).await? {
            Some(name) => {
                update.insert("customerName".into(), json!(name));
            }
            // `update.customerName = undefined`: left out of the `set`.
            None => {
                update.remove("customerName");
            }
        }
    }
    OPPORTUNITIES
        .update(
            &orm(&caller.db),
            id,
            set_values(&CRM_OPPORTUNITIES, &update),
            true,
        )
        .await?;
    sync_values_for_entity(&caller.db, "opportunity", id, data.get("customFields")).await;
    for event in opportunity_update_events(id, &existing, &update) {
        caller.publish(state, event_of(event.action), id, &event.data);
    }
    Ok(Data(json!({ "id": id })).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let scope = caller.scope(OPPORTUNITIES_SCOPE_ALL);
        let Some(existing) = live_opportunity(&caller.db, &id, scope.as_deref()).await? else {
            return Ok(ApiError::not_found("Opportunity", Some(&id)).into_response());
        };
        let at = utc_now();
        crm_opportunities::Entity::update_many()
            .col_expr(crm_opportunities::Column::DeletedAt, Expr::value(at))
            .col_expr(crm_opportunities::Column::UpdatedAt, Expr::value(at))
            .filter(crm_opportunities::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        let amount = match existing.get("amount") {
            Some(value) if !value.is_null() => value.clone(),
            _ => json!("0"),
        };
        caller.publish(
            &state,
            OPPORTUNITY_DELETED,
            &id,
            &json!({
                "id": id,
                "name": existing.get("name"),
                "amount": amount,
                "stage": existing.get("stage"),
                "status": existing.get("status"),
                "customerId": existing.get("customerId"),
            }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete opportunity")
}
