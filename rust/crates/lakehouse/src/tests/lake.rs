//! Writing, replace files and upkeep.

use std::collections::HashSet;
use std::sync::Arc;

use arrow_array::{Array, Int64Array, RecordBatch, StringArray};
use arrow_schema::DataType;
use datafusion::arrow::compute::cast;
use iceberg::arrow::schema_to_arrow_schema;
use iceberg::spec::{ManifestStatus, Operation, PrimitiveType, Type};
use iceberg::table::Table;
use iceberg::transaction::{ApplyTransactionAction, Transaction};
use serde_json::Value;

use super::fixture::{TestLake, events, test_lake};
use crate::maintenance::{live_files, read_files};
use crate::rows::rows_to_batch;
use crate::writer::write_data_files;
use crate::{LakehouseError, PanelTable, ReplaceFiles, STREAM_SEQ_PROPERTY, partitions};

const NOV_1: i32 = 20_758;
const NOV_3: i32 = 20_760;

fn rows_of(rows: &[Value], workspace: &str, day: &str) -> Vec<Value> {
    rows.iter()
        .filter(|row| {
            row["workspace_id"] == workspace
                && row["ts"].as_str().is_some_and(|ts| ts.starts_with(day))
        })
        .cloned()
        .collect()
}

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

async fn strings(lake: &TestLake, sql: &str) -> Vec<String> {
    let result = lake
        .engine()
        .query(sql)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"));
    result
        .batches
        .iter()
        .flat_map(|batch| {
            // `CAST(… AS VARCHAR)` is a Utf8View in DataFusion 54.
            let column = cast(batch.column(0), &DataType::Utf8).expect("text");
            let column = column.as_any().downcast_ref::<StringArray>().expect("text");
            (0..column.len())
                .map(|row| column.value(row).to_owned())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Writes rows as data files of `table`'s current state, uncommitted.
async fn data_files(table: &Table, rows: &[Value]) -> Vec<iceberg::spec::DataFile> {
    let schema =
        Arc::new(schema_to_arrow_schema(table.metadata().current_schema()).expect("a schema"));
    let batch: RecordBatch = rows_to_batch(&schema, rows).expect("a batch");
    write_data_files(table, &[batch]).await.expect("data files")
}

#[tokio::test]
async fn creates_the_tables_once_with_global_s_columns_and_the_partitioning() {
    let lake = test_lake!();
    lake.lake
        .ensure_tables()
        .await
        .expect("again: nothing to do");
    for table in PanelTable::ALL {
        let loaded = lake.lake.load(table).await.expect("the table");
        let schema = loaded.metadata().current_schema();
        let names: Vec<&str> = schema
            .as_struct()
            .fields()
            .iter()
            .map(|f| f.name.as_str())
            .collect();
        let expected: Vec<&str> = table.columns().iter().map(|c| c.name).collect();
        assert_eq!(names, expected, "{}", table.name());
        let spec = loaded.metadata().default_partition_spec();
        let fields: Vec<String> = spec
            .fields()
            .iter()
            .map(|field| format!("{}:{}", field.name, field.transform))
            .collect();
        let want = match table.day_column() {
            Some(day) => vec!["workspace_id:identity".to_owned(), format!("{day}_day:day")],
            None => vec!["workspace_id:identity".to_owned()],
        };
        assert_eq!(fields, want, "{}", table.name());
    }
    let events = lake.lake.load(PanelTable::Events).await.expect("events");
    let ts = events
        .metadata()
        .current_schema()
        .field_by_name("ts")
        .expect("ts");
    assert_eq!(*ts.field_type, Type::Primitive(PrimitiveType::Timestamptz));
    assert!(ts.required);
}

#[tokio::test]
async fn appends_zstd_parquet_per_partition_and_remembers_the_stream_sequence() {
    let lake = test_lake!();
    assert_eq!(
        lake.lake
            .last_stream_seq(PanelTable::Events)
            .await
            .expect("seq"),
        None
    );
    let rows = events();
    let outcome = lake
        .lake
        .append_rows(PanelTable::Events, &rows, Some(10))
        .await
        .expect("an append")
        .expect("a commit");
    // Two workspaces × three days.
    assert_eq!(outcome.data_files.len(), 6);
    assert!(
        outcome
            .data_files
            .iter()
            .all(|path| path.contains("workspace_id=ws_") && path.contains("ts_day=2026-11-0"))
    );
    assert_eq!(
        lake.lake
            .last_stream_seq(PanelTable::Events)
            .await
            .expect("seq"),
        Some(10)
    );

    // zstd Parquet.
    let table = lake.lake.load(PanelTable::Events).await.expect("events");
    let bytes = table
        .file_io()
        .new_input(&outcome.data_files[0])
        .expect("an input")
        .read()
        .await
        .expect("the file");
    let reader = parquet::file::reader::SerializedFileReader::new(bytes).expect("parquet");
    let column = parquet::file::reader::FileReader::metadata(&reader)
        .row_group(0)
        .column(0)
        .compression();
    assert!(
        matches!(column, parquet::basic::Compression::ZSTD(_)),
        "{column:?}"
    );

    let more = rows_of(&rows, "ws_1", "2026-11-02");
    lake.lake
        .append_rows(PanelTable::Events, &more, Some(20))
        .await
        .expect("an append");
    assert_eq!(
        lake.lake
            .last_stream_seq(PanelTable::Events)
            .await
            .expect("seq"),
        Some(20)
    );
    let total = i64::try_from(rows.len() + more.len()).expect("a count");
    assert_eq!(
        count(&lake, "SELECT count(*) FROM panel.events_v1").await,
        total
    );
    assert!(
        lake.lake
            .append_rows(PanelTable::Events, &[], Some(30))
            .await
            .expect("nothing")
            .is_none()
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn a_replace_commit_has_the_right_manifests_summary_and_sequence_numbers() {
    let lake = test_lake!();
    let rows = events();
    lake.lake
        .append_rows(PanelTable::Events, &rows, Some(7))
        .await
        .expect("seed");
    let day = rows_of(&rows, "ws_1", "2026-11-01");
    lake.lake
        .append_rows(PanelTable::Events, &day[..4], None)
        .await
        .expect("a second file");

    let before = lake.lake.load(PanelTable::Events).await.expect("events");
    let parent = before
        .metadata()
        .current_snapshot()
        .expect("a snapshot")
        .clone();
    let target = live_files(&before)
        .await
        .expect("files")
        .into_iter()
        .find(|file| file.record_count() == 4)
        .expect("the small file");
    let target_path = target.file_path().to_owned();
    let remove = HashSet::from([target_path.clone()]);
    let batches = read_files(&before, &remove).await.expect("its rows");
    let add = write_data_files(&before, &batches).await.expect("a copy");
    let added_path = add[0].file_path().to_owned();
    let outcome = lake
        .lake
        .replace_files(
            PanelTable::Events,
            &ReplaceFiles {
                operation: Operation::Replace,
                remove,
                add,
            },
        )
        .await
        .expect("a replace");
    assert_eq!(outcome.attempts, 1);

    let after = lake.lake.load(PanelTable::Events).await.expect("events");
    let snapshot = after
        .metadata()
        .current_snapshot()
        .expect("the new snapshot");
    assert_eq!(snapshot.snapshot_id(), outcome.snapshot_id);
    assert_eq!(snapshot.parent_snapshot_id(), Some(parent.snapshot_id()));
    assert_eq!(snapshot.sequence_number(), parent.sequence_number() + 1);
    let summary = snapshot.summary();
    assert_eq!(summary.operation, Operation::Replace);
    let prop = |key: &str| {
        summary
            .additional_properties
            .get(key)
            .cloned()
            .unwrap_or_default()
    };
    assert_eq!(prop("added-data-files"), "1");
    assert_eq!(prop("deleted-data-files"), "1");
    assert_eq!(prop("added-records"), "4");
    assert_eq!(prop("deleted-records"), "4");
    assert_eq!(prop("total-data-files"), "7");
    assert_eq!(prop("total-records"), (rows.len() + 4).to_string());
    assert_eq!(prop(STREAM_SEQ_PROPERTY), "7");
    assert_eq!(
        prop("total-records"),
        parent.summary().additional_properties["total-records"]
    );

    // Manifests: the removed file DELETED with its old sequence numbers, the
    // copy ADDED at the new one, the rest carried over.
    let list = after
        .manifest_list_reader(snapshot)
        .load()
        .await
        .expect("the list");
    let mut seen = Vec::new();
    for manifest_file in list.entries() {
        let manifest = after
            .manifest_reader()
            .read(manifest_file)
            .await
            .expect("a manifest");
        for entry in manifest.entries() {
            seen.push((
                entry.file_path().to_owned(),
                entry.status(),
                entry.sequence_number(),
            ));
        }
    }
    let status_of = |path: &str| {
        seen.iter()
            .find(|(p, _, _)| p == path)
            .cloned()
            .expect("listed")
    };
    assert_eq!(status_of(&target_path).1, ManifestStatus::Deleted);
    assert_eq!(status_of(&target_path).2, Some(parent.sequence_number()));
    assert_eq!(status_of(&added_path).1, ManifestStatus::Added);
    assert_eq!(status_of(&added_path).2, Some(snapshot.sequence_number()));
    let live: Vec<_> = seen
        .iter()
        .filter(|(_, status, _)| *status != ManifestStatus::Deleted)
        .collect();
    assert_eq!(live.len(), 7);
    assert!(live.iter().all(|(_, _, seq)| seq.is_some()));

    // Same rows as before.
    let total = i64::try_from(rows.len() + 4).expect("a count");
    assert_eq!(
        count(&lake, "SELECT count(*) FROM panel.events_v1").await,
        total
    );
}

#[tokio::test]
async fn a_replace_that_loses_the_swap_to_an_append_starts_over_and_keeps_it() {
    let lake = test_lake!();
    let rows = events();
    lake.lake
        .append_rows(PanelTable::Events, &rows, Some(1))
        .await
        .expect("seed");
    let current = lake.lake.load(PanelTable::Events).await.expect("events");
    let victim = live_files(&current).await.expect("files")[0]
        .file_path()
        .to_owned();
    let newer = rows_of(&rows, "ws_2", "2026-11-03");
    let outcome = lake
        .lake
        .replace_files_with(
            PanelTable::Events,
            &ReplaceFiles {
                operation: Operation::Delete,
                remove: HashSet::from([victim.clone()]),
                add: Vec::new(),
            },
            |attempt| {
                let newer = newer.clone();
                let lake = &lake.lake;
                async move {
                    if attempt == 1 {
                        lake.append_rows(PanelTable::Events, &newer, Some(2))
                            .await?;
                    }
                    Ok(())
                }
            },
        )
        .await
        .expect("a replace");
    assert_eq!(outcome.attempts, 2);
    let after = lake.lake.load(PanelTable::Events).await.expect("events");
    let live: Vec<String> = live_files(&after)
        .await
        .expect("files")
        .iter()
        .map(|file| file.file_path().to_owned())
        .collect();
    assert!(!live.contains(&victim));
    // The six files of the seed, less one, plus the append's.
    assert_eq!(live.len(), 6);
    assert_eq!(
        lake.lake
            .last_stream_seq(PanelTable::Events)
            .await
            .expect("seq"),
        Some(2)
    );
}

#[tokio::test]
async fn an_append_prepared_before_a_replace_commits_on_top_of_it() {
    let lake = test_lake!();
    let rows = events();
    lake.lake
        .append_rows(PanelTable::Events, &rows, Some(1))
        .await
        .expect("seed");
    let stale = lake.lake.load(PanelTable::Events).await.expect("events");
    let victim = live_files(&stale).await.expect("files")[0].clone();
    let newer = rows_of(&rows, "ws_1", "2026-11-03");
    let files = data_files(&stale, &newer).await;
    let tx = Transaction::new(&stale);
    let tx = tx
        .fast_append()
        .add_data_files(files)
        .apply(tx)
        .expect("an append");

    lake.lake
        .replace_files(
            PanelTable::Events,
            &ReplaceFiles {
                operation: Operation::Delete,
                remove: HashSet::from([victim.file_path().to_owned()]),
                add: Vec::new(),
            },
        )
        .await
        .expect("a replace");
    tx.commit(lake.lake.catalog())
        .await
        .expect("the append, retried on top");

    let after = lake.lake.load(PanelTable::Events).await.expect("events");
    let live = live_files(&after).await.expect("files");
    assert!(
        live.iter()
            .all(|file| file.file_path() != victim.file_path())
    );
    let expected = rows.len() + newer.len() - usize::try_from(victim.record_count()).expect("rows");
    assert_eq!(
        count(&lake, "SELECT count(*) FROM panel.events_v1").await,
        i64::try_from(expected).expect("a count")
    );
}

#[tokio::test]
async fn a_replace_refuses_a_file_that_is_no_longer_live() {
    let lake = test_lake!();
    lake.lake
        .append_rows(PanelTable::Events, &events(), None)
        .await
        .expect("seed");
    let before = lake.lake.load(PanelTable::Events).await.expect("events");
    let error = lake
        .lake
        .replace_files(
            PanelTable::Events,
            &ReplaceFiles {
                operation: Operation::Delete,
                remove: HashSet::from(["file:/nowhere/x.parquet".to_owned()]),
                add: Vec::new(),
            },
        )
        .await
        .expect_err("a conflict");
    assert!(matches!(error, LakehouseError::Conflict(_)), "{error}");
    let after = lake.lake.load(PanelTable::Events).await.expect("events");
    assert_eq!(after.metadata_location(), before.metadata_location());
}

#[tokio::test]
async fn compaction_bin_packs_one_partition_and_keeps_its_rows() {
    let lake = test_lake!();
    let rows = events();
    let day = rows_of(&rows, "ws_1", "2026-11-01");
    for chunk in day.chunks(8) {
        lake.lake
            .append_rows(PanelTable::Events, chunk, None)
            .await
            .expect("a small file");
    }
    let other = rows_of(&rows, "ws_1", "2026-11-02");
    for chunk in other.chunks(8) {
        lake.lake
            .append_rows(PanelTable::Events, chunk, None)
            .await
            .expect("a small file");
    }
    let ids = "SELECT event_id FROM panel.events_v1 WHERE workspace_id = 'ws_1' ORDER BY event_id";
    let before = strings(&lake, ids).await;
    let groups = partitions(&lake.lake, PanelTable::Events)
        .await
        .expect("partitions");
    assert_eq!(groups[&("ws_1".to_owned(), Some(NOV_1))].len(), 3);

    let outcome = lake
        .lake
        .compact_partition(PanelTable::Events, "ws_1", Some(NOV_1))
        .await
        .expect("a compaction")
        .expect("something to do");
    assert_eq!(outcome.attempts, 1);
    let groups = partitions(&lake.lake, PanelTable::Events)
        .await
        .expect("partitions");
    assert_eq!(groups[&("ws_1".to_owned(), Some(NOV_1))].len(), 1);
    assert_eq!(groups[&("ws_1".to_owned(), Some(NOV_1 + 1))].len(), 3);
    assert_eq!(strings(&lake, ids).await, before);
    let snapshot = lake.lake.load(PanelTable::Events).await.expect("events");
    assert_eq!(
        snapshot
            .metadata()
            .current_snapshot()
            .expect("a snapshot")
            .summary()
            .operation,
        Operation::Replace
    );
    // One file left: nothing more to do.
    assert!(
        lake.lake
            .compact_partition(PanelTable::Events, "ws_1", Some(NOV_1))
            .await
            .expect("nothing")
            .is_none()
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn erasure_rewrites_one_workspace_without_the_person_s_rows() {
    let lake = test_lake!();
    lake.seed().await;
    let ids = HashSet::from(["u-1".to_owned(), "a-1".to_owned()]);
    let person =
        "(distinct_id IN ('u-1', 'a-1') OR anon_id IN ('u-1', 'a-1') OR user_id IN ('u-1', 'a-1'))";
    let ws1_before = count(
        &lake,
        "SELECT count(*) FROM panel.events_v1 WHERE workspace_id = 'ws_1'",
    )
    .await;
    let ws1_person = count(
        &lake,
        &format!("SELECT count(*) FROM panel.events_v1 WHERE workspace_id = 'ws_1' AND {person}"),
    )
    .await;
    let ws2_person = count(
        &lake,
        &format!("SELECT count(*) FROM panel.events_v1 WHERE workspace_id = 'ws_2' AND {person}"),
    )
    .await;
    assert!(ws1_person > 0 && ws2_person > 0);

    let outcome = lake
        .lake
        .erase(
            PanelTable::Events,
            "ws_1",
            &["distinct_id", "anon_id", "user_id"],
            &ids,
        )
        .await
        .expect("an erasure")
        .expect("rows to erase");
    assert_eq!(outcome.attempts, 1);
    lake.lake
        .erase(PanelTable::People, "ws_1", &["user_id"], &ids)
        .await
        .expect("people")
        .expect("a person");
    lake.lake
        .erase(
            PanelTable::Identities,
            "ws_1",
            &["anon_id", "user_id"],
            &ids,
        )
        .await
        .expect("identities")
        .expect("a link");

    assert_eq!(
        count(
            &lake,
            &format!(
                "SELECT count(*) FROM panel.events_v1 WHERE workspace_id = 'ws_1' AND {person}"
            )
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &lake,
            "SELECT count(*) FROM panel.events_v1 WHERE workspace_id = 'ws_1'"
        )
        .await,
        ws1_before - ws1_person
    );
    assert_eq!(
        count(
            &lake,
            &format!(
                "SELECT count(*) FROM panel.events_v1 WHERE workspace_id = 'ws_2' AND {person}"
            )
        )
        .await,
        ws2_person
    );
    assert_eq!(
        count(
            &lake,
            "SELECT count(*) FROM panel.people_v1 WHERE workspace_id = 'ws_1' AND user_id = 'u-1'"
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &lake,
            "SELECT count(*) FROM panel.people_v1 WHERE workspace_id = 'ws_1'"
        )
        .await,
        4
    );
    assert_eq!(
        count(
            &lake,
            "SELECT count(*) FROM panel.people_v1 WHERE workspace_id = 'ws_2' AND user_id = 'u-1'"
        )
        .await,
        2
    );
    assert_eq!(
        count(
            &lake,
            "SELECT count(*) FROM panel.identities_v1 WHERE workspace_id = 'ws_1'"
        )
        .await,
        2
    );
    // Erased already: nothing left to do.
    assert!(
        lake.lake
            .erase(
                PanelTable::Events,
                "ws_1",
                &["distinct_id", "anon_id", "user_id"],
                &ids
            )
            .await
            .expect("nothing")
            .is_none()
    );
}

#[tokio::test]
async fn retention_drops_one_workspace_s_old_days() {
    let lake = test_lake!();
    lake.seed().await;
    let outcome = lake
        .lake
        .drop_days_before(PanelTable::Events, "ws_1", NOV_3)
        .await
        .expect("retention")
        .expect("days to drop");
    assert_eq!(outcome.attempts, 1);
    lake.lake
        .drop_days_before(PanelTable::ReplayChunks, "ws_1", NOV_3)
        .await
        .expect("chunks")
        .expect("days to drop");
    let days = |table: &str, column: &str, workspace: &str| {
        format!(
            "SELECT DISTINCT CAST(date_trunc('day', {column}) AS VARCHAR) FROM panel.{table} WHERE workspace_id = '{workspace}' ORDER BY 1"
        )
    };
    assert_eq!(
        strings(&lake, &days("events_v1", "ts", "ws_1")).await.len(),
        1
    );
    assert_eq!(
        strings(&lake, &days("events_v1", "ts", "ws_2")).await.len(),
        3
    );
    assert_eq!(
        strings(&lake, &days("replay_chunks_v1", "ts_start", "ws_1"))
            .await
            .len(),
        1
    );
    let summary = lake.lake.load(PanelTable::Events).await.expect("events");
    assert_eq!(
        summary
            .metadata()
            .current_snapshot()
            .expect("a snapshot")
            .summary()
            .operation,
        Operation::Delete
    );
    assert!(
        lake.lake
            .drop_days_before(PanelTable::People, "ws_1", NOV_3)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn expiry_deletes_the_files_no_remaining_snapshot_references() {
    let lake = test_lake!();
    let rows = events();
    let day = rows_of(&rows, "ws_1", "2026-11-01");
    for (index, chunk) in day.chunks(8).enumerate() {
        lake.lake
            .append_rows(
                PanelTable::Events,
                chunk,
                Some(u64::try_from(index).expect("seq") + 100),
            )
            .await
            .expect("a small file");
    }
    lake.lake
        .append_rows(
            PanelTable::Events,
            &rows_of(&rows, "ws_2", "2026-11-01"),
            Some(200),
        )
        .await
        .expect("ws_2");
    let small: Vec<String> = live_files(&lake.lake.load(PanelTable::Events).await.expect("events"))
        .await
        .expect("files")
        .iter()
        .map(|file| file.file_path().to_owned())
        .collect();
    lake.lake
        .compact_partition(PanelTable::Events, "ws_1", Some(NOV_1))
        .await
        .expect("compaction")
        .expect("something to do");
    lake.lake
        .erase(
            PanelTable::Events,
            "ws_2",
            &["distinct_id"],
            &HashSet::from(["u-2".to_owned()]),
        )
        .await
        .expect("erasure")
        .expect("rows to erase");
    let expected = count(&lake, "SELECT count(*) FROM panel.events_v1").await;
    let table = lake.lake.load(PanelTable::Events).await.expect("events");
    let snapshots_before = table.metadata().snapshots().len();
    assert_eq!(snapshots_before, 6);

    let future = 4_102_444_800_000; // 2100-01-01: everything is older.
    let outcome = lake
        .lake
        .expire_snapshots(PanelTable::Events, future, 1)
        .await
        .expect("expiry");
    assert_eq!(outcome.expired_snapshots, 5);
    let after = lake.lake.load(PanelTable::Events).await.expect("events");
    assert_eq!(after.metadata().snapshots().len(), 1);
    // The compacted and erased files are gone from storage, the live ones stay.
    for path in &small {
        assert!(outcome.deleted_files.contains(path), "{path} not deleted");
        assert!(
            !after.file_io().exists(path).await.expect("exists"),
            "{path} still there"
        );
    }
    for file in live_files(&after).await.expect("files") {
        assert!(
            after
                .file_io()
                .exists(file.file_path())
                .await
                .expect("exists")
        );
    }
    assert!(
        outcome
            .deleted_files
            .iter()
            .any(|path| path.contains("/snap-"))
    );
    assert!(
        outcome
            .deleted_files
            .iter()
            .any(|path| path.ends_with("-m0.avro") || path.ends_with("-m1.avro"))
    );
    assert_eq!(
        count(&lake, "SELECT count(*) FROM panel.events_v1").await,
        expected
    );
    // The stream sequence survives: the replace commits carried it forward.
    assert_eq!(
        lake.lake
            .last_stream_seq(PanelTable::Events)
            .await
            .expect("seq"),
        Some(200)
    );
    // Nothing more to expire.
    let again = lake
        .lake
        .expire_snapshots(PanelTable::Events, future, 1)
        .await
        .expect("expiry");
    assert_eq!(again, crate::ExpireOutcome::default());
}
