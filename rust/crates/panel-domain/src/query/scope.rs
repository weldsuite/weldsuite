//! The scoped read of `events_v1` (`scope.ts`): the one place that writes the
//! workspace and project filters, the time bound, the erased-id exclusion,
//! the identity join, the person-property join and the group-property joins.
//!
//! Aliases: `e` events, `i` latest identity per anonymous id, `pp` latest
//! profile per user, `g_<type>` latest profile of the event's group of that
//! type. Also here: what a spec's references stand for (custom events,
//! computed properties), from the definitions in the context.

use super::context::{BASIN_NAMESPACE, PanelQueryContext};
use super::paths::cleaned_path_sql;
use super::sql::{
    LIKE_ESCAPE, PanelQueryError, QueryResult, RefKind, compare_text, event_name,
    group_type as checked_group_type, in_list, int, like_contains, lit, num, property_key,
    ref_id_of, ts,
};
use super::time::{ResolvedRange, TimeBounds, query_now};
use crate::expression::{
    ExpressionIdentifierKind, ParseExpressionOptions, parse_expression, to_sql,
};
use crate::js::{self, DAY_MS};
use crate::schemas::{
    AggregateBy, CohortCondition, CohortFilter, CohortMatch, ComputedPropertyDefinition,
    ComputedPropertySource, CustomEventDefinition, FilterColumn, FilterListItem, FilterOperator,
    FilterValue, PanelBreakdown, PanelFilter,
};
use crate::tables;
use crate::wire::{group_key_property, is_computed_property_ref, is_custom_event_ref};

const MAX_ERASED_IN_SQL: usize = 5000;

/// `panel.events_v1`.
pub fn events_table() -> String {
    format!("{BASIN_NAMESPACE}.{}", tables::EVENTS)
}
/// `panel.identities_v1`.
pub fn identities_table() -> String {
    format!("{BASIN_NAMESPACE}.{}", tables::IDENTITIES)
}
/// `panel.people_v1`.
pub fn people_table() -> String {
    format!("{BASIN_NAMESPACE}.{}", tables::PEOPLE)
}
/// `panel.groups_v1`.
pub fn groups_table() -> String {
    format!("{BASIN_NAMESPACE}.{}", tables::GROUPS)
}
/// `panel.replay_chunks_v1`.
pub fn replay_chunks_table() -> String {
    format!("{BASIN_NAMESPACE}.{}", tables::REPLAY_CHUNKS)
}

/// `workspace_id = … AND project_id = …`, from the authenticated context only.
pub fn scope_conds(ctx: &PanelQueryContext, prefix: &str) -> QueryResult<Vec<String>> {
    Ok(vec![
        format!("{prefix}workspace_id = {}", lit(&ctx.workspace_id)?),
        format!("{prefix}project_id = {}", lit(&ctx.project_id)?),
    ])
}

fn erased_list(ctx: &PanelQueryContext) -> QueryResult<Vec<String>> {
    let ids = js::distinct(ctx.erased_ids.iter().cloned());
    if ids.len() > MAX_ERASED_IN_SQL {
        return Err(PanelQueryError::new(
            "Too many erasures are waiting to be applied; try again shortly",
        ));
    }
    Ok(ids)
}

/// Everything a query reads about people lives between the retention floor and now.
pub fn history_bounds(ctx: &PanelQueryContext, range: &ResolvedRange, column: &str) -> Vec<String> {
    vec![
        format!("{column} >= {}", ts(range.floor)),
        format!("{column} <= {}", ts(query_now(ctx))),
    ]
}

/// `identitiesLatest`: the latest identity link per anonymous id (the first
/// link wins), as a derived table.
pub fn identities_latest(ctx: &PanelQueryContext, range: &ResolvedRange) -> QueryResult<String> {
    let mut conds = scope_conds(ctx, "")?;
    conds.extend(history_bounds(ctx, range, "ts"));
    let erased = erased_list(ctx)?;
    if !erased.is_empty() {
        let list = in_list(&erased)?;
        conds.push(format!("user_id NOT IN {list}"));
        conds.push(format!("anon_id NOT IN {}", in_list(&erased)?));
    }
    Ok(format!(
        "(SELECT anon_id, user_id FROM (SELECT anon_id, user_id, ROW_NUMBER() OVER (PARTITION BY anon_id ORDER BY ts ASC) AS rn \
         FROM {} WHERE {}) AS il WHERE rn = 1)",
        identities_table(),
        conds.join(" AND ")
    ))
}

/// `peopleLatest`: the current profile per user (highest version), not deleted.
pub fn people_latest(ctx: &PanelQueryContext, range: &ResolvedRange) -> QueryResult<String> {
    let mut conds = scope_conds(ctx, "")?;
    conds.extend(history_bounds(ctx, range, "ts"));
    let erased = erased_list(ctx)?;
    if !erased.is_empty() {
        conds.push(format!("user_id NOT IN {}", in_list(&erased)?));
    }
    Ok(format!(
        "(SELECT user_id, properties FROM (SELECT user_id, properties, deleted, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY version DESC) AS rn \
         FROM {} WHERE {}) AS pl WHERE rn = 1 AND deleted = false)",
        people_table(),
        conds.join(" AND ")
    ))
}

/// `knownGroupType`: a group type the project has (when the context lists
/// them), checked against the pattern.
pub fn known_group_type<'a>(ctx: &PanelQueryContext, value: &'a str) -> QueryResult<&'a str> {
    let checked = checked_group_type(value)?;
    if let Some(types) = &ctx.group_types
        && !types.iter().any(|t| t == checked)
    {
        return Err(PanelQueryError::new("That group type does not exist"));
    }
    Ok(checked)
}

/// `groupsLatest`: the current profile per group key of one type.
pub fn groups_latest(
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    group: &str,
) -> QueryResult<String> {
    let mut conds = scope_conds(ctx, "")?;
    conds.extend(history_bounds(ctx, range, "ts"));
    conds.push(format!(
        "group_type = {}",
        lit(known_group_type(ctx, group)?)?
    ));
    Ok(format!(
        "(SELECT group_key, properties FROM (SELECT group_key, properties, deleted, ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY version DESC) AS rn \
         FROM {} WHERE {}) AS gl WHERE rn = 1 AND deleted = false)",
        groups_table(),
        conds.join(" AND ")
    ))
}

/// `groupAlias`: `g_<type>`.
pub fn group_alias(group: &str) -> QueryResult<String> {
    Ok(format!("g_{}", checked_group_type(group)?))
}

/// `groupKeyExpr`: the event's group key of a type.
pub fn group_key_expr(group: &str) -> QueryResult<String> {
    let checked = checked_group_type(group)?;
    Ok(format!(
        "json_get_str(e.properties, {})",
        property_key(&group_key_property(checked))?
    ))
}

/// The scoped events read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventsScope {
    /// `panel.events_v1 e` plus its joins.
    pub from: String,
    /// The person: the identity's user id, else the event's distinct id.
    pub person: String,
    /// Every condition applied so far.
    pub conds: Vec<String>,
}

impl EventsScope {
    /// `WHERE` with the base conditions and `extra`.
    pub fn where_sql<S: AsRef<str>>(&self, extra: &[S]) -> String {
        let mut all: Vec<&str> = self.conds.iter().map(String::as_str).collect();
        all.extend(extra.iter().map(AsRef::as_ref));
        format!("WHERE {}", all.join(" AND "))
    }

    /// `WHERE` with the base conditions only.
    pub fn where_base(&self) -> String {
        self.where_sql::<&str>(&[])
    }
}

/// What a scope joins and filters on besides the base conditions.
#[derive(Debug, Clone, Copy, Default)]
pub struct ScopeOptions<'a> {
    pub filters: Option<&'a [PanelFilter]>,
    /// Join the person's profile.
    pub person_props: bool,
    /// Join the latest profile of these group types.
    pub group_types: &'a [String],
    /// Further conditions on `e`.
    pub extra_conds: &'a [String],
}

impl<'a> ScopeOptions<'a> {
    /// `{ filters, ...needs }`.
    pub fn with_needs(filters: Option<&'a [PanelFilter]>, needs: &'a ScopeNeeds) -> Self {
        Self {
            filters,
            person_props: needs.person_props,
            group_types: &needs.group_types,
            extra_conds: &[],
        }
    }
}

/// `personExpr`.
pub fn person_expr(ctx: &PanelQueryContext) -> &'static str {
    if ctx.has_identified_users {
        "COALESCE(i.user_id, e.distinct_id)"
    } else {
        "e.distinct_id"
    }
}

/// `eventsScope`: the scoped events read for `bounds`.
pub fn events_scope(
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    bounds: TimeBounds,
    options: ScopeOptions<'_>,
) -> QueryResult<EventsScope> {
    let person = person_expr(ctx);
    let own_filters: Vec<&[PanelFilter]> = options.filters.into_iter().collect();
    let own = scope_needs(
        ctx,
        &ScopeUse {
            filters: &own_filters,
            ..ScopeUse::default()
        },
    )?;
    let join_profiles = options.person_props || own.person_props;
    let mut group_types = js::distinct(
        options
            .group_types
            .iter()
            .chain(own.group_types.iter())
            .cloned(),
    );
    group_types.sort_by(|a, b| compare_text(a, b));

    let mut from = format!("{} e", events_table());
    if ctx.has_identified_users {
        let identities = identities_latest(ctx, range)?;
        from.push_str(&[" LEFT JOIN ", &identities, " i ON i.anon_id = e.anon_id"].concat());
    }
    if join_profiles {
        let people = people_latest(ctx, range)?;
        from.push_str(&[" LEFT JOIN ", &people, " pp ON pp.user_id = ", person].concat());
    }
    for group in &group_types {
        let alias = group_alias(group)?;
        let profiles = groups_latest(ctx, range, group)?;
        let key = group_key_expr(group)?;
        from.push_str(
            &[
                " LEFT JOIN ",
                &profiles,
                " ",
                &alias,
                " ON ",
                &alias,
                ".group_key = ",
                &key,
            ]
            .concat(),
        );
    }

    let mut conds = scope_conds(ctx, "e.")?;
    conds.push(format!("e.ts >= {}", ts(bounds.from)));
    conds.push(format!("e.ts < {}", ts(bounds.to)));
    let erased = erased_list(ctx)?;
    if !erased.is_empty() {
        let list = in_list(&erased)?;
        conds.push(format!("e.anon_id NOT IN {list}"));
        conds.push(format!("e.distinct_id NOT IN {list}"));
        conds.push(format!("COALESCE(e.user_id, '') NOT IN {list}"));
    }
    if let Some(filters) = options.filters.filter(|f| !f.is_empty()) {
        conds.extend(compile_filters(filters, ctx, range, person)?);
    }
    conds.extend(options.extra_conds.iter().cloned());

    Ok(EventsScope {
        from,
        person: person.to_owned(),
        conds,
    })
}

// ---------------------------------------------------------------------------
// What a scope has to join
// ---------------------------------------------------------------------------

/// Filters, event refs and breakdowns a scope is compiled against.
#[derive(Debug, Clone, Copy, Default)]
pub struct ScopeUse<'a> {
    pub filters: &'a [&'a [PanelFilter]],
    pub events: &'a [&'a str],
    pub breakdowns: &'a [Option<&'a PanelBreakdown>],
}

/// The joins a scope needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeNeeds {
    pub person_props: bool,
    pub group_types: Vec<String>,
}

/// `scopeNeeds`: the joins a scope needs for these filters, events and breakdowns.
pub fn scope_needs(ctx: &PanelQueryContext, used: &ScopeUse<'_>) -> QueryResult<ScopeNeeds> {
    let mut person_props = false;
    let mut group_types: Vec<String> = Vec::new();
    let add_group = |group: &str, groups: &mut Vec<String>| {
        if !groups.iter().any(|g| g == group) {
            groups.push(group.to_owned());
        }
    };
    let from_filters = |filters: &[PanelFilter], person: &mut bool, groups: &mut Vec<String>| {
        for f in filters {
            match f {
                PanelFilter::Person { .. } => *person = true,
                PanelFilter::Group { group_type, .. } => add_group(group_type, groups),
                _ => {}
            }
        }
    };
    for list in used.filters {
        from_filters(list, &mut person_props, &mut group_types);
    }
    for reference in used.events {
        if !is_custom_event_ref(reference) {
            continue;
        }
        for m in &custom_event(ctx, reference)?.match_ {
            from_filters(&m.filters, &mut person_props, &mut group_types);
        }
    }
    for b in used.breakdowns.iter().flatten() {
        match b {
            PanelBreakdown::Person { .. } => person_props = true,
            PanelBreakdown::Group { group_type, .. }
                if !group_types.iter().any(|g| g == group_type) =>
            {
                group_types.push(group_type.clone());
            }
            _ => {}
        }
    }
    group_types.sort_by(|a, b| compare_text(a, b));
    Ok(ScopeNeeds {
        person_props,
        group_types,
    })
}

// ---------------------------------------------------------------------------
// Events: names and custom events
// ---------------------------------------------------------------------------

fn custom_event<'a>(
    ctx: &'a PanelQueryContext,
    reference: &str,
) -> QueryResult<&'a CustomEventDefinition> {
    let id = ref_id_of(reference, RefKind::CustomEvent)?;
    let def = ctx
        .custom_events
        .as_ref()
        .and_then(|events| events.get(id))
        .ok_or_else(|| PanelQueryError::new("That custom event does not exist"))?;
    if def.match_.is_empty() {
        return Err(PanelQueryError::new("That custom event has no events"));
    }
    Ok(def)
}

/// `eventNamesOf`: the tracked event names an event ref stands for.
pub fn event_names_of(reference: &str, ctx: &PanelQueryContext) -> QueryResult<Vec<String>> {
    if !is_custom_event_ref(reference) {
        return Ok(vec![reference.to_owned()]);
    }
    Ok(js::distinct(
        custom_event(ctx, reference)?
            .match_
            .iter()
            .map(|m| m.event.clone()),
    ))
}

/// `namesCondition`: `e.name IN (…)` for every name the refs stand for.
pub fn names_condition<S: AsRef<str>>(refs: &[S], ctx: &PanelQueryContext) -> QueryResult<String> {
    let mut all = Vec::new();
    for reference in refs {
        all.extend(event_names_of(reference.as_ref(), ctx)?);
    }
    let names = js::distinct(all);
    for name in &names {
        event_name(name)?;
    }
    Ok(format!("e.name IN {}", in_list(&names)?))
}

/// `eventMatch`: SQL that is true for events matching `reference`.
pub fn event_match(
    reference: &str,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    person: &str,
) -> QueryResult<String> {
    if !is_custom_event_ref(reference) {
        return Ok(format!("e.name = {}", event_name(reference)?));
    }
    let mut parts = Vec::new();
    for m in &custom_event(ctx, reference)?.match_ {
        if m.filters
            .iter()
            .any(|f| matches!(f, PanelFilter::Cohort { .. }))
        {
            return Err(PanelQueryError::new("Custom events cannot use cohorts"));
        }
        let mut conds = vec![format!("e.name = {}", event_name(&m.event)?)];
        conds.extend(compile_filters(&m.filters, ctx, range, person)?);
        parts.push(format!("({})", conds.join(" AND ")));
    }
    Ok(format!("({})", parts.join(" OR ")))
}

/// `eventWithFilters`: an event ref and extra filters as one condition.
pub fn event_with_filters(
    reference: &str,
    filters: &[PanelFilter],
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    person: &str,
) -> QueryResult<String> {
    let mut parts = vec![event_match(reference, ctx, range, person)?];
    parts.extend(compile_filters(filters, ctx, range, person)?);
    Ok(parts.join(" AND "))
}

// ---------------------------------------------------------------------------
// Who is counted
// ---------------------------------------------------------------------------

/// What a measure counts and the conditions its events need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitExpr {
    pub expr: String,
    pub conds: Vec<String>,
}

/// `unitExpr`: people (the scope's person), or groups of one type.
pub fn unit_expr(
    ctx: &PanelQueryContext,
    scope: &EventsScope,
    aggregate_by: Option<&AggregateBy>,
) -> QueryResult<UnitExpr> {
    match aggregate_by {
        Some(AggregateBy::Group { group_type }) => {
            let key = group_key_expr(known_group_type(ctx, group_type)?)?;
            Ok(UnitExpr {
                conds: vec![format!("{key} IS NOT NULL")],
                expr: key,
            })
        }
        _ => Ok(UnitExpr {
            expr: scope.person.clone(),
            conds: Vec::new(),
        }),
    }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/// `columnExpr`: `e.<field>`.
pub fn column_expr(field: FilterColumn) -> String {
    format!("e.{field}")
}

/// A thing being compared, as SQL values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValueExprs {
    /// Text value.
    pub str: String,
    /// Numeric value (JSON properties only; a column is compared as text).
    pub num: Option<String>,
    pub bool: Option<String>,
    /// True when the thing exists.
    pub is_set: String,
}

fn json_exprs(column: &str, key: &str) -> QueryResult<ValueExprs> {
    let k = property_key(key)?;
    Ok(ValueExprs {
        str: format!("json_get_str({column}, {k})"),
        num: Some(format!("json_get_float({column}, {k})")),
        bool: Some(format!("json_get_bool({column}, {k})")),
        is_set: format!("json_contains({column}, {k})"),
    })
}

fn computed_exprs(reference: &str, ctx: &PanelQueryContext) -> QueryResult<ValueExprs> {
    let id = ref_id_of(reference, RefKind::ComputedProperty)?;
    let def = ctx
        .computed_properties
        .as_ref()
        .and_then(|defs| defs.get(id))
        .ok_or_else(|| PanelQueryError::new("That computed property does not exist"))?;
    match def {
        ComputedPropertyDefinition::Formula { expression } => {
            let parsed = parse_expression(
                expression,
                ParseExpressionOptions {
                    identifiers: ExpressionIdentifierKind::Properties,
                    series_count: None,
                },
            )
            .map_err(|err| {
                PanelQueryError::new(format!(
                    "A computed property's formula does not parse: {}",
                    err.message
                ))
            })?;
            let value = to_sql(&parsed.ast, &mut |key: &str| -> QueryResult<String> {
                Ok(format!(
                    "json_get_float(e.properties, {})",
                    property_key(key)?
                ))
            })?;
            Ok(ValueExprs {
                str: format!("CAST({value} AS VARCHAR)"),
                is_set: format!("{value} IS NOT NULL"),
                num: Some(value),
                bool: None,
            })
        }
        ComputedPropertyDefinition::Coalesce { keys } => {
            if keys.len() < 2 || keys.len() > 5 {
                return Err(PanelQueryError::new(
                    "A computed property takes 2 to 5 inputs",
                ));
            }
            let strs = keys
                .iter()
                .map(|k| match k {
                    ComputedPropertySource::Column { field } => {
                        Ok(format!("CAST({} AS VARCHAR)", column_expr(*field)))
                    }
                    ComputedPropertySource::Event { key } => Ok(format!(
                        "json_get_str(e.properties, {})",
                        property_key(key)?
                    )),
                })
                .collect::<QueryResult<Vec<_>>>()?;
            let mut floats = Vec::new();
            for k in keys {
                if let ComputedPropertySource::Event { key } = k {
                    floats.push(format!(
                        "json_get_float(e.properties, {})",
                        property_key(key)?
                    ));
                }
            }
            let nums =
                (floats.len() == keys.len()).then(|| format!("COALESCE({})", floats.join(", ")));
            let str = format!("COALESCE({})", strs.join(", "));
            Ok(ValueExprs {
                is_set: format!("{str} IS NOT NULL"),
                str,
                num: nums,
                bool: None,
            })
        }
    }
}

/// `eventPropertyExprs`: an event property (or computed property) as SQL values.
pub fn event_property_exprs(key: &str, ctx: &PanelQueryContext) -> QueryResult<ValueExprs> {
    if is_computed_property_ref(key) {
        computed_exprs(key, ctx)
    } else {
        json_exprs("e.properties", key)
    }
}

/// `eventPropertyNumber`: the numeric value of an event property.
pub fn event_property_number(key: &str, ctx: &PanelQueryContext) -> QueryResult<String> {
    event_property_exprs(key, ctx)?
        .num
        .ok_or_else(|| PanelQueryError::new("That property is not a number"))
}

/// `String(value)` of a scalar filter value.
fn scalar_text(value: &FilterValue) -> String {
    match value {
        FilterValue::Text(text) => text.clone(),
        FilterValue::Number(number) => js::number_text(*number),
        FilterValue::Bool(flag) => flag.to_string(),
        FilterValue::List(items) => items
            .iter()
            .map(|item| match item {
                FilterListItem::Text(text) => text.clone(),
                FilterListItem::Number(number) => js::number_text(*number),
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

fn in_comparison(value: &FilterValue, ex: &ValueExprs) -> QueryResult<String> {
    let FilterValue::List(items) = value else {
        return Err(PanelQueryError::new("Use a list of values"));
    };
    if items.is_empty() {
        return Err(PanelQueryError::new("Use a list of values"));
    }
    if let Some(num_expr) = &ex.num {
        let numbers: Option<Vec<f64>> = items
            .iter()
            .map(|item| match item {
                FilterListItem::Number(n) => Some(*n),
                FilterListItem::Text(_) => None,
            })
            .collect();
        if let Some(numbers) = numbers {
            let written = numbers
                .into_iter()
                .map(num)
                .collect::<QueryResult<Vec<_>>>()?;
            return Ok(format!("{num_expr} IN ({})", written.join(", ")));
        }
    }
    let texts: Vec<String> = items
        .iter()
        .map(|item| match item {
            FilterListItem::Text(text) => text.clone(),
            FilterListItem::Number(number) => js::number_text(*number),
        })
        .collect();
    Ok(format!("{} IN {}", ex.str, in_list(&texts)?))
}

fn contains_comparison(
    operator: FilterOperator,
    value: &FilterValue,
    ex: &ValueExprs,
) -> QueryResult<String> {
    let matches = format!(
        "LOWER({}) LIKE {}{LIKE_ESCAPE}",
        ex.str,
        like_contains(&scalar_text(value))?
    );
    Ok(if operator == FilterOperator::Contains {
        matches
    } else {
        format!("({} IS NULL OR NOT ({matches}))", ex.str)
    })
}

fn order_comparison(
    operator: FilterOperator,
    value: &FilterValue,
    ex: &ValueExprs,
) -> QueryResult<String> {
    let sign = if operator == FilterOperator::Gt {
        ">"
    } else {
        "<"
    };
    match (value, &ex.num) {
        (FilterValue::Number(n), Some(num_expr)) => Ok(format!("{num_expr} {sign} {}", num(*n)?)),
        (FilterValue::Bool(_), _) => Err(PanelQueryError::new("Use a number or text")),
        _ => Ok(format!("{} {sign} {}", ex.str, lit(&scalar_text(value))?)),
    }
}

fn comparison(
    operator: FilterOperator,
    value: Option<&FilterValue>,
    ex: &ValueExprs,
) -> QueryResult<String> {
    match operator {
        FilterOperator::IsSet => return Ok(ex.is_set.clone()),
        FilterOperator::IsNotSet => return Ok(format!("NOT {}", ex.is_set)),
        _ => {}
    }
    let Some(value) = value else {
        return Err(PanelQueryError::new("A filter needs a value"));
    };
    if operator == FilterOperator::In {
        return in_comparison(value, ex);
    }
    if matches!(value, FilterValue::List(_)) {
        return Err(PanelQueryError::new("Only `in` takes a list"));
    }
    if matches!(
        operator,
        FilterOperator::Contains | FilterOperator::NotContains
    ) {
        return contains_comparison(operator, value, ex);
    }
    if matches!(operator, FilterOperator::Gt | FilterOperator::Lt) {
        return order_comparison(operator, value, ex);
    }
    // eq / neq
    let equal = match (value, &ex.num, &ex.bool) {
        (FilterValue::Number(n), Some(num_expr), _) => format!("{num_expr} = {}", num(*n)?),
        (FilterValue::Bool(flag), _, Some(bool_expr)) => format!("{bool_expr} = {flag}"),
        _ => format!("{} = {}", ex.str, lit(&scalar_text(value))?),
    };
    Ok(if operator == FilterOperator::Eq {
        equal
    } else {
        format!("({} IS NULL OR NOT ({equal}))", ex.str)
    })
}

/// One non-cohort filter as a SQL condition.
fn filter_condition(filter: &PanelFilter, ctx: &PanelQueryContext) -> QueryResult<String> {
    match filter {
        PanelFilter::Column {
            field,
            operator,
            value,
        } => {
            let col = column_expr(*field);
            if *operator == FilterOperator::IsNotSet {
                return Ok(format!("{col} IS NULL"));
            }
            let ex = ValueExprs {
                is_set: format!("{col} IS NOT NULL"),
                str: col,
                num: None,
                bool: None,
            };
            comparison(*operator, value.as_ref(), &ex)
        }
        PanelFilter::Event {
            key,
            operator,
            value,
        } => {
            let exprs = event_property_exprs(key, ctx)?;
            comparison(*operator, value.as_ref(), &exprs)
        }
        PanelFilter::Person {
            key,
            operator,
            value,
        } => {
            let exprs = json_exprs("pp.properties", key)?;
            comparison(*operator, value.as_ref(), &exprs)
        }
        PanelFilter::Group {
            group_type,
            key,
            operator,
            value,
        } => {
            let properties = format!(
                "{}.properties",
                group_alias(known_group_type(ctx, group_type)?)?
            );
            let exprs = json_exprs(&properties, key)?;
            if *operator == FilterOperator::IsNotSet {
                return Ok(format!("({properties} IS NULL OR NOT {})", exprs.is_set));
            }
            comparison(*operator, value.as_ref(), &exprs)
        }
        PanelFilter::GroupKey {
            group_type,
            operator,
            value,
        } => {
            known_group_type(ctx, group_type)?;
            let exprs = json_exprs("e.properties", &group_key_property(group_type))?;
            comparison(*operator, value.as_ref(), &exprs)
        }
        PanelFilter::Cohort { .. } => Err(PanelQueryError::new("Unknown filter")),
    }
}

/// `compileFilters`: the conditions for a list of filters, joined with
/// `AND` by the caller. Cohort filters become person subqueries.
pub fn compile_filters(
    filters: &[PanelFilter],
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    person: &str,
) -> QueryResult<Vec<String>> {
    filters
        .iter()
        .map(|filter| match filter {
            PanelFilter::Cohort { cohort_id, negate } => {
                let cohort = ctx
                    .cohorts
                    .as_ref()
                    .and_then(|cohorts| cohorts.get(cohort_id))
                    .ok_or_else(|| PanelQueryError::new("That cohort does not exist"))?;
                let member = cohort_membership(cohort, ctx, range, person)?;
                Ok(if negate == &Some(true) {
                    format!("NOT ({member})")
                } else {
                    format!("({member})")
                })
            }
            other => Ok(format!("({})", filter_condition(other, ctx)?)),
        })
        .collect()
}

/// `cohortMembership`: SQL true for people in the cohort, over `person`.
pub fn cohort_membership(
    cohort: &CohortFilter,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    person: &str,
) -> QueryResult<String> {
    let joiner = if cohort.match_ == CohortMatch::Any {
        " OR "
    } else {
        " AND "
    };
    let mut parts = Vec::new();
    for condition in &cohort.conditions {
        match condition {
            CohortCondition::PersonProperty {
                key,
                operator,
                value,
            } => {
                let exprs = json_exprs("pl2.properties", key)?;
                let cond = comparison(*operator, value.as_ref(), &exprs)?;
                parts.push(format!(
                    "{person} IN (SELECT pl2.user_id FROM {} AS pl2 WHERE {cond})",
                    people_latest(ctx, range)?
                ));
            }
            CohortCondition::Performed {
                event,
                filters,
                within_days,
                min_count,
                negate,
            } => {
                if filters
                    .iter()
                    .any(|f| matches!(f, PanelFilter::Cohort { .. }))
                {
                    return Err(PanelQueryError::new("Cohorts cannot contain cohorts"));
                }
                let now = query_now(ctx);
                let bounds = TimeBounds {
                    from: (now - within_days * DAY_MS).max(range.floor),
                    to: now,
                };
                let inner = events_scope(
                    ctx,
                    range,
                    bounds,
                    ScopeOptions {
                        filters: Some(filters),
                        ..ScopeOptions::default()
                    },
                )?;
                let inner_where = inner.where_sql(&[format!("e.name = {}", event_name(event)?)]);
                let subquery = format!(
                    "SELECT {person_inner} FROM {from} {inner_where} GROUP BY {person_inner} HAVING COUNT(*) >= {count}",
                    person_inner = inner.person,
                    from = inner.from,
                    count = int(*min_count, 100_000)?
                );
                let op = if *negate { "NOT IN" } else { "IN" };
                parts.push(format!("{person} {op} ({subquery})"));
            }
        }
    }
    Ok(parts.join(joiner))
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

/// The value of a breakdown when the property is missing.
pub const NONE_LABEL: &str = "(none)";
/// Where values outside the top N go.
pub const OTHER_LABEL: &str = "Other";

/// How a breakdown's value is written.
#[derive(Debug, Clone, Copy, Default)]
pub struct BreakdownExprOptions<'a> {
    /// Apply the path rules to a `path` column breakdown.
    pub clean_paths: Option<bool>,
    /// Numeric bucket edges (low to high) for a bucketed breakdown.
    pub edges: Option<&'a [f64]>,
}

/// `breakdownNumberExpr`: the numeric value of a breakdown's property.
pub fn breakdown_number_expr(
    breakdown: &PanelBreakdown,
    ctx: &PanelQueryContext,
) -> QueryResult<String> {
    match breakdown {
        PanelBreakdown::Event { key, .. } => event_property_number(key, ctx),
        PanelBreakdown::Person { key, .. } => Ok(format!(
            "json_get_float(pp.properties, {})",
            property_key(key)?
        )),
        PanelBreakdown::Group {
            group_type, key, ..
        } => Ok(format!(
            "json_get_float({}.properties, {})",
            group_alias(known_group_type(ctx, group_type)?)?,
            property_key(key)?
        )),
        PanelBreakdown::Column { .. } => Err(PanelQueryError::new(
            "Only property breakdowns can be put in buckets",
        )),
    }
}

/// `formatEdge`: the short label of a bucket edge.
pub fn format_edge(value: f64) -> String {
    js::number_text(js::to_precision(value, 10))
}

/// `bucketLabelsFor`: `< a`, `a – b`, …, `≥ z`.
pub fn bucket_labels_for(edges: &[f64]) -> Vec<String> {
    let mut labels = vec![format!("< {}", format_edge(edges[0]))];
    for pair in edges.windows(2) {
        labels.push(format!(
            "{} – {}",
            format_edge(pair[0]),
            format_edge(pair[1])
        ));
    }
    labels.push(format!("≥ {}", format_edge(edges[edges.len() - 1])));
    labels
}

/// `bucketCaseSql`: `CASE` putting a number into its bucket label.
pub fn bucket_case_sql(value: &str, edges: &[f64]) -> QueryResult<String> {
    if edges.is_empty() || edges.len() > 19 {
        return Err(PanelQueryError::new("Use 1 to 19 bucket edges"));
    }
    let labels = bucket_labels_for(edges);
    let whens = edges
        .iter()
        .zip(&labels)
        .map(|(edge, label)| {
            Ok(format!(
                "WHEN {value} < {} THEN {}",
                num(*edge)?,
                lit(label)?
            ))
        })
        .collect::<QueryResult<Vec<_>>>()?;
    Ok(format!(
        "CASE WHEN {value} IS NULL THEN {} {} ELSE {} END",
        lit(NONE_LABEL)?,
        whens.join(" "),
        lit(&labels[labels.len() - 1])?
    ))
}

/// `breakdownExpr`: the SQL text value of a breakdown, `(none)` when missing.
pub fn breakdown_expr(
    breakdown: &PanelBreakdown,
    ctx: &PanelQueryContext,
    options: BreakdownExprOptions<'_>,
) -> QueryResult<String> {
    if let PanelBreakdown::Column { field, .. } = breakdown {
        let column = column_expr(*field);
        let value = if *field == FilterColumn::Path {
            cleaned_path_sql(ctx, options.clean_paths, &column)?
        } else {
            column
        };
        return Ok(format!(
            "COALESCE(CAST({value} AS VARCHAR), {})",
            lit(NONE_LABEL)?
        ));
    }
    if let (Some(edges), Some(_)) = (options.edges, breakdown.bucket()) {
        return bucket_case_sql(&breakdown_number_expr(breakdown, ctx)?, edges);
    }
    Ok(format!(
        "COALESCE({}, {})",
        property_breakdown_text(breakdown, ctx)?,
        lit(NONE_LABEL)?
    ))
}

/// The text value of an event, person or group property breakdown.
fn property_breakdown_text(
    breakdown: &PanelBreakdown,
    ctx: &PanelQueryContext,
) -> QueryResult<String> {
    match breakdown {
        PanelBreakdown::Event { key, .. } => {
            if is_computed_property_ref(key) {
                Ok(event_property_exprs(key, ctx)?.str)
            } else {
                Ok(format!(
                    "json_get_str(e.properties, {})",
                    property_key(key)?
                ))
            }
        }
        PanelBreakdown::Group {
            group_type, key, ..
        } => Ok(format!(
            "json_get_str({}.properties, {})",
            group_alias(known_group_type(ctx, group_type)?)?,
            property_key(key)?
        )),
        PanelBreakdown::Person { key, .. } => Ok(format!(
            "json_get_str(pp.properties, {})",
            property_key(key)?
        )),
        PanelBreakdown::Column { .. } => Err(PanelQueryError::new("Unknown breakdown")),
    }
}

/// `limitedExpr`: `expr` with every value outside `values` folded into `Other`.
pub fn limited_expr(expr: &str, values: &[String]) -> QueryResult<String> {
    if values.is_empty() {
        return lit(OTHER_LABEL);
    }
    Ok(format!(
        "CASE WHEN {expr} IN {} THEN {expr} ELSE {} END",
        in_list(values)?,
        lit(OTHER_LABEL)?
    ))
}
