//! `weldsuite admin`: staff work on the Kubernetes editions (ADR SEC-014),
//! what the admin console (`apps/web/admin`) does on Global. Run in a server
//! pod, which has the database settings:
//!
//! ```text
//! kubectl -n weldsuite exec deploy/weldsuite -- weldsuite admin access list --status requested
//! ```
//!
//! Access to it is access to the cluster's API. Every change names the
//! person acting (`--as`, an active non-viewer row of master `admin_users`)
//! and a reason, and is recorded in `admin_audit_events`. The rules and the
//! writes are in `weldsuite-staff-domain`; this file only parses arguments
//! and prints.

use std::fmt::Write as _;
use std::process::ExitCode;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_adapters_oss::SmtpMail;
use weldsuite_db::{Keyring, WorkspaceConfig, Workspaces};
use weldsuite_ports::DynSystemMail;
use weldsuite_reach_domain::schemas::{Limits, WELDREACH_APP_CODE};
use weldsuite_staff_domain::access::{
    self, AccessAction, AccessDetail, AccessFilter, AccessSummary, Decision, DecisionOutcome,
    Effects, LimitsChange, LimitsPatch, LimitsRequest, STATUSES,
};
use weldsuite_staff_domain::staff::{self, Actor, NewStaff, RosterChange, StaffMember, StaffRole};
use weldsuite_staff_domain::{StaffError, StaffResult};

pub(crate) const USAGE: &str = "\
usage: weldsuite admin <area> <action> [options]

Staff work on this install's master database (ADR SEC-014). Run it in a
server pod, which has the database settings:

  kubectl -n weldsuite exec deploy/weldsuite -- weldsuite admin access list

Every change needs --reason and the person acting, --as <email> (or
WELDSUITE_ACTOR): an active, non-viewer row of admin_users. Each change is
recorded in admin_audit_events. --dry-run checks a change and shows it
without writing.

  access list [--status <status>] [--app <code>] [--search <text>]
        access to apps on request only; --status requested lists the open
        requests, oldest first
  access show <workspace> [--app <code>]
  access approve|reject|suspend|unsuspend|revoke <workspace> --reason <text>
        approve also installs the app in the workspace and emails the
        requester; reject emails them the reason; suspend shows the reason
        to the workspace
  access limits <workspace> --reason <text> [--max-domains <n>]
        [--max-mailboxes <n>] [--max-daily-sends <n>]
        [--consumer-recipients on|off] [--allow-domains <list>]
        WeldReach's limits; only the ones named change. --allow-domains
        replaces the list (comma separated; \"\" clears it)
  staff list
  staff add <email> --role superadmin|admin|viewer [--name <text>] --reason <text>
        a superadmin only; the first one without --as, while the list is empty
  staff remove <email> --reason <text>
  billing show <workspace>
        plan, seats, period, the Mollie account, the latest charges and
        invoices (plan billing on Mollie, ADR BILL-014)
  billing comp <workspace> [--plan <id|slug>] [--seats <n>]
        [--until <YYYY-MM-DD>|none] --reason <text>
        a complimentary plan: nothing is charged, the plan's credits still
        come; the renewal job ends it on --until
  billing uncomp <workspace> --reason <text>
        ends the comp now; without a paid subscription the workspace goes
        to Free
  billing refund <bpy_…|tr_…> [--amount <cents>] --reason <text>
        refunds a paid charge through Mollie (in full by default); make the
        credit note in WeldBooks, in the issuer workspace
  billing retry-now <workspace> --reason <text>
        charges a past-due workspace's open charge on its mandate again

<workspace> is its id, slug or organization id. --app defaults to weldreach.

options:
  --as <email>      who is acting (or WELDSUITE_ACTOR)
  --reason <text>   why, at least 3 characters
  --dry-run         check and show the change; write nothing
  --json            print JSON
  -h, --help        print this message

environment: DATABASE_URL_MASTER; DATABASE_ENCRYPTION_KEY and
DATABASE_ENCRYPTION_KEY_V2 to install an approved app in the workspace;
SMTP_URL and SYSTEM_EMAIL_FROM for the requester's email, PLATFORM_URL for
its links. Without them that step is skipped with a warning.

Exit status: 0 done, 1 refused or failed, 2 bad arguments, 78 when
DATABASE_URL_MASTER is missing.";

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    AccessList {
        status: Option<String>,
        app: Option<String>,
        search: Option<String>,
    },
    AccessShow {
        workspace: String,
        app: String,
    },
    AccessDecide {
        workspace: String,
        app: String,
        action: AccessAction,
    },
    AccessLimits {
        workspace: String,
        app: String,
        patch: Patch,
    },
    StaffList,
    StaffAdd {
        email: String,
        role: StaffRole,
        name: Option<String>,
    },
    StaffRemove {
        email: String,
    },
    /// `billing …` (`crate::admin_billing`).
    Billing(crate::admin_billing::BillingCommand),
}

/// [`LimitsPatch`] with `PartialEq`, for the parser's tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Patch {
    max_domains: Option<String>,
    max_mailboxes: Option<String>,
    max_daily_sends: Option<String>,
    consumer_recipients: Option<bool>,
    allow_domains: Option<String>,
}

impl Patch {
    fn to_limits_patch(&self) -> LimitsPatch {
        LimitsPatch {
            max_domains: self.max_domains.clone(),
            max_mailboxes: self.max_mailboxes.clone(),
            max_daily_sends: self.max_daily_sends.clone(),
            allow_consumer_recipients: self.consumer_recipients,
            force_allow_domains: self.allow_domains.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Options {
    command: Command,
    actor: Option<String>,
    reason: String,
    dry_run: bool,
    json: bool,
}

impl Options {
    fn writes(&self) -> bool {
        match &self.command {
            Command::Billing(billing) => billing.writes(),
            command => !matches!(
                command,
                Command::AccessList { .. } | Command::AccessShow { .. } | Command::StaffList
            ),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Parsed {
    Run(Box<Options>),
    Help,
}

/// Flags that take a value.
const VALUE_FLAGS: &[&str] = &[
    "--as",
    "--reason",
    "--app",
    "--status",
    "--search",
    "--role",
    "--name",
    "--max-domains",
    "--max-mailboxes",
    "--max-daily-sends",
    "--consumer-recipients",
    "--allow-domains",
    "--plan",
    "--seats",
    "--until",
    "--amount",
];

/// The words after `admin`: positionals and flags (`--flag value` or
/// `--flag=value`). `actor_env` is `WELDSUITE_ACTOR`.
#[allow(
    clippy::too_many_lines,
    reason = "one arm per area and action, each checking its own arguments"
)]
fn parse(args: &[String], actor_env: Option<String>) -> Result<Parsed, String> {
    let mut words = Vec::new();
    let mut flags: Vec<(String, String)> = Vec::new();
    let mut dry_run = false;
    let mut json = false;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        match name {
            "-h" | "--help" => return Ok(Parsed::Help),
            "--dry-run" => dry_run = true,
            "--json" => json = true,
            flag if VALUE_FLAGS.contains(&flag) => {
                let value = match inline {
                    Some(value) => value,
                    None => args
                        .next()
                        .filter(|v| !v.starts_with("--"))
                        .cloned()
                        .ok_or_else(|| format!("{flag} needs a value"))?,
                };
                if flags.iter().any(|(f, _)| f == flag) {
                    return Err(format!("{flag} is given twice"));
                }
                flags.push((flag.to_owned(), value));
            }
            other if other.starts_with('-') => return Err(format!("unknown option {other}")),
            word => words.push(word.to_owned()),
        }
    }
    let mut take = |flag: &str| {
        flags
            .iter()
            .position(|(f, _)| f == flag)
            .map(|index| flags.remove(index).1)
    };
    let actor = take("--as").or(actor_env).filter(|a| !a.trim().is_empty());
    let reason = take("--reason").unwrap_or_default();
    let app_flag = take("--app");
    let app = app_flag
        .clone()
        .unwrap_or_else(|| WELDREACH_APP_CODE.to_owned());
    let target = |what: &str| {
        words
            .get(2)
            .cloned()
            .ok_or_else(|| format!("name the {what}"))
    };

    let area = words.first().map(String::as_str);
    let action = words.get(1).map(String::as_str);
    let command = match (area, action) {
        (Some("access"), Some("list")) => {
            let status = take("--status");
            if let Some(status) = &status
                && !STATUSES.contains(&status.as_str())
            {
                return Err(format!("--status is one of {}", STATUSES.join(", ")));
            }
            Command::AccessList {
                status,
                app: app_flag,
                search: take("--search"),
            }
        }
        (Some("access"), Some("show")) => Command::AccessShow {
            workspace: target("workspace")?,
            app,
        },
        (Some("access"), Some("limits")) => {
            let consumer = take("--consumer-recipients")
                .map(|v| match v.as_str() {
                    "on" | "true" | "yes" => Ok(true),
                    "off" | "false" | "no" => Ok(false),
                    _ => Err("--consumer-recipients is on or off".to_owned()),
                })
                .transpose()?;
            Command::AccessLimits {
                workspace: target("workspace")?,
                app,
                patch: Patch {
                    max_domains: take("--max-domains"),
                    max_mailboxes: take("--max-mailboxes"),
                    max_daily_sends: take("--max-daily-sends"),
                    consumer_recipients: consumer,
                    allow_domains: take("--allow-domains"),
                },
            }
        }
        (Some("access"), Some(word)) => match AccessAction::parse(word) {
            Some(action) => Command::AccessDecide {
                workspace: target("workspace")?,
                app,
                action,
            },
            None => return Err(format!("unknown access action {word}")),
        },
        (Some("staff"), Some("list")) => Command::StaffList,
        (Some("staff"), Some("add")) => {
            let role = take("--role").ok_or("staff add needs --role")?;
            Command::StaffAdd {
                email: target("email address")?,
                role: StaffRole::parse(&role).ok_or("--role is superadmin, admin or viewer")?,
                name: take("--name"),
            }
        }
        (Some("staff"), Some("remove")) => Command::StaffRemove {
            email: target("email address")?,
        },
        (Some("billing"), action) => Command::Billing(crate::admin_billing::BillingCommand::parse(
            action,
            words.get(2).map(String::as_str),
            &mut take,
        )?),
        (Some(area @ ("access" | "staff")), None) => return Err(format!("{area} needs an action")),
        (Some(area), _) => return Err(format!("unknown area {area}")),
        (None, _) => return Err("name an area: access, staff or billing".to_owned()),
    };
    // A flag no command above took is one this command doesn't have.
    if let Some((flag, _)) = flags.first() {
        return Err(format!("{flag} doesn't apply here"));
    }
    if words.len() > 3 {
        return Err(format!("unexpected argument {}", words[3]));
    }
    Ok(Parsed::Run(Box::new(Options {
        command,
        actor,
        reason,
        dry_run,
        json,
    })))
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(crate) fn run(args: &[String]) -> ExitCode {
    let options = match parse(args, env("WELDSUITE_ACTOR")) {
        Ok(Parsed::Run(options)) => options,
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(problem) => {
            eprintln!("{problem}\n\nweldsuite admin --help shows the commands.");
            return ExitCode::from(2);
        }
    };
    if options.writes()
        && options.actor.is_none()
        && !matches!(options.command, Command::StaffAdd { .. })
    {
        eprintln!("A change needs the person acting: --as <email> (or WELDSUITE_ACTOR).");
        return ExitCode::from(2);
    }
    let Some(master_url) = env("DATABASE_URL_MASTER").or_else(|| env("MASTER_DATABASE_URL")) else {
        eprintln!("DATABASE_URL_MASTER is required");
        return ExitCode::from(78); // EX_CONFIG
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start the async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(execute(&options, &master_url)) {
        Ok(output) => {
            print!("{output}");
            ExitCode::SUCCESS
        }
        Err(StaffError::Refused(message)) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("failed: {error}");
            ExitCode::FAILURE
        }
    }
}

/// What a change may need beyond the master database, from the environment.
struct Environment {
    tenants: Workspaces,
    mail: Option<Arc<dyn DynSystemMail>>,
    platform_url: Option<String>,
    /// Why there is no mail transport, when `SMTP_URL` is set but unusable.
    mail_problem: Option<String>,
}

impl Environment {
    fn from_env(master: &PgPool) -> Self {
        let keyring = Keyring {
            v1: env("DATABASE_ENCRYPTION_KEY"),
            v2: env("DATABASE_ENCRYPTION_KEY_V2"),
        };
        let (mail, mail_problem) = match env("SMTP_URL").map(|url| SmtpMail::from_url(&url)) {
            Some(Ok(smtp)) => {
                let smtp: Arc<dyn DynSystemMail> = Arc::new(smtp);
                let from = env("SYSTEM_EMAIL_FROM");
                (
                    Some(weldsuite_emails::WithFromAddress::wrap(
                        smtp,
                        from.as_deref(),
                    )),
                    None,
                )
            }
            Some(Err(error)) => (None, Some(format!("SMTP_URL is not usable: {error}"))),
            None => (None, None),
        };
        Self {
            tenants: Workspaces::new(master.clone(), keyring, WorkspaceConfig::default()),
            mail,
            platform_url: env("PLATFORM_URL"),
            mail_problem,
        }
    }

    fn effects(&self) -> Effects<'_> {
        Effects {
            tenants: Some(&self.tenants),
            mail: self.mail.as_deref(),
            platform_url: self.platform_url.as_deref(),
        }
    }
}

async fn execute(options: &Options, master_url: &str) -> StaffResult<String> {
    let master = weldsuite_db::master_pool(master_url, 2)
        .map_err(|error| StaffError::Refused(format!("DATABASE_URL_MASTER: {error}")))?;
    match &options.command {
        Command::StaffList | Command::StaffAdd { .. } | Command::StaffRemove { .. } => {
            execute_staff(&master, options).await
        }
        Command::Billing(billing) => {
            crate::admin_billing::execute(
                &master,
                billing,
                options.actor.as_deref(),
                &options.reason,
                options.dry_run,
            )
            .await
        }
        _ => execute_access(&master, options).await,
    }
}

/// `access …`.
async fn execute_access(master: &PgPool, options: &Options) -> StaffResult<String> {
    let json = options.json;
    match &options.command {
        Command::AccessList {
            status,
            app,
            search,
        } => {
            let filter = AccessFilter {
                status: status.as_deref(),
                app_code: app.as_deref(),
                search: search.as_deref(),
            };
            let rows = access::list(master, &filter).await?;
            Ok(if json {
                pretty(&Value::Array(rows.iter().map(summary_json).collect()))
            } else {
                summary_table(&rows)
            })
        }
        Command::AccessShow { workspace, app } => {
            let found = access::find_workspace(master, workspace).await?;
            let detail = access::get(master, &found.id, app).await?.ok_or_else(|| {
                StaffError::Refused(format!(
                    "{} ({}) has no access row for {app}.",
                    found.name, found.id
                ))
            })?;
            Ok(if json {
                pretty(&detail_json(&detail))
            } else {
                detail_text(&detail)
            })
        }
        Command::AccessDecide {
            workspace,
            app,
            action,
        } => {
            let actor = acting(master, options).await?;
            let environment = Environment::from_env(master);
            let mut outcome = access::decide(
                master,
                &actor,
                Decision {
                    workspace,
                    app_code: app,
                    action: *action,
                    reason: &options.reason,
                    dry_run: options.dry_run,
                },
                environment.effects(),
            )
            .await?;
            if let Some(problem) = environment.mail_problem {
                outcome.warnings.push(problem);
            }
            Ok(decision_output(&outcome, json))
        }
        Command::AccessLimits {
            workspace,
            app,
            patch,
        } => {
            let actor = acting(master, options).await?;
            let patch = patch.to_limits_patch();
            let change = access::set_limits(
                master,
                &actor,
                LimitsRequest {
                    workspace,
                    app_code: app,
                    patch: &patch,
                    reason: &options.reason,
                    dry_run: options.dry_run,
                },
            )
            .await?;
            Ok(limits_output(&change, json))
        }
        _ => Err(StaffError::Refused("not an access command".to_owned())),
    }
}

/// `staff …`.
async fn execute_staff(master: &PgPool, options: &Options) -> StaffResult<String> {
    let json = options.json;
    match &options.command {
        Command::StaffList => {
            let rows = staff::list(master).await?;
            Ok(if json {
                pretty(&Value::Array(rows.iter().map(member_json).collect()))
            } else {
                staff_table(&rows)
            })
        }
        Command::StaffAdd { email, role, name } => {
            let actor = match &options.actor {
                Some(email) => Some(staff::actor(master, email).await?),
                None => None,
            };
            let change = staff::add(
                master,
                actor.as_ref(),
                &NewStaff {
                    email,
                    role: *role,
                    name: name.as_deref(),
                },
                &options.reason,
                options.dry_run,
            )
            .await?;
            Ok(roster_output("added", &change, json))
        }
        Command::StaffRemove { email } => {
            let actor = acting_any(master, options).await?;
            let change =
                staff::remove(master, &actor, email, &options.reason, options.dry_run).await?;
            Ok(roster_output("removed", &change, json))
        }
        _ => Err(StaffError::Refused("not a staff command".to_owned())),
    }
}

/// The person acting, allowed to write.
async fn acting(master: &PgPool, options: &Options) -> StaffResult<Actor> {
    staff::writer(master, options.actor.as_deref().unwrap_or_default()).await
}

/// The person acting, any role (the roster checks its own).
async fn acting_any(master: &PgPool, options: &Options) -> StaffResult<Actor> {
    staff::actor(master, options.actor.as_deref().unwrap_or_default()).await
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

fn pretty(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    text
}

/// Rows as columns padded to their widest cell.
fn table(header: &[&str], rows: &[Vec<String>]) -> String {
    let mut widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
    for row in rows {
        for (width, cell) in widths.iter_mut().zip(row) {
            *width = (*width).max(cell.chars().count());
        }
    }
    let mut out = String::new();
    let line = |out: &mut String, cells: Vec<&str>| {
        let mut text = String::new();
        for (index, (cell, width)) in cells.iter().zip(&widths).enumerate() {
            if index > 0 {
                text.push_str("  ");
            }
            let _ = write!(text, "{cell:<width$}");
        }
        out.push_str(text.trim_end());
        out.push('\n');
    };
    line(&mut out, header.to_vec());
    for row in rows {
        line(&mut out, row.iter().map(String::as_str).collect());
    }
    out
}

fn or_dash(value: Option<&str>) -> String {
    value.filter(|v| !v.is_empty()).unwrap_or("-").to_owned()
}

fn countries(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn summary_table(rows: &[AccessSummary]) -> String {
    if rows.is_empty() {
        return "No access rows.\n".to_owned();
    }
    let cells: Vec<Vec<String>> = rows
        .iter()
        .map(|row| {
            vec![
                row.workspace_id.clone(),
                row.workspace_name.clone(),
                row.app_code.clone(),
                row.status.clone(),
                or_dash(row.requested_at.as_deref()),
                or_dash(row.company_name.as_deref()),
                countries(row.target_countries.as_ref()).join(","),
                or_dash(row.expected_daily_sends.as_deref()),
            ]
        })
        .collect();
    table(
        &[
            "WORKSPACE",
            "NAME",
            "APP",
            "STATUS",
            "REQUESTED",
            "COMPANY",
            "COUNTRIES",
            "PER DAY",
        ],
        &cells,
    )
}

fn summary_json(row: &AccessSummary) -> Value {
    json!({
        "id": row.id,
        "workspaceId": row.workspace_id,
        "workspaceName": row.workspace_name,
        "appCode": row.app_code,
        "appName": row.app_name,
        "status": row.status,
        "requestedAt": row.requested_at,
        "reviewedAt": row.reviewed_at,
        "companyName": row.company_name,
        "targetCountries": countries(row.target_countries.as_ref()),
        "listSource": row.list_source,
        "expectedDailySends": row.expected_daily_sends.as_deref().and_then(|n| n.parse::<f64>().ok()),
    })
}

fn detail_json(detail: &AccessDetail) -> Value {
    let (contact_email, contact_name) = access::requester_contact(detail);
    json!({
        "id": detail.id,
        "workspace": { "id": detail.workspace_id, "name": detail.workspace_name, "slug": detail.workspace_slug },
        "appCode": detail.app_code,
        "appName": detail.app_name,
        "status": detail.status,
        "availableActions": access::available_actions(&detail.status).into_iter().map(AccessAction::as_str).collect::<Vec<_>>(),
        "request": detail.request,
        "requester": { "email": contact_email, "name": contact_name },
        "limits": detail.limits.to_json(),
        "limitsUnset": detail.limits_unset,
        "requestedAt": detail.requested_at,
        "reviewedBy": detail.reviewed_by,
        "reviewedAt": detail.reviewed_at,
        "reviewNotes": detail.review_notes,
        "rejectionReason": detail.rejection_reason,
        "suspendedReason": detail.suspended_reason,
        "billingStatus": detail.billing_status,
    })
}

fn limits_lines(out: &mut String, limits: &Limits) {
    let _ = writeln!(out, "  max domains          {}", limits.max_domains);
    let _ = writeln!(out, "  max mailboxes        {}", limits.max_mailboxes);
    let _ = writeln!(out, "  max daily sends      {}", limits.max_daily_sends);
    let consumer = if limits.allow_consumer_recipients {
        "on"
    } else {
        "off"
    };
    let _ = writeln!(out, "  consumer recipients  {consumer}");
    let domains = if limits.force_allow_domains.is_empty() {
        "-".to_owned()
    } else {
        limits.force_allow_domains.join(", ")
    };
    let _ = writeln!(out, "  allowed domains      {domains}");
}

fn detail_text(detail: &AccessDetail) -> String {
    let mut out = String::new();
    let field = |out: &mut String, label: &str, value: Option<&str>| {
        let _ = writeln!(out, "{label:<18}{}", or_dash(value));
    };
    let request = |key: &str| {
        detail
            .request
            .as_ref()
            .and_then(|r| r.get(key))
            .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
    };
    field(
        &mut out,
        "workspace",
        Some(&format!(
            "{} ({}, {})",
            detail.workspace_name, detail.workspace_id, detail.workspace_slug
        )),
    );
    field(
        &mut out,
        "app",
        Some(&format!("{} ({})", detail.app_name, detail.app_code)),
    );
    field(&mut out, "status", Some(&detail.status));
    let actions = access::available_actions(&detail.status)
        .into_iter()
        .map(AccessAction::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    field(&mut out, "possible", Some(&actions));
    let (contact_email, contact_name) = access::requester_contact(detail);
    let requester = match (contact_name, contact_email) {
        (Some(name), Some(email)) => Some(format!("{name} <{email}>")),
        (None, Some(email)) => Some(email),
        _ => None,
    };
    field(&mut out, "requester", requester.as_deref());
    field(&mut out, "requested", detail.requested_at.as_deref());
    field(
        &mut out,
        "reviewed",
        detail
            .reviewed_at
            .as_ref()
            .map(|at| format!("{at} by {}", or_dash(detail.reviewed_by.as_deref())))
            .as_deref(),
    );
    field(
        &mut out,
        "rejection reason",
        detail.rejection_reason.as_deref(),
    );
    field(
        &mut out,
        "suspension reason",
        detail.suspended_reason.as_deref(),
    );
    field(&mut out, "notes", detail.review_notes.as_deref());
    if detail.request.is_some() {
        out.push_str("request\n");
        for (label, key) in [
            ("company", "companyName"),
            ("website", "website"),
            ("use case", "useCase"),
            ("daily sends", "expectedDailySends"),
            ("list source", "listSource"),
            ("list details", "listSourceDetails"),
            ("terms version", "termsVersion"),
        ] {
            let _ = writeln!(out, "  {label:<19}{}", or_dash(request(key).as_deref()));
        }
        let countries = countries(
            detail
                .request
                .as_ref()
                .and_then(|r| r.get("targetCountries")),
        );
        let _ = writeln!(
            out,
            "  {:<19}{}",
            "countries",
            if countries.is_empty() {
                "-".to_owned()
            } else {
                countries.join(", ")
            }
        );
    }
    if detail.app_code == WELDREACH_APP_CODE {
        let defaults = if detail.limits_unset {
            " (defaults; none stored)"
        } else {
            ""
        };
        let _ = writeln!(out, "limits{defaults}");
        limits_lines(&mut out, &detail.limits);
    }
    out
}

fn decision_output(outcome: &DecisionOutcome, json: bool) -> String {
    let warnings = &outcome.warnings;
    if json {
        return pretty(&json!({
            "applied": outcome.applied,
            "workspace": { "id": outcome.workspace.id, "name": outcome.workspace.name, "slug": outcome.workspace.slug },
            "appCode": outcome.app_code,
            "action": outcome.action.as_str(),
            "from": outcome.from,
            "to": outcome.update.status,
            "limits": outcome.update.limits.as_ref().map(Limits::to_json),
            "warnings": warnings,
            "access": outcome.access.as_ref().map(detail_json),
        }));
    }
    let mut out = String::new();
    let verb = if outcome.applied {
        "done"
    } else {
        "dry run, nothing written"
    };
    let _ = writeln!(
        out,
        "{} {} for {} ({}): {} -> {} ({verb})",
        outcome.action.as_str(),
        outcome.app_code,
        outcome.workspace.name,
        outcome.workspace.id,
        outcome.from,
        outcome.update.status,
    );
    if let Some(limits) = &outcome.update.limits {
        out.push_str("default limits set:\n");
        limits_lines(&mut out, limits);
    }
    for warning in warnings {
        let _ = writeln!(out, "warning: {warning}");
    }
    out
}

fn limits_output(change: &LimitsChange, json: bool) -> String {
    if json {
        return pretty(&json!({
            "applied": change.applied,
            "workspace": { "id": change.workspace.id, "name": change.workspace.name, "slug": change.workspace.slug },
            "before": change.before.to_json(),
            "after": change.after.to_json(),
        }));
    }
    let verb = if change.applied {
        "done"
    } else {
        "dry run, nothing written"
    };
    let mut out = format!(
        "WeldReach limits for {} ({}) ({verb})\nbefore\n",
        change.workspace.name, change.workspace.id
    );
    limits_lines(&mut out, &change.before);
    out.push_str("after\n");
    limits_lines(&mut out, &change.after);
    out
}

fn member_json(member: &StaffMember) -> Value {
    json!({
        "email": member.email,
        "name": member.name,
        "role": member.role.as_str(),
        "isActive": member.is_active,
        "userId": member.user_id,
        "consoleSubject": member.console_subject,
        "invitedBy": member.invited_by,
        "invitedAt": member.invited_at,
    })
}

fn staff_table(rows: &[StaffMember]) -> String {
    if rows.is_empty() {
        return "Nobody is on the staff list. Add the first superadmin with \
                `weldsuite admin staff add <email> --role superadmin --reason <text>`.\n"
            .to_owned();
    }
    let cells: Vec<Vec<String>> = rows
        .iter()
        .map(|m| {
            vec![
                m.email.clone(),
                or_dash(m.name.as_deref()),
                m.role.as_str().to_owned(),
                if m.is_active { "active" } else { "removed" }.to_owned(),
                or_dash(m.user_id.as_deref()),
                or_dash(m.console_subject.as_deref()),
            ]
        })
        .collect();
    table(
        &[
            "EMAIL",
            "NAME",
            "ROLE",
            "STATE",
            "PLATFORM ACCOUNT",
            "CONSOLE ACCOUNT",
        ],
        &cells,
    )
}

fn roster_output(verb: &str, change: &RosterChange, json: bool) -> String {
    if json {
        return pretty(&json!({
            "applied": change.applied,
            "before": change.before.as_ref().map(member_json),
            "after": member_json(&change.after),
        }));
    }
    let state = if change.applied {
        "done"
    } else {
        "dry run, nothing written"
    };
    let mut out = format!(
        "{verb} {} as {} ({state})\n",
        change.after.email,
        change.after.role.as_str()
    );
    if change.after.is_active && change.after.user_id.is_none() {
        out.push_str(
            "note: no platform account with this email is in a workspace yet, so the WeldApps \
             review gate doesn't know them until `staff add` runs again after they join one.\n",
        );
    }
    if change.after.is_active && change.after.console_subject.is_none() {
        out.push_str(
            "note: their first sign-in to the admin console, with a verified email in the staff \
             organization, binds the row to that account.\n",
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    fn run_options(line: &str) -> Options {
        match parse(&args(line), None) {
            Ok(Parsed::Run(options)) => *options,
            other => panic!("{line}: {other:?}"),
        }
    }

    #[test]
    fn decisions_parse_with_the_default_app() {
        let options =
            run_options("access approve ws_1 --as a@weldsuite.org --reason=fine --dry-run");
        assert_eq!(
            options.command,
            Command::AccessDecide {
                workspace: "ws_1".to_owned(),
                app: "weldreach".to_owned(),
                action: AccessAction::Approve,
            }
        );
        assert_eq!(options.actor.as_deref(), Some("a@weldsuite.org"));
        assert_eq!(options.reason, "fine");
        assert!(options.dry_run && options.writes());
    }

    #[test]
    fn the_actor_comes_from_the_environment_unless_given() {
        let parsed = parse(
            &args("access suspend acme --reason spam"),
            Some("env@weldsuite.org".to_owned()),
        );
        let Ok(Parsed::Run(options)) = parsed else {
            panic!("parses")
        };
        assert_eq!(options.actor.as_deref(), Some("env@weldsuite.org"));
    }

    #[test]
    fn limits_take_only_what_is_named() {
        let options = run_options(
            "access limits ws_1 --max-mailboxes 20 --consumer-recipients on --allow-domains a.com,b.nl --reason more",
        );
        assert_eq!(
            options.command,
            Command::AccessLimits {
                workspace: "ws_1".to_owned(),
                app: "weldreach".to_owned(),
                patch: Patch {
                    max_mailboxes: Some("20".to_owned()),
                    consumer_recipients: Some(true),
                    allow_domains: Some("a.com,b.nl".to_owned()),
                    ..Patch::default()
                },
            }
        );
    }

    #[test]
    fn lists_and_reads_need_no_actor() {
        let options = run_options("access list --status requested --app weldreach");
        assert_eq!(
            options.command,
            Command::AccessList {
                status: Some("requested".to_owned()),
                app: Some("weldreach".to_owned()),
                search: None,
            }
        );
        assert!(!options.writes());
        assert!(!run_options("staff list").writes());
    }

    #[test]
    fn staff_add_needs_a_known_role() {
        let options = run_options("staff add Gert@WeldSuite.org --role superadmin --reason first");
        assert_eq!(
            options.command,
            Command::StaffAdd {
                email: "Gert@WeldSuite.org".to_owned(),
                role: StaffRole::Superadmin,
                name: None,
            }
        );
        assert!(parse(&args("staff add a@b.org --role owner"), None).is_err());
        assert!(parse(&args("staff add a@b.org"), None).is_err());
    }

    #[test]
    fn mistakes_are_named() {
        for (line, expected) in [
            ("", "name an area"),
            ("access", "access needs an action"),
            ("billing list", "unknown billing action list"),
            ("billing", "billing needs an action"),
            ("invoices list", "unknown area invoices"),
            ("access delete ws_1", "unknown access action delete"),
            ("access approve", "name the workspace"),
            ("access list --status pending", "--status is one of"),
            (
                "access approve ws_1 --role admin",
                "--role doesn't apply here",
            ),
            ("access approve ws_1 --reason", "--reason needs a value"),
            (
                "access approve ws_1 --frobnicate",
                "unknown option --frobnicate",
            ),
            ("access approve ws_1 ws_2", "unexpected argument ws_2"),
            (
                "access limits ws_1 --consumer-recipients maybe",
                "on or off",
            ),
        ] {
            let error = parse(&args(line), None).expect_err(line);
            assert!(error.contains(expected), "{line}: {error}");
        }
        assert_eq!(parse(&args("access --help"), None), Ok(Parsed::Help));
    }

    #[test]
    fn tables_pad_to_the_widest_cell() {
        let text = table(&["A", "BB"], &[vec!["long".to_owned(), "x".to_owned()]]);
        assert_eq!(text, "A     BB\nlong  x\n");
    }
}
