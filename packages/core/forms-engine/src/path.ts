/**
 * The path a respondent takes through a form, given their answers.
 *
 * Start at the first block; skip page breaks; put each content block on the
 * path (its answers, and its group children's, become visible). Leaving a
 * block: the selected scores of its choice fields add to `score`, its
 * calculations run in order, then the first jump whose condition holds is
 * taken, else `otherwise`, else the next block. A jump to an ending ends the
 * walk; a jump that doesn't go forward (or to an unknown target) counts as
 * "next block". Past the last block the first matching `endingRules` entry
 * picks the ending, else `endings[0]`.
 */

import { collectAnswers } from './answers';
import { blockFields, isChoiceField } from './blocks';
import {
  createEvalContext,
  evaluateGroup,
  operandNumber,
  operandText,
  roundNumber,
  selectedScore,
  variablesOf,
  type EvalContext,
} from './conditions';
import type { BlockLogic, Calculation, ChoiceAnswer, FormDefinition, LogicTarget } from './definition';
import type { EngineInput, PathResult } from './types';

/** Runs one calculation on the context's variables. */
export function runCalculation(calc: Calculation, ctx: EvalContext): void {
  const current = ctx.variables.get(calc.variable);
  if (current === undefined) return;
  if (calc.when && !evaluateGroup(calc.when, ctx)) return;

  if (typeof current === 'string') {
    if (calc.op !== 'set' && calc.op !== 'add') return;
    const text = operandText(calc.value, ctx);
    if (text === null) return;
    ctx.variables.set(calc.variable, calc.op === 'set' ? text : current + text);
    return;
  }

  const operand = operandNumber(calc.value, ctx);
  if (operand === null) return;
  let next: number;
  switch (calc.op) {
    case 'add':
      next = current + operand;
      break;
    case 'subtract':
      next = current - operand;
      break;
    case 'multiply':
      next = current * operand;
      break;
    case 'divide':
      if (operand === 0) return;
      next = current / operand;
      break;
    case 'set':
      next = operand;
      break;
  }
  if (!Number.isFinite(next)) return;
  ctx.variables.set(calc.variable, roundNumber(next));
}

export interface WalkResult extends PathResult {
  /** Field and block ids on the path (group children included). */
  visible: Set<string>;
}

/** Walks the blocks over already-validated answers. */
export function walk(def: FormDefinition, ctx: EvalContext): WalkResult {
  const logicByBlock = new Map<string, BlockLogic>();
  for (const logic of def.logic) if (!logicByBlock.has(logic.blockId)) logicByBlock.set(logic.blockId, logic);
  const endingIds = new Set(def.endings.map((e) => e.id));
  const blockIndex = new Map<string, number>();
  def.blocks.forEach((b, i) => {
    if (!blockIndex.has(b.id)) blockIndex.set(b.id, i);
  });

  const path: string[] = [];
  let endingId: string | null = null;
  let i = 0;
  while (i < def.blocks.length) {
    const block = def.blocks[i];
    if (!block) break;
    if (block.type === 'page_break') {
      i++;
      continue;
    }
    path.push(block.id);
    ctx.visible.add(block.id);
    if (block.type === 'group') for (const child of block.children) ctx.visible.add(child.id);

    for (const field of blockFields(block)) {
      if (!isChoiceField(field)) continue;
      const answer = ctx.answers[field.id];
      if (answer === undefined) continue;
      const score = ctx.variables.get('score');
      if (typeof score === 'number') ctx.variables.set('score', roundNumber(score + selectedScore(field, answer as ChoiceAnswer)));
    }

    let target: LogicTarget | null = null;
    const logic = logicByBlock.get(block.id);
    if (logic) {
      for (const calc of logic.calculations) runCalculation(calc, ctx);
      const jump = logic.jumps.find((j) => evaluateGroup(j.when, ctx));
      target = jump ? jump.to : logic.otherwise;
    }

    let next = i + 1;
    if (target) {
      if (target.type === 'ending') {
        if (endingIds.has(target.id)) {
          endingId = target.id;
          break;
        }
      } else {
        const j = blockIndex.get(target.id);
        if (j !== undefined && j > i && def.blocks[j]?.type !== 'page_break') next = j;
      }
    }
    i = next;
  }

  if (endingId === null) {
    const rule = def.endingRules.find((r) => endingIds.has(r.endingId) && evaluateGroup(r.when, ctx));
    endingId = rule ? rule.endingId : (def.endings[0]?.id ?? '');
  }

  return { path, endingId, variables: variablesOf(ctx), visible: ctx.visible };
}

/** Walks the form with the answers given (invalid answers count as unanswered). */
export function computePath(def: FormDefinition, input: EngineInput): PathResult {
  const { valid } = collectAnswers(def, input.answers);
  const { path, endingId, variables } = walk(def, createEvalContext(def, valid, input.hidden));
  return { path, endingId, variables };
}

/** Where to go first: the first block, or straight to an ending when the form has no content blocks. */
export function firstStep(def: FormDefinition, input: EngineInput): string | { endingId: string } {
  const result = computePath(def, input);
  return result.path[0] ?? { endingId: result.endingId };
}

/**
 * Conversational navigation: the block after `currentBlockId`, or the ending.
 * A group child's id counts as its group. When the current block is not on
 * the path, the first path block after it in `blocks` order is next.
 */
export function nextStep(
  def: FormDefinition,
  input: EngineInput,
  currentBlockId: string,
): string | { endingId: string } {
  const { path, endingId } = computePath(def, input);
  const currentIndex = def.blocks.findIndex(
    (b) => b.id === currentBlockId || (b.type === 'group' && b.children.some((c) => c.id === currentBlockId)),
  );
  const current = def.blocks[currentIndex];
  const onPath = current ? path.indexOf(current.id) : -1;
  if (onPath !== -1) return path[onPath + 1] ?? { endingId };
  if (currentIndex === -1) return path[0] ?? { endingId };
  const after = path.find((id) => def.blocks.findIndex((b) => b.id === id) > currentIndex);
  return after ?? { endingId };
}

/**
 * The classic layout's pages: the path's blocks, split where the definition
 * has a page break. Pages without a block on the path are left out.
 */
export function classicPages(def: FormDefinition, path: string[]): string[][] {
  const onPath = new Set(path);
  const pages: string[][] = [];
  let page: string[] = [];
  for (const block of def.blocks) {
    if (block.type === 'page_break') {
      if (page.length > 0) pages.push(page);
      page = [];
      continue;
    }
    if (onPath.has(block.id)) page.push(block.id);
  }
  if (page.length > 0) pages.push(page);
  return pages;
}
