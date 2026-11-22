//! The Rust differ writes what drizzle-kit wrote (ADR DATA-019, plan phase
//! 3): for every pair of consecutive master and tenant snapshots git still
//! has, drizzle-kit 0.30's statements are a golden in `tests/differ/`
//! (`scripts/rust-differ-fixtures.ts`), with both snapshots cut down to what
//! changed, and `diff` must return exactly those statements, in that order.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use weldsuite_schema::diff::{Ambiguity, diff_with};
use weldsuite_schema::drizzle::Snapshot;

#[derive(Deserialize)]
struct Fixture {
    database: String,
    n: u32,
    prev: Snapshot,
    next: Snapshot,
    statements: Vec<String>,
}

fn fixtures() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("differ");
    let mut files = Vec::new();
    for database in ["tenant", "master"] {
        for entry in std::fs::read_dir(root.join(database)).expect("tests/differ/<database>") {
            let path = entry.unwrap().path();
            if path.to_string_lossy().ends_with(".json.gz") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn read(path: &Path) -> Fixture {
    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
        .read_to_string(&mut text)
        .unwrap();
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The first statement where two lists part, for the failure message.
fn first_difference(expected: &[String], actual: &[String]) -> String {
    let at = expected
        .iter()
        .zip(actual)
        .position(|(a, b)| a != b)
        .unwrap_or(expected.len().min(actual.len()));
    format!(
        "statement {at} of {} / {}:\n  drizzle-kit: {}\n  rust:        {}",
        expected.len(),
        actual.len(),
        expected.get(at).map_or("(none)", String::as_str),
        actual.get(at).map_or("(none)", String::as_str),
    )
}

#[test]
fn the_differ_writes_what_drizzle_kit_wrote_for_every_migration_in_history() {
    let files = fixtures();
    assert!(
        files.len() > 200,
        "the goldens are missing: {}",
        files.len()
    );
    let mut failures = Vec::new();
    for path in &files {
        let fixture = read(path);
        // drizzle-kit asked whether a table or column that disappeared while
        // another appeared was renamed; history answered no every time.
        match diff_with(&fixture.prev, &fixture.next, Ambiguity::DropAndCreate) {
            Ok(statements) if statements == fixture.statements => {}
            Ok(statements) => failures.push(format!(
                "{} {}: {}",
                fixture.database,
                fixture.n,
                first_difference(&fixture.statements, &statements)
            )),
            Err(error) => failures.push(format!("{} {}: {error}", fixture.database, fixture.n)),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} migrations differ from drizzle-kit's:\n{}",
        failures.len(),
        files.len(),
        failures
            .iter()
            .take(15)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
