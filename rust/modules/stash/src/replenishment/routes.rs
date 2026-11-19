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
//! POST   /purchase-orders          draft purchase orders from plans          orders:create
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
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    REORDER_RULE_CREATED, REORDER_RULE_DELETED, REORDER_RULE_UPDATED,
    REPLENISHMENT_SETTINGS_UPDATED,
};
use weldsuite_catalogs::permission_keys::{INVENTORY_MANAGE, INVENTORY_READ};
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::DynJobs;

use super::demand::item_key;
use super::engine::MAX_QUANTITY;
use super::run::{RunStart, SWEEP_KIND, StartError, Started, next_run_at, start_run};
use super::settings::{SETTINGS_ID, from_json, settings_json};
use super::{imports, orders, plans};
use crate::incoming::{IncomingQuery, VariantFilter, incoming, parse_date};
use crate::js::{query_param, query_set};
use crate::{Caller, Refusal, StashState, internal, now, validate};

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

/// The statement slots of a [`VariantFilter`]: mode and variant.
pub(crate) fn variant_slots(filter: &VariantFilter) -> (&'static str, Option<&str>) {
    match filter {
        VariantFilter::Any => ("any", None),
        VariantFilter::None => ("none", None),
        VariantFilter::Only(id) => ("only", Some(id.as_str())),
    }
}

/// `?limit=` within `[1, max]`, `fallback` when missing or not a number.
pub(crate) fn limit_param(query: Option<&str>, fallback: i64, max: i64) -> i64 {
    query_param(query, "limit")
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .map_or(fallback, |limit| limit.clamp(1, max))
}

/// Whether the live row `id` of `table` exists (`products`, `warehouses`, …).
async fn exists(db: &PgPool, sql: &'static str, id: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(sql).bind(id).fetch_one(db).await
}

// ── Settings ────────────────────────────────────────────────────────────────

async fn get_settings(caller: Caller) -> Response {
    match settings_json(&caller.db).await {
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

const UPSERT_SETTINGS: &str = "insert into stash_settings as t (id, created_at, updated_at, \
     replenishment_enabled, default_service_level, default_review_period_days, lookback_days, \
     default_lead_time_days, demand_warehouse_id, history_cutover_date, run_hour_utc) \
     values ('default', $1::timestamp, $1::timestamp, coalesce($2, false), \
     coalesce($3::numeric, 0.950), coalesce($4, 7), coalesce($5, 365), coalesce($6, 14), \
     case when $7 then $8 else null end, case when $9 then $10::date else null end, \
     coalesce($11, 2)) \
     on conflict (id) do update set updated_at = excluded.updated_at, \
     replenishment_enabled = coalesce($2, t.replenishment_enabled), \
     default_service_level = coalesce($3::numeric, t.default_service_level), \
     default_review_period_days = coalesce($4, t.default_review_period_days), \
     lookback_days = coalesce($5, t.lookback_days), \
     default_lead_time_days = coalesce($6, t.default_lead_time_days), \
     demand_warehouse_id = case when $7 then $8 else t.demand_warehouse_id end, \
     history_cutover_date = case when $9 then $10::date else t.history_cutover_date end, \
     run_hour_utc = coalesce($11, t.run_hour_utc) \
     returning to_jsonb(t) || jsonb_build_object('default_service_level', \
     t.default_service_level::text)";

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
    let db = &ctx.caller.db;
    let (warehouse_given, warehouse) = nullable_slot(&patch.demand_warehouse_id);
    if let Some(id) = &warehouse
        && !exists(
            db,
            "select exists(select 1 from warehouses where id = $1 and deleted_at is null)",
            id,
        )
        .await?
    {
        return Err(Refusal::not_found("Warehouse", id));
    }
    let (cutover_given, cutover) = nullable_slot(&patch.cutover);
    let before = from_json(&settings_json(db).await?);
    let row: Value = sqlx::query_scalar(UPSERT_SETTINGS)
        .bind(now())
        .bind(patch.enabled.as_set().copied())
        .bind(patch.service_level.as_set().copied())
        .bind(patch.review_period_days.as_set().copied())
        .bind(patch.lookback_days.as_set().copied())
        .bind(patch.lead_time_days.as_set().copied())
        .bind(warehouse_given)
        .bind(warehouse)
        .bind(cutover_given)
        .bind(cutover)
        .bind(patch.run_hour_utc.as_set().copied())
        .fetch_one(db)
        .await?;
    Ok((before, weldsuite_db::js_row(row)))
}

// ── Rules ───────────────────────────────────────────────────────────────────

/// A rule as Drizzle returns it.
macro_rules! rule_row {
    () => {
        "to_jsonb(r) || jsonb_build_object('service_level', r.service_level::text)"
    };
}
pub(crate) use rule_row;

const LIST_RULES: &str = concat!(
    "select ",
    rule_row!(),
    " from stash_reorder_rules r where ($1::text is null or r.product_id = $1) \
     and ($2::text = 'any' or ($2::text = 'none' and coalesce(r.variant_id, '') = '') \
          or ($2::text = 'only' and r.variant_id = $3)) \
     and ($4::text is null or r.warehouse_id = $4) \
     order by r.created_at, r.id"
);

async fn list_rules(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let product = query_set(query, "productId");
    let warehouse = query_set(query, "warehouseId");
    let variant = variant_filter(query);
    let (mode, variant) = variant_slots(&variant);
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(LIST_RULES)
        .bind(product.as_deref())
        .bind(mode)
        .bind(variant)
        .bind(warehouse.as_deref())
        .fetch_all(&caller.db)
        .await;
    match rows {
        Ok(rows) => {
            let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
            List::new(
                rows.into_iter().map(weldsuite_db::js_row).collect(),
                Pagination::new(total, false, None),
            )
            .into_response()
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

const UPSERT_RULE: &str = concat!(
    "insert into stash_reorder_rules as r (id, created_at, updated_at, item_key, product_id, \
     variant_id, warehouse_id, method, min_qty, max_qty, service_level, review_period_days, \
     lead_time_days_override, product_supplier_id) values ($1, $2::timestamp, $2::timestamp, \
     $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12, $13) \
     on conflict (item_key) do update set updated_at = excluded.updated_at, \
     method = excluded.method, min_qty = excluded.min_qty, max_qty = excluded.max_qty, \
     service_level = excluded.service_level, review_period_days = excluded.review_period_days, \
     lead_time_days_override = excluded.lead_time_days_override, \
     product_supplier_id = excluded.product_supplier_id \
     returning ",
    rule_row!(),
    ", (xmax = 0)"
);

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
    let db = &caller.db;
    if !exists(
        db,
        "select exists(select 1 from products where id = $1 and deleted_at is null)",
        &rule.product_id,
    )
    .await?
    {
        return Err(Refusal::not_found("Product", &rule.product_id));
    }
    if let Some(variant) = &rule.variant_id {
        let found: bool = sqlx::query_scalar(
            "select exists(select 1 from product_variants where id = $1 and product_id = $2 \
             and deleted_at is null)",
        )
        .bind(variant)
        .bind(&rule.product_id)
        .fetch_one(db)
        .await?;
        if !found {
            return Err(Refusal::not_found("Product variant", variant));
        }
    }
    if !exists(
        db,
        "select exists(select 1 from warehouses where id = $1 and deleted_at is null)",
        &rule.warehouse_id,
    )
    .await?
    {
        return Err(Refusal::not_found("Warehouse", &rule.warehouse_id));
    }
    if let Some(link) = &rule.product_supplier_id {
        let found: bool = sqlx::query_scalar(
            "select exists(select 1 from product_suppliers where id = $1 and product_id = $2 \
             and (coalesce(variant_id, '') = '' or variant_id = $3) and deleted_at is null)",
        )
        .bind(link)
        .bind(&rule.product_id)
        .bind(rule.variant_id.as_deref())
        .fetch_one(db)
        .await?;
        if !found {
            return Err(Refusal::not_found("Product supplier", link));
        }
    }
    let at = now();
    let (row, inserted): (Value, bool) = sqlx::query_as(UPSERT_RULE)
        .bind(generate_id("rrule"))
        .bind(&at)
        .bind(item_key(
            &rule.product_id,
            rule.variant_id.as_deref(),
            &rule.warehouse_id,
        ))
        .bind(&rule.product_id)
        .bind(rule.variant_id.as_deref())
        .bind(&rule.warehouse_id)
        .bind(&rule.method)
        .bind(rule.min_qty)
        .bind(rule.max_qty)
        .bind(rule.service_level)
        .bind(rule.review_period_days)
        .bind(rule.lead_time_days_override)
        .bind(rule.product_supplier_id.as_deref())
        .fetch_one(db)
        .await?;
    Ok((weldsuite_db::js_row(row), inserted))
}

async fn delete_rule(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete reorder rule";
    let row: Result<Option<Value>, _> = sqlx::query_scalar(concat!(
        "delete from stash_reorder_rules r where r.id = $1 returning ",
        rule_row!()
    ))
    .bind(&id)
    .fetch_optional(&caller.db)
    .await;
    match row {
        Ok(Some(row)) => {
            let row = weldsuite_db::js_row(row);
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
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from stash_planning_runs t order by t.started_at desc, t.id desc \
         limit $1",
    )
    .bind(limit)
    .fetch_all(&caller.db)
    .await;
    let total: Result<i64, _> = sqlx::query_scalar("select count(*) from stash_planning_runs")
        .fetch_one(&caller.db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => {
            let total = u64::try_from(total).unwrap_or(0);
            let has_more = total > u64::try_from(rows.len()).unwrap_or(u64::MAX);
            List::new(
                rows.into_iter().map(weldsuite_db::js_row).collect(),
                Pagination::new(total, has_more, None),
            )
            .into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn start(State(state): State<StashState>, ctx: Ctx) -> Response {
    const FAILED: &str = "Failed to start planning run";
    let settings = match super::settings::load_settings(&ctx.caller.db).await {
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
