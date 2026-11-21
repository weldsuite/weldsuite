/**
 * The SQL corpus (`sql-corpus.json`, see the README next to it): every SQL
 * statement the WeldPanel query layer sends to Basin, with the input that
 * produced it. The Rust backend reads it twice: a DataFusion test plans and
 * runs every statement, and the Rust compiler compiles every `compiler`
 * entry's input and compares the text byte for byte.
 *
 * This module is the contract: the input shapes (as Zod schemas, so a stored
 * input is checked when it is read back), how an input is compiled, and how
 * the file is written (sorted ids, sorted input keys, 2-space indent).
 */

import { z } from 'zod';
import { panelCohortFilterSchema, panelQuerySpecSchema, type ParsedTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import {
  panelComputedPropertyDefinitionSchema,
  panelCustomEventDefinitionSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { explainPanelChangeSchema } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import { activityCountQuery, activityQuery, lexiconQueries } from '../activity';
import type { PanelQueryContext } from '../context';
import { explainDimensions, explainQueries, explainWindows } from '../explain';
import { PANEL_EXPORT_TABLE_NAMES, exportPageQuery } from '../export';
import { runPanelQuery } from '../index';
import type { PanelSqlQuery, RawRow } from '../rows';
import { compareText } from '../sql';
import { resolveRange } from '../time';
import { trendsInterval } from '../trends';

export const CORPUS_VERSION = 1;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A {@link PanelQueryContext} as JSON: `now` (the frozen clock) is an ISO 8601 UTC string. */
export const corpusContextSchema = z
  .object({
    workspaceId: z.string(),
    projectId: z.string(),
    retentionDays: z.number(),
    hasIdentifiedUsers: z.boolean(),
    erasedIds: z.array(z.string()),
    cohorts: z.record(panelCohortFilterSchema).optional(),
    pageGroups: z.record(z.string()).optional(),
    favoriteSessionIds: z.array(z.string()).optional(),
    customEvents: z.record(panelCustomEventDefinitionSchema).optional(),
    computedProperties: z.record(panelComputedPropertyDefinitionSchema).optional(),
    pathRules: z.array(z.object({ pattern: z.string(), replacement: z.string() }).strict()).optional(),
    groupTypes: z.array(z.string()).optional(),
    now: z.string().datetime(),
  })
  .strict();
export type CorpusContext = z.output<typeof corpusContextSchema>;
export type CorpusContextDraft = z.input<typeof corpusContextSchema>;

const rowsSchema = z.array(z.record(z.unknown()));

/**
 * What a `compiler` entry compiles, by `call`:
 *
 * - `runPanelQuery`: a parsed spec through `runPanelQuery`. `responses` answer
 *   statements by name (a runner reads some results before it writes the next
 *   statement: breakdown values, auto-bucket ranges, signal candidates, the
 *   sessions page); a statement without a response gets no rows.
 * - `activityQuery`, `activityCountQuery`, `lexiconQueries`: ./activity.
 * - `exportPageQuery`: ./export, `from` and `to` as ISO 8601 instants.
 * - `explain`: panel-api's root-cause pipeline (`explainNumbers`): the request's
 *   spec without breakdowns and formulas, `resolveRange`, `explainWindows` (at
 *   `trendsInterval`), `explainDimensions`, `explainQueries`.
 */
export const corpusInputSchema = z.discriminatedUnion('call', [
  z
    .object({
      call: z.literal('runPanelQuery'),
      context: corpusContextSchema,
      spec: panelQuerySpecSchema,
      responses: z.record(rowsSchema),
    })
    .strict(),
  z
    .object({
      call: z.literal('activityQuery'),
      context: corpusContextSchema,
      options: z
        .object({
          sessionId: z.string().optional(),
          distinctId: z.string().optional(),
          days: z.number().int().optional(),
          limit: z.number().int(),
          excludeNames: z.array(z.string()).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ call: z.literal('activityCountQuery'), context: corpusContextSchema, distinctId: z.string(), days: z.number().int() }).strict(),
  z.object({ call: z.literal('lexiconQueries'), context: corpusContextSchema }).strict(),
  z
    .object({
      call: z.literal('exportPageQuery'),
      context: corpusContextSchema,
      page: z
        .object({
          table: z.enum(PANEL_EXPORT_TABLE_NAMES),
          from: z.string().datetime(),
          to: z.string().datetime(),
          after: z.object({ time: z.string(), keys: z.array(z.union([z.string(), z.number()])) }).strict().optional(),
          limit: z.number().int().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ call: z.literal('explain'), context: corpusContextSchema, request: explainPanelChangeSchema }).strict(),
]);
export type CorpusInput = z.output<typeof corpusInputSchema>;
export type CorpusInputDraft = z.input<typeof corpusInputSchema>;

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export interface CorpusStatement {
  name: string;
  sql: string;
  columns: string[];
}

export type CorpusSource = 'compiler' | 'panel-api';

export interface CorpusEntry {
  id: string;
  source: CorpusSource;
  /** `compiler`: a {@link CorpusInput} (keys sorted). `panel-api`: null. */
  input: unknown;
  statements: CorpusStatement[];
}

export interface CorpusFile {
  version: number;
  entries: CorpusEntry[];
}

export function toContext(context: CorpusContext): PanelQueryContext {
  return { ...context, now: new Date(context.now) };
}

export function statementOf(query: PanelSqlQuery): CorpusStatement {
  return { name: query.name, sql: query.sql, columns: [...query.columns] };
}

/** panel-api's root cause (`explainNumbers` in apps/workers/panel-api/src/services/explain.ts), without the cache and the runner. */
function explainStatements(request: Extract<CorpusInput, { call: 'explain' }>['request'], ctx: PanelQueryContext): PanelSqlQuery[] {
  const spec: ParsedTrendsSpec = { ...request.spec, breakdown: undefined, breakdowns: undefined, formulas: undefined, formulaOnly: undefined };
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const windows = explainWindows(ctx, range, trendsInterval(range, spec.interval), request);
  const dimensions = explainDimensions(ctx, request.properties, spec.cleanPaths);
  return explainQueries(spec, ctx, range, windows, dimensions, request.properties);
}

/** The statements an input compiles to, in the order they are sent. */
export async function compileInput(input: CorpusInput): Promise<PanelSqlQuery[]> {
  const ctx = toContext(input.context);
  switch (input.call) {
    case 'runPanelQuery': {
      const sent: PanelSqlQuery[] = [];
      await runPanelQuery(input.spec, ctx, async (query) => {
        sent.push(query);
        const rows: RawRow[] = input.responses[query.name] ?? [];
        return { rows };
      });
      return sent;
    }
    case 'activityQuery':
      return [activityQuery(ctx, input.options)];
    case 'activityCountQuery':
      return [activityCountQuery(ctx, input.distinctId, input.days)];
    case 'lexiconQueries':
      return lexiconQueries(ctx);
    case 'exportPageQuery': {
      const { table, from, to, after, limit } = input.page;
      return [exportPageQuery(ctx, { table, from: new Date(from), to: new Date(to), after, limit })];
    }
    case 'explain':
      return explainStatements(input.request, ctx);
  }
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

/** `value` with every object's keys sorted (code-unit order), arrays kept in order. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareText)
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/** A JSON copy: what a reader of the file gets back. */
export function jsonCopy(value: unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return copy;
}

/** The file's text: entries sorted by id, 2-space indent, trailing newline. */
export function serializeCorpus(entries: readonly CorpusEntry[]): string {
  const sorted = [...entries].sort((a, b) => compareText(a.id, b.id));
  const file: CorpusFile = {
    version: CORPUS_VERSION,
    entries: sorted.map((entry) => ({
      id: entry.id,
      source: entry.source,
      input: entry.input === null ? null : sortKeys(entry.input),
      statements: entry.statements.map((s) => ({ name: s.name, sql: s.sql, columns: [...s.columns] })),
    })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
