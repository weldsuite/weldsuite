/**
 * My HR → Overview, laid out as a record: the same `EntityDetailView` header,
 * icon tab strip and property rows as an employee or a WeldCRM company, shown
 * fullscreen inside the page instead of over it.
 *
 *   - Header: avatar, name, and the Clock in / Clock out button.
 *   - Details: the time clock, what needs attention (each row links to the
 *     My HR page behind it) and the profile, as read-only property rows.
 *   - Leave balances and Upcoming shifts: standard list rows; a row opens
 *     Time off or Schedule & hours.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  Briefcase,
  BriefcaseBusiness,
  Building,
  Building2,
  CalendarClock,
  CalendarDays,
  ChartNoAxesGantt,
  CircleUser,
  ClipboardList,
  Clock,
  Hash,
  Loader2,
  LogIn,
  LogOut,
  Mail,
  MapPin,
  MessageSquareHeart,
  Phone,
  Plane,
  Star,
  Target,
  UserRound,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrLeaveBalance, HrSelfOverview, HrSelfProfile } from '@weldsuite/app-api-client/domains/weldhr';
import type { HrGeoPointInput } from '@weldsuite/app-api-client/schemas/weldhr';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { ObjectPanelTabs } from '@/components/object-panel';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import { LinkedRecordStatus } from '@/components/objects/_shared/linked-record-row';
import { PanelRow, RecordLoadFailed } from '@/components/objects/_shared/record-panel-parts';
import {
  ActivityIllustration,
  NotesIllustration,
  TAB_EMPTY_STATE_TABLE_CLASS,
  tabBodyClassName,
} from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { HR_EMPLOYEE_STATUS_TONE } from '@/components/objects/hr-employee/hr-employee-tabs';
import { useMyHrClock, useMyHrOverview } from '@/hooks/queries/use-weldhr-queries';
import { useTimeFormat, type TimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { MY_HR_PATHS, type MyHrPath } from '../../access';
import { errorMessage, formatDate, formatDateTime, formatTime, useFormatTime } from '../../components/shared';
import { GeolocationError, getDevicePosition, type GeolocationFailure } from '../../lib/geolocation';
import { useMyHrSelf } from './my-hr-context';
import { ColorDot } from './shared';

type MyHrTabId = 'overview' | 'leave' | 'shifts';

/** Today's clock-ins read as a time, older ones as a date and time. */
function formatSince(since: string, timeFormat: TimeFormat): string {
  return new Date(since).toDateString() === new Date().toDateString() ? formatTime(since, timeFormat) : formatDateTime(since);
}

// ─── Header ────────────────────────────────────────────────────────────────

function SelfAvatar({ employee }: Readonly<{ employee: HrSelfProfile }>) {
  return (
    <Avatar className="size-[22px]">
      {employee.avatarUrl && <AvatarImage src={employee.avatarUrl} alt={employee.displayName} className="object-cover" />}
      <AvatarFallback className="bg-muted text-[10px] font-medium">
        {(employee.displayName.trim()[0] ?? '#').toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

const LOCATION_FAILURE_MESSAGE: Record<GeolocationFailure, string> = {
  denied: 'weldhr.me.overview.clock.locationDenied',
  unavailable: 'weldhr.me.overview.clock.locationUnavailable',
  unsupported: 'weldhr.me.overview.clock.locationUnsupported',
};

/** Clock in / Clock out, in the record's header. */
function ClockButton({ clock }: Readonly<{ clock: HrSelfOverview['clock'] }>) {
  const t = useTranslations();
  const clockMutation = useMyHrClock();
  const { features } = useMyHrSelf();
  const requiresLocation = features.clockInRequiresLocation === true;
  const [locating, setLocating] = useState(false);
  const busy = clockMutation.isPending || locating;

  async function toggle() {
    const action = clock.clockedIn ? 'out' : 'in';
    try {
      // The server checks the device is at one of the work locations; it needs the position to do so.
      let location: HrGeoPointInput | undefined;
      if (requiresLocation) {
        setLocating(true);
        try {
          location = await getDevicePosition();
        } finally {
          setLocating(false);
        }
      }
      await clockMutation.mutateAsync({ action, ...(location ? { location } : {}) });
      toast.success(t(action === 'in' ? 'weldhr.me.overview.clock.clockedInToast' : 'weldhr.me.overview.clock.clockedOutToast'));
    } catch (err) {
      // A refused position reads differently from a refusal by the server, which explains itself.
      toast.error(
        err instanceof GeolocationError ? t(LOCATION_FAILURE_MESSAGE[err.reason]) : errorMessage(err, t('weldhr.me.overview.clock.failed')),
      );
    }
  }

  let icon = <LogIn />;
  if (busy) icon = <Loader2 className="animate-spin" />;
  else if (clock.clockedIn) icon = <LogOut />;

  let hint: string | undefined;
  if (locating) hint = t('weldhr.me.overview.clock.locating');
  else if (requiresLocation) hint = t('weldhr.me.overview.clock.locationRequired');

  return (
    <Button
      size="sm"
      variant={clock.clockedIn ? 'destructive' : 'default'}
      onClick={() => void toggle()}
      disabled={busy}
      title={hint}
    >
      {icon}
      {clock.clockedIn ? t('weldhr.me.overview.clock.clockOut') : t('weldhr.me.overview.clock.clockIn')}
    </Button>
  );
}

// ─── Details tab ───────────────────────────────────────────────────────────

/** A row value that opens the My HR page behind it. */
function RowLink({ to, children }: Readonly<{ to: MyHrPath; children: ReactNode }>) {
  return (
    <Link to={to} className="text-primary hover:underline tabular-nums">
      {children}
    </Link>
  );
}

function Muted({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="ml-2 min-w-0 truncate text-muted-foreground">{children}</span>;
}

function MyDetailsTab({
  employee,
  overview,
  canClockIn,
}: Readonly<{ employee: HrSelfProfile; overview: HrSelfOverview; canClockIn: boolean }>) {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  const toAcknowledge = overview.toAcknowledge.coaching + overview.toAcknowledge.evaluations;
  const latest = overview.latestEvaluation;
  const latestScore = latest?.overallScore;
  const totalMilestones = overview.milestones.achieved + overview.milestones.open;

  let clockValue = t('weldhr.me.overview.record.notClockedIn');
  if (overview.clock.clockedIn && overview.clock.since) {
    clockValue = t('weldhr.me.overview.record.clockedInSince', { time: formatSince(overview.clock.since, timeFormat) });
  }

  return (
    <div className="p-4 space-y-1">
      {canClockIn && <PanelRow icon={Clock} label={t('weldhr.me.overview.clock.title')} value={clockValue} tabular />}
      <PanelRow
        icon={ClipboardList}
        label={t('weldhr.me.overview.kpis.openTasks')}
        value={String(overview.openTasks)}
        renderValue={(value) => <RowLink to={MY_HR_PATHS.tasks}>{value}</RowLink>}
      />
      <PanelRow
        icon={MessageSquareHeart}
        label={t('weldhr.me.overview.record.toAcknowledge')}
        value={String(toAcknowledge)}
        renderValue={(value) => (
          <>
            <RowLink to={MY_HR_PATHS.reviews}>{value}</RowLink>
            <Muted>
              {t('weldhr.me.overview.kpis.toAcknowledgeHint', {
                coaching: overview.toAcknowledge.coaching,
                evaluations: overview.toAcknowledge.evaluations,
              })}
            </Muted>
          </>
        )}
      />
      <PanelRow
        icon={Star}
        label={t('weldhr.me.overview.record.evaluation')}
        value={latest ? (latestScore?.toFixed(1) ?? '—') : t('weldhr.me.overview.kpis.noEvaluation')}
        renderValue={(value) =>
          latest ? (
            <>
              <RowLink to={MY_HR_PATHS.reviews}>{value}</RowLink>
              <Muted>
                {[latest.formName, latest.submittedAt ? formatDate(latest.submittedAt) : null].filter(Boolean).join(' · ')}
              </Muted>
            </>
          ) : (
            <span className="text-muted-foreground">{value}</span>
          )
        }
      />
      <PanelRow
        icon={Target}
        label={t('weldhr.me.overview.record.milestones')}
        value={t('weldhr.me.overview.record.milestonesValue', {
          achieved: overview.milestones.achieved,
          total: totalMilestones,
        })}
        renderValue={(value) => (
          <>
            <RowLink to={MY_HR_PATHS.reviews}>{value}</RowLink>
            {overview.milestones.open > 0 && (
              <Muted>{t('weldhr.me.overview.kpis.milestonesHint', { open: overview.milestones.open })}</Muted>
            )}
          </>
        )}
      />
      <PanelRow icon={Mail} label={t('weldhr.me.overview.profile.email')} type="email" value={employee.email} />
      <PanelRow icon={Phone} label={t('weldhr.me.overview.profile.phone')} type="phone" value={employee.phone} />
      <PanelRow icon={Briefcase} label={t('weldhr.employees.create.jobTitle')} value={employee.jobTitle} />
      <PanelRow icon={Building2} label={t('weldhr.employees.create.department')} value={employee.departmentName} />
      <PanelRow icon={UserRound} label={t('weldhr.employees.detail.fields.manager')} value={employee.manager?.displayName ?? null} />
      <PanelRow
        icon={BriefcaseBusiness}
        label={t('weldhr.employees.detail.fields.employmentType')}
        value={t(`weldhr.status.employmentType.${employee.employmentType}`)}
      />
      <PanelRow
        icon={CircleUser}
        label={t('weldhr.employees.create.status')}
        value={employee.status}
        renderValue={() => (
          <LinkedRecordStatus tone={HR_EMPLOYEE_STATUS_TONE[employee.status]}>
            {t(`weldhr.status.employee.${employee.status}`)}
          </LinkedRecordStatus>
        )}
      />
      <PanelRow icon={Hash} label={t('weldhr.employees.detail.fields.employeeNumber')} value={employee.employeeNumber} />
      <PanelRow
        icon={CalendarDays}
        label={t('weldhr.me.overview.profile.startDate')}
        type="date"
        value={employee.startDate}
        renderValue={(value) => formatDate(value)}
      />
      <PanelRow icon={MapPin} label={t('weldhr.me.overview.profile.location')} value={employee.location} />
      <PanelRow
        icon={Building}
        label={t('weldhr.me.overview.record.clients')}
        value={employee.clients.length > 0 ? String(employee.clients.length) : null}
        renderValue={() => (
          <span className="flex flex-wrap gap-1">
            {employee.clients.map((client) => (
              <LinkedRecordStatus key={client.companyId} tone={client.isPrimary ? 'blue' : 'gray'}>
                {client.companyName ?? client.companyId}
              </LinkedRecordStatus>
            ))}
          </span>
        )}
      />
    </div>
  );
}

// ─── Leave balances tab ────────────────────────────────────────────────────

const LEAVE_COLUMN = {
  name: 'min-w-0 flex-1',
  allowance: 'w-[110px] @max-[560px]:hidden',
  used: 'w-[90px]',
  pending: 'w-[90px] @max-[560px]:hidden',
  remaining: 'w-[110px]',
};

type LeaveBalanceItem = HrLeaveBalance & { id: string };

function MyLeaveTab({ balances }: Readonly<{ balances: HrLeaveBalance[] }>) {
  const t = useTranslations();
  const navigate = useNavigate();
  const items = useMemo<LeaveBalanceItem[]>(
    () => balances.map((balance) => ({ ...balance, id: balance.leaveTypeId })),
    [balances],
  );

  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'name', header: t('weldhr.leave.balances.table.type'), width: LEAVE_COLUMN.name },
      { id: 'allowance', header: t('weldhr.leave.balances.table.allowance'), width: LEAVE_COLUMN.allowance },
      { id: 'used', header: t('weldhr.leave.balances.table.used'), width: LEAVE_COLUMN.used },
      { id: 'pending', header: t('weldhr.leave.balances.table.pending'), width: LEAVE_COLUMN.pending },
      { id: 'remaining', header: t('weldhr.leave.balances.table.remaining'), width: LEAVE_COLUMN.remaining },
    ],
    [t],
  );

  const renderRow = useCallback(
    (balance: LeaveBalanceItem) => {
      const unlimited = t('weldhr.me.leave.balances.unlimited');
      return (
        <TabListRow key={balance.id} label={balance.name} onOpen={() => void navigate({ to: MY_HR_PATHS.timeOff })}>
          <div className={`${LEAVE_COLUMN.name} flex items-center gap-2`}>
            <ColorDot color={balance.color} />
            <span className="truncate text-sm font-medium text-foreground">{balance.name}</span>
          </div>
          <span className={`${LEAVE_COLUMN.allowance} text-sm text-muted-foreground tabular-nums`}>
            {balance.allowance ?? unlimited}
          </span>
          <span className={`${LEAVE_COLUMN.used} text-sm text-muted-foreground tabular-nums`}>{balance.used}</span>
          <span className={`${LEAVE_COLUMN.pending} text-sm text-muted-foreground tabular-nums`}>{balance.pending}</span>
          <span className={`${LEAVE_COLUMN.remaining} text-sm font-medium text-foreground tabular-nums`}>
            {balance.remaining ?? unlimited}
          </span>
        </TabListRow>
      );
    },
    [navigate, t],
  );

  return (
    <TabListScope>
      <EntityList<LeaveBalanceItem>
        items={items}
        isLoading={false}
        error={null}
        filters={[]}
        hideTopBar
        headerColumns={headerColumns}
        renderRow={renderRow}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{
          icon: <NotesIllustration />,
          title: t('weldhr.me.overview.record.leaveEmptyTitle'),
          description: t('weldhr.me.overview.record.leaveEmptyDescription'),
        }}
      />
    </TabListScope>
  );
}

// ─── Upcoming shifts tab ───────────────────────────────────────────────────

const SHIFT_COLUMN = {
  date: 'min-w-0 flex-1',
  time: 'w-[140px]',
  client: 'w-[200px] @max-[560px]:hidden',
};

type Shift = HrSelfOverview['upcomingShifts'][number];

function MyShiftsTab({ shifts }: Readonly<{ shifts: Shift[] }>) {
  const t = useTranslations();
  const navigate = useNavigate();
  const formatShiftTime = useFormatTime();

  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'date', header: t('weldhr.common.date'), width: SHIFT_COLUMN.date },
      { id: 'time', header: t('weldhr.me.overview.record.time'), width: SHIFT_COLUMN.time },
      { id: 'client', header: t('weldhr.common.client'), width: SHIFT_COLUMN.client },
    ],
    [t],
  );

  const renderRow = useCallback(
    (shift: Shift) => (
      <TabListRow
        key={shift.id}
        label={formatDate(shift.startsAt)}
        onOpen={() => void navigate({ to: MY_HR_PATHS.schedule })}
      >
        <span className={`${SHIFT_COLUMN.date} truncate text-sm font-medium text-foreground tabular-nums`}>
          {formatDate(shift.startsAt)}
        </span>
        <span className={`${SHIFT_COLUMN.time} text-sm text-muted-foreground tabular-nums`}>
          {formatShiftTime(shift.startsAt)}–{formatShiftTime(shift.endsAt)}
        </span>
        <span className={`${SHIFT_COLUMN.client} truncate text-sm text-muted-foreground`}>{shift.companyName ?? '—'}</span>
      </TabListRow>
    ),
    [formatShiftTime, navigate],
  );

  return (
    <TabListScope>
      <EntityList<Shift>
        items={shifts}
        isLoading={false}
        error={null}
        filters={[]}
        hideTopBar
        headerColumns={headerColumns}
        renderRow={renderRow}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{
          icon: <ActivityIllustration />,
          title: t('weldhr.me.overview.record.shiftsEmptyTitle'),
          description: t('weldhr.me.overview.record.shiftsEmptyDescription'),
        }}
      />
    </TabListScope>
  );
}

// ─── Record ────────────────────────────────────────────────────────────────

export function MyHrRecord({ employee, canClockIn }: Readonly<{ employee: HrSelfProfile; canClockIn: boolean }>) {
  const t = useTranslations();
  const { data: overview, isLoading, error, refetch } = useMyHrOverview();
  const [activeTab, setActiveTab] = useState<MyHrTabId>('overview');

  const leaveCount = overview?.leaveBalances.length ?? 0;
  const shiftCount = overview?.upcomingShifts.length ?? 0;
  const tabs = useMemo(
    () => [
      { id: 'overview', label: t('sweep.entities.detailsTab'), icon: ChartNoAxesGantt },
      { id: 'leave', label: t('weldhr.me.overview.leaveBalances'), icon: Plane, count: leaveCount || undefined },
      { id: 'shifts', label: t('weldhr.me.shifts.title'), icon: CalendarClock, count: shiftCount || undefined },
    ],
    [t, leaveCount, shiftCount],
  );

  return (
    <div className="h-full min-h-0">
      <EntityDetailView
        mode="fullscreen"
        fullscreenOverlay={false}
        showExpandButton={false}
        showCloseButton={false}
        contentClassName={tabBodyClassName('fullscreen')}
        loading={isLoading}
        avatar={<SelfAvatar employee={employee} />}
        title={
          <span className="block text-[15px] font-medium leading-6 text-foreground truncate">{employee.displayName}</span>
        }
        actions={canClockIn && overview ? <ClockButton clock={overview.clock} /> : null}
        tabs={<ObjectPanelTabs tabs={tabs} activeTab={activeTab} onChange={(id) => setActiveTab(id as MyHrTabId)} />}
      >
        {!overview && !isLoading && (
          <RecordLoadFailed
            notFound={false}
            message={errorMessage(error, t('weldhr.me.overview.loadFailed'))}
            retryLabel={t('common.actions.retry')}
            onRetry={() => void refetch()}
          />
        )}
        {overview && activeTab === 'overview' && (
          <MyDetailsTab employee={employee} overview={overview} canClockIn={canClockIn} />
        )}
        {overview && activeTab === 'leave' && <MyLeaveTab balances={overview.leaveBalances} />}
        {overview && activeTab === 'shifts' && <MyShiftsTab shifts={overview.upcomingShifts} />}
      </EntityDetailView>
    </div>
  );
}
