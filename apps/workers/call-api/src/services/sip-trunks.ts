/**
 * A customer's own phone system (SIP trunk / PBX) connected to WeldDesk: the
 * trunk (one Telnyx connection, by IP address or by SIP login), its numbers
 * (ordinary WeldDesk numbers with provider `sip_trunk`, registered in the
 * master phone_number_registry) and verifying one for outbound caller id.
 *
 * Pure functions over the tenant database and Telnyx: no Hono context. They
 * throw `SipTrunkError`, which the route turns into the answer.
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { isBlockedHost } from '@weldsuite/worker-kit/safe-url';
import { getMasterDb, masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { SipTrunkIpAddress } from '@weldsuite/db/schema/voip-sip-trunks';
import {
  DESK_SIP_TRUNK_MAX_IP_ADDRESSES,
  type CreateDeskSipTrunkInput,
  type DeskSipVerificationMethod,
  type UpdateDeskSipTrunkInput,
} from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { TelnyxApiError, type TelnyxEnv } from '../lib/telnyx';
import {
  telnyxConfirmNumberVerification,
  telnyxCreateCredentialConnection,
  telnyxCreateIp,
  telnyxCreateIpConnection,
  telnyxDeleteCredentialConnection,
  telnyxDeleteIp,
  telnyxDeleteIpConnection,
  telnyxDeleteVerifiedNumber,
  telnyxRequestNumberVerification,
  telnyxUpdateCredentialConnection,
  telnyxUpdateIpConnection,
} from '../lib/telnyx-connections';
import { deactivatePhoneNumberRegistry, upsertPhoneNumberRegistry } from '../lib/phone-registry';
import { countryOfE164, toTrunkE164 } from '../lib/sip-trunk-number';
import {
  DEFAULT_SIP_HOST,
  SIP_PORT_PLAIN,
  SIP_PORT_TLS,
  TELNYX_SIGNALING_IPS,
  TELNYX_SIP_HOSTS,
} from '../lib/sip-trunk-constants';

export type SipTrunkRow = typeof schema.voipSipTrunks.$inferSelect;
export type SipTrunkNumberRow = typeof schema.voipPhoneNumbers.$inferSelect;

export class SipTrunkError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SipTrunkError';
  }
}

export interface SipTrunkContext {
  env: TelnyxEnv;
  db: Database;
  /** The Clerk org id: what the master phone_number_registry is keyed by. */
  workspaceId: string;
  userId: string | null;
}

// ── JSON ──────────────────────────────────────────────────────────────────

export function toNumberJson(row: SipTrunkNumberRow) {
  return {
    id: row.id,
    phoneNumber: row.phoneNumber,
    displayName: row.displayName,
    status: row.status,
    allowOutbound: row.allowOutbound ?? false,
    callerIdVerifiedAt: row.callerIdVerifiedAt ? row.callerIdVerifiedAt.toISOString() : null,
  };
}

export function connectionDetails(env: TelnyxEnv, trunk: SipTrunkRow) {
  const primaryHost = env.TELNYX_SIP_HOST?.trim() || DEFAULT_SIP_HOST;
  return {
    sipHosts: TELNYX_SIP_HOSTS.map((h) => ({ region: h.region, host: h.host })),
    primaryHost,
    port: trunk.transport === 'tls' ? SIP_PORT_TLS : SIP_PORT_PLAIN,
    transport: trunk.transport,
    username: trunk.sipUsername,
    signalingIps: TELNYX_SIGNALING_IPS.map((i) => ({ region: i.region, ip: i.ip })),
  };
}

export function toTrunkJson(env: TelnyxEnv, trunk: SipTrunkRow, numbers: SipTrunkNumberRow[]) {
  return {
    id: trunk.id,
    createdAt: trunk.createdAt.toISOString(),
    updatedAt: trunk.updatedAt.toISOString(),
    name: trunk.name,
    provider: trunk.provider,
    authMode: trunk.authMode,
    transport: trunk.transport,
    status: trunk.status,
    ipAddresses: trunk.ipAddresses.map((a) => ({ ip: a.ip, ...(a.port !== undefined ? { port: a.port } : {}) })),
    lastInboundAt: trunk.lastInboundAt ? trunk.lastInboundAt.toISOString() : null,
    lastError: trunk.lastError,
    numbers: numbers.map(toNumberJson),
    connection: connectionDetails(env, trunk),
  };
}

// ── Loading ───────────────────────────────────────────────────────────────

async function loadNumbers(db: Database, trunkIds: string[]): Promise<SipTrunkNumberRow[]> {
  if (trunkIds.length === 0) return [];
  return db
    .select()
    .from(schema.voipPhoneNumbers)
    .where(and(inArray(schema.voipPhoneNumbers.sipTrunkId, trunkIds), isNull(schema.voipPhoneNumbers.deletedAt)))
    .orderBy(asc(schema.voipPhoneNumbers.createdAt), asc(schema.voipPhoneNumbers.id));
}

export async function loadTrunk(db: Database, id: string): Promise<SipTrunkRow> {
  const [row] = await db.select().from(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.id, id)).limit(1);
  if (!row) throw new SipTrunkError(404, 'not_found', `Phone system '${id}' not found`);
  return row;
}

export async function listSipTrunks(ctx: SipTrunkContext) {
  const trunks = await ctx.db
    .select()
    .from(schema.voipSipTrunks)
    .orderBy(asc(schema.voipSipTrunks.createdAt), asc(schema.voipSipTrunks.id));
  const numbers = await loadNumbers(ctx.db, trunks.map((t) => t.id));
  return trunks.map((t) =>
    toTrunkJson(ctx.env, t, numbers.filter((n) => n.sipTrunkId === t.id)),
  );
}

export async function getSipTrunk(ctx: SipTrunkContext, id: string) {
  const trunk = await loadTrunk(ctx.db, id);
  return toTrunkJson(ctx.env, trunk, await loadNumbers(ctx.db, [id]));
}

// ── Validation and credentials ────────────────────────────────────────────

interface IpInput {
  ip: string;
  port?: number;
}

/** Public IPv4 only, no duplicates; the limit is 1–10. */
export function validateIpAddresses(input: IpInput[]): IpInput[] {
  if (input.length < 1) throw new SipTrunkError(400, 'ip_required', 'Add at least one IP address');
  if (input.length > DESK_SIP_TRUNK_MAX_IP_ADDRESSES) {
    throw new SipTrunkError(400, 'too_many_ips', `At most ${DESK_SIP_TRUNK_MAX_IP_ADDRESSES} IP addresses`);
  }
  const seen = new Set<string>();
  const out: IpInput[] = [];
  for (const entry of input) {
    if (isBlockedHost(entry.ip)) {
      throw new SipTrunkError(400, 'invalid_ip', `${entry.ip} is not a public IP address`);
    }
    const key = `${entry.ip}:${entry.port ?? 5060}`;
    if (seen.has(key)) throw new SipTrunkError(400, 'duplicate_ip', `${entry.ip} is listed twice`);
    seen.add(key);
    out.push({ ip: entry.ip, ...(entry.port !== undefined ? { port: entry.port } : {}) });
  }
  return out;
}

const keyOf = (a: IpInput) => `${a.ip}:${a.port ?? 5060}`;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A random SIP password: 24 characters with upper case, lower case and digits (nothing that is hard to read aloud). */
export function generateSipPassword(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const text = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
    if (/[a-z]/.test(text) && /[A-Z]/.test(text) && /\d/.test(text)) return text;
  }
}

/** The SIP login of a trunk, derived from its workspace and id: lower case letters and digits only. */
export function sipUsernameFor(workspaceId: string, trunkId: string): string {
  const workspace = workspaceId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-8);
  const trunk = trunkId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `wd${workspace}${trunk}`.slice(0, 64);
}

function requireTelnyx(env: TelnyxEnv) {
  if (!env.TELNYX_API_KEY) throw new SipTrunkError(400, 'not_configured', 'Phone service is not activated');
}

/** A Telnyx refusal as a 400 the member can read; a 404 is returned to the caller by `ignoreNotFound`. */
function telnyxFailure(action: string, err: unknown): SipTrunkError {
  console.error(`[sip-trunks] ${action} failed:`, err);
  return new SipTrunkError(400, 'telnyx_failed', `${action} failed at the phone provider`);
}

async function ignoreNotFound(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof TelnyxApiError && err.status === 404) return;
    throw err;
  }
}

async function bestEffort(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await ignoreNotFound(run);
  } catch (err) {
    console.error(`[sip-trunks] ${label} failed (continuing):`, err);
  }
}

// ── Trunks ────────────────────────────────────────────────────────────────

export async function createSipTrunk(ctx: SipTrunkContext, input: CreateDeskSipTrunkInput) {
  requireTelnyx(ctx.env);
  const { env, db } = ctx;
  const transport = input.transport ?? 'udp';
  const ips = input.authMode === 'ip' ? validateIpAddresses(input.ipAddresses ?? []) : [];
  if (input.authMode === 'credentials' && (input.ipAddresses ?? []).length > 0) {
    throw new SipTrunkError(400, 'ip_not_applicable', 'IP addresses only apply to an IP-authenticated trunk');
  }

  const id = generateId('strk');
  const username = input.authMode === 'credentials' ? sipUsernameFor(ctx.workspaceId, id) : null;
  const password = input.authMode === 'credentials' ? generateSipPassword() : null;

  let connectionId: string | null = null;
  const ipAddresses: SipTrunkIpAddress[] = [];
  try {
    if (input.authMode === 'credentials') {
      connectionId = await telnyxCreateCredentialConnection(env, {
        name: input.name,
        username: username as string,
        password: password as string,
      });
    } else {
      connectionId = await telnyxCreateIpConnection(env, { name: input.name, transport });
      for (const ip of ips) {
        const providerIpId = await telnyxCreateIp(env, { connectionId, ip: ip.ip, port: ip.port });
        ipAddresses.push({ ...ip, providerIpId });
      }
    }
  } catch (err) {
    // Nothing is left behind: the connection (and with it its addresses) goes.
    if (connectionId) {
      const created = connectionId;
      await bestEffort('rolling back the connection', () =>
        input.authMode === 'credentials'
          ? telnyxDeleteCredentialConnection(env, created)
          : telnyxDeleteIpConnection(env, created),
      );
    }
    throw telnyxFailure('Creating the connection', err);
  }

  const now = new Date();
  try {
    const [row] = await db
      .insert(schema.voipSipTrunks)
      .values({
        id,
        createdAt: now,
        updatedAt: now,
        name: input.name,
        provider: input.provider,
        authMode: input.authMode,
        ipAddresses,
        sipUsername: username,
        transport,
        providerConnectionId: connectionId,
        status: 'active',
        createdById: ctx.userId,
      })
      .returning();
    return {
      trunk: toTrunkJson(env, row as SipTrunkRow, []),
      row: row as SipTrunkRow,
      credentials: username && password ? { username, password } : null,
    };
  } catch (err) {
    const created = connectionId;
    if (created) {
      await bestEffort('rolling back the connection', () =>
        input.authMode === 'credentials'
          ? telnyxDeleteCredentialConnection(env, created)
          : telnyxDeleteIpConnection(env, created),
      );
    }
    throw err;
  }
}

export async function updateSipTrunk(ctx: SipTrunkContext, id: string, input: UpdateDeskSipTrunkInput) {
  const { env, db } = ctx;
  const trunk = await loadTrunk(db, id);
  const connectionId = trunk.providerConnectionId;
  const isIp = trunk.authMode === 'ip';

  if (input.ipAddresses !== undefined && !isIp) {
    throw new SipTrunkError(400, 'ip_not_applicable', 'IP addresses only apply to an IP-authenticated trunk');
  }
  const wantedIps = input.ipAddresses !== undefined ? validateIpAddresses(input.ipAddresses) : null;

  const connectionChange =
    (input.name !== undefined && input.name !== trunk.name) ||
    (input.status !== undefined && input.status !== trunk.status) ||
    (input.transport !== undefined && input.transport !== trunk.transport && isIp);
  if ((connectionChange || wantedIps) && connectionId) requireTelnyx(env);

  // Addresses by diff: add the new ones first, then remove the gone ones.
  let ipAddresses = trunk.ipAddresses;
  let ipFailure: SipTrunkError | null = null;
  if (wantedIps && connectionId) {
    const current = new Map(trunk.ipAddresses.map((a) => [keyOf(a), a]));
    const wanted = new Map(wantedIps.map((a) => [keyOf(a), a]));
    const kept: SipTrunkIpAddress[] = trunk.ipAddresses.filter((a) => wanted.has(keyOf(a)));
    const added: SipTrunkIpAddress[] = [];
    try {
      for (const [key, ip] of wanted) {
        if (current.has(key)) continue;
        const providerIpId = await telnyxCreateIp(env, { connectionId, ip: ip.ip, port: ip.port });
        added.push({ ...ip, providerIpId });
      }
    } catch (err) {
      for (const a of added) {
        if (a.providerIpId) {
          const ipId = a.providerIpId;
          await bestEffort('rolling back an address', () => telnyxDeleteIp(env, ipId));
        }
      }
      throw telnyxFailure('Adding an IP address', err);
    }
    const stillThere: SipTrunkIpAddress[] = [];
    for (const [key, old] of current) {
      if (wanted.has(key)) continue;
      try {
        if (old.providerIpId) {
          const ipId = old.providerIpId;
          await ignoreNotFound(() => telnyxDeleteIp(env, ipId));
        }
      } catch (err) {
        stillThere.push(old);
        ipFailure = telnyxFailure('Removing an IP address', err);
      }
    }
    ipAddresses = [...kept, ...added, ...stillThere];
  }

  if (connectionChange && connectionId && !ipFailure) {
    try {
      if (isIp) {
        await telnyxUpdateIpConnection(env, connectionId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.transport !== undefined ? { transport: input.transport } : {}),
          ...(input.status !== undefined ? { active: input.status === 'active' } : {}),
        });
      } else {
        await telnyxUpdateCredentialConnection(env, connectionId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.status !== undefined ? { active: input.status === 'active' } : {}),
        });
      }
    } catch (err) {
      ipFailure = telnyxFailure('Updating the connection', err);
    }
  }

  // The addresses already changed at Telnyx are kept in our row even when a later step failed.
  const [row] = await db
    .update(schema.voipSipTrunks)
    .set({
      ipAddresses,
      updatedAt: new Date(),
      ...(ipFailure
        ? {}
        : {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.provider !== undefined ? { provider: input.provider } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.transport !== undefined ? { transport: input.transport } : {}),
          }),
    })
    .where(eq(schema.voipSipTrunks.id, id))
    .returning();
  if (ipFailure) throw ipFailure;
  return { trunk: toTrunkJson(env, row as SipTrunkRow, await loadNumbers(db, [id])), row: row as SipTrunkRow };
}

export async function rotateSipTrunkPassword(ctx: SipTrunkContext, id: string) {
  const { env, db } = ctx;
  const trunk = await loadTrunk(db, id);
  if (trunk.authMode !== 'credentials' || !trunk.sipUsername || !trunk.providerConnectionId) {
    throw new SipTrunkError(400, 'credentials_only', 'Only a trunk that signs in with a username has a password');
  }
  requireTelnyx(env);
  const password = generateSipPassword();
  try {
    await telnyxUpdateCredentialConnection(env, trunk.providerConnectionId, { password });
  } catch (err) {
    throw telnyxFailure('Changing the password', err);
  }
  await db
    .update(schema.voipSipTrunks)
    .set({ updatedAt: new Date() })
    .where(eq(schema.voipSipTrunks.id, id));
  return { row: trunk, credentials: { username: trunk.sipUsername, password } };
}

/** Soft-delete one number of a trunk and free it in the registry (and at Telnyx when it was verified). */
async function retireNumber(ctx: SipTrunkContext, number: SipTrunkNumberRow): Promise<void> {
  const { env, db } = ctx;
  const now = new Date();
  await db
    .update(schema.voipPhoneNumbers)
    .set({ deletedAt: now, updatedAt: now, status: 'inactive' })
    .where(eq(schema.voipPhoneNumbers.id, number.id));
  await bestEffort('deactivating the registry entry', () => deactivatePhoneNumberRegistry(env, number.phoneNumber));
  if (number.callerIdVerifiedAt && env.TELNYX_API_KEY) {
    await bestEffort('removing the verified number', () => telnyxDeleteVerifiedNumber(env, number.phoneNumber));
  }
}

export async function deleteSipTrunk(ctx: SipTrunkContext, id: string) {
  const { env, db } = ctx;
  const trunk = await loadTrunk(db, id);
  if (trunk.providerConnectionId) {
    requireTelnyx(env);
    const connection = trunk.providerConnectionId;
    try {
      await ignoreNotFound(() =>
        trunk.authMode === 'credentials'
          ? telnyxDeleteCredentialConnection(env, connection)
          : telnyxDeleteIpConnection(env, connection),
      );
    } catch (err) {
      throw telnyxFailure('Deleting the connection', err);
    }
  }
  const numbers = await loadNumbers(db, [id]);
  for (const number of numbers) await retireNumber(ctx, number);
  await db.delete(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.id, id));
  return { row: trunk, numbers };
}

// ── Numbers ───────────────────────────────────────────────────────────────

export async function addTrunkNumber(
  ctx: SipTrunkContext,
  trunkId: string,
  input: { phoneNumber: string; displayName?: string | null },
) {
  const { env, db } = ctx;
  const trunk = await loadTrunk(db, trunkId);
  const e164 = toTrunkE164(input.phoneNumber);
  if (!e164) throw new SipTrunkError(400, 'invalid_number', 'Enter the number in international format, like +31201234567');

  // The registry is the arbiter: any active entry (this or another workspace) holds the number.
  const masterDb = getMasterDb(env);
  const [registered] = await masterDb
    .select()
    .from(masterSchema.phoneNumberRegistry)
    .where(eq(masterSchema.phoneNumberRegistry.phoneNumber, e164))
    .limit(1);
  if (registered?.isActive) {
    throw new SipTrunkError(409, 'number_taken', 'This number is already in use');
  }

  const [existing] = await db
    .select()
    .from(schema.voipPhoneNumbers)
    .where(eq(schema.voipPhoneNumbers.phoneNumber, e164))
    .limit(1);
  if (existing && !existing.deletedAt) {
    throw new SipTrunkError(409, 'number_taken', 'This number is already in use');
  }

  const now = new Date();
  const values = {
    provider: 'sip_trunk',
    phoneNumber: e164,
    formattedNumber: e164,
    countryCode: countryOfE164(e164),
    numberType: 'local',
    providerPhoneNumberId: null,
    providerConnectionId: trunk.providerConnectionId,
    status: 'active',
    assignedUserId: null,
    assignedAt: null,
    isDefault: false,
    allowInbound: true,
    // Not shown as caller id until verified with Telnyx.
    allowOutbound: false,
    enableRecording: true,
    displayName: input.displayName ?? null,
    sipTrunkId: trunk.id,
    callerIdVerifiedAt: null,
    deletedAt: null,
    updatedAt: now,
  };
  let row: SipTrunkNumberRow;
  if (existing) {
    [row] = (await db
      .update(schema.voipPhoneNumbers)
      .set(values)
      .where(eq(schema.voipPhoneNumbers.id, existing.id))
      .returning()) as SipTrunkNumberRow[];
  } else {
    [row] = (await db
      .insert(schema.voipPhoneNumbers)
      .values({ id: generateId('vpn'), createdAt: now, ...values })
      .returning()) as SipTrunkNumberRow[];
  }

  try {
    await upsertPhoneNumberRegistry(env, {
      phoneNumber: e164,
      clerkOrgId: ctx.workspaceId,
      voipPhoneNumberId: row.id,
      isActive: true,
    });
  } catch (err) {
    console.error('[sip-trunks] registering the number failed:', err);
    await db
      .update(schema.voipPhoneNumbers)
      .set({ deletedAt: new Date(), status: 'inactive' })
      .where(eq(schema.voipPhoneNumbers.id, row.id));
    throw new SipTrunkError(400, 'registry_failed', 'The number could not be registered, try again');
  }
  return { number: row, trunk };
}

async function loadTrunkNumber(db: Database, trunkId: string, numberId: string): Promise<SipTrunkNumberRow> {
  const [row] = await db
    .select()
    .from(schema.voipPhoneNumbers)
    .where(
      and(
        eq(schema.voipPhoneNumbers.id, numberId),
        eq(schema.voipPhoneNumbers.sipTrunkId, trunkId),
        isNull(schema.voipPhoneNumbers.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new SipTrunkError(404, 'not_found', `Number '${numberId}' not found on this phone system`);
  return row;
}

export async function removeTrunkNumber(ctx: SipTrunkContext, trunkId: string, numberId: string) {
  const trunk = await loadTrunk(ctx.db, trunkId);
  const number = await loadTrunkNumber(ctx.db, trunkId, numberId);
  await retireNumber(ctx, number);
  return { number, trunk };
}

// ── Caller id verification ────────────────────────────────────────────────

export async function startNumberVerification(
  ctx: SipTrunkContext,
  trunkId: string,
  numberId: string,
  method: DeskSipVerificationMethod,
) {
  requireTelnyx(ctx.env);
  await loadTrunk(ctx.db, trunkId);
  const number = await loadTrunkNumber(ctx.db, trunkId, numberId);
  if (number.callerIdVerifiedAt) throw new SipTrunkError(409, 'already_verified', 'This number is already verified');
  try {
    await telnyxRequestNumberVerification(ctx.env, number.phoneNumber, method);
  } catch (err) {
    if (err instanceof TelnyxApiError && err.status >= 400 && err.status < 500) {
      console.error('[sip-trunks] verification request refused:', err);
      throw new SipTrunkError(400, 'verification_refused', 'The phone provider could not send a code to this number');
    }
    throw telnyxFailure('Sending the code', err);
  }
  return { method, phoneNumber: number.phoneNumber };
}

export async function confirmNumberVerification(
  ctx: SipTrunkContext,
  trunkId: string,
  numberId: string,
  code: string,
) {
  requireTelnyx(ctx.env);
  const trunk = await loadTrunk(ctx.db, trunkId);
  const number = await loadTrunkNumber(ctx.db, trunkId, numberId);
  if (number.callerIdVerifiedAt) throw new SipTrunkError(409, 'already_verified', 'This number is already verified');
  try {
    await telnyxConfirmNumberVerification(ctx.env, number.phoneNumber, code);
  } catch (err) {
    if (err instanceof TelnyxApiError) {
      if (err.status === 404 || /expire/i.test(err.message)) {
        throw new SipTrunkError(400, 'code_expired', 'The code has expired, ask for a new one');
      }
      if (err.status >= 400 && err.status < 500) {
        throw new SipTrunkError(400, 'wrong_code', 'That code is not right');
      }
    }
    throw telnyxFailure('Checking the code', err);
  }
  const now = new Date();
  const [row] = await ctx.db
    .update(schema.voipPhoneNumbers)
    .set({ callerIdVerifiedAt: now, allowOutbound: true, updatedAt: now })
    .where(eq(schema.voipPhoneNumbers.id, number.id))
    .returning();
  return { number: row as SipTrunkNumberRow, trunk };
}
