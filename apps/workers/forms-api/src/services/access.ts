/**
 * Who may see and change a form (weldsuite-documentation/plans/weldforms.md, "Permissions").
 *
 * Two layers. The workspace permissions (`forms:*`, `form_responses:*`) say
 * what a member may do at all; a **restricted** form then narrows that to its
 * owner, its access list and `forms:manage`. A restricted form that a member
 * cannot see is a 404, never a 403: its existence is not for them.
 *
 * `form_responses:*` stays apart from `forms:*` on purpose: someone can see
 * forms and counts without reading answers.
 */

import { and, eq } from 'drizzle-orm';
import { hasContextPermission } from '@weldsuite/permissions/server';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Context } from 'hono';
import type { FormAccessRole, FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { notFound } from '../lib/errors';

const { forms, formAccess } = schema;
type FormRow = typeof forms.$inferSelect;

/** What the member's workspace permissions allow, whichever form it is. */
export interface MemberGrants {
  read: boolean;
  update: boolean;
  delete: boolean;
  publish: boolean;
  send: boolean;
  manage: boolean;
  responsesRead: boolean;
  responsesExport: boolean;
  responsesDelete: boolean;
}

export async function resolveGrants(c: Context): Promise<MemberGrants> {
  const [read, update, del, publish, send, manage, responsesRead, responsesExport, responsesDelete] = await Promise.all([
    hasContextPermission(c, 'forms:read'),
    hasContextPermission(c, 'forms:update'),
    hasContextPermission(c, 'forms:delete'),
    hasContextPermission(c, 'forms:publish'),
    hasContextPermission(c, 'forms:send'),
    hasContextPermission(c, 'forms:manage'),
    hasContextPermission(c, 'form_responses:read'),
    hasContextPermission(c, 'form_responses:export'),
    hasContextPermission(c, 'form_responses:delete'),
  ]);
  return { read, update, delete: del, publish, send, manage, responsesRead, responsesExport, responsesDelete };
}

/** How the member relates to one form. `null`: they cannot see it. */
export type FormRelation = 'workspace' | 'owner' | 'manage' | FormAccessRole;

export function relationTo(form: Pick<FormRow, 'access' | 'ownerUserId'>, userId: string, grants: MemberGrants, entry: FormAccessRole | null): FormRelation | null {
  if (form.ownerUserId === userId) return 'owner';
  if (grants.manage) return 'manage';
  if (form.access === 'workspace') return 'workspace';
  return entry;
}

const canChange = (relation: FormRelation) => relation === 'workspace' || relation === 'owner' || relation === 'manage' || relation === 'editor';
const canSeeAnswers = (relation: FormRelation) => canChange(relation) || relation === 'results';

/** What the member may do on this form: their permissions, narrowed by their relation to it. */
export function formPermissions(relation: FormRelation, grants: MemberGrants): FormDetail['permissions'] {
  const full = relation === 'workspace' || relation === 'owner' || relation === 'manage';
  return {
    edit: grants.update && canChange(relation),
    publish: grants.publish && canChange(relation),
    delete: grants.delete && full,
    send: grants.send && canChange(relation),
    readResponses: grants.responsesRead && canSeeAnswers(relation),
    exportResponses: grants.responsesExport && canSeeAnswers(relation),
    deleteResponses: grants.responsesDelete && canChange(relation),
    manageAccess: relation === 'owner' || relation === 'manage',
  };
}

export interface AccessibleForm {
  form: FormRow;
  relation: FormRelation;
  permissions: FormDetail['permissions'];
}

/** The member's own entry on a restricted form's access list. */
async function accessEntry(db: Database, formId: string, userId: string): Promise<FormAccessRole | null> {
  const [row] = await db
    .select({ role: formAccess.role })
    .from(formAccess)
    .where(and(eq(formAccess.formId, formId), eq(formAccess.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/**
 * Loads a form the member may see. 404 when it does not exist or is restricted
 * and they are not on it (or the owner, or `forms:manage`).
 */
export async function loadAccessibleForm(db: Database, formId: string, userId: string, grants: MemberGrants): Promise<AccessibleForm> {
  const [form] = await db.select().from(forms).where(eq(forms.id, formId)).limit(1);
  if (!form) throw notFound('Form');
  const entry = form.access === 'restricted' && form.ownerUserId !== userId && !grants.manage ? await accessEntry(db, form.id, userId) : null;
  const relation = relationTo(form, userId, grants, entry);
  if (!relation) throw notFound('Form');
  return { form, relation, permissions: formPermissions(relation, grants) };
}

/**
 * The forms whose answers the member may read: every form they can see, narrowed
 * by their role on it (`results`, `editor`, the owner, `forms:manage`) and by
 * `form_responses:read` itself. Used by the cross-form routes (a person's
 * responses, the GDPR erase with `deleteOnly`).
 */
export async function answerableFormIds(
  db: Database,
  userId: string,
  grants: MemberGrants,
  need: 'readResponses' | 'deleteResponses' = 'readResponses',
): Promise<string[]> {
  const [all, mine] = await Promise.all([
    db.select().from(forms),
    grants.manage ? Promise.resolve([]) : db.select({ formId: formAccess.formId, role: formAccess.role }).from(formAccess).where(eq(formAccess.userId, userId)),
  ]);
  const roles = new Map(mine.map((m) => [m.formId, m.role]));
  return all
    .filter((form) => {
      const relation = relationTo(form, userId, grants, roles.get(form.id) ?? null);
      return relation !== null && formPermissions(relation, grants)[need];
    })
    .map((form) => form.id);
}
