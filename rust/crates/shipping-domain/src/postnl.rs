//! PostNL (`api.postnl.nl`, sandbox `api-sandbox.postnl.nl`), header
//! `apikey`, from a Dutch PostNL contract (customer code and number).
//!
//! - Labels: `POST /shipment/v2_2/label?confirm=true`, one `Shipments[]`
//!   entry per piece. PostNL makes the barcode when it is left out, except
//!   for multi-collo: those pieces (NL and BE only) share a `Groups` entry
//!   and take their barcodes from the Barcode API first. Customs documents
//!   (CN23, CP71, commercial invoice) come back as extra labels.
//! - Return labels: a separate 3285 shipment (to a home or business
//!   address), the customer as sender; domestic only.
//! - Products: a fixed table; the delivery options pick the code (3085 with
//!   a signature is 3189, …).
//! - Tracking: `ShippingStatus` v2 by barcode. Service points: Locations
//!   `v2_1`.
//!
//! Research: `weldsuite-documentation/plans/weldstash-carriers-research/postnl.md`.

use base64::Engine as _;
use serde_json::{Map, Value, json};
use time::macros::format_description;
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, UtcOffset, Weekday};
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use crate::countries::is_eu_member;
use crate::error::CarrierError;
use crate::http::{self, amount, list, query, text};
use crate::types::{
    Address, CreatedPiece, CreatedShipment, Customs, CustomsContent, LabelFile, LabelFormat,
    OpeningHours, ParcelStatus, PointQuery, Product, ServicePoint, ShipmentRequest, TrackRef,
    Tracking, TrackingEvent,
};

const PRODUCTION: &str = "https://api.postnl.nl";
const SANDBOX: &str = "https://api-sandbox.postnl.nl";
/// Shipments per label request (since 2026-05-12).
const MAX_SHIPMENTS: usize = 25;
/// Customs lines per declaration.
const MAX_CUSTOMS_LINES: usize = 5;
/// PostNL's `MessageID` is at most 12 characters.
const MAX_MESSAGE_ID: usize = 12;
/// The standalone return label to a home or business address.
const RETURN_PRODUCT: &str = "3285";

/// What a PostNL account needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub api_key: String,
    /// e.g. `DEVC`.
    pub customer_code: String,
    /// e.g. `11223344`.
    pub customer_number: String,
    /// The PostNL location that collects the parcels (6 characters).
    pub collection_location: Option<String>,
    pub sandbox: bool,
}

/// The client for one account.
pub struct PostNl {
    http: OutboundHttp,
    base: String,
    credentials: Credentials,
}

impl std::fmt::Debug for PostNl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostNl")
            .field("base", &self.base)
            .field("customer_code", &self.credentials.customer_code)
            .finish_non_exhaustive()
    }
}

/// A product family: the code a person picks and what the options turn it
/// into.
struct Family {
    code: &'static str,
    name: &'static str,
    /// Destinations: `NL`, `BE`, `EU` (other member states) or `WORLD`.
    zone: &'static str,
    service_point: bool,
    mailbox: bool,
    options: &'static [&'static str],
}

const FAMILIES: &[Family] = &[
    Family {
        code: "3085",
        name: "Standard parcel",
        zone: "NL",
        service_point: false,
        mailbox: false,
        options: &[
            "signature",
            "noNeighbour",
            "ageCheck",
            "eveningDelivery",
            "insurance",
            "returnLabel",
        ],
    },
    Family {
        code: "3533",
        name: "Pickup point",
        zone: "NL",
        service_point: true,
        mailbox: false,
        options: &["ageCheck", "insurance", "returnLabel"],
    },
    Family {
        code: "2928",
        name: "Mailbox parcel",
        zone: "NL",
        service_point: false,
        mailbox: true,
        options: &[],
    },
    Family {
        code: "4946",
        name: "Parcel Belgium",
        zone: "BE",
        service_point: false,
        mailbox: false,
        options: &["signature", "noNeighbour", "insurance"],
    },
    Family {
        code: "4936",
        name: "Pickup point Belgium",
        zone: "BE",
        service_point: true,
        mailbox: false,
        options: &[],
    },
    Family {
        code: "4907",
        name: "Parcel EU",
        zone: "EU",
        service_point: false,
        mailbox: false,
        options: &["insurance"],
    },
    Family {
        code: "4909",
        name: "Parcel outside the EU",
        zone: "WORLD",
        service_point: false,
        mailbox: false,
        options: &["insurance"],
    },
];

/// Countries where 4907 delivers to a pickup point (option 118/045).
const EU_POINT_COUNTRIES: &[&str] = &["DE", "DK", "SE"];

fn zone_of(to: &str) -> &'static str {
    match to {
        "NL" => "NL",
        "BE" => "BE",
        c if is_eu_member(c) => "EU",
        _ => "WORLD",
    }
}

fn family(code: &str) -> Option<&'static Family> {
    FAMILIES.iter().find(|f| f.code == code)
}

/// The product code to send and its product options.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Resolved {
    family: &'static str,
    code: &'static str,
    options: Vec<(&'static str, &'static str)>,
    insured: bool,
}

/// The product code PostNL wants for a family and the delivery options.
#[allow(
    clippy::too_many_lines,
    reason = "one table of product codes, read top to bottom"
)]
fn resolve(request: &ShipmentRequest) -> Result<Resolved, CarrierError> {
    let to = request.recipient.country.trim().to_ascii_uppercase();
    let zone = zone_of(&to);
    let options = &request.options;
    let insured = options.insured_value_cents.is_some_and(|v| v > 0);
    let family_code = match request.product.as_deref() {
        Some(code) => code.to_owned(),
        None => FAMILIES
            .iter()
            .find(|f| {
                f.zone == zone
                    && f.service_point == request.service_point.is_some()
                    && f.mailbox == options.mailbox
            })
            .or_else(|| {
                FAMILIES
                    .iter()
                    .find(|f| f.zone == zone && !f.service_point && !f.mailbox)
            })
            .map(|f| f.code.to_owned())
            .ok_or_else(|| CarrierError::not_supported(format!("PostNL has no product to {to}")))?,
    };
    let family = family(&family_code).ok_or_else(|| {
        CarrierError::not_supported(format!("PostNL product {family_code} is not supported"))
    })?;
    if family.zone != zone {
        return Err(CarrierError::not_supported(format!(
            "PostNL product {} ({}) doesn't ship to {to}",
            family.code, family.name
        )));
    }
    let point_ok = family.service_point
        || (family.code == "4907" && EU_POINT_COUNTRIES.contains(&to.as_str()));
    if request.service_point.is_some() && !point_ok {
        return Err(CarrierError::not_supported(format!(
            "PostNL product {} ({}) doesn't deliver to a pickup point",
            family.code, family.name
        )));
    }
    if family.service_point && request.service_point.is_none() {
        return Err(CarrierError::invalid(
            "Choose a PostNL pickup point for this product",
        ));
    }
    let wanted = [
        ("signature", options.signature),
        ("noNeighbour", options.no_neighbour),
        ("ageCheck", options.age_check),
        ("eveningDelivery", options.evening_delivery),
        ("insurance", insured),
        ("returnLabel", request.return_label),
    ];
    if let Some((name, _)) = wanted
        .iter()
        .find(|(name, on)| *on && !family.options.contains(name))
    {
        return Err(CarrierError::not_supported(format!(
            "PostNL product {} ({}) doesn't offer {name}",
            family.code, family.name
        )));
    }
    let mut product_options = Vec::new();
    let code = match family.code {
        "3085" => {
            if options.age_check {
                product_options.push(("002", "014"));
                "3438"
            } else if insured {
                "3087"
            } else if options.signature && options.no_neighbour {
                "3089"
            } else if options.signature {
                "3189"
            } else if options.no_neighbour {
                "3385"
            } else {
                "3085"
            }
        }
        "3533" => {
            if options.age_check {
                "3571"
            } else if insured {
                "3534"
            } else {
                "3533"
            }
        }
        "4946" => {
            if insured {
                "4914"
            } else if options.signature {
                "4912"
            } else if options.no_neighbour {
                "4941"
            } else {
                "4946"
            }
        }
        "4907" | "4909" => {
            product_options.push(if insured {
                ("004", "015")
            } else {
                ("005", "025")
            });
            if family.code == "4907" {
                product_options.push(if request.recipient.is_business() {
                    ("101", "013")
                } else {
                    ("101", "012")
                });
                if request.service_point.is_some() {
                    product_options.push(("118", "045"));
                }
            }
            family.code
        }
        other => other,
    };
    if options.evening_delivery {
        product_options.push(("118", "006"));
    }
    Ok(Resolved {
        family: family.code,
        code,
        options: product_options,
        insured,
    })
}

impl PostNl {
    pub fn new(credentials: Credentials, http: OutboundHttp) -> Self {
        let base = if credentials.sandbox {
            SANDBOX
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
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn authorized(&self, request: HttpRequest) -> HttpRequest {
        request
            .header("apikey", self.credentials.api_key.clone())
            .header("accept", "application/json")
    }

    /// A new 3S barcode from the Barcode API.
    async fn barcode(&self) -> Result<String, CarrierError> {
        let code = self.credentials.customer_code.trim();
        // 3S + customer code + serial = 15 characters.
        let digits = 13_usize.saturating_sub(code.chars().count()).max(5);
        let serie = format!("{}-{}", "0".repeat(digits), "9".repeat(digits));
        let url = self.url(&format!(
            "/shipment/v1_1/barcode?{}",
            query(&[
                ("CustomerCode", code),
                ("CustomerNumber", self.credentials.customer_number.trim()),
                ("Type", "3S"),
                ("Serie", &serie),
            ])
        ));
        let response =
            http::send_read(&self.http, self.authorized(HttpRequest::empty("GET", url))).await?;
        if !response.ok() {
            return Err(error_of(&response));
        }
        text(&response.json(), "Barcode")
            .ok_or_else(|| CarrierError::unavailable("PostNL answered without a barcode"))
    }

    /// The key, customer code and customer number work (one barcode is
    /// drawn and left unused).
    pub async fn verify(&self) -> Result<(), CarrierError> {
        self.barcode().await.map(|_| ())
    }

    /// The products from the Netherlands to `to`.
    pub fn products(&self, from: &str, to: &str) -> Vec<Product> {
        products(from, to)
    }

    /// Labels for every piece of `request`, and its return label.
    pub async fn create_shipment(
        &self,
        request: &ShipmentRequest,
    ) -> Result<CreatedShipment, CarrierError> {
        check_request(request)?;
        let resolved = resolve(request)?;
        let to = request.recipient.country.to_ascii_uppercase();
        let pieces = request.pieces.len();
        let customs_needed = crate::countries::customs_required(
            &request.sender.country,
            &to,
            &request.recipient.postal_code,
        );
        if customs_needed && request.customs.is_none() {
            return Err(CarrierError::invalid(format!(
                "A parcel to {to} needs a customs declaration"
            )));
        }
        if pieces > 1 && (customs_needed || !(to == "NL" || to == "BE")) {
            return Err(CarrierError::not_supported(
                "PostNL ships one piece per shipment outside the Netherlands and Belgium",
            ));
        }
        if pieces > 1 && (request.options.mailbox || request.service_point.is_some()) {
            return Err(CarrierError::not_supported(
                "PostNL mailbox and pickup point parcels take one piece per shipment",
            ));
        }
        let barcodes = if pieces > 1 {
            let mut barcodes = Vec::with_capacity(pieces);
            for _ in 0..pieces {
                barcodes.push(self.barcode().await?);
            }
            barcodes
        } else {
            Vec::new()
        };
        let shipments: Vec<Value> = (0..pieces)
            .map(|index| shipment_entry(request, &resolved, index, &barcodes))
            .collect();
        let body = self.label_body(request, request.label_format, &shipments);
        let answered = self.post_label(&body).await?;
        let (mut created, warnings) = parse_label_answer(&answered, request.label_format)?;
        let mut shipment = CreatedShipment {
            product: resolved.code.to_owned(),
            pieces: Vec::new(),
            return_piece: None,
            customs_document: None,
            warnings,
        };
        for (index, answered) in created.drain(..).enumerate() {
            if shipment.customs_document.is_none() {
                shipment.customs_document = answered.customs;
            }
            shipment.pieces.push(CreatedPiece {
                collo_number: u32::try_from(index + 1).unwrap_or(1),
                tracking_number: answered.barcode,
                carrier_reference: None,
                label: answered.label,
            });
        }
        if request.return_label {
            let mut back = request.clone();
            back.sender = request.recipient.clone();
            back.recipient = request
                .return_address
                .clone()
                .unwrap_or_else(|| request.sender.clone());
            back.pieces.truncate(1);
            match self.create_return(&back).await {
                Ok(returned) => shipment.return_piece = returned.pieces.into_iter().next(),
                Err(error) => shipment.warnings.push(format!(
                    "The return label could not be made: {}",
                    error.message()
                )),
            }
        }
        Ok(shipment)
    }

    /// A return label on its own (product 3285): `request.sender` is the
    /// customer sending it back, `request.recipient` the merchant.
    pub async fn create_return(
        &self,
        request: &ShipmentRequest,
    ) -> Result<CreatedShipment, CarrierError> {
        check_request(request)?;
        let from = request.sender.country.to_ascii_uppercase();
        let to = request.recipient.country.to_ascii_uppercase();
        if from != "NL" || to != "NL" {
            return Err(CarrierError::not_supported(
                "PostNL return labels are for returns within the Netherlands",
            ));
        }
        let barcode = self.barcode().await?;
        let piece = request.pieces.first().copied().unwrap_or_default();
        let mut entry = json!({
            "Addresses": [address_of(&request.recipient, "01")],
            "Barcode": barcode,
            "Contacts": contacts(&request.sender, "02"),
            "Dimension": dimension(&piece),
            "ProductCodeDelivery": RETURN_PRODUCT,
            "Reference": request.reference,
        });
        // The customer is the sender on a return label.
        if let Some(addresses) = entry["Addresses"].as_array_mut() {
            addresses.push(address_of(&request.sender, "02"));
        }
        let body = self.label_body(request, request.label_format, &[entry]);
        let answered = self.post_label(&body).await?;
        let (mut created, warnings) = parse_label_answer(&answered, request.label_format)?;
        let first = created.drain(..).next().ok_or_else(|| {
            CarrierError::unavailable("PostNL answered the return label without a shipment")
        })?;
        Ok(CreatedShipment {
            product: RETURN_PRODUCT.to_owned(),
            pieces: vec![CreatedPiece {
                collo_number: 1,
                tracking_number: first.barcode,
                carrier_reference: None,
                label: first.label,
            }],
            return_piece: None,
            customs_document: None,
            warnings,
        })
    }

    fn label_body(
        &self,
        request: &ShipmentRequest,
        format: LabelFormat,
        shipments: &[Value],
    ) -> Value {
        let mut customer = json!({
            "CustomerCode": self.credentials.customer_code.trim(),
            "CustomerNumber": self.credentials.customer_number.trim(),
            "Address": address_of(&request.sender, "02"),
        });
        if let Some(location) = self
            .credentials
            .collection_location
            .as_deref()
            .map(str::trim)
            .filter(|l| !l.is_empty())
        {
            customer["CollectionLocation"] = json!(location);
        }
        let message_id: String = request
            .idempotency_key
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(MAX_MESSAGE_ID)
            .collect();
        json!({
            "Customer": customer,
            "Message": {
                "MessageID": if message_id.is_empty() { "1".to_owned() } else { message_id },
                "MessageTimeStamp": message_timestamp(OffsetDateTime::now_utc()),
                "Printertype": printer_type(format),
            },
            "Shipments": shipments,
        })
    }

    async fn post_label(&self, body: &Value) -> Result<Value, CarrierError> {
        let shipments = body["Shipments"].as_array().map_or(0, Vec::len);
        if shipments > MAX_SHIPMENTS {
            return Err(CarrierError::invalid(format!(
                "PostNL takes at most {MAX_SHIPMENTS} pieces per request"
            )));
        }
        let request = self.authorized(HttpRequest::json(
            "POST",
            self.url("/shipment/v2_2/label?confirm=true"),
            body,
        ));
        let response = http::send(&self.http, request).await?;
        if response.status == 404 {
            // Over 200 KB answers 404 instead of a validation error.
            return Err(CarrierError::Rejected(vec![
                "PostNL refused the request (too large or not found)".to_owned(),
            ]));
        }
        if !response.ok() {
            return Err(error_of(&response));
        }
        Ok(response.json())
    }

    /// The piece's status and events; `None` when PostNL doesn't know it.
    pub async fn track(&self, piece: &TrackRef) -> Result<Option<Tracking>, CarrierError> {
        let url = self.url(&format!(
            "/shipment/v2/status/barcode/{}?{}",
            piece.tracking_number.trim(),
            query(&[("detail", "true"), ("language", "NL")])
        ));
        let response =
            http::send_read(&self.http, self.authorized(HttpRequest::empty("GET", url))).await?;
        if !response.ok() {
            return Err(error_of(&response));
        }
        Ok(parse_tracking(&response.json(), &piece.tracking_number))
    }

    /// Pickup points near a postal code (NL and BE).
    pub async fn service_points(&self, q: &PointQuery) -> Result<Vec<ServicePoint>, CarrierError> {
        let postal = crate::types::compact_postal_code(&q.postal_code);
        let url = self.url(&format!(
            "/shipment/v2_1/locations/nearest?{}",
            query(&[
                ("CountryCode", &q.country.trim().to_ascii_uppercase()),
                ("PostalCode", &postal),
                ("HouseNumber", q.house_number.as_deref().unwrap_or("")),
                ("City", q.city.as_deref().unwrap_or("")),
                ("DeliveryOptions", "PG"),
            ])
        ));
        let response =
            http::send_read(&self.http, self.authorized(HttpRequest::empty("GET", url))).await?;
        if !response.ok() {
            return Err(error_of(&response));
        }
        let body = response.json();
        let limit = usize::try_from(q.limit.clamp(1, 50)).unwrap_or(10);
        Ok(list(body.pointer("/GetLocationsResult/ResponseLocation"))
            .into_iter()
            .filter_map(parse_point)
            .take(limit)
            .collect())
    }
}

/// The products from `from` to `to`.
pub fn products(from: &str, to: &str) -> Vec<Product> {
    if !from.eq_ignore_ascii_case("NL") {
        return Vec::new();
    }
    let to = to.trim().to_ascii_uppercase();
    let zone = zone_of(&to);
    FAMILIES
        .iter()
        .filter(|f| f.zone == zone)
        .map(|f| Product {
            code: f.code.to_owned(),
            name: f.name.to_owned(),
            service_point: f.service_point
                || (f.code == "4907" && EU_POINT_COUNTRIES.contains(&to.as_str())),
            multi_collo: (f.zone == "NL" || f.zone == "BE") && !f.service_point && !f.mailbox,
            mailbox: f.mailbox,
            returns: false,
            options: f.options.iter().map(|o| (*o).to_owned()).collect(),
        })
        .collect()
}

/// The public track-and-trace page.
pub fn tracking_url(piece: &TrackRef) -> String {
    format!(
        "https://jouw.postnl.nl/track-and-trace/{}-{}-{}",
        piece.tracking_number.trim(),
        piece.country.trim().to_ascii_uppercase(),
        crate::types::compact_postal_code(&piece.postal_code)
    )
}

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
        let benelux = ["NL", "BE"].contains(&address.country.to_ascii_uppercase().as_str());
        if benelux
            && !address
                .house_number
                .trim()
                .chars()
                .all(|c| c.is_ascii_digit())
        {
            return Err(CarrierError::invalid(format!(
                "The {side}'s house number must be a number; put letters in the addition"
            )));
        }
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
    if let Some(customs) = &request.customs {
        if customs.lines.is_empty() || customs.lines.len() > MAX_CUSTOMS_LINES {
            return Err(CarrierError::invalid(format!(
                "A PostNL customs declaration takes 1 to {MAX_CUSTOMS_LINES} lines"
            )));
        }
        let currency = customs.currency.to_ascii_uppercase();
        if currency != "EUR" && currency != "USD" {
            return Err(CarrierError::invalid(
                "PostNL customs declarations are in EUR or USD",
            ));
        }
    }
    Ok(())
}

fn address_of(address: &Address, kind: &str) -> Value {
    let (first, last) = address.first_and_last_name();
    let mut value = Map::new();
    value.insert("AddressType".into(), json!(kind));
    if !first.is_empty() {
        value.insert("FirstName".into(), json!(first));
    }
    if !last.is_empty() {
        value.insert("Name".into(), json!(last));
    }
    if let Some(company) = address.company.as_deref().filter(|c| !c.trim().is_empty()) {
        value.insert("CompanyName".into(), json!(company.trim()));
    }
    value.insert("Street".into(), json!(address.street.trim()));
    if !address.house_number.trim().is_empty() {
        value.insert("HouseNr".into(), json!(address.house_number.trim()));
    }
    if let Some(suffix) = address
        .house_number_suffix
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        value.insert("HouseNrExt".into(), json!(suffix.trim()));
    }
    if let Some(extra) = address
        .address_line_2
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        value.insert("Buildingname".into(), json!(extra.trim()));
    }
    let country = address.country.trim().to_ascii_uppercase();
    let postal = if country == "NL" {
        address.compact_postal_code()
    } else {
        address.postal_code.trim().to_owned()
    };
    value.insert("Zipcode".into(), json!(postal));
    value.insert("City".into(), json!(address.city.trim()));
    if let Some(region) = address.state.as_deref().filter(|s| !s.trim().is_empty()) {
        value.insert("Region".into(), json!(region.trim()));
    }
    value.insert("Countrycode".into(), json!(country));
    Value::Object(value)
}

fn contacts(address: &Address, kind: &str) -> Value {
    let mut contact = Map::new();
    contact.insert("ContactType".into(), json!(kind));
    if let Some(email) = address.email.as_deref().filter(|e| !e.trim().is_empty()) {
        contact.insert("Email".into(), json!(email.trim()));
    }
    if let Some(phone) = address.phone.as_deref().filter(|p| !p.trim().is_empty()) {
        contact.insert("SMSNr".into(), json!(phone.trim()));
    }
    if contact.len() == 1 {
        return json!([]);
    }
    json!([Value::Object(contact)])
}

fn dimension(piece: &crate::types::PieceSpec) -> Value {
    let mut dimension = json!({ "Weight": piece.weight_grams.max(1) });
    let mut sides: Vec<u32> = [piece.length_cm, piece.width_cm, piece.height_cm]
        .into_iter()
        .flatten()
        .collect();
    if sides.len() == 3 {
        // Millimetres, longest side first.
        sides.sort_unstable_by(|a, b| b.cmp(a));
        dimension["Length"] = json!(sides[0] * 10);
        dimension["Width"] = json!(sides[1] * 10);
        dimension["Height"] = json!(sides[2] * 10);
    }
    dimension
}

fn customs_body(customs: &Customs) -> Value {
    let kind = match customs.content {
        CustomsContent::SaleOfGoods | CustomsContent::Other => "Commercial Goods",
        CustomsContent::Gift => "Gift",
        CustomsContent::Documents => "Documents",
        CustomsContent::CommercialSample => "Commercial Sample",
        CustomsContent::ReturnedGoods => "Returned Goods",
    };
    let currency = if customs.currency.eq_ignore_ascii_case("USD") {
        "USS"
    } else {
        "EUR"
    };
    let content: Vec<Value> = customs
        .lines
        .iter()
        .map(|line| {
            let mut item = json!({
                "Description": line.description.chars().take(35).collect::<String>(),
                "Quantity": line.quantity.max(1),
                "Weight": line.weight_grams.max(1),
                "Value": format!("{:.2}", amount(line.value_cents)),
            });
            if let Some(code) = line.hs_code.as_deref().filter(|c| !c.is_empty()) {
                item["HSTariffNr"] = json!(code);
            }
            if let Some(origin) = line.origin_country.as_deref().filter(|c| !c.is_empty()) {
                item["CountryOfOrigin"] = json!(origin.to_ascii_uppercase());
            }
            item
        })
        .collect();
    let invoice = customs
        .invoice_number
        .as_deref()
        .is_some_and(|i| !i.trim().is_empty());
    let commercial = matches!(
        customs.content,
        CustomsContent::SaleOfGoods | CustomsContent::Other | CustomsContent::CommercialSample
    );
    let mut body = json!({
        "ShipmentType": kind,
        "Currency": currency,
        "HandleAsNonDeliverable": false,
        "Invoice": invoice || commercial,
        "Certificate": false,
        "License": false,
        "Content": content,
    });
    if let Some(number) = customs
        .invoice_number
        .as_deref()
        .filter(|i| !i.trim().is_empty())
    {
        body["InvoiceNr"] = json!(number.trim());
    }
    body
}

/// One `Shipments[]` entry, for the piece at `index`.
fn shipment_entry(
    request: &ShipmentRequest,
    resolved: &Resolved,
    index: usize,
    barcodes: &[String],
) -> Value {
    let piece = request.pieces[index];
    let mut addresses = vec![
        address_of(&request.recipient, "01"),
        address_of(&request.sender, "02"),
    ];
    let mut entry = Map::new();
    if let Some(point) = &request.service_point {
        let mut at = point.address.clone().unwrap_or_default();
        if at.company.as_deref().unwrap_or("").trim().is_empty() {
            at.company.clone_from(&point.name);
        }
        at.name = None;
        addresses.push(address_of(&at, "09"));
        entry.insert("DeliveryAddress".into(), json!("09"));
        if resolved.family != "3533" {
            // Belgian and EU points go through a partner network.
            entry.insert(
                "DownPartnerID".into(),
                json!(point.network_id.clone().unwrap_or_default()),
            );
            entry.insert("DownPartnerLocation".into(), json!(point.id));
        }
    }
    entry.insert("Addresses".into(), Value::Array(addresses));
    entry.insert("Contacts".into(), contacts(&request.recipient, "01"));
    entry.insert("Dimension".into(), dimension(&piece));
    entry.insert("ProductCodeDelivery".into(), json!(resolved.code));
    if !resolved.options.is_empty() {
        entry.insert(
            "ProductOptions".into(),
            Value::Array(
                resolved
                    .options
                    .iter()
                    .map(|(characteristic, option)| {
                        json!({ "Characteristic": characteristic, "Option": option })
                    })
                    .collect(),
            ),
        );
    }
    entry.insert("Reference".into(), json!(request.reference));
    if let Some(barcode) = barcodes.get(index) {
        entry.insert("Barcode".into(), json!(barcode));
        entry.insert(
            "Groups".into(),
            json!([{
                "GroupType": "03",
                "GroupSequence": index + 1,
                "GroupCount": barcodes.len(),
                "MainBarcode": barcodes[0],
            }]),
        );
    }
    if resolved.insured
        && let Some(cents) = request.options.insured_value_cents
    {
        entry.insert(
            "Amounts".into(),
            json!([{ "AmountType": "02", "Currency": "EUR", "Value": format!("{:.2}", amount(cents)) }]),
        );
    }
    if let Some(customs) = &request.customs {
        entry.insert("Customs".into(), customs_body(customs));
    }
    Value::Object(entry)
}

fn printer_type(format: LabelFormat) -> &'static str {
    match format {
        // PostNL's PDF label is A6; A4 merging needs a fixed slot per label,
        // so A4 accounts get the A6 PDF too.
        LabelFormat::PdfA6 | LabelFormat::PdfA4 => "GraphicFile|PDF",
        LabelFormat::Zpl => "Zebra|Generic ZPL II 200 dpi",
    }
}

/// One answered shipment.
struct Answered {
    barcode: String,
    label: LabelFile,
    customs: Option<LabelFile>,
}

fn decode(content: &str) -> Result<Vec<u8>, CarrierError> {
    base64::engine::general_purpose::STANDARD
        .decode(content.trim())
        .map_err(|_| CarrierError::unavailable("PostNL answered a label that is not base64"))
}

fn parse_label_answer(
    body: &Value,
    format: LabelFormat,
) -> Result<(Vec<Answered>, Vec<String>), CarrierError> {
    let mut answered = Vec::new();
    let mut warnings = Vec::new();
    let mut errors = Vec::new();
    for shipment in list(body.get("ResponseShipments")) {
        for error in list(shipment.get("Errors")) {
            errors.push(
                text(error, "Description")
                    .or_else(|| text(error, "Error"))
                    .unwrap_or_else(|| "PostNL refused a shipment".to_owned()),
            );
        }
        for warning in list(shipment.get("Warnings")) {
            if let Some(description) =
                text(warning, "Description").or_else(|| text(warning, "Message"))
            {
                warnings.push(description);
            }
        }
        let Some(barcode) = text(shipment, "Barcode") else {
            continue;
        };
        let mut label = None;
        let mut customs = None;
        for file in list(shipment.get("Labels")) {
            let Some(content) = text(file, "Content") else {
                continue;
            };
            let kind = text(file, "Labeltype").unwrap_or_else(|| "Label".to_owned());
            let bytes = decode(&content)?;
            match kind.as_str() {
                "Label" => label = Some(LabelFile::of(format, bytes)),
                "CN23" => customs = Some(LabelFile::pdf(bytes)),
                "CommercialInvoice" | "CP71" if customs.is_none() => {
                    customs = Some(LabelFile::pdf(bytes));
                }
                _ => {}
            }
        }
        let label = label.ok_or_else(|| {
            CarrierError::unavailable(format!(
                "PostNL answered shipment {barcode} without a label"
            ))
        })?;
        answered.push(Answered {
            barcode,
            label,
            customs,
        });
    }
    if !errors.is_empty() {
        return Err(CarrierError::Rejected(errors));
    }
    if answered.is_empty() {
        return Err(CarrierError::unavailable(
            "PostNL answered without a shipment",
        ));
    }
    Ok((answered, warnings))
}

/// Amsterdam's UTC offset on `date`: summer time from the last Sunday of
/// March to the last Sunday of October.
fn amsterdam_offset(date: Date) -> UtcOffset {
    let last_sunday = |month: Month| {
        let mut day = Date::from_calendar_date(date.year(), month, 31).unwrap_or(date);
        while day.weekday() != Weekday::Sunday {
            day = day.previous_day().unwrap_or(day);
        }
        day
    };
    let summer = date >= last_sunday(Month::March) && date < last_sunday(Month::October);
    UtcOffset::from_hms(if summer { 2 } else { 1 }, 0, 0).unwrap_or(UtcOffset::UTC)
}

/// `dd-mm-yyyy hh:mm:ss` in Amsterdam time.
fn message_timestamp(now: OffsetDateTime) -> String {
    let local = now.to_offset(amsterdam_offset(now.date()));
    local
        .format(format_description!(
            "[day]-[month]-[year] [hour]:[minute]:[second]"
        ))
        .unwrap_or_default()
}

/// PostNL's `dd-mm-yyyy hh:mm:ss`, Amsterdam time.
fn parse_timestamp(value: &str) -> Option<OffsetDateTime> {
    let local = PrimitiveDateTime::parse(
        value.trim(),
        format_description!("[day]-[month]-[year] [hour]:[minute]:[second]"),
    )
    .ok()?;
    Some(local.assume_offset(amsterdam_offset(local.date())))
}

/// Return-receipt events: the parcel is back with the sender.
const RETURNED_EVENTS: &[&str] = &["X21", "X22"];

fn status_of(status_code: &str, phase: &str, event_codes: &[String]) -> ParcelStatus {
    if event_codes
        .iter()
        .any(|c| RETURNED_EVENTS.contains(&c.as_str()))
    {
        return ParcelStatus::Returned;
    }
    match status_code {
        "1" | "13" | "14" => ParcelStatus::LabelCreated,
        "8" => ParcelStatus::Exception,
        "11" | "22" => ParcelStatus::Delivered,
        "12" => ParcelStatus::AtServicePoint,
        _ if phase == "4" => ParcelStatus::Delivered,
        _ => ParcelStatus::InTransit,
    }
}

fn parse_tracking(body: &Value, barcode: &str) -> Option<Tracking> {
    let shipments = list(body.pointer("/CompleteStatus/Shipment"));
    let shipment = shipments
        .iter()
        .find(|s| {
            text(s, "Barcode").is_some_and(|b| b.eq_ignore_ascii_case(barcode.trim()))
                || text(s, "MainBarcode").is_some_and(|b| b.eq_ignore_ascii_case(barcode.trim()))
        })
        .or_else(|| shipments.first())
        .copied()?;
    let status = shipment.get("Status")?;
    let mut events: Vec<TrackingEvent> = list(shipment.get("Event"))
        .into_iter()
        .map(|event| TrackingEvent {
            at: text(event, "TimeStamp").and_then(|t| parse_timestamp(&t)),
            code: text(event, "Code").unwrap_or_default(),
            description: text(event, "Description").unwrap_or_default(),
            location: text(event, "LocationCode"),
        })
        .collect();
    events.sort_by_key(|e| e.at);
    let codes: Vec<String> = events.iter().map(|e| e.code.clone()).collect();
    let status_code = text(status, "StatusCode").unwrap_or_default();
    let phase = text(status, "PhaseCode").unwrap_or_default();
    let parcel_status = status_of(&status_code, &phase, &codes);
    let at = text(status, "TimeStamp").and_then(|t| parse_timestamp(&t));
    let estimated_delivery = shipment
        .get("Expectation")
        .and_then(|e| text(e, "ETAFrom"))
        .and_then(|t| {
            parse_timestamp(&t).or_else(|| {
                OffsetDateTime::parse(&t, &time::format_description::well_known::Rfc3339).ok()
            })
        });
    if events.is_empty() {
        events.push(TrackingEvent {
            at,
            code: status_code,
            description: text(status, "StatusDescription").unwrap_or_default(),
            location: None,
        });
    }
    Some(Tracking {
        status: parcel_status,
        events,
        delivered_at: at.filter(|_| parcel_status == ParcelStatus::Delivered),
        estimated_delivery,
    })
}

/// `{ "Monday": { "string": ["08:00-18:00"] } }` → opening hours.
fn opening_hours(value: Option<&Value>) -> Vec<OpeningHours> {
    let days = [
        ("Monday", 1),
        ("Tuesday", 2),
        ("Wednesday", 3),
        ("Thursday", 4),
        ("Friday", 5),
        ("Saturday", 6),
        ("Sunday", 7),
    ];
    let mut hours = Vec::new();
    let Some(value) = value else {
        return hours;
    };
    for (day, weekday) in days {
        let slots = value
            .get(day)
            .map(|d| list(d.get("string")))
            .unwrap_or_default();
        for slot in slots {
            if let Some((opens, closes)) = slot.as_str().and_then(|s| s.split_once('-')) {
                hours.push(OpeningHours {
                    weekday,
                    opens: opens.trim().to_owned(),
                    closes: closes.trim().to_owned(),
                });
            }
        }
    }
    hours
}

fn parse_point(location: &Value) -> Option<ServicePoint> {
    let id = text(location, "LocationCode")?;
    let address = location.get("Address")?;
    let name = text(location, "Name").unwrap_or_else(|| id.clone());
    let options: Vec<String> = location
        .get("DeliveryOptions")
        .map(|d| list(d.get("string")))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let distance = location
        .get("Distance")
        .and_then(Value::as_f64)
        .filter(|d| d.is_finite() && *d >= 0.0)
        .map(|d| {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let meters = d.round().min(f64::from(u32::MAX)) as u32;
            meters
        });
    Some(ServicePoint {
        address: Address {
            company: Some(name.clone()),
            street: text(address, "Street").unwrap_or_default(),
            house_number: text(address, "HouseNr").unwrap_or_default(),
            house_number_suffix: text(address, "HouseNrExt"),
            postal_code: text(address, "Zipcode").unwrap_or_default(),
            city: text(address, "City").unwrap_or_default(),
            country: text(address, "Countrycode").unwrap_or_default(),
            ..Address::default()
        },
        name,
        distance_meters: distance,
        latitude: location.get("Latitude").and_then(Value::as_f64),
        longitude: location.get("Longitude").and_then(Value::as_f64),
        opening_hours: opening_hours(location.get("OpeningHours")),
        locker: options.iter().any(|o| o == "PA") && !options.iter().any(|o| o == "PG"),
        network_id: text(location, "RetailNetworkID"),
        id,
    })
}

fn error_of(response: &HttpResponse) -> CarrierError {
    let body = response.json();
    let fault = body
        .pointer("/fault/faultstring")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if response.status == 401
        || response.status == 403
        || fault.as_deref().is_some_and(|f| f.contains("ApiKey"))
    {
        return CarrierError::Unauthorized("PostNL refused the API key".to_owned());
    }
    if response.status == 429 {
        return CarrierError::unavailable("PostNL is limiting requests; try again in a minute");
    }
    let mut messages: Vec<String> = list(body.get("Errors"))
        .into_iter()
        .filter_map(|e| {
            text(e, "Description")
                .or_else(|| text(e, "ErrorMsg"))
                .or_else(|| text(e, "Error"))
        })
        .collect();
    if let Some(error) = body.get("Error")
        && let Some(description) = text(error, "ErrorDescription")
    {
        messages.push(description);
    }
    for shipment in list(body.get("ResponseShipments")) {
        for error in list(shipment.get("Errors")) {
            if let Some(description) = text(error, "Description").or_else(|| text(error, "Error")) {
                messages.push(description);
            }
        }
    }
    if response.status >= 500 || response.status == 0 {
        return CarrierError::unavailable(format!(
            "PostNL failed ({}): {}",
            response.status,
            fault.unwrap_or_else(|| http::body_excerpt(response))
        ));
    }
    if messages.is_empty() {
        messages.push(fault.unwrap_or_else(|| {
            let excerpt = http::body_excerpt(response);
            if excerpt.is_empty() {
                format!("PostNL refused the request ({})", response.status)
            } else {
                excerpt
            }
        }));
    }
    CarrierError::Rejected(messages)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::testing::{Fake, piece, request};
    use crate::types::{CustomsLine, ServicePointRef};

    fn client(fake: &Arc<Fake>) -> PostNl {
        PostNl::with_base(
            Credentials {
                api_key: "key".into(),
                customer_code: "DEVC".into(),
                customer_number: "11223344".into(),
                collection_location: Some("123456".into()),
                sandbox: true,
            },
            fake.outbound(),
            "https://postnl.test",
        )
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn answer(barcodes: &[&str]) -> Value {
        json!({ "ResponseShipments": barcodes.iter().map(|b| json!({
            "Barcode": b, "ProductCodeDelivery": "3085",
            "Labels": [{ "Content": b64(format!("PDF {b}").as_bytes()), "Labeltype": "Label", "OutputType": "PDF" }],
            "Errors": [], "Warnings": []
        })).collect::<Vec<_>>() })
    }

    const LABEL: &str = "POST https://postnl.test/shipment/v2_2/label?confirm=true";

    #[tokio::test]
    async fn one_piece_lets_postnl_make_the_barcode() {
        let fake = Fake::new();
        fake.answer(LABEL, 200, &answer(&["3SDEVC000000001"]));
        let mut req = request();
        req.options.signature = true;
        let created = client(&fake).create_shipment(&req).await.expect("created");
        assert_eq!(created.product, "3189");
        assert_eq!(created.pieces[0].tracking_number, "3SDEVC000000001");
        assert_eq!(created.pieces[0].label.bytes, b"PDF 3SDEVC000000001");
        let sent = fake.body_of(LABEL);
        assert_eq!(sent["Customer"]["CustomerCode"], "DEVC");
        assert_eq!(sent["Customer"]["CollectionLocation"], "123456");
        assert_eq!(sent["Message"]["Printertype"], "GraphicFile|PDF");
        let shipment = &sent["Shipments"][0];
        assert_eq!(shipment["ProductCodeDelivery"], "3189");
        assert!(shipment.get("Barcode").is_none());
        assert_eq!(shipment["Addresses"][0]["AddressType"], "01");
        assert_eq!(shipment["Addresses"][0]["Street"], "Damrak");
        assert_eq!(shipment["Addresses"][0]["HouseNr"], "1");
        assert_eq!(shipment["Addresses"][0]["HouseNrExt"], "A");
        assert_eq!(shipment["Addresses"][0]["Zipcode"], "1012LG");
        assert_eq!(shipment["Contacts"][0]["Email"], "anna@example.com");
        assert_eq!(shipment["Dimension"]["Weight"], 1000);
        assert_eq!(fake.header_of(LABEL, "apikey").as_deref(), Some("key"));
    }

    #[tokio::test]
    async fn multi_collo_groups_pieces_under_the_first_barcode() {
        let fake = Fake::new();
        fake.answer_prefix(
            "GET https://postnl.test/shipment/v1_1/barcode?",
            200,
            &json!({ "Barcode": "3SDEVC000000010" }),
        );
        fake.answer(LABEL, 200, &answer(&["3SDEVC000000010", "3SDEVC000000010"]));
        let mut req = request();
        req.pieces = vec![piece(1000), piece(2000)];
        let created = client(&fake).create_shipment(&req).await.expect("created");
        assert_eq!(created.pieces.len(), 2);
        assert_eq!(created.pieces[1].collo_number, 2);
        assert_eq!(
            fake.count("GET https://postnl.test/shipment/v1_1/barcode?"),
            2
        );
        assert!(fake.called_with("Serie=000000000-999999999"));
        let sent = fake.body_of(LABEL);
        assert_eq!(sent["Shipments"][1]["Groups"][0]["GroupType"], "03");
        assert_eq!(sent["Shipments"][1]["Groups"][0]["GroupSequence"], 2);
        assert_eq!(sent["Shipments"][1]["Groups"][0]["GroupCount"], 2);
    }

    #[tokio::test]
    async fn pickup_points_add_the_point_address() {
        let fake = Fake::new();
        fake.answer(LABEL, 200, &answer(&["3SDEVC000000002"]));
        let mut req = request();
        req.service_point = Some(ServicePointRef {
            id: "163043".into(),
            name: Some("Primera Damrak".into()),
            address: Some(Address {
                street: "Damrak".into(),
                house_number: "5".into(),
                postal_code: "1012LG".into(),
                city: "Amsterdam".into(),
                country: "NL".into(),
                ..Address::default()
            }),
            network_id: Some("PNPNL-01".into()),
        });
        let created = client(&fake).create_shipment(&req).await.expect("created");
        assert_eq!(created.product, "3533");
        let shipment = &fake.body_of(LABEL)["Shipments"][0];
        assert_eq!(shipment["DeliveryAddress"], "09");
        assert_eq!(shipment["Addresses"][2]["AddressType"], "09");
        assert_eq!(shipment["Addresses"][2]["CompanyName"], "Primera Damrak");
        assert!(shipment.get("DownPartnerID").is_none());
    }

    #[tokio::test]
    async fn customs_go_with_a_parcel_outside_the_eu() {
        let fake = Fake::new();
        let mut body = answer(&["CD123456789NL"]);
        body["ResponseShipments"][0]["Labels"]
            .as_array_mut()
            .expect("labels")
            .push(json!({ "Content": b64(b"CN23"), "Labeltype": "CN23", "OutputType": "PDF" }));
        fake.answer(LABEL, 200, &body);
        let mut req = request();
        req.recipient.country = "CH".into();
        req.recipient.postal_code = "8001".into();
        req.recipient.city = "Zürich".into();
        req.recipient.street = "Bahnhofstrasse".into();
        let error = client(&fake)
            .create_shipment(&req)
            .await
            .expect_err("customs needed");
        assert!(matches!(error, CarrierError::Invalid(_)));
        req.customs = Some(Customs {
            invoice_number: Some("ORD-1001".into()),
            currency: "EUR".into(),
            lines: vec![CustomsLine {
                description: "Cotton T-shirt".into(),
                quantity: 2,
                value_cents: 5998,
                weight_grams: 400,
                hs_code: Some("610910".into()),
                origin_country: Some("pt".into()),
            }],
            ..Customs::default()
        });
        let created = client(&fake).create_shipment(&req).await.expect("created");
        assert_eq!(created.product, "4909");
        assert_eq!(
            created.customs_document.map(|d| d.bytes),
            Some(b"CN23".to_vec())
        );
        let shipment = &fake.body_of(LABEL)["Shipments"][0];
        assert_eq!(shipment["ProductOptions"][0]["Characteristic"], "005");
        assert_eq!(shipment["Customs"]["ShipmentType"], "Commercial Goods");
        assert_eq!(shipment["Customs"]["Invoice"], true);
        assert_eq!(shipment["Customs"]["Content"][0]["HSTariffNr"], "610910");
        assert_eq!(shipment["Customs"]["Content"][0]["Value"], "59.98");
        assert_eq!(shipment["Customs"]["Content"][0]["CountryOfOrigin"], "PT");
    }

    #[tokio::test]
    async fn a_return_label_is_a_3285_shipment_from_the_customer() {
        let fake = Fake::new();
        fake.answer(LABEL, 200, &answer(&["3SDEVC000000003"]));
        fake.answer(LABEL, 200, &answer(&["3SDEVC000000004"]));
        fake.answer_prefix(
            "GET https://postnl.test/shipment/v1_1/barcode?",
            200,
            &json!({ "Barcode": "3SDEVC000000004" }),
        );
        let mut req = request();
        req.return_label = true;
        let created = client(&fake).create_shipment(&req).await.expect("created");
        assert_eq!(
            created.return_piece.map(|p| p.tracking_number),
            Some("3SDEVC000000004".into())
        );
        let bodies = fake.bodies_of(LABEL);
        assert_eq!(bodies.len(), 2);
        let back = &bodies[1]["Shipments"][0];
        assert_eq!(back["ProductCodeDelivery"], "3285");
        assert_eq!(back["Barcode"], "3SDEVC000000004");
        assert_eq!(back["Addresses"][0]["CompanyName"], "Weld Demo BV");
        assert_eq!(back["Addresses"][1]["AddressType"], "02");
        assert_eq!(back["Contacts"][0]["ContactType"], "02");
    }

    #[tokio::test]
    async fn refusals_carry_postnls_messages() {
        let fake = Fake::new();
        fake.answer(
            LABEL,
            400,
            &json!({ "Errors": [{ "Error": "Validation failed", "Code": "1280202", "Description": "Incorrect address specified in address type Sender" }] }),
        );
        let error = client(&fake)
            .create_shipment(&request())
            .await
            .expect_err("rejected");
        assert_eq!(
            error,
            CarrierError::Rejected(vec![
                "Incorrect address specified in address type Sender".into()
            ])
        );
        let fake = Fake::new();
        fake.answer_prefix(
            "GET https://postnl.test/shipment/v1_1/barcode?",
            401,
            &json!({ "fault": { "faultstring": "Invalid ApiKey" } }),
        );
        assert!(matches!(
            client(&fake).verify().await,
            Err(CarrierError::Unauthorized(_))
        ));
    }

    #[test]
    fn options_pick_the_product_code() {
        let code = |f: &dyn Fn(&mut ShipmentRequest)| {
            let mut req = request();
            f(&mut req);
            resolve(&req).map(|r| r.code)
        };
        assert_eq!(code(&|_| {}), Ok("3085"));
        assert_eq!(code(&|r| r.options.no_neighbour = true), Ok("3385"));
        assert_eq!(
            code(&|r| {
                r.options.signature = true;
                r.options.no_neighbour = true;
            }),
            Ok("3089")
        );
        assert_eq!(code(&|r| r.options.age_check = true), Ok("3438"));
        assert_eq!(
            code(&|r| r.options.insured_value_cents = Some(50_000)),
            Ok("3087")
        );
        assert_eq!(code(&|r| r.options.mailbox = true), Ok("2928"));
        assert_eq!(code(&|r| r.recipient.country = "BE".into()), Ok("4946"));
        assert_eq!(code(&|r| r.recipient.country = "DE".into()), Ok("4907"));
        assert_eq!(code(&|r| r.recipient.country = "US".into()), Ok("4909"));
        assert!(matches!(
            code(&|r| {
                r.recipient.country = "DE".into();
                r.options.signature = true;
            }),
            Err(CarrierError::NotSupported(_))
        ));
    }

    #[test]
    fn tracking_reads_status_codes_and_events() {
        let body = json!({ "CompleteStatus": { "Shipment": {
            "MainBarcode": "3SDEVC000000001", "Barcode": "3SDEVC000000001",
            "Status": { "TimeStamp": "20-11-2026 14:02:00", "StatusCode": "11", "StatusDescription": "Bezorgd", "PhaseCode": "4" },
            "Event": [
                { "Code": "A01", "Description": "Zending is aangemeld", "TimeStamp": "19-11-2026 09:00:00" },
                { "Code": "I01", "Description": "Zending is bezorgd", "LocationCode": "888888", "TimeStamp": "20-11-2026 14:02:00" }
            ],
            "Expectation": {}
        } } });
        let tracking = parse_tracking(&body, "3SDEVC000000001").expect("known");
        assert_eq!(tracking.status, ParcelStatus::Delivered);
        assert_eq!(tracking.events.len(), 2);
        assert_eq!(tracking.events[1].code, "I01");
        // 14:02 in Amsterdam in November is 13:02 UTC.
        assert_eq!(
            tracking
                .delivered_at
                .map(|d| d.to_offset(UtcOffset::UTC).hour()),
            Some(13)
        );
        let one_event = json!({ "CompleteStatus": { "Shipment": {
            "Barcode": "X", "Status": { "StatusCode": "12", "PhaseCode": "4" },
            "Event": { "Code": "J05", "Description": "Afhaalpunt", "TimeStamp": "20-11-2026 10:00:00" }
        } } });
        assert_eq!(
            parse_tracking(&one_event, "X").map(|t| t.status),
            Some(ParcelStatus::AtServicePoint)
        );
        let unknown = json!({ "CompleteStatus": {}, "Warnings": [{ "Message": "No shipment found", "Code": "2" }] });
        assert!(parse_tracking(&unknown, "X").is_none());
        assert_eq!(status_of("8", "3", &["X21".into()]), ParcelStatus::Returned);
        assert_eq!(status_of("8", "3", &[]), ParcelStatus::Exception);
        assert_eq!(status_of("1", "1", &[]), ParcelStatus::LabelCreated);
        assert_eq!(status_of("5", "2", &[]), ParcelStatus::InTransit);
    }

    #[test]
    fn locations_read_points_and_hours() {
        let point = parse_point(&json!({
            "LocationCode": 163_043, "Name": "Primera Damrak", "Distance": 102,
            "Latitude": 52.37, "Longitude": 4.89,
            "Address": { "Street": "Damrak", "HouseNr": 5, "Zipcode": "1012LG", "City": "Amsterdam", "Countrycode": "NL" },
            "OpeningHours": { "Monday": { "string": ["08:00-18:00"] }, "Sunday": {} },
            "DeliveryOptions": { "string": ["PG", "DO"] },
            "RetailNetworkID": "PNPNL-01"
        }))
        .expect("point");
        assert_eq!(point.id, "163043");
        assert_eq!(point.address.house_number, "5");
        assert_eq!(
            point.opening_hours,
            vec![OpeningHours {
                weekday: 1,
                opens: "08:00".into(),
                closes: "18:00".into()
            }]
        );
        assert!(!point.locker);
        assert_eq!(point.network_id.as_deref(), Some("PNPNL-01"));
    }

    #[test]
    fn timestamps_and_urls() {
        let summer = time::macros::datetime!(2026-07-01 10:00 UTC);
        assert_eq!(message_timestamp(summer), "01-07-2026 12:00:00");
        let winter = time::macros::datetime!(2026-11-24 10:00 UTC);
        assert_eq!(message_timestamp(winter), "24-11-2026 11:00:00");
        assert_eq!(
            tracking_url(&TrackRef {
                tracking_number: "3SDEVC000000001".into(),
                postal_code: "1012 lg".into(),
                country: "nl".into(),
            }),
            "https://jouw.postnl.nl/track-and-trace/3SDEVC000000001-NL-1012LG"
        );
        assert_eq!(products("BE", "NL"), Vec::<Product>::new());
        assert_eq!(products("NL", "NL").len(), 3);
        assert!(products("NL", "DE")[0].service_point);
    }
}
