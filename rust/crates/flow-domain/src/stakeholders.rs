//! Stakeholder register rules (`@weldsuite/flow-domain/stakeholders`): who a
//! stakeholder is, the RACI checks, the portal address and the shapes a
//! stakeholder takes on the wire and in entity events (ADR FLOW-020).
//!
//! Every message returned here goes to the client as it is.

use std::fmt::Write;

use serde_json::{Value, json};

pub const IDENTITY_REQUIRED: &str = "Provide either memberId or crmContactId";
pub const IDENTITY_ONE_ONLY: &str = "Provide either memberId or crmContactId, not both";
pub const MEMBER_NOT_FOUND: &str = "Member not found";
pub const CONTACT_NOT_FOUND: &str = "Contact not found";
pub const ALREADY_STAKEHOLDER: &str = "This person is already a stakeholder of the project";
pub const NOT_A_CONTACT: &str = "Only a CRM contact can be given portal access";
pub const CONTACT_WITHOUT_EMAIL: &str = "The contact has no email address";
pub const DELIVERABLE_NOT_FOUND: &str = "Deliverable not found";
pub const STAKEHOLDER_NOT_IN_PROJECT: &str = "Stakeholder not found in this project";
pub const SUBJECT_ID_REQUIRED: &str = "subjectId is required for a deliverable";
pub const SUBJECT_ID_NOT_ALLOWED: &str = "subjectId is only for a deliverable";
pub const ONE_ACCOUNTABLE: &str = "A subject can have only one accountable (A)";
pub const DUPLICATE_ASSIGNMENT: &str = "A stakeholder can have a letter only once per subject";

pub const RACI_SUBJECT_TYPES: [&str; 3] = ["deliverable", "change_requests", "go_live"];
pub const RACI_LETTERS: [&str; 4] = ["R", "A", "C", "I"];

/// The 400 message when a body names both or neither of the member and the contact.
pub fn identity_error(member_id: Option<&str>, contact_id: Option<&str>) -> Option<&'static str> {
    let member = member_id.is_some_and(|id| !id.is_empty());
    let contact = contact_id.is_some_and(|id| !id.is_empty());
    match (member, contact) {
        (true, true) => Some(IDENTITY_ONE_ONLY),
        (false, false) => Some(IDENTITY_REQUIRED),
        _ => None,
    }
}

/// The 400 message when `subjectId` does not fit `subjectType`.
pub fn raci_subject_error(subject_type: &str, subject_id: Option<&str>) -> Option<&'static str> {
    let has = subject_id.is_some_and(|id| !id.is_empty());
    if subject_type == "deliverable" {
        return (!has).then_some(SUBJECT_ID_REQUIRED);
    }
    has.then_some(SUBJECT_ID_NOT_ALLOWED)
}

/// One cell: a stakeholder and a letter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub stakeholder_id: String,
    pub letter: String,
}

impl Assignment {
    pub fn to_value(&self) -> Value {
        json!({ "stakeholderId": self.stakeholder_id, "letter": self.letter })
    }
}

/// The 400 message when a subject's assignments break a rule.
pub fn raci_assignments_error(assignments: &[Assignment]) -> Option<&'static str> {
    let mut seen: Vec<(&str, &str)> = Vec::new();
    for assignment in assignments {
        let key = (
            assignment.stakeholder_id.as_str(),
            assignment.letter.as_str(),
        );
        if seen.contains(&key) {
            return Some(DUPLICATE_ASSIGNMENT);
        }
        seen.push(key);
    }
    (assignments.iter().filter(|a| a.letter == "A").count() > 1).then_some(ONE_ACCOUNTABLE)
}

fn letter_rank(letter: &str) -> usize {
    ["A", "R", "C", "I"]
        .iter()
        .position(|l| *l == letter)
        .unwrap_or(usize::MAX)
}

/// By stakeholder (register order, unknown last), then A R C I.
pub fn sort_assignments(assignments: &[Assignment], order: &[String]) -> Vec<Assignment> {
    let position = |id: &str| order.iter().position(|o| o == id).unwrap_or(usize::MAX);
    let mut out = assignments.to_vec();
    out.sort_by(|a, b| {
        position(&a.stakeholder_id)
            .cmp(&position(&b.stakeholder_id))
            .then(letter_rank(&a.letter).cmp(&letter_rank(&b.letter)))
    });
    out
}

/// The stakeholders whose letters differ between two lists, in order of first appearance.
pub fn changed_stakeholders(before: &[Assignment], after: &[Assignment]) -> Vec<String> {
    let letters_of = |list: &[Assignment], id: &str| -> String {
        let mut letters: Vec<&str> = list
            .iter()
            .filter(|a| a.stakeholder_id == id)
            .map(|a| a.letter.as_str())
            .collect();
        letters.sort_unstable();
        letters.concat()
    };
    let mut ids: Vec<&str> = Vec::new();
    for assignment in before.iter().chain(after) {
        if !ids.contains(&assignment.stakeholder_id.as_str()) {
            ids.push(&assignment.stakeholder_id);
        }
    }
    ids.into_iter()
        .filter(|id| letters_of(before, id) != letters_of(after, id))
        .map(str::to_owned)
        .collect()
}

/// `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `<base>/<workspace slug>/projects/<project>`. The portal routes by `workspaces.slug`.
pub fn project_portal_url(base: &str, workspace_slug: &str, project_id: &str) -> String {
    format!(
        "{}/{}/projects/{}",
        base.trim_end_matches('/'),
        encode_component(workspace_slug),
        encode_component(project_id)
    )
}

fn get(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

fn kind_of(row: &Value) -> &'static str {
    if row.get("memberId").is_some_and(|v| !v.is_null()) {
        "member"
    } else {
        "contact"
    }
}

/// The stakeholder as every route answers it.
pub fn present_stakeholder(row: &Value, name: Option<&str>, email: Option<&str>) -> Value {
    json!({
        "id": get(row, "id"),
        "projectId": get(row, "projectId"),
        "kind": kind_of(row),
        "memberId": get(row, "memberId"),
        "crmContactId": get(row, "crmContactId"),
        "name": name,
        "email": email,
        "organisation": get(row, "organisation"),
        "role": get(row, "role"),
        "influence": get(row, "influence"),
        "interest": get(row, "interest"),
        "attitude": get(row, "attitude"),
        "engagement": get(row, "engagement"),
        "notes": get(row, "notes"),
        "lastContactAt": get(row, "lastContactAt"),
        "portalAccess": get(row, "portalAccess"),
        "portalInvitedAt": get(row, "portalInvitedAt"),
        "createdBy": get(row, "createdBy"),
        "createdAt": get(row, "createdAt"),
        "updatedAt": get(row, "updatedAt"),
    })
}

/// What an entity event of a stakeholder carries (no name or email).
pub fn event_data(row: &Value) -> Value {
    json!({
        "id": get(row, "id"),
        "projectId": get(row, "projectId"),
        "kind": kind_of(row),
        "memberId": get(row, "memberId"),
        "crmContactId": get(row, "crmContactId"),
        "organisation": get(row, "organisation"),
        "role": get(row, "role"),
        "influence": get(row, "influence"),
        "interest": get(row, "interest"),
        "attitude": get(row, "attitude"),
        "engagement": get(row, "engagement"),
        "portalAccess": get(row, "portalAccess"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(id: &str, letter: &str) -> Assignment {
        Assignment {
            stakeholder_id: id.to_owned(),
            letter: letter.to_owned(),
        }
    }

    #[test]
    fn identity() {
        assert_eq!(identity_error(Some("user_1"), None), None);
        assert_eq!(identity_error(None, Some("per_1")), None);
        assert_eq!(identity_error(None, None), Some(IDENTITY_REQUIRED));
        assert_eq!(identity_error(Some(""), Some("")), Some(IDENTITY_REQUIRED));
        assert_eq!(
            identity_error(Some("user_1"), Some("per_1")),
            Some(IDENTITY_ONE_ONLY)
        );
    }

    #[test]
    fn raci_rules() {
        assert_eq!(raci_subject_error("deliverable", Some("del_1")), None);
        assert_eq!(
            raci_subject_error("deliverable", None),
            Some(SUBJECT_ID_REQUIRED)
        );
        assert_eq!(raci_subject_error("go_live", None), None);
        assert_eq!(
            raci_subject_error("change_requests", Some("del_1")),
            Some(SUBJECT_ID_NOT_ALLOWED)
        );
        assert_eq!(raci_assignments_error(&[]), None);
        assert_eq!(
            raci_assignments_error(&[a("s1", "A"), a("s1", "R"), a("s2", "C")]),
            None
        );
        assert_eq!(
            raci_assignments_error(&[a("s1", "A"), a("s2", "A")]),
            Some(ONE_ACCOUNTABLE)
        );
        assert_eq!(
            raci_assignments_error(&[a("s1", "C"), a("s1", "C")]),
            Some(DUPLICATE_ASSIGNMENT)
        );
    }

    #[test]
    fn sorting_and_changes() {
        let order = ["s1".to_owned(), "s2".to_owned()];
        let sorted = sort_assignments(
            &[a("s2", "I"), a("s1", "R"), a("s1", "A"), a("gone", "C")],
            &order,
        );
        assert_eq!(
            sorted,
            [a("s1", "A"), a("s1", "R"), a("s2", "I"), a("gone", "C")]
        );
        let before = [a("s1", "A"), a("s2", "C")];
        let after = [a("s1", "A"), a("s2", "I"), a("s3", "R")];
        assert_eq!(changed_stakeholders(&before, &after), ["s2", "s3"]);
        assert_eq!(changed_stakeholders(&before, &[]), ["s1", "s2"]);
        assert_eq!(changed_stakeholders(&before, &before).len(), 0);
    }

    #[test]
    fn portal_address() {
        assert_eq!(
            project_portal_url("https://projects.weldsuite.org", "acme", "prj_1"),
            "https://projects.weldsuite.org/acme/projects/prj_1"
        );
        assert_eq!(
            project_portal_url("https://projects-test.weldsuite.org/", "acme", "prj 1"),
            "https://projects-test.weldsuite.org/acme/projects/prj%201"
        );
    }

    #[test]
    fn presenting() {
        let row = json!({
            "id": "stk_1", "projectId": "prj_1", "memberId": null, "crmContactId": "per_1",
            "organisation": "Van Dijk", "role": "IT", "influence": 4, "interest": 5,
            "attitude": "supportive", "engagement": "leading", "notes": null,
            "lastContactAt": "2026-11-03T10:00:00.000Z", "portalAccess": true,
            "portalInvitedAt": null, "createdBy": "u", "createdAt": "x", "updatedAt": "y"
        });
        let shown = present_stakeholder(&row, Some("Femke"), Some("f@example.com"));
        assert_eq!(shown["kind"], "contact");
        assert_eq!(shown["name"], "Femke");
        assert_eq!(shown["portalInvitedAt"], Value::Null);
        let data = event_data(&row);
        assert!(data.get("name").is_none() && data.get("email").is_none());
        assert_eq!(data["influence"], 4);
        let member = json!({ "memberId": "user_9", "crmContactId": null });
        assert_eq!(present_stakeholder(&member, None, None)["kind"], "member");
    }
}
