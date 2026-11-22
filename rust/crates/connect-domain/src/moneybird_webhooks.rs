//! Moneybird deliveries whose entity is not the record to import
//! (`moneybird-webhooks.ts` of connect-domain,
//! [`crate::webhooks::is_routed_moneybird_topic`]):
//!
//! - `document_*`: a purchase invoice or a receipt. The payload's
//!   `entity_type` says which when it names one; otherwise the document is
//!   read back as a purchase invoice, then as a receipt.
//! - `payment_*`: the payment. The sales invoice or document it belongs to is
//!   read back (what is paid, and its state, changed), and so is the bank line
//!   it was linked to.
//! - `financial_statement_*`: the statement. Its lines are the bank lines;
//!   Moneybird has no event of their own.
//!
//! Payments on external sales invoices (what WeldBooks itself sends to
//! Moneybird) and VAT documents, and documents WeldBooks doesn't import
//! (typeless, general journal), are left alone.

use serde_json::Value;
use weldsuite_ports::OutboundHttp;

use crate::clients::{ConnectorError, as_text};
use crate::moneybird::Moneybird;

/// `MoneybirdDeliveryTarget`.
#[derive(Debug, Clone, PartialEq)]
pub struct DeliveryTarget {
    pub sync_name: &'static str,
    pub records: Vec<Value>,
    pub force_deleted: bool,
}

const PURCHASE_INVOICES: &str = "moneybird-purchase-invoices";
const RECEIPTS: &str = "moneybird-receipts";
const SALES_INVOICES: &str = "moneybird-sales-invoices";
const MUTATIONS: &str = "moneybird-financial-mutations";

/// `idOf(value)`: Moneybird ids are digits; anything else is not put into a
/// request path (`/^[A-Za-z0-9_-]{1,64}$/`).
fn id_of(value: Option<&Value>) -> Option<String> {
    let text = match value? {
        Value::String(text) => text.clone(),
        number @ Value::Number(_) => as_text(number),
        _ => return None,
    };
    let id = weldsuite_kit::validation::js_trim(&text);
    let safe = (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    safe.then(|| id.to_owned())
}

/// What `documentSyncFromType(entityType)` says.
enum DocumentKind {
    Sync(&'static str),
    /// A document WeldBooks doesn't import.
    Other,
}

/// `documentSyncFromType(entityType)`: `None` when it doesn't say.
fn document_sync_from_type(entity_type: Option<&Value>) -> Option<DocumentKind> {
    let kind: String = entity_type?
        .as_str()?
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_lowercase)
        .collect();
    if kind.ends_with("purchaseinvoice") {
        Some(DocumentKind::Sync(PURCHASE_INVOICES))
    } else if kind.ends_with("receipt") {
        Some(DocumentKind::Sync(RECEIPTS))
    } else if kind.ends_with("typelessdocument") || kind.ends_with("generaljournaldocument") {
        Some(DocumentKind::Other)
    } else {
        None
    }
}

fn target(sync_name: &'static str, records: Vec<Value>, force_deleted: bool) -> DeliveryTarget {
    DeliveryTarget {
        sync_name,
        records,
        force_deleted,
    }
}

/// `readDocument(client, id, wants)`: read back as a purchase invoice, else
/// as a receipt; `None` when it is neither, or not imported.
async fn read_document(
    client: &Moneybird,
    http: Option<&OutboundHttp>,
    id: &str,
    wants: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Option<DeliveryTarget>, ConnectorError> {
    if !wants(PURCHASE_INVOICES) && !wants(RECEIPTS) {
        return Ok(None);
    }
    if let Some(invoice) = client.get_purchase_invoice(http, id).await? {
        return Ok(
            wants(PURCHASE_INVOICES).then(|| target(PURCHASE_INVOICES, vec![invoice], false))
        );
    }
    let receipt = client.get_receipt(http, id).await?;
    Ok(receipt
        .filter(|_| wants(RECEIPTS))
        .map(|receipt| target(RECEIPTS, vec![receipt], false)))
}

async fn document_targets(
    client: &Moneybird,
    http: Option<&OutboundHttp>,
    payload: &Value,
    entity: &Value,
    kind: &str,
    wants: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Vec<DeliveryTarget>, ConnectorError> {
    let hinted = match document_sync_from_type(payload.get("entity_type")) {
        Some(DocumentKind::Other) => return Ok(Vec::new()),
        Some(DocumentKind::Sync(sync)) => Some(sync),
        None => None,
    };
    if kind == "delete" {
        // Gone from Moneybird: removed under whichever kind WeldBooks has it as.
        let syncs = hinted.map_or_else(|| vec![PURCHASE_INVOICES, RECEIPTS], |sync| vec![sync]);
        return Ok(syncs
            .into_iter()
            .filter(|sync| wants(sync))
            .map(|sync| target(sync, vec![entity.clone()], true))
            .collect());
    }
    if let Some(sync) = hinted {
        return Ok(if wants(sync) {
            vec![target(sync, vec![entity.clone()], false)]
        } else {
            Vec::new()
        });
    }
    let Some(id) = id_of(entity.get("id")).or_else(|| id_of(payload.get("entity_id"))) else {
        return Ok(Vec::new());
    };
    Ok(read_document(client, http, &id, wants)
        .await?
        .into_iter()
        .collect())
}

async fn payment_targets(
    client: &Moneybird,
    http: Option<&OutboundHttp>,
    entity: &Value,
    wants: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Vec<DeliveryTarget>, ConnectorError> {
    let kind = entity.get("invoice_type").and_then(Value::as_str);
    if kind != Some("SalesInvoice") && kind != Some("Document") {
        return Ok(Vec::new());
    }
    let mut targets = Vec::new();
    if let Some(invoice_id) = id_of(entity.get("invoice_id")) {
        if kind == Some("SalesInvoice") {
            if wants(SALES_INVOICES)
                && let Some(invoice) = client.get_sales_invoice(http, &invoice_id).await?
            {
                targets.push(target(SALES_INVOICES, vec![invoice], false));
            }
        } else if let Some(found) = read_document(client, http, &invoice_id, wants).await? {
            targets.push(found);
        }
    }
    if let Some(mutation_id) = id_of(entity.get("financial_mutation_id"))
        && wants(MUTATIONS)
    {
        let mutations = client.get_financial_mutations(http, &[mutation_id]).await?;
        if !mutations.is_empty() {
            targets.push(target(MUTATIONS, mutations, false));
        }
    }
    Ok(targets)
}

fn statement_targets(
    entity: &Value,
    kind: &str,
    wants: &(dyn Fn(&str) -> bool + Sync),
) -> Vec<DeliveryTarget> {
    if !wants(MUTATIONS) {
        return Vec::new();
    }
    let account_id = entity
        .get("financial_account_id")
        .filter(|id| !id.is_null());
    let records: Vec<Value> = entity
        .get("financial_mutations")
        .and_then(Value::as_array)
        .map(|lines| {
            lines
                .iter()
                .filter(|line| line.is_object())
                .map(|line| {
                    let mut line = line.clone();
                    let missing = line.get("financial_account_id").is_none_or(Value::is_null);
                    if let (true, Some(account_id), Some(map)) =
                        (missing, account_id, line.as_object_mut())
                    {
                        map.insert("financial_account_id".to_owned(), account_id.clone());
                    }
                    line
                })
                .collect()
        })
        .unwrap_or_default();
    if records.is_empty() {
        return Vec::new();
    }
    vec![target(MUTATIONS, records, kind == "delete")]
}

/// `moneybirdDeliveryTargets(...)`: what a routed Moneybird delivery imports,
/// per sync; Moneybird is read only for syncs the connection imports
/// (`wants`). Empty: nothing to import.
pub async fn delivery_targets(
    client: &Moneybird,
    http: Option<&OutboundHttp>,
    topic: &str,
    kind: &str,
    payload: &Value,
    entity: &Value,
    wants: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Vec<DeliveryTarget>, ConnectorError> {
    if topic.starts_with("document_") {
        document_targets(client, http, payload, entity, kind, wants).await
    } else if topic.starts_with("payment_") {
        payment_targets(client, http, entity, wants).await
    } else if topic.starts_with("financial_statement_") {
        Ok(statement_targets(entity, kind, wants))
    } else {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn ids_and_document_kinds() {
        assert_eq!(id_of(Some(&json!(" 116015 "))).as_deref(), Some("116015"));
        assert_eq!(id_of(Some(&json!(42))).as_deref(), Some("42"));
        assert_eq!(id_of(Some(&json!("../contacts"))), None);
        assert_eq!(id_of(Some(&json!(""))), None);
        assert!(matches!(
            document_sync_from_type(Some(&json!("PurchaseInvoice"))),
            Some(DocumentKind::Sync(PURCHASE_INVOICES))
        ));
        assert!(matches!(
            document_sync_from_type(Some(&json!("Documents::Receipt"))),
            Some(DocumentKind::Sync(RECEIPTS))
        ));
        assert!(matches!(
            document_sync_from_type(Some(&json!("TypelessDocument"))),
            Some(DocumentKind::Other)
        ));
        assert!(document_sync_from_type(Some(&json!("Document"))).is_none());
    }

    #[test]
    fn statement_lines_take_the_statement_account() {
        let entity = json!({
            "id": "fs1",
            "financial_account_id": "fa1",
            "financial_mutations": [
                { "id": "m1", "amount": "1.0" },
                { "id": "m2", "amount": "2.0", "financial_account_id": "fa2" },
                "junk",
            ],
        });
        let all = |_: &str| true;
        let targets = statement_targets(&entity, "create", &all);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].sync_name, MUTATIONS);
        assert_eq!(
            targets[0]
                .records
                .iter()
                .map(|r| r["financial_account_id"].clone())
                .collect::<Vec<_>>(),
            vec![json!("fa1"), json!("fa2")]
        );
        assert!(statement_targets(&entity, "delete", &all)[0].force_deleted);
        assert_eq!(
            statement_targets(&entity, "create", &|_: &str| false),
            Vec::new()
        );
    }
}
