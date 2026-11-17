import type { ReactNode } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export type SegmentTone = 'success' | 'warning' | 'danger' | 'neutral' | 'primary';

export interface Segment {
  key: string;
  label: string;
  /** Any non-negative amount; segments are sized by their share of the total. */
  value: number;
  tone?: SegmentTone;
  /** What the legend shows next to the label (a percentage, a count); defaults to the share. */
  valueLabel?: ReactNode;
}

export interface SegmentedBarProps {
  segments: Segment[];
  /** Names the bar for assistive technology. */
  label: string;
  /** Shows the label and share of each segment under the bar. */
  legend?: boolean;
  /** Formats a 0-1 share for the legend and titles; defaults to a whole percentage. */
  formatShare?: (share: number) => string;
  className?: string;
}

const TONES: Record<SegmentTone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-destructive',
  neutral: 'bg-muted-foreground/40',
  primary: 'bg-primary',
};

function defaultShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * One horizontal bar split into parts by share: a good / needs improvement /
 * poor distribution, a status breakdown, a budget split. Zero segments are
 * left out of the bar but stay in the legend.
 */
export function SegmentedBar({ segments, label, legend = true, formatShare = defaultShare, className }: Readonly<SegmentedBarProps>) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const share = (value: number) => (total > 0 ? Math.max(0, value) / total : 0);

  return (
    <div className={cn('grid gap-2', className)}>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label}: ${segments.map((s) => `${s.label} ${formatShare(share(s.value))}`).join(', ')}`}>
        {segments.map((s) =>
          s.value > 0 ? <div key={s.key} className={cn('h-full', TONES[s.tone ?? 'primary'])} style={{ width: `${share(s.value) * 100}%` }} title={`${s.label}: ${formatShare(share(s.value))}`} /> : null,
        )}
      </div>
      {legend && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {segments.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className={cn('size-2 rounded-full', TONES[s.tone ?? 'primary'])} aria-hidden />
              <span>{s.label}</span>
              <span className="font-medium tabular-nums text-foreground">{s.valueLabel ?? formatShare(share(s.value))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
