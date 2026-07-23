/**
 * Data actions: create_record, update_record, delete_record, query_data, transform.
 *
 * Record actions are tenant-scoped: when the target table has a `workspaceId`
 * column, reads/writes filter/set it from ctx.tenant.workspaceId.
 */

import { eq, and, isNull } from 'drizzle-orm';
import type { ActionHandler } from '../types';
import { getEntityTable, getEntityIdPrefix } from '../entity-tables';
import { generateId } from '../../lib/id';

export const handleCreateRecord: ActionHandler = async (inputs, ctx) => {
  const entityType = String(inputs.entity || inputs.entityType || '');
  const data = (inputs.data || inputs.fields || {}) as Record<string, unknown>;
  if (!entityType) throw new Error('Entity type is required');

  const table = getEntityTable(entityType);
  const idPrefix = getEntityIdPrefix(entityType);
  const insertData: Record<string, unknown> = {
    id: generateId(idPrefix),
    ...data,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if ('workspaceId' in table) insertData.workspaceId = ctx.tenant.workspaceId;

  const [created] = (await ctx.db.insert(table).values(insertData).returning()) as any[];
  return { created: true, record: created };
};

export const handleUpdateRecord: ActionHandler = async (inputs, ctx) => {
  const entityType = String(inputs.entity || inputs.entityType || '');
  const recordId = String(inputs.id || inputs.recordId || '');
  const data = (inputs.data || inputs.fields || {}) as Record<string, unknown>;
  if (!entityType) throw new Error('Entity type is required');
  if (!recordId) throw new Error('Record ID is required');

  const table = getEntityTable(entityType);
  const whereConditions = [eq(table.id, recordId)];
  if ('workspaceId' in table) whereConditions.push(eq(table.workspaceId, ctx.tenant.workspaceId));

  const [updated] = (await ctx.db
    .update(table)
    .set({ ...data, updatedAt: new Date() })
    .where(and(...whereConditions))
    .returning()) as any[];
  if (!updated) throw new Error(`Record ${recordId} not found`);
  return { updated: true, record: updated };
};

export const handleDeleteRecord: ActionHandler = async (inputs, ctx) => {
  const entityType = String(inputs.entity || inputs.entityType || '');
  const recordId = String(inputs.id || inputs.recordId || '');
  const hardDelete = inputs.hardDelete === true;
  if (!entityType) throw new Error('Entity type is required');
  if (!recordId) throw new Error('Record ID is required');

  const table = getEntityTable(entityType);
  const whereConditions = [eq(table.id, recordId)];
  if ('workspaceId' in table) whereConditions.push(eq(table.workspaceId, ctx.tenant.workspaceId));

  if (hardDelete) {
    await ctx.db.delete(table).where(and(...whereConditions));
  } else {
    await ctx.db
      .update(table)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(...whereConditions));
  }
  return { deleted: true, id: recordId };
};

export const handleQueryData: ActionHandler = async (inputs, ctx) => {
  const entityType = String(inputs.entity || inputs.entityType || '');
  if (!entityType) throw new Error('Entity type is required');

  const table = getEntityTable(entityType);
  const filters = (inputs.filters || inputs.where || {}) as Record<string, unknown>;
  const limit = Number(inputs.limit) || 100;
  const offset = Number(inputs.offset) || 0;

  const records = await ctx.db
    .select()
    .from(table)
    .where(isNull(table.deletedAt))
    .limit(limit)
    .offset(offset);

  let filteredRecords = records as Array<Record<string, unknown>>;
  for (const [key, value] of Object.entries(filters)) {
    filteredRecords = filteredRecords.filter((record) => {
      if (typeof value === 'object' && value !== null) {
        const op = value as { operator?: string; value?: unknown };
        switch (op.operator) {
          case 'eq':
          case 'equals':
            return record[key] === op.value;
          case 'neq':
          case 'not_equals':
            return record[key] !== op.value;
          case 'contains':
            return String(record[key]).includes(String(op.value));
          case 'gt':
            return Number(record[key]) > Number(op.value);
          case 'lt':
            return Number(record[key]) < Number(op.value);
          default:
            return record[key] === op.value;
        }
      }
      return record[key] === value;
    });
  }

  return { records: filteredRecords, count: filteredRecords.length };
};

export const handleTransform: ActionHandler = async (inputs, ctx) => {
  const transform = String(inputs.transform || inputs.operation || 'pick');
  const data = inputs.data || ctx.previousResults;

  switch (transform) {
    case 'pick': {
      const fields = inputs.fields as string[];
      if (!fields || !Array.isArray(fields)) throw new Error('Fields array is required for pick');
      const result: Record<string, unknown> = {};
      for (const field of fields) result[field] = (data as Record<string, unknown>)[field];
      return result;
    }
    case 'map': {
      const sourceArray = inputs.source || data;
      if (!Array.isArray(sourceArray)) throw new Error('Source must be an array for map');
      return sourceArray.map((item: any) => item[String(inputs.mapField || 'id')]);
    }
    case 'filter': {
      const sourceArray = inputs.source || data;
      if (!Array.isArray(sourceArray)) throw new Error('Source must be an array for filter');
      return sourceArray.filter(
        (item: any) => item[String(inputs.filterField || '')] === inputs.filterValue,
      );
    }
    case 'merge': {
      const objects = inputs.objects as Record<string, unknown>[];
      if (!Array.isArray(objects)) throw new Error('Objects array is required for merge');
      return Object.assign({}, ...objects);
    }
    case 'stringify':
      return JSON.stringify(data);
    case 'parse':
      return typeof data === 'string' ? JSON.parse(data) : data;
    default:
      return data;
  }
};
