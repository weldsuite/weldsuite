//! The accounts bank-line processing books to that an entity may not have yet:
//! the clearing account for transfers between its own accounts (NL:
//! *kruisposten*) and the account for what is paid privately (NL: *privé* for
//! a sole trader or VOF, *rekening-courant DGA* for a BV or NV).
//!
//! The charts of accounts the adapters seed carry them (system roles
//! `transfers_in_transit`, `private`, `director_current_account`), but
//! entities made before the roles existed don't. [`ensure_role_account`]
//! finds the account for a role, else the one on the template's code, else
//! creates it, idempotently and without a migration: a transaction-scoped
//! advisory lock per (entity, role) serializes two requests that both need it
//! first.

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use weldsuite_db::{OrmConn, PgPool, atomically_with, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::accounts;

use crate::db_values::to_json_rows;
use crate::document_posting::load_entity;
use crate::http::now;
use crate::jurisdictions;
use crate::posting::PostError;
use crate::tables::ACCOUNTS;

/// The clearing account for money moving between the entity's own accounts.
pub const TRANSFERS_IN_TRANSIT: &str = "transfers_in_transit";
/// Owner's drawings and deposits (sole trader, partnership).
pub const PRIVATE: &str = "private";
/// The current account with the director-shareholder (company).
pub const DIRECTOR_CURRENT_ACCOUNT: &str = "director_current_account";

/// The role money paid privately is booked to for a legal form.
///
/// - NL: a BV or NV has the *rekening-courant DGA*; a sole trader (`sole`)
///   or VOF has *privé*.
/// - IN: a private limited company has the director's loan account; an LLP
///   or sole proprietor has drawings.
/// - US: an S or C corporation has a shareholder current account; an LLC,
///   partnership or sole proprietor has the owner's draws.
/// - BR: the chart's "Lucros distribuídos e retiradas" (`owner_draws`).
pub fn private_role(jurisdiction: &str, entity_type: Option<&str>) -> &'static str {
    match (jurisdiction.to_uppercase().as_str(), entity_type) {
        ("NL", Some("bv" | "nv")) | ("IN", Some("pvt_ltd")) | ("US", Some("s_corp" | "c_corp")) => {
            DIRECTOR_CURRENT_ACCOUNT
        }
        _ => PRIVATE,
    }
}

/// An account to create when the entity has none for a role.
struct Spec {
    code: String,
    name: String,
    kind: String,
    subtype: Option<String>,
    normal_side: String,
}

/// Other roles that already name the same kind of account: the US sole
/// proprietor's and the Brazilian chart's draws.
fn also_accepted(role: &str) -> &'static [&'static str] {
    if role == PRIVATE {
        &["owner_draws"]
    } else {
        &[]
    }
}

/// What to create for `role` on this entity: the template row that carries
/// it, else a fallback per jurisdiction.
fn spec_for(entity: &Value, role: &str) -> Spec {
    let jurisdiction = entity["jurisdictionCode"].as_str().unwrap_or_default();
    let template = jurisdictions::chart_template(
        jurisdiction,
        entity["entityType"].as_str(),
        entity["taxClassification"].as_str(),
    );
    if let Some(row) = template
        .iter()
        .find(|row| row["systemRole"].as_str() == Some(role))
    {
        return Spec {
            code: row["code"].as_str().unwrap_or_default().to_owned(),
            name: row["name"].as_str().unwrap_or_default().to_owned(),
            kind: row["type"].as_str().unwrap_or_default().to_owned(),
            subtype: row["subtype"].as_str().map(str::to_owned),
            normal_side: row["normalSide"].as_str().unwrap_or("debit").to_owned(),
        };
    }
    let upper = jurisdiction.to_uppercase();
    let (code, name, kind, subtype, normal_side) = match role {
        TRANSFERS_IN_TRANSIT => (
            match upper.as_str() {
                "US" => "1060",
                "BR" => "1.1.1.05",
                _ => "1250",
            },
            if upper == "NL" {
                "Kruisposten"
            } else {
                "Transfers in transit"
            },
            "asset",
            "current_assets",
            "debit",
        ),
        DIRECTOR_CURRENT_ACCOUNT => (
            match upper.as_str() {
                "IN" => "1950",
                "US" => "2500",
                "BR" => "2.1.9.02",
                _ => "1960",
            },
            if upper == "NL" {
                "Rekening-courant DGA"
            } else {
                "Shareholder current account"
            },
            "liability",
            "accounts_payable",
            "credit",
        ),
        _ => (
            match upper.as_str() {
                "US" => "3100",
                "BR" => "2.3.9.01",
                _ => "0540",
            },
            if upper == "NL" {
                "Privé"
            } else {
                "Private withdrawals"
            },
            "equity",
            "capital",
            "debit",
        ),
    };
    Spec {
        code: code.to_owned(),
        name: name.to_owned(),
        kind: kind.to_owned(),
        subtype: Some(subtype.to_owned()),
        normal_side: normal_side.to_owned(),
    }
}

/// `code` with its last number counted up (`1250` to `1251`, `1.1.1.05` to
/// `1.1.1.06`), for when the template's code is another account's.
fn next_code(code: &str) -> String {
    let (head, tail) = match code.rfind('.') {
        Some(at) => code.split_at(at + 1),
        None => ("", code),
    };
    match tail.parse::<u64>() {
        Ok(number) => format!("{head}{:0width$}", number + 1, width = tail.len()),
        Err(_) => format!("{code}1"),
    }
}

fn role_of(account: &Value) -> Option<&str> {
    account
        .get("metadata")
        .and_then(|m| m.get("systemRole"))
        .and_then(Value::as_str)
}

fn is_live(account: &Value) -> bool {
    account.get("isActive") != Some(&Value::Bool(false))
}

/// The entity's account for `role`, without creating one: an active account
/// that carries the role (or an accepted equivalent), else the account on the
/// template's code when it is of the template's type.
fn find_existing<'a>(rows: &'a [Value], entity: &Value, role: &str) -> Option<&'a Value> {
    let by_role = |wanted: &str| {
        rows.iter()
            .find(|a| role_of(a) == Some(wanted) && is_live(a))
    };
    by_role(role)
        .or_else(|| also_accepted(role).iter().find_map(|r| by_role(r)))
        .or_else(|| {
            let spec = spec_for(entity, role);
            rows.iter().find(|a| {
                a["code"].as_str() == Some(spec.code.as_str())
                    && a["type"].as_str() == Some(spec.kind.as_str())
                    && is_live(a)
            })
        })
}

#[allow(
    clippy::disallowed_methods,
    reason = "a transaction-scoped advisory lock has no entity"
)]
async fn lock(conn: &mut PgConnection, key: &str) -> Result<(), sqlx::Error> {
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(key)
        .execute(conn)
        .await?;
    Ok(())
}

async fn live_accounts(conn: &mut PgConnection, entity_id: &str) -> Result<Vec<Value>, PostError> {
    let rows = accounts::Entity::find()
        .filter(accounts::Column::EntityId.eq(entity_id))
        .filter(accounts::Column::DeletedAt.is_null())
        .all(&OrmConn::new(conn))
        .await?;
    Ok(to_json_rows(rows)?)
}

/// The entity's account for a system role, created when it has none.
///
/// Looks for an account that carries the role, then for the template's code
/// (an entity from before the role existed has "Privé" on `0540`), and only
/// then creates the account the template (or, without one, the jurisdiction's
/// fallback) describes, with the role in its metadata so the next lookup is
/// by role. Safe to call at the same time from several requests.
pub async fn ensure_role_account(
    db: &PgPool,
    entity_id: &str,
    role: &'static str,
) -> Result<Value, PostError> {
    let entity = load_entity(db, entity_id).await?;
    let existing = crate::posting::load_entity_accounts(db, entity_id).await?;
    if let Some(account) = find_existing(existing.rows(), &entity, role) {
        return Ok(account.clone());
    }
    let entity_id = entity_id.to_owned();
    atomically_with::<_, Value, PostError, _>(db, move |conn| {
        Box::pin(async move {
            lock(&mut *conn, &format!("system-account:{entity_id}:{role}")).await?;
            let rows = live_accounts(&mut *conn, &entity_id).await?;
            if let Some(account) = find_existing(&rows, &entity, role) {
                return Ok(account.clone());
            }
            let spec = spec_for(&entity, role);
            let mut code = spec.code.clone();
            let mut tries = 0;
            while rows
                .iter()
                .any(|a| a["code"].as_str() == Some(code.as_str()))
                && tries < 100
            {
                code = next_code(&code);
                tries += 1;
            }
            let stamp = now();
            let id = generate_id("acc");
            let mut values = Map::new();
            for (key, value) in [
                ("id", json!(id)),
                ("entityId", json!(entity_id)),
                ("code", json!(code)),
                ("name", json!(spec.name)),
                ("type", json!(spec.kind)),
                ("subtype", json!(spec.subtype)),
                ("normalSide", json!(spec.normal_side)),
                ("currency", entity["baseCurrency"].clone()),
                ("isActive", json!(true)),
                ("isSystemAccount", json!(false)),
                ("openingBalance", json!("0")),
                ("currentBalance", json!("0")),
                ("metadata", json!({ "systemRole": role })),
                ("createdAt", json!(stamp)),
                ("updatedAt", json!(stamp)),
            ] {
                values.insert(key.to_owned(), value);
            }
            let created = ACCOUNTS
                .insert_raw_on(&OrmConn::new(&mut *conn), ACCOUNTS.values(&values))
                .await?;
            Ok(created)
        })
    })
    .await
}

/// Whether `entity_id` has the account for `role` already (no creation):
/// what a read-only route (the to-process list) can ask.
pub async fn has_role_account(
    db: &PgPool,
    entity_id: &str,
    role: &'static str,
) -> Result<bool, PostError> {
    let entity = load_entity(db, entity_id).await?;
    let rows = accounts::Entity::find()
        .filter(accounts::Column::EntityId.eq(entity_id))
        .filter(accounts::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    let rows = to_json_rows(rows)?;
    Ok(find_existing(&rows, &entity, role).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_goes_by_legal_form() {
        assert_eq!(private_role("NL", Some("bv")), DIRECTOR_CURRENT_ACCOUNT);
        assert_eq!(private_role("nl", Some("nv")), DIRECTOR_CURRENT_ACCOUNT);
        assert_eq!(private_role("NL", Some("sole")), PRIVATE);
        assert_eq!(private_role("NL", Some("vof")), PRIVATE);
        assert_eq!(private_role("NL", None), PRIVATE);
        assert_eq!(
            private_role("IN", Some("pvt_ltd")),
            DIRECTOR_CURRENT_ACCOUNT
        );
        assert_eq!(private_role("IN", Some("llp")), PRIVATE);
        assert_eq!(private_role("US", Some("c_corp")), DIRECTOR_CURRENT_ACCOUNT);
        assert_eq!(private_role("US", Some("llc")), PRIVATE);
        assert_eq!(private_role("BR", Some("ltda")), PRIVATE);
    }

    #[test]
    fn a_taken_code_counts_up() {
        assert_eq!(next_code("1250"), "1251");
        assert_eq!(next_code("0540"), "0541");
        assert_eq!(next_code("1.1.1.05"), "1.1.1.06");
        assert_eq!(next_code("X"), "X1");
    }

    #[test]
    fn the_templates_carry_the_roles() {
        for (code, entity_type, role, account) in [
            ("NL", Some("bv"), TRANSFERS_IN_TRANSIT, "1250"),
            ("NL", Some("bv"), DIRECTOR_CURRENT_ACCOUNT, "1960"),
            ("NL", Some("sole"), PRIVATE, "0540"),
            ("IN", None, TRANSFERS_IN_TRANSIT, "1250"),
            ("IN", None, PRIVATE, "0540"),
            ("IN", None, DIRECTOR_CURRENT_ACCOUNT, "1950"),
            ("US", Some("llc"), TRANSFERS_IN_TRANSIT, "1060"),
            ("BR", None, TRANSFERS_IN_TRANSIT, "1.1.1.05"),
        ] {
            let entity = json!({ "jurisdictionCode": code, "entityType": entity_type });
            let spec = spec_for(&entity, role);
            assert_eq!(spec.code, account, "{code} {role}");
        }
    }
}
