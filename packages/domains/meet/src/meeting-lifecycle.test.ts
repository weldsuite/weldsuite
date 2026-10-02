import { describe, it, expect } from 'vitest';
import { collectLinkedPeople, isMeetingPast } from './meeting-lifecycle';

describe('collectLinkedPeople', () => {
  it('returns nothing for workspace members (no person or contact link)', () => {
    expect(collectLinkedPeople([{}, {}], [{}])).toEqual([]);
  });

  it('takes people from session participants and meeting attendees, once each', () => {
    const people = collectLinkedPeople(
      [{ personId: 'per_a' }, { personId: 'per_b', contactId: 'con_b' }],
      [{ personId: 'per_a' }, { personId: 'per_c' }],
    );
    expect(people).toEqual([
      { personId: 'per_a', contactId: null },
      { personId: 'per_b', contactId: 'con_b' },
      { personId: 'per_c', contactId: null },
    ]);
  });

  it('keeps a legacy contact-only link, but not when a person already carries it', () => {
    const people = collectLinkedPeople(
      [{ contactId: 'con_old' }, { personId: 'per_b', contactId: 'con_b' }],
      [{ contactId: 'con_b' }, { contactId: 'con_old' }],
    );
    expect(people).toEqual([
      { personId: 'per_b', contactId: 'con_b' },
      { personId: null, contactId: 'con_old' },
    ]);
  });

  it('fills in the contact back-reference from a later entry of the same person', () => {
    expect(collectLinkedPeople([{ personId: 'per_a' }], [{ personId: 'per_a', contactId: 'con_a' }])).toEqual([
      { personId: 'per_a', contactId: 'con_a' },
    ]);
  });
});

describe('isMeetingPast', () => {
  const now = new Date('2026-10-02T12:00:00Z');

  it('keeps unscheduled rooms reusable and uses end, else start + 1h', () => {
    expect(isMeetingPast(undefined, now)).toBe(false);
    expect(isMeetingPast({ scheduledStart: null, scheduledEnd: new Date('2026-10-02T11:00:00Z') }, now)).toBe(true);
    expect(isMeetingPast({ scheduledStart: new Date('2026-10-02T11:30:00Z'), scheduledEnd: null }, now)).toBe(false);
  });
});
