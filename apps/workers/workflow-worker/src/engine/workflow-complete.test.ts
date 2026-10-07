import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  chainInstanceId,
  chainedTriggerData,
  fireWorkflowCompleteTriggers,
  matchWorkflowCompleteTriggers,
  MAX_CHAIN_DEPTH,
  type CompletedRun,
  type WorkflowCandidate,
} from './workflow-complete';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import type { WorkflowEnv } from './types';

const wfcTrigger = (sourceWorkflowId: string, triggerOn: string, opts: { enabled?: boolean; passOutput?: boolean } = {}) => ({
  type: 'workflow_complete',
  isEnabled: opts.enabled ?? true,
  config: { sourceWorkflowId, triggerOn, passOutput: opts.passOutput },
});

describe('matchWorkflowCompleteTriggers', () => {
  const candidates: WorkflowCandidate[] = [
    { id: 'wfl_a', _source: 'weldconnect', triggers: [wfcTrigger('wfl_a', 'success')] }, // self → excluded
    { id: 'wfl_b', _source: 'weldconnect', triggers: [wfcTrigger('wfl_a', 'success')] }, // match on success
    { id: 'wfl_c', _source: 'weldconnect', triggers: [wfcTrigger('wfl_a', 'failure')] }, // no match on success
    { id: 'wfl_d', _source: 'helpdesk', triggers: [wfcTrigger('wfl_a', 'both', { passOutput: true })] }, // match
    { id: 'wfl_e', _source: 'weldconnect', triggers: [wfcTrigger('wfl_a', 'success', { enabled: false })] }, // disabled
    { id: 'wfl_f', _source: 'weldconnect', triggers: [wfcTrigger('wfl_other', 'success')] }, // wrong source id
    { id: 'wfl_g', _source: 'weldconnect', triggers: [{ type: 'manual', isEnabled: true }] }, // not a wfc trigger
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

  it('reads the editor\'s flat trigger shape, and treats a missing isEnabled as enabled', () => {
    const editorShaped: WorkflowCandidate[] = [
      { id: 'wfl_x', _source: 'weldconnect', triggers: [{ type: 'workflow_complete', sourceWorkflowId: 'wfl_a', triggerOn: 'failure', passOutput: true }] },
    ];
    expect(matchWorkflowCompleteTriggers(editorShaped, 'wfl_a', true)).toEqual([]);
    expect(matchWorkflowCompleteTriggers(editorShaped, 'wfl_a', false)).toEqual([
      { workflowId: 'wfl_x', source: 'weldconnect', passOutput: true },
    ]);
  });

  it('fires on success when the trigger has no outcome, and once per workflow', () => {
    const fired = matchWorkflowCompleteTriggers(
      [
        {
          id: 'wfl_y',
          _source: 'weldconnect',
          triggers: [
            { type: 'workflow_complete', sourceWorkflowId: 'wfl_a' },
            { type: 'workflow_complete', sourceWorkflowId: 'wfl_a', triggerOn: 'both' },
          ],
        },
      ],
      'wfl_a',
      true,
    );
    expect(fired).toEqual([{ workflowId: 'wfl_y', source: 'weldconnect', passOutput: false }]);
  });
});

const run = (overrides: Partial<CompletedRun> = {}): CompletedRun => ({
  workflowId: 'wf_source',
  workflowName: 'Source',
  executionId: 'wex_source_1',
  workspaceId: 'ws_1',
  userId: 'user_1',
  succeeded: true,
  output: { step_1: { contactId: 'ppl_1' } },
  chainDepth: 0,
  ...overrides,
});

describe('chainedTriggerData', () => {
  it('describes the finished run, with its output only when asked to', () => {
    expect(chainedTriggerData(run(), false)).toEqual({
      sourceWorkflowId: 'wf_source',
      sourceWorkflowName: 'Source',
      sourceExecutionId: 'wex_source_1',
      status: 'success',
    });
    expect(chainedTriggerData(run({ succeeded: false }), true)).toMatchObject({
      status: 'failure',
      output: { step_1: { contactId: 'ppl_1' } },
    });
  });
});

describe('fireWorkflowCompleteTriggers (pglite)', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    const base = { createdAt: new Date(), updatedAt: new Date(), steps: [] };
    // The editor stores the trigger settings flat (the db type only declares the nested shape).
    await db.insert(schema.workflows).values([
      { ...base, id: 'wf_source', name: 'Source', status: 'active', triggers: [] },
      {
        ...base,
        id: 'wf_next',
        name: 'Next',
        status: 'active',
        triggers: [{ id: 't1', type: 'workflow_complete', isEnabled: true, sourceWorkflowId: 'wf_source', triggerOn: 'success', passOutput: true }],
      },
      {
        ...base,
        id: 'wf_paused',
        name: 'Paused',
        status: 'paused',
        triggers: [{ id: 't1', type: 'workflow_complete', isEnabled: true, sourceWorkflowId: 'wf_source', triggerOn: 'both' }],
      },
    ] as unknown as Array<typeof schema.workflows.$inferInsert>);
  });

  function envWith(create: ReturnType<typeof vi.fn>): WorkflowEnv {
    return { EXECUTE_WORKFLOW: { create } } as WorkflowEnv;
  }

  it('starts each active downstream workflow once, with an idempotent instance id', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'x' });
    const dispatched = await fireWorkflowCompleteTriggers(envWith(create), db, run());

    expect(dispatched.map((d) => d.workflowId)).toEqual(['wf_next']); // the paused one is skipped
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      id: chainInstanceId('wex_source_1', 'wf_next'),
      params: {
        workspaceId: 'ws_1',
        userId: 'user_1',
        workflowId: 'wf_next',
        triggerType: 'workflow_complete',
        source: 'weldconnect',
        triggerData: {
          sourceWorkflowId: 'wf_source',
          sourceWorkflowName: 'Source',
          sourceExecutionId: 'wex_source_1',
          status: 'success',
          output: { step_1: { contactId: 'ppl_1' } },
        },
        chainDepth: 1,
      },
    });
  });

  it('does not chain a failed run into a success-only trigger', async () => {
    const create = vi.fn();
    await fireWorkflowCompleteTriggers(envWith(create), db, run({ succeeded: false }));
    expect(create).not.toHaveBeenCalled();
  });

  it('stops at the chain depth limit', async () => {
    const create = vi.fn();
    await fireWorkflowCompleteTriggers(envWith(create), db, run({ chainDepth: MAX_CHAIN_DEPTH }));
    expect(create).not.toHaveBeenCalled();
  });

  it('survives a refused dispatch (the chained run was already started by an earlier try)', async () => {
    const create = vi.fn().mockRejectedValue(new Error('instance already exists'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(fireWorkflowCompleteTriggers(envWith(create), db, run())).resolves.toHaveLength(1);
    warn.mockRestore();
  });
});

describe('chainInstanceId', () => {
  it('is stable per (run, workflow) and within Cloudflare\'s 100 characters', () => {
    expect(chainInstanceId('wex_abc', 'wf_def')).toBe('wex_abc-then-wf_def');
    expect(chainInstanceId('x'.repeat(80), 'y'.repeat(80))).toHaveLength(100);
  });
});
