//! `/api/commerce-settings`: the order number prefix, the next number and
//! the default currency. The row is created with its defaults on first read;
//! `nextOrderNumber` only goes up (409 `SEQUENCE_BACKWARDS` with the current
//! number in `details.current`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::COMMERCE_SETTINGS_UPDATED;
use weldsuite_catalogs::permission_keys::{COMMERCE_SETTINGS_READ, COMMERCE_SETTINGS_UPDATE};
use weldsuite_commerce_domain::numbering::{self, Change, Settings};
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::wire::{body_or_empty, read_currency, refuse};
use crate::{Caller, CommerceState, Refusal, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/",
        get(read)
            .route_layer(gate.require([COMMERCE_SETTINGS_READ]))
            .patch(update)
            .route_layer(gate.require([COMMERCE_SETTINGS_UPDATE])),
    )
}

fn present(settings: &Settings) -> Value {
    json!({
        "orderNumberPrefix": settings.order_number_prefix,
        "nextOrderNumber": settings.next_order_number,
        "defaultCurrency": settings.default_currency,
    })
}

async fn read(caller: Caller) -> Response {
    const FAILED: &str = "Failed to fetch commerce settings";
    let result = async {
        let mut tx = caller.db.begin().await?;
        let settings = numbering::load_or_create(&mut tx).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(settings)
    }
    .await;
    match result {
        Ok(settings) => Data(present(&settings)).into_response(),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

async fn update(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update commerce settings";
    let (headers, body) = body_or_empty(&headers, &body);
    let change = match validate(&headers, &body, |issues, fields| Change {
        order_number_prefix: issues
            .text_with(
                fields,
                "orderNumberPrefix",
                Presence::Optional,
                Text::trimmed(None, Some(20)),
            )
            .into_option(),
        next_order_number: issues
            .whole_number(
                fields,
                "nextOrderNumber",
                Presence::Optional,
                Number {
                    min: Some(1.0),
                    max: Some(9_007_199_254_740_991.0),
                    ..Number::default()
                },
            )
            .into_option(),
        default_currency: read_currency(issues, fields, Presence::Optional).into_option(),
    }) {
        Ok(change) => change,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let mut tx = caller.db.begin().await?;
        let settings = numbering::update(&mut tx, &change).await.map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(settings)
    }
    .await;
    match result {
        Ok(settings) => {
            caller.publish(
                &state,
                COMMERCE_SETTINGS_UPDATED,
                &settings.id,
                &present(&settings),
            );
            Data(present(&settings)).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}
