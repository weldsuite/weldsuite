/**
 * The session player: rrweb's `Replayer` (it renders the page in its own
 * sandboxed iframe) with our own controls laid over the bottom of the stage,
 * as a video player has them (and as WeldMeet's recording player does): the
 * timeline with event markers, play and pause, 5 seconds back and forward,
 * replay from the start, skip inactivity, speed and full screen. They show
 * while the mouse moves over the stage, while paused and while keyboard focus
 * is inside, and hide with the cursor after a moment of stillness. The page
 * being replayed and the key to the marker colours are in the details
 * column's Info tab. The replayer is rebuilt when the events change and
 * destroyed on unmount.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from 'react';
import { Replayer } from 'rrweb';
import 'rrweb/dist/style.css';
import { FastForward, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, SkipBack } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { Switch } from '@weldsuite/ui/components/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  INACTIVITY_MS,
  RRWEB_META,
  fitScale,
  formatClock,
  type ReplayEvent,
  type TimelineMarker,
  type TimeRange,
} from '../../lib/replay';
import { Timeline } from './timeline';

export const PLAYBACK_SPEEDS = [1, 2, 4, 8] as const;
const SEEK_STEP_MS = 5_000;
const TIME_REPORT_MS = 250;
/** How long the controls stay up after the mouse stops moving while playing. */
const CONTROLS_IDLE_MS = 2_500;

/** A control on the dark scrim, as on WeldMeet's video player; bigger on touch screens. */
const OVERLAY_BUTTON = 'size-8 text-white/80 hover:bg-white/10 hover:text-white dark:hover:bg-white/10 pointer-coarse:size-10 [&_svg]:size-3.5';
/** Left out when a phone recording makes the page narrow; the arrow keys and the timeline still seek. */
const NARROW_HIDDEN = '@max-xs:hidden';

export interface ReplayPlayerHandle {
  seek: (ms: number) => void;
}

interface ReplayPlayerProps {
  events: ReplayEvent[];
  markers: readonly TimelineMarker[];
  inactive: readonly TimeRange[];
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

export function ReplayPlayer({ events, markers, inactive, onTimeChange, onError, ref }: Readonly<ReplayPlayerProps>) {
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
  const [awake, setAwake] = useState(true);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerTypeRef = useRef('mouse');

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

  // Show the controls, and hide them again once the pointer has been still for a moment.
  const wake = useCallback(() => {
    setAwake(true);
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setAwake(false), CONTROLS_IDLE_MS);
  }, []);

  useEffect(() => {
    wake();
    return () => clearTimeout(idleTimerRef.current);
  }, [wake]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void boxRef.current?.requestFullscreen?.();
  }, []);

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
    wake();
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
  const ended = !playing && total > 0 && current >= total - 50;
  const showControls = !playing || awake || speedMenuOpen;

  // A click on the replayed page plays or pauses, as on a video; on a touch screen a tap first brings the controls up.
  function onStageClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (pointerTypeRef.current !== 'mouse' && !showControls) return;
    togglePlay();
  }

  return (
    <div className="grid gap-3" data-testid="replay-player">
      {/* The stage is the player's keyboard target (space, arrows): a custom widget, so it takes focus itself. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={boxRef}
        role="application"
        aria-label={tp.label}
        aria-keyshortcuts="Space ArrowLeft ArrowRight"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={wake}
        onPointerDown={(event) => {
          pointerTypeRef.current = event.pointerType;
          wake();
        }}
        onPointerLeave={() => {
          clearTimeout(idleTimerRef.current);
          setAwake(false);
        }}
        style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}
        className={cn(
          // No card and no padding: the stage takes the recording's shape, so the replayed page fills the width. A tall
          // (phone) recording stops at 80% of the window and is centred.
          'group/video relative max-h-[80vh] min-h-60 w-full overflow-hidden outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50',
          !showControls && 'cursor-none',
        )}
      >
        <div className="flex h-full w-full items-center justify-center">
          <div className="@container relative shrink-0 overflow-hidden bg-white" style={{ width: viewport.width * scale, height: viewport.height * scale }}>
            <div ref={stageRef} style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})`, transformOrigin: 'top left' }} />
            {/* Clicks on the replayed page must not reach the page's own controls: they play or pause instead. */}
            <div className="absolute inset-0" aria-hidden onClick={onStageClick} />
            {(skipping || ended) && (
              <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-medium text-white">
                {skipping && <FastForward className="size-3.5" aria-hidden />}
                {skipping ? tp.skipping : tp.finished}
              </span>
            )}

            {/* The controls, over the bottom of the replayed page. Hidden ones stay in the tab order and come back with keyboard focus. */}
            <div
              className={cn(
                'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-16 transition-opacity duration-300 motion-reduce:transition-none',
                showControls ? 'opacity-100' : 'opacity-0 group-has-[:focus-visible]/video:opacity-100',
              )}
            >
              <div className="px-4">
                <Timeline total={total} current={current} markers={markers} inactive={inactive} onSeek={seek} />
              </div>
              <div className="flex items-center gap-1 px-3 pb-2">
                <div className="flex items-center gap-0.5">
                  <Button type="button" variant="ghost" size="icon" className={OVERLAY_BUTTON} onClick={togglePlay} aria-label={playing ? tp.pause : tp.play}>
                    {playing ? <Pause /> : <Play />}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className={cn(OVERLAY_BUTTON, NARROW_HIDDEN)} onClick={() => seek(current - SEEK_STEP_MS)} aria-label={tp.back5}>
                        <RotateCcw />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{tp.back5}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className={cn(OVERLAY_BUTTON, NARROW_HIDDEN)} onClick={() => seek(current + SEEK_STEP_MS)} aria-label={tp.forward5}>
                        <RotateCw />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{tp.forward5}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className={OVERLAY_BUTTON} onClick={restart} aria-label={tp.restart}>
                        <SkipBack />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{tp.restart}</TooltipContent>
                  </Tooltip>
                </div>
                <span className="ml-2 font-mono text-xs tabular-nums text-white/90" data-testid="player-clock">
                  {formatClock(current)} / {formatClock(total)}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <div className="mr-1 flex items-center gap-2">
                    <Switch id="weldpanel-skip-inactivity" checked={skipInactive} onCheckedChange={setSkipInactive} />
                    <Label htmlFor="weldpanel-skip-inactivity" className="text-xs font-normal text-white/80 @max-md:sr-only">
                      {tp.skipInactivity}
                    </Label>
                  </div>
                  <DropdownMenu modal={false} open={speedMenuOpen} onOpenChange={setSpeedMenuOpen}>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" className={cn(OVERLAY_BUTTON, 'w-auto px-2 text-xs font-medium')} aria-label={tp.speed}>
                        {tp.speedValue.replace('{speed}', String(speed))}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
                      <DropdownMenuRadioGroup value={String(speed)} onValueChange={(value) => setSpeed(Number(value))}>
                        {PLAYBACK_SPEEDS.map((value) => (
                          <DropdownMenuRadioItem key={value} value={String(value)}>
                            {tp.speedValue.replace('{speed}', String(value))}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button type="button" variant="ghost" size="icon" className={OVERLAY_BUTTON} aria-label={tp.fullscreen} aria-pressed={fullscreen} onClick={toggleFullscreen}>
                    {fullscreen ? <Minimize /> : <Maximize />}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
