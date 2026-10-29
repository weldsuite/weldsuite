/**
 * The default WeldAgent: the chat assistant a person gets without picking a
 * workspace agent (home composer, /new-chat, the side panel).
 *
 * It runs on the AI gateway's free copilot model, not on Claude Managed
 * Agents, and has no agent row, so it has no grants. What it may read comes
 * from the person chatting: each read tool is registered only when that
 * person's own permissions cover it, and reads stay inside their row-level
 * scope (see ToolContext.rowScope).
 *
 * It writes in one place only: the spreadsheets the person points it at,
 * the one open next to the chat and the ones tagged in it. It gets the
 * spreadsheet tools limited to those sheets, with the person's own
 * `sheets:*` permissions and edit access to each sheet.
 *
 * This module is the pure part (which tools, the instructions, the text
 * stream); the routes own the model call and the credit metering.
 */

import { stepCountIs, tool, zodSchema, type FlexibleSchema, type ToolSet } from '@weldsuite/ai';
import type { AiOpenSheet } from '@weldsuite/app-api-client/schemas/ai';
import { getWorkspaceTimezone } from '@weldsuite/flow-domain/day-boundaries';
import type { WeldAgentEnv } from './env';
import { todayIn } from './read-helpers';
import { describeOpenSheet, sheetToolsLimitedTo } from './sheets-tools';
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

/** With a spreadsheet to work on: look at its tabs and cells, write, check, answer. */
export const PERSONA_SHEET_MAX_STEPS = 10;

/** A spreadsheet tagged in the chat (`<@sheet:id|Label>`). */
export interface PersonaTaggedSheet {
  id: string;
  label: string | null;
}

/** The spreadsheets the person points the persona at. */
export interface PersonaSheets {
  /** The one open next to the chat. */
  open?: AiOpenSheet | null;
  /** The ones tagged in the conversation. */
  tagged?: readonly PersonaTaggedSheet[];
}

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

/** Every permission key the persona consults: its tools' own (spreadsheets included), plus the row-level grants. */
export function personaPermissionKeys(): string[] {
  const keys = [...personaToolDefinitions(), ...sheetToolsLimitedTo([])].flatMap((definition) => definition.requiredPermissions);
  return [...new Set([...keys, SCOPE_PEOPLE, SCOPE_PROJECTS])];
}

/** The persona's tools this person may use: those whose permissions they all hold. */
export function selectPersonaTools(holds: PermissionCheck): PlatformToolDefinition[] {
  return personaToolDefinitions().filter((definition) => definition.requiredPermissions.every(holds));
}

/** The ids of the spreadsheets the person points at: the open one first, each once. */
export function personaSheetIds(sheets: PersonaSheets | undefined): string[] {
  const ids = [sheets?.open?.id, ...(sheets?.tagged ?? []).map((sheet) => sheet.id)].filter((id): id is string => !!id);
  return [...new Set(ids)];
}

/**
 * The spreadsheet tools for those sheets, as far as the person's permissions
 * go: reading needs `sheets:read`, writing `sheets:update` as well. None
 * without a sheet to work on.
 */
export function selectPersonaSheetTools(holds: PermissionCheck, sheets: PersonaSheets | undefined): PlatformToolDefinition[] {
  const ids = personaSheetIds(sheets);
  if (ids.length === 0 || !holds('sheets:read')) return [];
  return sheetToolsLimitedTo(ids).filter((definition) => definition.requiredPermissions.every(holds));
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
  '- If you have no tool for something, say so in one short sentence of your own, speaking as "I" (never "You cannot …"), ' +
  'and point to where it lives: that app, or a workspace agent from the agent menu. ' +
  'For example: "I can\'t see your notifications here — open the bell at the top right.", ' +
  '"I can\'t read your inbox here — open WeldMail.", "I can\'t create or change records here — pick a workspace agent from the agent menu." ' +
  'This covers notifications, the mail inbox, the calendar, meetings, files, accounting, commerce, and creating or changing any record. ' +
  'Never promise to check later.\n' +
  '- Never show internal ids (they look like prj_…, task_…, per_…), tool names or raw field names. ' +
  'Refer to records by their name, title or number.\n' +
  '- If the request lacks something you need (for example which contact to find), ask one short question.';

export interface PersonaSystemInput {
  tools: readonly PlatformToolDefinition[];
  /** Extra context from the client (the record the user is looking at). */
  extraSystem?: string;
  /** The spreadsheets the user points at; described when the spreadsheet tools are among `tools`. */
  sheets?: PersonaSheets;
  /** Today's date (`YYYY-MM-DD`) in the person's time zone. */
  today: string;
  timezone?: string | null;
}

/** How the persona works on the spreadsheets the user points at. */
function sheetsSection(sheets: PersonaSheets, canWrite: boolean): string {
  const lines: string[] = [];
  if (sheets.open) {
    lines.push(`${describeOpenSheet(sheets.open)} "This sheet", "here" and "the selection" refer to it.`);
  }
  const tagged = (sheets.tagged ?? []).filter((sheet) => sheet.id !== sheets.open?.id);
  if (tagged.length > 0) {
    const names = tagged.map((sheet) => {
      const name = sheet.label ? `"${sheet.label}"` : 'a spreadsheet';
      return `${name} (spreadsheetId ${sheet.id})`;
    });
    lines.push(`The user tagged: ${names.join(', ')}.`);
  }
  if (canWrite) {
    lines.push(
      'You can read and change these spreadsheets, and only these, with list_spreadsheet_tabs, read_spreadsheet_range and write_spreadsheet_range. ' +
        'Changing them is the one exception to the rule that you cannot change records.',
      '- Look before you write: read the tab first (read_spreadsheet_range without a range returns its used cells), so your changes fit its layout.',
      '- write_spreadsheet_range writes rows of values from a start cell. Text starting with "=" is a formula in English syntax, for example =SUM(B2:B9); null clears a cell.',
      '- Change cells only when the user asks for a change, and never overwrite filled cells they did not ask you to change.',
      '- After a write, say in one sentence what you changed and where (tab and cells). The change shows in the sheet at once and can be undone from version history.',
      '- If a write is refused because the user may only view the sheet, say so.',
    );
  } else {
    lines.push(
      'You can read these spreadsheets, and only these, with list_spreadsheet_tabs and read_spreadsheet_range. ' +
        'You cannot change them: the user has no permission to edit spreadsheets.',
    );
  }
  return `SPREADSHEETS\n${lines.join('\n')}`;
}

/** The persona's instructions for this person: the rules, what it can look up, and how. */
export function buildPersonaSystem(input: PersonaSystemInput): string {
  const has = (id: string) => input.tools.some((definition) => definition.id === id);
  const sections = [BASE_INSTRUCTIONS];
  const hasSheets = has('sheets.read_range') && !!input.sheets;

  const lookups = Object.entries(GUIDE_BY_TOOL)
    .filter(([id]) => has(id))
    .map(([, line]) => `- ${line}`);
  if (lookups.length > 0) {
    sections.push(`WHAT YOU CAN LOOK UP (read only)\n${lookups.join('\n')}`);
  } else if (hasSheets) {
    sections.push('WHAT YOU CAN LOOK UP\nOnly the spreadsheets below: you have no other lookup tools for this user.');
  } else {
    sections.push(
      'WHAT YOU CAN LOOK UP\nNothing: you have no lookup tools for this user, so you cannot read their workspace data here. Say so if they ask for it.',
    );
  }

  if (hasSheets && input.sheets) sections.push(sheetsSection(input.sheets, has('sheets.write_range')));

  if (has('tasks.list')) {
    const zone = input.timezone ? ` (${input.timezone})` : '';
    sections.push(
      'HOW\n' +
        '- "my" and "me" mean the signed-in user: for "my tasks" use list_tasks with assignedToMe=true.\n' +
        '- "What is on my plate today?": list_tasks with assignedToMe=true, includeDone=false and dueOnOrBefore set to today. ' +
        'That returns what is overdue or due today; when nothing is, say nothing is due today or overdue for them.\n' +
        '- "My open tasks": list_tasks with assignedToMe=true and includeDone=false, whatever the due date. ' +
        'When there are none, say they have no open tasks assigned to them; do not talk about today.\n' +
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
  /** The spreadsheets the person points at (open next to the chat, tagged in it). */
  sheets?: PersonaSheets;
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
  const readTools = selectPersonaTools(input.holds);
  const sheetTools = selectPersonaSheetTools(input.holds, input.sheets);
  const definitions = [...readTools, ...sheetTools];
  let timezone = input.timezone ?? null;
  if (readTools.length > 0 && !timezone) {
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
      sheets: sheetTools.length > 0 ? input.sheets : undefined,
      today: todayIn(timezone, input.now),
      timezone,
    }),
    tools: definitions.length > 0 ? buildPersonaToolSet(definitions, ctx) : undefined,
    stopWhen: stepCountIs(sheetTools.length > 0 ? PERSONA_SHEET_MAX_STEPS : PERSONA_MAX_STEPS),
    toolNames: definitions.map((definition) => definition.name),
  };
}

/**
 * Token usage added up over the model requests that ran, for billing a reply
 * that was cut short (the SDK only reports the total of a reply that finished).
 */
export function sumStepUsage(
  steps: ReadonlyArray<{ usage: { inputTokens?: number; outputTokens?: number } }>,
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
