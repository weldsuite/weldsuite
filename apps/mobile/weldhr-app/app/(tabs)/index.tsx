import { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useObserve } from 'expo-observe';
import * as Haptics from 'expo-haptics';
import {
  CalendarPlus,
  ChevronRight,
  Clock,
  ClipboardCheck,
  MessageSquareText,
  Receipt,
  Thermometer,
  Wallet,
} from 'lucide-react-native';
import { Avatar } from '@weldsuite/mobile-ui/components/Avatar';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';

import { LeaveBalances } from '@/components/LeaveBalances';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { Panel, Screen, Section } from '@/components/Screen';
import { ShiftLine } from '@/components/ShiftLine';
import { BRAND, TONES, toneFg } from '@/constants/brand';
import { useAbsences, useClock, useHrAccess, useOverview, usePayslips } from '@/hooks/use-weldhr-queries';
import { todayIso } from '@/lib/dates';
import { firstName, formatDay, formatTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

function greetingFor(hour: number): 'greetingMorning' | 'greetingAfternoon' | 'greetingEvening' {
  if (hour < 12) return 'greetingMorning';
  if (hour < 18) return 'greetingAfternoon';
  return 'greetingEvening';
}

export default function HomeScreen() {
  const { markInteractive } = useObserve();
  const { t, format } = useI18n();
  const { user } = useClerkAuth();
  const { currentWorkspace } = useWorkspace();
  const state = useSelfState();
  const ready = state.status === 'ready';
  const overview = useOverview(ready);
  const absences = useAbsences();

  useEffect(() => {
    if (state.status !== 'loading') {
      hideAppSplash();
      markInteractive();
    }
  }, [state.status, markInteractive]);

  const name = ready ? firstName(state.self.employee.firstName || state.self.employee.displayName) : firstName(user?.firstName);
  const title = name ? format(t.home[greetingFor(new Date().getHours())], { name }) : t.home.greeting;

  const refresh = () => {
    state.refetch();
    void overview.refetch();
    void absences.refetch();
  };

  return (
    <Screen
      title={title}
      eyebrow={currentWorkspace?.name}
      refreshing={state.isRefetching || overview.isRefetching}
      onRefresh={refresh}
      action={ready ? <Avatar name={state.self.employee.displayName} source={state.self.employee.avatarUrl ? { uri: state.self.employee.avatarUrl } : undefined} size={40} /> : undefined}
    >
      <MyHrGate state={state}>
        {ready ? <HomeBody selfClockIn={state.self.features.selfClockIn} /> : null}
      </MyHrGate>
    </Screen>
  );
}

function HomeBody({ selfClockIn }: Readonly<{ selfClockIn: boolean }>) {
  const { theme } = useTheme();
  const warning = toneFg('warning', theme);
  const { t, format, plural, intlLocale } = useI18n();
  const router = useRouter();
  const overview = useOverview(true);
  const absences = useAbsences();
  const { access } = useHrAccess();
  const payslips = usePayslips(access.self);
  const data = overview.data;
  const current = absences.data?.current ?? null;

  if (!data) {
    return <ActivityIndicator style={styles.loading} />;
  }

  const nextShift = data.upcomingShifts[0];
  const toAcknowledge = data.toAcknowledge.coaching + data.toAcknowledge.evaluations;

  return (
    <>
      {current ? (
        <View style={[styles.sickCard, { backgroundColor: TONES.warning.bg }]}>
          <Thermometer size={22} color={warning} />
          <View style={styles.flex}>
            <Text style={[styles.sickTitle, { color: warning }]}>
              {format(t.home.sickSince, { date: formatDay(current.startDate, intlLocale) })}
            </Text>
            <Text style={[styles.sickText, { color: warning }]}>{t.home.sickHint}</Text>
          </View>
          <Pressable
            onPress={() => router.push('/sick')}
            accessibilityRole="button"
            style={[styles.sickButton, { borderColor: warning }]}
          >
            <Text style={[styles.sickButtonText, { color: warning }]}>{t.home.imBetter}</Text>
          </Pressable>
        </View>
      ) : null}

      {selfClockIn ? <ClockCard clockedIn={data.clock.clockedIn} since={data.clock.since} /> : null}

      <Section title={t.home.nextShift}>
        <Panel style={styles.shiftPanel}>
          <Clock size={20} color={BRAND} />
          {nextShift ? (
            <View style={styles.flex}>
              <ShiftLine startsAt={nextShift.startsAt} endsAt={nextShift.endsAt} />
              {nextShift.companyName ? <MutedText>{nextShift.companyName}</MutedText> : null}
            </View>
          ) : (
            <MutedText>{t.home.noShifts}</MutedText>
          )}
        </Panel>
      </Section>

      <Section title={t.home.balances}>
        <LeaveBalances balances={data.leaveBalances} />
      </Section>

      <Section title={t.home.toDo}>
        <Panel>
          {data.openTasks === 0 && toAcknowledge === 0 ? (
            <View style={styles.row}>
              <MutedText>{t.home.nothingToDo}</MutedText>
            </View>
          ) : null}
          {data.openTasks > 0 ? (
            <LinkRow
              icon={<ClipboardCheck size={20} color={BRAND} />}
              label={plural(data.openTasks, t.home.openTasks)}
              href="/tasks"
            />
          ) : null}
          {toAcknowledge > 0 ? (
            <LinkRow
              icon={<MessageSquareText size={20} color={BRAND} />}
              label={plural(toAcknowledge, t.home.toAcknowledge)}
              href="/reviews"
            />
          ) : null}
        </Panel>
      </Section>

      <Section title={t.home.quickActions}>
        <View style={styles.actions}>
          <QuickAction icon={<CalendarPlus size={22} color={BRAND} />} label={t.home.requestTimeOff} href="/leave/new" />
          <QuickAction icon={<Receipt size={22} color={BRAND} />} label={t.home.addExpense} href="/expense/new" />
          {current ? null : (
            <QuickAction icon={<Thermometer size={22} color={BRAND} />} label={t.home.reportSick} href="/sick" />
          )}
          {payslips.data ? (
            <QuickAction icon={<Wallet size={22} color={BRAND} />} label={t.home.payslips} href="/pay" />
          ) : null}
        </View>
      </Section>
    </>
  );
}

function ClockCard({ clockedIn, since }: Readonly<{ clockedIn: boolean; since: string | null }>) {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  const clock = useClock();
  const toast = useToast();

  const onPress = () => {
    const action = clockedIn ? 'out' : 'in';
    clock.mutate(action, {
      onSuccess: () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast.success(action === 'in' ? t.home.clockedIn : t.home.clockedOut);
      },
      onError: (err) => toast.error((err as Error).message || t.common.somethingWrong),
    });
  };

  return (
    <View style={[styles.clockCard, { backgroundColor: clockedIn ? BRAND : colors.card, borderColor: colors.border }]}>
      <View style={styles.flex}>
        <Text style={[styles.clockLabel, { color: clockedIn ? 'rgba(255,255,255,0.8)' : colors.mutedForeground }]}>
          {formatDay(todayIso(), intlLocale)}
        </Text>
        <Text style={[styles.clockStatus, { color: clockedIn ? '#fff' : colors.text }]}>
          {clockedIn && since ? format(t.home.clockedInSince, { time: formatTime(since, intlLocale) }) : t.home.notClockedIn}
        </Text>
      </View>
      <Pressable
        onPress={onPress}
        disabled={clock.isPending}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.clockButton,
          { backgroundColor: clockedIn ? '#fff' : BRAND, opacity: pressed || clock.isPending ? 0.8 : 1 },
        ]}
      >
        {clock.isPending ? (
          <ActivityIndicator color={clockedIn ? BRAND : '#fff'} />
        ) : (
          <Text style={[styles.clockButtonText, { color: clockedIn ? BRAND : '#fff' }]}>
            {clockedIn ? t.home.clockOut : t.home.clockIn}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

function LinkRow({ icon, label, href }: Readonly<{ icon: ReactNode; label: string; href: Href }>) {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : 'transparent' }]}
    >
      {icon}
      <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

function QuickAction({ icon, label, href }: Readonly<{ icon: ReactNode; label: string; href: Href }>) {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <View style={[styles.actionIcon, { backgroundColor: TONES.brand.bg }]}>{icon}</View>
      <Text style={[styles.actionLabel, { color: colors.text }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

function MutedText({ children }: Readonly<{ children: ReactNode }>) {
  const { colors } = useTheme();
  return <Text style={[styles.muted, { color: colors.mutedForeground }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { marginTop: 32 },
  sickCard: { borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  sickTitle: { fontSize: 15, fontWeight: '600' },
  sickText: { fontSize: 13, marginTop: 2 },
  sickButton: { borderWidth: 1.5, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  sickButtonText: { fontSize: 14, fontWeight: '600' },
  clockCard: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  clockLabel: { fontSize: 13, fontWeight: '500' },
  clockStatus: { fontSize: 18, fontWeight: '700', marginTop: 2 },
  clockButton: { borderRadius: 12, paddingVertical: 12, paddingHorizontal: 18, minWidth: 110, alignItems: 'center' },
  clockButtonText: { fontSize: 15, fontWeight: '700' },
  shiftPanel: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  rowLabel: { flex: 1, fontSize: 15 },
  muted: { fontSize: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  action: {
    width: '48%',
    flexGrow: 1,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 10,
  },
  actionIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  actionLabel: { fontSize: 14, fontWeight: '600' },
});
