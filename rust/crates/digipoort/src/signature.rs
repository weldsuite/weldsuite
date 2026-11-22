//! WS-Security for the SOAP messages: an XML Signature (RSA-SHA256, SHA-256
//! digests, exclusive c14n) over elements that carry a `wsu:Id`, keyed to the
//! PKIoverheid certificate sent as a `BinarySecurityToken`. The port of
//! `signElements` in `packages/domains/payroll/src/nl/xmldsig.ts`.

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use sha2::Digest as _;

use crate::xml::Element;

/// The namespaces and algorithm identifiers of WS-Security and XML-DSig.
pub mod ns {
    pub const DS: &str = "http://www.w3.org/2000/09/xmldsig#";
    pub const EXC_C14N: &str = "http://www.w3.org/2001/10/xml-exc-c14n#";
    pub const RSA_SHA256: &str = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    pub const SHA256: &str = "http://www.w3.org/2001/04/xmlenc#sha256";
    pub const WSSE: &str =
        "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
    pub const WSU: &str =
        "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
    pub const X509V3: &str =
        "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3";
    pub const BASE64_BINARY: &str = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";
}

/// Why the certificate or key can't be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyError(pub String);

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for KeyError {}

/// The PKIoverheid certificate and its private key: what signs every message.
#[derive(Clone)]
pub struct Signer {
    key: jsonwebtoken::EncodingKey,
    /// The leaf certificate, DER: the `BinarySecurityToken`.
    certificate_der: Vec<u8>,
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Signer").finish_non_exhaustive()
    }
}

/// The DER bodies of the PEM blocks labelled `label`, in order.
pub fn pem_blocks(pem: &str, label: &str) -> Vec<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut out = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find(&begin) {
        let after = &rest[start + begin.len()..];
        let Some(stop) = after.find(&end) else {
            break;
        };
        let body: String = after[..stop]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        if let Ok(der) = STANDARD.decode(body) {
            out.push(der);
        }
        rest = &after[stop + end.len()..];
    }
    out
}

/// A PEM value as it arrives from the environment: `\n` escapes become
/// newlines (one-line secrets), surrounding whitespace goes.
pub fn normalize_pem(value: &str) -> String {
    value.trim().replace("\\n", "\n")
}

impl Signer {
    /// From the certificate chain (the leaf first) and the unencrypted RSA
    /// private key (PKCS#8 or PKCS#1), both PEM.
    pub fn from_pem(certificate_pem: &str, private_key_pem: &str) -> Result<Self, KeyError> {
        let certificate_pem = normalize_pem(certificate_pem);
        let certificate_der = pem_blocks(&certificate_pem, "CERTIFICATE")
            .into_iter()
            .next()
            .ok_or_else(|| KeyError("no PEM certificate found".to_owned()))?;
        let key =
            jsonwebtoken::EncodingKey::from_rsa_pem(normalize_pem(private_key_pem).as_bytes())
                .map_err(|e| {
                    KeyError(format!(
                        "the private key is not an unencrypted RSA PEM key: {e}"
                    ))
                })?;
        let signer = Self {
            key,
            certificate_der,
        };
        // Fail now, not on the first filing, when the key can't sign.
        signer.sign(b"probe")?;
        Ok(signer)
    }

    /// The certificate, base64 DER (the token's content).
    pub fn certificate_base64(&self) -> String {
        STANDARD.encode(&self.certificate_der)
    }

    /// RSASSA-PKCS1-v1_5 with SHA-256 of `data`, base64.
    pub fn sign(&self, data: &[u8]) -> Result<String, KeyError> {
        let signed = jsonwebtoken::crypto::sign(data, &self.key, jsonwebtoken::Algorithm::RS256)
            .map_err(|e| KeyError(format!("signing failed: {e}")))?;
        // jsonwebtoken answers base64url; XML-DSig carries plain base64.
        URL_SAFE_NO_PAD
            .decode(signed)
            .map(|bytes| STANDARD.encode(bytes))
            .map_err(|e| KeyError(format!("signing failed: {e}")))
    }
}

/// SHA-256 of `text`, base64.
pub fn sha256_base64(text: &str) -> String {
    STANDARD.encode(sha2::Sha256::digest(text.as_bytes()))
}

/// An element to sign: its `wsu:Id` and the element as it appears in the
/// message.
pub struct Reference<'a> {
    pub id: &'a str,
    pub element: &'a Element,
}

/// `signElements`: a `ds:Signature` over `references`, keyed to the
/// `BinarySecurityToken` whose `wsu:Id` is `token_id`.
pub fn sign_elements(
    signer: &Signer,
    references: &[Reference<'_>],
    token_id: &str,
) -> Result<Element, KeyError> {
    let ds = |name: &str| Element::new(ns::DS, "ds", name);
    let mut signed_info = ds("SignedInfo")
        .child(ds("CanonicalizationMethod").attr("Algorithm", ns::EXC_C14N))
        .child(ds("SignatureMethod").attr("Algorithm", ns::RSA_SHA256));
    for reference in references {
        let digest = sha256_base64(&reference.element.canonical());
        signed_info = signed_info.child(
            ds("Reference")
                .attr("URI", format!("#{}", reference.id))
                .child(ds("Transforms").child(ds("Transform").attr("Algorithm", ns::EXC_C14N)))
                .child(ds("DigestMethod").attr("Algorithm", ns::SHA256))
                .child(ds("DigestValue").text(digest)),
        );
    }
    let value = signer.sign(signed_info.canonical().as_bytes())?;
    Ok(ds("Signature")
        .child(signed_info)
        .child(ds("SignatureValue").text(value))
        .child(
            ds("KeyInfo").child(
                Element::new(ns::WSSE, "wsse", "SecurityTokenReference").child(
                    Element::new(ns::WSSE, "wsse", "Reference")
                        .attr("URI", format!("#{token_id}"))
                        .attr("ValueType", ns::X509V3),
                ),
            ),
        ))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A throwaway RSA key (none is committed), its PKCS#8 PEM, the PKCS#1
    /// public key that verifies it, and a stand-in certificate PEM.
    pub(crate) fn test_signer() -> (Signer, Vec<u8>) {
        use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
        use aws_lc_rs::signature::KeyPair as _;
        let key = aws_lc_rs::rsa::KeyPair::generate(aws_lc_rs::rsa::KeySize::Rsa2048).expect("rsa");
        let der: Pkcs8V1Der<'static> = key.as_der().expect("pkcs8");
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(der.as_ref())
        );
        // Any DER will do for the token: the signature is checked against the key.
        let certificate = "-----BEGIN CERTIFICATE-----\nMAMCAQA=\n-----END CERTIFICATE-----\n";
        let signer = Signer::from_pem(certificate, &pem).expect("signer");
        (signer, key.public_key().as_ref().to_vec())
    }

    #[test]
    fn reads_pem_blocks_and_escaped_newlines() {
        let pem = "junk\\n-----BEGIN CERTIFICATE-----\\nMAMC\\nAQA=\\n-----END CERTIFICATE-----\\n-----BEGIN CERTIFICATE-----\\nAAEC\\n-----END CERTIFICATE-----";
        let blocks = pem_blocks(&normalize_pem(pem), "CERTIFICATE");
        assert_eq!(
            blocks,
            vec![vec![0x30, 0x03, 0x02, 0x01, 0x00], vec![0, 1, 2]]
        );
        assert!(Signer::from_pem("no certificate", "no key").is_err());
    }

    #[test]
    fn signs_signed_info_verifiably() {
        let (signer, public_key) = test_signer();
        assert_eq!(signer.certificate_base64(), "MAMCAQA=");
        let body = Element::new("urn:body", "b", "Body")
            .ns_attr("wsu", ns::WSU, "Id", "id-body")
            .text("payload");
        let signature = sign_elements(
            &signer,
            &[Reference {
                id: "id-body",
                element: &body,
            }],
            "id-x509",
        )
        .expect("signature");
        let written = signature.canonical();
        let Some(crate::xml::Node::Element(signed_info)) = signature.children.first() else {
            panic!("SignedInfo first");
        };
        let value = crate::xml::text_of(&written, "SignatureValue").expect("value");
        aws_lc_rs::signature::UnparsedPublicKey::new(
            &aws_lc_rs::signature::RSA_PKCS1_2048_8192_SHA256,
            &public_key,
        )
        .verify(
            signed_info.canonical().as_bytes(),
            &STANDARD.decode(value).expect("base64"),
        )
        .expect("RSA-SHA256 verifies");
        assert_eq!(
            crate::xml::text_of(&written, "DigestValue"),
            Some(sha256_base64(&body.canonical()))
        );
        assert!(written.contains("URI=\"#id-body\""));
        assert!(written.contains("URI=\"#id-x509\""));
    }
}
