/**
 * The default WeldAgent: the chat assistant a person gets without picking a
 * workspace agent (home composer, /new-chat, the side panel).
 *
 * It runs on the AI gateway's free copilot model, not on Claude Managed
 * Agents, and has no agent row, so it has no grants. What it may read comes
 * from the person chatting: each read tool is registered only when that
 * person's own permissions cover it, and reads stay inside their row-level
 * scope (see ToolContext.rowScope). It never writes.
 *
 * This module is the pure part (which tools, the instructions, the text
 * stream); the routes own the model call and the credit metering.
 */

import { stepCountIs, tool, zodSchema, type FlexibleSchema, type ToolSet } from '@weldsuite/ai';
import { getWorkspaceTimezone } from '@weldsuite/flow-domain/day-boundaries';
import type { WeldAgentEnv } from './env';
import { todayIn } from './read-helpers';
import {
  PLATFORM_TOOLS,
  agentHasGrants,
  type AgentDb,
  type PlatformToolDefinition,
  type ToolContext,
  type ToolRowScope,
} from './tools';

/** Stands in for the agent id the tools attribute work to (the read tools attribute nothing). */
export const PERSONA_AGENT_ID = 'agt_weldagent_default';

/** Model requests one reply may take: a few lookups, then the answer. */
export const PERSONA_MAX_STEPS = 6;

/** The only tools the default WeldAgent has, all read-only. */
export const PERSONA_TOOL_IDS: readonly string[] = [
  'people.list',
  'people.get',
  'tickets.list',
  'tasks.list',
  'projects.list',
  'projects.get',
];

/** The row-level grants that widen what a person sees to everyone's records. */
const SCOPE_PEOPLE = 'people:scope:all';
const SCOPE_PROJECTS = 'projects:scope:all';

/** Whether the person holds one permission key. */
export type PermissionCheck = (key: string) => boolean;

/** A {@link PermissionCheck} over a resolved permission list (wildcards and per-app grants count). */
export function holdsPermissions(permissions: readonly string[]): PermissionCheck {
  const held = [...permissions];
  return (key) => agentHasGrants(held, [key]);
}

function personaToolDefinitions(): PlatformToolDefinition[] {
  return PLATFORM_TOOLS.filter((definition) => PERSONA_TOOL_IDS.includes(definition.id));
}

/** Every permission key the persona consults: its tools' own, plus the row-level grants. */
export function personaPermissionKeys(): string[] {
  const keys = personaToolDefinitions().flatMap((definition) => definition.requiredPermissions);
  return [...new Set([...keys, SCOPE_PEOPLE, SCOPE_PROJECTS])];
}

/** The persona's tools this person may use: those whose permissions they all hold. */
export function selectPersonaTools(holds: PermissionCheck): PlatformToolDefinition[] {
  return personaToolDefinitions().filter((definition) => definition.requiredPermissions.every(holds));
}

/** The row-level boundary the persona's reads stay inside for this person. */
export function personaRowScope(userId: string, holds: PermissionCheck): ToolRowScope {
  return { userId, allPeople: holds(SCOPE_PEOPLE), allProjects: holds(SCOPE_PROJECTS) };
}

const TOOL_FAILED = { error: 'The lookup failed. Say you could not check it right now; do not guess.' };

/** The AI SDK tool set for these definitions, each run against `ctx`. A failing tool answers the model with an error, it does not end the reply. */
export function buildPersonaToolSet(definitions: readonly PlatformToolDefinition[], ctx: ToolContext): ToolSet {
  const tools: ToolSet = {};
  for (const definition of definitions) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: zodSchema(definition.parameters as never) as FlexibleSchema<unknown>,
      execute: async (input: unknown) => {
        try {
          return await definition.execute(ctx, input);
        } catch (err) {
          console.warn(`[weldagent/persona] ${definition.name} failed:`, err instanceof Error ? err.message : err);
          return TOOL_FAILED;
        }
      },
    });
  }
  return tools;
}

const GUIDE_BY_TOOL: Record<string, string> = {
  'people.list': 'contacts and people in the CRM: list_people (search by name or email), get_person',
  'tickets.list': 'helpdesk tickets: list_tickets',
  'tasks.list': 'tasks: list_tasks',
  'projects.list': 'projects and how many tasks they have: list_projects, get_project',
};

const BASE_INSTRUCTIONS =
  'You are WeldAgent, the AI assistant built into the WeldSuite business platform. ' +
  'Be concise, direct and practical. Use plain text, no markdown headings, and keep answers short unless the user asks for detail.\n\n' +
  'RULES\n' +
  "- For any question about the user's workspace data, call your tools first, then answer from what they return. " +
  'Do not write text before calling a tool, and never say you are going to look something up without doing it.\n' +
  '- Only state counts, names, records, dates, notifications or emails that a tool returned in this conversation. ' +
  'Never guess, estimate or invent an example. If a tool returns nothing, say so plainly.\n' +
  '- If you have no tool for something, say so in one sentence: you cannot see or do that from here. ' +
  'Then point to where it lives: open that app, or pick a workspace agent from the agent menu. ' +
  'This covers notifications, the mail inbox, the calendar, meetings, files, accounting, commerce, and creating or changing any record. ' +
  'Never promise to check later.\n' +
  '- Never show internal ids (they look like prj_…, task_…, per_…), tool names or raw field names. ' +
  'Refer to records by their name, title or number.\n' +
  '- If the request lacks something you need (for example which contact to find), ask one short question.';

export interface PersonaSystemInput {
  tools: readonly PlatformToolDefinition[];
  /** Extra context from the client (the record the user is looking at). */
  extraSystem?: string;
  /** Today's date (`YYYY-MM-DD`) in the person's time zone. */
  today: string;
  timezone?: string | null;
}

/** The persona's instructions for this person: the rules, what it can look up, and how. */
export function buildPersonaSystem(input: PersonaSystemInput): string {
  const has = (id: string) => input.tools.some((definition) => definition.id === id);
  const sections = [BASE_INSTRUCTIONS];

  const lookups = Object.entries(GUIDE_BY_TOOL)
    .filter(([id]) => has(id))
    .map(([, line]) => `- ${line}`);
  if (lookups.length === 0) {
    sections.push(
      'WHAT YOU CAN LOOK UP\nNothing: you have no lookup tools for this user, so you cannot read their workspace data here. Say so if they ask for it.',
    );
  } else {
    sections.push(`WHAT YOU CAN LOOK UP (read only)\n${lookups.join('\n')}`);
  }

  if (has('tasks.list')) {
    const zone = input.timezone ? ` (${input.timezone})` : '';
    sections.push(
      'HOW\n' +
        '- "my" and "me" mean the signed-in user: for "my tasks" use list_tasks with assignedToMe=true.\n' +
        '- "What is on my plate today?": list_tasks with assignedToMe=true, includeDone=false and dueOnOrBefore set to today. ' +
        'That returns what is overdue or due today; say plainly when nothing is.\n' +
        '- "My open tasks": list_tasks with assignedToMe=true and includeDone=false.\n' +
        (has('projects.get') ? '- "How many tasks are in project X": get_project by name and report its task counts.\n' : '') +
        `- Today is ${input.today}${zone}.`,
    );
  }

  if (input.extraSystem) sections.push(input.extraSystem);
  return sections.join('\n\n');
}

export interface PersonaCallInput {
  db: AgentDb;
  workspaceId: string;
  userId: string;
  env?: WeldAgentEnv;
  holds: PermissionCheck;
  /** Extra context from the client, appended to the instructions. */
  extraSystem?: string;
  /** The person's IANA time zone, when the client sent one. */
  timezone?: string | null;
  now?: Date;
}

export interface PersonaCall {
  system: string;
  /** Undefined when this person may read nothing the persona offers. */
  tools: ToolSet | undefined;
  stopWhen: ReturnType<typeof stepCountIs>;
  /** The model-facing names of the tools offered. */
  toolNames: string[];
}

/** Everything a persona model call needs besides the model and the messages. */
export async function buildPersonaCall(input: PersonaCallInput): Promise<PersonaCall> {
  const definitions = selectPersonaTools(input.holds);
  let timezone = input.timezone ?? null;
  if (definitions.length > 0 && !timezone) {
    timezone = await getWorkspaceTimezone(input.db).catch(() => null);
  }
  const ctx: ToolContext = {
    db: input.db,
    agentId: PERSONA_AGENT_ID,
    actorUserId: input.userId,
    workspaceId: input.workspaceId,
    env: input.env,
    userTimezone: timezone,
    rowScope: personaRowScope(input.userId, input.holds),
  };
  return {
    system: buildPersonaSystem({
      tools: definitions,
      extraSystem: input.extraSystem || undefined,
      today: todayIn(timezone, input.now),
      timezone,
    }),
    tools: definitions.length > 0 ? buildPersonaToolSet(definitions, ctx) : undefined,
    stopWhen: stepCountIs(PERSONA_MAX_STEPS),
    toolNames: definitions.map((definition) => definition.name),
  };
}

/**
 * Token usage added up over the model requests that ran, for billing a reply
 * that was cut short (the SDK only reports the total of a reply that finished).
 */
export function sumStepUsage(
  steps: ReadonlyArray<{ usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }>,
): { inputTokens: number; outputTokens: number; totalTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const step of steps) {
    inputTokens += step.usage.inputTokens ?? 0;
    outputTokens += step.usage.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** What the person sees when the model returned no text (a lookup that never got an answer, a failed stream). */
export const PERSONA_FALLBACK_TEXT = "Sorry, I couldn't finish that. Please try again.";

/** The reply text for a finished call, never empty. */
export function personaReplyText(text: string): string {
  return text.trim() ? text : PERSONA_FALLBACK_TEXT;
}

interface StreamPart {
  type: string;
  text?: string;
}

/**
 * The model's text as the plain text stream the chat client reads. A reply
 * with lookups spans several model requests; the text of one request is set
 * apart from the next by a blank line, and an empty reply becomes
 * {@link PERSONA_FALLBACK_TEXT} instead of nothing.
 */
export function createPersonaTextTransform(): TransformStream<StreamPart, string> {
  let emitted = false;
  let stepHadText = false;
  let separate = false;
  return new TransformStream<StreamPart, string>({
    transform(part, controller) {
      if (part.type === 'text-delta' && part.text) {
        if (separate) {
          controller.enqueue('\n\n');
          separate = false;
        }
        controller.enqueue(part.text);
        emitted = true;
        stepHadText = true;
      } else if (part.type === 'finish-step') {
        if (stepHadText) separate = true;
        stepHadText = false;
      }
    },
    flush(controller) {
      if (!emitted) controller.enqueue(PERSONA_FALLBACK_TEXT);
    },
  });
}
