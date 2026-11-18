//! The range a result reports back to the client (`result-range.ts`).

use super::time::{ResolvedRange, TimeBounds};
use crate::js;
use crate::schemas::PanelResolvedRange;

/// `toResolvedRange`.
pub fn to_resolved_range(
    range: &ResolvedRange,
    previous: Option<TimeBounds>,
) -> PanelResolvedRange {
    PanelResolvedRange {
        from: js::iso_string(range.from),
        to: js::iso_string(range.to),
        timezone: range.timezone.clone(),
        clamped_to_retention: range.clamped_to_retention,
        previous_from: previous.map(|p| js::iso_string(p.from)),
        previous_to: previous.map(|p| js::iso_string(p.to)),
    }
}
