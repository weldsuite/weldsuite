//! RAID log rules (`@weldsuite/flow-domain/raid`): kinds, statuses,
//! numbering, conversion, link and field rules, and the shapes a register
//! item takes on the wire and in entity events (design:
//! weldflow-project-control.md; ADRs FLOW-010 and FLOW-011).
//!
//! Every message returned here goes to the client as it is, so both backends
//! answer alike. The wire shapes read rows as `weldsuite_db::js_row` gives
//! them: camelCase keys, timestamps as ISO strings, `numeric` as text.

use std::borrow::Cow;

use serde_json::{Value, json};

use crate::numbering::NumberSequence;
use crate::risk::{RiskBand, risk_band, risk_score};

// ── Vocabulary (`@weldsuite/app-api-client/schemas/project-control`) ────────

/// `RAID_KINDS`.
pub const RAID_KINDS: [&str; 4] = ["risk", "assumption", "issue", "dependency"];
pub const RISK_STRATEGIES: [&str; 4] = ["avoid", "mitigate", "transfer", "accept"];
pub const ASSUMPTION_CONFIDENCES: [&str; 3] = ["low", "medium", "high"];
pub const ISSUE_SEVERITIES: [&str; 4] = ["low", "medium", "high", "critical"];
pub const DEPENDENCY_DIRECTIONS: [&str; 2] = ["inbound", "outbound"];
pub const DEPENDENCY_PARTY_TYPES: [&str; 4] = ["project", "supplier", "team", "customer"];
/// `CONTROL_LINK_TYPES`.
pub const CONTROL_LINK_TYPES: [&str; 3] = ["raid_item", "task", "milestone"];
/// `CONTROL_LINK_RELATIONS`.
pub const CONTROL_LINK_RELATIONS: [&str; 5] = [
    "mitigates",
    "resolves",
    "raised_from",
    "affects",
    "threatens",
];
/// `RAID_TASK_PRIORITIES`: the priorities a mitigation task can be created with.
pub const RAID_TASK_PRIORITIES: [&str; 5] = ["critical", "high", "medium", "low", "none"];
/// `PROGRESS_RELATIONS`: the relations that make a task part of an item's progress.
pub const PROGRESS_RELATIONS: [&str; 2] = ["mitigates", "resolves"];

/// A register kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RaidKind {
    Risk,
    Assumption,
    Issue,
    Dependency,
}

impl RaidKind {
    pub const ALL: [Self; 4] = [Self::Risk, Self::Assumption, Self::Issue, Self::Dependency];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Risk => "risk",
            Self::Assumption => "assumption",
            Self::Issue => "issue",
            Self::Dependency => "dependency",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// `RAID_STATUSES[kind]`: in lifecycle order, the first where a new item starts.
    pub const fn statuses(self) -> &'static [&'static str] {
        match self {
            Self::Risk => &[
                "identified",
                "assessing",
                "mitigating",
                "monitoring",
                "occurred",
                "closed",
            ],
            Self::Assumption => &["open", "validated", "invalid"],
            Self::Issue => &["open", "in_progress", "resolved", "closed"],
            Self::Dependency => &["open", "at_risk", "delivered", "closed"],
        }
    }

    /// `RAID_CLOSED_STATUSES[kind]`: the statuses that end an item's life
    /// in the register.
    pub const fn closed_statuses(self) -> &'static [&'static str] {
        match self {
            Self::Risk => &["occurred", "closed"],
            Self::Assumption => &["validated", "invalid"],
            Self::Issue => &["resolved", "closed"],
            Self::Dependency => &["delivered", "closed"],
        }
    }

    /// The scope key and display prefix of the kind's numbers (`SEQUENCES`).
    const fn sequence(self) -> (&'static str, &'static str) {
        match self {
            Self::Risk => ("rsk", "RSK-"),
            Self::Assumption => ("asm", "A-"),
            Self::Issue => ("iss", "ISS-"),
            Self::Dependency => ("dep", "DEP-"),
        }
    }
}

// ── Numbering ───────────────────────────────────────────────────────────────

/// `raidSequence(kind, projectId)`: the counter of one kind in one project,
/// scope `rsk:<projectId>`, prefix `RSK-`.
pub fn raid_sequence(kind: RaidKind, project_id: &str) -> NumberSequence {
    let (key, prefix) = kind.sequence();
    NumberSequence {
        scope: Cow::Owned(format!("{key}:{project_id}")),
        prefix,
    }
}

/// `raidCode(kind, number)`: `RSK-4`, `A-1`, `ISS-2`, `DEP-3`.
pub fn raid_code(kind: RaidKind, number: i64) -> String {
    format!("{}{number}", kind.sequence().1)
}

// ── Statuses ────────────────────────────────────────────────────────────────

/// `initialRaidStatus(kind)`.
pub fn initial_raid_status(kind: RaidKind) -> &'static str {
    kind.statuses()[0]
}

/// `isClosedStatus(kind, status)`.
pub fn is_closed_status(kind: RaidKind, status: &str) -> bool {
    kind.closed_statuses().contains(&status)
}

/// `closedAtFor(kind, status, currentClosedAt, now)`: the time the item first
/// entered a closed status (kept while it stays closed, across another closed
/// status), `None` once it is open again.
pub fn closed_at_for<T>(kind: RaidKind, status: &str, current: Option<T>, now: T) -> Option<T> {
    if !is_closed_status(kind, status) {
        return None;
    }
    Some(current.unwrap_or(now))
}

// ── Field rules ─────────────────────────────────────────────────────────────

/// The values `raidFieldsError` looks at.
#[derive(Debug, Clone, Copy, Default)]
pub struct RaidFields<'a> {
    pub residual_probability: Option<i64>,
    pub residual_impact: Option<i64>,
    pub party_type: Option<&'a str>,
    pub party_project_id: Option<&'a str>,
}

/// `raidFieldsError(kind, projectId, fields)`: the cross-field rules on the
/// values the item would end up with; the 400 message, or `None`.
pub fn raid_fields_error(
    kind: RaidKind,
    project_id: &str,
    fields: &RaidFields<'_>,
) -> Option<&'static str> {
    match kind {
        RaidKind::Risk => {
            crate::risk::residual_pair_error(fields.residual_probability, fields.residual_impact)
        }
        RaidKind::Dependency => {
            let party = fields.party_project_id.filter(|p| !p.is_empty())?;
            if fields.party_type != Some("project") {
                return Some("partyProjectId requires partyType 'project'");
            }
            (party == project_id).then_some("A dependency cannot be on its own project")
        }
        RaidKind::Assumption | RaidKind::Issue => None,
    }
}

// ── Conversion ──────────────────────────────────────────────────────────────

/// `conversionError(from, to)`: an assumption that proves wrong becomes a
/// risk, a risk that happens an issue; the 400 message otherwise.
pub fn conversion_error(from: RaidKind, to: RaidKind) -> Option<&'static str> {
    let target = match from {
        RaidKind::Assumption => RaidKind::Risk,
        RaidKind::Risk => RaidKind::Issue,
        RaidKind::Issue | RaidKind::Dependency => {
            return Some("Only assumptions and risks can be converted");
        }
    };
    if target == to {
        return None;
    }
    Some(if from == RaidKind::Assumption {
        "An assumption can only be converted to a risk"
    } else {
        "A risk can only be converted to an issue"
    })
}

/// `conversionInputError(to, input)`: a risk needs (and only a risk takes)
/// probability and impact, only an issue takes a severity.
pub fn conversion_input_error(
    to: RaidKind,
    probability: Option<i64>,
    impact: Option<i64>,
    severity: Option<&str>,
) -> Option<&'static str> {
    if to == RaidKind::Issue {
        let has_ratings = probability.is_some() || impact.is_some();
        return has_ratings
            .then_some("probability and impact only apply when converting to a risk");
    }
    if probability.is_none() || impact.is_none() {
        return Some("probability and impact are required to convert to a risk");
    }
    severity
        .is_some()
        .then_some("severity only applies when converting to an issue")
}

/// `sourceStatusAfterConversion(from)`: an assumption is closed `invalid`,
/// a risk `occurred`; `None` where TypeScript throws.
pub fn source_status_after_conversion(from: RaidKind) -> Option<&'static str> {
    match from {
        RaidKind::Assumption => Some("invalid"),
        RaidKind::Risk => Some("occurred"),
        RaidKind::Issue | RaidKind::Dependency => None,
    }
}

/// `severityForBand(band)`: an issue raised from a risk takes its band's
/// name (the two scales share them).
pub fn severity_for_band(band: RiskBand) -> &'static str {
    band.as_str()
}

// ── Links ───────────────────────────────────────────────────────────────────

/// One end of a link before it is looked up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkRef<'a> {
    pub link_type: &'a str,
    pub id: &'a str,
}

/// One end of a link once it is known (`LinkEnd`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkEnd<'a> {
    pub link_type: &'a str,
    pub id: &'a str,
    pub project_id: &'a str,
    /// The register kind, for a `raid_item`.
    pub kind: Option<RaidKind>,
}

/// `linkShapeError({ from, to, relation })`: two different objects, and the
/// relation going the right way between the right types.
///
/// ```text
/// mitigates, resolves   task → raid_item
/// raised_from           raid_item → raid_item
/// affects, threatens    raid_item → task or milestone
/// ```
pub fn link_shape_error(from: LinkRef<'_>, to: LinkRef<'_>, relation: &str) -> Option<String> {
    if from.link_type == to.link_type && from.id == to.id {
        return Some("A link needs two different objects".to_owned());
    }
    match relation {
        "mitigates" | "resolves" => (!(from.link_type == "task" && to.link_type == "raid_item"))
            .then(|| format!("The '{relation}' relation goes from a task to a register item")),
        "raised_from" => (!(from.link_type == "raid_item" && to.link_type == "raid_item")).then(
            || {
                "The 'raised_from' relation goes from a register item to the register item it was raised from"
                    .to_owned()
            },
        ),
        "affects" | "threatens" => (!(from.link_type == "raid_item"
            && matches!(to.link_type, "task" | "milestone")))
        .then(|| {
            format!("The '{relation}' relation goes from a register item to a task or milestone")
        }),
        _ => None,
    }
}

/// `linkEndsError({ from, to, relation })`: a task mitigates only a risk and
/// resolves only an issue, and the ends share a project, except that a
/// dependency may affect or threaten a milestone of another project.
pub fn link_ends_error(
    from: &LinkEnd<'_>,
    to: &LinkEnd<'_>,
    relation: &str,
) -> Option<&'static str> {
    if relation == "mitigates" && to.kind != Some(RaidKind::Risk) {
        return Some("A task can only mitigate a risk");
    }
    if relation == "resolves" && to.kind != Some(RaidKind::Issue) {
        return Some("A task can only resolve an issue");
    }
    if from.project_id != to.project_id {
        let cross_project = from.link_type == "raid_item"
            && from.kind == Some(RaidKind::Dependency)
            && to.link_type == "milestone";
        if !cross_project {
            return Some("Both ends of a link must be in the same project");
        }
    }
    None
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

fn int(row: &Value, key: &str) -> Option<i64> {
    row.get(key).and_then(Value::as_i64)
}

/// The kind of a row, if it is one of the four.
pub fn row_kind(row: &Value) -> Option<RaidKind> {
    row.get("kind")
        .and_then(Value::as_str)
        .and_then(RaidKind::parse)
}

/// The display code of a row (`raidCode(row.kind, row.number)`).
pub fn row_code(row: &Value) -> Value {
    match (row_kind(row), int(row, "number")) {
        (Some(kind), Some(number)) => Value::String(raid_code(kind, number)),
        _ => Value::Null,
    }
}

/// The score of a risk row, `None` for the other kinds (`scoreOf`).
pub fn row_score(row: &Value) -> Option<i64> {
    if row_kind(row) != Some(RaidKind::Risk) {
        return None;
    }
    risk_score(int(row, "probability")?, int(row, "impact")?)
}

fn band_value(score: Option<i64>) -> Value {
    score
        .and_then(risk_band)
        .map_or(Value::Null, |band| Value::String(band.as_str().to_owned()))
}

/// `presentRaidItem(row, taskProgress)`: the row with its timestamps as ISO
/// strings, plus `code`, `band` and `residualScore` (risks only) and the
/// task progress.
pub fn present_raid_item(row: &Value, done: i64, total: i64) -> Value {
    let score = row_score(row);
    let residual_score = match (int(row, "residualProbability"), int(row, "residualImpact")) {
        (Some(p), Some(i)) => risk_score(p, i),
        _ => None,
    };
    let mut out = serde_json::Map::new();
    for key in [
        "id",
        "projectId",
        "kind",
        "number",
        "title",
        "description",
        "status",
        "category",
        "ownerId",
        "dueAt",
        "closedAt",
        "customFields",
        "probability",
        "impact",
        "residualProbability",
        "residualImpact",
        "strategy",
        "trigger",
        "costImpact",
        "scheduleImpactDays",
        "reviewIntervalDays",
        "confidence",
        "ifWrong",
        "severity",
        "escalatedAt",
        "direction",
        "partyType",
        "partyProjectId",
        "partyName",
        "createdBy",
        "createdAt",
        "updatedAt",
        "deletedAt",
    ] {
        out.insert(key.to_owned(), field(row, key));
    }
    out.insert("code".to_owned(), row_code(row));
    out.insert("score".to_owned(), score.map_or(Value::Null, Value::from));
    out.insert("band".to_owned(), band_value(score));
    out.insert(
        "residualScore".to_owned(),
        residual_score.map_or(Value::Null, Value::from),
    );
    out.insert(
        "taskProgress".to_owned(),
        json!({ "done": done, "total": total }),
    );
    Value::Object(out)
}

/// `presentRaidAssessment(row)`.
pub fn present_raid_assessment(row: &Value) -> Value {
    let score = match (int(row, "probability"), int(row, "impact")) {
        (Some(p), Some(i)) => risk_score(p, i),
        _ => None,
    };
    json!({
        "id": field(row, "id"),
        "itemId": field(row, "itemId"),
        "projectId": field(row, "projectId"),
        "probability": field(row, "probability"),
        "impact": field(row, "impact"),
        "score": score,
        "band": band_value(score),
        "residualProbability": field(row, "residualProbability"),
        "residualImpact": field(row, "residualImpact"),
        "note": field(row, "note"),
        "assessedBy": field(row, "assessedBy"),
        "assessedAt": field(row, "assessedAt"),
    })
}

/// `presentControlLink(row)`.
pub fn present_control_link(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "fromType": field(row, "fromType"),
        "fromId": field(row, "fromId"),
        "toType": field(row, "toType"),
        "toId": field(row, "toId"),
        "relation": field(row, "relation"),
        "createdBy": field(row, "createdBy"),
        "createdAt": field(row, "createdAt"),
    })
}

// ── Entity event payloads ───────────────────────────────────────────────────

/// `raidEventData(row)`: ids and statuses, no free text beyond the title;
/// `score` and `band` are null for anything but a risk.
pub fn raid_event_data(row: &Value) -> Value {
    let score = row_score(row);
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "kind": field(row, "kind"),
        "number": field(row, "number"),
        "code": row_code(row),
        "title": field(row, "title"),
        "status": field(row, "status"),
        "ownerId": field(row, "ownerId"),
        "score": score,
        "band": band_value(score),
    })
}

/// `controlLinkEventData(row)`.
pub fn control_link_event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "fromType": field(row, "fromType"),
        "fromId": field(row, "fromId"),
        "toType": field(row, "toType"),
        "toId": field(row, "toId"),
        "relation": field(row, "relation"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_counts_per_project_with_its_prefix() {
        let scope = |kind| {
            let sequence = raid_sequence(kind, "prj_1");
            (sequence.scope.into_owned(), sequence.prefix)
        };
        assert_eq!(scope(RaidKind::Risk), ("rsk:prj_1".to_owned(), "RSK-"));
        assert_eq!(scope(RaidKind::Assumption), ("asm:prj_1".to_owned(), "A-"));
        assert_eq!(scope(RaidKind::Issue), ("iss:prj_1".to_owned(), "ISS-"));
        assert_eq!(
            scope(RaidKind::Dependency),
            ("dep:prj_1".to_owned(), "DEP-")
        );
        assert_eq!(raid_code(RaidKind::Risk, 4), "RSK-4");
        assert_eq!(raid_code(RaidKind::Assumption, 1), "A-1");
        assert_eq!(raid_code(RaidKind::Issue, 2), "ISS-2");
        assert_eq!(raid_code(RaidKind::Dependency, 3), "DEP-3");
        let longest = raid_sequence(RaidKind::Risk, &"p".repeat(255));
        assert!(longest.scope.len() <= 300);
    }

    #[test]
    fn statuses_start_first_and_know_which_are_closed() {
        assert_eq!(initial_raid_status(RaidKind::Risk), "identified");
        assert_eq!(initial_raid_status(RaidKind::Assumption), "open");
        assert_eq!(initial_raid_status(RaidKind::Issue), "open");
        assert_eq!(initial_raid_status(RaidKind::Dependency), "open");
        assert!(!is_closed_status(RaidKind::Risk, "mitigating"));
        assert!(is_closed_status(RaidKind::Risk, "occurred"));
        assert!(is_closed_status(RaidKind::Risk, "closed"));
        assert!(!is_closed_status(RaidKind::Assumption, "open"));
        assert!(is_closed_status(RaidKind::Assumption, "invalid"));
        assert!(!is_closed_status(RaidKind::Issue, "in_progress"));
        assert!(is_closed_status(RaidKind::Issue, "resolved"));
        assert!(!is_closed_status(RaidKind::Dependency, "at_risk"));
        assert!(is_closed_status(RaidKind::Dependency, "delivered"));
        for kind in RaidKind::ALL {
            for status in kind.closed_statuses() {
                assert!(kind.statuses().contains(status), "{status}");
            }
        }
        assert_eq!(RaidKind::ALL.map(RaidKind::as_str), RAID_KINDS);
    }

    #[test]
    fn closed_at_is_stamped_kept_and_cleared() {
        let now = "2026-11-03T10:00:00.000Z";
        let earlier = "2026-10-01T10:00:00.000Z";
        assert_eq!(
            closed_at_for(RaidKind::Issue, "resolved", None, now),
            Some(now)
        );
        assert_eq!(
            closed_at_for(RaidKind::Issue, "closed", Some(earlier), now),
            Some(earlier)
        );
        assert_eq!(
            closed_at_for(RaidKind::Issue, "open", Some(earlier), now),
            None
        );
    }

    #[test]
    fn issues_take_the_severity_of_the_band() {
        for band in RiskBand::ALL {
            assert_eq!(severity_for_band(band), band.as_str());
            assert!(ISSUE_SEVERITIES.contains(&band.as_str()));
        }
    }

    #[test]
    fn only_assumptions_and_risks_convert_one_way() {
        use RaidKind::{Assumption, Dependency, Issue, Risk};
        assert_eq!(conversion_error(Assumption, Risk), None);
        assert_eq!(conversion_error(Risk, Issue), None);
        assert_eq!(
            conversion_error(Assumption, Issue),
            Some("An assumption can only be converted to a risk")
        );
        assert_eq!(
            conversion_error(Risk, Risk),
            Some("A risk can only be converted to an issue")
        );
        assert_eq!(
            conversion_error(Issue, Risk),
            Some("Only assumptions and risks can be converted")
        );
        assert_eq!(
            conversion_error(Dependency, Issue),
            Some("Only assumptions and risks can be converted")
        );
        assert_eq!(source_status_after_conversion(Assumption), Some("invalid"));
        assert_eq!(source_status_after_conversion(Risk), Some("occurred"));
        assert_eq!(source_status_after_conversion(Issue), None);
        assert_eq!(conversion_input_error(Risk, Some(2), Some(2), None), None);
        assert_eq!(
            conversion_input_error(Risk, None, None, None),
            Some("probability and impact are required to convert to a risk")
        );
        assert_eq!(
            conversion_input_error(Risk, Some(2), Some(2), Some("low")),
            Some("severity only applies when converting to an issue")
        );
        assert_eq!(
            conversion_input_error(Issue, None, None, Some("high")),
            None
        );
        assert_eq!(
            conversion_input_error(Issue, Some(2), None, None),
            Some("probability and impact only apply when converting to a risk")
        );
    }

    #[test]
    fn field_rules_hold_for_risks_and_dependencies() {
        let risk = |p, i| RaidFields {
            residual_probability: p,
            residual_impact: i,
            ..RaidFields::default()
        };
        assert_eq!(
            raid_fields_error(RaidKind::Risk, "prj_1", &risk(Some(2), Some(2))),
            None
        );
        assert_eq!(
            raid_fields_error(RaidKind::Risk, "prj_1", &risk(Some(2), None)),
            Some("residualProbability and residualImpact must be set together")
        );
        let dependency = |party_type, party| RaidFields {
            party_type,
            party_project_id: party,
            ..RaidFields::default()
        };
        assert_eq!(
            raid_fields_error(
                RaidKind::Dependency,
                "prj_1",
                &dependency(Some("project"), Some("prj_2"))
            ),
            None
        );
        assert_eq!(
            raid_fields_error(
                RaidKind::Dependency,
                "prj_1",
                &dependency(Some("supplier"), Some("prj_2"))
            ),
            Some("partyProjectId requires partyType 'project'")
        );
        assert_eq!(
            raid_fields_error(
                RaidKind::Dependency,
                "prj_1",
                &dependency(Some("project"), Some("prj_1"))
            ),
            Some("A dependency cannot be on its own project")
        );
        assert_eq!(
            raid_fields_error(
                RaidKind::Dependency,
                "prj_1",
                &dependency(Some("project"), None)
            ),
            None
        );
    }

    #[test]
    fn link_shapes_follow_the_relation() {
        let task = LinkRef {
            link_type: "task",
            id: "t1",
        };
        let item = LinkRef {
            link_type: "raid_item",
            id: "r1",
        };
        let other = LinkRef {
            link_type: "raid_item",
            id: "r2",
        };
        let milestone = LinkRef {
            link_type: "milestone",
            id: "m1",
        };
        let shape = |from, to, relation| link_shape_error(from, to, relation);
        assert_eq!(
            shape(item, item, "raised_from").as_deref(),
            Some("A link needs two different objects")
        );
        assert_eq!(shape(task, item, "mitigates"), None);
        assert_eq!(shape(task, item, "resolves"), None);
        assert_eq!(
            shape(item, task, "mitigates").as_deref(),
            Some("The 'mitigates' relation goes from a task to a register item")
        );
        assert_eq!(
            shape(task, milestone, "resolves").as_deref(),
            Some("The 'resolves' relation goes from a task to a register item")
        );
        assert_eq!(shape(item, other, "raised_from"), None);
        assert_eq!(
            shape(task, item, "raised_from").as_deref(),
            Some(
                "The 'raised_from' relation goes from a register item to the register item it was raised from"
            )
        );
        assert_eq!(shape(item, milestone, "threatens"), None);
        assert_eq!(shape(item, task, "affects"), None);
        assert_eq!(
            shape(item, other, "affects").as_deref(),
            Some("The 'affects' relation goes from a register item to a task or milestone")
        );
    }

    #[test]
    fn link_ends_follow_the_kinds_and_projects() {
        let end = |link_type, project_id, kind| LinkEnd {
            link_type,
            id: "x",
            project_id,
            kind,
        };
        let task = end("task", "p1", None);
        let risk = end("raid_item", "p1", Some(RaidKind::Risk));
        let issue = end("raid_item", "p1", Some(RaidKind::Issue));
        assert_eq!(link_ends_error(&task, &risk, "mitigates"), None);
        assert_eq!(
            link_ends_error(&task, &issue, "mitigates"),
            Some("A task can only mitigate a risk")
        );
        assert_eq!(link_ends_error(&task, &issue, "resolves"), None);
        assert_eq!(
            link_ends_error(&task, &risk, "resolves"),
            Some("A task can only resolve an issue")
        );
        let dependency = end("raid_item", "p1", Some(RaidKind::Dependency));
        let there = end("milestone", "p2", None);
        assert_eq!(
            link_ends_error(&risk, &there, "threatens"),
            Some("Both ends of a link must be in the same project")
        );
        assert_eq!(link_ends_error(&dependency, &there, "threatens"), None);
        assert_eq!(
            link_ends_error(&dependency, &end("task", "p2", None), "affects"),
            Some("Both ends of a link must be in the same project")
        );
    }

    #[test]
    fn items_present_with_code_band_and_progress() {
        let row = json!({
            "id": "raid_1", "projectId": "prj_1", "kind": "risk", "number": 4,
            "title": "Late", "status": "identified", "probability": 4, "impact": 5,
            "residualProbability": 1, "residualImpact": 2, "ownerId": null,
            "costImpact": "1500.50", "score": 20,
        });
        let item = present_raid_item(&row, 1, 3);
        assert_eq!(item["code"], "RSK-4");
        assert_eq!(item["score"], 20);
        assert_eq!(item["band"], "critical");
        assert_eq!(item["residualScore"], 2);
        assert_eq!(item["costImpact"], "1500.50");
        assert_eq!(item["taskProgress"], json!({ "done": 1, "total": 3 }));
        assert_eq!(item["deletedAt"], Value::Null);
        let event = raid_event_data(&row);
        assert_eq!(
            event,
            json!({
                "id": "raid_1", "projectId": "prj_1", "kind": "risk", "number": 4,
                "code": "RSK-4", "title": "Late", "status": "identified", "ownerId": null,
                "score": 20, "band": "critical",
            })
        );
        let issue = json!({ "id": "raid_2", "kind": "issue", "number": 1, "probability": null });
        assert_eq!(raid_event_data(&issue)["score"], Value::Null);
        assert_eq!(present_raid_item(&issue, 0, 0)["band"], Value::Null);
    }
}
