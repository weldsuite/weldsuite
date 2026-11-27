//! Per-entity defaults for the differences between a payment and what it
//! settles: the accounts for bank costs, a payment discount and rounding,
//! and the cap on what is rounded off automatically (default 1.00 in the
//! entity's currency).
//!
//! They live in the entity's `jurisdiction_settings` jsonb under
//! `differences` (no migration), next to the settings other features keep
//! there: reads and writes merge, never replace, the object. Moneybird
//! writes off any amount as rounding; here the gap is only booked to the
//! rounding account when it is within the cap, so a real shortfall is never
//! hidden.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_schema::tenant::entities;

use crate::document_posting::text;
use crate::js::{js_number_value, round_money};
use crate::posting::{EntityAccounts, load_entity_accounts};

/// The rounding cap when the entity has not set one.
pub const DEFAULT_ROUNDING_CAP: f64 = 1.0;

/// The key in `jurisdiction_settings`.
const KEY: &str = "differences";

/// What an entity booked differences to by default.
#[derive(Debug, Clone, PartialEq)]
pub struct Differences {
    pub bank_costs_account_id: Option<String>,
    pub payment_discount_account_id: Option<String>,
    pub rounding_account_id: Option<String>,
    /// In the entity's base currency.
    pub rounding_cap: f64,
}

impl Default for Differences {
    fn default() -> Self {
        Self {
            bank_costs_account_id: None,
            payment_discount_account_id: None,
            rounding_account_id: None,
            rounding_cap: DEFAULT_ROUNDING_CAP,
        }
    }
}

fn filled(settings: &Value, key: &str) -> Option<String> {
    text(settings, key)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

impl Differences {
    /// Read them from an entity's `jurisdictionSettings`.
    pub fn of(jurisdiction_settings: Option<&Value>) -> Self {
        let Some(stored) = jurisdiction_settings.and_then(|s| s.get(KEY)) else {
            return Self::default();
        };
        let cap = stored.get("roundingCap").map(|c| js_number_value(Some(c)));
        Self {
            bank_costs_account_id: filled(stored, "bankCostsAccountId"),
            payment_discount_account_id: filled(stored, "paymentDiscountAccountId"),
            rounding_account_id: filled(stored, "roundingAccountId"),
            rounding_cap: cap
                .filter(|c| c.is_finite() && *c >= 0.0)
                .map_or(DEFAULT_ROUNDING_CAP, round_money),
        }
    }

    /// `{ bankCostsAccountId, paymentDiscountAccountId, roundingAccountId,
    /// roundingCap }`, unset accounts as `null`, the cap as the text of two
    /// decimals.
    pub fn to_json(&self) -> Value {
        json!({
            "bankCostsAccountId": self.bank_costs_account_id,
            "paymentDiscountAccountId": self.payment_discount_account_id,
            "roundingAccountId": self.rounding_account_id,
            "roundingCap": crate::js::to_fixed(self.rounding_cap, 2),
        })
    }

    /// The rounding account to book a small gap to: the one set, else the
    /// entity's `rounding` system account (when it is active).
    pub fn rounding_account<'a>(&'a self, accounts: &'a EntityAccounts) -> Option<String> {
        self.rounding_account_id
            .as_deref()
            .filter(|id| accounts.by_id(Some(id)).is_some())
            .map(str::to_owned)
            .or_else(|| {
                accounts
                    .by_role("rounding")
                    .filter(|a| a.get("isActive") != Some(&Value::Bool(false)))
                    .and_then(|a| text(a, "id"))
                    .map(str::to_owned)
            })
    }

    /// Whether a gap (either way) is small enough to round off: at least a
    /// cent and no more than the cap.
    pub fn within_cap(&self, gap: f64) -> bool {
        let gap = round_money(gap.abs());
        gap >= 0.01 && gap <= round_money(self.rounding_cap) + 1e-9
    }
}

/// The entity's differences settings.
pub async fn load(db: &PgPool, entity_id: &str) -> Result<Differences, DbErr> {
    let settings: Option<Option<Value>> = entities::Entity::find_by_id(entity_id.to_owned())
        .filter(entities::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|row| row.jurisdiction_settings);
    Ok(Differences::of(settings.flatten().as_ref()))
}

/// The `differences` object stored in the entity's `jurisdiction_settings`,
/// as it is (`None` when there is none).
pub async fn stored(db: &PgPool, entity_id: &str) -> Result<Option<Value>, DbErr> {
    let settings: Option<Option<Value>> = entities::Entity::find_by_id(entity_id.to_owned())
        .filter(entities::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|row| row.jurisdiction_settings);
    Ok(settings
        .flatten()
        .and_then(|all| all.get(KEY).filter(|v| v.is_object()).cloned()))
}

/// `settings` (an entity update's new `jurisdictionSettings`) with the
/// stored `differences` carried over, unless the update names its own: the
/// per-jurisdiction normalisers (BR, IN) and a body that replaces the whole
/// object would otherwise drop the key phase 2 keeps there.
pub fn keep_stored(settings: Value, stored: Option<&Value>) -> Value {
    let (Value::Object(mut all), Some(stored)) = (settings.clone(), stored) else {
        return settings;
    };
    if !all.contains_key(KEY) {
        all.insert(KEY.to_owned(), stored.clone());
    }
    Value::Object(all)
}

/// The entity's differences and its rounding account to use, in one read.
pub async fn load_with_rounding(
    db: &PgPool,
    entity_id: &str,
) -> Result<(Differences, Option<String>), DbErr> {
    let differences = load(db, entity_id).await?;
    let accounts = load_entity_accounts(db, entity_id).await?;
    let rounding = differences.rounding_account(&accounts);
    Ok((differences, rounding))
}

/// `jurisdictionSettings` with `differences` merged from `patch` (a key set
/// to `null` clears it); everything else in the settings is kept.
pub fn merged(jurisdiction_settings: Option<&Value>, patch: &Map<String, Value>) -> Value {
    let mut all = match jurisdiction_settings {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mut differences = match all.get(KEY) {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    for (key, value) in patch {
        if value.is_null() {
            differences.remove(key);
        } else {
            differences.insert(key.clone(), value.clone());
        }
    }
    all.insert(KEY.to_owned(), Value::Object(differences));
    Value::Object(all)
}

/// Store `settings` as the entity's `jurisdiction_settings`.
pub async fn store(db: &PgPool, entity_id: &str, settings: &Value) -> Result<(), DbErr> {
    entities::Entity::update_many()
        .col_expr(
            entities::Column::JurisdictionSettings,
            Expr::value(settings.clone()),
        )
        .col_expr(entities::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(entities::Column::Id.eq(entity_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_stored_means_the_defaults() {
        let none = Differences::of(None);
        assert_eq!(none, Differences::default());
        assert!((none.rounding_cap - 1.0).abs() < f64::EPSILON);
        assert_eq!(Differences::of(Some(&json!({ "stateCode": "KA" }))), none);
    }

    #[test]
    fn reads_what_is_stored() {
        let settings = json!({
            "stateCode": "KA",
            "differences": {
                "bankCostsAccountId": "acc_bank",
                "roundingAccountId": "acc_round",
                "roundingCap": "0.50",
            }
        });
        let read = Differences::of(Some(&settings));
        assert_eq!(read.bank_costs_account_id.as_deref(), Some("acc_bank"));
        assert_eq!(read.payment_discount_account_id, None);
        assert_eq!(read.rounding_account_id.as_deref(), Some("acc_round"));
        assert!((read.rounding_cap - 0.5).abs() < f64::EPSILON);
        // A cap that makes no sense is the default.
        let odd = json!({ "differences": { "roundingCap": -3 } });
        assert!((Differences::of(Some(&odd)).rounding_cap - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_gap_is_within_the_cap_up_to_and_including_it() {
        let cap = Differences::default();
        assert!(cap.within_cap(0.01));
        assert!(cap.within_cap(-0.99));
        assert!(cap.within_cap(1.0));
        assert!(!cap.within_cap(1.01));
        assert!(!cap.within_cap(0.0));
        assert!(!cap.within_cap(0.004));
        let none = Differences {
            rounding_cap: 0.0,
            ..Differences::default()
        };
        assert!(!none.within_cap(0.01));
    }

    #[test]
    fn an_update_keeps_the_stored_differences() {
        let stored = json!({ "roundingCap": "2.00" });
        // The new settings do not mention them: they stay.
        let kept = keep_stored(json!({ "stateCode": "KA" }), Some(&stored));
        assert_eq!(kept["stateCode"], json!("KA"));
        assert_eq!(kept["differences"], stored);
        // An update that names its own wins.
        let own = keep_stored(
            json!({ "differences": { "roundingCap": "5.00" } }),
            Some(&stored),
        );
        assert_eq!(own["differences"]["roundingCap"], json!("5.00"));
        // Nothing stored, or settings that are not an object: unchanged.
        assert_eq!(keep_stored(json!({ "a": 1 }), None), json!({ "a": 1 }));
        assert_eq!(keep_stored(Value::Null, Some(&stored)), Value::Null);
    }

    #[test]
    fn merging_keeps_the_other_settings() {
        let settings = json!({ "stateCode": "KA", "differences": { "roundingCap": "2.00" } });
        let patch = json!({ "bankCostsAccountId": "acc_bank", "roundingCap": null });
        let patch = patch.as_object().cloned().unwrap_or_default();
        let next = merged(Some(&settings), &patch);
        assert_eq!(next["stateCode"], json!("KA"));
        assert_eq!(next["differences"]["bankCostsAccountId"], json!("acc_bank"));
        assert!(next["differences"].get("roundingCap").is_none());
        assert_eq!(
            merged(None, &patch)["differences"]["bankCostsAccountId"],
            json!("acc_bank")
        );
    }
}
