//! `/api/ad-campaigns`: campaigns on the synced ad accounts, created and
//! edited locally and marked for the next push to Meta.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveEnum, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, FromQueryResult,
    JoinType, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{AD_CAMPAIGN_CREATED, AD_CAMPAIGN_UPDATED};
use weldsuite_db::orm;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};
use weldsuite_schema::tenant::enums::AdCampaignSyncStatus;
use weldsuite_schema::tenant::{ad_accounts, ad_campaigns};

use crate::orm_bridge::sqlx_message;
use crate::{AdsState, Caller, internal, json_error, query_param, validate};

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

/// A listed campaign with its account's name and Meta id.
#[derive(FromQueryResult)]
struct CampaignRow {
    id: String,
    ad_account_id: String,
    platform_campaign_id: Option<String>,
    name: String,
    status: Option<String>,
    objective: Option<String>,
    daily_budget: Option<i32>,
    lifetime_budget: Option<i32>,
    currency: Option<String>,
    metrics: Option<Value>,
    metrics_synced_at: Option<PrimitiveDateTime>,
    sync_status: AdCampaignSyncStatus,
    sync_error: Option<String>,
    last_synced_at: Option<PrimitiveDateTime>,
    created_at: PrimitiveDateTime,
    updated_at: PrimitiveDateTime,
    account_name: String,
    platform_account_id: String,
}

/// A `timestamp` as Drizzle's `Date` (`toISOString()`).
fn iso(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
}

impl CampaignRow {
    /// The row as Drizzle's `select({ … })` returned it.
    fn json(self) -> Value {
        json!({
            "id": self.id,
            "adAccountId": self.ad_account_id,
            "platformCampaignId": self.platform_campaign_id,
            "name": self.name,
            "status": self.status,
            "objective": self.objective,
            "dailyBudget": self.daily_budget,
            "lifetimeBudget": self.lifetime_budget,
            "currency": self.currency,
            "metrics": self.metrics,
            "metricsSyncedAt": self.metrics_synced_at.map(iso),
            "syncStatus": self.sync_status.to_value(),
            "syncError": self.sync_error,
            "lastSyncedAt": self.last_synced_at.map(iso),
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
            "accountName": self.account_name,
            "platformAccountId": self.platform_account_id,
        })
    }
}

/// The keyset operands: the cursor campaign's `createdAt` as JavaScript read
/// it (milliseconds) and its id.
type Cursor = (PrimitiveDateTime, String);

/// The filters the list and its count share; `live` is
/// `isNull(adCampaigns.deletedAt)`.
fn filtered(live: bool, [account, status, sync_status, search]: [Option<String>; 4]) -> Condition {
    let mut all = Condition::all();
    if live {
        all = all.add(ad_campaigns::Column::DeletedAt.is_null());
    }
    if let Some(account) = account {
        all = all.add(ad_campaigns::Column::AdAccountId.eq(account));
    }
    if let Some(status) = status {
        all = all.add(ad_campaigns::Column::Status.eq(status));
    }
    if let Some(sync_status) = sync_status {
        all = all.add(ad_campaigns::Column::SyncStatus.eq(sync_status));
    }
    if let Some(search) = search {
        all = all.add(ad_campaigns::Column::Name.like(search));
    }
    all
}

/// `or(lt(createdAt, at), and(eq(createdAt, at), lt(id, id)))`.
fn before((at, id): Cursor) -> Condition {
    Condition::any()
        .add(ad_campaigns::Column::CreatedAt.lt(at))
        .add(
            Condition::all()
                .add(ad_campaigns::Column::CreatedAt.eq(at))
                .add(ad_campaigns::Column::Id.lt(id)),
        )
}

async fn list_page(
    caller: &Caller,
    limit: f64,
    [account, status, sync_status, search]: [Option<String>; 4],
    cursor_id: Option<String>,
) -> Result<Response, DbErr> {
    let db = orm(&caller.db);
    let mut cursor: Option<Cursor> = None;
    if let Some(id) = &cursor_id {
        let found: Option<(PrimitiveDateTime, String)> = ad_campaigns::Entity::find()
            .select_only()
            .columns([ad_campaigns::Column::CreatedAt, ad_campaigns::Column::Id])
            .filter(ad_campaigns::Column::Id.eq(id))
            .into_tuple()
            .one(&db)
            .await?;
        cursor = found
            .map(|(created_at, id)| (weldsuite_db::utc_timestamp(created_at.assume_utc()), id));
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
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let sql_limit = (probe >= 0.0).then_some(probe as u64);
    let mut conditions = filtered(
        true,
        [
            account.clone(),
            status.clone(),
            sync_status.clone(),
            search.clone(),
        ],
    );
    if let Some(cursor) = cursor {
        conditions = conditions.add(before(cursor));
    }
    let found = page(&db, conditions, sql_limit).await?;
    let total = ad_campaigns::Entity::find()
        .filter(filtered(
            counted.contains(&Filter::Live),
            [
                counts(Filter::Account, &account),
                counts(Filter::Status, &status),
                counts(Filter::SyncStatus, &sync_status),
                counts(Filter::Search, &search),
            ],
        ))
        .count(&db)
        .await?;

    #[allow(clippy::cast_precision_loss)]
    let has_more = (found.len() as f64) > limit;
    let data = if has_more {
        js_slice_to(found, limit)
    } else {
        found
    };
    let cursor = if has_more {
        data.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    Ok(List::new(data, Pagination::new(total, has_more, cursor)).into_response())
}

/// The page: the campaigns `conditions` keep, with their account, most
/// recently updated first.
async fn page(
    db: &DatabaseConnection,
    conditions: Condition,
    limit: Option<u64>,
) -> Result<Vec<Value>, DbErr> {
    let rows = ad_campaigns::Entity::find()
        .select_only()
        .columns([
            ad_campaigns::Column::Id,
            ad_campaigns::Column::AdAccountId,
            ad_campaigns::Column::PlatformCampaignId,
            ad_campaigns::Column::Name,
            ad_campaigns::Column::Status,
            ad_campaigns::Column::Objective,
            ad_campaigns::Column::DailyBudget,
            ad_campaigns::Column::LifetimeBudget,
            ad_campaigns::Column::Currency,
            ad_campaigns::Column::Metrics,
            ad_campaigns::Column::MetricsSyncedAt,
            ad_campaigns::Column::SyncStatus,
            ad_campaigns::Column::SyncError,
            ad_campaigns::Column::LastSyncedAt,
            ad_campaigns::Column::CreatedAt,
            ad_campaigns::Column::UpdatedAt,
        ])
        .column_as(ad_accounts::Column::Name, "account_name")
        .column_as(
            ad_accounts::Column::PlatformAccountId,
            "platform_account_id",
        )
        .join(
            JoinType::InnerJoin,
            ad_campaigns::Entity::belongs_to(ad_accounts::Entity)
                .from(ad_campaigns::Column::AdAccountId)
                .to(ad_accounts::Column::Id)
                .into(),
        )
        .filter(conditions)
        .order_by_desc(ad_campaigns::Column::UpdatedAt)
        .order_by_desc(ad_campaigns::Column::Id)
        .limit(limit)
        .into_model::<CampaignRow>()
        .all(db)
        .await?;
    Ok(rows.into_iter().map(CampaignRow::json).collect())
}

/// `GET /api/ad-campaigns/:id`.
pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match live_campaign(&caller, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Ad campaign", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch ad campaign"),
    }
}

async fn live_campaign(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    ad_campaigns::Entity::find()
        .filter(ad_campaigns::Column::Id.eq(id))
        .filter(ad_campaigns::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(|campaign| serde_json::to_value(campaign).map_err(json_error))
        .transpose()
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
    Database(DbErr),
}

impl From<DbErr> for WriteError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

impl WriteError {
    /// The thrown error's `message`: a failed statement's as the driver
    /// gave it.
    fn message(&self) -> String {
        match self {
            Self::Message(message) => (*message).to_owned(),
            Self::Database(error) => sqlx_message(error),
        }
    }
}

/// `loadWritableAccount`: a live account chosen for sync; its currency.
async fn writable_account(caller: &Caller, id: &str) -> Result<Option<String>, WriteError> {
    let account: Option<(Option<String>, bool)> = ad_accounts::Entity::find()
        .select_only()
        .columns([
            ad_accounts::Column::Currency,
            ad_accounts::Column::IsSelected,
        ])
        .filter(ad_accounts::Column::Id.eq(id))
        .filter(ad_accounts::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
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
    let now = weldsuite_db::utc_now();
    let row = ad_campaigns::Entity::insert(ad_campaigns::ActiveModel {
        id: Set(generate_id("adcp")),
        ad_account_id: Set(account_id),
        platform_campaign_id: Set(None),
        name: Set(input.name.clone().unwrap_or_default()),
        status: Set(Some(
            input.status.clone().unwrap_or_else(|| "PAUSED".to_owned()),
        )),
        objective: Set(input.objective.clone()),
        daily_budget: Set(budget_int(input.daily_budget)?),
        lifetime_budget: Set(budget_int(input.lifetime_budget)?),
        currency: Set(currency),
        sync_status: Set(AdCampaignSyncStatus::PendingPush),
        sync_error: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await?;
    serde_json::to_value(row).map_err(|error| WriteError::Database(json_error(error)))
}

/// A budget as the `integer` column takes it (`$n::int`): one out of its
/// range is the statement's error.
fn budget_int(budget: Option<i64>) -> Result<Option<i32>, WriteError> {
    budget
        .map(|budget| {
            i32::try_from(budget).map_err(|_| {
                WriteError::Message("error returned from database: integer out of range")
            })
        })
        .transpose()
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
    let account_id: Option<String> = ad_campaigns::Entity::find()
        .select_only()
        .column(ad_campaigns::Column::AdAccountId)
        .filter(ad_campaigns::Column::Id.eq(id))
        .filter(ad_campaigns::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    let Some(account_id) = account_id else {
        return Err(WriteError::Message("Ad campaign not found"));
    };
    writable_account(caller, &account_id).await?;
    let daily_budget = budget_int(input.daily_budget)?;
    let lifetime_budget = budget_int(input.lifetime_budget)?;
    // `coalesce(new, column)`: a field the body leaves out keeps its value.
    let mut update = ad_campaigns::Entity::update_many();
    if let Some(name) = &input.name {
        update = update.col_expr(ad_campaigns::Column::Name, Expr::val(name.as_str()));
    }
    if let Some(objective) = &input.objective {
        update = update.col_expr(
            ad_campaigns::Column::Objective,
            Expr::val(objective.as_str()),
        );
    }
    if let Some(status) = &input.status {
        update = update.col_expr(ad_campaigns::Column::Status, Expr::val(status.as_str()));
    }
    if let Some(budget) = daily_budget {
        update = update.col_expr(ad_campaigns::Column::DailyBudget, Expr::val(budget));
    }
    if let Some(budget) = lifetime_budget {
        update = update.col_expr(ad_campaigns::Column::LifetimeBudget, Expr::val(budget));
    }
    let rows = update
        .col_expr(
            ad_campaigns::Column::SyncStatus,
            ad_campaigns::Column::SyncStatus.save_as(Expr::val(AdCampaignSyncStatus::PendingPush)),
        )
        .col_expr(
            ad_campaigns::Column::SyncError,
            Expr::val(Option::<String>::None),
        )
        .col_expr(
            ad_campaigns::Column::UpdatedAt,
            Expr::val(weldsuite_db::utc_now()),
        )
        .filter(ad_campaigns::Column::Id.eq(id))
        .exec_with_returning(&orm(&caller.db))
        .await?;
    let row = rows
        .into_iter()
        .next()
        .ok_or(WriteError::Message("Ad campaign not found"))?;
    serde_json::to_value(row).map_err(|error| WriteError::Database(json_error(error)))
}
