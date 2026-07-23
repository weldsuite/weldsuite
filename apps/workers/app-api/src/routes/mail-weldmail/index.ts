/**
 * WeldMail routes — /api/mail-weldmail/*.
 *
 * Manage reserved addresses on the workspace's shared
 * `{slug}.weldmail.com` subdomain. Plan limits gate how many can be
 * reserved; Cloudflare Email Routing on the shared zone is already
 * provisioned, so reservation is a pure DB-side operation.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import * as weldmail from '../../services/mail/weldmail';
import { WeldMailError } from '../../services/mail/weldmail';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const addressSchema = z
  .string()
  .min(3, 'Address must be at least 3 characters')
  .max(64, 'Address must be at most 64 characters')
  .regex(
    /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/i,
    'Address can only contain letters, numbers, dots, hyphens, and underscores',
  )
  .transform((v) => v.toLowerCase());

const checkBody = z.object({ address: addressSchema });
const reserveBody = z.object({
  address: addressSchema,
  name: z.string().min(1).max(255).optional(),
  displayName: z.string().max(255).optional(),
});

function mapWeldMailError(c: Parameters<typeof error.badRequest>[0], err: WeldMailError) {
  switch (err.code) {
    case 'WORKSPACE_NOT_FOUND':
    case 'ADDRESS_NOT_FOUND':
      return error.notFound(c, err.message);
    case 'RESERVED_ADDRESS':
      return error.badRequest(c, err.message);
    case 'ADDRESS_TAKEN':
      return error.conflict(c, err.message);
    case 'PLAN_DISABLED':
      return error.forbidden(c, err.message);
    case 'PLAN_LIMIT_REACHED':
      return error.badRequest(c, err.message);
  }
}

app.get('/domain', requirePermission('accounts:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  try {
    const domain = await weldmail.getWeldMailDomain(c.env, orgId);
    return success(c, { domain });
  } catch (err) {
    if (err instanceof WeldMailError) return mapWeldMailError(c, err);
    console.error('[app-api/mail-weldmail] domain failed:', err);
    return error.internal(c, 'Failed to fetch WeldMail domain');
  }
});

app.post(
  '/check',
  requirePermission('accounts:read'),
  zValidator('json', checkBody),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    try {
      const result = await weldmail.checkAddressAvailability(
        c.env,
        orgId,
        c.req.valid('json').address,
      );
      return success(c, result);
    } catch (err) {
      if (err instanceof WeldMailError) return mapWeldMailError(c, err);
      console.error('[app-api/mail-weldmail] check failed:', err);
      return error.internal(c, 'Failed to check address');
    }
  },
);

app.post(
  '/reserve',
  requirePermission('accounts:create'),
  zValidator('json', reserveBody),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    try {
      const account = await weldmail.reserveAddress(
        c.env,
        c.get('tenantDb'),
        orgId,
        c.req.valid('json'),
      );
      return success(
        c,
        {
          id: account.id,
          email: account.email,
          name: account.name,
          displayName: account.displayName,
          isDefault: account.isDefault,
        },
        201,
      );
    } catch (err) {
      if (err instanceof WeldMailError) return mapWeldMailError(c, err);
      // Trap Postgres unique-constraint violations as a friendlier 409.
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505') {
        return error.conflict(c, 'This address is already taken');
      }
      console.error('[app-api/mail-weldmail] reserve failed:', err);
      return error.internal(c, 'Failed to reserve address');
    }
  },
);

app.get('/', requirePermission('accounts:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  try {
    const result = await weldmail.listAddresses(c.env, c.get('tenantDb'), orgId);
    return success(c, result);
  } catch (err) {
    if (err instanceof WeldMailError) return mapWeldMailError(c, err);
    console.error('[app-api/mail-weldmail] list failed:', err);
    return error.internal(c, 'Failed to list addresses');
  }
});

app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const id = c.req.param('id');
  try {
    const result = await weldmail.releaseAddress(c.env, c.get('tenantDb'), orgId, id);
    return success(c, { deleted: true, ...result });
  } catch (err) {
    if (err instanceof WeldMailError) return mapWeldMailError(c, err);
    console.error('[app-api/mail-weldmail] release failed:', err);
    return error.internal(c, 'Failed to release address');
  }
});

export const mailWeldMailRoutes = app;
