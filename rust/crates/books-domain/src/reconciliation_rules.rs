//! Reconciliation rules (`accounting-reconciliation-rules`): "a line whose
//! description contains 'huur' goes to 4210 Huur". A rule has conditions on
//! the bank line (all or any must hold) and a category account to post the
//! line to.
//!
//! Text conditions compare case-insensitively and ignore surrounding spaces;
//! amount conditions compare the absolute amount, so a rule reads the same
//! for money in and money out. Rules are tried highest priority first, and
//! the first one that matches wins. Rows are `Value`s as Drizzle returns
//! them (`RECONCILIATION_RULES.js(row)`).

use serde_json::Value;
use sqlx::PgPool;

use crate::document_posting::text;
use crate::http::now;
use crate::js::{number_text, parse_float};
use crate::jurisdictions::{is_js_space, js_trim};
use crate::tables::RECONCILIATION_RULES;

fn conditions(rule: &Value) -> &[Value] {
    rule.get("conditions")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `rule.actions?.<key>` as text.
pub fn action<'a>(rule: &'a Value, key: &str) -> Option<&'a str> {
    rule.get("actions")
        .and_then(|a| a.get(key))
        .and_then(Value::as_str)
}

/// `loadActiveRules(db, entityId)`: the entity's active rules, highest
/// priority first, that can post a line (they name a category account and
/// have a condition).
pub async fn load_active_rules(db: &PgPool, entity_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(reconciliation_rules),
        " from reconciliation_rules t where t.entity_id = $1 and t.is_active = true \
         and t.deleted_at is null order by t.priority desc, t.created_at"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(RECONCILIATION_RULES
        .js_rows(rows)
        .into_iter()
        .filter(|rule| {
            action(rule, "categoryAccountId").is_some_and(|a| !a.is_empty())
                && !conditions(rule).is_empty()
        })
        .collect())
}

/// `loadActiveRule(db, ruleId, entityId)`: one active rule of the entity (a
/// rule suggestion picked by hand names it by id).
pub async fn load_active_rule(
    db: &PgPool,
    rule_id: &str,
    entity_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(reconciliation_rules),
        " from reconciliation_rules t where t.id = $1 and t.entity_id = $2 and t.is_active = true \
         and t.deleted_at is null limit 1"
    ))
    .bind(rule_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| RECONCILIATION_RULES.js(row)))
}

/// `recordRuleMatch(db, ruleId)`: count a rule's use (`matchCount` and
/// `lastMatchedAt` show on the Rules page).
pub async fn record_rule_match(db: &PgPool, rule_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update reconciliation_rules set match_count = coalesce(match_count, 0) + 1, \
         last_matched_at = $2::timestamp where id = $1",
    )
    .bind(rule_id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// `.replaceAll(/\s/g, '')`.
fn without_spaces(value: &str) -> String {
    value.chars().filter(|c| !is_js_space(*c)).collect()
}

/// `fieldText(txn, field)`: the line's text a condition reads.
fn field_text(txn: &Value, field: &str) -> String {
    let value = |key: &str| text(txn, key).unwrap_or_default();
    match field {
        "description" | "counterpartyName" | "reference" => value(field).to_owned(),
        // An IBAN reads the same with or without its spaces.
        "counterpartyIban" => without_spaces(value("counterpartyIban")),
        _ => String::new(),
    }
}

/// `String(value ?? '')`.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number_text(number.as_f64().unwrap_or(f64::NAN)),
        Some(other) => other.to_string(),
    }
}

/// `toNumber(value)`: a number as is, else `parseFloat` with a decimal
/// comma read as a point.
fn to_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        other => parse_float(&js_string(other).replacen(',', ".", 1)),
    }
}

/// `conditionMatches(txn, cond)`: whether one condition holds for a bank
/// line.
pub fn condition_matches(txn: &Value, condition: &Value) -> bool {
    let field = text(condition, "field").unwrap_or_default();
    let operator = text(condition, "operator").unwrap_or_default();
    if field == "amount" {
        let amount =
            parse_float(text(txn, "amount").filter(|a| !a.is_empty()).unwrap_or("0")).abs();
        let value = to_number(condition.get("value"));
        if !amount.is_finite() || !value.is_finite() {
            return false;
        }
        return match operator {
            "equals" => (amount - value).abs() < 0.005,
            "greater_than" => amount > value,
            "less_than" => amount < value,
            "between" => {
                let upper = to_number(condition.get("value2"));
                upper.is_finite() && amount >= value.min(upper) && amount <= value.max(upper)
            }
            _ => false,
        };
    }
    let needle = js_trim(&js_string(condition.get("value"))).to_lowercase();
    let needle = if field == "counterpartyIban" {
        without_spaces(&needle)
    } else {
        needle
    };
    if needle.is_empty() {
        return false;
    }
    let haystack = js_trim(&field_text(txn, field)).to_lowercase();
    match operator {
        "contains" => haystack.contains(&needle),
        "equals" => haystack == needle,
        "starts_with" => haystack.starts_with(&needle),
        "ends_with" => haystack.ends_with(&needle),
        _ => false,
    }
}

/// `ruleMatches(txn, rule)`: every condition (`all`, the default) or at
/// least one (`any`); a rule without conditions never matches.
pub fn rule_matches(txn: &Value, rule: &Value) -> bool {
    let conditions = conditions(rule);
    if conditions.is_empty() {
        return false;
    }
    if text(rule, "matchMode") == Some("any") {
        conditions.iter().any(|c| condition_matches(txn, c))
    } else {
        conditions.iter().all(|c| condition_matches(txn, c))
    }
}

/// `findMatchingRule(txn, rules)`: the first rule (they come highest
/// priority first) that matches the line.
pub fn find_matching_rule<'a>(txn: &Value, rules: &'a [Value]) -> Option<&'a Value> {
    rules.iter().find(|rule| rule_matches(txn, rule))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn line() -> Value {
        json!({
            "id": "bt_1",
            "amount": "-1200.00",
            "counterpartyIban": "NL91 ABNA 0417 1643 00",
            "counterpartyName": "Vastgoed BV",
            "reference": "RF18 5390 0754 7034",
            "description": "Huur kantoor oktober",
            "endToEndId": null,
        })
    }

    fn rule(id: &str, conditions: &Value, mode: &str) -> Value {
        json!({
            "id": id,
            "matchMode": mode,
            "conditions": conditions,
            "actions": { "categoryAccountId": "acc_rent" },
        })
    }

    fn holds(field: &str, operator: &str, value: &Value) -> bool {
        let condition = json!({ "field": field, "operator": operator, "value": value });
        condition_matches(&line(), &condition)
    }

    #[test]
    fn text_conditions_ignore_case_and_spaces() {
        for (field, operator, value, expected) in [
            ("description", "contains", "huur", true),
            ("description", "contains", "HUUR", true),
            ("description", "contains", "energie", false),
            ("counterpartyName", "equals", " vastgoed bv ", true),
            ("description", "starts_with", "huur", true),
            ("description", "ends_with", "Oktober", true),
            ("counterpartyIban", "equals", "nl91abna0417164300", true),
            ("description", "contains", "  ", false),
        ] {
            assert_eq!(
                holds(field, operator, &json!(value)),
                expected,
                "{operator} {value}"
            );
        }
    }

    #[test]
    fn amount_conditions_read_the_absolute_amount() {
        assert!(holds("amount", "equals", &json!(1200)));
        assert!(holds("amount", "greater_than", &json!("1000")));
        assert!(!holds("amount", "less_than", &json!(1000)));
        let between = |value2: Value| {
            let condition = json!({ "field": "amount", "operator": "between", "value": 1500, "value2": value2 });
            condition_matches(&line(), &condition)
        };
        assert!(between(json!(1000)));
        assert!(!between(Value::Null));
    }

    #[test]
    fn rules_match_all_or_any_and_the_first_wins() {
        let conditions = json!([
            { "field": "description", "operator": "contains", "value": "huur" },
            { "field": "amount", "operator": "less_than", "value": 100 },
        ]);
        assert!(!rule_matches(&line(), &rule("rr_1", &conditions, "all")));
        assert!(rule_matches(&line(), &rule("rr_1", &conditions, "any")));
        assert!(!rule_matches(&line(), &rule("rr_1", &json!([]), "all")));

        let rules = [
            rule(
                "rr_energy",
                &json!([{ "field": "description", "operator": "contains", "value": "energie" }]),
                "all",
            ),
            rule(
                "rr_rent",
                &json!([{ "field": "description", "operator": "contains", "value": "huur" }]),
                "all",
            ),
            rule(
                "rr_any",
                &json!([{ "field": "amount", "operator": "greater_than", "value": 0 }]),
                "all",
            ),
        ];
        assert_eq!(
            find_matching_rule(&line(), &rules).and_then(|r| text(r, "id")),
            Some("rr_rent")
        );
        let mut other = line();
        other["description"] = json!("Iets anders");
        assert_eq!(
            find_matching_rule(&other, &rules).and_then(|r| text(r, "id")),
            Some("rr_any")
        );
    }
}
