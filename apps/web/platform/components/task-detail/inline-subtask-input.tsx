'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@weldsuite/ui/components/input';

interface InlineSubtaskInputProps {
  placeholder: string;
  /** Called with the trimmed, non-empty title when the user presses Enter. */
  onSubmit: (title: string) => void;
  /** Called when the user presses Escape, or leaves the field while empty. */
  onCancel: () => void;
}

/**
 * Inline title field for "Add subtask". Nothing is created until the user
 * presses Enter with a non-blank title; Escape (or blurring an empty field)
 * cancels without creating anything.
 *
 * Focus is taken explicitly on mount. The task chat composer next to the
 * panel grabs focus whenever its channel resolves, so relying on the browser
 * alone would let typed characters land in the chat instead.
 */
export function InlineSubtaskInput({ placeholder, onSubmit, onCancel }: Readonly<InlineSubtaskInputProps>) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against a double Enter (or Enter + blur) creating two subtasks.
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed || doneRef.current) return;
    doneRef.current = true;
    onSubmit(trimmed);
  };

  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <Input
      ref={inputRef}
      value={title}
      placeholder={placeholder}
      aria-label={placeholder}
      autoComplete="off"
      className="h-8 text-sm"
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => {
        // Keep the keystroke inside the field: panel/global shortcuts and the
        // surrounding chat must never see it.
        e.stopPropagation();
        if (e.key === 'Enter') {
          // Ignore the Enter that confirms an IME composition.
          if (e.nativeEvent.isComposing) return;
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={() => {
        if (!title.trim()) cancel();
      }}
    />
  );
}
