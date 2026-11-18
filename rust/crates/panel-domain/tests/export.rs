//! The raw-export reader: the port of
//! `packages/domains/panel/src/query/export.test.ts` (isolation, literals
//! only, keyset paging that neither skips nor repeats rows sharing a second).

use serde_json::{Map, Value, json};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::PanelQueryContext;
use weldsuite_panel_domain::query::export::{
    ExportCursor, ExportKey, ExportPageInput, PANEL_EXPORT_PAGE_SIZE, PANEL_EXPORT_TABLE_NAMES,
    PanelExportTableName, exact_timestamp, exact_timestamp_millis, export_columns,
    export_cursor_of, export_page_query,
};

fn ctx() -> PanelQueryContext {
    PanelQueryContext {
        workspace_id: "ws_1".to_owned(),
        project_id: "pnp_1".to_owned(),
        retention_days: 365.0,
        has_identified_users: true,
        erased_ids: Vec::new(),
        now: js::parse_iso("2026-11-14T12:00:00Z"),
        ..PanelQueryContext::default()
    }
}

fn from() -> i64 {
    js::parse_iso("2026-11-14T10:00:00Z").expect("an instant")
}

fn to() -> i64 {
    js::parse_iso("2026-11-14T11:00:00Z").expect("an instant")
}

fn page(table: PanelExportTableName) -> ExportPageInput {
    ExportPageInput {
        table,
        from: from(),
        to: to(),
        after: None,
        limit: None,
    }
}

fn sql(context: &PanelQueryContext, input: &ExportPageInput) -> String {
    export_page_query(context, input).expect("a page").sql
}

fn row(value: &Value) -> Map<String, Value> {
    value.as_object().expect("a row").clone()
}

#[test]
fn every_table_is_scoped_to_the_workspace_the_project_and_the_window() {
    for table in PANEL_EXPORT_TABLE_NAMES {
        let query = export_page_query(&ctx(), &page(table)).expect("a page");
        assert!(query.sql.contains("workspace_id = 'ws_1'"));
        assert!(query.sql.contains("project_id = 'pnp_1'"));
        assert!(query.sql.contains("TIMESTAMP '2026-11-14 10:00:00.000'"));
        assert!(query.sql.contains("TIMESTAMP '2026-11-14 11:00:00.000'"));
        assert!(
            query
                .sql
                .contains(&format!("FROM panel.{}_v1 ", table.as_str()))
        );
        assert!(
            query
                .sql
                .contains(&format!("LIMIT {PANEL_EXPORT_PAGE_SIZE}"))
        );
        assert!(!query.sql.to_uppercase().contains("OFFSET"));
        // The workspace is never exported as a column.
        assert!(!query.columns.iter().any(|c| c == "workspace_id"));
        assert_eq!(query.columns, export_columns(table));
    }
}

#[test]
fn reads_events_by_arrival_and_the_other_tables_by_their_own_time() {
    assert!(
        sql(&ctx(), &page(PanelExportTableName::Events))
            .contains("received_at >= TIMESTAMP '2026-11-14 10:00:00.000' AND received_at < ")
    );
    assert!(
        sql(&ctx(), &page(PanelExportTableName::People))
            .contains("ts >= TIMESTAMP '2026-11-14 10:00:00.000' AND ts < ")
    );
}

#[test]
fn leaves_erased_people_out_of_events_people_and_identities() {
    let erased = PanelQueryContext {
        erased_ids: vec![
            "user_gone".to_owned(),
            "anon_gone".to_owned(),
            "user_gone".to_owned(),
        ],
        ..ctx()
    };
    let events = sql(&erased, &page(PanelExportTableName::Events));
    assert!(events.contains("anon_id NOT IN ('user_gone', 'anon_gone')"));
    assert!(events.contains("distinct_id NOT IN ('user_gone', 'anon_gone')"));
    assert!(events.contains("COALESCE(user_id, '') NOT IN ('user_gone', 'anon_gone')"));
    assert!(
        sql(&erased, &page(PanelExportTableName::People))
            .contains("user_id NOT IN ('user_gone', 'anon_gone')")
    );
    let identities = sql(&erased, &page(PanelExportTableName::Identities));
    assert!(identities.contains("anon_id NOT IN ('user_gone', 'anon_gone')"));
    assert!(identities.contains("user_id NOT IN ('user_gone', 'anon_gone')"));
    assert!(!sql(&erased, &page(PanelExportTableName::Groups)).contains("NOT IN"));
}

#[test]
fn quotes_ids_from_the_context_and_the_cursor() {
    let evil = PanelQueryContext {
        workspace_id: "ws' OR '1'='1".to_owned(),
        erased_ids: vec!["x') OR (1=1".to_owned()],
        ..ctx()
    };
    let input = ExportPageInput {
        after: Some(ExportCursor {
            time: "2026-11-14 10:30:00.123456".to_owned(),
            keys: vec![ExportKey::Text("evt' OR 1=1 --".to_owned())],
        }),
        ..page(PanelExportTableName::Events)
    };
    let text = sql(&evil, &input);
    assert!(text.contains("workspace_id = 'ws'' OR ''1''=''1'"));
    assert!(text.contains("'x'') OR (1=1'"));
    assert!(text.contains("event_id > 'evt'' OR 1=1 --'"));
}

#[test]
fn refuses_a_window_over_an_hour_an_empty_one_and_too_many_erasures() {
    let long = ExportPageInput {
        to: from() + 3_600_001,
        ..page(PanelExportTableName::Events)
    };
    assert!(export_page_query(&ctx(), &long).is_err());
    let empty = ExportPageInput {
        to: from(),
        ..page(PanelExportTableName::Events)
    };
    assert!(export_page_query(&ctx(), &empty).is_err());
    let many = PanelQueryContext {
        erased_ids: (0..5001).map(|i| format!("u{i}")).collect(),
        ..ctx()
    };
    assert!(export_page_query(&many, &page(PanelExportTableName::People)).is_err());
}

#[test]
fn starts_after_the_last_row_keeping_its_fractional_seconds() {
    let cursor = export_cursor_of(
        PanelExportTableName::Events,
        &row(&json!({ "received_at": "2026-11-14T10:30:00.123456Z", "event_id": "evt_9" })),
    );
    assert_eq!(
        cursor,
        ExportCursor {
            time: "2026-11-14T10:30:00.123456Z".to_owned(),
            keys: vec![ExportKey::Text("evt_9".to_owned())],
        }
    );
    let text = sql(
        &ctx(),
        &ExportPageInput {
            after: Some(cursor),
            ..page(PanelExportTableName::Events)
        },
    );
    assert!(text.contains(
        "(received_at > TIMESTAMP '2026-11-14 10:30:00.123456' OR (received_at = TIMESTAMP '2026-11-14 10:30:00.123456' AND event_id > 'evt_9'))"
    ));
    assert!(text.contains("ORDER BY received_at ASC, event_id ASC"));
}

#[test]
fn nests_every_tie_break_column_in_order_numbers_as_numbers() {
    let cursor = export_cursor_of(
        PanelExportTableName::Groups,
        &row(
            &json!({ "ts": "2026-11-14 10:00:05", "group_type": "company", "group_key": "acme", "version": "7" }),
        ),
    );
    assert_eq!(
        cursor.keys,
        [
            ExportKey::Text("company".to_owned()),
            ExportKey::Text("acme".to_owned()),
            ExportKey::Number(7.0)
        ]
    );
    let text = sql(
        &ctx(),
        &ExportPageInput {
            after: Some(cursor),
            ..page(PanelExportTableName::Groups)
        },
    );
    assert!(text.contains(
        "(ts > TIMESTAMP '2026-11-14 10:00:05' OR (ts = TIMESTAMP '2026-11-14 10:00:05' AND (group_type > 'company' OR (group_type = 'company' AND (group_key > 'acme' OR (group_key = 'acme' AND version > 7))))))"
    ));
}

#[test]
fn refuses_a_cursor_that_is_not_a_utc_timestamp_or_does_not_fit_the_table() {
    let after = |table, time: &str, keys: Vec<ExportKey>| ExportPageInput {
        after: Some(ExportCursor {
            time: time.to_owned(),
            keys,
        }),
        ..page(table)
    };
    let text = |s: &str| ExportKey::Text(s.to_owned());
    assert!(
        export_page_query(
            &ctx(),
            &after(
                PanelExportTableName::Events,
                "2026-11-14'; DROP",
                vec![text("a")]
            )
        )
        .is_err()
    );
    assert!(
        export_page_query(
            &ctx(),
            &after(
                PanelExportTableName::Events,
                "2026-11-14T10:00:00+02:00",
                vec![text("a")]
            )
        )
        .is_err()
    );
    assert!(
        export_page_query(
            &ctx(),
            &after(
                PanelExportTableName::People,
                "2026-11-14T10:00:00Z",
                vec![text("a")]
            )
        )
        .is_err()
    );
    assert!(
        export_page_query(
            &ctx(),
            &after(
                PanelExportTableName::People,
                "2026-11-14T10:00:00Z",
                vec![text("a"), ExportKey::Number(f64::NAN)]
            )
        )
        .is_err()
    );
}

#[test]
fn writes_dates_and_epoch_millis_as_exact_literals() {
    let half = js::parse_iso("2026-11-14T10:00:00.5Z").expect("an instant");
    assert_eq!(
        exact_timestamp_millis(half).expect("literal"),
        "TIMESTAMP '2026-11-14 10:00:00.500'"
    );
    assert_eq!(
        exact_timestamp_millis(js::date_utc(2026, 10, 14) + 10 * 3_600_000).expect("literal"),
        "TIMESTAMP '2026-11-14 10:00:00.000'"
    );
    assert_eq!(
        exact_timestamp("2026-11-14 10:00:00").expect("literal"),
        "TIMESTAMP '2026-11-14 10:00:00'"
    );
}
