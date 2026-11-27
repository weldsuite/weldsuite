//! The master rows of the moving workspaces ([`copy`]): which tables move,
//! and why the others don't ([`TABLES`]).
//!
//! Global's master stays at the schema it had at the flip (migration 0072,
//! ADR DATA-019) while the install's is newer, so rows are read as JSON with
//! the columns both sides have, and written through the install's own row
//! type (`json_populate_recordset`). Columns only the install has take their
//! defaults. The whole copy is one transaction on the install: it lands, or
//! nothing does.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::{Acquire as _, PgConnection, PgPool};

use crate::global::{Global, GlobalWorkspace, PlanName};
use crate::sql::{self, OnConflict};
use crate::{ImportError, redact_urls};

/// Which rows of a table move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    /// Rows whose column (any of them) holds a moving workspace's id or
    /// organization id.
    Workspace(&'static [&'static str]),
    /// Rows whose column holds the id of a moving workspace's member.
    User(&'static str),
    /// Rows a condition on the workspace references (`$1`) selects.
    Custom(&'static str),
}

impl Filter {
    /// The `where` clause, with `$1` the workspace references or the user
    /// ids.
    pub fn sql(self) -> String {
        match self {
            Self::Workspace(columns) => columns
                .iter()
                .map(|column| format!("{} = any($1)", sql::ident(column)))
                .collect::<Vec<_>>()
                .join(" or "),
            Self::User(column) => format!("{} = any($1)", sql::ident(column)),
            Self::Custom(condition) => condition.to_owned(),
        }
    }

    fn by_user(self) -> bool {
        matches!(self, Self::User(_))
    }
}

/// What happens to a master table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Copy(Filter),
    /// Not moved, and why.
    Skip(&'static str),
}

/// One master table and its rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Table {
    pub name: &'static str,
    pub rule: Rule,
}

const fn moves(name: &'static str, filter: Filter) -> Table {
    Table {
        name,
        rule: Rule::Copy(filter),
    }
}

const fn stays(name: &'static str, reason: &'static str) -> Table {
    Table {
        name,
        rule: Rule::Skip(reason),
    }
}

const WORKSPACE: Filter = Filter::Workspace(&["workspace_id"]);
const WORKSPACE_OR_ORG: Filter = Filter::Workspace(&["workspace_id", "clerk_org_id"]);
const ORG: Filter = Filter::Workspace(&["clerk_org_id"]);

/// The apps a moving workspace owns or has installed: an install needs its
/// app. An app is shared by every workspace that installed it, so these
/// rows are never deleted to be written again (that would take other
/// workspaces' installs with them): see [`APP_TABLES`].
const MOVING_APPS: &str = "owner_workspace_id = any($1) \
     or id in (select app_id from public.user_app_installs where workspace_id = any($1))";
const OF_MOVING_APPS: &str = "app_id in (select id from public.user_apps \
     where owner_workspace_id = any($1) \
        or id in (select app_id from public.user_app_installs where workspace_id = any($1)))";

/// The tables of apps, with the column naming the app. Like `users`, a row
/// the install already has stays (another workspace that installed the app
/// moved earlier, in its own batch); one of an app a moving workspace owns
/// is brought up to date. None of them is deleted for `--replace`.
const APP_TABLES: &[(&str, &str)] = &[
    ("user_apps", "id"),
    ("user_app_versions", "app_id"),
    ("user_app_oauth_clients", "app_id"),
];

const PARTNERS: &str = "partners don't move: no Global workspace has one (inventory, \
     2026-11-20), and the partner portal follows in phase 9";
const CATALOGUE: &str = "the App Store catalogue is this install's own";
const LAKEHOUSE: &str = "the analytics catalogue: WeldPanel analytics move in phase 9";
const PRICE_LIST: &str = "this install's own price list";

/// Every master table, in the order the copy writes them (a table after the
/// ones its foreign keys point at). A table Global has that is not listed
/// stops the move ([`crate::check`]): nothing is left behind unnoticed.
pub const TABLES: &[Table] = &[
    moves("users", Filter::User("id")),
    moves("workspaces", Filter::Workspace(&["id"])),
    moves("user_workspaces", WORKSPACE),
    moves("user_apps", Filter::Custom(MOVING_APPS)),
    moves("user_app_versions", Filter::Custom(OF_MOVING_APPS)),
    moves("user_app_oauth_clients", Filter::Custom(OF_MOVING_APPS)),
    moves("user_app_installs", WORKSPACE),
    moves("user_app_tokens", WORKSPACE),
    moves("ad_sync_index", WORKSPACE_OR_ORG),
    stays(
        "admin_audit_events",
        "the staff audit of Global's admin console; this install keeps its own",
    ),
    stays("admin_users", "this install's own staff list"),
    stays(
        "ai_gateway_credits",
        "Cloudflare AI Gateway's balance, not used here",
    ),
    moves("ai_provider_usage", WORKSPACE),
    moves("api_key_registry", WORKSPACE),
    stays("app_catalog", CATALOGUE),
    moves("app_developer_accounts", WORKSPACE),
    stays("app_screenshots", CATALOGUE),
    moves("bank_feed_connection_index", ORG),
    stays(
        "billing_accounts",
        "Mollie billing: a paid workspace's account is opened after the copy (BILL-014)",
    ),
    stays("billing_invoices", "Mollie invoices: Global has none"),
    stays("billing_payments", "Mollie payments: Global has none"),
    moves("commerce_connection_registry", WORKSPACE),
    stays("credit_packages", "this install's own credit packages"),
    moves("credit_transactions", WORKSPACE),
    stays(
        "database_pool",
        "Neon's warm pool: no pool on Kubernetes (DATA-018)",
    ),
    moves("digest_schedules", WORKSPACE),
    stays("domain_pricing", PRICE_LIST),
    stays(
        "enterprise_inquiries",
        "WeldSuite's own sales inquiries, not a workspace's",
    ),
    moves("feature_flag_overrides", WORKSPACE),
    stays(
        "feature_requests",
        "WeldSuite's own feedback board, not a workspace's",
    ),
    moves("form_abuse_reports", WORKSPACE),
    moves("form_invitation_registry", WORKSPACE_OR_ORG),
    moves("form_link_registry", WORKSPACE_OR_ORG),
    moves("helpcenter_domain_registry", WORKSPACE),
    stays("iceberg_namespace_properties", LAKEHOUSE),
    stays("iceberg_tables", LAKEHOUSE),
    moves("mail_account_registry", WORKSPACE),
    stays(
        "mail_threat_indicators",
        "Global's shared threat list; this install keeps its own",
    ),
    moves("merge_provider_index", WORKSPACE),
    stays(
        "neon_shared_projects",
        "Global's Neon projects; this install's shards are its own",
    ),
    moves("outbound_mail_cases", WORKSPACE),
    moves("outbound_mail_events", WORKSPACE),
    moves("outbound_mail_policies", WORKSPACE),
    moves("panel_custom_domains", WORKSPACE),
    moves("panel_erasure_ledger", WORKSPACE),
    moves("panel_key_registry", WORKSPACE),
    moves("panel_project_registry", WORKSPACE),
    moves("panel_schedule_registry", WORKSPACE),
    moves("panel_share_registry", WORKSPACE),
    moves("panel_usage_monthly", WORKSPACE),
    stays("partner_contracts", PARTNERS),
    stays("partner_credit_grants", PARTNERS),
    stays("partner_licence_packages", PARTNERS),
    stays("partner_members", PARTNERS),
    stays("partner_statement_lines", PARTNERS),
    stays("partner_statements", PARTNERS),
    stays("partner_territories", PARTNERS),
    stays("partner_workspace_requests", PARTNERS),
    stays("partners", PARTNERS),
    moves("payroll_usage_events", WORKSPACE),
    stays(
        "personal_accounts",
        "the consumer product is retired (OPS-025, decision 5)",
    ),
    moves("phone_number_registry", ORG),
    stays(
        "plans",
        "this install's own plans; each workspace's plan is mapped to one of them",
    ),
    moves("postpeer_post_index", ORG),
    moves("reach_routes", WORKSPACE_OR_ORG),
    moves("reach_warmup_mailboxes", WORKSPACE_OR_ORG),
    stays(
        "reach_warmup_messages",
        "the warm-up network's message log; the mailboxes move and warm up again",
    ),
    moves("sign_link_registry", WORKSPACE_OR_ORG),
    moves("storefront_hosts", WORKSPACE),
    moves("storefront_key_registry", WORKSPACE),
    stays("system_settings", "this install's own settings"),
    stays("telephony_number_pricing", PRICE_LIST),
    stays("telephony_service_rates", PRICE_LIST),
    moves("telnyx_porting_order_index", ORG),
    stays(
        "user_app_dev_sessions",
        "`weld app dev` sessions: the developer starts one again",
    ),
    moves("widget_registry", WORKSPACE),
    moves("workflow_webhook_registry", WORKSPACE),
    moves("workspace_app_access", WORKSPACE),
    moves("workspace_credits", WORKSPACE),
    stays(
        "workspace_database_moves",
        "Global's own moves between Neon projects",
    ),
    stays(
        "workspace_due_index",
        "Global keeps it in D1; every sweep's row is seeded once the tenant is copied",
    ),
    stays(
        "workspace_invitations",
        "invitations sent through Clerk don't open on this install: admins invite again",
    ),
    stays("workspace_licence_changes", PARTNERS),
    stays("workspace_licences", PARTNERS),
    moves("workspace_seat_snapshots", WORKSPACE),
    moves("workspace_sso", WORKSPACE_OR_ORG),
    moves("workspace_usage", WORKSPACE),
];

/// The rule for a master table, if the move has one.
pub fn rule(table: &str) -> Option<Rule> {
    TABLES
        .iter()
        .find(|entry| entry.name == table)
        .map(|entry| entry.rule)
}

/// Columns of a workspace row the install owns: where its database is and
/// whether it is ready. Global's values are never copied, and a second run
/// leaves the install's alone.
pub const INSTALL_OWNED_WORKSPACE_COLUMNS: &[&str] = &[
    "neon_project_id",
    "neon_database_name",
    "shared_project_id",
    "neon_branch_id",
    "neon_role_name",
    "neon_region",
    "database_url",
    "database_provisioned_at",
    "provisioning_status",
    "provisioning_error",
];

/// Global's plan ids, mapped to the install's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlanMap {
    by_global_id: BTreeMap<String, String>,
    /// Global plans with no counterpart: `(global id, slug)`.
    unmapped: Vec<(String, String)>,
}

impl PlanMap {
    /// Each Global plan goes to the install's plan with the same slug, or the
    /// one `overrides` names (Global slug → install slug). An override naming
    /// a slug either side lacks is an error.
    pub fn build(
        global: &[PlanName],
        install: &[PlanName],
        overrides: &[(String, String)],
    ) -> Result<Self, ImportError> {
        let install_by_slug: BTreeMap<&str, &str> = install
            .iter()
            .map(|plan| (plan.slug.as_str(), plan.id.as_str()))
            .collect();
        for (from, to) in overrides {
            if !global.iter().any(|plan| &plan.slug == from) {
                return Err(ImportError::refused(format!(
                    "--plan {from}={to}: Global has no plan {from}"
                )));
            }
            if !install_by_slug.contains_key(to.as_str()) {
                return Err(ImportError::refused(format!(
                    "--plan {from}={to}: this install has no plan {to}"
                )));
            }
        }
        let mut map = Self::default();
        for plan in global {
            let slug = overrides
                .iter()
                .find(|(from, _)| from == &plan.slug)
                .map_or(plan.slug.as_str(), |(_, to)| to.as_str());
            match install_by_slug.get(slug) {
                Some(id) => {
                    map.by_global_id.insert(plan.id.clone(), (*id).to_owned());
                }
                None => map.unmapped.push((plan.id.clone(), plan.slug.clone())),
            }
        }
        Ok(map)
    }

    /// The install's plan for a Global plan id.
    pub fn get(&self, global_id: &str) -> Option<&str> {
        self.by_global_id.get(global_id).map(String::as_str)
    }

    /// The slug of a Global plan with no counterpart, if `global_id` is one.
    pub fn unmapped_slug(&self, global_id: &str) -> Option<&str> {
        self.unmapped
            .iter()
            .find(|(id, _)| id == global_id)
            .map(|(_, slug)| slug.as_str())
    }
}

/// How [`copy`] runs.
#[derive(Debug, Clone)]
pub struct MasterOptions<'a> {
    pub plans: &'a PlanMap,
    /// Write over workspaces the install already has from an earlier run:
    /// their rows are updated (their database's placement kept) and the
    /// rows of the other tables replaced.
    pub replace: bool,
    /// Do everything, then roll back.
    pub dry_run: bool,
}

/// What happened to one table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableOutcome {
    pub table: String,
    /// Rows read from Global.
    pub read: usize,
    /// Rows the install took (`users` already there are kept, not counted).
    pub written: u64,
    /// Rows of an earlier run removed first (`--replace`).
    pub replaced: u64,
    /// Not moved, and why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
    /// Global columns the install doesn't have: not copied.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dropped_columns: Vec<String>,
}

/// What [`copy`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterReport {
    pub workspaces: Vec<String>,
    pub users: usize,
    pub tables: Vec<TableOutcome>,
    pub dry_run: bool,
}

/// The moving workspaces whose rows the install has already (an earlier
/// run): left alone without `--replace`.
pub async fn already_on_install(
    install: &PgPool,
    moving: &[GlobalWorkspace],
) -> Result<BTreeSet<String>, ImportError> {
    use sea_orm::{ColumnTrait as _, EntityTrait as _, QueryFilter as _, QuerySelect as _};
    use weldsuite_schema::master::workspaces;
    if moving.is_empty() {
        return Ok(BTreeSet::new());
    }
    let ids: Vec<String> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .filter(workspaces::Column::Id.is_in(moving.iter().map(|ws| ws.id.as_str())))
        .into_tuple()
        .all(&weldsuite_db::orm(install))
        .await
        .map_err(|error| ImportError::failed("reading this install's workspaces", error))?;
    Ok(ids.into_iter().collect())
}

/// Every table Global's master has that [`TABLES`] doesn't list.
pub fn unclassified<'a>(global_tables: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    global_tables
        .into_iter()
        .filter(|table| rule(table).is_none() && !is_bookkeeping(table))
        .cloned()
        .collect()
}

/// Tables that belong to the migration runner, not to the data.
fn is_bookkeeping(table: &str) -> bool {
    table == "__drizzle_migrations"
}

/// The members to move: every user a moving workspace's memberships name,
/// as member or as the one who invited them.
async fn member_ids(conn: &mut PgConnection, refs: &[String]) -> Result<Vec<String>, ImportError> {
    let filter = WORKSPACE.sql();
    let mut ids = BTreeSet::new();
    for column in ["user_id", "invited_by"] {
        ids.extend(
            sql::distinct_values(conn, "user_workspaces", column, &filter, refs)
                .await
                .map_err(|error| ImportError::failed("reading Global's memberships", error))?,
        );
    }
    Ok(ids.into_iter().collect())
}

/// Copy the master rows of `moving` from Global into `install` (see the
/// module docs). The caller has checked names and plans ([`crate::check`]);
/// what still collides on the install fails the transaction, named.
pub async fn copy(
    global: &Global,
    install: &PgPool,
    moving: &[GlobalWorkspace],
    options: &MasterOptions<'_>,
) -> Result<MasterReport, ImportError> {
    let mut source = global
        .master()
        .acquire()
        .await
        .map_err(|error| ImportError::failed("connecting to Global's master", error))?;
    let mut target = install
        .acquire()
        .await
        .map_err(|error| ImportError::failed("connecting to this install's master", error))?;
    let global_tables = sql::tables(&mut source)
        .await
        .map_err(|error| ImportError::failed("reading Global's master tables", error))?;
    let install_tables = sql::tables(&mut target)
        .await
        .map_err(|error| ImportError::failed("reading this install's master tables", error))?;
    let unknown = unclassified(global_tables.keys());
    if !unknown.is_empty() {
        return Err(ImportError::refused(format!(
            "Global's master has tables the move has no rule for: {}",
            unknown.join(", ")
        )));
    }

    let refs: Vec<String> = moving
        .iter()
        .flat_map(GlobalWorkspace::references)
        .collect();
    let id_of_org: BTreeMap<String, String> = moving
        .iter()
        .filter_map(|ws| Some((ws.clerk_org_id.clone()?, ws.id.clone())))
        .collect();
    let users = member_ids(&mut source, &refs).await?;
    let owned_apps: BTreeSet<String> = if global_tables.contains_key("user_apps") {
        sql::distinct_values(
            &mut source,
            "user_apps",
            "id",
            "owner_workspace_id = any($1)",
            &refs,
        )
        .await
        .map_err(|error| ImportError::failed("reading Global's apps", error))?
        .into_iter()
        .collect()
    } else {
        BTreeSet::new()
    };

    let mut tx = target
        .begin()
        .await
        .map_err(|error| ImportError::failed("starting the copy", error))?;
    let context = Copying {
        refs: &refs,
        users: &users,
        id_of_org: &id_of_org,
        owned_apps: &owned_apps,
        options,
    };
    let mut outcomes = Vec::new();
    for entry in TABLES {
        let Some(global_columns) = global_tables.get(entry.name) else {
            continue;
        };
        let outcome = match entry.rule {
            Rule::Skip(reason) => TableOutcome::skipped(entry.name, reason),
            Rule::Copy(filter) => {
                let Some(install_columns) = install_tables.get(entry.name) else {
                    return Err(ImportError::refused(format!(
                        "Global's master table {} is not on this install",
                        entry.name
                    )));
                };
                let columns = Columns::of(global_columns, install_columns);
                copy_table(&context, &mut source, &mut tx, entry.name, filter, columns).await?
            }
        };
        outcomes.push(outcome);
    }
    if options.dry_run {
        tx.rollback()
            .await
            .map_err(|error| ImportError::failed("rolling back the dry run", error))?;
    } else {
        tx.commit()
            .await
            .map_err(|error| ImportError::failed("committing the copy", error))?;
    }
    Ok(MasterReport {
        workspaces: moving.iter().map(|ws| ws.id.clone()).collect(),
        users: users.len(),
        tables: outcomes,
        dry_run: options.dry_run,
    })
}

/// What every table's copy reads: the moving workspaces' references, their
/// members, and how a membership's organization id maps to the workspace.
struct Copying<'a> {
    refs: &'a [String],
    users: &'a [String],
    id_of_org: &'a BTreeMap<String, String>,
    /// Apps the moving workspaces own.
    owned_apps: &'a BTreeSet<String>,
    options: &'a MasterOptions<'a>,
}

/// A table's columns as both sides have them.
struct Columns {
    /// Both have them: copied.
    common: Vec<String>,
    /// Only Global has them: not copied, reported.
    dropped: Vec<String>,
}

impl Columns {
    fn of(global: &[String], install: &[String]) -> Self {
        let (common, dropped) = global
            .iter()
            .cloned()
            .partition(|column| install.contains(column));
        Self { common, dropped }
    }
}

impl TableOutcome {
    fn skipped(table: &str, reason: &str) -> Self {
        Self {
            table: table.to_owned(),
            read: 0,
            written: 0,
            replaced: 0,
            skipped: Some(reason.to_owned()),
            dropped_columns: Vec::new(),
        }
    }
}

/// One table's rows of the moving workspaces, read from Global and written
/// into the install's transaction: `users` already there are kept, a
/// `workspaces` row already there is updated (its database's placement
/// kept), and with `--replace` the other tables' rows of an earlier run go
/// first.
async fn copy_table(
    context: &Copying<'_>,
    source: &mut PgConnection,
    tx: &mut PgConnection,
    table: &'static str,
    filter: Filter,
    columns: Columns,
) -> Result<TableOutcome, ImportError> {
    let values = if filter.by_user() {
        context.users
    } else {
        context.refs
    };
    let where_sql = filter.sql();
    let mut rows = sql::read_rows(source, table, &columns.common, &where_sql, values)
        .await
        .map_err(|error| ImportError::failed(&format!("reading Global's {table}"), error))?;
    prepare(table, &mut rows, context.options.plans, context.id_of_org)?;
    if let Some((_, app_column)) = APP_TABLES.iter().find(|(name, _)| *name == table) {
        let (owned, shared) = split_by_app(rows, app_column, context.owned_apps);
        let update: Vec<String> = columns
            .common
            .iter()
            .filter(|column| column.as_str() != "id")
            .cloned()
            .collect();
        let mut written = 0;
        for (rows, on_conflict) in [
            (&owned, OnConflict::Update("id", update)),
            (&shared, OnConflict::Keep("id")),
        ] {
            written += sql::write_rows(tx, table, &columns.common, rows, &on_conflict)
                .await
                .map_err(|error| write_error(table, &error))?;
        }
        return Ok(TableOutcome {
            table: table.to_owned(),
            read: owned.len() + shared.len(),
            written,
            replaced: 0,
            skipped: None,
            dropped_columns: columns.dropped,
        });
    }
    let on_conflict = match table {
        "users" => OnConflict::Keep("id"),
        "workspaces" => OnConflict::Update(
            "id",
            columns
                .common
                .iter()
                .filter(|column| {
                    column.as_str() != "id"
                        && !INSTALL_OWNED_WORKSPACE_COLUMNS.contains(&column.as_str())
                })
                .cloned()
                .collect(),
        ),
        _ => OnConflict::Fail,
    };
    let replaced = if context.options.replace && on_conflict == OnConflict::Fail {
        sql::delete_rows(tx, table, &where_sql, values)
            .await
            .map_err(|error| ImportError::failed(&format!("clearing {table}"), error))?
    } else {
        0
    };
    let written = sql::write_rows(tx, table, &columns.common, &rows, &on_conflict)
        .await
        .map_err(|error| write_error(table, &error))?;
    Ok(TableOutcome {
        table: table.to_owned(),
        read: rows.len(),
        written,
        replaced,
        skipped: None,
        dropped_columns: columns.dropped,
    })
}

/// Rows of an app table split by whose app they belong to: the moving
/// workspaces' own (`owned`), and apps they only installed.
fn split_by_app(
    rows: Vec<Value>,
    app_column: &str,
    owned: &BTreeSet<String>,
) -> (Vec<Value>, Vec<Value>) {
    rows.into_iter().partition(|row| {
        row.get(app_column)
            .and_then(Value::as_str)
            .is_some_and(|app| owned.contains(app))
    })
}

/// A failed write, named by its table and the constraint it broke: a name
/// or key the install already has for another workspace.
fn write_error(table: &str, error: &sqlx::Error) -> ImportError {
    if let Some(db) = error.as_database_error()
        && let Some(constraint) = db.constraint()
    {
        return ImportError::refused(format!(
            "{table}: a row breaks {constraint} on this install ({})",
            redact_urls(db.message())
        ));
    }
    ImportError::failed(&format!("writing {table}"), error)
}

/// The changes rows take on the way: a workspace's database placement is
/// the install's to make, its plan is the install's counterpart, and a
/// membership names the workspace by id.
fn prepare(
    table: &str,
    rows: &mut [Value],
    plans: &PlanMap,
    id_of_org: &BTreeMap<String, String>,
) -> Result<(), ImportError> {
    for row in rows.iter_mut() {
        let Some(row) = row.as_object_mut() else {
            continue;
        };
        match table {
            "workspaces" => prepare_workspace(row, plans)?,
            "user_workspaces" => {
                if let Some(Value::String(workspace)) = row.get("workspace_id")
                    && let Some(id) = id_of_org.get(workspace)
                {
                    row.insert("workspace_id".to_owned(), Value::String(id.clone()));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn prepare_workspace(row: &mut Map<String, Value>, plans: &PlanMap) -> Result<(), ImportError> {
    for column in INSTALL_OWNED_WORKSPACE_COLUMNS {
        row.insert((*column).to_owned(), Value::Null);
    }
    row.insert(
        "provisioning_status".to_owned(),
        Value::String("provisioning".to_owned()),
    );
    // No partner moves (TABLES), so no workspace is billed through one.
    row.insert("partner_id".to_owned(), Value::Null);
    if row.get("billing_mode").and_then(Value::as_str) == Some("partner") {
        row.insert(
            "billing_mode".to_owned(),
            Value::String("direct".to_owned()),
        );
    }
    if let Some(Value::String(plan)) = row.get("plan_id") {
        let mapped = plans.get(plan).ok_or_else(|| {
            let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
            let slug = plans.unmapped_slug(plan).unwrap_or(plan);
            ImportError::refused(format!(
                "{id} is on Global's plan {slug}, which this install has no plan for: \
                 map it with --plan {slug}=<install plan>"
            ))
        })?;
        row.insert("plan_id".to_owned(), Value::String(mapped.to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn plan(id: &str, slug: &str) -> PlanName {
        PlanName {
            id: id.to_owned(),
            slug: slug.to_owned(),
        }
    }

    #[test]
    fn every_master_table_has_one_rule() {
        let names: Vec<&str> = TABLES.iter().map(|table| table.name).collect();
        let unique: BTreeSet<&str> = names.iter().copied().collect();
        assert_eq!(names.len(), unique.len(), "a table is listed twice");
        let schema: BTreeSet<String> = weldsuite_schema::master::tables()
            .iter()
            .map(|table| table.ddl.name.to_owned())
            .collect();
        let missing: Vec<&String> = schema
            .iter()
            .filter(|table| rule(table).is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "master tables with no rule in TABLES (copy them for the moving workspaces, or skip them \
             with a reason): {missing:?}"
        );
        let stale: Vec<&str> = names
            .iter()
            .copied()
            .filter(|name| !schema.contains(*name))
            .collect();
        assert!(
            stale.is_empty(),
            "TABLES names tables the schema doesn't have: {stale:?}"
        );
    }

    #[test]
    fn users_and_workspaces_come_before_what_points_at_them() {
        let position = |name: &str| TABLES.iter().position(|table| table.name == name);
        assert_eq!(position("users"), Some(0));
        assert_eq!(position("workspaces"), Some(1));
        assert!(position("user_apps") < position("user_app_versions"));
        assert!(position("user_app_installs") < position("user_app_tokens"));
    }

    #[test]
    fn filters_name_their_columns() {
        assert_eq!(WORKSPACE.sql(), "\"workspace_id\" = any($1)");
        assert_eq!(
            WORKSPACE_OR_ORG.sql(),
            "\"workspace_id\" = any($1) or \"clerk_org_id\" = any($1)"
        );
        assert_eq!(Filter::User("id").sql(), "\"id\" = any($1)");
    }

    #[test]
    fn plans_map_by_slug_or_override() {
        let global = [
            plan("p_free", "free"),
            plan("p_scale", "scale"),
            plan("p_biz", "business"),
        ];
        let install = [plan("plan_free", "free"), plan("plan_business", "business")];
        let map = PlanMap::build(&global, &install, &[]).expect("map");
        assert_eq!(map.get("p_free"), Some("plan_free"));
        assert_eq!(map.get("p_biz"), Some("plan_business"));
        assert_eq!(map.get("p_scale"), None);
        assert_eq!(map.unmapped_slug("p_scale"), Some("scale"));

        let overrides = [("scale".to_owned(), "business".to_owned())];
        let map = PlanMap::build(&global, &install, &overrides).expect("map");
        assert_eq!(map.get("p_scale"), Some("plan_business"));

        let bad = [("scale".to_owned(), "platinum".to_owned())];
        assert!(PlanMap::build(&global, &install, &bad).is_err());
        let bad = [("gold".to_owned(), "business".to_owned())];
        assert!(PlanMap::build(&global, &install, &bad).is_err());
    }

    #[test]
    fn a_workspace_row_loses_its_placement_and_gets_the_install_plan() {
        let global = [plan("p_scale", "scale")];
        let install = [plan("plan_business", "business")];
        let map =
            PlanMap::build(&global, &install, &[("scale".into(), "business".into())]).expect("map");
        let mut rows = vec![json!({
            "id": "ws_1",
            "plan_id": "p_scale",
            "neon_project_id": "proj-1",
            "database_url": "v2:aa:bb",
            "provisioning_status": "ready",
            "partner_id": "par_1",
            "billing_mode": "partner",
            "slug": "acme",
        })];
        prepare("workspaces", &mut rows, &map, &BTreeMap::new()).expect("prepare");
        let row = &rows[0];
        assert_eq!(row["plan_id"], "plan_business");
        assert_eq!(row["neon_project_id"], Value::Null);
        assert_eq!(row["database_url"], Value::Null);
        assert_eq!(row["provisioning_status"], "provisioning");
        assert_eq!(row["partner_id"], Value::Null);
        assert_eq!(row["billing_mode"], "direct");
        assert_eq!(row["slug"], "acme");

        let mut unmapped = vec![json!({ "id": "ws_2", "plan_id": "p_scale" })];
        let error = prepare(
            "workspaces",
            &mut unmapped,
            &PlanMap::build(&global, &install, &[]).expect("map"),
            &BTreeMap::new(),
        )
        .expect_err("refused");
        assert!(error.to_string().contains("--plan scale="), "{error}");
    }

    #[test]
    fn a_membership_names_its_workspace_by_id() {
        let orgs = BTreeMap::from([("org_1".to_owned(), "ws_1".to_owned())]);
        let mut rows = vec![
            json!({ "id": "uw_1", "workspace_id": "org_1" }),
            json!({ "id": "uw_2", "workspace_id": "ws_1" }),
        ];
        prepare("user_workspaces", &mut rows, &PlanMap::default(), &orgs).expect("prepare");
        assert_eq!(rows[0]["workspace_id"], "ws_1");
        assert_eq!(rows[1]["workspace_id"], "ws_1");
    }

    #[test]
    fn app_rows_split_by_who_owns_the_app() {
        let owned = BTreeSet::from(["app_mine".to_owned()]);
        let rows = vec![
            json!({ "id": "ver_1", "app_id": "app_mine" }),
            json!({ "id": "ver_2", "app_id": "app_public" }),
            json!({ "id": "ver_3", "app_id": null }),
        ];
        let (mine, shared) = split_by_app(rows, "app_id", &owned);
        assert_eq!(mine, [json!({ "id": "ver_1", "app_id": "app_mine" })]);
        assert_eq!(shared.len(), 2);
        assert!(
            APP_TABLES
                .iter()
                .all(|(table, _)| rule(table).is_some_and(|rule| matches!(rule, Rule::Copy(_)))),
            "every app table is copied"
        );
    }

    #[test]
    fn the_migration_table_needs_no_rule() {
        let tables = ["__drizzle_migrations".to_owned(), "secret_stuff".to_owned()];
        assert_eq!(unclassified(tables.iter()), ["secret_stuff"]);
    }
}
