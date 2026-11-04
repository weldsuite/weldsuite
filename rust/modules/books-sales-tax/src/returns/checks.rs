//! Checks before filing (`services/sales-tax-returns/checks.ts`): the
//! agency's payable in the general ledger against what the tax ledger says is
//! owed, and the return's net sales against the income of the period.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::js::{locale_compare, to_fixed};
use weldsuite_books_domain::posting::{BOOKED_STATUSES, account_for_role, load_entity_accounts};
use weldsuite_db::PgPool;

use super::calculate::{CalculationInput, calculate_return};
use super::common::{
    FILED_STATUSES, is_filed, n, next_day, num, num_at, round2, s, start_of_day, state_of_address,
    sum_money,
};
use super::documents::anchor_indexes;
use super::payment::{owed_by_filed_return, settled_against_payable};
use crate::common::text;

/// `statusAsOf(ret, asOf)`: `unfiled` | `filed` | `paid` on a date.
pub(crate) fn status_as_of(ret: &Value, as_of: &str) -> &'static str {
    let end = start_of_day(&next_day(as_of));
    let status = s(ret, "status");
    if text(ret, "paidAt").is_some_and(|p| p < end.as_str()) && status == "paid" {
        return "paid";
    }
    if text(ret, "filedAt").is_some_and(|f| f < end.as_str()) && FILED_STATUSES.contains(&status) {
        return "filed";
    }
    "unfiled"
}

/// `AgencyLiability`.
pub(crate) struct AgencyLiability {
    pub json: Map<String, Value>,
    pub collected_tax: f64,
    pub paid_tax: f64,
    pub filed_unpaid_tax: f64,
    pub unfiled_tax: f64,
    pub expected_balance: f64,
    pub gl_balance: f64,
    pub difference: f64,
    pub warnings: Vec<String>,
}

#[derive(sqlx::FromRow)]
struct GlRow {
    journal_entry_id: String,
    entry_number: Option<String>,
    date: Option<String>,
    description: Option<String>,
    source_type: Option<String>,
    source_id: Option<String>,
    net: Option<String>,
}

fn text_value(value: Option<&String>) -> Value {
    value.map_or(Value::Null, |v| json!(v))
}

/// `agencyLiability(db, { entityId, agency, asOf, withItems, returns })`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors checks.ts's agencyLiability()"
)]
pub(crate) async fn agency_liability(
    db: &PgPool,
    entity_id: &str,
    agency: &Value,
    as_of: &str,
    with_items: bool,
    returns: &[Value],
) -> Result<AgencyLiability, sqlx::Error> {
    let accounts = load_entity_accounts(db, entity_id).await?;
    let own: Vec<&Value> = [
        accounts.by_id(text(agency, "liabilityAccountId")),
        accounts.by_id(text(agency, "useTaxAccountId")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut warnings: Vec<String> = Vec::new();
    let mut payable = own.clone();
    let mut shared = false;
    if own.is_empty() {
        shared = true;
        payable = [
            account_for_role(&accounts, "sales_tax_payable", &["2200"]),
            account_for_role(&accounts, "use_tax_payable", &["2210"]),
        ]
        .into_iter()
        .flatten()
        .collect();
        warnings.push("This agency has no payable account of its own; the check compares the shared sales tax payable account.".to_owned());
    }
    let account_ids: Vec<String> = payable.iter().map(|a| s(a, "id").to_owned()).collect();
    let before = start_of_day(&next_day(as_of));
    let statuses: Vec<String> = BOOKED_STATUSES.iter().map(|s| (*s).to_owned()).collect();
    let gl_rows: Vec<GlRow> = if account_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "select je.id as journal_entry_id, je.entry_number, to_char(je.date, 'YYYY-MM-DD') as date, \
             je.description, je.source_type, je.source_id, \
             sum(coalesce(jl.credit, 0) - coalesce(jl.debit, 0))::text as net \
             from journal_lines jl inner join journal_entries je on je.id = jl.journal_entry_id \
             where jl.entity_id = $1 and jl.account_id = any($2) and jl.deleted_at is null \
             and je.deleted_at is null and je.status = any($3) and je.date < $4::timestamp \
             group by je.id, je.entry_number, je.date, je.description, je.source_type, je.source_id",
        )
        .bind(entity_id)
        .bind(&account_ids)
        .bind(&statuses)
        .bind(&before)
        .fetch_all(db)
        .await?
    };
    let net_of = |r: &GlRow| num(&r.net.clone().map_or(Value::Null, Value::String));
    let gl_balance = sum_money(gl_rows.iter().map(net_of));

    let ledger_rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "select journal_entry_id, sum(tax_amount)::text from tax_lines \
         where entity_id = $1 and agency_id = $2 and direction in ('sales', 'use') \
         and tax_date < $3::date group by journal_entry_id",
    )
    .bind(entity_id)
    .bind(s(agency, "id"))
    .bind(next_day(as_of))
    .fetch_all(db)
    .await?;
    let mut tax_by_entry: Vec<(String, f64)> = Vec::new();
    for (id, tax) in ledger_rows {
        let tax = num(&tax.map_or(Value::Null, Value::String));
        match tax_by_entry.iter_mut().find(|(k, _)| *k == id) {
            Some(entry) => entry.1 += tax,
            None => tax_by_entry.push((id, tax)),
        }
    }
    let collected_tax = sum_money(tax_by_entry.iter().map(|(_, t)| *t));
    let paid_tax = sum_money(
        returns
            .iter()
            .filter(|r| status_as_of(r, as_of) == "paid")
            .map(settled_against_payable),
    );
    let filed_unpaid = sum_money(
        returns
            .iter()
            .filter(|r| status_as_of(r, as_of) == "filed")
            .map(|r| {
                let mut filed = r.clone();
                filed["status"] = json!("filed");
                owed_by_filed_return(&filed)
            }),
    );
    let expected_balance = round2(collected_tax - paid_tax);

    let mut items: Vec<Map<String, Value>> = Vec::new();
    if with_items {
        let mut entry_ids: Vec<String> =
            gl_rows.iter().map(|r| r.journal_entry_id.clone()).collect();
        for (id, _) in &tax_by_entry {
            if !entry_ids.contains(id) {
                entry_ids.push(id.clone());
            }
        }
        for id in &entry_ids {
            let row = gl_rows.iter().find(|r| &r.journal_entry_id == id);
            let gl_amount = round2(row.map_or(0.0, net_of));
            let tax_amount = tax_by_entry
                .iter()
                .find(|(k, _)| k == id)
                .map_or(0.0, |(_, t)| *t);
            let settled = match row {
                Some(r) if r.source_type.as_deref() == Some("tax_return") => r
                    .source_id
                    .as_deref()
                    .filter(|i| !i.is_empty())
                    .and_then(|sid| {
                        returns
                            .iter()
                            .find(|ret| s(ret, "id") == sid && status_as_of(ret, as_of) == "paid")
                    })
                    .map_or(0.0, settled_against_payable),
                _ => 0.0,
            };
            let expected = round2(tax_amount - settled);
            let difference = round2(gl_amount - expected);
            if difference.abs() < 0.005 {
                continue;
            }
            let mut item = Map::new();
            item.insert("journalEntryId".into(), json!(id));
            item.insert(
                "entryNumber".into(),
                text_value(row.and_then(|r| r.entry_number.as_ref())),
            );
            item.insert(
                "date".into(),
                json!(row.and_then(|r| r.date.clone()).unwrap_or_default()),
            );
            item.insert(
                "description".into(),
                text_value(row.and_then(|r| r.description.as_ref())),
            );
            item.insert(
                "sourceType".into(),
                text_value(row.and_then(|r| r.source_type.as_ref())),
            );
            item.insert(
                "sourceId".into(),
                text_value(row.and_then(|r| r.source_id.as_ref())),
            );
            item.insert("glAmount".into(), n(gl_amount));
            item.insert("expectedAmount".into(), n(expected));
            item.insert("difference".into(), n(difference));
            items.push(item);
        }
        items.sort_by(|a, b| {
            locale_compare(
                a["date"].as_str().unwrap_or(""),
                b["date"].as_str().unwrap_or(""),
            )
            .then_with(|| {
                locale_compare(
                    a["journalEntryId"].as_str().unwrap_or(""),
                    b["journalEntryId"].as_str().unwrap_or(""),
                )
            })
        });
        let undated: Vec<String> = items
            .iter()
            .filter(|i| i["date"].as_str() == Some(""))
            .filter_map(|i| i["journalEntryId"].as_str().map(str::to_owned))
            .collect();
        if !undated.is_empty() {
            let found: Vec<GlRow> = sqlx::query_as(
                "select id as journal_entry_id, entry_number, to_char(date, 'YYYY-MM-DD') as date, \
                 description, source_type, source_id, null::text as net \
                 from journal_entries where id = any($1)",
            )
            .bind(&undated)
            .fetch_all(db)
            .await?;
            for f in found {
                if let Some(item) = items
                    .iter_mut()
                    .find(|i| i["journalEntryId"].as_str() == Some(f.journal_entry_id.as_str()))
                {
                    item.insert("entryNumber".into(), text_value(f.entry_number.as_ref()));
                    item.insert("date".into(), json!(f.date.unwrap_or_default()));
                    item.insert("description".into(), text_value(f.description.as_ref()));
                    item.insert("sourceType".into(), text_value(f.source_type.as_ref()));
                    item.insert("sourceId".into(), text_value(f.source_id.as_ref()));
                }
            }
        }
    }

    let unfiled_tax = round2(expected_balance - filed_unpaid);
    let difference = round2(gl_balance - expected_balance);
    let mut out = Map::new();
    out.insert("agencyId".into(), agency["id"].clone());
    out.insert("asOf".into(), json!(as_of));
    out.insert(
        "accounts".into(),
        Value::Array(
            payable
                .iter()
                .map(|a| json!({ "id": a["id"], "code": a["code"], "name": a["name"] }))
                .collect(),
        ),
    );
    out.insert("sharedAccount".into(), json!(shared));
    out.insert("glBalance".into(), n(gl_balance));
    out.insert("collectedTax".into(), n(collected_tax));
    out.insert("paidTax".into(), n(paid_tax));
    out.insert("filedUnpaidTax".into(), n(filed_unpaid));
    out.insert("unfiledTax".into(), n(unfiled_tax));
    out.insert("expectedBalance".into(), n(expected_balance));
    out.insert("difference".into(), n(difference));
    out.insert(
        "items".into(),
        Value::Array(items.into_iter().map(Value::Object).collect()),
    );
    out.insert("warnings".into(), json!(warnings));
    Ok(AgencyLiability {
        json: out,
        collected_tax,
        paid_tax,
        filed_unpaid_tax: filed_unpaid,
        unfiled_tax,
        expected_balance,
        gl_balance,
        difference,
        warnings,
    })
}

// ── Pre-file check ──────────────────────────────────────────────────────────

const LIST_LIMIT: usize = 50;

struct InvoiceFacts {
    id: String,
    number: Value,
    kind: String,
    date: String,
    contact_name: Value,
    ship_to_state: String,
    income: f64,
}

impl InvoiceFacts {
    fn document_type(&self) -> &'static str {
        if self.kind == "credit_note" {
            "credit_note"
        } else {
            "invoice"
        }
    }
}

async fn period_invoices(
    db: &PgPool,
    entity_id: &str,
    start: &str,
    end: &str,
) -> Result<Vec<InvoiceFacts>, sqlx::Error> {
    let invoices: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'number', invoice_number, 'type', type, \
         'date', to_char(issue_date, 'YYYY-MM-DD'), 'contactName', contact_name, \
         'shipping', shipping_address, 'billing', billing_address) from invoices \
         where entity_id = $1 and deleted_at is null and type in ('standard', 'correction', 'credit_note') \
         and journal_entry_id is not null and issue_date >= $2::timestamp and issue_date < $3::timestamp",
    )
    .bind(entity_id)
    .bind(start_of_day(start))
    .bind(start_of_day(&next_day(end)))
    .fetch_all(db)
    .await?;
    let ids: Vec<String> = invoices.iter().map(|i| s(i, "id").to_owned()).collect();
    let mut income: Vec<(String, f64)> = Vec::new();
    for part in ids.chunks(2000) {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "select invoice_id, sum(coalesce(line_total, 0))::text from invoice_items \
             where invoice_id = any($1) and deleted_at is null group by invoice_id",
        )
        .bind(part)
        .fetch_all(db)
        .await?;
        for (id, total) in rows {
            income.push((id, num(&total.map_or(Value::Null, Value::String))));
        }
    }
    Ok(invoices
        .into_iter()
        .map(|i| {
            let id = s(&i, "id").to_owned();
            let kind = s(&i, "type").to_owned();
            let sign = if kind == "credit_note" { -1.0 } else { 1.0 };
            let total = income
                .iter()
                .find(|(k, _)| *k == id)
                .map_or(0.0, |(_, t)| *t);
            let shipping = state_of_address(&i["shipping"]);
            InvoiceFacts {
                ship_to_state: if shipping.is_empty() {
                    state_of_address(&i["billing"])
                } else {
                    shipping
                },
                income: round2(total * sign),
                number: i["number"].clone(),
                date: s(&i, "date").to_owned(),
                contact_name: i["contactName"].clone(),
                kind,
                id,
            }
        })
        .collect())
}

#[allow(clippy::needless_pass_by_value, reason = "the values go into the JSON")]
fn finding(code: &str, severity: &str, message: String, documents: Vec<Value>) -> Value {
    let amount = sum_money(documents.iter().map(|d| num_at(d, "amount")));
    let count = documents.len();
    json!({
        "code": code,
        "severity": severity,
        "message": message,
        "count": count,
        "amount": n(amount),
        "documents": documents.into_iter().take(LIST_LIMIT).collect::<Vec<_>>(),
        "truncated": count > LIST_LIMIT,
    })
}

#[derive(sqlx::FromRow)]
struct EntryAmount {
    id: String,
    entry_number: Option<String>,
    date: Option<String>,
    description: Option<String>,
    source_type: Option<String>,
    source_id: Option<String>,
    amount: Option<String>,
}

/// `preFileCheck(db, { entity, agency, ret })`.
#[allow(clippy::too_many_lines, reason = "mirrors checks.ts's preFileCheck()")]
pub(crate) async fn pre_file_check(
    db: &PgPool,
    entity: &Value,
    agency: &Value,
    ret: &Value,
    now: &str,
    today: &str,
) -> Result<Value, sqlx::Error> {
    let entity_id = s(entity, "id");
    let mut document_gross: Vec<(String, f64)> = Vec::new();
    let counted = !is_filed(ret);
    if counted {
        let calc = calculate_return(
            db,
            &CalculationInput {
                entity,
                agency,
                ret,
                now,
                today,
                created_not_after: None,
            },
        )
        .await?;
        let mut by_doc: Vec<(String, Vec<usize>)> = Vec::new();
        for (index, e) in calc.rows.entries.iter().enumerate() {
            let source_type = s(&e.row, "sourceType");
            if e.carried
                || matches!(source_type, "write_off" | "bad_debt")
                || s(&e.row, "direction") == "use"
            {
                continue;
            }
            let key = format!(
                "{}|{}",
                if source_type == "credit_note" {
                    "credit_note"
                } else {
                    "invoice"
                },
                text(&e.row, "sourceId").unwrap_or_else(|| s(&e.row, "journalEntryId"))
            );
            match by_doc.iter_mut().find(|(k, _)| *k == key) {
                Some((_, list)) => list.push(index),
                None => by_doc.push((key, vec![index])),
            }
        }
        for (key, list) in by_doc {
            let entries: Vec<&super::rows::LoadedEntry> =
                list.iter().map(|i| &calc.rows.entries[*i]).collect();
            let anchors = anchor_indexes(&entries, |e| {
                (
                    text(&e.row, "sourceLineId"),
                    text(&e.row, "jurisdictionLevel"),
                    text(&e.row, "jurisdictionCode"),
                )
            });
            document_gross.push((
                key,
                sum_money(
                    anchors
                        .iter()
                        .map(|i| entries[*i].line.gross_amount.unwrap_or(0.0)),
                ),
            ));
        }
    }

    let mut skipped: Vec<String> = Vec::new();
    let mut findings: Vec<Value> = Vec::new();
    let invoices =
        period_invoices(db, entity_id, s(ret, "periodStart"), s(ret, "periodEnd")).await?;
    let agency_state = s(agency, "stateCode").to_uppercase();
    let to_state: Vec<&InvoiceFacts> = invoices
        .iter()
        .filter(|i| i.ship_to_state == agency_state)
        .collect();

    let mut comparison = Value::Null;
    if s(agency, "reportingBasis") == "cash" {
        skipped.push("net_sales_difference: a cash-basis return counts sales when paid, so it does not match income of the period".to_owned());
    } else if !counted {
        skipped.push("net_sales_difference: the return is already filed".to_owned());
    } else {
        let mut docs: Vec<Value> = Vec::new();
        let mut return_net = 0.0;
        for (_, v) in &document_gross {
            return_net += v;
        }
        let income_shipped = sum_money(to_state.iter().map(|i| i.income));
        for invoice in &to_state {
            let key = format!("{}|{}", invoice.document_type(), invoice.id);
            let ledger = document_gross
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| *v);
            let difference = round2(invoice.income - ledger.unwrap_or(0.0));
            if difference.abs() < 0.01 {
                continue;
            }
            docs.push(json!({
                "documentType": invoice.document_type(),
                "documentId": invoice.id,
                "number": invoice.number,
                "date": invoice.date,
                "contactName": invoice.contact_name,
                "amount": n(invoice.income),
                "returnAmount": n(ledger.unwrap_or(0.0)),
                "reason": if ledger.is_none() {
                    "No tax-ledger rows for this agency: its income is not on the return"
                } else {
                    "Income differs from the sales the return counts"
                },
            }));
        }
        let net = round2(return_net);
        let difference = round2(income_shipped - return_net);
        comparison = json!({
            "returnNetSales": n(net),
            "incomeShippedToState": n(income_shipped),
            "difference": n(difference),
        });
        if difference != 0.0 || !docs.is_empty() {
            findings.push(finding(
                "net_sales_difference",
                "error",
                format!(
                    "Income of invoices shipped to {} ({}) differs from the net sales on the return ({}).",
                    s(agency, "stateCode"),
                    to_fixed(income_shipped, 2),
                    to_fixed(net, 2)
                ),
                docs,
            ));
        }
    }

    let period_start = start_of_day(s(ret, "periodStart"));
    let period_after = start_of_day(&next_day(s(ret, "periodEnd")));
    let statuses: Vec<String> = BOOKED_STATUSES.iter().map(|s| (*s).to_owned()).collect();
    let revenue: Vec<EntryAmount> = sqlx::query_as(
        "select je.id, je.entry_number, to_char(je.date, 'YYYY-MM-DD') as date, je.description, \
         je.source_type, je.source_id, sum(coalesce(jl.credit, 0) - coalesce(jl.debit, 0))::text as amount \
         from journal_lines jl inner join journal_entries je on je.id = jl.journal_entry_id \
         inner join accounts a on a.id = jl.account_id \
         where jl.entity_id = $1 and jl.deleted_at is null and je.deleted_at is null \
         and je.status = any($2) and a.type = 'revenue' \
         and je.date >= $3::timestamp and je.date < $4::timestamp \
         and not exists (select 1 from tax_lines t where t.journal_entry_id = je.id) \
         group by je.id, je.entry_number, je.date, je.description, je.source_type, je.source_id \
         having sum(coalesce(jl.credit, 0) - coalesce(jl.debit, 0)) <> 0",
    )
    .bind(entity_id)
    .bind(&statuses)
    .bind(&period_start)
    .bind(&period_after)
    .fetch_all(db)
    .await?;
    let amount_of =
        |r: &EntryAmount| round2(num(&r.amount.clone().map_or(Value::Null, Value::String)));
    if !revenue.is_empty() {
        let docs: Vec<Value> = revenue
            .iter()
            .map(|r| {
                let source = r.source_type.as_deref();
                let document_type = match source {
                    Some("invoice") => "invoice",
                    Some("credit_note") => "credit_note",
                    _ => "journal_entry",
                };
                let document_id = if matches!(source, Some("invoice" | "credit_note")) {
                    r.source_id.clone().unwrap_or_else(|| r.id.clone())
                } else {
                    r.id.clone()
                };
                json!({
                    "documentType": document_type,
                    "documentId": document_id,
                    "number": r.entry_number,
                    "date": r.date.clone().unwrap_or_default(),
                    "contactName": null,
                    "amount": n(amount_of(r)),
                    "reason": r.description.clone().unwrap_or_else(|| "Income without tax data".to_owned()),
                })
            })
            .collect();
        findings.push(finding(
            "income_without_tax_data",
            "warning",
            "Income was posted in this period without sales tax data (no tax-ledger rows). It is not on any return.".to_owned(),
            docs,
        ));
    }

    let no_state: Vec<Value> = invoices
        .iter()
        .filter(|i| i.ship_to_state.is_empty())
        .map(|i| {
            json!({
                "documentType": i.document_type(),
                "documentId": i.id,
                "number": i.number,
                "date": i.date,
                "contactName": i.contact_name,
                "amount": n(i.income),
                "reason": "No ship-to state",
            })
        })
        .collect();
    if !no_state.is_empty() {
        findings.push(finding(
            "missing_ship_to",
            "warning",
            "Invoices have no ship-to or bill-to state, so their sales cannot be reported to any state.".to_owned(),
            no_state,
        ));
    }

    let payable_ids: Vec<String> = [
        text(agency, "liabilityAccountId"),
        text(agency, "useTaxAccountId"),
    ]
    .into_iter()
    .flatten()
    .filter(|id| !id.is_empty())
    .map(str::to_owned)
    .collect();
    if payable_ids.is_empty() {
        skipped.push(
            "payable_direct_entries: the agency has no payable account of its own".to_owned(),
        );
    } else {
        let direct: Vec<EntryAmount> = sqlx::query_as(
            "select je.id, je.entry_number, to_char(je.date, 'YYYY-MM-DD') as date, je.description, \
             null::text as source_type, null::text as source_id, \
             sum(coalesce(jl.credit, 0) - coalesce(jl.debit, 0))::text as amount \
             from journal_lines jl inner join journal_entries je on je.id = jl.journal_entry_id \
             where jl.entity_id = $1 and jl.account_id = any($2) and jl.deleted_at is null \
             and je.deleted_at is null and je.status = any($3) \
             and je.date >= $4::timestamp and je.date < $5::timestamp \
             and je.source_type is distinct from 'tax_return' \
             and not exists (select 1 from tax_lines t where t.journal_entry_id = je.id and t.agency_id = $6) \
             group by je.id, je.entry_number, je.date, je.description",
        )
        .bind(entity_id)
        .bind(&payable_ids)
        .bind(&statuses)
        .bind(&period_start)
        .bind(&period_after)
        .bind(s(agency, "id"))
        .fetch_all(db)
        .await?;
        if !direct.is_empty() {
            let docs: Vec<Value> = direct
                .iter()
                .map(|r| {
                    json!({
                        "documentType": "journal_entry",
                        "documentId": r.id,
                        "number": r.entry_number,
                        "date": r.date.clone().unwrap_or_default(),
                        "contactName": null,
                        "amount": n(amount_of(r)),
                        "reason": r.description.clone().unwrap_or_else(|| "Direct entry on the payable account".to_owned()),
                    })
                })
                .collect();
            findings.push(finding(
                "payable_direct_entries",
                "warning",
                "Journal entries moved the agency payable account directly. Their amounts are not on the return.".to_owned(),
                docs,
            ));
        }
    }

    let ok = findings.is_empty();
    Ok(json!({
        "returnId": ret["id"],
        "agencyId": agency["id"],
        "stateCode": agency["stateCode"],
        "periodStart": ret["periodStart"],
        "periodEnd": ret["periodEnd"],
        "comparison": comparison,
        "skipped": skipped,
        "findings": findings,
        "ok": ok,
    }))
}
