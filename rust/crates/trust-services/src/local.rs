//! `SIGN_TRUST_MODE=local`: a test CA, seal and TSA in process, and
//! "signers" whose certificate is issued on the spot. The redirects bounce
//! straight back to WeldSign, so the whole advanced and qualified flow runs
//! without a provider. Keys live in this process: one replica only, and a
//! restart forgets a signer who was halfway.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use weldsuite_pades::local::{LocalCa, LocalIdentity, LocalTsa, Profile};
use weldsuite_pades::{Certificate, ValidationData, oid};
use weldsuite_ports::BoxFuture;

use crate::{
    AuthorizeRequest, Callback, IdentifyRequest, Identity, Level, SignerCredential, TrustError,
    TrustService, revocation, with_query,
};

/// The provider name signers see.
pub const LOCAL_PROVIDER: &str = "WeldSign test CA";

pub struct LocalTrustService {
    tsa: LocalTsa,
    seal: LocalIdentity,
    ca: LocalCa,
    signers: Mutex<HashMap<String, Arc<LocalIdentity>>>,
}

impl std::fmt::Debug for LocalTrustService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalTrustService").finish_non_exhaustive()
    }
}

fn failed(error: impl std::fmt::Display) -> TrustError {
    TrustError::new(error.to_string())
}

impl LocalTrustService {
    /// A fresh CA, seal ("WeldSuite test seal") and TSA.
    pub fn new() -> Result<Self, TrustError> {
        let ca = LocalCa::new("WeldSign test root").map_err(failed)?;
        let tsa = LocalTsa::new(&ca).map_err(failed)?;
        let seal = ca
            .issue(
                &[
                    (oid::COUNTRY, "NL"),
                    (oid::ORGANIZATION, "WeldSuite (test)"),
                    (oid::COMMON_NAME, "WeldSuite test seal"),
                ],
                Profile::Seal { qualified: true },
            )
            .map_err(failed)?;
        Ok(Self {
            tsa,
            seal,
            ca,
            signers: Mutex::new(HashMap::new()),
        })
    }

    /// The root every certificate here chains to.
    pub fn root(&self) -> &Certificate {
        self.ca.root()
    }

    fn signer(&self, credential_id: &str) -> Option<Arc<LocalIdentity>> {
        self.signers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(credential_id)
            .cloned()
    }
}

fn encode(text: Option<&str>) -> String {
    URL_SAFE_NO_PAD.encode(text.unwrap_or_default())
}

fn decode(text: &str) -> String {
    URL_SAFE_NO_PAD
        .decode(text)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

impl TrustService for LocalTrustService {
    fn provider(&self) -> &str {
        LOCAL_PROVIDER
    }

    fn offers(&self, _level: Level) -> bool {
        true
    }

    fn seals(&self) -> bool {
        true
    }

    fn seal_identity(&self) -> BoxFuture<'_, Result<Identity, TrustError>> {
        let identity = Identity {
            certificate: self.seal.certificate.clone(),
            chain: self.seal.chain.clone(),
        };
        Box::pin(std::future::ready(Ok(identity)))
    }

    fn seal_sign<'a>(
        &'a self,
        data_to_be_signed: &'a [u8],
    ) -> BoxFuture<'a, Result<Vec<u8>, TrustError>> {
        Box::pin(std::future::ready(
            self.seal.sign(data_to_be_signed).map_err(failed),
        ))
    }

    fn timestamp<'a>(
        &'a self,
        digest: &'a [u8],
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, TrustError>> {
        Box::pin(std::future::ready(
            self.tsa.token(digest).map(Some).map_err(failed),
        ))
    }

    fn validation_data<'a>(
        &'a self,
        chains: &'a [Vec<Certificate>],
    ) -> BoxFuture<'a, Result<ValidationData, TrustError>> {
        Box::pin(async move {
            let mut chains = chains.to_vec();
            chains.push(vec![self.tsa.certificate().clone(), self.ca.root().clone()]);
            Ok(revocation::collect(None, &chains).await)
        })
    }

    fn identify_url(&self, request: &IdentifyRequest<'_>) -> Result<String, TrustError> {
        let code = format!(
            "local.{}.{}.{}",
            request.level.as_str(),
            encode(request.signer_name),
            encode(request.signer_email)
        );
        Ok(with_query(
            request.redirect_uri,
            &[("code", &code), ("state", request.state)],
        ))
    }

    fn identified<'a>(
        &'a self,
        level: Level,
        callback: Callback<'a>,
    ) -> BoxFuture<'a, Result<SignerCredential, TrustError>> {
        Box::pin(async move {
            let parts: Vec<&str> = callback.code.split('.').collect();
            let [_, _, name, email] = parts[..] else {
                return Err(TrustError::new("not a local code"));
            };
            let (name, email) = (decode(name), decode(email));
            let common_name = if name.is_empty() {
                if email.is_empty() {
                    "Test signer".to_owned()
                } else {
                    email.clone()
                }
            } else {
                name
            };
            let mut subject = vec![
                (oid::COUNTRY, "NL"),
                (oid::COMMON_NAME, common_name.as_str()),
            ];
            if !email.is_empty() {
                subject.push((oid::EMAIL_ADDRESS, email.as_str()));
            }
            let identity = self
                .ca
                .issue(
                    &subject,
                    Profile::Signer {
                        qualified: level == Level::Qes,
                    },
                )
                .map_err(failed)?;
            let mut id = [0u8; 12];
            let _ = SystemRandom::new().fill(&mut id);
            let credential_id = URL_SAFE_NO_PAD.encode(id);
            let credential = SignerCredential {
                credential_id: credential_id.clone(),
                identity: Identity {
                    certificate: identity.certificate.clone(),
                    chain: identity.chain.clone(),
                },
                access_token: "local".to_owned(),
                identity_method: Some("test".to_owned()),
            };
            self.signers
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(credential_id, Arc::new(identity));
            Ok(credential)
        })
    }

    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> Result<String, TrustError> {
        Ok(with_query(
            request.redirect_uri,
            &[("code", "local.authorize"), ("state", request.state)],
        ))
    }

    fn sign_authorized<'a>(
        &'a self,
        credential: &'a SignerCredential,
        data_to_be_signed: &'a [u8],
        _callback: Callback<'a>,
    ) -> BoxFuture<'a, Result<Vec<u8>, TrustError>> {
        Box::pin(async move {
            let signer = self
                .signer(&credential.credential_id)
                .ok_or_else(|| TrustError::new("the test signer is gone (process restarted)"))?;
            signer.sign(data_to_be_signed).map_err(failed)
        })
    }
}
