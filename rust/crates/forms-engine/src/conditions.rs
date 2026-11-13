//! Conditions and calculations over the answers on the path, the hidden
//! values and the variables (`conditions.ts`).
//!
//! Operand values: numeric fields a number; yes/no and legal a boolean;
//! choice fields the selected ids plus `other` when there is an Other text;
//! a ranking its ids; a matrix with `rowId` that row's column ids (without:
//! answered or not); a composite with `part` that part's text (without:
//! answered or not); text fields, dates, hidden values and text variables a
//! string; number variables a number; constants themselves (a list is a set
//! of ids). A field's answer is empty until its block is on the path.

use std::collections::{HashMap, HashSet};

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use super::answers::{AnswerValue, Answers, ChoiceAnswer};
use super::blocks::fields_of;
use super::definition::{
    Condition, ConditionGroup, ConditionItem, ConditionOperator, ConstantValue, Field, FieldKind,
    FormDefinition, GroupOp, Operand, Variable,
};
use super::display::display_value;
use super::js::{js_cmp, js_round, js_trim, number_text, ser_num};

/// A variable's value.
#[derive(Debug, Clone, PartialEq)]
pub enum VarValue {
    Number(f64),
    Text(String),
}

impl Serialize for VarValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Number(number) => ser_num(number, serializer),
            Self::Text(text) => serializer.serialize_str(text),
        }
    }
}

/// The variables by name, `score` first, then the declared ones in order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VariableValues(Vec<(String, VarValue)>);

impl VariableValues {
    pub fn get(&self, name: &str) -> Option<&VarValue> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }

    /// `map.set(name, value)`: replaces in place, else appends.
    pub fn set(&mut self, name: &str, value: VarValue) {
        match self.0.iter_mut().find(|(key, _)| key == name) {
            Some(entry) => entry.1 = value,
            None => self.0.push((name.to_owned(), value)),
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &VarValue)> {
        self.0.iter().map(|(key, value)| (key.as_str(), value))
    }

    /// `score`, a number (0 when it is missing).
    pub fn score(&self) -> f64 {
        match self.get("score") {
            Some(VarValue::Number(number)) => *number,
            _ => 0.0,
        }
    }

    /// The variables as a JSON object.
    pub fn to_json(&self) -> Map<String, Value> {
        self.iter()
            .map(|(name, value)| {
                (
                    name.to_owned(),
                    serde_json::to_value(value).unwrap_or(Value::Null),
                )
            })
            .collect()
    }
}

impl Serialize for VariableValues {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (name, value) in &self.0 {
            map.serialize_entry(name, value)?;
        }
        map.end()
    }
}

/// The state conditions are evaluated against.
#[derive(Debug, Clone)]
pub struct EvalContext<'a> {
    /// The first field with each id.
    pub fields: HashMap<&'a str, &'a Field>,
    /// Valid, normalised answers by field id.
    pub answers: &'a Answers,
    /// Field and block ids whose block is on the path so far.
    pub visible: HashSet<&'a str>,
    /// Declared hidden values, trimmed.
    pub hidden: HashMap<&'a str, String>,
    pub variables: VariableValues,
}

/// An operand's value.
#[derive(Debug, Clone, PartialEq)]
pub enum OperandValue {
    Empty,
    Num(f64),
    Bool(bool),
    Str(String),
    Set(Vec<String>),
    /// Answered, with nothing conditions can compare (a matrix without a row, files).
    Opaque,
}

/// Round to 10 decimals (half away from zero) to keep float noise out of
/// variables; `-0` becomes `0`; 1e15 and up, and non-finite values, as they are.
pub fn round_number(x: f64) -> f64 {
    if !x.is_finite() || x.abs() >= 1e15 {
        return x;
    }
    // `Math.sign(x) * Math.round(Math.abs(x) * 1e10) / 1e10`.
    let r = x.signum() * js_round(x.abs() * 1e10) / 1e10;
    if r == 0.0 { 0.0 } else { r }
}

/// A string holding a plain decimal number (`-12.5`, `^-?\d+(\.\d+)?$`
/// after trimming), as a number.
pub fn parse_numeric_text(text: &str) -> Option<f64> {
    let t = js_trim(text);
    let digits = t.strip_prefix('-').unwrap_or(t);
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(whole) || fraction.is_some_and(|f| !all_digits(f)) {
        return None;
    }
    t.parse::<f64>().ok()
}

/// `createEvalContext`: the fields, the declared hidden values (trimmed),
/// `score` and the declared variables with their initial values.
pub fn create_eval_context<'a>(
    def: &'a FormDefinition,
    answers: &'a Answers,
    hidden: Option<&Map<String, Value>>,
) -> EvalContext<'a> {
    let mut fields = HashMap::new();
    for field in fields_of(def) {
        fields.entry(field.id.as_str()).or_insert(field);
    }
    let mut hidden_values = HashMap::new();
    for declared in &def.hidden {
        if let Some(Value::String(value)) = hidden.and_then(|hidden| hidden.get(&declared.name)) {
            hidden_values.insert(declared.name.as_str(), js_trim(value).to_owned());
        }
    }
    let mut variables = VariableValues(vec![("score".to_owned(), VarValue::Number(0.0))]);
    for variable in &def.variables {
        if variables.get(variable.name()).is_some() {
            continue;
        }
        let value = match variable {
            Variable::Number { initial, .. } => VarValue::Number(round_number(*initial)),
            Variable::Text { initial, .. } => VarValue::Text(initial.clone()),
        };
        variables.set(variable.name(), value);
    }
    EvalContext {
        fields,
        answers,
        visible: HashSet::new(),
        hidden: hidden_values,
        variables,
    }
}

impl<'a> EvalContext<'a> {
    /// A field's answer, once its block is on the path.
    fn visible_answer(&self, id: &str) -> Option<(&'a Field, &'a AnswerValue)> {
        let field = *self.fields.get(id)?;
        if !self.visible.contains(id) {
            return None;
        }
        let answers: &'a Answers = self.answers;
        answers.get(id).map(|answer| (field, answer))
    }
}

/// The value of an operand.
pub fn resolve_operand(operand: &Operand, ctx: &EvalContext<'_>) -> OperandValue {
    match operand {
        Operand::Field { id, row_id, part } => {
            let Some((field, answer)) = ctx.visible_answer(id) else {
                return OperandValue::Empty;
            };
            field_value(field, answer, row_id.as_deref(), part.as_deref())
        }
        Operand::Hidden { name } => match ctx.hidden.get(name.as_str()) {
            Some(value) if !value.is_empty() => OperandValue::Str(value.clone()),
            _ => OperandValue::Empty,
        },
        Operand::Variable { name } => match ctx.variables.get(name) {
            None => OperandValue::Empty,
            Some(VarValue::Number(number)) => OperandValue::Num(*number),
            Some(VarValue::Text(text)) if text.is_empty() => OperandValue::Empty,
            Some(VarValue::Text(text)) => OperandValue::Str(text.clone()),
        },
        Operand::Constant { value } => match value {
            ConstantValue::Number(number) => OperandValue::Num(*number),
            ConstantValue::Bool(flag) => OperandValue::Bool(*flag),
            ConstantValue::Text(text) => OperandValue::Str(text.clone()),
            ConstantValue::List(ids) => OperandValue::Set(ids.clone()),
        },
    }
}

fn field_value(
    field: &Field,
    answer: &AnswerValue,
    row_id: Option<&str>,
    part: Option<&str>,
) -> OperandValue {
    match (&field.kind, answer) {
        (_, AnswerValue::Number(number)) if field.kind.is_numeric() => OperandValue::Num(*number),
        (_, AnswerValue::Bool(flag)) if field.kind.is_boolean() => OperandValue::Bool(*flag),
        (_, AnswerValue::Choice(choice)) if field.kind.is_choice() => {
            OperandValue::Set(choice.selected_with_other())
        }
        (FieldKind::Ranking(_), AnswerValue::Ranking(ids)) => OperandValue::Set(ids.clone()),
        (FieldKind::Matrix(_), _) => match row_id {
            None => OperandValue::Opaque,
            Some(row_id) => answer.row(row_id).map_or(OperandValue::Empty, |columns| {
                OperandValue::Set(columns.to_vec())
            }),
        },
        (FieldKind::ContactInfo(_) | FieldKind::Address(_), _) => match part {
            None => OperandValue::Opaque,
            Some(part) => answer.part(part).map_or(OperandValue::Empty, |text| {
                OperandValue::Str(text.to_owned())
            }),
        },
        (FieldKind::FileUpload(_) | FieldKind::Signature(_), _) => OperandValue::Opaque,
        (_, AnswerValue::Text(text)) => OperandValue::Str(text.clone()),
        // An answer of another field's shape: nothing to compare.
        _ => OperandValue::Opaque,
    }
}

fn norm(text: &str) -> String {
    js_trim(text).to_lowercase()
}

/// Ids on the right of a set comparison: one id or several.
fn ids_of(value: &OperandValue) -> Option<Vec<String>> {
    match value {
        OperandValue::Str(text) => Some(vec![js_trim(text).to_owned()]),
        OperandValue::Set(ids) => Some(ids.clone()),
        _ => None,
    }
}

/// `is`: `None` when the two values can't be compared.
#[allow(clippy::float_cmp)] // `===`
fn equals(left: &OperandValue, right: &OperandValue) -> Option<bool> {
    match (left, right) {
        (OperandValue::Set(selected), _) => {
            ids_of(right).map(|ids| ids.iter().any(|id| selected.contains(id)))
        }
        (OperandValue::Num(l), OperandValue::Num(r)) => Some(l == r),
        (OperandValue::Bool(l), OperandValue::Bool(r)) => Some(l == r),
        (OperandValue::Str(l), OperandValue::Str(r)) => Some(norm(l) == norm(r)),
        _ => None,
    }
}

/// Evaluates one condition. A condition on an empty value is false except `is_empty`.
pub fn evaluate_condition(condition: &Condition, ctx: &EvalContext<'_>) -> bool {
    use ConditionOperator as Op;
    let left = resolve_operand(&condition.left, ctx);
    match condition.operator {
        Op::IsEmpty => return left == OperandValue::Empty,
        Op::IsAnswered => return left != OperandValue::Empty,
        _ => {}
    }
    if left == OperandValue::Empty {
        return false;
    }
    let Some(right) = condition.right.as_ref() else {
        return false;
    };
    let right = resolve_operand(right, ctx);
    if right == OperandValue::Empty {
        return false;
    }

    match condition.operator {
        Op::Is => equals(&left, &right) == Some(true),
        Op::IsNot => equals(&left, &right) == Some(false),
        Op::Contains | Op::NotContains | Op::StartsWith | Op::EndsWith => {
            let (OperandValue::Str(l), OperandValue::Str(r)) = (&left, &right) else {
                return false;
            };
            let (l, r) = (norm(l), norm(r));
            match condition.operator {
                Op::Contains => l.contains(&r),
                Op::NotContains => !l.contains(&r),
                Op::StartsWith => l.starts_with(&r),
                _ => l.ends_with(&r),
            }
        }
        Op::GreaterThan | Op::GreaterOrEqual | Op::LessThan | Op::LessOrEqual => {
            let (OperandValue::Num(l), OperandValue::Num(r)) = (left, right) else {
                return false;
            };
            match condition.operator {
                Op::GreaterThan => l > r,
                Op::GreaterOrEqual => l >= r,
                Op::LessThan => l < r,
                _ => l <= r,
            }
        }
        Op::Before | Op::After => {
            let (OperandValue::Str(l), OperandValue::Str(r)) = (&left, &right) else {
                return false;
            };
            let order = js_cmp(js_trim(l), js_trim(r));
            if condition.operator == Op::Before {
                order.is_lt()
            } else {
                order.is_gt()
            }
        }
        Op::AnyOf | Op::AllOf | Op::NoneOf => {
            let OperandValue::Set(selected) = &left else {
                return false;
            };
            let Some(ids) = ids_of(&right) else {
                return false;
            };
            match condition.operator {
                Op::AnyOf => ids.iter().any(|id| selected.contains(id)),
                Op::AllOf => ids.iter().all(|id| selected.contains(id)),
                _ => !ids.iter().any(|id| selected.contains(id)),
            }
        }
        Op::IsAnswered | Op::IsEmpty => false,
    }
}

fn all_or_any(op: GroupOp, mut results: impl Iterator<Item = bool>) -> bool {
    match op {
        GroupOp::And => results.all(|result| result),
        GroupOp::Or => results.any(|result| result),
    }
}

/// Evaluates an AND/OR group (one level of nesting).
pub fn evaluate_group(group: &ConditionGroup, ctx: &EvalContext<'_>) -> bool {
    all_or_any(
        group.op,
        group.conditions.iter().map(|item| match item {
            ConditionItem::Condition(condition) => evaluate_condition(condition, ctx),
            ConditionItem::Group(nested) => all_or_any(
                nested.op,
                nested
                    .conditions
                    .iter()
                    .map(|condition| evaluate_condition(condition, ctx)),
            ),
        }),
    )
}

// ---------------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------------

/// Sum of the selected choices' scores (unscored choices and Other count 0).
pub fn selected_score(field: &Field, answer: &ChoiceAnswer) -> f64 {
    let selected: HashSet<&str> = answer.choice_ids.iter().map(String::as_str).collect();
    let sum = field
        .choices()
        .iter()
        .filter(|choice| selected.contains(choice.id.as_str()))
        .filter_map(|choice| choice.score)
        .fold(0.0, |sum, score| sum + score);
    round_number(sum)
}

/// An operand as a number for a calculation; `None` skips the calculation.
pub fn operand_number(operand: &Operand, ctx: &EvalContext<'_>) -> Option<f64> {
    match operand {
        Operand::Field { id, .. } => {
            let (field, answer) = ctx.visible_answer(id)?;
            match answer {
                AnswerValue::Number(number) if field.kind.is_numeric() => Some(*number),
                AnswerValue::Bool(flag) if field.kind.is_boolean() => {
                    Some(if *flag { 1.0 } else { 0.0 })
                }
                AnswerValue::Choice(choice) if field.kind.is_choice() => {
                    Some(selected_score(field, choice))
                }
                _ => None,
            }
        }
        Operand::Hidden { name } => ctx
            .hidden
            .get(name.as_str())
            .and_then(|value| parse_numeric_text(value)),
        Operand::Variable { name } => match ctx.variables.get(name)? {
            VarValue::Number(number) => Some(*number),
            VarValue::Text(text) => parse_numeric_text(text),
        },
        Operand::Constant { value } => match value {
            ConstantValue::Number(number) => Some(*number),
            ConstantValue::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
            ConstantValue::Text(text) => parse_numeric_text(text),
            ConstantValue::List(_) => None,
        },
    }
}

/// An operand as text for a text variable; `None` skips the calculation.
pub fn operand_text(operand: &Operand, ctx: &EvalContext<'_>) -> Option<String> {
    match operand {
        Operand::Field { id, .. } => {
            let (field, answer) = ctx.visible_answer(id)?;
            let text = display_value(field, answer);
            (!text.is_empty()).then_some(text)
        }
        Operand::Hidden { name } => ctx
            .hidden
            .get(name.as_str())
            .filter(|value| !value.is_empty())
            .cloned(),
        Operand::Variable { name } => match ctx.variables.get(name)? {
            VarValue::Number(number) => Some(number_text(*number)),
            VarValue::Text(text) => (!text.is_empty()).then(|| text.clone()),
        },
        Operand::Constant { value } => match value {
            ConstantValue::Text(text) => Some(text.clone()),
            ConstantValue::Number(number) => Some(number_text(*number)),
            ConstantValue::Bool(flag) => Some(flag.to_string()),
            ConstantValue::List(_) => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_keeps_float_noise_out() {
        assert!((round_number(0.1 + 0.2) - 0.3).abs() < f64::EPSILON);
        assert!((round_number(1.0 / 3.0) - 0.333_333_333_3).abs() < f64::EPSILON);
        assert!((round_number(-1.0 / 3.0) + 0.333_333_333_3).abs() < f64::EPSILON);
        assert!(round_number(-0.0).is_sign_positive());
        assert!(round_number(-1e-12).is_sign_positive());
        assert!((round_number(2e15 + 0.5) - (2e15 + 0.5)).abs() < f64::EPSILON);
    }

    #[test]
    fn numeric_text_is_a_plain_decimal() {
        assert_eq!(parse_numeric_text(" -12.5 "), Some(-12.5));
        assert_eq!(parse_numeric_text("7"), Some(7.0));
        for text in ["", "-", "1.", ".5", "1e3", "+1", "0x10", "1 2"] {
            assert_eq!(parse_numeric_text(text), None, "{text}");
        }
    }
}
