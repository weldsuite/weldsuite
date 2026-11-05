//! The synced fields of an issue and the loop guard over them
//! (`services/issue-sync/fields.ts`).
//!
//! Both sides are reduced to the same six canonical fields: title, body,
//! open/closed, the close reason, labels by name, and the assignee's
//! provider login. `merge_external_issues.checksum` is the sha-256 (hex) of
//! their canonical JSON, always taken from the provider's side of the last
//! exchange, so the webhook echo of our own push carries the same checksum
//! and is ignored.
//!
//! Canonical form, byte for byte as the worker writes it: title trimmed;
//! body CRLF → LF; labels lower-cased, de-duplicated, sorted (UTF-16 order);
//! assignee lower-cased or null; stateReason null while open;
//! `JSON.stringify({ title, body, state, stateReason, labels, assignee })`.

use sha2::{Digest, Sha256};

use crate::providers::NormalizedIssue;

/// `MergeSyncedIssueFields`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SyncedFields {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) state: &'static str,
    pub(crate) state_reason: Option<&'static str>,
    pub(crate) labels: Vec<String>,
    pub(crate) assignee: Option<String>,
}

/// `canonicalFields(input)`.
pub(crate) fn canonical_fields(
    title: &str,
    body: &str,
    state: &'static str,
    state_reason: Option<&'static str>,
    labels: &[String],
    assignee: Option<&str>,
) -> SyncedFields {
    let mut lowered: Vec<String> = Vec::new();
    for label in labels {
        let lower = label.to_lowercase();
        if !lowered.contains(&lower) {
            lowered.push(lower);
        }
    }
    // `[...].sort()`: UTF-16 code unit order.
    lowered.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    SyncedFields {
        title: weldsuite_kit::validation::js_trim(title).to_owned(),
        body: body.replace("\r\n", "\n"),
        state,
        state_reason: if state == "closed" {
            state_reason
        } else {
            None
        },
        labels: lowered,
        assignee: assignee
            .filter(|login| !login.is_empty())
            .map(str::to_lowercase),
    }
}

/// `providerFields(issue)`: what the provider says an issue is.
pub(crate) fn provider_fields(issue: &NormalizedIssue) -> SyncedFields {
    canonical_fields(
        &issue.title,
        &issue.body,
        issue.state,
        issue.state_reason,
        &issue.labels,
        issue.assignee_login.as_deref(),
    )
}

/// A JSON string as `JSON.stringify` writes it.
fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// `checksumOf(fields)`: sha-256 (hex) of the canonical JSON.
pub(crate) fn checksum_of(fields: &SyncedFields) -> String {
    let nullable = |value: Option<&str>| value.map_or_else(|| "null".to_owned(), json_string);
    let labels: Vec<String> = fields.labels.iter().map(|l| json_string(l)).collect();
    let json = format!(
        "{{\"title\":{},\"body\":{},\"state\":{},\"stateReason\":{},\"labels\":[{}],\"assignee\":{}}}",
        json_string(&fields.title),
        json_string(&fields.body),
        json_string(fields.state),
        nullable(fields.state_reason),
        labels.join(","),
        nullable(fields.assignee.as_deref()),
    );
    hex::encode(Sha256::digest(json.as_bytes()))
}

/// `statusToProviderState(status)`: `done` / `canceled` close the provider
/// issue with that reason; every other status keeps it open.
pub(crate) fn status_to_provider_state(status: &str) -> (&'static str, Option<&'static str>) {
    match status {
        "done" => ("closed", Some("completed")),
        "canceled" => ("closed", Some("not_planned")),
        _ => ("open", None),
    }
}

/// `providerStateToStatus(issue, current)`: closed → `done` (`canceled` for
/// `not_planned`); open keeps an open status the issue already has and
/// reopens a done or canceled one to `todo`.
pub(crate) fn provider_state_to_status(
    state: &str,
    state_reason: Option<&str>,
    current: Option<&str>,
) -> String {
    if state == "closed" {
        return if state_reason == Some("not_planned") {
            "canceled"
        } else {
            "done"
        }
        .to_owned();
    }
    match current {
        None | Some("done" | "canceled") => "todo".to_owned(),
        Some(status) => status.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksums_the_canonical_json() {
        let fields = canonical_fields(
            "  Fix login ",
            "a\r\nb",
            "open",
            Some("completed"),
            &["Bug".to_owned(), "bug".to_owned(), "Area".to_owned()],
            Some("Octo"),
        );
        assert_eq!(fields.labels, vec!["area", "bug"]);
        assert_eq!(fields.state_reason, None);
        // sha-256 of {"title":"Fix login","body":"a\nb","state":"open","stateReason":null,"labels":["area","bug"],"assignee":"octo"}
        let expected = hex::encode(Sha256::digest(
            br#"{"title":"Fix login","body":"a\nb","state":"open","stateReason":null,"labels":["area","bug"],"assignee":"octo"}"#,
        ));
        assert_eq!(checksum_of(&fields), expected);
    }

    #[test]
    fn maps_states_both_ways() {
        assert_eq!(
            status_to_provider_state("done"),
            ("closed", Some("completed"))
        );
        assert_eq!(status_to_provider_state("in_progress"), ("open", None));
        assert_eq!(
            provider_state_to_status("closed", Some("not_planned"), None),
            "canceled"
        );
        assert_eq!(provider_state_to_status("open", None, Some("done")), "todo");
        assert_eq!(
            provider_state_to_status("open", None, Some("in_progress")),
            "in_progress"
        );
    }
}
