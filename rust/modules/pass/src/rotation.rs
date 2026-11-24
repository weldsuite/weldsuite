//! Root-key rotation and the checksum backfill, run by `weldsuite admin
//! weldpass` (weldsuite-documentation `plans/weldpass-eu.md`, step 1.2).
//!
//! A rotation: set `WELDPASS_ROOT_KEY_V2` beside `WELDPASS_ROOT_KEY` on the
//! server (new vaults then wrap under v2) and run `rewrap` until `status`
//! shows nothing left under v1. The v2 key then stays in the v2 slot: its
//! blobs are tagged `v2`. Only the KEK rows change (`weldpass_projects`,
//! `weldpass_vaults`, soft-deleted rows included, so a restore still opens);
//! no secret, DEK or item is touched (ADR PASS-001).

use std::collections::BTreeMap;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect, sea_query::Expr};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{weldpass_projects as projects, weldpass_vaults as vaults};

use crate::envelope::{
    EnvelopeError, RootKeyring, create_vault_key, rewrap_vault_key, unwrap_vault_key, version_of,
};
use crate::secrets::{Backfilled, backfill_checksums};

/// The tag a census gives a wrapped key it can't read.
pub const UNREADABLE: &str = "unreadable";

/// How many vault keys each root-key version wraps, by the tag on the
/// wrapped value (not the `root_key_version` column, which only says what
/// the row was written with).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct KeyCensus {
    /// Secret vaults (`weldpass_projects`).
    pub projects: BTreeMap<String, u64>,
    /// Password vaults (`weldpass_vaults`).
    pub vaults: BTreeMap<String, u64>,
}

impl KeyCensus {
    /// Rows not wrapped under `version`.
    pub fn outside(&self, version: &str) -> u64 {
        let count = |map: &BTreeMap<String, u64>| {
            map.iter()
                .filter(|(tag, _)| tag.as_str() != version)
                .map(|(_, n)| n)
                .sum::<u64>()
        };
        count(&self.projects) + count(&self.vaults)
    }

    /// Every row counted.
    pub fn total(&self) -> u64 {
        self.projects.values().sum::<u64>() + self.vaults.values().sum::<u64>()
    }
}

/// What [`rewrap_all`] did (or, in a dry run, would do).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Rewrapped {
    /// Project KEKs rewritten under the newest root key.
    pub projects: u64,
    /// Vault KEKs rewritten under the newest root key.
    pub vaults: u64,
    /// Already under the newest root key.
    pub current: u64,
    /// Rows that would not open (`projects:<id>` / `vaults:<id>`). Their
    /// root key is missing or the row was tampered with; they stay as they
    /// are.
    pub failed: Vec<String>,
    /// The version everything was rewrapped to.
    pub version: &'static str,
}

/// The root keys work: the newest one is configured, 64 hex characters, and
/// wraps and opens a throwaway vault key. `weldsuite doctor` and the
/// server's start-up check use it. Answers the newest version.
pub fn self_check(keyring: &RootKeyring) -> Result<&'static str, EnvelopeError> {
    let version = keyring.current_version()?;
    let wrapped = create_vault_key(keyring, "self-check")?;
    unwrap_vault_key(keyring, "self-check", &wrapped.kek_wrapped)?;
    // An older key that is set must be well formed too: a typo there only
    // shows when an old vault is opened.
    if version == "v2" && keyring.v1.as_deref().is_some_and(|key| !key.is_empty()) {
        let v1_only = RootKeyring::from_values(keyring.v1.as_deref(), None);
        let wrapped = create_vault_key(&v1_only, "self-check")?;
        unwrap_vault_key(&v1_only, "self-check", &wrapped.kek_wrapped)?;
    }
    Ok(version)
}

fn tag_of(kek_wrapped: &str) -> String {
    version_of(kek_wrapped).unwrap_or_else(|_| UNREADABLE.to_owned())
}

async fn project_keys(db: &PgPool) -> Result<Vec<(String, String)>, DbErr> {
    projects::Entity::find()
        .select_only()
        .column(projects::Column::Id)
        .column(projects::Column::KekWrapped)
        .into_tuple()
        .all(&orm(db))
        .await
}

async fn vault_keys(db: &PgPool) -> Result<Vec<(String, String)>, DbErr> {
    vaults::Entity::find()
        .select_only()
        .column(vaults::Column::Id)
        .column(vaults::Column::KekWrapped)
        .into_tuple()
        .all(&orm(db))
        .await
}

/// Counts one workspace's vault keys per root-key version. Reads only.
pub async fn census(db: &PgPool) -> Result<KeyCensus, DbErr> {
    let mut census = KeyCensus::default();
    for (_, wrapped) in project_keys(db).await? {
        *census.projects.entry(tag_of(&wrapped)).or_default() += 1;
    }
    for (_, wrapped) in vault_keys(db).await? {
        *census.vaults.entry(tag_of(&wrapped)).or_default() += 1;
    }
    Ok(census)
}

/// Rewrites every project and vault KEK of one workspace that isn't under
/// the newest root key. Idempotent. Each row is updated only if it still
/// holds the value that was read, so a vault created meanwhile is left to
/// its own (already current) key. `dry_run` opens each key but writes
/// nothing.
pub async fn rewrap_all(
    db: &PgPool,
    keyring: &RootKeyring,
    dry_run: bool,
) -> Result<Rewrapped, RotationError> {
    let version = keyring.current_version()?;
    let mut result = Rewrapped {
        version,
        ..Rewrapped::default()
    };
    for (id, wrapped) in project_keys(db).await? {
        if tag_of(&wrapped) == version {
            result.current += 1;
            continue;
        }
        match rewrap_vault_key(keyring, &id, &wrapped) {
            Ok(_) if dry_run => result.projects += 1,
            Ok(new) => {
                let updated = projects::Entity::update_many()
                    .col_expr(projects::Column::KekWrapped, Expr::value(new.kek_wrapped))
                    .col_expr(
                        projects::Column::RootKeyVersion,
                        Expr::value(new.root_key_version.to_owned()),
                    )
                    .filter(projects::Column::Id.eq(&id))
                    .filter(projects::Column::KekWrapped.eq(&wrapped))
                    .exec(&orm(db))
                    .await?;
                result.projects += updated.rows_affected;
            }
            Err(_) => result.failed.push(format!("projects:{id}")),
        }
    }
    for (id, wrapped) in vault_keys(db).await? {
        if tag_of(&wrapped) == version {
            result.current += 1;
            continue;
        }
        match rewrap_vault_key(keyring, &id, &wrapped) {
            Ok(_) if dry_run => result.vaults += 1,
            Ok(new) => {
                let updated = vaults::Entity::update_many()
                    .col_expr(vaults::Column::KekWrapped, Expr::value(new.kek_wrapped))
                    .col_expr(
                        vaults::Column::RootKeyVersion,
                        Expr::value(new.root_key_version.to_owned()),
                    )
                    .filter(vaults::Column::Id.eq(&id))
                    .filter(vaults::Column::KekWrapped.eq(&wrapped))
                    .exec(&orm(db))
                    .await?;
                result.vaults += updated.rows_affected;
            }
            Err(_) => result.failed.push(format!("vaults:{id}")),
        }
    }
    Ok(result)
}

/// [`backfill_checksums`] for every secrets project of one workspace,
/// soft-deleted ones included. A project whose key won't open is counted in
/// `failed`, its secrets untouched.
pub async fn backfill_all_checksums(
    db: &PgPool,
    keyring: &RootKeyring,
) -> Result<Backfilled, RotationError> {
    let mut total = Backfilled::default();
    for (id, wrapped) in project_keys(db).await? {
        let Ok(kek) = unwrap_vault_key(keyring, &id, &wrapped) else {
            total.failed += 1;
            continue;
        };
        let done = backfill_checksums(db, &kek, &id).await?;
        total.secrets += done.secrets;
        total.versions += done.versions;
        total.failed += done.failed;
    }
    Ok(total)
}

/// A rotation step that could not run at all (as opposed to a row that
/// would not open, which is counted).
#[derive(Debug)]
pub enum RotationError {
    /// No usable root key on this process.
    Keys(EnvelopeError),
    /// The workspace's database.
    Db(DbErr),
}

impl std::fmt::Display for RotationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Keys(error) => write!(f, "{error}"),
            Self::Db(error) => write!(f, "database: {error}"),
        }
    }
}

impl std::error::Error for RotationError {}

impl From<EnvelopeError> for RotationError {
    fn from(error: EnvelopeError) -> Self {
        Self::Keys(error)
    }
}

impl From<DbErr> for RotationError {
    fn from(error: DbErr) -> Self {
        Self::Db(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const V1: &str = "abababababababababababababababababababababababababababababababab";
    const V2: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

    #[test]
    fn self_check_names_the_newest_key() {
        assert_eq!(
            self_check(&RootKeyring::from_values(Some(V1), None)).ok(),
            Some("v1")
        );
        assert_eq!(
            self_check(&RootKeyring::from_values(Some(V1), Some(V2))).ok(),
            Some("v2")
        );
    }

    #[test]
    fn self_check_refuses_a_missing_or_malformed_key() {
        assert!(self_check(&RootKeyring::default()).is_err());
        assert!(self_check(&RootKeyring::from_values(Some("abcd"), None)).is_err());
        // A malformed v1 beside a good v2 would only fail on an old vault.
        assert!(self_check(&RootKeyring::from_values(Some("abcd"), Some(V2))).is_err());
        assert!(self_check(&RootKeyring::from_values(Some(""), Some(V2))).is_ok());
    }

    #[test]
    fn census_counts_what_is_outside_a_version() {
        let mut census = KeyCensus::default();
        census.projects.insert("v1".to_owned(), 2);
        census.projects.insert("v2".to_owned(), 1);
        census.vaults.insert("v1".to_owned(), 3);
        census.vaults.insert(UNREADABLE.to_owned(), 1);
        assert_eq!(census.total(), 7);
        assert_eq!(census.outside("v2"), 6);
        assert_eq!(census.outside("v1"), 2);
    }

    #[test]
    fn tags_come_from_the_wrapped_value() {
        let keyring = RootKeyring::from_values(Some(V1), Some(V2));
        let wrapped = create_vault_key(&keyring, "wpp_1").expect("wrapped");
        assert_eq!(tag_of(&wrapped.kek_wrapped), "v2");
        assert_eq!(tag_of("garbage"), UNREADABLE);
    }
}
