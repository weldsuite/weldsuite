import { describe, it, expect } from 'vitest';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import {
  buildInvitationEmail,
  buildInvitationIcs,
  buildMeetingJoinUrl,
  getMeetingPortalUrl,
  mergeInvitees,
  normalizeInvitees,
  type ResolvedInvitee,
} from './invitations';

const guest = (email: string, extra: Partial<ResolvedInvitee> = {}): ResolvedInvitee => ({
  email,
  name: email,
  userId: '',
  ...extra,
});

describe('normalizeInvitees', () => {
  it('lowercases, trims and de-duplicates by email (first one wins)', () => {
    expect(
      normalizeInvitees([
        { email: ' WeldHost@Gmail.com ', name: ' Weld ' },
        { email: 'weldhost@gmail.com', name: 'Other' },
        { email: 'b@example.com' },
      ]),
    ).toEqual([
      { email: 'weldhost@gmail.com', name: 'Weld' },
      { email: 'b@example.com' },
    ]);
  });
});

describe('mergeInvitees', () => {
  const organizer: MeetingAttendee = {
    userId: 'user_org',
    email: 'org@acme.com',
    name: 'Org',
    status: 'accepted',
    role: 'organizer',
  };

  it('adds new invitees as pending attendees', () => {
    const result = mergeInvitees([organizer], [guest('weldhost@gmail.com', { personId: 'per_1' })]);
    expect(result.added).toEqual([
      {
        userId: '',
        email: 'weldhost@gmail.com',
        name: 'weldhost@gmail.com',
        status: 'pending',
        role: 'attendee',
        personId: 'per_1',
      },
    ]);
    expect(result.attendees).toHaveLength(2);
    expect(result.alreadyInvited).toEqual([]);
  });

  it('leaves existing attendees untouched (matched by email or user id)', () => {
    const result = mergeInvitees(
      [organizer],
      [guest('ORG@acme.com'.toLowerCase()), guest('other@acme.com', { userId: 'user_org' })],
    );
    expect(result.added).toEqual([]);
    expect(result.alreadyInvited).toEqual(['org@acme.com', 'other@acme.com']);
    expect(result.attendees).toEqual([organizer]);
  });

  it('promotes a walk-in guest to an invited attendee', () => {
    const walkIn: MeetingAttendee = {
      userId: 'guest:abc',
      email: 'walk@in.com',
      name: 'Walk In',
      status: 'accepted',
      role: 'attendee',
      source: 'walk_in',
    };
    const result = mergeInvitees([walkIn], [guest('walk@in.com')]);
    expect(result.added).toHaveLength(1);
    expect(result.attendees[0]?.source).toBeUndefined();
    expect(walkIn.source).toBe('walk_in');
  });
});

describe('join url', () => {
  it('defaults to the production portal and strips trailing slashes', () => {
    expect(getMeetingPortalUrl(undefined)).toBe('https://meet.weldsuite.org');
    expect(getMeetingPortalUrl('http://localhost:3020/')).toBe('http://localhost:3020');
    expect(buildMeetingJoinUrl('https://meet.weldsuite.org', 'org_1', 'wm-abc-def-ghi')).toBe(
      'https://meet.weldsuite.org/org_1/wm-abc-def-ghi',
    );
  });
});

describe('invitation email', () => {
  const base = {
    meeting: { id: 'mtg_1', title: 'Sync <script>', description: null },
    organizer: { name: 'Gert', email: 'gert@acme.com' },
    joinUrl: 'https://meet.weldsuite.org/org_1/wm-abc-def-ghi',
  };

  it('contains the join link and escapes the title', () => {
    const { subject, html, text } = buildInvitationEmail(base);
    expect(subject).toBe('Gert invited you to "Sync <script>"');
    expect(html).toContain('href="https://meet.weldsuite.org/org_1/wm-abc-def-ghi"');
    expect(html).toContain('Sync &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(text).toContain('https://meet.weldsuite.org/org_1/wm-abc-def-ghi');
  });

  it('builds an .ics only when the meeting is scheduled', () => {
    const attendee = { email: 'weldhost@gmail.com' };
    expect(buildInvitationIcs({ ...base, attendee })).toBeNull();

    const ics = buildInvitationIcs({
      ...base,
      meeting: { ...base.meeting, scheduledStart: '2026-10-05T09:00:00.000Z' },
      attendee,
    });
    // Unfold RFC 5545 continuation lines before matching.
    const unfolded = ics?.replace(/\r\n /g, '');
    expect(unfolded).toContain('DTSTART:20261005T090000Z');
    // No end time → one hour.
    expect(unfolded).toContain('DTEND:20261005T100000Z');
    expect(unfolded).toContain('mailto:weldhost@gmail.com');
    expect(unfolded).toContain('UID:mtg_1@meet.weldsuite.org');
  });
});
