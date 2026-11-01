//! `/api/sales-tax/reports` (`routes/sales-tax/reports.ts`,
//! `services/sales-tax-reports.ts`): liability by agency and jurisdiction
//! tied to the ledger, taxable and exempt sales, exceptions, expiring and
//! missing exemption certificates, and the provider reconciliation.
//!
//! Every figure reads the tax ledger (`tax_lines`); a document line's gross
//! is counted once, from its highest-level row.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::response::Response;
use axum::routing::get;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::http::{BooksState, Caller, Query, ok, reply};
use weldsuite_books_domain::js::{locale_compare, math_round, parse_int, to_fixed};
use weldsuite_books_domain::sales_tax::exemptions::{
    certificate_expiry, missing_certificate_cure_deadline,
};
use weldsuite_books_domain::sales_tax::load::to_certificate_ref;
use weldsuite_books_domain::tables::{EXEMPTION_CERTIFICATES, INVOICES, TAX_LINES};
use weldsuite_db::PgPool;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::{is_iso_date_text, text, today_in};
use crate::returns::checks::{agency_liability, status_as_of};
use crate::returns::common::{
    add_days, add_months, bad, load_agencies, load_agency_returns, n, next_day, num, num_at,
    registered_on, round2, s, start_of_day, state_of_address, sum_money, us_entity_of,
};
use crate::returns::documents::{anchor_rows, describe_documents, document_key};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = || gate.require(["taxes:read".to_owned()]);
    Router::new()
        .route("/reports/liability", get(liability).route_layer(need()))
        .route(
            "/reports/sales-summary",
            get(sales_summary).route_layer(need()),
        )
        .route("/reports/exceptions", get(exceptions).route_layer(need()))
        .route(
            "/reports/certificates/expiring",
            get(expiring).route_layer(need()),
        )
        .route(
            "/reports/certificates/missing",
            get(missing).route_layer(need()),
        )
        .route(
            "/reports/provider-reconciliation",
            get(provider_reconciliation).route_layer(need()),
        )
        .with_state(state)
}

/// `range(c, timeZone)`: `from` and `to` given, or the year to date.
fn range(
    q: &Query,
    today: &str,
) -> Result<(String, String), weldsuite_books_domain::http::Refusal> {
    let from = q.get("from").map_or_else(
        || format!("{}-01-01", today.get(..4).unwrap_or("")),
        str::to_owned,
    );
    let to = q.get("to").map_or_else(|| today.to_owned(), str::to_owned);
    if !is_iso_date_text(&from) || !is_iso_date_text(&to) {
        return Err(bad("from and to must be YYYY-MM-DD dates"));
    }
    if to < from {
        return Err(bad("to must not be before from"));
    }
    Ok((from, to))
}

fn today_of(caller: &Caller, state: &BooksState, entity: &Value) -> String {
    today_in(caller, state, text(entity, "timezone"))
}

// ── Liability ───────────────────────────────────────────────────────────────

async fn liability(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let entity = us_entity_of(&caller).await?;
            let as_of = q
                .get("asOf")
                .map_or_else(|| today_of(&caller, &state, &entity), str::to_owned);
            if !is_iso_date_text(&as_of) {
                return Err(bad("asOf must be a YYYY-MM-DD date"));
            }
            Ok(ok(liability_report(&caller.db, &entity, &as_of).await?))
        }
        .await,
        "Failed to fetch the sales tax liability",
    )
}

/// A jurisdiction group of the tax ledger: code, name, level, the return that stamped it, its tax.
type JurisdictionGroup = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// A month of the provider reconciliation: period, documents, committed,
/// uncommitted, provider tax, ledger tax, difference, problems.
type ReconciliationPeriod = (String, i64, i64, i64, f64, f64, f64, i64);

/// `liabilityReport(db, entity, asOf)`.
async fn liability_report(db: &PgPool, entity: &Value, as_of: &str) -> Result<Value, sqlx::Error> {
    let entity_id = s(entity, "id");
    let agencies = load_agencies(db, entity_id).await?;
    let mut rows: Vec<Value> = Vec::new();
    for agency in &agencies {
        let returns = load_agency_returns(db, entity_id, s(agency, "id")).await?;
        let liability = agency_liability(db, entity_id, agency, as_of, false, &returns).await?;
        let grouped: Vec<JurisdictionGroup> = sqlx::query_as(
            "select jurisdiction_code, jurisdiction_name, jurisdiction_level, tax_return_id, \
                 sum(tax_amount)::text from tax_lines where entity_id = $1 and agency_id = $2 \
                 and direction in ('sales', 'use') and tax_date < $3::date \
                 group by jurisdiction_code, jurisdiction_name, jurisdiction_level, tax_return_id",
        )
        .bind(entity_id)
        .bind(s(agency, "id"))
        .bind(next_day(as_of))
        .fetch_all(db)
        .await?;
        // (code, name, level, collected, filed, paid, outstanding)
        let mut jurisdictions: Vec<(String, String, String, f64, f64, f64, f64)> = Vec::new();
        for (code, name, level, return_id, tax) in grouped {
            let key = code.unwrap_or_default();
            let tax = num(&tax.map_or(Value::Null, Value::String));
            let stamped = return_id
                .as_deref()
                .filter(|r| !r.is_empty())
                .and_then(|id| returns.iter().find(|r| s(r, "id") == id));
            let status = stamped.map_or("unfiled", |r| status_as_of(r, as_of));
            let index = if let Some(i) = jurisdictions.iter().position(|j| j.0 == key) {
                i
            } else {
                jurisdictions.push((
                    key.clone(),
                    name.unwrap_or_else(|| key.clone()),
                    level.unwrap_or_default(),
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                ));
                jurisdictions.len() - 1
            };
            let entry = &mut jurisdictions[index];
            entry.3 = round2(entry.3 + tax);
            if status == "filed" || status == "paid" {
                entry.4 = round2(entry.4 + tax);
            }
            if status == "paid" {
                entry.5 = round2(entry.5 + tax);
            }
            entry.6 = round2(entry.3 - entry.5);
        }
        jurisdictions
            .sort_by(|a, b| locale_compare(&a.2, &b.2).then_with(|| locale_compare(&a.1, &b.1)));
        rows.push(json!({
            "agencyId": agency["id"],
            "agencyName": agency["name"],
            "stateCode": agency["stateCode"],
            "status": agency["status"],
            "collected": n(liability.collected_tax),
            "filed": n(round2(liability.paid_tax + liability.filed_unpaid_tax)),
            "paid": n(liability.paid_tax),
            "outstanding": n(liability.expected_balance),
            "unfiled": n(liability.unfiled_tax),
            "filedUnpaid": n(liability.filed_unpaid_tax),
            "glBalance": n(liability.gl_balance),
            "difference": n(liability.difference),
            "jurisdictions": jurisdictions.iter().map(|j| json!({
                "jurisdictionCode": j.0,
                "jurisdictionName": j.1,
                "level": j.2,
                "collected": n(j.3),
                "filed": n(j.4),
                "paid": n(j.5),
                "outstanding": n(j.6),
            })).collect::<Vec<_>>(),
            "warnings": liability.warnings,
        }));
    }
    let total = |key: &str| n(sum_money(rows.iter().map(|r| num_at(r, key))));
    Ok(json!({
        "asOf": as_of,
        "totals": {
            "collected": total("collected"),
            "filed": total("filed"),
            "paid": total("paid"),
            "outstanding": total("outstanding"),
            "glBalance": total("glBalance"),
            "difference": total("difference"),
        },
        "agencies": rows,
    }))
}

// ── Sales summary ───────────────────────────────────────────────────────────

/// `cents(v)`: `Math.round(v * 100)`.
#[allow(clippy::cast_possible_truncation)]
fn cents(value: f64) -> i64 {
    math_round(value * 100.0) as i64
}

#[derive(Default)]
struct Acc {
    key: String,
    label: String,
    level: Option<String>,
    gross: i64,
    taxable: i64,
    exempt: i64,
    exempt_by_reason: Vec<(String, i64)>,
    non_taxable: i64,
    marketplace: i64,
    tax: i64,
    documents: Vec<String>,
}

impl Acc {
    fn new(key: String, label: String, level: Option<String>) -> Self {
        Self {
            key,
            label,
            level,
            ..Self::default()
        }
    }

    fn add(&mut self, r: &Value, gross: bool, tax: bool) {
        if gross {
            self.gross += cents(num_at(r, "grossAmount"));
            self.taxable += cents(num_at(r, "taxableAmount"));
            let exempt = cents(num_at(r, "exemptAmount"));
            self.exempt += exempt;
            if exempt != 0 {
                let reason = text(r, "exemptReason").unwrap_or("other").to_owned();
                match self.exempt_by_reason.iter_mut().find(|(k, _)| *k == reason) {
                    Some(entry) => entry.1 += exempt,
                    None => self.exempt_by_reason.push((reason, exempt)),
                }
            }
            self.non_taxable += cents(num_at(r, "nonTaxableAmount"));
            if r["marketplaceFacilitated"].as_bool() == Some(true) {
                self.marketplace += cents(num_at(r, "grossAmount"));
            }
        }
        if tax {
            self.tax += cents(num_at(r, "taxAmount"));
        }
        let key = document_key(r);
        if !self.documents.contains(&key) {
            self.documents.push(key);
        }
    }

    #[allow(clippy::cast_precision_loss)]
    fn figures(&self) -> Map<String, Value> {
        let d = |c: i64| n(c as f64 / 100.0);
        let mut out = Map::new();
        out.insert("grossSales".into(), d(self.gross));
        out.insert("taxableSales".into(), d(self.taxable));
        out.insert("exemptSales".into(), d(self.exempt));
        out.insert(
            "exemptByReason".into(),
            Value::Object(
                self.exempt_by_reason
                    .iter()
                    .map(|(k, v)| (k.clone(), d(*v)))
                    .collect(),
            ),
        );
        out.insert("nonTaxableSales".into(), d(self.non_taxable));
        out.insert("marketplaceSales".into(), d(self.marketplace));
        out.insert("tax".into(), d(self.tax));
        out.insert("documents".into(), json!(self.documents.len()));
        out
    }

    fn finish(&self) -> Value {
        let mut out = Map::new();
        out.insert("key".into(), json!(self.key));
        out.insert("label".into(), json!(self.label));
        if let Some(level) = &self.level {
            out.insert("level".into(), json!(level));
        }
        out.extend(self.figures());
        Value::Object(out)
    }
}

/// `salesRows(db, entityId, from, to)`.
async fn sales_rows(
    db: &PgPool,
    entity_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_lines),
        " from tax_lines t where t.entity_id = $1 and t.direction = 'sales' \
         and t.tax_date >= $2::date and t.tax_date <= $3::date"
    ))
    .bind(entity_id)
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;
    Ok(TAX_LINES.js_rows(rows))
}

/// `customerNames(db, ids)`.
async fn customer_names(
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, String>, sqlx::Error> {
    let mut out = HashMap::new();
    for part in ids.chunks(1000) {
        let rows: Vec<(String, Option<String>)> =
            sqlx::query_as("select id, display_name from parties where id = any($1)")
                .bind(part)
                .fetch_all(db)
                .await?;
        for (id, name) in rows {
            if let Some(name) = name.filter(|n| !n.is_empty()) {
                out.insert(id, name);
            }
        }
    }
    Ok(out)
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in values {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

async fn sales_summary(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let entity = us_entity_of(&caller).await?;
            let group_by = q.get("groupBy").unwrap_or("state").to_owned();
            if !["customer", "state", "jurisdiction"].contains(&group_by.as_str()) {
                return Err(bad("groupBy must be customer, state or jurisdiction"));
            }
            let (from, to) = range(&q, &today_of(&caller, &state, &entity))?;
            Ok(ok(summary(
                &caller.db,
                s(&entity, "id"),
                &from,
                &to,
                &group_by,
            )
            .await?))
        }
        .await,
        "Failed to fetch the sales summary",
    )
}

/// `salesSummary(db, entityId, { from, to, groupBy })`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors sales-tax-reports.ts's salesSummary()"
)]
async fn summary(
    db: &PgPool,
    entity_id: &str,
    from: &str,
    to: &str,
    group_by: &str,
) -> Result<Value, sqlx::Error> {
    let rows = sales_rows(db, entity_id, from, to).await?;
    let refs: Vec<&Value> = rows.iter().collect();
    let docs = describe_documents(db, entity_id, &refs).await?;
    let names = customer_names(
        db,
        &unique(rows.iter().filter_map(|r| {
            text(r, "contactId")
                .filter(|i| !i.is_empty())
                .map(str::to_owned)
        })),
    )
    .await?;
    let mut groups: Vec<Acc> = Vec::new();
    let mut total = Acc::new("total".into(), "Total".into(), None);

    let key_of = |r: &Value| -> (String, String, Option<String>) {
        match group_by {
            "jurisdiction" => {
                let code = text(r, "jurisdictionCode");
                (
                    code.unwrap_or("").to_owned(),
                    text(r, "jurisdictionName")
                        .or(code)
                        .unwrap_or("Unknown")
                        .to_owned(),
                    Some(text(r, "jurisdictionLevel").unwrap_or("").to_owned()),
                )
            }
            "state" => {
                let state = text(r, "shipToState")
                    .filter(|v| !v.is_empty())
                    .or_else(|| text(r, "stateCode").filter(|v| !v.is_empty()))
                    .unwrap_or("")
                    .to_uppercase();
                let label = if state.is_empty() {
                    "No ship-to state".to_owned()
                } else {
                    state.clone()
                };
                (state, label, None)
            }
            _ => {
                let info = docs.get(&document_key(r));
                let id = text(r, "contactId")
                    .map(str::to_owned)
                    .or_else(|| info.and_then(|i| text(i, "contactId")).map(str::to_owned))
                    .unwrap_or_default();
                let label = (!id.is_empty())
                    .then(|| names.get(&id).cloned())
                    .flatten()
                    .or_else(|| {
                        info.and_then(|i| text(i, "contactName"))
                            .filter(|n| !n.is_empty())
                            .map(str::to_owned)
                    })
                    .or_else(|| (!id.is_empty()).then(|| id.clone()))
                    .unwrap_or_else(|| "Unknown customer".to_owned());
                (id, label, None)
            }
        }
    };
    let group = |groups: &mut Vec<Acc>, r: &Value| -> usize {
        let (key, label, level) = key_of(r);
        if let Some(i) = groups.iter().position(|g| g.key == key) {
            return i;
        }
        groups.push(Acc::new(key, label, level));
        groups.len() - 1
    };

    if group_by == "jurisdiction" {
        for r in &rows {
            let i = group(&mut groups, r);
            groups[i].add(r, true, true);
            total.add(r, false, true);
        }
        for anchor in anchor_rows(&refs) {
            total.add(anchor, true, false);
        }
    } else {
        let line_key = |r: &Value, index: usize| {
            format!(
                "{}|{}",
                document_key(r),
                text(r, "sourceLineId").map_or_else(|| format!("#{index}"), str::to_owned)
            )
        };
        let mut anchors: Vec<(String, usize)> = Vec::new();
        for (index, r) in rows.iter().enumerate() {
            let key = line_key(r, index);
            match anchors.iter_mut().find(|(k, _)| *k == key) {
                Some((_, current)) => {
                    let pair = [&rows[*current], r];
                    let best = anchor_rows(&pair);
                    if let Some(best) = best.first()
                        && std::ptr::eq(*best, r)
                    {
                        *current = index;
                    }
                }
                None => anchors.push((key, index)),
            }
        }
        for (index, r) in rows.iter().enumerate() {
            let key = line_key(r, index);
            let anchor = anchors
                .iter()
                .find(|(k, _)| *k == key)
                .map_or(r, |(_, i)| &rows[*i]);
            let g = group(&mut groups, anchor);
            groups[g].add(r, false, true);
            total.add(r, false, true);
        }
        for (_, i) in &anchors {
            let anchor = &rows[*i];
            let g = group(&mut groups, anchor);
            groups[g].add(anchor, true, false);
            total.add(anchor, true, false);
        }
    }
    let mut out: Vec<(i64, String, Value)> = groups
        .iter()
        .map(|g| (g.gross, g.label.clone(), g.finish()))
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| locale_compare(&a.1, &b.1)));
    Ok(json!({
        "from": from,
        "to": to,
        "groupBy": group_by,
        "rows": out.into_iter().map(|(_, _, v)| v).collect::<Vec<_>>(),
        "totals": Value::Object(total.figures()),
    }))
}

// ── Exceptions ──────────────────────────────────────────────────────────────

const KINDS: [&str; 7] = [
    "no_ship_to_state",
    "tax_in_unregistered_state",
    "taxable_without_tax",
    "marketplace_sale",
    "tax_override",
    "provider_commit_failure",
    "tax_warning",
];

async fn exceptions(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let entity = us_entity_of(&caller).await?;
            let (from, to) = range(&q, &today_of(&caller, &state, &entity))?;
            Ok(ok(exceptions_report(
                &caller.db,
                s(&entity, "id"),
                &from,
                &to,
            )
            .await?))
        }
        .await,
        "Failed to fetch the sales tax exceptions",
    )
}

/// Posted invoices, credit memos and corrections issued in `[from, to]`.
async fn posted_invoices(
    db: &PgPool,
    entity_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(invoices),
        " from invoices t where t.entity_id = $1 and t.deleted_at is null \
         and t.type in ('standard', 'correction', 'credit_note') and t.journal_entry_id is not null \
         and t.issue_date >= $2::timestamp and t.issue_date <= $3::timestamp"
    ))
    .bind(entity_id)
    .bind(start_of_day(from))
    .bind(start_of_day(&next_day(to)))
    .fetch_all(db)
    .await?;
    Ok(INVOICES.js_rows(rows))
}

fn doc_type(kind: &str) -> &'static str {
    if kind == "credit_note" {
        "credit_note"
    } else {
        "invoice"
    }
}

fn day10(value: &Value) -> Value {
    value
        .as_str()
        .map_or(Value::Null, |d| json!(d.get(..10).unwrap_or(d)))
}

fn state_or_null(shipping: &Value, billing: &Value) -> Value {
    let a = state_of_address(shipping);
    let state = if a.is_empty() {
        state_of_address(billing)
    } else {
        a
    };
    if state.is_empty() {
        Value::Null
    } else {
        json!(state)
    }
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::needless_pass_by_value, reason = "the values go into the JSON")]
fn exception(
    kind: &str,
    severity: &str,
    base: (&Value, &Value, &Value, &Value, &Value),
    state_code: Value,
    amount: Value,
    tax_amount: f64,
    message: String,
) -> Value {
    json!({
        "kind": kind,
        "severity": severity,
        "documentType": base.0,
        "documentId": base.1,
        "documentNumber": base.2,
        "date": base.3,
        "contactName": base.4,
        "stateCode": state_code,
        "amount": amount,
        "taxAmount": n(tax_amount),
        "message": message,
    })
}

fn contains_commit(text: &str) -> bool {
    text.to_lowercase().contains("commit")
}

/// `exceptionsReport(db, entityId, { from, to })`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors sales-tax-reports.ts's exceptionsReport()"
)]
async fn exceptions_report(
    db: &PgPool,
    entity_id: &str,
    from: &str,
    to: &str,
) -> Result<Value, sqlx::Error> {
    let agencies = load_agencies(db, entity_id).await?;
    let mut out: Vec<Value> = Vec::new();
    for i in posted_invoices(db, entity_id, from, to).await? {
        let kind = doc_type(s(&i, "type"));
        let date = day10(&i["issueDate"]);
        let base = (
            &json!(kind),
            &i["id"],
            &i["invoiceNumber"],
            &date,
            &i["contactName"],
        );
        if state_of_address(&i["shippingAddress"]).is_empty()
            && state_of_address(&i["billingAddress"]).is_empty()
        {
            out.push(exception(
                "no_ship_to_state",
                "error",
                base,
                Value::Null,
                n(num_at(&i, "subtotal")),
                num_at(&i, "taxTotal"),
                "The document has no ship-to or bill-to state, so the tax cannot be sourced."
                    .to_owned(),
            ));
        }
        for warning in i["taxWarnings"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let commit = contains_commit(warning);
            out.push(exception(
                if commit {
                    "provider_commit_failure"
                } else {
                    "tax_warning"
                },
                if commit { "error" } else { "warning" },
                base,
                state_or_null(&i["shippingAddress"], &i["billingAddress"]),
                n(num_at(&i, "subtotal")),
                num_at(&i, "taxTotal"),
                warning.to_owned(),
            ));
        }
    }

    let overrides: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('invoiceId', ii.invoice_id, 'description', ii.description, \
         'amount', ii.tax_override_amount::text, 'reason', ii.tax_override_reason, \
         'number', inv.invoice_number, 'type', inv.type, 'issueDate', to_char(inv.issue_date, 'YYYY-MM-DD'), \
         'contactName', inv.contact_name, 'shipping', inv.shipping_address, 'billing', inv.billing_address) \
         from invoice_items ii inner join invoices inv on inv.id = ii.invoice_id \
         where inv.entity_id = $1 and inv.deleted_at is null and ii.deleted_at is null \
         and ii.tax_override_amount is not null and inv.journal_entry_id is not null \
         and inv.issue_date >= $2::timestamp and inv.issue_date <= $3::timestamp",
    )
    .bind(entity_id)
    .bind(start_of_day(from))
    .bind(start_of_day(&next_day(to)))
    .fetch_all(db)
    .await?;
    for o in &overrides {
        let reason = text(o, "reason")
            .map(weldsuite_kit::validation::js_trim)
            .filter(|r| !r.is_empty())
            .unwrap_or("no reason given");
        let description = text(o, "description").unwrap_or("null");
        out.push(exception(
            "tax_override",
            "warning",
            (
                &json!(doc_type(s(o, "type"))),
                &o["invoiceId"],
                &o["number"],
                &o["issueDate"],
                &o["contactName"],
            ),
            state_or_null(&o["shipping"], &o["billing"]),
            Value::Null,
            num_at(o, "amount"),
            format!("Tax set by hand on \"{description}\": {reason}."),
        ));
    }

    let rows = sales_rows(db, entity_id, from, to).await?;
    let refs: Vec<&Value> = rows.iter().collect();
    let docs = describe_documents(db, entity_id, &refs).await?;
    let mut by_document: Vec<(String, Vec<&Value>)> = Vec::new();
    for r in &rows {
        let key = document_key(r);
        match by_document.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(r),
            None => by_document.push((key, vec![r])),
        }
    }
    for (key, list) in &by_document {
        let info = docs.get(key).cloned().unwrap_or(Value::Null);
        let first = list[0];
        let tax_date = s(first, "taxDate");
        let date = json!(tax_date);
        let base = (
            &info["type"],
            &info["id"],
            &info["number"],
            &date,
            &info["contactName"],
        );
        let state = text(first, "shipToState")
            .filter(|v| !v.is_empty())
            .or_else(|| text(first, "stateCode").filter(|v| !v.is_empty()))
            .unwrap_or("")
            .to_uppercase();
        let state = if state.is_empty() {
            Value::Null
        } else {
            json!(state)
        };

        let mut by_state: Vec<(String, Vec<&Value>)> = Vec::new();
        for r in list {
            let code = s(r, "stateCode").to_uppercase();
            match by_state.iter_mut().find(|(k, _)| *k == code) {
                Some((_, l)) => l.push(r),
                None => by_state.push((code, vec![r])),
            }
        }
        for (code, state_rows) in &by_state {
            let tax = sum_money(state_rows.iter().map(|r| num_at(r, "taxAmount")));
            if tax != 0.0 && !registered_on(&agencies, Some(code.as_str()), tax_date) {
                out.push(exception(
                    "tax_in_unregistered_state",
                    "error",
                    base,
                    json!(code),
                    Value::Null,
                    tax,
                    format!(
                        "Tax was charged in {}, where the business has no registration.",
                        if code.is_empty() {
                            "an unknown state"
                        } else {
                            code
                        }
                    ),
                ));
            }
        }
        let anchors = anchor_rows(list);
        for anchor in &anchors {
            let line = text(anchor, "sourceLineId");
            let line_tax = sum_money(
                list.iter()
                    .filter(|r| text(r, "sourceLineId") == line)
                    .map(|r| num_at(r, "taxAmount")),
            );
            let gross = num_at(anchor, "grossAmount");
            if gross > 0.0
                && line_tax == 0.0
                && num_at(anchor, "exemptAmount") == 0.0
                && num_at(anchor, "nonTaxableAmount") == 0.0
                && anchor["marketplaceFacilitated"].as_bool() != Some(true)
                && text(anchor, "certificateId").is_none_or(str::is_empty)
                && text(anchor, "exemptReason").is_none_or(str::is_empty)
                && registered_on(&agencies, text(anchor, "stateCode"), tax_date)
                && s(anchor, "direction") == "sales"
            {
                let code = s(anchor, "stateCode").to_uppercase();
                out.push(exception(
                    "taxable_without_tax",
                    "error",
                    base,
                    if code.is_empty() { state.clone() } else { json!(code) },
                    n(gross),
                    0.0,
                    "A sale in a state where the business is registered carries no tax, no exemption and no certificate.".to_owned(),
                ));
            }
        }
        let marketplace: Vec<&&Value> = anchors
            .iter()
            .filter(|a| a["marketplaceFacilitated"].as_bool() == Some(true))
            .collect();
        if !marketplace.is_empty() {
            out.push(exception(
                "marketplace_sale",
                "info",
                base,
                state.clone(),
                n(sum_money(marketplace.iter().map(|a| num_at(a, "grossAmount")))),
                0.0,
                "Sold through a marketplace facilitator that collects the tax; it counts toward nexus only.".to_owned(),
            ));
        }
    }

    out.sort_by(|a, b| {
        locale_compare(s(a, "date"), s(b, "date"))
            .then_with(|| locale_compare(s(a, "kind"), s(b, "kind")))
            .then_with(|| locale_compare(s(a, "documentNumber"), s(b, "documentNumber")))
    });
    let counts: Map<String, Value> = KINDS
        .iter()
        .map(|k| {
            (
                (*k).to_owned(),
                json!(out.iter().filter(|e| s(e, "kind") == *k).count()),
            )
        })
        .collect();
    Ok(json!({ "from": from, "to": to, "counts": counts, "exceptions": out }))
}

// ── Certificates ────────────────────────────────────────────────────────────

async fn expiring(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let entity = us_entity_of(&caller).await?;
            let days = q
                .get("days")
                .map_or(Some(60), parse_int)
                .filter(|d| *d != 0)
                .unwrap_or(60)
                .clamp(1, 730);
            let today = today_of(&caller, &state, &entity);
            Ok(ok(
                expiring_certificates(&caller.db, &entity, days, &today).await?
            ))
        }
        .await,
        "Failed to fetch expiring certificates",
    )
}

/// `expiringCertificates(db, entity, { days })`.
async fn expiring_certificates(
    db: &PgPool,
    entity: &Value,
    days: i64,
    today: &str,
) -> Result<Value, sqlx::Error> {
    let entity_id = s(entity, "id");
    let until = add_days(today, days);
    let earliest = add_days(today, -365);
    let certs: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(exemption_certificates),
        " from exemption_certificates t where t.entity_id = $1 and t.deleted_at is null \
         and t.status in ('valid', 'expired')"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let certs = EXEMPTION_CERTIFICATES.js_rows(certs);
    if certs.is_empty() {
        return Ok(json!({ "asOf": today, "days": days, "certificates": [] }));
    }
    let ids: Vec<String> = certs.iter().map(|c| s(c, "id").to_owned()).collect();
    let used: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "select certificate_id, max(tax_date)::text from tax_lines \
         where entity_id = $1 and certificate_id = any($2) group by certificate_id",
    )
    .bind(entity_id)
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let last_used = |id: &str| -> Option<String> {
        used.iter()
            .find(|(c, _)| c.as_deref() == Some(id))
            .and_then(|(_, d)| d.clone())
    };
    let names = customer_names(
        db,
        &unique(certs.iter().map(|c| s(c, "partyId").to_owned())),
    )
    .await?;
    let mut out: Vec<Value> = Vec::new();
    for cert in &certs {
        let id = s(cert, "id");
        let reference = to_certificate_ref(cert, last_used(id));
        let states: Vec<String> = cert["states"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let by_state: Vec<(String, Option<String>)> = states
            .iter()
            .map(|st| (st.to_uppercase(), certificate_expiry(&reference, st)))
            .collect();
        let mut dates: Vec<String> = by_state
            .iter()
            .filter_map(|(_, d)| d.clone().filter(|d| !d.is_empty()))
            .collect();
        dates.sort();
        let Some(expires_on) = dates.into_iter().next() else {
            continue;
        };
        if expires_on > until || expires_on < earliest {
            continue;
        }
        let days_left = weldsuite_books_domain::dates::diff_days(today, &expires_on).unwrap_or(0);
        out.push(json!({
            "certificateId": id,
            "partyId": cert["partyId"],
            "customerName": names.get(s(cert, "partyId")),
            "certificateNumber": cert["certificateNumber"],
            "reason": cert["reason"],
            "form": cert["form"],
            "blanket": cert["blanket"],
            "states": states.iter().map(|st| st.to_uppercase()).collect::<Vec<_>>(),
            "status": cert["status"],
            "expiresOn": expires_on,
            "expiryByState": by_state.iter().map(|(code, d)| json!({ "stateCode": code, "expiresOn": d })).collect::<Vec<_>>(),
            "daysLeft": days_left,
            "expired": expires_on.as_str() < today,
            "lastUsedOn": last_used(id),
        }));
    }
    out.sort_by(|a, b| {
        locale_compare(s(a, "expiresOn"), s(b, "expiresOn"))
            .then_with(|| locale_compare(s(a, "certificateId"), s(b, "certificateId")))
    });
    Ok(json!({ "asOf": today, "days": days, "certificates": out }))
}

async fn missing(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let entity = us_entity_of(&caller).await?;
            let from = q.present("from");
            let to = q.present("to");
            if from.is_some_and(|f| !is_iso_date_text(f))
                || to.is_some_and(|t| !is_iso_date_text(t))
            {
                return Err(bad("from and to must be YYYY-MM-DD dates"));
            }
            let today = today_of(&caller, &state, &entity);
            Ok(ok(missing_certificates(
                &caller.db, &entity, from, to, &today,
            )
            .await?))
        }
        .await,
        "Failed to fetch missing certificates",
    )
}

/// `missingCertificates(db, entity, { from, to })`.
async fn missing_certificates(
    db: &PgPool,
    entity: &Value,
    from: Option<&str>,
    to: Option<&str>,
    today: &str,
) -> Result<Value, sqlx::Error> {
    let entity_id = s(entity, "id");
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_lines),
        " from tax_lines t where t.entity_id = $1 and t.direction = 'sales' \
         and t.certificate_id is null and t.marketplace_facilitated = false \
         and coalesce(t.exempt_amount, 0) > 0 \
         and ($2::date is null or t.tax_date >= $2::date) and ($3::date is null or t.tax_date <= $3::date)"
    ))
    .bind(entity_id)
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;
    let rows = TAX_LINES.js_rows(rows);
    let refs: Vec<&Value> = rows.iter().collect();
    let docs = describe_documents(db, entity_id, &refs).await?;
    let mut by_document: Vec<(String, Vec<&Value>)> = Vec::new();
    for r in &rows {
        let key = document_key(r);
        match by_document.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(r),
            None => by_document.push((key, vec![r])),
        }
    }
    let mut out: Vec<Value> = Vec::new();
    for (key, list) in &by_document {
        let info = docs.get(key).cloned().unwrap_or(Value::Null);
        let anchors = anchor_rows(list);
        let first = anchors[0];
        let cure = missing_certificate_cure_deadline(s(first, "taxDate")).unwrap_or_default();
        let state = text(first, "shipToState")
            .filter(|v| !v.is_empty())
            .or_else(|| text(first, "stateCode").filter(|v| !v.is_empty()))
            .unwrap_or("")
            .to_uppercase();
        out.push(json!({
            "documentType": info["type"],
            "documentId": info["id"],
            "documentNumber": info["number"],
            "customerId": if first["contactId"].is_null() { info["contactId"].clone() } else { first["contactId"].clone() },
            "customerName": info["contactName"],
            "stateCode": if state.is_empty() { Value::Null } else { json!(state) },
            "saleDate": first["taxDate"],
            "exemptSales": n(sum_money(anchors.iter().map(|a| num_at(a, "exemptAmount")))),
            "exemptReason": first["exemptReason"],
            "cureDeadline": cure,
            "pastDeadline": cure.as_str() < today,
            "daysLeft": weldsuite_books_domain::dates::diff_days(today, &cure).unwrap_or(0),
        }));
    }
    out.sort_by(|a, b| {
        locale_compare(s(a, "cureDeadline"), s(b, "cureDeadline"))
            .then_with(|| locale_compare(s(a, "documentNumber"), s(b, "documentNumber")))
    });
    let exempt = sum_money(out.iter().map(|m| num_at(m, "exemptSales")));
    let past = out
        .iter()
        .filter(|m| m["pastDeadline"] == json!(true))
        .count();
    let documents = out.len();
    Ok(json!({
        "asOf": today,
        "certificates": out,
        "totals": { "documents": documents, "exemptSales": n(exempt), "pastDeadline": past },
    }))
}

// ── Provider reconciliation ─────────────────────────────────────────────────

async fn provider_reconciliation(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let entity = us_entity_of(&caller).await?;
            let today = today_of(&caller, &state, &entity);
            let from = q
                .get("from")
                .map_or_else(|| add_months(&today, -1), str::to_owned);
            let to = q.get("to").map_or_else(|| today.clone(), str::to_owned);
            if !is_iso_date_text(&from) || !is_iso_date_text(&to) {
                return Err(bad("from and to must be YYYY-MM-DD dates"));
            }
            let all = matches!(q.get("all"), Some("1" | "true"));
            Ok(ok(reconcile(&caller.db, &entity, &from, &to, all).await?))
        }
        .await,
        "Failed to reconcile the tax provider",
    )
}

/// `providerReconciliation(db, entity, { from, to, all })`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors sales-tax-reports.ts's providerReconciliation()"
)]
async fn reconcile(
    db: &PgPool,
    entity: &Value,
    from: &str,
    to: &str,
    all: bool,
) -> Result<Value, sqlx::Error> {
    let engine = text(entity, "salesTaxEngine")
        .unwrap_or("manual")
        .to_owned();
    let note = "The provider API has no transaction listing here, so the provider side is what WeldBooks recorded when it committed each document: its engine reference, commit time and tax breakdown. Differences inside the provider account itself are not visible.";
    if engine != "stripe_tax" && engine != "avalara" {
        return Ok(json!({
            "engine": engine,
            "applicable": false,
            "from": from,
            "to": to,
            "periods": [],
            "documents": [],
            "notes": ["This entity uses the manual engine; there is no provider to reconcile with."],
        }));
    }
    let invoices = posted_invoices(db, s(entity, "id"), from, to).await?;
    let ids: Vec<String> = invoices.iter().map(|i| s(i, "id").to_owned()).collect();
    let mut ledger: HashMap<String, f64> = HashMap::new();
    for part in ids.chunks(2000) {
        let sums: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
            "select source_id, sum(tax_amount)::text from tax_lines where entity_id = $1 \
             and source_type in ('invoice', 'credit_note') and direction = 'sales' \
             and source_id = any($2) group by source_id",
        )
        .bind(s(entity, "id"))
        .bind(part)
        .fetch_all(db)
        .await?;
        for (id, tax) in sums {
            if let Some(id) = id.filter(|i| !i.is_empty()) {
                ledger.insert(id, num(&tax.map_or(Value::Null, Value::String)));
            }
        }
    }

    let mut documents: Vec<Value> = Vec::new();
    // (period, documents, committed, uncommitted, providerTax, ledgerTax, difference, problems)
    let mut periods: Vec<ReconciliationPeriod> = Vec::new();
    for i in &invoices {
        let id = s(i, "id");
        let credit = s(i, "type") == "credit_note";
        let sign = if credit { -1.0 } else { 1.0 };
        let breakdown = i["taxBreakdown"].as_array();
        let breakdown_tax = breakdown
            .into_iter()
            .flatten()
            .fold(0.0, |sum, r| sum + r["taxAmount"].as_f64().unwrap_or(0.0));
        let provider_tax = round2(
            if breakdown.is_some_and(|b| !b.is_empty()) {
                breakdown_tax
            } else {
                num_at(i, "taxTotal")
            } * sign,
        );
        let ledger_tax = round2(ledger.get(id).copied().unwrap_or(0.0));
        let difference = round2(ledger_tax - provider_tax);
        let committed = text(i, "taxEngineRef").is_some_and(|r| !r.is_empty())
            && text(i, "taxCommittedAt").is_some_and(|c| !c.is_empty());
        let commit_failed = i["taxWarnings"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find(|w| contains_commit(w));
        let (status, severity, message) = if let Some(warning) = commit_failed {
            ("commit_failed", "error", json!(warning))
        } else if !ledger.contains_key(id) && provider_tax != 0.0 {
            (
                "no_ledger",
                "error",
                json!(
                    "The provider has tax for this document but the tax ledger has no rows for it."
                ),
            )
        } else if difference.abs() >= 0.01 {
            (
                "ledger_mismatch",
                "error",
                json!(format!(
                    "The tax ledger ({}) differs from the tax the provider calculated ({}).",
                    to_fixed(ledger_tax, 2),
                    to_fixed(provider_tax, 2)
                )),
            )
        } else if !committed {
            if engine == "avalara" {
                (
                    "missing_commit",
                    "error",
                    json!("The document was never committed to Avalara."),
                )
            } else {
                (
                    "not_committed",
                    "info",
                    json!("The document was calculated by Stripe Tax but not recorded there."),
                )
            }
        } else {
            ("ok", "ok", Value::Null)
        };
        let date = s(i, "issueDate").get(..10).unwrap_or("").to_owned();
        documents.push(json!({
            "documentType": doc_type(s(i, "type")),
            "documentId": id,
            "documentNumber": i["invoiceNumber"],
            "date": date,
            "engine": i["taxEngine"],
            "engineRef": i["taxEngineRef"],
            "committedAt": i["taxCommittedAt"],
            "providerTax": n(provider_tax),
            "ledgerTax": n(ledger_tax),
            "difference": n(difference),
            "status": status,
            "severity": severity,
            "message": message,
        }));
        let month = date.get(..7).unwrap_or("").to_owned();
        let index = if let Some(p) = periods.iter().position(|p| p.0 == month) {
            p
        } else {
            periods.push((month, 0, 0, 0, 0.0, 0.0, 0.0, 0));
            periods.len() - 1
        };
        let p = &mut periods[index];
        p.1 += 1;
        if committed {
            p.2 += 1;
        } else {
            p.3 += 1;
        }
        p.4 = round2(p.4 + provider_tax);
        p.5 = round2(p.5 + ledger_tax);
        p.6 = round2(p.5 - p.4);
        if severity == "error" {
            p.7 += 1;
        }
    }
    documents.sort_by(|a, b| {
        locale_compare(s(a, "date"), s(b, "date"))
            .then_with(|| locale_compare(s(a, "documentNumber"), s(b, "documentNumber")))
    });
    periods.sort_by(|a, b| locale_compare(&a.0, &b.0));
    let documents: Vec<Value> = if all {
        documents
    } else {
        documents
            .into_iter()
            .filter(|d| s(d, "status") != "ok")
            .collect()
    };
    Ok(json!({
        "engine": engine,
        "applicable": true,
        "from": from,
        "to": to,
        "periods": periods.iter().map(|p| json!({
            "period": p.0,
            "documents": p.1,
            "committed": p.2,
            "uncommitted": p.3,
            "providerTax": n(p.4),
            "ledgerTax": n(p.5),
            "difference": n(p.6),
            "problems": p.7,
        })).collect::<Vec<_>>(),
        "documents": documents,
        "notes": [note],
    }))
}
