//! `/api/ad-campaigns`: campaigns on the synced ad accounts, created and
//! edited locally and marked for the next push to Meta.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{AD_CAMPAIGN_CREATED, AD_CAMPAIGN_UPDATED};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};

use crate::{AdsState, Caller, internal, query_param, rows, validate};

const OBJECTIVES: [&str; 6] = [
    "OUTCOME_TRAFFIC",
    "OUTCOME_SALES",
    "OUTCOME_LEADS",
    "OUTCOME_AWARENESS",
    "OUTCOME_ENGAGEMENT",
    "OUTCOME_APP_PROMOTION",
];
const STATUSES: [&str; 2] = ["ACTIVE", "PAUSED"];

/// `Number.parseInt(text, 10)`.
fn js_parse_int(text: &str) -> f64 {
    let rest =
        text.trim_start_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    let (negative, rest) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return f64::NAN;
    }
    let value = digits.parse::<f64>().unwrap_or(f64::INFINITY);
    if negative { -value } else { value }
}

/// `rows.slice(0, end)` with JavaScript's end semantics.
fn js_slice_to<T>(mut rows: Vec<T>, end: f64) -> Vec<T> {
    #[allow(clippy::cast_precision_loss)]
    let len = rows.len() as f64;
    let end = if end.is_nan() {
        0.0
    } else if end < 0.0 {
        (len + end).max(0.0)
    } else {
        end.min(len)
    };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    rows.truncate(end as usize);
    rows
}

/// One of the list's filters, in the order the route builds them.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Filter {
    Live,
    Account,
    Status,
    SyncStatus,
    Search,
}

/// `GET /api/ad-campaigns`: the live campaigns with their account, most
/// recently updated first, paged by a cursor on `(created_at, id)`.
pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query_values(query.as_deref());
    let param = |name: &str| query_param(&query, name).filter(|value| !value.is_empty());
    let limit = param("limit").map_or(25.0, |raw| js_parse_int(&raw));
    // `Math.min(limit, 100)`, NaN kept.
    let limit = if limit.is_nan() {
        limit
    } else {
        limit.min(100.0)
    };
    let account = param("adAccountId");
    let status = param("status");
    let sync_status = param("syncStatus");
    let search = param("search").map(|search| format!("%{search}%"));
    let cursor_id = param("cursor");

    match list_page(
        &caller,
        limit,
        [account, status, sync_status, search],
        cursor_id,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => internal(&error, "Failed to list ad campaigns"),
    }
}

async fn list_page(
    caller: &Caller,
    limit: f64,
    [account, status, sync_status, search]: [Option<String>; 4],
    cursor_id: Option<String>,
) -> Result<Response, sqlx::Error> {
    let mut cursor: Option<(String, String)> = None;
    if let Some(id) = &cursor_id {
        let found: Option<(Option<Value>, String)> = sqlx::query_as(
            "select to_jsonb(created_at), id from ad_campaigns where id = $1 limit 1",
        )
        .bind(id)
        .fetch_optional(&caller.db)
        .await?;
        cursor = found.and_then(|(created_at, id)| {
            let created_at = created_at
                .as_ref()
                .and_then(Value::as_str)
                .and_then(weldsuite_db::js_timestamp)?;
            Some((created_at, id))
        });
    }

    // The count takes the filters without the cursor's condition, which the
    // route does by dropping the last condition whenever a cursor was given:
    // with an unknown cursor that is the last filter.
    let mut counted: Vec<Filter> = vec![Filter::Live];
    for (filter, value) in [
        (Filter::Account, &account),
        (Filter::Status, &status),
        (Filter::SyncStatus, &sync_status),
        (Filter::Search, &search),
    ] {
        if value.is_some() {
            counted.push(filter);
        }
    }
    if cursor_id.is_some() && cursor.is_none() {
        counted.pop();
    }
    let counts = |filter: Filter, value: &Option<String>| {
        if counted.contains(&filter) {
            value.clone()
        } else {
            None
        }
    };

    // `limit + 1` rows; Drizzle leaves out a limit that is not a number >= 0.
    let probe = limit + 1.0;
    #[allow(clippy::cast_possible_truncation)]
    let sql_limit = (probe >= 0.0).then_some(probe as i64);
    let found: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(x) from (
             select c.id, c.ad_account_id, c.platform_campaign_id, c.name, c.status, c.objective,
                    c.daily_budget, c.lifetime_budget, c.currency, c.metrics, c.metrics_synced_at,
                    c.sync_status, c.sync_error, c.last_synced_at, c.created_at, c.updated_at,
                    a.name as account_name, a.platform_account_id
             from ad_campaigns c
             inner join ad_accounts a on c.ad_account_id = a.id
             where c.deleted_at is null
               and ($1::text is null or c.ad_account_id = $1)
               and ($2::text is null or c.status = $2)
               and ($3::text is null or c.sync_status = $3::ad_campaign_sync_status)
               and ($4::text is null or c.name like $4)
               and ($5::text is null
                    or c.created_at < $5::timestamp
                    or (c.created_at = $5::timestamp and c.id < $6))
             order by c.updated_at desc, c.id desc
             limit $7
         ) x",
    )
    .bind(&account)
    .bind(&status)
    .bind(&sync_status)
    .bind(&search)
    .bind(cursor.as_ref().map(|(created_at, _)| created_at.as_str()))
    .bind(cursor.as_ref().map(|(_, id)| id.as_str()))
    .bind(sql_limit)
    .fetch_all(&caller.db)
    .await?;
    let total = count(
        caller,
        counted.contains(&Filter::Live),
        [
            counts(Filter::Account, &account),
            counts(Filter::Status, &status),
            counts(Filter::SyncStatus, &sync_status),
            counts(Filter::Search, &search),
        ],
    )
    .await?;

    #[allow(clippy::cast_precision_loss)]
    let has_more = (found.len() as f64) > limit;
    let data = if has_more {
        js_slice_to(rows(found), limit)
    } else {
        rows(found)
    };
    let cursor = if has_more {
        data.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    let total = u64::try_from(total).unwrap_or_default();
    Ok(List::new(data, Pagination::new(total, has_more, cursor)).into_response())
}

/// The list's `count(*)` under the counted filters.
async fn count(
    caller: &Caller,
    live: bool,
    [account, status, sync_status, search]: [Option<String>; 4],
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(*)::bigint from ad_campaigns
         where ($1::bool is not true or deleted_at is null)
           and ($2::text is null or ad_account_id = $2)
           and ($3::text is null or status = $3)
           and ($4::text is null or sync_status = $4::ad_campaign_sync_status)
           and ($5::text is null or name like $5)",
    )
    .bind(live)
    .bind(account)
    .bind(status)
    .bind(sync_status)
    .bind(search)
    .fetch_one(&caller.db)
    .await
}

/// `GET /api/ad-campaigns/:id`.
pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match live_campaign(&caller, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Ad campaign", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch ad campaign"),
    }
}

async fn live_campaign(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from ad_campaigns c where c.id = $1 and c.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

// ── validation ──────────────────────────────────────────────────────────────

/// Whether Zod stops before the schema's `.refine()`: a field of the wrong
/// type, or an enum value it doesn't know, makes the object invalid; a
/// failed `.min()`, `.int()` or `.positive()` does not.
fn aborts(fields: &Map<String, Value>, required: bool, key: &str, kind: Kind) -> bool {
    match fields.get(key) {
        None => required,
        Some(value) => match kind {
            Kind::Text => !value.is_string(),
            Kind::Number => !value.is_number(),
            Kind::Choice(options) => !value.as_str().is_some_and(|v| options.contains(&v)),
        },
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Number,
    Choice(&'static [&'static str]),
}

/// `z.number().int().positive().optional()`.
fn budget(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Field<i64> {
    let field = issues.whole_number(fields, key, Presence::Optional, Number::default());
    if let Some(number) = fields.get(key).and_then(Value::as_f64)
        && number <= 0.0
    {
        issues.issue_at(
            key,
            json!({
                "code": "too_small",
                "minimum": 0,
                "type": "number",
                "inclusive": false,
                "exact": false,
                "message": "Number must be greater than 0",
            }),
        );
        return Field::Absent;
    }
    field
}

fn nullish(fields: &Map<String, Value>, key: &str) -> bool {
    matches!(fields.get(key), None | Some(Value::Null))
}

/// The fields a campaign is created or edited with.
struct CampaignInput {
    ad_account_id: Option<String>,
    name: Option<String>,
    objective: Option<String>,
    status: Option<String>,
    daily_budget: Option<i64>,
    lifetime_budget: Option<i64>,
}

/// `createSchema`.
fn create_input(headers: &HeaderMap, body: &Bytes) -> Result<CampaignInput, Box<Response>> {
    validate(headers, body, |issues, fields| {
        let aborted = aborts(fields, true, "adAccountId", Kind::Text)
            || aborts(fields, true, "name", Kind::Text)
            || aborts(fields, true, "objective", Kind::Choice(&OBJECTIVES))
            || aborts(fields, false, "status", Kind::Choice(&STATUSES))
            || aborts(fields, false, "dailyBudget", Kind::Number)
            || aborts(fields, false, "lifetimeBudget", Kind::Number);
        let input = CampaignInput {
            ad_account_id: issues
                .text(fields, "adAccountId", Presence::Required, Some(1), None)
                .into_option(),
            name: issues
                .text_with(
                    fields,
                    "name",
                    Presence::Required,
                    Text::trimmed(Some(1), Some(255)),
                )
                .into_option(),
            objective: issues
                .choice(fields, "objective", Presence::Required, &OBJECTIVES)
                .into_option(),
            status: issues
                .choice(fields, "status", Presence::Optional, &STATUSES)
                .into_option(),
            daily_budget: budget(issues, fields, "dailyBudget").into_option(),
            lifetime_budget: budget(issues, fields, "lifetimeBudget").into_option(),
        };
        if !aborted && nullish(fields, "dailyBudget") && nullish(fields, "lifetimeBudget") {
            issues.custom(
                "dailyBudget",
                "Either dailyBudget or lifetimeBudget is required",
            );
        }
        input
    })
}

/// `patchSchema`.
fn patch_input(headers: &HeaderMap, body: &Bytes) -> Result<CampaignInput, Box<Response>> {
    validate(headers, body, |issues, fields| {
        let aborted = aborts(fields, false, "name", Kind::Text)
            || aborts(fields, false, "objective", Kind::Choice(&OBJECTIVES))
            || aborts(fields, false, "status", Kind::Choice(&STATUSES))
            || aborts(fields, false, "dailyBudget", Kind::Number)
            || aborts(fields, false, "lifetimeBudget", Kind::Number);
        let input = CampaignInput {
            ad_account_id: None,
            name: issues
                .text_with(
                    fields,
                    "name",
                    Presence::Optional,
                    Text::trimmed(Some(1), Some(255)),
                )
                .into_option(),
            objective: issues
                .choice(fields, "objective", Presence::Optional, &OBJECTIVES)
                .into_option(),
            status: issues
                .choice(fields, "status", Presence::Optional, &STATUSES)
                .into_option(),
            daily_budget: budget(issues, fields, "dailyBudget").into_option(),
            lifetime_budget: budget(issues, fields, "lifetimeBudget").into_option(),
        };
        let nothing = [
            "name",
            "objective",
            "status",
            "dailyBudget",
            "lifetimeBudget",
        ]
        .iter()
        .all(|key| nullish(fields, key));
        if !aborted && nothing {
            issues.custom_root("At least one field is required");
        }
        input
    })
}

// ── writes ──────────────────────────────────────────────────────────────────

/// What `createLocalCampaign` / `updateLocalCampaign` throw.
enum WriteError {
    Message(&'static str),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for WriteError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl WriteError {
    fn message(&self) -> String {
        match self {
            Self::Message(message) => (*message).to_owned(),
            Self::Database(error) => error.to_string(),
        }
    }
}

/// `loadWritableAccount`: a live account chosen for sync; its currency.
async fn writable_account(caller: &Caller, id: &str) -> Result<Option<String>, WriteError> {
    let account: Option<(Option<String>, bool)> = sqlx::query_as(
        "select currency, is_selected from ad_accounts where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((currency, is_selected)) = account else {
        return Err(WriteError::Message("Ad account not found"));
    };
    if !is_selected {
        return Err(WriteError::Message("Ad account is not selected for sync"));
    }
    Ok(currency)
}

/// `POST /api/ad-campaigns`: a local campaign, pending its first push.
pub(crate) async fn create(
    State(state): State<AdsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match create_input(&headers, &body) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    match create_campaign(&caller, &input).await {
        Ok(row) => {
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            caller.publish(&state, AD_CAMPAIGN_CREATED, &id, &row);
            Created(row).into_response()
        }
        Err(error) => {
            if let WriteError::Database(error) = &error {
                tracing::error!(%error, "[ads-api/ad-campaigns] create failed");
            }
            ApiError::bad_request(error.message()).into_response()
        }
    }
}

async fn create_campaign(caller: &Caller, input: &CampaignInput) -> Result<Value, WriteError> {
    let account_id = input.ad_account_id.clone().unwrap_or_default();
    let currency = writable_account(caller, &account_id).await?;
    let now = weldsuite_ads_domain::now();
    let row: Value = sqlx::query_scalar(
        "insert into ad_campaigns
             (id, ad_account_id, platform_campaign_id, name, status, objective, daily_budget,
              lifetime_budget, currency, sync_status, sync_error, created_at, updated_at)
         values ($1, $2, null, $3, $4, $5, $6::int, $7::int, $8, 'pending_push', null,
                 $9::timestamp, $9::timestamp)
         returning to_jsonb(ad_campaigns)",
    )
    .bind(generate_id("adcp"))
    .bind(&account_id)
    .bind(input.name.as_deref().unwrap_or_default())
    .bind(input.status.as_deref().unwrap_or("PAUSED"))
    .bind(input.objective.as_deref())
    .bind(input.daily_budget)
    .bind(input.lifetime_budget)
    .bind(currency)
    .bind(&now)
    .fetch_one(&caller.db)
    .await?;
    Ok(weldsuite_db::js_row(row))
}

/// `PATCH /api/ad-campaigns/:id`: the fields given, then pending a push.
pub(crate) async fn update(
    State(state): State<AdsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match patch_input(&headers, &body) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    match update_campaign(&caller, &id, &input).await {
        Ok(row) => {
            let row_id = row["id"].as_str().unwrap_or_default().to_owned();
            caller.publish(&state, AD_CAMPAIGN_UPDATED, &row_id, &row);
            Data(row).into_response()
        }
        Err(error) => {
            if let WriteError::Database(error) = &error {
                tracing::error!(%error, "[ads-api/ad-campaigns] patch failed");
            }
            let message = error.message();
            if message.contains("not found") {
                return ApiError::not_found("Ad campaign", Some(&id)).into_response();
            }
            ApiError::bad_request(message).into_response()
        }
    }
}

async fn update_campaign(
    caller: &Caller,
    id: &str,
    input: &CampaignInput,
) -> Result<Value, WriteError> {
    let account_id: Option<String> = sqlx::query_scalar(
        "select ad_account_id from ad_campaigns where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    let Some(account_id) = account_id else {
        return Err(WriteError::Message("Ad campaign not found"));
    };
    writable_account(caller, &account_id).await?;
    let row: Option<Value> = sqlx::query_scalar(
        "update ad_campaigns set
             name = coalesce($2, name),
             objective = coalesce($3, objective),
             status = coalesce($4, status),
             daily_budget = coalesce($5::int, daily_budget),
             lifetime_budget = coalesce($6::int, lifetime_budget),
             sync_status = 'pending_push',
             sync_error = null,
             updated_at = $7::timestamp
         where id = $1
         returning to_jsonb(ad_campaigns)",
    )
    .bind(id)
    .bind(input.name.as_deref())
    .bind(input.objective.as_deref())
    .bind(input.status.as_deref())
    .bind(input.daily_budget)
    .bind(input.lifetime_budget)
    .bind(weldsuite_ads_domain::now())
    .fetch_optional(&caller.db)
    .await?;
    row.map(weldsuite_db::js_row)
        .ok_or(WriteError::Message("Ad campaign not found"))
}
