//! Per-entity access for the WeldHR routes (`routes/weldhr/entity-scope.ts`,
//! `services/weldhr/entity-scope.ts`; docs/plans/legal-entities.md,
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

use weldsuite_legal_entities::{
    EntityRecordGuard, EntityRecordGuardLayer, EntityScopeCondition, LegalEntityApp, RequestEntity,
    can_see_entity, default_entity_id_for, entity_scope_condition, record_in_request_entity,
    request_entity_scope,
};

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

    /// The `$ids` bind of the scope condition the queries carry
    /// ([`EntityScopeCondition::sql`] over their own column, or through
    /// `hr_employees` / `hr_payroll_employers` for a table keyed by employee
    /// or employer: `employeeIdIn` / `employerIdIn`): `None` for no filter,
    /// an empty list for nothing.
    pub(crate) fn ids(&self) -> Option<Vec<String>> {
        self.0.ids_bind()
    }

    /// The `$unassigned` bind of the scope condition (rows without an entity
    /// count as the default entity's).
    pub(crate) fn unassigned(&self) -> bool {
        self.0.unassigned_bind()
    }
}

impl Default for Scope {
    fn default() -> Self {
        Self::ALL
    }
}

/// `guardRecord(router, param, resource, resolve, prefix)`: a 404 for
/// `<prefix>/<id>` and everything under it when the record (found with
/// `sql`, the id as `$1`, the entity as the first column) belongs to an
/// entity the request may not touch. Add it with `route_layer`.
pub(crate) fn guard(
    prefix: &'static str,
    label: &'static str,
    sql: &'static str,
) -> EntityRecordGuardLayer {
    EntityRecordGuard::query(sql, label)
        .prefix(prefix)
        .unassigned_as_default(Some(HR_APP))
        .layer()
}

/// `viaEmployee(table, id, employee)`: a record keyed by its employee's entity.
macro_rules! via_employee {
    ($table:literal) => {
        concat!(
            "select scope_e.legal_entity_id from ",
            $table,
            " scope_t join hr_employees scope_e on scope_e.id = scope_t.employee_id",
            " where scope_t.id = $1 limit 1"
        )
    };
}

/// `viaEmployer(table, id, employer)`: a record keyed by its employer's entity.
macro_rules! via_employer {
    ($table:literal) => {
        concat!(
            "select scope_p.legal_entity_id from ",
            $table,
            " scope_t join hr_payroll_employers scope_p on scope_p.id = scope_t.employer_id",
            " where scope_t.id = $1 limit 1"
        )
    };
}

pub(crate) use {via_employee, via_employer};

/// `employeeRecord`: an employee by id.
pub(crate) const EMPLOYEE_RECORD: &str =
    "select legal_entity_id from hr_employees where id = $1 limit 1";

/// `employerRecord`: an employer by id.
pub(crate) const EMPLOYER_RECORD: &str =
    "select legal_entity_id from hr_payroll_employers where id = $1 limit 1";

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

    /// A 404 (`resource`) unless the record `sql` finds is in an entity this
    /// request may touch. A missing record is left to the caller.
    async fn assert_record_visible(
        &self,
        sql: &'static str,
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
        let row: Option<Option<String>> = sqlx::query_scalar(sql)
            .bind(id)
            .fetch_optional(&self.db)
            .await?;
        if let Some(entity) = row
            && !self.entity_allowed(entity.as_deref()).await?
        {
            return Err(HrError::not_found(resource, id));
        }
        Ok(())
    }

    /// `assertEmployeeVisible(c, employeeId)`.
    pub(crate) async fn assert_employee_visible(&self, id: Option<&str>) -> Result<(), HrError> {
        self.assert_record_visible(EMPLOYEE_RECORD, "Employee", id)
            .await
    }

    /// `assertEmployerVisible(c, employerId)`.
    pub(crate) async fn assert_employer_visible(&self, id: Option<&str>) -> Result<(), HrError> {
        self.assert_record_visible(EMPLOYER_RECORD, "Payroll employer", id)
            .await
    }

    /// `assertEntityUsable(c, entityId)`: a legal entity this request may put
    /// a record in: the member sees it and acts there with the role the
    /// request was checked with. Anything else is a `Legal entity` 404.
    pub(crate) fn assert_entity_usable(&self, entity_id: &str) -> Result<(), HrError> {
        let Some(request) = &self.entity else {
            return Ok(());
        };
        if !can_see_entity(request.access(), Some(entity_id))
            || !record_in_request_entity(request, Some(entity_id))
        {
            return Err(HrError::not_found("Legal entity", entity_id));
        }
        Ok(())
    }

    /// `resolveNewEmployeeEntity(c, requested)`: the request's entity
    /// (`X-Legal-Entity-Id`), else the one the body names, else the
    /// workspace default, else none.
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
        if let Some(requested) = requested {
            self.assert_entity_usable(requested)?;
            return Ok(Some(requested.to_owned()));
        }
        Ok(default_entity_id_for(&self.db, Some(HR_APP)).await?)
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
        assert_eq!(
            via_employee!("hr_absences"),
            "select scope_e.legal_entity_id from hr_absences scope_t join hr_employees scope_e \
             on scope_e.id = scope_t.employee_id where scope_t.id = $1 limit 1"
        );
        assert_eq!(
            via_employer!("hr_pay_runs"),
            "select scope_p.legal_entity_id from hr_pay_runs scope_t join hr_payroll_employers \
             scope_p on scope_p.id = scope_t.employer_id where scope_t.id = $1 limit 1"
        );
    }

    #[test]
    fn the_scope_binds_match_the_condition() {
        // The queries inline `EntityScopeCondition::sql` over their own column.
        assert_eq!(
            EntityScopeCondition::sql("e.legal_entity_id", 5, 6),
            "($5::text[] is null or e.legal_entity_id = any($5) or ($6::boolean and \
             e.legal_entity_id is null))"
        );
        assert_eq!(Scope::ALL.ids(), None);
        assert!(!Scope::ALL.unassigned());
        assert_eq!(Scope::default(), Scope::ALL);
        let named = Scope(EntityScopeCondition::In {
            ids: vec!["ent_a".to_owned()],
            include_unassigned: true,
        });
        assert_eq!(named.ids(), Some(vec!["ent_a".to_owned()]));
        assert!(named.unassigned());
        assert_eq!(Scope(EntityScopeCondition::Nothing).ids(), Some(Vec::new()));
    }
}
