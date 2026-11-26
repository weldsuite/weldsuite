//! `SIGN_TRUST_MODE=key`: a self-hosted operator's own seal, a key and
//! certificate in PEM (as Digipoort takes its certificate), with any RFC
//! 3161 TSA. A key in a file is never in a QSCD, so this seal is advanced
//! at best, never qualified. No advanced or qualified signers.

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{
    ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, RSA_PKCS1_SHA256, RsaKeyPair,
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use weldsuite_pades::{Certificate, ValidationData};
use weldsuite_ports::{BoxFuture, OutboundHttp};

use crate::tsa::HttpTsa;
use crate::{
    AuthorizeRequest, Callback, IdentifyRequest, Identity, Level, SignerCredential, TrustError,
    TrustService, revocation,
};

enum SealKey {
    Ec(EcdsaKeyPair),
    Rsa(RsaKeyPair),
}

pub struct KeyFileSeal {
    provider: String,
    identity: Identity,
    key: SealKey,
    tsa: Option<HttpTsa>,
    http: Option<OutboundHttp>,
}

impl std::fmt::Debug for KeyFileSeal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyFileSeal")
            .field("provider", &self.provider)
            .finish_non_exhaustive()
    }
}

/// The DER inside the first PEM block labelled `label`.
fn pem_block(pem: &str, label: &str) -> Option<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let start = pem.find(&begin)? + begin.len();
    let stop = pem[start..].find(&end)? + start;
    let body: String = pem[start..stop].split_whitespace().collect();
    STANDARD.decode(body).ok()
}

impl KeyFileSeal {
    /// From `cert_pem` (leaf first, then its chain) and an unencrypted
    /// PKCS #8 `key_pem` (P-256 or RSA).
    pub fn new(
        provider: String,
        cert_pem: &str,
        key_pem: &str,
        tsa: Option<HttpTsa>,
        http: Option<OutboundHttp>,
    ) -> Result<Self, TrustError> {
        let mut certs =
            Certificate::from_pem(cert_pem).map_err(|e| TrustError::new(e.to_string()))?;
        if certs.is_empty() {
            return Err(TrustError::new("SIGN_SEAL_CERT holds no certificate"));
        }
        let certificate = certs.remove(0);
        let der = pem_block(key_pem, "PRIVATE KEY").ok_or_else(|| {
            TrustError::new("SIGN_SEAL_KEY is not an unencrypted PKCS #8 PEM key")
        })?;
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &der)
            .map(SealKey::Ec)
            .or_else(|_| RsaKeyPair::from_pkcs8(&der).map(SealKey::Rsa))
            .map_err(|_| TrustError::new("SIGN_SEAL_KEY is neither a P-256 nor an RSA key"))?;
        Ok(Self {
            provider,
            identity: Identity {
                certificate,
                chain: certs,
            },
            key,
            tsa,
            http,
        })
    }

    fn sign(&self, data: &[u8]) -> Result<Vec<u8>, TrustError> {
        let rng = SystemRandom::new();
        match &self.key {
            SealKey::Ec(key) => key
                .sign(&rng, data)
                .map(|s| s.as_ref().to_vec())
                .map_err(|_| TrustError::new("seal signing failed")),
            SealKey::Rsa(key) => {
                let mut signature = vec![0u8; key.public_modulus_len()];
                key.sign(&RSA_PKCS1_SHA256, &rng, data, &mut signature)
                    .map_err(|_| TrustError::new("seal signing failed"))?;
                Ok(signature)
            }
        }
    }
}

fn not_offered() -> TrustError {
    TrustError::new("this server offers no advanced or qualified signatures")
}

impl TrustService for KeyFileSeal {
    fn provider(&self) -> &str {
        &self.provider
    }

    fn offers(&self, _level: Level) -> bool {
        false
    }

    fn seals(&self) -> bool {
        true
    }

    fn seal_identity(&self) -> BoxFuture<'_, Result<Identity, TrustError>> {
        Box::pin(std::future::ready(Ok(self.identity.clone())))
    }

    fn seal_sign<'a>(
        &'a self,
        data_to_be_signed: &'a [u8],
    ) -> BoxFuture<'a, Result<Vec<u8>, TrustError>> {
        Box::pin(std::future::ready(self.sign(data_to_be_signed)))
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
        Box::pin(async move { Ok(revocation::collect(self.http.as_ref(), chains).await) })
    }

    fn identify_url(&self, _request: &IdentifyRequest<'_>) -> Result<String, TrustError> {
        Err(not_offered())
    }

    fn identified<'a>(
        &'a self,
        _level: Level,
        _callback: Callback<'a>,
    ) -> BoxFuture<'a, Result<SignerCredential, TrustError>> {
        Box::pin(std::future::ready(Err(not_offered())))
    }

    fn authorize_url(&self, _request: &AuthorizeRequest<'_>) -> Result<String, TrustError> {
        Err(not_offered())
    }

    fn sign_authorized<'a>(
        &'a self,
        _credential: &'a SignerCredential,
        _data_to_be_signed: &'a [u8],
        _callback: Callback<'a>,
    ) -> BoxFuture<'a, Result<Vec<u8>, TrustError>> {
        Box::pin(std::future::ready(Err(not_offered())))
    }
}
