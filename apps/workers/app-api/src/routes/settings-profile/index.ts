/**
 * Self-profile routes — /api/settings/profile.
 *
 * Ported from apps/api-worker/src/routes/settings/index.ts (~3442-3662) as part
 * of retiring that worker. See src/services/settings-profile.ts for the store
 * this reads and writes, and why it is deliberately NOT the `workspace_members`
 * profile columns behind /api/team-members/user/:userId/profile.
 *
 * PERMISSIONS: editing your own profile is a personal, self-scoped action, so
 * every role must be able to reach it. All three routes gate on `general:read`
 * — the baseline OWNER, ADMIN, MEMBER and VIEWER all hold (verified against
 * packages/core/permissions/src/catalog.ts: every LEGACY_*_PERMISSIONS list carries
 * `settings:general:read`, which migrates to `general:read`). Gating the writes
 * on `general:update` would be wrong: that is admin-only, and a member editing
 * their own name would 403.
 *
 * Identity comes from `c.get('userId')` (Clerk), never from the request body,
 * so a caller can only ever read or write their own profile.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import {
  getSelfProfile,
  updateSelfAvatar,
  updateSelfProfile,
} from '../../services/settings-profile';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Mirrors legacy `updateProfileSchema` (Zod v3), plus `timezone`.
 *
 * `timezone` is the one field legacy omitted, which made the Timezone picker a
 * no-op: the UI enabled Save and toasted success, but the value was never sent
 * and would have been stripped here anyway. It is accepted now and written to
 * the EXISTING `user_preferences.timezone` column (`varchar(100)`, notNull,
 * default 'UTC') that `composeProfile` already reads — no schema change.
 * The `.max(100)` cap matches that column so an oversized value 400s instead of
 * overflowing the write.
 */
const updateProfileSchema = z.object({
  name: z.string().optional(),
  nickname: z.string().optional(),
  phone: z.string().optional(),
  jobTitle: z.string().optional(),
  bio: z.string().optional(),
  timezone: z.string().min(1).max(100).optional(),
});

const avatarSchema = z.object({
  /** A `data:<mime>;base64,<payload>` URL, as produced by FileReader.readAsDataURL. */
  file: z.string().min(1),
  fileName: z.string().optional(),
  contentType: z.string().optional(),
});

/** Decoded avatar ceiling. Mirrors the MAX_*_BYTES pattern used elsewhere. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Build the public URL for an object. On localhost the mapped R2 domain serves
 * the *remote* bucket and cannot see Miniflare's local objects, so point at the
 * worker's own passthrough instead. Mirrors `resolvePublicUrl` in routes/storage.
 */
function resolvePublicUrl(reqUrl: string, r2PublicUrl: string | undefined, fileKey: string): string {
  const origin = new URL(reqUrl).origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return `${origin}/api/storage/public/${fileKey}`;
  }
  const base = r2PublicUrl || 'https://weldsuite-storage-test.weldsuite.org';
  return `${base}/${fileKey}`;
}

// ============================================================================
// GET /api/settings/profile
// ============================================================================

app.get('/', requirePermission('general:read'), async (c) => {
  try {
    const profile = await getSelfProfile(c.get('tenantDb'), c.get('userId'));
    return success(c, profile);
  } catch (err) {
    console.error('[app-api/settings-profile] failed to fetch profile:', err);
    return error.internal(c, 'Failed to fetch profile');
  }
});

// ============================================================================
// PUT /api/settings/profile
// ============================================================================

app.put('/', requirePermission('general:read'), zValidator('json', updateProfileSchema), async (c) => {
  try {
    const profile = await updateSelfProfile(c.get('tenantDb'), c.get('userId'), c.req.valid('json'));
    return success(c, profile);
  } catch (err) {
    console.error('[app-api/settings-profile] failed to update profile:', err);
    return error.internal(c, 'Failed to update profile');
  }
});

// ============================================================================
// PUT /api/settings/profile/avatar
// ============================================================================

/**
 * Accepts a base64 data URL, stores the bytes in R2 and saves the resulting
 * public URL on the workspace member row.
 *
 * NOTE — this is the one place the port intentionally diverges from legacy.
 * The legacy handler wrote the raw data URL straight into
 * `workspace_members.picture`, which is `varchar(500)`; a data URL for any real
 * image is orders of magnitude longer, so that write always overflowed and the
 * endpoint 500'd for every non-trivial upload. Storing to R2 keeps the same
 * destination column and the same response shape while producing a ~130-char
 * URL that actually fits.
 */
app.put('/avatar', requirePermission('general:read'), zValidator('json', avatarSchema), async (c) => {
  try {
    const { file, contentType } = c.req.valid('json');

    if (!c.env.STORAGE) return error.internal(c, 'Storage is not configured');

    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(file);
    if (!match || !match[2]) {
      return error.badRequest(c, 'Avatar must be a base64 data URL');
    }
    const mime = (match[1] || contentType || '').toLowerCase();
    const payload = match[3] ?? '';

    const ext = EXT_BY_MIME[mime];
    if (!ext) {
      return error.badRequest(c, 'Avatar must be a PNG, JPEG, GIF, WebP or AVIF image');
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(payload);
    } catch {
      return error.badRequest(c, 'Avatar is not valid base64');
    }

    if (bytes.byteLength === 0) return error.badRequest(c, 'Avatar is empty');
    if (bytes.byteLength > MAX_AVATAR_BYTES) {
      return error.badRequest(c, `Avatar exceeds the ${MAX_AVATAR_BYTES / (1024 * 1024)}MB limit`);
    }

    // Key is derived from the authenticated user + workspace, never from the
    // client-supplied fileName, so a caller cannot traverse or overwrite
    // another user's object.
    const workspaceId = c.get('workspaceId');
    const userId = c.get('userId');
    const fileKey = `workspaces/${workspaceId}/avatars/${userId}_${Date.now()}.${ext}`;

    await c.env.STORAGE.put(fileKey, bytes, { httpMetadata: { contentType: mime } });

    const imageUrl = resolvePublicUrl(c.req.url, c.env.R2_PUBLIC_URL, fileKey);

    // The object exists but nothing references it until the row below lands.
    // If that write fails, roll the object back — otherwise it is orphaned for
    // good: `picture` still points at the previous avatar, so no code path will
    // ever read or clean up this key. The delete is best-effort and must not
    // mask the original DB error, which is what the caller needs to see.
    try {
      await updateSelfAvatar(c.get('tenantDb'), userId, imageUrl);
    } catch (err) {
      await c.env.STORAGE.delete(fileKey).catch((cleanupErr) => {
        console.error(
          '[app-api/settings-profile] failed to clean up orphaned avatar:',
          fileKey,
          cleanupErr,
        );
      });
      throw err;
    }

    return success(c, { imageUrl });
  } catch (err) {
    console.error('[app-api/settings-profile] failed to update avatar:', err);
    return error.internal(c, 'Failed to update avatar');
  }
});

export { app as settingsProfileRoutes };
