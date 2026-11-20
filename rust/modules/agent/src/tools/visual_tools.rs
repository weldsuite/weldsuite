//! Display tools (`packages/domains/agent/src/visual-tools.ts`, ADR
//! AGENT-017): the model shows a chart, stat tiles, a table or record cards by
//! calling one with a spec. The tool only checks the spec; the loop puts the
//! visual into the reply as a marker (`\u{1e}visual:{json}\u{1e}`, the
//! contract in `@weldsuite/app-api-client/schemas/chat-visuals`) and each
//! client draws it. They read and change nothing, so every agent has them.

use serde_json::{Map, Value, json};

use super::{ToolError, ToolSpec};

/// The record separator a marker sits between.
const MARKER: char = '\u{1e}';
const VISUAL_PREFIX: &str = "visual:";

/// What the tool tells the model once a visual is on screen (`SHOWN_HINT`).
const SHOWN_HINT: &str = "The visual is on screen now, where you called the tool. Do not repeat its numbers as a list or markdown table; \
add at most a sentence or two on what stands out.";

/// The record types a card may show (`SEARCH_ENTITY_TYPES`).
const ENTITY_TYPES: [&str; 31] = [
    "contact",
    "customer",
    "lead",
    "opportunity",
    "ticket",
    "article",
    "knowledge_page",
    "product",
    "order",
    "invoice",
    "bill",
    "project",
    "task",
    "sheet",
    "board",
    "domain",
    "merge_issue",
    "merge_pull_request",
    "document",
    "form",
    "drive_file",
    "conversation",
    "meeting",
    "sign_envelope",
    "warehouse",
    "workflow",
    "agent",
    "reach_campaign",
    "chat_channel",
    "data_list",
    "panel_project",
];

/// The ids of the display tools (`VISUAL_TOOL_IDS`).
pub const VISUAL_TOOL_IDS: [&str; 4] = [
    "agent.show_chart",
    "agent.show_stats",
    "agent.show_table",
    "agent.show_records",
];

pub(super) fn is_visual_tool_id(id: &str) -> bool {
    VISUAL_TOOL_IDS.contains(&id)
}

/// The visual type a display tool shows, by its model-facing name.
fn visual_type(name: &str) -> Option<&'static str> {
    match name {
        "show_chart" => Some("chart"),
        "show_stats" => Some("stats"),
        "show_table" => Some("table"),
        "show_records" => Some("records"),
        _ => None,
    }
}

fn format_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "style": { "type": "string", "enum": ["number", "currency", "percent", "compact"],
                "description": "number: 1,234.5 · currency: € 1,234 · percent: the value IS the percentage (12.5 → 12.5%) · compact: 1.2K" },
            "currency": { "type": "string", "minLength": 3, "maxLength": 3, "description": "ISO 4217 code for style \"currency\", e.g. \"EUR\"." },
            "decimals": { "type": "integer", "minimum": 0, "maximum": 4, "description": "Fixed number of decimals." },
        },
        "required": ["style"],
        "description": "How numbers are written.",
    })
}

pub(super) fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            id: "agent.show_chart",
            name: "show_chart",
            description: concat!(
                "Show the user a chart in the chat. Use it when a picture answers better than words: comparing categories ",
                "(bar), a trend over time (line or area), or parts of a whole (pie or donut, up to 8 slices). ",
                "Use only data your tools returned or the user gave; never invent numbers. ",
                "Give one value per label in each series; keep it to a few series and at most a few dozen labels."
            ),
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["bar", "line", "area", "pie", "donut"],
                        "description": "bar: compare categories · line/area: a trend over time · pie/donut: parts of one whole (first series only, ≤ 8 slices)." },
                    "title": { "type": "string", "minLength": 1, "maxLength": 120, "description": "What the chart shows, e.g. \"Open tickets per status\"." },
                    "description": { "type": "string", "maxLength": 300, "description": "Optional one-line takeaway under the title." },
                    "caption": { "type": "string", "maxLength": 200, "description": "Optional source or period, e.g. \"Last 30 days\"." },
                    "labels": { "type": "array", "minItems": 1, "maxItems": 200, "items": { "type": "string", "maxLength": 80 },
                        "description": "The categories along the x axis (or the slices), in order." },
                    "series": { "type": "array", "minItems": 1, "maxItems": 8, "items": { "type": "object", "properties": {
                        "name": { "type": "string", "minLength": 1, "maxLength": 60, "description": "Series name, shown in the legend." },
                        "values": { "type": "array", "items": { "type": ["number", "null"] },
                            "description": "One value per label, in the same order; null for a gap." },
                    }, "required": ["name", "values"] } },
                    "stacked": { "type": "boolean", "description": "Bar/area: stack the series instead of placing them side by side." },
                    "horizontal": { "type": "boolean", "description": "Bar: draw the bars horizontally (good for long labels)." },
                    "format": format_schema(),
                },
                "required": ["kind", "title", "labels", "series"],
            }),
        },
        ToolSpec {
            id: "agent.show_stats",
            name: "show_stats",
            description: concat!(
                "Show the user a row of key figures (stat tiles), e.g. revenue, open tickets, win rate, each with an optional ",
                "change vs the previous period. Use it for 1 to 8 headline numbers. ",
                "Use only data your tools returned or the user gave; never invent numbers. "
            ),
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 120 },
                    "items": { "type": "array", "minItems": 1, "maxItems": 8, "items": { "type": "object", "properties": {
                        "label": { "type": "string", "minLength": 1, "maxLength": 60 },
                        "value": { "type": ["number", "string"], "maxLength": 40,
                            "description": "A number (formatted with `format`) or a short text." },
                        "format": format_schema(),
                        "change": { "type": "number",
                            "description": "Change vs the previous period as a percentage, e.g. 12.5 for +12.5% or -3 for -3%." },
                        "changeLabel": { "type": "string", "maxLength": 60, "description": "What the change compares to, e.g. \"vs last month\"." },
                        "positiveIsGood": { "type": "boolean",
                            "description": "False when a rise is bad (costs, churn, open tickets). Defaults to true." },
                    }, "required": ["label", "value"] } },
                },
                "required": ["items"],
            }),
        },
        ToolSpec {
            id: "agent.show_table",
            name: "show_table",
            description: concat!(
                "Show the user a table in the chat, for row-by-row detail that does not fit a chart: several columns per item, ",
                "up to 100 rows. Prefer it over a markdown table when there are more than a few rows or columns. ",
                "Use only data your tools returned or the user gave; never invent numbers. ",
                "Pass columns once and each row as an array of cells in column order."
            ),
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 120 },
                    "columns": { "type": "array", "minItems": 1, "maxItems": 12, "items": { "type": "object", "properties": {
                        "label": { "type": "string", "minLength": 1, "maxLength": 60 },
                        "format": format_schema(),
                        "align": { "type": "string", "enum": ["left", "right", "center"] },
                    }, "required": ["label"] } },
                    "rows": { "type": "array", "minItems": 1, "maxItems": 100,
                        "items": { "type": "array", "items": { "type": ["string", "number", "boolean", "null"], "maxLength": 300 } },
                        "description": "One array per row, one cell per column in column order." },
                },
                "required": ["columns", "rows"],
            }),
        },
        ToolSpec {
            id: "agent.show_records",
            name: "show_records",
            description: concat!(
                "Show the user workspace records as cards they can click to open: tickets, tasks, deals (opportunity), leads, ",
                "projects, invoices and the like. Use it when your answer is a short list of records (up to 20). ",
                "Only use ids your tools returned."
            ),
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 120 },
                    "items": { "type": "array", "minItems": 1, "maxItems": 20, "items": { "type": "object", "properties": {
                        "entityType": { "type": "string", "enum": ENTITY_TYPES,
                            "description": "The kind of record, e.g. \"ticket\", \"task\", \"opportunity\"." },
                        "id": { "type": "string", "minLength": 1, "maxLength": 64, "description": "The record id your tools returned." },
                        "label": { "type": "string", "minLength": 1, "maxLength": 160, "description": "Its name or title." },
                        "subtitle": { "type": "string", "maxLength": 160, "description": "One short line, e.g. the company or assignee." },
                        "status": { "type": "string", "maxLength": 40 },
                        "fields": { "type": "array", "maxItems": 4, "items": { "type": "object", "properties": {
                            "label": { "type": "string", "minLength": 1, "maxLength": 40 },
                            "value": { "type": "string", "maxLength": 80 },
                        }, "required": ["label", "value"] },
                            "description": "Up to 4 key facts, e.g. amount or due date." },
                    }, "required": ["entityType", "id", "label"] } },
                },
                "required": ["items"],
            }),
        },
    ]
}

fn array_len(value: &Value) -> usize {
    value.as_array().map_or(0, Vec::len)
}

/// What the schema cannot say: one value per label, one cell per column.
fn shape_problem(name: &str, args: &Value) -> Option<String> {
    match name {
        "show_chart" => {
            let labels = array_len(&args["labels"]);
            args["series"].as_array()?.iter().enumerate().find_map(|(i, series)| {
                let values = array_len(&series["values"]);
                (values != labels).then(|| {
                    format!("series.{i}.values: Expected {labels} values (one per label), got {values}")
                })
            })
        }
        "show_table" => {
            let columns = array_len(&args["columns"]);
            args["rows"]
                .as_array()?
                .iter()
                .enumerate()
                .find_map(|(i, row)| {
                    let cells = array_len(row);
                    (cells != columns).then(|| {
                        format!("rows.{i}: Expected {columns} cells (one per column), got {cells}")
                    })
                })
        }
        _ => None,
    }
}

/// Run a display tool on arguments the registry already checked against its
/// schema.
pub(super) fn execute(id: &str, args: &Value) -> Result<Value, ToolError> {
    let name = id.trim_start_matches("agent.");
    if visual_type(name).is_none() {
        return Err(ToolError::UnknownTool(id.to_owned()));
    }
    Ok(match shape_problem(name, args) {
        Some(problem) => json!({
            "ok": false,
            "error": format!("The visual was not shown: {problem}. Fix the spec and call again."),
        }),
        None => json!({ "ok": true, "shownToUser": true, "hint": SHOWN_HINT }),
    })
}

/// The marker for a display tool call that succeeded (its answer has
/// `ok: true`), or `None` for any other call.
pub fn shown_visual_marker(name: &str, args: &Value, answer: &Value) -> Option<String> {
    let kind = visual_type(name)?;
    if answer["ok"] != Value::Bool(true) {
        return None;
    }
    let mut visual = Map::new();
    visual.insert("type".into(), json!(kind));
    for (key, value) in args.as_object()? {
        visual.insert(key.clone(), value.clone());
    }
    Some(format!(
        "{MARKER}{VISUAL_PREFIX}{}{MARKER}",
        Value::Object(visual)
    ))
}

/// The visuals carried in a reply, in order, and its text without them
/// (`extractVisuals`): a WeldChat message keeps the specs in
/// `metadata.visuals` and plain text in `content`.
pub fn extract_visuals(raw: &str) -> (String, Vec<Value>) {
    let mut texts: Vec<String> = Vec::new();
    let mut visuals = Vec::new();
    for part in split(raw) {
        match part {
            Part::Text(text) => texts.push(text),
            Part::Visual(visual) => visuals.push(visual),
        }
    }
    (texts.join("\n\n"), visuals)
}

enum Part {
    Text(String),
    Visual(Value),
}

/// A reply split at its markers. A malformed or unfinished marker is dropped.
fn split(raw: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    let push_text = |text: &str, parts: &mut Vec<Part>| {
        let clean = text.trim();
        if !clean.is_empty() {
            parts.push(Part::Text(clean.to_owned()));
        }
    };
    let mut rest = raw;
    while let Some(start) = rest.find(MARKER) {
        push_text(&rest[..start], &mut parts);
        let after = &rest[start + MARKER.len_utf8()..];
        let Some(end) = after.find(MARKER) else {
            return parts;
        };
        let body = &after[..end];
        if let Some(json) = body.strip_prefix(VISUAL_PREFIX) {
            if let Ok(visual) = serde_json::from_str::<Value>(json) {
                if visual.is_object() {
                    parts.push(Part::Visual(visual));
                }
            }
        }
        rest = &after[end + MARKER.len_utf8()..];
    }
    push_text(rest, &mut parts);
    parts
}

const DATA_TEXT_LIMIT: usize = 1500;

fn kind_name(visual: &Value) -> &'static str {
    match visual["type"].as_str() {
        Some("chart") => "Chart",
        Some("stats") => "Figures",
        Some("table") => "Table",
        _ => "Records",
    }
}

fn labels_of(items: &Value, key: &str) -> String {
    items
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item[key].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

/// A visual's title, or its labels when it has none (`visualTitle`).
fn visual_title(visual: &Value) -> String {
    if let Some(title) = visual["title"].as_str().filter(|t| !t.is_empty()) {
        return title.to_owned();
    }
    match visual["type"].as_str() {
        Some("stats" | "records") => labels_of(&visual["items"], "label"),
        Some("table") => labels_of(&visual["columns"], "label"),
        _ => String::new(),
    }
}

fn cell_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A visual's data as compact text the model can read back next turn.
fn visual_data_text(visual: &Value) -> String {
    let empty = Vec::new();
    let items = |key: &str| visual[key].as_array().unwrap_or(&empty).clone();
    match visual["type"].as_str() {
        Some("chart") => {
            let labels = items("labels");
            items("series")
                .iter()
                .map(|series| {
                    let values = series["values"].as_array().cloned().unwrap_or_default();
                    let points: Vec<String> = labels
                        .iter()
                        .enumerate()
                        .map(|(i, label)| {
                            let value = values
                                .get(i)
                                .filter(|v| !v.is_null())
                                .map_or("-".to_owned(), cell_text);
                            format!("{} {value}", cell_text(label))
                        })
                        .collect();
                    format!("{}: {}", cell_text(&series["name"]), points.join(", "))
                })
                .collect::<Vec<_>>()
                .join("; ")
        }
        Some("stats") => items("items")
            .iter()
            .map(|item| {
                let base = format!(
                    "{} {}",
                    cell_text(&item["label"]),
                    cell_text(&item["value"])
                );
                match item["change"].as_f64() {
                    Some(change) => {
                        let sign = if change > 0.0 { "+" } else { "" };
                        format!("{base} ({sign}{}%)", cell_text(&item["change"]))
                    }
                    None => base,
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
        Some("table") => {
            let mut lines = vec![labels_of(&visual["columns"], "label").replace(", ", " | ")];
            for row in items("rows") {
                let cells: Vec<String> = row
                    .as_array()
                    .map(|r| r.iter().map(cell_text).collect())
                    .unwrap_or_default();
                lines.push(cells.join(" | "));
            }
            lines.join("\n")
        }
        _ => items("items")
            .iter()
            .map(|item| {
                let base = format!(
                    "{} {} \"{}\"",
                    cell_text(&item["entityType"]),
                    cell_text(&item["id"]),
                    cell_text(&item["label"])
                );
                match item["status"].as_str() {
                    Some(status) => format!("{base} ({status})"),
                    None => base,
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
    }
}

/// One visual as text: its summary line and, with `with_data`, its numbers
/// (`visualToPlainText`).
pub fn visual_to_plain_text(visual: &Value, with_data: bool) -> String {
    let name: String = visual_title(visual).chars().take(120).collect();
    let kind = kind_name(visual);
    let line = if name.is_empty() {
        kind.to_owned()
    } else {
        format!("{kind}: {name}")
    };
    if !with_data {
        return format!("[{line}]");
    }
    let data = visual_data_text(visual);
    let clipped = if data.chars().count() > DATA_TEXT_LIMIT {
        format!(
            "{}…",
            data.chars().take(DATA_TEXT_LIMIT).collect::<String>()
        )
    } else {
        data
    };
    format!("[{line} — shown to the user: {clipped}]")
}

/// A stored reply as plain text for the model's history: each visual becomes
/// its summary line with its numbers (`replyToPlainText(raw, { detail: 'data' })`).
pub fn reply_to_plain_text(raw: &str) -> String {
    if !raw.contains(MARKER) {
        return raw.to_owned();
    }
    split(raw)
        .into_iter()
        .map(|part| match part {
            Part::Text(text) => text,
            Part::Visual(visual) => visual_to_plain_text(&visual, true),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::schema;

    fn chart() -> Value {
        json!({
            "kind": "bar",
            "title": "Open tickets per status",
            "labels": ["Open", "Solved"],
            "series": [{ "name": "Tickets", "values": [3, 9] }],
        })
    }

    fn spec(name: &str) -> ToolSpec {
        specs().into_iter().find(|s| s.name == name).expect("spec")
    }

    #[test]
    fn the_specs_are_the_four_display_tools_needing_no_permission() {
        let names: Vec<&str> = specs().iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            ["show_chart", "show_stats", "show_table", "show_records"]
        );
        assert!(specs().iter().all(|s| s.required_permissions.is_empty()));
        assert!(specs().iter().all(|s| is_visual_tool_id(s.id)));
        // Same wording as the TypeScript tools, which the catalog route answers.
        assert!(
            spec("show_stats")
                .description
                .ends_with("never invent numbers. ")
        );
    }

    #[test]
    fn a_valid_spec_is_shown_and_becomes_a_marker() {
        let args = schema::validate(&spec("show_chart").parameters, &chart()).expect("valid");
        let answer = execute("agent.show_chart", &args).expect("runs");
        assert_eq!(answer["ok"], true);
        let marker = shown_visual_marker("show_chart", &args, &answer).expect("marker");
        let (text, visuals) = extract_visuals(&format!("Here.{marker}Done."));
        assert_eq!(text, "Here.\n\nDone.");
        assert_eq!(visuals.len(), 1);
        assert_eq!(visuals[0]["type"], "chart");
        assert_eq!(visuals[0]["title"], "Open tickets per status");
    }

    #[test]
    fn a_spec_with_the_wrong_shape_is_refused_with_a_reason() {
        let mut bad = chart();
        bad["series"][0]["values"] = json!([1]);
        let answer = execute("agent.show_chart", &bad).expect("runs");
        assert_eq!(answer["ok"], false);
        assert!(answer["error"].as_str().unwrap().contains("one per label"));
        assert!(shown_visual_marker("show_chart", &bad, &answer).is_none());

        let table =
            json!({ "columns": [{ "label": "A" }, { "label": "B" }], "rows": [["only one"]] });
        let answer = execute("agent.show_table", &table).expect("runs");
        assert!(answer["error"].as_str().unwrap().contains("one per column"));

        let missing = schema::validate(&spec("show_records").parameters, &json!({}));
        assert!(missing.is_err());
    }

    #[test]
    fn only_display_tools_make_markers() {
        let ok = json!({ "ok": true });
        assert!(shown_visual_marker("list_tasks", &chart(), &ok).is_none());
        assert!(execute("agent.ask_user", &chart()).is_err());
    }

    #[test]
    fn a_reply_reads_back_as_text_with_its_numbers() {
        let answer = json!({ "ok": true });
        let chart_marker = shown_visual_marker("show_chart", &chart(), &answer).unwrap();
        let stats = json!({ "items": [{ "label": "Revenue", "value": 10, "change": 5 }] });
        let stats_marker = shown_visual_marker("show_stats", &stats, &answer).unwrap();
        let table = json!({ "columns": [{ "label": "Deal" }, { "label": "Stage" }], "rows": [["A", null]] });
        let table_marker = shown_visual_marker("show_table", &table, &answer).unwrap();
        let records = json!({ "items": [{ "entityType": "task", "id": "tsk_1", "label": "Ship it", "status": "Open" }] });
        let records_marker = shown_visual_marker("show_records", &records, &answer).unwrap();

        assert_eq!(reply_to_plain_text("plain"), "plain");
        assert_eq!(
            reply_to_plain_text(&format!("Here.\n\n{chart_marker}")),
            "Here.\n\n[Chart: Open tickets per status — shown to the user: Tickets: Open 3, Solved 9]"
        );
        assert_eq!(
            reply_to_plain_text(&stats_marker),
            "[Figures: Revenue — shown to the user: Revenue 10 (+5%)]"
        );
        assert_eq!(
            reply_to_plain_text(&table_marker),
            "[Table: Deal, Stage — shown to the user: Deal | Stage\nA | ]"
        );
        assert_eq!(
            reply_to_plain_text(&records_marker),
            "[Records: Ship it — shown to the user: task tsk_1 \"Ship it\" (Open)]"
        );
        assert_eq!(
            visual_to_plain_text(&json!({ "type": "chart" }), false),
            "[Chart]"
        );
    }

    #[test]
    fn an_unfinished_or_broken_marker_is_dropped() {
        let (text, visuals) = extract_visuals("a\u{1e}visual:{nope\u{1e}b\u{1e}visual:{\"type\"");
        assert_eq!(text, "a\n\nb");
        assert!(visuals.is_empty());
    }
}
