//! The SQL corpus (`packages/domains/panel/src/query/__corpus__/sql-corpus.json`,
//! README next to it): every `compiler` entry's input compiled again here
//! must give the TypeScript's statements byte for byte, in the same order,
//! with the same names and columns.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{Map, Value};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::activity::{
    ActivityOptions, activity_count_query, activity_query, lexicon_queries,
};
use weldsuite_panel_domain::query::explain::explain_statements;
use weldsuite_panel_domain::query::export::{
    ExportCursor, ExportPageInput, PanelExportTableName, export_page_query,
};
use weldsuite_panel_domain::query::{
    EngineError, PanelQueryContext, PanelSqlQuery, PanelSqlResult, run_panel_query,
    stable_stringify,
};
use weldsuite_panel_domain::schemas::{ExplainPanelChange, PanelQuerySpec};

#[derive(Deserialize)]
struct CorpusFile {
    version: u32,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    id: String,
    source: String,
    input: Option<Value>,
    statements: Vec<PanelSqlQuery>,
}

fn corpus() -> CorpusFile {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/domains/panel/src/query/__corpus__/sql-corpus.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

fn field<T: for<'de> Deserialize<'de>>(input: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(input.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|err| format!("`{key}`: {err}"))
}

#[derive(Deserialize)]
struct ExportPage {
    table: PanelExportTableName,
    from: String,
    to: String,
    #[serde(default)]
    after: Option<ExportCursor>,
    #[serde(default)]
    limit: Option<i64>,
}

/// The statements an input compiles to, in the order they are sent.
async fn compile(input: &Value) -> Result<Vec<PanelSqlQuery>, String> {
    let call = input
        .get("call")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let ctx: PanelQueryContext = field(input, "context")?;
    let refused = |err: weldsuite_panel_domain::query::PanelQueryError| format!("refused: {err}");
    match call {
        "runPanelQuery" => {
            let spec: PanelQuerySpec = field(input, "spec")?;
            let responses: Map<String, Value> = field(input, "responses")?;
            // The parsed spec must serialize back to what Zod's parse gave
            // (the cache key hashes it).
            let raw = input.get("spec").cloned().unwrap_or(Value::Null);
            let typed = serde_json::to_value(&spec).map_err(|err| err.to_string())?;
            if stable_stringify(&raw) != stable_stringify(&typed) {
                return Err(format!(
                    "the typed spec does not write back the parsed spec:\n  ts:   {}\n  rust: {}",
                    stable_stringify(&raw),
                    stable_stringify(&typed)
                ));
            }
            let sent = Mutex::new(Vec::new());
            let executor = |query: PanelSqlQuery| {
                let rows = responses
                    .get(&query.name)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                sent.lock().expect("not poisoned").push(query);
                async move {
                    Ok::<_, EngineError>(PanelSqlResult {
                        rows,
                        bytes_scanned: None,
                    })
                }
            };
            run_panel_query(&spec, &ctx, &executor)
                .await
                .map_err(|err| format!("refused: {err}"))?;
            Ok(sent.into_inner().expect("not poisoned"))
        }
        "activityQuery" => {
            let options: ActivityOptions = field(input, "options")?;
            Ok(vec![activity_query(&ctx, &options).map_err(refused)?])
        }
        "activityCountQuery" => {
            let distinct_id: String = field(input, "distinctId")?;
            let days: i64 = field(input, "days")?;
            Ok(vec![
                activity_count_query(&ctx, &distinct_id, days).map_err(refused)?,
            ])
        }
        "lexiconQueries" => lexicon_queries(&ctx).map_err(refused),
        "exportPageQuery" => {
            let page: ExportPage = field(input, "page")?;
            let instant =
                |text: &str| js::parse_iso(text).ok_or_else(|| format!("not an instant: {text}"));
            let page = ExportPageInput {
                table: page.table,
                from: instant(&page.from)?,
                to: instant(&page.to)?,
                after: page.after,
                limit: page.limit,
            };
            Ok(vec![export_page_query(&ctx, &page).map_err(refused)?])
        }
        "explain" => {
            let request: ExplainPanelChange = field(input, "request")?;
            explain_statements(&request, &ctx).map_err(refused)
        }
        other => Err(format!("unknown call `{other}`")),
    }
}

/// Where two texts first differ, with some context.
fn text_diff(expected: &str, actual: &str) -> String {
    let at = expected
        .char_indices()
        .zip(actual.chars())
        .find(|((_, e), a)| e != a)
        .map_or_else(|| expected.len().min(actual.len()), |((i, _), _)| i);
    let window = |text: &str| {
        let start = text[..at.min(text.len())]
            .char_indices()
            .rev()
            .nth(80)
            .map_or(0, |(i, _)| i);
        let end = text[at.min(text.len())..]
            .char_indices()
            .nth(80)
            .map_or(text.len(), |(i, _)| at.min(text.len()) + i);
        format!(
            "…{}⟦{}⟧…",
            &text[start..at.min(text.len())],
            &text[at.min(text.len())..end]
        )
    };
    format!(
        "first difference at byte {at} (lengths {} / {}):\n      ts:   {}\n      rust: {}",
        expected.len(),
        actual.len(),
        window(expected),
        window(actual)
    )
}

fn statement_diffs(expected: &[PanelSqlQuery], actual: &[PanelSqlQuery]) -> Vec<String> {
    let mut out = Vec::new();
    let names = |list: &[PanelSqlQuery]| list.iter().map(|q| q.name.clone()).collect::<Vec<_>>();
    if names(expected) != names(actual) {
        out.push(format!(
            "statements differ:\n      ts:   {:?}\n      rust: {:?}",
            names(expected),
            names(actual)
        ));
    }
    for (e, a) in expected.iter().zip(actual) {
        if e.columns != a.columns {
            out.push(format!(
                "{}: columns differ:\n      ts:   {:?}\n      rust: {:?}",
                e.name, e.columns, a.columns
            ));
        }
        if e.sql != a.sql {
            out.push(format!(
                "{}: sql differs, {}",
                e.name,
                text_diff(&e.sql, &a.sql)
            ));
        }
    }
    out
}

#[tokio::test(flavor = "current_thread")]
async fn compiles_every_corpus_input_to_the_same_statements() {
    let file = corpus();
    assert_eq!(file.version, 1, "corpus version");
    let compiler: Vec<&Entry> = file
        .entries
        .iter()
        .filter(|e| e.source == "compiler")
        .collect();
    assert!(!compiler.is_empty(), "no compiler entries");

    let mut failures = Vec::new();
    for entry in &compiler {
        let input = entry.input.as_ref().expect("a compiler entry has an input");
        match compile(input).await {
            Ok(actual) => {
                let diffs = statement_diffs(&entry.statements, &actual);
                if !diffs.is_empty() {
                    failures.push(format!("{}\n    {}", entry.id, diffs.join("\n    ")));
                }
            }
            Err(err) => failures.push(format!("{}\n    {err}", entry.id)),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} compiler entries differ from the TypeScript:\n\n{}",
        failures.len(),
        compiler.len(),
        failures.join("\n\n")
    );
    println!("{} compiler entries identical", compiler.len());
}
