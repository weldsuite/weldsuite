//! Carrier accounts (`carriers` rows; ADR STASH-012) and what they answer:
//! the catalog, products, service points, the credential test, a quote.
//!
//! - `integration_type` is `own` (the workspace's contract, credentials in
//!   `api_credentials`, secret fields sealed with the workspace keyring and
//!   never returned) or `weldsuite` (WeldSuite's contract from the install's
//!   environment, paid in credits). Older rows say `manual` and are listed.
//! - `settings`: `{ sandbox, labelFormat, defaultProduct, senderAddress,
//!   returnAddress }`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PARCEL_CARRIER_CREATED, PARCEL_CARRIER_DELETED, PARCEL_CARRIER_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    CARRIERS_CREATE, CARRIERS_DELETE, CARRIERS_READ, CARRIERS_UPDATE,
};
use weldsuite_connect_domain::connections::encrypt_credentials;
use weldsuite_connect_domain::crypto::maybe_decrypt_field;
use weldsuite_db::{Keyring, PgPool, orm, utc_now};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::carriers;
use weldsuite_shipping_domain::rates::{QuoteRequest, RateCard};
use weldsuite_shipping_domain::{
    CarrierClient, CarrierCode, Credentials, LabelFormat, PieceSpec, PointQuery, ShipmentOptions,
    catalog, dhl_parcel_nl, postnl,
};

use super::{Ctx, billing, carrier_refusal, field, read_body};
use crate::js::query_param;
use crate::{Refusal, StashState};

/// Whose contract an account ships on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Contract {
    Own,
    Weldsuite,
}

impl Contract {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Own => "own",
            Self::Weldsuite => "weldsuite",
        }
    }
}

/// A usable carrier account.
#[derive(Debug, Clone)]
pub(crate) struct Account {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) code: CarrierCode,
    pub(crate) contract: Contract,
    pub(crate) settings: Value,
    credentials: Option<Value>,
}

impl Account {
    /// A row that can ship: a known carrier, own or WeldSuite's contract.
    pub(crate) fn of(row: &carriers::Model) -> Result<Self, Refusal> {
        let code = CarrierCode::parse(&row.code).ok_or_else(|| {
            Refusal::bad_request(format!("Carrier {} has no connector", row.name))
        })?;
        let contract = match row.integration_type.as_str() {
            "own" => Contract::Own,
            "weldsuite" => Contract::Weldsuite,
            _ => {
                return Err(Refusal::bad_request(format!(
                    "Carrier {} is not connected to {}",
                    row.name,
                    code.name()
                )));
            }
        };
        Ok(Self {
            id: row.id.clone(),
            name: row.name.clone(),
            code,
            contract,
            settings: row.settings.clone().unwrap_or_else(|| json!({})),
            credentials: row.api_credentials.clone(),
        })
    }

    pub(crate) fn label_format(&self) -> LabelFormat {
        self.settings
            .get("labelFormat")
            .and_then(Value::as_str)
            .and_then(LabelFormat::parse)
            .unwrap_or_default()
    }

    fn sandbox(&self) -> bool {
        self.settings
            .get("sandbox")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// The account's credentials: decrypted own ones, or WeldSuite's.
    pub(crate) fn credentials(
        &self,
        keyring: &Keyring,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Credentials, Refusal> {
        if self.contract == Contract::Weldsuite {
            return Credentials::weldsuite(self.code, env).ok_or_else(|| {
                ApiError::unavailable(format!(
                    "{} on WeldSuite's contract is not available on this install",
                    self.code.name()
                ))
                .into()
            });
        }
        let stored = self.credentials.clone().unwrap_or(Value::Null);
        let read = |key: &str| field(&stored, key).unwrap_or_default();
        let secret = |key: &str| {
            field(&stored, key)
                .map(|sealed| maybe_decrypt_field(&sealed, keyring))
                .unwrap_or_default()
        };
        let credentials = match self.code {
            CarrierCode::PostNl => Credentials::PostNl(postnl::Credentials {
                api_key: secret("apiKey"),
                customer_code: read("customerCode"),
                customer_number: read("customerNumber"),
                collection_location: field(&stored, "collectionLocation"),
                sandbox: self.sandbox(),
            }),
            CarrierCode::DhlParcelNl => Credentials::DhlParcelNl(dhl_parcel_nl::Credentials {
                user_id: read("userId"),
                api_key: secret("apiKey"),
                account_id: read("accountId"),
                sandbox: self.sandbox(),
            }),
        };
        Ok(credentials)
    }

    pub(crate) fn client(
        &self,
        http: OutboundHttp,
        keyring: &Keyring,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<CarrierClient, Refusal> {
        Ok(CarrierClient::new(self.credentials(keyring, env)?, http))
    }
}

/// The carrier HTTP client, or 503 without one.
pub(crate) fn outbound(ctx: &Ctx, state: &StashState) -> Result<OutboundHttp, Refusal> {
    ctx.caller
        .http(state)
        .ok_or_else(|| ApiError::unavailable("Carriers can't be reached from this install").into())
}

/// A live account row.
pub(crate) async fn load(db: &PgPool, id: &str) -> Result<Option<carriers::Model>, DbErr> {
    carriers::Entity::find_by_id(id)
        .filter(carriers::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

/// The default account (or the oldest active one).
pub(crate) async fn default_account(db: &PgPool) -> Result<Option<carriers::Model>, DbErr> {
    let rows = carriers::Entity::find()
        .filter(carriers::Column::DeletedAt.is_null())
        .filter(carriers::Column::IntegrationType.is_in(["own", "weldsuite"]))
        .filter(
            Condition::any()
                .add(carriers::Column::IsActive.is_null())
                .add(carriers::Column::IsActive.eq(true)),
        )
        .order_by_desc(carriers::Column::IsDefault)
        .order_by_asc(carriers::Column::CreatedAt)
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().next())
}

/// The account as the API answers it: no secret, the last four characters
/// of each secret field.
pub(crate) fn view(row: &carriers::Model, keyring: &Keyring) -> Value {
    let code = CarrierCode::parse(&row.code);
    let fields = code
        .and_then(|code| catalog().into_iter().find(|c| c.code == code))
        .map(|info| info.credential_fields)
        .unwrap_or_default();
    let stored = row.api_credentials.clone().unwrap_or(Value::Null);
    let mut credentials = Map::new();
    for credential in &fields {
        let Some(value) = field(&stored, credential.key) else {
            continue;
        };
        let shown = if credential.secret {
            let plain = maybe_decrypt_field(&value, keyring);
            let tail: String = plain
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            format!("••••{tail}")
        } else {
            value
        };
        credentials.insert(credential.key.to_owned(), json!(shown));
    }
    json!({
        "id": row.id,
        "name": row.name,
        "code": row.code,
        "carrierName": code.map(CarrierCode::name),
        "contract": row.integration_type,
        "isDefault": row.is_default.unwrap_or(false),
        "isActive": row.is_active.unwrap_or(true),
        "accountNumber": row.account_number,
        "settings": row.settings.clone().unwrap_or_else(|| json!({})),
        "credentials": credentials,
        "hasCredentials": !credentials.is_empty(),
        "createdAt": crate::shipping::parcels::iso(row.created_at),
        "updatedAt": crate::shipping::parcels::iso(row.updated_at),
    })
}

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([CARRIERS_READ]);
    Router::new()
        .route("/catalog", get(catalog_route).route_layer(read()))
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([CARRIERS_CREATE])),
        )
        .route("/{id}", get(fetch).route_layer(read()))
        .route(
            "/{id}",
            patch(update).route_layer(gate.require([CARRIERS_UPDATE])),
        )
        .route(
            "/{id}",
            delete(remove).route_layer(gate.require([CARRIERS_DELETE])),
        )
        .route("/{id}/test", post(test).route_layer(read()))
        .route("/{id}/products", get(products).route_layer(read()))
        .route(
            "/{id}/service-points",
            get(service_points).route_layer(read()),
        )
        .route("/{id}/quote", post(quote).route_layer(read()))
}

/// Whether `code` is offered on WeldSuite's contract here: the install has
/// its credentials and the rate card prices it.
fn weldsuite_offered(ctx: &Ctx, card: &RateCard, code: CarrierCode) -> bool {
    let env = |name: &str| ctx.caller.env(name);
    Credentials::weldsuite(code, env).is_some() && card.offers(code.as_str())
}

async fn card(ctx: &Ctx) -> RateCard {
    match &ctx.master {
        Some(master) => billing::rate_card(master).await.unwrap_or_else(|error| {
            tracing::warn!(%error, "[stash] rate card");
            RateCard::default()
        }),
        None => RateCard::default(),
    }
}

async fn catalog_route(ctx: Ctx) -> Response {
    let card = card(&ctx).await;
    let carriers: Vec<Value> = catalog()
        .into_iter()
        .map(|info| {
            let offered = weldsuite_offered(&ctx, &card, info.code);
            let mut value = serde_json::to_value(&info).unwrap_or_else(|_| json!({}));
            value["weldsuiteContract"] = json!(offered);
            value
        })
        .collect();
    Data(carriers).into_response()
}

async fn list(ctx: Ctx) -> Response {
    let result = carriers::Entity::find()
        .filter(carriers::Column::DeletedAt.is_null())
        .order_by_desc(carriers::Column::IsDefault)
        .order_by_asc(carriers::Column::Name)
        .all(&orm(&ctx.caller.db))
        .await;
    match result {
        Ok(rows) => {
            let keyring = ctx.keyring();
            let views: Vec<Value> = rows.iter().map(|row| view(row, &keyring)).collect();
            Data(views).into_response()
        }
        Err(error) => crate::internal(&error, "Failed to list carriers"),
    }
}

async fn fetch(ctx: Ctx, Path(id): Path<String>) -> Response {
    match load(&ctx.caller.db, &id).await {
        Ok(Some(row)) => Data(view(&row, &ctx.keyring())).into_response(),
        Ok(None) => Refusal::not_found("Carrier", &id).respond("Failed to fetch carrier"),
        Err(error) => crate::internal(&error, "Failed to fetch carrier"),
    }
}

/// `POST /carriers` and `PATCH /carriers/:id` bodies.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AccountBody {
    code: Option<String>,
    name: Option<String>,
    contract: Option<String>,
    credentials: Option<Map<String, Value>>,
    settings: Option<Map<String, Value>>,
    is_default: Option<bool>,
    is_active: Option<bool>,
    /// Save without testing the credentials first.
    skip_test: bool,
}

/// The stored credentials: the catalog's fields only, secret ones sealed;
/// a secret left out (or masked) keeps the stored one.
fn credentials_to_store(
    code: CarrierCode,
    given: &Map<String, Value>,
    stored: Option<&Value>,
    keyring: &Keyring,
) -> Result<Map<String, Value>, Refusal> {
    let info = catalog()
        .into_iter()
        .find(|c| c.code == code)
        .ok_or_else(|| Refusal::bad_request("Unknown carrier"))?;
    let mut plain = Map::new();
    let mut secrets = Map::new();
    let mut out = Map::new();
    for credential in &info.credential_fields {
        let given_value = given
            .get(credential.key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty() && !v.starts_with("••••"));
        match (given_value, stored.and_then(|s| s.get(credential.key))) {
            (Some(value), _) if credential.secret => {
                secrets.insert(credential.key.to_owned(), json!(value));
            }
            (Some(value), _) => {
                plain.insert(credential.key.to_owned(), json!(value));
            }
            (None, Some(kept)) if !kept.is_null() => {
                out.insert(credential.key.to_owned(), kept.clone());
            }
            (None, _) if credential.required => {
                return Err(Refusal::bad_request(format!(
                    "{} needs {}",
                    code.name(),
                    credential.key
                )));
            }
            (None, _) => {}
        }
    }
    let sealed = encrypt_credentials(&secrets, keyring).map_err(|error| {
        tracing::error!(%error, "[stash] sealing carrier credentials");
        Refusal::from(ApiError::internal())
    })?;
    out.extend(plain);
    out.extend(sealed);
    Ok(out)
}

/// The account number shown in lists: PostNL's customer number, DHL's
/// account id.
fn account_number(code: CarrierCode, credentials: &Map<String, Value>) -> Option<String> {
    let key = match code {
        CarrierCode::PostNl => "customerNumber",
        CarrierCode::DhlParcelNl => "accountId",
    };
    credentials
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|v| !v.is_empty())
}

fn clean_settings(settings: &Map<String, Value>) -> Result<Value, Refusal> {
    let mut out = Map::new();
    for (key, value) in settings {
        match key.as_str() {
            "sandbox" => {
                out.insert(key.clone(), json!(value.as_bool().unwrap_or(false)));
            }
            "labelFormat" => {
                let format = value.as_str().and_then(LabelFormat::parse).ok_or_else(|| {
                    Refusal::bad_request("labelFormat must be pdf_a6, pdf_a4 or zpl")
                })?;
                out.insert(key.clone(), json!(format.as_str()));
            }
            "defaultProduct" | "customsDefaultContent" => {
                out.insert(key.clone(), value.clone());
            }
            "senderAddress" | "returnAddress" | "defaultOptions" => {
                if !(value.is_object() || value.is_null()) {
                    return Err(Refusal::bad_request(format!("{key} must be an object")));
                }
                out.insert(key.clone(), value.clone());
            }
            _ => {}
        }
    }
    Ok(Value::Object(out))
}

/// Make `id` the only default account.
async fn make_default(db: &PgPool, id: &str) -> Result<(), DbErr> {
    carriers::Entity::update_many()
        .col_expr(carriers::Column::IsDefault, Expr::value(false))
        .filter(carriers::Column::Id.ne(id))
        .filter(carriers::Column::IsDefault.eq(true))
        .exec(&orm(db))
        .await?;
    Ok(())
}

async fn verify(ctx: &Ctx, state: &StashState, row: &carriers::Model) -> Result<(), Refusal> {
    let account = Account::of(row)?;
    let http = outbound(ctx, state)?;
    let env = |name: &str| ctx.caller.env(name);
    let client = account.client(http, &ctx.keyring(), &env)?;
    client
        .verify()
        .await
        .map_err(|error| carrier_refusal(&error))
}

async fn create(
    State(state): State<StashState>,
    ctx: Ctx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let fallback = "Failed to connect carrier";
    match create_account(&state, &ctx, &headers, &body).await {
        Ok(row) => {
            let shown = view(&row, &ctx.keyring());
            ctx.caller
                .publish(&state, PARCEL_CARRIER_CREATED, &row.id, &shown);
            Created(shown).into_response()
        }
        Err(refusal) => refusal.respond(fallback),
    }
}

async fn create_account(
    state: &StashState,
    ctx: &Ctx,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<carriers::Model, Refusal> {
    let input: AccountBody = read_body(headers, body)?;
    let code = input
        .code
        .as_deref()
        .and_then(CarrierCode::parse)
        .ok_or_else(|| Refusal::bad_request("code must be postnl or dhl_parcel_nl"))?;
    let contract = match input.contract.as_deref().unwrap_or("own") {
        "own" => Contract::Own,
        "weldsuite" => Contract::Weldsuite,
        _ => return Err(Refusal::bad_request("contract must be own or weldsuite")),
    };
    let keyring = ctx.keyring();
    let credentials = match contract {
        Contract::Own => Some(credentials_to_store(
            code,
            &input.credentials.unwrap_or_default(),
            None,
            &keyring,
        )?),
        Contract::Weldsuite => {
            if !weldsuite_offered(ctx, &card(ctx).await, code) {
                return Err(Refusal::bad_request(format!(
                    "{} is not offered on WeldSuite's contract",
                    code.name()
                )));
            }
            None
        }
    };
    let settings = clean_settings(&input.settings.unwrap_or_default())?;
    let db = &ctx.caller.db;
    let first = default_account(db).await?.is_none();
    let is_default = input.is_default.unwrap_or(first);
    let now = utc_now();
    let name = input
        .name
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| match contract {
            Contract::Own => code.name().to_owned(),
            Contract::Weldsuite => format!("{} (WeldSuite)", code.name()),
        });
    let row = carriers::Model {
        id: generate_id("car"),
        created_at: now,
        updated_at: now,
        deleted_at: None,
        name,
        code: code.as_str().to_owned(),
        logo: None,
        website: catalog()
            .into_iter()
            .find(|c| c.code == code)
            .map(|c| c.website.to_owned()),
        is_active: Some(input.is_active.unwrap_or(true)),
        is_default: Some(is_default),
        integration_type: contract.as_str().to_owned(),
        account_number: credentials.as_ref().and_then(|c| account_number(code, c)),
        api_credentials: credentials.map(Value::Object),
        supported_services: None,
        supported_countries: None,
        features: None,
        tracking_url_template: None,
        support_email: None,
        support_phone: None,
        settings: Some(settings),
        description: None,
    };
    if !input.skip_test {
        verify(ctx, state, &row).await?;
    }
    let active: carriers::ActiveModel = row.into();
    let saved = carriers::Entity::insert(active)
        .exec_with_returning(&orm(db))
        .await?;
    if is_default {
        make_default(db, &saved.id).await?;
    }
    Ok(saved)
}

async fn update(
    State(state): State<StashState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let fallback = "Failed to update carrier";
    let result = async {
        let input: AccountBody = read_body(&headers, &body)?;
        let db = &ctx.caller.db;
        let row = load(db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Carrier", &id))?;
        let mut next = row.clone();
        if let Some(name) = input
            .name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
        {
            next.name = name;
        }
        if let Some(settings) = &input.settings {
            let mut merged = row
                .settings
                .clone()
                .and_then(|s| s.as_object().cloned())
                .unwrap_or_default();
            if let Value::Object(cleaned) = clean_settings(settings)? {
                merged.extend(cleaned);
            }
            next.settings = Some(Value::Object(merged));
        }
        if let Some(active) = input.is_active {
            next.is_active = Some(active);
        }
        if let Some(default) = input.is_default {
            next.is_default = Some(default);
        }
        let mut retest = input
            .settings
            .as_ref()
            .is_some_and(|s| s.contains_key("sandbox"));
        if let Some(given) = &input.credentials
            && next.integration_type == "own"
            && let Some(code) = CarrierCode::parse(&next.code)
        {
            let stored =
                credentials_to_store(code, given, next.api_credentials.as_ref(), &ctx.keyring())?;
            next.account_number = account_number(code, &stored);
            next.api_credentials = Some(Value::Object(stored));
            retest = true;
        }
        if retest && !input.skip_test {
            verify(&ctx, &state, &next).await?;
        }
        next.updated_at = utc_now();
        let active = carriers::ActiveModel {
            id: Unchanged(next.id.clone()),
            name: Set(next.name.clone()),
            settings: Set(next.settings.clone()),
            is_active: Set(next.is_active),
            is_default: Set(next.is_default),
            api_credentials: Set(next.api_credentials.clone()),
            account_number: Set(next.account_number.clone()),
            updated_at: Set(next.updated_at),
            ..Default::default()
        };
        let saved = active.update(&orm(db)).await?;
        if saved.is_default == Some(true) {
            make_default(db, &saved.id).await?;
        }
        Ok::<_, Refusal>(saved)
    }
    .await;
    match result {
        Ok(row) => {
            let shown = view(&row, &ctx.keyring());
            ctx.caller
                .publish(&state, PARCEL_CARRIER_UPDATED, &row.id, &shown);
            Data(shown).into_response()
        }
        Err(refusal) => refusal.respond(fallback),
    }
}

async fn remove(State(state): State<StashState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    let fallback = "Failed to delete carrier";
    let db = &ctx.caller.db;
    let result = async {
        let row = load(db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Carrier", &id))?;
        let now = utc_now();
        carriers::ActiveModel {
            id: Unchanged(row.id.clone()),
            deleted_at: Set(Some(now)),
            is_active: Set(Some(false)),
            is_default: Set(Some(false)),
            updated_at: Set(now),
            ..Default::default()
        }
        .update(&orm(db))
        .await?;
        Ok::<_, Refusal>(row)
    }
    .await;
    match result {
        Ok(row) => {
            ctx.caller.publish(
                &state,
                PARCEL_CARRIER_DELETED,
                &row.id,
                &json!({ "id": row.id, "name": row.name, "code": row.code }),
            );
            NoContent.into_response()
        }
        Err(refusal) => refusal.respond(fallback),
    }
}

async fn account(ctx: &Ctx, id: &str) -> Result<(carriers::Model, Account), Refusal> {
    let row = load(&ctx.caller.db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Carrier", id))?;
    let account = Account::of(&row)?;
    Ok((row, account))
}

async fn test(State(state): State<StashState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    let result = async {
        let (row, _) = account(&ctx, &id).await?;
        verify(&ctx, &state, &row).await
    }
    .await;
    match result {
        Ok(()) => Data(json!({ "ok": true })).into_response(),
        Err(refusal) => refusal.respond("Failed to test carrier"),
    }
}

/// The sender's country: the account's sender address, else NL.
fn origin(account: &Account) -> String {
    account
        .settings
        .get("senderAddress")
        .and_then(|a| field(a, "country"))
        .map_or_else(|| "NL".to_owned(), |c| c.to_ascii_uppercase())
}

async fn products(
    State(state): State<StashState>,
    ctx: Ctx,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let result = async {
        let (_, account) = account(&ctx, &id).await?;
        let to = query_param(query.as_deref(), "toCountry")
            .unwrap_or_else(|| "NL".to_owned())
            .to_ascii_uppercase();
        let from = query_param(query.as_deref(), "fromCountry")
            .map_or_else(|| origin(&account), |c| c.to_ascii_uppercase());
        let business = query_param(query.as_deref(), "business").is_some_and(|b| b == "true");
        let http = outbound(&ctx, &state)?;
        let env = |name: &str| ctx.caller.env(name);
        let client = account.client(http, &ctx.keyring(), &env)?;
        let mut products = client
            .products(&from, &to, business)
            .await
            .map_err(|error| carrier_refusal(&error))?;
        if account.contract == Contract::Weldsuite {
            let priced = card(&ctx).await.products_to(account.code.as_str(), &to);
            products.retain(|p| priced.contains(&p.code));
        }
        Ok::<_, Refusal>(products)
    }
    .await;
    match result {
        Ok(products) => Data(products).into_response(),
        Err(refusal) => refusal.respond("Failed to list carrier products"),
    }
}

async fn service_points(
    State(state): State<StashState>,
    ctx: Ctx,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let result = async {
        let (_, account) = account(&ctx, &id).await?;
        let param = |key: &str| query_param(query.as_deref(), key);
        let postal_code =
            param("postalCode").ok_or_else(|| Refusal::bad_request("postalCode is required"))?;
        let limit = param("limit")
            .and_then(|l| l.parse::<u32>().ok())
            .unwrap_or(10);
        let http = outbound(&ctx, &state)?;
        let env = |name: &str| ctx.caller.env(name);
        let client = account.client(http, &ctx.keyring(), &env)?;
        client
            .service_points(&PointQuery {
                country: param("country").unwrap_or_else(|| "NL".to_owned()),
                postal_code,
                house_number: param("houseNumber"),
                city: param("city"),
                limit,
            })
            .await
            .map_err(|error| carrier_refusal(&error))
    }
    .await;
    match result {
        Ok(points) => Data(points).into_response(),
        Err(refusal) => refusal.respond("Failed to find service points"),
    }
}

/// `POST /carriers/:id/quote` body.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct QuoteBody {
    product: Option<String>,
    to_country: Option<String>,
    pieces: Vec<PieceSpec>,
    options: ShipmentOptions,
    return_label: bool,
}

async fn quote(ctx: Ctx, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let result = async {
        let (_, account) = account(&ctx, &id).await?;
        let input: QuoteBody = read_body(&headers, &body)?;
        if account.contract == Contract::Own {
            return Ok(json!({ "contract": "own", "credits": null, "lines": [] }));
        }
        let product = input
            .product
            .ok_or_else(|| Refusal::bad_request("product is required"))?;
        let to = input.to_country.unwrap_or_else(|| "NL".to_owned());
        let pieces = if input.pieces.is_empty() {
            vec![PieceSpec::default()]
        } else {
            input.pieces
        };
        let quote = card(&ctx)
            .await
            .quote(&QuoteRequest {
                carrier: account.code.as_str(),
                product: &product,
                destination: &to,
                pieces: &pieces,
                options: &input.options,
                return_label: input.return_label,
            })
            .map_err(|missing| Refusal::bad_request(missing.message()))?;
        Ok::<_, Refusal>(
            json!({ "contract": "weldsuite", "credits": quote.credits, "lines": quote.lines }),
        )
    }
    .await;
    match result {
        Ok(value) => Data(value).into_response(),
        Err(refusal) => refusal.respond("Failed to quote"),
    }
}
