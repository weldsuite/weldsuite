/**
 * Small display pieces of the RAID screens: score and severity badges, status
 * pills, owner cells, due dates, progress bars and summary tiles.
 */

import type { ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import type { RaidItem, RaidKind, RiskBand } from '@weldsuite/app-api-client/domains/project-control';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { bandLabel, dueText, statusLabel } from '../_lib/copy';
import { initialsOf, progressPercent, statusTone } from '../_lib/raid';
import { dueStatus } from '../_lib/risk';
import { BAND_STYLES, SEVERITY_BAND, TONE_DOT, TONE_PILL } from '../_lib/styles';
import { useRaid } from './raid-context';

/** `20 Critical`, coloured by band. */
export function ScoreBadge({
  score,
  band,
  className,
  showLabel = true,
}: Readonly<{ score: number; band: RiskBand; className?: string; showLabel?: boolean }>) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        BAND_STYLES[band].badge,
        className,
      )}
    >
      <span className="tabular-nums">{score}</span>
      {showLabel && bandLabel(t.projects.raid, band)}
    </span>
  );
}

/** An issue's severity, on the band colours. */
export function SeverityBadge({ severity }: Readonly<{ severity: string | null }>) {
  const { t } = useI18n();
  if (!severity) return null;
  const band = SEVERITY_BAND[severity];
  const label = (t.projects.raid.severity as unknown as Record<string, string>)[severity] ?? severity;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        band ? BAND_STYLES[band].badge : 'bg-muted text-foreground/80',
      )}
    >
      {label}
    </span>
  );
}

/** The status of an item, as a tinted pill with a dot. */
export function StatusPill({ kind, status }: Readonly<{ kind: RaidKind; status: string }>) {
  const { t } = useI18n();
  const tone = statusTone(kind, status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_PILL[tone],
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
      {statusLabel(t.projects.raid, kind, status)}
    </span>
  );
}

/** An avatar with initials for a project member. */
export function PersonAvatar({
  name,
  avatar,
  className,
}: Readonly<{ name: string; avatar?: string | null; className?: string }>) {
  return (
    <Avatar aria-hidden className={cn('size-6 shrink-0', className)}>
      {avatar ? <AvatarImage src={avatar} alt="" /> : null}
      <AvatarFallback className="bg-muted text-[10px] font-semibold text-foreground/80">{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}

/** The owner of an item (or the assignee of a task): avatar and name, or "Unassigned". */
export function OwnerCell({
  ownerId,
  withName = true,
  className,
}: Readonly<{ ownerId: string | null; withName?: boolean; className?: string }>) {
  const { t } = useI18n();
  const { memberOf } = useRaid();
  if (!ownerId) {
    return <span className={cn('text-xs text-muted-foreground', className)}>{t.projects.raid.register.unassigned}</span>;
  }
  const member = memberOf(ownerId);
  const name = member?.name ?? t.projects.raid.register.unknownOwner;
  return (
    <span className={cn('inline-flex items-center gap-2 whitespace-nowrap', className)}>
      <PersonAvatar name={name} avatar={member?.avatar} />
      {withName ? <span className="max-w-[10rem] truncate">{name}</span> : <span className="sr-only">{name}</span>}
    </span>
  );
}

/** A due date against today: red when late, with the closing date of a closed item. */
export function DueLabel({
  dueAt,
  closedText,
  className,
}: Readonly<{ dueAt: string | null; closedText?: string | null; className?: string }>) {
  const { t, plural, format } = useI18n();
  const { now } = useRaid();
  if (closedText) {
    return <span className={cn('text-xs text-muted-foreground', className)}>{closedText}</span>;
  }
  const due = dueStatus(dueAt, now);
  return (
    <span
      className={cn(
        'text-xs font-medium whitespace-nowrap',
        due.kind === 'overdue' ? 'text-red-700 dark:text-red-400' : 'text-foreground/80',
        due.kind === 'none' && 'font-normal text-muted-foreground',
        className,
      )}
    >
      {dueText(t.projects.raid, due, plural, format)}
    </span>
  );
}

/** A thin progress bar with its `done/total` count. */
export function TaskProgress({
  progress,
  className,
}: Readonly<{ progress: RaidItem['taskProgress']; className?: string }>) {
  const percent = progressPercent(progress);
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        className="h-1.5 min-w-[3.5rem] flex-1 overflow-hidden rounded-full bg-muted"
      >
        <span className="block h-full rounded-full bg-foreground/80" style={{ width: `${percent}%` }} />
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {progress.done}/{progress.total}
      </span>
    </span>
  );
}

/** One summary tile: a label over a large figure. */
export function SummaryTile({
  label,
  value,
  hint,
  swatch,
  tone,
  children,
}: Readonly<{
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  swatch?: string;
  tone?: 'danger' | 'warning';
  children?: ReactNode;
}>) {
  return (
    <div className="rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {swatch ? <span aria-hidden className={cn('size-2 rounded-sm', swatch)} /> : null}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={cn(
            'text-2xl font-semibold tabular-nums',
            tone === 'danger' && 'text-red-700 dark:text-red-400',
            tone === 'warning' && 'text-orange-700 dark:text-orange-400',
          )}
        >
          {value}
        </span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function confidenceLevel(confidence: string): number {
  if (confidence === 'high') return 3;
  return confidence === 'medium' ? 2 : 1;
}

/** Confidence of an assumption as three bars and a word. */
export function ConfidenceBars({ confidence }: Readonly<{ confidence: string | null }>) {
  const { t } = useI18n();
  if (!confidence) return <span className="text-xs text-muted-foreground">—</span>;
  const level = confidenceLevel(confidence);
  const label = (t.projects.raid.confidence as unknown as Record<string, string>)[confidence] ?? confidence;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-foreground/80 whitespace-nowrap">
      <span aria-hidden className="flex items-end gap-0.5">
        {[1, 2, 3].map((bar) => (
          <span key={bar} className={cn('w-1 rounded-sm', bar <= level ? 'bg-foreground' : 'bg-muted-foreground/30')} style={{ height: 4 + bar * 3 }} />
        ))}
      </span>
      {label}
    </span>
  );
}

/** `RSK-4` in the muted, tabular style of the register. */
export function ItemCode({ code, className }: Readonly<{ code: string; className?: string }>) {
  return <span className={cn('text-xs tabular-nums text-muted-foreground whitespace-nowrap', className)}>{code}</span>;
}
