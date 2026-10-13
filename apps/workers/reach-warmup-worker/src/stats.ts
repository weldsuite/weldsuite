/**
 * Stats rollup (daily): per pool mailbox, what the network measured over the
 * last 3 and 7 days, written to `reach_warmup_mailboxes.stats` for reach-api
 * (health gate, Mailboxes screen) and the admin console.
 *
 * Placement is judged at the recipient: a mailbox's `inbox3d` counts ITS OWN
 * sent mail that landed in the inbox of whoever received it. Two aggregate
 * queries (sent side, received side) and one multi-row UPDATE per 100 mailboxes;
 * nothing runs per message.
 */

import { count, gte, ne, sql } from 'drizzle-orm';
import { inboxRate } from '@weldsuite/reach-domain/warmup';
import type { ReachWarmupStats } from '@weldsuite/db/schema/master';
import { DAY_MS } from './lib/random';
import { messages, pool, type MasterDatabase, type PoolStatus } from './lib/db';
import { timestamptz } from './lib/sql';

/** Mailboxes written per UPDATE statement. */
const WRITE_CHUNK = 100;

export interface RolledUpMailbox {
  id: string;
  status: PoolStatus;
  stats: ReachWarmupStats;
}

interface SentRow {
  id: string;
  sent7d: number;
  inbox3d: number;
  spam3d: number;
  missing3d: number;
  inbox7d: number;
  spam7d: number;
  missing7d: number;
}

interface ReceivedRow {
  id: string;
  received7d: number;
  spamRescues7d: number;
}

function filtered(condition: ReturnType<typeof sql>) {
  return sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
}

async function readSent(master: MasterDatabase, now: Date): Promise<SentRow[]> {
  const since3 = timestamptz(new Date(now.getTime() - 3 * DAY_MS));
  const placed = (placement: string, since: ReturnType<typeof sql>) =>
    filtered(sql`${messages.placement} = ${placement} and ${messages.sentAt} >= ${since}`);
  const since7 = timestamptz(new Date(now.getTime() - 7 * DAY_MS));
  return master
    .select({
      id: messages.fromMailboxId,
      sent7d: count(),
      inbox3d: placed('inbox', since3),
      spam3d: placed('spam', since3),
      missing3d: placed('missing', since3),
      inbox7d: placed('inbox', since7),
      spam7d: placed('spam', since7),
      missing7d: placed('missing', since7),
    })
    .from(messages)
    .where(gte(messages.sentAt, new Date(now.getTime() - 7 * DAY_MS)))
    .groupBy(messages.fromMailboxId);
}

async function readReceived(master: MasterDatabase, now: Date): Promise<ReceivedRow[]> {
  return master
    .select({
      id: messages.toMailboxId,
      received7d: count(),
      spamRescues7d: filtered(sql`${messages.actions}->>'movedFromSpam' = 'true'`),
    })
    .from(messages)
    .where(gte(messages.sentAt, new Date(now.getTime() - 7 * DAY_MS)))
    .groupBy(messages.toMailboxId);
}

const NO_SENT: SentRow = {
  id: '',
  sent7d: 0,
  inbox3d: 0,
  spam3d: 0,
  missing3d: 0,
  inbox7d: 0,
  spam7d: 0,
  missing7d: 0,
};

/** The stats of one mailbox from its sent-side and received-side rows. */
export function buildStats(sent: SentRow | undefined, received: ReceivedRow | undefined, now: Date): ReachWarmupStats {
  const s = sent ?? NO_SENT;
  return {
    sent7d: s.sent7d,
    received7d: received?.received7d ?? 0,
    inbox3d: s.inbox3d,
    spam3d: s.spam3d,
    missing3d: s.missing3d,
    inbox7d: s.inbox7d,
    spam7d: s.spam7d,
    missing7d: s.missing7d,
    inboxRate3d: inboxRate({ inbox: s.inbox3d, spam: s.spam3d, missing: s.missing3d }),
    inboxRate7d: inboxRate({ inbox: s.inbox7d, spam: s.spam7d, missing: s.missing7d }),
    spamRescues7d: received?.spamRescues7d ?? 0,
    rolledUpAt: now.toISOString(),
  };
}

async function writeStats(master: MasterDatabase, rolled: RolledUpMailbox[]): Promise<void> {
  for (let i = 0; i < rolled.length; i += WRITE_CHUNK) {
    const tuples = rolled
      .slice(i, i + WRITE_CHUNK)
      .map((mailbox) => sql`(${mailbox.id}, ${JSON.stringify(mailbox.stats)}::jsonb)`);
    const rows = sql.join(tuples, sql`, `);
    await master.execute(
      sql`update ${pool} as m set stats = v.stats from (values ${rows}) as v(id, stats) where m.id = v.id`,
    );
  }
}

/** Recompute and store the stats of every pool mailbox that is not removed. */
export async function rollUpStats(master: MasterDatabase, now: Date): Promise<RolledUpMailbox[]> {
  const [mailboxes, sentRows, receivedRows] = await Promise.all([
    master.select({ id: pool.id, status: pool.status }).from(pool).where(ne(pool.status, 'removed')),
    readSent(master, now),
    readReceived(master, now),
  ]);
  const sent = new Map(sentRows.map((row) => [row.id, row]));
  const received = new Map(receivedRows.map((row) => [row.id, row]));
  const rolled = mailboxes.map((mailbox) => ({
    id: mailbox.id,
    status: mailbox.status,
    stats: buildStats(sent.get(mailbox.id), received.get(mailbox.id), now),
  }));
  await writeStats(master, rolled);
  return rolled;
}
