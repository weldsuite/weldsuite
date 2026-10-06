import { describe, expect, it } from 'vitest';
import {
  getConditionBranchIds,
  isBranchingStepType,
  workflowToFlow,
  type WorkflowStep,
} from '@weldsuite/ui/components/workflow-canvas';

const step = (id: string, type: string, extra: Partial<WorkflowStep> = {}): WorkflowStep =>
  ({ id, type, name: id, config: {}, ...extra }) as WorkflowStep;

describe('workflow canvas: branching steps', () => {
  it('treats conditions and loops as branching steps', () => {
    expect(isBranchingStepType('condition')).toBe(true);
    expect(isBranchingStepType('loop')).toBe(true);
    expect(isBranchingStepType('send_email')).toBe(false);
    expect(getConditionBranchIds({ id: 'l1', type: 'loop' })).toEqual(['l1_each']);
    expect(getConditionBranchIds({ id: 'c1', type: 'condition' })).toEqual(['c1_if', 'c1_if_not']);
  });

  it('draws a loop with a "for each item" branch holding its body, then joins the main flow', () => {
    const { nodes, edges } = workflowToFlow(
      null,
      [
        step('l1', 'loop', { config: { items: '{{trigger.data.lines}}' } }),
        step('body', 'send_email', { parentBranchId: 'l1_each' } as Partial<WorkflowStep>),
        step('after', 'send_email'),
      ],
      undefined,
      { labels: { branchLabels: { forEachItem: 'Voor elk item' } } },
    );

    const branch = nodes.find((n) => n.id === 'l1_each');
    expect(branch?.type).toBe('condition_branch');
    expect(branch?.data).toMatchObject({ label: 'Voor elk item', conditionLabel: '{{trigger.data.lines}}' });
    expect(nodes.find((n) => n.id === 'l1')?.type).toBe('condition');

    const pairs = edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toEqual(expect.arrayContaining(['l1->l1_each', 'l1_each->body', 'body->after']));
  });

  it('translates the if/else branch labels', () => {
    const { nodes } = workflowToFlow(null, [step('c1', 'condition')], undefined, {
      labels: { branchLabels: { ifTrue: 'Als waar', ifFalse: 'Als niet waar' } },
    });
    expect(nodes.find((n) => n.id === 'c1_if')?.data).toMatchObject({ label: 'Als waar' });
    expect(nodes.find((n) => n.id === 'c1_if_not')?.data).toMatchObject({ label: 'Als niet waar' });
  });
});
