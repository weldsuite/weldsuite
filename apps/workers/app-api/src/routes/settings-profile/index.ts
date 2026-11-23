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
import { error, success } from '@weldsuite/worker-kit/response';
import {
  getSelfProfile,
  saveAccountPicture,
  updateSelfProfile,
} from '../../services/settings-profile';
import { updateProfileSchema } from '../../services/settings-profile-schema';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

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
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.codePointAt(i)!;
  return bytes;
}

/**
 * Set the user's Clerk profile image and return its new URL, or null when
 * Clerk refuses it. Clerk answers with the updated user object.
 */
async function setClerkProfileImage(
  secretKey: string,
  userId: string,
  bytes: Uint8Array,
  mime: string,
  ext: string,
): Promise<string | null> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), `avatar.${ext}`);
  const resp = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}/profile_image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}` },
    body: form,
  });
  if (!resp.ok) {
    console.error('[app-api/settings-profile] Clerk profile image update failed:', resp.status);
    return null;
  }
  const user = (await resp.json().catch(() => null)) as { image_url?: string | null } | null;
  return user?.image_url || null;
}

// ============================================================================
// GET /api/settings/profile
// ============================================================================

app.get('/', requirePermission('general:read'), async (c) => {
  try {
    const profile = await getSelfProfile(c.get('tenantDb'), c.env, c.get('userId'));
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
    const profile = await updateSelfProfile(c.get('tenantDb'), c.env, c.get('userId'), c.req.valid('json'));
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
 * Accepts a base64 data URL and makes it the caller's ACCOUNT picture: it is
 * sent to Clerk as the user's profile image, and the URL Clerk answers with is
 * written to the master `users.image_url` straight away (the `user.updated`
 * webhook writes the same value shortly after). A picture belongs to the
 * person, not to one workspace, so nothing is stored on `workspace_members`
 * and nothing in R2: every workspace shows the new picture
 * (@weldsuite/worker-kit/account-pictures).
 */
app.put('/avatar', requirePermission('general:read'), zValidator('json', avatarSchema), async (c) => {
  try {
    const { file, contentType } = c.req.valid('json');

    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(file);
    if (!match?.[2]) {
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

    // Identity comes from the session, never from the body: a caller can only
    // ever change their own picture.
    const userId = c.get('userId');
    const imageUrl = await setClerkProfileImage(c.env.CLERK_SECRET_KEY, userId, bytes, mime, ext);
    if (!imageUrl) return error.internal(c, 'Failed to update avatar');

    await saveAccountPicture(c.env, userId, imageUrl);

    return success(c, { imageUrl });
  } catch (err) {
    console.error('[app-api/settings-profile] failed to update avatar:', err);
    return error.internal(c, 'Failed to update avatar');
  }
});

export { app as settingsProfileRoutes };
