/**
 * Work locations and the clock-in location rule.
 *
 * With `hr_portal_settings.clock_in_requires_location` on, clocking in or out
 * yourself (My HR, the WeldHR app, the workforce portal) needs the device's
 * position within the radius of a work location the employee may use. The
 * position is only asked for and stored while the rule is on. It is what the
 * device reports, so it keeps honest people honest rather than stopping a
 * determined one; HR still approves the hours.
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { HrNotFoundError, HrValidationError } from './shared';

const wl = schema.hrWorkLocations;

/** A GPS fix is never better than the device says; at most this much of its uncertainty is given the benefit of the doubt. */
const MAX_ACCURACY_ALLOWANCE_METERS = 50;

export interface GeoPoint {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export async function listWorkLocations(db: Database, opts: { includeInactive?: boolean } = {}) {
  const conditions = [isNull(wl.deletedAt)];
  if (!opts.includeInactive) conditions.push(eq(wl.isActive, true));
  return db.select().from(wl).where(and(...conditions)).orderBy(asc(wl.name));
}

async function requireWorkLocation(db: Database, id: string) {
  const [row] = await db.select().from(wl).where(and(eq(wl.id, id), isNull(wl.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Work location', id);
  return row;
}

type WorkLocationInput = {
  name?: string;
  address?: string | null;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  isActive?: boolean;
};

export async function createWorkLocation(db: Database, input: WorkLocationInput & { name: string; latitude: number; longitude: number }) {
  const [row] = await db
    .insert(wl)
    .values({ id: generateId('hrloc'), ...input, name: input.name.trim(), address: input.address?.trim() || null })
    .returning();
  return row!;
}

export async function updateWorkLocation(db: Database, id: string, input: WorkLocationInput) {
  await requireWorkLocation(db, id);
  const [row] = await db
    .update(wl)
    .set({
      ...input,
      name: input.name?.trim(),
      address: input.address === undefined ? undefined : input.address?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(wl.id, id))
    .returning();
  return row!;
}

/** Soft delete: attendance records that name the location keep its name. */
export async function deleteWorkLocation(db: Database, id: string) {
  await requireWorkLocation(db, id);
  const now = new Date();
  await db.update(wl).set({ deletedAt: now, isActive: false, updatedAt: now }).where(eq(wl.id, id));
}

/** Every id in an employee's allowed list has to be a live location. */
export async function assertWorkLocations(db: Database, ids: string[] | null | undefined) {
  if (!ids?.length) return;
  const unique = [...new Set(ids)];
  const rows = await db.select({ id: wl.id }).from(wl).where(and(inArray(wl.id, unique), isNull(wl.deletedAt)));
  if (rows.length !== unique.length) throw new HrValidationError('One of the work locations does not exist');
}

/** Names for a set of location ids, deleted ones included. */
export async function workLocationNames(db: Database, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const rows = await db.select({ id: wl.id, name: wl.name }).from(wl).where(inArray(wl.id, unique));
  for (const row of rows) out.set(row.id, row.name);
  return out;
}

/** What a clock-in or -out records about where it happened; all null while the rule is off. */
export interface ClockPlace {
  locationId: string | null;
  latitude: number | null;
  longitude: number | null;
}

export const NO_CLOCK_PLACE: ClockPlace = { locationId: null, latitude: null, longitude: null };

/**
 * Check the device is at one of the employee's work locations. Throws a 400
 * the apps show as is: no position sent, no locations set up, or too far
 * away (naming the nearest and how far it is).
 */
export async function resolveClockPlace(
  db: Database,
  employee: { workLocationIds: string[] | null },
  point: GeoPoint | undefined,
): Promise<ClockPlace> {
  if (!point) throw new HrValidationError('Share your location to clock in or out here', { code: 'LOCATION_REQUIRED' });
  const allowed = employee.workLocationIds?.length ? new Set(employee.workLocationIds) : null;
  const locations = (await listWorkLocations(db)).filter((loc) => !allowed || allowed.has(loc.id));
  if (locations.length === 0) {
    throw new HrValidationError('No work location is set up for you yet. Ask HR to add one.', { code: 'NO_WORK_LOCATION' });
  }
  const allowance = Math.min(Math.max(point.accuracy ?? 0, 0), MAX_ACCURACY_ALLOWANCE_METERS);
  const ranked = locations
    .map((loc) => ({ loc, distance: distanceMeters(point, loc) }))
    .sort((a, b) => a.distance - b.distance);
  const at = ranked.find(({ loc, distance }) => distance - allowance <= loc.radiusMeters);
  if (!at) {
    const nearest = ranked[0]!;
    throw new HrValidationError(
      `You are not at a work location. The nearest, ${nearest.loc.name}, is ${formatDistance(nearest.distance)} away.`,
      { code: 'NOT_AT_WORK_LOCATION', nearest: nearest.loc.name, distanceMeters: Math.round(nearest.distance) },
    );
  }
  return { locationId: at.loc.id, latitude: point.latitude, longitude: point.longitude };
}

/** Where a self-service clock happened: checked and recorded while the workspace requires a location, nothing otherwise. */
export async function clockPlaceFor(
  db: Database,
  employeeId: string,
  requiresLocation: boolean,
  point: GeoPoint | undefined,
): Promise<ClockPlace> {
  if (!requiresLocation) return NO_CLOCK_PLACE;
  const [employee] = await db
    .select({ workLocationIds: schema.hrEmployees.workLocationIds })
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, employeeId))
    .limit(1);
  return resolveClockPlace(db, employee ?? { workLocationIds: null }, point);
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}
