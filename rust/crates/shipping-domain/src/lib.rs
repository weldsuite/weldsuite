//! Parcel carriers behind one port (ADR STASH-011): what WeldStash needs to
//! put a packed pick list on the road and follow it.
//!
//! - [`CarrierClient`]: one enum over the adapters, with one method per
//!   capability (verify credentials, products on a route, labels for every
//!   piece with a return label and customs, a return label on its own,
//!   tracking, service points, the public tracking URL). A new carrier is a
//!   new variant; the compiler then points at every capability.
//! - [`postnl`] and [`dhl_parcel_nl`]: the adapters. They build the
//!   carrier's requests and read its answers, and call it only through
//!   [`OutboundHttp`], so tests replay recorded answers. No database.
//! - [`types`]: the carrier-neutral request and answer shapes;
//!   [`address::split_street`] for orders that keep one address line;
//!   [`countries`] for customs and the rate card's zones; [`rates`] for
//!   labels on WeldSuite's contract (ADR STASH-012).
//!
//! Plan: `weldsuite-documentation/plans/weldstash-carriers.md`.

pub mod address;
pub mod countries;
pub mod dhl_parcel_nl;
mod error;
mod http;
pub mod postnl;
pub mod rates;
#[cfg(test)]
mod testing;
pub mod types;

use serde::Serialize;
use weldsuite_ports::OutboundHttp;

pub use error::CarrierError;
pub use types::{
    Address, CreatedPiece, CreatedShipment, Customs, CustomsContent, CustomsLine, LabelFile,
    LabelFormat, OpeningHours, ParcelStatus, PieceSpec, PointQuery, Product, ServicePoint,
    ServicePointRef, ShipmentOptions, ShipmentRequest, TrackRef, Tracking, TrackingEvent,
};

/// The carriers WeldStash ships with (`carriers.code`, `parcels.carrier_code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum CarrierCode {
    #[serde(rename = "postnl")]
    PostNl,
    #[serde(rename = "dhl_parcel_nl")]
    DhlParcelNl,
}

impl CarrierCode {
    pub const ALL: [Self; 2] = [Self::PostNl, Self::DhlParcelNl];

    pub fn parse(code: &str) -> Option<Self> {
        match code {
            "postnl" => Some(Self::PostNl),
            "dhl_parcel_nl" => Some(Self::DhlParcelNl),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PostNl => "postnl",
            Self::DhlParcelNl => "dhl_parcel_nl",
        }
    }

    /// The carrier's name, as the label and the parcel list show it.
    pub fn name(self) -> &'static str {
        match self {
            Self::PostNl => "PostNL",
            Self::DhlParcelNl => "DHL Parcel",
        }
    }

    /// The public track-and-trace page for a piece, without a client (the
    /// account may be gone).
    pub fn tracking_url(self, piece: &TrackRef) -> String {
        match self {
            Self::PostNl => postnl::tracking_url(piece),
            Self::DhlParcelNl => dhl_parcel_nl::tracking_url(piece),
        }
    }

    /// The environment variables that hold WeldSuite's own contract
    /// (ADR STASH-012), `SHIPPING_POSTNL_*` and `SHIPPING_DHL_PARCEL_NL_*`.
    fn env_prefix(self) -> &'static str {
        match self {
            Self::PostNl => "SHIPPING_POSTNL_",
            Self::DhlParcelNl => "SHIPPING_DHL_PARCEL_NL_",
        }
    }
}

/// An account's credentials, per carrier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credentials {
    PostNl(postnl::Credentials),
    DhlParcelNl(dhl_parcel_nl::Credentials),
}

impl Credentials {
    pub fn code(&self) -> CarrierCode {
        match self {
            Self::PostNl(_) => CarrierCode::PostNl,
            Self::DhlParcelNl(_) => CarrierCode::DhlParcelNl,
        }
    }

    /// WeldSuite's contract for `code`, from the install's environment, when
    /// its variables are set.
    pub fn weldsuite(code: CarrierCode, env: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let prefix = code.env_prefix();
        let var = |name: &str| {
            env(&format!("{prefix}{name}"))
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let sandbox = var("SANDBOX").is_some_and(|v| v == "true" || v == "1");
        match code {
            CarrierCode::PostNl => Some(Self::PostNl(postnl::Credentials {
                api_key: var("API_KEY")?,
                customer_code: var("CUSTOMER_CODE")?,
                customer_number: var("CUSTOMER_NUMBER")?,
                collection_location: var("COLLECTION_LOCATION"),
                sandbox,
            })),
            CarrierCode::DhlParcelNl => Some(Self::DhlParcelNl(dhl_parcel_nl::Credentials {
                user_id: var("USER_ID")?,
                api_key: var("API_KEY")?,
                account_id: var("ACCOUNT_ID").unwrap_or_default(),
                sandbox,
            })),
        }
    }
}

/// One credential field the platform's form asks for (labels come from the
/// platform's translations, by `key`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialField {
    pub key: &'static str,
    /// Stored encrypted and never shown again.
    pub secret: bool,
    pub required: bool,
}

/// What the platform shows about a carrier.
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent capabilities, as the API answers them"
)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarrierInfo {
    pub code: CarrierCode,
    pub name: &'static str,
    pub website: &'static str,
    pub credential_fields: Vec<CredentialField>,
    /// Several pieces per shipment.
    pub multi_collo: bool,
    pub service_points: bool,
    pub return_labels: bool,
    pub customs: bool,
    pub label_formats: Vec<&'static str>,
}

const fn field(key: &'static str, secret: bool, required: bool) -> CredentialField {
    CredentialField {
        key,
        secret,
        required,
    }
}

/// Every carrier and what its account form needs.
pub fn catalog() -> Vec<CarrierInfo> {
    vec![
        CarrierInfo {
            code: CarrierCode::PostNl,
            name: CarrierCode::PostNl.name(),
            website: "https://www.postnl.nl",
            credential_fields: vec![
                field("apiKey", true, true),
                field("customerCode", false, true),
                field("customerNumber", false, true),
                field("collectionLocation", false, false),
            ],
            multi_collo: true,
            service_points: true,
            return_labels: true,
            customs: true,
            label_formats: vec!["pdf_a6", "zpl"],
        },
        CarrierInfo {
            code: CarrierCode::DhlParcelNl,
            name: CarrierCode::DhlParcelNl.name(),
            website: "https://www.dhlparcel.nl",
            credential_fields: vec![
                field("userId", false, true),
                field("apiKey", true, true),
                field("accountId", false, false),
            ],
            multi_collo: true,
            service_points: true,
            return_labels: true,
            customs: true,
            label_formats: vec!["pdf_a6", "pdf_a4", "zpl"],
        },
    ]
}

/// A client for one carrier account.
#[derive(Debug)]
pub enum CarrierClient {
    PostNl(postnl::PostNl),
    DhlParcelNl(dhl_parcel_nl::DhlParcelNl),
}

impl CarrierClient {
    pub fn new(credentials: Credentials, http: OutboundHttp) -> Self {
        match credentials {
            Credentials::PostNl(c) => Self::PostNl(postnl::PostNl::new(c, http)),
            Credentials::DhlParcelNl(c) => {
                Self::DhlParcelNl(dhl_parcel_nl::DhlParcelNl::new(c, http))
            }
        }
    }

    pub fn code(&self) -> CarrierCode {
        match self {
            Self::PostNl(_) => CarrierCode::PostNl,
            Self::DhlParcelNl(_) => CarrierCode::DhlParcelNl,
        }
    }

    /// The credentials work.
    pub async fn verify(&self) -> Result<(), CarrierError> {
        match self {
            Self::PostNl(c) => c.verify().await,
            Self::DhlParcelNl(c) => c.verify().await,
        }
    }

    /// What the carrier offers from `from` to `to` (a business when
    /// `business`).
    pub async fn products(
        &self,
        from: &str,
        to: &str,
        business: bool,
    ) -> Result<Vec<Product>, CarrierError> {
        match self {
            Self::PostNl(c) => Ok(c.products(from, to)),
            Self::DhlParcelNl(c) => c.products(from, to, business).await,
        }
    }

    /// Labels for every piece, with the return label and the customs
    /// document when asked. Sent once: a failed call is not retried.
    pub async fn create_shipment(
        &self,
        request: &ShipmentRequest,
    ) -> Result<CreatedShipment, CarrierError> {
        match self {
            Self::PostNl(c) => c.create_shipment(request).await,
            Self::DhlParcelNl(c) => c.create_shipment(request).await,
        }
    }

    /// A return label on its own: `request.sender` is the customer,
    /// `request.recipient` the merchant.
    pub async fn create_return(
        &self,
        request: &ShipmentRequest,
    ) -> Result<CreatedShipment, CarrierError> {
        match self {
            Self::PostNl(c) => c.create_return(request).await,
            Self::DhlParcelNl(c) => c.create_return(request).await,
        }
    }

    /// The piece's status now; `None` when the carrier doesn't know it yet.
    pub async fn track(&self, piece: &TrackRef) -> Result<Option<Tracking>, CarrierError> {
        match self {
            Self::PostNl(c) => c.track(piece).await,
            Self::DhlParcelNl(c) => c.track(piece).await,
        }
    }

    /// Pickup points near an address.
    pub async fn service_points(
        &self,
        query: &PointQuery,
    ) -> Result<Vec<ServicePoint>, CarrierError> {
        match self {
            Self::PostNl(c) => c.service_points(query).await,
            Self::DhlParcelNl(c) => c.service_points(query).await,
        }
    }

    pub fn tracking_url(&self, piece: &TrackRef) -> String {
        self.code().tracking_url(piece)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn codes_round_trip() {
        for code in CarrierCode::ALL {
            assert_eq!(CarrierCode::parse(code.as_str()), Some(code));
        }
        assert_eq!(CarrierCode::parse("ups"), None);
        assert_eq!(catalog().len(), CarrierCode::ALL.len());
    }

    #[test]
    fn weldsuites_contract_needs_every_required_variable() {
        let env: HashMap<&str, &str> = [
            ("SHIPPING_POSTNL_API_KEY", "k"),
            ("SHIPPING_POSTNL_CUSTOMER_CODE", "DEVC"),
            ("SHIPPING_POSTNL_CUSTOMER_NUMBER", "11223344"),
            ("SHIPPING_POSTNL_SANDBOX", "true"),
            ("SHIPPING_DHL_PARCEL_NL_USER_ID", "u"),
        ]
        .into_iter()
        .collect();
        let read = |name: &str| env.get(name).map(|v| (*v).to_owned());
        let postnl = Credentials::weldsuite(CarrierCode::PostNl, read).expect("postnl");
        assert!(
            matches!(&postnl, Credentials::PostNl(c) if c.sandbox && c.collection_location.is_none())
        );
        assert_eq!(postnl.code(), CarrierCode::PostNl);
        assert_eq!(Credentials::weldsuite(CarrierCode::DhlParcelNl, read), None);
    }
}
