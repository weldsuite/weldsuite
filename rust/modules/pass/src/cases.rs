//! The pure helpers against what pass-api's own code answered for the same
//! inputs (`tests/fixtures/cases-ts.json`, written by `tools/fixtures.mts`).

use serde_json::{Value, json};
use weldsuite_kit::validation::Issues;

use crate::dotenv::{is_valid_secret_key, parse_dotenv, render_dotenv};
use crate::import::{parse_csv, parse_import};
use crate::js::JsRecord;
use crate::schemas::{host_of, password_entropy_bits, password_strength, read_item, slugify};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../tests/fixtures/cases-ts.json")).expect("JSON")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

#[test]
fn slugs_hosts_and_strength() {
    let cases = fixture();
    for case in cases["slugify"].as_array().expect("slugify") {
        assert_eq!(
            slugify(text(&case["input"])),
            text(&case["output"]),
            "{case}"
        );
    }
    for case in cases["hostOf"].as_array().expect("hostOf") {
        assert_eq!(
            host_of(Some(text(&case["input"]))).map_or(Value::Null, Value::String),
            case["output"],
            "{case}"
        );
    }
    for case in cases["passwords"].as_array().expect("passwords") {
        let input = text(&case["input"]);
        let bits = case["bits"].as_f64().expect("bits");
        assert!((password_entropy_bits(input) - bits).abs() < 1e-9, "{case}");
        assert_eq!(password_strength(input), text(&case["strength"]), "{case}");
    }
}

#[test]
fn dotenv_matches_typescript() {
    let cases = fixture();
    for case in cases["dotenv"].as_array().expect("dotenv") {
        let parsed = parse_dotenv(text(&case["input"]));
        let skipped: Vec<Value> = parsed
            .skipped
            .iter()
            .map(crate::dotenv::Skipped::to_json)
            .collect();
        assert_eq!(
            json!({ "values": parsed.values.to_json(), "skipped": skipped }),
            case["output"],
            "{case}"
        );
        // Key order too (`Object.keys`), which serde_json's map loses.
        let keys: Vec<&str> = case["keys"]
            .as_array()
            .expect("keys")
            .iter()
            .map(text)
            .collect();
        assert_eq!(parsed.values.keys().collect::<Vec<_>>(), keys, "{case}");
    }
    for case in cases["renderDotenv"].as_array().expect("render") {
        let mut values = JsRecord::default();
        for (key, value) in case["input"].as_object().expect("object") {
            values.set(key, text(value).to_owned());
        }
        assert_eq!(render_dotenv(&values), text(&case["output"]), "{case}");
    }
    for case in cases["validKeys"].as_array().expect("validKeys") {
        assert_eq!(
            Value::Bool(is_valid_secret_key(text(&case["input"]))),
            case["output"],
            "{case}"
        );
    }
}

#[test]
fn csv_and_imports_match_typescript() {
    let cases = fixture();
    for case in cases["csv"].as_array().expect("csv") {
        let records: Vec<Value> = parse_csv(text(&case["input"]))
            .into_iter()
            .map(|r| json!({ "line": r.line, "cells": r.cells }))
            .collect();
        assert_eq!(Value::Array(records), case["output"], "{case}");
    }
    for case in cases["imports"].as_array().expect("imports") {
        let outcome = parse_import(text(&case["content"]), text(&case["format"]));
        match (outcome, case.get("error")) {
            (Err(error), Some(expected)) => assert_eq!(error.0, text(expected), "{case}"),
            (Ok(parsed), None) => {
                let documents: Vec<Value> = parsed
                    .documents
                    .iter()
                    .map(|d| serde_json::from_str(&d.to_json_string()).expect("JSON"))
                    .collect();
                let notes = |list: &[crate::import::ImportNote]| -> Vec<Value> {
                    list.iter()
                        .map(crate::import::ImportNote::to_json)
                        .collect()
                };
                assert_eq!(
                    json!({
                        "format": parsed.format,
                        "documents": documents,
                        "skipped": notes(&parsed.skipped),
                        "warnings": notes(&parsed.warnings),
                    }),
                    case["output"],
                    "{case}"
                );
            }
            (outcome, expected) => panic!("{case}: {outcome:?} vs {expected:?}"),
        }
    }
}

/// The request bodies against Zod's own answers.
#[test]
fn bodies_validate_like_zod() {
    let cases = fixture();
    for case in cases["zod"].as_array().expect("zod") {
        let body = &case["body"];
        let mut issues = Issues::default();
        let data = match text(&case["schema"]) {
            "item" => read_item(&mut issues, body)
                .map(|d| serde_json::from_str::<Value>(&d.to_json_string()).expect("JSON")),
            _ => continue,
        };
        let result = match issues.finish() {
            Ok(()) => json!({ "success": true, "data": data }),
            Err(invalid) => {
                json!({ "success": false, "error": { "issues": invalid.issues(), "name": "ZodError" } })
            }
        };
        assert_eq!(result, case["result"], "{case}");
    }
}
