/**
 * WeldData routes — /api/welddata/*.
 *
 * Lead-database (Lemlist-backed) module. Searches an external B2B database
 * server-side (the API key never leaves the worker), lets users save rows
 * into WeldData lists, and converts saved leads into CRM people/companies.
 *
 * Permission model (object-based, like the rest of app-api):
 *   prospects:read    — search the database, read lists & saved leads
 *   prospects:create  — create lists, save leads
 *   prospects:update  — rename lists, convert leads
 *   prospects:delete  — delete lists, remove saved leads
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  addLeadsSchema,
  convertLeadSchema,
  convertSearchLeadsSchema,
  convertToCrmListSchema,
  createColumnSchema,
  createWelddataListSchema,
  listLeadsQuery,
  listWelddataListsQuery,
  runCellSchema,
  runColumnSchema,
  searchLeadsSchema,
  updateColumnSchema,
  updateWelddataListSchema,
} from '@weldsuite/app-api-client/schemas/welddata';
import type { LemlistSearchResult } from '@weldsuite/app-api-client/schemas/welddata';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as welddata from '../../services/welddata';
import {
  getFilters,
  LemlistError,
  LemlistNotConfiguredError,
  searchCompanies,
  searchPeople,
} from '../../lib/lemlist';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function handleLemlistError(c: Parameters<typeof error.internal>[0], err: unknown) {
  if (err instanceof LemlistNotConfiguredError) {
    return error.internal(c, 'Lead database is not configured');
  }
  if (err instanceof LemlistError) {
    if (err.status === 401 || err.status === 403) {
      return error.internal(c, 'Lead database rejected the request (check API key)');
    }
    if (err.status === 429) {
      return error.badRequest(c, 'Lead database rate limit reached, please retry shortly');
    }
  }
  console.error('[app-api/welddata] lemlist call failed:', err);
  return error.internal(c, 'Lead database request failed');
}

// ---------------------------------------------------------------------------
// External database search
// ---------------------------------------------------------------------------

/**
 * Drop result rows whose Lemlist id is already saved in any of `excludeListIds`
 * (the provider can't filter on our lists). The total is reduced by what we
 * filter on this page — an approximation, since we can't know the excluded
 * count across pages without fetching them all.
 */
async function excludeSavedLeads(
  c: Parameters<typeof success>[0],
  result: LemlistSearchResult,
  excludeListIds: string[] | undefined,
): Promise<LemlistSearchResult> {
  if (!excludeListIds?.length) return result;
  const saved = await welddata.getSavedLemlistIds(c.get('tenantDb'), excludeListIds);
  if (saved.size === 0) return result;
  const rows = result.rows.filter((r) => !saved.has(r.id));
  const removed = result.rows.length - rows.length;
  return { ...result, rows, total: Math.max(0, result.total - removed) };
}

app.get('/filters', requirePermission('prospects:read'), async (c) => {
  try {
    const filters = await getFilters(c.env.LEMLIST_API_KEY, c.env.WORKSPACE_CACHE);
    return success(c, filters);
  } catch (err) {
    return handleLemlistError(c, err);
  }
});

app.post(
  '/search/people',
  requirePermission('prospects:read'),
  zValidator('json', searchLeadsSchema),
  async (c) => {
    try {
      const input = c.req.valid('json');
      const result = await searchPeople(c.env.LEMLIST_API_KEY, input, c.env.WORKSPACE_CACHE);
      return success(c, await excludeSavedLeads(c, result, input.excludeListIds));
    } catch (err) {
      return handleLemlistError(c, err);
    }
  },
);

app.post(
  '/search/companies',
  requirePermission('prospects:read'),
  zValidator('json', searchLeadsSchema),
  async (c) => {
    try {
      const input = c.req.valid('json');
      const result = await searchCompanies(c.env.LEMLIST_API_KEY, input, c.env.WORKSPACE_CACHE);
      return success(c, await excludeSavedLeads(c, result, input.excludeListIds));
    } catch (err) {
      return handleLemlistError(c, err);
    }
  },
);

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

app.get(
  '/lists',
  requirePermission('prospects:read'),
  zValidator('query', listWelddataListsQuery),
  async (c) => {
    const db = c.get('tenantDb');
    try {
      const result = await welddata.listLists(db, c.req.valid('query'));
      return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
    } catch (err) {
      console.error('[app-api/welddata] list lists failed:', err);
      return error.internal(c, 'Failed to list WeldData lists');
    }
  },
);

app.post(
  '/lists',
  requirePermission('prospects:create'),
  zValidator('json', createWelddataListSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    try {
      const created = await welddata.createList(db, c.req.valid('json'), userId);
      publishEntityEvent({
        c,
        entityType: 'welddata_list',
        entityId: created.id,
        action: 'created',
        data: { id: created.id, name: created.name },
      });
      return success(c, created, 201);
    } catch (err) {
      console.error('[app-api/welddata] create list failed:', err);
      return error.internal(c, 'Failed to create WeldData list');
    }
  },
);

app.get('/lists/:id', requirePermission('prospects:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const row = await welddata.getList(db, c.req.param('id'));
    if (!row) return error.notFound(c, 'WeldData list', c.req.param('id'));
    return success(c, row);
  } catch (err) {
    console.error('[app-api/welddata] get list failed:', err);
    return error.internal(c, 'Failed to fetch WeldData list');
  }
});

app.patch(
  '/lists/:id',
  requirePermission('prospects:update'),
  zValidator('json', updateWelddataListSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    try {
      const row = await welddata.updateList(db, id, c.req.valid('json'));
      if (!row) return error.notFound(c, 'WeldData list', id);
      publishEntityEvent({
        c,
        entityType: 'welddata_list',
        entityId: row.id,
        action: 'updated',
        data: { id: row.id, name: row.name },
      });
      return success(c, row);
    } catch (err) {
      console.error('[app-api/welddata] update list failed:', err);
      return error.internal(c, 'Failed to update WeldData list');
    }
  },
);

app.delete('/lists/:id', requirePermission('prospects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const ok = await welddata.deleteList(db, id);
    if (!ok) return error.notFound(c, 'WeldData list', id);
    publishEntityEvent({
      c,
      entityType: 'welddata_list',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/welddata] delete list failed:', err);
    return error.internal(c, 'Failed to delete WeldData list');
  }
});

// ---------------------------------------------------------------------------
// Saved leads
// ---------------------------------------------------------------------------

app.get(
  '/lists/:id/leads',
  requirePermission('prospects:read'),
  zValidator('query', listLeadsQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    try {
      const result = await welddata.listLeads(db, id, c.req.valid('query'));
      if (!result) return error.notFound(c, 'WeldData list', id);
      return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
    } catch (err) {
      console.error('[app-api/welddata] list leads failed:', err);
      return error.internal(c, 'Failed to list saved leads');
    }
  },
);

app.post(
  '/lists/:id/leads',
  requirePermission('prospects:create'),
  zValidator('json', addLeadsSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const userId = c.get('userId');
    try {
      const result = await welddata.addLeads(db, id, c.req.valid('json'), userId);
      if (!result) return error.notFound(c, 'WeldData list', id);
      publishEntityEvent({
        c,
        entityType: 'welddata_list',
        entityId: id,
        action: 'members_added',
        data: { id, count: result.added },
      });
      return success(c, result, 201);
    } catch (err) {
      console.error('[app-api/welddata] add leads failed:', err);
      return error.internal(c, 'Failed to save leads');
    }
  },
);

app.delete('/leads/:id', requirePermission('prospects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const ok = await welddata.removeLead(db, id);
    if (!ok) return error.notFound(c, 'Saved lead', id);
    publishEntityEvent({
      c,
      entityType: 'welddata_lead',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/welddata] remove lead failed:', err);
    return error.internal(c, 'Failed to remove saved lead');
  }
});

app.post(
  '/leads/:id/convert',
  requirePermission('prospects:update'),
  zValidator('json', convertLeadSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const userId = c.get('userId');
    const { createCompany } = c.req.valid('json');
    try {
      const lead = await welddata.getLead(db, id);
      if (!lead) return error.notFound(c, 'Saved lead', id);

      const result = await welddata.convertLead(db, lead, { createCompany, ownerId: userId });

      if (!result.alreadyConverted) {
        if (result.createdCompany && result.companyId) {
          publishEntityEvent({
            c,
            entityType: 'company',
            entityId: result.companyId,
            action: 'created',
            data: { id: result.companyId, name: lead.companyName ?? lead.name },
          });
        }
        if (result.createdPerson && result.personId) {
          publishEntityEvent({
            c,
            entityType: 'person',
            entityId: result.personId,
            action: 'created',
            data: { id: result.personId, displayName: lead.name, email: lead.email, title: lead.title },
          });
        }
        publishEntityEvent({
          c,
          entityType: 'welddata_lead',
          entityId: lead.id,
          action: 'converted',
          data: {
            id: lead.id,
            listId: lead.listId,
            kind: lead.kind,
            name: lead.name,
            convertedPersonId: result.personId,
            convertedCompanyId: result.companyId,
          },
        });
      }

      return success(c, {
        leadId: result.leadId,
        personId: result.personId,
        companyId: result.companyId,
      });
    } catch (err) {
      console.error('[app-api/welddata] convert lead failed:', err);
      return error.internal(c, 'Failed to convert lead');
    }
  },
);

// Convert search-result rows straight into CRM, bypassing the WeldData list.
// The rows aren't persisted, so the full payloads are sent inline. Companies
// are deduped find-or-create (by name), so processing is sequential to keep
// leads that share a company from each creating a duplicate.
app.post(
  '/convert',
  requirePermission('prospects:update'),
  zValidator('json', convertSearchLeadsSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const { leads, createCompany } = c.req.valid('json');
    try {
      let people = 0;
      let companies = 0;
      for (const lead of leads) {
        const result = await welddata.convertSearchLead(db, lead, { createCompany, ownerId: userId });
        if (result.createdCompany && result.companyId) {
          companies++;
          publishEntityEvent({
            c,
            entityType: 'company',
            entityId: result.companyId,
            action: 'created',
            data: { id: result.companyId, name: lead.companyName ?? lead.name },
          });
        }
        if (result.createdPerson && result.personId) {
          people++;
          publishEntityEvent({
            c,
            entityType: 'person',
            entityId: result.personId,
            action: 'created',
            data: { id: result.personId, displayName: lead.name, email: lead.email, title: lead.title },
          });
        }
      }
      return success(c, { converted: leads.length, people, companies });
    } catch (err) {
      console.error('[app-api/welddata] convert search leads failed:', err);
      return error.internal(c, 'Failed to convert leads');
    }
  },
);

// Convert leads (inline search rows and/or saved-lead ids) into CRM and add the
// resulting person/company to an existing CRM list in one step. The CRM list's
// `kind` decides which id is added (person list → person, company list →
// company). Sequential so shared-company find-or-create stays race-free.
app.post(
  '/convert-to-list',
  requirePermission('prospects:update'),
  zValidator('json', convertToCrmListSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const { listId, leads = [], leadIds = [], createCompany } = c.req.valid('json');

    const emitCreated = (
      r: { personId: string | null; companyId: string | null; createdPerson: boolean; createdCompany: boolean },
      lead: { name?: string | null; companyName?: string | null; email?: string | null; title?: string | null },
    ) => {
      if (r.createdCompany && r.companyId) {
        publishEntityEvent({
          c,
          entityType: 'company',
          entityId: r.companyId,
          action: 'created',
          data: { id: r.companyId, name: lead.companyName ?? lead.name },
        });
      }
      if (r.createdPerson && r.personId) {
        publishEntityEvent({
          c,
          entityType: 'person',
          entityId: r.personId,
          action: 'created',
          data: { id: r.personId, displayName: lead.name, email: lead.email, title: lead.title },
        });
      }
    };

    try {
      const crmList = await welddata.getCrmList(db, listId);
      if (!crmList) return error.notFound(c, 'List', listId);

      const entityIds: string[] = [];
      let converted = 0;

      // Saved WeldData leads — convert (marks the lead converted) then collect.
      for (const id of leadIds) {
        const lead = await welddata.getLead(db, id);
        if (!lead) continue;
        const result = await welddata.convertLead(db, lead, { createCompany, ownerId: userId });
        converted++;
        emitCreated(result, lead);
        const entityId = crmList.kind === 'company' ? result.companyId : result.personId;
        if (entityId) entityIds.push(entityId);
      }

      // Inline search rows — materialise straight into CRM.
      for (const lead of leads) {
        const result = await welddata.convertSearchLead(db, lead, { createCompany, ownerId: userId });
        converted++;
        emitCreated(result, lead);
        const entityId = crmList.kind === 'company' ? result.companyId : result.personId;
        if (entityId) entityIds.push(entityId);
      }

      const added = await welddata.addCrmListMembers(db, listId, entityIds);
      return success(c, { converted, added });
    } catch (err) {
      console.error('[app-api/welddata] convert to CRM list failed:', err);
      return error.internal(c, 'Failed to add leads to CRM list');
    }
  },
);

// ---------------------------------------------------------------------------
// Enrichment columns
// ---------------------------------------------------------------------------

app.get('/lists/:id/columns', requirePermission('prospects:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const columns = await welddata.listColumns(db, c.req.param('id'));
    return success(c, columns);
  } catch (err) {
    console.error('[app-api/welddata] list columns failed:', err);
    return error.internal(c, 'Failed to list columns');
  }
});

app.post(
  '/lists/:id/columns',
  requirePermission('prospects:create'),
  zValidator('json', createColumnSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const userId = c.get('userId');
    try {
      const created = await welddata.createColumn(db, id, c.req.valid('json'), userId);
      if (!created) return error.notFound(c, 'WeldData list', id);
      publishEntityEvent({
        c,
        entityType: 'welddata_column',
        entityId: created.id,
        action: 'created',
        data: { id: created.id, listId: created.listId, name: created.name, type: created.type },
      });
      return success(c, created, 201);
    } catch (err) {
      console.error('[app-api/welddata] create column failed:', err);
      return error.internal(c, 'Failed to create column');
    }
  },
);

app.patch(
  '/columns/:id',
  requirePermission('prospects:update'),
  zValidator('json', updateColumnSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    try {
      const row = await welddata.updateColumn(db, id, c.req.valid('json'));
      if (!row) return error.notFound(c, 'Column', id);
      publishEntityEvent({
        c,
        entityType: 'welddata_column',
        entityId: row.id,
        action: 'updated',
        data: { id: row.id, listId: row.listId, name: row.name, type: row.type },
      });
      return success(c, row);
    } catch (err) {
      console.error('[app-api/welddata] update column failed:', err);
      return error.internal(c, 'Failed to update column');
    }
  },
);

app.delete('/columns/:id', requirePermission('prospects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const ok = await welddata.deleteColumn(db, id);
    if (!ok) return error.notFound(c, 'Column', id);
    publishEntityEvent({
      c,
      entityType: 'welddata_column',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/welddata] delete column failed:', err);
    return error.internal(c, 'Failed to delete column');
  }
});

app.get('/lists/:id/cells', requirePermission('prospects:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const cells = await welddata.listCells(db, c.req.param('id'));
    return success(c, cells);
  } catch (err) {
    console.error('[app-api/welddata] list cells failed:', err);
    return error.internal(c, 'Failed to list cells');
  }
});

/** Queue a whole-column enrichment run (background, fans out per row). */
app.post(
  '/lists/:id/columns/:columnId/run',
  requirePermission('prospects:update'),
  zValidator('json', runColumnSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const listId = c.req.param('id');
    const columnId = c.req.param('columnId');
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    if (!orgId) return error.orgRequired(c);
    try {
      const column = await welddata.getColumn(db, columnId);
      if (!column || column.listId !== listId) return error.notFound(c, 'Column', columnId);

      const { leadIds, onlyMissing } = c.req.valid('json');
      const targets = await welddata.resolveTargetLeadIds(db, listId, columnId, {
        leadIds,
        onlyMissing,
      });
      if (targets.length === 0) return success(c, { queued: 0 });
      if (!c.env.WELDDATA_ENRICH) return error.internal(c, 'Enrichment is not configured');

      await welddata.markCellsPending(db, columnId, targets);
      await c.env.WELDDATA_ENRICH.create({
        params: { workspaceId: orgId, userId, listId, columnId, leadIds: targets },
      });

      publishEntityEvent({
        c,
        entityType: 'welddata_column',
        entityId: columnId,
        action: 'run',
        data: { id: columnId, listId, name: column.name, type: column.type, count: targets.length },
      });
      return success(c, { queued: targets.length });
    } catch (err) {
      console.error('[app-api/welddata] run column failed:', err);
      return error.internal(c, 'Failed to queue column run');
    }
  },
);

/** Queue a single cell (re)run. */
app.post(
  '/cells/run',
  requirePermission('prospects:update'),
  zValidator('json', runCellSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    if (!orgId) return error.orgRequired(c);
    const { columnId, leadId } = c.req.valid('json');
    try {
      const column = await welddata.getColumn(db, columnId);
      if (!column) return error.notFound(c, 'Column', columnId);
      if (!c.env.WELDDATA_ENRICH) return error.internal(c, 'Enrichment is not configured');

      await welddata.markCellsPending(db, columnId, [leadId]);
      await c.env.WELDDATA_ENRICH.create({
        params: { workspaceId: orgId, userId, listId: column.listId, columnId, leadIds: [leadId] },
      });
      return success(c, { queued: 1 });
    } catch (err) {
      console.error('[app-api/welddata] run cell failed:', err);
      return error.internal(c, 'Failed to queue cell run');
    }
  },
);

export const welddataRoutes = app;
