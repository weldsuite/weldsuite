//! DataFusion constructs the compiler uses, on the fixture. Each case runs
//! on its own; the test fails listing every case that failed and why.

use arrow_array::RecordBatch;
use datafusion::arrow::util::display::{ArrayFormatter, FormatOptions};

use super::fixture::test_lake;

/// The rows as text, `|`-separated, for comparing.
pub(crate) fn render(batches: &[RecordBatch]) -> Vec<String> {
    let options = FormatOptions::default().with_null("NULL");
    let mut rows = Vec::new();
    for batch in batches {
        let formatters: Vec<ArrayFormatter<'_>> = batch
            .columns()
            .iter()
            .map(|column| ArrayFormatter::try_new(column.as_ref(), &options).expect("a formatter"))
            .collect();
        for row in 0..batch.num_rows() {
            rows.push(
                formatters
                    .iter()
                    .map(|formatter| formatter.value(row).to_string())
                    .collect::<Vec<_>>()
                    .join("|"),
            );
        }
    }
    rows
}

/// `(construct, SQL, expected rows)`.
const CASES: &[(&str, &str, &[&str])] = &[
    (
        "date_trunc trend with COUNT(DISTINCT), TIMESTAMP literals",
        "SELECT date_trunc('day', e.ts) AS bucket, COUNT(DISTINCT e.distinct_id) AS users, COUNT(*) AS n \
         FROM panel.events_v1 e WHERE e.workspace_id = 'ws_1' AND e.project_id = 'pnp_1' AND e.name = '$pageview' \
         AND e.ts >= TIMESTAMP '2026-11-01 00:00:00' AND e.ts < TIMESTAMP '2026-11-03 00:00:00' GROUP BY 1 ORDER BY 1",
        &["2026-11-01T00:00:00Z|4|8", "2026-11-02T00:00:00Z|4|8"],
    ),
    (
        "json_get_str",
        "SELECT json_get_str(e.properties, 'plan') AS plan, COUNT(*) FROM panel.events_v1 e \
         WHERE e.workspace_id = 'ws_1' AND e.name IN ('$pageview', 'signup') GROUP BY 1 ORDER BY 1",
        &["free|18", "pro|18"],
    ),
    (
        "json_get_float, json_contains",
        "SELECT SUM(json_get_float(e.properties, 'amount')), COUNT(*) FILTER (WHERE json_contains(e.properties, '$group_company')) \
         FROM panel.events_v1 e WHERE e.workspace_id = 'ws_1' AND e.name = 'signup'",
        &["594.0|12"],
    ),
    (
        "ROW_NUMBER() OVER (PARTITION BY …) latest-row subquery",
        "SELECT user_id, json_get_str(properties, 'plan') AS plan FROM (SELECT user_id, properties, deleted, \
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY version DESC) AS rn FROM panel.people_v1 \
         WHERE workspace_id = 'ws_1' AND project_id = 'pnp_1') latest WHERE rn = 1 AND NOT deleted ORDER BY user_id",
        &["u-1|pro", "u-2|pro", "u-3|pro"],
    ),
    (
        "approx_percentile_cont(expr, p)",
        "SELECT approx_percentile_cont(json_get_float(e.properties, '$lcp'), 0.5) FROM panel.events_v1 e \
         WHERE e.workspace_id = 'ws_1' AND e.name = '$webvitals'",
        &["1375.0"],
    ),
    (
        "FIRST_VALUE(x ORDER BY y) as an aggregate",
        "SELECT e.anon_id, FIRST_VALUE(e.path ORDER BY e.ts ASC, e.event_id ASC) AS entry, \
         FIRST_VALUE(e.path ORDER BY e.ts DESC, e.event_id DESC) AS exit FROM panel.events_v1 e \
         WHERE e.workspace_id = 'ws_1' AND e.session_id = 's-1-0' GROUP BY e.anon_id",
        &["a-1|/|/checkout"],
    ),
    (
        "to_unixtime",
        "SELECT to_unixtime(MAX(ts)) - to_unixtime(MIN(ts)) AS secs FROM panel.events_v1 \
         WHERE workspace_id = 'ws_1' AND session_id = 's-1-0'",
        &["305"],
    ),
    (
        "regexp_replace(…, 'g')",
        "SELECT DISTINCT regexp_replace(path, '[a-z]+', 'x', 'g') FROM panel.events_v1 \
         WHERE workspace_id = 'ws_1' AND path = '/pricing'",
        &["/x"],
    ),
    (
        "LIKE … ESCAPE '!'",
        "SELECT (SELECT COUNT(*) FROM panel.events_v1 WHERE workspace_id = 'ws_1' AND LOWER(path) LIKE '%!_%' ESCAPE '!') AS underscores, \
         (SELECT COUNT(*) FROM panel.events_v1 WHERE workspace_id = 'ws_1' AND LOWER(path) LIKE '%pric%' ESCAPE '!') AS pricing, \
         (SELECT COUNT(*) FROM panel.events_v1 WHERE workspace_id = 'ws_1' AND path LIKE ('%' || chr(92) || '!%') ESCAPE '!') AS backslash",
        &["0|36|0"],
    ),
    (
        "chr(92)",
        "SELECT 'CORP' || chr(92) || 'jdoe', length('a' || chr(92) || 'b')",
        &["CORP\\jdoe|3"],
    ),
    (
        "TIMESTAMP literal, INTERVAL '120 minutes' arithmetic",
        "SELECT COUNT(*) FROM panel.events_v1 WHERE workspace_id = 'ws_1' \
         AND ts + INTERVAL '120 minutes' >= TIMESTAMP '2026-11-03 12:00:00' \
         AND ts < TIMESTAMP '2026-11-01 00:00:00' + INTERVAL '3 days'",
        &["24"],
    ),
    (
        "date_trunc after an offset, FLOOR of to_unixtime differences (retention buckets)",
        "SELECT FLOOR((to_unixtime(date_trunc('day', MAX(ts) + INTERVAL '60 minutes')) - \
         to_unixtime(date_trunc('day', MIN(ts) + INTERVAL '60 minutes'))) / 86400) FROM panel.events_v1 WHERE workspace_id = 'ws_1'",
        &["2.0"],
    ),
    (
        "LEAD / LAG",
        "SELECT name, LEAD(name) OVER (PARTITION BY session_id ORDER BY ts, event_id) AS next, \
         LAG(name) OVER (PARTITION BY session_id ORDER BY ts, event_id) AS prev FROM panel.events_v1 \
         WHERE workspace_id = 'ws_1' AND session_id = 's-1-0' ORDER BY ts LIMIT 2",
        &[
            "$pageview|$pageview|NULL",
            "$pageview|$autocapture|$pageview",
        ],
    ),
    (
        "joins across the five tables",
        "SELECT COUNT(DISTINCT COALESCE(i.user_id, e.distinct_id)), COUNT(DISTINCT g.group_key), COUNT(DISTINCT r.session_id) \
         FROM panel.events_v1 e \
         LEFT JOIN (SELECT anon_id, user_id FROM (SELECT anon_id, user_id, ROW_NUMBER() OVER (PARTITION BY anon_id ORDER BY ts ASC) AS rn \
           FROM panel.identities_v1 WHERE workspace_id = 'ws_1') x WHERE rn = 1) i ON i.anon_id = e.anon_id \
         LEFT JOIN panel.groups_v1 g ON g.workspace_id = e.workspace_id AND g.group_key = json_get_str(e.properties, '$group_company') \
         LEFT JOIN panel.replay_chunks_v1 r ON r.workspace_id = e.workspace_id AND r.session_id = e.session_id \
         WHERE e.workspace_id = 'ws_1'",
        &["4|1|12"],
    ),
    (
        "CAST(… AS VARCHAR), COALESCE, CASE, CROSS JOIN",
        "WITH k AS (SELECT 'country' AS prop UNION ALL SELECT 'browser') \
         SELECT k.prop, COALESCE(CAST(CASE WHEN k.prop = 'country' THEN e.country ELSE e.browser END AS VARCHAR), '(none)') AS v, COUNT(*) \
         FROM panel.events_v1 e CROSS JOIN k WHERE e.workspace_id = 'ws_1' GROUP BY 1, 2 ORDER BY 1, 2",
        &["browser|Chrome|72", "country|DE|36", "country|NL|36"],
    ),
];

#[tokio::test]
async fn the_compilers_constructs_run_on_datafusion() {
    let lake = test_lake!();
    lake.seed().await;
    let engine = lake.engine();
    let mut failures = Vec::new();
    for (construct, sql, expected) in CASES {
        match engine.query(sql).await {
            Ok(result) => {
                let rows = render(&result.batches);
                if rows != *expected {
                    failures.push(format!("{construct}: got {rows:?}, want {expected:?}"));
                }
            }
            Err(error) => failures.push(format!("{construct}: {error}")),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} failed:\n{}",
        failures.len(),
        CASES.len(),
        failures.join("\n")
    );
}

/// Cohort filters (`<person> IN (SELECT …)`) DataFusion 54 runs and can't
/// (see `corpus.rs`'s `KNOWN_GAPS`). When the failing one runs, the
/// compiler's SQL works as it is.
#[tokio::test]
async fn datafusion_54_and_in_subqueries() {
    let lake = test_lake!();
    lake.seed().await;
    let engine = lake.engine();
    let person = "COALESCE(i.user_id, e.distinct_id)";
    let from = "FROM panel.events_v1 e LEFT JOIN panel.identities_v1 i ON i.anon_id = e.anon_id";
    // Fine: IN-subqueries in a filter, alone or under OR.
    for sql in [
        format!("SELECT COUNT(*) {from} WHERE {person} IN (SELECT user_id FROM panel.people_v1)"),
        format!(
            "SELECT COUNT(*) {from} WHERE {person} IN (SELECT user_id FROM panel.people_v1) \
             OR {person} IN (SELECT user_id FROM panel.identities_v1)"
        ),
    ] {
        engine
            .query(&sql)
            .await
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }
    // An IN-subquery in an aggregate's argument isn't decorrelated.
    let in_aggregate = format!(
        "SELECT COUNT(DISTINCT CASE WHEN {person} IN (SELECT user_id FROM panel.people_v1) THEN {person} END) {from}"
    );
    let error = engine
        .query(&in_aggregate)
        .await
        .expect_err("a DataFusion 54 gap");
    assert!(error.to_string().contains("InSubquery"), "{error}");
    // The other gap ("Projections require unique expression names" in
    // decorrelate_predicate_subquery) needs the corpus's whole cohort
    // statements; no smaller form reproduces it.
}

#[tokio::test]
async fn queries_are_read_only_and_limited() {
    let lake = test_lake!();
    lake.seed().await;
    let engine = lake.engine();
    for statement in [
        "CREATE TABLE x AS SELECT 1",
        "INSERT INTO panel.events_v1 SELECT * FROM panel.events_v1",
        "SET datafusion.execution.batch_size = 1",
    ] {
        assert!(engine.query(statement).await.is_err(), "{statement} ran");
    }

    // A memory pool too small for a big hash aggregate fails the query,
    // not the process.
    let tight = crate::QueryEngine::new(
        lake.lake.catalog_arc(),
        crate::QueryLimits {
            memory_bytes: 64 * 1024,
            ..crate::QueryLimits::default()
        },
    );
    // A hash join's build side can't spill.
    let pairs =
        "SELECT a.event_id || b.event_id AS k FROM panel.events_v1 a CROSS JOIN panel.events_v1 b";
    let heavy = format!("SELECT COUNT(*) FROM ({pairs}) x JOIN ({pairs}) y ON x.k = y.k");
    let error = tight.query(&heavy).await.expect_err("out of memory");
    assert!(error.to_string().contains("esources exhausted"), "{error}");

    // A timeout stops a slow query.
    let hasty = crate::QueryEngine::new(
        lake.lake.catalog_arc(),
        crate::QueryLimits {
            timeout: std::time::Duration::from_millis(1),
            ..crate::QueryLimits::default()
        },
    );
    let error = hasty.query(&heavy).await.expect_err("too slow");
    assert!(matches!(error, crate::LakehouseError::Timeout), "{error}");
}
