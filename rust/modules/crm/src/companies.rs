//! `/api/companies` (`routes/companies/index.ts`): organisations, on
//! `weldsuite_crm_domain::companies`. Without `companies:scope:all` a caller
//! sees only the companies they own.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    COMPANY_ARCHIVED, COMPANY_CREATED, COMPANY_DELETED, COMPANY_UPDATED,
};
use weldsuite_catalogs::permission_keys::COMPANIES_SCOPE_ALL;
use weldsuite_crm_domain::DomainError;
use weldsuite_crm_domain::companies::{self as service, CompanyFilter, ListOptions};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent};

use crate::identity_schema::{
    LIFECYCLE_STAGES, address, addresses, email_or_empty, emails, money, positive_int, url_field,
    url_refine,
};
use crate::schema::{self, Kind, NULLISH, OPT, REQ, STRINGS, Spec, int, partial, s};
use crate::{Answer, Caller, CrmState, Refusal, answer, page, validate};

const LOG: &str = "companies";

/// The plain fields of `createCompanySchema`, in its order. The fields
/// with their own readers (`employeeCount`, `website`, money, `email`,
/// `alternateEmails`, addresses, `foundationDate`) are read around them.
const PLAIN_HEAD: [Spec; 5] = [
    Spec::new("name", s(Some(1), Some(255)), REQ),
    Spec::new("tradingName", s(None, Some(255)), OPT),
    Spec::new("registrationNumber", s(None, Some(100)), OPT),
    Spec::new("vatNumber", s(None, Some(50)), OPT),
    Spec::new("industry", s(None, Some(100)), OPT),
];

const PLAIN_MID: [Spec; 3] = [
    Spec::new("phone", s(None, Some(50)), OPT),
    Spec::new("mobile", s(None, Some(50)), OPT),
    Spec::new("fax", s(None, Some(50)), OPT),
];

const PLAIN_TAIL: [Spec; 32] = [
    Spec::new("avatarUrl", s(None, Some(1000)), OPT),
    Spec::new("linkedinUrl", s(None, Some(500)), OPT),
    Spec::new("twitterHandle", s(None, Some(100)), OPT),
    Spec::new("facebookUrl", s(None, Some(500)), OPT),
    Spec::new("instagramUrl", s(None, Some(500)), OPT),
    Spec::new("angellistUrl", s(None, Some(500)), OPT),
    Spec::new("twitterFollowerCount", int(Some(0.0), None), NULLISH),
    Spec::new("ownerId", s(None, None), NULLISH),
    Spec::new("accountManagerId", s(None, None), NULLISH),
    Spec::new("status", s(None, None), OPT),
    Spec::new("lifecycleStage", Kind::Enum(LIFECYCLE_STAGES), NULLISH),
    Spec::new("segment", s(None, None), OPT),
    Spec::new("rating", s(None, None), OPT),
    Spec::new("source", s(None, None), OPT),
    Spec::new("lastContactDate", s(None, None), NULLISH),
    Spec::new("nextFollowUpDate", s(None, None), NULLISH),
    Spec::new("isSupplier", Kind::Bool, OPT),
    Spec::new("isLead", Kind::Bool, OPT),
    Spec::new("isFavorite", Kind::Bool, OPT),
    Spec::new("preferredContactMethod", s(None, None), OPT),
    Spec::new("preferredLanguage", s(None, None), OPT),
    Spec::new("timezone", s(None, None), OPT),
    Spec::new("marketingConsent", Kind::Bool, OPT),
    Spec::new("emailOptIn", Kind::Bool, OPT),
    Spec::new("smsOptIn", Kind::Bool, OPT),
    Spec::new("doNotCall", Kind::Bool, OPT),
    Spec::new("tags", STRINGS, OPT),
    Spec::new("customFields", Kind::Record, OPT),
    Spec::new("notes", s(None, None), OPT),
    Spec::new("internalNotes", s(None, None), OPT),
    // `annualRevenue`/`fundingRaised` sit between `description` and
    // `foundationDate`; read in `company_body`.
    Spec::new("description", s(None, Some(5000)), OPT),
    Spec::new("foundationDate", s(None, None), NULLISH),
];

pub(crate) const EMPLOYEES_MESSAGE: &str =
    "Employees must be a number or a range (e.g. 42 or 11-50)";
pub(crate) const WEBSITE_MESSAGE: &str =
    "Website must be a valid URL (e.g. acme.com or https://acme.com)";

/// `/^\d+(-\d+)?\+?$/`.
pub(crate) fn is_employee_count(text: &str) -> bool {
    let (head, rest) = text.split_at(text.bytes().take_while(u8::is_ascii_digit).count());
    if head.is_empty() {
        return false;
    }
    let rest = rest.strip_suffix('+').unwrap_or(rest);
    match rest.strip_prefix('-') {
        None => rest.is_empty(),
        Some(tail) => !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// `createCompanySchema`, or `updateCompanySchema` (partial, a nullish
/// `primaryAddress`, `ifVersion`/`version`), in Zod's issue order.
fn company_body(
    issues: &mut Issues,
    body: &Map<String, Value>,
    update: bool,
) -> Map<String, Value> {
    let specs = |list: &[Spec]| if update { partial(list) } else { list.to_vec() };
    let mut out = schema::read_sync(issues, body, &specs(&PLAIN_HEAD));
    // employeeCount, website: strings first; refinements after every field.
    if let Field::Set(text) = issues.text_with(
        body,
        "employeeCount",
        Presence::Optional,
        Text::length(None, Some(50)),
    ) {
        out.insert("employeeCount".into(), json!(text));
    }
    url_field(issues, body, "website", 500, &mut out);
    let rest = specs(&PLAIN_TAIL);
    out.extend(schema::read_sync(issues, body, &rest[30..31]));
    money(issues, body, "annualRevenue", &mut out);
    money(issues, body, "fundingRaised", &mut out);
    out.extend(schema::read_sync(issues, body, &rest[31..32]));
    emails(issues, body, "alternateEmails", &mut out);
    out.extend(schema::read_sync(issues, body, &specs(&PLAIN_MID)));
    address(
        issues,
        body,
        "primaryAddress",
        if update {
            Presence::Nullish
        } else {
            Presence::Optional
        },
        &mut out,
    );
    addresses(issues, body, "addresses", &mut out);
    out.extend(schema::read_sync(issues, body, &rest[..30]));
    if update {
        positive_int(issues, body, "ifVersion", &mut out);
        positive_int(issues, body, "version", &mut out);
    }
    // Refinements on plain fields, then the `email` union.
    if let Some(Value::String(raw)) = body.get("employeeCount")
        && !raw.is_empty()
        && !is_employee_count(raw)
    {
        issues.custom("employeeCount", EMPLOYEES_MESSAGE);
    }
    url_refine(issues, body, "website", WEBSITE_MESSAGE, &mut out);
    email_or_empty(issues, body, "email", &mut out);
    out
}

/// The list/export filters off a parsed query.
fn filter_of(values: &Map<String, Value>, issues: &mut Issues) -> CompanyFilter {
    let text = |issues: &mut Issues, key: &str| {
        issues
            .text_with(values, key, Presence::Optional, Text::default())
            .into_option()
    };
    let flag = |key: &str| {
        values
            .get(key)
            .map(|v| v.as_str().is_some_and(|s| !s.is_empty()) || v.is_array())
    };
    CompanyFilter {
        search: text(issues, "search"),
        status: text(issues, "status"),
        owner_id: text(issues, "ownerId"),
        is_supplier: flag("isSupplier"),
        is_lead: flag("isLead"),
        industry: text(issues, "industry"),
        list_id: text(issues, "listId"),
        custom_filter: None,
    }
}

/// `listCompaniesQuery` (`export`: without cursor, limit and include).
fn list_query(raw: Option<&str>, export: bool) -> Answer<(CompanyFilter, ListOptions)> {
    let values = query_values(raw);
    let mut issues = Issues::default();
    let cursor = if export {
        None
    } else {
        issues
            .text_with(&values, "cursor", Presence::Optional, Text::default())
            .into_option()
    };
    let limit = if export {
        0.0
    } else {
        issues
            .number(
                &values,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: false,
                    min: Some(1.0),
                    max: Some(100.0),
                },
            )
            .into_option()
            .unwrap_or(25.0)
    };
    let mut filter = filter_of(&values, &mut issues);
    let sort = issues
        .text_with(&values, "sort", Presence::Optional, Text::default())
        .into_option();
    let sort_dir = issues
        .choice(&values, "sortDir", Presence::Optional, &["asc", "desc"])
        .into_option();
    filter.custom_filter = issues
        .text_with(&values, "customFilter", Presence::Optional, Text::default())
        .into_option();
    let include = if export {
        None
    } else {
        issues
            .choice(&values, "include", Presence::Optional, &["attributes"])
            .into_option()
    };
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    #[allow(clippy::cast_possible_truncation)]
    let options = ListOptions {
        limit: limit as i64,
        cursor,
        sort,
        sort_dir,
        include_attributes: include.is_some(),
    };
    Ok((filter, options))
}

/// The service's refusals as `createCompany`/`updateCompany`'s catch maps
/// them (member and status: 400 with the field; version: 409).
fn refused(error: DomainError) -> Refusal {
    error.into()
}

pub(crate) fn company_event(row: &Value, keys: &[&str]) -> Value {
    let mut data = Map::new();
    for key in keys {
        data.insert(
            (*key).to_owned(),
            row.get(*key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(data)
}

// ── GET / and /export ───────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (filter, options) = match list_query(query.as_deref(), false) {
        Ok(q) => q,
        Err(refusal) => return refusal.respond(LOG, "Invalid query"),
    };
    let result = async {
        let scope = caller.scope(COMPANIES_SCOPE_ALL);
        let page_of =
            service::list_companies(&caller.db, &filter, &options, scope.as_deref()).await?;
        Ok(page(
            page_of.data,
            page_of.total_count,
            page_of.has_more,
            page_of.cursor,
        ))
    }
    .await;
    answer(result, LOG, "Failed to list companies")
}

pub(crate) async fn export(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (filter, _) = match list_query(query.as_deref(), true) {
        Ok(q) => q,
        Err(refusal) => return refusal.respond(LOG, "Invalid query"),
    };
    let result = async {
        let scope = caller.scope(COMPANIES_SCOPE_ALL);
        let rows = service::export_companies(&caller.db, &filter, scope.as_deref()).await?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, LOG, "Failed to export companies")
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let scope = caller.scope(COMPANIES_SCOPE_ALL);
        Ok(
            match service::get_company(&caller.db, &id, scope.as_deref()).await? {
                Some(row) => Data(row).into_response(),
                None => ApiError::not_found("Company", Some(&id)).into_response(),
            },
        )
    }
    .await;
    answer(result, LOG, "Failed to fetch company")
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut data = match validate(&headers, &body, |issues, fields| {
        company_body(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    if data.get("ownerId").is_none_or(Value::is_null) {
        data.insert("ownerId".into(), json!(caller.user_id));
    }
    let result = async {
        let created = service::create_company(&caller.db, &data, Some(&caller.user_id))
            .await
            .map_err(refused)?;
        let id = created
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        caller.publish(
            &state,
            COMPANY_CREATED,
            &id,
            &company_event(
                &created,
                &[
                    "id", "name", "email", "phone", "website", "industry", "status",
                ],
            ),
        );
        Ok(Created(created).into_response())
    }
    .await;
    answer(result, LOG, "Failed to create company")
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
        company_body(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let scope = caller.scope(COMPANIES_SCOPE_ALL);
        let Some((row, changes)) =
            service::update_company(&caller.db, &id, &data, scope.as_deref(), None)
                .await
                .map_err(refused)?
        else {
            return Ok(ApiError::not_found("Company", Some(&id)).into_response());
        };
        let row_id = row
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        caller.publish_with_changes(
            &state,
            COMPANY_UPDATED,
            &row_id,
            company_event(&row, &["id", "name", "website", "industry"]),
            changes,
        );
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update company")
}

// ── DELETE /:id, archive, unarchive ─────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let scope = caller.scope(COMPANIES_SCOPE_ALL);
        if !service::delete_company(&caller.db, &id, scope.as_deref()).await? {
            return Ok(ApiError::not_found("Company", Some(&id)).into_response());
        }
        caller.publish(&state, COMPANY_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete company")
}

async fn set_archived(state: &CrmState, caller: &Caller, id: &str, archived: bool) -> Answer {
    let scope = caller.scope(COMPANIES_SCOPE_ALL);
    let Some(row) = service::set_archived(&caller.db, id, archived, scope.as_deref()).await? else {
        return Ok(ApiError::not_found("Company", Some(id)).into_response());
    };
    let row_id = row
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let data = company_event(&row, &["id", "name"]);
    if archived {
        caller.publish(state, COMPANY_ARCHIVED, &row_id, &data);
    } else {
        // `company:unarchived` is not in the entity-event catalog; the
        // TypeScript publisher hands it to the queue as it is.
        caller.publish_custom(state, "company", "unarchived", &row_id, data);
    }
    Ok(Data(row).into_response())
}

pub(crate) async fn archive(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        set_archived(&state, &caller, &id, true).await,
        LOG,
        "Failed to archive company",
    )
}

pub(crate) async fn unarchive(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        set_archived(&state, &caller, &id, false).await,
        LOG,
        "Failed to unarchive company",
    )
}

// ── GET /:id/people ─────────────────────────────────────────────────────────

pub(crate) async fn people(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let scope = caller.scope(COMPANIES_SCOPE_ALL);
        let rows = service::list_company_people(&caller.db, &id, scope.as_deref()).await?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, LOG, "Failed to list company people")
}

// ── POST /bulk-update ───────────────────────────────────────────────────────

/// `bulkUpdateCompaniesSchema`.
fn bulk_body(issues: &mut Issues, body: &Map<String, Value>) -> (Vec<String>, Map<String, Value>) {
    let ids = issues
        .list(
            body,
            "companyIds",
            Presence::Required,
            Some(1),
            Some(500),
            |issues, item| issues.item_text(item, Text::default()),
        )
        .into_option()
        .unwrap_or_default();
    let mut refine_failed = false;
    let updates = issues
        .nested(body, "updates", Presence::Required, |issues, fields| {
            let specs = [
                Spec::new("ownerId", s(None, None), NULLISH),
                Spec::new("accountManagerId", s(None, None), NULLISH),
                Spec::new("status", s(None, None), OPT),
                Spec::new("lifecycleStage", Kind::Enum(LIFECYCLE_STAGES), OPT),
            ];
            let out = schema::read(issues, fields, &specs);
            refine_failed = ["ownerId", "accountManagerId", "status", "lifecycleStage"]
                .iter()
                .all(|key| !out.contains_key(*key));
            out
        })
        .into_option()
        .unwrap_or_default();
    if refine_failed {
        issues.custom("updates", "At least one field must be provided");
    }
    (ids, updates)
}

pub(crate) async fn bulk_update(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (ids, updates) = match validate(&headers, &body, bulk_body) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let scope = caller.scope(COMPANIES_SCOPE_ALL);
        let (count, failed, rows) =
            service::bulk_update_companies(&caller.db, &ids, &updates, scope.as_deref())
                .await
                .map_err(refused)?;
        for (id, before, after) in rows {
            let mut data = Map::new();
            data.insert("id".into(), json!(id));
            let mut diff = Map::new();
            for (key, value) in &after {
                data.insert(key.clone(), value.clone());
                diff.insert(
                    key.clone(),
                    json!({ "old": before.get(key).cloned().unwrap_or(Value::Null), "new": value }),
                );
            }
            caller.publish_with_changes(
                &state,
                COMPANY_UPDATED,
                &id,
                Value::Object(data),
                Some(diff),
            );
        }
        Ok(Data(json!({ "updated": count, "failed": failed })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to bulk-update companies")
}
