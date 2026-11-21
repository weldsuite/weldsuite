//! WeldDesk routing rules (`@weldsuite/db/lib/desk-routing`,
//! `packages/core/db/src/lib/desk-routing.ts`).
//!
//! The rules live in `helpdesk_settings.automation.deskRouting.rules`, in
//! order. When a writer opens a conversation, and when its type or tags
//! change, the first enabled rule whose conditions all hold applies: team,
//! priority and tags through [`crate::attributes`] (author `system`,
//! `metadata.routingRuleId`), and an owner only on an open conversation
//! nobody owns. A write that set the team itself keeps it (`keep_team`), one
//! that named an owner keeps that (`keep_assignee`). Conditions compare as
//! the SLA engine does: case-insensitively; every list a rule sets must
//! match, `tags` when the conversation has any of them.

use std::collections::HashSet;

use sea_orm::ActiveValue::Set;
// The module, not the trait: `PgExpr` in scope would shadow `contains` on slices.
use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;
use weldsuite_schema::tenant::{
    desk_conversations, desk_messages, helpdesk_departments, helpdesk_settings, workspace_members,
};

use crate::assignment::{Picker, auto_assign_with};
use crate::attributes::{self, Update, UpdateError, normalize_tags};
use crate::webchat::{self, Append, AppendError};

const CONDITION_KEYS: [&str; 5] = [
    "channels",
    "ticketTypeIds",
    "tags",
    "priorities",
    "departmentIds",
];
const PRIORITIES: [&str; 4] = ["low", "medium", "high", "urgent"];

/// `idList(value)`: the non-empty strings, each once, in order.
fn id_list(value: Option<&Value>) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| !id.is_empty() && seen.insert(*id))
        .map(str::to_owned)
        .collect()
}

fn optional_id(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// A rule, normalised (`DeskRoutingRule`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// `(key, values)` for each condition list that is set, in
    /// [`CONDITION_KEYS`] order.
    pub conditions: Vec<(&'static str, Vec<String>)>,
    pub department_id: Option<String>,
    pub assignee_id: Option<String>,
    pub priority: Option<String>,
    pub add_tags: Vec<String>,
}

impl Rule {
    fn condition(&self, key: &str) -> Option<&[String]> {
        self.conditions
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, values)| values.as_slice())
    }

    /// The rule as stored and answered.
    pub fn json(&self) -> Value {
        let mut conditions = Map::new();
        for (key, values) in &self.conditions {
            conditions.insert((*key).to_owned(), json!(values));
        }
        let mut actions = Map::new();
        if let Some(id) = &self.department_id {
            actions.insert("departmentId".to_owned(), json!(id));
        }
        if let Some(id) = &self.assignee_id {
            actions.insert("assigneeId".to_owned(), json!(id));
        }
        if let Some(priority) = &self.priority {
            actions.insert("priority".to_owned(), json!(priority));
        }
        if !self.add_tags.is_empty() {
            actions.insert("addTags".to_owned(), json!(self.add_tags));
        }
        json!({
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled,
            "conditions": conditions,
            "actions": actions,
        })
    }
}

/// `normalizeDeskRouting(raw)`: a rule without an id is dropped, a repeated
/// id keeps the first.
pub fn normalize(raw: Option<&Value>) -> Vec<Rule> {
    let mut seen = HashSet::new();
    let mut rules = Vec::new();
    let items = raw
        .and_then(|value| value.get("rules"))
        .and_then(Value::as_array);
    for item in items.into_iter().flatten() {
        let Some(rule) = item.as_object() else {
            continue;
        };
        let Some(id) = optional_id(rule.get("id")) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let conditions_raw = rule.get("conditions").filter(|c| c.is_object());
        let conditions = CONDITION_KEYS
            .iter()
            .filter_map(|key| {
                let list = id_list(conditions_raw.and_then(|c| c.get(*key)));
                (!list.is_empty()).then_some((*key, list))
            })
            .collect();
        let actions = rule.get("actions").filter(|a| a.is_object());
        let action = |key: &str| actions.and_then(|a| a.get(key));
        rules.push(Rule {
            id,
            name: rule
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            enabled: rule.get("enabled") != Some(&Value::Bool(false)),
            conditions,
            department_id: optional_id(action("departmentId")),
            assignee_id: optional_id(action("assigneeId")),
            priority: action("priority")
                .and_then(Value::as_str)
                .filter(|p| PRIORITIES.contains(p))
                .map(str::to_owned),
            add_tags: id_list(action("addTags")),
        });
    }
    rules
}

/// The rules as answered (`{ rules }`).
pub fn rules_json(rules: &[Rule]) -> Value {
    json!({ "rules": rules.iter().map(Rule::json).collect::<Vec<_>>() })
}

/// `getDeskRoutingSettings(db)`: the settings row's id and the rules.
pub async fn settings(db: &PgPool) -> Result<(Option<String>, Vec<Rule>), DbErr> {
    let row: Option<(String, Option<Value>)> = helpdesk_settings::Entity::find()
        .select_only()
        .columns([
            helpdesk_settings::Column::Id,
            helpdesk_settings::Column::Automation,
        ])
        .filter(helpdesk_settings::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(match row {
        Some((id, automation)) => {
            let raw = automation.as_ref().and_then(|a| a.get("deskRouting"));
            (Some(id), normalize(raw))
        }
        None => (None, Vec::new()),
    })
}

/// `saveDeskRoutingSettings(db, generateId, settings)`: replace the rules,
/// leaving the rest of `automation` as it is.
pub async fn save(db: &PgPool, raw: &Value) -> Result<Vec<Rule>, DbErr> {
    use helpdesk_settings::Column;
    let normalized = rules_json(&normalize(Some(raw)));
    let (settings_id, _) = settings(db).await?;
    let now = utc_now();
    let orm_db = orm(db);
    if let Some(id) = settings_id {
        // `coalesce(automation, '{}') || { deskRouting }`: the rest of
        // `automation` stays as it is, in the same statement.
        let automation = Expr::from(Func::coalesce([
            Expr::col(Column::Automation),
            Expr::val(json!({})),
        ]));
        let automation =
            pg::PgExpr::concat(automation, Expr::val(json!({ "deskRouting": normalized })));
        helpdesk_settings::Entity::update_many()
            .col_expr(Column::Automation, automation)
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(id))
            .exec(&orm_db)
            .await?;
    } else {
        helpdesk_settings::Entity::insert(helpdesk_settings::ActiveModel {
            id: Set(generate_id("hds")),
            automation: Set(Some(json!({ "enabled": false, "deskRouting": normalized }))),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&orm_db)
        .await?;
    }
    Ok(settings(db).await?.1)
}

// ── Matching ────────────────────────────────────────────────────────────────

/// The SLA engine's `same(a, b)`: the same text ignoring case.
fn same(a: &str, b: &Value) -> bool {
    if b.is_null() {
        return false;
    }
    a.to_lowercase() == crate::workflow::shared::js_string(Some(b)).to_lowercase()
}

/// An unset list holds; otherwise it must name the value.
fn list_holds(list: Option<&[String]>, value: &Value) -> bool {
    match list {
        None => true,
        Some(list) => !value.is_null() && list.iter().any(|v| same(v, value)),
    }
}

/// `deskRoutingRuleMatches(rule, conversation)`.
pub fn matches(rule: &Rule, conversation: &Value) -> bool {
    let tags_hold = match rule.condition("tags") {
        None => true,
        Some(list) => conversation["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|tag| list.iter().any(|v| same(v, tag))),
    };
    list_holds(rule.condition("channels"), &conversation["channel"])
        && list_holds(
            rule.condition("ticketTypeIds"),
            &conversation["ticketTypeId"],
        )
        && list_holds(rule.condition("priorities"), &conversation["priority"])
        && list_holds(
            rule.condition("departmentIds"),
            &conversation["departmentId"],
        )
        && tags_hold
}

/// `selectDeskRoutingRule(rules, conversation)`: the first enabled rule
/// whose conditions all hold.
pub fn select<'a>(rules: &'a [Rule], conversation: &Value) -> Option<&'a Rule> {
    rules
        .iter()
        .find(|rule| rule.enabled && matches(rule, conversation))
}

// ── Applying a rule ─────────────────────────────────────────────────────────

/// `DeskRoutingStep`.
#[derive(Debug, Clone)]
pub struct Step {
    pub conversation: Value,
    pub message: Value,
    /// `updated` for ticket fields, `assigned` for an owner.
    pub action: &'static str,
}

/// `DeskRoutingResult`.
#[derive(Debug, Clone)]
pub struct Routed {
    pub conversation: Value,
    pub steps: Vec<Step>,
    pub rule_id: Option<String>,
    pub sla_check_at: Option<i64>,
}

/// Why routing stopped.
#[derive(Debug)]
pub struct RoutingError(pub String);

impl std::fmt::Display for RoutingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<DbErr> for RoutingError {
    fn from(error: DbErr) -> Self {
        Self(error.to_string())
    }
}

impl From<AppendError> for RoutingError {
    fn from(error: AppendError) -> Self {
        Self(error.to_string())
    }
}

impl From<UpdateError> for RoutingError {
    fn from(error: UpdateError) -> Self {
        match error {
            UpdateError::NotFound => Self("conversation not found".to_owned()),
            UpdateError::Rejected { message, .. } | UpdateError::Failed(message) => Self(message),
        }
    }
}

/// What the triggering write set itself.
#[derive(Debug, Clone, Copy, Default)]
pub struct Keep {
    pub team: bool,
    pub assignee: bool,
}

/// `DeskRoutingChange`: what the `attributes_changed` edit behind a `changed`
/// trigger did. The rule that applied last isn't applied again, and a tag the
/// edit removed is never put back.
#[derive(Debug, Clone, Default)]
pub struct Change {
    /// Tags the edit removed (any case).
    pub removed_tags: Vec<String>,
}

/// `lastRoutingRuleId(db, conversationId)`: the rule that last applied on
/// the conversation (its latest `routingRuleId` on the timeline).
async fn last_routing_rule_id(db: &PgPool, conversation_id: &str) -> Result<Option<String>, DbErr> {
    use desk_messages::Column;
    let metadata = || Expr::col(Column::Metadata);
    let row: Option<Option<String>> = desk_messages::Entity::find()
        .select_only()
        .column_as(
            pg::PgExpr::cast_json_field(metadata(), "routingRuleId"),
            "rule_id",
        )
        .filter(Column::ConversationId.eq(conversation_id))
        // `metadata ? 'routingRuleId'`.
        .filter(sea_orm::ExprTrait::is_not_null(pg::PgExpr::get_json_field(
            metadata(),
            "routingRuleId",
        )))
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.flatten())
}

fn earliest(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    [a, b].into_iter().flatten().min()
}

async fn usable_team(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    use helpdesk_departments::Column;
    let row: Option<String> = helpdesk_departments::Entity::find_by_id(id)
        .select_only()
        .column(Column::Id)
        .filter(Column::DeletedAt.is_null())
        .filter(Column::IsActive.eq(true))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.is_some())
}

async fn usable_assignee(db: &PgPool, user_id: &str) -> Result<bool, DbErr> {
    use workspace_members::Column;
    let row: Option<String> = workspace_members::Entity::find()
        .select_only()
        .column(Column::UserId)
        .filter(Column::UserId.eq(user_id))
        .filter(Column::DeletedAt.is_null())
        .filter(crate::upper_is(Column::Status, "ACTIVE"))
        .filter(crate::upper_is(Column::MemberType, "INTERNAL"))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.is_some())
}

/// `routeDeskConversation(db, { conversationId, keepTeam, keepAssignee })`:
/// apply the first matching rule. Writes nothing when no rule matches or
/// it changes nothing; a team that is gone or inactive, or a teammate who
/// left, skips that action.
pub async fn route(db: &PgPool, conversation_id: &str, keep: Keep) -> Result<Routed, RoutingError> {
    route_with(db, conversation_id, keep, None).await
}

/// [`route`] for the `changed` trigger: `change` is what the edit did.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub async fn route_with(
    db: &PgPool,
    conversation_id: &str,
    keep: Keep,
    change: Option<&Change>,
) -> Result<Routed, RoutingError> {
    let Some((current, _)) = webchat::get(db, conversation_id, false).await? else {
        return Err(RoutingError(format!(
            "Desk conversation '{conversation_id}' not found"
        )));
    };
    let unrouted = |conversation: Value| Routed {
        conversation,
        steps: Vec::new(),
        rule_id: None,
        sla_check_at: None,
    };
    let (_, rules) = settings(db).await?;
    let Some(rule) = select(&rules, &current) else {
        return Ok(unrouted(current));
    };
    // An edit re-routes only to a rule other than the one that placed the
    // conversation; re-running that one would undo the agent's own changes.
    if change.is_some()
        && last_routing_rule_id(db, conversation_id).await?.as_deref() == Some(rule.id.as_str())
    {
        return Ok(unrouted(current));
    }
    let removed: Vec<String> = change
        .map(|c| c.removed_tags.iter().map(|t| t.to_lowercase()).collect())
        .unwrap_or_default();
    let added: Vec<String> = rule
        .add_tags
        .iter()
        .filter(|tag| !removed.contains(&tag.to_lowercase()))
        .cloned()
        .collect();

    let mut steps = Vec::new();
    let mut sla_check_at = None;
    let mut conversation = current.clone();

    let mut input = Update::default();
    let mut changed = false;
    if let Some(team) = &rule.department_id
        && !keep.team
        && current["departmentId"].as_str() != Some(team.as_str())
        && usable_team(db, team).await?
    {
        input.department_id = Field::Set(team.clone());
        changed = true;
    }
    if let Some(priority) = &rule.priority
        && current["priority"].as_str() != Some(priority.as_str())
    {
        input.priority = Field::Set(priority.clone());
        changed = true;
    }
    if !added.is_empty() {
        let before: Vec<String> = current["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let mut all = before.clone();
        all.extend(added.iter().cloned());
        let tags = normalize_tags(&all);
        if tags != before {
            input.tags = Some(tags);
            changed = true;
        }
    }
    if changed {
        let mut extra = Map::new();
        extra.insert("routingRuleId".to_owned(), json!(rule.id));
        let set = attributes::update_with_metadata(
            db,
            conversation_id,
            "system",
            None,
            &input,
            Some(extra),
        )
        .await?;
        conversation = set.conversation;
        sla_check_at = earliest(sla_check_at, set.sla_check_at);
        if let Some(message) = set.message {
            steps.push(Step {
                conversation: conversation.clone(),
                message,
                action: "updated",
            });
        }
    }

    let owned = conversation["assigneeId"]
        .as_str()
        .is_some_and(|a| !a.is_empty());
    if let Some(assignee) = &rule.assignee_id
        && !keep.assignee
        && conversation["state"] == "open"
        && !owned
        && usable_assignee(db, assignee).await?
    {
        let claimed = desk_conversations::Entity::update_many()
            .col_expr(
                desk_conversations::Column::AssigneeId,
                Expr::value(assignee.clone()),
            )
            .col_expr(
                desk_conversations::Column::UpdatedAt,
                Expr::value(utc_now()),
            )
            .filter(desk_conversations::Column::Id.eq(conversation_id))
            .filter(desk_conversations::Column::AssigneeId.is_null())
            .exec(&orm(db))
            .await?;
        if claimed.rows_affected > 0 {
            let mut metadata = Map::new();
            metadata.insert("eventType".to_owned(), json!("assigned"));
            metadata.insert("assigneeId".to_owned(), json!(assignee));
            metadata.insert("routingRuleId".to_owned(), json!(rule.id));
            let assigned = webchat::append(
                db,
                Append {
                    conversation_id,
                    kind: "event",
                    author_type: "system",
                    author_id: None,
                    body: None,
                    attachments: None,
                    metadata: Some(metadata),
                    assignee_id: Some(Some(assignee.clone())),
                },
            )
            .await?;
            sla_check_at = earliest(sla_check_at, assigned.sla_check_at);
            let (next, message) = assigned.pair();
            conversation = next;
            steps.push(Step {
                conversation: conversation.clone(),
                message,
                action: "assigned",
            });
        }
    }

    let rule_id = (!steps.is_empty()).then(|| rule.id.clone());
    Ok(Routed {
        conversation,
        steps,
        rule_id,
        sla_check_at,
    })
}

/// `DeskRoutingTrigger`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// A writer just opened the conversation.
    Opened,
    /// Its type or tags changed: auto-assignment runs only when a rule applied.
    Changed,
}

/// `routeAndAssignDeskConversation(db, { …, pick, trigger })`: route, then
/// auto-assign (team-aware) when nobody owns it.
pub async fn route_and_assign(
    db: &PgPool,
    conversation_id: &str,
    keep: Keep,
    trigger: Trigger,
    picker: &Picker<'_>,
) -> Result<Routed, RoutingError> {
    route_and_assign_with(db, conversation_id, keep, trigger, None, picker).await
}

/// [`route_and_assign`] with what the triggering edit did (the `changed` trigger).
pub async fn route_and_assign_with(
    db: &PgPool,
    conversation_id: &str,
    keep: Keep,
    trigger: Trigger,
    change: Option<&Change>,
    picker: &Picker<'_>,
) -> Result<Routed, RoutingError> {
    let mut routed = route_with(db, conversation_id, keep, change).await?;
    if keep.assignee || (trigger == Trigger::Changed && routed.steps.is_empty()) {
        return Ok(routed);
    }
    if let Some(assigned) = auto_assign_with(db, conversation_id, picker).await? {
        routed.sla_check_at = earliest(routed.sla_check_at, assigned.sla_check_at);
        let (conversation, message) = assigned.pair();
        routed.conversation = conversation.clone();
        routed.steps.push(Step {
            conversation,
            message,
            action: "assigned",
        });
    }
    Ok(routed)
}

/// `deskChangeReroutes(changes).change`: the tags an `attributes_changed`
/// event's tag change removed (compared in any case).
pub fn change_of(changes: &Value) -> Change {
    let tags = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    let tag_change = changes
        .as_array()
        .into_iter()
        .flatten()
        .find(|change| change["field"] == "tags");
    let Some(tag_change) = tag_change else {
        return Change::default();
    };
    let after: Vec<String> = tags(&tag_change["to"])
        .iter()
        .map(|t| t.to_lowercase())
        .collect();
    Change {
        removed_tags: tags(&tag_change["from"])
            .into_iter()
            .filter(|t| !after.contains(&t.to_lowercase()))
            .collect(),
    }
}

/// `deskChangeReroutes(changes)`: whether an `attributes_changed` event's
/// changes re-route (type or tags), and whether it set the team (kept).
pub fn change_reroutes(changes: &Value) -> (bool, bool) {
    let fields: Vec<&str> = changes
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|change| change["field"].as_str())
        .collect();
    (
        fields.contains(&"ticketType") || fields.contains(&"tags"),
        fields.contains(&"team"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_drops_bad_rules_and_empty_lists() {
        let rules = normalize(Some(&json!({ "rules": [
            { "id": "r1", "name": "VIP", "enabled": true,
              "conditions": { "tags": ["vip", "", "vip"], "channels": [] },
              "actions": { "departmentId": "dep_1", "priority": "loud", "addTags": ["x"] } },
            { "name": "no id" },
            { "id": "r1", "name": "repeat" },
            { "id": "r2", "conditions": null, "actions": { "assigneeId": "user_a" } },
        ] })));
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].conditions, vec![("tags", vec!["vip".to_owned()])]);
        assert_eq!(rules[0].priority, None);
        assert!(rules[1].enabled);
        assert_eq!(rules[1].name, "");
        assert_eq!(
            rules[0].json(),
            json!({ "id": "r1", "name": "VIP", "enabled": true,
                    "conditions": { "tags": ["vip"] },
                    "actions": { "departmentId": "dep_1", "addTags": ["x"] } })
        );
    }

    #[test]
    fn matching_needs_every_list_and_any_tag() {
        let rule = &normalize(Some(&json!({ "rules": [
            { "id": "r", "conditions": { "channels": ["email"], "tags": ["VIP", "refund"] }, "actions": {} },
        ] })))[0];
        let email_vip = json!({ "channel": "email", "tags": ["vip"], "priority": null });
        assert!(matches(rule, &email_vip));
        assert!(!matches(
            rule,
            &json!({ "channel": "messenger", "tags": ["vip"] })
        ));
        assert!(!matches(rule, &json!({ "channel": "email", "tags": [] })));
        let by_priority = &normalize(Some(&json!({ "rules": [
            { "id": "p", "conditions": { "priorities": ["high"] }, "actions": {} },
        ] })))[0];
        assert!(!matches(by_priority, &email_vip));
        let any = &normalize(Some(&json!({ "rules": [{ "id": "a" }] })))[0];
        assert!(matches(any, &email_vip));
    }

    #[test]
    fn a_change_reroutes_on_type_or_tags_and_keeps_a_team_it_set() {
        assert_eq!(
            change_reroutes(&json!([{ "field": "tags" }])),
            (true, false)
        );
        assert_eq!(
            change_reroutes(&json!([{ "field": "ticketType" }, { "field": "team" }])),
            (true, true)
        );
        assert_eq!(
            change_reroutes(&json!([{ "field": "priority" }])),
            (false, false)
        );
        assert_eq!(change_reroutes(&Value::Null), (false, false));
    }
}
