//! Signed tokens of the online store, keyed by the install's
//! `STOREFRONT_RENDERER_SECRET` with a purpose label so one token can never
//! stand in for another:
//!
//! - a **preview token** lets the editor's iframe see a site's draft:
//!   `<site id>.<workspace id>.<expiry>.<signature>`, an hour long;
//! - a **visitor pass** opens a password-protected shop:
//!   `<host>.<password hash digest>.<expiry>.<signature>`, a week long; a
//!   new password invalidates every pass.
//!
//! Shop passwords are stored as `<salt>$<hex(HMAC-SHA256(salt, password))>`
//! keyed by the secret, compared in constant time.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use time::OffsetDateTime;

type HmacSha256 = Hmac<Sha256>;

/// How long a preview link works.
pub(crate) const PREVIEW_SECONDS: i64 = 60 * 60;
/// How long a visitor pass for a password-protected shop lasts.
pub(crate) const PASS_SECONDS: i64 = 7 * 24 * 60 * 60;

fn mac(secret: &str, purpose: &str, payload: &str) -> Option<String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(purpose.as_bytes());
    mac.update(b"\n");
    mac.update(payload.as_bytes());
    Some(hex::encode(mac.finalize().into_bytes()))
}

/// Constant-time comparison of two strings.
pub(crate) fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0_u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

/// A preview token for `site_id` in `workspace_id`, and when it expires
/// (Unix seconds).
pub(crate) fn preview_token(
    secret: &str,
    site_id: &str,
    workspace_id: &str,
) -> Option<(String, i64)> {
    let expires = now() + PREVIEW_SECONDS;
    let payload = format!("{site_id}.{workspace_id}.{expires}");
    let signature = mac(secret, "preview", &payload)?;
    Some((format!("{payload}.{signature}"), expires))
}

/// The site and workspace a valid, unexpired preview token names.
pub(crate) fn verify_preview(secret: &str, token: &str) -> Option<(String, String)> {
    let (payload, signature) = token.rsplit_once('.')?;
    if !same(&mac(secret, "preview", payload)?, signature) {
        return None;
    }
    let mut fields = payload.split('.');
    let (site, workspace, expires) = (fields.next()?, fields.next()?, fields.next()?);
    if fields.next().is_some() || expires.parse::<i64>().ok()? < now() {
        return None;
    }
    Some((site.to_owned(), workspace.to_owned()))
}

/// The stored form of a shop password.
pub(crate) fn hash_password(secret: &str, password: &str) -> Option<String> {
    let salt = weldsuite_kit::portal::tokens::random_token(12);
    let salt = hex::encode(salt);
    let digest = mac(secret, &format!("password:{salt}"), password)?;
    Some(format!("{salt}${digest}"))
}

/// `password` matches the stored hash.
pub(crate) fn check_password(secret: &str, stored: &str, password: &str) -> bool {
    let Some((salt, digest)) = stored.split_once('$') else {
        return false;
    };
    mac(secret, &format!("password:{salt}"), password).is_some_and(|ours| same(&ours, digest))
}

/// A short digest of the stored hash, so a new password ends old passes.
fn hash_tag(stored: &str) -> String {
    stored.chars().rev().take(12).collect()
}

/// A visitor pass for `host`, given the shop's stored password hash.
pub(crate) fn visitor_pass(secret: &str, host: &str, stored: &str) -> Option<String> {
    let expires = now() + PASS_SECONDS;
    let payload = format!("{}.{expires}", hash_tag(stored));
    let signature = mac(secret, &format!("pass:{host}"), &payload)?;
    Some(format!("{payload}.{signature}"))
}

/// The pass is valid for `host` and the current password.
pub(crate) fn verify_pass(secret: &str, host: &str, stored: &str, pass: &str) -> bool {
    let Some((payload, signature)) = pass.rsplit_once('.') else {
        return false;
    };
    let Some(ours) = mac(secret, &format!("pass:{host}"), payload) else {
        return false;
    };
    if !same(&ours, signature) {
        return false;
    }
    let Some((tag, expires)) = payload.split_once('.') else {
        return false;
    };
    tag == hash_tag(stored) && expires.parse::<i64>().is_ok_and(|e| e >= now())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key made at run time from random bytes: the tests depend on no
    /// fixed secret.
    fn key() -> String {
        weldsuite_kit::portal::tokens::random_token(32)
    }

    #[test]
    fn preview_tokens_round_trip_and_refuse_tampering() {
        let (secret, other) = (key(), key());
        let (token, expires) = preview_token(&secret, "sfs_1", "ws_1").expect("token");
        assert!(expires > now());
        assert_eq!(
            verify_preview(&secret, &token),
            Some(("sfs_1".to_owned(), "ws_1".to_owned()))
        );
        assert_eq!(verify_preview(&other, &token), None);
        let tampered = token.replace("sfs_1", "sfs_2");
        assert_eq!(verify_preview(&secret, &tampered), None);
        assert_eq!(verify_preview(&secret, "garbage"), None);
    }

    #[test]
    fn passwords_and_passes() {
        let (secret, other) = (key(), key());
        // The shop's passwords are made at run time too; `almost` is the
        // password without its last character.
        let (password, new_password) = (key(), key());
        let almost = &password[..password.len() - 1];
        let stored = hash_password(&secret, &password).expect("hash");
        assert!(check_password(&secret, &stored, &password));
        assert!(!check_password(&secret, &stored, almost));
        assert!(!check_password(&other, &stored, &password));
        let pass = visitor_pass(&secret, "shop.example.com", &stored).expect("pass");
        assert!(verify_pass(&secret, "shop.example.com", &stored, &pass));
        assert!(!verify_pass(&secret, "other.example.com", &stored, &pass));
        let changed = hash_password(&secret, &new_password).expect("hash");
        assert!(!verify_pass(&secret, "shop.example.com", &changed, &pass));
    }

    #[test]
    fn comparison_is_exact() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }
}
