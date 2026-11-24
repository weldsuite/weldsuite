//! Labels for a packed pick list (`/pick-lists/:id/labels`).
//!
//! Making labels claims the pick list's draft parcel (`draft` →
//! `labelling`, one statement, so two people can't label the same pick
//! list; a claim older than five minutes is stale), calls the carrier once,
//! stores the files, and turns the draft into the first piece: more pieces
//! and a return label become parcels of their own. The order gets the first
//! piece's tracking number. On WeldSuite's contract the price is checked
//! before the call and charged after it. A failure gives the draft back.
//!
//! Voiding (before the pick list ships) cancels the labelled parcels, gives
//! the pick list a fresh draft parcel and refunds WeldSuite-contract labels.
//! Neither carrier voids a label; an unscanned label is not used.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use http::HeaderMap;
use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::entity::prelude::BigDecimal;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::Deserialize;
use serde_json::{Value, json};
use time::{Duration, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{PARCEL_CREATED, PARCEL_UPDATED};
use weldsuite_catalogs::permission_keys::{PARCELS_CREATE, PARCELS_READ, PARCELS_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    order_items, orders, parcels, pick_list_items, pick_lists, products, warehouses,
};
use weldsuite_shipping_domain::countries::customs_required;
use weldsuite_shipping_domain::rates::QuoteRequest;
use weldsuite_shipping_domain::{
    Address, CreatedPiece, Customs, CustomsContent, CustomsLine, LabelFormat, PieceSpec,
    ServicePointRef, ShipmentOptions, ShipmentRequest, TrackRef,
};

use super::accounts::{self, Account, Contract};
use super::addresses::{AddressInput, recipient_of, stored, warehouse_sender};
use super::parcels::{store, store_named, view};
use super::{Ctx, billing, carrier_refusal, field, read_body, tracking};
use crate::{Refusal, StashState};

/// A `labelling` claim older than this is stale (the request died).
const STALE_CLAIM_MINUTES: i64 = 5;
/// Pieces per label request.
const MAX_PIECES: usize = 25;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/{id}/shipping",
            get(defaults).route_layer(gate.require([PARCELS_READ])),
        )
        .route(
            "/{id}/labels",
            post(create).route_layer(gate.require([PARCELS_CREATE])),
        )
        .route(
            "/{id}/labels",
            delete(void).route_layer(gate.require([PARCELS_UPDATE])),
        )
}

fn outbound_pieces(id: &str) -> Condition {
    Condition::all()
        .add(parcels::Column::PickListId.eq(id))
        .add(parcels::Column::CarrierCode.is_not_null())
        .add(parcels::Column::DeletedAt.is_null())
        .add(
            Condition::any()
                .add(parcels::Column::IsReturn.is_null())
                .add(parcels::Column::IsReturn.eq(false)),
        )
}

/// The labelled pieces besides `first` that ship with the pick list.
pub(crate) async fn extra_pieces(
    db: &PgPool,
    id: &str,
    first: Option<&str>,
) -> Result<Vec<String>, DbErr> {
    let mut condition = outbound_pieces(id).add(parcels::Column::Status.eq("label_created"));
    if let Some(first) = first {
        condition = condition.add(parcels::Column::Id.ne(first));
    }
    parcels::Entity::find()
        .select_only()
        .column(parcels::Column::Id)
        .filter(condition)
        .order_by_asc(parcels::Column::ColloNumber)
        .into_tuple()
        .all(&orm(db))
        .await
}

/// The labelled pieces of a shipped pick list.
pub(crate) async fn shipped_pieces(db: &PgPool, id: &str) -> Result<Vec<parcels::Model>, DbErr> {
    parcels::Entity::find()
        .filter(outbound_pieces(id).add(parcels::Column::Status.eq("shipped")))
        .order_by_asc(parcels::Column::ColloNumber)
        .all(&orm(db))
        .await
}

/// Grams as the `parcels.weight` kilograms.
pub(crate) fn kilograms(grams: u32) -> Option<BigDecimal> {
    BigDecimal::from_str(&format!("{:.3}", f64::from(grams) / 1000.0)).ok()
}

fn decimal(value: Option<&BigDecimal>) -> f64 {
    value
        .and_then(|v| v.to_string().parse::<f64>().ok())
        .unwrap_or(0.0)
}

/// A product's weight in grams per unit (`weight` in `weight_unit`).
fn grams_per_unit(product: &products::Model) -> Option<f64> {
    let weight = decimal(product.weight.as_ref());
    if weight <= 0.0 {
        return None;
    }
    let factor = match product.weight_unit.as_deref().unwrap_or("kg") {
        "g" => 1.0,
        "lb" => 453.592,
        "oz" => 28.349_5,
        _ => 1000.0,
    };
    Some(weight * factor)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn round_u32(value: f64) -> u32 {
    value.round().clamp(0.0, f64::from(u32::MAX)) as u32
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn round_u64(value: f64) -> u64 {
    value.round().clamp(0.0, 9.0e15) as u64
}

/// What a label request starts from.
struct Facts {
    list: pick_lists::Model,
    order: Option<orders::Model>,
    warehouse: Option<warehouses::Model>,
    /// The picked lines, as customs lines (and their weight).
    lines: Vec<CustomsLine>,
    /// What the picked goods weigh, when every product says.
    weight_grams: Option<u32>,
    /// The pick list's parcels.
    parcels: Vec<parcels::Model>,
}

#[allow(
    clippy::too_many_lines,
    reason = "one read after another, then the customs lines"
)]
async fn facts(db: &PgPool, id: &str) -> Result<Facts, Refusal> {
    let conn = orm(db);
    let list = pick_lists::Entity::find_by_id(id)
        .filter(pick_lists::Column::DeletedAt.is_null())
        .one(&conn)
        .await?
        .ok_or_else(|| Refusal::not_found("Pick list", id))?;
    let order_id = list
        .order_ids
        .as_ref()
        .and_then(|ids| ids.get(0))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let order = match &order_id {
        Some(order_id) => {
            orders::Entity::find_by_id(order_id.as_str())
                .one(&conn)
                .await?
        }
        None => None,
    };
    let warehouse = warehouses::Entity::find_by_id(list.warehouse_id.as_str())
        .one(&conn)
        .await?;
    let items = pick_list_items::Entity::find()
        .filter(pick_list_items::Column::PickListId.eq(id))
        .all(&conn)
        .await?;
    let order_lines: HashMap<String, order_items::Model> = match &order_id {
        Some(order_id) => order_items::Entity::find()
            .filter(order_items::Column::OrderId.eq(order_id.as_str()))
            .all(&conn)
            .await?
            .into_iter()
            .map(|line| (line.id.clone(), line))
            .collect(),
        None => HashMap::new(),
    };
    let product_ids: Vec<String> = items.iter().map(|i| i.product_id.clone()).collect();
    let products: HashMap<String, products::Model> = if product_ids.is_empty() {
        HashMap::new()
    } else {
        products::Entity::find()
            .filter(products::Column::Id.is_in(product_ids))
            .all(&conn)
            .await?
            .into_iter()
            .map(|p| (p.id.clone(), p))
            .collect()
    };
    let mut lines = Vec::new();
    let mut weight = 0.0;
    let mut weight_known = !items.is_empty();
    for item in &items {
        let quantity = item.quantity_picked.unwrap_or(0).max(0);
        if quantity == 0 {
            continue;
        }
        let quantity = u32::try_from(quantity).unwrap_or(0);
        let product = products.get(&item.product_id);
        let line = item
            .order_item_id
            .as_ref()
            .and_then(|id| order_lines.get(id));
        let unit_grams = product.and_then(grams_per_unit);
        match unit_grams {
            Some(grams) => weight += grams * f64::from(quantity),
            None => weight_known = false,
        }
        let unit_price = line
            .map(|l| decimal(Some(&l.unit_price)))
            .or_else(|| product.map(|p| decimal(Some(&p.price))))
            .unwrap_or(0.0);
        lines.push(CustomsLine {
            description: line
                .map(|l| l.name.clone())
                .or_else(|| product.map(|p| p.name.clone()))
                .unwrap_or_else(|| item.name.clone()),
            quantity,
            value_cents: round_u64(unit_price * 100.0 * f64::from(quantity)),
            weight_grams: round_u32(unit_grams.unwrap_or(0.0) * f64::from(quantity)),
            hs_code: product.and_then(|p| p.hs_code.clone()),
            origin_country: product.and_then(|p| p.origin_country.clone()),
        });
    }
    let parcels = parcels::Entity::find()
        .filter(parcels::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(parcels::Column::PickListId.eq(id))
                .add(parcels::Column::Id.eq(list.parcel_id.clone().unwrap_or_default())),
        )
        .order_by_asc(parcels::Column::CreatedAt)
        .all(&conn)
        .await?;
    Ok(Facts {
        list,
        order,
        warehouse,
        lines,
        weight_grams: (weight_known && weight > 0.0).then(|| round_u32(weight)),
        parcels,
    })
}

fn order_json(order: Option<&orders::Model>) -> Value {
    order
        .and_then(|o| serde_json::to_value(o).ok())
        .unwrap_or(Value::Null)
}

/// The sender: the account's sender address, else the warehouse.
fn sender_input(account: Option<&Account>, warehouse: Option<&warehouses::Model>) -> AddressInput {
    let configured = account
        .and_then(|a| a.settings.get("senderAddress"))
        .filter(|a| a.is_object())
        .map(AddressInput::from_json);
    match (configured, warehouse) {
        (Some(configured), Some(warehouse)) => warehouse_sender(warehouse).merged(&configured),
        (Some(configured), None) => configured,
        (None, Some(warehouse)) => warehouse_sender(warehouse),
        (None, None) => AddressInput::default(),
    }
}

/// The service point the order names (`orders.metadata.servicePoint`).
fn order_point(order: Option<&orders::Model>) -> Option<Value> {
    order
        .and_then(|o| o.metadata.as_ref())
        .and_then(|m| m.get("servicePoint"))
        .filter(|p| p.is_object())
        .cloned()
}

fn input_json(input: &AddressInput, resolved: &Address) -> Value {
    let mut value = serde_json::to_value(input).unwrap_or_else(|_| json!({}));
    value["street"] = json!(resolved.street);
    value["houseNumber"] = json!(resolved.house_number);
    value["houseNumberSuffix"] = json!(resolved.house_number_suffix);
    value["country"] = json!(resolved.country);
    value
}

/// `GET /pick-lists/:id/shipping`: what the label dialog starts from.
async fn defaults(ctx: Ctx, Path(id): Path<String>) -> Response {
    let result = async {
        let db = &ctx.caller.db;
        let facts = facts(db, &id).await?;
        let default_row = accounts::default_account(db).await?;
        let account = default_row.as_ref().and_then(|row| Account::of(row).ok());
        let recipient_input = recipient_of(&order_json(facts.order.as_ref()));
        let recipient = recipient_input.resolve();
        let sender_input = sender_input(account.as_ref(), facts.warehouse.as_ref());
        let sender = sender_input.resolve();
        let from = if sender.country.is_empty() { "NL".to_owned() } else { sender.country.clone() };
        let customs = customs_required(&from, &recipient.country, &recipient.postal_code);
        let order = facts.order.as_ref();
        Ok::<_, Refusal>(json!({
            "pickListId": facts.list.id,
            "status": facts.list.status,
            "orderId": order.map(|o| o.id.clone()),
            "orderNumber": order.map(|o| o.order_number.clone()),
            "recipient": input_json(&recipient_input, &recipient),
            "sender": input_json(&sender_input, &sender),
            "suggestedWeightGrams": facts.weight_grams,
            "customsRequired": customs,
            "customs": {
                "content": "sale_of_goods",
                "invoiceNumber": order.map(|o| o.order_number.clone()),
                "currency": order.and_then(|o| o.currency.clone()).unwrap_or_else(|| "EUR".to_owned()),
                "lines": facts.lines,
            },
            "servicePoint": order_point(order),
            "defaultCarrierId": default_row.map(|row| row.id),
            "parcels": facts.parcels.iter().map(view).collect::<Vec<_>>(),
        }))
    }
    .await;
    match result {
        Ok(value) => Data(value).into_response(),
        Err(refusal) => refusal.respond("Failed to read the pick list's shipping"),
    }
}

/// The customs part of a label request.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CustomsInput {
    content: Option<CustomsContent>,
    invoice_number: Option<String>,
    currency: Option<String>,
    lines: Option<Vec<CustomsLine>>,
    shipping_fee_cents: Option<u64>,
}

/// `POST /pick-lists/:id/labels` body.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LabelBody {
    carrier_id: Option<String>,
    product: Option<String>,
    pieces: Vec<PieceSpec>,
    options: ShipmentOptions,
    service_point: Option<ServicePointRef>,
    return_label: bool,
    recipient: Option<AddressInput>,
    sender: Option<AddressInput>,
    customs: Option<CustomsInput>,
    label_format: Option<String>,
}

/// Give the claimed draft back.
async fn release(db: &PgPool, parcel_id: &str) {
    let result = parcels::Entity::update_many()
        .col_expr(parcels::Column::Status, Expr::value("draft"))
        .col_expr(parcels::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(parcels::Column::Id.eq(parcel_id))
        .filter(parcels::Column::Status.eq("labelling"))
        .exec(&orm(db))
        .await;
    if let Err(error) = result {
        tracing::error!(%error, parcel = parcel_id, "[stash] releasing a label claim failed");
    }
}

/// Claim the draft parcel: `draft` (or a stale `labelling`) → `labelling`.
async fn claim(db: &PgPool, parcel_id: &str) -> Result<bool, DbErr> {
    let stale = utc_now() - Duration::minutes(STALE_CLAIM_MINUTES);
    let claimed = parcels::Entity::update_many()
        .col_expr(parcels::Column::Status, Expr::value("labelling"))
        .col_expr(parcels::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(parcels::Column::Id.eq(parcel_id))
        .filter(
            Condition::any()
                .add(parcels::Column::Status.eq("draft"))
                .add(
                    Condition::all()
                        .add(parcels::Column::Status.eq("labelling"))
                        .add(parcels::Column::UpdatedAt.lt(stale)),
                ),
        )
        .exec(&orm(db))
        .await?;
    Ok(claimed.rows_affected > 0)
}

/// What [`make_labels`] made.
struct Made {
    parcels: Vec<parcels::Model>,
    return_parcel: Option<parcels::Model>,
    warnings: Vec<String>,
    credits: Option<i64>,
}

async fn create(
    State(state): State<StashState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match Box::pin(make_labels(&state, &ctx, &id, &headers, &body)).await {
        Ok(made) => {
            let mut events = Vec::new();
            for (index, parcel) in made.parcels.iter().enumerate() {
                let event = if index == 0 {
                    PARCEL_UPDATED
                } else {
                    PARCEL_CREATED
                };
                events.push((event, parcel.id.clone(), view(parcel)));
            }
            if let Some(parcel) = &made.return_parcel {
                events.push((PARCEL_CREATED, parcel.id.clone(), view(parcel)));
            }
            ctx.caller.publish_in_order(&state, events);
            Created(json!({
                "pickListId": id,
                "parcels": made.parcels.iter().map(view).collect::<Vec<_>>(),
                "returnParcel": made.return_parcel.as_ref().map(view),
                "warnings": made.warnings,
                "credits": made.credits,
            }))
            .into_response()
        }
        Err(refusal) => refusal.respond("Failed to create labels"),
    }
}

#[allow(clippy::too_many_lines)] // one step after another, as the module doc lists them
async fn make_labels(
    state: &StashState,
    ctx: &Ctx,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Made, Refusal> {
    let input: LabelBody = read_body(headers, body)?;
    let db = &ctx.caller.db;
    let files = ctx
        .files
        .clone()
        .ok_or_else(|| Refusal::from(ApiError::unavailable("File storage is not configured")))?;
    let facts = facts(db, id).await?;
    if facts.list.status != "packed" {
        return Err(ApiError::new(
            http::StatusCode::BAD_REQUEST,
            "INVALID_STATUS",
            "Pack the pick list before making labels",
        )
        .into());
    }
    let draft_id = facts
        .list
        .parcel_id
        .clone()
        .ok_or_else(|| Refusal::bad_request("The pick list has no parcel; pack it again"))?;
    let account_row = match &input.carrier_id {
        Some(carrier) => accounts::load(db, carrier)
            .await?
            .ok_or_else(|| Refusal::not_found("Carrier", carrier))?,
        None => accounts::default_account(db)
            .await?
            .ok_or_else(|| Refusal::bad_request("Connect a carrier under Settings first"))?,
    };
    if account_row.is_active == Some(false) {
        return Err(Refusal::bad_request("This carrier account is switched off"));
    }
    let account = Account::of(&account_row)?;
    let http = accounts::outbound(ctx, state)?;
    let env = |name: &str| ctx.caller.env(name);
    let client = account.client(http, &ctx.keyring(), &env)?;

    // The request.
    let order = facts.order.as_ref();
    let recipient_input = recipient_of(&order_json(order));
    let recipient_input = match &input.recipient {
        Some(over) => recipient_input.merged(over),
        None => recipient_input,
    };
    let recipient = recipient_input.resolve();
    let sender_input = sender_input(Some(&account), facts.warehouse.as_ref());
    let sender_input = match &input.sender {
        Some(over) => sender_input.merged(over),
        None => sender_input,
    };
    let sender = sender_input.resolve();
    let pieces = if input.pieces.is_empty() {
        let grams = facts
            .weight_grams
            .ok_or_else(|| Refusal::bad_request("Give the weight of each piece"))?;
        vec![PieceSpec {
            weight_grams: grams,
            ..PieceSpec::default()
        }]
    } else {
        input.pieces.clone()
    };
    if pieces.len() > MAX_PIECES {
        return Err(Refusal::bad_request(format!(
            "At most {MAX_PIECES} pieces per label request"
        )));
    }
    if pieces.iter().any(|p| p.weight_grams == 0) {
        return Err(Refusal::bad_request("Every piece needs a weight"));
    }
    let customs = if customs_required(&sender.country, &recipient.country, &recipient.postal_code) {
        let given = input.customs.unwrap_or_default();
        let lines = given
            .lines
            .filter(|lines| !lines.is_empty())
            .unwrap_or_else(|| facts.lines.clone());
        if lines.is_empty() {
            return Err(Refusal::bad_request(
                "A parcel to this country needs customs lines",
            ));
        }
        Some(Customs {
            content: given.content.unwrap_or_default(),
            invoice_number: given
                .invoice_number
                .or_else(|| order.map(|o| o.order_number.clone())),
            currency: given
                .currency
                .or_else(|| order.and_then(|o| o.currency.clone()))
                .unwrap_or_else(|| "EUR".to_owned()),
            lines,
            shipping_fee_cents: given.shipping_fee_cents.or_else(|| {
                order
                    .and_then(|o| o.shipping_total.as_ref())
                    .map(|fee| round_u64(decimal(Some(fee)) * 100.0))
                    .filter(|cents| *cents > 0)
            }),
        })
    } else {
        None
    };
    let label_format = input
        .label_format
        .as_deref()
        .and_then(LabelFormat::parse)
        .unwrap_or_else(|| account.label_format());
    let reference = order.map_or_else(
        || facts.list.pick_list_number.clone(),
        |o| o.order_number.clone(),
    );
    let return_address = account
        .settings
        .get("returnAddress")
        .filter(|a| a.is_object())
        .map(|a| AddressInput::from_json(a).resolve());
    // The account's default product: `{ "<country>": "<code>" }`, or one
    // code for parcels within the sender's country.
    let domestic = sender.country == recipient.country;
    let product = input.product.clone().or_else(|| {
        account.settings.get("defaultProduct").and_then(|p| {
            field(p, recipient.country.as_str())
                .or_else(|| p.as_str().filter(|_| domestic).map(str::to_owned))
        })
    });
    let request_key = uuid::Uuid::new_v4().to_string();
    let request = ShipmentRequest {
        reference,
        sender: sender.clone(),
        recipient: recipient.clone(),
        return_address,
        product: product.clone(),
        pieces: pieces.clone(),
        options: input.options.clone(),
        service_point: input.service_point.clone(),
        return_label: input.return_label,
        customs: customs.clone(),
        label_format,
        idempotency_key: request_key.clone(),
    };

    // WeldSuite's contract: the price, and a wallet that holds it.
    let mut wallet = None;
    let mut credits = None;
    if account.contract == Contract::Weldsuite {
        let master = ctx.master.clone().ok_or_else(|| {
            Refusal::from(ApiError::unavailable("The credit wallet can't be reached"))
        })?;
        let product = product
            .clone()
            .ok_or_else(|| Refusal::bad_request("Choose a product"))?;
        let quote = billing::rate_card(&master)
            .await?
            .quote(&QuoteRequest {
                carrier: account.code.as_str(),
                product: &product,
                destination: &recipient.country,
                pieces: &pieces,
                options: &request.options,
                return_label: request.return_label,
            })
            .map_err(|missing| Refusal::bad_request(missing.message()))?;
        let workspace = billing::ensure_credits(&master, &ctx.workspace_id, quote.credits).await?;
        credits = Some(quote.credits);
        wallet = Some((master, workspace));
    }

    // The claim, the carrier, the files.
    if !claim(db, &draft_id).await? {
        return Err(ApiError::conflict(
            "This pick list has labels already, or someone is making them; void them first",
        )
        .into());
    }
    let created = match client.create_shipment(&request).await {
        Ok(created) => created,
        Err(error) => {
            release(db, &draft_id).await;
            return Err(carrier_refusal(&error));
        }
    };
    let mut warnings = created.warnings.clone();
    let now = utc_now();
    let mut ids: Vec<String> = Vec::with_capacity(created.pieces.len());
    for index in 0..created.pieces.len() {
        ids.push(if index == 0 {
            draft_id.clone()
        } else {
            generate_id("par")
        });
    }
    let mut label_stored = Vec::with_capacity(created.pieces.len());
    for (piece, parcel_id) in created.pieces.iter().zip(&ids) {
        let ok = store(ctx, files.as_ref(), parcel_id, &piece.label).await;
        if !ok {
            warnings.push(format!(
                "The label of {} could not be stored; download it from the carrier",
                piece.tracking_number
            ));
        }
        label_stored.push(ok);
    }
    let customs_stored = match &created.customs_document {
        Some(document) => {
            store_named(ctx, files.as_ref(), &draft_id, "customs.pdf", document).await
        }
        None => false,
    };

    // The parcels.
    let carrier_name = account.name.clone();
    let shipping_cost = |first: bool| {
        json!({
            "contract": account.contract.as_str(),
            "credits": if first { credits } else { None },
            "chargeKey": (first && credits.is_some()).then(|| format!("parcel-label:{request_key}")),
        })
    };
    let track = |piece: &CreatedPiece| TrackRef {
        tracking_number: piece.tracking_number.clone(),
        postal_code: recipient.postal_code.clone(),
        country: recipient.country.clone(),
    };
    let order_id = order.map(|o| o.id.clone());
    let order_number = order.map(|o| o.order_number.clone());
    let list_number = Some(facts.list.pick_list_number.clone());
    let next_check = tracking::first_check(now, false);
    let mut saved = Vec::with_capacity(created.pieces.len());
    for (index, ((piece, parcel_id), stored_label)) in created
        .pieces
        .iter()
        .zip(&ids)
        .zip(&label_stored)
        .enumerate()
    {
        let spec = pieces.get(index).copied().unwrap_or_default();
        let dimensions = match (spec.length_cm, spec.width_cm, spec.height_cm) {
            (Some(l), Some(w), Some(h)) => {
                Some(json!({ "length": l, "width": w, "height": h, "unit": "cm" }))
            }
            _ => None,
        };
        let mut row = parcels::ActiveModel {
            id: if index == 0 { Unchanged(parcel_id.clone()) } else { Set(parcel_id.clone()) },
            updated_at: Set(now),
            status: Set("label_created".to_owned()),
            tracking_number: Set(Some(piece.tracking_number.clone())),
            barcode: Set(Some(piece.tracking_number.clone())),
            carrier_reference: Set(piece.carrier_reference.clone()),
            tracking_url: Set(Some(account.code.tracking_url(&track(piece)))),
            pick_list_id: Set(Some(id.to_owned())),
            collo_number: Set(Some(i32::try_from(piece.collo_number).unwrap_or(1))),
            carrier_id: Set(Some(account.id.clone())),
            carrier_name: Set(Some(carrier_name.clone())),
            carrier_code: Set(Some(account.code.as_str().to_owned())),
            service_type: Set(Some(created.product.clone())),
            sender_name: Set(sender.name.clone()),
            sender_company: Set(sender.company.clone()),
            sender_email: Set(sender.email.clone()),
            sender_phone: Set(sender.phone.clone()),
            sender_address: Set(Some(stored(&sender))),
            recipient_name: Set(recipient.name.clone()),
            recipient_company: Set(recipient.company.clone()),
            recipient_email: Set(recipient.email.clone()),
            recipient_phone: Set(recipient.phone.clone()),
            recipient_address: Set(Some(stored(&recipient))),
            weight: Set(kilograms(spec.weight_grams)),
            weight_unit: Set(Some("kg".to_owned())),
            dimensions: Set(dimensions),
            signature_required: Set(Some(request.options.signature)),
            saturday_delivery: Set(Some(request.options.saturday_delivery)),
            insurance_amount: Set(request
                .options
                .insured_value_cents
                .map(|cents| json!({ "amountCents": cents, "currency": "EUR" }))),
            service_point: Set(request.service_point.as_ref().map(|point| {
                json!({ "id": point.id, "name": point.name, "carrier": account.code.as_str(), "address": point.address })
            })),
            label_url: Set(stored_label.then(|| format!("/api/parcels/{parcel_id}/label"))),
            label_format: Set(Some(piece.label.extension.to_owned())),
            shipping_cost: Set(Some(shipping_cost(index == 0))),
            tracking_next_check_at: Set(next_check),
            status_history: Set(Some(json!([]))),
            ..Default::default()
        };
        if index == 0 {
            row.customs_info = Set(customs.as_ref().and_then(|c| serde_json::to_value(c).ok()));
            row.customs_form_url =
                Set(customs_stored.then(|| format!("/api/parcels/{parcel_id}/customs-document")));
        } else {
            row.created_at = Set(now);
            row.order_id = Set(order_id.clone());
            row.order_number = Set(order_number.clone());
            row.reference_number = Set(list_number.clone());
            row.contents = Set(Some(format!(
                "Pick list {} ({}/{})",
                list_number.clone().unwrap_or_default(),
                index + 1,
                created.pieces.len()
            )));
        }
        let model = if index == 0 {
            row.update(&orm(db)).await?
        } else {
            row.insert(&orm(db)).await?
        };
        saved.push(model);
    }

    // The return label.
    let mut return_parcel = None;
    if let Some(piece) = &created.return_piece {
        let parcel_id = generate_id("par");
        let stored_label = store(ctx, files.as_ref(), &parcel_id, &piece.label).await;
        let merchant = request
            .return_address
            .clone()
            .unwrap_or_else(|| sender.clone());
        let row = parcels::ActiveModel {
            id: Set(parcel_id.clone()),
            created_at: Set(now),
            updated_at: Set(now),
            status: Set("label_created".to_owned()),
            tracking_number: Set(Some(piece.tracking_number.clone())),
            barcode: Set(Some(piece.tracking_number.clone())),
            carrier_reference: Set(piece.carrier_reference.clone()),
            // A return goes to the merchant: its lookup takes their postal code.
            tracking_url: Set(Some(account.code.tracking_url(&TrackRef {
                tracking_number: piece.tracking_number.clone(),
                postal_code: merchant.postal_code.clone(),
                country: merchant.country.clone(),
            }))),
            order_id: Set(order_id.clone()),
            order_number: Set(order_number.clone()),
            reference_number: Set(list_number.clone()),
            pick_list_id: Set(Some(id.to_owned())),
            is_return: Set(Some(true)),
            return_for_parcel_id: Set(Some(draft_id.clone())),
            carrier_id: Set(Some(account.id.clone())),
            carrier_name: Set(Some(carrier_name.clone())),
            carrier_code: Set(Some(account.code.as_str().to_owned())),
            service_type: Set(Some(created.product.clone())),
            sender_name: Set(recipient.name.clone()),
            sender_company: Set(recipient.company.clone()),
            sender_email: Set(recipient.email.clone()),
            sender_phone: Set(recipient.phone.clone()),
            sender_address: Set(Some(stored(&recipient))),
            recipient_name: Set(merchant.name.clone()),
            recipient_company: Set(merchant.company.clone()),
            recipient_email: Set(merchant.email.clone()),
            recipient_phone: Set(merchant.phone.clone()),
            recipient_address: Set(Some(stored(&merchant))),
            label_url: Set(stored_label.then(|| format!("/api/parcels/{parcel_id}/label"))),
            label_format: Set(Some(piece.label.extension.to_owned())),
            shipping_cost: Set(Some(json!({ "contract": account.contract.as_str() }))),
            collo_number: Set(Some(1)),
            tracking_next_check_at: Set(tracking::first_check(now, true)),
            status_history: Set(Some(json!([]))),
            ..Default::default()
        }
        .insert(&orm(db))
        .await?;
        if let Some(first) = saved.first_mut() {
            *first = parcels::ActiveModel {
                id: Unchanged(first.id.clone()),
                return_tracking_number: Set(row.tracking_number.clone()),
                return_label_url: Set(row.label_url.clone()),
                ..Default::default()
            }
            .update(&orm(db))
            .await?;
        }
        return_parcel = Some(row);
    }

    // The order shows the first piece.
    if let (Some(order), Some(first)) = (order, saved.first()) {
        orders::Entity::update_many()
            .col_expr(
                orders::Column::TrackingNumber,
                Expr::value(first.tracking_number.clone()),
            )
            .col_expr(
                orders::Column::TrackingUrl,
                Expr::value(first.tracking_url.clone()),
            )
            .col_expr(
                orders::Column::ShippingCarrier,
                Expr::value(account.code.name()),
            )
            .col_expr(orders::Column::UpdatedAt, Expr::value(now))
            .filter(orders::Column::Id.eq(order.id.as_str()))
            .exec(&orm(db))
            .await?;
    }

    if let (Some((master, workspace)), Some(credits)) = (&wallet, credits) {
        billing::charge(
            master,
            &billing::Charge {
                workspace,
                credits,
                parcel_id: &draft_id,
                idempotency_key: format!("parcel-label:{request_key}"),
                description: format!(
                    "{} labels for {}",
                    account.code.name(),
                    request.reference
                ),
                metadata: json!({
                    "carrier": account.code.as_str(),
                    "product": created.product,
                    "pieces": saved.len(),
                    "returnLabel": return_parcel.is_some(),
                    "trackingNumbers": saved.iter().map(|p| p.tracking_number.clone()).collect::<Vec<_>>(),
                }),
                user_id: Some(&ctx.caller.user_id),
            },
        )
        .await;
    }
    if let (Some(master), Some(first)) = (&ctx.master, saved.first()) {
        tracking::mark_due(master, &ctx.workspace_id, first).await;
    }
    Ok(Made {
        parcels: saved,
        return_parcel,
        warnings,
        credits,
    })
}

/// `DELETE /pick-lists/:id/labels`.
#[allow(
    clippy::too_many_lines,
    reason = "one step after another, as the module doc lists them"
)]
async fn void(State(state): State<StashState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    let fallback = "Failed to void labels";
    let result = async {
        let db = &ctx.caller.db;
        let facts = facts(db, &id).await?;
        if facts.list.status == "shipped" {
            return Err(Refusal::bad_request("Shipped parcels can't be voided"));
        }
        let labelled: Vec<&parcels::Model> = facts
            .parcels
            .iter()
            .filter(|p| p.carrier_code.is_some() && p.status == "label_created")
            .collect();
        if labelled.is_empty() {
            return Err(Refusal::bad_request("This pick list has no labels to void"));
        }
        let now = utc_now();
        let mut changed = Vec::new();
        for parcel in &labelled {
            let watch = parcel
                .shipping_cost
                .as_ref()
                .and_then(|c| c.get("contract"))
                .and_then(Value::as_str)
                == Some("weldsuite");
            let next: Option<PrimitiveDateTime> =
                tracking::next_check("cancelled", false, parcel.created_at, now, watch);
            let row = parcels::ActiveModel {
                id: Unchanged(parcel.id.clone()),
                status: Set("cancelled".to_owned()),
                tracking_next_check_at: Set(next),
                updated_at: Set(now),
                ..Default::default()
            }
            .update(&orm(db))
            .await?;
            changed.push(row);
        }
        // A fresh draft for the next labels.
        let first = labelled
            .iter()
            .find(|p| Some(p.id.as_str()) == facts.list.parcel_id.as_deref())
            .copied()
            .or_else(|| labelled.first().copied());
        let draft_id = generate_id("par");
        let draft = parcels::ActiveModel {
            id: Set(draft_id.clone()),
            created_at: Set(now),
            updated_at: Set(now),
            status: Set("draft".to_owned()),
            order_id: Set(first.and_then(|p| p.order_id.clone())),
            order_number: Set(first.and_then(|p| p.order_number.clone())),
            reference_number: Set(Some(facts.list.pick_list_number.clone())),
            contents: Set(Some(format!("Pick list {}", facts.list.pick_list_number))),
            recipient_name: Set(first.and_then(|p| p.recipient_name.clone())),
            recipient_email: Set(first.and_then(|p| p.recipient_email.clone())),
            recipient_phone: Set(first.and_then(|p| p.recipient_phone.clone())),
            recipient_address: Set(first.and_then(|p| p.recipient_address.clone())),
            pick_list_id: Set(Some(id.clone())),
            ..Default::default()
        }
        .insert(&orm(db))
        .await?;
        pick_lists::Entity::update_many()
            .col_expr(pick_lists::Column::ParcelId, Expr::value(draft_id.as_str()))
            .col_expr(pick_lists::Column::UpdatedAt, Expr::value(now))
            .filter(pick_lists::Column::Id.eq(id.as_str()))
            .exec(&orm(db))
            .await?;
        // The order no longer shows a voided tracking number.
        if let Some(order) = &facts.order
            && labelled
                .iter()
                .any(|p| p.tracking_number.is_some() && p.tracking_number == order.tracking_number)
        {
            orders::Entity::update_many()
                .col_expr(
                    orders::Column::TrackingNumber,
                    Expr::value(Option::<String>::None),
                )
                .col_expr(
                    orders::Column::TrackingUrl,
                    Expr::value(Option::<String>::None),
                )
                .col_expr(orders::Column::UpdatedAt, Expr::value(now))
                .filter(orders::Column::Id.eq(order.id.as_str()))
                .exec(&orm(db))
                .await?;
        }
        // WeldSuite's contract: the credits back.
        if let Some(master) = &ctx.master {
            for parcel in &labelled {
                let cost = parcel.shipping_cost.clone().unwrap_or(Value::Null);
                let credits = cost.get("credits").and_then(Value::as_i64).unwrap_or(0);
                let key = cost.get("chargeKey").and_then(Value::as_str);
                if credits > 0
                    && let Some(key) = key
                    && let Ok(Some(workspace)) =
                        weldsuite_core_domain::credits::resolve_internal_workspace_id(
                            master,
                            &ctx.workspace_id,
                        )
                        .await
                {
                    billing::refund(
                        master,
                        &workspace,
                        credits,
                        &parcel.id,
                        format!("{key}:refund"),
                    )
                    .await;
                }
            }
        }
        Ok::<_, Refusal>((changed, draft))
    }
    .await;
    match result {
        Ok((changed, draft)) => {
            let mut events: Vec<_> = changed
                .iter()
                .map(|row| (PARCEL_UPDATED, row.id.clone(), view(row)))
                .collect();
            events.push((PARCEL_CREATED, draft.id.clone(), view(&draft)));
            ctx.caller.publish_in_order(&state, events);
            Data(json!({ "pickListId": id, "voided": changed.len(), "parcelId": draft.id }))
                .into_response()
        }
        Err(refusal) => refusal.respond(fallback),
    }
}
