/**
 * Running-timer queries.
 *
 * The timer is server state (`active_timers`, one row per user), not component
 * state, so it survives refresh, navigation, and switching devices. Elapsed
 * time is derived from `startedAt` on each render rather than counted up
 * locally — a tab that was backgrounded or asleep still shows the truth.
 */

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { timerApi, type RunningTimer, type StartTimerInput } from '@/app/weldflow/lib/api-client';
import { projectKeys } from './use-projects-queries';

export const timerKeys = {
  all: ['weldflow', 'timer'] as const,
  current: () => [...timerKeys.all, 'current'] as const,
};

/** Raised when starting a timer while another one is already running. */
export class TimerAlreadyRunningError extends Error {
  constructor(public readonly running: RunningTimer | null) {
    super('A timer is already running');
    this.name = 'TimerAlreadyRunningError';
  }
}

/**
 * The caller's running timer, or `null`. Refetches on window focus so a timer
 * stopped in another tab or on another device doesn't linger here.
 */
export function useRunningTimer() {
  return useQuery({
    queryKey: timerKeys.current(),
    queryFn: async () => {
      const res = await timerApi.get();
      if (!res.success) throw new Error(res.error || 'Failed to fetch running timer');
      return res.data ?? null;
    },
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}

export function useStartTimer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StartTimerInput) => {
      const res = await timerApi.start(input);
      if (!res.success) {
        if (res.status === 409) {
          const running = (res.details as { timer?: RunningTimer } | undefined)?.timer ?? null;
          throw new TimerAlreadyRunningError(running);
        }
        throw new Error(res.error || 'Failed to start timer');
      }
      return res.data!;
    },
    onSuccess: (timer) => {
      queryClient.setQueryData(timerKeys.current(), timer);
    },
    onError: (err) => {
      // A 409 means the server has a timer this client didn't know about.
      if (err instanceof TimerAlreadyRunningError) {
        queryClient.setQueryData(timerKeys.current(), err.running);
      }
    },
  });
}

export function useStopTimer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (overrides: StartTimerInput = {}) => {
      const res = await timerApi.stop(overrides);
      if (!res.success) throw new Error(res.error || 'Failed to stop timer');
      return res.data!;
    },
    onSuccess: (_entry, _vars, _ctx) => {
      queryClient.setQueryData(timerKeys.current(), null);
      // The stop wrote a time entry — every project's entry list may be stale.
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useDiscardTimer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await timerApi.discard();
      if (!res.success) throw new Error(res.error || 'Failed to discard timer');
    },
    onSuccess: () => {
      queryClient.setQueryData(timerKeys.current(), null);
    },
  });
}

/**
 * Seconds elapsed since `startedAt`, ticking once a second.
 *
 * Derived from the timestamp rather than incremented, so it stays correct
 * across sleep, throttled background tabs, and remounts.
 */
export function useElapsedSeconds(startedAt: string | null | undefined): number {
  const compute = useCallback(() => {
    if (!startedAt) return 0;
    const started = new Date(startedAt).getTime();
    if (!Number.isFinite(started)) return 0;
    return Math.max(0, Math.floor((Date.now() - started) / 1000));
  }, [startedAt]);

  const [elapsed, setElapsed] = useState(compute);

  useEffect(() => {
    setElapsed(compute());
    if (!startedAt) return;
    const interval = setInterval(() => setElapsed(compute()), 1000);
    return () => clearInterval(interval);
  }, [startedAt, compute]);

  return elapsed;
}

/** Seconds as `H:MM:SS` (or `M:SS` under an hour). */
export function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
