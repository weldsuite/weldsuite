//! `/api/leads` (`routes/leads/index.ts`): leads in `crm_leads`, with
//! qualify and convert. Without `leads:scope:all` a caller sees only the
//! leads they own.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    COMPANY_CREATED, LEAD_CONVERTED, LEAD_CREATED, LEAD_DELETED, LEAD_QUALIFIED, LEAD_UPDATED,
    OPPORTUNITY_CREATED,
};
use weldsuite_catalogs::permission_keys::LEADS_SCOPE_ALL;
use weldsuite_crm_domain::leads::{create_lead, js_truthy, lead_event_fields};
use weldsuite_crm_domain::tables::{CRM_LEADS, CRM_OPPORTUNITIES, PARTIES};
use weldsuite_crm_domain::{drizzle_row, insert_sql, update_sql};
use weldsuite_kit::validation::js_trim;
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::schema::{Kind, NULLISH, OPT, REQ, STRINGS, Spec, extend, int, partial, s};
use crate::{
    Answer, Caller, CrmState, Refusal, answer, cut, js_limit, now, page, query_map, validate_specs,
};

const LOG: &str = "leads";

/// `createLeadSchema`.
const CREATE: [Spec; 25] = [
    Spec::new("firstName", s(None, None), OPT),
    Spec::new("lastName", s(None, None), OPT),
    Spec::new("email", Kind::Email, REQ),
    Spec::new("companyName", s(None, None), OPT),
    Spec::new("title", s(None, None), OPT),
    Spec::new("phone", s(None, None), OPT),
    Spec::new("mobile", s(None, None), OPT),
    Spec::new("website", s(None, None), OPT),
    Spec::new("address", Kind::Unknown, OPT),
    Spec::new("source", s(None, None), OPT),
    Spec::new("channel", s(None, None), OPT),
    Spec::new("campaign", s(None, None), OPT),
    Spec::new("medium", s(None, None), OPT),
    Spec::new("status", s(None, None), OPT),
    Spec::new("rating", s(None, None), OPT),
    Spec::new("score", int(None, None), OPT),
    Spec::new("ownerId", s(None, None), NULLISH),
    Spec::new("productInterest", STRINGS, OPT),
    Spec::new("budget", Kind::Unknown, OPT),
    Spec::new("timeline", s(None, None), OPT),
    Spec::new("authority", Kind::Bool, OPT),
    Spec::new("need", s(None, None), OPT),
    Spec::new("notes", s(None, None), OPT),
    Spec::new("nextAction", s(None, None), OPT),
    // `.extend({ email: z.string().email().optional() })` of the update.
    Spec::new("email", Kind::Email, OPT),
];

fn create_schema() -> &'static [Spec] {
    &CREATE[..24]
}

/// `updateLeadSchema`: partial, with an optional email.
fn update_schema() -> Vec<Spec> {
    extend(&partial(create_schema()), &CREATE[24..])
}

/// `convertLeadSchema`.
const CONVERT: [Spec; 2] = [
    Spec::new("createCustomer", Kind::Bool, OPT).with_default("true"),
    Spec::new("createOpportunity", Kind::Bool, OPT).with_default("false"),
];

async fn live(
    caller: &Caller,
    id: &str,
    scope: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_leads t
         where id = $1 and deleted_at is null and ($2::text is null or owner_id = $2) limit 1",
    )
    .bind(id)
    .bind(scope)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(drizzle_row))
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(
        run_list(&caller, query.as_deref()).await,
        LOG,
        "Failed to list leads",
    )
}

async fn run_list(caller: &Caller, query: Option<&str>) -> Answer {
    let q = query_map(query);
    let limit = js_limit(q.get("limit"), 25, 100);
    let scope = caller.scope(LEADS_SCOPE_ALL);
    let param = |key: &str| q.get(key).filter(|v| !v.is_empty()).cloned();
    let mut cursor: Option<(String, String)> = None;
    if let Some(id) = param("cursor") {
        cursor = sqlx::query_as(
            "select to_char(date_trunc('milliseconds', created_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
             from crm_leads where id = $1 limit 1",
        )
        .bind(id)
        .fetch_optional(&caller.db)
        .await
        .map_err(|e| Refusal::Failed(e.to_string()))?;
    }
    let limit = limit.ok_or_else(|| Refusal::Failed("limit is NaN".to_owned()))?;
    // `q.isQualified !== undefined`: any value filters, `'true'` for true.
    let qualified = q.get("isQualified").map(|v| v == "true");
    let search = param("search").map(|s| format!("%{s}%"));
    // The conditions in TypeScript's order; with a cursor given, the count
    // drops the last one (`conditions.slice(0, -1)`), found or not.
    let mut on = [
        scope.is_some(),
        param("status").is_some(),
        param("source").is_some(),
        param("rating").is_some(),
        param("ownerId").is_some(),
        qualified.is_some(),
        search.is_some(),
    ];
    let page_on = on;
    let cursor_given = param("cursor").is_some();
    if cursor_given
        && cursor.is_none()
        && let Some(last) = on.iter().rposition(|f| *f)
    {
        on[last] = false;
    }
    // `isNull(deletedAt)` comes first; it is the one dropped when nothing
    // else is on.
    let deleted_on = !(cursor_given && cursor.is_none() && page_on.iter().all(|f| !*f));
    let (cursor_at, cursor_id) = cursor.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_leads t
         where deleted_at is null
           and ($1::text is null or owner_id = $1)
           and ($2::text is null or status = $2)
           and ($3::text is null or source = $3)
           and ($4::text is null or rating = $4)
           and ($5::text is null or owner_id = $5)
           and ($6::bool is null or is_qualified = $6)
           and ($7::text is null or email like $7 or full_name like $7 or company_name like $7
                or first_name like $7 or last_name like $7)
           and ($8::timestamp is null
                or created_at < $8::timestamp or (created_at = $8::timestamp and id < $9))
         order by created_at desc, id desc
         limit $10",
    )
    .bind(&scope)
    .bind(param("status"))
    .bind(param("source"))
    .bind(param("rating"))
    .bind(param("ownerId"))
    .bind(qualified)
    .bind(&search)
    .bind(&cursor_at)
    .bind(&cursor_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from crm_leads
         where (not $8 or deleted_at is null)
           and (not $9 or owner_id = $1)
           and (not $10 or status = $2)
           and (not $11 or source = $3)
           and (not $12 or rating = $4)
           and (not $13 or owner_id = $5)
           and (not $14 or is_qualified = $6::bool)
           and (not $15 or email like $7 or full_name like $7 or company_name like $7
                or first_name like $7 or last_name like $7)",
    )
    .bind(&scope)
    .bind(param("status"))
    .bind(param("source"))
    .bind(param("rating"))
    .bind(param("ownerId"))
    .bind(qualified)
    .bind(&search)
    .bind(deleted_on)
    .bind(on[0])
    .bind(on[1])
    .bind(on[2])
    .bind(on[3])
    .bind(on[4])
    .bind(on[5])
    .bind(on[6])
    .fetch_one(&caller.db)
    .await?;
    let (data, has_more, next) = cut(rows.into_iter().map(drizzle_row).collect(), limit);
    Ok(page(data, total, has_more, next))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let scope = caller.scope(LEADS_SCOPE_ALL);
        Ok(match live(&caller, &id, scope.as_deref()).await? {
            Some(row) => Data(row).into_response(),
            None => ApiError::not_found("Lead", Some(&id)).into_response(),
        })
    }
    .await;
    answer(result, LOG, "Failed to fetch lead")
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, create_schema()) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let created = create_lead(&caller.db, &data, Some(&caller.user_id)).await?;
        caller.publish(&state, LEAD_CREATED, &created.id, &created.event_data);
        Ok(Created(json!({ "id": created.id })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to create lead")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, &update_schema()) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    answer(
        run_update(&state, &caller, &id, &data).await,
        LOG,
        "Failed to update lead",
    )
}

async fn run_update(
    state: &CrmState,
    caller: &Caller,
    id: &str,
    data: &Map<String, Value>,
) -> Answer {
    let scope = caller.scope(LEADS_SCOPE_ALL);
    let Some(existing) = live(caller, id, scope.as_deref()).await? else {
        return Ok(ApiError::not_found("Lead", Some(id)).into_response());
    };
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    for (key, value) in data {
        update.insert(key.clone(), value.clone());
    }
    if data.contains_key("firstName") || data.contains_key("lastName") {
        // `data.x ?? existing.x ?? ''`
        let name = |key: &str| -> String {
            data.get(key)
                .and_then(Value::as_str)
                .or_else(|| existing.get(key).and_then(Value::as_str))
                .unwrap_or_default()
                .to_owned()
        };
        let full = format!("{} {}", name("firstName"), name("lastName"));
        let full = js_trim(&full);
        update.insert(
            "fullName".into(),
            if full.is_empty() {
                Value::Null
            } else {
                json!(full)
            },
        );
    }
    sqlx::query(update_sql!(
        crm_leads,
        "where t.id = $1 and t.deleted_at is null"
    ))
    .bind(id)
    .bind(CRM_LEADS.set(&update))
    .execute(&caller.db)
    .await?;
    let mut merged = object(&existing);
    for (key, value) in &update {
        merged.insert(key.clone(), value.clone());
    }
    let mut event = lead_event_fields(&merged);
    event.insert("id".into(), json!(id));
    let pick = |key: &str, fallback: &str| -> Value {
        let value = match update.get(key) {
            Some(value) if !value.is_null() => Some(value),
            _ => existing.get(key),
        };
        if js_truthy(value) {
            value.cloned().unwrap_or(Value::Null)
        } else {
            json!(fallback)
        }
    };
    event.insert("email".into(), pick("email", ""));
    event.insert("status".into(), pick("status", "new"));
    caller.publish(state, LEAD_UPDATED, id, &Value::Object(event));
    Ok(Data(json!({ "id": id })).into_response())
}

/// `existing.x ?? fallback` of a row.
fn or_default(row: &Value, key: &str, fallback: &str) -> Value {
    match row.get(key) {
        Some(value) if !value.is_null() => value.clone(),
        _ => json!(fallback),
    }
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let scope = caller.scope(LEADS_SCOPE_ALL);
        let Some(existing) = live(&caller, &id, scope.as_deref()).await? else {
            return Ok(ApiError::not_found("Lead", Some(&id)).into_response());
        };
        sqlx::query(
            "update crm_leads set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        caller.publish(
            &state,
            LEAD_DELETED,
            &id,
            &json!({
                "id": id,
                "email": or_default(&existing, "email", ""),
                "status": or_default(&existing, "status", "new"),
            }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete lead")
}

// ── POST /:id/qualify ───────────────────────────────────────────────────────

pub(crate) async fn qualify(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let scope = caller.scope(LEADS_SCOPE_ALL);
        let Some(existing) = live(&caller, &id, scope.as_deref()).await? else {
            return Ok(ApiError::not_found("Lead", Some(&id)).into_response());
        };
        sqlx::query(
            "update crm_leads set is_qualified = true, qualified_at = $2::timestamp,
                 status = 'qualified', updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        caller.publish(
            &state,
            LEAD_QUALIFIED,
            &id,
            &json!({ "id": id, "email": or_default(&existing, "email", ""), "status": "qualified" }),
        );
        Ok(Data(json!({ "id": id, "isQualified": true, "status": "qualified" })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to qualify lead")
}

// ── POST /:id/convert ───────────────────────────────────────────────────────

pub(crate) async fn convert(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let options = match validate_specs(&headers, &body, &CONVERT) {
        Ok(options) => options,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    answer(
        run_convert(&state, &caller, &id, &options).await,
        LOG,
        "Failed to convert lead",
    )
}

async fn run_convert(
    state: &CrmState,
    caller: &Caller,
    id: &str,
    options: &Map<String, Value>,
) -> Answer {
    let scope = caller.scope(LEADS_SCOPE_ALL);
    let Some(lead) = live(caller, id, scope.as_deref()).await? else {
        return Ok(ApiError::not_found("Lead", Some(id)).into_response());
    };
    let now = now();
    let flag = |key: &str| options.get(key).and_then(Value::as_bool).unwrap_or(false);
    let text = |key: &str| lead.get(key).and_then(Value::as_str).map(str::to_owned);
    let owner = text("ownerId").unwrap_or_else(|| caller.user_id.clone());
    let mut customer_id: Option<String> = None;
    let mut opportunity_id: Option<String> = None;
    if flag("createCustomer") {
        let party_id = generate_id("pty");
        let kind = if js_truthy(lead.get("companyName")) {
            "company"
        } else {
            "person"
        };
        let mut values = Map::new();
        values.insert("id".into(), json!(party_id));
        values.insert("kind".into(), json!(kind));
        values.insert("role".into(), json!("customer"));
        if let Some(address) = lead.get("address") {
            values.insert("billingAddress".into(), address.clone());
        }
        values.insert("status".into(), json!("prospect"));
        values.insert("ownerId".into(), json!(owner));
        values.insert("createdAt".into(), json!(now));
        values.insert("updatedAt".into(), json!(now));
        sqlx::query(insert_sql!(parties))
            .bind(PARTIES.values(&values))
            .execute(&caller.db)
            .await?;
        customer_id = Some(party_id);
    }
    // `lead.fullName ?? lead.email`
    let full_or_email = text("fullName").or_else(|| text("email"));
    if flag("createOpportunity")
        && let Some(customer) = &customer_id
    {
        let deal_id = generate_id("opp");
        let budget = lead.get("budget");
        let amount = budget
            .and_then(|b| b.get("amount"))
            .filter(|a| js_truthy(Some(a)))
            .map_or_else(|| json!("0"), |a| json!(js_string_of(a)));
        let currency = budget
            .and_then(|b| b.get("currency"))
            .filter(|c| !c.is_null())
            .cloned()
            .unwrap_or(json!("EUR"));
        let mut values = Map::new();
        values.insert("id".into(), json!(deal_id));
        values.insert(
            "name".into(),
            json!(format!(
                "Opportunity from {}",
                full_or_email
                    .clone()
                    .unwrap_or_else(|| "undefined".to_owned())
            )),
        );
        values.insert("customerId".into(), json!(customer));
        values.insert("amount".into(), amount);
        values.insert("currency".into(), currency);
        values.insert("stage".into(), json!("prospecting"));
        values.insert("status".into(), json!("open"));
        values.insert("ownerId".into(), json!(owner));
        for (to, from) in [("leadSource", "source"), ("campaign", "campaign")] {
            if let Some(value) = lead.get(from) {
                values.insert(to.into(), value.clone());
            }
        }
        values.insert("createdAt".into(), json!(now));
        values.insert("updatedAt".into(), json!(now));
        sqlx::query(insert_sql!(crm_opportunities))
            .bind(CRM_OPPORTUNITIES.values(&values))
            .execute(&caller.db)
            .await?;
        opportunity_id = Some(deal_id);
    }
    sqlx::query(
        "update crm_leads set status = 'converted', converted_at = $2::timestamp,
             converted_to_customer_id = $3, converted_to_opportunity_id = $4,
             updated_at = $2::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(&now)
    .bind(&customer_id)
    .bind(&opportunity_id)
    .execute(&caller.db)
    .await?;
    caller.publish(
        state,
        LEAD_CONVERTED,
        id,
        &json!({ "id": id, "email": or_default(&lead, "email", ""), "status": "converted" }),
    );
    if let Some(customer) = &customer_id {
        let name = text("companyName")
            .or_else(|| text("fullName"))
            .or_else(|| text("email"))
            .unwrap_or_default();
        caller.publish(
            state,
            COMPANY_CREATED,
            customer,
            &json!({ "id": customer, "name": name }),
        );
    }
    if let Some(deal) = &opportunity_id {
        caller.publish(
            state,
            OPPORTUNITY_CREATED,
            deal,
            &json!({
                "id": deal,
                "name": format!("Opportunity from {}", full_or_email.clone().unwrap_or_default()),
                "amount": "0",
                "stage": "prospecting",
                "status": "open",
                "customerId": customer_id,
            }),
        );
    }
    let mut body = Map::new();
    body.insert("leadId".into(), json!(id));
    if let Some(customer) = customer_id {
        body.insert("customerId".into(), json!(customer));
    }
    if let Some(deal) = opportunity_id {
        body.insert("opportunityId".into(), json!(deal));
    }
    Ok(Data(Value::Object(body)).into_response())
}

/// `String(value)` of a JSON value.
fn js_string_of(value: &Value) -> String {
    weldsuite_crm_domain::js::js_string(&weldsuite_crm_domain::js::Js::from_jsonb(value))
}
