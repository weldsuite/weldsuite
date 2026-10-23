/**
 * Settings — account, appearance and privacy shortcuts.
 */

import { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useOrganization } from '@clerk/expo';
import { LogOut, ChevronRight } from 'lucide-react-native';

import { useTheme, type ThemePreference } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';

import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow } from '@/components/detail';
import { useNotifications } from '@/contexts/NotificationContext';
import { useI18n } from '@/lib/i18n';

export default function SettingsScreen() {
  const { colors, preference, setPreference } = useTheme();
  const { user, signOut } = useClerkAuth();
  const { organization } = useOrganization();
  const { isPermissionGranted, requestPermissions, openNotificationSettings, unregisterDevice } =
    useNotifications();
  const toast = useToast();
  const router = useRouter();
  const { t, language } = useI18n();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  const handleNotifications = async () => {
    if (isPermissionGranted) {
      void openNotificationSettings();
      return;
    }
    if (await requestPermissions()) return;
    // Denied (or no token): the OS won't ask again, so point to its settings.
    toast.warning(t.settings.notificationsBlocked, 5000);
    void openNotificationSettings();
  };

  return (
    <Screen header={<ScreenHeader title={t.settings.title} showBack />}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionCard title={t.settings.account}>
          <DetailRow
            label={t.settings.name}
            value={user?.fullName || t.common.dash}
          />
          <DetailRow label={t.settings.email} value={user?.email || t.common.dash} />
        </SectionCard>

        <SectionCard title={t.settings.workspace}>
          <DetailRow
            label={t.settings.workspace}
            value={organization?.name ?? t.common.dash}
          />
        </SectionCard>

        <SectionCard title={t.settings.appearance}>
          <Text style={[styles.switchText, { color: colors.text }]}>{t.settings.theme}</Text>
          <SegmentedControl
            options={[
              { value: 'system', label: t.settings.themeSystem },
              { value: 'light', label: t.settings.themeLight },
              { value: 'dark', label: t.settings.themeDark },
            ]}
            value={preference}
            onValueChange={(value) => void setPreference(value as ThemePreference)}
            style={styles.themePicker}
          />
          <DetailRow label={t.settings.language} value={t.languageNames[language]} />
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            {t.settings.languageHint}
          </Text>
        </SectionCard>

        <SectionCard title={t.settings.notifications}>
          <Pressable
            onPress={() => void handleNotifications()}
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
          <DetailRow label={t.settings.product} value="WeldFlow" />
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
  switchText: { fontSize: 15, fontWeight: '500' },
  themePicker: { marginTop: 8, marginBottom: 8 },
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
