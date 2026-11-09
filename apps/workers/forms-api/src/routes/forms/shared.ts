/**
 * Shared by the member routes of one form: the context type, loading a form
 * the member may see (and the right they need on it), and the detail answer.
 */

import type { Context } from 'hono';
import {
  loadAccessibleForm,
  resolveGrants,
  type AccessibleForm,
  type MemberGrants,
} from '../../services/access';
import { workspaceCtx, type WorkspaceCtx } from '../../services/context';
import { moderationOf, toDetail, type FormRow } from '../../services/forms';
import { memberRef } from '../../services/members';
import { FormsError } from '../../lib/errors';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import type { Env, Variables } from '../../types';

export type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export interface Loaded extends AccessibleForm {
  ctx: WorkspaceCtx;
  grants: MemberGrants;
  userId: string;
}

/**
 * The form with the member's relation to it. 404 when it does not exist or is
 * restricted and the member is not on it; 403 when `need` (one of the form's
 * `permissions`) is not theirs.
 */
export async function loadForm(c: Ctx, id: string, need?: keyof FormDetail['permissions']): Promise<Loaded> {
  const ctx = workspaceCtx(c);
  const userId = c.get('userId');
  const grants = await resolveGrants(c);
  const accessible = await loadAccessibleForm(ctx.db, id, userId, grants);
  if (need && !accessible.permissions[need]) throw new FormsError(403, 'FORBIDDEN', 'You do not have access to do this on this form.');
  return { ...accessible, ctx, grants, userId };
}

/** The detail DTO of a (possibly just changed) form row. */
export async function detailOf(loaded: Loaded, form: FormRow = loaded.form): Promise<FormDetail> {
  const { ctx } = loaded;
  const [owner, moderation] = await Promise.all([memberRef(ctx.db, form.ownerUserId), moderationOf(ctx, form)]);
  return toDetail(ctx, form, { owner, relation: loaded.relation, grants: loaded.grants, moderation });
}
