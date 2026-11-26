//! eIDAS beyond simple signatures (plan `weldsuite-documentation/plans/weldsign-eidas.md`,
//! ADRs SIGN-006 to SIGN-009). Rust only: Global keeps simple, unsealed
//! signatures (the `sign-eidas` edition feature hides all of this there).
//!
//! - **Levels** (SIGN-008): a signer's `signatureLevel` is `aes` or `qes`
//!   (unset: simple). Only levels the install's trust service offers are
//!   accepted.
//! - **The prepared PDF** (SIGN-009): a request with an AES or QES signer
//!   gets, at sending, one PDF with every document and a form field per
//!   WeldSign field (plus a signature field per AES/QES signer). Values go
//!   in as incremental revisions, so each signer's PAdES signature stays
//!   intact; the certificate of completion becomes a separate evidence
//!   report.
//! - **Credits** (SIGN-008): AES and QES signers are paid for when the
//!   request is sent, from the workspace's wallet, and given back for each
//!   one who never signs (declined, voided, expired).
//! - **The seal** (SIGN-006): after completion the signed PDF (and the
//!   evidence report) get the operator's seal, the validation material (DSS)
//!   and a document timestamp: PAdES-B-LTA when the install has a TSA.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use http::{HeaderValue, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_core_domain::credits::{Consumed, LedgerEntry, consume_credits, refund_credits};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, CreditShortfall, Data, generate_id};
use weldsuite_pades::{
    Certificate, FieldKind, Hash, Revision, SIGNATURE_SIZE, SignatureKind, SignatureSpec,
    add_validation_data, prepare_document_timestamp, prepare_signature, signing, verify_pdf,
};
use weldsuite_ports::PutOptions;
use weldsuite_schema::master::system_settings;
use weldsuite_schema::tenant::{sign_envelopes, sign_events, sign_recipients, sign_signatures};
use weldsuite_trust_services::{Level, TrustService};

use crate::envelopes::{
    json_rows, list_documents, list_fields, list_recipients, load_envelope, load_own_envelope,
    row_json, viewer_of,
};
use crate::links::sha256_hex;
use crate::pdf_render::{OutputPdf, Rect, RenderField, field_appearance, field_rect};
use crate::sending::{SignEvent, record_sign_event};
use crate::{Caller, SendContext, SignError, SignResult, SignState, answer, text};

/// `sign_envelopes.pipeline` for a request with AES or QES signers.
pub(crate) const PREPARED: &str = "prepared";
/// The staff price list in master `system_settings`: `{ "aes": n, "qes": n }` in credits.
pub const PRICING_KEY: &str = "weldsign.signature_pricing";

/// The install's eIDAS services: its trust service and default prices.
#[derive(Clone, Default)]
pub struct Eidas {
    /// `SIGN_TRUST_MODE`'s service; `None`: simple signatures only, nothing sealed.
    pub trust: Option<Arc<dyn TrustService>>,
    /// Credits per advanced signer when `system_settings` has no price list
    /// (`SIGN_AES_CREDITS`; 0 = free, as on a self-hosted install).
    pub aes_credits: i64,
    /// The same for qualified signers (`SIGN_QES_CREDITS`).
    pub qes_credits: i64,
}

impl std::fmt::Debug for Eidas {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Eidas")
            .field(
                "trust",
                &self.trust.as_ref().map(|t| t.provider().to_owned()),
            )
            .field("aes_credits", &self.aes_credits)
            .field("qes_credits", &self.qes_credits)
            .finish()
    }
}

/// A recipient's level, when above simple.
pub(crate) fn level_of(recipient: &Value) -> Option<Level> {
    recipient["signatureLevel"].as_str().and_then(Level::parse)
}

fn storage(ctx: &SendContext) -> SignResult<weldsuite_ports::FileStores> {
    ctx.services
        .files
        .clone()
        .ok_or_else(|| SignError::Internal("sign: no file storage".to_owned()))
}

fn internal(error: impl std::fmt::Display) -> SignError {
    SignError::Internal(error.to_string())
}

// ── Levels on recipients and roles ─────────────────────────────────────────

/// `signatureLevel` in a recipient or role body.
pub(crate) fn read_level(
    issues: &mut Issues,
    fields: &serde_json::Map<String, Value>,
) -> Field<String> {
    issues.choice(
        fields,
        "signatureLevel",
        Presence::Optional,
        &["ses", "aes", "qes"],
    )
}

/// What a recipient or role body does to the stored level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LevelChange {
    /// Not sent: leave it.
    Unchanged,
    /// Simple (stored as unset).
    Simple,
    /// `aes` or `qes`.
    Level(String),
}

/// What to store for a level sent with role `role`. Refuses a level the
/// install does not offer; a copy recipient is always simple.
pub(crate) fn check_level(
    level: &Field<String>,
    role: &str,
    eidas: &Eidas,
) -> SignResult<LevelChange> {
    if role == "cc" {
        return Ok(LevelChange::Simple);
    }
    let Some(level) = level.as_set() else {
        return Ok(LevelChange::Unchanged);
    };
    let Some(wanted) = Level::parse(level) else {
        return Ok(LevelChange::Simple);
    };
    let offered = eidas.trust.as_ref().is_some_and(|t| t.offers(wanted));
    if !offered {
        return Err(SignError::invalid(match wanted {
            Level::Aes => "This server does not offer advanced electronic signatures",
            Level::Qes => "This server does not offer qualified electronic signatures",
        }));
    }
    Ok(LevelChange::Level(level.clone()))
}

/// Store a checked level on a recipient row; the row as it is now.
pub(crate) async fn store_level(db: &PgPool, row: Value, change: LevelChange) -> SignResult<Value> {
    let level = match change {
        LevelChange::Unchanged => return Ok(row),
        LevelChange::Simple => None,
        LevelChange::Level(level) => Some(level),
    };
    if row["signatureLevel"].as_str() == level.as_deref() {
        return Ok(row);
    }
    let updated = sign_recipients::Entity::update_many()
        .col_expr(sign_recipients::Column::SignatureLevel, Expr::value(level))
        .filter(sign_recipients::Column::Id.eq(text(&row, "id")))
        .exec_with_returning(&orm(db))
        .await?;
    match updated.into_iter().next() {
        Some(model) => Ok(row_json(model)?),
        None => Ok(row),
    }
}

// ── Capabilities and prices ────────────────────────────────────────────────

/// Credits per signer at each level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Prices {
    pub(crate) aes: i64,
    pub(crate) qes: i64,
}

impl Prices {
    pub(crate) fn of(self, level: Level) -> i64 {
        match level {
            Level::Aes => self.aes,
            Level::Qes => self.qes,
        }
    }
}

/// The staff price list, else the install's defaults.
pub(crate) async fn prices(master: &PgPool, eidas: &Eidas) -> Prices {
    let row: Result<Option<Option<Value>>, _> = system_settings::Entity::find()
        .select_only()
        .column(system_settings::Column::Value)
        .filter(system_settings::Column::Key.eq(PRICING_KEY))
        .into_tuple()
        .one(&orm(master))
        .await;
    let listed = row.ok().flatten().flatten().unwrap_or(Value::Null);
    let price =
        |key: &str, default: i64| listed[key].as_i64().filter(|n| *n >= 0).unwrap_or(default);
    Prices {
        aes: price("aes", eidas.aes_credits.max(0)),
        qes: price("qes", eidas.qes_credits.max(0)),
    }
}

/// `GET /api/sign/capabilities`: what this install offers.
pub(crate) async fn capabilities(State(state): State<SignState>, caller: Caller) -> Response {
    answer(
        async {
            let eidas = &state.eidas;
            let mut levels = vec!["ses"];
            let (mut aes, mut qes) = (Value::Null, Value::Null);
            let trust = eidas.trust.as_ref();
            if trust.is_some_and(|t| t.offers(Level::Aes) || t.offers(Level::Qes)) {
                let ctx = caller.send_context(&state)?;
                let prices = prices(&ctx.master, eidas).await;
                if trust.is_some_and(|t| t.offers(Level::Aes)) {
                    levels.push("aes");
                    aes = json!(prices.aes);
                }
                if trust.is_some_and(|t| t.offers(Level::Qes)) {
                    levels.push("qes");
                    qes = json!(prices.qes);
                }
            }
            Ok(Data(json!({
                "seal": trust.is_some_and(|t| t.seals()),
                "levels": levels,
                "provider": trust.map(|t| t.provider().to_owned()),
                "prices": { "aes": aes, "qes": qes },
            }))
            .into_response())
        }
        .await,
    )
}

// ── Sending: the prepared PDF and the credits ──────────────────────────────

/// What sending a request with AES or QES signers set up.
#[derive(Debug, Clone)]
pub(crate) struct Prepared {
    pub(crate) key: String,
    pub(crate) sha256: String,
    pub(crate) credits: i64,
    /// Credits per recipient, for refunds.
    pub(crate) per_signer: Vec<(String, i64)>,
    /// The ledger entry's idempotency key.
    pub(crate) ledger_key: Option<String>,
}

fn prepared_key(clerk_org_id: &str, envelope_id: &str) -> String {
    format!(
        "workspaces/{clerk_org_id}/weldsign/{envelope_id}/prepared/{}.pdf",
        generate_id("rev")
    )
}

fn evidence_key(clerk_org_id: &str, envelope_id: &str) -> String {
    format!("workspaces/{clerk_org_id}/weldsign/{envelope_id}/evidence.pdf")
}

/// The form field name of a WeldSign field, and of a signer's signature.
pub(crate) fn field_name(field_id: &str) -> String {
    format!("ws_{field_id}")
}

pub(crate) fn signature_field_name(recipient_id: &str) -> String {
    format!("ws_sig_{recipient_id}")
}

/// Where each document's first page is in the merged PDF.
fn page_offsets(documents: &[Value]) -> HashMap<String, usize> {
    let mut offsets = HashMap::new();
    let mut next = 0usize;
    for doc in documents {
        offsets.insert(text(doc, "id").to_owned(), next);
        next += usize::try_from(doc["pageCount"].as_i64().unwrap_or(0)).unwrap_or(0);
    }
    offsets
}

/// Merge the originals and add a form field per WeldSign field and a
/// signature field per AES/QES signer.
async fn build_prepared(
    ctx: &SendContext,
    envelope: &Value,
    recipients: &[Value],
) -> SignResult<Vec<u8>> {
    let id = text(envelope, "id");
    let files = storage(ctx)?;
    let documents = list_documents(&ctx.db, id).await?;
    let fields = list_fields(&ctx.db, id).await?;
    let mut out = OutputPdf::new();
    for doc in &documents {
        let original = files
            .private
            .get_boxed(text(doc, "storageKey"))
            .await
            .map_err(internal)?
            .ok_or_else(|| {
                SignError::Internal(format!("Original of {} is missing", text(doc, "id")))
            })?;
        out.append_document(lopdf::Document::load_mem(&original.bytes).map_err(internal)?)
            .map_err(internal)?;
    }
    let merged = out.finish(text(envelope, "title")).map_err(internal)?;
    let offsets = page_offsets(&documents);
    let mut revision = Revision::open(merged).map_err(internal)?;
    for field in &fields {
        let Some(offset) = offsets.get(text(field, "documentId")) else {
            continue;
        };
        let page = offset + usize::try_from(field["page"].as_u64().unwrap_or(0)).unwrap_or(0);
        let rect = Rect {
            x: field["x"].as_f64().unwrap_or(0.0),
            y: field["y"].as_f64().unwrap_or(0.0),
            width: field["width"].as_f64().unwrap_or(0.0),
            height: field["height"].as_f64().unwrap_or(0.0),
        };
        let Some(rect) = field_rect(revision.document(), page, rect) else {
            continue;
        };
        let kind = if field["type"] == "checkbox" {
            FieldKind::Checkbox
        } else {
            FieldKind::Text
        };
        revision
            .add_form_field(kind, &field_name(text(field, "id")), page, rect)
            .map_err(internal)?;
    }
    for recipient in recipients.iter().filter(|r| level_of(r).is_some()) {
        revision
            .add_form_field(
                FieldKind::Signature,
                &signature_field_name(text(recipient, "id")),
                0,
                [0.0; 4],
            )
            .map_err(internal)?;
    }
    revision.write().map_err(internal)
}

/// Before a draft goes out: for AES/QES signers, the prepared PDF and the
/// credits. `None` for a simple request (nothing changes for it).
pub(crate) async fn prepare_for_send(
    ctx: &SendContext,
    envelope: &Value,
    recipients: &[Value],
) -> SignResult<Option<Prepared>> {
    let leveled: Vec<(&Value, Level)> = recipients
        .iter()
        .filter(|r| r["role"] == "signer")
        .filter_map(|r| level_of(r).map(|level| (r, level)))
        .collect();
    if leveled.is_empty() {
        return Ok(None);
    }
    let eidas = &ctx.services.eidas;
    let Some(trust) = eidas.trust.as_ref() else {
        return Err(SignError::Conflict(
            "This server does not offer advanced or qualified signatures".to_owned(),
        ));
    };
    if let Some((r, _)) = leveled.iter().find(|(_, level)| !trust.offers(*level)) {
        return Err(SignError::Conflict(format!(
            "{} asks for a signature level this server no longer offers",
            crate::or_else(&r["name"], &r["email"])
                .as_str()
                .unwrap_or_default()
        )));
    }
    let id = text(envelope, "id");
    let bytes = build_prepared(ctx, envelope, recipients).await?;
    let sha256 = sha256_hex(&bytes);
    let key = prepared_key(&ctx.clerk_org_id, id);

    let prices = prices(&ctx.master, eidas).await;
    let per_signer: Vec<(String, i64)> = leveled
        .iter()
        .map(|(r, level)| (text(r, "id").to_owned(), prices.of(*level)))
        .collect();
    let credits: i64 = per_signer.iter().map(|(_, n)| n).sum();
    let mut ledger_key = None;
    if credits > 0 {
        let key = format!("weldsign:send:{id}:{}", generate_id("try"));
        let consumed = consume_credits(
            &ctx.master,
            &LedgerEntry {
                workspace_id: &ctx.workspace_id,
                amount: credits,
                service_type: Some("weldsign"),
                idempotency_key: Some(key.clone()),
                reference_id: Some(id),
                reference_type: Some("sign_envelope"),
                description: Some(format!(
                    "WeldSign: {} advanced or qualified signature(s)",
                    per_signer.len()
                )),
                metadata: Some(json!({ "envelopeId": id, "signers": per_signer.len() })),
            },
        )
        .await
        .map_err(|e| SignError::Internal(format!("{e:?}")))?;
        if let Consumed::Insufficient {
            current_balance,
            required,
        } = consumed
        {
            #[allow(clippy::cast_precision_loss, reason = "credit counts")]
            let details = CreditShortfall {
                current_balance: Some(current_balance as f64),
                required: Some(required as f64),
                shortfall: Some((required - current_balance).max(0) as f64),
            };
            return Err(SignError::Response(Box::new(
                ApiError::insufficient_credits(Some(details)).into_response(),
            )));
        }
        ledger_key = Some(key);
    }
    let stored = storage(ctx)?
        .private
        .put_boxed(
            &key,
            bytes,
            &PutOptions::content_type("application/pdf").with_metadata("sha256", &sha256),
        )
        .await;
    if let Err(error) = stored {
        give_back(ctx, id, credits, ledger_key.as_deref()).await;
        return Err(internal(error));
    }
    Ok(Some(Prepared {
        key,
        sha256,
        credits,
        per_signer,
        ledger_key,
    }))
}

/// Give the whole charge back (sending failed after charging).
pub(crate) async fn give_back(
    ctx: &SendContext,
    envelope_id: &str,
    credits: i64,
    ledger_key: Option<&str>,
) {
    let Some(key) = ledger_key.filter(|_| credits > 0) else {
        return;
    };
    let refunded = refund_credits(
        &ctx.master,
        &LedgerEntry {
            workspace_id: &ctx.workspace_id,
            amount: credits,
            service_type: Some("weldsign"),
            idempotency_key: Some(format!("{key}:refund")),
            reference_id: Some(envelope_id),
            reference_type: Some("sign_envelope"),
            description: Some("WeldSign: request not sent".to_owned()),
            metadata: None,
        },
    )
    .await;
    if let Err(error) = refunded {
        tracing::error!(
            ?error,
            envelope_id,
            "sign: refund after a failed send failed"
        );
    }
}

/// The prepared PDF and the charge on the row, set in the same statement
/// that flips the draft to sent (so only the winner of two racing sends
/// writes them).
pub(crate) fn with_prepared(
    update: sea_orm::UpdateMany<sign_envelopes::Entity>,
    prepared: &Prepared,
) -> sea_orm::UpdateMany<sign_envelopes::Entity> {
    update
        .col_expr(sign_envelopes::Column::Pipeline, Expr::value(PREPARED))
        .col_expr(
            sign_envelopes::Column::PreparedStorageKey,
            Expr::value(&prepared.key),
        )
        .col_expr(
            sign_envelopes::Column::PreparedSha256,
            Expr::value(&prepared.sha256),
        )
        .col_expr(
            sign_envelopes::Column::CreditsReserved,
            Expr::value(i32::try_from(prepared.credits).unwrap_or(i32::MAX)),
        )
}

/// After the request went out: the charge per signer on the trail, which
/// the refunds read.
pub(crate) async fn record_prepared(
    ctx: &SendContext,
    envelope_id: &str,
    prepared: &Prepared,
) -> SignResult<()> {
    let credits: serde_json::Map<String, Value> = prepared
        .per_signer
        .iter()
        .map(|(id, n)| (id.clone(), json!(n)))
        .collect();
    record_sign_event(
        &ctx.db,
        SignEvent {
            envelope_id,
            kind: "prepared",
            details: Some(json!({
                "preparedSha256": prepared.sha256,
                "credits": credits,
                "ledgerKey": prepared.ledger_key,
            })),
            ..SignEvent::default()
        },
    )
    .await
}

/// A closed request (declined, voided, expired): give back the credits of
/// every AES/QES signer who never signed. Never fails the close; problems
/// are logged.
pub(crate) async fn refund_unsigned(ctx: &SendContext, envelope_id: &str) {
    if let Err(error) = try_refund_unsigned(ctx, envelope_id).await {
        tracing::error!(
            ?error,
            envelope_id,
            "sign: refunding unsigned signers failed"
        );
    }
}

async fn try_refund_unsigned(ctx: &SendContext, envelope_id: &str) -> SignResult<()> {
    let prepared = sign_events::Entity::find()
        .filter(sign_events::Column::EnvelopeId.eq(envelope_id))
        .filter(sign_events::Column::Type.eq("prepared"))
        .one(&orm(&ctx.db))
        .await?;
    let Some(details) = prepared.and_then(|event| event.details) else {
        return Ok(());
    };
    let Some(credits) = details["credits"].as_object() else {
        return Ok(());
    };
    let recipients = list_recipients(&ctx.db, envelope_id).await?;
    for (recipient_id, amount) in credits {
        let amount = amount.as_i64().unwrap_or(0);
        let signed = recipients
            .iter()
            .any(|r| r["id"] == recipient_id.as_str() && r["status"] == "signed");
        if amount <= 0 || signed {
            continue;
        }
        refund_credits(
            &ctx.master,
            &LedgerEntry {
                workspace_id: &ctx.workspace_id,
                amount,
                service_type: Some("weldsign"),
                idempotency_key: Some(format!("weldsign:refund:{envelope_id}:{recipient_id}")),
                reference_id: Some(envelope_id),
                reference_type: Some("sign_envelope"),
                description: Some("WeldSign: signer did not sign".to_owned()),
                metadata: Some(json!({ "recipientId": recipient_id })),
            },
        )
        .await
        .map_err(|e| SignError::Internal(format!("{e:?}")))?;
    }
    Ok(())
}

// ── Filling the prepared PDF ───────────────────────────────────────────────

/// Whether a form field already has its value (from an earlier revision).
fn already_filled(revision: &Revision, id: lopdf::ObjectId) -> bool {
    let Ok(dict) = revision.dictionary(id) else {
        return true;
    };
    match dict.get(b"FT").ok().and_then(|t| t.as_name().ok()) {
        Some(b"Btn") => dict
            .get(b"AS")
            .ok()
            .and_then(|s| s.as_name().ok())
            .is_some_and(|s| s == b"Yes"),
        _ => dict.has(b"V"),
    }
}

/// One filled value to put into the prepared PDF.
pub(crate) struct Fill {
    pub(crate) field: Value,
    pub(crate) value: Option<String>,
    pub(crate) image: Option<Vec<u8>>,
}

/// Fill `fills` into `revision`, skipping fields already filled in an
/// earlier revision.
pub(crate) fn fill_revision(
    revision: &mut Revision,
    documents: &[Value],
    fills: &[Fill],
) -> SignResult<()> {
    let offsets = page_offsets(documents);
    for fill in fills {
        let field = &fill.field;
        let Some(id) = revision.find_field(&field_name(text(field, "id"))) else {
            continue;
        };
        if already_filled(revision, id) {
            continue;
        }
        let Some(offset) = offsets.get(text(field, "documentId")) else {
            continue;
        };
        let kind = text(field, "type").to_owned();
        let render = RenderField {
            page: offset + usize::try_from(field["page"].as_u64().unwrap_or(0)).unwrap_or(0),
            x: field["x"].as_f64().unwrap_or(0.0),
            y: field["y"].as_f64().unwrap_or(0.0),
            width: field["width"].as_f64().unwrap_or(0.0),
            height: field["height"].as_f64().unwrap_or(0.0),
            kind: kind.clone(),
            value: fill.value.clone(),
            image: fill.image.clone(),
        };
        let Some(appearance) = field_appearance(revision, &render).map_err(internal)? else {
            continue;
        };
        if kind == "checkbox" {
            revision.fill_checkbox(id, appearance).map_err(internal)?;
        } else {
            let value = match kind.as_str() {
                "signature" | "initials" => kind.clone(),
                _ => fill.value.clone().unwrap_or_default(),
            };
            revision
                .fill_text(id, &value, appearance)
                .map_err(internal)?;
        }
    }
    Ok(())
}

/// The fills for every field already filled in the database.
pub(crate) async fn stored_fills(ctx: &SendContext, fields: &[Value]) -> SignResult<Vec<Fill>> {
    let files = storage(ctx)?;
    let mut out = Vec::new();
    for field in fields.iter().filter(|f| !f["filledAt"].is_null()) {
        let image = match field["signatureKey"].as_str() {
            Some(key) => files
                .private
                .get_boxed(key)
                .await
                .map_err(internal)?
                .map(|object| object.bytes),
            None => None,
        };
        out.push(Fill {
            field: field.clone(),
            value: field["value"].as_str().map(str::to_owned),
            image,
        });
    }
    Ok(out)
}

/// The latest revision of a prepared request, with every stored value in.
pub(crate) async fn prepared_with_values(
    ctx: &SendContext,
    envelope: &Value,
) -> SignResult<Vec<u8>> {
    let id = text(envelope, "id");
    let bytes = storage(ctx)?
        .private
        .get_boxed(text(envelope, "preparedStorageKey"))
        .await
        .map_err(internal)?
        .ok_or_else(|| SignError::Internal(format!("Prepared PDF of {id} is missing")))?
        .bytes;
    let documents = list_documents(&ctx.db, id).await?;
    let fields = list_fields(&ctx.db, id).await?;
    let fills = stored_fills(ctx, &fields).await?;
    let mut revision = Revision::open(bytes).map_err(internal)?;
    fill_revision(&mut revision, &documents, &fills)?;
    revision.write().map_err(internal)
}

/// The evidence report of a prepared request: the certificate of completion
/// as its own PDF.
pub(crate) fn evidence_report(
    input: &crate::pdf_render::CertificateInput,
    title: &str,
) -> SignResult<Vec<u8>> {
    let mut out = OutputPdf::new();
    crate::pdf_render::append_certificate(&mut out, input).map_err(internal)?;
    out.finish(&format!("{title} (evidence report)"))
        .map_err(internal)
}

pub(crate) fn evidence_storage_key(clerk_org_id: &str, envelope_id: &str) -> String {
    evidence_key(clerk_org_id, envelope_id)
}

pub(crate) fn new_prepared_key(clerk_org_id: &str, envelope_id: &str) -> String {
    prepared_key(clerk_org_id, envelope_id)
}

// ── Sealing (SIGN-006) ─────────────────────────────────────────────────────

/// A signature to note in `sign_signatures`.
pub(crate) struct Record {
    pub(crate) recipient_id: Option<String>,
    pub(crate) kind: &'static str,
    pub(crate) level: Option<String>,
    pub(crate) document: &'static str,
    pub(crate) provider: Option<String>,
    pub(crate) certificate: Option<Certificate>,
    pub(crate) identity_method: Option<String>,
    pub(crate) signed_at: Option<OffsetDateTime>,
    pub(crate) timestamp_at: Option<OffsetDateTime>,
}

pub(crate) async fn insert_records(
    db: &PgPool,
    envelope_id: &str,
    records: Vec<Record>,
) -> SignResult<()> {
    for record in records {
        let cert = record.certificate.as_ref();
        sign_signatures::Entity::insert(sign_signatures::ActiveModel {
            id: Set(generate_id("sgs")),
            envelope_id: Set(envelope_id.to_owned()),
            recipient_id: Set(record.recipient_id),
            kind: Set(record.kind.to_owned()),
            level: Set(record.level),
            document: Set(record.document.to_owned()),
            provider: Set(record.provider),
            certificate_subject: Set(cert.map(|c| c.subject.display())),
            certificate_issuer: Set(cert.map(|c| c.issuer.display())),
            certificate_serial: Set(cert.map(Certificate::serial_hex)),
            certificate_not_after: Set(cert.map(|c| c.not_after)),
            qualified: Set(cert.is_some_and(Certificate::qualified_with_qscd)),
            identity_method: Set(record.identity_method),
            signed_at: Set(record.signed_at.map(crate::millis)),
            timestamp_at: Set(record.timestamp_at.map(crate::millis)),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
        .await?;
    }
    Ok(())
}

/// What securing a PDF added.
struct Secured {
    bytes: Vec<u8>,
    records: Vec<Record>,
    renew_at: Option<OffsetDateTime>,
}

/// Seal (when the install seals), add the DSS for every signature in the
/// file, and a document timestamp (when it has a TSA).
async fn secure_pdf(
    trust: &dyn TrustService,
    bytes: Vec<u8>,
    document: &'static str,
) -> Result<Secured, String> {
    let mut pdf = bytes;
    let mut records = Vec::new();
    if trust.seals() {
        let seal = trust.seal_identity().await.map_err(|e| e.to_string())?;
        let now = OffsetDateTime::now_utc();
        let pending = prepare_signature(
            Revision::open(pdf).map_err(|e| e.to_string())?,
            &SignatureSpec {
                field_name: "ws_seal".to_owned(),
                field: None,
                kind: SignatureKind::Cades {
                    name: Some(seal.certificate.subject.display()),
                    reason: Some("Sealed by WeldSign".to_owned()),
                    location: None,
                    signing_time: now,
                },
                contents_size: SIGNATURE_SIZE,
            },
            &seal.certificate,
            &seal.chain,
        )
        .map_err(|e| e.to_string())?;
        let value = trust
            .seal_sign(pending.data_to_be_signed())
            .await
            .map_err(|e| e.to_string())?;
        let token = trust
            .timestamp(&signing::signature_timestamp_digest(&value))
            .await
            .map_err(|e| e.to_string())?;
        pdf = pending
            .finish(&value, token.as_deref())
            .map_err(|e| e.to_string())?;
        records.push(Record {
            recipient_id: None,
            kind: "seal",
            level: Some("seal".to_owned()),
            document,
            provider: Some(trust.provider().to_owned()),
            certificate: Some(seal.certificate),
            identity_method: None,
            signed_at: Some(now),
            timestamp_at: token.as_ref().map(|_| now),
        });
    }
    let reports = verify_pdf(&pdf).map_err(|e| e.to_string())?;
    let mut chains: Vec<Vec<Certificate>> = Vec::new();
    for report in &reports {
        if !report.chain.is_empty() {
            chains.push(report.chain.clone());
        }
        if let Some(stamp) = &report.timestamp {
            chains.push(weldsuite_pades::x509::chain_of(
                &stamp.tsa,
                &stamp.certificates,
            ));
        }
    }
    let data = trust
        .validation_data(&chains)
        .await
        .map_err(|e| e.to_string())?;
    pdf = add_validation_data(pdf, &data).map_err(|e| e.to_string())?;
    let stamp = prepare_document_timestamp(
        Revision::open(pdf.clone()).map_err(|e| e.to_string())?,
        "ws_ts_1",
    )
    .map_err(|e| e.to_string())?;
    let mut renew_at = None;
    if let Some(token) = trust
        .timestamp(&stamp.digest(Hash::Sha256))
        .await
        .map_err(|e| e.to_string())?
    {
        let checked = weldsuite_pades::tsp::verify_token(&token, |hash| stamp.digest(hash))
            .map_err(|e| e.to_string())?;
        renew_at = Some(checked.tsa.not_after - time::Duration::days(365));
        pdf = stamp.embed(&token).map_err(|e| e.to_string())?;
        records.push(Record {
            recipient_id: None,
            kind: "document_timestamp",
            level: None,
            document,
            provider: Some(trust.provider().to_owned()),
            certificate: Some(checked.tsa),
            identity_method: None,
            signed_at: None,
            timestamp_at: Some(checked.time),
        });
    }
    Ok(Secured {
        bytes: pdf,
        records,
        renew_at,
    })
}

/// The `secure signed pdf` step of `sign.finalize`: seal the completed
/// request's PDF (and evidence report), add the DSS and a document
/// timestamp. Once (`sealedAt`). A failure is logged and noted on the
/// trail; the unsealed PDF still goes out.
#[allow(
    clippy::too_many_lines,
    reason = "the steps of sealing one request, in order"
)]
pub(crate) async fn secure_final(ctx: &SendContext, envelope_id: &str) -> SignResult<()> {
    let Some(trust) = ctx.services.eidas.trust.clone() else {
        return Ok(());
    };
    let Some(envelope) = sign_envelopes::Entity::find_by_id(envelope_id)
        .one(&orm(&ctx.db))
        .await?
        .map(row_json)
        .transpose()?
    else {
        return Ok(());
    };
    let prepared = envelope["pipeline"] == PREPARED;
    let final_key = text(&envelope, "finalStorageKey").to_owned();
    if envelope["status"] != "completed"
        || final_key.is_empty()
        || !envelope["sealedAt"].is_null()
        || !(trust.seals() || prepared)
    {
        return Ok(());
    }
    // Once: a `sealed` event marks it done, also when nothing was sealed
    // (a prepared request on an install without a seal gets only the DSS
    // and a document timestamp).
    let done: Option<String> = sign_events::Entity::find()
        .select_only()
        .column(sign_events::Column::Id)
        .filter(sign_events::Column::EnvelopeId.eq(envelope_id))
        .filter(sign_events::Column::Type.eq("sealed"))
        .into_tuple()
        .one(&orm(&ctx.db))
        .await?;
    if done.is_some() {
        return Ok(());
    }
    let files = storage(ctx)?;
    let original = files
        .private
        .get_boxed(&final_key)
        .await
        .map_err(internal)?
        .ok_or_else(|| SignError::Internal(format!("Final PDF of {envelope_id} is missing")))?
        .bytes;
    let unsealed = text(&envelope, "finalSha256").to_owned();
    let secured = match secure_pdf(trust.as_ref(), original, "final").await {
        Ok(secured) => secured,
        Err(error) => {
            tracing::error!(error, envelope_id, "sign: sealing the signed PDF failed");
            record_sign_event(
                &ctx.db,
                SignEvent {
                    envelope_id,
                    kind: "seal_failed",
                    details: Some(json!({ "provider": trust.provider() })),
                    ..SignEvent::default()
                },
            )
            .await?;
            return Ok(());
        }
    };
    let mut records = secured.records;
    let mut evidence_sha = None;
    let evidence = text(&envelope, "evidenceStorageKey").to_owned();
    if !evidence.is_empty()
        && let Some(object) = files.private.get_boxed(&evidence).await.map_err(internal)?
    {
        match secure_pdf(trust.as_ref(), object.bytes, "evidence").await {
            Ok(sealed) => {
                let sha = sha256_hex(&sealed.bytes);
                files
                    .private
                    .put_boxed(
                        &evidence,
                        sealed.bytes,
                        &PutOptions::content_type("application/pdf").with_metadata("sha256", &sha),
                    )
                    .await
                    .map_err(internal)?;
                records.extend(sealed.records);
                evidence_sha = Some(sha);
            }
            Err(error) => tracing::error!(
                error,
                envelope_id,
                "sign: sealing the evidence report failed"
            ),
        }
    }
    let sha = sha256_hex(&secured.bytes);
    files
        .private
        .put_boxed(
            &final_key,
            secured.bytes,
            &PutOptions::content_type("application/pdf").with_metadata("sha256", &sha),
        )
        .await
        .map_err(internal)?;
    let now = crate::now();
    let sealed = records.iter().any(|r| r.kind == "seal");
    let seal_timestamped = records
        .iter()
        .any(|r| r.kind == "seal" && r.timestamp_at.is_some());
    let timestamped = records.iter().any(|r| r.kind == "document_timestamp");
    let mut update = sign_envelopes::Entity::update_many()
        .col_expr(sign_envelopes::Column::FinalSha256, Expr::value(&sha))
        .col_expr(
            sign_envelopes::Column::SealedAt,
            Expr::value(sealed.then_some(now)),
        )
        .col_expr(
            sign_envelopes::Column::LtvRenewAt,
            Expr::value(secured.renew_at.map(crate::millis)),
        )
        .col_expr(sign_envelopes::Column::UpdatedAt, Expr::value(now));
    if let Some(evidence_sha) = &evidence_sha {
        update = update.col_expr(
            sign_envelopes::Column::EvidenceSha256,
            Expr::value(evidence_sha),
        );
    }
    update
        .filter(sign_envelopes::Column::Id.eq(envelope_id))
        .exec(&orm(&ctx.db))
        .await?;
    // The PAdES level the file reached: a document timestamp (B-LTA), a
    // timestamped signature with the DSS (B-LT), or neither (B-B).
    let level = if timestamped {
        "B-LTA"
    } else if seal_timestamped {
        "B-LT"
    } else {
        "B-B"
    };
    insert_records(&ctx.db, envelope_id, records).await?;
    record_sign_event(
        &ctx.db,
        SignEvent {
            envelope_id,
            kind: "sealed",
            details: Some(json!({
                "unsealedSha256": unsealed,
                "finalSha256": sha,
                "evidenceSha256": evidence_sha,
                "provider": trust.provider(),
                "sealed": sealed,
                "level": level,
            })),
            ..SignEvent::default()
        },
    )
    .await
}

// ── Member routes ──────────────────────────────────────────────────────────

/// The extra detail fields of a request with eIDAS data, left out otherwise.
pub(crate) fn extend_detail(detail: &mut serde_json::Map<String, Value>, envelope: &Value) {
    for key in ["pipeline", "sealedAt", "creditsReserved"] {
        if !envelope[key].is_null() {
            detail.insert(key.to_owned(), envelope[key].clone());
        }
    }
    if envelope["evidenceStorageKey"].is_string() && envelope["status"] == "completed" {
        detail.insert("hasEvidence".to_owned(), json!(true));
    }
}

fn normalized(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// `GET /api/sign/envelopes/:id/signatures` (owner).
pub(crate) async fn signatures(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_own_envelope(&caller.db, &id, &viewer).await?;
            let envelope_id = text(&envelope, "id");
            let rows = sign_signatures::Entity::find()
                .filter(sign_signatures::Column::EnvelopeId.eq(envelope_id))
                .filter(sign_signatures::Column::Document.eq("final"))
                .order_by_asc(sign_signatures::Column::CreatedAt)
                .all(&orm(&caller.db))
                .await?;
            let recipients = list_recipients(&caller.db, envelope_id).await?;
            let rows = json_rows(rows)?;
            let out: Vec<Value> = rows
                .iter()
                .map(|row| {
                    let recipient = row["recipientId"]
                        .as_str()
                        .and_then(|rid| recipients.iter().find(|r| r["id"] == rid));
                    let mismatch = match (
                        recipient.and_then(|r| r["name"].as_str()),
                        row["certificateSubject"].as_str(),
                    ) {
                        (Some(expected), Some(holder)) if !expected.trim().is_empty() => {
                            normalized(expected) != normalized(holder)
                        }
                        _ => false,
                    };
                    json!({
                        "id": row["id"],
                        "kind": row["kind"],
                        "level": row["level"],
                        "recipientId": row["recipientId"],
                        "holderName": row["certificateSubject"],
                        "issuerName": row["certificateIssuer"],
                        "provider": row["provider"],
                        "qualified": row["qualified"],
                        "signedAt": row["signedAt"],
                        "timestampAt": row["timestampAt"],
                        "nameMismatch": mismatch,
                    })
                })
                .collect();
            Ok(Data(Value::Array(out)).into_response())
        }
        .await,
    )
}

/// A PDF download answer.
pub(crate) fn pdf_download(bytes: Vec<u8>, filename: &str) -> Response {
    let filename = filename.replace('"', "");
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
        .unwrap_or_else(|_| HeaderValue::from_static("attachment"));
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
    headers.insert(CONTENT_DISPOSITION, disposition);
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

/// `GET /api/sign/envelopes/:id/evidence`: the evidence report.
pub(crate) async fn evidence(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_envelope(&caller.db, &id, &viewer).await?;
            let key = text(&envelope, "evidenceStorageKey");
            if envelope["status"] != "completed" || key.is_empty() {
                return Ok(ApiError::not_found("Evidence report", None).into_response());
            }
            // The app's own private bucket. A Rust-only route has no
            // conformance stand-in to take from the request.
            let files = state
                .files
                .clone()
                .ok_or_else(|| SignError::Internal("sign: no file storage".to_owned()))?;
            let Some(object) = files.private.get_boxed(key).await.map_err(internal)? else {
                return Ok(ApiError::not_found("Evidence report", None).into_response());
            };
            let name = format!("{} - evidence report.pdf", text(&envelope, "title"));
            Ok(pdf_download(object.bytes, &name))
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use lopdf::{Document, Object, dictionary};
    use weldsuite_trust_services::local::LocalTrustService;

    use super::*;

    fn one_page() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages,
            "MediaBox" => vec![Object::Integer(0), Object::Integer(0), Object::Integer(612), Object::Integer(792)],
        });
        doc.objects.insert(
            pages,
            Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => Object::Integer(1) }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).expect("save");
        out
    }

    fn png() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = ::png::Encoder::new(&mut bytes, 2, 2);
            encoder.set_color(::png::ColorType::Rgba);
            encoder.set_depth(::png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("header");
            writer.write_image_data(&[0u8; 16]).expect("pixels");
        }
        bytes
    }

    fn field(id: &str, kind: &str, y: f64) -> Value {
        json!({ "id": id, "documentId": "d1", "page": 0, "x": 72.0, "y": y, "width": 200.0, "height": 24.0, "type": kind })
    }

    #[tokio::test]
    async fn values_fill_the_prepared_fields_and_the_seal_goes_on_last() {
        let fields = [
            field("f1", "text", 100.0),
            field("f2", "checkbox", 140.0),
            field("f3", "signature", 180.0),
        ];
        let mut revision = Revision::open(one_page()).expect("open");
        for f in &fields {
            let rect = Rect {
                x: 72.0,
                y: f["y"].as_f64().expect("y"),
                width: 200.0,
                height: 24.0,
            };
            let rect = field_rect(revision.document(), 0, rect).expect("rect");
            let kind = if f["type"] == "checkbox" {
                FieldKind::Checkbox
            } else {
                FieldKind::Text
            };
            revision
                .add_form_field(kind, &field_name(text(f, "id")), 0, rect)
                .expect("field");
        }
        revision
            .add_form_field(
                FieldKind::Signature,
                &signature_field_name("r1"),
                0,
                [0.0; 4],
            )
            .expect("sig field");
        let prepared = revision.write().expect("prepared");

        let documents = [json!({ "id": "d1", "pageCount": 1 })];
        let fills = vec![
            Fill {
                field: fields[0].clone(),
                value: Some("Ann Peeters".to_owned()),
                image: None,
            },
            Fill {
                field: fields[1].clone(),
                value: Some("true".to_owned()),
                image: None,
            },
            Fill {
                field: fields[2].clone(),
                value: None,
                image: Some(png()),
            },
        ];
        let mut revision = Revision::open(prepared).expect("open");
        fill_revision(&mut revision, &documents, &fills).expect("fill");
        let filled = revision.write().expect("filled");
        let again = Revision::open(filled.clone()).expect("open");
        for f in &fields {
            let id = again.find_field(&field_name(text(f, "id"))).expect("field");
            assert!(already_filled(&again, id), "{} not filled", text(f, "id"));
        }

        let trust = LocalTrustService::new().expect("trust");
        let secured = secure_pdf(&trust, filled, "final").await.expect("secured");
        let reports = verify_pdf(&secured.bytes).expect("verify");
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().all(|r| r.intact));
        assert!(reports[0].qualified());
        assert!(reports[1].document_timestamp);
        assert_eq!(secured.records.len(), 2);
        assert!(secured.renew_at.is_some());
    }

    #[test]
    fn levels_are_only_what_the_install_offers() {
        let mut issues = Issues::default();
        let body = json!({ "signatureLevel": "qes" });
        let level = read_level(&mut issues, body.as_object().expect("object"));
        let none = Eidas::default();
        assert!(check_level(&level, "signer", &none).is_err());
        assert_eq!(
            check_level(&level, "cc", &none).ok(),
            Some(LevelChange::Simple)
        );
        let local = Eidas {
            trust: Some(Arc::new(LocalTrustService::new().expect("trust"))),
            ..Eidas::default()
        };
        assert_eq!(
            check_level(&level, "signer", &local).ok(),
            Some(LevelChange::Level("qes".to_owned()))
        );
        assert_eq!(Prices { aes: 1, qes: 3 }.of(Level::Qes), 3);
    }
}
