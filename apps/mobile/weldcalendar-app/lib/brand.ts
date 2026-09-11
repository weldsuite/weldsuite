/**
 * WeldCalendar brand tokens.
 *
 * `@weldsuite/mobile-ui`'s theme is deliberately neutral (black/white primary)
 * so each app layers its own accent on top. WeldCalendar is pink — the same
 * #FE466C the platform sidebar mark and the app icon use
 * (`apps/web/platform/public/assets/images/weldcalendar/icon.svg`).
 */

export const BRAND = '#FE466C';
export const BRAND_DARK = '#D92B52';
/** ~12% pink, for icon tiles and selected chips. */
export const BRAND_TINT = 'rgba(254,70,108,0.12)';

/**
 * Event-type colours, mirroring `EVENT_TYPE_COLORS` in the platform
 * (`app/weldcalendar/lib/event-form-schema.ts`) so an event reads the same on
 * both surfaces. Kept in lockstep by hand — there is no shared package for
 * calendar presentation tokens yet.
 */
export const EVENT_TYPE_COLORS: Record<string, string> = {
  meeting: '#3b82f6', // blue
  call: '#22c55e', // green
  appointment: '#8b5cf6', // violet
  event: '#f59e0b', // amber
  reminder: '#ef4444', // red
  other: '#6b7280', // gray
};

/** Accent per module area, for the rounded icon tiles on menu rows. */
export const ACCENTS = {
  agenda: '#FE466C',
  month: '#8B5CF6',
  calendars: '#3B82F6',
  today: '#10B981',
  settings: '#6B7280',
  privacy: '#0EA5E9',
  notifications: '#F59E0B',
} as const;

/** Palette offered when creating a calendar — matches the platform's picker. */
export const CALENDAR_COLORS = [
  '#FE466C',
  '#ef4444',
  '#f59e0b',
  '#eab308',
  '#22c55e',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#6b7280',
] as const;

/** ~12% tint of an accent, for the rounded icon tiles on menu rows. */
export function tint(hex: string, alpha = 0.12): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return BRAND_TINT;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Colour an event should paint with: its own override, else its type's. */
export function eventColor(
  color: string | null | undefined,
  type: string | null | undefined,
): string {
  if (color) return color;
  return EVENT_TYPE_COLORS[type ?? 'other'] ?? EVENT_TYPE_COLORS.other;
}
