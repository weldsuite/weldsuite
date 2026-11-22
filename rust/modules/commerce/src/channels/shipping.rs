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
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Postgres, Transaction};
use weldsuite_catalogs::entity_events::{
    COMMERCE_SHIPPING_RATE_CREATED, COMMERCE_SHIPPING_RATE_DELETED, COMMERCE_SHIPPING_RATE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    COMMERCE_CHANNELS_CREATE, COMMERCE_CHANNELS_DELETE, COMMERCE_CHANNELS_READ,
    COMMERCE_CHANNELS_UPDATE,
};
use weldsuite_commerce_domain::money::{self, Cents};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::{conflict, find, read_countries, strings};
use crate::wire::{body_or_empty, invalid, read_money};
use crate::{Caller, CommerceState, Refusal, now, validate};

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

const SELECT: &str = "select jsonb_build_object('id', r.id, 'channelId', r.channel_id, \
       'zoneName', r.zone_name, 'countries', r.countries, 'name', r.name, \
       'price', r.price::text, 'currency', r.currency, \
       'freeShippingThreshold', r.free_shipping_threshold::text, \
       'position', r.position, 'active', r.active) from commerce_shipping_rates r";

fn event(rate: &Value) -> Value {
    json!({
        "id": rate["id"], "channelId": rate["channelId"],
        "zoneName": rate["zoneName"], "name": rate["name"],
    })
}

async fn rates(conn: &mut PgConnection, channel_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{SELECT} where r.channel_id = $1 and r.deleted_at is null \
         order by r.position asc, r.created_at asc, r.id asc"
    )))
    .bind(channel_id)
    .fetch_all(&mut *conn)
    .await
}

async fn find_rate(
    conn: &mut PgConnection,
    channel_id: &str,
    rate_id: &str,
    lock: bool,
) -> Result<Option<Value>, sqlx::Error> {
    let tail = if lock { " for update of r" } else { "" };
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{SELECT} where r.id = $1 and r.channel_id = $2 and r.deleted_at is null{tail}"
    )))
    .bind(rate_id)
    .bind(channel_id)
    .fetch_optional(&mut *conn)
    .await
}

/// The channel, locked, when it is a storefront (the only channel with rates).
async fn storefront(
    tx: &mut Transaction<'_, Postgres>,
    channel_id: &str,
) -> Result<Value, Refusal> {
    let Some(channel) = find(tx, channel_id, true).await? else {
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
        let mut conn = caller.db.acquire().await?;
        if find(&mut conn, &id, false).await?.is_none() {
            return Err(Refusal::not_found("Channel", &id));
        }
        Ok(rates(&mut conn, &id).await?)
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
        let channel = storefront(&mut tx, &id).await?;
        let countries = body.countries.clone().unwrap_or_default();
        within(&countries, &strings(&channel["sellingCountries"]))?;
        let rate_id = generate_id("shrt");
        let stamp = now();
        sqlx::query(
            "insert into commerce_shipping_rates (id, channel_id, zone_name, countries, name, \
               price, currency, free_shipping_threshold, position, active, created_at, updated_at) \
             values ($1, $2, $3, $4::jsonb, $5, $6::numeric, $7, $8::numeric, \
               (select coalesce(max(position) + 1, 0) from commerce_shipping_rates \
                 where channel_id = $2 and deleted_at is null), \
               $9, $10::timestamp, $10::timestamp)",
        )
        .bind(&rate_id)
        .bind(&id)
        .bind(body.zone_name.as_deref().unwrap_or_default())
        .bind(json!(countries))
        .bind(body.name.as_deref().unwrap_or_default())
        .bind(money::format(body.price.unwrap_or(0)))
        .bind(channel["currency"].as_str().unwrap_or("EUR"))
        .bind(body.threshold.as_set().copied().map(money::format))
        .bind(body.active.unwrap_or(true))
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
        let row = find_rate(&mut tx, &id, &rate_id, false).await?;
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
        let channel = storefront(&mut tx, &id).await?;
        let Some(current) = find_rate(&mut tx, &id, &rate_id, true).await? else {
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
        sqlx::query(
            "update commerce_shipping_rates set zone_name = $2, countries = $3::jsonb, name = $4, \
               price = $5::numeric, free_shipping_threshold = $6::numeric, active = $7, \
               updated_at = $8::timestamp where id = $1",
        )
        .bind(&rate_id)
        .bind(
            body.zone_name
                .as_deref()
                .or_else(|| current["zoneName"].as_str())
                .unwrap_or_default(),
        )
        .bind(json!(countries))
        .bind(
            body.name
                .as_deref()
                .or_else(|| current["name"].as_str())
                .unwrap_or_default(),
        )
        .bind(money::format(price))
        .bind(threshold.map(money::format))
        .bind(
            body.active
                .unwrap_or_else(|| current["active"].as_bool().unwrap_or(true)),
        )
        .bind(now())
        .execute(&mut *tx)
        .await?;
        let row = find_rate(&mut tx, &id, &rate_id, false).await?;
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
        let Some(rate) = find_rate(&mut tx, &id, &rate_id, true).await? else {
            return Err(Refusal::not_found("Shipping rate", &rate_id));
        };
        let stamp = now();
        sqlx::query(
            "update commerce_shipping_rates set deleted_at = $2::timestamp, \
               updated_at = $2::timestamp where id = $1",
        )
        .bind(&rate_id)
        .bind(&stamp)
        .execute(&mut *tx)
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
        storefront(&mut tx, &id).await?;
        let current = rates(&mut tx, &id).await?;
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
        let stamp = now();
        let mut moved = Vec::new();
        for (position, rate) in order.iter().enumerate() {
            let before = current
                .iter()
                .find(|r| r["id"] == *rate)
                .and_then(|r| r["position"].as_i64());
            let position = i64::try_from(position).unwrap_or(0);
            if before != Some(position) {
                sqlx::query(
                    "update commerce_shipping_rates set position = $2, updated_at = $3::timestamp \
                     where id = $1",
                )
                .bind(rate)
                .bind(position)
                .bind(&stamp)
                .execute(&mut *tx)
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
