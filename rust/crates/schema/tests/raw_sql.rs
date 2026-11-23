//! The raw-SQL ratchet (ADR DATA-019, plan phase 4). `rust/clippy.toml`
//! disallows `sqlx::query`, `query_as`, `query_scalar` and their `_with`
//! forms: queries go through the SeaORM entities of this crate. A crate that
//! still writes SQL allows that at its root and is listed here; the list only
//! shrinks:
//!
//! - a crate drops the root `allow` when it is converted, and leaves the list;
//! - a new crate starts on the ORM, so it never joins it;
//! - SQL that stays on purpose takes `#[allow(clippy::disallowed_methods,
//!   reason = "…")]` on its function, and the reason is required.
//!
//! Tests, examples and benches aren't covered: their fixtures may write SQL.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// SQL by nature: the migration runner, the lakehouse catalog, and the MTA's
/// queue store (its own database and embedded migrations, no entities).
const SQL_BY_NATURE: &[&str] = &["crates/lakehouse", "crates/migrations", "crates/mta"];

/// Not converted yet. Remove a crate when its root `allow` goes; never add one.
const NOT_CONVERTED: &[&str] = &[
    "bins/weldsuite",
    "crates/ads-domain",
    "crates/ai",
    "crates/books-domain",
    "crates/chat-domain",
    "crates/connect-domain",
    "crates/crm-domain",
    "crates/db",
    "crates/mail-inbound",
    "crates/reach-domain",
    "crates/social-domain",
    "crates/staff-domain",
    "crates/subscribers",
    "modules/core-files",
    "modules/docs",
    "modules/mcp",
    "modules/sheets",
];

fn rust_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `crates/<name>`, `modules/<name>` and `bins/<name>`.
fn crate_dirs() -> Vec<String> {
    let mut dirs = Vec::new();
    for group in ["crates", "modules", "bins"] {
        for entry in std::fs::read_dir(rust_dir().join(group)).unwrap() {
            let entry = entry.unwrap();
            if entry.path().join("Cargo.toml").is_file() {
                dirs.push(format!("{group}/{}", entry.file_name().to_string_lossy()));
            }
        }
    }
    dirs.sort();
    dirs
}

/// Every `.rs` file under `dir`.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// The `#[allow(…)]` / `#![allow(…)]` attributes in `text` that name
/// `clippy::disallowed_methods`, as (inner, attribute text).
fn disallowed_methods_allows(text: &str) -> Vec<(bool, String)> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("allow(") {
        let before = &rest[..start];
        let inner = before.ends_with("#![");
        let tail = &rest[start..];
        if !inner && !before.ends_with("#[") {
            rest = &tail["allow(".len()..];
            continue;
        }
        let end = tail.find(")]").map_or(tail.len(), |end| end + 2);
        let body = &tail[..end];
        if body.contains("clippy::disallowed_methods") {
            found.push((inner, body.to_owned()));
        }
        rest = &tail[end..];
    }
    found
}

#[test]
fn only_listed_crates_allow_raw_sql_at_their_root() {
    let listed: BTreeSet<&str> = NOT_CONVERTED.iter().chain(SQL_BY_NATURE).copied().collect();
    let mut allowing = BTreeSet::new();
    for dir in crate_dirs() {
        for root in ["src/lib.rs", "src/main.rs"] {
            let Ok(text) = std::fs::read_to_string(rust_dir().join(&dir).join(root)) else {
                continue;
            };
            if disallowed_methods_allows(&text)
                .iter()
                .any(|(inner, _)| *inner)
            {
                allowing.insert(dir.clone());
            }
        }
    }
    let new: Vec<_> = allowing
        .iter()
        .filter(|dir| !listed.contains(dir.as_str()))
        .collect();
    assert!(
        new.is_empty(),
        "{new:?} allow raw SQL at the crate root, but aren't on the list in this test. \
         New code queries through the SeaORM entities (ADR DATA-019): use \
         weldsuite_db::orm / OrmConn, or allow one function with a reason."
    );
    let converted: Vec<_> = NOT_CONVERTED
        .iter()
        .filter(|dir| !allowing.contains(**dir))
        .collect();
    assert!(
        converted.is_empty(),
        "{converted:?} no longer allow raw SQL at the root: remove them from NOT_CONVERTED"
    );
}

#[test]
fn every_other_raw_sql_allow_gives_its_reason() {
    let mut missing = Vec::new();
    for dir in crate_dirs() {
        let mut files = Vec::new();
        rust_files(&rust_dir().join(&dir).join("src"), &mut files);
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            for (inner, attribute) in disallowed_methods_allows(&text) {
                if !attribute.contains("reason") {
                    missing.push(format!(
                        "{} ({})",
                        file.strip_prefix(rust_dir()).unwrap_or(&file).display(),
                        if inner { "crate or module" } else { "item" }
                    ));
                }
            }
        }
    }
    assert!(
        missing.is_empty(),
        "#[allow(clippy::disallowed_methods)] without `reason = \"…\"`: say why this SQL \
         stays SQL (ADR DATA-019):\n{}",
        missing.join("\n")
    );
}
