//! The CSC adapter against a scripted provider: what it sends at each step
//! of a signer's round trip and of the seal, and what it makes of the answers.

use std::sync::{Arc, Mutex, PoisonError};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use weldsuite_pades::local::{LocalCa, Profile};
use weldsuite_pades::{crypto, oid};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};
use weldsuite_trust_services::csc::{CscConfig, CscTrustService};
use weldsuite_trust_services::{Callback, Level, TrustService};

/// Answers by path; remembers every request.
struct Scripted {
    chain: Vec<String>,
    seen: Mutex<Vec<HttpRequest>>,
}

impl Scripted {
    fn requests(&self, path: &str) -> Vec<HttpRequest> {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|r| r.url.ends_with(path))
            .cloned()
            .collect()
    }
}

fn reply(body: &Value) -> HttpResponse {
    HttpResponse::new(200, body.to_string().into_bytes())
}

impl DynOutboundHttp for Scripted {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(request.clone());
        let url = request.url.as_str();
        let response = if url.ends_with("/oauth2/token") {
            reply(&json!({ "access_token": "tok", "expires_in": 3600 }))
        } else if url.ends_with("/credentials/list") {
            reply(&json!({
                "credentialIDs": ["cred-1"],
                "credentialInfos": [{ "cert": { "certificates": self.chain } }],
            }))
        } else if url.ends_with("/credentials/info") {
            reply(&json!({ "cert": { "certificates": self.chain } }))
        } else if url.ends_with("/credentials/authorize") {
            reply(&json!({ "SAD": "sad-1" }))
        } else if url.ends_with("/signatures/signHash") {
            reply(
                &json!({ "signatures": [STANDARD.encode([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])] }),
            )
        } else {
            HttpResponse::new(404, Vec::new())
        };
        Box::pin(std::future::ready(Ok(response)))
    }
}

fn body(request: &HttpRequest) -> Value {
    serde_json::from_slice(request.body.as_deref().unwrap_or_default()).unwrap_or(Value::Null)
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "one scripted provider through both redirects and the seal"
)]
async fn a_qualified_signer_and_the_seal_over_csc() {
    let ca = LocalCa::new("QTSP root").expect("ca");
    let person = ca
        .issue(
            &[(oid::COUNTRY, "NL"), (oid::COMMON_NAME, "Ann Peeters")],
            Profile::Signer { qualified: true },
        )
        .expect("person");
    let chain = vec![
        STANDARD.encode(&person.certificate.der),
        STANDARD.encode(&ca.root().der),
    ];
    let scripted = Arc::new(Scripted {
        chain,
        seen: Mutex::new(Vec::new()),
    });
    let service = CscTrustService::new(
        CscConfig {
            provider: "Test QTSP".to_owned(),
            base_url: "https://qtsp.example/csc/v2".to_owned(),
            client_id: "weldsign".to_owned(),
            client_secret: "secret".to_owned(),
            qes_profile: Some("qes".to_owned()),
            seal_credential_id: Some("seal-1".to_owned()),
            seal_pin: Some("1234".to_owned()),
            ..CscConfig::default()
        },
        OutboundHttp(scripted.clone()),
    );
    let redirect = "https://sign.example/signature-callback";

    let credential = service
        .identified(
            Level::Qes,
            Callback {
                code: "c1",
                redirect_uri: redirect,
                code_verifier: "v1",
            },
        )
        .await
        .expect("identified");
    assert_eq!(credential.credential_id, "cred-1");
    assert_eq!(
        credential.identity.certificate.subject.display(),
        "Ann Peeters"
    );
    assert_eq!(credential.identity.chain.len(), 1);
    let token = scripted.requests("/oauth2/token");
    let form = String::from_utf8(token[0].body.clone().unwrap_or_default()).expect("form");
    assert!(form.contains("grant_type=authorization_code"));
    assert!(form.contains("code_verifier=v1"));
    assert!(form.contains("redirect_uri=https%3A%2F%2Fsign.example%2Fsignature-callback"));
    assert_eq!(
        body(&scripted.requests("/credentials/list")[0])["clientData"],
        "qes"
    );

    let dtbs = b"signed attributes";
    let url = service
        .authorize_url(&weldsuite_trust_services::AuthorizeRequest {
            credential: &credential,
            data_to_be_signed: dtbs,
            redirect_uri: redirect,
            state: "s2",
            code_challenge: "c",
            description: "Contract",
            locale: "nl",
        })
        .expect("url");
    assert!(url.contains("scope=credential"));
    assert!(url.contains("credentialID=cred-1"));
    let value = service
        .sign_authorized(
            &credential,
            dtbs,
            Callback {
                code: "c2",
                redirect_uri: redirect,
                code_verifier: "v2",
            },
        )
        .await
        .expect("signed");
    assert_eq!(value[0], 0x30);
    let sign = body(&scripted.requests("/signatures/signHash")[0]);
    assert_eq!(sign["credentialID"], "cred-1");
    assert_eq!(sign["hashes"][0], STANDARD.encode(crypto::sha256(dtbs)));
    assert_eq!(sign["signAlgo"], oid::ECDSA_SHA256);
    assert_eq!(sign["hashAlgorithmOID"], oid::SHA256);

    // The seal: client credentials, the credential's chain, authorise with
    // the PIN, then signHash with the SAD.
    assert!(service.seals());
    let seal = service.seal_identity().await.expect("seal identity");
    assert_eq!(seal.certificate.subject.display(), "Ann Peeters");
    service.seal_sign(b"seal data").await.expect("seal");
    let authorize = body(&scripted.requests("/credentials/authorize")[0]);
    assert_eq!(authorize["credentialID"], "seal-1");
    assert_eq!(authorize["PIN"], "1234");
    let sign = body(&scripted.requests("/signatures/signHash")[1]);
    assert_eq!(sign["SAD"], "sad-1");
    let forms: Vec<String> = scripted
        .requests("/oauth2/token")
        .iter()
        .map(|r| String::from_utf8(r.body.clone().unwrap_or_default()).unwrap_or_default())
        .collect();
    assert!(
        forms
            .iter()
            .any(|f| f.contains("grant_type=client_credentials"))
    );
}
