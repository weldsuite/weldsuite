/**
 * One of my shifts, opened from Schedule or Home: when it is and what for at
 * the top, then its breaks (the planned one, time clocked out in between, a
 * break HR recorded), what was clocked on it, and what it pays, as open rows
 * like Schedule's. Hours clocked without a shift open here too, by the
 * record's id, without the planned part.
 *
 * It reads the week the shift is in (`day`), the same query Schedule shows,
 * so it opens at once from there.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Clock, Coffee } from 'lucide-react-native';
import type { HrSelfAttendance } from '@weldsuite/app-api-client/domains/weldhr';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { EmptyState } from '@/components/EmptyState';
import { statusColor, timeRange } from '@/components/HrRows';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, EmptyRow, IconTile, Row } from '@/components/Row';
import { Inset, Screen, Section } from '@/components/Screen';
import { swatchFor, type Palette } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { useAttendance } from '@/hooks/use-weldhr-queries';
import { addDays, startOfWeek, todayIso } from '@/lib/dates';
import { formatHoursMinutes, formatLongDay, formatMoney, formatTimer } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import type { Translations } from '@/lib/i18n/locales/en';
import {
  byClockIn,
  clockedOutGaps,
  DEFAULT_CURRENCY,
  earnings,
  isOpen,
  minutesBetween,
  minutesOf,
  plannedBreak,
  plannedMinutes,
  shiftOf,
} from '@/lib/shifts';

type MyRecord = HrSelfAttendance['records'][number];
type MyShift = HrSelfAttendance['shifts'][number];

export default function ShiftScreen() {
  const { t, intlLocale } = useI18n();
  const { id, day } = useLocalSearchParams<{ id: string; day?: string }>();
  const anchor = day ?? todayIso();
  const from = startOfWeek(anchor);
  const state = useSelfState();
  const week = useAttendance(from, addDays(from, 6), state.status === 'ready');

  const refresh = () => {
    state.refetch();
    void week.refetch();
  };

  return (
    <Screen
      title={day ? capitalize(formatLongDay(day, intlLocale)) : t.shift.details}
      variant="push"
      plain
      refreshing={week.isRefetching}
      onRefresh={refresh}
    >
      <MyHrGate state={state} onRetry={refresh}>
        <QueryBody query={week}>{(data) => <ShiftDetail data={data} id={id} />}</QueryBody>
      </MyHrGate>
    </Screen>
  );
}

/** "Dinsdag 27 oktober" for a title; Dutch writes the weekday in lower case. */
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function ShiftDetail({ data, id }: Readonly<{ data: HrSelfAttendance; id: string }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const { currentWorkspace } = useWorkspace();
  const running = data.records.some(isOpen);
  const now = useNow(running ? 1000 : 30_000);

  const shift = data.shifts.find((s) => s.id === id);
  const loose = shift ? undefined : data.records.find((r) => r.id === id);
  if (!shift && !loose) return <EmptyState illustration="calendar" title={t.shift.notFound} />;

  const worked: MyRecord[] = shift
    ? data.records.filter((r) => shiftOf(r, data.shifts, now)?.id === shift.id).sort(byClockIn)
    : [loose!];
  const workspace = currentWorkspace?.name;
  const company = shift?.companyName ?? loose?.companyName ?? null;
  const open = worked.find(isOpen);
  const started = shift ? new Date(shift.startsAt).getTime() <= now : true;
  const workedMinutes = worked.reduce((sum, r) => sum + minutesOf(r, now), 0);
  const hours = (value: number) => formatHoursMinutes(value, t.common.hm);
  // A break in minutes ("30 min"), from an hour on in hours and minutes.
  const minutes = (value: number) => (value >= 60 ? hours(value) : format(t.shift.minutes, { minutes: Math.round(value) }));

  const { status, tint: statusTint } = shiftStatus({ open: Boolean(open), worked, started, t, palette });

  // What and where: the work and the client, else the workspace, as on Home.
  const place = shift ? [shift.workType, company].filter(Boolean).join(' · ') || workspace : t.schedule.withoutShift;

  return (
    <>
      <View style={styles.hero}>
        <View style={[styles.heroBar, { backgroundColor: swatchFor(company ?? workspace) }]} />
        <View style={styles.flex}>
          <View style={styles.heroTitleRow}>
            <Text style={[styles.heroTitle, { color: palette.text }]} numberOfLines={1}>
              {shift
                ? timeRange(shift.startsAt, shift.endsAt, intlLocale)
                : timeRange(loose!.clockIn, loose!.clockOut, intlLocale)}
            </Text>
            <Text style={[styles.heroLength, { color: palette.muted }]}>
              {shift ? hours(plannedMinutes(shift)) : hours(workedMinutes)}
            </Text>
          </View>
          {place ? (
            <Text style={[styles.heroLine, { color: palette.muted }]} numberOfLines={1}>
              {place}
            </Text>
          ) : null}
          <Text style={[styles.heroStatus, { color: statusTint }]} numberOfLines={1}>
            {status}
          </Text>
        </View>
      </View>

      {shift?.notes ? (
        <Section title={t.shift.notes}>
          <Inset>
            <Text style={[styles.notes, { color: palette.text }]}>{shift.notes}</Text>
          </Inset>
        </Section>
      ) : null}

      <Breaks shift={shift} worked={worked} minutes={minutes} />

      {worked.length > 0 || started ? <Worked worked={worked} now={now} hours={hours} /> : null}

      <Pay shift={shift} worked={worked} workedMinutes={workedMinutes} now={now} hours={hours} />
    </>
  );
}

/** The status in the corner of the summary: clocked in, worked (approved or not), missed or still to come. */
function shiftStatus({
  open,
  worked,
  started,
  t,
  palette,
}: Readonly<{ open: boolean; worked: MyRecord[]; started: boolean; t: Translations; palette: Palette }>): {
  status: string;
  tint: string;
} {
  if (open) return { status: t.timesheet.clockedIn, tint: palette.success };
  if (worked.length > 0) {
    const approved = worked.every((r) => r.approved);
    return approved
      ? { status: t.timesheet.approved, tint: palette.success }
      : { status: t.timesheet.pendingApproval, tint: palette.warning };
  }
  if (started) return { status: t.schedule.notClockedIn, tint: palette.warning };
  return { status: t.shift.planned, tint: palette.muted };
}

/** What was clocked on the shift: each stretch with how it was recorded, how late and its status, then the notes. */
function Worked({
  worked,
  now,
  hours,
}: Readonly<{ worked: MyRecord[]; now: number; hours: (value: number) => string }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  return (
    <Section title={t.shift.worked}>
      <Card open>
        {worked.length === 0 ? <EmptyRow icon={Clock} title={t.schedule.notClockedIn} /> : null}
        {worked.map((record) => {
          const since = isOpen(record) ? record.clockIn : null;
          return (
            <Row
              key={record.id}
              leading={<IconTile icon={Clock} />}
              title={record.clockIn ? timeRange(record.clockIn, record.clockOut, intlLocale) : labelFor(t.attendanceStatus, record.status)}
              subtitle={[
                labelFor(t.shift.source, record.source),
                record.lateMinutes ? format(t.timesheet.late, { minutes: record.lateMinutes }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              value={since ? formatTimer(now - new Date(since).getTime()) : hours(minutesOf(record, now))}
              detail={since ? t.timesheet.clockedIn : labelFor(t.attendanceStatus, record.status)}
              detailColor={since ? palette.success : statusColor(record.status, palette)}
            />
          );
        })}
        {worked
          .filter((record) => record.notes)
          .map((record) => (
            <DetailRow key={`${record.id}-note`} label={t.shift.notes} value={record.notes!} />
          ))}
      </Card>
    </Section>
  );
}

/**
 * Every break, each unpaid: the one planned in the shift, the time clocked
 * out between two stretches, and break minutes recorded on a stretch.
 */
function Breaks({
  shift,
  worked,
  minutes,
}: Readonly<{ shift: MyShift | undefined; worked: MyRecord[]; minutes: (value: number) => string }>) {
  const palette = usePalette();
  const { t, intlLocale } = useI18n();
  const planned = shift ? plannedBreak(shift) : null;
  const gaps = clockedOutGaps(worked);
  const recorded = worked.filter((record) => record.breakMinutes && record.breakMinutes > 0);
  const none = !planned && gaps.length === 0 && recorded.length === 0;

  const breakRow = (key: string, title: string, subtitle: string, length: number) => (
    <Row
      key={key}
      leading={<IconTile icon={Coffee} />}
      title={title}
      subtitle={subtitle}
      value={minutes(length)}
      detail={t.shift.unpaid}
      detailColor={palette.muted}
    />
  );

  return (
    <Section title={t.shift.breaks}>
      <Card open>
        {none ? <EmptyRow icon={Coffee} title={t.shift.noBreak} /> : null}
        {planned
          ? breakRow('planned', timeRange(planned.start, planned.end, intlLocale), t.shift.plannedBreak, minutesBetween(planned.start, planned.end))
          : null}
        {gaps.map((gap) =>
          breakRow(gap.start, timeRange(gap.start, gap.end, intlLocale), t.shift.clockedOut, minutesBetween(gap.start, gap.end)),
        )}
        {recorded.map((record) =>
          breakRow(
            `${record.id}-break`,
            t.shift.recordedBreak,
            record.clockIn ? timeRange(record.clockIn, record.clockOut, intlLocale) : '',
            record.breakMinutes ?? 0,
          ),
        )}
      </Card>
      {none ? null : (
        <Inset style={styles.hint}>
          <Text style={[styles.hintText, { color: palette.muted }]}>{t.shift.breaksUnpaid}</Text>
        </Inset>
      )}
    </Section>
  );
}

/**
 * The hourly rate and what the shift pays: what the hours clocked on it
 * earned, or before any are, what its planned hours (without the break) will.
 */
function Pay({
  shift,
  worked,
  workedMinutes,
  now,
  hours,
}: Readonly<{
  shift: MyShift | undefined;
  worked: MyRecord[];
  workedMinutes: number;
  now: number;
  hours: (value: number) => string;
}>) {
  const { t, format, intlLocale } = useI18n();
  const priced = worked.find((r) => r.hourlyRate != null);
  const rate = shift?.hourlyRate ?? priced?.hourlyRate ?? null;
  const currency = shift?.currency ?? priced?.currency ?? DEFAULT_CURRENCY;
  const money = (amount: number) => formatMoney(amount, currency, intlLocale);

  const rows =
    worked.length > 0
      ? [
          { label: t.shift.paidHours, value: hours(workedMinutes) },
          { label: t.shift.earned, value: earnings(worked, now, currency, intlLocale) },
        ]
      : [
          { label: t.shift.paidHours, value: hours(shift ? plannedMinutes(shift) : 0) },
          { label: t.shift.expected, value: money(rate != null && shift ? (plannedMinutes(shift) / 60) * rate : 0) },
        ];

  return (
    <Section title={t.shift.pay}>
      <Card open>
        <DetailRow label={t.shift.hourlyRate} value={rate != null ? format(t.shift.perHour, { amount: money(rate) }) : t.shift.noRate} />
        {rows.map((row) => (
          <DetailRow key={row.label} label={row.label} value={row.value} />
        ))}
      </Card>
    </Section>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // No box: the bar in the shift's colour lines up with the section titles.
  hero: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, marginTop: 12 },
  // From the top of the time's figures to the status line's baseline, not their line boxes.
  heroBar: { width: 5, borderRadius: 2.5, marginTop: 7, marginBottom: 4.5 },
  heroTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 28 },
  heroTitle: { flex: 1, fontSize: 20, fontWeight: '700', letterSpacing: -0.3, fontVariant: ['tabular-nums'] },
  heroLength: { fontSize: 15, fontVariant: ['tabular-nums'] },
  heroLine: { fontSize: 15, lineHeight: 20, marginTop: 2 },
  heroStatus: { fontSize: 15, lineHeight: 20, marginTop: 2 },
  notes: { fontSize: 15, lineHeight: 21 },
  hint: { marginTop: 8 },
  hintText: { fontSize: 13, lineHeight: 18 },
});
