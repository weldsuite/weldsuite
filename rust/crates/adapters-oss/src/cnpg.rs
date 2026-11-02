//! CloudNativePG: [`DatabaseProvisioner`] on Postgres tenant shards, each a
//! CloudNativePG `Cluster` with a transaction-mode `PgBouncer` `Pooler` in
//! front (`rust/deploy/flux/infrastructure/configs/base`). It does what
//! `provisionSharedDatabase` and `deleteWorkspaceDatabase`
//! (`@weldsuite/neon-provisioning`) do on a Neon shard, with SQL instead of
//! the Neon API.
//!
//! # Where things are recorded (the master database, as on Neon)
//!
//! - A shard is a `neon_shared_projects` row, registered from the
//!   configuration ([`CnpgProvisioner::register_shards`], also done on first
//!   use): `neon_project_id` = `cnpg:<cluster name>`, `neon_project_name` =
//!   the cluster name, `connection_host`/`connection_port` = its pooler,
//!   `admin_role` = the admin user, `region`, `max_databases`; `database_count`
//!   and `status` (`active` / `full` / `disabled`) are claimed and released
//!   with the TypeScript statements (`claimSharedProject`,
//!   `decrementShardCount`), so an admin can disable a shard or watch it fill.
//!   The admin password stays in the Kubernetes Secret, never in the master.
//! - A workspace's placement goes on its row, claimed once with
//!   `… where neon_project_id is null` (one database per workspace, however
//!   many calls race): `neon_project_id` = the shard's `cnpg:<name>`,
//!   `shared_project_id` = its row, `neon_database_name` = `ws_<workspace id>`,
//!   `neon_role_name` = `role_<workspace id>` (lowercased, anything but
//!   `[a-z0-9_]` as `_`, as TypeScript names them), `neon_region`, and no
//!   `neon_branch_id`. `weldsuite migrate` finds tenants by that placement.
//! - `database_url` holds the URL sealed as `encryptWorkspaceDatabaseUrl`
//!   seals it (v3, bound to the workspace, with AAD writes on and a v2 key;
//!   else v2, else v1): `postgres://role_<id>:<password>@<pooler host>:<port>/ws_<id>?<url options>`.
//!
//! # On the shard
//!
//! Through the admin connection (straight to the primary, `<cluster>-rw`,
//! not the pooler: the per-database session advisory lock that serialises
//! two calls for one workspace needs a session), as a role with `CREATEDB`
//! and `CREATEROLE` (or a superuser):
//!
//! 1. `CREATE ROLE role_<id> LOGIN PASSWORD '<SCRAM verifier>'`: a 256-bit
//!    random password, sent as its SCRAM-SHA-256 verifier, so the password
//!    itself never reaches the server or its statement log. On Postgres 16+
//!    a non-superuser admin sets `createrole_self_grant` to `set, inherit`
//!    first, so it may create and later drop the role's database; before 16
//!    it grants itself the role.
//! 2. `CREATE DATABASE ws_<id> OWNER role_<id>` (from `template`, default
//!    `template1`), then `REVOKE ALL ON DATABASE … FROM PUBLIC`: another
//!    workspace's role cannot even connect.
//! 3. The extensions the tenant schema needs (`vector`, `pg_trgm`), created
//!    by the admin in the new database when missing. pgvector is not a
//!    trusted extension, so with a non-superuser admin the template must
//!    carry it: the Flux clusters create both in `template1`
//!    (`postInitTemplateSQL`).
//! 4. The URL is sealed and stored; then the tenant migrations run through
//!    `weldsuite-migrations` over that URL, so the pooler path and the new
//!    role's login are proven before the call returns. Like the workspace
//!    worker's applier, every journal migration the database lacks is
//!    applied (Drizzle's rule, then the skipped ones).
//!
//! A call that finds the work partly done finishes it: a missing role or
//! database is created; a role whose password is not in a stored URL that
//! still matches gets a new one.
//!
//! # How a new database reaches the pooler
//!
//! Nothing to configure. CloudNativePG writes the `Pooler`'s `PgBouncer`
//! configuration with a wildcard database (`* = host=<cluster>-rw`) and
//! `auth_query` login: `PgBouncer` looks every user up through the
//! `cnpg_pooler_pgbouncer` role and the `user_search` function in the
//! `postgres` database (`auth_dbname`), and passes SCRAM through. So a role
//! and database created on the cluster are reachable through
//! `<cluster>-pooler` as soon as they exist. The pooler's connection caps are
//! per user and per database, and every workspace now has its own role: see
//! the note in `poolers.yaml`.
//!
//! No warm pool: `CREATE DATABASE` takes milliseconds and the whole journal
//! applies in a few seconds, against the minutes a Neon project needs, which
//! is what the Global pool (`refill-pool.ts`) hides.

use std::fmt;
use std::num::NonZeroU32;
use std::str::FromStr;
use std::time::Duration;

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use aws_lc_rs::{digest, hmac, pbkdf2};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use sqlx::postgres::PgConnectOptions;
use sqlx::{AssertSqlSafe, Connection, PgConnection, PgPool};
use tokio::sync::OnceCell;
use weldsuite_db::{Keyring, encrypt_workspace_database_url, resolve_database_url};
use weldsuite_migrations::{DatabaseOptions, Folder, Journal, migrate_database};
use weldsuite_ports::{
    BoxFuture, DatabaseProvisioner, DatabaseUrl, Placement, ProvisionError, ProvisionRequest,
    ProvisionedDatabase, Teardown,
};

/// Postgres's identifier limit (`NAMEDATALEN - 1`).
const MAX_IDENTIFIER: usize = 63;
/// PBKDF2 rounds of the SCRAM verifier: Postgres's default
/// (`scram_iterations`).
const SCRAM_ITERATIONS: NonZeroU32 = NonZeroU32::new(4096).expect("non-zero");
/// How long a shard connection may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

fn default_pooler_port() -> u16 {
    5432
}

fn default_url_options() -> String {
    "sslmode=require".to_owned()
}

fn default_max_databases() -> i16 {
    500
}

/// One tenant shard: a CloudNativePG `Cluster` and its `Pooler`. Reads the
/// JSON the server's configuration holds (`TENANT_SHARDS`, a list of these):
///
/// ```json
/// [{"name": "tenants-1",
///   "adminUrl": "postgres://tenant:…@tenants-1-rw.postgres.svc:5432/tenants?sslmode=require",
///   "poolerHost": "tenants-1-pooler.postgres.svc"}]
/// ```
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CnpgShard {
    /// The `Cluster`'s name (`tenants-1`): `[a-z0-9-]`, how a request pins
    /// the shard and how its `neon_shared_projects` row is keyed.
    pub name: String,
    /// The admin connection, straight to the primary (`<cluster>-rw`), as a
    /// role with `CREATEDB` and `CREATEROLE`, or a superuser.
    pub admin_url: String,
    /// Where tenant URLs point: the `Pooler`'s Service.
    pub pooler_host: String,
    #[serde(default = "default_pooler_port")]
    pub pooler_port: u16,
    /// The query string of tenant URLs (empty for none).
    #[serde(default = "default_url_options")]
    pub url_options: String,
    /// How many workspace databases the shard takes before it counts as full.
    /// Spike S4 held 2,000 on one server; this is a placement limit, not a
    /// Postgres one.
    #[serde(default = "default_max_databases")]
    pub max_databases: i16,
}

impl fmt::Debug for CnpgShard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CnpgShard")
            .field("name", &self.name)
            .field("pooler_host", &self.pooler_host)
            .field("pooler_port", &self.pooler_port)
            .field("max_databases", &self.max_databases)
            .finish_non_exhaustive()
    }
}

impl CnpgShard {
    /// The shards of a `TENANT_SHARDS` value.
    pub fn parse_list(json: &str) -> Result<Vec<Self>, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// `neon_shared_projects.neon_project_id` and `workspaces.neon_project_id`.
    pub fn key(&self) -> String {
        shard_key(&self.name)
    }
}

fn shard_key(name: &str) -> String {
    format!("cnpg:{name}")
}

/// What [`CnpgProvisioner`] works with.
#[derive(Debug, Clone)]
pub struct CnpgOptions {
    pub shards: Vec<CnpgShard>,
    /// `neon_shared_projects.region` of the shards, and the region a new
    /// workspace is placed in.
    pub region: String,
    /// Extensions each new database gets (created when missing).
    pub extensions: Vec<String>,
    /// `CREATE DATABASE … TEMPLATE`; `None` is Postgres's default, `template1`.
    pub template: Option<String>,
    /// Seals `workspaces.database_url` (`DATABASE_ENCRYPTION_KEY[_V2]`).
    pub keyring: Keyring,
    /// `FIELD_ENCRYPTION_AAD_WRITES`: seal URLs as v3. Every Rust reader opens
    /// v3, so the Kubernetes editions can have it on from the start.
    pub aad_writes: bool,
}

impl CnpgOptions {
    /// `region` `default`, the tenant schema's extensions, `template1`, AAD
    /// writes off (the TypeScript default).
    pub fn new(shards: Vec<CnpgShard>, keyring: Keyring) -> Self {
        Self {
            shards,
            region: "default".to_owned(),
            extensions: vec!["vector".to_owned(), "pg_trgm".to_owned()],
            template: None,
            keyring,
            aad_writes: false,
        }
    }
}

/// Lowercase, anything but `[a-z0-9_]` as `_` (one per UTF-16 unit, as
/// JavaScript counts): the TypeScript `sanitize`.
fn sanitize(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    out
}

/// A workspace's database and role names: `ws_<id>` and `role_<id>`,
/// sanitised.
pub fn database_names(workspace_id: &str) -> Result<(String, String), ProvisionError> {
    if workspace_id.is_empty() {
        return Err(ProvisionError::InvalidWorkspaceId("it is empty".to_owned()));
    }
    let database = sanitize(&format!("ws_{workspace_id}"));
    let role = sanitize(&format!("role_{workspace_id}"));
    if role.len() > MAX_IDENTIFIER {
        return Err(ProvisionError::InvalidWorkspaceId(format!(
            "it makes a role name of {} characters, more than Postgres's {MAX_IDENTIFIER}",
            role.len()
        )));
    }
    Ok((database, role))
}

/// A configured name (shard, extension, template) Postgres can take as an
/// identifier.
fn checked_identifier(kind: &str, value: &str) -> Result<(), ProvisionError> {
    let valid = !value.is_empty()
        && value.len() <= MAX_IDENTIFIER
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(ProvisionError::Shard(
            format!("{kind} {value:?} is not a plain identifier").into(),
        ))
    }
}

/// `"name"`, for names already checked to be plain identifiers.
fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The SCRAM-SHA-256 verifier Postgres stores for `password`
/// (`SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, RFC 5803).
/// Postgres takes it in place of the password and keeps it as is.
fn scram_verifier(password: &str, salt: &[u8; 16]) -> String {
    let mut salted = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        SCRAM_ITERATIONS,
        salt,
        password.as_bytes(),
        &mut salted,
    );
    let key = hmac::Key::new(hmac::HMAC_SHA256, &salted);
    let client_key = hmac::sign(&key, b"Client Key");
    let stored_key = digest::digest(&digest::SHA256, client_key.as_ref());
    let server_key = hmac::sign(&key, b"Server Key");
    format!(
        "SCRAM-SHA-256${}:{}${}:{}",
        SCRAM_ITERATIONS,
        STANDARD.encode(salt),
        STANDARD.encode(stored_key.as_ref()),
        STANDARD.encode(server_key.as_ref())
    )
}

/// A fresh password (64 hex characters) and its verifier.
fn new_password() -> Result<(String, String), ProvisionError> {
    let random = SystemRandom::new();
    let mut secret = [0u8; 32];
    let mut salt = [0u8; 16];
    random
        .fill(&mut secret)
        .and_then(|()| random.fill(&mut salt))
        .map_err(|_| ProvisionError::Shard("the random number generator failed".into()))?;
    let password = hex::encode(secret);
    let verifier = scram_verifier(&password, &salt);
    Ok((password, verifier))
}

fn master_error(error: sqlx::Error) -> ProvisionError {
    ProvisionError::Master(Box::new(error))
}

fn shard_error(error: sqlx::Error) -> ProvisionError {
    ProvisionError::Shard(Box::new(error))
}

async fn connect(options: &PgConnectOptions) -> Result<PgConnection, ProvisionError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, PgConnection::connect_with(options)).await {
        Ok(result) => result.map_err(shard_error),
        Err(_) => Err(ProvisionError::Shard(
            format!("no connection within {}s", CONNECT_TIMEOUT.as_secs()).into(),
        )),
    }
}

#[derive(sqlx::FromRow)]
struct WorkspaceRow {
    neon_project_id: Option<String>,
    neon_database_name: Option<String>,
    neon_role_name: Option<String>,
    shared_project_id: Option<String>,
}

/// The admin's powers, which decide how it may own what it creates.
struct Admin {
    superuser: bool,
    server_version: i32,
}

/// [`DatabaseProvisioner`] on CloudNativePG shards. See the module docs.
pub struct CnpgProvisioner {
    master: PgPool,
    options: CnpgOptions,
    journal: &'static Journal,
    registered: OnceCell<()>,
}

impl fmt::Debug for CnpgProvisioner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CnpgProvisioner")
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

impl CnpgProvisioner {
    /// A provisioner over `master` (the master database pool) and the
    /// configured shards. Refuses names that are not plain identifiers.
    pub fn new(master: PgPool, options: CnpgOptions) -> Result<Self, ProvisionError> {
        if options.shards.is_empty() {
            return Err(ProvisionError::NoCapacity);
        }
        for shard in &options.shards {
            checked_identifier("shard name", &shard.name)?;
            PgConnectOptions::from_str(&shard.admin_url).map_err(|_| {
                ProvisionError::Shard(
                    format!("shard {}: adminUrl is not a Postgres URL", shard.name).into(),
                )
            })?;
        }
        for extension in &options.extensions {
            checked_identifier("extension", extension)?;
        }
        if let Some(template) = &options.template {
            checked_identifier("template", template)?;
        }
        Ok(Self {
            master,
            options,
            journal: Journal::embedded(Folder::Tenant),
            registered: OnceCell::new(),
        })
    }

    /// Migrate new databases with `journal` instead of the embedded tenant
    /// journal (tests).
    #[must_use]
    pub fn with_journal(mut self, journal: &'static Journal) -> Self {
        self.journal = journal;
        self
    }

    fn shard_by_key(&self, key: &str) -> Option<&CnpgShard> {
        self.options.shards.iter().find(|shard| shard.key() == key)
    }

    /// Record (or refresh) every configured shard in `neon_shared_projects`:
    /// its pooler, admin user, region and capacity. The count and an admin's
    /// `disabled` stay; a `full` shard given more room opens again.
    pub async fn register_shards(&self) -> Result<(), ProvisionError> {
        for shard in &self.options.shards {
            let admin = PgConnectOptions::from_str(&shard.admin_url)
                .map(|options| options.get_username().to_owned())
                .ok();
            let port = i16::try_from(shard.pooler_port).unwrap_or(i16::MAX);
            sqlx::query(
                "insert into neon_shared_projects
                     (id, neon_project_id, neon_project_name, region, connection_host,
                      connection_port, admin_role, max_databases, database_count, status)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'active')
                 on conflict (neon_project_id) do update set
                     neon_project_name = excluded.neon_project_name,
                     region = excluded.region,
                     connection_host = excluded.connection_host,
                     connection_port = excluded.connection_port,
                     admin_role = excluded.admin_role,
                     max_databases = excluded.max_databases,
                     status = case
                         when neon_shared_projects.status = 'full'
                              and neon_shared_projects.database_count < excluded.max_databases
                             then 'active'::neon_shared_project_status
                         when neon_shared_projects.status = 'active'
                              and neon_shared_projects.database_count >= excluded.max_databases
                             then 'full'::neon_shared_project_status
                         else neon_shared_projects.status
                     end,
                     updated_at = timezone('utc', now())",
            )
            .bind(weldsuite_kit::generate_id("nsp"))
            .bind(shard.key())
            .bind(&shard.name)
            .bind(&self.options.region)
            .bind(&shard.pooler_host)
            .bind(port)
            .bind(admin)
            .bind(shard.max_databases)
            .execute(&self.master)
            .await
            .map_err(master_error)?;
        }
        Ok(())
    }

    async fn ensure_registered(&self) -> Result<(), ProvisionError> {
        self.registered
            .get_or_try_init(|| self.register_shards())
            .await?;
        Ok(())
    }

    async fn workspace(&self, workspace_id: &str) -> Result<WorkspaceRow, ProvisionError> {
        sqlx::query_as(
            "select neon_project_id, neon_database_name, neon_role_name, shared_project_id
             from workspaces where id = $1",
        )
        .bind(workspace_id)
        .fetch_optional(&self.master)
        .await
        .map_err(master_error)?
        .ok_or(ProvisionError::WorkspaceNotFound)
    }

    /// The placement a row records, when it is on a managed shard.
    fn recorded_placement(
        &self,
        row: &WorkspaceRow,
    ) -> Result<Option<(&CnpgShard, Placement)>, ProvisionError> {
        let Some(key) = row.neon_project_id.as_deref() else {
            return Ok(None);
        };
        let foreign = || ProvisionError::ForeignPlacement(key.to_owned());
        let shard = self.shard_by_key(key).ok_or_else(foreign)?;
        let (Some(database_name), Some(role_name), Some(shard_id)) = (
            row.neon_database_name.clone(),
            row.neon_role_name.clone(),
            row.shared_project_id.clone(),
        ) else {
            return Err(foreign());
        };
        Ok(Some((
            shard,
            Placement {
                shard_id,
                shard_name: shard.name.clone(),
                database_name,
                role_name,
            },
        )))
    }

    /// Reserve a slot on a managed, active shard of the region with room,
    /// the emptiest first (`claimSharedProject`). Returns its row id and key.
    async fn claim_capacity(
        &self,
        pinned: Option<&str>,
    ) -> Result<(String, String), ProvisionError> {
        let keys: Vec<String> = match pinned {
            Some(name) => {
                let key = shard_key(name);
                if self.shard_by_key(&key).is_none() {
                    return Err(ProvisionError::UnknownShard(name.to_owned()));
                }
                vec![key]
            }
            None => self.options.shards.iter().map(CnpgShard::key).collect(),
        };
        let claimed: Option<(String, String)> = sqlx::query_as(
            "update neon_shared_projects
             set database_count = database_count + 1,
                 status = case when database_count + 1 >= max_databases then 'full' else status end,
                 updated_at = timezone('utc', now())
             where id = (
                 select id from neon_shared_projects
                 where status = 'active'
                   and region = $1
                   and database_count < max_databases
                   and neon_project_id = any($2)
                 order by database_count asc
                 limit 1
                 for update skip locked
             )
             returning id, neon_project_id",
        )
        .bind(&self.options.region)
        .bind(&keys)
        .fetch_optional(&self.master)
        .await
        .map_err(master_error)?;
        claimed.ok_or(ProvisionError::NoCapacity)
    }

    /// Give a slot back (`decrementShardCount`): never below zero, and a
    /// `full` shard with room is `active` again.
    async fn release_capacity(&self, shard_id: &str) -> Result<(), ProvisionError> {
        sqlx::query(
            "update neon_shared_projects
             set database_count = greatest(database_count - 1, 0),
                 status = case when status = 'full' and database_count - 1 < max_databases
                               then 'active'::neon_shared_project_status else status end,
                 updated_at = timezone('utc', now())
             where id = $1",
        )
        .bind(shard_id)
        .execute(&self.master)
        .await
        .map(|_| ())
        .map_err(master_error)
    }

    /// The workspace's placement: the recorded one, or a new one claimed now.
    async fn place(
        &self,
        request: &ProvisionRequest,
    ) -> Result<(&CnpgShard, Placement), ProvisionError> {
        let row = self.workspace(&request.workspace_id).await?;
        if let Some(placed) = self.recorded_placement(&row)? {
            return Ok(placed);
        }
        let (database_name, role_name) = database_names(&request.workspace_id)?;
        let (shard_id, key) = self.claim_capacity(request.shard.as_deref()).await?;
        let claimed = sqlx::query(
            "update workspaces
             set neon_project_id = $2, neon_database_name = $3, neon_branch_id = null,
                 neon_role_name = $4, neon_region = $5, shared_project_id = $6,
                 updated_at = timezone('utc', now())
             where id = $1 and neon_project_id is null",
        )
        .bind(&request.workspace_id)
        .bind(&key)
        .bind(&database_name)
        .bind(&role_name)
        .bind(&self.options.region)
        .bind(&shard_id)
        .execute(&self.master)
        .await
        .map_err(master_error)?
        .rows_affected();
        if claimed == 0 {
            // Another call placed it first: give the slot back and follow it.
            self.release_capacity(&shard_id).await?;
            let row = self.workspace(&request.workspace_id).await?;
            return self.recorded_placement(&row)?.ok_or_else(|| {
                ProvisionError::ForeignPlacement("placement cleared meanwhile".to_owned())
            });
        }
        let shard = self
            .shard_by_key(&key)
            .ok_or_else(|| ProvisionError::UnknownShard(key.clone()))?;
        Ok((
            shard,
            Placement {
                shard_id,
                shard_name: shard.name.clone(),
                database_name,
                role_name,
            },
        ))
    }

    fn tenant_url(shard: &CnpgShard, placement: &Placement, password: &str) -> String {
        let mut url = format!(
            "postgres://{}:{password}@{}:{}/{}",
            placement.role_name, shard.pooler_host, shard.pooler_port, placement.database_name
        );
        if !shard.url_options.is_empty() {
            url.push('?');
            url.push_str(&shard.url_options);
        }
        url
    }

    /// Whether a stored URL is this placement's on this shard's pooler (its
    /// password is not known here; the migrations then log in with it).
    fn url_matches(url: &str, shard: &CnpgShard, placement: &Placement) -> bool {
        url.starts_with(&format!("postgres://{}:", placement.role_name))
            && url.contains(&format!(
                "@{}:{}/{}",
                shard.pooler_host, shard.pooler_port, placement.database_name
            ))
    }

    /// The stored URL, opened, when it still matches the placement.
    async fn stored_url(
        &self,
        workspace_id: &str,
        shard: &CnpgShard,
        placement: &Placement,
    ) -> Result<Option<String>, ProvisionError> {
        let stored: Option<Option<String>> =
            sqlx::query_scalar("select database_url from workspaces where id = $1")
                .bind(workspace_id)
                .fetch_optional(&self.master)
                .await
                .map_err(master_error)?;
        Ok(stored
            .flatten()
            .and_then(|stored| {
                resolve_database_url(&stored, workspace_id, &self.options.keyring).ok()
            })
            .filter(|url| Self::url_matches(url, shard, placement)))
    }

    async fn store_url(
        &self,
        workspace_id: &str,
        placement: &Placement,
        url: &str,
    ) -> Result<(), ProvisionError> {
        let sealed = encrypt_workspace_database_url(
            url,
            workspace_id,
            &self.options.keyring,
            self.options.aad_writes,
        )
        .map_err(|error| ProvisionError::Encryption(error.to_string()))?;
        let stored = sqlx::query(
            "update workspaces set database_url = $2, updated_at = timezone('utc', now())
             where id = $1 and neon_database_name = $3",
        )
        .bind(workspace_id)
        .bind(sealed)
        .bind(&placement.database_name)
        .execute(&self.master)
        .await
        .map_err(master_error)?
        .rows_affected();
        if stored == 0 {
            return Err(ProvisionError::ForeignPlacement(
                "the placement changed while provisioning".to_owned(),
            ));
        }
        Ok(())
    }

    /// Role, database, extensions and stored URL, under the database's lock.
    /// Returns the URL and whether the database was created.
    async fn ensure_database(
        &self,
        workspace_id: &str,
        shard: &CnpgShard,
        placement: &Placement,
    ) -> Result<(String, bool), ProvisionError> {
        let admin_options = PgConnectOptions::from_str(&shard.admin_url).map_err(shard_error)?;
        let mut admin = connect(&admin_options).await?;
        let lock = format!("weldsuite:provision:{}", placement.database_name);
        sqlx::query("select pg_advisory_lock(hashtextextended($1, 0))")
            .bind(&lock)
            .execute(&mut admin)
            .await
            .map_err(shard_error)?;
        let result = self
            .ensure_locked(&mut admin, &admin_options, workspace_id, shard, placement)
            .await;
        let _ = sqlx::query("select pg_advisory_unlock(hashtextextended($1, 0))")
            .bind(&lock)
            .execute(&mut admin)
            .await;
        let _ = admin.close().await;
        result
    }

    async fn ensure_locked(
        &self,
        admin: &mut PgConnection,
        admin_options: &PgConnectOptions,
        workspace_id: &str,
        shard: &CnpgShard,
        placement: &Placement,
    ) -> Result<(String, bool), ProvisionError> {
        let powers = admin_powers(admin).await?;
        let role = quoted(&placement.role_name);
        let database = quoted(&placement.database_name);

        let role_exists = exists(
            admin,
            "select exists (select 1 from pg_roles where rolname = $1)",
            &placement.role_name,
        )
        .await?;
        let stored = self.stored_url(workspace_id, shard, placement).await?;
        let new_password = if !role_exists || stored.is_none() {
            let (password, verifier) = new_password()?;
            if role_exists {
                execute(
                    admin,
                    format!("ALTER ROLE {role} WITH LOGIN PASSWORD '{verifier}'"),
                )
                .await?;
            } else {
                if !powers.superuser && powers.server_version >= 160_000 {
                    sqlx::raw_sql("SET createrole_self_grant = 'set, inherit'")
                        .execute(&mut *admin)
                        .await
                        .map_err(shard_error)?;
                }
                execute(
                    admin,
                    format!("CREATE ROLE {role} WITH LOGIN PASSWORD '{verifier}'"),
                )
                .await?;
                if !powers.superuser && powers.server_version < 160_000 {
                    execute(admin, format!("GRANT {role} TO CURRENT_USER")).await?;
                }
            }
            Some(password)
        } else {
            None
        };

        let database_exists = exists(
            admin,
            "select exists (select 1 from pg_database where datname = $1)",
            &placement.database_name,
        )
        .await?;
        if !database_exists {
            let template = self
                .options
                .template
                .as_deref()
                .map(|template| format!(" TEMPLATE {}", quoted(template)))
                .unwrap_or_default();
            execute(
                admin,
                format!("CREATE DATABASE {database} OWNER {role}{template}"),
            )
            .await?;
            execute(
                admin,
                format!("REVOKE ALL ON DATABASE {database} FROM PUBLIC"),
            )
            .await?;
        }
        self.ensure_extensions(admin_options, &placement.database_name)
            .await?;

        let url = if let Some(password) = new_password {
            let url = Self::tenant_url(shard, placement, &password);
            self.store_url(workspace_id, placement, &url).await?;
            url
        } else {
            // No new password means the stored URL matched.
            stored.ok_or_else(|| ProvisionError::Shard("no database URL to use".into()))?
        };
        Ok((url, !database_exists))
    }

    /// Create the configured extensions the database lacks, as the admin.
    async fn ensure_extensions(
        &self,
        admin_options: &PgConnectOptions,
        database: &str,
    ) -> Result<(), ProvisionError> {
        if self.options.extensions.is_empty() {
            return Ok(());
        }
        let mut conn = connect(&admin_options.clone().database(database)).await?;
        let present: Vec<String> = sqlx::query_scalar("select extname::text from pg_extension")
            .fetch_all(&mut conn)
            .await
            .map_err(shard_error)?;
        for extension in &self.options.extensions {
            if !present.contains(extension) {
                execute(
                    &mut conn,
                    format!("CREATE EXTENSION IF NOT EXISTS {}", quoted(extension)),
                )
                .await?;
            }
        }
        let _ = conn.close().await;
        Ok(())
    }

    /// Drop the database and role on the shard, under the database's lock.
    /// Returns whether this call dropped the database.
    async fn drop_database(
        &self,
        shard: &CnpgShard,
        placement: &Placement,
    ) -> Result<bool, ProvisionError> {
        let admin_options = PgConnectOptions::from_str(&shard.admin_url).map_err(shard_error)?;
        let mut admin = connect(&admin_options).await?;
        let lock = format!("weldsuite:provision:{}", placement.database_name);
        sqlx::query("select pg_advisory_lock(hashtextextended($1, 0))")
            .bind(&lock)
            .execute(&mut admin)
            .await
            .map_err(shard_error)?;
        let result = drop_locked(&mut admin, placement).await;
        let _ = sqlx::query("select pg_advisory_unlock(hashtextextended($1, 0))")
            .bind(&lock)
            .execute(&mut admin)
            .await;
        let _ = admin.close().await;
        result
    }
}

async fn admin_powers(admin: &mut PgConnection) -> Result<Admin, ProvisionError> {
    let (superuser, server_version): (bool, i32) = sqlx::query_as(
        "select rolsuper, current_setting('server_version_num')::int
         from pg_roles where rolname = current_user",
    )
    .fetch_one(&mut *admin)
    .await
    .map_err(shard_error)?;
    Ok(Admin {
        superuser,
        server_version,
    })
}

async fn exists(
    conn: &mut PgConnection,
    query: &'static str,
    name: &str,
) -> Result<bool, ProvisionError> {
    sqlx::query_scalar(query)
        .bind(name)
        .fetch_one(&mut *conn)
        .await
        .map_err(shard_error)
}

/// A statement built from checked identifiers and a SCRAM verifier only.
async fn execute(conn: &mut PgConnection, statement: String) -> Result<(), ProvisionError> {
    sqlx::raw_sql(AssertSqlSafe(statement))
        .execute(&mut *conn)
        .await
        .map(|_| ())
        .map_err(shard_error)
}

async fn drop_locked(
    admin: &mut PgConnection,
    placement: &Placement,
) -> Result<bool, ProvisionError> {
    let powers = admin_powers(admin).await?;
    let role = quoted(&placement.role_name);
    let database = quoted(&placement.database_name);
    let role_exists = exists(
        admin,
        "select exists (select 1 from pg_roles where rolname = $1)",
        &placement.role_name,
    )
    .await?;
    let database_exists = exists(
        admin,
        "select exists (select 1 from pg_database where datname = $1)",
        &placement.database_name,
    )
    .await?;
    if database_exists {
        if role_exists && !powers.superuser && powers.server_version < 160_000 {
            execute(admin, format!("GRANT {role} TO CURRENT_USER")).await?;
        }
        execute(
            admin,
            format!("DROP DATABASE IF EXISTS {database} WITH (FORCE)"),
        )
        .await?;
    }
    if role_exists {
        execute(admin, format!("DROP ROLE IF EXISTS {role}")).await?;
    }
    Ok(database_exists)
}

impl DatabaseProvisioner for CnpgProvisioner {
    fn provision<'a>(
        &'a self,
        request: &'a ProvisionRequest,
    ) -> BoxFuture<'a, Result<ProvisionedDatabase, ProvisionError>> {
        Box::pin(async move {
            self.ensure_registered().await?;
            let (shard, placement) = self.place(request).await?;
            let (url, created) = self
                .ensure_database(&request.workspace_id, shard, &placement)
                .await?;
            let outcome = migrate_database(
                &url,
                self.journal,
                DatabaseOptions {
                    apply_skipped: true,
                    check_only: false,
                },
            )
            .await
            .map_err(|error| ProvisionError::Migrations(Box::new(error)))?;
            Ok(ProvisionedDatabase {
                workspace_id: request.workspace_id.clone(),
                placement,
                database_url: DatabaseUrl::new(url),
                created,
                migrations_applied: outcome.applied.len() + outcome.applied_skipped.len(),
                schema_version: outcome
                    .journal_gap
                    .is_none()
                    .then(|| self.journal.latest_tag().map(str::to_owned))
                    .flatten(),
            })
        })
    }

    fn teardown<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Teardown, ProvisionError>> {
        Box::pin(async move {
            let row = self.workspace(workspace_id).await?;
            let Some((shard, placement)) = self.recorded_placement(&row)? else {
                return Ok(Teardown::NothingToDrop);
            };
            if self.drop_database(shard, &placement).await? {
                self.release_capacity(&placement.shard_id).await?;
            }
            sqlx::query(
                "update workspaces
                 set neon_project_id = null, neon_database_name = null, neon_branch_id = null,
                     neon_role_name = null, shared_project_id = null,
                     database_provisioned_at = null, updated_at = timezone('utc', now())
                 where id = $1",
            )
            .bind(workspace_id)
            .execute(&self.master)
            .await
            .map_err(master_error)?;
            // Best effort, as the TypeScript teardown: a pool row that tracked
            // the workspace (none on Kubernetes, which has no warm pool).
            let _ = sqlx::query("delete from database_pool where assigned_workspace_id = $1")
                .bind(workspace_id)
                .execute(&self.master)
                .await;
            Ok(Teardown::Dropped(placement))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_typescript_sanitize() {
        assert_eq!(
            database_names("ws_m1x2k3l4a8b9c0d1").expect("names"),
            (
                "ws_ws_m1x2k3l4a8b9c0d1".to_owned(),
                "role_ws_m1x2k3l4a8b9c0d1".to_owned()
            )
        );
        assert_eq!(sanitize("ws_AB-c.d"), "ws_ab_c_d");
        // One `_` per UTF-16 unit, as `replaceAll(/[^a-z0-9_]/g, '_')` counts.
        assert_eq!(sanitize("é😀"), "___");
        assert!(matches!(
            database_names(&"x".repeat(60)),
            Err(ProvisionError::InvalidWorkspaceId(_))
        ));
        assert!(database_names("").is_err());
    }

    #[test]
    fn the_scram_verifier_has_postgres_shape() {
        let verifier = scram_verifier("pencil", &[7; 16]);
        let (head, keys) = verifier
            .split_once('$')
            .and_then(|(_, rest)| rest.split_once('$'))
            .expect("shape");
        assert_eq!(head, format!("4096:{}", STANDARD.encode([7u8; 16])));
        let (stored, server) = keys.split_once(':').expect("keys");
        assert_eq!(STANDARD.decode(stored).expect("b64").len(), 32);
        assert_eq!(STANDARD.decode(server).expect("b64").len(), 32);
        assert!(verifier.starts_with("SCRAM-SHA-256$4096:"));
        // Deterministic for a salt, different for another.
        assert_eq!(verifier, scram_verifier("pencil", &[7; 16]));
        assert_ne!(verifier, scram_verifier("pencil", &[8; 16]));
    }

    #[test]
    fn reads_the_shard_list_with_defaults() {
        let shards = CnpgShard::parse_list(
            r#"[{"name":"tenants-1","adminUrl":"postgres://tenant:pw@tenants-1-rw:5432/tenants",
                 "poolerHost":"tenants-1-pooler.postgres.svc"}]"#,
        )
        .expect("parses");
        assert_eq!(shards[0].key(), "cnpg:tenants-1");
        assert_eq!(shards[0].pooler_port, 5432);
        assert_eq!(shards[0].url_options, "sslmode=require");
        assert_eq!(shards[0].max_databases, 500);
        assert!(!format!("{:?}", shards[0]).contains("pw@"));
        assert!(
            CnpgShard::parse_list(r#"[{"name":"x","adminUrl":"u","poolerHost":"h","bogus":1}]"#)
                .is_err()
        );
    }

    #[test]
    fn tenant_urls_point_at_the_pooler() {
        let shard = &CnpgShard::parse_list(
            r#"[{"name":"tenants-1","adminUrl":"postgres://a@b/c","poolerHost":"tenants-1-pooler.postgres.svc"}]"#,
        )
        .expect("parses")[0];
        let placement = Placement {
            shard_id: "nsp_1".to_owned(),
            shard_name: "tenants-1".to_owned(),
            database_name: "ws_ws_1".to_owned(),
            role_name: "role_ws_1".to_owned(),
        };
        let url = CnpgProvisioner::tenant_url(shard, &placement, "secret");
        assert_eq!(
            url,
            "postgres://role_ws_1:secret@tenants-1-pooler.postgres.svc:5432/ws_ws_1?sslmode=require"
        );
        assert!(CnpgProvisioner::url_matches(&url, shard, &placement));
        let moved = Placement {
            database_name: "ws_ws_2".to_owned(),
            ..placement
        };
        assert!(!CnpgProvisioner::url_matches(&url, shard, &moved));
    }
}
