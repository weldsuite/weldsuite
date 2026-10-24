import { describe, expect, it } from 'vitest';
import type { WeldAgentMessage } from '@/hooks/queries/use-weldagent-queries';
import { buildThread, openQuestion } from './thread';

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
