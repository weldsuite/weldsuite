//! The guard's contract with every send path, the admin console and the
//! platform (`@weldsuite/app-api-client/schemas/outbound-mail`): trust
//! levels, states, modes, sources, the default limits, the thresholds and
//! the denial codes. Keep in step with that file.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Trust levels, states, modes, sources, kinds
// ---------------------------------------------------------------------------

/// `OutboundTrustLevel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    New,
    Standard,
    Trusted,
}

impl TrustLevel {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "new" => Some(Self::New),
            "standard" => Some(Self::Standard),
            "trusted" => Some(Self::Trusted),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Standard => "standard",
            Self::Trusted => "trusted",
        }
    }
}

/// `OutboundState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundState {
    Active,
    Restricted,
    Hold,
    Suspended,
}

impl OutboundState {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "restricted" => Some(Self::Restricted),
            "hold" => Some(Self::Hold),
            "suspended" => Some(Self::Suspended),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Restricted => "restricted",
            Self::Hold => "hold",
            Self::Suspended => "suspended",
        }
    }

    /// `STATE_ORDER`: how tight the state is.
    pub fn order(self) -> u8 {
        match self {
            Self::Active => 0,
            Self::Restricted => 1,
            Self::Hold => 2,
            Self::Suspended => 3,
        }
    }
}

/// `OutboundGuardMode`: `shadow` decides and logs but never blocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardMode {
    Off,
    Shadow,
    Enforce,
}

impl GuardMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "shadow" => Some(Self::Shadow),
            "enforce" => Some(Self::Enforce),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Shadow => "shadow",
            Self::Enforce => "enforce",
        }
    }
}

/// `OUTBOUND_SOURCES`: where a send came from.
pub const OUTBOUND_SOURCES: [&str; 13] = [
    "compose",
    "reply",
    "forward",
    "scheduled",
    "api",
    "crm_sequence",
    "workflow",
    "desk",
    "calendar",
    "meet",
    "sign",
    "personal",
    "subscription",
];

/// `OutboundKind`: `reply` = answering someone who wrote to the mailbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundKind {
    Reply,
    NewThread,
    Forward,
}

impl OutboundKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::NewThread => "new_thread",
            Self::Forward => "forward",
        }
    }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// `OutboundLimits`: recipients, not messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundLimits {
    pub recipients_per_message: i64,
    pub sender_per_hour: i64,
    pub sender_per_day: i64,
    pub workspace_per_day: i64,
    pub first_contact_per_day: i64,
    pub replies_per_sender_per_day: i64,
    /// `null` = no monthly cap.
    pub monthly_recipients: Option<i64>,
}

/// `OUTBOUND_DEFAULT_LIMITS.new`.
pub const NEW_LIMITS: OutboundLimits = OutboundLimits {
    recipients_per_message: 20,
    sender_per_hour: 30,
    sender_per_day: 150,
    workspace_per_day: 300,
    first_contact_per_day: 50,
    replies_per_sender_per_day: 150,
    monthly_recipients: None,
};

/// `OUTBOUND_DEFAULT_LIMITS.standard`.
pub const STANDARD_LIMITS: OutboundLimits = OutboundLimits {
    recipients_per_message: 50,
    sender_per_hour: 100,
    sender_per_day: 500,
    workspace_per_day: 2_000,
    first_contact_per_day: 200,
    replies_per_sender_per_day: 500,
    monthly_recipients: None,
};

/// `OUTBOUND_DEFAULT_LIMITS.trusted`.
pub const TRUSTED_LIMITS: OutboundLimits = OutboundLimits {
    recipients_per_message: 50,
    sender_per_hour: 400,
    sender_per_day: 2_000,
    workspace_per_day: 10_000,
    first_contact_per_day: 1_000,
    replies_per_sender_per_day: 2_000,
    monthly_recipients: None,
};

/// `OUTBOUND_DEFAULT_LIMITS.restricted`: the `restricted` state's own set.
pub const RESTRICTED_LIMITS: OutboundLimits = OutboundLimits {
    recipients_per_message: 10,
    sender_per_hour: 10,
    sender_per_day: 50,
    workspace_per_day: 200,
    first_contact_per_day: 0,
    replies_per_sender_per_day: 200,
    monthly_recipients: None,
};

/// `OUTBOUND_DEFAULT_LIMITS[trustLevel]`.
pub fn default_limits(trust: TrustLevel) -> OutboundLimits {
    match trust {
        TrustLevel::New => NEW_LIMITS,
        TrustLevel::Standard => STANDARD_LIMITS,
        TrustLevel::Trusted => TRUSTED_LIMITS,
    }
}

/// `OUTBOUND_PERSONAL_LIMITS`: personal WeldMail, by plan (`pro` or not).
pub fn personal_limits(pro: bool) -> OutboundLimits {
    if pro {
        OutboundLimits {
            workspace_per_day: 500,
            ..STANDARD_LIMITS
        }
    } else {
        OutboundLimits {
            sender_per_day: 50,
            workspace_per_day: 50,
            replies_per_sender_per_day: 50,
            ..NEW_LIMITS
        }
    }
}

/// `WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY`.
pub const WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY: i64 = 20;

/// `MAILBOX_DAILY_SEND_LIMIT_MAX`.
pub const MAILBOX_DAILY_SEND_LIMIT_MAX: i64 = 2_000;

/// `outboundLimitOverridesSchema.safeParse(overrides)`: the staff overrides
/// stored on a policy row, or `None` when any present field is invalid
/// (Zod refuses the whole object, and the caller then ignores it).
#[allow(clippy::cast_precision_loss)] // the bounds are far below 2^52
fn parse_overrides(overrides: Option<&Value>) -> Option<Vec<(&'static str, Option<i64>)>> {
    let Some(value) = overrides else {
        return Some(Vec::new());
    };
    // `safeParse(overrides ?? {})`: null becomes `{}`.
    if value.is_null() {
        return Some(Vec::new());
    }
    let object = value.as_object()?;
    let fields: [(&'static str, i64, i64, bool); 7] = [
        ("recipientsPerMessage", 1, 50, false),
        ("senderPerHour", 0, 100_000, false),
        ("senderPerDay", 0, 1_000_000, false),
        ("workspacePerDay", 0, 10_000_000, false),
        ("firstContactPerDay", 0, 1_000_000, false),
        ("repliesPerSenderPerDay", 0, 1_000_000, false),
        ("monthlyRecipients", 0, 100_000_000, true),
    ];
    let mut parsed = Vec::new();
    for (name, min, max, nullable) in fields {
        match object.get(name) {
            None => {}
            Some(Value::Null) if nullable => parsed.push((name, None)),
            Some(value) => {
                let number = value.as_f64()?;
                if number.fract() != 0.0 || number < min as f64 || number > max as f64 {
                    return None;
                }
                #[allow(clippy::cast_possible_truncation)]
                parsed.push((name, Some(number as i64)));
            }
        }
    }
    Some(parsed)
}

/// `{ ...base, ...parsed }`.
pub fn apply_overrides(base: OutboundLimits, overrides: Option<&Value>) -> OutboundLimits {
    let mut limits = base;
    for (name, value) in parse_overrides(overrides).unwrap_or_default() {
        match (name, value) {
            ("recipientsPerMessage", Some(v)) => limits.recipients_per_message = v,
            ("senderPerHour", Some(v)) => limits.sender_per_hour = v,
            ("senderPerDay", Some(v)) => limits.sender_per_day = v,
            ("workspacePerDay", Some(v)) => limits.workspace_per_day = v,
            ("firstContactPerDay", Some(v)) => limits.first_contact_per_day = v,
            ("repliesPerSenderPerDay", Some(v)) => limits.replies_per_sender_per_day = v,
            ("monthlyRecipients", v) => limits.monthly_recipients = v,
            _ => {}
        }
    }
    limits
}

/// `resolveOutboundLimits(trustLevel, state, overrides)`.
pub fn resolve_outbound_limits(
    trust: TrustLevel,
    state: OutboundState,
    overrides: Option<&Value>,
) -> OutboundLimits {
    if state == OutboundState::Restricted {
        return RESTRICTED_LIMITS;
    }
    apply_overrides(default_limits(trust), overrides)
}

/// `SHARED_WELDMAIL_APEXES`.
pub const SHARED_WELDMAIL_APEXES: [&str; 2] = ["weldmail.com", "weldmail.org"];

/// `isSharedWeldMailDomain(domain)`: a shared apex or a workspace subdomain
/// of one.
pub fn is_shared_weldmail_domain(domain: &str) -> bool {
    let domain = domain.to_lowercase();
    SHARED_WELDMAIL_APEXES
        .iter()
        .any(|apex| domain == *apex || domain.ends_with(&format!(".{apex}")))
}

// ---------------------------------------------------------------------------
// Trust computation
// ---------------------------------------------------------------------------

/// `OUTBOUND_TRUST_RULES`.
pub const NEW_WORKSPACE_DAYS: f64 = 14.0;
pub const TRUSTED_AFTER_DAYS: f64 = 60.0;
pub const TRUSTED_MAX_HARD_BOUNCE_RATE: f64 = 0.02;
pub const TRUSTED_MAX_COMPLAINT_RATE: f64 = 0.001;

/// `TrustInput`.
#[derive(Debug, Clone)]
pub struct TrustInput {
    /// `workspaces.created_at`, ms since the epoch.
    pub created_at_ms: i64,
    pub subscription_status: Option<String>,
    pub plan_price_monthly: Option<f64>,
    pub comp_granted: bool,
    pub trust_override: Option<TrustLevel>,
    pub hard_bounce_rate_7d: Option<f64>,
    pub complaint_rate_7d: Option<f64>,
    pub now_ms: i64,
}

/// `computeTrustLevel(input)`.
pub fn compute_trust_level(input: &TrustInput) -> TrustLevel {
    if let Some(level) = input.trust_override {
        return level;
    }
    #[allow(clippy::cast_precision_loss)]
    let age_days = (input.now_ms - input.created_at_ms) as f64 / 86_400_000.0;
    let paying = matches!(
        input.subscription_status.as_deref(),
        Some("active" | "past_due")
    ) && input.plan_price_monthly.unwrap_or(0.0) > 0.0;
    let paid = input.comp_granted || paying;
    if !paid || age_days < NEW_WORKSPACE_DAYS {
        return TrustLevel::New;
    }
    let clean = matches!(
        (input.hard_bounce_rate_7d, input.complaint_rate_7d),
        (Some(bounces), Some(complaints))
            if bounces <= TRUSTED_MAX_HARD_BOUNCE_RATE && complaints <= TRUSTED_MAX_COMPLAINT_RATE
    );
    if age_days >= TRUSTED_AFTER_DAYS && clean {
        TrustLevel::Trusted
    } else {
        TrustLevel::Standard
    }
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/// `OUTBOUND_THRESHOLDS`.
pub mod thresholds {
    pub const COLD_TEMPLATE_FIRST_CONTACT_PER_DAY: i64 = 25;
    pub const REVIEW_FIRST_CONTACT_RECIPIENTS: i64 = 10;
    pub const NEW_WORKSPACE_REVIEW_SAMPLES_PER_DAY: i64 = 20;
    pub const COLD_OUTREACH_CONFIDENCE: f64 = 0.7;
    pub const PHISHING_CONFIDENCE: f64 = 0.8;
    pub const HARD_BOUNCE_RATE: f64 = 0.05;
    pub const HARD_BOUNCE_MIN_RECIPIENTS: i64 = 20;
    pub const COMPLAINTS_7D: i64 = 2;
    pub const COMPLAINT_RATE: f64 = 0.003;
    pub const RISK_RESTRICTED: i64 = 70;
    pub const RISK_HOLD: i64 = 90;
    pub const RISK_REVIEW_MIN: i64 = 40;
    pub const PLATFORM_BUDGET_RATIO: f64 = 0.7;
}

/// `FINGERPRINT_MAX_DISTANCE`.
pub const FINGERPRINT_MAX_DISTANCE: u32 = 3;

// ---------------------------------------------------------------------------
// Denials
// ---------------------------------------------------------------------------

/// `OUTBOUND_DENIAL_CODES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DenialCode {
    SendingLimited,
    FirstContactLimited,
    SendingOnHold,
    SendingSuspended,
    SenderNotOwned,
    TooManyRecipients,
    RecipientSuppressed,
    PlatformLimited,
}

impl DenialCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SendingLimited => "SENDING_LIMITED",
            Self::FirstContactLimited => "FIRST_CONTACT_LIMITED",
            Self::SendingOnHold => "SENDING_ON_HOLD",
            Self::SendingSuspended => "SENDING_SUSPENDED",
            Self::SenderNotOwned => "SENDER_NOT_OWNED",
            Self::TooManyRecipients => "TOO_MANY_RECIPIENTS",
            Self::RecipientSuppressed => "RECIPIENT_SUPPRESSED",
            Self::PlatformLimited => "PLATFORM_LIMITED",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "SENDING_LIMITED" => Self::SendingLimited,
            "FIRST_CONTACT_LIMITED" => Self::FirstContactLimited,
            "SENDING_ON_HOLD" => Self::SendingOnHold,
            "SENDING_SUSPENDED" => Self::SendingSuspended,
            "SENDER_NOT_OWNED" => Self::SenderNotOwned,
            "TOO_MANY_RECIPIENTS" => Self::TooManyRecipients,
            "RECIPIENT_SUPPRESSED" => Self::RecipientSuppressed,
            "PLATFORM_LIMITED" => Self::PlatformLimited,
            _ => return None,
        })
    }

    /// `outboundDenialStatus(code)`.
    pub fn status(self) -> u16 {
        match self {
            Self::SenderNotOwned | Self::SendingSuspended | Self::SendingOnHold => 403,
            Self::TooManyRecipients | Self::RecipientSuppressed => 422,
            _ => 429,
        }
    }
}

/// `OutboundDenialDetails`. Fields in the order TypeScript writes them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DenialDetails {
    pub code: DenialCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggest_weld_reach: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipients: Option<Vec<String>>,
}

impl DenialDetails {
    pub fn new(code: DenialCode) -> Self {
        Self {
            code,
            window: None,
            limit: None,
            used: None,
            retry_after: None,
            reason: None,
            suggest_weld_reach: None,
            recipients: None,
        }
    }

    #[must_use]
    pub fn window(mut self, window: &str) -> Self {
        self.window = Some(window.to_owned());
        self
    }

    #[must_use]
    pub fn limit(mut self, limit: i64) -> Self {
        self.limit = Some(limit);
        self
    }

    #[must_use]
    pub fn used(mut self, used: i64) -> Self {
        self.used = Some(used);
        self
    }

    #[must_use]
    pub fn retry_after(mut self, at: String) -> Self {
        self.retry_after = Some(at);
        self
    }

    #[must_use]
    pub fn reason(mut self, reason: &str) -> Self {
        self.reason = Some(reason.to_owned());
        self
    }

    #[must_use]
    pub fn suggest_weld_reach(mut self) -> Self {
        self.suggest_weld_reach = Some(true);
        self
    }

    /// The details as TypeScript writes the object: keys in insertion
    /// order of the denial's literal (code, window, limit, used, retryAfter,
    /// reason, suggestWeldReach, recipients).
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// `denialMessage(details)`: English fallback text; clients translate by code.
pub fn denial_message(details: &DenialDetails) -> String {
    let limit = details
        .limit
        .map_or_else(|| "?".to_owned(), |limit| limit.to_string());
    match details.code {
        DenialCode::SendingLimited => format!(
            "Sending limit reached ({limit} recipients per {}).",
            details.window.as_deref().unwrap_or("day")
        ),
        DenialCode::FirstContactLimited => {
            if details.reason.as_deref() == Some("cold_outreach_template") {
                "This message looks like cold outreach and reached its daily limit of new recipients. Use WeldReach for outreach campaigns.".to_owned()
            } else {
                format!(
                    "Limit reached for new recipients who never wrote to you ({limit} per day)."
                )
            }
        }
        DenialCode::SendingOnHold => "New conversations are paused while WeldSuite reviews this workspace. Replies still go out.".to_owned(),
        DenialCode::SendingSuspended => {
            "Sending is suspended for this workspace. Contact WeldSuite support.".to_owned()
        }
        DenialCode::SenderNotOwned => "This workspace cannot send from that address.".to_owned(),
        DenialCode::TooManyRecipients => {
            format!("Too many recipients in one message (at most {limit}).")
        }
        DenialCode::RecipientSuppressed => {
            "A recipient reported earlier mail from this workspace as spam and cannot be emailed."
                .to_owned()
        }
        DenialCode::PlatformLimited => {
            "Mail to new recipients is paused for today. Try again tomorrow.".to_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn overrides_apply_only_when_valid() {
        let limits = resolve_outbound_limits(
            TrustLevel::Standard,
            OutboundState::Active,
            Some(&json!({ "senderPerHour": 7, "monthlyRecipients": null })),
        );
        assert_eq!(limits.sender_per_hour, 7);
        assert_eq!(limits.monthly_recipients, None);
        // One invalid field: Zod refuses the object, nothing applies.
        let ignored = resolve_outbound_limits(
            TrustLevel::Standard,
            OutboundState::Active,
            Some(&json!({ "senderPerHour": 7, "recipientsPerMessage": 0 })),
        );
        assert_eq!(ignored, STANDARD_LIMITS);
        assert_eq!(
            resolve_outbound_limits(TrustLevel::Trusted, OutboundState::Restricted, None),
            RESTRICTED_LIMITS
        );
    }

    #[test]
    fn personal_limits_follow_the_plans() {
        assert_eq!(personal_limits(false).sender_per_day, 50);
        assert_eq!(personal_limits(false).recipients_per_message, 20);
        assert_eq!(personal_limits(true).workspace_per_day, 500);
        assert_eq!(personal_limits(true).sender_per_hour, 100);
    }

    #[test]
    fn trust_levels() {
        let day = 86_400_000;
        let base = TrustInput {
            created_at_ms: 0,
            subscription_status: Some("active".to_owned()),
            plan_price_monthly: Some(29.0),
            comp_granted: false,
            trust_override: None,
            hard_bounce_rate_7d: None,
            complaint_rate_7d: None,
            now_ms: 20 * day,
        };
        assert_eq!(compute_trust_level(&base), TrustLevel::Standard);
        assert_eq!(
            compute_trust_level(&TrustInput {
                now_ms: 10 * day,
                ..base.clone()
            }),
            TrustLevel::New
        );
        assert_eq!(
            compute_trust_level(&TrustInput {
                plan_price_monthly: Some(0.0),
                ..base.clone()
            }),
            TrustLevel::New
        );
        assert_eq!(
            compute_trust_level(&TrustInput {
                now_ms: 61 * day,
                hard_bounce_rate_7d: Some(0.0),
                complaint_rate_7d: Some(0.0),
                ..base.clone()
            }),
            TrustLevel::Trusted
        );
        assert_eq!(
            compute_trust_level(&TrustInput {
                trust_override: Some(TrustLevel::Trusted),
                ..base
            }),
            TrustLevel::Trusted
        );
    }

    #[test]
    fn denial_messages_and_statuses() {
        let limited = DenialDetails::new(DenialCode::SendingLimited)
            .window("hour")
            .limit(100);
        assert_eq!(
            denial_message(&limited),
            "Sending limit reached (100 recipients per hour)."
        );
        assert_eq!(DenialCode::SenderNotOwned.status(), 403);
        assert_eq!(DenialCode::RecipientSuppressed.status(), 422);
        assert_eq!(DenialCode::PlatformLimited.status(), 429);
        assert_eq!(
            serde_json::to_string(&limited).expect("json"),
            r#"{"code":"SENDING_LIMITED","window":"hour","limit":100}"#
        );
        assert!(is_shared_weldmail_domain("acme.weldmail.com"));
        assert!(is_shared_weldmail_domain("WeldMail.org"));
        assert!(!is_shared_weldmail_domain("notweldmail.com"));
    }
}
