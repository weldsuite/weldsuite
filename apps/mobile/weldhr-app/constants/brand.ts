/**
 * The app's colours, after the WeldChat app: white pages, black type, iOS
 * greys for controls and tiles, black primary buttons, and the app's own
 * colour (WeldHR teal, where WeldChat has its green) for links, switches and
 * badges. The month calendar marks today and the chosen week in blue.
 */

/** WeldHR teal, the same as the platform's WeldHR icon. */
export const BRAND = '#0D9488';

export interface Palette {
  /** The tinted page behind the sheet: the header, and Home. A soft blue, the family of the shift card and calendar. */
  canvas: string;
  /** Sheets and cards. */
  surface: string;
  /** Square header buttons and the segmented control's track, a step deeper than the canvas. */
  chrome: string;
  /** The same on a plain white page (`Screen` with `plain`): iOS grey instead of the blue tint. */
  chromePlain: string;
  /** Secondary buttons on a sheet ("Decline", call / email). */
  control: string;
  /** The selected segment. */
  thumb: string;
  /** The selected segment on a plain white page. */
  thumbPlain: string;
  /** Date tiles and icon tiles. */
  tile: string;
  text: string;
  muted: string;
  border: string;
  grabber: string;
  accent: string;
  /** Today and the chosen day in the month calendar. */
  calendar: string;
  /** The chosen week in the month calendar. */
  calendarSoft: string;
  /** The blue action button on an empty page ("New expense"). */
  primary: string;
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
    canvas: '#EBF1FE',
    surface: '#FFFFFF',
    chrome: '#D9E4FC',
    chromePlain: '#EEEEF0',
    control: '#E5E5EA',
    thumb: '#FFFFFF',
    thumbPlain: '#FFFFFF',
    tile: '#F2F2F7',
    text: '#000000',
    muted: '#52575F',
    border: '#E5E5EA',
    grabber: '#D1D1D6',
    accent: BRAND,
    calendar: '#3B82F6',
    calendarSoft: 'rgba(59, 130, 246, 0.12)',
    primary: '#2563EB',
    ink: '#000000',
    inkText: '#FFFFFF',
    success: '#059669',
    warning: '#D97706',
    danger: '#DC2626',
  },
  dark: {
    canvas: '#0C1426',
    surface: '#1C1C1E',
    chrome: '#1C2741',
    chromePlain: '#2C2C2E',
    control: '#2C2C2E',
    thumb: '#33425F',
    thumbPlain: '#636366',
    tile: '#2C2C2E',
    text: '#FFFFFF',
    muted: '#9CA3AF',
    border: '#38383A',
    grabber: '#48484A',
    accent: '#14B8A6',
    calendar: '#3B82F6',
    calendarSoft: 'rgba(59, 130, 246, 0.22)',
    primary: '#3B82F6',
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
