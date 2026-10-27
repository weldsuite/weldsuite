/**
 * Turns stored WeldAgent messages into what the chat renders: replies with
 * their tool steps, the work handed to sub-agents with their reports, the
 * questions the agent asked (`ask_user`) with the answer the user gave, and
 * the actions it parked for approval.
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

/** A routine the agent scheduled or changed in this reply (`create_routine` / `update_routine`). */
export interface ThreadRoutine {
  routineId: string;
  name: string;
  cronExpr: string | null;
  timezone: string | null;
  nextRunAt: string | null;
}

/** Stored invocation name of work handed to a sub-agent (agent-domain executor). */
export const DELEGATION_TOOL_NAME = 'delegate_to_agent';

/** Work the agent handed to a sub-agent in this reply, and what came back. */
export interface ThreadDelegation {
  agent: string;
  task: string;
  /** The sub-agent's report; null while it had not reported back. */
  report: string | null;
}

export type ThreadItem =
  | {
      kind: 'user';
      id: string;
      content: string;
      /** The reply to a question card: the card already shows it. */
      answersQuestion: boolean;
    }
  | {
      kind: 'assistant';
      id: string;
      content: string;
      createdAt: string;
      steps: ToolStep[];
      questions: ThreadQuestion[];
      approvals: ThreadApproval[];
      routines: ThreadRoutine[];
      delegations: ThreadDelegation[];
      /** Set when a routine run posted this message. */
      routineName: string | null;
    };

interface Invocation {
  toolName: string;
  state: 'call' | 'result' | 'error';
  args?: unknown;
  result?: unknown;
}

function isInvocation(inv: unknown): inv is Invocation {
  if (!inv || typeof inv !== 'object') return false;
  const { toolName, state } = inv as Invocation;
  return typeof toolName === 'string' && (state === 'call' || state === 'result' || state === 'error');
}

/**
 * The outcome of each tool call in a reply. A call is stored twice, as a
 * `call` entry and again as its `result` or `error`: the outcome replaces the
 * call, and a call that never finished is left out. The agent may also try to
 * ask a second question in one turn, which the server rejects with an `error`
 * entry of its own: while a question was asked, that rejection is not a
 * failure the user needs to see.
 */
export function readInvocations(raw: unknown): Invocation[] {
  if (!Array.isArray(raw)) return [];
  const waiting: Invocation[] = [];
  const outcomes: Invocation[] = [];
  for (const inv of raw.filter(isInvocation)) {
    if (inv.state === 'call') {
      waiting.push(inv);
      continue;
    }
    const call = waiting.findIndex((w) => w.toolName === inv.toolName);
    if (call >= 0) waiting.splice(call, 1);
    outcomes.push(inv);
  }
  const askedOk = outcomes.some((inv) => inv.toolName === ASK_USER_TOOL_NAME && !failed(inv));
  return askedOk ? outcomes.filter((inv) => inv.toolName !== ASK_USER_TOOL_NAME || !failed(inv)) : outcomes;
}

function pendingApprovalId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { pendingApproval?: unknown; approvalId?: unknown };
  return r.pendingApproval === true && typeof r.approvalId === 'string' ? r.approvalId : null;
}

function scheduledRoutine(inv: Invocation): ThreadRoutine | null {
  if ((inv.toolName !== 'create_routine' && inv.toolName !== 'update_routine') || inv.state !== 'result') return null;
  const r = inv.result as Partial<Record<string, unknown>> | null | undefined;
  if (!r || typeof r !== 'object' || r.ok !== true || typeof r.routineId !== 'string') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    routineId: r.routineId,
    name: text(r.name) ?? '',
    cronExpr: text(r.cronExpr),
    timezone: text(r.timezone),
    nextRunAt: text(r.nextRunAt),
  };
}

/**
 * Pair each task handed to a sub-agent with the report it sent back (both are
 * stored as `delegate_to_agent` invocations, in order).
 */
export function readDelegations(raw: unknown): ThreadDelegation[] {
  if (!Array.isArray(raw)) return [];
  const delegations: ThreadDelegation[] = [];
  for (const inv of raw as Invocation[]) {
    if (inv?.toolName === DELEGATION_TOOL_NAME) addDelegationStep(delegations, inv);
  }
  return delegations;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** A hand-off opens a step; a report closes the oldest open step for that agent. */
function addDelegationStep(delegations: ThreadDelegation[], inv: Invocation): void {
  const args = (inv.args ?? {}) as { agent?: unknown; task?: unknown };
  const agent = text(args.agent);
  if (inv.state === 'call') {
    delegations.push({ agent, task: text(args.task), report: null });
    return;
  }
  const report = text(inv.result);
  const open = delegations.find((d) => d.agent === agent && d.report === null);
  if (open) open.report = report;
  else delegations.push({ agent, task: '', report });
}

function routineNameOf(metadata: Record<string, unknown> | null | undefined): string | null {
  if (metadata?.kind !== 'routine_result') return null;
  return typeof metadata.routineName === 'string' ? metadata.routineName : '';
}

function failed(inv: Invocation): boolean {
  if (inv.state === 'error') return true;
  const r = inv.result as { error?: unknown } | null | undefined;
  return !!r && typeof r === 'object' && typeof r.error === 'string';
}

/** Message lists merged into one, deduplicated by id, oldest first (later lists win). */
export function mergeMessages(...lists: WeldAgentMessage[][]): WeldAgentMessage[] {
  const byId = new Map<string, WeldAgentMessage>();
  for (const list of lists) for (const m of list) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function buildThread(messages: WeldAgentMessage[]): ThreadItem[] {
  const visible = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  return visible.map((m, index): ThreadItem => {
    if (m.role === 'user') {
      const previous = visible[index - 1];
      return { kind: 'user', id: m.id, content: m.content, answersQuestion: asksQuestion(previous) };
    }

    const nextUser = visible.slice(index + 1).find((later) => later.role === 'user');
    const steps: ToolStep[] = [];
    const questions: ThreadQuestion[] = [];
    const approvals: ThreadApproval[] = [];
    const routines: ThreadRoutine[] = [];

    for (const inv of readInvocations(m.toolInvocations)) {
      if (inv.toolName === DELEGATION_TOOL_NAME) continue;
      const routine = scheduledRoutine(inv);
      if (routine) {
        routines.push(routine);
        continue;
      }
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

    return {
      kind: 'assistant',
      id: m.id,
      content: m.content,
      createdAt: m.createdAt,
      steps,
      questions,
      approvals,
      routines,
      delegations: readDelegations(m.toolInvocations),
      routineName: routineNameOf(m.metadata),
    };
  });
}

function asksQuestion(message: WeldAgentMessage | undefined): boolean {
  if (message?.role !== 'assistant') return false;
  return readInvocations(message.toolInvocations).some(
    (inv) => inv.toolName === ASK_USER_TOOL_NAME && !failed(inv) && parseAgentQuestion(inv.args) !== null,
  );
}

/** The question waiting for an answer: one the agent asked after the user's last message. */
export function openQuestion(thread: ThreadItem[]): AgentQuestion | null {
  const last = thread[thread.length - 1];
  if (last?.kind !== 'assistant') return null;
  return last.questions.find((q) => q.answer === null)?.question ?? null;
}

/** What a reply changed about the agent itself, so open screens can refetch it. */
export interface AgentChanges {
  /** Name, description, instructions or event subscriptions. */
  agent: boolean;
  routines: boolean;
  skills: boolean;
  memories: boolean;
}

const ROUTINE_TOOLS = new Set(['create_routine', 'update_routine', 'delete_routine']);

/** The edits the agent made to itself in a reply (`save_agent_setup`, routines, skills, memory). */
export function agentChangesIn(message: Pick<WeldAgentMessage, 'role' | 'toolInvocations'>): AgentChanges {
  const changes: AgentChanges = { agent: false, routines: false, skills: false, memories: false };
  if (message.role !== 'assistant') return changes;
  for (const inv of readInvocations(message.toolInvocations)) {
    if (failed(inv)) continue;
    if (inv.toolName === 'save_agent_setup') changes.agent = true;
    else if (ROUTINE_TOOLS.has(inv.toolName)) {
      changes.routines = true;
      changes.agent = true;
    } else if (inv.toolName === 'save_skill') changes.skills = true;
    else if (inv.toolName === 'remember') changes.memories = true;
  }
  return changes;
}
