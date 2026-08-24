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
} from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { IconTile } from '@/components/detail';

type MenuItem = {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
  route: string;
};

const SECTIONS: { title: string; items: MenuItem[] }[] = [
  {
    title: 'Financial',
    items: [
      {
        title: 'Bank accounts',
        subtitle: 'Balances and transactions',
        icon: Landmark,
        color: ACCENTS.banking,
        route: '/bank',
      },
      {
        title: 'Reconciliation',
        subtitle: 'Match bank transactions',
        icon: GitMerge,
        color: ACCENTS.reconciliation,
        route: '/reconciliation',
      },
      {
        title: 'VAT returns',
        subtitle: 'Review and file',
        icon: FileCheck,
        color: ACCENTS.vat,
        route: '/vat',
      },
    ],
  },
  {
    title: 'Reports',
    items: [
      {
        title: 'Profit & loss',
        subtitle: 'Revenue and expense overview',
        icon: TrendingUp,
        color: ACCENTS.profitLoss,
        route: '/reports/profit-loss',
      },
      {
        title: 'Balance sheet',
        subtitle: 'Assets, liabilities and equity',
        icon: Scale,
        color: ACCENTS.balanceSheet,
        route: '/reports/balance-sheet',
      },
    ],
  },
  {
    title: 'Other',
    items: [
      {
        title: 'Contacts',
        subtitle: 'Customers and suppliers',
        icon: Users,
        color: ACCENTS.contacts,
        route: '/contacts',
      },
      {
        title: 'Settings',
        subtitle: 'App and company preferences',
        icon: Settings,
        color: ACCENTS.settings,
        route: '/settings',
      },
    ],
  },
];

export default function MoreScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const open = useCallback(
    (route: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  return (
    <Screen header={<ScreenHeader title="More" />}>
      <ScrollView contentContainerStyle={styles.content}>
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
