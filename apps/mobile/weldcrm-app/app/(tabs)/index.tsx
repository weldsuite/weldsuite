import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useObserve } from 'expo-observe';
import {
  Activity,
  Building2,
  CheckSquare,
  DollarSign,
  FileText,
  Mail,
  Phone,
  Target,
  Trophy,
  UserPlus,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { api, type CrmActivity, type CrmDashboardStats } from '@/services/api';
import { hideAppSplash } from '@/utils/splash';
import { interpolate, plural, useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';

interface StatCard {
  key: string;
  title: string;
  value: string;
  note?: string;
  icon: LucideIcon;
  color: string;
  onPress?: () => void;
}

interface QuickAction {
  key: string;
  label: string;
  icon: LucideIcon;
  color: string;
  onPress: () => void;
}

const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  call: Phone,
  email: Mail,
  meeting: Video,
  note: FileText,
  task: CheckSquare,
};

export default function CrmDashboard() {
  const { markInteractive } = useObserve();
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [stats, setStats] = useState<CrmDashboardStats | null>(null);
  const [recentActivities, setRecentActivities] = useState<CrmActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loadedOnce = useRef(false);

  const loadDashboardData = useCallback(
    async (silent = false) => {
      const [statsResponse, activitiesResponse] = await Promise.all([
        api.getCrmDashboardStats(),
        api.getActivities({ limit: 6 }),
      ]);

      if (statsResponse.success && statsResponse.data) setStats(statsResponse.data);
      if (activitiesResponse.success && activitiesResponse.data) setRecentActivities(activitiesResponse.data.items);
      if (!silent && !statsResponse.success) toast.error(t.home.loadFailed);

      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
    },
    [t, toast],
  );

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  // Coming back from a create screen: refresh the figures quietly.
  useFocusEffect(
    useCallback(() => {
      if (loadedOnce.current) void loadDashboardData(true);
    }, [loadDashboardData]),
  );

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  const handleRefresh = () => {
    setRefreshing(true);
    void loadDashboardData();
  };

  const formatNumber = (value: number): string => value.toLocaleString(intlLocale);

  const revenueNote = stats
    ? [
        stats.revenueExcluded > 0 ? plural(stats.revenueExcluded, t.home.revenueExcluded) : null,
        stats.revenuePartial ? interpolate(t.home.revenuePartial, { count: formatNumber(stats.revenueDealsRead) }) : null,
      ]
        .filter(Boolean)
        .join('. ')
    : '';

  const statCards: StatCard[] = stats
    ? [
        {
          key: 'people',
          title: t.home.kpi.people,
          value: formatNumber(stats.totalPeople),
          icon: Users,
          color: '#3B82F6',
          onPress: () => router.navigate({ pathname: '/contacts', params: { segment: 'people' } }),
        },
        {
          key: 'companies',
          title: t.home.kpi.companies,
          value: formatNumber(stats.totalCompanies),
          icon: Building2,
          color: '#6366F1',
          onPress: () => router.navigate({ pathname: '/contacts', params: { segment: 'companies' } }),
        },
        {
          key: 'leads',
          title: t.home.kpi.leads,
          value: formatNumber(stats.leads),
          icon: UserPlus,
          color: '#10B981',
          onPress: () => router.navigate({ pathname: '/contacts', params: { filter: 'leads' } }),
        },
        {
          key: 'open',
          title: t.home.kpi.openDeals,
          value: formatNumber(stats.openDeals),
          icon: Target,
          color: '#8B5CF6',
          onPress: () => router.navigate('/deals'),
        },
        {
          key: 'won',
          title: t.home.kpi.wonDeals,
          value: formatNumber(stats.wonDeals),
          icon: Trophy,
          color: '#EC4899',
        },
        {
          key: 'revenue',
          title: t.home.kpi.revenue,
          value: formatMoney(stats.revenue, stats.currency, intlLocale, { compact: true }),
          note: revenueNote || undefined,
          icon: DollarSign,
          color: '#F59E0B',
        },
      ]
    : [];

  const quickActions: QuickAction[] = [
    { key: 'person', label: t.home.actions.addPerson, icon: Users, color: '#3B82F6', onPress: () => router.push('/person/new') },
    { key: 'company', label: t.home.actions.addCompany, icon: Building2, color: '#6366F1', onPress: () => router.push('/company/new') },
    { key: 'activity', label: t.home.actions.logActivity, icon: Activity, color: '#F59E0B', onPress: () => router.push('/activity/new') },
    {
      key: 'note',
      label: t.home.actions.newNote,
      icon: FileText,
      color: '#10B981',
      onPress: () => router.push({ pathname: '/note/[id]', params: { id: 'new' } }),
    },
    {
      key: 'deal',
      label: t.home.actions.createDeal,
      icon: Target,
      color: '#8B5CF6',
      onPress: () => router.navigate({ pathname: '/deals', params: { new: '1' } }),
    },
    {
      key: 'task',
      label: t.home.actions.newTask,
      icon: CheckSquare,
      color: '#EF4444',
      onPress: () => router.navigate({ pathname: '/tasks', params: { new: '1' } }),
    },
  ];

  const formatActivityTime = (iso: string) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return t.common.dash;
    return date.toLocaleString(intlLocale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  const openActivity = (activity: CrmActivity) => {
    if (activity.type === 'note') {
      router.push({ pathname: '/note/[id]', params: { id: activity.id } });
    } else if (activity.record) {
      router.push({
        pathname: activity.record.kind === 'company' ? '/company/[id]' : '/person/[id]',
        params: { id: activity.record.id, name: activity.record.name ?? '', tab: 'activity' },
      });
    }
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      contentContainerStyle={{ paddingTop: insets.top + 8 }}
    >
      <View style={styles.content}>
        <Text style={[styles.pageTitle, { color: colors.text }]} accessibilityRole="header">
          {t.home.title}
        </Text>

        {loading ? (
          <ActivityIndicator style={styles.loading} size="large" color={colors.text} accessibilityLabel={t.common.loading} />
        ) : (
          <View style={styles.statsGrid}>
            {statCards.map((stat) => {
              const Icon = stat.icon;
              return (
                <TouchableOpacity
                  key={stat.key}
                  style={styles.statCard}
                  onPress={stat.onPress}
                  disabled={!stat.onPress}
                  accessibilityRole={stat.onPress ? 'button' : undefined}
                  accessibilityLabel={`${stat.title}: ${stat.value}`}
                >
                  <View style={[styles.iconContainer, { backgroundColor: stat.color + '20' }]}>
                    <Icon size={24} color={stat.color} strokeWidth={2} />
                  </View>
                  <Text style={[styles.statValue, { color: colors.text }]}>{stat.value}</Text>
                  <Text style={[styles.statTitle, { color: colors.muted }]}>{stat.title}</Text>
                  {stat.note ? <Text style={[styles.statNote, { color: colors.muted }]}>{stat.note}</Text> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Quick Actions */}
        <View style={[styles.section, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t.home.quickActions}</Text>
          <View style={styles.actionsGrid}>
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <View key={action.key} style={styles.actionCell}>
                  <TouchableOpacity
                    style={[styles.actionButton, { borderColor: colors.divider }]}
                    onPress={action.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                  >
                    <Icon size={20} color={action.color} strokeWidth={2} />
                    <Text style={[styles.actionText, { color: colors.text }]}>{action.label}</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        </View>

        {/* Recent Activities */}
        <View style={[styles.section, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.sectionHeader}>
            <Activity size={20} color={colors.text} strokeWidth={2} />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t.home.recentActivities}</Text>
          </View>
          <View style={styles.activitiesList}>
            {loading ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              recentActivities.map((activity) => {
                const Icon = ACTIVITY_ICONS[activity.type] ?? Activity;
                return (
                  <TouchableOpacity
                    key={activity.id}
                    style={[styles.activityItem, { borderBottomColor: colors.divider }]}
                    onPress={() => openActivity(activity)}
                    disabled={activity.type !== 'note' && !activity.record}
                    accessibilityRole="button"
                    accessibilityLabel={activity.subject}
                  >
                    <Icon size={16} color={colors.muted} />
                    <View style={styles.activityText}>
                      <Text style={[styles.activityTitle, { color: colors.text }]} numberOfLines={1}>
                        {activity.subject}
                      </Text>
                      <Text style={[styles.activityTime, { color: colors.muted }]} numberOfLines={1}>
                        {[activity.record?.name, formatActivityTime(activity.createdAt)].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
            {!loading && recentActivities.length === 0 && (
              <Text style={[styles.activityTime, { color: colors.muted }]}>{t.home.noActivity}</Text>
            )}
          </View>
        </View>
        <View style={{ height: 24 }} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  pageTitle: { fontSize: 34, fontWeight: '700', marginBottom: 16 },
  loading: { paddingVertical: 48 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -8 },
  statCard: { width: '50%', padding: 8, marginBottom: 8 },
  iconContainer: { width: 48, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  statValue: { fontSize: 24, fontWeight: '700', marginBottom: 4 },
  statTitle: { fontSize: 13 },
  statNote: { fontSize: 11, marginTop: 6 },
  section: { marginTop: 24, borderRadius: 12, padding: 16, borderWidth: 1 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '600' },
  activitiesList: { gap: 12 },
  activityItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 12, borderBottomWidth: 1 },
  activityText: { flex: 1 },
  activityTitle: { fontSize: 14, marginBottom: 4 },
  activityTime: { fontSize: 13 },
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, marginHorizontal: -6 },
  actionCell: { width: '50%', padding: 6 },
  actionButton: { borderWidth: 1, borderRadius: 8, alignItems: 'center', paddingVertical: 16, paddingHorizontal: 8 },
  actionText: { fontSize: 14, fontWeight: '500', marginTop: 8, textAlign: 'center' },
});
