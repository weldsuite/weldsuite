//! The install's Digipoort connection, from the environment. One PKIoverheid
//! certificate per install (the operator's: WeldSuite on the EU edition, the
//! customer on a self-hosted one) signs and sends every workspace's filings,
//! as the intermediary.
//!
//! | Variable | Meaning |
//! |---|---|
//! | `DIGIPOORT_MODE` | `preprod` or `production`; unset or `simulated` leaves Digipoort off |
//! | `DIGIPOORT_AANLEVER_URL` | the aanleverservice endpoint of that environment |
//! | `DIGIPOORT_STATUS_URL` | the statusinformatieservice endpoint |
//! | `DIGIPOORT_CERT` | the PKIoverheid services server certificate, PEM, leaf first, with its intermediates |
//! | `DIGIPOORT_KEY` | its private key, unencrypted RSA PEM (PKCS#8 or PKCS#1) |
//! | `DIGIPOORT_CA` | optional: the CA certificates (PEM) Digipoort's own server certificate chains to, when they are not in the system trust store (PKIoverheid private roots) |
//!
//! The endpoints are configuration, not code: Logius publishes them per
//! environment in the Aansluit Suite and changed them in the 2025–2026
//! migration to the new Digipoort, so the install names them.

/// `preprod` (Logius' pre-production, the Belastingdienst and KvK test
/// chain) or `production`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Preprod,
    Production,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preprod => "preprod",
            Self::Production => "production",
        }
    }
}

pub const ENV_MODE: &str = "DIGIPOORT_MODE";
pub const ENV_AANLEVER_URL: &str = "DIGIPOORT_AANLEVER_URL";
pub const ENV_STATUS_URL: &str = "DIGIPOORT_STATUS_URL";
pub const ENV_CERT: &str = "DIGIPOORT_CERT";
pub const ENV_KEY: &str = "DIGIPOORT_KEY";
pub const ENV_CA: &str = "DIGIPOORT_CA";

/// Why the configuration can't be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// A configured connection.
#[derive(Clone, PartialEq, Eq)]
pub struct DigipoortConfig {
    pub mode: Mode,
    pub aanlever_url: String,
    pub status_url: String,
    /// The certificate chain, PEM, `\n` escapes resolved.
    pub certificate_pem: String,
    pub private_key_pem: String,
    /// Extra trust anchors for Digipoort's server certificate, PEM.
    pub ca_pem: Option<String>,
}

impl std::fmt::Debug for DigipoortConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DigipoortConfig")
            .field("mode", &self.mode)
            .field("aanlever_url", &self.aanlever_url)
            .field("status_url", &self.status_url)
            .field("ca", &self.ca_pem.is_some())
            .finish_non_exhaustive()
    }
}

impl DigipoortConfig {
    /// The connection the environment describes: `Ok(None)` when Digipoort
    /// is off (no `DIGIPOORT_MODE`, or `simulated`), an error when it is on
    /// but incomplete.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, ConfigError> {
        let filled = |name: &str| {
            get(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let mode = match filled(ENV_MODE).map(|m| m.to_ascii_lowercase()).as_deref() {
            None | Some("simulated") => return Ok(None),
            Some("preprod") => Mode::Preprod,
            Some("production") => Mode::Production,
            Some(other) => {
                return Err(ConfigError(format!(
                    "{ENV_MODE} is \"{other}\"; expected preprod, production or simulated"
                )));
            }
        };
        let missing: Vec<&str> = [ENV_AANLEVER_URL, ENV_STATUS_URL, ENV_CERT, ENV_KEY]
            .into_iter()
            .filter(|name| filled(name).is_none())
            .collect();
        if !missing.is_empty() {
            return Err(ConfigError(format!(
                "{ENV_MODE} is {} but {} {} not set",
                mode.as_str(),
                missing.join(", "),
                if missing.len() == 1 { "is" } else { "are" }
            )));
        }
        let url = |name: &str| -> Result<String, ConfigError> {
            let value = filled(name).unwrap_or_default();
            if value.starts_with("https://") {
                Ok(value)
            } else {
                Err(ConfigError(format!("{name} must be an https:// URL")))
            }
        };
        Ok(Some(Self {
            mode,
            aanlever_url: url(ENV_AANLEVER_URL)?,
            status_url: url(ENV_STATUS_URL)?,
            certificate_pem: crate::signature::normalize_pem(&filled(ENV_CERT).unwrap_or_default()),
            private_key_pem: crate::signature::normalize_pem(&filled(ENV_KEY).unwrap_or_default()),
            ca_pem: filled(ENV_CA).map(|pem| crate::signature::normalize_pem(&pem)),
        }))
    }

    /// The certificate chain and key in one PEM, as an mTLS client identity
    /// takes them.
    pub fn identity_pem(&self) -> String {
        format!("{}\n{}\n", self.certificate_pem, self.private_key_pem)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    #[test]
    fn off_unless_a_mode_is_set() {
        assert_eq!(DigipoortConfig::from_env(env(&[])), Ok(None));
        assert_eq!(
            DigipoortConfig::from_env(env(&[(ENV_MODE, "simulated")])),
            Ok(None)
        );
        assert!(DigipoortConfig::from_env(env(&[(ENV_MODE, "live")])).is_err());
    }

    #[test]
    fn names_what_is_missing() {
        let error = DigipoortConfig::from_env(env(&[
            (ENV_MODE, "preprod"),
            (ENV_AANLEVER_URL, "https://a.test/aanleveren"),
        ]))
        .expect_err("incomplete");
        assert_eq!(
            error.0,
            "DIGIPOORT_MODE is preprod but DIGIPOORT_STATUS_URL, DIGIPOORT_CERT, DIGIPOORT_KEY are not set"
        );
        let plain = DigipoortConfig::from_env(env(&[
            (ENV_MODE, "production"),
            (ENV_AANLEVER_URL, "http://a.test"),
            (ENV_STATUS_URL, "https://a.test/status"),
            (ENV_CERT, "c"),
            (ENV_KEY, "k"),
        ]));
        assert_eq!(
            plain,
            Err(ConfigError(
                "DIGIPOORT_AANLEVER_URL must be an https:// URL".to_owned()
            ))
        );
    }

    #[test]
    fn reads_a_complete_connection() {
        let config = DigipoortConfig::from_env(env(&[
            (ENV_MODE, " Production "),
            (ENV_AANLEVER_URL, "https://a.test/aanleveren"),
            (ENV_STATUS_URL, "https://a.test/status"),
            (
                ENV_CERT,
                "-----BEGIN CERTIFICATE-----\\nAA==\\n-----END CERTIFICATE-----",
            ),
            (ENV_KEY, "key"),
        ]))
        .expect("valid")
        .expect("on");
        assert_eq!(config.mode, Mode::Production);
        assert_eq!(
            config.certificate_pem,
            "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----"
        );
        assert_eq!(config.ca_pem, None);
        assert!(config.identity_pem().contains("key"));
    }
}
