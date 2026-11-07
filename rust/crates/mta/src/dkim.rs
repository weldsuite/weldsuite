//! DKIM signing (RFC 6376): `rsa-sha256`, `relaxed/relaxed`, 2048-bit keys.
//! Ed25519 (RFC 8463) is left out on purpose: Microsoft does not verify it,
//! and a second signature buys nothing until it does.
//!
//! The signer canonicalizes the headers it signs and the body, hashes the
//! body (`bh=`), and signs the header hash input with `b=` empty, exactly as
//! the header will be written (folded), so a verifier that unfolds and
//! canonicalizes it gets the same bytes. [`verify`] is the other side, for
//! tests and the CLI's self-check.

use aws_lc_rs::digest;
use aws_lc_rs::encoding::AsDer;
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::rsa::KeySize;
use aws_lc_rs::signature::{self, RsaKeyPair};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;

use crate::message::{Header, headers, split};

/// The headers signed when present, in this order. `From` is signed once
/// more than it occurs (over-signing), so another `From` cannot be added
/// in transit without breaking the signature.
const SIGNED: &[&str] = &[
    "from",
    "reply-to",
    "subject",
    "date",
    "to",
    "cc",
    "message-id",
    "in-reply-to",
    "references",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
    "list-id",
    "list-unsubscribe",
    "list-unsubscribe-post",
    "feedback-id",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DkimError(pub String);

impl std::fmt::Display for DkimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DKIM: {}", self.0)
    }
}

impl std::error::Error for DkimError {}

/// A new key: (PKCS#8 DER of the private key, base64 `SubjectPublicKeyInfo`).
pub fn generate_rsa() -> Result<(Vec<u8>, String), DkimError> {
    let pair = RsaKeyPair::generate(KeySize::Rsa2048)
        .map_err(|_| DkimError("cannot generate a key".into()))?;
    let private = pair
        .as_der()
        .map_err(|_| DkimError("cannot encode the key".into()))?;
    let public = signature::KeyPair::public_key(&pair)
        .as_der()
        .map_err(|_| DkimError("cannot encode the public key".into()))?;
    Ok((private.as_ref().to_vec(), B64.encode(public.as_ref())))
}

/// The TXT record value at `<selector>._domainkey.<domain>`.
pub fn record_value(public_key_b64: &str) -> String {
    format!("v=DKIM1; k=rsa; p={public_key_b64}")
}

/// A key ready to sign for one domain.
pub struct Signer {
    domain: String,
    selector: String,
    key: RsaKeyPair,
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Signer")
            .field("domain", &self.domain)
            .field("selector", &self.selector)
            .finish_non_exhaustive()
    }
}

impl Signer {
    pub fn new(domain: &str, selector: &str, pkcs8: &[u8]) -> Result<Self, DkimError> {
        let key = RsaKeyPair::from_pkcs8(pkcs8).map_err(|e| DkimError(format!("bad key: {e}")))?;
        Ok(Self {
            domain: domain.to_ascii_lowercase(),
            selector: selector.to_owned(),
            key,
        })
    }

    pub fn domain(&self) -> &str {
        &self.domain
    }

    /// The `DKIM-Signature` field (name, folded value, CRLF) to put in front
    /// of `message`, signed at `timestamp` (seconds since the epoch).
    pub fn sign(&self, message: &[u8], timestamp: i64) -> Result<String, DkimError> {
        let (block, body) = split(message);
        let fields = headers(block);
        let body_hash = B64.encode(digest::digest(&digest::SHA256, &relaxed_body(body)));

        let (names, mut input) = select_headers(&fields);
        let header = format!(
            "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d={domain};\r\n\ts={selector}; t={timestamp};\r\n\th={names};\r\n\tbh={body_hash};\r\n\tb=",
            domain = self.domain,
            selector = self.selector,
            names = fold_list(&names),
        );
        input.extend_from_slice(relaxed_header(&header).as_bytes());

        let rng = SystemRandom::new();
        let mut sig = vec![0u8; self.key.public_modulus_len()];
        self.key
            .sign(&signature::RSA_PKCS1_SHA256, &rng, &input, &mut sig)
            .map_err(|_| DkimError("signing failed".into()))?;
        let b = B64.encode(&sig);
        Ok(format!("{header}{}\r\n", fold_b64(&b)))
    }
}

/// The names for `h=` and the canonicalized headers they select, bottom-up
/// for repeated names (RFC 6376 §5.4.2).
fn select_headers(fields: &[Header]) -> (Vec<String>, Vec<u8>) {
    let mut names = Vec::new();
    let mut input = Vec::new();
    for &name in SIGNED {
        let instances: Vec<&Header> = fields
            .iter()
            .filter(|field| field.name.eq_ignore_ascii_case(name))
            .collect();
        for field in instances.iter().rev() {
            names.push(name.to_owned());
            input
                .extend_from_slice(relaxed_header(&String::from_utf8_lossy(&field.raw)).as_bytes());
            input.extend_from_slice(b"\r\n");
        }
        if name == "from" {
            // The over-signed instance selects nothing (a null string).
            names.push(name.to_owned());
        }
    }
    (names, input)
}

fn fold_list(names: &[String]) -> String {
    let mut out = String::new();
    let mut line = 0;
    for (index, name) in names.iter().enumerate() {
        if index > 0 {
            out.push(':');
            line += 1;
            if line + name.len() > 60 {
                out.push_str("\r\n\t ");
                line = 0;
            }
        }
        out.push_str(name);
        line += name.len();
    }
    out
}

fn fold_b64(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + value.len() / 60 * 4);
    for (index, chunk) in value.as_bytes().chunks(72).enumerate() {
        if index > 0 {
            out.push_str("\r\n\t ");
        }
        out.push_str(&String::from_utf8_lossy(chunk));
    }
    out
}

fn is_wsp(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// Relaxed header canonicalization (§3.4.2) of one whole field, without
/// the final CRLF.
pub fn relaxed_header(field: &str) -> String {
    let field = field.trim_end_matches(['\r', '\n']);
    let Some((name, value)) = field.split_once(':') else {
        return field.to_owned();
    };
    let unfolded: String = value.chars().filter(|&c| c != '\r' && c != '\n').collect();
    let mut collapsed = String::with_capacity(unfolded.len());
    let mut in_wsp = false;
    for c in unfolded.chars() {
        if is_wsp(c) {
            in_wsp = true;
        } else {
            if in_wsp && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            in_wsp = false;
            collapsed.push(c);
        }
    }
    format!(
        "{}:{}",
        name.trim_end_matches(is_wsp).to_ascii_lowercase(),
        collapsed
    )
}

/// Relaxed body canonicalization (§3.4.4).
pub fn relaxed_body(body: &[u8]) -> Vec<u8> {
    let mut lines: Vec<Vec<u8>> = Vec::new();
    for line in body.split_inclusive(|&b| b == b'\n') {
        let content = line.strip_suffix(b"\n").unwrap_or(line);
        let content = content.strip_suffix(b"\r").unwrap_or(content);
        let mut out = Vec::with_capacity(content.len());
        let mut in_wsp = false;
        for &byte in content {
            if byte == b' ' || byte == b'\t' {
                in_wsp = true;
            } else {
                if in_wsp {
                    out.push(b' ');
                }
                in_wsp = false;
                out.push(byte);
            }
        }
        lines.push(out);
    }
    while lines.last().is_some_and(Vec::is_empty) {
        lines.pop();
    }
    let mut out = Vec::with_capacity(body.len());
    for line in lines {
        out.extend_from_slice(&line);
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// Tags of a `DKIM-Signature` value.
fn tags(value: &str) -> Vec<(String, String)> {
    value
        .split(';')
        .filter_map(|tag| {
            let (name, value) = tag.split_once('=')?;
            let value: String = value.chars().filter(|c| !c.is_whitespace()).collect();
            Some((name.trim().to_owned(), value))
        })
        .collect()
}

/// Verifies the first `DKIM-Signature` of `message` against a base64
/// `SubjectPublicKeyInfo` (or PKCS#1) RSA key.
pub fn verify(message: &[u8], public_key_b64: &str) -> Result<(), DkimError> {
    let (block, body) = split(message);
    let fields = headers(block);
    let signature_field = fields
        .iter()
        .find(|field| field.name.eq_ignore_ascii_case("dkim-signature"))
        .ok_or_else(|| DkimError("no signature".into()))?;
    let tags = tags(&signature_field.value);
    let tag = |name: &str| {
        tags.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
            .ok_or_else(|| DkimError(format!("no {name}= tag")))
    };
    if tag("c")? != "relaxed/relaxed" || tag("a")? != "rsa-sha256" {
        return Err(DkimError("unsupported algorithm".into()));
    }
    let body_hash = B64.encode(digest::digest(&digest::SHA256, &relaxed_body(body)));
    if tag("bh")? != body_hash {
        return Err(DkimError("body hash mismatch".into()));
    }
    let mut input = Vec::new();
    let mut used: Vec<usize> = Vec::new();
    for name in tag("h")?.split(':') {
        let name = name.trim();
        let pick =
            fields.iter().enumerate().rev().find(|(index, field)| {
                field.name.eq_ignore_ascii_case(name) && !used.contains(index)
            });
        if let Some((index, field)) = pick {
            used.push(index);
            input
                .extend_from_slice(relaxed_header(&String::from_utf8_lossy(&field.raw)).as_bytes());
            input.extend_from_slice(b"\r\n");
        }
    }
    let raw = String::from_utf8_lossy(&signature_field.raw).into_owned();
    let b_at = find_b_tag(&raw).ok_or_else(|| DkimError("no b= tag".into()))?;
    let end = raw[b_at..].find(';').map_or(raw.len(), |i| b_at + i);
    let stripped = format!("{}{}", &raw[..b_at], &raw[end..]);
    input.extend_from_slice(relaxed_header(&stripped).as_bytes());
    let sig = B64
        .decode(tag("b")?)
        .map_err(|_| DkimError("b= is not base64".into()))?;
    let key = B64
        .decode(public_key_b64)
        .map_err(|_| DkimError("key is not base64".into()))?;
    signature::UnparsedPublicKey::new(&signature::RSA_PKCS1_2048_8192_SHA256, key)
        .verify(&input, &sig)
        .map_err(|_| DkimError("signature mismatch".into()))
}

/// The offset just after `b=` (the tag, not `bh=`).
fn find_b_tag(raw: &str) -> Option<usize> {
    let bytes = raw.as_bytes();
    let mut search = 0;
    while let Some(i) = raw[search..].find("b=") {
        let at = search + i;
        let before = raw[..at].trim_end_matches([' ', '\t', '\r', '\n']);
        if before.ends_with(';') || before.ends_with(':') {
            return Some(at + 2);
        }
        search = at + 2;
        if search >= bytes.len() {
            break;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_like_rfc_6376_section_3_4_5() {
        assert_eq!(relaxed_header("A: X\r\n"), "a:X");
        assert_eq!(relaxed_header("B : Y\t\r\n\tZ  \r\n"), "b:Y Z");
        assert_eq!(relaxed_body(b" C \r\nD \t E\r\n\r\n\r\n"), b" C\r\nD E\r\n");
        assert_eq!(relaxed_body(b""), b"");
        assert_eq!(relaxed_body(b"x"), b"x\r\n");
    }

    #[test]
    fn signs_and_verifies() {
        let (private, public) = generate_rsa().expect("key");
        let signer = Signer::new("Acme.EU", "ws202611", &private).expect("signer");
        let message = b"From: Anna <anna@acme.eu>\r\nTo: bob@example.com\r\nSubject: Hi  there\r\nDate: Sat, 7 Nov 2026 12:00:00 +0000\r\nMessage-ID: <1@acme.eu>\r\n\r\nHello\r\n.dot\r\n\r\n";
        let header = signer.sign(message, 1_794_000_000).expect("sign");
        assert!(
            header.starts_with("DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=acme.eu;")
        );
        assert!(header.contains("h=from:from:subject:date:to:message-id;"));
        let mut stamped = header.into_bytes();
        stamped.extend_from_slice(message);
        verify(&stamped, &public).expect("verifies");

        // A relay that refolds headers and adds trailing blank lines still verifies.
        let rewritten = String::from_utf8(stamped.clone())
            .expect("utf8")
            .replace("Subject: Hi  there", "Subject:  Hi\r\n there")
            + "\r\n\r\n";
        verify(rewritten.as_bytes(), &public).expect("relaxed survives refolding");

        let tampered = String::from_utf8(stamped)
            .expect("utf8")
            .replace("Hello", "Hullo");
        assert!(verify(tampered.as_bytes(), &public).is_err());
        assert_eq!(record_value("AB"), "v=DKIM1; k=rsa; p=AB");
    }

    #[test]
    fn an_added_from_breaks_the_signature() {
        let (private, public) = generate_rsa().expect("key");
        let signer = Signer::new("acme.eu", "s", &private).expect("signer");
        let message = b"From: anna@acme.eu\r\nSubject: x\r\n\r\nbody\r\n";
        let mut stamped = signer.sign(message, 1).expect("sign").into_bytes();
        stamped.extend_from_slice(message);
        let forged = String::from_utf8(stamped)
            .expect("utf8")
            .replace("Subject: x", "Subject: x\r\nFrom: evil@bad.example");
        assert!(verify(forged.as_bytes(), &public).is_err());
    }
}
