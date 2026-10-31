//! Which address a sale is taxed at (`sales-tax/sourcing.ts`), as far as the
//! posting engine needs it: the state and ZIP of an address, the ship-to of a
//! document.

use serde_json::Value;

use crate::address::normalize_postal_address;
use crate::jurisdictions::{is_js_space, js_trim, us};

/// `stateCodeOf(address)`: the two-letter USPS code, from a code or a full
/// state name; `None` without one.
pub fn state_code_of(address: Option<&Value>) -> Option<String> {
    let raw = js_trim(address?.get("state")?.as_str()?);
    if raw.is_empty() {
        return None;
    }
    if raw.encode_utf16().count() == 2 {
        return Some(raw.to_uppercase());
    }
    let lower = raw.to_lowercase();
    Some(
        us::states()
            .iter()
            .find(|s| s["name"].as_str().map(str::to_lowercase).as_deref() == Some(lower.as_str()))
            .and_then(|s| s["code"].as_str())
            .map_or_else(|| raw.to_uppercase(), str::to_owned),
    )
}

/// `zip5Of(address)`: the five-digit ZIP (ZIP+4 cut back), or `None`.
pub fn zip5_of(address: Option<&Value>) -> Option<String> {
    let raw = js_trim(address?.get("postalCode")?.as_str()?);
    // `/^(\d{5})(?:[-\s]?\d{4})?$/`
    let chars: Vec<char> = raw.chars().collect();
    let digits = |part: &[char]| part.iter().all(char::is_ascii_digit);
    if chars.len() < 5 || !digits(&chars[..5]) {
        return None;
    }
    let rest = &chars[5..];
    let ok = match rest.len() {
        0 => true,
        4 => digits(rest),
        5 => (rest[0] == '-' || is_js_space(rest[0])) && digits(&rest[1..]),
        _ => false,
    };
    ok.then(|| chars[..5].iter().collect())
}

/// `pickShipTo(...candidates)` (books-api `services/sales-tax/document-tax.ts`):
/// the first address with a state, else the first address at all.
pub fn pick_ship_to(candidates: &[Option<&Value>]) -> Option<Value> {
    let addresses: Vec<Value> = candidates
        .iter()
        .filter_map(|a| normalize_postal_address(*a))
        .collect();
    let index = addresses
        .iter()
        .position(|a| state_code_of(Some(a)).is_some())
        .or(if addresses.is_empty() { None } else { Some(0) })?;
    addresses.into_iter().nth(index)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn states_and_zips() {
        assert_eq!(
            state_code_of(Some(&json!({ "state": " ca " }))).as_deref(),
            Some("CA")
        );
        assert_eq!(
            state_code_of(Some(&json!({ "state": "new york" }))).as_deref(),
            Some("NY")
        );
        assert_eq!(
            state_code_of(Some(&json!({ "state": "Bavaria" }))).as_deref(),
            Some("BAVARIA")
        );
        assert_eq!(state_code_of(Some(&json!({ "state": "" }))), None);
        for (zip, expected) in [
            ("94105-1234", Some("94105")),
            ("94105 1234", Some("94105")),
            ("941051234", Some("94105")),
            ("1234 AB", None),
            ("", None),
        ] {
            assert_eq!(
                zip5_of(Some(&json!({ "postalCode": zip }))).as_deref(),
                expected
            );
        }
    }

    #[test]
    fn ship_to_prefers_an_address_with_a_state() {
        let ship = json!({ "city": "Amsterdam" });
        let bill = json!({ "line1": "1 Main St", "state": "TX", "postalCode": "73301" });
        let picked = pick_ship_to(&[Some(&ship), Some(&bill)]).expect("the billing address");
        assert_eq!(picked["state"], "TX");
        assert_eq!(
            pick_ship_to(&[Some(&ship), None]).expect("the shipping address")["city"],
            "Amsterdam"
        );
        assert_eq!(pick_ship_to(&[None]), None);
    }
}
