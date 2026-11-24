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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Asterisk, Expr, Func, Query, SubQueryStatement};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, Order, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    SALES_HISTORY_IMPORT_COMPLETED, SALES_HISTORY_IMPORT_CREATED, SALES_HISTORY_IMPORT_DELETED,
};
use weldsuite_catalogs::permission_keys::{INVENTORY_MANAGE, INVENTORY_READ};
use weldsuite_db::{OrmConn, orm, utc_now};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    orders, product_variants, products, stash_sales_history as history,
    stash_sales_history_imports as imports, warehouses,
};

use super::demand::{NOT_DEMAND, ymd};
use super::engine::MAX_QUANTITY;
use super::routes::{Ctx, is_iso_day, limit_param, whole};
use super::settings::{load_settings, model_json};
use crate::incoming::parse_date;
use crate::{Caller, Refusal, StashState, internal, validate};

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
async fn find_import<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Value>, DbErr> {
    imports::Entity::find_by_id(id)
        .filter(imports::Column::DeletedAt.is_null())
        .one(db)
        .await?
        .map(|row| model_json!(row))
        .transpose()
}

// ── Reading ─────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list sales history imports";
    let limit = limit_param(query.as_deref(), 50, 200);
    let db = orm(&caller.db);
    let rows = imports::Entity::find()
        .filter(imports::Column::DeletedAt.is_null())
        .order_by(imports::Column::CreatedAt, Order::Desc)
        .order_by(imports::Column::Id, Order::Desc)
        .limit(u64::try_from(limit).ok())
        .all(&db)
        .await
        .and_then(|rows| {
            rows.iter()
                .map(|row| model_json!(row))
                .collect::<Result<Vec<_>, _>>()
        });
    let total = imports::Entity::find()
        .filter(imports::Column::DeletedAt.is_null())
        .count(&db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => {
            let has_more = total > u64::try_from(rows.len()).unwrap_or(u64::MAX);
            List::new(rows, Pagination::new(total, has_more, None)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn fetch(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch sales history import";
    match find_import(&orm(&caller.db), &id).await {
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
    let now = utc_now();
    let row = imports::Entity::insert(imports::ActiveModel {
        id: Set(generate_id("shimp")),
        created_at: Set(now),
        updated_at: Set(now),
        file_name: Set(file_name),
        status: Set("processing".to_owned()),
        created_by: Set(Some(caller.user_id.clone())),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(|row| model_json!(row));
    match row {
        Ok(row) => {
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

async fn lookups<C: ConnectionTrait>(db: &C, rows: &[HistoryRow]) -> Result<Lookups, DbErr> {
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
    // `distinct on (sku)`, the oldest first.
    let variants: Vec<(String, String, String)> = product_variants::Entity::find()
        .select_only()
        .columns([
            product_variants::Column::Sku,
            product_variants::Column::ProductId,
            product_variants::Column::Id,
        ])
        .distinct_on([product_variants::Column::Sku])
        .filter(product_variants::Column::DeletedAt.is_null())
        .filter(product_variants::Column::Sku.is_in(skus.iter().map(String::as_str)))
        .order_by(product_variants::Column::Sku, Order::Asc)
        .order_by(product_variants::Column::CreatedAt, Order::Asc)
        .order_by(product_variants::Column::Id, Order::Asc)
        .into_tuple()
        .all(db)
        .await?;
    let products: Vec<(String, String)> = products::Entity::find()
        .select_only()
        .columns([products::Column::Sku, products::Column::Id])
        .distinct_on([products::Column::Sku])
        .filter(products::Column::DeletedAt.is_null())
        .filter(products::Column::Sku.is_in(skus.iter().map(String::as_str)))
        .order_by(products::Column::Sku, Order::Asc)
        .order_by(products::Column::CreatedAt, Order::Asc)
        .order_by(products::Column::Id, Order::Asc)
        .into_tuple()
        .all(db)
        .await?;
    let warehouses: Vec<(String, String)> = warehouses::Entity::find()
        .select_only()
        .columns([warehouses::Column::Code, warehouses::Column::Id])
        .distinct_on([warehouses::Column::Code])
        .filter(warehouses::Column::DeletedAt.is_null())
        .filter(warehouses::Column::Code.is_in(codes.iter().map(String::as_str)))
        .order_by(warehouses::Column::Code, Order::Asc)
        .order_by(warehouses::Column::CreatedAt, Order::Asc)
        .order_by(warehouses::Column::Id, Order::Asc)
        .into_tuple()
        .all(db)
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

/// A row's day (`u.day::date`): Postgres has no year 0.
fn history_day(text: &str) -> Result<time::Date, DbErr> {
    parse_date(text)
        .filter(|day| day.year() != 0)
        .ok_or_else(|| DbErr::Custom(format!("date/time field value out of range: \"{text}\"")))
}

/// Store `matched` as the import's sales history rows, in one statement.
async fn insert_history<C: ConnectionTrait>(
    db: &C,
    import_id: &str,
    at: PrimitiveDateTime,
    matched: &[Matched],
) -> Result<(), DbErr> {
    if matched.is_empty() {
        return Ok(());
    }
    let mut rows = Vec::with_capacity(matched.len());
    for row in matched {
        rows.push(history::ActiveModel {
            id: Set(generate_id("sh")),
            created_at: Set(at),
            date: Set(history_day(&row.date)?),
            product_id: Set(row.product_id.clone()),
            variant_id: Set(row.variant_id.clone()),
            warehouse_id: Set(row.warehouse_id.clone()),
            quantity: Set(i32::try_from(row.quantity)
                .map_err(|_| DbErr::Custom("integer out of range".to_owned()))?),
            source: Set("import".to_owned()),
            import_id: Set(Some(import_id.to_owned())),
            external_ref: Set(row.reference.clone()),
            ..Default::default()
        });
    }
    history::Entity::insert_many(rows)
        .exec_without_returning(db)
        .await?;
    Ok(())
}

/// `(select <expr> from stash_sales_history h where h.import_id = $id)`.
fn of_history(id: &str, expr: Expr) -> Expr {
    use sea_orm::ExprTrait as _;
    let mut select = Query::select();
    select
        .expr(expr)
        .from(history::Entity)
        .and_where(Expr::col(history::Column::ImportId).eq(id));
    Expr::SubQuery(None, Box::new(SubQueryStatement::SelectStatement(select)))
}

/// What a chunk adds to its import's counts.
struct Counts<'a> {
    id: &'a str,
    /// With `startRow`: the furthest row the chunk reaches.
    start_row: Option<i64>,
    length: i64,
    chunk: &'a Chunk,
    unmatched: Vec<String>,
    first: Option<&'a str>,
    last: Option<&'a str>,
    at: PrimitiveDateTime,
}

/// The import's counts after a chunk: derived from the rows stored for a
/// chunk with `startRow`, so a retry doesn't add them twice; added up
/// without.
async fn update_counts<C: ConnectionTrait>(db: &C, counts: Counts<'_>) -> Result<(), DbErr> {
    use sea_orm::ExprTrait as _;
    let int4 = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
    let col = |column: imports::Column| Expr::col((imports::Entity, column));
    let mut update = imports::Entity::update_many();
    update = match counts.start_row {
        Some(start) => {
            let furthest = || {
                Expr::from(Func::greatest([
                    col(imports::Column::RowsTotal),
                    Expr::val(int4(start + counts.length)),
                ]))
            };
            let stored = || {
                of_history(
                    counts.id,
                    Expr::from(Func::count(Expr::col(Asterisk))).cast_as("integer"),
                )
            };
            update
                .col_expr(imports::Column::RowsTotal, furthest())
                .col_expr(imports::Column::RowsImported, stored())
                .col_expr(
                    imports::Column::RowsSkipped,
                    Func::greatest([furthest().sub(stored()), Expr::val(0)]).into(),
                )
        }
        None => update
            .col_expr(
                imports::Column::RowsTotal,
                col(imports::Column::RowsTotal).add(int4(counts.length)),
            )
            .col_expr(
                imports::Column::RowsImported,
                col(imports::Column::RowsImported).add(int4(counts.chunk.imported)),
            )
            .col_expr(
                imports::Column::RowsSkipped,
                col(imports::Column::RowsSkipped).add(int4(counts.chunk.skipped)),
            ),
    };
    update
        .col_expr(
            imports::Column::UnmatchedSkus,
            Expr::val(json!(counts.unmatched)),
        )
        .col_expr(
            imports::Column::DateFrom,
            Func::least([
                col(imports::Column::DateFrom),
                Expr::val(counts.first.map(str::to_owned)).cast_as("date"),
            ])
            .into(),
        )
        .col_expr(
            imports::Column::DateTo,
            Func::greatest([
                col(imports::Column::DateTo),
                Expr::val(counts.last.map(str::to_owned)).cast_as("date"),
            ])
            .into(),
        )
        .col_expr(imports::Column::UpdatedAt, Expr::val(counts.at))
        .filter(imports::Column::Id.eq(counts.id))
        .exec(db)
        .await?;
    Ok(())
}

/// Lock the import, match and store the rows (a chunk with `startRow`
/// replacing what an earlier attempt stored), update its counts.
async fn store_rows(caller: &Caller, id: String, body: RowsBody) -> Result<Chunk, Refusal> {
    let at = utc_now();
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
            let db = OrmConn::new(conn);
            let import: Option<(String, Option<Value>)> = imports::Entity::find()
                .select_only()
                .columns([imports::Column::Status, imports::Column::UnmatchedSkus])
                .filter(imports::Column::Id.eq(&id))
                .filter(imports::Column::DeletedAt.is_null())
                .lock_exclusive()
                .into_tuple()
                .one(&db)
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
                history::Entity::delete_many()
                    .filter(history::Column::ImportId.eq(&id))
                    .filter(history::Column::ExternalRef.is_in(refs.iter().map(String::as_str)))
                    .exec(&db)
                    .await?;
            }
            let (variants, products, warehouses) = lookups(&db, &rows).await?;
            let (matched, chunk) = match_rows(&rows, &variants, &products, &warehouses);
            insert_history(&db, &id, at, &matched).await?;
            let existing: Vec<String> = existing
                .and_then(|value| serde_json::from_value(value).ok())
                .unwrap_or_default();
            let unmatched = merge_unmatched(&existing, &chunk.unmatched);
            let counts = Counts {
                id: &id,
                start_row,
                length: i64::try_from(rows.len()).unwrap_or(i64::MAX),
                chunk: &chunk,
                unmatched,
                first: matched.iter().map(|row| row.date.as_str()).min(),
                last: matched.iter().map(|row| row.date.as_str()).max(),
                at,
            };
            update_counts(&db, counts).await?;
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
    let at = utc_now();
    weldsuite_db::atomically_with(&caller.db, move |conn| {
        Box::pin(async move {
            let db = OrmConn::new(conn);
            let status: Option<String> = imports::Entity::find()
                .select_only()
                .column(imports::Column::Status)
                .filter(imports::Column::Id.eq(&id))
                .filter(imports::Column::DeletedAt.is_null())
                .lock_exclusive()
                .into_tuple()
                .one(&db)
                .await?;
            match status.as_deref() {
                None => return Err(Refusal::not_found(RESOURCE, &id)),
                Some("processing") => {}
                Some("done") => {
                    let row = find_import(&db, &id)
                        .await?
                        .ok_or_else(|| Refusal::not_found(RESOURCE, &id))?;
                    return Ok((row, false));
                }
                Some(_) => return Err(Refusal::bad_request("This import failed")),
            }
            let day = |of: fn(Expr) -> sea_orm::sea_query::FunctionCall| {
                of_history(&id, of(Expr::col(history::Column::Date)).into())
            };
            let row = imports::Entity::update_many()
                .col_expr(imports::Column::Status, Expr::val("done"))
                .col_expr(imports::Column::DateFrom, day(Func::min))
                .col_expr(imports::Column::DateTo, day(Func::max))
                .col_expr(imports::Column::UpdatedAt, Expr::val(at))
                .filter(imports::Column::Id.eq(&id))
                .exec_with_returning(&db)
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| DbErr::RecordNotFound(id.clone()))?;
            Ok::<_, Refusal>((model_json!(row)?, true))
        })
    })
    .await
}

/// The day of the first order, while the settings have no cut-over date.
async fn suggested_cutover(db: &weldsuite_db::PgPool) -> Result<Option<String>, DbErr> {
    let db = orm(db);
    if load_settings(&db).await?.cutover.is_some() {
        return Ok(None);
    }
    let first: Option<Option<PrimitiveDateTime>> = orders::Entity::find()
        .select_only()
        .column_as(orders::Column::CreatedAt.min(), "first")
        .filter(orders::Column::DeletedAt.is_null())
        .filter(orders::Column::CancelledAt.is_null())
        // `coalesce(status, '') <> all(…)`.
        .filter(
            Condition::any()
                .add(orders::Column::Status.is_null())
                .add(orders::Column::Status.is_not_in(NOT_DEMAND)),
        )
        .into_tuple()
        .one(&db)
        .await?;
    Ok(first.flatten().map(|at| ymd(at.date())))
}

async fn remove(State(state): State<StashState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to delete sales history import";
    let at = utc_now();
    let import_id = id.clone();
    let deleted = weldsuite_db::atomically_with(&ctx.caller.db, move |conn| {
        Box::pin(async move {
            let db = OrmConn::new(conn);
            let row = imports::Entity::update_many()
                .col_expr(imports::Column::DeletedAt, Expr::val(at))
                .col_expr(imports::Column::UpdatedAt, Expr::val(at))
                .filter(imports::Column::Id.eq(&import_id))
                .filter(imports::Column::DeletedAt.is_null())
                .exec_with_returning(&db)
                .await?
                .into_iter()
                .next();
            if row.is_some() {
                history::Entity::delete_many()
                    .filter(history::Column::ImportId.eq(&import_id))
                    .exec(&db)
                    .await?;
            }
            Ok::<_, Refusal>(row.map(|row| model_json!(row)).transpose()?)
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
        Err(refusal) => refusal.respond(FAILED),
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
