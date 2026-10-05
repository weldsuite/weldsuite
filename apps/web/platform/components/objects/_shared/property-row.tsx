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
import { Check, Flag, X } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { MemberSelect } from '@/components/team/member-select';
import { STATUS_STYLE_MAP } from '@/hooks/queries/use-weldcrm-customer-statuses';

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

const INPUT_TYPE_BY_ROW_TYPE: Record<PropertyRowType, string> = {
  text: 'text',
  email: 'email',
  phone: 'tel',
  url: 'url',
  address: 'text',
};

const LINK_CLASS = 'text-primary hover:underline truncate inline-block max-w-full';

/** Read-mode render of a non-empty value: link for url/email/phone, plain text otherwise. */
function renderReadValue(type: PropertyRowType, value: string) {
  if (type === 'url') {
    return (
      <a
        href={value.startsWith('http') ? value : `https://${value}`}
        target="_blank"
        rel="noopener noreferrer"
        className={LINK_CLASS}
        onClick={(e) => {
          // Prevent the row from entering edit mode when the user
          // clicks the link itself.
          e.stopPropagation();
        }}
      >
        {value}
      </a>
    );
  }
  if (type === 'email' || type === 'phone') {
    return (
      <a
        href={`${type === 'email' ? 'mailto' : 'tel'}:${value}`}
        className={LINK_CLASS}
        onClick={(e) => e.stopPropagation()}
      >
        {value}
      </a>
    );
  }
  return <span className="text-foreground break-words">{value}</span>;
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
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key !== 'Enter') return;
    // Address is multiline: Enter inserts a newline, Cmd/Ctrl+Enter commits.
    if (type !== 'address' || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      commit();
    }
  };

  const fallback = placeholder ?? t('sweep.entities.setFieldPlaceholder', { label });

  const renderEditor = () =>
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
        type={INPUT_TYPE_BY_ROW_TYPE[type]}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKey}
        className="w-full bg-transparent border-0 p-0 text-sm outline-none"
      />
    );

  const renderReadMode = () => {
    if (!value) return <span className="text-muted-foreground/70">{fallback}</span>;
    if (renderValue) return renderValue(value);
    return renderReadValue(type, value);
  };

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
        {isEditing ? renderEditor() : renderReadMode()}
      </div>
      <div className="text-muted-foreground">
        {!isEditing && accessory ? accessory : null}
      </div>
    </div>
  );
}

// ─── MemberPropertyRow ──────────────────────────────────────────────────────
// Owner / Manager picker row — shared by the company and person panels so
// both show the member's name (via `MemberSelect`) instead of a raw user id.

export interface MemberPropertyRowProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
}

export function MemberPropertyRow({ icon: Icon, label, value, placeholder, onChange }: MemberPropertyRowProps) {
  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-center group/row min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div className="min-w-0 -mx-2">
        <MemberSelect value={value} onChange={onChange} placeholder={placeholder} variant="assignee" />
      </div>
      <div />
    </div>
  );
}

// ─── StatusPropertyRow ──────────────────────────────────────────────────────
// Status picker row — shared by the company and person panels. Options are
// supplied by the caller (built-in + workspace custom statuses merged via
// `useCustomerStatusOptions()`), so this component stays presentation-only.
// A stored value that isn't in `options` (e.g. a status later renamed or
// deleted from Settings) still renders gracefully as plain text.

export interface StatusOption {
  value: string;
  label: string;
  color?: string;
}

function StatusBadge({ value, options }: { value: string; options: StatusOption[] }) {
  const opt = options.find((o) => o.value === value);
  const style = opt?.color ? STATUS_STYLE_MAP[opt.color] : undefined;
  const label = opt?.label ?? value;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        style?.bg ?? 'bg-muted',
        style?.color ?? 'text-foreground',
      )}
    >
      {label}
    </span>
  );
}

export interface StatusPropertyRowProps {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  options: StatusOption[];
}

export function StatusPropertyRow({ value, onChange, options }: StatusPropertyRowProps) {
  const st = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-center group/row min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Flag className="h-4 w-4" />
        <span>{st('sweep.entities.fieldStatus')}</span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="text-sm min-w-0 text-left cursor-pointer rounded px-1.5 -mx-1.5 py-0.5 hover:bg-muted/40 transition-colors flex items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring h-auto"
          >
            {value ? (
              <StatusBadge value={value} options={options} />
            ) : (
              <span className="text-muted-foreground/70">{st('sweep.entities.setStatusPlaceholder')}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput placeholder={st('sweep.entities.searchEllipsisPlaceholder')} />
            <CommandList className="max-h-[260px] p-1">
              <CommandEmpty>{st('sweep.entities.noStatusesFound')}</CommandEmpty>
              {options.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <CommandItem
                    key={opt.value}
                    value={opt.label}
                    onSelect={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className="flex items-center justify-between gap-2 px-1.5"
                  >
                    <StatusBadge value={opt.value} options={options} />
                    {isSelected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <div />
    </div>
  );
}

// ─── TagsPropertyRow ────────────────────────────────────────────────────────
// Editable tags row — chips + an inline text input, matching the row
// geometry of `PropertyRow`. Enter (or a comma) commits the current draft as
// a new tag; Backspace on an empty draft removes the last chip.

export interface TagsPropertyRowProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value?: string[] | null;
  placeholder?: string;
  onChange: (next: string[]) => void;
}

export function TagsPropertyRow({ icon: Icon, label, value, placeholder, onChange }: TagsPropertyRowProps) {
  const t = useTranslations();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tags = value ?? [];

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const commitDraft = () => {
    const next = draft.trim();
    if (next && !tags.includes(next)) onChange([...tags, next]);
    setDraft('');
  };

  const removeTag = (tag: string) => onChange(tags.filter((x) => x !== tag));

  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-start group/row min-h-[32px] py-0.5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground h-7">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div
        className={cn(
          'min-w-0 -mx-2 px-2 rounded-[9px] box-border flex flex-wrap items-center gap-1 min-h-[32px] py-1',
          !isEditing && 'cursor-text hover:bg-muted/50 transition-colors',
          isEditing && 'border border-border bg-background focus-within:ring-1 focus-within:ring-primary',
        )}
        onClick={() => setIsEditing(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (!isEditing && e.key === 'Enter') setIsEditing(true);
        }}
      >
        {tags.length === 0 && !isEditing && (
          <span className="text-muted-foreground/70 text-sm">
            {placeholder ?? t('sweep.entities.setFieldPlaceholder', { label })}
          </span>
        )}
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 text-xs">
            {tag}
            {isEditing && (
              <button
                type="button"
                // Keep focus on the text input across this click so the
                // input's onBlur-commit doesn't unmount the button mid-click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  removeTag(tag);
                }}
                className="ml-0.5 -mr-0.5 rounded hover:bg-muted-foreground/20"
                aria-label={t('sweep.entities.unlink')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </Badge>
        ))}
        {isEditing && (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commitDraft();
              } else if (e.key === 'Backspace' && !draft && tags.length > 0) {
                removeTag(tags[tags.length - 1]!);
              } else if (e.key === 'Escape') {
                setDraft('');
                setIsEditing(false);
              }
            }}
            onBlur={() => {
              commitDraft();
              setIsEditing(false);
            }}
            placeholder={t('sweep.entities.fieldTagsPlaceholder')}
            className="bg-transparent border-0 outline-none text-sm flex-1 min-w-[80px]"
          />
        )}
      </div>
      <div />
    </div>
  );
}
