/**
 * upsertMailContacts: every address on a message becomes a `people` row, and
 * each newly created person gets an initials-SVG avatar in R2 with its public
 * URL written back to `people.avatar_url`. R2 is a recording fake.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { upsertMailContacts } from './contacts';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';

const { people } = schema;
const PUBLIC_URL = 'https://files.test.dev';

function fakeStorage() {
  const puts: { key: string; body: string; contentType?: string }[] = [];
  const bucket = {
    async put(key: string, body: string, opts?: { httpMetadata?: { contentType?: string } }) {
      puts.push({ key, body, contentType: opts?.httpMetadata?.contentType });
      return null;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

describe('upsertMailContacts', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 60_000);

  async function personFor(email: string) {
    const rows = await db.select().from(people).where(eq(people.email, email));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it('creates a person per address and stores an avatar on each new one', async () => {
    const { bucket, puts } = fakeStorage();
    await upsertMailContacts({ STORAGE: bucket, R2_PUBLIC_URL: PUBLIC_URL }, db, 'org_avatar', {
      from: { email: 'Ada@Example.com', name: 'Ada Lovelace' },
      to: [{ email: 'team@example.com' }],
    });

    const ada = await personFor('ada@example.com');
    const team = await personFor('team@example.com');
    expect(ada.id).toMatch(/^person_/);

    for (const person of [ada, team]) {
      const key = `workspaces/org_avatar/avatars/people/${person.id}/logo.svg`;
      expect(person.avatarUrl).toBe(`${PUBLIC_URL}/${key}`);
      const put = puts.find((p) => p.key === key);
      expect(put?.contentType).toBe('image/svg+xml');
      expect(put?.body).toContain('<svg');
    }
    // Seeded on the display name, so the initials are the name's, not the address's.
    expect(puts.find((p) => p.key.includes(ada.id))?.body).toContain('>AL<');
  });

  it('leaves an existing person and its avatar alone', async () => {
    const { bucket, puts } = fakeStorage();
    const before = await personFor('ada@example.com');

    await upsertMailContacts({ STORAGE: bucket, R2_PUBLIC_URL: PUBLIC_URL }, db, 'org_other', {
      from: { email: 'ada@example.com', name: 'Someone Else' },
    });

    expect(puts).toHaveLength(0);
    expect((await personFor('ada@example.com')).avatarUrl).toBe(before.avatarUrl);
  });

  it('still creates people without storage, just no avatar', async () => {
    await upsertMailContacts({}, db, 'org_avatar', { to: [{ email: 'nostorage@example.com' }] });

    const rows = await db.select().from(people).where(inArray(people.email, ['nostorage@example.com']));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.avatarUrl).toBeNull();
  });
});
