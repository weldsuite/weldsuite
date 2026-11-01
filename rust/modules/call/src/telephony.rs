//! `/api/telephony` (`routes/telephony`): the workspace's Telnyx numbers
//! (display name, default, removal, searching, buying, syncing), Telnyx
//! addresses, ordering requirements and documents, and the price list.
//!
//! Buying a number is a Stripe Checkout through Global's billing-worker,
//! which the Kubernetes editions don't have: `provision` checks what the
//! worker checks before that call (Telnyx configured, the address, a
//! price), then answers as the worker does when billing-worker cannot be
//! reached. Removing a number releases nothing there either: no number
//! was bought through Stripe here (`/config.json` lists
//! `phone-number-purchase` as unavailable).

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    VOIP_PHONE_NUMBER_CREATED, VOIP_PHONE_NUMBER_DELETED, VOIP_PHONE_NUMBER_UPDATED,
};
use weldsuite_kit::validation::{Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data};

use crate::calls::query_param;
use crate::numbers::{self, PriceRow};
use crate::porting::{FormFile, read_form_file};
use crate::registry::{self, Entry};
use crate::telnyx::{Body, COUNTRIES_REQUIRING_ADDRESS};
use crate::{CallState, Caller, internal, js, now, validate};

const NOT_ACTIVATED: &str = "Phone service is not activated";

/// `GET /api/telephony/configured`.
pub(crate) async fn configured(State(state): State<CallState>, caller: Caller) -> Response {
    Data(json!({ "configured": caller.telnyx(&state).configured() })).into_response()
}

/// A live number: `(phoneNumber, status, countryCode, numberType)`.
type LiveNumber = (String, String, String, Option<String>);

async fn live_number(caller: &Caller, id: &str) -> Result<Option<LiveNumber>, sqlx::Error> {
    sqlx::query_as(
        "select phone_number, status, country_code, number_type from voip_phone_numbers
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await
}

/// `PUT /api/telephony/phone-numbers/:id { displayName?, isDefault? }`.
pub(crate) async fn update_number(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (display_name, is_default) = match validate(&headers, &body, |issues, fields| {
        (
            issues.text_with(fields, "displayName", Presence::Nullish, Text::default()),
            issues
                .boolean(fields, "isDefault", Presence::Optional)
                .into_option(),
        )
    }) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let result = async {
        let Some((phone, status, _, _)) = live_number(&caller, &id).await? else {
            return Ok(ApiError::not_found("Phone number", Some(&id)).into_response());
        };
        sqlx::query(
            "update voip_phone_numbers set updated_at = $2::timestamp,
                 display_name = case when $3 then $4 else display_name end,
                 is_default = coalesce($5, is_default)
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(!display_name.is_absent())
        .bind(display_name.as_set())
        .bind(is_default)
        .execute(&caller.db)
        .await?;
        caller.publish(
            &state,
            VOIP_PHONE_NUMBER_UPDATED,
            &id,
            &json!({ "id": id, "phoneNumber": phone, "status": status }),
        );
        Ok::<_, sqlx::Error>(Data(json!({ "success": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to update phone number"))
}

/// `DELETE /api/telephony/phone-numbers/:id`: a soft delete, and the number
/// leaves the inbound registry.
pub(crate) async fn delete_number(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some((phone, status, _, _)) = live_number(&caller, &id).await? else {
            return Ok(ApiError::not_found("Phone number", Some(&id)).into_response());
        };
        // The worker asks billing-worker to drop the number's Stripe price
        // here, ignoring any failure; billing is Global-only.
        let now = now();
        sqlx::query(
            "update voip_phone_numbers set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        if let Err(error) = registry::deactivate(caller.master(&state).as_ref(), &phone).await {
            tracing::error!(%error, "[Telephony] Failed to deactivate phone registry");
        }
        caller.publish(
            &state,
            VOIP_PHONE_NUMBER_DELETED,
            &id,
            &json!({ "id": id, "phoneNumber": phone, "status": status }),
        );
        Ok::<_, sqlx::Error>(Data(json!({ "success": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete phone number"))
}

/// `POST /api/telephony/phone-numbers/:id/set-default`.
pub(crate) async fn set_default(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some((phone, status, _, _)) = live_number(&caller, &id).await? else {
            return Ok(ApiError::not_found("Phone number", Some(&id)).into_response());
        };
        let now = now();
        sqlx::query(
            "update voip_phone_numbers set is_default = false, updated_at = $2::timestamp
             where is_default = true and deleted_at is null and id <> $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        sqlx::query(
            "update voip_phone_numbers set is_default = true, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        caller.publish(
            &state,
            VOIP_PHONE_NUMBER_UPDATED,
            &id,
            &json!({ "id": id, "phoneNumber": phone, "status": status }),
        );
        Ok::<_, sqlx::Error>(Data(json!({ "success": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to set default phone number"))
}

/// `searchSchema`.
struct Search {
    country: String,
    area_code: Option<String>,
    contains: Option<String>,
    kind: String,
    limit: f64,
}

fn read_search(issues: &mut Issues, fields: &Map<String, Value>) -> Search {
    Search {
        country: issues
            .text(fields, "country", Presence::Required, Some(2), Some(2))
            .into_option()
            .unwrap_or_default(),
        area_code: issues
            .text_with(fields, "areaCode", Presence::Optional, Text::default())
            .into_option(),
        contains: issues
            .text_with(fields, "contains", Presence::Optional, Text::default())
            .into_option(),
        kind: issues
            .choice(
                fields,
                "type",
                Presence::Optional,
                &["local", "toll-free", "mobile"],
            )
            .into_option()
            .unwrap_or_else(|| "local".to_owned()),
        limit: issues
            .number(
                fields,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    min: Some(1.0),
                    max: Some(50.0),
                    ..Number::default()
                },
            )
            .into_option()
            .unwrap_or(20.0),
    }
}

/// `POST /api/telephony/phone-numbers/search`: available numbers on Telnyx,
/// priced with the price list's markup.
pub(crate) async fn search(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_search) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return ApiError::bad_request(NOT_ACTIVATED).into_response();
    }
    let result = async {
        let limit = js::number(data.limit);
        let kind = match data.kind.as_str() {
            "toll-free" => "toll_free",
            "mobile" => "mobile",
            _ => "local",
        };
        let mut pairs: Vec<(&str, &str)> = vec![
            ("filter[country_code]", &data.country),
            ("filter[limit]", &limit),
            ("filter[features][]", "voice"),
            ("filter[phone_number_type]", kind),
        ];
        if let Some(area) = data.area_code.as_deref().filter(|a| !a.is_empty()) {
            pairs.push(("filter[national_destination_code]", area));
        }
        if let Some(contains) = data.contains.as_deref().filter(|c| !c.is_empty()) {
            pairs.push(("filter[phone_number][contains]", contains));
        }
        let response = telnyx
            .request(
                "GET",
                &format!("/available_phone_numbers?{}", js::search_params(&pairs)),
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        let mapped: Vec<Value> = response["data"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| numbers::map_available(r, &data.country))
                    .collect()
            })
            .unwrap_or_default();
        let master = caller.master(&state).ok_or("no master database")?;
        let rows = numbers::price_list(&master, false)
            .await
            .map_err(|e| e.to_string())?;
        let numbers: Vec<Value> = mapped
            .into_iter()
            .map(|mut number| {
                let iso = number["iso_country"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let markup = numbers::resolve_markup(&rows, &iso, &data.kind);
                if let Some(cost) = number.get("cost_information").cloned() {
                    number["cost_information"] =
                        numbers::apply_markup_to_cost(&cost, markup.as_ref());
                }
                number
            })
            .collect();
        Ok::<_, String>(json!({ "numbers": numbers }))
    }
    .await;
    match result {
        Ok(found) => Data(found).into_response(),
        Err(error) => internal(&error, "Failed to search phone numbers"),
    }
}

/// `provisionSchema`.
struct Provision {
    phone_number: String,
    country_code: String,
    number_type: String,
    address_id: Option<String>,
}

fn read_provision(issues: &mut Issues, fields: &Map<String, Value>) -> Provision {
    let phone_number = issues
        .text(fields, "phoneNumber", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    issues.text_with(fields, "friendlyName", Presence::Optional, Text::default());
    issues.text_with(fields, "displayName", Presence::Optional, Text::default());
    let country_code = issues
        .text(fields, "countryCode", Presence::Required, Some(2), Some(2))
        .into_option()
        .unwrap_or_default();
    let number_type = issues
        .choice(
            fields,
            "numberType",
            Presence::Optional,
            &["local", "toll-free", "mobile"],
        )
        .into_option()
        .unwrap_or_else(|| "local".to_owned());
    let address_id = issues
        .text_with(fields, "addressId", Presence::Optional, Text::default())
        .into_option();
    Provision {
        phone_number,
        country_code,
        number_type,
        address_id,
    }
}

/// `c.json({ error: { code: 'ADDRESS_REQUIRED', message, details } }, 400)`.
fn address_required_error(message: &str) -> Response {
    ApiError::new(http::StatusCode::BAD_REQUEST, "ADDRESS_REQUIRED", message)
        .with_details(json!({ "requiresAddress": true }))
        .into_response()
}

/// `POST /api/telephony/phone-numbers/provision`: on Global a Stripe
/// Checkout for the number; here the checks before it, then billing-worker's
/// absence.
pub(crate) async fn provision(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_provision) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return ApiError::bad_request(NOT_ACTIVATED).into_response();
    }
    let upper = data.country_code.to_uppercase();
    if COUNTRIES_REQUIRING_ADDRESS.contains(&upper.as_str())
        && data.address_id.as_deref().is_none_or(str::is_empty)
    {
        return address_required_error(&format!(
            "Phone numbers in {} require a verified address.",
            data.country_code
        ));
    }
    let priced = async {
        let master = caller.master(&state).ok_or("no master database")?;
        let rows: Vec<PriceRow> = numbers::price_list(&master, false)
            .await
            .map_err(|e| e.to_string())?;
        numbers::has_customer_price(
            &telnyx,
            &rows,
            &data.country_code,
            &data.number_type,
            &data.phone_number,
        )
        .await
        .map_err(|e| e.to_string())
    }
    .await;
    let failed = |message: &str| {
        if message.contains("address") || message.contains("regulatory") {
            return address_required_error("Address or regulatory document required");
        }
        internal(&message, "Failed to provision phone number")
    };
    match priced {
        Ok(true) => {
            // billing-worker (`POST /api/billing/phone/checkout`) is
            // Global-only: answer as when it cannot be reached.
            tracing::warn!("telephony: no billing-worker on this edition, checkout refused");
            failed("fetch failed")
        }
        Ok(false) => ApiError::bad_request("No pricing configured for this phone number type")
            .into_response(),
        Err(error) => failed(&error),
    }
}

/// A number on the Telnyx account (`GET /phone_numbers`).
struct AccountNumber {
    id: Value,
    phone_number: String,
    connection_id: Value,
}

/// `POST /api/telephony/phone-numbers/sync`: the account's active numbers
/// into the workspace (and the inbound registry).
#[allow(clippy::too_many_lines)] // the route, step by step
pub(crate) async fn sync(State(state): State<CallState>, caller: Caller) -> Response {
    let telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return ApiError::bad_request(NOT_ACTIVATED).into_response();
    }
    let result = async {
        let connection = caller.env("TELNYX_CONNECTION_ID");
        let mut pairs: Vec<(&str, &str)> = vec![("page[size]", "250"), ("filter[status]", "active")];
        if let Some(connection) = connection.as_deref() {
            pairs.push(("filter[connection_id]", connection));
        }
        let response = telnyx
            .request(
                "GET",
                &format!("/phone_numbers?{}", js::search_params(&pairs)),
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        let numbers: Vec<Value> = response["data"].as_array().cloned().unwrap_or_default();
        if numbers.is_empty() {
            return Ok(json!({ "count": 0 }));
        }
        let existing: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "select id, phone_number, provider_phone_number_id from voip_phone_numbers
             where deleted_at is null",
        )
        .fetch_all(&caller.db)
        .await
        .map_err(|e| e.to_string())?;
        let master = caller.master(&state);
        let org = caller.clerk_org_id.clone().unwrap_or_default();
        let mut synced = 0;
        for raw in numbers {
            let Some(phone) = raw["phone_number"].as_str().map(str::to_owned) else {
                tracing::error!("[Telephony] Failed to sync a number without a phone number");
                continue;
            };
            let number = AccountNumber {
                id: raw["id"].clone(),
                phone_number: phone,
                connection_id: raw["connection_id"].clone(),
            };
            let found = existing.iter().find(|(_, existing_phone, provider_id)| {
                provider_id
                    .as_deref()
                    .is_some_and(|p| number.id.as_str() == Some(p))
                    || *existing_phone == number.phone_number
            });
            let text = |value: &Value| match value {
                Value::Null => None,
                Value::String(text) => Some(text.clone()),
                other => Some(other.to_string()),
            };
            let written = async {
                let id = if let Some((id, _, _)) = found {
                    sqlx::query(
                        "update voip_phone_numbers set status = 'active',
                             provider_phone_number_id = case when $2 then $3 else provider_phone_number_id end,
                             provider_connection_id = case when $4 then $5 else provider_connection_id end,
                             updated_at = $6::timestamp
                         where id = $1",
                    )
                    .bind(id)
                    .bind(raw.get("id").is_some())
                    .bind(text(&number.id))
                    .bind(raw.get("connection_id").is_some())
                    .bind(text(&number.connection_id))
                    .bind(now())
                    .execute(&caller.db)
                    .await?;
                    id.clone()
                } else {
                    let id = weldsuite_kit::generate_id("vpn");
                    let now = now();
                    sqlx::query(
                        "insert into voip_phone_numbers (id, provider, phone_number, formatted_number,
                             country_code, number_type, status, provider_phone_number_id,
                             provider_connection_id, is_default, created_at, updated_at)
                         values ($1, 'telnyx', $2, $2, $3, 'local', 'active', $4, $5, false,
                             $6::timestamp, $6::timestamp)",
                    )
                    .bind(&id)
                    .bind(&number.phone_number)
                    .bind(if number.phone_number.starts_with("+1") { "US" } else { "INTL" })
                    .bind(text(&number.id))
                    .bind(text(&number.connection_id))
                    .bind(&now)
                    .execute(&caller.db)
                    .await?;
                    caller.publish(
                        &state,
                        VOIP_PHONE_NUMBER_CREATED,
                        &id,
                        &json!({ "id": id, "phoneNumber": number.phone_number, "status": "active" }),
                    );
                    id
                };
                Ok::<_, sqlx::Error>(id)
            }
            .await;
            match written {
                Ok(id) => {
                    if let Err(error) = registry::upsert(
                        master.as_ref(),
                        Entry {
                            phone_number: &number.phone_number,
                            clerk_org_id: &org,
                            voip_phone_number_id: &id,
                            is_active: true,
                        },
                    )
                    .await
                    {
                        tracing::error!(%error, "[Telephony] Failed to register a number");
                    }
                    synced += 1;
                }
                Err(error) => tracing::error!(%error, "[Telephony] Failed to sync a number"),
            }
        }
        Ok::<_, String>(json!({ "count": synced }))
    }
    .await;
    match result {
        Ok(count) => Data(count).into_response(),
        Err(error) => internal(&error, "Failed to refresh phone numbers"),
    }
}

/// `GET /api/telephony/addresses`.
pub(crate) async fn addresses(State(state): State<CallState>, caller: Caller) -> Response {
    let telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return Data(json!({ "addresses": [] })).into_response();
    }
    match telnyx.request("GET", "/addresses", None).await {
        Ok(response) => {
            let list = if js::truthy(&response["data"]) {
                response["data"].clone()
            } else {
                json!([])
            };
            Data(json!({ "addresses": list })).into_response()
        }
        Err(error) => internal(&error, "Failed to list addresses"),
    }
}

/// `POST /api/telephony/addresses`: a Telnyx address (address book).
pub(crate) async fn create_address(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let address = match validate(&headers, &body, |issues, fields| {
        let mut out = Map::new();
        let mut required = |issues: &mut Issues, key: &str, target: &str| {
            if let Some(value) = issues
                .text(fields, key, Presence::Required, Some(1), None)
                .into_option()
            {
                out.insert(target.to_owned(), json!(value));
            }
        };
        required(issues, "businessName", "business_name");
        required(issues, "firstName", "first_name");
        required(issues, "lastName", "last_name");
        required(issues, "streetAddress", "street_address");
        if let Some(extended) = issues
            .text_with(
                fields,
                "extendedAddress",
                Presence::Optional,
                Text::default(),
            )
            .into_option()
        {
            out.insert("extended_address".to_owned(), json!(extended));
        }
        if let Some(locality) = issues
            .text(fields, "locality", Presence::Required, Some(1), None)
            .into_option()
        {
            out.insert("locality".to_owned(), json!(locality));
        }
        let area = issues
            .text_with(
                fields,
                "administrativeArea",
                Presence::Optional,
                Text::default(),
            )
            .into_option()
            .unwrap_or_default();
        out.insert("administrative_area".to_owned(), json!(area));
        if let Some(postal) = issues
            .text(fields, "postalCode", Presence::Required, Some(1), None)
            .into_option()
        {
            out.insert("postal_code".to_owned(), json!(postal));
        }
        if let Some(country) = issues
            .text(fields, "countryCode", Presence::Required, Some(2), Some(2))
            .into_option()
        {
            out.insert("country_code".to_owned(), json!(country));
        }
        out.insert("address_book".to_owned(), json!(true));
        out
    }) {
        Ok(address) => address,
        Err(response) => return *response,
    };
    let telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return ApiError::bad_request(NOT_ACTIVATED).into_response();
    }
    match telnyx
        .request(
            "POST",
            "/addresses",
            Some(Body::Json(Value::Object(address))),
        )
        .await
    {
        Ok(response) => {
            let mut body = Map::new();
            if let Some(data) = response.get("data") {
                body.insert("address".to_owned(), data.clone());
            }
            Created(Value::Object(body)).into_response()
        }
        Err(error) => internal(&error, "Failed to create address"),
    }
}

/// `GET /api/telephony/bundles`: Telnyx has none.
pub(crate) async fn bundles() -> Response {
    Data(json!({ "bundles": [] })).into_response()
}

/// `GET /api/telephony/requirements?countryCode=&numberType=`.
pub(crate) async fn requirements(
    State(state): State<CallState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    let telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return Data(json!({ "requirements": [] })).into_response();
    }
    let query = query_values(query.as_deref());
    let Some(country) = query_param(&query, "countryCode").filter(|c| !c.is_empty()) else {
        return ApiError::bad_request("countryCode query parameter is required").into_response();
    };
    let kind = query_param(&query, "numberType")
        .filter(|k| !k.is_empty())
        .unwrap_or_else(|| "local".to_owned());
    match numbers::ordering_requirements(&telnyx, &country, &kind).await {
        Ok(list) => Data(json!({ "requirements": list })).into_response(),
        Err(error) => internal(&error, "Failed to list requirements"),
    }
}

/// `GET /api/telephony/phone-numbers/:id/regulatory-requirements`: what the
/// number's Telnyx order still owes.
pub(crate) async fn order_requirements(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return Data(json!({ "requirementsMet": true, "requirements": [] })).into_response();
    }
    let result = async {
        let Some((phone, status, country, kind)) =
            live_number(&caller, &id).await.map_err(|e| e.to_string())?
        else {
            return Ok(ApiError::not_found("Phone number", Some(&id)).into_response());
        };
        let kind = kind
            .filter(|k| !k.is_empty())
            .unwrap_or_else(|| "local".to_owned());
        let pending = numbers::pending_requirements(&telnyx, &id, &phone, &country, &kind)
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(match pending {
            Some(pending) => Data(pending).into_response(),
            None => Data(json!({ "requirementsMet": status == "active", "requirements": [] }))
                .into_response(),
        })
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to list regulatory requirements"))
}

/// `submitRequirementsSchema`: `(requirementId, fieldValue)` pairs.
fn read_values(issues: &mut Issues, fields: &Map<String, Value>) -> Vec<(String, String)> {
    issues
        .list(
            fields,
            "values",
            Presence::Required,
            Some(1),
            None,
            |issues, item| {
                let fields = issues.object(item)?;
                let id = issues
                    .text(fields, "requirementId", Presence::Required, Some(1), None)
                    .into_option();
                let value = issues
                    .text(fields, "fieldValue", Presence::Required, Some(1), None)
                    .into_option();
                id.zip(value)
            },
        )
        .into_option()
        .unwrap_or_default()
}

/// `POST /api/telephony/phone-numbers/:id/regulatory-requirements { values }`:
/// documents and answers for a paid order; the number goes live once
/// Telnyx has everything.
pub(crate) async fn submit_order_requirements(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let values = match validate(&headers, &body, read_values) {
        Ok(values) => values,
        Err(response) => return *response,
    };
    let telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return ApiError::bad_request(NOT_ACTIVATED).into_response();
    }
    let result = async {
        let Some((phone, status, country, kind)) =
            live_number(&caller, &id).await.map_err(|e| e.to_string())?
        else {
            return Ok(ApiError::not_found("Phone number", Some(&id)).into_response());
        };
        let kind = kind.filter(|k| !k.is_empty()).unwrap_or_else(|| "local".to_owned());
        let Some(pending) = numbers::pending_requirements(&telnyx, &id, &phone, &country, &kind)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(ApiError::bad_request("No Telnyx order found for this number").into_response());
        };
        let line = js::string(&pending["phoneNumberOrderId"]);
        let met = numbers::submit_requirements(&telnyx, &line, &values)
            .await
            .map_err(|e| e.to_string())?;
        if met && status != "active" {
            sqlx::query(
                "update voip_phone_numbers set status = 'active', updated_at = $2::timestamp where id = $1",
            )
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await
            .map_err(|e| e.to_string())?;
            if let Err(error) = registry::upsert(
                caller.master(&state).as_ref(),
                Entry {
                    phone_number: &phone,
                    clerk_org_id: caller.clerk_org_id.as_deref().unwrap_or_default(),
                    voip_phone_number_id: &id,
                    is_active: true,
                },
            )
            .await
            {
                tracing::error!(%error, "[Telephony] Registry activate after documents failed");
            }
            caller.publish(
                &state,
                VOIP_PHONE_NUMBER_UPDATED,
                &id,
                &json!({ "id": id, "phoneNumber": phone, "status": "active" }),
            );
        }
        Ok::<_, String>(Data(json!({ "requirementsMet": met })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| {
        tracing::error!(%error, "[Telephony] Failed to submit order requirements");
        ApiError::internal().with_message(error).into_response()
    })
}

/// `POST /api/telephony/documents` (multipart, `file`): the file uploaded
/// to Telnyx, for an order's requirements.
pub(crate) async fn upload_document(
    State(state): State<CallState>,
    caller: Caller,
    request: axum::extract::Request,
) -> Response {
    let telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return ApiError::bad_request(NOT_ACTIVATED).into_response();
    }
    let file: Option<FormFile> = match read_form_file(request).await {
        Ok(file) => file,
        Err(message) => return ApiError::internal().with_message(message).into_response(),
    };
    let Some(file) = file else {
        return ApiError::bad_request("file is required").into_response();
    };
    let uploaded = telnyx
        .request(
            "POST",
            "/documents",
            Some(Body::File {
                name: file.name.clone(),
                content_type: file.content_type.clone(),
                bytes: file.bytes,
            }),
        )
        .await;
    match uploaded {
        Ok(response) => {
            let data = &response["data"];
            if !js::truthy(&data["id"]) {
                return ApiError::internal()
                    .with_message("Telnyx did not return a document id")
                    .into_response();
            }
            let filename = if js::truthy(&data["filename"]) {
                data["filename"].clone()
            } else {
                json!(file.name)
            };
            Data(json!({ "id": data["id"], "filename": filename })).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "[Telephony] Failed to upload document");
            ApiError::internal()
                .with_message(error.to_string())
                .into_response()
        }
    }
}

/// `GET /api/telephony/pricing`: the price list with markup, without the
/// default row.
pub(crate) async fn pricing(State(state): State<CallState>, caller: Caller) -> Response {
    let Some(master) = caller.master(&state) else {
        return internal(&"no master database", "Failed to fetch pricing");
    };
    match numbers::price_list(&master, true).await {
        Ok(rows) => {
            let pricing: Vec<Value> = rows
                .iter()
                .filter(|r| !numbers::is_default_pricing(&r.country_code, &r.number_type))
                .map(|r| {
                    let customer = numbers::apply_markup(&r.monthly_price, Some(&r.markup));
                    let setup = numbers::apply_markup(&r.setup_fee, Some(&r.markup));
                    let number =
                        |text: &str| js::json_number(weldsuite_kit::validation::js_number(text));
                    let mut row = Map::new();
                    row.insert(
                        "countryCode".to_owned(),
                        json!(r.country_code.to_uppercase()),
                    );
                    row.insert(
                        "numberType".to_owned(),
                        json!(numbers::normalize_type(&r.number_type)),
                    );
                    row.insert(
                        "monthlyPrice".to_owned(),
                        number(customer.as_deref().unwrap_or(&r.monthly_price)),
                    );
                    row.insert(
                        "setupFee".to_owned(),
                        number(setup.as_deref().unwrap_or(&r.setup_fee)),
                    );
                    row.insert("currency".to_owned(), json!(r.currency));
                    if let Some(price) = &r.stripe_price_id {
                        row.insert("stripePriceId".to_owned(), json!(price));
                    }
                    Value::Object(row)
                })
                .collect();
            Data(json!({ "pricing": pricing })).into_response()
        }
        Err(error) => internal(&error, "Failed to fetch pricing"),
    }
}

/// `GET /api/telephony/service-rates`: credits per call and transcription
/// minute.
pub(crate) async fn service_rates(State(state): State<CallState>, caller: Caller) -> Response {
    let Some(master) = caller.master(&state) else {
        return internal(&"no master database", "Failed to fetch service rates");
    };
    let found: Result<Vec<(String, String)>, sqlx::Error> = sqlx::query_as(
        "select service_type, credits_per_unit::text from telephony_service_rates where is_active = true",
    )
    .fetch_all(&master)
    .await;
    match found {
        Ok(rows) => {
            let rate = |service: &str, fallback: i64| {
                rows.iter()
                    .rev()
                    .find(|(kind, _)| kind == service)
                    .map_or(json!(fallback), |(_, credits)| {
                        js::json_number(weldsuite_kit::validation::js_number(credits))
                    })
            };
            Data(json!({
                "rates": {
                    "voipCallMinute": rate("voip_call_minute", 3),
                    "callTranscriptionMinute": rate("call_transcription_minute", 2),
                },
            }))
            .into_response()
        }
        Err(error) => internal(&error, "Failed to fetch service rates"),
    }
}

/// `GET /api/telephony/address-required/:countryCode`.
pub(crate) async fn address_required_for(Path(country): Path<String>) -> Response {
    Data(json!({
        "required": COUNTRIES_REQUIRING_ADDRESS.contains(&country.to_uppercase().as_str()),
        "countryCode": country,
    }))
    .into_response()
}
