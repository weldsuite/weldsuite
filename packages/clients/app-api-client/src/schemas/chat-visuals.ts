/**
 * Chat visuals — charts, stat tiles, tables and record cards an AI reply can
 * show (ADR AGENT-016). Shared by the agent runtime (the `show_*` tools and
 * the stream marker), the platform and the mobile apps (the renderers).
 *
 * The model never writes markup: it calls a `show_*` tool with a spec, the
 * spec is validated here, and each client draws it with its own components.
 * Colours are never part of a spec; series take the theme's chart colours in
 * order.
 *
 * A shown visual travels inside the reply text as a marker between two
 * record-separator characters (`\u001evisual:{json}\u001e`), at the place in
 * the reply where the model showed it, the same way `ask_user` questions do
 * (`weldagent-questions.ts`). WeldChat messages carry them in
 * `metadata.visuals` instead (see {@link extractVisuals}).
 */

import { z } from 'zod';
import { searchEntityTypeSchema } from './search';
import { parseAgentQuestion, type AgentQuestion } from './weldagent-questions';

// ============================================================================
// Specs
// ============================================================================

export const CHAT_VISUAL_LIMITS = {
  chartPoints: 200,
  chartSeries: 8,
  stats: 8,
  tableColumns: 12,
  tableRows: 100,
  records: 20,
  recordFields: 4,
} as const;

export const visualFormatSchema = z
  .object({
    style: z
      .enum(['number', 'currency', 'percent', 'compact'])
      .describe('number: 1,234.5 · currency: € 1,234 · percent: the value IS the percentage (12.5 → 12.5%) · compact: 1.2K'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional()
      .describe('ISO 4217 code for style "currency", e.g. "EUR".'),
    decimals: z.number().int().min(0).max(4).optional().describe('Fixed number of decimals.'),
  })
  .describe('How numbers are written.');

export type VisualFormat = z.infer<typeof visualFormatSchema>;

const title = z.string().trim().min(1).max(120);
const optionalTitle = title.optional();
const cellValue = z.union([z.string().max(300), z.number(), z.boolean(), z.null()]);

export const CHART_KINDS = ['bar', 'line', 'area', 'pie', 'donut'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

const chartFields = {
  kind: z
    .enum(CHART_KINDS)
    .describe('bar: compare categories · line/area: a trend over time · pie/donut: parts of one whole (first series only, ≤ 8 slices).'),
  title: title.describe('What the chart shows, e.g. "Open tickets per status".'),
  description: z.string().trim().max(300).optional().describe('Optional one-line takeaway under the title.'),
  caption: z.string().trim().max(200).optional().describe('Optional source or period, e.g. "Last 30 days".'),
  labels: z
    .array(z.string().max(80))
    .min(1)
    .max(CHAT_VISUAL_LIMITS.chartPoints)
    .describe('The categories along the x axis (or the slices), in order.'),
  series: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60).describe('Series name, shown in the legend.'),
        values: z
          .array(z.number().nullable())
          .describe('One value per label, in the same order; null for a gap.'),
      }),
    )
    .min(1)
    .max(CHAT_VISUAL_LIMITS.chartSeries),
  stacked: z.boolean().optional().describe('Bar/area: stack the series instead of placing them side by side.'),
  horizontal: z.boolean().optional().describe('Bar: draw the bars horizontally (good for long labels).'),
  format: visualFormatSchema.optional(),
};

const statFields = {
  title: optionalTitle,
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        value: z.union([z.number(), z.string().max(40)]).describe('A number (formatted with `format`) or a short text.'),
        format: visualFormatSchema.optional(),
        change: z
          .number()
          .optional()
          .describe('Change vs the previous period as a percentage, e.g. 12.5 for +12.5% or -3 for -3%.'),
        changeLabel: z.string().trim().max(60).optional().describe('What the change compares to, e.g. "vs last month".'),
        positiveIsGood: z
          .boolean()
          .optional()
          .describe('False when a rise is bad (costs, churn, open tickets). Defaults to true.'),
      }),
    )
    .min(1)
    .max(CHAT_VISUAL_LIMITS.stats),
};

const tableFields = {
  title: optionalTitle,
  columns: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        format: visualFormatSchema.optional().describe('For a column of numbers.'),
        align: z.enum(['left', 'right', 'center']).optional(),
      }),
    )
    .min(1)
    .max(CHAT_VISUAL_LIMITS.tableColumns),
  rows: z
    .array(z.array(cellValue))
    .min(1)
    .max(CHAT_VISUAL_LIMITS.tableRows)
    .describe('One array per row, one cell per column in column order.'),
};

const recordFields = {
  title: optionalTitle,
  items: z
    .array(
      z.object({
        entityType: searchEntityTypeSchema.describe('The kind of record, e.g. "ticket", "task", "opportunity".'),
        id: z.string().trim().min(1).max(64).describe('The record id your tools returned.'),
        label: z.string().trim().min(1).max(160).describe('Its name or title.'),
        subtitle: z.string().trim().max(160).optional().describe('One short line, e.g. the company or assignee.'),
        status: z.string().trim().max(40).optional(),
        fields: z
          .array(z.object({ label: z.string().trim().min(1).max(40), value: z.string().trim().max(80) }))
          .max(CHAT_VISUAL_LIMITS.recordFields)
          .optional()
          .describe('Up to 4 key facts, e.g. amount or due date.'),
      }),
    )
    .min(1)
    .max(CHAT_VISUAL_LIMITS.records),
};

/** Every value has one entry per label. */
function seriesMatchLabels(spec: { labels: string[]; series: { values: unknown[] }[] }, ctx: z.RefinementCtx) {
  spec.series.forEach((s, i) => {
    if (s.values.length !== spec.labels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['series', i, 'values'],
        message: `Expected ${spec.labels.length} values (one per label), got ${s.values.length}`,
      });
    }
  });
}

/** Every row has one cell per column. */
function rowsMatchColumns(spec: { columns: unknown[]; rows: unknown[][] }, ctx: z.RefinementCtx) {
  spec.rows.forEach((row, i) => {
    if (row.length !== spec.columns.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rows', i],
        message: `Expected ${spec.columns.length} cells (one per column), got ${row.length}`,
      });
    }
  });
}

/** Tool input of `show_chart` (the spec without `type`). */
export const showChartInputSchema = z.object(chartFields).superRefine(seriesMatchLabels);
/** Tool input of `show_stats`. */
export const showStatsInputSchema = z.object(statFields);
/** Tool input of `show_table`. */
export const showTableInputSchema = z.object(tableFields).superRefine(rowsMatchColumns);
/** Tool input of `show_records`. */
export const showRecordsInputSchema = z.object(recordFields);

const chartVisualSchema = z.object({ type: z.literal('chart'), ...chartFields });
const statsVisualSchema = z.object({ type: z.literal('stats'), ...statFields });
const tableVisualSchema = z.object({ type: z.literal('table'), ...tableFields });
const recordsVisualSchema = z.object({ type: z.literal('records'), ...recordFields });

export const chatVisualSchema = z
  .discriminatedUnion('type', [chartVisualSchema, statsVisualSchema, tableVisualSchema, recordsVisualSchema])
  .superRefine((spec, ctx) => {
    if (spec.type === 'chart') seriesMatchLabels(spec, ctx);
    if (spec.type === 'table') rowsMatchColumns(spec, ctx);
  });

export type ChatVisual = z.infer<typeof chatVisualSchema>;
export type ChatVisualType = ChatVisual['type'];
export type ChartVisual = Extract<ChatVisual, { type: 'chart' }>;
export type StatsVisual = Extract<ChatVisual, { type: 'stats' }>;
export type TableVisual = Extract<ChatVisual, { type: 'table' }>;
export type RecordsVisual = Extract<ChatVisual, { type: 'records' }>;
export type StatItem = StatsVisual['items'][number];
export type RecordItem = RecordsVisual['items'][number];
export type TableCell = TableVisual['rows'][number][number];

/** Validate a spec, or null. */
export function parseChatVisual(value: unknown): ChatVisual | null {
  const parsed = chatVisualSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ============================================================================
// Tools
// ============================================================================

export const SHOW_VISUAL_TOOLS = {
  show_chart: 'chart',
  show_stats: 'stats',
  show_table: 'table',
  show_records: 'records',
} as const satisfies Record<string, ChatVisualType>;

export type ShowVisualToolName = keyof typeof SHOW_VISUAL_TOOLS;

export function isShowVisualTool(name: string): name is ShowVisualToolName {
  return Object.prototype.hasOwnProperty.call(SHOW_VISUAL_TOOLS, name);
}

/** The visual a `show_*` tool call shows, or null when the name or the args do not fit. */
export function visualFromToolCall(name: string, args: unknown): ChatVisual | null {
  if (!isShowVisualTool(name) || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  return parseChatVisual({ ...(args as Record<string, unknown>), type: SHOW_VISUAL_TOOLS[name] });
}

// ============================================================================
// Markers
// ============================================================================

const MARKER = '\u001e';
const VISUAL_PREFIX = 'visual:';
const ASK_PREFIX = 'ask:';

/** Inline form of a visual in a reply. */
export function encodeVisualMarker(visual: ChatVisual): string {
  return `${MARKER}${VISUAL_PREFIX}${JSON.stringify(visual)}${MARKER}`;
}

export type ReplyPart =
  | { kind: 'text'; text: string }
  | { kind: 'visual'; visual: ChatVisual }
  /** A visual still streaming in: drawn as a placeholder until it is complete. */
  | { kind: 'pending-visual' };

export interface ReplyParts {
  parts: ReplyPart[];
  /** `ask_user` questions carried in the reply (see weldagent-questions.ts). */
  questions: AgentQuestion[];
}

function tidy(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split a reply into its text and the visuals and questions it carries, in
 * reply order. A malformed marker is dropped; a visual whose marker has not
 * finished streaming becomes a `pending-visual` part (a question still
 * streaming is just left out).
 */
export function splitReplyParts(raw: string): ReplyParts {
  const parts: ReplyPart[] = [];
  const questions: AgentQuestion[] = [];
  const pushText = (text: string) => {
    const clean = tidy(text);
    if (clean) parts.push({ kind: 'text', text: clean });
  };
  let rest = raw;
  for (;;) {
    const start = rest.indexOf(MARKER);
    if (start < 0) {
      pushText(rest);
      break;
    }
    pushText(rest.slice(0, start));
    const end = rest.indexOf(MARKER, start + 1);
    const body = end < 0 ? rest.slice(start + 1) : rest.slice(start + 1, end);
    if (end < 0) {
      if (body.length > 0 && (body.startsWith(VISUAL_PREFIX) || VISUAL_PREFIX.startsWith(body))) parts.push({ kind: 'pending-visual' });
      break;
    }
    try {
      if (body.startsWith(VISUAL_PREFIX)) {
        const visual = parseChatVisual(JSON.parse(body.slice(VISUAL_PREFIX.length)));
        if (visual) parts.push({ kind: 'visual', visual });
      } else if (body.startsWith(ASK_PREFIX)) {
        const question = parseAgentQuestion(JSON.parse(body.slice(ASK_PREFIX.length)));
        if (question) questions.push(question);
      }
    } catch {
      // A malformed marker is dropped.
    }
    rest = rest.slice(end + 1);
  }
  return { parts, questions };
}

/** Whether a reply carries any marker at all (cheap check before splitting). */
export function hasReplyMarkers(raw: string): boolean {
  return raw.includes(MARKER);
}

/**
 * A reply's text with every marker taken out, and the visuals it showed, for
 * places that keep the two apart (a WeldChat message: text in `content`,
 * specs in `metadata.visuals`).
 */
export function extractVisuals(raw: string): { text: string; visuals: ChatVisual[] } {
  if (!hasReplyMarkers(raw)) return { text: raw.trim(), visuals: [] };
  const { parts } = splitReplyParts(raw);
  const texts: string[] = [];
  const visuals: ChatVisual[] = [];
  for (const part of parts) {
    if (part.kind === 'text') texts.push(part.text);
    else if (part.kind === 'visual') visuals.push(part.visual);
  }
  return { text: texts.join('\n\n'), visuals };
}

/**
 * The visuals on a WeldChat message (`metadata.visuals`), each validated; an
 * entry that does not parse is left out.
 */
export function readVisualsMetadata(metadata: unknown): ChatVisual[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { visuals?: unknown }).visuals;
  if (!Array.isArray(raw)) return [];
  return raw.map(parseChatVisual).filter((visual): visual is ChatVisual => visual !== null);
}

const KIND_NAME: Record<ChatVisualType, string> = {
  chart: 'Chart',
  stats: 'Figures',
  table: 'Table',
  records: 'Records',
};

/** A visual's title, or its first label when it has none. */
export function visualTitle(visual: ChatVisual): string {
  if (visual.title) return visual.title;
  switch (visual.type) {
    case 'stats':
      return visual.items.map((item) => item.label).join(', ');
    case 'table':
      return visual.columns.map((column) => column.label).join(', ');
    case 'records':
      return visual.items.map((item) => item.label).join(', ');
    default:
      return '';
  }
}

/** One line naming a visual: `[Chart: Open tickets per status]`. */
export function visualSummaryLine(visual: ChatVisual): string {
  const name = visualTitle(visual).slice(0, 120);
  return name ? `[${KIND_NAME[visual.type]}: ${name}]` : `[${KIND_NAME[visual.type]}]`;
}

const DATA_TEXT_LIMIT = 1500;

function cellText(value: TableCell | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** A visual's data as compact text the model can read back next turn. */
function visualDataText(visual: ChatVisual): string {
  switch (visual.type) {
    case 'chart':
      return visual.series
        .map((s) => `${s.name}: ${visual.labels.map((label, i) => `${label} ${s.values[i] ?? '-'}`).join(', ')}`)
        .join('; ');
    case 'stats':
      return visual.items
        .map((item) => `${item.label} ${item.value}${item.change === undefined ? '' : ` (${item.change > 0 ? '+' : ''}${item.change}%)`}`)
        .join(', ');
    case 'table':
      return [visual.columns.map((c) => c.label).join(' | '), ...visual.rows.map((row) => row.map(cellText).join(' | '))].join(
        '\n',
      );
    case 'records':
      return visual.items
        .map((item) => `${item.entityType} ${item.id} "${item.label}"${item.status ? ` (${item.status})` : ''}`)
        .join(', ');
    default:
      return '';
  }
}

/** One visual as text: its summary line, or with `detail: 'data'` the line plus its numbers. */
export function visualToPlainText(visual: ChatVisual, options: { detail?: 'title' | 'data' } = {}): string {
  const line = visualSummaryLine(visual);
  if (options.detail !== 'data') return line;
  const data = visualDataText(visual);
  const clipped = data.length > DATA_TEXT_LIMIT ? `${data.slice(0, DATA_TEXT_LIMIT)}…` : data;
  return `${line.slice(0, -1)} — shown to the user: ${clipped}]`;
}

/**
 * A reply as plain text, for every place that cannot draw visuals: push
 * previews, run summaries (`detail: 'title'`, the default: one line per
 * visual), and the history sent back to the model (`detail: 'data'`: the
 * line plus the visual's numbers, so a follow-up about it can be answered).
 * Questions become the line `questionMarkersToText` writes.
 */
export function replyToPlainText(raw: string, options: { detail?: 'title' | 'data' } = {}): string {
  if (!hasReplyMarkers(raw)) return raw;
  const { parts, questions } = splitReplyParts(raw);
  const lines: string[] = [];
  for (const part of parts) {
    if (part.kind === 'text') lines.push(part.text);
    else if (part.kind === 'visual') lines.push(visualToPlainText(part.visual, options));
  }
  for (const q of questions) {
    lines.push(`[Asked the user: ${q.question} Options: ${q.options.map((o) => o.label).join(' / ')}]`);
  }
  return lines.join('\n\n');
}

// ============================================================================
// CSV
// ============================================================================

export interface VisualCsvHeaders {
  label: string;
  value: string;
  change: string;
  type: string;
  status: string;
  details: string;
  id: string;
}

const DEFAULT_CSV_HEADERS: VisualCsvHeaders = {
  label: 'Label',
  value: 'Value',
  change: 'Change (%)',
  type: 'Type',
  status: 'Status',
  details: 'Details',
  id: 'Id',
};

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The rows of a visual's data, header first (raw values, not formatted). */
export function visualToRows(visual: ChatVisual, headers: Partial<VisualCsvHeaders> = {}): unknown[][] {
  const h = { ...DEFAULT_CSV_HEADERS, ...headers };
  switch (visual.type) {
    case 'chart':
      return [
        [h.label, ...visual.series.map((s) => s.name)],
        ...visual.labels.map((label, i) => [label, ...visual.series.map((s) => s.values[i] ?? null)]),
      ];
    case 'stats':
      return [[h.label, h.value, h.change], ...visual.items.map((item) => [item.label, item.value, item.change ?? null])];
    case 'table':
      return [visual.columns.map((c) => c.label), ...visual.rows];
    case 'records':
      return [
        [h.label, h.type, h.status, h.details, h.id],
        ...visual.items.map((item) => [
          item.label,
          item.entityType,
          item.status ?? null,
          [item.subtitle, ...(item.fields ?? []).map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join(' · '),
          item.id,
        ]),
      ];
    default:
      return [];
  }
}

/** A visual's data as CSV (RFC 4180 quoting, CRLF line ends). */
export function visualToCsv(visual: ChatVisual, headers: Partial<VisualCsvHeaders> = {}): string {
  return visualToRows(visual, headers)
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}

/** A file name for a visual's download, from its title. */
export function visualFileName(visual: ChatVisual, extension: string): string {
  const base =
    visualTitle(visual)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || visual.type;
  return `${base}.${extension}`;
}

// ============================================================================
// Formatting (shared by the web and mobile renderers)
// ============================================================================

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(locale, options);
    } catch {
      // An unknown currency code, locale or option: plain numbers rather than a crash.
      formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    }
    numberFormats.set(key, formatter);
  }
  return formatter;
}

function numberOptions(format: VisualFormat | undefined, compact: boolean): Intl.NumberFormatOptions {
  const digits =
    format?.decimals === undefined
      ? {}
      : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals };
  const shortened: Intl.NumberFormatOptions = { notation: 'compact', maximumFractionDigits: 1 };
  switch (format?.style) {
    case 'currency':
      if (!format.currency) return { maximumFractionDigits: 2, ...digits };
      return { style: 'currency', currency: format.currency, ...(compact ? shortened : digits) };
    case 'percent':
      // The value is the percentage itself (12.5 → 12.5%).
      return { maximumFractionDigits: 1, ...digits };
    case 'compact':
      return shortened;
    default:
      return compact ? shortened : { maximumFractionDigits: 2, ...digits };
  }
}

/** A number the way its spec asks, in `locale`; `compact` shortens it for axis ticks. */
export function formatVisualNumber(
  value: number,
  format: VisualFormat | undefined,
  locale: string,
  { compact = false }: { compact?: boolean } = {},
): string {
  const text = numberFormat(locale, numberOptions(format, compact)).format(value);
  return format?.style === 'percent' ? `${text}%` : text;
}

/** A stat or cell: numbers through {@link formatVisualNumber}, text as is, empty as ''. */
export function formatVisualValue(value: TableCell | undefined, format: VisualFormat | undefined, locale: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatVisualNumber(value, format, locale);
  if (typeof value === 'boolean') return value ? '✓' : '–';
  return value;
}

/** A change as a signed percentage: "+12.5%", "-3%". */
export function formatVisualChange(change: number, locale: string): string {
  return `${numberFormat(locale, { maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(change)}%`;
}

/** Order two cells: numbers by value, text by `locale`, empty cells last. */
export function compareVisualCells(a: TableCell | undefined, b: TableCell | undefined, locale: string): number {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA || emptyB) return Number(emptyA) - Number(emptyB);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), locale, { numeric: true, sensitivity: 'base' });
}
