//! Edition flags (P4 work package 4.F3): what `/config.json` tells the
//! platform about this deployment besides its API, so a Kubernetes install
//! never shows a screen its backend can't serve.
//!
//! - `edition`: which Kubernetes edition this is (`EDITION`).
//! - `unavailableFeatures`: what this backend lacks even inside the modules
//!   it serves ([`UNAVAILABLE_FEATURES`]). The modules themselves come from
//!   the catalog (`RUST_PORTED_MODULES`), so neither list is configuration:
//!   both follow the code, and a port removes its entry here.
//! - `env`: public settings the platform would otherwise bake in at build
//!   time, by their `VITE_*` name (`PUBLIC_ENV`), limited to
//!   [`PUBLIC_ENV_KEYS`] because the document is public.
//!
//! The platform reads them in `apps/web/platform/lib/edition.ts` and
//! `lib/runtime-config.ts`. Global serves no `/config.json` and offers
//! everything.

use std::collections::BTreeMap;

use serde_json::{Value, json};

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
    // Stripe stays with Global's billing-worker: plans, subscriptions, seats
    // bought by card, payment methods and invoices (`/api/billing`).
    "billing",
    // Buying credits is a Stripe checkout (`POST /api/credits/checkout`).
    "credit-top-up",
    // Paid WeldApps: their subscriptions and developer payouts are Stripe's.
    "paid-apps",
    // The desktop app's sign-in ticket (`POST /api/auth-desktop/ticket`)
    // needs an identity provider that mints one.
    "desktop-sign-in",
    // Analytics pages read Cloudflare's analytics store.
    "analytics",
    // `POST /api/search/reindex` isn't served.
    "search-reindex",
    // `POST /api/company-logos/resolve` (crm-api) fetches each company's
    // website and keeps the logo in R2; not served, so avatars keep initials.
    "company-logos",
    // WeldMail custom domains (`/api/mail-domains`) are Cloudflare Email
    // Routing and DNS on Global; the Kubernetes answers differ (MAIL-010).
    "mail-domains",
    // Free `{slug}.weldmail.com` addresses (`/api/mail-weldmail`): that
    // domain's MX and reputation belong to Global (MAIL-010).
    "mail-free-addresses",
    // WeldMail AI (`/api/mail-ai`): the Rust backend has no AI port yet.
    "mail-ai",
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
    // WeldBooks document OCR (`POST /api/accounting-documents/:id/process`)
    // reads the file with a model on Workers AI; the route keeps its refusals
    // and answers 503 where it would call the model.
    "books-ocr",
];

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
pub(crate) struct EditionConfig {
    pub(crate) edition: Edition,
    /// Name → value, only names in [`PUBLIC_ENV_KEYS`].
    pub(crate) public_env: BTreeMap<String, String>,
}

impl Default for EditionConfig {
    fn default() -> Self {
        Self {
            edition: Edition::SelfHosted,
            public_env: BTreeMap::new(),
        }
    }
}

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
        Self {
            edition,
            public_env,
        }
    }

    /// Adds `edition`, `unavailableFeatures` and, when set, `env` to the
    /// `/config.json` body.
    pub(crate) fn describe(&self, body: &mut Value) {
        body["edition"] = json!(self.edition.as_str());
        body["unavailableFeatures"] = json!(UNAVAILABLE_FEATURES);
        if !self.public_env.is_empty() {
            body["env"] = json!(self.public_env);
        }
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
        assert_eq!(
            body["unavailableFeatures"]
                .as_array()
                .map(Vec::len)
                .unwrap_or_default(),
            UNAVAILABLE_FEATURES.len()
        );
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
        for feature in UNAVAILABLE_FEATURES {
            assert!(
                feature.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{feature}"
            );
            assert!(seen.insert(*feature), "{feature} twice");
        }
    }
}
