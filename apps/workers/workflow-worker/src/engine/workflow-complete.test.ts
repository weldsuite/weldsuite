import { describe, it, expect } from 'vitest';
import { matchWorkflowCompleteTriggers, type WorkflowCandidate } from './workflow-complete';

const wfcTrigger = (sourceWorkflowId: string, triggerOn: string, opts: { enabled?: boolean; passOutput?: boolean } = {}) => ({
  type: 'workflow_complete',
  isEnabled: opts.enabled ?? true,
  config: { sourceWorkflowId, triggerOn, passOutput: opts.passOutput },
});

describe('matchWorkflowCompleteTriggers', () => {
  const candidates: WorkflowCandidate[] = [
    { id: 'wfl_a', _source: 'task', triggers: [wfcTrigger('wfl_a', 'success')] }, // self → excluded
    { id: 'wfl_b', _source: 'task', triggers: [wfcTrigger('wfl_a', 'success')] }, // match on success
    { id: 'wfl_c', _source: 'task', triggers: [wfcTrigger('wfl_a', 'failure')] }, // no match on success
    { id: 'wfl_d', _source: 'helpdesk', triggers: [wfcTrigger('wfl_a', 'both', { passOutput: true })] }, // match
    { id: 'wfl_e', _source: 'task', triggers: [wfcTrigger('wfl_a', 'success', { enabled: false })] }, // disabled
    { id: 'wfl_f', _source: 'task', triggers: [wfcTrigger('wfl_other', 'success')] }, // wrong source id
    { id: 'wfl_g', _source: 'task', triggers: [{ type: 'manual', isEnabled: true }] }, // not a wfc trigger
  ];

  it('matches enabled workflow_complete triggers pointing at the completed workflow on success', () => {
    const fired = matchWorkflowCompleteTriggers(candidates, 'wfl_a', true).map((d) => d.workflowId);
    expect(fired.sort()).toEqual(['wfl_b', 'wfl_d']);
  });

  it('matches failure + both when the run failed', () => {
    const fired = matchWorkflowCompleteTriggers(candidates, 'wfl_a', false).map((d) => d.workflowId);
    expect(fired.sort()).toEqual(['wfl_c', 'wfl_d']);
  });

  it('carries source + passOutput through', () => {
    const d = matchWorkflowCompleteTriggers(candidates, 'wfl_a', true).find((x) => x.workflowId === 'wfl_d');
    expect(d).toMatchObject({ source: 'helpdesk', passOutput: true });
  });

  it('returns nothing when no candidate references the completed workflow', () => {
    expect(matchWorkflowCompleteTriggers(candidates, 'wfl_nobody', true)).toEqual([]);
  });
});
