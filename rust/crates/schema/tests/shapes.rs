//! Spike S7 of the ORM plan (`rust/docs/spikes.md`): for every table, the
//! rows Drizzle returned (recorded by `scripts/rust-schema-shapes.ts`) against
//! the same rows read through the generated entities and serialized.
//!
//! Needs the `all-tables` feature, `WELDSUITE_TEST_MASTER_URL` and
//! `WELDSUITE_TEST_TENANT_URL` (the databases the script filled) and
//! `SPIKE_DRIZZLE_ROWS` (its output); skipped otherwise.
//!
//! ```text
//! cargo test -p weldsuite-schema --features all-tables --test shapes -- --nocapture
//! ```

#![cfg(feature = "all-tables")]
#![allow(clippy::unwrap_used, clippy::too_many_lines)]

use std::collections::BTreeMap;

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_db::orm;

fn canonical(row: &Value) -> Value {
    match row {
        // `bigint` columns: the script writes Drizzle's BigInt as `bigint:<n>`.
        Value::String(text) => match text.strip_prefix("bigint:") {
            Some(n) => Value::String(n.to_owned()),
            None => row.clone(),
        },
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        // `0` and `0.0` are one value to a JSON client: compare numbers by value.
        Value::Number(n) => n.as_f64().map_or_else(|| row.clone(), Value::from),
        other => other.clone(),
    }
}

#[tokio::test]
async fn entity_rows_match_drizzle_rows() {
    let (Ok(master), Ok(tenant), Ok(file)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
        std::env::var("SPIKE_DRIZZLE_ROWS"),
    ) else {
        eprintln!("database URLs or SPIKE_DRIZZLE_ROWS not set; skipping");
        return;
    };
    let recorded: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let master = orm(&PgPool::connect(&master).await.unwrap());
    let tenant = orm(&PgPool::connect(&tenant).await.unwrap());

    let mut tables = 0;
    let mut matching = 0;
    // (kind of difference) → tables.column examples
    let mut differences: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut failures = Vec::new();
    for kind in ["tenant", "master"] {
        let Some(Value::Object(by_table)) = recorded.get(kind) else {
            continue;
        };
        for (table, drizzle_rows) in by_table {
            tables += 1;
            let rows = if kind == "tenant" {
                weldsuite_schema::tenant::rows_json(&tenant, table).await
            } else {
                weldsuite_schema::master::rows_json(&master, table).await
            };
            let rows = match rows {
                Ok(Some(rows)) => rows,
                Ok(None) => {
                    failures.push(format!("{kind}.{table}: no entity"));
                    continue;
                }
                Err(error) => {
                    failures.push(format!("{kind}.{table}: {error}"));
                    continue;
                }
            };
            let Value::Array(drizzle_rows) = drizzle_rows else {
                continue;
            };
            let rows: Vec<Value> = rows.iter().map(canonical).collect();
            let mut table_matches = rows.len() == drizzle_rows.len();
            for drizzle in drizzle_rows {
                let drizzle = canonical(drizzle);
                // Pair rows by `id`, or else by the most equal values (the two
                // inserts differ in every column they can).
                let ours = match drizzle.get("id") {
                    Some(id) => rows.iter().find(|row| row.get("id") == Some(id)),
                    None => rows.iter().max_by_key(|row| match (row, &drizzle) {
                        (Value::Object(a), Value::Object(b)) => {
                            a.iter().filter(|(k, v)| b.get(*k) == Some(*v)).count()
                        }
                        _ => 0,
                    }),
                };
                let Some(ours) = ours else {
                    table_matches = false;
                    failures.push(format!("{kind}.{table}: row not found by id"));
                    continue;
                };
                if *ours == drizzle {
                    continue;
                }
                table_matches = false;
                let (Value::Object(a), Value::Object(b)) = (&drizzle, ours) else {
                    continue;
                };
                for (key, expected) in a {
                    let got = b.get(key);
                    if got == Some(expected) {
                        continue;
                    }
                    let shape = |v: Option<&Value>| match v {
                        None => "missing".to_owned(),
                        Some(Value::Null) => "null".to_owned(),
                        Some(Value::String(s)) => format!("string {s:?}"),
                        Some(Value::Number(n)) => format!("number {n}"),
                        Some(Value::Bool(_)) => "bool".to_owned(),
                        Some(Value::Array(_)) => "array".to_owned(),
                        Some(Value::Object(_)) => "object".to_owned(),
                    };
                    let class =
                        format!("drizzle {} / entity {}", shape(Some(expected)), shape(got));
                    differences
                        .entry(class)
                        .or_default()
                        .push(format!("{kind}.{table}.{key}"));
                }
                for key in b.keys() {
                    if !a.contains_key(key) {
                        differences
                            .entry("only in the entity".to_owned())
                            .or_default()
                            .push(format!("{kind}.{table}.{key}"));
                    }
                }
            }
            if table_matches {
                matching += 1;
            } else {
                println!(
                    "not identical: {kind}.{table} ({} entity rows, {} Drizzle rows)",
                    rows.len(),
                    drizzle_rows.len()
                );
            }
        }
    }
    println!("tables compared: {tables}, identical: {matching}");
    for (class, places) in &differences {
        let mut places = places.clone();
        places.sort();
        places.dedup();
        println!(
            "{} × {class}: {}",
            places.len(),
            places
                .iter()
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    for failure in &failures {
        println!("failure: {failure}");
    }
    assert!(
        differences.is_empty() && failures.is_empty(),
        "see the output above"
    );
}
