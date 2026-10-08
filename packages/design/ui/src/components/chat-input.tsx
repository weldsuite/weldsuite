"use client";

import * as React from "react";
import {
  Plus,
  Smile,
  AtSign,
  Baseline,
  Video,
  Mic,
  ArrowUp,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@weldsuite/ui/lib/utils";
import { Button } from "@weldsuite/ui/components/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatInputAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

export interface MentionOption {
  userId: string;
  name: string;
  email?: string | null;
  avatar?: string | null;
}

export interface ChatInputSendPayload {
  /** Content with `<@userId>` tokens in place of mention badges. */
  content: string;
  mentions: string[];
}

export interface ChatInputProps {
  value: string;
  onValueChange: (value: string) => void;
  onSend: (payload: ChatInputSendPayload) => void;

  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  autoFocus?: boolean;

  onAttach?: () => void;
  onEmoji?: () => void;
  onFormat?: () => void;
  onVideo?: () => void;
  onAudio?: () => void;

  /**
   * When provided, the input switches to rich mode: typing `@` opens an
   * inline autocomplete, and selected mentions render as badges. The
   * mention toolbar button becomes an `@` insertion trigger automatically.
   */
  mentionOptions?: MentionOption[];
  onMention?: () => void;

  recording?: "video" | "audio" | null;

  extraActions?: ChatInputAction[];
  leftActions?: React.ReactNode;

  topSlot?: React.ReactNode;
  inlineSlot?: React.ReactNode;

  className?: string;
  rows?: number;

  textareaProps?: Omit<
    React.ComponentProps<"textarea">,
    "value" | "onChange" | "placeholder" | "disabled"
  >;
}

// ---------------------------------------------------------------------------
// DOM helpers (rich mode)
// ---------------------------------------------------------------------------

function extractContentAndMentions(root: HTMLElement): { content: string; mentions: string[] } {
  const clone = root.cloneNode(true) as HTMLElement;
  const mentions: string[] = [];
  clone.querySelectorAll<HTMLElement>("span[data-mention-userid]").forEach((el) => {
    const userId = el.dataset.mentionUserid ?? "";
    if (userId) {
      if (!mentions.includes(userId)) mentions.push(userId);
      el.replaceWith(document.createTextNode(`<@${userId}>`));
    }
  });
  clone.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")));
  const content = clone.textContent ?? "";
  return { content, mentions };
}

function extractPlainText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")));
  return clone.textContent ?? "";
}

function placeCaretAfter(node: Node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * The `@query` being typed at the caret inside `el`, or `null` when the caret
 * is not in a mention position.
 */
function getMentionQueryAtCaret(el: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const text = (range.startContainer.textContent ?? "").slice(0, range.startOffset);
  const atIdx = text.lastIndexOf("@");
  if (atIdx === -1) return null;
  const charBefore = atIdx === 0 ? " " : text[atIdx - 1];
  if (charBefore && !/\s/.test(charBefore)) return null;
  const query = text.slice(atIdx + 1);
  return /\s/.test(query) ? null : query;
}

/**
 * Replace the `@query` before the caret with a mention badge. Returns false
 * when the caret is not in a mention position (nothing is changed then).
 */
function insertMentionBadge(el: HTMLElement, member: MentionOption): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;

  const textNode = range.startContainer as Text;
  const text = textNode.textContent ?? "";
  const caret = range.startOffset;
  const atIdx = text.slice(0, caret).lastIndexOf("@");
  if (atIdx === -1) return false;

  textNode.textContent = text.slice(0, atIdx) + text.slice(caret);

  const insertRange = document.createRange();
  insertRange.setStart(textNode, atIdx);
  insertRange.collapse(true);

  const badge = document.createElement("span");
  badge.dataset.mentionUserid = member.userId;
  badge.setAttribute("contenteditable", "false");
  badge.className =
    "inline-block bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 rounded px-1.5 py-0 text-[13px] font-medium align-middle mx-0.5";
  badge.textContent = `@${member.name}`;

  insertRange.insertNode(badge);
  const trailing = document.createTextNode("\u00A0");
  badge.after(trailing);
  placeCaretAfter(trailing);
  return true;
}

type MentionKeyAction = "next" | "previous" | "select" | "close";

function getMentionKeyAction(key: string): MentionKeyAction | null {
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Enter":
    case "Tab":
      return "select";
    case "Escape":
      return "close";
    default:
      return null;
  }
}

function buildBuiltInActions(opts: {
  isRich: boolean;
  onAttach?: () => void;
  onEmoji?: () => void;
  onMention?: () => void;
  onFormat?: () => void;
  insertAtToken: () => void;
}): ChatInputAction[] {
  const { isRich, onAttach, onEmoji, onMention, onFormat, insertAtToken } = opts;
  const actions: ChatInputAction[] = [];
  if (onAttach) actions.push({ icon: Plus, label: "Attach", onClick: onAttach });
  if (onEmoji) actions.push({ icon: Smile, label: "Emoji", onClick: onEmoji });
  if (isRich || onMention) {
    actions.push({
      icon: AtSign,
      label: "Mention",
      onClick: onMention ?? (isRich ? insertAtToken : () => {}),
    });
  }
  if (onFormat) actions.push({ icon: Baseline, label: "Formatting", onClick: onFormat });
  return actions;
}

function buildMediaActions(opts: {
  recording: "video" | "audio" | null;
  onVideo?: () => void;
  onAudio?: () => void;
}): ChatInputAction[] {
  const { recording, onVideo, onAudio } = opts;
  const actions: ChatInputAction[] = [];
  if (onVideo) {
    actions.push({
      icon: Video,
      label: "Record video",
      onClick: onVideo,
      active: recording === "video",
    });
  }
  if (onAudio) {
    actions.push({
      icon: Mic,
      label: "Record audio",
      onClick: onAudio,
      active: recording === "audio",
    });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ChatInput = React.forwardRef<HTMLTextAreaElement, ChatInputProps>(
  function ChatInput(props, ref) {
    const {
      value,
      onValueChange,
      onSend,
      placeholder = "Type a message...",
      disabled,
      submitDisabled,
      autoFocus,
      onAttach,
      onEmoji,
      onMention,
      onFormat,
      onVideo,
      onAudio,
      mentionOptions,
      recording = null,
      extraActions,
      leftActions,
      topSlot,
      inlineSlot,
      className,
      rows = 1,
      textareaProps,
    } = props;

    const isRich = !!mentionOptions;
    const canSend = !disabled && !submitDisabled && value.trim().length > 0;

    const editorRef = React.useRef<HTMLDivElement>(null);
    const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
    const [mentionActive, setMentionActive] = React.useState(0);

    React.useEffect(() => {
      if (!isRich) return;
      const el = editorRef.current;
      if (!el) return;
      const current = extractPlainText(el);
      if (value === "" && current !== "") {
        el.innerHTML = "";
      }
    }, [isRich, value]);

    const syncFromEditor = React.useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      onValueChange(extractPlainText(el));
    }, [onValueChange]);

    const detectMentionQuery = React.useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const query = getMentionQueryAtCaret(el);
      setMentionQuery(query);
      if (query !== null) setMentionActive(0);
    }, []);

    const filteredMentions = React.useMemo(() => {
      if (!mentionOptions || mentionQuery === null) return [];
      const q = mentionQuery.toLowerCase();
      if (!q) return mentionOptions.slice(0, 8);
      return mentionOptions
        .filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            (m.email ?? "").toLowerCase().includes(q),
        )
        .slice(0, 8);
    }, [mentionOptions, mentionQuery]);

    const insertMention = React.useCallback(
      (member: MentionOption) => {
        const el = editorRef.current;
        if (!el) return;
        if (!insertMentionBadge(el, member)) return;
        setMentionQuery(null);
        syncFromEditor();
      },
      [syncFromEditor],
    );

    const insertAtToken = React.useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      document.execCommand("insertText", false, "@");
      detectMentionQuery();
    }, [detectMentionQuery]);

    const handleMentionKey = React.useCallback(
      (action: MentionKeyAction) => {
        const count = filteredMentions.length;
        switch (action) {
          case "next":
            setMentionActive((i) => (i + 1) % count);
            break;
          case "previous":
            setMentionActive((i) => (i - 1 + count) % count);
            break;
          case "select": {
            const activeMention = filteredMentions[mentionActive];
            if (activeMention) insertMention(activeMention);
            break;
          }
          case "close":
            setMentionQuery(null);
            break;
        }
      },
      [filteredMentions, mentionActive, insertMention],
    );

    const handleRichKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (mentionQuery !== null && filteredMentions.length > 0) {
          const action = getMentionKeyAction(e.key);
          if (action) {
            e.preventDefault();
            handleMentionKey(action);
            return;
          }
        }

        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (!canSend) return;
          const el = editorRef.current;
          if (!el) return;
          const { content, mentions } = extractContentAndMentions(el);
          onSend({ content: content.trim(), mentions });
        }
      },
      [mentionQuery, filteredMentions.length, handleMentionKey, canSend, onSend],
    );

    const handleTextareaKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        textareaProps?.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (canSend) onSend({ content: value, mentions: [] });
        }
      },
      [textareaProps, onSend, canSend, value],
    );

    const builtInActions = buildBuiltInActions({
      isRich,
      onAttach,
      onEmoji,
      onMention,
      onFormat,
      insertAtToken,
    });
    const mediaActions = buildMediaActions({ recording, onVideo, onAudio });

    const handleSendClick = React.useCallback(() => {
      if (!canSend) return;
      if (isRich) {
        const el = editorRef.current;
        if (!el) return;
        const { content, mentions } = extractContentAndMentions(el);
        onSend({ content: content.trim(), mentions });
      } else {
        onSend({ content: value, mentions: [] });
      }
    }, [canSend, isRich, onSend, value]);

    return (
      <div
        className={cn(
          "border-input focus-within:border-ring focus-within:ring-ring/50 relative flex flex-col rounded-2xl border bg-background shadow-xs transition-[color,box-shadow] focus-within:ring-[3px]",
          disabled && "opacity-50",
          className,
        )}
        data-slot="chat-input"
      >
        {topSlot ? <div className="border-b px-3 py-2">{topSlot}</div> : null}

        {isRich ? (
          <div
            ref={editorRef}
            role="textbox"
            tabIndex={disabled ? -1 : 0}
            aria-multiline="true"
            aria-label={placeholder}
            contentEditable={!disabled}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            onInput={() => {
              syncFromEditor();
              detectMentionQuery();
            }}
            onKeyUp={detectMentionQuery}
            onClick={detectMentionQuery}
            onBlur={() => setTimeout(() => setMentionQuery(null), 120)}
            onKeyDown={handleRichKeyDown}
            autoFocus={autoFocus}
            className={cn(
              "placeholder:text-muted-foreground min-h-[44px] max-h-60 w-full overflow-y-auto bg-transparent px-4 pt-3 pb-1 text-sm outline-none whitespace-pre-wrap break-words",
              "empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
            )}
          />
        ) : (
          <textarea
            {...textareaProps}
            ref={ref}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            rows={rows}
            className={cn(
              "placeholder:text-muted-foreground field-sizing-content max-h-60 min-h-[44px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none disabled:cursor-not-allowed",
              textareaProps?.className,
            )}
          />
        )}

        {isRich && mentionQuery !== null && filteredMentions.length > 0 && (
          <div className="absolute bottom-full left-2 right-2 mb-2 z-50 rounded-lg border bg-popover shadow-lg max-h-56 overflow-y-auto">
            {filteredMentions.map((m, i) => (
              <button
                key={m.userId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(m);
                }}
                onMouseEnter={() => setMentionActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                  i === mentionActive ? "bg-muted" : "hover:bg-muted",
                )}
              >
                {m.avatar ? (
                  <img src={m.avatar} alt="" className="h-5 w-5 rounded" />
                ) : (
                  <div className="bg-muted flex h-5 w-5 items-center justify-center rounded text-[10px] font-medium">
                    {(m.name || "?").slice(0, 1).toUpperCase()}
                  </div>
                )}
                <span className="font-medium">{m.name}</span>
                {m.email && <span className="text-muted-foreground text-xs">{m.email}</span>}
              </button>
            ))}
          </div>
        )}

        {inlineSlot ? <div className="px-3 pb-2">{inlineSlot}</div> : null}

        <div className="flex items-center justify-between gap-1 px-2 pt-1 pb-2">
          <div className="flex items-center gap-0.5">
            {leftActions ?? (
              <>
                {builtInActions.map((action) => (
                  <ActionButton key={action.label} {...action} />
                ))}

                {(builtInActions.length > 0 && (mediaActions.length > 0 || (extraActions?.length ?? 0) > 0)) && (
                  <div className="bg-border mx-1 h-4 w-px" aria-hidden />
                )}

                {mediaActions.map((action) => (
                  <ActionButton key={action.label} {...action} />
                ))}

                {extraActions?.map((action) => (
                  <ActionButton key={action.label} {...action} />
                ))}
              </>
            )}
          </div>

          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={handleSendClick}
            disabled={!canSend}
            aria-label="Send message"
            className="size-8 rounded-full"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
    );
  },
);

function ActionButton({ icon: Icon, label, onClick, disabled, active }: Readonly<ChatInputAction>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "text-muted-foreground hover:text-foreground size-8 rounded-md",
        active && "text-destructive",
      )}
    >
      <Icon className="size-4" />
    </Button>
  );
}
