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

  const actionUrl = `/weldflow/project/${opts.projectId}/tasks`;
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
