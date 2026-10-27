/** What started a run, as the Activity tab names it. */
export type RunTrigger = 'routineTest' | 'routine' | 'manual' | 'event' | 'chat';

const PLAIN_TRIGGERS = new Set<string>(['manual', 'event', 'chat']);

/**
 * A routine's run carries the routine in its trigger data, so a test of a
 * routine (stored as a manual run) and a scheduled routine (stored as an event)
 * are told apart from a plain manual run or a plain event.
 */
export function runTrigger(run: {
  triggerType: string | null;
  triggerData: Record<string, unknown> | null;
}): RunTrigger | null {
  if (typeof run.triggerData?.routineId === 'string') {
    return run.triggerData.test === true ? 'routineTest' : 'routine';
  }
  return run.triggerType && PLAIN_TRIGGERS.has(run.triggerType) ? (run.triggerType as RunTrigger) : null;
}

/** A summary worth a "show more": it runs past a few short lines. */
export function isLongSummary(summary: string): boolean {
  return summary.length > 180 || summary.split('\n').length > 3;
}
