//! Payslip line labels (`labels.ts`): the NL, US and state labels, written
//! to `data/labels.json` by `pnpm rust:payroll-fixtures`.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

use crate::documents::Lang;

#[derive(Debug, Clone, Deserialize)]
pub struct Label {
    pub en: String,
    pub nl: String,
}

impl Label {
    pub fn get(&self, lang: Lang) -> &str {
        match lang {
            Lang::En => &self.en,
            Lang::Nl => &self.nl,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTables {
    /// `PAYSLIP_LABELS`.
    pub payslip: BTreeMap<String, Label>,
    /// `STATE_NAMES`.
    #[serde(default)]
    pub state_names: BTreeMap<String, Label>,
    /// `STATE_CERTIFICATE_LABELS`.
    #[serde(default)]
    pub state_certificates: BTreeMap<String, Label>,
}

pub static LABELS: LazyLock<LabelTables> =
    LazyLock::new(|| serde_json::from_str(include_str!("../data/labels.json")).unwrap_or_default());

/// `payslipLineLabel(line, lang)`.
pub fn payslip_line_label(label_key: &str, label: Option<&str>, lang: Lang) -> String {
    if let Some(label) = label.filter(|l| !l.is_empty()) {
        return label.to_owned();
    }
    LABELS
        .payslip
        .get(label_key)
        .map_or_else(|| label_key.to_owned(), |l| l.get(lang).to_owned())
}
