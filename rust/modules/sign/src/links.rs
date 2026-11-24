//! Signing links (`packages/domains/sign/src/links.ts`, ADR SIGN-002). A link
//! is `<portal>/r/<token>` with 32 random bytes; only the token's SHA-256 is
//! stored, in the master `sign_link_registry`, which tells the portal which
//! workspace, envelope and recipient a link belongs to. The tenant rows stay
//! the source of truth: a registry hit is always re-checked against them.

use aws_lc_rs::digest;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::master::sign_link_registry;

use crate::{SignResult, millis, now};

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
    /// When the link stops working (to the millisecond, as a JavaScript
    /// `Date` holds it).
    pub(crate) expires_at: Option<OffsetDateTime>,
}

/// Create a link for one recipient; the token, shown once in the email
/// (`createLink`).
pub(crate) async fn create_link(master: &PgPool, target: &LinkTarget<'_>) -> SignResult<String> {
    let token = new_link_token();
    sign_link_registry::Entity::insert(sign_link_registry::ActiveModel {
        id: Set(generate_id("sgl")),
        token_hash: Set(sha256_hex(token.as_bytes())),
        workspace_id: Set(target.workspace_id.to_owned()),
        clerk_org_id: Set(target.clerk_org_id.to_owned()),
        envelope_id: Set(target.envelope_id.to_owned()),
        recipient_id: Set(target.recipient_id.to_owned()),
        expires_at: Set(target.expires_at.map(millis)),
        ..Default::default()
    })
    .exec_without_returning(&orm(master))
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
    let row: Option<(String, String, String, Option<OffsetDateTime>)> =
        sign_link_registry::Entity::find()
            .select_only()
            .columns([
                sign_link_registry::Column::ClerkOrgId,
                sign_link_registry::Column::EnvelopeId,
                sign_link_registry::Column::RecipientId,
                sign_link_registry::Column::ExpiresAt,
            ])
            .filter(sign_link_registry::Column::TokenHash.eq(token_hash))
            .filter(sign_link_registry::Column::RevokedAt.is_null())
            .into_tuple()
            .one(&orm(master))
            .await?;
    let at = millis(at);
    Ok(
        row.and_then(|(clerk_org_id, envelope_id, recipient_id, expires_at)| {
            let expired = expires_at.is_some_and(|expires_at| expires_at < at);
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
    sign_link_registry::Entity::update_many()
        .col_expr(sign_link_registry::Column::RevokedAt, Expr::value(now()))
        .filter(sign_link_registry::Column::WorkspaceId.eq(workspace_id))
        .filter(sign_link_registry::Column::EnvelopeId.eq(envelope_id))
        .filter(sign_link_registry::Column::RevokedAt.is_null())
        .exec(&orm(master))
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
    let mut revoke = sign_link_registry::Entity::update_many()
        .col_expr(sign_link_registry::Column::RevokedAt, Expr::value(now()))
        .filter(sign_link_registry::Column::WorkspaceId.eq(workspace_id))
        .filter(sign_link_registry::Column::EnvelopeId.eq(envelope_id))
        .filter(sign_link_registry::Column::RecipientId.eq(recipient_id))
        .filter(sign_link_registry::Column::RevokedAt.is_null());
    if let Some(keep) = keep_token.map(|t| sha256_hex(t.as_bytes())) {
        revoke = revoke.filter(sign_link_registry::Column::TokenHash.ne(keep));
    }
    revoke.exec(&orm(master)).await?;
    Ok(())
}

/// Take back links that never reached anyone: the outbound guard said no
/// (`revokeTokens`).
pub(crate) async fn revoke_tokens(master: &PgPool, tokens: &[String]) -> SignResult<()> {
    if tokens.is_empty() {
        return Ok(());
    }
    let hashes: Vec<String> = tokens.iter().map(|t| sha256_hex(t.as_bytes())).collect();
    sign_link_registry::Entity::update_many()
        .col_expr(sign_link_registry::Column::RevokedAt, Expr::value(now()))
        .filter(sign_link_registry::Column::TokenHash.is_in(hashes))
        .exec(&orm(master))
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
    let until = millis(completed_at + time::Duration::days(DOWNLOAD_WINDOW_DAYS));
    sign_link_registry::Entity::update_many()
        .col_expr(sign_link_registry::Column::ExpiresAt, Expr::value(until))
        .filter(sign_link_registry::Column::WorkspaceId.eq(workspace_id))
        .filter(sign_link_registry::Column::EnvelopeId.eq(envelope_id))
        .filter(sign_link_registry::Column::RevokedAt.is_null())
        .exec(&orm(master))
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
