import { useState, type ReactNode } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { CONDITION_TYPES, fieldCount, PALETTE, type ConditionDraft } from './conditions';

/** A condition type and its value fields (filter menu, both rule panels). */
export function ConditionFields({
  draft,
  onChange,
  allowNone = true,
}: {
  draft: ConditionDraft;
  onChange: (draft: ConditionDraft) => void;
  allowNone?: boolean;
}) {
  const { t } = useI18n();
  const tc = t.weldsheets.conditions;
  const fields = fieldCount(draft.type);
  return (
    <div className="flex flex-col gap-2">
      <Select value={draft.type} onValueChange={(type) => onChange({ ...draft, type: type as ConditionDraft['type'] })}>
        <SelectTrigger className="h-8 w-full text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value="none">{tc.none}</SelectItem>}
          {CONDITION_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {tc[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {fields === 1 && (
        <Input
          className="h-8 text-sm"
          value={draft.value}
          placeholder={draft.type === 'formula' ? '=B2>100' : tc.value}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
          aria-label={tc.value}
        />
      )}
      {fields === 2 && (
        <div className="flex gap-2">
          <Input className="h-8 text-sm" value={draft.value} placeholder={tc.min} aria-label={tc.min} onChange={(e) => onChange({ ...draft, value: e.target.value })} />
          <Input className="h-8 text-sm" value={draft.value2} placeholder={tc.max} aria-label={tc.max} onChange={(e) => onChange({ ...draft, value2: e.target.value })} />
        </div>
      )}
    </div>
  );
}

/** A swatch button that opens the palette; `none` adds a "no colour" choice. */
export function ColorSelect({
  label,
  value,
  onChange,
  none,
}: {
  label: string;
  value: string | undefined;
  onChange: (color: string | undefined) => void;
  none?: string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (color: string | undefined) => {
    onChange(color);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-8 items-center gap-2 rounded-md border px-2 text-sm hover:bg-accent" aria-label={label}>
          <span className="size-4 rounded-sm border" style={{ backgroundColor: value ?? 'transparent' }} />
          <span className="text-xs text-muted-foreground">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        {none && (
          <button type="button" className="mb-2 w-full rounded px-2 py-1 text-left text-sm hover:bg-accent" onClick={() => pick(undefined)}>
            {none}
          </button>
        )}
        <div className="grid grid-cols-10 gap-1">
          {PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              className={`size-5 rounded-sm border ${value === color ? 'ring-2 ring-primary ring-offset-1' : ''}`}
              style={{ backgroundColor: color }}
              aria-label={color}
              onClick={() => pick(color)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A small titled block in a panel or menu. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** A text field that saves on Enter or when it loses focus; Escape puts back what is saved. */
export function CommitInput({
  label,
  value,
  placeholder,
  onCommit,
  mono,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (text: string) => void;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value);
  // Someone else (or undo) changed it: show theirs.
  if (saved !== value) {
    setSaved(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      className={`h-8 text-sm ${mono ? 'font-mono' : ''}`}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        else if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}
