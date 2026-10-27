import { describe, expect, it } from 'vitest';
import { RUNS_POLL_MS, RUNS_WATCH_MS, runsPollInterval } from './agent-runs-watch';

const now = Date.parse('2026-10-20T10:00:00Z');
const run = (id: string, status: string, createdAt = '2026-10-20T09:00:00Z') => ({ id, status, createdAt });

describe('runsPollInterval', () => {
  it('stays quiet when nothing is running and nothing was started', () => {
    expect(runsPollInterval([run('r1', 'completed')], undefined, now)).toBe(false);
  });

  it('polls while a run is queued or running', () => {
    expect(runsPollInterval([run('r1', 'running')], undefined, now)).toBe(RUNS_POLL_MS);
    expect(runsPollInterval([run('r1', 'queued')], undefined, now)).toBe(RUNS_POLL_MS);
  });

  it('waits for a started run that has not shown up yet', () => {
    const watch = { since: now - 5_000, knownRunIds: ['r1'] };
    expect(runsPollInterval([run('r1', 'completed')], watch, now)).toBe(RUNS_POLL_MS);
  });

  it('stops once the started run has appeared and ended', () => {
    const watch = { since: now - 20_000, knownRunIds: ['r1'] };
    expect(runsPollInterval([run('r2', 'completed'), run('r1', 'completed')], watch, now)).toBe(false);
  });

  it('keeps polling while the started run is still live', () => {
    const watch = { since: now - 20_000, knownRunIds: ['r1'] };
    expect(runsPollInterval([run('r2', 'running'), run('r1', 'completed')], watch, now)).toBe(RUNS_POLL_MS);
  });

  it('gives up after the watch window', () => {
    const watch = { since: now - RUNS_WATCH_MS - 1, knownRunIds: ['r1'] };
    expect(runsPollInterval([run('r1', 'completed')], watch, now)).toBe(false);
  });

  it('judges by time when the list had not been loaded yet', () => {
    const watch = { since: now - 10_000, knownRunIds: null };
    expect(runsPollInterval([run('old', 'completed', '2026-10-20T08:00:00Z')], watch, now)).toBe(RUNS_POLL_MS);
    expect(runsPollInterval([run('new', 'completed', '2026-10-20T09:59:55Z')], watch, now)).toBe(false);
  });
});
