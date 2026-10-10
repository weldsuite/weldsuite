/**
 * SendDigestWorkflow — Cloudflare Workflow
 *
 * Per-user workflow that queries overdue/due-today/due-this-week tasks and
 * sends the 'flow.digest' system email (@weldsuite/emails) through whichever
 * transport the worker is configured with (`workerTransport`: Resend during
 * the migration, else the Cloudflare `SEND_EMAIL` binding).
 *
 * Triggered by the hourly digest sweep cron handler (flow-api's
 * src/cron/digest-sweep.ts).
 * Instance ID: `digest-${clerkOrgId}-${userId}-${YYYY-MM-DD}` for daily dedup.
 *
 * Ported from apps/api-worker/src/workflows/send-digest.ts (W4 legacy-worker
 * phase-out). Hosted in flow-api under the workflow names
 * `send-digest-v3[-dev]` (bound as SEND_DIGEST and re-exported from flow-api's
 * src/index.ts). app-api's old `send-digest-v2*` instances finished draining
 * and were removed from app-api on 2026-09-29 (see its src/index.ts).
 *
 * Step boundaries: Workflow step outputs must be JSON-serializable, so the
 * first step queries tasks and builds the plain-object email props; the
 * second step builds the transport (not serializable) and sends.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull, lt, between, notInArray } from 'drizzle-orm';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import { resolveEmailLocale, sendSystemEmail, type EmailBrand, type EmailLocale, type FlowDigestEmailProps } from '@weldsuite/emails';
import { workerTransport, type SystemEmailEnv } from '@weldsuite/emails/transports/binding';

/**
 * The bindings the workflow reads: tenant DB resolution, the environment name
 * (platform links), and the system-email transport (@weldsuite/emails).
 * Any worker Env with them fits.
 */
export interface SendDigestEnv extends DbEnv, SystemEmailEnv {
  ENVIRONMENT: string;
}

// ── Types ────────────────────────────────────────────────────────────────

export interface SendDigestParams {
  workspaceId: string; // clerkOrgId
  userId: string;
  email: string;
  name: string;
  timezone: string;
}

interface DigestTask {
  id: string;
  title: string;
  dueDate: Date | null;
  priority: string;
  projectName?: string | null;
  type: 'project' | 'personal';
}

// ── Date Helpers ─────────────────────────────────────────────────────────

function getDateBoundaries(timezone: string): {
  startOfToday: Date;
  endOfToday: Date;
  endOfWeek: Date;
} {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = formatter.format(now); // "YYYY-MM-DD"

  const startOfToday = new Date(`${todayStr}T00:00:00`);
  const endOfToday = new Date(`${todayStr}T23:59:59.999`);

  const todayDate = new Date(todayStr);
  const dayOfWeek = todayDate.getDay();
  const daysUntilSunday = dayOfWeek === 0 ? 6 : 7 - dayOfWeek;
  const endOfWeekDate = new Date(todayDate);
  endOfWeekDate.setDate(endOfWeekDate.getDate() + daysUntilSunday);
  const endOfWeekStr = endOfWeekDate.toISOString().split('T')[0];
  const endOfWeek = new Date(`${endOfWeekStr}T23:59:59.999`);

  return { startOfToday, endOfToday, endOfWeek };
}

// ── Query Helpers ────────────────────────────────────────────────────────

const DONE_STATUSES = ['done', 'cancelled'];

async function queryProjectTasks(
  db: any,
  userId: string,
  startOfToday: Date,
  endOfToday: Date,
  endOfWeek: Date,
  sections: { overdue: boolean; dueToday: boolean; dueThisWeek: boolean },
): Promise<{ overdue: DigestTask[]; dueToday: DigestTask[]; dueThisWeek: DigestTask[] }> {
  const result = { overdue: [] as DigestTask[], dueToday: [] as DigestTask[], dueThisWeek: [] as DigestTask[] };

  const projectRows = await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects);
  const projectMap = new Map(projectRows.map((p: any) => [p.id, p.name]));

  const mapTask = (t: any): DigestTask => ({
    id: t.id,
    title: t.title,
    dueDate: t.dueDate,
    priority: t.priority || 'medium',
    projectName: (projectMap.get(t.projectId) as string) || null,
    type: 'project' as const,
  });

  if (sections.overdue) {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.assigneeId, userId), lt(schema.tasks.dueDate, startOfToday), notInArray(schema.tasks.status, DONE_STATUSES), isNull(schema.tasks.deletedAt)))
      .limit(25);
    result.overdue = rows.map(mapTask);
  }

  if (sections.dueToday) {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.assigneeId, userId), between(schema.tasks.dueDate, startOfToday, endOfToday), notInArray(schema.tasks.status, DONE_STATUSES), isNull(schema.tasks.deletedAt)))
      .limit(25);
    result.dueToday = rows.map(mapTask);
  }

  if (sections.dueThisWeek) {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.assigneeId, userId), between(schema.tasks.dueDate, endOfToday, endOfWeek), notInArray(schema.tasks.status, DONE_STATUSES), isNull(schema.tasks.deletedAt)))
      .limit(25);
    result.dueThisWeek = rows.map(mapTask);
  }

  return result;
}

async function queryStandaloneTasks(
  db: any,
  userId: string,
  startOfToday: Date,
  endOfToday: Date,
  endOfWeek: Date,
  sections: { overdue: boolean; dueToday: boolean; dueThisWeek: boolean },
): Promise<{ overdue: DigestTask[]; dueToday: DigestTask[]; dueThisWeek: DigestTask[] }> {
  const result = { overdue: [] as DigestTask[], dueToday: [] as DigestTask[], dueThisWeek: [] as DigestTask[] };

  const mapTask = (t: any): DigestTask => ({
    id: t.id,
    title: t.title,
    dueDate: t.dueDate,
    priority: t.priority || 'medium',
    projectName: null,
    type: 'personal' as const,
  });

  // Standalone tasks = tasks without a projectId, assigned to this user
  if (sections.overdue) {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.assigneeId, userId), isNull(schema.tasks.projectId), lt(schema.tasks.dueDate, startOfToday), notInArray(schema.tasks.status, DONE_STATUSES), isNull(schema.tasks.deletedAt)))
      .limit(25);
    result.overdue = rows.map(mapTask);
  }

  if (sections.dueToday) {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.assigneeId, userId), isNull(schema.tasks.projectId), between(schema.tasks.dueDate, startOfToday, endOfToday), notInArray(schema.tasks.status, DONE_STATUSES), isNull(schema.tasks.deletedAt)))
      .limit(25);
    result.dueToday = rows.map(mapTask);
  }

  if (sections.dueThisWeek) {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.assigneeId, userId), isNull(schema.tasks.projectId), between(schema.tasks.dueDate, endOfToday, endOfWeek), notInArray(schema.tasks.status, DONE_STATUSES), isNull(schema.tasks.deletedAt)))
      .limit(25);
    result.dueThisWeek = rows.map(mapTask);
  }

  return result;
}

/** Map the internal query shape to the email template's plain-object task shape. */
function toEmailTasks(tasks: DigestTask[], platformUrl: string): FlowDigestEmailProps['overdue'] {
  return tasks.map((t) => ({
    title: t.title,
    url: `${platformUrl}/weldflow/task/${t.id}`,
    projectName: t.projectName ?? null,
    personal: t.type === 'personal',
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
  }));
}

// ── Platform URL Helper ──────────────────────────────────────────────────

function getPlatformUrl(environment: string): string {
  const urls: Record<string, string> = {
    development: 'http://localhost:3000',
    test: 'https://app-test.weldsuite.org',
    preview: 'https://app-preview.weldsuite.org',
    production: 'https://app.weldsuite.org',
  };
  return urls[environment] || 'https://app.weldsuite.org';
}

/** What step 1 hands step 2 — must be JSON-serializable (no transports, no Dates). */
interface PreparedDigestEmail {
  skip: boolean;
  to?: string;
  props?: FlowDigestEmailProps;
  locale?: EmailLocale;
  brand?: EmailBrand;
  fromName?: string;
  headers?: Record<string, string>;
  totalTasks?: number;
}

// ── Workflow ─────────────────────────────────────────────────────────────

export class SendDigestWorkflow extends WorkflowEntrypoint<SendDigestEnv, SendDigestParams> {
  async run(event: WorkflowEvent<SendDigestParams>, step: WorkflowStep) {
    const { workspaceId, userId, email, name, timezone } = event.payload;

    // Step 1: Query tasks and build the email props (serializable plain object).
    const emailData: PreparedDigestEmail = await step.do('query-and-prepare', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);

      // Get workspace branding + locale
      const [wsSettings] = await db
        .select({
          timezone: schema.workspaceSettings.timezone,
          logoUrl: schema.workspaceSettings.logoUrl,
          tradingName: schema.workspaceSettings.tradingName,
          primaryColor: schema.workspaceSettings.primaryColor,
          language: schema.workspaceSettings.language,
        })
        .from(schema.workspaceSettings)
        .limit(1);

      const [userPref] = await db
        .select({ language: schema.userPreferences.language })
        .from(schema.userPreferences)
        .where(eq(schema.userPreferences.userId, userId))
        .limit(1);

      const wsTimezone = wsSettings?.timezone || timezone || 'UTC';
      const workspaceName = wsSettings?.tradingName || 'WeldSuite';
      const logoUrl = wsSettings?.logoUrl || null;
      const primaryColor = wsSettings?.primaryColor || '#2563eb';
      const platformUrl = getPlatformUrl(this.env.ENVIRONMENT);
      const locale = resolveEmailLocale(userPref?.language, wsSettings?.language);

      // Get digest config
      const [digestSettings] = await db.select().from(schema.taskDigestSettings).limit(1);
      const taskTypes = (digestSettings?.taskTypes as any) || { projectTasks: true, personalTasks: true };
      const sections = (digestSettings?.sections as any) || { overdue: true, dueToday: true, dueThisWeek: true };

      // Compute date boundaries
      const { startOfToday, endOfToday, endOfWeek } = getDateBoundaries(wsTimezone);

      // Query tasks
      const overdue: DigestTask[] = [];
      const dueToday: DigestTask[] = [];
      const dueThisWeek: DigestTask[] = [];

      if (taskTypes.projectTasks) {
        const pt = await queryProjectTasks(db, userId, startOfToday, endOfToday, endOfWeek, sections);
        overdue.push(...pt.overdue);
        dueToday.push(...pt.dueToday);
        dueThisWeek.push(...pt.dueThisWeek);
      }

      if (taskTypes.personalTasks) {
        const pt = await queryStandaloneTasks(db, userId, startOfToday, endOfToday, endOfWeek, sections);
        overdue.push(...pt.overdue);
        dueToday.push(...pt.dueToday);
        dueThisWeek.push(...pt.dueThisWeek);
      }

      const totalTasks = overdue.length + dueToday.length + dueThisWeek.length;
      if (totalTasks === 0) {
        console.log(`[Digest] No tasks for ${email}, skipping`);
        return { skip: true };
      }

      const firstName = name.split(' ')[0] || name;
      const unsubscribeUrl = `${platformUrl}/settings/notifications`;

      const props: FlowDigestEmailProps = {
        firstName,
        workspaceName,
        overdue: toEmailTasks(overdue, platformUrl),
        dueToday: toEmailTasks(dueToday, platformUrl),
        dueThisWeek: toEmailTasks(dueThisWeek, platformUrl),
        timezone: wsTimezone,
        date: new Date().toISOString(),
        tasksUrl: `${platformUrl}/weldflow`,
        settingsUrl: unsubscribeUrl,
      };

      return {
        skip: false,
        to: email,
        props,
        locale,
        brand: { kind: 'workspace', name: workspaceName, logoUrl, accentColor: primaryColor },
        fromName: workspaceName,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        totalTasks,
      };
    });

    if (emailData.skip || !emailData.to || !emailData.props) return;

    // Step 2: Build the transport (not serializable) and send.
    await step.do('send-email', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const transport = workerTransport(this.env);
      if (!transport) {
        console.log(`[Digest] No email transport configured, skipping send to ${emailData.to}`);
        return { skipped: true };
      }

      const result = await sendSystemEmail(transport, {
        template: 'flow.digest',
        props: emailData.props!,
        to: emailData.to!,
        locale: emailData.locale,
        brand: emailData.brand,
        fromName: emailData.fromName,
        headers: emailData.headers,
      });
      console.log(`[Digest] Sent to ${emailData.to} via ${result.transport}: ${result.messageId}`);
      return { transport: result.transport, messageId: result.messageId };
    });
  }
}
