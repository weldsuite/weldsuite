//! The migration generator behind `pnpm db:generate` (ADR DATA-019): the
//! newest journaled snapshot of `rust/migrations/<database>` against the one
//! the entities build, through [`crate::diff`], written in drizzle-kit's
//! layout: `NNNN_<name>.sql` with [`crate::diff::BREAKPOINT`] between
//! statements, `meta/NNNN_snapshot.json`, the `meta/_journal.json` entry, and
//! only the newest [`KEEP_SNAPSHOTS`] snapshots.
//!
//! It refuses what it would otherwise have to guess, and what breaks a
//! version running one migration behind (DATA-007, DATA-017):
//!
//! - anything that looks like a rename (a rename isn't additive; add,
//!   backfill and drop in steps, or write it as a `--custom` migration);
//! - dropping a table, column, enum or enum value, changing a column's type
//!   (a varchar getting longer aside), or `SET NOT NULL`, without
//!   `allow_drop`;
//! - `CONCURRENTLY`, which can't run in the migration's transaction.
//!
//! A `--custom` migration's SQL is left for a person to write, and its
//! snapshot is the entities': the SQL has to bring the database there.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::diff::{self, BREAKPOINT, DiffError};
use crate::drizzle::Snapshot;

/// How many snapshots a migrations folder keeps: the newest is the next
/// diff's "before"; a few more let the last migrations be taken back.
pub const KEEP_SNAPSHOTS: usize = 5;

/// What drizzle-kit writes into a `--custom` migration.
pub const CUSTOM_SQL: &str = "-- Custom SQL migration file, put your code below! --";

/// `meta/_journal.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journal {
    pub version: String,
    pub dialect: String,
    pub entries: Vec<JournalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub idx: u32,
    pub version: String,
    pub when: i64,
    pub tag: String,
    pub breakpoints: bool,
}

/// One run of the generator.
#[derive(Debug, Clone)]
pub struct Request {
    /// `rust/migrations/<database>`.
    pub dir: PathBuf,
    /// The snapshot the entities build.
    pub next: Snapshot,
    /// The migration's name: lower-case words joined by underscores.
    pub name: String,
    pub custom: bool,
    pub allow_drop: bool,
    /// The new snapshot's id.
    pub id: String,
    /// Milliseconds since the epoch, the journal's `when`.
    pub now: i64,
}

/// What a run did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The entities match the newest snapshot; nothing was written.
    NoChanges { snapshot: String },
    /// A migration was written.
    Written {
        sql: PathBuf,
        statements: usize,
        pruned: usize,
        /// Changes a `--custom` migration's SQL must make, or why it may be a rename.
        warnings: Vec<String>,
    },
}

/// Why nothing was written.
#[derive(Debug)]
pub enum GenerateError {
    BadName(String),
    Io(PathBuf, std::io::Error),
    Json(PathBuf, serde_json::Error),
    EmptyJournal(PathBuf),
    Ambiguous(Vec<String>),
    Destructive(Vec<String>),
    Concurrently(String),
    Unsupported(Vec<String>),
}

impl std::fmt::Display for GenerateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadName(name) => {
                write!(f, "--name {name:?}: lower-case words joined by underscores")
            }
            Self::Io(path, error) => write!(f, "{}: {error}", path.display()),
            Self::Json(path, error) => write!(f, "{}: {error}", path.display()),
            Self::EmptyJournal(path) => write!(f, "{} has no entries", path.display()),
            Self::Ambiguous(found) => write!(
                f,
                "These look like renames, which the generator never guesses:\n  {}\nA rename is not \
                 additive (DATA-007): add the new one, backfill, and drop the old in a later \
                 migration. To rename anyway, write it as a --custom migration.",
                found.join("\n  ")
            ),
            Self::Destructive(found) => write!(
                f,
                "This migration would break the version running one migration behind (DATA-007):\n  \
                 {}\nShip the code that stops using it first; then rerun with --allow-drop.",
                found.join("\n  ")
            ),
            Self::Concurrently(statement) => write!(
                f,
                "CONCURRENTLY can't run in the migration's transaction (DATA-017):\n{statement}"
            ),
            Self::Unsupported(found) => write!(
                f,
                "The generator doesn't write these; write them as a --custom migration:\n  {}",
                found.join("\n  ")
            ),
        }
    }
}

impl std::error::Error for GenerateError {}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, GenerateError> {
    let text =
        fs::read_to_string(path).map_err(|error| GenerateError::Io(path.to_owned(), error))?;
    serde_json::from_str(&text).map_err(|error| GenerateError::Json(path.to_owned(), error))
}

fn write(path: &Path, text: &str) -> Result<(), GenerateError> {
    fs::write(path, text).map_err(|error| GenerateError::Io(path.to_owned(), error))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('_').all(|word| {
            !word.is_empty()
                && word
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// A varchar that only gets longer, or becomes text: every old value still fits.
fn widens(from: &str, to: &str) -> bool {
    fn length(sql_type: &str) -> Option<u64> {
        let rest = sql_type.strip_prefix("varchar")?;
        if rest.is_empty() {
            return Some(u64::MAX);
        }
        rest.strip_prefix('(')?.strip_suffix(')')?.parse().ok()
    }
    let Some(before) = length(from) else {
        return false;
    };
    to == "text" || length(to).is_some_and(|after| after >= before)
}

/// The changes that can break the previous version or lose data.
pub fn destructive_changes(prev: &Snapshot, next: &Snapshot) -> Vec<String> {
    let mut found = Vec::new();
    for key in prev
        .tables
        .keys()
        .filter(|key| !next.tables.contains_key(*key))
    {
        found.push(format!("drops table {key}"));
    }
    for (key, before) in &prev.enums {
        match next.enums.get(key) {
            None => found.push(format!("drops type {key}")),
            Some(after) => {
                for value in before
                    .values
                    .iter()
                    .filter(|value| !after.values.contains(value))
                {
                    found.push(format!("drops value '{value}' from type {key}"));
                }
            }
        }
    }
    for (key, after) in &next.tables {
        let Some(before) = prev.tables.get(key) else {
            continue;
        };
        for name in before
            .columns
            .keys()
            .filter(|name| !after.columns.contains_key(*name))
        {
            found.push(format!("drops column {key}.{name}"));
        }
        for (name, column) in &after.columns {
            let Some(old) = before.columns.get(name) else {
                continue;
            };
            if old.sql_type != column.sql_type && !widens(&old.sql_type, &column.sql_type) {
                found.push(format!(
                    "changes the type of {key}.{name} from {} to {}",
                    old.sql_type, column.sql_type
                ));
            }
            if !old.not_null && column.not_null {
                found.push(format!("sets {key}.{name} NOT NULL"));
            }
        }
    }
    found
}

fn pad(idx: u32) -> String {
    format!("{idx:04}")
}

/// Deletes all but the newest [`KEEP_SNAPSHOTS`] snapshots; how many went.
fn prune_snapshots(meta: &Path) -> Result<usize, GenerateError> {
    let entries = fs::read_dir(meta).map_err(|error| GenerateError::Io(meta.to_owned(), error))?;
    let mut snapshots: Vec<(u32, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let number = name.strip_suffix("_snapshot.json")?.parse().ok()?;
            Some((number, entry.path()))
        })
        .collect();
    snapshots.sort();
    let stale = snapshots.len().saturating_sub(KEEP_SNAPSHOTS);
    for (_, path) in &snapshots[..stale] {
        fs::remove_file(path).map_err(|error| GenerateError::Io(path.clone(), error))?;
    }
    Ok(stale)
}

/// Runs the generator: diffs, checks and writes (nothing when it refuses).
pub fn generate(request: Request) -> Result<Outcome, GenerateError> {
    if !valid_name(&request.name) {
        return Err(GenerateError::BadName(request.name));
    }
    let meta = request.dir.join("meta");
    let journal_path = meta.join("_journal.json");
    let mut journal: Journal = read_json(&journal_path)?;
    let last = journal
        .entries
        .last()
        .cloned()
        .ok_or_else(|| GenerateError::EmptyJournal(journal_path.clone()))?;
    let prev_file = format!("{}_snapshot.json", pad(last.idx));
    let prev: Snapshot = read_json(&meta.join(&prev_file))?;
    let mut next = request.next;
    next.id = Some(request.id);
    next.prev_id.clone_from(&prev.id);

    let mut warnings = Vec::new();
    let statements = match diff::diff(&prev, &next) {
        Ok(statements) => statements,
        Err(DiffError::Ambiguous(found)) if request.custom => {
            warnings.push(format!(
                "looks like a rename, so its SQL is yours to write: {}",
                found.join("; ")
            ));
            Vec::new()
        }
        Err(DiffError::Ambiguous(found)) => return Err(GenerateError::Ambiguous(found)),
        Err(DiffError::Unsupported(found)) if request.custom => {
            warnings.push(format!(
                "the generator doesn't write these, so their SQL is yours: {}",
                found.join("; ")
            ));
            Vec::new()
        }
        Err(DiffError::Unsupported(found)) => return Err(GenerateError::Unsupported(found)),
    };

    if request.custom {
        warnings.extend(
            statements
                .iter()
                .map(|statement| format!("the SQL must make this change: {}", statement.trim())),
        );
    } else if statements.is_empty() {
        return Ok(Outcome::NoChanges {
            snapshot: prev_file,
        });
    } else {
        let destructive = destructive_changes(&prev, &next);
        if !destructive.is_empty() && !request.allow_drop {
            return Err(GenerateError::Destructive(destructive));
        }
        if let Some(statement) = statements
            .iter()
            .find(|s| s.to_ascii_uppercase().contains("CONCURRENTLY"))
        {
            return Err(GenerateError::Concurrently(statement.clone()));
        }
    }

    let idx = last.idx + 1;
    let tag = format!("{}_{}", pad(idx), request.name);
    let sql_path = request.dir.join(format!("{tag}.sql"));
    let sql = if request.custom {
        CUSTOM_SQL.to_owned()
    } else {
        statements.join(BREAKPOINT)
    };
    let snapshot = serde_json::to_string_pretty(&next)
        .map_err(|error| GenerateError::Json(sql_path.clone(), error))?;
    journal.entries.push(JournalEntry {
        idx,
        version: next.version.clone(),
        when: request.now.max(last.when + 1),
        tag,
        breakpoints: true,
    });
    let journal_text = serde_json::to_string_pretty(&journal)
        .map_err(|error| GenerateError::Json(journal_path.clone(), error))?;
    write(&sql_path, &sql)?;
    write(&meta.join(format!("{}_snapshot.json", pad(idx))), &snapshot)?;
    write(&journal_path, &journal_text)?;
    let pruned = prune_snapshots(&meta)?;
    Ok(Outcome::Written {
        sql: sql_path,
        statements: if request.custom { 0 } else { statements.len() },
        pruned,
        warnings,
    })
}

/// The report a run prints, with paths relative to `root`.
pub fn report(outcome: &Outcome, database: &str, custom: bool, root: &Path) -> String {
    match outcome {
        Outcome::NoChanges { snapshot } => {
            format!("No schema changes: the {database} entities match {snapshot}.")
        }
        Outcome::Written {
            sql,
            statements,
            pruned,
            warnings,
        } => {
            let mut out = String::new();
            for warning in warnings {
                let _ = writeln!(out, "warning: {warning}");
            }
            let what = if custom {
                "write its SQL".to_owned()
            } else if *statements == 1 {
                "1 statement".to_owned()
            } else {
                format!("{statements} statements")
            };
            let shown = sql.strip_prefix(root).unwrap_or(sql);
            let _ = writeln!(
                out,
                "Wrote {} ({what}), its snapshot and journal entry.",
                shown.display()
            );
            if *pruned > 0 {
                let _ = writeln!(
                    out,
                    "Deleted {pruned} old snapshot(s), keeping {KEEP_SNAPSHOTS}."
                );
            }
            out.push_str(
                "Commit the SQL, the snapshot, the journal and the deleted snapshots together.",
            );
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_lower_case_words() {
        assert!(valid_name("add_ticket_priority"));
        assert!(valid_name("v2"));
        assert!(!valid_name("Add"));
        assert!(!valid_name("a__b"));
        assert!(!valid_name("a-b"));
        assert!(!valid_name(""));
    }

    #[test]
    fn only_a_longer_varchar_widens() {
        assert!(widens("varchar(30)", "varchar(255)"));
        assert!(widens("varchar(30)", "text"));
        assert!(!widens("varchar(255)", "varchar(30)"));
        assert!(!widens("integer", "bigint"));
    }
}
