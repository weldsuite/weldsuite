/**
 * Everything that doesn't earn a tab. Section grouping and accent colours match
 * the platform's WeldBooks sidebar so the same feature sits under the same
 * label and colour on both surfaces.
 */

import React, { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  Landmark,
  GitMerge,
  FileCheck,
  TrendingUp,
  Scale,
  Users,
  Settings,
  ChevronRight,
  Building2,
} from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { IconTile } from '@/components/detail';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { useI18n } from '@/lib/i18n';

type MenuItem = {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
  route: string;
};

export default function MoreScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { activeEntity, canSwitch, openSwitcher } = useAccountingEntity();
  const { t, format } = useI18n();

  const SECTIONS: { title: string; items: MenuItem[] }[] = [
    {
      title: t.more.financial,
      items: [
        {
          title: t.more.bankAccounts,
          subtitle: t.more.bankAccountsSub,
          icon: Landmark,
          color: ACCENTS.banking,
          route: '/bank',
        },
        {
          title: t.more.reconciliation,
          subtitle: t.more.reconciliationSub,
          icon: GitMerge,
          color: ACCENTS.reconciliation,
          route: '/reconciliation',
        },
        {
          title: t.more.vatReturns,
          subtitle: t.more.vatReturnsSub,
          icon: FileCheck,
          color: ACCENTS.vat,
          route: '/vat',
        },
      ],
    },
    {
      title: t.more.reports,
      items: [
        {
          title: t.more.profitLoss,
          subtitle: t.more.profitLossSub,
          icon: TrendingUp,
          color: ACCENTS.profitLoss,
          route: '/reports/profit-loss',
        },
        {
          title: t.more.balanceSheet,
          subtitle: t.more.balanceSheetSub,
          icon: Scale,
          color: ACCENTS.balanceSheet,
          route: '/reports/balance-sheet',
        },
      ],
    },
    {
      title: t.more.other,
      items: [
        {
          title: t.more.contacts,
          subtitle: t.more.contactsSub,
          icon: Users,
          color: ACCENTS.contacts,
          route: '/contacts',
        },
        {
          title: t.more.settings,
          subtitle: t.more.settingsSub,
          icon: Settings,
          color: ACCENTS.settings,
          route: '/settings',
        },
      ],
    },
  ];

  const open = useCallback(
    (route: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  return (
    <Screen header={<ScreenHeader title={t.more.title} />}>
      <ScrollView contentContainerStyle={styles.content}>
        {activeEntity ? (
          <View>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
              {t.more.administration}
            </Text>
            <Card style={[styles.card, { borderRadius: 20 }]}>
              <Pressable
                onPress={canSwitch ? openSwitcher : undefined}
                disabled={!canSwitch}
                accessibilityRole="button"
                accessibilityLabel={
                  canSwitch
                    ? format(t.screen.switchAdministration, { name: activeEntity.name })
                    : activeEntity.name
                }
                style={({ pressed }) => [
                  styles.row,
                  canSwitch && pressed && { backgroundColor: colors.pressed },
                ]}
              >
                <IconTile icon={Building2} color={ACCENTS.settings} />
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: colors.text }]}>{activeEntity.name}</Text>
                  <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>
                    {canSwitch
                      ? `${activeEntity.jurisdictionCode} · ${activeEntity.baseCurrency} · ${t.more.tapToSwitch}`
                      : `${activeEntity.jurisdictionCode} · ${activeEntity.baseCurrency}`}
                  </Text>
                </View>
                {canSwitch ? <ChevronRight size={18} color={colors.mutedForeground} /> : null}
              </Pressable>
            </Card>
          </View>
        ) : null}
        {SECTIONS.map((section) => (
          <View key={section.title}>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
              {section.title}
            </Text>
            <Card style={[styles.card, { borderRadius: 20 }]}>
              {section.items.map((item, index) => (
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
                      <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>
                        {item.subtitle}
                      </Text>
                    </View>
                    <ChevronRight size={18} color={colors.mutedForeground} />
                  </Pressable>
                </React.Fragment>
              ))}
            </Card>
          </View>
        ))}
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
