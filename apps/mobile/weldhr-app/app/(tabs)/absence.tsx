/**
 * Absence: the member's requests and sick reports per year (their balances
 * are on the profile page); for people with the permission, who is off on a
 * given day and the leave requests waiting for their approval. The lists are
 * Schedule's grouped list (GroupedList), so the two pages look the same.
 */

import { useState, type ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { Thermometer } from 'lucide-react-native';
import type { HrAbsence, HrLeaveRequest, HrSelfLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';

import { LeaveApprovals } from '@/components/Approvals';
import { EmptyState } from '@/components/EmptyState';
import { FilterSheet } from '@/components/FilterSheet';
import { GroupedList, type ListGroup } from '@/components/GroupedList';
import { LeaveRow, LeaveTypeTile, SickRow, SickTile } from '@/components/HrRows';
import { MonthCalendar } from '@/components/MonthCalendar';
import { ListSearch, NoMatches } from '@/components/ListSearch';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { AVATAR_BADGE, PersonAvatar } from '@/components/PersonAvatar';
import { ListSkeleton, QueryBody } from '@/components/QueryBody';
import { IconTile, Row } from '@/components/Row';
import { Inset, PeriodNav, Screen, TabStrip, type SegmentOption } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import {
  useAbsences,
  useHrAccess,
  useLeave,
  usePendingLeave,
  useSickReports,
  useTeamLeave,
} from '@/hooks/use-weldhr-queries';
import type { HrAccess } from '@/lib/access';
import { addDays, todayIso } from '@/lib/dates';
import { formatLongDay, formatShortDate, formatSpan, RANGE, withCount } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Translations } from '@/lib/i18n/locales/en';
import { matchesSearch } from '@/lib/search';

type AbsenceView = 'mine' | 'absences' | 'requests';

export default function AbsenceScreen() {
  const { t, intlLocale } = useI18n();
  const { access } = useHrAccess();
  const state = useSelfState();
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const [chosen, setChosen] = useState<AbsenceView>('mine');
  const [year, setYear] = useState(thisYear);
  const [day, setDay] = useState(today);

  const pending = usePendingLeave(access.approveLeave);
  const options = absenceViews(access, t, pending.data?.length ?? 0);
  const view = options.some((o) => o.value === chosen) ? chosen : (options[0]?.value ?? 'mine');

  const leave = useLeave();
  const absences = useAbsences();
  const teamLeave = useTeamLeave(day, day, view === 'absences' && access.leave);
  const sick = useSickReports(view === 'absences' && access.sickToday);

  const ready = state.status === 'ready';
  const canRequest = ready && state.self.features.leaveRequests;

  const refresh = () => {
    state.refetch();
    if (view === 'mine') {
      void leave.refetch();
      void absences.refetch();
    } else if (view === 'absences') {
      void teamLeave.refetch();
      void sick.refetch();
    } else {
      void pending.refetch();
    }
  };

  const { period, behind } = absencePeriod(view, { year, thisYear, setYear, day, setDay, locale: intlLocale });

  let body: ReactNode;
  if (view === 'mine') {
    body = (
      <MyHrGate state={state} onRetry={refresh}>
        <MyAbsence year={year} canRequest={canRequest} />
      </MyHrGate>
    );
  } else if (view === 'absences') {
    body = (
      <OffOnDay
        day={day}
        leave={access.leave ? teamLeave.data : []}
        sick={access.sickToday ? sick.data : []}
        loading={(access.leave && teamLeave.isPending) || (access.sickToday && sick.isPending)}
      />
    );
  } else {
    body = <LeaveToApprove pending={pending} />;
  }

  return (
    <Screen
      title={t.tabs.absence}
      segments={<TabStrip value={view} options={options} onChange={setChosen} />}
      period={period}
      behind={behind}
      keepSheet
      refreshing={leave.isRefetching || teamLeave.isRefetching || pending.isRefetching}
      onRefresh={refresh}
    >
      {/* Keyed by the tab, so the other view fades in instead of popping in. */}
      <Animated.View key={view} entering={FadeIn.duration(180)} style={styles.view}>
        {body}
      </Animated.View>
    </Screen>
  );
}

/** The member's views: their own absence, who is off, and leave to approve (with how many wait). */
function absenceViews(access: HrAccess, t: Translations, waiting: number): SegmentOption<AbsenceView>[] {
  const options: SegmentOption<AbsenceView>[] = [];
  if (access.self) options.push({ value: 'mine', label: t.absence.mine, testID: 'absence-mine' });
  if (access.leave || access.sickToday) options.push({ value: 'absences', label: t.absence.absences, testID: 'absence-team' });
  if (access.approveLeave) {
    options.push({ value: 'requests', label: withCount(t.absence.requests, waiting), testID: 'absence-requests' });
  }
  return options;
}

/**
 * Under the segments: the year on My absence (not past this one), the day on
 * Absences with the month calendar behind the sheet to jump to another.
 */
function absencePeriod(
  view: AbsenceView,
  nav: {
    year: number;
    thisYear: number;
    setYear: (year: number) => void;
    day: string;
    setDay: (day: string) => void;
    locale: string;
  },
): { period: ReactNode; behind?: (close: () => void) => ReactNode } {
  const { year, thisYear, setYear, day, setDay, locale } = nav;
  if (view === 'mine') {
    return {
      period: (
        <PeriodNav
          label={String(year)}
          onPrevious={() => setYear(year - 1)}
          onNext={year <= thisYear ? () => setYear(year + 1) : undefined}
        />
      ),
    };
  }
  if (view !== 'absences') return { period: null };
  return {
    period: (
      <PeriodNav label={formatLongDay(day, locale)} onPrevious={() => setDay(addDays(day, -1))} onNext={() => setDay(addDays(day, 1))} />
    ),
    behind: (close) => (
      <MonthCalendar
        value={day}
        mode="day"
        onPick={(iso) => {
          setDay(iso);
          close();
        }}
      />
    ),
  };
}

/** Leave requests waiting for the member's approval. */
function LeaveToApprove({ pending }: Readonly<{ pending: ReturnType<typeof usePendingLeave> }>) {
  const { t } = useI18n();
  return (
    <QueryBody query={pending}>
      {(requests) =>
        requests.length === 0 ? (
          <EmptyState illustration="check" title={t.team.nothingToApprove} description={t.team.nothingToApproveDescription} />
        ) : (
          <SearchableLeaveApprovals requests={requests} />
        )
      }
    </QueryBody>
  );
}

/**
 * The requests to approve as Expenses → To approve has its claims: a search
 * field over who asks, for which type of leave, why and when, and a filter
 * that switches types of leave off.
 */
function SearchableLeaveApprovals({ requests }: Readonly<{ requests: HrLeaveRequest[] }>) {
  const { t, plural, intlLocale } = useI18n();
  const [search, setSearch] = useState('');
  const [off, setOff] = useState<string[]>([]);
  const [filtering, setFiltering] = useState(false);

  // The types of leave asked for, by name; one switched off that nobody asks for any more no longer counts.
  const types = new Map(requests.map((r) => [r.leaveTypeId, r.leaveTypeName ?? t.absence.leave]));
  const hidden = off.filter((id) => types.has(id));
  const shown = requests.filter(
    (r) =>
      !hidden.includes(r.leaveTypeId) &&
      matchesSearch(search, [
        r.employeeName,
        r.leaveTypeName,
        r.reason,
        formatSpan(r.startDate, r.endDate, intlLocale),
        plural(r.days, t.balance.days),
      ]),
  );

  return (
    <>
      <ListSearch
        value={search}
        onChangeText={setSearch}
        placeholder={t.absence.search}
        filtered={hidden.length > 0}
        onFilter={() => setFiltering(true)}
        testID="leave-approvals"
      />
      {shown.length === 0 ? (
        <NoMatches
          title={t.absence.noResults}
          description={t.absence.noResultsDescription}
          filtered={hidden.length > 0}
          onClearFilters={() => setOff([])}
          onClearSearch={() => setSearch('')}
        />
      ) : (
        <LeaveApprovals requests={shown} />
      )}
      {filtering ? (
        <FilterSheet
          options={[...types]
            .map(([value, label]) => ({ value, label }))
            .sort((a, b) => a.label.localeCompare(b.label))}
          off={hidden}
          onApply={setOff}
          onClose={() => setFiltering(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The member's year: requests waiting for review, the ones reviewed, and sick
 * reports (with "Report sick" while they are not), each with how many; under
 * them the days of leave taken and the days off sick.
 */
function MyAbsence({ year, canRequest }: Readonly<{ year: number; canRequest: boolean }>) {
  const palette = usePalette();
  const { t, format, plural } = useI18n();
  const router = useRouter();
  const leave = useLeave();
  const absences = useAbsences();
  const today = todayIso();
  const prefix = String(year);
  const thisYear = today.startsWith(prefix);

  if (leave.isPending) return <ListSkeleton count={4} />;

  const requests = (leave.data?.requests ?? []).filter((r) => r.startDate.startsWith(prefix) || r.endDate.startsWith(prefix));
  const open = requests.filter((r) => r.status === 'pending').sort((a, b) => a.startDate.localeCompare(b.startDate));
  const reviewed = requests.filter((r) => r.status !== 'pending').sort((a, b) => b.startDate.localeCompare(a.startDate));
  const current = absences.data?.current ?? null;
  const sickReports = [...(current ? [current] : []), ...(absences.data?.history ?? [])].filter(
    (a) => a.startDate.startsWith(prefix) || (a.endDate ?? today).startsWith(prefix),
  );
  const reportSick = thisYear && !current;
  // A request or sick report opens its own page (cancelling leave is there).
  const requestRow = (request: HrSelfLeaveRequest) => (
    <LeaveRow
      key={request.id}
      request={request}
      onPress={() => router.push({ pathname: '/leave/[id]', params: { id: request.id } })}
    />
  );

  const groups: ListGroup[] = [];
  if (open.length > 0) {
    groups.push({ key: 'open', title: t.absence.openRequests, figure: String(open.length), children: open.map(requestRow) });
  }
  if (reviewed.length > 0) {
    groups.push({ key: 'reviewed', title: t.absence.reviewed, figure: String(reviewed.length), children: reviewed.map(requestRow) });
  }
  if (sickReports.length > 0 || reportSick) {
    groups.push({
      key: 'sick',
      title: t.absence.sickLeave,
      figure: sickReports.length > 0 ? String(sickReports.length) : undefined,
      children: (
        <>
          {sickReports.map((report) => (
            <SickRow
              key={report.id}
              absence={report}
              onPress={() => router.push({ pathname: '/sick/[id]', params: { id: report.id } })}
            />
          ))}
          {reportSick ? (
            <Row leading={<IconTile icon={Thermometer} />} title={t.absence.reportSick} onPress={() => router.push('/sick')} chevron />
          ) : null}
        </>
      ),
    });
  }

  const leaveDays = requests.filter((r) => r.status === 'approved').reduce((sum, r) => sum + r.days, 0);
  const sickDays = sickReports.reduce((sum, a) => sum + a.days, 0);

  return (
    <>
      {!canRequest ? (
        <Inset style={styles.note}>
          <Text style={[styles.noteText, { color: palette.muted }]}>{t.timeOff.turnedOff}</Text>
        </Inset>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState illustration="calendar" title={format(t.absence.noAbsence, { year: prefix })} />
      ) : (
        <GroupedList
          groups={groups}
          total={{
            label: t.common.total,
            value: [
              format(t.absence.leaveDays, { days: plural(leaveDays, t.balance.days) }),
              format(t.absence.sickDays, { days: plural(sickDays, t.balance.days) }),
            ],
          }}
        />
      )}
    </>
  );
}

/** Who is off on `day`: approved leave and sick reports that cover it. */
function OffOnDay({
  day,
  leave,
  sick,
  loading,
}: Readonly<{ day: string; leave: HrLeaveRequest[] | undefined; sick: HrAbsence[] | undefined; loading: boolean }>) {
  const { t, plural, intlLocale } = useI18n();
  if (loading) return <ListSkeleton count={4} />;

  const today = todayIso();
  const onLeave = (leave ?? []).filter((r) => r.startDate <= day && r.endDate >= day);
  const ill = (sick ?? []).filter((a) => a.startDate <= day && (a.endDate ?? today) >= day && day <= today);

  if (onLeave.length === 0 && ill.length === 0) {
    return <EmptyState illustration="people" title={t.absence.nobodyAbsent} description={t.absence.nobodyAbsentDescription} />;
  }

  const groups: ListGroup[] = [];
  if (onLeave.length > 0) {
    groups.push({
      key: 'leave',
      title: t.absence.leave,
      figure: String(onLeave.length),
      children: onLeave.map((request) => (
        <Row
          key={request.id}
          leading={<PersonAvatar name={request.employeeName} badge={<LeaveTypeTile color={request.leaveTypeColor} size={AVATAR_BADGE} />} />}
          title={request.employeeName}
          subtitle={request.leaveTypeName ?? t.absence.leave}
          value={formatSpan(request.startDate, request.endDate, intlLocale)}
          detail={plural(request.days, t.balance.days)}
        />
      )),
    });
  }
  if (ill.length > 0) {
    groups.push({
      key: 'sick',
      title: t.absence.sick,
      figure: String(ill.length),
      children: ill.map((absence) => (
        <Row
          key={absence.id}
          leading={<PersonAvatar name={absence.employeeName} badge={<SickTile size={AVATAR_BADGE} />} />}
          title={absence.employeeName}
          subtitle={t.absence.sick}
          value={
            absence.endDate
              ? formatSpan(absence.startDate, absence.endDate, intlLocale)
              : `${formatShortDate(absence.startDate, intlLocale)}${RANGE}…`
          }
          detail={plural(absence.days, t.balance.days)}
        />
      )),
    });
  }

  return <GroupedList groups={groups} />;
}

const styles = StyleSheet.create({
  view: { flexGrow: 1 },
  note: { marginTop: 8 },
  noteText: { fontSize: 14, lineHeight: 20 },
});
