//! `weldsuite doctor`: checks the configuration and what it points at, one
//! line per check (`pass`, `warn`, `skip`, `fail`) with what to fix. It exits
//! 1 when a check fails, and 78 when the configuration itself is invalid (as
//! `serve` would refuse to start).
//!
//! The checks so far (`docs/plans/self-hosted-edition.md`, C1, lists the rest):
//!
//! - the configuration, with every problem `serve` would stop on;
//! - the settings still on a default that names Global (`global_defaults`);
//! - the master database answers;
//! - AI (ADR AI-012): the install provider, each provider key the install
//!   holds (a model list, which costs nothing), and that the install
//!   provider's default chat models answer: one completion of one token each,
//!   unmetered (no workspace pays for it). `--no-model-calls` skips those.
//! - WeldAgent's sandbox: the Kubernetes API answers with the service
//!   account's rights, `SearXNG` answers, and a new sandbox can't reach the
//!   metadata service or the Kubernetes API (it is started and deleted
//!   again). `--no-sandbox-probe` starts none.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use weldsuite_ai::config::Endpoint;
use weldsuite_ai::{Ai, AiCall, AiConfig, ChatRequest, Feature, ProviderId, Task, Tier};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::config::Config;
use crate::edition::Edition;

const USAGE: &str = "\
usage: weldsuite doctor [--no-model-calls] [--no-sandbox-probe]

Checks the configuration (the same environment as `serve`) and what it points
at: the master database, the AI providers' keys and the install provider's
default models. One line per check; exits 1 when one fails.

  --no-model-calls    check the AI keys but call no model
  --no-sandbox-probe  check the sandbox's API and search but start no sandbox";

/// How long one provider may take to answer a check.
const KEY_TIMEOUT: Duration = Duration::from_secs(15);
const MODEL_TIMEOUT: Duration = Duration::from_secs(60);
const DATABASE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Pass,
    Warn,
    Skip,
    Fail,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Warn => "warn",
            Self::Skip => "skip",
            Self::Fail => "FAIL",
        }
    }
}

/// One line of the report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Check {
    pub(crate) status: Status,
    pub(crate) name: String,
    pub(crate) detail: String,
}

impl Check {
    fn new(status: Status, name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            status,
            name: name.into(),
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for Check {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}  {}: {}",
            self.status.as_str(),
            self.name,
            self.detail
        )
    }
}

/// `weldsuite doctor`.
pub(crate) fn run(args: &[String]) -> ExitCode {
    let mut model_calls = true;
    let mut sandbox_probe = true;
    for arg in args {
        match arg.as_str() {
            "--no-model-calls" => model_calls = false,
            "--no-sandbox-probe" => sandbox_probe = false,
            "--help" | "-h" | "help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            _ => {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
        }
    }
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            for problem in &error.0 {
                println!("{}", Check::new(Status::Fail, "config", problem.as_str()));
            }
            return ExitCode::from(78); // EX_CONFIG
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start the async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    let checks = runtime.block_on(checks(&config, model_calls, sandbox_probe));
    for check in &checks {
        println!("{check}");
    }
    if checks.iter().any(|check| check.status == Status::Fail) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

async fn checks(config: &Config, model_calls: bool, sandbox_probe: bool) -> Vec<Check> {
    let mut out = vec![Check::new(Status::Pass, "config", "valid")];
    out.extend(
        config
            .global_defaults
            .iter()
            .map(|line| Check::new(Status::Warn, "global default", line.as_str())),
    );
    out.push(master_database(config).await);
    let http = match weldsuite_adapters_oss::ReqwestOutbound::new(MODEL_TIMEOUT) {
        Ok(client) => OutboundHttp(Arc::new(client)),
        Err(error) => {
            out.push(Check::new(
                Status::Fail,
                "ai",
                format!("no HTTP client: {error}"),
            ));
            return out;
        }
    };
    let ai = (model_calls && config.ai.default_provider.is_some())
        .then(|| Ai::new(config.ai.clone(), http.clone(), None));
    out.extend(ai_checks(&config.ai, config.edition.edition, &http, ai.as_ref()).await);
    out.extend(sandbox_checks(config, sandbox_probe).await);
    out
}

/// WeldAgent's sandbox: the Kubernetes API answers with the service
/// account's rights, `SearXNG` answers, and, with `probe`, a new sandbox can't
/// reach the metadata service or the Kubernetes API (it is started and
/// deleted again).
async fn sandbox_checks(config: &Config, probe: bool) -> Vec<Check> {
    let Some(sandbox) = config.sandbox.as_ref() else {
        let status = if config.edition.edition == Edition::Eu {
            Status::Warn
        } else {
            Status::Skip
        };
        return vec![Check::new(
            status,
            "sandbox",
            "off: SANDBOX_ENABLED is not set, so WeldAgent has no sandbox, computer use or browsing \
             (the chart's sandbox.enabled)",
        )];
    };
    let sandboxes = match crate::sandbox::build(Some(sandbox)) {
        Ok(Some(sandboxes)) => sandboxes,
        Ok(None) => return Vec::new(),
        Err(error) => return vec![Check::new(Status::Fail, "sandbox", error.to_string())],
    };
    let mut out = vec![match sandboxes.pods().await {
        Ok(pods) => Check::new(
            Status::Pass,
            "sandbox",
            format!(
                "the Kubernetes API answers; {} sandbox pods in {}",
                pods.len(),
                sandbox.namespace
            ),
        ),
        Err(error) => Check::new(
            Status::Fail,
            "sandbox",
            format!(
                "{error} (the service account needs pods get/list/create/delete in {}: the chart's \
                 sandbox Role)",
                sandbox.namespace
            ),
        ),
    }];
    out.push(match sandboxes.search() {
        None => Check::new(
            Status::Warn,
            "web search",
            "SEARXNG_URL is not set: web_search answers that search is not configured",
        ),
        Some(search) => match search.search("weldsuite", 1, None).await {
            Ok(hits) => Check::new(
                Status::Pass,
                "web search",
                format!("SearXNG answers ({} results)", hits.len()),
            ),
            Err(error) => Check::new(Status::Fail, "web search", error.to_string()),
        },
    });
    if !probe {
        out.push(Check::new(
            Status::Skip,
            "sandbox isolation",
            "--no-sandbox-probe: no sandbox was started",
        ));
        return out;
    }
    out.push(match sandboxes.check_isolation().await {
        Ok(reached) if reached.is_empty() => Check::new(
            Status::Pass,
            "sandbox isolation",
            format!(
                "a new sandbox can't reach {}",
                sandbox.egress_probes.join(", ")
            ),
        ),
        Ok(reached) => Check::new(
            Status::Fail,
            "sandbox isolation",
            format!(
                "a new sandbox reached {}: the sandbox namespace's NetworkPolicy is not enforced, \
                 so no sandbox is handed out (install a NetworkPolicy controller: \
                 rust/deploy/hetzner/README.md, \"Agent sandbox\")",
                reached.join(", ")
            ),
        ),
        Err(error) => Check::new(Status::Fail, "sandbox isolation", error.to_string()),
    });
    out
}

async fn master_database(config: &Config) -> Check {
    let name = "master database";
    let pool = match weldsuite_db::master_pool(&config.master_database_url, 1) {
        Ok(pool) => pool,
        Err(error) => {
            return Check::new(Status::Fail, name, format!("DATABASE_URL_MASTER: {error}"));
        }
    };
    let ping = sqlx::query_scalar::<_, i32>("select 1").fetch_one(&pool);
    match tokio::time::timeout(DATABASE_TIMEOUT, ping).await {
        Ok(Ok(_)) => Check::new(Status::Pass, name, "answers"),
        Ok(Err(error)) => Check::new(
            Status::Fail,
            name,
            format!("{error} (check DATABASE_URL_MASTER and that the database is up)"),
        ),
        Err(_) => Check::new(
            Status::Fail,
            name,
            format!("no answer in {} s", DATABASE_TIMEOUT.as_secs()),
        ),
    }
}

/// The AI checks: the install provider, each key the install holds, and,
/// with `ai`, a one-token completion on each of the install provider's
/// default chat models.
pub(crate) async fn ai_checks(
    config: &AiConfig,
    edition: Edition,
    http: &OutboundHttp,
    ai: Option<&Ai>,
) -> Vec<Check> {
    let Some(install) = config.default_provider else {
        return vec![if edition == Edition::Eu {
            Check::new(
                Status::Warn,
                "ai",
                "off: the EU edition runs its AI features on Mistral (config.ai.defaultProvider: \
                 mistral, MISTRAL_API_KEY in the Secret)",
            )
        } else {
            Check::new(
                Status::Skip,
                "ai",
                "off: AI_DEFAULT_PROVIDER is not set, so the AI features are hidden",
            )
        }];
    };
    let opt_ins: Vec<String> = config
        .opt_in
        .iter()
        .map(|(provider, sources)| {
            let keys: Vec<&str> = [("weldsuite", sources.weldsuite), ("own", sources.own)]
                .into_iter()
                .filter_map(|(name, on)| on.then_some(name))
                .collect();
            format!("{} ({})", provider.as_str(), keys.join(", "))
        })
        .collect();
    let mut out = vec![Check::new(
        Status::Pass,
        "ai",
        format!(
            "{} ({}) is the install provider; opt-in: {}",
            install.as_str(),
            config.region(install).as_str(),
            if opt_ins.is_empty() {
                "none".to_owned()
            } else {
                opt_ins.join(", ")
            }
        ),
    )];
    let keyed = [
        (ProviderId::Mistral, &config.mistral, "MISTRAL_API_KEY"),
        (
            ProviderId::Anthropic,
            &config.anthropic,
            "ANTHROPIC_API_KEY",
        ),
        (ProviderId::OpenAi, &config.openai, "OPENAI_API_KEY"),
    ];
    for (provider, endpoint, key_name) in keyed {
        if endpoint.api_key.is_some() {
            out.push(key_check(provider, endpoint, key_name, http).await);
        }
    }
    if let Some(compat) = &config.compat {
        out.push(
            key_check(
                ProviderId::Compat,
                &compat.endpoint,
                "AI_COMPAT_API_KEY",
                http,
            )
            .await,
        );
    }
    match ai {
        Some(ai) => out.extend(model_checks(ai).await),
        None => out.push(Check::new(
            Status::Skip,
            "ai models",
            "--no-model-calls: no model was called",
        )),
    }
    out
}

/// A provider's model list with the install's key: free, and refused
/// (401/403) when the key is wrong.
async fn key_check(
    provider: ProviderId,
    endpoint: &Endpoint,
    key_name: &str,
    http: &OutboundHttp,
) -> Check {
    let name = format!("ai key {}", provider.as_str());
    let base = endpoint.base_url.as_str();
    let request = match (provider, endpoint.api_key.as_deref()) {
        (ProviderId::Anthropic, key) => HttpRequest::empty("GET", format!("{base}/v1/models"))
            .header("x-api-key", key.unwrap_or_default())
            .header("anthropic-version", "2023-06-01"),
        (_, Some(key)) => HttpRequest::empty("GET", format!("{base}/models"))
            .header("authorization", format!("Bearer {key}")),
        (_, None) => HttpRequest::empty("GET", format!("{base}/models")),
    };
    match tokio::time::timeout(KEY_TIMEOUT, http.send(request)).await {
        Err(_) => Check::new(
            Status::Fail,
            name,
            format!("{base} did not answer in {} s", KEY_TIMEOUT.as_secs()),
        ),
        Ok(Err(error)) => Check::new(Status::Fail, name, format!("cannot reach {base}: {error}")),
        Ok(Ok(response)) if response.ok() => {
            Check::new(Status::Pass, name, format!("{base} accepts it"))
        }
        Ok(Ok(response)) if matches!(response.status, 401 | 403) => Check::new(
            Status::Fail,
            name,
            format!("{base} refuses it ({}): check {key_name}", response.status),
        ),
        Ok(Ok(response)) => Check::new(
            Status::Fail,
            name,
            format!("{base} answered {}", response.status),
        ),
    }
}

/// One token from each of the install provider's default chat models: the
/// cheap tier (classify) and the quality tier (draft). No workspace, so
/// nothing is charged.
async fn model_checks(ai: &Ai) -> Vec<Check> {
    let mut out = Vec::new();
    let mut seen = Vec::new();
    for (task, tier) in [(Task::Classify, Tier::Free), (Task::Draft, Tier::Quality)] {
        let call = AiCall::new("doctor", Feature::Assistant, task, tier).op("doctor");
        let model = match ai.route(&call).await {
            Ok(route) => route.primary.model,
            Err(error) => {
                out.push(Check::new(Status::Fail, "ai model", error.to_string()));
                continue;
            }
        };
        if seen.contains(&model) {
            continue;
        }
        let name = format!("ai model {model}");
        seen.push(model);
        let request =
            ChatRequest::system_user("Answer with one word.", "Are you there?").max_tokens(1);
        let started = Instant::now();
        match tokio::time::timeout(MODEL_TIMEOUT, ai.chat(&call, request)).await {
            Ok(Ok(answer)) => out.push(Check::new(
                Status::Pass,
                name,
                format!(
                    "answered in {} ms ({})",
                    started.elapsed().as_millis(),
                    answer.served.model
                ),
            )),
            Ok(Err(error)) => out.push(Check::new(Status::Fail, name, error.to_string())),
            Err(_) => out.push(Check::new(
                Status::Fail,
                name,
                format!("no answer in {} s", MODEL_TIMEOUT.as_secs()),
            )),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpResponse, PortError};

    use super::*;

    /// Answers by URL and records what was asked.
    #[derive(Default)]
    struct Scripted {
        answers: Vec<(&'static str, Result<u16, &'static str>)>,
        asked: Mutex<Vec<HttpRequest>>,
    }

    impl DynOutboundHttp for Scripted {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            let answer = self
                .answers
                .iter()
                .find(|(url, _)| request.url == *url)
                .map_or(Ok(404), |(_, answer)| *answer);
            self.asked
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(request);
            Box::pin(std::future::ready(match answer {
                Ok(status) => Ok(HttpResponse::new(status, b"{}".to_vec())),
                Err(message) => Err(PortError::backend(message)),
            }))
        }
    }

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

    #[tokio::test]
    async fn ai_off_is_a_warning_only_on_the_eu_edition() {
        let http = OutboundHttp(Arc::new(Scripted::default()));
        let off = config(&[]);
        let eu = ai_checks(&off, Edition::Eu, &http, None).await;
        assert_eq!(eu.len(), 1);
        assert_eq!(eu[0].status, Status::Warn);
        assert!(eu[0].detail.contains("Mistral"), "{}", eu[0]);
        let self_hosted = ai_checks(&off, Edition::SelfHosted, &http, None).await;
        assert_eq!(self_hosted[0].status, Status::Skip);
    }

    #[tokio::test]
    async fn checks_every_key_the_install_holds() {
        let scripted = Arc::new(Scripted {
            answers: vec![
                ("https://api.mistral.ai/v1/models", Ok(200)),
                ("https://api.anthropic.com/v1/models", Ok(401)),
                ("https://api.openai.com/v1/models", Err("dns error")),
            ],
            ..Scripted::default()
        });
        let http = OutboundHttp(Arc::clone(&scripted) as Arc<dyn DynOutboundHttp>);
        let config = config(&[
            ("AI_DEFAULT_PROVIDER", "mistral"),
            ("MISTRAL_API_KEY", "mk-1"),
            ("ANTHROPIC_API_KEY", "sk-ant-1"),
            ("OPENAI_API_KEY", "sk-oa-1"),
            ("AI_OPTIN_ANTHROPIC", "weldsuite"),
        ]);
        let checks = ai_checks(&config, Edition::Eu, &http, None).await;
        let line = |name: &str| {
            checks
                .iter()
                .find(|check| check.name == name)
                .unwrap_or_else(|| panic!("{name}: {checks:?}"))
        };
        assert_eq!(line("ai").status, Status::Pass);
        assert!(line("ai").detail.contains("mistral (eu)"), "{}", line("ai"));
        assert!(
            line("ai").detail.contains("anthropic (weldsuite)"),
            "{}",
            line("ai")
        );
        assert_eq!(line("ai key mistral").status, Status::Pass);
        let anthropic = line("ai key anthropic");
        assert_eq!(anthropic.status, Status::Fail);
        assert!(
            anthropic.detail.contains("ANTHROPIC_API_KEY"),
            "{anthropic}"
        );
        let openai = line("ai key openai");
        assert_eq!(openai.status, Status::Fail);
        assert!(openai.detail.contains("dns error"), "{openai}");
        assert_eq!(line("ai models").status, Status::Skip);
        // Never a key in a line.
        assert!(!checks.iter().any(|c| c.to_string().contains("mk-1")));

        let asked = scripted
            .asked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let header = |url: &str, name: &str| {
            asked
                .iter()
                .find(|r| r.url == url)
                .and_then(|r| r.headers.iter().find(|(n, _)| n == name))
                .map(|(_, v)| v.clone())
        };
        assert_eq!(
            header("https://api.mistral.ai/v1/models", "authorization").as_deref(),
            Some("Bearer mk-1")
        );
        assert_eq!(
            header("https://api.anthropic.com/v1/models", "x-api-key").as_deref(),
            Some("sk-ant-1")
        );
        assert_eq!(
            header("https://api.anthropic.com/v1/models", "anthropic-version").as_deref(),
            Some("2023-06-01")
        );
    }

    #[tokio::test]
    async fn a_self_hosted_endpoint_may_need_no_key() {
        let scripted = Arc::new(Scripted {
            answers: vec![("http://ollama:11434/v1/models", Ok(200))],
            ..Scripted::default()
        });
        let http = OutboundHttp(Arc::clone(&scripted) as Arc<dyn DynOutboundHttp>);
        let config = config(&[
            ("AI_COMPAT_BASE_URL", "http://ollama:11434/v1"),
            ("AI_COMPAT_MODEL", "llama3.3"),
        ]);
        let checks = ai_checks(&config, Edition::SelfHosted, &http, None).await;
        let compat = checks
            .iter()
            .find(|c| c.name == "ai key compat")
            .expect("checked");
        assert_eq!(compat.status, Status::Pass, "{compat}");
        let asked = scripted
            .asked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert!(asked[0].headers.is_empty(), "no key, no header");
    }

    #[test]
    fn lines_read_status_name_and_detail() {
        assert_eq!(
            Check::new(Status::Fail, "ai key mistral", "refused").to_string(),
            "FAIL  ai key mistral: refused"
        );
    }
}
