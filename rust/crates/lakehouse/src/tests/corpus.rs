//! The compiler's SQL corpus (`packages/domains/panel/src/query/__corpus__/
//! sql-corpus.json`, written by the TypeScript compiler tests and panel-api's
//! routes): every statement is planned and run through the DataFusion
//! session over the seeded fixture, and its columns compared. The test fails
//! listing every statement that doesn't run, with the error. Without the file
//! it is skipped with a message (`PANEL_SQL_CORPUS` points elsewhere).

use std::path::PathBuf;

use serde_json::Value;

use super::fixture::test_lake;

fn corpus_path() -> PathBuf {
    std::env::var_os("PANEL_SQL_CORPUS").map_or_else(
        || {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/domains/panel/src/query/__corpus__/sql-corpus.json")
        },
        PathBuf::from,
    )
}

/// Statements DataFusion 54 can't run, and why: both are cohort filters
/// (`<person> IN (SELECT …)`). Each must still fail; one that runs is
/// taken off the list.
const KNOWN_GAPS: &[(&str, &str)] = &[
    (
        "panel-api:panel-api/people.ts/cohortPeople-any/people.cohort",
        DUPLICATE_NAME,
    ),
    (
        "compiler:query/sessions/cohort-any/sessions.list",
        DUPLICATE_NAME,
    ),
    (
        "compiler:query/trends/filters-cohort-any/trends.series",
        DUPLICATE_NAME,
    ),
    (
        "compiler:query/trends/filters-cohort-any/trends.totals",
        DUPLICATE_NAME,
    ),
    (
        "compiler:query/trends/filters-cohort-clamped-to-retention/trends.series",
        DUPLICATE_NAME,
    ),
    (
        "compiler:query/trends/filters-cohort-clamped-to-retention/trends.totals",
        DUPLICATE_NAME,
    ),
    (
        "compiler:query/trends/filters-cohort-negated/trends.series",
        DUPLICATE_NAME,
    ),
    (
        "compiler:query/trends/filters-cohort-negated/trends.totals",
        DUPLICATE_NAME,
    ),
    (
        "compiler:query/trends/filters-series/trends.series",
        SUBQUERY_IN_AGGREGATE,
    ),
    (
        "compiler:query/trends/filters-series/trends.totals",
        SUBQUERY_IN_AGGREGATE,
    ),
];

/// `x IN (SELECT …) OR x IN (SELECT …)` with the same non-column `x`
/// (`COALESCE(i.user_id, e.distinct_id)`): `decorrelate_predicate_subquery`
/// fails, "Projections require unique expression names".
const DUPLICATE_NAME: &str = "two IN-subqueries on one expression under OR";

/// `COUNT(DISTINCT CASE WHEN … x IN (SELECT …) … END)`: an IN-subquery in an
/// aggregate's argument isn't decorrelated, "Physical plan does not support
/// logical expression `InSubquery`".
const SUBQUERY_IN_AGGREGATE: &str = "IN-subquery inside an aggregate";

/// One statement of the corpus.
struct Statement {
    label: String,
    sql: String,
    columns: Vec<String>,
}

fn statements(corpus: &Value) -> Vec<Statement> {
    let mut out = Vec::new();
    for entry in corpus["entries"].as_array().into_iter().flatten() {
        let id = entry["id"].as_str().unwrap_or("?");
        let source = entry["source"].as_str().unwrap_or("?");
        for statement in entry["statements"].as_array().into_iter().flatten() {
            out.push(Statement {
                label: format!(
                    "{source}:{id}/{}",
                    statement["name"].as_str().unwrap_or("?")
                ),
                sql: statement["sql"].as_str().unwrap_or_default().to_owned(),
                columns: statement["columns"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|column| column.as_str().map(str::to_owned))
                    .collect(),
            });
        }
    }
    out
}

#[tokio::test]
async fn every_corpus_statement_runs_on_datafusion() {
    let path = corpus_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!(
            "skipped: no SQL corpus at {} (the TypeScript compiler tests write it)",
            path.display()
        );
        return;
    };
    let corpus: Value = serde_json::from_str(&text).expect("the corpus is JSON");
    assert_eq!(corpus["version"], 1, "corpus version");
    let mut statements = statements(&corpus);
    assert!(!statements.is_empty(), "the corpus has no statements");
    // `PANEL_SQL_CORPUS_FILTER=funnel` runs only the statements whose label has it.
    if let Ok(filter) = std::env::var("PANEL_SQL_CORPUS_FILTER") {
        statements.retain(|statement| statement.label.contains(&filter));
    }

    let lake = test_lake!();
    lake.seed().await;
    // The tables don't change: load their metadata once.
    let engine = crate::QueryEngine::new(
        lake.lake.catalog_arc(),
        crate::QueryLimits {
            metadata_ttl: std::time::Duration::from_secs(3600),
            ..crate::QueryLimits::default()
        },
    );
    let mut failures = Vec::new();
    let mut column_mismatches = Vec::new();
    let mut known = 0_usize;
    let mut with_rows = 0_usize;
    for statement in &statements {
        let gap = KNOWN_GAPS
            .iter()
            .find(|(label, _)| *label == statement.label);
        match engine.query(&statement.sql).await {
            Err(_) if gap.is_some() => known += 1,
            Ok(_) if gap.is_some() => failures.push(format!(
                "{}: runs now, take it off KNOWN_GAPS",
                statement.label
            )),
            Ok(result) => {
                if result.batches.iter().any(|batch| batch.num_rows() > 0) {
                    with_rows += 1;
                }
                if !statement.columns.is_empty() && result.columns != statement.columns {
                    column_mismatches.push(format!(
                        "{}: columns {:?}, want {:?}",
                        statement.label, result.columns, statement.columns
                    ));
                }
            }
            Err(error) => failures.push(format!(
                "{}: {}\n    {}",
                statement.label,
                error
                    .to_string()
                    .lines()
                    .take(6)
                    .collect::<Vec<_>>()
                    .join(" / "),
                statement.sql
            )),
        }
    }
    eprintln!(
        "corpus: {} statements, {} ran ({} returned rows), {} known gaps, {} failed, {} column mismatches",
        statements.len(),
        statements.len() - failures.len() - known,
        with_rows,
        known,
        failures.len(),
        column_mismatches.len()
    );
    for line in &column_mismatches {
        eprintln!("  {line}");
    }
    assert!(
        failures.is_empty() && column_mismatches.is_empty(),
        "{} of {} statements failed, {} column mismatches:\n{}\n{}",
        failures.len(),
        statements.len(),
        column_mismatches.len(),
        failures.join("\n"),
        column_mismatches.join("\n")
    );
}
