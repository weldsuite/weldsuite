//! The KvK deposit of a micro or small company's publicatiestukken as an XBRL
//! instance in the Nederlandse Taxonomie (the "XBRL-formaat" route, an
//! `.xbrl` file over Digipoort, berichtsoort `Jaarrekening`).
//!
//! Laid out as SBR-NL's sample instances for NT20 and NT21
//! (`kvk-rpt-jaarverantwoording-<year>-nlgaap-{micro,klein}-publicatiestukken`):
//! the document facts in a plain duration context, the balance sheet in
//! instant contexts with `BasisOfPreparationAxis = CommercialMember` and
//! `FinancialStatementsTypeAxis = SeparateMember` (no dimension defaults, so
//! both are always written), amounts in whole euros with `decimals="INF"`,
//! and only the contexts and units the facts use (KvK filing rules FR-NL-3.03,
//! 4.01). Neither entrypoint has a profit and loss account. Sources: KvK
//! Filing and Business Rules NT20 v1.0 and NT21 v1.1, the RTS 2025 and 2026.

use std::fmt::Write as _;

use super::figures::{Item, Lines};

/// The micro (art. 2:395a BW) or small (art. 2:396 BW) entrypoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Size {
    Micro,
    Small,
}

impl Size {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "micro" => Some(Self::Micro),
            "small" => Some(Self::Small),
            _ => None,
        }
    }

    fn entrypoint(self) -> &'static str {
        match self {
            Self::Micro => "micro",
            Self::Small => "klein",
        }
    }
}

/// The NT release a financial year is filed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Taxonomy {
    /// The year in the entrypoint's name.
    pub year: i32,
    nt: &'static str,
    /// The release folder of the KvK, jenv and rj parts.
    folder: &'static str,
    /// The release folder of `nl-common-data`.
    sbr: &'static str,
}

/// The releases this backend writes: the financial years 2025 (NT20,
/// accepted from 1 January 2026) and 2026 (NT21, from 1 January 2027).
/// A year is the one the financial year starts in (RTS annex I).
const TAXONOMIES: [Taxonomy; 2] = [
    Taxonomy {
        year: 2025,
        nt: "nt20",
        folder: "20251210",
        sbr: "20250301",
    },
    Taxonomy {
        year: 2026,
        nt: "nt21",
        folder: "20261209",
        sbr: "20260301",
    },
];

/// The taxonomy of the financial year starting in `year`, when there is one.
pub(crate) fn taxonomy_for(year: i32) -> Option<Taxonomy> {
    TAXONOMIES.into_iter().find(|t| t.year == year)
}

/// The years a report can be filed for, for the messages.
pub(crate) fn supported_years() -> String {
    TAXONOMIES
        .iter()
        .map(|t| t.year.to_string())
        .collect::<Vec<_>>()
        .join(" and ")
}

impl Taxonomy {
    fn root(self, part: &str, folder: &str) -> String {
        format!("http://www.nltaxonomie.nl/{}/{part}/{folder}", self.nt)
    }

    fn entrypoint(self, size: Size) -> String {
        format!(
            "{}/entrypoints/kvk-rpt-jaarverantwoording-{}-nlgaap-{}-publicatiestukken.xsd",
            self.root("kvk", self.folder),
            self.year,
            size.entrypoint()
        )
    }
}

/// What the instance states.
pub(crate) struct Document<'a> {
    pub taxonomy: Taxonomy,
    pub size: Size,
    pub kvk_number: &'a str,
    pub name: &'a str,
    /// `LegalEntityLegalForm`'s enumeration value.
    pub legal_form: &'a str,
    pub registered_office: &'a str,
    pub city: &'a str,
    /// `1234AB`.
    pub postal_code: &'a str,
    pub email: &'a str,
    /// `YYYY-MM-DD`.
    pub start: &'a str,
    pub end: &'a str,
    /// The previous financial year, when the comparative figures are given.
    pub previous: Option<(&'a str, &'a str)>,
    pub prepared_on: &'a str,
    /// The adoption date when the general meeting adopted the accounts.
    pub adopted_on: Option<&'a str>,
    /// Before profit appropriation (`Voor`), or after (`Na`).
    pub before_appropriation: bool,
    /// Rounded to whole euros.
    pub current: &'a Lines,
    pub prior: Option<&'a Lines>,
    pub average_employees: Option<f64>,
}

/// What the filing rules allow in text (FR-NL-1.02: Basic Latin, Latin-1
/// Supplement and Currency Symbols): typographic quotes and dashes become
/// their ASCII forms, anything else outside those blocks is dropped.
pub(crate) fn filing_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{2032}' => out.push('\''),
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{2033}' => out.push('"'),
            '\u{2013}' | '\u{2014}' | '\u{2212}' => out.push('-'),
            '\u{2026}' => out.push_str("..."),
            '\t' | '\n' | '\r' => out.push(' '),
            c if c < ' ' => {}
            c if (c as u32) <= 0xFF || ('\u{20A0}'..='\u{20CF}').contains(&c) => out.push(c),
            _ => {}
        }
    }
    out.trim().to_owned()
}

fn escape(value: &str) -> String {
    weldsuite_digipoort::xml::escape(&filing_text(value))
}

const KVK_SCHEME: &str = "http://www.kvk.nl/kvk-id";
const DURATION: &str = "D";
const DURATION_CS: &str = "D_CS";
const INSTANT_CS: &str = "I_CS";
const PRIOR_INSTANT_CS: &str = "PI_CS";

struct Writer<'a> {
    doc: &'a Document<'a>,
    out: String,
}

impl Writer<'_> {
    fn context(&mut self, id: &str, period: &str, commercial_separate: bool) {
        let scenario = if commercial_separate {
            "\n    <xbrli:scenario>\n      <xbrldi:explicitMember dimension=\"jenv-bw2-dim:BasisOfPreparationAxis\">jenv-bw2-dm:CommercialMember</xbrldi:explicitMember>\n      <xbrldi:explicitMember dimension=\"jenv-bw2-dim:FinancialStatementsTypeAxis\">jenv-bw2-dm:SeparateMember</xbrldi:explicitMember>\n    </xbrli:scenario>"
        } else {
            ""
        };
        let _ = write!(
            self.out,
            "\n  <xbrli:context id=\"{id}\">\n    <xbrli:entity>\n      <xbrli:identifier scheme=\"{KVK_SCHEME}\">{}</xbrli:identifier>\n    </xbrli:entity>\n    <xbrli:period>\n      {period}\n    </xbrli:period>{scenario}\n  </xbrli:context>",
            escape(self.doc.kvk_number)
        );
    }

    fn text(&mut self, concept: &str, context: &str, value: &str) {
        let _ = write!(
            self.out,
            "\n  <{concept} contextRef=\"{context}\">{}</{concept}>",
            escape(value)
        );
    }

    fn money(&mut self, concept: &str, context: &str, amount: f64) {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "whole euros, far inside i64"
        )]
        let whole = amount.round() as i64;
        let _ = write!(
            self.out,
            "\n  <{concept} decimals=\"INF\" contextRef=\"{context}\" unitRef=\"EUR\">{whole}</{concept}>"
        );
    }

    fn pure(&mut self, concept: &str, context: &str, value: f64) {
        let number = if value.fract() == 0.0 {
            format!("{value:.0}")
        } else {
            format!("{value:.2}").trim_end_matches('0').to_owned()
        };
        let _ = write!(
            self.out,
            "\n  <{concept} decimals=\"INF\" contextRef=\"{context}\" unitRef=\"pure\">{number}</{concept}>"
        );
    }

    /// A balance sheet line, left out when it is zero.
    fn line(&mut self, concept: &str, context: &str, amount: f64) {
        if amount != 0.0 {
            self.money(concept, context, amount);
        }
    }

    #[allow(
        clippy::too_many_lines,
        reason = "one fact per line of the two layouts"
    )]
    fn balance_sheet(&mut self, context: &str, lines: &Lines) {
        match self.doc.size {
            Size::Micro => {
                self.line(
                    "jenv-bw2-i:AssetsNoncurrentOther",
                    context,
                    lines.fixed_assets(),
                );
                self.money("jenv-bw2-i:AssetsNoncurrent", context, lines.fixed_assets());
                self.line(
                    "jenv-bw2-i:AssetsCurrentOther",
                    context,
                    lines.current_assets(),
                );
                self.money("jenv-bw2-i:AssetsCurrent", context, lines.current_assets());
                self.money("jenv-bw2-i:Assets", context, lines.assets());
                self.money("jenv-bw2-i:Equity", context, lines.equity());
                self.line(
                    "jenv-bw2-i:Provisions",
                    context,
                    lines.get(Item::Provisions),
                );
                self.line(
                    "jenv-bw2-i:LiabilitiesMaturityExceedingOneYear",
                    context,
                    lines.get(Item::LongTermLiabilities),
                );
                self.line(
                    "jenv-bw2-i:LiabilitiesMaturityLessThanOneYear",
                    context,
                    lines.get(Item::CurrentLiabilities),
                );
                self.money("jenv-bw2-i:Liabilities", context, lines.liabilities());
                self.money(
                    "jenv-bw2-i:EquityAndLiabilities",
                    context,
                    lines.equity_and_liabilities(),
                );
            }
            Size::Small => {
                for (concept, item) in [
                    ("jenv-bw2-i:IntangibleAssets", Item::IntangibleAssets),
                    ("jenv-bw2-i:PropertyPlantEquipment", Item::TangibleAssets),
                    ("jenv-bw2-i:FinancialAssets", Item::FinancialAssets),
                ] {
                    self.line(concept, context, lines.get(item));
                }
                self.money("jenv-bw2-i:AssetsNoncurrent", context, lines.fixed_assets());
                for (concept, item) in [
                    ("jenv-bw2-i:Inventories", Item::Inventories),
                    ("jenv-bw2-i:Receivables", Item::Receivables),
                    ("jenv-bw2-i:SecuritiesCurrent", Item::Securities),
                    ("jenv-bw2-i:CashAndCashEquivalents", Item::Cash),
                ] {
                    self.line(concept, context, lines.get(item));
                }
                self.money("jenv-bw2-i:AssetsCurrent", context, lines.current_assets());
                self.money("jenv-bw2-i:Assets", context, lines.assets());
                // After appropriation the result is part of the reserves
                // (and SHOULD NOT be reported on its own).
                let result = lines.get(Item::ResultForTheYear);
                let (result, other) = if self.doc.before_appropriation {
                    (result, lines.get(Item::OtherReserves))
                } else {
                    (0.0, lines.get(Item::OtherReserves) + result)
                };
                for (concept, amount) in [
                    (
                        "jenv-bw2-i:ShareCapitalPaidCalledUp",
                        lines.get(Item::ShareCapital),
                    ),
                    ("jenv-bw2-i:SharePremium", lines.get(Item::SharePremium)),
                    (
                        "jenv-bw2-i:RevaluationReserve",
                        lines.get(Item::RevaluationReserve),
                    ),
                    ("jenv-bw2-i:LegalReserves", lines.get(Item::LegalReserves)),
                    (
                        "jenv-bw2-i:StatutoryReserves",
                        lines.get(Item::StatutoryReserves),
                    ),
                    ("jenv-bw2-i:ReservesOther", other),
                    ("jenv-bw2-i:ResultForTheYear", result),
                ] {
                    self.line(concept, context, amount);
                }
                self.money("jenv-bw2-i:Equity", context, lines.equity());
                self.line(
                    "jenv-bw2-i:Provisions",
                    context,
                    lines.get(Item::Provisions),
                );
                self.line(
                    "jenv-bw2-i:LiabilitiesNoncurrent",
                    context,
                    lines.get(Item::LongTermLiabilities),
                );
                self.line(
                    "jenv-bw2-i:LiabilitiesCurrent",
                    context,
                    lines.get(Item::CurrentLiabilities),
                );
                self.money(
                    "jenv-bw2-i:EquityAndLiabilities",
                    context,
                    lines.equity_and_liabilities(),
                );
            }
        }
    }
}

/// Whether the period is anything but exactly one year (twelve months
/// ending the day before the same date a year later).
fn differs_from_a_year(start: &str, end: &str) -> bool {
    let (Some(year), Some(rest)) = (
        start.get(..4).and_then(|y| y.parse::<i32>().ok()),
        start.get(4..),
    ) else {
        return true;
    };
    let next = format!("{}{rest}", year + 1);
    weldsuite_books_domain::dates::add_days(&next, -1).as_deref() != Some(end)
}

/// The instance.
#[allow(
    clippy::too_many_lines,
    reason = "the instance, fact by fact, in the samples' order"
)]
pub(crate) fn instance(doc: &Document<'_>) -> String {
    let t = doc.taxonomy;
    let namespaces = [
        ("link", "http://www.xbrl.org/2003/linkbase".to_owned()),
        (
            "rj-i",
            format!("{}/dictionary/rj-data", t.root("rj", t.folder)),
        ),
        (
            "jenv-bw2-dm",
            format!("{}/dictionary/jenv-bw2-domains", t.root("jenv", t.folder)),
        ),
        ("xbrldi", "http://xbrl.org/2006/xbrldi".to_owned()),
        (
            "jenv-bw2-i",
            format!("{}/dictionary/jenv-bw2-data", t.root("jenv", t.folder)),
        ),
        ("xbrli", "http://www.xbrl.org/2003/instance".to_owned()),
        ("iso4217", "http://www.xbrl.org/2003/iso4217".to_owned()),
        (
            "jenv-bw2-dim",
            format!("{}/dictionary/jenv-bw2-axes", t.root("jenv", t.folder)),
        ),
        (
            "nl-cd",
            format!("{}/dictionary/nl-common-data", t.root("sbr", t.sbr)),
        ),
        ("xlink", "http://www.w3.org/1999/xlink".to_owned()),
        (
            "kvk-i",
            format!("{}/dictionary/kvk-data", t.root("kvk", t.folder)),
        ),
    ];
    let declarations = namespaces
        .iter()
        .fold(String::new(), |mut out, (prefix, uri)| {
            let _ = write!(out, " xmlns:{prefix}=\"{uri}\"");
            out
        });
    let mut w = Writer {
        doc,
        out: format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<xbrli:xbrl xml:lang=\"nl\"{declarations}>\n  <link:schemaRef xlink:type=\"simple\" xlink:href=\"{}\"/>",
            t.entrypoint(doc.size)
        ),
    };
    let duration = format!(
        "<xbrli:startDate>{}</xbrli:startDate>\n      <xbrli:endDate>{}</xbrli:endDate>",
        doc.start, doc.end
    );
    w.context(DURATION, &duration, false);
    w.context(DURATION_CS, &duration, true);
    w.context(
        INSTANT_CS,
        &format!("<xbrli:instant>{}</xbrli:instant>", doc.end),
        true,
    );
    let prior = doc.prior.zip(doc.previous);
    if let Some((_, (_, previous_end))) = prior {
        w.context(
            PRIOR_INSTANT_CS,
            &format!("<xbrli:instant>{previous_end}</xbrli:instant>"),
            true,
        );
    }
    w.out.push_str("\n  <xbrli:unit id=\"EUR\">\n    <xbrli:measure>iso4217:EUR</xbrli:measure>\n  </xbrli:unit>");
    let employees = doc.average_employees.filter(|_| doc.size == Size::Small);
    if employees.is_some() {
        w.out.push_str("\n  <xbrli:unit id=\"pure\">\n    <xbrli:measure>xbrli:pure</xbrli:measure>\n  </xbrli:unit>");
    }

    // The entity and the document.
    w.text("nl-cd:EmailAddressFull", DURATION, doc.email);
    w.text("nl-cd:PostalCodeNL", DURATION, doc.postal_code);
    w.text("nl-cd:PlaceOfResidenceNL", DURATION, doc.city);
    w.text("nl-cd:LegalEntityName", DURATION, doc.name);
    w.text("jenv-bw2-i:LegalEntityLegalForm", DURATION, doc.legal_form);
    w.text(
        "jenv-bw2-i:LegalEntityRegisteredOffice",
        DURATION,
        doc.registered_office,
    );
    w.text(
        "nl-cd:ChamberOfCommerceRegistrationNumber",
        DURATION,
        doc.kvk_number,
    );
    w.text(
        "rj-i:FinancialStatementsDateOfPreparation",
        DURATION,
        doc.prepared_on,
    );
    w.text(
        "jenv-bw2-i:FinancialReportingPeriodCurrentStartDate",
        DURATION,
        doc.start,
    );
    w.text(
        "jenv-bw2-i:FinancialReportingPeriodCurrentEndDate",
        DURATION,
        doc.end,
    );
    match doc.adopted_on {
        Some(date) => {
            w.text("jenv-bw2-i:DocumentAdoptionStatus", DURATION, "Ja");
            w.text("jenv-bw2-i:DocumentAdoptionDate", DURATION, date);
        }
        None => w.text("jenv-bw2-i:DocumentAdoptionStatus", DURATION, "Nee"),
    }
    if let Some((_, (previous_start, previous_end))) = prior {
        w.text(
            "jenv-bw2-i:FinancialReportingPeriodPreviousStartDate",
            DURATION,
            previous_start,
        );
        w.text(
            "jenv-bw2-i:FinancialReportingPeriodPreviousEndDate",
            DURATION,
            previous_end,
        );
    }
    // NT21 moved this fact of the small entrypoint into the
    // commercial-separate context; the rest keep it plain.
    let different_context = if doc.size == Size::Small && t.year >= 2026 {
        DURATION_CS
    } else {
        DURATION
    };
    w.text(
        "rj-i:FinancialReportingPeriodDifferentThanAnnualStatus",
        different_context,
        if differs_from_a_year(doc.start, doc.end) {
            "Ja"
        } else {
            "Nee"
        },
    );
    w.text("nl-cd:DocumentPresentationCurrency", DURATION, "EUR");
    w.text("jenv-bw2-i:BasisOfPreparation", DURATION, "Commercieel");
    w.text(
        "jenv-bw2-i:BalanceSheetBeforeAfterAppropriationResults",
        DURATION_CS,
        if doc.before_appropriation {
            "Voor"
        } else {
            "Na"
        },
    );

    // The balance sheet, this year and the comparative figures.
    w.balance_sheet(INSTANT_CS, doc.current);
    if let Some((lines, _)) = prior {
        w.balance_sheet(PRIOR_INSTANT_CS, lines);
    }

    if let Some(employees) = employees {
        w.pure("jenv-bw2-i:AverageNumberEmployees", DURATION_CS, employees);
    }
    match doc.size {
        Size::Micro => w.text(
            "kvk-i:LegalSizeCriteriaClassificationMicro",
            DURATION,
            "Micro",
        ),
        Size::Small => w.text(
            "kvk-i:LegalSizeCriteriaClassificationSmall",
            DURATION,
            "Klein",
        ),
    }
    w.out.push_str("\n</xbrli:xbrl>\n");
    w.out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn lines(pairs: &[(Item, f64)]) -> Lines {
        Lines(pairs.iter().copied().collect())
    }

    pub(crate) fn document<'a>(
        size: Size,
        year: i32,
        current: &'a Lines,
        prior: Option<&'a Lines>,
    ) -> Document<'a> {
        Document {
            taxonomy: taxonomy_for(year).expect("taxonomy"),
            size,
            kvk_number: "12345678",
            name: "Voorbeeld B.V.",
            legal_form: "Besloten vennootschap met beperkte aansprakelijkheid",
            registered_office: "Den Haag",
            city: "Den Haag",
            postal_code: "2514GL",
            email: "info@voorbeeld.nl",
            start: if year == 2025 {
                "2025-01-01"
            } else {
                "2026-01-01"
            },
            end: if year == 2025 {
                "2025-12-31"
            } else {
                "2026-12-31"
            },
            previous: Some(if year == 2025 {
                ("2024-01-01", "2024-12-31")
            } else {
                ("2025-01-01", "2025-12-31")
            }),
            prepared_on: if year == 2025 {
                "2026-03-01"
            } else {
                "2027-03-01"
            },
            adopted_on: None,
            before_appropriation: true,
            current,
            prior,
            average_employees: Some(3.0),
        }
    }

    #[test]
    fn writes_a_micro_instance_as_the_sample_does() {
        let current = lines(&[
            (Item::TangibleAssets, 150_000.0),
            (Item::Cash, 50_000.0),
            (Item::ShareCapital, 18_000.0),
            (Item::OtherReserves, 82_000.0),
            (Item::Provisions, 25_000.0),
            (Item::CurrentLiabilities, 75_000.0),
        ]);
        let xml = instance(&document(Size::Micro, 2025, &current, None));
        assert!(xml.contains("xlink:href=\"http://www.nltaxonomie.nl/nt20/kvk/20251210/entrypoints/kvk-rpt-jaarverantwoording-2025-nlgaap-micro-publicatiestukken.xsd\""));
        assert!(xml.contains(
            "xmlns:nl-cd=\"http://www.nltaxonomie.nl/nt20/sbr/20250301/dictionary/nl-common-data\""
        ));
        assert!(xml.contains("<jenv-bw2-i:AssetsNoncurrentOther decimals=\"INF\" contextRef=\"I_CS\" unitRef=\"EUR\">150000</jenv-bw2-i:AssetsNoncurrentOther>"));
        assert!(xml.contains("<jenv-bw2-i:Equity decimals=\"INF\" contextRef=\"I_CS\" unitRef=\"EUR\">100000</jenv-bw2-i:Equity>"));
        assert!(xml.contains("<jenv-bw2-i:Liabilities decimals=\"INF\" contextRef=\"I_CS\" unitRef=\"EUR\">75000</jenv-bw2-i:Liabilities>"));
        assert!(xml.contains("<kvk-i:LegalSizeCriteriaClassificationMicro contextRef=\"D\">Micro</kvk-i:LegalSizeCriteriaClassificationMicro>"));
        assert!(xml.contains("<rj-i:FinancialReportingPeriodDifferentThanAnnualStatus contextRef=\"D\">Nee</rj-i:FinancialReportingPeriodDifferentThanAnnualStatus>"));
        assert!(xml.contains("<jenv-bw2-i:DocumentAdoptionStatus contextRef=\"D\">Nee</jenv-bw2-i:DocumentAdoptionStatus>"));
        // No comparative figures: no prior context, no previous dates, and
        // micro has no employees, so no pure unit.
        assert!(!xml.contains("PI_CS"));
        assert!(!xml.contains("PreviousStartDate"));
        assert!(!xml.contains("unit id=\"pure\""));
        assert!(!xml.contains("IntangibleAssets"));
    }

    #[test]
    fn writes_a_small_instance_with_comparatives() {
        let current = lines(&[
            (Item::IntangibleAssets, 1_000.0),
            (Item::TangibleAssets, 2_000.0),
            (Item::Receivables, 3_000.0),
            (Item::Cash, 4_000.0),
            (Item::ShareCapital, 100.0),
            (Item::OtherReserves, 900.0),
            (Item::ResultForTheYear, 5_000.0),
            (Item::LongTermLiabilities, 1_000.0),
            (Item::CurrentLiabilities, 3_000.0),
        ]);
        let prior = lines(&[
            (Item::Cash, 1_000.0),
            (Item::ShareCapital, 100.0),
            (Item::OtherReserves, 900.0),
        ]);
        let mut doc = document(Size::Small, 2026, &current, Some(&prior));
        doc.adopted_on = Some("2027-05-01");
        let xml = instance(&doc);
        assert!(xml.contains("nt21/kvk/20261209/entrypoints/kvk-rpt-jaarverantwoording-2026-nlgaap-klein-publicatiestukken.xsd"));
        assert!(xml.contains("<jenv-bw2-i:PropertyPlantEquipment decimals=\"INF\" contextRef=\"I_CS\" unitRef=\"EUR\">2000</jenv-bw2-i:PropertyPlantEquipment>"));
        assert!(xml.contains("<jenv-bw2-i:ResultForTheYear decimals=\"INF\" contextRef=\"I_CS\" unitRef=\"EUR\">5000</jenv-bw2-i:ResultForTheYear>"));
        assert!(xml.contains("<jenv-bw2-i:EquityAndLiabilities decimals=\"INF\" contextRef=\"I_CS\" unitRef=\"EUR\">10000</jenv-bw2-i:EquityAndLiabilities>"));
        assert!(xml.contains("<jenv-bw2-i:EquityAndLiabilities decimals=\"INF\" contextRef=\"PI_CS\" unitRef=\"EUR\">1000</jenv-bw2-i:EquityAndLiabilities>"));
        assert!(xml.contains("<xbrli:instant>2025-12-31</xbrli:instant>"));
        assert!(xml.contains("<jenv-bw2-i:FinancialReportingPeriodPreviousEndDate contextRef=\"D\">2025-12-31</jenv-bw2-i:FinancialReportingPeriodPreviousEndDate>"));
        assert!(xml.contains("<jenv-bw2-i:DocumentAdoptionDate contextRef=\"D\">2027-05-01</jenv-bw2-i:DocumentAdoptionDate>"));
        assert!(xml.contains("<jenv-bw2-i:AverageNumberEmployees decimals=\"INF\" contextRef=\"D_CS\" unitRef=\"pure\">3</jenv-bw2-i:AverageNumberEmployees>"));
        assert!(xml.contains("<rj-i:FinancialReportingPeriodDifferentThanAnnualStatus contextRef=\"D_CS\">Nee</rj-i:FinancialReportingPeriodDifferentThanAnnualStatus>"));
        assert!(xml.contains("<kvk-i:LegalSizeCriteriaClassificationSmall contextRef=\"D\">Klein</kvk-i:LegalSizeCriteriaClassificationSmall>"));

        // After appropriation the result goes into the other reserves.
        doc.before_appropriation = false;
        let after = instance(&doc);
        assert!(!after.contains("ResultForTheYear"));
        assert!(after.contains("<jenv-bw2-i:ReservesOther decimals=\"INF\" contextRef=\"I_CS\" unitRef=\"EUR\">5900</jenv-bw2-i:ReservesOther>"));
        assert!(after.contains(">Na</jenv-bw2-i:BalanceSheetBeforeAfterAppropriationResults>"));
    }

    /// With `KVK_XBRL_OUT` set, writes a micro and a small instance for each
    /// taxonomy there, to validate them against the NT packages (Arelle with
    /// the KvK formula rules) when the taxonomy or the writer changes.
    #[test]
    fn writes_sample_instances_when_asked() {
        let Ok(dir) = std::env::var("KVK_XBRL_OUT") else {
            return;
        };
        let current = lines(&[
            (Item::IntangibleAssets, 1_000.0),
            (Item::TangibleAssets, 20_000.0),
            (Item::Receivables, 3_000.0),
            (Item::Cash, 14_000.0),
            (Item::ShareCapital, 100.0),
            (Item::OtherReserves, 9_900.0),
            (Item::ResultForTheYear, 5_000.0),
            (Item::Provisions, 2_000.0),
            (Item::LongTermLiabilities, 10_000.0),
            (Item::CurrentLiabilities, 11_000.0),
        ]);
        let prior = lines(&[
            (Item::TangibleAssets, 15_000.0),
            (Item::Cash, 5_000.0),
            (Item::ShareCapital, 100.0),
            (Item::OtherReserves, 9_900.0),
            (Item::CurrentLiabilities, 10_000.0),
        ]);
        for year in [2025, 2026] {
            for size in [Size::Micro, Size::Small] {
                let doc = document(size, year, &current, Some(&prior));
                let name = format!("{dir}/{year}-{}.xbrl", size.entrypoint());
                std::fs::write(&name, instance(&doc)).expect("write");
            }
        }
    }

    #[test]
    fn keeps_text_to_what_the_filing_rules_allow() {
        assert_eq!(
            filing_text("“Bakker’s” – café … €5 ✓"),
            "\"Bakker's\" - café ... €5"
        );
        assert_eq!(escape("A & B <C>"), "A &amp; B &lt;C&gt;");
        assert!(!differs_from_a_year("2025-01-01", "2025-12-31"));
        assert!(!differs_from_a_year("2024-07-01", "2025-06-30"));
        assert!(differs_from_a_year("2025-03-15", "2025-12-31"));
        assert_eq!(taxonomy_for(2024), None);
        assert_eq!(supported_years(), "2025 and 2026");
    }
}
