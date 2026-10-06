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
import { createPerson, PersonDuplicateEmailError, updatePerson } from '@weldsuite/crm-domain/people';

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

// ---------------------------------------------------------------------------
// Contacts (CRM people)
// ---------------------------------------------------------------------------

type PersonRow = typeof schema.people.$inferSelect;

/** Contact fields a workflow step may set; undefined = leave untouched. */
export interface WorkflowContactFields {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
  companyId?: string;
  status?: string;
  notes?: string;
  tags?: string[];
}

function personFields(fields: WorkflowContactFields) {
  return {
    firstName: fields.firstName,
    lastName: fields.lastName,
    email: fields.email,
    directPhone: fields.phone,
    title: fields.title,
    status: fields.status,
    notes: fields.notes,
    tags: fields.tags,
  };
}

/**
 * Create a CRM contact through the people service, owned by the workflow's
 * owner. With `skipIfEmailExists`, an existing contact with the same email is
 * returned instead (`created: false`).
 */
export async function createContactFromWorkflow(
  db: Database,
  input: { ownerUserId: string; skipIfEmailExists: boolean; contact: WorkflowContactFields },
): Promise<{ created: boolean; person: PersonRow }> {
  const { contact } = input;
  try {
    const person = await createPerson(
      db,
      {
        ...personFields(contact),
        ownerId: input.ownerUserId,
        source: 'weldconnect',
        ...(contact.companyId ? { companyIds: [contact.companyId], primaryCompanyId: contact.companyId } : {}),
      },
      { allowDuplicateEmail: !input.skipIfEmailExists },
    );
    return { created: true, person };
  } catch (err) {
    if (err instanceof PersonDuplicateEmailError) {
      const [existing] = await db
        .select()
        .from(schema.people)
        .where(eq(schema.people.id, err.existingPersonId))
        .limit(1);
      if (existing) return { created: false, person: existing };
    }
    throw err;
  }
}

/**
 * Update a CRM contact through the people service. `ownerScope` limits it to
 * contacts the owner owns (set unless they hold `people:scope:all`). Returns
 * null when the contact doesn't exist or is out of scope.
 */
export async function updateContactFromWorkflow(
  db: Database,
  input: { contactId: string; ownerScope?: string; contact: WorkflowContactFields },
) {
  const fields = Object.fromEntries(
    Object.entries(personFields(input.contact)).filter(([, value]) => value !== undefined),
  );
  return updatePerson(db, input.contactId, fields, input.ownerScope);
}

/** The entity-event payload the CRM people routes publish for a person. */
export function personEventData(person: PersonRow): Record<string, unknown> {
  return {
    id: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
    fullName: person.fullName,
    displayName: person.displayName,
    email: person.email,
    title: person.title,
  };
}
