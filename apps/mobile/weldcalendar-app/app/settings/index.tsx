/**
 * Settings — account, appearance and privacy shortcuts.
 */

import { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Moon, Sun, LogOut, ChevronRight, Check } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';

import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow } from '@/components/detail';
import { useNotifications } from '@/contexts/NotificationContext';
import { useI18n } from '@/lib/i18n';

export default function SettingsScreen() {
  const { colors, theme, toggleTheme } = useTheme();
  const { user, signOut } = useClerkAuth();
  const { currentWorkspace, workspaces, switchWorkspace } = useWorkspace();
  const { isPermissionGranted, requestPermissions, openNotificationSettings, unregisterDevice, prepareWorkspaceSwitch } =
    useNotifications();
  const toast = useToast();
  const router = useRouter();
  const { t, language } = useI18n();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  const handleSwitchWorkspace = async (clerkOrgId: string) => {
    if (switchingId) return;
    setSwitchingId(clerkOrgId);
    try {
      await prepareWorkspaceSwitch();
      await switchWorkspace(clerkOrgId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.settings.switchWorkspaceFailed);
    } finally {
      setSwitchingId(null);
    }
  };

  const handleNotifications = () => {
    if (isPermissionGranted) {
      openNotificationSettings();
    } else {
      void requestPermissions();
    }
  };

  return (
    <Screen header={<ScreenHeader title={t.settings.title} showBack />}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionCard title={t.settings.account}>
          <DetailRow
            label={t.settings.name}
            value={user?.fullName || user?.email || t.common.dash}
          />
          <DetailRow label={t.settings.email} value={user?.email || t.common.dash} />
        </SectionCard>

        <SectionCard title={t.settings.workspace}>
          {workspaces.length > 0 ? (
            workspaces.map((ws) => {
              const isActive = currentWorkspace?.clerkOrgId === ws.clerkOrgId;
              const isSwitching = switchingId === ws.clerkOrgId;
              return (
                <Pressable
                  key={ws.clerkOrgId}
                  onPress={() => !isActive && void handleSwitchWorkspace(ws.clerkOrgId)}
                  disabled={isActive || !!switchingId}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.linkRow, pressed && !isActive && { opacity: 0.7 }]}
                >
                  <Text style={[styles.linkLabel, { color: colors.text }]}>{ws.name}</Text>
                  {isSwitching ? (
                    <ActivityIndicator size="small" color={colors.mutedForeground} />
                  ) : isActive ? (
                    <Check size={18} color={colors.text} />
                  ) : null}
                </Pressable>
              );
            })
          ) : (
            <DetailRow
              label={t.settings.workspace}
              value={currentWorkspace?.name ?? t.common.dash}
            />
          )}
        </SectionCard>

        <SectionCard title={t.settings.appearance}>
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              {theme === 'dark' ? (
                <Moon size={18} color={colors.mutedForeground} />
              ) : (
                <Sun size={18} color={colors.mutedForeground} />
              )}
              <Text style={[styles.switchText, { color: colors.text }]}>
                {t.settings.darkMode}
              </Text>
            </View>
            <Switch value={theme === 'dark'} onValueChange={() => void toggleTheme()} />
          </View>
          <DetailRow label={t.settings.language} value={t.languageNames[language]} />
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            {t.settings.languageHint}
          </Text>
        </SectionCard>

        <SectionCard title={t.settings.notifications}>
          <Pressable
            onPress={handleNotifications}
            accessibilityRole="button"
            style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.linkLabel, { color: colors.text }]}>
              {t.settings.pushNotifications}
            </Text>
            <View style={styles.linkRight}>
              <Text style={{ color: colors.mutedForeground }}>
                {isPermissionGranted ? t.more.notificationsOn : t.more.notificationsOff}
              </Text>
              <ChevronRight size={18} color={colors.mutedForeground} />
            </View>
          </Pressable>
        </SectionCard>

        <SectionCard title={t.settings.privacy}>
          <Pressable
            onPress={() => router.push('/settings/privacy')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.linkLabel, { color: colors.text }]}>
              {t.settings.privacyAccount}
            </Text>
            <ChevronRight size={18} color={colors.mutedForeground} />
          </Pressable>
        </SectionCard>

        <SectionCard title={t.settings.app}>
          <DetailRow label={t.settings.version} value={appVersion} />
          <DetailRow label={t.settings.product} value="WeldCalendar" />
        </SectionCard>

        <Button
          title={t.settings.signOut}
          variant="outline"
          leftIcon={<LogOut size={18} color={colors.destructive} />}
          textStyle={{ color: colors.destructive }}
          onPress={() => setConfirmSignOut(true)}
          style={styles.signOut}
        />
      </ScrollView>

      <ConfirmModal
        visible={confirmSignOut}
        title={t.settings.signOutTitle}
        confirmText={t.settings.signOut}
        cancelText={t.common.cancel}
        variant="destructive"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={async () => {
          setConfirmSignOut(false);
          try {
            await unregisterDevice();
            await signOut();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.settings.signOutFailed);
          }
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  switchLabel: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchText: { fontSize: 15, fontWeight: '500' },
  hint: { fontSize: 12, marginTop: 4, lineHeight: 16 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  linkLabel: { fontSize: 15, fontWeight: '500' },
  linkRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  signOut: { marginHorizontal: 12, marginTop: 20 },
});
