/**
 * Switch colours from the theme.
 *
 * Setting only `trackColor` leaves Android's default knob (teal) on top of the
 * brand-coloured track, so both states get a knob colour too: white on the
 * brand track, the muted grey on the neutral one (visible on the light and
 * the dark track alike).
 */

import { BRAND } from '@/lib/brand';

export interface SwitchTheme {
  border: string;
  muted: string;
}

export interface SwitchColors {
  trackColor: { false: string; true: string };
  thumbColor: string;
  ios_backgroundColor: string;
}

export const SWITCH_KNOB_ON = '#FFFFFF';

export function switchColors(theme: SwitchTheme, value: boolean): SwitchColors {
  return {
    trackColor: { false: theme.border, true: BRAND },
    thumbColor: value ? SWITCH_KNOB_ON : theme.muted,
    ios_backgroundColor: theme.border,
  };
}
