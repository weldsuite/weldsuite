//! The rate card for labels on WeldSuite's contract (ADR STASH-012): credits
//! per carrier product, destination zone and weight band, plus surcharges.
//! Staff keep it in master `system_settings` under [`RATE_CARD_KEY`]; a
//! product without a price for the route is not offered on WeldSuite's
//! contract.
//!
//! ```json
//! { "carriers": { "postnl": {
//!     "products": { "3085": { "NL": [{ "maxWeightGrams": 2000, "credits": 495 }] } },
//!     "surcharges": { "returnLabel": 450, "signature": 95, "ageCheck": 150 } } } }
//! ```

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::countries::Zone;
use crate::types::{PieceSpec, ShipmentOptions};

/// The `system_settings` key of the rate card.
pub const RATE_CARD_KEY: &str = "weldstash.shipping_rates";

/// One weight band: up to and including `max_weight_grams`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Band {
    pub max_weight_grams: u32,
    pub credits: i64,
}

/// Credits added per piece (options) or per shipment (return label).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Surcharges {
    pub return_label: Option<i64>,
    pub signature: Option<i64>,
    pub age_check: Option<i64>,
    pub no_neighbour: Option<i64>,
    pub evening_delivery: Option<i64>,
    pub saturday_delivery: Option<i64>,
    /// Per started 100 EUR of insured value.
    pub insurance_per_100_eur: Option<i64>,
}

/// One carrier's prices.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CarrierRates {
    /// Product code → zone key (`NL`, `BE`, `EU`, `EUROPE`, `WORLD`) → bands.
    pub products: BTreeMap<String, BTreeMap<String, Vec<Band>>>,
    pub surcharges: Surcharges,
}

/// The whole card.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RateCard {
    pub carriers: BTreeMap<String, CarrierRates>,
}

/// One priced part of a quote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteLine {
    /// `piece`, `returnLabel`, `signature`, …
    pub kind: &'static str,
    /// 1..n for a piece's lines.
    pub piece: Option<u32>,
    pub credits: i64,
}

/// What a label request costs on WeldSuite's contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub credits: i64,
    pub lines: Vec<QuoteLine>,
}

/// Why there is no price.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoRate {
    /// The card doesn't price this carrier.
    Carrier,
    /// Or this product to this zone.
    Product { product: String, zone: &'static str },
    /// Or a piece this heavy.
    Weight {
        product: String,
        zone: &'static str,
        grams: u32,
    },
}

impl NoRate {
    pub fn message(&self) -> String {
        match self {
            Self::Carrier => "This carrier is not offered on WeldSuite's contract".to_owned(),
            Self::Product { product, zone } => {
                format!("Product {product} is not offered on WeldSuite's contract for zone {zone}")
            }
            Self::Weight {
                product,
                zone,
                grams,
            } => format!(
                "A {grams} g piece is too heavy for product {product} on WeldSuite's contract (zone {zone})"
            ),
        }
    }
}

/// What to price.
#[derive(Debug, Clone, Copy)]
pub struct QuoteRequest<'a> {
    pub carrier: &'a str,
    pub product: &'a str,
    /// The recipient's country.
    pub destination: &'a str,
    pub pieces: &'a [PieceSpec],
    pub options: &'a ShipmentOptions,
    pub return_label: bool,
}

impl RateCard {
    /// The card in a `system_settings` value; an unreadable card is empty
    /// (nothing offered), and the error says why.
    pub fn parse(value: &Value) -> Result<Self, String> {
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())
    }

    /// Whether any product of `carrier` has a price.
    pub fn offers(&self, carrier: &str) -> bool {
        self.carriers
            .get(carrier)
            .is_some_and(|rates| rates.products.values().any(|zones| !zones.is_empty()))
    }

    /// The products of `carrier` priced to `destination`.
    pub fn products_to(&self, carrier: &str, destination: &str) -> Vec<String> {
        let zone = Zone::of(destination).key();
        self.carriers
            .get(carrier)
            .map(|rates| {
                rates
                    .products
                    .iter()
                    .filter(|(_, zones)| zones.get(zone).is_some_and(|bands| !bands.is_empty()))
                    .map(|(code, _)| code.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The price of a label request, or why there is none.
    pub fn quote(&self, request: &QuoteRequest<'_>) -> Result<Quote, NoRate> {
        let rates = self.carriers.get(request.carrier).ok_or(NoRate::Carrier)?;
        let zone = Zone::of(request.destination).key();
        let bands = rates
            .products
            .get(request.product)
            .and_then(|zones| zones.get(zone))
            .filter(|bands| !bands.is_empty())
            .ok_or_else(|| NoRate::Product {
                product: request.product.to_owned(),
                zone,
            })?;
        let mut lines = Vec::new();
        let surcharges = &rates.surcharges;
        for (index, piece) in request.pieces.iter().enumerate() {
            let number = u32::try_from(index + 1).unwrap_or(u32::MAX);
            let band = bands
                .iter()
                .filter(|band| band.max_weight_grams >= piece.weight_grams)
                .min_by_key(|band| band.max_weight_grams)
                .ok_or_else(|| NoRate::Weight {
                    product: request.product.to_owned(),
                    zone,
                    grams: piece.weight_grams,
                })?;
            lines.push(QuoteLine {
                kind: "piece",
                piece: Some(number),
                credits: band.credits,
            });
            let options = request.options;
            let per_piece = [
                ("signature", options.signature, surcharges.signature),
                ("ageCheck", options.age_check, surcharges.age_check),
                ("noNeighbour", options.no_neighbour, surcharges.no_neighbour),
                (
                    "eveningDelivery",
                    options.evening_delivery,
                    surcharges.evening_delivery,
                ),
                (
                    "saturdayDelivery",
                    options.saturday_delivery,
                    surcharges.saturday_delivery,
                ),
            ];
            for (kind, wanted, credits) in per_piece {
                if let (true, Some(credits)) = (wanted, credits)
                    && credits > 0
                {
                    lines.push(QuoteLine {
                        kind,
                        piece: Some(number),
                        credits,
                    });
                }
            }
            if let (Some(value), Some(per_100)) = (
                options.insured_value_cents,
                surcharges.insurance_per_100_eur,
            ) && value > 0
                && per_100 > 0
            {
                let hundreds = i64::try_from(value.div_ceil(10_000)).unwrap_or(i64::MAX);
                lines.push(QuoteLine {
                    kind: "insurance",
                    piece: Some(number),
                    credits: hundreds.saturating_mul(per_100),
                });
            }
        }
        if request.return_label
            && let Some(credits) = surcharges.return_label
            && credits > 0
        {
            lines.push(QuoteLine {
                kind: "returnLabel",
                piece: None,
                credits,
            });
        }
        let credits = lines
            .iter()
            .fold(0_i64, |sum, line| sum.saturating_add(line.credits));
        Ok(Quote { credits, lines })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn card() -> RateCard {
        RateCard::parse(&json!({
            "carriers": {
                "postnl": {
                    "products": {
                        "3085": {
                            "NL": [
                                { "maxWeightGrams": 10000, "credits": 695 },
                                { "maxWeightGrams": 2000, "credits": 495 }
                            ],
                            "BE": [{ "maxWeightGrams": 23000, "credits": 950 }]
                        },
                        "4909": { "WORLD": [] }
                    },
                    "surcharges": { "returnLabel": 450, "signature": 95, "insurancePer100Eur": 50 }
                }
            }
        }))
        .expect("card")
    }

    fn piece(grams: u32) -> PieceSpec {
        PieceSpec {
            weight_grams: grams,
            ..PieceSpec::default()
        }
    }

    #[test]
    fn prices_each_piece_in_the_smallest_band_that_fits() {
        let pieces = [piece(1500), piece(2001)];
        let options = ShipmentOptions {
            signature: true,
            insured_value_cents: Some(25_000),
            ..ShipmentOptions::default()
        };
        let quote = card()
            .quote(&QuoteRequest {
                carrier: "postnl",
                product: "3085",
                destination: "nl",
                pieces: &pieces,
                options: &options,
                return_label: true,
            })
            .expect("quote");
        // 495 + 95 + 3×50, 695 + 95 + 3×50, 450.
        assert_eq!(quote.credits, 495 + 95 + 150 + 695 + 95 + 150 + 450);
        assert_eq!(quote.lines.len(), 7);
    }

    #[test]
    fn says_why_there_is_no_price() {
        let pieces = [piece(30_000)];
        let options = ShipmentOptions::default();
        let request = |carrier, product, destination| QuoteRequest {
            carrier,
            product,
            destination,
            pieces: &pieces,
            options: &options,
            return_label: false,
        };
        assert_eq!(
            card().quote(&request("dhl_parcel_nl", "EPL", "NL")),
            Err(NoRate::Carrier)
        );
        assert_eq!(
            card().quote(&request("postnl", "3085", "DE")),
            Err(NoRate::Product {
                product: "3085".into(),
                zone: "EU"
            })
        );
        assert_eq!(
            card().quote(&request("postnl", "4909", "US")),
            Err(NoRate::Product {
                product: "4909".into(),
                zone: "WORLD"
            })
        );
        assert_eq!(
            card().quote(&request("postnl", "3085", "BE")),
            Err(NoRate::Weight {
                product: "3085".into(),
                zone: "BE",
                grams: 30_000
            })
        );
    }

    #[test]
    fn lists_what_it_offers() {
        let card = card();
        assert!(card.offers("postnl"));
        assert!(!card.offers("dhl_parcel_nl"));
        assert_eq!(card.products_to("postnl", "BE"), vec!["3085".to_owned()]);
        assert_eq!(card.products_to("postnl", "US"), Vec::<String>::new());
        assert!(RateCard::parse(&json!({ "carriers": 3 })).is_err());
    }
}
