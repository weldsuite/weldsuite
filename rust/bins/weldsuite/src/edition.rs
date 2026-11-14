//! Edition flags (P4 work package 4.F3): what `/config.json` tells the
//! platform about this deployment besides its API, so a Kubernetes install
//! never shows a screen its backend can't serve.
//!
//! - `edition`: which Kubernetes edition this is (`EDITION`).
//! - `unavailableFeatures`: what this backend lacks even inside the modules
//!   it serves ([`UNAVAILABLE_FEATURES`]). The modules themselves come from
//!   the catalog (`RUST_PORTED_MODULES`), so neither list is configuration:
//!   both follow the code, and a port removes its entry here. Some entries
//!   follow the deployment instead: [`AI_FEATURES`], when it has no AI
//!   provider (`AI_DEFAULT_PROVIDER`); [`MAIL_DOMAINS_FEATURE`], when it has no
//!   MX for customer domains (`MAIL_MX_HOST`); [`MAIL_FREE_ADDRESSES_FEATURE`],
//!   when it also has no free-address domain of its own (`WELDMAIL_DOMAIN`);
//!   [`COLLAB_ROOMS_FEATURE`], when no collab-rooms service is configured
//!   (`COLLAB_ROOMS_URLS`); [`CREDIT_TOP_UP_FEATURE`], without Mollie
//!   (`MOLLIE_API_KEY`); and [`AGENT_SANDBOX_FEATURE`], without WeldAgent's
//!   sandbox (`SANDBOX_ENABLED`).
//! - `ai`: the install's AI providers, with their region and the key sources
//!   a workspace may use (`weldsuite_ai::AiConfig::describe`), when it has
//!   one. The platform shows the AI settings page and the region labels from
//!   it.
//! - `env`: public settings the platform would otherwise bake in at build
//!   time, by their `VITE_*` name (`PUBLIC_ENV`), limited to
//!   [`PUBLIC_ENV_KEYS`] because the document is public.
//! - `videoProvider` and `videoUrl`: which client joins WeldMeet rooms
//!   (`livekit` or `realtimekit`) and the `LiveKit` server it connects to,
//!   from the same `VIDEO_PROVIDER`/`LIVEKIT_URL` the meet module reads
//!   (`weldsuite_video_rooms::client_settings`).
//!
//! The platform reads them in `apps/web/platform/lib/edition.ts` and
//! `lib/runtime-config.ts`. Global serves no `/config.json` and offers
//! everything.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use weldsuite_video_rooms::ClientSettings;

/// The Kubernetes edition (`EDITION`): `self-hosted` (the default) or `eu`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Edition {
    /// WeldSuite's EU edition, on EU-only infrastructure.
    Eu,
    /// A customer's own install.
    SelfHosted,
}

impl Edition {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Eu => "eu",
            Self::SelfHosted => "self-hosted",
        }
    }
}

/// Features the Rust backend lacks inside the modules it serves; the platform
/// hides them (`EditionFeature` in `apps/web/platform/lib/edition.ts`).
pub(crate) const UNAVAILABLE_FEATURES: &[&str] = &[
    // `/api/sso` claims and verifies a domain, but the SAML connection lives
    // at the identity provider (Clerk's): every connection change answers 502.
    "sso-connections",
    // Paid WeldApps: their subscriptions and developer payouts are Stripe's.
    "paid-apps",
    // The desktop app's sign-in ticket (`POST /api/auth-desktop/ticket`)
    // needs an identity provider that mints one.
    "desktop-sign-in",
    // Analytics pages read Cloudflare's analytics store.
    "analytics",
    // `POST /api/company-logos/resolve` (crm-api) fetches each company's
    // website and keeps the logo in R2; not served, so avatars keep initials.
    "company-logos",
    // WeldChat voice and video calls (`/api/chat-calls`) run on Cloudflare
    // RealtimeKit, its API and the call UI's client SDK alike; they come with
    // LiveKit in the call UI.
    "chat-calls",
    // WeldDesk help center custom domains: attaching one writes a CNAME into a
    // Cloudflare zone and registers the host on the Vercel-hosted help center
    // (`/api/helpcenter-settings/domains`, its verify and delete).
    "helpcenter-custom-domains",
    // WeldHR payroll: sending the loonaangifte over Digipoort needs the
    // worker's PKIoverheid client certificate binding. The return is filed
    // by hand and marked as filed (`POST …/filings/:id/submit` answers
    // DIGIPOORT_NOT_CONFIGURED, as the worker without the binding does).
    "payroll-digipoort",
    // WeldCall: buying a phone number and submitting a number port are Stripe
    // checkouts through Global's billing-worker (`/api/telephony/phone-numbers/provision`,
    // `/api/porting/:id/submit`); numbers come from the Telnyx account (sync).
    "phone-number-purchase",
    // WeldBooks VAT: sending the BTW-aangifte and the Opgaaf ICP to Digipoort
    // needs the worker's PKIoverheid client certificate binding. Without it
    // the worker builds the envelope and answers a simulated submission, as
    // Rust always does (`POST /api/vat-returns/:id/file`,
    // `/api/icp-declarations/:id/file`); the platform hides filing and the
    // status check, and the XBRL download is filed by hand.
    "vat-digipoort",
    // WeldHost: buying and renewing domains charge through Stripe, which
    // stays with Global (`POST /api/domains/checkout` and `/:id/renew` answer
    // "Stripe is not configured", as the worker without the key does).
    // Managing, transferring and external domains stay available.
    "domain-purchase",
    // WeldMeet transcripts and summaries: Whisper and the summary model run in
    // the worker's MEETING_AI Workflow, and the video provider's own
    // transcript and summary are RealtimeKit's. `POST …/recording/transcribe`
    // and `…/summarize` answer 503 as the worker without the binding does,
    // and the AI options of a live meeting need RealtimeKit. Listed whatever
    // the AI provider while `meet-recordings` is: there is nothing to
    // transcribe without a recording.
    "meet-transcription",
    // WeldMeet recordings: RealtimeKit's recorder uploads the file and the
    // worker's MEETING_RECORDING_COPY Workflow copies it into the private
    // MEETING_RECORDINGS bucket. On LiveKit that would be an Egress into the
    // files store, which isn't built: access, streaming and deletes answer
    // 503 "Recording storage is not configured".
    "meet-recordings",
    // Choosing where a new workspace's data is stored: Global puts each
    // workspace's database in the Neon region picked at signup. A Kubernetes
    // install keeps every workspace in its own one cluster, so there is no
    // choice to offer (onboarding's `region` only lands in the metadata).
    "data-regions",
];

/// The AI features (ADR AI-012): served on the install's AI provider
/// (`AI_DEFAULT_PROVIDER`, `weldsuite_ai`), listed as unavailable only when
/// there is none, as the workers answer without their model.
pub(crate) const AI_FEATURES: &[&str] = &[
    // WeldMail AI (`/api/mail-ai`): drafts, replies, summaries, labels.
    "mail-ai",
    // WeldConnect's "Generate with AI" (`POST /api/workflows/generate`) and
    // its `ai_generate` / `ai_classify` steps.
    "weldconnect-ai",
    // WeldBooks document OCR (`POST /api/accounting-documents/:id/process`).
    "books-ocr",
    // WeldDesk's inbox translation (`POST /api/desk/conversations/:id/translate`
    // and `/translate-reply`).
    "desk-ai",
    // WeldForms' AI (`/api/forms/ai/*` and the response summaries).
    "forms-ai",
    // `POST /api/search/reindex`: the semantic search index's embeddings.
    "search-reindex",
    // The assistant chat and drawer (`/api/ai/generate`, `/api/ai/chat`,
    // `/api/ai/chat/stream` without an agent).
    "assistant-ai",
    // WeldAgent's agents, routines and teach mode, on the Kubernetes
    // editions' own agent loop.
    "agent-ai",
];

/// WeldAgent: offered by `/config.json` only with an AI provider.
pub(crate) const AI_MODULE: &str = "agent";

/// WeldDocs, WeldSheets and WeldBoard: live editing runs in the collab-rooms
/// service (`rust/docs/collab-rooms.md`). Without `COLLAB_ROOMS_URLS` (the
/// chart's `collabRooms.enabled: false`) every route that needs a room or an
/// engine answers 503, so the platform hides the three apps.
pub(crate) const COLLAB_ROOMS_FEATURE: &str = "collab-rooms";

/// WeldMail custom domains (`/api/mail-domains`, MAIL-010 and MAIL-011): the
/// records point at the deployment's own MX (`MAIL_MX_HOST`, Haraka) and, on
/// the EU edition, the MTA mints each domain's DKIM key (`MTA_API_URL`).
/// Unavailable when the deployment has no MX: no domain could receive mail,
/// and the routes answer 503 (`crate::routes::mail_domains`).
pub(crate) const MAIL_DOMAINS_FEATURE: &str = "mail-domains";

/// Free WeldMail addresses (`/api/mail-weldmail`, MAIL-007 and MAIL-012) on
/// the deployment's own domain, `{slug}.<WELDMAIL_DOMAIN>` (`weldmail.eu` on
/// the EU edition). Unavailable without that domain or without an MX:
/// `weldmail.com` and `weldmail.org` are Global's and never used here.
pub(crate) const MAIL_FREE_ADDRESSES_FEATURE: &str = "mail-free-addresses";

/// Buying credits (`POST /api/credits/checkout`): a Mollie payment on the
/// Kubernetes editions (`weldsuite_core_platform::topup`, ADR OPS-012), a
/// Stripe Checkout on Global. Unavailable without `MOLLIE_API_KEY` (and an
/// address Mollie reports payments to): the checkout then answers as the
/// workers do without billing-worker.
pub(crate) const CREDIT_TOP_UP_FEATURE: &str = "credit-top-up";

/// Plans, seats, payment methods and invoices (`/api/billing`): Mollie on the
/// Kubernetes editions when `BILLING_PROVIDER=mollie` (`weldsuite_core_billing`,
/// ADR BILL-014), Stripe on Global. Unavailable otherwise: a self-hosted
/// install's seats and modules come from its licence.
pub(crate) const BILLING_FEATURE: &str = "billing";

/// WeldReach's inbox subscription: billing-worker's (Stripe) on Global. Here
/// inboxes ride on the plan's Mollie charge where plans are billed through
/// Mollie (`weldsuite_core_billing::addons`, ADR BILL-014); otherwise they are
/// provisioned unbilled (ADR REACH-010).
pub(crate) const REACH_BILLING_FEATURE: &str = "reach-billing";

/// WeldAgent's sandbox, computer use and web browsing (the `computer:use` and
/// `browser:use` toggles of the builder): Claude Managed Agents run them on
/// Global; the Kubernetes editions run them on the install's own sandbox pods
/// and `SearXNG` (`weldsuite_sandbox`, ADR AI-012 phase 5). Unavailable without
/// one (`SANDBOX_ENABLED`, the chart's `sandbox.enabled`).
pub(crate) const AGENT_SANDBOX_FEATURE: &str = "agent-sandbox";

/// The public settings `PUBLIC_ENV` may carry into `/config.json`'s `env`,
/// by the platform's name for them. Never add a secret: anyone can read the
/// document.
pub(crate) const PUBLIC_ENV_KEYS: &[&str] = &[
    // Mapbox's public access token (`pk.…`): maps and address search.
    "VITE_MAPBOX_ACCESS_TOKEN",
    // The public API's origin, shown with API keys and to WeldApps.
    "VITE_EXTERNAL_API_URL",
    // WeldApps: the dedicated bundle origin, and whether community apps get
    // one origin each.
    "VITE_USER_APP_BUNDLE_ORIGIN",
    "VITE_USER_APP_ISOLATE_COMMUNITY_APPS",
    // Public pages the platform links to.
    "VITE_BOOKING_PORTAL_URL",
    "VITE_MEETING_PORTAL_URL",
];

/// The edition and the public settings, read at start.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "one flag per service the deployment may have, each an edition feature"
)]
pub(crate) struct EditionConfig {
    pub(crate) edition: Edition,
    /// Name → value, only names in [`PUBLIC_ENV_KEYS`].
    pub(crate) public_env: BTreeMap<String, String>,
    /// The video client the frontends join rooms with.
    pub(crate) video: ClientSettings,
    /// The chosen video provider has its credentials
    /// (`weldsuite_video_rooms::configured`); without them WeldMeet is hidden.
    pub(crate) video_configured: bool,
    /// A collab-rooms service is configured (`COLLAB_ROOMS_URLS`).
    pub(crate) live_editing: bool,
    /// What the deployment offers of WeldMail's addresses.
    pub(crate) mail: MailOffer,
    /// `/config.json`'s `ai` block (`weldsuite_ai::AiConfig::describe`), set
    /// by `Config` from `AI_*`; `None` is AI off: [`AI_FEATURES`] are
    /// unavailable and [`AI_MODULE`] isn't offered.
    pub(crate) ai: Option<Value>,
    /// Credits can be bought through Mollie: [`CREDIT_TOP_UP_FEATURE`].
    pub(crate) credit_top_up: bool,
    /// Plans are billed through Mollie (`BILLING_PROVIDER=mollie`):
    /// [`BILLING_FEATURE`], and `/config.json`'s `billingProvider`.
    pub(crate) plan_billing: bool,
    /// WeldAgent has a sandbox (`SANDBOX_ENABLED`, set by `Config`):
    /// [`AGENT_SANDBOX_FEATURE`].
    pub(crate) sandbox: bool,
}

/// WeldMail's address features this deployment can serve.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct MailOffer {
    /// Custom domains have an adapter (`MAIL_MX_HOST`, and the MTA's API when
    /// set): [`MAIL_DOMAINS_FEATURE`].
    pub(crate) custom_domains: bool,
    /// Free addresses have a domain of this deployment's own
    /// (`WELDMAIL_DOMAIN`) and an MX: [`MAIL_FREE_ADDRESSES_FEATURE`].
    pub(crate) free_addresses: bool,
}

impl MailOffer {
    /// From the environment. A `WELDMAIL_DOMAIN` of Global's is a problem:
    /// the deployment never hands out `weldmail.com` or `weldmail.org`.
    fn from_lookup(lookup: &impl Fn(&str) -> Option<String>, problems: &mut Vec<String>) -> Self {
        let custom_domains = crate::routes::mail_domains::offered(lookup);
        let free_domain = lookup("WELDMAIL_DOMAIN").filter(|apex| !apex.trim().is_empty());
        if let Some(apex) = &free_domain
            && !weldsuite_mail::is_free_apex(apex)
        {
            problems.push(format!(
                "WELDMAIL_DOMAIN: {} can't carry free addresses here (weldmail.com and weldmail.org are Global's; the EU edition uses weldmail.eu)",
                apex.trim()
            ));
        }
        Self {
            custom_domains,
            free_addresses: custom_domains
                && free_domain.is_some_and(|apex| weldsuite_mail::is_free_apex(&apex)),
        }
    }
}

impl Default for EditionConfig {
    fn default() -> Self {
        Self {
            edition: Edition::SelfHosted,
            public_env: BTreeMap::new(),
            video: ClientSettings::default(),
            video_configured: false,
            live_editing: false,
            mail: MailOffer::default(),
            ai: None,
            credit_top_up: false,
            plan_billing: false,
            sandbox: false,
        }
    }
}

/// The module that needs a video service: hidden from `/config.json`'s
/// `modules` when none is configured.
pub(crate) const VIDEO_MODULE: &str = "meet";

impl EditionConfig {
    /// `EDITION` and `PUBLIC_ENV` (a JSON object of strings, as the chart
    /// writes `config.publicEnv`). A name outside [`PUBLIC_ENV_KEYS`] is a
    /// problem, so a secret put there by mistake stops the start instead of
    /// being published.
    pub(crate) fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
    ) -> Self {
        let edition = match lookup("EDITION").as_deref() {
            None | Some("self-hosted") => Edition::SelfHosted,
            Some("eu") => Edition::Eu,
            Some(_) => {
                problems.push("EDITION must be eu or self-hosted".to_owned());
                Edition::SelfHosted
            }
        };
        let public_env = lookup("PUBLIC_ENV")
            .map(|raw| public_env(&raw, problems))
            .unwrap_or_default();
        let mail = MailOffer::from_lookup(lookup, problems);
        let credit_top_up = match weldsuite_core_platform::TopUpSettings::from_lookup(lookup) {
            Ok(settings) => settings.is_some(),
            Err(problem) => {
                problems.push(problem);
                false
            }
        };
        let plan_billing = match weldsuite_core_billing::BillingSettings::from_lookup(lookup) {
            Ok(settings) => settings.is_some(),
            Err(problem) => {
                problems.push(problem);
                false
            }
        };
        Self {
            credit_top_up,
            plan_billing,
            edition,
            public_env,
            video: weldsuite_video_rooms::client_settings(lookup),
            video_configured: weldsuite_video_rooms::configured(lookup),
            live_editing: lookup("COLLAB_ROOMS_URLS")
                .is_some_and(|urls| urls.split(',').any(|url| !url.trim().is_empty())),
            mail,
            // `Config` reads `AI_*` once, with its problems, and sets it.
            ai: None,
            // `Config` reads `SANDBOX_*` likewise.
            sandbox: false,
        }
    }

    /// Adds `edition`, `unavailableFeatures` and, when set, `env` to the
    /// `/config.json` body.
    pub(crate) fn describe(&self, body: &mut Value) {
        body["edition"] = json!(self.edition.as_str());
        body["unavailableFeatures"] = json!(self.unavailable_features());
        if !self.public_env.is_empty() {
            body["env"] = json!(self.public_env);
        }
        body["videoProvider"] = json!(self.video.provider.as_str());
        if let Some(url) = &self.video.url {
            body["videoUrl"] = json!(url);
        }
        if let Some(ai) = &self.ai {
            body["ai"] = ai.clone();
        }
        if self.plan_billing {
            // The platform's switch for Mollie's flows (payment methods by
            // hosted checkout, the checkout return page); absent on Global.
            body["billingProvider"] = json!("mollie");
        }
    }
}

impl EditionConfig {
    /// [`UNAVAILABLE_FEATURES`], and the AI features, custom mail domains and
    /// live editing when they aren't configured.
    pub(crate) fn unavailable_features(&self) -> Vec<&'static str> {
        let mut features = UNAVAILABLE_FEATURES.to_vec();
        if self.ai.is_none() {
            features.extend_from_slice(AI_FEATURES);
        }
        if !self.mail.custom_domains {
            features.push(MAIL_DOMAINS_FEATURE);
        }
        if !self.mail.free_addresses {
            features.push(MAIL_FREE_ADDRESSES_FEATURE);
        }
        if !self.credit_top_up {
            features.push(CREDIT_TOP_UP_FEATURE);
        }
        if !self.plan_billing {
            features.push(BILLING_FEATURE);
            features.push(REACH_BILLING_FEATURE);
        }
        if !self.sandbox {
            features.push(AGENT_SANDBOX_FEATURE);
        }
        if !self.live_editing {
            features.push(COLLAB_ROOMS_FEATURE);
        }
        features
    }

    /// Whether `/config.json` offers `module`: WeldMeet only with a video
    /// service ([`VIDEO_MODULE`]), WeldAgent only with an AI provider
    /// ([`AI_MODULE`]). The routes stay mounted either way.
    pub(crate) fn offers(&self, module: &str) -> bool {
        (module != VIDEO_MODULE || self.video_configured)
            && (module != AI_MODULE || self.ai.is_some())
    }
}

fn public_env(raw: &str, problems: &mut Vec<String>) -> BTreeMap<String, String> {
    let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(raw) else {
        problems.push("PUBLIC_ENV must be a JSON object of strings".to_owned());
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    for (name, value) in entries {
        if !PUBLIC_ENV_KEYS.contains(&name.as_str()) {
            problems.push(format!(
                "PUBLIC_ENV: {name} is not a public setting /config.json may carry (one of {})",
                PUBLIC_ENV_KEYS.join(", ")
            ));
            continue;
        }
        match value {
            Value::String(text) if text.trim().is_empty() => {}
            Value::String(text) => {
                out.insert(name, text);
            }
            _ => problems.push(format!("PUBLIC_ENV: {name} must be a string")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(vars: &[(&str, &str)]) -> (EditionConfig, Vec<String>) {
        let mut problems = Vec::new();
        let lookup = |name: &str| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        };
        let config = EditionConfig::from_lookup(&lookup, &mut problems);
        (config, problems)
    }

    #[test]
    fn defaults_to_self_hosted_without_public_settings() {
        let (config, problems) = read(&[]);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(config, EditionConfig::default());
        let mut body = json!({});
        config.describe(&mut body);
        assert_eq!(body["edition"], "self-hosted");
        assert!(body.get("env").is_none());
        assert_eq!(body["videoProvider"], "realtimekit");
        assert!(body.get("videoUrl").is_none());
        assert_eq!(
            body["unavailableFeatures"]
                .as_array()
                .map(Vec::len)
                .unwrap_or_default(),
            UNAVAILABLE_FEATURES.len() + AI_FEATURES.len() + 7
        );
        assert_eq!(
            body["unavailableFeatures"]
                .as_array()
                .and_then(|f| f.last()),
            Some(&json!(COLLAB_ROOMS_FEATURE))
        );
        assert!(body.get("ai").is_none(), "no AI provider");
    }

    /// The AI features and WeldAgent follow the install's AI provider; what
    /// AI can't serve on Kubernetes stays listed either way.
    #[test]
    fn offers_the_ai_features_with_an_ai_provider() {
        let (off, _) = read(&[]);
        let lacks = off.unavailable_features();
        for feature in AI_FEATURES {
            assert!(lacks.contains(feature), "{feature}");
        }
        assert!(!off.offers(AI_MODULE));

        let block = json!({
            "defaultProvider": "mistral",
            "providers": [{ "id": "mistral", "region": "eu", "keySources": ["weldsuite"] }],
        });
        let on = EditionConfig {
            ai: Some(block.clone()),
            ..off
        };
        let lacks = on.unavailable_features();
        for feature in AI_FEATURES {
            assert!(!lacks.contains(feature), "{feature}");
        }
        for still in ["meet-transcription", "meet-recordings", "agent-sandbox"] {
            assert!(lacks.contains(&still), "{still}");
        }
        assert!(on.offers(AI_MODULE));
        assert!(on.offers("crm"));
        let mut body = json!({});
        on.describe(&mut body);
        assert_eq!(body["ai"], block);
    }

    /// WeldAgent's sandbox, computer use and browsing follow the install's
    /// sandbox (`SANDBOX_ENABLED`), whatever the AI provider.
    #[test]
    fn offers_the_agent_sandbox_with_a_sandbox() {
        let (off, _) = read(&[]);
        assert!(off.unavailable_features().contains(&AGENT_SANDBOX_FEATURE));
        let on = EditionConfig {
            sandbox: true,
            ..off
        };
        assert!(!on.unavailable_features().contains(&AGENT_SANDBOX_FEATURE));
        assert!(!UNAVAILABLE_FEATURES.contains(&AGENT_SANDBOX_FEATURE));
    }

    #[test]
    fn offers_live_editing_with_a_collab_rooms_service() {
        let (config, problems) = read(&[(
            "COLLAB_ROOMS_URLS",
            "http://collab-rooms-0.collab-rooms:8080, http://collab-rooms-1.collab-rooms:8080",
        )]);
        assert!(problems.is_empty(), "{problems:?}");
        assert!(config.live_editing);
        let mut body = json!({});
        config.describe(&mut body);
        let mut lacks = UNAVAILABLE_FEATURES.to_vec();
        lacks.extend_from_slice(AI_FEATURES);
        lacks.extend([
            MAIL_DOMAINS_FEATURE,
            MAIL_FREE_ADDRESSES_FEATURE,
            CREDIT_TOP_UP_FEATURE,
            BILLING_FEATURE,
            REACH_BILLING_FEATURE,
            AGENT_SANDBOX_FEATURE,
        ]);
        assert_eq!(body["unavailableFeatures"], json!(lacks));
        // A blank list is no service.
        let (blank, _) = read(&[("COLLAB_ROOMS_URLS", " , ")]);
        assert!(!blank.live_editing);
    }

    #[test]
    fn offers_custom_mail_domains_with_an_mx() {
        let lacks = |vars: &[(&str, &str)]| {
            let (config, problems) = read(vars);
            assert!(problems.is_empty(), "{problems:?}");
            config
                .unavailable_features()
                .contains(&MAIL_DOMAINS_FEATURE)
        };
        assert!(lacks(&[]));
        assert!(lacks(&[("MAIL_MX_HOST", " ")]), "a blank MX is none");
        assert!(!lacks(&[("MAIL_MX_HOST", "mx.weldsuite.eu")]));
        assert!(!lacks(&[
            ("MAIL_MX_HOST", "mx.weldsuite.eu"),
            (
                "MTA_API_URL",
                "http://weldsuite-mta-api.weldsuite-mail.svc:8025"
            ),
            ("MTA_API_SECRET", "s3cret"),
        ]));
        // Half the MTA's settings: the server builds no adapter, so none is offered.
        assert!(lacks(&[
            ("MAIL_MX_HOST", "mx.weldsuite.eu"),
            (
                "MTA_API_URL",
                "http://weldsuite-mta-api.weldsuite-mail.svc:8025"
            ),
        ]));
    }

    #[test]
    fn offers_free_addresses_only_on_a_domain_of_its_own() {
        let lacks = |vars: &[(&str, &str)]| {
            let (config, problems) = read(vars);
            assert!(problems.is_empty(), "{problems:?}");
            config
                .unavailable_features()
                .contains(&MAIL_FREE_ADDRESSES_FEATURE)
        };
        let mx = ("MAIL_MX_HOST", "mx.weldsuite.eu");
        let eu = ("WELDMAIL_DOMAIN", "weldmail.eu");
        assert!(lacks(&[]));
        assert!(lacks(&[mx]), "no domain of its own");
        assert!(lacks(&[eu]), "no MX to receive on");
        assert!(!lacks(&[mx, eu]));

        // Global's domains stop the start instead of being handed out.
        for global in ["weldmail.com", "weldmail.org", "test.weldmail.com"] {
            let (config, problems) = read(&[mx, ("WELDMAIL_DOMAIN", global)]);
            assert_eq!(problems.len(), 1, "{global}: {problems:?}");
            assert!(problems[0].contains("Global's"), "{problems:?}");
            assert!(!config.mail.free_addresses);
        }
    }

    #[test]
    fn offers_the_credit_top_up_with_mollie() {
        let lacks = |vars: &[(&str, &str)]| {
            let (config, problems) = read(vars);
            assert!(problems.is_empty(), "{problems:?}");
            config
                .unavailable_features()
                .contains(&CREDIT_TOP_UP_FEATURE)
        };
        assert!(lacks(&[]));
        assert!(lacks(&[("MOLLIE_API_KEY", " ")]), "a blank key is none");
        assert!(!lacks(&[
            ("MOLLIE_API_KEY", "live_key"),
            ("PUBLIC_URL", "https://app.weldsuite.eu"),
        ]));
        // A key Mollie could never report payments for stops the start.
        let (config, problems) = read(&[("MOLLIE_API_KEY", "live_key")]);
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].contains("MOLLIE_WEBHOOK_URL"), "{problems:?}");
        assert!(!config.credit_top_up);
    }

    #[test]
    fn offers_plan_billing_with_mollie() {
        let full = [
            ("BILLING_PROVIDER", "mollie"),
            ("MOLLIE_API_KEY", "test_key"),
            ("PUBLIC_URL", "https://app.weldsuite.eu"),
            ("BILLING_ISSUER_WORKSPACE_ID", "ws_issuer"),
            ("BILLING_PAY_LINK_KEY", "0123456789abcdef0123456789abcdef"),
        ];
        let (off, problems) = read(&[]);
        assert!(problems.is_empty(), "{problems:?}");
        assert!(off.unavailable_features().contains(&BILLING_FEATURE));
        assert!(off.unavailable_features().contains(&REACH_BILLING_FEATURE));
        let mut body = json!({});
        off.describe(&mut body);
        assert!(
            body.get("billingProvider").is_none(),
            "absent without billing"
        );

        let (on, problems) = read(&full);
        assert!(problems.is_empty(), "{problems:?}");
        assert!(on.plan_billing);
        assert!(!on.unavailable_features().contains(&BILLING_FEATURE));
        // WeldReach inboxes ride on the plan's charge.
        assert!(!on.unavailable_features().contains(&REACH_BILLING_FEATURE));
        let mut body = json!({});
        on.describe(&mut body);
        assert_eq!(body["billingProvider"], "mollie");

        // Turned on but not configured: the start stops.
        let (half, problems) = read(&[("BILLING_PROVIDER", "mollie")]);
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(
            problems[0].contains("BILLING_ISSUER_WORKSPACE_ID"),
            "{problems:?}"
        );
        assert!(!half.plan_billing);
    }

    #[test]
    fn offers_weldmeet_only_with_a_video_service() {
        let (none, _) = read(&[]);
        assert!(!none.offers(VIDEO_MODULE));
        assert!(none.offers("crm"), "other modules don't depend on video");
        let (livekit, problems) = read(&[
            ("LIVEKIT_URL", "wss://lk.example.eu"),
            ("LIVEKIT_API_KEY", "key"),
            ("LIVEKIT_API_SECRET", "secret"),
        ]);
        assert!(problems.is_empty(), "{problems:?}");
        assert!(livekit.offers(VIDEO_MODULE));
    }

    #[test]
    fn reads_the_edition_and_the_public_settings() {
        let (config, problems) = read(&[
            ("EDITION", "eu"),
            (
                "PUBLIC_ENV",
                r#"{"VITE_MAPBOX_ACCESS_TOKEN":"pk.eu","VITE_MEETING_PORTAL_URL":" "}"#,
            ),
        ]);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(config.edition, Edition::Eu);
        let mut body = json!({ "backend": "rust" });
        config.describe(&mut body);
        assert_eq!(body["edition"], "eu");
        // Blank values are left out, like unset ones.
        assert_eq!(body["env"], json!({ "VITE_MAPBOX_ACCESS_TOKEN": "pk.eu" }));
    }

    #[test]
    fn names_the_livekit_server_the_clients_join() {
        let (config, problems) = read(&[
            ("VIDEO_PROVIDER", "livekit"),
            ("LIVEKIT_URL", "wss://lk.example.eu"),
            ("LIVEKIT_API_URL", "http://livekit.video:7880"),
            ("LIVEKIT_API_SECRET", "never-published"),
        ]);
        assert!(problems.is_empty(), "{problems:?}");
        let mut body = json!({});
        config.describe(&mut body);
        assert_eq!(body["videoProvider"], "livekit");
        // The address the browsers reach, never the in-cluster API URL.
        assert_eq!(body["videoUrl"], "wss://lk.example.eu");
        assert!(!body.to_string().contains("never-published"));
    }

    #[test]
    fn refuses_anything_but_the_listed_public_settings() {
        let (config, problems) = read(&[
            ("EDITION", "global"),
            (
                "PUBLIC_ENV",
                r#"{"VITE_STRIPE_SECRET_KEY":"sk_live","VITE_MAPBOX_ACCESS_TOKEN":1}"#,
            ),
        ]);
        assert_eq!(problems.len(), 3, "{problems:?}");
        assert!(problems[0].contains("EDITION"));
        assert!(
            problems
                .iter()
                .any(|p| p.contains("VITE_STRIPE_SECRET_KEY") && p.contains("not a public"))
        );
        assert!(
            problems
                .iter()
                .any(|p| p.contains("VITE_MAPBOX_ACCESS_TOKEN must be a string"))
        );
        assert!(config.public_env.is_empty());

        let (_, problems) = read(&[("PUBLIC_ENV", "[]")]);
        assert_eq!(problems, ["PUBLIC_ENV must be a JSON object of strings"]);
    }

    #[test]
    fn feature_names_are_kebab_case_and_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for feature in UNAVAILABLE_FEATURES.iter().chain(AI_FEATURES).chain([
            &MAIL_DOMAINS_FEATURE,
            &MAIL_FREE_ADDRESSES_FEATURE,
            &COLLAB_ROOMS_FEATURE,
            &REACH_BILLING_FEATURE,
        ]) {
            assert!(
                feature.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{feature}"
            );
            assert!(seen.insert(*feature), "{feature} twice");
        }
    }
}
