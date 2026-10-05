/**
 * Booking-page availability: which events block a slot, overrides, notice,
 * horizon and the per-day booking cap. DB-backed (pglite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { computeAvailableSlots, type BookingPageSlotConfig, type TimeSlot } from './calendar-slots';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

let seq = 0;
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

// 2030-03-05 is a Tuesday. "Now" is a few days earlier so minNotice never bites
// unless a test moves it.
const DATE = '2030-03-05';
const NOW = Date.UTC(2030, 2, 1, 12, 0, 0);

const emptyWeek = {
  monday: [],
  tuesday: [],
  wednesday: [],
  thursday: [],
  friday: [],
  saturday: [],
  sunday: [],
};

function pageConfig(ownerId: string, extra: Partial<BookingPageSlotConfig> = {}): BookingPageSlotConfig {
  return {
    id: generateId('bpg'),
    ownerId,
    // 09:00-12:00 UTC on Tuesdays: three one-hour slots.
    availability: { ...emptyWeek, tuesday: [{ start: '09:00', end: '12:00' }] },
    timezone: 'UTC',
    duration: 60,
    bufferBefore: 0,
    bufferAfter: 0,
    minNotice: 60,
    maxAdvance: null,
    dateOverrides: null,
    maxBookingsPerDay: null,
    ...extra,
  };
}

async function seedCalendar(ownerId: string): Promise<string> {
  const id = generateId('cal');
  await db.insert(schema.calendars).values({
    id,
    name: `${ownerId} cal`,
    ownerId,
    isDefault: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedEvent(
  calendarId: string,
  organizerId: string,
  start: string,
  end: string | null,
  extra: Partial<typeof schema.calendarEvents.$inferInsert> = {},
): Promise<void> {
  await db.insert(schema.calendarEvents).values({
    id: generateId('evt'),
    calendarId,
    organizerId,
    title: 'Busy',
    type: 'meeting',
    startTime: new Date(start),
    endTime: end ? new Date(end) : null,
    ...extra,
  });
}

const available = (slots: TimeSlot[]) => slots.filter((s) => s.available).map((s) => s.start.slice(11, 16));

describe('computeAvailableSlots', () => {
  it('offers every slot of the weekday window on an empty calendar', async () => {
    const owner = `user_slots_${next()}`;
    const slots = await computeAvailableSlots(db, pageConfig(owner), DATE, NOW);
    expect(available(slots)).toEqual(['09:00', '10:00', '11:00']);
  });

  describe('which events block', () => {
    it('a multi-day all-day event blocks every day it covers, not only its first', async () => {
      const owner = `user_multi_${next()}`;
      const cal = await seedCalendar(owner);
      // Sun 3 March 00:00 .. Wed 6 March 00:00 UTC, all day.
      await seedEvent(cal, owner, '2030-03-03T00:00:00Z', '2030-03-06T00:00:00Z', { allDay: true });
      const slots = await computeAvailableSlots(db, pageConfig(owner), DATE, NOW);
      expect(slots).toHaveLength(3);
      expect(available(slots)).toEqual([]);
      // The day after the event is free again.
      const after = await computeAvailableSlots(
        db,
        pageConfig(owner, { availability: { ...emptyWeek, thursday: [{ start: '09:00', end: '12:00' }] } }),
        '2030-03-07',
        NOW,
      );
      expect(available(after)).toEqual(['09:00', '10:00', '11:00']);
    });

    it('an event that started the day before and runs into the day blocks the overlapped slot', async () => {
      const owner = `user_overnight_${next()}`;
      const cal = await seedCalendar(owner);
      await seedEvent(cal, owner, '2030-03-04T22:00:00Z', '2030-03-05T09:30:00Z');
      const slots = await computeAvailableSlots(db, pageConfig(owner), DATE, NOW);
      expect(available(slots)).toEqual(['10:00', '11:00']);
    });

    it('an event that ends exactly when the day starts does not block it', async () => {
      const owner = `user_edge_${next()}`;
      const cal = await seedCalendar(owner);
      await seedEvent(cal, owner, '2030-03-04T22:00:00Z', '2030-03-05T00:00:00Z');
      const slots = await computeAvailableSlots(db, pageConfig(owner), DATE, NOW);
      expect(available(slots)).toEqual(['09:00', '10:00', '11:00']);
    });

    it('tentative events block, cancelled ones do not, deleted ones do not', async () => {
      const owner = `user_status_${next()}`;
      const cal = await seedCalendar(owner);
      await seedEvent(cal, owner, '2030-03-05T09:00:00Z', '2030-03-05T10:00:00Z', { status: 'tentative' });
      await seedEvent(cal, owner, '2030-03-05T10:00:00Z', '2030-03-05T11:00:00Z', { status: 'cancelled' });
      await seedEvent(cal, owner, '2030-03-05T11:00:00Z', '2030-03-05T12:00:00Z', { deletedAt: new Date() });
      const slots = await computeAvailableSlots(db, pageConfig(owner), DATE, NOW);
      expect(available(slots)).toEqual(['10:00', '11:00']);
    });

    it('an event without an end counts as 30 minutes', async () => {
      const owner = `user_noend_${next()}`;
      const cal = await seedCalendar(owner);
      await seedEvent(cal, owner, '2030-03-05T10:15:00Z', null);
      const slots = await computeAvailableSlots(db, pageConfig(owner), DATE, NOW);
      expect(available(slots)).toEqual(['09:00', '11:00']);
    });

    it('an event another member organised on one of the owner\'s calendars blocks; on someone else\'s calendar it does not', async () => {
      const owner = `user_cal_owner_${next()}`;
      const other = `user_cal_other_${next()}`;
      const ownerCal = await seedCalendar(owner);
      const otherCal = await seedCalendar(other);
      await seedEvent(ownerCal, other, '2030-03-05T09:00:00Z', '2030-03-05T10:00:00Z');
      await seedEvent(otherCal, other, '2030-03-05T10:00:00Z', '2030-03-05T11:00:00Z');
      const slots = await computeAvailableSlots(db, pageConfig(owner), DATE, NOW);
      expect(available(slots)).toEqual(['10:00', '11:00']);
    });

    it('buffers widen the conflict window', async () => {
      const owner = `user_buffer_${next()}`;
      const cal = await seedCalendar(owner);
      await seedEvent(cal, owner, '2030-03-05T10:00:00Z', '2030-03-05T11:00:00Z');
      const slots = await computeAvailableSlots(
        db,
        pageConfig(owner, { bufferBefore: 15, bufferAfter: 15 }),
        DATE,
        NOW,
      );
      expect(available(slots)).toEqual([]);
    });
  });

  describe('minNotice and maxAdvance', () => {
    it('slots inside the minimum notice are unavailable', async () => {
      const owner = `user_notice_${next()}`;
      // 08:30 on the day; 100 minutes of notice (earliest 10:10) leaves only the 11:00 slot.
      const now = Date.UTC(2030, 2, 5, 8, 30, 0);
      const slots = await computeAvailableSlots(db, pageConfig(owner, { minNotice: 100 }), DATE, now);
      expect(available(slots)).toEqual(['11:00']);
    });

    it('a date further ahead than maxAdvance days has no available slots', async () => {
      const owner = `user_adv_${next()}`;
      // NOW is 4 days before DATE.
      const within = await computeAvailableSlots(db, pageConfig(owner, { maxAdvance: 5 }), DATE, NOW);
      expect(available(within)).toEqual(['09:00', '10:00', '11:00']);
      const beyond = await computeAvailableSlots(db, pageConfig(owner, { maxAdvance: 3 }), DATE, NOW);
      expect(available(beyond)).toEqual([]);
    });

    it('a null maxAdvance means no horizon', async () => {
      const owner = `user_adv_null_${next()}`;
      const far = await computeAvailableSlots(db, pageConfig(owner, { maxAdvance: null }), DATE, Date.UTC(2020, 0, 1));
      expect(available(far)).toEqual(['09:00', '10:00', '11:00']);
    });
  });

  describe('dateOverrides', () => {
    it('an override replaces the weekly availability for that date only', async () => {
      const owner = `user_ovr_${next()}`;
      const config = pageConfig(owner, {
        dateOverrides: [{ date: DATE, slots: [{ start: '13:00', end: '15:00' }] }],
      });
      expect(available(await computeAvailableSlots(db, config, DATE, NOW))).toEqual(['13:00', '14:00']);
      // The following Tuesday is untouched.
      expect(available(await computeAvailableSlots(db, config, '2030-03-12', NOW))).toEqual([
        '09:00',
        '10:00',
        '11:00',
      ]);
    });

    it('an override with no slots closes the day', async () => {
      const owner = `user_ovr_closed_${next()}`;
      const config = pageConfig(owner, { dateOverrides: [{ date: DATE, slots: [] }] });
      expect(await computeAvailableSlots(db, config, DATE, NOW)).toEqual([]);
    });

    it('an override can open a day the weekly availability has closed', async () => {
      const owner = `user_ovr_open_${next()}`;
      // 2030-03-06 is a Wednesday, which has no weekly availability.
      const config = pageConfig(owner, {
        dateOverrides: [{ date: '2030-03-06', slots: [{ start: '09:00', end: '10:00' }] }],
      });
      expect(available(await computeAvailableSlots(db, config, '2030-03-06', NOW))).toEqual(['09:00']);
    });
  });

  describe('maxBookingsPerDay', () => {
    async function seedBooking(pageId: string, start: string, status = 'confirmed', deleted = false) {
      await db.insert(schema.calendarBookings).values({
        id: generateId('bkg'),
        bookingPageId: pageId,
        bookerName: 'Booker',
        bookerEmail: 'booker@example.com',
        startTime: new Date(start),
        endTime: new Date(new Date(start).getTime() + 60 * 60000),
        status,
        deletedAt: deleted ? new Date() : null,
      });
    }

    it('makes every slot unavailable once the cap is reached, ignoring cancelled bookings', async () => {
      const owner = `user_cap_${next()}`;
      const config = pageConfig(owner, { maxBookingsPerDay: 2 });
      await seedBooking(config.id, '2030-03-05T13:00:00Z');
      await seedBooking(config.id, '2030-03-05T14:00:00Z', 'cancelled');
      await seedBooking(config.id, '2030-03-05T15:00:00Z', 'confirmed', true);
      // One live booking, cap 2: still bookable.
      expect(available(await computeAvailableSlots(db, config, DATE, NOW))).toEqual(['09:00', '10:00', '11:00']);

      await seedBooking(config.id, '2030-03-05T16:00:00Z');
      const full = await computeAvailableSlots(db, config, DATE, NOW);
      expect(full).toHaveLength(3);
      expect(available(full)).toEqual([]);
    });

    it('counts per day, per page, and treats null or 0 as unlimited', async () => {
      const owner = `user_cap_scope_${next()}`;
      const config = pageConfig(owner, { maxBookingsPerDay: 1 });
      // Another day and another page do not count.
      await seedBooking(config.id, '2030-03-04T10:00:00Z');
      await seedBooking(generateId('bpg'), '2030-03-05T10:00:00Z');
      expect(available(await computeAvailableSlots(db, config, DATE, NOW))).toHaveLength(3);

      await seedBooking(config.id, '2030-03-05T10:00:00Z');
      for (const unlimited of [0, null]) {
        const open = await computeAvailableSlots(db, { ...config, maxBookingsPerDay: unlimited }, DATE, NOW);
        expect(available(open)).toHaveLength(3);
      }
    });

    it('counts the day in the page timezone', async () => {
      const owner = `user_cap_tz_${next()}`;
      // Amsterdam in March (CET, UTC+1): the 5th runs 2030-03-04T23:00Z to 2030-03-05T23:00Z.
      const config = pageConfig(owner, {
        timezone: 'Europe/Amsterdam',
        maxBookingsPerDay: 1,
      });
      // 23:30 UTC on the 4th is 00:30 on the 5th in Amsterdam: it counts.
      await seedBooking(config.id, '2030-03-04T23:30:00Z');
      const slots = await computeAvailableSlots(db, config, DATE, NOW);
      expect(slots).toHaveLength(3);
      expect(available(slots)).toEqual([]);
    });
  });
});
