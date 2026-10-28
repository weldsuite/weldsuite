/**
 * The app's colours, after the WeldChat app: white pages, Attio's text colours
 * (near-black type, slate grey for the muted; lib/app-font.ts), iOS greys for
 * controls and tiles, black primary buttons, and the app's own colour (WeldHR
 * teal, where WeldChat has its green) for links, switches and badges. The
 * month calendar marks today and the chosen week in blue, and the tab bar's
 * counts and unread rows are blue.
 */

import type { HrDeclarationCategory } from '@weldsuite/app-api-client/domains/weldhr';

/** WeldHR teal, the same as the platform's WeldHR icon. */
export const BRAND = '#0D9488';

export interface Palette {
  /** The light grey top behind a sheet (Schedule, Absence), where the month calendar is. */
  canvas: string;
  /** Pages, sheets and cards. */
  surface: string;
  /** Square header buttons and the segmented control's track. */
  chrome: string;
  /** Secondary buttons on a sheet ("Decline", call / email). */
  control: string;
  /** Square buttons on the grey canvas (the week arrows): a light step darker than the canvas. */
  canvasControl: string;
  /** The selected segment. */
  thumb: string;
  /** Date tiles and icon tiles. */
  tile: string;
  text: string;
  muted: string;
  border: string;
  /** A softer border: the search field and the Expenses totals card. */
  softBorder: string;
  /** A line on the grey canvas (under the tabs), where `border` would barely show. */
  canvasBorder: string;
  grabber: string;
  accent: string;
  /** Today and the chosen day in the month calendar. */
  calendar: string;
  /** The chosen week in the month calendar. */
  calendarSoft: string;
  /** The blue action button on an empty page ("New expense"). */
  primary: string;
  /** The counts on the tab bar's icons: a blue halfway between `primary` and blue-500. */
  badge: string;
  /** Behind a row not opened yet (an unread announcement): `badge` washed out. */
  unread: string;
  /** The profile's page behind its cards: the canvas grey, a step lighter. */
  groupedPage: string;
  /** Attio's settings cards (Grouped.tsx): their border and lines, the icons, the check. */
  groupedBorder: string;
  groupedIcon: string;
  selected: string;
  /** The black primary button ("Clock in", "Approve"). */
  ink: string;
  inkText: string;
  success: string;
  warning: string;
  danger: string;
}

/** The `@weldsuite/mobile-ui` theme tokens WeldChat is built on, light and dark. */
export const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    canvas: '#F2F2F7',
    surface: '#FFFFFF',
    chrome: '#EEEEF0',
    control: '#E5E5EA',
    canvasControl: '#E7E7EC',
    thumb: '#FFFFFF',
    tile: '#F2F2F7',
    text: '#1C1D1F',
    muted: '#6F7988',
    border: '#E5E5EA',
    softBorder: '#EFEFF2',
    canvasBorder: '#C7C7CC',
    grabber: '#D1D1D6',
    accent: BRAND,
    calendar: '#3B82F6',
    calendarSoft: 'rgba(59, 130, 246, 0.12)',
    primary: '#2563EB',
    badge: '#3073F1',
    unread: '#EEF4FE',
    groupedPage: '#F7F7FA',
    groupedBorder: '#E6E7E8',
    groupedIcon: '#6C6E6F',
    selected: '#3A6CE8',
    ink: '#000000',
    inkText: '#FFFFFF',
    success: '#059669',
    warning: '#D97706',
    danger: '#DC2626',
  },
  dark: {
    canvas: '#000000',
    surface: '#1C1C1E',
    chrome: '#2C2C2E',
    control: '#2C2C2E',
    canvasControl: '#2C2C2E',
    thumb: '#636366',
    tile: '#2C2C2E',
    text: '#EFF3F4',
    muted: '#97A0AF',
    border: '#38383A',
    softBorder: '#38383A',
    canvasBorder: '#38383A',
    grabber: '#48484A',
    accent: '#14B8A6',
    calendar: '#3B82F6',
    calendarSoft: 'rgba(59, 130, 246, 0.22)',
    primary: '#3B82F6',
    badge: '#4E94F8',
    unread: '#232D3C',
    groupedPage: '#000000',
    groupedBorder: '#2C2C2E',
    groupedIcon: '#98989F',
    selected: '#4E7FF0',
    ink: '#FFFFFF',
    inkText: '#000000',
    success: '#34D399',
    warning: '#FBBF24',
    danger: '#EF4444',
  },
};

/**
 * Colours for the bar in front of a shift and for people's initials. Shifts
 * have no colour of their own in WeldHR, so the client or role picks one, the
 * way a department does in a rostering app.
 */
const SWATCHES = ['#10B981', '#8B5CF6', '#F59E0B', '#3B82F6', '#EC4899', '#14B8A6', '#F97316', '#6366F1'];
const AVATAR_SWATCHES = ['#E32626', '#2F6FE0', '#2EA043', '#A0329E', '#E07B00', '#0E9F9A', '#D6336C', '#5B4BDB'];

function hash(key: string): number {
  let value = 0;
  for (const char of key) value = (value * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(value);
}

/** A stable colour for a client, role or department name. */
export function swatchFor(key: string | null | undefined): string {
  return SWATCHES[hash(key ?? '') % SWATCHES.length];
}

/** A stable colour behind a person's initials. */
export function avatarColorFor(name: string): string {
  return AVATAR_SWATCHES[hash(name) % AVATAR_SWATCHES.length];
}

/** Icon colours per area, for the tinted menu tiles on More (as in WeldChat's settings). */
export const ACCENTS = {
  expenses: '#F59E0B',
  sick: '#EF4444',
  pay: '#10B981',
  tasks: '#8B5CF6',
  reviews: '#EC4899',
  team: '#3B82F6',
  settings: '#6B7280',
} as const;

/** A colour per expense category, for its tinted tile on Expenses. */
export const DECLARATION_ACCENTS: Record<HrDeclarationCategory, string> = {
  travel: '#3B82F6',
  meals: '#F97316',
  accommodation: '#8B5CF6',
  equipment: '#14B8A6',
  training: '#EC4899',
  other: '#6B7280',
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function channels(color: string | null | undefined): number[] | null {
  const hex = HEX.exec(color?.trim() ?? '')?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}

/**
 * A `#rgb` / `#rrggbb` colour at low opacity, for soft fills. Leave types
 * carry the colour HR picked, so anything that is not hex falls back to the
 * brand tint rather than rendering nothing.
 */
export function tint(color: string | null | undefined, alpha = 0.12): string {
  const rgb = channels(color) ?? channels(BRAND)!;
  return `rgba(${rgb.join(', ')}, ${alpha})`;
}

/** The colour itself when it is hex, else the brand teal (see `tint`). */
export function solid(color: string | null | undefined): string {
  return HEX.test(color?.trim() ?? '') ? color!.trim() : BRAND;
}

/** Dark or white, whichever reads better on `color` (an icon on a leave type's tile). */
export function onColor(color: string): string {
  const rgb = channels(color);
  if (!rgb) return '#FFFFFF';
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#000000' : '#FFFFFF';
}
