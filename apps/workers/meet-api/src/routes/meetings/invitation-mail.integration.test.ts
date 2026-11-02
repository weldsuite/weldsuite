/**
 * POST /api/meetings/:id/invitations with the worker's `SEND_EMAIL` binding:
 * the `meet.invitation` mail itself (recipients, subject, the `.ics` of a
 * scheduled meeting), which ./integration.test.ts never sends. The
 * conformance harness compares both backends' messages per envelope; this
 * test reads the raw message only for what it is about. The outbound guard
 * runs for real: without an `OUTBOUND_LEDGER` it lets the batch through.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { meetingsRoutes } from './index';
import { fakeKv } from '../../test/fakes';
import type { Env, Variables } from '../../types';

const ORGANIZER = 'user_mail_organizer';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master
    .insert(masterSchema.workspaces)
    .values({ id: 'ws_test_default', clerkOrgId: 'org_test_default', name: 'Mail', slug: 'meet-mail' } as typeof masterSchema.workspaces.$inferInsert);
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_mail_org',
    userId: ORGANIZER,
    email: 'olga@example.com',
    name: 'Olga Organizer',
  });
  await db.insert(schema.meetings).values([
    {
      id: 'mtg_mail_scheduled',
      title: 'Quarterly review',
      description: 'Numbers and next steps',
      organizerId: ORGANIZER,
      status: 'scheduled',
      accessType: 'anyone_with_link',
      joinCode: 'wm-abc-def-ghi',
      scheduledStart: new Date('2026-12-01T09:00:00.000Z'),
      scheduledEnd: new Date('2026-12-01T10:30:00.000Z'),
    },
    {
      id: 'mtg_mail_open',
      title: 'Open office hours',
      organizerId: ORGANIZER,
      status: 'scheduled',
      accessType: 'anyone_with_link',
      joinCode: 'wm-jkl-mno-pqr',
    },
  ]);
}, 60_000);

/** The `SEND_EMAIL` binding the invitations go through. */
let mail = createSendEmailStub();

beforeEach(() => {
  mail = createSendEmailStub();
});

/** The raw message sent to `email`. */
const rawTo = (email: string) => mail.sent.find((m) => m.to === email)?.raw ?? '';

function invite(meetingId: string, body: unknown) {
  const { request } = createTestApp<Env, Variables>('/api/meetings', meetingsRoutes, {
    context: { permissions: permissions('meetings:update'), userId: ORGANIZER, tenantDb: db, masterDb: master },
    env: { WORKSPACE_CACHE: fakeKv(), MEETING_PORTAL_URL: 'https://meet.example.com', SEND_EMAIL: mail as never } as Partial<Env>,
  });
  return request(`/api/meetings/${meetingId}/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type Invited = { data: { invited: Array<{ email: string; emailSent: boolean }>; alreadyInvited: string[] } };

describe('the invitation mail', () => {
  it('mails each new invitee the join link, with a calendar file for a scheduled meeting', async () => {
    const res = await invite('mtg_mail_scheduled', {
      invitees: [{ email: 'guest@example.com', name: 'Gus Guest' }, { email: 'second@example.com' }],
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Invited;
    expect(data.invited).toEqual([
      { email: 'guest@example.com', name: 'Gus Guest', emailSent: true },
      { email: 'second@example.com', name: 'second', emailSent: true },
    ]);

    expect(mail.sent.map((m) => m.to).sort()).toEqual(['guest@example.com', 'second@example.com']);
    const toGus = rawTo('guest@example.com');
    expect(toGus).toContain('Quarterly review');
    expect(toGus).toMatch(/^reply-to:.*olga@example\.com/im);
    expect(toGus).toMatch(/text\/calendar/i);

    // Invited once: a second invitation mails nobody.
    mail = createSendEmailStub();
    const again = (await (await invite('mtg_mail_scheduled', { invitees: [{ email: 'guest@example.com' }] })).json()) as Invited;
    expect(again.data.alreadyInvited).toEqual(['guest@example.com']);
    expect(mail.sent).toHaveLength(0);
  });

  it('sends no calendar file for an unscheduled meeting, and nothing when asked not to', async () => {
    const res = await invite('mtg_mail_open', { invitees: [{ email: 'drop-in@example.com', name: 'Dee' }] });
    expect(((await res.json()) as Invited).data.invited).toEqual([{ email: 'drop-in@example.com', name: 'Dee', emailSent: true }]);
    expect(mail.sent).toHaveLength(1);
    expect(rawTo('drop-in@example.com')).toContain('Open office hours');
    expect(rawTo('drop-in@example.com')).not.toMatch(/text\/calendar/i);

    mail = createSendEmailStub();
    const quiet = await invite('mtg_mail_open', { invitees: [{ email: 'quiet@example.com' }], sendEmail: false });
    expect(((await quiet.json()) as Invited).data.invited).toEqual([{ email: 'quiet@example.com', name: 'quiet', emailSent: false }]);
    expect(mail.sent).toHaveLength(0);
    const [row] = await db.select({ attendees: schema.meetings.attendees }).from(schema.meetings).where(eq(schema.meetings.id, 'mtg_mail_open'));
    expect(row?.attendees?.map((a) => a.email)).toEqual(expect.arrayContaining(['drop-in@example.com', 'quiet@example.com']));
  });
});
