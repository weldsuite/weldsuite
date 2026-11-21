import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Pause, Play, Plus, Square, Timer } from 'lucide-react';
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
  takesOthersVotes,
  timerRemaining,
  timerRunning,
  voteCounts,
  votesLeft,
  type Board,
  type BoardElement,
} from '@weldsuite/board-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from './model/board-controller';
import { BarButton, SIDE_PANEL, SIDE_PANEL_HEADER } from './ui';

const TIMER_PRESETS = [1, 3, 5, 10, 15];
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '🤔'];
/** The name each reaction is announced by (`REACTIONS`, in order). */
const REACTION_NAMES = ['thumbsUp', 'heart', 'laugh', 'party', 'clap', 'thinking'] as const;

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

interface VotingLabels {
  title: string;
  left: string;
  leftOne: string;
  noneLeft: string;
  results: string;
  votes: string;
  oneVote: string;
}

/**
 * What the voting control says: while the round is open, the votes this
 * person has left (or just "Voting" for someone who cannot vote); once it
 * is closed, the results.
 */
function votingSummary(
  state: { open: boolean; canTakePart: boolean; myLeft: number; totalVotes: number },
  tv: VotingLabels,
  format: (template: string, values: Record<string, unknown>) => string,
): string {
  if (!state.open) {
    const total = state.totalVotes === 1 ? tv.oneVote : format(tv.votes, { count: state.totalVotes });
    return `${tv.results} · ${total}`;
  }
  if (!state.canTakePart) return tv.title;
  return votesLeftText(state.myLeft, tv, format);
}

/** "3 votes left", "1 vote left", "No votes left". */
function votesLeftText(left: number, tv: Pick<VotingLabels, 'left' | 'leftOne' | 'noneLeft'>, format: (template: string, values: Record<string, unknown>) => string): string {
  if (left === 1) return tv.leftOne;
  return left ? format(tv.left, { count: left }) : tv.noneLeft;
}

/** What an element is called in the results: the start of its text, its name or title, else its kind. */
function elementLabel(el: BoardElement, kinds: Record<string, string>): string {
  const text = (el.text?.text ?? el.name ?? el.title ?? '').replace(/\s+/g, ' ').trim();
  return text || kinds[el.type] || el.type;
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

/** The board's shared timer and the time it has left, ticking while it runs. */
function useBoardTimer(c: BoardController) {
  const [now, setNow] = useState(() => Date.now());
  const timer = c.board.props.timer ?? null;
  const running = timerRunning(timer);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running]);
  return { timer, running, left: timerRemaining(timer, now) };
}

/**
 * The header button that opens the facilitation panel. It stays on screen
 * while the panel is closed, so it rings when the timer runs out and shows
 * what is running: the clock, and the votes this person has left.
 */
export function FacilitateButton({
  controller: c,
  open,
  onToggle,
  className,
  idleHidden,
}: {
  controller: BoardController;
  open: boolean;
  onToggle: () => void;
  className?: string;
  /** No room in the header: shown only while a timer runs or a vote is open. */
  idleHidden?: boolean;
}) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const { t, format } = useI18n();
  const te = t.weldboard.editor;
  const { timer, running, left } = useBoardTimer(c);
  const round = c.board.props.voting ?? null;
  const canTakePart = !c.readOnly || c.canComment;

  // Say so once when the timer reaches zero.
  const rang = useRef<number | null>(null);
  useEffect(() => {
    if (!running || left > 0 || !timer?.endsAt || rang.current === timer.endsAt) return;
    rang.current = timer.endsAt;
    chime();
    toast.info(te.timer.done);
  }, [running, left, timer?.endsAt, te.timer.done]);

  const myLeft = round?.status === 'open' && canTakePart ? votesLeft(c.board, c.options.userId) : null;
  let votes: string | null = null;
  if (myLeft !== null) votes = votesLeftText(myLeft, te.voting, format);
  if (idleHidden && !timer && votes === null) return null;

  // A running timer or an open vote takes the label's place (the name stays for screen readers),
  // so the header around it doesn't shift.
  return (
    <Button
      size="sm"
      variant="outline"
      className={cn('h-8 min-w-24 gap-1.5', open && 'bg-accent', className)}
      aria-pressed={open}
      aria-label={[te.facilitation, timer ? clock(left) : null, votes].filter(Boolean).join(', ')}
      onClick={onToggle}
    >
      {timer ? (
        <>
          <Timer className="size-4 text-muted-foreground" aria-hidden />
          <span className={cn('font-mono tabular-nums', left === 0 && 'text-destructive')}>{clock(left)}</span>
        </>
      ) : (
        (votes ?? te.facilitation)
      )}
    </Button>
  );
}

/**
 * Facilitation for everyone on the board, in a panel on the right: a shared
 * timer, voting rounds, reactions and private mode. Starting and stopping is
 * for those who may edit; anyone who may comment can vote and react.
 */
export function FacilitationPanel({ controller: c, onClose }: { controller: BoardController; onClose: () => void }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const { t, format } = useI18n();
  const te = t.weldboard.editor;
  const tt = te.timer;
  const tv = te.voting;
  const { timer, running, left } = useBoardTimer(c);
  const round = c.board.props.voting ?? null;
  const canRun = !c.readOnly;
  const canTakePart = !c.readOnly || c.canComment;
  const me = c.options.userId;

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
    <aside className={SIDE_PANEL} aria-label={te.facilitation}>
      <div className={SIDE_PANEL_HEADER}>
        <h2 className="text-sm font-semibold">{te.facilitation}</h2>
        <BarButton label={t.common.actions.close} onClick={onClose}>
          <Plus className="rotate-45" />
        </BarButton>
      </div>
      <div className="min-h-0 flex-1 divide-y overflow-y-auto">
        {/* Timer */}
        {(timer || canRun) && (
          <section className="space-y-2 p-3">
            <h3 className="text-xs font-medium text-muted-foreground">{tt.title}</h3>
            {timer ? (
              <div className="flex items-center gap-0.5" role="timer" aria-label={tt.title}>
                <span className={cn('flex-1 font-mono text-2xl tabular-nums', left === 0 && 'text-destructive')}>{clock(left)}</span>
                {canRun && (
                  <>
                    {running ? (
                      <Button size="icon" variant="ghost" className="size-8" aria-label={tt.pause} onClick={() => c.apply(pauseTimerOp(timer, Date.now()))}>
                        <Pause className="size-4" />
                      </Button>
                    ) : (
                      <Button size="icon" variant="ghost" className="size-8" aria-label={tt.resume} onClick={() => c.apply(resumeTimerOp(timer, Date.now()))}>
                        <Play className="size-4" />
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" className="size-8" aria-label={tt.add} onClick={() => c.apply(addTimeOp(timer, 60_000, Date.now()))}>
                      <Plus className="size-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8" aria-label={tt.stop} onClick={() => c.apply(stopTimerOp())}>
                      <Square className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <>
                <p className="text-sm">{tt.startFor}</p>
                <div className="grid grid-cols-5 gap-1">
                  {TIMER_PRESETS.map((m) => (
                    <Button key={m} size="sm" variant="outline" className="px-0" onClick={() => c.apply(startTimerOp(m * 60_000, Date.now(), me))}>
                      {format(tt.minutes, { n: m })}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* Voting */}
        {(round || canRun) && (
          <section className="space-y-3 p-3">
            <h3 className="text-xs font-medium text-muted-foreground">{tv.title}</h3>
            {round ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm">{votingSummary({ open: round.status === 'open', canTakePart, myLeft, totalVotes }, tv, format)}</span>
                {canRun && round.status === 'open' && (
                  <Button size="sm" variant="outline" className="h-7" onClick={() => {
                    const op = closeVotingOp(c.board);
                    if (op) c.apply(op);
                  }}>
                    {tv.end}
                  </Button>
                )}
                {canRun && round.status === 'closed' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => c.apply(clearVotingOp(c.board), { undoable: !takesOthersVotes(c.board, me) })}
                  >
                    {tv.clearResults}
                  </Button>
                )}
              </div>
            ) : null}
            {round?.status === 'closed' && <VoteResults controller={c} />}
            {round ? null : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="wb-votes-each">{tv.votesPerPerson}</Label>
                  <NumberInput id="wb-votes-each" className="w-20" min={1} max={100} value={votesEach} onValueChange={(v) => setVotesEach(Math.min(100, Math.max(1, Math.round(v ?? 1))))} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={anonymous} onCheckedChange={(v) => setAnonymous(!!v)} />
                  {tv.anonymous}
                </label>
                {/* Only with something selected: says so, rather than just greying out. */}
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox className="mt-0.5" checked={onlySelection && c.selection.size > 0} disabled={c.selection.size === 0} onCheckedChange={(v) => setOnlySelection(!!v)} aria-describedby="wb-only-selection-hint" />
                  <span className={cn('flex flex-col', c.selection.size === 0 && 'text-muted-foreground')}>
                    {tv.onlySelection}
                    {c.selection.size === 0 && (
                      <span id="wb-only-selection-hint" className="text-xs">
                        {tv.selectFirst}
                      </span>
                    )}
                  </span>
                </label>
                <Button
                  className="w-full"
                  size="sm"
                  onClick={() => {
                    const scope = onlySelection && c.selection.size ? [...c.selection] : undefined;
                    c.apply(startVotingOp(c.board, { votesPerPerson: votesEach, anonymous, scope }, newId('v'), me), {
                      undoable: !takesOthersVotes(c.board, me),
                    });
                    toast.info(tv.clickToVote);
                  }}
                >
                  {tv.start}
                </Button>
              </>
            )}
          </section>
        )}

        {/* Reactions */}
        {canTakePart && (
          <section className="space-y-2 p-3">
            <h3 className="text-xs font-medium text-muted-foreground">{te.reactions.title}</h3>
            <div className="flex flex-wrap gap-1">
              {REACTIONS.map((emoji, i) => {
                const name = te.reactions.names[REACTION_NAMES[i]!];
                return (
                  <button key={emoji} type="button" className="rounded-md px-1.5 py-1 text-xl hover:bg-muted" onClick={() => react(emoji)} aria-label={name} title={name}>
                    <span aria-hidden>{emoji}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Private mode */}
        {canRun && (
          <section className="flex items-center justify-between gap-2 p-3">
            <Label htmlFor="wb-private-mode">{te.privateMode.title}</Label>
            <Switch id="wb-private-mode" checked={!!c.board.props.privateMode} onCheckedChange={(on) => c.apply(privateModeOp(on))} />
          </section>
        )}
      </div>
    </aside>
  );
}

/** The most voted items once a round is closed, most first: a click shows one on the board. */
function VoteResults({ controller: c }: { controller: BoardController }) {
  const { t } = useI18n();
  const te = t.weldboard.editor;
  const ranked = [...voteCounts(c.board)]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .flatMap(([id, n]) => {
      const el = c.board.get(id);
      return el ? [{ el, n }] : [];
    });
  if (!ranked.length) return <p className="text-sm text-muted-foreground">{te.voting.noVotes}</p>;
  return (
    <ol className="space-y-0.5" aria-label={te.voting.results}>
      {ranked.map(({ el, n }, i) => (
        <li key={el.id}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted"
            onClick={() => {
              c.select([el.id]);
              c.reveal(c.boundsOf(el));
            }}
          >
            <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{elementLabel(el, te.a11y.types as Record<string, string>)}</span>
            <span className="shrink-0 rounded-full bg-primary/10 px-2 text-xs font-medium tabular-nums text-primary">{n}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
