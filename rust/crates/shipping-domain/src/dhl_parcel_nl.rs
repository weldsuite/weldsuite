//! DHL Parcel NL/BE (DHL eCommerce Benelux), `api-gw.dhlparcel.nl`.
//!
//! - Auth: `POST /authenticate/api-key` (`userId` + `key`) gives a bearer
//!   token for about 15 minutes and the account numbers; cached per client.
//! - Labels: `POST /shipments` makes one shipment with every piece (and,
//!   with option `ADD_RETURN_LABEL`, a return shipment), then each label is
//!   fetched as PDF or ZPL from `GET /labels/{labelId}` and the customs
//!   document from `GET /customs/declarations/{id}/documents`.
//! - Products: `GET /capabilities/business` (no auth) lists product, parcel
//!   type and options per route; the adapter picks the parcel type per piece.
//! - Tracking: `GET /track-trace?key={tracker}+{postcode}` (no auth).
//! - Service points: `GET /parcel-shop-locations/{country}` (no auth).
//!
//! Research: `weldsuite-documentation/plans/weldstash-carriers-research/dhl-parcel-nl.md`.

use std::sync::Mutex;

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use crate::error::CarrierError;
use crate::http::{self, amount, kilograms, list, query, text};
use crate::types::{
    Address, CreatedPiece, CreatedShipment, Customs, CustomsContent, LabelFile, LabelFormat,
    OpeningHours, ParcelStatus, PieceSpec, PointQuery, Product, ServicePoint, ShipmentRequest,
    TrackRef, Tracking, TrackingEvent,
};

const PRODUCTION: &str = "https://api-gw.dhlparcel.nl";
const ACCEPTANCE: &str = "https://api-gw-accept.dhlparcel.nl";
/// Renew the token this long before DHL says it expires.
const TOKEN_MARGIN_SECONDS: i64 = 60;
/// DHL's `REFERENCE` option takes at most 35 characters.
const MAX_REFERENCE: usize = 35;

/// What a DHL Parcel NL account needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub user_id: String,
    pub api_key: String,
    /// One of the key's account numbers; empty takes the first.
    pub account_id: String,
    /// The acceptance environment.
    pub sandbox: bool,
}

/// The client for one account.
pub struct DhlParcelNl {
    http: OutboundHttp,
    base: String,
    credentials: Credentials,
    /// `(token, account id, expires at unix seconds)`.
    token: Mutex<Option<(String, String, i64)>>,
}

impl std::fmt::Debug for DhlParcelNl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DhlParcelNl")
            .field("base", &self.base)
            .field("user_id", &self.credentials.user_id)
            .finish_non_exhaustive()
    }
}

/// One line of `/capabilities/business`: a product with one parcel type.
#[derive(Debug, Clone, PartialEq)]
struct Capability {
    rank: i64,
    product: String,
    label: String,
    mono_collo: bool,
    return_product: bool,
    parcel_type: String,
    max_kg: f64,
    max_cm: [Option<f64>; 3],
    options: Vec<String>,
}

/// DHL option keys and the names the API and the platform use.
const OPTION_NAMES: &[(&str, &str)] = &[
    ("HANDT", "signature"),
    ("AGE_CHECK", "ageCheck"),
    ("NBB", "noNeighbour"),
    ("EVE", "eveningDelivery"),
    ("S", "saturdayDelivery"),
    ("INS", "insurance"),
    ("BP", "mailbox"),
    ("PS", "servicePoint"),
    ("ADD_RETURN_LABEL", "returnLabel"),
];

fn option_name(key: &str) -> Option<&'static str> {
    OPTION_NAMES
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, name)| *name)
}

impl DhlParcelNl {
    pub fn new(credentials: Credentials, http: OutboundHttp) -> Self {
        let base = if credentials.sandbox {
            ACCEPTANCE
        } else {
            PRODUCTION
        };
        Self::with_base(credentials, http, base)
    }

    /// A client against another host (tests).
    pub fn with_base(credentials: Credentials, http: OutboundHttp, base: &str) -> Self {
        Self {
            http,
            base: base.trim_end_matches('/').to_owned(),
            credentials,
            token: Mutex::new(None),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// A valid bearer token and the account id, authenticating when needed.
    async fn token(&self) -> Result<(String, String), CarrierError> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        if let Ok(cached) = self.token.lock()
            && let Some((token, account, expires)) = cached.as_ref()
            && *expires - TOKEN_MARGIN_SECONDS > now
        {
            return Ok((token.clone(), account.clone()));
        }
        let request = HttpRequest::json(
            "POST",
            self.url("/authenticate/api-key"),
            &json!({ "userId": self.credentials.user_id, "key": self.credentials.api_key }),
        )
        .header("accept", "application/json");
        let response = http::send(&self.http, request).await?;
        if response.status == 400 || response.status == 401 || response.status == 403 {
            return Err(CarrierError::Unauthorized(
                "DHL Parcel refused the user id or API key".to_owned(),
            ));
        }
        if !response.ok() {
            return Err(error_of(&response));
        }
        let body = response.json();
        let token = text(&body, "accessToken").ok_or_else(|| {
            CarrierError::unavailable("DHL Parcel answered the sign-in without a token")
        })?;
        let expires = body
            .get("accessTokenExpiration")
            .and_then(Value::as_i64)
            .unwrap_or(now + 600);
        let accounts: Vec<String> = list(body.get("accountNumbers"))
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let wanted = self.credentials.account_id.trim();
        let account = if wanted.is_empty() {
            accounts.first().cloned().ok_or_else(|| {
                CarrierError::Unauthorized("This DHL Parcel API key has no account".to_owned())
            })?
        } else if accounts.is_empty() || accounts.iter().any(|a| a == wanted) {
            wanted.to_owned()
        } else {
            return Err(CarrierError::Unauthorized(format!(
                "Account {wanted} is not one of this API key's accounts ({})",
                accounts.join(", ")
            )));
        };
        if let Ok(mut cached) = self.token.lock() {
            *cached = Some((token.clone(), account.clone(), expires));
        }
        Ok((token, account))
    }

    /// The credentials work and name an account of the key.
    pub async fn verify(&self) -> Result<(), CarrierError> {
        self.token().await.map(|_| ())
    }

    async fn capabilities(
        &self,
        from: &str,
        to: &str,
        business: bool,
        returns: bool,
    ) -> Result<Vec<Capability>, CarrierError> {
        let mut pairs = vec![
            ("fromCountry", from.to_owned()),
            ("toCountry", to.to_owned()),
            ("toBusiness", business.to_string()),
        ];
        if returns {
            pairs.push(("returnProduct", "true".to_owned()));
        }
        if !self.credentials.account_id.trim().is_empty() {
            pairs.push((
                "accountNumber",
                self.credentials.account_id.trim().to_owned(),
            ));
        }
        let pairs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let url = self.url(&format!("/capabilities/business?{}", query(&pairs)));
        let request = HttpRequest::empty("GET", url).header("accept", "application/json");
        let response = http::send_read(&self.http, request).await?;
        if !response.ok() {
            return Err(error_of(&response));
        }
        Ok(parse_capabilities(&response.json()))
    }

    /// The products DHL offers on this route, best first.
    pub async fn products(
        &self,
        from: &str,
        to: &str,
        business: bool,
    ) -> Result<Vec<Product>, CarrierError> {
        let capabilities = self.capabilities(from, to, business, false).await?;
        Ok(products_of(&capabilities))
    }

    /// Labels for every piece of `request` (and its return label).
    pub async fn create_shipment(
        &self,
        request: &ShipmentRequest,
    ) -> Result<CreatedShipment, CarrierError> {
        check_request(request)?;
        let capabilities = self
            .capabilities(
                &request.sender.country,
                &request.recipient.country,
                request.recipient.is_business(),
                false,
            )
            .await?;
        let plan = plan(request, &capabilities)?;
        let (token, account) = self.token().await?;
        let body = shipment_body(request, &plan, &account, false);
        let created = self.post_shipment(&token, &body).await?;
        self.collect(&token, request.label_format, &created, &plan.product)
            .await
    }

    /// A return label on its own: `request.sender` is the customer sending
    /// it back, `request.recipient` the merchant.
    pub async fn create_return(
        &self,
        request: &ShipmentRequest,
    ) -> Result<CreatedShipment, CarrierError> {
        check_request(request)?;
        let capabilities = self
            .capabilities(
                &request.sender.country,
                &request.recipient.country,
                request.recipient.is_business(),
                true,
            )
            .await?;
        let plan = plan(request, &capabilities)?;
        let (token, account) = self.token().await?;
        let body = shipment_body(request, &plan, &account, true);
        let created = self.post_shipment(&token, &body).await?;
        self.collect(&token, request.label_format, &created, &plan.product)
            .await
    }

    async fn post_shipment(&self, token: &str, body: &Value) -> Result<Value, CarrierError> {
        let request = HttpRequest::json("POST", self.url("/shipments"), body)
            .header("accept", "application/json")
            .header("authorization", format!("Bearer {token}"));
        let response = http::send(&self.http, request).await?;
        match response.status {
            200 | 201 => Ok(response.json()),
            401 | 403 => Err(CarrierError::Unauthorized(
                "DHL Parcel refused the API key for making labels".to_owned(),
            )),
            409 => Err(CarrierError::Rejected(vec![
                "DHL Parcel already has a shipment for this request".to_owned(),
            ])),
            _ => Err(error_of(&response)),
        }
    }

    /// One label file.
    pub async fn label(
        &self,
        label_id: &str,
        format: LabelFormat,
    ) -> Result<LabelFile, CarrierError> {
        let (token, _) = self.token().await?;
        self.fetch_label(&token, label_id, format).await
    }

    async fn fetch_label(
        &self,
        token: &str,
        label_id: &str,
        format: LabelFormat,
    ) -> Result<LabelFile, CarrierError> {
        let accept = if format.is_pdf() {
            "application/pdf"
        } else {
            "application/zpl"
        };
        let request = HttpRequest::empty("GET", self.url(&format!("/labels/{label_id}")))
            .header("accept", accept)
            .header("authorization", format!("Bearer {token}"));
        let response = http::send_read(&self.http, request).await?;
        if !response.ok() || response.body.is_empty() {
            return Err(error_of(&response));
        }
        Ok(LabelFile::of(format, response.body))
    }

    async fn customs_document(&self, token: &str, id: &str) -> Result<LabelFile, CarrierError> {
        let request = HttpRequest::empty(
            "GET",
            self.url(&format!("/customs/declarations/{id}/documents")),
        )
        .header("accept", "application/pdf")
        .header("authorization", format!("Bearer {token}"));
        let response = http::send_read(&self.http, request).await?;
        if !response.ok() || response.body.is_empty() {
            return Err(error_of(&response));
        }
        Ok(LabelFile::pdf(response.body))
    }

    /// The labels (and customs document) of an answered `POST /shipments`.
    async fn collect(
        &self,
        token: &str,
        format: LabelFormat,
        created: &Value,
        planned_product: &str,
    ) -> Result<CreatedShipment, CarrierError> {
        let mut pieces = Vec::new();
        for (index, piece) in list(created.get("pieces")).into_iter().enumerate() {
            pieces.push(self.created_piece(token, format, piece, index).await?);
        }
        if pieces.is_empty() {
            return Err(CarrierError::unavailable(
                "DHL Parcel made the shipment but answered no pieces",
            ));
        }
        let mut warnings = Vec::new();
        let return_piece = match created
            .get("returnShipment")
            .map(|r| list(r.get("pieces")))
            .and_then(|pieces| pieces.into_iter().next())
        {
            Some(piece) => match self.created_piece(token, format, piece, 0).await {
                Ok(piece) => Some(piece),
                Err(error) => {
                    warnings.push(format!(
                        "The return label could not be fetched: {}",
                        error.message()
                    ));
                    None
                }
            },
            None => None,
        };
        let customs_document = match text(created, "customsDeclarationId") {
            Some(id) => match self.customs_document(token, &id).await {
                Ok(file) => Some(file),
                Err(error) => {
                    warnings.push(format!(
                        "The customs document could not be fetched: {}",
                        error.message()
                    ));
                    None
                }
            },
            None => None,
        };
        Ok(CreatedShipment {
            product: text(created, "product").unwrap_or_else(|| planned_product.to_owned()),
            pieces,
            return_piece,
            customs_document,
            warnings,
        })
    }

    async fn created_piece(
        &self,
        token: &str,
        format: LabelFormat,
        piece: &Value,
        index: usize,
    ) -> Result<CreatedPiece, CarrierError> {
        let label_id = text(piece, "labelId").ok_or_else(|| {
            CarrierError::unavailable("DHL Parcel answered a piece without a label id")
        })?;
        let tracker = text(piece, "trackerCode").ok_or_else(|| {
            CarrierError::unavailable("DHL Parcel answered a piece without a tracker code")
        })?;
        let label = self.fetch_label(token, &label_id, format).await?;
        let collo_number = piece
            .get("pieceNumber")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or_else(|| u32::try_from(index + 1).unwrap_or(1));
        Ok(CreatedPiece {
            collo_number,
            tracking_number: tracker,
            carrier_reference: Some(label_id),
            label,
        })
    }

    /// The piece's status and events; `None` when DHL doesn't know it yet.
    pub async fn track(&self, piece: &TrackRef) -> Result<Option<Tracking>, CarrierError> {
        let key = format!("{}+{}", piece.tracking_number, piece_postal(piece));
        let url = self.url(&format!("/track-trace?{}", query(&[("key", &key)])));
        let request = HttpRequest::empty("GET", url).header("accept", "application/json");
        let response = http::send_read(&self.http, request).await?;
        if response.status == 404 {
            return Ok(None);
        }
        if !response.ok() {
            return Err(error_of(&response));
        }
        let body = response.json();
        let pieces = list(Some(&body));
        let found = pieces
            .iter()
            .find(|p| {
                text(p, "barcode").is_some_and(|b| b.eq_ignore_ascii_case(&piece.tracking_number))
            })
            .or_else(|| pieces.first())
            .copied();
        Ok(found.map(parse_tracking))
    }

    /// Pickup points near a postal code.
    pub async fn service_points(&self, q: &PointQuery) -> Result<Vec<ServicePoint>, CarrierError> {
        let limit = q.limit.clamp(1, 50).to_string();
        let postal = crate::types::compact_postal_code(&q.postal_code);
        let country = q.country.trim().to_ascii_uppercase();
        let url = self.url(&format!(
            "/parcel-shop-locations/{country}?{}",
            query(&[
                ("postalCode", &postal),
                ("houseNumber", q.house_number.as_deref().unwrap_or("")),
                ("city", q.city.as_deref().unwrap_or("")),
                ("limit", &limit),
            ])
        ));
        let request = HttpRequest::empty("GET", url).header("accept", "application/json");
        let response = http::send_read(&self.http, request).await?;
        if !response.ok() {
            return Err(error_of(&response));
        }
        Ok(list(Some(&response.json()))
            .into_iter()
            .filter_map(parse_point)
            .collect())
    }
}

fn piece_postal(piece: &TrackRef) -> String {
    crate::types::compact_postal_code(&piece.postal_code)
}

/// The public track-and-trace page.
pub fn tracking_url(piece: &TrackRef) -> String {
    let postal = piece_postal(piece);
    if piece.country.eq_ignore_ascii_case("BE") {
        return format!(
            "https://my.dhlparcel.be/go-track-trace?{}",
            query(&[("tt", &piece.tracking_number), ("pc", &postal)])
        );
    }
    format!(
        "https://my.dhlecommerce.nl/home/tracktrace/{}/{}",
        piece.tracking_number, postal
    )
}

/// What a label request needs before anything is sent.
fn check_request(request: &ShipmentRequest) -> Result<(), CarrierError> {
    if request.pieces.is_empty() {
        return Err(CarrierError::invalid("A shipment needs at least one piece"));
    }
    for (side, address) in [
        ("sender", &request.sender),
        ("recipient", &request.recipient),
    ] {
        if address.street.trim().is_empty()
            || address.postal_code.trim().is_empty()
            || address.city.trim().is_empty()
            || address.country.trim().is_empty()
        {
            return Err(CarrierError::invalid(format!(
                "The {side}'s address needs a street, postal code, city and country"
            )));
        }
        let benelux =
            ["NL", "BE", "LU", "DE"].contains(&address.country.to_ascii_uppercase().as_str());
        if benelux && address.house_number.trim().is_empty() {
            return Err(CarrierError::invalid(format!(
                "The {side}'s address needs a house number"
            )));
        }
        if address.name.as_deref().unwrap_or("").trim().is_empty() && !address.is_business() {
            return Err(CarrierError::invalid(format!(
                "The {side} needs a name or a company name"
            )));
        }
    }
    if !request.recipient.is_business()
        && request
            .recipient
            .email
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return Err(CarrierError::invalid(
            "DHL Parcel needs the recipient's email address for a delivery to a consumer",
        ));
    }
    Ok(())
}

/// The product, a parcel type per piece and the options to send.
#[derive(Debug, Clone, PartialEq)]
struct Plan {
    product: String,
    parcel_types: Vec<String>,
    options: Vec<Value>,
}

fn plan(request: &ShipmentRequest, capabilities: &[Capability]) -> Result<Plan, CarrierError> {
    let to = request.recipient.country.to_ascii_uppercase();
    if capabilities.is_empty() {
        return Err(CarrierError::not_supported(format!(
            "DHL Parcel offers no product from {} to {to} on this account",
            request.sender.country.to_ascii_uppercase()
        )));
    }
    let mut products: Vec<&str> = Vec::new();
    let mut sorted: Vec<&Capability> = capabilities.iter().collect();
    sorted.sort_by_key(|c| c.rank);
    for capability in &sorted {
        if !products.contains(&capability.product.as_str()) {
            products.push(&capability.product);
        }
    }
    let multi = request.pieces.len() > 1;
    let wanted: Vec<&str> = match request.product.as_deref() {
        Some(code) => {
            if !products.contains(&code) {
                return Err(CarrierError::not_supported(format!(
                    "DHL Parcel doesn't offer product {code} to {to} on this account"
                )));
            }
            vec![code]
        }
        None => products,
    };
    let needed = needed_options(request);
    let mut last_error = None;
    for product in wanted {
        let lines: Vec<&Capability> = sorted
            .iter()
            .copied()
            .filter(|c| c.product == product)
            .collect();
        if multi && lines.iter().all(|c| c.mono_collo) {
            last_error = Some(CarrierError::not_supported(format!(
                "DHL Parcel product {product} takes one piece per shipment"
            )));
            continue;
        }
        let offered: Vec<&str> = lines
            .iter()
            .flat_map(|c| c.options.iter().map(String::as_str))
            .collect();
        if let Some(missing) = needed.iter().find(|key| !offered.contains(key)) {
            last_error = Some(CarrierError::not_supported(format!(
                "DHL Parcel product {product} doesn't offer {} to {to}",
                option_name(missing).unwrap_or(missing)
            )));
            continue;
        }
        let parcel_types: Vec<String> = request
            .pieces
            .iter()
            .map_while(|piece| parcel_type(&lines, piece))
            .collect();
        if let Some(piece) = request.pieces.get(parcel_types.len()) {
            last_error = Some(CarrierError::invalid(format!(
                "A {} g piece doesn't fit any DHL Parcel parcel type of product {product}",
                piece.weight_grams
            )));
            continue;
        }
        return Ok(Plan {
            product: product.to_owned(),
            parcel_types,
            options: option_values(request),
        });
    }
    Err(last_error.unwrap_or_else(|| {
        CarrierError::not_supported(format!(
            "DHL Parcel offers no product for this shipment to {to}"
        ))
    }))
}

/// The DHL option keys the request asks for.
fn needed_options(request: &ShipmentRequest) -> Vec<&'static str> {
    let options = &request.options;
    let mut keys = Vec::new();
    if request.service_point.is_some() {
        keys.push("PS");
    } else if options.mailbox {
        keys.push("BP");
    }
    for (wanted, key) in [
        (options.signature, "HANDT"),
        (options.age_check, "AGE_CHECK"),
        (options.no_neighbour, "NBB"),
        (options.evening_delivery, "EVE"),
        (options.saturday_delivery, "S"),
        (options.insured_value_cents.is_some_and(|v| v > 0), "INS"),
        (request.return_label, "ADD_RETURN_LABEL"),
    ] {
        if wanted {
            keys.push(key);
        }
    }
    keys
}

fn option_values(request: &ShipmentRequest) -> Vec<Value> {
    let options = &request.options;
    let mut values = Vec::new();
    if let Some(point) = &request.service_point {
        values.push(json!({ "key": "PS", "input": point.id }));
    } else if options.mailbox {
        values.push(json!({ "key": "BP" }));
    } else {
        values.push(json!({ "key": "DOOR" }));
    }
    for (wanted, key) in [
        (options.signature, "HANDT"),
        (options.age_check, "AGE_CHECK"),
        (options.no_neighbour, "NBB"),
        (options.evening_delivery, "EVE"),
        (options.saturday_delivery, "S"),
        (request.return_label, "ADD_RETURN_LABEL"),
    ] {
        if wanted {
            values.push(json!({ "key": key }));
        }
    }
    if let Some(cents) = options.insured_value_cents.filter(|v| *v > 0) {
        values.push(json!({ "key": "INS", "input": format!("{:.2}", amount(cents)) }));
    }
    let reference: String = request.reference.chars().take(MAX_REFERENCE).collect();
    if !reference.trim().is_empty() {
        values.push(json!({ "key": "REFERENCE", "input": reference }));
    }
    values
}

/// The smallest parcel type of the product that takes the piece.
fn parcel_type(lines: &[&Capability], piece: &PieceSpec) -> Option<String> {
    let kg = kilograms(piece.weight_grams);
    let mut sides: Vec<f64> = [piece.length_cm, piece.width_cm, piece.height_cm]
        .into_iter()
        .flatten()
        .map(f64::from)
        .collect();
    sides.sort_by(|a, b| b.total_cmp(a));
    lines
        .iter()
        .filter(|c| c.max_kg >= kg)
        .filter(|c| {
            if sides.len() < 3 {
                return true;
            }
            let mut limits: Vec<f64> = c.max_cm.iter().flatten().copied().collect();
            if limits.len() < 3 {
                return true;
            }
            limits.sort_by(|a, b| b.total_cmp(a));
            sides.iter().zip(&limits).all(|(side, limit)| side <= limit)
        })
        .min_by(|a, b| a.max_kg.total_cmp(&b.max_kg))
        .map(|c| c.parcel_type.clone())
}

fn party(address: &Address) -> Value {
    let (first, last) = address.first_and_last_name();
    let mut name = Map::new();
    if !first.is_empty() {
        name.insert("firstName".into(), json!(first));
    }
    if !last.is_empty() {
        name.insert("lastName".into(), json!(last));
    }
    if let Some(company) = address.company.as_deref().filter(|c| !c.trim().is_empty()) {
        name.insert("companyName".into(), json!(company.trim()));
    }
    if let Some(extra) = address
        .address_line_2
        .as_deref()
        .filter(|c| !c.trim().is_empty())
    {
        name.insert("additionalName".into(), json!(extra.trim()));
    }
    let mut postal = Map::new();
    postal.insert(
        "countryCode".into(),
        json!(address.country.to_ascii_uppercase()),
    );
    postal.insert("postalCode".into(), json!(address.compact_postal_code()));
    postal.insert("city".into(), json!(address.city.trim()));
    postal.insert("street".into(), json!(address.street.trim()));
    if !address.house_number.trim().is_empty() {
        postal.insert("number".into(), json!(address.house_number.trim()));
    }
    if let Some(suffix) = address
        .house_number_suffix
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        postal.insert("addition".into(), json!(suffix.trim()));
    }
    postal.insert("isBusiness".into(), json!(address.is_business()));
    let mut party = Map::new();
    party.insert("name".into(), Value::Object(name));
    party.insert("address".into(), Value::Object(postal));
    if let Some(email) = address.email.as_deref().filter(|e| !e.trim().is_empty()) {
        party.insert("email".into(), json!(email.trim()));
    }
    if let Some(phone) = address.phone.as_deref().filter(|p| !p.trim().is_empty()) {
        party.insert("phoneNumber".into(), json!(phone.trim()));
    }
    Value::Object(party)
}

/// The `POST /shipments` body.
fn shipment_body(
    request: &ShipmentRequest,
    plan: &Plan,
    account: &str,
    return_only: bool,
) -> Value {
    let shipment_id = uuid::Uuid::parse_str(&request.idempotency_key)
        .unwrap_or_else(|_| uuid::Uuid::new_v4())
        .to_string();
    let pieces: Vec<Value> = request
        .pieces
        .iter()
        .zip(&plan.parcel_types)
        .map(|(piece, parcel_type)| {
            let mut value = json!({
                "parcelType": parcel_type,
                "quantity": 1,
                "weight": kilograms(piece.weight_grams),
            });
            if let (Some(l), Some(w), Some(h)) = (piece.length_cm, piece.width_cm, piece.height_cm)
            {
                value["dimensions"] = json!({ "length": l, "width": w, "height": h });
            }
            value
        })
        .collect();
    let mut body = json!({
        "shipmentId": shipment_id,
        "orderReference": request.reference,
        "receiver": party(&request.recipient),
        "shipper": party(&request.sender),
        "accountId": account,
        "options": plan.options,
        "product": plan.product,
        "returnLabel": return_only,
        "pieces": pieces,
    });
    if let Some(customs) = &request.customs {
        body["customsDeclaration"] = customs_body(customs);
    }
    body
}

fn customs_body(customs: &Customs) -> Value {
    let reason = match customs.content {
        CustomsContent::SaleOfGoods => "SaleOfGoods",
        CustomsContent::Gift => "Gift",
        CustomsContent::Documents => "Documents",
        CustomsContent::CommercialSample => "CommercialSample",
        CustomsContent::ReturnedGoods => "ReturnedGoods",
        CustomsContent::Other => "Other",
    };
    let export_type = if customs.content == CustomsContent::ReturnedGoods {
        "Return"
    } else {
        "Permanent"
    };
    let goods: Vec<Value> = customs
        .lines
        .iter()
        .map(|line| {
            let mut good = json!({
                "description": line.description,
                "quantity": line.quantity,
                "value": amount(line.value_cents),
                "weight": kilograms(line.weight_grams),
            });
            if let Some(code) = line.hs_code.as_deref().filter(|c| !c.is_empty()) {
                good["code"] = json!(code);
            }
            if let Some(origin) = line.origin_country.as_deref().filter(|c| !c.is_empty()) {
                good["origin"] = json!(origin.to_ascii_uppercase());
            }
            good
        })
        .collect();
    let mut body = json!({
        "currency": customs.currency.to_ascii_uppercase(),
        "exportType": export_type,
        "exportReason": reason,
        "incoTerms": "DAP",
        "customsGoods": goods,
    });
    if let Some(invoice) = customs.invoice_number.as_deref().filter(|i| !i.is_empty()) {
        body["invoiceNumber"] = json!(invoice);
    }
    if let Some(fee) = customs.shipping_fee_cents {
        body["shippingFee"] = json!({ "value": amount(fee) });
    }
    body
}

fn parse_capabilities(body: &Value) -> Vec<Capability> {
    list(Some(body))
        .into_iter()
        .filter_map(|item| {
            let product = item.get("product")?;
            let parcel = item.get("parcelType")?;
            let dimensions = parcel.get("dimensions");
            let cm = |key: &str| dimensions.and_then(|d| d.get(key)).and_then(Value::as_f64);
            Some(Capability {
                rank: item.get("rank").and_then(Value::as_i64).unwrap_or(i64::MAX),
                product: text(product, "key")?,
                label: text(product, "label").unwrap_or_default(),
                mono_collo: product
                    .get("monoColloProduct")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                return_product: product
                    .get("returnProduct")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                parcel_type: text(parcel, "key")?,
                max_kg: parcel
                    .get("maxWeightKg")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::MAX),
                max_cm: [cm("maxLengthCm"), cm("maxWidthCm"), cm("maxHeightCm")],
                options: list(item.get("options"))
                    .into_iter()
                    .filter_map(|o| text(o, "key"))
                    .collect(),
            })
        })
        .collect()
}

fn products_of(capabilities: &[Capability]) -> Vec<Product> {
    let mut sorted: Vec<&Capability> = capabilities.iter().collect();
    sorted.sort_by_key(|c| c.rank);
    let mut products: Vec<Product> = Vec::new();
    for capability in sorted {
        let names = capability.options.iter().filter_map(|k| option_name(k));
        if let Some(product) = products.iter_mut().find(|p| p.code == capability.product) {
            for name in names {
                if !product.options.iter().any(|o| o == name) {
                    product.options.push(name.to_owned());
                }
            }
            product.multi_collo |= !capability.mono_collo;
            continue;
        }
        let options: Vec<String> = names.map(str::to_owned).collect();
        products.push(Product {
            code: capability.product.clone(),
            name: if capability.label.is_empty() {
                capability.product.clone()
            } else {
                capability.label.clone()
            },
            service_point: options.iter().any(|o| o == "servicePoint"),
            multi_collo: !capability.mono_collo,
            mailbox: options.iter().any(|o| o == "mailbox"),
            returns: capability.return_product,
            options,
        });
    }
    for product in &mut products {
        product.service_point = product.options.iter().any(|o| o == "servicePoint");
        product.mailbox = product.options.iter().any(|o| o == "mailbox");
    }
    products
}

fn parse_time(value: Option<&Value>) -> Option<OffsetDateTime> {
    let raw = value?.as_str()?;
    OffsetDateTime::parse(raw, &Rfc3339).ok()
}

/// `DELIVERED_AT_NEIGHBOURS` → `Delivered at neighbours`.
fn humanize(status: &str) -> String {
    let lower = status.replace('_', " ").to_lowercase();
    let mut chars = lower.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

const AT_POINT: &[&str] = &[
    "DELIVERED_AT_PARCELSTATION",
    "DELIVERED_AT_PARCELSHOP",
    "AWAITING_RECEIVER_COLLECTION",
    "NOTIFICATION_FOR_PARCELSHOP_COLLECTION_HAS_BEEN_SENT",
];
const COLLECTED: &[&str] = &["COLLECTED_AT_PARCELSHOP", "COLLECTED_AT_PARCELSTATION"];
const RETURNED: &[&str] = &["RETURNED_TO_SHIPPER", "DELIVERED_AT_SHIPPER"];

/// The status the newest event says.
fn status_of(events: &[(String, String)], delivered: bool) -> ParcelStatus {
    let Some((category, status)) = events.last() else {
        return if delivered {
            ParcelStatus::Delivered
        } else {
            ParcelStatus::LabelCreated
        };
    };
    let status = status.as_str();
    if RETURNED.contains(&status) {
        return ParcelStatus::Returned;
    }
    if COLLECTED.contains(&status) {
        return ParcelStatus::Delivered;
    }
    if AT_POINT.contains(&status) {
        return ParcelStatus::AtServicePoint;
    }
    match category.as_str() {
        "DELIVERED" => ParcelStatus::Delivered,
        "EXCEPTION" | "PROBLEM" => ParcelStatus::Exception,
        "DATA_RECEIVED" => ParcelStatus::LabelCreated,
        _ if delivered => ParcelStatus::Delivered,
        _ => ParcelStatus::InTransit,
    }
}

fn parse_tracking(piece: &Value) -> Tracking {
    let mut raw: Vec<(Option<OffsetDateTime>, String, String, Option<String>)> =
        list(piece.get("events"))
            .into_iter()
            .map(|event| {
                let location = event
                    .get("facility")
                    .and_then(|f| {
                        if f.is_string() {
                            f.as_str().map(str::to_owned)
                        } else {
                            text(f, "name").or_else(|| text(f, "city"))
                        }
                    })
                    .filter(|f| !f.is_empty());
                (
                    parse_time(event.get("timestamp")),
                    text(event, "category").unwrap_or_default(),
                    text(event, "status").unwrap_or_default(),
                    location,
                )
            })
            .collect();
    raw.sort_by_key(|(at, ..)| *at);
    let delivered_at = parse_time(piece.get("deliveredAt"));
    let pairs: Vec<(String, String)> = raw
        .iter()
        .map(|(_, category, status, _)| (category.clone(), status.clone()))
        .collect();
    let status = status_of(&pairs, delivered_at.is_some());
    let events = raw
        .into_iter()
        .map(|(at, category, status, location)| {
            let code = if status.is_empty() { category } else { status };
            TrackingEvent {
                at,
                description: humanize(&code),
                code,
                location,
            }
        })
        .collect();
    let estimated_delivery = piece
        .get("plannedDeliveryTimeframe")
        .and_then(Value::as_str)
        .and_then(|frame| frame.split('/').next())
        .and_then(|start| OffsetDateTime::parse(start, &Rfc3339).ok());
    Tracking {
        status,
        events,
        delivered_at: delivered_at.filter(|_| status == ParcelStatus::Delivered),
        estimated_delivery,
    }
}

/// `10:00:00.000` → `10:00`.
fn hhmm(value: &str) -> String {
    value.chars().take(5).collect()
}

fn parse_point(location: &Value) -> Option<ServicePoint> {
    let id = text(location, "id")?;
    let address = location.get("address")?;
    let geo = location.get("geoLocation");
    let opening_hours = list(location.get("openingTimes"))
        .into_iter()
        .filter_map(|slot| {
            let weekday = slot.get("weekDay").and_then(Value::as_u64)?;
            Some(OpeningHours {
                weekday: u8::try_from(weekday).ok()?,
                opens: hhmm(&text(slot, "timeFrom")?),
                closes: hhmm(&text(slot, "timeTo")?),
            })
        })
        .collect();
    let distance = location
        .get("distance")
        .and_then(Value::as_f64)
        .filter(|d| d.is_finite() && *d >= 0.0)
        .map(|d| {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let meters = d.round().min(f64::from(u32::MAX)) as u32;
            meters
        });
    let name = text(location, "name").unwrap_or_else(|| id.clone());
    Some(ServicePoint {
        id,
        address: Address {
            company: Some(name.clone()),
            street: text(address, "street").unwrap_or_default(),
            house_number: text(address, "number").unwrap_or_default(),
            house_number_suffix: text(address, "addition"),
            postal_code: text(address, "postalCode")
                .or_else(|| text(address, "zipCode"))
                .unwrap_or_default(),
            city: text(address, "city").unwrap_or_default(),
            country: text(address, "countryCode").unwrap_or_default(),
            ..Address::default()
        },
        name,
        distance_meters: distance,
        latitude: geo.and_then(|g| g.get("latitude")).and_then(Value::as_f64),
        longitude: geo.and_then(|g| g.get("longitude")).and_then(Value::as_f64),
        opening_hours,
        locker: text(location, "shopType").is_some_and(|t| t == "packStation"),
        network_id: None,
    })
}

/// A failed answer as a [`CarrierError`]: `{ key, message, details }` JSON
/// or plain text.
fn error_of(response: &HttpResponse) -> CarrierError {
    match response.status {
        401 | 403 => {
            return CarrierError::Unauthorized("DHL Parcel refused the credentials".to_owned());
        }
        429 => {
            return CarrierError::unavailable(
                "DHL Parcel is limiting requests; try again in a minute",
            );
        }
        status if status >= 500 || status == 0 => {
            return CarrierError::unavailable(format!(
                "DHL Parcel failed ({status}): {}",
                http::body_excerpt(response)
            ));
        }
        _ => {}
    }
    let body = response.json();
    let mut messages = Vec::new();
    if let Some(message) = text(&body, "message") {
        messages.push(message);
    }
    if let Some(Value::Object(details)) = body.get("details") {
        for (field, problems) in details {
            for problem in list(Some(problems)) {
                if let Some(problem) = problem.as_str() {
                    messages.push(format!("{field}: {problem}"));
                }
            }
        }
    }
    if messages.is_empty() {
        let excerpt = http::body_excerpt(response);
        messages.push(if excerpt.is_empty() {
            format!("DHL Parcel refused the request ({})", response.status)
        } else {
            excerpt
        });
    }
    CarrierError::Rejected(messages)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::testing::{Fake, piece, request};

    fn capabilities() -> Value {
        json!([
            {
                "rank": 1,
                "product": { "key": "DFY-B2C", "label": "DHL For You", "monoColloProduct": true },
                "parcelType": { "key": "SMALL", "minWeightKg": 0, "maxWeightKg": 2,
                    "dimensions": { "maxLengthCm": 80, "maxWidthCm": 50, "maxHeightCm": 35 } },
                "options": [{ "key": "DOOR" }, { "key": "PS" }, { "key": "HANDT" }, { "key": "ADD_RETURN_LABEL" }]
            },
            {
                "rank": 1,
                "product": { "key": "DFY-B2C", "label": "DHL For You", "monoColloProduct": true },
                "parcelType": { "key": "MEDIUM", "minWeightKg": 0, "maxWeightKg": 10 },
                "options": [{ "key": "DOOR" }, { "key": "PS" }, { "key": "HANDT" }, { "key": "ADD_RETURN_LABEL" }]
            },
            {
                "rank": 2,
                "product": { "key": "EPL", "label": "Europlus", "monoColloProduct": false },
                "parcelType": { "key": "LARGE", "minWeightKg": 0, "maxWeightKg": 20 },
                "options": [{ "key": "DOOR" }, { "key": "HANDT" }]
            }
        ])
    }

    fn client(fake: &Arc<Fake>) -> DhlParcelNl {
        DhlParcelNl::with_base(
            Credentials {
                user_id: "user".into(),
                api_key: "key".into(),
                account_id: "01234567".into(),
                sandbox: false,
            },
            fake.outbound(),
            "https://dhl.test",
        )
    }

    fn signed_in(fake: &Fake) {
        fake.answer(
            "POST https://dhl.test/authenticate/api-key",
            200,
            &json!({ "accessToken": "tok", "accessTokenExpiration": 4_102_444_800_i64, "accountNumbers": ["01234567"] }),
        );
    }

    #[tokio::test]
    async fn makes_a_shipment_and_fetches_every_label() {
        let fake = Fake::new();
        signed_in(&fake);
        fake.answer_prefix(
            "GET https://dhl.test/capabilities/business?",
            200,
            &capabilities(),
        );
        fake.answer(
            "POST https://dhl.test/shipments",
            201,
            &json!({
                "shipmentId": "x", "product": "DFY-B2C",
                "pieces": [{ "labelId": "lab-1", "trackerCode": "JVGL001", "pieceNumber": 1 }],
                "returnShipment": { "pieces": [{ "labelId": "lab-r", "trackerCode": "JVGLR01", "pieceNumber": 1 }] }
            }),
        );
        fake.answer_bytes("GET https://dhl.test/labels/lab-1", 200, b"%PDF-1");
        fake.answer_bytes("GET https://dhl.test/labels/lab-r", 200, b"%PDF-R");
        let mut req = request();
        req.options.signature = true;
        req.return_label = true;
        req.pieces = vec![piece(1500)];
        let created = client(&fake).create_shipment(&req).await.expect("created");
        assert_eq!(created.product, "DFY-B2C");
        assert_eq!(created.pieces.len(), 1);
        assert_eq!(created.pieces[0].tracking_number, "JVGL001");
        assert_eq!(
            created.pieces[0].carrier_reference.as_deref(),
            Some("lab-1")
        );
        assert_eq!(created.pieces[0].label.bytes, b"%PDF-1");
        assert_eq!(
            created
                .return_piece
                .as_ref()
                .map(|p| p.tracking_number.as_str()),
            Some("JVGLR01")
        );

        let sent = fake.body_of("POST https://dhl.test/shipments");
        assert_eq!(sent["accountId"], "01234567");
        assert_eq!(sent["product"], "DFY-B2C");
        assert_eq!(sent["pieces"][0]["parcelType"], "SMALL");
        assert_eq!(sent["pieces"][0]["weight"], 1.5);
        assert_eq!(sent["receiver"]["address"]["street"], "Damrak");
        assert_eq!(sent["receiver"]["address"]["number"], "1");
        assert_eq!(sent["receiver"]["address"]["addition"], "A");
        assert_eq!(sent["receiver"]["address"]["postalCode"], "1012LG");
        assert_eq!(sent["receiver"]["name"]["firstName"], "Anna");
        assert_eq!(sent["receiver"]["name"]["lastName"], "de Vries");
        let keys: Vec<&str> = sent["options"]
            .as_array()
            .expect("options")
            .iter()
            .filter_map(|o| o["key"].as_str())
            .collect();
        assert_eq!(keys, ["DOOR", "HANDT", "ADD_RETURN_LABEL", "REFERENCE"]);
        assert!(uuid::Uuid::parse_str(sent["shipmentId"].as_str().unwrap_or("")).is_ok());
        assert_eq!(
            fake.header_of("POST https://dhl.test/shipments", "authorization")
                .as_deref(),
            Some("Bearer tok")
        );
        assert_eq!(
            fake.header_of("GET https://dhl.test/labels/lab-1", "accept")
                .as_deref(),
            Some("application/pdf")
        );
    }

    #[tokio::test]
    async fn several_pieces_take_a_multi_collo_product() {
        let fake = Fake::new();
        signed_in(&fake);
        fake.answer_prefix(
            "GET https://dhl.test/capabilities/business?",
            200,
            &capabilities(),
        );
        fake.answer(
            "POST https://dhl.test/shipments",
            201,
            &json!({ "product": "EPL", "pieces": [
                { "labelId": "a", "trackerCode": "JV1", "pieceNumber": 1 },
                { "labelId": "b", "trackerCode": "JV2", "pieceNumber": 2 }
            ] }),
        );
        fake.answer_bytes("GET https://dhl.test/labels/a", 200, b"A");
        fake.answer_bytes("GET https://dhl.test/labels/b", 200, b"B");
        let mut req = request();
        req.pieces = vec![piece(3000), piece(12_000)];
        let created = client(&fake).create_shipment(&req).await.expect("created");
        assert_eq!(created.pieces.len(), 2);
        assert_eq!(created.pieces[1].collo_number, 2);
        let sent = fake.body_of("POST https://dhl.test/shipments");
        assert_eq!(sent["product"], "EPL");
        assert_eq!(sent["pieces"][1]["parcelType"], "LARGE");
    }

    #[tokio::test]
    async fn service_points_and_options_must_be_offered() {
        let fake = Fake::new();
        signed_in(&fake);
        fake.answer_prefix(
            "GET https://dhl.test/capabilities/business?",
            200,
            &capabilities(),
        );
        let mut req = request();
        req.options.age_check = true;
        let error = client(&fake)
            .create_shipment(&req)
            .await
            .expect_err("refused");
        assert!(matches!(error, CarrierError::NotSupported(_)), "{error:?}");

        let mut req = request();
        req.service_point = Some(crate::types::ServicePointRef {
            id: "8004-NL-354306".into(),
            ..Default::default()
        });
        req.product = Some("EPL".into());
        let error = client(&fake)
            .create_shipment(&req)
            .await
            .expect_err("refused");
        assert!(error.message().contains("servicePoint"), "{error:?}");
    }

    #[tokio::test]
    async fn a_consumer_needs_an_email_and_an_address_a_number() {
        let fake = Fake::new();
        let mut req = request();
        req.recipient.email = None;
        assert!(matches!(
            client(&fake).create_shipment(&req).await,
            Err(CarrierError::Invalid(_))
        ));
        let mut req = request();
        req.recipient.house_number = String::new();
        assert!(matches!(
            client(&fake).create_shipment(&req).await,
            Err(CarrierError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn validation_errors_carry_the_fields() {
        let fake = Fake::new();
        signed_in(&fake);
        fake.answer_prefix(
            "GET https://dhl.test/capabilities/business?",
            200,
            &capabilities(),
        );
        fake.answer(
            "POST https://dhl.test/shipments",
            400,
            &json!({ "key": "label_validation_error", "message": "Invalid body",
                     "details": { "receiver": ["error.path.missing"] } }),
        );
        let error = client(&fake)
            .create_shipment(&request())
            .await
            .expect_err("rejected");
        assert_eq!(
            error,
            CarrierError::Rejected(vec![
                "Invalid body".into(),
                "receiver: error.path.missing".into()
            ])
        );
    }

    #[tokio::test]
    async fn a_wrong_key_is_unauthorized() {
        let fake = Fake::new();
        fake.answer_bytes("POST https://dhl.test/authenticate/api-key", 401, b"");
        let error = client(&fake).verify().await.expect_err("refused");
        assert!(matches!(error, CarrierError::Unauthorized(_)));
    }

    #[tokio::test]
    async fn tracking_reads_the_newest_event() {
        let fake = Fake::new();
        fake.answer_prefix(
            "GET https://dhl.test/track-trace?",
            200,
            &json!([{
                "barcode": "JVGL001",
                "deliveredAt": "2026-11-20T14:02:00+01:00",
                "events": [
                    { "category": "DATA_RECEIVED", "status": "PRENOTIFICATION_RECEIVED", "timestamp": "2026-11-19T09:00:00+01:00" },
                    { "category": "DELIVERED", "status": "DELIVERED_AT_NEIGHBOURS", "timestamp": "2026-11-20T14:02:00+01:00",
                      "facility": "Utrecht" },
                    { "category": "UNDERWAY", "status": "IN_DELIVERY", "timestamp": "2026-11-20T08:00:00+01:00" }
                ]
            }]),
        );
        let tracking = client(&fake)
            .track(&TrackRef {
                tracking_number: "JVGL001".into(),
                postal_code: "1012 lg".into(),
                country: "NL".into(),
            })
            .await
            .expect("tracked")
            .expect("known");
        assert_eq!(tracking.status, ParcelStatus::Delivered);
        assert_eq!(tracking.events.len(), 3);
        assert_eq!(tracking.events[2].code, "DELIVERED_AT_NEIGHBOURS");
        assert_eq!(tracking.events[2].description, "Delivered at neighbours");
        assert_eq!(tracking.events[2].location.as_deref(), Some("Utrecht"));
        assert!(tracking.delivered_at.is_some());
        assert!(fake.called_with("key=JVGL001%2B1012LG"));
    }

    #[test]
    fn statuses() {
        let s = |pairs: &[(&str, &str)]| {
            let events: Vec<(String, String)> = pairs
                .iter()
                .map(|(c, s)| ((*c).to_owned(), (*s).to_owned()))
                .collect();
            status_of(&events, false)
        };
        assert_eq!(s(&[]), ParcelStatus::LabelCreated);
        assert_eq!(s(&[("DATA_RECEIVED", "X")]), ParcelStatus::LabelCreated);
        assert_eq!(s(&[("UNDERWAY", "SORTED")]), ParcelStatus::InTransit);
        assert_eq!(
            s(&[("DELIVERED", "DELIVERED_AT_PARCELSTATION")]),
            ParcelStatus::AtServicePoint
        );
        assert_eq!(
            s(&[("DELIVERED", "COLLECTED_AT_PARCELSHOP")]),
            ParcelStatus::Delivered
        );
        assert_eq!(
            s(&[("PROBLEM", "ADDRESS_UNKNOWN")]),
            ParcelStatus::Exception
        );
        assert_eq!(s(&[("LEG", "RETURNED_TO_SHIPPER")]), ParcelStatus::Returned);
    }

    #[tokio::test]
    async fn service_points_read_the_parcel_shops() {
        let fake = Fake::new();
        fake.answer_prefix(
            "GET https://dhl.test/parcel-shop-locations/NL?",
            200,
            &json!([{
                "id": "8004-NL-354306", "name": "Primera Damrak", "shopType": "parcelShop",
                "address": { "countryCode": "NL", "postalCode": "1012LG", "city": "Amsterdam", "street": "Damrak", "number": "5" },
                "geoLocation": { "latitude": 52.37, "longitude": 4.89 }, "distance": 120.4,
                "openingTimes": [{ "weekDay": 1, "timeFrom": "09:00:00.000", "timeTo": "18:00:00.000" }]
            }]),
        );
        let points = client(&fake)
            .service_points(&PointQuery {
                country: "nl".into(),
                postal_code: "1012 LG".into(),
                house_number: Some("1".into()),
                city: None,
                limit: 10,
            })
            .await
            .expect("points");
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].id, "8004-NL-354306");
        assert_eq!(points[0].distance_meters, Some(120));
        assert_eq!(points[0].opening_hours[0].opens, "09:00");
        assert_eq!(points[0].address.house_number, "5");
        assert!(fake.called_with("postalCode=1012LG"));
    }

    #[test]
    fn products_merge_parcel_types() {
        let products = products_of(&parse_capabilities(&capabilities()));
        assert_eq!(products.len(), 2);
        assert_eq!(products[0].code, "DFY-B2C");
        assert!(products[0].service_point);
        assert!(!products[0].multi_collo);
        assert!(products[0].options.contains(&"returnLabel".to_owned()));
        assert!(products[1].multi_collo);
    }

    #[test]
    fn tracking_urls() {
        let mut piece = TrackRef {
            tracking_number: "JVGL001".into(),
            postal_code: "1012 lg".into(),
            country: "NL".into(),
        };
        assert_eq!(
            tracking_url(&piece),
            "https://my.dhlecommerce.nl/home/tracktrace/JVGL001/1012LG"
        );
        piece.country = "BE".into();
        assert_eq!(
            tracking_url(&piece),
            "https://my.dhlparcel.be/go-track-trace?tt=JVGL001&pc=1012LG"
        );
    }
}
