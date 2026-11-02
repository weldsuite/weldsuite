//! The signer's side (`packages/domains/sign/src/signing.ts`): what a link
//! opens, the view of the request, consent, signing and declining. Every
//! write is recorded in `sign_events` with the signer's IP and browser (ADR
//! SIGN-003).

use std::collections::{HashMap, HashSet};

use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use jiff::Timestamp;
use jiff::tz::{Offset, TimeZone};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_db::js_row;
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynFileStore, PutOptions};

use crate::finalize::DISCLOSURE_VERSION;
use crate::pdf_render::{RenderField, flatten_document};
use crate::{SignError, SignResult, text};

/// The signer's IP and browser (`SignerMeta`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SignerMeta {
    pub(crate) ip: Option<String>,
    pub(crate) user_agent: Option<String>,
}

/// The envelope and recipient a link or session points at (`SignerRef`),
/// as Drizzle rows.
#[derive(Debug, Clone)]
pub(crate) struct SignerRef {
    pub(crate) envelope: Value,
    pub(crate) recipient: Value,
}

/// `loadSigner`: drafts and deleted requests do not exist for signers.
pub(crate) async fn load_signer(
    db: &PgPool,
    envelope_id: &str,
    recipient_id: &str,
) -> SignResult<SignerRef> {
    let envelope: Option<Value> =
        sqlx::query_scalar("select to_jsonb(e) from sign_envelopes e where id = $1 limit 1")
            .bind(envelope_id)
            .fetch_optional(db)
            .await?;
    let Some(envelope) = envelope
        .map(js_row)
        .filter(|e| e["kind"] == "envelope" && e["status"] != "draft" && e["deletedAt"].is_null())
    else {
        return Err(SignError::NotFound("Envelope"));
    };
    let recipient: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from sign_recipients r where id = $1 and envelope_id = $2 limit 1",
    )
    .bind(recipient_id)
    .bind(envelope_id)
    .fetch_optional(db)
    .await?;
    let recipient = recipient
        .map(js_row)
        .ok_or(SignError::NotFound("Recipient"))?;
    Ok(SignerRef {
        envelope,
        recipient,
    })
}

/// `new Date()` as JavaScript keeps it: milliseconds.
pub(crate) fn now_ms() -> OffsetDateTime {
    let now = OffsetDateTime::now_utc();
    now.replace_millisecond(now.millisecond()).unwrap_or(now)
}

/// A timestamp column (`toISOString()`) as a time.
fn instant(value: &Value) -> Option<OffsetDateTime> {
    value
        .as_str()
        .and_then(|text| OffsetDateTime::parse(text, &Rfc3339).ok())
}

/// `closedReason`: why a request can no longer be acted on, or `None` while
/// it is open (or completed).
pub(crate) fn closed_reason(envelope: &Value, now: OffsetDateTime) -> Option<&'static str> {
    match text(envelope, "status") {
        "voided" => return Some("voided"),
        "declined" => return Some("declined"),
        "expired" => return Some("expired"),
        _ => {}
    }
    let expired = text(envelope, "status") != "completed"
        && instant(&envelope["expiresAt"]).is_some_and(|at| at < now);
    expired.then_some("expired")
}

/// `portalMode`: what the page should offer.
pub(crate) fn portal_mode(
    envelope: &Value,
    recipient: &Value,
    now: OffsetDateTime,
) -> &'static str {
    if envelope["status"] == "completed" {
        return "completed";
    }
    if closed_reason(envelope, now).is_some() {
        return "closed";
    }
    let status = text(recipient, "status");
    if recipient["role"] == "signer" && (status == "sent" || status == "opened") {
        return "sign";
    }
    "waiting"
}

/// One evidence row about the signer, the actor, with their IP and browser
/// (`recordSignEvent`).
async fn record_signer_event(
    db: &PgPool,
    signer: &SignerRef,
    kind: &str,
    meta: &SignerMeta,
    details: Option<Value>,
) -> SignResult<()> {
    let recipient = &signer.recipient;
    sqlx::query(
        "insert into sign_events
             (id, envelope_id, recipient_id, type, actor_user_id, actor_name, actor_email, ip, user_agent, details)
         values ($1, $2, $3, $4, null, $5, $6, $7, $8, $9::jsonb)",
    )
    .bind(generate_id("sge"))
    .bind(text(&signer.envelope, "id"))
    .bind(text(recipient, "id"))
    .bind(kind)
    .bind(recipient["name"].as_str())
    .bind(recipient["email"].as_str())
    .bind(meta.ip.as_deref())
    .bind(meta.user_agent.as_deref())
    .bind(details)
    .execute(db)
    .await?;
    Ok(())
}

/// `markOpened`: the first time a signer gets in, `opened`, and the
/// request is in progress.
pub(crate) async fn mark_opened(
    db: &PgPool,
    signer: &SignerRef,
    meta: &SignerMeta,
) -> SignResult<()> {
    let now = crate::now();
    let recipient = &signer.recipient;
    if recipient["status"] == "sent" {
        sqlx::query(
            "update sign_recipients set status = 'opened', opened_at = $2::timestamptz, updated_at = $2::timestamptz
             where id = $1",
        )
        .bind(text(recipient, "id"))
        .bind(&now)
        .execute(db)
        .await?;
    }
    if recipient["openedAt"].is_null() {
        record_signer_event(db, signer, "opened", meta, None).await?;
    }
    if signer.envelope["status"] == "sent" {
        sqlx::query(
            "update sign_envelopes set status = 'in_progress', updated_at = $2::timestamptz
             where id = $1 and status = 'sent'",
        )
        .bind(text(&signer.envelope, "id"))
        .bind(&now)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// `recordCodeCheck`: a code check on the evidence trail.
pub(crate) async fn record_code_check(
    db: &PgPool,
    signer: &SignerRef,
    ok: bool,
    meta: &SignerMeta,
) -> SignResult<()> {
    let kind = if ok { "code_verified" } else { "code_failed" };
    let details = json!({ "method": signer.recipient["authMode"] });
    record_signer_event(db, signer, kind, meta, Some(details)).await
}

/// `changedEmail`: a correction that changed the address.
fn changed_email(details: &Value) -> bool {
    details.is_object() && details.get("from") != details.get("to")
}

/// `hasConsented`: only consent given after the last correction that
/// changed the address counts; fixing just the name changes nothing.
pub(crate) async fn has_consented(db: &PgPool, recipient_id: &str) -> SignResult<bool> {
    let steps: Vec<(String, Option<Value>)> = sqlx::query_as(
        "select type, details from sign_events
         where recipient_id = $1 and type in ('consented', 'recipient_corrected')
         order by created_at desc, id desc",
    )
    .bind(recipient_id)
    .fetch_all(db)
    .await?;
    let last = steps
        .iter()
        .find(|(kind, details)| kind == "consented" || details.as_ref().is_some_and(changed_email));
    Ok(last.is_some_and(|(kind, _)| kind == "consented"))
}

/// The brand the signer sees (`SignPortalBrand`).
pub(crate) struct PortalBrand {
    pub(crate) name: String,
    pub(crate) color: Option<String>,
    pub(crate) logo_url: Option<String>,
}

/// `portalView`: what the signer sees, only their own fields.
pub(crate) async fn portal_view(
    db: &PgPool,
    signer: &SignerRef,
    brand: PortalBrand,
) -> SignResult<Value> {
    let SignerRef {
        envelope,
        recipient,
    } = signer;
    let envelope_id = text(envelope, "id");
    let recipient_id = text(recipient, "id");
    let documents = crate::envelopes::list_documents(db, envelope_id).await?;
    let fields: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from sign_fields f where envelope_id = $1 and recipient_id = $2",
    )
    .bind(envelope_id)
    .bind(recipient_id)
    .fetch_all(db)
    .await?;
    let consented = has_consented(db, recipient_id).await?;
    let now = now_ms();
    let pick = |row: &Value, keys: &[&str]| -> Value {
        Value::Object(
            keys.iter()
                .map(|k| ((*k).to_owned(), row[*k].clone()))
                .collect(),
        )
    };
    Ok(json!({
        "envelopeId": envelope["id"],
        "title": envelope["title"],
        "message": envelope["message"],
        "status": envelope["status"],
        "senderName": envelope["senderName"],
        "senderEmail": envelope["senderEmail"],
        "brand": { "name": brand.name, "color": brand.color, "logoUrl": brand.logo_url },
        "recipient": {
            "id": recipient["id"],
            "name": recipient["name"],
            "email": recipient["email"],
            "role": recipient["role"],
            "status": recipient["status"],
            "locale": if recipient["locale"] == "nl" { "nl" } else { "en" },
            "consented": consented,
        },
        "mode": portal_mode(envelope, recipient, now),
        "closedReason": closed_reason(envelope, now),
        "expiresAt": envelope["expiresAt"],
        "disclosureVersion": DISCLOSURE_VERSION,
        "documents": documents
            .iter()
            .map(|d| pick(d, &["id", "name", "pageCount", "pageSizes"]))
            .collect::<Vec<_>>(),
        "fields": fields
            .into_iter()
            .map(js_row)
            .map(|f| pick(&f, &["id", "documentId", "type", "page", "x", "y", "width", "height", "required", "label", "value"]))
            .collect::<Vec<_>>(),
    }))
}

/// `recordConsent`.
pub(crate) async fn record_consent(
    db: &PgPool,
    signer: &SignerRef,
    disclosure_version: &str,
    meta: &SignerMeta,
) -> SignResult<()> {
    if portal_mode(&signer.envelope, &signer.recipient, now_ms()) != "sign" {
        return Err(SignError::Conflict(
            "This request cannot be signed now".to_owned(),
        ));
    }
    if has_consented(db, text(&signer.recipient, "id")).await? {
        return Ok(());
    }
    let details = json!({ "disclosureVersion": disclosure_version });
    record_signer_event(db, signer, "consented", meta, Some(details)).await
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// `atob`: forgiving about padding and trailing bits.
const FORGIVING: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// A signature the signer adopted (`SignPortalSignature`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Signature {
    pub(crate) kind: String,
    /// A PNG data URL.
    pub(crate) image: String,
}

/// `pngBytes`: the PNG bytes of a data URL, checked to really be a PNG.
pub(crate) fn png_bytes(signature: &Signature) -> SignResult<Vec<u8>> {
    let image = &signature.image;
    let base64 = image
        .find(',')
        .map_or(image.as_str(), |at| &image[at + 1..]);
    let bytes = FORGIVING
        .decode(base64)
        .map_err(|_| SignError::invalid("The signature image could not be read"))?;
    if bytes.len() < 33 || bytes[..8] != PNG_MAGIC {
        return Err(SignError::invalid("The signature must be a PNG image"));
    }
    Ok(bytes)
}

const MONTHS_EN: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
];
const MONTHS_NL: [&str; 12] = [
    "jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec",
];

/// The time zone `Intl.DateTimeFormat` accepts as `timeZone`: an IANA name
/// (any case) or an offset (`+01:00`); `None` for anything else.
fn time_zone(name: &str) -> Option<TimeZone> {
    if let Ok(zone) = TimeZone::get(name) {
        return Some(zone);
    }
    let (sign, rest) = match name.as_bytes().first()? {
        b'+' => (1, &name[1..]),
        b'-' => (-1, &name[1..]),
        _ => return None,
    };
    let digits: String = rest.chars().filter(|c| *c != ':').collect();
    let valid = matches!(digits.len(), 2 | 4)
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (rest.len() == digits.len() || (rest.len() == 5 && rest.as_bytes()[2] == b':'));
    if !valid {
        return None;
    }
    let hours: i32 = digits[..2].parse().ok()?;
    let minutes: i32 = digits.get(2..).map_or(Ok(0), str::parse).ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    let offset = Offset::from_seconds(sign * (hours * 3600 + minutes * 60)).ok()?;
    Some(TimeZone::fixed(offset))
}

/// `signedDate`: "24 Oct 2026" / "24 okt 2026", in the signer's time zone
/// (UTC when it has none or an unknown one).
pub(crate) fn signed_date(locale: &str, zone: Option<&str>, now: OffsetDateTime) -> String {
    let zone = zone
        .filter(|z| !z.is_empty())
        .and_then(time_zone)
        .unwrap_or(TimeZone::UTC);
    let at = Timestamp::from_millisecond(
        i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(0),
    )
    .unwrap_or(Timestamp::UNIX_EPOCH)
    .to_zoned(zone);
    let months = if locale == "nl" { MONTHS_NL } else { MONTHS_EN };
    let month = months[usize::try_from(at.month() - 1).unwrap_or(0)];
    format!("{} {month} {}", at.day(), at.year())
}

/// `signatureKey`.
pub(crate) fn signature_key(
    workspace_id: &str,
    envelope_id: &str,
    recipient_id: &str,
    kind: &str,
) -> String {
    format!("workspaces/{workspace_id}/weldsign/{envelope_id}/signatures/{recipient_id}-{kind}.png")
}

/// `workingKey`: `x.pdf` → `x.working.pdf` (a key without `.pdf` stays as it is).
pub(crate) fn working_key(original_key: &str) -> String {
    original_key.strip_suffix(".pdf").map_or_else(
        || original_key.to_owned(),
        |stem| format!("{stem}.working.pdf"),
    )
}

/// What a signer submits (`SignPortalCompleteInput`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Submission {
    /// `{ fieldId, value }` in the body's order.
    pub(crate) values: Vec<(String, String)>,
    pub(crate) signature: Option<Signature>,
    pub(crate) initials: Option<Signature>,
    pub(crate) time_zone: Option<String>,
}

/// A field's value and signature image once resolved (`ResolvedField`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Resolved {
    pub(crate) value: Option<String>,
    pub(crate) signature_key: Option<String>,
}

/// `resolveField`.
fn resolve_field(
    field: &Value,
    recipient: &Value,
    raw: Option<&str>,
    keys: (Option<&str>, Option<&str>),
    date: &str,
) -> SignResult<Resolved> {
    let entered = |value: Option<String>| Resolved {
        value,
        signature_key: None,
    };
    let label = || field["label"].as_str().filter(|l| !l.is_empty());
    let required = field["required"].as_bool().unwrap_or(false);
    match text(field, "type") {
        kind @ ("signature" | "initials") => {
            let key = if kind == "signature" { keys.0 } else { keys.1 };
            let Some(key) = key else {
                return Err(SignError::invalid(if kind == "signature" {
                    "Adopt a signature first"
                } else {
                    "Adopt your initials first"
                }));
            };
            Ok(Resolved {
                value: None,
                signature_key: Some(key.to_owned()),
            })
        }
        "name" => Ok(entered(Some(text(recipient, "name").to_owned()))),
        "email" => Ok(entered(Some(text(recipient, "email").to_owned()))),
        "date_signed" => Ok(entered(Some(date.to_owned()))),
        "checkbox" => {
            let checked = raw == Some("true");
            if required && !checked {
                return Err(SignError::invalid(format!(
                    "{} must be checked",
                    label().unwrap_or("A required checkbox")
                )));
            }
            Ok(entered(Some(
                if checked { "true" } else { "false" }.to_owned(),
            )))
        }
        _ => {
            let value = crate::mail::js_trim(raw.unwrap_or_default());
            if required && value.is_empty() {
                return Err(SignError::invalid(format!(
                    "{} is empty",
                    label().unwrap_or("A required field")
                )));
            }
            Ok(entered((!value.is_empty()).then(|| value.to_owned())))
        }
    }
}

/// `resolveSubmission`: field values and signature keys for a signer's
/// submission, in the fields' order; refuses anything missing or out of
/// place.
pub(crate) fn resolve_submission(
    fields: &[Value],
    recipient: &Value,
    input: &Submission,
    keys: (Option<&str>, Option<&str>),
    now: OffsetDateTime,
) -> SignResult<Vec<(String, Resolved)>> {
    // `new Map(values)`: the last value of an id wins, its first position counts.
    let mut values: HashMap<&str, &str> = HashMap::new();
    let mut order: Vec<&str> = Vec::new();
    for (id, value) in &input.values {
        if values.insert(id, value).is_none() {
            order.push(id);
        }
    }
    for id in order {
        if !fields.iter().any(|f| f["id"] == id) {
            return Err(SignError::invalid(format!(
                "Field {id} is not one of yours"
            )));
        }
    }
    let date = signed_date(text(recipient, "locale"), input.time_zone.as_deref(), now);
    fields
        .iter()
        .map(|field| {
            let id = text(field, "id");
            resolve_field(field, recipient, values.get(id).copied(), keys, &date)
                .map(|resolved| (id.to_owned(), resolved))
        })
        .collect()
}

/// Where a signature is stored: the private bucket, and the org prefix.
pub(crate) struct CompleteContext<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) bucket: &'a dyn DynFileStore,
    /// The Clerk org id (storage prefix).
    pub(crate) workspace_id: &'a str,
    pub(crate) meta: &'a SignerMeta,
}

fn storage_error(error: impl std::fmt::Display) -> SignError {
    SignError::Internal(format!("sign storage: {error}"))
}

/// The signer's own fields, in the table's order (no `order by`, as
/// TypeScript reads them).
async fn own_fields(db: &PgPool, envelope_id: &str, recipient_id: &str) -> SignResult<Vec<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from sign_fields f where envelope_id = $1 and recipient_id = $2",
    )
    .bind(envelope_id)
    .bind(recipient_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `completeSigning`: images to the private bucket, values on the fields,
/// the recipient signed, the evidence event, and fresh working copies of
/// their documents so the next signer sees what is already signed.
pub(crate) async fn complete_signing(
    ctx: &CompleteContext<'_>,
    signer: &SignerRef,
    input: &Submission,
) -> SignResult<()> {
    let db = ctx.db;
    let SignerRef {
        envelope,
        recipient,
    } = signer;
    let envelope_id = text(envelope, "id");
    let recipient_id = text(recipient, "id");
    if portal_mode(envelope, recipient, now_ms()) != "sign" {
        return Err(SignError::Conflict(
            "This request cannot be signed now".to_owned(),
        ));
    }
    if !has_consented(db, recipient_id).await? {
        return Err(SignError::Conflict(
            "Agree to sign electronically first".to_owned(),
        ));
    }

    let fields = own_fields(db, envelope_id, recipient_id).await?;
    let needs = |kind: &str| fields.iter().any(|f| f["type"] == kind);
    let mut keys: [Option<String>; 2] = [None, None];
    for (slot, (kind, signature)) in [
        ("signature", &input.signature),
        ("initials", &input.initials),
    ]
    .into_iter()
    .enumerate()
    {
        let Some(signature) = signature.as_ref().filter(|_| needs(kind)) else {
            continue;
        };
        let key = signature_key(ctx.workspace_id, envelope_id, recipient_id, kind);
        let bytes = png_bytes(signature)?;
        ctx.bucket
            .put_boxed(&key, bytes, &PutOptions::content_type("image/png"))
            .await
            .map_err(storage_error)?;
        keys[slot] = Some(key);
    }
    let now = now_ms();
    let resolved = resolve_submission(
        &fields,
        recipient,
        input,
        (keys[0].as_deref(), keys[1].as_deref()),
        now,
    )?;

    // Claim the signature before writing anything: a double-submitted
    // /complete (or two tabs) races here, and only the one that flips the
    // recipient goes on.
    let stamp = weldsuite_events::iso_timestamp(now);
    let claimed: Option<String> = sqlx::query_scalar(
        "update sign_recipients
         set status = 'signed', signed_at = $2::timestamptz, signed_ip = $3, signed_user_agent = $4,
             updated_at = $2::timestamptz
         where id = $1 and status in ('sent', 'opened')
         returning id",
    )
    .bind(recipient_id)
    .bind(&stamp)
    .bind(ctx.meta.ip.as_deref())
    .bind(ctx.meta.user_agent.as_deref())
    .fetch_optional(db)
    .await?;
    if claimed.is_none() {
        return Err(SignError::Conflict(
            "This request has already been signed".to_owned(),
        ));
    }
    if let Err(error) = fill_fields(db, &resolved, &stamp).await {
        // The values did not all land: give the turn back so the signer can
        // submit again.
        sqlx::query(
            "update sign_recipients
             set status = $2, signed_at = null, signed_ip = null, signed_user_agent = null,
                 updated_at = $3::timestamptz
             where id = $1 and status = 'signed'",
        )
        .bind(recipient_id)
        .bind(text(recipient, "status"))
        .bind(crate::now())
        .execute(db)
        .await?;
        return Err(error);
    }
    let details = json!({
        "signatureKind": input.signature.as_ref().map(|s| s.kind.as_str()),
        "initialsKind": input.initials.as_ref().map(|s| s.kind.as_str()),
        "fields": fields.len(),
    });
    record_signer_event(db, signer, "signed", ctx.meta, Some(details)).await?;
    sqlx::query("update sign_envelopes set updated_at = $2::timestamptz where id = $1")
        .bind(envelope_id)
        .bind(&stamp)
        .execute(db)
        .await?;

    let mut seen = HashSet::new();
    let touched: Vec<String> = fields
        .iter()
        .map(|f| text(f, "documentId").to_owned())
        .filter(|id| seen.insert(id.clone()))
        .collect();
    refresh_working_copies(db, ctx.bucket, envelope_id, &touched).await
}

async fn fill_fields(db: &PgPool, resolved: &[(String, Resolved)], stamp: &str) -> SignResult<()> {
    for (id, field) in resolved {
        sqlx::query(
            "update sign_fields
             set value = $2, signature_key = $3, filled_at = $4::timestamptz, updated_at = $4::timestamptz
             where id = $1",
        )
        .bind(id)
        .bind(field.value.as_deref())
        .bind(field.signature_key.as_deref())
        .bind(stamp)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// `refreshWorkingCopies`: rebuild the working copy of each document from
/// its original and every value filled so far.
pub(crate) async fn refresh_working_copies(
    db: &PgPool,
    bucket: &dyn DynFileStore,
    envelope_id: &str,
    document_ids: &[String],
) -> SignResult<()> {
    if document_ids.is_empty() {
        return Ok(());
    }
    let docs: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(d) from sign_documents d where id = any($1)")
            .bind(document_ids)
            .fetch_all(db)
            .await?;
    let fields: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from sign_fields f where envelope_id = $1 and document_id = any($2)",
    )
    .bind(envelope_id)
    .bind(document_ids)
    .fetch_all(db)
    .await?;
    let fields: Vec<Value> = fields.into_iter().map(js_row).collect();
    // `loadImages`: each signature image once.
    let mut images: HashMap<String, Vec<u8>> = HashMap::new();
    for key in fields.iter().filter_map(|f| f["signatureKey"].as_str()) {
        if images.contains_key(key) {
            continue;
        }
        if let Some(object) = bucket.get_boxed(key).await.map_err(storage_error)? {
            images.insert(key.to_owned(), object.bytes);
        }
    }
    for doc in docs.into_iter().map(js_row) {
        let storage_key = text(&doc, "storageKey");
        let Some(original) = bucket.get_boxed(storage_key).await.map_err(storage_error)? else {
            continue;
        };
        let render: Vec<RenderField> = fields
            .iter()
            .filter(|f| f["documentId"] == doc["id"] && !f["filledAt"].is_null())
            .map(|f| render_field(f, &images))
            .collect();
        let bytes = flatten_document(&original.bytes, &render).map_err(storage_error)?;
        bucket
            .put_boxed(
                &working_key(storage_key),
                bytes,
                &PutOptions::content_type("application/pdf"),
            )
            .await
            .map_err(storage_error)?;
    }
    Ok(())
}

/// `toRenderFields` for one filled field.
fn render_field(field: &Value, images: &HashMap<String, Vec<u8>>) -> RenderField {
    RenderField {
        page: usize::try_from(field["page"].as_u64().unwrap_or(0)).unwrap_or(0),
        x: field["x"].as_f64().unwrap_or(0.0),
        y: field["y"].as_f64().unwrap_or(0.0),
        width: field["width"].as_f64().unwrap_or(0.0),
        height: field["height"].as_f64().unwrap_or(0.0),
        kind: text(field, "type").to_owned(),
        value: field["value"].as_str().map(str::to_owned),
        image: field["signatureKey"]
            .as_str()
            .and_then(|key| images.get(key).cloned()),
    }
}

/// `signerDocument`: the PDF a signer sees, the working copy when earlier
/// signers filled something, else the original.
pub(crate) async fn signer_document(
    db: &PgPool,
    bucket: &dyn DynFileStore,
    envelope_id: &str,
    document_id: &str,
) -> SignResult<Vec<u8>> {
    let storage_key: Option<String> = sqlx::query_scalar(
        "select storage_key from sign_documents where id = $1 and envelope_id = $2 limit 1",
    )
    .bind(document_id)
    .bind(envelope_id)
    .fetch_optional(db)
    .await?;
    let Some(storage_key) = storage_key else {
        return Err(SignError::NotFound("Document"));
    };
    if let Some(working) = bucket
        .get_boxed(&working_key(&storage_key))
        .await
        .map_err(storage_error)?
    {
        return Ok(working.bytes);
    }
    bucket
        .get_boxed(&storage_key)
        .await
        .map_err(storage_error)?
        .map(|original| original.bytes)
        .ok_or(SignError::NotFound("Document file"))
}

/// `declineSigning`: the request is closed for everyone.
pub(crate) async fn decline_signing(
    db: &PgPool,
    signer: &SignerRef,
    reason: &str,
    meta: &SignerMeta,
) -> SignResult<()> {
    if portal_mode(&signer.envelope, &signer.recipient, now_ms()) != "sign" {
        return Err(SignError::Conflict(
            "This request cannot be declined now".to_owned(),
        ));
    }
    let now = crate::now();
    sqlx::query(
        "update sign_recipients
         set status = 'declined', declined_at = $2::timestamptz, decline_reason = $3, updated_at = $2::timestamptz
         where id = $1",
    )
    .bind(text(&signer.recipient, "id"))
    .bind(&now)
    .bind(reason)
    .execute(db)
    .await?;
    sqlx::query(
        "update sign_envelopes set status = 'declined', updated_at = $2::timestamptz where id = $1",
    )
    .bind(text(&signer.envelope, "id"))
    .bind(&now)
    .execute(db)
    .await?;
    let details = json!({ "reason": reason });
    record_signer_event(db, signer, "declined", meta, Some(details)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> OffsetDateTime {
        OffsetDateTime::parse(iso, &Rfc3339).expect("iso")
    }

    /// `signedDate` in Node 22 (ICU 78).
    #[test]
    fn signed_dates_like_intl() {
        let late = at("2026-10-24T23:30:00Z");
        assert_eq!(
            signed_date("en", Some("Europe/Amsterdam"), late),
            "25 Oct 2026"
        );
        assert_eq!(
            signed_date("nl", Some("Europe/Amsterdam"), late),
            "25 okt 2026"
        );
        assert_eq!(
            signed_date("en", Some("europe/amsterdam"), late),
            "25 Oct 2026"
        );
        assert_eq!(signed_date("en", None, late), "24 Oct 2026");
        assert_eq!(signed_date("en", Some("Not/AZone"), late), "24 Oct 2026");
        assert_eq!(signed_date("en", Some("+01:00"), late), "25 Oct 2026");
        assert_eq!(signed_date("en", Some("UTC"), late), "24 Oct 2026");
        let september = at("2026-09-05T12:00:00Z");
        assert_eq!(signed_date("en", None, september), "5 Sept 2026");
        assert_eq!(
            signed_date("nl", None, at("2026-03-05T12:00:00Z")),
            "5 mrt 2026"
        );
    }

    #[test]
    fn closed_and_modes_follow_status_and_expiry() {
        let now = at("2026-10-24T12:00:00Z");
        let envelope =
            |status: &str, expires: Value| json!({ "status": status, "expiresAt": expires });
        let signer = json!({ "role": "signer", "status": "opened" });
        assert_eq!(
            closed_reason(&envelope("voided", Value::Null), now),
            Some("voided")
        );
        assert_eq!(
            closed_reason(
                &envelope("in_progress", json!("2026-10-24T11:59:59.999Z")),
                now
            ),
            Some("expired")
        );
        assert_eq!(
            closed_reason(
                &envelope("completed", json!("2026-01-01T00:00:00.000Z")),
                now
            ),
            None
        );
        assert_eq!(
            portal_mode(&envelope("completed", Value::Null), &signer, now),
            "completed"
        );
        assert_eq!(
            portal_mode(&envelope("sent", Value::Null), &signer, now),
            "sign"
        );
        let cc = json!({ "role": "cc", "status": "sent" });
        assert_eq!(
            portal_mode(&envelope("sent", Value::Null), &cc, now),
            "waiting"
        );
    }

    #[test]
    fn keys_like_typescript() {
        assert_eq!(working_key("a/b.pdf"), "a/b.working.pdf");
        assert_eq!(working_key("a/b.PDF"), "a/b.PDF");
        assert_eq!(
            signature_key("org", "sgn", "sgr", "initials"),
            "workspaces/org/weldsign/sgn/signatures/sgr-initials.png"
        );
    }

    #[test]
    fn png_data_urls_are_checked() {
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let sig = |image: &str| Signature {
            kind: "drawn".to_owned(),
            image: image.to_owned(),
        };
        assert_eq!(png_bytes(&sig(png)).expect("png").len(), 70);
        let not_png = png_bytes(&sig("data:image/png;base64,R0lGODlhAQABAAAAACw="));
        assert!(
            matches!(not_png, Err(SignError::Invalid(m)) if m == "The signature must be a PNG image")
        );
        let unreadable = png_bytes(&sig("data:image/png;base64,abcde"));
        assert!(
            matches!(unreadable, Err(SignError::Invalid(m)) if m == "The signature image could not be read")
        );
    }

    #[test]
    fn submissions_resolve_in_field_order() {
        let fields = vec![
            json!({ "id": "f1", "type": "signature", "required": true, "label": null }),
            json!({ "id": "f2", "type": "text", "required": true, "label": "Job title" }),
            json!({ "id": "f3", "type": "checkbox", "required": false, "label": null }),
            json!({ "id": "f4", "type": "name", "required": true, "label": null }),
        ];
        let recipient = json!({ "name": "Ann", "email": "a@x.io", "locale": "en" });
        let now = at("2026-10-24T12:00:00Z");
        let input = |values: &[(&str, &str)]| Submission {
            values: values
                .iter()
                .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
                .collect(),
            ..Submission::default()
        };
        let missing = resolve_submission(&fields, &recipient, &input(&[]), (Some("k"), None), now);
        assert!(matches!(missing, Err(SignError::Invalid(m)) if m == "Job title is empty"));
        let stranger = resolve_submission(
            &fields,
            &recipient,
            &input(&[("zz", "x")]),
            (Some("k"), None),
            now,
        );
        assert!(
            matches!(stranger, Err(SignError::Invalid(m)) if m == "Field zz is not one of yours")
        );
        let unsigned = resolve_submission(
            &fields,
            &recipient,
            &input(&[("f2", "CEO")]),
            (None, None),
            now,
        );
        assert!(matches!(unsigned, Err(SignError::Invalid(m)) if m == "Adopt a signature first"));
        let done = resolve_submission(
            &fields,
            &recipient,
            &input(&[("f2", " Director "), ("f2", "CEO ")]),
            (Some("k"), None),
            now,
        )
        .expect("resolved");
        let values: Vec<_> = done
            .iter()
            .map(|(id, r)| (id.as_str(), r.value.as_deref()))
            .collect();
        assert_eq!(
            values,
            vec![
                ("f1", None),
                ("f2", Some("CEO")),
                ("f3", Some("false")),
                ("f4", Some("Ann"))
            ]
        );
        assert_eq!(done[0].1.signature_key.as_deref(), Some("k"));
    }
}
