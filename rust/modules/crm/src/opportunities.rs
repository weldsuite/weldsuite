//! `/api/opportunities` (`routes/opportunities/index.ts`): deals in
//! `crm_opportunities`. Without `opportunities:scope:all` a caller sees
//! only the deals they own.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
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
use weldsuite_crm_domain::{drizzle_row, opportunity_json, update_sql};
use weldsuite_kit::validation::Issues;
use weldsuite_kit::{ApiError, Created, Data, NoContent};

use crate::schema::{self, Kind, NULLISH, OPT, REQ, STRINGS, Spec, int, partial, refine, s};
use crate::{
    Answer, Caller, CrmState, Refusal, answer, cut, js_limit, now, page, query_map, validate,
};

const LOG: &str = "opportunities";

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

/// A deal with `companyDeleted`, within the owner scope.
async fn live_with_company(
    caller: &Caller,
    id: &str,
    scope: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        opportunity_json!("t"),
        " || jsonb_build_object('company_deleted',
               coalesce(t.customer_id, '') <> '' and (c.id is null or c.deleted_at is not null))
         from crm_opportunities t left join companies c on c.id = t.customer_id
         where t.id = $1 and t.deleted_at is null and ($2::text is null or t.owner_id = $2)
         limit 1"
    ))
    .bind(id)
    .bind(scope)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(drizzle_row))
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
    let person = param("personId").map(|p| json!([p]));
    let search = param("search").map(|s| format!("%{s}%"));
    let mut cursor: Option<(String, String)> = None;
    if let Some(id) = param("cursor") {
        cursor = sqlx::query_as(
            "select to_char(date_trunc('milliseconds', created_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
             from crm_opportunities where id = $1 limit 1",
        )
        .bind(id)
        .fetch_optional(&caller.db)
        .await
        .map_err(|e| Refusal::Failed(e.to_string()))?;
    }
    let limit = limit.ok_or_else(|| Refusal::Failed("limit is NaN".to_owned()))?;
    let (cursor_at, cursor_id) = cursor.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        opportunity_json!("t"),
        " || jsonb_build_object('company_deleted',
               coalesce(t.customer_id, '') <> '' and (c.id is null or c.deleted_at is not null))
         from crm_opportunities t left join companies c on c.id = t.customer_id
         where t.deleted_at is null
           and ($1::text is null or t.owner_id = $1)
           and ($2::text is null or t.status = $2)
           and ($3::text is null or t.stage = $3)
           and ($4::text is null or t.pipeline = $4)
           and ($5::text is null or t.owner_id = $5)
           and ($6::text is null or t.customer_id = $6)
           and ($7::text[] is null or t.customer_id = any($7))
           and ($8::jsonb is null or t.person_ids @> $8 or t.contact_ids @> $8)
           and ($9::text is null or t.name like $9 or t.customer_name like $9 or t.description like $9)
           and ($10::timestamp is null
                or t.created_at < $10::timestamp or (t.created_at = $10::timestamp and t.id < $11))
         order by t.created_at desc, t.id desc
         limit $12"
    ))
    .bind(&scope)
    .bind(param("status"))
    .bind(param("stage"))
    .bind(param("pipeline"))
    .bind(param("ownerId"))
    .bind(param("customerId"))
    .bind(&customer_ids)
    .bind(&person)
    .bind(&search)
    .bind(&cursor_at)
    .bind(&cursor_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from crm_opportunities t
         where t.deleted_at is null
           and ($1::text is null or t.owner_id = $1)
           and ($2::text is null or t.status = $2)
           and ($3::text is null or t.stage = $3)
           and ($4::text is null or t.pipeline = $4)
           and ($5::text is null or t.owner_id = $5)
           and ($6::text is null or t.customer_id = $6)
           and ($7::text[] is null or t.customer_id = any($7))
           and ($8::jsonb is null or t.person_ids @> $8 or t.contact_ids @> $8)
           and ($9::text is null or t.name like $9 or t.customer_name like $9 or t.description like $9)",
    )
    .bind(&scope)
    .bind(param("status"))
    .bind(param("stage"))
    .bind(param("pipeline"))
    .bind(param("ownerId"))
    .bind(param("customerId"))
    .bind(&customer_ids)
    .bind(&person)
    .bind(&search)
    .fetch_one(&caller.db)
    .await?;
    let (data, has_more, next) = cut(rows.into_iter().map(drizzle_row).collect(), limit);
    let data = hydrate(&caller.db, "opportunity", data, None).await?;
    Ok(page(data, total, has_more, next))
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
    sqlx::query(update_sql!(
        crm_opportunities,
        "where t.id = $1 and t.deleted_at is null"
    ))
    .bind(id)
    .bind(CRM_OPPORTUNITIES.set(&update))
    .execute(&caller.db)
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
        sqlx::query(
            "update crm_opportunities set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
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
