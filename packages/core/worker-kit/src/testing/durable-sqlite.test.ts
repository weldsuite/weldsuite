/**
 * `createSqliteDurableObjectState()` / `fireAlarm()`: the strictness rules
 * (rejecting BEGIN/COMMIT/SAVEPOINT and boolean/undefined bindings through
 * `sql.exec()`), multi-statement `exec()` semantics, transactions, the KV
 * API, alarms, `deleteAll()`, and FTS5 (trigram substring search, contentless
 * deletes, `unicode61 remove_diacritics`), all against the real node:sqlite
 * engine `createSqliteDurableObjectState()` wraps.
 */

import { describe, expect, it } from 'vitest';
import { createSqliteDurableObjectState, fireAlarm } from './durable-sqlite';

function freshSql() {
  const state = createSqliteDurableObjectState();
  return { state, sql: state.storage.sql };
}

describe('sql.exec(): cursor API', () => {
  it('toArray(), one(), raw(), columnNames, and iteration over a simple SELECT', () => {
    const { sql } = freshSql();
    sql.exec('CREATE TABLE artist (artistid INTEGER PRIMARY KEY, artistname TEXT)');
    sql.exec('INSERT INTO artist (artistid, artistname) VALUES (123, ?), (456, ?), (789, ?)', 'Alice', 'Bob', 'Charlie');

    const all = sql.exec<{ artistid: number; artistname: string }>('SELECT * FROM artist ORDER BY artistname ASC').toArray();
    expect(all).toEqual([
      { artistid: 123, artistname: 'Alice' },
      { artistid: 456, artistname: 'Bob' },
      { artistid: 789, artistname: 'Charlie' },
    ]);

    const cursor = sql.exec('SELECT * FROM artist ORDER BY artistname ASC');
    expect(cursor.columnNames).toEqual(['artistid', 'artistname']);
    const collected = [...cursor];
    expect(collected).toHaveLength(3);

    const rawRows = [...sql.exec('SELECT * FROM artist ORDER BY artistname ASC').raw()];
    expect(rawRows).toEqual([
      [123, 'Alice'],
      [456, 'Bob'],
      [789, 'Charlie'],
    ]);

    expect(sql.exec('SELECT * FROM artist WHERE artistname = ?', 'Alice').one()).toEqual({
      artistid: 123,
      artistname: 'Alice',
    });
    expect(() => sql.exec('SELECT * FROM artist').one()).toThrow(/exactly one/);
  });

  it('tracks rowsRead and rowsWritten', () => {
    const { sql } = freshSql();
    sql.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    const insert = sql.exec('INSERT INTO t (v) VALUES (?), (?), (?)', 'a', 'b', 'c');
    expect(insert.rowsWritten).toBe(3);
    expect(insert.rowsRead).toBe(0); // INSERT without RETURNING produces no rows

    const select = sql.exec('SELECT * FROM t');
    expect(select.rowsRead).toBe(3);
    expect(select.rowsWritten).toBe(0);

    const update = sql.exec('UPDATE t SET v = ? WHERE v = ?', 'z', 'a');
    expect(update.rowsWritten).toBe(1);
  });

  it('returns ArrayBuffer for BLOB columns and round-trips bound ArrayBuffers/Uint8Arrays', () => {
    const { sql } = freshSql();
    sql.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    sql.exec('INSERT INTO blobs (id, data) VALUES (1, ?)', bytes.buffer);
    sql.exec('INSERT INTO blobs (id, data) VALUES (2, ?)', bytes);

    for (const id of [1, 2]) {
      const row = sql.exec<{ data: ArrayBuffer }>('SELECT data FROM blobs WHERE id = ?', id).one();
      expect(row.data).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(row.data)).toEqual(bytes);
    }
  });

  it('loses precision on integers beyond 2^53 instead of throwing (documented deviation)', () => {
    const { sql } = freshSql();
    sql.exec('CREATE TABLE t (v INTEGER)');
    const big = 9_007_199_254_740_993n; // 2^53 + 1, not exactly representable as a JS number
    sql.exec('INSERT INTO t (v) VALUES (?)', big);
    const row = sql.exec<{ v: number }>('SELECT v FROM t').one();
    expect(typeof row.v).toBe('number');
    expect(row.v).toBe(Number(big));
  });
});

describe('sql.exec(): strictness, like workerd', () => {
  it.each(['BEGIN', 'begin transaction', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s1', 'RELEASE s1'])(
    'rejects %s',
    (statement) => {
      const { sql } = freshSql();
      expect(() => sql.exec(statement)).toThrow(/transaction-related statements/);
    },
  );

  it('rejects a boolean binding', () => {
    const { sql } = freshSql();
    sql.exec('CREATE TABLE t (v)');
    expect(() => sql.exec('INSERT INTO t (v) VALUES (?)', true)).toThrow(TypeError);
  });

  it('rejects an undefined binding', () => {
    const { sql } = freshSql();
    sql.exec('CREATE TABLE t (v)');
    expect(() => sql.exec('INSERT INTO t (v) VALUES (?)', undefined)).toThrow(TypeError);
  });

  it('allows null, string, number, and bigint bindings', () => {
    const { sql } = freshSql();
    sql.exec('CREATE TABLE t (v)');
    expect(() => sql.exec('INSERT INTO t (v) VALUES (?)', null)).not.toThrow();
    expect(() => sql.exec('INSERT INTO t (v) VALUES (?)', 'str')).not.toThrow();
    expect(() => sql.exec('INSERT INTO t (v) VALUES (?)', 42)).not.toThrow();
    expect(() => sql.exec('INSERT INTO t (v) VALUES (?)', 42n)).not.toThrow();
  });
});

describe('sql.exec(): multiple statements', () => {
  it('runs every statement, applying bindings and returning a cursor for the last one only', () => {
    const { sql } = freshSql();
    const cursor = sql.exec<{ b: number }>(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('first'); SELECT ? AS b",
      7,
    );
    expect(cursor.toArray()).toEqual([{ b: 7 }]);
    expect(sql.exec('SELECT v FROM t').toArray()).toEqual([{ v: 'first' }]);
  });

  it('still rejects a transaction statement buried in a multi-statement string', () => {
    const { sql } = freshSql();
    expect(() => sql.exec('CREATE TABLE t (v); BEGIN; SELECT 1')).toThrow(/transaction-related statements/);
  });
});

describe('transactionSync()', () => {
  it('commits on success', () => {
    const { state, sql } = freshSql();
    sql.exec('CREATE TABLE t (v TEXT)');
    state.storage.transactionSync(() => {
      sql.exec("INSERT INTO t (v) VALUES ('a')");
      sql.exec("INSERT INTO t (v) VALUES ('b')");
    });
    expect(sql.exec('SELECT v FROM t').toArray()).toEqual([{ v: 'a' }, { v: 'b' }]);
  });

  it('rolls back every write when the callback throws', () => {
    const { state, sql } = freshSql();
    sql.exec('CREATE TABLE t (v TEXT)');
    expect(() =>
      state.storage.transactionSync(() => {
        sql.exec("INSERT INTO t (v) VALUES ('a')");
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(sql.exec('SELECT v FROM t').toArray()).toEqual([]);
  });
});

describe('transaction()', () => {
  it('commits on success', async () => {
    const { state, sql } = freshSql();
    sql.exec('CREATE TABLE t (v TEXT)');
    await state.storage.transaction(async () => {
      sql.exec("INSERT INTO t (v) VALUES ('a')");
    });
    expect(sql.exec('SELECT v FROM t').toArray()).toEqual([{ v: 'a' }]);
  });

  it('rolls back when the callback throws', async () => {
    const { state, sql } = freshSql();
    sql.exec('CREATE TABLE t (v TEXT)');
    await expect(
      state.storage.transaction(async () => {
        sql.exec("INSERT INTO t (v) VALUES ('a')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sql.exec('SELECT v FROM t').toArray()).toEqual([]);
  });

  it('rolls back on txn.rollback()', async () => {
    const { state, sql } = freshSql();
    sql.exec('CREATE TABLE t (v TEXT)');
    await state.storage.transaction(async (txn) => {
      sql.exec("INSERT INTO t (v) VALUES ('a')");
      txn.rollback();
    });
    expect(sql.exec('SELECT v FROM t').toArray()).toEqual([]);
  });
});

describe('FTS5', () => {
  it('trigram tokenizer matches a substring that is not at a token boundary, and contentless_delete removes a row', () => {
    const { sql } = freshSql();
    sql.exec(
      "CREATE VIRTUAL TABLE msg_fts_meta USING fts5(subject, sender, tokenize='trigram', content='', contentless_delete=1)",
    );
    sql.exec('INSERT INTO msg_fts_meta(rowid, subject, sender) VALUES (1, ?, ?)', 'Your invoice is ready', 'billing@acme.com');

    // "voice" is a substring of "invoice", not a whole token: only a trigram tokenizer matches it.
    expect(sql.exec("SELECT rowid FROM msg_fts_meta WHERE msg_fts_meta MATCH 'voice'").toArray()).toEqual([{ rowid: 1 }]);

    sql.exec('DELETE FROM msg_fts_meta WHERE rowid = ?', 1);
    expect(sql.exec("SELECT rowid FROM msg_fts_meta WHERE msg_fts_meta MATCH 'voice'").toArray()).toEqual([]);
  });

  it("unicode61 remove_diacritics with detail=column: prefix search ignores accents, phrase queries are rejected", () => {
    const { sql } = freshSql();
    sql.exec(
      "CREATE VIRTUAL TABLE body_fts USING fts5(body, content='', contentless_delete=1, detail=column, tokenize='unicode61 remove_diacritics 2')",
    );
    sql.exec('INSERT INTO body_fts(rowid, body) VALUES (1, ?)', 'café invoice déjà vu');

    expect(sql.exec("SELECT rowid FROM body_fts WHERE body_fts MATCH 'cafe*'").toArray()).toEqual([{ rowid: 1 }]);

    // detail=column drops positional info, so phrase queries ("a b") are rejected by SQLite itself —
    // the design doc calls this out explicitly; this fake doesn't special-case it, the real engine does.
    expect(() => sql.exec('SELECT rowid FROM body_fts WHERE body_fts MATCH ?', '"cafe invoice"')).toThrow(/phrase queries/);
  });
});

describe('KV API', () => {
  it('async get/put/delete, single key and batch', async () => {
    const { state } = freshSql();
    await state.storage.put('a', { n: 1 });
    await state.storage.put({ b: 'two', c: [3] });
    expect(await state.storage.get('a')).toEqual({ n: 1 });

    const batch = await state.storage.get(['a', 'b', 'missing']);
    expect(batch).toBeInstanceOf(Map);
    expect(batch as Map<string, unknown>).toEqual(
      new Map<string, unknown>([
        ['a', { n: 1 }],
        ['b', 'two'],
      ]),
    );

    expect(await state.storage.delete('a')).toBe(true);
    expect(await state.storage.delete('a')).toBe(false);
    expect(await state.storage.delete(['b', 'c'])).toBe(2);
  });

  it('async list with prefix, start/startAfter/end, reverse, and limit', async () => {
    const { state } = freshSql();
    for (const key of ['a:1', 'a:2', 'a:3', 'b:1']) await state.storage.put(key, key);

    expect([...(await state.storage.list({ prefix: 'a:' })).keys()]).toEqual(['a:1', 'a:2', 'a:3']);
    expect([...(await state.storage.list({ prefix: 'a:', reverse: true })).keys()]).toEqual(['a:3', 'a:2', 'a:1']);
    expect([...(await state.storage.list({ prefix: 'a:', limit: 2 })).keys()]).toEqual(['a:1', 'a:2']);
    expect([...(await state.storage.list({ start: 'a:2' })).keys()]).toEqual(['a:2', 'a:3', 'b:1']);
    expect([...(await state.storage.list({ startAfter: 'a:2' })).keys()]).toEqual(['a:3', 'b:1']);
    expect([...(await state.storage.list({ end: 'a:3' })).keys()]).toEqual(['a:1', 'a:2']);
    await expect(state.storage.list({ start: 'a:2', startAfter: 'a:2' })).rejects.toThrow(/simultaneously/);
  });

  it('synchronous kv.get/put/delete/list mirror the async KV API', () => {
    const { state } = freshSql();
    state.storage.kv.put('x', 1);
    state.storage.kv.put('y', 2);
    expect(state.storage.kv.get('x')).toBe(1);
    expect(state.storage.kv.get('missing')).toBeUndefined();
    expect([...state.storage.kv.list()].map(([key]) => key)).toEqual(['x', 'y']);
    expect(state.storage.kv.delete('x')).toBe(true);
    expect(state.storage.kv.delete('x')).toBe(false);
  });
});

describe('alarms', () => {
  it('getAlarm/setAlarm/deleteAlarm', async () => {
    const { state } = freshSql();
    expect(await state.storage.getAlarm()).toBeNull();
    await state.storage.setAlarm(1000);
    expect(await state.storage.getAlarm()).toBe(1000);
    await state.storage.setAlarm(new Date(2000));
    expect(await state.storage.getAlarm()).toBe(2000);
    await state.storage.deleteAlarm();
    expect(await state.storage.getAlarm()).toBeNull();
  });

  it('fireAlarm() runs a pending alarm immediately and clears it first', async () => {
    const { state } = freshSql();
    const calls: Array<{ retryCount: number; isRetry: boolean } | undefined> = [];
    const object = { alarm: (info?: { retryCount: number; isRetry: boolean }) => void calls.push(info) };

    expect(await fireAlarm(state, object)).toBe(false);

    await state.storage.setAlarm(Date.now() + 60_000); // far in the future: fireAlarm ignores the time
    expect(await fireAlarm(state, object)).toBe(true);
    expect(calls).toEqual([{ retryCount: 0, isRetry: false }]);
    expect(await state.storage.getAlarm()).toBeNull();
  });

  it('fireAlarm() propagates an error from alarm() without rescheduling (no retry-with-backoff)', async () => {
    const { state } = freshSql();
    await state.storage.setAlarm(Date.now());
    const object = {
      alarm: () => {
        throw new Error('alarm failed');
      },
    };
    await expect(fireAlarm(state, object)).rejects.toThrow('alarm failed');
    expect(await state.storage.getAlarm()).toBeNull(); // cleared before running, unlike real workerd's retry
  });
});

describe('deleteAll()', () => {
  it('empties SQL tables and the KV store atomically, but leaves the alarm (pre-2026-02-24 default)', async () => {
    const { state, sql } = freshSql();
    sql.exec('CREATE TABLE t (v TEXT)');
    sql.exec("INSERT INTO t (v) VALUES ('a')");
    await state.storage.put('k', 'v');
    await state.storage.setAlarm(123);

    await state.storage.deleteAll();

    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='t'").toArray()).toEqual([]);
    expect(await state.storage.get('k')).toBeUndefined();
    expect(await state.storage.getAlarm()).toBe(123);
  });
});

describe('databaseSize', () => {
  it('is a positive number that grows as data is written', () => {
    const { sql } = freshSql();
    const empty = sql.databaseSize;
    expect(empty).toBeGreaterThan(0);

    sql.exec('CREATE TABLE t (v TEXT)');
    sql.exec("INSERT INTO t (v) VALUES (?)", 'x'.repeat(100_000));
    expect(sql.databaseSize).toBeGreaterThan(empty);
  });
});

describe('createSqliteDurableObjectState() options', () => {
  it('surfaces id, name and jurisdiction', () => {
    const state = createSqliteDurableObjectState({ id: 'abc123', name: 'mbx:ws_1:acc_1', jurisdiction: 'eu' });
    expect(state.id.toString()).toBe('abc123');
    expect((state.id as unknown as { name?: string }).name).toBe('mbx:ws_1:acc_1');
    expect((state as unknown as { jurisdiction?: string }).jurisdiction).toBe('eu');
  });

  it('blockConcurrencyWhile awaits and returns the callback result', async () => {
    const state = createSqliteDurableObjectState();
    const result = await state.blockConcurrencyWhile(async () => 42);
    expect(result).toBe(42);
  });

  it('waitUntil() records promises for a test to drain', async () => {
    const state = createSqliteDurableObjectState() as unknown as DurableObjectState & { __waitUntilPromises: Promise<unknown>[] };
    let ran = false;
    state.waitUntil(
      Promise.resolve().then(() => {
        ran = true;
      }),
    );
    await Promise.all(state.__waitUntilPromises);
    expect(ran).toBe(true);
  });
});
