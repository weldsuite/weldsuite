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

use sea_orm::sea_query::{Expr, Query, SelectStatement};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use weldsuite_db::orm;
use weldsuite_schema::tenant::{
    accounting_entity_settings, bills, fiscal_periods, hr_employees, hr_pay_runs,
    hr_payroll_employers, invoices, journal_entries, payments, vat_returns,
};

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
    ) -> Result<HashSet<String>, DbErr> {
        match self {
            Self::Weldhr => Ok(entity_ids.iter().cloned().collect()),
            Self::Weldbooks => {
                if entity_ids.is_empty() {
                    return Ok(HashSet::new());
                }
                let ids: Vec<String> = accounting_entity_settings::Entity::find()
                    .select_only()
                    .column(accounting_entity_settings::Column::EntityId)
                    .filter(accounting_entity_settings::Column::EntityId.is_in(entity_ids))
                    .into_tuple()
                    .all(&orm(db))
                    .await?;
                Ok(ids.into_iter().collect())
            }
        }
    }

    /// Whether the app is enabled for one entity.
    pub async fn is_enabled_for(self, db: &PgPool, entity_id: &str) -> Result<bool, DbErr> {
        let ids = [entity_id.to_owned()];
        Ok(self.enabled_for(db, &ids).await?.contains(entity_id))
    }

    /// Whether the app holds data for the entity (`hasData`; blocks deletion):
    /// WeldBooks any invoice, bill or journal entry; WeldHR a live employee or
    /// payroll employer.
    pub async fn has_data(self, db: &PgPool, entity_id: &str) -> Result<bool, DbErr> {
        let queries = match self {
            Self::Weldbooks => vec![
                rows_of(
                    invoices::Entity,
                    Condition::all().add(invoices::Column::EntityId.eq(entity_id)),
                ),
                rows_of(
                    bills::Entity,
                    Condition::all().add(bills::Column::EntityId.eq(entity_id)),
                ),
                rows_of(
                    journal_entries::Entity,
                    Condition::all().add(journal_entries::Column::EntityId.eq(entity_id)),
                ),
            ],
            Self::Weldhr => vec![
                rows_of(
                    hr_employees::Entity,
                    Condition::all()
                        .add(hr_employees::Column::LegalEntityId.eq(entity_id))
                        .add(hr_employees::Column::DeletedAt.is_null()),
                ),
                rows_of(
                    hr_payroll_employers::Entity,
                    Condition::all()
                        .add(hr_payroll_employers::Column::LegalEntityId.eq(entity_id))
                        .add(hr_payroll_employers::Column::DeletedAt.is_null()),
                ),
            ],
        };
        any_exists(db, queries).await
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
    ) -> Result<Option<String>, DbErr> {
        match self {
            Self::Weldbooks => books_locked_change(db, entity_id, change).await,
            Self::Weldhr => {
                if !change.jurisdiction_code && !change.base_currency {
                    return Ok(None);
                }
                let run = any_exists(db, [pay_runs_of(entity_id)]).await?;
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

/// `select 1 from <table> where <condition>`: the rows an `exists` probes.
fn rows_of(table: impl EntityTrait, condition: Condition) -> SelectStatement {
    Query::select()
        .expr(Expr::val(1))
        .from(table)
        .cond_where(condition)
        .to_owned()
}

/// `select exists (a) or exists (b) …`, one statement: whether any of the
/// queries finds a row.
async fn any_exists(
    db: &PgPool,
    queries: impl IntoIterator<Item = SelectStatement>,
) -> Result<bool, DbErr> {
    let mut probes = queries.into_iter().map(Expr::exists);
    let Some(first) = probes.next() else {
        return Ok(false);
    };
    let any = probes.fold(first, sea_orm::ExprTrait::or);
    let statement = Query::select().expr(any).to_owned();
    match orm(db).query_one(&statement).await? {
        Some(row) => row.try_get_by_index(0),
        None => Ok(false),
    }
}

/// WeldHR pay runs of the entity's employers (`hr_pay_runs r join
/// hr_payroll_employers e on e.id = r.employer_id where e.legal_entity_id = $1`).
fn pay_runs_of(entity_id: &str) -> SelectStatement {
    Query::select()
        .expr(Expr::val(1))
        .from(hr_pay_runs::Entity)
        .inner_join(
            hr_payroll_employers::Entity,
            sea_orm::ExprTrait::equals(
                Expr::col((
                    hr_payroll_employers::Entity,
                    hr_payroll_employers::Column::Id,
                )),
                (hr_pay_runs::Entity, hr_pay_runs::Column::EmployerId),
            ),
        )
        .cond_where(Condition::all().add(hr_payroll_employers::Column::LegalEntityId.eq(entity_id)))
        .to_owned()
}

/// Finalized WeldBooks records (`booksHasPostings`): the same definition as
/// books-api's `entityHasPostings`, which guards WeldBooks' own PATCH.
async fn books_has_postings(db: &PgPool, entity_id: &str) -> Result<bool, DbErr> {
    any_exists(
        db,
        [
            rows_of(
                journal_entries::Entity,
                Condition::all()
                    .add(journal_entries::Column::EntityId.eq(entity_id))
                    .add(journal_entries::Column::Status.ne("draft"))
                    .add(journal_entries::Column::DeletedAt.is_null()),
            ),
            rows_of(
                invoices::Entity,
                Condition::all()
                    .add(invoices::Column::EntityId.eq(entity_id))
                    .add(invoices::Column::Status.ne("draft"))
                    .add(invoices::Column::DeletedAt.is_null()),
            ),
            rows_of(
                bills::Entity,
                Condition::all()
                    .add(bills::Column::EntityId.eq(entity_id))
                    .add(bills::Column::Status.ne("draft"))
                    .add(bills::Column::DeletedAt.is_null()),
            ),
            rows_of(
                payments::Entity,
                Condition::all()
                    .add(payments::Column::EntityId.eq(entity_id))
                    .add(payments::Column::DeletedAt.is_null()),
            ),
            rows_of(
                vat_returns::Entity,
                Condition::all()
                    .add(vat_returns::Column::EntityId.eq(entity_id))
                    .add(vat_returns::Column::Status.ne("draft"))
                    .add(vat_returns::Column::DeletedAt.is_null()),
            ),
        ],
    )
    .await
}

async fn books_locked_change(
    db: &PgPool,
    entity_id: &str,
    change: LegalEntityCoreChange,
) -> Result<Option<String>, DbErr> {
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
    let periods = any_exists(
        db,
        [rows_of(
            fiscal_periods::Entity,
            Condition::all()
                .add(fiscal_periods::Column::EntityId.eq(entity_id))
                .add(fiscal_periods::Column::DeletedAt.is_null()),
        )],
    )
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
) -> Result<HashMap<String, Vec<LegalEntityApp>>, DbErr> {
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
) -> Result<Option<String>, DbErr> {
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
    fn probes_read_like_the_sql() {
        use sea_orm::DbBackend;
        let probe = |statement: &SelectStatement| DbBackend::Postgres.build(statement).sql;
        assert_eq!(
            probe(&pay_runs_of("ent_1")),
            r#"SELECT $1 FROM "hr_pay_runs" INNER JOIN "hr_payroll_employers" ON "hr_payroll_employers"."id" = "hr_pay_runs"."employer_id" WHERE "hr_payroll_employers"."legal_entity_id" = $2"#
        );
        let rows = rows_of(
            invoices::Entity,
            Condition::all()
                .add(invoices::Column::EntityId.eq("ent_1"))
                .add(invoices::Column::Status.ne("draft")),
        );
        let exists = Query::select()
            .expr(sea_orm::ExprTrait::or(
                Expr::exists(rows.clone()),
                Expr::exists(rows),
            ))
            .to_owned();
        assert_eq!(
            probe(&exists),
            r#"SELECT EXISTS(SELECT $1 FROM "invoices" WHERE "invoices"."entity_id" = $2 AND "invoices"."status" <> $3) OR EXISTS(SELECT $4 FROM "invoices" WHERE "invoices"."entity_id" = $5 AND "invoices"."status" <> $6)"#
        );
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
