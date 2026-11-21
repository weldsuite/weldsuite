//! The WeldPanel query layer (`query/index.ts`, ADR PANEL-003): typed spec
//! in, SQL out, typed result back. [`run_panel_query`] is what the route
//! calls; the builders and [`scope::events_scope`] are public for the tests
//! and for routes that read raw events (activity feeds, timelines, the
//! lexicon, exports).
//!
//! The workspace and project come from the authenticated
//! [`PanelQueryContext`], never from the spec; see [`scope`] for where they,
//! the time bound, the erased ids and the identity join are applied.

pub mod activity;
pub mod breakdowns;
pub mod cache_key;
pub mod context;
pub mod correlation;
pub mod explain;
pub mod export;
pub mod flows;
pub mod funnel;
pub mod heatmap;
pub mod impact;
pub mod lifecycle;
pub mod paths;
pub mod permissions;
pub mod plan_retention;
pub mod refs;
pub mod result_range;
pub mod retention;
pub mod rows;
pub mod scope;
pub mod sessions;
pub mod signal;
pub mod sql;
pub mod stickiness;
pub mod time;
pub mod trends;
pub mod vitals;
pub mod web;

pub use cache_key::{spec_cache_key, stable_stringify};
pub use context::{BASIN_NAMESPACE, MAX_RETENTION_DAYS, PanelQueryContext};
pub use rows::{
    EngineError, PanelError, PanelSqlExecutor, PanelSqlQuery, PanelSqlResult, QUERY_CONCURRENCY,
    Row, RunStats, Runner, normalize_rows,
};
pub use sql::PanelQueryError;

use crate::schemas::{PanelQueryResult, PanelQuerySpec};

/// What a run gives besides the result.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelQueryOutput {
    pub result: PanelQueryResult,
    pub stats: RunStats,
}

/// `runPanelQuery`: compiles and runs a parsed spec. A spec the compiler
/// refuses is [`PanelError::Query`]; an engine failure [`PanelError::Engine`].
pub async fn run_panel_query<E: PanelSqlExecutor + ?Sized>(
    spec: &PanelQuerySpec,
    ctx: &PanelQueryContext,
    executor: &E,
) -> Result<PanelQueryOutput, PanelError> {
    if spec.project_id() != ctx.project_id {
        return Err(PanelQueryError::new(
            "The query names a different project than the one it runs for",
        )
        .into());
    }
    let runner = Runner::new(executor);
    let result = match spec {
        PanelQuerySpec::Web(s) => PanelQueryResult::Web(web::run_web(s, ctx, &runner).await?),
        PanelQuerySpec::Trends(s) => {
            PanelQueryResult::Trends(trends::run_trends(s, ctx, &runner).await?)
        }
        PanelQuerySpec::Funnel(s) => {
            PanelQueryResult::Funnel(funnel::run_funnel(s, ctx, &runner).await?)
        }
        PanelQuerySpec::Retention(s) => {
            PanelQueryResult::Retention(retention::run_retention(s, ctx, &runner).await?)
        }
        PanelQuerySpec::Flows(s) => {
            PanelQueryResult::Flows(flows::run_flows(s, ctx, &runner).await?)
        }
        PanelQuerySpec::Sessions(s) => {
            PanelQueryResult::Sessions(sessions::run_sessions(s, ctx, &runner).await?)
        }
        PanelQuerySpec::Heatmap(s) => {
            PanelQueryResult::Heatmap(heatmap::run_heatmap(s, ctx, &runner).await?)
        }
        PanelQuerySpec::FunnelCorrelation(s) => PanelQueryResult::FunnelCorrelation(
            correlation::run_funnel_correlation(s, ctx, &runner).await?,
        ),
        PanelQuerySpec::Stickiness(s) => {
            PanelQueryResult::Stickiness(stickiness::run_stickiness(s, ctx, &runner).await?)
        }
        PanelQuerySpec::Lifecycle(s) => {
            PanelQueryResult::Lifecycle(lifecycle::run_lifecycle(s, ctx, &runner).await?)
        }
        PanelQuerySpec::Vitals(s) => {
            PanelQueryResult::Vitals(vitals::run_vitals(s, ctx, &runner).await?)
        }
        PanelQuerySpec::Impact(s) => {
            PanelQueryResult::Impact(impact::run_impact(s, ctx, &runner).await?)
        }
        PanelQuerySpec::Signal(s) => {
            PanelQueryResult::Signal(signal::run_signal(s, ctx, &runner).await?)
        }
    };
    Ok(PanelQueryOutput {
        result,
        stats: runner.stats(),
    })
}
