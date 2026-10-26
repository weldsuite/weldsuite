/**
 * Schedule: a week of what was planned and what was worked, side by side.
 * My week has the member's own days: each shift with the hours clocked on it
 * (the running clock while clocked in), hours worked without a shift, shifts
 * asked for and not yet approved, and leave or sick days, then the week's
 * worked-of-planned total and its pay. Open shifts HR posted for anyone to
 * take are listed above the week, to sign up for. Team has everyone's shifts per day
 * with whether they clocked in, for people who can read attendance. Pull the
 * sheet down for the month to jump weeks.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Clock } from 'lucide-react-native';
import type { HrAttendanceRecord, HrSelfAttendance, HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { EmptyState } from '@/components/EmptyState';
import { LeaveTypeTile, SickTile, statusColor, timeRange } from '@/components/HrRows';
import { MonthCalendar } from '@/components/MonthCalendar';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { OpenShiftsSection } from '@/components/OpenShifts';
import { PersonAvatar } from '@/components/PersonAvatar';
import { QueryBody } from '@/components/QueryBody';
import { Pinned, useStickySections } from '@/components/Sticky';
import { Row, type RowProps } from '@/components/Row';
import { PeriodNav, Screen, Segments, type SegmentOption } from '@/components/Screen';
import { swatchFor } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import {
  useAbsences,
  useAttendance,
  useHrAccess,
  useLeave,
  useOpenShifts,
  useTeamAttendance,
  useTeamShifts,
} from '@/hooks/use-weldhr-queries';
import { addDays, dayOf, isoWeek, parseIsoDate, startOfWeek, todayIso } from '@/lib/dates';
import { formatDuration, formatHoursMinutes, formatShortDate, formatSpan, formatTime, formatTimer } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import {
  byClockIn,
  DEFAULT_CURRENCY,
  earnings,
  isOpen,
  minutesBetween,
  minutesOf,
  plannedMinutes,
  shiftOf,
  type Clocked,
} from '@/lib/shifts';

type ScheduleView = 'mine' | 'team';
type MyRecord = HrSelfAttendance['records'][number];
type MyShift = HrSelfAttendance['shifts'][number];

/** "08:58 – 17:04": from the first clock-in to the last clock-out of `records` (in clock-in order). */
function stretches(records: Clocked[], locale: string): string {
  const clocked = records.filter((record) => record.clockIn);
  return clocked.length > 0 ? timeRange(clocked[0]!.clockIn, clocked[clocked.length - 1]!.clockOut, locale) : '';
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function ScheduleScreen() {
  const { t, format, intlLocale } = useI18n();
  const { access } = useHrAccess();
  const state = useSelfState();
  const [chosen, setChosen] = useState<ScheduleView>('mine');
  const [day, setDay] = useState(todayIso);

  const options: SegmentOption<ScheduleView>[] = [];
  if (access.self) options.push({ value: 'mine', label: t.schedule.mine, testID: 'schedule-mine' });
  if (access.attendance) options.push({ value: 'team', label: t.schedule.team, testID: 'schedule-team' });
  const view = options.some((o) => o.value === chosen) ? chosen : (options[0]?.value ?? 'mine');

  const from = startOfWeek(day);
  const to = addDays(from, 6);
  const mine = useAttendance(from, to, view === 'mine' && state.status === 'ready');
  const openShifts = useOpenShifts(view === 'mine' && state.status === 'ready');
  const teamShifts = useTeamShifts(from, to, view === 'team');
  const teamHours = useTeamAttendance(from, to, view === 'team');


  const refresh = () => {
    state.refetch();
    if (view === 'mine') {
      void mine.refetch();
      void openShifts.refetch();
    } else {
      void teamShifts.refetch();
      void teamHours.refetch();
    }
  };

  return (
    <Screen
      title={t.tabs.schedule}
      segments={<Segments value={view} options={options} onChange={setChosen} />}
      period={
        <PeriodNav
          label={format(t.schedule.week, { week: isoWeek(from) })}
          sublabel={formatSpan(from, to, intlLocale)}
          onPrevious={() => setDay(addDays(from, -7))}
          onNext={() => setDay(addDays(from, 7))}
        />
      }
      behind={(close) => (
        <MonthCalendar
          value={day}
          mode="week"
          onPick={(iso) => {
            setDay(iso);
            close();
          }}
        />
      )}
      refreshing={view === 'mine' ? mine.isRefetching : teamShifts.isRefetching || teamHours.isRefetching}
      onRefresh={refresh}
    >
      {view === 'mine' ? (
        <MyHrGate state={state} onRetry={refresh}>
          <OpenShiftsSection enabled={state.status === 'ready'} />
          <QueryBody query={mine}>{(data) => <MyWeek data={data} from={from} to={to} />}</QueryBody>
        </MyHrGate>
      ) : (
        <QueryBody query={teamShifts}>
          {(shifts) => (
            <QueryBody query={teamHours}>
              {(records) => <TeamWeek shifts={shifts} records={records} from={from} to={to} />}
            </QueryBody>
          )}
        </QueryBody>
      )}
    </Screen>
  );
}

/** A time with the clock glyph in front, for hours that are still counting. */
function Running({ children }: Readonly<{ children: string }>) {
  const palette = usePalette();
  return (
    <View style={styles.running}>
      <Clock size={15} color={palette.text} strokeWidth={2} />
      <Text style={[styles.runningText, { color: palette.text }]}>{children}</Text>
    </View>
  );
}

/** The bold "Total" line under the week. */
function TotalRow({ label, value }: Readonly<{ label: string; value: string }>) {
  const palette = usePalette();
  return (
    <View style={styles.total}>
      <Text style={[styles.totalLabel, { color: palette.text }]}>{label}</Text>
      <Text style={[styles.totalValue, { color: palette.muted }]}>{value}</Text>
    </View>
  );
}

/**
 * My week, as Shiftbase lays out a timesheet: each day that has something on
 * it, with the day's hours and pay (what is planned, for days still to come),
 * its shifts with what was clocked on them, hours clocked without a shift,
 * and any leave or sick day.
 */
function MyWeek({ data, from, to }: Readonly<{ data: HrSelfAttendance; from: string; to: string }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const router = useRouter();
  // A shift, or hours clocked without one, opens on the week it is in.
  const openShift = (id: string, day: string) => router.push({ pathname: '/shift/[id]', params: { id, day } });
  const { currentWorkspace } = useWorkspace();
  const leave = useLeave();
  const absences = useAbsences();
  const today = todayIso();
  const records = data.records.filter((r) => r.date >= from && r.date <= to).sort(byClockIn);
  const shifts = data.shifts
    .filter((s) => dayOf(s.startsAt) >= from && dayOf(s.startsAt) <= to)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const now = useNow(records.some(isOpen) ? 1000 : 30_000);
  // Shifts I asked for that are not on the rooster (yet): waiting, or turned down.
  const asked = (data.requests ?? [])
    .filter((r) => dayOf(r.startsAt) >= from && dayOf(r.startsAt) <= to)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const requests = (leave.data?.requests ?? []).filter(
    (r) => (r.status === 'approved' || r.status === 'pending') && r.startDate <= to && r.endDate >= from,
  );
  const sick = [absences.data?.current, ...(absences.data?.history ?? [])].filter(
    (a): a is NonNullable<typeof a> => a != null && a.startDate <= to && (a.endDate ?? today) >= from,
  );

  // Each record under the shift it was clocked on; the rest stand alone.
  const onShift = new Map<string, MyRecord[]>();
  const loose: MyRecord[] = [];
  for (const record of records) {
    const shift = shiftOf(record, shifts, now);
    if (shift) onShift.set(shift.id, [...(onShift.get(shift.id) ?? []), record]);
    else loose.push(record);
  }

  const minutes = (r: MyRecord) => minutesOf(r, now);
  const workspace = currentWorkspace?.name;
  const place = (companyName: string | null) => [workspace, companyName].filter(Boolean).join(' | ');
  // "0:24 | € 7,40": the hours and what they earn, € 0,00 when payroll has no rate for them.
  const currency = records.find((r) => r.currency)?.currency ?? DEFAULT_CURRENCY;
  const withPay = (list: MyRecord[]) =>
    `${formatDuration(list.reduce((sum, r) => sum + minutes(r), 0))} | ${earnings(list, now, currency, intlLocale)}`;

  // A day's figure: what was worked and earned, or for days to come what is
  // planned (nothing when only leave is).
  const dayTotal = (day: string, planned: number, dayRecords: MyRecord[]) => {
    if (day <= today) return withPay(dayRecords);
    return planned > 0 ? format(t.schedule.planned, { hours: formatDuration(planned) }) : '';
  };

  const groups = Array.from({ length: 7 }, (_, i) => addDays(from, i))
    .map((day) => {
      const dayShifts = shifts.filter((s) => dayOf(s.startsAt) === day);
      const dayRecords = records.filter((r) => r.date === day);
      const planned = dayShifts.reduce((sum, s) => sum + plannedMinutes(s), 0);
      return {
        day,
        shifts: dayShifts,
        loose: loose.filter((r) => r.date === day),
        asked: asked.filter((r) => dayOf(r.startsAt) === day),
        // Leave over several days skips the weekend, the way it is counted.
        away: requests.filter(
          (r) => r.startDate <= day && r.endDate >= day && (r.startDate === r.endDate || !isWeekend(day)),
        ),
        ill: sick.filter((a) => a.startDate <= day && (a.endDate ?? today) >= day && day <= today),
        total: dayTotal(day, planned, dayRecords),
      };
    })
    .filter((group) => group.shifts.length + group.loose.length + group.asked.length + group.away.length + group.ill.length > 0);
  const sticky = useStickySections(groups.length, DAY_HEADER_TOP);
  const pinned = groups[sticky.active];

  if (groups.length === 0) {
    return <EmptyState illustration="calendar" title={t.schedule.noShifts} description={t.schedule.noShiftsDescription} />;
  }

  const plannedWeek = shifts.reduce((sum, s) => sum + plannedMinutes(s), 0);
  const workedWeek = formatDuration(records.reduce((sum, r) => sum + minutes(r), 0));
  const totalHours = plannedWeek > 0 ? format(t.schedule.workedOfPlanned, { worked: workedWeek, planned: formatDuration(plannedWeek) }) : workedWeek;

  /** A shift: the hours planned, and what was clocked on it or that nothing was. */
  const shiftRow = (shift: MyShift) => {
    const worked = onShift.get(shift.id) ?? [];
    const open = worked.find(isOpen);
    let row: Partial<RowProps>;
    if (open?.clockIn) {
      row = {
        subtitle: format(t.home.since, { time: formatTime(open.clockIn, intlLocale) }),
        value: <Running>{formatTimer(now - new Date(open.clockIn).getTime())}</Running>,
        detail: t.timesheet.clockedIn,
        detailColor: palette.success,
      };
    } else if (worked.length > 0) {
      const late = worked[0]?.lateMinutes;
      const approved = worked.every((r) => r.approved);
      row = {
        subtitle: [format(t.schedule.worked, { range: stretches(worked, intlLocale) }), late ? format(t.timesheet.late, { minutes: late }) : null]
          .filter(Boolean)
          .join(' · '),
        value: formatHoursMinutes(worked.reduce((sum, r) => sum + minutes(r), 0), t.common.hm),
        detail: approved ? t.timesheet.approved : t.timesheet.pendingApproval,
        detailColor: approved ? palette.success : palette.warning,
      };
    } else if (new Date(shift.startsAt).getTime() <= now) {
      row = { subtitle: t.schedule.notClockedIn, subtitleColor: palette.warning };
    } else {
      row = { subtitle: place(shift.companyName ?? shift.notes) };
    }
    return (
      <Row
        key={shift.id}
        bar={swatchFor(shift.companyName ?? workspace)}
        title={timeRange(shift.startsAt, shift.endsAt, intlLocale)}
        {...row}
        onPress={() => openShift(shift.id, dayOf(shift.startsAt))}
      />
    );
  };

  /** Hours clocked outside any shift. */
  const looseRow = (record: MyRecord) => {
    const since = isOpen(record) ? record.clockIn : null;
    let detail = record.approved ? t.timesheet.approved : t.timesheet.pendingApproval;
    if (since) detail = t.timesheet.clockedIn;
    return (
      <Row
        key={record.id}
        bar={swatchFor(record.companyName ?? workspace)}
        title={record.clockIn ? timeRange(record.clockIn, record.clockOut, intlLocale) : labelFor(t.attendanceStatus, record.status)}
        subtitle={[
          since ? format(t.home.since, { time: formatTime(since, intlLocale) }) : place(record.companyName),
          t.schedule.withoutShift,
          record.lateMinutes ? format(t.timesheet.late, { minutes: record.lateMinutes }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        value={since ? <Running>{formatTimer(now - new Date(since).getTime())}</Running> : formatHoursMinutes(minutes(record), t.common.hm)}
        detail={detail}
        detailColor={since || record.approved ? palette.success : palette.warning}
        onPress={() => openShift(record.id, record.date)}
      />
    );
  };

  return (
    <>
      <Pinned slide={sticky.slide}>{pinned ? <DayHeader day={pinned.day} total={pinned.total} pinned /> : null}</Pinned>

      {groups.map((group, index) => (
        <View key={group.day} onLayout={sticky.onSectionLayout(index)}>
          <DayHeader day={group.day} total={group.total} />
          {group.shifts.map(shiftRow)}
          {group.loose.map(looseRow)}
          {group.asked.map((request) => (
            <Row
              key={request.id}
              bar={palette.grabber}
              title={timeRange(request.startsAt, request.endsAt, intlLocale)}
              subtitle={labelFor(t.shiftRequest.status, request.status)}
              subtitleColor={statusColor(request.status, palette)}
              value={formatHoursMinutes(minutesBetween(request.startsAt, request.endsAt), t.common.hm)}
              detail={request.workType ?? undefined}
              onPress={() =>
                router.push({ pathname: '/shift-request/[id]', params: { id: request.id, day: dayOf(request.startsAt) } })
              }
            />
          ))}
          {group.away.map((request) => (
            <Row
              key={request.id}
              leading={<LeaveTypeTile color={request.leaveTypeColor} />}
              title={request.leaveTypeName ?? t.absence.leave}
              subtitle={labelFor(t.leaveStatus, request.status)}
              subtitleColor={statusColor(request.status, palette)}
              value={request.startDate === request.endDate && request.days < 1 ? t.sick.halfDay : t.sick.fullDay}
              onPress={() => router.push({ pathname: '/leave/[id]', params: { id: request.id } })}
            />
          ))}
          {group.ill.map((absence) => (
            <Row
              key={absence.id}
              leading={<SickTile />}
              title={t.absence.sick}
              subtitle={absence.status === 'ongoing' ? t.absence.ongoing : t.absence.recovered}
              subtitleColor={absence.status === 'ongoing' ? palette.danger : palette.muted}
              value={group.day === absence.startDate && absence.firstDay === 'half' ? t.sick.halfDay : t.sick.fullDay}
              onPress={() => router.push({ pathname: '/sick/[id]', params: { id: absence.id } })}
            />
          ))}
          <View style={[styles.divider, { backgroundColor: palette.border }]} />
        </View>
      ))}

      <TotalRow label={t.common.total} value={`${totalHours} | ${earnings(records, now, currency, intlLocale)}`} />
    </>
  );
}

/**
 * Everyone's week, one section per day: each shift with whether its person
 * clocked in and the hours they worked, and hours clocked without a shift.
 */
function TeamWeek({
  shifts,
  records,
  from,
  to,
}: Readonly<{ shifts: HrShift[]; records: HrAttendanceRecord[]; from: string; to: string }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const { currentWorkspace } = useWorkspace();
  const week = records.filter((r) => r.date >= from && r.date <= to).sort(byClockIn);
  const planned = shifts
    .filter((s) => dayOf(s.startsAt) >= from && dayOf(s.startsAt) <= to)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.employeeName.localeCompare(b.employeeName));
  const now = useNow(week.some(isOpen) ? 1000 : 30_000);

  const onShift = new Map<string, HrAttendanceRecord[]>();
  const loose: HrAttendanceRecord[] = [];
  for (const record of week) {
    const shift = shiftOf(
      record,
      planned.filter((s) => s.employeeId === record.employeeId),
      now,
    );
    if (shift) onShift.set(shift.id, [...(onShift.get(shift.id) ?? []), record]);
    else loose.push(record);
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i))
    .map((day) => ({
      day,
      shifts: planned.filter((s) => dayOf(s.startsAt) === day),
      loose: loose.filter((r) => r.date === day),
    }))
    .filter((group) => group.shifts.length + group.loose.length > 0);
  // Each day is a sticky section: its title stays at the top while its rows scroll.
  const sticky = useStickySections(days.length, DAY_HEADER_TOP);
  const pinned = days[sticky.active];

  if (days.length === 0) {
    return <EmptyState illustration="people" title={t.schedule.noTeamShifts} />;
  }

  const minutes = (r: HrAttendanceRecord) => minutesOf(r, now);
  const workspace = currentWorkspace?.name;
  const count = (group: (typeof days)[number]) => String(group.shifts.length + group.loose.length);
  const plannedWeek = planned.reduce((sum, s) => sum + plannedMinutes(s), 0);
  const workedWeek = formatDuration(week.reduce((sum, r) => sum + minutes(r), 0));

  /** A teammate's shift, with whether they clocked in on it. */
  const shiftRow = (shift: HrShift) => {
    const worked = onShift.get(shift.id) ?? [];
    const open = worked.find(isOpen);
    let value: RowProps['value'];
    let detail: string | undefined;
    let detailColor: string | undefined;
    if (open?.clockIn) {
      value = <Running>{formatTimer(now - new Date(open.clockIn).getTime())}</Running>;
      detail = t.timesheet.clockedIn;
      detailColor = palette.success;
    } else if (worked.length > 0) {
      value = formatHoursMinutes(worked.reduce((sum, r) => sum + minutes(r), 0), t.common.hm);
      detail = stretches(worked, intlLocale);
    } else if (new Date(shift.startsAt).getTime() <= now) {
      detail = t.schedule.notClockedIn;
      detailColor = palette.warning;
    }
    return (
      <Row
        key={shift.id}
        leading={<PersonAvatar name={shift.employeeName} />}
        bar={swatchFor(shift.workType ?? shift.companyName)}
        title={shift.employeeName}
        subtitle={[timeRange(shift.startsAt, shift.endsAt, intlLocale), shift.workType ?? shift.companyName].filter(Boolean).join(' • ')}
        value={value}
        detail={detail}
        detailColor={detailColor}
      />
    );
  };

  /** A teammate's hours clocked outside any shift. */
  const looseRow = (record: HrAttendanceRecord) => {
    const since = isOpen(record) ? record.clockIn : null;
    return (
      <Row
        key={record.id}
        leading={<PersonAvatar name={record.employeeName} />}
        bar={swatchFor(record.companyName ?? workspace)}
        title={record.employeeName}
        subtitle={[
          record.clockIn ? timeRange(record.clockIn, record.clockOut, intlLocale) : labelFor(t.attendanceStatus, record.status),
          t.schedule.withoutShift,
        ].join(' • ')}
        value={since ? <Running>{formatTimer(now - new Date(since).getTime())}</Running> : formatHoursMinutes(minutes(record), t.common.hm)}
        detail={since ? t.timesheet.clockedIn : undefined}
        detailColor={since ? palette.success : undefined}
      />
    );
  };

  return (
    <>
      <Pinned slide={sticky.slide}>{pinned ? <DayHeader day={pinned.day} total={count(pinned)} pinned /> : null}</Pinned>
      {days.map((group, index) => (
        <View key={group.day} onLayout={sticky.onSectionLayout(index)}>
          <DayHeader day={group.day} total={count(group)} />
          {group.shifts.map(shiftRow)}
          {group.loose.map(looseRow)}
          <View style={[styles.divider, { backgroundColor: palette.border }]} />
        </View>
      ))}
      <TotalRow
        label={t.common.total}
        value={plannedWeek > 0 ? format(t.schedule.workedOfPlanned, { worked: workedWeek, planned: formatDuration(plannedWeek) }) : workedWeek}
      />
    </>
  );
}

/** Space above a day header's text, and between two headers stacked while one pushes the other out. */
const DAY_HEADER_TOP = 20;
const STACK_GAP = 6;

/**
 * "Ma 26 okt" on the left, the day's hours (or how many shifts) on the right.
 * `pinned` is the copy that stays at the top while the list scrolls (Sticky.tsx).
 */
function DayHeader({ day, total, pinned = false }: Readonly<{ day: string; total: string; pinned?: boolean }>) {
  const palette = usePalette();
  const { intlLocale } = useI18n();
  const short = parseIsoDate(day)?.toLocaleDateString(intlLocale, { weekday: 'short' }).slice(0, 2) ?? '';
  const weekday = short.charAt(0).toUpperCase() + short.slice(1);
  return (
    <View style={[styles.dayHeader, pinned && [styles.dayHeaderPinned, { backgroundColor: palette.surface }]]}>
      <Text style={[styles.dayText, { color: palette.text }]} numberOfLines={1}>
        <Text style={styles.dayWeekday}>{weekday}</Text>
        {'  '}
        {formatShortDate(day, intlLocale)}
      </Text>
      <Text style={[styles.dayTotal, { color: palette.muted }]}>{total}</Text>
    </View>
  );
}

function isWeekend(iso: string): boolean {
  const weekday = parseIsoDate(iso)?.getDay();
  return weekday === 0 || weekday === 6;
}

const styles = StyleSheet.create({
  divider: { height: StyleSheet.hairlineWidth },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: DAY_HEADER_TOP,
    paddingBottom: 4,
  },
  // The pinned copy ends just under its text, so the next day's header stacks right below it.
  dayHeaderPinned: { paddingBottom: STACK_GAP },
  dayText: { flexShrink: 1, fontSize: 17, lineHeight: 22 },
  dayWeekday: { fontWeight: '700' },
  dayTotal: { fontSize: 16, lineHeight: 22, fontVariant: ['tabular-nums'] },
  running: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  runningText: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  total: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 22,
  },
  totalLabel: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  totalValue: { fontSize: 16, fontVariant: ['tabular-nums'] },
});
