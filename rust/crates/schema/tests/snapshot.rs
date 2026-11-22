//! The guard between the entities and the migrations (ADR DATA-019): the
//! entities and their DDL build exactly the newest snapshot in
//! `rust/migrations/{tenant,master}/meta`, `id` and `prevId` aside, and every
//! migration file is journaled.
//!
//! The snapshot is the schema the last migration left. A difference means an
//! entity changed without a migration (`pnpm db:generate`), a migration was
//! written without the entity change, or the builder drops something.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// `rust/migrations/<folder>`.
fn migrations(folder: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../migrations")
        .join(folder)
}

/// The newest `meta/<n>_snapshot.json` of a migrations folder, without the
/// journal ids.
fn newest_snapshot(folder: &str) -> (PathBuf, Value) {
    let meta = migrations(folder).join("meta");
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

fn check_snapshot(folder: &str, built: &Value) {
    let (file, expected) = newest_snapshot(folder);
    let mut found = Vec::new();
    differences("", &expected, built, &mut found);
    assert!(
        found.is_empty(),
        "the snapshot built from the entities differs from {} in {} place(s) \
         (newest snapshot / entities). An entity changed without a migration: \
         run `pnpm db:generate` (tenant) or `pnpm db:generate:master`.\n{}",
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

/// `.sql` files from drizzle-kit's time that no journal lists, so no runner
/// ever applied them (DATA-006 records it). They stay, so the moved folders
/// are what drizzle-kit left; nothing may join them.
const NEVER_JOURNALED: &[&str] = &[
    // A hand-written `app_catalog` update that was never journaled.
    "0025_rename_weldtask_to_weldconnect",
];

/// The journal's tags and the folder's `.sql` files name the same migrations.
fn check_journal(folder: &str) {
    let dir = migrations(folder);
    let journal: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("meta").join("_journal.json")).unwrap(),
    )
    .unwrap();
    let tags: BTreeSet<String> = journal["entries"]
        .as_array()
        .expect("journal entries")
        .iter()
        .map(|entry| entry["tag"].as_str().expect("a tag").to_owned())
        .collect();
    let files: BTreeSet<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".sql").map(str::to_owned)
        })
        .filter(|tag| !NEVER_JOURNALED.contains(&tag.as_str()))
        .collect();
    let unjournaled: Vec<_> = files.difference(&tags).collect();
    let missing: Vec<_> = tags.difference(&files).collect();
    assert!(
        unjournaled.is_empty() && missing.is_empty(),
        "{}: .sql files the journal doesn't list: {unjournaled:?}; journal entries \
         without a file: {missing:?}. Migrations are written by `pnpm db:generate`, \
         never by hand.",
        dir.display()
    );
}

#[test]
fn the_tenant_entities_build_the_newest_tenant_snapshot() {
    check_snapshot("tenant", &weldsuite_schema::tenant::snapshot());
}

#[test]
fn the_master_entities_build_the_newest_master_snapshot() {
    check_snapshot("master", &weldsuite_schema::master::snapshot());
}

#[test]
fn every_tenant_migration_is_journaled() {
    check_journal("tenant");
}

#[test]
fn every_master_migration_is_journaled() {
    check_journal("master");
}
