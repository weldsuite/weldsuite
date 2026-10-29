//! Finishing a request once every signer has signed (ADR SIGN-003,
//! `packages/domains/sign/src/{finalize,finalize-envelope}.ts` and sign-api's
//! `FinalizeEnvelopeWorkflow`):
//!
//! 1. [`build_final_pdf`]: every document with all values drawn in, in
//!    order, then the certificate of completion; stored in the private
//!    bucket with its SHA-256; the request marked completed.
//! 2. [`notify_completed`]: links limited to downloading for 30 days, fresh
//!    download links for signers and copy recipients, and the "everyone
//!    signed" email to all of them and to the sender.
//! 3. `sign_envelope:completed`.
//! 4. Filing a copy in WeldDrive and on the CRM record (`crate::filing`).
//!
//! [`FinalizeJob`] runs them as separately retried steps of the
//! `sign.finalize` job (one run per envelope: key `finalize-<envelopeId>`,
//! as the Workflow instance id); each step is idempotent, so a failed email
//! never rebuilds the PDF and a filing problem holds back nothing.
//! [`finalize_request`] runs them in one go, the fallback without a jobs
//! adapter. The signer portal (`crate::portal`) starts it with [`start_finalize`]
//! when the last signer finishes.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::SIGN_ENVELOPE_COMPLETED;
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::{EntityEvent, EventContext, EventSource, iso_timestamp};
use weldsuite_ports::{
    BoxFuture, Job, JobContext, JobError, JobRequest, PutOptions, StepRetry, step,
};

use crate::envelopes::{list_documents, list_fields, list_recipients};
use crate::filing::file_signed_pdf;
use crate::links::{
    DOWNLOAD_WINDOW_DAYS, LinkTarget, create_link, limit_links_to_download, sha256_hex,
    signing_link,
};
use crate::mail::{CompletedMail, envelope_app_url, send_completed, workspace_brand};
use crate::pdf_render::{
    CertificateDocument, CertificateInput, CertificateRecipient, OutputPdf, RenderField,
    append_certificate, draw_fields,
};
use crate::schedule::timestamp;
use crate::sending::{SignEvent, record_sign_event};
use crate::{SendContext, Services, SignError, SignResult, or_else, text};

/// The job's name (the Workflow class).
pub const FINALIZE_JOB: &str = "sign.finalize";

/// `SIGN_DISCLOSURE_VERSION`: the electronic-signature disclosure signers agree to.
pub(crate) const DISCLOSURE_VERSION: &str = "2026-10-24";

/// What the job is started with (`FinalizeEnvelopeParams`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeParams {
    /// Clerk org id: storage prefix, tenant, events.
    pub clerk_org_id: String,
    /// Master `workspaces.id` (link registry).
    pub workspace_id: String,
    pub envelope_id: String,
}

/// Start the `sign.finalize` job for one envelope; one run per envelope.
pub fn start_finalize(params: &FinalizeParams) -> Result<JobRequest, weldsuite_ports::PortError> {
    JobRequest::new(
        FINALIZE_JOB,
        format!("finalize-{}", params.envelope_id),
        params,
    )
}

/// A workspace's tenant database, found by its id or Clerk org id.
pub struct TenantRef {
    pub db: PgPool,
    pub workspace_id: String,
    pub clerk_org_id: Option<String>,
}

/// Opens tenant databases outside a request: the bin hands in its
/// `Workspaces`; conformance hands in the test's database.
pub trait TenantResolver: Send + Sync {
    fn tenant<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<TenantRef, String>>;
}

/// `finalKey(workspaceId, envelopeId)`.
fn final_key(clerk_org_id: &str, envelope_id: &str) -> String {
    format!("workspaces/{clerk_org_id}/weldsign/{envelope_id}/final.pdf")
}

async fn envelope_row(db: &PgPool, id: &str) -> SignResult<Option<Value>> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(e) from sign_envelopes e where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

fn storage(ctx: &SendContext) -> SignResult<weldsuite_ports::FileStores> {
    ctx.services
        .files
        .clone()
        .ok_or_else(|| SignError::Internal("sign: no file storage".to_owned()))
}

/// What the build step hands on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuiltPdf {
    pub sha256: String,
    pub key: String,
}

/// `toRenderFields`: the filled fields, with their images.
async fn render_fields(ctx: &SendContext, fields: &[&Value]) -> SignResult<Vec<RenderField>> {
    let files = storage(ctx)?;
    let mut out = Vec::new();
    for field in fields.iter().filter(|f| !f["filledAt"].is_null()) {
        let image = match field["signatureKey"].as_str() {
            Some(key) => files
                .private
                .get_boxed(key)
                .await
                .map_err(|e| SignError::Internal(e.to_string()))?
                .map(|object| object.bytes),
            None => None,
        };
        out.push(RenderField {
            page: usize::try_from(field["page"].as_u64().unwrap_or(0)).unwrap_or(0),
            x: field["x"].as_f64().unwrap_or(0.0),
            y: field["y"].as_f64().unwrap_or(0.0),
            width: field["width"].as_f64().unwrap_or(0.0),
            height: field["height"].as_f64().unwrap_or(0.0),
            kind: text(field, "type").to_owned(),
            value: field["value"].as_str().map(str::to_owned),
            image,
        });
    }
    Ok(out)
}

fn opt(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// Every document with its fields drawn in, in order, in a new PDF.
async fn drawn_documents(
    ctx: &SendContext,
    documents: &[Value],
    fields: &[Value],
) -> SignResult<OutputPdf> {
    let files = storage(ctx)?;
    let mut out = OutputPdf::new();
    for doc in documents {
        let original = files
            .private
            .get_boxed(text(doc, "storageKey"))
            .await
            .map_err(|e| SignError::Internal(e.to_string()))?
            .ok_or_else(|| {
                SignError::Internal(format!(
                    "Original of document {} is missing",
                    text(doc, "id")
                ))
            })?;
        let mut pdf = lopdf::Document::load_mem(&original.bytes)
            .map_err(|e| SignError::Internal(format!("pdf: {e}")))?;
        let own: Vec<&Value> = fields
            .iter()
            .filter(|f| f["documentId"] == doc["id"])
            .collect();
        draw_fields(&mut pdf, &render_fields(ctx, &own).await?)
            .map_err(|e| SignError::Internal(e.to_string()))?;
        out.append_document(pdf)
            .map_err(|e| SignError::Internal(e.to_string()))?;
    }
    Ok(out)
}

/// The recipients as the certificate shows them. The latest event of each
/// kind counts: after a corrected email, the new person consented and
/// signed again.
fn certificate_recipients(recipients: &[Value], events: &[Value]) -> Vec<CertificateRecipient> {
    let event_at = |recipient: &str, kind: &str| {
        events
            .iter()
            .rfind(|e| e["recipientId"] == recipient && e["type"] == kind)
    };
    recipients
        .iter()
        .map(|r| {
            let id = text(r, "id");
            CertificateRecipient {
                name: opt(&r["name"]),
                email: opt(&r["email"]),
                role: text(r, "role").to_owned(),
                auth_mode: text(r, "authMode").to_owned(),
                signature_kind: event_at(id, "signed")
                    .and_then(|e| e["details"]["signatureKind"].as_str())
                    .map(str::to_owned),
                ip: opt(&r["signedIp"]),
                user_agent: opt(&r["signedUserAgent"]),
                sent_at: opt(&r["sentAt"]),
                opened_at: opt(&r["openedAt"]),
                consented_at: event_at(id, "consented").and_then(|e| opt(&e["createdAt"])),
                signed_at: opt(&r["signedAt"]),
            }
        })
        .collect()
}

/// Build and store the signed PDF; mark the request completed. The final
/// hash and key, or `None` when there is nothing to build (`buildFinalPdf`).
pub(crate) async fn build_final_pdf(
    ctx: &SendContext,
    envelope_id: &str,
) -> SignResult<Option<BuiltPdf>> {
    let Some(envelope) = envelope_row(&ctx.db, envelope_id).await? else {
        return Ok(None);
    };
    let status = text(&envelope, "status");
    let (key, sha) = (
        text(&envelope, "finalStorageKey"),
        text(&envelope, "finalSha256"),
    );
    if status == "completed" && !key.is_empty() && !sha.is_empty() {
        return Ok(Some(BuiltPdf {
            sha256: sha.to_owned(),
            key: key.to_owned(),
        }));
    }
    if status != "sent" && status != "in_progress" {
        return Ok(None);
    }
    let documents = list_documents(&ctx.db, envelope_id).await?;
    let recipients = list_recipients(&ctx.db, envelope_id).await?;
    let fields = list_fields(&ctx.db, envelope_id).await?;
    let events: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(e) from sign_events e where envelope_id = $1 order by created_at asc",
    )
    .bind(envelope_id)
    .fetch_all(&ctx.db)
    .await?;
    let events: Vec<Value> = events.into_iter().map(js_row).collect();
    if recipients
        .iter()
        .any(|r| r["role"] == "signer" && r["status"] != "signed")
    {
        return Ok(None);
    }

    let files = storage(ctx)?;
    let mut out = drawn_documents(ctx, &documents, &fields).await?;
    let completed_at = crate::now();
    let (_, workspace_name) = workspace_brand(ctx).await?;
    let input = CertificateInput {
        envelope_id: envelope_id.to_owned(),
        title: text(&envelope, "title").to_owned(),
        sender_name: opt(&envelope["senderName"]),
        sender_email: opt(&envelope["senderEmail"]),
        workspace_name,
        sent_at: opt(&envelope["sentAt"]),
        completed_at: completed_at.clone(),
        documents: documents
            .iter()
            .map(|d| CertificateDocument {
                name: text(d, "name").to_owned(),
                page_count: d["pageCount"].as_i64().unwrap_or(0),
                sha256: text(d, "sha256").to_owned(),
            })
            .collect(),
        recipients: certificate_recipients(&recipients, &events),
        disclosure_version: DISCLOSURE_VERSION.to_owned(),
    };
    append_certificate(&mut out, &input).map_err(|e| SignError::Internal(e.to_string()))?;

    let bytes = out
        .finish(text(&envelope, "title"))
        .map_err(|e| SignError::Internal(e.to_string()))?;
    let sha256 = sha256_hex(&bytes);
    let key = final_key(&ctx.clerk_org_id, envelope_id);
    let size = bytes.len();
    files
        .private
        .put_boxed(
            &key,
            bytes,
            &PutOptions::content_type("application/pdf").with_metadata("sha256", &sha256),
        )
        .await
        .map_err(|e| SignError::Internal(e.to_string()))?;
    sqlx::query(
        "update sign_envelopes
         set status = 'completed', completed_at = $3::timestamptz, final_sha256 = $4,
             final_storage_key = $5, updated_at = $3::timestamptz
         where id = $1 and status = $2",
    )
    .bind(envelope_id)
    .bind(status)
    .bind(&completed_at)
    .bind(&sha256)
    .bind(&key)
    .execute(&ctx.db)
    .await?;
    record_sign_event(
        &ctx.db,
        SignEvent {
            envelope_id,
            kind: "completed",
            details: Some(json!({ "finalSha256": sha256, "sizeBytes": size })),
            ..SignEvent::default()
        },
    )
    .await?;
    Ok(Some(BuiltPdf { sha256, key }))
}

/// Download links and the "everyone signed" email (`notifyCompleted`).
pub(crate) async fn notify_completed(ctx: &SendContext, envelope_id: &str) -> SignResult<()> {
    let Some(envelope) = envelope_row(&ctx.db, envelope_id).await? else {
        return Ok(());
    };
    let final_key = text(&envelope, "finalStorageKey");
    if text(&envelope, "status") != "completed" || final_key.is_empty() {
        return Ok(());
    }
    let notified: Option<String> = sqlx::query_scalar(
        "select id from sign_events where envelope_id = $1 and type = 'delivered' limit 1",
    )
    .bind(envelope_id)
    .fetch_optional(&ctx.db)
    .await?;
    if notified.is_some() {
        return Ok(());
    }

    let completed_at =
        timestamp(&envelope["completedAt"]).unwrap_or_else(time::OffsetDateTime::now_utc);
    limit_links_to_download(&ctx.master, &ctx.workspace_id, envelope_id, completed_at).await?;
    let recipients = list_recipients(&ctx.db, envelope_id).await?;
    let pdf = storage(ctx)?
        .private
        .get_boxed(final_key)
        .await
        .map_err(|e| SignError::Internal(e.to_string()))?
        .ok_or_else(|| SignError::Internal(format!("Final PDF of {envelope_id} is missing")))?
        .bytes;

    let until = iso_timestamp(completed_at + time::Duration::days(DOWNLOAD_WINDOW_DAYS));
    let mut mails = Vec::new();
    for r in &recipients {
        let email = text(r, "email");
        if email.is_empty() {
            continue;
        }
        let token = create_link(
            &ctx.master,
            &LinkTarget {
                workspace_id: &ctx.workspace_id,
                clerk_org_id: &ctx.clerk_org_id,
                envelope_id,
                recipient_id: text(r, "id"),
                expires_at: Some(&until),
            },
        )
        .await?;
        mails.push(CompletedMail {
            to: email.to_owned(),
            locale: opt(&r["locale"]),
            url: Some(signing_link(ctx.services.portal_url.as_deref(), &token)),
            for_sender: false,
        });
    }
    let sender = text(&envelope, "senderEmail");
    if !sender.is_empty() && !recipients.iter().any(|r| r["email"] == sender) {
        mails.push(CompletedMail {
            to: sender.to_owned(),
            locale: Some("en".to_owned()),
            url: Some(envelope_app_url(ctx, envelope_id)),
            for_sender: true,
        });
    }
    let signers: Vec<String> = recipients
        .iter()
        .filter(|r| r["role"] == "signer")
        .map(|r| {
            or_else(&r["name"], &r["email"])
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .collect();
    send_completed(ctx, &envelope, &mails, &signers, &pdf).await?;
    record_sign_event(
        &ctx.db,
        SignEvent {
            envelope_id,
            kind: "delivered",
            details: Some(json!({ "recipients": mails.len() })),
            ..SignEvent::default()
        },
    )
    .await
}

/// `sign_envelope:completed`, from the system (`publishCompleted`).
async fn publish_completed(services: &Services, params: &FinalizeParams, sha256: &str) {
    let context = EventContext::new(&params.clerk_org_id, "system", EventSource::System);
    let data = json!({ "id": params.envelope_id, "status": "completed", "finalSha256": sha256 });
    services
        .events
        .publish_and_wait(
            &context,
            EntityEvent::new(SIGN_ENVELOPE_COMPLETED, &params.envelope_id, data),
        )
        .await;
}

/// The job's handle on the process: tenant databases, the master database
/// and the services.
#[derive(Clone)]
pub struct FinalizeJob {
    pub tenants: Arc<dyn TenantResolver>,
    pub master: PgPool,
    pub services: Services,
}

impl FinalizeJob {
    async fn context(&self, params: &FinalizeParams) -> Result<SendContext, JobError> {
        let tenant = self
            .tenants
            .tenant(&params.clerk_org_id)
            .await
            .map_err(JobError::Failed)?;
        Ok(SendContext {
            db: tenant.db,
            master: self.master.clone(),
            clerk_org_id: params.clerk_org_id.clone(),
            workspace_id: params.workspace_id.clone(),
            services: self.services.clone(),
        })
    }
}

#[allow(clippy::needless_pass_by_value, reason = "used as map_err(failed)")]
fn failed(error: SignError) -> JobError {
    JobError::Failed(format!("{error:?}"))
}

impl Job for FinalizeJob {
    fn name(&self) -> &'static str {
        FINALIZE_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: FinalizeParams = serde_json::from_value(payload)?;
            let built: Option<BuiltPdf> = step(
                ctx,
                "build signed pdf",
                StepRetry::exponential(5, Duration::from_secs(10)),
                || async {
                    let sign = self.context(&params).await?;
                    build_final_pdf(&sign, &params.envelope_id)
                        .await
                        .map_err(failed)
                },
            )
            .await?;
            let Some(built) = built else {
                return Ok(());
            };
            step(
                ctx,
                "send signed pdf",
                StepRetry::exponential(5, Duration::from_secs(30)),
                || async {
                    let sign = self.context(&params).await?;
                    notify_completed(&sign, &params.envelope_id)
                        .await
                        .map_err(failed)
                },
            )
            .await?;
            step(ctx, "publish completed", StepRetry::default(), || async {
                publish_completed(&self.services, &params, &built.sha256).await;
                Ok(())
            })
            .await?;
            // Last, and on its own: a filing problem never holds back the
            // signed PDF or its emails.
            step(
                ctx,
                "file signed pdf",
                StepRetry::exponential(5, Duration::from_secs(60)),
                || async {
                    let sign = self.context(&params).await?;
                    file_signed_pdf(&sign, &params.envelope_id)
                        .await
                        .map(|_| ())
                        .map_err(failed)
                },
            )
            .await?;
            Ok(())
        })
    }
}

/// Every step at once (`finalizeEnvelope`): for an install without a jobs
/// adapter. A filing problem is logged, not returned.
pub async fn finalize_request(job: &FinalizeJob, params: &FinalizeParams) -> Result<(), JobError> {
    let ctx = job.context(params).await?;
    let Some(built) = build_final_pdf(&ctx, &params.envelope_id)
        .await
        .map_err(failed)?
    else {
        return Ok(());
    };
    notify_completed(&ctx, &params.envelope_id)
        .await
        .map_err(failed)?;
    publish_completed(&job.services, params, &built.sha256).await;
    if let Err(error) = file_signed_pdf(&ctx, &params.envelope_id).await {
        tracing::error!(
            ?error,
            envelope_id = params.envelope_id,
            "sign: filing the signed PDF failed"
        );
    }
    Ok(())
}
