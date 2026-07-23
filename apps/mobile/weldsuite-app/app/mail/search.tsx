import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Keyboard,
  ScrollView,
  Modal,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { useMail, type Email } from '@/contexts/MailContext';
import {
  ChevronLeft,
  X,
  ChevronDown,
  Star,
  Inbox,
  Send,
  FileText,
  Clock,
  Mail,
  Archive,
  Trash2,
  AlertTriangle,
  Tag,
  User,
  Users,
  Paperclip,
  Calendar,
  CheckCircle,
  Circle,
} from 'lucide-react-native';

// Filter options
const FILTERS = ['Label', 'From', 'To', 'Attachment', 'Date', 'Is unread'];

// Filter modal options
const FILTER_OPTIONS: Record<string, { icon: any; label: string }[]> = {
  Label: [
    { icon: Star, label: 'Starred' },
    { icon: Calendar, label: 'Scheduled' },
    { icon: ChevronDown, label: 'Important' },
    { icon: Send, label: 'Sent' },
    { icon: Clock, label: 'Snoozed' },
    { icon: FileText, label: 'Drafts' },
    { icon: Mail, label: 'All emails' },
    { icon: Archive, label: 'Archive' },
    { icon: Trash2, label: 'Trash' },
  ],
  From: [
    { icon: User, label: 'Me' },
    { icon: Users, label: 'Anyone' },
  ],
  To: [
    { icon: User, label: 'Me' },
    { icon: Users, label: 'Anyone' },
  ],
  Attachment: [
    { icon: Paperclip, label: 'Has attachment' },
    { icon: Circle, label: 'No attachment' },
  ],
  Date: [
    { icon: Calendar, label: 'Today' },
    { icon: Calendar, label: 'Yesterday' },
    { icon: Calendar, label: 'This week' },
    { icon: Calendar, label: 'This month' },
    { icon: Calendar, label: 'This year' },
    { icon: Calendar, label: 'Custom range' },
  ],
  'Is unread': [
    { icon: Circle, label: 'Unread' },
    { icon: CheckCircle, label: 'Read' },
  ],
};

export default function MailSearchScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);

  const {
    selectedAccount,
    messages,
    markAsRead,
    toggleStar,
  } = useMail();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Email[]>([]);
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const [filterModalVisible, setFilterModalVisible] = useState(false);
  const [activeFilterType, setActiveFilterType] = useState<string | null>(null);
  const [filterSearchQuery, setFilterSearchQuery] = useState('');
  const searchTimeoutRef = useRef<NodeJS.Timeout>();

  // Auto-focus the search input
  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (searchQuery.trim().length === 0) {
      setSearchResults([]);
      return;
    }

    searchTimeoutRef.current = setTimeout(async () => {
      if (selectedAccount && searchQuery.trim()) {
        // Filter messages based on search query
        const query = searchQuery.toLowerCase();
        const filtered = messages.filter(email =>
          email.subject.toLowerCase().includes(query) ||
          email.from.toLowerCase().includes(query) ||
          email.preview.toLowerCase().includes(query)
        );
        setSearchResults(filtered);
      }
    }, 150);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery, selectedAccount, messages]);

  const handleBack = () => {
    Keyboard.dismiss();
    router.back();
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    inputRef.current?.focus();
  };

  const handleEmailPress = useCallback((email: Email) => {
    // Mark as read
    if (!email.isRead) {
      markAsRead(email.id, true);
    }

    // Navigate to email detail
    router.push(`/mail/${email.id}` as any);
  }, [markAsRead]);

  const handleStarToggle = useCallback((emailId: string) => {
    toggleStar(emailId);
  }, [toggleStar]);

  const getAvatarColor = (name: string) => {
    const avatarColors = [
      '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444',
      '#06B6D4', '#EC4899', '#F97316', '#14B8A6', '#6366F1',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return avatarColors[Math.abs(hash) % avatarColors.length];
  };

  // Highlight search term in text
  const highlightText = (text: string, query: string) => {
    if (!query.trim()) return <Text>{text}</Text>;

    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    return (
      <Text>
        {parts.map((part, index) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <Text key={index} style={styles.highlight}>{part}</Text>
          ) : (
            <Text key={index}>{part}</Text>
          )
        )}
      </Text>
    );
  };

  const openFilterModal = (filter: string) => {
    setActiveFilterType(filter);
    setFilterSearchQuery('');
    setFilterModalVisible(true);
  };

  const closeFilterModal = () => {
    setFilterModalVisible(false);
    setActiveFilterType(null);
    setFilterSearchQuery('');
  };

  const selectFilterOption = (filter: string, option: string) => {
    setActiveFilters(prev => ({
      ...prev,
      [filter]: option,
    }));
    closeFilterModal();
  };

  const clearFilter = (filter: string) => {
    setActiveFilters(prev => {
      const newFilters = { ...prev };
      delete newFilters[filter];
      return newFilters;
    });
  };

  const renderFilterChip = (filter: string) => {
    const selectedValue = activeFilters[filter];
    const isActive = !!selectedValue;
    return (
      <TouchableOpacity
        key={filter}
        style={[
          styles.filterChip,
          {
            borderColor: isActive ? '#3B82F6' : colors.divider,
            backgroundColor: isActive ? '#EFF6FF' : colors.background,
          }
        ]}
        onPress={() => openFilterModal(filter)}
      >
        <Text style={[
          styles.filterChipText,
          { color: isActive ? '#3B82F6' : colors.text }
        ]}>
          {isActive ? selectedValue : filter}
        </Text>
        <ChevronDown size={14} color={isActive ? '#3B82F6' : colors.muted} strokeWidth={2} />
      </TouchableOpacity>
    );
  };

  const getFilteredOptions = () => {
    if (!activeFilterType) return [];
    const options = FILTER_OPTIONS[activeFilterType] || [];
    if (!filterSearchQuery.trim()) return options;
    return options.filter(opt =>
      opt.label.toLowerCase().includes(filterSearchQuery.toLowerCase())
    );
  };

  const renderSearchResult = ({ item }: { item: Email }) => (
    <TouchableOpacity
      style={[styles.resultItem, { backgroundColor: colors.background }]}
      onPress={() => handleEmailPress(item)}
      activeOpacity={0.7}
    >
      <View style={[styles.avatar, { backgroundColor: getAvatarColor(item.from) }]}>
        <Text style={styles.avatarText}>
          {item.from.charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.resultContent}>
        <View style={styles.resultTop}>
          <View style={styles.senderRow}>
            <Text style={[styles.resultSender, { color: colors.text }]} numberOfLines={1}>
              {highlightText(item.from.split('@')[0].split('<')[0].trim(), searchQuery)}
            </Text>
          </View>
          <Text style={[styles.resultDate, { color: colors.muted }]}>{item.date}</Text>
        </View>
        <Text style={[styles.resultSubject, { color: colors.text }]} numberOfLines={1}>
          {highlightText(item.subject, searchQuery)}
        </Text>
        <View style={styles.resultBottom}>
          <Text style={[styles.resultPreview, { color: colors.muted }]} numberOfLines={1}>
            {highlightText(item.preview, searchQuery)}
          </Text>
          <View style={styles.resultMeta}>
            {item.labels?.length > 0 && (
              <View style={[styles.labelChip, { backgroundColor: '#F3F4F6' }]}>
                <Text style={styles.labelChipText}>{item.labels[0]}</Text>
              </View>
            )}
            <TouchableOpacity
              onPress={() => handleStarToggle(item.id)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Star
                size={18}
                color={item.isStarred ? '#F59E0B' : '#D1D5DB'}
                fill={item.isStarred ? '#F59E0B' : 'transparent'}
                strokeWidth={2}
              />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderEmptyState = () => {
    if (searchQuery.trim().length === 0) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: colors.muted }]}>
            Search for emails by sender, subject, or content
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No results found</Text>
        <Text style={[styles.emptyText, { color: colors.muted }]}>
          Try searching for a different term
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Search Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack}>
          <ChevronLeft size={28} color={colors.text} strokeWidth={1.5} />
        </TouchableOpacity>
        <View style={styles.searchInputWrapper}>
          <TextInput
            ref={inputRef}
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search in mail"
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        {searchQuery.length > 0 && (
          <TouchableOpacity style={styles.clearButton} onPress={handleClearSearch}>
            <X size={22} color={colors.muted} strokeWidth={2} />
          </TouchableOpacity>
        )}
      </View>

      {/* Filter Chips */}
      <View style={styles.filtersContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filtersScroll}
        >
          {FILTERS.map(renderFilterChip)}
        </ScrollView>
      </View>

      {/* Sort Option */}
      {searchResults.length > 0 && (
        <TouchableOpacity style={styles.sortOption}>
          <Text style={[styles.sortText, { color: colors.text }]}>Most relevant</Text>
          <ChevronDown size={16} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
      )}

      {/* Search Results */}
      <FlatList
        data={searchResults}
        renderItem={renderSearchResult}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.resultsList,
          searchResults.length === 0 && styles.emptyList,
        ]}
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />

      {/* Filter Modal */}
      <Modal
        visible={filterModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeFilterModal}
      >
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          {/* Modal Header */}
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <TouchableOpacity style={styles.modalCloseButton} onPress={closeFilterModal}>
              <X size={24} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {activeFilterType}
            </Text>
            <View style={styles.modalCloseButton} />
          </View>

          {/* Search Input */}
          <View style={[styles.modalSearchContainer, { borderBottomColor: colors.divider }]}>
            <TextInput
              style={[styles.modalSearchInput, { color: colors.text }]}
              placeholder={`Search ${activeFilterType?.toLowerCase() || 'options'}`}
              placeholderTextColor={colors.muted}
              value={filterSearchQuery}
              onChangeText={setFilterSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {/* Options List */}
          <ScrollView style={styles.modalOptionsList} showsVerticalScrollIndicator={false}>
            {getFilteredOptions().map((option, index) => {
              const IconComponent = option.icon;
              const isSelected = activeFilters[activeFilterType || ''] === option.label;
              return (
                <TouchableOpacity
                  key={index}
                  style={styles.modalOption}
                  onPress={() => selectFilterOption(activeFilterType || '', option.label)}
                >
                  <IconComponent
                    size={22}
                    color={isSelected ? '#3B82F6' : colors.muted}
                    strokeWidth={1.5}
                  />
                  <Text style={[
                    styles.modalOptionText,
                    { color: isSelected ? '#3B82F6' : colors.text }
                  ]}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 8,
  },
  searchInputWrapper: {
    flex: 1,
    marginLeft: 4,
  },
  searchInput: {
    fontSize: 18,
    fontWeight: '400',
  },
  clearButton: {
    padding: 12,
  },
  filtersContainer: {
    paddingVertical: 10,
  },
  filtersScroll: {
    paddingHorizontal: 12,
    gap: 8,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  filterChipText: {
    fontSize: 14,
    fontWeight: '400',
  },
  sortOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 4,
  },
  sortText: {
    fontSize: 14,
    fontWeight: '500',
  },
  resultsList: {
    paddingBottom: 20,
  },
  emptyList: {
    flex: 1,
  },
  resultItem: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  resultContent: {
    flex: 1,
    gap: 2,
  },
  resultTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
    gap: 6,
  },
  resultSender: {
    fontSize: 15,
    fontWeight: '500',
  },
  resultDate: {
    fontSize: 13,
  },
  resultSubject: {
    fontSize: 14,
    fontWeight: '500',
  },
  resultBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  resultPreview: {
    fontSize: 14,
    flex: 1,
    marginRight: 8,
  },
  resultMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  labelChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  labelChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#6B7280',
  },
  highlight: {
    backgroundColor: '#FEF08A',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
  // Modal styles
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  modalCloseButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '500',
  },
  modalSearchContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  modalSearchInput: {
    fontSize: 16,
  },
  modalOptionsList: {
    flex: 1,
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 20,
  },
  modalOptionText: {
    fontSize: 16,
    fontWeight: '400',
  },
});
