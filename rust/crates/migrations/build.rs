//! Embeds the journaled migrations in the crate: one table per database, in
//! the order of its `meta/_journal.json`, each entry's SQL pulled in with
//! `include_str!`. The master and tenant migrations live in `rust/migrations`,
//! generated from the entities in `weldsuite-schema` (`pnpm db:generate`, ADR
//! DATA-019); the personal database's are still Drizzle's
//! (`packages/core/db/drizzle/personal-migrations`) until personal-api goes.
//!
//! The image builds from the repository root and copies `rust/` to its
//! working directory, so `rust/migrations` sits next to the crates there too;
//! the Dockerfile copies the personal migrations' SQL and journal and points
//! `WELDSUITE_PERSONAL_MIGRATIONS_DIR` at them.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=WELDSUITE_PERSONAL_MIGRATIONS_DIR");
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let migrations = manifest.join("../../migrations");
    let personal = env::var_os("WELDSUITE_PERSONAL_MIGRATIONS_DIR").map_or_else(
        || manifest.join("../../../packages/core/db/drizzle/personal-migrations"),
        PathBuf::from,
    );
    let folders = [
        ("MASTER", migrations.join("master")),
        ("TENANT", migrations.join("tenant")),
        ("PERSONAL", personal),
    ];

    let mut out = String::new();
    for (name, dir) in folders {
        let journal_path = dir.join("meta").join("_journal.json");
        println!("cargo:rerun-if-changed={}", journal_path.display());
        let text = fs::read_to_string(&journal_path).unwrap_or_else(|error| {
            panic!(
                "cannot read {}: {error}. The migrations are embedded in the \
                 binary: build from the repository (the image: docker build \
                 -f rust/Dockerfile . from its root)",
                journal_path.display()
            )
        });
        let journal: serde_json::Value = serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("{}: {error}", journal_path.display()));
        let entries = journal["entries"]
            .as_array()
            .unwrap_or_else(|| panic!("{}: no entries", journal_path.display()));

        writeln!(out, "pub(crate) static {name}: &[RawEntry] = &[").expect("write");
        for entry in entries {
            let tag = entry["tag"]
                .as_str()
                .unwrap_or_else(|| panic!("{}: an entry without a tag", journal_path.display()));
            let when = entry["when"]
                .as_i64()
                .unwrap_or_else(|| panic!("{}: {tag} has no `when`", journal_path.display()));
            let sql_path = dir.join(format!("{tag}.sql"));
            println!("cargo:rerun-if-changed={}", sql_path.display());
            assert!(
                sql_path.is_file(),
                "{}: the journal names {tag}, but {} is missing",
                journal_path.display(),
                sql_path.display()
            );
            let path = sql_path
                .to_str()
                .unwrap_or_else(|| panic!("{} is not UTF-8", sql_path.display()));
            writeln!(
                out,
                "    RawEntry {{ tag: {tag:?}, when: {when}, sql: include_str!({path:?}) }},"
            )
            .expect("write");
        }
        writeln!(out, "];").expect("write");
    }

    let target = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("journals.rs");
    fs::write(&target, out).unwrap_or_else(|error| panic!("{}: {error}", target.display()));
}
