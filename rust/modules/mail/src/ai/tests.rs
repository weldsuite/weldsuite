//! Mail AI over `weldsuite_ai::FakeProvider`: the requests each operation
//! sends (prompts, schemas, task and tier, the model choice) and how the
//! answers are read. The database side runs in the conformance suite
//! `mail: ai` (`routes/mail-ai/*.test.ts`).

use serde_json::{Value, json};
use weldsuite_ai::catalog::task_model;
use weldsuite_ai::fake::FakeCall;
use weldsuite_ai::{Ai, AiConfig, AiError, FakeProvider, ProviderId, Region, Task, Tier};

use super::*;

fn ai(fake: &FakeProvider) -> Ai {
    let lookup = |name: &str| match name {
        "AI_DEFAULT_PROVIDER" => Some("mistral".to_owned()),
        "MISTRAL_API_KEY" => Some("mistral-key".to_owned()),
        "AI_OPTIN_ANTHROPIC" => Some("weldsuite".to_owned()),
        "ANTHROPIC_API_KEY" => Some("anthropic-key".to_owned()),
        _ => None,
    };
    let mut problems = Vec::new();
    let config = AiConfig::from_lookup(&lookup, &mut problems);
    assert!(problems.is_empty(), "{problems:?}");
    Ai::fake(config, fake.clone())
}

fn account() -> AccountContext {
    AccountContext {
        ai_settings: json!({
            "customInstructions": "Sign as Sam.",
            "defaultTone": "friendly",
            "defaultLength": "short",
            "modelPreference": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        }),
        display_name: Some("Sam Example".to_owned()),
    }
}

fn message() -> Value {
    json!({
        "id": "mmsg_1",
        "accountId": "mail_1",
        "from": { "email": "ana@example.com", "name": "Ana" },
        "subject": "Invoice 42",
        "preview": "Preview text",
        "textBody": "Could you resend invoice 42?",
        "categories": ["ai:billing"],
    })
}

fn system_of(call: &FakeCall) -> String {
    call.body["messages"][0]["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn user_of(call: &FakeCall) -> String {
    call.body["messages"][1]["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn each_route_asks_for_its_task_tier_and_op() {
    let cases = [
        (Op::Draft, Task::Draft, Tier::Quality, "draft"),
        (Op::ImproveText, Task::Draft, Tier::Quality, "improve-text"),
        (Op::AutoDraft, Task::Draft, Tier::Quality, "auto-draft"),
        (Op::Reply, Task::Draft, Tier::Quality, "reply"),
        (Op::SmartReplies, Task::Draft, Tier::Free, "smart-replies"),
        (
            Op::InboxSummary,
            Task::Summarize,
            Tier::Free,
            "inbox-summary",
        ),
        (Op::Label, Task::Classify, Tier::Free, "label"),
        (Op::LabelBatch, Task::Classify, Tier::Free, "label"),
    ];
    for (op, task, tier, ledger) in cases {
        assert_eq!(op.task_tier(), (task, tier), "{op:?}");
        assert_eq!(op.ledger_op(), ledger, "{op:?}");
        let call = op_call("ws_1", "user_1", op, None, None);
        assert_eq!(call.feature, weldsuite_ai::Feature::Mail);
        assert_eq!((call.task, call.tier), (task, tier));
        assert_eq!(call.op_name(), ledger);
        assert_eq!(call.user_id.as_deref(), Some("user_1"));
    }
}

#[test]
fn a_requested_model_wins_over_the_accounts_preference() {
    use weldsuite_ai::RequestedModel;
    let account = account();
    let stored = op_call("ws_1", "u", Op::Draft, Some(&account), None);
    assert_eq!(
        stored.model,
        Some(RequestedModel::Stored(
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast".to_owned()
        ))
    );
    let requested = op_call(
        "ws_1",
        "u",
        Op::Draft,
        Some(&account),
        Some("mistral/mistral-small-2603"),
    );
    assert_eq!(
        requested.model,
        Some(RequestedModel::Request(
            "mistral/mistral-small-2603".to_owned()
        ))
    );
    // `explicit || preference`: a blank model id is none.
    let blank = op_call("ws_1", "u", Op::Draft, Some(&account), Some("  "));
    assert!(matches!(blank.model, Some(RequestedModel::Stored(_))));
    assert_eq!(op_call("ws_1", "u", Op::Draft, None, None).model, None);
}

#[test]
fn the_system_prompt_names_the_account_and_its_instructions() {
    assert_eq!(
        base_system(Some(&account()), "Role."),
        "Role.\nYou are writing on behalf of Sam Example.\nAlways follow these instructions: Sign as Sam.\nWrite plain text only — no markdown, and no preamble like \"Here is your email\"."
    );
    assert_eq!(
        base_system(None, "Role."),
        "Role.\nWrite plain text only — no markdown, and no preamble like \"Here is your email\"."
    );
}

#[test]
fn the_message_context_reads_as_typescript_writes_it() {
    assert_eq!(
        message_context(&message()),
        "From: Ana <ana@example.com>\nSubject: Invoice 42\n\nCould you resend invoice 42?"
    );
    // `textBody || preview || ''`, `subject ?? '(no subject)'`, 6000 units.
    let sparse =
        json!({ "from": { "email": "x@y.z" }, "subject": null, "textBody": "", "preview": "p" });
    assert_eq!(
        message_context(&sparse),
        "From:  <x@y.z>\nSubject: (no subject)\n\np"
    );
    let long = json!({ "from": null, "textBody": "é".repeat(7000) });
    assert_eq!(
        message_context(&long).chars().filter(|c| *c == 'é').count(),
        6000
    );
}

#[tokio::test]
async fn a_draft_is_a_structured_quality_call_with_the_typescript_prompt() {
    let fake = FakeProvider::new()
        .reply_json(&json!({ "subject": "Re: Invoice 42", "body": "Here it is." }));
    let ai = ai(&fake);
    let account = account();
    let message = message();
    let call = op_call("ws_1", "user_1", Op::Draft, None, None);
    let request = draft_request(
        Some(&account),
        Some(&message),
        "send the invoice again",
        None,
        account.default_length(),
    );
    let (object, response) = object_call(&ai, &call, request).await.expect("draft");
    assert_eq!(
        pick(&object, &["subject", "body"]),
        json!({ "subject": "Re: Invoice 42", "body": "Here it is." })
    );
    assert_eq!(response.served.provider, ProviderId::Mistral);
    assert_eq!(response.served.region, Region::Eu);
    assert_eq!(
        Some(response.served.model.as_str()),
        task_model(ProviderId::Mistral, Task::Draft, Tier::Quality)
    );
    assert_eq!(response.served.meta()["provider"], "mistral");

    let calls = fake.calls();
    assert_eq!(calls.len(), 1);
    let sent = &calls[0];
    assert!(sent.url.ends_with("/chat/completions"));
    assert_eq!(sent.body["response_format"]["type"], "json_schema");
    assert_eq!(
        sent.body["response_format"]["json_schema"]["schema"],
        email_schema()
    );
    assert_eq!(
        system_of(sent),
        base_system(
            Some(&account),
            "You are an expert email-writing assistant. Write a complete, ready-to-send email."
        )
    );
    assert_eq!(
        user_of(sent),
        "Tone: professional and polished.\nLength: 1–2 short paragraphs.\nYou are drafting a reply to this email:\n\nFrom: Ana <ana@example.com>\nSubject: Invoice 42\n\nCould you resend invoice 42?\n\nWrite an email that: send the invoice again\nReturn a concise subject line and the email body."
    );
}

#[tokio::test]
async fn a_model_the_workspace_policy_refuses_is_not_allowed() {
    let fake = FakeProvider::new();
    let ai = ai(&fake);
    // Anthropic is offered by the install but not enabled for the workspace.
    let call = op_call(
        "ws_1",
        "u",
        Op::Draft,
        None,
        Some("anthropic/claude-sonnet-5-5"),
    );
    let error = ai.assert_credits(&call).await.expect_err("refused");
    assert!(
        matches!(error, AiError::ModelNotAllowed { .. }),
        "{error:?}"
    );
    // A stored preference the policy refuses is skipped instead.
    let stored = op_call("ws_1", "u", Op::Draft, Some(&account()), None);
    let route = ai.route(&stored).await.expect("route");
    assert_eq!(route.primary.provider, ProviderId::Mistral);
    assert!(fake.calls().is_empty());
}

#[test]
fn auto_draft_prompts_follow_the_reply_or_the_inbox() {
    let account = account();
    let reply = auto_draft_request(&account, Some(&message()), &[], None);
    assert_eq!(
        reply.system.as_deref(),
        Some(
            base_system(
                Some(&account),
                "You are an email-writing assistant. Draft a reply to the email below."
            )
            .as_str()
        )
    );
    let weldsuite_ai::Part::Text(text) = &reply.messages[0].content[0] else {
        panic!("text");
    };
    assert!(text.starts_with(
        "Tone: warm and friendly.\nLength: 1–2 short paragraphs.\nReply to this email:"
    ));
    assert!(
        text.ends_with("Write an appropriate reply.\nReturn a subject line and the email body.")
    );

    let recent = vec![
        json!({ "from": { "email": "a@x.io" }, "subject": "Hello", "preview": "Hi there" }),
        json!({ "from": null, "subject": null, "preview": null }),
    ];
    let inbox = auto_draft_request(&account, None, &recent, Some("ask for a meeting"));
    let weldsuite_ai::Part::Text(text) = &inbox.messages[0].content[0] else {
        panic!("text");
    };
    assert_eq!(
        text,
        "Tone: warm and friendly.\nLength: 1–2 short paragraphs.\nRecent inbox context:\n- a@x.io: Hello — Hi there\n- : (no subject) — \n\nThe user's intent: ask for a meeting\nReturn a subject line and the email body."
    );
    assert_eq!(
        inbox.response_schema.map(|s| s.schema),
        Some(email_schema())
    );
}

#[tokio::test]
async fn improve_and_reply_are_trimmed_text_answers() {
    let fake = FakeProvider::new().reply_text("  Thanks, Ana!\n");
    let ai = ai(&fake);
    let (system, prompt) = reply_prompt(None, Some(&message()), Some("brief"), None);
    let call = op_call("ws_1", "u", Op::Reply, None, None);
    let (text, _) = text_call(&ai, &call, system, prompt).await.expect("reply");
    assert_eq!(text, "Thanks, Ana!");
    let sent = &fake.calls()[0];
    assert!(sent.body.get("response_format").is_none());
    assert_eq!(
        user_of(sent),
        "Tone: brief and direct.\nReply to this email:\n\nFrom: Ana <ana@example.com>\nSubject: Invoice 42\n\nCould you resend invoice 42?\n\nWrite an appropriate reply."
    );
    assert_eq!(
        improve_instruction("make_friendly"),
        "Rewrite the text in a warmer, friendlier tone."
    );
    assert_eq!(
        improve_instruction("improve"),
        "Improve the clarity, grammar, and flow of the text while preserving its meaning and intent."
    );
}

#[test]
fn the_summary_marks_unread_messages() {
    let recent = vec![
        json!({ "from": { "email": "a@x.io" }, "subject": "One", "preview": "p1", "isRead": true }),
        json!({ "from": { "email": "b@x.io" }, "subject": "Two", "preview": "p2", "isRead": false }),
        json!({ "from": { "email": "c@x.io" }, "subject": "Three", "preview": "p3", "isRead": null }),
    ];
    assert_eq!(
        summary_prompt(&recent),
        "Summarise these recent emails:\n\n1. a@x.io: One — p1\n2. [unread] b@x.io: Two — p2\n3. [unread] c@x.io: Three — p3"
    );
}

#[tokio::test]
async fn smart_replies_and_labels_read_their_structured_answers() {
    let fake = FakeProvider::new()
        .reply_json(&json!({ "replies": ["Yes", "No", "Later", "Maybe"] }))
        .reply_json(&json!({ "category": "billing", "priority": "high" }));
    let ai = ai(&fake);
    let call = op_call("ws_1", "u", Op::SmartReplies, None, None);
    let (object, _) = object_call(&ai, &call, smart_replies_request(None, &message()))
        .await
        .expect("replies");
    assert_eq!(object["replies"].as_array().map(Vec::len), Some(4));

    let call = op_call("ws_1", "u", Op::Label, None, None);
    let (category, priority, response) = classify_one(&ai, call, &message()).await.expect("label");
    assert_eq!(category, "billing");
    assert_eq!(priority, json!("high"));
    assert_eq!(
        Some(response.served.model.as_str()),
        task_model(ProviderId::Mistral, Task::Classify, Tier::Free)
    );

    let calls = fake.calls();
    assert_eq!(
        calls[0].body["response_format"]["json_schema"]["schema"],
        replies_schema()
    );
    assert!(user_of(&calls[0]).starts_with(
        "Suggest 3 brief, distinct reply options (e.g. an affirmative, a decline, and a follow-up) to this email:\n\nFrom: Ana"
    ));
    assert_eq!(
        system_of(&calls[1]),
        "You are an email triage assistant. Classify the email into one category and a priority."
    );
    assert!(user_of(&calls[1]).starts_with(
        "Categories: sales, support, billing, personal, newsletter, notification, spam, other.\nPriorities: high, normal, low.\n\nEmail:\nFrom: Ana"
    ));
    assert_eq!(
        calls[1].body["response_format"]["json_schema"]["schema"],
        classify_schema()
    );
}

#[tokio::test]
async fn an_answer_without_its_json_is_a_failed_request() {
    let fake = FakeProvider::new()
        .reply_text("not json")
        .reply_json(&json!({ "priority": "low" }));
    let ai = ai(&fake);
    let call = op_call("ws_1", "u", Op::Label, None, None);
    let error = classify_one(&ai, call.clone(), &message())
        .await
        .expect_err("not json");
    assert!(
        matches!(error, MailAiError::Ai(AiError::Invalid(_))),
        "{error:?}"
    );
    let error = classify_one(&ai, call, &message())
        .await
        .expect_err("no category");
    assert!(
        matches!(error, MailAiError::Ai(AiError::Invalid(_))),
        "{error:?}"
    );
}

#[test]
fn a_classification_adds_its_category_once() {
    assert_eq!(
        with_category(&json!(["ai:billing", "x", "x"]), "billing"),
        json!(["ai:billing", "x"])
    );
    assert_eq!(with_category(&Value::Null, "spam"), json!(["ai:spam"]));
    assert_eq!(
        with_category(&json!(["inbox"]), "support"),
        json!(["inbox", "ai:support"])
    );
}

#[test]
fn tone_and_length_fall_back_to_the_defaults() {
    assert_eq!(tone_line(None), "Tone: professional and polished.");
    assert_eq!(
        tone_line(Some("casual")),
        "Tone: casual and conversational."
    );
    assert_eq!(tone_line(Some("odd")), "Tone: professional and polished.");
    assert_eq!(length_line(Some("long")), "Length: thorough and detailed.");
    assert_eq!(
        length_line(Some("medium")),
        "Length: a few concise paragraphs."
    );
    // A set but non-text default still counts as set (`??`), and reads as
    // the default line.
    let odd = AccountContext {
        ai_settings: json!({ "defaultTone": 3 }),
        display_name: None,
    };
    assert_eq!(odd.default_tone(), Some(""));
    assert_eq!(
        account().model_preference(),
        Some("@cf/meta/llama-3.3-70b-instruct-fp8-fast")
    );
}
