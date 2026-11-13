//! A WeldDesk team's escalation rules (`@weldsuite/db/lib/desk-escalation-check`
//! and `@weldsuite/db/lib/desk-escalation`).
//!
//! `helpdesk_departments.escalationRules` belong to a team and apply to the
//! open conversations in it. A rule fires `afterMinutes` after its condition
//! started holding:
//!
//!   - `unassigned`: open and nobody owns it, since it was opened, unassigned
//!     or reopened;
//!   - `no_response`: the customer is waiting, since their first message
//!     after the team's last reply;
//!   - `sla_breach`: a running SLA clock breached, since the earliest breach;
//!   - `custom`: never.
//!
//! Moving into the team restarts every condition's clock for that team's
//! rules. A rule fires at most once per episode: the `escalated` timeline
//! event (`metadata.teamId`, `metadata.ruleIndex`) at or after the
//! condition's start says it already did.
//!
//! [`refresh_check`] stores the earliest due time in
//! `desk_conversations.escalation_check_at` ([`crate::sla::refresh`] calls
//! it and folds it into the due time writers copy into the index); the SLA
//! sweep runs the due rules with [`run`].

use serde_json::{Map, Value, json};
use sqlx::PgPool;

use crate::assignment::{Picker, auto_assign_with, team_member_ids};
use crate::attributes::{self, Update, UpdateError};
use crate::sla::{self, ConversationRef, time_value};
use crate::sla_calendar::iso;
use crate::webchat::{self, Append, AppendError, DESK_CONVERSATIONS};
use weldsuite_kit::validation::Field;

const MINUTE_MS: f64 = 60_000.0;

/// Rules one sweep fires on a conversation at most (`MAX_FIRINGS`).
const MAX_FIRINGS: usize = 5;

/// `DESK_ESCALATION_CUSTOMER_MESSAGE`: what `notifyCustomer` posts in
/// English, and for a language without a text of its own.
pub const CUSTOMER_MESSAGE: &str = "Your request has been escalated so the right people can help. We will get back to you as soon as possible.";

/// `DESK_ESCALATION_CUSTOMER_MESSAGES`: the notice by language (a tag's
/// primary subtag).
const CUSTOMER_MESSAGES: [(&str, &str); 2] = [
    ("en", CUSTOMER_MESSAGE),
    (
        "nl",
        "Je verzoek is doorgezet, zodat de juiste mensen je kunnen helpen. We komen zo snel mogelijk bij je terug.",
    ),
];

/// `deskEscalationCustomerMessage(language)`: the notice for a language tag
/// (`nl`, `nl-BE`, `NL_nl`), English when it has no text of its own.
#[must_use]
pub fn customer_message(language: Option<&str>) -> &'static str {
    let tag = weldsuite_kit::validation::js_trim(language.unwrap_or_default()).to_lowercase();
    let primary = tag.split(['-', '_']).next().unwrap_or_default();
    CUSTOMER_MESSAGES
        .iter()
        .find(|(language, _)| *language == primary)
        .map_or(CUSTOMER_MESSAGE, |(_, text)| text)
}

/// `customerLanguage(db, conversation)`: the conversation's language
/// (detected by inbox translation), else the workspace's.
async fn customer_language(
    db: &PgPool,
    conversation: &Value,
) -> Result<Option<String>, sqlx::Error> {
    let own = conversation["language"].as_str().unwrap_or_default();
    if !weldsuite_kit::validation::js_trim(own).is_empty() {
        return Ok(Some(own.to_owned()));
    }
    let language: Option<Option<String>> = sqlx::query_scalar(
        "select language from workspace_settings where deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(language.flatten())
}

/// An `EscalationRule` the engine can run.
#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub condition: String,
    pub after_minutes: f64,
    pub escalate_to: String,
    pub escalate_to_id: Option<String>,
    pub notify_customer: bool,
}

/// `DeskEscalationRuleAt`: a rule and its index in the stored list.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleAt {
    pub index: usize,
    pub rule: Rule,
}

/// JavaScript truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `runnableDeskEscalationRules(raw)`: the rules with a known condition and
/// target and a finite, non-negative `afterMinutes`, each with its index.
pub fn runnable_rules(raw: &Value) -> Vec<RuleAt> {
    let Some(items) = raw.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(rule) = item.as_object() else {
            continue;
        };
        let Some(condition) = rule
            .get("condition")
            .and_then(Value::as_str)
            .filter(|c| matches!(*c, "sla_breach" | "no_response" | "unassigned"))
        else {
            continue;
        };
        let Some(escalate_to) = rule
            .get("escalateTo")
            .and_then(Value::as_str)
            .filter(|t| matches!(*t, "manager" | "next_tier" | "specific_agent"))
        else {
            continue;
        };
        let Some(after) = rule
            .get("afterMinutes")
            .and_then(Value::as_f64)
            .filter(|after| after.is_finite() && *after >= 0.0)
        else {
            continue;
        };
        out.push(RuleAt {
            index,
            rule: Rule {
                condition: condition.to_owned(),
                after_minutes: after,
                escalate_to: escalate_to.to_owned(),
                escalate_to_id: rule
                    .get("escalateToId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned),
                notify_customer: truthy(rule.get("notifyCustomer")),
            },
        });
    }
    out
}

/// `DeskEscalationTimelineEntry`.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineEntry {
    pub at: i64,
    pub kind: String,
    pub author_type: String,
    pub event_type: Option<String>,
    pub team_changed: bool,
    pub team_id: Option<String>,
    pub rule_index: Option<f64>,
}

/// `DeskEscalationEpisode`.
#[derive(Debug, Clone, PartialEq)]
pub struct Episode {
    pub team_entered_at: i64,
    pub unassigned_since: Option<i64>,
    pub waiting_since: Option<i64>,
    /// `(teamId, ruleIndex, at)` of each `escalated` event.
    pub fired: Vec<(Option<String>, Option<f64>, i64)>,
}

/// `deskEscalationEpisode(createdAt, timeline)`: replay the timeline
/// (oldest first) from the conversation's start. Pure.
pub fn episode(created_at: i64, timeline: &[TimelineEntry]) -> Episode {
    let mut open = true;
    let mut owned = false;
    let mut out = Episode {
        team_entered_at: created_at,
        unassigned_since: Some(created_at),
        waiting_since: None,
        fired: Vec::new(),
    };
    for entry in timeline {
        let at = entry.at;
        let mut reopen = |out: &mut Episode| {
            if !open {
                open = true;
                if !owned {
                    out.unassigned_since = Some(at);
                }
            }
        };
        if entry.kind == "message" {
            match entry.author_type.as_str() {
                "visitor" => {
                    reopen(&mut out);
                    if out.waiting_since.is_none() {
                        out.waiting_since = Some(at);
                    }
                }
                "agent" | "bot" => out.waiting_since = None,
                _ => {}
            }
            continue;
        }
        if entry.kind != "event" {
            continue;
        }
        match entry.event_type.as_deref() {
            Some("closed") => {
                open = false;
                out.waiting_since = None;
                out.unassigned_since = None;
            }
            Some("reopened") => reopen(&mut out),
            Some("assigned") => {
                owned = true;
                out.unassigned_since = None;
            }
            Some("unassigned") => {
                owned = false;
                if open {
                    out.unassigned_since = Some(at);
                }
            }
            Some("attributes_changed") if entry.team_changed => out.team_entered_at = at,
            Some("escalated") => out
                .fired
                .push((entry.team_id.clone(), entry.rule_index, at)),
            _ => {}
        }
    }
    out
}

/// `DeskEscalationDue`: a rule and when it fires (maybe already past).
#[derive(Debug, Clone, PartialEq)]
pub struct Due {
    pub index: usize,
    pub rule: Rule,
    pub due_at: i64,
}

/// `deskEscalationsDue({ conversation, rules, episode, breachedAt })`: the
/// team's rules that can still fire in this episode, earliest first (ties
/// by index). Pure.
pub fn due(
    conversation: &Value,
    rules: &[RuleAt],
    episode: &Episode,
    breached_at: Option<i64>,
) -> Vec<Due> {
    let team_id = conversation["departmentId"]
        .as_str()
        .filter(|id| !id.is_empty());
    let (true, Some(team_id)) = (conversation["state"] == "open", team_id) else {
        return Vec::new();
    };
    let owned = truthy(conversation.get("assigneeId"));
    let mut out = Vec::new();
    for RuleAt { index, rule } in rules {
        let since = match rule.condition.as_str() {
            "unassigned" if !owned => episode.unassigned_since,
            "no_response" => episode.waiting_since,
            "sla_breach" => breached_at,
            _ => None,
        };
        let Some(since) = since else {
            continue;
        };
        let anchor = since.max(episode.team_entered_at);
        #[allow(clippy::cast_precision_loss)] // a rule index
        let fired = episode.fired.iter().any(|(team, rule_index, at)| {
            team.as_deref() == Some(team_id) && *rule_index == Some(*index as f64) && *at >= anchor
        });
        if fired {
            continue;
        }
        #[allow(clippy::cast_possible_truncation)] // whole milliseconds, as Math.round gives them
        let after = (rule.after_minutes * MINUTE_MS).round() as i64;
        out.push(Due {
            index: *index,
            rule: rule.clone(),
            due_at: anchor.saturating_add(after),
        });
    }
    out.sort_by(|a, b| a.due_at.cmp(&b.due_at).then(a.index.cmp(&b.index)));
    out
}

// ── Reading what the derivation needs ───────────────────────────────────────

/// `loadDeskTeamEscalationRules(db, teamId)`.
pub async fn team_rules(db: &PgPool, team_id: Option<&str>) -> Result<Vec<RuleAt>, sqlx::Error> {
    let Some(team_id) = team_id.filter(|id| !id.is_empty()) else {
        return Ok(Vec::new());
    };
    let team: Option<(Option<Value>, bool)> = sqlx::query_as(
        "select escalation_rules, is_active from helpdesk_departments
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(team_id)
    .fetch_optional(db)
    .await?;
    Ok(match team {
        Some((rules, true)) => runnable_rules(&rules.unwrap_or(Value::Null)),
        _ => Vec::new(),
    })
}

/// `loadDeskEscalationTimeline(db, conversationId)`.
pub async fn timeline(
    db: &PgPool,
    conversation_id: &str,
) -> Result<Vec<TimelineEntry>, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        i64,
        String,
        String,
        Option<String>,
        bool,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "select floor(extract(epoch from created_at) * 1000)::int8, kind, author_type,
                    metadata->>'eventType',
                    coalesce(metadata->'changes' @> '[{\"field\":\"team\"}]'::jsonb, false),
                    metadata->>'teamId', metadata->>'ruleIndex'
             from desk_messages where conversation_id = $1 and kind in ('message', 'event')
             order by created_at asc, id asc",
    )
    .bind(conversation_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(at, kind, author_type, event_type, team_changed, team_id, rule_index)| {
                TimelineEntry {
                    at,
                    kind,
                    author_type,
                    event_type,
                    team_changed,
                    team_id,
                    rule_index: rule_index
                        .filter(|text| !text.is_empty())
                        .map(|text| text.trim().parse::<f64>().unwrap_or(f64::NAN)),
                }
            },
        )
        .collect())
}

/// `loadDeskRunningBreach(db, conversationId)`: the earliest breach of a
/// running SLA clock.
pub async fn running_breach(
    db: &PgPool,
    conversation_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar(
        "select floor(extract(epoch from min(breached_at)) * 1000)::int8 from desk_sla_clocks
         where conversation_id = $1 and status = 'running'",
    )
    .bind(conversation_id)
    .fetch_one(db)
    .await
}

/// `deskEscalationsDueFor(db, conversation, breachedAt)`.
pub async fn due_for(
    db: &PgPool,
    conversation: &Value,
    breached_at: Option<i64>,
) -> Result<Vec<Due>, sqlx::Error> {
    let team_id = conversation["departmentId"]
        .as_str()
        .filter(|id| !id.is_empty());
    if conversation["state"] != "open" || team_id.is_none() {
        return Ok(Vec::new());
    }
    let rules = team_rules(db, team_id).await?;
    if rules.is_empty() {
        return Ok(Vec::new());
    }
    let id = conversation["id"].as_str().unwrap_or_default();
    let created_at = time_value(conversation.get("createdAt")).unwrap_or_default();
    let episode = episode(created_at, &timeline(db, id).await?);
    Ok(due(conversation, &rules, &episode, breached_at))
}

/// `refreshDeskEscalationCheck(db, conversation, breachedAt)`: re-derive and
/// store `escalationCheckAt` (the earliest rule still to fire); writes only
/// when it changed. The conversation after it, and the check time.
pub async fn refresh_check(
    db: &PgPool,
    conversation: Value,
    breached_at: Option<i64>,
) -> Result<(Value, Option<i64>), crate::table::WriteError> {
    let next = due_for(db, &conversation, breached_at)
        .await?
        .first()
        .map(|d| d.due_at);
    if time_value(conversation.get("escalationCheckAt")) == next {
        return Ok((conversation, next));
    }
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    let mut values = Map::new();
    values.insert(
        "escalation_check_at".to_owned(),
        next.map_or(Value::Null, |at| json!(iso(at))),
    );
    let updated = DESK_CONVERSATIONS
        .patch(db, &id, values, false, &["escalationCheckAt"])
        .await?;
    Ok((
        updated.unwrap_or_else(|| {
            let mut merged = conversation;
            merged["escalationCheckAt"] = next.map_or(Value::Null, |at| json!(iso(at)));
            merged
        }),
        next,
    ))
}

/// `listDueDeskEscalations(db, now, limit)`: conversations with a rule due
/// by `now`, the most overdue first.
pub async fn list_due(db: &PgPool, now: i64, limit: i64) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select id from desk_conversations where escalation_check_at <= $1::timestamp
         order by escalation_check_at asc, id asc limit $2",
    )
    .bind(iso(now))
    .bind(limit)
    .fetch_all(db)
    .await
}

/// `backOffDeskEscalation(db, conversationId, retryAt)`.
pub async fn back_off(
    db: &PgPool,
    conversation_id: &str,
    retry_at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("update desk_conversations set escalation_check_at = $2::timestamp where id = $1")
        .bind(conversation_id)
        .bind(iso(retry_at))
        .execute(db)
        .await?;
    Ok(())
}

// ── Running the rules ───────────────────────────────────────────────────────

/// `DeskEscalationStep`: a timeline event an escalation wrote.
#[derive(Debug, Clone)]
pub struct Step {
    pub conversation: Value,
    pub message: Value,
    /// `assigned` when the owner changed, `updated` otherwise.
    pub action: &'static str,
}

/// `DeskEscalationResult`.
#[derive(Debug, Clone, Default)]
pub struct Escalated {
    pub conversation: Option<Value>,
    pub steps: Vec<Step>,
    /// Teammates who now own the conversation through an escalation.
    pub new_owners: Vec<String>,
    pub next_check_at: Option<i64>,
}

/// Why running the rules stopped.
#[derive(Debug)]
pub struct EscalationError(pub String);

impl std::fmt::Display for EscalationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<sqlx::Error> for EscalationError {
    fn from(error: sqlx::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<AppendError> for EscalationError {
    fn from(error: AppendError) -> Self {
        Self(error.to_string())
    }
}

impl From<UpdateError> for EscalationError {
    fn from(error: UpdateError) -> Self {
        match error {
            UpdateError::NotFound => Self("conversation not found".to_owned()),
            UpdateError::Rejected { message, .. } | UpdateError::Failed(message) => Self(message),
        }
    }
}

/// `memberUserId(db, ref)`: an active internal member, by user id or by
/// member id (`managerId` holds the latter).
async fn member_user_id(
    db: &PgPool,
    reference: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let Some(reference) = reference.filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    sqlx::query_scalar(
        "select user_id from workspace_members
         where (user_id = $1 or id = $1) and deleted_at is null
           and upper(status) = 'ACTIVE' and upper(member_type) = 'INTERNAL'
         order by user_id asc limit 1",
    )
    .bind(reference)
    .fetch_optional(db)
    .await
}

/// `nextDeskTeam(db, teamId)`: the active team after `team_id` in the teams'
/// order (sort order, newest first, id).
pub async fn next_team(db: &PgPool, team_id: &str) -> Result<Option<String>, sqlx::Error> {
    let teams: Vec<(String, bool)> = sqlx::query_as(
        "select id, is_active from helpdesk_departments where deleted_at is null
         order by coalesce(sort_order, 0), created_at desc, id desc",
    )
    .fetch_all(db)
    .await?;
    let Some(at) = teams.iter().position(|(id, _)| id == team_id) else {
        return Ok(None);
    };
    Ok(teams[at + 1..]
        .iter()
        .find(|(_, active)| *active)
        .map(|(id, _)| id.clone()))
}

fn event(fields: &[(&str, Value)]) -> Map<String, Value> {
    fields
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

struct Fire<'a> {
    picker: &'a Picker<'a>,
    steps: Vec<Step>,
    new_owners: Vec<String>,
}

impl Fire<'_> {
    async fn append(
        &mut self,
        db: &PgPool,
        input: Append<'_>,
        action: &'static str,
    ) -> Result<Value, EscalationError> {
        let (conversation, message) = webchat::append(db, input).await?.pair();
        self.steps.push(Step {
            conversation: conversation.clone(),
            message,
            action,
        });
        Ok(conversation)
    }

    /// Hand the conversation to `user_id` (an escalation overrides the owner).
    async fn assign_to(
        &mut self,
        db: &PgPool,
        conversation: Value,
        user_id: &str,
    ) -> Result<Value, EscalationError> {
        if conversation["assigneeId"].as_str() == Some(user_id) {
            return Ok(conversation);
        }
        let id = conversation["id"].as_str().unwrap_or_default().to_owned();
        let metadata = event(&[
            ("eventType", json!("assigned")),
            ("assigneeId", json!(user_id)),
            ("escalation", json!(true)),
        ]);
        let next = self
            .append(
                db,
                Append {
                    conversation_id: &id,
                    kind: "event",
                    author_type: "system",
                    author_id: None,
                    body: None,
                    attachments: None,
                    metadata: Some(metadata),
                    assignee_id: Some(Some(user_id.to_owned())),
                },
                "assigned",
            )
            .await?;
        self.new_owners.push(user_id.to_owned());
        Ok(next)
    }

    /// Move to the next team; an owner outside its members lets go, and the
    /// team's members take it.
    async fn next_tier(
        &mut self,
        db: &PgPool,
        conversation: &Value,
        next: &str,
    ) -> Result<Value, EscalationError> {
        let id = conversation["id"].as_str().unwrap_or_default().to_owned();
        let input = Update {
            department_id: Field::Set(next.to_owned()),
            ..Update::default()
        };
        let moved = attributes::update_with_metadata(
            db,
            &id,
            "system",
            None,
            &input,
            Some(event(&[("escalation", json!(true))])),
        )
        .await?;
        let mut current = moved.conversation;
        if let Some(message) = moved.message {
            self.steps.push(Step {
                conversation: current.clone(),
                message,
                action: "updated",
            });
        }
        let members = team_member_ids(db, Some(next)).await?;
        let owner = current["assigneeId"]
            .as_str()
            .filter(|a| !a.is_empty())
            .map(str::to_owned);
        if let (Some(owner), Some(members)) = (owner, members)
            && !members.contains(&owner)
        {
            let metadata = event(&[
                ("eventType", json!("unassigned")),
                ("assigneeId", Value::Null),
                ("escalation", json!(true)),
            ]);
            current = self
                .append(
                    db,
                    Append {
                        conversation_id: &id,
                        kind: "event",
                        author_type: "system",
                        author_id: None,
                        body: None,
                        attachments: None,
                        metadata: Some(metadata),
                        assignee_id: Some(None),
                    },
                    "assigned",
                )
                .await?;
        }
        if let Some(assigned) = auto_assign_with(db, &id, self.picker).await? {
            let (conversation, message) = assigned.pair();
            current = conversation;
            self.steps.push(Step {
                conversation: current.clone(),
                message,
                action: "assigned",
            });
            if let Some(owner) = current["assigneeId"].as_str().filter(|a| !a.is_empty()) {
                self.new_owners.push(owner.to_owned());
            }
        }
        Ok(current)
    }

    /// `fire(db, ctx, conversation, due)`.
    async fn fire(
        &mut self,
        db: &PgPool,
        conversation: Value,
        due: &Due,
    ) -> Result<(), EscalationError> {
        let team_id = conversation["departmentId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let id = conversation["id"].as_str().unwrap_or_default().to_owned();
        let rule = &due.rule;
        let mut assignee: Option<String> = None;
        let mut to_team: Option<String> = None;
        match rule.escalate_to.as_str() {
            "manager" => {
                let manager: Option<Option<String>> = sqlx::query_scalar(
                    "select manager_id from helpdesk_departments where id = $1 limit 1",
                )
                .bind(&team_id)
                .fetch_optional(db)
                .await?;
                assignee = member_user_id(db, manager.flatten().as_deref()).await?;
            }
            "specific_agent" => {
                assignee = member_user_id(db, rule.escalate_to_id.as_deref()).await?;
            }
            "next_tier" => to_team = next_team(db, &team_id).await?,
            _ => {}
        }

        let mut metadata = event(&[
            ("eventType", json!("escalated")),
            ("teamId", json!(team_id)),
            ("ruleIndex", json!(due.index)),
            ("condition", json!(rule.condition)),
            ("escalateTo", json!(rule.escalate_to)),
        ]);
        if let Some(user) = &assignee {
            metadata.insert("assigneeId".to_owned(), json!(user));
        }
        if let Some(team) = &to_team {
            metadata.insert("toTeamId".to_owned(), json!(team));
        }
        let mut current = self
            .append(
                db,
                Append {
                    conversation_id: &id,
                    kind: "event",
                    author_type: "system",
                    author_id: None,
                    body: None,
                    attachments: None,
                    metadata: Some(metadata),
                    assignee_id: None,
                },
                "updated",
            )
            .await?;

        if let Some(user) = &assignee {
            current = self.assign_to(db, current, user).await?;
        } else if let Some(team) = &to_team {
            current = self.next_tier(db, &current, team).await?;
        }

        if rule.notify_customer {
            let id = current["id"].as_str().unwrap_or_default().to_owned();
            let language = customer_language(db, &current).await?;
            self.append(
                db,
                Append {
                    conversation_id: &id,
                    kind: "message",
                    author_type: "system",
                    author_id: None,
                    body: Some(customer_message(language.as_deref()).to_owned()),
                    attachments: None,
                    metadata: Some(event(&[("escalation", json!(true))])),
                    assignee_id: None,
                },
                "updated",
            )
            .await?;
        }
        Ok(())
    }
}

/// `runDeskEscalations(db, { conversationId, now, pick })`: fire the rules
/// due on a conversation by `now`, one at a time (each re-derived after the
/// last), then re-derive its SLA and escalation check.
pub async fn run(
    db: &PgPool,
    conversation_id: &str,
    now: i64,
    picker: &Picker<'_>,
) -> Result<Escalated, EscalationError> {
    let mut fire = Fire {
        picker,
        steps: Vec::new(),
        new_owners: Vec::new(),
    };
    for _ in 0..MAX_FIRINGS {
        let Some((conversation, _)) = webchat::get(db, conversation_id, false).await? else {
            return Ok(Escalated {
                conversation: None,
                steps: fire.steps,
                new_owners: fire.new_owners,
                next_check_at: None,
            });
        };
        let breached_at = running_breach(db, conversation_id).await?;
        let due = due_for(db, &conversation, breached_at).await?;
        let Some(first) = due.into_iter().next().filter(|d| d.due_at <= now) else {
            break;
        };
        fire.fire(db, conversation, &first).await?;
    }
    let refreshed = sla::refresh(db, ConversationRef::Id(conversation_id), now, false)
        .await
        .map_err(|error| EscalationError(error.to_string()))?;
    let mut new_owners: Vec<String> = Vec::new();
    for owner in fire.new_owners {
        if !new_owners.contains(&owner) {
            new_owners.push(owner);
        }
    }
    Ok(Escalated {
        conversation: refreshed.conversation,
        steps: fire.steps,
        new_owners,
        next_check_at: refreshed.next_check_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(at: i64, kind: &str, author: &str, event: Option<&str>) -> TimelineEntry {
        TimelineEntry {
            at,
            kind: kind.to_owned(),
            author_type: author.to_owned(),
            event_type: event.map(str::to_owned),
            team_changed: false,
            team_id: None,
            rule_index: None,
        }
    }

    fn rules() -> Vec<RuleAt> {
        runnable_rules(&json!([
            { "condition": "unassigned", "afterMinutes": 10, "escalateTo": "manager" },
            { "condition": "no_response", "afterMinutes": 30, "escalateTo": "next_tier", "notifyCustomer": true },
            { "condition": "custom", "afterMinutes": 1, "escalateTo": "manager" },
            { "condition": "sla_breach", "afterMinutes": 0, "escalateTo": "specific_agent", "escalateToId": "user_x" },
            { "condition": "unassigned", "afterMinutes": -1, "escalateTo": "manager" },
        ]))
    }

    #[test]
    fn runnable_rules_keep_their_index_and_skip_the_rest() {
        let rules = rules();
        assert_eq!(rules.iter().map(|r| r.index).collect::<Vec<_>>(), [0, 1, 3]);
        assert!(rules[1].rule.notify_customer);
        assert_eq!(rules[2].rule.escalate_to_id.as_deref(), Some("user_x"));
    }

    #[test]
    fn the_episode_follows_owner_waiting_and_team() {
        let mut team = entry(50, "event", "agent", Some("attributes_changed"));
        team.team_changed = true;
        let timeline = [
            entry(0, "message", "visitor", None),
            entry(10, "message", "visitor", None),
            entry(20, "event", "system", Some("assigned")),
            entry(30, "message", "agent", None),
            entry(40, "event", "agent", Some("unassigned")),
            team,
            entry(60, "message", "visitor", None),
        ];
        let ep = episode(0, &timeline);
        assert_eq!(ep.team_entered_at, 50);
        assert_eq!(ep.unassigned_since, Some(40));
        assert_eq!(ep.waiting_since, Some(60));

        let closed = [
            entry(0, "message", "visitor", None),
            entry(10, "event", "agent", Some("closed")),
            entry(20, "message", "visitor", None),
        ];
        let ep = episode(0, &closed);
        assert_eq!(ep.unassigned_since, Some(20));
        assert_eq!(ep.waiting_since, Some(20));
    }

    #[test]
    fn due_rules_anchor_on_the_later_of_the_condition_and_the_team() {
        let conversation = json!({ "state": "open", "departmentId": "dep_1", "assigneeId": null });
        let ep = Episode {
            team_entered_at: 100,
            unassigned_since: Some(0),
            waiting_since: Some(200),
            fired: Vec::new(),
        };
        let due_rules = due(&conversation, &rules(), &ep, Some(1_000));
        let times: Vec<(usize, i64)> = due_rules.iter().map(|d| (d.index, d.due_at)).collect();
        assert_eq!(times, vec![(3, 1_000), (0, 600_100), (1, 1_800_200)]);
    }

    #[test]
    fn a_rule_fires_once_per_episode() {
        let conversation = json!({ "state": "open", "departmentId": "dep_1", "assigneeId": null });
        let mut ep = Episode {
            team_entered_at: 0,
            unassigned_since: Some(0),
            waiting_since: None,
            fired: vec![(Some("dep_1".to_owned()), Some(0.0), 700_000)],
        };
        assert_eq!(due(&conversation, &rules(), &ep, None).len(), 0);
        // Unassigned again later: a new episode.
        ep.unassigned_since = Some(800_000);
        assert_eq!(due(&conversation, &rules(), &ep, None)[0].due_at, 1_400_000);
        // Another team's escalation does not count.
        ep.unassigned_since = Some(0);
        ep.fired = vec![(Some("dep_2".to_owned()), Some(0.0), 700_000)];
        assert_eq!(due(&conversation, &rules(), &ep, None).len(), 1);
        // Owned, closed or without a team: nothing.
        let owned = json!({ "state": "open", "departmentId": "dep_1", "assigneeId": "user_a" });
        assert_eq!(due(&owned, &rules(), &ep, None).len(), 0);
        let closed = json!({ "state": "closed", "departmentId": "dep_1" });
        assert_eq!(due(&closed, &rules(), &ep, None).len(), 0);
        let teamless = json!({ "state": "open", "departmentId": null });
        assert_eq!(due(&teamless, &rules(), &ep, None).len(), 0);
    }
}
