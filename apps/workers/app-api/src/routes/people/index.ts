/**
 * People routes — /api/people/*.
 *
 * Canonical surface used by the person object panel + grid + company panel
 * popovers + `useCompanyLiveSync`-style cache reconcilers. Successor to
 * `apps/core-api/src/routes/weldcrm/people.ts`.
 *
 * Uses the dedicated `people:*` permission set from `@weldsuite/permissions`'s
 * catalog — distinct from `contacts:*`. The contact surface is a status-flag
 * projection on top of people, not a separate object.
 */

import { Hono } from 'hono';
import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission, ensurePermissionsResolved } from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createPersonSchema,
  updatePersonSchema,
  listPeopleQuery,
  personDetailQuery,
  personNavigationQuery,
  bulkUpdatePeopleSchema,
  importPeopleSchema,
  exportPeopleQuery,
} from '@weldsuite/core-api-client/schemas/people';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as peopleService from '../../services/people';
import { personChatRoutes } from './chat';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Returns undefined for users WITH people:scope:all (no owner filter),
 * or their own userId for users who may only see their own records.
 */
async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  const perms = resolved?.permissions ?? [];
  if (hasPermission(perms, 'people:scope:all')) return undefined;
  return c.get('userId');
}

app.get(
  '/',
  requirePermission('people:read'),
  zValidator('query', listPeopleQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const params = c.req.valid('query');
    const scope = await scopeFor(c);
    try {
      const result = await peopleService.listPeople(db, params, scope);
      return list(
        c,
        result.data,
        cursorPagination(result.totalCount, result.hasMore, result.cursor),
      );
    } catch (err) {
      console.error('[app-api/people] list failed:', err);
      return error.internal(c, 'Failed to list people');
    }
  },
);

/**
 * POST /api/people/resolve-by-emails
 *
 * Resolve a list of email addresses to Person rows. Used by WeldMail to
 * hydrate avatars and person links for message recipients/senders.
 * Returns only the rows that matched — unmatched addresses are omitted.
 * Read-only; no entity event.
 */
const resolveByEmailsBody = z.object({
  emails: z.array(z.string().email()).min(1).max(100),
});

// Not owner-scoped — identity resolver for WeldMail threading; see service doc.
app.post(
  '/resolve-by-emails',
  requirePermission('people:read'),
  zValidator('json', resolveByEmailsBody),
  async (c) => {
    const db = c.get('tenantDb');
    const { emails } = c.req.valid('json');
    try {
      const people = await peopleService.resolveByEmails(db, emails);
      return success(c, people);
    } catch (err) {
      console.error('[app-api/people] resolve-by-emails failed:', err);
      return error.internal(c, 'Failed to resolve people by email');
    }
  },
);

/**
 * POST /api/people/import — upsert a batch (≤500) of people, matched by
 * partyCode then email. Per-row created/updated entity events are emitted.
 *
 * Mounted before `:id` routes so `import` isn't claimed by `/:id`.
 */
app.post(
  '/import',
  requirePermission('people:create'),
  zValidator('json', importPeopleSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const { records } = c.req.valid('json');
    try {
      const result = await peopleService.importPeople(db, records);
      for (const changed of result.changedRows) {
        publishEntityEvent({
          c,
          entityType: 'person',
          entityId: changed.id,
          action: changed.action,
          data: {
            id: changed.row.id,
            firstName: changed.row.firstName,
            lastName: changed.row.lastName,
            fullName: changed.row.fullName,
            displayName: changed.row.displayName,
            email: changed.row.email,
            title: changed.row.title,
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
      console.error('[app-api/people] import failed:', err);
      return error.internal(c, 'Failed to import people');
    }
  },
);

/**
 * GET /api/people/recent-correspondents
 *
 * Returns recently-touched Person rows for use in mail recipient
 * suggestions. When `accountId` is provided the result is biased toward
 * people that appear in that account's message history; otherwise the
 * tenant-wide `updatedAt` desc ordering is used as a proxy.
 * Read-only; no entity event.
 */
const recentCorrespondentsQuery = z.object({
  accountId: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(10),
});

// Not owner-scoped — mail recipient suggestions; see service doc.
app.get(
  '/recent-correspondents',
  requirePermission('people:read'),
  zValidator('query', recentCorrespondentsQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const { accountId, limit } = c.req.valid('query');
    try {
      const people = await peopleService.listRecentCorrespondents(db, { accountId, limit });
      return success(c, people);
    } catch (err) {
      console.error('[app-api/people] recent-correspondents failed:', err);
      return error.internal(c, 'Failed to list recent correspondents');
    }
  },
);

/**
 * GET /api/people/export — every person matching the list filters (no
 * pagination). The client renders the rows to CSV/XLSX. Mounted before `:id`
 * so `export` isn't claimed by `/:id`.
 */
app.get(
  '/export',
  requirePermission('people:read'),
  zValidator('query', exportPeopleQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const filter = c.req.valid('query');
    const scope = await scopeFor(c);
    try {
      const rows = await peopleService.exportPeople(db, filter, scope);
      return success(c, rows);
    } catch (err) {
      console.error('[app-api/people] export failed:', err);
      return error.internal(c, 'Failed to export people');
    }
  },
);

app.get('/:id', requirePermission('people:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const person = await peopleService.getPerson(db, id, scope);
    if (!person) return error.notFound(c, 'Person', id);
    return success(c, person);
  } catch (err) {
    console.error('[app-api/people] get failed:', err);
    return error.internal(c, 'Failed to fetch person');
  }
});

app.post(
  '/',
  requirePermission('people:create'),
  zValidator('json', createPersonSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const userId = c.get('userId');
    try {
      const created = await peopleService.createPerson(db, { ...data, ownerId: data.ownerId ?? userId });
      publishEntityEvent({
        c,
        entityType: 'person',
        entityId: created.id,
        action: 'created',
        data: {
          id: created.id,
          firstName: created.firstName,
          lastName: created.lastName,
          fullName: created.fullName,
          displayName: created.displayName,
          email: created.email,
          title: created.title,
        },
      });
      return success(c, created, 201);
    } catch (err) {
      console.error('[app-api/people] create failed:', err);
      return error.internal(c, 'Failed to create person');
    }
  },
);

app.patch(
  '/:id',
  requirePermission('people:update'),
  zValidator('json', updatePersonSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const scope = await scopeFor(c);
    try {
      const result = await peopleService.updatePerson(db, id, data, scope);
      if (!result) return error.notFound(c, 'Person', id);
      const { row, changes } = result;
      publishEntityEvent({
        c,
        entityType: 'person',
        entityId: row.id,
        action: 'updated',
        data: {
          id: row.id,
          firstName: row.firstName,
          lastName: row.lastName,
          fullName: row.fullName,
          displayName: row.displayName,
          email: row.email,
          title: row.title,
        },
        changes,
      });
      return success(c, row);
    } catch (err) {
      if (err instanceof peopleService.PersonVersionConflictError) {
        return error.conflict(c, err.message);
      }
      console.error('[app-api/people] update failed:', err);
      return error.internal(c, 'Failed to update person');
    }
  },
);

app.delete('/:id', requirePermission('people:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const ok = await peopleService.deletePerson(db, id, scope);
    if (!ok) return error.notFound(c, 'Person', id);
    publishEntityEvent({
      c,
      entityType: 'person',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/people] delete failed:', err);
    return error.internal(c, 'Failed to delete person');
  }
});

app.post('/:id/archive', requirePermission('people:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const updated = await peopleService.archivePerson(db, id, scope);
    if (!updated) return error.notFound(c, 'Person', id);
    publishEntityEvent({
      c,
      entityType: 'person',
      entityId: updated.id,
      action: 'archived',
      data: {
        id: updated.id,
        displayName: updated.displayName,
      },
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/people] archive failed:', err);
    return error.internal(c, 'Failed to archive person');
  }
});

app.post('/:id/unarchive', requirePermission('people:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const updated = await peopleService.unarchivePerson(db, id, scope);
    if (!updated) return error.notFound(c, 'Person', id);
    publishEntityEvent({
      c,
      entityType: 'person',
      entityId: updated.id,
      action: 'unarchived',
      data: {
        id: updated.id,
        displayName: updated.displayName,
      },
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/people] unarchive failed:', err);
    return error.internal(c, 'Failed to unarchive person');
  }
});

/**
 * POST /api/people/:id/add-to-crm — promote a mail-only identity into the CRM.
 *
 * Mail / helpdesk auto-create people with `inCrm=false` so they don't clutter
 * the CRM. This flips the flag (and assigns the acting user as owner when the
 * person has none) so it shows up in the WeldCRM People grid. Backs the
 * "Add to CRM" button on the person panel. Idempotent.
 */
app.post('/:id/add-to-crm', requirePermission('people:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId');
  const scope = await scopeFor(c);
  try {
    const updated = await peopleService.addPersonToCrm(db, id, userId, scope);
    if (!updated) return error.notFound(c, 'Person', id);
    publishEntityEvent({
      c,
      entityType: 'person',
      entityId: updated.id,
      action: 'updated',
      data: {
        id: updated.id,
        displayName: updated.displayName,
      },
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/people] add-to-crm failed:', err);
    return error.internal(c, 'Failed to add person to CRM');
  }
});

/**
 * GET /api/people/:id/companies — employment history, enriched with the
 * joined company's display name / industry / avatar.
 */
app.get('/:id/companies', requirePermission('people:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  try {
    const rows = await peopleService.listPersonCompanies(db, id, scope);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/people] companies fetch failed:', err);
    return error.internal(c, 'Failed to list person companies');
  }
});

/**
 * POST /api/people/bulk-update — atomic multi-row patch on a safe set
 * of fields. Mirrors `POST /api/companies/bulk-update`.
 */
app.post(
  '/bulk-update',
  requirePermission('people:update'),
  zValidator('json', bulkUpdatePeopleSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const input = c.req.valid('json');
    const scope = await scopeFor(c);
    try {
      const result = await peopleService.bulkUpdatePeople(db, input, scope);
      for (const row of result.changedRows) {
        publishEntityEvent({
          c,
          entityType: 'person',
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
      console.error('[app-api/people] bulk-update failed:', err);
      return error.internal(c, 'Failed to bulk-update people');
    }
  },
);

/**
 * GET /api/people/:id/detail — aggregate read used by the person detail
 * page. Returns the person + their companies + recent activities/tickets +
 * counts.
 */
app.get(
  '/:id/detail',
  requirePermission('people:read'),
  zValidator('query', personDetailQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const opts = c.req.valid('query');
    const scope = await scopeFor(c);
    try {
      const detail = await peopleService.getPersonDetail(db, id, opts, scope);
      if (!detail) return error.notFound(c, 'Person', id);
      return success(c, detail);
    } catch (err) {
      console.error('[app-api/people] detail fetch failed:', err);
      return error.internal(c, 'Failed to fetch person detail');
    }
  },
);

/**
 * GET /api/people/:id/navigation — prev/next ids in the current list view.
 */
app.get(
  '/:id/navigation',
  requirePermission('people:read'),
  zValidator('query', personNavigationQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { listId } = c.req.valid('query');
    const scope = await scopeFor(c);
    try {
      const nav = await peopleService.getPersonNavigation(db, id, { listId }, scope);
      if (!nav) return error.notFound(c, 'Person', id);
      return success(c, nav);
    } catch (err) {
      console.error('[app-api/people] navigation fetch failed:', err);
      return error.internal(c, 'Failed to fetch person navigation');
    }
  },
);

app.route('/:id/chat', personChatRoutes);

export const peopleRoutes = app;
