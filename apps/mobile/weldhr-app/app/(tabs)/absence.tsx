/**
 * Absence: the member's balances, requests and sick reports per year; for
 * people with the permission, who is off on a given day and the leave
 * requests waiting for their approval.
 */

import { useState, type ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import Svg, { Circle } from 'react-native-svg';
import { Hourglass, ListChecks, Thermometer } from 'lucide-react-native';
import type {
  HrAbsence,
  HrLeaveBalance,
  HrLeaveRequest,
  HrSelfLeaveRequest,
} from '@weldsuite/app-api-client/domains/weldhr';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';

import { LeaveApprovals } from '@/components/Approvals';
import { EmptyState } from '@/components/EmptyState';
import { LeaveRow, LeaveTypeTile, SickRow, SickTile } from '@/components/HrRows';
import { MonthCalendar } from '@/components/MonthCalendar';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { AVATAR_BADGE, PersonAvatar } from '@/components/PersonAvatar';
import { ListSkeleton, QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, EmptyRow, IconTile, List, Row } from '@/components/Row';
import { Inset, PeriodNav, Screen, Section, Segments, type SegmentOption } from '@/components/Screen';
import { solid } from '@/constants/brand';
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
import { formatDays, formatLongDay, formatShortDate, formatSpan, withCount } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Translations } from '@/lib/i18n/locales/en';

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
      segments={<Segments value={view} options={options} onChange={setChosen} />}
      period={period}
      behind={behind}
      refreshing={leave.isRefetching || teamLeave.isRefetching || pending.isRefetching}
      onRefresh={refresh}
    >
      {body}
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
          <LeaveApprovals requests={requests} />
        )
      }
    </QueryBody>
  );
}

function MyAbsence({ year, canRequest }: Readonly<{ year: number; canRequest: boolean }>) {
  const palette = usePalette();
  const { t, intlLocale } = useI18n();
  const router = useRouter();
  const leave = useLeave();
  const absences = useAbsences();
  const [balance, setBalance] = useState<HrLeaveBalance | null>(null);
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
  const balances = thisYear ? (leave.data?.balances ?? []) : [];
  // A request or sick report opens its own page (cancelling leave is there).
  const onRequest = (request: HrSelfLeaveRequest) => () =>
    router.push({ pathname: '/leave/[id]', params: { id: request.id } });

  return (
    <>
      {!canRequest ? (
        <Inset style={styles.note}>
          <Text style={[styles.noteText, { color: palette.muted }]}>{t.timeOff.turnedOff}</Text>
        </Inset>
      ) : null}

      {balances.length > 0 ? (
        <Section title={t.absence.balances} meta={formatSpan(`${prefix}-01-01`, `${prefix}-12-31`, intlLocale)} first>
          <Card>
            {balances.map((b) => (
              <BalanceRow key={b.leaveTypeId} balance={b} onPress={() => setBalance(b)} />
            ))}
          </Card>
        </Section>
      ) : null}

      <Section title={t.absence.openRequests} first={balances.length === 0}>
        <Card>
          {open.length === 0 ? (
            <EmptyRow icon={Hourglass} title={t.absence.noOpenRequests} />
          ) : (
            open.map((request) => <LeaveRow key={request.id} request={request} onPress={onRequest(request)} />)
          )}
        </Card>
      </Section>

      <Section title={t.absence.reviewed}>
        <Card>
          {reviewed.length === 0 ? (
            <EmptyRow icon={ListChecks} title={t.absence.nothingReviewed} />
          ) : (
            reviewed.map((request) => <LeaveRow key={request.id} request={request} onPress={onRequest(request)} />)
          )}
        </Card>
      </Section>

      <Section title={t.absence.sickLeave}>
        <Card>
          {sickReports.map((report) => (
            <SickRow
              key={report.id}
              absence={report}
              onPress={() => router.push({ pathname: '/sick/[id]', params: { id: report.id } })}
            />
          ))}
          {current || !thisYear ? null : (
            <Row leading={<IconTile icon={Thermometer} />} title={t.absence.reportSick} onPress={() => router.push('/sick')} chevron />
          )}
          {!thisYear && sickReports.length === 0 ? <EmptyRow icon={Thermometer} title={t.absence.noSickLeave} /> : null}
        </Card>
      </Section>

      {balance ? <BalanceSheet balance={balance} onClose={() => setBalance(null)} /> : null}
    </>
  );
}

/** How much of the allowance is left, as a ring in the leave type's colour. */
function Ring({ fraction, color, size = 44 }: Readonly<{ fraction: number | null; color: string; size?: number }>) {
  const palette = usePalette();
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  const shown = fraction == null ? 1 : Math.min(1, Math.max(0, fraction));
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={radius} stroke={palette.tile} strokeWidth={stroke} fill="none" />
      {shown > 0 ? (
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${length * shown} ${length}`}
          rotation={-90}
          origin={`${size / 2}, ${size / 2}`}
        />
      ) : null}
    </Svg>
  );
}

function BalanceRow({ balance, onPress }: Readonly<{ balance: HrLeaveBalance; onPress: () => void }>) {
  const palette = usePalette();
  const { t, format, plural } = useI18n();
  const limited = balance.allowance != null && balance.remaining != null;
  // How full the ring is; none for a type without a limit.
  let fraction: number | null = null;
  if (limited) fraction = balance.allowance! > 0 ? balance.remaining! / balance.allowance! : 0;
  const remaining = limited ? format(t.absence.remaining, { amount: plural(balance.remaining!, t.balance.days) }) : t.balance.unlimited;
  return (
    <Row
      leading={<Ring fraction={fraction} color={solid(balance.color)} />}
      title={balance.name}
      subtitle={remaining}
      subtitleColor={limited && balance.remaining! < 0 ? palette.danger : undefined}
      onPress={onPress}
      chevron
    />
  );
}

/** A balance in figures: allowance, taken, waiting for approval, left. */
function BalanceSheet({ balance, onClose }: Readonly<{ balance: HrLeaveBalance; onClose: () => void }>) {
  const palette = usePalette();
  const { t, intlLocale } = useI18n();
  const days = (value: number | null) => (value == null ? t.balance.unlimited : formatDays(value, intlLocale));
  return (
    <Sheet visible onClose={onClose} title={balance.name} heightRatio={0.5}>
      <Card style={styles.sheetCard}>
        <DetailRow label={t.absence.allowance} value={days(balance.allowance)} />
        <DetailRow label={t.absence.taken} value={days(balance.used)} />
        <DetailRow label={t.absence.waiting} value={days(balance.pending)} />
        <DetailRow label={t.absence.left} value={days(balance.remaining)} />
      </Card>
      {balance.prorated ? <Text style={[styles.sheetNote, { color: palette.muted }]}>{t.balance.prorated}</Text> : null}
    </Sheet>
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

  return (
    <List>
      {onLeave.map((request) => (
        <Row
          key={request.id}
          leading={<PersonAvatar name={request.employeeName} badge={<LeaveTypeTile color={request.leaveTypeColor} size={AVATAR_BADGE} />} />}
          title={request.employeeName}
          subtitle={request.leaveTypeName ?? t.absence.leave}
          value={formatSpan(request.startDate, request.endDate, intlLocale)}
          detail={plural(request.days, t.balance.days)}
        />
      ))}
      {ill.map((absence) => (
        <Row
          key={absence.id}
          leading={<PersonAvatar name={absence.employeeName} badge={<SickTile size={AVATAR_BADGE} />} />}
          title={absence.employeeName}
          subtitle={t.absence.sick}
          value={
            absence.endDate
              ? formatSpan(absence.startDate, absence.endDate, intlLocale)
              : `${formatShortDate(absence.startDate, intlLocale)} – …`
          }
          detail={plural(absence.days, t.balance.days)}
        />
      ))}
    </List>
  );
}

const styles = StyleSheet.create({
  note: { marginTop: 8 },
  noteText: { fontSize: 14, lineHeight: 20 },
  sheetCard: { marginHorizontal: 0 },
  sheetNote: { fontSize: 13, marginTop: 10 },
});
