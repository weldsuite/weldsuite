//! India's GST worksheet (`GET /api/vat-returns/gst-worksheet`;
//! books-api's `accounting-gst-return`, books-domain's
//! `jurisdictions/in/gst-return`): the GSTR-1 tables and the GSTR-3B summary
//! of a period from the tax ledger and the invoices behind it. Nothing is
//! stored or filed.

use std::collections::{HashMap, HashSet};

use axum::response::Response;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::currency::to_base_currency;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::http::{Caller, Refusal, Reply, ok, reply};
use weldsuite_books_domain::js::{self, locale_compare, number_value, round_money as round2};
use weldsuite_books_domain::tax::entity_state_code;

use crate::vat_returns::{entity_row, has_feature};

fn n(value: f64) -> Value {
    number_value(value)
}

/// `Number(value)`, 0 unless finite.
fn num(text: Option<&str>) -> f64 {
    let value = match text {
        Some(text) => weldsuite_kit::validation::js_number(text),
        None => 0.0,
    };
    if value.is_finite() { value } else { 0.0 }
}

// ── the route ───────────────────────────────────────────────────────────────

pub(crate) async fn worksheet(caller: Caller) -> Response {
    let q = caller.query();
    let start = q.get("periodStart").unwrap_or_default().to_owned();
    let end = q.get("periodEnd").unwrap_or_default().to_owned();
    let is_day = |value: &str| {
        let b = value.as_bytes();
        b.len() == 10
            && b.iter().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    *c == b'-'
                } else {
                    c.is_ascii_digit()
                }
            })
            && js::js_date_millis(value).is_some()
    };
    if !is_day(&start) || !is_day(&end) {
        return Refusal::bad_request("periodStart and periodEnd are required as YYYY-MM-DD dates")
            .respond("");
    }
    if start > end {
        return Refusal::bad_request("periodStart must not be after periodEnd").respond("");
    }
    reply(
        load_worksheet(&caller, &start, &end).await,
        "Failed to build the GST worksheet",
    )
}

async fn load_worksheet(caller: &Caller, start: &str, end: &str) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let Some(entity) = entity_row(db, &entity_id, true).await? else {
        return Err(Refusal::not_found("Entity", &entity_id));
    };
    let code = entity.get("jurisdictionCode").and_then(Value::as_str);
    if !has_feature(code, "gstReturn") {
        return Err(Refusal::bad_request(
            "This entity's jurisdiction has no GST return.",
        ));
    }
    // `loadIndiaEntity` reads the entity again and refuses anything but India.
    if code.map(str::to_uppercase).as_deref() != Some("IN") {
        return Err(Refusal::bad_request(
            "This entity's jurisdiction has no GST return.",
        ));
    }
    let input = load_input(db, &entity, &entity_id, start, end).await?;
    Ok(ok(compute(&input)))
}

// ── loading ─────────────────────────────────────────────────────────────────

struct Entry {
    source_type: String,
    source_id: Option<String>,
    direction: &'static str,
    component: Option<String>,
    rate: f64,
    tax_category_code: Option<String>,
    self_assessed: bool,
    taxable: f64,
    tax: f64,
}

struct Document {
    id: String,
    credit_note: bool,
    number: String,
    date: String,
    counterparty_name: String,
    gstin: Option<String>,
    place_of_supply: Option<String>,
    total: f64,
    original_number: Option<String>,
}

struct InvoiceLine {
    document_id: String,
    sign: f64,
    hsn_sac: Option<String>,
    unit: Option<String>,
    quantity: f64,
    taxable_value: f64,
    tax_amount: f64,
    slab_rate: f64,
}

struct Input {
    period_start: String,
    period_end: String,
    entity_state_code: Option<String>,
    entries: Vec<Entry>,
    documents: Vec<Document>,
    lines: Vec<InvoiceLine>,
}

#[allow(clippy::too_many_lines)] // the loader's queries, in the service's order
async fn load_input(
    db: &PgPool,
    entity: &Value,
    entity_id: &str,
    start: &str,
    end: &str,
) -> Result<Input, sqlx::Error> {
    type LedgerRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        String,
        Option<String>,
        bool,
        String,
        String,
    );
    let ledger: Vec<LedgerRow> = sqlx::query_as(
        "select \"source_type\", \"source_id\", \"direction\", \"component\", \"rate\"::text, \
         \"tax_category_code\", \"self_assessed\", \"base_taxable_amount\"::text, \"base_tax_amount\"::text \
         from \"tax_lines\" where (\"tax_lines\".\"entity_id\" = $1 and \"tax_lines\".\"tax_date\" >= $2::date \
         and \"tax_lines\".\"tax_date\" <= $3::date)",
    )
    .bind(entity_id)
    .bind(start)
    .bind(end)
    .fetch_all(db)
    .await?;
    let entries: Vec<Entry> = ledger
        .iter()
        .map(|r| Entry {
            source_type: r.0.clone(),
            source_id: r.1.clone(),
            direction: if r.2 == "purchase" {
                "purchase"
            } else {
                "sales"
            },
            component: r.3.clone(),
            rate: num(Some(&r.4)),
            tax_category_code: r.5.clone(),
            self_assessed: r.6,
            taxable: num(Some(&r.7)),
            tax: num(Some(&r.8)),
        })
        .collect();
    let mut invoice_ids: Vec<String> = Vec::new();
    for r in &ledger {
        if (r.0 == "invoice" || r.0 == "credit_note")
            && let Some(id) = r.1.as_deref().filter(|id| !id.is_empty())
            && !invoice_ids.iter().any(|i| i == id)
        {
            invoice_ids.push(id.to_owned());
        }
    }

    let base_currency = entity
        .get("baseCurrency")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut documents = Vec::new();
    let mut lines = Vec::new();
    if !invoice_ids.is_empty() {
        type InvoiceRow = (
            String,
            Option<String>,
            Option<String>,
            Value,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let invoices: Vec<InvoiceRow> = sqlx::query_as(
            "select \"id\", \"invoice_number\", \"type\", to_jsonb(\"issue_date\"), \"total\"::text, \
             \"currency\", \"exchange_rate\"::text, \"place_of_supply\", \"contact_tax_number\", \
             \"contact_id\", \"contact_name\", \"credit_note_for_invoice_id\" \
             from \"invoices\" where \"invoices\".\"id\" = any($1)",
        )
        .bind(&invoice_ids)
        .fetch_all(db)
        .await?;
        let mut original_ids: Vec<String> = Vec::new();
        for inv in &invoices {
            if let Some(id) = inv.11.as_deref().filter(|id| !id.is_empty())
                && !original_ids.iter().any(|o| o == id)
            {
                original_ids.push(id.to_owned());
            }
        }
        let originals: Vec<(String, Option<String>)> = if original_ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as(
                "select \"id\", \"invoice_number\" from \"invoices\" where \"invoices\".\"id\" = any($1)",
            )
            .bind(&original_ids)
            .fetch_all(db)
            .await?
        };
        let original_number: HashMap<String, Option<String>> = originals.into_iter().collect();

        let mut unnumbered: Vec<String> = Vec::new();
        for inv in &invoices {
            if inv.8.as_deref().is_none_or(str::is_empty)
                && let Some(contact) = inv.9.as_deref().filter(|c| !c.is_empty())
                && !unnumbered.iter().any(|u| u == contact)
            {
                unnumbered.push(contact.to_owned());
            }
        }
        let gstins: HashMap<String, String> = if unnumbered.is_empty() {
            HashMap::new()
        } else {
            let rows: Vec<(String, Option<String>)> = sqlx::query_as(
                "select \"parties\".\"id\", \"companies\".\"vat_number\" from \"parties\" \
                 left join \"companies\" on \"parties\".\"company_id\" = \"companies\".\"id\" \
                 where \"parties\".\"id\" = any($1)",
            )
            .bind(&unnumbered)
            .fetch_all(db)
            .await?;
            rows.into_iter()
                .filter_map(|(id, vat)| {
                    vat.filter(|v| !v.is_empty()).map(|v| {
                        (
                            id,
                            weldsuite_books_domain::jurisdictions::js_trim(&v).to_owned(),
                        )
                    })
                })
                .collect()
        };

        let same_currency = |currency: Option<&str>| {
            currency.is_none_or(str::is_empty) || currency.map(str::to_owned) == base_currency
        };
        for inv in &invoices {
            let total = num(inv.4.as_deref());
            let rate = num(inv.6.as_deref());
            let issue = match &inv.3 {
                Value::String(text) => text.clone(),
                _ => String::new(),
            };
            let gstin = inv
                .8
                .clone()
                .filter(|g| !g.is_empty())
                .or_else(|| inv.9.as_ref().and_then(|c| gstins.get(c).cloned()))
                .filter(|g| !g.is_empty());
            documents.push(Document {
                id: inv.0.clone(),
                credit_note: inv.2.as_deref() == Some("credit_note"),
                number: inv.1.clone().unwrap_or_else(|| inv.0.clone()),
                date: weldsuite_db::js_timestamp(&issue)
                    .unwrap_or(issue)
                    .chars()
                    .take(10)
                    .collect(),
                counterparty_name: inv.10.clone().unwrap_or_default(),
                gstin,
                place_of_supply: inv.7.clone(),
                total: if same_currency(inv.5.as_deref()) {
                    total
                } else {
                    to_base_currency(total, if rate == 0.0 { 1.0 } else { rate })
                },
                original_number: inv
                    .11
                    .as_ref()
                    .filter(|id| !id.is_empty())
                    .and_then(|id| original_number.get(id).cloned().flatten()),
            });
        }

        type ItemRow = (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let items: Vec<ItemRow> = sqlx::query_as(
            "select \"invoice_id\", \"hsn_sac\", \"unit\", \"quantity\"::text, \"line_total\"::text, \
             \"tax_amount\"::text, \"tax_rate\"::text from \"invoice_items\" \
             where (\"invoice_items\".\"invoice_id\" = any($1) and \"invoice_items\".\"deleted_at\" is null)",
        )
        .bind(&invoice_ids)
        .fetch_all(db)
        .await?;
        for item in items {
            let Some(inv) = invoices.iter().find(|i| i.0 == item.0) else {
                continue;
            };
            let exchange = num(inv.6.as_deref());
            let rate = if same_currency(inv.5.as_deref()) {
                1.0
            } else {
                1.0 / if exchange == 0.0 { 1.0 } else { exchange }
            };
            lines.push(InvoiceLine {
                document_id: item.0,
                sign: if inv.2.as_deref() == Some("credit_note") {
                    -1.0
                } else {
                    1.0
                },
                hsn_sac: item.1,
                unit: item.2,
                quantity: num(item.3.as_deref()),
                taxable_value: js::math_round(num(item.4.as_deref()) * rate * 100.0) / 100.0,
                tax_amount: js::math_round(num(item.5.as_deref()) * rate * 100.0) / 100.0,
                slab_rate: num(item.6.as_deref()),
            });
        }
    }

    Ok(Input {
        period_start: start.chars().take(10).collect(),
        period_end: end.chars().take(10).collect(),
        entity_state_code: entity_state_code(
            entity.get("taxIdentifiers"),
            entity.get("jurisdictionSettings"),
        ),
        entries,
        documents,
        lines,
    })
}

// ── the computation ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default)]
struct Heads {
    igst: f64,
    cgst: f64,
    sgst: f64,
    cess: f64,
}

impl Heads {
    fn add(self, other: Self) -> Self {
        Self {
            igst: round2(self.igst + other.igst),
            cgst: round2(self.cgst + other.cgst),
            sgst: round2(self.sgst + other.sgst),
            cess: round2(self.cess + other.cess),
        }
    }

    fn get_mut(&mut self, head: Head) -> &mut f64 {
        match head {
            Head::Igst => &mut self.igst,
            Head::Cgst => &mut self.cgst,
            Head::Sgst => &mut self.sgst,
        }
    }

    fn json(self) -> Value {
        json!({ "igst": n(self.igst), "cgst": n(self.cgst), "sgst": n(self.sgst), "cess": n(self.cess) })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Head {
    Igst,
    Cgst,
    Sgst,
}

fn head_of(component: Option<&str>) -> Option<Head> {
    match component {
        Some("igst") => Some(Head::Igst),
        Some("cgst") => Some(Head::Cgst),
        Some("sgst" | "utgst") => Some(Head::Sgst),
        _ => None,
    }
}

fn counts_taxable(component: Option<&str>) -> bool {
    !matches!(component, Some("sgst" | "utgst"))
}

fn slab_rate_of(e: &Entry) -> f64 {
    if matches!(e.component.as_deref(), Some("cgst" | "sgst" | "utgst")) {
        round2(e.rate * 2.0)
    } else {
        e.rate
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Taxable,
    Export,
    Exempt,
    Nil,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Taxable => "taxable",
            Self::Export => "export",
            Self::Exempt => "exempt",
            Self::Nil => "nil",
        }
    }
}

fn classify(e: &Entry) -> Kind {
    let category = e.tax_category_code.as_deref();
    if e.component.as_deref() == Some("export") || category == Some("export_goods") {
        return Kind::Export;
    }
    if category == Some("exempt") {
        return Kind::Exempt;
    }
    if category == Some("zero")
        || (e.rate == 0.0 && e.component.is_none() && category != Some("reverse_charge"))
    {
        return Kind::Nil;
    }
    Kind::Taxable
}

const B2C_LARGE_THRESHOLD: f64 = 250_000.0;

#[derive(Debug, Clone, Copy, Default)]
struct Outward {
    taxable_value: f64,
    heads: Heads,
}

impl Outward {
    fn add(&mut self, taxable: f64, heads: Heads) {
        self.taxable_value = round2(self.taxable_value + taxable);
        self.heads.igst = round2(self.heads.igst + heads.igst);
        self.heads.cgst = round2(self.heads.cgst + heads.cgst);
        self.heads.sgst = round2(self.heads.sgst + heads.sgst);
        self.heads.cess = round2(self.heads.cess + heads.cess);
    }

    fn json(self) -> Value {
        json!({
            "taxableValue": n(self.taxable_value),
            "igst": n(self.heads.igst), "cgst": n(self.heads.cgst),
            "sgst": n(self.heads.sgst), "cess": n(self.heads.cess),
        })
    }
}

struct DocAgg<'a> {
    doc: Option<&'a Document>,
    kind: Kind,
    slab_rate: f64,
    taxable: f64,
    heads: Heads,
}

/// `utiliseItc(liability, credit)`: (cash, carry forward, credit used).
fn utilise_itc(liability_in: Heads, credit_in: Heads) -> (Heads, Heads, Heads) {
    let mut liability = [
        liability_in.igst.max(0.0),
        liability_in.cgst.max(0.0),
        liability_in.sgst.max(0.0),
    ];
    let mut credit = [
        credit_in.igst.max(0.0),
        credit_in.cgst.max(0.0),
        credit_in.sgst.max(0.0),
    ];
    let mut used = [0.0; 3];
    let mut pay = |from: usize, to: usize| {
        let amount = credit[from].min(liability[to]);
        credit[from] = round2(credit[from] - amount);
        liability[to] = round2(liability[to] - amount);
        used[from] = round2(used[from] + amount);
    };
    pay(0, 0);
    pay(0, 1);
    pay(0, 2);
    pay(1, 1);
    pay(1, 0);
    pay(2, 2);
    pay(2, 0);
    let heads = |v: [f64; 3]| Heads {
        igst: v[0],
        cgst: v[1],
        sgst: v[2],
        cess: 0.0,
    };
    (heads(liability), heads(credit), heads(used))
}

fn rate_line(agg: &DocAgg<'_>) -> Map<String, Value> {
    let doc = agg.doc.expect("a document");
    let mut out = Map::new();
    out.insert("documentId".into(), json!(doc.id));
    out.insert("number".into(), json!(doc.number));
    out.insert("date".into(), json!(doc.date));
    out.insert("value".into(), n(doc.total));
    out.insert("placeOfSupply".into(), json!(doc.place_of_supply));
    out.insert("slabRate".into(), n(agg.slab_rate));
    out.insert("taxable".into(), n(agg.taxable));
    out.insert("igst".into(), n(agg.heads.igst));
    out.insert("cgst".into(), n(agg.heads.cgst));
    out.insert("sgst".into(), n(agg.heads.sgst));
    out
}

struct Party {
    gstin: String,
    name: String,
    lines: Vec<Map<String, Value>>,
    taxable: f64,
    igst: f64,
    cgst: f64,
    sgst: f64,
}

struct Small {
    key: String,
    place_of_supply: Option<String>,
    slab_rate: f64,
    taxable: f64,
    igst: f64,
    cgst: f64,
    sgst: f64,
}

struct ExportRow {
    document_id: String,
    number: String,
    date: String,
    value: f64,
    taxable: f64,
    igst: f64,
}

#[derive(Default)]
struct NilRow {
    intra_registered: f64,
    intra_unregistered: f64,
    inter_registered: f64,
    inter_unregistered: f64,
}

struct HsnRow {
    key: String,
    hsn_sac: Option<String>,
    unit: Option<String>,
    slab_rate: f64,
    quantity: f64,
    taxable: f64,
    igst: f64,
    cgst: f64,
    sgst: f64,
}

fn str_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// `computeGstWorksheet(input)`.
#[allow(clippy::too_many_lines)] // the worksheet in one pass, as in TypeScript
fn compute(input: &Input) -> Value {
    let state = input.entity_state_code.as_deref();
    let docs: HashMap<&str, &Document> =
        input.documents.iter().map(|d| (d.id.as_str(), d)).collect();
    let is_inter = |pos: Option<&str>| {
        pos.is_some_and(|p| !p.is_empty()) && state.is_some_and(|s| !s.is_empty()) && pos != state
    };

    // The pass over the ledger.
    let mut unsplit = 0.0;
    let mut sales: Vec<(String, DocAgg<'_>)> = Vec::new();
    let mut outward = Outward::default();
    let mut zero_rated = Outward::default();
    let mut nil_exempt_total = 0.0;
    let mut other_tax = 0.0;
    let mut other_rows = 0_i64;
    let mut itc_other = Heads::default();
    let mut itc_reverse = Heads::default();
    let mut reverse = Outward::default();
    for e in &input.entries {
        let component = e.component.as_deref();
        let head = head_of(component);
        if e.direction == "purchase" {
            if e.self_assessed {
                if counts_taxable(component) {
                    reverse.taxable_value = round2(reverse.taxable_value + e.taxable);
                }
                if let Some(head) = head {
                    let r = reverse.heads.get_mut(head);
                    *r = round2(*r + e.tax);
                    let i = itc_reverse.get_mut(head);
                    *i = round2(*i + e.tax);
                } else if e.tax != 0.0 {
                    unsplit = round2(unsplit + e.tax);
                }
            } else if let Some(head) = head {
                let i = itc_other.get_mut(head);
                *i = round2(*i + e.tax);
            } else if e.tax != 0.0 && component != Some("export") {
                unsplit = round2(unsplit + e.tax);
            }
            continue;
        }
        let kind = classify(e);
        let mut heads = Heads::default();
        if let Some(head) = head {
            *heads.get_mut(head) = e.tax;
        } else if kind == Kind::Taxable && e.tax != 0.0 {
            unsplit = round2(unsplit + e.tax);
        }
        let taxable = if counts_taxable(component) {
            e.taxable
        } else {
            0.0
        };
        match kind {
            Kind::Taxable => outward.add(taxable, heads),
            Kind::Export => zero_rated.add(taxable, heads),
            _ => nil_exempt_total = round2(nil_exempt_total + taxable),
        }
        let source = e.source_id.as_deref().filter(|s| !s.is_empty());
        let is_document = e.source_type == "invoice" || e.source_type == "credit_note";
        let (true, Some(source)) = (is_document, source) else {
            other_rows += 1;
            other_tax = round2(other_tax + e.tax);
            continue;
        };
        let slab = if kind == Kind::Taxable {
            slab_rate_of(e)
        } else {
            0.0
        };
        let key = format!("{source}|{}|{}", kind.as_str(), js::number_text(slab));
        let at = sales
            .iter()
            .position(|(k, _)| *k == key)
            .unwrap_or_else(|| {
                sales.push((
                    key,
                    DocAgg {
                        doc: docs.get(source).copied(),
                        kind,
                        slab_rate: slab,
                        taxable: 0.0,
                        heads: Heads::default(),
                    },
                ));
                sales.len() - 1
            });
        let agg = &mut sales[at].1;
        agg.taxable = round2(agg.taxable + taxable);
        agg.heads = agg.heads.add(heads);
    }

    // GSTR-1 tables.
    let mut b2b: Vec<Party> = Vec::new();
    let mut b2c_large: Vec<Map<String, Value>> = Vec::new();
    let mut b2c_small: Vec<Small> = Vec::new();
    let mut exports: Vec<ExportRow> = Vec::new();
    let mut nil_exempt: Vec<(&'static str, NilRow)> = Vec::new();
    let mut credit_notes: Vec<Map<String, Value>> = Vec::new();
    let mut missing_pos = 0_i64;
    let mut flagged: HashSet<&str> = HashSet::new();
    let mut add_nil = |category: &'static str, registered: bool, inter: bool, taxable: f64| {
        let at = nil_exempt
            .iter()
            .position(|(c, _)| *c == category)
            .unwrap_or_else(|| {
                nil_exempt.push((category, NilRow::default()));
                nil_exempt.len() - 1
            });
        let row = &mut nil_exempt[at].1;
        let field = match (inter, registered) {
            (false, true) => &mut row.intra_registered,
            (false, false) => &mut row.intra_unregistered,
            (true, true) => &mut row.inter_registered,
            (true, false) => &mut row.inter_unregistered,
        };
        *field = round2(*field + taxable);
    };
    let mut add_export = |doc: &Document, value: f64, agg: &DocAgg<'_>| {
        let at = exports
            .iter()
            .position(|r| r.document_id == doc.id)
            .unwrap_or_else(|| {
                exports.push(ExportRow {
                    document_id: doc.id.clone(),
                    number: doc.number.clone(),
                    date: doc.date.clone(),
                    value,
                    taxable: 0.0,
                    igst: 0.0,
                });
                exports.len() - 1
            });
        let row = &mut exports[at];
        row.taxable = round2(row.taxable + agg.taxable);
        row.igst = round2(row.igst + agg.heads.igst);
    };
    for (_, agg) in &sales {
        let Some(doc) = agg.doc else { continue };
        let registered = doc.gstin.as_deref().is_some_and(|g| !g.is_empty());
        let inter = is_inter(doc.place_of_supply.as_deref());
        if agg.kind == Kind::Taxable
            && doc.place_of_supply.as_deref().is_none_or(str::is_empty)
            && flagged.insert(doc.id.as_str())
        {
            missing_pos += 1;
        }
        let nil_category = if agg.kind == Kind::Exempt {
            "exempt"
        } else {
            "nil_rated"
        };
        if doc.credit_note {
            match agg.kind {
                Kind::Taxable => {
                    let mut line = rate_line(agg);
                    line.insert("gstin".into(), json!(doc.gstin));
                    line.insert("originalNumber".into(), json!(doc.original_number));
                    credit_notes.push(line);
                }
                Kind::Export => add_export(doc, -doc.total, agg),
                _ => add_nil(nil_category, registered, inter, agg.taxable),
            }
            continue;
        }
        match agg.kind {
            Kind::Taxable => {
                if registered {
                    let gstin = doc.gstin.clone().unwrap_or_default();
                    let at = b2b
                        .iter()
                        .position(|p| p.gstin == gstin)
                        .unwrap_or_else(|| {
                            b2b.push(Party {
                                gstin: gstin.clone(),
                                name: doc.counterparty_name.clone(),
                                lines: Vec::new(),
                                taxable: 0.0,
                                igst: 0.0,
                                cgst: 0.0,
                                sgst: 0.0,
                            });
                            b2b.len() - 1
                        });
                    let party = &mut b2b[at];
                    let line = rate_line(agg);
                    party.taxable = round2(party.taxable + agg.taxable);
                    party.igst = round2(party.igst + agg.heads.igst);
                    party.cgst = round2(party.cgst + agg.heads.cgst);
                    party.sgst = round2(party.sgst + agg.heads.sgst);
                    party.lines.push(line);
                } else if inter && doc.total > B2C_LARGE_THRESHOLD {
                    b2c_large.push(rate_line(agg));
                } else {
                    let key = format!(
                        "{}|{}",
                        doc.place_of_supply.as_deref().unwrap_or_default(),
                        js::number_text(agg.slab_rate)
                    );
                    let at = b2c_small
                        .iter()
                        .position(|s| s.key == key)
                        .unwrap_or_else(|| {
                            b2c_small.push(Small {
                                key,
                                place_of_supply: doc.place_of_supply.clone(),
                                slab_rate: agg.slab_rate,
                                taxable: 0.0,
                                igst: 0.0,
                                cgst: 0.0,
                                sgst: 0.0,
                            });
                            b2c_small.len() - 1
                        });
                    let small = &mut b2c_small[at];
                    small.taxable = round2(small.taxable + agg.taxable);
                    small.igst = round2(small.igst + agg.heads.igst);
                    small.cgst = round2(small.cgst + agg.heads.cgst);
                    small.sgst = round2(small.sgst + agg.heads.sgst);
                }
            }
            Kind::Export => add_export(doc, doc.total, agg),
            _ => add_nil(nil_category, registered, inter, agg.taxable),
        }
    }

    // GSTR-3B 3.2.
    let mut inter_unregistered: Vec<(String, Option<String>, f64, f64)> = Vec::new();
    for (_, agg) in &sales {
        let Some(doc) = agg.doc else { continue };
        if agg.kind != Kind::Taxable
            || doc.gstin.as_deref().is_some_and(|g| !g.is_empty())
            || !is_inter(doc.place_of_supply.as_deref())
        {
            continue;
        }
        let key = doc.place_of_supply.clone().unwrap_or_default();
        let at = inter_unregistered
            .iter()
            .position(|r| r.0 == key)
            .unwrap_or_else(|| {
                inter_unregistered.push((key, doc.place_of_supply.clone(), 0.0, 0.0));
                inter_unregistered.len() - 1
            });
        let row = &mut inter_unregistered[at];
        row.2 = round2(row.2 + agg.taxable);
        row.3 = round2(row.3 + agg.heads.igst);
    }

    // HSN summary.
    let mut supply_of: HashMap<&str, &'static str> = HashMap::new();
    for e in &input.entries {
        let Some(source) = e.source_id.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        if e.direction != "sales" {
            continue;
        }
        match e.component.as_deref() {
            Some("igst") => {
                supply_of.insert(source, "inter");
            }
            Some("cgst") => {
                supply_of.entry(source).or_insert("intra");
            }
            _ => {}
        }
    }
    let mut hsn: Vec<HsnRow> = Vec::new();
    let mut missing_hsn = 0_i64;
    for line in &input.lines {
        let key = format!(
            "{}|{}|{}",
            line.hsn_sac.as_deref().unwrap_or_default(),
            line.unit.as_deref().unwrap_or_default(),
            js::number_text(line.slab_rate)
        );
        let at = hsn.iter().position(|r| r.key == key).unwrap_or_else(|| {
            hsn.push(HsnRow {
                key,
                hsn_sac: line.hsn_sac.clone(),
                unit: line.unit.clone(),
                slab_rate: line.slab_rate,
                quantity: 0.0,
                taxable: 0.0,
                igst: 0.0,
                cgst: 0.0,
                sgst: 0.0,
            });
            hsn.len() - 1
        });
        let row = &mut hsn[at];
        let taxable = round2(line.taxable_value * line.sign);
        let tax = round2(line.tax_amount * line.sign);
        row.quantity = round2(row.quantity + line.quantity * line.sign);
        row.taxable = round2(row.taxable + taxable);
        match supply_of.get(line.document_id.as_str()) {
            Some(&"inter") => row.igst = round2(row.igst + tax),
            Some(&"intra") => {
                let cgst = round2((taxable * (line.slab_rate / 2.0)) / 100.0);
                row.cgst = round2(row.cgst + cgst);
                row.sgst = round2(row.sgst + (tax - cgst));
            }
            _ => {}
        }
        if line.hsn_sac.as_deref().is_none_or(str::is_empty) {
            missing_hsn += 1;
        }
    }

    // Payment.
    let mut totals = Outward::default();
    totals.add(outward.taxable_value, outward.heads);
    totals.add(zero_rated.taxable_value, zero_rated.heads);
    totals.add(nil_exempt_total, Heads::default());
    let itc_total = itc_other.add(itc_reverse);
    let liability = outward.heads.add(zero_rated.heads);
    let reverse_liability = reverse.heads;
    let (cash, carry, used) = utilise_itc(liability, itc_total);
    let net = cash.add(reverse_liability);

    let mut warnings = Vec::new();
    if unsplit != 0.0 {
        warnings.push(json!({ "code": "unsplit_tax", "count": 1, "amount": n(unsplit) }));
    }
    if missing_hsn > 0 {
        warnings.push(json!({ "code": "missing_hsn", "count": missing_hsn }));
    }
    if missing_pos > 0 {
        warnings.push(json!({ "code": "missing_place_of_supply", "count": missing_pos }));
    }
    if other_rows > 0 {
        warnings.push(json!({ "code": "tax_on_other_documents", "count": other_rows, "amount": n(other_tax) }));
    }

    // Sorting, as the worksheet lists them.
    let by_date = |a: &Value, b: &Value| locale_compare(&str_of(a, "date"), &str_of(b, "date"));
    b2b.sort_by(|a, b| locale_compare(&a.gstin, &b.gstin));
    let b2b: Vec<Value> = b2b
        .into_iter()
        .map(|mut party| {
            let mut lines: Vec<Value> = party.lines.drain(..).map(Value::Object).collect();
            lines.sort_by(|a, b| {
                by_date(a, b).then_with(|| locale_compare(&str_of(a, "number"), &str_of(b, "number")))
            });
            json!({
                "gstin": party.gstin, "name": party.name, "lines": lines,
                "taxable": n(party.taxable), "igst": n(party.igst), "cgst": n(party.cgst), "sgst": n(party.sgst),
            })
        })
        .collect();
    let mut b2c_large: Vec<Value> = b2c_large.into_iter().map(Value::Object).collect();
    b2c_large.sort_by(by_date);
    let pos_order = |a: Option<&str>, b: Option<&str>| {
        locale_compare(a.unwrap_or_default(), b.unwrap_or_default())
    };
    b2c_small.sort_by(|a, b| {
        pos_order(a.place_of_supply.as_deref(), b.place_of_supply.as_deref()).then_with(|| {
            a.slab_rate
                .partial_cmp(&b.slab_rate)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let b2c_small: Vec<Value> = b2c_small
        .into_iter()
        .map(|s| {
            json!({
                "placeOfSupply": s.place_of_supply, "slabRate": n(s.slab_rate), "taxable": n(s.taxable),
                "igst": n(s.igst), "cgst": n(s.cgst), "sgst": n(s.sgst),
            })
        })
        .collect();
    let mut exports: Vec<Value> = exports
        .into_iter()
        .map(|r| {
            json!({
                "documentId": r.document_id, "number": r.number, "date": r.date,
                "value": n(r.value), "taxable": n(r.taxable), "igst": n(r.igst),
            })
        })
        .collect();
    exports.sort_by(by_date);
    let nil_exempt: Vec<Value> = nil_exempt
        .into_iter()
        .map(|(category, row)| {
            json!({
                "category": category,
                "intraRegistered": n(row.intra_registered), "intraUnregistered": n(row.intra_unregistered),
                "interRegistered": n(row.inter_registered), "interUnregistered": n(row.inter_unregistered),
            })
        })
        .collect();
    let mut credit_notes: Vec<Value> = credit_notes.into_iter().map(Value::Object).collect();
    credit_notes.sort_by(by_date);
    hsn.sort_by(|a, b| {
        pos_order(a.hsn_sac.as_deref(), b.hsn_sac.as_deref()).then_with(|| {
            a.slab_rate
                .partial_cmp(&b.slab_rate)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let hsn: Vec<Value> = hsn
        .into_iter()
        .map(|r| {
            json!({
                "hsnSac": r.hsn_sac, "unit": r.unit, "slabRate": n(r.slab_rate), "quantity": n(r.quantity),
                "taxable": n(r.taxable), "igst": n(r.igst), "cgst": n(r.cgst), "sgst": n(r.sgst),
            })
        })
        .collect();
    inter_unregistered.sort_by(|a, b| pos_order(a.1.as_deref(), b.1.as_deref()));
    let inter_unregistered: Vec<Value> = inter_unregistered
        .into_iter()
        .map(|(_, pos, taxable, igst)| json!({ "placeOfSupply": pos, "taxable": n(taxable), "igst": n(igst) }))
        .collect();

    json!({
        "periodStart": input.period_start,
        "periodEnd": input.period_end,
        "entityStateCode": input.entity_state_code,
        "gstr1": {
            "b2b": b2b,
            "b2cLarge": b2c_large,
            "b2cSmall": b2c_small,
            "exports": exports,
            "nilExempt": nil_exempt,
            "creditNotes": credit_notes,
            "hsn": hsn,
            "totals": totals.json(),
        },
        "gstr3b": {
            "outwardTaxable": outward.json(),
            "zeroRated": zero_rated.json(),
            "nilExempt": { "taxableValue": n(nil_exempt_total) },
            "reverseCharge": reverse.json(),
            "interStateUnregistered": inter_unregistered,
            "itc": { "other": itc_other.json(), "reverseCharge": itc_reverse.json(), "total": itc_total.json() },
            "payment": {
                "liability": liability.json(),
                "reverseChargeLiability": reverse_liability.json(),
                "itcUtilisation": { "cash": cash.json(), "carryForward": carry.json(), "creditUsed": used.json() },
                "netPayable": net.json(),
                "totalNetPayable": n(round2(net.igst + net.cgst + net.sgst + net.cess)),
            },
        },
        "unsplitTax": n(unsplit),
        "warnings": warnings,
    })
}
