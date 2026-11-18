//! What a parsed spec refers to besides its own fields (`refs.ts`): saved
//! cohorts, custom events, computed properties, group types, and whether it
//! groups by path. panel-api loads only these into the context.

use serde::Serialize;

use super::sql::compare_text;
use crate::js;
use crate::schemas::{
    AggregateBy, CustomEventDefinition, FilterColumn, PanelBreakdown, PanelFilter, PanelQuerySpec,
    TrendMath, WebPanel, aggregate_group_type, spec_breakdowns,
};
use crate::wire::{is_computed_property_ref, is_custom_event_ref};

/// `SpecReferences`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecReferences {
    pub cohort_ids: Vec<String>,
    /// Row ids (`pnce_…`, without the `@`).
    pub custom_event_ids: Vec<String>,
    /// Row ids (`pncp_…`).
    pub computed_property_ids: Vec<String>,
    pub group_types: Vec<String>,
    /// The spec groups or shows pages by path and has not switched cleaning off.
    pub uses_path_rules: bool,
}

#[derive(Default)]
struct Collector {
    cohorts: Vec<String>,
    custom_events: Vec<String>,
    computed: Vec<String>,
    groups: Vec<String>,
}

fn add(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|v| v == value) {
        list.push(value.to_owned());
    }
}

impl Collector {
    fn event(&mut self, reference: Option<&str>) {
        if let Some(reference) = reference.filter(|r| is_custom_event_ref(r)) {
            add(&mut self.custom_events, &reference[1..]);
        }
    }

    fn property(&mut self, key: Option<&str>) {
        if let Some(key) = key.filter(|k| is_computed_property_ref(k)) {
            add(&mut self.computed, &key[1..]);
        }
    }

    fn filters(&mut self, filters: &[PanelFilter]) {
        for f in filters {
            match f {
                PanelFilter::Cohort { cohort_id, .. } => add(&mut self.cohorts, cohort_id),
                PanelFilter::Event { key, .. } => self.property(Some(key)),
                PanelFilter::Group { group_type, .. }
                | PanelFilter::GroupKey { group_type, .. } => {
                    add(&mut self.groups, group_type);
                }
                _ => {}
            }
        }
    }

    fn breakdowns(&mut self, breakdowns: &[Option<&PanelBreakdown>]) {
        for b in breakdowns.iter().flatten() {
            match b {
                PanelBreakdown::Event { key, .. } => self.property(Some(key)),
                PanelBreakdown::Group { group_type, .. } => add(&mut self.groups, group_type),
                _ => {}
            }
        }
    }

    /// Events with their own filters (steps, exclusions, goals, anchors).
    fn events_with_filters<'a>(
        &mut self,
        items: impl IntoIterator<Item = (Option<&'a str>, &'a [PanelFilter])>,
    ) {
        for (event, filters) in items {
            self.event(event);
            self.filters(filters);
        }
    }
}

fn path_breakdown(breakdowns: &[Option<&PanelBreakdown>]) -> bool {
    breakdowns.iter().flatten().any(|b| {
        matches!(
            b,
            PanelBreakdown::Column {
                field: FilterColumn::Path,
                ..
            }
        )
    })
}

/// `specReferences`: everything a spec refers to.
pub fn spec_references(spec: &PanelQuerySpec) -> SpecReferences {
    let mut c = Collector::default();
    let mut aggregate: Option<&AggregateBy> = None;
    let mut clean_paths: Option<bool> = None;
    let uses_paths = match spec {
        PanelQuerySpec::Web(s) => {
            c.filters(&s.base.filters);
            c.events_with_filters(
                s.goals
                    .iter()
                    .flatten()
                    .map(|g| (g.event.as_deref(), g.filters.as_slice())),
            );
            clean_paths = s.clean_paths;
            s.panels.as_ref().is_none_or(|panels| {
                panels.contains(&WebPanel::TopPages) || panels.contains(&WebPanel::EntryExitPages)
            })
        }
        PanelQuerySpec::Trends(s) => {
            c.filters(&s.base.filters);
            c.events_with_filters(
                s.series
                    .iter()
                    .map(|x| (Some(x.event.as_str()), x.filters.as_slice())),
            );
            for x in &s.series {
                c.property(x.property.as_deref());
                if x.math == TrendMath::UniqueGroups
                    && let Some(group) = x.group_type.as_deref().filter(|g| !g.is_empty())
                {
                    add(&mut c.groups, group);
                }
            }
            let breakdowns: Vec<_> = spec_breakdowns(s.breakdown.as_ref(), s.breakdowns.as_ref())
                .into_iter()
                .map(Some)
                .collect();
            c.breakdowns(&breakdowns);
            clean_paths = s.clean_paths;
            path_breakdown(&breakdowns)
        }
        PanelQuerySpec::Funnel(s)
        | PanelQuerySpec::FunnelCorrelation(crate::schemas::FunnelCorrelationSpec {
            funnel: s,
            ..
        }) => {
            c.filters(&s.base.filters);
            c.events_with_filters(
                s.steps
                    .iter()
                    .map(|x| (Some(x.event.as_str()), x.filters.as_slice()))
                    .chain(
                        s.exclusions
                            .iter()
                            .flatten()
                            .map(|x| (Some(x.event.as_str()), x.filters.as_slice())),
                    ),
            );
            let mut breakdowns: Vec<_> =
                spec_breakdowns(s.breakdown.as_ref(), s.breakdowns.as_ref())
                    .into_iter()
                    .map(Some)
                    .collect();
            breakdowns.push(s.hold_constant.as_ref());
            c.breakdowns(&breakdowns);
            aggregate = s.aggregate_by.as_ref();
            clean_paths = s.clean_paths;
            path_breakdown(&breakdowns)
        }
        PanelQuerySpec::Retention(s) => {
            c.filters(&s.base.filters);
            c.event(Some(&s.first_event));
            c.event(s.return_event.as_deref());
            c.breakdowns(&[s.breakdown.as_ref()]);
            aggregate = s.aggregate_by.as_ref();
            path_breakdown(&[s.breakdown.as_ref()])
        }
        PanelQuerySpec::Flows(s) => {
            c.filters(&s.base.filters);
            c.events_with_filters([(Some(s.anchor.event.as_str()), s.anchor.filters.as_slice())]);
            clean_paths = s.clean_paths;
            true
        }
        PanelQuerySpec::Sessions(s) => {
            if let Some(cohort) = s.cohort_id.as_deref().filter(|c| !c.is_empty()) {
                add(&mut c.cohorts, cohort);
            }
            for reference in s
                .did_events
                .iter()
                .flatten()
                .chain(s.not_did_events.iter().flatten())
            {
                c.event(Some(reference));
            }
            false
        }
        PanelQuerySpec::Heatmap(_) => false,
        PanelQuerySpec::Stickiness(s) => {
            c.filters(&s.base.filters);
            c.event(Some(&s.event));
            aggregate = s.aggregate_by.as_ref();
            false
        }
        PanelQuerySpec::Lifecycle(s) => {
            c.filters(&s.base.filters);
            c.event(Some(&s.event));
            aggregate = s.aggregate_by.as_ref();
            false
        }
        PanelQuerySpec::Vitals(s) => {
            c.filters(&s.base.filters);
            clean_paths = s.clean_paths;
            true
        }
        PanelQuerySpec::Impact(s) => {
            c.filters(&s.base.filters);
            c.event(Some(&s.launch_event));
            c.events_with_filters([(Some(s.metric.event.as_str()), s.metric.filters.as_slice())]);
            c.property(s.metric.property.as_deref());
            false
        }
        PanelQuerySpec::Signal(s) => {
            c.filters(&s.base.filters);
            c.events_with_filters([(Some(s.goal.event.as_str()), s.goal.filters.as_slice())]);
            for reference in s.candidates.iter().flatten() {
                c.event(Some(reference));
            }
            false
        }
    };
    if let Some(group) = aggregate_group_type(aggregate) {
        add(&mut c.groups, group);
    }
    let mut group_types = c.groups;
    group_types.sort_by(|a, b| compare_text(a, b));
    SpecReferences {
        cohort_ids: c.cohorts,
        custom_event_ids: c.custom_events,
        computed_property_ids: c.computed,
        group_types,
        uses_path_rules: uses_paths && clean_paths != Some(false),
    }
}

/// What loaded custom events refer to in turn.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomEventReferences {
    pub computed_property_ids: Vec<String>,
    pub group_types: Vec<String>,
}

/// `customEventReferences`: computed properties and group types in the
/// filters of loaded custom events.
pub fn custom_event_references(definitions: &[CustomEventDefinition]) -> CustomEventReferences {
    let mut c = Collector::default();
    for def in definitions {
        for m in &def.match_ {
            c.filters(&m.filters);
        }
    }
    let mut group_types = js::distinct(c.groups);
    group_types.sort_by(|a, b| compare_text(a, b));
    CustomEventReferences {
        computed_property_ids: c.computed,
        group_types,
    }
}
