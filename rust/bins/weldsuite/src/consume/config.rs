//! Configuration of `weldsuite consume`, from environment variables only. It
//! shares the database, NATS and Valkey variables with `serve` and needs no
//! sign-in settings.
//!
//! | Variable | |
//! |---|---|
//! | `DATABASE_URL_MASTER` (required), `DATABASE_ENCRYPTION_KEY`, `DATABASE_ENCRYPTION_KEY_V2` | as for `serve` |
//! | `DATABASE_MASTER_MAX_CONNECTIONS`, `TENANT_POOL_MAX_CONNECTIONS`, `TENANT_POOLS_MAX`, `WORKSPACE_CACHE_TTL_SECONDS` | pools, as for `serve` |
//! | `NATS_URL` (required), `NATS_USER`/`NATS_PASSWORD` or `NATS_TOKEN`, `NATS_ENTITY_EVENTS_STREAM`, `NATS_ENTITY_EVENTS_SUBJECT` | the hub |
//! | `NATS_ENSURE_STREAMS`, `NATS_STREAM_REPLICAS` | create or update the hub and the dead-letter stream at start, with this many replicas |
//! | `NATS_DEAD_LETTER_STREAM` | the dead-letter stream (default `ENTITY_EVENTS_DLQ`, subjects `<subject>-dlq.<subscriber>.…`) |
//! | `CONSUME_SUBSCRIBERS` | the subscribers to run, comma separated (default: every ported one) |
//! | `VALKEY_URL`, `VALKEY_REALTIME_PREFIX` | realtime publishes; without them the realtime subscriber does not run |
//! | `EMBEDDINGS_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_API_KEY` | an OpenAI-compatible embeddings endpoint; without one the search-index subscriber does not run |
//! | `WEBHOOK_ALLOW_PRIVATE_NETWORKS` | `true` lets webhooks reach private addresses (refused by default) |
//! | `WEBHOOK_RETRY_SWEEP` | `false` stops this role from retrying failed webhook deliveries every ten minutes |
//! | `CONSUME_DRAIN_SECONDS` | how long batches in hand may take to finish after SIGTERM (default 25) |
//! | `PORT`, `HOST`, `ENVIRONMENT`, `LOG_FORMAT`, `RUST_LOG` | probes (`/livez`, `/readyz`, `/health`) and logs |

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use weldsuite_db::{Keyring, WorkspaceConfig};

use crate::config::LogFormat;

/// The subscribers `weldsuite consume` can run.
pub(crate) const PORTED: [&str; 4] = ["audit", "search-index", "webhooks", "realtime"];

#[derive(Clone)]
pub(crate) struct EmbeddingsConfig {
    pub(crate) url: String,
    pub(crate) model: String,
    pub(crate) api_key: Option<String>,
}

#[derive(Clone)]
pub(crate) struct ConsumeConfig {
    pub(crate) listen: SocketAddr,
    pub(crate) environment: String,
    pub(crate) log_format: LogFormat,
    pub(crate) master_database_url: String,
    pub(crate) master_max_connections: u32,
    pub(crate) keyring: Keyring,
    pub(crate) workspaces: WorkspaceConfig,
    pub(crate) nats_url: String,
    pub(crate) nats_user: Option<(String, String)>,
    pub(crate) nats_token: Option<String>,
    pub(crate) stream: String,
    pub(crate) subject_prefix: String,
    pub(crate) dead_letter_stream: String,
    pub(crate) ensure_streams: bool,
    pub(crate) stream_replicas: usize,
    pub(crate) subscribers: Vec<String>,
    pub(crate) valkey_url: Option<String>,
    pub(crate) valkey_realtime_prefix: String,
    pub(crate) embeddings: Option<EmbeddingsConfig>,
    pub(crate) webhook_allow_private: bool,
    pub(crate) webhook_retry_sweep: bool,
    pub(crate) drain: Duration,
}

impl fmt::Debug for ConsumeConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConsumeConfig")
            .field("listen", &self.listen)
            .field("environment", &self.environment)
            .field("stream", &self.stream)
            .field("subject_prefix", &self.subject_prefix)
            .field("dead_letter_stream", &self.dead_letter_stream)
            .field("ensure_streams", &self.ensure_streams)
            .field("stream_replicas", &self.stream_replicas)
            .field("subscribers", &self.subscribers)
            .field("valkey", &self.valkey_url.as_ref().map(|_| "<set>"))
            .field(
                "embeddings",
                &self.embeddings.as_ref().map(|e| e.model.as_str()),
            )
            .field("webhook_allow_private", &self.webhook_allow_private)
            .field("webhook_retry_sweep", &self.webhook_retry_sweep)
            .field("drain", &self.drain)
            .finish_non_exhaustive()
    }
}

/// Every problem found, so one failed start lists them all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConsumeConfigError(pub(crate) Vec<String>);

impl fmt::Display for ConsumeConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid configuration: {}", self.0.join("; "))
    }
}

impl std::error::Error for ConsumeConfigError {}

fn flag(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &str,
    default: bool,
    problems: &mut Vec<String>,
) -> bool {
    match lookup(name).as_deref() {
        None => default,
        Some("true") => true,
        Some("false") => false,
        Some(_) => {
            problems.push(format!("{name} must be true or false"));
            default
        }
    }
}

impl ConsumeConfig {
    pub(crate) fn from_env() -> Result<Self, ConsumeConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
    }

    /// `lookup` reads a variable; injectable for tests.
    #[allow(
        clippy::too_many_lines,
        reason = "one variable after the other, as Config::from_lookup"
    )]
    pub(crate) fn from_lookup(
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, ConsumeConfigError> {
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
        let port = u16::try_from(port).unwrap_or_else(|_| {
            problems.push("PORT must be at most 65535".to_owned());
            8080
        });
        let host: IpAddr = match lookup("HOST") {
            None => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            Some(raw) => raw.parse().unwrap_or_else(|_| {
                problems.push("HOST must be an IP address".to_owned());
                IpAddr::V4(Ipv4Addr::UNSPECIFIED)
            }),
        };
        let master_max_connections = number(&mut problems, "DATABASE_MASTER_MAX_CONNECTIONS", 10);
        let tenant_max_connections = number(&mut problems, "TENANT_POOL_MAX_CONNECTIONS", 1);
        let max_tenant_pools = number(&mut problems, "TENANT_POOLS_MAX", 2000);
        let cache_ttl = number(&mut problems, "WORKSPACE_CACHE_TTL_SECONDS", 300);
        let replicas = number(&mut problems, "NATS_STREAM_REPLICAS", 1);
        let drain = number(&mut problems, "CONSUME_DRAIN_SECONDS", 25);

        let master_database_url = lookup("DATABASE_URL_MASTER").unwrap_or_else(|| {
            problems.push("DATABASE_URL_MASTER is required".to_owned());
            String::new()
        });
        let nats_url = lookup("NATS_URL").unwrap_or_else(|| {
            problems.push("NATS_URL is required: consume reads the entity-event hub".to_owned());
            String::new()
        });
        let nats_user = match (lookup("NATS_USER"), lookup("NATS_PASSWORD")) {
            (Some(user), Some(password)) => Some((user, password)),
            (None, None) => None,
            _ => {
                problems.push("NATS_USER and NATS_PASSWORD go together".to_owned());
                None
            }
        };
        let log_format = match lookup("LOG_FORMAT").as_deref() {
            None | Some("json") => LogFormat::Json,
            Some("text") => LogFormat::Text,
            Some(_) => {
                problems.push("LOG_FORMAT must be json or text".to_owned());
                LogFormat::Json
            }
        };
        let subject_prefix = lookup("NATS_ENTITY_EVENTS_SUBJECT")
            .unwrap_or_else(|| weldsuite_events::DEFAULT_SUBJECT_PREFIX.to_owned());
        let subscribers: Vec<String> = match lookup("CONSUME_SUBSCRIBERS") {
            None => PORTED.iter().map(|id| (*id).to_owned()).collect(),
            Some(list) => list
                .split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .collect(),
        };
        for id in &subscribers {
            if !PORTED.contains(&id.as_str()) {
                problems.push(format!(
                    "CONSUME_SUBSCRIBERS: {id} is not a ported subscriber ({})",
                    PORTED.join(", ")
                ));
            }
        }
        let embeddings = match (lookup("EMBEDDINGS_URL"), lookup("EMBEDDINGS_MODEL")) {
            (Some(url), Some(model)) => Some(EmbeddingsConfig {
                url,
                model,
                api_key: lookup("EMBEDDINGS_API_KEY"),
            }),
            (None, None) => None,
            _ => {
                problems.push("EMBEDDINGS_URL and EMBEDDINGS_MODEL go together".to_owned());
                None
            }
        };
        let ensure_streams = flag(&lookup, "NATS_ENSURE_STREAMS", false, &mut problems);
        let webhook_allow_private = flag(
            &lookup,
            "WEBHOOK_ALLOW_PRIVATE_NETWORKS",
            false,
            &mut problems,
        );
        let webhook_retry_sweep = flag(&lookup, "WEBHOOK_RETRY_SWEEP", true, &mut problems);

        if !problems.is_empty() {
            return Err(ConsumeConfigError(problems));
        }
        Ok(Self {
            listen: SocketAddr::new(host, port),
            environment: lookup("ENVIRONMENT").unwrap_or_else(|| "development".to_owned()),
            log_format,
            master_database_url,
            master_max_connections: u32::try_from(master_max_connections).unwrap_or(u32::MAX),
            keyring: Keyring {
                v1: lookup("DATABASE_ENCRYPTION_KEY"),
                v2: lookup("DATABASE_ENCRYPTION_KEY_V2"),
            },
            workspaces: WorkspaceConfig {
                cache_ttl: Duration::from_secs(cache_ttl),
                tenant_max_connections: u32::try_from(tenant_max_connections).unwrap_or(u32::MAX),
                max_tenant_pools: usize::try_from(max_tenant_pools).unwrap_or(usize::MAX),
                ..WorkspaceConfig::default()
            },
            nats_url,
            nats_user,
            nats_token: lookup("NATS_TOKEN"),
            stream: lookup("NATS_ENTITY_EVENTS_STREAM")
                .unwrap_or_else(|| weldsuite_adapters_oss::DEFAULT_ENTITY_EVENTS_STREAM.to_owned()),
            dead_letter_stream: lookup("NATS_DEAD_LETTER_STREAM")
                .unwrap_or_else(|| "ENTITY_EVENTS_DLQ".to_owned()),
            subject_prefix,
            ensure_streams,
            stream_replicas: usize::try_from(replicas).unwrap_or(1).max(1),
            subscribers,
            valkey_url: lookup("VALKEY_URL"),
            valkey_realtime_prefix: lookup("VALKEY_REALTIME_PREFIX")
                .unwrap_or_else(|| "realtime:".to_owned()),
            embeddings,
            webhook_allow_private,
            webhook_retry_sweep,
            drain: Duration::from_secs(drain),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(vars: &[(&str, &str)]) -> Result<ConsumeConfig, ConsumeConfigError> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        ConsumeConfig::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn defaults_run_every_ported_subscriber() {
        let config = config(&[
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("NATS_URL", "nats://nats:4222"),
        ])
        .expect("valid");
        assert_eq!(config.subscribers, PORTED);
        assert_eq!(config.stream, "ENTITY_EVENTS");
        assert_eq!(config.subject_prefix, "entity-events");
        assert_eq!(config.dead_letter_stream, "ENTITY_EVENTS_DLQ");
        assert!(!config.webhook_allow_private);
        assert!(config.webhook_retry_sweep);
        assert!(config.embeddings.is_none());
        assert!(!format!("{config:?}").contains("postgres://master"));
    }

    #[test]
    fn lists_every_problem() {
        let error = config(&[
            ("CONSUME_SUBSCRIBERS", "audit,analytics"),
            ("EMBEDDINGS_URL", "http://tei"),
            ("WEBHOOK_ALLOW_PRIVATE_NETWORKS", "yes"),
        ])
        .expect_err("invalid");
        assert_eq!(error.0.len(), 5, "{error}");
    }
}
