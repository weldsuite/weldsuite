//! `weldsuite admin outside-eu …`: a workspace's services outside the EU
//! (ADR OPS-026), audited in `admin_audit_events` like the rest of
//! `weldsuite admin` (ADR SEC-014):
//!
//! - `list <workspace>`: every service, on or off, and who switched it.
//! - `on <workspace> --service <ids> --reason <text> [--via staff|move]`:
//!   switches services on for the workspace. `--via move` records an
//!   integration the workspace had connected on Global before it moved
//!   (ADR OPS-025, decision 6); the move tool may call
//!   `weldsuite_outside_eu::store::set` itself instead.
//! - `off <workspace> --service <ids> --reason <text>`: switches them off;
//!   the backend stops calling them at once.
//!
//! `<ids>` is one service id or several, comma separated (`telnyx,google`).
//! The switch lives in the workspace's own database, so the change and its
//! audit row are two writes: the switch first, then the row (a failed row is
//! reported, the switch stays). A workspace admin's own acknowledgement is
//! not recorded for a staff switch (`acknowledgedAt` stays empty).

use std::fmt::Write as _;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::{Keyring, WorkspaceConfig, Workspaces};
use weldsuite_outside_eu::store::{self, Change, OptIn, Via};
use weldsuite_outside_eu::{SERVICES, ServiceId};
use weldsuite_staff_domain::access::find_workspace;
use weldsuite_staff_domain::audit::{AuditEntry, record_failure, record_success};
use weldsuite_staff_domain::staff;
use weldsuite_staff_domain::{StaffError, StaffResult};

/// One `outside-eu` command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OutsideEuCommand {
    List {
        workspace: String,
    },
    Switch {
        workspace: String,
        services: Vec<ServiceId>,
        enabled: bool,
        via: Via,
    },
}

impl OutsideEuCommand {
    pub(crate) fn writes(&self) -> bool {
        matches!(self, Self::Switch { .. })
    }

    /// From `outside-eu <action> <workspace>` and the flags the parser left.
    pub(crate) fn parse(
        action: Option<&str>,
        target: Option<&str>,
        take: &mut dyn FnMut(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let workspace = || {
            target
                .map(str::to_owned)
                .ok_or_else(|| "name the workspace".to_owned())
        };
        let enabled = match action {
            Some("list") => {
                return Ok(Self::List {
                    workspace: workspace()?,
                });
            }
            Some("on") => true,
            Some("off") => false,
            Some(other) => return Err(format!("unknown outside-eu action {other}")),
            None => return Err("outside-eu needs an action: list, on or off".to_owned()),
        };
        let raw = take("--service").ok_or("name the services: --service <id>[,<id>…]")?;
        let mut services = Vec::new();
        for id in raw.split(',').map(str::trim).filter(|id| !id.is_empty()) {
            let service = ServiceId::parse(id).ok_or_else(|| {
                format!(
                    "unknown service {id}; one of {}",
                    SERVICES
                        .iter()
                        .map(|s| s.id.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;
            if !services.contains(&service) {
                services.push(service);
            }
        }
        if services.is_empty() {
            return Err("name the services: --service <id>[,<id>…]".to_owned());
        }
        let via = match take("--via") {
            None => Via::Staff,
            Some(raw) if enabled => match Via::parse(&raw) {
                Some(via @ (Via::Staff | Via::Move)) => via,
                _ => return Err("--via is staff or move".to_owned()),
            },
            Some(_) => return Err("--via applies to on only".to_owned()),
        };
        Ok(Self::Switch {
            workspace: workspace()?,
            services,
            enabled,
            via,
        })
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// The workspace's own database, opened with the install's keys.
async fn tenant_db(master: &PgPool, workspace_id: &str) -> StaffResult<PgPool> {
    let keyring = Keyring {
        v1: env("DATABASE_ENCRYPTION_KEY"),
        v2: env("DATABASE_ENCRYPTION_KEY_V2"),
    };
    let workspaces = Workspaces::new(master.clone(), keyring, WorkspaceConfig::default());
    workspaces
        .tenant(workspace_id)
        .await
        .map(|tenant| tenant.db)
        .map_err(|error| {
            StaffError::Refused(format!(
                "Cannot open the workspace's database ({error}); DATABASE_ENCRYPTION_KEY and \
                 DATABASE_ENCRYPTION_KEY_V2 must be set as on the server."
            ))
        })
}

/// A failed read or write of the switch, for the person at the terminal.
fn switch_error(error: impl std::fmt::Display) -> StaffError {
    StaffError::Refused(format!(
        "The workspace's switches could not be read or saved: {error}"
    ))
}

fn opt_in_json(service: ServiceId, opt_in: Option<&OptIn>) -> Value {
    let opt_in = opt_in.cloned().unwrap_or_default();
    json!({
        "service": service,
        "name": service.service().name,
        "company": service.service().company,
        "country": service.service().country,
        "enabled": opt_in.enabled,
        "via": opt_in.via,
        "enabledBy": opt_in.enabled_by,
        "enabledAt": opt_in.enabled_at,
        "acknowledgedAt": opt_in.acknowledged_at,
        "disabledBy": opt_in.disabled_by,
        "disabledAt": opt_in.disabled_at,
        "reason": opt_in.reason,
    })
}

fn pretty(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    text
}

/// The list as a table: id, on/off, how and when.
fn table(rows: &[Value]) -> String {
    let mut out = format!(
        "{:<12} {:<4} {:<6} {:<26} {}\n",
        "SERVICE", "ON", "VIA", "SINCE", "BY"
    );
    for row in rows {
        let on = row["enabled"].as_bool().unwrap_or(false);
        let since = if on {
            row["enabledAt"].as_str()
        } else {
            row["disabledAt"].as_str()
        };
        let by = if on {
            row["enabledBy"].as_str()
        } else {
            row["disabledBy"].as_str()
        };
        let _ = writeln!(
            out,
            "{:<12} {:<4} {:<6} {:<26} {}",
            row["service"].as_str().unwrap_or_default(),
            if on { "yes" } else { "no" },
            row["via"].as_str().unwrap_or("-"),
            since.unwrap_or("-"),
            by.unwrap_or("-"),
        );
    }
    out
}

/// Runs `command`; a switch needs `actor` (an active non-viewer staff row)
/// and `reason`.
#[allow(clippy::too_many_lines, reason = "the list and the switch, each whole")]
pub(crate) async fn execute(
    master: &PgPool,
    command: &OutsideEuCommand,
    actor: Option<&str>,
    reason: &str,
    dry_run: bool,
    json: bool,
) -> StaffResult<String> {
    match command {
        OutsideEuCommand::List { workspace } => {
            let found = find_workspace(master, workspace).await?;
            let db = tenant_db(master, &found.id).await?;
            let opt_ins = store::read(&db).await.map_err(switch_error)?;
            let rows: Vec<Value> = SERVICES
                .iter()
                .map(|s| opt_in_json(s.id, opt_ins.get(&s.id)))
                .collect();
            Ok(if json {
                pretty(&json!({ "workspace": found.id, "name": found.name, "services": rows }))
            } else {
                format!("{} ({})\n{}", found.name, found.id, table(&rows))
            })
        }
        OutsideEuCommand::Switch {
            workspace,
            services,
            enabled,
            via,
        } => {
            let actor = staff::writer(master, actor.unwrap_or_default()).await?;
            if reason.trim().chars().count() < 3 {
                return Err(StaffError::Refused(
                    "--reason is required (at least 3 characters).".to_owned(),
                ));
            }
            let found = find_workspace(master, workspace).await?;
            if found.deleted {
                return Err(StaffError::Refused(format!(
                    "{} ({}) is deleted.",
                    found.name, found.id
                )));
            }
            let word = if *enabled { "on" } else { "off" };
            let names: Vec<&str> = services.iter().map(|s| s.as_str()).collect();
            if dry_run {
                return Ok(format!(
                    "Would switch {} {word} for {} ({}), via {}.\n",
                    names.join(", "),
                    found.name,
                    found.id,
                    via.as_str()
                ));
            }
            let db = tenant_db(master, &found.id).await?;
            let at = weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc());
            let action = if *enabled {
                "workspace.outside_eu.enable"
            } else {
                "workspace.outside_eu.disable"
            };
            let mut changed = Vec::new();
            for service in services {
                let details = json!({ "service": service, "via": via });
                let entry = AuditEntry {
                    workspace_id: Some(&found.id),
                    target_type: "workspace",
                    target_id: &found.id,
                    action,
                    actor_email: &actor.email,
                    reason: Some(reason),
                    details: Some(details),
                };
                let change = Change {
                    service: *service,
                    enabled: *enabled,
                    actor: &actor.email,
                    via: *via,
                    acknowledged: false,
                    reason: Some(reason),
                    at: &at,
                };
                match store::set(&db, &change).await {
                    Ok((before, after)) => {
                        if before != after {
                            record_success(master, &entry).await?;
                            changed.push(service.as_str());
                        }
                    }
                    Err(error) => {
                        record_failure(master, &entry, &error.to_string()).await;
                        return Err(switch_error(error));
                    }
                }
            }
            Ok(if json {
                pretty(&json!({
                    "workspace": found.id,
                    "enabled": enabled,
                    "via": via,
                    "changed": changed,
                }))
            } else if changed.is_empty() {
                format!(
                    "{} was already {word} for {} ({}).\n",
                    names.join(", "),
                    found.name,
                    found.id
                )
            } else {
                format!(
                    "Switched {} {word} for {} ({}).\n",
                    changed.join(", "),
                    found.name,
                    found.id
                )
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(
        action: &str,
        target: Option<&str>,
        flags: &[(&str, &str)],
    ) -> Result<OutsideEuCommand, String> {
        let mut flags: Vec<(String, String)> = flags
            .iter()
            .map(|(f, v)| ((*f).to_owned(), (*v).to_owned()))
            .collect();
        let mut take = |flag: &str| {
            flags
                .iter()
                .position(|(f, _)| f == flag)
                .map(|i| flags.remove(i).1)
        };
        OutsideEuCommand::parse(Some(action), target, &mut take)
    }

    #[test]
    fn parses_the_actions() {
        assert_eq!(
            parse("list", Some("acme"), &[]),
            Ok(OutsideEuCommand::List {
                workspace: "acme".to_owned()
            })
        );
        assert_eq!(
            parse(
                "on",
                Some("acme"),
                &[("--service", "telnyx, google,telnyx"), ("--via", "move")]
            ),
            Ok(OutsideEuCommand::Switch {
                workspace: "acme".to_owned(),
                services: vec![ServiceId::Telnyx, ServiceId::Google],
                enabled: true,
                via: Via::Move,
            })
        );
        assert_eq!(
            parse("off", Some("acme"), &[("--service", "slack")]),
            Ok(OutsideEuCommand::Switch {
                workspace: "acme".to_owned(),
                services: vec![ServiceId::Slack],
                enabled: false,
                via: Via::Staff,
            })
        );
    }

    #[test]
    fn refuses_what_it_cannot_do() {
        assert!(parse("on", Some("acme"), &[]).is_err());
        assert!(parse("on", Some("acme"), &[("--service", "mistral")]).is_err());
        assert!(parse("on", Some("acme"), &[("--service", ",")]).is_err());
        assert!(parse("on", None, &[("--service", "telnyx")]).is_err());
        assert!(
            parse(
                "on",
                Some("acme"),
                &[("--service", "telnyx"), ("--via", "admin")]
            )
            .is_err()
        );
        assert!(
            parse(
                "off",
                Some("acme"),
                &[("--service", "telnyx"), ("--via", "move")]
            )
            .is_err()
        );
        assert!(parse("flip", Some("acme"), &[]).is_err());
    }

    #[test]
    fn the_table_shows_each_service() {
        let on = OptIn {
            enabled: true,
            via: Some(Via::Move),
            enabled_by: Some("staff@weldsuite.org".to_owned()),
            enabled_at: Some("2026-11-20T10:00:00.000Z".to_owned()),
            ..OptIn::default()
        };
        let text = table(&[
            opt_in_json(ServiceId::Telnyx, Some(&on)),
            opt_in_json(ServiceId::Slack, None),
        ]);
        assert!(
            text.contains(
                "telnyx       yes  move   2026-11-20T10:00:00.000Z   staff@weldsuite.org"
            )
        );
        assert!(text.contains("slack        no   -"));
    }
}
