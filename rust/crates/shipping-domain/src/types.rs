//! The carrier-neutral shapes every adapter takes and answers.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// A postal address with the street and house number apart, as both
/// carriers want them (see [`crate::address::split_street`] for orders that
/// store one free-text line).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Address {
    /// The person (first and last name in one string).
    pub name: Option<String>,
    pub company: Option<String>,
    pub street: String,
    pub house_number: String,
    pub house_number_suffix: Option<String>,
    /// Whatever the address had on a second line (building, floor, c/o).
    pub address_line_2: Option<String>,
    pub postal_code: String,
    pub city: String,
    pub state: Option<String>,
    /// ISO 3166 alpha-2, upper case.
    pub country: String,
    pub email: Option<String>,
    pub phone: Option<String>,
}

impl Address {
    /// A company name makes it a business address.
    pub fn is_business(&self) -> bool {
        self.company
            .as_deref()
            .is_some_and(|c| !c.trim().is_empty())
    }

    /// `(first, last)`: the first word and the rest, or `("", whole)` for a
    /// single word. Carriers that want the two apart get this.
    pub fn first_and_last_name(&self) -> (String, String) {
        let name = self.name.as_deref().unwrap_or("").trim();
        match name.split_once(char::is_whitespace) {
            Some((first, rest)) => (first.to_owned(), rest.trim().to_owned()),
            None => (String::new(), name.to_owned()),
        }
    }

    /// The postal code without spaces, upper case (`1012 AB` → `1012AB`),
    /// as tracking lookups want it.
    pub fn compact_postal_code(&self) -> String {
        compact_postal_code(&self.postal_code)
    }
}

/// `1012 ab` → `1012AB`.
pub fn compact_postal_code(postal_code: &str) -> String {
    postal_code
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}

/// One box: its weight and, when known, its outside dimensions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceSpec {
    pub weight_grams: u32,
    pub length_cm: Option<u32>,
    pub width_cm: Option<u32>,
    pub height_cm: Option<u32>,
}

/// Delivery services on top of the product.
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent switches, as the API takes them"
)]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShipmentOptions {
    /// Signature on delivery.
    pub signature: bool,
    /// The receiver must show they are 18 or older.
    pub age_check: bool,
    /// Never hand it to a neighbour.
    pub no_neighbour: bool,
    pub evening_delivery: bool,
    pub saturday_delivery: bool,
    /// Fits through the letterbox (PostNL mailbox parcel, DHL `BP`).
    pub mailbox: bool,
    /// Insured value in cents (EUR).
    pub insured_value_cents: Option<u64>,
}

/// A pickup point the parcel is delivered to.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePointRef {
    /// The carrier's id (PostNL `LocationCode`, DHL parcel-shop id).
    pub id: String,
    pub name: Option<String>,
    /// The point's address; PostNL puts it on the label.
    pub address: Option<Address>,
    /// PostNL's `RetailNetworkID` (`PNPNL-01`), when the lookup gave one.
    pub network_id: Option<String>,
}

/// What a customs declaration says the parcel holds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomsContent {
    #[default]
    SaleOfGoods,
    Gift,
    Documents,
    CommercialSample,
    ReturnedGoods,
    Other,
}

/// One line of a customs declaration.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomsLine {
    pub description: String,
    pub quantity: u32,
    /// The line's total value in cents of [`Customs::currency`].
    pub value_cents: u64,
    /// The line's total net weight.
    pub weight_grams: u32,
    /// HS tariff code (6 to 10 digits).
    pub hs_code: Option<String>,
    /// Where the goods were made (ISO alpha-2).
    pub origin_country: Option<String>,
}

/// A customs declaration (CN23) for a destination outside the EU customs
/// territory ([`crate::countries::customs_required`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Customs {
    pub content: CustomsContent,
    pub invoice_number: Option<String>,
    /// ISO 4217 (EUR, USD, GBP, CHF, NOK).
    pub currency: String,
    pub lines: Vec<CustomsLine>,
    /// Shipping charged to the buyer, in cents.
    pub shipping_fee_cents: Option<u64>,
}

/// The label file the warehouse prints.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelFormat {
    /// A6 PDF, one label per page (thermal printers that take PDF).
    #[default]
    PdfA6,
    /// A4 PDF (office printers).
    PdfA4,
    /// ZPL II for Zebra-type printers.
    Zpl,
}

impl LabelFormat {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pdf_a6" => Some(Self::PdfA6),
            "pdf_a4" => Some(Self::PdfA4),
            "zpl" => Some(Self::Zpl),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PdfA6 => "pdf_a6",
            Self::PdfA4 => "pdf_a4",
            Self::Zpl => "zpl",
        }
    }

    pub fn is_pdf(self) -> bool {
        !matches!(self, Self::Zpl)
    }
}

/// What to ship: one call makes the labels for every piece, and the return
/// label when asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShipmentRequest {
    /// Printed on the label and stored at the carrier (order number).
    pub reference: String,
    pub sender: Address,
    pub recipient: Address,
    /// Where returns go; the sender when absent.
    pub return_address: Option<Address>,
    /// The carrier's product code; `None` lets the adapter choose the
    /// standard product for the route.
    pub product: Option<String>,
    pub pieces: Vec<PieceSpec>,
    pub options: ShipmentOptions,
    pub service_point: Option<ServicePointRef>,
    /// Also make a return label ("label in the box").
    pub return_label: bool,
    pub customs: Option<Customs>,
    pub label_format: LabelFormat,
    /// Unique per request and stable across a retry of the same request.
    pub idempotency_key: String,
}

/// A file the carrier made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelFile {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    /// `pdf` or `zpl`.
    pub extension: &'static str,
}

impl LabelFile {
    pub fn pdf(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            content_type: "application/pdf",
            extension: "pdf",
        }
    }

    pub fn zpl(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            content_type: "application/zpl",
            extension: "zpl",
        }
    }

    pub fn of(format: LabelFormat, bytes: Vec<u8>) -> Self {
        if format.is_pdf() {
            Self::pdf(bytes)
        } else {
            Self::zpl(bytes)
        }
    }
}

/// One piece the carrier made a label for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedPiece {
    /// 1..n.
    pub collo_number: u32,
    pub tracking_number: String,
    /// The carrier's own id when it differs (DHL label id).
    pub carrier_reference: Option<String>,
    pub label: LabelFile,
}

/// What [`crate::CarrierClient::create_shipment`] made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedShipment {
    /// The product the carrier used.
    pub product: String,
    pub pieces: Vec<CreatedPiece>,
    pub return_piece: Option<CreatedPiece>,
    /// The CN23 / commercial invoice, when the carrier made one apart from
    /// the label.
    pub customs_document: Option<LabelFile>,
    /// Non-fatal remarks from the carrier.
    pub warnings: Vec<String>,
}

/// Where a parcel is, in WeldStash's words (`parcels.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParcelStatus {
    /// The label exists; the carrier hasn't scanned it.
    LabelCreated,
    InTransit,
    /// Waiting at a pickup point for the receiver.
    AtServicePoint,
    Delivered,
    /// A delivery problem the carrier reports (address unknown, damaged…).
    Exception,
    /// Back with the sender.
    Returned,
}

impl ParcelStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LabelCreated => "label_created",
            Self::InTransit => "in_transit",
            Self::AtServicePoint => "at_service_point",
            Self::Delivered => "delivered",
            Self::Exception => "exception",
            Self::Returned => "returned",
        }
    }

    /// No more updates are expected.
    pub fn is_final(self) -> bool {
        matches!(self, Self::Delivered | Self::Returned)
    }
}

/// One scan or status change at the carrier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackingEvent {
    pub at: Option<OffsetDateTime>,
    /// The carrier's code (PostNL `01A`, DHL `DELIVERED`).
    pub code: String,
    pub description: String,
    pub location: Option<String>,
}

/// What the carrier says about one piece now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tracking {
    pub status: ParcelStatus,
    /// Oldest first.
    pub events: Vec<TrackingEvent>,
    pub delivered_at: Option<OffsetDateTime>,
    pub estimated_delivery: Option<OffsetDateTime>,
}

/// Which piece to look up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackRef {
    pub tracking_number: String,
    /// The recipient's postal code (DHL needs it for the full answer).
    pub postal_code: String,
    pub country: String,
}

/// A service point search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointQuery {
    pub country: String,
    pub postal_code: String,
    pub house_number: Option<String>,
    pub city: Option<String>,
    pub limit: u32,
}

/// Opening hours of one weekday (1 = Monday).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpeningHours {
    pub weekday: u8,
    /// `HH:MM`.
    pub opens: String,
    pub closes: String,
}

/// A pickup point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePoint {
    pub id: String,
    pub name: String,
    pub address: Address,
    pub distance_meters: Option<u32>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub opening_hours: Vec<OpeningHours>,
    /// A parcel locker rather than a shop.
    pub locker: bool,
    pub network_id: Option<String>,
}

/// A product the carrier offers on a route.
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent capabilities, as the API answers them"
)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub code: String,
    pub name: String,
    /// Delivered to a pickup point.
    pub service_point: bool,
    /// More than one piece per shipment.
    pub multi_collo: bool,
    /// Fits through the letterbox.
    pub mailbox: bool,
    /// The product a return label uses.
    pub returns: bool,
    /// Options it takes (`signature`, `ageCheck`, `noNeighbour`, …).
    pub options: Vec<String>,
}
