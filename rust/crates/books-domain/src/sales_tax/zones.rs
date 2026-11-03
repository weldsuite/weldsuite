//! Tax zone matching for the manual engine (`sales-tax/zones.ts`): a zone
//! lists five-digit ZIPs and inclusive ZIP ranges, or marks the seller's own
//! location (`is_origin`).

use super::types::{ManualZone, PostalEntry};
use crate::jurisdictions::js_trim;

/// `/^(\d{5})/` of the trimmed value.
fn zip5(value: &str) -> Option<&str> {
    let text = js_trim(value);
    let head = text.get(..5)?;
    head.bytes().all(|b| b.is_ascii_digit()).then_some(head)
}

/// `zoneCoversZip(zone, zip)`: the zone's ZIP list covers the ZIP (ZIP+4
/// entries count as their ZIP).
pub fn zone_covers_zip(zone: &ManualZone, zip: Option<&str>) -> bool {
    let Some(zip) = zip.filter(|z| !z.is_empty()) else {
        return false;
    };
    zone.postal_codes.iter().any(|entry| match entry {
        PostalEntry::Zip(value) => zip5(value) == Some(zip),
        PostalEntry::Range { from, to } => match (zip5(from), zip5(to)) {
            (Some(from), Some(to)) => zip >= from && zip <= to,
            _ => false,
        },
        PostalEntry::Other => false,
    })
}

/// Lower priority first, a stable sort (`byPriority`).
fn by_priority(mut zones: Vec<&ManualZone>) -> Vec<&ManualZone> {
    zones.sort_by(|a, b| {
        a.priority
            .partial_cmp(&b.priority)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    zones
}

/// `pickDestinationZone(zones, zip)`: the lowest-priority zone that covers
/// the ZIP.
pub fn pick_destination_zone<'a>(
    zones: &[&'a ManualZone],
    zip: Option<&str>,
) -> Option<&'a ManualZone> {
    by_priority(
        zones
            .iter()
            .copied()
            .filter(|z| zone_covers_zip(z, zip))
            .collect(),
    )
    .first()
    .copied()
}

/// `pickOriginZone(zones, shipFromZip)`: the seller-location zone covering
/// the ship-from ZIP, else the first seller-location zone, else any zone
/// covering the ship-from ZIP.
pub fn pick_origin_zone<'a>(
    zones: &[&'a ManualZone],
    ship_from_zip: Option<&str>,
) -> Option<&'a ManualZone> {
    let origins = by_priority(zones.iter().copied().filter(|z| z.is_origin).collect());
    origins
        .iter()
        .copied()
        .find(|z| zone_covers_zip(z, ship_from_zip))
        .or_else(|| origins.first().copied())
        .or_else(|| pick_destination_zone(zones, ship_from_zip))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(id: &str, codes: Vec<PostalEntry>, origin: bool, priority: f64) -> ManualZone {
        ManualZone {
            id: id.into(),
            agency_id: "a".into(),
            state_code: "TX".into(),
            name: id.into(),
            jurisdiction_ids: vec![],
            postal_codes: codes,
            is_origin: origin,
            priority,
        }
    }

    #[test]
    fn zips_and_ranges() {
        let a = zone(
            "a",
            vec![
                PostalEntry::Zip("78701-1234".into()),
                PostalEntry::Range {
                    from: "75000".into(),
                    to: "75999".into(),
                },
            ],
            false,
            10.0,
        );
        let b = zone("b", vec![PostalEntry::Zip("78701".into())], true, 5.0);
        assert!(zone_covers_zip(&a, Some("78701")));
        assert!(zone_covers_zip(&a, Some("75500")));
        assert!(!zone_covers_zip(&a, Some("76000")));
        let zones = [&a, &b];
        assert_eq!(
            pick_destination_zone(&zones, Some("78701")).map(|z| z.id.as_str()),
            Some("b")
        );
        assert_eq!(
            pick_origin_zone(&zones, Some("75500")).map(|z| z.id.as_str()),
            Some("b")
        );
    }
}
