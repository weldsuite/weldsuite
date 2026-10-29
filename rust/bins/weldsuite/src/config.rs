//! Configuration, from environment variables only, so the same image runs in
//! every cluster. Secrets come from Kubernetes Secrets mounted as variables;
//! nothing here is ever logged except through [`Config`]'s `Debug`, which
//! hides them.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use weldsuite_db::{Keyring, WorkspaceConfig};

/// Where the Clerk session token key comes from.
#[derive(Clone)]
pub(crate) enum ClerkKey {
    /// `CLERK_JWT_KEY`: the instance's PEM public key.
    Pem(String),
    /// `CLERK_JWKS_FILE`: a JWKS document on disk (a mounted `ConfigMap`).
    Jwks(String),
    /// `CLERK_JWKS_URL`: a JWKS document fetched and refreshed over HTTP.
    JwksUrl(String),
    /// `CLERK_SECRET_KEY`: the keys fetched from Clerk's Backend API.
    SecretKey(String),
}

/// Log lines as JSON (for the cluster's log pipeline) or text (local runs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LogFormat {
    Json,
    Text,
}

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) listen: SocketAddr,
    /// `ENVIRONMENT`, reported by `/health`.
    pub(crate) environment: String,
    pub(crate) master_database_url: String,
    pub(crate) master_max_connections: u32,
    pub(crate) keyring: Keyring,
    pub(crate) clerk_key: ClerkKey,
    /// `CLERK_AUTHORIZED_PARTIES`: extra origins allowed as `azp`.
    pub(crate) authorized_parties: Option<String>,
    /// `PERMISSIONS_APP_ENFORCE=true`: refuse per-app denials instead of
    /// logging them.
    pub(crate) permissions_app_enforce: bool,
    pub(crate) workspaces: WorkspaceConfig,
    pub(crate) log_format: LogFormat,
    /// How long `/readyz` fails before the server stops accepting
    /// connections, so the Service stops routing to the pod first.
    pub(crate) shutdown_delay: Duration,
    pub(crate) infra: InfraConfig,
    /// `SIGN_SESSION_SECRET`: keys WeldSign's signer sessions and the stored
    /// hash of access codes; the same value as the TypeScript workers'.
    pub(crate) sign_session_secret: Option<String>,
}

/// Where feature flag values come from (`FEATURE_FLAGS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FlagSourceKind {
    /// Every flag at its catalog default, as the workers without Flagship.
    Defaults,
    /// The master database's flag overrides (`MasterDbFlagSource`).
    MasterDb,
}

/// The open-source services behind the ports (ADR OPS-013). Each is optional:
/// without it the server runs, and the side effect it carries is skipped with
/// a warning, as the workers do without the binding.
#[derive(Clone)]
#[cfg_attr(feature = "conformance", allow(dead_code))]
pub(crate) struct InfraConfig {
    /// `VALKEY_URL`: cache and realtime publish.
    pub(crate) valkey_url: Option<String>,
    pub(crate) valkey_cache_prefix: String,
    /// The WebSocket gateway subscribes under the same prefix.
    pub(crate) valkey_realtime_prefix: String,
    /// `NATS_URL`: the entity-event stream.
    pub(crate) nats_url: Option<String>,
    pub(crate) nats_user: Option<(String, String)>,
    pub(crate) nats_token: Option<String>,
    pub(crate) nats_stream: String,
    pub(crate) nats_subject_prefix: String,
    /// `NATS_ENSURE_STREAMS=true`: create or update the stream at start.
    pub(crate) nats_ensure_streams: bool,
    pub(crate) flags: FlagSourceKind,
    pub(crate) flags_refresh: Duration,
    /// `TEST_FIXTURES_TOKEN`: unlocks `X-Test-Flags` outside production.
    pub(crate) test_fixtures_token: Option<String>,
}

impl fmt::Debug for InfraConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InfraConfig")
            .field("valkey", &self.valkey_url.as_ref().map(|_| "<set>"))
            .field("nats", &self.nats_url.as_ref().map(|_| "<set>"))
            .field("nats_stream", &self.nats_stream)
            .field("flags", &self.flags)
            .finish_non_exhaustive()
    }
}

impl InfraConfig {
    fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
        refresh_seconds: u64,
    ) -> Self {
        let flags = match lookup("FEATURE_FLAGS").as_deref() {
            None | Some("defaults") => FlagSourceKind::Defaults,
            Some("master-db") => FlagSourceKind::MasterDb,
            Some(_) => {
                problems.push("FEATURE_FLAGS must be defaults or master-db".to_owned());
                FlagSourceKind::Defaults
            }
        };
        let nats_user = match (lookup("NATS_USER"), lookup("NATS_PASSWORD")) {
            (Some(user), Some(password)) => Some((user, password)),
            (None, None) => None,
            _ => {
                problems.push("NATS_USER and NATS_PASSWORD go together".to_owned());
                None
            }
        };
        Self {
            valkey_url: lookup("VALKEY_URL"),
            valkey_cache_prefix: lookup("VALKEY_CACHE_PREFIX")
                .unwrap_or_else(|| "cache:".to_owned()),
            valkey_realtime_prefix: lookup("VALKEY_REALTIME_PREFIX")
                .unwrap_or_else(|| "realtime:".to_owned()),
            nats_url: lookup("NATS_URL"),
            nats_user,
            nats_token: lookup("NATS_TOKEN"),
            nats_stream: lookup("NATS_ENTITY_EVENTS_STREAM")
                .unwrap_or_else(|| weldsuite_adapters_oss::DEFAULT_ENTITY_EVENTS_STREAM.to_owned()),
            nats_subject_prefix: lookup("NATS_ENTITY_EVENTS_SUBJECT")
                .unwrap_or_else(|| weldsuite_events::DEFAULT_SUBJECT_PREFIX.to_owned()),
            nats_ensure_streams: lookup("NATS_ENSURE_STREAMS").as_deref() == Some("true"),
            flags,
            flags_refresh: Duration::from_secs(refresh_seconds),
            test_fixtures_token: lookup("TEST_FIXTURES_TOKEN"),
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("environment", &self.environment)
            .field("master_max_connections", &self.master_max_connections)
            .field("keyring", &self.keyring)
            .field("authorized_parties", &self.authorized_parties)
            .field("permissions_app_enforce", &self.permissions_app_enforce)
            .field("workspaces", &self.workspaces)
            .field("log_format", &self.log_format)
            .field("shutdown_delay", &self.shutdown_delay)
            .field("infra", &self.infra)
            .finish_non_exhaustive()
    }
}

/// Every problem found, so one failed start lists them all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfigError(pub(crate) Vec<String>);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid configuration: {}", self.0.join("; "))
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    pub(crate) fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(
            |name| std::env::var(name).ok().filter(|v| !v.is_empty()),
            |path| std::fs::read_to_string(path),
        )
    }

    /// `lookup` reads a variable, `read_file` a file; both injectable for
    /// tests.
    pub(crate) fn from_lookup(
        lookup: impl Fn(&str) -> Option<String>,
        read_file: impl Fn(&str) -> std::io::Result<String>,
    ) -> Result<Self, ConfigError> {
        let mut problems = Vec::new();
        let number = |problems: &mut Vec<String>, name: &str, default: u64| -> u64 {
            match lookup(name) {
                None => default,
                Some(raw) => raw.parse().unwrap_or_else(|_| {
                    problems.push(format!("{name} must be a whole number"));
                    default
                }),
            }
        };

        let port = number(&mut problems, "PORT", 8080);
        let master_max_connections = number(&mut problems, "DATABASE_MASTER_MAX_CONNECTIONS", 10);
        let tenant_max_connections = number(&mut problems, "TENANT_POOL_MAX_CONNECTIONS", 1);
        let max_tenant_pools = number(&mut problems, "TENANT_POOLS_MAX", 2000);
        let cache_ttl = number(&mut problems, "WORKSPACE_CACHE_TTL_SECONDS", 300);
        let shutdown_delay = number(&mut problems, "SHUTDOWN_DELAY_SECONDS", 5);
        let flags_refresh = number(&mut problems, "FEATURE_FLAGS_REFRESH_SECONDS", 30);
        let infra = InfraConfig::from_lookup(&lookup, &mut problems, flags_refresh);

        let host: IpAddr = match lookup("HOST") {
            None => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            Some(raw) => raw.parse().unwrap_or_else(|_| {
                problems.push("HOST must be an IP address".to_owned());
                IpAddr::V4(Ipv4Addr::UNSPECIFIED)
            }),
        };
        let port = u16::try_from(port).unwrap_or_else(|_| {
            problems.push("PORT must be at most 65535".to_owned());
            8080
        });

        let master_database_url = lookup("DATABASE_URL_MASTER").unwrap_or_else(|| {
            problems.push("DATABASE_URL_MASTER is required".to_owned());
            String::new()
        });

        let keyring = Keyring {
            v1: lookup("DATABASE_ENCRYPTION_KEY"),
            v2: lookup("DATABASE_ENCRYPTION_KEY_V2"),
        };

        // In order of preference: a fixed key, then keys fetched over HTTP.
        let clerk_key = if let Some(pem) = lookup("CLERK_JWT_KEY") {
            ClerkKey::Pem(pem.replace("\\n", "\n"))
        } else if let Some(path) = lookup("CLERK_JWKS_FILE") {
            read_file(&path).map_or_else(
                |error| {
                    problems.push(format!("CLERK_JWKS_FILE {path} cannot be read: {error}"));
                    ClerkKey::Jwks(String::new())
                },
                ClerkKey::Jwks,
            )
        } else if let Some(url) = lookup("CLERK_JWKS_URL") {
            ClerkKey::JwksUrl(url)
        } else if let Some(secret) = lookup("CLERK_SECRET_KEY") {
            ClerkKey::SecretKey(secret)
        } else {
            problems.push(
                "one of CLERK_JWT_KEY, CLERK_JWKS_FILE, CLERK_JWKS_URL or CLERK_SECRET_KEY is required"
                    .to_owned(),
            );
            ClerkKey::Pem(String::new())
        };

        let log_format = match lookup("LOG_FORMAT").as_deref() {
            None | Some("json") => LogFormat::Json,
            Some("text") => LogFormat::Text,
            Some(_) => {
                problems.push("LOG_FORMAT must be json or text".to_owned());
                LogFormat::Json
            }
        };

        if !problems.is_empty() {
            return Err(ConfigError(problems));
        }

        Ok(Self {
            listen: SocketAddr::new(host, port),
            environment: lookup("ENVIRONMENT").unwrap_or_else(|| "development".to_owned()),
            master_database_url,
            master_max_connections: saturate(master_max_connections),
            keyring,
            clerk_key,
            authorized_parties: lookup("CLERK_AUTHORIZED_PARTIES"),
            permissions_app_enforce: lookup("PERMISSIONS_APP_ENFORCE").as_deref() == Some("true"),
            workspaces: WorkspaceConfig {
                cache_ttl: Duration::from_secs(cache_ttl),
                tenant_max_connections: saturate(tenant_max_connections),
                max_tenant_pools: usize::try_from(max_tenant_pools).unwrap_or(usize::MAX),
                ..WorkspaceConfig::default()
            },
            log_format,
            shutdown_delay: Duration::from_secs(shutdown_delay),
            infra,
            sign_session_secret: lookup("SIGN_SESSION_SECRET").filter(|s| !s.is_empty()),
        })
    }
}

fn saturate(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        Config::from_lookup(
            |name| vars.get(name).cloned(),
            |path| {
                (path == "/etc/clerk/jwks.json")
                    .then(|| r#"{"keys":[]}"#.to_owned())
                    .ok_or_else(|| std::io::Error::other("missing"))
            },
        )
    }

    #[test]
    fn defaults_and_required_values() {
        let config = config(&[
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("CLERK_JWT_KEY", "-----BEGIN PUBLIC KEY-----\\nabc"),
        ])
        .expect("valid");
        assert_eq!(config.listen.to_string(), "0.0.0.0:8080");
        assert_eq!(config.log_format, LogFormat::Json);
        assert!(!config.permissions_app_enforce);
        assert!(matches!(&config.clerk_key, ClerkKey::Pem(pem) if pem.contains('\n')));
        assert!(!format!("{config:?}").contains("postgres://master"));
    }

    #[test]
    fn lists_every_problem() {
        let error = config(&[("PORT", "eighty"), ("LOG_FORMAT", "xml")]).expect_err("invalid");
        assert_eq!(error.0.len(), 4, "{error}");
    }

    #[test]
    fn reads_a_jwks_file() {
        let config = config(&[
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("CLERK_JWKS_FILE", "/etc/clerk/jwks.json"),
        ])
        .expect("valid");
        assert!(matches!(config.clerk_key, ClerkKey::Jwks(_)));
    }
}
