//! Mail rules on an inbound message: `inboundRuleMatches`,
//! `evalRuleCondition` and `applyRuleActions`
//! (`@weldsuite/mail-domain/store/model`), the worker's `applyMailRules`
//! and `finalizeOpFromStates`, and the Postgres store's `inbound.finalize`.

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_mail_domain::labels::{add_labels, remove_labels};

use crate::parsed::{EmailAddress, ParsedEmail};

/// `RuleMessageState`.
#[allow(clippy::struct_excessive_bools)] // the TypeScript state's flags
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleState {
    pub labels: Vec<String>,
    pub is_read: bool,
    pub is_flagged: bool,
    pub is_spam: bool,
    pub deleted: bool,
}

/// The message view every rule matches against.
struct MatchMessage<'a> {
    from: &'a EmailAddress,
    to: &'a [EmailAddress],
    cc: &'a [EmailAddress],
    subject: &'a str,
    text_body: Option<&'a str>,
    html_body: Option<&'a str>,
    has_attachments: bool,
    is_spam: bool,
    labels: &'a [String],
}

/// A condition's field value, as JavaScript holds it.
enum Field {
    Text(String),
    Bool(bool),
    Number(f64),
}

/// A rule condition's value threw in TypeScript (`v.toLowerCase()` on a
/// value that is not a string); the whole rule run is abandoned then.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuleError;

/// `Number(x)` of a string.
fn js_number(text: &str) -> f64 {
    let t = crate::mime::js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let lower = t.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix)
                .ok()
                .map_or(f64::NAN, |n| {
                    #[allow(clippy::cast_precision_loss)] // as JavaScript's numbers are
                    let n = n as f64;
                    n
                });
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !valid {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// The condition's value: `Array.isArray(c.value) ? c.value.join(',') : c.value`.
enum CondValue {
    Text(String),
    Other(Value),
}

fn cond_value(value: &Value) -> CondValue {
    match value {
        Value::String(s) => CondValue::Text(s.clone()),
        Value::Array(items) => CondValue::Text(
            items
                .iter()
                .map(|item| match item {
                    Value::Null => String::new(),
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
        ),
        other => CondValue::Other(other.clone()),
    }
}

impl CondValue {
    fn lower(&self) -> Result<String, RuleError> {
        match self {
            Self::Text(s) => Ok(s.to_lowercase()),
            Self::Other(_) => Err(RuleError),
        }
    }

    /// `String(fieldValue) === v`.
    fn equals_text(&self, text: &str) -> bool {
        matches!(self, Self::Text(s) if s == text)
    }

    fn number(&self) -> f64 {
        match self {
            Self::Text(s) => js_number(s),
            Self::Other(Value::Null) => 0.0,
            Self::Other(Value::Bool(b)) => f64::from(u8::from(*b)),
            Self::Other(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            Self::Other(_) => f64::NAN,
        }
    }
}

/// `evalRuleCondition(message, condition)`.
fn eval_condition(message: &MatchMessage<'_>, condition: &Value) -> Result<bool, RuleError> {
    let join = |list: &[EmailAddress]| {
        list.iter()
            .map(|a| a.email.clone())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let field = match condition["field"].as_str().unwrap_or_default() {
        "from" => Field::Text(message.from.email.clone()),
        "to" => Field::Text(join(message.to)),
        "cc" => Field::Text(join(message.cc)),
        "subject" => Field::Text(message.subject.to_owned()),
        "body" => Field::Text(
            message
                .text_body
                .filter(|t| !t.is_empty())
                .or(message.html_body.filter(|h| !h.is_empty()))
                .unwrap_or_default()
                .to_owned(),
        ),
        "has_attachment" => Field::Bool(message.has_attachments),
        "size" => Field::Number(0.0),
        "is_spam" => Field::Bool(message.is_spam),
        "priority" => Field::Text("normal".to_owned()),
        _ => return Ok(false),
    };
    let v = cond_value(&condition["value"]);
    let as_string = |field: &Field| match field {
        Field::Text(s) => s.clone(),
        Field::Bool(b) => b.to_string(),
        Field::Number(n) => {
            if n.fract() == 0.0 {
                format!("{n:.0}")
            } else {
                n.to_string()
            }
        }
    };
    let as_number = |field: &Field| match field {
        Field::Text(s) => js_number(s),
        Field::Bool(b) => f64::from(u8::from(*b)),
        Field::Number(n) => *n,
    };
    Ok(match condition["operator"].as_str().unwrap_or_default() {
        "contains" => match &field {
            Field::Text(s) => s.to_lowercase().contains(&v.lower()?),
            _ => false,
        },
        "not_contains" => match &field {
            Field::Text(s) => !s.to_lowercase().contains(&v.lower()?),
            _ => false,
        },
        "equals" => match &field {
            Field::Text(s) => s.to_lowercase() == v.lower()?,
            other => v.equals_text(&as_string(other)),
        },
        "not_equals" => match &field {
            Field::Text(s) => s.to_lowercase() != v.lower()?,
            other => !v.equals_text(&as_string(other)),
        },
        "starts_with" => match &field {
            Field::Text(s) => s.to_lowercase().starts_with(&v.lower()?),
            _ => false,
        },
        "ends_with" => match &field {
            Field::Text(s) => s.to_lowercase().ends_with(&v.lower()?),
            _ => false,
        },
        "greater_than" => {
            let (a, b) = (as_number(&field), v.number());
            !a.is_nan() && !b.is_nan() && a > b
        }
        "less_than" => {
            let (a, b) = (as_number(&field), v.number());
            !a.is_nan() && !b.is_nan() && a < b
        }
        "is_true" => {
            matches!(&field, Field::Bool(true)) || matches!(&field, Field::Text(s) if s == "true")
        }
        "is_false" => {
            matches!(&field, Field::Bool(false)) || matches!(&field, Field::Text(s) if s == "false")
        }
        _ => false,
    })
}

/// `inboundRuleMatches(rule, message)`.
fn rule_matches(rule: &Value, message: &MatchMessage<'_>) -> Result<bool, RuleError> {
    if rule["scope"].as_str() == Some("outgoing") {
        return Ok(false);
    }
    if let Some(folders) = rule["folders"].as_array().filter(|f| !f.is_empty())
        && !folders.iter().any(|f| {
            f.as_str()
                .is_some_and(|f| message.labels.iter().any(|l| l == f))
        })
    {
        return Ok(false);
    }
    let conditions = rule["conditions"].as_array().cloned().unwrap_or_default();
    if conditions.is_empty() {
        return Ok(false);
    }
    let all = rule["matchType"].as_str().unwrap_or("all") == "all" || rule["matchType"].is_null();
    if all {
        for condition in &conditions {
            if !eval_condition(message, condition)? {
                return Ok(false);
            }
        }
        Ok(true)
    } else {
        for condition in &conditions {
            if eval_condition(message, condition)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// `applyRuleAction(state, action)`: the next state, and whether the action
/// applied.
fn apply_action(state: &RuleState, action: &Value) -> (RuleState, bool) {
    let kind = action["type"].as_str().unwrap_or_default();
    let label = action["labelId"].as_str().filter(|l| !l.is_empty());
    let mut next = state.clone();
    match kind {
        "mark_as_spam" => {
            next.labels
                .retain(|l| !matches!(l.as_str(), "INBOX" | "ARCHIVE" | "PROMOTIONS"));
            if !next.labels.iter().any(|l| l == "SPAM") {
                next.labels.push("SPAM".to_owned());
            }
            dedupe(&mut next.labels);
            next.is_spam = true;
            return (next, true);
        }
        "delete" => next.deleted = true,
        "mark_as_read" => next.is_read = true,
        "mark_as_unread" => next.is_read = false,
        "flag" => next.is_flagged = true,
        "move_to_folder" | "archive" => {
            let target = if kind == "archive" {
                "ARCHIVE"
            } else {
                match label {
                    Some(label) => label,
                    None => return (next, false),
                }
            };
            next.labels.retain(|l| l != "INBOX");
            next.labels.push(target.to_owned());
            dedupe(&mut next.labels);
        }
        "star" => {
            if !next.labels.iter().any(|l| l == "STARRED") {
                next.labels.push("STARRED".to_owned());
            }
        }
        "add_label" => {
            let Some(label) = label else {
                return (next, false);
            };
            if !next.labels.iter().any(|l| l == label) {
                next.labels.push(label.to_owned());
            }
        }
        "remove_label" => {
            let Some(label) = label else {
                return (next, false);
            };
            next.labels.retain(|l| l != label);
        }
        _ => return (next, false),
    }
    (next, true)
}

/// `[...new Set(list)]`.
fn dedupe(list: &mut Vec<String>) {
    let mut seen: Vec<String> = Vec::with_capacity(list.len());
    list.retain(|l| {
        if seen.contains(l) {
            false
        } else {
            seen.push(l.clone());
            true
        }
    });
}

/// What a rule run did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesOutcome {
    pub state: RuleState,
    pub marked_spam: bool,
}

/// The rules' fold without the database: the outcome (or the error
/// TypeScript would throw), and the rules that applied, in order, until then.
pub fn fold_rules(
    rules: &[Value],
    email: &ParsedEmail,
    state: &RuleState,
) -> (Result<RulesOutcome, RuleError>, Vec<String>) {
    let message = MatchMessage {
        from: &email.from,
        to: &email.to,
        cc: &email.cc,
        subject: &email.subject,
        text_body: email.text_body.as_deref(),
        html_body: email.html_body.as_deref(),
        has_attachments: email.has_attachments,
        is_spam: state.is_spam,
        labels: &state.labels,
    };
    let mut next = state.clone();
    let mut marked_spam = false;
    let mut applied_rules = Vec::new();
    for rule in rules {
        match rule_matches(rule, &message) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => return (Err(error), applied_rules),
        }
        let actions = rule["actions"].as_array().cloned().unwrap_or_default();
        let mut applied = 0;
        for action in &actions {
            let (after, did) = apply_action(&next, action);
            next = after;
            if did {
                applied += 1;
                if action["type"] == "mark_as_spam" {
                    marked_spam = true;
                }
            }
        }
        if applied == 0 {
            continue;
        }
        applied_rules.push(rule["id"].as_str().unwrap_or_default().to_owned());
        if rule["stopProcessing"] == Value::Bool(true) {
            break;
        }
    }
    (
        Ok(RulesOutcome {
            state: next,
            marked_spam,
        }),
        applied_rules,
    )
}

/// `applyMailRules(db, rules, email, messageId, state)`: every rule matched
/// against the message as it was when the run began, the actions of each
/// matching one folded into the state, and each applied rule's stats
/// bumped. A condition TypeScript would throw on abandons the run (the
/// stats bumped before it stay).
pub async fn apply_mail_rules(
    db: &PgPool,
    rules: &[Value],
    email: &ParsedEmail,
    message_id: &str,
    state: &RuleState,
) -> Result<Result<RulesOutcome, RuleError>, sqlx::Error> {
    let (outcome, applied) = fold_rules(rules, email, state);
    for id in applied {
        let now = weldsuite_mail_domain::outbound::clock::iso(
            weldsuite_mail_domain::outbound::clock::now_ms(),
        );
        sqlx::query(
            "update mail_rules set applied_count = applied_count + 1,
                    last_applied_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(db)
        .await?;
        tracing::info!(rule = %id, message_id, "[Rules] Applied rule");
    }
    Ok(outcome)
}

/// `finalizeOpFromStates(messageId, initialState, state)` applied by the
/// Postgres store (`applyInboundFinalize`): a delta onto the row as it is
/// now, written only when something changed.
pub async fn finalize_inbound(
    db: &PgPool,
    account_id: &str,
    message_id: &str,
    initial: &RuleState,
    state: &RuleState,
) -> Result<(), sqlx::Error> {
    let add: Vec<String> = state
        .labels
        .iter()
        .filter(|l| !initial.labels.contains(l))
        .cloned()
        .collect();
    let remove: Vec<String> = initial
        .labels
        .iter()
        .filter(|l| !state.labels.contains(l))
        .cloned()
        .collect();
    let is_read = (state.is_read != initial.is_read).then_some(state.is_read);
    let is_flagged = (state.is_flagged != initial.is_flagged).then_some(state.is_flagged);
    let is_spam = (state.is_spam != initial.is_spam).then_some(state.is_spam);
    let deleted = state.deleted && state.deleted != initial.deleted;
    if add.is_empty()
        && remove.is_empty()
        && is_read.is_none()
        && is_flagged.is_none()
        && is_spam.is_none()
        && !deleted
    {
        return Ok(());
    }
    let existing: Option<Option<Value>> = sqlx::query_scalar(
        "select labels from mail_messages where id = $1 and account_id = $2 limit 1",
    )
    .bind(message_id)
    .bind(account_id)
    .fetch_optional(db)
    .await?;
    let Some(existing) = existing else {
        return Ok(());
    };
    let labels = if add.is_empty() && remove.is_empty() {
        None
    } else {
        let current = weldsuite_mail_domain::labels::labels_of(existing.as_ref());
        Some(remove_labels(&add_labels(&current, &add), &remove))
    };
    let now = weldsuite_mail_domain::outbound::clock::iso(
        weldsuite_mail_domain::outbound::clock::now_ms(),
    );
    sqlx::query(
        "update mail_messages set
            labels = case when $3 then $4::jsonb else labels end,
            is_trash = case when $3 then $5 else is_trash end,
            is_read = coalesce($6, is_read),
            is_flagged = coalesce($7, is_flagged),
            is_spam = coalesce($8, is_spam),
            deleted_at = case when $9 then $10::timestamp else deleted_at end,
            updated_at = $10::timestamp
         where id = $1 and account_id = $2",
    )
    .bind(message_id)
    .bind(account_id)
    .bind(labels.is_some())
    .bind(Value::from(labels.clone().unwrap_or_default()))
    .bind(
        labels
            .as_ref()
            .is_some_and(|l| l.iter().any(|l| l == "TRASH")),
    )
    .bind(is_read)
    .bind(is_flagged)
    .bind(is_spam)
    .bind(deleted)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn state() -> RuleState {
        RuleState {
            labels: vec!["INBOX".to_owned()],
            is_read: false,
            is_flagged: false,
            is_spam: false,
            deleted: false,
        }
    }

    #[test]
    fn actions() {
        let (next, applied) = apply_action(&state(), &json!({ "type": "mark_as_spam" }));
        assert!(applied);
        assert_eq!(next.labels, ["SPAM"]);
        assert!(next.is_spam);
        let (next, applied) = apply_action(&state(), &json!({ "type": "add_label" }));
        assert!(!applied);
        assert_eq!(next, state());
        let (next, _) = apply_action(
            &state(),
            &json!({ "type": "move_to_folder", "labelId": "Work" }),
        );
        assert_eq!(next.labels, ["Work"]);
    }

    #[test]
    fn numbers_as_javascript_reads_them() {
        assert!((js_number(" 12 ") - 12.0).abs() < f64::EPSILON);
        assert!(js_number("abc").is_nan());
        assert!((js_number("0x10") - 16.0).abs() < f64::EPSILON);
        assert!(js_number("inf").is_nan());
    }
}
