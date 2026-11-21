//! Shoppers and B2B buyers (ADR COM-012).
//!
//! A shopper is a WeldCRM person: found by email, or made with
//! `in_crm = false` so web shoppers do not flood the CRM grid. A B2B buyer is
//! a person linked to a company (`person_companies`) with a commerce role in
//! `commerce_buyers` (`buyer`, `approver`, `admin`) and an optional per-order
//! spend limit. A company's `commerce_company_settings` hold the approval
//! threshold.
//!
//! Every function runs on the caller's connection (inside the caller's
//! transaction where it writes more than one row); none sends anything or
//! publishes an event.

use serde_json::{Value, json};
use sqlx::PgConnection;
use weldsuite_kit::generate_id;

use crate::error::Error;
use crate::money::{self, Cents};

/// The roles of a buyer, weakest first.
pub const ROLES: [&str; 3] = ["buyer", "approver", "admin"];
/// The statuses a buyer may be set to.
pub const STATUSES: [&str; 3] = ["invited", "active", "disabled"];

const TS: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'";

// ── people ──────────────────────────────────────────────────────────────────

/// A shopper as the CRM knows them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub id: String,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
}

impl Person {
    /// The name to show: first and last name, else the email.
    #[must_use]
    pub fn display(&self) -> String {
        display(
            self.first_name.as_deref(),
            self.last_name.as_deref(),
            &self.email,
        )
    }
}

type PersonRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn person_of(row: PersonRow) -> Person {
    Person {
        id: row.0,
        email: row.1.unwrap_or_default(),
        first_name: row.2,
        last_name: row.3,
        phone: row.4,
    }
}

const PERSON_COLUMNS: &str =
    "id, email, first_name, last_name, coalesce(mobile_phone, direct_phone)";

/// The person with this email (the oldest, when there are several).
///
/// # Errors
/// A failed statement.
pub async fn find_person(
    conn: &mut PgConnection,
    email: &str,
) -> Result<Option<Person>, sqlx::Error> {
    let row: Option<PersonRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {PERSON_COLUMNS} from people where lower(email) = lower($1) \
           and deleted_at is null order by created_at asc, id asc limit 1"
    )))
    .bind(email)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(person_of))
}

/// A person by id.
///
/// # Errors
/// A failed statement.
pub async fn person(conn: &mut PgConnection, id: &str) -> Result<Option<Person>, sqlx::Error> {
    let row: Option<PersonRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {PERSON_COLUMNS} from people where id = $1 and deleted_at is null"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(person_of))
}

fn display(first: Option<&str>, last: Option<&str>, email: &str) -> String {
    let name = [first, last]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        email.to_owned()
    } else {
        name
    }
}

/// The person with this email, made when there is none: hidden from the CRM
/// grid (`in_crm = false`) until the merchant wants them there. Run inside a
/// transaction: two first sign-ins of one address make one person.
///
/// # Errors
/// A failed statement.
pub async fn find_or_create_person(
    conn: &mut PgConnection,
    email: &str,
    first_name: Option<&str>,
    last_name: Option<&str>,
    owner: &str,
) -> Result<Person, sqlx::Error> {
    sqlx::query("select pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("weldcommerce:person:{}", email.to_lowercase()))
        .execute(&mut *conn)
        .await?;
    if let Some(found) = find_person(conn, email).await? {
        return Ok(found);
    }
    let id = generate_id("per");
    let name = display(first_name, last_name, email);
    sqlx::query(
        "insert into people (id, display_name, full_name, first_name, last_name, email, in_crm, \
           source, owner_id) values ($1, $2, $2, $3, $4, $5, false, 'weldcommerce', $6)",
    )
    .bind(&id)
    .bind(&name)
    .bind(first_name.filter(|n| !n.trim().is_empty()))
    .bind(last_name.filter(|n| !n.trim().is_empty()))
    .bind(email)
    .bind(owner)
    .execute(&mut *conn)
    .await?;
    Ok(Person {
        id,
        email: email.to_owned(),
        first_name: first_name.map(str::to_owned),
        last_name: last_name.map(str::to_owned),
        phone: None,
    })
}

/// A change to a shopper's own details; `Some(None)` clears.
#[derive(Debug, Default, Clone)]
#[allow(
    clippy::option_option,
    reason = "a patch field: absent, null or a value"
)]
pub struct Profile {
    pub first_name: Option<Option<String>>,
    pub last_name: Option<Option<String>>,
    pub phone: Option<Option<String>>,
}

/// Write the shopper's details; the display name follows the names.
///
/// # Errors
/// A failed statement.
pub async fn update_profile(
    conn: &mut PgConnection,
    id: &str,
    profile: &Profile,
) -> Result<Option<Person>, sqlx::Error> {
    let Some(current) = person(conn, id).await? else {
        return Ok(None);
    };
    let first = profile
        .first_name
        .clone()
        .unwrap_or_else(|| current.first_name.clone());
    let last = profile
        .last_name
        .clone()
        .unwrap_or_else(|| current.last_name.clone());
    let phone = profile
        .phone
        .clone()
        .unwrap_or_else(|| current.phone.clone());
    let name = display(first.as_deref(), last.as_deref(), &current.email);
    sqlx::query(
        "update people set first_name = $2, last_name = $3, full_name = $4, display_name = $4, \
           mobile_phone = $5, updated_at = now() at time zone 'utc' where id = $1",
    )
    .bind(id)
    .bind(&first)
    .bind(&last)
    .bind(&name)
    .bind(&phone)
    .execute(&mut *conn)
    .await?;
    person(conn, id).await
}

// ── buyers ──────────────────────────────────────────────────────────────────

fn buyer_select() -> String {
    format!(
        "select jsonb_build_object('id', b.id, 'personId', b.person_id, 'companyId', b.company_id, \
           'name', p.display_name, 'email', p.email, 'role', b.role, \
           'spendLimit', b.spend_limit::text, 'spendLimitCurrency', b.spend_limit_currency, \
           'status', b.status, 'invitedAt', to_char(b.invited_at, {TS}), \
           'acceptedAt', to_char(b.accepted_at, {TS}), \
           'createdAt', to_char(b.created_at, {TS}), 'updatedAt', to_char(b.updated_at, {TS})) \
         from commerce_buyers b join people p on p.id = b.person_id \
         where b.deleted_at is null"
    )
}

/// The buyers, newest last; filtered by company and/or person.
///
/// # Errors
/// A failed statement.
pub async fn buyers(
    conn: &mut PgConnection,
    company_id: Option<&str>,
    person_id: Option<&str>,
) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{} and ($1::text is null or b.company_id = $1) and ($2::text is null or b.person_id = $2) \
         order by b.created_at asc, b.id asc",
        buyer_select()
    )))
    .bind(company_id)
    .bind(person_id)
    .fetch_all(&mut *conn)
    .await
}

/// One buyer.
///
/// # Errors
/// A failed statement.
pub async fn buyer(conn: &mut PgConnection, id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{} and b.id = $1",
        buyer_select()
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
}

/// A buyer of a company by id, as stored (no join).
async fn buyer_row(
    conn: &mut PgConnection,
    id: &str,
) -> Result<Option<(String, String, String, String)>, sqlx::Error> {
    sqlx::query_as(
        "select company_id, person_id, role, status from commerce_buyers \
         where id = $1 and deleted_at is null for update",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
}

/// A buyer to add to a company.
#[derive(Debug, Clone)]
pub struct NewBuyer<'a> {
    pub company_id: &'a str,
    pub email: &'a str,
    pub first_name: Option<&'a str>,
    pub last_name: Option<&'a str>,
    pub role: &'a str,
    pub spend_limit: Option<Cents>,
    pub spend_limit_currency: Option<&'a str>,
    pub invited_by: &'a str,
}

/// Add a buyer: the person is found by email or made (`in_crm = false`), linked to
/// the company (`person_companies`) and invited. Returns the buyer.
///
/// # Errors
/// [`Error::NotFound`] for a company that is gone, [`Error::BuyerExists`]
/// when the person is a buyer of the company already, [`Error::Invalid`].
pub async fn create_buyer(conn: &mut PgConnection, new: &NewBuyer<'_>) -> Result<Value, Error> {
    check_limit(new.spend_limit, new.spend_limit_currency)?;
    if !ROLES.contains(&new.role) {
        return Err(Error::invalid("role", "Must be buyer, approver or admin"));
    }
    let company: Option<String> =
        sqlx::query_scalar("select id from companies where id = $1 and deleted_at is null")
            .bind(new.company_id)
            .fetch_optional(&mut *conn)
            .await?;
    if company.is_none() {
        return Err(Error::not_found("Company", new.company_id));
    }
    let person = find_or_create_person(
        conn,
        new.email,
        new.first_name,
        new.last_name,
        new.invited_by,
    )
    .await?;
    let exists: bool = sqlx::query_scalar(
        "select exists (select 1 from commerce_buyers where person_id = $1 and company_id = $2 \
           and deleted_at is null)",
    )
    .bind(&person.id)
    .bind(new.company_id)
    .fetch_one(&mut *conn)
    .await?;
    if exists {
        return Err(Error::BuyerExists);
    }
    let linked: bool = sqlx::query_scalar(
        "select exists (select 1 from person_companies where person_id = $1 and company_id = $2 \
           and ended_at is null)",
    )
    .bind(&person.id)
    .bind(new.company_id)
    .fetch_one(&mut *conn)
    .await?;
    if !linked {
        sqlx::query(
            "insert into person_companies (id, person_id, company_id, is_primary, started_at) \
             values ($1, $2, $3, not exists (select 1 from person_companies \
               where person_id = $2 and is_primary and ended_at is null), now() at time zone 'utc')",
        )
        .bind(generate_id("pc"))
        .bind(&person.id)
        .bind(new.company_id)
        .execute(&mut *conn)
        .await?;
    }
    let id = generate_id("cbuy");
    sqlx::query(
        "insert into commerce_buyers (id, person_id, company_id, role, spend_limit, \
           spend_limit_currency, status, invited_by, invited_at) \
         values ($1, $2, $3, $4, $5::numeric, $6, 'invited', $7, now() at time zone 'utc')",
    )
    .bind(&id)
    .bind(&person.id)
    .bind(new.company_id)
    .bind(new.role)
    .bind(new.spend_limit.map(money::format))
    .bind(new.spend_limit.and(new.spend_limit_currency))
    .bind(new.invited_by)
    .execute(&mut *conn)
    .await?;
    buyer(conn, &id)
        .await?
        .ok_or_else(|| Error::not_found("Buyer", id))
}

/// A spend limit is an amount above zero with its currency.
fn check_limit(limit: Option<Cents>, currency: Option<&str>) -> Result<(), Error> {
    match (limit, currency) {
        (Some(amount), _) if amount <= 0 => {
            Err(Error::invalid("spendLimit", "Must be an amount above zero"))
        }
        (Some(_), None) => Err(Error::invalid(
            "spendLimitCurrency",
            "A spend limit needs its currency",
        )),
        (Some(_), Some(code))
            if code.len() != 3 || !code.chars().all(|c| c.is_ascii_alphabetic()) =>
        {
            Err(Error::invalid(
                "spendLimitCurrency",
                "Must be a 3-letter currency code",
            ))
        }
        _ => Ok(()),
    }
}

/// A change to a buyer; `spend_limit` `Some(None)` clears limit and currency.
#[derive(Debug, Default, Clone)]
#[allow(
    clippy::option_option,
    reason = "a patch field: absent, null or a value"
)]
pub struct BuyerPatch {
    pub role: Option<String>,
    pub spend_limit: Option<Option<(Cents, String)>>,
    pub status: Option<String>,
}

/// How many other admins the company keeps (invited ones count, disabled do not).
async fn other_admins(
    conn: &mut PgConnection,
    company_id: &str,
    except: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(*) from commerce_buyers where company_id = $1 and id <> $2 \
           and role = 'admin' and status <> 'disabled' and deleted_at is null",
    )
    .bind(company_id)
    .bind(except)
    .fetch_one(&mut *conn)
    .await
}

/// Change a buyer. With `keep_an_admin` (the storefront), the last admin of
/// a company cannot lose the role, be disabled or be removed.
///
/// # Errors
/// [`Error::NotFound`], [`Error::LastAdmin`], [`Error::Invalid`].
pub async fn update_buyer(
    conn: &mut PgConnection,
    id: &str,
    patch: &BuyerPatch,
    keep_an_admin: bool,
) -> Result<Value, Error> {
    let (company_id, _, role, status) = buyer_row(conn, id)
        .await?
        .ok_or_else(|| Error::not_found("Buyer", id))?;
    if let Some(new_role) = &patch.role
        && !ROLES.contains(&new_role.as_str())
    {
        return Err(Error::invalid("role", "Must be buyer, approver or admin"));
    }
    if let Some(new_status) = &patch.status
        && !STATUSES.contains(&new_status.as_str())
    {
        return Err(Error::invalid(
            "status",
            "Must be invited, active or disabled",
        ));
    }
    let new_role = patch.role.as_deref().unwrap_or(&role);
    let new_status = patch.status.as_deref().unwrap_or(&status);
    let loses_admin = role == "admin"
        && status != "disabled"
        && (new_role != "admin" || new_status == "disabled");
    if keep_an_admin && loses_admin && other_admins(conn, &company_id, id).await? == 0 {
        return Err(Error::LastAdmin);
    }
    if let Some(Some((amount, currency))) = &patch.spend_limit {
        check_limit(Some(*amount), Some(currency))?;
    }
    sqlx::query(
        "update commerce_buyers set role = $2, status = $3, \
           spend_limit = case when $4 then $5::numeric else spend_limit end, \
           spend_limit_currency = case when $4 then $6 else spend_limit_currency end, \
           accepted_at = case when $3 = 'active' and accepted_at is null \
             then now() at time zone 'utc' else accepted_at end, \
           updated_at = now() at time zone 'utc' where id = $1",
    )
    .bind(id)
    .bind(new_role)
    .bind(new_status)
    .bind(patch.spend_limit.is_some())
    .bind(
        patch
            .spend_limit
            .as_ref()
            .and_then(|limit| limit.as_ref())
            .map(|(amount, _)| money::format(*amount)),
    )
    .bind(
        patch
            .spend_limit
            .as_ref()
            .and_then(|limit| limit.as_ref())
            .map(|(_, currency)| currency.to_ascii_uppercase()),
    )
    .execute(&mut *conn)
    .await?;
    buyer(conn, id)
        .await?
        .ok_or_else(|| Error::not_found("Buyer", id))
}

/// Remove a buyer (soft). The person and the company link stay.
///
/// # Errors
/// [`Error::NotFound`], [`Error::LastAdmin`] when `keep_an_admin`.
pub async fn delete_buyer(
    conn: &mut PgConnection,
    id: &str,
    keep_an_admin: bool,
) -> Result<Value, Error> {
    let (company_id, _, role, status) = buyer_row(conn, id)
        .await?
        .ok_or_else(|| Error::not_found("Buyer", id))?;
    let before = buyer(conn, id)
        .await?
        .ok_or_else(|| Error::not_found("Buyer", id))?;
    if keep_an_admin
        && role == "admin"
        && status != "disabled"
        && other_admins(conn, &company_id, id).await? == 0
    {
        return Err(Error::LastAdmin);
    }
    sqlx::query(
        "update commerce_buyers set deleted_at = now() at time zone 'utc', \
           updated_at = now() at time zone 'utc' where id = $1",
    )
    .bind(id)
    .execute(&mut *conn)
    .await?;
    Ok(before)
}

/// A shopper's buying company.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Membership {
    pub buyer_id: String,
    pub company_id: String,
    pub name: String,
    pub role: String,
    pub spend_limit: Option<Cents>,
    pub currency: Option<String>,
}

type MembershipRow = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

/// The companies the person may buy for: active buyers only (a disabled or
/// not yet accepted buyer cannot select the company).
///
/// # Errors
/// A failed statement.
pub async fn memberships(
    conn: &mut PgConnection,
    person_id: &str,
) -> Result<Vec<Membership>, sqlx::Error> {
    let rows: Vec<MembershipRow> = sqlx::query_as(
        "select b.id, b.company_id, c.display_name, b.role, b.spend_limit::text, \
               b.spend_limit_currency \
             from commerce_buyers b join companies c on c.id = b.company_id \
             where b.person_id = $1 and b.status = 'active' and b.deleted_at is null \
               and c.deleted_at is null order by c.display_name asc, b.id asc",
    )
    .bind(person_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(buyer_id, company_id, name, role, limit, currency)| Membership {
                buyer_id,
                company_id,
                name: name.unwrap_or_default(),
                role,
                spend_limit: limit.as_deref().and_then(money::parse),
                currency,
            },
        )
        .collect())
}

/// A person's first sign-in accepts their invitations; the buyers that
/// became active.
///
/// # Errors
/// A failed statement.
pub async fn accept_invitations(
    conn: &mut PgConnection,
    person_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "update commerce_buyers set status = 'active', accepted_at = now() at time zone 'utc', \
           updated_at = now() at time zone 'utc' \
         where person_id = $1 and status = 'invited' and deleted_at is null returning id",
    )
    .bind(person_id)
    .fetch_all(&mut *conn)
    .await
}

/// The buyer rows that may approve for `company_id` (approvers and admins,
/// active), as `(person id, email, name)`.
///
/// # Errors
/// A failed statement.
pub async fn approvers(
    conn: &mut PgConnection,
    company_id: &str,
) -> Result<Vec<(String, String, Option<String>)>, sqlx::Error> {
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select p.id, p.email, p.display_name from commerce_buyers b \
         join people p on p.id = b.person_id \
         where b.company_id = $1 and b.role in ('approver', 'admin') and b.status = 'active' \
           and b.deleted_at is null and p.deleted_at is null and p.email is not null \
         order by b.created_at asc, b.id asc",
    )
    .bind(company_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, email, name)| (id, email.unwrap_or_default(), name))
        .collect())
}

// ── company settings ────────────────────────────────────────────────────────

/// The company's settings; null thresholds when it has none.
///
/// # Errors
/// [`Error::NotFound`] for a company that is gone.
pub async fn company_settings(conn: &mut PgConnection, company_id: &str) -> Result<Value, Error> {
    ensure_company(conn, company_id).await?;
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select approval_threshold::text, approval_threshold_currency \
         from commerce_company_settings where company_id = $1",
    )
    .bind(company_id)
    .fetch_optional(&mut *conn)
    .await?;
    let (threshold, currency) = row.unwrap_or((None, None));
    Ok(json!({
        "companyId": company_id,
        "approvalThreshold": threshold,
        "approvalThresholdCurrency": currency,
    }))
}

async fn ensure_company(conn: &mut PgConnection, company_id: &str) -> Result<(), Error> {
    let found: Option<String> =
        sqlx::query_scalar("select id from companies where id = $1 and deleted_at is null")
            .bind(company_id)
            .fetch_optional(&mut *conn)
            .await?;
    found
        .map(|_| ())
        .ok_or_else(|| Error::not_found("Company", company_id))
}

/// Set (or clear, with `None`) the company's approval threshold.
///
/// # Errors
/// [`Error::NotFound`], [`Error::Invalid`].
pub async fn set_company_settings(
    conn: &mut PgConnection,
    company_id: &str,
    threshold: Option<(Cents, String)>,
) -> Result<Value, Error> {
    ensure_company(conn, company_id).await?;
    if let Some((amount, currency)) = &threshold {
        if *amount <= 0 {
            return Err(Error::invalid(
                "approvalThreshold",
                "Must be an amount above zero",
            ));
        }
        if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(Error::invalid(
                "approvalThresholdCurrency",
                "Must be a 3-letter currency code",
            ));
        }
    }
    sqlx::query(
        "insert into commerce_company_settings (id, company_id, approval_threshold, \
           approval_threshold_currency) values ($1, $2, $3::numeric, $4) \
         on conflict (company_id) do update set approval_threshold = excluded.approval_threshold, \
           approval_threshold_currency = excluded.approval_threshold_currency, \
           updated_at = now() at time zone 'utc'",
    )
    .bind(generate_id("ccs"))
    .bind(company_id)
    .bind(threshold.as_ref().map(|(amount, _)| money::format(*amount)))
    .bind(
        threshold
            .as_ref()
            .map(|(_, currency)| currency.to_ascii_uppercase()),
    )
    .execute(&mut *conn)
    .await?;
    company_settings(conn, company_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_display_name_falls_back_to_the_email() {
        assert_eq!(
            display(Some("Sam"), Some(" Shopper "), "s@x.test"),
            "Sam Shopper"
        );
        assert_eq!(display(None, Some("Shopper"), "s@x.test"), "Shopper");
        assert_eq!(display(Some(" "), None, "s@x.test"), "s@x.test");
    }

    #[test]
    fn a_spend_limit_needs_an_amount_and_a_currency() {
        assert!(check_limit(None, None).is_ok());
        assert!(check_limit(Some(100), Some("EUR")).is_ok());
        assert!(check_limit(Some(0), Some("EUR")).is_err());
        assert!(check_limit(Some(100), None).is_err());
        assert!(check_limit(Some(100), Some("EURO")).is_err());
    }
}
