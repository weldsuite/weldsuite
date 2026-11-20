/**
 * Workspace settings (a single row), the member's own subscription to a form,
 * and media uploads (images authors put on questions and themes).
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { loadWorkspacePlan } from '@weldsuite/core-domain/plan-limits';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { ALPHANUMERIC, randomString } from '@weldsuite/worker-kit/random';
import type {
  FormMediaUploadResult,
  FormSubscription,
  FormsWorkspaceSettings,
  UpdateFormsWorkspaceSettingsInput,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError, notFound } from '../lib/errors';
import type { WorkspaceCtx } from './context';
import { refreshPublicCache } from './public-cache';

const { forms, formSettings, formThemes, formSubscriptions } = schema;

// ---------------------------------------------------------------------------
// Workspace settings
// ---------------------------------------------------------------------------

type SettingsRow = typeof formSettings.$inferSelect;

function settingsDto(row: SettingsRow | undefined, canHideBadge: boolean): FormsWorkspaceSettings {
  return {
    defaultThemeId: row?.defaultThemeId ?? null,
    senderName: row?.senderName ?? null,
    reminderAfterDays: row?.reminderAfterDays ?? null,
    reminderEveryDays: row?.reminderEveryDays ?? null,
    reminderMaxCount: row?.reminderMaxCount ?? 3,
    // A plan that may not hide the badge always shows it.
    showBadge: row ? row.showBadge || !canHideBadge : true,
    canHideBadge,
  };
}

export async function getWorkspaceSettings(ctx: Pick<WorkspaceCtx, 'db' | 'master' | 'workspaceId'>): Promise<FormsWorkspaceSettings> {
  const [[row], plan] = await Promise.all([ctx.db.select().from(formSettings).limit(1), loadWorkspacePlan(ctx.master, ctx.workspaceId)]);
  return settingsDto(row, plan.removeBranding);
}

/** Upserts the single settings row. Switching the badge off needs a plan that allows it (403 `PLAN_REQUIRED`). */
export async function updateWorkspaceSettings(ctx: WorkspaceCtx, input: UpdateFormsWorkspaceSettingsInput): Promise<FormsWorkspaceSettings> {
  const plan = await loadWorkspacePlan(ctx.master, ctx.workspaceId);
  if (input.showBadge === false && !plan.removeBranding) {
    throw new FormsError(403, 'PLAN_REQUIRED', 'Your plan does not include removing the "Made with WeldForms" badge.');
  }
  if (input.defaultThemeId) {
    const [theme] = await ctx.db.select({ id: formThemes.id }).from(formThemes).where(eq(formThemes.id, input.defaultThemeId)).limit(1);
    if (!theme) throw notFound('Theme');
  }
  const [existing] = await ctx.db.select().from(formSettings).limit(1);
  const values = {
    ...(input.defaultThemeId !== undefined ? { defaultThemeId: input.defaultThemeId } : {}),
    ...(input.senderName !== undefined ? { senderName: input.senderName } : {}),
    ...(input.reminderAfterDays !== undefined ? { reminderAfterDays: input.reminderAfterDays } : {}),
    ...(input.reminderEveryDays !== undefined ? { reminderEveryDays: input.reminderEveryDays } : {}),
    ...(input.reminderMaxCount !== undefined ? { reminderMaxCount: input.reminderMaxCount } : {}),
    ...(input.showBadge !== undefined ? { showBadge: input.showBadge } : {}),
    updatedAt: new Date(),
  };
  const [row] = existing
    ? await ctx.db.update(formSettings).set(values).where(eq(formSettings.id, existing.id)).returning()
    : await ctx.db.insert(formSettings).values({ id: generateId('fst'), ...values }).returning();
  // The badge is part of what respondents get from the cache.
  if (input.showBadge !== undefined) {
    const live = await ctx.db.select().from(forms).where(isNotNull(forms.publicId));
    await Promise.all(live.map((f) => refreshPublicCache(ctx, f)));
  }
  return settingsDto(row, plan.removeBranding);
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/** The member's notification setting for a form; `instant` for the owner, `off` for anyone who never chose. */
export async function getSubscription(ctx: Pick<WorkspaceCtx, 'db'>, formId: string, userId: string): Promise<FormSubscription> {
  const [row] = await ctx.db
    .select({ mode: formSubscriptions.mode })
    .from(formSubscriptions)
    .where(and(eq(formSubscriptions.formId, formId), eq(formSubscriptions.userId, userId)))
    .limit(1);
  return { mode: row?.mode ?? 'off' };
}

export async function setSubscription(ctx: Pick<WorkspaceCtx, 'db'>, formId: string, userId: string, input: FormSubscription): Promise<FormSubscription> {
  const [existing] = await ctx.db
    .select({ id: formSubscriptions.id })
    .from(formSubscriptions)
    .where(and(eq(formSubscriptions.formId, formId), eq(formSubscriptions.userId, userId)))
    .limit(1);
  if (existing) {
    await ctx.db.update(formSubscriptions).set({ mode: input.mode, updatedAt: new Date() }).where(eq(formSubscriptions.id, existing.id));
  } else {
    await ctx.db.insert(formSubscriptions).values({ id: generateId('fsb'), formId, userId, mode: input.mode });
  }
  return { mode: input.mode };
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/** Images only; SVG is left out because it can carry script and is served from a shared origin. */
const MEDIA_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

export function publicMediaUrl(env: { R2_PUBLIC_URL?: string }, key: string): string {
  return `${(env.R2_PUBLIC_URL || 'https://weldsuite-storage.weldsuite.org').replace(/\/$/, '')}/${key}`;
}

/** Stores an image in the public bucket under `workspaces/<org>/weldforms/media/`. */
export async function uploadMedia(ctx: Pick<WorkspaceCtx, 'env' | 'clerkOrgId'>, file: File): Promise<FormMediaUploadResult> {
  const ext = MEDIA_TYPES[file.type];
  if (!ext) throw new FormsError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a PNG, JPEG, GIF, WebP or AVIF image.');
  if (file.size > MAX_MEDIA_BYTES) throw new FormsError(413, 'FILE_TOO_LARGE', 'Images can be at most 5 MB.');
  if (file.size === 0) throw new FormsError(400, 'BAD_REQUEST', 'The file is empty.');
  const key = `workspaces/${ctx.clerkOrgId}/weldforms/media/${randomString(16, ALPHANUMERIC)}.${ext}`;
  await ctx.env.STORAGE.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' } });
  return { url: publicMediaUrl(ctx.env, key), contentType: file.type, size: file.size };
}
