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
    expect(user).toEqual({ kind: 'user', id: 'u1', content: 'Support work' });
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
    expect(openQuestion(thread)).toBeNull();
  });

  it('reports the question still waiting for an answer', () => {
    expect(openQuestion(buildThread([message('u1', 'user', 'Support'), asked]))).toEqual(question);
  });

  it('skips system messages and malformed questions', () => {
    const thread = buildThread([
      { ...message('s1', 'user', 'x'), role: 'system' },
      message('a2', 'assistant', 'Hm', [{ toolName: 'ask_user', state: 'result', args: { question: 'Hm?' } }]),
    ]);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ questions: [], steps: [] });
  });
});
