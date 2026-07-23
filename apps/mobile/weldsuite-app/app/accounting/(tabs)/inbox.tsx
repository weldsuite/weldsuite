import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  View,
  Text,
  RefreshControl,
  FlatList,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  FileText,
  Receipt,
  ChevronRight,
  Inbox,
  Filter,
} from 'lucide-react-native';
import api, { AccountingInboxItem } from '@/services/api';

type FilterType = '' | 'invoice' | 'expense';

export default function InboxScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<AccountingInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState<FilterType>('');

  useEffect(() => {
    loadInboxItems();
  }, [selectedFilter]);

  const loadInboxItems = async () => {
    try {
      setLoading(true);
      const response = await api.getAccountingInbox({
        limit: 50,
        type: selectedFilter || undefined,
      });
      if (response.success && response.data) {
        setItems(response.data.items);
      }
    } catch (error) {
      console.error('Error loading inbox items:', error);
      toast.error('Failed to load inbox');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadInboxItems();
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'invoice':
        return <FileText size={20} color="#FFFFFF" strokeWidth={2} />;
      case 'expense':
        return <Receipt size={20} color="#FFFFFF" strokeWidth={2} />;
      default:
        return <FileText size={20} color="#FFFFFF" strokeWidth={2} />;
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'invoice':
        return '#3B82F6';
      case 'expense':
        return '#F59E0B';
      default:
        return colors.muted;
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffHours < 1) {
      return 'Just now';
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  const markAsRead = (itemId: string) => {
    setItems(prev =>
      prev.map(item => (item.id === itemId ? { ...item, read: true } : item))
    );
  };

  const renderInboxItem = ({ item }: { item: AccountingInboxItem }) => (
    <TouchableOpacity
      style={[
        styles.inboxItem,
        {
          borderBottomColor: colors.divider,
          backgroundColor: item.read ? 'transparent' : colors.background,
        },
      ]}
      onPress={() => markAsRead(item.id)}
      activeOpacity={0.7}
    >
      <View style={[styles.typeIcon, { backgroundColor: getTypeColor(item.type) }]}>
        {getTypeIcon(item.type)}
      </View>

      <View style={styles.itemContent}>
        <View style={styles.itemHeader}>
          <Text
            style={[
              styles.itemTitle,
              {
                color: colors.text,
                fontWeight: item.read ? '400' : '600',
              },
            ]}
            numberOfLines={1}
          >
            {item.title}
          </Text>
          {!item.read && <View style={styles.unreadDot} />}
        </View>

        <View style={styles.itemMeta}>
          <Text style={[styles.itemSender, { color: colors.muted }]}>{item.sender}</Text>
          <Text style={[styles.itemDate, { color: colors.muted }]}>• {formatDate(item.date)}</Text>
        </View>

        <Text style={[styles.itemAmount, { color: colors.text }]}>
          {formatCurrency(item.amount)}
        </Text>
      </View>

      <ChevronRight size={20} color={colors.muted} strokeWidth={2} />
    </TouchableOpacity>
  );

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading inbox...</Text>
      </View>
    );
  }

  const unreadCount = items.filter(item => !item.read).length;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 45 }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <View style={styles.headerTitleRow}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Inbox</Text>
          {unreadCount > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadCount}>{unreadCount}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Filter Pills */}
      <View style={styles.filterContainer}>
        <TouchableOpacity
          style={[
            styles.filterPill,
            {
              backgroundColor: selectedFilter === '' ? '#3B82F6' : colors.background,
              borderColor: selectedFilter === '' ? '#3B82F6' : colors.divider,
            },
          ]}
          onPress={() => setSelectedFilter('')}
        >
          <Text
            style={[
              styles.filterText,
              { color: selectedFilter === '' ? '#FFFFFF' : colors.text },
            ]}
          >
            All
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.filterPill,
            {
              backgroundColor: selectedFilter === 'invoice' ? '#3B82F6' : colors.background,
              borderColor: selectedFilter === 'invoice' ? '#3B82F6' : colors.divider,
            },
          ]}
          onPress={() => setSelectedFilter('invoice')}
        >
          <FileText
            size={14}
            color={selectedFilter === 'invoice' ? '#FFFFFF' : colors.text}
            strokeWidth={2}
          />
          <Text
            style={[
              styles.filterText,
              { color: selectedFilter === 'invoice' ? '#FFFFFF' : colors.text },
            ]}
          >
            Invoices
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.filterPill,
            {
              backgroundColor: selectedFilter === 'expense' ? '#F59E0B' : colors.background,
              borderColor: selectedFilter === 'expense' ? '#F59E0B' : colors.divider,
            },
          ]}
          onPress={() => setSelectedFilter('expense')}
        >
          <Receipt
            size={14}
            color={selectedFilter === 'expense' ? '#FFFFFF' : colors.text}
            strokeWidth={2}
          />
          <Text
            style={[
              styles.filterText,
              { color: selectedFilter === 'expense' ? '#FFFFFF' : colors.text },
            ]}
          >
            Expenses
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={items}
        renderItem={renderInboxItem}
        keyExtractor={item => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Inbox size={64} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>Inbox is empty</Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              {selectedFilter
                ? `No ${selectedFilter === 'invoice' ? 'unpaid invoices' : 'pending expenses'} found`
                : 'No unpaid invoices or pending expenses'}
            </Text>
          </View>
        }
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  unreadBadge: {
    marginLeft: 8,
    backgroundColor: '#EF4444',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadCount: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  filterContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  filterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    gap: 6,
  },
  filterText: {
    fontSize: 13,
    fontWeight: '500',
  },
  listContent: {
    paddingBottom: 32,
  },
  inboxItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 0.5,
    gap: 12,
  },
  typeIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemContent: {
    flex: 1,
    gap: 4,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  itemTitle: {
    fontSize: 14,
    flex: 1,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3B82F6',
  },
  itemMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  itemSender: {
    fontSize: 12,
  },
  itemDate: {
    fontSize: 12,
  },
  itemAmount: {
    fontSize: 13,
    fontWeight: '500',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center',
  },
});
