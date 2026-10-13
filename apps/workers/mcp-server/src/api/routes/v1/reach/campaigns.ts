/**
 * Campaigns: /v1/reach/campaigns
 *
 * Scopes: reach_campaigns:read (list, get, enrollments, stats) and
 * reach_campaigns:write (create, update, delete, steps, mailboxes, enrolling,
 * removing an enrollment, launch, pause, resume).
 *
 * The same domain functions as reach-api's `/api/reach/campaigns`
 * (`@weldsuite/reach-domain/campaigns`), so the validation, the launch checks
 * and the entity events (`reach_campaign` created / updated / deleted /
 * launched / paused / completed) are the app's. Launching, resuming and
 * enrolling into a running campaign wake the send sweep; the sending itself
 * happens in reach-api's `reach-send` queue consumer, inside the campaign's
 * window. Wiring (events, the sweep, limits) is in `lib/reach.ts`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  addReachCampaignProspectsSchema,
  createReachCampaignSchema,
  replaceReachStepsSchema,
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
  removeCampaignEnrollment,
  replaceCampaignSteps,
  resumeCampaign,
  setCampaignMailboxes,
  updateCampaign,
} from '@weldsuite/reach-domain/campaigns';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, list, noContent, success } from '../../../lib/response';
import { reachDeps, reachValidation } from '../../../lib/reach';

const app = new Hono<HonoEnv>();

app.get('/', requireScope('reach_campaigns:read'), async (c) => {
  const page = await listCampaigns(c.get('tenantDb'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.get('/:id', requireScope('reach_campaigns:read'), async (c) => {
  return success(c, await getCampaignDetail(c.get('tenantDb'), c.req.param('id')));
});

app.post('/', requireScope('reach_campaigns:write'), zValidator('json', createReachCampaignSchema, reachValidation), async (c) => {
  return success(c, await createCampaign(reachDeps(c), c.req.valid('json')), 201);
});

app.patch('/:id', requireScope('reach_campaigns:write'), zValidator('json', updateReachCampaignSchema, reachValidation), async (c) => {
  return success(c, await updateCampaign(reachDeps(c), c.req.param('id'), c.req.valid('json')));
});

app.delete('/:id', requireScope('reach_campaigns:write'), async (c) => {
  await deleteCampaign(reachDeps(c), c.req.param('id'));
  return noContent(c);
});

app.put('/:id/steps', requireScope('reach_campaigns:write'), zValidator('json', replaceReachStepsSchema, reachValidation), async (c) => {
  return success(c, await replaceCampaignSteps(reachDeps(c), c.req.param('id'), c.req.valid('json').steps));
});

app.put('/:id/mailboxes', requireScope('reach_campaigns:write'), zValidator('json', setReachCampaignMailboxesSchema, reachValidation), async (c) => {
  return success(c, await setCampaignMailboxes(reachDeps(c), c.req.param('id'), c.req.valid('json').mailboxIds));
});

app.post('/:id/prospects', requireScope('reach_campaigns:write'), zValidator('json', addReachCampaignProspectsSchema, reachValidation), async (c) => {
  return success(c, await enrollCampaignProspects(reachDeps(c), c.req.param('id'), c.req.valid('json')));
});

app.get('/:id/enrollments', requireScope('reach_campaigns:read'), async (c) => {
  const page = await listEnrollments(c.get('tenantDb'), c.req.param('id'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.delete('/:id/enrollments/:enrollmentId', requireScope('reach_campaigns:write'), async (c) => {
  await removeCampaignEnrollment(reachDeps(c), c.req.param('id'), c.req.param('enrollmentId'));
  return noContent(c);
});

app.post('/:id/launch', requireScope('reach_campaigns:write'), async (c) => {
  return success(c, await launchCampaign(reachDeps(c), c.req.param('id')));
});

app.post('/:id/pause', requireScope('reach_campaigns:write'), async (c) => {
  return success(c, await pauseCampaign(reachDeps(c), c.req.param('id')));
});

app.post('/:id/resume', requireScope('reach_campaigns:write'), async (c) => {
  return success(c, await resumeCampaign(reachDeps(c), c.req.param('id')));
});

app.get('/:id/stats', requireScope('reach_campaigns:read'), async (c) => {
  return success(c, await getCampaignStats(c.get('tenantDb'), c.req.param('id')));
});

export default app;
