//! The analytics SQL engine the report routes run the compiler's statements
//! on (plan `weldpanel-eu.md`, "Querying"): the `AnalyticsSql` port and its
//! Basin SQL adapter.
//!
//! - Production (the Kubernetes editions): DataFusion over the install's
//!   Iceberg tables (`weldsuite-lakehouse`, ADR EVT-019), set on
//!   [`crate::PanelState::sql`] by the server when the panel store is
//!   configured (`S3_BUCKET_PANEL`). Without it queries answer 503, as
//!   panel-api does without its Basin settings.
//! - Conformance: [`BasinSql`], panel-api's Basin SQL REST client
//!   (`@weldsuite/worker-kit/basin`'s `basinSql`) built from the test's env
//!   (`R2_SQL_API_TOKEN`, `CF_ACCOUNT_ID`, `PANEL_BASIN_BUCKET`) and sent
//!   through the request's outbound HTTP (the harness's bridge), so the
//!   test's fake Basin answers the Rust server's SQL and both backends'
//!   calls are compared.
//!
//! Both answer rows as Basin SQL's REST API does (objects keyed by column),
//! so the compiler reads them alike.

use std::future::Future;
use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_panel_domain::query::PanelSqlExecutor;
pub use weldsuite_panel_domain::query::{EngineError, PanelSqlQuery, PanelSqlResult};
use weldsuite_ports::{BoxFuture, HttpRequest, OutboundHttp};

/// Runs one SQL statement of the compiler (read-only, already scoped to the
/// workspace and project by the compiler).
pub trait AnalyticsSql: Send + Sync {
    /// The rows (objects keyed by column, as Basin SQL answers) and the bytes
    /// scanned when the engine reports them. An error is the engine failing:
    /// the route answers 502.
    fn execute(&self, query: PanelSqlQuery) -> BoxFuture<'_, Result<PanelSqlResult, EngineError>>;
}

/// An engine as the compiler's executor.
pub(crate) struct Engine(pub(crate) Arc<dyn AnalyticsSql>);

impl PanelSqlExecutor for Engine {
    fn execute(
        &self,
        query: PanelSqlQuery,
    ) -> impl Future<Output = Result<PanelSqlResult, EngineError>> + Send {
        self.0.execute(query)
    }
}

/// Basin SQL over REST (Cloudflare's R2 SQL), as `basinSql` calls it.
pub struct BasinSql {
    http: OutboundHttp,
    token: String,
    account_id: String,
    bucket: String,
}

impl std::fmt::Debug for BasinSql {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BasinSql")
            .field("account_id", &self.account_id)
            .field("bucket", &self.bucket)
            .finish_non_exhaustive()
    }
}

impl BasinSql {
    pub fn new(http: OutboundHttp, token: String, account_id: String, bucket: String) -> Self {
        Self {
            http,
            token,
            account_id,
            bucket,
        }
    }

    /// `basinEndpoint(config)`.
    pub fn endpoint(&self) -> String {
        format!(
            "https://api.sql.cloudflarestorage.com/api/v1/accounts/{}/r2-sql/query/{}",
            self.account_id, self.bucket
        )
    }
}

impl AnalyticsSql for BasinSql {
    fn execute(&self, query: PanelSqlQuery) -> BoxFuture<'_, Result<PanelSqlResult, EngineError>> {
        Box::pin(async move {
            let request =
                HttpRequest::json("POST", self.endpoint(), &json!({ "query": query.sql }))
                    .header("authorization", format!("Bearer {}", self.token));
            let response = self
                .http
                .send(request)
                .await
                .map_err(|error| -> EngineError { Box::new(error) })?;
            let text = String::from_utf8_lossy(&response.body).into_owned();
            if !(200..300).contains(&response.status) {
                return Err(format!("R2 SQL API error {}: {text}", response.status).into());
            }
            let raw: Value =
                serde_json::from_str(&text).map_err(|error| -> EngineError { Box::new(error) })?;
            Ok(basin_result(&raw))
        })
    }
}

/// `{ result: { rows, metrics: { bytes_scanned } } }`: the rows (none when
/// absent) and the bytes scanned when it is a finite number.
fn basin_result(raw: &Value) -> PanelSqlResult {
    let result = &raw["result"];
    PanelSqlResult {
        rows: result["rows"].as_array().cloned().unwrap_or_default(),
        bytes_scanned: result["metrics"]["bytes_scanned"]
            .as_f64()
            .filter(|bytes| bytes.is_finite()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use weldsuite_ports::{DynOutboundHttp, HttpResponse, PortError};

    use super::*;

    /// A fake Basin: keeps what was sent, answers `status` and `body`.
    struct Fake {
        sent: Mutex<Vec<HttpRequest>>,
        status: u16,
        body: String,
    }

    impl DynOutboundHttp for Fake {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            self.sent.lock().expect("lock").push(request);
            Box::pin(std::future::ready(Ok(HttpResponse::new(
                self.status,
                self.body.clone().into_bytes(),
            ))))
        }
    }

    fn basin(status: u16, body: &str) -> (Arc<Fake>, BasinSql) {
        let fake = Arc::new(Fake {
            sent: Mutex::default(),
            status,
            body: body.to_owned(),
        });
        let sql = BasinSql::new(
            OutboundHttp(fake.clone()),
            "tok".into(),
            "acc".into(),
            "bucket".into(),
        );
        (fake, sql)
    }

    fn query() -> PanelSqlQuery {
        PanelSqlQuery {
            name: "web.totals".into(),
            sql: "SELECT 1 AS n".into(),
            columns: vec!["n".into()],
        }
    }

    #[tokio::test]
    async fn posts_the_sql_as_basin_sql_takes_it() {
        let (fake, sql) = basin(
            200,
            r#"{"result":{"rows":[{"n":1}],"metrics":{"bytes_scanned":2048}}}"#,
        );
        let result = sql.execute(query()).await.expect("rows");
        assert_eq!(result.rows, vec![json!({ "n": 1 })]);
        assert_eq!(result.bytes_scanned, Some(2048.0));
        let sent = fake.sent.lock().expect("lock");
        assert_eq!(sent[0].method, "POST");
        assert_eq!(
            sent[0].url,
            "https://api.sql.cloudflarestorage.com/api/v1/accounts/acc/r2-sql/query/bucket"
        );
        assert!(
            sent[0]
                .headers
                .contains(&("authorization".to_owned(), "Bearer tok".to_owned()))
        );
        let body: Value =
            serde_json::from_slice(sent[0].body.as_deref().expect("a body")).expect("json");
        assert_eq!(body, json!({ "query": "SELECT 1 AS n" }));
    }

    #[tokio::test]
    async fn fails_with_the_apis_message_and_reads_a_bare_answer() {
        let (_, sql) = basin(500, "boom");
        let error = sql.execute(query()).await.expect_err("a failure");
        assert_eq!(error.to_string(), "R2 SQL API error 500: boom");
        let (_, sql) = basin(200, r#"{"result":{"metrics":{"bytes_scanned":"x"}}}"#);
        let result = sql.execute(query()).await.expect("rows");
        assert_eq!(result.rows, Vec::<Value>::new());
        assert_eq!(result.bytes_scanned, None);
    }
}
