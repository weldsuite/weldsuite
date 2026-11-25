//! `/api/replenishment` (Rust only; `weldsuite-documentation/plans/weldstash-replenishment.md`,
//! phases 2 to 4):
//!
//! ```text
//! GET    /settings                 the settings (or their defaults)          inventory:read
//! PATCH  /settings                 change them                               inventory:manage
//! GET    /plans                    item plans, filtered, cursor-paged        inventory:read
//! GET    /plans/:id                a plan, its rule and product supplier     inventory:read
//! GET    /plans/:id/demand         weekly demand and forecast, for a chart   inventory:read
//! POST   /plans/:id/dismiss        snooze a suggestion                       inventory:update
//! POST   /plans/:id/restore        undo that                                 inventory:update
//! GET    /rules                    reorder rules                             inventory:read
//! PUT    /rules                    create or change an item's rule           inventory:manage
//! DELETE /rules/:id                remove one                                inventory:manage
//! GET    /runs                     planning runs, newest first               inventory:read
//! POST   /runs                     plan now                                  inventory:manage
//! POST   /purchase-orders          draft purchase orders from plans          purchase_orders:create
//! GET    /incoming                 stock on open purchase orders             inventory:read
//! …      /imports                  CSV sales history ([`super::imports`])
//! ```
//!
//! Every change publishes its entity event, except dismiss and restore,
//! which only move a plan's review state.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequestParts, Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::{Alias, Expr, OnConflict, Query};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DatabaseConnection, DbBackend, DbErr, EntityTrait,
    FromQueryResult, Iterable, Order, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    REORDER_RULE_CREATED, REORDER_RULE_DELETED, REORDER_RULE_UPDATED,
    REPLENISHMENT_SETTINGS_UPDATED,
};
use weldsuite_catalogs::permission_keys::{INVENTORY_MANAGE, INVENTORY_READ};
use weldsuite_db::{MasterDb, PgPool, Tenant, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::DynJobs;
use weldsuite_schema::tenant::{
    product_suppliers, product_variants, products, stash_planning_runs, stash_reorder_rules,
    stash_settings, warehouses,
};

use super::demand::item_key;
use super::engine::MAX_QUANTITY;
use super::run::{RunStart, SWEEP_KIND, StartError, Started, next_run_at, start_run};
use super::settings::{SETTINGS_ID, from_json, model_json, settings_json};
use super::{imports, orders, plans};
use crate::incoming::{IncomingQuery, VariantFilter, incoming, parse_date};
use crate::js::{query_param, query_set};
use crate::{Caller, Refusal, StashState, internal, validate};

/// What the replenishment routes need beyond [`StashState`]: the master
/// database (the due index of the nightly runs) and the jobs port (runs).
/// The binary adds it to the stash router as a request extension; without
/// it, nothing is marked due and `POST /runs` answers 503.
#[derive(Clone, Default)]
pub struct Services {
    pub master: Option<PgPool>,
    pub jobs: Option<Arc<dyn DynJobs>>,
}

impl std::fmt::Debug for Services {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Services")
            .field("master", &self.master.is_some())
            .field("jobs", &self.jobs.is_some())
            .finish()
    }
}

/// A replenishment request: the stash [`Caller`], the workspace's
/// `workspaces.id` and the [`Services`] (the test's master database first,
/// in conformance builds).
pub(crate) struct Ctx {
    pub(crate) caller: Caller,
    pub(crate) workspace_id: String,
    pub(crate) master: Option<PgPool>,
    pub(crate) jobs: Option<Arc<dyn DynJobs>>,
}

impl<S: Send + Sync> FromRequestParts<S> for Ctx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let caller = Caller::from_request_parts(parts, state).await?;
        let workspace_id = parts
            .extensions
            .get::<Tenant>()
            .map(|tenant| tenant.workspace_id.clone())
            .unwrap_or_default();
        let services = parts
            .extensions
            .get::<Services>()
            .cloned()
            .unwrap_or_default();
        let master = parts
            .extensions
            .get::<MasterDb>()
            .map(|master| master.0.clone())
            .or(services.master);
        Ok(Self {
            caller,
            workspace_id,
            master,
            jobs: services.jobs,
        })
    }
}

impl Ctx {
    /// Have the nightly sweep look at this workspace by `at` (best effort).
    pub(crate) async fn mark_due(&self, at: OffsetDateTime) {
        if let Some(master) = &self.master {
            weldsuite_db::due_index::mark_due(master, SWEEP_KIND, &self.workspace_id, at).await;
        }
    }

    /// Have the nightly sweep look at this workspace at `at` and not
    /// before, even when it was due earlier (the run hour moved later).
    pub(crate) async fn set_due(&self, at: OffsetDateTime) {
        if let Some(master) = &self.master {
            weldsuite_db::due_index::set_due(master, SWEEP_KIND, &self.workspace_id, at).await;
        }
    }
}

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([INVENTORY_READ]);
    let manage = || gate.require([INVENTORY_MANAGE]);
    Router::new()
        .route("/settings", get(get_settings).route_layer(read()))
        .route("/settings", patch(patch_settings).route_layer(manage()))
        .route("/rules", get(list_rules).route_layer(read()))
        .route("/rules", put(put_rule).route_layer(manage()))
        .route("/rules/{id}", delete(delete_rule).route_layer(manage()))
        .route("/runs", get(list_runs).route_layer(read()))
        .route("/runs", post(start).route_layer(manage()))
        .route("/incoming", get(list_incoming).route_layer(read()))
        .merge(plans::routes(gate))
        .merge(orders::routes(gate))
        .merge(imports::routes(gate))
}

/// A whole number in `[min, max]`.
pub(crate) fn whole(min: i64, max: i64) -> Number {
    #[allow(clippy::cast_precision_loss)] // small bounds
    Number {
        coerce: false,
        int: true,
        min: Some(min as f64),
        max: Some(max as f64),
    }
}

/// An id: `z.string().min(1)`, at most a `varchar(30)`.
pub(crate) fn id_text() -> Text {
    Text::length(Some(1), Some(30))
}

/// `YYYY-MM-DD` that is a real day.
pub(crate) fn is_iso_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
        && parse_date(text).is_some()
}

/// `?variantId=`: an id, `none` (no variant), or any.
pub(crate) fn variant_filter(query: Option<&str>) -> VariantFilter {
    match query_set(query, "variantId").as_deref() {
        None => VariantFilter::Any,
        Some("none") => VariantFilter::None,
        Some(id) => VariantFilter::Only(id.to_owned()),
    }
}

/// A [`VariantFilter`] on a `variant_id` column: any, none
/// (`coalesce(variant_id, '') = ''`) or the one.
pub(crate) fn variant_condition(column: impl ColumnTrait, filter: &VariantFilter) -> Condition {
    match filter {
        VariantFilter::Any => Condition::all(),
        VariantFilter::None => Condition::any().add(column.is_null()).add(column.eq("")),
        VariantFilter::Only(id) => Condition::all().add(column.eq(id.as_str())),
    }
}

/// `?limit=` within `[1, max]`, `fallback` when missing or not a number.
pub(crate) fn limit_param(query: Option<&str>, fallback: i64, max: i64) -> i64 {
    query_param(query, "limit")
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .map_or(fallback, |limit| limit.clamp(1, max))
}

/// `select exists(select 1 from … where …)`.
async fn exists<E: EntityTrait>(db: &DatabaseConnection, query: Select<E>) -> Result<bool, DbErr>
where
    E::Model: Sync,
{
    Ok(query.count(db).await? > 0)
}

/// The live warehouse `id` exists.
async fn warehouse_exists(db: &DatabaseConnection, id: &str) -> Result<bool, DbErr> {
    exists(
        db,
        warehouses::Entity::find()
            .filter(warehouses::Column::Id.eq(id))
            .filter(warehouses::Column::DeletedAt.is_null()),
    )
    .await
}

// ── Settings ────────────────────────────────────────────────────────────────

async fn get_settings(caller: Caller) -> Response {
    match settings_json(&orm(&caller.db)).await {
        Ok(row) => Data(row).into_response(),
        Err(error) => internal(&error, "Failed to fetch replenishment settings"),
    }
}

/// `PATCH /settings`'s body: every field optional.
#[derive(Debug, Default)]
struct SettingsPatch {
    enabled: Field<bool>,
    service_level: Field<f64>,
    review_period_days: Field<i64>,
    lookback_days: Field<i64>,
    lead_time_days: Field<i64>,
    demand_warehouse_id: Field<String>,
    cutover: Field<String>,
    run_hour_utc: Field<i64>,
}

impl SettingsPatch {
    /// The keys the body sets, in the schema's order.
    fn changes(&self) -> Vec<&'static str> {
        [
            ("replenishmentEnabled", self.enabled.is_absent()),
            ("defaultServiceLevel", self.service_level.is_absent()),
            (
                "defaultReviewPeriodDays",
                self.review_period_days.is_absent(),
            ),
            ("lookbackDays", self.lookback_days.is_absent()),
            ("defaultLeadTimeDays", self.lead_time_days.is_absent()),
            ("demandWarehouseId", self.demand_warehouse_id.is_absent()),
            ("historyCutoverDate", self.cutover.is_absent()),
            ("runHourUtc", self.run_hour_utc.is_absent()),
        ]
        .into_iter()
        .filter(|(_, absent)| !absent)
        .map(|(key, _)| key)
        .collect()
    }
}

fn read_settings(issues: &mut Issues, body: &Map<String, Value>) -> SettingsPatch {
    let optional = Presence::Optional;
    SettingsPatch {
        enabled: issues.boolean(body, "replenishmentEnabled", optional),
        service_level: issues.number(
            body,
            "defaultServiceLevel",
            optional,
            Number {
                coerce: false,
                int: false,
                min: Some(0.5),
                max: Some(0.999),
            },
        ),
        review_period_days: issues.whole_number(
            body,
            "defaultReviewPeriodDays",
            optional,
            whole(1, 90),
        ),
        lookback_days: issues.whole_number(body, "lookbackDays", optional, whole(28, 730)),
        lead_time_days: issues.whole_number(body, "defaultLeadTimeDays", optional, whole(0, 365)),
        demand_warehouse_id: issues.text_with(
            body,
            "demandWarehouseId",
            Presence::Nullish,
            Text::length(None, Some(30)),
        ),
        cutover: issues.pattern(
            body,
            "historyCutoverDate",
            Presence::Nullish,
            None,
            None,
            is_iso_day,
            "Use YYYY-MM-DD",
        ),
        run_hour_utc: issues.whole_number(body, "runHourUtc", optional, whole(0, 23)),
    }
}

/// A nullable field as `(given, value)`; an empty string is null.
fn nullable_slot(field: &Field<String>) -> (bool, Option<String>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(text) => (true, Some(text.clone()).filter(|text| !text.is_empty())),
    }
}

/// `insert … on conflict (id) do update`: the body's fields over the saved
/// row, the column defaults over none. The row as Drizzle returns it.
async fn upsert_settings(
    db: &DatabaseConnection,
    patch: &SettingsPatch,
    (warehouse_given, warehouse): (bool, Option<String>),
    (cutover_given, cutover): (bool, Option<String>),
) -> Result<Value, DbErr> {
    use sea_orm::ExprTrait as _;
    use stash_settings::Column;
    let now = utc_now();
    // `coalesce($3::numeric, 0.950)`: the number as Postgres casts a float.
    let service_level = match patch.service_level.as_set() {
        Some(level) => Expr::val(*level).cast_as("numeric"),
        None => Expr::val("0.950").cast_as("numeric"),
    };
    let mut update = vec![Column::UpdatedAt];
    let mut set = |column: Column, given: bool| {
        if given {
            update.push(column);
        }
    };
    set(Column::ReplenishmentEnabled, !patch.enabled.is_absent());
    set(
        Column::DefaultServiceLevel,
        !patch.service_level.is_absent(),
    );
    set(
        Column::DefaultReviewPeriodDays,
        !patch.review_period_days.is_absent(),
    );
    set(Column::LookbackDays, !patch.lookback_days.is_absent());
    set(
        Column::DefaultLeadTimeDays,
        !patch.lead_time_days.is_absent(),
    );
    set(Column::DemandWarehouseId, warehouse_given);
    set(Column::HistoryCutoverDate, cutover_given);
    set(Column::RunHourUtc, !patch.run_hour_utc.is_absent());
    let mut insert = Query::insert();
    insert
        .into_table(stash_settings::Entity)
        .columns([
            Column::Id,
            Column::CreatedAt,
            Column::UpdatedAt,
            Column::ReplenishmentEnabled,
            Column::DefaultServiceLevel,
            Column::DefaultReviewPeriodDays,
            Column::LookbackDays,
            Column::DefaultLeadTimeDays,
            Column::DemandWarehouseId,
            Column::HistoryCutoverDate,
            Column::RunHourUtc,
        ])
        .values([
            Expr::val(SETTINGS_ID),
            Expr::val(now),
            Expr::val(now),
            Expr::val(patch.enabled.as_set().copied().unwrap_or(false)),
            service_level,
            Expr::val(patch.review_period_days.as_set().copied().unwrap_or(7)),
            Expr::val(patch.lookback_days.as_set().copied().unwrap_or(365)),
            Expr::val(patch.lead_time_days.as_set().copied().unwrap_or(14)),
            Expr::val(warehouse),
            Expr::val(cutover).cast_as("date"),
            Expr::val(patch.run_hour_utc.as_set().copied().unwrap_or(2)),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .on_conflict(
            OnConflict::column(Column::Id)
                .update_columns(update)
                .to_owned(),
        )
        .returning_all();
    let row = db
        .query_one_raw(DbBackend::Postgres.build(&insert))
        .await?
        .ok_or(DbErr::RecordNotInserted)?;
    model_json!(stash_settings::Model::from_query_result(&row, "")?)
}

async fn patch_settings(
    State(state): State<StashState>,
    ctx: Ctx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update replenishment settings";
    let patch = match validate(&headers, &body, read_settings) {
        Ok(patch) => patch,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match save_settings(&ctx, &patch).await {
        Ok((before, row)) => {
            let after = from_json(&row);
            ctx.caller.publish(
                &state,
                REPLENISHMENT_SETTINGS_UPDATED,
                SETTINGS_ID,
                &json!({
                    "id": SETTINGS_ID,
                    "replenishmentEnabled": after.enabled,
                    "runHourUtc": after.run_hour_utc,
                    "changes": patch.changes(),
                }),
            );
            let now = OffsetDateTime::now_utc();
            if after.enabled && !before.enabled {
                ctx.mark_due(now).await;
            } else if after.enabled && after.run_hour_utc != before.run_hour_utc {
                // Replace the old hour's due time: kept (it is the earlier
                // one when the hour moved later), the sweep would run at the
                // old hour and again at the new one the same day.
                ctx.set_due(next_run_at(now, after.run_hour_utc)).await;
            }
            Data(row).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// The settings before, and the saved row.
async fn save_settings(
    ctx: &Ctx,
    patch: &SettingsPatch,
) -> Result<(super::settings::Settings, Value), Refusal> {
    let db = &orm(&ctx.caller.db);
    let warehouse = nullable_slot(&patch.demand_warehouse_id);
    if let Some(id) = &warehouse.1
        && !warehouse_exists(db, id).await?
    {
        return Err(Refusal::not_found("Warehouse", id));
    }
    let cutover = nullable_slot(&patch.cutover);
    let before = from_json(&settings_json(db).await?);
    let row = upsert_settings(db, patch, warehouse, cutover).await?;
    Ok((before, row))
}

// ── Rules ───────────────────────────────────────────────────────────────────

async fn list_rules(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let product = query_set(query, "productId");
    let warehouse = query_set(query, "warehouseId");
    let variant = variant_filter(query);
    let mut rules = stash_reorder_rules::Entity::find().filter(variant_condition(
        stash_reorder_rules::Column::VariantId,
        &variant,
    ));
    if let Some(product) = product {
        rules = rules.filter(stash_reorder_rules::Column::ProductId.eq(product));
    }
    if let Some(warehouse) = warehouse {
        rules = rules.filter(stash_reorder_rules::Column::WarehouseId.eq(warehouse));
    }
    let rows = rules
        .order_by(stash_reorder_rules::Column::CreatedAt, Order::Asc)
        .order_by(stash_reorder_rules::Column::Id, Order::Asc)
        .all(&orm(&caller.db))
        .await
        .and_then(|rows| {
            rows.iter()
                .map(|row| model_json!(row))
                .collect::<Result<Vec<_>, _>>()
        });
    match rows {
        Ok(rows) => {
            let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
            List::new(rows, Pagination::new(total, false, None)).into_response()
        }
        Err(error) => internal(&error, "Failed to list reorder rules"),
    }
}

/// `PUT /rules`'s body.
#[derive(Debug)]
struct RuleBody {
    product_id: String,
    variant_id: Option<String>,
    warehouse_id: String,
    method: String,
    min_qty: Option<i64>,
    max_qty: Option<i64>,
    service_level: Option<f64>,
    review_period_days: Option<i64>,
    lead_time_days_override: Option<i64>,
    product_supplier_id: Option<String>,
}

fn read_rule(issues: &mut Issues, body: &Map<String, Value>) -> Option<RuleBody> {
    let nullish = Presence::Nullish;
    let product_id = issues.text_with(body, "productId", Presence::Required, id_text());
    let variant_id = issues.text_with(body, "variantId", nullish, Text::length(None, Some(30)));
    let warehouse_id = issues.text_with(body, "warehouseId", Presence::Required, id_text());
    let method = issues.choice(
        body,
        "method",
        Presence::Required,
        &["auto", "min_max", "off"],
    );
    let min_qty = issues.whole_number(body, "minQty", nullish, whole(0, MAX_QUANTITY));
    let max_qty = issues.whole_number(body, "maxQty", nullish, whole(0, MAX_QUANTITY));
    let service_level = issues.number(
        body,
        "serviceLevel",
        nullish,
        Number {
            coerce: false,
            int: false,
            min: Some(0.5),
            max: Some(0.999),
        },
    );
    let review = issues.whole_number(body, "reviewPeriodDays", nullish, whole(1, 90));
    let lead = issues.whole_number(body, "leadTimeDaysOverride", nullish, whole(0, 365));
    let product_supplier_id = issues.text_with(
        body,
        "productSupplierId",
        nullish,
        Text::length(None, Some(30)),
    );
    if issues.is_empty() && method.as_set().map(String::as_str) == Some("min_max") {
        let fits =
            matches!((min_qty.as_set(), max_qty.as_set()), (Some(min), Some(max)) if min <= max);
        if !fits {
            issues.custom(
                "maxQty",
                "Min and max are required, and min cannot exceed max",
            );
        }
    }
    Some(RuleBody {
        product_id: product_id.into_option()?,
        variant_id: variant_id.into_option().filter(|id| !id.is_empty()),
        warehouse_id: warehouse_id.into_option()?,
        method: method.into_option()?,
        min_qty: min_qty.into_option(),
        max_qty: max_qty.into_option(),
        service_level: service_level.into_option(),
        review_period_days: review.into_option(),
        lead_time_days_override: lead.into_option(),
        product_supplier_id: product_supplier_id
            .into_option()
            .filter(|id| !id.is_empty()),
    })
}

/// `insert … on conflict (item_key) do update … returning *, (xmax = 0)`:
/// the rule as Drizzle returns it, and whether the row is new (a row
/// inserted by the statement has no `xmax`).
async fn upsert_rule(db: &DatabaseConnection, rule: &RuleBody) -> Result<(Value, bool), DbErr> {
    use sea_orm::ExprTrait as _;
    use stash_reorder_rules::Column;
    let now = utc_now();
    let mut insert = Query::insert();
    insert
        .into_table(stash_reorder_rules::Entity)
        .columns([
            Column::Id,
            Column::CreatedAt,
            Column::UpdatedAt,
            Column::ItemKey,
            Column::ProductId,
            Column::VariantId,
            Column::WarehouseId,
            Column::Method,
            Column::MinQty,
            Column::MaxQty,
            Column::ServiceLevel,
            Column::ReviewPeriodDays,
            Column::LeadTimeDaysOverride,
            Column::ProductSupplierId,
        ])
        .values([
            Expr::val(generate_id("rrule")),
            Expr::val(now),
            Expr::val(now),
            Expr::val(item_key(
                &rule.product_id,
                rule.variant_id.as_deref(),
                &rule.warehouse_id,
            )),
            Expr::val(rule.product_id.as_str()),
            Expr::val(rule.variant_id.clone()),
            Expr::val(rule.warehouse_id.as_str()),
            Expr::val(rule.method.as_str()),
            Expr::val(rule.min_qty),
            Expr::val(rule.max_qty),
            // `$10::numeric`: the number as Postgres casts a float.
            Expr::val(rule.service_level).cast_as("numeric"),
            Expr::val(rule.review_period_days),
            Expr::val(rule.lead_time_days_override),
            Expr::val(rule.product_supplier_id.clone()),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .on_conflict(
            OnConflict::column(Column::ItemKey)
                .update_columns([
                    Column::UpdatedAt,
                    Column::Method,
                    Column::MinQty,
                    Column::MaxQty,
                    Column::ServiceLevel,
                    Column::ReviewPeriodDays,
                    Column::LeadTimeDaysOverride,
                    Column::ProductSupplierId,
                ])
                .to_owned(),
        )
        .returning(
            Query::returning().exprs(
                Column::iter()
                    .map(Expr::col)
                    .chain([Expr::col(Alias::new("xmax")).eq(0)]),
            ),
        );
    let row = db
        .query_one_raw(DbBackend::Postgres.build(&insert))
        .await?
        .ok_or(DbErr::RecordNotInserted)?;
    let inserted: bool = row.try_get_by_index(Column::iter().count())?;
    let rule = stash_reorder_rules::Model::from_query_result(&row, "")?;
    Ok((model_json!(rule)?, inserted))
}

/// The data of a `reorder_rule` event.
fn rule_event(rule: &Value) -> Value {
    json!({
        "id": rule["id"],
        "productId": rule["productId"],
        "variantId": rule["variantId"],
        "warehouseId": rule["warehouseId"],
        "method": rule["method"],
    })
}

async fn put_rule(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to save reorder rule";
    let rule = match validate(&headers, &body, read_rule) {
        Ok(Some(rule)) => rule,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond(FAILED),
    };
    match save_rule(&caller, &rule).await {
        Ok((row, inserted)) => {
            let event = if inserted {
                REORDER_RULE_CREATED
            } else {
                REORDER_RULE_UPDATED
            };
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            caller.publish(&state, event, &id, &rule_event(&row));
            Data(row).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// The checks (404s), then the upsert: the rule and whether it is new.
async fn save_rule(caller: &Caller, rule: &RuleBody) -> Result<(Value, bool), Refusal> {
    let db = &orm(&caller.db);
    let product = products::Entity::find()
        .filter(products::Column::Id.eq(&rule.product_id))
        .filter(products::Column::DeletedAt.is_null());
    if !exists(db, product).await? {
        return Err(Refusal::not_found("Product", &rule.product_id));
    }
    if let Some(variant) = &rule.variant_id {
        let found = product_variants::Entity::find()
            .filter(product_variants::Column::Id.eq(variant))
            .filter(product_variants::Column::ProductId.eq(&rule.product_id))
            .filter(product_variants::Column::DeletedAt.is_null());
        if !exists(db, found).await? {
            return Err(Refusal::not_found("Product variant", variant));
        }
    }
    if !warehouse_exists(db, &rule.warehouse_id).await? {
        return Err(Refusal::not_found("Warehouse", &rule.warehouse_id));
    }
    if let Some(link) = &rule.product_supplier_id {
        // `coalesce(variant_id, '') = '' or variant_id = $3`.
        let mut variant = Condition::any()
            .add(product_suppliers::Column::VariantId.is_null())
            .add(product_suppliers::Column::VariantId.eq(""));
        if let Some(id) = &rule.variant_id {
            variant = variant.add(product_suppliers::Column::VariantId.eq(id));
        }
        let found = product_suppliers::Entity::find()
            .filter(product_suppliers::Column::Id.eq(link))
            .filter(product_suppliers::Column::ProductId.eq(&rule.product_id))
            .filter(variant)
            .filter(product_suppliers::Column::DeletedAt.is_null());
        if !exists(db, found).await? {
            return Err(Refusal::not_found("Product supplier", link));
        }
    }
    Ok(upsert_rule(db, rule).await?)
}

async fn delete_rule(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete reorder rule";
    let row = stash_reorder_rules::Entity::delete_many()
        .filter(stash_reorder_rules::Column::Id.eq(&id))
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.first().map(|row| model_json!(row)).transpose());
    match row {
        Ok(Some(row)) => {
            caller.publish(&state, REORDER_RULE_DELETED, &id, &rule_event(&row));
            NoContent.into_response()
        }
        Ok(None) => Refusal::not_found("Reorder rule", &id).respond(FAILED),
        Err(error) => internal(&error, FAILED),
    }
}

// ── Runs ────────────────────────────────────────────────────────────────────

async fn list_runs(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list planning runs";
    let limit = limit_param(query.as_deref(), 20, 100);
    let db = orm(&caller.db);
    let rows = stash_planning_runs::Entity::find()
        .order_by(stash_planning_runs::Column::StartedAt, Order::Desc)
        .order_by(stash_planning_runs::Column::Id, Order::Desc)
        .limit(u64::try_from(limit).ok())
        .all(&db)
        .await
        .and_then(|rows| {
            rows.iter()
                .map(|row| model_json!(row))
                .collect::<Result<Vec<_>, _>>()
        });
    let total = stash_planning_runs::Entity::find().count(&db).await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => {
            let has_more = total > u64::try_from(rows.len()).unwrap_or(u64::MAX);
            List::new(rows, Pagination::new(total, has_more, None)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn start(State(state): State<StashState>, ctx: Ctx) -> Response {
    const FAILED: &str = "Failed to start planning run";
    let settings = match super::settings::load_settings(&orm(&ctx.caller.db)).await {
        Ok(settings) => settings,
        Err(error) => return internal(&error, FAILED),
    };
    if !settings.enabled {
        return ApiError::bad_request("Replenishment is turned off for this workspace")
            .into_response();
    }
    let Some(jobs) = &ctx.jobs else {
        return ApiError::unavailable("Planning runs are not available here").into_response();
    };
    let start = RunStart {
        workspace_id: ctx.workspace_id.clone(),
        clerk_org_id: Some(ctx.caller.clerk_org_id.clone()),
        trigger: "manual",
        started_by: Some(ctx.caller.user_id.clone()),
    };
    match start_run(&ctx.caller.db, jobs.as_ref(), &state.events, &start).await {
        Ok(Started::New(row)) => (StatusCode::ACCEPTED, Data(row)).into_response(),
        Ok(Started::Running(row)) => Data(row).into_response(),
        Err(StartError::Database(error)) => internal(&error, FAILED),
        Err(error @ StartError::Jobs(_)) => internal(&error, FAILED),
    }
}

// ── Incoming ────────────────────────────────────────────────────────────────

async fn list_incoming(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let filters = IncomingQuery {
        product_ids: query_set(query, "productId").map(|id| vec![id]),
        variant: variant_filter(query),
        warehouse_id: query_set(query, "warehouseId"),
    };
    match incoming(&caller.db, &filters).await {
        Ok(items) => Data(
            items
                .iter()
                .map(crate::incoming::Incoming::to_json)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => internal(&error, "Failed to list incoming stock"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_must_be_real_iso_days() {
        assert!(is_iso_day("2026-11-18"));
        assert!(!is_iso_day("2026-02-30"));
        assert!(!is_iso_day("2026-1-18"));
        assert!(!is_iso_day("18-11-2026"));
        assert!(!is_iso_day("2026-11-18T00:00"));
    }

    #[test]
    fn the_limit_is_clamped() {
        assert_eq!(limit_param(None, 20, 100), 20);
        assert_eq!(limit_param(Some("limit=5"), 20, 100), 5);
        assert_eq!(limit_param(Some("limit=500"), 20, 100), 100);
        assert_eq!(limit_param(Some("limit=0"), 20, 100), 1);
        assert_eq!(limit_param(Some("limit=many"), 20, 100), 20);
    }

    #[test]
    fn the_settings_patch_lists_what_it_changes() {
        let patch = SettingsPatch {
            enabled: Field::Set(true),
            cutover: Field::Null,
            ..SettingsPatch::default()
        };
        assert_eq!(
            patch.changes(),
            vec!["replenishmentEnabled", "historyCutoverDate"]
        );
    }

    #[test]
    fn a_min_max_rule_needs_both_bounds_in_order() {
        let read = |body: Value| {
            let mut issues = Issues::default();
            let fields = body.as_object().cloned().unwrap_or_default();
            let rule = read_rule(&mut issues, &fields);
            (rule.is_some() && issues.is_empty(), issues.count())
        };
        let base = json!({ "productId": "p", "warehouseId": "w", "method": "min_max" });
        assert!(!read(base.clone()).0);
        let mut ok = base.clone();
        ok["minQty"] = json!(2);
        ok["maxQty"] = json!(10);
        assert!(read(ok).0);
        let mut reversed = base;
        reversed["minQty"] = json!(10);
        reversed["maxQty"] = json!(2);
        assert!(!read(reversed).0);
        assert!(read(json!({ "productId": "p", "warehouseId": "w", "method": "auto" })).0);
    }
}
