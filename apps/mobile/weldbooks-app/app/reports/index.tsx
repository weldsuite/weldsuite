import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { TrendingUp, Scale, ChevronLeft, ChevronRight } from 'lucide-react-native';

type ReportCard = {
  title: string;
  description: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  iconColor: string;
  iconBg: string;
  route: string;
};

const REPORTS: ReportCard[] = [
  {
    title: 'Profit & Loss',
    description:
      'View your revenue, expenses, and net profit over a selected period. Track your business performance at a glance.',
    icon: TrendingUp,
    iconColor: '#F59E0B',
    iconBg: 'rgba(245,158,11,0.12)',
    route: '/reports/profit-loss',
  },
  {
    title: 'Balance Sheet',
    description:
      'See a snapshot of your assets, liabilities, and equity. Understand your financial position at any point in time.',
    icon: Scale,
    iconColor: '#EC4899',
    iconBg: 'rgba(236,72,153,0.12)',
    route: '/reports/balance-sheet',
  },
];

export default function ReportsMenuScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  const handlePress = (route: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(route as any);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Reports</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {REPORTS.map((report) => {
          const Icon = report.icon;
          return (
            <TouchableOpacity
              key={report.route}
              style={[styles.card, { backgroundColor: colors.cardBackground }]}
              onPress={() => handlePress(report.route)}
              activeOpacity={0.6}
            >
              <View style={styles.cardHeader}>
                <View style={[styles.iconCircle, { backgroundColor: report.iconBg }]}>
                  <Icon size={24} color={report.iconColor} />
                </View>
                <ChevronRight size={20} color={colors.muted} />
              </View>
              <Text style={[styles.cardTitle, { color: colors.text }]}>{report.title}</Text>
              <Text style={[styles.cardDescription, { color: colors.muted }]}>
                {report.description}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 32,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 16,
  },
  card: {
    borderRadius: 16,
    padding: 20,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  cardDescription: {
    fontSize: 14,
    lineHeight: 20,
  },
});
