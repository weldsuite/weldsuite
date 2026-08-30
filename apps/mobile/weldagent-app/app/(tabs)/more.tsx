import React, { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Coins, Settings, Bell, ChevronRight, Building2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { IconTile } from '@/components/detail';
import { useI18n } from '@/lib/i18n';
import { useNotifications } from '@/contexts/NotificationContext';

export default function MoreScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { currentWorkspace } = useWorkspace();
  const { t } = useI18n();
  const { isPermissionGranted, requestPermissions } = useNotifications();

  const open = useCallback((route: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(route as never);
  }, [router]);

  const items = [
    {
      title: t.more.credits,
      subtitle: t.more.creditsSub,
      icon: Coins,
      color: ACCENTS.credits,
      route: '/credits',
    },
    {
      title: t.more.settings,
      subtitle: t.more.settingsSub,
      icon: Settings,
      color: ACCENTS.settings,
      route: '/settings',
    },
  ];

  return (
    <Screen header={<ScreenHeader title={t.more.title} />}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{t.more.workspace}</Text>
        <Card style={[styles.card, { borderRadius: 20 }]}>
          <View style={styles.row}>
            <IconTile icon={Building2} color={ACCENTS.settings} />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>
                {currentWorkspace?.name ?? t.common.dash}
              </Text>
            </View>
          </View>
        </Card>

        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{t.more.notifications}</Text>
        <Card style={[styles.card, { borderRadius: 20 }]}>
          <Pressable
            onPress={() => {
              if (!isPermissionGranted) void requestPermissions();
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
          >
            <IconTile icon={Bell} color={ACCENTS.chat} />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>{t.more.notifications}</Text>
              <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>
                {isPermissionGranted ? t.settings.pushOn : t.more.notificationsSub}
              </Text>
            </View>
          </Pressable>
        </Card>

        <Card style={[styles.card, { borderRadius: 20, marginTop: 20 }]}>
          {items.map((item, index) => (
            <React.Fragment key={item.route}>
              {index > 0 ? <Divider inset={62} /> : null}
              <Pressable
                onPress={() => open(item.route)}
                accessibilityRole="button"
                accessibilityLabel={item.title}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
              >
                <IconTile icon={item.icon} color={item.color} />
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: colors.text }]}>{item.title}</Text>
                  <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>{item.subtitle}</Text>
                </View>
                <ChevronRight size={18} color={colors.mutedForeground} />
              </Pressable>
            </React.Fragment>
          ))}
        </Card>
      </ScrollView>
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
  rowText: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
});
