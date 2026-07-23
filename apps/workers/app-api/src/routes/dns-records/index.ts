/**
 * DNS records routes — /api/dns-records/*.
 *
 * Cloudflare is the source of truth: every mutation calls the CF API
 * and immediately resyncs the local table. The route surface mirrors
 * the legacy `/host/domains/:id/dns*` set but lives under a flat
 * object-based prefix.
 *
 * Permissions: `dns:read | dns:create | dns:update | dns:delete`.
 * Entity events: `dns_record:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  listDnsRecordsQuery,
  createDnsRecordSchema,
  updateDnsRecordSchema,
  toggleDnsRecordLockSchema,
  importDnsRecordsSchema,
} from '@weldsuite/core-api-client/schemas/dns-records';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import * as dnsRecordsService from '../../services/dns-records';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// Listing surfaces (must come before `/:id`)
// ============================================================================

app.get(
  '/by-zone/:zoneId',
  requirePermission('dns:read'),
  async (c) => {
    const zoneId = c.req.param('zoneId');
    try {
      const result = await dnsRecordsService.listDnsRecordsByZone(
        c.get('tenantDb'),
        zoneId,
        c.env.CLOUDFLARE_API_TOKEN,
      );
      if (!result) return error.notFound(c, 'DNS zone', zoneId);
      return success(c, result);
    } catch (err) {
      console.error('[app-api/dns-records] list-by-zone failed:', err);
      return error.internal(c, 'Failed to list DNS records');
    }
  },
);

app.get('/by-domain/:domainId', requirePermission('dns:read'), async (c) => {
  const domainId = c.req.param('domainId');
  try {
    const result = await dnsRecordsService.listDnsRecordsByDomain(
      c.get('tenantDb'),
      domainId,
      c.env.CLOUDFLARE_API_TOKEN,
    );
    if (!result) return error.notFound(c, 'Domain', domainId);
    return success(c, result);
  } catch (err) {
    console.error('[app-api/dns-records] list-by-domain failed:', err);
    return error.internal(c, 'Failed to list DNS records');
  }
});

app.post('/by-zone/:zoneId/sync', requirePermission('dns:read'), async (c) => {
  const zoneId = c.req.param('zoneId');
  const ready = await dnsRecordsService.resolveCloudflareReadyByZone(
    c.get('tenantDb'),
    zoneId,
    c.env.CLOUDFLARE_API_TOKEN,
  );
  if (!ready.ok) {
    if (ready.reason === 'not_found') return error.notFound(c, 'DNS zone', zoneId);
    if (ready.reason === 'no_cf_zone') return error.badRequest(c, 'This zone is not managed by Cloudflare.');
    return error.internal(c, 'Cloudflare integration is not configured.');
  }
  const sync = await dnsRecordsService.syncRecordsFromCloudflare(
    c.get('tenantDb'),
    c.env.CLOUDFLARE_API_TOKEN!,
    ready.zone,
  );
  if (!sync.ok) {
    return c.json(
      {
        success: false,
        data: { records: sync.records, added: sync.added, updated: sync.updated, removed: sync.removed },
        error: { code: 'CLOUDFLARE_ERROR', message: sync.error ?? 'Cloudflare sync failed' },
      },
      502,
    );
  }
  return success(c, {
    records: sync.records,
    added: sync.added,
    updated: sync.updated,
    removed: sync.removed,
  });
});

app.post('/by-domain/:domainId/scan', requirePermission('dns:read'), async (c) => {
  const domainId = c.req.param('domainId');
  const result = await dnsRecordsService.scanDnsRecordsForDomain(c.get('tenantDb'), domainId);
  if (!result.ok) {
    if (result.reason === 'not_found') return error.notFound(c, 'Domain', domainId);
    if (result.reason === 'no_cf_zone') return error.badRequest(c, 'This domain does not have a Cloudflare zone yet. Complete verification first.');
    if (result.reason === 'scan_failed') return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'DNS scan failed. Try again in a moment.' } }, 503);
  } else {
    return success(c, { records: result.records });
  }
});

app.post(
  '/by-domain/:domainId/import',
  requirePermission('dns:create'),
  zValidator('json', importDnsRecordsSchema),
  async (c) => {
    const domainId = c.req.param('domainId');
    if (!c.env.CLOUDFLARE_API_TOKEN) return error.internal(c, 'Cloudflare integration is not configured.');
    const result = await dnsRecordsService.importDnsRecords(
      c.get('tenantDb'),
      c.env.CLOUDFLARE_API_TOKEN,
      domainId,
      c.req.valid('json').records as never,
    );
    if (!result.ok) {
      if (result.reason === 'not_found') return error.notFound(c, 'Domain', domainId);
      if (result.reason === 'no_cf_zone') return error.badRequest(c, 'This domain does not have a Cloudflare zone yet.');
      return error.internal(c, 'Cloudflare integration is not configured.');
    }
    return success(c, { imported: result.imported, skipped: result.skipped, failed: result.failed });
  },
);

// ============================================================================
// Flat list (filterable by zoneId / type) — secondary surface for grids
// ============================================================================

app.get('/', requirePermission('dns:read'), zValidator('query', listDnsRecordsQuery), async (c) => {
  const q = c.req.valid('query');
  if (!q.zoneId) {
    // We require a zoneId for the flat list to keep payloads bounded.
    return error.badRequest(c, 'zoneId is required');
  }
  try {
    const result = await dnsRecordsService.listDnsRecordsByZone(
      c.get('tenantDb'),
      q.zoneId,
      c.env.CLOUDFLARE_API_TOKEN,
    );
    if (!result) return error.notFound(c, 'DNS zone', q.zoneId);
    return success(c, result);
  } catch (err) {
    console.error('[app-api/dns-records] flat list failed:', err);
    return error.internal(c, 'Failed to list DNS records');
  }
});

// ============================================================================
// Mutations — proxy to Cloudflare + reconcile
// ============================================================================

app.post(
  '/by-domain/:domainId',
  requirePermission('dns:create'),
  zValidator('json', createDnsRecordSchema),
  async (c) => {
    const domainId = c.req.param('domainId');
    const ready = await dnsRecordsService.resolveCloudflareReady(
      c.get('tenantDb'),
      domainId,
      c.env.CLOUDFLARE_API_TOKEN,
    );
    if (!ready.ok) {
      if (ready.reason === 'not_found') return error.notFound(c, 'Domain', domainId);
      if (ready.reason === 'no_cf_zone') return error.badRequest(c, 'This domain does not have a Cloudflare zone yet.');
      return error.internal(c, 'Cloudflare integration is not configured.');
    }
    const input = c.req.valid('json');
    const { cfError, sync } = await dnsRecordsService.createDnsRecord(
      c.get('tenantDb'),
      c.env.CLOUDFLARE_API_TOKEN!,
      ready.zone,
      input as never,
    );
    if (cfError) {
      return c.json(
        {
          success: false,
          data: { records: sync.records },
          error: { code: 'CLOUDFLARE_ERROR', message: cfError },
        },
        422,
      );
    }
    publishEntityEvent({
      c,
      entityType: 'dns_record',
      entityId: ready.zone.id,
      action: 'created',
      data: { id: ready.zone.id, zoneId: ready.zone.id, name: input.name, type: input.type, value: input.value },
    });
    return success(c, { records: sync.records }, 201);
  },
);

app.patch(
  '/:id',
  requirePermission('dns:update'),
  zValidator('json', updateDnsRecordSchema),
  async (c) => {
    const id = c.req.param('id');
    if (!c.env.CLOUDFLARE_API_TOKEN) return error.internal(c, 'Cloudflare integration is not configured.');
    const result = await dnsRecordsService.updateDnsRecord(
      c.get('tenantDb'),
      c.env.CLOUDFLARE_API_TOKEN,
      id,
      c.req.valid('json') as never,
    );
    if ('reason' in result) {
      if (result.reason === 'not_found') return error.notFound(c, 'DNS record', id);
      if (result.reason === 'no_cf_zone') return error.badRequest(c, 'This zone is not managed by Cloudflare.');
      if (result.reason === 'no_external_id') return error.badRequest(c, 'Record has no Cloudflare id — run a sync first.');
      if (result.reason === 'locked') {
        return c.json(
          {
            success: false,
            error: {
              code: 'RECORD_LOCKED',
              message: result.reasons[0] ?? 'This record is locked.',
              details: { reasons: result.reasons },
            },
          },
          423,
        );
      }
    }
    if ('cfError' in result && result.cfError) {
      return c.json(
        {
          success: false,
          data: { records: result.sync.records },
          error: { code: 'CLOUDFLARE_ERROR', message: result.cfError },
        },
        422,
      );
    }
    if ('sync' in result) {
      const input = c.req.valid('json');
      publishEntityEvent({
        c,
        entityType: 'dns_record',
        entityId: id,
        action: 'updated',
        data: { id, zoneId: id, name: input.name, type: input.type, value: input.value },
      });
      return success(c, { records: result.sync.records });
    }
    return error.internal(c, 'Failed to update DNS record');
  },
);

app.delete('/:id', requirePermission('dns:delete'), async (c) => {
  const id = c.req.param('id');
  if (!c.env.CLOUDFLARE_API_TOKEN) return error.internal(c, 'Cloudflare integration is not configured.');
  const result = await dnsRecordsService.deleteDnsRecord(
    c.get('tenantDb'),
    c.env.CLOUDFLARE_API_TOKEN,
    id,
  );
  if ('reason' in result) {
    if (result.reason === 'not_found') return error.notFound(c, 'DNS record', id);
    if (result.reason === 'no_cf_zone') return error.badRequest(c, 'This zone is not managed by Cloudflare.');
    if (result.reason === 'locked') {
      return c.json(
        {
          success: false,
          error: {
            code: 'RECORD_LOCKED',
            message: result.reasons[0] ?? 'This record is locked.',
            details: { reasons: result.reasons },
          },
        },
        423,
      );
    }
  }
  if ('cfError' in result && result.cfError) {
    return c.json(
      {
        success: false,
        data: { records: result.sync.records },
        error: { code: 'CLOUDFLARE_ERROR', message: result.cfError },
      },
      422,
    );
  }
  if ('sync' in result) {
    publishEntityEvent({
      c,
      entityType: 'dns_record',
      entityId: id,
      action: 'deleted',
      data: { id, zoneId: id },
    });
    return success(c, { records: result.sync.records });
  }
  return error.internal(c, 'Failed to delete DNS record');
});

app.post(
  '/:id/lock',
  requirePermission('dns:update'),
  zValidator('json', toggleDnsRecordLockSchema),
  async (c) => {
    const id = c.req.param('id');
    const { locked, reason } = c.req.valid('json');
    const reasonText = reason && reason.trim() ? reason.slice(0, 500) : 'Locked by user';
    const result = await dnsRecordsService.toggleUserLock(c.get('tenantDb'), id, {
      locked,
      reason: reasonText,
    });
    if (!result.ok) return error.notFound(c, 'DNS record', id);
    publishEntityEvent({
      c,
      entityType: 'dns_record',
      entityId: id,
      action: 'updated',
      data: { id, zoneId: result.zoneId },
    });
    return success(c, { records: result.records });
  },
);

export const dnsRecordsRoutes = app;
