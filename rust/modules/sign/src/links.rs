//! Signing links (`packages/domains/sign/src/links.ts`, ADR SIGN-002). A link
//! is `<portal>/r/<token>` with 32 random bytes; only the token's SHA-256 is
//! stored, in the master `sign_link_registry`, which tells the portal which
//! workspace, envelope and recipient a link belongs to. The tenant rows stay
//! the source of truth: a registry hit is always re-checked against them.

use aws_lc_rs::digest;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_kit::generate_id;

use crate::{SignResult, now};

/// How long a link keeps working after the request completes, to download
/// the signed PDF.
pub(crate) const DOWNLOAD_WINDOW_DAYS: i64 = 30;

/// SHA-256 as lowercase hex (`sha256Hex`).
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    hex::encode(digest::digest(&digest::SHA256, data).as_ref())
}

/// 32 random bytes, base64url without padding (`newLinkToken`).
pub(crate) fn new_link_token() -> String {
    let mut bytes = [0u8; 32];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random source works");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `<portal>/r/<token>` (`signingLink`).
pub(crate) fn signing_link(portal_url: Option<&str>, token: &str) -> String {
    let base = portal_url
        .filter(|url| !url.is_empty())
        .unwrap_or("https://sign.weldsuite.org");
    format!("{}/r/{token}", base.strip_suffix('/').unwrap_or(base))
}

/// Who a link is for.
pub(crate) struct LinkTarget<'a> {
    /// Master `workspaces.id`.
    pub(crate) workspace_id: &'a str,
    pub(crate) clerk_org_id: &'a str,
    pub(crate) envelope_id: &'a str,
    pub(crate) recipient_id: &'a str,
    /// ISO timestamp, as the envelope row holds it.
    pub(crate) expires_at: Option<&'a str>,
}

/// Create a link for one recipient; the token, shown once in the email
/// (`createLink`).
pub(crate) async fn create_link(master: &PgPool, target: &LinkTarget<'_>) -> SignResult<String> {
    let token = new_link_token();
    sqlx::query(
        "insert into sign_link_registry
             (id, token_hash, workspace_id, clerk_org_id, envelope_id, recipient_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz)",
    )
    .bind(generate_id("sgl"))
    .bind(sha256_hex(token.as_bytes()))
    .bind(target.workspace_id)
    .bind(target.clerk_org_id)
    .bind(target.envelope_id)
    .bind(target.recipient_id)
    .bind(target.expires_at)
    .execute(master)
    .await?;
    Ok(token)
}

/// A live link (`ResolvedLink`).
#[derive(Debug, Clone)]
pub(crate) struct ResolvedLink {
    pub(crate) token_hash: String,
    pub(crate) clerk_org_id: String,
    pub(crate) envelope_id: String,
    pub(crate) recipient_id: String,
}

/// The live link for a token hash, or `None` when unknown, revoked or past
/// its expiry (`resolveLinkByHash`).
pub(crate) async fn resolve_link_by_hash(
    master: &PgPool,
    token_hash: &str,
    at: OffsetDateTime,
) -> SignResult<Option<ResolvedLink>> {
    let row: Option<(String, String, String, bool)> = sqlx::query_as(
        "select clerk_org_id, envelope_id, recipient_id,
                expires_at is not null and expires_at < $2::timestamptz
         from sign_link_registry
         where token_hash = $1 and revoked_at is null limit 1",
    )
    .bind(token_hash)
    .bind(weldsuite_events::iso_timestamp(at))
    .fetch_optional(master)
    .await?;
    Ok(
        row.and_then(|(clerk_org_id, envelope_id, recipient_id, expired)| {
            (!expired).then(|| ResolvedLink {
                token_hash: token_hash.to_owned(),
                clerk_org_id,
                envelope_id,
                recipient_id,
            })
        }),
    )
}

/// The live link for a token (`resolveLink`).
pub(crate) async fn resolve_link(
    master: &PgPool,
    token: &str,
    at: OffsetDateTime,
) -> SignResult<Option<ResolvedLink>> {
    resolve_link_by_hash(master, &sha256_hex(token.as_bytes()), at).await
}

/// Stop every link of an envelope at once: decline, void, expiry
/// (`revokeEnvelopeLinks`).
pub(crate) async fn revoke_envelope_links(
    master: &PgPool,
    workspace_id: &str,
    envelope_id: &str,
) -> SignResult<()> {
    sqlx::query(
        "update sign_link_registry set revoked_at = $3::timestamptz
         where workspace_id = $1 and envelope_id = $2 and revoked_at is null",
    )
    .bind(workspace_id)
    .bind(envelope_id)
    .bind(now())
    .execute(master)
    .await?;
    Ok(())
}

/// Stop one recipient's links (a corrected email), except the one just sent
/// to them (`revokeRecipientLinks`).
pub(crate) async fn revoke_recipient_links(
    master: &PgPool,
    workspace_id: &str,
    envelope_id: &str,
    recipient_id: &str,
    keep_token: Option<&str>,
) -> SignResult<()> {
    let keep = keep_token.map(|t| sha256_hex(t.as_bytes()));
    sqlx::query(
        "update sign_link_registry set revoked_at = $5::timestamptz
         where workspace_id = $1 and envelope_id = $2 and recipient_id = $3
           and revoked_at is null and ($4::text is null or token_hash <> $4)",
    )
    .bind(workspace_id)
    .bind(envelope_id)
    .bind(recipient_id)
    .bind(keep)
    .bind(now())
    .execute(master)
    .await?;
    Ok(())
}

/// Take back links that never reached anyone: the outbound guard said no
/// (`revokeTokens`).
pub(crate) async fn revoke_tokens(master: &PgPool, tokens: &[String]) -> SignResult<()> {
    if tokens.is_empty() {
        return Ok(());
    }
    let hashes: Vec<String> = tokens.iter().map(|t| sha256_hex(t.as_bytes())).collect();
    sqlx::query(
        "update sign_link_registry set revoked_at = $2::timestamptz where token_hash = any($1)",
    )
    .bind(&hashes)
    .bind(now())
    .execute(master)
    .await?;
    Ok(())
}

/// After completion links only download the signed PDF, for a limited time
/// (`limitLinksToDownload`).
pub(crate) async fn limit_links_to_download(
    master: &PgPool,
    workspace_id: &str,
    envelope_id: &str,
    completed_at: OffsetDateTime,
) -> SignResult<()> {
    let until = completed_at + time::Duration::days(DOWNLOAD_WINDOW_DAYS);
    sqlx::query(
        "update sign_link_registry set expires_at = $3::timestamptz
         where workspace_id = $1 and envelope_id = $2 and revoked_at is null",
    )
    .bind(workspace_id)
    .bind(envelope_id)
    .bind(weldsuite_events::iso_timestamp(until))
    .execute(master)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_and_links() {
        let token = new_link_token();
        assert_eq!(token.len(), 43, "32 bytes, base64url without padding");
        assert!(!token.contains(['+', '/', '=']));
        assert_eq!(
            signing_link(Some("https://sign.test/"), "abc"),
            "https://sign.test/r/abc"
        );
        assert_eq!(
            signing_link(None, "abc"),
            "https://sign.weldsuite.org/r/abc"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
