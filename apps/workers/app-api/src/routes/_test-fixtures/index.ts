/**
 * CI-only seed + reset endpoints.
 *
 * NEVER mounted in production. Two-layer guard in `test-fixtures-guard.ts`:
 * env != production AND `X-Test-Token` header matches the secret.
 *
 * Seed endpoints reuse the same service functions / route patterns the
 * real API routes use, so what gets created in tests matches what the
 * UI produces. Every row created here is stamped with `[E2E_TEST]` in
 * `internalNotes` (where the column exists), in `description`/`notes`
 * for entities without one, so the `/reset` endpoint can find and
 * delete just the test data without touching legitimate rows.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { schema, masterSchema, getMasterDb, type Database } from '../../db';
import { createCompany } from '../../services/companies';
import { createPerson } from '../../services/people';
import { createDomain } from '../../services/domains';
import {
  sendAndPersist,
  replyAndPersist,
  forwardAndPersist,
  MailSendError,
} from '../../services/mail/send';
import { generateId } from '../../lib/id';
import { success, error } from '../../lib/response';
import { testFixturesGuard } from '../../middleware/test-fixtures-guard';
import type { Env } from '../../types';

const TEST_MARKER = '[E2E_TEST]';

type Variables = {
  tenantDb: Database;
  workspaceId: string;
};

export const testFixturesRoutes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

testFixturesRoutes.use('*', testFixturesGuard());

testFixturesRoutes.get('/ping', (c) =>
  success(c, {
    workspaceId: c.get('workspaceId'),
    environment: c.env.ENVIRONMENT,
    marker: TEST_MARKER,
  }),
);

/**
 * Hard-deletes every row this fixture suite created in the workspace.
 * Each entity has its own marker column; the loop deletes from one
 * table at a time and returns per-entity counts so specs can assert
 * cleanup actually ran.
 */
testFixturesRoutes.post('/reset', async (c) => {
  const db = c.get('tenantDb');
  const marker = `%${TEST_MARKER}%`;
  const counts: Record<string, number> = {};

  // Companies + People — internalNotes column.
  counts.companies = (
    await db
      .delete(schema.companies)
      .where(like(schema.companies.internalNotes, marker))
      .returning({ id: schema.companies.id })
  ).length;

  counts.people = (
    await db
      .delete(schema.people)
      .where(like(schema.people.internalNotes, marker))
      .returning({ id: schema.people.id })
  ).length;

  // Pipelines + stages — description column.
  counts.pipelines = (
    await db
      .delete(schema.crmPipelines)
      .where(like(schema.crmPipelines.description, marker))
      .returning({ id: schema.crmPipelines.id })
  ).length;

  // Leads — notes column.
  counts.leads = (
    await db
      .delete(schema.crmLeads)
      .where(like(schema.crmLeads.notes, marker))
      .returning({ id: schema.crmLeads.id })
  ).length;

  // Activities — description column.
  counts.activities = (
    await db
      .delete(schema.crmActivities)
      .where(like(schema.crmActivities.description, marker))
      .returning({ id: schema.crmActivities.id })
  ).length;

  // Tasks — description column.
  counts.tasks = (
    await db
      .delete(schema.tasks)
      .where(like(schema.tasks.description, marker))
      .returning({ id: schema.tasks.id })
  ).length;

  // Projects — description column.
  counts.projects = (
    await db
      .delete(schema.projects)
      .where(like(schema.projects.description, marker))
      .returning({ id: schema.projects.id })
  ).length;

  // Lists — description column.
  counts.lists = (
    await db
      .delete(schema.lists)
      .where(like(schema.lists.description, marker))
      .returning({ id: schema.lists.id })
  ).length;

  // Opportunities — description column.
  counts.opportunities = (
    await db
      .delete(schema.crmOpportunities)
      .where(like(schema.crmOpportunities.description, marker))
      .returning({ id: schema.crmOpportunities.id })
  ).length;

  // Helpdesk tickets — description column.
  counts.tickets = (
    await db
      .delete(schema.helpdeskTickets)
      .where(like(schema.helpdeskTickets.description, marker))
      .returning({ id: schema.helpdeskTickets.id })
  ).length;

  // Meetings — description column.
  counts.meetings = (
    await db
      .delete(schema.meetings)
      .where(like(schema.meetings.description, marker))
      .returning({ id: schema.meetings.id })
  ).length;

  // Domains — notes column.
  counts.domains = (
    await db
      .delete(schema.hostDomains)
      .where(like(schema.hostDomains.notes, marker))
      .returning({ id: schema.hostDomains.id })
  ).length;

  // Commerce / WMS products — description column.
  counts.products = (
    await db
      .delete(schema.products)
      .where(like(schema.products.description, marker))
      .returning({ id: schema.products.id })
  ).length;

  // Orders — internalNote column.
  counts.orders = (
    await db
      .delete(schema.orders)
      .where(like(schema.orders.internalNote, marker))
      .returning({ id: schema.orders.id })
  ).length;

  // WMS suppliers — notes column.
  counts.suppliers = (
    await db
      .delete(schema.suppliers)
      .where(like(schema.suppliers.notes, marker))
      .returning({ id: schema.suppliers.id })
  ).length;

  // WMS warehouses — description column.
  counts.warehouses = (
    await db
      .delete(schema.warehouses)
      .where(like(schema.warehouses.description, marker))
      .returning({ id: schema.warehouses.id })
  ).length;

  // VoIP calls — notes column.
  counts.voipCalls = (
    await db
      .delete(schema.voipCalls)
      .where(like(schema.voipCalls.notes, marker))
      .returning({ id: schema.voipCalls.id })
  ).length;

  // Custom field definitions — description column.
  counts.customFieldDefinitions = (
    await db
      .delete(schema.customFieldDefinitions)
      .where(like(schema.customFieldDefinitions.description, marker))
      .returning({ id: schema.customFieldDefinitions.id })
  ).length;

  // Object templates — description column.
  counts.objectTemplates = (
    await db
      .delete(schema.objectTemplates)
      .where(like(schema.objectTemplates.description, marker))
      .returning({ id: schema.objectTemplates.id })
  ).length;

  // Customer statuses — marker embedded in name column.
  counts.customerStatuses = (
    await db
      .delete(schema.crmCustomerStatuses)
      .where(like(schema.crmCustomerStatuses.name, marker))
      .returning({ id: schema.crmCustomerStatuses.id })
  ).length;

  // Booking pages — description column.
  counts.bookingPages = (
    await db
      .delete(schema.calendarBookingPages)
      .where(like(schema.calendarBookingPages.description, marker))
      .returning({ id: schema.calendarBookingPages.id })
  ).length;

  // ── FK-ordered deletes: children before parents ──

  // Mail messages carry the marker in `customFields.__e2e` (the SENT rows
  // created by the real send service are stamped after creation; seeded inbox
  // rows are stamped on insert). Their attachments (FK → mail messages) go
  // first, found by parent id.
  const e2eMailMessageIds = db
    .select({ id: schema.mailMessages.id })
    .from(schema.mailMessages)
    .where(sql`(${schema.mailMessages.customFields} ->> '__e2e') = ${TEST_MARKER}`);
  counts.mailAttachments = (
    await db
      .delete(schema.mailAttachments)
      .where(inArray(schema.mailAttachments.messageId, e2eMailMessageIds))
      .returning({ id: schema.mailAttachments.id })
  ).length;
  counts.mailMessages = (
    await db
      .delete(schema.mailMessages)
      .where(sql`(${schema.mailMessages.customFields} ->> '__e2e') = ${TEST_MARKER}`)
      .returning({ id: schema.mailMessages.id })
  ).length;

  // Mail labels (FK → mail accounts) before mail accounts.
  counts.mailLabels = (
    await db
      .delete(schema.mailLabels)
      .where(like(schema.mailLabels.aiDescription, marker))
      .returning({ id: schema.mailLabels.id })
  ).length;

  counts.mailAccounts = (
    await db
      .delete(schema.mailAccounts)
      .where(like(schema.mailAccounts.syncError, marker))
      .returning({ id: schema.mailAccounts.id })
  ).length;

  // Workflow webhooks + executions (FK → workflows) before workflows.
  counts.workflowWebhooks = (
    await db
      .delete(schema.workflowWebhooks)
      .where(like(schema.workflowWebhooks.description, marker))
      .returning({ id: schema.workflowWebhooks.id })
  ).length;

  counts.workflowExecutions = (
    await db
      .delete(schema.workflowExecutions)
      .where(like(schema.workflowExecutions.workflowName, marker))
      .returning({ id: schema.workflowExecutions.id })
  ).length;

  // Workflows (covers seed/workflow, seed/sequence, and inline FK parents).
  counts.workflows = (
    await db
      .delete(schema.workflows)
      .where(like(schema.workflows.description, marker))
      .returning({ id: schema.workflows.id })
  ).length;

  // Calendar events (FK → calendars) before calendars.
  counts.calendarEvents = (
    await db
      .delete(schema.calendarEvents)
      .where(like(schema.calendarEvents.description, marker))
      .returning({ id: schema.calendarEvents.id })
  ).length;

  counts.calendars = (
    await db
      .delete(schema.calendars)
      .where(like(schema.calendars.description, marker))
      .returning({ id: schema.calendars.id })
  ).length;

  // WeldChat — channels carry the marker in `description`; messages + members
  // are cleaned by channel ownership (subquery) since they have no marker
  // column of their own. Children first to respect the FK to chat_channels.
  const markedChannelIds = db
    .select({ id: schema.chatChannels.id })
    .from(schema.chatChannels)
    .where(like(schema.chatChannels.description, marker));
  counts.chatMessages = (
    await db
      .delete(schema.chatMessages)
      .where(inArray(schema.chatMessages.channelId, markedChannelIds))
      .returning({ id: schema.chatMessages.id })
  ).length;
  counts.chatChannelMembers = (
    await db
      .delete(schema.chatChannelMembers)
      .where(inArray(schema.chatChannelMembers.channelId, markedChannelIds))
      .returning({ id: schema.chatChannelMembers.id })
  ).length;
  counts.chatChannels = (
    await db
      .delete(schema.chatChannels)
      .where(like(schema.chatChannels.description, marker))
      .returning({ id: schema.chatChannels.id })
  ).length;

  return success(c, { counts });
});

// ─── Seed endpoints ──────────────────────────────────────────────────

const seedCompanyBody = z.object({
  name: z.string().min(1).optional(),
  tradingName: z.string().optional(),
  email: z.string().email().optional(),
  isSupplier: z.boolean().optional(),
  isLead: z.boolean().optional(),
});

testFixturesRoutes.post(
  '/seed/company',
  zValidator('json', seedCompanyBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const company = await createCompany(db, {
      name: body.name ?? `E2E Company ${suffix}`,
      tradingName: body.tradingName,
      email: body.email,
      isSupplier: body.isSupplier,
      isLead: body.isLead,
      internalNotes: TEST_MARKER,
    });
    return success(c, company, 201);
  },
);

const seedPersonBody = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
});

testFixturesRoutes.post(
  '/seed/person',
  zValidator('json', seedPersonBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const person = await createPerson(db, {
      firstName: body.firstName ?? 'E2E',
      lastName: body.lastName ?? `Person ${suffix}`,
      email: body.email,
      internalNotes: TEST_MARKER,
    });
    return success(c, person, 201);
  },
);

const seedPipelineBody = z.object({
  name: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/pipeline',
  zValidator('json', seedPipelineBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('pl');
    const now = new Date();
    await db.insert(schema.crmPipelines).values({
      id,
      name: body.name ?? `E2E Pipeline ${suffix}`,
      description: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.crmPipelines)
      .where(eq(schema.crmPipelines.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

const seedLeadBody = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  companyName: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/lead',
  zValidator('json', seedLeadBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('lead');
    const now = new Date();
    await db.insert(schema.crmLeads).values({
      id,
      firstName: body.firstName ?? 'E2E',
      lastName: body.lastName ?? `Lead ${suffix}`,
      email: body.email ?? `lead-${suffix}@e2e.test`,
      companyName: body.companyName ?? 'E2E Test Inc',
      notes: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.crmLeads)
      .where(eq(schema.crmLeads.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

const seedListBody = z.object({
  name: z.string().optional(),
  kind: z.enum(['company', 'person', 'lead']).optional(),
});

testFixturesRoutes.post(
  '/seed/list',
  zValidator('json', seedListBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('list');
    const now = new Date();
    await db.insert(schema.lists).values({
      id,
      name: body.name ?? `E2E List ${suffix}`,
      kind: body.kind ?? 'company',
      description: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.lists.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.lists)
      .where(eq(schema.lists.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

const seedProjectBody = z.object({
  name: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/project',
  zValidator('json', seedProjectBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('prj');
    const now = new Date();
    await db.insert(schema.projects).values({
      id,
      name: body.name ?? `E2E Project ${suffix}`,
      description: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

const seedTaskBody = z.object({
  title: z.string().optional(),
  // Optional project placement — needed for WeldFlow project task-list specs
  // (a task with no projectId never shows on /weldflow/project/:id/tasks).
  projectId: z.string().optional(),
  parentTaskId: z.string().optional(),
  stageId: z.string().optional(),
  status: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/task',
  zValidator('json', seedTaskBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('task');
    const now = new Date();
    await db.insert(schema.tasks).values({
      id,
      title: body.title ?? `E2E Task ${suffix}`,
      description: TEST_MARKER,
      projectId: body.projectId,
      parentTaskId: body.parentTaskId,
      stageId: body.stageId,
      ...(body.status ? { status: body.status } : {}),
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.tasks.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldChat: channel ───────────────────────────────────────────────
//
// The marker lives in `description` so /reset can find marked channels and
// cascade-clean their messages + members. Seeded channels are `public` by
// default so the logged-in test user can read them without a membership row.

const seedChatChannelBody = z.object({
  name: z.string().optional(),
  type: z.enum(['public', 'private', 'dm', 'entity']).optional(),
  topic: z.string().optional(),
  isDefault: z.boolean().optional(),
  voiceCallsEnabled: z.boolean().optional(),
  videoCallsEnabled: z.boolean().optional(),
});

testFixturesRoutes.post(
  '/seed/chat-channel',
  zValidator('json', seedChatChannelBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('ch');
    const now = new Date();
    await db.insert(schema.chatChannels).values({
      id,
      name: body.name ?? `E2E Channel ${suffix}`,
      // Slug is NOT NULL + unique — make it collision-proof with the id.
      slug: `e2e-channel-${suffix}-${id.slice(-6)}`,
      description: TEST_MARKER,
      type: body.type ?? 'public',
      topic: body.topic,
      isDefault: body.isDefault ?? false,
      ...(body.voiceCallsEnabled === undefined ? {} : { voiceCallsEnabled: body.voiceCallsEnabled }),
      ...(body.videoCallsEnabled === undefined ? {} : { videoCallsEnabled: body.videoCallsEnabled }),
      createdBy: 'e2e-user',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.chatChannels.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.chatChannels)
      .where(eq(schema.chatChannels.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldChat: message ───────────────────────────────────────────────

const seedChatMessageBody = z.object({
  channelId: z.string(),
  content: z.string().optional(),
  authorId: z.string().optional(),
  authorName: z.string().optional(),
  parentId: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/chat-message',
  zValidator('json', seedChatMessageBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('msg');
    const now = new Date();
    await db.insert(schema.chatMessages).values({
      id,
      channelId: body.channelId,
      authorId: body.authorId ?? 'e2e-user',
      authorName: body.authorName ?? 'E2E User',
      content: body.content ?? `E2E message ${suffix}`,
      parentId: body.parentId,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.chatMessages.$inferInsert);
    // Mirror postChatMessage: a thread reply bumps the parent's denormalized
    // counters, so the seeded parent renders its "N replies" indicator (the UI
    // gates on threadReplyCount > 0). A direct insert alone would leave the
    // parent at 0 and the indicator hidden.
    if (body.parentId) {
      await db
        .update(schema.chatMessages)
        .set({
          threadReplyCount: sql`${schema.chatMessages.threadReplyCount} + 1`,
          threadLastReplyAt: now,
          updatedAt: now,
        })
        .where(eq(schema.chatMessages.id, body.parentId));
    }
    const [row] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldChat: channel member ────────────────────────────────────────
//
// `userId` defaults to the body value (specs pass TEST_USER_ID so the
// logged-in user is a member and can post / see unread state).

const seedChatChannelMemberBody = z.object({
  channelId: z.string(),
  userId: z.string().optional(),
  role: z.enum(['owner', 'admin', 'member']).optional(),
  memberType: z.enum(['user', 'agent']).optional(),
});

testFixturesRoutes.post(
  '/seed/chat-channel-member',
  zValidator('json', seedChatChannelMemberBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const id = generateId('ccm');
    const now = new Date();
    await db.insert(schema.chatChannelMembers).values({
      id,
      channelId: body.channelId,
      userId: body.userId ?? 'e2e-user',
      memberType: body.memberType ?? 'user',
      role: body.role ?? 'member',
      joinedAt: now,
      createdAt: now,
    } as unknown as typeof schema.chatChannelMembers.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── CRM: opportunity ────────────────────────────────────────────────

const seedOpportunityBody = z.object({
  name: z.string().optional(),
  customerId: z.string().optional(),
  ownerId: z.string().optional(),
  stage: z.string().optional(),
  status: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/opportunity',
  zValidator('json', seedOpportunityBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const now = new Date();

    // Satisfy customerId — create a marked company inline unless supplied.
    let customerId = body.customerId;
    if (!customerId) {
      const company = await createCompany(db, {
        name: `E2E Opp Company ${suffix}`,
        internalNotes: TEST_MARKER,
      });
      customerId = company.id;
    }

    const id = generateId('opp');
    await db.insert(schema.crmOpportunities).values({
      id,
      name: body.name ?? `E2E Opportunity ${suffix}`,
      description: TEST_MARKER,
      customerId,
      stage: body.stage ?? 'prospecting',
      status: body.status ?? 'open',
      amount: '0',
      currency: 'EUR',
      probability: 0,
      pipeline: 'default',
      closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ownerId: body.ownerId ?? 'e2e-seed-user',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.crmOpportunities.$inferInsert);

    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── CRM: activity ───────────────────────────────────────────────────

const seedActivityBody = z.object({
  type: z.string().optional(),
  subject: z.string().optional(),
  assignedToId: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/activity',
  zValidator('json', seedActivityBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('act');
    const now = new Date();
    await db.insert(schema.crmActivities).values({
      id,
      type: body.type ?? 'note',
      subject: body.subject ?? `E2E Activity ${suffix}`,
      assignedToId: body.assignedToId ?? 'e2e-test-user',
      description: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.crmActivities.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.crmActivities)
      .where(eq(schema.crmActivities.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── Workflow automation: sequence (workflows table, tagged) ─────────

const seedSequenceBody = z.object({
  name: z.string().optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
});

testFixturesRoutes.post(
  '/seed/sequence',
  zValidator('json', seedSequenceBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('wf');
    const now = new Date();
    await db.insert(schema.workflows).values({
      id,
      name: body.name ?? `E2E Sequence ${suffix}`,
      description: TEST_MARKER,
      status: body.status ?? 'draft',
      tags: ['__type:sequence'],
      version: 1,
      executionCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── Helpdesk: ticket ────────────────────────────────────────────────

const seedTicketBody = z.object({
  subject: z.string().optional(),
  customerName: z.string().optional(),
  customerEmail: z.string().email().optional(),
  status: z
    .enum([
      'new',
      'open',
      'pending',
      'on_hold',
      'in_progress',
      'resolved',
      'closed',
      'cancelled',
    ])
    .optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent', 'critical']).optional(),
});

testFixturesRoutes.post(
  '/seed/ticket',
  zValidator('json', seedTicketBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('tkt');
    const now = new Date();
    await db.insert(schema.helpdeskTickets).values({
      id,
      ticketNumber: `T-${Date.now()}`,
      subject: body.subject ?? `E2E Ticket ${suffix}`,
      customerName: body.customerName ?? 'E2E Customer',
      customerEmail: body.customerEmail ?? `e2e-${suffix}@e2e.test`,
      status: body.status ?? 'new',
      priority: body.priority ?? 'medium',
      description: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.helpdeskTickets.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.helpdeskTickets)
      .where(eq(schema.helpdeskTickets.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldMeet: meeting ───────────────────────────────────────────────

const seedMeetingBody = z.object({
  title: z.string().optional(),
  status: z
    .enum(['scheduled', 'in_progress', 'completed', 'failed', 'cancelled'])
    .optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  organizerId: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/meeting',
  zValidator('json', seedMeetingBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('mtg');
    const now = new Date();
    await db.insert(schema.meetings).values({
      id,
      title: body.title ?? `E2E Meeting ${suffix}`,
      description: TEST_MARKER,
      status: body.status ?? 'scheduled',
      organizerId: body.organizerId ?? 'e2e-organizer',
      scheduledStart: body.scheduledStart ? new Date(body.scheduledStart) : null,
      scheduledEnd: body.scheduledEnd ? new Date(body.scheduledEnd) : null,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.meetings.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldHost: domain ────────────────────────────────────────────────

const seedDomainBody = z.object({
  name: z.string().optional(),
  tld: z.string().optional(),
  fullDomain: z.string().optional(),
  status: z
    .enum(['active', 'pending', 'expired', 'suspended', 'cancelled'])
    .optional(),
});

testFixturesRoutes.post(
  '/seed/domain',
  zValidator('json', seedDomainBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const name = body.name ?? `e2e-${suffix}`;
    const tld = body.tld ?? 'com';
    const fullDomain = body.fullDomain ?? `${name}.${tld}`;
    const domain = await createDomain(db, {
      name,
      tld,
      fullDomain,
      status: body.status ?? 'active',
      notes: TEST_MARKER,
    });
    return success(c, domain, 201);
  },
);

// ─── WeldMail: mailAccount ───────────────────────────────────────────

const seedMailAccountBody = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
});

testFixturesRoutes.post(
  '/seed/mailAccount',
  zValidator('json', seedMailAccountBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('mail');
    const now = new Date();
    await db.insert(schema.mailAccounts).values({
      id,
      name: body.name ?? `E2E Mail Account ${suffix}`,
      email: body.email ?? `e2e-${suffix}@e2e.test`,
      syncError: TEST_MARKER, // marker column for /reset
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.mailAccounts.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.mailAccounts)
      .where(eq(schema.mailAccounts.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldMail: mailLabel (FK → mailAccounts) ─────────────────────────

const seedMailLabelBody = z.object({
  accountId: z.string().optional(),
  name: z.string().optional(),
  color: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/mailLabel',
  zValidator('json', seedMailLabelBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const now = new Date();

    // Resolve or create parent mailAccount.
    let accountId = body.accountId;
    if (!accountId) {
      const acctId = generateId('mail');
      await db.insert(schema.mailAccounts).values({
        id: acctId,
        name: `E2E Mail Account ${suffix}`,
        email: `e2e-${suffix}@e2e.test`,
        syncError: TEST_MARKER,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof schema.mailAccounts.$inferInsert);
      accountId = acctId;
    }

    const id = generateId('label');
    await db.insert(schema.mailLabels).values({
      id,
      accountId,
      name: body.name ?? `E2E Label ${suffix}`,
      color: body.color ?? null,
      aiDescription: TEST_MARKER, // marker column for /reset
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.mailLabels)
      .where(eq(schema.mailLabels.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldMail: mailMessage (FK → mailAccounts) ───────────────────────

/**
 * Resolve a usable mail account for the mail fixtures. When no id is given a
 * fresh **shared** account is created so the send/reply/forward access check
 * (`hasAccessToAccount`) always passes regardless of the test user's role.
 * Carries the marker in `syncError` for /reset.
 */
async function ensureTestMailAccount(
  db: Database,
  accountId?: string,
): Promise<{ id: string; email: string }> {
  if (accountId) {
    const [existing] = await db
      .select({ id: schema.mailAccounts.id, email: schema.mailAccounts.email })
      .from(schema.mailAccounts)
      .where(eq(schema.mailAccounts.id, accountId))
      .limit(1);
    if (existing) return existing;
  }
  const suffix = `${Date.now().toString(36)}-${Math.floor(performance.now())}`;
  const id = generateId('mail');
  const email = `e2e-${suffix}@e2e.test`;
  const now = new Date();
  await db.insert(schema.mailAccounts).values({
    id,
    name: `E2E Mail Account ${suffix}`,
    email,
    isShared: true,
    syncError: TEST_MARKER,
    createdAt: now,
    updatedAt: now,
  } as unknown as typeof schema.mailAccounts.$inferInsert);
  return { id, email };
}

/** Write throwaway R2 objects so the real `resolveAttachments` can fetch them. */
async function seedAttachmentObjects(
  env: Env,
  attachments: { fileKey: string; size: number; contentType?: string }[],
): Promise<void> {
  if (!env.STORAGE) return;
  for (const att of attachments) {
    // Only seed workspace-prefixed keys — a deliberately mis-prefixed key is
    // left absent so the workspace-guard path can be exercised.
    const bytes = new Uint8Array(Math.max(0, att.size));
    await env.STORAGE.put(att.fileKey, bytes, {
      httpMetadata: att.contentType ? { contentType: att.contentType } : undefined,
    });
  }
}

const seedMailMessageBody = z.object({
  accountId: z.string().optional(),
  subject: z.string().optional(),
  fromEmail: z.string().optional(),
  fromName: z.string().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  isRead: z.boolean().optional(),
  textBody: z.string().optional(),
  htmlBody: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/mail-message',
  zValidator('json', seedMailMessageBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const now = new Date();

    const account = await ensureTestMailAccount(db, body.accountId);

    const id = generateId('msg');
    const smtpId = `<seed-${suffix}-${id}@e2e.test>`;
    const textBody = body.textBody ?? `E2E seeded message ${suffix}`;
    await db.insert(schema.mailMessages).values({
      id,
      accountId: account.id,
      messageId: smtpId,
      threadId: smtpId,
      from: { email: body.fromEmail ?? 'sender@external.test', name: body.fromName },
      to: (body.to ?? [account.email]).map((email) => ({ email })),
      cc: body.cc?.map((email) => ({ email })),
      subject: body.subject ?? `E2E Subject ${suffix}`,
      preview: textBody.slice(0, 200),
      textBody,
      htmlBody: body.htmlBody,
      sentDate: now,
      receivedDate: now,
      isRead: body.isRead ?? false,
      source: 'inbox',
      labels: body.labels ?? ['INBOX'],
      // Marker for /reset.
      customFields: { __e2e: TEST_MARKER },
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.mailMessages.$inferInsert);

    const [row] = await db
      .select()
      .from(schema.mailMessages)
      .where(eq(schema.mailMessages.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

const seedMailAttachmentBody = z.object({
  messageId: z.string(),
  fileName: z.string().optional(),
  contentType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  storagePath: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/mail-attachment',
  zValidator('json', seedMailAttachmentBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const now = new Date();
    const id = generateId('attach');
    await db.insert(schema.mailAttachments).values({
      id,
      messageId: body.messageId,
      fileName: body.fileName ?? `e2e-${suffix}.txt`,
      contentType: body.contentType ?? 'text/plain',
      size: body.size ?? 12,
      storagePath: body.storagePath ?? `workspaces/test/e2e-${suffix}.txt`,
      isInline: false,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.mailAttachments.$inferInsert);
    // Reflect attachment presence on the parent message.
    await db
      .update(schema.mailMessages)
      .set({ hasAttachments: true, attachmentCount: sql`${schema.mailMessages.attachmentCount} + 1` })
      .where(eq(schema.mailMessages.id, body.messageId));
    const [row] = await db
      .select()
      .from(schema.mailAttachments)
      .where(eq(schema.mailAttachments.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldMail: dry-run send / reply / forward ────────────────────────
//
// These call the REAL send services in dry-run mode (no MX lookup, no
// Cloudflare transmit) and return the persisted SENT message + attachment
// rows so API tests can assert cc/bcc/attachment persistence end-to-end.

const fixtureAttachmentSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().optional(),
  size: z.number().int().nonnegative(),
  fileKey: z.string().min(1),
});

/** Stamp the E2E marker on a just-sent message so /reset can find it. */
async function markSentMessage(db: Database, messageId: string): Promise<void> {
  await db
    .update(schema.mailMessages)
    .set({ customFields: { __e2e: TEST_MARKER } })
    .where(eq(schema.mailMessages.id, messageId));
}

async function loadMessageWithAttachments(db: Database, messageId: string) {
  const [message] = await db
    .select()
    .from(schema.mailMessages)
    .where(eq(schema.mailMessages.id, messageId))
    .limit(1);
  const attachments = await db
    .select()
    .from(schema.mailAttachments)
    .where(eq(schema.mailAttachments.messageId, messageId));
  return { message, attachments };
}

function mailSendErrorResponse(c: Parameters<typeof success>[0], err: unknown) {
  if (err instanceof MailSendError) {
    const status = err.code === 'ACCOUNT_NOT_FOUND' ? 404 : 400;
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, status);
  }
  throw err;
}

const fixtureSendBody = z.object({
  accountId: z.string().optional(),
  userId: z.string().optional(),
  to: z.array(z.string()).min(1),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  attachments: z.array(fixtureAttachmentSchema).optional(),
  /** When true (default), pre-write the attachment R2 objects. */
  seedObjects: z.boolean().optional(),
  /**
   * LIVE SEND — when true, actually transmits via the Cloudflare `send_email`
   * binding (skips the dry-run). Requires `accountId` to be a real account on a
   * VERIFIED sending domain; only works in a deployed (non-dev) env. Default
   * false. Still test-token-gated + blocked in production.
   */
  live: z.boolean().optional(),
});

testFixturesRoutes.post(
  '/mail/send',
  zValidator('json', fixtureSendBody),
  async (c) => {
    const db = c.get('tenantDb');
    const orgId = c.get('workspaceId');
    const body = c.req.valid('json');
    const userId = body.userId ?? 'e2e-user';

    const account = await ensureTestMailAccount(db, body.accountId);

    if (body.attachments?.length && body.seedObjects !== false) {
      await seedAttachmentObjects(c.env, body.attachments);
    }

    try {
      const result = await sendAndPersist(
        c.env,
        db,
        orgId,
        userId,
        account.id,
        {
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          body: body.body,
          htmlBody: body.htmlBody,
          attachments: body.attachments,
        },
        c.executionCtx?.waitUntil?.bind(c.executionCtx),
        { dryRun: body.live !== true },
      );
      await markSentMessage(db, result.messageId);
      const persisted = await loadMessageWithAttachments(db, result.messageId);
      return success(c, { result, ...persisted, accountId: account.id }, 201);
    } catch (err) {
      return mailSendErrorResponse(c, err);
    }
  },
);

const fixtureReplyBody = z.object({
  originalMessageId: z.string(),
  userId: z.string().optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyAll: z.boolean().optional(),
  live: z.boolean().optional(),
});

testFixturesRoutes.post(
  '/mail/reply',
  zValidator('json', fixtureReplyBody),
  async (c) => {
    const db = c.get('tenantDb');
    const orgId = c.get('workspaceId');
    const body = c.req.valid('json');
    const userId = body.userId ?? 'e2e-user';

    try {
      const result = await replyAndPersist(
        c.env,
        db,
        orgId,
        userId,
        body.originalMessageId,
        { body: body.body, htmlBody: body.htmlBody, replyAll: body.replyAll },
        c.executionCtx?.waitUntil?.bind(c.executionCtx),
        { dryRun: body.live !== true },
      );
      await markSentMessage(db, result.messageId);
      const persisted = await loadMessageWithAttachments(db, result.messageId);
      return success(c, { result, ...persisted }, 201);
    } catch (err) {
      return mailSendErrorResponse(c, err);
    }
  },
);

const fixtureForwardBody = z.object({
  originalMessageId: z.string(),
  userId: z.string().optional(),
  to: z.array(z.string()).min(1),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  attachments: z.array(fixtureAttachmentSchema).optional(),
  seedObjects: z.boolean().optional(),
  live: z.boolean().optional(),
});

testFixturesRoutes.post(
  '/mail/forward',
  zValidator('json', fixtureForwardBody),
  async (c) => {
    const db = c.get('tenantDb');
    const orgId = c.get('workspaceId');
    const body = c.req.valid('json');
    const userId = body.userId ?? 'e2e-user';

    if (body.attachments?.length && body.seedObjects !== false) {
      await seedAttachmentObjects(c.env, body.attachments);
    }

    try {
      const result = await forwardAndPersist(
        c.env,
        db,
        orgId,
        userId,
        body.originalMessageId,
        { to: body.to, body: body.body, htmlBody: body.htmlBody, attachments: body.attachments },
        c.executionCtx?.waitUntil?.bind(c.executionCtx),
        { dryRun: body.live !== true },
      );
      await markSentMessage(db, result.messageId);
      const persisted = await loadMessageWithAttachments(db, result.messageId);
      return success(c, { result, ...persisted }, 201);
    } catch (err) {
      return mailSendErrorResponse(c, err);
    }
  },
);

// ─── WeldCommerce: product ───────────────────────────────────────────

const seedProductBody = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().optional(),
  status: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/product',
  zValidator('json', seedProductBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('prod');
    const now = new Date();
    const name = body.name ?? `E2E Product ${suffix}`;
    const slug = body.slug ?? `e2e-product-${suffix}`;
    await db.insert(schema.products).values({
      id,
      name,
      slug,
      description: TEST_MARKER,
      status: body.status ?? 'draft',
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldCommerce: order ─────────────────────────────────────────────

const seedOrderBody = z.object({
  orderNumber: z.string().optional(),
  status: z.string().optional(),
  customerId: z.string().optional(),
  customerEmail: z.string().email().optional(),
  customerName: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/order',
  zValidator('json', seedOrderBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('ord');
    const now = new Date();
    await db.insert(schema.orders).values({
      id,
      orderNumber: body.orderNumber ?? `E2E-${suffix}`,
      status: body.status ?? 'pending',
      customerId: body.customerId,
      customerEmail: body.customerEmail,
      customerName: body.customerName ?? `E2E Customer ${suffix}`,
      internalNote: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.orders.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── Workflow automation: workflow ───────────────────────────────────

const seedWorkflowBody = z.object({
  name: z.string().optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
});

testFixturesRoutes.post(
  '/seed/workflow',
  zValidator('json', seedWorkflowBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('wf');
    const now = new Date();
    await db.insert(schema.workflows).values({
      id,
      name: body.name ?? `E2E Workflow ${suffix}`,
      description: TEST_MARKER,
      status: body.status ?? 'draft',
      version: 1,
      executionCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── Workflow automation: webhook (FK → workflows) ───────────────────

const seedWebhookBody = z.object({
  name: z.string().optional(),
  workflowId: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/webhook',
  zValidator('json', seedWebhookBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const now = new Date();

    // Resolve or create parent workflow.
    let workflowId = body.workflowId;
    if (!workflowId) {
      workflowId = generateId('wf');
      await db.insert(schema.workflows).values({
        id: workflowId,
        name: `E2E Workflow (webhook parent) ${suffix}`,
        description: TEST_MARKER,
        status: 'draft',
        version: 1,
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    const id = generateId('wfwh');
    await db.insert(schema.workflowWebhooks).values({
      id,
      workflowId,
      name: body.name ?? `E2E Webhook ${suffix}`,
      description: TEST_MARKER,
      isEnabled: true,
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.workflowWebhooks.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.workflowWebhooks)
      .where(eq(schema.workflowWebhooks.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── Workflow automation: execution (FK → workflows) ─────────────────

const seedExecutionBody = z.object({
  status: z
    .enum([
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'timeout',
      'waiting_for_input',
    ])
    .optional(),
  triggerType: z
    .enum(['manual', 'schedule', 'webhook', 'entity_event', 'api'])
    .optional(),
  workflowId: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/execution',
  zValidator('json', seedExecutionBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const now = new Date();

    // Resolve or create parent workflow.
    let workflowId = body.workflowId;
    if (!workflowId) {
      workflowId = generateId('wf');
      await db.insert(schema.workflows).values({
        id: workflowId,
        name: `E2E Workflow (execution parent) ${suffix}`,
        description: TEST_MARKER,
        status: 'active',
        version: 1,
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    const id = generateId('wfex');
    await db.insert(schema.workflowExecutions).values({
      id,
      workflowId,
      workflowVersion: 1,
      workflowName: TEST_MARKER, // nullable varchar(255) — used as marker
      status: body.status ?? 'queued',
      triggerType: body.triggerType ?? 'manual',
      retryCount: 0,
      currentStepIndex: 0,
      totalSteps: 0,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.workflowExecutions.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldStash (WMS): product ────────────────────────────────────────

const seedWeldstashProductBody = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().optional(),
  sku: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/weldstash-product',
  zValidator('json', seedWeldstashProductBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('prod');
    const now = new Date();
    const name = body.name ?? `E2E Product ${suffix}`;
    const slug = body.slug ?? `e2e-product-${suffix}`;
    await db.insert(schema.products).values({
      id,
      name,
      slug,
      sku: body.sku,
      description: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldStash (WMS): supplier ───────────────────────────────────────

const seedWeldstashSupplierBody = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  contactName: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/weldstash-supplier',
  zValidator('json', seedWeldstashSupplierBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('sup');
    const now = new Date();
    await db.insert(schema.suppliers).values({
      id,
      name: body.name ?? `E2E Supplier ${suffix}`,
      email: body.email,
      contactName: body.contactName,
      notes: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldStash (WMS): warehouse ──────────────────────────────────────

const seedWeldstashWarehouseBody = z.object({
  name: z.string().min(1).optional(),
  code: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/weldstash-warehouse',
  zValidator('json', seedWeldstashWarehouseBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('wh');
    const now = new Date();
    await db.insert(schema.warehouses).values({
      id,
      name: body.name ?? `E2E Warehouse ${suffix}`,
      code: body.code,
      description: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.warehouses)
      .where(eq(schema.warehouses.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldCalendar: calendar event (FK → calendars) ───────────────────

const seedCalendarEventBody = z.object({
  title: z.string().optional(),
  type: z.string().optional(),
  startTime: z.string().optional(),
  organizerId: z.string().optional(),
  calendarId: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/calendar-event',
  zValidator('json', seedCalendarEventBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const now = new Date();
    const ownerId = body.organizerId ?? 'e2e-user';

    // Create parent calendar inline unless caller supplies calendarId.
    let calendarId = body.calendarId;
    if (!calendarId) {
      const calId = generateId('cal');
      await db.insert(schema.calendars).values({
        id: calId,
        name: `E2E Calendar ${suffix}`,
        description: TEST_MARKER,
        ownerId,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof schema.calendars.$inferInsert);
      calendarId = calId;
    }

    const id = generateId('cevt');
    const startTime = body.startTime
      ? new Date(body.startTime)
      : new Date(Date.now() + 86_400_000);
    await db.insert(schema.calendarEvents).values({
      id,
      title: body.title ?? `E2E Event ${suffix}`,
      description: TEST_MARKER,
      type: body.type ?? 'event',
      startTime,
      calendarId,
      organizerId: ownerId,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.calendarEvents.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldCalendar: booking page ──────────────────────────────────────

const seedBookingPageBody = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  ownerId: z.string().optional(),
  duration: z.number().int().positive().optional(),
});

const defaultAvailability = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [] as { start: string; end: string }[],
  sunday: [] as { start: string; end: string }[],
};

testFixturesRoutes.post(
  '/seed/booking-page',
  zValidator('json', seedBookingPageBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const now = new Date();
    const id = generateId('bkpg');

    await db.insert(schema.calendarBookingPages).values({
      id,
      name: body.name ?? `E2E Booking Page ${suffix}`,
      slug: body.slug ?? `e2e-booking-${suffix}`,
      description: TEST_MARKER,
      ownerId: body.ownerId ?? 'e2e-user',
      duration: body.duration ?? 30,
      availability: defaultAvailability,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.calendarBookingPages.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.calendarBookingPages)
      .where(eq(schema.calendarBookingPages.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── WeldCall: VoIP call ─────────────────────────────────────────────

const seedVoipCallBody = z.object({
  direction: z.enum(['inbound', 'outbound']).optional(),
  fromNumber: z.string().optional(),
  toNumber: z.string().optional(),
  userId: z.string().optional(),
  status: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/voip-call',
  zValidator('json', seedVoipCallBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('vcall');
    const now = new Date();
    await db.insert(schema.voipCalls).values({
      id,
      userId: body.userId ?? 'e2e-user',
      direction: body.direction ?? 'outbound',
      fromNumber: body.fromNumber ?? '+10000000000',
      toNumber:
        body.toNumber ?? `+1555${suffix.slice(-7).padStart(7, '0')}`,
      status: body.status ?? 'completed',
      notes: TEST_MARKER,
      createdAt: now,
      updatedAt: now,
      initiatedAt: now,
    } as unknown as typeof schema.voipCalls.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.voipCalls)
      .where(eq(schema.voipCalls.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── Settings: custom field definition ───────────────────────────────

const seedCustomFieldDefinitionBody = z.object({
  entityType: z.string().optional(),
  name: z.string().optional(),
  slug: z.string().optional(),
  fieldType: z
    .enum([
      'text',
      'number',
      'boolean',
      'date',
      'select',
      'multiselect',
      'url',
      'email',
    ])
    .optional(),
  group: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/custom-field-definition',
  zValidator('json', seedCustomFieldDefinitionBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('cfld');
    const now = new Date();
    const slug = body.slug ?? `e2e-field-${suffix}`;
    const entityType = body.entityType ?? 'company';
    await db.insert(schema.customFieldDefinitions).values({
      id,
      entityType,
      name: body.name ?? `E2E Field ${suffix}`,
      slug,
      fieldType: body.fieldType ?? 'text',
      description: TEST_MARKER,
      group: body.group,
      required: false,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.customFieldDefinitions.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.customFieldDefinitions)
      .where(eq(schema.customFieldDefinitions.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── Settings: object template ───────────────────────────────────────

const seedObjectTemplateBody = z.object({
  entityType: z.string().optional(),
  name: z.string().optional(),
  slug: z.string().optional(),
  fields: z.array(z.string()).optional(),
});

testFixturesRoutes.post(
  '/seed/object-template',
  zValidator('json', seedObjectTemplateBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('crmtpl');
    const now = new Date();
    await db.insert(schema.objectTemplates).values({
      id,
      entityType: body.entityType ?? 'company',
      name: body.name ?? `E2E Template ${suffix}`,
      slug: body.slug ?? `e2e-template-${suffix}`,
      description: TEST_MARKER,
      fields: body.fields ?? [],
      isDefault: false,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.objectTemplates.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.objectTemplates)
      .where(eq(schema.objectTemplates.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── Settings: customer status (marker embedded in name) ─────────────

const seedCustomerStatusBody = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  color: z.string().optional(),
});

testFixturesRoutes.post(
  '/seed/customer-status',
  zValidator('json', seedCustomerStatusBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const suffix = Date.now().toString(36);
    const id = generateId('ccst');
    const now = new Date();
    // No nullable text column — embed marker in `name` (varchar 60).
    const name = body.name ?? `${TEST_MARKER} Status ${suffix}`;
    const slug = body.slug ?? `e2e-status-${suffix}`;
    await db.insert(schema.crmCustomerStatuses).values({
      id,
      name,
      slug,
      color: body.color ?? 'gray',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.crmCustomerStatuses.$inferInsert);
    const [row] = await db
      .select()
      .from(schema.crmCustomerStatuses)
      .where(eq(schema.crmCustomerStatuses.id, id))
      .limit(1);
    return success(c, row, 201);
  },
);

// ─── Workspace provisioning ──────────────────────────────────────────

/**
 * Installs apps for the test workspace by upserting `workspace_installed_apps`
 * rows (same table the real `/settings/apps/:code/install` route writes, in
 * the tenant DB). Idempotent — reactivates any soft-deleted row. Without this,
 * a fresh E2E workspace has zero apps, so `AppAccessGuard` redirects every
 * module route to home and the module suite can't run. NOT cleaned by /reset
 * (workspace config is meant to persist across tests). Skips app-catalog
 * validation — these are known branded codes seeded for tests only.
 */
const DEFAULT_INSTALL_APPS = [
  'weldcrm', 'welddesk', 'weldflow', 'weldmail',
  'weldconnect', 'weldhost', 'weldstash', 'weldbooks', 'weldcalendar',
  'weldmeet', 'weldchat', 'welddrive',
];

const installAppsBody = z.object({
  apps: z.array(z.string().min(1)).optional(),
  // Clerk user id of the test user. If given, that user is granted a
  // user_app_assignments row for every installed app, so the dashboard
  // installed-apps endpoint surfaces them all even when the user isn't an
  // OWNER/ADMIN workspace member (the dedicated test user has assignments
  // but no membership row).
  userId: z.string().optional(),
});

testFixturesRoutes.post(
  '/install-apps',
  zValidator('json', installAppsBody),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const apps = body.apps && body.apps.length ? body.apps : DEFAULT_INSTALL_APPS;
    const now = new Date();

    for (const appCode of apps) {
      await db
        .insert(schema.workspaceInstalledApps)
        .values({
          id: generateId('wia'),
          appCode,
          isActive: true,
          installedBy: TEST_MARKER,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.workspaceInstalledApps.appCode,
          set: { isActive: true, deletedAt: null, updatedAt: now },
        });
    }

    // Promote every workspace member to OWNER so the dashboard installed-apps
    // endpoint returns ALL installed apps for them (it only returns the full
    // set for OWNER/ADMIN; non-admins get just their per-user assignments).
    await db
      .update(schema.workspaceMembers)
      .set({ role: 'OWNER', updatedAt: now })
      .where(isNull(schema.workspaceMembers.deletedAt));

    // The test user authenticates with a Clerk JWT but has no workspace_members
    // row (only assignments), so the OWNER bypass above doesn't apply to them.
    // Grant explicit assignments for every installed app so they see all of it.
    if (body.userId) {
      const installedCodes = body.apps && body.apps.length ? body.apps : DEFAULT_INSTALL_APPS;
      for (const appCode of installedCodes) {
        await db
          .insert(schema.userAppAssignments)
          .values({
            id: generateId('uaa'),
            userId: body.userId,
            appCode,
            isActive: true,
            grantedBy: TEST_MARKER,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.userAppAssignments.userId, schema.userAppAssignments.appCode],
            set: { isActive: true, deletedAt: null, updatedAt: now },
          });
      }
    }

    const rows = await db
      .select({ appCode: schema.workspaceInstalledApps.appCode })
      .from(schema.workspaceInstalledApps)
      .where(
        and(
          eq(schema.workspaceInstalledApps.isActive, true),
          isNull(schema.workspaceInstalledApps.deletedAt),
        ),
      );
    const members = await db
      .select({ userId: schema.workspaceMembers.userId, role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .where(isNull(schema.workspaceMembers.deletedAt));
    const assignments = body.userId
      ? await db
          .select({ appCode: schema.userAppAssignments.appCode, isActive: schema.userAppAssignments.isActive })
          .from(schema.userAppAssignments)
          .where(eq(schema.userAppAssignments.userId, body.userId))
      : [];
    return success(c, { installed: rows.map((r) => r.appCode), members, assignments });
  },
);

// ─── Targeted teardown ───────────────────────────────────────────────

testFixturesRoutes.delete('/entity/:type/:id', async (c) => {
  const db = c.get('tenantDb');
  const { type, id } = c.req.param();

  switch (type) {
    case 'company':
      await db.delete(schema.companies).where(eq(schema.companies.id, id));
      return success(c, { deleted: true });
    case 'person':
      await db.delete(schema.people).where(eq(schema.people.id, id));
      return success(c, { deleted: true });
    case 'pipeline':
      await db.delete(schema.crmPipelines).where(eq(schema.crmPipelines.id, id));
      return success(c, { deleted: true });
    case 'lead':
      await db.delete(schema.crmLeads).where(eq(schema.crmLeads.id, id));
      return success(c, { deleted: true });
    case 'list':
      await db.delete(schema.lists).where(eq(schema.lists.id, id));
      return success(c, { deleted: true });
    case 'project':
      await db.delete(schema.projects).where(eq(schema.projects.id, id));
      return success(c, { deleted: true });
    case 'task':
      await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
      return success(c, { deleted: true });
    case 'opportunity':
      await db
        .delete(schema.crmOpportunities)
        .where(eq(schema.crmOpportunities.id, id));
      return success(c, { deleted: true });
    case 'activity':
      await db
        .delete(schema.crmActivities)
        .where(eq(schema.crmActivities.id, id));
      return success(c, { deleted: true });
    case 'sequence':
    case 'workflow':
      await db.delete(schema.workflows).where(eq(schema.workflows.id, id));
      return success(c, { deleted: true });
    case 'variable':
      await db
        .delete(schema.workflowVariables)
        .where(eq(schema.workflowVariables.id, id));
      return success(c, { deleted: true });
    case 'ticket':
      await db
        .delete(schema.helpdeskTickets)
        .where(eq(schema.helpdeskTickets.id, id));
      return success(c, { deleted: true });
    case 'meeting':
      await db.delete(schema.meetings).where(eq(schema.meetings.id, id));
      return success(c, { deleted: true });
    case 'domain':
      await db.delete(schema.hostDomains).where(eq(schema.hostDomains.id, id));
      return success(c, { deleted: true });
    case 'mailAccount':
      await db
        .delete(schema.mailAccounts)
        .where(eq(schema.mailAccounts.id, id));
      return success(c, { deleted: true });
    case 'mailLabel':
      await db.delete(schema.mailLabels).where(eq(schema.mailLabels.id, id));
      return success(c, { deleted: true });
    case 'mailMessage':
      // Drop child attachments first (FK → mail_messages).
      await db
        .delete(schema.mailAttachments)
        .where(eq(schema.mailAttachments.messageId, id));
      await db.delete(schema.mailMessages).where(eq(schema.mailMessages.id, id));
      return success(c, { deleted: true });
    case 'mailAttachment':
      await db
        .delete(schema.mailAttachments)
        .where(eq(schema.mailAttachments.id, id));
      return success(c, { deleted: true });
    case 'product':
    case 'weldstash-product':
      await db.delete(schema.products).where(eq(schema.products.id, id));
      return success(c, { deleted: true });
    case 'order':
      await db.delete(schema.orders).where(eq(schema.orders.id, id));
      return success(c, { deleted: true });
    case 'webhook':
      await db
        .delete(schema.workflowWebhooks)
        .where(eq(schema.workflowWebhooks.id, id));
      return success(c, { deleted: true });
    case 'execution':
      await db
        .delete(schema.workflowExecutions)
        .where(eq(schema.workflowExecutions.id, id));
      return success(c, { deleted: true });
    case 'weldstash-supplier':
      await db.delete(schema.suppliers).where(eq(schema.suppliers.id, id));
      return success(c, { deleted: true });
    case 'weldstash-warehouse':
      await db.delete(schema.warehouses).where(eq(schema.warehouses.id, id));
      return success(c, { deleted: true });
    case 'calendarEvent':
      await db
        .delete(schema.calendarEvents)
        .where(eq(schema.calendarEvents.id, id));
      return success(c, { deleted: true });
    case 'bookingPage':
      await db
        .delete(schema.calendarBookingPages)
        .where(eq(schema.calendarBookingPages.id, id));
      return success(c, { deleted: true });
    case 'voip-call':
      await db.delete(schema.voipCalls).where(eq(schema.voipCalls.id, id));
      return success(c, { deleted: true });
    case 'customFieldDefinition':
      await db
        .delete(schema.customFieldDefinitions)
        .where(eq(schema.customFieldDefinitions.id, id));
      return success(c, { deleted: true });
    case 'objectTemplate':
      await db
        .delete(schema.objectTemplates)
        .where(eq(schema.objectTemplates.id, id));
      return success(c, { deleted: true });
    case 'customerStatus':
      await db
        .delete(schema.crmCustomerStatuses)
        .where(eq(schema.crmCustomerStatuses.id, id));
      return success(c, { deleted: true });
    case 'chatChannel':
      // Cascade children first to respect the FK to chat_channels.
      await db.delete(schema.chatMessages).where(eq(schema.chatMessages.channelId, id));
      await db.delete(schema.chatChannelMembers).where(eq(schema.chatChannelMembers.channelId, id));
      await db.delete(schema.chatChannels).where(eq(schema.chatChannels.id, id));
      return success(c, { deleted: true });
    case 'chatMessage':
      await db.delete(schema.chatMessages).where(eq(schema.chatMessages.id, id));
      return success(c, { deleted: true });
    case 'chatChannelMember':
      await db.delete(schema.chatChannelMembers).where(eq(schema.chatChannelMembers.id, id));
      return success(c, { deleted: true });
    default:
      return error.badRequest(c, `Unknown entity type: ${type}`);
  }
});

// ─── Onboarding teardown: full workspace destroy ─────────────────────
//
// Tears down a workspace created by the onboarding E2E spec (Part A of
// PLAN-onboarding-e2e.md). Destructive + outward-facing — it deletes a real
// Clerk organization and drops the Neon tenant DB — so it stays strictly
// behind the `testFixturesGuard()` applied to this whole router, PLUS an
// in-handler refusal that protects the shared E2E workspace.
//
// Idempotent: a missing workspace (or a Clerk org already gone) returns
// `{ ok: true }` rather than 500, so an `afterAll` hook can run safely even
// when the test bailed before provisioning finished.

// Same host the api-worker NeonClient uses, so behaviour matches the
// provisioning path we mirror.
const NEON_API_BASE = 'https://console.neon.tech/api/v2';

/**
 * Deletes the Neon tenant DB for a workspace by mirroring
 * api-worker's `DatabaseProvisioningService.deleteWorkspaceDatabase` path:
 * dedicated projects → delete the whole project; legacy shared projects →
 * delete just the database + role on the branch. Tolerates 404 (already
 * gone) so the endpoint stays idempotent. Returns false when there is no
 * Neon project recorded (nothing to drop).
 */
async function dropNeonTenantDb(
  apiKey: string,
  workspace: {
    neonProjectId: string | null;
    neonBranchId: string | null;
    neonDatabaseName: string | null;
    neonRoleName: string | null;
    sharedProjectId: string | null;
  },
): Promise<boolean> {
  if (!workspace.neonProjectId) return false;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const okOrGone = (status: number) => status < 300 || status === 404;

  if (workspace.sharedProjectId) {
    // Legacy shared project — drop the per-workspace database + role only.
    if (workspace.neonBranchId && workspace.neonDatabaseName) {
      const res = await fetch(
        `${NEON_API_BASE}/projects/${workspace.neonProjectId}/branches/${workspace.neonBranchId}/databases/${workspace.neonDatabaseName}`,
        { method: 'DELETE', headers },
      );
      if (!okOrGone(res.status)) {
        throw new Error(
          `Neon deleteDatabase failed: ${res.status} ${await res.text()}`,
        );
      }
    }
    if (workspace.neonBranchId && workspace.neonRoleName) {
      const res = await fetch(
        `${NEON_API_BASE}/projects/${workspace.neonProjectId}/branches/${workspace.neonBranchId}/roles/${workspace.neonRoleName}`,
        { method: 'DELETE', headers },
      );
      if (!okOrGone(res.status)) {
        throw new Error(
          `Neon deleteRole failed: ${res.status} ${await res.text()}`,
        );
      }
    }
    return true;
  }

  // Dedicated project — delete the entire Neon project.
  const res = await fetch(
    `${NEON_API_BASE}/projects/${workspace.neonProjectId}`,
    { method: 'DELETE', headers },
  );
  if (!okOrGone(res.status)) {
    throw new Error(
      `Neon deleteProject failed: ${res.status} ${await res.text()}`,
    );
  }
  return true;
}

/**
 * Deletes a Clerk organization via the Backend API (same REST pattern used by
 * workspace-worker's onboard flow). Tolerates 404 so a second call is a no-op.
 */
async function deleteClerkOrg(
  clerkSecretKey: string,
  clerkOrgId: string,
): Promise<void> {
  const res = await fetch(
    `https://api.clerk.com/v1/organizations/${clerkOrgId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${clerkSecretKey}` },
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Clerk deleteOrganization failed: ${res.status} ${await res.text()}`,
    );
  }
}

const teardownWorkspaceBody = z.object({
  clerkOrgId: z.string().min(1),
});

testFixturesRoutes.post(
  '/teardown-workspace',
  zValidator('json', teardownWorkspaceBody),
  async (c) => {
    const { clerkOrgId } = c.req.valid('json');

    // Safety refusal: never tear down the shared E2E workspace. The guard
    // injects X-Test-Workspace-Id as `workspaceId`, but compare against the
    // configured TEST_WORKSPACE_ID too in case a caller targets it directly.
    const sharedWorkspaceId = (
      c.env as Env & { TEST_WORKSPACE_ID?: string }
    ).TEST_WORKSPACE_ID;
    if (
      clerkOrgId === sharedWorkspaceId ||
      clerkOrgId === c.get('workspaceId')
    ) {
      return error.badRequest(
        c,
        'Refusing to tear down the shared E2E workspace',
      );
    }

    const masterDb = getMasterDb(c.env);

    // 1. Look up the workspace row by Clerk org id.
    const [workspace] = await masterDb
      .select({
        id: masterSchema.workspaces.id,
        neonProjectId: masterSchema.workspaces.neonProjectId,
        neonBranchId: masterSchema.workspaces.neonBranchId,
        neonDatabaseName: masterSchema.workspaces.neonDatabaseName,
        neonRoleName: masterSchema.workspaces.neonRoleName,
        sharedProjectId: masterSchema.workspaces.sharedProjectId,
      })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
      .limit(1);

    // 2. Drop the Neon tenant DB (best-effort, idempotent). Skipped when the
    //    workspace row is already gone — nothing recorded to drop.
    if (workspace) {
      await dropNeonTenantDb(c.env.NEON_API_KEY, workspace);
    }

    // 3. Delete the Clerk organization (idempotent — 404 tolerated).
    await deleteClerkOrg(c.env.CLERK_SECRET_KEY, clerkOrgId);

    // 4. Remove master-DB membership + workspace rows (children first).
    if (workspace) {
      await masterDb
        .delete(masterSchema.userWorkspaces)
        .where(eq(masterSchema.userWorkspaces.workspaceId, workspace.id));
      await masterDb
        .delete(masterSchema.workspaces)
        .where(eq(masterSchema.workspaces.id, workspace.id));
    }

    return success(c, { ok: true });
  },
);
