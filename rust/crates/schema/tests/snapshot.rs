//! The entities and their DDL build exactly the newest drizzle-kit snapshot
//! of each database, `id` and `prevId` aside (ADR DATA-019, phase 1 of the
//! plan): the entities hold the whole schema, so the snapshot built from
//! them can replace drizzle-kit's as the state migrations are diffed against.
//!
//! Fails when the Drizzle schema has a migration the entities don't follow
//! yet (`pnpm rust:schema`), or when the builder drops something.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};

use serde_json::Value;

/// The newest `meta/<n>_snapshot.json` of a migrations folder, without the
/// journal ids.
fn newest_snapshot(folder: &str) -> (PathBuf, Value) {
    let meta = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/core/db/drizzle")
        .join(folder)
        .join("meta");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&meta)
        .expect("the migrations' meta folder")
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with("_snapshot.json"))
        })
        .collect();
    files.sort();
    let file = files.pop().expect("a snapshot");
    let mut snapshot: Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    if let Value::Object(map) = &mut snapshot {
        map.remove("id");
        map.remove("prevId");
    }
    (file, snapshot)
}

/// Every place where `actual` differs from `expected`, as `path: expected / actual`.
fn differences(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                let at = format!("{path}.{key}");
                match b.get(key) {
                    Some(other) => differences(&at, value, other, out),
                    None => out.push(format!("{at}: {value} / missing")),
                }
            }
            for (key, value) in b {
                if !a.contains_key(key) {
                    out.push(format!("{path}.{key}: missing / {value}"));
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                differences(&format!("{path}[{i}]"), x, y, out);
            }
        }
        _ if expected == actual => {}
        _ => out.push(format!("{path}: {expected} / {actual}")),
    }
}

fn check(folder: &str, built: &Value) {
    let (file, expected) = newest_snapshot(folder);
    let mut found = Vec::new();
    differences("", &expected, built, &mut found);
    assert!(
        found.is_empty(),
        "the snapshot built from the entities differs from {} in {} place(s) \
         (expected / built; run `pnpm rust:schema` after a migration):\n{}",
        file.display(),
        found.len(),
        found
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_tenant_entities_build_the_newest_tenant_snapshot() {
    check("tenant-migrations", &weldsuite_schema::tenant::snapshot());
}

#[test]
fn the_master_entities_build_the_newest_master_snapshot() {
    check("master-migrations", &weldsuite_schema::master::snapshot());
}
