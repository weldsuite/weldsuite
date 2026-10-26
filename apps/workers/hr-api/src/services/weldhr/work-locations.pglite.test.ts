/**
 * The clock-in location rule: a self-service clock is only accepted near a
 * work location the employee may use, and where it happened is kept on the
 * record. With the rule off nothing is asked or stored.
 *
 * "Now" is Wednesday 18 March 2026. The office is on the Dam in Amsterdam
 * (radius 150 m); the depot is in Utrecht.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { clock, listAttendance } from './time';
import { updateEmployee } from './employees';
import {
  NO_CLOCK_PLACE,
  clockPlaceFor,
  createWorkLocation,
  deleteWorkLocation,
  distanceMeters,
  listWorkLocations,
} from './work-locations';

const at = (time: string) => new Date(`2026-03-18T${time}:00Z`);
const dam = { latitude: 52.3731, longitude: 4.8926 };
const nearDam = { latitude: 52.3738, longitude: 4.8926 }; // ~78 m north
const centraal = { latitude: 52.3791, longitude: 4.9003 }; // ~860 m away

let db: Database;
let office: string;
let depot: string;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.hrEmployees).values([
    { id: 'emp_wl_ann', firstName: 'Ann', lastName: 'Adams', email: 'ann@example.com', status: 'active' },
  ]);
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.hrAttendanceRecords);
});

describe('distanceMeters', () => {
  it('measures along the earth', () => {
    expect(distanceMeters(dam, dam)).toBe(0);
    expect(Math.round(distanceMeters(dam, nearDam))).toBe(78);
    expect(distanceMeters(dam, centraal)).toBeGreaterThan(800);
  });
});

describe('the clock-in location rule', () => {
  it('asks nothing while it is off', async () => {
    expect(await clockPlaceFor(db, 'emp_wl_ann', false, undefined)).toEqual(NO_CLOCK_PLACE);
  });

  it('needs a location set up and a position sent', async () => {
    await expect(clockPlaceFor(db, 'emp_wl_ann', true, dam)).rejects.toThrow('No work location is set up');
    office = (await createWorkLocation(db, { name: 'Office', ...dam, radiusMeters: 150 })).id;
    depot = (await createWorkLocation(db, { name: 'Depot', latitude: 52.0907, longitude: 5.1214 })).id;
    await expect(clockPlaceFor(db, 'emp_wl_ann', true, undefined)).rejects.toThrow('Share your location');
  });

  it('accepts a position inside the radius and names the location', async () => {
    expect(await clockPlaceFor(db, 'emp_wl_ann', true, nearDam)).toEqual({ locationId: office, ...nearDam });
  });

  it('refuses one too far away, naming the nearest', async () => {
    await expect(clockPlaceFor(db, 'emp_wl_ann', true, { ...centraal, accuracy: 20 })).rejects.toThrow(
      /not at a work location\. The nearest, Office, is \d+ m away/,
    );
  });

  it('gives a vague fix at most 50 m of the benefit of the doubt', async () => {
    const justOutside = { latitude: 52.3746, longitude: 4.8926 }; // ~167 m
    await expect(clockPlaceFor(db, 'emp_wl_ann', true, justOutside)).rejects.toThrow('not at a work location');
    expect((await clockPlaceFor(db, 'emp_wl_ann', true, { ...justOutside, accuracy: 30 })).locationId).toBe(office);
    await expect(clockPlaceFor(db, 'emp_wl_ann', true, { ...centraal, accuracy: 5000 })).rejects.toThrow('not at a work location');
  });

  it('keeps an employee to the locations they are allowed', async () => {
    await updateEmployee(db, 'emp_wl_ann', { workLocationIds: [depot] });
    await expect(clockPlaceFor(db, 'emp_wl_ann', true, dam)).rejects.toThrow('The nearest, Depot');
    await expect(updateEmployee(db, 'emp_wl_ann', { workLocationIds: ['hrloc_nope'] })).rejects.toThrow('does not exist');
    await updateEmployee(db, 'emp_wl_ann', { workLocationIds: null });
  });

  it('records where the clock-in and clock-out happened', async () => {
    const place = await clockPlaceFor(db, 'emp_wl_ann', true, nearDam);
    await clock(db, 'emp_wl_ann', 'in', at('08:00'), 'user_ann', undefined, place);
    await clock(db, 'emp_wl_ann', 'out', at('16:00'), 'user_ann', undefined, { locationId: office, ...dam });
    const [record] = (await listAttendance(db, { employeeId: 'emp_wl_ann' })).data;
    expect(record).toMatchObject({
      clockInLocationId: office,
      clockInLocationName: 'Office',
      clockInLatitude: nearDam.latitude,
      clockOutLocationName: 'Office',
      clockOutLongitude: dam.longitude,
    });
  });

  it('keeps a deleted location’s name on the records, but no longer accepts it', async () => {
    await clock(db, 'emp_wl_ann', 'in', at('08:00'), 'user_ann', undefined, { locationId: depot, latitude: 52.0907, longitude: 5.1214 });
    await deleteWorkLocation(db, depot);
    expect((await listWorkLocations(db)).map((l) => l.name)).toEqual(['Office']);
    const [record] = (await listAttendance(db, { employeeId: 'emp_wl_ann' })).data;
    expect(record?.clockInLocationName).toBe('Depot');
  });
});
