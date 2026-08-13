/**
 * Domain transfers service — pure functions backing /api/domain-transfers/*.
 *
 * Incoming transfers for Realtime Register call the RTR transfer API and store
 * the process id. Outgoing transfers remain local bookkeeping (authcode is
 * fetched via /api/domains/:id/auth-code).
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import type { RealtimeRegistrar } from '@weldsuite/realtime-registrar';
import { roleContactsFromEnv } from './domains';

const { hostDomainTransfers, hostDomains } = schema;

export interface ListDomainTransfersParams {
  domainId?: string;
  status?: typeof schema.hostDomainTransfers.$inferSelect['status'];
  type?: typeof schema.hostDomainTransfers.$inferSelect['type'];
  cursor?: string;
  limit?: number;
}

export async function listDomainTransfers(db: Database, params: ListDomainTransfersParams) {
  const limit = Math.min(params.limit ?? 25, 100);
  const conditions = [] as any[];
  if (params.domainId) conditions.push(eq(hostDomainTransfers.domainId, params.domainId));
  if (params.status) conditions.push(eq(hostDomainTransfers.status, params.status));
  if (params.type) conditions.push(eq(hostDomainTransfers.type, params.type));
  if (params.cursor) {
    const [cur] = await db
      .select({ createdAt: hostDomainTransfers.createdAt, id: hostDomainTransfers.id })
      .from(hostDomainTransfers)
      .where(eq(hostDomainTransfers.id, params.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${hostDomainTransfers.createdAt} < ${cur.createdAt} OR (${hostDomainTransfers.createdAt} = ${cur.createdAt} AND ${hostDomainTransfers.id} < ${cur.id}))`,
      );
    }
  }

  const filterConditions = params.cursor ? conditions.slice(0, -1) : conditions;

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(hostDomainTransfers)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(hostDomainTransfers.createdAt), desc(hostDomainTransfers.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(hostDomainTransfers)
      .where(filterConditions.length ? and(...filterConditions) : undefined),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  return { data, totalCount: countRow?.count ?? 0, hasMore, cursor };
}

export async function getDomainTransfer(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  return row ?? null;
}

function mapRtrTransferStatus(
  status: string,
): typeof schema.hostDomainTransfers.$inferSelect['status'] {
  switch (status.toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'rejected':
    case 'cancelled':
      return 'failed';
    case 'approved':
      return 'approved';
    case 'pendingfoa':
    case 'pendingwhois':
    case 'pendingvalidation':
      return 'pending_approval';
    case 'pending':
    default:
      return 'in_progress';
  }
}

export async function createDomainTransfer(
  db: Database,
  data: {
    domainId?: string | null;
    domainName: string;
    type: 'incoming' | 'outgoing';
    authCode?: string;
    fromRegistrar?: string;
    toRegistrar?: string;
  },
  opts?: {
    rtr?: RealtimeRegistrar | null;
    contactEnv?: {
      REALTIME_REGISTER_CONTACT_ADMIN?: string;
      REALTIME_REGISTER_CONTACT_TECH?: string;
      REALTIME_REGISTER_CONTACT_BILLING?: string;
    };
    nameservers?: string[];
    registrantHandle?: string;
    registrantContact?: Record<string, unknown> | null;
  },
) {
  const id = generateId('txfr');
  let toRegistrar =
    data.toRegistrar ?? (data.type === 'incoming' ? 'realtimeregister' : data.toRegistrar);
  let domainId = data.domainId ?? null;

  // Persist the transfer row first so a registrar outage still leaves a
  // reconcilable local record.
  await db.insert(hostDomainTransfers).values({
    id,
    domainId,
    domainName: data.domainName.toLowerCase(),
    type: data.type,
    status: 'pending',
    authCode: data.authCode,
    fromRegistrar: data.fromRegistrar,
    toRegistrar,
  });

  if (data.type === 'incoming' && opts?.rtr) {
    const rtr = opts.rtr;
    let registrant = opts.registrantHandle ?? null;

    try {
      if (!registrant && opts.registrantContact) {
        registrant = await rtr.ensureRegistrantFromDomainContact(
          opts.registrantContact as never,
          'ws',
        );
      }
      if (!registrant) {
        registrant = opts.contactEnv?.REALTIME_REGISTER_CONTACT_ADMIN ?? null;
      }
      if (!registrant) {
        throw new Error(
          'Incoming transfer requires a registrant contact handle (set REALTIME_REGISTER_CONTACT_ADMIN or provide contact details)',
        );
      }

      const contacts = roleContactsFromEnv(opts.contactEnv ?? {}, registrant);
      const result = await rtr.transfer({
        name: data.domainName.toLowerCase(),
        registrant,
        authCode: data.authCode,
        contacts,
        nameservers: opts.nameservers,
        designatedAgent: 'NONE',
        periodMonths: 12,
      });

      const status = mapRtrTransferStatus(result.status);
      const externalTransferId = String(result.processId);
      const registrarResponse = result as unknown as Record<string, unknown>;
      toRegistrar = 'realtimeregister';

      // Ensure a domain row exists for the incoming transfer
      if (!domainId) {
        const parts = data.domainName.toLowerCase().split('.');
        const name = parts[0]!;
        const tld = parts.slice(1).join('.');
        domainId = generateId('dom');
        await db.insert(hostDomains).values({
          id: domainId,
          name,
          tld,
          fullDomain: data.domainName.toLowerCase(),
          registrar: 'realtimeregister',
          status: 'pending',
          registrationStatus: 'pending_transfer',
          rtrRegistrantHandle: registrant,
          rtrProcessId: externalTransferId,
          authCode: data.authCode,
        });
      } else {
        await db
          .update(hostDomains)
          .set({
            registrationStatus: 'pending_transfer',
            rtrProcessId: externalTransferId,
            rtrRegistrantHandle: registrant,
            updatedAt: new Date(),
          })
          .where(eq(hostDomains.id, domainId));
      }

      await db
        .update(hostDomainTransfers)
        .set({
          domainId,
          status,
          toRegistrar,
          externalTransferId,
          registrarResponse,
          updatedAt: new Date(),
        })
        .where(eq(hostDomainTransfers.id, id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(hostDomainTransfers)
        .set({
          status: 'failed',
          failureReason: message,
          updatedAt: new Date(),
        })
        .where(eq(hostDomainTransfers.id, id));
      throw err;
    }
  }

  const [row] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  return row!;
}

export async function syncTransferFromRegistrar(
  db: Database,
  rtr: RealtimeRegistrar,
  transferId: string,
) {
  const [transfer] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, transferId))
    .limit(1);
  if (!transfer?.externalTransferId) return transfer ?? null;

  const processId = Number.parseInt(transfer.externalTransferId, 10);
  if (!Number.isFinite(processId)) return transfer;

  const outcome = await rtr.pollProcess(processId);
  if (outcome === 'pending') return transfer;

  if (outcome === 'failed') {
    return failDomainTransfer(db, transferId, 'Realtime Register process failed');
  }

  // completed
  const remote = await rtr.getDomain(transfer.domainName).catch(() => null);
  if (transfer.domainId) {
    const patch: Partial<typeof hostDomains.$inferInsert> = {
      status: 'active',
      registrationStatus: 'transferred',
      registrar: 'realtimeregister',
      externalRegistrarId: remote?.id ?? transfer.domainName,
      registrarSyncedAt: new Date(),
      updatedAt: new Date(),
    };
    // Only overwrite registrar-derived fields when the lookup succeeded —
    // a transient getDomain failure must not null out expiresAt / lock state.
    if (remote) {
      patch.registrarStatus = remote.status.join(',');
      if (remote.expiresAt) patch.expiresAt = new Date(remote.expiresAt);
      patch.locked = remote.locked;
      patch.autoRenew = remote.autoRenew;
    }
    await db.update(hostDomains).set(patch).where(eq(hostDomains.id, transfer.domainId));
  }
  return completeDomainTransfer(db, transferId);
}

export async function completeDomainTransfer(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  if (!existing) return null;
  await db
    .update(hostDomainTransfers)
    .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(hostDomainTransfers.id, id));
  const [row] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  return row!;
}

export async function failDomainTransfer(db: Database, id: string, reason: string) {
  const [existing] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  if (!existing) return null;
  await db
    .update(hostDomainTransfers)
    .set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
    .where(eq(hostDomainTransfers.id, id));
  const [row] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  return row!;
}
