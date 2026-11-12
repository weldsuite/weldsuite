//! Configuration, from environment variables only, so the same image runs in
//! every cluster. Secrets come from Kubernetes Secrets mounted as variables;
//! nothing here is ever logged except through [`Config`]'s `Debug`, which
//! hides them.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
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

/// Who signs people in (`AUTH_PROVIDER`, ADR SEC-012).
#[derive(Clone)]
pub(crate) enum AuthConfig {
    /// `clerk`, the default: Clerk session tokens, as the workers verify them.
    Clerk {
        key: ClerkKey,
        /// `CLERK_AUTHORIZED_PARTIES`: extra origins allowed as `azp`.
        authorized_parties: Option<String>,
    },
    /// `oidc`: an OIDC provider's tokens (Zitadel, or the customer's own).
    Oidc {
        settings: weldsuite_auth::OidcSettings,
        /// `OIDC_WEB_CLIENT_ID`: the platform's public PKCE client, told to
        /// the frontends by `/config.json`.
        web_client_id: Option<String>,
        /// `OIDC_MOBILE_CLIENT_ID`: the mobile apps' public native client
        /// (PKCE, `<app scheme>://sso-callback` redirects), told to the
        /// apps by `/config.json`. Without it the apps can't sign in here.
        mobile_client_id: Option<String>,
        /// `OIDC_SIGN_IN=platform`: the platform shows its own sign-in
        /// screens and this server is the provider's login client behind
        /// them (`/api/sign-in`, ADR SEC-016). Unset or `provider`: the
        /// provider's own pages.
        platform_sign_in: bool,
    },
}

impl fmt::Debug for AuthConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Clerk {
                authorized_parties, ..
            } => f
                .debug_struct("Clerk")
                .field("authorized_parties", authorized_parties)
                .finish_non_exhaustive(),
            Self::Oidc {
                settings,
                web_client_id,
                mobile_client_id,
                platform_sign_in,
            } => f
                .debug_struct("Oidc")
                .field("settings", settings)
                .field("web_client_id", web_client_id)
                .field("mobile_client_id", mobile_client_id)
                .field("platform_sign_in", platform_sign_in)
                .finish(),
        }
    }
}

impl AuthConfig {
    fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        read_file: &impl Fn(&str) -> std::io::Result<String>,
        problems: &mut Vec<String>,
    ) -> Self {
        match lookup("AUTH_PROVIDER").as_deref() {
            None | Some("clerk") => Self::Clerk {
                key: clerk_key(lookup, read_file, problems),
                authorized_parties: lookup("CLERK_AUTHORIZED_PARTIES"),
            },
            Some("oidc") => {
                let issuer = lookup("OIDC_ISSUER").unwrap_or_else(|| {
                    problems.push("OIDC_ISSUER is required with AUTH_PROVIDER=oidc".to_owned());
                    String::new()
                });
                let audiences: Vec<String> = lookup("OIDC_AUDIENCE")
                    .unwrap_or_default()
                    .split(',')
                    .map(str::trim)
                    .filter(|aud| !aud.is_empty())
                    .map(str::to_owned)
                    .collect();
                if audiences.is_empty() {
                    problems.push("OIDC_AUDIENCE is required with AUTH_PROVIDER=oidc".to_owned());
                }
                let mut settings = weldsuite_auth::OidcSettings::new(issuer, audiences);
                if let Some(claim) = lookup("OIDC_ORG_CLAIM") {
                    settings.org_claim = claim;
                }
                settings.jwks_url = lookup("OIDC_JWKS_URL");
                let platform_sign_in = match lookup("OIDC_SIGN_IN").as_deref() {
                    None | Some("" | "provider") => false,
                    Some("platform") => true,
                    Some(_) => {
                        problems.push("OIDC_SIGN_IN must be provider or platform".to_owned());
                        false
                    }
                };
                Self::Oidc {
                    settings,
                    web_client_id: lookup("OIDC_WEB_CLIENT_ID"),
                    mobile_client_id: lookup("OIDC_MOBILE_CLIENT_ID"),
                    platform_sign_in,
                }
            }
            Some(_) => {
                problems.push("AUTH_PROVIDER must be clerk or oidc".to_owned());
                Self::Clerk {
                    key: ClerkKey::Pem(String::new()),
                    authorized_parties: None,
                }
            }
        }
    }
}

impl AuthConfig {
    /// The platform's own sign-in screens are served by the provider's
    /// login API: without it there is nothing behind them.
    fn check_sign_in_screens(&self, infra: &InfraConfig, problems: &mut Vec<String>) {
        if matches!(
            self,
            Self::Oidc {
                platform_sign_in: true,
                ..
            }
        ) && infra.identity.is_none()
        {
            problems.push(
                "OIDC_SIGN_IN=platform needs ZITADEL_API_URL, ZITADEL_SERVICE_TOKEN and ZITADEL_PROJECT_ID"
                    .to_owned(),
            );
        }
    }
}

/// In order of preference: a fixed key, then keys fetched over HTTP.
fn clerk_key(
    lookup: &impl Fn(&str) -> Option<String>,
    read_file: &impl Fn(&str) -> std::io::Result<String>,
    problems: &mut Vec<String>,
) -> ClerkKey {
    if let Some(pem) = lookup("CLERK_JWT_KEY") {
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
    }
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
    /// `METRICS_ADDR`: where `GET /metrics` listens, apart from the API
    /// (`monitoring.rs`); `None` is off.
    pub(crate) metrics_addr: Option<SocketAddr>,
    /// `ENVIRONMENT`, reported by `/health`.
    pub(crate) environment: String,
    /// `EDITION` and `PUBLIC_ENV`, for `/config.json` (`edition.rs`).
    pub(crate) edition: crate::edition::EditionConfig,
    pub(crate) master_database_url: String,
    pub(crate) master_max_connections: u32,
    pub(crate) keyring: Keyring,
    pub(crate) auth: AuthConfig,
    /// `PERMISSIONS_APP_ENFORCE=true`: refuse per-app denials instead of
    /// logging them.
    pub(crate) permissions_app_enforce: bool,
    pub(crate) workspaces: WorkspaceConfig,
    pub(crate) log_format: LogFormat,
    /// How long `/readyz` fails before the server stops accepting
    /// connections, so the Service stops routing to the pod first.
    pub(crate) shutdown_delay: Duration,
    /// `SPA_DIR`: the platform's built SPA, served for every path the API
    /// doesn't answer (`spa.rs`). Unset: the API only.
    pub(crate) spa_dir: Option<PathBuf>,
    pub(crate) infra: InfraConfig,
    /// `SIGN_SESSION_SECRET`: keys WeldSign's signer sessions and the stored
    /// hash of access codes; the same value as the TypeScript workers'.
    pub(crate) sign_session_secret: Option<String>,
    /// `SIGN_PORTAL_URL`: the signer portal's origin; signing links are
    /// `<portal>/r/<token>` (default `https://sign.weldsuite.org`).
    pub(crate) sign_portal_url: Option<String>,
    /// `PUBLIC_APP_URL`: the platform links in WeldSign's mail go to; unset,
    /// Global's for the `ENVIRONMENT`.
    pub(crate) public_app_url: Option<String>,
    /// Settings still on a default that names Global (`global_defaults`),
    /// one sentence each: logged at start, and for `weldsuite doctor`.
    pub(crate) global_defaults: Vec<String>,
    /// `PROJECT_PORTAL_URL`: the WeldFlow client portal's origin, for the links in the
    /// portal invitation and in status reports emailed to client contacts.
    pub(crate) project_portal_url: Option<String>,
    /// `SIGN_PORTAL_SECRET`: the key the signer portal sends with every call
    /// to `/public/sign-portal` (ADR FE-017); without it those calls are refused.
    pub(crate) sign_portal_secret: Option<String>,
    /// `COLLAB_ROOMS_URLS`: the collab-rooms pods (WeldDocs and WeldSheets'
    /// rooms, `rust/docs/collab-rooms.md`), comma separated; empty: no live
    /// editing (the room routes answer 503).
    pub(crate) collab_rooms_urls: Vec<String>,
    /// `COLLAB_ROOMS_SECRET`: the `x-internal-secret` between this server
    /// and the collab-rooms pods, both ways.
    pub(crate) collab_rooms_secret: Option<String>,
    /// `MAIL_INBOUND_SECRET`: the key Haraka sends with the `RCPT TO` check
    /// (`/internal/mail-inbound/recipients`, MAIL-010); without it the check
    /// is refused (503) and Haraka defers every recipient.
    pub(crate) mail_inbound_secret: Option<String>,
    /// `S3_PUBLIC_URL`: the public bucket's own URL (the workers'
    /// `R2_PUBLIC_URL`), for Drive rows that store only a key.
    pub(crate) files_public_url: Option<String>,
    /// `S3_PUBLIC_VIA_SERVER=true`: this server serves the public bucket's
    /// objects at `/api/storage/public/<key>` (for an object store with no
    /// public endpoint of its own; the chart then points `S3_PUBLIC_URL` there).
    pub(crate) files_public_via_server: bool,
    /// `STORAGE_SIGNING_KEY`: signs the files cookie and signed URLs that
    /// open private objects; the same value as app-api's.
    pub(crate) storage_signing_key: Option<String>,
    /// `PLATFORM_URL`: the platform's origin, for the links in the emails
    /// the sign-in screens have the identity provider send (verify an
    /// address, reset a password). Unset: the provider's own pages.
    pub(crate) platform_url: Option<String>,
    /// `REALTIME_*`: the WebSocket gateway (`realtime.rs`).
    pub(crate) realtime: weldsuite_realtime::GatewayConfig,
    /// `TRUSTED_PROXIES`: how many proxies in front of the server append
    /// to `X-Forwarded-For` (1, the ingress controller; 2 with a CDN the
    /// ingress trusts). The client's address is that many entries from the
    /// right; anything to its left came from the client.
    pub(crate) trusted_proxies: usize,
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
    /// WeldPanel's events stream and subject prefix
    /// (`NATS_PANEL_EVENTS_STREAM`, `NATS_PANEL_EVENTS_SUBJECT`), and how long
    /// it keeps rows (`NATS_PANEL_EVENTS_MAX_AGE_DAYS`, 0 = no age limit).
    pub(crate) nats_panel_stream: String,
    pub(crate) nats_panel_subject: String,
    pub(crate) nats_panel_max_age_days: u64,
    /// `NATS_ENSURE_STREAMS=true`: create or update the stream at start.
    pub(crate) nats_ensure_streams: bool,
    pub(crate) flags: FlagSourceKind,
    pub(crate) flags_refresh: Duration,
    /// `TEST_FIXTURES_TOKEN`: unlocks `X-Test-Flags` outside production.
    pub(crate) test_fixtures_token: Option<String>,
    /// `S3_ENDPOINT` and friends: object storage for the private (and the
    /// legacy public) bucket.
    pub(crate) files: Option<FilesConfig>,
    /// `SMTP_URL`: the relay system mail goes through (`smtp://…`,
    /// `smtps://…`). Unset: mail is skipped, as the workers without the
    /// `SEND_EMAIL` binding.
    pub(crate) smtp_url: Option<String>,
    /// `SYSTEM_EMAIL_FROM`: send from this address instead of
    /// `notifications@mail.weldsuite.org` (a relay that only takes its own domain).
    pub(crate) system_email_from: Option<String>,
    pub(crate) jobs: JobsConfig,
    /// `ZITADEL_API_URL` and friends: the identity provider's management
    /// API (onboarding, team routes, the identity sync). Unset: no identity
    /// provider, as the workers without a Clerk key.
    pub(crate) identity: Option<IdentityConfig>,
    /// `TENANT_SHARDS`: the CloudNativePG shards new workspace databases go
    /// on. Unset: no provisioning, so no new workspaces.
    pub(crate) tenant_shards: Option<Vec<weldsuite_adapters_oss::CnpgShard>>,
    /// `TENANT_REGION`: the shards' region (default `default`).
    pub(crate) tenant_region: Option<String>,
    /// `FIELD_ENCRYPTION_AAD_WRITES=true`: seal new database URLs as v3.
    pub(crate) aad_writes: bool,
}

/// The Zitadel management API (`crates/adapters-oss/src/zitadel.rs`).
#[derive(Clone)]
pub(crate) struct IdentityConfig {
    /// `ZITADEL_API_URL`.
    pub(crate) api_url: String,
    /// `ZITADEL_SERVICE_TOKEN`: a service user's personal access token.
    pub(crate) token: String,
    /// `ZITADEL_LOGIN_TOKEN`: the token of a service user with only the
    /// `IAM_LOGIN_CLIENT` role, for the sign-in screens (`/api/sign-in`).
    /// Unset: `token`, whose user then needs that role as well.
    pub(crate) login_token: Option<String>,
    /// `ZITADEL_PROJECT_ID`.
    pub(crate) project_id: String,
    /// `ZITADEL_INVITE_URL_TEMPLATE`.
    pub(crate) invite_url_template: Option<String>,
    /// `ZITADEL_HOST`: the `Host` header when `api_url` is in-cluster.
    pub(crate) host: Option<String>,
}

impl fmt::Debug for IdentityConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdentityConfig")
            .field("api_url", &self.api_url)
            .field("project_id", &self.project_id)
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

impl IdentityConfig {
    fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
    ) -> Option<Self> {
        let set = |name: &str| lookup(name).filter(|value| !value.trim().is_empty());
        let (api_url, token, project_id) = (
            set("ZITADEL_API_URL"),
            set("ZITADEL_SERVICE_TOKEN"),
            set("ZITADEL_PROJECT_ID"),
        );
        match (api_url, token, project_id) {
            (Some(api_url), Some(token), Some(project_id)) => Some(Self {
                api_url,
                token,
                login_token: set("ZITADEL_LOGIN_TOKEN"),
                project_id,
                invite_url_template: set("ZITADEL_INVITE_URL_TEMPLATE"),
                host: set("ZITADEL_HOST"),
            }),
            (None, None, None) => None,
            _ => {
                problems.push(
                    "ZITADEL_API_URL, ZITADEL_SERVICE_TOKEN and ZITADEL_PROJECT_ID go together"
                        .to_owned(),
                );
                None
            }
        }
    }
}

/// Durable jobs: on Restate when `RESTATE_INGRESS_URL` is set, else in the
/// server process (`InProcessJobs`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct JobsConfig {
    /// `RESTATE_INGRESS_URL`: where jobs are started, `http://restate:8080`.
    pub(crate) restate_ingress_url: Option<String>,
    /// `RESTATE_ADMIN_URL`: where the endpoint is registered at start,
    /// `http://restate:9070`. Unset: registered by hand.
    pub(crate) restate_admin_url: Option<String>,
    /// `RESTATE_DEPLOYMENT_URI`: how Restate reaches the jobs endpoint, the
    /// jobs Service, `http://weldsuite-jobs:9080`.
    pub(crate) restate_deployment_uri: Option<String>,
    /// `JOBS_PORT`: the port the Restate service endpoint listens on (9080).
    pub(crate) port: u16,
}

impl JobsConfig {
    fn from_lookup(lookup: &impl Fn(&str) -> Option<String>, problems: &mut Vec<String>) -> Self {
        let port = match lookup("JOBS_PORT") {
            None => 9080,
            Some(port) => port.parse().unwrap_or_else(|_| {
                problems.push("JOBS_PORT must be a port number".to_owned());
                9080
            }),
        };
        let config = Self {
            restate_ingress_url: lookup("RESTATE_INGRESS_URL").filter(|s| !s.is_empty()),
            restate_admin_url: lookup("RESTATE_ADMIN_URL").filter(|s| !s.is_empty()),
            restate_deployment_uri: lookup("RESTATE_DEPLOYMENT_URI").filter(|s| !s.is_empty()),
            port,
        };
        if config.restate_admin_url.is_some() != config.restate_deployment_uri.is_some() {
            problems.push("RESTATE_ADMIN_URL and RESTATE_DEPLOYMENT_URI go together".to_owned());
        }
        if config.restate_admin_url.is_some() && config.restate_ingress_url.is_none() {
            problems.push("RESTATE_ADMIN_URL needs RESTATE_INGRESS_URL".to_owned());
        }
        config
    }
}

/// The S3 buckets behind the file stores (the workers' R2 `PRIVATE_STORAGE`
/// and `STORAGE`). One endpoint and key pair for both.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "conformance", allow(dead_code))]
pub(crate) struct FilesConfig {
    /// `S3_BUCKET_PRIVATE` on `S3_ENDPOINT`.
    pub(crate) private: weldsuite_adapters_oss::S3Options,
    /// `S3_BUCKET_PUBLIC`: read for objects stored before the private bucket.
    pub(crate) public_bucket: Option<String>,
    /// `S3_ENSURE_BUCKETS=true`: create the buckets at start when the store
    /// doesn't have them (the object store a self-hosted chart bundles).
    pub(crate) ensure_buckets: bool,
}

impl FilesConfig {
    /// `S3_ENDPOINT` unset is no object storage; set, the bucket and keys must
    /// be too.
    fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
    ) -> Option<Self> {
        let endpoint = lookup("S3_ENDPOINT")?;
        let mut required = |name: &str| {
            let value = lookup(name);
            if value.is_none() {
                problems.push(format!("{name} is required with S3_ENDPOINT"));
            }
            value.unwrap_or_default()
        };
        let bucket = required("S3_BUCKET_PRIVATE");
        let access_key_id = required("S3_ACCESS_KEY_ID");
        let secret_access_key = required("S3_SECRET_ACCESS_KEY");
        let path_style = match lookup("S3_FORCE_PATH_STYLE").as_deref() {
            None | Some("false") => false,
            Some("true") => true,
            Some(_) => {
                problems.push("S3_FORCE_PATH_STYLE must be true or false".to_owned());
                false
            }
        };
        let ensure_buckets = match lookup("S3_ENSURE_BUCKETS").as_deref() {
            None | Some("false") => false,
            Some("true") => true,
            Some(_) => {
                problems.push("S3_ENSURE_BUCKETS must be true or false".to_owned());
                false
            }
        };
        Some(Self {
            private: weldsuite_adapters_oss::S3Options {
                endpoint,
                region: lookup("S3_REGION").unwrap_or_else(|| "us-east-1".to_owned()),
                bucket,
                access_key_id,
                secret_access_key,
                path_style,
            },
            public_bucket: lookup("S3_BUCKET_PUBLIC"),
            ensure_buckets,
        })
    }

    /// The legacy public bucket's settings, if there is one.
    pub(crate) fn public(&self) -> Option<weldsuite_adapters_oss::S3Options> {
        self.public_bucket
            .as_ref()
            .map(|bucket| weldsuite_adapters_oss::S3Options {
                bucket: bucket.clone(),
                ..self.private.clone()
            })
    }
}

impl fmt::Debug for InfraConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InfraConfig")
            .field("valkey", &self.valkey_url.as_ref().map(|_| "<set>"))
            .field("nats", &self.nats_url.as_ref().map(|_| "<set>"))
            .field("nats_stream", &self.nats_stream)
            .field("flags", &self.flags)
            .field("files", &self.files)
            .field("jobs", &self.jobs)
            .field("smtp", &self.smtp_url.as_ref().map(|_| "<set>"))
            .field("system_email_from", &self.system_email_from)
            .field("identity", &self.identity)
            .field("tenant_shards", &self.tenant_shards)
            .field("aad_writes", &self.aad_writes)
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
            nats_panel_stream: lookup("NATS_PANEL_EVENTS_STREAM")
                .unwrap_or_else(|| weldsuite_adapters_oss::DEFAULT_PANEL_EVENTS_STREAM.to_owned()),
            nats_panel_subject: lookup("NATS_PANEL_EVENTS_SUBJECT")
                .unwrap_or_else(|| weldsuite_adapters_oss::DEFAULT_PANEL_EVENTS_SUBJECT.to_owned()),
            nats_panel_max_age_days: lookup("NATS_PANEL_EVENTS_MAX_AGE_DAYS")
                .and_then(|days| days.parse().ok())
                .unwrap_or(0),
            nats_ensure_streams: lookup("NATS_ENSURE_STREAMS").as_deref() == Some("true"),
            flags,
            flags_refresh: Duration::from_secs(refresh_seconds),
            test_fixtures_token: lookup("TEST_FIXTURES_TOKEN"),
            files: FilesConfig::from_lookup(lookup, problems),
            jobs: JobsConfig::from_lookup(lookup, problems),
            smtp_url: lookup("SMTP_URL").filter(|url| !url.trim().is_empty()),
            system_email_from: lookup("SYSTEM_EMAIL_FROM").filter(|from| !from.trim().is_empty()),
            identity: IdentityConfig::from_lookup(lookup, problems),
            tenant_shards: lookup("TENANT_SHARDS")
                .filter(|shards| !shards.trim().is_empty())
                .and_then(|shards| {
                    weldsuite_adapters_oss::CnpgShard::parse_list(&shards)
                        .map_err(|error| problems.push(format!("TENANT_SHARDS: {error}")))
                        .ok()
                }),
            tenant_region: lookup("TENANT_REGION").filter(|region| !region.trim().is_empty()),
            aad_writes: lookup("FIELD_ENCRYPTION_AAD_WRITES").as_deref() == Some("true"),
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("metrics_addr", &self.metrics_addr)
            .field("environment", &self.environment)
            .field("edition", &self.edition)
            .field("master_max_connections", &self.master_max_connections)
            .field("keyring", &self.keyring)
            .field("auth", &self.auth)
            .field("permissions_app_enforce", &self.permissions_app_enforce)
            .field("workspaces", &self.workspaces)
            .field("log_format", &self.log_format)
            .field("shutdown_delay", &self.shutdown_delay)
            .field("spa_dir", &self.spa_dir)
            .field("infra", &self.infra)
            .field("realtime", &self.realtime)
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
        Self::from_lookup(env_value, |path| std::fs::read_to_string(path))
    }

    /// `lookup` reads a variable, `read_file` a file; both injectable for
    /// tests.
    #[allow(
        clippy::too_many_lines,
        reason = "one variable after the other, as ConsumeConfig::from_lookup"
    )]
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
        let trusted_proxies = number(&mut problems, "TRUSTED_PROXIES", 1);
        if trusted_proxies == 0 {
            problems.push("TRUSTED_PROXIES must be at least 1".to_owned());
        }
        let infra = InfraConfig::from_lookup(&lookup, &mut problems, flags_refresh);
        let realtime = weldsuite_realtime::GatewayConfig::from_lookup(&lookup, &mut problems);
        let metrics_addr = crate::monitoring::listen_addr(
            lookup(crate::monitoring::METRICS_ADDR).as_deref(),
            &mut problems,
        );

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

        let auth = AuthConfig::from_lookup(&lookup, &read_file, &mut problems);
        auth.check_sign_in_screens(&infra, &mut problems);
        let edition = crate::edition::EditionConfig::from_lookup(&lookup, &mut problems);

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
            metrics_addr,
            environment: lookup("ENVIRONMENT").unwrap_or_else(|| "development".to_owned()),
            edition,
            master_database_url,
            master_max_connections: saturate(master_max_connections),
            keyring,
            auth,
            permissions_app_enforce: lookup("PERMISSIONS_APP_ENFORCE").as_deref() == Some("true"),
            workspaces: WorkspaceConfig {
                cache_ttl: Duration::from_secs(cache_ttl),
                tenant_max_connections: saturate(tenant_max_connections),
                max_tenant_pools: usize::try_from(max_tenant_pools).unwrap_or(usize::MAX),
                ..WorkspaceConfig::default()
            },
            log_format,
            shutdown_delay: Duration::from_secs(shutdown_delay),
            spa_dir: lookup("SPA_DIR").map(PathBuf::from),
            infra,
            sign_session_secret: lookup("SIGN_SESSION_SECRET").filter(|s| !s.is_empty()),
            sign_portal_url: lookup("SIGN_PORTAL_URL").filter(|s| !s.is_empty()),
            public_app_url: lookup("PUBLIC_APP_URL").filter(|s| !s.trim().is_empty()),
            global_defaults: global_defaults(&lookup),
            project_portal_url: lookup("PROJECT_PORTAL_URL").filter(|s| !s.is_empty()),
            sign_portal_secret: lookup("SIGN_PORTAL_SECRET").filter(|s| !s.is_empty()),
            collab_rooms_urls: lookup("COLLAB_ROOMS_URLS")
                .map(|urls| {
                    urls.split(',')
                        .map(str::trim)
                        .filter(|url| !url.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            collab_rooms_secret: lookup("COLLAB_ROOMS_SECRET").filter(|s| !s.is_empty()),
            mail_inbound_secret: lookup("MAIL_INBOUND_SECRET").filter(|s| !s.is_empty()),
            files_public_url: lookup("S3_PUBLIC_URL").filter(|s| !s.is_empty()),
            files_public_via_server: lookup("S3_PUBLIC_VIA_SERVER").as_deref() == Some("true"),
            storage_signing_key: lookup("STORAGE_SIGNING_KEY").filter(|s| !s.is_empty()),
            platform_url: lookup("PLATFORM_URL").filter(|s| !s.trim().is_empty()),
            realtime,
            trusted_proxies: usize::try_from(trusted_proxies.max(1)).unwrap_or(usize::MAX),
        })
    }
}

/// A variable as `serve` and `consume` read it: empty counts as unset,
/// except `METRICS_ADDR`, where empty turns the metrics listener off.
pub(crate) fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty() || name == crate::monitoring::METRICS_ADDR)
}

fn saturate(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// The URL settings that name the install's own host: the platform, `/api`,
/// `/v1`, the integration webhooks and the WeldPanel collector are all served
/// there. The chart sets each to `config.publicUrl` (`PUBLIC_URL`) unless
/// `extraEnv` names it (`weldsuite.publicUrlEnv` in `_helpers.tpl`); unset,
/// the modules fall back to Global's `*.weldsuite.org` hosts.
pub(crate) const PUBLIC_URL_SETTINGS: &[&str] = &[
    "PUBLIC_APP_URL",
    "APP_URL",
    "PLATFORM_URL",
    "APP_API_PUBLIC_URL",
    "PUBLIC_API_URL",
    "CONNECT_API_URL",
    "CONNECTOR_WEBHOOK_BASE_URL",
    "WEBHOOK_BASE_URL",
    "PANEL_COLLECTOR_URL",
];

/// The settings still on a default that assumes the Global edition, one
/// sentence each with the setting that fixes it. Not problems: the server
/// starts (conformance and the kind test run on Global's defaults on
/// purpose), but an EU or self-hosted install should have none.
pub(crate) fn global_defaults(lookup: &impl Fn(&str) -> Option<String>) -> Vec<String> {
    let set = |name: &str| lookup(name).is_some_and(|value| !value.trim().is_empty());
    let mut out = Vec::new();
    if lookup("AUTH_PROVIDER").is_none_or(|provider| provider == "clerk") {
        out.push(
            "AUTH_PROVIDER is clerk: sign-in takes Global's Clerk session tokens; an EU or \
             self-hosted install signs in through its OIDC provider (AUTH_PROVIDER=oidc, chart \
             config.auth.provider)"
                .to_owned(),
        );
    }
    let unset: Vec<&str> = PUBLIC_URL_SETTINGS
        .iter()
        .copied()
        .filter(|name| !set(name))
        .collect();
    if !set("PUBLIC_URL") && unset.len() == PUBLIC_URL_SETTINGS.len() {
        out.push(
            "PUBLIC_URL is not set: links in mail, OAuth redirects and webhook registrations name \
             Global's *.weldsuite.org hosts (chart config.publicUrl)"
                .to_owned(),
        );
    } else if !unset.is_empty() {
        out.push(format!(
            "{} not set: those links name Global's *.weldsuite.org hosts (the chart sets them \
             from config.publicUrl)",
            match unset.as_slice() {
                [one] => format!("{one} is"),
                many => format!("{} are", many.join(", ")),
            }
        ));
    }
    if set("S3_ENDPOINT") && !set("S3_PUBLIC_URL") {
        out.push(
            "S3_PUBLIC_URL is not set: public object links (avatars, logos, published documents) \
             name Global's test bucket host (chart config.files.publicUrl)"
                .to_owned(),
        );
    }
    if set("SMTP_URL") && !set("SYSTEM_EMAIL_FROM") {
        out.push(
            "SYSTEM_EMAIL_FROM is not set: system mail is sent from \
             notifications@mail.weldsuite.org, which a relay may refuse and receivers may treat \
             as spoofed (chart config.mail.from)"
                .to_owned(),
        );
    }
    if !weldsuite_video_rooms::configured(lookup) {
        out.push(
            "no video service is configured (LiveKit's URL and key pair): WeldMeet is hidden \
             (chart config.video)"
                .to_owned(),
        );
    }
    out
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
        assert_eq!(config.trusted_proxies, 1);
        assert!(matches!(
            &config.auth,
            AuthConfig::Clerk { key: ClerkKey::Pem(pem), .. } if pem.contains('\n')
        ));
        assert!(!format!("{config:?}").contains("postgres://master"));
    }

    #[test]
    fn metrics_listen_apart_from_the_api_unless_off() {
        let base = [
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("CLERK_JWT_KEY", "-----BEGIN PUBLIC KEY-----\\nabc"),
        ];
        let with = |value: Option<&'static str>| {
            let mut vars = base.to_vec();
            vars.extend(value.map(|value| ("METRICS_ADDR", value)));
            config(&vars)
        };
        let metrics = with(None).expect("valid").metrics_addr;
        assert_eq!(
            metrics.map(|addr| addr.to_string()).as_deref(),
            Some("0.0.0.0:9464")
        );
        assert_ne!(metrics, Some(with(None).expect("valid").listen));
        for off in ["off", ""] {
            assert_eq!(
                with(Some(off)).expect("valid").metrics_addr,
                None,
                "{off:?}"
            );
        }
        let error = with(Some("everywhere")).expect_err("invalid");
        assert!(error.to_string().contains("METRICS_ADDR"), "{error}");
    }

    #[test]
    fn lists_every_problem() {
        let error = config(&[("PORT", "eighty"), ("LOG_FORMAT", "xml")]).expect_err("invalid");
        assert_eq!(error.0.len(), 4, "{error}");
    }

    #[test]
    fn mail_is_optional_and_its_url_stays_out_of_logs() {
        let base = [
            ("DATABASE_URL_MASTER", "postgres://master"),
            (
                "CLERK_JWT_KEY",
                "-----BEGIN PUBLIC KEY-----
abc",
            ),
        ];
        assert!(config(&base).expect("valid").infra.smtp_url.is_none());
        let mut vars = base.to_vec();
        vars.extend([
            ("SMTP_URL", "smtp://user:hunter2@relay:587?tls=required"),
            ("SYSTEM_EMAIL_FROM", "mail@eu.example"),
        ]);
        let config = config(&vars).expect("valid");
        assert_eq!(
            config.infra.system_email_from.as_deref(),
            Some("mail@eu.example")
        );
        assert!(!format!("{config:?}").contains("hunter2"));
    }

    #[test]
    fn object_storage_is_optional_but_complete() {
        let base = [
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("CLERK_JWT_KEY", "-----BEGIN PUBLIC KEY-----\\nabc"),
        ];
        assert!(config(&base).expect("valid").infra.files.is_none());

        let mut vars = base.to_vec();
        vars.extend([
            ("S3_ENDPOINT", "http://s3:9000"),
            ("S3_BUCKET_PRIVATE", "weldsuite-private"),
            ("S3_BUCKET_PUBLIC", "weldsuite-public"),
            ("S3_ACCESS_KEY_ID", "key"),
            ("S3_SECRET_ACCESS_KEY", "very-secret"),
            ("S3_FORCE_PATH_STYLE", "true"),
        ]);
        let config = config(&vars).expect("valid");
        let files = config.infra.files.as_ref().expect("files");
        assert!(files.private.path_style);
        assert_eq!(files.private.region, "us-east-1");
        assert_eq!(
            files.public().map(|p| p.bucket).as_deref(),
            Some("weldsuite-public")
        );
        assert!(!format!("{config:?}").contains("very-secret"));

        let mut incomplete = base.to_vec();
        incomplete.extend([
            ("S3_ENDPOINT", "http://s3:9000"),
            ("S3_FORCE_PATH_STYLE", "yes"),
        ]);
        let error = super::Config::from_lookup(
            |name| {
                incomplete
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| (*v).to_owned())
            },
            |_| Err(std::io::Error::other("missing")),
        )
        .expect_err("incomplete");
        assert_eq!(error.0.len(), 4, "{error}");
    }

    #[test]
    fn reads_a_jwks_file() {
        let config = config(&[
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("CLERK_JWKS_FILE", "/etc/clerk/jwks.json"),
        ])
        .expect("valid");
        assert!(matches!(
            config.auth,
            AuthConfig::Clerk {
                key: ClerkKey::Jwks(_),
                ..
            }
        ));
    }

    #[test]
    fn oidc_needs_an_issuer_and_audience_and_no_clerk_key() {
        let oidc = config(&[
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("AUTH_PROVIDER", "oidc"),
            ("OIDC_ISSUER", "https://auth.eu.example"),
            ("OIDC_AUDIENCE", "300000000000000100, 300000000000000200"),
            ("OIDC_WEB_CLIENT_ID", "300000000000000300"),
            ("OIDC_MOBILE_CLIENT_ID", "300000000000000400"),
        ])
        .expect("valid");
        let AuthConfig::Oidc {
            settings,
            web_client_id,
            mobile_client_id,
            platform_sign_in,
        } = &oidc.auth
        else {
            panic!("oidc expected");
        };
        assert!(!platform_sign_in, "the provider's own pages by default");
        assert_eq!(settings.issuer, "https://auth.eu.example");
        assert_eq!(
            settings.audiences,
            ["300000000000000100", "300000000000000200"]
        );
        assert_eq!(settings.org_claim, weldsuite_auth::ZITADEL_ORG_CLAIM);
        assert_eq!(settings.jwks_url, None);
        assert_eq!(web_client_id.as_deref(), Some("300000000000000300"));
        assert_eq!(mobile_client_id.as_deref(), Some("300000000000000400"));

        let error = config(&[
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("AUTH_PROVIDER", "oidc"),
        ])
        .expect_err("incomplete");
        assert_eq!(error.0.len(), 2, "{error}");
        assert!(error.0.iter().all(|problem| problem.contains("OIDC_")));

        let error = config(&[
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("AUTH_PROVIDER", "saml"),
        ])
        .expect_err("unknown provider");
        assert!(error.0[0].contains("AUTH_PROVIDER"));

        let claim = config(&[
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("AUTH_PROVIDER", "oidc"),
            ("OIDC_ISSUER", "https://auth.eu.example"),
            ("OIDC_AUDIENCE", "p"),
            ("OIDC_ORG_CLAIM", "urn:zitadel:iam:org:project:roles"),
            ("OIDC_JWKS_URL", "http://zitadel:8080/oauth/v2/keys"),
        ])
        .expect("valid");
        assert!(matches!(
            &claim.auth,
            AuthConfig::Oidc { settings, .. }
                if settings.org_claim == "urn:zitadel:iam:org:project:roles"
                    && settings.jwks_url.is_some()
        ));
    }

    #[test]
    fn the_platforms_own_sign_in_screens_need_the_providers_login_api() {
        let oidc = [
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("AUTH_PROVIDER", "oidc"),
            ("OIDC_ISSUER", "https://auth.eu.example"),
            ("OIDC_AUDIENCE", "300000000000000100"),
            ("OIDC_SIGN_IN", "platform"),
        ];
        let error = config(&oidc).expect_err("no login API");
        assert!(error.0[0].contains("OIDC_SIGN_IN=platform"), "{error}");

        let mut vars = oidc.to_vec();
        vars.extend([
            ("ZITADEL_API_URL", "http://zitadel:8080"),
            ("ZITADEL_SERVICE_TOKEN", "service"),
            ("ZITADEL_PROJECT_ID", "300000000000000100"),
            ("ZITADEL_LOGIN_TOKEN", "login"),
            ("PLATFORM_URL", "https://app.eu.example"),
        ]);
        let config_with = config(&vars).expect("valid");
        assert!(matches!(
            config_with.auth,
            AuthConfig::Oidc {
                platform_sign_in: true,
                ..
            }
        ));
        let identity = config_with.infra.identity.expect("identity");
        assert_eq!(identity.login_token.as_deref(), Some("login"));
        assert_eq!(
            config_with.platform_url.as_deref(),
            Some("https://app.eu.example")
        );

        let mut vars = oidc.to_vec();
        vars[4] = ("OIDC_SIGN_IN", "embedded");
        let error = config(&vars).expect_err("unknown value");
        assert!(error.0[0].contains("OIDC_SIGN_IN must be"), "{error}");
    }

    #[test]
    fn jobs_run_in_process_unless_restate_is_set() {
        let base = [
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("CLERK_JWT_KEY", "-----BEGIN PUBLIC KEY-----\\nabc"),
        ];
        let jobs = config(&base).expect("valid").infra.jobs;
        assert_eq!(jobs.restate_ingress_url, None);
        assert_eq!(jobs.port, 9080);

        let mut vars = base.to_vec();
        vars.extend([
            ("RESTATE_INGRESS_URL", "http://restate:8080"),
            ("RESTATE_ADMIN_URL", "http://restate:9070"),
            ("RESTATE_DEPLOYMENT_URI", "http://weldsuite-jobs:9080"),
            ("JOBS_PORT", "9180"),
        ]);
        let jobs = config(&vars).expect("valid").infra.jobs;
        assert_eq!(
            jobs.restate_admin_url.as_deref(),
            Some("http://restate:9070")
        );
        assert_eq!(jobs.port, 9180);

        let mut vars = base.to_vec();
        vars.push(("RESTATE_ADMIN_URL", "http://restate:9070"));
        let error = config(&vars).expect_err("invalid");
        assert!(error.0.iter().any(|p| p.contains("RESTATE_DEPLOYMENT_URI")));
        assert!(error.0.iter().any(|p| p.contains("RESTATE_INGRESS_URL")));
    }

    fn defaults(vars: &[(&str, &str)]) -> Vec<String> {
        let lookup = |name: &str| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        };
        global_defaults(&lookup)
    }

    #[test]
    fn names_every_global_default_still_in_use() {
        let all = defaults(&[
            ("S3_ENDPOINT", "http://s3:9000"),
            ("SMTP_URL", "smtp://relay:25"),
        ]);
        for start in [
            "AUTH_PROVIDER is clerk",
            "PUBLIC_URL is not set",
            "S3_PUBLIC_URL is not set",
            "SYSTEM_EMAIL_FROM is not set",
            "no video service",
        ] {
            assert!(
                all.iter().any(|line| line.starts_with(start)),
                "{start}: {all:?}"
            );
        }
        // Without S3 or SMTP there is nothing to say about them.
        assert_eq!(defaults(&[]).len(), 3);
    }

    #[test]
    fn a_configured_install_has_no_global_defaults() {
        let mut vars = vec![
            ("AUTH_PROVIDER", "oidc"),
            ("PUBLIC_URL", "https://weldsuite.example.com"),
            ("S3_ENDPOINT", "http://s3:9000"),
            ("S3_PUBLIC_URL", "https://files.weldsuite.example.com"),
            ("SMTP_URL", "smtp://relay:25"),
            ("SYSTEM_EMAIL_FROM", "WeldSuite <noreply@example.com>"),
            ("LIVEKIT_URL", "wss://lk.example.com"),
            ("LIVEKIT_API_KEY", "key"),
            ("LIVEKIT_API_SECRET", "secret"),
        ];
        vars.extend(
            PUBLIC_URL_SETTINGS
                .iter()
                .map(|name| (*name, "https://weldsuite.example.com")),
        );
        assert_eq!(defaults(&vars), Vec::<String>::new());
    }

    #[test]
    fn lists_the_url_settings_public_url_left_unset() {
        // PUBLIC_URL without the chart: the settings it would have filled.
        let lines = defaults(&[
            ("AUTH_PROVIDER", "oidc"),
            ("PUBLIC_URL", "https://weldsuite.example.com"),
            ("PLATFORM_URL", "https://weldsuite.example.com"),
        ]);
        let urls = lines
            .iter()
            .find(|line| line.contains("are not set"))
            .expect("listed");
        assert!(
            urls.starts_with("PUBLIC_APP_URL, APP_URL, APP_API_PUBLIC_URL"),
            "{urls}"
        );
        assert!(!urls.contains("PLATFORM_URL"), "{urls}");
    }

    #[test]
    fn reads_the_public_app_url() {
        let config = config(&[
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("CLERK_JWT_KEY", "-----BEGIN PUBLIC KEY-----\\nabc"),
            ("PUBLIC_APP_URL", "https://weldsuite.example.com"),
        ])
        .expect("valid");
        assert_eq!(
            config.public_app_url.as_deref(),
            Some("https://weldsuite.example.com")
        );
        assert!(!config.global_defaults.is_empty(), "clerk, no video");
    }
}
