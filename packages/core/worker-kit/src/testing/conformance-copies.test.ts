import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { copyForTypeScript } from './conformance';

describe('the copy the TypeScript side of a write runs on', () => {
  const main = new PGlite();
  afterAll(() => main.close());
  const count = async (db: Awaited<ReturnType<typeof copyForTypeScript>>['db']) =>
    ((await db.execute(sql`select count(*)::int as n from notes`)) as unknown as { rows: { n: number }[] }).rows[0]?.n;

  it('is taken again only once either database was written', async () => {
    await main.exec('create table notes (id text primary key, body text)');
    const first = await copyForTypeScript(main, 'tenant');
    await first.done();

    // Nothing wrote: the next write runs on the same copy.
    const second = await copyForTypeScript(main, 'tenant');
    expect(second.db).toBe(first.db);
    await second.done();

    // The source changed (Rust's side of a write, a test seeding it): a new copy, with the row.
    await main.query("insert into notes values ('n1', 'a')");
    const third = await copyForTypeScript(main, 'tenant');
    expect(third.db).not.toBe(first.db);
    expect(await count(third.db)).toBe(1);

    // The TypeScript side wrote to its copy: the next write gets a new one, without that row.
    await third.db.execute(sql`insert into notes values ('n2', 'b')`);
    await third.done();
    const fourth = await copyForTypeScript(main, 'tenant');
    expect(fourth.db).not.toBe(third.db);
    expect(await count(fourth.db)).toBe(1);
    await fourth.done();

    // A write that failed still counts as one.
    await main.query("insert into notes values ('n1', 'again')").catch(() => undefined);
    const fifth = await copyForTypeScript(main, 'tenant');
    expect(fifth.db).not.toBe(fourth.db);
    await fifth.done();
  }, 60_000);
});
