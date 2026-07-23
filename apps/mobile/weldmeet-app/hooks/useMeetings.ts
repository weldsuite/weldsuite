import { useCallback, useEffect, useState } from 'react';
import { useWeldmeetApi } from '@/services/app-api';
import type { Meeting, RecordingSummary } from '@weldsuite/core-api-client/schemas/weldmeet';

interface State<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function toMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

export function useUpcomingMeetings(): State<Meeting[]> {
  const { weldmeet } = useWeldmeetApi();
  const [data, setData] = useState<Meeting[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await weldmeet.listUpcoming({ days: 30, limit: 50 });
      setData(res.data ?? []);
    } catch (err) {
      setError(toMessage(err, 'Failed to load meetings'));
    } finally {
      setLoading(false);
    }
  }, [weldmeet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}

export function useMeetingHistory(): State<Meeting[]> {
  const { weldmeet } = useWeldmeetApi();
  const [data, setData] = useState<Meeting[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await weldmeet.listMeetings({ status: 'completed', pageSize: 50, page: 1 });
      setData(res.data ?? []);
    } catch (err) {
      setError(toMessage(err, 'Failed to load meetings'));
    } finally {
      setLoading(false);
    }
  }, [weldmeet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}

export function useMeeting(id: string | undefined): State<Meeting> {
  const { weldmeet } = useWeldmeetApi();
  const [data, setData] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await weldmeet.getMeeting(id);
      setData(res.data ?? null);
    } catch (err) {
      setError(toMessage(err, 'Failed to load meeting'));
    } finally {
      setLoading(false);
    }
  }, [weldmeet, id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}

export function useRecordings(): State<RecordingSummary[]> {
  const { weldmeet } = useWeldmeetApi();
  const [data, setData] = useState<RecordingSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await weldmeet.listRecordings();
      setData(res.data ?? []);
    } catch (err) {
      setError(toMessage(err, 'Failed to load recordings'));
    } finally {
      setLoading(false);
    }
  }, [weldmeet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
