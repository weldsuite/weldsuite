'use client';

import React, { useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';

/** Hex swatches offered when creating a label inline (labels store hex). */
export const INLINE_LABEL_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#6b7280',
] as const;

interface InlineLabelCreatorProps {
  /** Persists the label. The caller decides what happens next (e.g. selecting it). */
  onCreate: (data: { name: string; color: string }) => Promise<unknown>;
  /** Names that already exist, so a duplicate is not created by accident. */
  existingNames: string[];
}

/**
 * Type-to-create row for label pickers: a name field plus a colour swatch row.
 * Pressing Enter (or the create button) saves the label.
 */
export function InlineLabelCreator({ onCreate, existingNames }: Readonly<InlineLabelCreatorProps>) {
  const t = useTranslations();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(INLINE_LABEL_COLORS[5]);
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const duplicate = existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const canCreate = trimmed.length > 0 && !duplicate && !busy;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onCreate({ name: trimmed, color });
      setName('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 p-1">
      <Input
        value={name}
        placeholder={t('sweep.shared.createLabelPlaceholder')}
        aria-label={t('sweep.shared.createLabelPlaceholder')}
        autoComplete="off"
        className="h-8 text-sm"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          // Keep keystrokes (incl. Enter) inside the popover.
          e.stopPropagation();
          if (e.key === 'Enter') {
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            void submit();
          }
        }}
      />
      {trimmed.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('sweep.shared.labelColor')}>
            {INLINE_LABEL_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                role="radio"
                aria-checked={color === hex}
                aria-label={hex}
                onClick={() => setColor(hex)}
                style={{ backgroundColor: hex }}
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full text-white ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                  color === hex && 'ring-2 ring-foreground/40 ring-offset-1',
                )}
              >
                {color === hex && <Check className="h-3 w-3" />}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canCreate}
            onClick={() => void submit()}
            className="h-8 justify-start gap-1.5 px-2 text-sm"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="truncate">{t('sweep.shared.createLabelNamed', { name: trimmed })}</span>
          </Button>
        </>
      )}
    </div>
  );
}
