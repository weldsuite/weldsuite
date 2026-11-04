/**
 * Notifications of the status reports and the stakeholder portal (design:
 * weldflow-delivery-and-portfolio.md, ADR FLOW-018 and FLOW-020).
 *
 *  - A published report goes to its recipients: a member gets an in-app
 *    notification and the `flow.status-report` email (as their channel
 *    preferences allow, through `@weldsuite/notifications`); a client contact
 *    gets the email directly, only when the report is shared with clients
 *    (`client_visible`) and the contact has portal access.
 *  - The `status_report_due` sweep tells the project manager a draft is ready.
 *  - Inviting a contact to the portal sends `flow.portal-invitation`.
 *
 * Every function is best-effort for the caller (the routes run them after the
 * response, on `waitUntil`): a failure is logged here and never thrown.
 */

import { inArray } from 'drizzle-orm';
import { createAndDeliverNotification } from '@weldsuite/notifications';
import { getMasterDb, masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';
import {
  periodLabel,
  resolveEmailLocale,
  sendPortalInvitationEmail,
  sendStatusReportEmail,
  workspaceAppUrl,
} from '@weldsuite/flow-domain/report-mail';
import { projectPortalUrl } from '@weldsuite/flow-domain/stakeholders';
import type { RecipientCandidate } from '@weldsuite/flow-domain/status-report';
import type { Env } from '../types';
import { memberIdentities } from '../services/stakeholders';
import type { ReportProject, StatusReportRow } from '../services/status-reports';

export interface NotifyContext {
  env: Env;
  db: Database;
  /** `workspaces.id`. */
  workspaceId: string;
  /** The Clerk org id: where in-app notifications and app links go. */
  clerkOrgId: string;
  /** Who did it (the publisher, the inviter); null for the sweep. */
  actorId: string | null;
}

/** Where a member opens a report in the app. */
export function reportAppPath(projectId: string, reportId: string): string {
  return `/weldflow/project/${projectId}/governance?report=${reportId}`;
}

async function workspaceNameOf(ctx: NotifyContext): Promise<string | null> {
  try {
    const masterDb = getMasterDb(ctx.env);
    const [row] = await masterDb
      .select({ name: masterSchema.workspaces.name })
      .from(masterSchema.workspaces)
      .where(matchWorkspaceRef(ctx.workspaceId))
      .limit(1);
    return row?.name ?? null;
  } catch {
    return null;
  }
}

async function contactLanguages(db: Database, contactIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (contactIds.length === 0) return out;
  const rows = await db
    .select({ id: schema.people.id, language: schema.people.preferredLanguage })
    .from(schema.people)
    .where(inArray(schema.people.id, contactIds));
  for (const row of rows) out.set(row.id, row.language ?? null);
  return out;
}

/** What a send did: how many people it reached, and how many it left out. */
export interface SendOutcome {
  sent: number;
  skipped: number;
}

/**
 * Send a published report. `contactIds` maps a stakeholder id to the CRM
 * contact behind it, for the targets that are not members.
 */
/** What the delivery of one published report shares between its recipients. */
interface ReportDelivery {
  ctx: NotifyContext;
  report: StatusReportRow;
  project: ReportProject;
  overall: 'green' | 'amber' | 'red';
  summary: string;
  publisherName: string | null;
  appBase: string;
  portalBase: string;
  workspaceName: string | null;
  languages: Map<string, string | null>;
  contactIds: Map<string, string>;
}

/** A member: the app, an in-app notification plus the email their preferences allow. */
async function notifyMember(d: ReportDelivery, target: RecipientCandidate & { userId: string }): Promise<'sent' | 'skipped'> {
  const { ctx, report, project, overall } = d;
  if (target.userId === ctx.actorId) return 'skipped';
  const locale = resolveEmailLocale();
  const path = reportAppPath(project.id, report.id);
  await createAndDeliverNotification({
    db: ctx.db,
    env: ctx.env,
    workspaceId: ctx.clerkOrgId,
    userId: target.userId,
    title: `Status report: ${project.name}`,
    body: `${periodLabel(locale, report.period)}: ${overall}`,
    category: 'projects',
    notificationType: 'project_updated',
    entityType: 'project_status_report',
    entityId: report.id,
    actionUrl: path,
    severity: 'info',
    actorType: ctx.actorId ? 'user' : 'system',
    actorId: ctx.actorId,
    email: {
      template: 'flow.status-report',
      props: {
        recipientName: target.name,
        projectName: project.name,
        periodLabel: periodLabel(locale, report.period),
        overall,
        summary: d.summary,
        publishedBy: d.publisherName,
        url: d.appBase ? workspaceAppUrl(d.appBase, ctx.clerkOrgId, path) : path,
      },
    },
  });
  return 'sent';
}

/** A client contact: only a report shared with clients, only with portal access and an address. */
async function mailContact(d: ReportDelivery, target: RecipientCandidate): Promise<'sent' | 'skipped'> {
  const { ctx, report, project, overall } = d;
  if (!report.clientVisible || !target.portalAccess || !target.email || !d.portalBase) return 'skipped';
  const contactId = target.stakeholderId ? d.contactIds.get(target.stakeholderId) : undefined;
  const locale = resolveEmailLocale(contactId ? d.languages.get(contactId) : null);
  const mailed = await sendStatusReportEmail(ctx.env, {
    to: target.email,
    locale,
    brand: { kind: 'workspace', name: d.workspaceName ?? 'WeldSuite' },
    props: {
      recipientName: target.name,
      projectName: project.name,
      periodLabel: periodLabel(locale, report.period),
      overall,
      summary: d.summary,
      publishedBy: d.publisherName,
      url: projectPortalUrl(d.portalBase, ctx.workspaceId, project.id),
    },
  });
  return mailed ? 'sent' : 'skipped';
}

export async function sendPublishedReport(
  ctx: NotifyContext,
  input: {
    report: StatusReportRow;
    project: ReportProject;
    targets: RecipientCandidate[];
    contactIds: Map<string, string>;
  },
): Promise<SendOutcome> {
  const { report, project, targets } = input;
  const outcome: SendOutcome = { sent: 0, skipped: 0 };
  const overall = report.overall;
  if (overall !== 'green' && overall !== 'amber' && overall !== 'red') return outcome;
  const publisher = report.publishedBy ? (await memberIdentities(ctx.db, [report.publishedBy])).get(report.publishedBy) : undefined;
  const delivery: ReportDelivery = {
    ctx,
    report,
    project,
    overall,
    summary: report.summary ?? '',
    publisherName: publisher?.name ?? null,
    appBase: ctx.env.PUBLIC_APP_URL ?? '',
    portalBase: ctx.env.PROJECT_PORTAL_URL ?? '',
    workspaceName: await workspaceNameOf(ctx),
    languages: await contactLanguages(ctx.db, [...input.contactIds.values()]),
    contactIds: input.contactIds,
  };

  for (const target of targets) {
    try {
      const result = target.userId ? await notifyMember(delivery, { ...target, userId: target.userId }) : await mailContact(delivery, target);
      outcome[result] += 1;
    } catch (err) {
      outcome.skipped += 1;
      console.error('[flow-api/status-reports] sending the report failed:', err);
    }
  }
  return outcome;
}

/** Tell the project manager a draft is ready for review (the sweep). */
export async function notifyDraftReady(
  ctx: NotifyContext,
  input: { report: StatusReportRow; project: ReportProject },
): Promise<boolean> {
  const managerId = input.project.projectManagerId;
  if (!managerId) return false;
  try {
    const locale = resolveEmailLocale();
    await createAndDeliverNotification({
      db: ctx.db,
      env: ctx.env,
      workspaceId: ctx.clerkOrgId,
      userId: managerId,
      title: `Status report ready to review: ${input.project.name}`,
      body: `The draft for ${periodLabel(locale, input.report.period)} is ready.`,
      category: 'projects',
      notificationType: 'project_updated',
      entityType: 'project_status_report',
      entityId: input.report.id,
      actionUrl: reportAppPath(input.project.id, input.report.id),
      severity: 'info',
      actorType: 'system',
      actorId: null,
    });
    return true;
  } catch (err) {
    console.error('[flow-api/status-reports] notifying the project manager failed:', err);
    return false;
  }
}

/** Send a contact the portal invitation. Returns whether the mail went out. */
export async function sendPortalInvitation(
  ctx: NotifyContext,
  input: { project: ReportProject; contact: { id: string; name: string | null; email: string }; inviterName: string | null },
): Promise<boolean> {
  const portalBase = ctx.env.PROJECT_PORTAL_URL;
  if (!portalBase) {
    console.warn('[flow-api/stakeholders] PROJECT_PORTAL_URL is not set, skipping the portal invitation');
    return false;
  }
  try {
    const languages = await contactLanguages(ctx.db, [input.contact.id]);
    const locale = resolveEmailLocale(languages.get(input.contact.id));
    const workspaceName = (await workspaceNameOf(ctx)) ?? 'WeldSuite';
    return await sendPortalInvitationEmail(ctx.env, {
      to: input.contact.email,
      locale,
      brand: { kind: 'workspace', name: workspaceName },
      props: {
        contactName: input.contact.name,
        projectName: input.project.name,
        invitedBy: input.inviterName,
        workspaceName,
        url: projectPortalUrl(portalBase, ctx.workspaceId, input.project.id),
      },
    });
  } catch (err) {
    console.error('[flow-api/stakeholders] sending the portal invitation failed:', err);
    return false;
  }
}
