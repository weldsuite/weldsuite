//! `/api/discounts`: discount codes. A code is unique (trimmed, ignoring
//! case) among live, non-archived discounts (409 `CODE_TAKEN`); the usage
//! counter and the redemptions are the order writes' (`commerce-domain`).
//! `effectiveStatus` folds the dates and the usage into the stored status.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sqlx::{Postgres, Transaction};
use weldsuite_catalogs::entity_events::{DISCOUNT_CREATED, DISCOUNT_DELETED, DISCOUNT_UPDATED};
use weldsuite_catalogs::permission_keys::{
    DISCOUNTS_CREATE, DISCOUNTS_DELETE, DISCOUNTS_READ, DISCOUNTS_UPDATE,
};
use weldsuite_commerce_domain::discount::effective_status;
use weldsuite_commerce_domain::money;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::query_set;
use crate::tables::DISCOUNTS;
use crate::wire::{amount, invalid, iso, read_currency, read_date, read_money, read_text};
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
        .route(
            "/{id}",
            get(detail)
                .route_layer(read())
                .patch(update)
                .route_layer(gate.require([DISCOUNTS_UPDATE]))
                .delete(remove)
                .route_layer(gate.require([DISCOUNTS_DELETE])),
        )
        .route("/{id}/redemptions", get(redemptions).route_layer(read()))
}

// ── presenting ──────────────────────────────────────────────────────────────

/// The row plus the flags the dates give, read before Drizzle's shaping.
const SELECT: &str = concat!(
    "(",
    row_of!(discounts),
    " || jsonb_build_object(\
       'not_started', coalesce(t.starts_at > (now() at time zone 'utc'), false), \
       'expired', coalesce(t.ends_at <= (now() at time zone 'utc'), false)))"
);

/// `effectiveStatus` in SQL (mirrors `commerce_domain::discount::effective_status`).
const EFFECTIVE_SQL: &str = "(case t.status when 'archived' then 'archived' when 'active' then \
      (case when coalesce(t.ends_at <= (now() at time zone 'utc'), false) then 'expired' \
            when t.usage_limit is not null and coalesce(t.usage_count, 0) >= t.usage_limit then 'used_up' \
            when coalesce(t.starts_at > (now() at time zone 'utc'), false) then 'scheduled' \
            else 'active' end) \
      else 'draft' end)";

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
    let row = DISCOUNTS.js(raw.clone());
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

async fn find(
    conn: &mut sqlx::PgConnection,
    id: &str,
    lock: bool,
) -> Result<Option<Value>, sqlx::Error> {
    let tail = if lock { " for update of t" } else { "" };
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {SELECT} from discounts t where t.id = $1 and t.deleted_at is null{tail}"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
}

// ── list ────────────────────────────────────────────────────────────────────

const WHERE_SQL: &str = " where t.deleted_at is null \
    and ($1::text is null or t.name ilike $1 or t.code ilike $1) \
    and ($2::text is null or t.status = $2)";

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list discounts";
    let query = query.as_deref();
    let param = |name: &str| query_set(query, name);
    let limit = weldsuite_kit::parse_limit(param("limit").as_deref(), 50, 100);
    let search = param("search").map(|s| format!("%{}%", crate::rules::like_literal(&s)));
    let filter = " and ($3::text is null or {E} = $3)".replace("{E}", EFFECTIVE_SQL);
    let select = format!(
        "select {SELECT} from discounts t{WHERE_SQL}{filter} \
         and ($4::text is null or not exists (select 1 from discounts where id = $4) \
           or (t.created_at, t.id) < (select c.created_at, c.id from discounts c where c.id = $4)) \
         order by t.created_at desc, t.id desc limit $5"
    );
    let count = format!("select count(*) from discounts t{WHERE_SQL}{filter}");
    let cursor = param("cursor");
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(select))
        .bind(search.as_deref())
        .bind(param("status"))
        .bind(param("effectiveStatus"))
        .bind(cursor.as_deref())
        .bind(i64::from(limit) + 1)
        .fetch_all(&caller.db)
        .await;
    let total: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(count))
        .bind(search.as_deref())
        .bind(param("status"))
        .bind(param("effectiveStatus"))
        .fetch_one(&caller.db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => weldsuite_kit::Page::of(
            rows.iter().map(present).collect(),
            usize::try_from(limit).unwrap_or(50),
            |row: &Value| row["id"].as_str().unwrap_or_default(),
        )
        .into_list(u64::try_from(total).unwrap_or(0))
        .into_response(),
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch discount";
    let found = async {
        let mut conn = caller.db.acquire().await?;
        find(&mut conn, &id, false).await
    }
    .await;
    match found {
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
    let exists: Result<bool, sqlx::Error> = sqlx::query_scalar(
        "select exists (select 1 from discounts where id = $1 and deleted_at is null)",
    )
    .bind(&id)
    .fetch_one(&caller.db)
    .await;
    match exists {
        Ok(true) => {}
        Ok(false) => return Refusal::not_found("Discount", &id).respond(FAILED),
        Err(error) => return internal(&error, FAILED),
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object('id', r.id, 'orderId', r.order_id, 'orderNumber', o.order_number, \
           'customerEmail', r.customer_email, 'personId', r.person_id, 'amount', r.amount::text, \
           'currency', r.currency, 'createdAt', to_jsonb(r.created_at)) \
         from discount_redemptions r left join orders o on o.id = r.order_id \
         where r.discount_id = $1 \
           and ($2::text is null or not exists (select 1 from discount_redemptions where id = $2) \
             or (r.created_at, r.id) < (select c.created_at, c.id from discount_redemptions c where c.id = $2)) \
         order by r.created_at desc, r.id desc limit $3",
    )
    .bind(&id)
    .bind(cursor.as_deref())
    .bind(i64::from(limit) + 1)
    .fetch_all(&caller.db)
    .await;
    let total: Result<i64, sqlx::Error> =
        sqlx::query_scalar("select count(*) from discount_redemptions where discount_id = $1")
            .bind(&id)
            .fetch_one(&caller.db)
            .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => weldsuite_kit::Page::of(
            rows.into_iter()
                .map(|mut row| {
                    let stamp = iso(&row["createdAt"]);
                    row["createdAt"] = stamp;
                    row
                })
                .collect(),
            usize::try_from(limit).unwrap_or(50),
            |row: &Value| row["id"].as_str().unwrap_or_default(),
        )
        .into_list(u64::try_from(total).unwrap_or(0))
        .into_response(),
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
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

fn refusal_of(error: &sqlx::Error) -> Option<Refusal> {
    match error {
        sqlx::Error::Database(db) if db.constraint() == Some("discounts_code_uidx") => {
            Some(code_taken())
        }
        _ => None,
    }
}

async fn ensure_free(
    tx: &mut Transaction<'_, Postgres>,
    code: &str,
    except: &str,
) -> Result<(), Refusal> {
    let taken: bool = sqlx::query_scalar(
        "select exists (select 1 from discounts where deleted_at is null and status <> 'archived' \
           and lower(trim(code)) = lower(trim($1)) and id <> $2)",
    )
    .bind(code)
    .bind(except)
    .fetch_one(&mut **tx)
    .await?;
    if taken { Err(code_taken()) } else { Ok(()) }
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
        if candidate["status"] != "archived" {
            ensure_free(&mut tx, candidate["code"].as_str().unwrap_or_default(), &id).await?;
        }
        let row = DISCOUNTS
            .insert(
                &mut *tx,
                values,
                &["createdAt", "updatedAt", "startsAt", "endsAt"],
            )
            .await;
        let row = match row {
            Ok(row) => row,
            Err(crate::table::WriteError::Database(error)) => {
                return Err(refusal_of(&error).unwrap_or(Refusal::Database(error)));
            }
            Err(other) => return Err(other.into()),
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
        let Some(current) = find(&mut tx, &id, true).await? else {
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
            ensure_free(&mut tx, merged["code"].as_str().unwrap_or_default(), &id).await?;
        }
        let row = DISCOUNTS
            .patch(
                &mut *tx,
                &id,
                values,
                true,
                &["updatedAt", "startsAt", "endsAt"],
            )
            .await;
        let row = match row {
            Ok(Some(row)) => row,
            Ok(None) => return Err(Refusal::not_found("Discount", &id)),
            Err(crate::table::WriteError::Database(error)) => {
                return Err(refusal_of(&error).unwrap_or(Refusal::Database(error)));
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
            let fresh = async {
                let mut conn = caller.db.acquire().await?;
                find(&mut conn, &id, false).await
            }
            .await;
            match fresh {
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
