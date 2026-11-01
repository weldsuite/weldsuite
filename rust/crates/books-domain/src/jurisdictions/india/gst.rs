//! India's GST state table (`jurisdictions/in/states.ts`) and the split of a
//! GST slab into CGST + SGST (UTGST) or IGST by place of supply
//! (`expandGstTaxBreakdown` in `jurisdictions/in/index.ts`).

use serde_json::{Map, Value};

use super::is_valid_gst_state_code;
use crate::js;
use crate::jurisdictions::{is_js_space, js_trim};

/// `GST_FOREIGN_COUNTRY_CODE`: the place of supply of a supply outside
/// India (not a GSTIN prefix).
pub const GST_FOREIGN_COUNTRY_CODE: &str = "96";

/// `GstState`: code, name, ISO suffix, UTGST (a union territory without a
/// legislature), retired.
#[derive(Debug, Clone, Copy)]
pub struct GstState {
    pub code: &'static str,
    pub name: &'static str,
    pub abbr: &'static str,
    pub utgst: bool,
    pub retired: bool,
}

const fn state(code: &'static str, name: &'static str, abbr: &'static str) -> GstState {
    GstState {
        code,
        name,
        abbr,
        utgst: false,
        retired: false,
    }
}

const fn territory(code: &'static str, name: &'static str, abbr: &'static str) -> GstState {
    GstState {
        code,
        name,
        abbr,
        utgst: true,
        retired: false,
    }
}

/// `GST_STATES`.
pub const GST_STATES: [GstState; 39] = [
    state("01", "Jammu and Kashmir", "JK"),
    state("02", "Himachal Pradesh", "HP"),
    state("03", "Punjab", "PB"),
    territory("04", "Chandigarh", "CH"),
    state("05", "Uttarakhand", "UK"),
    state("06", "Haryana", "HR"),
    state("07", "Delhi", "DL"),
    state("08", "Rajasthan", "RJ"),
    state("09", "Uttar Pradesh", "UP"),
    state("10", "Bihar", "BR"),
    state("11", "Sikkim", "SK"),
    state("12", "Arunachal Pradesh", "AR"),
    state("13", "Nagaland", "NL"),
    state("14", "Manipur", "MN"),
    state("15", "Mizoram", "MZ"),
    state("16", "Tripura", "TR"),
    state("17", "Meghalaya", "ML"),
    state("18", "Assam", "AS"),
    state("19", "West Bengal", "WB"),
    state("20", "Jharkhand", "JH"),
    state("21", "Odisha", "OD"),
    state("22", "Chhattisgarh", "CG"),
    state("23", "Madhya Pradesh", "MP"),
    state("24", "Gujarat", "GJ"),
    GstState {
        code: "25",
        name: "Daman and Diu",
        abbr: "DD",
        utgst: true,
        retired: true,
    },
    territory("26", "Dadra and Nagar Haveli and Daman and Diu", "DH"),
    state("27", "Maharashtra", "MH"),
    GstState {
        code: "28",
        name: "Andhra Pradesh (before division)",
        abbr: "AP",
        utgst: false,
        retired: true,
    },
    state("29", "Karnataka", "KA"),
    state("30", "Goa", "GA"),
    territory("31", "Lakshadweep", "LD"),
    state("32", "Kerala", "KL"),
    state("33", "Tamil Nadu", "TN"),
    state("34", "Puducherry", "PY"),
    territory("35", "Andaman and Nicobar Islands", "AN"),
    state("36", "Telangana", "TS"),
    state("37", "Andhra Pradesh", "AP"),
    territory("38", "Ladakh", "LA"),
    territory("97", "Other Territory", "OT"),
];

/// `NAME_ALIASES`: names people type that are not the official one.
const NAME_ALIASES: [(&str, &str); 13] = [
    ("orissa", "21"),
    ("pondicherry", "34"),
    ("nct of delhi", "07"),
    ("new delhi", "07"),
    ("jammu kashmir", "01"),
    ("dadra and nagar haveli", "26"),
    ("daman and diu", "26"),
    ("daman diu", "26"),
    ("andaman nicobar islands", "35"),
    ("andaman and nicobar", "35"),
    ("uttaranchal", "05"),
    ("bangalore", "29"),
    ("bengaluru", "29"),
];

fn state_of(code: &str) -> Option<&'static GstState> {
    GST_STATES.iter().find(|s| s.code == code)
}

/// `gstStateName(code)`.
pub fn gst_state_name(code: Option<&str>) -> Option<&'static str> {
    let code = code.filter(|c| !c.is_empty())?;
    if code == GST_FOREIGN_COUNTRY_CODE {
        return Some("Foreign Country");
    }
    state_of(code).map(|s| s.name)
}

/// `usesUtgst(code)`: intra-territory supplies carry UTGST, not SGST.
pub fn uses_utgst(code: Option<&str>) -> bool {
    code.and_then(state_of).is_some_and(|s| s.utgst)
}

/// `fold(value)`: lower case, `&` as " and ", every run of characters other
/// than `[a-z0-9]` one space, trimmed.
fn fold(value: &str) -> String {
    let lowered = value.to_lowercase().replace('&', " and ");
    let mut out = String::with_capacity(lowered.len());
    let mut gap = false;
    for c in lowered.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

/// `NAME_INDEX.get(folded)`: the aliases (set last, so they win), else the
/// official names (the pre-division Andhra Pradesh left out).
fn code_of_name(folded: &str) -> Option<&'static str> {
    if let Some((_, code)) = NAME_ALIASES.iter().find(|(alias, _)| *alias == folded) {
        return Some(code);
    }
    GST_STATES
        .iter()
        .rev()
        .filter(|s| !(s.retired && s.code == "28"))
        .find(|s| fold(s.name) == folded)
        .map(|s| s.code)
}

fn is_two_digits(text: &str) -> bool {
    text.len() == 2 && text.bytes().all(|b| b.is_ascii_digit())
}

/// `gstStateCodeFromText(value)`: a two-digit code, a state name, the ISO
/// suffix (`MH`, `IN-MH`) or a leading code (`27 - Maharashtra`); never a
/// guess.
pub fn gst_state_code_from_text(value: Option<&str>) -> Option<String> {
    let trimmed = js_trim(value?);
    if trimmed.is_empty() {
        return None;
    }
    if is_two_digits(trimmed) {
        return is_valid_gst_state_code(trimmed).then(|| trimmed.to_owned());
    }
    if let Some(code) = code_of_name(&fold(trimmed)) {
        return Some(code.to_owned());
    }
    let upper = trimmed.to_uppercase();
    // `.replace(/^IN[-\s]/, '')`
    let abbr = upper
        .strip_prefix("IN")
        .and_then(|rest| rest.strip_prefix(|c: char| c == '-' || is_js_space(c)))
        .unwrap_or(&upper);
    if abbr.len() == 2
        && abbr.bytes().all(|b| b.is_ascii_uppercase())
        && let Some(hit) = GST_STATES.iter().find(|s| s.abbr == abbr && !s.retired)
    {
        return Some(hit.code.to_owned());
    }
    // `/^(\d{2})\b/`: two digits not followed by a word character.
    let bytes = trimmed.as_bytes();
    if bytes.len() > 2
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && !(bytes[2].is_ascii_alphanumeric() || bytes[2] == b'_')
    {
        let leading = &trimmed[..2];
        if is_valid_gst_state_code(leading) {
            return Some(leading.to_owned());
        }
    }
    None
}

/// `normalizeStateCode(value)`: a trimmed two-digit code, else none.
fn normalize_state_code(value: Option<&str>) -> Option<String> {
    let trimmed = js_trim(value?);
    is_two_digits(trimmed).then(|| trimmed.to_owned())
}

/// `OUTPUT_TO_INPUT_ROLE`.
fn input_role(output: &str) -> Option<&'static str> {
    match output {
        "tax_output_cgst" => Some("tax_input_cgst"),
        "tax_output_sgst" => Some("tax_input_sgst"),
        "tax_output_igst" => Some("tax_input_igst"),
        _ => None,
    }
}

/// `parseSlabMetadata(meta)`: the slab's intra- and inter-state components,
/// `None` unless `gstSlab` is a string and both lists are non-empty arrays.
fn slab_components(meta: Option<&Value>) -> Option<(&Vec<Value>, &Vec<Value>)> {
    let meta = meta?.as_object()?;
    meta.get("gstSlab")?.as_str()?;
    let components = meta.get("components")?;
    let intra = components.get("intrastate")?.as_array()?;
    let inter = components.get("interstate")?.as_array()?;
    (!intra.is_empty() && !inter.is_empty()).then_some((intra, inter))
}

/// `meta && meta.components`: a rate seeded with its GST components.
pub fn has_slab_components(meta: Option<&Value>) -> bool {
    js::truthy(meta.and_then(|m| m.get("components")))
}

/// `Number.parseFloat(value)` of a metadata value.
fn parse_rate(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::String(text)) => js::parse_float(text),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// What `expandGstTaxBreakdown` is given.
#[derive(Debug, Clone, Copy)]
pub struct GstExpansion<'a> {
    pub taxable_amount: f64,
    pub tax_rate_id: &'a str,
    pub tax_rate_name: &'a str,
    pub slab_rate: f64,
    pub jurisdiction_metadata: Option<&'a Value>,
    pub seller_state_code: Option<&'a str>,
    pub buyer_state_code: Option<&'a str>,
    pub buyer_country: Option<&'a str>,
    /// A purchase (input roles) rather than a sale (output roles).
    pub purchase: bool,
}

/// `expandGstTaxBreakdown(opts)`: the breakdown rows of one line under a
/// seeded GST slab: CGST + SGST (UTGST) within a state, IGST across states,
/// one 0% export row abroad, the plain slab (no split) while either state is
/// unknown. Rows are `{ taxRateId, taxRateName, taxRate, taxableAmount,
/// taxAmount, component?, accountRole? }` with the amounts unrounded.
pub fn expand_gst_tax_breakdown(opts: &GstExpansion<'_>) -> Vec<Map<String, Value>> {
    let row = |name: &str, rate: f64, tax: f64| {
        let mut row = Map::new();
        row.insert("taxRateId".into(), Value::String(opts.tax_rate_id.into()));
        row.insert("taxRateName".into(), Value::String(name.into()));
        row.insert("taxRate".into(), js::number_value(rate));
        row.insert(
            "taxableAmount".into(),
            js::number_value(opts.taxable_amount),
        );
        row.insert("taxAmount".into(), js::number_value(tax));
        row
    };
    let single_slab = || {
        vec![row(
            opts.tax_rate_name,
            opts.slab_rate,
            opts.taxable_amount * (opts.slab_rate / 100.0),
        )]
    };
    let Some((intra, inter)) = slab_components(opts.jurisdiction_metadata) else {
        return single_slab();
    };
    let buyer_country = opts.buyer_country.map(str::to_uppercase);
    if buyer_country
        .as_deref()
        .is_some_and(|c| !c.is_empty() && c != "IN")
        || opts.buyer_state_code == Some(GST_FOREIGN_COUNTRY_CODE)
    {
        let mut export = row("GST Export (0%)", 0.0, 0.0);
        export.insert("component".into(), Value::String("export".into()));
        return vec![export];
    }
    let (Some(seller), Some(buyer)) = (
        normalize_state_code(opts.seller_state_code),
        normalize_state_code(opts.buyer_state_code),
    ) else {
        return single_slab();
    };
    let intrastate = seller == buyer;
    let list = if intrastate { intra } else { inter };
    let utgst = intrastate && uses_utgst(Some(&seller));
    list.iter()
        .map(|c| {
            let declared = c.get("code").and_then(Value::as_str).unwrap_or_default();
            let rate = parse_rate(c.get("rate"));
            let code = if utgst && declared == "sgst" {
                "utgst"
            } else {
                declared
            };
            let prefix = match code {
                "cgst" => "CGST",
                "sgst" => "SGST",
                "utgst" => "UTGST",
                _ => "IGST",
            };
            let label = format!("{prefix} {}%", js::number_text(rate));
            let mut out = row(&label, rate, opts.taxable_amount * (rate / 100.0));
            out.insert("component".into(), Value::String(code.into()));
            // An absent `accountRole` stays `undefined`: left out of the row.
            if let Some(role) = c.get("accountRole") {
                let role = match role {
                    Value::String(output) if opts.purchase => Value::String(
                        input_role(output).map_or_else(|| output.clone(), str::to_owned),
                    ),
                    other => other.clone(),
                };
                out.insert("accountRole".into(), role);
            }
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn slab() -> Value {
        json!({
            "gstSlab": "18",
            "components": {
                "intrastate": [
                    { "code": "cgst", "rate": "9", "accountRole": "tax_output_cgst" },
                    { "code": "sgst", "rate": "9", "accountRole": "tax_output_sgst" },
                ],
                "interstate": [{ "code": "igst", "rate": "18", "accountRole": "tax_output_igst" }],
            },
        })
    }

    #[test]
    fn reads_state_text() {
        assert_eq!(
            gst_state_code_from_text(Some("Maharashtra")).as_deref(),
            Some("27")
        );
        assert_eq!(
            gst_state_code_from_text(Some("IN-MH")).as_deref(),
            Some("27")
        );
        assert_eq!(
            gst_state_code_from_text(Some("in mh")).as_deref(),
            Some("27")
        );
        assert_eq!(
            gst_state_code_from_text(Some("27 - Maharashtra")).as_deref(),
            Some("27")
        );
        assert_eq!(
            gst_state_code_from_text(Some("Bengaluru")).as_deref(),
            Some("29")
        );
        assert_eq!(
            gst_state_code_from_text(Some("Daman & Diu")).as_deref(),
            Some("26")
        );
        assert_eq!(
            gst_state_code_from_text(Some("Andhra Pradesh")).as_deref(),
            Some("37")
        );
        assert_eq!(gst_state_code_from_text(Some("99")), None);
        assert_eq!(gst_state_code_from_text(Some("Atlantis")), None);
        assert_eq!(gst_state_code_from_text(Some("  ")), None);
    }

    #[test]
    fn splits_a_slab_by_place_of_supply() {
        let meta = slab();
        let base = GstExpansion {
            taxable_amount: 1000.0,
            tax_rate_id: "tr_18",
            tax_rate_name: "GST 18%",
            slab_rate: 18.0,
            jurisdiction_metadata: Some(&meta),
            seller_state_code: Some("27"),
            buyer_state_code: Some("27"),
            buyer_country: Some("IN"),
            purchase: false,
        };
        let intra = expand_gst_tax_breakdown(&base);
        assert_eq!(intra.len(), 2);
        assert_eq!(intra[0]["taxRateName"], "CGST 9%");
        assert_eq!(intra[1]["taxAmount"], json!(90));
        let inter = expand_gst_tax_breakdown(&GstExpansion {
            buyer_state_code: Some("29"),
            purchase: true,
            ..base
        });
        assert_eq!(inter[0]["taxRateName"], "IGST 18%");
        assert_eq!(inter[0]["accountRole"], "tax_input_igst");
        let utgst = expand_gst_tax_breakdown(&GstExpansion {
            seller_state_code: Some("04"),
            buyer_state_code: Some("04"),
            ..base
        });
        assert_eq!(utgst[1]["component"], "utgst");
        assert_eq!(utgst[1]["taxRateName"], "UTGST 9%");
        let export = expand_gst_tax_breakdown(&GstExpansion {
            buyer_country: Some("us"),
            ..base
        });
        assert_eq!(export[0]["component"], "export");
        let unknown = expand_gst_tax_breakdown(&GstExpansion {
            buyer_state_code: None,
            ..base
        });
        assert_eq!(unknown[0]["taxRateName"], "GST 18%");
        assert!(unknown[0].get("component").is_none());
    }
}
