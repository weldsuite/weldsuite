//! The SLA engine's SQL against the real tenant schema
//! (`WELDSUITE_TEST_TENANT_URL`, built by `scripts/rust-test-db.ts`; the
//! test skips without it): an append re-derives the clocks and the summary,
//! the sweep's `acknowledge` returns each warning once, a failed
//! announcement is released, and a conversation without a matching policy
//! loses its clocks. The behaviour itself is compared with TypeScript by the
//! `desk: SLA` conformance suite and `sla_parity.rs`.

use serde_json::{Map, json};
use sqlx::PgPool;
use weldsuite_desk_domain::sla::{self, ConversationRef, Metric};
use weldsuite_desk_domain::webchat::{
    Append, ChannelConversation, NewConversation, append, create_on_channel,
};

const POLICY: &str = "sla_rust_db_test";
const MINUTE: i64 = 60_000;

async fn tenant() -> Option<PgPool> {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some(PgPool::connect(&url).await.expect("the tenant database"))
}

async fn cleanup(db: &PgPool) {
    sqlx::query("delete from helpdesk_slas where id = $1")
        .bind(POLICY)
        .execute(db)
        .await
        .expect("cleanup");
}

#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn scenario(db: PgPool) {
    sqlx::query(
        "insert into helpdesk_slas (id, name, is_default, is_active, operational_hours,
             first_response_time, resolution_time, update_time)
         values ($1, 'Rust DB test', true, true, '24x7', $2, $3, $4)",
    )
    .bind(POLICY)
    .bind(json!([{ "priority": "medium", "time": 60 }]))
    .bind(json!([{ "priority": "medium", "time": 480 }]))
    .bind(json!([{ "priority": "medium", "time": 120 }]))
    .execute(&db)
    .await
    .expect("policy");

    let created = create_on_channel(
        &db,
        ChannelConversation {
            channel: "messenger",
            title: json!("SLA"),
            attachments: None,
            conversation: NewConversation {
                visitor_id: "v_rust_sla_db",
                name: json!("Rita"),
                email: json!(null),
                body: "Help".to_owned(),
                author_type: "visitor",
                author_id: None,
                metadata: None,
            },
        },
    )
    .await
    .expect("conversation");
    let id = created.conversation["id"]
        .as_str()
        .expect("the SLA statement")
        .to_owned();
    assert_eq!(created.conversation["slaPolicyId"], POLICY);
    assert_eq!(created.conversation["slaStatus"], "active");
    assert_eq!(created.conversation["slaMetric"], "first_response");
    let started = sla::time_value(created.message.get("createdAt")).expect("the SLA statement");
    assert_eq!(created.sla_check_at, Some(started + 45 * MINUTE));
    assert_eq!(
        sla::time_value(created.conversation.get("slaDueAt")),
        Some(started + 60 * MINUTE)
    );

    // Due at the warning; the sweep's acknowledge returns it once.
    let due = sla::list_due(&db, started + 50 * MINUTE, 100)
        .await
        .expect("the SLA statement");
    assert!(due.contains(&id));
    let swept = sla::refresh(&db, ConversationRef::Id(&id), started + 50 * MINUTE, true)
        .await
        .expect("the SLA statement");
    assert_eq!(swept.alerts.len(), 1);
    assert_eq!(swept.alerts[0].kind, "warning");
    assert_eq!(swept.alerts[0].metric, Metric::FirstResponse);
    let again = sla::refresh(&db, ConversationRef::Id(&id), started + 51 * MINUTE, true)
        .await
        .expect("the SLA statement");
    assert_eq!(again.alerts, Vec::new());

    // Released: warned again on the next look, which is no later than the breach.
    sla::release_alert(&db, &swept.alerts[0], started + 80 * MINUTE)
        .await
        .expect("the SLA statement");
    let next: Option<i64> = sqlx::query_scalar(
        "select floor(extract(epoch from next_check_at) * 1000)::int8 from desk_sla_clocks
         where conversation_id = $1 and metric = 'first_response'",
    )
    .bind(&id)
    .fetch_one(&db)
    .await
    .expect("the SLA statement");
    assert_eq!(next, Some(started + 60 * MINUTE));
    let retried = sla::refresh(&db, ConversationRef::Id(&id), started + 60 * MINUTE, true)
        .await
        .expect("the SLA statement");
    assert_eq!(
        retried.alerts.iter().map(|a| a.kind).collect::<Vec<_>>(),
        ["warning"]
    );

    // An agent reply meets first response and pauses resolution.
    let replied = append(
        &db,
        Append {
            conversation_id: &id,
            kind: "message",
            author_type: "agent",
            author_id: Some("user_agent"),
            body: Some("Hello".to_owned()),
            attachments: None,
            metadata: None,
            assignee_id: None,
        },
    )
    .await
    .expect("the SLA statement");
    assert_eq!(replied.conversation["slaStatus"], "paused");
    assert_eq!(replied.sla_check_at, None);

    // No policy applies anymore: the clocks go.
    sqlx::query("update helpdesk_slas set is_active = false where id = $1")
        .bind(POLICY)
        .execute(&db)
        .await
        .expect("the SLA statement");
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!("closed"));
    let closed = append(
        &db,
        Append {
            conversation_id: &id,
            kind: "event",
            author_type: "agent",
            author_id: Some("user_agent"),
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await
    .expect("the SLA statement");
    assert!(closed.conversation["slaPolicyId"].is_null());
    let left: i64 =
        sqlx::query_scalar("select count(*) from desk_sla_clocks where conversation_id = $1")
            .bind(&id)
            .fetch_one(&db)
            .await
            .expect("the SLA statement");
    assert_eq!(left, 0);
}

#[tokio::test]
async fn clocks_follow_the_timeline_on_the_real_schema() {
    let Some(db) = tenant().await else {
        return;
    };
    cleanup(&db).await;
    // A policy left behind would put clocks on every other test's conversations.
    let outcome = tokio::spawn(scenario(db.clone())).await;
    cleanup(&db).await;
    if let Err(error) = outcome {
        std::panic::resume_unwind(error.into_panic());
    }
}
