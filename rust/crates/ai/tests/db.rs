//! `weldsuite-ai`'s SQL against the real schema (databases built from the
//! journaled migrations by `scripts/rust-test-db.ts`, as CI does): the
//! tenant AI settings and own keys, routing on them (a failing own key is
//! marked and skipped), the credit charge with its debt and the ops ledger
//! row, the gate, and the usage report.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are
//! set; otherwise it returns early.

use std::collections::BTreeMap;

use weldsuite_ai::config::{Endpoint, KeySources};
use weldsuite_ai::settings::{self, FeatureOverride, ProviderSetting};
use weldsuite_ai::{
    Ai, AiCall, AiConfig, AiError, ChatRequest, FakeProvider, Feature, KeySource, ProviderId,
    Region, Route, Target, Task, Tier, Usage, WorkspaceAiSettings, billing,
};
use weldsuite_db::{PgPool, master_pool};

const WORKSPACE: &str = "ws_ai_crate_test";
const SECRET: [u8; 32] = [9; 32];

fn config() -> AiConfig {
    let endpoint = |url: &str, key: &str| Endpoint {
        base_url: url.to_owned(),
        api_key: Some(key.to_owned()),
    };
    AiConfig {
        default_provider: Some(ProviderId::Mistral),
        mistral: endpoint("https://api.mistral.ai/v1", "mistral-key"),
        anthropic: endpoint("https://api.anthropic.com/v1", "anthropic-key"),
        opt_in: BTreeMap::from([(
            ProviderId::Anthropic,
            KeySources {
                weldsuite: true,
                own: true,
            },
        )]),
        keys_encryption_key: Some(SECRET),
        ..AiConfig::default()
    }
}

async fn balance(master: &PgPool) -> i32 {
    sqlx::query_scalar("select current_balance from workspace_credits where workspace_id = $1")
        .bind(WORKSPACE)
        .fetch_one(master)
        .await
        .expect("balance")
}

#[tokio::test]
async fn settings_keys_and_metering_on_the_migrated_schema() {
    let (Ok(master_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    // One connection each (the test is sequential); one pool when both URLs
    // name the same database.
    let master = master_pool(&master_url, 1).expect("master pool");
    let tenant = if tenant_url == master_url {
        master.clone()
    } else {
        master_pool(&tenant_url, 1).expect("tenant pool")
    };
    tenant_settings_and_keys(&tenant).await;
    metering(&master).await;
}

#[allow(clippy::too_many_lines)]
async fn tenant_settings_and_keys(tenant: &PgPool) {
    sqlx::raw_sql("delete from ai_provider_keys; delete from ai_settings;")
        .execute(tenant)
        .await
        .expect("clean");

    // No row: the install defaults.
    assert_eq!(
        settings::read(tenant).await.expect("read"),
        WorkspaceAiSettings::default()
    );

    // Save, then save again (the update path).
    let mut stored = WorkspaceAiSettings::default();
    stored.providers.insert(
        ProviderId::Anthropic,
        ProviderSetting {
            enabled: true,
            key_source: KeySource::Own,
            enabled_by: Some("user_admin".to_owned()),
            enabled_at: Some("2026-11-13T10:00:00.000Z".to_owned()),
        },
    );
    stored.default_provider = Some(ProviderId::Anthropic);
    settings::save_settings(tenant, &stored, Some("user_admin"))
        .await
        .expect("insert");
    stored.feature_overrides.insert(
        Feature::Mail,
        FeatureOverride {
            provider: ProviderId::Anthropic,
            model: Some("anthropic/claude-haiku-5-5".to_owned()),
        },
    );
    settings::save_settings(tenant, &stored, Some("user_admin"))
        .await
        .expect("update");
    let read = settings::read(tenant).await.expect("read");
    assert_eq!(read.providers, stored.providers);
    assert_eq!(read.default_provider, Some(ProviderId::Anthropic));
    assert_eq!(read.feature_overrides, stored.feature_overrides);
    assert_eq!(read.updated_by.as_deref(), Some("user_admin"));
    assert!(read.updated_at.is_some_and(|at| at.ends_with('Z')));
    let rows: i64 = sqlx::query_scalar("select count(*) from ai_settings")
        .fetch_one(tenant)
        .await
        .expect("count");
    assert_eq!(rows, 1);

    // An own key: sealed, hinted, opened only for its workspace.
    let status = settings::put_key(
        tenant,
        &SECRET,
        WORKSPACE,
        ProviderId::Anthropic,
        "sk-ant-api03-secretsecret-a1b2",
        Some("user_admin"),
    )
    .await
    .expect("put");
    assert_eq!(status.hint, "sk-…a1b2");
    assert_eq!(status.status, "ok");
    let ciphertext: String = sqlx::query_scalar("select ciphertext from ai_provider_keys")
        .fetch_one(tenant)
        .await
        .expect("ciphertext");
    assert!(!ciphertext.contains("secret"));
    assert_eq!(
        settings::own_key(tenant, &SECRET, WORKSPACE, ProviderId::Anthropic)
            .await
            .expect("own key")
            .as_deref(),
        Some("sk-ant-api03-secretsecret-a1b2")
    );
    assert!(
        settings::own_key(tenant, &SECRET, "ws_other", ProviderId::Anthropic)
            .await
            .is_err()
    );

    // Routing on the stored settings: the own key is used; a 401 marks it
    // failing and the call falls back to WeldSuite's Mistral.
    let fake = FakeProvider::new()
        .reply_status(
            401,
            r#"{"type":"error","error":{"message":"invalid x-api-key"}}"#,
        )
        .reply_text("from Mistral");
    let ai = Ai::fake(config(), fake.clone());
    let call =
        AiCall::new(WORKSPACE, Feature::Mail, Task::Draft, Tier::Quality).tenant(tenant.clone());
    let route = ai.route(&call).await.expect("route");
    assert_eq!(route.primary.model, "anthropic/claude-haiku-5-5");
    assert_eq!(route.primary.key_source, KeySource::Own);
    let answer = ai
        .chat(&call, ChatRequest::system_user("s", "u"))
        .await
        .expect("fallback");
    assert_eq!(answer.served.provider, ProviderId::Mistral);
    assert_eq!(
        fake.calls()[0].header("x-api-key"),
        Some("sk-ant-api03-secretsecret-a1b2")
    );
    let read = settings::read(tenant).await.expect("read");
    let key = &read.own_keys[&ProviderId::Anthropic];
    assert_eq!(key.status, "failing");
    assert!(
        key.last_error
            .as_deref()
            .is_some_and(|e| e.contains("invalid x-api-key"))
    );
    assert!(key.last_checked_at.is_some());
    // A failing key isn't routed to until it is tested again.
    assert_eq!(
        ai.route(&call).await.expect("route").primary.provider,
        ProviderId::Mistral
    );
    let fake = FakeProvider::new().reply_text("");
    let ai = Ai::fake(config(), fake);
    let tested = ai
        .test_key(tenant, WORKSPACE, ProviderId::Anthropic)
        .await
        .expect("test")
        .expect("a key");
    assert_eq!(tested.status, "ok");
    assert_eq!(tested.last_error, None);

    assert!(
        settings::delete_key(tenant, ProviderId::Anthropic)
            .await
            .expect("delete")
    );
    assert!(
        !settings::delete_key(tenant, ProviderId::Anthropic)
            .await
            .expect("delete again")
    );
    sqlx::raw_sql("delete from ai_provider_keys; delete from ai_settings;")
        .execute(tenant)
        .await
        .expect("clean");
}

#[allow(clippy::too_many_lines)]
async fn metering(master: &PgPool) {
    for statement in [
        "delete from ai_provider_usage where workspace_id = $1",
        "delete from credit_transactions where workspace_id = $1",
        "delete from workspace_credits where workspace_id = $1",
        "delete from workspaces where id = $1",
    ] {
        sqlx::query(statement)
            .bind(WORKSPACE)
            .execute(master)
            .await
            .expect("clean");
    }
    sqlx::query("insert into workspaces (id, name, slug) values ($1, 'AI crate test', $1)")
        .bind(WORKSPACE)
        .execute(master)
        .await
        .expect("workspace");

    let config = config();
    let call = AiCall::new(WORKSPACE, Feature::Mail, Task::Draft, Tier::Quality)
        .master(Some(master.clone()))
        .user("user_1")
        .op("mail_draft")
        .reference("msg_1");
    let mistral = Target {
        provider: ProviderId::Mistral,
        model: "mistral/mistral-small-2603".to_owned(),
        region: Region::Eu,
        key_source: KeySource::Weldsuite,
    };
    let usage = Usage {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
    };
    // An empty wallet: the charge is booked as debt.
    let cost = billing::provider_cost_usd(&mistral.model, usage, 0, 0.0);
    assert_eq!(
        billing::charge(&config, &call, &mistral, cost, usage).await,
        188
    );
    assert_eq!(balance(master).await, -188);
    let (kind, amount, description, user): (String, i32, String, Option<String>) = sqlx::query_as(
        "select type, amount, description, user_id from credit_transactions where workspace_id = $1",
    )
    .bind(WORKSPACE)
    .fetch_one(master)
    .await
    .expect("debt");
    assert_eq!(kind, "adjustment");
    assert_eq!(amount, -188);
    assert!(description.starts_with("AI (mail_draft) [mistral/mistral-small-2603]"));
    assert_eq!(user.as_deref(), Some("user_1"));

    // The gate refuses an overdrawn wallet when it is on.
    let route = Route {
        primary: mistral.clone(),
        fallbacks: Vec::new(),
    };
    assert!(
        billing::assert_credits(&config, &call, &route)
            .await
            .is_ok()
    );
    let gated = AiConfig {
        credit_gate: true,
        ..config.clone()
    };
    match billing::assert_credits(&gated, &call, &route).await {
        Err(AiError::InsufficientCredits { balance, required }) => {
            assert_eq!((balance, required), (-188, 1));
        }
        other => panic!("{other:?}"),
    }

    // With credits the charge is a consumption.
    sqlx::query("update workspace_credits set current_balance = 500 where workspace_id = $1")
        .bind(WORKSPACE)
        .execute(master)
        .await
        .expect("top up");
    assert_eq!(
        billing::charge(&config, &call, &mistral, cost, usage).await,
        188
    );
    assert_eq!(balance(master).await, 312);

    // An own key is counted, not charged.
    let own = Target {
        provider: ProviderId::Anthropic,
        model: "anthropic/claude-haiku-5-5".to_owned(),
        region: Region::OutsideEu,
        key_source: KeySource::Own,
    };
    assert_eq!(billing::charge(&config, &call, &own, 0.5, usage).await, 0);
    assert_eq!(balance(master).await, 312);

    let rows: Vec<(String, String, String, Option<String>, i64, i32)> = sqlx::query_as(
        "select gateway, model_id, key_source, feature, provider_cost_nano_usd, credits_charged
         from ai_provider_usage where workspace_id = $1 order by created_at, key_source desc",
    )
    .bind(WORKSPACE)
    .fetch_all(master)
    .await
    .expect("ops rows");
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows[0],
        (
            "direct".to_owned(),
            "mistral/mistral-small-2603".to_owned(),
            "weldsuite".to_owned(),
            Some("mail".to_owned()),
            750_000_000,
            188
        )
    );
    assert!(rows.iter().any(|r| r.2 == "own" && r.4 == 0 && r.5 == 0));

    let report = settings::usage(master, WORKSPACE).await.expect("usage");
    assert_eq!(report.last_month.len(), 0);
    let mistral_row = report
        .this_month
        .iter()
        .find(|r| r.provider == "mistral")
        .expect("mistral usage");
    assert_eq!(mistral_row.calls, 2);
    assert_eq!(mistral_row.credits, 376);
    assert_eq!(mistral_row.feature.as_deref(), Some("mail"));
    let own_row = report
        .this_month
        .iter()
        .find(|r| r.key_source == "own")
        .expect("own usage");
    assert_eq!(own_row.provider, "anthropic");
    assert_eq!(own_row.credits, 0);
    assert_eq!(own_row.input_tokens, 1_000_000);
}
