import { describe, expect, it } from 'vitest';
import type { WeldAgentMessage } from '@/hooks/queries/use-weldagent-queries';
import { agentChangesIn, buildThread, mergeMessages, openQuestion, readInvocations } from './thread';

const question = { question: 'When should I act?', options: [{ label: 'Daily' }, { label: 'On new tickets' }] };

function message(id: string, role: 'user' | 'assistant', content: string, toolInvocations?: unknown[]): WeldAgentMessage {
  return { id, conversationId: 'conv', role, content, toolInvocations, createdAt: '2026-10-14T00:00:00Z' };
}

const asked = message('a1', 'assistant', 'Got it.', [
  { toolName: 'ask_user', state: 'call', args: question },
  { toolName: 'ask_user', state: 'result', args: question, result: { ok: true } },
  { toolName: 'list_tickets', state: 'result', args: {}, result: [] },
  { toolName: 'create_ticket', state: 'result', args: {}, result: { pendingApproval: true, approvalId: 'apr_1' } },
  { toolName: 'create_task', state: 'error', args: {}, result: { error: 'nope' } },
]);

describe('buildThread', () => {
  it('splits a reply into questions, approvals and tool steps', () => {
    const [user, reply] = buildThread([message('u1', 'user', 'Support work'), asked]);
    expect(user).toEqual({ kind: 'user', id: 'u1', content: 'Support work', answersQuestion: false });
    expect(reply).toMatchObject({
      kind: 'assistant',
      questions: [{ question, answer: null }],
      approvals: [{ approvalId: 'apr_1', toolName: 'create_ticket' }],
      steps: [
        { name: 'list_tickets', failed: false },
        { name: 'create_task', failed: true },
      ],
    });
  });

  it('pairs a question with the reply that followed it', () => {
    const thread = buildThread([message('u1', 'user', 'Support'), asked, message('u2', 'user', 'Daily')]);
    expect(thread[1]).toMatchObject({ questions: [{ answer: 'Daily' }] });
    expect(thread[2]).toMatchObject({ kind: 'user', answersQuestion: true });
    expect(openQuestion(thread)).toBeNull();
  });

  it('reports the question still waiting for an answer', () => {
    expect(openQuestion(buildThread([message('u1', 'user', 'Support'), asked]))).toEqual(question);
  });

  it('turns create_routine into a routine card and labels routine posts', () => {
    const [reply, posted] = buildThread([
      message('a1', 'assistant', 'Done.', [
        {
          toolName: 'create_routine',
          state: 'result',
          args: {},
          result: { ok: true, routineId: 'rtn_1', name: 'Digest', cronExpr: '0 7 * * 1-5', timezone: 'Europe/Amsterdam', nextRunAt: '2026-10-16T05:00:00Z' },
        },
      ]),
      { ...message('a2', 'assistant', '3 overdue'), metadata: { kind: 'routine_result', routineName: 'Digest' } },
    ]);
    expect(reply).toMatchObject({
      steps: [],
      routines: [{ routineId: 'rtn_1', name: 'Digest', cronExpr: '0 7 * * 1-5', timezone: 'Europe/Amsterdam' }],
      routineName: null,
    });
    expect(posted).toMatchObject({ routineName: 'Digest' });
  });

  it('skips system messages and malformed questions', () => {
    const thread = buildThread([
      { ...message('s1', 'user', 'x'), role: 'system' },
      message('a2', 'assistant', 'Hm', [{ toolName: 'ask_user', state: 'result', args: { question: 'Hm?' } }]),
    ]);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ questions: [], steps: [] });
  });

  it('keeps messages that slide out of the live window once older pages are loaded', () => {
    const at = (id: string, minute: number) => ({
      ...message(id, 'user', id),
      createdAt: `2026-10-14T00:${String(minute).padStart(2, '0')}:00.000Z`,
    });
    const olderPage = [at('m1', 1), at('m2', 2)];
    const firstWindow = [at('m3', 3), at('m4', 4)];
    const kept = mergeMessages(olderPage, firstWindow);
    // Two new messages push m3 and m4 out of the newest-page window.
    const nextWindow = [at('m5', 5), at('m6', 6)];
    expect(mergeMessages(mergeMessages(kept, nextWindow), nextWindow).map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
    ]);
  });

  it('pairs work handed to sub-agents with their reports, apart from tool steps', () => {
    const [reply] = buildThread([
      message('a1', 'assistant', 'Both are done.', [
        { toolName: 'delegate_to_agent', state: 'call', args: { agent: 'Researcher', task: 'Find invoices' } },
        { toolName: 'delegate_to_agent', state: 'call', args: { agent: 'Writer', task: 'Draft a mail' } },
        { toolName: 'delegate_to_agent', state: 'result', args: { agent: 'Writer' }, result: 'Drafted.' },
        { toolName: 'list_people', state: 'result', args: {}, result: [] },
      ]),
    ]);
    expect(reply).toMatchObject({
      steps: [{ name: 'list_people', failed: false }],
      delegations: [
        { agent: 'Researcher', task: 'Find invoices', report: null },
        { agent: 'Writer', task: 'Draft a mail', report: 'Drafted.' },
      ],
    });
  });
});

describe('readInvocations', () => {
  it('folds a call and its outcome into one entry', () => {
    const entries = readInvocations([
      { toolName: 'list_people', state: 'call', args: {} },
      { toolName: 'list_people', state: 'result', args: {}, result: [] },
      { toolName: 'create_task', state: 'call', args: {} },
      { toolName: 'create_task', state: 'error', args: {}, result: { error: 'nope' } },
      { toolName: 'list_tickets', state: 'call', args: {} },
    ]);
    expect(entries.map((e) => [e.toolName, e.state])).toEqual([
      ['list_people', 'result'],
      ['create_task', 'error'],
    ]);
  });

  it('does not count a rejected second question as a failed tool', () => {
    const [reply] = buildThread([
      message('a1', 'assistant', 'One question.', [
        { toolName: 'ask_user', state: 'call', args: question },
        { toolName: 'ask_user', state: 'result', args: question, result: { ok: true } },
        {
          toolName: 'ask_user',
          state: 'error',
          args: { question: 'And another?', options: question.options },
          result: { error: 'You already asked a question this turn' },
        },
      ]),
    ]);
    expect(reply).toMatchObject({ kind: 'assistant', steps: [], questions: [{ question, answer: null }] });
  });

  it('still reports a question that failed outright', () => {
    const [reply] = buildThread([
      message('a1', 'assistant', 'Hm', [
        { toolName: 'ask_user', state: 'error', args: {}, result: { error: 'Invalid question' } },
      ]),
    ]);
    expect(reply).toMatchObject({ steps: [{ name: 'ask_user', failed: true }] });
  });
});

describe('agentChangesIn', () => {
  it('spots the edits an agent made to itself', () => {
    const reply = message('a1', 'assistant', 'Saved.', [
      { toolName: 'save_agent_setup', state: 'result', args: {}, result: { ok: true } },
      { toolName: 'create_routine', state: 'result', args: {}, result: { ok: true, routineId: 'rtn_1' } },
      { toolName: 'remember', state: 'result', args: {}, result: { ok: true } },
    ]);
    expect(agentChangesIn(reply)).toEqual({ agent: true, routines: true, skills: false, memories: true });
  });

  it('ignores failed calls and user messages', () => {
    const failedSave = message('a1', 'assistant', 'Oops', [
      { toolName: 'save_agent_setup', state: 'error', args: {}, result: { error: 'no' } },
    ]);
    expect(agentChangesIn(failedSave)).toEqual({ agent: false, routines: false, skills: false, memories: false });
    expect(agentChangesIn(message('u1', 'user', 'hi'))).toEqual({
      agent: false,
      routines: false,
      skills: false,
      memories: false,
    });
  });
});
