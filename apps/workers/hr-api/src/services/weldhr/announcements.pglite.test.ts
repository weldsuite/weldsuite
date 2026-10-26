/**
 * Announcements: who they are meant for (everyone, or a department and the
 * ones under it), the unread count, and HR's view of who has read one.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  announcementReads,
  announcementRecipients,
  announcementsForEmployee,
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  markAnnouncementRead,
  unreadAnnouncementCount,
  updateAnnouncement,
} from './announcements';
import { announcementPreview } from './announcement-push';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.hrDepartments).values([
    { id: 'dep_an_store', name: 'Store' },
    { id: 'dep_an_tills', name: 'Tills', parentId: 'dep_an_store' },
    { id: 'dep_an_office', name: 'Office' },
  ]);
  await db.insert(schema.hrEmployees).values([
    { id: 'emp_an_ann', firstName: 'Ann', lastName: 'Adams', email: 'ann@example.com', status: 'active', departmentId: 'dep_an_tills', userId: 'user_ann' },
    { id: 'emp_an_ben', firstName: 'Ben', lastName: 'Baker', email: 'ben@example.com', status: 'active', departmentId: 'dep_an_office', userId: 'user_ben' },
    { id: 'emp_an_cas', firstName: 'Cas', lastName: 'Cole', email: 'cas@example.com', status: 'active' },
    { id: 'emp_an_old', firstName: 'Old', lastName: 'Timer', email: 'old@example.com', status: 'terminated', departmentId: 'dep_an_tills', userId: 'user_old' },
  ]);
}, 60_000);

describe('announcements', () => {
  let everyone: string;
  let store: string;

  beforeAll(async () => {
    everyone = (await createAnnouncement(db, { title: 'Summer party', body: 'Friday 18:00\nin the canteen' }, 'user_hr')).id;
    store = (await createAnnouncement(db, { title: 'New tills', body: 'Training on Monday', departmentIds: ['dep_an_store'], pinned: true }, 'user_hr')).id;
  });

  it('reaches a department and the ones under it, everyone when it names none', async () => {
    expect((await announcementsForEmployee(db, 'emp_an_ann')).announcements.map((a) => a.id)).toEqual([store, everyone]);
    expect((await announcementsForEmployee(db, 'emp_an_ben')).announcements.map((a) => a.id)).toEqual([everyone]);
    expect((await announcementsForEmployee(db, 'emp_an_cas')).announcements.map((a) => a.id)).toEqual([everyone]);
    await expect(markAnnouncementRead(db, store, 'emp_an_ben')).rejects.toThrow('not found');
  });

  it('pushes to the audience’s members only, never to someone who left', async () => {
    const [row] = await db.select().from(schema.hrAnnouncements).where(eq(schema.hrAnnouncements.id, store));
    expect(await announcementRecipients(db, row!)).toEqual(['user_ann']);
  });

  it('counts unread, and keeps the first read', async () => {
    expect(await unreadAnnouncementCount(db, 'emp_an_ann')).toBe(2);
    const first = await markAnnouncementRead(db, everyone, 'emp_an_ann');
    const again = await markAnnouncementRead(db, everyone, 'emp_an_ann');
    expect(again.readAt).toEqual(first.readAt);
    const mine = await announcementsForEmployee(db, 'emp_an_ann');
    expect(mine.unread).toBe(1);
    expect(mine.announcements.find((a) => a.id === everyone)?.readAt).toBeTruthy();
    expect(await unreadAnnouncementCount(db, 'emp_an_ann')).toBe(1);
  });

  it('shows HR the audience and who has read it, unread first', async () => {
    const listed = await listAnnouncements(db);
    expect(listed.map((a) => a.id)).toEqual([store, everyone]);
    expect(listed.find((a) => a.id === everyone)).toMatchObject({ audienceCount: 3, readCount: 1, departmentNames: [] });
    expect(listed.find((a) => a.id === store)).toMatchObject({ audienceCount: 1, readCount: 0, departmentNames: ['Store'] });
    const reads = await announcementReads(db, everyone);
    expect(reads.map((r) => [r.employeeName, Boolean(r.readAt)])).toEqual([
      ['Ben Baker', false],
      ['Cas Cole', false],
      ['Ann Adams', true],
    ]);
  });

  it('moves with a new audience, and is gone once deleted', async () => {
    await updateAnnouncement(db, store, { departmentIds: ['dep_an_office'] });
    expect((await announcementsForEmployee(db, 'emp_an_ben')).announcements.map((a) => a.id)).toContain(store);
    await expect(updateAnnouncement(db, store, { departmentIds: ['dep_nope'] })).rejects.toThrow('not found');
    await deleteAnnouncement(db, store);
    expect((await announcementsForEmployee(db, 'emp_an_ben')).announcements.map((a) => a.id)).toEqual([everyone]);
  });
});

describe('announcementPreview', () => {
  it('flattens the body and cuts it short', () => {
    expect(announcementPreview('Friday 18:00\n\nin the   canteen')).toBe('Friday 18:00 in the canteen');
    const long = announcementPreview('x'.repeat(400));
    expect(long).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);
  });
});
