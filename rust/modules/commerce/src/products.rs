//! `/api/products`: the product catalogue (cursor-paged CRUD with the sales
//! tax fields `taxable` / `taxClass`), a product's manual category
//! membership, and its sales channels on external stores
//! ([`crate::sales_channels`]).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::{Filter, ListError, Listing, fetch, page_of};
use crate::sales_channels::{self, ChannelError, Context};
use crate::sales_tax::tax_codes::is_accepted_product_tax_class;
use crate::table::WriteError;
use crate::tables;
use crate::{Caller, CommerceState, Refusal, all, now, validate};

const PRODUCT_LIST: (&str, &str) = listing_as!(row_of!(products); "products";
    "($2::boolean or t.status = $3::text)",
    "($4::boolean or t.name like $5::text or t.slug like $5::text or t.sku like $5::text or t.barcode like $5::text)";
    6, 7, 8; "$9");

const LISTING: Listing = Listing {
    table: &tables::PRODUCTS,
    filters: &[Filter::eq("status"), Filter::like("search")],
    list_sql: PRODUCT_LIST.0,
    count_sql: PRODUCT_LIST.1,
    slice_count: true,
};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::PRODUCTS_READ]);
    let update = || gate.require([perm::PRODUCTS_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(gate.require([perm::PRODUCTS_CREATE])))
        .route("/sales-channel-targets", get(targets).route_layer(read()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", axum::routing::patch(update_product).route_layer(update()))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(gate.require([perm::PRODUCTS_DELETE])),
        )
        .route("/{id}/categories", get(categories).route_layer(read()))
        .route("/{id}/sales-channels", get(channels).route_layer(read()))
        .route("/{id}/sales-channels", post(add_channel).route_layer(update()))
        .route(
            "/{id}/sales-channels/{channel_id}",
            axum::routing::patch(update_channel)
                .delete(remove_channel)
                .route_layer(update()),
        )
}

/// `{ ...product, salesChannels }`.
fn with_channels(mut product: Value, channels: &[Value]) -> Value {
    let id = product["id"].as_str().map(str::to_owned);
    let own: Vec<Value> = channels
        .iter()
        .filter(|c| c["productId"].as_str() == id.as_deref())
        .cloned()
        .collect();
    if let Value::Object(fields) = &mut product {
        fields.insert("salesChannels".to_owned(), Value::Array(own));
    }
    product
}

async fn list(State(_state): State<CommerceState>, caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list products";
    let fetched = match fetch(LISTING, &caller.db, query.as_deref()).await {
        Ok(fetched) => fetched,
        Err(error) => return error.respond(FAILED),
    };
    let (data, has_more, cursor) = page_of(fetched.rows, fetched.limit, |row| row["id"].as_str());
    let ids: Vec<String> = data.iter().filter_map(|r| r["id"].as_str().map(str::to_owned)).collect();
    let channels = if ids.is_empty() {
        Vec::new()
    } else {
        match sales_channels::channels_of(&caller.db, &ids).await {
            Ok(channels) => channels,
            Err(error) => return ListError::Database(error).respond(FAILED),
        }
    };
    let data: Vec<Value> = data.into_iter().map(|p| with_channels(p, &channels)).collect();
    weldsuite_kit::List::new(
        data,
        weldsuite_kit::Pagination::new(u64::try_from(fetched.total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

async fn targets(State(_state): State<CommerceState>, caller: Caller) -> Response {
    match sales_channels::targets(&caller.db).await {
        Ok(targets) => Data(Value::Array(targets)).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to list sales channels"),
    }
}

async fn detail(State(_state): State<CommerceState>, caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch product";
    let product = match sales_channels::load_product(&caller.db, &id).await {
        Ok(Some(product)) => product,
        Ok(None) => return Refusal::not_found("Product", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    match sales_channels::channels_of(&caller.db, std::slice::from_ref(&id)).await {
        Ok(channels) => Data(with_channels(product, &channels)).into_response(),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

async fn live_id(caller: &Caller, id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> =
        sqlx::query_scalar("select id from products where id = $1 and deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(found.is_some())
}

async fn categories(State(_state): State<CommerceState>, caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to list product categories";
    match live_id(&caller, &id).await {
        Ok(true) => {}
        Ok(false) => return Refusal::not_found("Product", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object('id', c.id, 'name', c.name, 'slug', c.slug, 'parentId', c.parent_id, \
         'depth', c.depth, 'type', c.type, 'isActive', c.is_active) \
         from category_products cp inner join categories c on c.id = cp.category_id \
         where cp.product_id = $1 and c.deleted_at is null order by c.name",
    )
    .bind(&id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => all(rows),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

async fn channels(State(_state): State<CommerceState>, caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to list product sales channels";
    match live_id(&caller, &id).await {
        Ok(true) => {}
        Ok(false) => return Refusal::not_found("Product", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    }
    match sales_channels::channels_of(&caller.db, std::slice::from_ref(&id)).await {
        Ok(rows) => all(rows),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

/// `salesChannelError(c, err)`.
fn channel_error(error: ChannelError) -> Response {
    match error {
        ChannelError::NotFound(message) => (
            http::StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": { "code": "NOT_FOUND", "message": message } })),
        )
            .into_response(),
        ChannelError::Conflict(message) => ApiError::conflict(message).into_response(),
        ChannelError::ConnectionInactive(message) | ChannelError::Unsupported(message) | ChannelError::Invalid(message) => {
            ApiError::bad_request(message).into_response()
        }
        ChannelError::SyncFailed(message) => ApiError::internal().with_message(message).into_response(),
        ChannelError::Database(error) => {
            tracing::error!(%error, "[commerce-api/products] sales channel failed");
            ApiError::internal()
                .with_message("Failed to update sales channels")
                .into_response()
        }
    }
}

/// The product's name for the `product.updated` event (`existing?.name ?? ''`).
async fn product_name(caller: &Caller, id: &str) -> Value {
    let name: Option<Option<String>> = sqlx::query_scalar("select name from products where id = $1 limit 1")
        .bind(id)
        .fetch_optional(&caller.db)
        .await
        .unwrap_or(None);
    json!(name.flatten().unwrap_or_default())
}

fn listing_fields(issues: &mut Issues, fields: &Map<String, Value>) -> (Option<Value>, Option<Value>) {
    let price = issues.string_or_number(fields, "price", Presence::Optional).into_option();
    let status = issues
        .choice(fields, "listingStatus", Presence::Optional, &["active", "inactive", "draft"])
        .into_option()
        .map(Value::String);
    (price, status)
}

fn channel_context<'a>(caller: &'a Caller, http: Option<&'a weldsuite_ports::OutboundHttp>, keyring: &'a weldsuite_db::Keyring) -> Context<'a> {
    Context {
        db: &caller.db,
        http,
        keyring,
    }
}

async fn add_channel(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, fields| {
        let connection = issues
            .text_with(fields, "connectionId", Presence::Required, Text::length(Some(1), Some(30)))
            .into_option();
        let (price, status) = listing_fields(issues, fields);
        (connection.unwrap_or_default(), price, status)
    });
    let (connection, price, status) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to update sales channels"),
    };
    let http = caller.overrides.http(&state);
    let keyring = caller.overrides.keyring(&state);
    let ctx = channel_context(&caller, http.as_ref(), &keyring);
    match sales_channels::publish(&ctx, &id, &connection, price.as_ref(), status.as_ref()).await {
        Ok(channel) => {
            let name = product_name(&caller, &id).await;
            caller.publish(&state, ev::PRODUCT_UPDATED, &id, &json!({ "id": id, "name": name }));
            Created(channel).into_response()
        }
        Err(error) => channel_error(error),
    }
}

async fn update_channel(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, channel_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, fields| {
        let before = issues.count();
        let (price, status) = listing_fields(issues, fields);
        // `.refine(value => value.price !== undefined || value.listingStatus !== undefined)`.
        if issues.count() == before && price.is_none() && status.is_none() {
            issues.custom_root("Provide a price or listing status");
        }
        (price, status)
    });
    let (price, status) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to update sales channels"),
    };
    let http = caller.overrides.http(&state);
    let keyring = caller.overrides.keyring(&state);
    let ctx = channel_context(&caller, http.as_ref(), &keyring);
    match sales_channels::update(&ctx, &id, &channel_id, price.as_ref(), status.as_ref()).await {
        Ok(channel) => {
            let name = product_name(&caller, &id).await;
            caller.publish(&state, ev::PRODUCT_UPDATED, &id, &json!({ "id": id, "name": name }));
            Data(channel).into_response()
        }
        Err(error) => channel_error(error),
    }
}

async fn remove_channel(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, channel_id)): Path<(String, String)>,
) -> Response {
    let http = caller.overrides.http(&state);
    let keyring = caller.overrides.keyring(&state);
    let ctx = channel_context(&caller, http.as_ref(), &keyring);
    match sales_channels::unlink(&ctx, &id, &channel_id).await {
        Ok(()) => {
            let name = product_name(&caller, &id).await;
            caller.publish(&state, ev::PRODUCT_UPDATED, &id, &json!({ "id": id, "name": name }));
            NoContent.into_response()
        }
        Err(error) => channel_error(error),
    }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

const TAX_CLASS_MESSAGE: &str = "Unknown tax code: use a WeldBooks code, a Stripe txcd_ code or an Avalara code";

/// `createProductBodySchema` (`partial` for the PATCH): the body as Zod
/// passes it on (passthrough), with `taxClass` trimmed and blank as null.
fn read_product(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial { Presence::Optional } else { Presence::Required };
    let text = |issues: &mut Issues, key: &str, presence: Presence, min: Option<usize>, max: Option<usize>| {
        issues.text_with(fields, key, presence, Text::length(min, max));
    };
    text(issues, "name", required, Some(1), Some(255));
    text(issues, "slug", Presence::Optional, Some(1), Some(255));
    text(issues, "description", Presence::Optional, None, None);
    text(issues, "sku", Presence::Optional, None, Some(100));
    text(issues, "type", Presence::Optional, None, Some(30));
    text(issues, "status", Presence::Optional, None, Some(30));
    issues.string_or_number(fields, "price", Presence::Optional);
    text(issues, "currency", Presence::Optional, None, Some(10));
    text(issues, "categoryId", Presence::Nullish, None, None);
    text(issues, "imageUrl", Presence::Optional, None, None);
    issues.boolean(fields, "taxable", Presence::Optional);
    let mut data = fields.clone();
    // `productTaxClassSchema`: `.max(50).nullish()`, trimmed, `''` as null,
    // then refined (a refinement settles after every other check).
    let before = issues.count();
    let class = issues.text_with(fields, "taxClass", Presence::Nullish, Text::length(None, Some(50)));
    let refused = match class {
        Field::Set(raw) => {
            let trimmed = weldsuite_kit::validation::js_trim(&raw);
            if trimmed.is_empty() {
                data.insert("taxClass".to_owned(), Value::Null);
                false
            } else {
                data.insert("taxClass".to_owned(), json!(trimmed));
                !is_accepted_product_tax_class(trimmed)
            }
        }
        Field::Null => {
            data.insert("taxClass".to_owned(), Value::Null);
            false
        }
        // A string past its `.max()` is still refined, untrimmed.
        Field::Absent => {
            issues.count() > before
                && fields
                    .get("taxClass")
                    .and_then(Value::as_str)
                    .is_some_and(|raw| !is_accepted_product_tax_class(raw))
        }
    };
    if refused {
        issues.custom("taxClass", TAX_CLASS_MESSAGE);
    }
    data
}

fn write_failed(error: &WriteError, message: &str) -> Response {
    tracing::error!(%error, "[commerce-api/products] {message}");
    ApiError::internal().with_message(message).into_response()
}

async fn create(State(state): State<CommerceState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create product";
    let data = match validate(&headers, &body, |issues, fields| read_product(issues, fields, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let id = generate_id("prod");
    let now = now();
    let t = &tables::PRODUCTS;
    let mut values = Map::new();
    t.set(&mut values, "id", json!(id));
    values.extend(t.values(&data));
    t.set(&mut values, "createdAt", json!(now));
    t.set(&mut values, "updatedAt", json!(now));
    let mut trusted = vec!["createdAt", "updatedAt"];
    if !data.contains_key("id") {
        trusted.push("id");
    }
    if let Err(error) = t.insert(&caller.db, values, &trusted).await {
        return write_failed(&error, FAILED);
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert(
        "name".to_owned(),
        data.get("name").filter(|n| !n.is_null()).cloned().unwrap_or_else(|| json!("")),
    );
    for key in ["sku", "status", "price", "currency"] {
        if let Some(value) = data.get(key) {
            event.insert(key.to_owned(), value.clone());
        }
    }
    caller.publish(&state, ev::PRODUCT_CREATED, &id, &Value::Object(event));
    Created(json!({ "id": id })).into_response()
}

async fn update_product(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update product";
    let data = match validate(&headers, &body, |issues, fields| read_product(issues, fields, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let existing = match sales_channels::load_product(&caller.db, &id).await {
        Ok(Some(existing)) => existing,
        Ok(None) => return Refusal::not_found("Product", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let t = &tables::PRODUCTS;
    let mut values = Map::new();
    t.set(&mut values, "updatedAt", json!(now()));
    values.extend(t.values(&data));
    let trusted: &[&str] = if data.contains_key("updatedAt") { &[] } else { &["updatedAt"] };
    if let Err(error) = t.patch(&caller.db, &id, values, true, trusted).await {
        return write_failed(&error, FAILED);
    }
    // `(update.x ?? existing.x)`: the body's value unless it is null.
    let pick = |key: &str| {
        data.get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| existing.get(key).cloned().unwrap_or(Value::Null))
    };
    let name = match pick("name") {
        Value::Null => json!(""),
        name => name,
    };
    caller.publish(
        &state,
        ev::PRODUCT_UPDATED,
        &id,
        &json!({
            "id": id,
            "name": name,
            "sku": pick("sku"),
            "status": pick("status"),
            "price": pick("price"),
            "currency": pick("currency"),
        }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(State(state): State<CommerceState>, caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to delete product";
    let existing = match sales_channels::load_product(&caller.db, &id).await {
        Ok(Some(existing)) => existing,
        Ok(None) => return Refusal::not_found("Product", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    if let Err(error) = crate::crud::soft_delete(&caller.db, &tables::PRODUCTS, &id).await {
        return write_failed(&error, FAILED);
    }
    let name = existing
        .get("name")
        .filter(|n| !n.is_null())
        .cloned()
        .unwrap_or_else(|| json!(""));
    caller.publish(&state, ev::PRODUCT_DELETED, &id, &json!({ "id": id, "name": name }));
    NoContent.into_response()
}
