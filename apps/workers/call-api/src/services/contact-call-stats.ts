/**
 * Per-person call statistics for the WeldCall People grid.
 *
 * A call belongs to a person when it is linked to them (`voip_calls.contact_id`)
 * or, when it isn't linked to anyone, when the other party's number matches
 * the person's direct or mobile phone. A call linked to a different person is
 * never counted by number.
 */

import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { ContactCallStats } from '@weldsuite/app-api-client/schemas/call-intelligence';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { phoneLookupSuffix, phonesMatch } from './desk-phone-crm';

export interface StatsCall {
  contactId: string | null;
  direction: string;
  fromNumber: string;
  toNumber: string;
  duration: number | null;
  initiatedAt: Date;
}

export interface StatsPerson {
  id: string;
  phones: string[];
}

/** The other party's number: who was dialled, or who called in. */
function remoteNumber(call: StatsCall): string {
  return call.direction === 'outbound' ? call.toNumber : call.fromNumber;
}

function emptyStats(contactId: string): ContactCallStats {
  return {
    contactId,
    totalCalls: 0,
    inboundCalls: 0,
    outboundCalls: 0,
    totalDuration: 0,
    lastCallAt: null,
  };
}

export function belongsTo(call: StatsCall, person: StatsPerson): boolean {
  if (call.contactId) return call.contactId === person.id;
  const remote = remoteNumber(call);
  return person.phones.some((phone) => phonesMatch(remote, phone));
}

export function aggregateContactCallStats(
  people: StatsPerson[],
  calls: StatsCall[],
): ContactCallStats[] {
  return people.map((person) => {
    const stats = emptyStats(person.id);
    let last: Date | null = null;
    for (const call of calls) {
      if (!belongsTo(call, person)) continue;
      stats.totalCalls += 1;
      if (call.direction === 'inbound') stats.inboundCalls += 1;
      if (call.direction === 'outbound') stats.outboundCalls += 1;
      stats.totalDuration += call.duration ?? 0;
      if (!last || call.initiatedAt > last) last = call.initiatedAt;
    }
    stats.lastCallAt = last ? last.toISOString() : null;
    return stats;
  });
}

/**
 * Stats for each of `contactIds` (people ids). `scopeUserId` limits the calls
 * to that owner, mirroring GET /api/calls without activities:scope:all.
 * Unknown or deleted people come back with zero counts.
 */
export async function getContactCallStats(
  db: Database,
  contactIds: string[],
  scopeUserId?: string,
): Promise<ContactCallStats[]> {
  if (contactIds.length === 0) return [];
  const { people, voipCalls } = schema;

  const rows = await db
    .select({ id: people.id, directPhone: people.directPhone, mobilePhone: people.mobilePhone })
    .from(people)
    .where(and(inArray(people.id, contactIds), isNull(people.deletedAt)));

  const byId = new Map(
    rows.map((r) => [
      r.id,
      [r.directPhone, r.mobilePhone].map((p) => p?.trim()).filter((p): p is string => !!p),
    ]),
  );
  const statsPeople: StatsPerson[] = contactIds.map((id) => ({ id, phones: byId.get(id) ?? [] }));

  // Narrow in SQL on the last 8 digits; phonesMatch makes the final call.
  const suffixes = [...new Set(statsPeople.flatMap((p) => p.phones.map((ph) => phoneLookupSuffix(ph))))]
    .filter((s): s is string => !!s);
  const remoteDigits = sql`regexp_replace(case when ${voipCalls.direction} = 'outbound' then ${voipCalls.toNumber} else ${voipCalls.fromNumber} end, '[^0-9]', '', 'g')`;
  const matches: SQL[] = [inArray(voipCalls.contactId, contactIds)];
  if (suffixes.length > 0) {
    matches.push(
      and(
        isNull(voipCalls.contactId),
        or(...suffixes.map((s) => sql`${remoteDigits} like ${`%${s}`}`)),
      )!,
    );
  }
  const conditions: SQL[] = [or(...matches)!];
  if (scopeUserId) conditions.push(eq(voipCalls.userId, scopeUserId));

  const calls = await db
    .select({
      contactId: voipCalls.contactId,
      direction: voipCalls.direction,
      fromNumber: voipCalls.fromNumber,
      toNumber: voipCalls.toNumber,
      duration: voipCalls.duration,
      initiatedAt: voipCalls.initiatedAt,
    })
    .from(voipCalls)
    .where(and(...conditions));

  return aggregateContactCallStats(statsPeople, calls);
}
