//! The workspace picker: membership mode (WeldID), a plain `/mcp`, and an
//! account in several workspaces. The token names no workspace and neither
//! does the URL. Refusing would show the person only that their MCP client
//! "couldn't connect", so the endpoint connects instead and offers one tool,
//! [`TOOL`], which lists their workspaces and the address that selects each
//! (`/mcp/w/<slug>`). The assistant can then tell them which address to
//! connect with.
//!
//! It never acts in a workspace: it serves no other tool and no resource,
//! and it reads only the names and slugs of the caller's own active
//! memberships ([`weldsuite_db::WorkspaceSelector::member_workspace_list`]).
//! There is no tenant database, permission lookup or rate limit, since
//! there is no workspace.

use std::fmt::Write as _;

use serde_json::{Map, Value, json};
use weldsuite_db::MemberWorkspace;

use crate::auth::{MCP_PATH, WORKSPACE_PREFIX, is_workspace_segment};
use crate::rpc;

/// The most workspaces listed.
pub(crate) const MAX_LISTED: u64 = 50;

/// The one tool.
const TOOL: &str = "list_workspaces";

/// What `initialize` tells the assistant instead of the house instructions.
const INSTRUCTIONS: &str = "This WeldSuite account belongs to several workspaces, and the address this MCP server was connected with doesn't say which one to use, so no workspace tools are available yet.\n\nCall list_workspaces, show the user their workspaces, and ask them to connect this MCP server again with the address of the workspace they want to use (each workspace has its own address). Nothing in WeldSuite can be read or changed through this connection until then.";

/// One workspace the caller may pick.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Choice {
    name: String,
    /// The endpoint for this workspace: `<server>/mcp/w/<slug>`.
    url: String,
}

/// The request's caller when it gets the picker: their workspaces, each
/// with the URL that selects it. Put in the request's extensions by
/// [`crate::auth::authenticate`] in place of an [`crate::McpSession`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceChoice {
    /// The URL that was called: `<server>/mcp`.
    endpoint: String,
    choices: Vec<Choice>,
}

impl WorkspaceChoice {
    /// `server_url` is the endpoint's origin (`McpAuth::server_url`). A
    /// workspace is selected by its slug, or by its id when the slug can't
    /// be a URL segment as it stands.
    pub(crate) fn new(server_url: &str, workspaces: &[MemberWorkspace]) -> Self {
        let endpoint = format!("{}{MCP_PATH}", server_url.trim_end_matches('/'));
        let choices = workspaces
            .iter()
            .map(|workspace| {
                let segment = if is_workspace_segment(&workspace.slug) {
                    &workspace.slug
                } else {
                    &workspace.id
                };
                Choice {
                    name: workspace.name.trim().to_owned(),
                    url: format!("{endpoint}{WORKSPACE_PREFIX}{segment}"),
                }
            })
            .collect();
        Self { endpoint, choices }
    }

    /// The tool's answer: one line per workspace, its name and its URL.
    fn listing(&self) -> String {
        if self.choices.is_empty() {
            return "This account is not an active member of any WeldSuite workspace. Create or join one in WeldSuite first.".to_owned();
        }
        let mut text = format!(
            "This WeldSuite account belongs to {} workspaces. {} doesn't say which one to use. To work in one, connect this MCP server again with that workspace's address:\n",
            self.choices.len(),
            self.endpoint,
        );
        // Writing to a String can't fail.
        for choice in &self.choices {
            let _ = write!(text, "\n- {}: {}", choice.name, choice.url);
        }
        if u64::try_from(self.choices.len()).is_ok_and(|listed| listed >= MAX_LISTED) {
            let _ = write!(
                text,
                "\n\nOnly the first {MAX_LISTED} are listed. Any workspace's address is {}{WORKSPACE_PREFIX}<slug>, with the slug from its /w/<slug> address in WeldSuite.",
                self.endpoint
            );
        }
        text
    }
}

/// [`TOOL`] as `tools/list` names it, read-only and closed-world.
fn tool_definition() -> Value {
    json!({
        "name": TOOL,
        "title": "List workspaces",
        "description": "List the WeldSuite workspaces this account belongs to, with the MCP server address to connect with for each. This connection names no workspace, so no other tools are available until the MCP server is connected again with one of these addresses.",
        "inputSchema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {}
        },
        "annotations": {
            "title": "List workspaces",
            "readOnlyHint": true,
            "openWorldHint": false
        },
        "execution": { "taskSupport": "forbidden" }
    })
}

/// A tool's error result.
fn tool_error(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

/// Answer one request message for a caller who has to pick a workspace.
pub(crate) fn handle(choice: &WorkspaceChoice, message: &Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let empty = Value::Object(Map::new());
    let params = message.get("params").unwrap_or(&empty);
    let outcome = match method {
        "initialize" => {
            let mut result = rpc::initialize(params);
            if let Some(object) = result.as_object_mut() {
                object.insert(
                    "instructions".to_owned(),
                    Value::String(INSTRUCTIONS.to_owned()),
                );
            }
            Ok(result)
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [tool_definition()] })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Ok(if name == TOOL {
                json!({ "content": [{ "type": "text", "text": choice.listing() }] })
            } else {
                tool_error(&format!(
                    "{name} is not available: this connection names no workspace. Call {TOOL} to see this account's workspaces and the address to connect with for each."
                ))
            })
        }
        "resources/list" => Ok(json!({ "resources": [] })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "resources/read" => {
            let uri = params
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Err(rpc::mcp_error(-32602, &format!("Resource {uri} not found")))
        }
        _ => Err((-32601, "Method not found".to_owned())),
    };
    match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::catalog;

    fn workspace(id: &str, slug: &str, name: &str) -> MemberWorkspace {
        MemberWorkspace {
            id: id.to_owned(),
            slug: slug.to_owned(),
            name: name.to_owned(),
        }
    }

    fn choice() -> WorkspaceChoice {
        WorkspaceChoice::new(
            "https://mcp.example.eu/",
            &[
                workspace("ws_1", "acme", "Acme"),
                workspace("ws_2", "beta bv", " Beta BV "),
            ],
        )
    }

    fn request(method: &str, params: &Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params })
    }

    #[test]
    fn each_workspace_is_listed_with_the_address_that_selects_it() {
        let answer = handle(
            &choice(),
            &request("tools/call", &json!({ "name": TOOL, "arguments": {} })),
        );
        let text = answer["result"]["content"][0]["text"]
            .as_str()
            .expect("text");
        assert!(text.contains("belongs to 2 workspaces"), "{text}");
        assert!(
            text.contains("https://mcp.example.eu/mcp doesn't say"),
            "{text}"
        );
        assert!(
            text.contains("- Acme: https://mcp.example.eu/mcp/w/acme"),
            "{text}"
        );
        // A slug that can't be a URL segment: the id selects it instead.
        assert!(
            text.contains("- Beta BV: https://mcp.example.eu/mcp/w/ws_2"),
            "{text}"
        );
        assert!(answer["result"].get("isError").is_none());
    }

    #[test]
    fn initialize_says_to_pick_a_workspace() {
        let answer = handle(
            &choice(),
            &request("initialize", &json!({ "protocolVersion": "2025-06-18" })),
        );
        let result = &answer["result"];
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert_eq!(result["serverInfo"], catalog().initialize["serverInfo"]);
        assert_eq!(result["capabilities"], catalog().initialize["capabilities"]);
        assert!(
            result["instructions"]
                .as_str()
                .expect("instructions")
                .contains("Call list_workspaces")
        );
    }

    #[test]
    fn nothing_but_the_listing_is_served() {
        let tools = handle(&choice(), &request("tools/list", &json!({})));
        assert_eq!(tools["result"]["tools"], json!([tool_definition()]));

        let other = handle(
            &choice(),
            &request(
                "tools/call",
                &json!({ "name": "search_tasks", "arguments": {} }),
            ),
        );
        assert_eq!(other["result"]["isError"], true);
        assert!(
            other["result"]["content"][0]["text"]
                .as_str()
                .expect("text")
                .starts_with("search_tasks is not available")
        );

        let resources = handle(&choice(), &request("resources/list", &json!({})));
        assert_eq!(resources["result"]["resources"], json!([]));
        let read = handle(
            &choice(),
            &request(
                "resources/read",
                &json!({ "uri": "weldsuite://workspace/info" }),
            ),
        );
        assert_eq!(read["error"]["code"], -32602);
        let unknown = handle(&choice(), &request("prompts/list", &json!({})));
        assert_eq!(unknown["error"]["code"], -32601);
        let ping = handle(&choice(), &request("ping", &json!({})));
        assert_eq!(ping["result"], json!({}));
        assert_eq!(ping["id"], 7);
    }

    #[test]
    fn no_workspace_and_many_workspaces_are_said_so() {
        let none = WorkspaceChoice::new("https://mcp.example.eu", &[]);
        assert!(none.listing().contains("not an active member of any"));

        let many: Vec<MemberWorkspace> = (0..MAX_LISTED)
            .map(|i| workspace(&format!("ws_{i}"), &format!("w{i}"), &format!("W{i}")))
            .collect();
        let listing = WorkspaceChoice::new("https://mcp.example.eu", &many).listing();
        assert!(
            listing.contains("Only the first 50 are listed"),
            "{listing}"
        );
        assert!(
            listing.contains("https://mcp.example.eu/mcp/w/<slug>"),
            "{listing}"
        );
    }
}
