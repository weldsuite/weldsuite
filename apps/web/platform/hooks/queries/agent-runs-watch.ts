import { atom } from 'jotai';

/**
 * Watching an agent's runs after the user started one ("Run now", or "Test" on
 * a routine): the run is queued in a durable job and only shows up in the list
 * a moment later, so the list polls until it has appeared and finished.
 */
export interface RunsWatch {
  /** When the run was started, on this machine's clock. */
  since: number;
  /** Runs the list already held then; null when it had not been loaded. */
  knownRunIds: string[] | null;
}

/** How often the runs are re-read while one is queued, running or expected. */
export const RUNS_POLL_MS = 3_000;
/** How long a started run is waited for before giving up on it. */
export const RUNS_WATCH_MS = 2 * 60_000;
/** The server's clock may differ from this machine's. */
const CLOCK_SKEW_MS = 60_000;

const LIVE_STATUSES = new Set(['queued', 'running']);

interface RunLike {
  id: string;
  status: string;
  createdAt: string;
}

/** Runs being watched, by agent id. */
export const runsWatchAtom = atom<Record<string, RunsWatch>>({});

/** The polling interval for an agent's run list; false when nothing is expected to change. */
export function runsPollInterval(
  runs: readonly RunLike[],
  watch: RunsWatch | undefined,
  now: number = Date.now(),
): number | false {
  if (runs.some((run) => LIVE_STATUSES.has(run.status))) return RUNS_POLL_MS;
  if (!watch || now - watch.since > RUNS_WATCH_MS) return false;
  const known = watch.knownRunIds ? new Set(watch.knownRunIds) : null;
  const appeared = runs.some((run) =>
    known ? !known.has(run.id) : Date.parse(run.createdAt) >= watch.since - CLOCK_SKEW_MS,
  );
  // The run has appeared and is no longer live: it has ended.
  return appeared ? false : RUNS_POLL_MS;
}
