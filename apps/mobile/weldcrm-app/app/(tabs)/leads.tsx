import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Building, Mail, Phone, Plus, Star, User } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { TabHeader } from '@/components/headers';
import { usePagedList } from '@/hooks/use-paged-list';
import { api, type CrmLead } from '@/services/api';
import { interpolate, labelFor, useI18n } from '@/lib/i18n';

const LEAD_STATUS_COLORS: Record<string, { color: string; backgroundColor: string }> = {
  new: { color: '#1D4ED8', backgroundColor: '#DBEAFE' },
  contacted: { color: '#7C3AED', backgroundColor: '#EDE9FE' },
  qualified: { color: '#059669', backgroundColor: '#D1FAE5' },
  converted: { color: '#14532D', backgroundColor: '#DCFCE7' },
  lost: { color: '#991B1B', backgroundColor: '#FEE2E2' },
};

const FALLBACK_STATUS_COLORS = { color: '#374151', backgroundColor: '#F3F4F6' };

const STATUS_FILTERS = ['new', 'contacted', 'qualified', 'converted', 'lost'] as const;

export default function LeadsScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchLeads = useCallback(
    (params: { cursor: string | null; search: string }) =>
      api.getCrmLeads({ ...params, status: selectedStatus ?? undefined }),
    [selectedStatus],
  );

  const leads = usePagedList<CrmLead>(fetchLeads, { search: searchQuery, resetKey: selectedStatus ?? '' });

  useEffect(() => {
    if (leads.error) toast.error(t.leads.loadFailed);
  }, [leads.error, t, toast]);

  const scoreColor = (score?: number): string => {
    if (!score) return colors.muted;
    if (score >= 80) return '#10B981';
    if (score >= 60) return '#F59E0B';
    if (score >= 40) return '#EF4444';
    return colors.muted;
  };

  const renderLead = ({ item }: { item: CrmLead }) => {
    const statusColors = LEAD_STATUS_COLORS[item.status] ?? FALLBACK_STATUS_COLORS;
    return (
      <View style={[styles.leadItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={styles.leadContent}>
          <View style={styles.leadLeft}>
            <View style={styles.leadHeader}>
              <Text style={[styles.leadName, { color: colors.text }]} numberOfLines={1}>
                {item.name || t.leads.unnamed}
              </Text>
              {item.score !== undefined && (
                <View style={styles.scoreContainer}>
                  <Star size={12} color={scoreColor(item.score)} fill={scoreColor(item.score)} strokeWidth={2} />
                  <Text style={[styles.scoreText, { color: scoreColor(item.score) }]}>{item.score}</Text>
                </View>
              )}
            </View>

            <View style={styles.leadDetails}>
              {!!item.email && (
                <View style={styles.detailRow}>
                  <Mail size={12} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.detailText, { color: colors.muted }]} numberOfLines={1}>
                    {item.email}
                  </Text>
                </View>
              )}
              {!!item.company && (
                <View style={styles.detailRow}>
                  <Building size={12} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.detailText, { color: colors.muted }]} numberOfLines={1}>
                    {item.company}
                  </Text>
                </View>
              )}
            </View>

            {!!item.source && (
              <Text style={[styles.sourceText, { color: colors.muted }]}>
                {interpolate(t.leads.source, { source: item.source })}
              </Text>
            )}
          </View>

          <View style={styles.leadRight}>
            <View style={[styles.statusBadge, { backgroundColor: statusColors.backgroundColor }]}>
              <Text style={[styles.statusText, { color: statusColors.color }]}>
                {labelFor(t.leads.status, item.status)}
              </Text>
            </View>
            {!!item.phone && (
              <View style={[styles.phoneIcon, { backgroundColor: '#10B98120' }]}>
                <Phone size={16} color="#10B981" strokeWidth={2} />
              </View>
            )}
          </View>
        </View>
      </View>
    );
  };

  const renderEmpty = () => {
    if (leads.loading) return null;
    const emptyMessage = searchQuery || selectedStatus ? t.leads.emptyFiltered : t.leads.emptyNone;
    const message = leads.error ? t.common.pullToRetry : emptyMessage;
    return (
      <View style={styles.emptyContainer}>
        <View style={[styles.emptyIconContainer, { backgroundColor: colors.secondary }]}>
          <User size={32} color={colors.muted} strokeWidth={1.5} />
        </View>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {leads.error ? t.leads.loadFailed : t.leads.emptyTitle}
        </Text>
        <Text style={[styles.emptyText, { color: colors.muted }]}>{message}</Text>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TabHeader
        title={interpolate(t.leads.titleWithCount, { count: leads.totalCount })}
        right={
          <TouchableOpacity
            style={[styles.addButton, { borderColor: colors.buttonBorder }]}
            onPress={() => router.push('/lead/new')}
            accessibilityRole="button"
            accessibilityLabel={t.leads.add}
          >
            <Plus size={18} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
        }
      />

      <View style={styles.searchContainer}>
        <View style={[styles.searchBar, { backgroundColor: colors.inputBackground }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder={t.leads.search}
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>
      </View>

      <View style={[styles.filterContainer, { borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {[null, ...STATUS_FILTERS].map((key) => {
            const active = selectedStatus === key;
            return (
              <TouchableOpacity
                key={key ?? 'all'}
                style={[
                  styles.filterButton,
                  {
                    backgroundColor: active ? colors.text : colors.background,
                    borderColor: active ? colors.text : colors.buttonBorder,
                  },
                ]}
                onPress={() => setSelectedStatus(key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.filterButtonText, { color: active ? colors.background : colors.text }]}>
                  {key ? t.leads.status[key] : t.leads.filterAll}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {leads.loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>{t.leads.loading}</Text>
        </View>
      ) : (
        <FlatList
          data={leads.items}
          renderItem={renderLead}
          keyExtractor={(item) => item.id}
          contentContainerStyle={leads.items.length === 0 ? styles.emptyListContainer : undefined}
          refreshControl={<RefreshControl refreshing={leads.refreshing} onRefresh={() => void leads.refresh()} />}
          onEndReached={() => void leads.loadMore()}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={renderEmpty}
          ListFooterComponent={leads.loadingMore ? <ActivityIndicator style={styles.footerSpinner} color={colors.text} /> : null}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 16, fontSize: 12 },
  addButton: { width: 36, height: 36, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  searchContainer: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  searchBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, gap: 8 },
  searchInput: { flex: 1, fontSize: 14, fontWeight: '400', padding: 0 },
  filterContainer: { paddingBottom: 12, borderBottomWidth: 0.5 },
  filterList: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  filterButton: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  filterButtonText: { fontSize: 13, fontWeight: '500' },
  emptyListContainer: { flex: 1 },
  footerSpinner: { paddingVertical: 16 },
  leadItem: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5 },
  leadContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  leadLeft: { flex: 1, marginRight: 12 },
  leadHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  leadName: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  scoreContainer: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  scoreText: { fontSize: 12, fontWeight: '600' },
  leadDetails: { gap: 2, marginBottom: 4 },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  detailText: { fontSize: 12, flex: 1 },
  sourceText: { fontSize: 11, fontStyle: 'italic' },
  leadRight: { alignItems: 'flex-end', gap: 8 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusText: { fontSize: 10, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.3 },
  phoneIcon: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyIconContainer: { width: 80, height: 80, borderRadius: 40, justifyContent: 'center', alignItems: 'center', marginBottom: 24 },
  emptyTitle: { fontSize: 20, fontWeight: '600', marginBottom: 8 },
  emptyText: { fontSize: 14, textAlign: 'center', maxWidth: 250 },
});
