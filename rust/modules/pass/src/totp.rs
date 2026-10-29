//! Time-based one-time passwords (RFC 6238), as pass-api's `totp.ts` mints
//! them on the server: a teammate gets the six digits, never the seed.
//!
//! `parseTotp` takes a bare base32 secret or the `otpauth://totp/…` URI of a
//! QR code; its error messages are the worker's, word for word, because the
//! routes answer them as 400s.

use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use time::OffsetDateTime;

use crate::js;

/// The HMAC behind the codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

impl Algorithm {
    /// Web Crypto's name, as `TotpConfig.algorithm` holds it.
    pub fn name(self) -> &'static str {
        match self {
            Self::Sha1 => "SHA-1",
            Self::Sha256 => "SHA-256",
            Self::Sha512 => "SHA-512",
        }
    }
}

/// `TotpConfig`. The secret prints as `<redacted>`.
#[derive(Clone, PartialEq, Eq)]
pub struct TotpConfig {
    pub secret: Vec<u8>,
    pub digits: u32,
    pub period: u64,
    pub algorithm: Algorithm,
}

impl std::fmt::Debug for TotpConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TotpConfig")
            .field("secret", &"<redacted>")
            .field("digits", &self.digits)
            .field("period", &self.period)
            .field("algorithm", &self.algorithm)
            .finish()
    }
}

/// `TotpError`: the message the routes answer with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TotpError(pub &'static str);

const BASE32: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// `decodeBase32`: groups separated by spaces or dashes, padding dropped,
/// any case.
fn decode_base32(input: &str) -> Result<Vec<u8>, TotpError> {
    // `.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()`
    let without_separators: String = input
        .chars()
        .filter(|&c| c != '-' && !js::is_js_space(c))
        .collect();
    let cleaned = without_separators.trim_end_matches('=').to_uppercase();
    if cleaned.is_empty() {
        return Err(TotpError("The two-factor secret is empty."));
    }
    let length = js::utf16_len(&cleaned) * 5 / 8;
    let mut bytes = Vec::with_capacity(length);
    let mut buffer: u32 = 0;
    let mut bits = 0_u32;
    for c in cleaned.chars() {
        let Some(value) = BASE32.find(c) else {
            return Err(TotpError(
                "The two-factor secret is not valid base32 (letters A–Z and digits 2–7).",
            ));
        };
        // JavaScript's `<<` keeps 32 bits; only the low bits are ever read.
        buffer = (buffer << 5) | u32::try_from(value).unwrap_or(0);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    bytes.truncate(length);
    if bytes.is_empty() {
        return Err(TotpError("The two-factor secret is too short."));
    }
    Ok(bytes)
}

/// `parseTotp`.
pub fn parse_totp(input: &str) -> Result<TotpConfig, TotpError> {
    let trimmed = js::trim(input);
    let is_uri = trimmed
        .get(..10)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("otpauth://"));
    if !is_uri {
        return Ok(TotpConfig {
            secret: decode_base32(trimmed)?,
            digits: 6,
            period: 30,
            algorithm: Algorithm::Sha1,
        });
    }

    let uri = url::Url::parse(trimmed)
        .map_err(|_| TotpError("The otpauth:// link could not be read."))?;
    if !uri
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("totp"))
    {
        return Err(TotpError(
            "Only time-based (TOTP) two-factor codes are supported.",
        ));
    }
    // `searchParams.get(name)`: the first value, form-decoded.
    let param = |name: &str| {
        uri.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };

    let secret = param("secret")
        .filter(|secret| !secret.is_empty())
        .ok_or(TotpError("The otpauth:// link has no secret."))?;
    let digits = js::parse_int(param("digits").as_deref().unwrap_or("6"), 10);
    let period = js::parse_int(param("period").as_deref().unwrap_or("30"), 10);
    let algorithm = match param("algorithm")
        .unwrap_or_else(|| "SHA1".to_owned())
        .to_uppercase()
        .as_str()
    {
        "SHA1" => Some(Algorithm::Sha1),
        "SHA256" => Some(Algorithm::Sha256),
        "SHA512" => Some(Algorithm::Sha512),
        _ => None,
    };

    // `Number.parseInt` is already an integer or NaN.
    let digits = digits
        .filter(|d| (6.0..=8.0).contains(d))
        .ok_or(TotpError("Two-factor codes must be 6 to 8 digits long."))?;
    let period = period
        .filter(|p| (5.0..=300.0).contains(p))
        .ok_or(TotpError("The two-factor period is out of range."))?;
    let algorithm = algorithm.ok_or(TotpError("Unsupported two-factor algorithm."))?;

    // In range above, so the casts are exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(TotpConfig {
        secret: decode_base32(&secret)?,
        digits: digits as u32,
        period: period as u64,
        algorithm,
    })
}

/// `TotpCode`: the code, its period and when it stops being accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TotpCode {
    pub code: String,
    pub period: u64,
    /// `expiresAt.toISOString()`.
    pub expires_at: String,
}

fn hmac_digest(algorithm: Algorithm, key: &[u8], message: &[u8]) -> Vec<u8> {
    // HMAC takes keys of any length; `new_from_slice` cannot fail for it.
    match algorithm {
        Algorithm::Sha1 => <Hmac<Sha1> as hmac::KeyInit>::new_from_slice(key)
            .map(|mut mac| {
                mac.update(message);
                mac.finalize().into_bytes().to_vec()
            })
            .unwrap_or_default(),
        Algorithm::Sha256 => <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(key)
            .map(|mut mac| {
                mac.update(message);
                mac.finalize().into_bytes().to_vec()
            })
            .unwrap_or_default(),
        Algorithm::Sha512 => <Hmac<Sha512> as hmac::KeyInit>::new_from_slice(key)
            .map(|mut mac| {
                mac.update(message);
                mac.finalize().into_bytes().to_vec()
            })
            .unwrap_or_default(),
    }
}

/// `totpCode(config, now)`.
pub fn totp_code(config: &TotpConfig, now: OffsetDateTime) -> TotpCode {
    let millis = now.unix_timestamp_nanos() / 1_000_000;
    // `Math.floor(now.getTime() / 1000)`.
    let seconds = millis.div_euclid(1000);
    let period = i128::from(config.period.max(1));
    let counter = seconds.div_euclid(period);
    // The 8-byte big-endian counter (the high word written, not assumed).
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let message = (counter as u64).to_be_bytes();
    let digest = hmac_digest(config.algorithm, &config.secret, &message);

    let offset = usize::from(digest.last().copied().unwrap_or(0) & 0x0f);
    let byte = |i: usize| u32::from(digest.get(offset + i).copied().unwrap_or(0));
    let binary = ((byte(0) & 0x7f) << 24) | (byte(1) << 16) | (byte(2) << 8) | byte(3);
    let modulus = 10_u32.pow(config.digits);
    let code = format!(
        "{:0width$}",
        binary % modulus,
        width = config.digits as usize
    );

    // `new Date((counter + 1) * period * 1000)`.
    let expires_nanos = (counter + 1) * period * 1_000_000_000;
    let expires_at = OffsetDateTime::from_unix_timestamp_nanos(expires_nanos)
        .map(weldsuite_events::iso_timestamp)
        .unwrap_or_default();
    TotpCode {
        code,
        period: config.period,
        expires_at,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn at(seconds: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(seconds).expect("valid time")
    }

    /// RFC 6238, appendix B: the 8-digit codes for the three seeds.
    #[test]
    fn rfc_6238_vectors() {
        let seeds = [
            (Algorithm::Sha1, b"12345678901234567890".to_vec()),
            (
                Algorithm::Sha256,
                b"12345678901234567890123456789012".to_vec(),
            ),
            (
                Algorithm::Sha512,
                b"1234567890123456789012345678901234567890123456789012345678901234".to_vec(),
            ),
        ];
        let expected: [(i64, [&str; 3]); 6] = [
            (59, ["94287082", "46119246", "90693936"]),
            (1_111_111_109, ["07081804", "68084774", "25091201"]),
            (1_111_111_111, ["14050471", "67062674", "99943326"]),
            (1_234_567_890, ["89005924", "91819424", "93441116"]),
            (2_000_000_000, ["69279037", "90698825", "38618901"]),
            (20_000_000_000, ["65353130", "77737706", "47863826"]),
        ];
        for (time, codes) in expected {
            for ((algorithm, secret), code) in seeds.iter().zip(codes) {
                let config = TotpConfig {
                    secret: secret.clone(),
                    digits: 8,
                    period: 30,
                    algorithm: *algorithm,
                };
                assert_eq!(totp_code(&config, at(time)).code, code, "{algorithm:?} at {time}");
            }
        }
    }

    /// What `totp.ts` parsed and minted for the same inputs (tools/fixtures.mts).
    #[test]
    fn matches_typescript() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/totp-ts.json")).expect("JSON");
        for case in fixture["cases"].as_array().expect("cases") {
            let input = case["input"].as_str().expect("input");
            match (parse_totp(input), case["error"].as_str()) {
                (Err(TotpError(message)), Some(expected)) => assert_eq!(message, expected, "{input}"),
                (Ok(config), None) => {
                    assert_eq!(hex::encode(&config.secret), case["secretHex"], "{input}");
                    assert_eq!(u64::from(config.digits), case["digits"].as_u64().unwrap_or(0));
                    assert_eq!(config.period, case["period"].as_u64().unwrap_or(0));
                    assert_eq!(config.algorithm.name(), case["algorithm"]);
                    for code in case["codes"].as_array().expect("codes") {
                        let minted = totp_code(&config, at(code["seconds"].as_i64().unwrap_or(0)));
                        assert_eq!(minted.code, code["code"], "{input}");
                        assert_eq!(minted.period, code["period"].as_u64().unwrap_or(0));
                        assert_eq!(minted.expires_at, code["expiresAt"], "{input}");
                    }
                }
                (outcome, expected) => panic!("{input}: {outcome:?} vs {expected:?}"),
            }
        }
    }
}
