/**
 * Profile, opened from the workspace at the top of Home: the member's
 * details and time off balances, what is not one of the tabs (payslips, sick
 * leave, tasks, reviews, the directory), the app's settings, the workspaces
 * and signing out or deleting the account. Laid out as Attio's settings (Grouped.tsx): cards on a
 * grey a step lighter than the app's canvas, without titles, the version
 * under the last.
 */

import { useState } from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import {
  BookUser,
  CircleArrowRight,
  ClipboardCheck,
  FileText,
  Languages,
  Lock,
  MessageSquareText,
  SunMoon,
  Thermometer,
  Trash2,
} from 'lucide-react-native';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useTheme, type ThemePreference } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { DeleteAccountDialog } from '@/components/DeleteAccountDialog';
import { Group, GroupFooter, GroupRow } from '@/components/Grouped';
import { LeaveBalances } from '@/components/LeaveBalances';
import { MyHrGate, useSelfState, type LinkedSelf } from '@/components/MyHrGate';
import { PersonAvatar } from '@/components/PersonAvatar';
import { CountBadge } from '@/components/Row';
import { Screen, Segments } from '@/components/Screen';
import { WorkspaceList } from '@/components/WorkspaceMenu';
import { lockMethodLabel, useAppLock } from '@/contexts/AppLockContext';
import { usePalette } from '@/hooks/use-palette';
import { useHrAccess, useOverview, usePayslips } from '@/hooks/use-weldhr-queries';
import { formatDate } from '@/lib/format';
import { APP_LANGUAGES, labelFor, useI18n, type AppLanguage } from '@/lib/i18n';

export default function ProfileScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const state = useSelfState();
  const { access } = useHrAccess();

  return (
    <Screen
      title={t.me.title}
      variant="push"
      background={palette.groupedPage}
      refreshing={state.isRefetching}
      onRefresh={state.refetch}
    >
      {access.self ? (
        <MyHrGate state={state} onRetry={state.refetch}>
          {state.status === 'ready' ? <Profile self={state.self} /> : null}
        </MyHrGate>
      ) : null}
      <TeamGroup first={!access.self} />
      <Settings />
    </Screen>
  );
}

function Profile({ self }: Readonly<{ self: LinkedSelf }>) {
  const { t, intlLocale } = useI18n();
  const router = useRouter();
  const overview = useOverview(true);
  const payslips = usePayslips(true);
  const employee = self.employee;
  const toAcknowledge = overview.data ? overview.data.toAcknowledge.coaching + overview.data.toAcknowledge.evaluations : 0;
  const details = [
    { label: t.me.department, value: employee.departmentName },
    { label: t.me.manager, value: employee.manager?.displayName ?? null },
    { label: t.me.startDate, value: employee.startDate ? formatDate(employee.startDate, intlLocale) : null },
    { label: t.me.employeeNumberLabel, value: employee.employeeNumber },
  ].filter((detail): detail is { label: string; value: string } => Boolean(detail.value));

  return (
    <>
      <Group plain style={styles.first}>
        <GroupRow
          leading={<PersonAvatar name={employee.displayName} url={employee.avatarUrl} size={36} />}
          title={employee.displayName}
          subtitle={[employee.jobTitle, labelFor(t.employeeStatus, employee.status)].filter(Boolean).join(' • ')}
        />
        {details.map((detail) => (
          <GroupRow key={detail.label} title={detail.label} value={detail.value} />
        ))}
      </Group>

      <LeaveBalances />

      <Group>
        {payslips.data ? (
          <GroupRow icon={FileText} title={t.pay.payslips} onPress={() => router.push('/pay')} testID="profile-pay" chevron />
        ) : null}
        <GroupRow icon={Thermometer} title={t.me.sickLeave} onPress={() => router.push('/sick')} chevron />
        <GroupRow
          icon={ClipboardCheck}
          title={t.me.tasks}
          value={<CountBadge count={overview.data?.openTasks ?? 0} />}
          onPress={() => router.push('/tasks')}
          chevron
        />
        <GroupRow
          icon={MessageSquareText}
          title={t.me.reviews}
          value={<CountBadge count={toAcknowledge} />}
          onPress={() => router.push('/reviews')}
          chevron
        />
      </Group>
    </>
  );
}

function TeamGroup({ first }: Readonly<{ first: boolean }>) {
  const { t } = useI18n();
  const router = useRouter();
  const { access } = useHrAccess();
  if (!access.directory) return null;

  return (
    <Group style={first ? styles.first : undefined}>
      <GroupRow
        icon={BookUser}
        title={t.directory.title}
        onPress={() => router.push('/directory')}
        testID="profile-directory"
        chevron
      />
    </Group>
  );
}

function Settings() {
  const palette = usePalette();
  const { preference, setPreference } = useTheme();
  const { t, format, language, setLanguage } = useI18n();
  const { signOut } = useClerkAuth();
  const lock = useAppLock();
  const method = lockMethodLabel(t, lock.method);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <Group>
        <GroupRow
          icon={Languages}
          title={t.me.language}
          below={
            <Segments
              value={language}
              onChange={(value) => setLanguage(value as AppLanguage)}
              options={APP_LANGUAGES.map((code) => ({ label: t.languageNames[code], value: code }))}
              style={styles.segments}
            />
          }
        />
        <GroupRow
          icon={SunMoon}
          title={t.me.appearance}
          below={
            <Segments
              value={preference}
              onChange={(value) => void setPreference(value as ThemePreference)}
              options={[
                { label: t.me.system, value: 'system' },
                { label: t.me.light, value: 'light' },
                { label: t.me.dark, value: 'dark' },
              ]}
              style={styles.segments}
            />
          }
        />
        {lock.available ? (
          <GroupRow
            icon={Lock}
            title={format(t.me.appLock, { method })}
            value={<Switch value={lock.enabled} onValueChange={(next) => void lock.setEnabled(next)} />}
            below={<Text style={[styles.hint, { color: palette.muted }]}>{format(t.me.appLockHint, { method })}</Text>}
          />
        ) : null}
      </Group>

      <WorkspaceList />

      <Group>
        <GroupRow icon={CircleArrowRight} title={t.me.signOut} onPress={() => void signOut()} testID="me-sign-out" />
        <GroupRow
          icon={Trash2}
          title={t.deleteAccount.action}
          onPress={() => setDeleting(true)}
          testID="me-delete-account"
          destructive
        />
      </Group>
      <DeleteAccountDialog visible={deleting} onClose={() => setDeleting(false)} />

      <GroupFooter
        label={t.me.versionLabel}
        value={`${Constants.expoConfig?.version ?? '1.0.0'}${Platform.OS === 'web' ? ' · web' : ''}`}
      />
    </>
  );
}

const styles = StyleSheet.create({
  // The first card, under the header's line.
  first: { marginTop: 14 },
  segments: { marginHorizontal: 0, marginTop: 0 },
  hint: { fontSize: 13, lineHeight: 18 },
});
