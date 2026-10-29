/**
 * The destroy state machine (design §3.8, task C1): `beginDestroy` is
 * idempotent, `continueDestroy` advances one stage per call (R2 → ledger →
 * done) so it genuinely spreads across multiple alarm ticks, each stage is
 * itself idempotent, and a stage that fails is retried rather than silently
 * skipped or advanced past.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSqliteDurableObjectState } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { migrateMailbox } from './migrate';
import { beginDestroy, continueDestroy, getDestroyState, isDestroying } from './destroy';
import { mailboxObjectPrefix } from '../store/bodies';

const REF = { workspaceId: 'ws_1', accountId: 'acc_1' };

function makeMailbox() {
  const { storage } = createSqliteDurableObjectState();
  migrateMailbox(storage);
  return { sql: storage.sql };
}

describe('beginDestroy', () => {
  it('is idempotent: a second call while already destroying keeps the existing state', () => {
    const { sql } = makeMailbox();
    const first = beginDestroy({ sql }, 1000);
    const second = beginDestroy({ sql }, 2000);
    expect(second).toEqual(first);
    expect(isDestroying(sql)).toBe(true);
  });
});

describe('continueDestroy', () => {
  it('advances r2 -> ledger -> done across three separate calls (one alarm tick each)', async () => {
    const { sql } = makeMailbox();
    const bucket = createMemoryR2();
    await bucket.put(`${mailboxObjectPrefix(REF)}msg_1/body.html`, 'hi');
    await bucket.put(`${mailboxObjectPrefix(REF)}msg_1/body.txt`, 'hi');
    beginDestroy({ sql }, Date.now());
    const dropFromIndex = vi.fn(async () => undefined);

    const r2Step = await continueDestroy({ sql }, { MAIL_STORAGE: bucket }, REF, dropFromIndex);
    expect(r2Step.done).toBe(false);
    expect(r2Step.state.stage).toBe('ledger');
    expect(r2Step.state.deleted).toBe(2);
    expect(dropFromIndex).not.toHaveBeenCalled();
    expect((await bucket.list({ prefix: mailboxObjectPrefix(REF) })).objects).toHaveLength(0);

    const ledgerStep = await continueDestroy({ sql }, { MAIL_STORAGE: bucket }, REF, dropFromIndex);
    expect(ledgerStep.done).toBe(false);
    expect(ledgerStep.state.stage).toBe('done');
    expect(dropFromIndex).toHaveBeenCalledTimes(1);

    const finalStep = await continueDestroy({ sql }, { MAIL_STORAGE: bucket }, REF, dropFromIndex);
    expect(finalStep.done).toBe(true);
    // Idempotent: calling it again after done doesn't re-run the ledger drop.
    expect(dropFromIndex).toHaveBeenCalledTimes(1);
  });

  it('retries the r2 stage (does not advance) when the MAIL_STORAGE binding is missing', async () => {
    const { sql } = makeMailbox();
    beginDestroy({ sql }, Date.now());
    const dropFromIndex = vi.fn(async () => undefined);

    const step = await continueDestroy({ sql }, {}, REF, dropFromIndex);

    expect(step.done).toBe(false);
    expect(step.state.stage).toBe('r2');
    expect(getDestroyState(sql)?.stage).toBe('r2');
  });

  it('retries the ledger stage when dropFromIndex throws, without losing the r2 progress already made', async () => {
    const { sql } = makeMailbox();
    const bucket = createMemoryR2();
    beginDestroy({ sql }, Date.now());
    const failingDrop = vi.fn(async () => {
      throw new Error('MailIndex unreachable');
    });

    await continueDestroy({ sql }, { MAIL_STORAGE: bucket }, REF, failingDrop); // advances to 'ledger'
    const retried = await continueDestroy({ sql }, { MAIL_STORAGE: bucket }, REF, failingDrop);

    expect(retried.done).toBe(false);
    expect(retried.state.stage).toBe('ledger');
    expect(failingDrop).toHaveBeenCalledTimes(1);
  });

  it('starting from scratch (no beginDestroy call yet) still runs — destroy is safe on a never-used mailbox', async () => {
    const { sql } = makeMailbox();
    const bucket = createMemoryR2();
    const dropFromIndex = vi.fn(async () => undefined);

    const step = await continueDestroy({ sql }, { MAIL_STORAGE: bucket }, REF, dropFromIndex);

    expect(step.state.stage).toBe('ledger');
    expect(step.state.deleted).toBe(0);
  });
});
