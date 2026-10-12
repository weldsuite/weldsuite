/**
 * The edge of a note popup, centred or pinned: a hairline border and a shadow
 * on every side (darker in dark mode, where a soft one disappears into the
 * page). Kept apart from the editor so the app shell can frame the pinned
 * panel without loading the editor.
 */
export const NOTE_POPUP_FRAME =
  'border border-border shadow-[0_8px_20px_rgba(0,0,0,0.12),0_0_60px_8px_rgba(0,0,0,0.16)] dark:shadow-[0_8px_20px_rgba(0,0,0,0.45),0_0_60px_8px_rgba(0,0,0,0.6)]';
