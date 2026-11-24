//! `/api/calls` (`routes/calls`): the `voip_calls` records, newest first,
//! scoped to the caller's own calls without `activities:scope:all`; the
//! dialer creates a call before dialling (gated by the prepaid wallet) and
//! the call's end settles its minutes. A call placed from a WeldDesk
//! conversation (click-to-call) is linked to it and noted on its timeline.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, Order, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{CALL_CREATED, CALL_DELETED, CALL_UPDATED};
use weldsuite_db::{orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Number, Presence, Text, js_date_iso, query_values};
use weldsuite_kit::{ApiError, Created, CreditShortfall, Data, List, NoContent, Pagination};
use weldsuite_schema::tenant::{desk_conversations, voip_calls, voip_phone_numbers};

use crate::credits::{self, VOIP_CALL_PER_MINUTE};
use crate::desk_phone_messages::post_phone_message;
use crate::{CallState, Caller, internal, js, validate};

/// `Date#toISOString()` of a `timestamp` column, as Drizzle reads it.
pub(crate) fn iso_of(at: PrimitiveDateTime) -> String {
    match weldsuite_schema::js::timestamp::serialize(&at, serde_json::value::Serializer) {
        Ok(Value::String(text)) => text,
        _ => String::new(),
    }
}

/// An ISO date (`toISOString()`) as `$n::timestamp` reads it; `None` for
/// text Postgres would refuse.
pub(crate) fn timestamp_of(iso: &str) -> Option<PrimitiveDateTime> {
    OffsetDateTime::parse(iso, &Rfc3339).ok().map(utc_timestamp)
}

/// A `voip_calls` row as Drizzle reads it (`numeric` as text).
fn call_json(call: voip_calls::Model) -> Result<Value, DbErr> {
    serde_json::to_value(call).map_err(|error| DbErr::Json(error.to_string()))
}

/// `c.req.query(name)`: the first value of a parameter.
pub(crate) fn query_param(query: &Map<String, Value>, name: &str) -> Option<String> {
    match query.get(name)? {
        Value::Array(values) => values.first().and_then(Value::as_str).map(str::to_owned),
        value => value.as_str().map(str::to_owned),
    }
}

/// The list's conditions, in the order the worker adds them; each is on
/// when its value is set: the scope, status, direction, customer, contact,
/// owner, provider and search (a `like` pattern), then the date range and
/// the keyset cursor.
#[derive(Clone, Default)]
struct Filters {
    values: [Option<String>; 8],
    from: Option<PrimitiveDateTime>,
    to: Option<PrimitiveDateTime>,
    cursor: Option<(PrimitiveDateTime, String)>,
}

impl Filters {
    /// The columns `values[0..7]` compare with.
    const COLUMNS: [voip_calls::Column; 7] = [
        voip_calls::Column::UserId,
        voip_calls::Column::Status,
        voip_calls::Column::Direction,
        voip_calls::Column::CustomerId,
        voip_calls::Column::ContactId,
        voip_calls::Column::UserId,
        voip_calls::Column::Provider,
    ];

    /// Leave out the last condition that is on (the date range counts after
    /// the other filters).
    fn drop_last(&mut self) {
        if self.to.is_some() {
            self.to = None;
        } else if self.from.is_some() {
            self.from = None;
        } else if let Some(last) = self.values.iter_mut().rev().find(|v| v.is_some()) {
            *last = None;
        }
    }

    /// The `where` of the list and its count.
    fn condition(&self) -> Condition {
        let mut all = Condition::all();
        for (column, value) in Self::COLUMNS.iter().zip(&self.values) {
            if let Some(value) = value {
                all = all.add(column.eq(value));
            }
        }
        if let Some(pattern) = &self.values[7] {
            all = all.add(
                Condition::any()
                    .add(voip_calls::Column::FromNumber.like(pattern))
                    .add(voip_calls::Column::ToNumber.like(pattern))
                    .add(voip_calls::Column::FromNumberFormatted.like(pattern))
                    .add(voip_calls::Column::ToNumberFormatted.like(pattern))
                    .add(voip_calls::Column::Notes.like(pattern)),
            );
        }
        if let Some(from) = self.from {
            all = all.add(voip_calls::Column::InitiatedAt.gte(from));
        }
        if let Some(to) = self.to {
            all = all.add(voip_calls::Column::InitiatedAt.lte(to));
        }
        if let Some((at, id)) = &self.cursor {
            all = all.add(
                Condition::any()
                    .add(voip_calls::Column::InitiatedAt.lt(*at))
                    .add(
                        Condition::all()
                            .add(voip_calls::Column::InitiatedAt.eq(*at))
                            .add(voip_calls::Column::Id.lt(id)),
                    ),
            );
        }
        all
    }
}

/// A date filter as Drizzle binds it; `Err` for an invalid date, which
/// fails the query (`toISOString()` throws, or Postgres refuses the text).
fn date_filter(value: Option<String>) -> Result<Option<PrimitiveDateTime>, ()> {
    match value.filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(text) => js_date_iso(&text)
            .as_deref()
            .and_then(timestamp_of)
            .map(Some)
            .ok_or(()),
    }
}

/// The keyset of the cursor's call: `initiatedAt` (to the millisecond, as
/// the worker reads it) and the id.
async fn cursor_of(
    caller: &Caller,
    id: &str,
) -> Result<Option<(PrimitiveDateTime, String)>, DbErr> {
    let row: Option<(PrimitiveDateTime, String)> = voip_calls::Entity::find()
        .select_only()
        .columns([voip_calls::Column::InitiatedAt, voip_calls::Column::Id])
        .filter(voip_calls::Column::Id.eq(id))
        .limit(1)
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    Ok(row.map(|(at, id)| (utc_timestamp(at.assume_utc()), id)))
}

/// One page of calls (`limit` rows at most) and the count of `counted`.
async fn page(
    caller: &Caller,
    filters: &Filters,
    counted: &Filters,
    limit: u64,
) -> Result<(Vec<Value>, u64), DbErr> {
    let db = orm(&caller.db);
    let rows = voip_calls::Entity::find()
        .filter(filters.condition())
        .order_by(voip_calls::Column::InitiatedAt, Order::Desc)
        .order_by(voip_calls::Column::Id, Order::Desc)
        .limit(limit)
        .all(&db)
        .await?;
    let count = voip_calls::Entity::find()
        .filter(counted.condition())
        .count(&db)
        .await?;
    let rows = rows.into_iter().map(call_json).collect::<Result<_, _>>()?;
    Ok((rows, count))
}

/// `GET /api/calls`: a page of calls (`limit` ≤ 100, default 25), filtered
/// by status, direction, customer, contact, owner, provider, a search and
/// a date range.
#[allow(clippy::too_many_lines)] // the route, step by step
pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query_values(query.as_deref());
    let q = |name: &str| query_param(&query, name);
    let limit = match q("limit").filter(|l| !l.is_empty()) {
        None => Some(25),
        Some(text) => js::parse_int(&text).map(|n| n.min(100)),
    };
    let mut filters = Filters::default();
    filters.values[0] = caller.scope().map(str::to_owned);
    for (index, name) in [
        "status",
        "direction",
        "customerId",
        "contactId",
        "userId",
        "provider",
    ]
    .iter()
    .enumerate()
    {
        filters.values[index + 1] = q(name).filter(|v| !v.is_empty());
    }
    filters.values[7] = q("search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let (Ok(from), Ok(to)) = (date_filter(q("from")), date_filter(q("to"))) else {
        return internal(&"invalid date", "Failed to list calls");
    };
    filters.from = from;
    filters.to = to;
    let cursor_param = q("cursor").filter(|c| !c.is_empty());
    if let Some(cursor) = &cursor_param {
        match cursor_of(&caller, cursor).await {
            Ok(row) => filters.cursor = row,
            Err(error) => return internal(&error, "Failed to list calls"),
        }
    }
    // The count leaves out the last condition when a cursor was asked for:
    // the keyset one, or, without a cursor row, the last filter.
    let mut count_filters = filters.clone();
    if cursor_param.is_some() {
        if count_filters.cursor.is_some() {
            count_filters.cursor = None;
        } else {
            count_filters.drop_last();
        }
    }
    let Some(limit) = limit else {
        return internal(&"limit is NaN", "Failed to list calls");
    };
    // `limit $n` with `limit + 1`: Postgres refuses a negative one.
    let Ok(fetched) = u64::try_from(limit + 1) else {
        return internal(&"LIMIT must not be negative", "Failed to list calls");
    };
    match page(&caller, &filters, &count_filters, fetched).await {
        Ok((rows, count)) => {
            let wanted = usize::try_from(limit).unwrap_or(0);
            let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
            let data: Vec<Value> = if has_more {
                rows.into_iter().take(wanted).collect()
            } else {
                rows
            };
            let cursor = if has_more {
                data.last()
                    .and_then(|row| row["id"].as_str())
                    .map(str::to_owned)
            } else {
                None
            };
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
        }
        Err(error) => internal(&error, "Failed to list calls"),
    }
}

/// `CONTACT_CALL_STATS_MAX_IDS`.
const MAX_CONTACT_IDS: usize = 100;

/// `zValidator('query', contactCallStatsQuerySchema)`: the ids, or Zod's 400.
fn contact_ids(query: &Map<String, Value>) -> Result<Vec<String>, Box<Response>> {
    let invalid = |issues: Vec<Value>| {
        Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({ "success": false, "error": { "issues": issues, "name": "ZodError" } }),
                ),
            )
                .into_response(),
        )
    };
    let Some(raw) = query_param(query, "contactIds") else {
        return Err(invalid(vec![json!({
            "code": "invalid_type",
            "expected": "string",
            "received": "undefined",
            "path": ["contactIds"],
            "message": "Required",
        })]));
    };
    let mut ids: Vec<String> = Vec::new();
    for id in raw.split(',') {
        let id = weldsuite_kit::validation::js_trim(id);
        if !id.is_empty() && !ids.iter().any(|known| known == id) {
            ids.push(id.to_owned());
        }
    }
    if ids.is_empty() {
        return Err(invalid(vec![json!({
            "code": "too_small",
            "minimum": 1,
            "type": "array",
            "inclusive": true,
            "exact": false,
            "message": "Array must contain at least 1 element(s)",
            "path": ["contactIds"],
        })]));
    }
    if ids.len() > MAX_CONTACT_IDS {
        return Err(invalid(vec![json!({
            "code": "too_big",
            "maximum": MAX_CONTACT_IDS,
            "type": "array",
            "inclusive": true,
            "exact": false,
            "message": format!("Array must contain at most {MAX_CONTACT_IDS} element(s)"),
            "path": ["contactIds"],
        })]));
    }
    let too_long: Vec<Value> = ids
        .iter()
        .enumerate()
        .filter(|(_, id)| id.encode_utf16().count() > 30)
        .map(|(index, _)| {
            json!({
                "code": "too_big",
                "maximum": 30,
                "type": "string",
                "inclusive": true,
                "exact": false,
                "message": "String must contain at most 30 character(s)",
                "path": ["contactIds", index],
            })
        })
        .collect();
    if !too_long.is_empty() {
        return Err(invalid(too_long));
    }
    Ok(ids)
}

/// `GET /api/calls/contact-stats?contactIds=a,b`: calls, inbound and
/// outbound, total time and last call per person, in the caller's scope.
pub(crate) async fn contact_stats(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query_values(query.as_deref());
    let ids = match contact_ids(&query) {
        Ok(ids) => ids,
        Err(response) => return *response,
    };
    match crate::crm::contact_call_stats(&caller.db, &ids, caller.scope()).await {
        Ok(stats) => Data(stats).into_response(),
        Err(error) => internal(&error, "Failed to fetch contact call statistics"),
    }
}

/// `GET /api/calls/:id`.
pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let mut found = voip_calls::Entity::find().filter(voip_calls::Column::Id.eq(&id));
    if let Some(user) = caller.scope() {
        found = found.filter(voip_calls::Column::UserId.eq(user));
    }
    let found = match found.one(&orm(&caller.db)).await {
        Ok(call) => call.map(call_json).transpose(),
        Err(error) => Err(error),
    };
    match found {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Call", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch call"),
    }
}

/// `createCallSchema`.
struct NewCall {
    direction: String,
    from_number: String,
    to_number: String,
    from_formatted: Option<String>,
    to_formatted: Option<String>,
    customer_id: Option<String>,
    contact_id: Option<String>,
    opportunity_id: Option<String>,
    is_recorded: Option<bool>,
    notes: Option<String>,
    provider: Option<String>,
    /// Click-to-call from a WeldDesk conversation.
    desk_conversation_id: Option<String>,
}

/// `createCallSchema`.
fn read_new_call(
    issues: &mut weldsuite_kit::validation::Issues,
    fields: &Map<String, Value>,
) -> NewCall {
    let optional = |issues: &mut weldsuite_kit::validation::Issues, key: &str| {
        issues
            .text_with(fields, key, Presence::Optional, Text::default())
            .into_option()
    };
    NewCall {
        direction: issues
            .choice(
                fields,
                "direction",
                Presence::Required,
                &["inbound", "outbound"],
            )
            .into_option()
            .unwrap_or_default(),
        from_number: issues
            .text(fields, "fromNumber", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        to_number: issues
            .text(fields, "toNumber", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        from_formatted: optional(issues, "fromNumberFormatted"),
        to_formatted: optional(issues, "toNumberFormatted"),
        customer_id: optional(issues, "customerId"),
        contact_id: optional(issues, "contactId"),
        opportunity_id: optional(issues, "opportunityId"),
        is_recorded: issues
            .boolean(fields, "isRecorded", Presence::Optional)
            .into_option(),
        notes: optional(issues, "notes"),
        provider: optional(issues, "provider"),
        desk_conversation_id: issues
            .text(
                fields,
                "deskConversationId",
                Presence::Optional,
                Some(1),
                None,
            )
            .into_option(),
    }
}

/// `resolveMetering(env, workspaceId)`: the master database and the
/// workspace's id there, or `None` (unmetered).
async fn metering(caller: &Caller, state: &CallState) -> Option<(weldsuite_db::PgPool, String)> {
    let master = caller.master(state)?;
    match credits::resolve_workspace(&master, &caller.workspace_id).await {
        Ok(Some(id)) => Some((master, id)),
        Ok(None) => {
            tracing::warn!(workspace = %caller.workspace_id, "[call-api/calls] no master workspace, unmetered");
            None
        }
        Err(error) => {
            tracing::warn!(%error, "[call-api/calls] credit metering unavailable");
            None
        }
    }
}

/// Whether `number` is a live number of the customer's own phone system that
/// Telnyx has not verified as caller id: such a number is a caller id only once
/// it is.
async fn unverified_trunk_number(caller: &Caller, number: &str) -> Result<bool, DbErr> {
    let found: Option<String> = voip_phone_numbers::Entity::find()
        .select_only()
        .column(voip_phone_numbers::Column::Id)
        .filter(voip_phone_numbers::Column::PhoneNumber.eq(crate::registry::normalize_e164(number)))
        .filter(voip_phone_numbers::Column::Provider.eq("sip_trunk"))
        .filter(voip_phone_numbers::Column::CallerIdVerifiedAt.is_null())
        .filter(voip_phone_numbers::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    Ok(found.is_some())
}

/// The new call's row: `initiated`, now.
async fn insert_call(caller: &Caller, id: &str, data: &NewCall) -> Result<u64, DbErr> {
    let now = utc_now();
    voip_calls::Entity::insert(voip_calls::ActiveModel {
        id: Set(id.to_owned()),
        user_id: Set(caller.user_id.clone()),
        provider: Set(data
            .provider
            .as_deref()
            .filter(|p| !p.is_empty())
            .unwrap_or("telnyx")
            .to_owned()),
        direction: Set(data.direction.clone()),
        status: Set("initiated".to_owned()),
        from_number: Set(data.from_number.clone()),
        to_number: Set(data.to_number.clone()),
        from_number_formatted: Set(data.from_formatted.clone()),
        to_number_formatted: Set(data.to_formatted.clone()),
        customer_id: Set(data.customer_id.clone()),
        contact_id: Set(data.contact_id.clone()),
        opportunity_id: Set(data.opportunity_id.clone()),
        is_recorded: Set(Some(data.is_recorded.unwrap_or(true))),
        notes: Set(data.notes.clone()),
        initiated_at: Set(now),
        created_at: Set(now),
        updated_at: Set(now),
        desk_conversation_id: Set(data.desk_conversation_id.clone()),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
    .await
}

/// `POST /api/calls`: a call record, before the dialer dials. An outbound
/// call needs a minute's credits in the wallet (402 otherwise).
pub(crate) async fn create(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_new_call) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    if data.direction == "outbound"
        && let Some((master, workspace)) = metering(&caller, &state).await
    {
        match credits::check(&master, &workspace, VOIP_CALL_PER_MINUTE).await {
            Ok((true, _)) => {}
            Ok((false, balance)) => {
                #[allow(clippy::cast_precision_loss)]
                return ApiError::insufficient_credits(Some(CreditShortfall {
                    current_balance: Some(balance as f64),
                    required: Some(VOIP_CALL_PER_MINUTE as f64),
                    shortfall: Some((VOIP_CALL_PER_MINUTE - balance) as f64),
                }))
                .into_response();
            }
            Err(error) => return internal(&error, "Internal server error"),
        }
    }
    // Click-to-call: the conversation the call is placed from must exist.
    if let Some(conversation) = data.desk_conversation_id.as_deref() {
        let found: Result<Option<String>, DbErr> = desk_conversations::Entity::find()
            .select_only()
            .column(desk_conversations::Column::Id)
            .filter(desk_conversations::Column::Id.eq(conversation))
            .limit(1)
            .into_tuple()
            .one(&orm(&caller.db))
            .await;
        match found {
            Ok(Some(_)) => {}
            Ok(None) => {
                return ApiError::not_found("Conversation", Some(conversation)).into_response();
            }
            Err(error) => return internal(&error, "Internal server error"),
        }
    }
    if data.direction == "outbound" && !data.from_number.is_empty() {
        match unverified_trunk_number(&caller, &data.from_number).await {
            Ok(false) => {}
            Ok(true) => return crate::sip_trunks::caller_id_unverified(),
            Err(error) => return internal(&error, "Internal server error"),
        }
    }
    let id = weldsuite_kit::generate_id("vcall");
    match insert_call(&caller, &id, &data).await {
        Ok(_) => {
            caller.publish(
                &state,
                CALL_CREATED,
                &id,
                &json!({ "id": id, "direction": data.direction, "toNumber": data.to_number, "status": "initiated" }),
            );
            if let Some(conversation) = data.desk_conversation_id.as_deref()
                && data.direction == "outbound"
            {
                let telnyx = caller.telnyx(&state);
                let org = caller.org();
                post_phone_message(
                    &caller.phone(&state, &telnyx, &org),
                    Some(conversation),
                    format!("Outbound call to {}", data.to_number),
                    json!({ "event": "call_outbound", "callId": id, "userId": caller.user_id }),
                )
                .await;
            }
            Created(json!({ "id": id })).into_response()
        }
        Err(error) => internal(&error, "Failed to create call"),
    }
}

/// A field of `updateCallSchema`: left out, or the value written.
type Change<T> = Option<Option<T>>;

/// `updateCallSchema`, with the echo of what was sent.
struct CallChanges {
    status: Change<String>,
    answered_at: Change<String>,
    ended_at: Change<String>,
    duration: Option<i64>,
    customer_id: Change<String>,
    contact_id: Change<String>,
    opportunity_id: Change<String>,
    notes: Option<String>,
    echo: Map<String, Value>,
}

fn read_changes(
    issues: &mut weldsuite_kit::validation::Issues,
    fields: &Map<String, Value>,
) -> CallChanges {
    let mut echo = Map::new();
    let mut text =
        |issues: &mut weldsuite_kit::validation::Issues, key: &str, presence: Presence| {
            let field = issues.text_with(fields, key, presence, Text::default());
            match field {
                weldsuite_kit::validation::Field::Absent => None,
                weldsuite_kit::validation::Field::Null => {
                    echo.insert(key.to_owned(), Value::Null);
                    Some(None)
                }
                weldsuite_kit::validation::Field::Set(value) => {
                    echo.insert(key.to_owned(), json!(value));
                    Some(Some(value))
                }
            }
        };
    let status = text(issues, "status", Presence::Optional);
    let answered_at = text(issues, "answeredAt", Presence::Nullish);
    let ended_at = text(issues, "endedAt", Presence::Nullish);
    let duration = issues
        .whole_number(
            fields,
            "duration",
            Presence::Optional,
            Number {
                min: Some(0.0),
                ..Number::default()
            },
        )
        .into_option();
    let customer_id = text(issues, "customerId", Presence::Nullish);
    let contact_id = text(issues, "contactId", Presence::Nullish);
    let opportunity_id = text(issues, "opportunityId", Presence::Nullish);
    let notes = text(issues, "notes", Presence::Optional).flatten();
    if let Some(duration) = duration {
        echo.insert("duration".to_owned(), json!(duration));
    }
    CallChanges {
        status,
        answered_at,
        ended_at,
        duration,
        customer_id,
        contact_id,
        opportunity_id,
        notes,
        echo,
    }
}

/// A date field as `buildCallUpdateFields` writes it: `v ? new Date(v) :
/// null`; `Err` for a date `toISOString()` can't write.
#[allow(clippy::ref_option)] // read as the changes hold it
fn date_change(change: &Change<String>) -> Result<Change<String>, ()> {
    match change {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(text)) if text.is_empty() => Ok(Some(None)),
        Some(Some(text)) => js_date_iso(text).map(|iso| Some(Some(iso))).ok_or(()),
    }
}

/// A call as an update reads it: `(status, duration, endedAt,
/// creditTransactionId, direction)`.
type ExistingCall = (
    String,
    Option<i32>,
    Option<PrimitiveDateTime>,
    Option<String>,
    String,
);

/// The writes of `PUT /api/calls/:id`: a column for each field sent, the
/// settlement when there is one.
struct CallWrite<'a> {
    changes: &'a CallChanges,
    answered_at: Change<PrimitiveDateTime>,
    ended_at: Change<PrimitiveDateTime>,
    settlement: Option<(i64, String)>,
}

/// `$n::int` of a whole number: out of range fails as the cast did.
fn int(value: i64) -> Result<i32, DbErr> {
    i32::try_from(value).map_err(|_| DbErr::Custom("integer out of range".to_owned()))
}

/// `buildCallUpdateFields`: `updatedAt` and the fields sent.
async fn write_call(caller: &Caller, id: &str, write: CallWrite<'_>) -> Result<(), DbErr> {
    let changes = write.changes;
    let mut update = voip_calls::Entity::update_many()
        .col_expr(voip_calls::Column::UpdatedAt, Expr::value(utc_now()));
    let texts = [
        (voip_calls::Column::Status, &changes.status),
        (voip_calls::Column::CustomerId, &changes.customer_id),
        (voip_calls::Column::ContactId, &changes.contact_id),
        (voip_calls::Column::OpportunityId, &changes.opportunity_id),
    ];
    for (column, change) in texts {
        if let Some(value) = change {
            update = update.col_expr(column, Expr::value(value.clone()));
        }
    }
    for (column, change) in [
        (voip_calls::Column::AnsweredAt, write.answered_at),
        (voip_calls::Column::EndedAt, write.ended_at),
    ] {
        if let Some(value) = change {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(duration) = changes.duration {
        update = update.col_expr(voip_calls::Column::Duration, Expr::value(int(duration)?));
    }
    if let Some(notes) = &changes.notes {
        update = update.col_expr(voip_calls::Column::Notes, Expr::value(notes));
    }
    if let Some((consumed, transaction)) = write.settlement {
        update = update
            .col_expr(
                voip_calls::Column::CreditsConsumed,
                Expr::value(int(consumed)?),
            )
            .col_expr(
                voip_calls::Column::CreditTransactionId,
                Expr::value(transaction),
            );
    }
    update
        .filter(voip_calls::Column::Id.eq(id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// A date change as `$n::timestamp` writes it; `None` for text Postgres
/// would refuse.
#[allow(clippy::ref_option)] // read as the changes hold it
fn timestamp_change(change: &Change<String>) -> Option<Change<PrimitiveDateTime>> {
    match change {
        None => Some(None),
        Some(None) => Some(Some(None)),
        Some(Some(iso)) => timestamp_of(iso).map(|at| Some(Some(at))),
    }
}

/// `PUT /api/calls/:id`: update a call. Once it has ended with a known
/// duration, its minutes are settled from the wallet (once per call).
#[allow(clippy::too_many_lines)] // the route, step by step
pub(crate) async fn update(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let changes = match validate(&headers, &body, read_changes) {
        Ok(changes) => changes,
        Err(response) => return *response,
    };
    let existing: Result<Option<ExistingCall>, DbErr> = voip_calls::Entity::find()
        .select_only()
        .columns([
            voip_calls::Column::Status,
            voip_calls::Column::Duration,
            voip_calls::Column::EndedAt,
            voip_calls::Column::CreditTransactionId,
            voip_calls::Column::Direction,
        ])
        .filter(voip_calls::Column::Id.eq(&id))
        .limit(1)
        .into_tuple()
        .one(&orm(&caller.db))
        .await;
    let existing = match existing {
        Ok(row) => row,
        Err(error) => return internal(&error, "Failed to update call"),
    };
    let Some((status, duration, ended_at_before, transaction, direction)) = existing else {
        return ApiError::not_found("Call", Some(&id)).into_response();
    };
    let (Ok(answered_at), Ok(ended_at)) = (
        date_change(&changes.answered_at),
        date_change(&changes.ended_at),
    ) else {
        return internal(&"invalid date", "Failed to update call");
    };
    let duration_secs = changes.duration.or(duration.map(i64::from)).unwrap_or(0);
    let call_ended = matches!(&changes.ended_at, Some(Some(text)) if !text.is_empty())
        || matches!(&changes.status, Some(Some(s)) if s == "completed")
        || ended_at_before.is_some();
    let mut settlement: Option<(i64, String)> = None;
    if call_ended
        && duration_secs > 0
        && transaction.as_deref().is_none_or(str::is_empty)
        && let Some((master, workspace)) = metering(&caller, &state).await
    {
        match credits::settle_call(
            &master,
            &workspace,
            &id,
            duration_secs,
            ("direction", json!(direction)),
            Some(&caller.user_id),
        )
        .await
        {
            Ok(settled) => settlement = Some(settled),
            Err(error) => {
                tracing::error!(%error, "[call-api/calls] credit settlement FAILED (untracked call!)");
            }
        }
    }
    let value = |change: &Change<String>| change.clone().flatten();
    let (Some(answered_at), Some(ended_at)) =
        (timestamp_change(&answered_at), timestamp_change(&ended_at))
    else {
        return internal(&"invalid date", "Failed to update call");
    };
    let write = CallWrite {
        changes: &changes,
        answered_at,
        ended_at,
        settlement,
    };
    if let Err(error) = write_call(&caller, &id, write).await {
        return internal(&error, "Failed to update call");
    }
    let new_status = value(&changes.status).map_or_else(|| json!(status), |s| json!(s));
    caller.publish(
        &state,
        CALL_UPDATED,
        &id,
        &json!({ "id": id, "status": new_status }),
    );
    let mut echo = changes.echo;
    echo.insert("id".to_owned(), json!(id));
    Data(Value::Object(echo)).into_response()
}

/// `DELETE /api/calls/:id`.
pub(crate) async fn remove(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let db = orm(&caller.db);
    let existing: Result<Option<String>, DbErr> = voip_calls::Entity::find()
        .select_only()
        .column(voip_calls::Column::Id)
        .filter(voip_calls::Column::Id.eq(&id))
        .limit(1)
        .into_tuple()
        .one(&db)
        .await;
    match existing {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Call", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to delete call"),
    }
    if let Err(error) = voip_calls::Entity::delete_many()
        .filter(voip_calls::Column::Id.eq(&id))
        .exec(&db)
        .await
    {
        return internal(&error, "Failed to delete call");
    }
    caller.publish(&state, CALL_DELETED, &id, &json!({ "id": id }));
    NoContent.into_response()
}
