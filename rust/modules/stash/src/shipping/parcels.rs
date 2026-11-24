//! `/api/parcels`: the parcels WeldStash packed and the carriers carry, their
//! files, a tracking refresh and a return label for a sent parcel.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, HeaderValue, header};
use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{PARCEL_CREATED, PARCEL_UPDATED};
use weldsuite_catalogs::permission_keys::{PARCELS_CREATE, PARCELS_READ, PARCELS_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::PutOptions;
use weldsuite_schema::tenant::parcels;
use weldsuite_shipping_domain::{
    Address, CarrierCode, LabelFile, LabelFormat, PieceSpec, ShipmentOptions, ShipmentRequest,
};

use super::accounts::{self, Account, Contract};
use super::addresses::{AddressInput, stored};
use super::{Ctx, billing, carrier_refusal, field, read_body, tracking};
use crate::js::query_param;
use crate::{Refusal, StashState};

/// `2026-11-24T10:00:00.000Z`.
pub(crate) fn iso(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
}

/// The row as the API answers it (the entity's camelCase fields).
pub(crate) fn view(row: &parcels::Model) -> Value {
    serde_json::to_value(row).unwrap_or_else(|_| json!({ "id": row.id }))
}

/// A live parcel.
pub(crate) async fn load(db: &PgPool, id: &str) -> Result<Option<parcels::Model>, DbErr> {
    parcels::Entity::find_by_id(id)
        .filter(parcels::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PARCELS_READ]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/{id}", get(fetch).route_layer(read()))
        .route("/{id}/label", get(label).route_layer(read()))
        .route(
            "/{id}/customs-document",
            get(customs_document).route_layer(read()),
        )
        .route(
            "/{id}/refresh-tracking",
            post(refresh).route_layer(gate.require([PARCELS_UPDATE])),
        )
        .route(
            "/{id}/return-label",
            post(return_label).route_layer(gate.require([PARCELS_CREATE])),
        )
}

/// `<createdAt ISO>|<id>`: the last row of a page.
fn cursor_of(row: &parcels::Model) -> String {
    format!("{}|{}", iso(row.created_at), row.id)
}

fn parse_cursor(cursor: &str) -> Option<(PrimitiveDateTime, String)> {
    let (at, id) = cursor.split_once('|')?;
    let at = OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339).ok()?;
    Some((utc_timestamp(at), id.to_owned()))
}

async fn list(ctx: Ctx, RawQuery(query): RawQuery) -> Response {
    let param = |key: &str| {
        query_param(query.as_deref(), key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let mut filter = Condition::all().add(parcels::Column::DeletedAt.is_null());
    if let Some(status) = param("status") {
        let statuses: Vec<String> = status.split(',').map(str::to_owned).collect();
        filter = filter.add(parcels::Column::Status.is_in(statuses));
    }
    if let Some(carrier) = param("carrierId") {
        filter = filter.add(parcels::Column::CarrierId.eq(carrier));
    }
    if let Some(order) = param("orderId") {
        filter = filter.add(parcels::Column::OrderId.eq(order));
    }
    if let Some(list) = param("pickListId") {
        filter = filter.add(parcels::Column::PickListId.eq(list));
    }
    match param("isReturn").as_deref() {
        Some("true") => filter = filter.add(parcels::Column::IsReturn.eq(true)),
        Some("false") => {
            filter = filter.add(
                Condition::any()
                    .add(parcels::Column::IsReturn.is_null())
                    .add(parcels::Column::IsReturn.eq(false)),
            );
        }
        _ => {}
    }
    if param("labelled").as_deref() == Some("true") {
        filter = filter.add(parcels::Column::CarrierCode.is_not_null());
    }
    if let Some(search) = param("search") {
        let like = format!("%{}%", search.replace(['%', '_'], ""));
        filter = filter.add(
            Condition::any()
                .add(parcels::Column::TrackingNumber.ilike(like.clone()))
                .add(parcels::Column::OrderNumber.ilike(like.clone()))
                .add(parcels::Column::RecipientName.ilike(like.clone()))
                .add(parcels::Column::ReferenceNumber.ilike(like)),
        );
    }
    let limit = param("limit")
        .and_then(|l| l.parse::<u64>().ok())
        .unwrap_or(50)
        .clamp(1, 200);
    let db = orm(&ctx.caller.db);
    let total = match parcels::Entity::find()
        .filter(filter.clone())
        .count(&db)
        .await
    {
        Ok(total) => total,
        Err(error) => return crate::internal(&error, "Failed to list parcels"),
    };
    let mut page = filter;
    if let Some((at, id)) = param("cursor").as_deref().and_then(parse_cursor) {
        page = page.add(
            Condition::any().add(parcels::Column::CreatedAt.lt(at)).add(
                Condition::all()
                    .add(parcels::Column::CreatedAt.eq(at))
                    .add(parcels::Column::Id.lt(id)),
            ),
        );
    }
    let rows = parcels::Entity::find()
        .filter(page)
        .order_by_desc(parcels::Column::CreatedAt)
        .order_by_desc(parcels::Column::Id)
        .limit(limit + 1)
        .all(&db)
        .await;
    match rows {
        Ok(mut rows) => {
            let has_more = rows.len() > usize::try_from(limit).unwrap_or(usize::MAX);
            rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
            let cursor = if has_more {
                rows.last().map(cursor_of)
            } else {
                None
            };
            let views: Vec<Value> = rows.iter().map(view).collect();
            List::new(views, Pagination::new(total, has_more, cursor)).into_response()
        }
        Err(error) => crate::internal(&error, "Failed to list parcels"),
    }
}

async fn fetch(ctx: Ctx, Path(id): Path<String>) -> Response {
    match load(&ctx.caller.db, &id).await {
        Ok(Some(row)) => {
            let returns = parcels::Entity::find()
                .filter(parcels::Column::ReturnForParcelId.eq(row.id.as_str()))
                .filter(parcels::Column::DeletedAt.is_null())
                .order_by_asc(parcels::Column::CreatedAt)
                .all(&orm(&ctx.caller.db))
                .await
                .unwrap_or_default();
            let mut value = view(&row);
            value["returnParcels"] = Value::Array(returns.iter().map(view).collect());
            Data(value).into_response()
        }
        Ok(None) => Refusal::not_found("Parcel", &id).respond("Failed to fetch parcel"),
        Err(error) => crate::internal(&error, "Failed to fetch parcel"),
    }
}

/// Stream a stored file of the parcel.
async fn file(ctx: &Ctx, row: &parcels::Model, name: &str, filename: String) -> Response {
    let Some(files) = &ctx.files else {
        return ApiError::unavailable("File storage is not configured").into_response();
    };
    let key = ctx.file_key(&row.id, name);
    match files.get_boxed(&key).await {
        Ok(Some(object)) => {
            let content_type = object
                .info
                .content_type
                .unwrap_or_else(|| "application/octet-stream".to_owned());
            let mut response = Response::new(Body::from(object.bytes));
            let headers = response.headers_mut();
            if let Ok(value) = HeaderValue::from_str(&content_type) {
                headers.insert(header::CONTENT_TYPE, value);
            }
            if let Ok(value) = HeaderValue::from_str(&format!("inline; filename=\"{filename}\"")) {
                headers.insert(header::CONTENT_DISPOSITION, value);
            }
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            );
            response
        }
        Ok(None) => ApiError::not_found("File", None).into_response(),
        Err(error) => crate::internal(&error, "Failed to read the file"),
    }
}

/// `label.pdf` or `label.zpl`, by the stored format.
pub(crate) fn label_name(row: &parcels::Model) -> &'static str {
    if row.label_format.as_deref() == Some("zpl") {
        "label.zpl"
    } else {
        "label.pdf"
    }
}

async fn label(ctx: Ctx, Path(id): Path<String>) -> Response {
    match load(&ctx.caller.db, &id).await {
        Ok(Some(row)) if row.label_url.is_some() => {
            let name = label_name(&row);
            let extension = name.trim_start_matches("label.");
            let base = row
                .tracking_number
                .clone()
                .unwrap_or_else(|| row.id.clone());
            file(&ctx, &row, name, format!("{base}.{extension}")).await
        }
        Ok(Some(_)) => ApiError::not_found("Label", None).into_response(),
        Ok(None) => Refusal::not_found("Parcel", &id).respond("Failed to fetch label"),
        Err(error) => crate::internal(&error, "Failed to fetch label"),
    }
}

async fn customs_document(ctx: Ctx, Path(id): Path<String>) -> Response {
    match load(&ctx.caller.db, &id).await {
        Ok(Some(row)) if row.customs_form_url.is_some() => {
            let base = row
                .tracking_number
                .clone()
                .unwrap_or_else(|| row.id.clone());
            file(&ctx, &row, "customs.pdf", format!("{base}-customs.pdf")).await
        }
        Ok(Some(_)) => ApiError::not_found("Customs document", None).into_response(),
        Ok(None) => Refusal::not_found("Parcel", &id).respond("Failed to fetch customs document"),
        Err(error) => crate::internal(&error, "Failed to fetch customs document"),
    }
}

async fn refresh(State(state): State<StashState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    let result = async {
        let row = load(&ctx.caller.db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Parcel", &id))?;
        let code = row
            .carrier_code
            .as_deref()
            .and_then(CarrierCode::parse)
            .ok_or_else(|| Refusal::bad_request("This parcel has no carrier label"))?;
        let http = accounts::outbound(&ctx, &state)?;
        let env = |name: &str| ctx.caller.env(name);
        let client = tracking::client_for(&ctx.caller.db, &row, code, http, &ctx.keyring(), &env)
            .await?
            .ok_or_else(|| Refusal::bad_request("The parcel's carrier account is gone"))?;
        let applied = tracking::poll(&ctx.caller.db, &client, &row)
            .await
            .map_err(|error| match error {
                tracking::PollError::Carrier(error) => carrier_refusal(&error),
                tracking::PollError::Database(error) => Refusal::Database(error),
            })?;
        Ok::<_, Refusal>(applied)
    }
    .await;
    match result {
        Ok(applied) => {
            tracking::publish(&ctx.caller.events, &state.events, &applied);
            if let Some(master) = &ctx.master {
                tracking::reschedule(master, &ctx.caller.db, &ctx.workspace_id).await;
            }
            Data(view(&applied.row)).into_response()
        }
        Err(refusal) => refusal.respond("Failed to refresh tracking"),
    }
}

/// `POST /parcels/:id/return-label` body.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ReturnBody {
    weight_grams: Option<u32>,
    label_format: Option<String>,
}

/// A stored party of a parcel as an address: the JSON address and the
/// name, company, email and phone columns.
pub(crate) fn party(
    address: Option<&Value>,
    name: Option<&String>,
    company: Option<&String>,
    email: Option<&String>,
    phone: Option<&String>,
) -> Address {
    let mut input = address.map(AddressInput::from_json).unwrap_or_default();
    input = input.merged(&AddressInput {
        name: name.cloned(),
        company: company.cloned(),
        email: email.cloned(),
        phone: phone.cloned(),
        ..AddressInput::default()
    });
    input.resolve()
}

async fn return_label(
    State(state): State<StashState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let fallback = "Failed to create the return label";
    let result = make_return(&state, &ctx, &id, &headers, &body).await;
    match result {
        Ok(row) => {
            let shown = view(&row);
            ctx.caller.publish(&state, PARCEL_CREATED, &row.id, &shown);
            ctx.caller.publish(
                &state,
                PARCEL_UPDATED,
                &id,
                &json!({ "id": id, "returnTrackingNumber": row.tracking_number }),
            );
            Created(shown).into_response()
        }
        Err(refusal) => refusal.respond(fallback),
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "one step after another: the parties, the price, the label, the rows"
)]
async fn make_return(
    state: &StashState,
    ctx: &Ctx,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<parcels::Model, Refusal> {
    let input: ReturnBody = read_body(headers, body)?;
    let db = &ctx.caller.db;
    let outbound = load(db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Parcel", id))?;
    if outbound.is_return == Some(true) {
        return Err(Refusal::bad_request("This parcel is a return already"));
    }
    if matches!(
        outbound.status.as_str(),
        "draft" | "labelling" | "cancelled"
    ) {
        return Err(Refusal::bad_request(
            "Only a labelled parcel can get a return label",
        ));
    }
    let carrier_id = outbound
        .carrier_id
        .clone()
        .ok_or_else(|| Refusal::bad_request("This parcel has no carrier"))?;
    let row = accounts::load(db, &carrier_id)
        .await?
        .ok_or_else(|| Refusal::bad_request("The parcel's carrier account is gone"))?;
    let account = Account::of(&row)?;
    let files = ctx
        .files
        .clone()
        .ok_or_else(|| Refusal::from(ApiError::unavailable("File storage is not configured")))?;
    let customer = party(
        outbound.recipient_address.as_ref(),
        outbound.recipient_name.as_ref(),
        outbound.recipient_company.as_ref(),
        outbound.recipient_email.as_ref(),
        outbound.recipient_phone.as_ref(),
    );
    let merchant = match account
        .settings
        .get("returnAddress")
        .filter(|a| a.is_object())
    {
        Some(address) => AddressInput::from_json(address).resolve(),
        None => party(
            outbound.sender_address.as_ref(),
            outbound.sender_name.as_ref(),
            outbound.sender_company.as_ref(),
            outbound.sender_email.as_ref(),
            outbound.sender_phone.as_ref(),
        ),
    };
    let weight = input.weight_grams.unwrap_or_else(|| {
        outbound
            .weight
            .as_ref()
            .and_then(|kg| kg.to_string().parse::<f64>().ok())
            .map_or(1000, |kg| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let grams = (kg * 1000.0).round().clamp(1.0, 1_000_000.0) as u32;
                grams
            })
    });
    let format = input
        .label_format
        .as_deref()
        .and_then(LabelFormat::parse)
        .unwrap_or_else(|| account.label_format());
    let request = ShipmentRequest {
        reference: outbound
            .order_number
            .clone()
            .or_else(|| outbound.reference_number.clone())
            .unwrap_or_else(|| outbound.id.clone()),
        sender: customer.clone(),
        recipient: merchant.clone(),
        return_address: None,
        product: None,
        pieces: vec![PieceSpec {
            weight_grams: weight.max(1),
            ..PieceSpec::default()
        }],
        options: ShipmentOptions::default(),
        service_point: None,
        return_label: false,
        customs: None,
        label_format: format,
        idempotency_key: uuid::Uuid::new_v4().to_string(),
    };
    // WeldSuite's contract: the rate card's return-label price.
    let mut wallet = None;
    let mut credits = 0;
    if account.contract == Contract::Weldsuite {
        let master = ctx.master.clone().ok_or_else(|| {
            Refusal::from(ApiError::unavailable("The credit wallet can't be reached"))
        })?;
        let card = billing::rate_card(&master).await?;
        credits = card
            .carriers
            .get(account.code.as_str())
            .and_then(|rates| rates.surcharges.return_label)
            .filter(|c| *c > 0)
            .ok_or_else(|| {
                Refusal::bad_request("Return labels are not offered on WeldSuite's contract")
            })?;
        wallet = Some((
            master.clone(),
            billing::ensure_credits(&master, &ctx.workspace_id, credits).await?,
        ));
    }
    let http = accounts::outbound(ctx, state)?;
    let env = |name: &str| ctx.caller.env(name);
    let client = account.client(http, &ctx.keyring(), &env)?;
    let created = client
        .create_return(&request)
        .await
        .map_err(|error| carrier_refusal(&error))?;
    let piece = created
        .pieces
        .into_iter()
        .next()
        .ok_or_else(|| Refusal::from(ApiError::bad_gateway()))?;
    let parcel_id = generate_id("par");
    let stored_label = store(ctx, files.as_ref(), &parcel_id, &piece.label).await;
    let now = utc_now();
    let track = weldsuite_shipping_domain::TrackRef {
        tracking_number: piece.tracking_number.clone(),
        postal_code: customer.postal_code.clone(),
        country: customer.country.clone(),
    };
    let row = parcels::ActiveModel {
        id: Set(parcel_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        status: Set("label_created".to_owned()),
        tracking_number: Set(Some(piece.tracking_number.clone())),
        barcode: Set(Some(piece.tracking_number.clone())),
        carrier_reference: Set(piece.carrier_reference.clone()),
        tracking_url: Set(Some(account.code.tracking_url(&track))),
        order_id: Set(outbound.order_id.clone()),
        order_number: Set(outbound.order_number.clone()),
        reference_number: Set(outbound.reference_number.clone()),
        pick_list_id: Set(outbound.pick_list_id.clone()),
        is_return: Set(Some(true)),
        return_for_parcel_id: Set(Some(outbound.id.clone())),
        carrier_id: Set(Some(account.id.clone())),
        carrier_name: Set(Some(account.name.clone())),
        carrier_code: Set(Some(account.code.as_str().to_owned())),
        service_type: Set(Some(created.product.clone())),
        sender_name: Set(customer.name.clone()),
        sender_company: Set(customer.company.clone()),
        sender_email: Set(customer.email.clone()),
        sender_phone: Set(customer.phone.clone()),
        sender_address: Set(Some(stored(&customer))),
        recipient_name: Set(merchant.name.clone()),
        recipient_company: Set(merchant.company.clone()),
        recipient_email: Set(merchant.email.clone()),
        recipient_phone: Set(merchant.phone.clone()),
        recipient_address: Set(Some(stored(&merchant))),
        weight: Set(super::labels::kilograms(weight)),
        weight_unit: Set(Some("kg".to_owned())),
        label_url: Set(stored_label.then(|| format!("/api/parcels/{parcel_id}/label"))),
        label_format: Set(Some(piece.label.extension.to_owned())),
        shipping_cost: Set(Some(json!({ "contract": account.contract.as_str(), "credits": (credits > 0).then_some(credits) }))),
        collo_number: Set(Some(1)),
        tracking_next_check_at: Set(tracking::first_check(now, true)),
        status_history: Set(Some(json!([]))),
        ..Default::default()
    }
    .insert(&orm(db))
    .await?;
    parcels::ActiveModel {
        id: Unchanged(outbound.id.clone()),
        return_tracking_number: Set(Some(piece.tracking_number.clone())),
        return_label_url: Set(row.label_url.clone()),
        updated_at: Set(now),
        ..Default::default()
    }
    .update(&orm(db))
    .await?;
    if let Some((master, workspace)) = &wallet {
        billing::charge(
            master,
            &billing::Charge {
                workspace,
                credits,
                parcel_id: &parcel_id,
                idempotency_key: format!("parcel-return:{parcel_id}"),
                description: format!("{} return label", account.code.name()),
                metadata: json!({ "carrier": account.code.as_str(), "trackingNumber": piece.tracking_number }),
                user_id: Some(&ctx.caller.user_id),
            },
        )
        .await;
    }
    if let Some(master) = &ctx.master {
        tracking::mark_due(master, &ctx.workspace_id, &row).await;
    }
    Ok(row)
}

/// Store a carrier file for a parcel; `false` (logged) when it fails.
pub(crate) async fn store(
    ctx: &Ctx,
    files: &dyn weldsuite_ports::DynFileStore,
    parcel_id: &str,
    file: &LabelFile,
) -> bool {
    store_named(
        ctx,
        files,
        parcel_id,
        &format!("label.{}", file.extension),
        file,
    )
    .await
}

pub(crate) async fn store_named(
    ctx: &Ctx,
    files: &dyn weldsuite_ports::DynFileStore,
    parcel_id: &str,
    name: &str,
    file: &LabelFile,
) -> bool {
    let key = ctx.file_key(parcel_id, name);
    let options = PutOptions::content_type(file.content_type);
    match files.put_boxed(&key, file.bytes.clone(), &options).await {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, parcel = parcel_id, "[stash] storing a carrier file failed");
            false
        }
    }
}

/// The recipient's postal code and country, for a tracking lookup.
pub(crate) fn postal_code_of(row: &parcels::Model) -> String {
    row.recipient_address
        .as_ref()
        .and_then(|a| field(a, "postalCode"))
        .unwrap_or_default()
}

pub(crate) fn country_of(row: &parcels::Model) -> String {
    row.recipient_address
        .as_ref()
        .and_then(|a| field(a, "country"))
        .unwrap_or_default()
}
