//! WeldStash replenishment: demand forecasting and reorder suggestions per
//! product (or variant) and warehouse
//! (`weldsuite-documentation/plans/weldstash-replenishment.md`).
//!
//! - [`engine`]: the pure planner (one item in, its plan out);
//! - `demand`: its inputs, read from the tenant database;
//! - `run`: the nightly (and on demand) planning run, a job per run, and
//!   the due-index sweep that starts the nightly ones;
//! - `routes`, `plans`, `orders`, `imports`: `/api/replenishment`.

#[cfg(test)]
mod db_tests;
mod demand;
pub mod engine;
mod imports;
mod orders;
mod plans;
mod review;
mod routes;
mod run;
mod settings;

pub use routes::Services;
pub use run::{
    REPLENISHMENT_RUN_JOB, ReplenishmentRunJob, SWEEP_KIND, SweepTenants, TenantDatabases,
    next_run_at, run_replenishment_sweep,
};

pub(crate) use routes::routes;
