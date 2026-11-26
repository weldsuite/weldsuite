//! A qualified trust service provider over the Cloud Signature Consortium
//! API v2 (aligned with ETSI TS 119 432).
//!
//! - **Signers** (SCAL2): OAuth 2.0 authorisation code with PKCE. First
//!   `scope=service`: the signer identifies at the QTSP (an ID document, a
//!   national eID, their existing account) and WeldSign reads their
//!   credential and certificate (`credentials/list`, `credentials/info`).
//!   Then `scope=credential` for one hash: the signer authorises it (OTP,
//!   app) and `signatures/signHash` returns the value. Only hashes leave
//!   WeldSuite.
//! - **The seal** (SCAL1): the install's own credential, authorised with the
//!   service token (client credentials) and the credential's PIN when it has
//!   one (`credentials/authorize`), then `signHash`.
//! - **Timestamps**: the QTSP's RFC 3161 TSA ([`crate::tsa::HttpTsa`]).
//!
//! What differs per QTSP (whether a one-time certificate is issued during
//! identification, which certificate profile a level maps to, extra
//! parameters) is configuration: the level's profile goes to the provider
//! as `clientData`.

use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use tokio::sync::{Mutex, OnceCell};
use weldsuite_pades::{Certificate, ValidationData, crypto, der, oid};
use weldsuite_ports::{BoxFuture, HttpRequest, OutboundHttp};

use crate::tsa::HttpTsa;
use crate::{
    AuthorizeRequest, Callback, IdentifyRequest, Identity, Level, SignerCredential, TrustError,
    TrustService, form_body, revocation, with_query,
};

/// The provider's settings (`SIGN_CSC_*`, `SIGN_SEAL_*`, `SIGN_TSA_*`).
#[derive(Debug, Clone, Default)]
pub struct CscConfig {
    /// The provider's name, shown to signers.
    pub provider: String,
    /// The CSC API base, e.g. `https://qtsp.example/csc/v2`.
    pub base_url: String,
    /// The OAuth 2.0 server; `<base_url>/oauth2` when unset.
    pub oauth_url: Option<String>,
    pub client_id: String,
    pub client_secret: String,
    /// The provider's profile for advanced signatures; unset hides the level.
    pub aes_profile: Option<String>,
    /// The provider's profile for qualified signatures; unset hides the level.
    pub qes_profile: Option<String>,
    /// The install's seal credential; unset seals nothing.
    pub seal_credential_id: Option<String>,
    pub seal_pin: Option<String>,
    /// The TSA; unset leaves signatures and seals at B-B.
    pub tsa_url: Option<String>,
    pub tsa_basic: Option<(String, String)>,
}

pub struct CscTrustService {
    config: CscConfig,
    http: OutboundHttp,
    tsa: Option<HttpTsa>,
    service_token: Mutex<Option<(String, Instant)>>,
    seal: OnceCell<Identity>,
}

impl std::fmt::Debug for CscTrustService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CscTrustService")
            .field("provider", &self.config.provider)
            .field("base_url", &self.config.base_url)
            .finish_non_exhaustive()
    }
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, TrustError> {
    STANDARD
        .decode(text.trim())
        .map_err(|_| TrustError::new("the provider sent invalid base64"))
}

/// Some providers return ECDSA signatures as `r || s`; CMS wants DER.
fn der_ecdsa(spki: &[u8], signature: Vec<u8>) -> Vec<u8> {
    let ec = matches!(
        crypto::key_kind(spki),
        crypto::KeyKind::EcP256 | crypto::KeyKind::EcP384
    );
    if ec && signature.first() != Some(&der::SEQUENCE) && matches!(signature.len(), 64 | 96) {
        let (r, s) = signature.split_at(signature.len() / 2);
        return der::sequence([der::integer_unsigned(r), der::integer_unsigned(s)]);
    }
    signature
}

/// A certificate list from `credentials/info` or `credentialInfos`.
fn identity_of(info: &Value) -> Result<Identity, TrustError> {
    let certs = info["cert"]["certificates"]
        .as_array()
        .ok_or_else(|| TrustError::new("the provider sent no certificate"))?;
    let mut chain = Vec::new();
    for cert in certs {
        let der = unb64(cert.as_str().unwrap_or_default())?;
        chain.push(Certificate::from_der(&der).map_err(|e| TrustError::new(e.to_string()))?);
    }
    if chain.is_empty() {
        return Err(TrustError::new("the provider sent no certificate"));
    }
    let certificate = chain.remove(0);
    Ok(Identity { certificate, chain })
}

impl CscTrustService {
    pub fn new(config: CscConfig, http: OutboundHttp) -> Self {
        let tsa = config.tsa_url.clone().map(|url| HttpTsa {
            url,
            basic: config.tsa_basic.clone(),
            http: http.clone(),
        });
        Self {
            config,
            http,
            tsa,
            service_token: Mutex::new(None),
            seal: OnceCell::new(),
        }
    }

    fn oauth(&self, path: &str) -> String {
        let base =
            self.config.oauth_url.clone().unwrap_or_else(|| {
                format!("{}/oauth2", self.config.base_url.trim_end_matches('/'))
            });
        format!("{}/{path}", base.trim_end_matches('/'))
    }

    fn api(&self, path: &str) -> String {
        format!("{}/{path}", self.config.base_url.trim_end_matches('/'))
    }

    fn profile(&self, level: Level) -> Option<&str> {
        match level {
            Level::Aes => self.config.aes_profile.as_deref(),
            Level::Qes => self.config.qes_profile.as_deref(),
        }
    }

    async fn post_json(&self, path: &str, token: &str, body: &Value) -> Result<Value, TrustError> {
        let request = HttpRequest::json("POST", self.api(path), body)
            .header("authorization", format!("Bearer {token}"));
        let response =
            self.http.send(request).await.map_err(|e| {
                TrustError::new(format!("{} unreachable: {e}", self.config.provider))
            })?;
        let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        if !response.ok() {
            let reason = value["error_description"]
                .as_str()
                .or_else(|| value["error"].as_str())
                .unwrap_or_default();
            return Err(TrustError::new(format!(
                "{} answered {} on {path}: {reason}",
                self.config.provider, response.status
            )));
        }
        Ok(value)
    }

    async fn token(&self, params: &[(&str, &str)]) -> Result<(String, u64), TrustError> {
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: self.oauth("token"),
            headers: vec![(
                "content-type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            )],
            body: Some(form_body(params)),
        };
        let response =
            self.http.send(request).await.map_err(|e| {
                TrustError::new(format!("{} unreachable: {e}", self.config.provider))
            })?;
        let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let Some(token) = value["access_token"].as_str().filter(|_| response.ok()) else {
            let error = value["error"].as_str().unwrap_or_default();
            if error == "access_denied" {
                return Err(TrustError::cancelled("the signer did not authorise"));
            }
            return Err(TrustError::new(format!(
                "{} refused the token ({}): {error}",
                self.config.provider, response.status
            )));
        };
        Ok((
            token.to_owned(),
            value["expires_in"].as_u64().unwrap_or(300),
        ))
    }

    /// The install's own token (client credentials), cached until shortly
    /// before it expires.
    async fn service_token(&self) -> Result<String, TrustError> {
        let mut cached = self.service_token.lock().await;
        if let Some((token, until)) = cached.as_ref()
            && Instant::now() < *until
        {
            return Ok(token.clone());
        }
        let (token, expires_in) = self
            .token(&[
                ("grant_type", "client_credentials"),
                ("client_id", &self.config.client_id),
                ("client_secret", &self.config.client_secret),
                ("scope", "service"),
            ])
            .await?;
        let until = Instant::now() + Duration::from_secs(expires_in.saturating_sub(60).max(30));
        *cached = Some((token.clone(), until));
        Ok(token)
    }

    async fn exchange(&self, callback: &Callback<'_>) -> Result<String, TrustError> {
        self.token(&[
            ("grant_type", "authorization_code"),
            ("code", callback.code),
            ("client_id", &self.config.client_id),
            ("client_secret", &self.config.client_secret),
            ("redirect_uri", callback.redirect_uri),
            ("code_verifier", callback.code_verifier),
        ])
        .await
        .map(|(token, _)| token)
    }

    async fn sign_hash(
        &self,
        token: &str,
        credential_id: &str,
        sad: Option<&str>,
        spki: &[u8],
        data: &[u8],
    ) -> Result<Vec<u8>, TrustError> {
        let mut body = json!({
            "credentialID": credential_id,
            "hashes": [b64(&crypto::sha256(data))],
            "hashAlgorithmOID": oid::SHA256,
            "signAlgo": crypto::signature_algorithm_for(spki).oid,
        });
        if let Some(sad) = sad {
            body["SAD"] = Value::String(sad.to_owned());
        }
        let value = self.post_json("signatures/signHash", token, &body).await?;
        let signature = value["signatures"][0]
            .as_str()
            .ok_or_else(|| TrustError::new("the provider returned no signature"))?;
        Ok(der_ecdsa(spki, unb64(signature)?))
    }
}

impl TrustService for CscTrustService {
    fn provider(&self) -> &str {
        &self.config.provider
    }

    fn offers(&self, level: Level) -> bool {
        self.profile(level).is_some()
    }

    fn seals(&self) -> bool {
        self.config.seal_credential_id.is_some()
    }

    fn seal_identity(&self) -> BoxFuture<'_, Result<Identity, TrustError>> {
        Box::pin(async move {
            let credential_id = self
                .config
                .seal_credential_id
                .as_deref()
                .ok_or_else(|| TrustError::new("no seal credential configured"))?;
            self.seal
                .get_or_try_init(|| async {
                    let token = self.service_token().await?;
                    let info = self
                        .post_json(
                            "credentials/info",
                            &token,
                            &json!({ "credentialID": credential_id, "certificates": "chain", "certInfo": false }),
                        )
                        .await?;
                    identity_of(&info)
                })
                .await
                .cloned()
        })
    }

    fn seal_sign<'a>(
        &'a self,
        data_to_be_signed: &'a [u8],
    ) -> BoxFuture<'a, Result<Vec<u8>, TrustError>> {
        Box::pin(async move {
            let identity = self.seal_identity().await?;
            let credential_id = self
                .config
                .seal_credential_id
                .as_deref()
                .unwrap_or_default();
            let token = self.service_token().await?;
            let mut authorize = json!({
                "credentialID": credential_id,
                "numSignatures": 1,
                "hashes": [b64(&crypto::sha256(data_to_be_signed))],
                "hashAlgorithmOID": oid::SHA256,
            });
            if let Some(pin) = &self.config.seal_pin {
                authorize["PIN"] = Value::String(pin.clone());
            }
            let sad = self
                .post_json("credentials/authorize", &token, &authorize)
                .await?;
            let sad = sad["SAD"].as_str().map(str::to_owned);
            self.sign_hash(
                &token,
                credential_id,
                sad.as_deref(),
                &identity.certificate.spki,
                data_to_be_signed,
            )
            .await
        })
    }

    fn timestamp<'a>(
        &'a self,
        digest: &'a [u8],
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, TrustError>> {
        Box::pin(async move {
            match &self.tsa {
                Some(tsa) => tsa.token(digest).await.map(Some),
                None => Ok(None),
            }
        })
    }

    fn validation_data<'a>(
        &'a self,
        chains: &'a [Vec<Certificate>],
    ) -> BoxFuture<'a, Result<ValidationData, TrustError>> {
        Box::pin(async move { Ok(revocation::collect(Some(&self.http), chains).await) })
    }

    fn identify_url(&self, request: &IdentifyRequest<'_>) -> Result<String, TrustError> {
        let profile = self
            .profile(request.level)
            .ok_or_else(|| TrustError::new("this level is not offered"))?;
        let mut params = vec![
            ("response_type", "code"),
            ("client_id", self.config.client_id.as_str()),
            ("redirect_uri", request.redirect_uri),
            ("scope", "service"),
            ("code_challenge", request.code_challenge),
            ("code_challenge_method", "S256"),
            ("state", request.state),
            ("lang", request.locale),
            ("clientData", profile),
        ];
        if let Some(email) = request.signer_email {
            params.push(("login_hint", email));
        }
        Ok(with_query(&self.oauth("authorize"), &params))
    }

    fn identified<'a>(
        &'a self,
        level: Level,
        callback: Callback<'a>,
    ) -> BoxFuture<'a, Result<SignerCredential, TrustError>> {
        Box::pin(async move {
            let token = self.exchange(&callback).await?;
            let mut body =
                json!({ "credentialInfo": true, "certificates": "chain", "certInfo": false });
            if let Some(profile) = self.profile(level) {
                body["clientData"] = Value::String(profile.to_owned());
            }
            let list = self.post_json("credentials/list", &token, &body).await?;
            let ids: Vec<String> = list["credentialIDs"]
                .as_array()
                .map(|ids| {
                    ids.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let now = std::time::SystemTime::now();
            let now = time::OffsetDateTime::from(now);
            for (i, id) in ids.iter().enumerate() {
                let info = match list["credentialInfos"].get(i) {
                    Some(info) if info["cert"]["certificates"].is_array() => info.clone(),
                    _ => {
                        self.post_json(
                            "credentials/info",
                            &token,
                            &json!({ "credentialID": id, "certificates": "chain", "certInfo": false }),
                        )
                        .await?
                    }
                };
                let identity = identity_of(&info)?;
                if !identity.certificate.valid_at(now) {
                    continue;
                }
                if level == Level::Qes && !identity.certificate.qualified_with_qscd() {
                    continue;
                }
                return Ok(SignerCredential {
                    credential_id: id.clone(),
                    identity,
                    access_token: token,
                    identity_method: None,
                });
            }
            Err(TrustError::new(match level {
                Level::Qes => "the provider has no valid qualified certificate for this signer",
                Level::Aes => "the provider has no valid certificate for this signer",
            }))
        })
    }

    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> Result<String, TrustError> {
        let hash = URL_SAFE_NO_PAD.encode(crypto::sha256(request.data_to_be_signed));
        Ok(with_query(
            &self.oauth("authorize"),
            &[
                ("response_type", "code"),
                ("client_id", &self.config.client_id),
                ("redirect_uri", request.redirect_uri),
                ("scope", "credential"),
                ("credentialID", &request.credential.credential_id),
                ("numSignatures", "1"),
                ("hashes", &hash),
                ("hashAlgorithmOID", oid::SHA256),
                ("code_challenge", request.code_challenge),
                ("code_challenge_method", "S256"),
                ("state", request.state),
                ("description", request.description),
                ("lang", request.locale),
            ],
        ))
    }

    fn sign_authorized<'a>(
        &'a self,
        credential: &'a SignerCredential,
        data_to_be_signed: &'a [u8],
        callback: Callback<'a>,
    ) -> BoxFuture<'a, Result<Vec<u8>, TrustError>> {
        Box::pin(async move {
            let token = self.exchange(&callback).await?;
            self.sign_hash(
                &token,
                &credential.credential_id,
                None,
                &credential.identity.certificate.spki,
                data_to_be_signed,
            )
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_ecdsa_signatures_become_der() {
        let ca = weldsuite_pades::local::LocalCa::new("t").expect("ca");
        let spki = ca.root().spki.clone();
        let raw = vec![0x80u8; 64];
        let der = der_ecdsa(&spki, raw);
        assert_eq!(der[0], der::SEQUENCE);
        assert_eq!(der.len(), 2 + 2 * (2 + 33));
        let already = vec![der::SEQUENCE, 0x02, 0x02, 0x01, 0x01];
        assert_eq!(der_ecdsa(&spki, already.clone()), already);
    }

    #[test]
    fn the_authorize_url_carries_the_hash_and_credential() {
        let service = CscTrustService::new(
            CscConfig {
                provider: "QTSP".to_owned(),
                base_url: "https://qtsp.example/csc/v2/".to_owned(),
                client_id: "weldsign".to_owned(),
                qes_profile: Some("qes-remote".to_owned()),
                ..CscConfig::default()
            },
            OutboundHttp(std::sync::Arc::new(Never)),
        );
        assert!(service.offers(Level::Qes));
        assert!(!service.offers(Level::Aes));
        assert!(!service.seals());
        let identify = service
            .identify_url(&IdentifyRequest {
                level: Level::Qes,
                redirect_uri: "https://sign.example/signature-callback",
                state: "s1",
                code_challenge: "c1",
                signer_name: None,
                signer_email: Some("ann@example.com"),
                locale: "nl",
            })
            .expect("url");
        assert!(
            identify.starts_with("https://qtsp.example/csc/v2/oauth2/authorize?response_type=code")
        );
        assert!(identify.contains("scope=service"));
        assert!(identify.contains("clientData=qes-remote"));
        assert!(identify.contains("login_hint=ann%40example.com"));
    }

    struct Never;

    impl weldsuite_ports::DynOutboundHttp for Never {
        fn send(
            &self,
            _request: HttpRequest,
        ) -> BoxFuture<'_, Result<weldsuite_ports::HttpResponse, weldsuite_ports::PortError>>
        {
            Box::pin(std::future::ready(Ok(weldsuite_ports::HttpResponse::new(
                500,
                Vec::new(),
            ))))
        }
    }
}
