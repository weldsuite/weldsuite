//! What `invoices.email_history` says about delivery (Rust only, edition
//! feature `books-invoice-email`): a jsonb list of `{ type, at, ... }`
//! entries, oldest first.
//!
//! | `type` | meaning |
//! |---|---|
//! | `sent` | the invoice was e-mailed (`to`, `messageId`) |
//! | `reminder` | a payment reminder went out (`level`, `to`, `messageId`, `claim`) |
//! | `viewed` | the public page was opened (at most one an hour) |
//! | `bounced` | a send was refused or reported undelivered (`to`, `error`) |
//! | `link` / `link_revoked` | the public link's nonce was made / withdrawn |
//!
//! The EU MTA reports no bounce back to the books, so `bounced` is recorded
//! for the failures the transport reports while sending.

use serde_json::Value;

/// [`is_undelivered`] as SQL on `email_history`, for the To process kind
/// `invoices_undelivered`: the last `sent`, `reminder` or `bounced` entry is
/// a `bounced`.
pub const UNDELIVERED_SQL: &str = "(SELECT e.value->>'type' FROM jsonb_array_elements(COALESCE(\"invoices\".\"email_history\", '[]'::jsonb)) WITH ORDINALITY AS e(value, n) WHERE e.value->>'type' IN ('sent', 'reminder', 'bounced') ORDER BY e.n DESC LIMIT 1) = 'bounced'";

fn kind(entry: &Value) -> &str {
    entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Whether the last delivery attempt (a send or a reminder) failed: the
/// invoice is then in To process as undelivered until a send goes through.
pub fn is_undelivered(history: &[Value]) -> bool {
    history
        .iter()
        .rev()
        .find(|e| matches!(kind(e), "sent" | "reminder" | "bounced"))
        .is_some_and(|e| kind(e) == "bounced")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn e(kind: &str) -> Value {
        json!({ "type": kind, "at": "2026-01-01T00:00:00.000Z" })
    }

    #[test]
    fn undelivered_is_the_last_attempt_failing() {
        assert!(!is_undelivered(&[]));
        assert!(!is_undelivered(&[e("sent")]));
        assert!(is_undelivered(&[e("sent"), e("bounced")]));
        // Being opened or getting a link does not undo a failure.
        assert!(is_undelivered(&[
            e("sent"),
            e("bounced"),
            e("viewed"),
            e("link")
        ]));
        // A later send that went through does.
        assert!(!is_undelivered(&[e("sent"), e("bounced"), e("reminder")]));
        assert!(!is_undelivered(&[e("link"), e("viewed")]));
    }
}
