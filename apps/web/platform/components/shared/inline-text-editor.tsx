import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface InlineTextEditorProps {
  /** Current persisted value (server state). */
  value: string;
  /** Called with the trimmed, changed value when the user commits an edit. */
  onSave: (next: string) => void;
  /** Typography/colour classes shared by the idle and the editing state. */
  className?: string;
}

/**
 * Click-to-edit single-value text (task titles, record names). Idle it is a
 * native `<button>` that shows the text and wraps; clicking or pressing
 * Enter/Space swaps it for an auto-growing `<textarea>`. Enter or blur commits,
 * Escape cancels. Saves are optimistic: the displayed text mirrors the last
 * committed value so nothing flashes back to a stale prop while the API
 * update is in flight.
 */
export function InlineTextEditor({ value, onSave, className }: Readonly<InlineTextEditorProps>) {
  const [isEditing, setIsEditing] = useState(false);
  const [local, setLocal] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const idleButtonRef = useRef<HTMLButtonElement>(null);
  // Set when edit mode was left with the keyboard so focus returns to the
  // re-mounted idle button instead of dropping to <body>.
  const refocusIdleRef = useRef(false);
  // Guards against committing twice (Enter commit followed by the blur that
  // fires when the textarea unmounts).
  const finishedRef = useRef(true);

  // Pull in server-side changes, but never while the user is typing.
  const isEditingRef = useRef(isEditing);
  useEffect(() => { isEditingRef.current = isEditing; }, [isEditing]);
  useEffect(() => {
    if (isEditingRef.current) return;
    setLocal(value);
  }, [value]);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Seed the editor with the current local value and put the caret at the end.
  useLayoutEffect(() => {
    if (!isEditing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.value = local;
    resize();
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [isEditing, local, resize]);

  useEffect(() => {
    if (isEditing || !refocusIdleRef.current) return;
    refocusIdleRef.current = false;
    idleButtonRef.current?.focus();
  }, [isEditing]);

  const finish = (commit: boolean, refocus: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (commit) {
      const next = (textareaRef.current?.value ?? local).trim();
      if (next && next !== local) {
        setLocal(next);
        onSave(next);
      }
    }
    refocusIdleRef.current = refocus;
    setIsEditing(false);
  };

  const baseClassName =
    'rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 border outline-none whitespace-pre-wrap break-words min-w-0 cursor-text';

  if (!isEditing) {
    return (
      <button
        ref={idleButtonRef}
        type="button"
        onClick={() => {
          finishedRef.current = false;
          setIsEditing(true);
        }}
        className={cn(
          baseClassName,
          'block max-w-full text-left border-transparent hover:border-border transition-colors focus-visible:ring-1 focus-visible:ring-primary',
          className,
        )}
      >
        {local}
      </button>
    );
  }

  return (
    <textarea
      ref={textareaRef}
      rows={1}
      defaultValue={local}
      onInput={resize}
      onBlur={() => finish(true, false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true, true);
        } else if (e.key === 'Escape') {
          finish(false, true);
        }
      }}
      className={cn(
        baseClassName,
        'block w-full resize-none overflow-hidden bg-transparent border-border focus:ring-1 focus:ring-primary',
        className,
      )}
    />
  );
}
