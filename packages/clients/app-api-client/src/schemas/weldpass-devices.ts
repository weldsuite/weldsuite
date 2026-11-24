/**
 * WeldPass devices and the offline copy (ADR PASS-010), Zod v3.
 *
 * A device (a phone with the WeldPass app, or any other client that keeps a
 * copy) registers itself, then syncs: it sends a cursor per vault and gets
 * back every item changed since, whole and decrypted, the ids deleted since,
 * and the vaults it may no longer keep. A revoked device, or one in a
 * workspace that switched offline copies off, is told to wipe its copy.
 *
 * Served by the Rust backend only (the TypeScript workers are frozen), so the
 * platform and the app hide all of it on Global (`weldpass-offline`).
 */

import { z } from 'zod';

import { weldpassItemSchema, weldpassVaultSchema, loginFieldsSchema, noteFieldsSchema, cardFieldsSchema } from './weldpass-passwords';

export const weldpassDevicePlatformSchema = z.enum(['ios', 'android', 'other']);
export type WeldPassDevicePlatform = z.infer<typeof weldpassDevicePlatformSchema>;

/** `POST /api/weldpass/devices`. */
export const registerDeviceSchema = z.object({
  /** What the person calls the phone ("Gert's iPhone"). */
  name: z.string().trim().min(1).max(100),
  platform: weldpassDevicePlatformSchema,
  /** The app's version, for the device list. */
  appVersion: z.string().trim().max(40).nullish(),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

/** A vault's sync cursor: opaque to the device, at most 64 characters. */
export const syncCursorSchema = z.string().min(1).max(64);

/** At most this many vaults in one sync request. */
export const MAX_SYNC_VAULTS = 500;

/** `POST /api/weldpass/devices/:deviceId/sync`. */
export const syncDeviceSchema = z.object({
  /**
   * The cursor the device got for each vault it holds. A vault it holds
   * nothing of is left out: it gets every item of that vault.
   */
  cursors: z
    .record(z.string().min(1).max(30), syncCursorSchema)
    .default({})
    .refine((cursors) => Object.keys(cursors).length <= MAX_SYNC_VAULTS, {
      message: `At most ${MAX_SYNC_VAULTS} vaults`,
    }),
});
export type SyncDeviceInput = z.infer<typeof syncDeviceSchema>;

/** What a device did with its copy while offline (or without a request). */
export const deviceEventActionSchema = z.enum(['revealed', 'copied', 'autofilled']);
export type DeviceEventAction = z.infer<typeof deviceEventActionSchema>;

export const MAX_DEVICE_EVENTS = 500;

/** `POST /api/weldpass/devices/:deviceId/events`. */
export const deviceEventsSchema = z.object({
  events: z
    .array(
      z.object({
        vaultId: z.string().min(1).max(30),
        itemId: z.string().min(1).max(30),
        action: deviceEventActionSchema,
        /** When it happened on the device (ISO 8601). */
        at: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(MAX_DEVICE_EVENTS),
});
export type DeviceEventsInput = z.infer<typeof deviceEventsSchema>;

/** `PATCH /api/weldpass/settings`. */
export const updateWeldPassSettingsSchema = z.object({
  /** "Allow offline copies on phones". On by default. */
  offlineCopies: z.boolean(),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const weldpassDeviceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  platform: weldpassDevicePlatformSchema,
  appVersion: z.string().nullable(),
  createdAt: z.string(),
  lastSyncAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
  /** On the workspace-wide list (`?all=true`) only: who owns it. */
  userName: z.string().nullable().optional(),
  userEmail: z.string().nullable().optional(),
});
export type WeldPassDevice = z.infer<typeof weldpassDeviceSchema>;

/**
 * An item in the copy: the list's metadata and its fields. A shared vault's
 * login comes with `totp` emptied (PASS-007: its codes still come from the
 * server); `hasTotp` still says it has one.
 */
export const weldpassSyncedItemSchema = weldpassItemSchema.extend({
  fields: z.union([loginFieldsSchema.strict(), noteFieldsSchema.strict(), cardFieldsSchema.strict()]),
});
export type WeldPassSyncedItem = z.infer<typeof weldpassSyncedItemSchema>;

export const weldpassSyncedVaultSchema = z.object({
  vault: weldpassVaultSchema,
  /** Send this back next time. */
  cursor: syncCursorSchema,
  /** Every item of the vault (no cursor was sent, or it wasn't usable): replace, don't merge. */
  full: z.boolean(),
  /** Items changed since the cursor, or all of them when `full`. */
  items: z.array(weldpassSyncedItemSchema),
  /** Items deleted (or moved out) since the cursor. */
  deletedIds: z.array(z.string()),
});
export type WeldPassSyncedVault = z.infer<typeof weldpassSyncedVaultSchema>;

export const weldpassSyncResultSchema = z.object({
  /** Delete the whole copy (and the key): the device was revoked, or offline copies are off. */
  wipe: z.boolean(),
  reason: z.enum(['revoked', 'disabled']).nullable(),
  /** The server's clock at the sync, ISO 8601. */
  syncedAt: z.string(),
  /** Every vault the person can read now. */
  vaults: z.array(weldpassSyncedVaultSchema),
  /** Vaults the device sent a cursor for that it may no longer keep: wipe them. */
  removedVaultIds: z.array(z.string()),
});
export type WeldPassSyncResult = z.infer<typeof weldpassSyncResultSchema>;

export const weldpassSettingsSchema = z.object({ offlineCopies: z.boolean() });
export type WeldPassSettings = z.infer<typeof weldpassSettingsSchema>;
