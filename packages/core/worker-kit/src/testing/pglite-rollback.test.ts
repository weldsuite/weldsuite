import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { heldByTypeScript, typeScriptSide } from './pglite-rollback';

describe('the TypeScript side of a write, on a rolled back transaction', () => {
  const main = new PGlite();
  afterAll(() => main.close());
  const ids = async () => (await main.query<{ id: string }>('select id from notes order by id')).rows.map((r) => r.id);

  it('runs each statement as autocommit would, and leaves the database as it found it', async () => {
    await main.exec("create table notes (id text primary key, body text); insert into notes values ('a', 'kept')");
    const side = await typeScriptSide(main, 'tenant');
    expect(heldByTypeScript(main)).toBeInstanceOf(Promise);

    await side.db.execute(sql`insert into notes values ('b', 'one')`);
    // A failed statement undoes itself only; the next one runs.
    await expect(side.db.execute(sql`insert into notes values ('a', 'again')`)).rejects.toThrow();
    await side.db.execute(sql`insert into notes values ('c', 'two')`);
    // A transaction of its own is all or nothing.
    await expect(
      side.db.transaction(async (tx) => {
        await tx.execute(sql`insert into notes values ('d', 'three')`);
        await tx.execute(sql`insert into notes values ('a', 'clash')`);
      }),
    ).rejects.toThrow();
    await side.db.transaction(async (tx) => {
      await tx.execute(sql`insert into notes values ('e', 'four')`);
    });
    // Statements started together run one after the other.
    await Promise.all([
      side.db.execute(sql`insert into notes values ('f', 'five')`),
      side.db.execute(sql`insert into notes values ('g', 'six')`),
    ]);
    const seen = (await side.db.execute(sql`select id from notes order by id`)) as unknown as { rows: { id: string }[] };
    expect(seen.rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'e', 'f', 'g']);

    await side.close();
    expect(heldByTypeScript(main)).toBeUndefined();
    expect(main.isInTransaction()).toBe(false);
    expect(await ids()).toEqual(['a']);
    // Anything that comes late finds the side closed, and writes nothing.
    const late = (await side.db.execute(sql`insert into notes values ('z', 'late')`).catch((error: unknown) => error)) as Error;
    expect(String((late.cause as Error | undefined)?.message ?? late.message)).toMatch(/over/);
    expect(await ids()).toEqual(['a']);
  }, 60_000);
});
