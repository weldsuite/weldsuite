//! What running a spec needs besides the compiler (`services/query-engine.ts`'s
//! `buildQueryContext`): the scope, the plan's retention, the project's
//! erased ids and identity flag ([`PanelProjectState`]), and the saved
//! cohorts, heatmap page groups, favourites, custom events, computed
//! properties, path rules and group types the spec uses, from the tenant
//! database and the master database.
//!
//! Only the definitions a spec refers to are loaded (`specReferences`), each
//! scoped to the project, and a definition that no longer parses is left out
//! (the compiler then refuses the spec with a 400 naming what is missing).
//!
//! Fails closed: without the project state the erased ids are unknown, and a
//! query that ignored them would show people who asked to be forgotten.

use std::collections::BTreeMap;
use std::sync::Arc;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::de::DeserializeOwned;
use serde_json::Value;
use weldsuite_db::{PgPool, orm};
use weldsuite_panel_domain::query::PanelQueryContext;
use weldsuite_panel_domain::query::plan_retention::event_retention_days;
use weldsuite_panel_domain::query::refs::{custom_event_references, spec_references};
use weldsuite_panel_domain::schemas::{
    CohortFilter, ComputedPropertyDefinition, CustomEventDefinition, PanelQuerySpec, PathRule,
};
use weldsuite_schema::tenant::{
    panel_cohorts, panel_computed_properties, panel_custom_events, panel_group_types,
    panel_heatmap_pages, panel_path_rules, panel_session_favorites,
};
use weldsuite_zod::Z;

use crate::project_state::{PanelProjectState, ProjectRef};
use crate::query::QueryFailure;
use crate::schemas_gen::{
    PANEL_COHORT_FILTER, PANEL_COMPUTED_PROPERTY_DEFINITION, PANEL_CUSTOM_EVENT_DEFINITION,
};

/// What [`build_query_context`] reads from.
pub(crate) struct ContextInput<'a> {
    pub(crate) tenant: &'a PgPool,
    /// The master database; `None` reads as a workspace without a plan.
    pub(crate) master: Option<&'a PgPool>,
    /// The project's state; `None` is panel-api without `PANEL_PROJECT` (503).
    pub(crate) state: Option<Arc<dyn PanelProjectState>>,
    pub(crate) workspace_id: &'a str,
    pub(crate) project_id: &'a str,
    pub(crate) spec: &'a PanelQuerySpec,
    /// The test's clock (conformance), else the real one.
    pub(crate) now: Option<i64>,
}

/// `schema.safeParse(value)`, then the domain's shape; `None` when either fails.
fn parse_definition<T: DeserializeOwned>(schema: &Z, value: &Value, what: &str) -> Option<T> {
    let parsed = weldsuite_zod::parse_issues(schema, value).ok()?;
    match serde_json::from_value(Value::Object(parsed.body)) {
        Ok(definition) => Some(definition),
        Err(error) => {
            tracing::warn!(%error, "[panel-api] a parsed {what} the compiler can't read");
            None
        }
    }
}

/// `loadPlanSlug`: the workspace's plan, `None` without one.
async fn plan_slug(master: Option<&PgPool>, workspace_id: &str) -> Result<Option<String>, DbErr> {
    let Some(master) = master else {
        return Ok(None);
    };
    crate::registry::plan_slug(master, workspace_id).await
}

/// The columns of a definitions table [`definitions`] reads: the id, the
/// definition, the project and the soft delete.
struct DefinitionColumns<C> {
    id: C,
    definition: C,
    project_id: C,
    deleted_at: C,
}

/// `(id, definition)` rows of a project's live definitions among `ids`.
async fn definitions<E: EntityTrait>(
    db: &PgPool,
    columns: DefinitionColumns<E::Column>,
    project_id: &str,
    ids: &[String],
) -> Result<Vec<(String, Value)>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    E::find()
        .select_only()
        .columns([columns.id, columns.definition])
        .filter(columns.project_id.eq(project_id))
        .filter(columns.id.is_in(ids.iter().map(String::as_str)))
        .filter(columns.deleted_at.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `loadCohortFilters`.
async fn cohort_filters(
    db: &PgPool,
    project_id: &str,
    ids: &[String],
) -> Result<BTreeMap<String, CohortFilter>, DbErr> {
    use panel_cohorts::Column;
    let columns = DefinitionColumns {
        id: Column::Id,
        definition: Column::Filter,
        project_id: Column::ProjectId,
        deleted_at: Column::DeletedAt,
    };
    let rows = definitions::<panel_cohorts::Entity>(db, columns, project_id, ids).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, filter)| {
            parse_definition(&PANEL_COHORT_FILTER, &filter, "cohort filter").map(|f| (id, f))
        })
        .collect())
}

/// What `loadDefinitions` answers.
struct Definitions {
    custom_events: BTreeMap<String, CustomEventDefinition>,
    computed_properties: BTreeMap<String, ComputedPropertyDefinition>,
    path_rules: Vec<PathRule>,
    group_types: Option<Vec<String>>,
}

/// `loadDefinitions`: the custom events, computed properties, path rules
/// and group types a spec uses (and only those).
async fn load_definitions(
    db: &PgPool,
    project_id: &str,
    spec: &PanelQuerySpec,
) -> Result<Definitions, DbErr> {
    let refs = spec_references(spec);
    let columns = DefinitionColumns {
        id: panel_custom_events::Column::Id,
        definition: panel_custom_events::Column::Definition,
        project_id: panel_custom_events::Column::ProjectId,
        deleted_at: panel_custom_events::Column::DeletedAt,
    };
    let rows = definitions::<panel_custom_events::Entity>(
        db,
        columns,
        project_id,
        &refs.custom_event_ids,
    )
    .await?;
    // In row order, as `Object.values()` reads them.
    let custom_events: Vec<(String, CustomEventDefinition)> = rows
        .into_iter()
        .filter_map(|(id, definition)| {
            parse_definition(&PANEL_CUSTOM_EVENT_DEFINITION, &definition, "custom event")
                .map(|d| (id, d))
        })
        .collect();
    let inner = custom_event_references(
        &custom_events
            .iter()
            .map(|(_, d)| d.clone())
            .collect::<Vec<_>>(),
    );
    let mut computed_ids = refs.computed_property_ids.clone();
    for id in inner.computed_property_ids {
        if !computed_ids.contains(&id) {
            computed_ids.push(id);
        }
    }
    let uses_groups = !refs.group_types.is_empty() || !inner.group_types.is_empty();

    let columns = DefinitionColumns {
        id: panel_computed_properties::Column::Id,
        definition: panel_computed_properties::Column::Definition,
        project_id: panel_computed_properties::Column::ProjectId,
        deleted_at: panel_computed_properties::Column::DeletedAt,
    };
    let computed_properties =
        definitions::<panel_computed_properties::Entity>(db, columns, project_id, &computed_ids)
            .await?
    .into_iter()
    .filter_map(|(id, definition)| {
        parse_definition(
            &PANEL_COMPUTED_PROPERTY_DEFINITION,
            &definition,
            "computed property",
        )
        .map(|d| (id, d))
    })
    .collect();
    let path_rules = if refs.uses_path_rules {
        panel_path_rules::Entity::find()
            .select_only()
            .columns([
                panel_path_rules::Column::Pattern,
                panel_path_rules::Column::Replacement,
            ])
            .filter(panel_path_rules::Column::ProjectId.eq(project_id))
            .order_by_asc(panel_path_rules::Column::Position)
            .into_tuple::<(String, String)>()
            .all(&orm(db))
            .await?
            .into_iter()
        .map(|(pattern, replacement)| PathRule {
            pattern,
            replacement,
        })
        .collect()
    } else {
        Vec::new()
    };
    let group_types = if uses_groups {
        Some(
            panel_group_types::Entity::find()
                .select_only()
                .column(panel_group_types::Column::GroupType)
                .filter(panel_group_types::Column::ProjectId.eq(project_id))
                .into_tuple::<String>()
                .all(&orm(db))
                .await?,
        )
    } else {
        None
    };
    Ok(Definitions {
        custom_events: custom_events.into_iter().collect(),
        computed_properties,
        path_rules,
        group_types,
    })
}

/// `buildQueryContext`: the compiler's scope for one request.
pub(crate) async fn build_query_context(
    input: ContextInput<'_>,
) -> Result<PanelQueryContext, QueryFailure> {
    let ContextInput {
        tenant,
        master,
        state,
        workspace_id,
        project_id,
        spec,
        now,
    } = input;
    let state = state.ok_or(QueryFailure::Unavailable)?;
    let project = ProjectRef {
        workspace_id,
        project_id,
    };

    let erased_ids = state
        .erased_ids(project)
        .await
        .map_err(QueryFailure::upstream)?;
    let has_identified_users = state
        .has_identified_users(project)
        .await
        .map_err(QueryFailure::upstream)?;
    let slug = plan_slug(master, workspace_id)
        .await
        .map_err(QueryFailure::upstream)?;
    let cohorts = cohort_filters(tenant, project_id, &spec_references(spec).cohort_ids)
        .await
        .map_err(QueryFailure::upstream)?;

    let mut page_groups = BTreeMap::new();
    if let PanelQuerySpec::Heatmap(heatmap) = spec
        && let Some(page_group_id) = &heatmap.page_group_id
    {
        let rows: Vec<(String, String)> = panel_heatmap_pages::Entity::find()
            .select_only()
            .columns([
                panel_heatmap_pages::Column::Id,
                panel_heatmap_pages::Column::UrlPattern,
            ])
            .filter(panel_heatmap_pages::Column::ProjectId.eq(project_id))
            .filter(panel_heatmap_pages::Column::Id.eq(page_group_id.as_str()))
            .into_tuple()
            .all(&orm(tenant))
            .await
            .map_err(QueryFailure::upstream)?;
        page_groups.extend(rows);
    }

    let favourites: Vec<String> = match spec {
        PanelQuerySpec::Sessions(sessions) if sessions.favorites_only == Some(true) => {
            panel_session_favorites::Entity::find()
                .select_only()
                .column(panel_session_favorites::Column::SessionId)
                .filter(panel_session_favorites::Column::ProjectId.eq(project_id))
                .into_tuple()
                .all(&orm(tenant))
                .await
                .map_err(QueryFailure::upstream)?
        }
        _ => Vec::new(),
    };

    let definitions = load_definitions(tenant, project_id, spec)
        .await
        .map_err(QueryFailure::upstream)?;

    Ok(PanelQueryContext {
        workspace_id: workspace_id.to_owned(),
        project_id: project_id.to_owned(),
        // 366 or 762 days.
        retention_days: f64::from(
            i32::try_from(event_retention_days(slug.as_deref())).unwrap_or(i32::MAX),
        ),
        has_identified_users,
        erased_ids,
        cohorts: Some(cohorts),
        page_groups: Some(page_groups),
        favorite_session_ids: Some(favourites),
        custom_events: Some(definitions.custom_events),
        computed_properties: Some(definitions.computed_properties),
        path_rules: Some(definitions.path_rules),
        group_types: definitions.group_types,
        now,
    })
}
