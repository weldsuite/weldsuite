//! Read credentials for private objects, HMAC-SHA256 under
//! `STORAGE_SIGNING_KEY` (`packages/core/worker-kit/src/storage.ts`): the
//! per-workspace files cookie and the short-lived signed URL. Each signs its
//! own purpose string, so a cookie value never verifies as a URL signature
//! or the other way round. Values are byte for byte the TypeScript ones, so
//! a cookie or URL from either backend opens objects on the other.

use std::time::{SystemTime, UNIX_EPOCH};

use aws_lc_rs::{constant_time, hmac};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use weldsuite_kit::validation::js_number;

use super::PRIVATE_OBJECT_PATH;
use crate::private_object_url;

/// Name of the per-workspace files cookie (one per workspace, path-scoped).
pub(crate) const FILES_COOKIE: &str = "ws_files";

/// Files cookie lifetime (`FILES_COOKIE_TTL_SECONDS`).
pub(crate) const FILES_COOKIE_TTL_SECONDS: i64 = 60 * 60;

/// Default and maximum lifetime of a signed object URL.
pub(crate) const SIGNED_URL_TTL_SECONDS: i64 = 15 * 60;
pub(crate) const SIGNED_URL_MAX_TTL_SECONDS: i64 = 24 * 60 * 60;

/// `Math.floor(Date.now() / 1000)`.
pub(crate) fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
        })
}

fn hmac_text(secret: &str, message: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    URL_SAFE_NO_PAD.encode(hmac::sign(&key, message.as_bytes()).as_ref())
}

/// `safeEqual`: the same bytes, compared without an early exit.
fn safe_equal(a: &str, b: &str) -> bool {
    constant_time::verify_slices_are_equal(a.as_bytes(), b.as_bytes()).is_ok()
}

fn cookie_message(workspace_id: &str, exp: i64) -> String {
    format!("ws-files-cookie:v1:{workspace_id}:{exp}")
}

fn url_message(key: &str, exp: i64) -> String {
    format!("ws-files-url:v1:{key}:{exp}")
}

/// `Number(text)` when it is an integer JavaScript prints as plain digits;
/// `None` otherwise (`Number.isInteger` fails, or it is too large for the
/// server ever to have signed it).
fn js_integer(text: &str) -> Option<i64> {
    let number = js_number(text);
    if !number.is_finite() || number.fract() != 0.0 || number.abs() >= 9.0e15 {
        return None;
    }
    // Checked as an integer of at most 2^53 above.
    #[allow(clippy::cast_possible_truncation)]
    Some(number as i64)
}

/// `signFilesCookie`: a cookie value granting read access to one
/// workspace's private objects, and when it lapses.
pub(crate) fn sign_files_cookie(secret: &str, workspace_id: &str, now: i64) -> (String, i64) {
    let exp = now + FILES_COOKIE_TTL_SECONDS;
    let sig = hmac_text(secret, &cookie_message(workspace_id, exp));
    (format!("v1.{workspace_id}.{exp}.{sig}"), exp)
}

/// `verifyFilesCookie`: an unexpired files cookie for `workspace_id`.
pub(crate) fn verify_files_cookie(secret: &str, value: &str, workspace_id: &str, now: i64) -> bool {
    let mut parts = value.split('.');
    let (Some(version), Some(ws), exp_raw, sig) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Some(sig) = sig.filter(|sig| !sig.is_empty()) else {
        return false;
    };
    if version != "v1" || ws != workspace_id {
        return false;
    }
    // `Number(undefined)` is NaN.
    let Some(exp) = exp_raw.and_then(js_integer) else {
        return false;
    };
    if exp < now {
        return false;
    }
    safe_equal(sig, &hmac_text(secret, &cookie_message(ws, exp)))
}

/// `filesCookiePath`: the Path a workspace's files cookie is scoped to.
pub(crate) fn files_cookie_path(workspace_id: &str) -> String {
    format!("{PRIVATE_OBJECT_PATH}workspaces/{workspace_id}/")
}

/// `signPrivateObjectUrl`: a short-lived URL reading one private object.
pub(crate) fn sign_private_object_url(
    secret: &str,
    origin: &str,
    key: &str,
    ttl_seconds: Option<i64>,
    now: i64,
) -> (String, i64) {
    let ttl = ttl_seconds
        .unwrap_or(SIGNED_URL_TTL_SECONDS)
        .clamp(1, SIGNED_URL_MAX_TTL_SECONDS);
    let exp = now + ttl;
    let sig = hmac_text(secret, &url_message(key, exp));
    (
        format!("{}?exp={exp}&sig={sig}", private_object_url(origin, key)),
        exp,
    )
}

/// `verifyPrivateObjectSignature`: `exp`/`sig` sign `key` and have not
/// lapsed (nor reach further than the longest lifetime).
pub(crate) fn verify_private_object_signature(
    secret: &str,
    key: &str,
    exp_raw: Option<&str>,
    sig: Option<&str>,
    now: i64,
) -> bool {
    let (Some(exp_raw), Some(sig)) = (
        exp_raw.filter(|v| !v.is_empty()),
        sig.filter(|v| !v.is_empty()),
    ) else {
        return false;
    };
    let Some(exp) = js_integer(exp_raw) else {
        return false;
    };
    if exp < now || exp > now + SIGNED_URL_MAX_TTL_SECONDS {
        return false;
    }
    safe_equal(sig, &hmac_text(secret, &url_message(key, exp)))
}

/// `cookieValues`: every value of cookie `name` in a `Cookie` header
/// (path-scoped cookies can repeat).
pub(crate) fn cookie_values(header: Option<&str>, name: &str) -> Vec<String> {
    let Some(header) = header.filter(|h| !h.is_empty()) else {
        return Vec::new();
    };
    header
        .split(';')
        .filter_map(|part| {
            let (cookie, value) = part.split_once('=')?;
            (js_trim(cookie) == name).then(|| js_trim(value).to_owned())
        })
        .collect()
}

fn js_trim(text: &str) -> &str {
    weldsuite_kit::validation::js_trim(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-signing-key";
    const NOW: i64 = 1_793_271_652;

    #[test]
    fn cookies_verify_for_their_workspace_until_they_lapse() {
        let (value, exp) = sign_files_cookie(SECRET, "org_a", NOW);
        assert_eq!(exp, NOW + 3600);
        assert!(value.starts_with(&format!("v1.org_a.{exp}.")));
        assert!(verify_files_cookie(SECRET, &value, "org_a", NOW));
        assert!(verify_files_cookie(SECRET, &value, "org_a", exp));
        assert!(!verify_files_cookie(SECRET, &value, "org_a", exp + 1));
        assert!(!verify_files_cookie(SECRET, &value, "org_b", NOW));
        assert!(!verify_files_cookie("other-key", &value, "org_a", NOW));
        let forged = value.replace(&exp.to_string(), &(exp + 100).to_string());
        assert!(!verify_files_cookie(SECRET, &forged, "org_a", NOW));
        for bad in [
            "",
            "v1.org_a",
            "v1.org_a.123",
            "v2.org_a.9999999999.x",
            "v1.org_a.1.5.x",
        ] {
            assert!(!verify_files_cookie(SECRET, bad, "org_a", NOW), "{bad}");
        }
    }

    /// The signature `signFilesCookie('test-signing-key', 'org_a')` gives at
    /// exp 1793275252 (Node's `crypto.subtle`, base64url without padding).
    #[test]
    fn signatures_match_the_typescript_ones() {
        let (value, _) = sign_files_cookie(SECRET, "org_a", 1_793_271_652);
        assert_eq!(
            value,
            "v1.org_a.1793275252.QkEhIc2FKG1dCjNSGjuymyfqkv16kGkv8mDghK46E-w"
        );
    }

    #[test]
    fn signed_urls_verify_for_their_key_only() {
        let key = "workspaces/org_a/drive/a b.pdf";
        let (url, exp) = sign_private_object_url(SECRET, "https://api.example", key, None, NOW);
        assert_eq!(exp, NOW + 900);
        let (base, query) = url.split_once('?').expect("a query");
        assert_eq!(
            base,
            "https://api.example/api/storage/private/workspaces/org_a/drive/a%20b.pdf"
        );
        let sig = query.split_once("&sig=").expect("sig").1;
        let exp_text = exp.to_string();
        assert!(verify_private_object_signature(
            SECRET,
            key,
            Some(&exp_text),
            Some(sig),
            NOW
        ));
        assert!(!verify_private_object_signature(
            SECRET,
            "workspaces/org_a/other.pdf",
            Some(&exp_text),
            Some(sig),
            NOW
        ));
        assert!(!verify_private_object_signature(
            SECRET,
            key,
            Some(&exp_text),
            Some(sig),
            exp + 1
        ));
        assert!(!verify_private_object_signature(
            SECRET,
            key,
            None,
            Some(sig),
            NOW
        ));
        assert!(!verify_private_object_signature(
            SECRET,
            key,
            Some(&exp_text),
            Some(""),
            NOW
        ));
        // A lifetime beyond the maximum is refused even when signed.
        let (far, far_exp) = sign_private_object_url(SECRET, "http://x", key, Some(86_400), NOW);
        let far_sig = far.split_once("&sig=").expect("sig").1;
        assert!(verify_private_object_signature(
            SECRET,
            key,
            Some(&far_exp.to_string()),
            Some(far_sig),
            NOW
        ));
        assert!(!verify_private_object_signature(
            SECRET,
            key,
            Some(&far_exp.to_string()),
            Some(far_sig),
            NOW - 1
        ));
        // Clamped like `Math.min(Math.max(1, ttl), max)`.
        assert_eq!(
            sign_private_object_url(SECRET, "http://x", key, Some(0), NOW).1,
            NOW + 1
        );
        assert_eq!(
            sign_private_object_url(SECRET, "http://x", key, Some(10 * 86_400), NOW).1,
            NOW + 86_400
        );
    }

    #[test]
    fn cookie_headers_repeat() {
        assert_eq!(
            cookie_values(Some("a=1; ws_files=x ;ws_files= y; b"), FILES_COOKIE),
            vec!["x".to_owned(), "y".to_owned()]
        );
        assert_eq!(cookie_values(None, FILES_COOKIE), Vec::<String>::new());
        assert_eq!(cookie_values(Some(""), FILES_COOKIE), Vec::<String>::new());
    }
}
