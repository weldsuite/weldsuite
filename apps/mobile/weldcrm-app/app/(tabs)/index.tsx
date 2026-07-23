import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TrendingUp, TrendingDown, Users, UserPlus, DollarSign, Activity, Target } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import api, { type CrmDashboardStats, type CrmActivity } from '@/services/api';

export default function CrmDashboard() {
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [stats, setStats] = useState<CrmDashboardStats | null>(null);
  const [recentActivities, setRecentActivities] = useState<CrmActivity[]>([]);
  const [, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      const [statsResponse, activitiesResponse] = await Promise.all([
        api.getCrmDashboardStats(),
        api.getCrmRecentActivities(5),
      ]);

      if (statsResponse.success && statsResponse.data) {
        setStats(statsResponse.data);
      }

      if (activitiesResponse.success && activitiesResponse.data) {
        setRecentActivities(activitiesResponse.data);
      }
    } catch (error) {
      console.error('Error loading CRM dashboard:', error);
      toast.error('Failed to load dashboard data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadDashboardData();
  };

  const formatCurrency = (value: number): string => {
    if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`;
    return `$${value.toFixed(0)}`;
  };

  const formatNumber = (value: number): string => value.toLocaleString();

  const statCards = stats ? [
    {
      title: 'Total Customers',
      value: formatNumber(stats.totalCustomers),
      change: `${stats.customersChange >= 0 ? '+' : ''}${stats.customersChange}%`,
      isPositive: stats.customersChange >= 0,
      icon: Users,
      color: '#3B82F6',
    },
    {
      title: 'New Leads',
      value: formatNumber(stats.newLeads),
      change: `${stats.leadsChange >= 0 ? '+' : ''}${stats.leadsChange}%`,
      isPositive: stats.leadsChange >= 0,
      icon: UserPlus,
      color: '#10B981',
    },
    {
      title: 'Revenue',
      value: formatCurrency(stats.revenue),
      change: `${stats.revenueChange >= 0 ? '+' : ''}${stats.revenueChange}%`,
      isPositive: stats.revenueChange >= 0,
      icon: DollarSign,
      color: '#F59E0B',
    },
    {
      title: 'Conversion Rate',
      value: `${stats.conversionRate}%`,
      change: `${stats.conversionRateChange >= 0 ? '+' : ''}${stats.conversionRateChange}%`,
      isPositive: stats.conversionRateChange >= 0,
      icon: Target,
      color: '#8B5CF6',
    },
  ] : [];

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      contentContainerStyle={{ paddingTop: insets.top + 8 }}
    >
      <View style={styles.content}>
        <Text style={[styles.pageTitle, { color: colors.text }]}>CRM</Text>

        {/* Stats Grid */}
        <View style={styles.statsGrid}>
          {statCards.map((stat, index) => {
            const Icon = stat.icon;
            const TrendIcon = stat.isPositive ? TrendingUp : TrendingDown;
            const trendColor = stat.isPositive ? '#10B981' : '#EF4444';
            return (
              <View key={index} style={[styles.statCard, { backgroundColor: colors.background }]}>
                <View style={[styles.iconContainer, { backgroundColor: stat.color + '20' }]}>
                  <Icon size={24} color={stat.color} strokeWidth={2} />
                </View>
                <View style={styles.statContent}>
                  <Text style={[styles.statValue, { color: colors.text }]}>{stat.value}</Text>
                  <Text style={[styles.statTitle, { color: colors.muted }]}>{stat.title}</Text>
                  <View style={styles.changeContainer}>
                    <TrendIcon size={14} color={trendColor} strokeWidth={2} />
                    <Text style={[styles.changeText, { color: trendColor }]}>{stat.change}</Text>
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        {/* Recent Activities */}
        <View style={[styles.section, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.sectionHeader}>
            <Activity size={20} color={colors.text} strokeWidth={2} />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent Activities</Text>
          </View>
          <View style={styles.activitiesList}>
            {recentActivities.map((activity) => (
              <View key={activity.id} style={[styles.activityItem, { borderBottomColor: colors.divider }]}>
                <Text style={[styles.activityText, { color: colors.text }]}>{activity.text}</Text>
                <Text style={[styles.activityTime, { color: colors.muted }]}>{activity.time}</Text>
              </View>
            ))}
            {recentActivities.length === 0 && (
              <Text style={[styles.activityTime, { color: colors.muted }]}>No recent activity.</Text>
            )}
          </View>
        </View>

        {/* Quick Actions */}
        <View style={[styles.section, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Quick Actions</Text>
          <View style={styles.actionsGrid}>
            <TouchableOpacity style={[styles.actionButton, { borderColor: colors.divider }]}>
              <UserPlus size={20} color="#3B82F6" strokeWidth={2} />
              <Text style={[styles.actionText, { color: colors.text }]}>Add Lead</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionButton, { borderColor: colors.divider }]}>
              <Users size={20} color="#10B981" strokeWidth={2} />
              <Text style={[styles.actionText, { color: colors.text }]}>Add Customer</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionButton, { borderColor: colors.divider }]}>
              <Activity size={20} color="#F59E0B" strokeWidth={2} />
              <Text style={[styles.actionText, { color: colors.text }]}>Log Activity</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionButton, { borderColor: colors.divider }]}>
              <Target size={20} color="#8B5CF6" strokeWidth={2} />
              <Text style={[styles.actionText, { color: colors.text }]}>Create Deal</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  pageTitle: { fontSize: 34, fontWeight: '700', marginBottom: 16 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -8 },
  statCard: { width: '50%', padding: 8 },
  iconContainer: { width: 48, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  statContent: { marginBottom: 8 },
  statValue: { fontSize: 24, fontWeight: '700', marginBottom: 4 },
  statTitle: { fontSize: 13, marginBottom: 8 },
  changeContainer: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  changeText: { fontSize: 13, fontWeight: '600' },
  section: { marginTop: 24, borderRadius: 12, padding: 16, borderWidth: 1 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '600' },
  activitiesList: { gap: 12 },
  activityItem: { paddingBottom: 12, borderBottomWidth: 1 },
  activityText: { fontSize: 14, marginBottom: 4 },
  activityTime: { fontSize: 13 },
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, marginHorizontal: -6 },
  actionButton: { width: '50%', padding: 6, borderWidth: 1, borderRadius: 8, alignItems: 'center', paddingVertical: 16, marginBottom: 12 },
  actionText: { fontSize: 15, fontWeight: '500', marginTop: 8 },
});
