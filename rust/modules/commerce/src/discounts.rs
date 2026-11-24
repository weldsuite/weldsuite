//! `/api/discounts`: discount codes. A code is unique (trimmed, ignoring
//! case) among live, non-archived discounts (409 `CODE_TAKEN`); the usage
//! counter and the redemptions are the order writes' (`commerce-domain`).
//! `effectiveStatus` folds the dates and the usage into the stored status.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::{HeaderMap, StatusCode};
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{DISCOUNT_CREATED, DISCOUNT_DELETED, DISCOUNT_UPDATED};
use weldsuite_catalogs::permission_keys::{
    DISCOUNTS_CREATE, DISCOUNTS_DELETE, DISCOUNTS_READ, DISCOUNTS_UPDATE,
};
use weldsuite_commerce_domain::discount::effective_status;
use weldsuite_commerce_domain::money;
use weldsuite_db::{OrmConn, orm};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{discount_redemptions, discounts, orders};

use crate::args::{after_cursor, utc_now_sql};
use crate::js::query_set;
use crate::tables::DISCOUNTS;
use crate::wire::{amount, invalid, read_currency, read_date, read_money, read_text};
use crate::{Caller, CommerceState, Refusal, internal, now, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([DISCOUNTS_READ]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([DISCOUNTS_CREATE])),
        )
        // One `route` per method: `route_layer` wraps every method already
        // chained, so chaining them would stack the permissions.
        .route("/{id}", get(detail).route_layer(read()))
        .route(
            "/{id}",
            patch(update).route_layer(gate.require([DISCOUNTS_UPDATE])),
        )
        .route(
            "/{id}",
            delete(remove).route_layer(gate.require([DISCOUNTS_DELETE])),
        )
        .route("/{id}/redemptions", get(redemptions).route_layer(read()))
}

// ── presenting ──────────────────────────────────────────────────────────────

/// A discount with the flags its dates give (`startsAt` still ahead,
/// `endsAt` passed), worked out on the database's clock.
#[derive(Debug, FromQueryResult)]
struct Found {
    #[sea_orm(nested)]
    discount: discounts::Model,
    not_started: bool,
    expired: bool,
}

impl Found {
    /// Drizzle's row with the two flags, as [`present`] reads it.
    fn raw(&self) -> Result<Value, DbErr> {
        let mut row = DISCOUNTS.model(&self.discount)?;
        if let Value::Object(fields) = &mut row {
            fields.insert("not_started".to_owned(), json!(self.not_started));
            fields.insert("expired".to_owned(), json!(self.expired));
        }
        Ok(row)
    }
}

/// `coalesce(t.starts_at > now, false)` (`after_now`) or
/// `coalesce(t.ends_at <= now, false)`, `now` the UTC wall clock.
fn dated(column: discounts::Column, after_now: bool) -> Expr {
    let at = Expr::col((discounts::Entity, column));
    let compared = if after_now {
        sea_orm::ExprTrait::gt(at, utc_now_sql())
    } else {
        sea_orm::ExprTrait::lte(at, utc_now_sql())
    };
    Func::coalesce([compared, Expr::val(false)]).into()
}

/// The discounts with their date flags ([`Found`]).
fn with_flags() -> Select<discounts::Entity> {
    discounts::Entity::find()
        .column_as(dated(discounts::Column::StartsAt, true), "not_started")
        .column_as(dated(discounts::Column::EndsAt, false), "expired")
}

/// `effectiveStatus` in SQL (mirrors `commerce_domain::discount::effective_status`).
fn effective() -> Expr {
    use sea_orm::ExprTrait as _;
    let column = |column: discounts::Column| Expr::col((discounts::Entity, column));
    let used: Expr = Func::coalesce([column(discounts::Column::UsageCount), Expr::val(0)]).into();
    let active = Expr::case(dated(discounts::Column::EndsAt, false), "expired")
        .case(
            Condition::all()
                .add(column(discounts::Column::UsageLimit).is_not_null())
                .add(used.gte(column(discounts::Column::UsageLimit))),
            "used_up",
        )
        .case(dated(discounts::Column::StartsAt, true), "scheduled")
        .finally("active");
    let status = column(discounts::Column::Status);
    Expr::case(status.clone().eq("archived"), "archived")
        .case(status.eq("active"), active)
        .finally("draft")
        .into()
}

fn strings(value: &Value) -> Value {
    if value.is_array() {
        value.clone()
    } else {
        json!([])
    }
}

fn present(raw: &Value) -> Value {
    let flag = |key: &str| raw.get(key).and_then(Value::as_bool).unwrap_or(false);
    let (not_started, expired) = (flag("not_started"), flag("expired"));
    let row = raw;
    let usage = row["usageCount"].as_i64().unwrap_or(0);
    let used_up = row["usageLimit"]
        .as_i64()
        .is_some_and(|limit| usage >= limit);
    let status = row["status"].as_str().unwrap_or("draft");
    json!({
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "code": row["code"],
        "type": row["type"],
        "value": amount(&row["value"], "0.00"),
        "currency": row["currency"],
        "maxDiscountAmount": row["maxDiscountAmount"],
        "appliesTo": row["appliesTo"],
        "productIds": strings(&row["productIds"]),
        "variantIds": strings(&row["variantIds"]),
        "categoryIds": strings(&row["categoryIds"]),
        "minimumSubtotal": row["minimumSubtotal"],
        "minimumQuantity": row["minimumQuantity"],
        "usageLimit": row["usageLimit"],
        "usageLimitPerCustomer": row["usageLimitPerCustomer"],
        "usageCount": usage,
        "status": status,
        "effectiveStatus": effective_status(status, not_started, expired, used_up),
        "startsAt": row["startsAt"],
        "endsAt": row["endsAt"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

fn event(discount: &Value) -> Value {
    json!({
        "id": discount["id"],
        "name": discount["name"],
        "code": discount["code"],
        "type": discount["type"],
        "status": discount["status"],
    })
}

/// The live discount `id` (locked until the transaction ends with `lock`),
/// as [`present`] reads it.
async fn find<C: ConnectionTrait>(db: &C, id: &str, lock: bool) -> Result<Option<Value>, DbErr> {
    let mut found = with_flags()
        .filter(discounts::Column::Id.eq(id))
        .filter(discounts::Column::DeletedAt.is_null());
    if lock {
        found = found.lock_exclusive();
    }
    found
        .into_model::<Found>()
        .one(db)
        .await?
        .map(|found| found.raw())
        .transpose()
}

// ── list ────────────────────────────────────────────────────────────────────

/// The list's filters: live, `search` on name and code, `status`,
/// `effectiveStatus`.
fn filters(
    search: Option<&str>,
    status: Option<String>,
    effective_status: Option<String>,
) -> Condition {
    let mut all = Condition::all().add(discounts::Column::DeletedAt.is_null());
    if let Some(search) = search {
        all = all.add(
            Condition::any()
                .add(discounts::Column::Name.ilike(search))
                .add(discounts::Column::Code.ilike(search)),
        );
    }
    if let Some(status) = status {
        all = all.add(discounts::Column::Status.eq(status));
    }
    if let Some(wanted) = effective_status {
        all = all.add(sea_orm::ExprTrait::eq(effective(), wanted));
    }
    all
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list discounts";
    let query = query.as_deref();
    let param = |name: &str| query_set(query, name);
    let limit = weldsuite_kit::parse_limit(param("limit").as_deref(), 50, 100);
    let search = param("search").map(|s| format!("%{}%", crate::rules::like_literal(&s)));
    let cursor = param("cursor");
    let conditions = filters(search.as_deref(), param("status"), param("effectiveStatus"));
    let mut page = with_flags().filter(conditions.clone());
    if let Some(cursor) = &cursor {
        page = page.filter(after_cursor::<discounts::Entity>(
            discounts::Column::CreatedAt,
            discounts::Column::Id,
            cursor,
            true,
        ));
    }
    let db = orm(&caller.db);
    let rows = async {
        page.order_by_desc(discounts::Column::CreatedAt)
            .order_by_desc(discounts::Column::Id)
            .limit(u64::from(limit) + 1)
            .into_model::<Found>()
            .all(&db)
            .await?
            .iter()
            .map(Found::raw)
            .collect::<Result<Vec<Value>, DbErr>>()
    }
    .await;
    let total = discounts::Entity::find()
        .filter(conditions)
        .count(&db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => weldsuite_kit::Page::of(
            rows.iter().map(present).collect(),
            usize::try_from(limit).unwrap_or(50),
            |row: &Value| row["id"].as_str().unwrap_or_default(),
        )
        .into_list(total)
        .into_response(),
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch discount";
    match find(&orm(&caller.db), &id, false).await {
        Ok(Some(row)) => Data(present(&row)).into_response(),
        Ok(None) => Refusal::not_found("Discount", &id).respond(FAILED),
        Err(error) => internal(&error, FAILED),
    }
}

async fn redemptions(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "Failed to list redemptions";
    let query = query.as_deref();
    let cursor = query_set(query, "cursor");
    let limit = weldsuite_kit::parse_limit(query_set(query, "limit").as_deref(), 50, 100);
    let db = orm(&caller.db);
    let exists: Result<Option<String>, DbErr> = discounts::Entity::find_by_id(id.as_str())
        .filter(discounts::Column::DeletedAt.is_null())
        .select_only()
        .column(discounts::Column::Id)
        .into_tuple()
        .one(&db)
        .await;
    match exists {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Discount", &id).respond(FAILED),
        Err(error) => return internal(&error, FAILED),
    }
    let mut page = discount_redemptions::Entity::find()
        .select_only()
        .columns([
            discount_redemptions::Column::Id,
            discount_redemptions::Column::OrderId,
            discount_redemptions::Column::CustomerEmail,
            discount_redemptions::Column::PersonId,
            discount_redemptions::Column::Amount,
            discount_redemptions::Column::Currency,
            discount_redemptions::Column::CreatedAt,
        ])
        .column_as(orders::Column::OrderNumber, "order_number")
        .join(
            JoinType::LeftJoin,
            discount_redemptions::Entity::belongs_to(orders::Entity)
                .from(discount_redemptions::Column::OrderId)
                .to(orders::Column::Id)
                .into(),
        )
        .filter(discount_redemptions::Column::DiscountId.eq(id.as_str()));
    if let Some(cursor) = &cursor {
        page = page.filter(after_cursor::<discount_redemptions::Entity>(
            discount_redemptions::Column::CreatedAt,
            discount_redemptions::Column::Id,
            cursor,
            true,
        ));
    }
    let rows = async {
        page.order_by_desc(discount_redemptions::Column::CreatedAt)
            .order_by_desc(discount_redemptions::Column::Id)
            .limit(u64::from(limit) + 1)
            .into_model::<Redemption>()
            .all(&db)
            .await?
            .iter()
            .map(|row| serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string())))
            .collect::<Result<Vec<Value>, DbErr>>()
    }
    .await;
    let total = discount_redemptions::Entity::find()
        .filter(discount_redemptions::Column::DiscountId.eq(id.as_str()))
        .count(&db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => {
            weldsuite_kit::Page::of(rows, usize::try_from(limit).unwrap_or(50), |row: &Value| {
                row["id"].as_str().unwrap_or_default()
            })
            .into_list(total)
            .into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

/// A redemption as the list shows it, with its order's number.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct Redemption {
    id: String,
    order_id: String,
    order_number: Option<String>,
    customer_email: Option<String>,
    person_id: Option<String>,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize")]
    amount: BigDecimal,
    currency: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
}

// ── writes ──────────────────────────────────────────────────────────────────

/// A discount write as the body asked for it; `Absent` is left alone.
#[derive(Default)]
struct Body {
    name: Option<String>,
    description: Field<String>,
    code: Option<String>,
    kind: Option<String>,
    value: Option<money::Cents>,
    currency: Field<String>,
    max_discount: Field<money::Cents>,
    applies_to: Option<String>,
    product_ids: Option<Vec<String>>,
    variant_ids: Option<Vec<String>>,
    category_ids: Option<Vec<String>>,
    minimum_subtotal: Field<money::Cents>,
    minimum_quantity: Field<i64>,
    usage_limit: Field<i64>,
    usage_limit_per_customer: Field<i64>,
    status: Option<String>,
    starts_at: Field<String>,
    ends_at: Field<String>,
}

fn read_ids(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    issues
        .list(
            fields,
            key,
            Presence::Optional,
            None,
            Some(1000),
            |issues, id| issues.item_text(id, Text::trimmed(Some(1), Some(30))),
        )
        .into_option()
}

fn count(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Field<i64> {
    issues.whole_number(
        fields,
        key,
        Presence::Nullish,
        Number {
            min: Some(1.0),
            max: Some(2_000_000_000.0),
            ..Number::default()
        },
    )
}

fn read_body(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Body {
    let presence = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    Body {
        name: issues
            .text_with(fields, "name", presence, Text::trimmed(Some(1), Some(255)))
            .into_option(),
        description: read_text(issues, fields, "description", 5000),
        code: issues
            .text_with(fields, "code", presence, Text::trimmed(Some(1), Some(100)))
            .into_option(),
        kind: issues
            .choice(
                fields,
                "type",
                presence,
                &["percentage", "fixed_amount", "free_shipping"],
            )
            .into_option(),
        value: read_money(issues, fields, "value", presence).into_option(),
        currency: read_currency(issues, fields, Presence::Nullish),
        max_discount: read_money(issues, fields, "maxDiscountAmount", Presence::Nullish),
        applies_to: issues
            .choice(
                fields,
                "appliesTo",
                Presence::Optional,
                &["all", "products", "categories"],
            )
            .into_option(),
        product_ids: read_ids(issues, fields, "productIds"),
        variant_ids: read_ids(issues, fields, "variantIds"),
        category_ids: read_ids(issues, fields, "categoryIds"),
        minimum_subtotal: read_money(issues, fields, "minimumSubtotal", Presence::Nullish),
        minimum_quantity: count(issues, fields, "minimumQuantity"),
        usage_limit: count(issues, fields, "usageLimit"),
        usage_limit_per_customer: count(issues, fields, "usageLimitPerCustomer"),
        status: issues
            .choice(
                fields,
                "status",
                Presence::Optional,
                &["draft", "active", "archived"],
            )
            .into_option(),
        starts_at: read_date(issues, fields, "startsAt", Presence::Nullish),
        ends_at: read_date(issues, fields, "endsAt", Presence::Nullish),
    }
}

fn nullable<T: Into<Value>>(field: Field<T>) -> Option<Value> {
    match field {
        Field::Set(value) => Some(value.into()),
        Field::Null => Some(Value::Null),
        Field::Absent => None,
    }
}

fn cents_value(field: &Field<money::Cents>) -> Option<Value> {
    nullable(match field {
        Field::Set(c) => Field::Set(money::format(*c)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    })
}

/// The values of the body as columns.
fn columns(body: Body, creating: bool) -> Map<String, Value> {
    let t = &DISCOUNTS;
    let mut values = Map::new();
    let mut set = |prop: &str, value: Option<Value>| {
        if let Some(value) = value {
            t.set(&mut values, prop, value);
        }
    };
    set("name", body.name.map(Value::from));
    set("description", nullable(body.description));
    set("code", body.code.map(Value::from));
    set("type", body.kind.clone().map(Value::from));
    let free = body.kind.as_deref() == Some("free_shipping");
    set(
        "value",
        if free {
            Some(json!("0.00"))
        } else {
            body.value.map(|v| json!(money::format(v)))
        },
    );
    set("currency", nullable(body.currency));
    set("maxDiscountAmount", cents_value(&body.max_discount));
    set("appliesTo", body.applies_to.map(Value::from));
    set("productIds", body.product_ids.map(|v| json!(v)));
    set("variantIds", body.variant_ids.map(|v| json!(v)));
    set("categoryIds", body.category_ids.map(|v| json!(v)));
    set("minimumSubtotal", cents_value(&body.minimum_subtotal));
    set("minimumQuantity", nullable(body.minimum_quantity));
    set("usageLimit", nullable(body.usage_limit));
    set(
        "usageLimitPerCustomer",
        nullable(body.usage_limit_per_customer),
    );
    set("status", body.status.map(Value::from));
    set("startsAt", nullable(body.starts_at));
    set("endsAt", nullable(body.ends_at));
    if creating {
        for prop in [
            "description",
            "currency",
            "maxDiscountAmount",
            "minimumSubtotal",
            "startsAt",
            "endsAt",
        ] {
            if !values.contains_key(DISCOUNTS.column(prop).map_or("", |c| c.name)) {
                t.set(&mut values, prop, Value::Null);
            }
        }
    }
    values
}

/// What the stored (or new) row must satisfy, as `(field, message)`.
fn check(row: &Value) -> Option<(&'static str, &'static str)> {
    let kind = row["type"].as_str().unwrap_or_default();
    let value = row["value"].as_str().and_then(money::parse).unwrap_or(0);
    if kind == "percentage" && !(1..=10_000).contains(&value) {
        return Some(("value", "A percentage is above 0 and at most 100"));
    }
    if kind == "fixed_amount" {
        if value == 0 {
            return Some(("value", "A fixed amount is above 0"));
        }
        if row["currency"].as_str().is_none_or(str::is_empty) {
            return Some(("currency", "A fixed amount needs a currency"));
        }
    }
    let empty = |key: &str| row[key].as_array().is_none_or(Vec::is_empty);
    match row["appliesTo"].as_str() {
        Some("products") if empty("productIds") && empty("variantIds") => {
            Some(("productIds", "Name at least one product or variant"))
        }
        Some("categories") if empty("categoryIds") => {
            Some(("categoryIds", "Name at least one category"))
        }
        _ => {
            let (starts, ends) = (row["startsAt"].as_str(), row["endsAt"].as_str());
            match (starts, ends) {
                (Some(a), Some(b)) if b <= a => Some(("endsAt", "Must be after startsAt")),
                _ => None,
            }
        }
    }
}

fn code_taken() -> Refusal {
    ApiError::new(
        StatusCode::CONFLICT,
        "CODE_TAKEN",
        "This discount code is already in use",
    )
    .with_details(json!({ "field": "code" }))
    .into()
}

fn refusal_of(error: &DbErr) -> Option<Refusal> {
    (weldsuite_db::pg_constraint(error).as_deref() == Some("discounts_code_uidx")).then(code_taken)
}

async fn ensure_free<C: ConnectionTrait>(db: &C, code: &str, except: &str) -> Result<(), Refusal> {
    let trimmed = |value: Expr| Expr::from(Func::lower(Func::cust("trim").arg(value)));
    let taken: Option<String> = discounts::Entity::find()
        .select_only()
        .column(discounts::Column::Id)
        .filter(discounts::Column::DeletedAt.is_null())
        .filter(discounts::Column::Status.ne("archived"))
        .filter(sea_orm::ExprTrait::eq(
            trimmed(Expr::col((discounts::Entity, discounts::Column::Code))),
            trimmed(Expr::val(code)),
        ))
        .filter(discounts::Column::Id.ne(except))
        .into_tuple()
        .one(db)
        .await?;
    if taken.is_some() {
        Err(code_taken())
    } else {
        Ok(())
    }
}

async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create discount";
    let body = match validate(&headers, &body, |issues, fields| {
        read_body(issues, fields, false)
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let mut values = columns(body, true);
        let id = generate_id("disc");
        let t = &DISCOUNTS;
        let stamp = now();
        t.set(&mut values, "id", json!(id));
        t.set(&mut values, "createdAt", json!(stamp));
        t.set(&mut values, "updatedAt", json!(stamp));
        t.set(&mut values, "createdBy", json!(caller.user_id));
        t.set(&mut values, "usageCount", json!(0));
        let mut candidate = Value::Object(
            DISCOUNTS
                .js(Value::Object(values.clone()))
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
        if candidate["status"].is_null() {
            candidate["status"] = json!("draft");
        }
        if candidate["appliesTo"].is_null() {
            candidate["appliesTo"] = json!("all");
        }
        if let Some((field, message)) = check(&candidate) {
            return Err(invalid(field, message));
        }
        let mut tx = caller.db.begin().await?;
        let row = {
            let db = OrmConn::new(&mut tx);
            if candidate["status"] != "archived" {
                ensure_free(&db, candidate["code"].as_str().unwrap_or_default(), &id).await?;
            }
            let row = DISCOUNTS
                .insert_on(
                    &db,
                    values,
                    &["createdAt", "updatedAt", "startsAt", "endsAt"],
                )
                .await;
            match row {
                Ok(row) => row,
                Err(crate::table::WriteError::Database(error)) => {
                    return Err(refusal_of(&error).unwrap_or(Refusal::from(error)));
                }
                Err(other) => return Err(other.into()),
            }
        };
        tx.commit().await?;
        Ok(row)
    }
    .await;
    match result {
        Ok(row) => {
            caller.publish(
                &state,
                DISCOUNT_CREATED,
                row["id"].as_str().unwrap_or_default(),
                &event(&row),
            );
            Created(json!({ "id": row["id"] })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn update(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update discount";
    let (headers, body) = crate::wire::body_or_empty(&headers, &body);
    let body = match validate(&headers, &body, |issues, fields| {
        read_body(issues, fields, true)
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let mut tx = caller.db.begin().await?;
        let db = OrmConn::new(&mut tx);
        let Some(current) = find(&db, &id, true).await? else {
            return Err(Refusal::not_found("Discount", &id));
        };
        let mut values = columns(body, false);
        DISCOUNTS.set(&mut values, "updatedAt", json!(now()));
        // The row as it will be, to check it as a whole.
        let mut merged = present(&current);
        let patched = DISCOUNTS.js(Value::Object({
            let mut raw = Map::new();
            for (column, value) in &values {
                raw.insert(column.clone(), value.clone());
            }
            raw
        }));
        if let (Value::Object(target), Value::Object(changes)) = (&mut merged, patched) {
            for (key, value) in changes {
                if values.contains_key(DISCOUNTS.column(&key).map_or("", |c| c.name))
                    && key != "updatedAt"
                {
                    target.insert(key, value);
                }
            }
        }
        if let Some((field, message)) = check(&merged) {
            return Err(invalid(field, message));
        }
        let code_or_status = values.contains_key("code") || values.contains_key("status");
        if code_or_status && merged["status"] != "archived" {
            ensure_free(&db, merged["code"].as_str().unwrap_or_default(), &id).await?;
        }
        let row = DISCOUNTS
            .patch_on(&db, &id, values, true, &["updatedAt", "startsAt", "endsAt"])
            .await;
        let row = match row {
            Ok(Some(row)) => row,
            Ok(None) => return Err(Refusal::not_found("Discount", &id)),
            Err(crate::table::WriteError::Database(error)) => {
                return Err(refusal_of(&error).unwrap_or(Refusal::from(error)));
            }
            Err(other) => return Err(other.into()),
        };
        tx.commit().await?;
        Ok(row)
    }
    .await;
    match result {
        Ok(row) => {
            caller.publish(&state, DISCOUNT_UPDATED, &id, &event(&row));
            match find(&orm(&caller.db), &id, false).await {
                Ok(Some(raw)) => Data(present(&raw)).into_response(),
                Ok(None) => Refusal::not_found("Discount", &id).respond(FAILED),
                Err(error) => internal(&error, FAILED),
            }
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete discount";
    let stamp = now();
    let mut values = Map::new();
    DISCOUNTS.set(&mut values, "deletedAt", json!(stamp));
    DISCOUNTS.set(&mut values, "updatedAt", json!(stamp));
    let row = DISCOUNTS
        .patch(&caller.db, &id, values, true, &["deletedAt", "updatedAt"])
        .await;
    match row {
        Ok(Some(row)) => {
            caller.publish(&state, DISCOUNT_DELETED, &id, &event(&row));
            NoContent.into_response()
        }
        Ok(None) => Refusal::not_found("Discount", &id).respond(FAILED),
        Err(error) => internal(&error, FAILED),
    }
}
