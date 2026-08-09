/**
 * Domain transfer routes — /api/domain-transfers/*.
 *
 * Permissions: `transfers:read | transfers:create | transfers:update | transfers:delete`.
 * Entity events: `domain_transfer:created | updated | approved | rejected | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  listDomainTransfersQuery,
  createDomainTransferSchema,
  failDomainTransferSchema,
} from '@weldsuite/core-api-client/schemas/domain-transfers';
import { RealtimeRegistrar, RealtimeRegistrarError } from '@weldsuite/realtime-registrar';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import * as transfersService from '../../services/domain-transfers';
import * as domainsService from '../../services/domains';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function getRealtimeRegistrar(env: Env): RealtimeRegistrar | null {
  const apiKey = env.REALTIME_REGISTER_API_KEY;
  const customer = env.REALTIME_REGISTER_CUSTOMER;
  if (!apiKey || !customer) return null;
  return new RealtimeRegistrar({
    apiKey,
    customer,
    ote: env.REALTIME_REGISTER_OTE === 'true',
  });
}

app.get(
  '/',
  requirePermission('transfers:read'),
  zValidator('query', listDomainTransfersQuery),
  async (c) => {
    try {
      const result = await transfersService.listDomainTransfers(
        c.get('tenantDb'),
        c.req.valid('query') as never,
      );
      return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
    } catch (err) {
      console.error('[app-api/domain-transfers] list failed:', err);
      return error.internal(c, 'Failed to list domain transfers');
    }
  },
);

app.get('/:id', requirePermission('transfers:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const rtr = getRealtimeRegistrar(c.env);
    if (rtr) {
      await transfersService.syncTransferFromRegistrar(c.get('tenantDb'), rtr, id);
    }
    const row = await transfersService.getDomainTransfer(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Domain transfer', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/domain-transfers] get failed:', err);
    return error.internal(c, 'Failed to fetch domain transfer');
  }
});

app.post(
  '/',
  requirePermission('transfers:create'),
  zValidator('json', createDomainTransferSchema),
  async (c) => {
    try {
      const input = c.req.valid('json');
      const rtr = getRealtimeRegistrar(c.env);
      let registrantContact: Record<string, unknown> | null = null;
      let nameservers: string[] | undefined;
      if (input.domainId) {
        const domain = await domainsService.getDomain(c.get('tenantDb'), input.domainId);
        registrantContact = (domain?.registrantContact as Record<string, unknown> | null) ?? null;
        nameservers = (domain?.nameservers as string[] | null) ?? undefined;
      }

      const row = await transfersService.createDomainTransfer(
        c.get('tenantDb'),
        input,
        {
          rtr: input.type === 'incoming' ? rtr : null,
          contactEnv: {
            REALTIME_REGISTER_CONTACT_ADMIN: c.env.REALTIME_REGISTER_CONTACT_ADMIN,
            REALTIME_REGISTER_CONTACT_TECH: c.env.REALTIME_REGISTER_CONTACT_TECH,
            REALTIME_REGISTER_CONTACT_BILLING: c.env.REALTIME_REGISTER_CONTACT_BILLING,
          },
          registrantContact,
          nameservers,
        },
      );

      if (row.externalTransferId && c.env.WORKSPACE_CACHE) {
        const workspaceId = c.get('workspaceId');
        if (workspaceId) {
          await c.env.WORKSPACE_CACHE.put(
            `rtr:process:${row.externalTransferId}`,
            JSON.stringify({
              workspaceId,
              transferId: row.id,
              domainId: row.domainId,
              kind: 'transfer',
            }),
            { expirationTtl: 60 * 60 * 24 * 14 },
          );
        }
      }

      publishEntityEvent({
        c,
        entityType: 'domain_transfer',
        entityId: row.id,
        action: 'created',
        data: { id: row.id, domainName: row.domainName, type: row.type, status: row.status },
      });
      return success(c, row, 201);
    } catch (err) {
      if (err instanceof RealtimeRegistrarError) {
        console.error('[app-api/domain-transfers] RTR create failed:', err.message);
        return error.badRequest(c, err.message);
      }
      console.error('[app-api/domain-transfers] create failed:', err);
      return error.internal(
        c,
        err instanceof Error ? err.message : 'Failed to create domain transfer',
      );
    }
  },
);

app.patch('/:id/complete', requirePermission('transfers:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await transfersService.completeDomainTransfer(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Domain transfer', id);
    publishEntityEvent({
      c,
      entityType: 'domain_transfer',
      entityId: row.id,
      action: 'updated',
      data: { id: row.id, domainName: row.domainName, type: row.type, status: row.status },
    });
    return success(c, row);
  } catch (err) {
    console.error('[app-api/domain-transfers] complete failed:', err);
    return error.internal(c, 'Failed to complete domain transfer');
  }
});

app.patch('/:id/sync', requirePermission('transfers:update'), async (c) => {
  const id = c.req.param('id');
  const rtr = getRealtimeRegistrar(c.env);
  if (!rtr) {
    return c.json(
      { error: { code: 'SERVICE_UNAVAILABLE', message: 'Realtime Register is not configured' } },
      503,
    );
  }
  try {
    const row = await transfersService.syncTransferFromRegistrar(c.get('tenantDb'), rtr, id);
    if (!row) return error.notFound(c, 'Domain transfer', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/domain-transfers] sync failed:', err);
    return error.internal(c, 'Failed to sync domain transfer');
  }
});

app.patch(
  '/:id/fail',
  requirePermission('transfers:update'),
  zValidator('json', failDomainTransferSchema),
  async (c) => {
    const id = c.req.param('id');
    const reason = c.req.valid('json').reason ?? 'Unknown error';
    try {
      const row = await transfersService.failDomainTransfer(c.get('tenantDb'), id, reason);
      if (!row) return error.notFound(c, 'Domain transfer', id);
      publishEntityEvent({
        c,
        entityType: 'domain_transfer',
        entityId: row.id,
        action: 'updated',
        data: { id: row.id, domainName: row.domainName, type: row.type, status: row.status },
      });
      return success(c, row);
    } catch (err) {
      console.error('[app-api/domain-transfers] fail failed:', err);
      return error.internal(c, 'Failed to mark domain transfer as failed');
    }
  },
);

export const domainTransfersRoutes = app;
