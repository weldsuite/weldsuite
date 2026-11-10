//! Rules a definition must follow that the schema can't express
//! (`validate.ts`). Issues are reported per occurrence: a duplicate on the
//! second (and every later) occurrence, never on the first.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde::Serialize;
use serde_json::Value;

use super::blocks::{ADDRESS_PARTS, CONTACT_PARTS};
use super::definition::{
    Block, BlockLogic, CalcOp, Condition, ConditionGroup, ConditionItem, ConditionOperator,
    ConstantValue, Field, FieldKind, FormDefinition, Operand, Target, Variable,
};
use super::js::{js_cmp, js_trim};
use super::schema::is_date_text;

/// What is wrong with a definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueCode {
    Schema,
    DuplicateId,
    DuplicateRef,
    DuplicateHidden,
    DuplicateVariable,
    ReservedVariable,
    UnknownBlock,
    UnknownEnding,
    UnknownField,
    UnknownRow,
    UnknownPart,
    UnknownHidden,
    UnknownVariable,
    VariableType,
    LogicOnPageBreak,
    DuplicateLogic,
    BackwardJump,
    OperandAfterSource,
    OperatorMismatch,
    SelectionRange,
    NumberRange,
    DateRange,
}

impl IssueCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Schema => "schema",
            Self::DuplicateId => "duplicate_id",
            Self::DuplicateRef => "duplicate_ref",
            Self::DuplicateHidden => "duplicate_hidden",
            Self::DuplicateVariable => "duplicate_variable",
            Self::ReservedVariable => "reserved_variable",
            Self::UnknownBlock => "unknown_block",
            Self::UnknownEnding => "unknown_ending",
            Self::UnknownField => "unknown_field",
            Self::UnknownRow => "unknown_row",
            Self::UnknownPart => "unknown_part",
            Self::UnknownHidden => "unknown_hidden",
            Self::UnknownVariable => "unknown_variable",
            Self::VariableType => "variable_type",
            Self::LogicOnPageBreak => "logic_on_page_break",
            Self::DuplicateLogic => "duplicate_logic",
            Self::BackwardJump => "backward_jump",
            Self::OperandAfterSource => "operand_after_source",
            Self::OperatorMismatch => "operator_mismatch",
            Self::SelectionRange => "selection_range",
            Self::NumberRange => "number_range",
            Self::DateRange => "date_range",
        }
    }
}

/// A problem with a definition (`DefinitionIssue`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionIssue {
    pub code: IssueCode,
    /// Human-readable, English; the builder maps `code` to a translated text.
    pub message: String,
    /// JSON path into the definition, e.g. `blocks.3.properties.choices.1.id`.
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
}

/// `parseDefinition`: the schema, then [`validate_definition`].
pub fn parse_definition(value: &Value) -> Result<FormDefinition, Vec<DefinitionIssue>> {
    let def = FormDefinition::parse(value).map_err(|issues| {
        issues
            .into_iter()
            .map(|issue| DefinitionIssue {
                code: IssueCode::Schema,
                path: issue.path_text(),
                message: issue.message,
                block_id: None,
            })
            .collect::<Vec<_>>()
    })?;
    let issues = validate_definition(&def);
    if issues.is_empty() {
        Ok(def)
    } else {
        Err(issues)
    }
}

/// What a condition operand holds, for operator checks: `set` = choice ids
/// (choice fields, a matrix row), `list` = a constant array, `opaque` =
/// answered or not, nothing to compare.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperandKind {
    Number,
    Boolean,
    Text,
    Date,
    Set,
    List,
    Opaque,
}

impl fmt::Display for OperandKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Text => "text",
            Self::Date => "date",
            Self::Set => "set",
            Self::List => "list",
            Self::Opaque => "opaque",
        })
    }
}

/// For a left-hand kind and an operator: the right-hand kinds it takes, or
/// `None` when the operator doesn't apply.
fn allowed_right(left: OperandKind, operator: ConditionOperator) -> Option<&'static [OperandKind]> {
    use ConditionOperator as Op;
    use OperandKind as K;
    match (left, operator) {
        (
            K::Number,
            Op::Is
            | Op::IsNot
            | Op::GreaterThan
            | Op::GreaterOrEqual
            | Op::LessThan
            | Op::LessOrEqual,
        ) => Some(&[K::Number]),
        (K::Boolean, Op::Is | Op::IsNot) => Some(&[K::Boolean]),
        (
            K::Text,
            Op::Is | Op::IsNot | Op::Contains | Op::NotContains | Op::StartsWith | Op::EndsWith,
        ) => Some(&[K::Text]),
        (K::Date, Op::Is | Op::IsNot | Op::Before | Op::After) => Some(&[K::Date, K::Text]),
        (K::Set, Op::Is | Op::IsNot | Op::AnyOf | Op::AllOf | Op::NoneOf) => {
            Some(&[K::Text, K::List])
        }
        _ => None,
    }
}

/// Whether `left operator right` is a meaningful comparison.
pub fn operator_allowed(
    left: OperandKind,
    operator: ConditionOperator,
    right: Option<OperandKind>,
    right_operand: Option<&Operand>,
) -> bool {
    if matches!(
        operator,
        ConditionOperator::IsAnswered | ConditionOperator::IsEmpty
    ) {
        return true;
    }
    let Some(right) = right else {
        return false;
    };
    if !allowed_right(left, operator).is_some_and(|kinds| kinds.contains(&right)) {
        return false;
    }
    // A date compares with a date constant only.
    if let (OperandKind::Date, Some(Operand::Constant { value })) = (left, right_operand) {
        return matches!(value, ConstantValue::Text(text) if is_date_text(js_trim(text)));
    }
    true
}

/// The kind of a field operand (with its `rowId` / `part`).
pub fn field_operand_kind(field: &Field, row_id: Option<&str>, part: Option<&str>) -> OperandKind {
    match &field.kind {
        FieldKind::Number(_)
        | FieldKind::Rating(_)
        | FieldKind::OpinionScale(_)
        | FieldKind::Nps(_) => OperandKind::Number,
        FieldKind::YesNo(_) | FieldKind::Legal(_) => OperandKind::Boolean,
        FieldKind::MultipleChoice(_) | FieldKind::Dropdown(_) | FieldKind::PictureChoice(_) => {
            OperandKind::Set
        }
        FieldKind::Matrix(_) if row_id.is_some() => OperandKind::Set,
        FieldKind::ContactInfo(_) | FieldKind::Address(_) if part.is_some() => OperandKind::Text,
        FieldKind::Date(_) => OperandKind::Date,
        FieldKind::ShortText(_)
        | FieldKind::LongText(_)
        | FieldKind::Email(_)
        | FieldKind::Phone(_)
        | FieldKind::Website(_) => OperandKind::Text,
        FieldKind::Matrix(_)
        | FieldKind::ContactInfo(_)
        | FieldKind::Address(_)
        | FieldKind::Ranking(_)
        | FieldKind::FileUpload(_)
        | FieldKind::Signature(_) => OperandKind::Opaque,
    }
}

/// Collects the issues while the definition is walked.
struct Checker<'a> {
    def: &'a FormDefinition,
    issues: Vec<DefinitionIssue>,
    /// Top-level blocks, group children and endings share one namespace.
    ids: HashSet<&'a str>,
    refs: HashSet<&'a str>,
    /// Fields by id with the index of the top-level block that holds them.
    fields: HashMap<&'a str, (&'a Field, usize)>,
    hidden_names: HashSet<&'a str>,
    /// Declared variables: `true` for a text variable.
    variable_is_text: HashMap<&'a str, bool>,
    block_index: HashMap<&'a str, usize>,
    ending_ids: HashSet<&'a str>,
}

impl<'a> Checker<'a> {
    fn add(&mut self, code: IssueCode, message: String, path: String, block_id: Option<&str>) {
        self.issues.push(DefinitionIssue {
            code,
            message,
            path,
            block_id: block_id.map(str::to_owned),
        });
    }

    fn check_id_and_ref(&mut self, id: &'a str, reference: &'a str, path: &str) {
        if !self.ids.insert(id) {
            self.add(
                IssueCode::DuplicateId,
                format!("The id \"{id}\" is used more than once."),
                format!("{path}.id"),
                Some(id),
            );
        }
        if !self.refs.insert(reference) {
            self.add(
                IssueCode::DuplicateRef,
                format!("The ref \"{reference}\" is used more than once."),
                format!("{path}.ref"),
                Some(id),
            );
        }
    }

    fn register_field(&mut self, field: &'a Field, index: usize, path: &str) {
        self.fields
            .entry(field.id.as_str())
            .or_insert((field, index));
        self.check_field(field, path);
    }

    /// `score` is a number variable (`Some(false)`); else the declared type.
    fn variable_is_text(&self, name: &str) -> Option<bool> {
        if name == "score" {
            Some(false)
        } else {
            self.variable_is_text.get(name).copied()
        }
    }

    /// Checks an operand; its kind, or `None` when it refers to nothing.
    /// `source` = index of the logic's block.
    fn check_operand(
        &mut self,
        operand: &Operand,
        path: &str,
        source: Option<usize>,
    ) -> Option<OperandKind> {
        match operand {
            Operand::Field { id, row_id, part } => {
                self.check_field_operand(id, row_id.as_deref(), part.as_deref(), path, source)
            }
            Operand::Hidden { name } => {
                if self.hidden_names.contains(name.as_str()) {
                    return Some(OperandKind::Text);
                }
                self.add(
                    IssueCode::UnknownHidden,
                    format!("No hidden field is named \"{name}\"."),
                    format!("{path}.name"),
                    None,
                );
                None
            }
            Operand::Variable { name } => match self.variable_is_text(name) {
                Some(true) => Some(OperandKind::Text),
                Some(false) => Some(OperandKind::Number),
                None => {
                    self.add(
                        IssueCode::UnknownVariable,
                        format!("No variable is named \"{name}\"."),
                        format!("{path}.name"),
                        None,
                    );
                    None
                }
            },
            Operand::Constant { value } => Some(match value {
                ConstantValue::Number(_) => OperandKind::Number,
                ConstantValue::Bool(_) => OperandKind::Boolean,
                ConstantValue::Text(_) => OperandKind::Text,
                ConstantValue::List(_) => OperandKind::List,
            }),
        }
    }

    fn check_field_operand(
        &mut self,
        id: &str,
        row_id: Option<&str>,
        part: Option<&str>,
        path: &str,
        source: Option<usize>,
    ) -> Option<OperandKind> {
        let Some(&(field, index)) = self.fields.get(id) else {
            self.add(
                IssueCode::UnknownField,
                format!("No field has the id \"{id}\"."),
                format!("{path}.id"),
                None,
            );
            return None;
        };
        if let Some(row_id) = row_id {
            let known = matches!(&field.kind, FieldKind::Matrix(props) if props.rows.iter().any(|row| row.id == row_id));
            if !known {
                self.add(
                    IssueCode::UnknownRow,
                    format!("The field \"{}\" has no row \"{row_id}\".", field.r#ref),
                    format!("{path}.rowId"),
                    Some(&field.id),
                );
                return None;
            }
        }
        if let Some(part) = part {
            let parts: &[&str] = match field.kind {
                FieldKind::ContactInfo(_) => &CONTACT_PARTS,
                FieldKind::Address(_) => &ADDRESS_PARTS,
                _ => &[],
            };
            if !parts.contains(&part) {
                self.add(
                    IssueCode::UnknownPart,
                    format!("The field \"{}\" has no part \"{part}\".", field.r#ref),
                    format!("{path}.part"),
                    Some(&field.id),
                );
                return None;
            }
        }
        if source.is_some_and(|source| index > source) {
            self.add(
                IssueCode::OperandAfterSource,
                format!(
                    "The field \"{}\" comes after the block this logic belongs to.",
                    field.r#ref
                ),
                path.to_owned(),
                Some(&field.id),
            );
        }
        Some(field_operand_kind(field, row_id, part))
    }

    fn check_condition(&mut self, condition: &Condition, path: &str, source: Option<usize>) {
        let left = self.check_operand(&condition.left, &format!("{path}.left"), source);
        let operator = condition.operator.as_str();
        if matches!(
            condition.operator,
            ConditionOperator::IsAnswered | ConditionOperator::IsEmpty
        ) {
            return;
        }
        let Some(right_operand) = &condition.right else {
            self.add(
                IssueCode::OperatorMismatch,
                format!("\"{operator}\" needs a value to compare with."),
                path.to_owned(),
                None,
            );
            return;
        };
        let right = self.check_operand(right_operand, &format!("{path}.right"), source);
        let (Some(left), Some(right)) = (left, right) else {
            return;
        };
        if !operator_allowed(left, condition.operator, Some(right), Some(right_operand)) {
            self.add(
                IssueCode::OperatorMismatch,
                format!("\"{operator}\" can't compare a {left} with a {right}."),
                path.to_owned(),
                None,
            );
        }
    }

    fn check_group(&mut self, group: &ConditionGroup, path: &str, source: Option<usize>) {
        for (k, item) in group.conditions.iter().enumerate() {
            match item {
                ConditionItem::Group(nested) => {
                    for (m, condition) in nested.conditions.iter().enumerate() {
                        let path = format!("{path}.conditions.{k}.conditions.{m}");
                        self.check_condition(condition, &path, source);
                    }
                }
                ConditionItem::Condition(condition) => {
                    self.check_condition(condition, &format!("{path}.conditions.{k}"), source);
                }
            }
        }
    }

    fn check_target(&mut self, target: &Target, path: &str, source: Option<usize>) {
        let id = match target {
            Target::Ending { id } => {
                if !self.ending_ids.contains(id.as_str()) {
                    self.add(
                        IssueCode::UnknownEnding,
                        format!("No ending has the id \"{id}\"."),
                        format!("{path}.id"),
                        None,
                    );
                }
                return;
            }
            Target::Block { id } => id,
        };
        let Some(&index) = self.block_index.get(id.as_str()) else {
            self.add(
                IssueCode::UnknownBlock,
                format!("No top-level block has the id \"{id}\"."),
                format!("{path}.id"),
                None,
            );
            return;
        };
        if self.def.blocks[index].is_page_break() || source.is_some_and(|source| index <= source) {
            self.add(
                IssueCode::BackwardJump,
                "A jump must go to a later question, statement or group.".to_owned(),
                path.to_owned(),
                Some(id),
            );
        }
    }

    /// Reports every repeated id of a field's choices, rows or columns.
    fn check_unique<'i>(
        &mut self,
        field: &Field,
        ids: impl Iterator<Item = &'i str>,
        items_path: &str,
    ) {
        let mut seen = HashSet::new();
        for (k, id) in ids.enumerate() {
            if !seen.insert(id) {
                self.add(
                    IssueCode::DuplicateId,
                    format!("The id \"{id}\" is used more than once in this field."),
                    format!("{items_path}.{k}.id"),
                    Some(&field.id),
                );
            }
        }
    }

    /// Per-field rules: unique choice, row and column ids; selection, number
    /// and date ranges.
    fn check_field(&mut self, field: &Field, path: &str) {
        let choices = field.choices();
        if !choices.is_empty() {
            let ids = choices.iter().map(|choice| choice.id.as_str());
            self.check_unique(field, ids, &format!("{path}.properties.choices"));
        }
        match &field.kind {
            FieldKind::Matrix(props) => {
                let rows = props.rows.iter().map(|row| row.id.as_str());
                self.check_unique(field, rows, &format!("{path}.properties.rows"));
                let columns = props.columns.iter().map(|column| column.id.as_str());
                self.check_unique(field, columns, &format!("{path}.properties.columns"));
            }
            FieldKind::MultipleChoice(props) => self.check_selection(
                field,
                path,
                (props.min_selections, props.max_selections),
                props.multiple,
                props.choices.len() + usize::from(props.allow_other),
            ),
            FieldKind::PictureChoice(props) => self.check_selection(
                field,
                path,
                (props.min_selections, props.max_selections),
                props.multiple,
                props.choices.len() + usize::from(props.allow_other),
            ),
            FieldKind::Number(props) => {
                if props.min.zip(props.max).is_some_and(|(min, max)| min > max) {
                    self.add(
                        IssueCode::NumberRange,
                        "The minimum is above the maximum.".to_owned(),
                        format!("{path}.properties"),
                        Some(&field.id),
                    );
                }
            }
            FieldKind::Date(props) => {
                let after = props
                    .min
                    .as_deref()
                    .zip(props.max.as_deref())
                    .is_some_and(|(min, max)| js_cmp(min, max).is_gt());
                if after {
                    self.add(
                        IssueCode::DateRange,
                        "The earliest date is after the latest date.".to_owned(),
                        format!("{path}.properties"),
                        Some(&field.id),
                    );
                }
            }
            _ => {}
        }
    }

    /// `selection_range`: min above max, min or max above the options
    /// (counting Other), or min above 1 on a single select.
    fn check_selection(
        &mut self,
        field: &Field,
        path: &str,
        (min, max): (Option<f64>, Option<f64>),
        multiple: bool,
        options: usize,
    ) {
        #[allow(clippy::cast_precision_loss)] // at most a few hundred options
        let options = options as f64;
        let wrong = min.zip(max).is_some_and(|(min, max)| min > max)
            || min.is_some_and(|min| min > options)
            || max.is_some_and(|max| max > options)
            || (!multiple && min.is_some_and(|min| min > 1.0));
        if wrong {
            self.add(
                IssueCode::SelectionRange,
                "The number of selections allowed does not fit the choices.".to_owned(),
                format!("{path}.properties"),
                Some(&field.id),
            );
        }
    }

    fn check_logic(
        &mut self,
        li: usize,
        logic: &'a BlockLogic,
        logic_blocks: &mut HashSet<&'a str>,
    ) {
        let path = format!("logic.{li}");
        let mut source = None;
        match self.block_index.get(logic.block_id.as_str()).copied() {
            None => self.add(
                IssueCode::UnknownBlock,
                format!("No top-level block has the id \"{}\".", logic.block_id),
                format!("{path}.blockId"),
                None,
            ),
            Some(index) if self.def.blocks[index].is_page_break() => self.add(
                IssueCode::LogicOnPageBreak,
                "A page break has no logic.".to_owned(),
                format!("{path}.blockId"),
                Some(&logic.block_id),
            ),
            Some(index) => {
                source = Some(index);
                if !logic_blocks.insert(logic.block_id.as_str()) {
                    self.add(
                        IssueCode::DuplicateLogic,
                        "This block already has logic.".to_owned(),
                        format!("{path}.blockId"),
                        Some(&logic.block_id),
                    );
                }
            }
        }

        for (ci, calc) in logic.calculations.iter().enumerate() {
            let calc_path = format!("{path}.calculations.{ci}");
            if let Some(when) = &calc.when {
                self.check_group(when, &format!("{calc_path}.when"), source);
            }
            match self.variable_is_text(&calc.variable) {
                None => self.add(
                    IssueCode::UnknownVariable,
                    format!("No variable is named \"{}\".", calc.variable),
                    format!("{calc_path}.variable"),
                    None,
                ),
                Some(true) if !matches!(calc.op, CalcOp::Set | CalcOp::Add) => self.add(
                    IssueCode::VariableType,
                    format!(
                        "A text variable can only be set or appended to, not \"{}\".",
                        calc.op.as_str()
                    ),
                    format!("{calc_path}.op"),
                    None,
                ),
                Some(_) => {}
            }
            self.check_operand(&calc.value, &format!("{calc_path}.value"), source);
        }
        for (ji, jump) in logic.jumps.iter().enumerate() {
            self.check_group(&jump.when, &format!("{path}.jumps.{ji}.when"), source);
            self.check_target(&jump.to, &format!("{path}.jumps.{ji}.to"), source);
        }
        if let Some(otherwise) = &logic.otherwise {
            self.check_target(otherwise, &format!("{path}.otherwise"), source);
        }
    }
}

/// The definition's rules beyond the schema; one issue per occurrence.
pub fn validate_definition(def: &FormDefinition) -> Vec<DefinitionIssue> {
    let mut checker = Checker {
        def,
        issues: Vec::new(),
        ids: HashSet::new(),
        refs: HashSet::new(),
        fields: HashMap::new(),
        hidden_names: HashSet::new(),
        variable_is_text: HashMap::new(),
        block_index: HashMap::new(),
        ending_ids: def
            .endings
            .iter()
            .map(|ending| ending.id.as_str())
            .collect(),
    };

    // --- ids and refs ---------------------------------------------------------
    for (i, block) in def.blocks.iter().enumerate() {
        let path = format!("blocks.{i}");
        checker.check_id_and_ref(block.id(), block.r#ref(), &path);
        match block {
            Block::Group(group) => {
                for (j, child) in group.children.iter().enumerate() {
                    let child_path = format!("{path}.children.{j}");
                    checker.check_id_and_ref(child.id(), child.r#ref(), &child_path);
                    if let Some(field) = child.as_field() {
                        checker.register_field(field, i, &child_path);
                    }
                }
            }
            Block::Field(field) => checker.register_field(field, i, &path),
            Block::Statement(_) | Block::PageBreak(_) => {}
        }
    }
    for (i, ending) in def.endings.iter().enumerate() {
        checker.check_id_and_ref(&ending.id, &ending.r#ref, &format!("endings.{i}"));
    }

    // --- hidden fields and variables ------------------------------------------
    for (i, hidden) in def.hidden.iter().enumerate() {
        if !checker.hidden_names.insert(hidden.name.as_str()) {
            checker.add(
                IssueCode::DuplicateHidden,
                format!(
                    "The hidden field \"{}\" is declared more than once.",
                    hidden.name
                ),
                format!("hidden.{i}.name"),
                None,
            );
        }
    }
    for (i, variable) in def.variables.iter().enumerate() {
        let name = variable.name();
        if name == "score" {
            checker.add(
                IssueCode::ReservedVariable,
                "The variable \"score\" always exists and cannot be declared.".to_owned(),
                format!("variables.{i}.name"),
                None,
            );
        } else if checker.variable_is_text.contains_key(name) {
            checker.add(
                IssueCode::DuplicateVariable,
                format!("The variable \"{name}\" is declared more than once."),
                format!("variables.{i}.name"),
                None,
            );
        } else {
            checker
                .variable_is_text
                .insert(name, matches!(variable, Variable::Text { .. }));
        }
    }

    // --- logic ----------------------------------------------------------------
    for (i, block) in def.blocks.iter().enumerate() {
        checker.block_index.entry(block.id()).or_insert(i);
    }
    let mut logic_blocks = HashSet::new();
    for (li, logic) in def.logic.iter().enumerate() {
        checker.check_logic(li, logic, &mut logic_blocks);
    }
    for (ri, rule) in def.ending_rules.iter().enumerate() {
        checker.check_group(&rule.when, &format!("endingRules.{ri}.when"), None);
        if !checker.ending_ids.contains(rule.ending_id.as_str()) {
            checker.add(
                IssueCode::UnknownEnding,
                format!("No ending has the id \"{}\".", rule.ending_id),
                format!("endingRules.{ri}.endingId"),
                None,
            );
        }
    }

    checker.issues
}
