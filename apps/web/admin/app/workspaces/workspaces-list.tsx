'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { Building2, CalendarClock, RotateCcw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { WorkspaceRow } from '@/lib/workspaces-data';
import { cancelWorkspaceDeletion, scheduleWorkspaceDeletion } from '@/actions/workspaces';

const PRESETS = [7, 30, 60, 90] as const;
const DEFAULT_PRESET = 30;

export function WorkspacesList({
  workspaces,
  initialSearch,
}: {
  workspaces: WorkspaceRow[];
  initialSearch: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialSearch);
  const [scheduleTarget, setScheduleTarget] = useState<WorkspaceRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WorkspaceRow | null>(null);
  const [isMutating, startMutation] = useTransition();

  function applySearch(next: string) {
    const params = new URLSearchParams();
    if (next.trim()) params.set('search', next.trim());
    const qs = params.toString();
    router.push(qs ? `/workspaces?${qs}` : '/workspaces');
  }

  function performCancel() {
    if (!cancelTarget) return;
    const target = cancelTarget;
    startMutation(async () => {
      const result = await cancelWorkspaceDeletion(target.id);
      if (result.ok) {
        toast.success(`Restored "${target.name}"`);
        setCancelTarget(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const counts = useMemo(() => {
    let active = 0;
    let scheduled = 0;
    let deleted = 0;
    for (const w of workspaces) {
      if (w.deletionState === 'deleted') deleted++;
      else if (w.deletionState === 'scheduled') scheduled++;
      else active++;
    }
    return { active, scheduled, deleted };
  }, [workspaces]);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Building2 className="h-6 w-6 text-blue-600" />
            Workspaces
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Schedule a workspace for deletion. It is suspended immediately and permanently
            deleted on the chosen date — cancel any time before then to restore it.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Active" value={counts.active} />
          <StatCard label="Scheduled for deletion" value={counts.scheduled} />
          <StatCard label="Deleted" value={counts.deleted} muted />
        </div>

        <form
          className="flex items-center gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            applySearch(search);
          }}
        >
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or slug…"
              className="w-full pl-9 pr-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button type="submit" className="px-3 py-2 rounded-md border text-sm hover:bg-accent">
            Search
          </button>
        </form>

        <div className="rounded-lg border bg-card overflow-hidden">
          {workspaces.length === 0 ? (
            <div className="text-center py-16 text-sm text-muted-foreground">
              No workspaces found.
            </div>
          ) : (
            <table className="w-full table-fixed">
              <colgroup>
                <col />
                <col className="w-28" />
                <col className="w-72" />
                <col className="w-28" />
                <col className="w-44" />
              </colgroup>
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Workspace</th>
                  <th className="text-left font-medium px-4 py-2.5">Plan</th>
                  <th className="text-left font-medium px-4 py-2.5">Status</th>
                  <th className="text-left font-medium px-4 py-2.5">Created</th>
                  <th className="text-right font-medium px-4 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {workspaces.map((w) => (
                  <tr key={w.id} className="hover:bg-accent/30 align-top">
                    <td className="px-4 py-3 min-w-0">
                      <div className="font-medium text-sm truncate">{w.name}</div>
                      <div className="text-xs text-muted-foreground truncate font-mono">{w.slug}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">{w.planName ?? '—'}</td>
                    <td className="px-4 py-3">
                      <StatusCell workspace={w} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                      {formatDate(w.createdAt, false)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {w.deletionState === 'active' && (
                          <button
                            onClick={() => setScheduleTarget(w)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Schedule deletion
                          </button>
                        )}
                        {w.deletionState === 'scheduled' && (
                          <button
                            onClick={() => setCancelTarget(w)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border hover:bg-accent"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Cancel deletion
                          </button>
                        )}
                        {w.deletionState === 'deleted' && (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {scheduleTarget && (
        <ScheduleDialog
          workspace={scheduleTarget}
          isMutating={isMutating}
          onClose={() => setScheduleTarget(null)}
          onConfirm={(deleteAtIso, reason) => {
            const target = scheduleTarget;
            startMutation(async () => {
              const result = await scheduleWorkspaceDeletion(target.id, deleteAtIso, reason);
              if (result.ok) {
                toast.success(`"${target.name}" scheduled for deletion`);
                setScheduleTarget(null);
                router.refresh();
              } else {
                toast.error(result.error);
              }
            });
          }}
        />
      )}

      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-popover rounded-lg shadow-xl border max-w-md w-full p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Cancel deletion of &quot;{cancelTarget.name}&quot;?</h2>
              <p className="text-sm text-muted-foreground mt-1">
                The workspace will be reactivated immediately and the scheduled deletion
                {cancelTarget.scheduledDeletionAt
                  ? ` (${formatDate(cancelTarget.scheduledDeletionAt, true)})`
                  : ''}{' '}
                removed. Its owners will be notified that it is active again.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setCancelTarget(null)}
                disabled={isMutating}
                className="px-4 py-2 rounded-md text-sm hover:bg-accent disabled:opacity-50"
              >
                Keep scheduled
              </button>
              <button
                onClick={performCancel}
                disabled={isMutating}
                className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {isMutating ? 'Restoring…' : 'Cancel deletion'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ScheduleDialog({
  workspace,
  isMutating,
  onClose,
  onConfirm,
}: {
  workspace: WorkspaceRow;
  isMutating: boolean;
  onClose: () => void;
  onConfirm: (deleteAtIso: string, reason: string) => void;
}) {
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [presetDays, setPresetDays] = useState<number>(DEFAULT_PRESET);
  const [customValue, setCustomValue] = useState<string>('');
  const [reason, setReason] = useState('');

  const deleteAt = useMemo(() => {
    if (mode === 'preset') {
      const d = new Date();
      d.setDate(d.getDate() + presetDays);
      return d;
    }
    if (!customValue) return null;
    const d = new Date(customValue);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [mode, presetDays, customValue]);

  const isValid = deleteAt !== null && deleteAt.getTime() > Date.now() + 5 * 60_000;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-popover rounded-lg shadow-xl border max-w-md w-full p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-red-600" />
            Schedule deletion
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            <span className="font-medium text-foreground">{workspace.name}</span> will be{' '}
            <strong>suspended immediately</strong> (all members locked out) and permanently deleted
            on the date below. You can cancel any time before then to fully restore it.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Delete after
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((days) => (
              <button
                key={days}
                onClick={() => {
                  setMode('preset');
                  setPresetDays(days);
                }}
                className={cn(
                  'px-3 py-1.5 rounded-md border text-sm',
                  mode === 'preset' && presetDays === days
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'hover:bg-accent',
                )}
              >
                {days} days
              </button>
            ))}
            <button
              onClick={() => setMode('custom')}
              className={cn(
                'px-3 py-1.5 rounded-md border text-sm',
                mode === 'custom' ? 'bg-blue-600 border-blue-600 text-white' : 'hover:bg-accent',
              )}
            >
              Custom date
            </button>
          </div>

          {mode === 'custom' && (
            <input
              type="datetime-local"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Included in the notification to the workspace owners."
            className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          />
        </div>

        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          {isValid && deleteAt ? (
            <>
              Permanent deletion on{' '}
              <strong>{formatDate(deleteAt.toISOString(), true)}</strong>. The owners will be emailed.
            </>
          ) : (
            <span className="text-red-600">Pick a date at least 5 minutes in the future.</span>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={isMutating}
            className="px-4 py-2 rounded-md text-sm hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => deleteAt && onConfirm(deleteAt.toISOString(), reason)}
            disabled={isMutating || !isValid}
            className="px-4 py-2 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
          >
            {isMutating ? 'Scheduling…' : 'Suspend & schedule deletion'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusCell({ workspace: w }: { workspace: WorkspaceRow }) {
  if (w.deletionState === 'deleted') {
    return (
      <div>
        <Badge tone="gray">Deleted</Badge>
        {w.deletedAt && (
          <div className="text-[11px] text-muted-foreground mt-1">{formatDate(w.deletedAt, true)}</div>
        )}
      </div>
    );
  }

  if (w.deletionState === 'scheduled') {
    return (
      <div>
        <Badge tone="amber">Scheduled</Badge>
        {w.scheduledDeletionAt && (
          <div className="text-[11px] text-muted-foreground mt-1">
            deletes {formatDate(w.scheduledDeletionAt, true)}
          </div>
        )}
        <div className="text-[11px] text-muted-foreground mt-0.5">
          {w.adminInitiated
            ? `by ${w.deletionRequestedBy}`
            : 'trial-expiry policy'}
        </div>
        {w.deletionReason && (
          <div className="text-[11px] text-muted-foreground mt-0.5 italic truncate">
            “{w.deletionReason}”
          </div>
        )}
      </div>
    );
  }

  return <Badge tone="green">Active</Badge>;
}

function Badge({ tone, children }: { tone: 'green' | 'amber' | 'gray'; children: React.ReactNode }) {
  const tones: Record<typeof tone, string> = {
    green:
      'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
    amber:
      'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900',
    gray: 'bg-muted text-muted-foreground border-border',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border',
        tones[tone],
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          tone === 'green' ? 'bg-emerald-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-muted-foreground/40',
        )}
      />
      {children}
    </span>
  );
}

function StatCard({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className={cn('text-xs uppercase tracking-wide text-muted-foreground', muted && 'opacity-80')}>
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function formatDate(iso: string, withTime: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
  });
}
