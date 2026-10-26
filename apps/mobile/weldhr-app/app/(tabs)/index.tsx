/**
 * Home: the workspace at the top (tap for the menu with the profile and the
 * workspaces), the next shift in a flat grey card with the clock button,
 * then My schedule and My absences as lists on the page, without a box.
 * Where the workspace requires being at a work location, clocking asks the
 * phone for its position first (hooks/use-clock-location.ts).
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useObserve } from 'expo-observe';
import * as Haptics from 'expo-haptics';
import {
  CalendarClock,
  CalendarHeart,
  CalendarPlus,
  ClipboardCheck,
  Clock3,
  MapPin,
  Megaphone,
  MessageSquareText,
} from 'lucide-react-native';
import type { HrSelfServiceClockInput } from '@weldsuite/app-api-client/schemas/weldhr';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { LeaveRow, ShiftRow, SickRow } from '@/components/HrRows';
import { MyHrGate, useSelfState, type LinkedSelf } from '@/components/MyHrGate';
import { ListSkeleton } from '@/components/QueryBody';
import { Card, EmptyRow, IconTile, Row } from '@/components/Row';
import { Screen, Section } from '@/components/Screen';
import { WorkspaceMenu } from '@/components/WorkspaceMenu';
import { swatchFor } from '@/constants/brand';
import { useClockLocation } from '@/hooks/use-clock-location';
import { usePalette } from '@/hooks/use-palette';
import { useAbsences, useClock, useLeave, useOverview } from '@/hooks/use-weldhr-queries';
import { addDays, dayOf, todayIso } from '@/lib/dates';
import { formatDay, formatLongDay, formatTime, formatTimer } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Translations } from '@/lib/i18n/locales/en';
import type { ClockLocation } from '@/lib/location';
import { hideAppSplash } from '@/utils/splash';

/** The current time, ticking every `intervalMs`. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function HomeScreen() {
  const { markInteractive } = useObserve();
  const { t } = useI18n();
  const state = useSelfState();
  const ready = state.status === 'ready';
  const overview = useOverview(ready);

  useEffect(() => {
    if (state.status !== 'loading') {
      hideAppSplash();
      markInteractive();
    }
  }, [state.status, markInteractive]);

  const refresh = () => {
    state.refetch();
    void overview.refetch();
  };

  return (
    <Screen
      title={t.tabs.home}
      heading={<WorkspaceMenu />}
      sheet={false}
      refreshing={state.isRefetching || overview.isRefetching}
      onRefresh={refresh}
    >
      <MyHrGate state={state} onRetry={refresh}>
        {ready ? <HomeBody self={state.self} /> : null}
      </MyHrGate>
    </Screen>
  );
}

function HomeBody({ self }: Readonly<{ self: LinkedSelf }>) {
  const { t } = useI18n();
  const router = useRouter();
  const { currentWorkspace } = useWorkspace();
  const overview = useOverview(true);
  const data = overview.data;
  const workspace = currentWorkspace?.name;

  if (!data) return <ListSkeleton count={4} />;

  const now = Date.now();
  const shifts = data.upcomingShifts
    .filter((shift) => new Date(shift.endsAt).getTime() >= now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const nextShift = shifts[0] ?? null;
  // The shift the open clock record is on, and the others of today to switch to.
  const onShift = data.clock.shiftId ? (data.upcomingShifts.find((s) => s.id === data.clock.shiftId) ?? null) : null;
  const switchable = shifts.filter((s) => s.id !== data.clock.shiftId && dayOf(s.startsAt) <= todayIso());
  const showHero = self.features.selfClockIn || nextShift != null || data.clock.clockedIn;


  return (
    <>
      {showHero ? (
        <ShiftHero
          shift={nextShift}
          onShift={onShift}
          switchable={switchable}
          clockedIn={data.clock.clockedIn}
          since={data.clock.since}
          canClock={self.features.selfClockIn}
          requiresLocation={Boolean(self.features.clockInRequiresLocation)}
          workspace={workspace}
        />
      ) : null}

      <Section title={t.home.mySchedule} large first={!showHero}>
        <Card style={styles.open}>
          {shifts.length === 0 ? (
            <EmptyRow icon={CalendarClock} title={t.home.noShifts} onPress={() => router.navigate('/schedule')} />
          ) : (
            shifts.slice(0, 3).map((shift) => (
              <ShiftRow
                key={shift.id}
                startsAt={shift.startsAt}
                endsAt={shift.endsAt}
                place={shift.companyName}
                workspace={workspace}
                onPress={() => router.push({ pathname: '/shift/[id]', params: { id: shift.id, day: dayOf(shift.startsAt) } })}
              />
            ))
          )}
        </Card>
      </Section>

      <MyAbsences canRequest={self.features.leaveRequests} />

      <ToDo
        openTasks={data.openTasks}
        toAcknowledge={data.toAcknowledge.coaching + data.toAcknowledge.evaluations}
        openShifts={data.openShifts ?? 0}
        unreadAnnouncements={data.unreadAnnouncements ?? 0}
      />
    </>
  );
}

/** This year's sick report (while it runs) and the next leave, or an empty row to add some. */
function MyAbsences({ canRequest }: Readonly<{ canRequest: boolean }>) {
  const { t, format } = useI18n();
  const router = useRouter();
  const leave = useLeave();
  const absences = useAbsences();
  const today = todayIso();
  const year = today.slice(0, 4);
  const current = absences.data?.current ?? null;
  const upcoming = (leave.data?.requests ?? [])
    .filter((r) => (r.status === 'approved' || r.status === 'pending') && r.endDate >= today && r.startDate.startsWith(year))
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 3);

  return (
    <Section title={format(t.home.myAbsences, { year })} large>
      <Card style={styles.open}>
        {current ? (
          <SickRow absence={current} onPress={() => router.push({ pathname: '/sick/[id]', params: { id: current.id } })} />
        ) : null}
        {upcoming.map((request) => (
          <LeaveRow
            key={request.id}
            request={request}
            onPress={() => router.push({ pathname: '/leave/[id]', params: { id: request.id } })}
          />
        ))}
        {!current && upcoming.length === 0 ? (
          <EmptyRow
            icon={CalendarHeart}
            title={t.home.noAbsences}
            link={canRequest ? t.home.addAbsence : undefined}
            onPress={canRequest ? () => router.push('/leave/new') : undefined}
            testID="home-add-absence"
          />
        ) : null}
      </Card>
    </Section>
  );
}

/** Unread announcements, open shifts to sign up for, open tasks and reviews to read, when there are any. */
function ToDo({
  openTasks,
  toAcknowledge,
  openShifts,
  unreadAnnouncements,
}: Readonly<{ openTasks: number; toAcknowledge: number; openShifts: number; unreadAnnouncements: number }>) {
  const { t, plural } = useI18n();
  const router = useRouter();
  if (openTasks === 0 && toAcknowledge === 0 && openShifts === 0 && unreadAnnouncements === 0) return null;
  return (
    <Section title={t.home.toDo} large>
      <Card style={styles.open}>
        {unreadAnnouncements > 0 ? (
          <Row
            leading={<IconTile icon={Megaphone} />}
            title={t.announcements.title}
            subtitle={plural(unreadAnnouncements, t.home.unreadAnnouncements)}
            onPress={() => router.navigate('/announcements')}
            chevron
            testID="home-announcements"
          />
        ) : null}
        {openShifts > 0 ? (
          <Row
            leading={<IconTile icon={CalendarPlus} />}
            title={t.openShifts.title}
            subtitle={plural(openShifts, t.home.openShiftsToSignUp)}
            onPress={() => router.navigate('/schedule')}
            chevron
            testID="home-open-shifts"
          />
        ) : null}
        {openTasks > 0 ? (
          <Row
            leading={<IconTile icon={ClipboardCheck} />}
            title={t.me.tasks}
            subtitle={plural(openTasks, t.home.openTasks)}
            onPress={() => router.push('/tasks')}
            chevron
          />
        ) : null}
        {toAcknowledge > 0 ? (
          <Row
            leading={<IconTile icon={MessageSquareText} />}
            title={t.me.reviews}
            subtitle={plural(toAcknowledge, t.home.toAcknowledge)}
            onPress={() => router.push('/reviews')}
            chevron
          />
        ) : null}
      </Card>
    </Section>
  );
}

type HeroShift = { id: string; startsAt: string; endsAt: string; companyName: string | null };

/** "09:00 – 17:00" and "Workspace | Client", the lines under a shift's title. */
function shiftLines(shift: HeroShift, workspace: string | undefined, locale: string): string[] {
  return [
    `${formatTime(shift.startsAt, locale)} – ${formatTime(shift.endsAt, locale)}`,
    [workspace, shift.companyName].filter(Boolean).join(' | '),
  ].filter(Boolean);
}

/**
 * The next shift on a flat grey card, with the black clock button: its hours
 * on top and where (and which day, when not today) under them; the bar in
 * front has the shift's colour, as in the lists. While
 * the member is clocked in, the top line is how long they have been, the line
 * under it the shift they are on, top right when they started, and Switch
 * shift sits next to Clock out.
 */
function ShiftHero({
  shift,
  onShift,
  switchable,
  clockedIn,
  since,
  canClock,
  requiresLocation,
  workspace,
}: Readonly<{
  shift: HeroShift | null;
  onShift: HeroShift | null;
  switchable: HeroShift[];
  clockedIn: boolean;
  since: string | null;
  canClock: boolean;
  /** The workspace needs the phone to be at a work location to clock in, out or switch. */
  requiresLocation: boolean;
  workspace?: string;
}>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const clock = useClock();
  const geo = useClockLocation(requiresLocation);
  const toast = useToast();
  const now = useNow(clockedIn ? 1000 : 30_000);
  const [switching, setSwitching] = useState(false);
  const [denied, setDenied] = useState(false);
  const working = clock.isPending || geo.locating;

  const sinceMs = since ? new Date(since).getTime() : Number.NaN;
  const running = clockedIn && !Number.isNaN(sinceMs);
  const { title, lines } = heroText({
    elapsed: running ? now.getTime() - sinceMs : null,
    shift,
    onShift,
    workspace,
    today: todayIso(now),
    t,
    locale: intlLocale,
  });
  // A time (the running timer or the shift's hours) rather than words.
  const figure = running || shift != null;
  const shown = running ? onShift : shift;
  const bar = shown ? swatchFor(shown.companyName ?? workspace) : palette.grabber;

  /**
   * Clocks in, out or to another shift. When the workspace requires a work
   * location the phone's position goes along; without permission or a
   * position the clock is not touched and the person is told why. The server
   * has the last word (wrong place, no location set up) and its message is shown.
   */
  const clockWith = async (input: HrSelfServiceClockInput, onDone: () => void) => {
    let location: ClockLocation | undefined;
    if (requiresLocation) {
      const found = await geo.locate();
      if (found?.status === 'denied') return setDenied(true);
      if (found?.status === 'unavailable') return toast.error(t.location.unavailable);
      if (found?.status === 'ok') location = found.location;
    }
    clock.mutate(location ? { ...input, location } : input, {
      onSuccess: () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onDone();
      },
      onError: (err) => toast.error((err as Error).message || t.common.somethingWrong),
    });
  };

  const onPress = () => {
    const action = clockedIn ? 'out' : 'in';
    void clockWith({ action }, () => toast.success(action === 'in' ? t.home.clockedIn : t.home.clockedOut));
  };

  const switchTo = (shiftId: string) => {
    void clockWith({ action: 'switch', shiftId }, () => {
      toast.success(t.home.switched);
      setSwitching(false);
    });
  };

  return (
    <View style={styles.heroWrap}>
      <View style={[styles.hero, { backgroundColor: palette.tile }]}>
        <View style={styles.heroTop}>
          <View style={[styles.heroBar, { backgroundColor: bar }]} />
          <View style={styles.flex}>
            <View style={styles.heroTitleRow}>
              <Text style={[styles.heroTitle, { color: palette.text }, figure && styles.heroTimer]} numberOfLines={1}>
                {title}
              </Text>
              {running ? (
                <View style={styles.since}>
                  <Clock3 size={14} color={palette.muted} strokeWidth={2.2} />
                  <Text style={[styles.sinceText, { color: palette.muted }]}>
                    {format(t.home.since, { time: formatTime(since, intlLocale) })}
                  </Text>
                </View>
              ) : null}
            </View>
            {lines.map((line) => (
              <Text key={line} style={[styles.heroLine, { color: palette.muted }]} numberOfLines={1}>
                {line}
              </Text>
            ))}
          </View>
        </View>

        {canClock || clockedIn ? (
          <ClockButtons
            clockedIn={clockedIn}
            canSwitch={clockedIn && canClock}
            pending={working}
            busy={working && !switching}
            onClock={onPress}
            onSwitch={() => setSwitching(true)}
          />
        ) : null}
        {requiresLocation && (canClock || clockedIn) ? (
          <View style={styles.locationHint}>
            <MapPin size={14} color={palette.muted} strokeWidth={2.2} />
            <Text style={[styles.locationHintText, { color: palette.muted }]}>{t.location.required}</Text>
          </View>
        ) : null}
      </View>
      {switching ? (
        <SwitchShiftSheet
          shifts={switchable}
          workspace={workspace}
          pending={working}
          onPick={switchTo}
          onClose={() => setSwitching(false)}
        />
      ) : null}
      <ConfirmModal
        visible={denied}
        title={t.location.deniedTitle}
        message={t.location.deniedMessage}
        confirmText={t.location.openSettings}
        cancelText={t.common.close}
        onCancel={() => setDenied(false)}
        onConfirm={() => {
          setDenied(false);
          void Linking.openSettings();
        }}
      />
    </View>
  );
}

/**
 * The card's title and the lines under it. Clocked in: how long, and the shift
 * it is on. Otherwise the next shift's hours lead, with which day (when not
 * today) and where under them; with no shift, that there is none and today.
 */
function heroText({
  elapsed,
  shift,
  onShift,
  workspace,
  today,
  t,
  locale,
}: Readonly<{
  elapsed: number | null;
  shift: HeroShift | null;
  onShift: HeroShift | null;
  workspace?: string;
  today: string;
  t: Translations;
  locale: string;
}>): { title: string; lines: string[] } {
  if (elapsed != null) {
    return { title: formatTimer(elapsed), lines: onShift ? shiftLines(onShift, workspace, locale) : [t.home.noShiftToday] };
  }
  if (!shift) return { title: t.home.noShiftToday, lines: [formatLongDay(today, locale)] };
  const [hours = '', place] = shiftLines(shift, workspace, locale);
  const day = dayOf(shift.startsAt);
  let when: string | null = null;
  if (day === addDays(today, 1)) when = t.common.tomorrow;
  else if (day !== today) when = formatDay(day, locale);
  return { title: hours, lines: [[when, place].filter(Boolean).join(' · ')].filter(Boolean) };
}

/** Clock in or out in black, and while clocked in Switch shift next to it. */
function ClockButtons({
  clockedIn,
  canSwitch,
  pending,
  busy,
  onClock,
  onSwitch,
}: Readonly<{
  clockedIn: boolean;
  canSwitch: boolean;
  pending: boolean;
  /** The clock itself is working (not a switch). */
  busy: boolean;
  onClock: () => void;
  onSwitch: () => void;
}>) {
  const palette = usePalette();
  const { t } = useI18n();
  return (
    <View style={styles.heroButtons}>
      <Pressable
        onPress={onClock}
        disabled={pending}
        accessibilityRole="button"
        testID="home-clock"
        style={({ pressed }) => [
          styles.clockButton,
          { backgroundColor: palette.ink, opacity: pressed || pending ? 0.85 : 1 },
        ]}
      >
        {busy ? (
          <ActivityIndicator color={palette.inkText} />
        ) : (
          <Text style={[styles.clockText, { color: palette.inkText }]}>{clockedIn ? t.home.clockOut : t.home.clockIn}</Text>
        )}
      </Pressable>
      {canSwitch ? (
        <Pressable
          onPress={onSwitch}
          disabled={pending}
          accessibilityRole="button"
          testID="home-switch-shift"
          style={({ pressed }) => [
            styles.clockButton,
            styles.switchButton,
            { backgroundColor: palette.surface, opacity: pressed ? 0.75 : 1 },
          ]}
        >
          <Text style={[styles.switchText, { color: palette.text }]}>{t.home.switchShift}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Today's other shifts; picking one clocks out of this shift and in on that one. */
function SwitchShiftSheet({
  shifts,
  workspace,
  pending,
  onPick,
  onClose,
}: Readonly<{
  shifts: HeroShift[];
  workspace?: string;
  pending: boolean;
  onPick: (shiftId: string) => void;
  onClose: () => void;
}>) {
  const palette = usePalette();
  const { t } = useI18n();
  return (
    <Sheet visible onClose={onClose} title={t.home.switchShift} heightRatio={0.5}>
      <Text style={[styles.switchHint, { color: palette.muted }]}>{t.home.switchHint}</Text>
      <Card style={styles.addCard}>
        {shifts.length === 0 ? (
          <EmptyRow icon={CalendarClock} title={t.home.noOtherShifts} />
        ) : (
          shifts.map((shift) => (
            <ShiftRow
              key={shift.id}
              startsAt={shift.startsAt}
              endsAt={shift.endsAt}
              place={shift.companyName}
              workspace={workspace}
              onPress={pending ? undefined : () => onPick(shift.id)}
            />
          ))
        )}
      </Card>
      {pending ? <ActivityIndicator style={styles.switchSpinner} color={palette.muted} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  heroWrap: { paddingHorizontal: 16, marginTop: 14 },
  // 16pt all round; the bar and the buttons share the left edge.
  hero: { borderRadius: 16, overflow: 'hidden', padding: 16, gap: 16 },
  heroTop: { flexDirection: 'row', gap: 12, alignItems: 'stretch' },
  heroBar: { width: 5, borderRadius: 2.5 },
  // The title and, while clocked in, "Since 13:04" share one 26pt line.
  heroTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 26 },
  heroTitle: { flexShrink: 1, fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3 },
  // The running time, a size up on the same line.
  heroTimer: { fontSize: 22, letterSpacing: -0.4, fontVariant: ['tabular-nums'] },
  heroLine: { fontSize: 15, lineHeight: 20, marginTop: 2 },
  since: { flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 'auto' },
  sinceText: { fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
  heroButtons: { flexDirection: 'row', gap: 10 },
  locationHint: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -4 },
  locationHintText: { fontSize: 13 },
  clockButton: {
    flex: 1,
    flexDirection: 'row',
    gap: 7,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clockText: { fontSize: 15, fontWeight: '600' },
  // Hugs its label, so Clock out gets the rest of the row.
  switchButton: { flex: 0, paddingHorizontal: 20 },
  switchText: { fontSize: 15, fontWeight: '600' },
  switchHint: { fontSize: 14, lineHeight: 20, marginBottom: 12 },
  switchSpinner: { marginTop: 14 },
  addCard: { marginHorizontal: 0, marginTop: 4 },
  // Home's sections have no box: the rows line up with the section title, dividers between them.
  open: { marginHorizontal: 0, borderWidth: 0, borderRadius: 0 },
});
