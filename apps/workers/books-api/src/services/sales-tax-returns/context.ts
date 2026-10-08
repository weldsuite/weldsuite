/**
 * Loading what every return operation needs: the entity (US only), the return
 * and its agency.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { TaxReturnError, type AgencyRow, type EntityRow, type ReturnRow } from './common';

export async function loadUsEntity(db: Database, entityId: string): Promise<EntityRow> {
  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) throw new TaxReturnError(`Accounting entity ${entityId} not found`, 'not_found');
  if (entity.jurisdictionCode !== 'US') {
    throw new TaxReturnError('Sales tax returns are only available for US accounting entities');
  }
  return entity;
}

export async function loadAgency(db: Database, entityId: string, agencyId: string): Promise<AgencyRow> {
  const [agency] = await db
    .select()
    .from(schema.salesTaxAgencies)
    .where(
      and(
        eq(schema.salesTaxAgencies.id, agencyId),
        eq(schema.salesTaxAgencies.entityId, entityId),
        isNull(schema.salesTaxAgencies.deletedAt),
      ),
    )
    .limit(1);
  if (!agency) throw new TaxReturnError(`Sales tax agency ${agencyId} not found`, 'not_found');
  return agency;
}

export async function loadAgencies(db: Database, entityId: string): Promise<AgencyRow[]> {
  return db
    .select()
    .from(schema.salesTaxAgencies)
    .where(and(eq(schema.salesTaxAgencies.entityId, entityId), isNull(schema.salesTaxAgencies.deletedAt)))
    .orderBy(schema.salesTaxAgencies.stateCode, schema.salesTaxAgencies.name);
}

export async function loadReturn(db: Database, entityId: string, id: string): Promise<ReturnRow> {
  const [ret] = await db
    .select()
    .from(schema.taxReturns)
    .where(
      and(eq(schema.taxReturns.id, id), eq(schema.taxReturns.entityId, entityId), isNull(schema.taxReturns.deletedAt)),
    )
    .limit(1);
  if (!ret) throw new TaxReturnError(`Tax return ${id} not found`, 'not_found');
  return ret;
}

export interface ReturnContext {
  entity: EntityRow;
  ret: ReturnRow;
  agency: AgencyRow;
}

export async function loadReturnContext(db: Database, entityId: string, id: string): Promise<ReturnContext> {
  const entity = await loadUsEntity(db, entityId);
  const ret = await loadReturn(db, entityId, id);
  if (!ret.agencyId) throw new TaxReturnError('This tax return has no agency');
  const agency = await loadAgency(db, entityId, ret.agencyId);
  return { entity, ret, agency };
}
