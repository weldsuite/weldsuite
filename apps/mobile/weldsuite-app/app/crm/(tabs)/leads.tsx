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
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { User, Mail, Phone, Building, Star } from 'lucide-react-native';
import api from '@/services/api';

interface Lead {
  id: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  status: string;
  source?: string;
  score?: number;
  createdAt: string;
}

const LEAD_STATUS_CONFIG: Record<string, { label: string; color: string; backgroundColor: string }> = {
  new: {
    label: 'New',
    color: '#1D4ED8',
    backgroundColor: '#DBEAFE',
  },
  contacted: {
    label: 'Contacted',
    color: '#7C3AED',
    backgroundColor: '#EDE9FE',
  },
  qualified: {
    label: 'Qualified',
    color: '#059669',
    backgroundColor: '#D1FAE5',
  },
  converted: {
    label: 'Converted',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
  },
  lost: {
    label: 'Lost',
    color: '#991B1B',
    backgroundColor: '#FEE2E2',
  },
};

export default function LeadsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [total, setTotal] = useState(0);

  useEffect(() => {
    loadLeads();
  }, [selectedStatus]);

  const loadLeads = async () => {
    try {
      setLoading(true);
      const response = await api.getCrmLeads({
        search: searchQuery || undefined,
        filters: selectedStatus ? { status: selectedStatus } : undefined,
      });

      if (response.success && response.data) {
        setLeads(response.data.items);
        setTotal(response.data.total);
      }
    } catch (error) {
      console.error('Error loading leads:', error);
      toast.error('Failed to load leads');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleSearch = () => {
    loadLeads();
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadLeads();
  };

  const getScoreColor = (score?: number): string => {
    if (!score) return colors.muted;
    if (score >= 80) return '#10B981';
    if (score >= 60) return '#F59E0B';
    if (score >= 40) return '#EF4444';
    return colors.muted;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const getStatusConfig = (status: string) => {
    return LEAD_STATUS_CONFIG[status] || {
      label: status.charAt(0).toUpperCase() + status.slice(1),
      color: '#374151',
      backgroundColor: '#F3F4F6',
    };
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Leads' },
      { key: 'new', label: 'New' },
      { key: 'contacted', label: 'Contacted' },
      { key: 'qualified', label: 'Qualified' },
      { key: 'converted', label: 'Converted' },
      { key: 'lost', label: 'Lost' },
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
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderLead = ({ item }: { item: Lead }) => {
    const statusConfig = getStatusConfig(item.status);

    return (
      <TouchableOpacity
        style={[styles.leadItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        activeOpacity={0.7}
      >
        <View style={styles.leadContent}>
          <View style={styles.leadLeft}>
            <View style={styles.leadHeader}>
              <Text style={[styles.leadName, { color: colors.text }]}>{item.name || 'Unknown'}</Text>
              {item.score !== undefined && (
                <View style={styles.scoreContainer}>
                  <Star size={12} color={getScoreColor(item.score)} fill={getScoreColor(item.score)} strokeWidth={2} />
                  <Text style={[styles.scoreText, { color: getScoreColor(item.score) }]}>{item.score}</Text>
                </View>
              )}
            </View>

            <View style={styles.leadDetails}>
              {item.email && (
                <View style={styles.detailRow}>
                  <Mail size={12} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.detailText, { color: colors.muted }]} numberOfLines={1}>
                    {item.email}
                  </Text>
                </View>
              )}
              {item.company && (
                <View style={styles.detailRow}>
                  <Building size={12} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.detailText, { color: colors.muted }]} numberOfLines={1}>
                    {item.company}
                  </Text>
                </View>
              )}
            </View>

            {item.source && (
              <Text style={[styles.sourceText, { color: colors.muted }]}>
                Source: {item.source}
              </Text>
            )}
          </View>

          <View style={styles.leadRight}>
            <View style={[styles.statusBadge, { backgroundColor: statusConfig.backgroundColor }]}>
              <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
            </View>
            {item.phone && (
              <TouchableOpacity style={[styles.actionButton, { backgroundColor: '#10B981' + '20' }]}>
                <Phone size={16} color="#10B981" strokeWidth={2} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <View style={[styles.emptyIconContainer, { backgroundColor: '#F3F4F6' }]}>
        <User size={32} color="#9CA3AF" strokeWidth={1.5} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>No Leads</Text>
      <Text style={[styles.emptyText, { color: colors.muted }]}>
        {searchQuery || selectedStatus
          ? 'No leads match your filters'
          : 'Your leads will appear here'
        }
      </Text>
    </View>
  );

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading leads...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Leads ({total})</Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search leads..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
        </View>
      </View>

      {renderStatusFilter()}

      <FlatList
        data={leads}
        renderItem={renderLead}
        keyExtractor={(item) => item.id}
        contentContainerStyle={leads.length === 0 ? styles.emptyListContainer : styles.listContainer}
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
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  searchContainer: {
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 16,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
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
    paddingHorizontal: 24,
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
  listContainer: {
    paddingHorizontal: 0,
  },
  emptyListContainer: {
    flex: 1,
  },
  leadItem: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  leadContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  leadLeft: {
    flex: 1,
    marginRight: 12,
  },
  leadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  leadName: {
    fontSize: 15,
    fontWeight: '600',
  },
  scoreContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  scoreText: {
    fontSize: 12,
    fontWeight: '600',
  },
  leadDetails: {
    gap: 2,
    marginBottom: 4,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  detailText: {
    fontSize: 12,
    flex: 1,
  },
  sourceText: {
    fontSize: 11,
    fontStyle: 'italic',
  },
  leadRight: {
    alignItems: 'flex-end',
    gap: 8,
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
  actionButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 250,
  },
});
