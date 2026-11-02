//! WeldCRM's objects: `/v1/people`, `/v1/companies`, `/v1/leads`,
//! `/v1/opportunities`, `/v1/pipelines`, `/v1/pipeline-stages`,
//! `/v1/activities` and `/v1/quotes` (`routes/v1/<object>/index.ts`), over
//! the CRM's tables with the client packages' schemas.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    ACTIVITY_COMPLETED, ACTIVITY_CREATED, ACTIVITY_DELETED, ACTIVITY_UPDATED, COMPANY_CREATED,
    COMPANY_DELETED, COMPANY_UPDATED, LEAD_CREATED, LEAD_DELETED, LEAD_UPDATED,
    OPPORTUNITY_CREATED, OPPORTUNITY_DELETED, OPPORTUNITY_LOST, OPPORTUNITY_STAGE_CHANGED,
    OPPORTUNITY_UPDATED, OPPORTUNITY_WON, PERSON_CREATED, PERSON_DELETED, PERSON_UPDATED,
    PIPELINE_CREATED, PIPELINE_DELETED, PIPELINE_STAGE_CREATED, PIPELINE_STAGE_DELETED,
    PIPELINE_STAGE_UPDATED, PIPELINE_UPDATED,
};
use weldsuite_kit::id::generate_id;
use weldsuite_kit::validation::js_trim;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, Fail, changes, created, dates, field, field_or, flag, get_live, like,
    live_or_404, no_content, now, ok, page, pick, soft_delete, table_list_sql, text, to_date,
    with_id, with_updated,
};
use crate::schemas::{CREATE_QUOTE, LIST_QUOTES, UPDATE_QUOTE};
use crate::schemas_gen::{
    CREATE_ACTIVITY, CREATE_COMPANY, CREATE_LEAD, CREATE_OPPORTUNITY, CREATE_PERSON,
    CREATE_PIPELINE, CREATE_PIPELINE_STAGE, LIST_ACTIVITIES, LIST_COMPANIES, LIST_LEADS,
    LIST_OPPORTUNITIES, LIST_PEOPLE, LIST_PIPELINE_STAGES, LIST_PIPELINES, UPDATE_ACTIVITY,
    UPDATE_COMPANY, UPDATE_LEAD, UPDATE_OPPORTUNITY, UPDATE_PERSON, UPDATE_PIPELINE,
    UPDATE_PIPELINE_STAGE,
};
use crate::session::{bad_request, internal_with, not_found};
use crate::tables_gen::{
    COMPANIES, CRM_ACTIVITIES, CRM_LEADS, CRM_OPPORTUNITIES, CRM_PIPELINE_STAGES, CRM_PIPELINES,
    CRM_QUOTES, PEOPLE,
};
use crate::zod;

type S = State<ExternalApiState>;

/// The CRM's routes, each behind its scope.
#[allow(clippy::too_many_lines)] // one route table
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/people",
            get(list_people)
                .route_layer(scope!("people:read"))
                .merge(axum::routing::post(create_person).route_layer(scope!("people:write"))),
        )
        .route(
            "/people/{id}",
            get(get_person).route_layer(scope!("people:read")).merge(
                axum::routing::patch(update_person)
                    .delete(delete_person)
                    .route_layer(scope!("people:write")),
            ),
        )
        .route(
            "/companies",
            get(list_companies)
                .route_layer(scope!("companies:read"))
                .merge(axum::routing::post(create_company).route_layer(scope!("companies:write"))),
        )
        .route(
            "/companies/{id}",
            get(get_company)
                .route_layer(scope!("companies:read"))
                .merge(
                    axum::routing::patch(update_company)
                        .delete(delete_company)
                        .route_layer(scope!("companies:write")),
                ),
        )
        .route(
            "/leads",
            get(list_leads)
                .route_layer(scope!("leads:read"))
                .merge(axum::routing::post(create_lead).route_layer(scope!("leads:write"))),
        )
        .route(
            "/leads/{id}",
            get(get_lead).route_layer(scope!("leads:read")).merge(
                axum::routing::patch(update_lead)
                    .delete(delete_lead)
                    .route_layer(scope!("leads:write")),
            ),
        )
        .route(
            "/opportunities",
            get(list_opportunities)
                .route_layer(scope!("opportunities:read"))
                .merge(
                    axum::routing::post(create_opportunity)
                        .route_layer(scope!("opportunities:write")),
                ),
        )
        .route(
            "/opportunities/{id}",
            get(get_opportunity)
                .route_layer(scope!("opportunities:read"))
                .merge(
                    axum::routing::patch(update_opportunity)
                        .delete(delete_opportunity)
                        .route_layer(scope!("opportunities:write")),
                ),
        )
        .route(
            "/pipelines",
            get(list_pipelines)
                .route_layer(scope!("pipelines:read"))
                .merge(axum::routing::post(create_pipeline).route_layer(scope!("pipelines:write"))),
        )
        .route(
            "/pipelines/{id}",
            get(get_pipeline)
                .route_layer(scope!("pipelines:read"))
                .merge(
                    axum::routing::patch(update_pipeline)
                        .delete(delete_pipeline)
                        .route_layer(scope!("pipelines:write")),
                ),
        )
        .route(
            "/pipeline-stages",
            get(list_stages)
                .route_layer(scope!("pipeline_stages:read"))
                .merge(
                    axum::routing::post(create_stage).route_layer(scope!("pipeline_stages:write")),
                ),
        )
        .route(
            "/pipeline-stages/{id}",
            get(get_stage)
                .route_layer(scope!("pipeline_stages:read"))
                .merge(
                    axum::routing::patch(update_stage)
                        .delete(delete_stage)
                        .route_layer(scope!("pipeline_stages:write")),
                ),
        )
        .route(
            "/activities",
            get(list_activities)
                .route_layer(scope!("activities:read"))
                .merge(
                    axum::routing::post(create_activity).route_layer(scope!("activities:write")),
                ),
        )
        .route(
            "/activities/{id}",
            get(get_activity)
                .route_layer(scope!("activities:read"))
                .merge(
                    axum::routing::patch(update_activity)
                        .delete(delete_activity)
                        .route_layer(scope!("activities:write")),
                ),
        )
        .route(
            "/quotes",
            get(list_quotes)
                .route_layer(scope!("quotes:read"))
                .merge(axum::routing::post(create_quote).route_layer(scope!("quotes:write"))),
        )
        .route(
            "/quotes/{id}",
            get(get_quote).route_layer(scope!("quotes:read")).merge(
                axum::routing::patch(update_quote)
                    .delete(delete_quote)
                    .route_layer(scope!("quotes:write")),
            ),
        )
}

/// A string field as JavaScript reads it: `None` for absent or null.
fn str_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// `[a, b].filter(Boolean).join(' ')`.
fn join_names(parts: &[Option<&str>]) -> String {
    parts
        .iter()
        .filter_map(|p| p.filter(|s| !s.is_empty()))
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const PEOPLE_LIST: (&str, &str) = table_list_sql!(
    people,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.display_name like $3->>'search' or t.full_name like $3->>'search' \
          or t.first_name like $3->>'search' or t.last_name like $3->>'search' or t.email like $3->>'search') \
     and ($3->>'status' is null or t.status = $3->>'status') \
     and ($3->>'ownerId' is null or t.owner_id = $3->>'ownerId') \
     and ($3->>'isSupplier' is null or t.is_supplier = ($3->>'isSupplier')::boolean) \
     and ($3->>'isLead' is null or t.is_lead = ($3->>'isLead')::boolean) \
     and ($3->>'companyId' is null or t.id in (select pc.person_id from person_companies pc \
          where pc.company_id = $3->>'companyId' and pc.ended_at is null)) \
     and ($3->>'listId' is null or t.id in (select lm.entity_id from list_members lm \
          where lm.list_id = $3->>'listId' and exists (select 1 from lists l \
          where l.id = $3->>'listId' and l.deleted_at is null and l.kind = 'person')))"
);

/// `deriveDisplayName` for people: the composed name, else the full name,
/// the email, or `Unnamed`.
fn person_display_name(
    first: Option<&str>,
    last: Option<&str>,
    full: Option<&str>,
    email: Option<&str>,
) -> String {
    let composed = join_names(&[first, last]);
    let composed = js_trim(&composed);
    if !composed.is_empty() {
        return composed.to_owned();
    }
    for candidate in [full, email].into_iter().flatten() {
        let trimmed = js_trim(candidate);
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    "Unnamed".to_owned()
}

fn person_event(id: &str, row: &Value) -> Value {
    pick(
        id,
        row,
        &[
            "firstName",
            "lastName",
            "fullName",
            "displayName",
            "email",
            "title",
        ],
    )
}

async fn list_people(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_PEOPLE, raw.as_deref())?;
    let filters = json!({
        "search": like(&q, "search"),
        "status": text(&q, "status"),
        "ownerId": text(&q, "ownerId"),
        "isSupplier": flag(&q, "isSupplier"),
        "isLead": flag(&q, "isLead"),
        "companyId": text(&q, "companyId"),
        "listId": text(&q, "listId"),
    });
    page(&caller.db, PEOPLE_LIST, &PEOPLE, &q, filters).await
}

async fn get_person(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &PEOPLE, "Person", &id).await
}

/// The body without `companyIds`, `primaryCompanyId` and `dateOfBirth`.
fn person_fields(body: &Map<String, Value>) -> (Map<String, Value>, Option<String>) {
    let mut rest = body.clone();
    rest.remove("companyIds");
    rest.remove("primaryCompanyId");
    let birth = rest
        .remove("dateOfBirth")
        .and_then(|v| v.as_str().map(str::to_owned));
    (rest, birth.filter(|s| !s.is_empty()))
}

async fn create_person(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_PERSON, &headers, &body)?;
    let (body, birth) = person_fields(&parsed.body);
    let stamp = now();
    let id = generate_id("person");
    let first = str_of(body.get("firstName"));
    let last = str_of(body.get("lastName"));
    let full = str_of(body.get("fullName"))
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| Some(join_names(&[first, last])).filter(|s| !s.is_empty()));
    let display = person_display_name(first, last, full.as_deref(), str_of(body.get("email")));
    let mut values = with_id(&body, &id, &stamp);
    if let Some(full) = &full {
        values.insert("fullName".into(), json!(full));
    }
    values.insert("displayName".into(), json!(display));
    if let Some(birth) = &birth {
        values.insert("dateOfBirth".into(), to_date(birth)?);
    }
    let row = PEOPLE
        .insert(
            &caller.db,
            &values,
            &["createdAt", "updatedAt", "dateOfBirth"],
        )
        .await?;
    caller.publish(&state.events, PERSON_CREATED, &id, person_event(&id, &row));
    created(row)
}

async fn update_person(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_PERSON, &headers, &body)?;
    let (body, birth) = person_fields(&parsed.body);
    let existing = live_or_404(&caller.db, &PEOPLE, "Person", &id).await?;
    let mut update = with_updated(&body, &now());
    if let Some(birth) = &birth {
        update.insert("dateOfBirth".into(), to_date(birth)?);
    }
    if ["firstName", "lastName", "fullName"]
        .iter()
        .any(|k| body.contains_key(*k))
    {
        let coalesce = |key: &str| -> Option<String> {
            match body.get(key) {
                Some(Value::Null) | None => str_of(existing.get(key)).map(str::to_owned),
                Some(value) => value.as_str().map(str::to_owned),
            }
        };
        let first = coalesce("firstName");
        let last = coalesce("lastName");
        let full = str_of(body.get("fullName"))
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                Some(join_names(&[first.as_deref(), last.as_deref()])).filter(|s| !s.is_empty())
            })
            .or_else(|| {
                str_of(existing.get("fullName"))
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            });
        if let Some(full) = &full {
            update.insert("fullName".into(), json!(full));
        }
        let email = coalesce("email");
        update.insert(
            "displayName".into(),
            json!(person_display_name(
                first.as_deref(),
                last.as_deref(),
                full.as_deref(),
                email.as_deref()
            )),
        );
    }
    let row = PEOPLE
        .patch(
            &caller.db,
            &id,
            &update,
            true,
            &["updatedAt", "dateOfBirth"],
        )
        .await?
        .ok_or_else(|| internal_with("Failed to update person"))?;
    caller.publish_changes(
        &state.events,
        PERSON_UPDATED,
        &id,
        person_event(&id, &row),
        changes(&existing, &update),
    );
    ok(row)
}

async fn delete_person(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    soft_delete(&caller.db, &PEOPLE, &id)
        .await?
        .ok_or_else(|| not_found("Person", &id))?;
    caller.publish(&state.events, PERSON_DELETED, &id, json!({ "id": id }));
    no_content()
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

const COMPANIES_LIST: (&str, &str) = table_list_sql!(
    companies,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.display_name like $3->>'search' or t.name like $3->>'search' \
          or t.trading_name like $3->>'search' or t.email like $3->>'search' or t.vat_number like $3->>'search') \
     and ($3->>'status' is null or t.status = $3->>'status') \
     and ($3->>'ownerId' is null or t.owner_id = $3->>'ownerId') \
     and ($3->>'industry' is null or t.industry = $3->>'industry') \
     and ($3->>'isSupplier' is null or t.is_supplier = ($3->>'isSupplier')::boolean) \
     and ($3->>'isLead' is null or t.is_lead = ($3->>'isLead')::boolean) \
     and ($3->>'listId' is null or t.id in (select lm.entity_id from list_members lm \
          where lm.list_id = $3->>'listId' and exists (select 1 from lists l \
          where l.id = $3->>'listId' and l.deleted_at is null and l.kind = 'company')))"
);

/// `deriveDisplayName` for companies: the trading name, the name, or
/// `Unnamed Company`.
fn company_display_name(name: Option<&str>, trading: Option<&str>) -> String {
    for candidate in [trading, name].into_iter().flatten() {
        let trimmed = js_trim(candidate);
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    "Unnamed Company".to_owned()
}

fn company_event(id: &str, row: &Value) -> Value {
    pick(id, row, &["name", "website", "industry"])
}

async fn list_companies(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_COMPANIES, raw.as_deref())?;
    let filters = json!({
        "search": like(&q, "search"),
        "status": text(&q, "status"),
        "ownerId": text(&q, "ownerId"),
        "industry": text(&q, "industry"),
        "isSupplier": flag(&q, "isSupplier"),
        "isLead": flag(&q, "isLead"),
        "listId": text(&q, "listId"),
    });
    page(&caller.db, COMPANIES_LIST, &COMPANIES, &q, filters).await
}

async fn get_company(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &COMPANIES, "Company", &id).await
}

async fn create_company(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_COMPANY, &headers, &body)?;
    let stamp = now();
    let id = generate_id("company");
    let display = company_display_name(
        str_of(parsed.get("name")),
        str_of(parsed.get("tradingName")),
    );
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    values.extend(parsed.body.clone());
    values.insert("displayName".into(), json!(display));
    let row = COMPANIES
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        COMPANY_CREATED,
        &id,
        company_event(&id, &row),
    );
    created(row)
}

async fn update_company(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_COMPANY, &headers, &body)?;
    let mut body = parsed.body.clone();
    body.remove("ifVersion");
    let existing = live_or_404(&caller.db, &COMPANIES, "Company", &id).await?;
    let mut update = with_updated(&body, &now());
    if body.contains_key("name") || body.contains_key("tradingName") {
        let coalesce = |key: &str| match body.get(key) {
            Some(Value::Null) | None => str_of(existing.get(key)),
            Some(value) => value.as_str(),
        };
        update.insert(
            "displayName".into(),
            json!(company_display_name(
                coalesce("name"),
                coalesce("tradingName")
            )),
        );
    }
    let row = COMPANIES
        .patch(
            &caller.db,
            &id,
            &update,
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| internal_with("Failed to update company"))?;
    caller.publish_changes(
        &state.events,
        COMPANY_UPDATED,
        &id,
        company_event(&id, &row),
        changes(&existing, &update),
    );
    ok(row)
}

async fn delete_company(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    soft_delete(&caller.db, &COMPANIES, &id)
        .await?
        .ok_or_else(|| not_found("Company", &id))?;
    caller.publish(&state.events, COMPANY_DELETED, &id, json!({ "id": id }));
    no_content()
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

const LEADS_LIST: (&str, &str) = table_list_sql!(
    crm_leads,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.email like $3->>'search' or t.full_name like $3->>'search' \
          or t.company_name like $3->>'search' or t.first_name like $3->>'search' or t.last_name like $3->>'search') \
     and ($3->>'status' is null or t.status = $3->>'status') \
     and ($3->>'source' is null or t.source = $3->>'source') \
     and ($3->>'rating' is null or t.rating = $3->>'rating') \
     and ($3->>'ownerId' is null or t.owner_id = $3->>'ownerId') \
     and ($3->>'isQualified' is null or t.is_qualified = ($3->>'isQualified')::boolean)"
);

fn lead_event(id: &str, row: &Value) -> Value {
    json!({
        "id": id,
        "email": field_or(row, "email", json!("")),
        "firstName": field(row, "firstName"),
        "lastName": field(row, "lastName"),
        "title": field(row, "title"),
        "status": field_or(row, "status", json!("new")),
        "source": field(row, "source"),
        "ownerId": field(row, "ownerId"),
    })
}

async fn list_leads(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_LEADS, raw.as_deref())?;
    let filters = json!({
        "search": like(&q, "search"),
        "status": text(&q, "status"),
        "source": text(&q, "source"),
        "rating": text(&q, "rating"),
        "ownerId": text(&q, "ownerId"),
        "isQualified": flag(&q, "isQualified"),
    });
    page(&caller.db, LEADS_LIST, &CRM_LEADS, &q, filters).await
}

async fn get_lead(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &CRM_LEADS, "Lead", &id).await
}

/// `a ?? b`: `a` unless absent or null.
fn or_else(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        Some(Value::Null) | None => fallback,
        Some(value) => value.clone(),
    }
}

async fn create_lead(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_LEAD, &headers, &body)?;
    let body = &parsed.body;
    let stamp = now();
    let id = generate_id("lead");
    let full = join_names(&[str_of(body.get("firstName")), str_of(body.get("lastName"))]);
    let mut values = body.clone();
    values.insert("id".into(), json!(id));
    if !full.is_empty() {
        values.insert("fullName".into(), json!(full));
    }
    values.insert("source".into(), or_else(body.get("source"), json!("other")));
    values.insert("status".into(), or_else(body.get("status"), json!("new")));
    values.insert("score".into(), or_else(body.get("score"), json!(0)));
    match or_else(
        body.get("ownerId"),
        caller
            .session
            .user_id
            .clone()
            .map_or(Value::Null, Value::String),
    ) {
        Value::Null => {
            values.remove("ownerId");
        }
        owner => {
            values.insert("ownerId".into(), owner);
        }
    }
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = CRM_LEADS
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(&state.events, LEAD_CREATED, &id, lead_event(&id, &row));
    created(row)
}

async fn update_lead(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_LEAD, &headers, &body)?;
    let body = &parsed.body;
    let existing = live_or_404(&caller.db, &CRM_LEADS, "Lead", &id).await?;
    let mut update = with_updated(body, &now());
    if body.contains_key("firstName") || body.contains_key("lastName") {
        let coalesce = |key: &str| match body.get(key) {
            Some(Value::Null) | None => str_of(existing.get(key)),
            Some(value) => value.as_str(),
        };
        let full = join_names(&[coalesce("firstName"), coalesce("lastName")]);
        if !full.is_empty() {
            update.insert("fullName".into(), json!(full));
        }
    }
    let row = CRM_LEADS
        .patch(
            &caller.db,
            &id,
            &update,
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| internal_with("Failed to update lead"))?;
    caller.publish(&state.events, LEAD_UPDATED, &id, lead_event(&id, &row));
    ok(row)
}

async fn delete_lead(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let row = soft_delete(&caller.db, &CRM_LEADS, &id)
        .await?
        .ok_or_else(|| not_found("Lead", &id))?;
    caller.publish(
        &state.events,
        LEAD_DELETED,
        &id,
        json!({
            "id": id,
            "email": field_or(&row, "email", json!("")),
            "status": field_or(&row, "status", json!("new")),
        }),
    );
    no_content()
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

const OPPORTUNITIES_LIST: (&str, &str) = table_list_sql!(
    crm_opportunities,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.name like $3->>'search' or t.customer_name like $3->>'search') \
     and ($3->>'status' is null or t.status = $3->>'status') \
     and ($3->>'stage' is null or t.stage = $3->>'stage') \
     and ($3->>'pipeline' is null or t.pipeline = $3->>'pipeline') \
     and ($3->>'ownerId' is null or t.owner_id = $3->>'ownerId') \
     and ($3->>'customerId' is null or t.customer_id = $3->>'customerId')"
);

const NUMERIC_FIELDS: [&str; 3] = ["amount", "expectedRevenue", "recurringRevenue"];
const OPPORTUNITY_DATES: [&str; 3] = ["closeDate", "startDate", "nextStepDate"];

/// `asText(value)` of a JSON scalar.
fn as_text(value: &Value) -> Value {
    match value {
        Value::String(_) => value.clone(),
        Value::Number(n) => json!(weldsuite_core_domain::js::number_text(
            n.as_f64().unwrap_or(f64::NAN)
        )),
        Value::Bool(b) => json!(b.to_string()),
        Value::Null => json!("null"),
        other => json!(other.to_string()),
    }
}

/// An opportunity's event data (`created` adds `pipelineId`).
fn opportunity_event(id: &str, row: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    for key in keys {
        let value = match *key {
            "amount" => field_or(row, "amount", json!("0")),
            "pipelineId" => field(row, "pipeline"),
            other => field(row, other),
        };
        out.insert((*key).to_owned(), value);
    }
    Value::Object(out)
}

const OPPORTUNITY_KEYS: [&str; 8] = [
    "name",
    "amount",
    "currency",
    "stage",
    "status",
    "customerId",
    "pipelineId",
    "ownerId",
];
const OPPORTUNITY_UPDATE_KEYS: [&str; 7] = [
    "name",
    "amount",
    "currency",
    "stage",
    "status",
    "customerId",
    "ownerId",
];

async fn list_opportunities(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_OPPORTUNITIES, raw.as_deref())?;
    let filters = json!({
        "search": like(&q, "search"),
        "status": text(&q, "status"),
        "stage": text(&q, "stage"),
        "pipeline": text(&q, "pipeline"),
        "ownerId": text(&q, "ownerId"),
        "customerId": text(&q, "customerId"),
    });
    page(
        &caller.db,
        OPPORTUNITIES_LIST,
        &CRM_OPPORTUNITIES,
        &q,
        filters,
    )
    .await
}

async fn get_opportunity(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &CRM_OPPORTUNITIES, "Opportunity", &id).await
}

async fn create_opportunity(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_OPPORTUNITY, &headers, &body)?;
    let body = &parsed.body;
    let owner = match body.get("ownerId") {
        Some(Value::String(owner)) => Some(owner.clone()),
        _ => caller.session.user_id.clone(),
    };
    let Some(owner) = owner else {
        return Err(bad_request("ownerId is required for workspace API keys").into());
    };
    let stamp = now();
    let id = generate_id("opp");
    let mut values = body.clone();
    values.insert("id".into(), json!(id));
    values.insert("ownerId".into(), json!(owner));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    for key in NUMERIC_FIELDS {
        if let Some(value) = values.get(key).filter(|v| !v.is_null()).cloned() {
            values.insert(key.into(), as_text(&value));
        }
    }
    let mut date_props = vec!["createdAt", "updatedAt"];
    for key in OPPORTUNITY_DATES {
        if let Some(Value::String(text)) = values.get(key).cloned() {
            values.insert(key.into(), to_date(&text)?);
            date_props.push(key);
        }
    }
    let amount = values
        .get("amount")
        .filter(|v| !v.is_null())
        .map_or(json!("0"), as_text);
    values.insert("amount".into(), amount);
    for (key, fallback) in [
        ("currency", json!("EUR")),
        ("stage", json!("prospecting")),
        ("status", json!("open")),
        ("probability", json!(0)),
        ("pipeline", json!("default")),
    ] {
        let value = or_else(values.get(key), fallback);
        values.insert(key.into(), value);
    }
    let row = CRM_OPPORTUNITIES
        .insert(&caller.db, &values, &date_props)
        .await?;
    caller.publish(
        &state.events,
        OPPORTUNITY_CREATED,
        &id,
        opportunity_event(&id, &row, &OPPORTUNITY_KEYS),
    );
    created(row)
}

async fn update_opportunity(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_OPPORTUNITY, &headers, &body)?;
    let existing = live_or_404(&caller.db, &CRM_OPPORTUNITIES, "Opportunity", &id).await?;
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    let mut date_props = vec!["updatedAt"];
    for (key, value) in &parsed.body {
        let value = if NUMERIC_FIELDS.contains(&key.as_str()) && !value.is_null() {
            as_text(value)
        } else if let (Some(prop), Value::String(text)) = (
            OPPORTUNITY_DATES.iter().find(|d| **d == key.as_str()),
            value,
        ) {
            if text.is_empty() {
                Value::Null
            } else {
                date_props.push(prop);
                to_date(text)?
            }
        } else {
            value.clone()
        };
        update.insert(key.clone(), value);
    }
    let row = CRM_OPPORTUNITIES
        .patch(&caller.db, &id, &update, true, &date_props)
        .await?
        .ok_or_else(|| internal_with("Failed to update opportunity"))?;
    let data = opportunity_event(&id, &row, &OPPORTUNITY_UPDATE_KEYS);
    caller.publish(&state.events, OPPORTUNITY_UPDATED, &id, data.clone());
    if row.get("stage") != existing.get("stage") {
        caller.publish(&state.events, OPPORTUNITY_STAGE_CHANGED, &id, data.clone());
    }
    if row.get("status") != existing.get("status") {
        match row.get("status").and_then(Value::as_str) {
            Some("won") => caller.publish(&state.events, OPPORTUNITY_WON, &id, data),
            Some("lost") => caller.publish(&state.events, OPPORTUNITY_LOST, &id, data),
            _ => {}
        }
    }
    ok(row)
}

async fn delete_opportunity(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let row = soft_delete(&caller.db, &CRM_OPPORTUNITIES, &id)
        .await?
        .ok_or_else(|| not_found("Opportunity", &id))?;
    caller.publish(
        &state.events,
        OPPORTUNITY_DELETED,
        &id,
        opportunity_event(
            &id,
            &row,
            &["name", "amount", "stage", "status", "customerId"],
        ),
    );
    no_content()
}

// ---------------------------------------------------------------------------
// Pipelines and their stages
// ---------------------------------------------------------------------------

const PIPELINES_LIST: (&str, &str) = table_list_sql!(
    crm_pipelines,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.name like $3->>'search') \
     and ($3->>'archived' is null or t.is_archived = ($3->>'archived')::boolean)"
);

async fn list_pipelines(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_PIPELINES, raw.as_deref())?;
    let archived = match q.get("archived").and_then(Value::as_str) {
        Some("active") => json!(false),
        Some("archived") => json!(true),
        _ => Value::Null,
    };
    let filters = json!({ "search": like(&q, "search"), "archived": archived });
    page(&caller.db, PIPELINES_LIST, &CRM_PIPELINES, &q, filters).await
}

async fn get_pipeline(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &CRM_PIPELINES, "Pipeline", &id).await
}

async fn create_pipeline(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_PIPELINE, &headers, &body)?;
    let stamp = now();
    let id = generate_id("pl");
    let values = with_id(&parsed.body, &id, &stamp);
    let row = CRM_PIPELINES
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        PIPELINE_CREATED,
        &id,
        pick(&id, &row, &["name"]),
    );
    created(row)
}

async fn update_pipeline(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_PIPELINE, &headers, &body)?;
    let update = with_updated(&parsed.body, &now());
    let row = CRM_PIPELINES
        .patch(
            &caller.db,
            &id,
            &update,
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("Pipeline", &id))?;
    caller.publish(
        &state.events,
        PIPELINE_UPDATED,
        &id,
        pick(&id, &row, &["name"]),
    );
    ok(row)
}

async fn delete_pipeline(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let row = soft_delete(&caller.db, &CRM_PIPELINES, &id)
        .await?
        .ok_or_else(|| not_found("Pipeline", &id))?;
    caller.publish(
        &state.events,
        PIPELINE_DELETED,
        &id,
        pick(&id, &row, &["name"]),
    );
    no_content()
}

const STAGES_LIST: (&str, &str) = table_list_sql!(
    crm_pipeline_stages,
    "t.deleted_at is null and ($3->>'pipeline' is null or t.pipeline = $3->>'pipeline')"
);

async fn list_stages(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_PIPELINE_STAGES, raw.as_deref())?;
    let filters = json!({ "pipeline": text(&q, "pipeline") });
    page(&caller.db, STAGES_LIST, &CRM_PIPELINE_STAGES, &q, filters).await
}

async fn get_stage(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &CRM_PIPELINE_STAGES, "Pipeline stage", &id).await
}

async fn create_stage(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_PIPELINE_STAGE, &headers, &body)?;
    let stamp = now();
    let id = generate_id("pls");
    let values = with_id(&parsed.body, &id, &stamp);
    let row = CRM_PIPELINE_STAGES
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        PIPELINE_STAGE_CREATED,
        &id,
        pick(&id, &row, &["name", "pipeline"]),
    );
    created(row)
}

async fn update_stage(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_PIPELINE_STAGE, &headers, &body)?;
    let update = with_updated(&parsed.body, &now());
    let row = CRM_PIPELINE_STAGES
        .patch(
            &caller.db,
            &id,
            &update,
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("Pipeline stage", &id))?;
    caller.publish(
        &state.events,
        PIPELINE_STAGE_UPDATED,
        &id,
        pick(&id, &row, &["name", "pipeline"]),
    );
    ok(row)
}

async fn delete_stage(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let row = soft_delete(&caller.db, &CRM_PIPELINE_STAGES, &id)
        .await?
        .ok_or_else(|| not_found("Pipeline stage", &id))?;
    caller.publish(
        &state.events,
        PIPELINE_STAGE_DELETED,
        &id,
        pick(&id, &row, &["name"]),
    );
    no_content()
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

const ACTIVITIES_LIST: (&str, &str) = table_list_sql!(
    crm_activities,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.subject like $3->>'search' or t.description like $3->>'search') \
     and ($3->>'type' is null or t.type = $3->>'type') \
     and ($3->>'status' is null or t.status = $3->>'status') \
     and ($3->>'assignedToId' is null or t.assigned_to_id = $3->>'assignedToId') \
     and ($3->>'customerId' is null or t.customer_id = $3->>'customerId') \
     and ($3->>'contactId' is null or t.contact_id = $3->>'contactId') \
     and ($3->>'leadId' is null or t.lead_id = $3->>'leadId') \
     and ($3->>'opportunityId' is null or t.opportunity_id = $3->>'opportunityId')"
);

const ACTIVITY_DATES: [&str; 4] = ["dueDate", "startTime", "endTime", "followUpDate"];

async fn list_activities(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_ACTIVITIES, raw.as_deref())?;
    let filters = json!({
        "search": like(&q, "search"),
        "type": text(&q, "type"),
        "status": text(&q, "status"),
        "assignedToId": text(&q, "assignedToId"),
        "customerId": text(&q, "customerId"),
        "contactId": text(&q, "contactId"),
        "leadId": text(&q, "leadId"),
        "opportunityId": text(&q, "opportunityId"),
    });
    page(&caller.db, ACTIVITIES_LIST, &CRM_ACTIVITIES, &q, filters).await
}

async fn get_activity(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &CRM_ACTIVITIES, "Activity", &id).await
}

fn activity_event(id: &str, row: &Value) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("id".into(), json!(id));
    for key in ["type", "subject", "status", "customerId", "contactId"] {
        data.insert(key.into(), field(row, key));
    }
    data.insert("assigneeId".into(), field(row, "assignedToId"));
    data
}

async fn create_activity(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_ACTIVITY, &headers, &body)?;
    let body = &parsed.body;
    let assigned = match body.get("assignedToId") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Null) | None => caller.session.user_id.clone(),
        Some(_) => None,
    };
    let Some(assigned) = assigned else {
        return Err(bad_request("assignedToId is required for workspace API keys").into());
    };
    let stamp = now();
    let id = generate_id("act");
    let mut values = body.clone();
    values.insert("id".into(), json!(id));
    values.insert("assignedToId".into(), json!(assigned));
    values.insert(
        "status".into(),
        or_else(body.get("status"), json!("planned")),
    );
    values.insert(
        "priority".into(),
        or_else(body.get("priority"), json!("medium")),
    );
    let mut date_props = vec!["createdAt", "updatedAt"];
    for key in ACTIVITY_DATES {
        match body
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            Some(text) => {
                values.insert(key.into(), to_date(text)?);
                date_props.push(key);
            }
            // `undefined` overrides the body's value: the column default.
            None => {
                values.remove(key);
            }
        }
    }
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = CRM_ACTIVITIES
        .insert(&caller.db, &values, &date_props)
        .await?;
    let mut data = activity_event(&id, &row);
    data.insert(
        "dueDate".into(),
        row.get("dueDate")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Null),
    );
    caller.publish(&state.events, ACTIVITY_CREATED, &id, Value::Object(data));
    created(row)
}

async fn update_activity(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_ACTIVITY, &headers, &body)?;
    let existing = live_or_404(&caller.db, &CRM_ACTIVITIES, "Activity", &id).await?;
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    let mut date_props = vec!["updatedAt"];
    for (key, value) in &parsed.body {
        let is_date = ACTIVITY_DATES.iter().find(|d| **d == key.as_str());
        match (is_date, value) {
            (Some(prop), Value::String(text)) => {
                update.insert(key.clone(), to_date(text)?);
                date_props.push(prop);
            }
            _ => {
                update.insert(key.clone(), value.clone());
            }
        }
    }
    let row = CRM_ACTIVITIES
        .patch(&caller.db, &id, &update, true, &date_props)
        .await?
        .ok_or_else(|| internal_with("Failed to update activity"))?;
    caller.publish(
        &state.events,
        ACTIVITY_UPDATED,
        &id,
        Value::Object(activity_event(&id, &row)),
    );
    if row.get("status").and_then(Value::as_str) == Some("completed")
        && existing.get("status").and_then(Value::as_str) != Some("completed")
    {
        caller.publish(
            &state.events,
            ACTIVITY_COMPLETED,
            &id,
            json!({ "id": id, "type": field(&row, "type") }),
        );
    }
    ok(row)
}

async fn delete_activity(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let row = soft_delete(&caller.db, &CRM_ACTIVITIES, &id)
        .await?
        .ok_or_else(|| not_found("Activity", &id))?;
    caller.publish(
        &state.events,
        ACTIVITY_DELETED,
        &id,
        pick(&id, &row, &["type", "customerId", "contactId"]),
    );
    no_content()
}

// ---------------------------------------------------------------------------
// Quotes (no entity events)
// ---------------------------------------------------------------------------

const QUOTES_LIST: (&str, &str) = table_list_sql!(
    crm_quotes,
    "t.deleted_at is null and ($3->>'search' is null or t.name like $3->>'search')"
);

async fn list_quotes(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_QUOTES, raw.as_deref())?;
    let filters = json!({ "search": like(&q, "search") });
    page(&caller.db, QUOTES_LIST, &CRM_QUOTES, &q, filters).await
}

async fn get_quote(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &CRM_QUOTES, "Quote", &id).await
}

/// `validFrom` / `validUntil` as `Date`s when set.
fn quote_dates(values: &mut Map<String, Value>, props: &mut Vec<&'static str>) -> Result<(), Fail> {
    for key in ["validFrom", "validUntil"] {
        if let Some(Value::String(text)) = values.get(key).cloned()
            && !text.is_empty()
        {
            values.insert(key.into(), to_date(&text)?);
            props.push(key);
        }
    }
    Ok(())
}

async fn create_quote(caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_QUOTE, &headers, &body)?;
    let stamp = now();
    let id = generate_id("quote");
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    values.extend(parsed.body.clone());
    let mut props = vec!["createdAt", "updatedAt"];
    quote_dates(&mut values, &mut props)?;
    let row = CRM_QUOTES.insert(&caller.db, &values, &props).await?;
    created(row)
}

async fn update_quote(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_QUOTE, &headers, &body)?;
    let mut update = with_updated(&parsed.body, &now());
    let mut props = vec!["updatedAt"];
    quote_dates(&mut update, &mut props)?;
    let row = CRM_QUOTES
        .patch(&caller.db, &id, &update, true, &props)
        .await?
        .ok_or_else(|| not_found("Quote", &id))?;
    ok(row)
}

async fn delete_quote(caller: Caller, Path(id): Path<String>) -> Answer {
    soft_delete(&caller.db, &CRM_QUOTES, &id)
        .await?
        .ok_or_else(|| not_found("Quote", &id))?;
    no_content()
}
