//! `/api/porting` (`routes/porting`): porting a number from another carrier
//! into the platform's Telnyx account: a portability check, the draft and
//! its Telnyx order, the details, the LOA template, the signed LOA and a
//! bill copy (kept in the `STORAGE` bucket under
//! `port-orders/<org>/<order>/<loa|bill>.pdf` and attached on Telnyx), the
//! submission, a refresh from Telnyx and cancelling.
//!
//! Submitting bills the number through Global's billing-worker (Stripe),
//! which the Kubernetes editions don't have: `submit` checks what the
//! worker checks before that call, then answers as the worker does when
//! billing-worker cannot be reached (`/config.json` lists
//! `phone-number-purchase` as unavailable).

use std::collections::BTreeMap;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, State};
use axum::response::{IntoResponse, Response};
use http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, VOIP_PORTING_ORDER_CREATED, VOIP_PORTING_ORDER_DELETED, VOIP_PORTING_ORDER_UPDATED,
};
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data};
use weldsuite_ports::PutOptions;

use crate::telnyx::{Body, PortingBody, PortingCode, PortingError, Telnyx};
use crate::{CallState, Caller, internal, js, now, validate};

/// Uploads up to 32 MiB reach the handler, which refuses more than 10 MB
/// itself (413) as the worker does.
pub(crate) fn upload_limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(32 * 1024 * 1024)
}

/// A port document's size limit (10 MB).
const MAX_BYTES: usize = 10 * 1024 * 1024;

/// One file of a multipart form (`File`).
pub(crate) struct FormFile {
    pub(crate) name: String,
    pub(crate) content_type: String,
    pub(crate) bytes: Vec<u8>,
}

/// `(await c.req.formData()).get('file')` as a `File`: `Ok(None)` when
/// the first `file` entry is a text field or there is none, `Err` with the
/// message where `formData()` throws.
pub(crate) async fn read_form_file(
    request: axum::extract::Request,
) -> Result<Option<FormFile>, String> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if content_type.starts_with("application/x-www-form-urlencoded") {
        return Ok(None);
    }
    let mut multipart = Multipart::from_request(request, &())
        .await
        .map_err(|_| {
            "Content-Type was not one of \"multipart/form-data\" or \"application/x-www-form-urlencoded\"."
                .to_owned()
        })?;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| error.to_string())?
    {
        if field.name() != Some("file") {
            continue;
        }
        let Some(name) = field.file_name().map(str::to_owned) else {
            return Ok(None);
        };
        let content_type = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_owned();
        let bytes = field.bytes().await.map_err(|error| error.to_string())?;
        return Ok(Some(FormFile {
            name,
            content_type,
            bytes: bytes.to_vec(),
        }));
    }
    Ok(None)
}

/// `respondTelnyx(c, err, fallback)`: a Telnyx failure as the API's error.
fn respond_telnyx(error: &PortingError, fallback: &str) -> Response {
    tracing::error!(%error, "[Porting] Telnyx error");
    let PortingError::Telnyx {
        code,
        message,
        telnyx_errors,
    } = error
    else {
        return ApiError::internal().with_message(fallback).into_response();
    };
    let or = |default: &str| {
        if message.is_empty() {
            default.to_owned()
        } else {
            message.clone()
        }
    };
    match code {
        PortingCode::Unauthorized | PortingCode::Forbidden => {
            ApiError::bad_request(or("Telnyx authentication failed")).into_response()
        }
        PortingCode::NotFound => ApiError::bad_request(or(
            "Telnyx returned 404 — endpoint not available for this account",
        ))
        .into_response(),
        PortingCode::Conflict => ApiError::conflict(message.clone()).into_response(),
        PortingCode::ValidationFailed => ApiError::bad_request(message.clone())
            .with_details(telnyx_errors.clone())
            .into_response(),
        PortingCode::RateLimited => ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many requests",
        )
        .into_response(),
        PortingCode::TelnyxUnavailable => {
            ApiError::unavailable(or("Telnyx is temporarily unavailable")).into_response()
        }
        PortingCode::Unknown => ApiError::internal()
            .with_message(or(fallback))
            .into_response(),
    }
}

/// A Telnyx or other failure of a porting helper, as the route answers it.
fn telnyx_failure(error: &PortingError, fallback: &str) -> Response {
    match error {
        PortingError::Telnyx { .. } => respond_telnyx(error, fallback),
        PortingError::Other(_) => internal(error, fallback),
    }
}

fn is_editable(status: &str) -> bool {
    matches!(status, "draft" | "preflight_failed" | "awaiting_documents")
}

/// `publishPortingEvent(c, action, order)`.
fn publish(
    caller: &Caller,
    state: &CallState,
    event: EventName,
    id: &str,
    phone: &Value,
    status: &Value,
) {
    caller.publish(
        state,
        event,
        id,
        &json!({ "id": id, "phoneNumber": phone, "status": status }),
    );
}

/// A live order row, as `to_jsonb` reads it.
async fn live_order(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select to_jsonb(t) from voip_porting_orders t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await
}

/// Any order row, as Drizzle reads it.
async fn order_row(caller: &Caller, id: &str) -> Result<Value, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from voip_porting_orders t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(row.map_or(Value::Null, weldsuite_db::js_row))
}

/// `/^\+\d+$/`.
fn is_plus_digits(text: &str) -> bool {
    text.strip_prefix('+')
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

/// `phoneNumberSchema`.
fn read_phone(issues: &mut Issues, fields: &Map<String, Value>) -> Option<String> {
    issues
        .pattern(
            fields,
            "phoneNumber",
            Presence::Required,
            Some(8),
            Some(20),
            is_plus_digits,
            "Phone number must be E.164 (start with + followed by digits)",
        )
        .into_option()
}

/// `z.string().length(n)`.
fn read_exact(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    length: usize,
    presence: Presence,
) -> Option<String> {
    let value = issues
        .text_with(fields, key, presence, Text::default())
        .into_option()?;
    let actual = value.encode_utf16().count();
    if actual != length {
        issues.string_length(key, length, actual);
        return None;
    }
    Some(value)
}

/// `POST /api/porting/preflight { phoneNumber, countryCode }`: whether
/// Telnyx can port the number in.
pub(crate) async fn preflight(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let phone = match validate(&headers, &body, |issues, fields| {
        let phone = read_phone(issues, fields);
        read_exact(issues, fields, "countryCode", 2, Presence::Required);
        phone.unwrap_or_default()
    }) {
        Ok(phone) => phone,
        Err(response) => return *response,
    };
    let telnyx = caller.telnyx(&state);
    let checked = telnyx
        .porting(
            "POST",
            "/portability_checks",
            Some(Body::Json(json!({ "phone_numbers": [phone] }))),
            false,
        )
        .await;
    match checked {
        Ok(body) => {
            let body = body.json();
            let items = body["data"].as_array().cloned().unwrap_or_default();
            let portable = !items.is_empty() && items.iter().all(|i| i["portable"] == true);
            let mut reasons: Vec<String> = items
                .iter()
                .filter(|i| !js::truthy(&i["portable"]))
                .map(|i| {
                    let number = js::string(&i["phone_number"]);
                    if js::truthy(&i["not_portable_reason"]) {
                        format!("{number}: {}", js::string(&i["not_portable_reason"]))
                    } else {
                        format!("{number}: not portable")
                    }
                })
                .collect();
            if items.is_empty() {
                reasons.push("Telnyx returned no portability data for this number".to_owned());
            }
            let mut result = Map::new();
            result.insert("portable".to_owned(), json!(portable));
            result.insert("reasons".to_owned(), json!(reasons));
            if let Some(raw) = body.get("data") {
                result.insert("raw".to_owned(), raw.clone());
            }
            Data(Value::Object(result)).into_response()
        }
        Err(error) => telnyx_failure(&error, "Preflight check failed"),
    }
}

/// `POST /api/porting { phoneNumber, formattedNumber?, countryCode, numberType? }`:
/// a draft and its Telnyx porting order.
#[allow(clippy::too_many_lines)] // the route, step by step
pub(crate) async fn create(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (phone, formatted, country, kind) = match validate(&headers, &body, |issues, fields| {
        let phone = read_phone(issues, fields).unwrap_or_default();
        let formatted = issues
            .text_with(
                fields,
                "formattedNumber",
                Presence::Optional,
                Text::default(),
            )
            .into_option();
        let country =
            read_exact(issues, fields, "countryCode", 2, Presence::Required).unwrap_or_default();
        let kind = issues
            .choice(
                fields,
                "numberType",
                Presence::Optional,
                &["local", "mobile"],
            )
            .into_option()
            .unwrap_or_else(|| "local".to_owned());
        (phone, formatted, country, kind)
    }) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let existing: Option<String> = match sqlx::query_scalar(
        "select status from voip_porting_orders where phone_number = $1 and deleted_at is null limit 1",
    )
    .bind(&phone)
    .fetch_optional(&caller.db)
    .await
    {
        Ok(found) => found,
        Err(error) => return internal(&error, "Internal server error"),
    };
    if existing.is_some_and(|status| {
        !matches!(
            status.as_str(),
            "cancelled" | "exception" | "preflight_failed" | "completed"
        )
    }) {
        return ApiError::conflict(format!("An in-flight port already exists for {phone}"))
            .into_response();
    }
    let id = weldsuite_kit::generate_id("vpo");
    if let Err(error) = sqlx::query(
        "insert into voip_porting_orders (id, created_by_user_id, phone_number, formatted_number,
             country_code, number_type, status)
         values ($1, $2, $3, $4, $5, $6, 'draft')",
    )
    .bind(&id)
    .bind(&caller.user_id)
    .bind(&phone)
    .bind(formatted.as_deref().unwrap_or(&phone))
    .bind(country.to_uppercase())
    .bind(&kind)
    .execute(&caller.db)
    .await
    {
        return internal(&error, "Failed to create port order");
    }
    let telnyx = caller.telnyx(&state);
    let ordered = async {
        let order = telnyx
            .porting(
                "POST",
                "/porting_orders",
                Some(Body::Json(
                    json!({ "phone_numbers": [phone], "customer_reference": id }),
                )),
                false,
            )
            .await?
            .json();
        let data = &order["data"];
        if !data.is_object() {
            return Err(PortingError::Other(
                "Cannot read properties of undefined (reading 'id')".to_owned(),
            ));
        }
        sqlx::query(
            "update voip_porting_orders set telnyx_porting_order_id = $2,
                 status = 'awaiting_documents', substatus = $3, updated_at = $4::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(data["id"].as_str())
        .bind(data["sub_status"].as_str())
        .bind(now())
        .execute(&caller.db)
        .await
        .map_err(|error| PortingError::Other(error.to_string()))?;
        Ok(())
    }
    .await;
    if let Err(error) = ordered {
        let code = match &error {
            PortingError::Telnyx { code, .. } => code.as_str(),
            PortingError::Other(_) => "unknown",
        };
        let message = error.to_string();
        let _ = sqlx::query(
            "update voip_porting_orders set status = 'preflight_failed', last_error_code = $2,
                 last_error_message = $3, updated_at = $4::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(code)
        .bind(if message.is_empty() {
            "Unknown error"
        } else {
            &message
        })
        .bind(now())
        .execute(&caller.db)
        .await;
        return telnyx_failure(&error, "Failed to create Telnyx porting order");
    }
    let draft = match order_row(&caller, &id).await {
        Ok(draft) => draft,
        Err(error) => return internal(&error, "Internal server error"),
    };
    publish(
        &caller,
        &state,
        VOIP_PORTING_ORDER_CREATED,
        &id,
        &json!(phone),
        &draft["status"],
    );
    Created(json!({ "order": draft })).into_response()
}

/// `patchSchema`.
#[derive(Default)]
struct Details {
    authorized_name: Option<String>,
    business_name: Option<String>,
    service_address: Option<Value>,
    current_carrier: Option<String>,
    current_account_number: Option<String>,
    /// `Some(None)`: `currentPin: null`.
    #[allow(clippy::option_option)]
    current_pin: Option<Option<String>>,
    requested_foc_at: Option<String>,
}

#[allow(clippy::too_many_lines)] // the schema, field by field
fn read_details(issues: &mut Issues, fields: &Map<String, Value>) -> Details {
    let start = issues.count();
    let mut details = Details {
        authorized_name: issues
            .text(
                fields,
                "authorizedName",
                Presence::Optional,
                Some(1),
                Some(200),
            )
            .into_option(),
        business_name: issues
            .text(
                fields,
                "businessName",
                Presence::Optional,
                Some(1),
                Some(200),
            )
            .into_option(),
        ..Details::default()
    };
    let address = issues.nested(
        fields,
        "serviceAddress",
        Presence::Optional,
        |issues, address| {
            let mut out = Map::new();
            let mut put = |issues: &mut Issues,
                           key: &str,
                           presence: Presence,
                           min: Option<usize>,
                           max: usize| {
                if let Some(value) = issues
                    .text(address, key, presence, min, Some(max))
                    .into_option()
                {
                    out.insert(key.to_owned(), json!(value));
                }
            };
            put(issues, "line1", Presence::Required, Some(1), 200);
            put(issues, "line2", Presence::Optional, None, 200);
            put(issues, "city", Presence::Required, Some(1), 100);
            put(issues, "region", Presence::Required, Some(1), 100);
            put(issues, "postalCode", Presence::Required, Some(1), 20);
            if let Some(country) = read_exact(issues, address, "country", 2, Presence::Required) {
                out.insert("country".to_owned(), json!(country));
            }
            Value::Object(out)
        },
    );
    details.service_address = address.into_option();
    details.current_carrier = issues
        .text(
            fields,
            "currentCarrier",
            Presence::Optional,
            Some(1),
            Some(100),
        )
        .into_option();
    details.current_account_number = issues
        .text(
            fields,
            "currentAccountNumber",
            Presence::Optional,
            Some(1),
            Some(100),
        )
        .into_option();
    details.current_pin = match issues.text(fields, "currentPin", Presence::Nullish, None, Some(50))
    {
        weldsuite_kit::validation::Field::Absent => None,
        weldsuite_kit::validation::Field::Null => Some(None),
        weldsuite_kit::validation::Field::Set(pin) => Some(Some(pin)),
    };
    details.requested_foc_at = issues
        .text_with(
            fields,
            "requestedFocAt",
            Presence::Optional,
            Text {
                format: Some(Format::Datetime),
                ..Text::default()
            },
        )
        .into_option();
    // The refinement runs when no field failed its type check.
    let aborted = issues
        .issues_since(start)
        .iter()
        .any(|issue| issue["code"] == "invalid_type");
    let known = [
        "authorizedName",
        "businessName",
        "serviceAddress",
        "currentCarrier",
        "currentAccountNumber",
        "currentPin",
        "requestedFocAt",
    ];
    if !aborted && !known.iter().any(|key| fields.contains_key(*key)) {
        issues.custom_root("At least one field must be provided");
    }
    details
}

/// `updatePortingOrder`'s body.
fn telnyx_details(details: &Details) -> Value {
    let mut body = Map::new();
    if let Some(name) = details.authorized_name.as_deref().filter(|n| !n.is_empty()) {
        body.insert("authorized_name".to_owned(), json!(name));
    }
    let mut end_user = Map::new();
    if let Some(business) = details.business_name.as_deref().filter(|b| !b.is_empty()) {
        end_user.insert("admin".to_owned(), json!({ "business_name": business }));
    }
    if let Some(address) = &details.service_address {
        let mut location = Map::new();
        for (from, to) in [
            ("line1", "street_address"),
            ("line2", "extended_address"),
            ("city", "locality"),
            ("region", "administrative_area"),
            ("postalCode", "postal_code"),
            ("country", "country_code"),
        ] {
            if let Some(value) = address.get(from) {
                location.insert(to.to_owned(), value.clone());
            }
        }
        end_user.insert("location".to_owned(), Value::Object(location));
    }
    if !end_user.is_empty() {
        body.insert("end_user".to_owned(), Value::Object(end_user));
    }
    let pin = details.current_pin.clone().flatten();
    let carrier = details.current_carrier.as_deref().filter(|c| !c.is_empty());
    let account = details
        .current_account_number
        .as_deref()
        .filter(|a| !a.is_empty());
    let pin = pin.as_deref().filter(|p| !p.is_empty());
    if carrier.is_some() || account.is_some() || pin.is_some() {
        let mut misc = Map::new();
        if let Some(carrier) = carrier {
            misc.insert("current_carrier".to_owned(), json!(carrier));
        }
        if let Some(account) = account {
            misc.insert("account_number".to_owned(), json!(account));
        }
        if let Some(pin) = pin {
            misc.insert("pin_passcode".to_owned(), json!(pin));
        }
        body.insert("misc".to_owned(), Value::Object(misc));
    }
    if let Some(foc) = details
        .requested_foc_at
        .as_deref()
        .filter(|f| !f.is_empty())
    {
        let units: Vec<u16> = foc.encode_utf16().take(10).collect();
        body.insert(
            "requested_foc_date".to_owned(),
            json!(String::from_utf16_lossy(&units)),
        );
    }
    Value::Object(body)
}

/// `PATCH /api/porting/:id`: the order's details, on Telnyx first.
pub(crate) async fn update(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let details = match validate(&headers, &body, read_details) {
        Ok(details) => details,
        Err(response) => return *response,
    };
    let draft = match live_order(&caller, &id).await {
        Ok(Some(draft)) => draft,
        Ok(None) => return ApiError::not_found("Porting order", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let status = draft["status"].as_str().unwrap_or_default().to_owned();
    if !is_editable(&status) {
        return ApiError::conflict(format!(
            "Order is {status} — fields are locked after submission"
        ))
        .into_response();
    }
    let Some(telnyx_id) = draft["telnyx_porting_order_id"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
    else {
        return ApiError::conflict("Order has no Telnyx id — recreate the draft").into_response();
    };
    let telnyx = caller.telnyx(&state);
    if let Err(error) = telnyx
        .porting(
            "PATCH",
            &format!("/porting_orders/{telnyx_id}"),
            Some(Body::Json(telnyx_details(&details))),
            false,
        )
        .await
    {
        return telnyx_failure(&error, "Telnyx rejected the update");
    }
    let foc = match details.requested_foc_at.as_deref() {
        None => None,
        Some(text) => match weldsuite_kit::validation::js_date_iso(text) {
            Some(iso) => Some(iso),
            None => return internal(&"invalid date", "Internal server error"),
        },
    };
    let (pin_set, pin) = details
        .current_pin
        .clone()
        .map_or((false, None), |p| (true, p));
    let result = async {
        sqlx::query(
            "update voip_porting_orders set updated_at = $2::timestamp,
                 authorized_name = coalesce($3, authorized_name),
                 business_name = coalesce($4, business_name),
                 service_address = coalesce($5::jsonb, service_address),
                 current_carrier = coalesce($6, current_carrier),
                 current_account_number = coalesce($7, current_account_number),
                 current_pin = case when $8 then $9 else current_pin end,
                 requested_foc_at = coalesce($10::timestamp, requested_foc_at)
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(&details.authorized_name)
        .bind(&details.business_name)
        .bind(&details.service_address)
        .bind(&details.current_carrier)
        .bind(&details.current_account_number)
        .bind(pin_set)
        .bind(pin)
        .bind(foc)
        .execute(&caller.db)
        .await?;
        order_row(&caller, &id).await
    }
    .await;
    match result {
        Ok(refreshed) => {
            publish(
                &caller,
                &state,
                VOIP_PORTING_ORDER_UPDATED,
                &id,
                &draft["phone_number"],
                &refreshed["status"],
            );
            Data(json!({ "order": refreshed })).into_response()
        }
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `POST /api/porting/:id/loa-template`: Telnyx's pre-filled LOA (PDF).
pub(crate) async fn loa_template(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let draft = match live_order(&caller, &id).await {
        Ok(Some(draft)) => draft,
        Ok(None) => return ApiError::not_found("Porting order", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let Some(telnyx_id) = draft["telnyx_porting_order_id"]
        .as_str()
        .filter(|t| !t.is_empty())
    else {
        return ApiError::conflict("Order has no Telnyx id yet").into_response();
    };
    let telnyx = caller.telnyx(&state);
    match telnyx
        .porting(
            "GET",
            &format!("/porting_orders/{telnyx_id}/loa_template"),
            None,
            true,
        )
        .await
    {
        Ok(body) => {
            let bytes = match body {
                PortingBody::Bytes(bytes) => bytes,
                PortingBody::Json(value) => js::string(&value).into_bytes(),
            };
            (
                StatusCode::OK,
                [
                    (CONTENT_TYPE, "application/pdf".to_owned()),
                    (
                        CONTENT_DISPOSITION,
                        format!("attachment; filename=\"loa-{id}.pdf\""),
                    ),
                ],
                bytes,
            )
                .into_response()
        }
        Err(error) => telnyx_failure(&error, "Failed to fetch LOA template"),
    }
}

/// `buildPortDocKey(workspaceId, portingOrderId, type)`.
fn doc_key(workspace: &str, order: &str, kind: &str) -> String {
    let safe = |text: &str| -> String {
        text.chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect()
    };
    format!("port-orders/{}/{}/{kind}.pdf", safe(workspace), safe(order))
}

/// `POST /api/porting/:id/loa` (multipart `file`): the signed LOA.
pub(crate) async fn upload_loa(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> Response {
    upload(state, caller, id, request, "loa").await
}

/// `POST /api/porting/:id/bill-copy` (multipart `file`): the current bill.
pub(crate) async fn upload_bill_copy(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> Response {
    upload(state, caller, id, request, "bill").await
}

/// `handleDocumentUpload(c, type)`: checked, stored, attached on Telnyx,
/// recorded on the order.
#[allow(clippy::too_many_lines)] // the route, step by step
async fn upload(
    state: CallState,
    caller: Caller,
    id: String,
    request: axum::extract::Request,
    kind: &str,
) -> Response {
    let Some(org) = caller.clerk_org_id.clone().filter(|o| !o.is_empty()) else {
        return ApiError::internal()
            .with_message("Workspace context missing")
            .into_response();
    };
    let draft = match live_order(&caller, &id).await {
        Ok(Some(draft)) => draft,
        Ok(None) => return ApiError::not_found("Porting order", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let status = draft["status"].as_str().unwrap_or_default().to_owned();
    if !is_editable(&status) {
        return ApiError::conflict(format!(
            "Order is {status} — documents are locked after submission"
        ))
        .into_response();
    }
    let Some(telnyx_id) = draft["telnyx_porting_order_id"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
    else {
        return ApiError::conflict("Order has no Telnyx id yet").into_response();
    };
    let Ok(Some(file)) = read_form_file(request).await else {
        return ApiError::bad_request("Missing \"file\" form field").into_response();
    };
    // validateAndReadPdf
    if file.bytes.is_empty() {
        return ApiError::bad_request("File is empty").into_response();
    }
    if file.bytes.len() > MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(json!({ "error": {
                "code": "TOO_LARGE",
                "message": format!("File exceeds {MAX_BYTES} bytes"),
                "details": { "code": "too_large", "sizeBytes": file.bytes.len(), "limitBytes": MAX_BYTES },
            } })),
        )
            .into_response();
    }
    if !file.bytes.starts_with(b"%PDF") {
        return ApiError::bad_request("File is not a valid PDF")
            .with_details(json!({
                "code": "not_pdf",
                "detail": "File does not start with the PDF signature (%PDF)",
            }))
            .into_response();
    }
    let key = doc_key(&org, &id, kind);
    let Some(storage) = caller.storage(&state) else {
        return internal(
            &"R2 STORAGE binding not configured on this worker",
            "Failed to store document",
        );
    };
    let mut metadata = BTreeMap::new();
    metadata.insert("portingOrderId".to_owned(), id.clone());
    metadata.insert("docType".to_owned(), kind.to_owned());
    metadata.insert("workspaceId".to_owned(), org.clone());
    let options = PutOptions {
        content_type: Some("application/pdf".to_owned()),
        metadata,
        ..PutOptions::default()
    };
    if let Err(error) = storage.put_boxed(&key, file.bytes.clone(), &options).await {
        return internal(&error, "Failed to store document");
    }
    let telnyx = caller.telnyx(&state);
    let attached = async {
        let (filename, document_type) = if kind == "loa" {
            ("signed-loa.pdf", "loa")
        } else {
            ("current-bill.pdf", "invoice")
        };
        let document = telnyx
            .porting(
                "POST",
                "/documents",
                Some(Body::File {
                    name: filename.to_owned(),
                    content_type: "application/pdf".to_owned(),
                    bytes: file.bytes,
                }),
                false,
            )
            .await?
            .json();
        if !document["data"].is_object() {
            return Err(PortingError::Other(
                "Cannot read properties of undefined (reading 'id')".to_owned(),
            ));
        }
        let mut documents = Map::new();
        documents.insert(document_type.to_owned(), document["data"]["id"].clone());
        telnyx
            .porting(
                "PATCH",
                &format!("/porting_orders/{telnyx_id}"),
                Some(Body::Json(json!({ "documents": documents }))),
                false,
            )
            .await?;
        Ok(())
    }
    .await;
    if let Err(error) = attached {
        return telnyx_failure(
            &error,
            if matches!(error, PortingError::Telnyx { .. }) {
                "Telnyx rejected the document upload"
            } else {
                "Failed to attach document to Telnyx order"
            },
        );
    }
    let column_update = if kind == "loa" {
        "update voip_porting_orders set loa_storage_key = $2, updated_at = $3::timestamp where id = $1"
    } else {
        "update voip_porting_orders set bill_copy_storage_key = $2, updated_at = $3::timestamp where id = $1"
    };
    if let Err(error) = sqlx::query(column_update)
        .bind(&id)
        .bind(&key)
        .bind(now())
        .execute(&caller.db)
        .await
    {
        return internal(&error, "Internal server error");
    }
    publish(
        &caller,
        &state,
        VOIP_PORTING_ORDER_UPDATED,
        &id,
        &draft["phone_number"],
        &draft["status"],
    );
    Data(json!({ "storageKey": key })).into_response()
}

/// `REQUIRED_SUBMIT_FIELDS`: column and the label reported when missing.
const REQUIRED_SUBMIT_FIELDS: [(&str, &str); 7] = [
    ("authorized_name", "authorizedName"),
    ("business_name", "businessName"),
    ("service_address", "serviceAddress"),
    ("current_carrier", "currentCarrier"),
    ("current_account_number", "currentAccountNumber"),
    ("loa_storage_key", "loa"),
    ("bill_copy_storage_key", "billCopy"),
];

/// `POST /api/porting/:id/submit`: on Global, the number's billing then the
/// Telnyx submission; here the checks before billing, then billing-worker's
/// absence.
pub(crate) async fn submit(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    if caller.org_id.as_deref().is_none_or(str::is_empty) {
        return ApiError::org_required().into_response();
    }
    let draft = match live_order(&caller, &id).await {
        Ok(Some(draft)) => draft,
        Ok(None) => return ApiError::not_found("Porting order", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let status = js::string(&draft["status"]);
    if status != "awaiting_documents" {
        return ApiError::conflict(format!("Cannot submit from status '{status}'")).into_response();
    }
    if draft["telnyx_porting_order_id"]
        .as_str()
        .is_none_or(str::is_empty)
    {
        return ApiError::conflict("Order has no Telnyx id yet").into_response();
    }
    let missing: Vec<&str> = REQUIRED_SUBMIT_FIELDS
        .iter()
        .filter(|(column, _)| !js::truthy(&draft[*column]))
        .map(|(_, label)| *label)
        .collect();
    if !missing.is_empty() {
        return ApiError::bad_request(format!(
            "Missing required fields/documents: {}",
            missing.join(", ")
        ))
        .with_details(json!({ "missing": missing }))
        .into_response();
    }
    let Some(master) = caller.master(&state) else {
        return internal(&"no master database", "Internal server error");
    };
    let country = draft["country_code"]
        .as_str()
        .unwrap_or_default()
        .to_uppercase();
    let kind = draft["number_type"]
        .as_str()
        .unwrap_or_default()
        .to_lowercase();
    let price: Result<Option<Option<String>>, sqlx::Error> = sqlx::query_scalar(
        "select stripe_price_id from telephony_number_pricing
         where country_code = $1 and number_type = $2 and is_active = true limit 1",
    )
    .bind(&country)
    .bind(&kind)
    .fetch_optional(&master)
    .await;
    let price = match price {
        Ok(price) => price.flatten().filter(|p| !p.is_empty()),
        Err(error) => return internal(&error, "Internal server error"),
    };
    if price.is_none() {
        return ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "UNPROCESSABLE_ENTITY",
            format!(
                "No active pricing configured for {}/{} — cannot bill, port refused",
                js::string(&draft["country_code"]),
                js::string(&draft["number_type"])
            ),
        )
        .into_response();
    }
    // billing-worker (`POST /api/billing/phone/add-number`) is Global-only:
    // answer as when it cannot be reached.
    tracing::warn!("porting: no billing-worker on this edition, submission refused");
    ApiError::unavailable("Billing service is unavailable — try again").into_response()
}

/// `GET /api/porting`: the live orders, newest first (100 at most).
pub(crate) async fn list(caller: Caller) -> Response {
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from voip_porting_orders t where t.deleted_at is null
         order by t.created_at desc limit 100",
    )
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(found) => Data(json!({ "orders": crate::rows(found) })).into_response(),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `GET /api/porting/:id`.
pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match live_order(&caller, &id).await {
        Ok(Some(order)) => Data(json!({ "order": weldsuite_db::js_row(order) })).into_response(),
        Ok(None) => ApiError::not_found("Porting order", Some(&id)).into_response(),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `POST /api/porting/:id/refresh`: the order's sub-status and FOC date
/// from Telnyx; an order Telnyx no longer knows becomes an exception.
pub(crate) async fn refresh(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let draft = match live_order(&caller, &id).await {
        Ok(Some(draft)) => draft,
        Ok(None) => return ApiError::not_found("Porting order", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let Some(telnyx_id) = draft["telnyx_porting_order_id"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
    else {
        return ApiError::conflict("Order has no Telnyx id yet").into_response();
    };
    let telnyx: Telnyx = caller.telnyx(&state);
    let remote = telnyx
        .porting("GET", &format!("/porting_orders/{telnyx_id}"), None, false)
        .await;
    let refreshed = match remote {
        Ok(body) => {
            let data = body.json()["data"].clone();
            if !data.is_object() {
                return internal(&"no order data", "Refresh failed");
            }
            let foc = match data["actual_foc_date"].as_str().filter(|d| !d.is_empty()) {
                None => None,
                Some(text) => match weldsuite_kit::validation::js_date_iso(text) {
                    Some(iso) => Some(iso),
                    None => return internal(&"invalid date", "Refresh failed"),
                },
            };
            sqlx::query(
                "update voip_porting_orders set substatus = $2,
                     actual_foc_at = coalesce($3::timestamp, actual_foc_at),
                     updated_at = $4::timestamp
                 where id = $1",
            )
            .bind(&id)
            .bind(data["sub_status"].as_str())
            .bind(foc)
            .bind(now())
            .execute(&caller.db)
            .await
        }
        Err(error) => {
            if let PortingError::Telnyx {
                code: PortingCode::NotFound,
                ..
            } = &error
            {
                let _ = sqlx::query(
                    "update voip_porting_orders set status = 'exception',
                         last_error_code = 'telnyx_not_found',
                         last_error_message = 'Telnyx no longer recognizes this order',
                         updated_at = $2::timestamp
                     where id = $1",
                )
                .bind(&id)
                .bind(now())
                .execute(&caller.db)
                .await;
            }
            return telnyx_failure(&error, "Refresh failed");
        }
    };
    if let Err(error) = refreshed {
        return internal(&error, "Refresh failed");
    }
    match order_row(&caller, &id).await {
        Ok(order) => Data(json!({ "order": order })).into_response(),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `DELETE /api/porting/:id`: cancel a draft (Telnyx and the documents
/// too, best effort).
pub(crate) async fn cancel(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let draft = match live_order(&caller, &id).await {
        Ok(Some(draft)) => draft,
        Ok(None) => return ApiError::not_found("Porting order", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    if !is_editable(draft["status"].as_str().unwrap_or_default()) {
        return ApiError::conflict(
            "Submitted ports cannot be cancelled via API — contact support to coordinate with the carrier",
        )
        .into_response();
    }
    if let Some(telnyx_id) = draft["telnyx_porting_order_id"]
        .as_str()
        .filter(|t| !t.is_empty())
    {
        let telnyx = caller.telnyx(&state);
        if let Err(error) = telnyx
            .porting(
                "DELETE",
                &format!("/porting_orders/{telnyx_id}"),
                None,
                false,
            )
            .await
        {
            tracing::warn!(%error, "[Porting] Telnyx delete failed (continuing)");
        }
    }
    if let Some(org) = caller.clerk_org_id.as_deref().filter(|o| !o.is_empty())
        && let Some(storage) = caller.storage(&state)
    {
        for kind in ["loa", "bill"] {
            let _ = storage.delete_boxed(&doc_key(org, &id, kind)).await;
        }
    }
    let now = now();
    if let Err(error) = sqlx::query(
        "update voip_porting_orders set status = 'cancelled', deleted_at = $2::timestamp,
             updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(&caller.db)
    .await
    {
        return internal(&error, "Internal server error");
    }
    publish(
        &caller,
        &state,
        VOIP_PORTING_ORDER_DELETED,
        &id,
        &draft["phone_number"],
        &json!("cancelled"),
    );
    Data(json!({ "success": true })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_document_keys_are_safe() {
        assert_eq!(
            doc_key("org_1", "vpo_2", "loa"),
            "port-orders/org_1/vpo_2/loa.pdf"
        );
        assert_eq!(
            doc_key("org/../x", "vpo 2", "bill"),
            "port-orders/orgx/vpo2/bill.pdf"
        );
        assert!(is_plus_digits("+3120"));
        assert!(!is_plus_digits("3120"));
        assert!(!is_plus_digits("+"));
    }

    #[test]
    fn details_map_onto_telnyx_fields() {
        let details = Details {
            business_name: Some("Acme".to_owned()),
            service_address: Some(
                json!({ "line1": "Main 1", "city": "Ghent", "region": "VOV", "postalCode": "9000", "country": "BE" }),
            ),
            current_pin: Some(None),
            requested_foc_at: Some("2026-12-01T09:00:00Z".to_owned()),
            ..Details::default()
        };
        assert_eq!(
            telnyx_details(&details),
            json!({
                "end_user": {
                    "admin": { "business_name": "Acme" },
                    "location": {
                        "street_address": "Main 1", "locality": "Ghent", "administrative_area": "VOV",
                        "postal_code": "9000", "country_code": "BE",
                    },
                },
                "requested_foc_date": "2026-12-01",
            })
        );
    }
}
