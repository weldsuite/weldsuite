//! Workspaces' access to apps on request only (WeldReach first, ADR
//! REACH-003): the admin console's rules (`apps/web/admin/lib/app-access.ts`)
//! and its writes (`apps/web/admin/actions/app-access.ts`), for
//! `weldsuite admin access`.
//!
//! | Action | From | To | Also |
//! |---|---|---|---|
//! | approve | no row, requested, rejected, revoked | approved | WeldReach's default limits on a row without limits; the app installed in the tenant; the approval email when the workspace asked |
//! | reject | requested | rejected | the reason shown to the workspace and emailed |
//! | suspend | approved | suspended | the reason shown to the workspace |
//! | unsuspend | suspended | approved | |
//! | revoke | approved, suspended | revoked | the reason only in the audit row |
//!
//! Every action needs a reason of at least [`MIN_REASON_LENGTH`] characters,
//! records the reviewer and the time, and clears the rejection and
//! suspension reasons it doesn't set. The status change and its audit row
//! commit together; the update only applies while the row still has the
//! status it was planned from, so two people acting at once can't both win.
//!
//! The module's gate caches a workspace's status for 60 seconds per pod
//! (`APP_ACCESS_CACHE_TTL`), so a decision reaches requests within that
//! minute. WeldReach's send path reads the master database on every batch,
//! so a suspension stops sending at once.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::Workspaces;
use weldsuite_emails::reach::{AccessApproved, AccessRejected, ApprovedLimits};
use weldsuite_emails::{EmailBrand, EmailLocale, SystemEmail, send_system_email};
use weldsuite_kit::generate_id;
use weldsuite_ports::DynSystemMail;
use weldsuite_reach_domain::schemas::{Limits, WELDREACH_APP_CODE, resolve_limits};

use crate::audit::{self, AuditEntry};
use crate::staff::{Actor, checked_reason};
use crate::{StaffError, StaffResult};

/// `APP_ACCESS_STATUSES`.
pub const STATUSES: [&str; 5] = ["requested", "approved", "rejected", "suspended", "revoked"];

/// The status of a workspace with no access row: staff may still approve it.
pub const NO_ROW: &str = "none";

/// `MIN_REASON_LENGTH`.
pub const MIN_REASON_LENGTH: usize = 3;

/// The longest list [`list`] returns (`LIST_LIMIT`).
pub const LIST_LIMIT: i64 = 300;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/// `AccessAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessAction {
    Approve,
    Reject,
    Suspend,
    Unsuspend,
    Revoke,
}

impl AccessAction {
    /// `ACTION_ORDER`: how the console lists what is possible.
    pub const ORDER: [Self; 5] = [
        Self::Approve,
        Self::Reject,
        Self::Unsuspend,
        Self::Suspend,
        Self::Revoke,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::Reject => "reject",
            Self::Suspend => "suspend",
            Self::Unsuspend => "unsuspend",
            Self::Revoke => "revoke",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ORDER.into_iter().find(|a| a.as_str() == value)
    }

    /// `ALLOWED_FROM`. Approval also from rejected and revoked: staff may
    /// change their mind without a new request.
    fn allowed_from(self) -> &'static [&'static str] {
        match self {
            Self::Approve => &[NO_ROW, "requested", "rejected", "revoked"],
            Self::Reject => &["requested"],
            Self::Suspend => &["approved"],
            Self::Unsuspend => &["suspended"],
            Self::Revoke => &["approved", "suspended"],
        }
    }

    /// `ACTION_TARGET`.
    pub fn target(self) -> &'static str {
        match self {
            Self::Approve | Self::Unsuspend => "approved",
            Self::Reject => "rejected",
            Self::Suspend => "suspended",
            Self::Revoke => "revoked",
        }
    }
}

/// `availableActions(status)`.
pub fn available_actions(status: &str) -> Vec<AccessAction> {
    AccessAction::ORDER
        .into_iter()
        .filter(|a| a.allowed_from().contains(&status))
        .collect()
}

/// `AccessUpdate`: what an action writes to the row (the time is the
/// database's `now()`).
#[derive(Debug, Clone, PartialEq)]
pub struct AccessUpdate {
    pub status: &'static str,
    pub reviewed_by: String,
    /// Shown to the workspace while rejected; cleared by every other action.
    pub rejection_reason: Option<String>,
    /// Shown to the workspace while suspended; cleared by every other action.
    pub suspended_reason: Option<String>,
    /// Only set when the limits must change: approving WeldReach on a row
    /// without limits.
    pub limits: Option<Limits>,
}

/// `planAccessUpdate`: what `action` does to a row in status `from`
/// ([`NO_ROW`] when there is none), or why it is refused.
pub fn plan_access_update(
    action: AccessAction,
    from: &str,
    app_code: &str,
    reason: &str,
    reviewer: &str,
    limits_unset: bool,
) -> Result<AccessUpdate, String> {
    let reason = reason.trim();
    if !action.allowed_from().contains(&from) {
        let state = if from == NO_ROW {
            "not requested"
        } else {
            from
        };
        return Err(format!(
            "Cannot {} access that is {state}.",
            action.as_str()
        ));
    }
    if reason.chars().count() < MIN_REASON_LENGTH {
        return Err(format!(
            "Give a reason of at least {MIN_REASON_LENGTH} characters."
        ));
    }
    Ok(AccessUpdate {
        status: action.target(),
        reviewed_by: reviewer.to_owned(),
        rejection_reason: (action == AccessAction::Reject).then(|| reason.to_owned()),
        suspended_reason: (action == AccessAction::Suspend).then(|| reason.to_owned()),
        limits: (action == AccessAction::Approve && app_code == WELDREACH_APP_CODE && limits_unset)
            .then(Limits::default),
    })
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// What to change in WeldReach's limits; `None` keeps the current value. The
/// counts and the domain list are text, as the console's form takes them
/// (`LimitsFormValues`).
#[derive(Debug, Clone, Default)]
pub struct LimitsPatch {
    pub max_domains: Option<String>,
    pub max_mailboxes: Option<String>,
    pub max_daily_sends: Option<String>,
    pub allow_consumer_recipients: Option<bool>,
    /// Replaces the whole list: one or more domains split on lines, commas,
    /// semicolons and spaces. Empty text clears it.
    pub force_allow_domains: Option<String>,
}

impl LimitsPatch {
    pub fn is_empty(&self) -> bool {
        self.max_domains.is_none()
            && self.max_mailboxes.is_none()
            && self.max_daily_sends.is_none()
            && self.allow_consumer_recipients.is_none()
            && self.force_allow_domains.is_none()
    }
}

/// `parseCount` plus the schema's upper bound.
fn parse_count(label: &str, raw: &str, max: i64) -> Result<i64, String> {
    let text = raw.trim();
    let number = (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse::<i64>().ok())
        .flatten()
        .ok_or_else(|| format!("{label} must be a whole number, 0 or more."))?;
    if number > max {
        return Err(format!("{label} can be at most {max}."));
    }
    Ok(number)
}

/// `DOMAIN`, without the look-ahead the regex crate doesn't have (the length
/// is checked on its own).
static DOMAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$").expect("domain regex")
});

static SEPARATORS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\s,;]+").expect("separator regex"));

/// `parseDomainList`: the domains (lowercased, a trailing dot dropped, each
/// once, in order) and the entries that aren't domains, as written.
pub fn parse_domain_list(text: &str) -> (Vec<String>, Vec<String>) {
    let mut seen = HashSet::new();
    let mut domains = Vec::new();
    let mut invalid = Vec::new();
    for raw in SEPARATORS.split(text) {
        let raw = raw.trim();
        let lower = raw.to_lowercase();
        let value = lower.strip_suffix('.').unwrap_or(&lower);
        if value.is_empty() {
            continue;
        }
        if value.len() > 253 || !DOMAIN.is_match(value) {
            invalid.push(raw.to_owned());
            continue;
        }
        if seen.insert(value.to_owned()) {
            domains.push(value.to_owned());
        }
    }
    (domains, invalid)
}

/// `parseLimitsForm` over the current limits: the changed fields checked as
/// the console checks them (`weldReachLimitsSchema`).
pub fn apply_limits(current: &Limits, patch: &LimitsPatch) -> Result<Limits, String> {
    let mut limits = current.clone();
    if let Some(raw) = &patch.max_domains {
        limits.max_domains = parse_count("Max domains", raw, 1000)?;
    }
    if let Some(raw) = &patch.max_mailboxes {
        limits.max_mailboxes = parse_count("Max mailboxes", raw, 10_000)?;
    }
    if let Some(raw) = &patch.max_daily_sends {
        limits.max_daily_sends = parse_count("Max daily sends", raw, 1_000_000)?;
    }
    if let Some(allow) = patch.allow_consumer_recipients {
        limits.allow_consumer_recipients = allow;
    }
    if let Some(text) = &patch.force_allow_domains {
        let (domains, invalid) = parse_domain_list(text);
        if !invalid.is_empty() {
            let shown = invalid.iter().take(5).cloned().collect::<Vec<_>>();
            return Err(format!("Not a domain name: {}.", shown.join(", ")));
        }
        if domains.len() > 1000 {
            return Err("At most 1000 domains can be allowed.".to_owned());
        }
        limits.force_allow_domains = domains;
    }
    Ok(limits)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// A workspace named by its id, slug or identity-provider organization id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRef {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub deleted: bool,
}

/// The workspace `reference` names: `workspaces.id`, its slug, or the
/// organization id in `clerk_org_id` (Zitadel's on Kubernetes).
pub async fn find_workspace(master: &PgPool, reference: &str) -> StaffResult<WorkspaceRef> {
    let reference = reference.trim();
    let row: Option<(String, String, String, bool)> = sqlx::query_as(
        "select id, name, slug, deleted_at is not null from workspaces
         where id = $1 or slug = $1 or clerk_org_id = $1
         order by (id = $1) desc, (slug = $1) desc
         limit 1",
    )
    .bind(reference)
    .fetch_optional(master)
    .await?;
    row.map(|(id, name, slug, deleted)| WorkspaceRef {
        id,
        name,
        slug,
        deleted,
    })
    .ok_or_else(|| {
        StaffError::refused(format!(
            "No workspace \"{reference}\" (id, slug or organization id)."
        ))
    })
}

/// One row of the access list (`AccessRequestSummary`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AccessSummary {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub app_code: String,
    pub app_name: String,
    pub status: String,
    pub requested_at: Option<String>,
    pub reviewed_at: Option<String>,
    pub company_name: Option<String>,
    pub target_countries: Option<Value>,
    pub list_source: Option<String>,
    pub expected_daily_sends: Option<String>,
}

/// What [`list`] narrows to.
#[derive(Debug, Clone, Default)]
pub struct AccessFilter<'a> {
    pub status: Option<&'a str>,
    pub app_code: Option<&'a str>,
    /// Part of the workspace's name or slug, or the request's company or
    /// contact email.
    pub search: Option<&'a str>,
}

/// `listAccessRequests`: the oldest open request first when listing
/// `requested`, else the most recently changed first.
pub async fn list(master: &PgPool, filter: &AccessFilter<'_>) -> StaffResult<Vec<AccessSummary>> {
    let search = filter
        .search
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let rows = sqlx::query_as(
        "select a.id, a.workspace_id, w.name as workspace_name, a.app_code,
                coalesce(c.name, a.app_code) as app_name, a.status,
                to_char(a.requested_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as requested_at,
                to_char(a.reviewed_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as reviewed_at,
                a.request->>'companyName' as company_name,
                a.request->'targetCountries' as target_countries,
                a.request->>'listSource' as list_source,
                a.request->>'expectedDailySends' as expected_daily_sends
         from workspace_app_access a
         join workspaces w on w.id = a.workspace_id
         left join app_catalog c on c.code = a.app_code
         where ($1::text is null or a.status = $1)
           and ($2::text is null or a.app_code = $2)
           and ($3::text is null or w.name ilike $3 or w.slug ilike $3
                or a.request->>'companyName' ilike $3 or a.request->>'contactEmail' ilike $3)
         order by case when $1::text = 'requested' then a.requested_at end asc, a.updated_at desc
         limit $4",
    )
    .bind(filter.status)
    .bind(filter.app_code)
    .bind(search)
    .bind(LIST_LIMIT)
    .fetch_all(master)
    .await?;
    Ok(rows)
}

/// Everything about one workspace's access to one app (`AppAccessDetail`).
#[derive(Debug, Clone)]
pub struct AccessDetail {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_slug: String,
    pub app_code: String,
    pub app_name: String,
    pub status: String,
    /// The request form's answers (`AppAccessRequestDetails`); none when staff
    /// granted access without a request.
    pub request: Option<Value>,
    /// The stored limits with the defaults filled in.
    pub limits: Limits,
    /// No limits were stored yet.
    pub limits_unset: bool,
    pub requested_by: Option<String>,
    /// The requester's account email, when the user is known.
    pub requested_by_email: Option<String>,
    pub requested_at: Option<String>,
    pub reviewed_by: Option<String>,
    pub reviewed_at: Option<String>,
    pub review_notes: Option<String>,
    pub rejection_reason: Option<String>,
    pub suspended_reason: Option<String>,
    pub billing_status: String,
}

#[derive(sqlx::FromRow)]
struct DetailRow {
    id: String,
    workspace_id: String,
    workspace_name: String,
    workspace_slug: String,
    app_code: String,
    app_name: String,
    status: String,
    request: Option<Value>,
    limits: Option<Value>,
    requested_by: Option<String>,
    requested_by_email: Option<String>,
    requested_at: Option<String>,
    reviewed_by: Option<String>,
    reviewed_at: Option<String>,
    review_notes: Option<String>,
    rejection_reason: Option<String>,
    suspended_reason: Option<String>,
    billing_status: String,
}

impl From<DetailRow> for AccessDetail {
    fn from(row: DetailRow) -> Self {
        let limits_unset = row
            .limits
            .as_ref()
            .and_then(Value::as_object)
            .is_none_or(serde_json::Map::is_empty);
        Self {
            id: row.id,
            workspace_id: row.workspace_id,
            workspace_name: row.workspace_name,
            workspace_slug: row.workspace_slug,
            app_code: row.app_code,
            app_name: row.app_name,
            status: row.status,
            request: row.request.filter(|r| !r.is_null()),
            limits: resolve_limits(row.limits.as_ref()),
            limits_unset,
            requested_by: row.requested_by,
            requested_by_email: row.requested_by_email,
            requested_at: row.requested_at,
            reviewed_by: row.reviewed_by,
            reviewed_at: row.reviewed_at,
            review_notes: row.review_notes,
            rejection_reason: row.rejection_reason,
            suspended_reason: row.suspended_reason,
            billing_status: row.billing_status,
        }
    }
}

/// `getAppAccess(workspaceId, appCode)`.
pub async fn get(
    master: &PgPool,
    workspace_id: &str,
    app_code: &str,
) -> StaffResult<Option<AccessDetail>> {
    let row: Option<DetailRow> = sqlx::query_as(
        "select a.id, a.workspace_id, w.name as workspace_name, w.slug as workspace_slug,
                a.app_code, coalesce(c.name, a.app_code) as app_name, a.status, a.request,
                a.limits, a.requested_by, u.email as requested_by_email,
                to_char(a.requested_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as requested_at,
                a.reviewed_by,
                to_char(a.reviewed_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as reviewed_at,
                a.review_notes, a.rejection_reason, a.suspended_reason, a.billing_status
         from workspace_app_access a
         join workspaces w on w.id = a.workspace_id
         left join app_catalog c on c.code = a.app_code
         left join users u on u.id = a.requested_by
         where a.workspace_id = $1 and a.app_code = $2
         limit 1",
    )
    .bind(workspace_id)
    .bind(app_code)
    .fetch_optional(master)
    .await?;
    Ok(row.map(AccessDetail::from))
}

/// `requesterContact`: the requester's account email, else the form's contact
/// email; the form's contact name only when it belongs to that address.
pub fn requester_contact(access: &AccessDetail) -> (Option<String>, Option<String>) {
    let text = |key: &str| {
        access
            .request
            .as_ref()
            .and_then(|r| r.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let contact_email = text("contactEmail");
    let contact_name = text("contactName");
    if let Some(email) = &access.requested_by_email {
        let same = contact_email
            .as_deref()
            .is_some_and(|c| c.eq_ignore_ascii_case(email));
        return (Some(email.clone()), if same { contact_name } else { None });
    }
    (contact_email, contact_name)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// What a decision may do beyond the master database. Each is optional: what
/// is missing becomes a warning, as in the console.
#[derive(Clone, Copy, Default)]
pub struct Effects<'a> {
    /// Opens tenant databases, to install the app on approval.
    pub tenants: Option<&'a Workspaces>,
    /// The system mail transport (`SMTP_URL`), for the requester's email.
    pub mail: Option<&'a dyn DynSystemMail>,
    /// The platform's origin (`PLATFORM_URL`), for the email's links.
    pub platform_url: Option<&'a str>,
}

impl std::fmt::Debug for Effects<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Effects")
            .field("tenants", &self.tenants.is_some())
            .field("mail", &self.mail.is_some())
            .field("platform_url", &self.platform_url)
            .finish()
    }
}

/// A status decision to make.
#[derive(Debug, Clone, Copy)]
pub struct Decision<'a> {
    /// The workspace's id, slug or organization id.
    pub workspace: &'a str,
    pub app_code: &'a str,
    pub action: AccessAction,
    pub reason: &'a str,
    /// Plan and check only; write nothing.
    pub dry_run: bool,
}

/// What a decision did, or would do.
#[derive(Debug, Clone)]
pub struct DecisionOutcome {
    pub workspace: WorkspaceRef,
    pub app_code: String,
    pub action: AccessAction,
    /// The status before ([`NO_ROW`] when there was no row).
    pub from: String,
    pub update: AccessUpdate,
    /// The row after the decision; none for a dry run on a workspace without
    /// a row.
    pub access: Option<AccessDetail>,
    /// What didn't happen and staff should handle themselves.
    pub warnings: Vec<String>,
    pub applied: bool,
}

const NOT_FOUND: &str = "This workspace has not asked for access to that app.";

/// Records a refusal as a failure row (not for a dry run) and returns it.
async fn refuse(
    master: &PgPool,
    entry: &AuditEntry<'_>,
    dry_run: bool,
    message: String,
) -> StaffError {
    if !dry_run {
        audit::record_failure(master, entry, &message).await;
    }
    StaffError::Refused(message)
}

/// Approve, reject, suspend, unsuspend or revoke, as the console's
/// `changeStatus` does.
pub async fn decide(
    master: &PgPool,
    actor: &Actor,
    decision: Decision<'_>,
    effects: Effects<'_>,
) -> StaffResult<DecisionOutcome> {
    let Decision {
        app_code,
        action,
        dry_run,
        ..
    } = decision;
    let workspace = find_workspace(master, decision.workspace).await?;
    let action_name = format!("app_access.{}", action.as_str());
    let reason = decision.reason.trim();
    let entry = AuditEntry {
        workspace_id: Some(&workspace.id),
        target_type: "workspace",
        target_id: &workspace.id,
        action: &action_name,
        actor_email: &actor.email,
        reason: Some(reason).filter(|r| !r.is_empty()),
        details: Some(json!({ "appCode": app_code })),
    };
    if workspace.deleted {
        return Err(refuse(
            master,
            &entry,
            dry_run,
            "This workspace has been deleted.".to_owned(),
        )
        .await);
    }

    let current = get(master, &workspace.id, app_code).await?;
    if current.is_none() {
        let refusal = if action == AccessAction::Approve {
            let known: bool =
                sqlx::query_scalar("select exists (select 1 from app_catalog where code = $1)")
                    .bind(app_code)
                    .fetch_one(master)
                    .await?;
            (!known).then(|| format!("Unknown app \"{app_code}\"."))
        } else {
            Some(NOT_FOUND.to_owned())
        };
        if let Some(message) = refusal {
            return Err(refuse(master, &entry, dry_run, message).await);
        }
    }

    let from = current
        .as_ref()
        .map_or(NO_ROW, |c| c.status.as_str())
        .to_owned();
    let limits_unset = current.as_ref().is_none_or(|c| c.limits_unset);
    let update =
        match plan_access_update(action, &from, app_code, reason, &actor.email, limits_unset) {
            Ok(update) => update,
            Err(message) => return Err(refuse(master, &entry, dry_run, message).await),
        };

    if dry_run {
        return Ok(DecisionOutcome {
            workspace,
            app_code: app_code.to_owned(),
            action,
            from,
            update,
            access: current,
            warnings: Vec::new(),
            applied: false,
        });
    }

    let audit_entry = AuditEntry {
        details: Some(json!({ "appCode": app_code, "from": from, "to": update.status })),
        ..entry.clone()
    };
    if !write_decision(
        master,
        current.as_ref(),
        &workspace.id,
        app_code,
        &update,
        &audit_entry,
    )
    .await?
    {
        let message = "Someone else just changed this request. Look again and retry.".to_owned();
        return Err(refuse(master, &entry, false, message).await);
    }

    let Some(access) = get(master, &workspace.id, app_code).await? else {
        return Err(StaffError::refused(NOT_FOUND));
    };
    let warnings = match action {
        AccessAction::Approve => after_approval(&workspace, &access, effects).await,
        AccessAction::Reject => after_rejection(&workspace, &access, reason, effects).await,
        _ => Vec::new(),
    };
    Ok(DecisionOutcome {
        workspace,
        app_code: app_code.to_owned(),
        action,
        from,
        update,
        access: Some(access),
        warnings,
        applied: true,
    })
}

/// Writes the planned update (or the first row) and its audit row in one
/// transaction. False when the row's status changed since it was read: the
/// update only applies to the status it was planned from.
async fn write_decision(
    master: &PgPool,
    current: Option<&AccessDetail>,
    workspace_id: &str,
    app_code: &str,
    update: &AccessUpdate,
    audit_entry: &AuditEntry<'_>,
) -> StaffResult<bool> {
    let limits_json = update.limits.as_ref().map(Limits::to_json);
    let mut tx = master.begin().await?;
    let written = if let Some(current) = current {
        sqlx::query(
            "update workspace_app_access set
                 status = $3, reviewed_by = $4, reviewed_at = now(),
                 rejection_reason = $5, suspended_reason = $6,
                 limits = coalesce($7, limits), updated_at = now()
             where id = $1 and status = $2",
        )
        .bind(&current.id)
        .bind(&current.status)
        .bind(update.status)
        .bind(&update.reviewed_by)
        .bind(&update.rejection_reason)
        .bind(&update.suspended_reason)
        .bind(&limits_json)
        .execute(&mut *tx)
        .await?
        .rows_affected()
    } else {
        sqlx::query(
            "insert into workspace_app_access
                 (id, workspace_id, app_code, status, limits, reviewed_by, reviewed_at,
                  rejection_reason, suspended_reason, created_at, updated_at)
             values ($1, $2, $3, $4, coalesce($5, '{}'::jsonb), $6, now(), $7, $8, now(), now())
             on conflict do nothing",
        )
        .bind(generate_id("waa"))
        .bind(workspace_id)
        .bind(app_code)
        .bind(update.status)
        .bind(&limits_json)
        .bind(&update.reviewed_by)
        .bind(&update.rejection_reason)
        .bind(&update.suspended_reason)
        .execute(&mut *tx)
        .await?
        .rows_affected()
    };
    if written == 0 {
        tx.rollback().await?;
        return Ok(false);
    }
    audit::record_success(&mut *tx, audit_entry).await?;
    tx.commit().await?;
    Ok(true)
}

/// Installs the app and emails the requester; returns what didn't happen.
async fn after_approval(
    workspace: &WorkspaceRef,
    access: &AccessDetail,
    effects: Effects<'_>,
) -> Vec<String> {
    let mut warnings = Vec::new();
    let installed_by = access.requested_by.as_deref().unwrap_or("admin-cli");
    if let Some(warning) = install_in_tenant(
        effects.tenants,
        &workspace.id,
        &access.app_code,
        installed_by,
    )
    .await
    {
        warnings.push(warning);
    }
    // Only a workspace that asked is emailed; a grant staff made on their own
    // has nobody to tell.
    if access.request.is_some() {
        let Some(url) = effects.platform_url else {
            warnings.push(
                "The requester was not emailed about the approval (PLATFORM_URL is not set). Tell them yourself."
                    .to_owned(),
            );
            return warnings;
        };
        let props = AccessApproved {
            recipient_name: None,
            workspace_name: workspace.name.clone(),
            url: format!("{}/weldreach", url.trim_end_matches('/')),
            limits: Some(ApprovedLimits {
                max_domains: access.limits.max_domains,
                max_mailboxes: access.limits.max_mailboxes,
                max_daily_sends: access.limits.max_daily_sends,
            }),
        };
        if let Err(cause) = send_access_email(effects.mail, access, |name| {
            let props = AccessApproved {
                recipient_name: name,
                ..props.clone()
            };
            weldsuite_emails::reach::access_approved(EmailLocale::En, &brand(), &props)
        })
        .await
        {
            warnings.push(format!(
                "The requester was not emailed about the approval ({cause}). Tell them yourself."
            ));
        }
    }
    warnings
}

/// Emails the requester the reason; returns what didn't happen.
async fn after_rejection(
    workspace: &WorkspaceRef,
    access: &AccessDetail,
    reason: &str,
    effects: Effects<'_>,
) -> Vec<String> {
    let url = effects
        .platform_url
        .map(|u| format!("{}/appstore/weldreach", u.trim_end_matches('/')));
    let result = send_access_email(effects.mail, access, |name| {
        weldsuite_emails::reach::access_rejected(
            EmailLocale::En,
            &brand(),
            &AccessRejected {
                recipient_name: name,
                workspace_name: workspace.name.clone(),
                reason: reason.to_owned(),
                url: url.clone(),
            },
        )
    })
    .await;
    match result {
        Ok(()) => Vec::new(),
        Err(cause) => vec![format!(
            "The requester was not emailed about the rejection ({cause}). Tell them yourself."
        )],
    }
}

fn brand() -> EmailBrand {
    EmailBrand::weldsuite("WeldReach")
}

/// Renders and sends to the requester; the error says why it wasn't sent.
async fn send_access_email(
    mail: Option<&dyn DynSystemMail>,
    access: &AccessDetail,
    render: impl FnOnce(
        Option<String>,
    ) -> Result<weldsuite_emails::RenderedEmail, weldsuite_emails::EmailError>,
) -> Result<(), String> {
    let (to, name) = requester_contact(access);
    let Some(to) = to else {
        return Err("no address to write to".to_owned());
    };
    let Some(mail) = mail else {
        return Err("SMTP_URL is not set".to_owned());
    };
    let rendered = render(name).map_err(|error| error.to_string())?;
    send_system_email(mail, SystemEmail::to(rendered, brand(), &to))
        .await
        .map(|_| ())
        .map_err(|error| {
            tracing::error!(%error, "admin access: email failed");
            format!("sending failed: {error}")
        })
}

/// Puts the app in the workspace's own database, as app-api's install does;
/// returns a warning when it couldn't.
async fn install_in_tenant(
    tenants: Option<&Workspaces>,
    workspace_id: &str,
    app_code: &str,
    installed_by: &str,
) -> Option<String> {
    let failed = |detail: &str| {
        Some(format!(
            "Approved, but installing {app_code} in the workspace failed ({detail}). \
             Its admins can install it from the App Store."
        ))
    };
    let Some(tenants) = tenants else {
        return failed("no tenant databases here");
    };
    let tenant = match tenants.tenant(workspace_id).await {
        Ok(tenant) => tenant,
        Err(error) => return failed(&error.to_string()),
    };
    match install(&tenant.db, app_code, installed_by).await {
        Ok(()) => None,
        Err(error) => {
            tracing::error!(%error, app_code, "admin access: install in the tenant failed");
            failed(&error.to_string())
        }
    }
}

async fn install(db: &PgPool, app_code: &str, installed_by: &str) -> Result<(), sqlx::Error> {
    let existing: Option<(String, bool, bool)> = sqlx::query_as(
        "select id, is_active, deleted_at is not null
         from workspace_installed_apps where app_code = $1 limit 1",
    )
    .bind(app_code)
    .fetch_optional(db)
    .await?;
    match existing {
        Some((_, true, false)) => Ok(()),
        Some((id, _, _)) => sqlx::query(
            "update workspace_installed_apps
             set is_active = true, deleted_at = null, installed_at = now(),
                 installed_by = $2, updated_at = now()
             where id = $1",
        )
        .bind(id)
        .bind(installed_by)
        .execute(db)
        .await
        .map(|_| ()),
        None => sqlx::query(
            "insert into workspace_installed_apps
                 (id, app_code, is_active, display_order, settings, installed_at, installed_by)
             values ($1, $2, true,
                     coalesce((select max(display_order) from workspace_installed_apps), -1) + 1,
                     '{}'::jsonb, now(), $3)
             on conflict do nothing",
        )
        .bind(generate_id("wia"))
        .bind(app_code)
        .bind(installed_by)
        .execute(db)
        .await
        .map(|_| ()),
    }
}

/// A change to WeldReach's limits.
#[derive(Debug, Clone, Copy)]
pub struct LimitsRequest<'a> {
    pub workspace: &'a str,
    pub app_code: &'a str,
    pub patch: &'a LimitsPatch,
    pub reason: &'a str,
    pub dry_run: bool,
}

/// What [`set_limits`] did, or would do.
#[derive(Debug, Clone)]
pub struct LimitsChange {
    pub workspace: WorkspaceRef,
    pub before: Limits,
    pub after: Limits,
    pub applied: bool,
}

/// `updateAppAccessLimits`: WeldReach's limits for one workspace. They apply
/// on the next request the module handles (after its cache).
pub async fn set_limits(
    master: &PgPool,
    actor: &Actor,
    request: LimitsRequest<'_>,
) -> StaffResult<LimitsChange> {
    let workspace = find_workspace(master, request.workspace).await?;
    let reason = checked_reason(request.reason)?;
    let entry = AuditEntry {
        workspace_id: Some(&workspace.id),
        target_type: "workspace",
        target_id: &workspace.id,
        action: "app_access.limits_update",
        actor_email: &actor.email,
        reason: Some(reason),
        details: Some(json!({ "appCode": request.app_code })),
    };
    if request.app_code != WELDREACH_APP_CODE {
        let message = "This app has no limits to edit.".to_owned();
        return Err(refuse(master, &entry, request.dry_run, message).await);
    }
    if request.patch.is_empty() {
        return Err(StaffError::refused(
            "Nothing to change: name at least one limit.",
        ));
    }
    let Some(current) = get(master, &workspace.id, request.app_code).await? else {
        return Err(refuse(master, &entry, request.dry_run, NOT_FOUND.to_owned()).await);
    };
    let after = match apply_limits(&current.limits, request.patch) {
        Ok(after) => after,
        Err(message) => return Err(refuse(master, &entry, request.dry_run, message).await),
    };
    let before = current.limits.clone();
    if request.dry_run {
        return Ok(LimitsChange {
            workspace,
            before,
            after,
            applied: false,
        });
    }

    let mut tx = master.begin().await?;
    sqlx::query("update workspace_app_access set limits = $2, updated_at = now() where id = $1")
        .bind(&current.id)
        .bind(after.to_json())
        .execute(&mut *tx)
        .await?;
    audit::record_success(
        &mut *tx,
        &AuditEntry {
            details: Some(json!({
                "appCode": request.app_code,
                "before": before.to_json(),
                "after": after.to_json(),
            })),
            ..entry.clone()
        },
    )
    .await?;
    tx.commit().await?;
    Ok(LimitsChange {
        workspace,
        before,
        after,
        applied: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(action: AccessAction, from: &str) -> Result<AccessUpdate, String> {
        plan_access_update(
            action,
            from,
            WELDREACH_APP_CODE,
            "Looks fine",
            "staff@weldsuite.org",
            true,
        )
    }

    /// The console's table (`app-access.test.ts`, "availableActions").
    #[test]
    fn each_status_offers_the_consoles_actions() {
        use AccessAction::{Approve, Reject, Revoke, Suspend, Unsuspend};
        let table: [(&str, &[AccessAction]); 6] = [
            (NO_ROW, &[Approve]),
            ("requested", &[Approve, Reject]),
            ("approved", &[Suspend, Revoke]),
            ("suspended", &[Unsuspend, Revoke]),
            ("rejected", &[Approve]),
            ("revoked", &[Approve]),
        ];
        for (status, expected) in table {
            assert_eq!(available_actions(status), expected, "{status}");
        }
        for status in STATUSES {
            assert!(!available_actions(status).is_empty(), "{status}");
        }
    }

    #[test]
    fn approving_records_the_reviewer_and_clears_the_reasons() {
        let update = plan(AccessAction::Approve, "requested").expect("allowed");
        assert_eq!(update.status, "approved");
        assert_eq!(update.reviewed_by, "staff@weldsuite.org");
        assert_eq!(update.rejection_reason, None);
        assert_eq!(update.suspended_reason, None);
    }

    #[test]
    fn approval_fills_the_default_limits_only_when_weldreach_has_none() {
        assert_eq!(
            plan(AccessAction::Approve, "requested").expect("ok").limits,
            Some(Limits::default())
        );
        let kept = plan_access_update(
            AccessAction::Approve,
            "requested",
            WELDREACH_APP_CODE,
            "fine",
            "s",
            false,
        );
        assert_eq!(kept.expect("ok").limits, None);
        let other = plan_access_update(
            AccessAction::Approve,
            "requested",
            "otherapp",
            "fine",
            "s",
            true,
        );
        assert_eq!(other.expect("ok").limits, None);
    }

    #[test]
    fn reject_and_suspend_keep_their_reason_and_revoke_keeps_none() {
        let rejected = plan(AccessAction::Reject, "requested").expect("ok");
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.rejection_reason.as_deref(), Some("Looks fine"));
        let suspended = plan(AccessAction::Suspend, "approved").expect("ok");
        assert_eq!(suspended.suspended_reason.as_deref(), Some("Looks fine"));
        let unsuspended = plan(AccessAction::Unsuspend, "suspended").expect("ok");
        assert_eq!(
            (unsuspended.status, unsuspended.suspended_reason),
            ("approved", None)
        );
        for from in ["approved", "suspended"] {
            let revoked = plan(AccessAction::Revoke, from).expect("ok");
            assert_eq!(revoked.status, "revoked");
            assert_eq!(
                (revoked.rejection_reason, revoked.suspended_reason),
                (None, None)
            );
        }
        assert_eq!(
            plan(AccessAction::Approve, "rejected").expect("ok").status,
            "approved"
        );
    }

    #[test]
    fn refusals_read_as_the_console_writes_them() {
        assert_eq!(
            plan(AccessAction::Reject, NO_ROW),
            Err("Cannot reject access that is not requested.".to_owned())
        );
        assert_eq!(
            plan(AccessAction::Suspend, "requested"),
            Err("Cannot suspend access that is requested.".to_owned())
        );
        let short = |reason: &str| {
            plan_access_update(
                AccessAction::Reject,
                "requested",
                "weldreach",
                reason,
                "s",
                true,
            )
        };
        assert!(short("  ok ").is_err());
        assert!(short("").is_err());
        assert!(short("ok!").is_ok());
    }

    #[test]
    fn domain_lists_split_lowercase_and_deduplicate() {
        assert_eq!(
            parse_domain_list("A.com, b.nl;\nc.co.uk  a.com"),
            (
                vec!["a.com".to_owned(), "b.nl".to_owned(), "c.co.uk".to_owned()],
                vec![]
            )
        );
        assert_eq!(
            parse_domain_list("acme.com.").0,
            vec!["acme.com".to_owned()]
        );
        assert_eq!(
            parse_domain_list("acme.com localhost -bad.com a_b.com https://x.com").1,
            vec!["localhost", "-bad.com", "a_b.com", "https://x.com"]
        );
        assert_eq!(parse_domain_list(" \n , "), (vec![], vec![]));
    }

    #[test]
    fn limits_change_only_what_is_named_and_are_checked() {
        let current = Limits::default();
        let patch = LimitsPatch {
            max_mailboxes: Some("20".to_owned()),
            allow_consumer_recipients: Some(true),
            force_allow_domains: Some("Acme.com\nbeta.nl".to_owned()),
            ..LimitsPatch::default()
        };
        let after = apply_limits(&current, &patch).expect("valid");
        assert_eq!(after.max_domains, 3);
        assert_eq!(after.max_mailboxes, 20);
        assert_eq!(after.max_daily_sends, 300);
        assert!(after.allow_consumer_recipients);
        assert_eq!(after.force_allow_domains, vec!["acme.com", "beta.nl"]);

        let zero = LimitsPatch {
            max_domains: Some("0".to_owned()),
            ..LimitsPatch::default()
        };
        assert_eq!(
            apply_limits(&current, &zero)
                .expect("zero switches it off")
                .max_domains,
            0
        );

        for (field, value) in [
            ("domains", "-1"),
            ("domains", "2.5"),
            ("mailboxes", "ten"),
            ("sends", ""),
            ("domains", "1001"),
            ("mailboxes", "10001"),
            ("sends", "1000001"),
        ] {
            let mut patch = LimitsPatch::default();
            let slot = match field {
                "domains" => &mut patch.max_domains,
                "mailboxes" => &mut patch.max_mailboxes,
                _ => &mut patch.max_daily_sends,
            };
            *slot = Some(value.to_owned());
            assert!(
                apply_limits(&current, &patch).is_err(),
                "{field} = {value:?}"
            );
        }

        let bad = LimitsPatch {
            force_allow_domains: Some("acme.com\nnot a domain".to_owned()),
            ..LimitsPatch::default()
        };
        let error = apply_limits(&current, &bad).expect_err("refused");
        assert!(
            error.starts_with("Not a domain name: not, a, domain"),
            "{error}"
        );
    }

    #[test]
    fn actions_parse_by_name() {
        for action in AccessAction::ORDER {
            assert_eq!(AccessAction::parse(action.as_str()), Some(action));
        }
        assert_eq!(AccessAction::parse("delete"), None);
    }
}
