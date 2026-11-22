/**
 * My HR → Schedule → Open shifts: shifts that still need people, your sign-ups
 * first. A sign-up goes to your manager, who approves it (the shift lands on
 * your schedule) or turns it down; a pending one can be withdrawn. Signing up
 * and withdrawing sit in the row menu and the shift's panel.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Hand, Loader2, Undo2, Users } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfOpenShift } from '@weldsuite/app-api-client/domains/weldhr';
import { formatClockRange, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { useObjectPanel } from '@/components/object-panel';
import { MY_OPEN_SHIFT_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import {
  useMyHrCancelShiftRequest,
  useMyHrOpenShifts,
  useMyHrSignUpForOpenShift,
} from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { errorMessage, formatDateTime, formatWeekdayDate, useFormatTime } from '../../components/shared';

const REQUEST_TONE = { approved: 'default', rejected: 'destructive' } as const;

/** My sign-up for the shift, unless it was withdrawn (then it is as if I never signed up). */
export function activeRequest(shift: HrSelfOpenShift) {
  return shift.myRequest && shift.myRequest.status !== 'cancelled' ? shift.myRequest : null;
}

/** "2 spots left", "1 spot left" or "Full". */
export function useSpotsLabel() {
  const t = useTranslations();
  return (spotsLeft: number) => {
    if (spotsLeft === 0) return t('weldhr.me.openShifts.full');
    return t(spotsLeft === 1 ? 'weldhr.me.openShifts.spotsLeft' : 'weldhr.me.openShifts.spotsLeftPlural', { count: spotsLeft });
  };
}

/** Withdraws a pending sign-up, with a toast for the outcome. */
export function useWithdrawSignUp() {
  const t = useTranslations();
  const cancelRequest = useMyHrCancelShiftRequest();
  return {
    isPending: cancelRequest.isPending,
    withdraw: async (requestId: string) => {
      try {
        await cancelRequest.mutateAsync(requestId);
        toast.success(t('weldhr.me.openShifts.withdrawnToast'));
      } catch (err) {
        toast.error(errorMessage(err, t('weldhr.me.openShifts.withdrawFailed')));
      }
    },
  };
}

/** Your sign-up's state as a badge: waiting, on the shift, or not approved. */
export function SignUpBadge({ shift }: Readonly<{ shift: HrSelfOpenShift }>) {
  const t = useTranslations();
  const request = activeRequest(shift);
  if (!request) return null;
  return (
    <Badge variant={REQUEST_TONE[request.status as keyof typeof REQUEST_TONE] ?? 'outline'}>
      {t(`weldhr.me.openShifts.status.${request.status}`)}
    </Badge>
  );
}

/** The menu items for a shift: sign up while there is room, or withdraw a pending sign-up. */
export function OpenShiftMenuItems({
  shift,
  onSignUp,
  onWithdraw,
  withdrawing,
}: Readonly<{ shift: HrSelfOpenShift; onSignUp: () => void; onWithdraw: (requestId: string) => void; withdrawing: boolean }>) {
  const t = useTranslations();
  const request = activeRequest(shift);
  if (request?.status === 'pending') {
    return (
      <DropdownMenuItem variant="destructive" disabled={withdrawing} onClick={() => onWithdraw(request.id)}>
        <Undo2 />
        {t('weldhr.me.openShifts.withdraw')}
      </DropdownMenuItem>
    );
  }
  if (!request && shift.spotsLeft > 0) {
    return (
      <DropdownMenuItem onClick={onSignUp}>
        <Hand />
        {t('weldhr.me.openShifts.signUp')}
      </DropdownMenuItem>
    );
  }
  return null;
}

type OpenShiftState = 'available' | 'signedUp' | 'full';

function stateOf(shift: HrSelfOpenShift): OpenShiftState {
  if (activeRequest(shift)) return 'signedUp';
  return shift.spotsLeft > 0 ? 'available' : 'full';
}

export function MyOpenShiftsList() {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  const { data, isLoading, error } = useMyHrOpenShifts();
  const { open: openPanel } = useObjectPanel();
  const withdrawal = useWithdrawSignUp();
  const spotsLabel = useSpotsLabel();
  const [signUpTarget, setSignUpTarget] = useState<HrSelfOpenShift | null>(null);
  const shifts = [...(data ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const groups: GroupConfig<HrSelfOpenShift>[] = [
    { id: 'mine', label: t('weldhr.me.schedule.groups.mine'), sortOrder: 1, filter: (s) => !!activeRequest(s) },
    { id: 'open', label: t('weldhr.me.schedule.groups.open'), sortOrder: 2, filter: (s) => !activeRequest(s) },
  ];

  const clients = [...new Set(shifts.map((s) => s.companyName).filter((name): name is string => !!name))].sort();
  const filters: FilterConfig[] = [
    {
      field: 'state',
      label: t('weldhr.me.schedule.filters.status'),
      operators: ['is'],
      options: (['available', 'signedUp', 'full'] as const).map((state) => ({
        value: state,
        label: t(`weldhr.me.schedule.filters.${state}`),
      })),
    },
    ...(clients.length > 0
      ? [
          {
            field: 'client',
            label: t('weldhr.me.schedule.filters.client'),
            operators: ['is'],
            options: clients.map((name) => ({ value: name, label: name })),
          },
        ]
      : []),
  ];

  const applyFilters = (rows: HrSelfOpenShift[], active: ActiveFilter[]) =>
    active.reduce((list, filter) => {
      if (!filter.value) return list;
      if (filter.field === 'state') return list.filter((s) => stateOf(s) === filter.value);
      if (filter.field === 'client') return list.filter((s) => s.companyName === filter.value);
      return list;
    }, rows);

  const timeRange = (s: HrSelfOpenShift) => formatClockRange(new Date(s.startsAt), new Date(s.endsAt), timeFormat);

  const columns: ColumnDef<HrSelfOpenShift>[] = [
    {
      id: 'date',
      header: t('weldhr.me.schedule.table.date'),
      width: HR_COL.main,
      render: (s) => (
        <div className="min-w-0">
          <p className="truncate font-medium tabular-nums">{formatWeekdayDate(s.startsAt)}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground tabular-nums @lg:hidden">
            {[timeRange(s), s.workType, spotsLabel(s.spotsLeft)].filter(Boolean).join(' · ')}
          </p>
        </div>
      ),
    },
    {
      id: 'time',
      header: t('weldhr.me.schedule.table.time'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[170px]'),
      render: (s) => <span className="block truncate tabular-nums">{timeRange(s)}</span>,
    },
    {
      id: 'workType',
      header: t('weldhr.me.schedule.table.workType'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[150px]'),
      render: (s) => <span className="block truncate">{s.workType ?? '—'}</span>,
    },
    {
      id: 'client',
      header: t('weldhr.me.schedule.table.client'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[160px]'),
      render: (s) => <span className="block truncate text-muted-foreground">{s.companyName ?? '—'}</span>,
    },
    {
      id: 'spots',
      header: t('weldhr.me.schedule.table.spots'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[110px]'),
      render: (s) => (
        <span className={cn('block truncate tabular-nums', s.spotsLeft === 0 && 'text-muted-foreground')}>{spotsLabel(s.spotsLeft)}</span>
      ),
    },
    {
      id: 'signUp',
      header: t('weldhr.me.schedule.table.signUp'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[170px]'),
      render: (s) => <SignUpBadge shift={s} />,
    },
  ];

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrSelfOpenShift>
          items={shifts}
          isLoading={isLoading}
          error={data ? null : error ? new Error(errorMessage(error, t('weldhr.me.openShifts.loadFailed'))) : null}
          columns={columns}
          onRowClick={(s) => openPanel({ type: MY_OPEN_SHIFT_PANEL_TYPE, id: s.id })}
          objectPanel={{ type: MY_OPEN_SHIFT_PANEL_TYPE }}
          // The row's "⋮" menu (on hover): signing up, or withdrawing a pending sign-up.
          rowMenu={(s) => {
            const request = activeRequest(s);
            if (request ? request.status !== 'pending' : s.spotsLeft === 0) return null;
            return (
              <OpenShiftMenuItems
                shift={s}
                onSignUp={() => setSignUpTarget(s)}
                onWithdraw={(id) => void withdrawal.withdraw(id)}
                withdrawing={withdrawal.isPending}
              />
            );
          }}
          groups={groups}
          filters={filters}
          applyFilters={applyFilters}
          searchFields={['workType', 'companyName', 'departmentName', 'notes']}
          searchPlaceholder={t('weldhr.me.schedule.search.openShifts')}
          emptyState={{
            icon: emptyIcon(Users),
            title: t('weldhr.me.schedule.empty.openShifts.title'),
            description: t('weldhr.me.schedule.empty.openShifts.description'),
          }}
        />
      </HrListContainer>

      {signUpTarget && <SignUpDialog shift={signUpTarget} onClose={() => setSignUpTarget(null)} />}
    </>
  );
}

export function SignUpDialog({ shift, onClose }: Readonly<{ shift: HrSelfOpenShift; onClose: () => void }>) {
  const t = useTranslations();
  const formatTime = useFormatTime();
  const signUp = useMyHrSignUpForOpenShift();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    setFailure(null);
    try {
      await signUp.mutateAsync({ id: shift.id, note: note.trim() || null });
      toast.success(t('weldhr.me.openShifts.signedUpToast'));
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.me.openShifts.signUpFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !signUp.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="mb-2">
          <DialogTitle>{t('weldhr.me.openShifts.signUpTitle')}</DialogTitle>
          <DialogDescription className="tabular-nums">
            {formatDateTime(shift.startsAt)} – {formatTime(shift.endsAt)}
            {shift.workType && ` · ${shift.workType}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />
          <div className="space-y-1.5">
            <Label htmlFor="my-hr-open-shift-note">{t('weldhr.me.openShifts.noteLabel')}</Label>
            <Textarea
              id="my-hr-open-shift-note"
              rows={3}
              maxLength={1000}
              value={note}
              placeholder={t('weldhr.me.openShifts.notePlaceholder')}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={signUp.isPending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={signUp.isPending}>
            {signUp.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.me.openShifts.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
