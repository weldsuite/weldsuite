/**
 * Building blocks of the governance and scope pages: the load, empty and error
 * states, a delete confirmation, a dialog shell with a footer, a person label
 * and a pill.
 */

import type { ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { PersonAvatar } from '../../raid/_components/raid-parts';
import type { GovernanceMember } from '../_lib/use-governance';

/** Placeholders while a page loads. */
export function LoadingBlocks({ label, rows = 4 }: Readonly<{ label: string; rows?: number }>) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-16 rounded-lg" />
      ))}
    </div>
  );
}

/** The page could not be loaded. */
export function ErrorBlock({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.common;
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="rounded-full bg-muted p-3">
        <AlertCircle aria-hidden className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-base font-semibold">{copy.loadFailedTitle}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{copy.loadFailedDescription}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        {copy.retry}
      </Button>
    </div>
  );
}

/** A register with nothing in it yet. */
export function EmptyBlock({
  icon,
  title,
  description,
  action,
}: Readonly<{ icon: ReactNode; title: string; description: string; action?: ReactNode }>) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">{icon}</div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}

/** Confirm a delete. */
export function ConfirmDelete({
  open,
  code,
  pending,
  onCancel,
  onConfirm,
}: Readonly<{ open: boolean; code: string; pending: boolean; onCancel: () => void; onConfirm: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.common;
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{format(copy.deleteConfirmTitle, { code })}</AlertDialogTitle>
          <AlertDialogDescription>{copy.deleteConfirmDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{copy.cancel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {copy.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A dialog with a scrolling body and a footer of Cancel and a submit button. */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  pending,
  onSubmit,
  children,
  wide,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: () => void;
  children: ReactNode;
  wide?: boolean;
}>) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className={cn('flex max-h-[90dvh] flex-col gap-0 p-0', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-2">{children}</div>
          <div className="flex justify-end gap-2 border-t px-6 py-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t.flowGovernance.common.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A member as avatar and name; the id as it is when they have left. */
export function MemberLabel({
  userId,
  member,
  className,
}: Readonly<{ userId: string | null | undefined; member: GovernanceMember | null; className?: string }>) {
  const { t } = useI18n();
  if (!userId) return <span className={cn('text-xs text-muted-foreground', className)}>{t.flowGovernance.common.unassigned}</span>;
  const name = member?.name ?? userId;
  return (
    <span className={cn('inline-flex items-center gap-2 whitespace-nowrap', className)}>
      <PersonAvatar name={name} avatar={member?.avatar} />
      <span className="max-w-[10rem] truncate">{name}</span>
    </span>
  );
}

const TONES = {
  neutral: 'bg-muted text-foreground/80',
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  success: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  warning: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  danger: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
} as const;

export type Tone = keyof typeof TONES;

/** A small status pill. */
export function Pill({ tone, children, className }: Readonly<{ tone: Tone; children: ReactNode; className?: string }>) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap', TONES[tone], className)}>{children}</span>;
}

/** A thin progress bar with a label. */
export function Bar({ percent, label, tone = 'neutral' }: Readonly<{ percent: number; label: string; tone?: 'neutral' | 'danger' }>) {
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 min-w-[3.5rem] flex-1 overflow-hidden rounded-full bg-muted"
    >
      <span className={cn('block h-full rounded-full', tone === 'danger' ? 'bg-red-600' : 'bg-foreground/80')} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </span>
  );
}
