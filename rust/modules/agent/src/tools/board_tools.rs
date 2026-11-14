//! The WeldBoard tools (`board-tools.ts`).
//!
//! A board lives in its room (the collab-rooms service), so these go through
//! the module surface ([`super::modules`]): `weldsuite_board::agent_call`, the
//! twin of board-api's `BoardsInternal` entrypoint. Every call acts for the
//! person the agent works for: it finds, reads and changes only the boards
//! their WeldDrive access (and project membership) allows, and a write is an
//! edit everyone with the board open watches arrive.
//!
//! Agents do not draw: they describe what goes on the board (sticky notes,
//! shapes, frames, arrows, a mind map) and the board engine lays it out.

use serde_json::{Value, json};

use super::{ToolContext, ToolError, ToolSpec, modules};

const UNAVAILABLE: &str = "Boards are not available to agents here";

/// `BOARD_SPEC_COLORS`.
const COLORS: [&str; 12] = [
    "yellow", "orange", "red", "pink", "violet", "blue", "cyan", "teal", "green", "lime", "grey",
    "white",
];
/// `BOARD_SPEC_SHAPES`.
const SHAPES: [&str; 24] = [
    "rectangle",
    "rounded",
    "ellipse",
    "triangle",
    "diamond",
    "parallelogram",
    "trapezoid",
    "pentagon",
    "hexagon",
    "octagon",
    "star",
    "cross",
    "cylinder",
    "cloud",
    "callout",
    "arrow-right",
    "arrow-left",
    "chevron",
    "document",
    "predefined",
    "data",
    "terminator",
    "delay",
    "manual-input",
];
/// `BOARD_SPEC_ITEM_TYPES`.
const ITEM_TYPES: [&str; 4] = ["sticky", "shape", "text", "card"];

fn key() -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": 100 })
}

fn mind(depth_children: Option<(Value, u64)>) -> Value {
    let mut props = json!({ "text": { "type": "string", "maxLength": 300 } });
    if let Some((child, max)) = depth_children {
        props["children"] = json!({ "type": "array", "maxItems": max, "items": child });
    }
    json!({ "type": "object", "properties": props, "required": ["text"] })
}

/// `boardSpecToolSchema`: the mind map spelled out four levels deep.
fn spec() -> Value {
    let leaf = mind(None);
    let twig = mind(Some((leaf, 12)));
    let branch = mind(Some((twig, 12)));
    let mut root = mind(Some((branch, 16)));
    root["description"] = json!("A mind map: the central topic and its branches");
    json!({
        "type": "object",
        "description": "What to put on the board; board-api lays it out",
        "properties": {
            "layout": { "type": "string", "enum": ["grid", "flow"],
                "description": "grid: rows of items; flow: layers following the lines, a flowchart. Default flow when there are lines" },
            "direction": { "type": "string", "enum": ["down", "right"], "description": "Which way a flow runs (default down)" },
            "items": { "type": "array", "maxItems": 500, "items": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "minLength": 1, "maxLength": 100,
                        "description": "A name for this item, unique in the spec, for lines to refer to" },
                    "type": { "type": "string", "enum": ITEM_TYPES },
                    "text": { "type": "string", "maxLength": 2000 },
                    "shape": { "type": "string", "enum": SHAPES, "description": "For a shape: its kind (default rounded)" },
                    "color": { "type": "string", "enum": COLORS },
                    "description": { "type": "string", "maxLength": 5000, "description": "For a card: the text under its title" },
                    "frame": { "type": "string", "minLength": 1, "maxLength": 100, "description": "The key of the frame this item goes in" },
                },
                "required": ["type", "text"],
            } },
            "frames": { "type": "array", "maxItems": 50,
                "description": "Frames side by side, each holding the items that name it",
                "items": { "type": "object",
                    "properties": { "key": key(), "title": { "type": "string", "maxLength": 200 } },
                    "required": ["key", "title"] } },
            "lines": { "type": "array", "maxItems": 1000, "description": "Arrows between items, by key",
                "items": { "type": "object",
                    "properties": { "from": key(), "to": key(), "label": { "type": "string", "maxLength": 200 } },
                    "required": ["from", "to"] } },
            "mindmap": root,
        },
    })
}

fn board_param() -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": 255,
        "description": "The board id (from find_boards or create_board)" })
}

pub(super) fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            id: "boards.find",
            name: "find_boards",
            description: "Find WeldBoard whiteboards by name (the ones the user can open), most recently changed first; or the boards of a WeldFlow project.",
            required_permissions: &["boards:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "maxLength": 255, "description": "Part of the board name" },
                    "projectId": { "type": "string", "maxLength": 255, "description": "Only this WeldFlow project\u{2019}s boards" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                },
            }),
        },
        ToolSpec {
            id: "boards.create",
            name: "create_board",
            description: "Create a new WeldBoard whiteboard (in the user\u{2019}s My Drive, or in a WeldFlow project), optionally with sticky notes, shapes, frames, arrows or a mind map on it.",
            required_permissions: &["boards:create"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "minLength": 1, "maxLength": 255 },
                    "projectId": { "type": "string", "maxLength": 255,
                        "description": "Make it a board of this WeldFlow project (default: the user\u{2019}s My Drive)" },
                    "content": spec(),
                },
                "required": ["name"],
            }),
        },
        ToolSpec {
            id: "boards.read",
            name: "read_board",
            description: "Read a board: its elements (id, type, text, position, frame) or just its text. Includes edits others are making right now.",
            required_permissions: &["boards:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "boardId": board_param(),
                    "format": { "type": "string", "enum": ["outline", "text"],
                        "description": "outline: elements with id, type, text, position and frame (default); text: the board\u{2019}s text only" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 2000, "description": "Most elements in an outline (default 500)" },
                },
                "required": ["boardId"],
            }),
        },
        ToolSpec {
            id: "boards.add",
            name: "add_to_board",
            description: "Put sticky notes, shapes, text, cards, frames, arrows or a mind map on a board. Describe them; the board lays them out. Everyone with the board open sees them arrive; the user can undo it from version history.",
            required_permissions: &["boards:update"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "boardId": board_param(),
                    "content": spec(),
                    "at": { "type": "object",
                        "description": "Board point for the middle of the new content; default right of what is there",
                        "properties": { "x": { "type": "number" }, "y": { "type": "number" } },
                        "required": ["x", "y"] },
                },
                "required": ["boardId", "content"],
            }),
        },
        ToolSpec {
            id: "boards.update",
            name: "update_board",
            description: "Rename a board, and change or remove elements on it by id (text, colour, position, delete). Get the ids from read_board.",
            required_permissions: &["boards:update"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "boardId": board_param(),
                    "name": { "type": "string", "minLength": 1, "maxLength": 255, "description": "A new name for the board" },
                    "changes": { "type": "array", "maxItems": 500, "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "minLength": 1, "maxLength": 64, "description": "An element id from read_board" },
                            "text": { "type": "string", "maxLength": 2000 },
                            "color": { "type": "string", "enum": COLORS },
                            "x": { "type": "number" },
                            "y": { "type": "number" },
                            "delete": { "type": "boolean" },
                        },
                        "required": ["id"],
                    } },
                },
                "required": ["boardId"],
            }),
        },
    ]
}

async fn run(ctx: &ToolContext, op: &str, board: Option<&str>, input: Value) -> Value {
    modules::call(ctx, "boards", op, board, input, UNAVAILABLE).await
}

pub(super) async fn execute(ctx: &ToolContext, id: &str, args: &Value) -> Result<Value, ToolError> {
    let board = args["boardId"].as_str();
    Ok(match id {
        "boards.find" => run(ctx, "find", None, args.clone()).await,
        "boards.create" => {
            let mut input = args.clone();
            let content = input.as_object_mut().and_then(|m| m.remove("content"));
            let created = run(ctx, "create", None, input).await;
            let (Some(content), Some(new_id)) = (content, created["id"].as_str()) else {
                return Ok(created);
            };
            if created.get("error").is_some() {
                return Ok(created);
            }
            let added = run(ctx, "add", Some(new_id), json!({ "spec": content })).await;
            let mut out = created.clone();
            out["content"] = added;
            out
        }
        "boards.read" => {
            let mut input = json!({ "format": args["format"].as_str().unwrap_or("outline") });
            if !args["limit"].is_null() {
                input["limit"] = args["limit"].clone();
            }
            run(ctx, "read", board, input).await
        }
        "boards.add" => {
            let mut input = json!({ "spec": args["content"] });
            if !args["at"].is_null() {
                input["at"] = args["at"].clone();
            }
            run(ctx, "add", board, input).await
        }
        "boards.update" => {
            let name = args["name"].as_str();
            let changes = args["changes"].as_array().filter(|c| !c.is_empty());
            if name.is_none() && changes.is_none() {
                return Ok(json!({ "error": "Send a name or changes" }));
            }
            let mut out = json!({});
            if let Some(name) = name {
                let renamed = run(ctx, "update", board, json!({ "name": name })).await;
                if renamed.get("error").is_some() {
                    return Ok(renamed);
                }
                out["name"] = renamed["name"].clone();
                out["url"] = renamed["url"].clone();
            }
            if let Some(changes) = changes {
                let edited = run(ctx, "edit", board, json!({ "changes": changes })).await;
                if edited.get("error").is_some() {
                    return Ok(edited);
                }
                if let (Some(into), Some(from)) = (out.as_object_mut(), edited.as_object()) {
                    into.extend(from.clone());
                }
            }
            out
        }
        other => return Err(ToolError::UnknownTool(other.to_owned())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::schema;

    #[test]
    fn a_board_spec_is_checked_and_a_mind_map_goes_four_levels_deep() {
        let add = &specs()[3];
        let ok = schema::validate(
            &add.parameters,
            &json!({
                "boardId": "brd_1",
                "content": {
                    "items": [{ "key": "a", "type": "sticky", "text": "Idea", "color": "yellow" }],
                    "lines": [{ "from": "a", "to": "a" }],
                    "mindmap": { "text": "Root", "children": [{ "text": "B", "children": [{ "text": "T",
                        "children": [{ "text": "L" }] }] }] },
                },
                "at": { "x": 1.5, "y": -2 },
            }),
        )
        .unwrap();
        assert_eq!(
            ok["content"]["mindmap"]["children"][0]["children"][0]["children"][0]["text"],
            "L"
        );
        let bad_color = schema::validate(
            &add.parameters,
            &json!({ "boardId": "b", "content": { "items": [{ "type": "sticky", "text": "x", "color": "mauve" }] } }),
        );
        assert!(bad_color.is_err());
        assert!(schema::validate(&add.parameters, &json!({ "boardId": "b" })).is_err());
    }

    #[test]
    fn the_read_format_is_outline_or_text() {
        let read = &specs()[2];
        assert!(
            schema::validate(
                &read.parameters,
                &json!({ "boardId": "b", "format": "svg" })
            )
            .is_err()
        );
        assert!(
            schema::validate(&read.parameters, &json!({ "boardId": "b", "limit": 2001 })).is_err()
        );
    }
}
