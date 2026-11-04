//! Phases and stage gates (`@weldsuite/flow-domain/gates`): the criteria
//! catalogue, the gate check and the rules of the phase lifecycle (design:
//! weldflow-delivery-and-portfolio.md; ADR FLOW-017).
//!
//! A line-by-line port: the same fixtures
//! (`packages/domains/flow/src/testing/gate-fixtures.json`) run in both
//! languages, and every message and fact shape is `gates.ts`'s. A criterion
//! is a catalogue key with parameters, or a manual criterion (free text the
//! project manager ticks); criteria are handled as the JSON they are stored
//! as, so what is stored is what was written.

use std::collections::HashSet;

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{js_number, js_trim};

use crate::risk::RiskBand;

/// The automatic criteria. Adding one is a code change, here and in
/// TypeScript.
pub const GATE_CRITERION_KEYS: [&str; 6] = [
    "deliverable_tasks_done",
    "deliverable_accepted",
    "no_open_risk_above",
    "decision_decided",
    "no_change_request_pending",
    "spend_within_baseline",
];

pub const GATE_RISK_BANDS: [&str; 4] = ["low", "medium", "high", "critical"];

/// Time entries that count as spend to date.
pub const SPEND_TIME_ENTRY_STATUSES: [&str; 2] = ["approved", "billed"];

/// `GATE_MESSAGES`: every refusal, sent to the client as it is.
pub mod messages {
    pub const UNKNOWN_CRITERION: &str = "Unknown gate criterion";
    pub const DELIVERABLE_REQUIRED: &str = "This criterion needs a deliverableId";
    pub const DECISION_REQUIRED: &str = "This criterion needs a decisionId";
    pub const BAND_REQUIRED: &str = "This criterion needs a band: low, medium, high or critical";
    pub const MANUAL_TEXT_REQUIRED: &str = "A manual criterion needs a text";
    pub const INVALID_CRITERION: &str =
        "A criterion is a catalogue key with parameters, or a manual text";
    pub const DELIVERABLE_NOT_FOUND: &str =
        "A criterion points at a deliverable that does not exist in this project";
    pub const DECISION_NOT_FOUND: &str =
        "A criterion points at a decision that does not exist in this project";
    pub const PHASE_NOT_ACTIVE: &str = "Only the active phase can request its gate";
    pub const ALREADY_REQUESTED: &str = "Approval of this gate has already been requested";
    pub const PHASE_PASSED: &str = "This phase has passed its gate and can no longer be changed";
    pub const NOT_ALL_SATISFIED: &str = "Not every criterion is met or waived";
    pub const NO_APPROVER: &str =
        "The project has no sponsor or project manager to approve the gate";
    pub const NOT_SPONSOR: &str = "Only the project sponsor can waive a criterion";
    pub const NOT_MANAGER: &str = "You do not have manage access to this project";
    pub const CRITERION_NOT_FOUND: &str = "This phase has no such criterion";
    pub const ALREADY_MET: &str = "This criterion is already met";
    pub const ALREADY_WAIVED: &str = "This criterion has already been waived";
    pub const NOT_MANUAL: &str = "Only manual criteria can be ticked";
    pub const WAIVE_AFTER_REQUEST: &str = "The gate is already waiting for approval";
    pub const REORDER_INCOMPLETE: &str = "List every phase of the project exactly once";
    pub const REORDER_PASSED: &str = "Passed phases keep their place at the start";
    pub const NOTE_REQUIRED: &str = "A note is required to waive a criterion";
}

// ── Criteria ────────────────────────────────────────────────────────────────

/// A stored criterion, read.
enum Parsed<'a> {
    Manual {
        text: &'a str,
        met: bool,
        met_at: Option<&'a str>,
    },
    Key {
        key: &'a str,
        params: Option<&'a Map<String, Value>>,
    },
}

fn parse(criterion: &Value) -> Parsed<'_> {
    if let Some(text) = criterion.get("manual").and_then(Value::as_str) {
        return Parsed::Manual {
            text,
            met: criterion.get("met") == Some(&Value::Bool(true)),
            met_at: criterion.get("metAt").and_then(Value::as_str),
        };
    }
    Parsed::Key {
        key: criterion.get("key").and_then(Value::as_str).unwrap_or(""),
        params: criterion.get("params").and_then(Value::as_object),
    }
}

/// `isManualCriterion(criterion)`.
pub fn is_manual_criterion(criterion: &Value) -> bool {
    matches!(parse(criterion), Parsed::Manual { .. })
}

/// `paramText(params, key)`: a string that is not blank.
fn param_text<'a>(params: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    params
        .and_then(|params| params.get(key))
        .and_then(Value::as_str)
        .filter(|text| !js_trim(text).is_empty())
}

/// `criterionError(criterion)`: the refusal for a criterion of a request, or
/// `None` when it is a known key with its parameters (or a manual text).
pub fn criterion_error(criterion: &Value) -> Option<&'static str> {
    let Some(value) = criterion.as_object() else {
        return Some(messages::INVALID_CRITERION);
    };
    if value.contains_key("manual") {
        return match value.get("manual").and_then(Value::as_str) {
            Some(text) if !js_trim(text).is_empty() => None,
            _ => Some(messages::MANUAL_TEXT_REQUIRED),
        };
    }
    let Some(key) = value
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| GATE_CRITERION_KEYS.contains(key))
    else {
        return Some(messages::UNKNOWN_CRITERION);
    };
    let params = value.get("params").and_then(Value::as_object);
    match key {
        "deliverable_tasks_done" | "deliverable_accepted" => param_text(params, "deliverableId")
            .is_none()
            .then_some(messages::DELIVERABLE_REQUIRED),
        "decision_decided" => param_text(params, "decisionId")
            .is_none()
            .then_some(messages::DECISION_REQUIRED),
        "no_open_risk_above" => (!GATE_RISK_BANDS
            .contains(&param_text(params, "band").unwrap_or("")))
        .then_some(messages::BAND_REQUIRED),
        _ => None,
    }
}

/// `criteriaError(criteria)`: the first refusal among a phase's criteria.
pub fn criteria_error(criteria: &[Value]) -> Option<&'static str> {
    criteria.iter().find_map(criterion_error)
}

/// `normalizeCriterion(criterion)`: a criterion as it is stored (a manual one
/// starts unmet).
pub fn normalize_criterion(criterion: &Value) -> Value {
    match parse(criterion) {
        Parsed::Manual { text, met, met_at } => json!({
            "manual": js_trim(text),
            "met": met,
            "metAt": if met { met_at.map(Value::from).unwrap_or(Value::Null) } else { Value::Null },
        }),
        Parsed::Key { key, params } => match params.filter(|params| !params.is_empty()) {
            Some(params) => json!({ "key": key, "params": params }),
            None => json!({ "key": key }),
        },
    }
}

/// `GateFactsNeeded`: what a set of criteria needs read from the project.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GateFactsNeeded {
    pub deliverable_ids: Vec<String>,
    pub decision_ids: Vec<String>,
    pub risks: bool,
    pub change_requests: bool,
    pub spend: bool,
}

pub fn gate_facts_needed(criteria: &[Value]) -> GateFactsNeeded {
    let mut needed = GateFactsNeeded::default();
    for criterion in criteria {
        let Parsed::Key { key, params } = parse(criterion) else {
            continue;
        };
        match key {
            "deliverable_tasks_done" | "deliverable_accepted" => {
                if let Some(id) = param_text(params, "deliverableId")
                    && !needed.deliverable_ids.iter().any(|known| known == id)
                {
                    needed.deliverable_ids.push(id.to_owned());
                }
            }
            "decision_decided" => {
                if let Some(id) = param_text(params, "decisionId")
                    && !needed.decision_ids.iter().any(|known| known == id)
                {
                    needed.decision_ids.push(id.to_owned());
                }
            }
            "no_open_risk_above" => needed.risks = true,
            "no_change_request_pending" => needed.change_requests = true,
            "spend_within_baseline" => needed.spend = true,
            _ => {}
        }
    }
    needed
}

// ── Facts and the check ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateDeliverableFact {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub status: String,
    pub tasks_done: i64,
    pub tasks_total: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateRiskFact {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub score: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateDecisionFact {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub status: String,
    pub decision_due_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateChangeFact {
    pub id: String,
    pub number: i64,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateSpendFact {
    /// A decimal string with two decimals.
    pub spent: String,
    pub budget: Option<String>,
    pub currency: Option<String>,
    pub baseline_version: Option<i64>,
}

/// What the criteria are evaluated over.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GateFacts {
    pub deliverables: Vec<GateDeliverableFact>,
    pub risks: Vec<GateRiskFact>,
    pub decisions: Vec<GateDecisionFact>,
    pub change_requests: Vec<GateChangeFact>,
    pub spend: Option<GateSpendFact>,
}

/// Where the data behind a criterion lives; the UI maps it to a page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateLink {
    pub kind: &'static str,
    pub id: Option<String>,
}

impl GateLink {
    fn to_json(&self) -> Value {
        json!({ "kind": self.kind, "id": self.id })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateWaiver {
    pub index: usize,
    pub note: String,
    pub by: String,
    pub at: String,
}

impl GateWaiver {
    pub fn to_json(&self) -> Value {
        json!({ "index": self.index, "note": self.note, "by": self.by, "at": self.at })
    }

    /// The waivers stored on a phase (`gateResult.waived`).
    pub fn from_result(gate_result: &Value) -> Vec<Self> {
        gate_result["waived"]
            .as_array()
            .map(|waived| {
                waived
                    .iter()
                    .filter_map(|w| {
                        Some(Self {
                            index: usize::try_from(w["index"].as_i64()?).ok()?,
                            note: w["note"].as_str()?.to_owned(),
                            by: w["by"].as_str()?.to_owned(),
                            at: w["at"].as_str()?.to_owned(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GateCheckItem {
    pub index: usize,
    pub manual: bool,
    pub key: Option<String>,
    pub text: Option<String>,
    pub params: Option<Map<String, Value>>,
    pub met: bool,
    pub waived: bool,
    pub waiver: Option<GateWaiver>,
    pub satisfied: bool,
    pub facts: Value,
    pub link: Option<GateLink>,
}

impl GateCheckItem {
    pub fn to_json(&self) -> Value {
        json!({
            "index": self.index,
            "kind": if self.manual { "manual" } else { "automatic" },
            "key": self.key,
            "text": self.text,
            "params": self.params.as_ref().map(|params| Value::Object(params.clone())),
            "met": self.met,
            "waived": self.waived,
            "waiver": self.waiver.as_ref().map(GateWaiver::to_json),
            "satisfied": self.satisfied,
            "facts": self.facts,
            "link": self.link.as_ref().map(GateLink::to_json),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GateCheck {
    pub items: Vec<GateCheckItem>,
    pub total: usize,
    pub met_count: usize,
    pub waived_count: usize,
    pub satisfied_count: usize,
    pub all_satisfied: bool,
}

impl GateCheck {
    pub fn to_json(&self) -> Value {
        json!({
            "items": self.items.iter().map(GateCheckItem::to_json).collect::<Vec<_>>(),
            "total": self.total,
            "metCount": self.met_count,
            "waivedCount": self.waived_count,
            "satisfiedCount": self.satisfied_count,
            "allSatisfied": self.all_satisfied,
        })
    }
}

fn deliverable_code(number: i64) -> String {
    format!("D{number}")
}

/// An amount as the numeric columns hold it; an unreadable one counts as 0.
fn amount(value: &str) -> f64 {
    let parsed = js_number(value);
    if parsed.is_finite() { parsed } else { 0.0 }
}

struct Evaluation {
    met: bool,
    facts: Value,
    link: Option<GateLink>,
}

fn link(kind: &'static str, id: Option<String>) -> Option<GateLink> {
    Some(GateLink { kind, id })
}

fn evaluate(criterion: &Value, facts: &GateFacts) -> Evaluation {
    let (key, params) = match parse(criterion) {
        Parsed::Manual { met, met_at, .. } => {
            return Evaluation {
                met,
                facts: json!({ "metAt": met_at }),
                link: None,
            };
        }
        Parsed::Key { key, params } => (key, params),
    };
    match key {
        "deliverable_tasks_done" => {
            let id = param_text(params, "deliverableId").unwrap_or("");
            let Some(found) = facts.deliverables.iter().find(|d| d.id == id) else {
                return Evaluation {
                    met: false,
                    facts: json!({ "deliverableId": id, "missing": true }),
                    link: link("tasks", Some(id.to_owned())),
                };
            };
            Evaluation {
                met: found.tasks_total > 0 && found.tasks_done == found.tasks_total,
                facts: json!({
                    "deliverableId": id,
                    "code": deliverable_code(found.number),
                    "title": found.title,
                    "done": found.tasks_done,
                    "total": found.tasks_total,
                }),
                link: link("tasks", Some(id.to_owned())),
            }
        }
        "deliverable_accepted" => {
            let id = param_text(params, "deliverableId").unwrap_or("");
            let Some(found) = facts.deliverables.iter().find(|d| d.id == id) else {
                return Evaluation {
                    met: false,
                    facts: json!({ "deliverableId": id, "missing": true }),
                    link: link("deliverable", Some(id.to_owned())),
                };
            };
            Evaluation {
                met: found.status == "accepted",
                facts: json!({
                    "deliverableId": id,
                    "code": deliverable_code(found.number),
                    "title": found.title,
                    "status": found.status,
                }),
                link: link("deliverable", Some(id.to_owned())),
            }
        }
        "no_open_risk_above" => {
            let band = param_text(params, "band").unwrap_or("critical");
            let floor = RiskBand::parse(band)
                .unwrap_or(RiskBand::Critical)
                .range()
                .0;
            let mut over: Vec<&GateRiskFact> = facts
                .risks
                .iter()
                .filter(|risk| risk.score >= floor)
                .collect();
            over.sort_by(|a, b| {
                b.score
                    .cmp(&a.score)
                    .then_with(|| a.number.cmp(&b.number))
                    .then_with(|| a.id.cmp(&b.id))
            });
            let top = over.first();
            Evaluation {
                met: over.is_empty(),
                facts: json!({
                    "band": band,
                    "count": over.len(),
                    "top": top.map(|risk| json!({
                        "id": risk.id,
                        "code": format!("RSK-{}", risk.number),
                        "title": risk.title,
                        "score": risk.score,
                    })),
                }),
                link: link("raid", top.map(|risk| risk.id.clone())),
            }
        }
        "decision_decided" => {
            let id = param_text(params, "decisionId").unwrap_or("");
            let Some(found) = facts.decisions.iter().find(|d| d.id == id) else {
                return Evaluation {
                    met: false,
                    facts: json!({ "decisionId": id, "missing": true }),
                    link: link("decision", Some(id.to_owned())),
                };
            };
            Evaluation {
                met: found.status == "decided" || found.status == "superseded",
                facts: json!({
                    "decisionId": id,
                    "code": format!("DEC-{}", found.number),
                    "title": found.title,
                    "status": found.status,
                    "decisionDueAt": found.decision_due_at,
                }),
                link: link("decision", Some(id.to_owned())),
            }
        }
        "no_change_request_pending" => {
            let first = facts.change_requests.first();
            Evaluation {
                met: facts.change_requests.is_empty(),
                facts: json!({
                    "count": facts.change_requests.len(),
                    "first": first.map(|change| json!({
                        "id": change.id,
                        "code": format!("CR-{}", change.number),
                        "title": change.title,
                    })),
                }),
                link: link("change_requests", first.map(|change| change.id.clone())),
            }
        }
        "spend_within_baseline" => match &facts.spend {
            Some(spend) if spend.budget.is_some() => {
                let budget = spend.budget.as_deref().unwrap_or("0.00");
                Evaluation {
                    met: amount(&spend.spent) <= amount(budget),
                    facts: json!({
                        "spent": spend.spent,
                        "budget": budget,
                        "currency": spend.currency,
                        "baselineVersion": spend.baseline_version,
                    }),
                    link: link("finance", None),
                }
            }
            other => Evaluation {
                met: false,
                facts: json!({
                    "spent": other.as_ref().map_or("0.00", |spend| spend.spent.as_str()),
                    "budget": Value::Null,
                    "currency": other.as_ref().and_then(|spend| spend.currency.clone()),
                    "baselineVersion": other.as_ref().and_then(|spend| spend.baseline_version),
                }),
                link: link("finance", None),
            },
        },
        other => Evaluation {
            met: false,
            facts: json!({ "unknownKey": other }),
            link: None,
        },
    }
}

/// `checkGate(criteria, facts, waivers)`: a waiver (by criterion position)
/// counts for a criterion that is not met; a met one is simply met.
pub fn check_gate(criteria: &[Value], facts: &GateFacts, waivers: &[GateWaiver]) -> GateCheck {
    let items: Vec<GateCheckItem> = criteria
        .iter()
        .enumerate()
        .map(|(index, criterion)| {
            let result = evaluate(criterion, facts);
            let waiver = waivers.iter().find(|w| w.index == index).cloned();
            let waived = !result.met && waiver.is_some();
            let (manual, key, text, params) = match parse(criterion) {
                Parsed::Manual { text, .. } => (true, None, Some(text.to_owned()), None),
                Parsed::Key { key, params } => (false, Some(key.to_owned()), None, params.cloned()),
            };
            GateCheckItem {
                index,
                manual,
                key,
                text,
                params,
                met: result.met,
                waived,
                waiver: if waived { waiver } else { None },
                satisfied: result.met || waived,
                facts: result.facts,
                link: result.link,
            }
        })
        .collect();
    let met_count = items.iter().filter(|item| item.met).count();
    let waived_count = items.iter().filter(|item| item.waived).count();
    GateCheck {
        total: items.len(),
        met_count,
        waived_count,
        satisfied_count: met_count + waived_count,
        all_satisfied: items.iter().all(|item| item.satisfied),
        items,
    }
}

/// `gateResultOf(check, criteria, waivers, checkedAt)`: the result stored on
/// the phase when a gate is requested and when it is decided.
pub fn gate_result_of(
    check: &GateCheck,
    criteria: &[Value],
    waivers: &[GateWaiver],
    checked_at: &str,
) -> Value {
    json!({
        "checkedAt": checked_at,
        "criteria": check.items.iter().map(|item| json!({
            "criterion": criteria.get(item.index).cloned().unwrap_or(Value::Null),
            "met": item.met,
            "detail": item.facts,
        })).collect::<Vec<_>>(),
        "waived": waivers
            .iter()
            .filter(|w| w.index < check.items.len())
            .map(GateWaiver::to_json)
            .collect::<Vec<_>>(),
    })
}

// ── Phase lifecycle ─────────────────────────────────────────────────────────

/// `PhaseLike`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhaseLike {
    pub id: String,
    pub position: i64,
    pub status: String,
}

fn by_position(a: &&PhaseLike, b: &&PhaseLike) -> std::cmp::Ordering {
    a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id))
}

/// `phaseToActivate(phases)`: when no phase is active, the first upcoming one
/// (by position, then id).
pub fn phase_to_activate(phases: &[PhaseLike]) -> Option<String> {
    if phases.iter().any(|phase| phase.status == "active") {
        return None;
    }
    let mut upcoming: Vec<&PhaseLike> = phases.iter().filter(|p| p.status == "upcoming").collect();
    upcoming.sort_by(by_position);
    upcoming.first().map(|phase| phase.id.clone())
}

/// `nextUpcomingPhase(phases, phaseId)`: the phase after `phase_id` that is
/// still to come.
pub fn next_upcoming_phase(phases: &[PhaseLike], phase_id: &str) -> Option<String> {
    let mut ordered: Vec<&PhaseLike> = phases.iter().collect();
    ordered.sort_by(by_position);
    let at = ordered.iter().position(|phase| phase.id == phase_id)?;
    ordered[at + 1..]
        .iter()
        .find(|phase| phase.status == "upcoming")
        .map(|phase| phase.id.clone())
}

/// `reorderError(phases, ids)`: every live phase exactly once, and the passed
/// phases first, in the order they had.
pub fn reorder_error(phases: &[PhaseLike], ids: &[String]) -> Option<&'static str> {
    let live: HashSet<&str> = phases.iter().map(|phase| phase.id.as_str()).collect();
    let distinct: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if ids.len() != live.len()
        || distinct.len() != ids.len()
        || ids.iter().any(|id| !live.contains(id.as_str()))
    {
        return Some(messages::REORDER_INCOMPLETE);
    }
    let mut passed: Vec<&PhaseLike> = phases.iter().filter(|p| p.status == "passed").collect();
    passed.sort_by(by_position);
    let passed: Vec<&str> = passed.iter().map(|phase| phase.id.as_str()).collect();
    let status_of = |id: &str| {
        phases
            .iter()
            .find(|phase| phase.id == id)
            .map(|p| p.status.as_str())
    };
    let split = passed.len().min(ids.len());
    let rest_passed = ids[split..]
        .iter()
        .any(|id| status_of(id) == Some("passed"));
    let leading_moved = ids[..split]
        .iter()
        .enumerate()
        .any(|(index, id)| passed.get(index) != Some(&id.as_str()));
    if rest_passed || leading_moved {
        return Some(messages::REORDER_PASSED);
    }
    None
}

/// `GateRequestBlock`: why a gate cannot be requested (in the order the
/// checks run).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateRequestBlock {
    PhasePassed,
    PhaseNotActive,
    AlreadyRequested,
    CriteriaOpen,
    NoApprover,
}

impl GateRequestBlock {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PhasePassed => "phase_passed",
            Self::PhaseNotActive => "phase_not_active",
            Self::AlreadyRequested => "already_requested",
            Self::CriteriaOpen => "criteria_open",
            Self::NoApprover => "no_approver",
        }
    }

    /// `GATE_REQUEST_BLOCK_MESSAGES`.
    pub const fn message(self) -> &'static str {
        match self {
            Self::PhasePassed => messages::PHASE_PASSED,
            Self::PhaseNotActive => messages::PHASE_NOT_ACTIVE,
            Self::AlreadyRequested => messages::ALREADY_REQUESTED,
            Self::CriteriaOpen => messages::NOT_ALL_SATISFIED,
            Self::NoApprover => messages::NO_APPROVER,
        }
    }
}

/// `gateRequestBlock(phase, check, hasApprover)`.
pub fn gate_request_block(
    status: &str,
    gate_requested: bool,
    all_satisfied: bool,
    has_approver: bool,
) -> Option<GateRequestBlock> {
    if status == "passed" {
        Some(GateRequestBlock::PhasePassed)
    } else if status != "active" {
        Some(GateRequestBlock::PhaseNotActive)
    } else if gate_requested {
        Some(GateRequestBlock::AlreadyRequested)
    } else if !all_satisfied {
        Some(GateRequestBlock::CriteriaOpen)
    } else if !has_approver {
        Some(GateRequestBlock::NoApprover)
    } else {
        None
    }
}

/// `gateApproverIds(sponsor, boardMemberIds)`: the sponsor, and the first
/// change board member when there is one and it is someone else.
pub fn gate_approver_ids(sponsor: Option<&str>, board_member_ids: &[String]) -> Vec<String> {
    let Some(sponsor) = sponsor.filter(|sponsor| !sponsor.is_empty()) else {
        return Vec::new();
    };
    match board_member_ids
        .first()
        .filter(|board| !board.is_empty() && *board != sponsor)
    {
        Some(board) => vec![sponsor.to_owned(), board.clone()],
        None => vec![sponsor.to_owned()],
    }
}

// ── Presenting ──────────────────────────────────────────────────────────────

/// `presentPhase(row)`: a phase row (camelCase, timestamps as ISO text, as
/// `js_row` reads it) as every route answers it.
pub fn present_phase(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "projectId": field("projectId"),
        "position": field("position"),
        "name": field("name"),
        "plannedStart": field("plannedStart"),
        "plannedEnd": field("plannedEnd"),
        "status": field("status"),
        "gateCriteria": field("gateCriteria"),
        "gateResult": field("gateResult"),
        "gateRequestedAt": field("gateRequestedAt"),
        "passedAt": field("passedAt"),
        "createdBy": field("createdBy"),
        "createdAt": field("createdAt"),
        "updatedAt": field("updatedAt"),
    })
}

/// `phaseEventData(row, extra)`: the entity-event payload of a phase.
pub fn phase_event_data(row: &Value, extra: Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let mut data = json!({
        "id": field("id"),
        "projectId": field("projectId"),
        "name": field("name"),
        "status": field("status"),
        "position": field("position"),
        "plannedStart": field("plannedStart"),
        "plannedEnd": field("plannedEnd"),
    });
    if let (Value::Object(data), Value::Object(extra)) = (&mut data, extra) {
        data.extend(extra);
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str =
        include_str!("../../../../packages/domains/flow/src/testing/gate-fixtures.json");

    fn str_of(value: &Value, key: &str) -> String {
        value[key].as_str().unwrap_or_default().to_owned()
    }

    fn facts_of(facts: &Value) -> GateFacts {
        GateFacts {
            deliverables: facts["deliverables"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|d| GateDeliverableFact {
                    id: str_of(d, "id"),
                    number: d["number"].as_i64().unwrap_or_default(),
                    title: str_of(d, "title"),
                    status: str_of(d, "status"),
                    tasks_done: d["tasksDone"].as_i64().unwrap_or_default(),
                    tasks_total: d["tasksTotal"].as_i64().unwrap_or_default(),
                })
                .collect(),
            risks: facts["risks"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| GateRiskFact {
                    id: str_of(r, "id"),
                    number: r["number"].as_i64().unwrap_or_default(),
                    title: str_of(r, "title"),
                    score: r["score"].as_i64().unwrap_or_default(),
                })
                .collect(),
            decisions: facts["decisions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|d| GateDecisionFact {
                    id: str_of(d, "id"),
                    number: d["number"].as_i64().unwrap_or_default(),
                    title: str_of(d, "title"),
                    status: str_of(d, "status"),
                    decision_due_at: d["decisionDueAt"].as_str().map(str::to_owned),
                })
                .collect(),
            change_requests: facts["changeRequests"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| GateChangeFact {
                    id: str_of(c, "id"),
                    number: c["number"].as_i64().unwrap_or_default(),
                    title: str_of(c, "title"),
                })
                .collect(),
            spend: facts
                .get("spend")
                .filter(|s| !s.is_null())
                .map(|s| GateSpendFact {
                    spent: str_of(s, "spent"),
                    budget: s["budget"].as_str().map(str::to_owned),
                    currency: s["currency"].as_str().map(str::to_owned),
                    baseline_version: s["baselineVersion"].as_i64(),
                }),
        }
    }

    /// Every field of `expected` must match `actual` exactly; arrays match
    /// element by element (the rule of `expectSubset` in gates.test.ts).
    fn expect_subset(actual: &Value, expected: &Value, path: &str) {
        match expected {
            Value::Array(items) => {
                let list = actual
                    .as_array()
                    .unwrap_or_else(|| panic!("{path} is a list, got {actual}"));
                assert_eq!(list.len(), items.len(), "{path} length: {actual}");
                for (index, item) in items.iter().enumerate() {
                    expect_subset(&list[index], item, &format!("{path}[{index}]"));
                }
            }
            Value::Object(fields) => {
                assert!(actual.is_object(), "{path} is an object, got {actual}");
                for (key, value) in fields {
                    expect_subset(
                        actual.get(key).unwrap_or(&Value::Null),
                        value,
                        &format!("{path}.{key}"),
                    );
                }
            }
            other => assert_eq!(actual, other, "{path}"),
        }
    }

    #[test]
    fn the_shared_gate_fixtures_give_the_same_answers_as_typescript() {
        let all: Value = serde_json::from_str(FIXTURES).expect("the shared fixtures are JSON");
        for case in all["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            let criteria = case["criteria"].as_array().expect("criteria").clone();
            let waivers = GateWaiver::from_result(&json!({ "waived": case["waivers"] }));
            let check = check_gate(&criteria, &facts_of(&case["facts"]), &waivers);
            expect_subset(&check.to_json(), &case["expected"], name);
        }
    }

    #[test]
    fn criteria_of_the_catalogue_and_manual_text_are_accepted() {
        let fine = [
            json!({ "key": "deliverable_tasks_done", "params": { "deliverableId": "dlv_1" } }),
            json!({ "key": "deliverable_accepted", "params": { "deliverableId": "dlv_1" } }),
            json!({ "key": "no_open_risk_above", "params": { "band": "critical" } }),
            json!({ "key": "no_open_risk_above", "params": { "band": "low" } }),
            json!({ "key": "decision_decided", "params": { "decisionId": "dec_1" } }),
            json!({ "key": "no_change_request_pending" }),
            json!({ "key": "spend_within_baseline" }),
            json!({ "manual": "Plan approved" }),
        ];
        for criterion in &fine {
            assert_eq!(criterion_error(criterion), None, "{criterion}");
        }
        assert_eq!(criteria_error(&fine), None);
    }

    #[test]
    fn unknown_keys_and_missing_parameters_are_refused_with_the_catalogue_messages() {
        assert_eq!(
            criterion_error(&json!({ "key": "moon_phase" })),
            Some(messages::UNKNOWN_CRITERION)
        );
        assert_eq!(
            criterion_error(&json!({ "key": "deliverable_tasks_done" })),
            Some(messages::DELIVERABLE_REQUIRED)
        );
        assert_eq!(
            criterion_error(
                &json!({ "key": "deliverable_accepted", "params": { "deliverableId": " " } })
            ),
            Some(messages::DELIVERABLE_REQUIRED)
        );
        assert_eq!(
            criterion_error(&json!({ "key": "decision_decided", "params": {} })),
            Some(messages::DECISION_REQUIRED)
        );
        assert_eq!(
            criterion_error(
                &json!({ "key": "no_open_risk_above", "params": { "band": "extreme" } })
            ),
            Some(messages::BAND_REQUIRED)
        );
        assert_eq!(
            criterion_error(&json!({ "manual": "   " })),
            Some(messages::MANUAL_TEXT_REQUIRED)
        );
        assert_eq!(
            criterion_error(&json!({ "manual": 5 })),
            Some(messages::MANUAL_TEXT_REQUIRED)
        );
        assert_eq!(
            criterion_error(&json!("text")),
            Some(messages::INVALID_CRITERION)
        );
        assert_eq!(
            criterion_error(&Value::Null),
            Some(messages::INVALID_CRITERION)
        );
        assert_eq!(
            criteria_error(&[json!({ "manual": "ok" }), json!({ "key": "nope" })]),
            Some(messages::UNKNOWN_CRITERION)
        );
    }

    #[test]
    fn a_manual_criterion_starts_unmet_and_empty_parameters_are_dropped() {
        assert_eq!(
            normalize_criterion(&json!({ "manual": "  Plan  " })),
            json!({ "manual": "Plan", "met": false, "metAt": null })
        );
        assert_eq!(
            normalize_criterion(
                &json!({ "manual": "Plan", "met": true, "metAt": "2026-11-03T00:00:00.000Z" })
            ),
            json!({ "manual": "Plan", "met": true, "metAt": "2026-11-03T00:00:00.000Z" })
        );
        assert_eq!(
            normalize_criterion(&json!({ "key": "no_change_request_pending", "params": {} })),
            json!({ "key": "no_change_request_pending" })
        );
        assert_eq!(
            normalize_criterion(
                &json!({ "key": "no_open_risk_above", "params": { "band": "high" } })
            ),
            json!({ "key": "no_open_risk_above", "params": { "band": "high" } })
        );
    }

    #[test]
    fn only_what_the_criteria_need_is_read() {
        assert_eq!(
            gate_facts_needed(&[
                json!({ "key": "deliverable_tasks_done", "params": { "deliverableId": "a" } }),
                json!({ "key": "deliverable_accepted", "params": { "deliverableId": "a" } }),
                json!({ "key": "decision_decided", "params": { "decisionId": "d" } }),
                json!({ "key": "spend_within_baseline" }),
                json!({ "manual": "x" }),
            ]),
            GateFactsNeeded {
                deliverable_ids: vec!["a".to_owned()],
                decision_ids: vec!["d".to_owned()],
                risks: false,
                change_requests: false,
                spend: true,
            }
        );
        assert_eq!(gate_facts_needed(&[]), GateFactsNeeded::default());
    }

    #[test]
    fn the_stored_result_holds_the_criteria_with_their_facts_and_the_waivers_that_apply() {
        let criteria = [
            json!({ "key": "no_change_request_pending" }),
            json!({ "manual": "Plan" }),
        ];
        let facts = GateFacts {
            change_requests: vec![GateChangeFact {
                id: "cr".to_owned(),
                number: 1,
                title: "x".to_owned(),
            }],
            ..GateFacts::default()
        };
        let waivers = vec![
            GateWaiver {
                index: 0,
                note: "later".to_owned(),
                by: "u".to_owned(),
                at: "2026-11-03T10:00:00.000Z".to_owned(),
            },
            GateWaiver {
                index: 5,
                note: "stale".to_owned(),
                by: "u".to_owned(),
                at: "2026-11-03T10:00:00.000Z".to_owned(),
            },
        ];
        let result = gate_result_of(
            &check_gate(&criteria, &facts, &waivers),
            &criteria,
            &waivers,
            "2026-11-03T11:00:00.000Z",
        );
        assert_eq!(result["checkedAt"], "2026-11-03T11:00:00.000Z");
        assert_eq!(result["criteria"].as_array().map(Vec::len), Some(2));
        assert_eq!(result["criteria"][0]["met"], false);
        assert_eq!(result["criteria"][0]["detail"]["count"], 1);
        assert_eq!(
            result["waived"],
            json!([{ "index": 0, "note": "later", "by": "u", "at": "2026-11-03T10:00:00.000Z" }])
        );
    }

    fn phase(id: &str, position: i64, status: &str) -> PhaseLike {
        PhaseLike {
            id: id.to_owned(),
            position,
            status: status.to_owned(),
        }
    }

    #[test]
    fn the_first_upcoming_phase_is_activated_only_when_none_is_active() {
        let phases = [
            phase("p1", 0, "passed"),
            phase("p2", 1, "active"),
            phase("p3", 2, "upcoming"),
            phase("p4", 3, "upcoming"),
        ];
        assert_eq!(phase_to_activate(&phases), None);
        assert_eq!(
            phase_to_activate(&[
                phase("a", 1, "passed"),
                phase("c", 3, "upcoming"),
                phase("b", 2, "upcoming")
            ]),
            Some("b".to_owned())
        );
        assert_eq!(phase_to_activate(&[phase("a", 1, "passed")]), None);
        assert_eq!(phase_to_activate(&[]), None);
        assert_eq!(
            phase_to_activate(&[phase("y", 0, "upcoming"), phase("x", 0, "upcoming")]),
            Some("x".to_owned())
        );
    }

    #[test]
    fn the_next_upcoming_phase_follows_the_lifecycle() {
        let phases = [
            phase("p1", 0, "passed"),
            phase("p2", 1, "active"),
            phase("p3", 2, "upcoming"),
            phase("p4", 3, "upcoming"),
        ];
        assert_eq!(next_upcoming_phase(&phases, "p2"), Some("p3".to_owned()));
        assert_eq!(next_upcoming_phase(&phases, "p3"), Some("p4".to_owned()));
        assert_eq!(next_upcoming_phase(&phases, "p4"), None);
        assert_eq!(next_upcoming_phase(&phases, "missing"), None);
    }

    #[test]
    fn a_reorder_lists_every_phase_once_and_keeps_the_passed_ones_first() {
        let phases = [
            phase("p1", 0, "passed"),
            phase("p2", 1, "active"),
            phase("p3", 2, "upcoming"),
            phase("p4", 3, "upcoming"),
        ];
        let ids = |list: &[&str]| list.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            reorder_error(&phases, &ids(&["p1", "p2", "p4", "p3"])),
            None
        );
        assert_eq!(
            reorder_error(&phases, &ids(&["p1", "p2", "p3"])),
            Some(messages::REORDER_INCOMPLETE)
        );
        assert_eq!(
            reorder_error(&phases, &ids(&["p1", "p2", "p3", "p3"])),
            Some(messages::REORDER_INCOMPLETE)
        );
        assert_eq!(
            reorder_error(&phases, &ids(&["p1", "p2", "p3", "zzz"])),
            Some(messages::REORDER_INCOMPLETE)
        );
        assert_eq!(
            reorder_error(&phases, &ids(&["p2", "p1", "p3", "p4"])),
            Some(messages::REORDER_PASSED)
        );
        assert_eq!(
            reorder_error(&phases, &ids(&["p2", "p3", "p4", "p1"])),
            Some(messages::REORDER_PASSED)
        );
    }

    #[test]
    fn a_gate_says_why_it_cannot_be_requested_in_a_fixed_order() {
        use GateRequestBlock::*;
        assert_eq!(gate_request_block("active", false, true, true), None);
        assert_eq!(
            gate_request_block("passed", false, true, true),
            Some(PhasePassed)
        );
        assert_eq!(
            gate_request_block("upcoming", false, true, true),
            Some(PhaseNotActive)
        );
        assert_eq!(
            gate_request_block("active", true, true, true),
            Some(AlreadyRequested)
        );
        assert_eq!(
            gate_request_block("active", false, false, true),
            Some(CriteriaOpen)
        );
        assert_eq!(
            gate_request_block("active", false, true, false),
            Some(NoApprover)
        );
        assert_eq!(
            CriteriaOpen.message(),
            "Not every criterion is met or waived"
        );
        assert_eq!(AlreadyRequested.as_str(), "already_requested");
    }

    #[test]
    fn the_sponsor_and_one_board_member_are_asked_once_each() {
        let board = |ids: &[&str]| ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            gate_approver_ids(Some("sponsor"), &board(&["board", "other"])),
            vec!["sponsor", "board"]
        );
        assert_eq!(
            gate_approver_ids(Some("sponsor"), &board(&["sponsor"])),
            vec!["sponsor"]
        );
        assert_eq!(gate_approver_ids(Some("sponsor"), &[]), vec!["sponsor"]);
        assert!(gate_approver_ids(None, &board(&["board"])).is_empty());
    }
}
