/**
 * Workflow actions that need the API's services — executed on behalf of a
 * WeldConnect run in apps/workers/workflow-worker via the internal routes in
 * routes/internal-workflow-actions/index.ts (the worker has no companies
 * service, party logic or ENTITY_EVENTS producer of its own).
 *
 * No Hono context — takes a tenant Database and typed params.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { getMasterDb, masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import { createCompany, isValidWorkspaceMember } from '@weldsuite/crm-domain/companies';
import { createPerson, PersonDuplicateEmailError, updatePerson } from '@weldsuite/crm-domain/people';
import { createLead as createLeadRow } from '@weldsuite/crm-domain/leads';
import {
  createOpportunity as createOpportunityRow,
  moveOpportunityStage,
  type OpportunityUpdateEvent,
} from '@weldsuite/crm-domain/opportunities';
import { createActivity as createActivityRow } from '@weldsuite/crm-domain/activities';
import type { CreateLeadInput } from '@weldsuite/core-api-client/schemas/leads';
import type { CreateOpportunityInput } from '@weldsuite/core-api-client/schemas/opportunities';
import type { CreateActivityInput } from '@weldsuite/core-api-client/schemas/activities';
import { createTask } from '@weldsuite/flow-domain/tasks';
import { createCalendarEventForTask } from '@weldsuite/db/lib/calendar-sync';
import { sendTaskAssignmentNotification } from '@weldsuite/notifications';
import type { Env } from '../types';

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

// ---------------------------------------------------------------------------
// Leads (create_lead)
// ---------------------------------------------------------------------------

export interface CreateLeadFromWorkflowResult {
  id: string;
  eventData: Record<string, unknown>;
}

/**
 * Create a CRM lead through the leads service, owned by the workflow's
 * owner. Leads always carry an email (same requirement as the CRM create
 * route's schema), so there is no dedup/reuse path like `create_contact`.
 */
export async function createLeadFromWorkflow(
  db: Database,
  input: { ownerUserId: string; lead: CreateLeadInput },
): Promise<CreateLeadFromWorkflowResult> {
  const { id, eventData } = await createLeadRow(db, { ...input.lead, ownerId: input.ownerUserId }, input.ownerUserId);
  // crm-domain types eventData against the catalog's exact LeadEventData
  // shape (no index signature); publishEntityEventRaw takes a plain bag.
  return { id, eventData: eventData as unknown as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Opportunities / deals (create_deal, move_deal_stage)
// ---------------------------------------------------------------------------

export interface CreateDealFromWorkflowResult {
  id: string;
  eventData: Record<string, unknown>;
}

/** Create a CRM opportunity through the opportunities service, owned by the workflow's owner. */
export async function createDealFromWorkflow(
  db: Database,
  input: { ownerUserId: string; deal: CreateOpportunityInput },
): Promise<CreateDealFromWorkflowResult> {
  const { id, eventData } = await createOpportunityRow(db, { ...input.deal, ownerId: input.ownerUserId }, input.ownerUserId);
  // crm-domain types eventData against the catalog's exact OpportunityEventData
  // shape (no index signature); publishEntityEventRaw takes a plain bag.
  return { id, eventData: eventData as unknown as Record<string, unknown> };
}

export interface MoveDealStageFromWorkflowResult {
  dealId: string;
  stageId: string;
  status: string;
  events: OpportunityUpdateEvent[];
}

/**
 * Move a deal onto a different pipeline stage (the WeldConnect
 * `move_deal_stage` step). `ownerScope` limits it to deals the owner owns
 * (set unless they hold `opportunities:scope:all`). Returns null when the
 * deal doesn't exist or is out of scope; propagates
 * `UnknownPipelineStageError` for an unknown stage.
 */
export async function moveDealStageFromWorkflow(
  db: Database,
  input: { dealId: string; stageId: string; ownerScope?: string },
): Promise<MoveDealStageFromWorkflowResult | null> {
  const result = await moveOpportunityStage(db, input.dealId, input.stageId, input.ownerScope);
  if (!result) return null;
  return { dealId: input.dealId, stageId: result.row.stageId ?? input.stageId, status: result.row.status, events: result.events };
}

// ---------------------------------------------------------------------------
// Activities (log_activity)
// ---------------------------------------------------------------------------

export interface LogActivityFromWorkflowResult {
  id: string;
  eventData: Record<string, unknown>;
}

/** Log a CRM activity through the activities service, assigned to the workflow's owner. */
export async function logActivityFromWorkflow(
  db: Database,
  input: { ownerUserId: string; activity: CreateActivityInput },
): Promise<LogActivityFromWorkflowResult> {
  const { id, eventData } = await createActivityRow(db, { ...input.activity, assignedToId: input.ownerUserId }, input.ownerUserId);
  // crm-domain types eventData against the catalog's exact ActivityEventData
  // shape (no index signature); publishEntityEventRaw takes a plain bag.
  return { id, eventData: eventData as unknown as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tasks (WeldFlow) — the WeldConnect `create_task` action
// ---------------------------------------------------------------------------

type TaskRow = typeof schema.tasks.$inferSelect;

/** Task fields a workflow step may set. `title` is the only required one. */
export interface WorkflowTaskFields {
  title: string;
  description?: string;
  priority?: string;
  stageId?: string;
  assigneeIds?: string[];
  dueDate?: string;
  labels?: string[];
  tags?: string[];
}

export interface CreateTaskFromWorkflowResult {
  row: TaskRow;
  assigneeIds: string[];
}

/**
 * Create a WeldFlow task through `@weldsuite/flow-domain`'s task service —
 * the same insert flow flow-api's `POST /api/tasks/projects/:projectId` uses
 * — then runs the synchronous calendar auto-schedule flow-api also runs on
 * create. Permission + project-write checks are the caller's responsibility
 * (`authorizeWorkflowOwner` + `resolveProjectAccess`, in the route).
 *
 * GitHub outbound sync (flow-api's `dispatchGithubOutboundSync`) is
 * deliberately NOT run here: it needs the `GITHUB_PROJECT_OUTBOUND` service
 * binding, which no connect-api environment declares in wrangler.toml — a
 * workflow-created task simply doesn't push to a linked GitHub Project yet.
 */
export async function createTaskFromWorkflow(
  db: Database,
  input: { ownerUserId: string; projectId: string; task: WorkflowTaskFields },
): Promise<CreateTaskFromWorkflowResult> {
  const { row, assigneeIds } = await createTask(
    db,
    {
      title: input.task.title,
      description: input.task.description,
      priority: input.task.priority,
      stageId: input.task.stageId,
      assigneeIds: input.task.assigneeIds,
      dueDate: input.task.dueDate,
      labels: input.task.labels,
      tags: input.task.tags,
    },
    { projectId: input.projectId, userId: input.ownerUserId },
  );

  // Calendar auto-schedule — synchronous like flow-api's create routes, and
  // needs only the tenant db (no Hono context).
  try {
    const eventId = await createCalendarEventForTask(db, {
      userId: input.ownerUserId,
      taskId: row.id,
      title: row.title,
      description: row.description ?? null,
      dueDate: row.dueDate ? new Date(row.dueDate) : null,
      startDate: row.startDate ? new Date(row.startDate) : null,
      durationMinutes: row.duration ?? null,
      priority: row.priority ?? null,
    });
    if (eventId) {
      await db.update(schema.tasks).set({ calendarEventId: eventId }).where(eq(schema.tasks.id, row.id));
    }
  } catch (err) {
    console.error('[connect-api] workflow create_task calendar auto-schedule failed:', err);
  }

  return { row, assigneeIds };
}

/**
 * Assignment notifications for a workflow-created task — mirrors flow-api's
 * `dispatchAssignmentNotifications`, awaited instead of fire-and-forget
 * (there's no request to respond to early here; the step result already
 * depends on the task existing). connect-api has a `REALTIME` binding but no
 * `SEND_EMAIL` one: `sendTaskAssignmentNotification`'s email channel degrades
 * to a no-op transport in that case (see `workerTransport` in
 * `@weldsuite/emails/transports/binding`), so in-app delivery still happens
 * and nothing throws for the missing binding.
 */
export async function sendTaskAssignmentNotificationsForWorkflow(
  db: Database,
  env: Env,
  opts: {
    assigneeIds: string[];
    workspaceId: string;
    assignedByUserId: string;
    taskId: string;
    taskTitle: string;
    projectId: string;
    taskPriority?: string | null;
    dueDate?: Date | string | null;
    taskDescription?: string | null;
  },
): Promise<void> {
  if (opts.assigneeIds.length === 0) return;

  const [projectRow] = await db
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.id, opts.projectId))
    .limit(1);

  let workspaceName: string | null = null;
  try {
    const masterDb = getMasterDb(env);
    const [row] = await masterDb
      .select({ name: masterSchema.workspaces.name })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, opts.workspaceId))
      .limit(1);
    workspaceName = row?.name ?? null;
  } catch {
    // non-fatal — the email template falls back without a workspace name.
  }

  const actionUrl = `/weldflow/task/${opts.taskId}`;
  for (const assigneeId of opts.assigneeIds) {
    try {
      await sendTaskAssignmentNotification({
        db,
        env,
        workspaceId: opts.workspaceId,
        assigneeId,
        assignedByUserId: opts.assignedByUserId,
        taskId: opts.taskId,
        taskTitle: opts.taskTitle,
        category: 'projects',
        actionUrl,
        projectId: opts.projectId,
        projectName: projectRow?.name ?? null,
        taskPriority: opts.taskPriority ?? null,
        dueDate: opts.dueDate ?? null,
        taskDescription: opts.taskDescription ?? null,
        workspaceName,
      });
    } catch (err) {
      console.error('[connect-api] workflow create_task assignment notification failed:', err);
    }
  }
}
