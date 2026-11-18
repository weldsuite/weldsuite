/**
 * The session player: rrweb's `Replayer` (it renders the page in its own
 * sandboxed iframe) with our own controls, built from the library: play and
 * pause, a timeline with event markers, skip inactivity, speed, the current
 * page and full screen. The replayer is rebuilt when the events change and
 * destroyed on unmount.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Replayer } from 'rrweb';
import 'rrweb/dist/style.css';
import { FastForward, Maximize2, Pause, Play, RotateCcw, Undo2, Redo2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import {
  INACTIVITY_MS,
  RRWEB_META,
  fitScale,
  formatClock,
  pageAt,
  type PageVisit,
  type ReplayEvent,
  type TimelineMarker,
  type TimeRange,
} from '../../lib/replay';
import { Timeline, TimelineLegend } from './timeline';

export const PLAYBACK_SPEEDS = [1, 2, 4, 8] as const;
const SEEK_STEP_MS = 5_000;
const TIME_REPORT_MS = 250;

export interface ReplayPlayerHandle {
  seek: (ms: number) => void;
}

interface ReplayPlayerProps {
  events: ReplayEvent[];
  markers: readonly TimelineMarker[];
  inactive: readonly TimeRange[];
  visits: readonly PageVisit[];
  /** Called a few times a second while the position changes. */
  onTimeChange?: (ms: number) => void;
  /** Called when rrweb throws while building the page. */
  onError?: () => void;
  ref?: Ref<ReplayPlayerHandle>;
}

type ReplayerEventsArg = ConstructorParameters<typeof Replayer>[0];

/** The size the page was recorded at: the first Meta event, else a desktop window. */
function recordedViewport(events: readonly ReplayEvent[]): { width: number; height: number } {
  const meta = events.find((e) => e.type === RRWEB_META)?.data as { width?: number; height?: number } | undefined;
  return { width: meta?.width || 1280, height: meta?.height || 800 };
}

export function ReplayPlayer({ events, markers, inactive, visits, onTimeChange, onError, ref }: Readonly<ReplayPlayerProps>) {
  const { t } = useI18n();
  const tp = t.weldpanel.observe.player;
  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const frameRef = useRef(0);
  const lastReportRef = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [skipInactive, setSkipInactive] = useState(true);
  const [skipping, setSkipping] = useState(false);
  const [viewport, setViewport] = useState(() => recordedViewport(events));
  const [box, setBox] = useState({ width: 0, height: 0 });

  const speedRef = useRef(speed);
  const skipRef = useRef(skipInactive);
  speedRef.current = speed;
  skipRef.current = skipInactive;
  const currentRef = useRef(0);
  const totalRef = useRef(0);
  const playingRef = useRef(false);
  playingRef.current = playing;

  const report = useCallback(
    (ms: number, force = false) => {
      currentRef.current = ms;
      setCurrent(ms);
      const now = Date.now();
      if (force || now - lastReportRef.current >= TIME_REPORT_MS) {
        lastReportRef.current = now;
        onTimeChange?.(ms);
      }
    },
    [onTimeChange],
  );

  // Build the replayer for these events.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || events.length < 2) return;
    let replayer: Replayer;
    let meta: { totalTime: number };
    try {
      replayer = new Replayer(events as unknown as ReplayerEventsArg, {
        root: stage,
        speed: speedRef.current,
        skipInactive: skipRef.current,
        inactivePeriodThreshold: INACTIVITY_MS,
        showWarning: false,
        mouseTail: { strokeStyle: '#f97316', lineWidth: 2 },
        triggerFocus: false,
      });
      meta = replayer.getMetaData();
    } catch {
      onError?.();
      return;
    }
    replayerRef.current = replayer;
    totalRef.current = meta.totalTime;
    setTotal(meta.totalTime);
    setViewport(recordedViewport(events));
    replayer.on('resize', (size: unknown) => {
      const { width, height } = size as { width: number; height: number };
      if (width > 0 && height > 0) setViewport({ width, height });
    });
    replayer.on('finish', () => {
      setPlaying(false);
      setSkipping(false);
      report(totalRef.current, true);
    });
    replayer.on('skip-start', () => setSkipping(true));
    replayer.on('skip-end', () => setSkipping(false));
    try {
      replayer.play(0);
      setPlaying(true);
    } catch {
      onError?.();
    }
    return () => {
      cancelAnimationFrame(frameRef.current);
      try {
        replayer.destroy();
      } catch {
        // Already gone with its container.
      }
      replayerRef.current = null;
      setPlaying(false);
      setCurrent(0);
    };
    // `report` and `onError` are deliberately left out: a new callback must not rebuild the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // Follow the playback position while playing.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const replayer = replayerRef.current;
      if (replayer) report(Math.min(replayer.getCurrentTime(), totalRef.current));
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [playing, report]);

  useEffect(() => {
    replayerRef.current?.setConfig({ speed });
  }, [speed]);

  useEffect(() => {
    replayerRef.current?.setConfig({ skipInactive });
    if (!skipInactive) setSkipping(false);
  }, [skipInactive]);

  // Fit the recorded window inside the available space.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const seek = useCallback(
    (ms: number) => {
      const replayer = replayerRef.current;
      if (!replayer) return;
      const target = Math.min(Math.max(0, ms), totalRef.current);
      if (playingRef.current) replayer.play(target);
      else replayer.pause(target);
      report(target, true);
    },
    [report],
  );

  useImperativeHandle(ref, () => ({ seek }), [seek]);

  const togglePlay = useCallback(() => {
    const replayer = replayerRef.current;
    if (!replayer) return;
    if (playingRef.current) {
      replayer.pause();
      setPlaying(false);
      return;
    }
    const atEnd = currentRef.current >= totalRef.current - 50;
    replayer.play(atEnd ? 0 : currentRef.current);
    setPlaying(true);
  }, []);

  const restart = useCallback(() => {
    replayerRef.current?.play(0);
    setPlaying(true);
    report(0, true);
  }, [report]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The timeline and the buttons handle their own keys.
    if (event.target !== event.currentTarget) return;
    if (event.key === ' ') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seek(currentRef.current + SEEK_STEP_MS);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seek(currentRef.current - SEEK_STEP_MS);
    }
  }

  const scale = fitScale(box.width, box.height, viewport.width, viewport.height);
  const visit = pageAt(visits, current);
  const ended = !playing && total > 0 && current >= total - 50;

  return (
    <div className="grid gap-3" data-testid="replay-player">
      {/* The stage is the player's keyboard target (space, arrows): a custom widget, so it takes focus itself. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={boxRef}
        role="application"
        aria-label={tp.label}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="relative flex h-[min(62vh,640px)] min-h-60 w-full items-center justify-center overflow-hidden rounded-lg border bg-muted/50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <div className="relative shrink-0 overflow-hidden rounded-sm bg-white shadow-md" style={{ width: viewport.width * scale, height: viewport.height * scale }}>
          <div ref={stageRef} style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})`, transformOrigin: 'top left' }} />
          {/* Clicks on the replayed page must not reach the page's own controls. */}
          <div className="absolute inset-0" aria-hidden />
        </div>
        {skipping && (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium shadow">
            <FastForward className="size-3.5" aria-hidden />
            {tp.skipping}
          </span>
        )}
        {ended && <span className="absolute bottom-3 left-3 rounded-full bg-background/90 px-2.5 py-1 text-xs shadow">{tp.finished}</span>}
      </div>

      <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-sm" aria-live="off">
        <span className="shrink-0 text-xs text-muted-foreground">{t.weldpanel.observe.session.currentPage}</span>
        <span className="min-w-0 truncate font-mono text-xs" title={visit?.url ?? undefined}>
          {visit ? (visit.url ?? visit.path) : t.weldpanel.observe.session.noPage}
        </span>
      </div>

      <Timeline total={total} current={current} markers={markers} inactive={inactive} onSeek={seek} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1">
          <Button type="button" size="icon" className="size-9" onClick={togglePlay} aria-label={playing ? tp.pause : tp.play}>
            {playing ? <Pause /> : <Play />}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => seek(current - SEEK_STEP_MS)} aria-label={tp.back5}>
                <Undo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tp.back5}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => seek(current + SEEK_STEP_MS)} aria-label={tp.forward5}>
                <Redo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tp.forward5}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="size-8" onClick={restart} aria-label={tp.restart}>
                <RotateCcw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tp.restart}</TooltipContent>
          </Tooltip>
        </div>
        <span className="font-mono text-sm tabular-nums" data-testid="player-clock">
          {formatClock(current)} / {formatClock(total)}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="weldpanel-skip-inactivity" checked={skipInactive} onCheckedChange={setSkipInactive} />
            <Label htmlFor="weldpanel-skip-inactivity" className="text-sm font-normal">
              {tp.skipInactivity}
            </Label>
          </div>
          <Select value={String(speed)} onValueChange={(value) => setSpeed(Number(value))}>
            <SelectTrigger size="sm" className="h-8 w-20" aria-label={tp.speed}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAYBACK_SPEEDS.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {tp.speedValue.replace('{speed}', String(value))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={tp.fullscreen}
            onClick={() => void boxRef.current?.requestFullscreen?.()}
          >
            <Maximize2 />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TimelineLegend />
        <p className="text-xs text-muted-foreground">{tp.shortcuts}</p>
      </div>
    </div>
  );
}
