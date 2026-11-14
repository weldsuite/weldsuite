/**
 * Usage route: GET /api/panel/usage.
 *
 * This month's events and recordings against the plan allowance, the overage
 * charged to the wallet, the quota state the collector is applying and what
 * the plan keeps for how long (the plan's "Plan allowance and overage").
 * `panel_projects:manage` covers usage, as it covers keys and privacy settings.
 *
 * Reading it also settles when the quota is not `ok`: after a wallet top-up the
 * unpaid blocks are charged again here, and the collector stops dropping data
 * within its minute of cache, without waiting for the next settlement.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { error, success } from '@weldsuite/worker-kit/response';
import type { PanelUsageDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { PANEL_FAVORITE_RETENTION_MONTHS } from '@weldsuite/panel-domain/plans';
import { parseQuotaState, quotaKvKey } from '@weldsuite/panel-domain/registry';
import type { Env, Variables } from '../../types';
import { listProjects } from '../../services/projects';
import { monthOf, loadWorkspacePlan, quotaFor, settleUsage, usageRow, type PanelUsageMonth } from '../../services/usage-settlement';
import { projectUsage } from '../../services/usage-projects';
import { sendUsageNotice } from '../../services/usage-mail';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const EMPTY = { events: 0, recordings: 0, eventBlocksCharged: 0, recordingBlocksCharged: 0, eventCreditsCharged: 0, recordingCreditsCharged: 0 } satisfies Partial<PanelUsageMonth>;

app.get('/', requirePermission('panel_projects:manage'), async (c) => {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);

  const masterDb = getMasterDb(c.env);
  const kv = c.env.WORKSPACE_CACHE;
  const now = new Date();
  const month = monthOf(now);

  const workspace = await loadWorkspacePlan(masterDb, workspaceId);
  if (!workspace) return error.notFound(c, 'Workspace', workspaceId);

  let usage: Pick<PanelUsageMonth, keyof typeof EMPTY> = (await usageRow(masterDb, workspaceId, month)) ?? EMPTY;
  let quota = quotaFor(workspace.limits, usage);

  const collectorState = parseQuotaState(await kv.get(quotaKvKey(workspaceId)));
  if ((quota !== 'ok' || collectorState !== 'ok')) {
    const settled = await settleUsage(
      { masterDb, kv, now, notify: async (notice) => void (await sendUsageNotice({ env: c.env }, notice)) },
      { workspaceId, month, events: usage.events, recordings: usage.recordings },
    );
    if (settled) {
      usage = settled.usage;
      quota = settled.quota;
    }
  }

  const [projects, counts] = await Promise.all([listProjects(c.get('tenantDb')), projectUsage(c.env, workspaceId, month)]);

  const dto: PanelUsageDto = {
    month,
    planSlug: workspace.planSlug ?? 'free',
    events: {
      used: usage.events,
      allowance: workspace.limits.events,
      blocksCharged: usage.eventBlocksCharged,
      creditsCharged: usage.eventCreditsCharged,
    },
    recordings: {
      used: usage.recordings,
      allowance: workspace.limits.recordings,
      blocksCharged: usage.recordingBlocksCharged,
      creditsCharged: usage.recordingCreditsCharged,
    },
    quota,
    retention: {
      eventsMonths: workspace.limits.eventRetentionMonths,
      recordingsDays: workspace.limits.recordingRetentionDays,
      favoritesMonths: PANEL_FAVORITE_RETENTION_MONTHS,
    },
    projects: projects
      .map((project) => ({ projectId: project.id, name: project.name, events: counts?.get(project.id)?.events ?? 0, recordings: counts?.get(project.id)?.recordings ?? 0 }))
      .sort((a, b) => b.events - a.events || b.recordings - a.recordings || a.name.localeCompare(b.name)),
  };
  return success(c, dto);
});

export default app;
