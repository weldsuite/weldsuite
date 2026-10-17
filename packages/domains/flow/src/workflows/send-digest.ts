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
import { and, asc, eq, gte, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import { getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import { dayBoundsInTimezone, type DayBounds } from '../day-boundaries';
import {
  resolveEmailLocale,
  sendSystemEmail,
  workspaceAppUrl,
  type EmailBrand,
  type EmailLocale,
  type FlowDigestEmailProps,
} from '@weldsuite/emails';
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

export interface DigestTask {
  id: string;
  title: string;
  dueDate: Date | null;
  priority: string;
  projectName?: string | null;
  type: 'project' | 'personal';
}

// ── Query Helpers ────────────────────────────────────────────────────────

const DONE_STATUSES = ['done', 'cancelled'];

/** Tasks listed per section, so a huge backlog cannot make the email unreadable. */
const SECTION_LIMIT = 25;

export interface DigestSections {
  overdue: boolean;
  dueToday: boolean;
  dueThisWeek: boolean;
}

export interface DigestTaskTypes {
  projectTasks: boolean;
  personalTasks: boolean;
}

export interface DigestTasks {
  overdue: DigestTask[];
  dueToday: DigestTask[];
  dueThisWeek: DigestTask[];
}

/**
 * One section of one kind of task, due in `[from, to)` (open-ended on the side
 * left out), oldest due date first.
 *
 * Project tasks are those with a project (and a live one); personal tasks are
 * those without. Keeping the two apart by `projectId` is what stops a personal
 * task being listed twice, and what makes the "personal tasks" switch real. A
 * task counts for the user when they are its `assigneeId` or sit in its
 * multi-assignee `assigneeIds`.
 */
async function queryDigestSection(
  db: Database,
  userId: string,
  kind: DigestTask['type'],
  window: { from?: Date; to: Date },
): Promise<DigestTask[]> {
  const t = schema.tasks;
  const rows = await db
    .select({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      priority: t.priority,
      projectName: schema.projects.name,
    })
    .from(t)
    .leftJoin(schema.projects, eq(t.projectId, schema.projects.id))
    .where(
      and(
        or(eq(t.assigneeId, userId), sql`${t.assigneeIds}::jsonb @> ${JSON.stringify([userId])}::jsonb`),
        kind === 'project' ? and(isNotNull(t.projectId), isNull(schema.projects.deletedAt)) : isNull(t.projectId),
        window.from ? gte(t.dueDate, window.from) : isNotNull(t.dueDate),
        lt(t.dueDate, window.to),
        notInArray(t.status, DONE_STATUSES),
        isNull(t.deletedAt),
      ),
    )
    .orderBy(asc(t.dueDate), asc(t.id))
    .limit(SECTION_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    dueDate: row.dueDate,
    priority: row.priority || 'medium',
    projectName: kind === 'project' ? row.projectName : null,
    type: kind,
  }));
}

/**
 * The user's overdue / due-today / due-this-week tasks. Day boundaries are the
 * workspace-timezone ones in `bounds`: overdue is before today's local midnight,
 * today runs to tomorrow's, this week up to next Monday.
 */
export async function queryDigestTasks(
  db: Database,
  userId: string,
  bounds: DayBounds,
  taskTypes: DigestTaskTypes,
  sections: DigestSections,
): Promise<DigestTasks> {
  const windows: Record<keyof DigestSections, { from?: Date; to: Date }> = {
    overdue: { to: bounds.startOfToday },
    dueToday: { from: bounds.startOfToday, to: bounds.startOfTomorrow },
    dueThisWeek: { from: bounds.startOfTomorrow, to: bounds.startOfNextWeek },
  };
  const kinds: DigestTask['type'][] = [
    ...(taskTypes.projectTasks ? (['project'] as const) : []),
    ...(taskTypes.personalTasks ? (['personal'] as const) : []),
  ];

  const result: DigestTasks = { overdue: [], dueToday: [], dueThisWeek: [] };
  for (const section of Object.keys(windows) as (keyof DigestSections)[]) {
    if (!sections[section]) continue;
    for (const kind of kinds) {
      result[section].push(...(await queryDigestSection(db, userId, kind, windows[section])));
    }
  }
  return result;
}

/** Map the internal query shape to the email template's plain-object task shape. */
function toEmailTasks(tasks: DigestTask[], appUrl: (path: string) => string): FlowDigestEmailProps['overdue'] {
  return tasks.map((t) => ({
    title: t.title,
    url: appUrl(`/weldflow/task/${t.id}`),
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
      // Open every link in this digest's workspace (FE-013).
      const appUrl = (path: string) => workspaceAppUrl(platformUrl, workspaceId, path);
      const locale = resolveEmailLocale(userPref?.language, wsSettings?.language);

      // Get digest config
      const [digestSettings] = await db.select().from(schema.taskDigestSettings).limit(1);
      const taskTypes =
        (digestSettings?.taskTypes as DigestTaskTypes | null) || { projectTasks: true, personalTasks: true };
      const sections =
        (digestSettings?.sections as DigestSections | null) || { overdue: true, dueToday: true, dueThisWeek: true };

      // Day boundaries in the workspace time zone, not the Worker's UTC clock.
      const { overdue, dueToday, dueThisWeek } = await queryDigestTasks(
        db,
        userId,
        dayBoundsInTimezone(wsTimezone),
        taskTypes,
        sections,
      );

      const totalTasks = overdue.length + dueToday.length + dueThisWeek.length;
      if (totalTasks === 0) {
        console.log(`[Digest] No tasks for ${email}, skipping`);
        return { skip: true };
      }

      const firstName = name.split(' ')[0] || name;
      const unsubscribeUrl = appUrl('/settings/notifications');

      const props: FlowDigestEmailProps = {
        firstName,
        workspaceName,
        overdue: toEmailTasks(overdue, appUrl),
        dueToday: toEmailTasks(dueToday, appUrl),
        dueThisWeek: toEmailTasks(dueThisWeek, appUrl),
        timezone: wsTimezone,
        date: new Date().toISOString(),
        tasksUrl: appUrl('/weldflow/my-tasks'),
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
