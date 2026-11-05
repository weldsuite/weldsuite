import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { EyeOff, Eye, Pause, Play, Plus, SmilePlus, Square, Timer, Vote } from 'lucide-react';
import {
  addTimeOp,
  clearVotingOp,
  closeVotingOp,
  newId,
  pauseTimerOp,
  privateModeOp,
  resumeTimerOp,
  startTimerOp,
  startVotingOp,
  stopTimerOp,
  timerRemaining,
  timerRunning,
  voteCounts,
  votesLeft,
  type Board,
} from '@weldsuite/board-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from './model/board-controller';

const TIMER_PRESETS = [1, 3, 5, 10, 15];
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '🤔'];

/** mm:ss (h:mm:ss past an hour). */
export function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/**
 * The votes the canvas shows, and what it fades: in an open anonymous round
 * a person sees only their own votes until it ends; a round limited to some
 * elements fades the rest.
 */
export function votingView(board: Board, userId: string): { votes?: Map<string, number>; faded?: ReadonlySet<string> } {
  const round = board.props.voting;
  if (!round) return {};
  let votes: Map<string, number>;
  if (round.status === 'open' && round.anonymous) {
    votes = new Map();
    for (const id of board.votes.get(userId) ?? []) votes.set(id, (votes.get(id) ?? 0) + 1);
  } else votes = voteCounts(board);
  let faded: Set<string> | undefined;
  if (round.status === 'open' && round.scope) {
    const keep = new Set(round.scope);
    faded = new Set();
    for (const el of board.elements.values()) if (!keep.has(el.id) && el.type !== 'frame' && el.type !== 'group') faded.add(el.id);
  }
  return { votes, faded };
}

/** A short tone when the timer runs out (no sound file needed). */
function chime(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.8);
    osc.onended = () => void ctx.close();
  } catch {
    // No audio here: the notice is enough.
  }
}

/**
 * Facilitation for everyone on the board, at the bottom: a shared timer,
 * voting rounds, reactions and private mode. Starting and stopping is for
 * those who may edit; anyone who may comment can vote and react.
 */
export function FacilitationBar({ controller: c }: { controller: BoardController }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const { t, format } = useI18n();
  const te = t.weldboard.editor;
  const tt = te.timer;
  const tv = te.voting;
  const [now, setNow] = useState(() => Date.now());
  const timer = c.board.props.timer ?? null;
  const round = c.board.props.voting ?? null;
  const canRun = !c.readOnly;
  const canTakePart = !c.readOnly || c.canComment;
  const me = c.options.userId;

  // Tick while a timer runs; say so once when it reaches zero.
  const running = timerRunning(timer);
  const left = timerRemaining(timer, now);
  const rang = useRef<number | null>(null);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running]);
  useEffect(() => {
    if (!running || left > 0 || !timer?.endsAt || rang.current === timer.endsAt) return;
    rang.current = timer.endsAt;
    chime();
    toast.info(tt.done);
  }, [running, left, timer?.endsAt, tt.done]);

  const [votesEach, setVotesEach] = useState(3);
  const [anonymous, setAnonymous] = useState(false);
  const [onlySelection, setOnlySelection] = useState(false);

  const myLeft = round ? votesLeft(c.board, me) : 0;
  const totalVotes = [...c.board.votes.values()].reduce((n, v) => n + v.length, 0);

  const react = (emoji: string) => {
    c.reaction = [emoji, Date.now()];
    c.changed();
  };

  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-xl border bg-background px-1.5 py-1 shadow-md">
      {/* Timer */}
      {timer ? (
        <div className="flex items-center gap-0.5" role="timer" aria-label={tt.title}>
          <span className={cn('min-w-[3.5rem] px-1 text-center font-mono text-sm tabular-nums', left === 0 && 'text-destructive')}>{clock(left)}</span>
          {canRun && (
            <>
              {running ? (
                <Button size="icon" variant="ghost" className="size-7" aria-label={tt.pause} onClick={() => c.apply(pauseTimerOp(timer, Date.now()))}>
                  <Pause className="size-4" />
                </Button>
              ) : (
                <Button size="icon" variant="ghost" className="size-7" aria-label={tt.resume} onClick={() => c.apply(resumeTimerOp(timer, Date.now()))}>
                  <Play className="size-4" />
                </Button>
              )}
              <Button size="icon" variant="ghost" className="size-7" aria-label={tt.add} onClick={() => c.apply(addTimeOp(timer, 60_000, Date.now()))}>
                <Plus className="size-4" />
              </Button>
              <Button size="icon" variant="ghost" className="size-7" aria-label={tt.stop} onClick={() => c.apply(stopTimerOp())}>
                <Square className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      ) : (
        canRun && (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="h-8 gap-1.5">
                <Timer className="size-4" />
                <span className="hidden sm:inline">{tt.title}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-56">
              <p className="mb-2 text-sm font-medium">{tt.startFor}</p>
              <div className="grid grid-cols-5 gap-1">
                {TIMER_PRESETS.map((m) => (
                  <Button key={m} size="sm" variant="outline" onClick={() => c.apply(startTimerOp(m * 60_000, Date.now(), me))}>
                    {format(tt.minutes, { n: m })}
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )
      )}

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

      {/* Voting */}
      {round ? (
        <div className="flex items-center gap-1">
          <Vote className="ml-1 size-4 text-muted-foreground" aria-hidden="true" />
          <span className="px-1 text-sm">
            {round.status === 'open' ? (canTakePart ? (myLeft ? format(tv.left, { count: myLeft }) : tv.noneLeft) : tv.title) : `${tv.results} · ${totalVotes === 1 ? tv.oneVote : format(tv.votes, { count: totalVotes })}`}
          </span>
          {canRun && round.status === 'open' && (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => {
              const op = closeVotingOp(c.board);
              if (op) c.apply(op);
            }}>
              {tv.end}
            </Button>
          )}
          {canRun && round.status === 'closed' && (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => c.apply(clearVotingOp(c.board))}>
              {tv.clearResults}
            </Button>
          )}
        </div>
      ) : (
        canRun && (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="h-8 gap-1.5">
                <Vote className="size-4" />
                <span className="hidden sm:inline">{tv.title}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-64 space-y-3">
              <p className="text-sm font-medium">{tv.start}</p>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="wb-votes-each">{tv.votesPerPerson}</Label>
                <NumberInput id="wb-votes-each" className="w-20" min={1} max={100} value={votesEach} onValueChange={(v) => setVotesEach(Math.min(100, Math.max(1, Math.round(v ?? 1))))} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={anonymous} onCheckedChange={(v) => setAnonymous(!!v)} />
                {tv.anonymous}
              </label>
              <label className={cn('flex items-center gap-2 text-sm', c.selection.size === 0 && 'opacity-50')}>
                <Checkbox checked={onlySelection && c.selection.size > 0} disabled={c.selection.size === 0} onCheckedChange={(v) => setOnlySelection(!!v)} />
                {tv.onlySelection}
              </label>
              <Button
                className="w-full"
                size="sm"
                onClick={() => {
                  const scope = onlySelection && c.selection.size ? [...c.selection] : undefined;
                  c.apply(startVotingOp(c.board, { votesPerPerson: votesEach, anonymous, scope }, newId('v'), me));
                  toast.info(tv.clickToVote);
                }}
              >
                {tv.start}
              </Button>
            </PopoverContent>
          </Popover>
        )
      )}

      {/* Reactions */}
      {canTakePart && (
        <Popover>
          <PopoverTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8" aria-label={te.reactions.title}>
              <SmilePlus className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" className="flex w-auto gap-1 p-1.5">
            {REACTIONS.map((emoji) => (
              <button key={emoji} type="button" className="rounded-md px-1.5 py-1 text-xl hover:bg-muted" onClick={() => react(emoji)} aria-label={emoji}>
                {emoji}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      )}

      {/* Private mode */}
      {canRun && (
        <Button
          size="icon"
          variant={c.board.props.privateMode ? 'secondary' : 'ghost'}
          className="size-8"
          aria-pressed={!!c.board.props.privateMode}
          aria-label={c.board.props.privateMode ? te.privateMode.reveal : te.privateMode.start}
          title={c.board.props.privateMode ? te.privateMode.reveal : te.privateMode.start}
          onClick={() => c.apply(privateModeOp(!c.board.props.privateMode))}
        >
          {c.board.props.privateMode ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      )}
    </div>
  );
}
