//! A lakehouse in a temp dir, and fixture rows: two workspaces (`ws_1` /
//! `pnp_1`, the compiler tests' ids, and `ws_2` / `pnp_2`), people, anonymous
//! visitors, sessions, groups and recording chunks over three days.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::{Lakehouse, LakehouseConfig, PanelTable, QueryEngine, QueryLimits};

pub(crate) struct TestLake {
    pub(crate) lake: Lakehouse,
    dir: PathBuf,
}

impl Drop for TestLake {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.starts_with('/') {
        format!("file:{text}")
    } else {
        format!("file:/{text}")
    }
}

/// A [`TestLake`], or skip the test (return) without Postgres.
macro_rules! test_lake {
    () => {
        match $crate::tests::fixture::TestLake::new().await {
            Some(lake) => lake,
            None => {
                eprintln!("skipped: WELDSUITE_TEST_DATABASE_URL is not set");
                return;
            }
        }
    };
}
pub(crate) use test_lake;

impl TestLake {
    /// The SQL catalog on Postgres (`WELDSUITE_TEST_DATABASE_URL`, a scratch
    /// database; its two tables are made there) under a catalog name of its
    /// own, and the tables in a new temp dir. `None` without the variable.
    ///
    /// Not SQLite: iceberg-catalog-sql's sqlx 0.8 bundles a libsqlite3-sys
    /// that cargo-deny rejects (a SQLite CVE fixed only in 0.39).
    pub(crate) async fn new() -> Option<Self> {
        let catalog_url = std::env::var("WELDSUITE_TEST_DATABASE_URL").ok()?;
        let dir =
            std::env::temp_dir().join(format!("weldsuite-lakehouse-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("warehouse")).expect("a temp dir");
        let config = LakehouseConfig {
            catalog_url,
            catalog_name: format!("test_{}", uuid::Uuid::new_v4().simple()),
            warehouse: file_url(&dir.join("warehouse")),
            storage: HashMap::new(),
        };
        let lake = Lakehouse::connect(&config).await.expect("the catalog");
        lake.ensure_tables().await.expect("the tables");
        Some(Self { lake, dir })
    }

    pub(crate) fn engine(&self) -> QueryEngine {
        QueryEngine::new(
            self.lake.catalog_arc(),
            QueryLimits {
                metadata_ttl: std::time::Duration::ZERO,
                ..QueryLimits::default()
            },
        )
    }

    /// Writes the whole fixture, one commit per table.
    pub(crate) async fn seed(&self) {
        for (table, rows) in fixture() {
            self.lake
                .append_rows(table, &rows, Some(1))
                .await
                .unwrap_or_else(|error| panic!("{}: {error}", table.name()));
        }
    }
}

/// One `events_v1` row; `n` makes the id.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)] // one row, every column
pub(crate) fn event(
    workspace: &str,
    n: usize,
    name: &str,
    ts: &str,
    anon: &str,
    user: Option<&str>,
    session: &str,
    path: &str,
    properties: &Value,
) -> Value {
    let project = workspace.replace("ws_", "pnp_");
    json!({
        "event_id": format!("evt-{workspace}-{n:04}"),
        "workspace_id": workspace,
        "project_id": project,
        "name": name,
        "ts": ts,
        "received_at": ts,
        "distinct_id": user.unwrap_or(anon),
        "anon_id": anon,
        "user_id": user,
        "session_id": session,
        "cookieless": false,
        "url": format!("https://shop.example{path}"),
        "host": "shop.example",
        "path": path,
        "title": "Shop",
        "referrer": if n.is_multiple_of(3) { Value::from("https://www.google.com/") } else { Value::Null },
        "referrer_host": if n.is_multiple_of(3) { Value::from("www.google.com") } else { Value::Null },
        "utm_source": if n.is_multiple_of(4) { Value::from("newsletter") } else { Value::Null },
        "utm_medium": Value::Null,
        "utm_campaign": if n.is_multiple_of(4) { Value::from("autumn") } else { Value::Null },
        "utm_content": Value::Null,
        "utm_term": Value::Null,
        "country": if n.is_multiple_of(2) { "NL" } else { "DE" },
        "region": Value::Null,
        "city": if n.is_multiple_of(2) { "Amsterdam" } else { "Berlin" },
        "device_type": if n.is_multiple_of(5) { "mobile" } else { "desktop" },
        "browser": "Chrome",
        "os": "Windows",
        "viewport_w": 1280,
        "el_tag": if name == "$autocapture" { Value::from("button") } else { Value::Null },
        "el_selector": if name == "$autocapture" { Value::from("#buy") } else { Value::Null },
        "el_text": if name == "$autocapture" { Value::from("Buy") } else { Value::Null },
        "x": if name == "$autocapture" { Value::from(100) } else { Value::Null },
        "y": if name == "$autocapture" { Value::from(200) } else { Value::Null },
        "rel_x": if name == "$autocapture" { Value::from(0.25) } else { Value::Null },
        "rel_y": if name == "$autocapture" { Value::from(0.75) } else { Value::Null },
        "scroll_depth": if name == "$pageleave" { Value::from(80) } else { Value::Null },
        "error_message": if name == "$exception" { Value::from("TypeError: x is undefined") } else { Value::Null },
        "properties": properties.to_string(),
        "lib": "web",
        "lib_version": "0.1.0",
    })
}

/// Visitors per workspace: `(anon, user once identified, session)`.
const VISITORS: [(&str, Option<&str>, &str); 4] = [
    ("a-1", Some("u-1"), "s-1"),
    ("a-2", Some("u-2"), "s-2"),
    ("a-3", None, "s-3"),
    ("a-4", Some("u-3"), "s-4"),
];

const DAYS: [&str; 3] = ["2026-11-01", "2026-11-02", "2026-11-03"];

/// The events: per workspace, day and visitor a short session (pageview,
/// click, signup or purchase, web vitals, sometimes an error), at 10:00 plus
/// a few minutes.
pub(crate) fn events() -> Vec<Value> {
    let mut rows = Vec::new();
    let mut n = 0;
    for workspace in ["ws_1", "ws_2"] {
        for (day_index, day) in DAYS.iter().enumerate() {
            for (visitor_index, (anon, user, session)) in VISITORS.iter().enumerate() {
                let session = format!("{session}-{day_index}");
                let steps: [(&str, &str, Value); 6] = [
                    (
                        "$pageview",
                        "/",
                        json!({ "plan": "free", "$referrer": "https://www.google.com/" }),
                    ),
                    (
                        "$pageview",
                        "/pricing",
                        json!({ "plan": if visitor_index.is_multiple_of(2) { "pro" } else { "free" } }),
                    ),
                    ("$autocapture", "/pricing", json!({ "$action": "click" })),
                    (
                        "signup",
                        "/signup",
                        json!({ "plan": "pro", "amount": 49.5, "$group_company": "acme" }),
                    ),
                    (
                        "$webvitals",
                        "/pricing",
                        json!({ "$lcp": 1200 + 100 * visitor_index, "$cls": 0.05, "$inp": 80 }),
                    ),
                    (
                        if visitor_index == 2 {
                            "$exception"
                        } else {
                            "purchase"
                        },
                        "/checkout",
                        json!({ "amount": 99, "currency": "EUR" }),
                    ),
                ];
                for (minute, (name, path, properties)) in steps.into_iter().enumerate() {
                    n += 1;
                    let ts = format!(
                        "{day}T10:{:02}:{:02}.000Z",
                        visitor_index * 10 + minute,
                        n % 60
                    );
                    // Identified from the signup on.
                    let user = if minute >= 3 { *user } else { None };
                    rows.push(event(
                        workspace,
                        n,
                        name,
                        &ts,
                        anon,
                        user,
                        &session,
                        path,
                        &properties,
                    ));
                }
            }
        }
    }
    rows
}

fn identities() -> Vec<Value> {
    ["ws_1", "ws_2"]
        .iter()
        .flat_map(|workspace| {
            VISITORS.iter().filter_map(move |(anon, user, _)| {
                user.map(|user| {
                    json!({
                        "workspace_id": workspace,
                        "project_id": workspace.replace("ws_", "pnp_"),
                        "anon_id": anon,
                        "user_id": user,
                        "ts": "2026-11-01T10:03:00.000Z",
                    })
                })
            })
        })
        .collect()
}

fn people() -> Vec<Value> {
    let mut rows = Vec::new();
    for workspace in ["ws_1", "ws_2"] {
        for (index, user) in ["u-1", "u-2", "u-3"].iter().enumerate() {
            for version in 1..=2_i64 {
                rows.push(json!({
                    "workspace_id": workspace,
                    "project_id": workspace.replace("ws_", "pnp_"),
                    "user_id": user,
                    "version": version,
                    "ts": format!("2026-11-0{version}T11:00:00.000Z"),
                    "properties": json!({
                        "$email": format!("{user}@example.com"),
                        "$name": format!("User {index}"),
                        "plan": if version == 2 { "pro" } else { "free" },
                        "company": "acme",
                    }).to_string(),
                    "deleted": false,
                }));
            }
        }
    }
    rows
}

fn groups() -> Vec<Value> {
    ["ws_1", "ws_2"]
        .iter()
        .flat_map(|workspace| {
            (1..=2_i64).map(move |version| {
                json!({
                    "workspace_id": workspace,
                    "project_id": workspace.replace("ws_", "pnp_"),
                    "group_type": "company",
                    "group_key": "acme",
                    "version": version,
                    "ts": "2026-11-01T12:00:00.000Z",
                    "properties": json!({ "name": "Acme", "employees": 50 * version }).to_string(),
                    "deleted": false,
                })
            })
        })
        .collect()
}

fn replay_chunks() -> Vec<Value> {
    let mut rows = Vec::new();
    for workspace in ["ws_1", "ws_2"] {
        for (day_index, day) in DAYS.iter().enumerate() {
            for (_, _, session) in VISITORS {
                for seq in 0..2_i32 {
                    rows.push(json!({
                        "workspace_id": workspace,
                        "project_id": workspace.replace("ws_", "pnp_"),
                        "session_id": format!("{session}-{day_index}"),
                        "seq": seq,
                        "ts_start": format!("{day}T10:0{seq}:00.000Z"),
                        "ts_end": format!("{day}T10:0{seq}:59.000Z"),
                        "bytes": 2048,
                        "has_full_snapshot": seq == 0,
                        "r2_key": format!("replays/standard/{workspace}/{session}-{day_index}/{seq}.json.gz"),
                    }));
                }
            }
        }
    }
    rows
}

/// Every table's fixture rows.
pub(crate) fn fixture() -> Vec<(PanelTable, Vec<Value>)> {
    vec![
        (PanelTable::Events, events()),
        (PanelTable::Identities, identities()),
        (PanelTable::People, people()),
        (PanelTable::Groups, groups()),
        (PanelTable::ReplayChunks, replay_chunks()),
    ]
}
