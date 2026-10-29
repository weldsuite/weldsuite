//! Identity codes for signing links (`packages/domains/sign/src/codes.ts`):
//! a 6-digit code emailed when the link is opened (auth mode `email_code`),
//! or the access code the sender shared (`access_code`). Kept in the cache
//! under the link's token hash, as the workers keep them in KV:
//!
//! ```text
//! sign:code:<tokenHash>       the emailed code's keyed hash, 10 minutes
//! sign:sent:<tokenHash>       last time a code was emailed (resend throttle), 1 minute
//! sign:attempts:<tokenHash>   wrong answers, forgotten 15 minutes after the last one
//! ```
//!
//! The workers count wrong answers in a Durable Object per link
//! (`SignCodeAttempts`), which settles one answer at a time. Here the count
//! is a cache counter (Valkey's `INCRBY`), atomic across replicas: five
//! wrong answers lock the link for 15 minutes however many arrive at once.

use std::time::Duration;

use weldsuite_ports::{DynCache, PortError};

use crate::{SignError, SignResult};

pub(crate) const CODE_TTL_SECONDS: u64 = 10 * 60;
const MAX_TRIES: i64 = 5;
const LOCK_SECONDS: u64 = 15 * 60;
const RESEND_AFTER_SECONDS: u64 = 60;

fn code_key(token_hash: &str) -> String {
    format!("sign:code:{token_hash}")
}

fn sent_key(token_hash: &str) -> String {
    format!("sign:sent:{token_hash}")
}

fn attempts_key(token_hash: &str) -> String {
    format!("sign:attempts:{token_hash}")
}

#[allow(clippy::needless_pass_by_value, reason = "used as map_err(failed)")]
fn failed(error: PortError) -> SignError {
    SignError::Internal(format!("sign codes: {error}"))
}

/// `newEmailCode`: six random digits.
pub(crate) fn new_email_code() -> String {
    let mut bytes = [0u8; 4];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random source works");
    format!("{:06}", u32::from_le_bytes(bytes) % 1_000_000)
}

/// `issueEmailCode`: store a fresh code's hash for this link; `false` when
/// one was sent less than a minute ago.
pub(crate) async fn issue_email_code(
    cache: &dyn DynCache,
    token_hash: &str,
    code_hash: &str,
) -> SignResult<bool> {
    if cache
        .get_boxed(&sent_key(token_hash))
        .await
        .map_err(failed)?
        .is_some_and(|sent| !sent.is_empty())
    {
        return Ok(false);
    }
    cache
        .put_boxed(
            &code_key(token_hash),
            code_hash,
            Some(Duration::from_secs(CODE_TTL_SECONDS)),
        )
        .await
        .map_err(failed)?;
    cache
        .put_boxed(
            &sent_key(token_hash),
            "1",
            Some(Duration::from_secs(RESEND_AFTER_SECONDS)),
        )
        .await
        .map_err(failed)?;
    Ok(true)
}

/// `emailCodeHash`: the emailed code's hash for this link, while valid.
pub(crate) async fn email_code_hash(
    cache: &dyn DynCache,
    token_hash: &str,
) -> SignResult<Option<String>> {
    cache.get_boxed(&code_key(token_hash)).await.map_err(failed)
}

/// Wrong answers so far.
async fn tries(cache: &dyn DynCache, token_hash: &str) -> SignResult<i64> {
    Ok(cache
        .get_boxed(&attempts_key(token_hash))
        .await
        .map_err(failed)?
        .and_then(|count| count.parse().ok())
        .unwrap_or(0))
}

/// `isLocked`.
pub(crate) async fn is_locked(cache: &dyn DynCache, token_hash: &str) -> SignResult<bool> {
    Ok(tries(cache, token_hash).await? >= MAX_TRIES)
}

/// How one answer was settled (`CodeCheck`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CodeCheck {
    Passed,
    Failed { locked: bool, attempts_left: i64 },
}

/// `checkCode`: compare the answer's hash with the expected one, then let
/// the link's counter settle it, so a right code sent while the link is
/// locked is still refused. A pass clears the count and the emailed code.
pub(crate) async fn check_code(
    cache: &dyn DynCache,
    token_hash: &str,
    expected: Option<&str>,
    answer_hash: &str,
) -> SignResult<CodeCheck> {
    let matched = expected.is_some_and(|expected| expected == answer_hash);
    if tries(cache, token_hash).await? >= MAX_TRIES {
        return Ok(CodeCheck::Failed {
            locked: true,
            attempts_left: 0,
        });
    }
    if matched {
        cache
            .delete_boxed(&attempts_key(token_hash))
            .await
            .map_err(failed)?;
        cache
            .delete_boxed(&code_key(token_hash))
            .await
            .map_err(failed)?;
        return Ok(CodeCheck::Passed);
    }
    // Each wrong answer restarts the window, as `AttemptCounter` does.
    let next = cache
        .increment_boxed(
            &attempts_key(token_hash),
            1,
            Some(Duration::from_secs(LOCK_SECONDS)),
        )
        .await
        .map_err(failed)?;
    Ok(CodeCheck::Failed {
        locked: next >= MAX_TRIES,
        attempts_left: (MAX_TRIES - next).max(0),
    })
}

/// `emailHint`: `ann@example.com` → `a••@example.com`, to say where the code
/// went.
pub(crate) fn email_hint(email: Option<&str>) -> Option<String> {
    let mut parts = email?.split('@');
    let local = parts.next().filter(|local| !local.is_empty())?;
    let domain = parts.next().filter(|domain| !domain.is_empty())?;
    let first = local.chars().next()?;
    // JavaScript's `length`: UTF-16 code units.
    let length = local.encode_utf16().count();
    let dots = (length.saturating_sub(1)).clamp(2, 6);
    Some(format!("{first}{}@{domain}", "\u{2022}".repeat(dots)))
}

#[cfg(test)]
mod tests {
    use weldsuite_ports::MemoryCache;

    use super::*;

    #[test]
    fn hints_like_typescript() {
        assert_eq!(
            email_hint(Some("bob@example.com")).as_deref(),
            Some("b••@example.com")
        );
        assert_eq!(email_hint(Some("a@x.io")).as_deref(), Some("a••@x.io"));
        assert_eq!(
            email_hint(Some("annemarie.de.vries@x.io")).as_deref(),
            Some("a••••••@x.io")
        );
        assert_eq!(email_hint(Some("a@b@c")).as_deref(), Some("a••@b"));
        assert_eq!(email_hint(Some("nobody")), None);
        assert_eq!(email_hint(None), None);
    }

    #[test]
    fn codes_have_six_digits() {
        for _ in 0..50 {
            let code = new_email_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|b| b.is_ascii_digit()));
        }
    }

    #[tokio::test]
    async fn five_wrong_answers_lock_the_link() {
        let cache = MemoryCache::new();
        let cache: &dyn DynCache = &cache;
        assert!(issue_email_code(cache, "t", "h").await.expect("issue"));
        assert!(!issue_email_code(cache, "t", "h2").await.expect("throttled"));
        assert_eq!(
            email_code_hash(cache, "t").await.expect("hash").as_deref(),
            Some("h")
        );
        for left in (1..=4).rev() {
            assert_eq!(
                check_code(cache, "t", Some("h"), "x").await.expect("check"),
                CodeCheck::Failed {
                    locked: false,
                    attempts_left: left
                }
            );
        }
        assert_eq!(
            check_code(cache, "t", Some("h"), "x").await.expect("check"),
            CodeCheck::Failed {
                locked: true,
                attempts_left: 0
            }
        );
        assert!(is_locked(cache, "t").await.expect("locked"));
        // The right code is refused while locked.
        assert_eq!(
            check_code(cache, "t", Some("h"), "h").await.expect("check"),
            CodeCheck::Failed {
                locked: true,
                attempts_left: 0
            }
        );
    }

    #[tokio::test]
    async fn a_right_answer_clears_the_count_and_the_code() {
        let cache = MemoryCache::new();
        let cache: &dyn DynCache = &cache;
        issue_email_code(cache, "t", "h").await.expect("issue");
        check_code(cache, "t", Some("h"), "x").await.expect("wrong");
        assert_eq!(
            check_code(cache, "t", Some("h"), "h").await.expect("right"),
            CodeCheck::Passed
        );
        assert_eq!(tries(cache, "t").await.expect("tries"), 0);
        assert_eq!(email_code_hash(cache, "t").await.expect("hash"), None);
        // Without an expected hash nothing matches.
        assert_eq!(
            check_code(cache, "t", None, "h").await.expect("none"),
            CodeCheck::Failed {
                locked: false,
                attempts_left: 4
            }
        );
    }
}
