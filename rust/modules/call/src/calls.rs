//! `/api/calls` (`routes/calls`): the `voip_calls` records, newest first,
//! scoped to the caller's own calls without `activities:scope:all`; the
//! dialer creates a call before dialling (gated by the prepaid wallet) and
//! the call's end settles its minutes.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{CALL_CREATED, CALL_DELETED, CALL_UPDATED};
use weldsuite_kit::validation::{Number, Presence, Text, js_date_iso, query_values};
use weldsuite_kit::{ApiError, Created, CreditShortfall, Data, List, NoContent, Pagination};

use crate::credits::{self, VOIP_CALL_PER_MINUTE};
use crate::{CallState, Caller, internal, js, now, validate};

/// A `voip_calls` row as Drizzle reads it (`numeric` as text).
macro_rules! call_row {
    () => {
        "to_jsonb(t) || jsonb_build_object('call_quality_score', t.call_quality_score::text)"
    };
}

/// `c.req.query(name)`: the first value of a parameter.
pub(crate) fn query_param(query: &Map<String, Value>, name: &str) -> Option<String> {
    match query.get(name)? {
        Value::Array(values) => values.first().and_then(Value::as_str).map(str::to_owned),
        value => value.as_str().map(str::to_owned),
    }
}

/// The list's conditions, in the order the worker adds them; each is on
/// when its value is set.
#[derive(Clone, Default)]
struct Filters {
    values: [Option<String>; 10],
    cursor: Option<(String, String)>,
}

const LIST_SQL: &str = concat!(
    "select ",
    call_row!(),
    " from voip_calls t where ($1::text is null or t.user_id = $1)",
    " and ($2::text is null or t.status = $2) and ($3::text is null or t.direction = $3)",
    " and ($4::text is null or t.customer_id = $4) and ($5::text is null or t.contact_id = $5)",
    " and ($6::text is null or t.user_id = $6) and ($7::text is null or t.provider = $7)",
    " and ($8::text is null or (t.from_number like $8 or t.to_number like $8",
    " or t.from_number_formatted like $8 or t.to_number_formatted like $8 or t.notes like $8))",
    " and ($9::timestamp is null or t.initiated_at >= $9::timestamp)",
    " and ($10::timestamp is null or t.initiated_at <= $10::timestamp)",
    " and ($11::timestamp is null or (t.initiated_at < $11::timestamp",
    " or (t.initiated_at = $11::timestamp and t.id < $12)))",
    " order by t.initiated_at desc, t.id desc limit $13"
);

const COUNT_SQL: &str = concat!(
    "select count(*) from voip_calls t where ($1::text is null or t.user_id = $1)",
    " and ($2::text is null or t.status = $2) and ($3::text is null or t.direction = $3)",
    " and ($4::text is null or t.customer_id = $4) and ($5::text is null or t.contact_id = $5)",
    " and ($6::text is null or t.user_id = $6) and ($7::text is null or t.provider = $7)",
    " and ($8::text is null or (t.from_number like $8 or t.to_number like $8",
    " or t.from_number_formatted like $8 or t.to_number_formatted like $8 or t.notes like $8))",
    " and ($9::timestamp is null or t.initiated_at >= $9::timestamp)",
    " and ($10::timestamp is null or t.initiated_at <= $10::timestamp)",
    " and ($11::timestamp is null or (t.initiated_at < $11::timestamp",
    " or (t.initiated_at = $11::timestamp and t.id < $12)))"
);

/// A date filter as Drizzle binds it; `Err` for an invalid date, which
/// fails the query (`toISOString()` throws).
fn date_filter(value: Option<String>) -> Result<Option<String>, ()> {
    match value.filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(text) => js_date_iso(&text).map(Some).ok_or(()),
    }
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
    filters.values[8] = from;
    filters.values[9] = to;
    let cursor_param = q("cursor").filter(|c| !c.is_empty());
    if let Some(cursor) = &cursor_param {
        let found: Result<Option<(String, String)>, sqlx::Error> = sqlx::query_as(
            "select to_char(initiated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
             from voip_calls where id = $1 limit 1",
        )
        .bind(cursor)
        .fetch_optional(&caller.db)
        .await;
        match found {
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
        } else if let Some(last) = count_filters.values.iter_mut().rev().find(|v| v.is_some()) {
            *last = None;
        }
    }
    let Some(limit) = limit else {
        return internal(&"limit is NaN", "Failed to list calls");
    };
    let bind = |sql: &'static str, filters: &Filters| {
        let mut statement = sqlx::query_scalar::<_, Value>(sql);
        for value in &filters.values {
            statement = statement.bind(value.clone());
        }
        let (at, id) = filters.cursor.clone().unzip();
        statement.bind(at).bind(id)
    };
    let rows = bind(LIST_SQL, &filters)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await;
    let mut count_statement = sqlx::query_scalar::<_, i64>(COUNT_SQL);
    for value in &count_filters.values {
        count_statement = count_statement.bind(value.clone());
    }
    let (at, id) = count_filters.cursor.clone().unzip();
    let count = count_statement
        .bind(at)
        .bind(id)
        .fetch_one(&caller.db)
        .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let rows = crate::rows(rows);
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
            List::new(
                data,
                Pagination::new(u64::try_from(count).unwrap_or(0), has_more, cursor),
            )
            .into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list calls"),
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
    let found: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        call_row!(),
        " from voip_calls t where t.id = $1 and ($2::text is null or t.user_id = $2) limit 1"
    ))
    .bind(&id)
    .bind(caller.scope())
    .fetch_optional(&caller.db)
    .await;
    match found {
        Ok(Some(row)) => Data(weldsuite_db::js_row(row)).into_response(),
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

/// `POST /api/calls`: a call record, before the dialer dials. An outbound
/// call needs a minute's credits in the wallet (402 otherwise).
pub(crate) async fn create(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
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
        }
    }) {
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
    let id = weldsuite_kit::generate_id("vcall");
    let now = now();
    let inserted = sqlx::query(
        "insert into voip_calls (id, user_id, provider, direction, status, from_number, to_number,
             from_number_formatted, to_number_formatted, customer_id, contact_id, opportunity_id,
             is_recorded, notes, initiated_at, created_at, updated_at)
         values ($1, $2, $3, $4, 'initiated', $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14::timestamp, $14::timestamp, $14::timestamp)",
    )
    .bind(&id)
    .bind(&caller.user_id)
    .bind(
        data.provider
            .as_deref()
            .filter(|p| !p.is_empty())
            .unwrap_or("telnyx"),
    )
    .bind(&data.direction)
    .bind(&data.from_number)
    .bind(&data.to_number)
    .bind(&data.from_formatted)
    .bind(&data.to_formatted)
    .bind(&data.customer_id)
    .bind(&data.contact_id)
    .bind(&data.opportunity_id)
    .bind(data.is_recorded.unwrap_or(true))
    .bind(&data.notes)
    .bind(&now)
    .execute(&caller.db)
    .await;
    match inserted {
        Ok(_) => {
            caller.publish(
                &state,
                CALL_CREATED,
                &id,
                &json!({ "id": id, "direction": data.direction, "toNumber": data.to_number, "status": "initiated" }),
            );
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

/// A call as an update reads it: `(status, duration, ended, creditTransactionId,
/// direction)`.
type ExistingCall = (String, Option<i32>, bool, Option<String>, String);

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
    let existing: Option<ExistingCall> = match sqlx::query_as(
        "select status, duration, ended_at is not null, credit_transaction_id, direction
         from voip_calls where id = $1 limit 1",
    )
    .bind(&id)
    .fetch_optional(&caller.db)
    .await
    {
        Ok(row) => row,
        Err(error) => return internal(&error, "Failed to update call"),
    };
    let Some((status, duration, ended, transaction, direction)) = existing else {
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
        || ended;
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
    let set = |change: &Change<String>| change.is_some();
    let value = |change: &Change<String>| change.clone().flatten();
    let (consumed, transaction_id) = settlement.clone().unzip();
    let updated = sqlx::query(
        "update voip_calls set updated_at = $2::timestamp,
             status = case when $3 then $4 else status end,
             answered_at = case when $5 then $6::timestamp else answered_at end,
             ended_at = case when $7 then $8::timestamp else ended_at end,
             duration = case when $9 then $10::int else duration end,
             customer_id = case when $11 then $12 else customer_id end,
             contact_id = case when $13 then $14 else contact_id end,
             opportunity_id = case when $15 then $16 else opportunity_id end,
             notes = case when $17 then $18 else notes end,
             credits_consumed = case when $19 then $20::int else credits_consumed end,
             credit_transaction_id = case when $19 then $21 else credit_transaction_id end
         where id = $1",
    )
    .bind(&id)
    .bind(now())
    .bind(set(&changes.status))
    .bind(value(&changes.status))
    .bind(set(&answered_at))
    .bind(value(&answered_at))
    .bind(set(&ended_at))
    .bind(value(&ended_at))
    .bind(changes.duration.is_some())
    .bind(changes.duration)
    .bind(set(&changes.customer_id))
    .bind(value(&changes.customer_id))
    .bind(set(&changes.contact_id))
    .bind(value(&changes.contact_id))
    .bind(set(&changes.opportunity_id))
    .bind(value(&changes.opportunity_id))
    .bind(changes.notes.is_some())
    .bind(&changes.notes)
    .bind(settlement.is_some())
    .bind(consumed)
    .bind(transaction_id)
    .execute(&caller.db)
    .await;
    if let Err(error) = updated {
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
    let existing: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("select id from voip_calls where id = $1 limit 1")
            .bind(&id)
            .fetch_optional(&caller.db)
            .await;
    match existing {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Call", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to delete call"),
    }
    if let Err(error) = sqlx::query("delete from voip_calls where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await
    {
        return internal(&error, "Failed to delete call");
    }
    caller.publish(&state, CALL_DELETED, &id, &json!({ "id": id }));
    NoContent.into_response()
}
