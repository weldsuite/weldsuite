//! The Odoo syncs: `odoo-warehouses`, `odoo-products`, `odoo-suppliers`,
//! `odoo-product-suppliers`, `odoo-stock`, `odoo-purchase-orders` and
//! `odoo-sales`, run by [`crate::sync::sync_connection`] for an `odoo`
//! connection, with the same run bookkeeping as the other connectors
//! (`connector_sync_runs`, watermarks in `connector_connections.sync_watermarks`,
//! an authentication failure ending the whole sync as `auth_error`).
//!
//! Paging. Each sync reads `search_read` pages of [`PAGE_SIZE`] with a
//! `write_date > <watermark>` domain. Odoo returns `write_date` in whole
//! seconds but stores microseconds, and a bulk import stamps thousands of
//! rows with one transaction time, so pages are keyed on `id` (`id > last`,
//! `order id asc`) under a domain fixed for the whole scan, not on the
//! timestamp; the watermark moves only when a scan completes
//! ([`next_watermark`]), and not past a record that failed anywhere in the
//! scan. A scan reads at most [`MAX_PAGES`] pages per run and resumes where
//! it stopped (`<model>__cursor`, `__since`, `__t0`, `__max`, and
//! `__failed` once a record failed). Stock is a full refresh on every run,
//! never cut short.
//!
//! A sync that follows a related record's changes too (a template's for
//! its variants, an order's for its lines) ORs both `write_date`s into the
//! domain: an order cancelled in Odoo 19 does not touch its lines'
//! `write_date` (their `state` is no longer stored there).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, PoisonError};

use serde_json::{Value, json};
use time::{Date, OffsetDateTime};
use weldsuite_db::PgPool;
use weldsuite_events::EntityEventPublisher;
use weldsuite_ports::OutboundHttp;

use super::client::Odoo;
use super::ingest::{self, Action, BucketKey, Item};
use super::mappers::{
    Expr, Uoms, add_quant, all_of, any_of, changed_since, domain, format_date, later, m2o_id,
    m2o_name, map_po_line, map_product, map_sale_line, map_supplier, map_supplierinfo,
    map_warehouse, next_watermark, odoo_date, odoo_ids, odoo_instant, odoo_number, odoo_text,
    parse_odoo_datetime, po_status, record_id, round_quantity, storable_domain, term,
};
use crate::clients::{ConnectorError, Kind};
use crate::ingest::{IngestResult, record_checksum, sanitise_error_message};
use crate::sync::{
    RunEnd, SyncArgs, SyncError, finish_sync_run, mark_connection_error, start_sync_run,
};

/// Records per `search_read`.
pub(crate) const PAGE_SIZE: u32 = 500;
/// Pages per sync and run (stock excepted).
pub(crate) const MAX_PAGES: u32 = 40;
/// How far back sales (and closed purchase orders) are read on the first
/// sync, unless the connection's `importStartDate` says otherwise.
pub(crate) const BACKFILL_DAYS: i64 = 730;

fn no_active_test() -> Value {
    json!({ "active_test": false })
}
/// Purchase order states still expecting goods or a decision.
const OPEN_PO_STATES: [&str; 4] = ["draft", "sent", "to approve", "purchase"];

/// What every sync reads.
pub(crate) struct Ctx<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) http: Option<&'a OutboundHttp>,
    pub(crate) events: &'a EntityEventPublisher,
    pub(crate) client: &'a Odoo,
    pub(crate) connection_id: &'a str,
    pub(crate) owner_id: &'a str,
    /// What events are stamped with (the Clerk org id).
    pub(crate) workspace_id: &'a str,
    /// The first day of sales (and closed purchase orders) to import.
    pub(crate) start_date: Date,
    pub(crate) today: Date,
    /// Records per page and pages per run ([`PAGE_SIZE`], [`MAX_PAGES`]).
    page_size: u32,
    max_pages: u32,
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    uoms: Option<Uoms>,
    product_uom: HashMap<i64, Option<i64>>,
    template_uom: HashMap<i64, Option<i64>>,
}

impl Ctx<'_> {
    fn cache(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every unit of measure, read once per run.
    async fn uoms(&self) -> Result<Uoms, ConnectorError> {
        if let Some(uoms) = self.cache().uoms.clone() {
            return Ok(uoms);
        }
        let available = self.client.fields(self.http, "uom.uom").await?;
        let (rows, _) = self
            .client
            .search_read(
                self.http,
                "uom.uom",
                json!([]),
                &["factor".to_owned()],
                None,
                None,
                Some(no_active_test()),
            )
            .await?;
        let uoms = Uoms {
            factors: rows
                .iter()
                .filter_map(|r| Some((record_id(r)?, odoo_number(&r["factor"])?)))
                .collect(),
            absolute: available.contains("relative_factor"),
        };
        self.cache().uoms = Some(uoms.clone());
        Ok(uoms)
    }

    /// The base unit (`uom_id`) of products or templates, read once each.
    async fn base_uoms(
        &self,
        model: &'static str,
        ids: &[i64],
    ) -> Result<HashMap<i64, Option<i64>>, ConnectorError> {
        let template = model == "product.template";
        let missing: Vec<i64> = {
            let cache = self.cache();
            let known = if template {
                &cache.template_uom
            } else {
                &cache.product_uom
            };
            let mut missing: Vec<i64> = ids
                .iter()
                .copied()
                .filter(|id| !known.contains_key(id))
                .collect();
            missing.sort_unstable();
            missing.dedup();
            missing
        };
        if !missing.is_empty() {
            let rows = self
                .client
                .read(
                    self.http,
                    model,
                    &missing,
                    &["uom_id".to_owned()],
                    Some(no_active_test()),
                )
                .await?;
            let mut cache = self.cache();
            let known = if template {
                &mut cache.template_uom
            } else {
                &mut cache.product_uom
            };
            for id in &missing {
                known.insert(*id, None);
            }
            for row in rows {
                if let Some(id) = record_id(&row) {
                    known.insert(id, m2o_id(&row["uom_id"]));
                }
            }
        }
        let cache = self.cache();
        let known = if template {
            &cache.template_uom
        } else {
            &cache.product_uom
        };
        Ok(ids
            .iter()
            .map(|id| (*id, known.get(id).copied().flatten()))
            .collect())
    }
}

/// `importStartDate` (`YYYY-MM-DD`) from the connection's settings.
fn import_start(connection: &Value) -> Option<Date> {
    connection
        .get("settings")
        .and_then(|s| s.get("importStartDate"))
        .and_then(Value::as_str)
        .and_then(parse_odoo_datetime)
        .map(time::PrimitiveDateTime::date)
}

// ── scan state ───────────────────────────────────────────────────────────────

/// Where a sync's scan stands.
struct Window {
    model: String,
    /// The `write_date >` bound of this scan (none: everything).
    since: Option<String>,
    /// The last id read.
    cursor: i64,
    /// The server's clock when the scan started (Odoo datetime text).
    started: Option<String>,
    /// The newest change seen.
    max_seen: Option<String>,
    continuing: bool,
    /// A record failed in an earlier run of this scan (`__failed`), which
    /// the page ceiling cut short: the scan's watermark must not pass it.
    failed_before: bool,
}

impl Window {
    fn open(connection: &Value, model: &str, full: bool) -> Self {
        let marks = connection.get("sync_watermarks");
        let mark = |key: &str| {
            marks
                .and_then(|m| m.get(key))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let cursor = if full {
            None
        } else {
            mark(&format!("{model}__cursor")).and_then(|c| c.parse::<i64>().ok())
        };
        match cursor {
            Some(cursor) => Self {
                model: model.to_owned(),
                since: mark(&format!("{model}__since")),
                cursor,
                started: mark(&format!("{model}__t0")),
                max_seen: mark(&format!("{model}__max")),
                continuing: true,
                failed_before: mark(&format!("{model}__failed")).is_some(),
            },
            None => Self {
                model: model.to_owned(),
                since: if full { None } else { mark(model) },
                cursor: 0,
                started: None,
                max_seen: None,
                continuing: false,
                failed_before: false,
            },
        }
    }

    fn key(&self, suffix: &str) -> String {
        format!("{}__{suffix}", self.model)
    }

    fn sync_type(&self, full: bool) -> &'static str {
        if full {
            "FULL"
        } else if self.continuing || self.since.is_none() {
            "INITIAL"
        } else {
            "INCREMENTAL"
        }
    }

    fn see(&mut self, stamp: &Value) {
        if let Some(stamp) = stamp.as_str() {
            self.max_seen = later(self.max_seen.take(), Some(stamp));
        }
    }

    fn start(&mut self, at: Option<OffsetDateTime>) {
        if self.started.is_none() {
            self.started = at.map(odoo_instant);
        }
    }

    fn continuation_keys(&self) -> Vec<(String, Option<String>)> {
        ["cursor", "since", "t0", "max", "failed"]
            .iter()
            .map(|suffix| (self.key(suffix), None))
            .collect()
    }

    /// A completed scan: the continuation goes, the watermark moves (unless
    /// a record failed, in this run or an earlier one of the scan, so the
    /// next scan reads it again).
    fn done_patch(&self, failed: bool) -> Vec<(String, Option<String>)> {
        let mut patch = self.continuation_keys();
        if !failed
            && !self.failed_before
            && let Some(mark) = next_watermark(
                self.since.as_deref(),
                self.max_seen.as_deref(),
                self.started.as_deref(),
            )
        {
            patch.push((self.model.clone(), Some(mark)));
        }
        patch
    }

    /// A scan cut short: where the next run resumes, and whether a record
    /// failed so far (the cursor moves past it).
    fn truncated_patch(&self, failed: bool) -> Vec<(String, Option<String>)> {
        vec![
            (self.key("cursor"), Some(self.cursor.to_string())),
            (self.key("since"), self.since.clone()),
            (self.key("t0"), self.started.clone()),
            (self.key("max"), self.max_seen.clone()),
            (
                self.key("failed"),
                (failed || self.failed_before).then(|| "true".to_owned()),
            ),
        ]
    }
}

/// `search_read` pages keyed on `id` under a fixed domain.
struct Pager<'c, 'a> {
    ctx: &'c Ctx<'a>,
    model: &'static str,
    base: Expr,
    fields: Vec<String>,
    context: Option<Value>,
    cursor: i64,
    pages: u32,
    max_pages: Option<u32>,
    done: bool,
    truncated: bool,
    first_answer: Option<OffsetDateTime>,
}

impl<'c, 'a> Pager<'c, 'a> {
    fn new(
        ctx: &'c Ctx<'a>,
        model: &'static str,
        base: Expr,
        fields: Vec<String>,
        context: Option<Value>,
        cursor: i64,
        max_pages: Option<u32>,
    ) -> Self {
        Self {
            ctx,
            model,
            base,
            fields,
            context,
            cursor,
            pages: 0,
            max_pages,
            done: false,
            truncated: false,
            first_answer: None,
        }
    }

    async fn next(&mut self) -> Result<Option<Vec<Value>>, ConnectorError> {
        if self.done {
            return Ok(None);
        }
        if self.max_pages.is_some_and(|max| self.pages >= max) {
            self.truncated = true;
            return Ok(None);
        }
        let filter = domain(all_of(vec![
            self.base.clone(),
            term("id", ">", json!(self.cursor)),
        ]));
        let (records, at) = self
            .ctx
            .client
            .search_read(
                self.ctx.http,
                self.model,
                filter,
                &self.fields,
                Some(self.ctx.page_size),
                Some("id asc"),
                self.context.clone(),
            )
            .await?;
        self.pages += 1;
        if self.first_answer.is_none() {
            self.first_answer = at;
        }
        if let Some(last) = records.last().and_then(record_id) {
            self.cursor = last;
        }
        if records.len() < self.ctx.page_size as usize {
            self.done = true;
        }
        Ok((!records.is_empty()).then_some(records))
    }
}

fn tally(applied: &mut IngestResult, action: Action) {
    match action {
        Action::Created => applied.created += 1,
        Action::Updated => applied.modified += 1,
        Action::Skipped => applied.skipped += 1,
        Action::Deleted => applied.deleted += 1,
    }
}

fn fail(applied: &mut IngestResult, odoo_id: i64, error: &sqlx::Error) {
    let raw = match error {
        sqlx::Error::Database(db) => db.message().to_owned(),
        other => other.to_string(),
    };
    let message = sanitise_error_message(&raw);
    tracing::error!("[connectors/odoo] record {odoo_id} failed: {message}");
    applied.failed += 1;
    if applied.error_samples.len() < 5 {
        applied.error_samples.push((odoo_id.to_string(), message));
    }
}

/// A record that names a storable product the product sync has not mapped
/// yet (one created in Odoo while this pass ran): it counts as failed, so
/// the scan's watermark stays before it and the next pass reads it again,
/// once the product sync has caught up.
fn wait_for_product(applied: &mut IngestResult, odoo_id: i64, product: i64) {
    tracing::warn!("[connectors/odoo] record {odoo_id} waits for product {product}");
    applied.failed += 1;
    if applied.error_samples.len() < 5 {
        applied.error_samples.push((
            odoo_id.to_string(),
            format!("Odoo product {product} is not synced yet; read again on the next pass"),
        ));
    }
}

/// Of the Odoo products `ids` without a WeldStash item, the storable ones
/// (archived included). A completed product sync gives every storable
/// product an item, so these are not synced *yet*; the rest keep no stock
/// and are skipped (a purchase line keeps them, without a product).
async fn missing_products(
    ctx: &Ctx<'_>,
    items: &HashMap<i64, Item>,
    ids: impl IntoIterator<Item = i64>,
) -> Result<HashSet<i64>, ConnectorError> {
    let mut unknown: Vec<i64> = ids
        .into_iter()
        .filter(|id| !items.contains_key(id))
        .collect();
    unknown.sort_unstable();
    unknown.dedup();
    if unknown.is_empty() {
        return Ok(HashSet::new());
    }
    let storable = ctx
        .client
        .fields(ctx.http, "product.product")
        .await?
        .contains("is_storable");
    let found = ctx
        .client
        .search(
            ctx.http,
            "product.product",
            domain(all_of(vec![
                term("id", "in", json!(unknown)),
                storable_domain(storable, ""),
            ])),
            None,
            None,
            Some(no_active_test()),
        )
        .await?;
    Ok(found.into_iter().collect())
}

/// [`missing_products`] for vendor lines that name only a template: the
/// unmapped templates with a storable variant, each with one such variant.
async fn missing_templates(
    ctx: &Ctx<'_>,
    templates: &HashMap<i64, (String, String)>,
    ids: impl IntoIterator<Item = i64>,
) -> Result<HashMap<i64, i64>, ConnectorError> {
    let mut unknown: Vec<i64> = ids
        .into_iter()
        .filter(|id| !templates.contains_key(id))
        .collect();
    unknown.sort_unstable();
    unknown.dedup();
    if unknown.is_empty() {
        return Ok(HashMap::new());
    }
    let storable = ctx
        .client
        .fields(ctx.http, "product.product")
        .await?
        .contains("is_storable");
    let (rows, _) = ctx
        .client
        .search_read(
            ctx.http,
            "product.product",
            domain(all_of(vec![
                term("product_tmpl_id", "in", json!(unknown)),
                storable_domain(storable, ""),
            ])),
            &["product_tmpl_id".to_owned()],
            None,
            None,
            Some(no_active_test()),
        )
        .await?;
    Ok(rows
        .iter()
        .filter_map(|r| Some((m2o_id(&r["product_tmpl_id"])?, record_id(r)?)))
        .collect())
}

/// An authentication failure stops the whole sync; other connector errors
/// end only the sync they happened in.
fn is_auth(error: &SyncError) -> bool {
    matches!(error, SyncError::Connector(e) if e.kind == Kind::Auth)
}

// ── the runner ───────────────────────────────────────────────────────────────

/// Runs the requested Odoo syncs, in catalog order.
pub(crate) async fn run(
    args: &SyncArgs<'_>,
    to_run: &[Value],
    client: &Odoo,
) -> Result<(), SyncError> {
    let today = OffsetDateTime::now_utc().date();
    let ctx = Ctx {
        db: args.db,
        http: args.env.http.as_ref(),
        events: &args.env.events,
        client,
        connection_id: args.connection["id"].as_str().unwrap_or_default(),
        owner_id: args.owner_id,
        workspace_id: args.workspace_id,
        start_date: import_start(args.connection)
            .unwrap_or(today - time::Duration::days(BACKFILL_DAYS)),
        today,
        page_size: limits().0,
        max_pages: limits().1,
        cache: Mutex::new(Cache::default()),
    };
    // Syncs whose scan is still going (a resume cursor from an earlier run).
    let marks = args.connection.get("sync_watermarks");
    let mut unfinished: HashSet<String> = crate::catalog::get_connector("odoo")
        .map(crate::catalog::syncs)
        .unwrap_or_default()
        .iter()
        .filter(|sync| {
            let model = sync["model"].as_str().unwrap_or_default();
            marks
                .and_then(|m| m.get(format!("{model}__cursor")))
                .and_then(Value::as_str)
                .is_some_and(|c| !c.is_empty())
        })
        .filter_map(|sync| sync["syncName"].as_str().map(str::to_owned))
        .collect();
    for sync in to_run {
        let name = sync["syncName"].as_str().unwrap_or_default();
        let waiting = prerequisites(name)
            .iter()
            .find(|p| unfinished.contains(**p))
            .copied();
        let complete = match waiting {
            Some(waiting) => {
                wait_for(&ctx, args, sync, waiting).await?;
                false
            }
            None => run_one(&ctx, args, sync).await?,
        };
        if complete {
            unfinished.remove(name);
        } else {
            unfinished.insert(name.to_owned());
        }
    }
    Ok(())
}

/// The syncs whose mappings a sync reads. It waits while one of them is
/// still scanning (cut short by the page ceiling, or failed in this pass):
/// otherwise a first sync of a large catalogue would skip every line whose
/// product is not mapped yet and move its cursor past them for good.
/// Vendors are not waited for: a purchase or vendor line brings its vendor
/// in on demand.
fn prerequisites(name: &str) -> &'static [&'static str] {
    match name {
        "odoo-product-suppliers" => &["odoo-products"],
        "odoo-stock" | "odoo-purchase-orders" | "odoo-sales" => {
            &["odoo-warehouses", "odoo-products"]
        }
        _ => &[],
    }
}

/// A run that only waits for `waiting`: its watermarks stay, and the next
/// pass (the catch-up, or Sync now) runs it.
async fn wait_for(
    ctx: &Ctx<'_>,
    args: &SyncArgs<'_>,
    sync: &Value,
    waiting: &str,
) -> Result<(), SyncError> {
    let model = sync["model"].as_str().unwrap_or_default();
    let window = Window::open(args.connection, model, args.full);
    let run_id = start_sync_run(
        ctx.db,
        ctx.connection_id,
        sync["syncName"].as_str().unwrap_or_default(),
        model,
        args.trigger.as_str(),
        window.sync_type(args.full),
    )
    .await?;
    finish_sync_run(
        ctx.db,
        &run_id,
        ctx.connection_id,
        &RunEnd {
            status: "partial",
            applied: &IngestResult::default(),
            error: Some(format!(
                "Waiting for {waiting} to finish; this sync runs on the next pass"
            )),
            watermarks: Vec::new(),
        },
    )
    .await?;
    Ok(())
}

#[cfg(test)]
thread_local! {
    /// Smaller pages for tests: `(page size, max pages)`.
    pub(crate) static TEST_LIMITS: std::cell::Cell<Option<(u32, u32)>> =
        const { std::cell::Cell::new(None) };
}

/// Records per page and pages per run.
fn limits() -> (u32, u32) {
    #[cfg(test)]
    if let Some(limits) = TEST_LIMITS.with(std::cell::Cell::get) {
        return limits;
    }
    (PAGE_SIZE, MAX_PAGES)
}

/// One sync; whether its scan completed (not cut short, not failed).
async fn run_one(ctx: &Ctx<'_>, args: &SyncArgs<'_>, sync: &Value) -> Result<bool, SyncError> {
    let model = sync["model"].as_str().unwrap_or_default();
    let name = sync["syncName"].as_str().unwrap_or_default();
    let mut window = Window::open(args.connection, model, args.full);
    let run_id = start_sync_run(
        ctx.db,
        ctx.connection_id,
        name,
        model,
        args.trigger.as_str(),
        window.sync_type(args.full),
    )
    .await?;
    let mut applied = IngestResult::default();
    let outcome = match name {
        "odoo-warehouses" => sync_warehouses(ctx, &mut window, &mut applied).await,
        "odoo-products" => sync_products(ctx, &mut window, &mut applied).await,
        "odoo-suppliers" => sync_suppliers(ctx, &mut window, &mut applied).await,
        "odoo-product-suppliers" => sync_product_suppliers(ctx, &mut window, &mut applied).await,
        "odoo-stock" => sync_stock(ctx, &mut window, &mut applied).await,
        "odoo-purchase-orders" => sync_purchase_orders(ctx, &mut window, &mut applied).await,
        "odoo-sales" => sync_sales(ctx, &mut window, &mut applied).await,
        _ => Ok(false),
    };
    match outcome {
        Ok(truncated) => {
            let failed = applied.failed > 0;
            let watermarks = if truncated {
                window.truncated_patch(failed)
            } else {
                window.done_patch(failed)
            };
            let error = if failed {
                Some(format!("{} record(s) failed to import", applied.failed))
            } else if truncated {
                Some("Page ceiling reached — run again to continue".to_owned())
            } else {
                None
            };
            finish_sync_run(
                ctx.db,
                &run_id,
                ctx.connection_id,
                &RunEnd {
                    status: if failed || truncated {
                        "partial"
                    } else {
                        "success"
                    },
                    applied: &applied,
                    error,
                    watermarks,
                },
            )
            .await?;
            Ok(!truncated)
        }
        Err(error) => {
            let auth = is_auth(&error);
            let message = error.to_string();
            if auth {
                mark_connection_error(ctx.db, ctx.connection_id, "auth_error", &message).await?;
            }
            finish_sync_run(
                ctx.db,
                &run_id,
                ctx.connection_id,
                &RunEnd {
                    status: "error",
                    applied: &applied,
                    error: Some(message),
                    watermarks: Vec::new(),
                },
            )
            .await?;
            if auth { Err(error) } else { Ok(false) }
        }
    }
}

// ── warehouses ───────────────────────────────────────────────────────────────

async fn sync_warehouses(
    ctx: &Ctx<'_>,
    window: &mut Window,
    applied: &mut IngestResult,
) -> Result<bool, SyncError> {
    const MODEL: &str = "stock.warehouse";
    let fields = ctx
        .client
        .pick_fields(
            ctx.http,
            MODEL,
            &[
                "name",
                "code",
                "active",
                "lot_stock_id",
                "in_type_id",
                "write_date",
            ],
        )
        .await?;
    let mut pager = Pager::new(
        ctx,
        MODEL,
        changed_since(&["write_date"], window.since.as_deref()),
        fields,
        Some(no_active_test()),
        window.cursor,
        Some(ctx.max_pages),
    );
    while let Some(page) = pager.next().await? {
        for record in &page {
            window.see(&record["write_date"]);
            let Some(values) = map_warehouse(record) else {
                applied.skipped += 1;
                continue;
            };
            match ingest::upsert_warehouse(ctx, &values, &record_checksum(record)).await {
                Ok((action, id)) => {
                    tally(applied, action);
                    ingest::publish(ctx, "warehouse", action, &id).await;
                }
                Err(error) => fail(applied, values.odoo_id, &error),
            }
        }
    }
    window.start(pager.first_answer);
    window.cursor = pager.cursor;
    Ok(pager.truncated)
}

// ── products ─────────────────────────────────────────────────────────────────

const PRODUCT_FIELDS: [&str; 14] = [
    "name",
    "display_name",
    "default_code",
    "barcode",
    "product_tmpl_id",
    "product_variant_count",
    "standard_price",
    "lst_price",
    "list_price",
    "weight",
    "active",
    "uom_id",
    "product_template_attribute_value_ids",
    "write_date",
];

/// Storable products only (`is_storable` from 18, `type = 'product'`
/// before), archived ones included (as `archived`): sales, purchase and
/// vendor lines name discontinued products too, and every storable product
/// having an item is what lets those syncs tell "not synced yet" from "keeps
/// no stock" ([`missing_products`]).
async fn sync_products(
    ctx: &Ctx<'_>,
    window: &mut Window,
    applied: &mut IngestResult,
) -> Result<bool, SyncError> {
    const MODEL: &str = "product.product";
    let available = ctx.client.fields(ctx.http, MODEL).await?;
    let fields: Vec<String> = PRODUCT_FIELDS
        .iter()
        .filter(|f| available.contains(**f))
        .map(|f| (*f).to_owned())
        .collect();
    let change = changed_since(
        &["write_date", "product_tmpl_id.write_date"],
        window.since.as_deref(),
    );
    let mut pager = Pager::new(
        ctx,
        MODEL,
        all_of(vec![
            storable_domain(available.contains("is_storable"), ""),
            change,
        ]),
        fields,
        Some(no_active_test()),
        window.cursor,
        Some(ctx.max_pages),
    );
    while let Some(page) = pager.next().await? {
        let mut value_ids: Vec<i64> = page
            .iter()
            .flat_map(|r| odoo_ids(&r["product_template_attribute_value_ids"]))
            .collect();
        value_ids.sort_unstable();
        value_ids.dedup();
        let names = attribute_names(ctx, &value_ids).await?;
        let mut templates: Vec<i64> = page
            .iter()
            .filter_map(|r| m2o_id(&r["product_tmpl_id"]))
            .collect();
        templates.sort_unstable();
        templates.dedup();
        // The templates' own `write_date`: the domain follows them, so the
        // watermark must too.
        let template_rows = ctx
            .client
            .read(
                ctx.http,
                "product.template",
                &templates,
                &["write_date".to_owned()],
                Some(no_active_test()),
            )
            .await?;
        for row in &template_rows {
            window.see(&row["write_date"]);
        }
        for record in &page {
            window.see(&record["write_date"]);
            let Some(values) = map_product(record, &names) else {
                applied.skipped += 1;
                continue;
            };
            ctx.cache()
                .product_uom
                .insert(values.odoo_id, values.uom_id);
            match ingest::upsert_product(ctx, &values, &record_checksum(record)).await {
                Ok((action, id)) => {
                    tally(applied, action);
                    ingest::publish(ctx, "product", action, &id).await;
                }
                Err(error) => fail(applied, values.odoo_id, &error),
            }
        }
    }
    window.start(pager.first_answer);
    window.cursor = pager.cursor;
    Ok(pager.truncated)
}

/// `product.template.attribute.value` names; without them a variant is
/// named from its `display_name`.
async fn attribute_names(
    ctx: &Ctx<'_>,
    ids: &[i64],
) -> Result<HashMap<i64, String>, ConnectorError> {
    match ctx
        .client
        .read(
            ctx.http,
            "product.template.attribute.value",
            ids,
            &["name".to_owned()],
            Some(no_active_test()),
        )
        .await
    {
        Ok(rows) => Ok(rows
            .iter()
            .filter_map(|r| Some((record_id(r)?, odoo_text(&r["name"])?)))
            .collect()),
        Err(error) if error.kind == Kind::Auth => Err(error),
        Err(error) => {
            tracing::warn!(error = %error.message, "[connectors/odoo] attribute names unavailable");
            Ok(HashMap::new())
        }
    }
}

// ── suppliers ────────────────────────────────────────────────────────────────

const SUPPLIER_FIELDS: [&str; 19] = [
    "name",
    "display_name",
    "ref",
    "email",
    "phone",
    "mobile",
    "website",
    "street",
    "street2",
    "city",
    "state_id",
    "zip",
    "country_id",
    "country_code",
    "vat",
    "active",
    "property_supplier_payment_term_id",
    "property_purchase_currency_id",
    "write_date",
];

/// Vendors: partners with `supplier_rank > 0` (the field comes with
/// Invoicing/Purchase; without it there is nothing to sync).
async fn sync_suppliers(
    ctx: &Ctx<'_>,
    window: &mut Window,
    applied: &mut IngestResult,
) -> Result<bool, SyncError> {
    const MODEL: &str = "res.partner";
    let available = ctx.client.fields(ctx.http, MODEL).await?;
    if !available.contains("supplier_rank") {
        return Ok(false);
    }
    let fields = ctx
        .client
        .pick_fields(ctx.http, MODEL, &SUPPLIER_FIELDS)
        .await?;
    let change = match window.since.as_deref() {
        None => term("active", "=", json!(true)),
        since => changed_since(&["write_date"], since),
    };
    let mut pager = Pager::new(
        ctx,
        MODEL,
        all_of(vec![term("supplier_rank", ">", json!(0)), change]),
        fields,
        Some(no_active_test()),
        window.cursor,
        Some(ctx.max_pages),
    );
    while let Some(page) = pager.next().await? {
        for record in &page {
            window.see(&record["write_date"]);
            let Some(values) = map_supplier(record) else {
                applied.skipped += 1;
                continue;
            };
            match ingest::upsert_supplier(ctx, &values, &record_checksum(record)).await {
                Ok((action, id)) => {
                    tally(applied, action);
                    ingest::publish(ctx, "supplier", action, &id).await;
                }
                Err(error) => fail(applied, values.odoo_id, &error),
            }
        }
    }
    window.start(pager.first_answer);
    window.cursor = pager.cursor;
    Ok(pager.truncated)
}

/// A vendor's supplier, synced on demand when a vendor line names a partner
/// the vendor sync has not seen (its `supplier_rank` only rises once a
/// purchase is confirmed).
async fn ensure_supplier(ctx: &Ctx<'_>, partner_id: i64) -> Result<Option<String>, SyncError> {
    if let Some(m) =
        ingest::find_mapping(ctx.db, ctx.connection_id, ingest::SUPPLIER, partner_id).await?
    {
        return Ok(Some(m.internal_id));
    }
    let fields = ctx
        .client
        .pick_fields(ctx.http, "res.partner", &SUPPLIER_FIELDS)
        .await?;
    let rows = ctx
        .client
        .read(
            ctx.http,
            "res.partner",
            &[partner_id],
            &fields,
            Some(no_active_test()),
        )
        .await?;
    let Some(values) = rows.first().and_then(map_supplier) else {
        return Ok(None);
    };
    let (action, id) = ingest::upsert_supplier(ctx, &values, &record_checksum(&rows[0])).await?;
    ingest::publish(ctx, "supplier", action, &id).await;
    Ok(Some(id))
}

// ── product suppliers ────────────────────────────────────────────────────────

/// Vendor lines (`product.supplierinfo`). Prices and minimum quantities are
/// per the vendor's unit; they are converted to the product's unit. An
/// expired line (`date_end` in the past) and a line deleted in Odoo (found
/// by comparing ids after a completed scan) release their row. A mapped
/// line that expired since it was read is found after a completed scan too:
/// time passing changes no `write_date`, so the scan does not read it.
async fn sync_product_suppliers(
    ctx: &Ctx<'_>,
    window: &mut Window,
    applied: &mut IngestResult,
) -> Result<bool, SyncError> {
    const MODEL: &str = "product.supplierinfo";
    let fields = ctx
        .client
        .pick_fields(
            ctx.http,
            MODEL,
            &[
                "partner_id",
                "product_tmpl_id",
                "product_id",
                "product_code",
                "product_name",
                "price",
                "currency_id",
                "min_qty",
                "delay",
                "sequence",
                "date_end",
                "product_uom",
                "product_uom_id",
                "write_date",
            ],
        )
        .await?;
    let has_end_date = fields.iter().any(|f| f == "date_end");
    let items = ingest::product_items(ctx.db, ctx.connection_id).await?;
    let templates = ingest::mappings_of(ctx.db, ctx.connection_id, ingest::TEMPLATE).await?;
    let uoms = ctx.uoms().await?;
    let mut pager = Pager::new(
        ctx,
        MODEL,
        changed_since(&["write_date"], window.since.as_deref()),
        fields,
        None,
        window.cursor,
        Some(ctx.max_pages),
    );
    while let Some(page) = pager.next().await? {
        let template_ids: Vec<i64> = page
            .iter()
            .filter_map(|r| m2o_id(&r["product_tmpl_id"]))
            .collect();
        let base_units = ctx.base_uoms("product.template", &template_ids).await?;
        let variant_ids = page.iter().filter_map(|r| m2o_id(&r["product_id"]));
        let missing = missing_products(ctx, &items, variant_ids).await?;
        let template_only = page
            .iter()
            .filter(|r| m2o_id(&r["product_id"]).is_none())
            .filter_map(|r| m2o_id(&r["product_tmpl_id"]));
        let missing_template = missing_templates(ctx, &templates, template_only).await?;
        for record in &page {
            window.see(&record["write_date"]);
            let Some(info) = map_supplierinfo(record, ctx.today) else {
                applied.skipped += 1;
                continue;
            };
            if info.expired {
                match ingest::remove_supplierinfo(ctx, info.odoo_id).await {
                    Ok(Some(row)) => {
                        tally(applied, Action::Deleted);
                        ingest::publish(ctx, "product_supplier", Action::Deleted, &row).await;
                    }
                    Ok(None) => tally(applied, Action::Skipped),
                    Err(error) => fail(applied, info.odoo_id, &error),
                }
                continue;
            }
            let item: Option<Item> = match info.variant.and_then(|v| items.get(&v)) {
                Some(item) => Some(item.clone()),
                None if info.variant.is_none() => info
                    .template
                    .and_then(|t| templates.get(&t))
                    .map(|(_, product)| (product.clone(), None)),
                None => None,
            };
            let Some((product_id, variant_id)) = item else {
                let waiting = match info.variant {
                    Some(variant) => missing.contains(&variant).then_some(variant),
                    None => info
                        .template
                        .and_then(|t| missing_template.get(&t).copied()),
                };
                match waiting {
                    Some(product) => wait_for_product(applied, info.odoo_id, product),
                    // Not a storable product.
                    None => applied.skipped += 1,
                }
                continue;
            };
            let Some(supplier_id) = ensure_supplier(ctx, info.partner_id).await? else {
                applied.skipped += 1;
                continue;
            };
            let base_unit = info
                .template
                .and_then(|t| base_units.get(&t).copied().flatten());
            let per_vendor_unit = uoms.convert(1.0, info.uom_id, base_unit);
            let unit_cost = info.price.map(|price| {
                if per_vendor_unit > 0.0 {
                    price / per_vendor_unit
                } else {
                    price
                }
            });
            let min_order_qty = (info.min_qty > 0.0)
                .then(|| (uoms.convert(info.min_qty, info.uom_id, base_unit).ceil() as i64).max(1));
            let input = ingest::ProductSupplierInput {
                info: &info,
                product_id: &product_id,
                variant_id: variant_id.as_deref(),
                supplier_id: &supplier_id,
                unit_cost,
                min_order_qty,
            };
            match ingest::upsert_product_supplier(ctx, &input, &record_checksum(record)).await {
                Ok((action, id)) => {
                    tally(applied, action);
                    ingest::publish(ctx, "product_supplier", action, &id).await;
                }
                Err(error) => fail(applied, info.odoo_id, &error),
            }
        }
    }
    window.start(pager.first_answer);
    window.cursor = pager.cursor;
    if !pager.truncated {
        let live: HashSet<i64> = ctx
            .client
            .search(ctx.http, MODEL, json!([]), None, None, None)
            .await?
            .into_iter()
            .collect();
        let mapped = ingest::mappings_of(ctx.db, ctx.connection_id, ingest::SUPPLIER_INFO).await?;
        let expired: HashSet<i64> = if has_end_date && !mapped.is_empty() {
            let mut ids: Vec<i64> = mapped.keys().copied().collect();
            ids.sort_unstable();
            ctx.client
                .search(
                    ctx.http,
                    MODEL,
                    domain(all_of(vec![
                        term("id", "in", json!(ids)),
                        term("date_end", "<", json!(format_date(ctx.today))),
                    ])),
                    None,
                    None,
                    None,
                )
                .await?
                .into_iter()
                .collect()
        } else {
            HashSet::new()
        };
        for odoo_id in mapped
            .keys()
            .filter(|id| !live.contains(id) || expired.contains(id))
        {
            match ingest::remove_supplierinfo(ctx, *odoo_id).await {
                Ok(Some(row)) => {
                    tally(applied, Action::Deleted);
                    ingest::publish(ctx, "product_supplier", Action::Deleted, &row).await;
                }
                Ok(None) => {}
                Err(error) => fail(applied, *odoo_id, &error),
            }
        }
    }
    Ok(pager.truncated)
}

// ── stock ────────────────────────────────────────────────────────────────────

/// A full refresh: every quant in an internal location, summed per product
/// and warehouse, becomes the one bucket of that item in the managed
/// warehouse ([`ingest::refresh_stock`]); quantities are in the product's
/// unit, rounded to whole units.
async fn sync_stock(
    ctx: &Ctx<'_>,
    window: &mut Window,
    applied: &mut IngestResult,
) -> Result<bool, SyncError> {
    const MODEL: &str = "stock.quant";
    let fields = ctx
        .client
        .pick_fields(
            ctx.http,
            MODEL,
            &[
                "product_id",
                "location_id",
                "warehouse_id",
                "quantity",
                "reserved_quantity",
                "write_date",
            ],
        )
        .await?;
    // `warehouse_id` is a related field on quants in 16–19; should a server
    // lack it, the warehouse comes from the location's (stored) one.
    let locations = if fields.iter().any(|f| f == "warehouse_id") {
        None
    } else {
        let (rows, _) = ctx
            .client
            .search_read(
                ctx.http,
                "stock.location",
                domain(term("usage", "=", json!("internal"))),
                &["warehouse_id".to_owned()],
                None,
                None,
                Some(no_active_test()),
            )
            .await?;
        Some(
            rows.iter()
                .filter_map(|r| Some((record_id(r)?, r["warehouse_id"].clone())))
                .collect::<HashMap<i64, Value>>(),
        )
    };
    let mut pager = Pager::new(
        ctx,
        MODEL,
        term("location_id.usage", "=", json!("internal")),
        fields,
        None,
        0,
        None,
    );
    let mut totals = BTreeMap::new();
    while let Some(page) = pager.next().await? {
        for record in &page {
            window.see(&record["write_date"]);
            let counted = match &locations {
                None => add_quant(&mut totals, record),
                Some(locations) => {
                    let mut quant = record.clone();
                    if let Some(location) = m2o_id(&record["location_id"]) {
                        quant["warehouse_id"] = locations
                            .get(&location)
                            .cloned()
                            .unwrap_or(Value::Bool(false));
                    }
                    add_quant(&mut totals, &quant)
                }
            };
            if !counted {
                applied.skipped += 1;
            }
        }
    }
    window.start(pager.first_answer);
    let items = ingest::product_items(ctx.db, ctx.connection_id).await?;
    let warehouses = ingest::mappings_of(ctx.db, ctx.connection_id, ingest::WAREHOUSE).await?;
    let managed = ingest::managed_warehouses(ctx).await?;
    let mut sums: BTreeMap<BucketKey, (f64, f64)> = BTreeMap::new();
    for ((product, warehouse), (on_hand, reserved)) in &totals {
        let (Some((product_id, variant_id)), Some((_, warehouse_id))) =
            (items.get(product), warehouses.get(warehouse))
        else {
            applied.skipped += 1;
            continue;
        };
        if !managed.contains(warehouse_id) {
            applied.skipped += 1;
            continue;
        }
        let entry = sums
            .entry(BucketKey {
                product_id: product_id.clone(),
                variant_id: variant_id.clone(),
                warehouse_id: warehouse_id.clone(),
            })
            .or_insert((0.0, 0.0));
        entry.0 += on_hand;
        entry.1 += reserved;
    }
    let snapshot: BTreeMap<BucketKey, (i64, i64)> = sums
        .into_iter()
        .map(|(key, (on_hand, reserved))| {
            (key, (round_quantity(on_hand), round_quantity(reserved)))
        })
        .collect();
    let changes = ingest::refresh_stock(ctx, &snapshot, &managed).await?;
    applied.created += changes.created.len() as u64;
    applied.modified += (changes.updated.len() + changes.zeroed.len()) as u64;
    applied.skipped += changes.unchanged;
    for id in &changes.created {
        ingest::publish(ctx, "inventory", Action::Created, id).await;
    }
    for id in changes.updated.iter().chain(&changes.zeroed) {
        ingest::publish(ctx, "inventory", Action::Updated, id).await;
    }
    Ok(false)
}

// ── purchase orders ──────────────────────────────────────────────────────────

/// `[LAMP-1] Desk lamp` → `LAMP-1`.
fn code_from_display(value: &Value) -> Option<String> {
    let name = m2o_name(value)?;
    let rest = name.strip_prefix('[')?;
    let end = rest.find(']')?;
    Some(rest[..end].trim().to_owned()).filter(|s| !s.is_empty())
}

/// Purchase orders and their lines. The first scan reads orders from the
/// start date plus every still-open one; later scans follow the orders'
/// and their lines' changes (a receipt updates `qty_received` on a line).
async fn sync_purchase_orders(
    ctx: &Ctx<'_>,
    window: &mut Window,
    applied: &mut IngestResult,
) -> Result<bool, SyncError> {
    const MODEL: &str = "purchase.order";
    let fields = ctx
        .client
        .pick_fields(
            ctx.http,
            MODEL,
            &[
                "name",
                "partner_id",
                "state",
                "date_order",
                "date_approve",
                "date_planned",
                "currency_id",
                "picking_type_id",
                "amount_untaxed",
                "amount_tax",
                "amount_total",
                "receipt_status",
                "write_date",
            ],
        )
        .await?;
    let line_fields = ctx
        .client
        .pick_fields(
            ctx.http,
            "purchase.order.line",
            &[
                "order_id",
                "product_id",
                "name",
                "product_qty",
                "product_uom_qty",
                "qty_received",
                "price_unit",
                "price_tax",
                "price_total",
                "discount",
                "display_type",
                "write_date",
            ],
        )
        .await?;
    let change = match window.since.as_deref() {
        None => any_of(vec![
            term(
                "date_order",
                ">=",
                json!(format!("{} 00:00:00", format_date(ctx.start_date))),
            ),
            term("state", "in", json!(OPEN_PO_STATES)),
        ]),
        since => changed_since(&["write_date", "order_line.write_date"], since),
    };
    let items = ingest::product_items(ctx.db, ctx.connection_id).await?;
    let suppliers = ingest::mappings_of(ctx.db, ctx.connection_id, ingest::SUPPLIER).await?;
    let warehouses = ingest::mappings_of(ctx.db, ctx.connection_id, ingest::WAREHOUSE).await?;
    let mut pager = Pager::new(
        ctx,
        MODEL,
        change,
        fields,
        None,
        window.cursor,
        Some(ctx.max_pages),
    );
    while let Some(page) = pager.next().await? {
        let ids: Vec<i64> = page.iter().filter_map(record_id).collect();
        let (lines, _) = ctx
            .client
            .search_read(
                ctx.http,
                "purchase.order.line",
                domain(term("order_id", "in", json!(ids))),
                &line_fields,
                None,
                Some("order_id, sequence, id"),
                None,
            )
            .await?;
        let mut by_order: HashMap<i64, Vec<&Value>> = HashMap::new();
        for line in &lines {
            window.see(&line["write_date"]);
            if let Some(order) = m2o_id(&line["order_id"]) {
                by_order.entry(order).or_default().push(line);
            }
        }
        let missing = missing_products(
            ctx,
            &items,
            lines.iter().filter_map(|l| m2o_id(&l["product_id"])),
        )
        .await?;
        let mut type_ids: Vec<i64> = page
            .iter()
            .filter_map(|r| m2o_id(&r["picking_type_id"]))
            .collect();
        type_ids.sort_unstable();
        type_ids.dedup();
        let types: HashMap<i64, Value> = ctx
            .client
            .read(
                ctx.http,
                "stock.picking.type",
                &type_ids,
                &["warehouse_id".to_owned()],
                Some(no_active_test()),
            )
            .await?
            .into_iter()
            .filter_map(|r| Some((record_id(&r)?, r["warehouse_id"].clone())))
            .collect();
        for order in &page {
            window.see(&order["write_date"]);
            let Some(odoo_id) = record_id(order) else {
                applied.skipped += 1;
                continue;
            };
            let raw_lines = by_order.get(&odoo_id).cloned().unwrap_or_default();
            // The whole order waits for a product not synced yet: written
            // now, its checksum would skip it on the next pass.
            if let Some(product) = raw_lines
                .iter()
                .filter_map(|l| m2o_id(&l["product_id"]))
                .find(|p| missing.contains(p))
            {
                wait_for_product(applied, odoo_id, product);
                continue;
            }
            let supplier_id = match m2o_id(&order["partner_id"]) {
                Some(partner) => match suppliers.get(&partner) {
                    Some((_, id)) => Some(id.clone()),
                    None => ensure_supplier(ctx, partner).await?,
                },
                None => None,
            };
            let lines: Vec<(super::mappers::PoLineValues, Option<Item>, Option<String>)> =
                raw_lines
                    .iter()
                    .filter_map(|line| {
                        let values = map_po_line(line)?;
                        let item = values.product.and_then(|p| items.get(&p).cloned());
                        Some((values, item, code_from_display(&line["product_id"])))
                    })
                    .collect();
            let line_values: Vec<_> = lines.iter().map(|(l, ..)| l.clone()).collect();
            let state = order["state"].as_str().unwrap_or("draft");
            let warehouse = m2o_id(&order["picking_type_id"]).and_then(|t| types.get(&t));
            let name = odoo_text(&order["name"]).unwrap_or_else(|| format!("Odoo PO {odoo_id}"));
            let input = ingest::PurchaseOrderInput {
                odoo_id,
                name: &name,
                supplier_id,
                supplier_name: m2o_name(&order["partner_id"]),
                warehouse_id: warehouse
                    .and_then(m2o_id)
                    .and_then(|w| warehouses.get(&w))
                    .map(|(_, id)| id.clone()),
                warehouse_name: warehouse.and_then(m2o_name),
                status: po_status(state, order["receipt_status"].as_str(), &line_values),
                order_date: odoo_text(&order["date_approve"])
                    .or_else(|| odoo_text(&order["date_order"])),
                expected_date: odoo_text(&order["date_planned"]),
                currency: m2o_name(&order["currency_id"])
                    .filter(|c| c.len() == 3)
                    .map(|c| c.to_uppercase()),
                subtotal: odoo_number(&order["amount_untaxed"]).unwrap_or(0.0),
                tax_total: odoo_number(&order["amount_tax"]).unwrap_or(0.0),
                total: odoo_number(&order["amount_total"]).unwrap_or(0.0),
                lines,
            };
            let checksum = record_checksum(&json!({ "order": order, "lines": raw_lines }));
            match ingest::upsert_purchase_order(ctx, &input, &checksum).await {
                Ok((action, id)) => {
                    tally(applied, action);
                    ingest::publish(ctx, "purchase_order", action, &id).await;
                }
                Err(error) => fail(applied, odoo_id, &error),
            }
        }
    }
    window.start(pager.first_answer);
    window.cursor = pager.cursor;
    Ok(pager.truncated)
}

// ── sales ────────────────────────────────────────────────────────────────────

/// Sale order lines of confirmed orders as demand (`stash_sales_history`,
/// `source 'odoo'`, one row per line): the order's date (UTC), the line's
/// warehouse (the order's on 16–17), the quantity in the product's unit,
/// rounded. A line that stops counting (order cancelled or back to
/// quotation) is deleted.
async fn sync_sales(
    ctx: &Ctx<'_>,
    window: &mut Window,
    applied: &mut IngestResult,
) -> Result<bool, SyncError> {
    const MODEL: &str = "sale.order.line";
    let fields = ctx
        .client
        .pick_fields(
            ctx.http,
            MODEL,
            &[
                "order_id",
                "product_id",
                "product_uom_qty",
                "product_uom",
                "product_uom_id",
                "state",
                "display_type",
                "is_downpayment",
                "warehouse_id",
                "write_date",
            ],
        )
        .await?;
    let order_fields = ctx
        .client
        .pick_fields(
            ctx.http,
            "sale.order",
            &["date_order", "state", "warehouse_id", "write_date"],
        )
        .await?;
    let storable = ctx
        .client
        .fields(ctx.http, "product.product")
        .await?
        .contains("is_storable");
    let change = match window.since.as_deref() {
        None => term("state", "in", json!(["sale", "done"])),
        since => changed_since(&["write_date", "order_id.write_date"], since),
    };
    let base = all_of(vec![
        term("display_type", "=", json!(false)),
        term(
            "order_id.date_order",
            ">=",
            json!(format!("{} 00:00:00", format_date(ctx.start_date))),
        ),
        storable_domain(storable, "product_id."),
        change,
    ]);
    let items = ingest::product_items(ctx.db, ctx.connection_id).await?;
    let warehouses = ingest::mappings_of(ctx.db, ctx.connection_id, ingest::WAREHOUSE).await?;
    let uoms = ctx.uoms().await?;
    let mut pager = Pager::new(
        ctx,
        MODEL,
        base,
        fields,
        None,
        window.cursor,
        Some(ctx.max_pages),
    );
    while let Some(page) = pager.next().await? {
        let mut order_ids: Vec<i64> = page.iter().filter_map(|r| m2o_id(&r["order_id"])).collect();
        order_ids.sort_unstable();
        order_ids.dedup();
        let orders: HashMap<i64, Value> = ctx
            .client
            .read(ctx.http, "sale.order", &order_ids, &order_fields, None)
            .await?
            .into_iter()
            .filter_map(|r| Some((record_id(&r)?, r)))
            .collect();
        let product_ids: Vec<i64> = page
            .iter()
            .filter_map(|r| m2o_id(&r["product_id"]))
            .collect();
        let base_units = ctx.base_uoms("product.product", &product_ids).await?;
        let missing = missing_products(ctx, &items, product_ids.iter().copied()).await?;
        for record in &page {
            window.see(&record["write_date"]);
            let order = m2o_id(&record["order_id"]).and_then(|o| orders.get(&o));
            if let Some(order) = order {
                window.see(&order["write_date"]);
            }
            let mut line = record.clone();
            if record.get("state").is_none_or(|s| !s.is_string())
                && let Some(order) = order
            {
                line["state"] = order["state"].clone();
            }
            let Some(values) = map_sale_line(&line) else {
                applied.skipped += 1;
                continue;
            };
            let item = values.product.and_then(|p| items.get(&p));
            if let Some(product) = values.product.filter(|p| missing.contains(p)) {
                wait_for_product(applied, values.odoo_id, product);
                continue;
            }
            let date = order.and_then(|o| odoo_date(&o["date_order"]));
            let quantity = round_quantity(
                uoms.convert(
                    values.quantity,
                    values.uom_id,
                    values
                        .product
                        .and_then(|p| base_units.get(&p).copied().flatten()),
                ),
            );
            let outcome = match (values.counts, item, date) {
                (true, Some((product_id, variant_id)), Some(date)) if quantity != 0 => {
                    let warehouse = values
                        .warehouse
                        .or_else(|| order.and_then(|o| m2o_id(&o["warehouse_id"])))
                        .and_then(|w| warehouses.get(&w))
                        .map(|(_, id)| id.as_str());
                    ingest::upsert_sale(
                        ctx,
                        &ingest::SaleInput {
                            odoo_id: values.odoo_id,
                            date: &date,
                            product_id,
                            variant_id: variant_id.as_deref(),
                            warehouse_id: warehouse,
                            quantity,
                        },
                    )
                    .await
                }
                _ => ingest::delete_sale(ctx, values.odoo_id).await,
            };
            match outcome {
                Ok(action) => tally(applied, action),
                Err(error) => fail(applied, values.odoo_id, &error),
            }
        }
    }
    window.start(pager.first_answer);
    window.cursor = pager.cursor;
    Ok(pager.truncated)
}

// ── the catch-up probe ───────────────────────────────────────────────────────

/// A setting key's model, its base domain and the changed-since fields.
async fn resource(
    client: &Odoo,
    http: Option<&OutboundHttp>,
    key: &str,
) -> Result<Option<(&'static str, Expr, &'static [&'static str], Option<Value>)>, ConnectorError> {
    Ok(Some(match key {
        "warehouses" => (
            "stock.warehouse",
            Vec::new(),
            &["write_date"][..],
            Some(no_active_test()),
        ),
        "products" => {
            let storable = client
                .fields(http, "product.product")
                .await?
                .contains("is_storable");
            (
                "product.product",
                storable_domain(storable, ""),
                &["write_date", "product_tmpl_id.write_date"][..],
                Some(no_active_test()),
            )
        }
        "suppliers" => {
            if !client
                .fields(http, "res.partner")
                .await?
                .contains("supplier_rank")
            {
                return Ok(None);
            }
            (
                "res.partner",
                term("supplier_rank", ">", json!(0)),
                &["write_date"][..],
                Some(no_active_test()),
            )
        }
        "productSuppliers" => (
            "product.supplierinfo",
            Vec::new(),
            &["write_date"][..],
            None,
        ),
        "inventory" => (
            "stock.quant",
            term("location_id.usage", "=", json!("internal")),
            &["write_date"][..],
            None,
        ),
        "purchaseOrders" => (
            "purchase.order",
            Vec::new(),
            &["write_date", "order_line.write_date"][..],
            None,
        ),
        "sales" => (
            "sale.order.line",
            term("display_type", "=", json!(false)),
            &["write_date", "order_id.write_date"][..],
            None,
        ),
        _ => return Ok(None),
    }))
}

/// `client.hasUpdatesSince(resource, since)`: anything changed after the
/// sync's watermark.
pub(crate) async fn has_updates_since(
    client: &Odoo,
    http: Option<&OutboundHttp>,
    key: &str,
    since: Option<&str>,
) -> Result<bool, ConnectorError> {
    let Some((model, base, change, context)) = resource(client, http, key).await? else {
        return Ok(false);
    };
    let filter = domain(all_of(vec![base, changed_since(change, since)]));
    Ok(!client
        .search(http, model, filter, Some(1), None, context)
        .await?
        .is_empty())
}

/// `client.countResource(resource)`.
pub(crate) async fn count_resource(
    client: &Odoo,
    http: Option<&OutboundHttp>,
    key: &str,
) -> Result<f64, ConnectorError> {
    let Some((model, base, _, context)) = resource(client, http, key).await? else {
        return Ok(0.0);
    };
    Ok(client
        .search_count(http, model, domain(base), context)
        .await? as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_resume_and_finish() {
        let fresh = Window::open(
            &json!({ "sync_watermarks": { "OdooProduct": "2026-11-01 00:00:00" } }),
            "OdooProduct",
            false,
        );
        assert_eq!(fresh.since.as_deref(), Some("2026-11-01 00:00:00"));
        assert_eq!(fresh.sync_type(false), "INCREMENTAL");
        let full = Window::open(
            &json!({ "sync_watermarks": { "OdooProduct": "2026-11-01 00:00:00" } }),
            "OdooProduct",
            true,
        );
        assert_eq!(full.since, None);
        assert_eq!(full.sync_type(true), "FULL");

        let mut window = Window::open(
            &json!({ "sync_watermarks": {
                "OdooProduct": "2026-11-01 00:00:00",
                "OdooProduct__cursor": "500",
                "OdooProduct__since": "2026-10-01 00:00:00",
                "OdooProduct__t0": "2026-11-18 10:00:00",
                "OdooProduct__max": "2026-11-17 09:00:00",
            } }),
            "OdooProduct",
            false,
        );
        assert!(window.continuing);
        assert_eq!(window.cursor, 500);
        assert_eq!(window.since.as_deref(), Some("2026-10-01 00:00:00"));
        assert_eq!(window.sync_type(false), "INITIAL");
        window.see(&json!("2026-11-18 09:59:30"));
        window.see(&json!(false));
        let patch = window.done_patch(false);
        assert!(patch.contains(&("OdooProduct__cursor".to_owned(), None)));
        assert!(patch.contains(&(
            "OdooProduct".to_owned(),
            Some("2026-11-18 09:59:00".to_owned())
        )));
        assert!(
            !window
                .done_patch(true)
                .iter()
                .any(|(k, _)| k == "OdooProduct")
        );
        window.cursor = 1000;
        assert!(
            window
                .truncated_patch(false)
                .contains(&("OdooProduct__cursor".to_owned(), Some("1000".to_owned())))
        );
        assert!(
            window
                .truncated_patch(false)
                .contains(&("OdooProduct__failed".to_owned(), None))
        );
        assert!(
            window
                .truncated_patch(true)
                .contains(&("OdooProduct__failed".to_owned(), Some("true".to_owned())))
        );
    }

    #[test]
    fn a_failure_before_the_page_ceiling_holds_the_watermark() {
        // A record failed on the run the ceiling cut short.
        let window = Window::open(
            &json!({ "sync_watermarks": {
                "OdooProduct": "2026-11-01 00:00:00",
                "OdooProduct__cursor": "500",
                "OdooProduct__since": "2026-11-01 00:00:00",
                "OdooProduct__t0": "2026-11-18 10:00:00",
                "OdooProduct__max": "2026-11-17 09:00:00",
                "OdooProduct__failed": "true",
            } }),
            "OdooProduct",
            false,
        );
        // Cut short again without a failure: the flag stays.
        assert!(
            window
                .truncated_patch(false)
                .contains(&("OdooProduct__failed".to_owned(), Some("true".to_owned())))
        );
        // Completed without a failure in this run: the watermark still waits,
        // and the flag goes with the continuation.
        let done = window.done_patch(false);
        assert!(!done.iter().any(|(k, _)| k == "OdooProduct"));
        assert!(done.contains(&("OdooProduct__failed".to_owned(), None)));
        assert!(done.contains(&("OdooProduct__cursor".to_owned(), None)));
    }

    #[test]
    fn product_codes_come_from_display_names() {
        assert_eq!(
            code_from_display(&json!([1, "[LAMP-1] Desk lamp"])),
            Some("LAMP-1".to_owned())
        );
        assert_eq!(code_from_display(&json!([1, "Desk lamp"])), None);
        assert_eq!(code_from_display(&json!(false)), None);
    }

    #[test]
    fn import_start_reads_the_setting() {
        assert_eq!(
            import_start(&json!({ "settings": { "importStartDate": "2025-01-31" } }))
                .map(format_date),
            Some("2025-01-31".to_owned())
        );
        assert_eq!(import_start(&json!({ "settings": null })), None);
    }
}
