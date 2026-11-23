//! `/api/commerce-channels`: the places a workspace sells (ADR COM-011).
//! A channel is a storefront (B2C or B2B), manual orders, or one connected
//! store (Shopify, WooCommerce). Storefront channels have keys ([`keys`]) and
//! shipping rates ([`shipping`]); connector channels have neither.
//!
//! A storefront channel is only `active` with at least one selling country
//! and one payment method (409 `CHANNEL_INCOMPLETE`, `details.missing`); the
//! currency is locked once the channel has orders (409 `CURRENCY_LOCKED`);
//! `invoice` is a B2B payment method; selling countries are EU member states
//! (milestone 1). Deleting a channel is a soft delete that revokes its keys.

mod keys;
mod registry;
mod shipping;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::{Asterisk, Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use time::PrimitiveDateTime;
use weldsuite_books_domain::tax::eu_vat::rates::is_eu_member;
use weldsuite_catalogs::entity_events::{
    COMMERCE_CHANNEL_CREATED, COMMERCE_CHANNEL_DELETED, COMMERCE_CHANNEL_KEY_REVOKED,
    COMMERCE_CHANNEL_UPDATED, COMMERCE_SHIPPING_RATE_DELETED,
};
use weldsuite_catalogs::permission_keys::{
    COMMERCE_CHANNELS_CREATE, COMMERCE_CHANNELS_DELETE, COMMERCE_CHANNELS_READ,
    COMMERCE_CHANNELS_UPDATE,
};
use weldsuite_db::{OrmConn, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    commerce_channel_keys, commerce_channels, commerce_shipping_rates, orders,
};

use crate::args::{after_cursor, iso};
use crate::js::query_set;
use crate::wire::{body_or_empty, invalid, read_currency};
use crate::{Caller, CommerceState, Refusal, internal, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    // One `route` per method (`route_layer` wraps every method chained).
    Router::new()
        .route(
            "/",
            get(list).route_layer(gate.require([COMMERCE_CHANNELS_READ])),
        )
        .route(
            "/",
            post(create).route_layer(gate.require([COMMERCE_CHANNELS_CREATE])),
        )
        .route(
            "/{id}",
            get(detail).route_layer(gate.require([COMMERCE_CHANNELS_READ])),
        )
        .route(
            "/{id}",
            patch(update).route_layer(gate.require([COMMERCE_CHANNELS_UPDATE])),
        )
        .route(
            "/{id}",
            delete(remove).route_layer(gate.require([COMMERCE_CHANNELS_DELETE])),
        )
        .merge(keys::routes(gate))
        .merge(shipping::routes(gate))
}

/// A 409 with a code, a message and optional details.
pub(super) fn conflict(code: &'static str, message: &str, details: Option<Value>) -> Refusal {
    let error = ApiError::new(StatusCode::CONFLICT, code, message);
    match details {
        Some(details) => error.with_details(details).into(),
        None => error.into(),
    }
}

// ── presenting ──────────────────────────────────────────────────────────────

/// A channel with how many of its keys are not revoked.
#[derive(Debug, FromQueryResult)]
struct Listed {
    #[sea_orm(nested)]
    channel: commerce_channels::Model,
    active_key_count: i64,
}

/// The channels with `activeKeyCount`: `(select count(*) from
/// commerce_channel_keys k where k.channel_id = t.id and k.revoked_at is
/// null)`.
fn listed() -> Select<commerce_channels::Entity> {
    let keys = Query::select()
        .expr(Func::count(Expr::col(Asterisk)))
        .from(commerce_channel_keys::Entity)
        .and_where(sea_orm::ExprTrait::eq(
            Expr::col((
                commerce_channel_keys::Entity,
                commerce_channel_keys::Column::ChannelId,
            )),
            Expr::col((commerce_channels::Entity, commerce_channels::Column::Id)),
        ))
        .and_where(commerce_channel_keys::Column::RevokedAt.is_null())
        .to_owned();
    commerce_channels::Entity::find().column_as(Expr::from(keys), "active_key_count")
}

/// A channel as the API answers it.
fn present(row: Listed) -> Value {
    let channel = row.channel;
    json!({
        "id": channel.id,
        "name": channel.name,
        "type": channel.type_,
        "audience": channel.audience,
        "status": channel.status,
        "currency": channel.currency,
        "pricesIncludeTax": channel.prices_include_tax,
        "sellingCountries": channel.selling_countries,
        "guestCheckout": channel.guest_checkout,
        "paymentMethods": channel.payment_methods,
        "connectionId": channel.connection_id,
        "activeKeyCount": row.active_key_count,
        "createdAt": iso(channel.created_at),
        "updatedAt": iso(channel.updated_at),
    })
}

fn event(channel: &Value) -> Value {
    json!({
        "id": channel["id"],
        "name": channel["name"],
        "type": channel["type"],
        "audience": channel["audience"],
        "status": channel["status"],
        "currency": channel["currency"],
    })
}

async fn find<C: ConnectionTrait>(db: &C, id: &str, lock: bool) -> Result<Option<Value>, DbErr> {
    // The lock is taken on the plain row: `for update` cannot sit on the
    // aggregate subselect's statement.
    if lock {
        let _locked: Option<String> = commerce_channels::Entity::find_by_id(id)
            .select_only()
            .column(commerce_channels::Column::Id)
            .filter(commerce_channels::Column::DeletedAt.is_null())
            .lock_exclusive()
            .into_tuple()
            .one(db)
            .await?;
    }
    let row = listed()
        .filter(commerce_channels::Column::Id.eq(id))
        .filter(commerce_channels::Column::DeletedAt.is_null())
        .into_model::<Listed>()
        .one(db)
        .await?;
    Ok(row.map(present))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

// ── reading a body ──────────────────────────────────────────────────────────

/// A country list: ISO-2 codes, upper-cased, Greece's `EL` as `GR`, each
/// once; `eu_only` also asks for an EU member state.
pub(super) fn read_countries(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    presence: Presence,
    eu_only: bool,
) -> Option<Vec<String>> {
    let message = if eu_only {
        "Must be an EU member state code, like NL"
    } else {
        "Must be a two-letter country code, like NL"
    };
    let list = issues.list(fields, key, presence, None, Some(60), |issues, item| {
        issues
            .item_pattern(
                item,
                Text::trimmed(Some(2), Some(2)),
                |code| {
                    let code = code.trim();
                    code.len() == 2
                        && code.bytes().all(|b| b.is_ascii_alphabetic())
                        && (!eu_only || is_eu_member(code))
                },
                message,
            )
            .map(|code| match code.to_ascii_uppercase().as_str() {
                "EL" => "GR".to_owned(),
                other => other.to_owned(),
            })
    });
    list.into_option().map(|mut codes| {
        let mut seen = Vec::new();
        codes.retain(|code| {
            let fresh = !seen.contains(code);
            seen.push(code.clone());
            fresh
        });
        codes
    })
}

#[derive(Default)]
struct Body {
    name: Option<String>,
    kind: Option<String>,
    audience: Option<String>,
    status: Option<String>,
    currency: Option<String>,
    prices_include_tax: Option<bool>,
    selling_countries: Option<Vec<String>>,
    guest_checkout: Option<bool>,
    payment_methods: Option<Vec<String>>,
    connection_id: Field<String>,
}

fn read_body(issues: &mut Issues, fields: &Map<String, Value>, creating: bool) -> Body {
    let presence = if creating {
        Presence::Required
    } else {
        Presence::Optional
    };
    let methods = issues
        .list(
            fields,
            "paymentMethods",
            Presence::Optional,
            None,
            Some(2),
            |issues, item| issues.item_choice(item, &["mollie", "invoice"]),
        )
        .into_option()
        .map(|mut methods| {
            methods.dedup();
            methods
        });
    Body {
        name: issues
            .text_with(fields, "name", presence, Text::trimmed(Some(1), Some(255)))
            .into_option(),
        kind: issues
            .choice(
                fields,
                "type",
                Presence::Optional,
                &["storefront", "manual", "shopify", "woocommerce"],
            )
            .into_option(),
        audience: issues
            .choice(fields, "audience", Presence::Optional, &["b2c", "b2b"])
            .into_option(),
        status: issues
            .choice(
                fields,
                "status",
                Presence::Optional,
                &["draft", "active", "archived"],
            )
            .into_option(),
        currency: read_currency(issues, fields, Presence::Optional).into_option(),
        prices_include_tax: issues
            .boolean(fields, "pricesIncludeTax", Presence::Optional)
            .into_option(),
        selling_countries: read_countries(
            issues,
            fields,
            "sellingCountries",
            Presence::Optional,
            true,
        ),
        guest_checkout: issues
            .boolean(fields, "guestCheckout", Presence::Optional)
            .into_option(),
        payment_methods: methods,
        connection_id: issues.text_with(
            fields,
            "connectionId",
            Presence::Nullish,
            Text::trimmed(Some(1), Some(30)),
        ),
    }
}

/// A channel as it will be stored.
struct Channel {
    name: String,
    kind: String,
    audience: String,
    status: String,
    currency: String,
    prices_include_tax: bool,
    selling_countries: Vec<String>,
    guest_checkout: bool,
    payment_methods: Vec<String>,
    connection_id: Option<String>,
}

fn is_connector(kind: &str) -> bool {
    matches!(kind, "shopify" | "woocommerce")
}

impl Channel {
    /// A new channel: the body over the defaults.
    fn fresh(body: Body) -> Self {
        let kind = body.kind.unwrap_or_else(|| "storefront".to_owned());
        let audience = body.audience.unwrap_or_else(|| "b2c".to_owned());
        let storefront = kind == "storefront";
        Self {
            name: body.name.unwrap_or_default(),
            prices_include_tax: body.prices_include_tax.unwrap_or(audience == "b2c"),
            status: body.status.unwrap_or_else(|| {
                // A connector's channel has nothing to finish.
                if is_connector(&kind) {
                    "active"
                } else {
                    "draft"
                }
                .to_owned()
            }),
            currency: body.currency.unwrap_or_else(|| "EUR".to_owned()),
            selling_countries: body.selling_countries.unwrap_or_default(),
            guest_checkout: body.guest_checkout.unwrap_or(true),
            payment_methods: body.payment_methods.unwrap_or_else(|| {
                if storefront {
                    vec!["mollie".to_owned()]
                } else {
                    Vec::new()
                }
            }),
            connection_id: body.connection_id.into_option(),
            audience,
            kind,
        }
    }

    /// The stored channel with the body's changes.
    fn merged(current: &Value, body: Body) -> Self {
        let text = |key: &str| current[key].as_str().unwrap_or_default().to_owned();
        Self {
            name: body.name.unwrap_or_else(|| text("name")),
            kind: text("type"),
            audience: body.audience.unwrap_or_else(|| text("audience")),
            status: body.status.unwrap_or_else(|| text("status")),
            currency: body.currency.unwrap_or_else(|| text("currency")),
            prices_include_tax: body
                .prices_include_tax
                .unwrap_or_else(|| current["pricesIncludeTax"].as_bool().unwrap_or(true)),
            selling_countries: body
                .selling_countries
                .unwrap_or_else(|| strings(&current["sellingCountries"])),
            guest_checkout: body
                .guest_checkout
                .unwrap_or_else(|| current["guestCheckout"].as_bool().unwrap_or(true)),
            payment_methods: body
                .payment_methods
                .unwrap_or_else(|| strings(&current["paymentMethods"])),
            connection_id: match body.connection_id {
                Field::Set(id) => Some(id),
                Field::Null => None,
                Field::Absent => current["connectionId"].as_str().map(str::to_owned),
            },
        }
    }

    /// The rules a stored channel keeps.
    fn check(&self) -> Result<(), Refusal> {
        if self.payment_methods.iter().any(|m| m == "invoice") && self.audience != "b2b" {
            return Err(invalid(
                "paymentMethods",
                "Pay by invoice is for B2B channels only",
            ));
        }
        if is_connector(&self.kind) && self.connection_id.is_none() {
            return Err(invalid(
                "connectionId",
                "A connected store's channel needs its connection",
            ));
        }
        if !is_connector(&self.kind) && self.connection_id.is_some() {
            return Err(invalid(
                "connectionId",
                "Only a connected store's channel has a connection",
            ));
        }
        if self.kind == "storefront" && self.status == "active" {
            let mut missing = Vec::new();
            if self.selling_countries.is_empty() {
                missing.push("sellingCountries");
            }
            if self.payment_methods.is_empty() {
                missing.push("paymentMethods");
            }
            if !missing.is_empty() {
                return Err(conflict(
                    "CHANNEL_INCOMPLETE",
                    "A storefront channel needs a selling country and a payment method to go live",
                    Some(json!({ "missing": missing })),
                ));
            }
        }
        Ok(())
    }
}

/// Another live channel already serves this store connection.
async fn connection_taken<C: ConnectionTrait>(
    db: &C,
    connection_id: &str,
    except: &str,
) -> Result<bool, DbErr> {
    let found: Option<String> = commerce_channels::Entity::find()
        .select_only()
        .column(commerce_channels::Column::Id)
        .filter(commerce_channels::Column::ConnectionId.eq(connection_id))
        .filter(commerce_channels::Column::DeletedAt.is_null())
        .filter(commerce_channels::Column::Id.ne(except))
        .into_tuple()
        .one(db)
        .await?;
    Ok(found.is_some())
}

// ── list and detail ─────────────────────────────────────────────────────────

/// The list's filters: live, `type`, `status`, `search` on the name.
fn filters(kind: Option<String>, status: Option<String>, search: Option<&str>) -> Condition {
    let mut all = Condition::all().add(commerce_channels::Column::DeletedAt.is_null());
    if let Some(kind) = kind {
        all = all.add(commerce_channels::Column::Type.eq(kind));
    }
    if let Some(status) = status {
        all = all.add(commerce_channels::Column::Status.eq(status));
    }
    if let Some(search) = search {
        all = all.add(commerce_channels::Column::Name.ilike(search));
    }
    all
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list channels";
    let query = query.as_deref();
    let param = |name: &str| query_set(query, name);
    let limit = weldsuite_kit::parse_limit(param("limit").as_deref(), 50, 100);
    let search = param("search").map(|s| format!("%{}%", crate::rules::like_literal(&s)));
    let filters = filters(param("type"), param("status"), search.as_deref());
    let cursor = param("cursor");
    let mut page = listed().filter(filters.clone());
    if let Some(cursor) = &cursor {
        page = page.filter(after_cursor::<commerce_channels::Entity>(
            commerce_channels::Column::CreatedAt,
            commerce_channels::Column::Id,
            cursor,
            false,
        ));
    }
    let db = orm(&caller.db);
    let rows = page
        .order_by_asc(commerce_channels::Column::CreatedAt)
        .order_by_asc(commerce_channels::Column::Id)
        .limit(u64::from(limit) + 1)
        .into_model::<Listed>()
        .all(&db)
        .await;
    let total = commerce_channels::Entity::find()
        .filter(filters)
        .count(&db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => weldsuite_kit::Page::of(
            rows.into_iter().map(present).collect(),
            usize::try_from(limit).unwrap_or(50),
            |row: &Value| row["id"].as_str().unwrap_or_default(),
        )
        .into_list(total)
        .into_response(),
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch channel";
    match find(&orm(&caller.db), &id, false).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Channel", &id).respond(FAILED),
        Err(error) => internal(&error, FAILED),
    }
}

// ── writes ──────────────────────────────────────────────────────────────────

async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create channel";
    let body = match validate(&headers, &body, |issues, fields| {
        read_body(issues, fields, true)
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let channel = Channel::fresh(body);
    let result = async {
        channel.check()?;
        let id = generate_id("chan");
        let mut tx = caller.db.begin().await?;
        let db = OrmConn::new(&mut tx);
        if let Some(connection) = &channel.connection_id
            && connection_taken(&db, connection, &id).await?
        {
            return Err(conflict(
                "CONNECTION_IN_USE",
                "Another channel already serves this store connection",
                None,
            ));
        }
        let stamp = utc_now();
        commerce_channels::Entity::insert(commerce_channels::ActiveModel {
            id: Set(id.clone()),
            name: Set(channel.name.clone()),
            type_: Set(channel.kind.clone()),
            audience: Set(channel.audience.clone()),
            status: Set(channel.status.clone()),
            currency: Set(channel.currency.clone()),
            prices_include_tax: Set(channel.prices_include_tax),
            selling_countries: Set(json!(channel.selling_countries)),
            guest_checkout: Set(channel.guest_checkout),
            payment_methods: Set(json!(channel.payment_methods)),
            connection_id: Set(channel.connection_id.clone()),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
        tx.commit().await?;
        Ok(id)
    }
    .await;
    match result {
        Ok(id) => {
            caller.publish(
                &state,
                COMMERCE_CHANNEL_CREATED,
                &id,
                &json!({
                    "id": id, "name": channel.name, "type": channel.kind,
                    "audience": channel.audience, "status": channel.status,
                    "currency": channel.currency,
                }),
            );
            Created(json!({ "id": id })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

#[allow(clippy::too_many_lines)]
async fn update(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update channel";
    let (headers, body) = body_or_empty(&headers, &body);
    let body = match validate(&headers, &body, |issues, fields| {
        read_body(issues, fields, false)
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let mut tx = caller.db.begin().await?;
        let db = OrmConn::new(&mut tx);
        let Some(current) = find(&db, &id, true).await? else {
            return Err(Refusal::not_found("Channel", &id));
        };
        if body
            .kind
            .as_deref()
            .is_some_and(|kind| current["type"] != kind)
        {
            return Err(conflict(
                "TYPE_LOCKED",
                "A channel's type cannot change",
                None,
            ));
        }
        let channel = Channel::merged(&current, body);
        channel.check()?;
        if let Some(connection) = &channel.connection_id
            && connection_taken(&db, connection, &id).await?
        {
            return Err(conflict(
                "CONNECTION_IN_USE",
                "Another channel already serves this store connection",
                None,
            ));
        }
        let currency_changed = current["currency"] != channel.currency.as_str();
        if currency_changed {
            let has_orders: Option<String> = orders::Entity::find()
                .select_only()
                .column(orders::Column::Id)
                .filter(orders::Column::ChannelId.eq(id.as_str()))
                .filter(orders::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&db)
                .await?;
            if has_orders.is_some() {
                return Err(conflict(
                    "CURRENCY_LOCKED",
                    "The currency cannot change once the channel has orders",
                    Some(json!({ "currency": current["currency"] })),
                ));
            }
        }
        let stamp = utc_now();
        commerce_channels::Entity::update_many()
            .col_expr(
                commerce_channels::Column::Name,
                Expr::val(channel.name.as_str()),
            )
            .col_expr(
                commerce_channels::Column::Audience,
                Expr::val(channel.audience.as_str()),
            )
            .col_expr(
                commerce_channels::Column::Status,
                Expr::val(channel.status.as_str()),
            )
            .col_expr(
                commerce_channels::Column::Currency,
                Expr::val(channel.currency.as_str()),
            )
            .col_expr(
                commerce_channels::Column::PricesIncludeTax,
                Expr::val(channel.prices_include_tax),
            )
            .col_expr(
                commerce_channels::Column::SellingCountries,
                Expr::val(json!(channel.selling_countries)),
            )
            .col_expr(
                commerce_channels::Column::GuestCheckout,
                Expr::val(channel.guest_checkout),
            )
            .col_expr(
                commerce_channels::Column::PaymentMethods,
                Expr::val(json!(channel.payment_methods)),
            )
            .col_expr(
                commerce_channels::Column::ConnectionId,
                Expr::val(channel.connection_id.clone()),
            )
            .col_expr(commerce_channels::Column::UpdatedAt, Expr::val(stamp))
            .filter(commerce_channels::Column::Id.eq(id.as_str()))
            .exec(&db)
            .await?;
        // The rates follow the channel: its currency, and only countries it
        // still sells to.
        follow_channel(
            &mut tx,
            &id,
            &channel.currency,
            &channel.selling_countries,
            stamp,
        )
        .await?;
        let fresh = find(&OrmConn::new(&mut tx), &id, false).await?;
        tx.commit().await?;
        fresh.ok_or_else(|| Refusal::not_found("Channel", &id))
    }
    .await;
    match result {
        Ok(row) => {
            caller.publish(&state, COMMERCE_CHANNEL_UPDATED, &id, &event(&row));
            Data(row).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// The channel's live rates take its currency and keep only the countries
/// it still sells to.
#[allow(
    clippy::disallowed_methods,
    reason = "one update that filters each rate's jsonb country array against the channel's (jsonb_array_elements), which the query builder cannot express"
)]
async fn follow_channel(
    conn: &mut PgConnection,
    channel_id: &str,
    currency: &str,
    countries: &[String],
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    sqlx::query(
        "update commerce_shipping_rates r set currency = $2, \
           countries = (select coalesce(jsonb_agg(c.value), '[]'::jsonb) \
                        from jsonb_array_elements(r.countries) c \
                        where c.value in (select value from jsonb_array_elements($3::jsonb))), \
           updated_at = $4 \
         where r.channel_id = $1 and r.deleted_at is null \
           and (r.currency <> $2 or exists (select 1 from jsonb_array_elements(r.countries) c \
                where c.value not in (select value from jsonb_array_elements($3::jsonb))))",
    )
    .bind(channel_id)
    .bind(currency)
    .bind(json!(countries))
    .bind(at)
    .execute(&mut *conn)
    .await
    .map(|_| ())
    .map_err(weldsuite_db::orm_error)
}

async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete channel";
    let result = async {
        let mut tx = caller.db.begin().await?;
        let db = OrmConn::new(&mut tx);
        let Some(current) = find(&db, &id, true).await? else {
            return Err(Refusal::not_found("Channel", &id));
        };
        let active: Vec<String> = commerce_channel_keys::Entity::find()
            .select_only()
            .column(commerce_channel_keys::Column::Id)
            .filter(commerce_channel_keys::Column::ChannelId.eq(id.as_str()))
            .filter(commerce_channel_keys::Column::RevokedAt.is_null())
            .into_tuple()
            .all(&db)
            .await?;
        let stamp = utc_now();
        // The keys stop working first (the registry is what the storefront
        // reads); a failure after that leaves a channel that retries cleanly.
        if !active.is_empty() {
            registry::Registry::of(&caller)?
                .revoke_channel(&id, stamp)
                .await?;
        }
        commerce_channel_keys::Entity::update_many()
            .col_expr(commerce_channel_keys::Column::RevokedAt, Expr::val(stamp))
            .col_expr(commerce_channel_keys::Column::UpdatedAt, Expr::val(stamp))
            .filter(commerce_channel_keys::Column::ChannelId.eq(id.as_str()))
            .filter(commerce_channel_keys::Column::RevokedAt.is_null())
            .exec(&db)
            .await?;
        let rates: Vec<String> = commerce_shipping_rates::Entity::update_many()
            .col_expr(commerce_shipping_rates::Column::DeletedAt, Expr::val(stamp))
            .col_expr(commerce_shipping_rates::Column::UpdatedAt, Expr::val(stamp))
            .filter(commerce_shipping_rates::Column::ChannelId.eq(id.as_str()))
            .filter(commerce_shipping_rates::Column::DeletedAt.is_null())
            .exec_with_returning(&db)
            .await?
            .into_iter()
            .map(|rate| rate.id)
            .collect();
        commerce_channels::Entity::update_many()
            .col_expr(commerce_channels::Column::DeletedAt, Expr::val(stamp))
            .col_expr(commerce_channels::Column::UpdatedAt, Expr::val(stamp))
            .filter(commerce_channels::Column::Id.eq(id.as_str()))
            .exec(&db)
            .await?;
        tx.commit().await?;
        Ok((current, active, rates))
    }
    .await;
    match result {
        Ok((channel, keys, rates)) => {
            for key in &keys {
                caller.publish(
                    &state,
                    COMMERCE_CHANNEL_KEY_REVOKED,
                    key,
                    &json!({ "id": key, "channelId": id }),
                );
            }
            for rate in &rates {
                caller.publish(
                    &state,
                    COMMERCE_SHIPPING_RATE_DELETED,
                    rate,
                    &json!({ "id": rate, "channelId": id }),
                );
            }
            caller.publish(&state, COMMERCE_CHANNEL_DELETED, &id, &event(&channel));
            NoContent.into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}
