//! The WeldSheets tools (`sheets-tools.ts`).
//!
//! A sheet lives in its room (the collab-rooms service), not in the tenant
//! database, so these go through the module surface ([`super::modules`]):
//! `weldsuite_sheets::agent_call`, the twin of `sheets-api`'s
//! `/internal/agent/*` routes. Every call acts for the person the agent works
//! for: it finds, reads and changes only the sheets their WeldDrive access
//! (and project membership) allows, and a write is an edit everyone in the
//! sheet sees at once.

use serde_json::{Value, json};

use super::{ToolContext, ToolError, ToolSpec, modules};

const UNAVAILABLE: &str = "Spreadsheets are not available to agents here";

fn values() -> Value {
    json!({
        "type": "array",
        "minItems": 1,
        "maxItems": 5000,
        "items": {
            "type": "array",
            "maxItems": 200,
            "items": { "type": ["string", "number", "boolean", "null"] },
        },
        "description": "Rows of cell values. Text starting with \"=\" is a formula in English syntax (e.g. \"=SUM(B2:B9)\"); null clears a cell.",
    })
}

fn sheet_param() -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": 255,
        "description": "The spreadsheet id (from find_spreadsheets or create_spreadsheet)" })
}

fn tab_param() -> Value {
    json!({ "type": "string", "maxLength": 200, "description": "Tab name or id; default the first visible tab" })
}

pub(super) fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            id: "sheets.find",
            name: "find_spreadsheets",
            description: "Find WeldSheets spreadsheets by name (the ones the user can open), most recently changed first.",
            required_permissions: &["sheets:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "maxLength": 255, "description": "Part of the spreadsheet name" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                },
            }),
        },
        ToolSpec {
            id: "sheets.create",
            name: "create_spreadsheet",
            description: "Create a new WeldSheets spreadsheet in the user\u{2019}s My Drive, optionally filled with values from A1.",
            required_permissions: &["sheets:create"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "minLength": 1, "maxLength": 255 },
                    "values": { "type": "array", "minItems": 1, "maxItems": 5000,
                        "items": values()["items"].clone(),
                        "description": "Optional starting values, written from A1 of the first tab" },
                },
                "required": ["name"],
            }),
        },
        ToolSpec {
            id: "sheets.list_tabs",
            name: "list_spreadsheet_tabs",
            description: "List the tabs of a spreadsheet and the block of cells each one uses.",
            required_permissions: &["sheets:read"],
            parameters: json!({
                "type": "object",
                "properties": { "spreadsheetId": sheet_param() },
                "required": ["spreadsheetId"],
            }),
        },
        ToolSpec {
            id: "sheets.read_range",
            name: "read_spreadsheet_range",
            description: "Read cell values (and formulas) from a spreadsheet range, as rows. Includes edits others are making right now.",
            required_permissions: &["sheets:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "spreadsheetId": sheet_param(),
                    "tab": tab_param(),
                    "range": { "type": "string", "maxLength": 200,
                        "description": "A1 range such as A1:D20 (or Sheet2!A1:B5); default every used cell of the tab, up to 10,000 cells" },
                },
                "required": ["spreadsheetId"],
            }),
        },
        ToolSpec {
            id: "sheets.write_range",
            name: "write_spreadsheet_range",
            description: "Write values or formulas into a spreadsheet from a starting cell. Everyone with the sheet open sees the change at once; it can be undone from version history.",
            required_permissions: &["sheets:update"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "spreadsheetId": sheet_param(),
                    "tab": tab_param(),
                    "range": { "type": "string", "maxLength": 200,
                        "description": "Where to start writing: a cell such as B2 (default A1)" },
                    "values": values(),
                },
                "required": ["spreadsheetId", "values"],
            }),
        },
    ]
}

/// The input without the sheet id (what the route takes in its body).
fn without_id(args: &Value) -> Value {
    let mut body = args.clone();
    if let Some(map) = body.as_object_mut() {
        map.remove("spreadsheetId");
    }
    body
}

async fn run(ctx: &ToolContext, op: &str, sheet: Option<&str>, input: Value) -> Value {
    modules::call(ctx, "sheets", op, sheet, input, UNAVAILABLE).await
}

pub(super) async fn execute(ctx: &ToolContext, id: &str, args: &Value) -> Result<Value, ToolError> {
    let sheet = args["spreadsheetId"].as_str();
    Ok(match id {
        "sheets.find" => {
            let found = run(ctx, "find", None, args.clone()).await;
            if found.get("error").is_some() {
                found
            } else {
                json!({ "spreadsheets": found })
            }
        }
        "sheets.create" => run(ctx, "create", None, args.clone()).await,
        "sheets.list_tabs" => run(ctx, "tabs", sheet, json!({})).await,
        "sheets.read_range" => run(ctx, "read", sheet, without_id(args)).await,
        "sheets.write_range" => run(ctx, "write", sheet, without_id(args)).await,
        other => return Err(ToolError::UnknownTool(other.to_owned())),
    })
}

/// The tools that work on one spreadsheet the caller names (not find or create).
pub const SHEET_SCOPED_TOOL_IDS: [&str; 3] = [
    "sheets.list_tabs",
    "sheets.read_range",
    "sheets.write_range",
];

/// `sheetToolsLimitedTo(ids)`: whether a call of a sheet-scoped tool names one
/// of the allowed spreadsheets (the default WeldAgent gets the sheet the
/// person has open or tagged). A call for any other is refused before it
/// reaches the sheets module.
pub fn sheet_call_allowed(allowed: &[String], args: &Value) -> bool {
    args["spreadsheetId"]
        .as_str()
        .is_some_and(|id| allowed.iter().any(|a| a == id))
}

/// The refusal for a call outside the allowed sheets.
pub fn sheet_not_allowed() -> Value {
    json!({ "error": "You can only work in the spreadsheet the user has open or tagged." })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::schema;

    #[test]
    fn the_schemas_take_cells_of_any_kind() {
        let write = &specs()[4];
        let ok = schema::validate(
            &write.parameters,
            &json!({ "spreadsheetId": "sht_1", "values": [["a", 1, true, null], ["=SUM(B1:B2)"]] }),
        )
        .unwrap();
        assert_eq!(ok["values"][0][3], Value::Null);
        assert!(
            schema::validate(
                &write.parameters,
                &json!({ "spreadsheetId": "sht_1", "values": [[{ "x": 1 }]] })
            )
            .is_err()
        );
        assert!(
            schema::validate(
                &write.parameters,
                &json!({ "spreadsheetId": "s", "values": [] })
            )
            .is_err()
        );
        assert!(schema::validate(&write.parameters, &json!({ "values": [[1]] })).is_err());
    }

    #[test]
    fn a_limited_agent_only_works_in_its_sheets() {
        let allowed = vec!["sht_open".to_owned()];
        assert!(sheet_call_allowed(
            &allowed,
            &json!({ "spreadsheetId": "sht_open" })
        ));
        assert!(!sheet_call_allowed(
            &allowed,
            &json!({ "spreadsheetId": "sht_other" })
        ));
        assert!(!sheet_call_allowed(&allowed, &json!({})));
    }
}
