//! `/api/companies` import, the detail page aggregate, navigation and
//! refresh-logo (`routes/companies/index.ts`).

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{COMPANY_CREATED, COMPANY_UPDATED};
use weldsuite_catalogs::permission_keys::COMPANIES_SCOPE_ALL;
use weldsuite_crm_domain::DomainError;
use weldsuite_crm_domain::companies as service;
use weldsuite_crm_domain::drizzle_row;
use weldsuite_crm_domain::validation::StatusLookup;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text, js_trim, query_values};
use weldsuite_kit::{ApiError, Data};

use crate::companies::{EMPLOYEES_MESSAGE, WEBSITE_MESSAGE, company_event, is_employee_count};
use crate::identity_schema::{LIFECYCLE_STAGES, address, url_field, url_refine};
use crate::schema::{self, Kind, OPT, STRINGS, Spec, s};
use crate::{Answer, Caller, CrmState, answer, validate};

const LOG: &str = "companies";

/// `importCompanyRecordSchema`, up to `website`, then after `primaryAddress`.
const RECORD_HEAD: [Spec; 9] = [
    Spec::new("partyCode", s(None, Some(50)), OPT),
    Spec::new("name", s(None, Some(255)), OPT),
    Spec::new("tradingName", s(None, Some(255)), OPT),
    Spec::new("email", s(None, Some(255)), OPT),
    Spec::new("alternateEmails", STRINGS, OPT),
    Spec::new("phone", s(None, Some(50)), OPT),
    Spec::new("mobile", s(None, Some(50)), OPT),
    Spec::new("fax", s(None, Some(50)), OPT),
    Spec::new("website", s(None, Some(500)), OPT),
];

const RECORD_TAIL: [Spec; 21] = [
    Spec::new("vatNumber", s(None, Some(50)), OPT),
    Spec::new("registrationNumber", s(None, Some(100)), OPT),
    Spec::new("industry", s(None, Some(100)), OPT),
    Spec::new("employeeCount", s(None, Some(50)), OPT),
    Spec::new("status", s(None, Some(50)), OPT),
    Spec::new("lifecycleStage", s(None, Some(50)), OPT),
    Spec::new("segment", s(None, Some(50)), OPT),
    Spec::new("rating", s(None, Some(10)), OPT),
    Spec::new("source", s(None, Some(100)), OPT),
    Spec::new("linkedinUrl", s(None, Some(500)), OPT),
    Spec::new("twitterHandle", s(None, Some(100)), OPT),
    Spec::new("facebookUrl", s(None, Some(500)), OPT),
    Spec::new("preferredContactMethod", s(None, Some(20)), OPT),
    Spec::new("preferredLanguage", s(None, Some(10)), OPT),
    Spec::new("timezone", s(None, Some(50)), OPT),
    Spec::new("tags", STRINGS, OPT),
    Spec::new("notes", s(None, Some(10000)), OPT),
    Spec::new("internalNotes", s(None, Some(10000)), OPT),
    Spec::new("isSupplier", Kind::Bool, OPT),
    Spec::new("isLead", Kind::Bool, OPT),
    Spec::new("customFields", Kind::Record, OPT),
];

/// `importCompaniesSchema`.
fn import_body(issues: &mut Issues, body: &Map<String, Value>) -> Vec<Map<String, Value>> {
    issues
        .list(
            body,
            "records",
            Presence::Required,
            Some(1),
            Some(500),
            |issues, item| {
                let fields = issues.object(item)?.clone();
                let mut out = schema::read(issues, &fields, &RECORD_HEAD);
                address(
                    issues,
                    &fields,
                    "primaryAddress",
                    Presence::Optional,
                    &mut out,
                );
                out.extend(schema::read(issues, &fields, &RECORD_TAIL));
                Some(out)
            },
        )
        .into_option()
        .unwrap_or_default()
}

/// `normImport(s)`: trimmed, `''` for none.
fn norm(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(|s| js_trim(s).to_owned())
        .unwrap_or_default()
}

/// `v.trim().toLowerCase().replace(/[\s-]+/g, '_')`.
fn stage_key(text: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in text.to_lowercase().chars() {
        if c.is_whitespace() || c == '-' {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `validateImportRecord(rec, statuses)`: the cleaned record, or the row's
/// error (`importRecordValidationSchema`'s messages, an unknown status).
fn validate_record(
    record: &Map<String, Value>,
    statuses: &StatusLookup,
) -> Result<Map<String, Value>, String> {
    let trimmed = |key: &str| -> Option<String> {
        record.get(key).and_then(Value::as_str).and_then(|s| {
            let t = js_trim(s);
            (!t.is_empty()).then(|| t.to_owned())
        })
    };
    let mut errors: Vec<String> = Vec::new();
    let mut out = record.clone();
    let email = trimmed("email");
    if let Some(email) = &email {
        let probe: Map<String, Value> = [("email".to_owned(), json!(email))].into_iter().collect();
        let rules = Text {
            format: Some(Format::Email),
            ..Text::default()
        };
        if Issues::default()
            .text_with(&probe, "email", Presence::Optional, rules)
            .is_absent()
        {
            errors.push("Email must be a valid email address".to_owned());
        }
    }
    let website = trimmed("website");
    let mut normalized_site = None;
    if let Some(site) = &website {
        let probe: Map<String, Value> = [("website".to_owned(), json!(site))].into_iter().collect();
        let mut issues = Issues::default();
        let mut scratch = Map::new();
        url_field(&mut issues, &probe, "website", 500, &mut scratch);
        url_refine(
            &mut issues,
            &probe,
            "website",
            WEBSITE_MESSAGE,
            &mut scratch,
        );
        match issues.finish() {
            Ok(()) => normalized_site = scratch.get("website").cloned(),
            Err(invalid) => {
                for issue in invalid.issues() {
                    errors.push(issue["message"].as_str().unwrap_or_default().to_owned());
                }
            }
        }
    }
    let employees = trimmed("employeeCount");
    if let Some(count) = &employees {
        if count.encode_utf16().count() > 50 {
            errors.push("String must contain at most 50 character(s)".to_owned());
        }
        if !is_employee_count(count) {
            errors.push(EMPLOYEES_MESSAGE.to_owned());
        }
    }
    let stage = trimmed("lifecycleStage")
        .map(|s| stage_key(&s))
        .filter(|s| !s.is_empty());
    if let Some(stage) = &stage
        && !LIFECYCLE_STAGES.contains(&stage.as_str())
    {
        errors.push(format!(
            "Lifecycle stage must be one of: {}",
            LIFECYCLE_STAGES.join(", ")
        ));
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    // A key the record had is replaced by its parsed value, or dropped.
    for (key, value) in [
        ("email", email.map(Value::String)),
        ("website", normalized_site),
        ("employeeCount", employees.map(Value::String)),
        ("lifecycleStage", stage.map(Value::String)),
    ] {
        if record.contains_key(key) {
            match value {
                Some(value) => {
                    out.insert(key.to_owned(), value);
                }
                None => {
                    out.remove(key);
                }
            }
        }
    }
    let raw_status = norm(record.get("status"));
    if raw_status.is_empty() {
        out.remove("status");
    } else {
        match statuses.by_loose_name.get(&raw_status.to_lowercase()) {
            Some(key) => {
                out.insert("status".into(), json!(key));
            }
            None => return Err(format!("Unknown status \"{raw_status}\"")),
        }
    }
    Ok(out)
}

/// `indexImportedCompany`.
fn index(by_code: &mut HashMap<String, Value>, by_email: &mut HashMap<String, Value>, row: &Value) {
    if let Some(code) = row
        .get("partyCode")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
    {
        by_code.insert(code.to_owned(), row.clone());
    }
    if let Some(email) = row
        .get("email")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
    {
        by_email.insert(email.to_lowercase(), row.clone());
    }
}

pub(crate) async fn import(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let records = match validate(&headers, &body, import_body) {
        Ok(records) => records,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    answer(
        run_import(&state, &caller, &records).await,
        LOG,
        "Failed to import companies",
    )
}

/// One record's import: `Ok(None)` done, `Ok(Some(message))` a row error.
async fn import_one(
    caller: &Caller,
    record: &Map<String, Value>,
    by_code: &mut HashMap<String, Value>,
    by_email: &mut HashMap<String, Value>,
    statuses: &StatusLookup,
    changed: &mut Vec<(String, bool, Value)>,
) -> Result<Option<String>, DomainError> {
    let db = &caller.db;
    let code = norm(record.get("partyCode"));
    let email = norm(record.get("email")).to_lowercase();
    let matched = (!code.is_empty())
        .then(|| by_code.get(&code).cloned())
        .flatten()
        .or_else(|| {
            (!email.is_empty())
                .then(|| by_email.get(&email).cloned())
                .flatten()
        });
    if let Some(found) = matched {
        let mut input = record.clone();
        if let Some(Value::Object(custom)) = record.get("customFields") {
            let mut merged = match found.get("customFields") {
                Some(Value::Object(existing)) => existing.clone(),
                _ => Map::new(),
            };
            for (key, value) in custom {
                merged.insert(key.clone(), value.clone());
            }
            input.insert("customFields".into(), Value::Object(merged));
        }
        let id = found
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        return Ok(
            match service::update_company(db, &id, &input, None, Some(statuses)).await? {
                None => Some("Matched company no longer exists".to_owned()),
                Some((row, _)) => {
                    index(by_code, by_email, &row);
                    changed.push((id, false, row));
                    None
                }
            },
        );
    }
    if norm(record.get("name")).is_empty() {
        return Ok(Some("Missing required field: name".to_owned()));
    }
    let row = service::insert_imported(db, record, Some(&caller.user_id)).await?;
    index(by_code, by_email, &row);
    let id = row
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    changed.push((id, true, row));
    Ok(None)
}

async fn run_import(state: &CrmState, caller: &Caller, records: &[Map<String, Value>]) -> Answer {
    let db = &caller.db;
    let (mut by_code, mut by_email) = (HashMap::new(), HashMap::new());
    let mut codes: Vec<String> = Vec::new();
    let mut emails: Vec<String> = Vec::new();
    for record in records {
        let code = norm(record.get("partyCode"));
        if !code.is_empty() && !codes.contains(&code) {
            codes.push(code);
        }
        let email = norm(record.get("email")).to_lowercase();
        if !email.is_empty() && !emails.contains(&email) {
            emails.push(email);
        }
    }
    if !codes.is_empty() {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from companies t where deleted_at is null and party_code = any($1)",
        )
        .bind(&codes)
        .fetch_all(db)
        .await?;
        for row in rows.into_iter().map(drizzle_row) {
            if let Some(code) = row
                .get("partyCode")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
            {
                by_code.insert(code.to_owned(), row.clone());
            }
        }
    }
    if !emails.is_empty() {
        let rows: Vec<Value> =
            sqlx::query_scalar("select to_jsonb(t) from companies t where deleted_at is null and lower(email) = any($1)")
                .bind(&emails)
                .fetch_all(db)
                .await?;
        for row in rows.into_iter().map(drizzle_row) {
            if let Some(email) = row
                .get("email")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
            {
                by_email.insert(email.to_lowercase(), row.clone());
            }
        }
    }
    let statuses = service::status_lookup(db).await?;
    let (mut imported, mut updated, mut failed) = (0, 0, 0);
    let mut errors: Vec<Value> = Vec::new();
    let mut changed: Vec<(String, bool, Value)> = Vec::new();
    for (index, original) in records.iter().enumerate() {
        let row = index + 1;
        let reference = [
            norm(original.get("partyCode")),
            norm(original.get("email")),
            norm(original.get("name")),
        ]
        .into_iter()
        .find(|r| !r.is_empty())
        .unwrap_or_else(|| format!("#{row}"));
        let outcome = match validate_record(original, &statuses) {
            Err(error) => Ok(Some(error)),
            Ok(record) => {
                let before = changed.len();
                let outcome = import_one(
                    caller,
                    &record,
                    &mut by_code,
                    &mut by_email,
                    &statuses,
                    &mut changed,
                )
                .await;
                if changed.len() > before {
                    if changed.last().is_some_and(|(_, created, _)| *created) {
                        imported += 1;
                    } else {
                        updated += 1;
                    }
                }
                outcome
            }
        };
        let error = match outcome {
            Ok(None) => continue,
            Ok(Some(error)) => error,
            Err(error) => error.message(),
        };
        failed += 1;
        errors.push(json!({ "row": row, "ref": reference, "error": error }));
    }
    for (id, created, row) in &changed {
        let data = company_event(row, &["id", "name", "website", "industry"]);
        let event = if *created {
            COMPANY_CREATED
        } else {
            COMPANY_UPDATED
        };
        caller.publish(state, event, id, &data);
    }
    Ok(Data(json!({
        "imported": imported,
        "updated": updated,
        "failed": failed,
        "total": records.len(),
        "errors": errors,
    }))
    .into_response())
}

// ── GET /:id/detail ─────────────────────────────────────────────────────────

/// A `z.coerce.number().min(1).max(50).default(n)` query value, `Math.min(…, 50)`.
fn limit_param(values: &Map<String, Value>, issues: &mut Issues, key: &str, fallback: f64) -> i64 {
    let rules = Number {
        coerce: true,
        int: false,
        min: Some(1.0),
        max: Some(50.0),
    };
    #[allow(clippy::cast_possible_truncation)]
    let value = issues
        .number(values, key, Presence::Optional, rules)
        .into_option()
        .unwrap_or(fallback)
        .min(50.0) as i64;
    value
}

/// Rows of a party-keyed table, newest first; none without a party.
async fn party_rows(
    caller: &Caller,
    party: Option<&String>,
    sql: &'static str,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let Some(party) = party else {
        return Ok(Vec::new());
    };
    let rows: Vec<Value> = sqlx::query_scalar(sql)
        .bind(party)
        .bind(limit)
        .fetch_all(&caller.db)
        .await?;
    Ok(rows.into_iter().map(drizzle_row).collect())
}

pub(crate) async fn aggregate(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let values = query_values(query.as_deref());
    let mut issues = Issues::default();
    let limits = [
        limit_param(&values, &mut issues, "activitiesLimit", 10.0),
        limit_param(&values, &mut issues, "ordersLimit", 10.0),
        limit_param(&values, &mut issues, "opportunitiesLimit", 10.0),
        limit_param(&values, &mut issues, "peopleLimit", 20.0),
    ];
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    answer(
        run_aggregate(&caller, &id, limits).await,
        LOG,
        "Failed to fetch company detail",
    )
}

async fn run_aggregate(caller: &Caller, id: &str, limits: [i64; 4]) -> Answer {
    let scope = caller.scope(COMPANIES_SCOPE_ALL);
    let db = &caller.db;
    let Some(company) = service::get_company(db, id, scope.as_deref()).await? else {
        return Ok(ApiError::not_found("Company", Some(id)).into_response());
    };
    let party: Option<String> = sqlx::query_scalar(
        "select id from parties where company_id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let mut people = service::list_company_people(db, id, None).await?;
    people.truncate(usize::try_from(limits[3]).unwrap_or(0));
    let activities = party_rows(
        caller,
        party.as_ref(),
        "select to_jsonb(t) from crm_activities t where counterparty_id = $1 and deleted_at is null
         order by created_at desc limit $2",
        limits[0],
    )
    .await?;
    let opportunities = party_rows(
        caller,
        party.as_ref(),
        concat!(
            "select ",
            weldsuite_crm_domain::opportunity_json!("t"),
            " from crm_opportunities t where counterparty_id = $1 and deleted_at is null
             order by created_at desc limit $2"
        ),
        limits[2],
    )
    .await?;
    let orders = party_rows(
        caller,
        party.as_ref(),
        "select to_jsonb(t) || jsonb_build_object('subtotal', t.subtotal::text,
             'discount_total', t.discount_total::text, 'shipping_total', t.shipping_total::text,
             'tax_total', t.tax_total::text, 'total', t.total::text)
         from orders t where counterparty_id = $1 and deleted_at is null
         order by created_at desc limit $2",
        limits[1],
    )
    .await?;
    let lists: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', l.id, 'name', l.name, 'color', l.color, 'icon', l.icon,
             'description', l.description, 'added_at', lm.added_at)
         from list_members lm inner join lists l on l.id = lm.list_id
         where lm.entity_id = $1 and l.kind = 'company' and l.deleted_at is null
         order by lm.added_at desc",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let people_count: i64 =
        sqlx::query_scalar("select count(*) from person_companies where company_id = $1")
            .bind(id)
            .fetch_one(db)
            .await?;
    let counts: (i64, i64, i64, i64, i64) = match &party {
        None => (0, 0, 0, 0, 0),
        Some(party) => {
            sqlx::query_as(
                "select
                   (select count(*) from crm_activities where counterparty_id = $1 and deleted_at is null),
                   (select count(*) from crm_opportunities where counterparty_id = $1 and deleted_at is null),
                   (select count(*) from orders where counterparty_id = $1 and deleted_at is null),
                   (select count(*) from crm_activities where counterparty_id = $1 and type = 'note' and deleted_at is null),
                   (select count(*) from crm_activities where counterparty_id = $1 and type = 'task' and deleted_at is null)",
            )
            .bind(party)
            .fetch_one(db)
            .await?
        }
    };
    let last_activity = activities
        .first()
        .and_then(|row| row.get("createdAt"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(Data(json!({
        "company": company,
        "people": people,
        "activities": activities,
        "opportunities": opportunities,
        "orders": orders,
        "invoices": [],
        "lists": lists.into_iter().map(drizzle_row).collect::<Vec<_>>(),
        "counts": {
            "people": people_count,
            "activities": counts.0,
            "opportunities": counts.1,
            "orders": counts.2,
            "invoices": 0,
            "notes": counts.3,
            "tasks": counts.4,
        },
        "lastActivity": last_activity,
    }))
    .into_response())
}

// ── GET /:id/navigation ─────────────────────────────────────────────────────

pub(crate) async fn navigation(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let values = query_values(query.as_deref());
    let mut issues = Issues::default();
    let list_id = issues
        .text_with(&values, "listId", Presence::Optional, Text::default())
        .into_option()
        .filter(|l| !l.is_empty());
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    answer(
        run_navigation(&caller, &id, list_id).await,
        LOG,
        "Failed to fetch company navigation",
    )
}

async fn run_navigation(caller: &Caller, id: &str, list_id: Option<String>) -> Answer {
    let scope = caller.scope(COMPANIES_SCOPE_ALL);
    let db = &caller.db;
    if let Some(list_id) = list_id {
        let name: Option<String> = sqlx::query_scalar(
            "select name from lists where id = $1 and deleted_at is null limit 1",
        )
        .bind(&list_id)
        .fetch_optional(db)
        .await?;
        let context = name.unwrap_or_else(|| "Company List".to_owned());
        let members: Vec<String> = sqlx::query_scalar(
            "select lm.entity_id from list_members lm inner join companies c on c.id = lm.entity_id
             where lm.list_id = $1 and c.deleted_at is null and ($2::text is null or c.owner_id = $2)
             order by lm.added_at desc",
        )
        .bind(&list_id)
        .bind(&scope)
        .fetch_all(db)
        .await?;
        let total = members.len();
        let body = match members.iter().position(|m| m == id) {
            None => {
                json!({ "currentIndex": 0, "totalCount": total, "previousId": null, "nextId": null, "contextName": context })
            }
            Some(index) => json!({
                "currentIndex": index + 1,
                "totalCount": total,
                "previousId": index.checked_sub(1).map(|i| members[i].clone()),
                "nextId": members.get(index + 1),
                "contextName": context,
            }),
        };
        return Ok(Data(body).into_response());
    }
    let created: Option<String> = sqlx::query_scalar(
        "select to_char(date_trunc('milliseconds', created_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS')
         from companies where id = $1 and deleted_at is null and ($2::text is null or owner_id = $2) limit 1",
    )
    .bind(id)
    .bind(&scope)
    .fetch_optional(db)
    .await?;
    let Some(created) = created else {
        return Ok(ApiError::not_found("Company", Some(id)).into_response());
    };
    let (total, previous, next, after): (i64, Option<String>, Option<String>, i64) = sqlx::query_as(
        "select
           (select count(*) from companies where deleted_at is null and ($1::text is null or owner_id = $1)),
           (select id from companies where deleted_at is null and ($1::text is null or owner_id = $1)
              and created_at > $2::timestamp order by created_at limit 1),
           (select id from companies where deleted_at is null and ($1::text is null or owner_id = $1)
              and created_at < $2::timestamp order by created_at desc limit 1),
           (select count(*) from companies where deleted_at is null and ($1::text is null or owner_id = $1)
              and created_at > $2::timestamp)",
    )
    .bind(&scope)
    .bind(&created)
    .fetch_one(db)
    .await?;
    Ok(Data(json!({
        "currentIndex": after + 1,
        "totalCount": total,
        "previousId": previous,
        "nextId": next,
        "contextName": "All Companies",
    }))
    .into_response())
}

// ── POST /:id/refresh-logo ──────────────────────────────────────────────────

pub(crate) async fn refresh_logo(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        run_refresh_logo(&state, &caller, &id).await,
        LOG,
        "Failed to refresh company logo",
    )
}

async fn run_refresh_logo(state: &CrmState, caller: &Caller, id: &str) -> Answer {
    let scope = caller.scope(COMPANIES_SCOPE_ALL);
    let storage = caller
        .files
        .as_ref()
        .or(state.services.files.as_ref())
        .and_then(|f| f.public.clone());
    let public_url = caller.env(state, "R2_PUBLIC_URL").filter(|u| !u.is_empty());
    if storage.is_none() || public_url.is_none() {
        return Ok(ApiError::internal()
            .with_message("Logo storage is not configured")
            .into_response());
    }
    if service::company_for_logo(&caller.db, id, scope.as_deref())
        .await?
        .is_none()
    {
        return Ok(ApiError::not_found("Company", Some(id)).into_response());
    }
    // `fetchAndStoreLogo` (Gravatar, Hunter.io, an initials SVG into R2) is
    // not ported: the route answers as TypeScript does when the fetch fails,
    // with the company unchanged.
    let Some(company) = service::get_company(&caller.db, id, None).await? else {
        return Ok(ApiError::not_found("Company", Some(id)).into_response());
    };
    let row_id = company
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    caller.publish(
        state,
        COMPANY_UPDATED,
        &row_id,
        &company_event(&company, &["id", "name", "website"]),
    );
    Ok(Data(company).into_response())
}
