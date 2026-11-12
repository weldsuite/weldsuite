/**
 * WeldDesk's priority matrix: ITIL impact × urgency → priority.
 *
 * A conversation carries an impact and an urgency (low / medium / high, null
 * when not set). With the workspace's matrix on
 * (`helpdesk_settings.tickets.priorityMatrix.enabled`) and both set, the
 * priority follows the grid whenever either of them changes. Setting the
 * priority directly stays allowed: it is an override that holds until the
 * impact or the urgency changes again. Off by default.
 *
 * updateDeskConversationAttributes (./desk) is the only writer; this file
 * holds the grid, the setting and the derivation. The Rust twin is
 * `weldsuite_desk_domain::priority_matrix`.
 */

import { isNull } from 'drizzle-orm';
import type { TenantDb } from './any-db';
import * as schema from '../schema';
import type {
  DeskConversation,
  DeskImpact,
  DeskPriority,
  DeskUrgency,
} from '../schema/desk-conversations';
import type { DeskAttributeChange } from '../schema/desk-messages';

type AnyDb = TenantDb;

export const DESK_IMPACTS = ['low', 'medium', 'high'] as const satisfies readonly DeskImpact[];
export const DESK_URGENCIES = ['low', 'medium', 'high'] as const satisfies readonly DeskUrgency[];
const PRIORITIES = new Set<string>(['low', 'medium', 'high', 'urgent']);

/** impact → urgency → priority. */
export type DeskPriorityGrid = Record<DeskImpact, Record<DeskUrgency, DeskPriority>>;

/** `helpdesk_settings.tickets.priorityMatrix`. */
export interface DeskPriorityMatrix {
  enabled: boolean;
  matrix: DeskPriorityGrid;
}

/** The ITIL default: the higher both are, the higher the priority. */
export const DEFAULT_DESK_PRIORITY_GRID: DeskPriorityGrid = {
  low: { low: 'low', medium: 'low', high: 'medium' },
  medium: { low: 'low', medium: 'medium', high: 'high' },
  high: { low: 'medium', medium: 'high', high: 'urgent' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The stored setting as the inbox uses it: off unless `enabled` is true, and
 * every cell a valid priority (a missing or bad cell takes the default's).
 * Always low / medium / high order, whatever order it was stored in.
 */
export function normalizeDeskPriorityMatrix(value: unknown): DeskPriorityMatrix {
  const stored = isRecord(value) ? value : {};
  const grid = isRecord(stored.matrix) ? stored.matrix : {};
  const matrix = {} as DeskPriorityGrid;
  for (const impact of DESK_IMPACTS) {
    const row = isRecord(grid[impact]) ? grid[impact] : {};
    matrix[impact] = {} as Record<DeskUrgency, DeskPriority>;
    for (const urgency of DESK_URGENCIES) {
      const cell = row[urgency];
      matrix[impact][urgency] =
        typeof cell === 'string' && PRIORITIES.has(cell)
          ? (cell as DeskPriority)
          : DEFAULT_DESK_PRIORITY_GRID[impact][urgency];
    }
  }
  return { enabled: stored.enabled === true, matrix };
}

/** The workspace's matrix (the default grid, off, when nothing is saved). */
export async function getDeskPriorityMatrix(db: AnyDb): Promise<DeskPriorityMatrix> {
  const [row] = await db
    .select({ tickets: schema.helpdeskSettings.tickets })
    .from(schema.helpdeskSettings)
    .where(isNull(schema.helpdeskSettings.deletedAt))
    .limit(1);
  const tickets = (row?.tickets ?? null) as Record<string, unknown> | null;
  return normalizeDeskPriorityMatrix(tickets?.priorityMatrix);
}

/** The grid's priority for an impact and an urgency; null unless both are set. */
export function deskPriorityFromMatrix(
  matrix: DeskPriorityGrid,
  impact: DeskImpact | null,
  urgency: DeskUrgency | null,
): DeskPriority | null {
  if (!impact || !urgency) return null;
  return matrix[impact]?.[urgency] ?? null;
}

export interface DeskMatrixInput {
  /** undefined leaves it alone; null clears it. */
  impact?: DeskImpact | null;
  urgency?: DeskUrgency | null;
}

export interface DeskMatrixChanges {
  patch: Partial<Pick<DeskConversation, 'impact' | 'urgency'>>;
  /** The impact and urgency entries for the `attributes_changed` event. */
  changes: DeskAttributeChange[];
  /**
   * The priority the grid gives now: set only when the impact or the urgency
   * changed, the matrix is on and both are set.
   */
  priority?: DeskPriority;
}

/**
 * The impact and urgency changes of an attribute update, and the priority
 * they derive. Reads the setting only when one of them changes.
 */
export async function deskMatrixChanges(
  db: AnyDb,
  current: Pick<DeskConversation, 'impact' | 'urgency'>,
  input: DeskMatrixInput,
): Promise<DeskMatrixChanges> {
  const out: DeskMatrixChanges = { patch: {}, changes: [] };
  if (input.impact !== undefined && input.impact !== current.impact) {
    out.patch.impact = input.impact;
    out.changes.push({ field: 'impact', from: current.impact, to: input.impact });
  }
  if (input.urgency !== undefined && input.urgency !== current.urgency) {
    out.patch.urgency = input.urgency;
    out.changes.push({ field: 'urgency', from: current.urgency, to: input.urgency });
  }
  if (out.changes.length === 0) return out;

  const impact = out.patch.impact === undefined ? current.impact : out.patch.impact;
  const urgency = out.patch.urgency === undefined ? current.urgency : out.patch.urgency;
  if (!impact || !urgency) return out;
  const setting = await getDeskPriorityMatrix(db);
  if (!setting.enabled) return out;
  const priority = deskPriorityFromMatrix(setting.matrix, impact, urgency);
  if (priority) out.priority = priority;
  return out;
}
