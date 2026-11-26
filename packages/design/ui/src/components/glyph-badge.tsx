import type { ComponentProps } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export type GlyphTone = 'violet' | 'pink' | 'green' | 'red' | 'blue' | 'amber' | 'neutral';

export const GLYPH_TONES: readonly GlyphTone[] = ['violet', 'pink', 'green', 'red', 'blue', 'amber', 'neutral'];

const TONE_CLASSES: Record<GlyphTone, string> = {
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-500/20 dark:text-pink-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  neutral: 'bg-muted text-muted-foreground',
};

const SIZE_CLASSES = {
  sm: 'size-4 rounded text-[10px]',
  md: 'size-5 rounded-[5px] text-[11px]',
} as const;

export type GlyphBadgeProps = {
  /** One or two characters: the letter of a kind, such as `E` for an epic. */
  glyph: string;
  tone: GlyphTone;
  /** What the glyph stands for, for screen readers and the tooltip. */
  label: string;
  size?: keyof typeof SIZE_CLASSES;
} & Omit<ComponentProps<'span'>, 'children'>;

/**
 * A letter in a soft coloured square that names a kind of record: an item's
 * type in a backlog (Epic, PBI, Bug), a document kind. The square keeps rows
 * aligned whatever the letter; `label` is the accessible name, so the letter
 * is never the only thing a screen reader gets.
 */
export function GlyphBadge({ glyph, tone, label, size = 'md', className, ...props }: Readonly<GlyphBadgeProps>) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex flex-none select-none items-center justify-center font-bold leading-none',
        SIZE_CLASSES[size],
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      <span aria-hidden="true">{glyph}</span>
    </span>
  );
}
