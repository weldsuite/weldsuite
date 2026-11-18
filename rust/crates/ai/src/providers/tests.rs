//! The call loop over [`FakeProvider`]: request shaping per provider as
//! sent, fallback chains, retries, streaming, OCR, embeddings,
//! transcription and key checks.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::json;
use weldsuite_ports::HttpResponse;

use super::*;
use crate::catalog::{Feature, Region, Task, Tier};
use crate::config::{Endpoint, KeySources};
use crate::fake::{FAKE_INPUT_TOKENS, FAKE_OUTPUT_TOKENS, FakeProvider};

fn config() -> AiConfig {
    let endpoint = |url: &str, key: &str| Endpoint {
        base_url: url.to_owned(),
        api_key: Some(key.to_owned()),
    };
    AiConfig {
        default_provider: Some(ProviderId::Mistral),
        mistral: endpoint("https://api.mistral.ai/v1", "mistral-key"),
        anthropic: endpoint("https://api.anthropic.com", "anthropic-key"),
        openai: endpoint("https://api.openai.com/v1/", "openai-key"),
        opt_in: BTreeMap::from([
            (
                ProviderId::Anthropic,
                KeySources {
                    weldsuite: true,
                    own: true,
                },
            ),
            (
                ProviderId::OpenAi,
                KeySources {
                    weldsuite: true,
                    own: true,
                },
            ),
        ]),
        ..AiConfig::default()
    }
}

fn target(provider: ProviderId, model: &str, key_source: KeySource) -> Target {
    Target {
        provider,
        model: model.to_owned(),
        region: if provider.opt_in() {
            Region::OutsideEu
        } else {
            Region::Eu
        },
        key_source,
    }
}

fn mistral(model: &str) -> Target {
    target(ProviderId::Mistral, model, KeySource::Weldsuite)
}

fn route(primary: Target, fallbacks: Vec<Target>) -> Route {
    Route { primary, fallbacks }
}

fn call() -> AiCall {
    AiCall::new("ws_1", Feature::Mail, Task::Draft, Tier::Quality)
}

#[tokio::test]
async fn a_chat_goes_to_mistral_with_its_key_and_model() {
    let fake = FakeProvider::new().reply_text("Hello!");
    let ai = Ai::fake(config(), fake.clone());
    let answer = ai
        .chat(
            &call(),
            ChatRequest::system_user("Be kind.", "Hi").temperature(0.2),
        )
        .await
        .expect("answer");
    assert_eq!(answer.text, "Hello!");
    assert_eq!(answer.usage.input_tokens, FAKE_INPUT_TOKENS);
    assert_eq!(answer.usage.output_tokens, FAKE_OUTPUT_TOKENS);
    assert_eq!(answer.served.provider, ProviderId::Mistral);
    assert_eq!(answer.served.model, "mistral/mistral-large-4-0");
    assert_eq!(answer.served.fallback_from, None);
    assert_eq!(
        answer.served.meta(),
        json!({ "provider": "mistral", "model": "mistral/mistral-large-4-0", "region": "eu" })
    );
    // No master database: unmetered.
    assert_eq!(answer.credits, 0);
    let calls = fake.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].url, "https://api.mistral.ai/v1/chat/completions");
    assert_eq!(calls[0].header("authorization"), Some("Bearer mistral-key"));
    assert_eq!(calls[0].model().as_deref(), Some("mistral-large-4-0"));
    assert_eq!(calls[0].body["messages"][0]["content"], "Be kind.");
}

#[tokio::test]
async fn ai_off_answers_unavailable_and_calls_nothing() {
    let fake = FakeProvider::new();
    let ai = Ai::fake(AiConfig::default(), fake.clone());
    assert!(!ai.enabled());
    assert!(matches!(
        ai.chat(&call(), ChatRequest::system_user("s", "u")).await,
        Err(AiError::Unavailable)
    ));
    assert!(fake.calls().is_empty());
}

#[tokio::test]
async fn a_structured_answer_parses_on_both_apis() {
    let schema = json!({ "type": "object", "properties": { "label": { "type": "string" } } });
    let fake = FakeProvider::new()
        .reply_json(&json!({ "label": "lead" }))
        .reply_json(&json!({ "label": "spam" }));
    let ai = Ai::fake(config(), fake.clone());
    let request = ChatRequest::system_user("Label it.", "Buy now").schema("labels", schema);
    let on_mistral = chat(
        &ai,
        &call(),
        &route(mistral("mistral/mistral-small-2603"), vec![]),
        request.clone(),
    )
    .await
    .expect("mistral");
    assert_eq!(on_mistral.object, Some(json!({ "label": "lead" })));
    let claude = target(
        ProviderId::Anthropic,
        "anthropic/claude-haiku-5-5",
        KeySource::Weldsuite,
    );
    let on_claude = chat(&ai, &call(), &route(claude, vec![]), request)
        .await
        .expect("claude");
    assert_eq!(on_claude.object, Some(json!({ "label": "spam" })));
    let calls = fake.calls();
    assert_eq!(
        calls[0].body["response_format"]["json_schema"]["name"],
        "labels"
    );
    assert_eq!(calls[1].url, "https://api.anthropic.com/v1/messages");
    assert_eq!(calls[1].header("x-api-key"), Some("anthropic-key"));
    assert_eq!(calls[1].header("anthropic-version"), Some("2023-06-01"));
    assert_eq!(
        calls[1].body["tool_choice"],
        json!({ "type": "tool", "name": "labels" })
    );
    assert_eq!(calls[1].model().as_deref(), Some("claude-haiku-5-5"));
}

#[tokio::test]
async fn a_refusal_falls_back_to_mistral_never_the_other_way() {
    let fake = FakeProvider::new()
        .reply_status(
            529,
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        )
        .reply_text("from Mistral");
    let ai = Ai::fake(config(), fake.clone());
    let primary = target(
        ProviderId::Anthropic,
        "anthropic/claude-sonnet-5-5",
        KeySource::Weldsuite,
    );
    let answer = chat(
        &ai,
        &call(),
        &route(primary, vec![mistral("mistral/mistral-large-4-0")]),
        ChatRequest::system_user("s", "u"),
    )
    .await
    .expect("fallback");
    assert_eq!(answer.text, "from Mistral");
    assert_eq!(answer.served.provider, ProviderId::Mistral);
    assert_eq!(answer.served.key_source, KeySource::Weldsuite);
    assert_eq!(
        answer.served.fallback_from.as_deref(),
        Some("anthropic/claude-sonnet-5-5")
    );
    let urls: Vec<String> = fake.calls().into_iter().map(|c| c.url).collect();
    assert_eq!(
        urls,
        vec![
            "https://api.anthropic.com/v1/messages".to_owned(),
            "https://api.mistral.ai/v1/chat/completions".to_owned()
        ]
    );
}

#[tokio::test]
async fn a_bad_request_does_not_fall_back() {
    let fake = FakeProvider::new().reply_status(400, r#"{"error":{"message":"bad schema"}}"#);
    let ai = Ai::fake(config(), fake.clone());
    let primary = target(ProviderId::OpenAi, "openai/gpt-5", KeySource::Weldsuite);
    let error = chat(
        &ai,
        &call(),
        &route(primary, vec![mistral("mistral/mistral-large-4-0")]),
        ChatRequest::system_user("s", "u"),
    )
    .await
    .expect_err("bad request");
    match error {
        AiError::Provider {
            provider,
            status,
            message,
        } => {
            assert_eq!(provider, ProviderId::OpenAi);
            assert_eq!(status, Some(400));
            assert_eq!(message, "bad schema");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(fake.calls().len(), 1);
    // A credit message in a 400 is a refusal (Anthropic's exhausted balance).
    let fake = FakeProvider::new()
        .reply_status(
            400,
            r#"{"error":{"message":"Your credit balance is too low"}}"#,
        )
        .reply_text("ok");
    let ai = Ai::fake(config(), fake.clone());
    let primary = target(
        ProviderId::Anthropic,
        "anthropic/claude-sonnet-5-5",
        KeySource::Weldsuite,
    );
    let answer = chat(
        &ai,
        &call(),
        &route(primary, vec![mistral("mistral/mistral-large-4-0")]),
        ChatRequest::system_user("s", "u"),
    )
    .await
    .expect("fallback");
    assert_eq!(answer.served.provider, ProviderId::Mistral);
}

#[tokio::test]
async fn the_last_refusal_is_the_error() {
    let fake = FakeProvider::new()
        .reply_status(503, "down")
        .reply_status(502, "also down");
    let ai = Ai::fake(config(), fake.clone());
    let primary = target(ProviderId::OpenAi, "openai/gpt-5", KeySource::Weldsuite);
    let error = chat(
        &ai,
        &call(),
        &route(primary, vec![mistral("mistral/mistral-large-4-0")]),
        ChatRequest::system_user("s", "u"),
    )
    .await
    .expect_err("both refused");
    assert_eq!(error.provider_status(), Some(502));
}

#[tokio::test(start_paused = true)]
async fn a_429_is_retried_honouring_retry_after() {
    let mut limited = HttpResponse::new(429, b"slow down".to_vec());
    limited
        .headers
        .push(("retry-after".to_owned(), "3".to_owned()));
    let fake = FakeProvider::new()
        .reply(limited)
        .reply_text("after the wait");
    let ai = Ai::fake(config(), fake.clone());
    let started = tokio::time::Instant::now();
    let answer = ai
        .chat(&call(), ChatRequest::system_user("s", "u"))
        .await
        .expect("answer");
    assert_eq!(answer.text, "after the wait");
    assert!(started.elapsed() >= Duration::from_secs(3));
    assert_eq!(fake.calls().len(), 2);
    assert!(fake.calls().iter().all(|c| c.url.contains("mistral")));
}

#[tokio::test(start_paused = true)]
async fn a_429_that_persists_falls_back() {
    let fake = FakeProvider::new()
        .reply_status(429, "limited")
        .reply_status(429, "limited")
        .reply_status(429, "limited")
        .reply_text("fallback");
    let ai = Ai::fake(config(), fake.clone());
    let primary = target(
        ProviderId::OpenAi,
        "openai/gpt-5-mini",
        KeySource::Weldsuite,
    );
    let answer = chat(
        &ai,
        &call(),
        &route(primary, vec![mistral("mistral/mistral-small-2603")]),
        ChatRequest::system_user("s", "u"),
    )
    .await
    .expect("fallback");
    assert_eq!(answer.served.model, "mistral/mistral-small-2603");
    assert_eq!(fake.calls().len(), 4);
}

#[tokio::test]
async fn an_own_key_that_cant_be_read_falls_back_to_weldsuites_mistral() {
    let fake = FakeProvider::new().reply_text("mistral");
    let mut config = config();
    config.keys_encryption_key = Some([3; 32]);
    let ai = Ai::fake(config, fake.clone());
    // No tenant database on the call: the own key can't be read.
    let primary = target(
        ProviderId::Anthropic,
        "anthropic/claude-sonnet-5-5",
        KeySource::Own,
    );
    let answer = chat(
        &ai,
        &call(),
        &route(primary, vec![mistral("mistral/mistral-large-4-0")]),
        ChatRequest::system_user("s", "u"),
    )
    .await
    .expect("fallback");
    assert_eq!(answer.served.provider, ProviderId::Mistral);
    assert_eq!(answer.served.key_source, KeySource::Weldsuite);
    // Anthropic was never called without a key.
    assert_eq!(fake.calls().len(), 1);
}

async fn collect(stream: ChatStream) -> Vec<StreamEvent> {
    stream
        .map(|event| event.expect("event"))
        .collect::<Vec<_>>()
        .await
}

#[tokio::test]
async fn an_openai_compatible_stream_yields_deltas_then_the_answer() {
    let fake = FakeProvider::new().reply_text("Hello there");
    let ai = Ai::fake(config(), fake.clone());
    let events = collect(
        ai.chat_stream(&call(), ChatRequest::system_user("s", "u"))
            .await
            .expect("stream"),
    )
    .await;
    let deltas: String = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::TextDelta(text) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, "Hello there");
    let Some(StreamEvent::Finish(answer)) = events.last() else {
        panic!("finish last: {events:?}");
    };
    assert_eq!(answer.text, "Hello there");
    assert_eq!(answer.usage.input_tokens, FAKE_INPUT_TOKENS);
    assert_eq!(answer.served.provider, ProviderId::Mistral);
    let sent = &fake.calls()[0];
    assert_eq!(sent.body["stream"], true);
    // Mistral rejects `stream_options`.
    assert!(sent.body.get("stream_options").is_none());
}

#[tokio::test]
async fn a_stream_tool_call_comes_before_the_finish() {
    let fake = FakeProvider::new()
        .reply_tool_call("lookup", &json!({ "q": "x" }))
        .reply_tool_call("lookup", &json!({ "q": "y" }));
    let ai = Ai::fake(config(), fake.clone());
    let mut request = ChatRequest::system_user("s", "u");
    request.tools.push(crate::types::ToolDef {
        name: "lookup".to_owned(),
        description: "Look it up".to_owned(),
        parameters: json!({ "type": "object" }),
    });
    for primary in [
        mistral("mistral/mistral-large-4-0"),
        target(
            ProviderId::Anthropic,
            "anthropic/claude-sonnet-5-5",
            KeySource::Weldsuite,
        ),
    ] {
        let events = collect(
            chat_stream(
                &ai,
                &call(),
                &route(primary.clone(), vec![]),
                request.clone(),
            )
            .await
            .expect("stream"),
        )
        .await;
        let calls: Vec<&ToolCall> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::ToolCall(call) => Some(call),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 1, "{}", primary.model);
        assert_eq!(calls[0].name, "lookup");
        let Some(StreamEvent::Finish(answer)) = events.last() else {
            panic!("finish");
        };
        assert_eq!(answer.finish_reason, FinishReason::ToolCalls);
        assert_eq!(answer.tool_calls.len(), 1);
    }
}

#[tokio::test]
async fn an_anthropic_stream_and_a_refusal_before_it_starts() {
    let fake = FakeProvider::new()
        .reply_status(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#)
        .reply_text("Mistral streams");
    let ai = Ai::fake(config(), fake.clone());
    let primary = target(ProviderId::OpenAi, "openai/gpt-5", KeySource::Weldsuite);
    let events = collect(
        chat_stream(
            &ai,
            &call(),
            &route(primary, vec![mistral("mistral/mistral-large-4-0")]),
            ChatRequest::system_user("s", "u"),
        )
        .await
        .expect("stream"),
    )
    .await;
    let Some(StreamEvent::Finish(answer)) = events.last() else {
        panic!("finish");
    };
    assert_eq!(answer.text, "Mistral streams");
    assert_eq!(answer.served.fallback_from.as_deref(), Some("openai/gpt-5"));

    let fake = FakeProvider::new().reply_text("Claude streams");
    let ai = Ai::fake(config(), fake.clone());
    let claude = target(
        ProviderId::Anthropic,
        "anthropic/claude-sonnet-5-5",
        KeySource::Weldsuite,
    );
    let events = collect(
        chat_stream(
            &ai,
            &call(),
            &route(claude, vec![]),
            ChatRequest::system_user("s", "u"),
        )
        .await
        .expect("stream"),
    )
    .await;
    assert_eq!(
        events[0],
        StreamEvent::TextDelta("Claude streams".to_owned())
    );
    let Some(StreamEvent::Finish(answer)) = events.last() else {
        panic!("finish");
    };
    assert_eq!(answer.usage.output_tokens, FAKE_OUTPUT_TOKENS);
    assert_eq!(fake.calls()[0].body["stream"], true);
}

fn invoice(extract: bool) -> Document {
    Document {
        mime: "application/pdf".to_owned(),
        name: Some("invoice.pdf".to_owned()),
        data: b"%PDF-1.7".to_vec(),
        extract: extract.then(|| JsonSchema {
            name: "invoice".to_owned(),
            schema: json!({ "type": "object", "properties": { "total": { "type": "number" } } }),
        }),
        prompt: None,
    }
}

#[tokio::test]
async fn ocr_runs_on_mistral_ocr_with_annotations() {
    let fake = FakeProvider::new().reply_json(&json!({ "total": 42.5 }));
    let ai = Ai::fake(config(), fake.clone());
    let call = AiCall::new("ws_1", Feature::BooksOcr, Task::Ocr, Tier::Quality);
    let read = ai.ocr(&call, invoice(true)).await.expect("ocr");
    assert_eq!(read.object, Some(json!({ "total": 42.5 })));
    assert_eq!(read.text(), "# Document");
    assert_eq!(read.served.model, "mistral/mistral-ocr-4-1");
    let sent = &fake.calls()[0];
    assert_eq!(sent.url, "https://api.mistral.ai/v1/ocr");
    assert_eq!(sent.body["model"], "mistral-ocr-4-1");
    assert_eq!(sent.body["document"]["type"], "document_url");
    assert!(sent.body.get("document_annotation_format").is_some());
}

#[tokio::test]
async fn native_file_input_falls_back_to_mistral_ocr() {
    let fake = FakeProvider::new()
        .reply_json(&json!({ "markdown": "# Invoice 7", "fields": { "total": 7 } }))
        .reply_status(500, "boom")
        .reply_text("# Scanned");
    let ai = Ai::fake(config(), fake.clone());
    let call = AiCall::new("ws_1", Feature::BooksOcr, Task::Ocr, Tier::Quality);
    let claude = target(
        ProviderId::Anthropic,
        "anthropic/claude-sonnet-5-5",
        KeySource::Weldsuite,
    );
    let ocr_route = route(claude, vec![mistral("mistral/mistral-ocr-4-1")]);
    let read = ocr(&ai, &call, &ocr_route, invoice(true))
        .await
        .expect("claude reads it");
    assert_eq!(read.pages[0].markdown, "# Invoice 7");
    assert_eq!(read.object, Some(json!({ "total": 7 })));
    let sent = &fake.calls()[0];
    assert_eq!(sent.body["messages"][0]["content"][0]["type"], "document");
    assert_eq!(
        sent.body["tools"][0]["input_schema"]["required"],
        json!(["markdown", "fields"])
    );

    let read = ocr(&ai, &call, &ocr_route, invoice(false))
        .await
        .expect("fell back");
    assert_eq!(read.served.model, "mistral/mistral-ocr-4-1");
    assert_eq!(read.text(), "# Scanned");
    assert_eq!(
        read.served.fallback_from.as_deref(),
        Some("anthropic/claude-sonnet-5-5")
    );
}

#[tokio::test]
async fn embeddings_and_transcription_run_on_mistral() {
    let fake = FakeProvider::new()
        .reply_embeddings(vec![vec![0.1, 0.2], vec![0.3, 0.4]])
        .reply_text("Goedemorgen");
    let ai = Ai::fake(config(), fake.clone());
    let index = AiCall::new("ws_1", Feature::SearchIndex, Task::Embed, Tier::Free);
    let embedded = ai
        .embed(&index, &["one".to_owned(), "two".to_owned()])
        .await
        .expect("vectors");
    assert_eq!(embedded.vectors, vec![vec![0.1, 0.2], vec![0.3, 0.4]]);
    assert_eq!(embedded.served.model, "mistral/mistral-embed-2312");
    assert_eq!(fake.calls()[0].url, "https://api.mistral.ai/v1/embeddings");
    assert_eq!(fake.calls()[0].body["input"], json!(["one", "two"]));
    let empty = ai.embed(&index, &[]).await.expect("nothing to embed");
    assert_eq!(empty.vectors.len(), 0);

    let meet = AiCall::new("ws_1", Feature::Meet, Task::Transcribe, Tier::Free);
    let transcript = ai
        .transcribe(
            &meet,
            Audio {
                mime: "audio/webm".to_owned(),
                name: "meeting.webm".to_owned(),
                data: b"webm".to_vec(),
                language: Some("nl".to_owned()),
            },
        )
        .await
        .expect("transcript");
    assert_eq!(transcript.text, "Goedemorgen");
    assert_eq!(transcript.duration_seconds, Some(60.0));
    // The empty batch called nothing.
    assert_eq!(fake.calls().len(), 2);
    let sent = &fake.calls()[1];
    assert_eq!(sent.url, "https://api.mistral.ai/v1/audio/transcriptions");
    assert!(
        sent.header("content-type")
            .is_some_and(|ct| ct.starts_with("multipart/form-data; boundary="))
    );
    assert_eq!(sent.model().as_deref(), Some("voxtral-mini-transcribe-3-0"));
}

#[tokio::test]
async fn keys_are_checked_with_a_model_list() {
    let fake = FakeProvider::new()
        .reply_status(401, r#"{"error":{"message":"Incorrect API key"}}"#)
        .reply_text("");
    let ai = Ai::fake(config(), fake.clone());
    let refused = ai
        .check_key(ProviderId::OpenAi, "sk-wrong")
        .await
        .expect_err("refused");
    assert_eq!(refused.provider_status(), Some(401));
    ai.check_key(ProviderId::Anthropic, " sk-ant-right ")
        .await
        .expect("ok");
    let calls = fake.calls();
    assert_eq!(calls[0].url, "https://api.openai.com/v1/models");
    assert_eq!(calls[0].header("authorization"), Some("Bearer sk-wrong"));
    assert_eq!(calls[1].url, "https://api.anthropic.com/v1/models");
    assert_eq!(calls[1].header("x-api-key"), Some("sk-ant-right"));
}

#[tokio::test]
async fn with_http_sends_everything_through_the_given_client() {
    let original = FakeProvider::new();
    let ai = Ai::fake(config(), original.clone());
    let bridge = FakeProvider::new().reply_text("bridged");
    let bridged = ai.with_http(bridge.outbound());
    let answer = bridged
        .chat(&call(), ChatRequest::system_user("s", "u"))
        .await
        .expect("answer");
    assert_eq!(answer.text, "bridged");
    assert_eq!(bridge.calls().len(), 1);
    assert!(original.calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_workspace_cap_holds_calls_past_it() {
    let mut config = config();
    config.workspace_concurrency = 1;
    let ai = Ai::fake(config, FakeProvider::new());
    let weldsuite = mistral("mistral/mistral-small-2603");
    let first = ai.permit(&call(), &weldsuite).await;
    assert!(first.is_some());
    // The second call waits for the first.
    assert!(
        tokio::time::timeout(Duration::from_secs(1), ai.permit(&call(), &weldsuite))
            .await
            .is_err()
    );
    // Another workspace isn't held up, and own keys aren't capped.
    let other = AiCall::new("ws_2", Feature::Mail, Task::Draft, Tier::Free);
    assert!(ai.permit(&other, &weldsuite).await.is_some());
    let own = target(ProviderId::OpenAi, "openai/gpt-5", KeySource::Own);
    assert!(ai.permit(&call(), &own).await.is_none());
    drop(first);
    assert!(ai.permit(&call(), &weldsuite).await.is_some());
}

#[test]
fn sampling_rules_follow_sampling_ts() {
    for fixed in [
        "anthropic/claude-sonnet-5-5",
        "anthropic/claude-opus-5-5",
        "anthropic/claude-haiku-5",
        "anthropic/claude-opus-4-7",
        "anthropic/claude-opus-4-8-20260101",
        "anthropic/claude-fable-1",
        "openai/gpt-5",
        "openai/gpt-5-mini",
    ] {
        assert!(rejects_sampling_params(fixed), "{fixed}");
    }
    for free in [
        "anthropic/claude-sonnet-4-5",
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-opus-4-1",
        "anthropic/claude-sonnet-50",
        "openai/gpt-4o",
        "mistral/mistral-large-4-0",
    ] {
        assert!(!rejects_sampling_params(free), "{free}");
    }
}

#[test]
fn helpers_shape_names_urls_and_delays() {
    assert_eq!(schema_tool_name("Reply labels (v2)"), "Reply_labels__v2_");
    assert_eq!(schema_tool_name(""), "answer");
    assert_eq!(
        base_url(&config(), ProviderId::Anthropic).expect("url"),
        "https://api.anthropic.com/v1"
    );
    assert_eq!(
        base_url(&config(), ProviderId::OpenAi).expect("url"),
        "https://api.openai.com/v1"
    );
    let mut unset = config();
    unset.mistral.base_url = String::new();
    assert_eq!(
        base_url(&unset, ProviderId::Mistral).expect("default"),
        "https://api.mistral.ai/v1"
    );
    assert!(base_url(&config(), ProviderId::Compat).is_err());
    assert_eq!(retry_delay(Some("2"), 0), Duration::from_secs(2));
    assert_eq!(retry_delay(Some("600"), 0), MAX_RETRY_DELAY);
    assert_eq!(retry_delay(None, 0), Duration::from_secs(1));
    assert_eq!(
        retry_delay(Some("Wed, 21 Oct 2026 07:28:00 GMT"), 1),
        Duration::from_secs(2)
    );
    assert_eq!(
        parse_json_answer("```\n[1,2]\n```").expect("json"),
        json!([1, 2])
    );
}
