/**
 * `PropertyRow` — the icon + label + inline-editable value row that drives
 * the Details tab of every object panel.
 *
 * Visual reference: the customer/contact panel's left column — see the
 * screenshot in the design dump. Each row is a flex three-track layout:
 *
 *   [icon] [label]                                  [value or placeholder]
 *
 * When the value is empty the right cell shows a muted "Set X…" affordance.
 * Clicking the value cell switches the row into an inline editor matching
 * the declared `type`. Saving commits via the parent-supplied `onSave`.
 *
 * Supported types so far:
 *  - text       single-line text
 *  - email      single-line, type="email"
 *  - phone      single-line, type="tel"
 *  - url        single-line, type="url"; renders as a clickable link in read mode
 *  - address    multiline textarea, persisted as a free string
 *
 * Additional types (user picker, multi-select, status select) can be added
 * later — they were intentionally left out of the first cut to keep this
 * primitive small. Until they exist, callers should render those rows
 * inline themselves and use this component for the simple field types.
 */

import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';

type PropertyRowType = 'text' | 'email' | 'phone' | 'url' | 'address';

export interface PropertyRowProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Current value. `null` / `undefined` / `''` triggers the placeholder. */
  value?: string | null;
  /** Placeholder displayed when value is empty. Falls back to `Set {label}…`. */
  placeholder?: string;
  /** What kind of editor to render when the row is clicked. */
  type?: PropertyRowType;
  /**
   * Called when the user commits an edit. Receives the new value, or `null`
   * when the user clears the field. Skip rendering an editor by passing
   * `readOnly`.
   */
  onSave?: (next: string | null) => void | Promise<void>;
  readOnly?: boolean;
  /**
   * Optional override for the value render. Used for non-text values like
   * linked entities (Owner avatar + name, Domain link). When provided,
   * `value` is still used for the empty-check and inline editor seed.
   */
  renderValue?: (value: string | null | undefined) => React.ReactNode;
  /**
   * Optional accessory rendered on the far right of the row in read mode
   * (e.g. a chevron for a select field). Hidden while editing.
   */
  accessory?: React.ReactNode;
}

export function PropertyRow({
  icon: Icon,
  label,
  value,
  placeholder,
  type = 'text',
  onSave,
  readOnly,
  renderValue,
  accessory,
}: PropertyRowProps) {
  const t = useTranslations();
  const editable = !readOnly && !!onSave;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Sync external value changes into the local draft while not editing.
  useEffect(() => {
    if (!isEditing) setDraft(value ?? '');
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const commit = () => {
    if (!onSave) {
      setIsEditing(false);
      return;
    }
    const next = draft.trim();
    const normalized = next === '' ? null : next;
    if ((normalized ?? '') !== (value ?? '')) {
      void onSave(normalized);
    }
    setIsEditing(false);
  };

  const cancel = () => {
    setDraft(value ?? '');
    setIsEditing(false);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && type !== 'address') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter' && type === 'address' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };

  const isEmpty = !value;
  const fallback = placeholder ?? t('sweep.entities.setFieldPlaceholder', { label });

  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-center group/row min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div
        className={cn(
          // Same box geometry in both states so the edit border sits exactly
          // where the hover highlight does — same rounding, padding, negative
          // margin and min height. `border-box` keeps the outer rectangle
          // identical once the border is drawn (the border eats into the
          // padding rather than growing the box).
          'text-sm min-w-0 flex items-center min-h-[32px] rounded-[9px] -mx-2 px-2 box-border',
          editable && !isEditing && 'cursor-text hover:bg-muted/50 transition-colors',
          isEditing && 'border border-border bg-background focus-within:ring-1 focus-within:ring-primary',
        )}
        onClick={() => {
          if (editable && !isEditing) setIsEditing(true);
        }}
        role={editable ? 'button' : undefined}
        tabIndex={editable ? 0 : undefined}
        onKeyDown={(e) => {
          if (!editable || isEditing) return;
          if (e.key === 'Enter') setIsEditing(true);
        }}
      >
        {isEditing ? (
          type === 'address' ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={handleKey}
              rows={3}
              className="w-full bg-transparent border-0 p-0 text-sm outline-none resize-none"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type={type === 'email' ? 'email' : type === 'phone' ? 'tel' : type === 'url' ? 'url' : 'text'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={handleKey}
              className="w-full bg-transparent border-0 p-0 text-sm outline-none"
            />
          )
        ) : isEmpty ? (
          <span className="text-muted-foreground/70">{fallback}</span>
        ) : renderValue ? (
          renderValue(value)
        ) : type === 'url' && value ? (
          <a
            href={value.startsWith('http') ? value : `https://${value}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline truncate inline-block max-w-full"
            onClick={(e) => {
              // Prevent the row from entering edit mode when the user
              // clicks the link itself.
              e.stopPropagation();
            }}
          >
            {value}
          </a>
        ) : type === 'email' && value ? (
          <a
            href={`mailto:${value}`}
            className="text-primary hover:underline truncate inline-block max-w-full"
            onClick={(e) => e.stopPropagation()}
          >
            {value}
          </a>
        ) : type === 'phone' && value ? (
          <a
            href={`tel:${value}`}
            className="text-primary hover:underline truncate inline-block max-w-full"
            onClick={(e) => e.stopPropagation()}
          >
            {value}
          </a>
        ) : (
          <span className="text-foreground break-words">{value}</span>
        )}
      </div>
      <div className="text-muted-foreground">
        {!isEditing && accessory ? accessory : null}
      </div>
    </div>
  );
}
