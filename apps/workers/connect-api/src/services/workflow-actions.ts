/**
 * Workflow actions that need the API's services — executed on behalf of a
 * WeldConnect run in apps/workers/workflow-worker via the internal routes in
 * routes/internal-workflow-actions/index.ts (the worker has no companies
 * service, party logic or ENTITY_EVENTS producer of its own).
 *
 * No Hono context — takes a tenant Database and typed params.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createCompany, isValidWorkspaceMember } from '@weldsuite/crm-domain/companies';

type CompanyRow = typeof schema.companies.$inferSelect;

export interface CreateCustomerFromWorkflowInput {
  name: string;
  email?: string;
  phone?: string;
  website?: string;
  notes?: string;
  status?: string;
  /** Clerk user who caused the run; `system` for schedule runs. */
  userId: string;
  /** Reuse an existing company with the same email instead of creating a duplicate. */
  skipIfEmailExists: boolean;
}

export interface CreateCustomerFromWorkflowResult {
  created: boolean;
  company: CompanyRow;
}

/** Status given to customers created by a workflow when the step doesn't pick one. */
export const DEFAULT_WORKFLOW_CUSTOMER_STATUS = 'active';

async function findCompanyByEmail(db: Database, email: string): Promise<CompanyRow | null> {
  const { companies } = schema;
  const [row] = await db
    .select()
    .from(companies)
    .where(and(isNull(companies.deletedAt), eq(sql`lower(${companies.email})`, email.toLowerCase())))
    .limit(1);
  return row ?? null;
}

/**
 * Create a CRM company as a customer (the WeldConnect `create_customer` step).
 * Goes through `createCompany` so the row is stamped (display name, version,
 * defaults) exactly like one created in the CRM.
 */
export async function createCustomerFromWorkflow(
  db: Database,
  input: CreateCustomerFromWorkflowInput,
): Promise<CreateCustomerFromWorkflowResult> {
  if (input.skipIfEmailExists && input.email) {
    const existing = await findCompanyByEmail(db, input.email);
    if (existing) return { created: false, company: existing };
  }

  // Schedule runs have no human behind them, and the run's user may have left
  // the workspace since the workflow was built; leave the owner unset then
  // rather than failing the step on the owner check.
  const ownerId =
    input.userId && input.userId !== 'system' && (await isValidWorkspaceMember(db, input.userId))
      ? input.userId
      : undefined;

  const company = await createCompany(db, {
    name: input.name,
    email: input.email,
    phone: input.phone,
    website: input.website,
    notes: input.notes,
    status: input.status || DEFAULT_WORKFLOW_CUSTOMER_STATUS,
    source: 'weldconnect',
    ownerId,
  });
  return { created: true, company };
}
