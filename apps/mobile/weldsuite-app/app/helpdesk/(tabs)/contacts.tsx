import React, { useState, useEffect, useCallback } from 'react';
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
  Modal,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Search, X, Phone, Mail, Menu as MenuIcon, Inbox as InboxIcon, Users } from 'lucide-react-native';
import AppDrawer from '@/components/layout/AppDrawer';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api, { Contact, getApiErrorMessage } from '@/services/api';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';

const STATUS_CONFIG: Record<string, { label: string; color: string; backgroundColor: string }> = {
  active: {
    label: 'Active',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
  },
  inactive: {
    label: 'Inactive',
    color: '#374151',
    backgroundColor: '#F3F4F6',
  },
  left_company: {
    label: 'Left',
    color: '#7C2D12',
    backgroundColor: '#FED7AA',
  },
};

const STATUS_TABS = [
  { key: null, label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
];

export default function ContactsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const showMiniSidebar = useShouldShowMiniSidebar();
  const { resetHeader, onScroll: onCollapsibleScroll } = useCollapsibleHeader();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterModalVisible, setFilterModalVisible] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);

  const drawerMenuItems = [
    {
      key: 'inbox',
      label: 'Inbox',
      icon: <InboxIcon size={20} color="#374151" strokeWidth={2} />,
      onPress: () => router.push('/helpdesk/(tabs)/inbox' as any),
    },
    {
      key: 'contacts',
      label: 'Contacts',
      icon: <Users size={20} color="#374151" strokeWidth={2} />,
      onPress: () => {},
    },
  ];
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const searchTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    resetHeader();
  }, [resetHeader]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
    setHasMore(true);
  }, [selectedStatus]);

  // Debounce search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      setPage(1);
      setHasMore(true);
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery]);

  // Load contacts when page/filters change
  useEffect(() => {
    loadContacts();
  }, [page, selectedStatus]);

  // Reload on focus
  useFocusEffect(
    useCallback(() => {
      loadContacts();
    }, [])
  );

  const loadContacts = async (isLoadingMore = false) => {
    if (isLoadingMore) {
      if (loadingMore || !hasMore) return;
      setLoadingMore(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await api.getContacts({
        search: searchQuery || undefined,
        status: selectedStatus || undefined,
        page,
        limit: 20,
      });

      if (response.success && response.data) {
        const items = response.data.data || response.data.items || [];
        const total = response.data.meta?.total || 0;
        const limit = response.data.meta?.limit || 20;

        if (page === 1) {
          setContacts(items);
        } else {
          setContacts(prev => [...prev, ...items]);
        }

        setTotalCount(total);
        setHasMore(items.length === limit && contacts.length + items.length < total);
      } else {
        toast.error(getApiErrorMessage(response.error, 'Failed to load contacts'));
      }
    } catch (error) {
      console.error('Error loading contacts:', error);
      toast.error('Failed to load contacts');
    } finally {
      setLoading(false);
      setInitialLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  };

  const handleLoadMore = () => {
    if (!loadingMore && hasMore && !loading) {
      setPage(prev => prev + 1);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    setPage(1);
    setHasMore(true);
    loadContacts();
  };

  const handleContactPress = (contact: Contact) => {
    router.push(`/helpdesk/contact/${contact.id}` as any);
  };

  const getContactName = (contact: Contact) => {
    if (contact.fullName) return contact.fullName;
    return `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Unknown';
  };

  const getInitials = (contact: Contact) => {
    const first = (contact.firstName || '')[0] || '';
    const last = (contact.lastName || '')[0] || '';
    return (first + last).toUpperCase() || '?';
  };

  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays < 1) return 'Today';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const renderStatusTabs = () => (
    <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
        {STATUS_TABS.map((item) => (
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

  const renderContact = ({ item }: { item: Contact }) => {
    const name = getContactName(item);
    const statusConfig = STATUS_CONFIG[item.status] || STATUS_CONFIG.active;
    const phone = item.mobilePhone || item.directPhone;

    return (
      <TouchableOpacity
        style={[styles.contactItem, { backgroundColor: colors.background, borderBottomColor: colors.border }]}
        onPress={() => handleContactPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.contactContent}>
          <View style={[styles.avatar, { backgroundColor: '#F3F4F6' }]}>
            <Text style={styles.avatarText}>{getInitials(item)}</Text>
          </View>
          <View style={styles.contactLeft}>
            <View style={styles.contactNameRow}>
              <Text style={[styles.contactName, { color: colors.text }]} numberOfLines={1}>
                {name}
              </Text>
              {item.isPrimary && (
                <View style={[styles.primaryBadge]}>
                  <Text style={styles.primaryBadgeText}>Primary</Text>
                </View>
              )}
            </View>
            <View style={styles.contactDetails}>
              {item.email && (
                <Text style={[styles.contactDetailText, { color: colors.muted }]} numberOfLines={1}>
                  {item.email}
                </Text>
              )}
              {phone && (
                <View style={styles.contactDetailRow}>
                  <Phone size={12} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.contactDetailText, { color: colors.muted }]}>
                    {phone}
                  </Text>
                </View>
              )}
            </View>
          </View>
          <View style={styles.contactRight}>
            {item.lastContactedAt && (
              <Text style={[styles.lastContactText, { color: colors.muted }]}>
                {formatDate(item.lastContactedAt)}
              </Text>
            )}
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
      {loading ? (
        <ActivityIndicator size="small" color={colors.text} />
      ) : (
        <Text style={[styles.emptyText, { color: colors.muted }]}>No contacts found</Text>
      )}
    </View>
  );

  if (initialLoading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading contacts...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <TouchableOpacity
          onPress={() => setDrawerVisible(true)}
          style={styles.menuButton}
        >
          <MenuIcon size={20} color="#374151" strokeWidth={2} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Contacts ({totalCount})</Text>
        <TouchableOpacity
          style={[
            styles.filterTextButton,
            { borderColor: selectedStatus ? colors.text : colors.buttonBorder },
          ]}
          onPress={() => setFilterModalVisible(true)}
        >
          <Text style={[styles.filterTextButtonLabel, { color: selectedStatus ? colors.text : colors.subtle }]}>
            {selectedStatus ? STATUS_CONFIG[selectedStatus]?.label || 'Filter' : 'Filter'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search contacts..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <X size={18} color={colors.muted} strokeWidth={2} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={contacts}
        renderItem={renderContact}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={renderEmptyState}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.loadingMoreContainer}>
              <ActivityIndicator size="small" color={colors.text} />
            </View>
          ) : null
        }
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.3}
        showsVerticalScrollIndicator={false}
        onScroll={onCollapsibleScroll}
        scrollEventThrottle={16}
      />

      {/* App Drawer */}
      <AppDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        currentApp="helpdesk"
        menuItems={drawerMenuItems}
        activeMenuItem="contacts"
      />

      {/* Filter Modal */}
      <Modal
        visible={filterModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setFilterModalVisible(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Filter by Status</Text>
            <TouchableOpacity
              onPress={() => setFilterModalVisible(false)}
              style={styles.modalCloseButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            <TouchableOpacity
              style={[styles.modalOption, { borderBottomColor: colors.border }]}
              onPress={() => { setSelectedStatus(null); setFilterModalVisible(false); }}
            >
              <Text style={[styles.modalOptionText, { color: colors.text, fontWeight: selectedStatus === null ? '600' : '400' }]}>All</Text>
              {selectedStatus === null && <Ionicons name="checkmark" size={20} color={colors.text} />}
            </TouchableOpacity>
            {Object.entries(STATUS_CONFIG).map(([key, config]) => (
              <TouchableOpacity
                key={key}
                style={[styles.modalOption, { borderBottomColor: colors.border }]}
                onPress={() => { setSelectedStatus(key); setFilterModalVisible(false); }}
              >
                <Text style={[styles.modalOptionText, { color: colors.text, fontWeight: selectedStatus === key ? '600' : '400' }]}>{config.label}</Text>
                {selectedStatus === key && <Ionicons name="checkmark" size={20} color={colors.text} />}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>
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
  menuButton: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '600',
    marginLeft: 12,
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
    paddingVertical: 9,
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
    paddingVertical: 7,
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
  contactItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  contactContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
  },
  contactLeft: {
    flex: 1,
    gap: 4,
  },
  contactNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  contactName: {
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  primaryBadge: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  primaryBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#2563EB',
  },
  contactDetails: {
    gap: 2,
  },
  contactDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  contactDetailText: {
    fontSize: 12,
    flexShrink: 1,
  },
  contactRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  lastContactText: {
    fontSize: 12,
    fontWeight: '400',
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
  },
  emptyText: {
    fontSize: 12,
  },
  loadingMoreContainer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  filterTextButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  filterTextButtonLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  modalCloseButton: {
    padding: 4,
  },
  modalOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 0.5,
  },
  modalOptionText: {
    fontSize: 16,
  },
});
