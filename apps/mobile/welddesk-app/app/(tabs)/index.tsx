import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Search, X, Inbox as InboxIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { formatShortTime } from '@weldsuite/mobile-ui/utils/dateFormatter';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useInboxRealtime } from '@/hooks/useInboxRealtime';
import api from '@/services/api';

const STATUS_FILTERS = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Open' },
  { key: 'pending', label: 'Pending' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
];

const STATUS_COLORS: Record<string, string> = {
  active: '#3B82F6',
  pending: '#F59E0B',
  snoozed: '#8B5CF6',
  resolved: '#10B981',
  closed: '#6B7280',
};

export default function InboxScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useClerkAuth();

  const [conversations, setConversations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchConversations = useCallback(async () => {
    try {
      const params: Record<string, unknown> = { limit: 50 };
      if (statusFilter) params.status = statusFilter;
      if (search.trim()) params.search = search.trim();

      const response = await api.getConversations(params);
      if (response.success && response.data) {
        const items = response.data.items || response.data.data || response.data;
        setConversations(Array.isArray(items) ? items : []);
      }
    } catch (error) {
      console.error('Failed to fetch conversations:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [statusFilter, search]);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  // Debounced search
  const handleSearchChange = (text: string) => {
    setSearch(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setLoading(true);
    }, 300);
  };

  // Real-time inbox updates
  const { isConnected } = useInboxRealtime({
    agentId: user?.id || '',
    agentName: user?.fullName || user?.firstName || 'Agent',
    onNewConversation: () => fetchConversations(),
    onNewMessage: () => fetchConversations(),
    onConversationUpdated: () => fetchConversations(),
    onConversationClosed: () => fetchConversations(),
    autoConnect: !!user?.id,
  });

  const onRefresh = () => { setRefreshing(true); fetchConversations(); };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Inbox</Text>
          <View style={styles.headerActions}>
            {isConnected && <View style={styles.connectedDot} />}
          </View>
        </View>

        {/* Search */}
        <View style={[styles.searchBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Search size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search conversations..."
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={handleSearchChange}
          />
          {search ? (
            <TouchableOpacity onPress={() => { setSearch(''); setLoading(true); }}>
              <X size={16} color={colors.muted} />
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Status filters */}
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={STATUS_FILTERS}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.filterRow}
          renderItem={({ item }) => {
            const active = statusFilter === item.key;
            return (
              <TouchableOpacity
                onPress={() => { setStatusFilter(item.key); setLoading(true); }}
                style={[
                  styles.filterChip,
                  { borderColor: active ? '#3B82F6' : colors.border },
                  active && { backgroundColor: '#3B82F6' },
                ]}
              >
                <Text style={[styles.filterText, { color: active ? '#fff' : colors.text }]}>{item.label}</Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Conversation list */}
      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.text} /></View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.item, { borderBottomColor: colors.divider }]}
              onPress={() => router.push(`/ticket/${item.id}`)}
              activeOpacity={0.6}
            >
              <View style={styles.itemRow}>
                <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[item.status] || '#6B7280' }]} />
                <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={1}>
                  {item.contactName || item.customerName || 'Unknown'}
                </Text>
                <Text style={[styles.itemTime, { color: colors.muted }]}>
                  {item.updatedAt ? formatShortTime(item.updatedAt) : ''}
                </Text>
              </View>
              <Text style={[styles.itemSubject, { color: colors.text }]} numberOfLines={1}>
                {item.subject || 'No subject'}
              </Text>
              <Text style={[styles.itemPreview, { color: colors.muted }]} numberOfLines={1}>
                {item.lastMessagePreview || ''}
              </Text>
              {(item.unreadCount > 0) && (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadText}>{item.unreadCount > 9 ? '9+' : item.unreadCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <InboxIcon size={48} color={colors.muted} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No conversations</Text>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                {search ? 'No results for your search' : 'All caught up!'}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  headerTitle: { fontSize: 34, fontWeight: '700' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  connectedDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#10B981' },
  searchBar: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, height: 40, gap: 8, marginBottom: 8 },
  searchInput: { flex: 1, fontSize: 15 },
  filterRow: { gap: 8, paddingBottom: 4 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: '500' },
  item: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 0.5, position: 'relative' },
  itemRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  itemName: { fontSize: 16, fontWeight: '600', flex: 1 },
  itemTime: { fontSize: 13 },
  itemSubject: { fontSize: 15, fontWeight: '500', marginBottom: 2, paddingLeft: 16 },
  itemPreview: { fontSize: 14, lineHeight: 20, paddingLeft: 16 },
  unreadBadge: { position: 'absolute', right: 16, top: 14, backgroundColor: '#3B82F6', borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  unreadText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  empty: { padding: 48, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '600' },
  emptyText: { fontSize: 15 },
});
