//! OCR on arrival, the `books-ocr` consumer of `weldsuite consume` (Rust only,
//! edition feature `books-receipts`; ADR EVT-001's event hub, the same way as
//! the Moneybird sync is a consumer of its own).
//!
//! `autoScanEnabled` is set when an accounting inbox is registered and was
//! read by nothing. This reads it: a consumer of `accounting_document:created`
//! (published by an upload and by the inbound mail fan-out) reads the new
//! document with the same read, credit charge and result as
//! `POST /api/accounting-documents/:id/process`
//! ([`crate::accounting_documents::scan_on_arrival`]).
//!
//! - **After the document exists, off the request:** the upload and the
//!   inbound mail path only publish the event; the model call runs here.
//! - **Idempotent:** one conditional write takes the document, so a
//!   redelivery or a person's own scan never reads (or charges) it twice.
//! - **No tenant fan-out on a timer** (DATA-008): each event wakes only the
//!   workspace that produced it.
//! - **A failure:** a provider or database error is retried by the consumer
//!   (the document goes back to `pending`); a refusal of the file or of the
//!   credits marks it `failed` and is not retried.

use std::sync::Arc;

use weldsuite_books_domain::http::{BooksState, Caller};
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition};
use weldsuite_subscribers::event::HubEvent;
use weldsuite_subscribers::tenants::{TenantError, Tenants};

use crate::accounting_documents::{Scan, scan_on_arrival};

/// The hub topics this consumer reads.
pub const BOOKS_OCR_TOPICS: &[&str] = &["accounting_document:created"];

/// The user the read and its credit charge are made as.
const SYSTEM_USER: &str = "system";

/// The `books-ocr` subscriber: `state` carries the AI, the file buckets and
/// the master database; `tenants` finds the workspace of each event.
pub struct OcrOnArrivalSubscriber {
    tenants: Arc<dyn Tenants>,
    state: BooksState,
}

impl OcrOnArrivalSubscriber {
    pub fn new(tenants: Arc<dyn Tenants>, state: BooksState) -> Self {
        Self { tenants, state }
    }

    async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        let Ok(event) = HubEvent::parse(&delivery.payload) else {
            return Disposition::Ack;
        };
        if event.event_type != "accounting_document:created" || event.entity_id.is_empty() {
            return Disposition::Ack;
        }
        let tenant = match self.tenants.tenant(&event.metadata.workspace_id).await {
            Ok(tenant) => tenant,
            // A workspace that is gone has nothing to read.
            Err(TenantError::NotFound) => return Disposition::Ack,
            Err(error) => return Disposition::retry(format!("workspace: {error}")),
        };
        let caller = Caller::in_process(
            tenant.db.clone(),
            &tenant.workspace_id,
            tenant
                .clerk_org_id
                .as_deref()
                .unwrap_or(tenant.workspace_id.as_str()),
            SYSTEM_USER,
            "",
            None,
        );
        match scan_on_arrival(&caller, &self.state, &event.entity_id).await {
            Scan::Skipped(reason) => {
                tracing::debug!(document = %event.entity_id, reason, "[books-ocr] skipped");
                Disposition::Ack
            }
            Scan::Done => {
                tracing::info!(document = %event.entity_id, "[books-ocr] read on arrival");
                Disposition::Ack
            }
            Scan::Failed(message) => {
                tracing::warn!(document = %event.entity_id, message, "[books-ocr] could not read");
                Disposition::Ack
            }
            Scan::Retry(message) => Disposition::retry(message),
        }
    }
}

impl BatchHandler for OcrOnArrivalSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            for delivery in batch {
                out.push(self.handle_one(delivery).await);
            }
            out
        })
    }
}
