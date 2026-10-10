/**
 * Task duration helpers shared by the task dialog (the duration chip) and the
 * task panel (the Duration row), so both offer the same presets and read the
 * same way. Durations are whole minutes, as stored in `tasks.duration`.
 */

/** Quick picks offered next to the custom-minutes input. */
export const DURATION_PRESETS = [15, 30, 45, 60, 90, 120];

/** 30 → "30m", 90 → "1h 30m", 120 → "2h". */
export function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const rest = mins % 60;
  const restLabel = rest ? ` ${rest}m` : '';
  return `${Math.floor(mins / 60)}h${restLabel}`;
}

/**
 * Parses the custom-minutes input. Anything that isn't a positive whole number
 * (empty, `0`, negative, text) is `null`, which means "no duration".
 */
export function parseDurationMinutes(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
