/**
 * DNS zones routes — /api/dns-zones/*.
 *
 * Permissions: `dns:read | dns:create | dns:update | dns:delete`.
 * Entity events: `dns_zone:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  listDnsZonesQuery,
  createDnsZoneSchema,
  updateDnsZoneSchema,
} from '@weldsuite/core-api-client/schemas/dns-zones';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as dnsZonesService from '../../services/dns-zones';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('dns:read'), zValidator('query', listDnsZonesQuery), async (c) => {
  try {
    const result = await dnsZonesService.listDnsZones(c.get('tenantDb'), c.req.valid('query'));
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/dns-zones] list failed:', err);
    return error.internal(c, 'Failed to list DNS zones');
  }
});

app.get('/by-domain/:domainId', requirePermission('dns:read'), async (c) => {
  const domainId = c.req.param('domainId');
  try {
    const row = await dnsZonesService.getDnsZoneByDomain(c.get('tenantDb'), domainId);
    if (!row) return error.notFound(c, 'DNS zone for domain', domainId);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/dns-zones] get-by-domain failed:', err);
    return error.internal(c, 'Failed to fetch DNS zone');
  }
});

app.get('/:id', requirePermission('dns:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await dnsZonesService.getDnsZone(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'DNS zone', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/dns-zones] get failed:', err);
    return error.internal(c, 'Failed to fetch DNS zone');
  }
});

app.post(
  '/',
  requirePermission('dns:create'),
  zValidator('json', createDnsZoneSchema),
  async (c) => {
    try {
      const row = await dnsZonesService.createDnsZone(c.get('tenantDb'), c.req.valid('json'));
      publishEntityEvent({
        c,
        entityType: 'dns_zone',
        entityId: row.id,
        action: 'created',
        data: { id: row.id, name: row.name, status: row.status },
      });
      return success(c, row, 201);
    } catch (err) {
      console.error('[app-api/dns-zones] create failed:', err);
      return error.internal(c, 'Failed to create DNS zone');
    }
  },
);

app.patch(
  '/:id',
  requirePermission('dns:update'),
  zValidator('json', updateDnsZoneSchema),
  async (c) => {
    const id = c.req.param('id');
    try {
      const row = await dnsZonesService.updateDnsZone(
        c.get('tenantDb'),
        id,
        c.req.valid('json') as Record<string, unknown>,
      );
      if (!row) return error.notFound(c, 'DNS zone', id);
      publishEntityEvent({
        c,
        entityType: 'dns_zone',
        entityId: row.id,
        action: 'updated',
        data: { id: row.id, name: row.name, status: row.status },
      });
      return success(c, row);
    } catch (err) {
      console.error('[app-api/dns-zones] update failed:', err);
      return error.internal(c, 'Failed to update DNS zone');
    }
  },
);

app.delete('/:id', requirePermission('dns:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const deleted = await dnsZonesService.deleteDnsZone(c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'DNS zone', id);
    publishEntityEvent({
      c,
      entityType: 'dns_zone',
      entityId: id,
      action: 'deleted',
      data: { id, name: deleted.name, status: deleted.status },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/dns-zones] delete failed:', err);
    return error.internal(c, 'Failed to delete DNS zone');
  }
});

export const dnsZonesRoutes = app;
