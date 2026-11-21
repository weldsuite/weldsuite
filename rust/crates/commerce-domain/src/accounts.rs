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
//! publishes an event. The statements are the SeaORM entities' (ADR
//! DATA-019), joined to the caller's transaction through [`db::on`].

use sea_orm::ActiveValue::Set;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, QueryTrait, RelationDef, Select,
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    commerce_buyers, commerce_company_settings, companies, people, person_companies,
};

use crate::db;
use crate::error::Error;
use crate::money::{self, Cents};

/// The roles of a buyer, weakest first.
pub const ROLES: [&str; 3] = ["buyer", "approver", "admin"];
/// The statuses a buyer may be set to.
pub const STATUSES: [&str; 3] = ["invited", "active", "disabled"];

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

/// `id, email, first_name, last_name, mobile_phone, direct_phone`.
type PersonRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn person_of((id, email, first_name, last_name, mobile, direct): PersonRow) -> Person {
    Person {
        id,
        email: email.unwrap_or_default(),
        first_name,
        last_name,
        // `coalesce(mobile_phone, direct_phone)`
        phone: mobile.or(direct),
    }
}

/// The live people, as the columns of a [`PersonRow`].
fn people_rows() -> Select<people::Entity> {
    people::Entity::find()
        .select_only()
        .columns([
            people::Column::Id,
            people::Column::Email,
            people::Column::FirstName,
            people::Column::LastName,
            people::Column::MobilePhone,
            people::Column::DirectPhone,
        ])
        .filter(people::Column::DeletedAt.is_null())
}

/// The person with this email (the oldest, when there are several).
///
/// # Errors
/// A failed statement.
pub async fn find_person(conn: &mut PgConnection, email: &str) -> Result<Option<Person>, DbErr> {
    let row: Option<PersonRow> = people_rows()
        // `lower(email) = lower($1)`
        .filter(sea_orm::sea_query::ExprTrait::eq(
            Func::lower(people::Column::Email.into_expr()),
            Func::lower(email),
        ))
        .order_by_asc(people::Column::CreatedAt)
        .order_by_asc(people::Column::Id)
        .limit(1)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    Ok(row.map(person_of))
}

/// A person by id.
///
/// # Errors
/// A failed statement.
pub async fn person(conn: &mut PgConnection, id: &str) -> Result<Option<Person>, DbErr> {
    let row: Option<PersonRow> = people_rows()
        .filter(people::Column::Id.eq(id))
        .into_tuple()
        .one(&db::on(conn))
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
) -> Result<Person, DbErr> {
    db::advisory_lock(
        conn,
        &format!("weldcommerce:person:{}", email.to_lowercase()),
    )
    .await?;
    if let Some(found) = find_person(conn, email).await? {
        return Ok(found);
    }
    let id = generate_id("per");
    let name = display(first_name, last_name, email);
    let given = |name: Option<&str>| name.filter(|n| !n.trim().is_empty()).map(str::to_owned);
    people::Entity::insert(people::ActiveModel {
        id: Set(id.clone()),
        display_name: Set(name.clone()),
        full_name: Set(Some(name)),
        first_name: Set(given(first_name)),
        last_name: Set(given(last_name)),
        email: Set(Some(email.to_owned())),
        in_crm: Set(false),
        source: Set(Some("weldcommerce".to_owned())),
        owner_id: Set(Some(owner.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&db::on(conn))
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
) -> Result<Option<Person>, DbErr> {
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
    people::Entity::update_many()
        .set(people::ActiveModel {
            first_name: Set(first),
            last_name: Set(last),
            full_name: Set(Some(name.clone())),
            display_name: Set(name),
            mobile_phone: Set(phone),
            updated_at: Set(db::now()),
            ..Default::default()
        })
        .filter(people::Column::Id.eq(id))
        .exec(&db::on(conn))
        .await?;
    person(conn, id).await
}

// ── buyers ──────────────────────────────────────────────────────────────────

/// `commerce_buyers.person_id = people.id` (the entities declare no
/// relations).
fn buyer_person() -> RelationDef {
    commerce_buyers::Entity::belongs_to(people::Entity)
        .from(commerce_buyers::Column::PersonId)
        .to(people::Column::Id)
        .into()
}

/// `commerce_buyers.company_id = companies.id`.
fn buyer_company() -> RelationDef {
    commerce_buyers::Entity::belongs_to(companies::Entity)
        .from(commerce_buyers::Column::CompanyId)
        .to(companies::Column::Id)
        .into()
}

/// A buyer row with its person's name and email.
#[derive(Debug, FromQueryResult)]
struct BuyerRow {
    #[sea_orm(nested)]
    buyer: commerce_buyers::Model,
    person_name: String,
    person_email: Option<String>,
}

/// The live buyers joined to their person.
fn buyer_rows() -> Select<commerce_buyers::Entity> {
    commerce_buyers::Entity::find()
        .join(JoinType::InnerJoin, buyer_person())
        .column_as(people::Column::DisplayName, "person_name")
        .column_as(people::Column::Email, "person_email")
        .filter(commerce_buyers::Column::DeletedAt.is_null())
}

/// The `Buyer` of the API.
fn buyer_json(row: &BuyerRow) -> Value {
    // The entity's JSON: numeric as `"100.00"`, timestamps as `toISOString()`.
    let buyer = serde_json::to_value(&row.buyer).unwrap_or_default();
    let field = |key: &str| buyer.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "personId": field("personId"),
        "companyId": field("companyId"),
        "name": row.person_name,
        "email": row.person_email,
        "role": field("role"),
        "spendLimit": field("spendLimit"),
        "spendLimitCurrency": field("spendLimitCurrency"),
        "status": field("status"),
        "invitedAt": field("invitedAt"),
        "acceptedAt": field("acceptedAt"),
        "createdAt": field("createdAt"),
        "updatedAt": field("updatedAt"),
    })
}

/// The buyers, newest last; filtered by company and/or person.
///
/// # Errors
/// A failed statement.
pub async fn buyers(
    conn: &mut PgConnection,
    company_id: Option<&str>,
    person_id: Option<&str>,
) -> Result<Vec<Value>, DbErr> {
    let rows = buyer_rows()
        .apply_if(company_id, |query, company| {
            query.filter(commerce_buyers::Column::CompanyId.eq(company))
        })
        .apply_if(person_id, |query, person| {
            query.filter(commerce_buyers::Column::PersonId.eq(person))
        })
        .order_by_asc(commerce_buyers::Column::CreatedAt)
        .order_by_asc(commerce_buyers::Column::Id)
        .into_model::<BuyerRow>()
        .all(&db::on(conn))
        .await?;
    Ok(rows.iter().map(buyer_json).collect())
}

/// One buyer.
///
/// # Errors
/// A failed statement.
pub async fn buyer(conn: &mut PgConnection, id: &str) -> Result<Option<Value>, DbErr> {
    let row = buyer_rows()
        .filter(commerce_buyers::Column::Id.eq(id))
        .into_model::<BuyerRow>()
        .one(&db::on(conn))
        .await?;
    Ok(row.as_ref().map(buyer_json))
}

/// A live buyer by id, as stored (no join), locked until the transaction
/// ends: `(company_id, person_id, role, status)`.
async fn buyer_row(
    conn: &mut PgConnection,
    id: &str,
) -> Result<Option<(String, String, String, String)>, DbErr> {
    commerce_buyers::Entity::find_by_id(id)
        .filter(commerce_buyers::Column::DeletedAt.is_null())
        .select_only()
        .columns([
            commerce_buyers::Column::CompanyId,
            commerce_buyers::Column::PersonId,
            commerce_buyers::Column::Role,
            commerce_buyers::Column::Status,
        ])
        .lock_exclusive()
        .into_tuple()
        .one(&db::on(conn))
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
    ensure_company(conn, new.company_id).await?;
    let person = find_or_create_person(
        conn,
        new.email,
        new.first_name,
        new.last_name,
        new.invited_by,
    )
    .await?;
    let exists = commerce_buyers::Entity::find()
        .filter(commerce_buyers::Column::PersonId.eq(person.id.as_str()))
        .filter(commerce_buyers::Column::CompanyId.eq(new.company_id))
        .filter(commerce_buyers::Column::DeletedAt.is_null())
        .count(&db::on(conn))
        .await?
        > 0;
    if exists {
        return Err(Error::BuyerExists);
    }
    let linked = person_companies::Entity::find()
        .filter(person_companies::Column::PersonId.eq(person.id.as_str()))
        .filter(person_companies::Column::CompanyId.eq(new.company_id))
        .filter(person_companies::Column::EndedAt.is_null())
        .count(&db::on(conn))
        .await?
        > 0;
    if !linked {
        // The first current company link is the person's primary one. The
        // person's advisory lock (`find_or_create_person`) is held until
        // the transaction ends, so no other link is made in between.
        let has_primary = person_companies::Entity::find()
            .filter(person_companies::Column::PersonId.eq(person.id.as_str()))
            .filter(person_companies::Column::IsPrimary.eq(true))
            .filter(person_companies::Column::EndedAt.is_null())
            .count(&db::on(conn))
            .await?
            > 0;
        person_companies::Entity::insert(person_companies::ActiveModel {
            id: Set(generate_id("pc")),
            person_id: Set(person.id.clone()),
            company_id: Set(new.company_id.to_owned()),
            is_primary: Set(!has_primary),
            started_at: Set(Some(db::now())),
            ..Default::default()
        })
        .exec_without_returning(&db::on(conn))
        .await?;
    }
    let id = generate_id("cbuy");
    commerce_buyers::Entity::insert(commerce_buyers::ActiveModel {
        id: Set(id.clone()),
        person_id: Set(person.id.clone()),
        company_id: Set(new.company_id.to_owned()),
        role: Set(new.role.to_owned()),
        spend_limit: Set(new.spend_limit.map(db::decimal)),
        spend_limit_currency: Set(new
            .spend_limit
            .and(new.spend_limit_currency)
            .map(str::to_owned)),
        status: Set("invited".to_owned()),
        invited_by: Set(Some(new.invited_by.to_owned())),
        invited_at: Set(Some(db::now())),
        ..Default::default()
    })
    .exec_without_returning(&db::on(conn))
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
) -> Result<u64, DbErr> {
    commerce_buyers::Entity::find()
        .filter(commerce_buyers::Column::CompanyId.eq(company_id))
        .filter(commerce_buyers::Column::Id.ne(except))
        .filter(commerce_buyers::Column::Role.eq("admin"))
        .filter(commerce_buyers::Column::Status.ne("disabled"))
        .filter(commerce_buyers::Column::DeletedAt.is_null())
        .count(&db::on(conn))
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
    let now = db::now();
    let mut row = commerce_buyers::ActiveModel {
        role: Set(new_role.to_owned()),
        status: Set(new_status.to_owned()),
        updated_at: Set(now),
        ..Default::default()
    };
    if let Some(limit) = &patch.spend_limit {
        row.spend_limit = Set(limit.as_ref().map(|(amount, _)| db::decimal(*amount)));
        row.spend_limit_currency = Set(limit
            .as_ref()
            .map(|(_, currency)| currency.to_ascii_uppercase()));
    }
    let mut update = commerce_buyers::Entity::update_many().set(row);
    if new_status == "active" {
        // Accepted now, unless it was accepted before.
        update = update.col_expr(
            commerce_buyers::Column::AcceptedAt,
            Func::coalesce([
                Expr::col(commerce_buyers::Column::AcceptedAt),
                Expr::val(now),
            ])
            .into(),
        );
    }
    update
        .filter(commerce_buyers::Column::Id.eq(id))
        .exec(&db::on(conn))
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
    let now = db::now();
    commerce_buyers::Entity::update_many()
        .set(commerce_buyers::ActiveModel {
            deleted_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .filter(commerce_buyers::Column::Id.eq(id))
        .exec(&db::on(conn))
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

/// `b.id, b.company_id, c.display_name, b.role, b.spend_limit,
/// b.spend_limit_currency`.
type MembershipRow = (
    String,
    String,
    String,
    String,
    Option<BigDecimal>,
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
) -> Result<Vec<Membership>, DbErr> {
    let rows: Vec<MembershipRow> = commerce_buyers::Entity::find()
        .join(JoinType::InnerJoin, buyer_company())
        .select_only()
        .column(commerce_buyers::Column::Id)
        .column(commerce_buyers::Column::CompanyId)
        .column(companies::Column::DisplayName)
        .column(commerce_buyers::Column::Role)
        .column(commerce_buyers::Column::SpendLimit)
        .column(commerce_buyers::Column::SpendLimitCurrency)
        .filter(commerce_buyers::Column::PersonId.eq(person_id))
        .filter(commerce_buyers::Column::Status.eq("active"))
        .filter(commerce_buyers::Column::DeletedAt.is_null())
        .filter(companies::Column::DeletedAt.is_null())
        .order_by_asc(companies::Column::DisplayName)
        .order_by_asc(commerce_buyers::Column::Id)
        .into_tuple()
        .all(&db::on(conn))
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(buyer_id, company_id, name, role, limit, currency)| Membership {
                buyer_id,
                company_id,
                name,
                role,
                // As `money::parse` read the column's text: none below zero.
                spend_limit: limit.as_ref().map(db::cents).filter(|cents| *cents >= 0),
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
) -> Result<Vec<String>, DbErr> {
    let now = db::now();
    let accepted = commerce_buyers::Entity::update_many()
        .set(commerce_buyers::ActiveModel {
            status: Set("active".to_owned()),
            accepted_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .filter(commerce_buyers::Column::PersonId.eq(person_id))
        .filter(commerce_buyers::Column::Status.eq("invited"))
        .filter(commerce_buyers::Column::DeletedAt.is_null())
        .exec_with_returning(&db::on(conn))
        .await?;
    Ok(accepted.into_iter().map(|buyer| buyer.id).collect())
}

/// The buyer rows that may approve for `company_id` (approvers and admins,
/// active), as `(person id, email, name)`.
///
/// # Errors
/// A failed statement.
pub async fn approvers(
    conn: &mut PgConnection,
    company_id: &str,
) -> Result<Vec<(String, String, Option<String>)>, DbErr> {
    let rows: Vec<(String, Option<String>, String)> = commerce_buyers::Entity::find()
        .join(JoinType::InnerJoin, buyer_person())
        .select_only()
        .column(people::Column::Id)
        .column(people::Column::Email)
        .column(people::Column::DisplayName)
        .filter(commerce_buyers::Column::CompanyId.eq(company_id))
        .filter(commerce_buyers::Column::Role.is_in(["approver", "admin"]))
        .filter(commerce_buyers::Column::Status.eq("active"))
        .filter(commerce_buyers::Column::DeletedAt.is_null())
        .filter(people::Column::DeletedAt.is_null())
        .filter(people::Column::Email.is_not_null())
        .order_by_asc(commerce_buyers::Column::CreatedAt)
        .order_by_asc(commerce_buyers::Column::Id)
        .into_tuple()
        .all(&db::on(conn))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, email, name)| (id, email.unwrap_or_default(), Some(name)))
        .collect())
}

// ── company settings ────────────────────────────────────────────────────────

/// The company's settings; null thresholds when it has none.
///
/// # Errors
/// [`Error::NotFound`] for a company that is gone.
pub async fn company_settings(conn: &mut PgConnection, company_id: &str) -> Result<Value, Error> {
    ensure_company(conn, company_id).await?;
    let row: Option<(Option<BigDecimal>, Option<String>)> =
        commerce_company_settings::Entity::find()
            .select_only()
            .columns([
                commerce_company_settings::Column::ApprovalThreshold,
                commerce_company_settings::Column::ApprovalThresholdCurrency,
            ])
            .filter(commerce_company_settings::Column::CompanyId.eq(company_id))
            .into_tuple()
            .one(&db::on(conn))
            .await?;
    let (threshold, currency) = row.unwrap_or((None, None));
    Ok(json!({
        "companyId": company_id,
        // `numeric(18, 2)` as Postgres prints it: `"100.00"`.
        "approvalThreshold": threshold.as_ref().map(|t| money::format(db::cents(t))),
        "approvalThresholdCurrency": currency,
    }))
}

async fn ensure_company(conn: &mut PgConnection, company_id: &str) -> Result<(), Error> {
    let found: Option<String> = companies::Entity::find_by_id(company_id)
        .filter(companies::Column::DeletedAt.is_null())
        .select_only()
        .column(companies::Column::Id)
        .into_tuple()
        .one(&db::on(conn))
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
    commerce_company_settings::Entity::insert(commerce_company_settings::ActiveModel {
        id: Set(generate_id("ccs")),
        company_id: Set(company_id.to_owned()),
        approval_threshold: Set(threshold.as_ref().map(|(amount, _)| db::decimal(*amount))),
        approval_threshold_currency: Set(threshold
            .as_ref()
            .map(|(_, currency)| currency.to_ascii_uppercase())),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(commerce_company_settings::Column::CompanyId)
            .update_columns([
                commerce_company_settings::Column::ApprovalThreshold,
                commerce_company_settings::Column::ApprovalThresholdCurrency,
            ])
            .value(commerce_company_settings::Column::UpdatedAt, db::now())
            .to_owned(),
    )
    .exec_without_returning(&db::on(conn))
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
