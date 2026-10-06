/**
 * pglite-backed service tests for `activities.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createActivity } from './activities';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('activities service · pglite integration', () => {
  it('defaults status/priority and assignedToId to the acting user', async () => {
    const result = await createActivity(db, { type: 'note', subject: 'Called about renewal' }, 'user_1');
    expect(result.row.status).toBe('planned');
    expect(result.row.priority).toBe('medium');
    expect(result.row.assignedToId).toBe('user_1');
    expect(result.eventData).toMatchObject({
      id: result.id,
      type: 'note',
      subject: 'Called about renewal',
      status: 'planned',
      assigneeId: 'user_1',
    });

    const [persisted] = await db.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, result.id));
    expect(persisted).toMatchObject({ type: 'note', subject: 'Called about renewal', assignedToId: 'user_1' });
  });

  it('accepts a direct personId link', async () => {
    const result = await createActivity(
      db,
      { type: 'call', subject: 'Discovery call', personId: 'person_1' },
      'user_1',
    );
    const [persisted] = await db.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, result.id));
    expect(persisted?.personId).toBe('person_1');
  });

  it('an explicit assignedToId wins over the acting user', async () => {
    const result = await createActivity(
      db,
      { type: 'task', subject: 'Follow up', assignedToId: 'assignee_2' },
      'user_1',
    );
    expect(result.row.assignedToId).toBe('assignee_2');
  });

  it('throws when neither assignedToId nor an acting user is given', async () => {
    await expect(createActivity(db, { type: 'note', subject: 'No assignee' })).rejects.toThrow(
      'assignedToId required',
    );
  });
});
