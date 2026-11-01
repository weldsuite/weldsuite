//! Recording finalized documents with a provider engine (Stripe Tax,
//! Avalara) (`services/sales-tax/provider-sync.ts`): an invoice is committed
//! after it posts, a credit memo reversed against the committed invoice. A
//! failure never rolls anything back: it is kept in `tax_warnings`
//! (`commit_failed`, `reverse_failed`, …) and retried by `POST
//! /api/invoices/:id/commit-tax`.
//!
//! The provider calls are the sales-tax area's engines
//! ([`weldsuite_books_domain::sales_tax`]): Stripe Tax and Avalara through
//! the outbound HTTP port. Entities without a provider engine (the manual
//! engine, every non-US entity) answer `not_applicable`, as in TypeScript.

use serde_json::{Value, json};
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::sales_tax::document_tax::{
    CreditLine, OriginalLine, Runtime, SalesTaxEntity, TaxItem, build_stored_request,
    load_sales_tax_entity, map_credit_items_to_original, uses_sales_tax,
};
use weldsuite_books_domain::sales_tax::errors::DocumentError;
use weldsuite_books_domain::sales_tax::load::{LoadOptions, load_sales_tax_context};
use weldsuite_books_domain::sales_tax::{ReverseLine, SalesTaxResult};
use weldsuite_books_domain::tables::INVOICES;
use weldsuite_books_domain::tax::TaxError;
use weldsuite_db::PgPool;

use weldsuite_books_domain::books_row;

use crate::finalize::{load_invoice, load_items};
use crate::persist::{invoice_document_context, merge_sync_warning, owned, text};

/// `ProviderSyncResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderSync {
    /// `committed` | `reversed` | `already_synced` | `not_applicable` | `failed`.
    pub status: &'static str,
    pub reference: Option<String>,
    pub warning: Option<String>,
}

impl ProviderSync {
    fn status(status: &'static str) -> Self {
        Self {
            status,
            reference: None,
            warning: None,
        }
    }

    /// As JSON (`ref` and `warning` left out when undefined).
    pub(crate) fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("status".into(), json!(self.status));
        if let Some(reference) = &self.reference {
            out.insert("ref".into(), json!(reference));
        }
        if let Some(warning) = &self.warning {
            out.insert("warning".into(), json!(warning));
        }
        Value::Object(out)
    }
}

/// `syncInvoiceWithProvider(db, invoiceId, runtime)`.
pub(crate) async fn sync_invoice_with_provider(
    db: &PgPool,
    invoice_id: &str,
    runtime: &Runtime,
) -> Result<ProviderSync, TaxError> {
    let Some(invoice) = load_invoice(db, invoice_id).await? else {
        return Err(TaxError::SalesTax(
            DocumentError::new("TAX_COMMIT_NOT_APPLICABLE", "Invoice not found").into(),
        ));
    };
    let entity = load_sales_tax_entity(db, text(&invoice, "entityId").unwrap_or_default()).await?;
    if !uses_sales_tax(entity.as_ref())
        || !weldsuite_books_domain::js::truthy(invoice.get("taxEngine"))
    {
        return Ok(ProviderSync::status("not_applicable"));
    }
    if !weldsuite_books_domain::js::truthy(invoice.get("journalEntryId")) {
        return Err(TaxError::SalesTax(
            DocumentError::new(
                "TAX_COMMIT_NOT_APPLICABLE",
                "Only a finalized invoice can be recorded with the tax provider.",
            )
            .into(),
        ));
    }
    if weldsuite_books_domain::js::truthy(invoice.get("taxCommittedAt")) {
        return Ok(ProviderSync {
            status: "already_synced",
            reference: owned(&invoice, "taxEngineRef"),
            warning: None,
        });
    }
    let Some(entity) = entity else {
        return Ok(ProviderSync::status("not_applicable"));
    };
    let items = load_items(db, invoice_id, false).await?;
    let credit_memo = text(&invoice, "type") == Some("credit_note");
    // Anything that goes wrong is kept on the invoice, never thrown.
    let outcome = provider_call(db, &invoice, &items, &entity, runtime, credit_memo).await;
    match outcome {
        Ok(Outcome::Done(sync)) => Ok(sync),
        Ok(Outcome::Recorded(reference, status)) => {
            record_outcome(db, &invoice, Ok(reference.clone())).await?;
            Ok(ProviderSync {
                status,
                reference: Some(reference),
                warning: None,
            })
        }
        Ok(Outcome::Skipped(warning)) => {
            record_outcome(db, &invoice, Err(warning.clone())).await?;
            Ok(ProviderSync {
                status: "failed",
                reference: None,
                warning: Some(warning),
            })
        }
        Err(failure) => {
            let unsupported = credit_memo && failure.invalid_request;
            let warning = format!(
                "{}: {}",
                if unsupported {
                    "reverse_unsupported"
                } else if credit_memo {
                    "reverse_failed"
                } else {
                    "commit_failed"
                },
                failure.message
            );
            record_outcome(db, &invoice, Err(warning.clone())).await?;
            Ok(ProviderSync {
                status: "failed",
                reference: None,
                warning: Some(warning),
            })
        }
    }
}

/// What a provider call came to.
enum Outcome {
    /// Nothing to record (`not_applicable`).
    Done(ProviderSync),
    /// The provider's reference, with the status (`committed`, `reversed`).
    Recorded(String, &'static str),
    /// A warning recorded without a call (`reverse_skipped`).
    Skipped(String),
}

/// A failure inside the sync's `try`: its message, and whether it is the
/// engine's `invalid_request`.
struct Failure {
    message: String,
    invalid_request: bool,
}

impl From<TaxError> for Failure {
    fn from(error: TaxError) -> Self {
        use weldsuite_books_domain::sales_tax::errors::SalesTaxError;
        match error {
            TaxError::SalesTax(SalesTaxError::Engine(e)) => Self {
                invalid_request: e.code == "invalid_request",
                message: e.message,
            },
            TaxError::SalesTax(SalesTaxError::Document(e)) => Self {
                message: e.message,
                invalid_request: false,
            },
            TaxError::SalesTax(SalesTaxError::Setup(e)) => Self {
                message: e.message,
                invalid_request: false,
            },
            other => Self {
                message: other.to_string(),
                invalid_request: false,
            },
        }
    }
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self {
            message: error.to_string(),
            invalid_request: false,
        }
    }
}

impl From<weldsuite_books_domain::sales_tax::errors::EngineError> for Failure {
    fn from(error: weldsuite_books_domain::sales_tax::errors::EngineError) -> Self {
        Self {
            invalid_request: error.code == "invalid_request",
            message: error.message,
        }
    }
}

/// The line of a stored invoice as the US calculation reads it.
fn us_item(item: &Value) -> TaxItem {
    TaxItem {
        id: owned(item, "id").unwrap_or_default(),
        description: owned(item, "description"),
        quantity: Some(owned(item, "quantity").unwrap_or_else(|| "1".into())),
        unit_price: owned(item, "unitPrice").unwrap_or_default(),
        discount_percent: Some(owned(item, "discountPercent").unwrap_or_else(|| "0".into())),
        sort_order: item.get("sortOrder").and_then(Value::as_f64),
        product_id: owned(item, "productId"),
        tax_code: owned(item, "taxCode"),
        tax_use: owned(item, "taxUse"),
        tax_included: item.get("taxIncluded").and_then(Value::as_bool),
        tax_override_amount: owned(item, "taxOverrideAmount"),
        tax_override_reason: owned(item, "taxOverrideReason"),
        ..TaxItem::default()
    }
}

/// The `try` of `syncInvoiceWithProvider`: commit an invoice, or reverse a
/// credit memo against its committed invoice.
async fn provider_call(
    db: &PgPool,
    invoice: &Value,
    items: &[Value],
    entity: &SalesTaxEntity,
    runtime: &Runtime,
    credit_memo: bool,
) -> Result<Outcome, Failure> {
    let ctx = load_sales_tax_context(
        db,
        &entity.id,
        LoadOptions {
            keyring: Some(&runtime.keyring),
            http: runtime.http.as_ref(),
        },
    )
    .await
    .map_err(|e| Failure::from(TaxError::from(e)))?;
    if !ctx.engine.can_commit() {
        return Ok(Outcome::Done(ProviderSync::status("not_applicable")));
    }
    if credit_memo {
        return reverse_credit_memo(db, invoice, items, &ctx.engine).await;
    }
    let tax_items: Vec<TaxItem> = items.iter().map(us_item).collect();
    let (request, _) = build_stored_request(
        db,
        entity,
        &invoice_document_context(invoice),
        &tax_items,
        Some(runtime),
    )
    .await?;
    let result = SalesTaxResult {
        engine: ctx.engine_id.to_owned(),
        engine_ref: owned(invoice, "taxEngineRef"),
        calculated_at: owned(invoice, "taxCalculatedAt").unwrap_or_else(now),
        sourcing: "none",
        ship_to_state: None,
        ship_to_postal_code: None,
        lines: Vec::new(),
        total_tax: weldsuite_books_domain::js::parse_float(
            text(invoice, "taxTotal").unwrap_or("0"),
        ),
        warnings: Vec::new(),
    };
    let Some(committed) = ctx.engine.commit(&request, &result).await else {
        return Ok(Outcome::Done(ProviderSync::status("not_applicable")));
    };
    Ok(Outcome::Recorded(committed?, "committed"))
}

/// `reverseCreditMemo(db, invoice, items, reverse)`.
async fn reverse_credit_memo(
    db: &PgPool,
    invoice: &Value,
    items: &[Value],
    engine: &weldsuite_books_domain::sales_tax::Engine,
) -> Result<Outcome, Failure> {
    let original = match text(invoice, "creditNoteForInvoiceId").filter(|i| !i.is_empty()) {
        Some(id) => {
            let row: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                books_row!(invoices),
                " from invoices t where t.id = $1 limit 1"
            ))
            .bind(id)
            .fetch_optional(db)
            .await?;
            row.map(|row| INVOICES.js(row))
        }
        None => None,
    };
    let committed = original.as_ref().and_then(|o| {
        let at = o.get("taxCommittedAt").filter(|v| !v.is_null());
        let reference = text(o, "taxEngineRef").filter(|r| !r.is_empty());
        at.and(reference).map(str::to_owned)
    });
    let (Some(original), Some(reference)) = (original, committed) else {
        return Ok(Outcome::Skipped(
            "reverse_skipped: the original invoice was not recorded with the tax provider, so there is nothing to credit there".to_owned(),
        ));
    };
    let original_items = load_items(db, text(&original, "id").unwrap_or_default(), false).await?;
    let lines = reverse_lines_for(items, &original_items, invoice.get("taxBreakdown"));
    if lines.is_empty() {
        return Ok(Outcome::Done(ProviderSync::status("not_applicable")));
    }
    let document_number = text(invoice, "invoiceNumber")
        .filter(|n| !n.is_empty())
        .or_else(|| text(invoice, "id"))
        .unwrap_or_default()
        .to_owned();
    let date: String = text(invoice, "issueDate")
        .unwrap_or("")
        .chars()
        .take(10)
        .collect();
    let Some(reversed) = engine
        .reverse(&reference, &lines, &document_number, &date)
        .await
    else {
        return Ok(Outcome::Done(ProviderSync::status("not_applicable")));
    };
    Ok(Outcome::Recorded(reversed?, "reversed"))
}

/// `reverseLinesFor(creditItems, originalItems, breakdown)`: per original
/// line, the credited net and tax.
fn reverse_lines_for(
    credit_items: &[Value],
    original_items: &[Value],
    breakdown: Option<&Value>,
) -> Vec<ReverseLine> {
    let credits: Vec<CreditLine<'_>> = credit_items
        .iter()
        .map(|i| CreditLine {
            id: text(i, "id").unwrap_or_default(),
            description: text(i, "description"),
            unit_price: text(i, "unitPrice").unwrap_or_default(),
            sort_order: i.get("sortOrder").and_then(Value::as_f64),
            original_line_id: None,
        })
        .collect();
    let originals: Vec<OriginalLine<'_>> = original_items
        .iter()
        .map(|i| OriginalLine {
            id: text(i, "id").unwrap_or_default(),
            description: text(i, "description"),
            unit_price: text(i, "unitPrice").unwrap_or_default(),
            sort_order: i.get("sortOrder").and_then(Value::as_f64),
        })
        .collect();
    let mapping = map_credit_items_to_original(&credits, &originals);
    let rows: Vec<Value> = breakdown
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let number = |row: &Value, key: &str| weldsuite_books_domain::js::js_number_value(row.get(key));
    let or_zero = |row: &Value, key: &str| match row.get(key) {
        None | Some(Value::Null) => 0.0,
        value => weldsuite_books_domain::js::js_number_value(value),
    };
    let mut out: Vec<ReverseLine> = Vec::new();
    for item in credit_items {
        let id = text(item, "id").unwrap_or_default();
        let Some(original) = mapping
            .iter()
            .find(|(c, _)| c == id)
            .and_then(|(_, o)| o.clone())
        else {
            continue;
        };
        let lines: Vec<&Value> = rows
            .iter()
            .filter(|r| text(r, "lineId") == Some(id))
            .collect();
        let Some(first) = lines.first() else {
            continue;
        };
        let net = number(first, "taxableAmount")
            + or_zero(first, "exemptAmount")
            + or_zero(first, "nonTaxableAmount");
        let tax = lines.iter().fold(0.0, |s, r| s + number(r, "taxAmount"));
        match out.iter_mut().find(|l| l.line_id == original) {
            Some(line) => {
                line.amount += net;
                line.tax += tax;
            }
            None => out.push(ReverseLine {
                line_id: original,
                amount: net,
                tax,
            }),
        }
    }
    let round = |v: f64| weldsuite_books_domain::js::math_round(v * 100.0) / 100.0;
    out.into_iter()
        .map(|l| ReverseLine {
            amount: round(l.amount),
            tax: round(l.tax),
            ..l
        })
        .collect()
}

/// `recordOutcome(db, invoiceId, existingWarnings, outcome)`.
async fn record_outcome(
    db: &PgPool,
    invoice: &Value,
    outcome: Result<String, String>,
) -> Result<(), TaxError> {
    let at = now();
    let mut set = serde_json::Map::new();
    match outcome {
        Ok(reference) => {
            set.insert("taxEngineRef".into(), json!(reference));
            set.insert("taxCommittedAt".into(), json!(at));
            set.insert(
                "taxWarnings".into(),
                Value::Array(merge_sync_warning(invoice.get("taxWarnings"), None)),
            );
        }
        Err(warning) => {
            set.insert(
                "taxWarnings".into(),
                Value::Array(merge_sync_warning(
                    invoice.get("taxWarnings"),
                    Some(warning),
                )),
            );
        }
    }
    set.insert("updatedAt".into(), json!(at));
    INVOICES
        .patch_raw(
            db,
            text(invoice, "id").unwrap_or_default(),
            INVOICES.values(&set),
            false,
        )
        .await?;
    Ok(())
}
