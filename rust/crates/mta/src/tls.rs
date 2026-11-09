//! Server certificates from PEM files (a cert-manager Secret mounted into
//! the pod), reloaded when the files change: cert-manager renews them in
//! place, and a long-running MTA must pick the new pair up.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;

#[derive(Debug)]
pub struct TlsError(pub String);

impl std::fmt::Display for TlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TLS: {}", self.0)
    }
}

impl std::error::Error for TlsError {}

fn load(cert: &str, key: &str) -> Result<TlsAcceptor, TlsError> {
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .map_err(|e| TlsError(format!("{cert}: {e}")))?
        .collect::<Result<_, _>>()
        .map_err(|e| TlsError(format!("{cert}: {e}")))?;
    if chain.is_empty() {
        return Err(TlsError(format!("{cert}: no certificate")));
    }
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| TlsError(format!("{key}: {e}")))?;
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| TlsError(e.to_string()))?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|e| TlsError(e.to_string()))?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

fn modified(path: &str) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

struct Current {
    acceptor: TlsAcceptor,
    stamp: (Option<SystemTime>, Option<SystemTime>),
    checked: Instant,
}

/// A certificate pair that reloads itself (checked at most once a minute).
pub struct Reloading {
    cert: String,
    key: String,
    current: Mutex<Current>,
}

impl std::fmt::Debug for Reloading {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reloading")
            .field("cert", &self.cert)
            .finish_non_exhaustive()
    }
}

impl Reloading {
    pub fn new(cert: &str, key: &str) -> Result<Self, TlsError> {
        let acceptor = load(cert, key)?;
        Ok(Self {
            cert: cert.to_owned(),
            key: key.to_owned(),
            current: Mutex::new(Current {
                acceptor,
                stamp: (modified(cert), modified(key)),
                checked: Instant::now(),
            }),
        })
    }

    pub fn acceptor(&self) -> TlsAcceptor {
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if current.checked.elapsed() >= Duration::from_secs(60) {
            current.checked = Instant::now();
            let stamp = (modified(&self.cert), modified(&self.key));
            if stamp != current.stamp {
                match load(&self.cert, &self.key) {
                    Ok(acceptor) => {
                        tracing::info!(cert = %self.cert, "TLS certificate reloaded");
                        current.acceptor = acceptor;
                        current.stamp = stamp;
                    }
                    Err(error) => {
                        tracing::warn!(%error, "TLS certificate reload failed; keeping the old one");
                    }
                }
            }
        }
        current.acceptor.clone()
    }
}
