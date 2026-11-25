//! The install's trust services from its environment.
//!
//! | Variable | Meaning |
//! |---|---|
//! | `SIGN_TRUST_MODE` | `off` (default), `local`, `key` or `csc` |
//! | `SIGN_CSC_PROVIDER` | the QTSP's name, shown to signers (`csc`) |
//! | `SIGN_CSC_BASE_URL` | the CSC API v2 base (`csc`) |
//! | `SIGN_CSC_OAUTH_URL` | the OAuth server; `<base>/oauth2` when unset |
//! | `SIGN_CSC_CLIENT_ID`, `SIGN_CSC_CLIENT_SECRET` | WeldSign's client at the QTSP |
//! | `SIGN_CSC_AES_PROFILE`, `SIGN_CSC_QES_PROFILE` | the provider's profile per level; unset hides the level |
//! | `SIGN_SEAL_CREDENTIAL_ID`, `SIGN_SEAL_PIN` | the seal credential at the QTSP (`csc`) |
//! | `SIGN_SEAL_CERT`, `SIGN_SEAL_KEY` | PEM certificate chain and PKCS #8 key (`key`) |
//! | `SIGN_SEAL_NAME` | the seal's name as shown (`key`) |
//! | `SIGN_TSA_URL`, `SIGN_TSA_USERNAME`, `SIGN_TSA_PASSWORD` | an RFC 3161 TSA (`csc`, `key`) |
//!
//! `local` is refused when the install says it is production.

use std::sync::Arc;

use weldsuite_ports::OutboundHttp;

use crate::TrustService;
use crate::csc::{CscConfig, CscTrustService};
use crate::keyfile::KeyFileSeal;
use crate::local::LocalTrustService;
use crate::tsa::HttpTsa;

fn required(get: &impl Fn(&str) -> Option<String>, name: &str) -> Result<String, String> {
    get(name)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("{name} is required with SIGN_TRUST_MODE"))
}

fn optional(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    get(name).filter(|v| !v.trim().is_empty())
}

fn tsa_basic(get: &impl Fn(&str) -> Option<String>) -> Option<(String, String)> {
    Some((
        optional(get, "SIGN_TSA_USERNAME")?,
        optional(get, "SIGN_TSA_PASSWORD")?,
    ))
}

/// The trust services `get` (an environment lookup) describes; `None` when
/// off. `http` is the outbound client (`csc` and `key` need it).
pub fn from_env(
    get: impl Fn(&str) -> Option<String>,
    http: Option<OutboundHttp>,
    production: bool,
) -> Result<Option<Arc<dyn TrustService>>, String> {
    let mode = optional(&get, "SIGN_TRUST_MODE").unwrap_or_else(|| "off".to_owned());
    match mode.trim() {
        "off" => Ok(None),
        "local" => {
            if production {
                return Err(
                    "SIGN_TRUST_MODE=local is a test CA and is refused in production".to_owned(),
                );
            }
            tracing::warn!(
                "SIGN_TRUST_MODE=local: signatures and seals come from a test CA nobody trusts"
            );
            let service = LocalTrustService::new().map_err(|e| e.to_string())?;
            Ok(Some(Arc::new(service)))
        }
        "key" => {
            let http = http.ok_or("SIGN_TRUST_MODE=key needs outbound HTTP")?;
            let tsa = optional(&get, "SIGN_TSA_URL").map(|url| HttpTsa {
                url,
                basic: tsa_basic(&get),
                http: http.clone(),
            });
            let seal = KeyFileSeal::new(
                optional(&get, "SIGN_SEAL_NAME").unwrap_or_else(|| "Seal".to_owned()),
                &required(&get, "SIGN_SEAL_CERT")?,
                &required(&get, "SIGN_SEAL_KEY")?,
                tsa,
                Some(http),
            )
            .map_err(|e| e.to_string())?;
            Ok(Some(Arc::new(seal)))
        }
        "csc" => {
            let http = http.ok_or("SIGN_TRUST_MODE=csc needs outbound HTTP")?;
            let config = CscConfig {
                provider: required(&get, "SIGN_CSC_PROVIDER")?,
                base_url: required(&get, "SIGN_CSC_BASE_URL")?,
                oauth_url: optional(&get, "SIGN_CSC_OAUTH_URL"),
                client_id: required(&get, "SIGN_CSC_CLIENT_ID")?,
                client_secret: required(&get, "SIGN_CSC_CLIENT_SECRET")?,
                aes_profile: optional(&get, "SIGN_CSC_AES_PROFILE"),
                qes_profile: optional(&get, "SIGN_CSC_QES_PROFILE"),
                seal_credential_id: optional(&get, "SIGN_SEAL_CREDENTIAL_ID"),
                seal_pin: optional(&get, "SIGN_SEAL_PIN"),
                tsa_url: optional(&get, "SIGN_TSA_URL"),
                tsa_basic: tsa_basic(&get),
            };
            Ok(Some(Arc::new(CscTrustService::new(config, http))))
        }
        other => Err(format!(
            "SIGN_TRUST_MODE must be off, local, key or csc (got {other})"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        }
    }

    #[test]
    fn modes() {
        assert!(from_env(env(&[]), None, true).expect("off").is_none());
        let local = from_env(env(&[("SIGN_TRUST_MODE", "local")]), None, false)
            .expect("local")
            .expect("service");
        assert!(local.seals());
        assert!(from_env(env(&[("SIGN_TRUST_MODE", "local")]), None, true).is_err());
        assert!(from_env(env(&[("SIGN_TRUST_MODE", "nope")]), None, false).is_err());
        assert!(from_env(env(&[("SIGN_TRUST_MODE", "csc")]), None, false).is_err());
    }
}
