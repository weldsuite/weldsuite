//! The path a respondent takes through a form, given their answers (`path.ts`).
//!
//! Start at the first block; skip page breaks; put each content block on
//! the path (its answers, and its group children's, become visible).
//! Leaving a block: the selected scores of its choice fields add to `score`,
//! its calculations run in order, then the first jump whose condition holds
//! is taken, else `otherwise`, else the next block. A jump to an ending ends
//! the walk; one that doesn't go forward (or to an unknown target) counts as
//! "next block". Past the last block the first matching `endingRules` entry
//! picks the ending, else `endings[0]`.

use std::collections::{HashMap, HashSet};

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use super::answers::{AnswerValue, collect_answers};
use super::blocks::block_fields;
use super::conditions::{
    EvalContext, VarValue, VariableValues, create_eval_context, evaluate_group, operand_number,
    operand_text, round_number, selected_score,
};
use super::definition::{
    Block, BlockLogic, CalcOp, Calculation, FormDefinition, GroupChild, Target,
};

/// What the engine reads: the raw answers by field id and the hidden values
/// by name (undeclared names and non-string values are ignored).
#[derive(Debug, Clone, Copy, Default)]
pub struct EngineInput<'a> {
    pub answers: Option<&'a Map<String, Value>>,
    pub hidden: Option<&'a Map<String, Value>>,
}

/// `computePath`'s result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathResult {
    /// Top-level block ids the respondent passes, in order (page breaks excluded).
    pub path: Vec<String>,
    pub ending_id: String,
    pub variables: VariableValues,
}

/// Where to go: a block id, or an ending (`string | { endingId }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Block(String),
    Ending(String),
}

impl Serialize for Step {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct EndingStep<'a> {
            ending_id: &'a str,
        }
        match self {
            Self::Block(id) => serializer.serialize_str(id),
            Self::Ending(ending_id) => EndingStep { ending_id }.serialize(serializer),
        }
    }
}

/// Runs one calculation on the context's variables.
pub fn run_calculation(calc: &Calculation, ctx: &mut EvalContext<'_>) {
    let Some(current) = ctx.variables.get(&calc.variable).cloned() else {
        return;
    };
    if calc
        .when
        .as_ref()
        .is_some_and(|when| !evaluate_group(when, ctx))
    {
        return;
    }
    let current = match current {
        VarValue::Text(current) => {
            if !matches!(calc.op, CalcOp::Set | CalcOp::Add) {
                return;
            }
            let Some(text) = operand_text(&calc.value, ctx) else {
                return;
            };
            let next = if calc.op == CalcOp::Set {
                text
            } else {
                current + &text
            };
            ctx.variables.set(&calc.variable, VarValue::Text(next));
            return;
        }
        VarValue::Number(current) => current,
    };
    let Some(operand) = operand_number(&calc.value, ctx) else {
        return;
    };
    let next = match calc.op {
        CalcOp::Add => current + operand,
        CalcOp::Subtract => current - operand,
        CalcOp::Multiply => current * operand,
        CalcOp::Divide => {
            if operand == 0.0 {
                return;
            }
            current / operand
        }
        CalcOp::Set => operand,
    };
    if !next.is_finite() {
        return;
    }
    ctx.variables
        .set(&calc.variable, VarValue::Number(round_number(next)));
}

/// [`walk`]'s result: the path, and every field and block id on it.
#[derive(Debug, Clone)]
pub struct WalkResult<'a> {
    pub path: PathResult,
    /// Field and block ids on the path (group children included).
    pub visible: HashSet<&'a str>,
}

/// Walks the blocks over already-validated answers.
pub fn walk<'a>(def: &'a FormDefinition, mut ctx: EvalContext<'a>) -> WalkResult<'a> {
    let mut logic_by_block: HashMap<&str, &BlockLogic> = HashMap::new();
    for logic in &def.logic {
        logic_by_block
            .entry(logic.block_id.as_str())
            .or_insert(logic);
    }
    let ending_ids: HashSet<&str> = def.endings.iter().map(|e| e.id.as_str()).collect();
    let mut block_index: HashMap<&str, usize> = HashMap::new();
    for (i, block) in def.blocks.iter().enumerate() {
        block_index.entry(block.id()).or_insert(i);
    }

    let mut path = Vec::new();
    let mut ending_id: Option<String> = None;
    let mut i = 0;
    while let Some(block) = def.blocks.get(i) {
        if block.is_page_break() {
            i += 1;
            continue;
        }
        path.push(block.id().to_owned());
        ctx.visible.insert(block.id());
        if let Block::Group(group) = block {
            ctx.visible
                .extend(group.children.iter().map(GroupChild::id));
        }

        for field in block_fields(block) {
            if !field.kind.is_choice() {
                continue;
            }
            let answers = ctx.answers;
            let Some(AnswerValue::Choice(answer)) = answers.get(&field.id) else {
                continue;
            };
            if let Some(VarValue::Number(score)) = ctx.variables.get("score") {
                let score = round_number(score + selected_score(field, answer));
                ctx.variables.set("score", VarValue::Number(score));
            }
        }

        let mut target: Option<&Target> = None;
        if let Some(logic) = logic_by_block.get(block.id()) {
            for calc in &logic.calculations {
                run_calculation(calc, &mut ctx);
            }
            target = logic
                .jumps
                .iter()
                .find(|jump| evaluate_group(&jump.when, &ctx))
                .map(|jump| &jump.to)
                .or(logic.otherwise.as_ref());
        }

        let mut next = i + 1;
        match target {
            Some(Target::Ending { id }) if ending_ids.contains(id.as_str()) => {
                ending_id = Some(id.clone());
                break;
            }
            Some(Target::Block { id }) => {
                if let Some(&j) = block_index.get(id.as_str())
                    && j > i
                    && !def.blocks[j].is_page_break()
                {
                    next = j;
                }
            }
            _ => {}
        }
        i = next;
    }

    let ending_id = ending_id.unwrap_or_else(|| {
        def.ending_rules
            .iter()
            .find(|rule| {
                ending_ids.contains(rule.ending_id.as_str()) && evaluate_group(&rule.when, &ctx)
            })
            .map(|rule| rule.ending_id.clone())
            .or_else(|| def.endings.first().map(|ending| ending.id.clone()))
            .unwrap_or_default()
    });

    WalkResult {
        path: PathResult {
            path,
            ending_id,
            variables: ctx.variables,
        },
        visible: ctx.visible,
    }
}

/// Walks the form with the answers given (invalid answers count as unanswered).
pub fn compute_path(def: &FormDefinition, input: EngineInput<'_>) -> PathResult {
    let collected = collect_answers(def, input.answers);
    walk(
        def,
        create_eval_context(def, &collected.valid, input.hidden),
    )
    .path
}

/// Where to go first: the first block, or straight to an ending when the
/// form has no content blocks.
pub fn first_step(def: &FormDefinition, input: EngineInput<'_>) -> Step {
    let result = compute_path(def, input);
    match result.path.into_iter().next() {
        Some(id) => Step::Block(id),
        None => Step::Ending(result.ending_id),
    }
}

/// Conversational navigation: the block after `current_block_id`, or the
/// ending. A group child's id counts as its group. When the current block
/// is not on the path, the first path block after it in `blocks` order is next.
pub fn next_step(def: &FormDefinition, input: EngineInput<'_>, current_block_id: &str) -> Step {
    let PathResult {
        path, ending_id, ..
    } = compute_path(def, input);
    let or_ending = |id: Option<&String>| {
        id.map_or_else(
            || Step::Ending(ending_id.clone()),
            |id| Step::Block(id.clone()),
        )
    };
    let current_index = def.blocks.iter().position(|block| {
        block.id() == current_block_id
            || matches!(block, Block::Group(group) if group.children.iter().any(|child| child.id() == current_block_id))
    });
    let Some(current_index) = current_index else {
        return or_ending(path.first());
    };
    let current_id = def.blocks[current_index].id();
    if let Some(on_path) = path.iter().position(|id| id == current_id) {
        return or_ending(path.get(on_path + 1));
    }
    let after = path.iter().find(|id| {
        def.blocks
            .iter()
            .position(|block| block.id() == id.as_str())
            .is_some_and(|index| index > current_index)
    });
    or_ending(after)
}

/// The classic layout's pages: the path's blocks, split where the definition
/// has a page break. Pages without a block on the path are left out.
pub fn classic_pages(def: &FormDefinition, path: &[String]) -> Vec<Vec<String>> {
    let on_path: HashSet<&str> = path.iter().map(String::as_str).collect();
    let mut pages = Vec::new();
    let mut page: Vec<String> = Vec::new();
    for block in &def.blocks {
        if block.is_page_break() {
            if !page.is_empty() {
                pages.push(std::mem::take(&mut page));
            }
            continue;
        }
        if on_path.contains(block.id()) {
            page.push(block.id().to_owned());
        }
    }
    if !page.is_empty() {
        pages.push(page);
    }
    pages
}
