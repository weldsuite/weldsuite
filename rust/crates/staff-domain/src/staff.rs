//! The install's staff roster: master `admin_users` (ADR SEC-014). On a
//! Kubernetes install a person may act through `weldsuite admin` only while
//! their email has an active row here; a `viewer` may only read.
//!
//! A row names two accounts of the same person (ADR SEC-018):
//! - `user_id`, their platform account, which Rust's WeldApps review gate
//!   matches. [`add`] fills it from an account with that email that belongs
//!   to a workspace, so adding someone who uses the platform also lets them
//!   review public apps, and adding them again catches up with an account
//!   they made since.
//! - `console_subject`, the account the admin console bound the row to on
//!   their first sign-in there (`apps/web/admin/lib/server/staff-roster.ts`),
//!   a separate account in the identity provider's staff organization. Only
//!   the console writes it.
//!
//! The first row can be added without an actor, while no active row exists;
//! after that only a superadmin adds or removes staff, as the console's
//! roles describe (`apps/web/admin/lib/roles.ts`).

use sea_orm::sea_query::{Alias, Expr, Func, OnConflict, Query};
use sea_orm::{
    ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};
use serde_json::json;
use sqlx::PgPool;
use time::PrimitiveDateTime;
use weldsuite_db::{OrmConn, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::master::enums::AdminRole;
use weldsuite_schema::master::{admin_users, user_workspaces, users};

use crate::audit::{self, AuditEntry};
use crate::{StaffError, StaffResult};

/// `admin_role`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaffRole {
    /// Everything, and adds or removes staff.
    Superadmin,
    /// Every staff action except the roster.
    Admin,
    /// Reads only.
    Viewer,
}

impl StaffRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Superadmin => "superadmin",
            Self::Admin => "admin",
            Self::Viewer => "viewer",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "superadmin" => Some(Self::Superadmin),
            "admin" => Some(Self::Admin),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }

    /// The `admin_role` value.
    fn stored(self) -> AdminRole {
        match self {
            Self::Superadmin => AdminRole::Superadmin,
            Self::Admin => AdminRole::Admin,
            Self::Viewer => AdminRole::Viewer,
        }
    }

    fn of(role: AdminRole) -> Self {
        match role {
            AdminRole::Superadmin => Self::Superadmin,
            AdminRole::Admin => Self::Admin,
            AdminRole::Viewer => Self::Viewer,
        }
    }
}

/// Who is acting: an active roster row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub email: String,
    pub role: StaffRole,
}

/// One roster row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaffMember {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub role: StaffRole,
    pub is_active: bool,
    /// The person's platform account (master `users`), which the WeldApps
    /// review gate matches; none until they belong to a workspace.
    pub user_id: Option<String>,
    /// The admin console's account for them, bound on their first sign-in
    /// there; none until then.
    pub console_subject: Option<String>,
    pub invited_by: Option<String>,
    pub invited_at: Option<String>,
}

/// Lowercased and trimmed, or why it isn't an email address.
pub fn normalize_email(value: &str) -> StaffResult<String> {
    let email = value.trim().to_lowercase();
    let valid = email.len() <= 255
        && !email.chars().any(char::is_whitespace)
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.contains('@')
        });
    if valid {
        Ok(email)
    } else {
        Err(StaffError::refused(format!(
            "\"{}\" is not an email address.",
            value.trim()
        )))
    }
}

/// `to_char(invited_at, 'YYYY-MM-DD"T"HH24:MI:SS')`.
fn invited_at(at: PrimitiveDateTime) -> Option<String> {
    let format = time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");
    at.format(format).ok()
}

fn member(row: admin_users::Model) -> StaffMember {
    StaffMember {
        id: row.id,
        email: row.email,
        name: row.name,
        role: StaffRole::of(row.role),
        is_active: row.is_active,
        user_id: row.user_id,
        console_subject: row.console_subject,
        invited_by: row.invited_by,
        invited_at: invited_at(row.invited_at),
    }
}

/// The person's platform account: a master `users` row with this email that
/// belongs to a workspace. The identity sync copies every account of the
/// provider into `users`, the staff organization's too, and those share the
/// email; a staff account is in no workspace and may already be a row's
/// `console_subject`, so neither is taken. The oldest wins if there are more.
async fn platform_account(master: &PgPool, email: &str) -> StaffResult<Option<String>> {
    use sea_orm::ExprTrait as _;
    let user_id = Expr::col((users::Entity, users::Column::Id));
    let in_a_workspace = Query::select()
        .expr(Expr::val(1))
        .from(user_workspaces::Entity)
        .and_where(Expr::col((user_workspaces::Entity, user_workspaces::Column::UserId)).eq(user_id.clone()))
        .to_owned();
    let a_console_account = Query::select()
        .expr(Expr::val(1))
        .from(admin_users::Entity)
        .and_where(Expr::col((admin_users::Entity, admin_users::Column::ConsoleSubject)).eq(user_id))
        .to_owned();
    Ok(users::Entity::find()
        .select_only()
        .column(users::Column::Id)
        .filter(Expr::from(Func::lower(Expr::col((users::Entity, users::Column::Email)))).eq(email))
        .filter(users::Column::IsActive.eq(true))
        .filter(Expr::exists(in_a_workspace))
        .filter(Expr::not_exists(a_console_account))
        .order_by_asc(users::Column::CreatedAt)
        .order_by_asc(users::Column::Id)
        .into_tuple()
        .one(&orm(master))
        .await?)
}

/// `user_id` after [`add`]: the platform account found now, else the one the
/// row had, unless that is the row's console account (which an install set
/// up before ADR SEC-018 could hold there).
fn kept_user_id(found: Option<String>, before: Option<&StaffMember>) -> Option<String> {
    found.or_else(|| {
        before.and_then(|b| {
            b.user_id
                .clone()
                .filter(|id| b.console_subject.as_deref() != Some(id.as_str()))
        })
    })
}

/// Every roster row, active first.
pub async fn list(master: &PgPool) -> StaffResult<Vec<StaffMember>> {
    let rows = admin_users::Entity::find()
        .order_by_desc(admin_users::Column::IsActive)
        .order_by_asc(admin_users::Column::Email)
        .all(&orm(master))
        .await?;
    Ok(rows.into_iter().map(member).collect())
}

async fn find(master: &PgPool, email: &str) -> StaffResult<Option<StaffMember>> {
    let row = admin_users::Entity::find()
        .filter(admin_users::Column::Email.eq(email))
        .one(&orm(master))
        .await?;
    Ok(row.map(member))
}

/// The acting person, from an active roster row.
pub async fn actor(master: &PgPool, email: &str) -> StaffResult<Actor> {
    let email = normalize_email(email)?;
    match find(master, &email).await? {
        Some(row) if row.is_active => Ok(Actor {
            email: row.email,
            role: row.role,
        }),
        _ => Err(StaffError::refused(format!(
            "{email} is not on this install's staff list (admin_users). \
             A superadmin adds people with `weldsuite admin staff add`."
        ))),
    }
}

/// [`actor`], refusing a viewer: for every write.
pub async fn writer(master: &PgPool, email: &str) -> StaffResult<Actor> {
    let actor = actor(master, email).await?;
    if actor.role == StaffRole::Viewer {
        return Err(StaffError::refused(format!(
            "{} has read-only access (viewer).",
            actor.email
        )));
    }
    Ok(actor)
}

/// Whether `actor` may change the roster, given how many active rows it has.
/// Nobody acting is allowed only while the roster is empty (the first
/// superadmin); otherwise a superadmin must act.
pub fn may_change_roster(actor: Option<&Actor>, active_rows: i64) -> Result<(), String> {
    match actor {
        None if active_rows == 0 => Ok(()),
        None => Err("The staff list is not empty: name who is acting with --as.".to_owned()),
        Some(actor) if actor.role == StaffRole::Superadmin => Ok(()),
        Some(actor) => Err(format!(
            "Only a superadmin adds or removes staff; {} is {}.",
            actor.email,
            actor.role.as_str()
        )),
    }
}

/// Whether a change leaves at least one active superadmin, without whom
/// nobody could change the list again. `before` is the row being changed,
/// `stays_superadmin` whether it is an active superadmin afterwards, and
/// `active_superadmins` how many there are now.
pub fn keeps_a_superadmin(
    before: Option<&StaffMember>,
    stays_superadmin: bool,
    active_superadmins: i64,
) -> Result<(), String> {
    if takes_a_superadmin_away(before, stays_superadmin) && active_superadmins <= 1 {
        return Err("That is the last superadmin; add another one first.".to_owned());
    }
    Ok(())
}

/// The change turns an active superadmin into something else.
fn takes_a_superadmin_away(before: Option<&StaffMember>, stays_superadmin: bool) -> bool {
    !stays_superadmin && before.is_some_and(|b| b.is_active && b.role == StaffRole::Superadmin)
}

/// [`keeps_a_superadmin`], counting the active superadmins only when the
/// change takes one away.
async fn check_keeps_a_superadmin(
    master: &PgPool,
    before: Option<&StaffMember>,
    stays_superadmin: bool,
) -> StaffResult<()> {
    if !takes_a_superadmin_away(before, stays_superadmin) {
        return Ok(());
    }
    let superadmins = admin_users::Entity::find()
        .filter(admin_users::Column::IsActive.eq(true))
        .filter(admin_users::Column::Role.eq(AdminRole::Superadmin))
        .count(&orm(master))
        .await?;
    keeps_a_superadmin(
        before,
        stays_superadmin,
        i64::try_from(superadmins).unwrap_or(i64::MAX),
    )
    .map_err(StaffError::Refused)
}

async fn active_rows(master: &PgPool) -> StaffResult<i64> {
    let n = admin_users::Entity::find()
        .filter(admin_users::Column::IsActive.eq(true))
        .count(&orm(master))
        .await?;
    Ok(i64::try_from(n).unwrap_or(i64::MAX))
}

/// A person to add, or to change the role of.
#[derive(Debug, Clone)]
pub struct NewStaff<'a> {
    pub email: &'a str,
    pub role: StaffRole,
    pub name: Option<&'a str>,
}

/// What [`add`] or [`remove`] did, or would do.
#[derive(Debug, Clone)]
pub struct RosterChange {
    pub before: Option<StaffMember>,
    /// The row after the change; for a dry run, the row as it would be.
    pub after: StaffMember,
    pub applied: bool,
}

/// Adds a person, or reactivates them or changes their role. The first one
/// may be added with `actor` `None` (bootstrap); the first must be a
/// superadmin, or nobody could add the next.
pub async fn add(
    master: &PgPool,
    actor: Option<&Actor>,
    staff: &NewStaff<'_>,
    reason: &str,
    dry_run: bool,
) -> StaffResult<RosterChange> {
    let email = normalize_email(staff.email)?;
    let reason = checked_reason(reason)?;
    let active = active_rows(master).await?;
    may_change_roster(actor, active).map_err(StaffError::Refused)?;
    if actor.is_none() && staff.role != StaffRole::Superadmin {
        return Err(StaffError::refused(
            "The first person on the staff list must be a superadmin (--role superadmin).",
        ));
    }
    let actor_email = actor.map_or(email.as_str(), |a| a.email.as_str());
    let before = find(master, &email).await?;
    // Changing a superadmin's role is a demotion too.
    check_keeps_a_superadmin(master, before.as_ref(), staff.role == StaffRole::Superadmin).await?;
    let name = staff.name.map(str::trim).filter(|n| !n.is_empty());
    // For the WeldApps review gate; the console's account is never set here.
    let user_id = kept_user_id(platform_account(master, &email).await?, before.as_ref());

    if dry_run {
        let after = StaffMember {
            id: before.as_ref().map_or_else(String::new, |b| b.id.clone()),
            email: email.clone(),
            name: name
                .map(str::to_owned)
                .or_else(|| before.as_ref().and_then(|b| b.name.clone())),
            role: staff.role,
            is_active: true,
            user_id,
            console_subject: before.as_ref().and_then(|b| b.console_subject.clone()),
            invited_by: Some(actor_email.to_owned()),
            invited_at: None,
        };
        return Ok(RosterChange {
            before,
            after,
            applied: false,
        });
    }

    let mut tx = master.begin().await?;
    let db = OrmConn::new(&mut tx);
    // `invited_at` is the column's default, `now()`.
    let row = admin_users::Entity::insert(admin_users::ActiveModel {
        id: Set(generate_id("adm")),
        email: Set(email.clone()),
        name: Set(name.map(str::to_owned)),
        role: Set(staff.role.stored()),
        is_active: Set(true),
        user_id: Set(user_id),
        invited_by: Set(Some(actor_email.to_owned())),
        ..Default::default()
    })
    .on_conflict(rejoin_on_email())
    .exec_with_returning(&db)
    .await?;
    let after = member(row);
    audit::record_success(
        &db,
        &AuditEntry {
            workspace_id: None,
            target_type: "admin_user",
            target_id: &email,
            action: "staff.add",
            actor_email,
            reason: Some(reason),
            details: Some(json!({
                "role": staff.role.as_str(),
                "before": before.as_ref().map(|b| json!({ "role": b.role.as_str(), "isActive": b.is_active })),
                "bootstrap": actor.is_none(),
            })),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(RosterChange {
        before,
        after,
        applied: true,
    })
}

/// `on conflict (email) do update`: the new role, active again, the name
/// kept when none is given, the platform account found now.
fn rejoin_on_email() -> OnConflict {
    use admin_users::Column;
    OnConflict::column(Column::Email)
        .update_columns([Column::Role, Column::UserId])
        .value(Column::IsActive, Expr::value(true))
        .value(
            Column::Name,
            Func::coalesce([
                Expr::col((Alias::new("excluded"), Column::Name)),
                Expr::col((admin_users::Entity, Column::Name)),
            ]),
        )
        .value(Column::UpdatedAt, Expr::current_timestamp())
        .to_owned()
}

/// Takes a person off the roster (`is_active` false; the row stays for the
/// trail). The last active superadmin stays.
pub async fn remove(
    master: &PgPool,
    actor: &Actor,
    email: &str,
    reason: &str,
    dry_run: bool,
) -> StaffResult<RosterChange> {
    let email = normalize_email(email)?;
    let reason = checked_reason(reason)?;
    may_change_roster(Some(actor), active_rows(master).await?).map_err(StaffError::Refused)?;
    let Some(before) = find(master, &email).await?.filter(|row| row.is_active) else {
        return Err(StaffError::refused(format!(
            "{email} is not on the staff list."
        )));
    };
    check_keeps_a_superadmin(master, Some(&before), false).await?;
    let mut after = before.clone();
    after.is_active = false;
    if dry_run {
        return Ok(RosterChange {
            before: Some(before),
            after,
            applied: false,
        });
    }

    let mut tx = master.begin().await?;
    let db = OrmConn::new(&mut tx);
    admin_users::Entity::update_many()
        .col_expr(admin_users::Column::IsActive, Expr::value(false))
        .col_expr(admin_users::Column::UpdatedAt, Expr::current_timestamp())
        .filter(admin_users::Column::Id.eq(before.id.as_str()))
        .exec(&db)
        .await?;
    audit::record_success(
        &db,
        &AuditEntry {
            workspace_id: None,
            target_type: "admin_user",
            target_id: &email,
            action: "staff.remove",
            actor_email: &actor.email,
            reason: Some(reason),
            details: Some(json!({ "role": before.role.as_str() })),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(RosterChange {
        before: Some(before),
        after,
        applied: true,
    })
}

/// Every write needs a reason of at least
/// [`MIN_REASON_LENGTH`](crate::access::MIN_REASON_LENGTH) characters.
pub(crate) fn checked_reason(reason: &str) -> StaffResult<&str> {
    let reason = reason.trim();
    if reason.chars().count() < crate::access::MIN_REASON_LENGTH {
        return Err(StaffError::refused(format!(
            "Give a reason of at least {} characters.",
            crate::access::MIN_REASON_LENGTH
        )));
    }
    Ok(reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(role: StaffRole) -> Actor {
        Actor {
            email: "a@weldsuite.org".to_owned(),
            role,
        }
    }

    #[test]
    fn roles_parse_and_print() {
        for role in [StaffRole::Superadmin, StaffRole::Admin, StaffRole::Viewer] {
            assert_eq!(StaffRole::parse(role.as_str()), Some(role));
        }
        assert_eq!(StaffRole::parse(" Admin "), Some(StaffRole::Admin));
        assert_eq!(StaffRole::parse("owner"), None);
    }

    #[test]
    fn emails_are_lowercased_and_checked() {
        assert_eq!(
            normalize_email(" Gert@WeldSuite.org ").ok().as_deref(),
            Some("gert@weldsuite.org")
        );
        for bad in [
            "",
            "gert",
            "gert@",
            "@weldsuite.org",
            "a b@weldsuite.org",
            "a@localhost",
            "a@b@c.org",
        ] {
            assert!(normalize_email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_a_superadmin_changes_the_roster_once_it_has_rows() {
        assert!(may_change_roster(None, 0).is_ok());
        assert!(may_change_roster(None, 1).is_err());
        assert!(may_change_roster(Some(&actor(StaffRole::Superadmin)), 3).is_ok());
        assert!(may_change_roster(Some(&actor(StaffRole::Admin)), 3).is_err());
        assert!(may_change_roster(Some(&actor(StaffRole::Viewer)), 3).is_err());
    }

    #[test]
    fn the_last_superadmin_is_neither_removed_nor_demoted() {
        let member = |role, is_active| StaffMember {
            id: "adm_1".to_owned(),
            email: "a@weldsuite.org".to_owned(),
            name: None,
            role,
            is_active,
            user_id: None,
            console_subject: None,
            invited_by: None,
            invited_at: None,
        };
        let superadmin = member(StaffRole::Superadmin, true);
        // Removing or demoting the only one is refused; with another one left it is fine.
        assert!(keeps_a_superadmin(Some(&superadmin), false, 1).is_err());
        assert!(keeps_a_superadmin(Some(&superadmin), false, 2).is_ok());
        // Staying a superadmin, or changing someone who isn't an active one, never is.
        assert!(keeps_a_superadmin(Some(&superadmin), true, 1).is_ok());
        assert!(keeps_a_superadmin(Some(&member(StaffRole::Admin, true)), false, 1).is_ok());
        assert!(keeps_a_superadmin(Some(&member(StaffRole::Superadmin, false)), false, 1).is_ok());
        assert!(keeps_a_superadmin(None, false, 0).is_ok());
    }

    #[test]
    fn the_platform_account_found_now_wins_and_a_console_account_is_dropped() {
        let row = |user_id: Option<&str>, console_subject: Option<&str>| StaffMember {
            id: "adm_1".to_owned(),
            email: "a@weldsuite.org".to_owned(),
            name: None,
            role: StaffRole::Admin,
            is_active: true,
            user_id: user_id.map(str::to_owned),
            console_subject: console_subject.map(str::to_owned),
            invited_by: None,
            invited_at: None,
        };
        let some = |id: &str| Some(id.to_owned());
        // A new row takes what was found, or nothing.
        assert_eq!(kept_user_id(some("platform"), None), some("platform"));
        assert_eq!(kept_user_id(None, None), None);
        // Adding again catches up with the account found now.
        assert_eq!(
            kept_user_id(some("platform-2"), Some(&row(Some("platform"), None))),
            some("platform-2")
        );
        // Nothing found: the row keeps its platform account...
        assert_eq!(
            kept_user_id(None, Some(&row(Some("platform"), Some("staff")))),
            some("platform")
        );
        // ...but not the console's account, which the console once bound there.
        assert_eq!(
            kept_user_id(None, Some(&row(Some("staff"), Some("staff")))),
            None
        );
    }

    #[test]
    fn a_reason_needs_three_characters() {
        assert!(checked_reason("  ok ").is_err());
        assert_eq!(checked_reason(" ok! ").ok(), Some("ok!"));
    }
}
