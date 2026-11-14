//! Pay links (ADR BILL-014, dunning): `GET /public/billing/pay/<token>` opens
//! a Mollie checkout for a past-due charge without signing in, so the link
//! can go in an email, like Stripe's hosted invoice page on Global.
//!
//! The token names the `billing_payments` row still to be paid and an
//! expiry, signed with HMAC-SHA256 under `BILLING_PAY_LINK_KEY`. It grants
//! nothing but paying that charge: the route checks the row is still the
//! workspace's open charge before it creates a payment.

use aws_lc_rs::hmac;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

/// Where pay links are served.
pub const PAY_PATH: &str = "/public/billing/pay";

/// How long a pay link works: past the dunning window, so the last email's
/// link still opens.
pub const PAY_LINK_TTL_SECONDS: i64 = 30 * 24 * 3600;

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    /// The `billing_payments` row to pay.
    p: String,
    /// Expiry, unix seconds.
    e: i64,
}

/// Signs and checks pay links.
#[derive(Clone)]
pub struct PayLinks {
    key: hmac::Key,
}

impl std::fmt::Debug for PayLinks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PayLinks")
    }
}

impl PayLinks {
    /// `secret` is `BILLING_PAY_LINK_KEY`, at least 32 bytes.
    pub fn new(secret: &str) -> Option<Self> {
        (secret.len() >= 32).then(|| Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
        })
    }

    /// A token for paying `payment_row_id`, valid until `expires_at` (unix seconds).
    pub fn sign(&self, payment_row_id: &str, expires_at: i64) -> String {
        let claims = Claims {
            p: payment_row_id.to_owned(),
            e: expires_at,
        };
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap_or_default());
        let signature = hmac::sign(&self.key, payload.as_bytes());
        format!("{payload}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }

    /// The row a token names, when its signature holds and it hasn't
    /// expired at `now` (unix seconds).
    pub fn verify(&self, token: &str, now: i64) -> Option<String> {
        let (payload, signature) = token.split_once('.')?;
        let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
        hmac::verify(&self.key, payload.as_bytes(), &signature).ok()?;
        let claims: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
        (claims.e > now && !claims.p.is_empty()).then_some(claims.p)
    }

    /// The link for `payment_row_id`, under `public_url` (the platform's
    /// origin, which serves the API on the Kubernetes editions).
    pub fn url(&self, public_url: &str, payment_row_id: &str, now: i64) -> String {
        format!(
            "{}{PAY_PATH}/{}",
            public_url.trim_end_matches('/'),
            self.sign(payment_row_id, now + PAY_LINK_TTL_SECONDS)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn a_token_names_its_row_until_it_expires() {
        let links = PayLinks::new(KEY).expect("key");
        let token = links.sign("bpy_1", 2_000);
        assert_eq!(links.verify(&token, 1_999).as_deref(), Some("bpy_1"));
        assert_eq!(links.verify(&token, 2_000), None, "expired");
        let url = links.url("https://app.weldsuite.eu/", "bpy_1", 1_000);
        assert!(url.starts_with("https://app.weldsuite.eu/public/billing/pay/"));
    }

    #[test]
    fn tampered_or_foreign_tokens_are_refused() {
        let links = PayLinks::new(KEY).expect("key");
        let token = links.sign("bpy_1", 2_000);
        let (payload, signature) = token.split_once('.').expect("two parts");
        let forged_payload = URL_SAFE_NO_PAD.encode(br#"{"p":"bpy_2","e":2000}"#);
        assert_eq!(
            links.verify(&format!("{forged_payload}.{signature}"), 1),
            None
        );
        assert_eq!(links.verify(&format!("{payload}.AAAA"), 1), None);
        assert_eq!(links.verify("garbage", 1), None);
        let other = PayLinks::new("another key that is long enough!!").expect("key");
        assert_eq!(other.verify(&token, 1), None);
        assert!(PayLinks::new("short").is_none());
    }
}
