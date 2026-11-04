/**
 * Client portal rules (design: weldflow-delivery-and-portfolio.md, "Client
 * portal"; ADR FLOW-020): the sign-in constants, the KV records and keys, and
 * the allowlisted shapes the portal answers with.
 *
 * Pure functions, no database and no Hono context. flow-api's
 * `/public/project-portal` routes use them and the Rust flow-domain mirrors
 * them. Every message returned here is sent to the client as it is, so the two
 * backends answer alike.
 *
 * The presenters build each shape field by field. A table row is never passed
 * through: that is what keeps costs, rates, RAID items, internal notes and
 * members' emails out of the portal.
 */

import type {
  PortalAcceptanceCriterion,
  PortalApproval,
  PortalApprovalSubject,
  PortalChangeImpact,
  PortalChangeRequest,
  PortalDeliverable,
  PortalDocument,
  PortalFile,
  PortalMessage,
  PortalMilestone,
  PortalNextMilestone,
  PortalReport,
  PortalStatusColour,
} from '@weldsuite/app-api-client/schemas/project-portal';
import { PORTAL_APPROVAL_SUBJECTS, PORTAL_STATUS_COLOURS } from '@weldsuite/app-api-client/schemas/project-portal';
import { compareText } from './compare';

// ── Sign-in ─────────────────────────────────────────────────────────────────

/** A sign-in code lives 15 minutes. */
export const PORTAL_CODE_TTL_SECONDS = 15 * 60;
/** A session lives 30 days from its last use. */
export const PORTAL_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** The session record is written again (a new TTL) when it was last used more than a day ago. */
export const PORTAL_SESSION_REFRESH_AFTER_SECONDS = 24 * 60 * 60;
/** Wrong guesses a code survives before it is thrown away. */
export const PORTAL_MAX_VERIFY_ATTEMPTS = 8;
/** Code requests per 15 minutes, per address and per workspace across all addresses. */
export const PORTAL_REQUEST_LIMIT_EMAIL = 5;
export const PORTAL_REQUEST_LIMIT_WORKSPACE = 200;
export const PORTAL_REQUEST_WINDOW_SECONDS = 15 * 60;
/** Failed verifies per 15 minutes, per address and per workspace. A slot is reserved up front and given back on success. */
export const PORTAL_VERIFY_LIMIT_EMAIL = 20;
export const PORTAL_VERIFY_LIMIT_WORKSPACE = 200;
/** The workspace lookup by slug is cached this long. */
export const PORTAL_SLUG_TTL_SECONDS = 300;

/** The messages of every refusal, sent to the client as they are. */
export const PORTAL_MESSAGES = {
  invalidCode: 'Invalid or expired code',
  tooManyAttempts: 'Too many attempts, try again later',
  signInUnavailable: 'Sign-in is temporarily unavailable, try again shortly',
  signInRequired: 'Sign in required',
  sessionExpired: 'Session expired',
  accessRevoked: 'Access revoked',
  projectNotFound: 'Project not found',
  fileNotFound: 'File not found',
  documentNotFound: 'Document not found',
  approvalNotFound: 'Approval not found',
} as const;

/** The 6-digit code and the address, normalised, as they are compared. */
export function normalizePortalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What is stored for a code: a SHA-256 of the code salted with the workspace and
 * the address, so a leaked record cannot be searched for 6-digit codes with a
 * table that works for every workspace.
 */
export function portalCodeHash(workspaceId: string, email: string, code: string): Promise<string> {
  return sha256Hex(`${workspaceId}:${normalizePortalEmail(email)}:${code}`);
}

/** A pending sign-in code (KV, 15 minutes). */
export interface PortalChallenge {
  codeHash: string;
  email: string;
  workspaceId: string;
  /** The CRM contacts with this address that hold portal access (a duplicate contact has its own id). */
  contactIds: string[];
  attempts: number;
}

/** A signed-in session (KV, 30 days from the last use), keyed by the SHA-256 of its token. */
export interface PortalSessionRecord {
  workspaceId: string;
  /** The Clerk org id the tenant database is opened with; null when only `workspaces.id` is known. */
  clerkOrgId: string | null;
  workspaceSlug: string;
  workspaceName: string;
  email: string;
  contactIds: string[];
  /** ISO. */
  createdAt: string;
  /** ISO; moves forward when the record is written again. */
  lastSeenAt: string;
}

export function portalCodeKey(workspaceId: string, email: string): string {
  return `pportal:code:${workspaceId}:${normalizePortalEmail(email)}`;
}

export function portalSessionKey(tokenHash: string): string {
  return `pportal:sess:${tokenHash}`;
}

export function portalSlugKey(slug: string): string {
  return `pportal:slug:${slug}`;
}

/** The workspace lookup cached under {@link portalSlugKey}. */
export interface PortalSlugEntry {
  workspaceId: string;
  clerkOrgId: string;
  name: string;
}

/** True when the session was last written more than a day ago, so it should get a new TTL. */
export function sessionNeedsRefresh(lastSeenAt: string, now: Date): boolean {
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return true;
  return now.getTime() - seen > PORTAL_SESSION_REFRESH_AFTER_SECONDS * 1000;
}

/** When a session last used at `lastSeenAt` lapses (ISO). */
export function sessionExpiresAt(lastSeenAt: string): string {
  const seen = Date.parse(lastSeenAt);
  return new Date((Number.isNaN(seen) ? Date.now() : seen) + PORTAL_SESSION_TTL_SECONDS * 1000).toISOString();
}

// ── Visibility ──────────────────────────────────────────────────────────────

/** The subjects of approvals the portal shows (see {@link PORTAL_APPROVAL_SUBJECTS}). */
export function isPortalApprovalSubject(subjectType: string): subjectType is PortalApprovalSubject {
  return (PORTAL_APPROVAL_SUBJECTS as readonly string[]).includes(subjectType);
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

// ── Codes and names ─────────────────────────────────────────────────────────

/** `D1`. */
export function deliverableCode(number: number): string {
  return `D${number}`;
}

/** `CR-8`. */
export function changeRequestCode(number: number): string {
  return `CR-${number}`;
}

/** A document file's name without its `.docx` suffix. */
export function documentName(fileName: string): string {
  return fileName.toLowerCase().endsWith('.docx') ? fileName.slice(0, -'.docx'.length) : fileName;
}

/** The sender name shown when the sender is not a known member. */
export const PORTAL_TEAM_SENDER = 'Project team';

// ── Progress and milestones ─────────────────────────────────────────────────

/** A `numeric` progress as a number from 0 to 100; 0 when it is missing or not a number. */
export function progressPercent(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(value ?? '');
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

export const MILESTONE_COMPLETED_STATUS = 'completed';

export interface PortalMilestoneRow {
  id: string;
  name: string;
  description: string | null;
  dueDate: Date;
  status: string;
}

export function presentMilestone(row: PortalMilestoneRow): PortalMilestone {
  return {
    id: row.id,
    name: row.name,
    dueDate: row.dueDate.toISOString(),
    completed: row.status === MILESTONE_COMPLETED_STATUS,
  };
}

/**
 * The next milestone: the earliest one that is not completed, ties by id. An
 * overdue milestone that is still open counts, because it is what the project is
 * waiting for.
 */
export function nextMilestoneOf(rows: readonly PortalMilestoneRow[]): PortalNextMilestone | null {
  const open = rows
    .filter((row) => row.status !== MILESTONE_COMPLETED_STATUS)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || compareText(a.id, b.id));
  const next = open[0];
  return next ? { id: next.id, name: next.name, description: next.description, dueDate: next.dueDate.toISOString() } : null;
}

// ── Reports ─────────────────────────────────────────────────────────────────

export interface PortalReportRow {
  id: string;
  period: string;
  publishedAt: Date | null;
  overall: string | null;
  areas: ReadonlyArray<{ key: string; colour: string }> | null;
  summary: string | null;
  done: ReadonlyArray<{ text?: string | null }> | null;
  next: ReadonlyArray<{ text?: string | null }> | null;
}

function colourOf(value: string | null | undefined): PortalStatusColour | null {
  return value && (PORTAL_STATUS_COLOURS as readonly string[]).includes(value) ? (value as PortalStatusColour) : null;
}

function itemTexts(items: ReadonlyArray<{ text?: string | null }> | null): string[] {
  return (items ?? []).map((item) => (item.text ?? '').trim()).filter((text) => text.length > 0);
}

/**
 * A published report as the client sees it: the colours without the reasons
 * behind them, the summary, and the done and next lists as text. The report's
 * `snapshot` (risks, figures) is never read.
 */
export function presentReport(row: PortalReportRow, publishedByName: string | null): PortalReport {
  return {
    id: row.id,
    period: row.period,
    publishedAt: (row.publishedAt ?? new Date(0)).toISOString(),
    publishedByName,
    overall: colourOf(row.overall),
    areas: (row.areas ?? []).flatMap((area) => {
      const colour = colourOf(area.colour);
      return colour ? [{ key: area.key, colour }] : [];
    }),
    summary: row.summary,
    done: itemTexts(row.done),
    next: itemTexts(row.next),
  };
}

// ── Deliverables and changes ────────────────────────────────────────────────

export interface PortalDeliverableRow {
  id: string;
  number: number;
  title: string;
  status: string;
  plannedEnd: Date | null;
  acceptedAt: Date | null;
}

export function presentDeliverable(row: PortalDeliverableRow): PortalDeliverable {
  return {
    id: row.id,
    code: deliverableCode(row.number),
    title: row.title,
    status: row.status,
    plannedEnd: iso(row.plannedEnd),
    acceptedAt: iso(row.acceptedAt),
  };
}

export interface PortalChangeRequestRow {
  id: string;
  number: number;
  title: string;
  status: string;
  costDelta: string | null;
  scheduleDeltaDays: number | null;
  decidedAt: Date | null;
}

export function presentChangeRequest(row: PortalChangeRequestRow, currency: string | null): PortalChangeRequest {
  return {
    id: row.id,
    code: changeRequestCode(row.number),
    title: row.title,
    status: row.status,
    costDelta: row.costDelta,
    currency,
    scheduleDeltaDays: row.scheduleDeltaDays,
    decidedAt: iso(row.decidedAt),
  };
}

// ── Approvals ───────────────────────────────────────────────────────────────

export interface PortalApprovalRow {
  id: string;
  projectId: string | null;
  subjectType: string;
  subjectId: string;
  roleLabel: string | null;
  step: number;
  dueAt: Date | null;
  createdAt: Date;
}

export interface PortalApprovalDeliverable {
  number: number;
  title: string;
  description: string | null;
  acceptanceCriteria: ReadonlyArray<{ text: string; met: boolean }> | null;
}

export interface PortalApprovalChange {
  number: number;
  title: string;
  description: string | null;
  costDelta: string | null;
  scheduleDeltaDays: number | null;
  planChanges: { goLive?: string | null } | null;
}

/** One review as the portal shows it. Null when the subject is not one the portal shows. */
export function presentApproval(input: {
  approval: PortalApprovalRow;
  projectName: string;
  currency: string | null;
  requestedByName: string | null;
  actionable: boolean;
  deliverable?: PortalApprovalDeliverable | null;
  change?: PortalApprovalChange | null;
}): PortalApproval | null {
  const { approval } = input;
  if (!isPortalApprovalSubject(approval.subjectType) || !approval.projectId) return null;
  const base = {
    id: approval.id,
    projectId: approval.projectId,
    projectName: input.projectName,
    subjectType: approval.subjectType,
    subjectId: approval.subjectId,
    roleLabel: approval.roleLabel,
    step: approval.step,
    dueAt: iso(approval.dueAt),
    requestedAt: approval.createdAt.toISOString(),
    requestedByName: input.requestedByName,
    actionable: input.actionable,
  };
  if (approval.subjectType === 'deliverable') {
    const deliverable = input.deliverable;
    if (!deliverable) return null;
    const criteria: PortalAcceptanceCriterion[] = (deliverable.acceptanceCriteria ?? []).map((c) => ({
      text: c.text,
      met: c.met === true,
    }));
    return {
      ...base,
      code: deliverableCode(deliverable.number),
      title: deliverable.title,
      description: deliverable.description,
      acceptanceCriteria: criteria,
      impact: null,
    };
  }
  const change = input.change;
  if (!change) return null;
  const impact: PortalChangeImpact = {
    costDelta: change.costDelta,
    currency: input.currency,
    scheduleDeltaDays: change.scheduleDeltaDays,
    newGoLive: change.planChanges?.goLive ?? null,
  };
  return {
    ...base,
    code: changeRequestCode(change.number),
    title: change.title,
    description: change.description,
    acceptanceCriteria: [],
    impact,
  };
}

// ── Messages, files, documents ──────────────────────────────────────────────

/** Where a message came from, in `project_messages.metadata`. */
export interface PortalMessageMetadata {
  source?: string;
  contactId?: string;
  contactName?: string;
}

export const PORTAL_MESSAGE_SOURCE = 'portal';

/** The metadata of a message a client wrote in the portal. */
export function portalMessageMetadata(contactId: string, contactName: string): PortalMessageMetadata {
  return { source: PORTAL_MESSAGE_SOURCE, contactId, contactName };
}

export interface PortalMessageRow {
  id: string;
  projectId: string | null;
  senderId: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  editedAt: Date | null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * A message of the thread. A client's message carries its sender in `metadata`
 * (`source: 'portal'`); a team member's is named from `memberNames` (member user
 * id to name), and never shows more than the name.
 */
export function presentMessage(
  row: PortalMessageRow,
  memberNames: ReadonlyMap<string, string>,
  contactIds: readonly string[],
): PortalMessage {
  const fromClient = row.metadata?.source === PORTAL_MESSAGE_SOURCE;
  const contactId = textOf(row.metadata?.contactId);
  const senderName = fromClient
    ? (textOf(row.metadata?.contactName) ?? PORTAL_TEAM_SENDER)
    : (memberNames.get(row.senderId) ?? PORTAL_TEAM_SENDER);
  return {
    id: row.id,
    projectId: row.projectId ?? '',
    senderName,
    fromClient,
    mine: fromClient && contactId !== null && contactIds.includes(contactId),
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    editedAt: iso(row.editedAt),
  };
}

export interface PortalFileRow {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedById: string | null;
  createdAt: Date;
}

export function presentFile(row: PortalFileRow, memberNames: ReadonlyMap<string, string>): PortalFile {
  return {
    id: row.id,
    name: row.fileName,
    mimeType: row.mimeType,
    size: row.fileSize,
    uploadedByName: row.uploadedById ? (memberNames.get(row.uploadedById) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface PortalDocumentRow {
  id: string;
  fileName: string;
  createdAt: Date;
  updatedAt: Date;
}

export function presentDocument(row: PortalDocumentRow): PortalDocument {
  return {
    id: row.id,
    name: documentName(row.fileName),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The `Content-Disposition` of a download: always an attachment, with the name in both forms. */
export function attachmentDisposition(fileName: string, fallbackId: string): string {
  const safe = (fileName || `file-${fallbackId}`).replaceAll('"', '');
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
