//! Analysis requests on top of a spec (`weldpanel-analysis.ts`): root cause
//! (`POST /api/panel/insights/explain`).

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::query::{PanelBreakdown, PanelQuerySpec, TrendsSpec};

/// `PANEL_EXPLAIN_DIMENSIONS`: the standard dimensions every explanation
/// looks at.
pub const PANEL_EXPLAIN_DIMENSIONS: [&str; 7] = [
    "country",
    "device_type",
    "browser",
    "os",
    "referrer_host",
    "utm_source",
    "path",
];

/// Days to explain, against as many days before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExplainPeriod {
    pub from: String,
    pub to: String,
}

fn five() -> i64 {
    5
}

/// `explainPanelChangeSchema`: what moved and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainPanelChange {
    pub project_id: String,
    /// A trends spec (`kind: 'trends'`) with one series.
    #[serde(with = "tagged_trends")]
    pub spec: TrendsSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<ExplainPeriod>,
    #[serde(default)]
    pub properties: Vec<PanelBreakdown>,
    #[serde(default = "five")]
    pub limit: i64,
    #[serde(default)]
    pub narrate: bool,
    #[serde(default)]
    pub regenerate: bool,
}

/// A [`TrendsSpec`] written with its `kind`.
mod tagged_trends {
    use super::{Deserialize, Deserializer, PanelQuerySpec, Serialize, Serializer, TrendsSpec};

    pub(super) fn serialize<S: Serializer>(
        spec: &TrendsSpec,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        PanelQuerySpec::Trends(spec.clone()).serialize(serializer)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<TrendsSpec, D::Error> {
        match PanelQuerySpec::deserialize(deserializer)? {
            PanelQuerySpec::Trends(spec) => Ok(spec),
            other => Err(serde::de::Error::custom(format!(
                "expected a trends spec, not {}",
                other.kind()
            ))),
        }
    }
}
