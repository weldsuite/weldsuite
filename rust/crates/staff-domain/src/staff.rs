//! The install's staff roster: master `admin_users` (ADR SEC-014). On a
//! Kubernetes install a person may act through `weldsuite admin` only while
//! their email has an active row here; a `viewer` may only read. The same
//! table is what Rust's WeldApps review gate reads (`user_id`), so adding
//! someone who already signed in also lets them review public apps.
//!
//! The first row can be added without an actor, while no active row exists;
//! after that only a superadmin adds or removes staff, as the console's
//! roles describe (`apps/web/admin/lib/roles.ts`).

use serde_json::json;
use sqlx::PgPool;
use weldsuite_kit::generate_id;

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
    /// The person's user id once they have one on this install (from master
    /// `users`), which the WeldApps review gate matches.
    pub user_id: Option<String>,
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

/// The columns of [`MemberRow`], for `concat!` (sqlx takes only static SQL).
macro_rules! member_columns {
    () => {
        "id, email, name, role::text, is_active, user_id, invited_by, \
         to_char(invited_at, 'YYYY-MM-DD\"T\"HH24:MI:SS')"
    };
}

type MemberRow = (
    String,
    String,
    Option<String>,
    String,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn member(row: MemberRow) -> StaffMember {
    let (id, email, name, role, is_active, user_id, invited_by, invited_at) = row;
    StaffMember {
        id,
        email,
        name,
        role: StaffRole::parse(&role).unwrap_or(StaffRole::Viewer),
        is_active,
        user_id,
        invited_by,
        invited_at,
    }
}

/// Every roster row, active first.
pub async fn list(master: &PgPool) -> StaffResult<Vec<StaffMember>> {
    let rows: Vec<MemberRow> = sqlx::query_as(concat!(
        "select ",
        member_columns!(),
        " from admin_users order by is_active desc, email"
    ))
    .fetch_all(master)
    .await?;
    Ok(rows.into_iter().map(member).collect())
}

async fn find(master: &PgPool, email: &str) -> StaffResult<Option<StaffMember>> {
    let row: Option<MemberRow> = sqlx::query_as(concat!(
        "select ",
        member_columns!(),
        " from admin_users where email = $1 limit 1"
    ))
    .bind(email)
    .fetch_optional(master)
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

async fn active_rows(master: &PgPool) -> StaffResult<i64> {
    Ok(
        sqlx::query_scalar("select count(*) from admin_users where is_active")
            .fetch_one(master)
            .await?,
    )
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
    let name = staff.name.map(str::trim).filter(|n| !n.is_empty());

    if dry_run {
        let after = StaffMember {
            id: before.as_ref().map_or_else(String::new, |b| b.id.clone()),
            email: email.clone(),
            name: name
                .map(str::to_owned)
                .or_else(|| before.as_ref().and_then(|b| b.name.clone())),
            role: staff.role,
            is_active: true,
            user_id: before.as_ref().and_then(|b| b.user_id.clone()),
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
    // `user_id`: the person's id on this install when they have signed in
    // already (master `users`), for the WeldApps review gate.
    let row: MemberRow = sqlx::query_as(concat!(
        "insert into admin_users (id, email, name, role, is_active, user_id, invited_by, invited_at)
         values ($1, $2, $3, $4::admin_role, true,
                 (select id from users where lower(email) = $2 limit 1), $5, now())
         on conflict (email) do update set
             role = excluded.role,
             is_active = true,
             name = coalesce(excluded.name, admin_users.name),
             user_id = coalesce(admin_users.user_id, excluded.user_id),
             updated_at = now()
         returning ",
        member_columns!()
    ))
    .bind(generate_id("adm"))
    .bind(&email)
    .bind(name)
    .bind(staff.role.as_str())
    .bind(actor_email)
    .fetch_one(&mut *tx)
    .await?;
    let after = member(row);
    audit::record_success(
        &mut *tx,
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
    if before.role == StaffRole::Superadmin {
        let superadmins: i64 = sqlx::query_scalar(
            "select count(*) from admin_users where is_active and role = 'superadmin'",
        )
        .fetch_one(master)
        .await?;
        if superadmins <= 1 {
            return Err(StaffError::refused(
                "That is the last superadmin; add another one first.",
            ));
        }
    }
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
    sqlx::query("update admin_users set is_active = false, updated_at = now() where id = $1")
        .bind(&before.id)
        .execute(&mut *tx)
        .await?;
    audit::record_success(
        &mut *tx,
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
    fn a_reason_needs_three_characters() {
        assert!(checked_reason("  ok ").is_err());
        assert_eq!(checked_reason(" ok! ").ok(), Some("ok!"));
    }
}
