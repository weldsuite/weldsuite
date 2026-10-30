//! Who may open a bundle that is not public + approved, and how
//! (`services/user-apps-bundle-access.ts`): a short-lived signed capability
//! in the URL path,
//!
//! ```text
//! /public/user-apps/:code/s/<exp>.<base64url(workspaceId)>.<sig>/<asset>
//! ```
//!
//! where `sig` is base64url(HMAC-SHA256(key, "uapp-bundle/v1\n<appId>\n
//! <workspaceId>\n<exp>")) and the key is HKDF-SHA256 of
//! `USER_APP_BUNDLE_SIGNING_KEY` (else `INTERNAL_API_SECRET`). Links minted
//! by either backend open on the other.
//!
//! Also here: the dedicated bundle origin and the `frame-ancestors` of
//! bundle responses.

use std::fmt::Write as _;
use std::sync::LazyLock;

use aws_lc_rs::{hkdf, hmac};
use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use regex::Regex;
use sqlx::PgPool;
use weldsuite_ports::DynCache;

/// How long a link stays valid (12 hours).
pub(crate) const BUNDLE_LINK_TTL_SECONDS: i64 = 12 * 60 * 60;

const HKDF_SALT: &[u8] = b"weldsuite-user-app-bundle";
const HKDF_INFO: &[u8] = b"weldsuite/app-api/user-app-bundle-capability/v1";
const SIGNED_PREFIX: &str = "uapp-bundle/v1";

/// `<exp>.<base64url(workspaceId)>.<sig>`; the signature is a 32 byte HMAC.
static TOKEN_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{1,12})\.([A-Za-z0-9_-]{1,96})\.([A-Za-z0-9_-]{43})$")
        .expect("the token pattern compiles")
});

/// `atob` on base64url: lenient about padding and trailing bits.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

fn is_workspace_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// True when `segment` has the shape of a bundle link token.
pub(crate) fn looks_like_bundle_token(segment: &str) -> bool {
    TOKEN_PATTERN.is_match(segment)
}

/// The signing material: the dedicated key, else `INTERNAL_API_SECRET`
/// (both trimmed); `None` when neither is set (links fail closed).
fn signing_key<'a>(env: impl Fn(&str) -> Option<&'a str>) -> Option<hmac::Key> {
    let material = env("USER_APP_BUNDLE_SIGNING_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env("INTERNAL_API_SECRET")
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })?;
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, HKDF_SALT).extract(material.as_bytes());
    let info = [HKDF_INFO];
    let okm = prk.expand(&info, hmac::HMAC_SHA256).ok()?;
    Some(hmac::Key::from(okm))
}

fn signed_data(app_id: &str, workspace_id: &str, exp: i64) -> String {
    format!("{SIGNED_PREFIX}\n{app_id}\n{workspace_id}\n{exp}")
}

/// A minted link: the token and its expiry in epoch milliseconds.
pub(crate) struct MintedLink {
    pub(crate) token: String,
    pub(crate) expires_at_ms: i64,
}

/// Sign a link for `workspace_id`'s access to `app_id`; `None` without a
/// signing secret (or a workspace id that can't be in a link).
pub(crate) fn sign_bundle_capability<'a>(
    env: impl Fn(&str) -> Option<&'a str>,
    app_id: &str,
    workspace_id: &str,
    now_ms: i64,
) -> Option<MintedLink> {
    if !is_workspace_id(workspace_id) {
        return None;
    }
    let key = signing_key(env)?;
    let exp = now_ms.div_euclid(1000) + BUNDLE_LINK_TTL_SECONDS;
    let tag = hmac::sign(&key, signed_data(app_id, workspace_id, exp).as_bytes());
    let token = format!(
        "{exp}.{}.{}",
        URL_SAFE_NO_PAD.encode(workspace_id.as_bytes()),
        URL_SAFE_NO_PAD.encode(tag.as_ref())
    );
    Some(MintedLink {
        token,
        expires_at_ms: exp * 1000,
    })
}

/// Why a link does not open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinkRefusal {
    Malformed,
    BadSignature,
    Expired,
    Unconfigured,
}

/// Check a link for `app_id`: the workspace and its expiry (epoch ms).
/// `Expired` is only reported for an authentic link.
pub(crate) fn verify_bundle_capability<'a>(
    env: impl Fn(&str) -> Option<&'a str>,
    app_id: &str,
    token: &str,
    now_ms: i64,
) -> Result<(String, i64), LinkRefusal> {
    let captures = TOKEN_PATTERN
        .captures(token)
        .ok_or(LinkRefusal::Malformed)?;
    let exp: i64 = captures[1].parse().map_err(|_| LinkRefusal::Malformed)?;
    let workspace = LENIENT
        .decode(&captures[2])
        .map_err(|_| LinkRefusal::Malformed)?;
    let signature = LENIENT
        .decode(&captures[3])
        .map_err(|_| LinkRefusal::Malformed)?;
    let workspace_id = String::from_utf8_lossy(&workspace).into_owned();
    if !is_workspace_id(&workspace_id) {
        return Err(LinkRefusal::Malformed);
    }
    let key = signing_key(env).ok_or(LinkRefusal::Unconfigured)?;
    hmac::verify(
        &key,
        signed_data(app_id, &workspace_id, exp).as_bytes(),
        &signature,
    )
    .map_err(|_| LinkRefusal::BadSignature)?;
    if exp * 1000 <= now_ms {
        return Err(LinkRefusal::Expired);
    }
    Ok((workspace_id, exp * 1000))
}

// ── who may open a non-public bundle ─────────────────────────────────────────

const ACCESS_CACHE_TTL_SECONDS: u64 = 60;

pub(crate) fn bundle_access_cache_key(app_id: &str, workspace_id: &str) -> String {
    format!("uapp-access:v1:{app_id}:{workspace_id}")
}

/// The authoring workspace, or one with an ACTIVE install of the app.
pub(crate) async fn workspace_may_use_bundle(
    master: &PgPool,
    app_id: &str,
    owner_workspace_id: &str,
    workspace_id: &str,
) -> Result<bool, sqlx::Error> {
    if owner_workspace_id == workspace_id {
        return Ok(true);
    }
    let install: Option<String> = sqlx::query_scalar(
        "select id from user_app_installs
         where app_id = $1 and workspace_id = $2 and status = 'active'
         limit 1",
    )
    .bind(app_id)
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    Ok(install.is_some())
}

/// [`workspace_may_use_bundle`] for the serving path, with the verdict
/// cached for 60 seconds.
pub(crate) async fn workspace_may_use_bundle_cached(
    master: &PgPool,
    cache: &dyn DynCache,
    app_id: &str,
    workspace_id: &str,
) -> Result<bool, sqlx::Error> {
    let key = bundle_access_cache_key(app_id, workspace_id);
    match cache.get_boxed(&key).await {
        Ok(Some(value)) if value == "1" => return Ok(true),
        Ok(Some(value)) if value == "0" => return Ok(false),
        Ok(_) => {}
        Err(error) => {
            tracing::error!(%error, "core-apps: bundle access cache read failed");
        }
    }
    let owner: Option<String> =
        sqlx::query_scalar("select owner_workspace_id from user_apps where id = $1 limit 1")
            .bind(app_id)
            .fetch_optional(master)
            .await?;
    let allowed = match owner {
        Some(owner) => workspace_may_use_bundle(master, app_id, &owner, workspace_id).await?,
        None => false,
    };
    if let Err(error) = cache
        .put_boxed(
            &key,
            if allowed { "1" } else { "0" },
            Some(std::time::Duration::from_secs(ACCESS_CACHE_TTL_SECONDS)),
        )
        .await
    {
        tracing::error!(%error, "core-apps: bundle access cache write failed");
    }
    Ok(allowed)
}

/// Drop the cached verdict after an install, uninstall or delete.
pub(crate) async fn invalidate_bundle_access(
    cache: &dyn DynCache,
    app_id: &str,
    workspace_id: &str,
) {
    if let Err(error) = cache
        .delete_boxed(&bundle_access_cache_key(app_id, workspace_id))
        .await
    {
        tracing::error!(%error, "core-apps: bundle access cache invalidation failed");
    }
}

// ── paths ────────────────────────────────────────────────────────────────────

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// The unsigned bundle path of a public, approved app.
pub(crate) fn plain_bundle_path(code: &str) -> String {
    format!(
        "/public/user-apps/{}/index.html",
        encode_uri_component(code)
    )
}

/// The signed bundle path of a non-public app.
pub(crate) fn signed_bundle_path(code: &str, token: &str) -> String {
    format!(
        "/public/user-apps/{}/s/{token}/index.html",
        encode_uri_component(code)
    )
}

/// The part after `/public/user-apps/:code/`: the link token when it starts
/// with `s/<token>/`, and the asset path. A leading `s/` that is not a token
/// stays part of the asset path.
pub(crate) fn split_bundle_path(rest: &str) -> (Option<&str>, &str) {
    if let Some(after) = rest.strip_prefix("s/") {
        let (segment, asset) = match after.find('/') {
            Some(slash) => (&after[..slash], &after[slash + 1..]),
            None => (after, ""),
        };
        if looks_like_bundle_token(segment) {
            return (Some(segment), asset);
        }
    }
    (None, rest)
}

// ── bundle origin ────────────────────────────────────────────────────────────

/// What `USER_APP_BUNDLE_ORIGIN` says about `code`'s bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BundleOrigin {
    Unset,
    Invalid,
    Ok(String),
}

/// The origin that must serve `code`'s bundle (`resolveBundleOrigin`).
pub(crate) fn resolve_bundle_origin<'a>(
    env: impl Fn(&str) -> Option<&'a str>,
    code: &str,
) -> BundleOrigin {
    let Some(raw) = env("USER_APP_BUNDLE_ORIGIN")
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
    else {
        return BundleOrigin::Unset;
    };
    let Ok(url) = url::Url::parse(&raw.replace("{code}", code)) else {
        return BundleOrigin::Invalid;
    };
    let host = url.host_str().unwrap_or_default();
    let local = host == "localhost" || host == "127.0.0.1";
    let secure = url.scheme() == "https" || (url.scheme() == "http" && local);
    let bare = url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    if !secure || !bare {
        return BundleOrigin::Invalid;
    }
    BundleOrigin::Ok(url.origin().ascii_serialization())
}

/// Whether a request on `request_origin` may be served `code`'s bundle.
pub(crate) fn is_bundle_host_request<'a>(
    env: impl Fn(&str) -> Option<&'a str>,
    code: &str,
    request_origin: &str,
) -> bool {
    match resolve_bundle_origin(env, code) {
        BundleOrigin::Unset => true,
        BundleOrigin::Ok(origin) => origin == request_origin,
        BundleOrigin::Invalid => false,
    }
}

/// Whether `request_origin` is the dedicated bundle host (any app).
pub(crate) fn is_dedicated_bundle_origin<'a>(
    env: impl Fn(&str) -> Option<&'a str> + Copy,
    request_origin: &str,
) -> bool {
    let Some(raw) = env("USER_APP_BUNDLE_ORIGIN")
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
    else {
        return false;
    };
    if !raw.contains("{code}") {
        return resolve_bundle_origin(env, "x") == BundleOrigin::Ok(request_origin.to_owned());
    }
    // Per-app template: the code is the leftmost label of the host.
    let Ok(host) = url::Url::parse(request_origin) else {
        return false;
    };
    let label = host
        .host_str()
        .and_then(|h| h.split('.').next())
        .unwrap_or_default();
    if label.is_empty() {
        return false;
    }
    resolve_bundle_origin(env, label) == BundleOrigin::Ok(request_origin.to_owned())
}

// ── response headers ─────────────────────────────────────────────────────────

const FRAME_ANCESTOR_ORIGINS: [&str; 6] = [
    "https://app.weldsuite.org",
    "https://app-test.weldsuite.org",
    "https://app-preview.weldsuite.org",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
];

static FRAME_ANCESTOR_SOURCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^https?://(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$")
        .expect("the frame-ancestor pattern compiles")
});

/// `frame-ancestors` of every bundle response: the platform origins plus
/// `USER_APP_FRAME_ANCESTORS`, never `*`.
pub(crate) fn bundle_frame_ancestors<'a>(env: impl Fn(&str) -> Option<&'a str>) -> String {
    let mut sources: Vec<String> = FRAME_ANCESTOR_ORIGINS
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    for source in env("USER_APP_FRAME_ANCESTORS")
        .unwrap_or_default()
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
    {
        if !source.is_empty()
            && FRAME_ANCESTOR_SOURCE.is_match(source)
            && !sources.iter().any(|s| s == source)
        {
            sources.push(source.to_owned());
        }
    }
    format!("frame-ancestors {}", sources.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(key: &str) -> Option<&'static str> {
        (key == "INTERNAL_API_SECRET").then_some("internal-secret-for-tests")
    }

    #[test]
    fn links_round_trip_and_fail_closed() {
        let now = 1_800_000_000_000;
        let link = sign_bundle_capability(env, "uapp_priv", "ws_owner", now).expect("signed");
        assert!(looks_like_bundle_token(&link.token));
        assert_eq!(
            verify_bundle_capability(env, "uapp_priv", &link.token, now),
            Ok(("ws_owner".to_owned(), link.expires_at_ms))
        );
        assert_eq!(
            verify_bundle_capability(env, "uapp_other", &link.token, now),
            Err(LinkRefusal::BadSignature)
        );
        assert_eq!(
            verify_bundle_capability(env, "uapp_priv", &link.token, link.expires_at_ms),
            Err(LinkRefusal::Expired)
        );
        assert_eq!(
            verify_bundle_capability(|_| None, "uapp_priv", &link.token, now),
            Err(LinkRefusal::Unconfigured)
        );
        assert_eq!(
            verify_bundle_capability(env, "uapp_priv", "nope", now),
            Err(LinkRefusal::Malformed)
        );
    }

    #[test]
    fn paths_split_like_the_host() {
        let token = format!("123.{}.{}", "d3Nfb3duZXI", "a".repeat(43));
        assert_eq!(
            split_bundle_path(&format!("s/{token}/assets/x.js")),
            (Some(token.as_str()), "assets/x.js")
        );
        assert_eq!(split_bundle_path("s/other/x.js"), (None, "s/other/x.js"));
        assert_eq!(split_bundle_path(""), (None, ""));
        assert_eq!(
            plain_bundle_path("my app"),
            "/public/user-apps/my%20app/index.html"
        );
    }

    #[test]
    fn bundle_origins() {
        let set = |value: &'static str| {
            move |key: &str| (key == "USER_APP_BUNDLE_ORIGIN").then_some(value)
        };
        assert_eq!(resolve_bundle_origin(|_| None, "x"), BundleOrigin::Unset);
        assert_eq!(
            resolve_bundle_origin(set("https://{code}.weldappcontent.net"), "pubapp"),
            BundleOrigin::Ok("https://pubapp.weldappcontent.net".to_owned())
        );
        assert_eq!(
            resolve_bundle_origin(set("not a url"), "x"),
            BundleOrigin::Invalid
        );
        assert_eq!(
            resolve_bundle_origin(set("http://weldappcontent.net"), "x"),
            BundleOrigin::Invalid
        );
        assert!(is_dedicated_bundle_origin(
            set("https://weldappcontent.net"),
            "https://weldappcontent.net"
        ));
        assert!(is_dedicated_bundle_origin(
            set("https://{code}.weldappcontent.net"),
            "https://demo.weldappcontent.net"
        ));
        assert!(!is_dedicated_bundle_origin(
            set("https://weldappcontent.net"),
            "https://app-api.weldsuite.org"
        ));
    }

    #[test]
    fn frame_ancestors_add_only_valid_sources() {
        let extra = |key: &str| {
            (key == "USER_APP_FRAME_ANCESTORS")
                .then_some("https://embed.example.com, javascript:x https://app.weldsuite.org")
        };
        assert_eq!(
            bundle_frame_ancestors(extra),
            "frame-ancestors https://app.weldsuite.org https://app-test.weldsuite.org https://app-preview.weldsuite.org http://localhost:3000 http://localhost:3001 http://localhost:5173 https://embed.example.com"
        );
    }
}
