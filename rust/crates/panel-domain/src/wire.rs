//! The collector's name patterns the compiler checks names against
//! (`wire.ts`: `CUSTOM_EVENT_NAME`, `PROPERTY_KEY`), and the spec's
//! reference patterns (`weldpanel-query.ts`).

use std::sync::LazyLock;

use regex::Regex;

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("a valid pattern")
}

/// What a person types for `track('Signed up')`.
pub static CUSTOM_EVENT_NAME: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^[A-Za-z0-9](?:[A-Za-z0-9 _.:/-]{0,98}[A-Za-z0-9_.:/-])?$"));

/// A custom property key (JavaScript's `\w` is ASCII).
pub static PROPERTY_KEY: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"));

/// `$pageview`, `$webvitals`, `$app_opened`: the SDKs' own events.
pub static SYSTEM_EVENT_NAME: LazyLock<Regex> = LazyLock::new(|| pattern(r"^\$[a-z][a-z_]{1,31}$"));

/// A custom event in a spec: `@pnce_…`.
pub static CUSTOM_EVENT_REF: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^@pnce_[A-Za-z0-9]{1,26}$"));

/// A computed property in a spec: `@pncp_…`.
pub static COMPUTED_PROPERTY_REF: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^@pncp_[A-Za-z0-9]{1,26}$"));

/// A group type (`company`).
pub static GROUP_TYPE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[a-z][a-z0-9_]{0,31}$"));

/// `isCustomEventRef`.
pub fn is_custom_event_ref(value: &str) -> bool {
    CUSTOM_EVENT_REF.is_match(value)
}

/// `isComputedPropertyRef`.
pub fn is_computed_property_ref(value: &str) -> bool {
    COMPUTED_PROPERTY_REF.is_match(value)
}

/// `groupKeyProperty`: the event property that holds an event's group key.
pub fn group_key_property(group_type: &str) -> String {
    format!("$group_{group_type}")
}
