//! Querying: DataFusion over the five tables, registered as schema `panel`
//! (so SQL says `panel.events_v1`), with `datafusion-functions-json`
//! (`json_get_str`, …), read-only SQL, and per-query limits: a memory pool,
//! a timeout, and a cap on queries running at once in the process.
//!
//! The tables' metadata is loaded at most every `metadata_ttl` and shared by
//! the queries in between (a static snapshot each), so a report doesn't cost
//! a catalog round trip per table.

use std::sync::Arc;
use std::time::{Duration, Instant};

use arrow_array::RecordBatch;
use datafusion::catalog::{MemorySchemaProvider, SchemaProvider};
use datafusion::execution::runtime_env::RuntimeEnvBuilder;
use datafusion::execution::session_state::SessionStateBuilder;
use datafusion::prelude::{SQLOptions, SessionConfig, SessionContext};
use iceberg::Catalog;
use iceberg_datafusion::IcebergStaticTableProvider;
use tokio::sync::{Mutex, Semaphore};

use crate::error::{LakehouseError, Result};
use crate::in_subquery::InSubqueryMarks;
use crate::like_escape::LikeEscapeToBackslash;
use crate::tables::{NAMESPACE, PanelTable};

/// Limits on queries.
#[derive(Debug, Clone)]
pub struct QueryLimits {
    /// Memory one query may hold (hash tables, sorts, aggregates); past it
    /// the query fails (or spills, where DataFusion can).
    pub memory_bytes: usize,
    /// How long one query may run.
    pub timeout: Duration,
    /// Queries running at once in this process.
    pub concurrent: usize,
    /// DataFusion's parallelism per query.
    pub target_partitions: usize,
    /// How long loaded table metadata is reused.
    pub metadata_ttl: Duration,
}

impl Default for QueryLimits {
    fn default() -> Self {
        Self {
            memory_bytes: 256 * 1024 * 1024,
            timeout: Duration::from_secs(30),
            concurrent: 4,
            target_partitions: 4,
            metadata_ttl: Duration::from_secs(5),
        }
    }
}

/// What a query returned.
#[derive(Debug, Clone)]
pub struct QueryResult {
    /// The result's column names, in order.
    pub columns: Vec<String>,
    /// The rows.
    pub batches: Vec<RecordBatch>,
}

/// Runs WeldPanel's SQL.
pub struct QueryEngine {
    catalog: Arc<dyn Catalog>,
    limits: QueryLimits,
    running: Semaphore,
    tables: Mutex<Option<(Instant, Arc<dyn SchemaProvider>)>>,
}

impl std::fmt::Debug for QueryEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueryEngine")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl QueryEngine {
    /// An engine over the catalog's `panel` tables.
    pub fn new(catalog: Arc<dyn Catalog>, limits: QueryLimits) -> Self {
        Self {
            running: Semaphore::new(limits.concurrent.max(1)),
            catalog,
            limits,
            tables: Mutex::new(None),
        }
    }

    /// Forgets the loaded metadata (tests, after a commit).
    pub async fn refresh(&self) {
        *self.tables.lock().await = None;
    }

    /// The `panel` schema: each table at its current snapshot, reused for
    /// `metadata_ttl`.
    async fn tables(&self) -> Result<Arc<dyn SchemaProvider>> {
        let mut cached = self.tables.lock().await;
        if let Some((loaded, tables)) = cached.as_ref()
            && loaded.elapsed() < self.limits.metadata_ttl
        {
            return Ok(tables.clone());
        }
        let schema = Arc::new(MemorySchemaProvider::new());
        for table in PanelTable::ALL {
            let loaded = self.catalog.load_table(&table.ident()).await?;
            let provider = IcebergStaticTableProvider::try_new_from_table(loaded).await?;
            schema.register_table(table.name().to_owned(), Arc::new(provider))?;
        }
        let schema: Arc<dyn SchemaProvider> = schema;
        *cached = Some((Instant::now(), schema.clone()));
        Ok(schema)
    }

    /// A session for one query: its own memory pool, the JSON functions and
    /// the `panel` schema.
    pub async fn session(&self) -> Result<SessionContext> {
        let mut config = SessionConfig::new()
            .with_target_partitions(self.limits.target_partitions.max(1))
            .with_information_schema(false);
        // DataFusion 54's leaf-expression pushdown (moving `json_get_*` calls
        // below joins as `__datafusion_extracted_N` columns) breaks plans with
        // joins: "optimize_projections failed … No field named e.path". Off.
        config
            .options_mut()
            .optimizer
            .enable_leaf_expression_pushdown = false;
        let runtime = RuntimeEnvBuilder::new()
            .with_memory_limit(self.limits.memory_bytes, 1.0)
            .build_arc()?;
        let state = SessionStateBuilder::new()
            .with_config(config)
            .with_runtime_env(runtime)
            .with_default_features()
            // The cohort filters' `IN (SELECT …)` where DataFusion 54 can't run it.
            .with_analyzer_rule(Arc::new(InSubqueryMarks))
            .with_optimizer_rule(Arc::new(LikeEscapeToBackslash))
            .build();
        let mut ctx = SessionContext::new_with_state(state);
        datafusion_functions_json::register_all(&mut ctx)?;
        let default_catalog = ctx
            .copied_config()
            .options()
            .catalog
            .default_catalog
            .clone();
        let catalog = ctx
            .catalog(&default_catalog)
            .ok_or_else(|| LakehouseError::Rows(format!("no default catalog {default_catalog}")))?;
        catalog.register_schema(NAMESPACE, self.tables().await?)?;
        Ok(ctx)
    }

    /// Plans and runs one read-only statement, within the limits.
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        let _permit = self
            .running
            .acquire()
            .await
            .map_err(|_| LakehouseError::Timeout)?;
        let ctx = self.session().await?;
        let options = SQLOptions::new()
            .with_allow_ddl(false)
            .with_allow_dml(false)
            .with_allow_statements(false);
        let run = async {
            let frame = ctx.sql_with_options(sql, options).await?;
            let columns = frame
                .schema()
                .fields()
                .iter()
                .map(|field| field.name().clone())
                .collect();
            let batches = frame.collect().await?;
            Ok::<_, LakehouseError>(QueryResult { columns, batches })
        };
        tokio::time::timeout(self.limits.timeout, run)
            .await
            .map_err(|_| LakehouseError::Timeout)?
    }
}
