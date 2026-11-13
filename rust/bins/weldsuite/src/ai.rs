//! The install's AI (`weldsuite_ai`, ADR AI-012), built once per process from
//! [`AiConfig`] (`config.rs` reads it with every other setting): `serve` keeps
//! it in [`AppState::ai`](crate::server::AppState), and `consume` and the cron
//! jobs build theirs the same way. `None` is AI off (no
//! `AI_DEFAULT_PROVIDER`): the AI features are listed in `/config.json`'s
//! `unavailableFeatures` and their routes answer as the workers do without
//! their model.
//!
//! A route takes the AI it calls from the request first, then the app:
//!
//! ```ignore
//! // In a module crate, where the state holds `ai: Option<weldsuite_ai::Ai>`:
//! let ai = parts.extensions.get::<weldsuite_ai::Ai>().or(state.ai.as_ref())
//!     .filter(|ai| ai.enabled()).cloned();
//! // In this crate:
//! let ai = crate::ai::for_request(state.ai.as_ref(), &parts.extensions);
//! ```
//!
//! A release build never puts an `Ai` on a request, so that is the app's. A
//! conformance build puts one on every request it authenticates
//! (`crate::conformance`, [`conformance`]): on when the test's env sets
//! `AI_TEST_BASE_URL`, with Mistral as the install provider at that URL and
//! its HTTP through the test's fetch stub, as `@weldsuite/ai` then calls the
//! same mock model (`@weldsuite/ai/testing`); off otherwise, as the worker
//! without its gateway.

use std::sync::Arc;
use std::time::Duration;

use weldsuite_ai::{Ai, AiConfig};
use weldsuite_ports::{DynCache, OutboundHttp, PortError};

/// The longest one exchange with a provider may take. The crate gives each
/// call its own, shorter deadline (120 s; 300 s for OCR and transcription);
/// this only ends a connection that hangs past them.
const HTTP_TIMEOUT: Duration = Duration::from_secs(330);

/// The process's AI over a plain HTTP client, with the settings cache in
/// Valkey when there is one (`cache`). `None` with AI off.
pub(crate) fn build(
    config: &AiConfig,
    cache: Option<Arc<dyn DynCache>>,
) -> Result<Option<Ai>, PortError> {
    let Some(provider) = config.default_provider else {
        tracing::info!("AI_DEFAULT_PROVIDER is not set: AI is off and its features are hidden");
        return Ok(None);
    };
    let http = weldsuite_adapters_oss::ReqwestOutbound::new(HTTP_TIMEOUT)?;
    if cache.is_none() {
        tracing::warn!(
            "VALKEY_URL is not set: workspaces' AI settings are read on every call, and the \
             per-workspace concurrency cap holds per process"
        );
    }
    tracing::info!(
        provider = provider.as_str(),
        region = config.region(provider).as_str(),
        "AI on"
    );
    Ok(Some(Ai::new(
        config.clone(),
        OutboundHttp(Arc::new(http)),
        cache,
    )))
}

/// `serve`'s AI: [`build`]'s.
#[cfg(not(feature = "conformance"))]
pub(crate) fn for_app(
    config: &AiConfig,
    cache: Option<Arc<dyn DynCache>>,
) -> Result<Option<Ai>, PortError> {
    build(config, cache)
}

/// `serve`'s AI in a conformance build: a fixed one, Mistral at the mock
/// model's URL over no HTTP; every request then carries the test's own.
#[cfg(feature = "conformance")]
#[allow(
    clippy::unnecessary_wraps,
    reason = "the release build's twin can fail"
)]
pub(crate) fn for_app(
    _config: &AiConfig,
    _cache: Option<Arc<dyn DynCache>>,
) -> Result<Option<Ai>, PortError> {
    let env = std::collections::HashMap::from([(
        "AI_TEST_BASE_URL".to_owned(),
        CONFORMANCE_BASE_URL.to_owned(),
    )]);
    Ok(Some(conformance(&env, None)))
}

/// The AI a request calls: the request's own (conformance builds), else the
/// app's; `None` when it is off.
#[allow(
    dead_code,
    reason = "for the AI routes this crate mounts as they are ported"
)]
pub(crate) fn for_request(app: Option<&Ai>, extensions: &http::Extensions) -> Option<Ai> {
    extensions
        .get::<Ai>()
        .or(app)
        .filter(|ai| ai.enabled())
        .cloned()
}

/// The mock model's base URL conformance tests point both backends at:
/// `MOCK_AI_BASE_URL` in `@weldsuite/ai/testing`. The harness leaves the
/// calls to its host out of the compared outbound calls.
#[cfg(feature = "conformance")]
pub(crate) const CONFORMANCE_BASE_URL: &str = "https://mock-ai.weldsuite.test/v1";

/// The fixed key that seals own keys in conformance builds (`ai_provider_keys`
/// rows a test reads back were sealed by this side).
#[cfg(feature = "conformance")]
const CONFORMANCE_KEYS_ENCRYPTION_KEY: &str =
    "636f6e666f726d616e63652d61692d6b6579732d656e6372797074696f6e2121";

/// The settings a test may set for the Rust side in its env (forwarded by
/// `FORWARDED_ENV` in `packages/core/worker-kit/src/testing/conformance.ts`).
#[cfg(feature = "conformance")]
const TEST_SETTINGS: [&str; 4] = [
    "AI_CREDIT_GATE",
    "AI_BILLING",
    "AI_OPTIN_ANTHROPIC",
    "AI_OPTIN_OPENAI",
];

/// The AI of a conformance request (or of the app, `env` empty but for
/// `AI_TEST_BASE_URL`), over `http`: the test's fetch stub, or none. On with
/// `AI_TEST_BASE_URL`: Mistral as the install provider and Anthropic and
/// `OpenAI` opted in with both key sources, all at that URL with fake keys, the
/// credit gate on (Global's is always on); the test's own [`TEST_SETTINGS`]
/// win. Off without it.
#[cfg(feature = "conformance")]
pub(crate) fn conformance(
    env: &std::collections::HashMap<String, String>,
    http: Option<OutboundHttp>,
) -> Ai {
    let http = http.unwrap_or_else(|| OutboundHttp(Arc::new(NoModel)));
    let Some(base) = env
        .get("AI_TEST_BASE_URL")
        .map(|url| url.trim())
        .filter(|url| !url.is_empty())
    else {
        return Ai::new(AiConfig::default(), http, None);
    };
    let fixed = |name: &str| -> Option<&str> {
        Some(match name {
            "AI_DEFAULT_PROVIDER" => "mistral",
            "AI_MISTRAL_BASE_URL" | "AI_ANTHROPIC_BASE_URL" | "AI_OPENAI_BASE_URL" => base,
            "MISTRAL_API_KEY" => "conformance-mistral-key",
            "ANTHROPIC_API_KEY" => "conformance-anthropic-key",
            "OPENAI_API_KEY" => "conformance-openai-key",
            "AI_KEYS_ENCRYPTION_KEY" => CONFORMANCE_KEYS_ENCRYPTION_KEY,
            "AI_OPTIN_ANTHROPIC" | "AI_OPTIN_OPENAI" => "weldsuite,own",
            "AI_CREDIT_GATE" => "true",
            _ => return None,
        })
    };
    let lookup = |name: &str| {
        TEST_SETTINGS
            .contains(&name)
            .then(|| env.get(name).cloned())
            .flatten()
            .or_else(|| fixed(name).map(str::to_owned))
    };
    let mut problems = Vec::new();
    let config = AiConfig::from_lookup(&lookup, &mut problems);
    if !problems.is_empty() {
        tracing::warn!(?problems, "conformance: the test's AI settings");
    }
    Ai::new(config, http, None)
}

/// No model to reach: every call fails like a `fetch` that can't connect.
#[cfg(feature = "conformance")]
struct NoModel;

#[cfg(feature = "conformance")]
impl weldsuite_ports::DynOutboundHttp for NoModel {
    fn send(
        &self,
        _request: weldsuite_ports::HttpRequest,
    ) -> weldsuite_ports::BoxFuture<'_, Result<weldsuite_ports::HttpResponse, PortError>> {
        Box::pin(std::future::ready(Err(PortError::backend(
            "conformance: no outbound bridge for the model",
        ))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(vars: &[(&str, &str)]) -> AiConfig {
        let lookup = |name: &str| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        };
        let mut problems = Vec::new();
        let config = AiConfig::from_lookup(&lookup, &mut problems);
        assert!(problems.is_empty(), "{problems:?}");
        config
    }

    #[test]
    fn off_without_an_install_provider() {
        assert!(build(&config(&[]), None).expect("client").is_none());
        let ai = build(
            &config(&[
                ("AI_DEFAULT_PROVIDER", "mistral"),
                ("MISTRAL_API_KEY", "mk"),
            ]),
            None,
        )
        .expect("client")
        .expect("on");
        assert!(ai.enabled());
        assert_eq!(
            ai.config().default_provider,
            Some(weldsuite_ai::ProviderId::Mistral)
        );
    }

    #[test]
    fn a_request_uses_its_own_ai_first() {
        let app = build(
            &config(&[
                ("AI_DEFAULT_PROVIDER", "mistral"),
                ("MISTRAL_API_KEY", "mk"),
            ]),
            None,
        )
        .expect("client");
        let mut extensions = http::Extensions::new();
        assert!(
            for_request(app.as_ref(), &extensions).is_some(),
            "the app's"
        );
        assert!(for_request(None, &extensions).is_none(), "AI off");
        // A request's AI that is off wins over the app's.
        let off = Ai::new(
            AiConfig::default(),
            OutboundHttp(Arc::new(Unreachable)),
            None,
        );
        extensions.insert(off);
        assert!(for_request(app.as_ref(), &extensions).is_none());
        // And one that is on, over its own HTTP.
        let own = app
            .as_ref()
            .expect("on")
            .with_http(OutboundHttp(Arc::new(Unreachable)));
        extensions.insert(own);
        assert!(for_request(None, &extensions).is_some());
    }

    /// An HTTP client the tests never reach.
    struct Unreachable;

    impl weldsuite_ports::DynOutboundHttp for Unreachable {
        fn send(
            &self,
            _request: weldsuite_ports::HttpRequest,
        ) -> weldsuite_ports::BoxFuture<'_, Result<weldsuite_ports::HttpResponse, PortError>>
        {
            Box::pin(std::future::ready(Err(PortError::backend("unreachable"))))
        }
    }

    #[cfg(feature = "conformance")]
    #[test]
    fn conformance_ai_follows_the_tests_env() {
        use std::collections::HashMap;
        let off = conformance(&HashMap::new(), None);
        assert!(
            !off.enabled(),
            "no AI_TEST_BASE_URL: off, as the worker without its gateway"
        );

        let env: HashMap<String, String> = [
            ("AI_TEST_BASE_URL", CONFORMANCE_BASE_URL),
            ("AI_CREDIT_GATE", "false"),
            ("AI_OPTIN_OPENAI", "own"),
            // Not a setting a test may change.
            ("MISTRAL_API_KEY", "a real key"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        let on = conformance(&env, None);
        let config = on.config();
        assert!(on.enabled());
        assert_eq!(
            config.default_provider,
            Some(weldsuite_ai::ProviderId::Mistral)
        );
        assert_eq!(config.mistral.base_url, CONFORMANCE_BASE_URL);
        assert_eq!(config.anthropic.base_url, CONFORMANCE_BASE_URL);
        assert_eq!(
            config.mistral.api_key.as_deref(),
            Some("conformance-mistral-key")
        );
        assert!(!config.credit_gate, "the test's");
        assert!(config.keys_encryption_key.is_some());
        let openai = config.opt_in[&weldsuite_ai::ProviderId::OpenAi];
        assert!(openai.own && !openai.weldsuite, "the test's");
        let anthropic = config.opt_in[&weldsuite_ai::ProviderId::Anthropic];
        assert!(anthropic.own && anthropic.weldsuite, "the default");
        // Without the test's settings the gate is on, as Global's always is.
        let fixed = conformance(
            &HashMap::from([(
                "AI_TEST_BASE_URL".to_owned(),
                CONFORMANCE_BASE_URL.to_owned(),
            )]),
            None,
        );
        assert!(fixed.config().credit_gate);
    }
}
