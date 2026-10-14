/**
 * Turns stored WeldAgent messages into what the chat renders: replies with
 * their tool steps, the questions the agent asked (`ask_user`) with the answer
 * the user gave, and the actions it parked for approval.
 */

import {
  ASK_USER_TOOL_NAME,
  parseAgentQuestion,
  type AgentQuestion,
} from '@weldsuite/app-api-client/schemas/weldagent-questions';
import type { WeldAgentMessage } from '@/hooks/queries/use-weldagent-queries';
import type { ToolStep } from '@/components/weldagent/chat/chat-message';

export interface ThreadQuestion {
  question: AgentQuestion;
  /** The user's next message, once they replied. */
  answer: string | null;
}

export interface ThreadApproval {
  approvalId: string;
  toolName: string;
}

export type ThreadItem =
  | { kind: 'user'; id: string; content: string }
  | {
      kind: 'assistant';
      id: string;
      content: string;
      steps: ToolStep[];
      questions: ThreadQuestion[];
      approvals: ThreadApproval[];
    };

interface Invocation {
  toolName: string;
  state: 'call' | 'result' | 'error';
  args?: unknown;
  result?: unknown;
}

function readInvocations(raw: unknown): Invocation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (inv): inv is Invocation =>
      !!inv &&
      typeof inv === 'object' &&
      typeof (inv as Invocation).toolName === 'string' &&
      ((inv as Invocation).state === 'result' || (inv as Invocation).state === 'error'),
  );
}

function pendingApprovalId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { pendingApproval?: unknown; approvalId?: unknown };
  return r.pendingApproval === true && typeof r.approvalId === 'string' ? r.approvalId : null;
}

function failed(inv: Invocation): boolean {
  if (inv.state === 'error') return true;
  const r = inv.result as { error?: unknown } | null | undefined;
  return !!r && typeof r === 'object' && typeof r.error === 'string';
}

export function buildThread(messages: WeldAgentMessage[]): ThreadItem[] {
  const visible = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  return visible.map((m, index): ThreadItem => {
    if (m.role === 'user') return { kind: 'user', id: m.id, content: m.content };

    const nextUser = visible.slice(index + 1).find((later) => later.role === 'user');
    const steps: ToolStep[] = [];
    const questions: ThreadQuestion[] = [];
    const approvals: ThreadApproval[] = [];

    for (const inv of readInvocations(m.toolInvocations)) {
      if (inv.toolName === ASK_USER_TOOL_NAME && !failed(inv)) {
        const question = parseAgentQuestion(inv.args);
        if (question) questions.push({ question, answer: nextUser?.content ?? null });
        continue;
      }
      const approvalId = pendingApprovalId(inv.result);
      if (approvalId) {
        approvals.push({ approvalId, toolName: inv.toolName });
        continue;
      }
      steps.push({ name: inv.toolName, failed: failed(inv) });
    }

    return { kind: 'assistant', id: m.id, content: m.content, steps, questions, approvals };
  });
}

/** The question waiting for an answer: one the agent asked after the user's last message. */
export function openQuestion(thread: ThreadItem[]): AgentQuestion | null {
  const last = thread[thread.length - 1];
  if (last?.kind !== 'assistant') return null;
  return last.questions.find((q) => q.answer === null)?.question ?? null;
}
