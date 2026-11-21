//! WeldPanel's analytics engine in the serve role (ADR EVT-019): the
//! compiler's SQL run by DataFusion over the install's Iceberg tables
//! (`weldsuite-lakehouse`), in the panel bucket from the panel store
//! config (`S3_BUCKET_PANEL`, `panel_store.rs`) with the catalog on the
//! master database. Rows come back as Basin SQL answers them on Global
//! (`weldsuite_lakehouse::json_rows`), so the report code reads them alike.
//!
//! An install without the panel store has no engine, and reports answer
//! 503 as panel-api does without its Basin settings. Conformance builds run
//! the test's Basin instead (`weldsuite_panel::BasinSql`).

use std::sync::Arc;

use tokio::sync::OnceCell;
use weldsuite_db::PgPool;
use weldsuite_lakehouse::{Lakehouse, LakehouseError, QueryEngine, QueryLimits};
use weldsuite_panel::AnalyticsSql;
use weldsuite_panel::engine::{EngineError, PanelSqlQuery, PanelSqlResult};
use weldsuite_ports::BoxFuture;

use crate::panel_store::PanelStoreConfig;

/// DataFusion over the panel store.
pub(crate) struct LakehouseSql {
    lake: Lakehouse,
    engine: QueryEngine,
    /// The tables exist (made on the first query of a new install, as the
    /// writer and the maintenance job make them).
    tables: OnceCell<()>,
}

impl LakehouseSql {
    pub(crate) fn new(lake: Lakehouse, limits: QueryLimits) -> Self {
        Self {
            engine: QueryEngine::new(lake.catalog_arc(), limits),
            lake,
            tables: OnceCell::new(),
        }
    }

    async fn rows(&self, sql: &str) -> Result<PanelSqlResult, LakehouseError> {
        self.tables
            .get_or_try_init(|| self.lake.ensure_tables())
            .await?;
        let result = self.engine.query(sql).await?;
        Ok(PanelSqlResult {
            rows: result.json_rows()?,
            // DataFusion reports no scanned bytes per query.
            bytes_scanned: None,
        })
    }
}

impl AnalyticsSql for LakehouseSql {
    fn execute(&self, query: PanelSqlQuery) -> BoxFuture<'_, Result<PanelSqlResult, EngineError>> {
        Box::pin(async move {
            self.rows(&query.sql).await.map_err(|error| {
                tracing::warn!(name = %query.name, %error, "panel: a statement failed");
                Box::new(error) as EngineError
            })
        })
    }
}

/// The serve role's engine: on the panel store when the install has one.
/// Must be called inside the runtime.
pub(crate) fn engine(
    config: Option<&PanelStoreConfig>,
    master: &PgPool,
) -> Result<Option<Arc<dyn AnalyticsSql>>, LakehouseError> {
    let Some(config) = config else {
        tracing::info!("S3_BUCKET_PANEL is not set: WeldPanel reports answer 503");
        return Ok(None);
    };
    let lake = config.lakehouse(master.clone())?;
    Ok(Some(
        Arc::new(LakehouseSql::new(lake, QueryLimits::default())) as Arc<dyn AnalyticsSql>,
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use weldsuite_lakehouse::PanelTable;

    use super::*;
    use crate::panel_test_support::{ScratchPanel, event};

    /// Rows read through the engine are Basin's JSON: numbers, text, ISO
    /// timestamps and nulls as the report code expects them.
    #[tokio::test]
    async fn answers_rows_as_basin_sql_does() {
        let Some(scratch) = ScratchPanel::new().await else {
            return;
        };
        let rows = [
            event(
                "ws_1",
                "pnp_1",
                "e-1",
                "a-1",
                "s-1",
                "2026-11-14T10:00:00.000Z",
            ),
            event(
                "ws_1",
                "pnp_1",
                "e-2",
                "a-1",
                "s-1",
                "2026-11-14T10:05:00.000Z",
            ),
        ];
        scratch
            .lake
            .append_rows(PanelTable::Events, &rows, None)
            .await
            .expect("an append");
        let sql = LakehouseSql::new(scratch.lake.clone(), QueryLimits::default());
        let result = sql
            .execute(PanelSqlQuery {
                name: "test".into(),
                sql: "SELECT e.session_id AS session_id, COUNT(*) AS n, MIN(e.ts) AS started, \
                      MAX(e.user_id) AS user_id FROM panel.events_v1 e \
                      WHERE e.workspace_id = 'ws_1' AND e.project_id = 'pnp_1' GROUP BY e.session_id"
                    .into(),
                columns: vec![
                    "session_id".into(),
                    "n".into(),
                    "started".into(),
                    "user_id".into(),
                ],
            })
            .await
            .expect("rows");
        assert_eq!(
            result.rows,
            [
                json!({ "session_id": "s-1", "n": 2, "started": "2026-11-14T10:00:00Z", "user_id": null })
            ]
        );
        assert_eq!(result.bytes_scanned, None);
        scratch.finish().await;
    }
}
