'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';

export const SETUP_PRESET_IDS = [
  'workProjects',
  'customersSales',
  'supportOps',
  'everything',
] as const;

export type SetupPresetId = (typeof SETUP_PRESET_IDS)[number];

const PRESET_LETTERS = ['A', 'B', 'C', 'D'] as const;

interface AgentSetupPickerProps {
  disabled?: boolean;
  onDismiss?: () => void;
  onSubmit: (payload: { presetIds: SetupPresetId[]; freeText: string; message: string }) => void;
}

export function AgentSetupPicker({ disabled, onDismiss, onSubmit }: AgentSetupPickerProps) {
  const setupT = getTranslations('common').agents.detail.setup;
  const [freeText, setFreeText] = useState('');
  const [activeId, setActiveId] = useState<SetupPresetId | null>(null);

  const submitPreset = (id: SetupPresetId) => {
    if (disabled) return;
    setActiveId(id);
    const label = setupT.presets[id].name;
    onSubmit({
      presetIds: [id],
      freeText: '',
      // Natural user reply only — do not embed instructions for the model.
      message: label,
    });
  };

  const submitFreeText = () => {
    const text = freeText.trim();
    if (!text || disabled) return;
    onSubmit({
      presetIds: [],
      freeText: text,
      message: text,
    });
  };

  return (
    <div className="w-full max-w-[min(100%,420px)] rounded-[22px] bg-[#ececf1] dark:bg-muted/80 p-4 sm:p-5 text-foreground">
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-[15px] sm:text-base font-medium leading-snug tracking-tight">
          {setupT.picker.title}
        </p>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-full p-1 text-muted-foreground/70 hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl bg-transparent">
        {SETUP_PRESET_IDS.map((id, index) => {
          const letter = PRESET_LETTERS[index];
          const selected = activeId === id;
          return (
            <button
              key={id}
              type="button"
              disabled={disabled}
              onClick={() => submitPreset(id)}
              className={cn(
                'flex w-full items-center gap-3 px-1 py-3 text-left transition-colors',
                index > 0 && 'border-t border-black/10 dark:border-white/10',
                selected ? 'opacity-100' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
                disabled && 'pointer-events-none opacity-60',
              )}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#d9d9e3] dark:bg-background/40 text-[13px] font-semibold text-foreground/80">
                {letter}
              </span>
              <span className="text-[15px] leading-snug text-foreground/90">
                {setupT.presets[id].name}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        <input
          type="text"
          value={freeText}
          disabled={disabled}
          placeholder={setupT.picker.freeTextPlaceholder}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitFreeText();
            }
          }}
          className={cn(
            'w-full rounded-full bg-white dark:bg-background px-4 py-2.5 text-[15px]',
            'placeholder:text-muted-foreground/60 text-foreground',
            'outline-none ring-0 border-0 shadow-sm',
            'disabled:opacity-60',
          )}
        />
      </div>
    </div>
  );
}
