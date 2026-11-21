//! What a number's inbound route says about ringing, waiting and speaking,
//! with defaults filled in, and the texts the phone flows speak
//! (`lib/desk-phone-options.ts`).

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::js_trim;

/// `DEFAULT_PHONE_LANGUAGE`.
const DEFAULT_LANGUAGE: &str = "en-US";
pub(crate) const PHONE_VOICE: &str = "female";
/// `DESK_PHONE_DEFAULT_RING_SECONDS`.
const DEFAULT_RING_SECONDS: i64 = 25;
/// `DESK_PHONE_DEFAULT_MAX_WAIT_SECONDS`.
const DEFAULT_MAX_WAIT_SECONDS: i64 = 300;

/// `DeskPhoneMenuChoice`: one key of the keypad menu and where it sends the
/// caller.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct MenuChoice {
    pub(crate) digit: String,
    pub(crate) label: Option<String>,
    pub(crate) action: String,
    /// `ai_agent`.
    pub(crate) voice_agent_id: Option<String>,
    /// `agents`.
    pub(crate) department_id: Option<String>,
    /// `forward`.
    pub(crate) forward_to_e164: Option<String>,
}

/// `DeskPhoneMenu`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Menu {
    pub(crate) prompt: String,
    pub(crate) choices: Vec<MenuChoice>,
    pub(crate) fallback_digit: Option<String>,
}

impl Menu {
    /// A stored `options.menu`.
    fn stored(menu: &Value) -> Self {
        let text = |value: &Value| value.as_str().map(str::to_owned);
        Self {
            prompt: text(&menu["prompt"]).unwrap_or_default(),
            choices: menu["choices"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|choice| MenuChoice {
                    digit: text(&choice["digit"]).unwrap_or_default(),
                    label: text(&choice["label"]),
                    action: text(&choice["action"]).unwrap_or_default(),
                    voice_agent_id: text(&choice["voiceAgentId"]),
                    department_id: text(&choice["departmentId"]),
                    forward_to_e164: text(&choice["forwardToE164"]),
                })
                .collect(),
            fallback_digit: text(&menu["fallbackDigit"]),
        }
    }

    /// `menu.choices.find((c) => c.digit === digit)`.
    pub(crate) fn choice(&self, digit: &str) -> Option<&MenuChoice> {
        self.choices.iter().find(|choice| choice.digit == digit)
    }
}

/// `ResolvedRouteOptions`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RouteOptions {
    pub(crate) greeting: Option<String>,
    pub(crate) language: String,
    pub(crate) department_id: Option<String>,
    /// The stored number as it is: Telnyx's `timeout_secs` of a ringing leg.
    pub(crate) ring_seconds: Value,
    /// The stored number as it is: the queue's `max_wait_time_secs`.
    pub(crate) max_wait_seconds: Value,
    /// `voicemail` or `hangup`.
    pub(crate) when_unanswered: String,
    pub(crate) voicemail_greeting: Option<String>,
    pub(crate) menu: Option<Menu>,
}

/// `text?.trim() || null`.
fn spoken(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(js_trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `value ?? fallback` for a stored number.
fn number_or(value: &Value, fallback: i64) -> Value {
    if value.is_null() {
        json!(fallback)
    } else {
        value.clone()
    }
}

/// `resolveRouteOptions(route)` for the route's `options` (`None` without a
/// route).
pub(crate) fn resolve(options: Option<&Value>) -> RouteOptions {
    let o = options.unwrap_or(&Value::Null);
    RouteOptions {
        greeting: spoken(&o["greeting"]),
        language: o["language"]
            .as_str()
            .filter(|language| !language.is_empty())
            .unwrap_or(DEFAULT_LANGUAGE)
            .to_owned(),
        department_id: o["departmentId"].as_str().map(str::to_owned),
        ring_seconds: number_or(&o["ringSeconds"], DEFAULT_RING_SECONDS),
        max_wait_seconds: number_or(&o["maxWaitSeconds"], DEFAULT_MAX_WAIT_SECONDS),
        when_unanswered: o["whenUnanswered"]
            .as_str()
            .unwrap_or("voicemail")
            .to_owned(),
        voicemail_greeting: spoken(&o["voicemailGreeting"]),
        menu: (!o["menu"].is_null()).then(|| Menu::stored(&o["menu"])),
    }
}

/// `resolveRouteOptions(await loadRouteForNumber(db, toNumber))`: the options
/// of the route of the number a call was dialled on.
pub(crate) async fn for_number(db: &PgPool, to_number: &str) -> Result<RouteOptions, sqlx::Error> {
    let phone: Option<String> = sqlx::query_scalar(
        "select id from voip_phone_numbers where phone_number = $1 and deleted_at is null limit 1",
    )
    .bind(to_number)
    .fetch_optional(db)
    .await?;
    let Some(phone) = phone else {
        return Ok(resolve(None));
    };
    let options: Option<Option<Value>> = sqlx::query_scalar(
        "select options from desk_phone_routes where voip_phone_number_id = $1 limit 1",
    )
    .bind(phone)
    .fetch_optional(db)
    .await?;
    Ok(resolve(options.flatten().as_ref()))
}

fn is_dutch(language: &str) -> bool {
    language.to_lowercase().starts_with("nl")
}

/// `defaultVoicemailGreeting(language)`.
pub(crate) fn default_voicemail_greeting(language: &str) -> &'static str {
    if is_dutch(language) {
        "Laat na de piep een bericht achter."
    } else {
        "Please leave a message after the tone."
    }
}

/// `invalidChoicePrompt(language)`.
pub(crate) fn invalid_choice_prompt(language: &str) -> &'static str {
    if is_dutch(language) {
        "Dat is geen geldige keuze."
    } else {
        "That is not a valid choice."
    }
}

/// `phoneQueueName(workspaceId, departmentId)`: the Telnyx queue a call
/// waits in, one per workspace and team (`all` is the general queue).
pub(crate) fn queue_name(workspace: &str, department_id: Option<&str>) -> String {
    format!("desk-{workspace}-{}", department_id.unwrap_or("all"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_resolve_with_their_defaults() {
        let bare = resolve(None);
        assert_eq!(bare.greeting, None);
        assert_eq!(bare.language, "en-US");
        assert_eq!(bare.ring_seconds, json!(25));
        assert_eq!(bare.max_wait_seconds, json!(300));
        assert_eq!(bare.when_unanswered, "voicemail");
        assert!(bare.menu.is_none());

        let stored = json!({
            "greeting": "  Welcome. ",
            "language": "nl-NL",
            "departmentId": "dept_1",
            "ringSeconds": 20,
            "whenUnanswered": "hangup",
            "voicemailGreeting": "   ",
            "menu": {
                "prompt": "Pick.",
                "choices": [{ "digit": "1", "label": "Sales", "action": "agents" }],
                "fallbackDigit": "1",
            },
        });
        let resolved = resolve(Some(&stored));
        assert_eq!(resolved.greeting.as_deref(), Some("Welcome."));
        assert_eq!(resolved.department_id.as_deref(), Some("dept_1"));
        assert_eq!(resolved.ring_seconds, json!(20));
        assert_eq!(resolved.when_unanswered, "hangup");
        assert_eq!(resolved.voicemail_greeting, None);
        let menu = resolved.menu.expect("menu");
        assert_eq!(menu.choice("1").map(|c| c.action.as_str()), Some("agents"));
        assert!(menu.choice("2").is_none());
        assert_eq!(menu.fallback_digit.as_deref(), Some("1"));
    }

    #[test]
    fn texts_follow_the_language() {
        assert_eq!(
            default_voicemail_greeting("nl-NL"),
            "Laat na de piep een bericht achter."
        );
        assert_eq!(
            default_voicemail_greeting("en-GB"),
            "Please leave a message after the tone."
        );
        assert_eq!(invalid_choice_prompt("NL"), "Dat is geen geldige keuze.");
        assert_eq!(queue_name("org_1", None), "desk-org_1-all");
        assert_eq!(queue_name("org_1", Some("dept_1")), "desk-org_1-dept_1");
    }
}
