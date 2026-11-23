//! `/api/commerce-channels/:id/shipping-rates`: flat shipping rates per zone
//! (a set of countries) on a storefront channel, in the channel's currency
//! and only to countries the channel sells to. Rates are ordered by
//! `position`; `PUT …/order` reorders them. No carrier rates in milestone 1.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect, Select,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    COMMERCE_SHIPPING_RATE_CREATED, COMMERCE_SHIPPING_RATE_DELETED, COMMERCE_SHIPPING_RATE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    COMMERCE_CHANNELS_CREATE, COMMERCE_CHANNELS_DELETE, COMMERCE_CHANNELS_READ,
    COMMERCE_CHANNELS_UPDATE,
};
use weldsuite_commerce_domain::money::{self, Cents};
use weldsuite_db::{OrmConn, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::commerce_shipping_rates;

use super::{conflict, find, read_countries, strings};
use crate::args::decimal;
use crate::wire::{body_or_empty, invalid, read_money};
use crate::{Caller, CommerceState, Refusal, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/{id}/shipping-rates",
            get(list).route_layer(gate.require([COMMERCE_CHANNELS_READ])),
        )
        .route(
            "/{id}/shipping-rates",
            post(create).route_layer(gate.require([COMMERCE_CHANNELS_CREATE])),
        )
        .route(
            "/{id}/shipping-rates/order",
            put(reorder).route_layer(gate.require([COMMERCE_CHANNELS_UPDATE])),
        )
        .route(
            "/{id}/shipping-rates/{rate_id}",
            patch(update).route_layer(gate.require([COMMERCE_CHANNELS_UPDATE])),
        )
        .route(
            "/{id}/shipping-rates/{rate_id}",
            delete(remove).route_layer(gate.require([COMMERCE_CHANNELS_DELETE])),
        )
}

/// A rate as the API answers it, the amounts as `numeric` text.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct Rate {
    id: String,
    channel_id: String,
    zone_name: String,
    countries: Value,
    name: String,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize")]
    price: BigDecimal,
    currency: String,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize_option")]
    free_shipping_threshold: Option<BigDecimal>,
    position: i32,
    active: bool,
}

/// The rates with the columns of a [`Rate`].
fn rate_rows() -> Select<commerce_shipping_rates::Entity> {
    commerce_shipping_rates::Entity::find()
        .select_only()
        .columns([
            commerce_shipping_rates::Column::Id,
            commerce_shipping_rates::Column::ChannelId,
            commerce_shipping_rates::Column::ZoneName,
            commerce_shipping_rates::Column::Countries,
            commerce_shipping_rates::Column::Name,
            commerce_shipping_rates::Column::Price,
            commerce_shipping_rates::Column::Currency,
            commerce_shipping_rates::Column::FreeShippingThreshold,
            commerce_shipping_rates::Column::Position,
            commerce_shipping_rates::Column::Active,
        ])
}

fn json_of(rate: &Rate) -> Result<Value, DbErr> {
    serde_json::to_value(rate).map_err(|error| DbErr::Json(error.to_string()))
}

fn event(rate: &Value) -> Value {
    json!({
        "id": rate["id"], "channelId": rate["channelId"],
        "zoneName": rate["zoneName"], "name": rate["name"],
    })
}

async fn rates<C: ConnectionTrait>(db: &C, channel_id: &str) -> Result<Vec<Value>, DbErr> {
    rate_rows()
        .filter(commerce_shipping_rates::Column::ChannelId.eq(channel_id))
        .filter(commerce_shipping_rates::Column::DeletedAt.is_null())
        .order_by_asc(commerce_shipping_rates::Column::Position)
        .order_by_asc(commerce_shipping_rates::Column::CreatedAt)
        .order_by_asc(commerce_shipping_rates::Column::Id)
        .into_model::<Rate>()
        .all(db)
        .await?
        .iter()
        .map(json_of)
        .collect()
}

async fn find_rate<C: ConnectionTrait>(
    db: &C,
    channel_id: &str,
    rate_id: &str,
    lock: bool,
) -> Result<Option<Value>, DbErr> {
    let mut found = rate_rows()
        .filter(commerce_shipping_rates::Column::Id.eq(rate_id))
        .filter(commerce_shipping_rates::Column::ChannelId.eq(channel_id))
        .filter(commerce_shipping_rates::Column::DeletedAt.is_null());
    if lock {
        found = found.lock_exclusive();
    }
    found
        .into_model::<Rate>()
        .one(db)
        .await?
        .as_ref()
        .map(json_of)
        .transpose()
}

/// The channel, locked, when it is a storefront (the only channel with rates).
async fn storefront<C: ConnectionTrait>(db: &C, channel_id: &str) -> Result<Value, Refusal> {
    let Some(channel) = find(db, channel_id, true).await? else {
        return Err(Refusal::not_found("Channel", channel_id));
    };
    if channel["type"] != "storefront" {
        return Err(conflict(
            "SHIPPING_NOT_SUPPORTED",
            "Only storefront channels have shipping rates",
            None,
        ));
    }
    Ok(channel)
}

async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to list shipping rates";
    let result = async {
        let db = orm(&caller.db);
        if find(&db, &id, false).await?.is_none() {
            return Err(Refusal::not_found("Channel", &id));
        }
        Ok(rates(&db, &id).await?)
    }
    .await;
    match result {
        Ok(rows) => Data(rows).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

#[derive(Default)]
struct Body {
    zone_name: Option<String>,
    countries: Option<Vec<String>>,
    name: Option<String>,
    price: Option<Cents>,
    threshold: Field<Cents>,
    active: Option<bool>,
}

fn read_body(issues: &mut Issues, fields: &Map<String, Value>, creating: bool) -> Body {
    let presence = if creating {
        Presence::Required
    } else {
        Presence::Optional
    };
    Body {
        zone_name: issues
            .text_with(
                fields,
                "zoneName",
                presence,
                Text::trimmed(Some(1), Some(255)),
            )
            .into_option(),
        countries: read_countries(issues, fields, "countries", presence, false),
        name: issues
            .text_with(fields, "name", presence, Text::trimmed(Some(1), Some(255)))
            .into_option(),
        price: read_money(issues, fields, "price", presence).into_option(),
        threshold: read_money(issues, fields, "freeShippingThreshold", Presence::Nullish),
        active: issues
            .boolean(fields, "active", Presence::Optional)
            .into_option(),
    }
}

/// Every country is one the channel sells to (and there is at least one).
fn within(countries: &[String], selling: &[String]) -> Result<(), Refusal> {
    if countries.is_empty() {
        return Err(invalid("countries", "Name at least one country"));
    }
    for (index, country) in countries.iter().enumerate() {
        if !selling.contains(country) {
            return Err(invalid(
                &format!("countries.{index}"),
                "Not one of the channel's selling countries",
            ));
        }
    }
    Ok(())
}

fn text_of(value: &Value) -> Option<Cents> {
    value.as_str().and_then(money::parse)
}

async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create shipping rate";
    let body = match validate(&headers, &body, |issues, fields| {
        read_body(issues, fields, true)
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let mut tx = caller.db.begin().await?;
        let db = OrmConn::new(&mut tx);
        let channel = storefront(&db, &id).await?;
        let countries = body.countries.clone().unwrap_or_default();
        within(&countries, &strings(&channel["sellingCountries"]))?;
        let rate_id = generate_id("shrt");
        let stamp = utc_now();
        // `position`: after the channel's live rates.
        let next = Query::select()
            .expr(Func::coalesce([
                sea_orm::ExprTrait::add(
                    Expr::from(Func::max(Expr::col(
                        commerce_shipping_rates::Column::Position,
                    ))),
                    1,
                ),
                Expr::val(0),
            ]))
            .from(commerce_shipping_rates::Entity)
            .and_where(commerce_shipping_rates::Column::ChannelId.eq(id.as_str()))
            .and_where(commerce_shipping_rates::Column::DeletedAt.is_null())
            .to_owned();
        let insert = Query::insert()
            .into_table(commerce_shipping_rates::Entity)
            .columns([
                commerce_shipping_rates::Column::Id,
                commerce_shipping_rates::Column::ChannelId,
                commerce_shipping_rates::Column::ZoneName,
                commerce_shipping_rates::Column::Countries,
                commerce_shipping_rates::Column::Name,
                commerce_shipping_rates::Column::Price,
                commerce_shipping_rates::Column::Currency,
                commerce_shipping_rates::Column::FreeShippingThreshold,
                commerce_shipping_rates::Column::Position,
                commerce_shipping_rates::Column::Active,
                commerce_shipping_rates::Column::CreatedAt,
                commerce_shipping_rates::Column::UpdatedAt,
            ])
            .values([
                Expr::val(rate_id.as_str()),
                Expr::val(id.as_str()),
                Expr::val(body.zone_name.as_deref().unwrap_or_default()),
                Expr::val(json!(countries)),
                Expr::val(body.name.as_deref().unwrap_or_default()),
                Expr::val(decimal(body.price.unwrap_or(0))),
                Expr::val(channel["currency"].as_str().unwrap_or("EUR")),
                Expr::val(body.threshold.as_set().copied().map(decimal)),
                Expr::from(next),
                Expr::val(body.active.unwrap_or(true)),
                Expr::val(stamp),
                Expr::val(stamp),
            ])
            .map_err(|error| DbErr::Custom(error.to_string()))?
            .to_owned();
        db.execute(&insert).await?;
        let row = find_rate(&db, &id, &rate_id, false).await?;
        tx.commit().await?;
        row.ok_or_else(|| Refusal::not_found("Shipping rate", &rate_id))
    }
    .await;
    match result {
        Ok(rate) => {
            let rate_id = rate["id"].as_str().unwrap_or_default();
            caller.publish(
                &state,
                COMMERCE_SHIPPING_RATE_CREATED,
                rate_id,
                &event(&rate),
            );
            Created(json!({ "id": rate_id })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn update(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, rate_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update shipping rate";
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
        let channel = storefront(&db, &id).await?;
        let Some(current) = find_rate(&db, &id, &rate_id, true).await? else {
            return Err(Refusal::not_found("Shipping rate", &rate_id));
        };
        let countries = body
            .countries
            .clone()
            .unwrap_or_else(|| strings(&current["countries"]));
        if body.countries.is_some() {
            within(&countries, &strings(&channel["sellingCountries"]))?;
        }
        let price = body
            .price
            .or_else(|| text_of(&current["price"]))
            .unwrap_or(0);
        let threshold = match body.threshold {
            Field::Set(cents) => Some(cents),
            Field::Null => None,
            Field::Absent => text_of(&current["freeShippingThreshold"]),
        };
        commerce_shipping_rates::Entity::update_many()
            .col_expr(
                commerce_shipping_rates::Column::ZoneName,
                Expr::val(
                    body.zone_name
                        .as_deref()
                        .or_else(|| current["zoneName"].as_str())
                        .unwrap_or_default(),
                ),
            )
            .col_expr(
                commerce_shipping_rates::Column::Countries,
                Expr::val(json!(countries)),
            )
            .col_expr(
                commerce_shipping_rates::Column::Name,
                Expr::val(
                    body.name
                        .as_deref()
                        .or_else(|| current["name"].as_str())
                        .unwrap_or_default(),
                ),
            )
            .col_expr(
                commerce_shipping_rates::Column::Price,
                Expr::val(decimal(price)),
            )
            .col_expr(
                commerce_shipping_rates::Column::FreeShippingThreshold,
                Expr::val(threshold.map(decimal)),
            )
            .col_expr(
                commerce_shipping_rates::Column::Active,
                Expr::val(
                    body.active
                        .unwrap_or_else(|| current["active"].as_bool().unwrap_or(true)),
                ),
            )
            .col_expr(
                commerce_shipping_rates::Column::UpdatedAt,
                Expr::val(utc_now()),
            )
            .filter(commerce_shipping_rates::Column::Id.eq(rate_id.as_str()))
            .exec(&db)
            .await?;
        let row = find_rate(&db, &id, &rate_id, false).await?;
        tx.commit().await?;
        row.ok_or_else(|| Refusal::not_found("Shipping rate", &rate_id))
    }
    .await;
    match result {
        Ok(rate) => {
            caller.publish(
                &state,
                COMMERCE_SHIPPING_RATE_UPDATED,
                &rate_id,
                &event(&rate),
            );
            Data(rate).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, rate_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to delete shipping rate";
    let result = async {
        let mut tx = caller.db.begin().await?;
        let db = OrmConn::new(&mut tx);
        let Some(rate) = find_rate(&db, &id, &rate_id, true).await? else {
            return Err(Refusal::not_found("Shipping rate", &rate_id));
        };
        let stamp = utc_now();
        commerce_shipping_rates::Entity::update_many()
            .col_expr(commerce_shipping_rates::Column::DeletedAt, Expr::val(stamp))
            .col_expr(commerce_shipping_rates::Column::UpdatedAt, Expr::val(stamp))
            .filter(commerce_shipping_rates::Column::Id.eq(rate_id.as_str()))
            .exec(&db)
            .await?;
        tx.commit().await?;
        Ok(rate)
    }
    .await;
    match result {
        Ok(rate) => {
            caller.publish(
                &state,
                COMMERCE_SHIPPING_RATE_DELETED,
                &rate_id,
                &event(&rate),
            );
            NoContent.into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// `{ ids }`: the rates in their new order. Rates the list leaves out keep
/// their order after the listed ones.
async fn reorder(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to reorder shipping rates";
    let ids = match validate(&headers, &body, |issues, fields| {
        issues
            .list(
                fields,
                "ids",
                Presence::Required,
                None,
                Some(500),
                |issues, item| issues.item_text(item, Text::trimmed(Some(1), Some(30))),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(ids) => ids,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let mut tx = caller.db.begin().await?;
        let db = OrmConn::new(&mut tx);
        storefront(&db, &id).await?;
        let current = rates(&db, &id).await?;
        let known: Vec<&str> = current.iter().filter_map(|r| r["id"].as_str()).collect();
        for (index, rate) in ids.iter().enumerate() {
            if !known.contains(&rate.as_str()) {
                return Err(invalid(
                    &format!("ids.{index}"),
                    "Not a shipping rate of this channel",
                ));
            }
            if ids[..index].contains(rate) {
                return Err(invalid(&format!("ids.{index}"), "Listed twice"));
            }
        }
        let mut order: Vec<&str> = ids.iter().map(String::as_str).collect();
        order.extend(known.iter().filter(|rate| !ids.iter().any(|i| i == *rate)));
        let stamp = utc_now();
        let mut moved = Vec::new();
        for (position, rate) in order.iter().enumerate() {
            let before = current
                .iter()
                .find(|r| r["id"] == *rate)
                .and_then(|r| r["position"].as_i64());
            let position = i64::try_from(position).unwrap_or(0);
            if before != Some(position) {
                commerce_shipping_rates::Entity::update_many()
                    .col_expr(
                        commerce_shipping_rates::Column::Position,
                        Expr::val(position),
                    )
                    .col_expr(commerce_shipping_rates::Column::UpdatedAt, Expr::val(stamp))
                    .filter(commerce_shipping_rates::Column::Id.eq(*rate))
                    .exec(&db)
                    .await?;
                moved.push(
                    current
                        .iter()
                        .find(|r| r["id"] == *rate)
                        .map(event)
                        .unwrap_or_default(),
                );
            }
        }
        tx.commit().await?;
        Ok(moved)
    }
    .await;
    match result {
        Ok(moved) => {
            for rate in &moved {
                caller.publish(
                    &state,
                    COMMERCE_SHIPPING_RATE_UPDATED,
                    rate["id"].as_str().unwrap_or_default(),
                    rate,
                );
            }
            NoContent.into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}
