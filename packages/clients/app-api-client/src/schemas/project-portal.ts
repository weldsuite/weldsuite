/**
 * WeldFlow client portal: the request schemas and the shapes of
 * `/public/project-portal` (flow-api and its Rust port), which the portal app
 * (`apps/web/project-portal`) calls. Design: weldsuite-documentation
 * `design/modules/weldflow-delivery-and-portfolio.md` ("Client portal"), ADR
 * FLOW-020.
 *
 * Who is asking: a CRM contact (`people`) who is a project stakeholder with
 * `portal_access`, signed in by an emailed code. Nothing here ever carries a
 * cost, a rate, a RAID item, an internal note or a member's email: every shape
 * below is an allowlist built field by field, never a table row.
 *
 * Request bodies are `.strict()`: an unknown field is a 400.
 */

import { z } from 'zod';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** The languages of the sign-in email (the portal's own texts: en and nl). */
export const PORTAL_LOCALES = ['en', 'nl'] as const;
export type PortalLocale = (typeof PORTAL_LOCALES)[number];

/** Digits in the emailed sign-in code. */
export const PORTAL_CODE_LENGTH = 6;

/** The answers a contact can give. `approved_with_conditions` is a member's answer, not offered here. */
export const PORTAL_DECISIONS = ['approved', 'rejected', 'info_requested'] as const;
export type PortalDecision = (typeof PORTAL_DECISIONS)[number];

/** The subjects an approval addressed to a contact can be about. */
export const PORTAL_APPROVAL_SUBJECTS = ['deliverable', 'change_request'] as const;
export type PortalApprovalSubject = (typeof PORTAL_APPROVAL_SUBJECTS)[number];

// ── Requests ────────────────────────────────────────────────────────────────

/** The workspace's slug, as the portal's URL carries it (`projects.weldsuite.org/<workspace>`). */
const workspaceSlug = z.string().trim().min(1).max(100);
const emailAddress = z.string().trim().email().max(255);

/** `POST /auth/request-code`: always answered with 204, whether or not the address may sign in. */
export const requestPortalCodeSchema = z
  .object({
    workspace: workspaceSlug,
    email: emailAddress,
    /** Language of the email; English when left out. */
    locale: z.enum(PORTAL_LOCALES).optional(),
  })
  .strict();
export type RequestPortalCodeInput = z.infer<typeof requestPortalCodeSchema>;

/** `POST /auth/verify`. */
export const verifyPortalCodeSchema = z
  .object({
    workspace: workspaceSlug,
    email: emailAddress,
    code: z
      .string()
      .trim()
      .regex(new RegExp(`^[0-9]{${PORTAL_CODE_LENGTH}}$`), `The code is ${PORTAL_CODE_LENGTH} digits`),
  })
  .strict();
export type VerifyPortalCodeInput = z.infer<typeof verifyPortalCodeSchema>;

/** `POST /projects/:id/messages`. */
export const postPortalMessageSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
  })
  .strict();
export type PostPortalMessageInput = z.infer<typeof postPortalMessageSchema>;

/**
 * `POST /approvals/:id/decide`. Declining needs a note (the approvals core
 * answers 400 without one); a question (`info_requested`) is the note.
 */
export const decidePortalApprovalSchema = z
  .object({
    decision: z.enum(PORTAL_DECISIONS),
    note: z.string().trim().max(2000).nullish(),
  })
  .strict();
export type DecidePortalApprovalInput = z.infer<typeof decidePortalApprovalSchema>;

/** The `limit` and `cursor` of a paged list (`GET /projects/:id/{reports,files,documents,messages}`). */
export interface PortalPageQuery {
  /** 1 to 100, 25 by default. */
  limit?: number;
  /** The `pagination.cursor` of the previous page. */
  cursor?: string;
}

// ── Responses ───────────────────────────────────────────────────────────────

/** A signed-in person: the CRM contact. The email is their own. */
export interface PortalContact {
  id: string;
  name: string;
  email: string;
}

export interface PortalWorkspace {
  slug: string;
  /** The workspace's name; the slug when it is not known. */
  name: string;
}

/** `POST /auth/verify`. */
export interface PortalSignIn {
  /** The session token: send it as `Authorization: Bearer <token>`. Lives 30 days from the last use. */
  token: string;
  /** When the session lapses if it is not used again (ISO). */
  expiresAt: string;
  contact: PortalContact;
  workspace: PortalWorkspace;
}

/** `GET /me`. */
export interface PortalMe {
  contact: PortalContact;
  workspace: PortalWorkspace;
}

export interface PortalMilestone {
  id: string;
  name: string;
  /** ISO. */
  dueDate: string;
  completed: boolean;
}

/** The next milestone: the earliest one that is not completed. */
export interface PortalNextMilestone {
  id: string;
  name: string;
  description: string | null;
  dueDate: string;
}

/** One project in the contact's list. */
export interface PortalProjectSummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  /** 0 to 100. */
  progress: number;
  startDate: string | null;
  /** The planned end of the project. */
  goLive: string | null;
  /** The project manager's name, never their email. */
  projectManagerName: string | null;
  nextMilestone: PortalNextMilestone | null;
  /** Approvals addressed to this contact on this project, still waiting for them. */
  waitingForYou: number;
  updatedAt: string;
}

export const PORTAL_STATUS_COLOURS = ['green', 'amber', 'red', 'grey'] as const;
export type PortalStatusColour = (typeof PORTAL_STATUS_COLOURS)[number];

export interface PortalReportArea {
  /** `schedule`, `budget`, `scope`, `risk` or `benefits`. */
  key: string;
  colour: PortalStatusColour;
}

/** A published status report marked client visible, as published (never live data). */
export interface PortalReport {
  id: string;
  /** An ISO week (`2026-W45`) or a month (`2026-11`). */
  period: string;
  publishedAt: string;
  publishedByName: string | null;
  overall: PortalStatusColour | null;
  /** Colours only; the reasons behind them stay with the team. */
  areas: PortalReportArea[];
  summary: string | null;
  done: string[];
  next: string[];
}

export interface PortalDeliverable {
  id: string;
  /** `D1`. */
  code: string;
  title: string;
  /** `not_started`, `in_progress`, `accepted` or `rejected`. */
  status: string;
  plannedEnd: string | null;
  acceptedAt: string | null;
}

export interface PortalChangeRequest {
  id: string;
  /** `CR-8`. */
  code: string;
  title: string;
  status: string;
  /** What the change costs, a decimal string in `currency`. */
  costDelta: string | null;
  currency: string | null;
  /** Working days. */
  scheduleDeltaDays: number | null;
  decidedAt: string | null;
}

/** `GET /projects/:id`. */
export interface PortalProject extends PortalProjectSummary {
  milestones: PortalMilestone[];
  /** Client visible deliverables only. */
  deliverables: PortalDeliverable[];
  /** Client visible change requests only. */
  changeRequests: PortalChangeRequest[];
  /** The newest published, client visible status report. */
  latestReport: PortalReport | null;
}

export interface PortalAcceptanceCriterion {
  text: string;
  met: boolean;
}

/** What a change request does to the project, as it is put to the client. */
export interface PortalChangeImpact {
  costDelta: string | null;
  currency: string | null;
  scheduleDeltaDays: number | null;
  /** The go-live the change moves the project to (ISO), when it moves it. */
  newGoLive: string | null;
}

/** One review waiting for the contact (`GET /approvals`). */
export interface PortalApproval {
  id: string;
  projectId: string;
  projectName: string;
  subjectType: PortalApprovalSubject;
  subjectId: string;
  /** `D1` or `CR-8`. */
  code: string;
  title: string;
  description: string | null;
  roleLabel: string | null;
  /** The sign-off step; a later step waits for the earlier one. */
  step: number;
  dueAt: string | null;
  /** When the review was asked for (ISO). */
  requestedAt: string;
  /** The team member who asked, by name. */
  requestedByName: string | null;
  /** True when its earlier steps are answered, so the contact can answer now. */
  actionable: boolean;
  /** Deliverables only; empty for a change request. */
  acceptanceCriteria: PortalAcceptanceCriterion[];
  /** Change requests only. */
  impact: PortalChangeImpact | null;
}

/** `POST /approvals/:id/decide`. */
export interface PortalDecisionResult {
  id: string;
  decision: string;
  note: string | null;
  decidedAt: string | null;
  /** What the subject's reviews add up to now. */
  outcome: 'approved' | 'rejected' | 'pending';
  /** True when this answer settled the subject. */
  resolved: boolean;
}

export interface PortalMessage {
  id: string;
  projectId: string;
  /** The sender's name; "Project team" when it is not known. */
  senderName: string;
  /** Sent by a client contact (in the portal) rather than by the team. */
  fromClient: boolean;
  /** Sent by the signed-in contact. */
  mine: boolean;
  message: string;
  createdAt: string;
  editedAt: string | null;
}

export interface PortalFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  uploadedByName: string | null;
  createdAt: string;
}

export interface PortalDocument {
  id: string;
  /** Without the `.docx` suffix. */
  name: string;
  createdAt: string;
  updatedAt: string;
}
