/**
 * Master database access and the vocabulary every job shares. This worker only
 * ever opens the master DB: the pool and the warmup messages live there, and
 * the engine must never wake a tenant database on a timer.
 */

import { masterSchema, getMasterDb, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { Env } from '../env';

export type { MasterDatabase };

export const pool = masterSchema.reachWarmupMailboxes;
export const messages = masterSchema.reachWarmupMessages;

export type PoolMailbox = typeof pool.$inferSelect;
export type WarmupMessage = typeof messages.$inferSelect;
export type PoolStatus = PoolMailbox['status'];

/** Mailboxes that take part in the network: they send, receive and are engaged. */
export const ELIGIBLE_STATUSES: PoolStatus[] = ['waiting', 'warming', 'maintaining'];

export function isEligible(status: PoolStatus): boolean {
  return ELIGIBLE_STATUSES.includes(status);
}

/** A claim on a scheduled or due message is held this long before the dispatcher hands the row out again. */
export const CLAIM_TTL_MS = 10 * 60_000;

/** Test seams shared by every entry point. */
export interface JobDeps {
  /** Tests inject a ready (pglite) database. */
  db?: MasterDatabase;
  now?: () => Date;
  /** Uniform [0, 1); tests script the random decisions. */
  random?: () => number;
}

export function openMaster(env: Pick<Env, 'DATABASE_URL_MASTER'>, deps: JobDeps): MasterDatabase {
  return deps.db ?? getMasterDb(env);
}

export function personOf(mailbox: Pick<PoolMailbox, 'firstName' | 'lastName'>): { firstName: string; lastName: string } {
  return { firstName: mailbox.firstName, lastName: mailbox.lastName };
}

export function displayName(mailbox: Pick<PoolMailbox, 'firstName' | 'lastName'>): string {
  return `${mailbox.firstName} ${mailbox.lastName}`.trim();
}
