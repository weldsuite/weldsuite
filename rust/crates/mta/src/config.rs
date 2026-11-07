//! Settings from the environment (the contract's table in
//! `docs/plans/eu-mail-service.md`). Parsing takes a lookup function so it
//! is testable without touching the process environment.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use crate::crypto::Keys;

/// Settings every `weldsuite mta` command needs.
#[derive(Debug, Clone)]
pub struct BaseConfig {
    pub database_url: String,
    pub keys: Keys,
}

/// Settings of `weldsuite mta run`.
#[derive(Debug, Clone)]
pub struct Config {
    pub base: BaseConfig,
    pub api_secret: String,
    /// pool → submission password.
    pub pool_passwords: BTreeMap<String, String>,
    /// The pools this node delivers for.
    pub pools: Vec<String>,
    pub submission_addr: SocketAddr,
    pub submission_tls: Option<(String, String)>,
    pub api_addr: SocketAddr,
    pub inbound_addr: Option<SocketAddr>,
    pub inbound_tls: Option<(String, String)>,
    pub bounce_domain: Option<String>,
    pub hostname: Option<String>,
    pub source_ip: Option<Ipv4Addr>,
    pub resolver: Option<SocketAddr>,
    pub max_message_bytes: usize,
    pub max_queue_age: Duration,
    pub concurrency: usize,
    /// Per-IP daily caps by warm-up day; empty = no warm-up.
    pub warmup_schedule: Vec<u32>,
    pub suppress_days: u32,
    pub tlsrpt_from: Option<String>,
    pub nats: Option<NatsSettings>,
    pub events_subject: String,
    /// Outbound SMTP port (25; tests point it elsewhere).
    pub delivery_port: u16,
    /// Deliver to MX addresses in private space (tests and labs only).
    pub allow_private_destinations: bool,
}

#[derive(Debug, Clone)]
pub struct NatsSettings {
    pub url: String,
    pub user: Option<(String, String)>,
    pub token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

pub const DEFAULT_WARMUP: &str = "50,100,200,400,800,1500,3000,6000,12000,25000,50000";

fn non_empty(lookup: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    lookup(name)
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn required(lookup: &dyn Fn(&str) -> Option<String>, name: &str) -> Result<String, ConfigError> {
    non_empty(lookup, name).ok_or_else(|| ConfigError(format!("{name} is required")))
}

fn parse<T: std::str::FromStr>(
    lookup: &dyn Fn(&str) -> Option<String>,
    name: &str,
    default: T,
) -> Result<T, ConfigError> {
    match non_empty(lookup, name) {
        None => Ok(default),
        Some(value) => value
            .parse()
            .map_err(|_| ConfigError(format!("{name} is not valid: {value}"))),
    }
}

fn tls_pair(
    lookup: &dyn Fn(&str) -> Option<String>,
    prefix: &str,
) -> Result<Option<(String, String)>, ConfigError> {
    let cert = non_empty(lookup, &format!("{prefix}_CERT"));
    let key = non_empty(lookup, &format!("{prefix}_KEY"));
    match (cert, key) {
        (Some(cert), Some(key)) => Ok(Some((cert, key))),
        (None, None) => Ok(None),
        _ => Err(ConfigError(format!(
            "{prefix}_CERT and {prefix}_KEY go together"
        ))),
    }
}

/// `5d`, `36h`, `90m`, `600s` or plain seconds.
pub fn parse_duration(value: &str) -> Option<Duration> {
    let value = value.trim();
    let (number, unit) = value
        .find(|c: char| !c.is_ascii_digit())
        .map_or((value, "s"), |at| value.split_at(at));
    let number: u64 = number.parse().ok()?;
    let seconds = match unit {
        "s" => number,
        "m" => number * 60,
        "h" => number * 3600,
        "d" => number * 86_400,
        _ => return None,
    };
    (seconds > 0).then(|| Duration::from_secs(seconds))
}

pub fn parse_warmup(value: &str) -> Result<Vec<u32>, ConfigError> {
    if value.trim().eq_ignore_ascii_case("off") {
        return Ok(Vec::new());
    }
    value
        .split(',')
        .map(|step| {
            step.trim()
                .parse::<u32>()
                .ok()
                .filter(|&n| n > 0)
                .ok_or_else(|| ConfigError(format!("MTA_WARMUP_SCHEDULE has a bad step: {step}")))
        })
        .collect()
}

/// Every `MTA_SUBMISSION_PASSWORD_<POOL>` that is set, keyed by the
/// lowercased pool name; at least one is required.
fn pool_passwords<'a>(
    lookup: &dyn Fn(&str) -> Option<String>,
    names: impl Iterator<Item = &'a str>,
) -> Result<BTreeMap<String, String>, ConfigError> {
    let mut pool_passwords = BTreeMap::new();
    for name in names {
        if let Some(pool) = name.strip_prefix("MTA_SUBMISSION_PASSWORD_")
            && let Some(password) = non_empty(lookup, name)
        {
            let pool = pool.to_ascii_lowercase();
            if !pool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || pool.is_empty() {
                return Err(ConfigError(format!("{name}: bad pool name")));
            }
            pool_passwords.insert(pool, password);
        }
    }
    if pool_passwords.is_empty() {
        return Err(ConfigError(
            "at least one MTA_SUBMISSION_PASSWORD_<POOL> is required".into(),
        ));
    }
    Ok(pool_passwords)
}

/// `MTA_POOLS`: each pool named there must have a submission password.
fn pools(
    lookup: &dyn Fn(&str) -> Option<String>,
    pool_passwords: &BTreeMap<String, String>,
) -> Result<Vec<String>, ConfigError> {
    let pools: Vec<String> = required(lookup, "MTA_POOLS")?
        .split(',')
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    for pool in &pools {
        if !pool_passwords.contains_key(pool) {
            return Err(ConfigError(format!(
                "MTA_POOLS names {pool}, which has no MTA_SUBMISSION_PASSWORD_{}",
                pool.to_ascii_uppercase()
            )));
        }
    }
    Ok(pools)
}

/// `MTA_MAX_QUEUE_AGE`, five days when unset.
fn max_queue_age(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Duration, ConfigError> {
    match non_empty(lookup, "MTA_MAX_QUEUE_AGE") {
        None => Ok(Duration::from_hours(5 * 24)),
        Some(value) => parse_duration(&value)
            .ok_or_else(|| ConfigError(format!("MTA_MAX_QUEUE_AGE is not valid: {value}"))),
    }
}

impl BaseConfig {
    pub fn from_lookup(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let database_url = required(lookup, "MTA_DATABASE_URL")?;
        let keys = Keys::from_base64(&required(lookup, "MTA_KEY")?)
            .map_err(|error| ConfigError(error.to_string()))?;
        Ok(Self { database_url, keys })
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let vars: BTreeMap<String, String> = std::env::vars().collect();
        Self::from_lookup(
            &|name| vars.get(name).cloned(),
            vars.keys().map(String::as_str),
        )
    }

    /// `names` lists every variable, for the `MTA_SUBMISSION_PASSWORD_*`
    /// scan.
    pub fn from_lookup<'a>(
        lookup: &dyn Fn(&str) -> Option<String>,
        names: impl Iterator<Item = &'a str>,
    ) -> Result<Self, ConfigError> {
        let base = BaseConfig::from_lookup(lookup)?;
        let api_secret = required(lookup, "MTA_API_SECRET")?;
        let pool_passwords = pool_passwords(lookup, names)?;
        let pools = pools(lookup, &pool_passwords)?;
        let bounce_domain = non_empty(lookup, "MTA_BOUNCE_DOMAIN").map(|d| d.to_ascii_lowercase());
        let tlsrpt_from = match lookup("MTA_TLSRPT_FROM") {
            Some(value) => Some(value.trim().to_owned()).filter(|v| !v.is_empty()),
            None => bounce_domain
                .as_ref()
                .map(|d| format!("tlsrpt-noreply@{d}")),
        };
        let max_queue_age = max_queue_age(lookup)?;
        let nats = non_empty(lookup, "NATS_URL").map(|url| NatsSettings {
            url,
            user: non_empty(lookup, "NATS_USER").zip(non_empty(lookup, "NATS_PASSWORD")),
            token: non_empty(lookup, "NATS_TOKEN"),
        });
        let inbound_addr = non_empty(lookup, "MTA_INBOUND_ADDR")
            .map(|value| {
                value
                    .parse()
                    .map_err(|_| ConfigError(format!("MTA_INBOUND_ADDR is not valid: {value}")))
            })
            .transpose()?;
        if inbound_addr.is_some() && bounce_domain.is_none() {
            return Err(ConfigError(
                "MTA_INBOUND_ADDR needs MTA_BOUNCE_DOMAIN".into(),
            ));
        }
        Ok(Self {
            base,
            api_secret,
            pool_passwords,
            pools,
            submission_addr: parse(
                lookup,
                "MTA_SUBMISSION_ADDR",
                SocketAddr::from(([0, 0, 0, 0], 2587)),
            )?,
            submission_tls: tls_pair(lookup, "MTA_SUBMISSION_TLS")?,
            api_addr: parse(
                lookup,
                "MTA_API_ADDR",
                SocketAddr::from(([0, 0, 0, 0], 8025)),
            )?,
            inbound_addr,
            inbound_tls: tls_pair(lookup, "MTA_INBOUND_TLS")?,
            bounce_domain,
            hostname: non_empty(lookup, "MTA_HOSTNAME").map(|h| h.to_ascii_lowercase()),
            source_ip: non_empty(lookup, "MTA_SOURCE_IP")
                .map(|v| {
                    v.parse().map_err(|_| {
                        ConfigError(format!("MTA_SOURCE_IP is not an IPv4 address: {v}"))
                    })
                })
                .transpose()?,
            resolver: non_empty(lookup, "MTA_RESOLVER")
                .map(|v| {
                    v.parse()
                        .map_err(|_| ConfigError(format!("MTA_RESOLVER is not ip:port: {v}")))
                })
                .transpose()?,
            max_message_bytes: parse(lookup, "MTA_MAX_MESSAGE_BYTES", 26_214_400)?,
            max_queue_age,
            concurrency: parse(lookup, "MTA_CONCURRENCY", 32usize)?.max(1),
            warmup_schedule: parse_warmup(
                &non_empty(lookup, "MTA_WARMUP_SCHEDULE")
                    .unwrap_or_else(|| DEFAULT_WARMUP.to_owned()),
            )?,
            suppress_days: parse(lookup, "MTA_SUPPRESS_DAYS", 30u32)?,
            tlsrpt_from,
            nats,
            events_subject: non_empty(lookup, "MTA_EVENTS_SUBJECT")
                .unwrap_or_else(|| "mail.sending-events".into()),
            delivery_port: parse(lookup, "MTA_DELIVERY_PORT", 25u16)?,
            allow_private_destinations: parse(lookup, "MTA_ALLOW_PRIVATE_DESTINATIONS", false)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let map: BTreeMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        Config::from_lookup(
            &|name| map.get(name).cloned(),
            map.keys().map(String::as_str),
        )
    }

    const KEY: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

    fn minimal() -> Vec<(&'static str, &'static str)> {
        vec![
            ("MTA_DATABASE_URL", "postgres://mta@db/weldsuite_mta"),
            ("MTA_KEY", KEY),
            ("MTA_API_SECRET", "s"),
            ("MTA_SUBMISSION_PASSWORD_SYSTEM", "a"),
            ("MTA_SUBMISSION_PASSWORD_CUSTOMER", "b"),
            ("MTA_POOLS", "customer"),
        ]
    }

    #[test]
    fn reads_a_minimal_config_with_defaults() {
        let config = env(&minimal()).expect("config");
        assert_eq!(config.pools, vec!["customer"]);
        assert_eq!(config.pool_passwords.len(), 2);
        assert_eq!(config.submission_addr.port(), 2587);
        assert_eq!(config.max_queue_age, Duration::from_hours(5 * 24));
        assert_eq!(config.warmup_schedule.first(), Some(&50));
        assert_eq!(config.events_subject, "mail.sending-events");
        assert!(config.tlsrpt_from.is_none());
        assert_eq!(config.delivery_port, 25);
        assert!(!config.allow_private_destinations);
    }

    #[test]
    fn checks_pools_and_the_bounce_domain() {
        let mut vars = minimal();
        vars.retain(|(k, _)| *k != "MTA_POOLS");
        vars.push(("MTA_POOLS", "bulk"));
        assert!(env(&vars).is_err());

        let mut vars = minimal();
        vars.push(("MTA_INBOUND_ADDR", "0.0.0.0:25"));
        assert!(env(&vars).is_err());
        vars.push(("MTA_BOUNCE_DOMAIN", "Bounces.EU.test"));
        let config = env(&vars).expect("config");
        assert_eq!(
            config.tlsrpt_from.as_deref(),
            Some("tlsrpt-noreply@bounces.eu.test")
        );
    }

    #[test]
    fn parses_durations_and_warmup() {
        assert_eq!(parse_duration("36h"), Some(Duration::from_hours(36)));
        assert_eq!(parse_duration("90m"), Some(Duration::from_mins(90)));
        assert_eq!(parse_duration("600"), Some(Duration::from_secs(600)));
        assert_eq!(parse_duration("3w"), None);
        assert_eq!(parse_warmup("off"), Ok(vec![]));
        assert_eq!(parse_warmup("10, 20"), Ok(vec![10, 20]));
        assert!(parse_warmup("10,0").is_err());
    }
}
