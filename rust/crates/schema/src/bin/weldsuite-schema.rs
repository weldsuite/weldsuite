//! `weldsuite-schema`: the schema's dev tool (ADR DATA-019).
//!
//!   weldsuite-schema generate tenant|master --name <slug> [--custom] [--allow-drop]
//!   weldsuite-schema snapshot tenant|master <file>
//!
//! `generate` writes a migration from the difference between the entities
//! and the newest journaled snapshot (`weldsuite_schema::generate`); `pnpm
//! db:generate` and `pnpm db:generate:master` run it. `snapshot` writes the
//! snapshot the entities build, to look at. A migration needs a person's
//! approval before it is generated (AGENTS.md, "Data").

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use weldsuite_schema::drizzle::Snapshot;
use weldsuite_schema::generate::{Request, generate, report};

const USAGE: &str =
    "usage: weldsuite-schema generate tenant|master --name <slug> [--custom] [--allow-drop]
       weldsuite-schema snapshot tenant|master <file>";

fn schema(database: &str) -> Option<Snapshot> {
    match database {
        "tenant" => Some(weldsuite_schema::tenant::schema()),
        "master" => Some(weldsuite_schema::master::schema()),
        _ => None,
    }
}

/// `rust/`: this crate is `rust/crates/schema`.
fn rust_dir() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(Path::parent)
        .map_or_else(|| manifest.join("../.."), Path::to_path_buf)
}

fn usage(message: &str) -> ExitCode {
    eprintln!("{message}\n{USAGE}");
    ExitCode::from(2)
}

fn run_generate(args: &[String]) -> ExitCode {
    let mut database = "tenant".to_owned();
    let mut name = None;
    let (mut custom, mut allow_drop) = (false, false);
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "tenant" | "master" => database.clone_from(arg),
            "--name" => name = rest.next().cloned(),
            "--custom" => custom = true,
            "--allow-drop" => allow_drop = true,
            "--" => {}
            other => match other.strip_prefix("--name=") {
                Some(value) => name = Some(value.to_owned()),
                None => return usage(&format!("unknown argument {other:?}")),
            },
        }
    }
    let Some(name) = name else {
        return usage("--name is required");
    };
    let Some(next) = schema(&database) else {
        return usage(&format!("unknown database {database:?}"));
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        });
    let request = Request {
        dir: rust_dir().join("migrations").join(&database),
        next,
        name,
        custom,
        allow_drop,
        id: uuid::Uuid::new_v4().to_string(),
        now,
    };
    match generate(request) {
        Ok(outcome) => {
            let repo = rust_dir()
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_default();
            println!("{}", report(&outcome, &database, custom, &repo));
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run_snapshot(args: &[String]) -> ExitCode {
    let [database, file] = args else {
        return usage("snapshot takes a database and a file");
    };
    let Some(snapshot) = schema(database) else {
        return usage(&format!("unknown database {database:?}"));
    };
    match serde_json::to_string_pretty(&snapshot).map(|text| std::fs::write(file, text)) {
        Ok(Ok(())) => ExitCode::SUCCESS,
        Ok(Err(error)) => {
            eprintln!("{file}: {error}");
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.split_first() {
        Some((command, rest)) if command == "generate" => run_generate(rest),
        Some((command, rest)) if command == "snapshot" => run_snapshot(rest),
        _ => usage("a command is required"),
    }
}
