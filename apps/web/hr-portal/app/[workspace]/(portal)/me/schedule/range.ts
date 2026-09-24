import { addDaysIso, todayIso } from '@/lib/date';

/**
 * The range the schedule opens on. Shared by the server page (which preloads
 * it) and the client view (whose initial state must produce the same query
 * key, or the preloaded data would be ignored).
 */
export function defaultScheduleRange(): { from: string; to: string } {
  const today = todayIso();
  return { from: addDaysIso(today, -30), to: addDaysIso(today, 14) };
}
