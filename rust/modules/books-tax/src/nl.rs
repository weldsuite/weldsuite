//! The Dutch filings' rules (`jurisdictions/nl/{btw-return,taxonomy}`,
//! `accounting-vat-xml`, books-api's `accounting-icp-xml`): the BTW-aangifte
//! boxes (rubrieken) from tax-ledger lines, stored returns read in the
//! current layout, and the SBR/XBRL messages of the aangifte and the Opgaaf
//! ICP.

use std::fmt::Write as _;

use serde_json::{Map, Value};
use weldsuite_books_domain::js::{self, math_round, number_value};

/// The rubrieken in `emptyRubrieken()`'s order.
pub(crate) const RUBRIEKEN: [&str; 25] = [
    "r1a", "r1aBtw", "r1b", "r1bBtw", "r1c", "r1cBtw", "r1d", "r1dBtw", "r1e", "r2a", "r2aBtw",
    "r3a", "r3b", "r3c", "r4a", "r4aBtw", "r4b", "r4bBtw", "r5a", "r5b", "r5c", "r5d", "r5e",
    "r5f", "r5g",
];

/// `VatRubrieken`: one amount per box, in [`RUBRIEKEN`] order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Rubrieken(Vec<f64>);

impl Default for Rubrieken {
    fn default() -> Self {
        Self(vec![0.0; RUBRIEKEN.len()])
    }
}

fn index_of(key: &str) -> usize {
    RUBRIEKEN
        .iter()
        .position(|k| *k == key)
        .unwrap_or_else(|| panic!("unknown rubriek {key}"))
}

impl Rubrieken {
    pub(crate) fn get(&self, key: &str) -> f64 {
        self.0[index_of(key)]
    }

    pub(crate) fn set(&mut self, key: &str, value: f64) {
        self.0[index_of(key)] = value;
    }

    fn add(&mut self, key: &str, value: f64) {
        self.0[index_of(key)] += value;
    }

    /// The JSON object, numbers as JavaScript prints them.
    pub(crate) fn to_value(&self) -> Value {
        let mut out = Map::new();
        for (key, value) in RUBRIEKEN.iter().zip(&self.0) {
            out.insert((*key).to_owned(), number_value(*value));
        }
        Value::Object(out)
    }
}

/// `Math.round(n * 100) / 100`.
pub(crate) fn round2(n: f64) -> f64 {
    math_round(n * 100.0) / 100.0
}

/// One tax-ledger line as the returns read it (`TaxReturnLine`).
#[derive(Debug, Clone)]
pub(crate) struct ReturnLine {
    pub tax_category_code: String,
    /// `sales` or `purchase`.
    pub direction: String,
    pub self_assessed: bool,
    pub taxable_amount: f64,
    pub tax_amount: f64,
    pub jurisdiction_metadata: Option<Value>,
}

/// `resolveNlRubriek(line)`: old codes of rates seeded before the official
/// numbering are read as the current ones.
fn resolve_rubriek(line: &ReturnLine) -> String {
    let code = line
        .jurisdiction_metadata
        .as_ref()
        .and_then(|m| m.get("btwRubriek"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if code == "1c" && line.tax_category_code == "reduced" {
        return "1b".into();
    }
    if code == "1e" && line.tax_amount != 0.0 {
        return "1c".into();
    }
    code
}

/// `recomputeRubriekTotals(r)`: 5a, 5c and 5g from the boxes.
pub(crate) fn recompute_totals(r: &Rubrieken) -> Rubrieken {
    let mut next = r.clone();
    let owed = round2(
        next.get("r1aBtw")
            + next.get("r1bBtw")
            + next.get("r1cBtw")
            + next.get("r1dBtw")
            + next.get("r2aBtw")
            + next.get("r4aBtw")
            + next.get("r4bBtw"),
    );
    next.set("r5a", owed);
    next.set("r5c", round2(next.get("r5a") - next.get("r5b")));
    next.set(
        "r5g",
        round2(next.get("r5c") - next.get("r5d") - next.get("r5e") + next.get("r5f")),
    );
    next
}

const PURCHASE_BASE: [&str; 3] = ["2a", "4a", "4b"];

/// `computeNlRubrieken(lines)`.
pub(crate) fn compute_rubrieken(lines: &[ReturnLine]) -> Rubrieken {
    let mut r = Rubrieken::default();
    for line in lines {
        let code = resolve_rubriek(line);
        // Every ledger line states its direction.
        let purchase = line.direction == "purchase";
        if purchase {
            if PURCHASE_BASE.contains(&code.as_str()) {
                let (base, btw) = match code.as_str() {
                    "2a" => ("r2a", "r2aBtw"),
                    "4a" => ("r4a", "r4aBtw"),
                    _ => ("r4b", "r4bBtw"),
                };
                r.add(base, line.taxable_amount);
                r.add(btw, line.tax_amount);
                r.add("r5b", line.tax_amount);
            } else if !line.self_assessed {
                r.add("r5b", line.tax_amount);
            }
            continue;
        }
        match code.as_str() {
            "1a" | "1b" | "1c" | "1d" => {
                let base = format!("r{code}");
                r.add(&base, line.taxable_amount);
                r.add(&format!("{base}Btw"), line.tax_amount);
            }
            "1e" => r.add("r1e", line.taxable_amount),
            "3a" => r.add("r3a", line.taxable_amount),
            "3b" => r.add("r3b", line.taxable_amount),
            "3c" => r.add("r3c", line.taxable_amount),
            _ => {}
        }
    }
    for value in &mut r.0 {
        *value = round2(*value);
    }
    recompute_totals(&r)
}

/// `Number(src[key])`, 0 unless finite.
fn finite(src: &Map<String, Value>, key: &str) -> f64 {
    let value = js::js_number_value(src.get(key));
    if value.is_finite() { value } else { 0.0 }
}

/// `normalizeVatRubrieken(raw)`: stored rubrieken in the current layout
/// (returns stored before the official numbering converted); `None` unless
/// an object.
pub(crate) fn normalize(raw: Option<&Value>) -> Option<Rubrieken> {
    let src = match raw {
        Some(Value::Object(map)) => map,
        // `!raw || typeof raw !== 'object'`; an array is an object to JavaScript.
        Some(Value::Array(_)) => &Map::new(),
        _ => return None,
    };
    let has = |key: &str| src.contains_key(key);
    let legacy = !has("r5g") && !has("r1aBtw") && (has("r1f") || has("r1b") || has("r5f"));
    let mut out = Rubrieken::default();
    if !legacy {
        for key in RUBRIEKEN {
            out.set(key, finite(src, key));
        }
        return Some(out);
    }
    let n = |key: &str| finite(src, key);
    out.set("r1a", n("r1a"));
    out.set("r1aBtw", n("r1b"));
    out.set("r1b", n("r1c"));
    out.set("r1bBtw", n("r1d"));
    if n("r1f") == 0.0 {
        out.set("r1e", n("r1e"));
    } else {
        out.set("r1c", n("r1e"));
        out.set("r1cBtw", n("r1f"));
    }
    for key in [
        "r2a", "r3a", "r3b", "r3c", "r4a", "r4b", "r5a", "r5b", "r5c", "r5d", "r5e",
    ] {
        out.set(key, n(key));
    }
    out.set("r5g", n("r5f"));
    Some(out)
}

/// A row with its `rubrieken` in the current layout (`withNormalizedRubrieken`).
pub(crate) fn with_normalized(mut row: Value) -> Value {
    let normalized = normalize(row.get("rubrieken")).map_or(Value::Null, |r| r.to_value());
    if let Value::Object(map) = &mut row {
        map.insert("rubrieken".into(), normalized);
    }
    row
}

// ── taxonomy ────────────────────────────────────────────────────────────────

/// `NL_TAXONOMY_VERSIONS`: (year, NT release, folder).
const TAXONOMY_VERSIONS: [(i64, &str, &str); 2] =
    [(2026, "nt20", "20251210"), (2027, "nt21", "20261209.b")];

/// `nlTaxonomyUris(periodStart)`.
pub(crate) struct TaxonomyUris {
    pub ob_entrypoint: String,
    pub icp_entrypoint: String,
    pub data_namespace: String,
    pub axes_namespace: String,
    pub domains_namespace: String,
}

pub(crate) fn taxonomy_uris(period_start: &str) -> TaxonomyUris {
    let year = js::numeric_text(Some(&period_start.chars().take(4).collect::<String>()));
    let (first, last) = (TAXONOMY_VERSIONS[0], TAXONOMY_VERSIONS[1]);
    #[allow(clippy::cast_precision_loss)]
    let (year_of, nt, release) = TAXONOMY_VERSIONS
        .iter()
        .find(|(y, _, _)| *y as f64 == year)
        .copied()
        .unwrap_or(if year > last.0 as f64 { last } else { first });
    let root = format!("http://www.nltaxonomie.nl/{nt}/bd/{release}");
    TaxonomyUris {
        ob_entrypoint: format!("{root}/entrypoints/bd-rpt-ob-aangifte-{year_of}.xsd"),
        icp_entrypoint: format!("{root}/entrypoints/bd-rpt-icp-opgaaf-{year_of}.xsd"),
        data_namespace: format!("{root}/dictionary/bd-data"),
        axes_namespace: format!("{root}/validation/bd-axes"),
        domains_namespace: format!("{root}/validation/bd-domains"),
    }
}

// ── XBRL ────────────────────────────────────────────────────────────────────

pub(crate) fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// `Math.round(value) || 0`, as JavaScript prints it.
fn whole_euros(value: f64) -> f64 {
    let rounded = math_round(value);
    if rounded == 0.0 || rounded.is_nan() {
        0.0
    } else {
        rounded
    }
}

/// `initialsOf(name)`: the first letter of each word, upper case, at most 10.
fn initials_of(name: &str) -> String {
    let letters: String = name
        .split(weldsuite_books_domain::jurisdictions::is_js_space)
        .filter_map(|word| word.chars().find(|c| c.is_alphabetic()))
        .collect::<String>()
        .to_uppercase();
    let letters = if letters.is_empty() {
        "X".to_owned()
    } else {
        letters
    };
    js::slice_utf16(&letters, 10)
}

/// `phone.replace(/[^\d+]/g, '').slice(0, 14)`.
fn telephone_of(phone: &str) -> String {
    phone
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .take(14)
        .collect()
}

/// The text of the first `n` UTF-16 units (`.slice(0, n)`).
fn head(text: &str, n: usize) -> String {
    js::slice_utf16(text, n)
}

/// `OMZETBELASTINGNUMMER_SCHEME`.
const SCHEME: &str = "http://www.belastingdienst.nl/omzetbelastingnummer";

/// `VatXmlInput`.
pub(crate) struct VatXmlInput<'a> {
    pub btw_number: &'a str,
    pub contact_name: &'a str,
    pub contact_phone: &'a str,
    /// ISO timestamps (`toISOString()`).
    pub period_start: &'a str,
    pub period_end: &'a str,
    pub rubrieken: &'a Rubrieken,
    pub message_reference: &'a str,
    /// `new Date().toISOString()`.
    pub now: &'a str,
}

/// `generateVatXml(input)`.
pub(crate) fn generate_vat_xml(input: &VatXmlInput<'_>) -> String {
    let start = head(input.period_start, 10);
    let end = head(input.period_end, 10);
    let taxonomy = taxonomy_uris(&start);
    let mut r = input.rubrieken.clone();
    for value in &mut r.0 {
        *value = whole_euros(*value);
    }
    r.set(
        "r5a",
        r.get("r1aBtw")
            + r.get("r1bBtw")
            + r.get("r1cBtw")
            + r.get("r1dBtw")
            + r.get("r2aBtw")
            + r.get("r4aBtw")
            + r.get("r4bBtw"),
    );
    let amount = |element: &str, value: f64| {
        format!(
            "  <bd-i:{element} contextRef=\"Msg\" unitRef=\"EUR\" decimals=\"0\">{}</bd-i:{element}>",
            js::number_text(value)
        )
    };
    let facts = [
        "  <!-- 1. Prestaties binnenland -->".to_owned(),
        "  <!-- 1a: hoog tarief -->".to_owned(),
        amount("TaxedTurnoverSuppliesServicesGeneralTariff", r.get("r1a")),
        amount(
            "ValueAddedTaxSuppliesServicesGeneralTariff",
            r.get("r1aBtw"),
        ),
        "  <!-- 1b: laag tarief -->".to_owned(),
        amount("TaxedTurnoverSuppliesServicesReducedTariff", r.get("r1b")),
        amount(
            "ValueAddedTaxSuppliesServicesReducedTariff",
            r.get("r1bBtw"),
        ),
        "  <!-- 1c: overige tarieven, behalve 0% -->".to_owned(),
        amount("TaxedTurnoverSuppliesServicesOtherRates", r.get("r1c")),
        amount("ValueAddedTaxSuppliesServicesOtherRates", r.get("r1cBtw")),
        "  <!-- 1d: privégebruik -->".to_owned(),
        amount("TaxedTurnoverPrivateUse", r.get("r1d")),
        amount("ValueAddedTaxPrivateUse", r.get("r1dBtw")),
        "  <!-- 1e: 0% of niet bij u belast -->".to_owned(),
        amount("SuppliesServicesNotTaxed", r.get("r1e")),
        "  <!-- 2. Verleggingsregelingen binnenland -->".to_owned(),
        amount(
            "TurnoverSuppliesServicesByWhichVATTaxationIsTransferred",
            r.get("r2a"),
        ),
        amount(
            "ValueAddedTaxSuppliesServicesByWhichVATTaxationIsTransferred",
            r.get("r2aBtw"),
        ),
        "  <!-- 3. Prestaties naar of in het buitenland -->".to_owned(),
        "  <!-- 3a: leveringen naar landen buiten de EU -->".to_owned(),
        amount("SuppliesToCountriesOutsideTheEC", r.get("r3a")),
        "  <!-- 3b: leveringen naar / diensten in landen binnen de EU -->".to_owned(),
        amount("SuppliesToCountriesWithinTheEC", r.get("r3b")),
        "  <!-- 3c: installatie / afstandsverkopen binnen de EU -->".to_owned(),
        amount("InstallationDistanceSalesWithinTheEC", r.get("r3c")),
        "  <!-- 4. Prestaties vanuit het buitenland aan u verricht -->".to_owned(),
        "  <!-- 4a: uit landen buiten de EU -->".to_owned(),
        amount(
            "TurnoverFromTaxedSuppliesFromCountriesOutsideTheEC",
            r.get("r4a"),
        ),
        amount(
            "ValueAddedTaxOnSuppliesFromCountriesOutsideTheEC",
            r.get("r4aBtw"),
        ),
        "  <!-- 4b: uit landen binnen de EU -->".to_owned(),
        amount(
            "TurnoverFromTaxedSuppliesFromCountriesWithinTheEC",
            r.get("r4b"),
        ),
        amount(
            "ValueAddedTaxOnSuppliesFromCountriesWithinTheEC",
            r.get("r4bBtw"),
        ),
        "  <!-- 5. Berekening -->".to_owned(),
        "  <!-- 5a: verschuldigde omzetbelasting -->".to_owned(),
        amount("ValueAddedTaxOwed", r.get("r5a")),
        "  <!-- 5b: voorbelasting -->".to_owned(),
        amount("ValueAddedTaxOnInput", r.get("r5b")),
        "  <!-- 5c: subtotaal -->".to_owned(),
        amount("ValueAddedTaxOwedToBePaidBack", r.get("r5a") - r.get("r5b")),
    ]
    .join("\n");
    let phone = telephone_of(input.contact_phone);
    let mut contact = vec![
        "  <bd-i:ContactType contextRef=\"Msg\">BPL</bd-i:ContactType>".to_owned(),
        format!(
            "  <bd-i:ContactInitials contextRef=\"Msg\">{}</bd-i:ContactInitials>",
            escape_xml(&initials_of(input.contact_name))
        ),
        format!(
            "  <bd-i:ContactSurname contextRef=\"Msg\">{}</bd-i:ContactSurname>",
            escape_xml(&head(input.contact_name, 200))
        ),
    ];
    if !phone.is_empty() {
        contact.push(format!(
            "  <bd-i:ContactTelephoneNumber contextRef=\"Msg\">{}</bd-i:ContactTelephoneNumber>",
            escape_xml(&phone)
        ));
    }
    let contact = contact.join("\n");
    let reference = escape_xml(&head(input.message_reference, 200));
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<xbrli:xbrl
  xmlns:xbrli=\"http://www.xbrl.org/2003/instance\"
  xmlns:xlink=\"http://www.w3.org/1999/xlink\"
  xmlns:link=\"http://www.xbrl.org/2003/linkbase\"
  xmlns:iso4217=\"http://www.xbrl.org/2003/iso4217\"
  xmlns:bd-i=\"{data}\">

  <link:schemaRef
    xlink:type=\"simple\"
    xlink:href=\"{entry}\" />

  <xbrli:context id=\"Msg\">
    <xbrli:entity>
      <xbrli:identifier scheme=\"{SCHEME}\">{btw}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:startDate>{start}</xbrli:startDate>
      <xbrli:endDate>{end}</xbrli:endDate>
    </xbrli:period>
  </xbrli:context>

  <xbrli:unit id=\"EUR\">
    <xbrli:measure>iso4217:EUR</xbrli:measure>
  </xbrli:unit>

  <!-- Message details and contact -->
  <bd-i:DateTimeCreation contextRef=\"Msg\">{now}</bd-i:DateTimeCreation>
  <bd-i:MessageReferenceSupplierVAT contextRef=\"Msg\">{reference}</bd-i:MessageReferenceSupplierVAT>
  <bd-i:SoftwarePackageName contextRef=\"Msg\">WeldSuite</bd-i:SoftwarePackageName>
  <bd-i:SoftwarePackageVersion contextRef=\"Msg\">1.0</bd-i:SoftwarePackageVersion>
{contact}

{facts}

</xbrli:xbrl>",
        data = taxonomy.data_namespace,
        entry = taxonomy.ob_entrypoint,
        btw = escape_xml(input.btw_number),
        now = input.now,
    )
}

/// `IcpXmlLine`.
pub(crate) struct IcpXmlLine {
    pub vat_number: String,
    pub country_code: String,
    /// `goods`, `services` or `triangulation`.
    pub supply_type: String,
    pub amount: f64,
}

/// `icpSupplyElement(type)`.
fn icp_supply_element(kind: &str) -> &'static str {
    match kind {
        "services" => "ServicesAmount",
        "triangulation" => "ABCSuppliesAmount",
        _ => "SuppliesAmount",
    }
}

/// `IcpXmlInput`.
pub(crate) struct IcpXmlInput<'a> {
    pub btw_number: &'a str,
    pub contact_name: &'a str,
    pub contact_phone: &'a str,
    pub message_reference: &'a str,
    pub period_start: &'a str,
    pub period_end: &'a str,
    pub lines: &'a [IcpXmlLine],
    pub now: &'a str,
}

/// `generateIcpXml(input)`.
pub(crate) fn generate_icp_xml(input: &IcpXmlInput<'_>) -> String {
    let start = head(input.period_start, 10);
    let end = head(input.period_end, 10);
    let taxonomy = taxonomy_uris(&start);
    let btw = escape_xml(input.btw_number);

    // One context per counterparty, in first-seen order.
    let mut per: Vec<(String, String, Vec<(String, f64)>)> = Vec::new();
    for line in input.lines {
        let at = per.iter().position(|(vat, _, _)| *vat == line.vat_number);
        let at = at.unwrap_or_else(|| {
            per.push((
                line.vat_number.clone(),
                line.country_code.clone(),
                Vec::new(),
            ));
            per.len() - 1
        });
        let amounts = &mut per[at].2;
        if let Some(entry) = amounts.iter_mut().find(|(t, _)| *t == line.supply_type) {
            entry.1 += line.amount;
        } else {
            amounts.push((line.supply_type.clone(), line.amount));
        }
    }

    let mut contexts = String::new();
    let mut facts: Vec<String> = Vec::new();
    for (idx, (vat, country, amounts)) in per.iter().enumerate() {
        let id = format!("Line{}", idx + 1);
        let country = country.to_uppercase();
        let number = if vat.to_uppercase().starts_with(&country) {
            // `.slice(country.length)`: the codes are ASCII letters.
            vat.chars().skip(country.chars().count()).collect()
        } else {
            vat.clone()
        };
        let _ = write!(
            contexts,
            "
  <xbrli:context id=\"{id}\">
    <xbrli:entity>
      <xbrli:identifier scheme=\"{SCHEME}\">{btw}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:startDate>{start}</xbrli:startDate>
      <xbrli:endDate>{end}</xbrli:endDate>
    </xbrli:period>
    <xbrli:scenario>
      <xbrldi:typedMember dimension=\"bd-dim-dim:CountryCodeEUDimension\">
        <bd-dim-dom:CountryCodeEUDomain>{}</bd-dim-dom:CountryCodeEUDomain>
      </xbrldi:typedMember>
      <xbrldi:typedMember dimension=\"bd-dim-dim:VATNumberDimension\">
        <bd-dim-dom:VATNumberDomain>{}</bd-dim-dom:VATNumberDomain>
      </xbrldi:typedMember>
    </xbrli:scenario>
  </xbrli:context>",
            escape_xml(&country),
            escape_xml(&number)
        );
        for kind in ["goods", "services", "triangulation"] {
            let Some((_, amount)) = amounts.iter().find(|(t, _)| t == kind) else {
                continue;
            };
            let element = icp_supply_element(kind);
            facts.push(format!(
                "  <bd-i:{element} contextRef=\"{id}\" unitRef=\"EUR\" decimals=\"0\">{}</bd-i:{element}>",
                js::number_text(whole_euros(*amount))
            ));
        }
    }

    let phone = telephone_of(input.contact_phone);
    let reference = escape_xml(&head(input.message_reference, 200));
    let phone_line = if phone.is_empty() {
        String::new()
    } else {
        format!(
            "\n  <bd-i:ContactTelephoneNumber contextRef=\"Msg\">{}</bd-i:ContactTelephoneNumber>",
            escape_xml(&phone)
        )
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<xbrli:xbrl
  xmlns:xbrli=\"http://www.xbrl.org/2003/instance\"
  xmlns:link=\"http://www.xbrl.org/2003/linkbase\"
  xmlns:xlink=\"http://www.w3.org/1999/xlink\"
  xmlns:iso4217=\"http://www.xbrl.org/2003/iso4217\"
  xmlns:xbrldi=\"http://xbrl.org/2006/xbrldi\"
  xmlns:bd-i=\"{data}\"
  xmlns:bd-dim-dim=\"{axes}\"
  xmlns:bd-dim-dom=\"{domains}\">
  <link:schemaRef xlink:type=\"simple\" xlink:href=\"{entry}\"/>
  <xbrli:context id=\"Msg\">
    <xbrli:entity>
      <xbrli:identifier scheme=\"{SCHEME}\">{btw}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:startDate>{start}</xbrli:startDate>
      <xbrli:endDate>{end}</xbrli:endDate>
    </xbrli:period>
  </xbrli:context>{contexts}
  <xbrli:unit id=\"EUR\">
    <xbrli:measure>iso4217:EUR</xbrli:measure>
  </xbrli:unit>
  <bd-i:DateTimeCreation contextRef=\"Msg\">{now}</bd-i:DateTimeCreation>
  <bd-i:MessageReferenceSupplierVAT contextRef=\"Msg\">{reference}</bd-i:MessageReferenceSupplierVAT>
  <bd-i:SoftwarePackageName contextRef=\"Msg\">WeldSuite</bd-i:SoftwarePackageName>
  <bd-i:SoftwarePackageVersion contextRef=\"Msg\">1.0</bd-i:SoftwarePackageVersion>
  <bd-i:ContactType contextRef=\"Msg\">BPL</bd-i:ContactType>
  <bd-i:ContactInitials contextRef=\"Msg\">{initials}</bd-i:ContactInitials>
  <bd-i:ContactSurname contextRef=\"Msg\">{surname}</bd-i:ContactSurname>{phone_line}
{facts}
</xbrli:xbrl>",
        data = taxonomy.data_namespace,
        axes = taxonomy.axes_namespace,
        domains = taxonomy.domains_namespace,
        entry = taxonomy.icp_entrypoint,
        now = input.now,
        initials = escape_xml(&initials_of(input.contact_name)),
        surname = escape_xml(&head(input.contact_name, 200)),
        facts = facts.join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(code: &str, category: &str, direction: &str, base: f64, tax: f64) -> ReturnLine {
        ReturnLine {
            tax_category_code: category.into(),
            direction: direction.into(),
            self_assessed: false,
            taxable_amount: base,
            tax_amount: tax,
            jurisdiction_metadata: Some(serde_json::json!({ "btwRubriek": code })),
        }
    }

    #[test]
    fn boxes_and_totals() {
        let r = compute_rubrieken(&[
            line("1a", "standard", "sales", 1000.0, 210.0),
            line("1c", "reduced", "sales", 500.0, 45.0),
            line("1e", "zero", "sales", 250.0, 0.0),
            line("1a", "standard", "purchase", 100.0, 21.0),
            line("4b", "eu", "purchase", 200.0, 42.0),
        ]);
        assert_eq!(r.get("r1a"), 1000.0);
        assert_eq!(r.get("r1b"), 500.0);
        assert_eq!(r.get("r1bBtw"), 45.0);
        assert_eq!(r.get("r1e"), 250.0);
        assert_eq!(r.get("r4b"), 200.0);
        assert_eq!(r.get("r5a"), 297.0);
        assert_eq!(r.get("r5b"), 63.0);
        assert_eq!(r.get("r5g"), 234.0);
    }

    #[test]
    fn legacy_layout() {
        let r = normalize(Some(
            &serde_json::json!({ "r1a": 10, "r1b": 2.1, "r1e": 5, "r5f": 7 }),
        ))
        .expect("an object");
        assert_eq!(r.get("r1aBtw"), 2.1);
        assert_eq!(r.get("r1e"), 5.0);
        assert_eq!(r.get("r5g"), 7.0);
        assert!(normalize(Some(&Value::Null)).is_none());
    }

    #[test]
    fn initials() {
        assert_eq!(initials_of("Aangifte BV"), "AB");
        assert_eq!(initials_of("  "), "X");
        assert_eq!(telephone_of("+31 (20) 123-4567"), "+31201234567");
    }
}
