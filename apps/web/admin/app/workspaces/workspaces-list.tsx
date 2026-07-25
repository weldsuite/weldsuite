'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { Building2, CalendarClock, RotateCcw, Search, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { cn } from '@/lib/utils';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import type { WorkspaceRow } from '@/lib/workspaces-data';
import { cancelWorkspaceDeletion, scheduleWorkspaceDeletion } from '@/actions/workspaces';
import { StatusBadge, formatDate } from './workspace-presentation';

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
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <Building2 className="h-6 w-6 text-primary" />
              Workspaces
            </span>
          }
          description="Schedule a workspace for deletion. It is suspended immediately and permanently deleted on the chosen date — cancel any time before then to restore it."
        />

        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Active" value={counts.active} />
          <StatCard label="Scheduled for deletion" value={counts.scheduled} />
          <StatCard label="Deleted" value={counts.deleted} muted />
        </div>

        <div className="space-y-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              applySearch(search);
            }}
          >
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or slug…"
                className="h-8 pl-9"
              />
            </div>
            <Button type="submit" variant="outline" size="sm" className="h-8">
              Search
            </Button>
          </form>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="[&_tr]:border-border/70">
                <TableRow>
                  <TableHead className="text-[13.5px]">Workspace</TableHead>
                  <TableHead className="w-28 text-[13.5px]">Plan</TableHead>
                  <TableHead className="w-24 text-right text-[13.5px]">Members</TableHead>
                  <TableHead className="w-72 text-[13.5px]">Status</TableHead>
                  <TableHead className="w-32 text-[13.5px]">Created</TableHead>
                  <TableHead className="w-44 text-right text-[13.5px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-border/70">
                {workspaces.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-16 text-center text-sm text-muted-foreground"
                    >
                      No workspaces found.
                    </TableCell>
                  </TableRow>
                )}
                {workspaces.map((w) => (
                  <TableRow
                    key={w.id}
                    className="group cursor-pointer align-top hover:bg-muted/50"
                    onClick={() => router.push(`/workspaces/${w.id}`)}
                  >
                    <TableCell className="min-w-0 py-2.5">
                      <div className="truncate text-sm font-medium">{w.name}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {w.slug}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 text-xs">{w.planName ?? '—'}</TableCell>
                    <TableCell className="py-2.5 text-right">
                      <span className="inline-flex items-center gap-1.5 text-sm tabular-nums">
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                        {w.memberCount}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal py-2.5">
                      <StatusBadge workspace={w} />
                    </TableCell>
                    <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                      {formatDate(w.createdAt, false)}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div
                        className="flex items-center justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {w.deletionState === 'active' && (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => setScheduleTarget(w)}
                            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Schedule deletion
                          </Button>
                        )}
                        {w.deletionState === 'scheduled' && (
                          <Button variant="outline" size="xs" onClick={() => setCancelTarget(w)}>
                            <RotateCcw className="h-3.5 w-3.5" />
                            Cancel deletion
                          </Button>
                        )}
                        {w.deletionState === 'deleted' && (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </PageBody>

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

      <Dialog open={cancelTarget !== null} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel deletion of &quot;{cancelTarget?.name}&quot;?</DialogTitle>
            <DialogDescription>
              The workspace will be reactivated immediately and the scheduled deletion
              {cancelTarget?.scheduledDeletionAt
                ? ` (${formatDate(cancelTarget.scheduledDeletionAt, true)})`
                : ''}{' '}
              removed. Its owners will be notified that it is active again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={isMutating} onClick={() => setCancelTarget(null)}>
              Keep scheduled
            </Button>
            <Button disabled={isMutating} onClick={performCancel}>
              {isMutating ? 'Restoring…' : 'Cancel deletion'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContent>
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-destructive" />
            Schedule deletion
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{workspace.name}</span> will be{' '}
            <strong>suspended immediately</strong> (all members locked out) and permanently deleted
            on the date below. You can cancel any time before then to fully restore it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Delete after
          </Label>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((days) => (
              <Button
                key={days}
                type="button"
                size="sm"
                variant={mode === 'preset' && presetDays === days ? 'default' : 'outline'}
                onClick={() => {
                  setMode('preset');
                  setPresetDays(days);
                }}
              >
                {days} days
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant={mode === 'custom' ? 'default' : 'outline'}
              onClick={() => setMode('custom')}
            >
              Custom date
            </Button>
          </div>

          {mode === 'custom' && (
            <Input
              type="datetime-local"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
            />
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Reason (optional)
          </Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Included in the notification to the workspace owners."
            className="resize-none"
          />
        </div>

        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          {isValid && deleteAt ? (
            <>
              Permanent deletion on <strong>{formatDate(deleteAt.toISOString(), true)}</strong>. The
              owners will be emailed.
            </>
          ) : (
            <span className="text-destructive">Pick a date at least 5 minutes in the future.</span>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={isMutating} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={isMutating || !isValid}
            onClick={() => deleteAt && onConfirm(deleteAt.toISOString(), reason)}
          >
            {isMutating ? 'Scheduling…' : 'Suspend & schedule deletion'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatCard({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <div
          className={cn(
            'text-xs uppercase tracking-wide text-muted-foreground',
            muted && 'opacity-80',
          )}
        >
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}
