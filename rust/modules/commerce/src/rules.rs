//! Automated categories: membership rules evaluated on read (ADR COM-010,
//! re-adopting COM-001 and COM-002).
//!
//! A rule is `{ column, relation, condition }`. `column` names a product
//! field from a server-side whitelist ([`RULE_COLUMNS`]), never an
//! identifier that reaches SQL, and `condition` is only ever a bound
//! parameter. A write is refused unless every rule fits its column (a known
//! column, a relation its kind has, a number where the column is numeric).
//! A stored rule is re-checked at use: one that no longer fits (an unknown
//! column or relation, a numeric rule whose condition is not a number)
//! becomes a false predicate, so a stale rule shrinks a category, never
//! widens it. No rules at all match nothing, never the whole catalogue.
//!
//! sqlx takes literal SQL only, so the rule set is one bound `jsonb`
//! ([`rules_param`]) and a `CASE` per rule picks its predicate
//! ([`rules_match!`]). Each rule carries its column, relation, condition,
//! the escaped LIKE literal and, for the numeric columns, the condition as a
//! number (null when it is not one, which matches nothing).

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Presence, Text, js_number, js_trim};

/// How a rule column compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ColumnKind {
    Text,
    Number,
    /// `products.tags`, a jsonb array of strings: a rule matches when one
    /// tag does.
    Tags,
}

/// The columns a rule may name, with their kind.
pub(crate) const RULE_COLUMNS: &[(&str, ColumnKind)] = &[
    ("name", ColumnKind::Text),
    ("productType", ColumnKind::Text),
    ("vendor", ColumnKind::Text),
    ("brand", ColumnKind::Text),
    ("sku", ColumnKind::Text),
    ("status", ColumnKind::Text),
    ("tag", ColumnKind::Tags),
    ("price", ColumnKind::Number),
    ("compareAtPrice", ColumnKind::Number),
    ("weight", ColumnKind::Number),
    ("inventoryQuantity", ColumnKind::Number),
];

const TEXT_RELATIONS: &[&str] = &[
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
];
const NUMBER_RELATIONS: &[&str] = &["equals", "not_equals", "greater_than", "less_than"];

/// Every relation, for the enum check.
const RELATIONS: &[&str] = &[
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "greater_than",
    "less_than",
];

/// At most this many rules in a set.
pub(crate) const MAX_RULES: usize = 50;

fn column_kind(column: &str) -> Option<ColumnKind> {
    RULE_COLUMNS
        .iter()
        .find(|(name, _)| *name == column)
        .map(|(_, kind)| *kind)
}

fn relations_of(kind: ColumnKind) -> &'static [&'static str] {
    match kind {
        ColumnKind::Text | ColumnKind::Tags => TEXT_RELATIONS,
        ColumnKind::Number => NUMBER_RELATIONS,
    }
}

/// `Number(condition)` when it is a finite number.
fn finite_number(condition: &str) -> Option<f64> {
    // `Number('')` is 0; an empty condition is no number here.
    if js_trim(condition).is_empty() {
        return None;
    }
    Some(js_number(condition)).filter(|n| n.is_finite())
}

/// The rules at `key`: an array of `{ column, relation, condition }`
/// (stripped of other keys), `min` to [`MAX_RULES`] long, each fitting its
/// column. The rules as stored.
pub(crate) fn read_rules(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    presence: Presence,
    min: Option<usize>,
) -> Field<Vec<Value>> {
    let column_names: Vec<&str> = RULE_COLUMNS.iter().map(|(name, _)| *name).collect();
    issues.list(
        fields,
        "rules",
        presence,
        min,
        Some(MAX_RULES),
        |issues, item| {
            let rule = issues.object(item)?;
            let before = issues.count();
            let column = issues
                .choice(rule, "column", Presence::Required, &column_names)
                .into_option();
            let relation = issues
                .choice(rule, "relation", Presence::Required, RELATIONS)
                .into_option();
            let condition = issues
                .text_with(
                    rule,
                    "condition",
                    Presence::Required,
                    Text::trimmed(Some(1), Some(255)),
                )
                .into_option();
            if issues.count() > before {
                return None;
            }
            let (column, relation, condition) = (column?, relation?, condition?);
            let kind = column_kind(&column)?;
            if !relations_of(kind).contains(&relation.as_str()) {
                issues.custom(
                    "relation",
                    &format!(
                        "\"{relation}\" does not apply to {column}: use one of {}",
                        relations_of(kind).join(", ")
                    ),
                );
                return None;
            }
            if kind == ColumnKind::Number && finite_number(&condition).is_none() {
                issues.custom("condition", &format!("{column} is compared with a number"));
                return None;
            }
            Some(json!({ "column": column, "relation": relation, "condition": condition }))
        },
    )
}

/// Escape the LIKE wildcards so a condition containing `%` matches literally.
pub(crate) fn like_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A stored or posted rule set as the statements read it: per rule its
/// column, relation, condition, LIKE literal and number. Anything that is
/// not a rule object reads as one that matches nothing.
pub(crate) fn rules_param(rules: &[Value]) -> Value {
    Value::Array(
        rules
            .iter()
            .map(|rule| {
                let text = |key: &str| rule.get(key).and_then(Value::as_str);
                let column = text("column");
                let relation = text("relation");
                let condition = text("condition").unwrap_or_default();
                let fits = column
                    .and_then(column_kind)
                    .zip(relation)
                    .is_some_and(|(kind, relation)| relations_of(kind).contains(&relation));
                let number = finite_number(condition).map(|n| format!("{n}"));
                json!({
                    // A rule that no longer fits its column names none.
                    "column": if fits { column } else { None },
                    "relation": relation,
                    "condition": condition,
                    "esc": like_literal(condition),
                    "num": number,
                })
            })
            .collect(),
    )
}

/// A stored rule set (`categories.rules`, jsonb nothing constrains): the
/// array, or none.
pub(crate) fn stored_rules(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// One rule `r` against product `t` (`ruleToPredicate`): an unknown column
/// or relation, or a numeric rule without a number, is false.
macro_rules! rule_predicate {
    () => {
        "(case \
          when r->>'column' = 'tag' then (case r->>'relation' \
            when 'equals' then exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(t.tags) = 'array' then t.tags else '[]'::jsonb end) as tag_value where tag_value = r->>'condition') \
            when 'not_equals' then not exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(t.tags) = 'array' then t.tags else '[]'::jsonb end) as tag_value where tag_value = r->>'condition') \
            when 'contains' then exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(t.tags) = 'array' then t.tags else '[]'::jsonb end) as tag_value where tag_value ilike '%' || (r->>'esc') || '%') \
            when 'not_contains' then not exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(t.tags) = 'array' then t.tags else '[]'::jsonb end) as tag_value where tag_value ilike '%' || (r->>'esc') || '%') \
            when 'starts_with' then exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(t.tags) = 'array' then t.tags else '[]'::jsonb end) as tag_value where tag_value ilike (r->>'esc') || '%') \
            when 'ends_with' then exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(t.tags) = 'array' then t.tags else '[]'::jsonb end) as tag_value where tag_value ilike '%' || (r->>'esc')) \
            else false end) \
          when r->>'column' in ('price', 'compareAtPrice', 'weight', 'inventoryQuantity') then (case when r->>'num' is null then false else (case r->>'relation' \
            when 'equals' then coalesce((case r->>'column' when 'price' then t.price when 'compareAtPrice' then t.compare_at_price when 'weight' then t.weight else t.inventory_quantity::numeric end) = (r->>'num')::numeric, false) \
            when 'not_equals' then (case r->>'column' when 'price' then t.price when 'compareAtPrice' then t.compare_at_price when 'weight' then t.weight else t.inventory_quantity::numeric end) is distinct from (r->>'num')::numeric \
            when 'greater_than' then coalesce((case r->>'column' when 'price' then t.price when 'compareAtPrice' then t.compare_at_price when 'weight' then t.weight else t.inventory_quantity::numeric end) > (r->>'num')::numeric, false) \
            when 'less_than' then coalesce((case r->>'column' when 'price' then t.price when 'compareAtPrice' then t.compare_at_price when 'weight' then t.weight else t.inventory_quantity::numeric end) < (r->>'num')::numeric, false) \
            else false end) end) \
          when r->>'column' in ('name', 'productType', 'vendor', 'brand', 'sku', 'status') then (case r->>'relation' \
            when 'equals' then coalesce((case r->>'column' when 'name' then t.name when 'productType' then t.product_type when 'vendor' then t.vendor when 'brand' then t.brand when 'sku' then t.sku else t.status end) = r->>'condition', false) \
            when 'not_equals' then (case r->>'column' when 'name' then t.name when 'productType' then t.product_type when 'vendor' then t.vendor when 'brand' then t.brand when 'sku' then t.sku else t.status end) is distinct from r->>'condition' \
            when 'contains' then coalesce((case r->>'column' when 'name' then t.name when 'productType' then t.product_type when 'vendor' then t.vendor when 'brand' then t.brand when 'sku' then t.sku else t.status end) ilike '%' || (r->>'esc') || '%', false) \
            when 'not_contains' then coalesce((case r->>'column' when 'name' then t.name when 'productType' then t.product_type when 'vendor' then t.vendor when 'brand' then t.brand when 'sku' then t.sku else t.status end) not ilike '%' || (r->>'esc') || '%', true) \
            when 'starts_with' then coalesce((case r->>'column' when 'name' then t.name when 'productType' then t.product_type when 'vendor' then t.vendor when 'brand' then t.brand when 'sku' then t.sku else t.status end) ilike (r->>'esc') || '%', false) \
            when 'ends_with' then coalesce((case r->>'column' when 'name' then t.name when 'productType' then t.product_type when 'vendor' then t.vendor when 'brand' then t.brand when 'sku' then t.sku else t.status end) ilike '%' || (r->>'esc'), false) \
            else false end) \
          else false end)"
    };
}
pub(crate) use rule_predicate;

/// The rule set `$1` (from [`rules_param`]) against product `t`, `$2`
/// `'any'` or `'all'`. No rules match nothing.
macro_rules! rules_match {
    () => {
        concat!(
            "(jsonb_array_length($1::jsonb) > 0 and (case when $2::text = 'any' \
             then exists (select 1 from jsonb_array_elements($1::jsonb) r where ",
            $crate::rules::rule_predicate!(),
            ") else not exists (select 1 from jsonb_array_elements($1::jsonb) r where not ",
            $crate::rules::rule_predicate!(),
            ") end))"
        )
    };
}
pub(crate) use rules_match;

#[cfg(test)]
mod tests {
    use super::*;

    fn read(body: Value) -> (Option<Vec<Value>>, usize) {
        let Value::Object(fields) = body else {
            panic!("an object");
        };
        let mut issues = Issues::default();
        let rules = read_rules(&mut issues, &fields, Presence::Required, Some(1)).into_option();
        (rules, issues.count())
    }

    #[test]
    fn rules_must_fit_their_column() {
        let (rules, issues) = read(json!({ "rules": [
            { "column": "vendor", "relation": "equals", "condition": " Acme ", "extra": 1 },
            { "column": "price", "relation": "greater_than", "condition": "10.5" },
            { "column": "tag", "relation": "contains", "condition": "summer" },
        ] }));
        assert_eq!(issues, 0);
        assert_eq!(
            rules.expect("rules")[0],
            json!({ "column": "vendor", "relation": "equals", "condition": "Acme" })
        );
        // A relation the column's kind does not have, a number that is not one,
        // a column off the whitelist, none at all.
        for body in [
            json!({ "rules": [{ "column": "vendor", "relation": "greater_than", "condition": "1" }] }),
            json!({ "rules": [{ "column": "price", "relation": "contains", "condition": "1" }] }),
            json!({ "rules": [{ "column": "price", "relation": "equals", "condition": "cheap" }] }),
            json!({ "rules": [{ "column": "password", "relation": "equals", "condition": "x" }] }),
            json!({ "rules": [{ "column": "name", "relation": "equals", "condition": "  " }] }),
            json!({ "rules": [] }),
        ] {
            let (_, issues) = read(body.clone());
            assert!(issues >= 1, "{body}");
        }
    }

    #[test]
    fn stale_rules_name_no_column() {
        let param = rules_param(&[
            json!({ "column": "vendor", "relation": "equals", "condition": "50%_off" }),
            json!({ "column": "vendor", "relation": "greater_than", "condition": "1" }),
            json!({ "column": "dropped_column", "relation": "equals", "condition": "x" }),
            json!({ "column": "price", "relation": "less_than", "condition": "1e2" }),
            json!("not a rule"),
        ]);
        assert_eq!(param[0]["column"], "vendor");
        assert_eq!(param[0]["esc"], "50\\%\\_off");
        assert_eq!(param[1]["column"], Value::Null);
        assert_eq!(param[2]["column"], Value::Null);
        assert_eq!(param[3]["num"], "100");
        assert_eq!(param[4]["column"], Value::Null);
    }
}
