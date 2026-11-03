//! `/api/stock-adjustments`: the append-only audit trail (list, detail,
//! create). There is no update or delete, by design.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::WMS_ADJUSTMENT_CREATED;
use weldsuite_catalogs::permission_keys::{INVENTORY_CREATE, INVENTORY_READ};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::args::{Arg, bind_scalar, created_cursor, cursor_sql, page_list};
use crate::crud::{cursor_failed, write_failed};
use crate::js::{js_limit, query_param, query_set, sql_limit};
use crate::tables::STOCK_ADJUSTMENTS;
use crate::{Caller, Refusal, StashState, internal, now, validate};

type Body = Map<String, Value>;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(list).route_layer(gate.require([INVENTORY_READ])))
        .route(
            "/",
            axum::routing::post(create).route_layer(gate.require([INVENTORY_CREATE])),
        )
        .route(
            "/{id}",
            get(detail).route_layer(gate.require([INVENTORY_READ])),
        )
}

const LIST_SQL: &str = concat!(
    "select to_jsonb(t) from stock_adjustments t where ",
    "(not $1::boolean or (t.reason like $2 or t.notes like $2)) and (not $3::boolean or t.type = $4) ",
    "and (not $5::boolean or t.warehouse_id = $6) and (not $7::boolean or t.product_id = $8) ",
    "and (not $9::boolean or t.source_type = $10) ",
    "and (not $11::boolean or (t.created_at < $12::timestamp or (t.created_at = $12::timestamp and t.id < $13))) ",
    "order by t.created_at desc, t.id desc limit $14"
);

const COUNT_SQL: &str = concat!(
    "select count(*) from stock_adjustments t where ",
    "(not $1::boolean or (t.reason like $2 or t.notes like $2)) and (not $3::boolean or t.type = $4) ",
    "and (not $5::boolean or t.warehouse_id = $6) and (not $7::boolean or t.product_id = $8) ",
    "and (not $9::boolean or t.source_type = $10)"
);

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let mut filters = Vec::new();
    let search = query_set(query, "search").map(|search| format!("%{search}%"));
    filters.push(Arg::Bool(search.is_some()));
    filters.push(Arg::Text(search));
    for key in ["type", "warehouseId", "productId", "sourceType"] {
        let value = query_set(query, key);
        filters.push(Arg::Bool(value.is_some()));
        filters.push(Arg::Text(value));
    }
    let cursor = match query_set(query, "cursor") {
        Some(cursor) => {
            match created_cursor(&caller.db, cursor_sql!("stock_adjustments"), &cursor).await {
                Ok(cursor) => cursor,
                Err(error) => return cursor_failed(&error),
            }
        }
        None => None,
    };
    let mut page = filters.clone();
    page.push(Arg::Bool(cursor.is_some()));
    page.push(Arg::opt(cursor.as_ref().map(|(at, _)| at.as_str())));
    page.push(Arg::opt(cursor.as_ref().map(|(_, id)| id.as_str())));
    page.push(Arg::Int(sql_limit(limit)));
    let rows: Result<Vec<Value>, _> = bind_scalar(sqlx::query_scalar(LIST_SQL), page)
        .fetch_all(&caller.db)
        .await;
    let total: Result<i64, _> = bind_scalar(sqlx::query_scalar(COUNT_SQL), filters)
        .fetch_one(&caller.db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => page_list(
            rows.into_iter()
                .map(|row| STOCK_ADJUSTMENTS.js(row))
                .collect(),
            limit,
            total,
        ),
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list stock adjustments"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match STOCK_ADJUSTMENTS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => {
            Refusal::not_found("Stock adjustment", &id).respond("Failed to fetch stock adjustment")
        }
        Err(error) => internal(&error, "Failed to fetch stock adjustment"),
    }
}

/// `createStockAdjustmentSchema`: the parsed body.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
fn schema(issues: &mut Issues, body: &Body) -> Body {
    let mut out = Map::new();
    let text = |issues: &mut Issues, key: &str, presence: Presence, rules: Text, out: &mut Body| {
        match issues.text_with(body, key, presence, rules) {
            Field::Set(value) => {
                out.insert(key.to_owned(), Value::String(value));
            }
            Field::Null => {
                out.insert(key.to_owned(), Value::Null);
            }
            Field::Absent => {}
        }
    };
    let len = |min: Option<usize>, max: Option<usize>| Text::length(min, max);
    text(
        issues,
        "productId",
        Presence::Required,
        len(Some(1), Some(30)),
        &mut out,
    );
    for key in ["warehouseId", "locationId", "inventoryId", "variantId"] {
        text(
            issues,
            key,
            Presence::Nullish,
            len(None, Some(30)),
            &mut out,
        );
    }
    text(
        issues,
        "type",
        Presence::Required,
        len(Some(1), Some(30)),
        &mut out,
    );
    for key in ["previousQuantity", "adjustmentQuantity", "newQuantity"] {
        if let Field::Set(number) =
            issues.whole_number(body, key, Presence::Required, Number::default())
        {
            out.insert(key.to_owned(), json!(number));
        }
    }
    text(
        issues,
        "lotNumber",
        Presence::Optional,
        len(None, Some(100)),
        &mut out,
    );
    text(
        issues,
        "batchNumber",
        Presence::Optional,
        len(None, Some(100)),
        &mut out,
    );
    text(
        issues,
        "reason",
        Presence::Optional,
        len(None, None),
        &mut out,
    );
    text(
        issues,
        "reasonCode",
        Presence::Optional,
        len(None, Some(50)),
        &mut out,
    );
    text(
        issues,
        "notes",
        Presence::Optional,
        len(None, None),
        &mut out,
    );
    text(
        issues,
        "performedBy",
        Presence::Optional,
        len(None, Some(255)),
        &mut out,
    );
    text(
        issues,
        "performedByName",
        Presence::Optional,
        len(None, Some(255)),
        &mut out,
    );
    text(
        issues,
        "sourceType",
        Presence::Optional,
        len(None, Some(30)),
        &mut out,
    );
    text(
        issues,
        "sourceId",
        Presence::Nullish,
        len(None, Some(30)),
        &mut out,
    );
    text(
        issues,
        "sourceNumber",
        Presence::Optional,
        len(None, Some(100)),
        &mut out,
    );
    let approval = issues.boolean(body, "requiresApproval", Presence::Optional);
    out.insert(
        "requiresApproval".to_owned(),
        Value::Bool(approval.into_option().unwrap_or(false)),
    );
    if issues
        .nested(body, "metadata", Presence::Optional, |_, _| ())
        .as_set()
        .is_some()
    {
        out.insert(
            "metadata".to_owned(),
            body.get("metadata").cloned().unwrap_or(Value::Null),
        );
    }
    out
}

async fn create(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create stock adjustment"),
    };
    let id = generate_id("adj");
    let requires = data
        .get("requiresApproval")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut props = Map::new();
    props.insert("id".to_owned(), json!(id));
    for key in [
        "productId",
        "variantId",
        "warehouseId",
        "locationId",
        "inventoryId",
        "type",
        "previousQuantity",
        "adjustmentQuantity",
        "newQuantity",
        "lotNumber",
        "batchNumber",
        "reason",
        "reasonCode",
        "notes",
        "performedBy",
        "performedByName",
        "sourceType",
        "sourceId",
        "sourceNumber",
    ] {
        if let Some(value) = data.get(key) {
            props.insert(key.to_owned(), value.clone());
        }
    }
    props.insert("requiresApproval".to_owned(), json!(i32::from(requires)));
    props.insert(
        "approvalStatus".to_owned(),
        json!(if requires { "pending" } else { "approved" }),
    );
    if let Some(metadata) = data.get("metadata") {
        props.insert("metadata".to_owned(), metadata.clone());
    }
    props.insert("createdAt".to_owned(), json!(now()));
    let mut values = Map::new();
    for (prop, value) in &props {
        STOCK_ADJUSTMENTS.set(&mut values, prop, value.clone());
    }
    if let Err(error) = STOCK_ADJUSTMENTS
        .insert(&caller.db, values, &["createdAt"])
        .await
    {
        return write_failed(&error, "Failed to create stock adjustment");
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    for key in ["productId", "type", "adjustmentQuantity", "newQuantity"] {
        if let Some(value) = data.get(key) {
            event.insert(key.to_owned(), value.clone());
        }
    }
    caller.publish(&state, WMS_ADJUSTMENT_CREATED, &id, &Value::Object(event));
    Created(json!({ "id": id })).into_response()
}
