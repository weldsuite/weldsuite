//! The signed SOAP envelope (`buildSignedEnvelope` in
//! `packages/domains/payroll/src/nl/digipoort.ts`): SOAP 1.1 with
//! WS-Addressing headers and a WS-Security header holding a timestamp, the
//! certificate as a `BinarySecurityToken` and an XML Signature over the body,
//! the timestamp and every addressing header, laid out as Logius' sample OB
//! request is (Security first, then Action, ReplyTo, MessageID and To).
//!
//! The signature is RSA-SHA256 with SHA-256 digests. Logius' 2015 WUS
//! documents still show RSA-SHA1; the new Digipoort's signing change broke
//! clients on .NET 4.5 and 4.8, whose WCF signs with SHA-1 by default, which
//! points at SHA-256. UNVERIFIED until a pre-production delivery: SHA-1
//! signing would need an RSA implementation beyond aws-lc-rs, which only
//! verifies RSA-SHA1.

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::profile;
use crate::signature::{KeyError, Reference, Signer, ns, sign_elements};
use crate::xml::Element;

/// One message to sign.
pub struct EnvelopeInput<'a> {
    /// The WS-Addressing action of the operation.
    pub action: &'a str,
    /// The endpoint (`wsa:To`).
    pub to: &'a str,
    /// The operation's request element.
    pub body: Element,
    pub now: OffsetDateTime,
    /// A UUID, without the `urn:uuid:` prefix.
    pub message_id: &'a str,
}

/// `2026-10-09T12:00:00Z`: whole seconds, UTC.
fn instant(at: OffsetDateTime) -> String {
    let at = at
        .to_offset(time::UtcOffset::UTC)
        .replace_nanosecond(0)
        .unwrap_or(at);
    at.format(&Rfc3339).unwrap_or_default()
}

/// The envelope, written in exclusive-canonical form.
pub fn signed_envelope(signer: &Signer, input: EnvelopeInput<'_>) -> Result<String, KeyError> {
    let soap = profile::SOAP_NS;
    let wsa = profile::WSA_NS;
    let with_id = |element: Element, id: &str| element.ns_attr("wsu", ns::WSU, "Id", id);
    let ids = Ids::default();

    let action = with_id(
        Element::new(wsa, "wsa", "Action").text(input.action),
        ids.action,
    );
    let to = with_id(Element::new(wsa, "wsa", "To").text(input.to), ids.to);
    let message_id = with_id(
        Element::new(wsa, "wsa", "MessageID").text(format!("uuid:{}", input.message_id)),
        ids.message,
    );
    let reply_to = with_id(
        Element::new(wsa, "wsa", "ReplyTo")
            .child(Element::new(wsa, "wsa", "Address").text(profile::WSA_ANONYMOUS)),
        ids.reply_to,
    );
    let expires = input.now + time::Duration::seconds(profile::TIMESTAMP_TTL_SECONDS);
    let timestamp = with_id(
        Element::new(ns::WSU, "wsu", "Timestamp")
            .child(Element::new(ns::WSU, "wsu", "Created").text(instant(input.now)))
            .child(Element::new(ns::WSU, "wsu", "Expires").text(instant(expires))),
        ids.timestamp,
    );
    let token = with_id(
        Element::new(ns::WSSE, "wsse", "BinarySecurityToken")
            .attr("EncodingType", ns::BASE64_BINARY)
            .attr("ValueType", ns::X509V3)
            .text(signer.certificate_base64()),
        ids.token,
    );
    let body = with_id(
        Element::new(soap, "soap", "Body").child(input.body),
        ids.body,
    );

    let signature = sign_elements(
        signer,
        &[
            Reference {
                id: ids.body,
                element: &body,
            },
            Reference {
                id: ids.timestamp,
                element: &timestamp,
            },
            Reference {
                id: ids.to,
                element: &to,
            },
            Reference {
                id: ids.action,
                element: &action,
            },
            Reference {
                id: ids.message,
                element: &message_id,
            },
            Reference {
                id: ids.reply_to,
                element: &reply_to,
            },
        ],
        ids.token,
    )?;
    let security = Element::new(ns::WSSE, "wsse", "Security")
        .ns_attr("soap", soap, "mustUnderstand", "1")
        .child(timestamp)
        .child(token)
        .child(signature);
    let envelope = Element::new(soap, "soap", "Envelope")
        .child(
            Element::new(soap, "soap", "Header")
                .child(security)
                .child(action)
                .child(reply_to)
                .child(message_id)
                .child(to),
        )
        .child(body);
    Ok(envelope.canonical())
}

/// The `wsu:Id`s of the signed parts.
struct Ids {
    body: &'static str,
    timestamp: &'static str,
    to: &'static str,
    action: &'static str,
    message: &'static str,
    reply_to: &'static str,
    token: &'static str,
}

impl Default for Ids {
    fn default() -> Self {
        Self {
            body: "id-body",
            timestamp: "id-ts",
            to: "id-to",
            action: "id-action",
            message: "id-msgid",
            reply_to: "id-replyto",
            token: "id-x509",
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    use super::*;
    use crate::signature::sha256_base64;
    use crate::signature::tests::test_signer;

    #[test]
    fn carries_addressing_a_timestamp_the_token_and_a_valid_signature() {
        let (signer, public_key) = test_signer();
        let request = Element::new(profile::TYPES_NS, "ns", "aanleverRequest")
            .child(Element::new(profile::TYPES_NS, "ns", "berichtsoort").text("Omzetbelasting"));
        let envelope = signed_envelope(
            &signer,
            EnvelopeInput {
                action: profile::AANLEVER_ACTION,
                to: "https://example.test/aanleveren",
                body: request.clone(),
                now: time::macros::datetime!(2026-10-09 12:00:00.250 UTC),
                message_id: "11111111-1111-4111-8111-111111111111",
            },
        )
        .expect("envelope");
        assert!(envelope.starts_with(
            "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Header><wsse:Security"
        ));
        assert!(
            envelope.contains(
                "<wsa:Address>http://www.w3.org/2005/08/addressing/anonymous</wsa:Address>"
            )
        );
        assert!(envelope.contains(
            "<wsu:Created>2026-10-09T12:00:00Z</wsu:Created><wsu:Expires>2026-10-09T12:05:00Z</wsu:Expires>"
        ));
        assert!(envelope.contains(">uuid:11111111-1111-4111-8111-111111111111</wsa:MessageID>"));
        assert!(envelope.contains("wsu:Id=\"id-x509\">MAMCAQA=</wsse:BinarySecurityToken>"));
        for uri in [
            "#id-body",
            "#id-ts",
            "#id-to",
            "#id-action",
            "#id-msgid",
            "#id-replyto",
        ] {
            assert!(envelope.contains(&format!("URI=\"{uri}\"")), "{uri}");
        }

        // SignedInfo as the apex of exclusive c14n declares ds itself.
        let start = envelope.find("<ds:SignedInfo>").expect("SignedInfo");
        let end = envelope.find("</ds:SignedInfo>").expect("end") + "</ds:SignedInfo>".len();
        let signed_info = envelope[start..end].replacen(
            "<ds:SignedInfo>",
            &format!("<ds:SignedInfo xmlns:ds=\"{}\">", ns::DS),
            1,
        );
        let value = crate::xml::text_of(&envelope, "SignatureValue").expect("value");
        aws_lc_rs::signature::UnparsedPublicKey::new(
            &aws_lc_rs::signature::RSA_PKCS1_2048_8192_SHA256,
            &public_key,
        )
        .verify(
            signed_info.as_bytes(),
            &STANDARD.decode(value).expect("b64"),
        )
        .expect("the signature verifies over the canonical SignedInfo");

        // The first digest is the body's, as a receiver canonicalizes it.
        let body = Element::new(profile::SOAP_NS, "soap", "Body")
            .ns_attr("wsu", ns::WSU, "Id", "id-body")
            .child(request);
        assert_eq!(
            crate::xml::text_of(&envelope, "DigestValue"),
            Some(sha256_base64(&body.canonical()))
        );
    }
}
