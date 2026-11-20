/**
 * The AI island: at rest a small pill with a sparkle (as in Google Workspace)
 * at the bottom centre of what it works on; hovered or clicked, it opens into
 * the WeldAgent composer (`AgentChatInput`, stacked, as in the agent panel)
 * with the surface's own actions in its button row. One component for every
 * surface that has one (the mail composer, the whiteboard), so they look and
 * behave the same.
 */
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { Plus, Sparkle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { AGENT_INPUT_ICON_BUTTON, AgentChatInput } from './agent-chat-input';

/** The look of a text button (a picked option) in the island's action row. */
export const AGENT_ISLAND_TEXT_BUTTON = cn(AGENT_INPUT_ICON_BUTTON, 'w-auto px-2 text-sm font-normal');

/** What the island hands to the actions it shows. */
export interface AgentIslandControls {
  /** Spread on a `DropdownMenu` in the action row: while it is open the island stays open. */
  menu: (id: string, onOpen?: () => void) => { open: boolean; onOpenChange: (open: boolean) => void };
  /** `onCloseAutoFocus` of a menu's content: back to typing, not to the button that opened it. */
  backToPrompt: (e: Event) => void;
  /** Puts text in the prompt (a prompt idea). */
  setPrompt: (text: string) => void;
}

export interface AgentIslandHandle {
  /** Opens the island with the cursor in its prompt (a toolbar button, a shortcut). */
  open: () => void;
}

/** How long the mouse rests on the pill before the island opens. */
const HOVER_OPEN_MS = 50;
/** How long after the mouse leaves an untouched island before it folds back. */
const HOVER_FOLD_MS = 100;
/** The fold-back animation (`duration-150` on the island). */
const FOLD_MS = 150;

export function AgentIsland({
  label,
  placeholder,
  busy,
  onSubmit,
  startActions,
  endActions,
  testIdPrefix,
  ref,
}: Readonly<{
  /** Names the pill and the open island ("Write with AI"). */
  label: string;
  placeholder: string;
  /** The AI is working: the actions are off and the island stays open. */
  busy: boolean;
  /** Runs the prompt; resolves to whether it did something, which is when the island folds back. */
  onSubmit: (prompt: string) => Promise<boolean> | boolean;
  /** Buttons at the start of the action row (prompt ideas, options). */
  startActions?: (controls: AgentIslandControls) => ReactNode;
  /** Buttons just before send. */
  endActions?: (controls: AgentIslandControls) => ReactNode;
  /** `<prefix>-ai-pill` and `<prefix>-ai-island`. */
  testIdPrefix: string;
  ref?: Ref<AgentIslandHandle>;
}>) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // Playing the fold-back animation; the island unmounts when it ends.
  const [closing, setClosing] = useState(false);
  const islandRef = useRef<HTMLDivElement>(null);
  // One pending hover open or fold-back at a time.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clicked in the island since it opened: it no longer folds on mouse leave.
  const engagedRef = useRef(false);
  // Closed (Escape, sent) with the mouse over the island, where the pill comes
  // back: no hover-open until the mouse moves off the pill, or it would spring
  // open again. Closed with the mouse elsewhere, the next hover opens it.
  const hoverBlockedRef = useRef(false);
  // Lifts that block (and stops watching the mouse for it).
  const unblockHoverRef = useRef<(() => void) | null>(null);
  // Where the cursor was before the island took it (a field, a spot in a
  // text, the whiteboard), to put it back if the island is left unused.
  const returnFocusRef = useRef<{ el: HTMLElement; range: Range | null } | null>(null);

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => clearTimer, []);
  useEffect(() => () => unblockHoverRef.current?.(), []);

  const focusPrompt = () => islandRef.current?.querySelector('textarea')?.focus();

  const rememberFocus = () => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body || islandRef.current?.contains(el)) {
      returnFocusRef.current = null;
      return;
    }
    const selection = window.getSelection();
    const range =
      selection && selection.rangeCount > 0 && el.contains(selection.getRangeAt(0).startContainer)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    returnFocusRef.current = { el, range };
  };

  const returnFocus = () => {
    const saved = returnFocusRef.current;
    returnFocusRef.current = null;
    if (!saved?.el.isConnected) return;
    saved.el.focus();
    if (saved.range?.startContainer.isConnected) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(saved.range);
    }
  };

  // Folds back into the pill: the island shrinks and fades, then goes. With
  // `restore`, the cursor goes back to where it was before the island opened.
  const foldBack = (restore = false) => {
    clearTimer();
    setClosing(true);
    timerRef.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
      timerRef.current = null;
    }, FOLD_MS);
    if (restore) returnFocus();
    else returnFocusRef.current = null;
  };

  const blockHoverWhileResting = () => {
    unblockHoverRef.current?.();
    if (!islandRef.current?.matches(':hover')) return;
    hoverBlockedRef.current = true;
    const pill = `[data-testid="${testIdPrefix}-ai-pill"]`;
    const onMove = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest(pill))) unblock();
    };
    const unblock = () => {
      hoverBlockedRef.current = false;
      document.removeEventListener('pointermove', onMove);
      unblockHoverRef.current = null;
    };
    document.addEventListener('pointermove', onMove);
    unblockHoverRef.current = unblock;
  };

  const close = () => {
    setPrompt('');
    blockHoverWhileResting();
    foldBack(true);
  };

  const submit = async (text: string) => {
    if (!text.trim() || busy) return;
    if (await onSubmit(text.trim())) close();
  };

  // Opening puts the cursor in the prompt straight away, by hover or by click.
  // A click on the pill already engages; a hover does not until the user acts.
  const openIsland = (byClick: boolean) => {
    clearTimer();
    if (!open || closing) rememberFocus();
    engagedRef.current = byClick;
    setClosing(false);
    setOpen(true);
    // Reopened while folding (or opened again from outside): the prompt is there, so focus it now.
    if (open) focusPrompt();
  };

  useImperativeHandle(ref, () => ({ open: () => openIsland(true) }));

  // A short pause before a hover opens it, so the mouse passing by does not.
  const hoverPill = () => {
    clearTimer();
    if (hoverBlockedRef.current) return;
    timerRef.current = setTimeout(() => openIsland(false), HOVER_OPEN_MS);
  };

  const canFold = () => !openMenu && !busy && !prompt.trim();

  // An empty prompt folds back into the pill when the cursor goes elsewhere.
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (closing || !canFold()) return;
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    foldBack();
  };

  // Opened by hovering and left alone: folds back a moment after the mouse
  // leaves (unless it comes back first) and hands the cursor back.
  const handleMouseLeave = () => {
    if (!canFold() || engagedRef.current) return;
    clearTimer();
    timerRef.current = setTimeout(() => foldBack(true), HOVER_FOLD_MS);
  };

  const pill = (
    <Button
      type="button"
      variant="secondary"
      aria-label={label}
      title={label}
      data-testid={`${testIdPrefix}-ai-pill`}
      onMouseEnter={hoverPill}
      onMouseLeave={() => {
        clearTimer();
        unblockHoverRef.current?.();
      }}
      onClick={() => openIsland(true)}
      // Seen on any background (a light canvas as much as a page): a border and a shadow, and a 24px target.
      className="pointer-events-auto h-6 w-[92px] rounded-full border border-border p-0 shadow-sm"
    >
      <Sparkle aria-hidden="true" className="size-3 fill-current" />
    </Button>
  );

  // The row keeps the pill's height; the open island floats up from there,
  // over what is above it, so opening it never pushes anything aside.
  if (!open) {
    return <div className="relative flex w-full justify-center">{pill}</div>;
  }

  const controls: AgentIslandControls = {
    menu: (id, onOpen) => ({
      open: openMenu === id,
      onOpenChange: (next) => {
        if (next) onOpen?.();
        setOpenMenu(next ? id : null);
      },
    }),
    backToPrompt: (e) => {
      e.preventDefault();
      focusPrompt();
    },
    setPrompt,
  };

  return (
    <div className="relative flex w-full justify-center">
      {/* The pill stays under the island while it folds back into it. */}
      {closing ? pill : <div aria-hidden="true" className="h-6" />}
      <div
        ref={islandRef}
        role="group"
        aria-label={label}
        data-testid={`${testIdPrefix}-ai-island`}
        onBlur={handleBlur}
        onPointerDown={() => {
          engagedRef.current = true;
        }}
        onMouseEnter={clearTimer}
        onMouseLeave={handleMouseLeave}
        className={cn(
          'pointer-events-auto absolute inset-x-0 bottom-0 z-10 mx-auto w-full max-w-[672px] origin-bottom',
          closing
            ? 'pointer-events-none animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-2 fill-mode-forwards duration-150 ease-in'
            : 'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150 ease-out',
        )}
      >
        <AgentChatInput
          variant="stacked"
          value={prompt}
          onChange={setPrompt}
          onSubmit={(text) => void submit(text)}
          onEscape={close}
          placeholder={placeholder}
          isSending={busy}
          autoFocus
          recordTags={false}
          startActions={startActions?.(controls)}
          endActions={endActions?.(controls)}
        />
      </div>
    </div>
  );
}

/** The `+` button of an island: prompt ideas that fill in the prompt. */
export function AgentIslandIdeas({
  controls,
  label,
  ideas,
  disabled,
}: Readonly<{ controls: AgentIslandControls; label: string; ideas: readonly string[]; disabled?: boolean }>) {
  return (
    <DropdownMenu {...controls.menu('ideas')}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={label}
          title={label}
          className={AGENT_INPUT_ICON_BUTTON}
        >
          <Plus className="h-[18px] w-[18px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64" onCloseAutoFocus={controls.backToPrompt}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {ideas.map((idea) => (
          <DropdownMenuItem key={idea} onSelect={() => controls.setPrompt(idea)}>
            {idea}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
