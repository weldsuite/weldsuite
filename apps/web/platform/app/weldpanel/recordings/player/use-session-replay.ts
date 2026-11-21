/**
 * Loads a recording's chunks for the player: from the first chunk that holds a
 * full snapshot to the last, a few at a time, each gunzipped and merged into
 * one time-ordered event list. A failed chunk fails the whole load, since a
 * replay with a hole in it shows the wrong page.
 */

import { useEffect, useRef, useState } from 'react';
import type { PanelChunkManifestEntry } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { useWeldPanelChunkLoader } from '@/hooks/queries/use-weldpanel-queries';
import { hasFullSnapshot, mergeChunks, readChunk, type ReplayEvent } from '../../lib/replay';

const CONCURRENCY = 4;

export type ReplayLoadState =
  | { status: 'idle' }
  | { status: 'loading'; done: number; total: number }
  | { status: 'ready'; events: ReplayEvent[] }
  | { status: 'error'; reason: 'gone' | 'failed' | 'no-snapshot' };

/** The chunks playback needs: those from the first full snapshot on. */
export function playableChunks(chunks: readonly PanelChunkManifestEntry[]): PanelChunkManifestEntry[] {
  const ordered = [...chunks].sort((a, b) => a.seq - b.seq);
  const start = ordered.findIndex((c) => c.hasFullSnapshot);
  return start === -1 ? [] : ordered.slice(start);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: number }).status === 404;
}

export function useSessionReplay(projectId: string, sessionId: string, chunks: readonly PanelChunkManifestEntry[] | undefined): ReplayLoadState {
  const loadChunk = useWeldPanelChunkLoader();
  const loadRef = useRef(loadChunk);
  loadRef.current = loadChunk;
  const [state, setState] = useState<ReplayLoadState>({ status: 'idle' });
  const chunkKey = chunks?.map((c) => c.seq).join(',') ?? null;

  useEffect(() => {
    if (!chunks || chunks.length === 0) {
      setState({ status: 'idle' });
      return;
    }
    const wanted = playableChunks(chunks);
    if (wanted.length === 0) {
      setState({ status: 'error', reason: 'no-snapshot' });
      return;
    }
    let cancelled = false;
    const results: ReplayEvent[][] = new Array<ReplayEvent[]>(wanted.length);
    let next = 0;
    let done = 0;
    setState({ status: 'loading', done: 0, total: wanted.length });

    async function worker(): Promise<void> {
      while (!cancelled) {
        const index = next++;
        if (index >= wanted.length) return;
        const bytes = await loadRef.current(projectId, sessionId, wanted[index]!.seq);
        results[index] = await readChunk(bytes);
        done += 1;
        if (!cancelled) setState({ status: 'loading', done, total: wanted.length });
      }
    }

    Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, () => worker()))
      .then(() => {
        if (cancelled) return;
        const events = mergeChunks(results);
        setState(hasFullSnapshot(events) ? { status: 'ready', events } : { status: 'error', reason: 'no-snapshot' });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', reason: isNotFound(error) ? 'gone' : 'failed' });
      });

    return () => {
      cancelled = true;
    };
    // `chunkKey` stands for the manifest: a refetch with the same chunks must not reload the recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, chunkKey]);

  return state;
}
