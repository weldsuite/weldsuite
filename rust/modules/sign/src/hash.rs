//! Hashes (`packages/domains/sign/src/hash.ts`).

use aws_lc_rs::hmac;

/// HMAC-SHA-256 as lowercase hex (`hmacHex`).
pub(crate) fn hmac_hex(secret: &str, message: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hex::encode(hmac::sign(&key, message.as_bytes()).as_ref())
}

/// The stored form of a signer's code (`codeHash`): keyed with the worker
/// secret and bound to the recipient, so a database dump alone cannot be
/// brute-forced.
pub(crate) fn code_hash(secret: &str, recipient_id: &str, code: &str) -> String {
    hmac_hex(secret, &format!("sign-code:{recipient_id}:{}", code.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's HMAC-SHA-256 for the same key and message
    /// (`createHmac('sha256', 'secret').update('sign-code:sgr_1:1234')`); the
    /// code is trimmed first.
    #[test]
    fn code_hashes_match_node() {
        let expected = "c6f11f0f2b589975f9efbf6acbc58b31d5aaf78480f656ee7c9ec7beb55d9e86";
        assert_eq!(code_hash("secret", "sgr_1", "1234"), expected);
        assert_eq!(code_hash("secret", "sgr_1", " 1234 "), expected);
    }
}
