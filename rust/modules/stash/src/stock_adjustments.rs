//! `/api/stock-adjustments`: the append-only audit trail (list, detail,
//! create). There is no update or delete, by design.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, Order, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::WMS_ADJUSTMENT_CREATED;
use weldsuite_catalogs::permission_keys::{INVENTORY_CREATE, INVENTORY_READ};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::stock_adjustments as adjustments;

use crate::args::page_list;
use crate::crud::write_failed;
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

/// The list's conditions: `like(reason | notes, %search%)`, then `type`,
/// `warehouseId`, `productId` and `sourceType` when set.
fn filters(query: Option<&str>) -> Condition {
    let mut condition = Condition::all();
    if let Some(search) = query_set(query, "search") {
        let pattern = format!("%{search}%");
        condition = condition.add(
            Condition::any()
                .add(adjustments::Column::Reason.like(pattern.as_str()))
                .add(adjustments::Column::Notes.like(pattern.as_str())),
        );
    }
    for (key, column) in [
        ("type", adjustments::Column::Type),
        ("warehouseId", adjustments::Column::WarehouseId),
        ("productId", adjustments::Column::ProductId),
        ("sourceType", adjustments::Column::SourceType),
    ] {
        if let Some(value) = query_set(query, key) {
            condition = condition.add(column.eq(value));
        }
    }
    condition
}

/// The cursor row's `createdAt` as JavaScript read it (milliseconds) and
/// its id; `None` when the row is gone.
async fn cursor_row(
    db: &PgPool,
    cursor: &str,
) -> Result<Option<(PrimitiveDateTime, String)>, DbErr> {
    let row: Option<(PrimitiveDateTime, String)> = adjustments::Entity::find()
        .select_only()
        .column(adjustments::Column::CreatedAt)
        .column(adjustments::Column::Id)
        .filter(adjustments::Column::Id.eq(cursor))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(|(at, id)| (utc_timestamp(at.assume_utc()), id)))
}

/// The page (`limit + 1` rows, newest first, after the cursor) and the
/// number of rows the filters match.
async fn page(
    db: &PgPool,
    query: Option<&str>,
    cursor: Option<(PrimitiveDateTime, String)>,
    limit: f64,
) -> Result<(Vec<Value>, i64), DbErr> {
    let db = orm(db);
    let mut rows = adjustments::Entity::find().filter(filters(query));
    if let Some((at, id)) = cursor {
        rows = rows.filter(
            Condition::any()
                .add(adjustments::Column::CreatedAt.lt(at))
                .add(
                    Condition::all()
                        .add(adjustments::Column::CreatedAt.eq(at))
                        .add(adjustments::Column::Id.lt(id)),
                ),
        );
    }
    let rows = rows
        .order_by(adjustments::Column::CreatedAt, Order::Desc)
        .order_by(adjustments::Column::Id, Order::Desc)
        .limit(sql_limit(limit).and_then(|limit| u64::try_from(limit).ok()))
        .all(&db)
        .await?
        .into_iter()
        .map(|row| {
            serde_json::to_value(row)
                .map(|row| STOCK_ADJUSTMENTS.drizzle(row))
                .map_err(|error| DbErr::Json(error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let total = adjustments::Entity::find()
        .filter(filters(query))
        .count(&db)
        .await?;
    Ok((rows, i64::try_from(total).unwrap_or(i64::MAX)))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    // The cursor lookup runs before the route's `try`: a failure is the
    // app's 500.
    let cursor = match query_set(query, "cursor") {
        Some(cursor) => match cursor_row(&caller.db, &cursor).await {
            Ok(cursor) => cursor,
            Err(error) => {
                tracing::error!(%error, "stash: cursor lookup failed");
                return ApiError::internal().into_response();
            }
        },
        None => None,
    };
    match page(&caller.db, query, cursor, limit).await {
        Ok((rows, total)) => page_list(rows, limit, total),
        Err(error) => internal(&error, "Failed to list stock adjustments"),
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
