//! `weldsuite admin weldpass …`: WeldPass's root keys, across the install's
//! workspaces or for one (weldsuite-documentation `plans/weldpass-eu.md`,
//! step 1.2):
//!
//! - `status [<workspace>]`: how many vault keys each root-key version
//!   wraps, and which keys this process holds. Reads only.
//! - `rewrap [<workspace>] --reason <text>`: rewrites every project and
//!   vault key that isn't under the newest root key
//!   (`weldsuite_pass::rotation::rewrap_all`). The rotation is: set
//!   `WELDPASS_ROOT_KEY_V2` on the server, run this until `status` shows
//!   nothing under v1, keep v2 set from then on.
//! - `backfill-checksums [<workspace>] --reason <text>`: rewrites the
//!   pre-HMAC checksums of every secret (a reveal does it one secret at a
//!   time otherwise).
//!
//! A change is audited per workspace it touched, in `admin_audit_events`.
//! The process needs `WELDPASS_ROOT_KEY` (and `_V2` during a rotation) as
//! the server has them; a server pod does.

use std::fmt::Write as _;

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::orm;
use weldsuite_pass::RootKeyring;
use weldsuite_pass::rotation::{self, KeyCensus};
use weldsuite_schema::master::workspaces;
use weldsuite_staff_domain::access::find_workspace;
use weldsuite_staff_domain::audit::{AuditEntry, record_failure, record_success};
use weldsuite_staff_domain::staff;
use weldsuite_staff_domain::{StaffError, StaffResult};

use crate::admin_outside_eu::tenant_db;

/// One `weldpass` command; `workspace` is `None` for every workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WeldpassCommand {
    Status { workspace: Option<String> },
    Rewrap { workspace: Option<String> },
    BackfillChecksums { workspace: Option<String> },
}

impl WeldpassCommand {
    pub(crate) fn writes(&self) -> bool {
        !matches!(self, Self::Status { .. })
    }

    /// From `weldpass <action> [<workspace>]`.
    pub(crate) fn parse(action: Option<&str>, target: Option<&str>) -> Result<Self, String> {
        let workspace = target.map(str::to_owned);
        match action {
            Some("status") => Ok(Self::Status { workspace }),
            Some("rewrap") => Ok(Self::Rewrap { workspace }),
            Some("backfill-checksums") => Ok(Self::BackfillChecksums { workspace }),
            Some(other) => Err(format!("unknown weldpass action {other}")),
            None => Err("weldpass needs an action: status, rewrap or backfill-checksums".to_owned()),
        }
    }

    fn workspace(&self) -> Option<&str> {
        match self {
            Self::Status { workspace }
            | Self::Rewrap { workspace }
            | Self::BackfillChecksums { workspace } => workspace.as_deref(),
        }
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn root_keys() -> RootKeyring {
    RootKeyring::from_values(
        env("WELDPASS_ROOT_KEY").as_deref(),
        env("WELDPASS_ROOT_KEY_V2").as_deref(),
    )
}

/// The workspaces to work on: the one named, or every live workspace with a
/// database, oldest id first.
async fn targets(master: &PgPool, workspace: Option<&str>) -> StaffResult<Vec<(String, String)>> {
    if let Some(reference) = workspace {
        let found = find_workspace(master, reference).await?;
        if found.deleted {
            return Err(StaffError::Refused(format!(
                "{} ({}) is deleted.",
                found.name, found.id
            )));
        }
        return Ok(vec![(found.id, found.name)]);
    }
    Ok(workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .column(workspaces::Column::Name)
        .filter(workspaces::Column::DeletedAt.is_null())
        .filter(workspaces::Column::DatabaseUrl.is_not_null())
        .order_by_asc(workspaces::Column::Id)
        .into_tuple()
        .all(&orm(master))
        .await?)
}

fn counts(map: &std::collections::BTreeMap<String, u64>) -> String {
    if map.is_empty() {
        return "-".to_owned();
    }
    map.iter()
        .map(|(tag, n)| format!("{tag}:{n}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn census_json(census: &KeyCensus) -> Value {
    json!({ "projects": census.projects, "vaults": census.vaults })
}

/// Which keys this process holds, never their values.
fn keys_line(keys: &RootKeyring) -> String {
    let set = |key: &Option<String>| if key.is_some() { "set" } else { "unset" };
    match rotation::self_check(keys) {
        Ok(version) => format!(
            "Root keys: v1 {}, v2 {}; new keys wrap under {version}.\n",
            set(&keys.v1),
            set(&keys.v2)
        ),
        Err(error) => format!(
            "Root keys: v1 {}, v2 {}; not usable: {error}.\n",
            set(&keys.v1),
            set(&keys.v2)
        ),
    }
}

/// Runs `command`; a change needs `actor` (an active non-viewer staff row)
/// and `reason`.
#[allow(
    clippy::too_many_lines,
    reason = "status, rewrap and backfill, each over the same workspace loop"
)]
pub(crate) async fn execute(
    master: &PgPool,
    command: &WeldpassCommand,
    actor: Option<&str>,
    reason: &str,
    dry_run: bool,
    json: bool,
) -> StaffResult<String> {
    let keys = root_keys();
    let actor = if command.writes() {
        let actor = staff::writer(master, actor.unwrap_or_default()).await?;
        if reason.trim().chars().count() < 3 {
            return Err(StaffError::Refused(
                "--reason is required (at least 3 characters).".to_owned(),
            ));
        }
        if let Err(error) = rotation::self_check(&keys) {
            return Err(StaffError::Refused(format!(
                "WELDPASS_ROOT_KEY (and WELDPASS_ROOT_KEY_V2 during a rotation) must be set as \
                 on the server: {error}"
            )));
        }
        Some(actor)
    } else {
        None
    };
    let targets = targets(master, command.workspace()).await?;

    let mut rows = Vec::new();
    let mut text = keys_line(&keys);
    let mut problems = 0_usize;
    for (id, name) in &targets {
        let db = match tenant_db(master, id).await {
            Ok(db) => db,
            Err(error) => {
                problems += 1;
                let _ = writeln!(text, "{name} ({id}): {error}");
                rows.push(json!({ "workspace": id, "error": error.to_string() }));
                continue;
            }
        };
        match command {
            WeldpassCommand::Status { .. } => match rotation::census(&db).await {
                Ok(census) => {
                    let _ = writeln!(
                        text,
                        "{name} ({id}): projects {}; vaults {}",
                        counts(&census.projects),
                        counts(&census.vaults)
                    );
                    rows.push(json!({ "workspace": id, "name": name, "keys": census_json(&census) }));
                }
                Err(error) => {
                    problems += 1;
                    let _ = writeln!(text, "{name} ({id}): {error}");
                    rows.push(json!({ "workspace": id, "error": error.to_string() }));
                }
            },
            WeldpassCommand::Rewrap { .. } => {
                let outcome = rotation::rewrap_all(&db, &keys, dry_run).await;
                let actor = actor.as_ref().map(|a| a.email.as_str()).unwrap_or_default();
                match outcome {
                    Ok(done) => {
                        let changed = done.projects + done.vaults;
                        let verb = if dry_run { "would rewrap" } else { "rewrapped" };
                        let _ = writeln!(
                            text,
                            "{name} ({id}): {verb} {} project and {} vault keys under {}; {} \
                             already current{}",
                            done.projects,
                            done.vaults,
                            done.version,
                            done.current,
                            if done.failed.is_empty() {
                                String::new()
                            } else {
                                format!("; would not open: {}", done.failed.join(", "))
                            }
                        );
                        problems += done.failed.len();
                        let details = json!({
                            "version": done.version,
                            "projects": done.projects,
                            "vaults": done.vaults,
                            "current": done.current,
                            "failed": done.failed,
                        });
                        if changed > 0 && !dry_run {
                            let entry = AuditEntry {
                                workspace_id: Some(id),
                                target_type: "workspace",
                                target_id: id,
                                action: "workspace.weldpass.rewrap",
                                actor_email: actor,
                                reason: Some(reason),
                                details: Some(details.clone()),
                            };
                            record_success(&orm(master), &entry).await?;
                        }
                        rows.push(json!({ "workspace": id, "name": name, "result": details }));
                    }
                    Err(error) => {
                        problems += 1;
                        let entry = AuditEntry {
                            workspace_id: Some(id),
                            target_type: "workspace",
                            target_id: id,
                            action: "workspace.weldpass.rewrap",
                            actor_email: actor,
                            reason: Some(reason),
                            details: None,
                        };
                        if !dry_run {
                            record_failure(master, &entry, &error.to_string()).await;
                        }
                        let _ = writeln!(text, "{name} ({id}): {error}");
                        rows.push(json!({ "workspace": id, "error": error.to_string() }));
                    }
                }
            }
            WeldpassCommand::BackfillChecksums { .. } => {
                if dry_run {
                    match rotation::census(&db).await {
                        Ok(census) => {
                            let projects: u64 = census.projects.values().sum();
                            let _ = writeln!(
                                text,
                                "{name} ({id}): would backfill the checksums of {projects} \
                                 secrets projects"
                            );
                            rows.push(json!({ "workspace": id, "name": name, "projects": projects }));
                        }
                        Err(error) => {
                            problems += 1;
                            let _ = writeln!(text, "{name} ({id}): {error}");
                            rows.push(json!({ "workspace": id, "error": error.to_string() }));
                        }
                    }
                    continue;
                }
                let actor = actor.as_ref().map(|a| a.email.as_str()).unwrap_or_default();
                let entry = |details: Option<Value>| AuditEntry {
                    workspace_id: Some(id),
                    target_type: "workspace",
                    target_id: id,
                    action: "workspace.weldpass.backfill_checksums",
                    actor_email: actor,
                    reason: Some(reason),
                    details,
                };
                match rotation::backfill_all_checksums(&db, &keys).await {
                    Ok(done) => {
                        let _ = writeln!(
                            text,
                            "{name} ({id}): {} secrets and {} history rows rewritten; {} would \
                             not open",
                            done.secrets, done.versions, done.failed
                        );
                        problems += usize::try_from(done.failed).unwrap_or(usize::MAX);
                        let details = json!({
                            "secrets": done.secrets,
                            "versions": done.versions,
                            "failed": done.failed,
                        });
                        if done.secrets + done.versions > 0 {
                            record_success(&orm(master), &entry(Some(details.clone()))).await?;
                        }
                        rows.push(json!({ "workspace": id, "name": name, "result": details }));
                    }
                    Err(error) => {
                        problems += 1;
                        record_failure(master, &entry(None), &error.to_string()).await;
                        let _ = writeln!(text, "{name} ({id}): {error}");
                        rows.push(json!({ "workspace": id, "error": error.to_string() }));
                    }
                }
            }
        }
    }
    if targets.is_empty() {
        text.push_str("No workspace with a database.\n");
    }
    if problems > 0 && !json {
        let _ = writeln!(text, "{problems} problem(s); see above.");
    }
    Ok(if json {
        let mut out = serde_json::to_string_pretty(&json!({
            "dryRun": dry_run,
            "workspaces": rows,
            "problems": problems,
        }))
        .unwrap_or_default();
        out.push('\n');
        out
    } else {
        text
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_actions() {
        assert_eq!(
            WeldpassCommand::parse(Some("status"), None),
            Ok(WeldpassCommand::Status { workspace: None })
        );
        assert_eq!(
            WeldpassCommand::parse(Some("rewrap"), Some("acme")),
            Ok(WeldpassCommand::Rewrap {
                workspace: Some("acme".to_owned())
            })
        );
        assert_eq!(
            WeldpassCommand::parse(Some("backfill-checksums"), None),
            Ok(WeldpassCommand::BackfillChecksums { workspace: None })
        );
        assert!(WeldpassCommand::parse(Some("rotate"), None).is_err());
        assert!(WeldpassCommand::parse(None, None).is_err());
    }

    #[test]
    fn only_status_reads() {
        assert!(!WeldpassCommand::Status { workspace: None }.writes());
        assert!(WeldpassCommand::Rewrap { workspace: None }.writes());
        assert!(WeldpassCommand::BackfillChecksums { workspace: None }.writes());
    }

    #[test]
    fn counts_read_per_version() {
        let mut map = std::collections::BTreeMap::new();
        assert_eq!(counts(&map), "-");
        map.insert("v1".to_owned(), 2);
        map.insert("v2".to_owned(), 5);
        assert_eq!(counts(&map), "v1:2 v2:5");
    }

    #[test]
    fn the_keys_line_names_no_value() {
        let key = "ab".repeat(32);
        let line = keys_line(&RootKeyring::from_values(Some(&key), None));
        assert_eq!(line, "Root keys: v1 set, v2 unset; new keys wrap under v1.\n");
        assert!(!line.contains(&key));
        assert!(keys_line(&RootKeyring::default()).contains("not usable"));
    }
}
