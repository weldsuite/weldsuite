import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  View,
  Text,
  TextInput,
  ScrollView,
} from 'react-native';
import { Globe, RefreshCcw, AlertTriangle, Clock, Search } from 'lucide-react-native';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';
import api from '@/services/api';

interface Domain {
  id: string;
  name: string;
  tld: string;
  fullDomain: string;
  status: 'active' | 'pending' | 'expired' | 'transferred';
  registrar: string;
  autoRenew: boolean;
  expiresAt: string;
  createdAt: string;
}

const DOMAIN_STATUS_CONFIG = {
  active: {
    label: 'Active',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
  },
  pending: {
    label: 'Pending',
    color: '#854D0E',
    backgroundColor: '#FEF9C3',
  },
  expired: {
    label: 'Expired',
    color: '#991B1B',
    backgroundColor: '#FEE2E2',
  },
  transferred: {
    label: 'Transferred',
    color: '#1E40AF',
    backgroundColor: '#DBEAFE',
  },
};

// Sample data for development
const SAMPLE_DOMAINS: Domain[] = [
  {
    id: '1',
    name: 'example',
    tld: 'com',
    fullDomain: 'example.com',
    status: 'active',
    registrar: 'WeldHost',
    autoRenew: true,
    expiresAt: '2025-12-15T00:00:00Z',
    createdAt: '2023-12-15T00:00:00Z',
  },
  {
    id: '2',
    name: 'mystore',
    tld: 'nl',
    fullDomain: 'mystore.nl',
    status: 'active',
    registrar: 'WeldHost',
    autoRenew: true,
    expiresAt: '2025-06-20T00:00:00Z',
    createdAt: '2024-06-20T00:00:00Z',
  },
  {
    id: '3',
    name: 'testsite',
    tld: 'io',
    fullDomain: 'testsite.io',
    status: 'pending',
    registrar: 'WeldHost',
    autoRenew: false,
    expiresAt: '2025-03-01T00:00:00Z',
    createdAt: '2024-03-01T00:00:00Z',
  },
];

export default function DomainsScreen() {
  const { colors } = useTheme();
  const showMiniSidebar = useShouldShowMiniSidebar();
  const { onScroll, resetHeader } = useCollapsibleHeader();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [filteredDomains, setFilteredDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Reset header when tab becomes active
  useEffect(() => {
    resetHeader();
  }, [resetHeader]);

  useEffect(() => {
    loadDomains();
  }, []);

  useEffect(() => {
    filterDomains();
  }, [selectedStatus, searchQuery, domains]);

  const loadDomains = async () => {
    try {
      setLoading(true);
      // TODO: Replace with actual API call
      // const response = await api.getDomains({ limit: 100 });
      // For now, use sample data
      await new Promise(resolve => setTimeout(resolve, 500));
      setDomains(SAMPLE_DOMAINS);
      setFilteredDomains(SAMPLE_DOMAINS);
    } catch (error) {
      console.error('Error loading domains:', error);
      setDomains([]);
      setFilteredDomains([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filterDomains = () => {
    let filtered = [...domains];

    // Status filter
    if (selectedStatus) {
      filtered = filtered.filter((domain) => domain.status === selectedStatus);
    }

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter((domain) =>
        domain.fullDomain.toLowerCase().includes(searchQuery.toLowerCase()) ||
        domain.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    setFilteredDomains(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadDomains();
  };

  const handleDomainPress = (domain: Domain) => {
    router.push(`/host/domain/${domain.id}` as any);
  };

  const getDaysUntilExpiry = (expiresAt: string) => {
    const expiryDate = new Date(expiresAt);
    const now = new Date();
    return Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  };

  const formatExpiryDate = (expiresAt: string) => {
    const date = new Date(expiresAt);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All', count: domains.length },
      { key: 'active', label: 'Active', count: domains.filter(d => d.status === 'active').length },
      { key: 'pending', label: 'Pending', count: domains.filter(d => d.status === 'pending').length },
      { key: 'expired', label: 'Expired', count: domains.filter(d => d.status === 'expired').length },
    ];

    return (
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {statusOptions.map((item) => (
            <TouchableOpacity
              key={item.key || 'all'}
              style={[
                styles.filterButton,
                {
                  backgroundColor: selectedStatus === item.key ? colors.text : colors.background,
                  borderColor: selectedStatus === item.key ? colors.text : colors.buttonBorder,
                }
              ]}
              onPress={() => setSelectedStatus(item.key)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  { color: selectedStatus === item.key ? colors.background : colors.text }
                ]}
              >
                {item.label}
              </Text>
              <Text
                style={[
                  styles.filterButtonCount,
                  { color: selectedStatus === item.key ? colors.background : colors.muted }
                ]}
              >
                ({item.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderDomain = ({ item }: { item: Domain }) => {
    const statusConfig = DOMAIN_STATUS_CONFIG[item.status];
    const daysUntilExpiry = getDaysUntilExpiry(item.expiresAt);
    const isExpiringSoon = daysUntilExpiry > 0 && daysUntilExpiry < 30;
    const isExpired = daysUntilExpiry < 0;

    return (
      <TouchableOpacity
        style={[styles.domainItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleDomainPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.domainContent}>
          <View style={[styles.domainIcon, { backgroundColor: '#F3F4F6' }]}>
            <Globe size={20} color="#6B7280" strokeWidth={2} />
          </View>
          <View style={styles.domainLeft}>
            <View style={styles.domainNameRow}>
              <Text style={[styles.domainName, { color: colors.text }]}>{item.fullDomain}</Text>
              {item.autoRenew && (
                <View style={styles.autoRenewBadge}>
                  <RefreshCcw size={10} color="#6B7280" strokeWidth={2} />
                </View>
              )}
            </View>
            <Text style={[styles.domainRegistrar, { color: colors.muted }]}>
              {item.registrar} · .{item.tld}
            </Text>
          </View>
          <View style={styles.domainRight}>
            <View style={styles.expiryInfo}>
              {isExpired ? (
                <View style={styles.expiryWarning}>
                  <AlertTriangle size={12} color="#DC2626" strokeWidth={2} />
                  <Text style={[styles.expiryWarningText, { color: '#DC2626' }]}>Expired</Text>
                </View>
              ) : isExpiringSoon ? (
                <View style={styles.expiryWarning}>
                  <Clock size={12} color="#D97706" strokeWidth={2} />
                  <Text style={[styles.expiryWarningText, { color: '#D97706' }]}>{daysUntilExpiry}d left</Text>
                </View>
              ) : (
                <Text style={[styles.expiryDate, { color: colors.muted }]}>{formatExpiryDate(item.expiresAt)}</Text>
              )}
            </View>
            <View style={[styles.statusBadge, { backgroundColor: statusConfig.backgroundColor }]}>
              <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Globe size={48} color={colors.muted} strokeWidth={1.5} />
      <Text style={[styles.emptyTitle, { color: colors.text }]}>No domains found</Text>
      <Text style={[styles.emptyText, { color: colors.muted }]}>
        Register your first domain or add an external domain
      </Text>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading domains...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>My Domains ({filteredDomains.length})</Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search domains..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {renderStatusFilter()}

      <FlatList
        data={filteredDomains}
        renderItem={renderDomain}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        onScroll={!showMiniSidebar ? onScroll : undefined}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  filterContainer: {
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
  },
  filterList: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  filterButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterButtonCount: {
    fontSize: 13,
    fontWeight: '400',
  },
  listContainer: {
    paddingHorizontal: 0,
  },
  domainItem: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  domainContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  domainIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  domainLeft: {
    flex: 1,
    gap: 2,
  },
  domainNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  domainName: {
    fontSize: 15,
    fontWeight: '600',
  },
  autoRenewBadge: {
    backgroundColor: '#F3F4F6',
    borderRadius: 4,
    padding: 3,
  },
  domainRegistrar: {
    fontSize: 12,
  },
  domainRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  expiryInfo: {
    alignItems: 'flex-end',
  },
  expiryDate: {
    fontSize: 12,
    fontWeight: '400',
  },
  expiryWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  expiryWarningText: {
    fontSize: 11,
    fontWeight: '500',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 8,
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
});
