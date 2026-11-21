//! The permissions a query kind needs (`permissions.ts`). `sessions` shows
//! what visitors did and saw, so it also needs `panel_recordings:read`.

use crate::schemas::PanelQueryKind;

/// `requiredPanelPermissions`.
pub fn required_panel_permissions(kind: PanelQueryKind) -> &'static [&'static str] {
    if kind == PanelQueryKind::Sessions {
        &["panel_reports:read", "panel_recordings:read"]
    } else {
        &["panel_reports:read"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_for_recordings_access_only_for_the_recordings_list() {
        assert_eq!(
            required_panel_permissions(PanelQueryKind::Sessions),
            ["panel_reports:read", "panel_recordings:read"]
        );
        assert_eq!(
            required_panel_permissions(PanelQueryKind::Heatmap),
            ["panel_reports:read"]
        );
        assert_eq!(
            required_panel_permissions(PanelQueryKind::Funnel),
            ["panel_reports:read"]
        );
    }
}
