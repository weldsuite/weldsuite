//! Apps that extend a legal entity (`extensions.ts`, contract item 4 in
//! `weldsuite-documentation/plans/legal-entities.md`). Each says whether it is enabled for an
//! entity and whether it holds data there; together they power "Used by" and
//! block deleting an entity that still has data. Reading another module's
//! tables for these probes is allowed by the module-split rules.
//!
//! `getLegalEntityExtension(app).enabledFor(db, ids)` is
//! [`LegalEntityApp::enabled_for`], and so on for `hasData` and
//! `lockedChange`; `LEGAL_ENTITY_EXTENSIONS` is [`LegalEntityApp::ALL`].

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

/// An app that extends a legal entity (`LegalEntityApp`). WeldBooks needs to
/// be enabled per entity; WeldHR works with any entity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LegalEntityApp {
    Weldbooks,
    Weldhr,
}

/// Which of the fields that history depends on a core update changes
/// (`LegalEntityCoreChange`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LegalEntityCoreChange {
    pub jurisdiction_code: bool,
    pub base_currency: bool,
    pub fiscal_year: bool,
}

impl LegalEntityCoreChange {
    fn any(self) -> bool {
        self.jurisdiction_code || self.base_currency || self.fiscal_year
    }

    /// `changedFields(change)`: "base currency and country", in that order.
    fn changed_fields(self) -> String {
        let mut fields = Vec::new();
        if self.base_currency {
            fields.push("base currency");
        }
        if self.jurisdiction_code {
            fields.push("country");
        }
        fields.join(" and ")
    }
}

impl LegalEntityApp {
    /// `LEGAL_ENTITY_EXTENSIONS`, in its order.
    pub const ALL: [Self; 2] = [Self::Weldbooks, Self::Weldhr];

    /// `LEGAL_ENTITY_APPS` values.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Weldbooks => "weldbooks",
            Self::Weldhr => "weldhr",
        }
    }

    /// `legalEntityAppSchema` for a known value.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "weldbooks" => Some(Self::Weldbooks),
            "weldhr" => Some(Self::Weldhr),
            _ => None,
        }
    }

    /// Ids (of `entity_ids`) the app is enabled for (`enabledFor`). A
    /// WeldBooks extension row (`accounting_entity_settings`) means WeldBooks
    /// is enabled; WeldHR works with any legal entity.
    pub async fn enabled_for(
        self,
        db: &PgPool,
        entity_ids: &[String],
    ) -> Result<HashSet<String>, sqlx::Error> {
        match self {
            Self::Weldhr => Ok(entity_ids.iter().cloned().collect()),
            Self::Weldbooks => {
                if entity_ids.is_empty() {
                    return Ok(HashSet::new());
                }
                let ids: Vec<String> = sqlx::query_scalar(
                    "select entity_id from accounting_entity_settings where entity_id = any($1)",
                )
                .bind(entity_ids)
                .fetch_all(db)
                .await?;
                Ok(ids.into_iter().collect())
            }
        }
    }

    /// Whether the app is enabled for one entity.
    pub async fn is_enabled_for(self, db: &PgPool, entity_id: &str) -> Result<bool, sqlx::Error> {
        let ids = [entity_id.to_owned()];
        Ok(self.enabled_for(db, &ids).await?.contains(entity_id))
    }

    /// Whether the app holds data for the entity (`hasData`; blocks deletion).
    pub async fn has_data(self, db: &PgPool, entity_id: &str) -> Result<bool, sqlx::Error> {
        let sql = match self {
            Self::Weldbooks => {
                "select exists (select 1 from invoices where entity_id = $1
                     union all select 1 from bills where entity_id = $1
                     union all select 1 from journal_entries where entity_id = $1
                     limit 1)"
            }
            Self::Weldhr => {
                "select exists (select 1 from hr_employees
                                where legal_entity_id = $1 and deleted_at is null)
                     or exists (select 1 from hr_payroll_employers
                                where legal_entity_id = $1 and deleted_at is null)"
            }
        };
        sqlx::query_scalar(sql).bind(entity_id).fetch_one(db).await
    }

    /// Why the app forbids changing core fields its data rests on, or `None`
    /// when the change is allowed (`lockedChange`). Only asked when the app is
    /// enabled for the entity.
    ///
    /// WeldBooks: base currency, country and fiscal year decide how posted
    /// amounts, tax lines and periods were computed. WeldHR: payroll is
    /// computed under the entity's country and in its currency.
    pub async fn locked_change(
        self,
        db: &PgPool,
        entity_id: &str,
        change: LegalEntityCoreChange,
    ) -> Result<Option<String>, sqlx::Error> {
        match self {
            Self::Weldbooks => books_locked_change(db, entity_id, change).await,
            Self::Weldhr => {
                if !change.jurisdiction_code && !change.base_currency {
                    return Ok(None);
                }
                let run: bool = sqlx::query_scalar(
                    "select exists (select 1 from hr_pay_runs r
                     join hr_payroll_employers e on e.id = r.employer_id
                     where e.legal_entity_id = $1)",
                )
                .bind(entity_id)
                .fetch_one(db)
                .await?;
                Ok(run.then(|| {
                    format!(
                        "The {} of this legal entity can no longer be changed because WeldHR has pay runs for it. Create a new legal entity instead.",
                        change.changed_fields()
                    )
                }))
            }
        }
    }
}

/// Finalized WeldBooks records (`booksHasPostings`): the same definition as
/// books-api's `entityHasPostings`, which guards WeldBooks' own PATCH.
async fn books_has_postings(db: &PgPool, entity_id: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists (select 1 from journal_entries
                        where entity_id = $1 and status <> 'draft' and deleted_at is null)
             or exists (select 1 from invoices
                        where entity_id = $1 and status <> 'draft' and deleted_at is null)
             or exists (select 1 from bills
                        where entity_id = $1 and status <> 'draft' and deleted_at is null)
             or exists (select 1 from payments where entity_id = $1 and deleted_at is null)
             or exists (select 1 from vat_returns
                        where entity_id = $1 and status <> 'draft' and deleted_at is null)",
    )
    .bind(entity_id)
    .fetch_one(db)
    .await
}

async fn books_locked_change(
    db: &PgPool,
    entity_id: &str,
    change: LegalEntityCoreChange,
) -> Result<Option<String>, sqlx::Error> {
    if !change.any() {
        return Ok(None);
    }
    let postings = books_has_postings(db, entity_id).await?;
    if postings && (change.jurisdiction_code || change.base_currency) {
        return Ok(Some(format!(
            "The {} of this legal entity can no longer be changed because WeldBooks has posted transactions for it. Create a new legal entity instead.",
            change.changed_fields()
        )));
    }
    if !change.fiscal_year {
        return Ok(None);
    }
    if postings {
        return Ok(Some(
            "The fiscal year of this legal entity can no longer be changed because WeldBooks has posted transactions for it."
                .to_owned(),
        ));
    }
    let periods: bool = sqlx::query_scalar(
        "select exists (select 1 from fiscal_periods where entity_id = $1 and deleted_at is null)",
    )
    .bind(entity_id)
    .fetch_one(db)
    .await?;
    Ok(periods.then(|| {
        "The fiscal year of this legal entity can no longer be changed because WeldBooks has generated fiscal periods for it."
            .to_owned()
    }))
}

/// Per entity id, the apps enabled for it, in [`LegalEntityApp::ALL`] order
/// (`enabledAppsByEntity`). Every id of `entity_ids` has an entry.
pub async fn enabled_apps_by_entity(
    db: &PgPool,
    entity_ids: &[String],
) -> Result<HashMap<String, Vec<LegalEntityApp>>, sqlx::Error> {
    let mut result: HashMap<String, Vec<LegalEntityApp>> = entity_ids
        .iter()
        .map(|id| (id.clone(), Vec::new()))
        .collect();
    for app in LegalEntityApp::ALL {
        for id in app.enabled_for(db, entity_ids).await? {
            if let Some(apps) = result.get_mut(&id) {
                apps.push(app);
            }
        }
    }
    Ok(result)
}

/// The reason an enabled app forbids the change, or `None` (`lockedCoreChange`).
pub async fn locked_core_change(
    db: &PgPool,
    entity_id: &str,
    change: LegalEntityCoreChange,
) -> Result<Option<String>, sqlx::Error> {
    if !change.any() {
        return Ok(None);
    }
    for app in LegalEntityApp::ALL {
        if !app.is_enabled_for(db, entity_id).await? {
            continue;
        }
        if let Some(reason) = app.locked_change(db, entity_id, change).await? {
            return Ok(Some(reason));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_fields_reads_like_the_typescript() {
        let both = LegalEntityCoreChange {
            jurisdiction_code: true,
            base_currency: true,
            fiscal_year: false,
        };
        assert_eq!(both.changed_fields(), "base currency and country");
        let country = LegalEntityCoreChange {
            jurisdiction_code: true,
            ..LegalEntityCoreChange::default()
        };
        assert_eq!(country.changed_fields(), "country");
    }

    #[test]
    fn apps_round_trip() {
        for app in LegalEntityApp::ALL {
            assert_eq!(LegalEntityApp::parse(app.as_str()), Some(app));
            assert_eq!(
                serde_json::to_value(app).ok(),
                Some(serde_json::Value::String(app.as_str().to_owned()))
            );
        }
        assert_eq!(LegalEntityApp::parse("weldcrm"), None);
    }
}
