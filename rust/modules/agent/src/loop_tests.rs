//! The agent loop end to end, on `weldsuite_ai::Ai::fake` (`FakeProvider`): a
//! tool call followed by the final answer, through the chat turn
//! ([`agent_turn`]) and the assistant seam ([`chat_once`]).
//!
//! What they pin: the tool runs with the caller's permissions (the agent's
//! grants narrowed to the person), a high-risk tool is held for approval
//! instead of running, the conversation's messages are stored with the tool
//! steps, and each model call is exactly one call of the AI layer (two
//! requests, two fake calls, nothing charged without a master database).
//!
//! They need the tenant schema, built from the journaled migrations by
//! `scripts/rust-test-db.ts` as CI does, so they run when
//! `WELDSUITE_TEST_TENANT_URL` is set and return early otherwise.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ai::config::Endpoint;
use weldsuite_ai::{Ai, AiConfig, FakeProvider, ProviderId};

use crate::agents::{CreateAgent, POLICY_DEFAULT_MODEL, create_agent};
use crate::assistant::{AgentChat, chat_once};
use crate::conversations::get_or_create_main;
use crate::run::{RunEnv, TurnParams, agent_turn};
use crate::tools::module_tools_tests::{calls_of, install_fake};

fn config() -> AiConfig {
    AiConfig {
        default_provider: Some(ProviderId::Mistral),
        mistral: Endpoint {
            base_url: "https://example.test/v1".to_owned(),
            api_key: Some("mistral-key".to_owned()),
        },
        ..AiConfig::default()
    }
}

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy(&url)
            .expect("tenant pool"),
    )
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|i| (*i).to_owned()).collect()
}

async fn agent(db: &PgPool, grants: &[&str]) -> Value {
    create_agent(
        db,
        CreateAgent {
            name: "Loop test".to_owned(),
            system_prompt: Some("Work on sheets and tickets when asked in chat.".to_owned()),
            permissions: strings(grants),
            created_by: Some("user_owner".to_owned()),
            default_model: POLICY_DEFAULT_MODEL.to_owned(),
            ..CreateAgent::default()
        },
    )
    .await
    .expect("agent")
}

fn tool_names(call: &weldsuite_ai::fake::FakeCall) -> Vec<String> {
    let mut names: Vec<String> = call.body["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

async fn messages_of(db: &PgPool, conversation_id: &str) -> Vec<Value> {
    sqlx::query_scalar::<_, Value>(
        "select to_jsonb(m) from weldagent_messages m where m.conversation_id = $1
         order by m.created_at, m.id",
    )
    .bind(conversation_id)
    .fetch_all(db)
    .await
    .expect("messages")
    .into_iter()
    .map(weldsuite_db::js_row)
    .collect()
}

#[tokio::test]
async fn a_chat_turn_runs_the_tool_as_the_person_and_stores_the_steps() {
    let Some(db) = tenant() else { return };
    install_fake();
    // The agent may read and write sheets; the person only reads.
    let agent = agent(&db, &["sheets:read", "sheets:update"]).await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();
    let user = format!("user_loop_{}", &agent_id[agent_id.len() - 6..]);
    let conversation = get_or_create_main(&db, &user, &agent_id, "Loop test")
        .await
        .expect("conversation");
    let conversation_id = conversation["id"].as_str().unwrap().to_owned();

    let fake = FakeProvider::new()
        .reply_tool_call(
            "read_spreadsheet_range",
            &json!({ "spreadsheetId": "sht_loop" }),
        )
        .reply_text("The sheet is empty.");
    let ai = Ai::fake(config(), fake.clone());
    let done = agent_turn(
        Some(&ai),
        TurnParams {
            db: db.clone(),
            workspace_id: "ws_loop".to_owned(),
            user_id: user.clone(),
            conversation_id: conversation_id.clone(),
            content: "What is in the sheet?".to_owned(),
            agent_id: None,
            actor_permissions: strings(&["weldagent:use", "weldagent:read", "sheets:read"]),
            timezone: None,
            wait: true,
            events: None,
            env: RunEnv::default(),
        },
    )
    .await
    .expect("turn");
    assert_eq!(done["status"], "completed", "{done}");
    assert_eq!(done["success"], true, "{done}");
    assert_eq!(done["assistantMessage"]["content"], "The sheet is empty.");
    // Nothing is charged without a master database.
    assert_eq!(done["creditsUsed"], 0);

    // Two model requests: the call, then the answer with the tool's result.
    let calls = fake.calls();
    assert_eq!(calls.len(), 2);
    // The person's role narrowed the agent: reading, not writing.
    assert_eq!(
        tool_names(&calls[0])
            .iter()
            .filter(|n| n.contains("spreadsheet"))
            .cloned()
            .collect::<Vec<_>>(),
        ["list_spreadsheet_tabs", "read_spreadsheet_range"]
    );
    assert!(
        calls[1].body["messages"]
            .to_string()
            .contains("\"role\":\"tool\"")
    );
    // The tool reached the sheets module as that person.
    let reached = calls_of(&user);
    assert_eq!(reached.len(), 1, "{reached:?}");
    assert_eq!(reached[0].0, "sheets");
    assert_eq!(reached[0].2.as_deref(), Some("sht_loop"));

    // The conversation: the question, then the answer with the tool step.
    let stored = messages_of(&db, &conversation_id).await;
    let roles: Vec<&str> = stored.iter().filter_map(|m| m["role"].as_str()).collect();
    assert_eq!(roles, ["user", "assistant"]);
    assert_eq!(stored[1]["content"], "The sheet is empty.");
    let step = &stored[1]["toolInvocations"][0];
    assert_eq!(step["toolName"], "read_spreadsheet_range");
    assert_eq!(step["state"], "result");
}

#[tokio::test]
async fn a_high_risk_tool_is_held_for_approval_and_the_model_is_told() {
    let Some(db) = tenant() else { return };
    let agent = agent(&db, &["tickets:create"]).await;
    let agent_id = agent["id"].as_str().unwrap().to_owned();
    let fake = FakeProvider::new()
        .reply_tool_call("create_ticket", &json!({ "subject": "Printer is on fire" }))
        .reply_text("I asked for approval.");
    let ai = Ai::fake(config(), fake.clone());
    let done = chat_once(
        Some(&ai),
        AgentChat {
            db: db.clone(),
            workspace_id: "ws_loop".to_owned(),
            actor_user_id: "user_approver".to_owned(),
            agent: agent.clone(),
            messages: vec![(
                "user".to_owned(),
                "Open a ticket for the printer".to_owned(),
            )],
            model: None,
            temperature: None,
            max_tokens: None,
            extra_system: None,
            actor_permissions: strings(&["tickets:create", "weldagent:use"]),
            env: RunEnv::default(),
            events: None,
        },
    )
    .await
    .expect("chat");
    assert_eq!(done["text"], "I asked for approval.");
    assert_eq!(done["creditsUsed"], 0);
    // The ticket was not created: the call parked an approval.
    let step = &done["toolInvocations"][0];
    assert_eq!(step["toolName"], "create_ticket");
    assert_eq!(step["result"]["pendingApproval"], true, "{step}");
    let (tool, risk, status): (String, String, String) = sqlx::query_as(
        "select tool_name, risk_level, status from weldagent_approvals where agent_id = $1",
    )
    .bind(&agent_id)
    .fetch_one(&db)
    .await
    .expect("approval row");
    assert_eq!(
        (tool.as_str(), risk.as_str(), status.as_str()),
        ("create_ticket", "high", "pending")
    );
    let tickets: i64 = sqlx::query_scalar(
        "select count(*) from desk_conversations where title = 'Printer is on fire'",
    )
    .fetch_one(&db)
    .await
    .expect("count");
    assert_eq!(tickets, 0);
    // The model heard that the action waits.
    let second = fake.calls()[1].body["messages"].to_string();
    assert!(second.contains("Held for approval"), "{second}");
    assert_eq!(fake.calls().len(), 2);
}
