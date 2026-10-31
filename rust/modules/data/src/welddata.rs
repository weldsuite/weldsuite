//! `/api/welddata`: the Lemlist lead database (search, filters), lists and
//! saved leads, converting leads into CRM, and enrichment columns, cells and
//! runs (`apps/workers/data-api/src/routes/welddata/index.ts`).
//!
//! Permissions: `prospects:read` searches and reads, `prospects:create`
//! creates lists, columns and saved leads, `prospects:update` renames,
//! converts and runs, `prospects:delete` deletes.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    COMPANY_CREATED, PERSON_CREATED, WELDDATA_COLUMN_CREATED, WELDDATA_COLUMN_DELETED,
    WELDDATA_COLUMN_RUN, WELDDATA_COLUMN_UPDATED, WELDDATA_LEAD_CONVERTED, WELDDATA_LEAD_DELETED,
    WELDDATA_LIST_CREATED, WELDDATA_LIST_DELETED, WELDDATA_LIST_MEMBERS_ADDED,
    WELDDATA_LIST_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::text;
use crate::lemlist::{Database, LemlistError, SearchArgs};
use crate::service::{self, LeadQuery, Materialised, NewList, Page};
use crate::{Caller, DataState, internal, validate, validate_query};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<DataState> {
    let read = || gate.require([perm::PROSPECTS_READ]);
    let create = || gate.require([perm::PROSPECTS_CREATE]);
    let update = || gate.require([perm::PROSPECTS_UPDATE]);
    let remove = || gate.require([perm::PROSPECTS_DELETE]);
    Router::new()
        .route("/filters", get(filters).route_layer(read()))
        .route("/search/people", post(search_people).route_layer(read()))
        .route(
            "/search/companies",
            post(search_companies).route_layer(read()),
        )
        .route(
            "/lists",
            get(list_lists)
                .route_layer(read())
                .merge(post(create_list).route_layer(create())),
        )
        .route(
            "/lists/{id}",
            get(get_list)
                .route_layer(read())
                .merge(patch(update_list).route_layer(update()))
                .merge(delete(delete_list).route_layer(remove())),
        )
        .route(
            "/lists/{id}/leads",
            get(list_leads)
                .route_layer(read())
                .merge(post(add_leads).route_layer(create())),
        )
        .route("/leads/{id}", delete(remove_lead).route_layer(remove()))
        .route(
            "/leads/{id}/convert",
            post(convert_lead).route_layer(update()),
        )
        .route("/convert", post(convert_leads).route_layer(update()))
        .route(
            "/convert-to-list",
            post(convert_to_list).route_layer(update()),
        )
        .route(
            "/lists/{id}/columns",
            get(list_columns)
                .route_layer(read())
                .merge(post(create_column).route_layer(create())),
        )
        .route(
            "/columns/{id}",
            patch(update_column)
                .route_layer(update())
                .merge(delete(delete_column).route_layer(remove())),
        )
        .route("/lists/{id}/cells", get(list_cells).route_layer(read()))
        .route(
            "/lists/{id}/columns/{column_id}/run",
            post(run_column).route_layer(update()),
        )
        .route("/cells/run", post(run_cell).route_layer(update()))
}

/// `handleLemlistError(c, err)`.
fn lemlist_error(error: &LemlistError) -> Response {
    match error {
        LemlistError::NotConfigured => ApiError::internal()
            .with_message("Lead database is not configured")
            .into_response(),
        LemlistError::Status(401 | 403) => ApiError::internal()
            .with_message("Lead database rejected the request (check API key)")
            .into_response(),
        LemlistError::Status(429) => {
            ApiError::bad_request("Lead database rate limit reached, please retry shortly")
                .into_response()
        }
        other => internal(other, "Lead database request failed"),
    }
}

fn page_list(page: Page) -> Response {
    List::new(
        page.rows,
        Pagination::new(
            u64::try_from(page.total_count).unwrap_or_default(),
            page.has_more,
            page.cursor,
        ),
    )
    .into_response()
}

fn not_found(resource: &str, id: &str) -> Response {
    ApiError::not_found(resource, Some(id)).into_response()
}

// ── the lead database ───────────────────────────────────────────────────────

/// `GET /filters`: the filter catalog per database.
async fn filters(State(state): State<DataState>, caller: Caller) -> Response {
    match caller.lemlist(&state).filters().await {
        Ok(catalog) => Data(catalog).into_response(),
        Err(error) => lemlist_error(&error),
    }
}

/// A search as `searchLeadsSchema` reads it, and the lists to leave out.
struct Search {
    args: SearchArgs,
    exclude: Option<Vec<String>>,
}

fn read_search(issues: &mut Issues, body: &Map<String, Value>) -> Option<Search> {
    let filters = if body.contains_key("filters") {
        issues.list(
            body,
            "filters",
            Presence::Optional,
            None,
            None,
            |issues, item| {
                let fields = issues.object(item)?;
                let id = issues.string(fields, "filterId", true, None, None);
                let values = if fields.contains_key("values") {
                    issues
                        .list(
                            fields,
                            "values",
                            Presence::Optional,
                            None,
                            None,
                            Issues::item_string_or_number,
                        )
                        .into_option()
                } else {
                    Some(Vec::new())
                };
                Some((id?, values?))
            },
        )
    } else {
        Field::Set(Vec::new())
    };
    let keyword = issues.string(body, "keyword", false, None, None);
    let whole = |min: f64, max: Option<f64>| Number {
        int: true,
        min: Some(min),
        max,
        ..Number::default()
    };
    let page = issues.whole_number(body, "page", Presence::Optional, whole(1.0, None));
    let size = issues.whole_number(body, "size", Presence::Optional, whole(1.0, Some(100.0)));
    let exclude = issues.list(
        body,
        "excludeListIds",
        Presence::Optional,
        None,
        Some(50),
        |issues, item| issues.item_text(item, Text::default()),
    );
    Some(Search {
        args: SearchArgs {
            filters: filters.into_option()?,
            keyword,
            page: page.into_option().unwrap_or(1),
            size: size.into_option().unwrap_or(25),
        },
        exclude: exclude.into_option(),
    })
}

/// `excludeSavedLeads(c, result, excludeListIds)`: rows saved in those
/// lists left out, the total reduced by as many.
async fn exclude_saved(
    caller: &Caller,
    mut result: Value,
    exclude: Option<&[String]>,
) -> Result<Value, service::ServiceError> {
    let Some(exclude) = exclude.filter(|lists| !lists.is_empty()) else {
        return Ok(result);
    };
    let saved = service::saved_lemlist_ids(&caller.db, exclude).await?;
    if saved.is_empty() {
        return Ok(result);
    }
    let rows = result["rows"].as_array().cloned().unwrap_or_default();
    let before = rows.len();
    let kept: Vec<Value> = rows
        .into_iter()
        .filter(|row| text(row, "id").is_none_or(|id| !saved.iter().any(|s| s == id)))
        .collect();
    #[allow(clippy::cast_precision_loss)]
    let removed = (before - kept.len()) as f64;
    let total = result["total"].as_f64().unwrap_or(f64::NAN);
    let reduced = (total - removed).max(0.0);
    result["rows"] = Value::Array(kept);
    #[allow(clippy::cast_possible_truncation)]
    let whole = reduced as i64;
    result["total"] = if reduced.fract() == 0.0 && reduced.abs() < 9.0e15 {
        json!(whole)
    } else {
        json!(reduced)
    };
    Ok(result)
}

async fn search(
    state: &DataState,
    caller: &Caller,
    database: Database,
    headers: &HeaderMap,
    body: &Bytes,
) -> Response {
    let input = match validate(headers, body, read_search) {
        Ok(Some(input)) => input,
        Ok(None) => return ApiError::internal().into_response(),
        Err(bad) => return *bad,
    };
    let result = match caller.lemlist(state).search(database, &input.args).await {
        Ok(result) => result,
        Err(error) => return lemlist_error(&error),
    };
    match exclude_saved(caller, result, input.exclude.as_deref()).await {
        Ok(result) => Data(result).into_response(),
        Err(error) => internal(&error, "Lead database request failed"),
    }
}

/// `POST /search/people`.
async fn search_people(
    State(state): State<DataState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    search(&state, &caller, Database::People, &headers, &body).await
}

/// `POST /search/companies`.
async fn search_companies(
    State(state): State<DataState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    search(&state, &caller, Database::Companies, &headers, &body).await
}

// ── lists ───────────────────────────────────────────────────────────────────

fn page_size(issues: &mut Issues, fields: &Map<String, Value>) -> f64 {
    let rules = Number {
        coerce: true,
        min: Some(1.0),
        max: Some(100.0),
        ..Number::default()
    };
    issues
        .number(fields, "limit", Presence::Optional, rules)
        .into_option()
        .unwrap_or(50.0)
}

/// `GET /lists`.
async fn list_lists(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let read = validate_query(query.as_deref(), |issues, fields| {
        let cursor = issues.string(fields, "cursor", false, None, None);
        let limit = page_size(issues, fields);
        let search = issues.string(fields, "search", false, None, None);
        (cursor, limit, search)
    });
    let (cursor, limit, search) = match read {
        Ok(read) => read,
        Err(bad) => return *bad,
    };
    match service::list_lists(&caller.db, cursor.as_deref(), limit, search.as_deref()).await {
        Ok(page) => page_list(page),
        Err(error) => internal(&error, "Failed to list WeldData lists"),
    }
}

/// `POST /lists`.
async fn create_list(
    State(state): State<DataState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let name = issues.string(body, "name", true, Some(1), Some(255));
        let kind = issues.choice(body, "kind", Presence::Optional, &["person", "company"]);
        let description = issues.string(body, "description", false, None, Some(1000));
        let color = issues.string(body, "color", false, None, Some(50));
        let icon = issues.string(body, "icon", false, None, Some(100));
        NewList {
            name: name.unwrap_or_default(),
            kind: kind.into_option().unwrap_or_else(|| "person".to_owned()),
            description,
            color,
            icon,
        }
    });
    let input = match input {
        Ok(input) => input,
        Err(bad) => return *bad,
    };
    match service::create_list(&caller.db, input, &caller.user_id).await {
        Ok(created) => {
            let id = text(&created, "id").unwrap_or_default().to_owned();
            caller.publish(
                &state,
                WELDDATA_LIST_CREATED,
                &id,
                json!({ "id": id, "name": created["name"] }),
            );
            Created(created).into_response()
        }
        Err(error) => internal(&error, "Failed to create WeldData list"),
    }
}

/// `GET /lists/:id`.
async fn get_list(caller: Caller, Path(id): Path<String>) -> Response {
    match service::get_list(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => not_found("WeldData list", &id),
        Err(error) => internal(&error, "Failed to fetch WeldData list"),
    }
}

/// `PATCH /lists/:id`: `name`, `description`, `color`, `icon`.
async fn update_list(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let fields = validate(&headers, &body, |issues, body| {
        let mut fields: Vec<(&'static str, String)> = Vec::new();
        for (key, column, min, max) in [
            ("name", "name", Some(1), 255),
            ("description", "description", None, 1000),
            ("color", "color", None, 50),
            ("icon", "icon", None, 100),
        ] {
            if let Some(value) = issues.string(body, key, false, min, Some(max)) {
                fields.push((column, value));
            }
        }
        fields
    });
    let fields = match fields {
        Ok(fields) => fields,
        Err(bad) => return *bad,
    };
    match service::update_list(&caller.db, &id, &fields).await {
        Ok(Some(row)) => {
            let row_id = text(&row, "id").unwrap_or_default().to_owned();
            caller.publish(
                &state,
                WELDDATA_LIST_UPDATED,
                &row_id,
                json!({ "id": row_id, "name": row["name"] }),
            );
            Data(row).into_response()
        }
        Ok(None) => not_found("WeldData list", &id),
        Err(error) => internal(&error, "Failed to update WeldData list"),
    }
}

/// `DELETE /lists/:id`: the list and its leads.
async fn delete_list(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match service::delete_list(&caller.db, &id).await {
        Ok(true) => {
            caller.publish(&state, WELDDATA_LIST_DELETED, &id, json!({ "id": id }));
            NoContent.into_response()
        }
        Ok(false) => not_found("WeldData list", &id),
        Err(error) => internal(&error, "Failed to delete WeldData list"),
    }
}

// ── saved leads ─────────────────────────────────────────────────────────────

/// `GET /lists/:id/leads`.
async fn list_leads(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let read = validate_query(query.as_deref(), |issues, fields| LeadQuery {
        cursor: issues.string(fields, "cursor", false, None, None),
        limit: page_size(issues, fields),
        search: issues.string(fields, "search", false, None, None),
        kind: issues
            .choice(fields, "kind", Presence::Optional, &["person", "company"])
            .into_option(),
        converted_status: issues
            .choice(
                fields,
                "convertedStatus",
                Presence::Optional,
                &["pending", "converted"],
            )
            .into_option(),
    });
    let query = match read {
        Ok(query) => query,
        Err(bad) => return *bad,
    };
    match service::list_leads(&caller.db, &id, &query).await {
        Ok(Some(page)) => page_list(page),
        Ok(None) => not_found("WeldData list", &id),
        Err(error) => internal(&error, "Failed to list saved leads"),
    }
}

/// The string fields of `savedLeadInputSchema`, after `kind`.
const LEAD_INPUT_FIELDS: [&str; 11] = [
    "lemlistId",
    "name",
    "email",
    "title",
    "companyName",
    "domain",
    "industry",
    "location",
    "country",
    "companySize",
    "linkedinUrl",
];

/// `savedLeadInputSchema`: the fields given, as Zod outputs them.
fn read_lead(issues: &mut Issues, item: &Value) -> Option<Map<String, Value>> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let mut lead = Map::new();
    if let Some(kind) = issues.one_of(fields, "kind", &["person", "company"]) {
        lead.insert("kind".into(), Value::String(kind));
    }
    for key in LEAD_INPUT_FIELDS {
        if let Some(value) = issues.string(fields, key, false, None, None) {
            lead.insert(key.into(), Value::String(value));
        }
    }
    if let Field::Set(data) = issues.nested(fields, "data", Presence::Optional, |_, data| {
        Value::Object(data.clone())
    }) {
        lead.insert("data".into(), data);
    }
    (issues.count() == before).then_some(lead)
}

/// `z.array(savedLeadInputSchema).min(1).max(200)`.
fn read_leads(
    issues: &mut Issues,
    body: &Map<String, Value>,
    presence: Presence,
    min: Option<usize>,
) -> Field<Vec<Map<String, Value>>> {
    issues.list(body, "leads", presence, min, Some(200), read_lead)
}

/// `POST /lists/:id/leads`: save leads of the list's kind, once.
async fn add_leads(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let leads = match validate(&headers, &body, |issues, body| {
        read_leads(issues, body, Presence::Required, Some(1)).into_option()
    }) {
        Ok(Some(leads)) => leads,
        Ok(None) => return ApiError::internal().into_response(),
        Err(bad) => return *bad,
    };
    match service::add_leads(&caller.db, &id, &leads, &caller.user_id).await {
        Ok(Some((added, skipped))) => {
            caller.publish(
                &state,
                WELDDATA_LIST_MEMBERS_ADDED,
                &id,
                json!({ "id": id, "count": added }),
            );
            Created(json!({ "added": added, "skipped": skipped })).into_response()
        }
        Ok(None) => not_found("WeldData list", &id),
        Err(error) => internal(&error, "Failed to save leads"),
    }
}

/// `DELETE /leads/:id`.
async fn remove_lead(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match service::remove_lead(&caller.db, &id).await {
        Ok(true) => {
            caller.publish(&state, WELDDATA_LEAD_DELETED, &id, json!({ "id": id }));
            NoContent.into_response()
        }
        Ok(false) => not_found("Saved lead", &id),
        Err(error) => internal(&error, "Failed to remove saved lead"),
    }
}

// ── conversion into CRM ─────────────────────────────────────────────────────

/// `a ?? b` over two fields: `None` where JavaScript has `undefined` (the
/// key is then left out of the event).
fn coalesce(lead: &Map<String, Value>, a: &str, b: &str) -> Option<Value> {
    match lead.get(a) {
        Some(value) if !value.is_null() => Some(value.clone()),
        _ => lead.get(b).cloned(),
    }
}

/// An event's data: the fields that are not `undefined`.
fn data_of(fields: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value)))
            .collect(),
    )
}

/// The `company:created` and `person:created` events of a conversion.
fn emit_created(
    state: &DataState,
    caller: &Caller,
    made: &Materialised,
    lead: &Map<String, Value>,
) {
    if made.created_company
        && let Some(company) = &made.company_id
    {
        caller.publish(
            state,
            COMPANY_CREATED,
            company,
            data_of(vec![
                ("id", Some(json!(company))),
                ("name", coalesce(lead, "companyName", "name")),
            ]),
        );
    }
    if made.created_person
        && let Some(person) = &made.person_id
    {
        caller.publish(
            state,
            PERSON_CREATED,
            person,
            data_of(vec![
                ("id", Some(json!(person))),
                ("displayName", lead.get("name").cloned()),
                ("email", lead.get("email").cloned()),
                ("title", lead.get("title").cloned()),
            ]),
        );
    }
}

fn create_company_flag(issues: &mut Issues, body: &Map<String, Value>) -> bool {
    issues
        .boolean(body, "createCompany", Presence::Optional)
        .into_option()
        .unwrap_or(true)
}

/// `POST /leads/:id/convert`: a saved lead into CRM.
async fn convert_lead(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let create_company = match validate(&headers, &body, create_company_flag) {
        Ok(flag) => flag,
        Err(bad) => return *bad,
    };
    let lead = match service::get_lead(&caller.db, &id).await {
        Ok(Some(Value::Object(lead))) => lead,
        Ok(_) => return not_found("Saved lead", &id),
        Err(error) => return internal(&error, "Failed to convert lead"),
    };
    let converted =
        match service::convert_lead(&caller.db, &lead, create_company, &caller.user_id).await {
            Ok(converted) => converted,
            Err(error) => return internal(&error, "Failed to convert lead"),
        };
    let made = &converted.made;
    if !converted.already {
        emit_created(&state, &caller, made, &lead);
        caller.publish(
            &state,
            WELDDATA_LEAD_CONVERTED,
            &id,
            json!({
                "id": id,
                "listId": lead.get("listId"),
                "kind": lead.get("kind"),
                "name": lead.get("name"),
                "convertedPersonId": made.person_id,
                "convertedCompanyId": made.company_id,
            }),
        );
    }
    Data(json!({
        "leadId": id,
        "personId": made.person_id,
        "companyId": made.company_id,
    }))
    .into_response()
}

/// `POST /convert`: search rows straight into CRM, one at a time (leads
/// that share a company find the one the first created).
async fn convert_leads(
    State(state): State<DataState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (leads, create_company) = match validate(&headers, &body, |issues, body| {
        let leads = read_leads(issues, body, Presence::Required, Some(1));
        let flag = create_company_flag(issues, body);
        (leads.into_option(), flag)
    }) {
        Ok((Some(leads), flag)) => (leads, flag),
        Ok((None, _)) => return ApiError::internal().into_response(),
        Err(bad) => return *bad,
    };
    let (mut people, mut companies) = (0, 0);
    for lead in &leads {
        let made =
            match service::convert_search_lead(&caller.db, lead, create_company, &caller.user_id)
                .await
            {
                Ok(made) => made,
                Err(error) => return internal(&error, "Failed to convert leads"),
            };
        if made.created_company && made.company_id.is_some() {
            companies += 1;
        }
        if made.created_person && made.person_id.is_some() {
            people += 1;
        }
        emit_created(&state, &caller, &made, lead);
    }
    Data(json!({ "converted": leads.len(), "people": people, "companies": companies }))
        .into_response()
}

/// `convertToCrmListSchema`, its refinement included.
struct ToList {
    list_id: String,
    leads: Vec<Map<String, Value>>,
    lead_ids: Vec<String>,
    create_company: bool,
}

fn read_to_list(issues: &mut Issues, body: &Map<String, Value>) -> Option<ToList> {
    let before = issues.count();
    let list_id = issues.string(body, "listId", true, Some(1), None);
    let leads = read_leads(issues, body, Presence::Optional, None);
    let lead_ids = issues.list(
        body,
        "leadIds",
        Presence::Optional,
        None,
        Some(200),
        |issues, item| issues.item_text(item, Text::default()),
    );
    let create_company = create_company_flag(issues, body);
    // The refinement runs unless a field failed its type (a length check
    // failing does not stop it).
    let aborted = issues.issues_since(before).iter().any(|issue| {
        !matches!(
            issue["code"].as_str(),
            Some("too_small" | "too_big" | "invalid_string")
        )
    });
    let length = |key: &str| body.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    if !aborted && length("leads") + length("leadIds") == 0 {
        issues.custom_root("Provide at least one lead");
    }
    Some(ToList {
        list_id: list_id?,
        leads: leads.into_option().unwrap_or_default(),
        lead_ids: lead_ids.into_option().unwrap_or_default(),
        create_company,
    })
}

/// `POST /convert-to-list`: leads (saved, then inline) into CRM and onto a
/// CRM list, the person or the company by the list's kind.
async fn convert_to_list(
    State(state): State<DataState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_to_list) {
        Ok(Some(input)) => input,
        Ok(None) => return ApiError::internal().into_response(),
        Err(bad) => return *bad,
    };
    match to_list(&state, &caller, &input).await {
        Ok(Some((converted, added))) => {
            Data(json!({ "converted": converted, "added": added })).into_response()
        }
        Ok(None) => not_found("List", &input.list_id),
        Err(error) => internal(&error, "Failed to add leads to CRM list"),
    }
}

async fn to_list(
    state: &DataState,
    caller: &Caller,
    input: &ToList,
) -> Result<Option<(usize, usize)>, service::ServiceError> {
    let Some(kind) = service::crm_list_kind(&caller.db, &input.list_id).await? else {
        return Ok(None);
    };
    let pick = |made: &Materialised| {
        if kind == "company" {
            made.company_id.clone()
        } else {
            made.person_id.clone()
        }
    };
    let mut entity_ids = Vec::new();
    let mut converted = 0;
    for id in &input.lead_ids {
        let Some(Value::Object(lead)) = service::get_lead(&caller.db, id).await? else {
            continue;
        };
        let result =
            service::convert_lead(&caller.db, &lead, input.create_company, &caller.user_id).await?;
        converted += 1;
        emit_created(state, caller, &result.made, &lead);
        entity_ids.extend(pick(&result.made));
    }
    for lead in &input.leads {
        let made =
            service::convert_search_lead(&caller.db, lead, input.create_company, &caller.user_id)
                .await?;
        converted += 1;
        emit_created(state, caller, &made, lead);
        entity_ids.extend(pick(&made));
    }
    let added = service::add_crm_list_members(&caller.db, &input.list_id, &entity_ids).await?;
    Ok(Some((converted, added)))
}

// ── enrichment columns, cells and runs ──────────────────────────────────────

const ACTION_TYPES: [&str; 3] = ["ai", "email_finder", "phone_finder"];

/// `columnConfigSchema`: the discriminated union of the action configs, as
/// Zod outputs the chosen one (defaults applied, other keys dropped).
fn read_config(issues: &mut Issues, body: &Map<String, Value>, presence: Presence) -> Field<Value> {
    issues.nested(body, "config", presence, |issues, fields| {
        let mut config = Map::new();
        let kind = fields
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !ACTION_TYPES.contains(&kind) {
            issues.invalid_discriminator("type", &ACTION_TYPES);
            return Value::Null;
        }
        config.insert("type".into(), json!(kind));
        match kind {
            "ai" => {
                if let Some(prompt) = issues.string(fields, "prompt", true, Some(1), Some(8000)) {
                    config.insert("prompt".into(), json!(prompt));
                }
                if let Some(model) = issues.string(fields, "model", false, None, None) {
                    config.insert("model".into(), json!(model));
                }
                let tokens = Number {
                    int: true,
                    min: Some(1.0),
                    max: Some(4096.0),
                    ..Number::default()
                };
                if let Field::Set(max) =
                    issues.whole_number(fields, "maxTokens", Presence::Optional, tokens)
                {
                    config.insert("maxTokens".into(), json!(max));
                }
                if let Field::Set(web) = issues.boolean(fields, "webSearch", Presence::Optional) {
                    config.insert("webSearch".into(), json!(web));
                }
            }
            "email_finder" => {
                let provider = issues
                    .choice(
                        fields,
                        "provider",
                        Presence::Optional,
                        &["findymail", "prospeo"],
                    )
                    .into_option()
                    .unwrap_or_else(|| "findymail".to_owned());
                config.insert("provider".into(), json!(provider));
            }
            _ => {
                let source = issues
                    .choice(fields, "source", Presence::Optional, &["website"])
                    .into_option()
                    .unwrap_or_else(|| "website".to_owned());
                config.insert("source".into(), json!(source));
                if let Field::Set(fallback) =
                    issues.boolean(fields, "webSearchFallback", Presence::Optional)
                {
                    config.insert("webSearchFallback".into(), json!(fallback));
                }
            }
        }
        Value::Object(config)
    })
}

/// The data of a column's events.
fn column_event(column: &Value) -> Value {
    json!({
        "id": column["id"],
        "listId": column["listId"],
        "name": column["name"],
        "type": column["type"],
    })
}

/// `GET /lists/:id/columns`.
async fn list_columns(caller: Caller, Path(id): Path<String>) -> Response {
    match service::list_columns(&caller.db, &id).await {
        Ok(columns) => Data(columns).into_response(),
        Err(error) => internal(&error, "Failed to list columns"),
    }
}

/// `POST /lists/:id/columns`.
async fn create_column(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let name = issues.string(body, "name", true, Some(1), Some(255));
        let config = read_config(issues, body, Presence::Required);
        (name, config.into_option())
    });
    let (name, config) = match input {
        Ok((Some(name), Some(config))) => (name, config),
        Ok(_) => return ApiError::internal().into_response(),
        Err(bad) => return *bad,
    };
    match service::create_column(&caller.db, &id, &name, &config, &caller.user_id).await {
        Ok(Some(column)) => {
            let column_id = text(&column, "id").unwrap_or_default().to_owned();
            caller.publish(
                &state,
                WELDDATA_COLUMN_CREATED,
                &column_id,
                column_event(&column),
            );
            Created(column).into_response()
        }
        Ok(None) => not_found("WeldData list", &id),
        Err(error) => internal(&error, "Failed to create column"),
    }
}

/// `PATCH /columns/:id`: `name`, `config` (and its type), `sortOrder`.
async fn update_column(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let name = issues.string(body, "name", false, Some(1), Some(255));
        let config = read_config(issues, body, Presence::Optional).into_option();
        let sort_order = issues
            .integer(body, "sortOrder", Presence::Optional, None)
            .into_option();
        (name, config, sort_order)
    });
    let (name, config, sort_order) = match input {
        Ok(input) => input,
        Err(bad) => return *bad,
    };
    match service::update_column(
        &caller.db,
        &id,
        name.as_deref(),
        sort_order,
        config.as_ref(),
    )
    .await
    {
        Ok(Some(column)) => {
            let column_id = text(&column, "id").unwrap_or_default().to_owned();
            caller.publish(
                &state,
                WELDDATA_COLUMN_UPDATED,
                &column_id,
                column_event(&column),
            );
            Data(column).into_response()
        }
        Ok(None) => not_found("Column", &id),
        Err(error) => internal(&error, "Failed to update column"),
    }
}

/// `DELETE /columns/:id`: the column, and its cells.
async fn delete_column(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match service::delete_column(&caller.db, &id).await {
        Ok(true) => {
            caller.publish(&state, WELDDATA_COLUMN_DELETED, &id, json!({ "id": id }));
            NoContent.into_response()
        }
        Ok(false) => not_found("Column", &id),
        Err(error) => internal(&error, "Failed to delete column"),
    }
}

/// `GET /lists/:id/cells`.
async fn list_cells(caller: Caller, Path(id): Path<String>) -> Response {
    match service::list_cells(&caller.db, &id).await {
        Ok(cells) => Data(cells).into_response(),
        Err(error) => internal(&error, "Failed to list cells"),
    }
}

/// `WELDDATA_ENRICH.create({ params })` for these leads of a column.
fn run_params(
    caller: &Caller,
    org_id: &str,
    list_id: &str,
    column_id: &str,
    lead_ids: &[String],
) -> Value {
    json!({
        "params": {
            "workspaceId": org_id,
            "userId": caller.user_id,
            "listId": list_id,
            "columnId": column_id,
            "leadIds": lead_ids,
        }
    })
}

/// `POST /lists/:id/columns/:columnId/run`: queue a column over the list's
/// leads (or those given), in the background.
async fn run_column(
    State(state): State<DataState>,
    caller: Caller,
    Path((list_id, column_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let lead_ids = issues.list(
            body,
            "leadIds",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        );
        let only_missing = issues.boolean(body, "onlyMissing", Presence::Optional);
        (
            lead_ids.into_option(),
            only_missing.into_option().unwrap_or(false),
        )
    });
    let (lead_ids, only_missing) = match input {
        Ok(input) => input,
        Err(bad) => return *bad,
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let failed = |error: &dyn std::fmt::Display| internal(error, "Failed to queue column run");
    let column = match service::get_column(&caller.db, &column_id).await {
        Ok(Some(column)) if text(&column, "listId") == Some(list_id.as_str()) => column,
        Ok(_) => return not_found("Column", &column_id),
        Err(error) => return failed(&error),
    };
    let targets = match service::resolve_target_lead_ids(
        &caller.db,
        &list_id,
        &column_id,
        lead_ids,
        only_missing,
    )
    .await
    {
        Ok(targets) => targets,
        Err(error) => return failed(&error),
    };
    if targets.is_empty() {
        return Data(json!({ "queued": 0 })).into_response();
    }
    let Some(runs) = caller.enrich_runs(&state) else {
        return ApiError::internal()
            .with_message("Enrichment is not configured")
            .into_response();
    };
    if let Err(error) = service::mark_cells_pending(&caller.db, &column_id, &targets).await {
        return failed(&error);
    }
    let params = run_params(&caller, &org_id, &list_id, &column_id, &targets);
    if let Err(error) = runs.create(&params).await {
        return failed(&error);
    }
    caller.publish(
        &state,
        WELDDATA_COLUMN_RUN,
        &column_id,
        json!({
            "id": column_id,
            "listId": list_id,
            "name": column["name"],
            "type": column["type"],
            "count": targets.len(),
        }),
    );
    Data(json!({ "queued": targets.len() })).into_response()
}

/// `POST /cells/run`: queue one cell again.
async fn run_cell(
    State(state): State<DataState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let column_id = issues.string(body, "columnId", true, None, None);
        let lead_id = issues.string(body, "leadId", true, None, None);
        column_id.zip(lead_id)
    });
    let (column_id, lead_id) = match input {
        Ok(Some(ids)) => ids,
        Ok(None) => return ApiError::internal().into_response(),
        Err(bad) => return *bad,
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let failed = |error: &dyn std::fmt::Display| internal(error, "Failed to queue cell run");
    let column = match service::get_column(&caller.db, &column_id).await {
        Ok(Some(column)) => column,
        Ok(None) => return not_found("Column", &column_id),
        Err(error) => return failed(&error),
    };
    let Some(runs) = caller.enrich_runs(&state) else {
        return ApiError::internal()
            .with_message("Enrichment is not configured")
            .into_response();
    };
    let targets = vec![lead_id];
    if let Err(error) = service::mark_cells_pending(&caller.db, &column_id, &targets).await {
        return failed(&error);
    }
    let list_id = text(&column, "listId").unwrap_or_default();
    let params = run_params(&caller, &org_id, list_id, &column_id, &targets);
    if let Err(error) = runs.create(&params).await {
        return failed(&error);
    }
    Data(json!({ "queued": 1 })).into_response()
}
