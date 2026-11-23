//! Per-entity access for the WeldHR routes (`routes/weldhr/entity-scope.ts`,
//! `services/weldhr/entity-scope.ts`; weldsuite-documentation/plans/legal-entities.md,
//! "Per-entity access").
//!
//! [`legal_entity_context`](weldsuite_legal_entities::legal_entity_context)
//! (mounted in [`crate::router`]) resolves the request's entity and swaps in
//! the member's entity role; this module turns that into what the routes need:
//!
//! - list scoping: a [`Scope`], a condition on the employee's (or employer's)
//!   legal entity the queries add to their filters. Without an
//!   `X-Legal-Entity-Id` header a member sees the entities where they act with
//!   their workspace role, never one where an entity role applies;
//! - by-id checks: a record of an entity the request may not touch answers
//!   404, not 403 ([`guard`] for `/<prefix>/<id>` paths, the `assert_*`
//!   helpers for ids in a body), so a restricted entity's records are never
//!   confirmed.
//!
//! A record's entity is its employee's `legal_entity_id` (its employer's for
//! payroll setup); a row without one counts as the default entity's.

use sea_orm::sea_query::Query;
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_db::orm;
use weldsuite_legal_entities::{
    EntityRecordGuard, EntityRecordGuardLayer, EntityScopeCondition, LegalEntityApp, RecordLookup,
    RequestEntity, can_see_entity, default_entity_id_for, entity_scope_condition,
    record_in_request_entity, request_entity_scope,
};
use weldsuite_schema::tenant::{hr_employees, hr_payroll_employers};

use crate::{Caller, HrError};

/// WeldHR works with any legal entity.
pub(crate) const HR_APP: LegalEntityApp = LegalEntityApp::Weldhr;

/// The entity scope of a list (`employeeEntityCondition` /
/// `employerEntityCondition`): which `legal_entity_id`s it may return rows
/// of. [`Scope::ALL`] is no filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Scope(EntityScopeCondition);

impl Scope {
    /// No filter (`undefined`): a route outside the entity context, or a
    /// member whose access is the same everywhere.
    pub(crate) const ALL: Self = Self(EntityScopeCondition::All);

    /// The request's scope: `requestEntityScope(c)`, with the default entity
    /// read only when a filter applies (rows without an entity count as its).
    pub(crate) async fn of(
        db: &weldsuite_db::PgPool,
        request: Option<&RequestEntity>,
    ) -> Result<Self, HrError> {
        let Some(request) = request else {
            return Ok(Self::ALL);
        };
        let scope = request_entity_scope(request);
        let default = match &scope {
            Some(_) => default_entity_id_for(db, Some(HR_APP)).await?,
            None => None,
        };
        Ok(Self(entity_scope_condition(
            scope.as_deref(),
            default.as_deref(),
        )))
    }

    /// `entityScopeCondition(column, …)` as a condition: no filter,
    /// none of the rows, or the entities allowed (and the rows without an
    /// entity when the default one is among them).
    pub(crate) fn condition(&self, column: impl ColumnTrait) -> Condition {
        match &self.0 {
            EntityScopeCondition::All => Condition::all(),
            EntityScopeCondition::Nothing => {
                Condition::all().add(column.is_in(Vec::<String>::new()))
            }
            EntityScopeCondition::In {
                ids,
                include_unassigned,
            } => {
                let scoped = Condition::any().add(column.is_in(ids.iter().map(String::as_str)));
                if *include_unassigned {
                    scoped.add(column.is_null())
                } else {
                    scoped
                }
            }
        }
    }

    /// `employeeIdIn(column, scope)`: `column in (select id from
    /// hr_employees where <scope on legal_entity_id>)`; no filter for
    /// [`Scope::ALL`].
    pub(crate) fn employee_id_in(&self, column: impl ColumnTrait) -> Condition {
        if !self.0.is_filtered() {
            return Condition::all();
        }
        Condition::all().add(
            column.in_subquery(
                Query::select()
                    .column(hr_employees::Column::Id)
                    .from(hr_employees::Entity)
                    .cond_where(self.condition(hr_employees::Column::LegalEntityId))
                    .to_owned(),
            ),
        )
    }

    /// `employerIdIn(column, scope)`: `column in (select id from
    /// hr_payroll_employers where <scope on legal_entity_id>)`; no filter for
    /// [`Scope::ALL`].
    pub(crate) fn employer_id_in(&self, column: impl ColumnTrait) -> Condition {
        if !self.0.is_filtered() {
            return Condition::all();
        }
        Condition::all().add(
            column.in_subquery(
                Query::select()
                    .column(hr_payroll_employers::Column::Id)
                    .from(hr_payroll_employers::Entity)
                    .cond_where(self.condition(hr_payroll_employers::Column::LegalEntityId))
                    .to_owned(),
            ),
        )
    }
}

impl Default for Scope {
    fn default() -> Self {
        Self::ALL
    }
}

/// `guardRecord(router, param, resource, resolve, prefix)`: a 404 for
/// `<prefix>/<id>` and everything under it when the record (its entity found
/// with `lookup`) belongs to an entity the request may not touch. Add it with
/// `route_layer`.
pub(crate) fn guard(
    prefix: &'static str,
    label: &'static str,
    lookup: RecordLookup,
) -> EntityRecordGuardLayer {
    EntityRecordGuard::lookup(lookup, label)
        .prefix(prefix)
        .unassigned_as_default(Some(HR_APP))
        .layer()
}

/// `viaEmployee(table, id, employee)`: a record of the `hr_*` entity `$table`
/// (by its `id`), keyed by its employee's entity.
macro_rules! via_employee {
    ($table:ident) => {
        weldsuite_legal_entities::RecordLookup::via::<
            weldsuite_schema::tenant::$table::Entity,
            weldsuite_schema::tenant::hr_employees::Entity,
        >(
            weldsuite_schema::tenant::$table::Column::Id,
            weldsuite_schema::tenant::$table::Column::EmployeeId,
            weldsuite_schema::tenant::hr_employees::Column::Id,
            weldsuite_schema::tenant::hr_employees::Column::LegalEntityId,
        )
    };
}

/// `viaEmployer(table, id, employer)`: a record of the `hr_*` entity `$table`
/// (by its `id`), keyed by its employer's entity.
macro_rules! via_employer {
    ($table:ident) => {
        weldsuite_legal_entities::RecordLookup::via::<
            weldsuite_schema::tenant::$table::Entity,
            weldsuite_schema::tenant::hr_payroll_employers::Entity,
        >(
            weldsuite_schema::tenant::$table::Column::Id,
            weldsuite_schema::tenant::$table::Column::EmployerId,
            weldsuite_schema::tenant::hr_payroll_employers::Column::Id,
            weldsuite_schema::tenant::hr_payroll_employers::Column::LegalEntityId,
        )
    };
}

pub(crate) use {via_employee, via_employer};

/// `employeeRecord`: an employee by id.
pub(crate) fn employee_record() -> RecordLookup {
    RecordLookup::column::<hr_employees::Entity>(
        hr_employees::Column::Id,
        hr_employees::Column::LegalEntityId,
    )
}

/// `employerRecord`: an employer by id.
pub(crate) fn employer_record() -> RecordLookup {
    RecordLookup::column::<hr_payroll_employers::Entity>(
        hr_payroll_employers::Column::Id,
        hr_payroll_employers::Column::LegalEntityId,
    )
}

impl Caller {
    /// The request's list scope ([`Scope::of`]).
    pub(crate) async fn scope(&self) -> Result<Scope, HrError> {
        Scope::of(&self.db, self.entity.as_ref()).await
    }

    /// `entityAllowed(c, entityId)`: may this request touch a record of
    /// `entity_id`? A row without an entity counts as the default entity's.
    pub(crate) async fn entity_allowed(&self, entity_id: Option<&str>) -> Result<bool, HrError> {
        let Some(request) = &self.entity else {
            return Ok(true);
        };
        if request.access().uniform {
            return Ok(true);
        }
        let effective = match entity_id {
            Some(id) => Some(id.to_owned()),
            None => default_entity_id_for(&self.db, Some(HR_APP)).await?,
        };
        Ok(record_in_request_entity(request, effective.as_deref()))
    }

    /// A 404 (`resource`) unless the record of `entity` (its id column,
    /// `id_column`, and its `legal_entity_id`, `entity_column`) is in an
    /// entity this request may touch. A missing record is left to the
    /// caller.
    async fn assert_record_visible<E: EntityTrait>(
        &self,
        id_column: E::Column,
        entity_column: E::Column,
        resource: &str,
        id: Option<&str>,
    ) -> Result<(), HrError> {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            return Ok(());
        };
        if self
            .entity
            .as_ref()
            .is_none_or(|request| request.access().uniform)
        {
            return Ok(());
        }
        let row: Option<Option<String>> = E::find()
            .select_only()
            .column(entity_column)
            .filter(id_column.eq(id))
            .into_tuple()
            .one(&orm(&self.db))
            .await?;
        if let Some(entity) = row
            && !self.entity_allowed(entity.as_deref()).await?
        {
            return Err(HrError::not_found(resource, id));
        }
        Ok(())
    }

    /// `assertEmployeeVisible(c, employeeId)` ([`employee_record`]).
    pub(crate) async fn assert_employee_visible(&self, id: Option<&str>) -> Result<(), HrError> {
        self.assert_record_visible::<hr_employees::Entity>(
            hr_employees::Column::Id,
            hr_employees::Column::LegalEntityId,
            "Employee",
            id,
        )
        .await
    }

    /// `assertEmployerVisible(c, employerId)` ([`employer_record`]).
    pub(crate) async fn assert_employer_visible(&self, id: Option<&str>) -> Result<(), HrError> {
        self.assert_record_visible::<hr_payroll_employers::Entity>(
            hr_payroll_employers::Column::Id,
            hr_payroll_employers::Column::LegalEntityId,
            "Payroll employer",
            id,
        )
        .await
    }

    /// `assertEntityUsable(c, entityId)`: a legal entity this request may put
    /// a record in: the member sees it and acts there with the role the
    /// request was checked with. Anything else is a `Legal entity` 404.
    pub(crate) fn assert_entity_usable(&self, entity_id: &str) -> Result<(), HrError> {
        if self.entity_usable(entity_id) {
            Ok(())
        } else {
            Err(HrError::not_found("Legal entity", entity_id))
        }
    }

    /// The check behind [`Self::assert_entity_usable`].
    fn entity_usable(&self, entity_id: &str) -> bool {
        self.entity.as_ref().is_none_or(|request| {
            can_see_entity(request.access(), Some(entity_id))
                && record_in_request_entity(request, Some(entity_id))
        })
    }

    /// `resolveNewEmployeeEntity(c, requested)`: the request's entity
    /// (`X-Legal-Entity-Id`), else the one the body names, else the
    /// workspace default, else none. A request that names an entity it may
    /// not use (unknown, hidden, not WeldHR's) is a `Legal entity` 404, never
    /// the body's or the default; the body's and the default must pass the
    /// check of [`Self::assert_entity_usable`]. A refused default is a 404
    /// without its id: the caller never named it, and may not even see it.
    pub(crate) async fn resolve_new_employee_entity(
        &self,
        requested: Option<&str>,
    ) -> Result<Option<String>, HrError> {
        let requested = requested.filter(|id| !id.is_empty());
        if let Some(from_request) = self
            .entity
            .as_ref()
            .and_then(RequestEntity::entity_id)
            .filter(|id| !id.is_empty())
        {
            if requested.is_some_and(|requested| requested != from_request) {
                return Err(HrError::validation(
                    "legalEntityId is not the legal entity this request is scoped to",
                ));
            }
            return Ok(Some(from_request.to_owned()));
        }
        if let Some(named) = self.entity.as_ref().and_then(RequestEntity::requested) {
            return Err(HrError::not_found("Legal entity", named));
        }
        if let Some(requested) = requested {
            self.assert_entity_usable(requested)?;
            return Ok(Some(requested.to_owned()));
        }
        let fallback = default_entity_id_for(&self.db, Some(HR_APP)).await?;
        if let Some(fallback) = fallback.as_deref()
            && !self.entity_usable(fallback)
        {
            return Err(HrError::not_found_message(
                "Legal entity",
                fallback,
                "Legal entity not found",
            ));
        }
        Ok(fallback)
    }
}

/// `isWorkspaceLevel(path)`: workspace-level setup and My HR are not about
/// one legal entity; they skip the entity context (no entity resolved, no
/// role swapped) and are never filtered.
pub(crate) fn is_workspace_level(path: &str) -> bool {
    const WORKSPACE_LEVEL_SEGMENTS: [&str; 9] = [
        "departments",
        "leave-types",
        "work-locations",
        "checklist-templates",
        "evaluation-forms",
        "kpis",
        "announcements",
        "settings",
        "me",
    ];
    let rest = path
        .strip_prefix("/api/weldhr/")
        .unwrap_or_else(|| path.trim_start_matches('/'));
    let first = rest.split('/').next().unwrap_or_default();
    WORKSPACE_LEVEL_SEGMENTS.contains(&first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_level_paths_skip_the_entity_context() {
        for path in [
            "/departments",
            "/departments/d1",
            "/me",
            "/me/payroll/payslips",
            "/kpis/k1",
            "/api/weldhr/settings",
            "/announcements",
        ] {
            assert!(is_workspace_level(path), "{path}");
        }
        for path in [
            "/employees",
            "/kpi-values",
            "/open-shifts",
            "/payroll/employers",
            "/dashboard",
            "/api/weldhr/employees/x",
            "/",
        ] {
            assert!(!is_workspace_level(path), "{path}");
        }
    }

    #[test]
    fn record_lookups_join_the_employee_or_employer() {
        use sea_orm::DbBackend;
        let sql = |lookup: RecordLookup| DbBackend::Postgres.build(&lookup.statement("x")).to_string();
        assert_eq!(
            sql(via_employee!(hr_absences)),
            r#"SELECT "hr_employees"."legal_entity_id" FROM "hr_absences" INNER JOIN "hr_employees" ON "hr_absences"."employee_id" = "hr_employees"."id" WHERE "hr_absences"."id" = 'x' LIMIT 1"#
        );
        assert_eq!(
            sql(via_employer!(hr_pay_runs)),
            r#"SELECT "hr_payroll_employers"."legal_entity_id" FROM "hr_pay_runs" INNER JOIN "hr_payroll_employers" ON "hr_pay_runs"."employer_id" = "hr_payroll_employers"."id" WHERE "hr_pay_runs"."id" = 'x' LIMIT 1"#
        );
        assert_eq!(
            sql(employee_record()),
            r#"SELECT "hr_employees"."legal_entity_id" FROM "hr_employees" WHERE "hr_employees"."id" = 'x' LIMIT 1"#
        );
    }

    #[test]
    fn the_scope_as_a_condition_matches_the_sql() {
        use sea_orm::{DbBackend, QueryTrait};
        use weldsuite_schema::tenant::hr_absences;
        assert_eq!(Scope::default(), Scope::ALL);
        let employees = |scope: &Scope| {
            hr_employees::Entity::find()
                .select_only()
                .column(hr_employees::Column::Id)
                .filter(scope.condition(hr_employees::Column::LegalEntityId))
                .build(DbBackend::Postgres)
                .to_string()
        };
        let absences = |scope: &Scope| {
            hr_absences::Entity::find()
                .select_only()
                .column(hr_absences::Column::Id)
                .filter(scope.employee_id_in(hr_absences::Column::EmployeeId))
                .build(DbBackend::Postgres)
                .to_string()
        };
        // No filter: an empty `Condition::all()` (`WHERE TRUE`).
        for all in [employees(&Scope::ALL), absences(&Scope::ALL)] {
            assert!(!all.contains(" IN ") && !all.contains("IS NULL"), "{all}");
        }
        let nothing = Scope(EntityScopeCondition::Nothing);
        assert!(employees(&nothing).ends_with("WHERE 1 = 2"));
        let named = Scope(EntityScopeCondition::In {
            ids: vec!["ent_a".to_owned()],
            include_unassigned: true,
        });
        assert!(employees(&named).ends_with(
            r#"WHERE "hr_employees"."legal_entity_id" IN ('ent_a') OR "hr_employees"."legal_entity_id" IS NULL"#
        ));
        let by_employee = absences(&named);
        assert!(
            by_employee.contains(r#"WHERE "hr_absences"."employee_id" IN (SELECT "#),
            "{by_employee}"
        );
        assert!(
            by_employee.ends_with(
                r#"FROM "hr_employees" WHERE "hr_employees"."legal_entity_id" IN ('ent_a') OR "hr_employees"."legal_entity_id" IS NULL)"#
            ),
            "{by_employee}"
        );
        let only = Scope(EntityScopeCondition::In {
            ids: vec!["ent_a".to_owned()],
            include_unassigned: false,
        });
        assert!(
            employees(&only).ends_with(r#"WHERE "hr_employees"."legal_entity_id" IN ('ent_a')"#)
        );
    }
}
