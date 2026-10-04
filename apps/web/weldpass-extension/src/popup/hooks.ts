import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveTab, type ActiveTab } from '../lib/chrome-page';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Run `load` on mount and whenever `key` changes. A stale run never overwrites a newer one. */
export function useAsync<T>(load: () => Promise<T>, key: string): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let current = true;
    setState((previous) => ({ ...previous, error: undefined, loading: true }));
    loadRef.current().then(
      (data) => current && setState({ data, error: undefined, loading: false }),
      (error: unknown) => current && setState({ data: undefined, error, loading: false }),
    );
    return () => {
      current = false;
    };
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, reload };
}

/** The tab the popup was opened on. `undefined` while it is being looked up. */
export function useActiveTab(): ActiveTab | null | undefined {
  const [tab, setTab] = useState<ActiveTab | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    getActiveTab().then(
      (found) => current && setTab(found),
      () => current && setTab(null),
    );
    return () => {
      current = false;
    };
  }, []);
  return tab;
}

export type StatusTone = 'ok' | 'error';
export interface Status {
  tone: StatusTone;
  text: string;
}
export type Notify = (tone: StatusTone, text: string) => void;

/** One status line at the bottom of the popup; a new message replaces the last. */
export function useStatus(): { status: Status | null; notify: Notify } {
  const [status, setStatus] = useState<Status | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const notify = useCallback<Notify>((tone, text) => {
    window.clearTimeout(timer.current);
    setStatus({ tone, text });
    timer.current = window.setTimeout(() => setStatus(null), tone === 'ok' ? 4000 : 8000);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { status, notify };
}
