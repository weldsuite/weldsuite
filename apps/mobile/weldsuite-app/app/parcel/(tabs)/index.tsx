import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  View,
  Text,
  RefreshControl,
  Dimensions,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { router } from 'expo-router';
import { Package, Truck, Clock, CheckCircle, AlertCircle, TrendingUp, ArrowRight, BarChart3 } from 'lucide-react-native';
import api from '@/services/api';
import { useToast } from '@/contexts/ToastContext';

interface DashboardStats {
  totalParcels: number;
  inTransit: number;
  delivered: number;
  pending: number;
  todayDeliveries: number;
  scheduledPickups: number;
}

interface TodayOverview {
  todayDeliveries: number;
  percentageChange: number;
  outForDelivery: number;
  delayed: number;
}

interface RecentParcel {
  id: string;
  trackingNumber: string;
  recipient: string;
  status: string;
  location: string;
  time: string;
}

export default function ParcelDashboard() {
  const { colors } = useTheme();
  const toast = useToast();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [todayOverview, setTodayOverview] = useState<TodayOverview | null>(null);
  const [recentParcels, setRecentParcels] = useState<RecentParcel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Detect iPad
  const { width } = Dimensions.get('window');
  const isTablet = width >= 768;

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setLoading(true);

      // Fetch all dashboard data in parallel
      const [statsResponse, recentResponse, overviewResponse] = await Promise.all([
        api.getParcelDashboardStats(),
        api.getRecentParcels(5),
        api.getParcelTodayOverview(),
      ]);

      if (statsResponse.success && statsResponse.data) {
        setStats(statsResponse.data);
      }

      if (recentResponse.success && recentResponse.data) {
        setRecentParcels(recentResponse.data);
      }

      if (overviewResponse.success && overviewResponse.data) {
        setTodayOverview(overviewResponse.data);
      }
    } catch (error) {
      console.error('Error loading dashboard:', error);
      toast.error('Failed to load parcel dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    loadDashboardData();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'delivered': return '#10B981';
      case 'in-transit': 
      case 'out-for-delivery': return '#3B82F6';
      case 'pending': return '#F59E0B';
      case 'delayed': return '#EF4444';
      default: return colors.muted;
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: '#FFFFFF' }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: '#FFFFFF' }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Dashboard</Text>
        <TouchableOpacity style={styles.statsButton}>
          <BarChart3 size={20} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
      </View>

      <ScrollView 
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        contentContainerStyle={isTablet && { paddingHorizontal: 20 }}
      >
        {/* Overview Cards */}
        <View style={[styles.overviewSection, isTablet && styles.overviewSectionTablet]}>
          <View style={[styles.primaryCard, isTablet && styles.primaryCardTablet]}>
            <View style={styles.primaryCardHeader}>
              <View>
                <Text style={[styles.primaryCardLabel, { color: colors.muted }]}>Today's Deliveries</Text>
                <Text style={[styles.primaryCardValue, { color: colors.text }]}>{stats?.todayDeliveries}</Text>
              </View>
              <View style={styles.primaryCardIcon}>
                <TrendingUp size={20} color="#10B981" strokeWidth={2} />
              </View>
            </View>
            <View style={styles.primaryCardFooter}>
              <Text style={[styles.primaryCardFooterText, { color: todayOverview && todayOverview.percentageChange >= 0 ? '#10B981' : '#EF4444' }]}>
                {todayOverview ? `${todayOverview.percentageChange >= 0 ? '+' : ''}${todayOverview.percentageChange}% from yesterday` : '—'}
              </Text>
            </View>
          </View>

          <View style={[styles.statsRow, isTablet && styles.statsRowTablet]}>
            <View style={styles.statCard}>
              <View style={styles.statCardIcon}>
                <Truck size={16} color="#3B82F6" strokeWidth={2} />
              </View>
              <Text style={[styles.statCardValue, { color: colors.text }]}>{stats?.inTransit}</Text>
              <Text style={[styles.statCardLabel, { color: colors.muted }]}>In Transit</Text>
            </View>

            <View style={styles.statCard}>
              <View style={styles.statCardIcon}>
                <CheckCircle size={16} color="#10B981" strokeWidth={2} />
              </View>
              <Text style={[styles.statCardValue, { color: colors.text }]}>{stats?.delivered}</Text>
              <Text style={[styles.statCardLabel, { color: colors.muted }]}>Delivered</Text>
            </View>

            <View style={styles.statCard}>
              <View style={styles.statCardIcon}>
                <Clock size={16} color="#F59E0B" strokeWidth={2} />
              </View>
              <Text style={[styles.statCardValue, { color: colors.text }]}>{stats?.pending}</Text>
              <Text style={[styles.statCardLabel, { color: colors.muted }]}>Pending</Text>
            </View>
          </View>
        </View>

        {/* Recent Activity */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent Activity</Text>
            <TouchableOpacity 
              onPress={() => router.push('/parcel/(tabs)/parcels' as any)}
              style={styles.viewAllButton}
            >
              <Text style={[styles.viewAllText, { color: colors.muted }]}>View all</Text>
              <ArrowRight size={14} color={colors.muted} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <View style={styles.activityList}>
            {recentParcels.map((parcel, index) => (
              <TouchableOpacity
                key={parcel.id}
                style={[
                  styles.activityItem,
                  index !== recentParcels.length - 1 && styles.activityItemBorder
                ]}
                activeOpacity={0.7}
              >
                <View style={styles.activityLeft}>
                  <View style={[styles.statusDot, { backgroundColor: getStatusColor(parcel.status) }]} />
                  <View style={styles.activityInfo}>
                    <Text style={[styles.trackingNumber, { color: colors.text }]}>
                      {parcel.trackingNumber}
                    </Text>
                    <Text style={[styles.recipientName, { color: colors.muted }]}>
                      {parcel.recipient} · {parcel.time}
                    </Text>
                  </View>
                </View>
                <ArrowRight size={16} color={colors.muted} strokeWidth={2} />
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Quick Stats */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Today's Overview</Text>
          <View style={styles.quickStatsGrid}>
            <View style={styles.quickStatCard}>
              <Text style={[styles.quickStatValue, { color: colors.text }]}>
                {stats?.scheduledPickups}
              </Text>
              <Text style={[styles.quickStatLabel, { color: colors.muted }]}>
                Scheduled Pickups
              </Text>
            </View>
            <View style={[styles.quickStatCard, styles.quickStatCardBorder]}>
              <Text style={[styles.quickStatValue, { color: colors.text }]}>
                {stats?.totalParcels}
              </Text>
              <Text style={[styles.quickStatLabel, { color: colors.muted }]}>
                Total Parcels
              </Text>
            </View>
          </View>
        </View>

        {/* Quick Actions */}
        <View style={[styles.section, { marginBottom: 32 }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Quick Actions</Text>
          <View style={styles.actionButtons}>
            <TouchableOpacity 
              style={styles.actionButton}
              onPress={() => router.push('/parcel/(tabs)/scan' as any)}
            >
              <Text style={[styles.actionButtonText, { color: colors.text }]}>Scan Parcel</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.actionButton}
              onPress={() => router.push('/parcel/add-parcel' as any)}
            >
              <Text style={[styles.actionButtonText, { color: colors.text }]}>Add Parcel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  statsButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overviewSection: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 32,
  },
  primaryCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  primaryCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  primaryCardLabel: {
    fontSize: 13,
    marginBottom: 4,
  },
  primaryCardValue: {
    fontSize: 32,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
  primaryCardIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryCardFooter: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  primaryCardFooterText: {
    fontSize: 12,
    fontWeight: '500',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  statCardIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  statCardValue: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 2,
  },
  statCardLabel: {
    fontSize: 11,
  },
  section: {
    paddingHorizontal: 24,
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  viewAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  viewAllText: {
    fontSize: 13,
  },
  activityList: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 4,
  },
  activityItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  activityItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  activityLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  activityInfo: {
    gap: 2,
  },
  trackingNumber: {
    fontSize: 14,
    fontWeight: '500',
  },
  recipientName: {
    fontSize: 12,
  },
  quickStatsGrid: {
    flexDirection: 'row',
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    overflow: 'hidden',
  },
  quickStatCard: {
    flex: 1,
    padding: 16,
    alignItems: 'center',
  },
  quickStatCardBorder: {
    borderLeftWidth: 1,
    borderLeftColor: '#E5E7EB',
  },
  quickStatValue: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 4,
  },
  quickStatLabel: {
    fontSize: 11,
    textAlign: 'center',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 14,
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    alignItems: 'center',
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  // Tablet styles
  overviewSectionTablet: {
    flexDirection: 'row',
    gap: 20,
    paddingHorizontal: 32,
  },
  primaryCardTablet: {
    flex: 1,
  },
  statsRowTablet: {
    flex: 1,
    flexDirection: 'column',
    gap: 12,
  },
});