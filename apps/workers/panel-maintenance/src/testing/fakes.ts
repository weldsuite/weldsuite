/**
 * In-memory stand-ins for the worker's bindings. The Durable Objects are the
 * real classes on a fake `ctx` (SQLite from node:sqlite), so the tests drive
 * the same code the runtime does.
 */

import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { MaintenanceLedger } from '../ledger';
import type { Env } from '../env';

type SqlValue = string | number | null;

/** Durable Object storage with a real SQLite behind `storage.sql`. */
export function fakeSqlContext() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec: (query: string, ...bindings: SqlValue[]) => {
      const statement = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = statement.all(...bindings) as Record<string, SqlValue>[];
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
      }
      const { changes } = statement.run(...bindings);
      return { toArray: () => [], rowsRead: 0, rowsWritten: Number(changes) };
    },
  };
  const storage = {
    sql,
    transactionSync: <R>(fn: () => R): R => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { ctx: { storage } as unknown as DurableObjectState, db };
}

export function newLedger(): MaintenanceLedger {
  return new MaintenanceLedger(fakeSqlContext().ctx, {} as Env);
}

/** A namespace whose `get(idFromName(name))` returns the same object for the same name. */
export function fakeNamespace<T extends object>(create: (name: string) => T) {
  const instances = new Map<string, T>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let instance = instances.get(id);
      if (!instance) {
        instance = create(id);
        instances.set(id, instance);
      }
      return instance;
    },
    instances,
  };
}

/** A queue message that records how it was settled. */
export function fakeMessage(body: unknown, id = 'msg_1') {
  return { id, body, ack: vi.fn(), retry: vi.fn() };
}

export function fakeBatch(messages: ReturnType<typeof fakeMessage>[]) {
  return { messages, queue: 'panel-maintenance-test' } as unknown as MessageBatch<unknown>;
}

/** A workflow step that runs `do` callbacks at once and records the step names and sleeps. */
export function fakeStep() {
  const names: string[] = [];
  const sleeps: string[] = [];
  const step = {
    do: async (name: string, configOrFn: unknown, maybeFn?: () => Promise<unknown>) => {
      names.push(name);
      const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<unknown>;
      return fn();
    },
    sleep: async (name: string, duration: string) => {
      sleeps.push(`${name}: ${duration}`);
    },
  };
  return { step: step as unknown as import('cloudflare:workers').WorkflowStep, names, sleeps };
}
