//! `/replenishment/imports`: past sales from a CSV file, as
//! `stash_sales_history` rows (`source = 'import'`; ADR STASH-009). The
//! browser parses the file and sends the rows in chunks:
//!
//! ```text
//! POST   /imports                 { fileName }: a new import, processing   201
//! POST   /imports/:id/rows        { rows: [...] (1–1000), startRow? }, while processing
//! POST   /imports/:id/complete    done; suggests a cut-over date
//! GET    /imports                 newest first
//! GET    /imports/:id
//! DELETE /imports/:id             the import (soft) and its rows (hard)     204
//! ```
//!
//! A row's SKU matches a live variant's SKU, else a live product's (the
//! oldest when several share it); its warehouse code a live warehouse's
//! `code`. Rows whose SKU matches nothing are counted as skipped and their
//! SKUs listed (the first 100 distinct on the import); rows with an unknown
//! warehouse code or a zero quantity are skipped too. Completing or
//! deleting an import marks the workspace due, so the next run uses it.
//!
//! **Retries.** A chunk sent with `startRow` (the 0-based index of its first
//! row in the file) can be sent again safely: each row is stored with
//! `external_ref = row:<startRow + i>`, and the chunk first deletes the
//! import's rows with those refs, so a retry replaces what the first attempt
//! stored. The import's counts are then derived, not added up:
//! `rows_total` is the furthest row seen (`startRow` + chunk length),
//! `rows_imported` the rows stored, `rows_skipped` the difference; send
//! `startRow` on every chunk of an import. Such rows keep no `reference`
//! (`external_ref` holds the row instead). Without `startRow` a chunk is
//! added as it comes: `reference` is stored in `external_ref` and the
//! counts grow by the chunk's, so a retry counts twice.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    SALES_HISTORY_IMPORT_COMPLETED, SALES_HISTORY_IMPORT_CREATED, SALES_HISTORY_IMPORT_DELETED,
};
use weldsuite_catalogs::permission_keys::{INVENTORY_MANAGE, INVENTORY_READ};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::demand::NOT_DEMAND;
use super::engine::MAX_QUANTITY;
use super::routes::{Ctx, is_iso_day, limit_param, whole};
use super::settings::load_settings;
use crate::{Caller, Refusal, StashState, internal, now, validate};

const RESOURCE: &str = "Sales history import";

/// SKUs kept on an import.
const MAX_UNMATCHED: usize = 100;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([INVENTORY_READ]);
    let manage = || gate.require([INVENTORY_MANAGE]);
    Router::new()
        .route("/imports", get(list).route_layer(read()))
        .route("/imports", post(create).route_layer(manage()))
        .route("/imports/{id}", get(fetch).route_layer(read()))
        .route("/imports/{id}", delete(remove).route_layer(manage()))
        .route("/imports/{id}/rows", post(add_rows).route_layer(manage()))
        .route(
            "/imports/{id}/complete",
            post(complete).route_layer(manage()),
        )
}

/// The data of a `sales_history_import` event.
fn import_event(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "fileName": row["fileName"],
        "status": row["status"],
        "rowsImported": row["rowsImported"],
        "rowsSkipped": row["rowsSkipped"],
    })
}

/// The live import `id`.
async fn find_import<'e>(
    db: impl sqlx::PgExecutor<'e>,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from stash_sales_history_imports t where t.id = $1 \
         and t.deleted_at is null",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

// ── Reading ─────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list sales history imports";
    let limit = limit_param(query.as_deref(), 50, 200);
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from stash_sales_history_imports t where t.deleted_at is null \
         order by t.created_at desc, t.id desc limit $1",
    )
    .bind(limit)
    .fetch_all(&caller.db)
    .await;
    let total: Result<i64, _> = sqlx::query_scalar(
        "select count(*) from stash_sales_history_imports where deleted_at is null",
    )
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

async fn fetch(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch sales history import";
    match find_import(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found(RESOURCE, &id).respond(FAILED),
        Err(error) => internal(&error, FAILED),
    }
}

// ── Writing ─────────────────────────────────────────────────────────────────

async fn create(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create sales history import";
    let file_name = match validate(&headers, &body, |issues, body| {
        issues
            .text_with(
                body,
                "fileName",
                Presence::Required,
                Text::length(Some(1), Some(255)),
            )
            .into_option()
    }) {
        Ok(Some(name)) => name,
        Ok(None) => return weldsuite_kit::ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond(FAILED),
    };
    let row: Result<Value, _> = sqlx::query_scalar(
        "insert into stash_sales_history_imports as t (id, created_at, updated_at, file_name, \
         status, created_by) values ($1, $2::timestamp, $2::timestamp, $3, 'processing', $4) \
         returning to_jsonb(t)",
    )
    .bind(generate_id("shimp"))
    .bind(now())
    .bind(&file_name)
    .bind(&caller.user_id)
    .fetch_one(&caller.db)
    .await;
    match row {
        Ok(row) => {
            let row = weldsuite_db::js_row(row);
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            caller.publish(
                &state,
                SALES_HISTORY_IMPORT_CREATED,
                &id,
                &import_event(&row),
            );
            Created(row).into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

/// A row of the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HistoryRow {
    pub(crate) date: String,
    pub(crate) sku: String,
    pub(crate) quantity: i64,
    pub(crate) warehouse_code: Option<String>,
    pub(crate) reference: Option<String>,
}

/// The body: `{ rows: [...] (1–1000), startRow?: integer ≥ 0 }`.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RowsBody {
    pub(crate) rows: Vec<HistoryRow>,
    /// The 0-based index of the first row in the file.
    pub(crate) start_row: Option<i64>,
}

/// The furthest `startRow`: `rows_total` stays an `int4`.
const MAX_START_ROW: i64 = 1_000_000_000;

fn read_body(issues: &mut Issues, body: &Map<String, Value>) -> RowsBody {
    let rows = read_rows(issues, body);
    let start_row = issues
        .whole_number(
            body,
            "startRow",
            Presence::Optional,
            whole(0, MAX_START_ROW),
        )
        .into_option();
    RowsBody { rows, start_row }
}

/// `external_ref` of the row at `index` in a chunk that starts at row
/// `start` of the file.
pub(crate) fn row_ref(start: i64, index: usize) -> String {
    format!(
        "row:{}",
        start.saturating_add(i64::try_from(index).unwrap_or(i64::MAX))
    )
}

fn read_rows(issues: &mut Issues, body: &Map<String, Value>) -> Vec<HistoryRow> {
    issues
        .list(
            body,
            "rows",
            Presence::Required,
            Some(1),
            Some(1000),
            |issues, item| {
                let fields = issues.object(item)?;
                let date = issues.pattern(
                    fields,
                    "date",
                    Presence::Required,
                    None,
                    None,
                    is_iso_day,
                    "Use YYYY-MM-DD",
                );
                let sku = issues.text_with(
                    fields,
                    "sku",
                    Presence::Required,
                    Text::length(Some(1), Some(100)),
                );
                let quantity = issues.whole_number(
                    fields,
                    "quantity",
                    Presence::Required,
                    whole(-MAX_QUANTITY, MAX_QUANTITY),
                );
                let warehouse_code = issues.text_with(
                    fields,
                    "warehouseCode",
                    Presence::Optional,
                    Text::length(None, Some(50)),
                );
                let reference = issues.text_with(
                    fields,
                    "reference",
                    Presence::Optional,
                    Text::length(None, Some(255)),
                );
                Some(HistoryRow {
                    date: date.into_option()?,
                    sku: sku.into_option()?.trim().to_owned(),
                    quantity: quantity.into_option()?,
                    warehouse_code: warehouse_code
                        .into_option()
                        .map(|code| code.trim().to_owned())
                        .filter(|code| !code.is_empty()),
                    reference: reference.into_option().filter(|text| !text.is_empty()),
                })
            },
        )
        .into_option()
        .unwrap_or_default()
}

/// What a chunk of rows did.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Chunk {
    pub(crate) imported: i64,
    pub(crate) skipped: i64,
    pub(crate) unmatched: Vec<String>,
}

/// A row that matched, ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Matched {
    pub(crate) date: String,
    pub(crate) product_id: String,
    pub(crate) variant_id: Option<String>,
    pub(crate) warehouse_id: Option<String>,
    pub(crate) quantity: i64,
    pub(crate) reference: Option<String>,
}

/// Match `rows` to products (by SKU: variant, then product) and warehouses
/// (by code).
pub(crate) fn match_rows(
    rows: &[HistoryRow],
    variants: &HashMap<String, (String, String)>,
    products: &HashMap<String, String>,
    warehouses: &HashMap<String, String>,
) -> (Vec<Matched>, Chunk) {
    let mut chunk = Chunk::default();
    let mut unmatched_seen = HashSet::new();
    let mut matched = Vec::new();
    for row in rows {
        let item = variants
            .get(&row.sku)
            .map(|(product, variant)| (product.clone(), Some(variant.clone())))
            .or_else(|| {
                products
                    .get(&row.sku)
                    .map(|product| (product.clone(), None))
            });
        let Some((product_id, variant_id)) = item else {
            chunk.skipped += 1;
            if unmatched_seen.insert(row.sku.clone()) {
                chunk.unmatched.push(row.sku.clone());
            }
            continue;
        };
        let warehouse_id = match &row.warehouse_code {
            Some(code) => {
                let Some(id) = warehouses.get(code) else {
                    chunk.skipped += 1;
                    continue;
                };
                Some(id.clone())
            }
            None => None,
        };
        if row.quantity == 0 {
            chunk.skipped += 1;
            continue;
        }
        chunk.imported += 1;
        matched.push(Matched {
            date: row.date.clone(),
            product_id,
            variant_id,
            warehouse_id,
            quantity: row.quantity,
            reference: row.reference.clone(),
        });
    }
    (matched, chunk)
}

/// The import's unmatched SKUs with `more` added: distinct, at most 100.
pub(crate) fn merge_unmatched(existing: &[String], more: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    existing
        .iter()
        .chain(more)
        .filter(|sku| seen.insert((*sku).clone()))
        .take(MAX_UNMATCHED)
        .cloned()
        .collect()
}

async fn add_rows(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to import sales history rows";
    let body = match validate(&headers, &body, read_body) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match store_rows(&caller, id, body).await {
        Ok(chunk) => Data(json!({
            "imported": chunk.imported,
            "skipped": chunk.skipped,
            "unmatchedSkus": chunk.unmatched,
        }))
        .into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// The SKU and warehouse code lookups of `rows`: variants (SKU → product,
/// variant), products (SKU → product), warehouses (code → id).
type Lookups = (
    HashMap<String, (String, String)>,
    HashMap<String, String>,
    HashMap<String, String>,
);

async fn lookups(conn: &mut PgConnection, rows: &[HistoryRow]) -> Result<Lookups, sqlx::Error> {
    let skus: Vec<String> = rows
        .iter()
        .map(|row| row.sku.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let codes: Vec<String> = rows
        .iter()
        .filter_map(|row| row.warehouse_code.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let variants: Vec<(String, String, String)> = sqlx::query_as(
        "select distinct on (sku) sku, product_id, id from product_variants \
         where deleted_at is null and sku = any($1) order by sku, created_at, id",
    )
    .bind(&skus)
    .fetch_all(&mut *conn)
    .await?;
    let products: Vec<(String, String)> = sqlx::query_as(
        "select distinct on (sku) sku, id from products \
         where deleted_at is null and sku = any($1) order by sku, created_at, id",
    )
    .bind(&skus)
    .fetch_all(&mut *conn)
    .await?;
    let warehouses: Vec<(String, String)> = sqlx::query_as(
        "select distinct on (code) code, id from warehouses \
         where deleted_at is null and code = any($1) order by code, created_at, id",
    )
    .bind(&codes)
    .fetch_all(&mut *conn)
    .await?;
    Ok((
        variants
            .into_iter()
            .map(|(sku, product, variant)| (sku, (product, variant)))
            .collect(),
        products.into_iter().collect(),
        warehouses.into_iter().collect(),
    ))
}

/// Store `matched` as the import's sales history rows, in one statement.
async fn insert_history(
    conn: &mut PgConnection,
    import_id: &str,
    at: &str,
    matched: &[Matched],
) -> Result<(), sqlx::Error> {
    if matched.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = matched.iter().map(|_| generate_id("sh")).collect();
    let days: Vec<&str> = matched.iter().map(|row| row.date.as_str()).collect();
    let product_ids: Vec<&str> = matched.iter().map(|row| row.product_id.as_str()).collect();
    let variant_ids: Vec<Option<&str>> = matched
        .iter()
        .map(|row| row.variant_id.as_deref())
        .collect();
    let warehouse_ids: Vec<Option<&str>> = matched
        .iter()
        .map(|row| row.warehouse_id.as_deref())
        .collect();
    let quantities: Vec<i64> = matched.iter().map(|row| row.quantity).collect();
    let references: Vec<Option<&str>> =
        matched.iter().map(|row| row.reference.as_deref()).collect();
    sqlx::query(
        "insert into stash_sales_history (id, created_at, date, product_id, variant_id, \
         warehouse_id, quantity, source, import_id, external_ref) \
         select u.id, $1::timestamp, u.day::date, u.product_id, u.variant_id, u.warehouse_id, \
         u.quantity, 'import', $2, u.reference \
         from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int8[], \
         $9::text[]) as u(id, day, product_id, variant_id, warehouse_id, quantity, reference)",
    )
    .bind(at)
    .bind(import_id)
    .bind(&ids)
    .bind(&days)
    .bind(&product_ids)
    .bind(&variant_ids)
    .bind(&warehouse_ids)
    .bind(&quantities)
    .bind(&references)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The counts of a chunk with `startRow`: derived from the rows stored, so
/// a retry doesn't add them twice (`$2`: the furthest row the chunk reaches).
const DERIVED_COUNTS: &str = "update stash_sales_history_imports t set \
     rows_total = greatest(t.rows_total, $2), \
     rows_imported = s.stored, rows_skipped = greatest(greatest(t.rows_total, $2) - s.stored, 0), \
     unmatched_skus = $3, date_from = least(t.date_from, $4::date), \
     date_to = greatest(t.date_to, $5::date), updated_at = $6::timestamp \
     from (select count(*)::integer as stored from stash_sales_history h \
       where h.import_id = $1) s \
     where t.id = $1";

/// The counts of a chunk without `startRow`: added up.
const ADDED_COUNTS: &str = "update stash_sales_history_imports set \
     rows_total = rows_total + $2, rows_imported = rows_imported + $7, \
     rows_skipped = rows_skipped + $8, unmatched_skus = $3, \
     date_from = least(date_from, $4::date), date_to = greatest(date_to, $5::date), \
     updated_at = $6::timestamp where id = $1";

/// Lock the import, match and store the rows (a chunk with `startRow`
/// replacing what an earlier attempt stored), update its counts.
async fn store_rows(caller: &Caller, id: String, body: RowsBody) -> Result<Chunk, Refusal> {
    let at = now();
    let RowsBody {
        mut rows,
        start_row,
    } = body;
    let refs: Vec<String> = match start_row {
        Some(start) => (0..rows.len()).map(|index| row_ref(start, index)).collect(),
        None => Vec::new(),
    };
    if start_row.is_some() {
        for (row, reference) in rows.iter_mut().zip(&refs) {
            row.reference = Some(reference.clone());
        }
    }
    weldsuite_db::atomically_with(&caller.db, move |conn| {
        Box::pin(async move {
            let import: Option<(String, Option<Value>)> = sqlx::query_as(
                "select status, unmatched_skus from stash_sales_history_imports \
                 where id = $1 and deleted_at is null for update",
            )
            .bind(&id)
            .fetch_optional(&mut *conn)
            .await?;
            let Some((status, existing)) = import else {
                return Err(Refusal::not_found(RESOURCE, &id));
            };
            if status != "processing" {
                return Err(Refusal::bad_request(
                    "This import is finished and takes no more rows",
                ));
            }
            if !refs.is_empty() {
                sqlx::query(
                    "delete from stash_sales_history where import_id = $1 \
                     and external_ref = any($2)",
                )
                .bind(&id)
                .bind(&refs)
                .execute(&mut *conn)
                .await?;
            }
            let (variants, products, warehouses) = lookups(conn, &rows).await?;
            let (matched, chunk) = match_rows(&rows, &variants, &products, &warehouses);
            insert_history(conn, &id, &at, &matched).await?;
            let existing: Vec<String> = existing
                .and_then(|value| serde_json::from_value(value).ok())
                .unwrap_or_default();
            let unmatched = merge_unmatched(&existing, &chunk.unmatched);
            let first = matched.iter().map(|row| row.date.as_str()).min();
            let last = matched.iter().map(|row| row.date.as_str()).max();
            let length = i64::try_from(rows.len()).unwrap_or(i64::MAX);
            let int4 = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
            let counts = match start_row {
                Some(start) => sqlx::query(DERIVED_COUNTS)
                    .bind(&id)
                    .bind(int4(start + length)),
                None => sqlx::query(ADDED_COUNTS).bind(&id).bind(int4(length)),
            };
            let counts = counts
                .bind(json!(unmatched))
                .bind(first)
                .bind(last)
                .bind(&at);
            let counts = if start_row.is_some() {
                counts
            } else {
                counts.bind(int4(chunk.imported)).bind(int4(chunk.skipped))
            };
            counts.execute(&mut *conn).await?;
            Ok::<_, Refusal>(chunk)
        })
    })
    .await
}

async fn complete(State(state): State<StashState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to complete sales history import";
    match finish_import(&ctx.caller, id).await {
        Ok((row, finished)) => {
            if finished {
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                ctx.caller.publish(
                    &state,
                    SALES_HISTORY_IMPORT_COMPLETED,
                    &id,
                    &import_event(&row),
                );
                ctx.mark_due(OffsetDateTime::now_utc()).await;
            }
            match suggested_cutover(&ctx.caller.db).await {
                Ok(suggested) => Data(json!({
                    "import": row,
                    "suggestedCutoverDate": suggested,
                }))
                .into_response(),
                Err(error) => internal(&error, FAILED),
            }
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// Mark the import done with its date range: the row, and whether it was
/// still processing (a second complete answers it again, unchanged).
async fn finish_import(caller: &Caller, id: String) -> Result<(Value, bool), Refusal> {
    let at = now();
    weldsuite_db::atomically_with(&caller.db, move |conn| {
        Box::pin(async move {
            let status: Option<String> = sqlx::query_scalar(
                "select status from stash_sales_history_imports where id = $1 \
                 and deleted_at is null for update",
            )
            .bind(&id)
            .fetch_optional(&mut *conn)
            .await?;
            match status.as_deref() {
                None => return Err(Refusal::not_found(RESOURCE, &id)),
                Some("processing") => {}
                Some("done") => {
                    let row = find_import(&mut *conn, &id)
                        .await?
                        .ok_or_else(|| Refusal::not_found(RESOURCE, &id))?;
                    return Ok((row, false));
                }
                Some(_) => return Err(Refusal::bad_request("This import failed")),
            }
            let row: Value = sqlx::query_scalar(
                "update stash_sales_history_imports t set status = 'done', \
                 date_from = (select min(h.date) from stash_sales_history h where h.import_id = $1), \
                 date_to = (select max(h.date) from stash_sales_history h where h.import_id = $1), \
                 updated_at = $2::timestamp where t.id = $1 returning to_jsonb(t)",
            )
            .bind(&id)
            .bind(&at)
            .fetch_one(&mut *conn)
            .await?;
            Ok::<_, Refusal>((weldsuite_db::js_row(row), true))
        })
    })
    .await
}

/// The day of the first order, while the settings have no cut-over date.
async fn suggested_cutover(db: &weldsuite_db::PgPool) -> Result<Option<String>, sqlx::Error> {
    if load_settings(db).await?.cutover.is_some() {
        return Ok(None);
    }
    sqlx::query_scalar(
        "select to_char(min(created_at), 'YYYY-MM-DD') from orders where deleted_at is null \
         and cancelled_at is null and coalesce(status, '') <> all($1)",
    )
    .bind(&NOT_DEMAND[..])
    .fetch_one(db)
    .await
}

async fn remove(State(state): State<StashState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to delete sales history import";
    let at = now();
    let import_id = id.clone();
    let deleted = weldsuite_db::atomically_with(&ctx.caller.db, move |conn| {
        Box::pin(async move {
            let row: Option<Value> = sqlx::query_scalar(
                "update stash_sales_history_imports t set deleted_at = $2::timestamp, \
                 updated_at = $2::timestamp where t.id = $1 and t.deleted_at is null \
                 returning to_jsonb(t)",
            )
            .bind(&import_id)
            .bind(&at)
            .fetch_optional(&mut *conn)
            .await?;
            if row.is_some() {
                sqlx::query("delete from stash_sales_history where import_id = $1")
                    .bind(&import_id)
                    .execute(&mut *conn)
                    .await?;
            }
            Ok::<_, sqlx::Error>(row.map(weldsuite_db::js_row))
        })
    })
    .await;
    match deleted {
        Ok(Some(row)) => {
            ctx.caller.publish(
                &state,
                SALES_HISTORY_IMPORT_DELETED,
                &id,
                &import_event(&row),
            );
            ctx.mark_due(OffsetDateTime::now_utc()).await;
            NoContent.into_response()
        }
        Ok(None) => Refusal::not_found(RESOURCE, &id).respond(FAILED),
        Err(error) => internal(&error, FAILED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(sku: &str, quantity: i64, code: Option<&str>) -> HistoryRow {
        HistoryRow {
            date: "2026-01-05".to_owned(),
            sku: sku.to_owned(),
            quantity,
            warehouse_code: code.map(str::to_owned),
            reference: None,
        }
    }

    #[test]
    fn rows_match_variants_then_products_and_warehouse_codes() {
        let variants = HashMap::from([(
            "LAMP-RED".to_owned(),
            ("prod_lamp".to_owned(), "var_red".to_owned()),
        )]);
        let products = HashMap::from([
            ("LAMP".to_owned(), "prod_lamp".to_owned()),
            ("LAMP-RED".to_owned(), "prod_other".to_owned()),
        ]);
        let warehouses = HashMap::from([("AMS".to_owned(), "wh_ams".to_owned())]);
        let rows = vec![
            row("LAMP-RED", 3, None),
            row("LAMP", 2, Some("AMS")),
            row("NOPE", 1, None),
            row("NOPE", 4, None),
            row("LAMP", 1, Some("XXX")),
            row("LAMP", 0, None),
            row("GONE", 1, None),
        ];
        let (matched, chunk) = match_rows(&rows, &variants, &products, &warehouses);
        assert_eq!(chunk.imported, 2);
        assert_eq!(chunk.skipped, 5);
        assert_eq!(chunk.unmatched, vec!["NOPE", "GONE"]);
        assert_eq!(matched[0].variant_id.as_deref(), Some("var_red"));
        assert_eq!(matched[0].product_id, "prod_lamp");
        assert_eq!(matched[1].warehouse_id.as_deref(), Some("wh_ams"));
        assert_eq!(matched[1].variant_id, None);
    }

    #[test]
    fn unmatched_skus_stay_distinct_and_capped() {
        let existing: Vec<String> = (0..99).map(|n| format!("S{n}")).collect();
        let merged = merge_unmatched(
            &existing,
            &["S1".to_owned(), "X".to_owned(), "Y".to_owned()],
        );
        assert_eq!(merged.len(), 100);
        assert_eq!(merged.last().map(String::as_str), Some("X"));
    }

    #[test]
    fn start_row_is_read_and_numbers_the_rows() {
        let read = |body: Value| {
            let mut issues = Issues::default();
            let fields = body.as_object().cloned().unwrap_or_default();
            let read = read_body(&mut issues, &fields);
            (read.start_row, issues.is_empty())
        };
        let row = json!({ "date": "2026-01-05", "sku": "A", "quantity": 1 });
        assert_eq!(read(json!({ "rows": [row] })), (None, true));
        assert_eq!(
            read(json!({ "rows": [row], "startRow": 1000 })),
            (Some(1000), true)
        );
        assert!(!read(json!({ "rows": [row], "startRow": -1 })).1);
        assert!(!read(json!({ "rows": [row], "startRow": 1.5 })).1);
        assert_eq!(row_ref(1000, 0), "row:1000");
        assert_eq!(row_ref(1000, 7), "row:1007");
    }

    #[test]
    fn rows_are_validated() {
        let read = |body: Value| {
            let mut issues = Issues::default();
            let fields = body.as_object().cloned().unwrap_or_default();
            let rows = read_rows(&mut issues, &fields);
            (rows, issues.is_empty())
        };
        let (rows, ok) = read(json!({ "rows": [
            { "date": "2026-01-05", "sku": " LAMP ", "quantity": -2, "warehouseCode": "" },
        ] }));
        assert!(ok);
        assert_eq!(
            rows,
            vec![HistoryRow {
                date: "2026-01-05".to_owned(),
                sku: "LAMP".to_owned(),
                quantity: -2,
                warehouse_code: None,
                reference: None,
            }]
        );
        assert!(!read(json!({ "rows": [] })).1);
        assert!(!read(json!({ "rows": [{ "date": "5 Jan", "sku": "A", "quantity": 1 }] })).1);
        assert!(!read(json!({ "rows": [{ "date": "2026-01-05", "sku": "", "quantity": 1 }] })).1);
        assert!(
            !read(json!({ "rows": [{ "date": "2026-01-05", "sku": "A", "quantity": 1.5 }] })).1
        );
    }
}
