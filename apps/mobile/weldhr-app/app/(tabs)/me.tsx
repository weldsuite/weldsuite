import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import Constants from 'expo-constants';
import {
  CalendarClock,
  ChevronRight,
  ClipboardCheck,
  LogOut,
  MessageSquareText,
  Thermometer,
} from 'lucide-react-native';
import { Avatar } from '@weldsuite/mobile-ui/components/Avatar';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useTheme, type ThemePreference } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { MyHrGate, useSelfState, type LinkedSelf } from '@/components/MyHrGate';
import { Pill } from '@/components/Pill';
import { Panel, Screen, Section } from '@/components/Screen';
import { BRAND } from '@/constants/brand';
import { lockMethodLabel, useAppLock } from '@/contexts/AppLockContext';
import { useOverview } from '@/hooks/use-weldhr-queries';
import { formatDate } from '@/lib/format';
import { APP_LANGUAGES, labelFor, useI18n, type AppLanguage } from '@/lib/i18n';

export default function MeScreen() {
  const { t } = useI18n();
  const state = useSelfState();

  return (
    <Screen title={t.me.title} refreshing={state.isRefetching} onRefresh={state.refetch}>
      <MyHrGate state={state}>{state.status === 'ready' ? <Profile self={state.self} /> : null}</MyHrGate>
      <Settings />
    </Screen>
  );
}

function Profile({ self }: Readonly<{ self: LinkedSelf }>) {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  const overview = useOverview(true);
  const employee = self.employee;
  const toAcknowledge = overview.data ? overview.data.toAcknowledge.coaching + overview.data.toAcknowledge.evaluations : 0;

  return (
    <>
      <Panel style={styles.profile}>
        <View style={styles.profileTop}>
          <Avatar
            name={employee.displayName}
            source={employee.avatarUrl ? { uri: employee.avatarUrl } : undefined}
            size={64}
          />
          <View style={styles.flex}>
            <Text style={[styles.name, { color: colors.text }]}>{employee.displayName}</Text>
            {employee.jobTitle ? (
              <Text style={[styles.job, { color: colors.mutedForeground }]}>{employee.jobTitle}</Text>
            ) : null}
            <Pill
              label={labelFor(t.employeeStatus, employee.status)}
              tone={employee.status === 'active' ? 'brand' : 'neutral'}
              style={styles.status}
            />
          </View>
        </View>
        <View style={[styles.facts, { borderTopColor: colors.border }]}>
          <Fact label={t.me.department} value={employee.departmentName} />
          <Fact label={t.me.manager} value={employee.manager?.displayName ?? null} />
          <Fact label={t.me.startDate} value={employee.startDate ? formatDate(employee.startDate, intlLocale) : null} />
        </View>
        {employee.employeeNumber ? (
          <Text style={[styles.number, { color: colors.mutedForeground }]}>
            {format(t.me.employeeNumber, { number: employee.employeeNumber })}
          </Text>
        ) : null}
      </Panel>

      <Section title={t.me.myWork}>
        <Panel>
          <LinkRow icon={<CalendarClock size={20} color={BRAND} />} label={t.me.schedule} href="/schedule" first />
          <LinkRow
            icon={<ClipboardCheck size={20} color={BRAND} />}
            label={t.me.tasks}
            href="/tasks"
            count={overview.data?.openTasks}
          />
          <LinkRow
            icon={<MessageSquareText size={20} color={BRAND} />}
            label={t.me.reviews}
            href="/reviews"
            count={toAcknowledge}
          />
          <LinkRow icon={<Thermometer size={20} color={BRAND} />} label={t.me.sickLeave} href="/sick" />
        </Panel>
      </Section>
    </>
  );
}

function Fact({ label, value }: Readonly<{ label: string; value: string | null }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View style={styles.fact}>
      <Text style={[styles.factLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.factValue, { color: colors.text }]} numberOfLines={1}>
        {value || t.common.dash}
      </Text>
    </View>
  );
}

function LinkRow({
  icon,
  label,
  href,
  count,
  first,
}: Readonly<{ icon: ReactNode; label: string; href: Href; count?: number; first?: boolean }>) {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
        pressed && { backgroundColor: colors.pressed },
      ]}
    >
      {icon}
      <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
      {count ? (
        <View style={styles.count}>
          <Text style={styles.countText}>{count}</Text>
        </View>
      ) : null}
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

function Settings() {
  const { colors, preference, setPreference } = useTheme();
  const { t, format, language, setLanguage } = useI18n();
  const { signOut, user } = useClerkAuth();
  const { currentWorkspace } = useWorkspace();
  const lock = useAppLock();
  const method = lockMethodLabel(t, lock.method);

  return (
    <Section title={t.me.settings}>
      <Panel style={styles.settings}>
        <View style={styles.setting}>
          <Text style={[styles.settingLabel, { color: colors.text }]}>{t.me.language}</Text>
          <SegmentedControl
            value={language}
            onValueChange={(value) => setLanguage(value as AppLanguage)}
            options={APP_LANGUAGES.map((code) => ({ label: t.languageNames[code], value: code }))}
          />
        </View>
        <View style={styles.setting}>
          <Text style={[styles.settingLabel, { color: colors.text }]}>{t.me.appearance}</Text>
          <SegmentedControl
            value={preference}
            onValueChange={(value) => void setPreference(value as ThemePreference)}
            options={[
              { label: t.me.system, value: 'system' },
              { label: t.me.light, value: 'light' },
              { label: t.me.dark, value: 'dark' },
            ]}
          />
        </View>
        {lock.available ? (
          <View style={styles.setting}>
            <Switch
              label={format(t.me.appLock, { method })}
              value={lock.enabled}
              onValueChange={(next) => void lock.setEnabled(next)}
            />
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>{format(t.me.appLockHint, { method })}</Text>
          </View>
        ) : null}
        <View style={[styles.account, { borderTopColor: colors.border }]}>
          <Text style={[styles.accountLabel, { color: colors.mutedForeground }]}>{t.me.workspace}</Text>
          <Text style={[styles.accountValue, { color: colors.text }]}>{currentWorkspace?.name ?? t.common.dash}</Text>
          <Text style={[styles.accountValue, { color: colors.mutedForeground }]}>{user?.email}</Text>
        </View>
      </Panel>

      <Pressable
        onPress={() => void signOut()}
        accessibilityRole="button"
        testID="me-sign-out"
        style={({ pressed }) => [styles.signOut, { opacity: pressed ? 0.7 : 1 }]}
      >
        <LogOut size={18} color={colors.destructive} />
        <Text style={[styles.signOutText, { color: colors.destructive }]}>{t.me.signOut}</Text>
      </Pressable>
      <Text style={[styles.version, { color: colors.mutedForeground }]}>
        {format(t.me.version, { version: Constants.expoConfig?.version ?? '1.0.0' })}
        {Platform.OS === 'web' ? ' · web' : ''}
      </Text>
    </Section>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  profile: { padding: 16, gap: 16 },
  profileTop: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  name: { fontSize: 20, fontWeight: '700' },
  job: { fontSize: 15, marginTop: 2 },
  status: { marginTop: 8 },
  facts: { flexDirection: 'row', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14 },
  fact: { flex: 1, gap: 2 },
  factLabel: { fontSize: 12 },
  factValue: { fontSize: 14, fontWeight: '600' },
  number: { fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  rowLabel: { flex: 1, fontSize: 15 },
  count: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  countText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  settings: { padding: 14, gap: 18 },
  setting: { gap: 8 },
  settingLabel: { fontSize: 14, fontWeight: '500' },
  hint: { fontSize: 13 },
  account: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14, gap: 2 },
  accountLabel: { fontSize: 12 },
  accountValue: { fontSize: 14 },
  signOut: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14 },
  signOutText: { fontSize: 16, fontWeight: '600' },
  version: { fontSize: 12, textAlign: 'center' },
});
