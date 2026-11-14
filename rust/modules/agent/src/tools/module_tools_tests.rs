//! The spreadsheet, board and WeldMerge tools against a recording stand-in for
//! the modules ([`ModuleTools`]): the arguments the modules get, the shape of
//! what the tools answer, and that a tool the grants do not cover is not there.

use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Value, json};
use weldsuite_ports::BoxFuture;

use super::modules::{ModuleCall, ModuleTools, install_module_tools};
use super::{ToolContext, ToolError, execute_tool};

type Recorded = (String, String, Option<String>, Value, String);

/// Records every call and answers by operation.
struct Fake {
    calls: Mutex<Vec<Recorded>>,
}

impl ModuleTools for Fake {
    fn call<'a>(&'a self, call: ModuleCall<'a>) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((
                call.module.to_owned(),
                call.op.to_owned(),
                call.id.map(str::to_owned),
                call.input.clone(),
                call.user_id.to_owned(),
            ));
            match (call.module, call.op) {
                ("sheets", "find") => {
                    Ok(json!([{ "id": "sht_t", "name": "Budget", "role": "owner" }]))
                }
                ("sheets", "read") => Err("Spreadsheet with ID 'nope' not found".to_owned()),
                ("boards", "create") => Ok(
                    json!({ "id": "brd_t", "name": call.input["name"], "url": "/weldboard/brd_t" }),
                ),
                ("boards", "add") => Ok(json!({ "revision": 3, "elementIds": ["e1"] })),
                ("boards", "update") => Ok(json!({ "name": "Renamed", "url": "/weldboard/brd_t" })),
                ("boards", "edit") => {
                    Ok(json!({ "revision": 4, "changed": ["e1"], "skipped": [] }))
                }
                ("merge", _) => Ok(Value::Null),
                _ => Ok(json!({})),
            }
        })
    }
}

/// Installs the shared stand-in for the process (tests in parallel share it).
pub(crate) fn install_fake() {
    install_module_tools(fake());
}

fn fake() -> Arc<Fake> {
    static FAKE: OnceLock<Arc<Fake>> = OnceLock::new();
    FAKE.get_or_init(|| {
        Arc::new(Fake {
            calls: Mutex::new(Vec::new()),
        })
    })
    .clone()
}

fn ctx(grants: &[&str], user: &str) -> ToolContext {
    install_module_tools(fake());
    ToolContext {
        db: sqlx::PgPool::connect_lazy("postgres://localhost/none").unwrap(),
        agent_id: "agt_1".into(),
        actor_user_id: user.into(),
        workspace_id: "ws_1".into(),
        agent_permissions: grants.iter().map(|g| (*g).to_owned()).collect(),
        enabled_tools: Vec::new(),
        user_timezone: None,
        actor_permissions: None,
        actor_can_edit: None,
        row_scope: None,
        events: None,
        sandbox: false,
        channel_id: None,
        conversation_id: None,
        agent_hop: 0,
        max_agent_hops: 2,
        master: None,
        realtime: None,
        ai: None,
    }
}

/// What `user`'s tools called (users are unique per test, the stand-in is shared).
pub(crate) fn calls_of(user: &str) -> Vec<(String, String, Option<String>, Value)> {
    fake()
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.4 == user)
        .map(|c| (c.0.clone(), c.1.clone(), c.2.clone(), c.3.clone()))
        .collect()
}

#[tokio::test]
async fn sheet_tools_run_as_the_person_and_shape_the_answer() {
    let c = ctx(&["sheets:read"], "u_sheet");
    let found = execute_tool(&c, "find_spreadsheets", &json!({ "query": "bud" }))
        .await
        .unwrap();
    assert_eq!(found["spreadsheets"][0]["name"], "Budget");
    let read = execute_tool(
        &c,
        "read_spreadsheet_range",
        &json!({ "spreadsheetId": "nope" }),
    )
    .await
    .unwrap();
    assert_eq!(read["error"], "Spreadsheet with ID 'nope' not found");
    let calls = calls_of("u_sheet");
    assert_eq!(calls[0].1, "find");
    assert_eq!(calls[1].2.as_deref(), Some("nope"));
    // The sheet id is the route's path, not its body.
    assert!(calls[1].3.get("spreadsheetId").is_none());
    // Without the update grant the write tool is not there at all.
    let refused = execute_tool(
        &c,
        "write_spreadsheet_range",
        &json!({ "spreadsheetId": "s", "values": [[1]] }),
    )
    .await;
    assert!(matches!(refused, Err(ToolError::UnknownTool(_))));
}

#[tokio::test]
async fn creating_a_board_with_content_adds_it_after() {
    let c = ctx(&["boards:create"], "u_board");
    let made = execute_tool(
        &c,
        "create_board",
        &json!({ "name": "Retro", "content": { "items": [{ "type": "sticky", "text": "Hi" }] } }),
    )
    .await
    .unwrap();
    assert_eq!(made["id"], "brd_t");
    assert_eq!(made["content"]["revision"], 3);
    let calls = calls_of("u_board");
    assert_eq!(
        calls.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(),
        ["create", "add"]
    );
    assert_eq!(calls[1].2.as_deref(), Some("brd_t"));
    assert_eq!(calls[1].3["spec"]["items"][0]["text"], "Hi");
}

#[tokio::test]
async fn a_board_update_renames_then_edits_and_needs_something_to_do() {
    let c = ctx(&["boards:update"], "u_upd");
    let none = execute_tool(&c, "update_board", &json!({ "boardId": "brd_t" }))
        .await
        .unwrap();
    assert_eq!(none["error"], "Send a name or changes");
    let both = execute_tool(
        &c,
        "update_board",
        &json!({ "boardId": "brd_t", "name": "Renamed", "changes": [{ "id": "e1", "delete": true }] }),
    )
    .await
    .unwrap();
    assert_eq!(both["name"], "Renamed");
    assert_eq!(both["changed"][0], "e1");
    assert_eq!(
        calls_of("u_upd")
            .iter()
            .map(|c| c.1.as_str())
            .collect::<Vec<_>>(),
        ["update", "edit"]
    );
}

#[tokio::test]
async fn merge_tools_pass_their_name_and_an_empty_answer_is_ok() {
    let c = ctx(&["merge_issues:read"], "u_merge");
    let out = execute_tool(&c, "merge_get_issue", &json!({ "issue": "PLAT-1" }))
        .await
        .unwrap();
    assert_eq!(out, json!({ "ok": true }));
    let calls = calls_of("u_merge");
    assert_eq!(calls[0].0, "merge");
    assert_eq!(calls[0].1, "merge_get_issue");
    let refused = execute_tool(
        &c,
        "merge_create_issue",
        &json!({ "teamId": "t", "title": "x" }),
    )
    .await;
    assert!(matches!(refused, Err(ToolError::UnknownTool(_))));
}

#[test]
fn the_catalog_is_the_global_one_without_the_in_sandbox_tools() {
    let catalog = super::list_tool_catalog();
    let ids: Vec<&str> = catalog
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 39, "{ids:?}");
    assert!(ids.contains(&"browser.open"));
    assert!(!ids.contains(&"sandbox.exec"));
    assert!(!ids.contains(&"web.search"));
    let permissions = super::list_tool_permissions();
    assert_eq!(permissions.len(), 20, "{permissions:?}");
    assert!(!permissions.iter().any(|p| p == "computer:use"));
    // The model is still offered the sandbox tools.
    assert!(
        super::platform_tools()
            .iter()
            .any(|t| t.id == "sandbox.exec")
    );
}

#[test]
fn every_global_tool_is_in_the_registry() {
    let ids: Vec<&str> = super::platform_tools().iter().map(|t| t.id).collect();
    for id in super::PORTED {
        assert!(ids.contains(&id), "{id}");
    }
    assert!(super::LEFT_OUT.is_empty());
    let permissions = super::list_tool_permissions();
    for key in [
        "tickets:read",
        "tickets:create",
        "sheets:read",
        "sheets:update",
        "boards:read",
        "merge_issues:read",
        "merge_pull_requests:review",
        "merge_connections:read",
        "browser:use",
    ] {
        assert!(permissions.iter().any(|p| p == key), "{key}");
    }
}
