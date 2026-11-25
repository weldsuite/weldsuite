/**
 * A project's delivery approach and what it changes (ADR FLOW-022): it only
 * sets defaults. What the Tasks tab opens on, what the Pipeline shows, which
 * item types are offered and which tabs are suggested. Agile lives inside the
 * existing tabs; no approach adds a tab.
 *
 * On an edition without the `flow-agile` feature (Global) every project reads
 * as a task list, so nothing changes there.
 */

import {
  DEFAULT_DELIVERY_SETTINGS,
  readDeliverySettings,
  type DeliveryApproach,
  type DeliverySettings,
  type ItemType,
} from '@weldsuite/app-api-client/schemas/flow-agile';
import type { ProjectTabId } from '@weldsuite/app-api-client/schemas/project-tabs';

export interface ApproachDefaults {
  /** Sprints: the Backlog plans them, the Pipeline shows one, Analytics reports them. */
  usesSprints: boolean;
  /** Items carry a type (Epic, PBI, Bug, …). */
  usesItemTypes: boolean;
  /** The Pipeline shows WIP limits per column. */
  usesWipLimits: boolean;
  /** Gantt › Phases is the plan (sprints sit inside phases for a hybrid project). */
  usesPhases: boolean;
  /** The view the Tasks tab opens on. */
  tasksOpensOn: 'list' | 'backlog';
  /** The tabs shown when the approach is picked with "show the suggested tabs". */
  suggestedTabs: readonly ProjectTabId[];
}

export const APPROACH_DEFAULTS: Record<DeliveryApproach, ApproachDefaults> = {
  tasklist: {
    usesSprints: false,
    usesItemTypes: false,
    usesWipLimits: false,
    usesPhases: false,
    tasksOpensOn: 'list',
    suggestedTabs: [],
  },
  predictive: {
    usesSprints: false,
    usesItemTypes: false,
    usesWipLimits: false,
    usesPhases: true,
    tasksOpensOn: 'list',
    suggestedTabs: ['tasks', 'gantt', 'documents', 'files', 'raid', 'governance', 'finance', 'analytics', 'settings'],
  },
  scrum: {
    usesSprints: true,
    usesItemTypes: true,
    usesWipLimits: false,
    usesPhases: false,
    tasksOpensOn: 'backlog',
    suggestedTabs: ['tasks', 'pipeline', 'analytics', 'documents', 'files', 'settings'],
  },
  kanban: {
    usesSprints: false,
    usesItemTypes: true,
    usesWipLimits: true,
    usesPhases: false,
    tasksOpensOn: 'backlog',
    suggestedTabs: ['tasks', 'pipeline', 'analytics', 'documents', 'files', 'settings'],
  },
  hybrid: {
    usesSprints: true,
    usesItemTypes: true,
    usesWipLimits: false,
    usesPhases: true,
    tasksOpensOn: 'backlog',
    suggestedTabs: ['tasks', 'pipeline', 'gantt', 'analytics', 'documents', 'raid', 'governance', 'settings'],
  },
};

export interface DeliveryModel extends ApproachDefaults {
  /** False on an edition without the `flow-agile` feature: then it is always a task list. */
  available: boolean;
  settings: DeliverySettings;
  approach: DeliveryApproach;
  /** Any approach but the task list. */
  isAgile: boolean;
  /** The item types the project offers, in the canonical order. */
  enabledTypes: ItemType[];
}

/**
 * The delivery model of a project from its `settings` (the project detail's
 * `settings` jsonb). WIP limits also show for any approach once a limit is set.
 */
export function deliveryModel(projectSettings: unknown, available: boolean): DeliveryModel {
  const raw =
    projectSettings && typeof projectSettings === 'object'
      ? (projectSettings as Record<string, unknown>).delivery
      : undefined;
  const settings = available ? readDeliverySettings(raw) : DEFAULT_DELIVERY_SETTINGS;
  const defaults = APPROACH_DEFAULTS[settings.approach];
  const usesItemTypes = defaults.usesItemTypes;
  const enabledTypes = usesItemTypes ? enabledItemTypes(settings) : [];
  return {
    ...defaults,
    usesWipLimits: defaults.usesWipLimits || Object.keys(settings.wipLimits).length > 0,
    available,
    settings,
    approach: settings.approach,
    isAgile: settings.approach !== 'tasklist',
    enabledTypes,
  };
}

const TYPE_ORDER: readonly ItemType[] = ['epic', 'feature', 'story', 'bug', 'task', 'spike', 'subtask'];

/** The enabled types in the canonical order; `feature` only with the feature level on. */
export function enabledItemTypes(settings: DeliverySettings): ItemType[] {
  const enabled = new Set(settings.itemTypes.enabled);
  return TYPE_ORDER.filter(
    (type) => enabled.has(type) && (type !== 'feature' || settings.itemTypes.featureLevel),
  );
}

/** Average velocity of the last `window` completed sprints (null when there are none). */
export function averageVelocity(
  sprints: ReadonlyArray<{ status: string; velocity: number | null; completedAt: string | null }>,
  window = 3,
): number | null {
  const done = sprints
    .filter((sprint) => sprint.status === 'completed' && sprint.velocity != null)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .slice(0, window);
  if (done.length === 0) return null;
  const total = done.reduce((sum, sprint) => sum + (sprint.velocity ?? 0), 0);
  return Math.round(total / done.length);
}
