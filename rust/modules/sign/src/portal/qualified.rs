//! An advanced or qualified signer's round trip to their trust service
//! provider (plan weldsign-eidas, SIGN-007). Two redirects, because the hash
//! to authorise depends on the signer's certificate:
//!
//! 1. `POST /signature/start` checks the submission like `/complete` would,
//!    keeps it, and sends the signer to identify (`identify_url`).
//! 2. `POST /signature/finish` after the first callback: their credential,
//!    the next revision of the prepared PDF with their values and a
//!    signature placeholder, and the second redirect to authorise its hash.
//! 3. `POST /signature/finish` after the second callback: the signature
//!    value, a timestamp, the revision stored (only if nobody else added one
//!    meanwhile), and then exactly what `/complete` does.
//!
//! Nothing is saved as signed until step 3 succeeds; a cancelled or failed
//! round trip leaves the signer where they were. The pending state lives
//! in the portal's cache for 30 minutes, bound to the signer's session.

use std::time::Duration;

use aws_lc_rs::rand::SystemRandom;
use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use http::StatusCode;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_kit::validation::Presence;
use weldsuite_pades::{
    Certificate, PendingSignature, Prepared, Revision, SIGNATURE_SIZE, SignatureKind,
    SignatureSpec, crypto, prepare_signature, signing,
};
use weldsuite_ports::{DynCache, PutOptions};
use weldsuite_schema::tenant::sign_envelopes;
use weldsuite_trust_services::{
    AuthorizeRequest, Callback, IdentifyRequest, Identity, Level, SignerCredential, TrustService,
};

use super::{Portal, Signer, fail, ok, parse, pdf, read_submission, unconfigured};
use crate::eidas::{self, Fill, Record};
use crate::envelopes::{list_documents, list_fields};
use crate::sending::{SignEvent, record_sign_event};
use crate::signing::{
    Submission, has_consented, now_ms, own_fields, png_bytes, portal_mode, resolve_submission,
};
use crate::{SignError, SignResult, text};

const PENDING_TTL: Duration = Duration::from_mins(30);

fn cache_key(state: &str) -> String {
    format!("sign:sig:{state}")
}

/// 32 random bytes, URL-safe: a `state` or a PKCE verifier. No random source
/// is an error, never a guessable token.
fn random_token() -> SignResult<String> {
    let bytes = aws_lc_rs::rand::generate::<[u8; 32]>(&SystemRandom::new())
        .map_err(|_| SignError::Internal("no random source".to_owned()))?
        .expose();
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// PKCE S256.
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(crypto::sha256(verifier.as_bytes()))
}

/// The signer's credential, as kept between the two redirects.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    id: String,
    /// Leaf first, base64 DER.
    certificates: Vec<String>,
    access_token: String,
    identity_method: Option<String>,
}

impl StoredCredential {
    fn of(credential: &SignerCredential) -> Self {
        let mut certificates = vec![STANDARD.encode(&credential.identity.certificate.der)];
        certificates.extend(
            credential
                .identity
                .chain
                .iter()
                .map(|c| STANDARD.encode(&c.der)),
        );
        Self {
            id: credential.credential_id.clone(),
            certificates,
            access_token: credential.access_token.clone(),
            identity_method: credential.identity_method.clone(),
        }
    }

    fn credential(&self) -> SignResult<SignerCredential> {
        let mut certs = Vec::new();
        for text in &self.certificates {
            let der = STANDARD
                .decode(text)
                .map_err(|e| SignError::Internal(e.to_string()))?;
            certs
                .push(Certificate::from_der(&der).map_err(|e| SignError::Internal(e.to_string()))?);
        }
        if certs.is_empty() {
            return Err(SignError::Internal("no certificate kept".to_owned()));
        }
        let certificate = certs.remove(0);
        Ok(SignerCredential {
            credential_id: self.id.clone(),
            identity: Identity {
                certificate,
                chain: certs,
            },
            access_token: self.access_token.clone(),
            identity_method: self.identity_method.clone(),
        })
    }
}

/// One signer's round trip in progress.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    /// `identify` or `authorize`.
    step: String,
    envelope_id: String,
    recipient_id: String,
    level: String,
    /// The `/complete` body as the signer sent it.
    submission: Value,
    verifier: String,
    credential: Option<StoredCredential>,
    /// The prepared PDF's key the revision was built on.
    base_key: Option<String>,
    /// The revision with the signature placeholder.
    revision_key: Option<String>,
    byte_range: Option<[usize; 4]>,
    /// Base64 of the CMS signed attributes (the data to be signed).
    signed_attributes: Option<String>,
}

async fn load(cache: &dyn DynCache, state: &str) -> Option<Pending> {
    let text = cache.get_boxed(&cache_key(state)).await.ok().flatten()?;
    serde_json::from_str(&text).ok()
}

async fn save(cache: &dyn DynCache, state: &str, pending: &Pending) -> SignResult<()> {
    let text = serde_json::to_string(pending).map_err(|e| SignError::Internal(e.to_string()))?;
    cache
        .put_boxed(&cache_key(state), &text, Some(PENDING_TTL))
        .await
        .map_err(|e| SignError::Internal(e.to_string()))
}

async fn forget(cache: &dyn DynCache, state: &str) {
    let _ = cache.delete_boxed(&cache_key(state)).await;
}

/// 400 `SIGNATURE_FAILED`: the signer may start again or decline.
fn failed(message: &str) -> Response {
    fail(StatusCode::BAD_REQUEST, "SIGNATURE_FAILED", message).into_response()
}

fn redirect_uri(portal: &Portal) -> Option<String> {
    portal
        .services()
        .portal_url
        .map(|url| format!("{}/signature-callback", url.trim_end_matches('/')))
}

fn level_name(level: Level) -> &'static str {
    match level {
        Level::Aes => "advanced",
        Level::Qes => "qualified",
    }
}

/// The submission kept at start, read again.
fn submission_of(pending: &Pending) -> SignResult<Submission> {
    let body =
        serde_json::to_vec(&pending.submission).map_err(|e| SignError::Internal(e.to_string()))?;
    parse(&Bytes::from(body), read_submission)
        .map_err(|_| SignError::Internal("the kept submission no longer reads".to_owned()))
}

async fn note(db: &sqlx::PgPool, signer: &Signer, kind: &str, details: Value) -> SignResult<()> {
    record_sign_event(
        db,
        SignEvent {
            envelope_id: &signer.session.envelope_id,
            recipient_id: Some(&signer.session.recipient_id),
            kind,
            details: Some(details),
            ..SignEvent::default()
        },
    )
    .await
}

/// `POST /signature/start`.
pub(super) async fn start(portal: Portal, body: Bytes) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            let input = match parse(&body, read_submission) {
                Ok(input) => input,
                Err(invalid) => return Ok(invalid.into_response()),
            };
            let raw: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let current = Portal::current(&signer).await?;
            let Some(level) = eidas::level_of(&current.recipient) else {
                return Err(SignError::Conflict(
                    "This signer signs without a trust service provider".to_owned(),
                ));
            };
            let (Some(trust), Some(redirect)) =
                (portal.state.sign.eidas.trust.clone(), redirect_uri(portal))
            else {
                return Ok(unconfigured());
            };
            let db = &signer.workspace.db;
            let recipient_id = text(&current.recipient, "id");
            let envelope_id = text(&current.envelope, "id");
            if portal_mode(&current.envelope, &current.recipient, now_ms()) != "sign" {
                return Err(SignError::Conflict(
                    "This request cannot be signed now".to_owned(),
                ));
            }
            if !has_consented(db, recipient_id).await? {
                return Err(SignError::Conflict(
                    "Agree to sign electronically first".to_owned(),
                ));
            }
            // Refuse an incomplete submission now, not after the provider.
            let fields = own_fields(db, envelope_id, recipient_id).await?;
            resolve_submission(
                &fields,
                &current.recipient,
                &input,
                (
                    input.signature.as_ref().map(|_| "pending"),
                    input.initials.as_ref().map(|_| "pending"),
                ),
                now_ms(),
            )?;
            let state = random_token()?;
            let verifier = random_token()?;
            let url = trust
                .identify_url(&IdentifyRequest {
                    level,
                    redirect_uri: &redirect,
                    state: &state,
                    code_challenge: &challenge(&verifier),
                    signer_name: current.recipient["name"].as_str(),
                    signer_email: current.recipient["email"].as_str(),
                    locale: current.recipient["locale"].as_str().unwrap_or("en"),
                })
                .map_err(|e| SignError::Conflict(e.message))?;
            save(
                portal.codes().as_ref(),
                &state,
                &Pending {
                    step: "identify".to_owned(),
                    envelope_id: envelope_id.to_owned(),
                    recipient_id: recipient_id.to_owned(),
                    level: level.as_str().to_owned(),
                    submission: raw,
                    verifier,
                    credential: None,
                    base_key: None,
                    revision_key: None,
                    byte_range: None,
                    signed_attributes: None,
                },
            )
            .await?;
            note(
                db,
                &signer,
                "signature_started",
                json!({ "level": level.as_str(), "provider": trust.provider() }),
            )
            .await?;
            Ok(ok(json!({ "redirectUrl": url, "state": state })))
        })
        .await
}

/// `POST /signature/finish`.
#[allow(
    clippy::too_many_lines,
    reason = "the two callbacks and their failures, in one place"
)]
pub(super) async fn finish(portal: Portal, body: Bytes) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            let read = parse(&body, |issues, body| {
                let state = issues.text(body, "state", Presence::Required, Some(1), Some(200));
                let code = issues.text(body, "code", Presence::Nullish, Some(1), Some(4000));
                let error = issues.text(body, "error", Presence::Nullish, None, Some(200));
                let description = issues.text(
                    body,
                    "errorDescription",
                    Presence::Nullish,
                    None,
                    Some(1000),
                );
                (
                    state.into_option().unwrap_or_default(),
                    code.into_option(),
                    error.into_option(),
                    description.into_option(),
                )
            });
            let (state, code, error, description) = match read {
                Ok(read) => read,
                Err(invalid) => return Ok(invalid.into_response()),
            };
            let cache = portal.codes();
            let Some(pending) = load(cache.as_ref(), &state).await else {
                return Ok(failed("This signing attempt has expired. Start again."));
            };
            if pending.recipient_id != signer.session.recipient_id
                || pending.envelope_id != signer.session.envelope_id
            {
                return Ok(failed("This signing attempt belongs to someone else."));
            }
            let (Some(trust), Some(redirect)) =
                (portal.state.sign.eidas.trust.clone(), redirect_uri(portal))
            else {
                return Ok(unconfigured());
            };
            let db = signer.workspace.db.clone();
            if let Some(error) = error {
                forget(cache.as_ref(), &state).await;
                note(
                    &db,
                    &signer,
                    "signature_failed",
                    json!({ "step": pending.step, "error": error, "provider": trust.provider() }),
                )
                .await?;
                tracing::info!(
                    error,
                    description,
                    "sign: the provider sent the signer back with an error"
                );
                return Ok(failed(if error == "access_denied" {
                    "You stopped at your provider. Nothing was signed."
                } else {
                    "Your provider could not complete the signature. Try again."
                }));
            }
            let Some(code) = code else {
                return Ok(failed("The provider sent no answer. Try again."));
            };
            let level = Level::parse(&pending.level).unwrap_or(Level::Qes);
            let callback = Callback {
                code: &code,
                redirect_uri: &redirect,
                code_verifier: &pending.verifier,
            };
            let step = if pending.step == "identify" {
                identified(
                    portal,
                    &signer,
                    trust.as_ref(),
                    level,
                    callback,
                    &pending,
                    &redirect,
                )
                .await
            } else {
                authorized(portal, &signer, trust.as_ref(), level, callback, &pending).await
            };
            forget(cache.as_ref(), &state).await;
            match step {
                Ok(Step::Next {
                    redirect_url,
                    state: next,
                    pending,
                }) => {
                    save(cache.as_ref(), &next, &pending).await?;
                    Ok(ok(json!({ "redirectUrl": redirect_url, "state": next })))
                }
                Ok(Step::Done(response)) => Ok(response),
                Err(StepError::Provider(message)) => {
                    note(
                        &db,
                        &signer,
                        "signature_failed",
                        json!({ "step": pending.step, "provider": trust.provider() }),
                    )
                    .await?;
                    tracing::warn!(message, "sign: a provider step failed");
                    Ok(failed(&message))
                }
                Err(StepError::Sign(error)) => Err(error),
            }
        })
        .await
}

enum Step {
    Next {
        redirect_url: String,
        state: String,
        pending: Box<Pending>,
    },
    Done(Response),
}

enum StepError {
    /// The provider refused or failed: the signer may try again.
    Provider(String),
    Sign(SignError),
}

impl From<SignError> for StepError {
    fn from(error: SignError) -> Self {
        Self::Sign(error)
    }
}

fn internal(error: impl std::fmt::Display) -> StepError {
    StepError::Sign(SignError::Internal(error.to_string()))
}

/// After the first callback: the credential, the revision, the second redirect.
#[allow(clippy::too_many_lines, reason = "one step at the provider, in order")]
async fn identified(
    portal: &Portal,
    signer: &Signer,
    trust: &dyn TrustService,
    level: Level,
    callback: Callback<'_>,
    pending: &Pending,
    redirect: &str,
) -> Result<Step, StepError> {
    let credential = trust.identified(level, callback).await.map_err(|e| {
        StepError::Provider(if e.cancelled {
            "You stopped at your provider. Nothing was signed.".to_owned()
        } else {
            format!("Your provider could not identify you: {}", e.message)
        })
    })?;
    let current = Portal::current(signer).await?;
    let db = &signer.workspace.db;
    let envelope = &current.envelope;
    let envelope_id = text(envelope, "id");
    let recipient_id = text(&current.recipient, "id");
    let base_key = text(envelope, "preparedStorageKey").to_owned();
    if base_key.is_empty() {
        return Err(StepError::Sign(SignError::Conflict(
            "This request was not prepared for this signature level".to_owned(),
        )));
    }
    let ctx = portal.send_context(&signer.workspace, &signer.session.org_id)?;
    let bucket = portal.private_bucket()?;
    let base = bucket
        .get_boxed(&base_key)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal("the prepared PDF is missing"))?
        .bytes;

    // Everyone's values so far, and this signer's, as they will be saved.
    let documents = list_documents(db, envelope_id).await?;
    let all_fields = list_fields(db, envelope_id).await?;
    let mut fills = eidas::stored_fills(&ctx, &all_fields).await?;
    let input = submission_of(pending)?;
    let own = own_fields(db, envelope_id, recipient_id).await?;
    let resolved = resolve_submission(
        &own,
        &current.recipient,
        &input,
        (
            input.signature.as_ref().map(|_| "pending"),
            input.initials.as_ref().map(|_| "pending"),
        ),
        now_ms(),
    )?;
    for (field_id, value) in resolved {
        let Some(field) = own.iter().find(|f| f["id"] == field_id.as_str()) else {
            continue;
        };
        let image = match (value.signature_key.is_some(), text(field, "type")) {
            (true, "signature") => input.signature.as_ref().map(png_bytes).transpose()?,
            (true, "initials") => input.initials.as_ref().map(png_bytes).transpose()?,
            _ => None,
        };
        fills.push(Fill {
            field: field.clone(),
            value: value.value,
            image,
        });
    }
    let mut revision = Revision::open(base).map_err(internal)?;
    eidas::fill_revision(&mut revision, &documents, &fills)?;
    let field = revision.find_field(&eidas::signature_field_name(recipient_id));
    let certificate = &credential.identity.certificate;
    // A qualified signature needs a qualified certificate with its key in a
    // QSCD; anything less is refused before the signer authorises anything.
    if level == Level::Qes && !certificate.qualified_with_qscd() {
        return Err(StepError::Provider(
            "Your provider did not issue a qualified certificate, so this cannot be a qualified signature."
                .to_owned(),
        ));
    }
    let prepared = prepare_signature(
        revision,
        &SignatureSpec {
            field_name: eidas::signature_field_name(recipient_id),
            field,
            kind: SignatureKind::Cades {
                name: Some(certificate.subject.display()),
                reason: Some("Signed with WeldSign".to_owned()),
                location: None,
                signing_time: OffsetDateTime::now_utc(),
            },
            contents_size: SIGNATURE_SIZE,
        },
        certificate,
        &credential.identity.chain,
    )
    .map_err(internal)?;
    let revision_key = eidas::new_prepared_key(&signer.session.org_id, envelope_id);
    bucket
        .put_boxed(
            &revision_key,
            prepared.prepared.bytes().to_vec(),
            &PutOptions::content_type("application/pdf"),
        )
        .await
        .map_err(internal)?;

    let state = random_token()?;
    let verifier = random_token()?;
    let url = trust
        .authorize_url(&AuthorizeRequest {
            credential: &credential,
            data_to_be_signed: prepared.data_to_be_signed(),
            redirect_uri: redirect,
            state: &state,
            code_challenge: &challenge(&verifier),
            description: text(envelope, "title"),
            locale: current.recipient["locale"].as_str().unwrap_or("en"),
        })
        .map_err(|e| StepError::Provider(e.message))?;
    Ok(Step::Next {
        redirect_url: url,
        state,
        pending: Box::new(Pending {
            step: "authorize".to_owned(),
            verifier,
            credential: Some(StoredCredential::of(&credential)),
            base_key: Some(base_key),
            revision_key: Some(revision_key),
            byte_range: Some(prepared.prepared.byte_range()),
            signed_attributes: Some(STANDARD.encode(&prepared.signed_attributes)),
            ..pending.clone()
        }),
    })
}

/// After the second callback: sign, store the revision, then `/complete`.
#[allow(clippy::too_many_lines, reason = "one step at the provider, in order")]
async fn authorized(
    portal: &Portal,
    signer: &Signer,
    trust: &dyn TrustService,
    level: Level,
    callback: Callback<'_>,
    pending: &Pending,
) -> Result<Step, StepError> {
    let (Some(stored), Some(base_key), Some(revision_key), Some(byte_range), Some(attributes)) = (
        &pending.credential,
        &pending.base_key,
        &pending.revision_key,
        pending.byte_range,
        &pending.signed_attributes,
    ) else {
        return Err(internal("the pending signature is incomplete"));
    };
    let credential = stored.credential()?;
    let signed_attributes = STANDARD.decode(attributes).map_err(internal)?;
    let value = trust
        .sign_authorized(&credential, &signed_attributes, callback)
        .await
        .map_err(|e| {
            StepError::Provider(if e.cancelled {
                "You stopped at your provider. Nothing was signed.".to_owned()
            } else {
                format!("Your provider could not sign: {}", e.message)
            })
        })?;
    let token = match trust
        .timestamp(&signing::signature_timestamp_digest(&value))
        .await
    {
        Ok(token) => token,
        Err(error) => {
            tracing::warn!(%error, "sign: no timestamp on a signer's signature");
            None
        }
    };
    let bucket = portal.private_bucket()?;
    let bytes = bucket
        .get_boxed(revision_key)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal("the pending revision is missing"))?
        .bytes;
    let prepared = Prepared::from_parts(bytes, byte_range).map_err(internal)?;
    let signed_pdf = PendingSignature {
        prepared,
        signed_attributes,
        signer: credential.identity.certificate.clone(),
        chain: credential.identity.chain.clone(),
    }
    .finish(&value, token.as_deref())
    .map_err(|e| {
        StepError::Provider(format!(
            "The signature from your provider does not fit: {e}"
        ))
    })?;

    // The revision becomes current only if nobody added one meanwhile.
    let envelope_id = &signer.session.envelope_id;
    let new_key = eidas::new_prepared_key(&signer.session.org_id, envelope_id);
    bucket
        .put_boxed(
            &new_key,
            signed_pdf,
            &PutOptions::content_type("application/pdf"),
        )
        .await
        .map_err(internal)?;
    let _ = bucket.delete_boxed(revision_key).await;
    let db = &signer.workspace.db;
    let swapped = sign_envelopes::Entity::update_many()
        .col_expr(
            sign_envelopes::Column::PreparedStorageKey,
            Expr::value(&new_key),
        )
        .filter(sign_envelopes::Column::Id.eq(envelope_id.as_str()))
        .filter(sign_envelopes::Column::PreparedStorageKey.eq(base_key.as_str()))
        .exec(&orm(db))
        .await
        .map_err(SignError::from)?;
    if swapped.rows_affected == 0 {
        let _ = bucket.delete_boxed(&new_key).await;
        return Err(StepError::Provider(
            "Someone else signed at the same moment. Please sign again.".to_owned(),
        ));
    }

    let input = submission_of(pending)?;
    match portal.complete_submission(signer, &input).await {
        Ok(response) => {
            let now = OffsetDateTime::now_utc();
            let certificate = credential.identity.certificate.clone();
            let details = json!({
                "level": level.as_str(),
                "provider": trust.provider(),
                "certificateSubject": certificate.subject.display(),
                "certificateIssuer": certificate.issuer.display(),
                "certificateSerial": certificate.serial_hex(),
                "qualified": certificate.qualified_with_qscd(),
                "timestamped": token.is_some(),
            });
            eidas::insert_records(
                db,
                envelope_id,
                vec![Record {
                    recipient_id: Some(signer.session.recipient_id.clone()),
                    kind: "signature",
                    level: Some(level.as_str().to_owned()),
                    document: "final",
                    provider: Some(trust.provider().to_owned()),
                    certificate: Some(certificate),
                    identity_method: credential.identity_method.clone(),
                    signed_at: Some(now),
                    timestamp_at: token.as_ref().map(|_| now),
                }],
            )
            .await?;
            note(db, signer, "signature_applied", details).await?;
            tracing::info!(
                envelope_id,
                level = level_name(level),
                "sign: a signature was applied at the provider"
            );
            Ok(Step::Done(response))
        }
        Err(error) => {
            // The values did not land: the revision goes back.
            let _ = sign_envelopes::Entity::update_many()
                .col_expr(
                    sign_envelopes::Column::PreparedStorageKey,
                    Expr::value(base_key.as_str()),
                )
                .filter(sign_envelopes::Column::Id.eq(envelope_id.as_str()))
                .filter(sign_envelopes::Column::PreparedStorageKey.eq(&new_key))
                .exec(&orm(db))
                .await;
            Err(StepError::Sign(error))
        }
    }
}

/// `POST /signature/cancel`.
pub(super) async fn cancel(portal: Portal, body: Bytes) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            let state = match parse(&body, |issues, body| {
                issues
                    .text(body, "state", Presence::Required, Some(1), Some(200))
                    .into_option()
                    .unwrap_or_default()
            }) {
                Ok(state) => state,
                Err(invalid) => return Ok(invalid.into_response()),
            };
            let cache = portal.codes();
            if let Some(pending) = load(cache.as_ref(), &state).await
                && pending.recipient_id == signer.session.recipient_id
            {
                forget(cache.as_ref(), &state).await;
                note(
                    &signer.workspace.db,
                    &signer,
                    "signature_failed",
                    json!({ "step": pending.step, "cancelled": true }),
                )
                .await?;
            }
            Ok(StatusCode::NO_CONTENT.into_response())
        })
        .await
}

/// `GET /evidence`: the evidence report of a completed request.
pub(super) async fn evidence(portal: Portal) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            let current = Portal::current(&signer).await?;
            let envelope = &current.envelope;
            let key = text(envelope, "evidenceStorageKey");
            if envelope["status"] != "completed" || key.is_empty() {
                return Err(SignError::NotFound("Evidence report"));
            }
            let bucket = portal.private_bucket()?;
            let object = bucket
                .get_boxed(key)
                .await
                .map_err(|e| SignError::Internal(e.to_string()))?
                .ok_or(SignError::NotFound("Evidence report"))?;
            Ok(pdf(object.bytes, None))
        })
        .await
}
