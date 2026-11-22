//! The documents behind tax-ledger rows (`services/sales-tax-returns/documents.ts`):
//! invoices, credit memos, bills and journal entries, each with the
//! jurisdiction rows it contributed and the certificates it relied on.

use std::collections::HashMap;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_books_domain::js::locale_compare;
use weldsuite_books_domain::sales_tax::worksheet::level_rank;
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{bills, exemption_certificates, invoices, journal_entries};

use super::common::{day_text, n, num_at, rows_json, s, sum_money};
use super::rows::LoadedEntry;
use crate::common::text;

const INVOICE_SOURCES: [&str; 4] = ["invoice", "credit_note", "write_off", "bad_debt"];
const BILL_SOURCES: [&str; 2] = ["bill", "bill_credit_note"];

/// `documentKey(row)`: `<sourceType>|<sourceId ?? journalEntryId>`.
pub(crate) fn document_key(row: &Value) -> String {
    format!(
        "{}|{}",
        s(row, "sourceType"),
        text(row, "sourceId").unwrap_or_else(|| s(row, "journalEntryId"))
    )
}

fn day_of(value: &Value) -> Value {
    value
        .as_str()
        .filter(|d| !d.is_empty())
        .map_or(Value::Null, |d| json!(d.get(..10).unwrap_or(d)))
}

#[allow(clippy::needless_pass_by_value, reason = "the values go into the JSON")]
fn info(
    kind: &str,
    id: Value,
    number: &Value,
    contact: (&Value, &Value),
    date: Value,
    row: &Value,
) -> Value {
    json!({
        "type": kind,
        "id": id,
        "number": number,
        "contactId": contact.0,
        "contactName": contact.1,
        "date": date,
        "status": row["status"],
        "currency": row["currency"],
        "description": null,
    })
}

/// An invoice or bill as `describeDocuments` reads it.
#[derive(Debug, FromQueryResult)]
struct DocumentRow {
    id: String,
    number: Option<String>,
    contact_id: String,
    contact_name: Option<String>,
    issue_date: time::PrimitiveDateTime,
    status: String,
    currency: Option<String>,
    kind: String,
}

impl DocumentRow {
    /// The row as `jsonb_build_object` built it (`issueDate` is cut to its
    /// day when read).
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "number": self.number,
            "contactId": self.contact_id,
            "contactName": self.contact_name,
            "issueDate": day_text(self.issue_date.date()),
            "status": self.status,
            "currency": self.currency,
            "type": self.kind,
        })
    }
}

/// The entity's invoices among `ids`.
async fn invoice_rows(db: &PgPool, entity_id: &str, ids: &[String]) -> Result<Vec<Value>, DbErr> {
    use invoices::Column;
    let rows = invoices::Entity::find()
        .select_only()
        .column(Column::Id)
        .column_as(Column::InvoiceNumber, "number")
        .columns([Column::ContactId, Column::ContactName, Column::IssueDate])
        .columns([Column::Status, Column::Currency])
        .column_as(Column::Type, "kind")
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::Id.is_in(ids.iter().map(String::as_str)))
        .into_model::<DocumentRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(DocumentRow::to_json).collect())
}

/// The entity's bills among `ids`.
async fn bill_rows(db: &PgPool, entity_id: &str, ids: &[String]) -> Result<Vec<Value>, DbErr> {
    use bills::Column;
    let rows = bills::Entity::find()
        .select_only()
        .column(Column::Id)
        .column_as(Column::BillNumber, "number")
        .columns([Column::ContactId, Column::ContactName, Column::IssueDate])
        .columns([Column::Status, Column::Currency])
        .column_as(Column::Type, "kind")
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::Id.is_in(ids.iter().map(String::as_str)))
        .into_model::<DocumentRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(DocumentRow::to_json).collect())
}

/// `id, entry_number, date, description, status` of a journal entry.
type EntryRow = (
    String,
    Option<String>,
    time::PrimitiveDateTime,
    Option<String>,
    String,
);

/// The entity's journal entries among `ids`.
async fn entry_rows(db: &PgPool, entity_id: &str, ids: &[String]) -> Result<Vec<EntryRow>, DbErr> {
    use journal_entries::Column;
    journal_entries::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::EntryNumber,
            Column::Date,
            Column::Description,
            Column::Status,
        ])
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::Id.is_in(ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `describeDocuments(db, entityId, rows)`: number, counterparty and date of
/// the documents the rows came from, by `documentKey`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors documents.ts's describeDocuments()"
)]
pub(crate) async fn describe_documents(
    db: &PgPool,
    entity_id: &str,
    rows: &[&Value],
) -> Result<HashMap<String, Value>, DbErr> {
    let mut invoice_ids: Vec<String> = Vec::new();
    let mut bill_ids: Vec<String> = Vec::new();
    let mut entry_ids: Vec<String> = Vec::new();
    let push = |list: &mut Vec<String>, id: &str| {
        if !list.iter().any(|i| i == id) {
            list.push(id.to_owned());
        }
    };
    for row in rows {
        let source_type = s(row, "sourceType");
        match text(row, "sourceId").filter(|i| !i.is_empty()) {
            Some(id) if INVOICE_SOURCES.contains(&source_type) => push(&mut invoice_ids, id),
            Some(id) if BILL_SOURCES.contains(&source_type) => push(&mut bill_ids, id),
            _ => push(&mut entry_ids, s(row, "journalEntryId")),
        }
    }

    let mut invoices: HashMap<String, Value> = HashMap::new();
    for part in invoice_ids.chunks(1000) {
        let found = invoice_rows(db, entity_id, part).await?;
        for r in found {
            let kind = if s(&r, "type") == "credit_note" {
                "credit_note"
            } else {
                "invoice"
            };
            invoices.insert(
                s(&r, "id").to_owned(),
                info(
                    kind,
                    r["id"].clone(),
                    &r["number"],
                    (&r["contactId"], &r["contactName"]),
                    day_of(&r["issueDate"]),
                    &r,
                ),
            );
        }
    }
    let mut bills: HashMap<String, Value> = HashMap::new();
    for part in bill_ids.chunks(1000) {
        let found = bill_rows(db, entity_id, part).await?;
        for r in found {
            let kind = if s(&r, "type") == "credit_note" {
                "bill_credit_note"
            } else {
                "bill"
            };
            bills.insert(
                s(&r, "id").to_owned(),
                info(
                    kind,
                    r["id"].clone(),
                    &r["number"],
                    (&r["contactId"], &r["contactName"]),
                    day_of(&r["issueDate"]),
                    &r,
                ),
            );
        }
    }
    let mut entries: HashMap<String, Value> = HashMap::new();
    for part in entry_ids.chunks(1000) {
        for (id, number, date, description, status) in entry_rows(db, entity_id, part).await? {
            entries.insert(
                id.clone(),
                json!({
                    "type": "journal_entry",
                    "id": id,
                    "number": number,
                    "contactId": null,
                    "contactName": null,
                    // `to_jsonb(date)` cut to its day.
                    "date": day_text(date.date()),
                    "status": status,
                    "currency": null,
                    "description": description,
                }),
            );
        }
    }

    let mut out: HashMap<String, Value> = HashMap::new();
    for row in rows {
        let key = document_key(row);
        if out.contains_key(&key) {
            continue;
        }
        let source_type = s(row, "sourceType");
        let source_id = text(row, "sourceId").filter(|i| !i.is_empty());
        let found = source_id
            .filter(|_| INVOICE_SOURCES.contains(&source_type))
            .and_then(|id| invoices.get(id))
            .or_else(|| {
                source_id
                    .filter(|_| BILL_SOURCES.contains(&source_type))
                    .and_then(|id| bills.get(id))
            })
            .or_else(|| entries.get(s(row, "journalEntryId")))
            .cloned();
        out.insert(
            key,
            found.unwrap_or_else(|| {
                json!({
                    "type": source_type,
                    "id": row["sourceId"],
                    "number": null,
                    "contactId": null,
                    "contactName": null,
                    "date": null,
                    "status": null,
                    "currency": null,
                    "description": null,
                })
            }),
        );
    }
    Ok(out)
}

/// `anchorRows(rows)`: a document line's gross counts once, from its
/// highest-level row. `key` gives `(sourceLineId, jurisdictionLevel,
/// jurisdictionCode)`; the answer is the anchors' indexes, in the order
/// their lines first appear.
pub(crate) fn anchor_indexes<T>(
    rows: &[T],
    key: impl Fn(&T) -> (Option<&str>, Option<&str>, Option<&str>),
) -> Vec<usize> {
    let mut by_line: Vec<(String, usize)> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let (line, level, code) = key(row);
        let line_key = line.map_or_else(|| format!("#{index}"), str::to_owned);
        match by_line.iter_mut().find(|(k, _)| *k == line_key) {
            None => by_line.push((line_key, index)),
            Some((_, current)) => {
                let (_, current_level, current_code) = key(&rows[*current]);
                let better = level_rank(level) < level_rank(current_level)
                    || (level_rank(level) == level_rank(current_level)
                        && code.unwrap_or("") < current_code.unwrap_or(""));
                if better {
                    *current = index;
                }
            }
        }
    }
    by_line.into_iter().map(|(_, i)| i).collect()
}

/// `anchorRows` of tax-ledger rows.
pub(crate) fn anchor_rows<'a>(rows: &[&'a Value]) -> Vec<&'a Value> {
    anchor_indexes(rows, |r| {
        (
            text(r, "sourceLineId"),
            text(r, "jurisdictionLevel"),
            text(r, "jurisdictionCode"),
        )
    })
    .into_iter()
    .map(|i| rows[i])
    .collect()
}

/// `returnDocuments(db, entityId, entries)`: the documents behind a
/// worksheet's rows, oldest first.
pub(crate) async fn return_documents(
    db: &PgPool,
    entity_id: &str,
    entries: &[LoadedEntry],
) -> Result<Vec<Value>, DbErr> {
    let rows: Vec<&Value> = entries.iter().map(|e| &e.row).collect();
    let info = describe_documents(db, entity_id, &rows).await?;
    let mut by_doc: Vec<(String, Vec<&LoadedEntry>)> = Vec::new();
    for e in entries {
        let key = document_key(&e.row);
        match by_doc.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(e),
            None => by_doc.push((key, vec![e])),
        }
    }
    let mut out: Vec<(String, String, Value)> = Vec::new();
    for (key, list) in by_doc {
        let mut details: Vec<Value> = list
            .iter()
            .map(|e| {
                json!({
                    "taxLineId": e.row["id"],
                    "sourceLineId": e.row["sourceLineId"],
                    "kind": if s(&e.row, "direction") == "use" { "use" } else { "sales" },
                    "jurisdictionCode": e.row["jurisdictionCode"],
                    "jurisdictionName": e.row["jurisdictionName"],
                    "jurisdictionLevel": e.row["jurisdictionLevel"],
                    "reportingCode": e.row["reportingCode"],
                    "rate": n(num_at(&e.row, "rate")),
                    "grossAmount": n(e.line.gross_amount.unwrap_or(0.0)),
                    "taxableAmount": n(e.line.taxable_amount),
                    "exemptAmount": n(e.line.exempt_amount.unwrap_or(0.0)),
                    "nonTaxableAmount": n(e.line.non_taxable_amount.unwrap_or(0.0)),
                    "taxAmount": n(e.line.tax_amount),
                    "exemptReason": e.row["exemptReason"],
                    "certificateId": e.row["certificateId"],
                    "taxCode": e.row["taxCode"],
                    "shipToState": e.row["shipToState"],
                    "marketplaceFacilitated": e.row["marketplaceFacilitated"],
                    "share": n(e.scale),
                    "carried": e.carried,
                })
            })
            .collect();
        details.sort_by(|a, b| {
            locale_compare(s(a, "sourceLineId"), s(b, "sourceLineId"))
                .then_with(|| {
                    level_rank(text(a, "jurisdictionLevel"))
                        .cmp(&level_rank(text(b, "jurisdictionLevel")))
                })
                .then_with(|| locale_compare(s(a, "jurisdictionName"), s(b, "jurisdictionName")))
        });
        let amount = |d: &Value, key: &str| num_at(d, key);
        let sales: Vec<&Value> = details.iter().filter(|d| s(d, "kind") == "sales").collect();
        let anchors: Vec<&Value> = anchor_indexes(&sales, |d| {
            (
                text(d, "sourceLineId"),
                text(d, "jurisdictionLevel"),
                text(d, "jurisdictionCode"),
            )
        })
        .into_iter()
        .map(|i| sales[i])
        .collect();
        let mut certificate_ids: Vec<String> = Vec::new();
        for d in &details {
            if let Some(id) = text(d, "certificateId").filter(|i| !i.is_empty())
                && !certificate_ids.iter().any(|c| c == id)
            {
                certificate_ids.push(id.to_owned());
            }
        }
        let first = &list[0].row;
        let document = info.get(&key).cloned().unwrap_or(Value::Null);
        let sort_name = text(&document, "number").map_or_else(|| key.clone(), str::to_owned);
        let tax_date = s(first, "taxDate").to_owned();
        let doc = json!({
            "key": key,
            "document": document,
            "taxDate": tax_date,
            "grossSales": n(sum_money(anchors.iter().map(|a| amount(a, "grossAmount")))),
            "taxableSales": n(sum_money(anchors.iter().map(|a| amount(a, "taxableAmount")))),
            "exemptSales": n(sum_money(anchors.iter().map(|a| amount(a, "exemptAmount")))),
            "nonTaxableSales": n(sum_money(anchors.iter().map(|a| amount(a, "nonTaxableAmount")))),
            "tax": n(sum_money(sales.iter().map(|d| amount(d, "taxAmount")))),
            "useTax": n(sum_money(details.iter().filter(|d| s(d, "kind") == "use").map(|d| amount(d, "taxAmount")))),
            "carried": list.iter().all(|e| e.carried),
            "certificateIds": certificate_ids,
            "rows": details,
        });
        out.push((tax_date, sort_name, doc));
    }
    out.sort_by(|a, b| locale_compare(&a.0, &b.0).then_with(|| locale_compare(&a.1, &b.1)));
    Ok(out.into_iter().map(|(_, _, d)| d).collect())
}

/// `loadCertificateRefs(db, entityId, ids)`.
pub(crate) async fn load_certificate_refs(
    db: &PgPool,
    entity_id: &str,
    ids: &[String],
) -> Result<Vec<Value>, DbErr> {
    use exemption_certificates::Column;
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    let mut out = Vec::new();
    for part in unique.chunks(1000) {
        let rows = exemption_certificates::Entity::find()
            .filter(Column::EntityId.eq(entity_id))
            .filter(Column::Id.is_in(part.iter().map(String::as_str)))
            .all(&orm(db))
            .await?;
        for row in rows_json(rows)? {
            out.push(json!({
                "id": row["id"],
                "certificateNumber": row["certificateNumber"],
                "reason": row["reason"],
                "states": if row["states"].is_null() { json!([]) } else { row["states"].clone() },
                "expiresOn": row["expiresOn"],
                "status": row["status"],
            }));
        }
    }
    Ok(out)
}
