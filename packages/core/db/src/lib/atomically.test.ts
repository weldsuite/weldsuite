import { describe, expect, it } from 'vitest';
import type { TenantDb } from './any-db';
import { atomically } from './atomically';

/**
 * A statement as Drizzle builds it: nothing runs until it is awaited (or
 * handed to a batch), and awaiting it records that it ran.
 */
function statement(ran: string[], name: string) {
  return {
    name,
    then(resolve: (value: string) => void) {
      ran.push(name);
      resolve(`${name}:done`);
    },
  };
}

const asDb = (driver: object) => driver as unknown as TenantDb;

describe('atomically', () => {
  it('hands every statement to one batch when the driver has one (neon-http)', async () => {
    const ran: string[] = [];
    const batches: unknown[][] = [];
    const db = asDb({
      batch: async (items: { name: string }[]) => {
        batches.push(items);
        return items.map((item) => `${item.name}:batched`);
      },
    });
    let built: unknown = null;
    const results = await atomically(db, (handle) => {
      built = handle;
      return [statement(ran, 'insert'), statement(ran, 'update')];
    });
    expect(built).toBe(db);
    expect(batches).toHaveLength(1);
    expect(results).toEqual(['insert:batched', 'update:batched']);
    expect(ran).toEqual([]);
  });

  it('runs the statements in order inside a transaction otherwise (postgres.js, pglite)', async () => {
    const ran: string[] = [];
    const tx = { kind: 'tx' };
    const db = asDb({
      transaction: async (fn: (handle: unknown) => Promise<void>) => {
        ran.push('begin');
        await fn(tx);
        ran.push('commit');
      },
    });
    let built: unknown = null;
    const results = await atomically(db, (handle) => {
      built = handle;
      return [statement(ran, 'insert'), statement(ran, 'update')];
    });
    expect(built).toBe(tx);
    expect(ran).toEqual(['begin', 'insert', 'update', 'commit']);
    expect(results).toEqual(['insert:done', 'update:done']);
  });

  it('lets a failed statement fail the transaction', async () => {
    const ran: string[] = [];
    const db = asDb({
      transaction: async (fn: (handle: unknown) => Promise<void>) => {
        ran.push('begin');
        try {
          await fn({});
          ran.push('commit');
        } catch (err) {
          ran.push('rollback');
          throw err;
        }
      },
    });
    const failing = Promise.reject(new Error('duplicate key'));
    failing.catch(() => undefined);
    await expect(atomically(db, () => [statement(ran, 'insert'), failing])).rejects.toThrow('duplicate key');
    expect(ran).toEqual(['begin', 'insert', 'rollback']);
  });

  it('runs the statements one after another on a handle with neither', async () => {
    const ran: string[] = [];
    const db = asDb({});
    const results = await atomically(db, () => [statement(ran, 'a'), statement(ran, 'b')]);
    expect(ran).toEqual(['a', 'b']);
    expect(results).toEqual(['a:done', 'b:done']);
  });
});
