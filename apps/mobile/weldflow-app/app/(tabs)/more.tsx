/**
 * Everything that doesn't earn a tab — settings shortcuts and account actions,
 * matching WeldBooks' More menu chrome (Card groups + IconTile rows).
 */

import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useOrganization } from '@clerk/expo';
import * as Haptics from 'expo-haptics';
import {
  Settings,
  ShieldCheck,
  Bell,
  Moon,
  Sun,
  LogOut,
  ChevronRight,
  Building2,
} from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { IconTile } from '@/components/detail';
import { useNotifications } from '@/contexts/NotificationContext';
import { useI18n } from '@/lib/i18n';

export default function MoreScreen() {
  const { colors, theme, toggleTheme } = useTheme();
  const router = useRouter();
  const { user, signOut } = useClerkAuth();
  const { organization } = useOrganization();
  const { isPermissionGranted, requestPermissions, openNotificationSettings } = useNotifications();
  const toast = useToast();
  const { t } = useI18n();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const open = useCallback(
    (route: string) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const handleNotifications = () => {
    if (isPermissionGranted) {
      openNotificationSettings();
    } else {
      void requestPermissions();
    }
  };

  return (
    <Screen header={<ScreenHeader title={t.more.title} />}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
          {t.more.account}
        </Text>
        <Card style={[styles.card, { borderRadius: 20 }]}>
          <View style={styles.row}>
            <IconTile icon={Building2} color={ACCENTS.settings} />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>
                {user?.fullName || user?.email || t.common.dash}
              </Text>
              <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>
                {[user?.email, organization?.name].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </View>
        </Card>

        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
          {t.more.preferences}
        </Text>
        <Card style={[styles.card, { borderRadius: 20 }]}>
          <Pressable
            onPress={() => open('/settings')}
            accessibilityRole="button"
            accessibilityLabel={t.more.settings}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
          >
            <IconTile icon={Settings} color={ACCENTS.settings} />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>{t.more.settings}</Text>
              <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>
                {t.more.settingsSub}
              </Text>
            </View>
            <ChevronRight size={18} color={colors.mutedForeground} />
          </Pressable>
          <Divider inset={62} />
          <Pressable
            onPress={() => void toggleTheme()}
            accessibilityRole="button"
            accessibilityLabel={t.more.darkMode}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
          >
            <IconTile
              icon={theme === 'dark' ? Moon : Sun}
              color={ACCENTS.notifications}
            />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>{t.more.darkMode}</Text>
              <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>
                {theme === 'dark' ? 'On' : 'Off'}
              </Text>
            </View>
          </Pressable>
          <Divider inset={62} />
          <Pressable
            onPress={handleNotifications}
            accessibilityRole="button"
            accessibilityLabel={t.more.notifications}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
          >
            <IconTile icon={Bell} color={ACCENTS.notifications} />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>{t.more.notifications}</Text>
              <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>
                {isPermissionGranted ? t.more.notificationsOn : t.more.notificationsOff}
              </Text>
            </View>
            <ChevronRight size={18} color={colors.mutedForeground} />
          </Pressable>
          <Divider inset={62} />
          <Pressable
            onPress={() => open('/settings/privacy')}
            accessibilityRole="button"
            accessibilityLabel={t.more.privacy}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
          >
            <IconTile icon={ShieldCheck} color={ACCENTS.privacy} />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>{t.more.privacy}</Text>
              <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>
                {t.more.privacySub}
              </Text>
            </View>
            <ChevronRight size={18} color={colors.mutedForeground} />
          </Pressable>
        </Card>

        <Pressable
          onPress={() => setConfirmSignOut(true)}
          accessibilityRole="button"
          accessibilityLabel={t.more.signOut}
          style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.7 }]}
        >
          <LogOut size={18} color={colors.destructive} />
          <Text style={[styles.signOutText, { color: colors.destructive }]}>{t.more.signOut}</Text>
        </Pressable>
      </ScrollView>

      <ConfirmModal
        visible={confirmSignOut}
        title={t.settings.signOutTitle}
        confirmText={t.more.signOut}
        cancelText={t.common.cancel}
        variant="destructive"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={async () => {
          setConfirmSignOut(false);
          try {
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
  content: { paddingTop: 8, paddingBottom: 24 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  card: { marginHorizontal: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 28,
    paddingVertical: 14,
  },
  signOutText: { fontSize: 16, fontWeight: '600' },
});
