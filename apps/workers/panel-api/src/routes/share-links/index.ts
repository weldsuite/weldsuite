/**
 * Public share links: /api/panel/share-links/*.
 *
 *   GET    /       → ?targetType&targetId: the target's links (revoked ones too), newest first
 *   POST   /       → new link: answers the token and the URL, once (`PanelCreatedShareLinkDto`)
 *   DELETE /:id    → revoke (tenant row and master registry); safe to repeat
 *
 * Creating needs `panel_reports:create` and a target the caller may change
 * (their own, or a shared one with `panel_projects:manage`), so a private
 * report of someone else can never be shared. A report (or a dashboard with
 * one) that shows people data is refused with `422 NOT_SHAREABLE`
 * (`details.reasons`). Listing needs `panel_reports:read` and a target the
 * caller may see; revoking needs `panel_reports:delete` and being the link's
 * creator or able to change the target.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createPanelShareLinkSchema,
  panelShareUrl,
  panelTargetQuerySchema,
  type PanelCreatedShareLinkDto,
  type PanelNotShareableDetails,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelShareLink } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { canChange, canSee, getTarget, type Actor } from '../../services/saved-objects';
import {
  createShareLink,
  getShareLink,
  listShareLinks,
  revokeShareLink,
  shareLinkEventData,
  ShareLinkError,
  targetRefusals,
  toShareLinkDto,
} from '../../services/share-links';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_PLATFORM_URL = 'https://app.weldsuite.org';

async function actorOf(c: Ctx): Promise<Actor> {
  return { userId: c.get('userId'), canManage: await hasContextPermission(c, 'panel_projects:manage') };
}

function publish(c: Ctx, link: PanelShareLink, action: 'created' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_share_link', entityId: link.id, action, data: shareLinkEventData(link) });
}

const targetLabel = (type: 'report' | 'dashboard') => (type === 'report' ? 'Report' : 'Dashboard');

app.get('/', requirePermission('panel_reports:read'), zValidator('query', panelTargetQuerySchema), async (c) => {
  const { targetType, targetId } = c.req.valid('query');
  const db = c.get('tenantDb');
  const target = await getTarget(db, targetType, targetId);
  if (!target || !canSee(target.row, await actorOf(c))) return error.notFound(c, targetLabel(targetType), targetId);
  const links = await listShareLinks(db, targetType, targetId);
  return list(c, links.map(toShareLinkDto), cursorPagination(links.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelShareLinkSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  const actor = await actorOf(c);
  const target = await getTarget(db, input.targetType, input.targetId);
  if (!target || !canSee(target.row, actor)) return error.notFound(c, targetLabel(input.targetType), input.targetId);
  if (!canChange(target.row, actor)) return error.forbidden(c, `Only the owner can share this ${input.targetType}`);

  const reasons = await targetRefusals(db, target);
  if (reasons.length > 0) {
    const details: PanelNotShareableDetails = { reasons };
    return c.json(
      { error: { code: 'NOT_SHAREABLE', message: 'People data cannot be shared publicly: remove person, URL and element-text breakdowns', details } },
      422,
    );
  }

  let created: Awaited<ReturnType<typeof createShareLink>>;
  try {
    created = await createShareLink(db, getMasterDb(c.env), { workspaceId, target, input, userId });
  } catch (err) {
    if (err instanceof ShareLinkError) return err.status === 409 ? error.conflict(c, err.message) : error.badRequest(c, err.message);
    throw err;
  }
  publish(c, created.link, 'created');
  const body: PanelCreatedShareLinkDto = {
    ...toShareLinkDto(created.link),
    token: created.token,
    url: panelShareUrl(c.env.PLATFORM_URL ?? DEFAULT_PLATFORM_URL, created.token),
  };
  return success(c, body, 201);
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const id = c.req.param('id');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const db = c.get('tenantDb');
  const link = await getShareLink(db, id);
  if (!link) return error.notFound(c, 'Share link', id);
  const actor = await actorOf(c);
  const target = await getTarget(db, link.targetType, link.targetId);
  if (target && !canSee(target.row, actor)) return error.notFound(c, 'Share link', id);
  const mayRevoke = link.createdByUserId === actor.userId || (target ? canChange(target.row, actor) : actor.canManage);
  if (!mayRevoke) return error.forbidden(c, 'Only the creator or the owner can revoke this link');

  const revoked = await revokeShareLink(db, getMasterDb(c.env), workspaceId, link);
  publish(c, revoked, 'deleted');
  return noContent(c);
});

export default app;
