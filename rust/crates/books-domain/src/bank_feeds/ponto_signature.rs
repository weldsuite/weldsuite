//! Ibanity's HTTP request signatures for Ponto Connect
//! (`@weldsuite/bank-feeds/ponto/signature.ts`): the `Digest` and
//! `Signature` headers a live application sends on every call
//! (<https://documentation.isabel.eu/security#http-signature>). The sandbox
//! does not need them.
//!
//! The scheme is the draft "Signing HTTP Messages" with `hs2019`:
//! RSASSA-PSS over SHA-256 (MGF1 SHA-256, a 32-byte salt) of a signing
//! string made of `(request-target)`, `host`, `digest`, `(created)` and,
//! when the request carries them, `authorization` and any `ibanity-*`
//! header. `Digest` is SHA-512 of the body as sent, of "" when there is
//! none. The key id is the signature certificate's id in Isabel's developer
//! portal, not the TLS certificate's.

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use sha2::Digest as _;
use weldsuite_ports::HttpRequest;

use super::FeedError;

/// The signature certificate a live Ponto application signs with
/// (`PONTO_SIGNATURE_CERT_ID`, `PONTO_SIGNATURE_KEY`).
#[derive(Clone)]
pub struct PontoSignature {
    /// The certificate's id in the developer portal: the header's `keyId`.
    pub certificate_id: String,
    /// Its private key, unencrypted PEM (PKCS#8 or PKCS#1); `\n` escapes
    /// are accepted.
    pub private_key: String,
}

impl std::fmt::Debug for PontoSignature {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PontoSignature")
            .field("certificate_id", &self.certificate_id)
            .finish_non_exhaustive()
    }
}

fn failed(message: String) -> FeedError {
    FeedError::new("ponto", "auth", message)
}

/// The `Digest` header: SHA-512 of the body as sent, base64.
pub fn digest(body: Option<&[u8]>) -> String {
    format!(
        "SHA-512={}",
        STANDARD.encode(sha2::Sha512::digest(body.unwrap_or_default()))
    )
}

/// The signed header names (the `headers` parameter) and the signing
/// string, in the same order.
pub fn signing_string(
    request: &HttpRequest,
    digest: &str,
    created: i64,
) -> Result<(String, String), FeedError> {
    let url = url::Url::parse(&request.url)
        .map_err(|e| failed(format!("Ponto request URL unreadable: {e}")))?;
    let host = url.host_str().unwrap_or_default();
    let host = url
        .port()
        .map_or_else(|| host.to_owned(), |port| format!("{host}:{port}"));
    let target = format!(
        "{} {}{}",
        request.method.to_lowercase(),
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    let mut names = ["(request-target)", "host", "digest", "(created)"]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut lines = vec![
        format!("(request-target): {target}"),
        format!("host: {host}"),
        format!("digest: {digest}"),
        format!("(created): {created}"),
    ];
    let lower = |name: &str| name.to_ascii_lowercase();
    let signed = request
        .headers
        .iter()
        .filter(|(name, _)| lower(name) == "authorization")
        .chain(
            request
                .headers
                .iter()
                .filter(|(name, _)| lower(name).starts_with("ibanity-")),
        );
    for (name, value) in signed {
        lines.push(format!("{}: {value}", lower(name)));
        names.push(lower(name));
    }
    Ok((names.join(" "), lines.join("\n")))
}

/// Add `Digest` and `Signature` to a request about to be sent, `created`
/// being the Unix time in seconds (Ibanity allows 60 seconds of drift).
pub fn sign_request(
    request: &mut HttpRequest,
    signature: &PontoSignature,
    created: i64,
) -> Result<(), FeedError> {
    let digest = digest(request.body.as_deref());
    let (headers, signing) = signing_string(request, &digest, created)?;
    let pem = signature.private_key.replace("\\n", "\n");
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(pem.as_bytes()).map_err(|e| {
        failed(format!(
            "Ponto signature key unreadable (an unencrypted RSA PEM key): {e}"
        ))
    })?;
    let signed =
        jsonwebtoken::crypto::sign(signing.as_bytes(), &key, jsonwebtoken::Algorithm::PS256)
            .map_err(|e| failed(format!("Ponto request signing failed: {e}")))?;
    // jsonwebtoken hands back base64url; the header carries plain base64.
    let signed = URL_SAFE_NO_PAD
        .decode(signed)
        .map(|bytes| STANDARD.encode(bytes))
        .map_err(|e| failed(format!("Ponto request signing failed: {e}")))?;
    request.headers.push(("Digest".to_owned(), digest));
    request.headers.push((
        "Signature".to_owned(),
        format!(
            "keyId=\"{}\",created={created},algorithm=\"hs2019\",headers=\"{headers}\",signature=\"{signed}\"",
            signature.certificate_id
        ),
    ));
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const CREATED: i64 = 1_599_659_223;

    /// A fresh RSA key (none is committed): its PKCS#8 PEM and the PKCS#1
    /// public key that verifies it.
    pub(crate) fn test_key() -> (String, Vec<u8>) {
        use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
        use aws_lc_rs::signature::KeyPair as _;
        let key = aws_lc_rs::rsa::KeyPair::generate(aws_lc_rs::rsa::KeySize::Rsa2048).expect("rsa");
        let der: Pkcs8V1Der<'static> = key.as_der().expect("pkcs8");
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(der.as_ref())
        );
        (pem, key.public_key().as_ref().to_vec())
    }

    /// The signing string and signature a `Signature` header carries.
    pub(crate) fn verify(request: &HttpRequest, public_key: &[u8]) -> (String, i64) {
        let header = request
            .headers
            .iter()
            .find(|(name, _)| name == "Signature")
            .map(|(_, value)| value.clone())
            .expect("a Signature header");
        let digest = request
            .headers
            .iter()
            .find(|(name, _)| name == "Digest")
            .map(|(_, value)| value.clone())
            .expect("a Digest header");
        let param = |name: &str| {
            header
                .split(',')
                .find_map(|part| part.strip_prefix(&format!("{name}=")))
                .map(|v| v.trim_matches('"').to_owned())
                .expect("a signature parameter")
        };
        let created: i64 = param("created").parse().expect("created");
        assert_eq!(param("algorithm"), "hs2019");
        assert_eq!(digest, super::digest(request.body.as_deref()));
        let (headers, signing) = signing_string(request, &digest, created).expect("signing");
        assert_eq!(param("headers"), headers);
        let signature = STANDARD.decode(param("signature")).expect("base64");
        aws_lc_rs::signature::UnparsedPublicKey::new(
            &aws_lc_rs::signature::RSA_PSS_2048_8192_SHA256,
            public_key,
        )
        .verify(signing.as_bytes(), &signature)
        .expect("RSASSA-PSS SHA-256 verifies");
        (param("keyId"), created)
    }

    fn token_request() -> HttpRequest {
        HttpRequest {
            method: "POST".to_owned(),
            url: "https://api.ibanity.com/ponto-connect/oauth2/token".to_owned(),
            headers: vec![
                ("Accept".to_owned(), "application/json".to_owned()),
                (
                    "Authorization".to_owned(),
                    "Basic Y2lkOmNzZWNyZXQ=".to_owned(),
                ),
                (
                    "Content-Type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned(),
                ),
            ],
            body: Some(b"grant_type=refresh_token&refresh_token=rt-1".to_vec()),
        }
    }

    #[test]
    fn the_digest_of_no_body_is_sha512_of_the_empty_string() {
        // The value Isabel's own example shows.
        assert_eq!(
            digest(None),
            "SHA-512=z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="
        );
        assert_eq!(digest(Some(b"")), digest(None));
    }

    #[test]
    fn a_post_signs_target_host_digest_created_and_authorization() {
        let request = token_request();
        let digest = digest(request.body.as_deref());
        assert_eq!(
            digest,
            "SHA-512=SOVBxxLqSeamoFz1pCkbBH/Snw+ucxqSUDtsd8R9ABrFNBRtusOfY4BCV2/DEvC5Gl+M43b30SaMFcwAsURIWw=="
        );
        let (headers, signing) = signing_string(&request, &digest, CREATED).expect("signing");
        assert_eq!(
            headers,
            "(request-target) host digest (created) authorization"
        );
        assert_eq!(
            signing,
            "(request-target): post /ponto-connect/oauth2/token\n\
             host: api.ibanity.com\n\
             digest: SHA-512=SOVBxxLqSeamoFz1pCkbBH/Snw+ucxqSUDtsd8R9ABrFNBRtusOfY4BCV2/DEvC5Gl+M43b30SaMFcwAsURIWw==\n\
             (created): 1599659223\n\
             authorization: Basic Y2lkOmNzZWNyZXQ="
        );
    }

    #[test]
    fn a_get_signs_its_query_and_any_ibanity_header() {
        let request = HttpRequest {
            method: "GET".to_owned(),
            url: "https://api.ibanity.com/ponto-connect/accounts?page%5Blimit%5D=100".to_owned(),
            headers: vec![
                ("Ibanity-Idempotency-Key".to_owned(), "61f02718".to_owned()),
                ("Authorization".to_owned(), "Bearer at-1".to_owned()),
            ],
            body: None,
        };
        let (headers, signing) = signing_string(&request, &digest(None), CREATED).expect("signing");
        assert_eq!(
            headers,
            "(request-target) host digest (created) authorization ibanity-idempotency-key"
        );
        assert_eq!(
            signing,
            "(request-target): get /ponto-connect/accounts?page%5Blimit%5D=100\n\
             host: api.ibanity.com\n\
             digest: SHA-512=z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==\n\
             (created): 1599659223\n\
             authorization: Bearer at-1\n\
             ibanity-idempotency-key: 61f02718"
        );
    }

    #[test]
    fn a_non_default_port_is_part_of_the_host() {
        let request = HttpRequest {
            url: "https://localhost:8443/ponto-connect/accounts".to_owned(),
            ..token_request()
        };
        let (_, signing) = signing_string(&request, &digest(None), CREATED).expect("signing");
        assert!(signing.contains("\nhost: localhost:8443\n"));
    }

    #[test]
    fn signs_with_rsassa_pss_sha256() {
        let (pem, public_key) = test_key();
        let mut request = token_request();
        let signature = PontoSignature {
            certificate_id: "62f02718-eeee-46e1-b5eb-e8fd6e799c2e".to_owned(),
            private_key: pem,
        };
        sign_request(&mut request, &signature, CREATED).expect("signed");
        let header = &request.headers.last().expect("signature").1;
        assert!(header.starts_with(
            "keyId=\"62f02718-eeee-46e1-b5eb-e8fd6e799c2e\",created=1599659223,algorithm=\"hs2019\",\
             headers=\"(request-target) host digest (created) authorization\",signature=\""
        ));
        assert_eq!(
            verify(&request, &public_key),
            ("62f02718-eeee-46e1-b5eb-e8fd6e799c2e".to_owned(), CREATED)
        );
    }

    #[test]
    fn takes_a_pkcs1_key_with_escaped_newlines() {
        let (pem, public_key) = test_key();
        // A 2048-bit PKCS#8 key is a 26-byte wrapper around its PKCS#1 key.
        let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
        let pkcs8 = STANDARD.decode(body).expect("der");
        let pkcs1 = format!(
            "-----BEGIN RSA PRIVATE KEY-----\\n{}\\n-----END RSA PRIVATE KEY-----",
            STANDARD.encode(&pkcs8[26..])
        );
        let mut request = token_request();
        let signature = PontoSignature {
            certificate_id: "cert".to_owned(),
            private_key: pkcs1,
        };
        sign_request(&mut request, &signature, CREATED).expect("signed");
        verify(&request, &public_key);
    }

    #[test]
    fn an_unreadable_key_is_an_auth_error() {
        let mut request = token_request();
        let signature = PontoSignature {
            certificate_id: "cert".to_owned(),
            private_key:
                "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----"
                    .to_owned(),
        };
        let error = sign_request(&mut request, &signature, CREATED).expect_err("unreadable");
        assert_eq!((error.provider.as_str(), error.kind), ("ponto", "auth"));
        assert!(error.message.contains("unreadable"));
        assert!(!request.headers.iter().any(|(name, _)| name == "Signature"));
    }

    #[test]
    fn the_debug_form_hides_the_key() {
        let signature = PontoSignature {
            certificate_id: "cert".to_owned(),
            private_key: "secret-key-material".to_owned(),
        };
        assert!(!format!("{signature:?}").contains("secret-key-material"));
    }
}
