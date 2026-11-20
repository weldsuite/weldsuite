/**
 * Display tools: the model shows a chart, stat tiles, a table or record cards
 * by calling one of these with a spec (ADR AGENT-017). The tool only checks
 * the spec; the runtime puts the visual into the reply (a stream marker, see
 * `@weldsuite/app-api-client/schemas/chat-visuals`) and each client draws it.
 *
 * Every agent and the default WeldAgent get them; they read and change
 * nothing, so they need no permission.
 */

import type { z } from 'zod';
import {
  SHOW_VISUAL_TOOLS,
  showChartInputSchema,
  showRecordsInputSchema,
  showStatsInputSchema,
  showTableInputSchema,
  visualFromToolCall,
  type ChatVisual,
  type ShowVisualToolName,
} from '@weldsuite/app-api-client/schemas/chat-visuals';
import type { PlatformToolDefinition } from './tools';

/** Said after every shown visual, so the reply does not repeat it. */
const SHOWN_HINT =
  'The visual is on screen now, where you called the tool. Do not repeat its numbers as a list or markdown table; ' +
  'add at most a sentence or two on what stands out.';

function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ');
}

function displayTool(
  name: ShowVisualToolName,
  description: string,
  parameters: z.ZodTypeAny,
): PlatformToolDefinition {
  return {
    id: `agent.${name}`,
    name,
    description,
    requiredPermissions: [],
    parameters,
    async execute(_ctx, raw) {
      const parsed = parameters.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `The visual was not shown: ${issuesText(parsed.error)}. Fix the spec and call again.` };
      }
      return { ok: true, shownToUser: true, hint: SHOWN_HINT };
    },
  };
}

const KEEP_SMALL = 'Use only data your tools returned or the user gave; never invent numbers. ';

export const VISUAL_TOOLS: PlatformToolDefinition[] = [
  displayTool(
    'show_chart',
    'Show the user a chart in the chat. Use it when a picture answers better than words: comparing categories ' +
      '(bar), a trend over time (line or area), or parts of a whole (pie or donut, up to 8 slices). ' +
      KEEP_SMALL +
      'Give one value per label in each series; keep it to a few series and at most a few dozen labels.',
    showChartInputSchema,
  ),
  displayTool(
    'show_stats',
    'Show the user a row of key figures (stat tiles), e.g. revenue, open tickets, win rate, each with an optional ' +
      'change vs the previous period. Use it for 1 to 8 headline numbers. ' +
      KEEP_SMALL,
    showStatsInputSchema,
  ),
  displayTool(
    'show_table',
    'Show the user a table in the chat, for row-by-row detail that does not fit a chart: several columns per item, ' +
      'up to 100 rows. Prefer it over a markdown table when there are more than a few rows or columns. ' +
      KEEP_SMALL +
      'Pass columns once and each row as an array of cells in column order.',
    showTableInputSchema,
  ),
  displayTool(
    'show_records',
    'Show the user workspace records as cards they can click to open: tickets, tasks, deals (opportunity), leads, ' +
      'projects, invoices and the like. Use it when your answer is a short list of records (up to 20). ' +
      'Only use ids your tools returned.',
    showRecordsInputSchema,
  ),
];

export const VISUAL_TOOL_IDS: readonly string[] = VISUAL_TOOLS.map((tool) => tool.id);

/** The visual a successful `show_*` call shows, or null. */
export function shownVisual(name: string, args: unknown, result?: unknown): ChatVisual | null {
  if (!(name in SHOW_VISUAL_TOOLS)) return null;
  if (result !== undefined && (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true)) {
    return null;
  }
  return visualFromToolCall(name, args);
}
