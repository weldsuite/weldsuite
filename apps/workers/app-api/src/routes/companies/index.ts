/**
 * Companies routes — /api/companies/*.
 *
 * Canonical surface used by the company object panel + grid + person panel
 * popovers, by the customer detail page, and by `useCompanyLiveSync`.
 * Successor to `apps/core-api/src/routes/weldcrm/companies.ts`.
 *
 * Uses the dedicated `companies:*` permission set (read/create/update/delete)
 * from `@weldsuite/permissions`'s catalog. Distinct from `customers:*` —
 * the customer surface is a status-flag projection on top of companies, not
 * a separate object.
 */

import { Hono } from 'hono';
import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission, ensurePermissionsResolved } from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createCompanySchema,
  updateCompanySchema,
  listCompaniesQuery,
  companyDetailQuery,
  companyNavigationQuery,
  bulkUpdateCompaniesSchema,
  importCompaniesSchema,
  exportCompaniesQuery,
} from '@weldsuite/app-api-client/schemas/companies';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as companiesService from '../../services/companies';
import { fetchAndStoreLogo } from '../../lib/logo-fetch';
import { companyChatRoutes } from './chat';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Returns undefined for users WITH companies:scope:all (no owner filter),
 * or their own userId for users who may only see their own records.
 */
async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  const perms = resolved?.permissions ?? [];
  if (hasPermission(perms, 'companies:scope:all')) return undefined;
  return c.get('userId');
}

app.get(
  '/',
  requirePermission('companies:read'),
  zValidator('query', listCompaniesQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const params = c.req.valid('query');
    const scope = await scopeFor(c);
    try {
      const result = await companiesService.listCompanies(db, params, scope);
      return list(
        c,
        result.data,
        cursorPagination(result.totalCount, result.hasMore, result.cursor),
      );
    } catch (err) {
      console.error('[app-api/companies] list failed:', err);
      return error.internal(c, 'Failed to list companies');
    }
  },
);

/**
 * POST /api/companies/import — upsert a batch (≤500) of companies, matched by
 * partyCode then email. Per-row created/updated entity events are emitted.
 *
 * Mounted before `:id` routes so `import` isn't claimed by `/:id`.
 */
app.post(
  '/import',
  requirePermission('companies:create'),
  zValidator('json', importCompaniesSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const { records } = c.req.valid('json');
    try {
      const result = await companiesService.importCompanies(db, records);
      for (const changed of result.changedRows) {
        publishEntityEvent({
          c,
          entityType: 'company',
          entityId: changed.id,
          action: changed.action,
          data: {
            id: changed.row.id,
            name: changed.row.name,
            website: changed.row.website,
            industry: changed.row.industry,
          },
        });
      }
      return success(c, {
        imported: result.imported,
        updated: result.updated,
        failed: result.failed,
        total: result.total,
        errors: result.errors,
      });
    } catch (err) {
      console.error('[app-api/companies] import failed:', err);
      return error.internal(c, 'Failed to import companies');
    }
  },
);

/**
 * GET /api/companies/export — every company matching the list filters (no
 * pagination). The client renders the rows to CSV/XLSX. Mounted before `:id`
 * so `export` isn't claimed by `/:id`.
 */
app.get(
  '/export',
  requirePermission('companies:read'),
  zValidator('query', exportCompaniesQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const filter = c.req.valid('query');
    const scope = await scopeFor(c);
    try {
      const rows = await companiesService.exportCompanies(db, filter, scope);
      return success(c, rows);
    } catch (err) {
      console.error('[app-api/companies] export failed:', err);
      return error.internal(c, 'Failed to export companies');
    }
  },
);

app.get('/:id', requirePermission('companies:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const company = await companiesService.getCompany(db, id, scope);
    if (!company) return error.notFound(c, 'Company', id);
    return success(c, company);
  } catch (err) {
    console.error('[app-api/companies] get failed:', err);
    return error.internal(c, 'Failed to fetch company');
  }
});

app.post(
  '/',
  requirePermission('companies:create'),
  zValidator('json', createCompanySchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const userId = c.get('userId');
    try {
      const created = await companiesService.createCompany(db, { ...data, ownerId: data.ownerId ?? userId });
      publishEntityEvent({
        c,
        entityType: 'company',
        entityId: created.id,
        action: 'created',
        data: {
          id: created.id,
          name: created.name,
          website: created.website,
          industry: created.industry,
        },
      });
      return success(c, created, 201);
    } catch (err) {
      console.error('[app-api/companies] create failed:', err);
      return error.internal(c, 'Failed to create company');
    }
  },
);

app.patch(
  '/:id',
  requirePermission('companies:update'),
  zValidator('json', updateCompanySchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const scope = await scopeFor(c);
    try {
      const result = await companiesService.updateCompany(db, id, data, scope);
      if (!result) return error.notFound(c, 'Company', id);
      const { row, changes } = result;
      publishEntityEvent({
        c,
        entityType: 'company',
        entityId: row.id,
        action: 'updated',
        data: {
          id: row.id,
          name: row.name,
          website: row.website,
          industry: row.industry,
        },
        changes,
      });
      return success(c, row);
    } catch (err) {
      if (err instanceof companiesService.CompanyVersionConflictError) {
        return error.conflict(c, err.message);
      }
      console.error('[app-api/companies] update failed:', err);
      return error.internal(c, 'Failed to update company');
    }
  },
);

app.delete('/:id', requirePermission('companies:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const ok = await companiesService.deleteCompany(db, id, scope);
    if (!ok) return error.notFound(c, 'Company', id);
    publishEntityEvent({
      c,
      entityType: 'company',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/companies] delete failed:', err);
    return error.internal(c, 'Failed to delete company');
  }
});

app.post('/:id/archive', requirePermission('companies:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const updated = await companiesService.archiveCompany(db, id, scope);
    if (!updated) return error.notFound(c, 'Company', id);
    publishEntityEvent({
      c,
      entityType: 'company',
      entityId: updated.id,
      action: 'archived',
      data: {
        id: updated.id,
        name: updated.name,
      },
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/companies] archive failed:', err);
    return error.internal(c, 'Failed to archive company');
  }
});

app.post('/:id/unarchive', requirePermission('companies:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const updated = await companiesService.unarchiveCompany(db, id, scope);
    if (!updated) return error.notFound(c, 'Company', id);
    publishEntityEvent({
      c,
      entityType: 'company',
      entityId: updated.id,
      action: 'unarchived',
      data: {
        id: updated.id,
        name: updated.name,
      },
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/companies] unarchive failed:', err);
    return error.internal(c, 'Failed to unarchive company');
  }
});

/**
 * GET /api/companies/:id/people — every person linked to this company,
 * enriched with the joined person's display name / email / avatar.
 */
app.get('/:id/people', requirePermission('companies:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const rows = await companiesService.listCompanyPeople(db, id, scope);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/companies] people fetch failed:', err);
    return error.internal(c, 'Failed to list company people');
  }
});

/**
 * POST /api/companies/bulk-update — atomic multi-row patch on a safe set
 * of fields (ownerId, accountManagerId, status, lifecycleStage). Per-row
 * entity events are emitted so subscribers see each change.
 *
 * Mounted before `:id` routes — `bulk-update` would otherwise be claimed
 * by `/:id`.
 */
app.post(
  '/bulk-update',
  requirePermission('companies:update'),
  zValidator('json', bulkUpdateCompaniesSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const input = c.req.valid('json');
    const scope = await scopeFor(c);
    try {
      const result = await companiesService.bulkUpdateCompanies(db, input, scope);
      for (const row of result.changedRows) {
        publishEntityEvent({
          c,
          entityType: 'company',
          entityId: row.id,
          action: 'updated',
          data: { id: row.id, ...row.after },
          changes: Object.fromEntries(
            Object.entries(row.after).map(([k, v]) => [k, { old: (row.before as Record<string, unknown>)[k], new: v }]),
          ),
        });
      }
      return success(c, { updated: result.updated, failed: result.failed });
    } catch (err) {
      console.error('[app-api/companies] bulk-update failed:', err);
      return error.internal(c, 'Failed to bulk-update companies');
    }
  },
);

/**
 * GET /api/companies/:id/detail — aggregate read used by the company
 * detail page. Returns the company + its people + recent
 * activities/orders/opportunities + list memberships + counts.
 */
app.get(
  '/:id/detail',
  requirePermission('companies:read'),
  zValidator('query', companyDetailQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const opts = c.req.valid('query');
    const scope = await scopeFor(c);
    try {
      const detail = await companiesService.getCompanyDetail(db, id, opts, scope);
      if (!detail) return error.notFound(c, 'Company', id);
      return success(c, detail);
    } catch (err) {
      console.error('[app-api/companies] detail fetch failed:', err);
      return error.internal(c, 'Failed to fetch company detail');
    }
  },
);

/**
 * GET /api/companies/:id/navigation — prev/next ids relative to the list
 * view the user came from. `listId` scopes navigation to a custom list;
 * otherwise navigation runs across all non-deleted companies sorted by
 * createdAt desc (matching the default grid order).
 */
app.get(
  '/:id/navigation',
  requirePermission('companies:read'),
  zValidator('query', companyNavigationQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { listId } = c.req.valid('query');
    const scope = await scopeFor(c);
    try {
      const nav = await companiesService.getCompanyNavigation(db, id, { listId }, scope);
      if (!nav) return error.notFound(c, 'Company', id);
      return success(c, nav);
    } catch (err) {
      console.error('[app-api/companies] navigation fetch failed:', err);
      return error.internal(c, 'Failed to fetch company navigation');
    }
  },
);

/**
 * POST /api/companies/:id/refresh-logo — re-runs the Hunter.io + R2 fetch
 * and writes the resulting public URL back to the company.
 */
app.post('/:id/refresh-logo', requirePermission('companies:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const storage = c.env.STORAGE as R2Bucket | undefined;
    const r2PublicUrl = c.env.R2_PUBLIC_URL as string | undefined;
    if (!storage || !r2PublicUrl) {
      return error.internal(c, 'Logo storage is not configured');
    }
    const workspaceId =
      (c.get('workspaceId') as string | undefined) ??
      (c.get('orgId') as string | undefined) ??
      'unknown';
    const result = await companiesService.refreshCompanyLogo(db, id, async (args) => {
      try {
        return await fetchAndStoreLogo({
          email: args.email ?? undefined,
          customerName: args.companyName ?? id,
          website: args.website ?? undefined,
          customerId: id,
          workspaceId,
          storage,
          r2PublicUrl,
          entityFolder: 'companies',
        });
      } catch (err) {
        console.error('[app-api/companies] logo fetch failed:', err);
        return null;
      }
    }, scope);
    if (!result) return error.notFound(c, 'Company', id);
    publishEntityEvent({
      c,
      entityType: 'company',
      entityId: result.company.id,
      action: 'updated',
      data: {
        id: result.company.id,
        name: result.company.name,
        website: result.company.website,
      },
    });
    return success(c, result.company);
  } catch (err) {
    console.error('[app-api/companies] refresh-logo failed:', err);
    return error.internal(c, 'Failed to refresh company logo');
  }
});

app.route('/:id/chat', companyChatRoutes);

export const companiesRoutes = app;
