//! The services outside the EU a workspace can switch on (ADR OPS-026): one
//! entry per company, with where it is, what data goes there and what in
//! WeldSuite uses it.
//!
//! This is the one list. A new integration or provider that sends a
//! workspace's data to a company outside the EU joins it here (a
//! [`ServiceId`], its [`Service`], and its integration codes in
//! [`ServiceId::for_integration`]), and its call paths check the switch with
//! [`crate::require`] or [`crate::allowed`]. The platform names each service
//! and use by id (`settings.outsideEu` in `@weldsuite/i18n`); the English
//! text here is for the API and `weldsuite admin`.
//!
//! Not listed, on purpose:
//!
//! - **EU companies**: Ponto, Enable Banking, Moneybird, Mollie, Mistral,
//!   Realtime Register, Picqer, Odoo. Lemlist (Paris; its data is stored in
//!   France, at OVH, and not exported outside the EEA, per its help centre)
//!   and Findymail (Lyon, hosted in the EU).
//! - **AI providers** (Anthropic, `OpenAI`): their own opt-in in
//!   `/api/ai-settings` (ADR AI-012, `weldsuite_ai::policy`).
//! - **Mapbox**: not offered on the Kubernetes editions at all (ADR FE-020).
//! - **`WooCommerce`**: the shop is the workspace's own server.

use serde::{Deserialize, Serialize};

/// A service outside the EU, by company.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceId {
    Telnyx,
    Cloudflare,
    Mailpool,
    #[serde(rename = "postpeer")]
    PostPeer,
    Meta,
    Plaid,
    Stripe,
    Prospeo,
    Google,
    Microsoft,
    Slack,
    Discord,
    #[serde(rename = "hubspot")]
    HubSpot,
    Attio,
    #[serde(rename = "github")]
    GitHub,
    #[serde(rename = "gitlab")]
    GitLab,
    Atlassian,
    Shopify,
    Twilio,
    Notion,
    Airtable,
    Asana,
}

/// Whose account with the service the calls use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Account {
    /// WeldSuite's own account (an install key such as `TELNYX_API_KEY`).
    Weldsuite,
    /// An account the workspace connects (OAuth, an API key or a token).
    Workspace,
}

/// Something in WeldSuite that calls the service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Use {
    /// The API module (`@weldsuite/api-modules` id) it belongs to.
    pub module: &'static str,
    /// A stable key the platform names it by (`settings.outsideEu.uses.<key>`).
    pub key: &'static str,
    /// English, for the API and `weldsuite admin`.
    pub label: &'static str,
}

/// One service: who runs it, where, what leaves the EU and what uses it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: ServiceId,
    /// The name the UI shows ("Google").
    pub name: &'static str,
    /// The company the data goes to.
    pub company: &'static str,
    /// Where the company processes the data: an ISO 3166-1 alpha-2 code.
    pub country: &'static str,
    /// What leaves the EU, in English.
    pub data: &'static str,
    pub account: Account,
    pub uses: &'static [Use],
}

const fn used(module: &'static str, key: &'static str, label: &'static str) -> Use {
    Use { module, key, label }
}

/// Every service, in the order the settings page lists them: WeldSuite's own
/// accounts first, then what a workspace connects.
pub const SERVICES: &[Service] = &[
    Service {
        id: ServiceId::Telnyx,
        name: "Telnyx",
        company: "Telnyx LLC",
        country: "US",
        data: "Phone numbers, calls and their recordings, text messages and caller details",
        account: Account::Weldsuite,
        uses: &[
            used(
                "call",
                "call-telephony",
                "WeldCall phone numbers, calls and recordings",
            ),
            used("desk", "desk-phone", "The WeldDesk phone channel"),
            used("connect", "connect-sms", "WeldConnect's \"Send SMS\" step"),
        ],
    },
    Service {
        id: ServiceId::Cloudflare,
        name: "Cloudflare DNS",
        company: "Cloudflare, Inc.",
        country: "US",
        data: "Domain names and their DNS records",
        account: Account::Weldsuite,
        uses: &[
            used("host", "host-dns", "WeldHost DNS zones and records"),
            used("reach", "reach-domains", "WeldReach sending domains"),
        ],
    },
    Service {
        id: ServiceId::Mailpool,
        name: "Mailpool",
        company: "Mailpool (mailboxes on Google Workspace and Microsoft 365)",
        country: "US",
        data: "Sending domains, mailbox names and the cold email sent and received through them",
        account: Account::Weldsuite,
        uses: &[used("reach", "reach-mailboxes", "WeldReach mailboxes")],
    },
    Service {
        id: ServiceId::PostPeer,
        name: "PostPeer",
        company: "PostPeer",
        country: "IL",
        data: "Social posts and their media, scheduled times and the connected social accounts",
        account: Account::Weldsuite,
        uses: &[used(
            "social",
            "social-publishing",
            "WeldSocial publishing and connected accounts",
        )],
    },
    Service {
        id: ServiceId::Meta,
        name: "Meta",
        company: "Meta Platforms, Inc.",
        country: "US",
        data: "Ad accounts, campaigns, ads, budgets and their results",
        account: Account::Weldsuite,
        uses: &[used(
            "ads",
            "ads-meta",
            "WeldAds: Meta (Facebook and Instagram) ads",
        )],
    },
    Service {
        id: ServiceId::Plaid,
        name: "Plaid",
        company: "Plaid Inc.",
        country: "US",
        data: "Bank accounts, balances and transactions",
        account: Account::Weldsuite,
        uses: &[used("books", "books-bank-feeds", "WeldBooks bank feeds")],
    },
    Service {
        id: ServiceId::Stripe,
        name: "Stripe",
        company: "Stripe, Inc.",
        country: "US",
        data: "Bank accounts and transactions (Financial Connections); customers, invoices and payments of a connected Stripe account",
        account: Account::Weldsuite,
        uses: &[
            used(
                "books",
                "books-bank-feeds",
                "WeldBooks bank feeds (Financial Connections)",
            ),
            used("connect", "connect-stripe", "The Stripe connector"),
        ],
    },
    Service {
        id: ServiceId::Prospeo,
        name: "Prospeo",
        company: "Prospeo",
        country: "CA",
        data: "Names and company domains of the people whose email address is looked up",
        account: Account::Weldsuite,
        uses: &[used("data", "data-email-finder", "WeldData's email finder")],
    },
    Service {
        id: ServiceId::Google,
        name: "Google",
        company: "Google LLC",
        country: "US",
        data: "Calendar events, email sent through Gmail and spreadsheet rows",
        account: Account::Workspace,
        uses: &[
            used("calendar", "calendar-google", "Google Calendar sync"),
            used(
                "connect",
                "connect-google",
                "WeldConnect's Gmail, Google Sheets and Google Calendar steps",
            ),
        ],
    },
    Service {
        id: ServiceId::Microsoft,
        name: "Microsoft",
        company: "Microsoft Corporation",
        country: "US",
        data: "Managed devices, repositories and pull requests, and Teams messages",
        account: Account::Workspace,
        uses: &[
            used(
                "core",
                "assets-intune",
                "The asset register's Microsoft Intune import",
            ),
            used("merge", "merge-azure-devops", "WeldMerge with Azure DevOps"),
            used(
                "connect",
                "connect-teams",
                "WeldConnect's Microsoft Teams step",
            ),
        ],
    },
    Service {
        id: ServiceId::Slack,
        name: "Slack",
        company: "Slack Technologies, LLC (Salesforce)",
        country: "US",
        data: "Messages, channels and the people in them",
        account: Account::Workspace,
        uses: &[
            used("desk", "desk-slack", "The WeldDesk Slack channel"),
            used("connect", "connect-slack", "WeldConnect's Slack steps"),
        ],
    },
    Service {
        id: ServiceId::Discord,
        name: "Discord",
        company: "Discord Inc.",
        country: "US",
        data: "Messages, channels and the people in them",
        account: Account::Workspace,
        uses: &[used("desk", "desk-discord", "The WeldDesk Discord channel")],
    },
    Service {
        id: ServiceId::HubSpot,
        name: "HubSpot",
        company: "HubSpot, Inc.",
        country: "US",
        data: "Contacts, companies and deals",
        account: Account::Workspace,
        uses: &[used(
            "connect",
            "connect-crm-sync",
            "CRM sync and WeldConnect steps",
        )],
    },
    Service {
        id: ServiceId::Attio,
        name: "Attio",
        company: "Attio Ltd",
        country: "GB",
        data: "Contacts and companies",
        account: Account::Workspace,
        uses: &[used(
            "connect",
            "connect-crm-sync",
            "CRM sync and WeldConnect steps",
        )],
    },
    Service {
        id: ServiceId::GitHub,
        name: "GitHub",
        company: "GitHub, Inc.",
        country: "US",
        data: "Repositories, issues, pull requests and their comments",
        account: Account::Workspace,
        uses: &[
            used("merge", "merge-github", "WeldMerge with GitHub"),
            used(
                "connect",
                "connect-github",
                "WeldConnect's and WeldFlow's GitHub connection",
            ),
        ],
    },
    Service {
        id: ServiceId::GitLab,
        name: "GitLab",
        company: "GitLab Inc.",
        country: "US",
        data: "Repositories, issues, merge requests and their comments",
        account: Account::Workspace,
        uses: &[used("merge", "merge-gitlab", "WeldMerge with GitLab")],
    },
    Service {
        id: ServiceId::Atlassian,
        name: "Bitbucket",
        company: "Atlassian",
        country: "AU",
        data: "Repositories, pull requests and their comments",
        account: Account::Workspace,
        uses: &[used("merge", "merge-bitbucket", "WeldMerge with Bitbucket")],
    },
    Service {
        id: ServiceId::Shopify,
        name: "Shopify",
        company: "Shopify Inc.",
        country: "CA",
        data: "Products, stock levels, orders and customers",
        account: Account::Workspace,
        uses: &[used("connect", "connect-shopify", "The Shopify connector")],
    },
    Service {
        id: ServiceId::Twilio,
        name: "Twilio",
        company: "Twilio Inc.",
        country: "US",
        data: "Phone numbers and the text of the messages sent",
        account: Account::Workspace,
        uses: &[used(
            "connect",
            "connect-twilio",
            "WeldConnect's Twilio step",
        )],
    },
    Service {
        id: ServiceId::Notion,
        name: "Notion",
        company: "Notion Labs, Inc.",
        country: "US",
        data: "The pages and database rows a workflow writes or reads",
        account: Account::Workspace,
        uses: &[used(
            "connect",
            "connect-notion",
            "WeldConnect's Notion steps",
        )],
    },
    Service {
        id: ServiceId::Airtable,
        name: "Airtable",
        company: "Formagrid, Inc. (Airtable)",
        country: "US",
        data: "The records a workflow writes or reads",
        account: Account::Workspace,
        uses: &[used(
            "connect",
            "connect-airtable",
            "WeldConnect's Airtable steps",
        )],
    },
    Service {
        id: ServiceId::Asana,
        name: "Asana",
        company: "Asana, Inc.",
        country: "US",
        data: "The tasks and projects a workflow writes or reads",
        account: Account::Workspace,
        uses: &[used(
            "connect",
            "connect-asana",
            "WeldConnect's Asana steps",
        )],
    },
];

impl ServiceId {
    /// Every service, in [`SERVICES`] order.
    pub fn all() -> impl Iterator<Item = Self> {
        SERVICES.iter().map(|service| service.id)
    }

    /// The id as the API and the store write it (`telnyx`, `github`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Telnyx => "telnyx",
            Self::Cloudflare => "cloudflare",
            Self::Mailpool => "mailpool",
            Self::PostPeer => "postpeer",
            Self::Meta => "meta",
            Self::Plaid => "plaid",
            Self::Stripe => "stripe",
            Self::Prospeo => "prospeo",
            Self::Google => "google",
            Self::Microsoft => "microsoft",
            Self::Slack => "slack",
            Self::Discord => "discord",
            Self::HubSpot => "hubspot",
            Self::Attio => "attio",
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
            Self::Atlassian => "atlassian",
            Self::Shopify => "shopify",
            Self::Twilio => "twilio",
            Self::Notion => "notion",
            Self::Airtable => "airtable",
            Self::Asana => "asana",
        }
    }

    /// An id as [`as_str`](Self::as_str) writes it.
    pub fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        Self::all().find(|id| id.as_str() == raw)
    }

    /// The service's entry in [`SERVICES`].
    pub fn service(self) -> &'static Service {
        SERVICES
            .iter()
            .find(|service| service.id == self)
            .unwrap_or(&SERVICES[0])
    }

    /// The service behind an integration, connector, channel or provider
    /// code as the routes and tables name it (`gmail`, `google_calendar`,
    /// `azure_devops`, `stripe`, …). `None`: not outside the EU (Moneybird,
    /// Picqer, Odoo, `WooCommerce`, Ponto, Enable Banking, Lemlist, Findymail,
    /// …) or unknown.
    pub fn for_integration(code: &str) -> Option<Self> {
        let code = code.trim().to_ascii_lowercase().replace('-', "_");
        Some(match code.as_str() {
            "telnyx" | "phone" | "sms" => Self::Telnyx,
            "cloudflare" | "cloudflare_dns" => Self::Cloudflare,
            "mailpool" => Self::Mailpool,
            "postpeer" => Self::PostPeer,
            "meta" | "meta_ads" | "facebook" | "facebook_ads" | "instagram" => Self::Meta,
            "plaid" => Self::Plaid,
            "stripe" | "stripe_connect" | "stripe_fc" | "stripe_financial_connections" => {
                Self::Stripe
            }
            "prospeo" => Self::Prospeo,
            "google" | "gmail" | "google_sheets" | "google_calendar" | "google_drive" => {
                Self::Google
            }
            "microsoft" | "microsoft_intune" | "intune" | "teams" | "microsoft_teams"
            | "azure_devops" | "azure" => Self::Microsoft,
            "slack" => Self::Slack,
            "discord" => Self::Discord,
            "hubspot" => Self::HubSpot,
            "attio" => Self::Attio,
            "github" => Self::GitHub,
            "gitlab" => Self::GitLab,
            "bitbucket" | "atlassian" => Self::Atlassian,
            "shopify" => Self::Shopify,
            "twilio" => Self::Twilio,
            "notion" => Self::Notion,
            "airtable" => Self::Airtable,
            "asana" => Self::Asana,
            _ => return None,
        })
    }
}

impl std::fmt::Display for ServiceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The integration codes [`ServiceId::for_integration`] knows, for the
/// platform's labels (`GET /api/outside-eu-services`'s `integrations`).
pub const INTEGRATION_CODES: &[&str] = &[
    "telnyx",
    "cloudflare",
    "mailpool",
    "postpeer",
    "meta",
    "meta_ads",
    "facebook",
    "instagram",
    "plaid",
    "stripe",
    "stripe_connect",
    "stripe_financial_connections",
    "prospeo",
    "google",
    "gmail",
    "google_sheets",
    "google_calendar",
    "google_drive",
    "microsoft",
    "microsoft_intune",
    "intune",
    "teams",
    "azure_devops",
    "slack",
    "discord",
    "hubspot",
    "attio",
    "github",
    "gitlab",
    "bitbucket",
    "shopify",
    "twilio",
    "notion",
    "airtable",
    "asana",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_id_is_listed_once_and_round_trips() {
        let mut seen = Vec::new();
        for service in SERVICES {
            assert!(!seen.contains(&service.id), "{} twice", service.id);
            seen.push(service.id);
            assert_eq!(ServiceId::parse(service.id.as_str()), Some(service.id));
            assert_eq!(service.id.service(), service);
            let json = serde_json::to_value(service.id).expect("serializes");
            assert_eq!(json, service.id.as_str());
            assert!(!service.uses.is_empty(), "{} has no use", service.id);
            assert_eq!(service.country.len(), 2, "{}", service.id);
        }
        assert_eq!(ServiceId::parse("nope"), None);
    }

    #[test]
    fn no_listed_country_is_in_the_eu() {
        const EU: &[&str] = &[
            "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
            "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
        ];
        for service in SERVICES {
            assert!(
                !EU.contains(&service.country),
                "{} is in the EU",
                service.id
            );
        }
    }

    #[test]
    fn integration_codes_map_to_their_company() {
        assert_eq!(
            ServiceId::for_integration("google_calendar"),
            Some(ServiceId::Google)
        );
        assert_eq!(ServiceId::for_integration("gmail"), Some(ServiceId::Google));
        assert_eq!(
            ServiceId::for_integration("azure-devops"),
            Some(ServiceId::Microsoft)
        );
        assert_eq!(
            ServiceId::for_integration("bitbucket"),
            Some(ServiceId::Atlassian)
        );
        for eu in [
            "moneybird",
            "picqer",
            "odoo",
            "woocommerce",
            "ponto",
            "enable_banking",
            "lemlist",
            "findymail",
            "mollie",
        ] {
            assert_eq!(ServiceId::for_integration(eu), None, "{eu}");
        }
        for code in INTEGRATION_CODES {
            assert!(ServiceId::for_integration(code).is_some(), "{code}");
        }
    }
}
