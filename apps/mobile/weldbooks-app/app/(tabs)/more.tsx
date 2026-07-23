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

type MenuItem = {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  iconColor: string;
  iconBg: string;
  route: string;
};

type MenuSection = {
  title: string;
  items: MenuItem[];
};

const SECTIONS: MenuSection[] = [
  {
    title: 'Financial',
    items: [
      {
        title: 'Bank Accounts',
        subtitle: 'Manage connected bank accounts',
        icon: Landmark,
        iconColor: '#3B82F6',
        iconBg: 'rgba(59,130,246,0.12)',
        route: '/bank',
      },
      {
        title: 'Reconciliation',
        subtitle: 'Match bank transactions',
        icon: GitMerge,
        iconColor: '#8B5CF6',
        iconBg: 'rgba(139,92,246,0.12)',
        route: '/reconciliation',
      },
      {
        title: 'VAT Returns',
        subtitle: 'View and submit VAT filings',
        icon: FileCheck,
        iconColor: '#10B981',
        iconBg: 'rgba(16,185,129,0.12)',
        route: '/vat',
      },
    ],
  },
  {
    title: 'Reports',
    items: [
      {
        title: 'Profit & Loss',
        subtitle: 'Revenue and expense overview',
        icon: TrendingUp,
        iconColor: '#F59E0B',
        iconBg: 'rgba(245,158,11,0.12)',
        route: '/reports/profit-loss',
      },
      {
        title: 'Balance Sheet',
        subtitle: 'Assets, liabilities, and equity',
        icon: Scale,
        iconColor: '#EC4899',
        iconBg: 'rgba(236,72,153,0.12)',
        route: '/reports/balance-sheet',
      },
    ],
  },
  {
    title: 'Other',
    items: [
      {
        title: 'Contacts',
        subtitle: 'Customers and vendors',
        icon: Users,
        iconColor: '#06B6D4',
        iconBg: 'rgba(6,182,212,0.12)',
        route: '/contacts',
      },
      {
        title: 'Settings',
        subtitle: 'App and workspace preferences',
        icon: Settings,
        iconColor: '#6B7280',
        iconBg: 'rgba(107,114,128,0.12)',
        route: '/settings',
      },
    ],
  },
];

export default function MoreScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  const handlePress = (route: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(route as any);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>More</Text>
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {SECTIONS.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.muted }]}>
              {section.title.toUpperCase()}
            </Text>
            <View style={[styles.sectionCard, { backgroundColor: colors.cardBackground }]}>
              {section.items.map((item, index) => {
                const Icon = item.icon;
                const isLast = index === section.items.length - 1;
                return (
                  <React.Fragment key={item.route}>
                    <TouchableOpacity
                      style={styles.menuItem}
                      onPress={() => handlePress(item.route)}
                      activeOpacity={0.6}
                    >
                      <View style={[styles.iconCircle, { backgroundColor: item.iconBg }]}>
                        <Icon size={20} color={item.iconColor} />
                      </View>
                      <View style={styles.menuItemContent}>
                        <Text style={[styles.menuItemTitle, { color: colors.text }]}>
                          {item.title}
                        </Text>
                        <Text style={[styles.menuItemSubtitle, { color: colors.muted }]}>
                          {item.subtitle}
                        </Text>
                      </View>
                      <ChevronRight size={18} color={colors.muted} />
                    </TouchableOpacity>
                    {!isLast && (
                      <View style={[styles.divider, { backgroundColor: colors.divider }]} />
                    )}
                  </React.Fragment>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionCard: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuItemContent: {
    flex: 1,
  },
  menuItemTitle: {
    fontSize: 16,
    fontWeight: '500',
  },
  menuItemSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 68,
  },
});
