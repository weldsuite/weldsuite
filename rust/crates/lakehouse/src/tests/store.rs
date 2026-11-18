//! Our catalog (`pg_catalog.rs`), the writer's fenced append, and the
//! nightly upkeep's whole-table operations: erasure across the four tables,
//! retention over every workspace, and the orphan sweep.

use arrow_array::{Array, Int64Array, RecordBatch};
use iceberg::{Catalog, ErrorKind, MetadataLocation, NamespaceIdent, TableIdent};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use super::fixture::{TestLake, events, file_url, fixture, test_lake, test_pool};
use crate::{
    Erasure, Lakehouse, LakehouseConfig, LakehouseError, ListedFile, PanelTable, rows_to_batch,
};

async fn count(lake: &TestLake, sql: &str) -> i64 {
    let result = lake
        .engine()
        .query(sql)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"));
    result.batches[0]
        .column(0)
        .as_any()
        .downcast_ref::<Int64Array>()
        .expect("a count")
        .value(0)
}

async fn batch(lake: &Lakehouse, table: PanelTable, rows: &[Value]) -> RecordBatch {
    let schema = lake.arrow_schema(table).await.expect("a schema");
    rows_to_batch(&schema, rows).expect("a batch")
}

#[tokio::test]
async fn the_catalog_keeps_namespaces_and_tables_and_swaps_only_from_the_current_metadata() {
    let lake = test_lake!();
    let catalog = lake.lake.catalog();
    let panel = NamespaceIdent::new("panel".to_owned());
    assert_eq!(
        catalog.list_namespaces(None).await.expect("namespaces"),
        std::slice::from_ref(&panel)
    );
    let again = catalog
        .create_namespace(&panel, HashMap::new())
        .await
        .expect_err("it exists");
    assert_eq!(again.kind(), ErrorKind::NamespaceAlreadyExists);
    catalog
        .update_namespace(
            &panel,
            HashMap::from([("owner".to_owned(), "weldpanel".to_owned())]),
        )
        .await
        .expect("properties");
    let properties = catalog.get_namespace(&panel).await.expect("the namespace");
    assert_eq!(
        properties.properties().get("owner").map(String::as_str),
        Some("weldpanel")
    );
    let mut tables: Vec<String> = catalog
        .list_tables(&panel)
        .await
        .expect("tables")
        .into_iter()
        .map(|table| table.name().to_owned())
        .collect();
    tables.sort();
    assert_eq!(
        tables,
        [
            "events_v1",
            "groups_v1",
            "identities_v1",
            "people_v1",
            "replay_chunks_v1"
        ]
    );
    let made_again = catalog
        .create_table(&panel, PanelTable::Events.creation().expect("a creation"))
        .await
        .expect_err("it exists");
    assert_eq!(made_again.kind(), ErrorKind::TableAlreadyExists);
    let missing = catalog
        .load_table(&TableIdent::new(panel.clone(), "nope".to_owned()))
        .await
        .expect_err("no table");
    assert_eq!(missing.kind(), ErrorKind::TableNotFound);
    assert!(
        catalog
            .drop_namespace(&panel)
            .await
            .is_err_and(|error| error.to_string().contains("still has tables"))
    );

    // The commit is a compare-and-swap on the current metadata location.
    let ident = PanelTable::Events.ident();
    let current = catalog
        .metadata_location(&ident)
        .await
        .expect("a location")
        .expect("the table");
    let next = MetadataLocation::from_str_checked(&current).to_string();
    assert!(
        !catalog
            .swap_metadata(&ident, "s3://elsewhere/metadata.json", &next)
            .await
            .expect("a swap")
    );
    assert!(
        catalog
            .swap_metadata(&ident, &current, &current)
            .await
            .expect("a swap")
    );

    // A second catalog name on the same database sees none of it.
    let pool = test_pool().await.expect("the database");
    let other = Lakehouse::new(
        pool,
        &LakehouseConfig {
            catalog_name: format!("test_{}", uuid::Uuid::new_v4().simple()),
            warehouse: file_url(&lake.dir().join("other")),
            storage: HashMap::new(),
        },
    )
    .expect("a catalog");
    let theirs = other
        .catalog()
        .list_namespaces(None)
        .await
        .expect("namespaces");
    assert!(theirs.is_empty(), "{theirs:?}");
}

/// The `MetadataLocation` parser, so the test can name the next version.
trait NextVersion {
    fn from_str_checked(text: &str) -> MetadataLocation;
}

impl NextVersion for MetadataLocation {
    fn from_str_checked(text: &str) -> MetadataLocation {
        use std::str::FromStr;
        MetadataLocation::from_str(text)
            .expect("a metadata location")
            .with_next_version()
    }
}

#[tokio::test]
async fn a_table_another_writer_committed_to_is_not_appended_to() {
    let lake = test_lake!();
    let rows = events();
    let first = batch(&lake.lake, PanelTable::Events, &rows[..10]).await;
    let outcome = lake
        .lake
        .append_after(PanelTable::Events, std::slice::from_ref(&first), 10, None)
        .await
        .expect("an append")
        .expect("a commit");
    assert!(!outcome.data_files.is_empty(), "{outcome:?}");
    assert_eq!(
        lake.lake
            .last_stream_seq(PanelTable::Events)
            .await
            .expect("seq"),
        Some(10)
    );
    // A writer that still believes the table is at nothing (it lost the
    // lease while paused) commits nothing, and leaves no files behind.
    let stale = lake
        .lake
        .append_after(PanelTable::Events, &[first], 12, None)
        .await
        .expect_err("fenced");
    assert!(matches!(stale, LakehouseError::Conflict(_)), "{stale}");
    let next = batch(&lake.lake, PanelTable::Events, &rows[10..20]).await;
    lake.lake
        .append_after(PanelTable::Events, &[next], 20, Some(10))
        .await
        .expect("an append")
        .expect("a commit");
    assert_eq!(
        count(&lake, "SELECT count(*) FROM panel.events_v1").await,
        20
    );
    assert_eq!(
        lake.lake
            .last_stream_seq(PanelTable::Events)
            .await
            .expect("seq"),
        Some(20)
    );
    // Empty is no commit.
    let empty = rows_to_batch(
        &lake
            .lake
            .arrow_schema(PanelTable::Events)
            .await
            .expect("a schema"),
        &[],
    )
    .expect("an empty batch");
    assert!(
        lake.lake
            .append_after(PanelTable::Events, &[empty], 21, Some(20))
            .await
            .expect("nothing")
            .is_none()
    );
    // The fenced attempt's data files were deleted.
    let referenced = lake
        .lake
        .referenced_files(PanelTable::Events)
        .await
        .expect("references");
    let data = files_under(lake.dir(), "events_v1/data");
    assert!(
        data.iter().all(|path| referenced.contains(path)),
        "unreferenced data files: {data:?}"
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn erasing_people_removes_their_rows_from_the_four_tables_in_their_project_only() {
    let lake = test_lake!();
    // ws_1's visitors also appear in a second project of the workspace.
    for (table, rows) in fixture() {
        let other: Vec<Value> = rows
            .iter()
            .filter(|row| row["workspace_id"] == "ws_1")
            .map(|row| {
                let mut row = row.clone();
                row["project_id"] = Value::from("pnp_9");
                if let Some(id) = row.get("event_id").and_then(Value::as_str) {
                    row["event_id"] = Value::from(format!("{id}-9"));
                }
                row
            })
            .collect();
        let all: Vec<Value> = rows.into_iter().chain(other).collect();
        lake.lake
            .append_rows(table, &all, Some(1))
            .await
            .expect("seed");
    }
    let in_project = |table: &str, project: &str, condition: &str| {
        format!(
            "SELECT count(*) FROM panel.{table} WHERE workspace_id = 'ws_1' AND project_id = '{project}' AND {condition}"
        )
    };
    let person =
        "(distinct_id IN ('u-1', 'a-1') OR anon_id IN ('u-1', 'a-1') OR user_id IN ('u-1', 'a-1'))";
    let sessions = "session_id IN (SELECT DISTINCT session_id FROM panel.events_v1 WHERE workspace_id = 'ws_1' AND project_id = 'pnp_1' AND (distinct_id IN ('u-1', 'a-1') OR anon_id IN ('u-1', 'a-1') OR user_id IN ('u-1', 'a-1')))";
    let events_before = count(&lake, &in_project("events_v1", "pnp_1", person)).await;
    let chunks_before = count(&lake, &in_project("replay_chunks_v1", "pnp_1", sessions)).await;
    let other_before = count(&lake, &in_project("events_v1", "pnp_9", person)).await;
    let other_chunks = count(&lake, &in_project("replay_chunks_v1", "pnp_9", "true")).await;
    assert!(events_before > 0 && chunks_before > 0 && other_before > 0);

    let erasure = Erasure {
        workspace_id: "ws_1".to_owned(),
        ids_by_project: BTreeMap::from([(
            "pnp_1".to_owned(),
            HashSet::from(["u-1".to_owned(), "a-1".to_owned()]),
        )]),
    };
    let counts = lake.lake.erase_people(&erasure).await.expect("an erasure");
    assert_eq!(counts.events, u64::try_from(events_before).expect("rows"));
    assert_eq!(
        counts.replay_chunks,
        u64::try_from(chunks_before).expect("rows")
    );
    assert_eq!(counts.people, 2);
    assert_eq!(counts.identities, 1);

    assert_eq!(
        count(&lake, &in_project("events_v1", "pnp_1", person)).await,
        0
    );
    assert_eq!(
        count(&lake, &in_project("people_v1", "pnp_1", "user_id = 'u-1'")).await,
        0
    );
    assert_eq!(
        count(
            &lake,
            &in_project(
                "identities_v1",
                "pnp_1",
                "(anon_id = 'a-1' OR user_id = 'u-1')"
            )
        )
        .await,
        0
    );
    // The other project's rows of the same ids stay, and so do ws_2's.
    assert_eq!(
        count(&lake, &in_project("events_v1", "pnp_9", person)).await,
        other_before
    );
    assert_eq!(
        count(&lake, &in_project("replay_chunks_v1", "pnp_9", "true")).await,
        other_chunks
    );
    assert!(
        count(
            &lake,
            &format!(
                "SELECT count(*) FROM panel.events_v1 WHERE workspace_id = 'ws_2' AND {person}"
            )
        )
        .await
            > 0
    );
    // Groups aren't personal.
    assert_eq!(
        count(&lake, "SELECT count(*) FROM panel.groups_v1").await,
        6
    );
    // Again: nothing left.
    assert_eq!(
        lake.lake.erase_people(&erasure).await.expect("nothing"),
        crate::ErasureCounts::default()
    );
}

#[tokio::test]
async fn retention_drops_each_workspace_s_days_before_its_own_cutoff_in_one_commit() {
    let lake = test_lake!();
    lake.seed().await;
    let before = count(&lake, "SELECT count(*) FROM panel.events_v1").await;
    let nov_2 = 20_759;
    // ws_1 keeps from Nov 2, ws_2 from Nov 3, anything else everything.
    let cutoff = |workspace: &str| match workspace {
        "ws_1" => Some(nov_2),
        "ws_2" => Some(nov_2 + 1),
        _ => None,
    };
    let (outcome, rows) = lake
        .lake
        .drop_expired_days(PanelTable::Events, &cutoff)
        .await
        .expect("retention")
        .expect("days to drop");
    assert_eq!(outcome.attempts, 1);
    // A day is 24 events per workspace.
    assert_eq!(rows, 24 * 3);
    assert_eq!(
        count(&lake, "SELECT count(*) FROM panel.events_v1").await,
        before - 72
    );
    assert!(
        lake.lake
            .drop_expired_days(PanelTable::Events, &cutoff)
            .await
            .expect("nothing")
            .is_none()
    );
    assert!(
        lake.lake
            .drop_expired_days(PanelTable::People, &cutoff)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn the_orphan_sweep_deletes_only_old_unreferenced_files_under_the_table() {
    let lake = test_lake!();
    lake.seed().await;
    let table = lake.lake.load(PanelTable::Events).await.expect("events");
    // What a crashed writer leaves: a data file and a metadata file no
    // commit names, and a file of another table.
    let panel = lake.dir().join("warehouse").join("panel");
    let strays = [
        panel.join("events_v1/data/workspace_id=ws_1/stray.parquet"),
        panel.join("events_v1/metadata/99999-stray.metadata.json"),
        panel.join("people_v1/stray.parquet"),
    ];
    for path in &strays {
        std::fs::create_dir_all(path.parent().expect("a folder")).expect("a folder");
        std::fs::write(path, "stray").expect("a stray file");
    }
    let [stray_data, stray_meta, elsewhere] = strays.map(|path| file_url(&path));
    assert!(
        stray_data.starts_with(table.metadata().location()),
        "{stray_data} is not under {}",
        table.metadata().location()
    );
    let referenced = lake
        .lake
        .referenced_files(PanelTable::Events)
        .await
        .expect("references");
    let mut listed: Vec<ListedFile> = files_under(lake.dir(), "events_v1")
        .into_iter()
        .map(|path| ListedFile {
            path,
            modified_ms: Some(0),
        })
        .collect();
    listed.push(ListedFile {
        path: elsewhere.clone(),
        modified_ms: Some(0),
    });
    let now = 4_102_444_800_000;
    // A young stray stays.
    let young: Vec<ListedFile> = listed
        .iter()
        .map(|file| ListedFile {
            modified_ms: Some(now),
            ..file.clone()
        })
        .collect();
    let sweep = lake
        .lake
        .sweep_orphans(PanelTable::Events, &young, now)
        .await
        .expect("a sweep");
    assert!(sweep.orphans.is_empty(), "{sweep:?}");

    let sweep = lake
        .lake
        .sweep_orphans(PanelTable::Events, &listed, now)
        .await
        .expect("a sweep");
    assert_eq!(sweep.orphans, [stray_data.clone(), stray_meta.clone()]);
    assert_eq!(sweep.referenced, referenced.len());
    for path in [&stray_data, &stray_meta] {
        assert!(!table.file_io().exists(path).await.expect("exists"));
    }
    assert!(table.file_io().exists(&elsewhere).await.expect("exists"));
    // Every referenced file is still there and the table still reads.
    for path in &referenced {
        assert!(
            table.file_io().exists(path).await.expect("exists"),
            "{path}"
        );
    }
    assert_eq!(
        count(&lake, "SELECT count(*) FROM panel.events_v1").await,
        i64::try_from(events().len()).expect("rows")
    );
}

/// Every file under `<dir>/warehouse/panel/<sub>`, as `file:` paths the way
/// the table names them.
fn files_under(dir: &Path, sub: &str) -> Vec<String> {
    let root = dir.join("warehouse").join("panel");
    let mut out = Vec::new();
    let mut stack = vec![root.join(sub)];
    while let Some(at) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&at) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(file_url(&path));
            }
        }
    }
    out.sort();
    out
}
