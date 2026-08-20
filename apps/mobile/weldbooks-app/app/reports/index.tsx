/**
 * Report index.
 */

import React, { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { TrendingUp, Scale, ChevronRight } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { IconTile } from '@/components/detail';

const REPORTS = [
  {
    title: 'Profit & loss',
    subtitle: 'Revenue, expenses and margin',
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
];

export default function ReportsScreen() {
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
    <Screen header={<ScreenHeader title="Reports" showBack />}>
      <ScrollView contentContainerStyle={styles.content}>
        <Card style={styles.card}>
          {REPORTS.map((report, index) => (
            <React.Fragment key={report.route}>
              {index > 0 ? <Divider inset={62} /> : null}
              <Pressable
                onPress={() => open(report.route)}
                accessibilityRole="button"
                accessibilityLabel={report.title}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
              >
                <IconTile icon={report.icon} color={report.color} />
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: colors.text }]}>{report.title}</Text>
                  <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]}>
                    {report.subtitle}
                  </Text>
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
  content: { paddingTop: 12, paddingBottom: 32 },
  card: { marginHorizontal: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
});
