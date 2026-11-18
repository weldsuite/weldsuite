/**
 * The colours a mail label can have, in hue order: two rows of eight in the
 * colour pickers. `key` names the colour in `mail.sidebar` and
 * `mail.settingsLabels`. The first eight values are the ones labels were
 * created with before the palette grew, so existing labels still match one.
 */
export const LABEL_COLORS = [
  { key: 'colorRed', value: '#EF4444' },
  { key: 'colorOrange', value: '#F97316' },
  { key: 'colorAmber', value: '#F59E0B' },
  { key: 'colorYellow', value: '#EAB308' },
  { key: 'colorLime', value: '#84CC16' },
  { key: 'colorGreen', value: '#22C55E' },
  { key: 'colorEmerald', value: '#10B981' },
  { key: 'colorTeal', value: '#14B8A6' },
  { key: 'colorCyan', value: '#06B6D4' },
  { key: 'colorSky', value: '#0EA5E9' },
  { key: 'colorBlue', value: '#3B82F6' },
  { key: 'colorIndigo', value: '#6366F1' },
  { key: 'colorPurple', value: '#8B5CF6' },
  { key: 'colorFuchsia', value: '#D946EF' },
  { key: 'colorPink', value: '#EC4899' },
  { key: 'colorGray', value: '#6B7280' },
] as const;

export type LabelColorValue = (typeof LABEL_COLORS)[number]['value'];

/** A new label starts blue. */
export const DEFAULT_LABEL_COLOR: LabelColorValue = '#3B82F6';
