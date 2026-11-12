/**
 * Pure edits of the logic part of a definition (per-block calculations, jumps
 * and "otherwise"; ending rules). A block's logic entry exists only while it
 * says something, so an emptied one is removed.
 */

import {
  newBlockId,
  type BlockLogic,
  type Calculation,
  type ConditionGroup,
  type EndingRule,
  type FormDefinition,
  type Jump,
  type LogicTarget,
} from '@weldsuite/forms-engine';

export function logicOf(def: Pick<FormDefinition, 'logic'>, blockId: string): BlockLogic {
  return def.logic.find((l) => l.blockId === blockId) ?? { blockId, calculations: [], jumps: [], otherwise: null };
}

function isEmpty(logic: BlockLogic): boolean {
  return logic.calculations.length === 0 && logic.jumps.length === 0 && logic.otherwise === null;
}

/** Applies `change` to the logic of one top-level block, creating or dropping its entry as needed. */
export function updateLogic(def: FormDefinition, blockId: string, change: (logic: BlockLogic) => BlockLogic): FormDefinition {
  const current = logicOf(def, blockId);
  const next = change(current);
  const exists = def.logic.some((l) => l.blockId === blockId);
  if (isEmpty(next)) return exists ? { ...def, logic: def.logic.filter((l) => l.blockId !== blockId) } : def;
  return { ...def, logic: exists ? def.logic.map((l) => (l.blockId === blockId ? next : l)) : [...def.logic, next] };
}

export function addJump(def: FormDefinition, blockId: string, when: ConditionGroup, to: LogicTarget): FormDefinition {
  const jump: Jump = { id: newBlockId('j'), when, to };
  return updateLogic(def, blockId, (l) => ({ ...l, jumps: [...l.jumps, jump] }));
}

export function updateJump(def: FormDefinition, blockId: string, jumpId: string, change: (jump: Jump) => Jump): FormDefinition {
  return updateLogic(def, blockId, (l) => ({ ...l, jumps: l.jumps.map((j) => (j.id === jumpId ? change(j) : j)) }));
}

export function removeJump(def: FormDefinition, blockId: string, jumpId: string): FormDefinition {
  return updateLogic(def, blockId, (l) => ({ ...l, jumps: l.jumps.filter((j) => j.id !== jumpId) }));
}

/** Jumps are checked in order: move one up or down. */
export function moveJump(def: FormDefinition, blockId: string, jumpId: string, direction: -1 | 1): FormDefinition {
  return updateLogic(def, blockId, (l) => {
    const from = l.jumps.findIndex((j) => j.id === jumpId);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= l.jumps.length) return l;
    const jumps = [...l.jumps];
    const [moved] = jumps.splice(from, 1);
    jumps.splice(to, 0, moved as Jump);
    return { ...l, jumps };
  });
}

export function setOtherwise(def: FormDefinition, blockId: string, otherwise: LogicTarget | null): FormDefinition {
  return updateLogic(def, blockId, (l) => ({ ...l, otherwise }));
}

export function addCalculation(def: FormDefinition, blockId: string, calculation: Omit<Calculation, 'id'>): FormDefinition {
  return updateLogic(def, blockId, (l) => ({ ...l, calculations: [...l.calculations, { ...calculation, id: newBlockId('x') }] }));
}

export function updateCalculation(def: FormDefinition, blockId: string, calcId: string, change: (calc: Calculation) => Calculation): FormDefinition {
  return updateLogic(def, blockId, (l) => ({ ...l, calculations: l.calculations.map((c) => (c.id === calcId ? change(c) : c)) }));
}

export function removeCalculation(def: FormDefinition, blockId: string, calcId: string): FormDefinition {
  return updateLogic(def, blockId, (l) => ({ ...l, calculations: l.calculations.filter((c) => c.id !== calcId) }));
}

// --- ending rules -----------------------------------------------------------

export function addEndingRule(def: FormDefinition, when: ConditionGroup, endingId: string): FormDefinition {
  const rule: EndingRule = { id: newBlockId('j'), when, endingId };
  return { ...def, endingRules: [...def.endingRules, rule] };
}

export function updateEndingRule(def: FormDefinition, ruleId: string, change: (rule: EndingRule) => EndingRule): FormDefinition {
  return { ...def, endingRules: def.endingRules.map((r) => (r.id === ruleId ? change(r) : r)) };
}

export function removeEndingRule(def: FormDefinition, ruleId: string): FormDefinition {
  return { ...def, endingRules: def.endingRules.filter((r) => r.id !== ruleId) };
}

export function moveEndingRule(def: FormDefinition, ruleId: string, direction: -1 | 1): FormDefinition {
  const from = def.endingRules.findIndex((r) => r.id === ruleId);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= def.endingRules.length) return def;
  const rules = [...def.endingRules];
  const [moved] = rules.splice(from, 1);
  rules.splice(to, 0, moved as EndingRule);
  return { ...def, endingRules: rules };
}

/** The targets a jump or "otherwise" on the block at `sourceIndex` may use: later blocks (not page breaks) and every ending. */
export function targetOptions(def: FormDefinition, sourceIndex: number): Array<{ target: LogicTarget; label: string }> {
  const blocks = def.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block, index }) => index > sourceIndex && block.type !== 'page_break')
    .map(({ block }) => ({ target: { type: 'block', id: block.id } as LogicTarget, label: block.title || block.ref }));
  const endings = def.endings.map((e) => ({ target: { type: 'ending', id: e.id } as LogicTarget, label: e.title || e.ref }));
  return [...blocks, ...endings];
}

export function targetKey(target: LogicTarget | null): string {
  return target ? `${target.type}:${target.id}` : 'next';
}

export function targetFromKey(key: string): LogicTarget | null {
  if (key === 'next') return null;
  const [type, ...rest] = key.split(':');
  const id = rest.join(':');
  return type === 'block' || type === 'ending' ? { type, id } : null;
}
