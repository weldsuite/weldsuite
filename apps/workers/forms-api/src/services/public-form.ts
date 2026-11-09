/**
 * The respondent's view of a form: finding it from its public id (master link
 * registry), opening its workspace, computing whether it is open, and the
 * `PublicForm` payload. The payload comes from the public cache; the tenant
 * database is opened only to rebuild an entry that is missing.
 */

import { and, eq } from 'drizzle-orm';
import { workspaceAppUrl } from '@weldsuite/emails';
import {
  getMasterDb,
  getWorkspaceContextForOrg,
  masterSchema,
  schema,
  type MasterDatabase,
} from '@weldsuite/worker-kit/db';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import type { PublicForm, PublicFormState } from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError, notFound } from '../lib/errors';
import type { Env } from '../types';
import { botCheckProvider } from './bot-check';
import type { WorkspaceCtx } from './context';
import { buildPublicEntry, monthOf, readPublicCache, writePublicCache, type PublicCacheEntry } from './public-cache';

const { formLinkRegistry } = masterSchema;
const { forms, formVersions } = schema;

export type LinkRow = typeof formLinkRegistry.$inferSelect;

/** The registry row of a public id, or 404. */
export async function resolveLink(master: MasterDatabase, publicId: string): Promise<LinkRow> {
  const [link] = await master.select().from(formLinkRegistry).where(eq(formLinkRegistry.publicId, publicId)).limit(1);
  if (!link) throw notFound('Form');
  return link;
}

/** Opens the tenant DB of the link's workspace; a suspended workspace is a 404 to respondents. */
export async function openWorkspace(env: Env, link: Pick<LinkRow, 'clerkOrgId' | 'workspaceId'>): Promise<WorkspaceCtx> {
  let workspace: Awaited<ReturnType<typeof getWorkspaceContextForOrg>>;
  try {
    workspace = await getWorkspaceContextForOrg(env, link.clerkOrgId);
  } catch {
    throw notFound('Form');
  }
  if (workspace.suspended) throw notFound('Form');
  return { env, db: workspace.db, master: getMasterDb(env), workspaceId: link.workspaceId, clerkOrgId: link.clerkOrgId };
}

/**
 * The cached payload of a form; on a miss it is rebuilt from the tenant rows
 * (the only time a public read opens the tenant DB) and cached again.
 */
export async function loadEntry(env: Env, link: LinkRow, workspace?: WorkspaceCtx): Promise<{ entry: PublicCacheEntry; ctx: WorkspaceCtx | null }> {
  const cached = await readPublicCache(env.WORKSPACE_CACHE, link.publicId);
  if (cached && cached.formId === link.formId) return { entry: cached, ctx: workspace ?? null };
  const ctx = workspace ?? (await openWorkspace(env, link));
  const [form] = await ctx.db.select().from(forms).where(and(eq(forms.id, link.formId), eq(forms.publicId, link.publicId))).limit(1);
  if (!form) throw notFound('Form');
  const entry = await buildPublicEntry(ctx, form);
  await writePublicCache(env.WORKSPACE_CACHE, link.publicId, entry);
  return { entry, ctx };
}

/** What a respondent meets. Staff actions (suspended, held) come first, then the form's own settings. */
export function stateOf(link: Pick<LinkRow, 'suspendedAt' | 'heldAt'>, entry: PublicCacheEntry, now = new Date()): PublicFormState {
  if (link.suspendedAt) return 'suspended';
  if (link.heldAt) return 'held';
  if (entry.status !== 'published' || !entry.definition) return 'closed';
  const { opensAt, closesAt } = entry.settings;
  if (opensAt && new Date(opensAt) > now) return 'not_open_yet';
  if (closesAt && new Date(closesAt) <= now) return 'past_close_date';
  if (entry.limitReached) return 'limit_reached';
  if (entry.overQuotaMonth === monthOf(now)) return 'over_quota';
  return 'open';
}

/** The refusal for a form that does not take responses right now. */
export function closedError(state: PublicFormState): FormsError {
  if (state === 'suspended' || state === 'held') return new FormsError(403, 'FORM_UNAVAILABLE', 'This form is no longer available.', { state });
  return new FormsError(403, 'FORM_CLOSED', 'This form is not accepting responses right now.', { state });
}

export interface PublicFormOptions {
  /** An older version a respondent is finishing (the one their response was started on). */
  version?: { id: string; definition: unknown } | null;
  /** Members-only forms answered in the platform get no bot check and no members redirect. */
  inPlatform?: boolean;
}

/** The `PublicForm` of a link. The definition is only given out while the form is open. */
export function toPublicForm(env: Env, link: LinkRow, entry: PublicCacheEntry, options: PublicFormOptions = {}): PublicForm {
  const state = stateOf(link, entry);
  const live = state === 'open';
  const provider = options.inPlatform ? 'none' : botCheckProvider(env);
  const definition = options.version ? formDefinitionSchema.parse(options.version.definition) : entry.definition;
  const { settings } = entry;
  return {
    publicId: link.publicId,
    title: entry.title,
    state,
    closedMessage: settings.closedMessage,
    versionId: options.version?.id ?? entry.versionId,
    definition: live ? definition : null,
    theme: entry.theme,
    respondentMode: settings.respondentMode,
    onePerRespondent: settings.onePerRespondent,
    allowEdit: settings.allowEdit,
    collectPartial: settings.collectPartial,
    allowedEmbedDomains: settings.allowedEmbedDomains,
    botCheck: { provider, siteKey: provider === 'turnstile' ? env.TURNSTILE_SITE_KEY || null : null },
    branding: entry.branding,
    membersUrl:
      settings.respondentMode === 'members' && !options.inPlatform
        ? workspaceAppUrl(env.PLATFORM_URL || 'https://app.weldsuite.org', link.clerkOrgId, `/weldforms/fill/${link.publicId}`)
        : null,
  };
}

/** A version row of a form, for a response that was started on it. */
export async function loadVersion(ctx: Pick<WorkspaceCtx, 'db'>, formId: string, versionId: string) {
  const [version] = await ctx.db
    .select()
    .from(formVersions)
    .where(and(eq(formVersions.id, versionId), eq(formVersions.formId, formId)))
    .limit(1);
  if (!version) throw notFound('Version');
  return version;
}
