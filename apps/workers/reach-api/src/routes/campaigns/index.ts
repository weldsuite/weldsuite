/**
 * Campaigns: /api/reach/campaigns
 *
 * Permissions: reach_campaigns:read | create | update | delete (launch, pause,
 * resume, steps, mailboxes and enrolling count as update). Every mutation
 * publishes a `reach_campaign` entity event (created / updated / deleted /
 * launched / paused / completed).
 *
 * The logic is in `@weldsuite/reach-domain/campaigns`, shared with the public
 * API; this file maps requests to it and wires its two ports: entity events
 * (`publishEntityEvent`) and waking the send sweep (`markWorkspaceDue`).
 * Sending itself happens in the `reach-send` queue consumer.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, list, noContent, success } from '@weldsuite/worker-kit/response';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import {
  addReachCampaignProspectsSchema,
  createReachCampaignSchema,
  previewReachStepSchema,
  replaceReachStepsSchema,
  resolveWeldReachLimits,
  setReachCampaignMailboxesSchema,
  updateReachCampaignSchema,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  createCampaign,
  deleteCampaign,
  enrollCampaignProspects,
  getCampaignDetail,
  getCampaignStats,
  launchCampaign,
  listCampaigns,
  listEnrollments,
  pauseCampaign,
  previewCampaignStep,
  removeCampaignEnrollment,
  replaceCampaignSteps,
  resumeCampaign,
  setCampaignMailboxes,
  updateCampaign,
} from '@weldsuite/reach-domain/campaigns';
import type { ReachDuePort, ReachEventSink } from '@weldsuite/reach-domain/events';
import type { Env, Variables } from '../../types';
import { reachErrorHandler } from '../../services/reach-errors';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Entity events of this request. The entity-event coverage sweep reads this file, so the publish call is spelled out here. */
function requestSink(c: AppContext): ReachEventSink {
  return (event) => {
    publishEntityEvent({
      c,
      entityType: event.entityType,
      action: event.action,
      entityId: event.entityId,
      data: event.data,
      changes: event.changes ?? undefined,
    });
  };
}

/** Tell the send sweep when this workspace next has outreach due. */
function dueOf(c: AppContext): ReachDuePort {
  return (kind, at) => markWorkspaceDue(c.env.SCHEDULE_INDEX, kind, c.get('workspaceId'), at);
}

function depsOf(c: AppContext) {
  return { db: c.get('tenantDb'), emit: requestSink(c), onDue: dueOf(c), userId: c.get('userId') };
}

app.get('/', requirePermission('reach_campaigns:read'), async (c) => {
  const page = await listCampaigns(c.get('tenantDb'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.get('/:id', requirePermission('reach_campaigns:read'), async (c) => {
  return success(c, await getCampaignDetail(c.get('tenantDb'), c.req.param('id')));
});

app.post('/', requirePermission('reach_campaigns:create'), zValidator('json', createReachCampaignSchema), async (c) => {
  return success(c, await createCampaign(depsOf(c), c.req.valid('json')), 201);
});

app.patch('/:id', requirePermission('reach_campaigns:update'), zValidator('json', updateReachCampaignSchema), async (c) => {
  return success(c, await updateCampaign(depsOf(c), c.req.param('id'), c.req.valid('json')));
});

app.delete('/:id', requirePermission('reach_campaigns:delete'), async (c) => {
  await deleteCampaign(depsOf(c), c.req.param('id'));
  return noContent(c);
});

app.put('/:id/steps', requirePermission('reach_campaigns:update'), zValidator('json', replaceReachStepsSchema), async (c) => {
  return success(c, await replaceCampaignSteps(depsOf(c), c.req.param('id'), c.req.valid('json').steps));
});

app.put('/:id/mailboxes', requirePermission('reach_campaigns:update'), zValidator('json', setReachCampaignMailboxesSchema), async (c) => {
  return success(c, await setCampaignMailboxes(depsOf(c), c.req.param('id'), c.req.valid('json').mailboxIds));
});

app.post('/:id/prospects', requirePermission('reach_campaigns:update'), zValidator('json', addReachCampaignProspectsSchema), async (c) => {
  // appAccessGate sets `appAccess`; the optional chain keeps route tests that skip the gate working.
  const limits = resolveWeldReachLimits(c.get('appAccess')?.limits);
  return success(c, await enrollCampaignProspects({ ...depsOf(c), limits }, c.req.param('id'), c.req.valid('json')));
});

app.get('/:id/enrollments', requirePermission('reach_campaigns:read'), async (c) => {
  const page = await listEnrollments(c.get('tenantDb'), c.req.param('id'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.delete('/:id/enrollments/:enrollmentId', requirePermission('reach_campaigns:update'), async (c) => {
  await removeCampaignEnrollment(depsOf(c), c.req.param('id'), c.req.param('enrollmentId'));
  return noContent(c);
});

app.post('/:id/launch', requirePermission('reach_campaigns:update'), async (c) => {
  return success(c, await launchCampaign(depsOf(c), c.req.param('id')));
});

app.post('/:id/pause', requirePermission('reach_campaigns:update'), async (c) => {
  return success(c, await pauseCampaign(depsOf(c), c.req.param('id')));
});

app.post('/:id/resume', requirePermission('reach_campaigns:update'), async (c) => {
  return success(c, await resumeCampaign(depsOf(c), c.req.param('id')));
});

app.post('/:id/preview', requirePermission('reach_campaigns:read'), zValidator('json', previewReachStepSchema), async (c) => {
  return success(c, await previewCampaignStep(c.get('tenantDb'), c.req.param('id'), c.req.valid('json')));
});

app.get('/:id/stats', requirePermission('reach_campaigns:read'), async (c) => {
  return success(c, await getCampaignStats(c.get('tenantDb'), c.req.param('id')));
});

export default app;
