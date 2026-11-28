//! The signed references of online invoice payments (ADR BOOKS-013): what
//! Mollie and the merchant's browser carry back to a public route that has
//! no session. Stateless, like [`crate::document_token`], and signed with the
//! same secret ([`crate::document_token::secret`]) under another purpose, so a
//! document link can never stand in for one of these.
//!
//! `base64url(json {v, k, ws, e, i, u, r, x}) "." base64url(HMAC-SHA256)`:
//!
//! - **webhook** (`k = mollie-webhook`): the workspace (`ws`, `workspaces.id`),
//!   the legal entity (`e`) and the invoice (`i`) a Mollie payment was made for.
//!   Never expires: Mollie posts a payment's changes for as long as it lives.
//!   It is the `{signedRef}` of `POST /public/weldbooks/mollie/webhook/{signedRef}`.
//! - **connect** (`k = mollie-connect`): the OAuth `state` of Mollie Connect:
//!   the workspace, the entity, the member (`u`), where to send the browser
//!   back to (`r`) and an expiry (`x`, ten minutes).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// The purpose of a webhook reference.
pub const WEBHOOK: &str = "mollie-webhook";
/// The purpose of the OAuth state.
pub const CONNECT: &str = "mollie-connect";

/// How long an OAuth state is valid.
pub const CONNECT_TTL_SECONDS: i64 = 600;

const VERSION: u8 = 1;

/// What a reference says (the field names are the wire format).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayRef {
    pub v: u8,
    /// The purpose: [`WEBHOOK`] or [`CONNECT`].
    pub k: String,
    /// `workspaces.id`.
    pub ws: String,
    /// The legal entity.
    pub e: String,
    /// The invoice (webhook).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i: Option<String>,
    /// The member who started the connection (connect).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub u: Option<String>,
    /// Where to send the browser back to (connect).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r: Option<String>,
    /// Expiry, seconds since the epoch (connect).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i64>,
}

impl PayRef {
    fn base(kind: &str, workspace_id: &str, entity_id: &str) -> Self {
        Self {
            v: VERSION,
            k: kind.to_owned(),
            ws: workspace_id.to_owned(),
            e: entity_id.to_owned(),
            i: None,
            u: None,
            r: None,
            x: None,
        }
    }

    /// The reference of Mollie's webhook for a payment of `invoice_id`.
    pub fn webhook(workspace_id: &str, entity_id: &str, invoice_id: &str) -> Self {
        Self {
            i: Some(invoice_id.to_owned()),
            ..Self::base(WEBHOOK, workspace_id, entity_id)
        }
    }

    /// The OAuth state of a member connecting `entity_id`, valid ten minutes
    /// from `now_secs`.
    pub fn connect(
        workspace_id: &str,
        entity_id: &str,
        user_id: &str,
        return_to: &str,
        now_secs: i64,
    ) -> Self {
        Self {
            u: Some(user_id.to_owned()),
            r: Some(return_to.to_owned()),
            x: Some(now_secs + CONNECT_TTL_SECONDS),
            ..Self::base(CONNECT, workspace_id, entity_id)
        }
    }
}

fn mac(secret: &[u8], kind: &str, payload: &str) -> Hmac<Sha256> {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(secret).expect("HMAC takes a key of any length");
    // The purpose is part of what is signed: a reference of one kind is not
    // a valid reference of another, nor a document token.
    mac.update(kind.as_bytes());
    mac.update(b"|");
    mac.update(payload.as_bytes());
    mac
}

/// The reference text.
///
/// # Panics
///
/// Never in practice: a reference of strings always serializes.
pub fn sign(secret: &[u8], reference: &PayRef) -> String {
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(reference).expect("a reference of strings serializes"));
    let signature =
        URL_SAFE_NO_PAD.encode(mac(secret, &reference.k, &payload).finalize().into_bytes());
    format!("{payload}.{signature}")
}

/// What `text` says, when `secret` signed it for `kind` and it has not
/// expired at `now_secs`. Every failure is the same `None`: the public routes
/// answer it with one 404.
pub fn verify(secret: &[u8], text: &str, kind: &str, now_secs: i64) -> Option<PayRef> {
    if text.len() > 512 {
        return None;
    }
    let (payload, signature) = text.split_once('.')?;
    let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
    mac(secret, kind, payload).verify_slice(&signature).ok()?;
    let reference: PayRef = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    if reference.v != VERSION || reference.k != kind {
        return None;
    }
    if reference.x.is_some_and(|expires| expires < now_secs) {
        return None;
    }
    Some(reference)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    /// A secret made at run time: a test needs a secret, not a particular one.
    static SECRET: std::sync::LazyLock<Vec<u8>> =
        std::sync::LazyLock::new(|| crate::document_token::new_nonce().into_bytes());

    #[test]
    fn a_webhook_reference_round_trips_under_its_secret_and_purpose_only() {
        let reference = PayRef::webhook("ws_1", "ent_1", "inv_1");
        let text = sign(&SECRET, &reference);
        assert_eq!(verify(&SECRET, &text, WEBHOOK, 0), Some(reference));
        assert_eq!(
            verify(
                crate::document_token::new_nonce().as_bytes(),
                &text,
                WEBHOOK,
                0
            ),
            None
        );
        assert_eq!(verify(&SECRET, &text, CONNECT, 0), None);
        assert_eq!(verify(&SECRET, "nope", WEBHOOK, 0), None);
        assert_eq!(verify(&SECRET, &"a.".repeat(300), WEBHOOK, 0), None);
    }

    #[test]
    fn a_tampered_reference_is_refused() {
        let text = sign(&SECRET, &PayRef::webhook("ws_1", "ent_1", "inv_1"));
        let (payload, signature) = text.split_once('.').unwrap();
        let forged = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&PayRef::webhook("ws_2", "ent_1", "inv_1")).unwrap());
        assert_eq!(
            verify(&SECRET, &format!("{forged}.{signature}"), WEBHOOK, 0),
            None
        );
        assert_eq!(verify(&SECRET, payload, WEBHOOK, 0), None);
    }

    #[test]
    fn a_connect_state_expires_after_ten_minutes() {
        let reference = PayRef::connect("ws_1", "ent_1", "user_1", "/settings", 1_000);
        let text = sign(&SECRET, &reference);
        assert_eq!(
            verify(&SECRET, &text, CONNECT, 1_000 + 599),
            Some(reference)
        );
        assert_eq!(verify(&SECRET, &text, CONNECT, 1_000 + 601), None);
    }
}
