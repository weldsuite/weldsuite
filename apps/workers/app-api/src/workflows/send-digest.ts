/**
 * SendDigestWorkflow — Cloudflare Workflow
 *
 * Per-user workflow that queries overdue/due-today/due-this-week tasks,
 * renders an HTML email, and sends it via Resend (or the Cloudflare send
 * binding as fallback).
 *
 * Triggered by the hourly digest sweep cron handler (src/cron/digest-sweep.ts).
 * Instance ID: `digest-${clerkOrgId}-${userId}-${YYYY-MM-DD}` for daily dedup.
 *
 * Ported from apps/api-worker/src/workflows/send-digest.ts (W4 legacy-worker
 * phase-out). Hosted in app-api under the NEW workflow names
 * `send-digest-v2[-dev/-test/-preview]`. The Resend call is inlined (raw
 * fetch, same request shape as @weldsuite/transactional-email) so app-api
 * doesn't grow a package dependency for one call.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull, lt, between, notInArray } from 'drizzle-orm';
import type { Env } from '../types';
import { getTenantDbForWorkspace, schema } from '../db';
import * as cfEmail from '../lib/cloudflare-email';

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

// ── Resend (inline fetch client, mirrors @weldsuite/transactional-email) ─

interface ResendSendParams {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

async function sendViaResend(apiKey: string, params: ResendSendParams): Promise<{ id: string }> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }

  return res.json() as Promise<{ id: string }>;
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

// ── Email Template ───────────────────────────────────────────────────────

function formatDate(date: Date | null): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(date));
}

function priorityColor(priority: string): string {
  switch (priority) {
    case 'critical': return '#dc2626';
    case 'high': return '#ea580c';
    case 'medium': return '#ca8a04';
    case 'low': return '#2563eb';
    default: return '#6b7280';
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTaskRow(t: DigestTask): string {
  const project = t.projectName
    ? `<span style="color:#6b7280;font-size:12px;"> &middot; ${escapeHtml(t.projectName)}</span>`
    : t.type === 'personal'
      ? `<span style="color:#6b7280;font-size:12px;"> &middot; Personal</span>`
      : '';

  return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${priorityColor(t.priority)};margin-right:8px;vertical-align:middle;"></span>
        <span style="font-size:14px;color:#1e293b;">${escapeHtml(t.title)}</span>
        ${project}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-size:13px;color:#64748b;white-space:nowrap;">
        ${formatDate(t.dueDate)}
      </td>
    </tr>`;
}

function renderSection(title: string, tasks: DigestTask[], accentColor: string, badgeColor: string): string {
  if (tasks.length === 0) return '';
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td colspan="2" style="padding:0 0 8px 0;">
          <span style="font-size:15px;font-weight:600;color:${accentColor};">${title}</span>
          <span style="display:inline-block;background:${badgeColor};color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:8px;">${tasks.length}</span>
        </td>
      </tr>
      ${tasks.map(renderTaskRow).join('')}
    </table>`;
}

function buildDigestHtml(params: {
  firstName: string;
  dateStr: string;
  overdue: DigestTask[];
  dueToday: DigestTask[];
  dueThisWeek: DigestTask[];
  workspaceName: string;
  logoUrl: string | null;
  primaryColor: string;
  platformUrl: string;
}): string {
  const { firstName, dateStr, overdue, dueToday, dueThisWeek, workspaceName, logoUrl, primaryColor, platformUrl } = params;

  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(workspaceName)}" style="max-height:32px;max-width:160px;" />`
    : `<span style="font-size:18px;font-weight:700;color:${primaryColor};">${escapeHtml(workspaceName)}</span>`;

  const sectionsHtml = [
    renderSection('Overdue', overdue, '#dc2626', '#dc2626'),
    renderSection('Due Today', dueToday, '#d97706', '#d97706'),
    renderSection('This Week', dueThisWeek, '#2563eb', '#2563eb'),
  ].join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="padding:24px 32px;border-bottom:1px solid #e2e8f0;">${logoHtml}</td></tr>
        <tr><td style="padding:24px 32px 8px;">
          <h1 style="margin:0;font-size:20px;font-weight:600;color:#0f172a;">Daily Task Digest</h1>
          <p style="margin:4px 0 0;font-size:13px;color:#94a3b8;">${escapeHtml(dateStr)}</p>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;">
          <p style="margin:0;font-size:15px;color:#334155;">Hi ${escapeHtml(firstName)},</p>
          <p style="margin:8px 0 0;font-size:14px;color:#64748b;">Here&rsquo;s a summary of your upcoming and overdue tasks.</p>
        </td></tr>
        <tr><td style="padding:0 32px 16px;">${sectionsHtml}</td></tr>
        <tr><td style="padding:8px 32px 32px;" align="center">
          <a href="${escapeHtml(platformUrl)}/task" style="display:inline-block;background:${primaryColor};color:#fff;font-size:14px;font-weight:600;padding:10px 28px;border-radius:8px;text-decoration:none;">View All Tasks</a>
        </td></tr>
        <tr><td style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#94a3b8;text-align:center;">
            You&rsquo;re receiving this as a member of ${escapeHtml(workspaceName)}.
            <a href="${escapeHtml(platformUrl)}/settings/notifications" style="color:${primaryColor};text-decoration:underline;">Manage in Settings</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
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

// ── Workflow ─────────────────────────────────────────────────────────────

export class SendDigestWorkflow extends WorkflowEntrypoint<Env, SendDigestParams> {
  async run(event: WorkflowEvent<SendDigestParams>, step: WorkflowStep) {
    const { workspaceId, userId, email, name, timezone } = event.payload;

    // Step 1: Query tasks and render email HTML
    const emailData = await step.do('query-and-render', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);

      // Get workspace branding
      const [wsSettings] = await db
        .select({
          timezone: schema.workspaceSettings.timezone,
          logoUrl: schema.workspaceSettings.logoUrl,
          tradingName: schema.workspaceSettings.tradingName,
          primaryColor: schema.workspaceSettings.primaryColor,
        })
        .from(schema.workspaceSettings)
        .limit(1);

      const wsTimezone = wsSettings?.timezone || timezone || 'UTC';
      const workspaceName = wsSettings?.tradingName || 'WeldSuite';
      const logoUrl = wsSettings?.logoUrl || null;
      const primaryColor = wsSettings?.primaryColor || '#2563eb';
      const platformUrl = getPlatformUrl(this.env.ENVIRONMENT);

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
        return { skip: true } as const;
      }

      const dateStr = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: wsTimezone,
      }).format(new Date());

      const firstName = name.split(' ')[0];
      const html = buildDigestHtml({ firstName, dateStr, overdue, dueToday, dueThisWeek, workspaceName, logoUrl, primaryColor, platformUrl });

      const subject = `Daily Task Digest — ${overdue.length > 0 ? `${overdue.length} overdue` : `${totalTasks} tasks`}`;
      const from = `${workspaceName} <digest@mail.weldsuite.org>`;
      const unsubscribeUrl = `${platformUrl}/settings/notifications`;

      return {
        skip: false as const,
        html,
        subject,
        from,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        totalTasks,
      };
    });

    // Step 2: Send the email
    if (emailData.skip) return;

    await step.do('send-email', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const params = {
        from: emailData.from,
        to: [email],
        subject: emailData.subject,
        html: emailData.html,
        headers: emailData.headers,
      };

      if (this.env.RESEND_API_KEY) {
        const result = await sendViaResend(this.env.RESEND_API_KEY, params);
        console.log(`[Digest] Sent to ${email} via Resend: ${result.id}`);
        return { provider: 'resend', messageId: result.id };
      } else {
        const result = await cfEmail.sendEmail(this.env, params);
        console.log(`[Digest] Sent to ${email} via Cloudflare send binding: ${result.messageId}`);
        return { provider: 'cloudflare', messageId: result.messageId };
      }
    });
  }
}
