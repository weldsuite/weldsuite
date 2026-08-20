/**
 * Sendcloud connection + cached senders/shipping options live on
 * `workspace_settings.customSettings.sendcloud`. Secrets are encrypted with
 * the workspace keyring when it is configured.
 */

import { eq } from 'drizzle-orm';
import {
  encryptField,
  maybeDecryptField,
  type EncryptionKeyring,
} from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '../../db';
import type { SendcloudMethodPublic, SendcloudSenderPublic } from '@weldsuite/app-api-client/schemas/sendcloud';
import type { SendcloudClient, SendcloudSenderAddress, SendcloudShippingOption } from './client';

const { workspaceSettings } = schema;

export interface SendcloudStoredSender extends SendcloudSenderPublic {}
export interface SendcloudStoredMethod extends SendcloudMethodPublic {}

export interface SendcloudStoredSettings {
  publicKey?: string;
  secretKey?: string;
  accountName?: string | null;
  lastSyncedAt?: string | null;
  senders: SendcloudStoredSender[];
  methods: SendcloudStoredMethod[];
}

function emptySettings(): SendcloudStoredSettings {
  return { senders: [], methods: [] };
}

async function loadRow(db: Database, workspaceId: string) {
  const [row] = await db
    .select({ id: workspaceSettings.id, customSettings: workspaceSettings.customSettings })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, workspaceId))
    .limit(1);
  return row ?? null;
}

export async function getSendcloudSettings(
  db: Database,
  workspaceId: string,
): Promise<SendcloudStoredSettings> {
  const row = await loadRow(db, workspaceId);
  const custom = (row?.customSettings ?? {}) as Record<string, unknown>;
  const raw = (custom.sendcloud ?? null) as SendcloudStoredSettings | null;
  if (!raw || typeof raw !== 'object') return emptySettings();
  return {
    publicKey: typeof raw.publicKey === 'string' ? raw.publicKey : undefined,
    secretKey: typeof raw.secretKey === 'string' ? raw.secretKey : undefined,
    accountName: raw.accountName ?? null,
    lastSyncedAt: raw.lastSyncedAt ?? null,
    senders: Array.isArray(raw.senders) ? raw.senders : [],
    methods: Array.isArray(raw.methods) ? raw.methods : [],
  };
}

export async function saveSendcloudSettings(
  db: Database,
  workspaceId: string,
  settings: SendcloudStoredSettings,
): Promise<void> {
  const existing = await loadRow(db, workspaceId);
  const now = new Date();
  const custom = ((existing?.customSettings ?? {}) as Record<string, unknown>);
  const next = { ...custom, sendcloud: settings };
  if (existing) {
    await db
      .update(workspaceSettings)
      .set({ customSettings: next, updatedAt: now })
      .where(eq(workspaceSettings.id, workspaceId));
    return;
  }
  await db.insert(workspaceSettings).values({
    id: workspaceId,
    customSettings: next,
    createdAt: now,
    updatedAt: now,
  });
}

export async function encryptSecret(secret: string, keyring: EncryptionKeyring): Promise<string> {
  if (keyring.v1 || keyring.v2) return encryptField(secret, keyring);
  return secret;
}

export async function decryptSecret(secret: string | undefined, keyring: EncryptionKeyring): Promise<string | null> {
  if (!secret) return null;
  return maybeDecryptField(secret, keyring);
}

export function maskPublicKey(publicKey?: string | null): string | null {
  if (!publicKey) return null;
  if (publicKey.length <= 8) return `${publicKey.slice(0, 2)}…`;
  return `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
}

export function toPublicSettings(
  stored: SendcloudStoredSettings,
): {
  connected: boolean;
  publicKeyMasked: string | null;
  accountName: string | null;
  lastSyncedAt: string | null;
  senders: SendcloudSenderPublic[];
  methods: SendcloudMethodPublic[];
} {
  return {
    connected: Boolean(stored.publicKey && stored.secretKey),
    publicKeyMasked: maskPublicKey(stored.publicKey),
    accountName: stored.accountName ?? null,
    lastSyncedAt: stored.lastSyncedAt ?? null,
    senders: stored.senders,
    methods: stored.methods,
  };
}

export function mapSyncedSenders(
  incoming: SendcloudSenderAddress[],
  previous: SendcloudStoredSender[],
): SendcloudStoredSender[] {
  const prevById = new Map(previous.map((row) => [row.id, row]));
  const hadAnyEnabled = previous.some((row) => row.enabled);
  const mapped = incoming.map((row, index) => {
    const prev = prevById.get(row.id);
    const name = row.companyName || row.contactName || `Sender ${row.id}`;
    return {
      id: row.id,
      name,
      companyName: row.companyName ?? null,
      contactName: row.contactName ?? null,
      email: row.email ?? null,
      phone: row.phone ?? null,
      addressLine1: row.addressLine1 ?? null,
      addressLine2: row.addressLine2 ?? null,
      houseNumber: row.houseNumber ?? null,
      postalCode: row.postalCode ?? null,
      city: row.city ?? null,
      countryCode: row.countryCode ?? null,
      enabled: prev?.enabled ?? (!hadAnyEnabled && (row.isDefault || index === 0)),
      isDefault: prev?.isDefault ?? Boolean(row.isDefault || index === 0),
    };
  });
  if (!mapped.some((row) => row.isDefault) && mapped[0]) {
    mapped[0] = { ...mapped[0], isDefault: true };
  }
  const defaultId = mapped.find((row) => row.isDefault)?.id;
  return mapped.map((row) => ({ ...row, isDefault: row.id === defaultId }));
}

export function mapSyncedMethods(
  incoming: SendcloudShippingOption[],
  previous: SendcloudStoredMethod[],
): SendcloudStoredMethod[] {
  const usable = incoming.filter((row) => row.code && !row.servicePointRequired && !row.isReturn);
  const prevByCode = new Map(previous.map((row) => [row.code, row]));
  const hadAnyEnabled = previous.some((row) => row.enabled);
  const mapped = usable.map((row, index) => {
    const prev = prevByCode.get(row.code);
    return {
      code: row.code,
      name: row.name,
      carrierCode: row.carrierCode ?? null,
      carrierName: row.carrierName ?? null,
      minWeightKg: row.minWeightKg ?? null,
      maxWeightKg: row.maxWeightKg ?? null,
      enabled: prev?.enabled ?? (!hadAnyEnabled && index === 0),
      isDefault: prev?.isDefault ?? (!hadAnyEnabled && index === 0),
    };
  });
  if (!mapped.some((row) => row.isDefault) && mapped[0]) {
    mapped[0] = { ...mapped[0], isDefault: true };
  }
  return mapped;
}

export async function syncSendcloudCatalog(
  stored: SendcloudStoredSettings,
  client: SendcloudClient,
): Promise<SendcloudStoredSettings> {
  const sendersIncoming = await client.listSenderAddresses();
  const senders = mapSyncedSenders(sendersIncoming, stored.senders);
  const defaultSender = senders.find((row) => row.isDefault) ?? senders[0] ?? null;
  let methods = stored.methods;
  if (defaultSender?.countryCode) {
    const from = {
      country_code: defaultSender.countryCode,
      postal_code: defaultSender.postalCode ?? undefined,
      city: defaultSender.city ?? undefined,
      address_line_1: defaultSender.addressLine1 ?? undefined,
      house_number: defaultSender.houseNumber ?? undefined,
    };
    const options = await client.listShippingOptions({
      from,
      to: from,
      weightKg: 1,
    });
    methods = mapSyncedMethods(options, stored.methods);
  }
  const accountName =
    defaultSender?.companyName || defaultSender?.contactName || stored.accountName || null;
  return {
    ...stored,
    accountName,
    senders,
    methods,
    lastSyncedAt: new Date().toISOString(),
  };
}

export function applySendcloudPatches(
  stored: SendcloudStoredSettings,
  patch: {
    senders?: Array<{ id: number; enabled?: boolean; isDefault?: boolean }>;
    methods?: Array<{ code: string; enabled?: boolean; isDefault?: boolean }>;
  },
): SendcloudStoredSettings {
  let senders = stored.senders;
  if (patch.senders) {
    const byId = new Map(patch.senders.map((row) => [row.id, row]));
    const defaultId = patch.senders.find((row) => row.isDefault)?.id;
    senders = stored.senders.map((row) => {
      const next = byId.get(row.id);
      if (!next) {
        return defaultId != null ? { ...row, isDefault: row.id === defaultId } : row;
      }
      return {
        ...row,
        enabled: next.enabled ?? row.enabled,
        isDefault: defaultId != null ? row.id === defaultId : (next.isDefault ?? row.isDefault),
      };
    });
  }
  let methods = stored.methods;
  if (patch.methods) {
    const byCode = new Map(patch.methods.map((row) => [row.code, row]));
    const defaultCode = patch.methods.find((row) => row.isDefault)?.code;
    methods = stored.methods.map((row) => {
      const next = byCode.get(row.code);
      if (!next) {
        return defaultCode != null ? { ...row, isDefault: row.code === defaultCode } : row;
      }
      return {
        ...row,
        enabled: next.enabled ?? row.enabled,
        isDefault: defaultCode != null ? row.code === defaultCode : (next.isDefault ?? row.isDefault),
      };
    });
  }
  return { ...stored, senders, methods };
}
