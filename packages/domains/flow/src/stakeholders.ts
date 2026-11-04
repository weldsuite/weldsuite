/**
 * Stakeholder register rules: who a stakeholder is (a member or a CRM
 * contact, never both), the RACI checks, the portal address and the shapes a
 * stakeholder takes on the wire and in entity events (design:
 * weldflow-delivery-and-portfolio.md, ADR FLOW-020).
 *
 * Pure functions, no database and no Hono context. The flow-api
 * `/api/project-stakeholders` routes use them, and the Rust flow-domain
 * mirrors them (rust/crates/flow-domain/src/stakeholders.rs). Every message
 * returned here is sent to the client as it is, so the two backends answer alike.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import type {
  RaciAssignment,
  RaciSubjectType,
  Stakeholder,
} from '@weldsuite/app-api-client/schemas/project-reporting';

type StakeholderRow = typeof schema.projectStakeholders.$inferSelect;

// ── Messages ────────────────────────────────────────────────────────────────

export const IDENTITY_REQUIRED = 'Provide either memberId or crmContactId';
export const IDENTITY_ONE_ONLY = 'Provide either memberId or crmContactId, not both';
export const MEMBER_NOT_FOUND = 'Member not found';
export const CONTACT_NOT_FOUND = 'Contact not found';
export const ALREADY_STAKEHOLDER = 'This person is already a stakeholder of the project';
export const NOT_A_CONTACT = 'Only a CRM contact can be given portal access';
export const CONTACT_WITHOUT_EMAIL = 'The contact has no email address';
export const DELIVERABLE_NOT_FOUND = 'Deliverable not found';
export const STAKEHOLDER_NOT_IN_PROJECT = 'Stakeholder not found in this project';
export const SUBJECT_ID_REQUIRED = 'subjectId is required for a deliverable';
export const SUBJECT_ID_NOT_ALLOWED = 'subjectId is only for a deliverable';
export const ONE_ACCOUNTABLE = 'A subject can have only one accountable (A)';
export const DUPLICATE_ASSIGNMENT = 'A stakeholder can have a letter only once per subject';

// ── Identity ────────────────────────────────────────────────────────────────

/** The 400 message when a body names both or neither of the member and the contact, else null. */
export function identityError(memberId: string | null | undefined, crmContactId: string | null | undefined): string | null {
  const hasMember = !!memberId;
  const hasContact = !!crmContactId;
  if (hasMember && hasContact) return IDENTITY_ONE_ONLY;
  if (!hasMember && !hasContact) return IDENTITY_REQUIRED;
  return null;
}

// ── RACI ────────────────────────────────────────────────────────────────────

/** The 400 message when `subjectId` does not fit `subjectType` (a deliverable has one, the others none), else null. */
export function raciSubjectError(subjectType: RaciSubjectType, subjectId: string | null | undefined): string | null {
  if (subjectType === 'deliverable') return subjectId ? null : SUBJECT_ID_REQUIRED;
  return subjectId ? SUBJECT_ID_NOT_ALLOWED : null;
}

/**
 * The 400 message when a subject's assignments break a rule: a stakeholder
 * with the same letter twice, or more than one `A`. Checked in the order of
 * the list, the duplicate first.
 */
export function raciAssignmentsError(assignments: readonly RaciAssignment[]): string | null {
  const seen = new Set<string>();
  for (const assignment of assignments) {
    const key = `${assignment.stakeholderId}:${assignment.letter}`;
    if (seen.has(key)) return DUPLICATE_ASSIGNMENT;
    seen.add(key);
  }
  return assignments.filter((assignment) => assignment.letter === 'A').length > 1 ? ONE_ACCOUNTABLE : null;
}

const LETTER_ORDER = ['A', 'R', 'C', 'I'] as const;

/** Assignments in a fixed order: by letter (A, R, C, I), then by the order the stakeholders were given. */
export function sortAssignments(assignments: readonly RaciAssignment[], stakeholderOrder: readonly string[]): RaciAssignment[] {
  const position = (id: string) => {
    const index = stakeholderOrder.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...assignments].sort(
    (a, b) =>
      position(a.stakeholderId) - position(b.stakeholderId) ||
      LETTER_ORDER.indexOf(a.letter) - LETTER_ORDER.indexOf(b.letter),
  );
}

/** The stakeholders whose letters on a subject differ between two lists (changed, added or removed). */
export function changedStakeholders(before: readonly RaciAssignment[], after: readonly RaciAssignment[]): string[] {
  const lettersOf = (list: readonly RaciAssignment[], id: string) =>
    list
      .filter((assignment) => assignment.stakeholderId === id)
      .map((assignment) => assignment.letter)
      .sort()
      .join('');
  const ids: string[] = [];
  for (const assignment of [...before, ...after]) {
    if (!ids.includes(assignment.stakeholderId)) ids.push(assignment.stakeholderId);
  }
  return ids.filter((id) => lettersOf(before, id) !== lettersOf(after, id));
}

// ── Portal ──────────────────────────────────────────────────────────────────

function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end -= 1;
  return text.slice(0, end);
}

/**
 * Where a contact opens a project in the client portal:
 * `<PROJECT_PORTAL_URL>/<workspace slug>/projects/<project>`. The portal routes by
 * `workspaces.slug` (`ws_…` ids are 404s there). It asks for
 * the contact's email and sends the one-time code (FLOW-020).
 */
export function projectPortalUrl(base: string, workspaceSlug: string, projectId: string): string {
  return `${trimTrailingSlashes(base)}/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}`;
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** The name and email a stakeholder shows under: the member's or the contact's, null when the person is gone. */
export interface StakeholderIdentity {
  name: string | null;
  email: string | null;
}

export function presentStakeholder(row: StakeholderRow, identity: StakeholderIdentity): Stakeholder {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.memberId ? 'member' : 'contact',
    memberId: row.memberId ?? null,
    crmContactId: row.crmContactId ?? null,
    name: identity.name,
    email: identity.email,
    organisation: row.organisation ?? null,
    role: row.role ?? null,
    influence: row.influence,
    interest: row.interest,
    attitude: row.attitude,
    engagement: row.engagement,
    notes: row.notes ?? null,
    lastContactAt: iso(row.lastContactAt),
    portalAccess: row.portalAccess,
    portalInvitedAt: iso(row.portalInvitedAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What an entity event of a stakeholder carries (no name or email: the event bus feeds analytics and agents). */
export function stakeholderEventData(row: StakeholderRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.memberId ? 'member' : 'contact',
    memberId: row.memberId ?? null,
    crmContactId: row.crmContactId ?? null,
    organisation: row.organisation ?? null,
    role: row.role ?? null,
    influence: row.influence,
    interest: row.interest,
    attitude: row.attitude,
    engagement: row.engagement,
    portalAccess: row.portalAccess,
  };
}
