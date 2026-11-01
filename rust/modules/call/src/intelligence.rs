//! `/api/call-intelligence` (`routes/call-intelligence`): the workspace's
//! phone numbers (`voip_phone_numbers`, soft-deleted), the WebRTC token
//! (Telnyx telephony credentials), call statistics and a call's
//! transcription, which follows the call's owner scope.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{CALL_CREATED, CALL_DELETED, CALL_UPDATED};
use weldsuite_kit::validation::{Field, Issues, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent};
use weldsuite_ports::HttpRequest;

use crate::calls::query_param;
use crate::{CallState, Caller, internal, js, now, rows, validate};

const CALL_DENIED: &str = "You do not have access to this call";

/// `GET /api/call-intelligence/phone-numbers[?status=&provider=]`: the
/// live numbers, the default first.
pub(crate) async fn list_numbers(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query_values(query.as_deref());
    let status = query_param(&query, "status").filter(|s| !s.is_empty());
    let provider = query_param(&query, "provider").filter(|p| !p.is_empty());
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from voip_phone_numbers t
         where t.deleted_at is null and ($1::text is null or t.status = $1)
           and ($2::text is null or t.provider = $2)
         order by t.is_default desc, t.created_at desc",
    )
    .bind(status)
    .bind(provider)
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(found) => Data(rows(found)).into_response(),
        Err(error) => internal(&error, "Failed to fetch phone numbers"),
    }
}

/// `createPhoneNumberSchema`.
struct NewNumber {
    provider: String,
    phone_number: String,
    formatted_number: Option<String>,
    country_code: String,
    number_type: Option<String>,
    status: String,
    provider_phone_number_id: Option<String>,
    provider_connection_id: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    is_default: Option<bool>,
    allow_inbound: Option<bool>,
    allow_outbound: Option<bool>,
    enable_recording: Option<bool>,
}

fn optional_text(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Option<String> {
    issues
        .text_with(fields, key, presence, Text::default())
        .into_option()
}

fn read_new_number(issues: &mut Issues, fields: &Map<String, Value>) -> NewNumber {
    NewNumber {
        provider: issues
            .choice(fields, "provider", Presence::Optional, &["telnyx"])
            .into_option()
            .unwrap_or_else(|| "telnyx".to_owned()),
        phone_number: issues
            .text(fields, "phoneNumber", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        formatted_number: optional_text(issues, fields, "formattedNumber", Presence::Optional),
        country_code: issues
            .text(fields, "countryCode", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        number_type: optional_text(issues, fields, "numberType", Presence::Optional),
        status: optional_text(issues, fields, "status", Presence::Optional)
            .unwrap_or_else(|| "active".to_owned()),
        provider_phone_number_id: optional_text(
            issues,
            fields,
            "providerPhoneNumberId",
            Presence::Nullish,
        ),
        provider_connection_id: optional_text(
            issues,
            fields,
            "providerConnectionId",
            Presence::Nullish,
        ),
        display_name: optional_text(issues, fields, "displayName", Presence::Optional),
        description: optional_text(issues, fields, "description", Presence::Optional),
        is_default: issues
            .boolean(fields, "isDefault", Presence::Optional)
            .into_option(),
        allow_inbound: issues
            .boolean(fields, "allowInbound", Presence::Optional)
            .into_option(),
        allow_outbound: issues
            .boolean(fields, "allowOutbound", Presence::Optional)
            .into_option(),
        enable_recording: issues
            .boolean(fields, "enableRecording", Presence::Optional)
            .into_option(),
    }
}

/// `POST /api/call-intelligence/phone-numbers`.
pub(crate) async fn create_number(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_new_number) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let id = weldsuite_kit::generate_id("vnum");
    let inserted = sqlx::query(
        "insert into voip_phone_numbers (id, provider, phone_number, formatted_number, country_code,
             number_type, status, provider_phone_number_id, provider_connection_id, display_name,
             description, is_default, allow_inbound, allow_outbound, enable_recording,
             created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16::timestamp, $16::timestamp)",
    )
    .bind(&id)
    .bind(&data.provider)
    .bind(&data.phone_number)
    .bind(&data.formatted_number)
    .bind(&data.country_code)
    .bind(data.number_type.as_deref().unwrap_or("local"))
    .bind(&data.status)
    .bind(&data.provider_phone_number_id)
    .bind(&data.provider_connection_id)
    .bind(&data.display_name)
    .bind(&data.description)
    .bind(data.is_default.unwrap_or(false))
    .bind(data.allow_inbound.unwrap_or(true))
    .bind(data.allow_outbound.unwrap_or(true))
    .bind(data.enable_recording.unwrap_or(true))
    .bind(now())
    .execute(&caller.db)
    .await;
    match inserted {
        Ok(_) => {
            caller.publish(
                &state,
                CALL_CREATED,
                &id,
                &json!({ "id": id, "phoneNumber": data.phone_number }),
            );
            Created(json!({ "id": id })).into_response()
        }
        Err(error) => internal(&error, "Failed to create phone number"),
    }
}

/// `updatePhoneNumberSchema` (the client package's).
struct NumberChanges {
    display_name: Field<String>,
    status: Option<String>,
    is_default: Option<bool>,
    formatted_number: Option<String>,
    allow_inbound: Option<bool>,
    allow_outbound: Option<bool>,
    enable_recording: Option<bool>,
    description: Option<String>,
}

fn read_number_changes(issues: &mut Issues, fields: &Map<String, Value>) -> NumberChanges {
    NumberChanges {
        display_name: issues.text_with(fields, "displayName", Presence::Nullish, Text::default()),
        status: optional_text(issues, fields, "status", Presence::Optional),
        is_default: issues
            .boolean(fields, "isDefault", Presence::Optional)
            .into_option(),
        formatted_number: optional_text(issues, fields, "formattedNumber", Presence::Optional),
        allow_inbound: issues
            .boolean(fields, "allowInbound", Presence::Optional)
            .into_option(),
        allow_outbound: issues
            .boolean(fields, "allowOutbound", Presence::Optional)
            .into_option(),
        enable_recording: issues
            .boolean(fields, "enableRecording", Presence::Optional)
            .into_option(),
        description: optional_text(issues, fields, "description", Presence::Optional),
    }
}

async fn live_number(caller: &Caller, id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from voip_phone_numbers where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(found.is_some())
}

/// `PATCH /api/call-intelligence/phone-numbers/:id`.
pub(crate) async fn update_number(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let changes = match validate(&headers, &body, read_number_changes) {
        Ok(changes) => changes,
        Err(response) => return *response,
    };
    match live_number(&caller, &id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Phone number", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to update phone number"),
    }
    let updated = sqlx::query(
        "update voip_phone_numbers set updated_at = $2::timestamp,
             display_name = case when $3 then $4 else display_name end,
             status = case when $5::text is not null then $5 else status end,
             is_default = coalesce($6, is_default),
             formatted_number = case when $7::text is not null then $7 else formatted_number end,
             allow_inbound = coalesce($8, allow_inbound),
             allow_outbound = coalesce($9, allow_outbound),
             enable_recording = coalesce($10, enable_recording),
             description = case when $11::text is not null then $11 else description end
         where id = $1 and deleted_at is null",
    )
    .bind(&id)
    .bind(now())
    .bind(!changes.display_name.is_absent())
    .bind(changes.display_name.clone().into_option())
    .bind(&changes.status)
    .bind(changes.is_default)
    .bind(&changes.formatted_number)
    .bind(changes.allow_inbound)
    .bind(changes.allow_outbound)
    .bind(changes.enable_recording)
    .bind(&changes.description)
    .execute(&caller.db)
    .await;
    match updated {
        Ok(_) => {
            caller.publish(&state, CALL_UPDATED, &id, &json!({ "id": id }));
            Data(json!({ "id": id })).into_response()
        }
        Err(error) => internal(&error, "Failed to update phone number"),
    }
}

/// `DELETE /api/call-intelligence/phone-numbers/:id`: a soft delete.
pub(crate) async fn delete_number(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match live_number(&caller, &id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Phone number", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to delete phone number"),
    }
    let now = now();
    if let Err(error) = sqlx::query(
        "update voip_phone_numbers set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(&caller.db)
    .await
    {
        return internal(&error, "Failed to delete phone number");
    }
    caller.publish(&state, CALL_DELETED, &id, &json!({ "id": id }));
    NoContent.into_response()
}

/// `TELNYX_ID_RE`: Telnyx ids are UUIDs.
fn is_telnyx_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `POST /api/call-intelligence/token`: a short-lived WebRTC login token
/// for the deployment's credential connection, creating its credential on
/// first use.
pub(crate) async fn token(State(state): State<CallState>, caller: Caller) -> Response {
    let (Some(key), Some(connection)) = (
        caller.env("TELNYX_API_KEY"),
        caller.env("TELNYX_SIP_CONNECTION_ID"),
    ) else {
        return Data(json!({
            "token": null,
            "message": "Telnyx is not configured. Set TELNYX_API_KEY and TELNYX_SIP_CONNECTION_ID.",
            "configured": false,
            "provider": "telnyx",
        }))
        .into_response();
    };
    match mint_token(&caller, &state, &key, &connection).await {
        Ok(token) => Data(json!({ "token": token, "configured": true, "provider": "telnyx" }))
            .into_response(),
        Err(error) => internal(&error, "Failed to generate Voice token"),
    }
}

async fn mint_token(
    caller: &Caller,
    state: &CallState,
    key: &str,
    connection: &str,
) -> Result<String, String> {
    let telnyx = caller.telnyx(state);
    let bearer = format!("Bearer {key}");
    let listed = telnyx
        .send(
            HttpRequest::empty(
                "GET",
                format!(
                    "https://api.telnyx.com/v2/telephony_credentials?filter[connection_id]={}&page[size]=1",
                    js::encode_uri_component(connection)
                ),
            )
            .header("Authorization", bearer.clone()),
        )
        .await?;
    let mut credential = Value::Null;
    if listed.ok() {
        let data: Value = serde_json::from_slice(&listed.body).map_err(|e| e.to_string())?;
        if let Some(first) = data["data"].as_array().and_then(|list| list.first()) {
            credential = first["id"].clone();
        }
    }
    if !js::truthy(&credential) {
        let created = telnyx
            .send(
                HttpRequest::json(
                    "POST",
                    "https://api.telnyx.com/v2/telephony_credentials",
                    &json!({ "connection_id": connection, "name": "weldsuite-webrtc" }),
                )
                .header("Authorization", bearer.clone()),
            )
            .await?;
        if !created.ok() {
            return Err(format!("Failed to create credential: {}", created.status));
        }
        let data: Value = serde_json::from_slice(&created.body).map_err(|e| e.to_string())?;
        if !data["data"].is_object() {
            return Err("Cannot read properties of undefined (reading 'id')".to_owned());
        }
        credential = data["data"]["id"].clone();
    }
    let Some(credential) = credential.as_str().filter(|id| is_telnyx_id(id)) else {
        return Err("Unexpected Telnyx credential id format".to_owned());
    };
    let minted = telnyx
        .send(
            HttpRequest::empty(
                "POST",
                format!(
                    "https://api.telnyx.com/v2/telephony_credentials/{}/token",
                    js::encode_uri_component(credential)
                ),
            )
            .header("Authorization", bearer),
        )
        .await?;
    if !minted.ok() {
        return Err(format!("Failed to generate token: {}", minted.status));
    }
    Ok(minted.text())
}

/// `GET /api/call-intelligence/stats`: counters over every call.
pub(crate) async fn stats(caller: Caller) -> Response {
    let found: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object(
             'totalCalls', count(*)::int,
             'completedCalls', (count(*) filter (where status = 'completed'))::int,
             'totalDuration', coalesce(sum(duration), 0)::int,
             'avgDuration', coalesce(avg(duration), 0)::int,
             'inboundCalls', (count(*) filter (where direction = 'inbound'))::int,
             'outboundCalls', (count(*) filter (where direction = 'outbound'))::int,
             'recordedCalls', (count(*) filter (where is_recorded = true))::int,
             'totalCreditsConsumed', coalesce(sum(credits_consumed), 0)::int)
         from voip_calls",
    )
    .fetch_one(&caller.db)
    .await;
    match found {
        Ok(stats) => Data(stats).into_response(),
        Err(error) => internal(&error, "Failed to fetch call statistics"),
    }
}

/// `canAccessCall(c, callId)`: `Err` with the 404 or 403.
#[allow(clippy::result_large_err)] // the route's own answer
async fn can_access(caller: &Caller, call_id: &str) -> Result<(), Response> {
    let owner: Option<String> =
        sqlx::query_scalar("select user_id from voip_calls where id = $1 limit 1")
            .bind(call_id)
            .fetch_optional(&caller.db)
            .await
            .map_err(|error| internal(&error, "Internal server error"))?;
    let Some(owner) = owner else {
        return Err(ApiError::not_found("VoIP call", Some(call_id)).into_response());
    };
    if caller.scope().is_some_and(|scope| scope != owner) {
        return Err(ApiError::forbidden()
            .with_message(CALL_DENIED)
            .into_response());
    }
    Ok(())
}

/// `GET /api/call-intelligence/calls/:id/transcription`: the transcription
/// with its segments in order.
pub(crate) async fn transcription(caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(response) = can_access(&caller, &id).await {
        return response;
    }
    let result = async {
        let transcription: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from crm_transcriptions t where t.activity_id = $1 limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(transcription) = transcription.map(weldsuite_db::js_row) else {
            return Ok(None);
        };
        let segments: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(s) from crm_transcript_segments s
             where s.transcription_id = $1 order by s.sequence_number asc",
        )
        .bind(transcription["id"].as_str().unwrap_or_default())
        .fetch_all(&caller.db)
        .await?;
        Ok::<_, sqlx::Error>(Some((transcription, rows(segments))))
    }
    .await;
    match result {
        Ok(Some((mut transcription, segments))) => {
            let segments: Vec<Value> = segments
                .into_iter()
                .map(|mut segment| {
                    segment["start"] = segment["startTime"].clone();
                    segment["end"] = segment["endTime"].clone();
                    segment["speaker"] = segment["speakerLabel"].clone();
                    segment
                })
                .collect();
            transcription["segments"] = Value::Array(segments);
            Data(transcription).into_response()
        }
        Ok(None) => ApiError::not_found("Transcription", None).into_response(),
        Err(error) => internal(&error, "Failed to fetch transcription"),
    }
}

/// `GET /api/call-intelligence/calls/:id/transcription/status`.
pub(crate) async fn transcription_status(caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(response) = can_access(&caller, &id).await {
        return response;
    }
    let found: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'status', status, 'error_message', error_message,
             'processing_started_at', processing_started_at,
             'processing_completed_at', processing_completed_at,
             'word_count', word_count, 'speaker_count', speaker_count)
         from crm_transcriptions where activity_id = $1 limit 1",
    )
    .bind(&id)
    .fetch_optional(&caller.db)
    .await;
    match found {
        Ok(Some(row)) => {
            let mut row = weldsuite_db::js_row(row);
            row["exists"] = json!(true);
            Data(row).into_response()
        }
        Ok(None) => Data(json!({ "exists": false })).into_response(),
        Err(error) => internal(&error, "Failed to fetch transcription status"),
    }
}

/// `POST /api/call-intelligence/calls/:id/transcription`: a pending
/// transcription for the call (one per call).
pub(crate) async fn create_transcription(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let language = match validate(&headers, &body, |issues, fields| {
        optional_text(issues, fields, "language", Presence::Optional)
    }) {
        Ok(language) => language,
        Err(response) => return *response,
    };
    let result = async {
        let owner: Option<String> =
            sqlx::query_scalar("select user_id from voip_calls where id = $1 limit 1")
                .bind(&id)
                .fetch_optional(&caller.db)
                .await?;
        let Some(owner) = owner else {
            return Ok(ApiError::not_found("VoIP call", Some(&id)).into_response());
        };
        if caller.scope().is_some_and(|scope| scope != owner) {
            return Ok(ApiError::forbidden().with_message(CALL_DENIED).into_response());
        }
        let existing: Option<String> =
            sqlx::query_scalar("select id from crm_transcriptions where activity_id = $1 limit 1")
                .bind(&id)
                .fetch_optional(&caller.db)
                .await?;
        if existing.is_some() {
            return Ok(
                ApiError::conflict("Transcription already exists for this call").into_response(),
            );
        }
        let transcription = weldsuite_kit::generate_id("trans");
        sqlx::query(
            "insert into crm_transcriptions (id, activity_id, status, language, created_at, updated_at)
             values ($1, $2, 'pending', $3, $4::timestamp, $4::timestamp)",
        )
        .bind(&transcription)
        .bind(&id)
        .bind(language.as_deref().unwrap_or("en"))
        .bind(now())
        .execute(&caller.db)
        .await?;
        Ok::<_, sqlx::Error>(Created(json!({ "id": transcription })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to create transcription"))
}
