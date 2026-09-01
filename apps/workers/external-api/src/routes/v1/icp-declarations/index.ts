import { createCrudRoute } from '../../../lib/crud-route';
import { schema } from '../../../db';
import { z } from 'zod';

const createIcpDeclarationSchema = z
  .object({
    entityId: z.string().min(1).max(30),
    periodType: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
    periodStart: z.string(),
    periodEnd: z.string(),
    periodLabel: z.string().max(100).optional(),
    status: z.string().max(30).optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

const updateIcpDeclarationSchema = createIcpDeclarationSchema.partial();

/** ICP declarations have no entity-event catalog entry — CRUD only. */
export default createCrudRoute({
  table: schema.icpDeclarations,
  scope: 'icp_declarations',
  label: 'ICP declaration',
  idPrefix: 'icp',
  entityType: 'accounting_entity',
  createSchema: createIcpDeclarationSchema,
  updateSchema: updateIcpDeclarationSchema,
  publishEvents: false,
});
