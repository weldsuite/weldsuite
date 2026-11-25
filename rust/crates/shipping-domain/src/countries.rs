//! Which destinations need customs, and the rate card's zones.

use crate::types::compact_postal_code;

/// The EU member states (ISO alpha-2).
pub const EU_MEMBERS: &[&str] = &[
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT",
    "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];

/// The rest of geographic Europe, priced as one zone.
const REST_OF_EUROPE: &[&str] = &[
    "AD", "AL", "BA", "BY", "CH", "FO", "GB", "GG", "GI", "IM", "IS", "JE", "LI", "MC", "MD", "ME",
    "MK", "NO", "RS", "SM", "UA", "VA", "XK",
];

pub fn is_eu_member(country: &str) -> bool {
    EU_MEMBERS.contains(&country.trim().to_ascii_uppercase().as_str())
}

/// Parts of EU member states outside the EU customs (or VAT) territory, by
/// postal code: the Canary Islands, Ceuta and Melilla, the French overseas
/// departments, Åland, Heligoland, Büsingen, Livigno, Campione d'Italia and
/// Mount Athos. A parcel there needs a declaration like any non-EU one.
fn special_territory(country: &str, postal_code: &str) -> bool {
    let code = compact_postal_code(postal_code);
    match country {
        "ES" => ["35", "38", "51", "52"].iter().any(|p| code.starts_with(p)),
        "FR" => ["971", "972", "973", "974", "975", "976", "98"]
            .iter()
            .any(|p| code.starts_with(p)),
        "FI" => code.starts_with("22"),
        "DE" => code == "27498" || code == "78266",
        "IT" => code == "23041" || code == "22061" || code == "22060",
        "GR" => code == "63086",
        _ => false,
    }
}

/// Whether a parcel from `from` to `to` (with the recipient's postal code)
/// needs a customs declaration: one side is outside the EU, or the
/// destination is a special territory.
pub fn customs_required(from: &str, to: &str, to_postal_code: &str) -> bool {
    let from = from.trim().to_ascii_uppercase();
    let to = to.trim().to_ascii_uppercase();
    if from == to && !special_territory(&to, to_postal_code) {
        return false;
    }
    !is_eu_member(&from) || !is_eu_member(&to) || special_territory(&to, to_postal_code)
}

/// A destination zone of the rate card (`weldstash.shipping_rates`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Nl,
    Be,
    /// Other EU member states.
    Eu,
    /// The rest of Europe (GB, CH, NO, …).
    Europe,
    World,
}

impl Zone {
    pub fn of(country: &str) -> Self {
        let country = country.trim().to_ascii_uppercase();
        match country.as_str() {
            "NL" => Self::Nl,
            "BE" => Self::Be,
            c if EU_MEMBERS.contains(&c) => Self::Eu,
            c if REST_OF_EUROPE.contains(&c) => Self::Europe,
            _ => Self::World,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Nl => "NL",
            Self::Be => "BE",
            Self::Eu => "EU",
            Self::Europe => "EUROPE",
            Self::World => "WORLD",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn customs_outside_the_eu_and_its_special_territories() {
        assert!(!customs_required("NL", "NL", "1012AB"));
        assert!(!customs_required("NL", "BE", "1000"));
        assert!(!customs_required("NL", "DE", "10115"));
        assert!(customs_required("NL", "GB", "SW1A 2AA"));
        assert!(customs_required("NL", "CH", "8001"));
        assert!(customs_required("NL", "NO", "0150"));
        assert!(customs_required("NL", "US", "10001"));
        // Canary Islands, Martinique, Åland, Heligoland.
        assert!(customs_required("NL", "ES", "35001"));
        assert!(!customs_required("NL", "ES", "28001"));
        assert!(customs_required("NL", "FR", "97200"));
        assert!(customs_required("NL", "FI", "22100"));
        assert!(customs_required("NL", "DE", "27498"));
        // From outside the EU in.
        assert!(customs_required("GB", "NL", "1012AB"));
    }

    #[test]
    fn zones() {
        assert_eq!(Zone::of("nl"), Zone::Nl);
        assert_eq!(Zone::of("BE"), Zone::Be);
        assert_eq!(Zone::of("DE"), Zone::Eu);
        assert_eq!(Zone::of("GB"), Zone::Europe);
        assert_eq!(Zone::of("CH"), Zone::Europe);
        assert_eq!(Zone::of("US"), Zone::World);
        assert_eq!(Zone::World.key(), "WORLD");
    }
}
