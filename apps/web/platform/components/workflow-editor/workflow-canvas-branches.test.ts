import { describe, expect, it } from 'vitest';
import {
  autoLayoutNodes,
  flowToWorkflow,
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

// A Send Email card is wider than the others. Its saved position stays that of
// the standard-width slot, and the card is drawn centred on it.
describe('workflow canvas: the wider Send Email card', () => {
  const centerX = (node: { position: { x: number } } | undefined, width: number) => node!.position.x + width / 2;
  const STANDARD = 260;
  const EMAIL = 420;

  it('sits centred on the main column, under a standard card', () => {
    const { nodes } = workflowToFlow(null, [step('wait', 'delay'), step('mail', 'send_email')]);
    const wait = nodes.find((n) => n.id === 'wait');
    const mail = nodes.find((n) => n.id === 'mail');
    expect(centerX(mail, EMAIL)).toBe(centerX(wait, STANDARD));
  });

  it('sits centred under its branch', () => {
    const { nodes } = workflowToFlow(null, [
      step('l1', 'loop'),
      step('body', 'send_email', { parentBranchId: 'l1_each' } as Partial<WorkflowStep>),
    ]);
    expect(centerX(nodes.find((n) => n.id === 'body'), EMAIL)).toBe(centerX(nodes.find((n) => n.id === 'l1_each'), STANDARD));
  });

  it('keeps a saved position through a load and a save, and through a re-layout of a branch', () => {
    const saved = { x: 600, y: 400 };
    const { nodes, edges } = workflowToFlow({ id: 't', type: 'manual', name: 'Start', isEnabled: true, config: {} }, [
      step('mail', 'send_email', { position: saved }),
    ]);
    expect(centerX(nodes.find((n) => n.id === 'mail'), EMAIL)).toBe(saved.x + STANDARD / 2);
    expect(flowToWorkflow(nodes, edges).steps[0].position).toEqual(saved);

    const branch = workflowToFlow(null, [
      step('l1', 'loop'),
      step('body', 'send_email', { parentBranchId: 'l1_each' } as Partial<WorkflowStep>),
    ]);
    const before = branch.nodes.find((n) => n.id === 'body')!.position;
    expect(autoLayoutNodes(branch.nodes, branch.edges).find((n) => n.id === 'body')!.position).toEqual(before);
  });
});
