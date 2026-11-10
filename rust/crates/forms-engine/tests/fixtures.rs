//! The shared fixtures of `@weldsuite/forms-engine`
//! (`packages/core/forms-engine/fixtures`), the same files its
//! `src/fixtures.test.ts` runs, so both backends decide alike:
//!
//! - `fixtures/*.json`: the definition parses; each case's
//!   `evaluate_submission` result is exactly `expect`, and `compute_path`
//!   gives the same path, ending and variables; the optional `recall`,
//!   `display` and `searchText` cases give exactly their `expect` text.
//! - `fixtures/invalid/*.json`: `parse_definition` fails with exactly the
//!   issue codes of `expectIssues` (compared sorted), and with exactly the
//!   issues of the optional `expectDetails` (code, path and message, in
//!   order); together the files cover every issue code.
//!
//! Results are compared as JSON after serialising them as the TypeScript
//! result serialises (whole numbers as integers, absent keys left out).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use weldsuite_forms_engine::{
    EngineInput, IssueCode, RecallContext, compute_path, display_answer, evaluate_submission,
    find_field, parse_definition, recall, search_text,
};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/core/forms-engine/fixtures")
}

/// The `.json` files of a directory, sorted by name.
fn json_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("reading {}: {err}", dir.display()))
        .map(|entry| entry.expect("a directory entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("reading {}: {err}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("{} is not JSON: {err}", path.display()))
}

fn name_of(path: &Path) -> String {
    path.file_name().unwrap().to_string_lossy().into_owned()
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

/// Compares and records a mismatch.
fn expect_eq(failures: &mut Vec<String>, what: &str, got: &Value, want: &Value) {
    if got != want {
        failures.push(format!(
            "{what}\n  got:  {}\n  want: {}",
            serde_json::to_string(got).unwrap(),
            serde_json::to_string(want).unwrap()
        ));
    }
}

#[test]
fn fixtures() {
    let files = json_files(&fixtures_dir());
    assert!(
        files.len() >= 10,
        "at least ten fixture files, found {}",
        files.len()
    );

    let mut failures = Vec::new();
    let mut checked = 0;
    for path in &files {
        let file = name_of(path);
        let fixture = read_json(path);
        let def = match parse_definition(&fixture["definition"]) {
            Ok(def) => def,
            Err(issues) => {
                failures.push(format!(
                    "{file}: the definition is invalid: {}",
                    serde_json::to_string(&issues).unwrap()
                ));
                continue;
            }
        };

        for case in fixture["cases"].as_array().expect("cases") {
            let what = format!("{file}: {}", text(&case["name"]));
            let input = EngineInput {
                answers: object(case.get("answers")),
                hidden: object(case.get("hidden")),
            };
            let want = &case["expect"];
            let result = serde_json::to_value(evaluate_submission(&def, input)).unwrap();
            expect_eq(&mut failures, &what, &result, want);
            let path_result = serde_json::to_value(compute_path(&def, input)).unwrap();
            let want_path = json!({
                "path": want["path"],
                "endingId": want["endingId"],
                "variables": want["variables"],
            });
            expect_eq(
                &mut failures,
                &format!("{what} (computePath)"),
                &path_result,
                &want_path,
            );
            checked += 1;
        }

        for case in fixture
            .get("recall")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let ctx = RecallContext {
                answers: object(case.get("answers")),
                hidden: object(case.get("hidden")),
                variables: object(case.get("variables")),
            };
            let encode = case.get("encode").and_then(Value::as_bool).unwrap_or(false);
            let got = recall(text(&case["text"]), &def, ctx, encode);
            let what = format!("{file}: recall: {}", text(&case["name"]));
            expect_eq(&mut failures, &what, &Value::from(got), &case["expect"]);
            checked += 1;
        }

        for case in fixture
            .get("display")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let what = format!("{file}: display: {}", text(&case["name"]));
            let field_id = text(&case["fieldId"]);
            let Some(field) = find_field(&def, field_id) else {
                failures.push(format!("{what}: no field {field_id}"));
                continue;
            };
            let got = display_answer(field, case.get("value"));
            expect_eq(&mut failures, &what, &Value::from(got), &case["expect"]);
            checked += 1;
        }

        for case in fixture
            .get("searchText")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let what = format!("{file}: searchText: {}", text(&case["name"]));
            let empty = Map::new();
            let got = search_text(&def, object(case.get("answers")).unwrap_or(&empty));
            expect_eq(&mut failures, &what, &Value::from(got), &case["expect"]);
            checked += 1;
        }
    }

    assert!(
        failures.is_empty(),
        "{} fixture case(s) differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(checked > 0, "no fixture cases ran");
}

#[test]
fn invalid_fixtures() {
    let files = json_files(&fixtures_dir().join("invalid"));
    assert!(!files.is_empty(), "no invalid fixtures");

    let mut failures = Vec::new();
    for path in &files {
        let fixture = read_json(path);
        let what = format!("{}: {}", name_of(path), text(&fixture["name"]));
        let issues = parse_definition(&fixture["definition"])
            .err()
            .unwrap_or_default();
        if let Some(details) = fixture.get("expectDetails") {
            let got_details: Vec<Value> = issues
                .iter()
                .map(|issue| {
                    json!({ "code": issue.code.as_str(), "path": issue.path, "message": issue.message })
                })
                .collect();
            expect_eq(
                &mut failures,
                &format!("{what} (details)"),
                &Value::from(got_details),
                details,
            );
        }
        let mut got: Vec<String> = issues
            .iter()
            .map(|issue| issue.code.as_str().to_owned())
            .collect();
        got.sort();
        let mut want: Vec<String> = fixture["expectIssues"]
            .as_array()
            .expect("expectIssues")
            .iter()
            .map(|code| text(code).to_owned())
            .collect();
        want.sort();
        expect_eq(&mut failures, &what, &json!(got), &json!(want));
    }
    assert!(
        failures.is_empty(),
        "{} invalid fixture(s) differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn invalid_fixtures_cover_every_issue_code() {
    let covered: BTreeSet<String> = json_files(&fixtures_dir().join("invalid"))
        .iter()
        .flat_map(|path| {
            read_json(path)["expectIssues"]
                .as_array()
                .expect("expectIssues")
                .iter()
                .map(|code| text(code).to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    let all = [
        IssueCode::Schema,
        IssueCode::DuplicateId,
        IssueCode::DuplicateRef,
        IssueCode::DuplicateHidden,
        IssueCode::DuplicateVariable,
        IssueCode::ReservedVariable,
        IssueCode::UnknownBlock,
        IssueCode::UnknownEnding,
        IssueCode::UnknownField,
        IssueCode::UnknownRow,
        IssueCode::UnknownPart,
        IssueCode::UnknownHidden,
        IssueCode::UnknownVariable,
        IssueCode::VariableType,
        IssueCode::LogicOnPageBreak,
        IssueCode::DuplicateLogic,
        IssueCode::BackwardJump,
        IssueCode::OperandAfterSource,
        IssueCode::OperatorMismatch,
        IssueCode::SelectionRange,
        IssueCode::NumberRange,
        IssueCode::DateRange,
    ];
    let missing: Vec<&str> = all
        .iter()
        .map(|code| code.as_str())
        .filter(|code| !covered.contains(*code))
        .collect();
    assert!(
        missing.is_empty(),
        "issue codes without an invalid fixture: {missing:?}"
    );
}

/// The definition the engine works on has Zod's defaults filled in, and
/// serialises back to what `formDefinitionSchema.parse` returns.
#[test]
fn a_parsed_definition_carries_the_schemas_defaults() {
    let def = parse_definition(&json!({
        "blocks": [
            { "id": "b_1", "ref": "name", "type": "short_text", "title": "Name" },
            { "id": "b_2", "ref": "rate", "type": "opinion_scale", "title": "Rate", "properties": { "end": 5.0 } },
            { "id": "b_3", "ref": "who", "type": "contact_info", "title": "Who", "properties": { "fields": { "phone": { "enabled": false, "required": false } } } },
            { "id": "b_4", "ref": "brk", "type": "page_break" },
        ],
        "endings": [{ "id": "e_1", "ref": "end", "title": "Done" }],
        "variables": [{ "name": "total", "type": "number" }],
        "logic": [{ "blockId": "b_1", "calculations": [{ "id": "x_1", "variable": "total", "op": "set", "value": { "type": "constant", "value": 2 } }] }],
    }))
    .expect("a valid definition");
    let value = serde_json::to_value(&def).unwrap();
    assert_eq!(
        value,
        json!({
            "schemaVersion": 1,
            "presentation": { "layout": "conversational", "language": "en", "progressBar": "percentage", "showQuestionNumbers": true, "allowBack": true },
            "welcome": null,
            "blocks": [
                { "id": "b_1", "ref": "name", "title": "Name", "required": false, "type": "short_text", "properties": {} },
                { "id": "b_2", "ref": "rate", "title": "Rate", "required": false, "type": "opinion_scale", "properties": { "start": 1, "end": 5, "labels": {} } },
                {
                    "id": "b_3", "ref": "who", "title": "Who", "required": false, "type": "contact_info",
                    "properties": { "fields": {
                        "firstName": { "enabled": true, "required": true },
                        "lastName": { "enabled": true, "required": true },
                        "email": { "enabled": true, "required": true },
                        "phone": { "enabled": false, "required": false },
                        "company": { "enabled": true, "required": false },
                    } },
                },
                { "id": "b_4", "ref": "brk", "type": "page_break", "title": "" },
            ],
            "endings": [{ "id": "e_1", "ref": "end", "title": "Done", "showScore": false, "showAnswers": false }],
            "hidden": [],
            "variables": [{ "name": "total", "type": "number", "initial": 0 }],
            "logic": [{
                "blockId": "b_1",
                "calculations": [{ "id": "x_1", "when": null, "variable": "total", "op": "set", "value": { "type": "constant", "value": 2 } }],
                "jumps": [],
                "otherwise": null,
            }],
            "endingRules": [],
        })
    );
    // Deserialising checks the schema too.
    let back: weldsuite_forms_engine::FormDefinition = serde_json::from_value(value).unwrap();
    assert_eq!(back, def);
    assert!(
        serde_json::from_value::<weldsuite_forms_engine::FormDefinition>(
            json!({ "blocks": [], "endings": [] })
        )
        .is_err()
    );
}

/// A condition group entry is read as the option Zod's union keeps: a
/// nested group that passes beats a condition that only fails its checks.
#[test]
fn condition_items_follow_zods_union() {
    use weldsuite_forms_engine::definition::ConditionItem;

    let long_id = "x".repeat(31);
    let both = json!({
        "left": { "type": "field", "id": long_id },
        "operator": "is_answered",
        "op": "or",
        "conditions": [{ "left": { "type": "hidden", "name": "src" }, "operator": "is_answered" }],
    });
    let item: ConditionItem = serde_json::from_value(both).unwrap();
    assert!(matches!(item, ConditionItem::Group(_)), "{item:?}");

    let condition = json!({
        "left": { "type": "hidden", "name": "src" },
        "operator": "is_answered",
        "op": "or",
        "conditions": [],
    });
    let item: ConditionItem = serde_json::from_value(condition).unwrap();
    assert!(matches!(item, ConditionItem::Condition(_)), "{item:?}");
}
