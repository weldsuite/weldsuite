/**
 * Workflow trigger matcher.
 *
 * Matches an entity event against `entity_event` triggers on active
 * WeldConnect workflows and dispatches CF Workflow instances. Called
 * fire-and-forget from `publishEntityEvent`.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { workflows } from '@weldsuite/db/schema';
import type { TenantDb } from './internal-types';

interface TriggerFilter {
  field: string;
  operator: string;
  value: unknown;
}

interface TriggerConfig {
  type: string;
  isEnabled?: boolean;
  entityType?: string;
  eventType?: string;
  // integration_event triggers (flat or nested under `config`)
  provider?: string;
  event?: string;
  integrationId?: string;
  filters?: TriggerFilter[];
  config?: {
    entityType?: string;
    eventType?: string;
    provider?: string;
    event?: string;
    integrationId?: string;
    filters?: TriggerFilter[];
  };
}

/**
 * Evaluate a trigger's field filters against an event payload. Shared by the
 * entity-event and integration-event matchers. Empty/absent filters pass.
 * Pure — exported for testing.
 */
export function evalFilters(
  filters: TriggerFilter[] | undefined,
  data: Record<string, unknown>,
): boolean {
  if (!filters || filters.length === 0) return true;
  return filters.every((f) => {
    const val = data[f.field];
    switch (f.operator) {
      case 'eq':
      case 'equals':
        return val === f.value;
      case 'neq':
      case 'not_equals':
        return val !== f.value;
      case 'contains':
        return String(val).includes(String(f.value));
      case 'exists':
        return val !== undefined && val !== null;
      case 'not_exists':
        return val === undefined || val === null;
      default:
        return true;
    }
  });
}

/**
 * Minimal env shape — only the Cloudflare Workflow binding required to
 * dispatch a run. Workers wider environments are accepted via structural
 * typing.
 */
export interface WorkflowDispatchEnv {
  EXECUTE_WORKFLOW?: {
    create: (init: { params: Record<string, unknown> }) => Promise<unknown>;
  };
}

export interface MatchAndDispatchInput {
  env: WorkflowDispatchEnv;
  db: TenantDb;
  workspaceId: string;
  userId: string;
  entityType: string;
  entityId: string;
  action: string;
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }>;
}

/**
 * Derive the fine-grained event types an action produces. `updated` events fan
 * out into status_changed / assigned / tagged / priority_changed based on which
 * fields changed. Pure — exported for testing.
 */
export function deriveEventTypes(
  action: string,
  changes?: Record<string, { old: unknown; new: unknown }>,
): string[] {
  const eventTypes: string[] = [action];
  if (action === 'updated' && changes) {
    if ('status' in changes) eventTypes.push('status_changed');
    if ('assigneeId' in changes || 'assigneeName' in changes) eventTypes.push('assigned');
    if ('tags' in changes) eventTypes.push('tagged');
    if ('priority' in changes) eventTypes.push('priority_changed');
  }
  return eventTypes;
}

/**
 * Does an `entity_event` trigger match the given event + payload? Pure —
 * exported for testing. Returns false for non-entity_event or disabled triggers.
 */
export function triggerMatchesEvent(
  trigger: TriggerConfig,
  entityType: string,
  eventTypes: string[],
  data: Record<string, unknown>,
): boolean {
  if (trigger.type !== 'entity_event') return false;
  if (trigger.isEnabled === false) return false;

  const tEntityType = trigger.entityType || trigger.config?.entityType;
  const tEventType = trigger.eventType || trigger.config?.eventType;
  if (tEntityType !== entityType) return false;
  if (tEventType && !eventTypes.includes(tEventType)) return false;

  return evalFilters(trigger.config?.filters, data);
}

/**
 * Does an `integration_event` trigger match the given provider + event? Pure —
 * exported for testing. Returns false for non-integration_event or disabled
 * triggers. Reads provider/event from the flat trigger or its nested `config`.
 */
export function integrationTriggerMatches(
  trigger: TriggerConfig,
  provider: string,
  event: string,
  integrationId: string | undefined,
  data: Record<string, unknown>,
): boolean {
  if (trigger.type !== 'integration_event') return false;
  if (trigger.isEnabled === false) return false;

  const tProvider = trigger.provider ?? trigger.config?.provider;
  const tEvent = trigger.event ?? trigger.config?.event;
  if (tProvider !== provider) return false;
  if (tEvent !== event) return false;

  // If the trigger is pinned to a specific connection, it must match the one
  // that produced the event.
  const tIntegrationId = trigger.integrationId ?? trigger.config?.integrationId;
  if (tIntegrationId && integrationId && tIntegrationId !== integrationId) return false;

  return evalFilters(trigger.filters ?? trigger.config?.filters, data);
}

export async function matchAndDispatchWorkflowTriggers(
  input: MatchAndDispatchInput,
): Promise<void> {
  const { env, db, workspaceId, userId, entityType, entityId, action, data, changes } = input;

  if (!workspaceId || !env.EXECUTE_WORKFLOW) return;

  const eventTypes = deriveEventTypes(action, changes);

  const activeWorkflows = await db
    .select({ id: workflows.id, name: workflows.name, triggers: workflows.triggers })
    .from(workflows)
    .where(and(eq(workflows.status, 'active'), isNull(workflows.deletedAt)));

  for (const workflow of activeWorkflows) {
    const triggers = (workflow.triggers as TriggerConfig[]) || [];

    for (const trigger of triggers) {
      if (!triggerMatchesEvent(trigger, entityType, eventTypes, data)) continue;

      try {
        await env.EXECUTE_WORKFLOW.create({
          params: {
            workspaceId,
            userId,
            workflowId: workflow.id,
            triggerType: 'entity_event',
            triggerData: {
              eventType: `${entityType}:${action}`,
              entityType,
              entityId,
              action,
              data,
              changes,
            },
            source: 'task',
          },
        });
        console.log(
          `[TriggerMatcher] Dispatched workflow "${workflow.name}" for ${entityType}:${action}`,
        );
      } catch (err) {
        console.error(`[TriggerMatcher] Failed to dispatch workflow ${workflow.id}:`, err);
      }
    }
  }
}

export interface MatchAndDispatchIntegrationInput {
  env: WorkflowDispatchEnv;
  db: TenantDb;
  workspaceId: string;
  userId: string;
  /** Integration catalog provider id, e.g. `slack`. */
  provider: string;
  /** Namespaced event id, e.g. `slack.message`. */
  event: string;
  /** The connection that produced the event (for pinned triggers). */
  integrationId?: string;
  /** Event payload exposed to filters + downstream steps. */
  data: Record<string, unknown>;
}

/**
 * Match an inbound integration event against `integration_event` triggers on
 * active WeldConnect workflows and dispatch CF Workflow instances. Mirror of
 * `matchAndDispatchWorkflowTriggers` for external providers; called from
 * integration-webhook-worker (webhook providers) and Trigger.dev polls.
 */
export async function matchAndDispatchIntegrationTriggers(
  input: MatchAndDispatchIntegrationInput,
): Promise<void> {
  const { env, db, workspaceId, userId, provider, event, integrationId, data } = input;

  if (!workspaceId || !env.EXECUTE_WORKFLOW) return;

  const activeWorkflows = await db
    .select({ id: workflows.id, name: workflows.name, triggers: workflows.triggers })
    .from(workflows)
    .where(and(eq(workflows.status, 'active'), isNull(workflows.deletedAt)));

  for (const workflow of activeWorkflows) {
    const triggers = (workflow.triggers as TriggerConfig[]) || [];

    for (const trigger of triggers) {
      if (!integrationTriggerMatches(trigger, provider, event, integrationId, data)) continue;

      try {
        await env.EXECUTE_WORKFLOW.create({
          params: {
            workspaceId,
            userId,
            workflowId: workflow.id,
            triggerType: 'integration_event',
            triggerData: {
              eventType: event,
              provider,
              event,
              integrationId,
              data,
            },
            source: 'integration',
          },
        });
        console.log(
          `[TriggerMatcher] Dispatched workflow "${workflow.name}" for ${provider}:${event}`,
        );
      } catch (err) {
        console.error(`[TriggerMatcher] Failed to dispatch workflow ${workflow.id}:`, err);
      }
    }
  }
}
