//! A member's own GitHub token, read from their linked WeldMerge account
//! (`merge_provider_accounts`, provider `github`, verified through OAuth),
//! for a module that holds the keyring but not the App's OAuth client
//! (`@weldsuite/merge-domain/member-token`): WeldConnect proves an install
//! with it. The token is used as stored, never refreshed: an expired one is
//! no token. The merge module uses its own `member_token`, which refreshes.

use serde_json::Value;
use weldsuite_db::{Keyring, PgPool, decrypt_field};
use weldsuite_kit::validation::js_date_parse;

/// The access token of a stored credentials blob (`mergeStoredCredentialsSchema`)
/// while it has not expired at `now_ms`.
fn usable_token(credentials: &str, now_ms: f64) -> Option<String> {
    let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(credentials) else {
        return None;
    };
    let access_token = fields.get("accessToken")?.as_str()?;
    // Optional strings: absent passes, anything but a string fails the schema.
    for key in ["refreshToken", "expiresAt", "tokenType"] {
        if fields.get(key).is_some_and(|value| !value.is_string()) {
            return None;
        }
    }
    // `new Date(expiresAt).getTime() <= now`: an unreadable date (NaN) is not expired.
    let expired = fields
        .get("expiresAt")
        .and_then(Value::as_str)
        .and_then(js_date_parse)
        .is_some_and(|at| at <= now_ms);
    (!expired && !access_token.is_empty()).then(|| access_token.to_owned())
}

/// `storedMemberGithubToken(tenantDb, keyring, userId)`: the member's
/// verified GitHub token while it has not expired; `None` otherwise.
///
/// # Errors
///
/// The tenant database fails.
pub async fn stored_member_github_token(
    tenant: &PgPool,
    keyring: &Keyring,
    user_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    if user_id.is_empty() {
        return Ok(None);
    }
    let sealed: Option<Option<String>> = sqlx::query_scalar(
        "select credentials from merge_provider_accounts where user_id = $1 and provider = 'github' \
         and host is null and verified_at is not null limit 1",
    )
    .bind(user_id)
    .fetch_optional(tenant)
    .await?;
    let Some(sealed) = sealed.flatten().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Ok(credentials) = decrypt_field(&sealed, keyring) else {
        return Ok(None);
    };
    #[allow(clippy::cast_precision_loss)]
    let now_ms = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as f64;
    Ok(usable_token(&credentials, now_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_a_token_until_it_expires() {
        let now = js_date_parse("2026-11-06T12:00:00.000Z").unwrap_or_default();
        assert_eq!(
            usable_token(r#"{"accessToken":"ghu_1"}"#, now).as_deref(),
            Some("ghu_1")
        );
        assert_eq!(
            usable_token(
                r#"{"accessToken":"ghu_1","expiresAt":"2026-11-06T13:00:00.000Z"}"#,
                now
            )
            .as_deref(),
            Some("ghu_1")
        );
        assert_eq!(
            usable_token(
                r#"{"accessToken":"ghu_1","expiresAt":"2026-11-06T11:00:00.000Z"}"#,
                now
            ),
            None
        );
        assert_eq!(usable_token(r#"{"refreshToken":"r"}"#, now), None);
        assert_eq!(usable_token("not json", now), None);
    }
}
