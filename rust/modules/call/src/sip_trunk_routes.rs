//! `/api/desk/phone/sip-trunks` (`routes/desk-phone/sip-trunks.ts`): a
//! customer's own phone system (SIP trunk / PBX such as Xelion or Dstny).
//!
//! ```text
//! GET    /                                      conversations:read  trunks with numbers and connection details
//! POST   /                                      settings:manage     create (credentials shown once)
//! PATCH  /:id                                   settings:manage
//! DELETE /:id                                   settings:manage
//! POST   /:id/rotate-password                   settings:manage     new password, shown once
//! POST   /:id/numbers                           settings:manage
//! DELETE /:id/numbers/:numberId                 settings:manage
//! POST   /:id/numbers/:numberId/verification          settings:manage  { method }
//! POST   /:id/numbers/:numberId/verification/confirm  settings:manage  { code }
//! ```
//!
//! The bodies are read as the shared schemas read them
//! (`@weldsuite/core-api-client/schemas/desk-sip-trunks`); the work is in
//! `sip_trunks`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, SIP_TRUNK_CREATED, SIP_TRUNK_DELETED, SIP_TRUNK_UPDATED, VOIP_PHONE_NUMBER_CREATED,
    VOIP_PHONE_NUMBER_DELETED, VOIP_PHONE_NUMBER_UPDATED,
};
use weldsuite_kit::validation::{Issues, Number, Presence, Text, js_number, js_trim};
use weldsuite_kit::{ApiError, Created, Data, NoContent};

use crate::desk_phone::whole_list;
use crate::sip_trunks::{
    CreateInput, Credentials, Failure, IpInput, MAX_IP_ADDRESSES, Trunks, UpdateInput, number_json,
};
use crate::{CallState, Caller, js, validate};

/// `DESK_SIP_TRUNK_PROVIDERS`.
const PROVIDERS: [&str; 3] = ["xelion", "dstny", "other"];
/// `DESK_SIP_TRUNK_AUTH_MODES`.
const AUTH_MODES: [&str; 2] = ["ip", "credentials"];
/// `DESK_SIP_TRUNK_TRANSPORTS`.
const TRANSPORTS: [&str; 3] = ["udp", "tcp", "tls"];
/// `DESK_SIP_TRUNK_STATUSES`.
const STATUSES: [&str; 2] = ["active", "disabled"];
/// `DESK_SIP_VERIFICATION_METHODS`.
const VERIFICATION_METHODS: [&str; 2] = ["call", "sms"];

const NOT_IPV4: &str = "Must be an IPv4 address";

/// `/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/`.
fn is_dotted_quad(text: &str) -> bool {
    let mut parts = 0;
    for part in text.split('.') {
        if !(1..=3).contains(&part.len()) || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        parts += 1;
    }
    parts == 4
}

/// `v.split('.').every((p) => Number(p) <= 255)`.
fn octets_in_range(text: &str) -> bool {
    text.split('.').all(|part| js_number(part) <= 255.0)
}

/// `/^\d{4,10}$/`.
fn is_numeric_code(text: &str) -> bool {
    (4..=10).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

/// `z.array(deskSipTrunkIpAddressInputSchema).max(10).optional()`. The
/// address's `.refine()` settles after the body's other checks: the paths
/// of the addresses that fail it go to `refused`.
fn read_addresses(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    refused: &mut Vec<Value>,
) -> Option<Vec<IpInput>> {
    issues
        .list(
            fields,
            "ipAddresses",
            Presence::Optional,
            None,
            Some(MAX_IP_ADDRESSES),
            |issues, item| {
                let entry = issues.object(item)?;
                let ip = issues
                    .pattern_with(
                        entry,
                        "ip",
                        Presence::Required,
                        Text::trimmed(None, None),
                        is_dotted_quad,
                        NOT_IPV4,
                    )
                    .into_option();
                // The refinement runs on any string, whatever the pattern said.
                if let Some(Value::String(raw)) = entry.get("ip")
                    && !octets_in_range(js_trim(raw))
                {
                    refused.push(issues.path_of("ip"));
                }
                let port = issues
                    .whole_number(
                        entry,
                        "port",
                        Presence::Optional,
                        Number {
                            min: Some(1.0),
                            max: Some(65535.0),
                            ..Number::default()
                        },
                    )
                    .into_option();
                Some(IpInput { ip: ip?, port })
            },
        )
        .into_option()
}

/// The addresses' failed refinements, as Zod reports them: last.
fn settle_refinements(issues: &mut Issues, refused: Vec<Value>) {
    for path in refused {
        issues.push_raw(json!({ "code": "custom", "message": NOT_IPV4, "path": path }));
    }
}

/// `createDeskSipTrunkSchema`.
fn read_create(issues: &mut Issues, fields: &Map<String, Value>) -> CreateInput {
    let mut refused = Vec::new();
    let name = issues
        .text_with(
            fields,
            "name",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option();
    let provider = issues
        .choice(fields, "provider", Presence::Optional, &PROVIDERS)
        .into_option();
    let auth_mode = issues.one_of(fields, "authMode", &AUTH_MODES);
    let transport = issues
        .choice(fields, "transport", Presence::Optional, &TRANSPORTS)
        .into_option();
    let ip_addresses = read_addresses(issues, fields, &mut refused);
    settle_refinements(issues, refused);
    CreateInput {
        name: name.unwrap_or_default(),
        // `.default('other')`.
        provider: provider.unwrap_or_else(|| "other".to_owned()),
        auth_mode: auth_mode.unwrap_or_default(),
        transport,
        ip_addresses,
    }
}

/// `updateDeskSipTrunkSchema`.
fn read_update(issues: &mut Issues, fields: &Map<String, Value>) -> UpdateInput {
    let mut refused = Vec::new();
    let name = issues
        .text_with(
            fields,
            "name",
            Presence::Optional,
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option();
    let provider = issues
        .choice(fields, "provider", Presence::Optional, &PROVIDERS)
        .into_option();
    let status = issues
        .choice(fields, "status", Presence::Optional, &STATUSES)
        .into_option();
    let transport = issues
        .choice(fields, "transport", Presence::Optional, &TRANSPORTS)
        .into_option();
    let ip_addresses = read_addresses(issues, fields, &mut refused);
    settle_refinements(issues, refused);
    UpdateInput {
        name,
        provider,
        status,
        transport,
        ip_addresses,
    }
}

/// `addDeskSipTrunkNumberSchema`: `(phoneNumber, displayName ?? null)`.
fn read_number(issues: &mut Issues, fields: &Map<String, Value>) -> (String, Option<String>) {
    let phone_number = issues
        .text_with(
            fields,
            "phoneNumber",
            Presence::Required,
            Text::trimmed(Some(1), Some(50)),
        )
        .into_option();
    let display_name = issues
        .text_with(
            fields,
            "displayName",
            Presence::Nullish,
            Text::trimmed(None, Some(100)),
        )
        .into_option();
    (phone_number.unwrap_or_default(), display_name)
}

/// Refusals the settings screen tells apart by `details.reason` as well as by
/// code.
const REASON_CODES: [&str; 2] = ["number_taken", "too_many_attempts"];

/// The service's refusal as the API's error envelope; anything else is the
/// worker's 500.
fn refuse(failure: Failure) -> Response {
    match failure {
        Failure::Refused(refusal) if refusal.status == StatusCode::NOT_FOUND => {
            ApiError::not_found("Phone system", None).into_response()
        }
        Failure::Refused(refusal) => {
            let mut error = ApiError::new(refusal.status, refusal.code, refusal.message);
            if REASON_CODES.contains(&refusal.code) {
                error = error.with_details(json!({ "reason": refusal.code }));
            }
            let mut response = error.into_response();
            if let Some(seconds) = refusal.retry_after
                && let Ok(value) = http::HeaderValue::from_str(&seconds.to_string())
            {
                response
                    .headers_mut()
                    .insert(http::header::RETRY_AFTER, value);
            }
            response
        }
        Failure::Internal(error) => {
            tracing::error!(%error, "[sip-trunks] request failed");
            ApiError::internal()
                .with_message("An unexpected error occurred")
                .into_response()
        }
    }
}

/// `trunkEvent(c, action, row)`.
fn trunk_event(caller: &Caller, state: &CallState, event: EventName, row: &Value) {
    caller.publish(
        state,
        event,
        &js::string(&row["id"]),
        &json!({
            "id": row["id"],
            "name": row["name"],
            "provider": row["provider"],
            "status": row["status"],
        }),
    );
}

/// `numberEvent(c, action, row)`.
fn number_event(caller: &Caller, state: &CallState, event: EventName, row: &Value) {
    caller.publish(
        state,
        event,
        &js::string(&row["id"]),
        &json!({
            "id": row["id"],
            "phoneNumber": row["phoneNumber"],
            "status": row["status"],
        }),
    );
}

/// `GET /api/desk/phone/sip-trunks`.
pub(crate) async fn list(State(state): State<CallState>, caller: Caller) -> Response {
    match Trunks::new(&caller, &state).list().await {
        Ok(trunks) => whole_list(trunks),
        Err(failure) => refuse(failure),
    }
}

/// `POST /api/desk/phone/sip-trunks`: a trunk and its Telnyx connection;
/// the login of a `credentials` trunk is shown here, once.
pub(crate) async fn create(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_create) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    match Trunks::new(&caller, &state).create(&input).await {
        Ok(created) => {
            trunk_event(&caller, &state, SIP_TRUNK_CREATED, &created.row);
            let mut trunk = created.trunk;
            trunk["credentials"] = created
                .credentials
                .as_ref()
                .map_or(Value::Null, Credentials::json);
            Created(trunk).into_response()
        }
        Err(failure) => refuse(failure),
    }
}

/// `PATCH /api/desk/phone/sip-trunks/:id`.
pub(crate) async fn update(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_update) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    match Trunks::new(&caller, &state).update(&id, &input).await {
        Ok((trunk, row)) => {
            trunk_event(&caller, &state, SIP_TRUNK_UPDATED, &row);
            Data(trunk).into_response()
        }
        Err(failure) => refuse(failure),
    }
}

/// `DELETE /api/desk/phone/sip-trunks/:id`: the trunk, its connection and
/// its numbers.
pub(crate) async fn remove(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match Trunks::new(&caller, &state).delete(&id).await {
        Ok((row, numbers)) => {
            for number in &numbers {
                number_event(&caller, &state, VOIP_PHONE_NUMBER_DELETED, number);
            }
            trunk_event(&caller, &state, SIP_TRUNK_DELETED, &row);
            NoContent.into_response()
        }
        Err(failure) => refuse(failure),
    }
}

/// `POST /api/desk/phone/sip-trunks/:id/rotate-password`: a new password,
/// shown once.
pub(crate) async fn rotate_password(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match Trunks::new(&caller, &state).rotate_password(&id).await {
        Ok((row, credentials)) => {
            trunk_event(&caller, &state, SIP_TRUNK_UPDATED, &row);
            Data(json!({ "credentials": credentials.json() })).into_response()
        }
        Err(failure) => refuse(failure),
    }
}

/// `POST /api/desk/phone/sip-trunks/:id/numbers`.
pub(crate) async fn add_number(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (phone_number, display_name) = match validate(&headers, &body, read_number) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    match Trunks::new(&caller, &state)
        .add_number(&id, &phone_number, display_name.as_deref())
        .await
    {
        Ok(number) => {
            number_event(&caller, &state, VOIP_PHONE_NUMBER_CREATED, &number);
            Created(number_json(&number)).into_response()
        }
        Err(failure) => refuse(failure),
    }
}

/// `DELETE /api/desk/phone/sip-trunks/:id/numbers/:numberId`.
pub(crate) async fn remove_number(
    State(state): State<CallState>,
    caller: Caller,
    Path((id, number_id)): Path<(String, String)>,
) -> Response {
    match Trunks::new(&caller, &state)
        .remove_number(&id, &number_id)
        .await
    {
        Ok(number) => {
            number_event(&caller, &state, VOIP_PHONE_NUMBER_DELETED, &number);
            NoContent.into_response()
        }
        Err(failure) => refuse(failure),
    }
}

/// `POST /api/desk/phone/sip-trunks/:id/numbers/:numberId/verification
/// { method }`: Telnyx sends the number a code.
pub(crate) async fn start_verification(
    State(state): State<CallState>,
    caller: Caller,
    Path((id, number_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // `startDeskSipVerificationSchema`.
    let method = match validate(&headers, &body, |issues, fields| {
        issues
            .one_of(fields, "method", &VERIFICATION_METHODS)
            .unwrap_or_default()
    }) {
        Ok(method) => method,
        Err(response) => return *response,
    };
    match Trunks::new(&caller, &state)
        .start_verification(&id, &number_id, &method)
        .await
    {
        Ok(started) => Data(started).into_response(),
        Err(failure) => refuse(failure),
    }
}

/// `POST /api/desk/phone/sip-trunks/:id/numbers/:numberId/verification/confirm
/// { code }`: the number may be shown as caller id once the code is right.
pub(crate) async fn confirm_verification(
    State(state): State<CallState>,
    caller: Caller,
    Path((id, number_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // `confirmDeskSipVerificationSchema`.
    let code = match validate(&headers, &body, |issues, fields| {
        issues
            .pattern_with(
                fields,
                "code",
                Presence::Required,
                Text::trimmed(None, None),
                is_numeric_code,
                "Enter the numeric code",
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(code) => code,
        Err(response) => return *response,
    };
    match Trunks::new(&caller, &state)
        .confirm_verification(&id, &number_id, &code)
        .await
    {
        Ok(number) => {
            number_event(&caller, &state, VOIP_PHONE_NUMBER_UPDATED, &number);
            Data(number_json(&number)).into_response()
        }
        Err(failure) => refuse(failure),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The issues `read` reports for `body`, as Zod's `error.issues`.
    fn issues_of<T>(
        body: &Value,
        read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
    ) -> Value {
        let mut issues = Issues::default();
        let fields = issues.object(body).expect("an object");
        read(&mut issues, fields);
        match issues.finish() {
            Ok(()) => json!([]),
            Err(invalid) => Value::Array(invalid.issues().to_vec()),
        }
    }

    // The expected issues below are Zod's own output for the same bodies
    // (`createDeskSipTrunkSchema.safeParseAsync(body)` and its siblings).

    #[test]
    fn a_new_trunk_is_validated_like_zod() {
        assert_eq!(
            issues_of(
                &json!({ "name": "", "authMode": "ip", "ipAddresses": [{ "ip": "8.8.8.8" }] }),
                read_create
            ),
            json!([{ "code": "too_small", "minimum": 1, "type": "string", "inclusive": true, "exact": false, "message": "String must contain at least 1 character(s)", "path": ["name"] }])
        );
        assert_eq!(
            issues_of(&json!({ "name": "X", "authMode": "sms" }), read_create),
            json!([{ "received": "sms", "code": "invalid_enum_value", "options": ["ip", "credentials"], "path": ["authMode"], "message": "Invalid enum value. Expected 'ip' | 'credentials', received 'sms'" }])
        );
        assert_eq!(
            issues_of(
                &json!({ "name": "X", "authMode": "ip", "ipAddresses": [{ "ip": "8.8.8.8", "port": 70000 }] }),
                read_create
            ),
            json!([{ "code": "too_big", "maximum": 65535, "type": "number", "inclusive": true, "exact": false, "message": "Number must be less than or equal to 65535", "path": ["ipAddresses", 0, "port"] }])
        );
        assert_eq!(
            issues_of(&json!({}), read_create),
            json!([
                { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["name"], "message": "Required" },
                { "expected": "'ip' | 'credentials'", "received": "undefined", "code": "invalid_type", "path": ["authMode"], "message": "Required" },
            ])
        );
        assert_eq!(
            issues_of(
                &json!({ "name": " Y ", "authMode": "credentials", "ipAddresses": "x" }),
                read_create
            ),
            json!([{ "code": "invalid_type", "expected": "array", "received": "string", "path": ["ipAddresses"], "message": "Expected array, received string" }])
        );
        let eleven: Vec<Value> = (0..11)
            .map(|n| json!({ "ip": format!("8.8.8.{n}") }))
            .collect();
        assert_eq!(
            issues_of(
                &json!({ "name": "Y", "authMode": "ip", "ipAddresses": eleven }),
                read_create
            ),
            json!([{ "code": "too_big", "maximum": 10, "type": "array", "inclusive": true, "exact": false, "message": "Array must contain at most 10 element(s)", "path": ["ipAddresses"] }])
        );
    }

    #[test]
    fn every_issue_of_a_trunk_comes_in_zods_order() {
        // The refinements of the addresses settle last.
        assert_eq!(
            issues_of(
                &json!({
                    "name": 5,
                    "provider": null,
                    "authMode": "ip",
                    "transport": "ws",
                    "ipAddresses": [
                        { "ip": "abc", "port": 1.5 },
                        { "ip": "999.1.1.1", "port": 0 },
                        7,
                        { "ip": 3 },
                        { "ip": " 1.2.3 " },
                        { "ip": "" },
                        { "port": 5060 },
                    ],
                }),
                read_create
            ),
            json!([
                { "code": "invalid_type", "expected": "string", "received": "number", "path": ["name"], "message": "Expected string, received number" },
                { "expected": "'xelion' | 'dstny' | 'other'", "received": "null", "code": "invalid_type", "path": ["provider"], "message": "Expected 'xelion' | 'dstny' | 'other', received null" },
                { "received": "ws", "code": "invalid_enum_value", "options": ["udp", "tcp", "tls"], "path": ["transport"], "message": "Invalid enum value. Expected 'udp' | 'tcp' | 'tls', received 'ws'" },
                { "validation": "regex", "code": "invalid_string", "message": "Must be an IPv4 address", "path": ["ipAddresses", 0, "ip"] },
                { "code": "invalid_type", "expected": "integer", "received": "float", "message": "Expected integer, received float", "path": ["ipAddresses", 0, "port"] },
                { "code": "too_small", "minimum": 1, "type": "number", "inclusive": true, "exact": false, "message": "Number must be greater than or equal to 1", "path": ["ipAddresses", 1, "port"] },
                { "code": "invalid_type", "expected": "object", "received": "number", "path": ["ipAddresses", 2], "message": "Expected object, received number" },
                { "code": "invalid_type", "expected": "string", "received": "number", "path": ["ipAddresses", 3, "ip"], "message": "Expected string, received number" },
                { "validation": "regex", "code": "invalid_string", "message": "Must be an IPv4 address", "path": ["ipAddresses", 4, "ip"] },
                { "validation": "regex", "code": "invalid_string", "message": "Must be an IPv4 address", "path": ["ipAddresses", 5, "ip"] },
                { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["ipAddresses", 6, "ip"], "message": "Required" },
                { "code": "custom", "message": "Must be an IPv4 address", "path": ["ipAddresses", 0, "ip"] },
                { "code": "custom", "message": "Must be an IPv4 address", "path": ["ipAddresses", 1, "ip"] },
            ])
        );
        assert_eq!(
            issues_of(
                &json!({ "name": "", "provider": "x", "status": "off", "transport": 3, "ipAddresses": [{ "ip": "256.1.1.1", "port": 70000 }] }),
                read_update
            ),
            json!([
                { "code": "too_small", "minimum": 1, "type": "string", "inclusive": true, "exact": false, "message": "String must contain at least 1 character(s)", "path": ["name"] },
                { "received": "x", "code": "invalid_enum_value", "options": ["xelion", "dstny", "other"], "path": ["provider"], "message": "Invalid enum value. Expected 'xelion' | 'dstny' | 'other', received 'x'" },
                { "received": "off", "code": "invalid_enum_value", "options": ["active", "disabled"], "path": ["status"], "message": "Invalid enum value. Expected 'active' | 'disabled', received 'off'" },
                { "expected": "'udp' | 'tcp' | 'tls'", "received": "number", "code": "invalid_type", "path": ["transport"], "message": "Expected 'udp' | 'tcp' | 'tls', received number" },
                { "code": "too_big", "maximum": 65535, "type": "number", "inclusive": true, "exact": false, "message": "Number must be less than or equal to 65535", "path": ["ipAddresses", 0, "port"] },
                { "code": "custom", "message": "Must be an IPv4 address", "path": ["ipAddresses", 0, "ip"] },
            ])
        );
        // Too many addresses are still read one by one.
        let mut eleven: Vec<Value> = (0..11)
            .map(|n| json!({ "ip": format!("8.8.8.{n}") }))
            .collect();
        eleven[0] = json!({ "ip": "999.1.1.1" });
        eleven[1] = json!({ "ip": "8.8.8.1", "port": 0 });
        assert_eq!(
            issues_of(
                &json!({ "name": "Y", "authMode": "ip", "ipAddresses": eleven }),
                read_create
            ),
            json!([
                { "code": "too_big", "maximum": 10, "type": "array", "inclusive": true, "exact": false, "message": "Array must contain at most 10 element(s)", "path": ["ipAddresses"] },
                { "code": "too_small", "minimum": 1, "type": "number", "inclusive": true, "exact": false, "message": "Number must be greater than or equal to 1", "path": ["ipAddresses", 1, "port"] },
                { "code": "custom", "message": "Must be an IPv4 address", "path": ["ipAddresses", 0, "ip"] },
            ])
        );
        assert_eq!(
            issues_of(&json!({ "name": null }), read_update),
            json!([{ "code": "invalid_type", "expected": "string", "received": "null", "path": ["name"], "message": "Expected string, received null" }])
        );
    }

    #[test]
    fn a_valid_trunk_is_read_trimmed_with_its_defaults() {
        let mut issues = Issues::default();
        let body = json!({ "name": " Y ", "authMode": "ip", "ipAddresses": [{ "ip": " 8.8.8.8 ", "port": 5070 }], "extra": 1 });
        let input = read_create(&mut issues, issues_object(&body));
        assert!(issues.finish().is_ok());
        assert_eq!(input.name, "Y");
        assert_eq!(input.provider, "other");
        assert_eq!(input.auth_mode, "ip");
        assert_eq!(input.transport, None);
        assert_eq!(
            input.ip_addresses,
            Some(vec![IpInput {
                ip: "8.8.8.8".to_owned(),
                port: Some(5070)
            }])
        );
    }

    fn issues_object(body: &Value) -> &Map<String, Value> {
        body.as_object().expect("an object")
    }

    #[test]
    fn numbers_and_codes_are_validated_like_zod() {
        assert_eq!(
            issues_of(
                &json!({ "phoneNumber": "   ", "displayName": "x".repeat(101) }),
                read_number
            ),
            json!([
                { "code": "too_small", "minimum": 1, "type": "string", "inclusive": true, "exact": false, "message": "String must contain at least 1 character(s)", "path": ["phoneNumber"] },
                { "code": "too_big", "maximum": 100, "type": "string", "inclusive": true, "exact": false, "message": "String must contain at most 100 character(s)", "path": ["displayName"] },
            ])
        );
        assert_eq!(
            issues_of(
                &json!({ "phoneNumber": "x".repeat(51), "displayName": null }),
                read_number
            ),
            json!([{ "code": "too_big", "maximum": 50, "type": "string", "inclusive": true, "exact": false, "message": "String must contain at most 50 character(s)", "path": ["phoneNumber"] }])
        );
        assert_eq!(
            issues_of(&json!({ "displayName": 4 }), read_number),
            json!([
                { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["phoneNumber"], "message": "Required" },
                { "code": "invalid_type", "expected": "string", "received": "number", "path": ["displayName"], "message": "Expected string, received number" },
            ])
        );
        assert!(is_numeric_code("123456"));
        assert!(is_numeric_code("1234"));
        assert!(!is_numeric_code("123"));
        assert!(!is_numeric_code("12345678901"));
        assert!(!is_numeric_code("abc"));
        assert!(is_dotted_quad("999.1.1.1"));
        assert!(!is_dotted_quad("1.2.3"));
        assert!(!is_dotted_quad("1.2.3.4.5"));
        assert!(!is_dotted_quad("1.2.3.1234"));
        assert!(octets_in_range("1.2.3"));
        assert!(octets_in_range(""));
        assert!(!octets_in_range("abc"));
        assert!(!octets_in_range("256.1.1.1"));
    }

    async fn body_of(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body reads");
        let json: Value = serde_json::from_slice(&bytes).expect("the body is JSON");
        (status, json)
    }

    #[tokio::test]
    async fn refusals_answer_in_the_api_envelope() {
        let not_found = crate::sip_trunks::Refusal {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: "Number 'vpn_1' not found on this phone system".to_owned(),
            retry_after: None,
        };
        assert_eq!(
            body_of(refuse(Failure::Refused(not_found))).await,
            (
                StatusCode::NOT_FOUND,
                json!({ "error": { "code": "NOT_FOUND", "message": "Phone system not found" } })
            )
        );
        let taken = crate::sip_trunks::Refusal {
            status: StatusCode::CONFLICT,
            code: "number_taken",
            message: "This number is already in use".to_owned(),
            retry_after: None,
        };
        assert_eq!(
            body_of(refuse(Failure::Refused(taken))).await,
            (
                StatusCode::CONFLICT,
                json!({ "error": { "code": "number_taken", "message": "This number is already in use", "details": { "reason": "number_taken" } } })
            )
        );
        let limited = crate::sip_trunks::Refusal {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "too_many_attempts",
            message: "Too many attempts, try again later".to_owned(),
            retry_after: Some(120),
        };
        let response = refuse(Failure::Refused(limited));
        assert_eq!(response.headers()["retry-after"], "120");
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let (status, body) = body_of(refuse(Failure::Internal("boom".to_owned()))).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"]["code"], "INTERNAL_ERROR");
    }
}
