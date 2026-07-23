/**
 * Widget Configuration Route
 *
 * Returns the widget configuration (colors, behavior, pages) for the authenticated widget.
 */

import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { success } from '../lib/response';
import { fetchWidgetBaseData, buildWidgetConfigResponse } from '../lib/widget-config';
import type { HelpdeskTriggerConfig as TriggerConfig, HelpdeskEntityEventTriggerConfig as EntityEventTriggerConfig } from '@weldsuite/db/schema/helpdesk-workflow-types';

export const configRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / - Get widget configuration
 *
 * Returns the widget settings including colors, pages visibility, and behavior.
 */
configRoutes.get('/', async (c) => {
  const widgetConfig = c.get('widgetConfig');
  const db = c.get('tenantDb');

  const { settings, defaultDepartment } = await fetchWidgetBaseData(db);

  const config = buildWidgetConfigResponse(
    widgetConfig,
    settings,
    defaultDepartment,
    c.get('removeBranding')
  );

  // Load ALL active "conversation created" welcome workflows, ordered by sortOrder.
  // Steps from each workflow are concatenated into a single welcomeFlow so the widget
  // renders them sequentially (like Intercom — multiple workflows, top-to-bottom).
  let welcomeFlow: Array<{
    id: string;
    type: string;
    name: string;
    order: number;
    config: Record<string, unknown>;
  }> | null = null;

  try {
    const activeWorkflows = await db
      .select({
        id: schema.helpdeskWorkflows.id,
        triggers: schema.helpdeskWorkflows.triggers,
        steps: schema.helpdeskWorkflows.steps,
        sortOrder: schema.helpdeskWorkflows.sortOrder,
      })
      .from(schema.helpdeskWorkflows)
      .where(and(eq(schema.helpdeskWorkflows.status, 'active'), isNull(schema.helpdeskWorkflows.deletedAt)))
      .orderBy(schema.helpdeskWorkflows.sortOrder);

    const WELCOME_STEP_TYPES = ['send_message', 'send_choices', 'collect_input', 'collect_customer_info', 'suggest_articles', 'delay'];
    const allParts: NonNullable<typeof welcomeFlow> = [];

    for (const wf of activeWorkflows) {
      const triggers = (wf.triggers ?? []) as TriggerConfig[];
      const hasWelcomeTrigger = triggers.some((t) => {
        if (t.isEnabled === false || t.type !== 'entity_event') return false;
        const cfg = (t.config ?? t) as EntityEventTriggerConfig;
        return cfg.entityType === 'helpdesk_conversation' && cfg.eventType === 'created';
      });

      if (hasWelcomeTrigger && Array.isArray(wf.steps)) {
        const steps = (wf.steps as unknown as Array<Record<string, unknown>>)
          .filter((s) => !s.parentBranchId && WELCOME_STEP_TYPES.includes(s.type as string))
          .sort((a, b) => ((a.order as number) ?? 0) - ((b.order as number) ?? 0))
          .map((s) => ({
            id: s.id as string,
            type: s.type as string,
            name: (s.name as string) || '',
            order: (s.order as number) ?? 0,
            config: { ...(s.config as Record<string, unknown> || {}), ...(s.inputs as Record<string, unknown> || {}) },
          }));
        allParts.push(...steps);
      }
    }

    if (allParts.length > 0) welcomeFlow = allParts;
  } catch (err) {
    // Non-fatal — widget works without welcome flow
    console.error('[Config] Failed to load welcome workflow:', err);
  }

  return success(c, {
    ...config,
    // Welcome message (config.ts only)
    welcome: {
      enabled: widgetConfig.showWelcomeMessage ?? true,
      message: widgetConfig.welcomeMessage || 'Hi there 👋\n\nHow can we help you today?',
    },
    // Welcome workflow steps (conversation:created trigger) — rendered client-side before conversation exists
    welcomeFlow,
  });
});
