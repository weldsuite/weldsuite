import { describe, expect, it } from 'vitest';
import { summarizeSequences, summarizeWorkflowSends } from './automation';
import { correspondents } from './__fixtures__/rows';
import type { SequenceStepRow, WorkflowStepGroup } from './types';

describe('summarizeSequences', () => {
  const steps: SequenceStepRow[] = [
    { at: new Date('2026-10-10T08:00:00Z'), status: 'completed', recipient: 'lead1@prospect.io', sequenceId: 'seq1' },
    { at: new Date('2026-10-10T09:00:00Z'), status: 'completed', recipient: 'client1@customer.org', sequenceId: 'seq1' },
    { at: new Date('2026-10-11T09:00:00Z'), status: 'completed', recipient: null, sequenceId: 'seq2' },
    { at: new Date('2026-10-11T10:00:00Z'), status: 'failed', recipient: 'lead2@prospect.io', sequenceId: 'seq2' },
    { at: new Date('2026-10-12T10:00:00Z'), status: 'running', recipient: 'lead3@prospect.io', sequenceId: 'seq3' },
  ];
  const summary = summarizeSequences(
    steps,
    [
      { day: '2026-10-09', sequenceId: 'seq1', count: 3 },
      { day: '2026-10-10', sequenceId: 'seq2', count: 2 },
      { day: '2026-10-10', sequenceId: 'seq1', count: 1 },
    ],
    correspondents(),
    5,
  );

  it('counts completed and failed send_email steps per day', () => {
    expect(summary).toMatchObject({ sent: 3, failed: 1, otherSteps: 1, sequences: 2 });
    expect(summary.days).toEqual([
      { day: '2026-10-10', sent: 2, failed: 0 },
      { day: '2026-10-11', sent: 1, failed: 1 },
    ]);
  });

  it('uses the enrolled contact for first contact and domains', () => {
    expect(summary).toMatchObject({ recipientsKnown: 2, distinctRecipients: 2, firstContactRecipients: 1, distinctFirstContact: 1 });
    expect(summary.topDomains).toEqual([
      { domain: 'customer.org', recipients: 1 },
      { domain: 'prospect.io', recipients: 1 },
    ]);
  });

  it('sums enrolments per day and sequence', () => {
    expect(summary.enrollments).toEqual({
      total: 6,
      sequences: 2,
      days: [
        { day: '2026-10-09', count: 3 },
        { day: '2026-10-10', count: 3 },
      ],
    });
  });
});

describe('summarizeWorkflowSends', () => {
  const groups: WorkflowStepGroup[] = [
    { day: '2026-10-10', status: 'completed', workflowId: 'wf1', runs: null, runFailure: null, steps: 5 },
    { day: '2026-10-10', status: 'completed', workflowId: 'wf2', runs: 40, runFailure: null, steps: 1 },
    { day: '2026-10-11', status: 'failed', workflowId: 'wf2', runs: null, runFailure: '3 of 10', steps: 1 },
    { day: '2026-10-11', status: 'failed', workflowId: 'wf3', runs: null, runFailure: null, steps: 2 },
    { day: '2026-10-12', status: 'skipped', workflowId: 'wf4', runs: null, runFailure: null, steps: 1 },
  ];

  it('counts single sends, loop iterations and the sends of a loop that carried on past failures', () => {
    const summary = summarizeWorkflowSends(groups);
    expect(summary).toEqual({
      sent: 52,
      failedSteps: 3,
      workflows: 2,
      days: [
        { day: '2026-10-10', sent: 45, failed: 0 },
        { day: '2026-10-11', sent: 7, failed: 3 },
      ],
    });
  });

  it('is empty without rows', () => {
    expect(summarizeWorkflowSends([])).toEqual({ sent: 0, failedSteps: 0, workflows: 0, days: [] });
  });
});
