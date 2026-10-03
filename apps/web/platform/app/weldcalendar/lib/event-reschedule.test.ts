import { describe, it, expect } from 'vitest';
import { getCurrentSlot, getNotifiableGuests, isSameSlot } from './event-reschedule';

describe('getNotifiableGuests', () => {
  const attendees = [
    { email: 'me@example.com', name: 'Me' },
    { email: 'Ada@Example.com' },
    { email: '' },
  ];

  it('drops the signed-in user and empty addresses', () => {
    expect(getNotifiableGuests({ attendees }, 'ME@example.com').map((a) => a.email)).toEqual(['Ada@Example.com']);
  });

  it('returns every address when the user is unknown, and [] without attendees', () => {
    expect(getNotifiableGuests({ attendees }).map((a) => a.email)).toEqual(['me@example.com', 'Ada@Example.com']);
    expect(getNotifiableGuests({})).toEqual([]);
  });
});

describe('getCurrentSlot / isSameSlot', () => {
  const event = { startTime: '2026-10-05T09:00:00.000Z', endTime: '2026-10-05T10:30:00.000Z' };

  it('returns ISO strings of the stored slot', () => {
    expect(getCurrentSlot(event)).toEqual({ startTime: '2026-10-05T09:00:00.000Z', endTime: '2026-10-05T10:30:00.000Z' });
  });

  it('assumes one hour when the event has no end', () => {
    expect(getCurrentSlot({ startTime: '2026-10-05T09:00:00.000Z' }).endTime).toBe('2026-10-05T10:00:00.000Z');
  });

  it('detects a no-op move', () => {
    expect(isSameSlot(event, new Date(event.startTime), new Date(event.endTime))).toBe(true);
    expect(isSameSlot(event, new Date('2026-10-05T09:15:00.000Z'), new Date(event.endTime))).toBe(false);
  });
});
