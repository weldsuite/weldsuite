/**
 * The shape the canvas gives a workflow, rebuilt from its flat `steps` list.
 *
 * The editor stores every step in one array. Steps without `parentBranchId`
 * form the main flow; a step with `parentBranchId` belongs to a branch of a
 * branching step:
 *   - `condition`: `<id>_if` / `<id>_if_not`, or `<id>_branch_<value>` when
 *     the step's config lists `branches`
 *   - `loop`: `<id>_each`, the steps repeated for every item
 * Branches nest (a condition inside a branch has branches of its own), and
 * after a branching step the main flow carries on with its next step. Keep the
 * branch ids in sync with `getConditionBranchIds` in
 * packages/design/ui/src/components/workflow-canvas/flow-utils.ts.
 */

import type { WorkflowStep } from './types';

export interface ConditionBranchConfig {
  value: string;
  label?: string;
}

export function isBranchingStep(step: Pick<WorkflowStep, 'type'>): boolean {
  return step.type === 'condition' || step.type === 'loop';
}

export const ifBranchId = (stepId: string) => `${stepId}_if`;
export const ifNotBranchId = (stepId: string) => `${stepId}_if_not`;
export const valueBranchId = (stepId: string, value: string) => `${stepId}_branch_${value}`;
export const loopBodyId = (stepId: string) => `${stepId}_each`;

/** The value branches of a multi-branch condition, or null for a plain if/else. */
export function conditionBranches(step: WorkflowStep): ConditionBranchConfig[] | null {
  const branches = (step.config as { branches?: unknown } | undefined)?.branches;
  return Array.isArray(branches) ? (branches as ConditionBranchConfig[]) : null;
}

/** Every branch id a step owns (none for a plain action). */
export function branchIdsOf(step: WorkflowStep): string[] {
  if (step.type === 'loop') return [loopBodyId(step.id)];
  if (step.type !== 'condition') return [];
  const branches = conditionBranches(step);
  if (branches) return branches.map((b) => valueBranchId(step.id, String(b.value)));
  return [ifBranchId(step.id), ifNotBranchId(step.id)];
}

export interface StepTree {
  /** Indexes (into `steps`) of the main-flow steps, in order. */
  main: number[];
  /** Indexes of each branch's steps, in order, keyed by branch id. */
  branches: Map<string, number[]>;
}

export function buildStepTree(steps: WorkflowStep[]): StepTree {
  const main: number[] = [];
  const branches = new Map<string, number[]>();
  steps.forEach((step, index) => {
    const parent = step.parentBranchId;
    if (!parent) {
      main.push(index);
      return;
    }
    const list = branches.get(parent) ?? [];
    list.push(index);
    branches.set(parent, list);
  });
  return { main, branches };
}

/** Indexes of every step nested (at any depth) under one branch, in tree order. */
export function stepsUnderBranch(tree: StepTree, steps: WorkflowStep[], branchId: string): number[] {
  const result: number[] = [];
  for (const index of tree.branches.get(branchId) ?? []) {
    result.push(index);
    for (const childBranch of branchIdsOf(steps[index])) {
      result.push(...stepsUnderBranch(tree, steps, childBranch));
    }
  }
  return result;
}
