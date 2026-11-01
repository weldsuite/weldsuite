//! Recording finalized documents with a provider engine (Stripe Tax,
//! Avalara) (`services/sales-tax/provider-sync.ts`): an invoice is committed
//! after it posts, a credit memo reversed against the committed invoice. A
//! failure never rolls anything back: it is kept in `tax_warnings`
//! (`commit_failed`, `reverse_failed`, …) and retried by `POST
//! /api/invoices/:id/commit-tax`.
//!
//! The provider calls themselves come with the sales-tax area's engines
//! ([`weldsuite_books_domain::sales_tax::document_tax`]); until then a sync
//! that reaches them records `commit_failed` / `reverse_failed` with the
//! engine's "not available" message. Entities without a provider engine (all
//! but US ones with Stripe Tax or Avalara) answer `not_applicable`, as in
//! TypeScript.

use serde_json::{Value, json};
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::sales_tax::document_tax::{
    Runtime, load_sales_tax_entity, uses_sales_tax,
};
use weldsuite_books_domain::sales_tax::errors::DocumentError;
use weldsuite_books_domain::tables::INVOICES;
use weldsuite_books_domain::tax::TaxError;
use weldsuite_db::PgPool;

use crate::finalize::load_invoice;
use crate::persist::{merge_sync_warning, owned, text};

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
    _runtime: &Runtime,
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
    // The provider engines are the sales-tax area's: until they are ported the
    // call fails as an unreachable provider would.
    let message = "the US sales tax engine is not available in this edition yet";
    let credit_memo = text(&invoice, "type") == Some("credit_note");
    let warning = format!(
        "{}: {message}",
        if credit_memo {
            "reverse_failed"
        } else {
            "commit_failed"
        }
    );
    let at = now();
    let mut set = serde_json::Map::new();
    set.insert(
        "taxWarnings".into(),
        Value::Array(merge_sync_warning(
            invoice.get("taxWarnings"),
            Some(warning.clone()),
        )),
    );
    set.insert("updatedAt".into(), json!(at));
    INVOICES
        .patch_raw(db, invoice_id, INVOICES.values(&set), false)
        .await?;
    Ok(ProviderSync {
        status: "failed",
        reference: None,
        warning: Some(warning),
    })
}
