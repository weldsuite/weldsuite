/**
 * Settings: the lock (always on), password health, workspace, server,
 * language, appearance and sign-out. The offline copy and this phone's
 * device registration come with PASS-010 (phase 4B).
 */

import { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { Check, HeartPulse, Lock, LogOut } from 'lucide-react-native';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { ServerRow } from '@weldsuite/mobile-ui/components/ServerRow';
import { lockMethodLabel, useAppLock } from '@weldsuite/mobile-ui/contexts/AppLockContext';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { useTheme, type ThemePreference } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { Group, GroupRow } from '@/components/Group';
import { Screen } from '@/components/Screen';
import { brandFor } from '@/lib/brand';
import { APP_LANGUAGES, useI18n, type AppLanguage } from '@/lib/i18n';

export default function SettingsScreen() {
  const { t, format, language, setLanguage } = useI18n();
  const { colors, theme, preference, setPreference } = useTheme();
  const { user, signOut } = useAuthSession();
  const lock = useAppLock();
  const router = useRouter();
  const brand = brandFor(theme);

  const confirmSignOut = () => {
    Alert.alert(t.settings.signOutTitle, t.settings.signOutMessage, [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.settings.signOut, style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  return (
    <Screen title={t.settings.title}>
      <ScrollView contentContainerStyle={styles.content}>
        <Group title={t.settings.security} footer={t.settings.lockAlwaysOn}>
          <GroupRow
            icon={<Lock size={20} color={brand} />}
            title={format(t.settings.lock, { method: lockMethodLabel(t.lock, lock.method) })}
            value={t.common.on}
          />
          <GroupRow
            icon={<HeartPulse size={20} color={brand} />}
            title={t.settings.health}
            onPress={() => router.push('/health')}
            testID="open-health"
          />
        </Group>

        <WorkspaceGroup />

        <Group title={t.settings.server}>
          <View style={styles.padded}>
            <ServerRow variant="settings" language={language} accentColor={brand} />
          </View>
        </Group>

        <Group title={t.settings.language}>
          <View style={styles.padded}>
            <SegmentedControl
              value={language}
              onValueChange={(value) => setLanguage(value as AppLanguage)}
              options={APP_LANGUAGES.map((code) => ({ label: t.languageNames[code], value: code }))}
            />
          </View>
        </Group>

        <Group title={t.settings.appearance}>
          <View style={styles.padded}>
            <SegmentedControl
              value={preference}
              onValueChange={(value) => void setPreference(value as ThemePreference)}
              options={[
                { label: t.settings.system, value: 'system' },
                { label: t.settings.light, value: 'light' },
                { label: t.settings.dark, value: 'dark' },
              ]}
            />
          </View>
        </Group>

        <Group
          title={t.settings.account}
          footer={format(t.settings.version, { version: Constants.expoConfig?.version ?? '' })}
        >
          {user ? <GroupRow title={user.fullName || user.email} subtitle={user.fullName ? user.email : null} /> : null}
          <GroupRow
            icon={<LogOut size={20} color={colors.destructive} />}
            title={t.settings.signOut}
            onPress={confirmSignOut}
            destructive
            testID="sign-out"
          />
        </Group>
      </ScrollView>
    </Screen>
  );
}

/** The person's workspaces; tapping another switches to it. Hidden with only one. */
function WorkspaceGroup() {
  const { t } = useI18n();
  const { colors, theme } = useTheme();
  const { currentWorkspace, workspaces, switchWorkspace } = useWorkspace();
  const [switching, setSwitching] = useState<string | null>(null);

  if (workspaces.length < 2) {
    return currentWorkspace ? (
      <Group title={t.settings.workspace}>
        <GroupRow title={currentWorkspace.name} />
      </Group>
    ) : null;
  }

  const switchTo = async (id: string) => {
    if (id === currentWorkspace?.clerkOrgId || switching) return;
    setSwitching(id);
    try {
      await switchWorkspace(id);
    } catch {
      // WorkspaceContext logs it; the app stays on the current workspace.
    } finally {
      setSwitching(null);
    }
  };

  return (
    <Group title={t.settings.workspace}>
      {workspaces.map((workspace) => {
        const current = workspace.clerkOrgId === currentWorkspace?.clerkOrgId;
        let value = null;
        if (switching === workspace.clerkOrgId) value = <ActivityIndicator size="small" color={colors.mutedForeground} />;
        else if (current) value = <Check size={18} color={brandFor(theme)} />;
        return (
          <GroupRow
            key={workspace.clerkOrgId}
            title={workspace.name}
            value={value}
            chevron={false}
            onPress={() => void switchTo(workspace.clerkOrgId)}
          />
        );
      })}
    </Group>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 120, paddingTop: 4 },
  padded: { padding: 12 },
});
