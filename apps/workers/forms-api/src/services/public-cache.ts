/**
 * The published form as respondents get it, cached so that opening a form
 * never opens the tenant database (weldsuite-documentation/plans/weldforms.md, "Published forms
 * are cached"). KV on Global (`WORKSPACE_CACHE`, key `forms:public:<publicId>`),
 * Valkey on Kubernetes.
 *
 * Refreshed on publish, close, reopen, settings changes and when a response
 * crosses the form's limit or the workspace's quota. An entry that is missing
 * (expired, or never written) is rebuilt from the tenant on the next request.
 * Staff suspension and the content-screen hold are NOT in the entry: they live
 * on the master registry row, which every request reads, so they take effect at
 * once.
 */

import { eq } from 'drizzle-orm';
import { masterSchema, schema } from '@weldsuite/worker-kit/db';
import {
  formSettingsSchema,
  type FormSettings,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { formDefinitionSchema, formThemeTokensSchema, type FormDefinition, type FormThemeTokens } from '@weldsuite/forms-engine/definition';
import type { WorkspaceCtx } from './context';
import { loadUsage, overQuota } from './usage';

const { forms, formVersions, formSettings: formSettingsTable } = schema;
const { workspaces } = masterSchema;

export const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const cacheKey = (publicId: string) => `forms:public:${publicId}`;

export interface PublicCacheEntry {
  formId: string;
  title: string;
  status: 'draft' | 'published' | 'closed';
  versionId: string | null;
  definition: FormDefinition | null;
  theme: FormThemeTokens;
  settings: FormSettings;
  branding: { workspaceName: string; logoUrl: string | null; showBadge: boolean };
  /** The form's own response limit has been reached. */
  limitReached: boolean;
  /** `YYYY-MM` of the month the workspace was over its quota; stale entries of past months are ignored. */
  overQuotaMonth: string | null;
}

export const monthOf = (now: Date = new Date()) => now.toISOString().slice(0, 7);

export async function readPublicCache(kv: KVNamespace, publicId: string): Promise<PublicCacheEntry | null> {
  try {
    const raw = await kv.get(cacheKey(publicId));
    return raw ? (JSON.parse(raw) as PublicCacheEntry) : null;
  } catch {
    return null;
  }
}

export async function writePublicCache(kv: KVNamespace, publicId: string, entry: PublicCacheEntry): Promise<void> {
  await kv.put(cacheKey(publicId), JSON.stringify(entry), { expirationTtl: CACHE_TTL_SECONDS });
}

export async function dropPublicCache(kv: KVNamespace, publicId: string): Promise<void> {
  await kv.delete(cacheKey(publicId));
}

/** The theme tokens a version was published with: its snapshot, else the defaults. */
export function themeOf(snapshot: Record<string, unknown> | null | undefined): FormThemeTokens {
  return formThemeTokensSchema.parse(snapshot ?? {});
}

/** The entry for a form, from the tenant and master rows. */
export async function buildPublicEntry(ctx: WorkspaceCtx, form: typeof forms.$inferSelect, now = new Date()): Promise<PublicCacheEntry> {
  const [version] = form.publishedVersionId
    ? await ctx.db.select().from(formVersions).where(eq(formVersions.id, form.publishedVersionId)).limit(1)
    : [];
  const settings = formSettingsSchema.parse(form.settings ?? {});
  const [[wsRow], [formSettingsRow], usage] = await Promise.all([
    ctx.master.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1),
    ctx.db.select().from(formSettingsTable).limit(1),
    loadUsage(ctx, now),
  ]);
  const theme = themeOf(version?.theme);
  // The badge is only switchable off on plans that allow removing branding.
  const showBadge = formSettingsRow ? formSettingsRow.showBadge || !usage.workspacePlan.removeBranding : true;
  return {
    formId: form.id,
    title: form.title,
    status: form.status,
    versionId: version?.id ?? null,
    definition: version ? formDefinitionSchema.parse(version.definition) : null,
    theme,
    settings,
    branding: { workspaceName: wsRow?.name ?? 'WeldSuite', logoUrl: theme.logoUrl ?? null, showBadge },
    limitReached: settings.responseLimit !== null && form.responseCount >= settings.responseLimit,
    overQuotaMonth: overQuota(usage) ? monthOf(now) : null,
  };
}

/** Rebuilds and stores the entry of a published or closed form. A form that never went live has none. */
export async function refreshPublicCache(ctx: WorkspaceCtx, form: typeof forms.$inferSelect): Promise<PublicCacheEntry | null> {
  if (!form.publicId) return null;
  const entry = await buildPublicEntry(ctx, form);
  await writePublicCache(ctx.env.WORKSPACE_CACHE, form.publicId, entry);
  return entry;
}
