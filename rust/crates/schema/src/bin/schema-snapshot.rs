//! `schema-snapshot tenant|master <file>`: writes the snapshot the entities
//! build (`tenant::snapshot()`, `master::snapshot()`) to `<file>` as JSON.
//! `pnpm db:generate` (`scripts/db-generate.ts`) diffs it against the newest
//! journaled snapshot and writes the migration (ADR DATA-019). It has no `id`
//! or `prevId`: the generator adds them.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [database, file] = args.as_slice() else {
        eprintln!("usage: schema-snapshot tenant|master <file>");
        return ExitCode::from(2);
    };
    let snapshot = match database.as_str() {
        "tenant" => weldsuite_schema::tenant::snapshot(),
        "master" => weldsuite_schema::master::snapshot(),
        other => {
            eprintln!("schema-snapshot: unknown database {other:?} (tenant or master)");
            return ExitCode::from(2);
        }
    };
    match serde_json::to_string(&snapshot).map(|text| std::fs::write(file, text)) {
        Ok(Ok(())) => ExitCode::SUCCESS,
        Ok(Err(error)) => {
            eprintln!("schema-snapshot: {file}: {error}");
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("schema-snapshot: {error}");
            ExitCode::FAILURE
        }
    }
}
