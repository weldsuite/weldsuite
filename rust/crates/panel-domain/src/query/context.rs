//! What a query runs against (`context.ts`): the authenticated scope (never
//! from the spec), the plan's retention and what the project knows.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::js;
use crate::schemas::{CohortFilter, ComputedPropertyDefinition, CustomEventDefinition, PathRule};

/// The Basin namespace of the WeldPanel tables.
pub const BASIN_NAMESPACE: &str = crate::tables::PANEL_BASIN_NAMESPACE;

/// Most a query may look back: 25 months.
pub const MAX_RETENTION_DAYS: i64 = 762;

/// `PanelQueryContext`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelQueryContext {
    /// `workspaces.id` of the authenticated workspace.
    pub workspace_id: String,
    /// The project the caller may read; must equal the spec's `projectId`.
    pub project_id: String,
    /// The plan's event retention in days, at most [`MAX_RETENTION_DAYS`].
    pub retention_days: f64,
    /// The identity join is added only when the project has identified users.
    pub has_identified_users: bool,
    /// Excluded from every query until the Iceberg rows are rewritten.
    pub erased_ids: Vec<String>,
    /// Saved cohorts by id, for `cohort` filters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cohorts: Option<BTreeMap<String, CohortFilter>>,
    /// Saved heatmap page groups: id → URL pattern.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_groups: Option<BTreeMap<String, String>>,
    /// Favourited session ids, for `favoritesOnly`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite_session_ids: Option<Vec<String>>,
    /// Custom events by id (`pnce_…`, without the `@`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_events: Option<BTreeMap<String, CustomEventDefinition>>,
    /// Computed properties by id (`pncp_…`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computed_properties: Option<BTreeMap<String, ComputedPropertyDefinition>>,
    /// The project's path rules in order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_rules: Option<Vec<PathRule>>,
    /// The project's group types; when set, a spec naming another is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_types: Option<Vec<String>>,
    /// An injected clock (epoch milliseconds; ISO 8601 in JSON), for tests.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_now",
        deserialize_with = "deserialize_now"
    )]
    pub now: Option<i64>,
}

// serde's `serialize_with` hands the field over by reference.
#[allow(clippy::ref_option)]
fn serialize_now<S: Serializer>(now: &Option<i64>, serializer: S) -> Result<S::Ok, S::Error> {
    match now {
        Some(millis) => serializer.serialize_str(&js::iso_string(*millis)),
        None => serializer.serialize_none(),
    }
}

fn deserialize_now<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    let text = Option::<String>::deserialize(deserializer)?;
    text.map(|text| {
        js::parse_iso(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("not an ISO 8601 instant: {text}")))
    })
    .transpose()
}
