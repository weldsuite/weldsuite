//! The journals: the embedded Drizzle migrations, and which of them a
//! database has applied (`packages/core/db/src/lib/tenant-journal.ts`).

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

use aws_lc_rs::digest::{SHA256, digest};

/// One journal entry as `build.rs` embedded it.
struct RawEntry {
    tag: &'static str,
    when: i64,
    sql: &'static str,
}

// The journals' `when` values, as written there.
#[allow(clippy::unreadable_literal)]
mod generated {
    use super::RawEntry;
    include!(concat!(env!("OUT_DIR"), "/journals.rs"));
}

/// What Drizzle writes between the statements of a migration file.
pub const STATEMENT_BREAKPOINT: &str = "--> statement-breakpoint";

/// Which migrations: the master database's or the tenant databases'.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Folder {
    /// `packages/core/db/drizzle/master-migrations`.
    Master,
    /// `packages/core/db/drizzle/tenant-migrations`.
    Tenant,
}

impl Folder {
    /// The schema of the bookkeeping table `__drizzle_migrations`.
    /// `pnpm db:migrate:master` (drizzle-kit, no `migrations.schema` in its
    /// config) keeps the master's in Drizzle's default `drizzle`;
    /// `apps/tools/migrate-databases` passes `migrationsSchema: 'public'` for
    /// the tenants, as the workspace worker's applier does.
    pub fn schema(self) -> &'static str {
        match self {
            Self::Master => "drizzle",
            Self::Tenant => "public",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Master => "master",
            Self::Tenant => "tenant",
        }
    }
}

/// One migration: its journal tag and `when`, its SQL and the hash Drizzle
/// records for it.
#[derive(Debug, Clone)]
pub struct Migration {
    tag: Cow<'static, str>,
    when: i64,
    sql: Cow<'static, str>,
    hash: String,
}

impl Migration {
    /// A migration from its file's text. Line endings are normalised to LF,
    /// as the files are in git (a Windows checkout may hold CRLF), so the
    /// hash is the one `apps/tools/migrate-databases` records on Linux: the
    /// SHA-256 of the file.
    pub fn new(
        tag: impl Into<Cow<'static, str>>,
        when: i64,
        sql: impl Into<Cow<'static, str>>,
    ) -> Self {
        let sql = sql.into();
        let sql = if sql.contains("\r\n") {
            Cow::Owned(sql.replace("\r\n", "\n"))
        } else {
            sql
        };
        let hash = hex::encode(digest(&SHA256, sql.as_bytes()));
        Self {
            tag: tag.into(),
            when,
            sql,
            hash,
        }
    }

    pub fn tag(&self) -> &str {
        &self.tag
    }

    /// The journal's `when`, which Drizzle stores as `created_at`.
    pub fn when(&self) -> i64 {
        self.when
    }

    /// SHA-256 (hex) of the file, Drizzle's `hash`.
    pub fn hash(&self) -> &str {
        &self.hash
    }

    pub fn sql(&self) -> &str {
        &self.sql
    }

    /// The file split on Drizzle's breakpoint, as Drizzle's migrator splits
    /// it; blank pieces left out (running them is a no-op).
    pub fn statements(&self) -> impl Iterator<Item = &str> {
        self.sql
            .split(STATEMENT_BREAKPOINT)
            .map(str::trim)
            .filter(|statement| !statement.is_empty())
    }
}

/// A folder's migrations in journal order (`meta/_journal.json`).
#[derive(Debug, Clone)]
pub struct Journal {
    folder: Folder,
    migrations: Vec<Migration>,
}

static EMBEDDED: LazyLock<[Journal; 2]> = LazyLock::new(|| {
    let load = |folder, entries: &'static [RawEntry]| Journal {
        folder,
        migrations: entries
            .iter()
            .map(|entry| Migration::new(entry.tag, entry.when, entry.sql))
            .collect(),
    };
    [
        load(Folder::Master, generated::MASTER),
        load(Folder::Tenant, generated::TENANT),
    ]
});

impl Journal {
    pub fn new(folder: Folder, migrations: Vec<Migration>) -> Self {
        Self { folder, migrations }
    }

    /// The migrations built into this binary.
    pub fn embedded(folder: Folder) -> &'static Self {
        match folder {
            Folder::Master => &EMBEDDED[0],
            Folder::Tenant => &EMBEDDED[1],
        }
    }

    pub fn folder(&self) -> Folder {
        self.folder
    }

    pub fn migrations(&self) -> &[Migration] {
        &self.migrations
    }

    pub fn get(&self, tag: &str) -> Option<&Migration> {
        self.migrations
            .iter()
            .find(|migration| migration.tag() == tag)
    }

    /// The newest tag: the schema version a database at the journal level has.
    pub fn latest_tag(&self) -> Option<&str> {
        self.migrations.last().map(Migration::tag)
    }

    /// The first `count` migrations, as an older release's journal.
    #[must_use]
    pub fn truncated(&self, count: usize) -> Self {
        Self {
            folder: self.folder,
            migrations: self.migrations.iter().take(count).cloned().collect(),
        }
    }
}

/// One `__drizzle_migrations` row. `tag` is null when Drizzle's migrator
/// wrote it (or the column does not exist).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedMigration {
    pub tag: Option<String>,
    pub hash: Option<String>,
    /// `created_at` as text (a bigint).
    pub created_at: Option<String>,
}

/// Rows of tenant migrations that are not, or no longer, in the journal, and
/// whose changes the journal already holds: they count as nothing
/// (`RETIRED_MIGRATION_HASHES`).
pub const RETIRED_MIGRATION_HASHES: [(&str, &str); 2] = [
    (
        "3844944a8c61a86607b981f47886e4fc09bc8249c635614727ba433754a13ed4",
        "applied on 2026-04-16 from a branch that was never merged",
    ),
    (
        "2061c8f2a3273ecb7dcd1d14fcf203cd2984060154218cb233e7cbee597806ea",
        "applied on 2026-04-16 from a branch that was never merged",
    ),
];

/// Earlier versions of a tenant journal migration, recorded under another
/// hash, whose changes equal the current version's
/// (`SUPERSEDED_MIGRATION_HASHES`).
pub const SUPERSEDED_MIGRATION_HASHES: [(&str, &str); 1] = [(
    // The 2026-08-20 version of 0124 (commit 0b3d0fb19); its `when` was 1777662354345 then.
    "25a06a163f4b21c4563468a803b99db0b8928dc371baef647400c5fc158d1d7c",
    "0124_massive_natasha_romanoff",
)];

/// Which journal migrations a database has applied (`TenantJournalMatch`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JournalMatch {
    /// Journal tags the database has applied.
    pub applied: BTreeSet<String>,
    /// Journal tags it has not applied, in journal order.
    pub missing: Vec<String>,
    /// Rows that match no journal entry and are not retired: migrations this
    /// journal does not know (a newer release's, say).
    pub unknown: Vec<RecordedMigration>,
    /// Rows that repeat a migration another row already recorded (harmless).
    pub duplicates: usize,
}

impl JournalMatch {
    /// Every journal migration applied, and nothing the journal does not
    /// know (`isAtJournalLevel`).
    pub fn is_at_journal_level(&self) -> bool {
        self.missing.is_empty() && self.unknown.is_empty()
    }

    /// One line for logs: what is missing (the first three tags) and how many
    /// rows are unknown (`describeJournalGap`).
    pub fn describe_gap(&self) -> String {
        const SHOW: usize = 3;
        let mut parts = Vec::new();
        if !self.missing.is_empty() {
            let first = self
                .missing
                .iter()
                .take(SHOW)
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            let more = if self.missing.len() > SHOW {
                format!(", +{} more", self.missing.len() - SHOW)
            } else {
                String::new()
            };
            parts.push(format!(
                "{} migration(s) missing ({first}{more})",
                self.missing.len()
            ));
        }
        if !self.unknown.is_empty() {
            parts.push(format!(
                "{} row(s) of migrations the journal does not know",
                self.unknown.len()
            ));
        }
        if parts.is_empty() {
            "at the journal level".to_owned()
        } else {
            parts.join("; ")
        }
    }
}

/// Judge a database's rows migration by migration against the journal
/// (`matchTenantJournal`). A row names its migration by `tag` (written by the
/// workspace worker and by `--apply-skipped`), by `hash` (Drizzle's
/// migrator), or only by `created_at` (an edited file). The retired and
/// superseded hashes are the tenant journal's.
pub fn match_journal(rows: &[RecordedMigration], journal: &Journal) -> JournalMatch {
    let by_tag: BTreeSet<&str> = journal.migrations().iter().map(Migration::tag).collect();
    let by_hash: HashMap<&str, &str> = journal
        .migrations()
        .iter()
        .map(|migration| (migration.hash(), migration.tag()))
        .collect();
    let by_when: HashMap<String, &str> = journal
        .migrations()
        .iter()
        .map(|migration| (migration.when().to_string(), migration.tag()))
        .collect();
    let tenant = journal.folder() == Folder::Tenant;

    // Some(Some(tag)) a journal migration, Some(None) a retired row, None unexplained.
    let tag_of = |row: &RecordedMigration| -> Option<Option<&str>> {
        if let Some(tag) = row.tag.as_deref()
            && let Some(known) = by_tag.get(tag)
        {
            return Some(Some(*known));
        }
        if let Some(hash) = row.hash.as_deref() {
            let superseded = || {
                SUPERSEDED_MIGRATION_HASHES
                    .iter()
                    .find(|(old, _)| tenant && *old == hash)
                    .map(|(_, tag)| *tag)
            };
            if let Some(tag) = by_hash.get(hash).copied().or_else(superseded)
                && by_tag.contains(tag)
            {
                return Some(Some(tag));
            }
            if tenant
                && RETIRED_MIGRATION_HASHES
                    .iter()
                    .any(|(retired, _)| *retired == hash)
            {
                return Some(None);
            }
        }
        let created_at = row.created_at.as_deref()?;
        by_when.get(created_at).map(|tag| Some(*tag))
    };

    let mut result = JournalMatch::default();
    for row in rows {
        match tag_of(row) {
            Some(None) => {}
            None => result.unknown.push(row.clone()),
            Some(Some(tag)) => {
                if !result.applied.insert(tag.to_owned()) {
                    result.duplicates += 1;
                }
            }
        }
    }
    result.missing = journal
        .migrations()
        .iter()
        .filter(|migration| !result.applied.contains(migration.tag()))
        .map(|migration| migration.tag().to_owned())
        .collect();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> Journal {
        Journal::new(
            Folder::Tenant,
            vec![
                Migration::new("0000_a", 100, "create table a ();"),
                Migration::new("0001_b", 200, "create table b ();"),
                Migration::new("0002_c", 300, "create table c ();"),
            ],
        )
    }

    fn row(tag: Option<&str>, hash: Option<&str>, created_at: Option<&str>) -> RecordedMigration {
        RecordedMigration {
            tag: tag.map(str::to_owned),
            hash: hash.map(str::to_owned),
            created_at: created_at.map(str::to_owned),
        }
    }

    #[test]
    fn embeds_both_journals_in_order_with_lf_hashes() {
        let master = Journal::embedded(Folder::Master);
        let tenant = Journal::embedded(Folder::Tenant);
        assert!(master.migrations().len() >= 64);
        assert!(tenant.migrations().len() >= 230);
        assert_eq!(master.migrations()[0].tag(), "0000_easy_smasher");
        assert_eq!(tenant.migrations()[0].tag(), "0000_dizzy_giant_girl");
        // The SHA-256 of the files as git holds them (LF), which the
        // TypeScript runner records on Linux.
        assert_eq!(
            master.migrations()[0].hash(),
            "3e8a2cc50077d6890dbe25542e2204f0c5e3ff7e9384baef79db54568cecd301"
        );
        assert_eq!(
            tenant.migrations()[0].hash(),
            "3474d0866faf49e77b7ef78df7976a8011c49c14d4001271f3c2029d3638bffb"
        );
        for journal in [master, tenant] {
            for migration in journal.migrations() {
                assert!(!migration.sql().contains('\r'), "{}", migration.tag());
                assert!(
                    migration.statements().next().is_some(),
                    "{}",
                    migration.tag()
                );
            }
        }
    }

    #[test]
    fn splits_on_the_breakpoint_and_drops_blanks() {
        let migration = Migration::new(
            "0000_x",
            1,
            "CREATE TABLE a ();\r\n--> statement-breakpoint\r\nCREATE TABLE b ();--> statement-breakpoint\n\n",
        );
        assert_eq!(
            migration.statements().collect::<Vec<_>>(),
            ["CREATE TABLE a ();", "CREATE TABLE b ();"]
        );
        assert_eq!(
            migration.hash(),
            Migration::new(
                "0000_x",
                1,
                "CREATE TABLE a ();\n--> statement-breakpoint\nCREATE TABLE b ();--> statement-breakpoint\n\n"
            )
            .hash()
        );
    }

    #[test]
    fn matches_rows_by_tag_hash_or_created_at() {
        let journal = journal();
        let hash_b = journal.get("0001_b").expect("b").hash().to_owned();
        let rows = [
            row(Some("0000_a"), None, None),
            row(None, Some(&hash_b), Some("200")),
            row(None, Some("edited"), Some("300")),
        ];
        let matched = match_journal(&rows, &journal);
        assert!(matched.is_at_journal_level(), "{matched:?}");
        assert_eq!(matched.duplicates, 0);
        assert_eq!(matched.describe_gap(), "at the journal level");
    }

    #[test]
    fn reports_skipped_unknown_retired_and_duplicate_rows() {
        let journal = journal();
        let rows = [
            row(None, Some("x"), Some("100")),
            row(None, Some("y"), Some("100")),
            row(None, Some("newer"), Some("999")),
            row(None, Some(RETIRED_MIGRATION_HASHES[0].0), Some("5")),
        ];
        let matched = match_journal(&rows, &journal);
        assert_eq!(matched.missing, ["0001_b", "0002_c"]);
        assert_eq!(matched.unknown.len(), 1);
        assert_eq!(matched.duplicates, 1);
        assert_eq!(
            matched.describe_gap(),
            "2 migration(s) missing (0001_b, 0002_c); 1 row(s) of migrations the journal does not know"
        );

        let mut long = journal.migrations().to_vec();
        long.push(Migration::new("0003_d", 400, "select 1"));
        long.push(Migration::new("0004_e", 500, "select 2"));
        let matched = match_journal(&[], &Journal::new(Folder::Tenant, long));
        assert_eq!(
            matched.describe_gap(),
            "5 migration(s) missing (0000_a, 0001_b, 0002_c, +2 more)"
        );
    }

    #[test]
    fn retired_and_superseded_hashes_are_the_tenant_journals() {
        let master = Journal::new(Folder::Master, journal().migrations().to_vec());
        let retired = [row(None, Some(RETIRED_MIGRATION_HASHES[0].0), Some("5"))];
        assert_eq!(match_journal(&retired, &master).unknown.len(), 1);
        assert_eq!(match_journal(&retired, &journal()).unknown, []);

        let tenant = Journal::embedded(Folder::Tenant);
        let superseded = [row(
            None,
            Some(SUPERSEDED_MIGRATION_HASHES[0].0),
            Some("1777662354345"),
        )];
        assert!(
            match_journal(&superseded, tenant)
                .applied
                .contains("0124_massive_natasha_romanoff")
        );
    }
}
