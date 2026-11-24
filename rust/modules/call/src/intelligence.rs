//! `/api/call-intelligence` (`routes/call-intelligence`): the workspace's
//! phone numbers (`voip_phone_numbers`, soft-deleted), the WebRTC token
//! (Telnyx telephony credentials), call statistics and a call's
//! transcription, which follows the call's owner scope.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, FromQueryResult, Order, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{CALL_CREATED, CALL_DELETED, CALL_UPDATED};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent};
use weldsuite_ports::HttpRequest;
use weldsuite_schema::tenant::{
    crm_transcript_segments as segments, crm_transcriptions as transcriptions, voip_calls,
    voip_phone_numbers as numbers,
};

use crate::calls::{iso_of, query_param};
use crate::sip_trunks::{TRUNK_NUMBER_REFUSAL, TRUNK_PROVIDER};
use crate::{CallState, Caller, internal, js, validate};

/// A row as the API returns it: the entity's JSON.
fn json_error(error: &serde_json::Error) -> DbErr {
    DbErr::Json(error.to_string())
}

const CALL_DENIED: &str = "You do not have access to this call";

/// `GET /api/call-intelligence/phone-numbers[?status=&provider=]`: the
/// live numbers, the default first.
pub(crate) async fn list_numbers(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query_values(query.as_deref());
    let status = query_param(&query, "status").filter(|s| !s.is_empty());
    let provider = query_param(&query, "provider").filter(|p| !p.is_empty());
    let mut found = numbers::Entity::find().filter(numbers::Column::DeletedAt.is_null());
    if let Some(status) = status {
        found = found.filter(numbers::Column::Status.eq(status));
    }
    if let Some(provider) = provider {
        found = found.filter(numbers::Column::Provider.eq(provider));
    }
    let found = found
        .order_by(numbers::Column::IsDefault, Order::Desc)
        .order_by(numbers::Column::CreatedAt, Order::Desc)
        .all(&orm(&caller.db))
        .await
        .and_then(|found| {
            found
                .into_iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| json_error(&error))
        });
    match found {
        Ok(found) => Data(found).into_response(),
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
    let now = utc_now();
    let inserted = numbers::Entity::insert(numbers::ActiveModel {
        id: Set(id.clone()),
        provider: Set(data.provider.clone()),
        phone_number: Set(data.phone_number.clone()),
        formatted_number: Set(data.formatted_number.clone()),
        country_code: Set(data.country_code.clone()),
        number_type: Set(Some(
            data.number_type.as_deref().unwrap_or("local").to_owned(),
        )),
        status: Set(data.status.clone()),
        provider_phone_number_id: Set(data.provider_phone_number_id.clone()),
        provider_connection_id: Set(data.provider_connection_id.clone()),
        display_name: Set(data.display_name.clone()),
        description: Set(data.description.clone()),
        is_default: Set(Some(data.is_default.unwrap_or(false))),
        allow_inbound: Set(Some(data.allow_inbound.unwrap_or(true))),
        allow_outbound: Set(Some(data.allow_outbound.unwrap_or(true))),
        enable_recording: Set(Some(data.enable_recording.unwrap_or(true))),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
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

/// A live number's provider, when the number exists.
/// A live number's provider, and whether Telnyx verified it as caller id.
async fn live_number(caller: &Caller, id: &str) -> Result<Option<(String, bool)>, DbErr> {
    let found: Option<(String, Option<PrimitiveDateTime>)> = numbers::Entity::find()
        .select_only()
        .columns([
            numbers::Column::Provider,
            numbers::Column::CallerIdVerifiedAt,
        ])
        .filter(numbers::Column::Id.eq(id))
        .filter(numbers::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    Ok(found.map(|(provider, verified_at)| (provider, verified_at.is_some())))
}

/// `PATCH`'s update: `updatedAt`, and each field the body sent.
async fn write_number(caller: &Caller, id: &str, changes: NumberChanges) -> Result<(), DbErr> {
    let mut update =
        numbers::Entity::update_many().col_expr(numbers::Column::UpdatedAt, Expr::value(utc_now()));
    if !changes.display_name.is_absent() {
        update = update.col_expr(
            numbers::Column::DisplayName,
            Expr::value(changes.display_name.into_option()),
        );
    }
    let texts = [
        (numbers::Column::Status, changes.status),
        (numbers::Column::FormattedNumber, changes.formatted_number),
        (numbers::Column::Description, changes.description),
    ];
    for (column, value) in texts {
        if let Some(value) = value {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    let flags = [
        (numbers::Column::IsDefault, changes.is_default),
        (numbers::Column::AllowInbound, changes.allow_inbound),
        (numbers::Column::AllowOutbound, changes.allow_outbound),
        (numbers::Column::EnableRecording, changes.enable_recording),
    ];
    for (column, value) in flags {
        if let Some(value) = value {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    update
        .filter(numbers::Column::Id.eq(id))
        .filter(numbers::Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
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
        // A number on the customer's own phone system is shown as caller id
        // only once Telnyx verified it is theirs.
        Ok(Some((provider, verified)))
            if provider == TRUNK_PROVIDER && changes.allow_outbound == Some(true) && !verified =>
        {
            return crate::sip_trunks::caller_id_unverified();
        }
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Phone number", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to update phone number"),
    }
    match write_number(&caller, &id, changes).await {
        Ok(()) => {
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
        // A number on the customer's own phone system is removed from that
        // system (desk/phone/sip-trunks).
        Ok(Some((provider, _))) if provider == TRUNK_PROVIDER => {
            return ApiError::conflict(TRUNK_NUMBER_REFUSAL).into_response();
        }
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Phone number", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to delete phone number"),
    }
    let now = utc_now();
    if let Err(error) = numbers::Entity::update_many()
        .col_expr(numbers::Column::DeletedAt, Expr::value(now))
        .col_expr(numbers::Column::UpdatedAt, Expr::value(now))
        .filter(numbers::Column::Id.eq(&id))
        .exec(&orm(&caller.db))
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

/// The counters of `GET /api/call-intelligence/stats`, each `::int`.
#[derive(Debug, FromQueryResult)]
struct CallStats {
    total_calls: i32,
    completed_calls: i32,
    total_duration: i32,
    avg_duration: i32,
    inbound_calls: i32,
    outbound_calls: i32,
    recorded_calls: i32,
    total_credits_consumed: i32,
}

/// `GET /api/call-intelligence/stats`: counters over every call.
pub(crate) async fn stats(caller: Caller) -> Response {
    // `(…)::int`, `count(*) filter (where c)` as `count(case when c then 1 end)`.
    let int = |expr: Expr| Expr::from(Func::cast_as(expr, "int"));
    let count_where = |condition: Expr| int(Func::count(Expr::case(condition, 1)).into());
    let or_zero = |expr: Expr| int(Func::coalesce([expr, Expr::val(0)]).into());
    let found = voip_calls::Entity::find()
        .select_only()
        .column_as(int(Func::count(Expr::col(Asterisk)).into()), "total_calls")
        .column_as(
            count_where(voip_calls::Column::Status.eq("completed")),
            "completed_calls",
        )
        .column_as(
            or_zero(voip_calls::Column::Duration.sum()),
            "total_duration",
        )
        .column_as(
            or_zero(Func::avg(Expr::col(voip_calls::Column::Duration)).into()),
            "avg_duration",
        )
        .column_as(
            count_where(voip_calls::Column::Direction.eq("inbound")),
            "inbound_calls",
        )
        .column_as(
            count_where(voip_calls::Column::Direction.eq("outbound")),
            "outbound_calls",
        )
        .column_as(
            count_where(voip_calls::Column::IsRecorded.eq(true)),
            "recorded_calls",
        )
        .column_as(
            or_zero(voip_calls::Column::CreditsConsumed.sum()),
            "total_credits_consumed",
        )
        .into_model::<CallStats>()
        .one(&orm(&caller.db))
        .await;
    match found {
        Ok(stats) => Data(stats.map(|stats| {
            json!({
                "totalCalls": stats.total_calls,
                "completedCalls": stats.completed_calls,
                "totalDuration": stats.total_duration,
                "avgDuration": stats.avg_duration,
                "inboundCalls": stats.inbound_calls,
                "outboundCalls": stats.outbound_calls,
                "recordedCalls": stats.recorded_calls,
                "totalCreditsConsumed": stats.total_credits_consumed,
            })
        }))
        .into_response(),
        Err(error) => internal(&error, "Failed to fetch call statistics"),
    }
}

/// The call's owner, when the call exists.
async fn call_owner(caller: &Caller, call_id: &str) -> Result<Option<String>, DbErr> {
    voip_calls::Entity::find()
        .select_only()
        .column(voip_calls::Column::UserId)
        .filter(voip_calls::Column::Id.eq(call_id))
        .limit(1)
        .into_tuple()
        .one(&orm(&caller.db))
        .await
}

/// `canAccessCall(c, callId)`: `Err` with the 404 or 403.
#[allow(clippy::result_large_err)] // the route's own answer
async fn can_access(caller: &Caller, call_id: &str) -> Result<(), Response> {
    let owner = call_owner(caller, call_id)
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
        let db = orm(&caller.db);
        let transcription = transcriptions::Entity::find()
            .filter(transcriptions::Column::ActivityId.eq(&id))
            .one(&db)
            .await?;
        let Some(transcription) = transcription else {
            return Ok(None);
        };
        let segments = segments::Entity::find()
            .filter(segments::Column::TranscriptionId.eq(&transcription.id))
            .order_by(segments::Column::SequenceNumber, Order::Asc)
            .all(&db)
            .await?;
        let transcription =
            serde_json::to_value(transcription).map_err(|error| json_error(&error))?;
        let segments = segments
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| json_error(&error))?;
        Ok::<_, DbErr>(Some((transcription, segments)))
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

/// A transcription's progress, as `jsonb_build_object` of its columns read.
#[derive(Debug, FromQueryResult)]
struct TranscriptionStatus {
    id: String,
    status: String,
    error_message: Option<String>,
    processing_started_at: Option<PrimitiveDateTime>,
    processing_completed_at: Option<PrimitiveDateTime>,
    word_count: Option<i32>,
    speaker_count: Option<i32>,
}

impl TranscriptionStatus {
    /// The object as Drizzle's row reads (camelCase, `toISOString()`).
    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "status": self.status,
            "errorMessage": self.error_message,
            "processingStartedAt": self.processing_started_at.map(iso_of),
            "processingCompletedAt": self.processing_completed_at.map(iso_of),
            "wordCount": self.word_count,
            "speakerCount": self.speaker_count,
        })
    }
}

/// `GET /api/call-intelligence/calls/:id/transcription/status`.
pub(crate) async fn transcription_status(caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(response) = can_access(&caller, &id).await {
        return response;
    }
    let found = transcriptions::Entity::find()
        .select_only()
        .columns([
            transcriptions::Column::Id,
            transcriptions::Column::Status,
            transcriptions::Column::ErrorMessage,
            transcriptions::Column::ProcessingStartedAt,
            transcriptions::Column::ProcessingCompletedAt,
            transcriptions::Column::WordCount,
            transcriptions::Column::SpeakerCount,
        ])
        .filter(transcriptions::Column::ActivityId.eq(&id))
        .limit(1)
        .into_model::<TranscriptionStatus>()
        .one(&orm(&caller.db))
        .await;
    match found {
        Ok(Some(row)) => {
            let mut row = row.json();
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
        let owner = call_owner(&caller, &id).await?;
        let Some(owner) = owner else {
            return Ok(ApiError::not_found("VoIP call", Some(&id)).into_response());
        };
        if caller.scope().is_some_and(|scope| scope != owner) {
            return Ok(ApiError::forbidden()
                .with_message(CALL_DENIED)
                .into_response());
        }
        let existing: Option<String> = transcriptions::Entity::find()
            .select_only()
            .column(transcriptions::Column::Id)
            .filter(transcriptions::Column::ActivityId.eq(&id))
            .limit(1)
            .into_tuple()
            .one(&orm(&caller.db))
            .await?;
        if existing.is_some() {
            return Ok(
                ApiError::conflict("Transcription already exists for this call").into_response(),
            );
        }
        let transcription = weldsuite_kit::generate_id("trans");
        let now = utc_now();
        transcriptions::Entity::insert(transcriptions::ActiveModel {
            id: Set(transcription.clone()),
            activity_id: Set(id.clone()),
            status: Set("pending".to_owned()),
            language: Set(Some(language.as_deref().unwrap_or("en").to_owned())),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        Ok::<_, DbErr>(Created(json!({ "id": transcription })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to create transcription"))
}
