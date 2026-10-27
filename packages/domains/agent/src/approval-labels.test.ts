import { describe, expect, it } from 'vitest';
import {
  approvalLabel,
  approvalRecipients,
  approvalsNotice,
  approvedOutcome,
  failedOutcome,
  heldForApprovalMessage,
  pendingApprovalsOf,
  rejectedOutcome,
} from './approval-labels';
import { PLATFORM_TOOLS } from './tools';
import { toolRiskLevel } from './parity';

describe('approval labels', () => {
  it('names the action and the record, never the tool', () => {
    expect(approvalLabel('create_task', { title: 'QA agent chat task' })).toBe('Create task "QA agent chat task"');
    expect(approvalLabel('create_person', { firstName: 'QA Agent', lastName: 'Testperson' })).toBe(
      'Create person "QA Agent Testperson"',
    );
    expect(approvalLabel('create_person', { email: 'qa@example.com' })).toBe('Create person "qa@example.com"');
    expect(approvalLabel('create_ticket', { subject: 'Printer is on fire' })).toBe('Create ticket "Printer is on fire"');
    expect(approvalLabel('create_spreadsheet', { name: 'Budget' })).toBe('Create spreadsheet "Budget"');
  });

  it('falls back to the bare action when there is no name, and to a generic one for an unknown tool', () => {
    expect(approvalLabel('create_task', {})).toBe('Create task');
    expect(approvalLabel('computer_exec', { command: 'rm -rf /tmp/x' })).toBe('Run a command in the sandbox');
    expect(approvalLabel('something_new', { a: 1 })).toBe('Run an action');
    expect(approvalLabel('create_task', null)).toBe('Create task');
  });

  it('cuts a very long name', () => {
    const label = approvalLabel('create_task', { title: 'x'.repeat(300) });
    expect(label.length).toBeLessThan(120);
    expect(label).toContain('…');
  });

  it('has a human action for every tool that is held for approval', () => {
    const held = PLATFORM_TOOLS.filter((tool) => toolRiskLevel(tool.name) === 'high');
    expect(held.length).toBeGreaterThan(0);
    for (const tool of held) {
      // Not the generic fallback, and never the tool's own name.
      expect(approvalLabel(tool.name, {})).not.toBe('Run an action');
      expect(approvalLabel(tool.name, {})).not.toContain('_');
    }
  });
});

describe('approval outcomes', () => {
  it('says what was done, from the result when the tool returned a name', () => {
    expect(approvedOutcome('create_task', { title: 'Follow up' }, { id: 'task_1', title: 'Follow up (1)' })).toBe(
      'Approved — created the task "Follow up (1)".',
    );
    expect(approvedOutcome('create_person', { firstName: 'QA' }, { id: 'per_1', fullName: 'QA Agent Testperson' })).toBe(
      'Approved — created the person "QA Agent Testperson".',
    );
    expect(approvedOutcome('create_task', { title: 'Follow up' }, { id: 'task_1' })).toBe(
      'Approved — created the task "Follow up".',
    );
    expect(approvedOutcome('something_new', {}, undefined)).toBe('Approved — ran that action.');
  });

  it('says what was rejected and what failed, in words', () => {
    expect(rejectedOutcome('create_task', { title: 'Follow up' })).toBe('Rejected — I did not create the task "Follow up".');
    expect(failedOutcome('create_ticket', { subject: 'Printer' }, 'db down')).toBe(
      'Approved, but I could not create the ticket "Printer": db down',
    );
  });

  it('never leaks a tool name or an id into any of them', () => {
    const texts = [
      approvedOutcome('create_task', { title: 'A' }, { id: 'task_1', title: 'A' }),
      rejectedOutcome('create_task', { title: 'A' }),
      failedOutcome('create_task', { title: 'A' }, 'x'),
      approvalLabel('create_task', { title: 'A' }),
    ];
    for (const text of texts) expect(text).not.toMatch(/create_task|task_1|apr_/);
  });
});

describe('what the model is told about a held action', () => {
  it('has no approval id, no tool name, and says what to tell the user', () => {
    const message = heldForApprovalMessage('Create task "QA agent chat task"');
    expect(message).toContain('Create task "QA agent chat task"');
    expect(message).toContain('waiting for their approval');
    expect(message).toContain('Do not mention ids');
    expect(message).not.toMatch(/apr_|create_task/);
  });
});

describe('approvals on a room reply', () => {
  it('reads the parked actions from the stored steps', () => {
    const approvals = pendingApprovalsOf([
      { result: { ok: true } },
      { result: { pendingApproval: true, approvalId: 'apr_1', label: 'Create task "A"', message: 'x' } },
      { result: { pendingApproval: true, approvalId: 'apr_2' } },
      { result: { pendingApproval: false, approvalId: 'apr_3' } },
      {},
    ]);
    expect(approvals).toEqual([
      { id: 'apr_1', label: 'Create task "A"', status: 'pending' },
      { id: 'apr_2', label: 'Run an action', status: 'pending' },
    ]);
  });

  it('writes a notice when the agent parked actions and said nothing else', () => {
    expect(
      approvalsNotice([
        { id: 'apr_1', label: 'Create task "A"', status: 'pending' },
        { id: 'apr_2', label: 'Create person "B"', status: 'pending' },
      ]),
    ).toBe('This needs your approval before I can do it: Create task "A"; Create person "B".');
  });
});

describe('approvalRecipients', () => {
  it('tells the owner, unless the owner asked in their own chat', () => {
    expect(approvalRecipients({ ownerId: 'u_owner', actorUserId: 'u_asker', inChannel: false })).toEqual(['u_owner']);
    expect(approvalRecipients({ ownerId: 'u_owner', actorUserId: 'u_owner', inChannel: false })).toEqual([]);
    expect(approvalRecipients({ ownerId: null, actorUserId: 'u_asker', inChannel: false })).toEqual([]);
  });

  it('also tells whoever asked in a room, where they have no chat to see it in', () => {
    expect(approvalRecipients({ ownerId: 'u_owner', actorUserId: 'u_asker', inChannel: true })).toEqual([
      'u_owner',
      'u_asker',
    ]);
    // The owner asking in a room is told once.
    expect(approvalRecipients({ ownerId: 'u_owner', actorUserId: 'u_owner', inChannel: true })).toEqual(['u_owner']);
    expect(approvalRecipients({ ownerId: 'u_owner', actorUserId: 'system', inChannel: true })).toEqual(['u_owner']);
  });
});
