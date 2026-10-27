/**
 * Profile, opened from the workspace menu at the top of Home: the member's
 * details, what is not one of the tabs (payslips, sick leave, tasks, reviews,
 * the directory) and the app's settings, as rows of white cards.
 */

import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import {
  BookUser,
  Building2,
  ClipboardCheck,
  FileText,
  Languages,
  Lock,
  LogOut,
  MessageSquareText,
  SunMoon,
  Thermometer,
  type LucideIcon,
} from 'lucide-react-native';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useTheme, type ThemePreference } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { MyHrGate, useSelfState, type LinkedSelf } from '@/components/MyHrGate';
import { PersonAvatar } from '@/components/PersonAvatar';
import { Card, CountBadge, DetailRow, IconTile, Row } from '@/components/Row';
import { Screen, Section, Segments } from '@/components/Screen';
import { ACCENTS, tint } from '@/constants/brand';
import { lockMethodLabel, useAppLock } from '@/contexts/AppLockContext';
import { usePalette } from '@/hooks/use-palette';
import { useHrAccess, useOverview, usePayslips } from '@/hooks/use-weldhr-queries';
import { formatDate } from '@/lib/format';
import { APP_LANGUAGES, labelFor, useI18n, type AppLanguage } from '@/lib/i18n';

export default function ProfileScreen() {
  const { t } = useI18n();
  const state = useSelfState();
  const { access } = useHrAccess();

  return (
    <Screen title={t.me.title} variant="push" refreshing={state.isRefetching} onRefresh={state.refetch}>
      {access.self ? (
        <MyHrGate state={state} onRetry={state.refetch}>
          {state.status === 'ready' ? <Profile self={state.self} /> : null}
        </MyHrGate>
      ) : null}
      <TeamMenu first={!access.self} />
      <Settings />
    </Screen>
  );
}

/** An area's icon on a tile tinted with its colour, as in WeldChat's settings. */
function AccentTile({ icon, accent }: Readonly<{ icon: LucideIcon; accent: string }>) {
  return <IconTile icon={icon} background={tint(accent)} color={accent} size={34} />;
}

function MenuRow({
  icon,
  accent,
  title,
  right,
  onPress,
  testID,
}: Readonly<{ icon: LucideIcon; accent: string; title: string; right?: ReactNode; onPress: () => void; testID?: string }>) {
  return (
    <Row
      leading={<AccentTile icon={icon} accent={accent} />}
      title={title}
      value={right}
      onPress={onPress}
      testID={testID}
      chevron
      regular
    />
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
      <Section first>
        <Card>
          <Row
            leading={<PersonAvatar name={employee.displayName} url={employee.avatarUrl} />}
            title={employee.displayName}
            subtitle={[employee.jobTitle, labelFor(t.employeeStatus, employee.status)].filter(Boolean).join(' • ')}
          />
          {details.map((detail) => (
            <DetailRow key={detail.label} label={detail.label} value={detail.value} />
          ))}
        </Card>
      </Section>

      <Section title={t.me.myWork}>
        <Card>
          {payslips.data ? (
            <MenuRow icon={FileText} accent={ACCENTS.pay} title={t.pay.payslips} onPress={() => router.push('/pay')} testID="profile-pay" />
          ) : null}
          <MenuRow icon={Thermometer} accent={ACCENTS.sick} title={t.me.sickLeave} onPress={() => router.push('/sick')} />
          <MenuRow
            icon={ClipboardCheck}
            accent={ACCENTS.tasks}
            title={t.me.tasks}
            right={<CountBadge count={overview.data?.openTasks ?? 0} />}
            onPress={() => router.push('/tasks')}
          />
          <MenuRow
            icon={MessageSquareText}
            accent={ACCENTS.reviews}
            title={t.me.reviews}
            right={<CountBadge count={toAcknowledge} />}
            onPress={() => router.push('/reviews')}
          />
        </Card>
      </Section>
    </>
  );
}

function TeamMenu({ first }: Readonly<{ first: boolean }>) {
  const { t } = useI18n();
  const router = useRouter();
  const { access } = useHrAccess();
  if (!access.directory) return null;

  return (
    <Section title={t.team.title} first={first}>
      <Card>
        <MenuRow icon={BookUser} accent={ACCENTS.team} title={t.directory.title} onPress={() => router.push('/directory')} testID="profile-directory" />
      </Card>
    </Section>
  );
}

/** A setting: the icon and name, with its control on the right or under it. */
function SettingRow({
  icon,
  title,
  right,
  below,
}: Readonly<{ icon: LucideIcon; title: string; right?: ReactNode; below?: ReactNode }>) {
  return (
    <View>
      <Row leading={<AccentTile icon={icon} accent={ACCENTS.settings} />} title={title} value={right} regular />
      {below ? <View style={styles.below}>{below}</View> : null}
    </View>
  );
}

function Settings() {
  const palette = usePalette();
  const { preference, setPreference } = useTheme();
  const { t, format, language, setLanguage } = useI18n();
  const { signOut, user } = useClerkAuth();
  const { currentWorkspace } = useWorkspace();
  const lock = useAppLock();
  const method = lockMethodLabel(t, lock.method);

  return (
    <>
      <Section title={t.me.settings}>
        <Card>
          <SettingRow
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
          <SettingRow
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
            <SettingRow
              icon={Lock}
              title={format(t.me.appLock, { method })}
              right={<Switch value={lock.enabled} onValueChange={(next) => void lock.setEnabled(next)} />}
              below={<Text style={[styles.hint, { color: palette.muted }]}>{format(t.me.appLockHint, { method })}</Text>}
            />
          ) : null}
        </Card>
      </Section>

      <Section title={t.me.account}>
        <Card>
          <Row
            leading={<AccentTile icon={Building2} accent={ACCENTS.settings} />}
            title={currentWorkspace?.name ?? t.common.dash}
            subtitle={user?.email}
          />
          <Pressable
            onPress={() => void signOut()}
            accessibilityRole="button"
            testID="me-sign-out"
            style={({ pressed }) => [styles.signOut, pressed && { backgroundColor: palette.tile }]}
          >
            <AccentTile icon={LogOut} accent={palette.danger} />
            <Text style={[styles.signOutText, { color: palette.danger }]}>{t.me.signOut}</Text>
          </Pressable>
        </Card>
      </Section>

      <Text style={[styles.version, { color: palette.muted }]}>
        {format(t.me.version, { version: Constants.expoConfig?.version ?? '1.0.0' })}
        {Platform.OS === 'web' ? ' · web' : ''}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  below: { paddingLeft: 64, paddingRight: 16, paddingBottom: 14, marginTop: -6 },
  segments: { marginHorizontal: 0, marginTop: 0 },
  hint: { fontSize: 14, lineHeight: 20 },
  signOut: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 13, minHeight: 66 },
  signOutText: { fontSize: 16, fontWeight: '500' },
  version: { fontSize: 13, textAlign: 'center', marginTop: 20 },
});
