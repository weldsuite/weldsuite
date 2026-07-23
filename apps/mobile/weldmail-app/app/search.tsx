import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Keyboard,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  ChevronLeft, X, ChevronDown, Star, Inbox, SendHorizontal, File, Clock,
  Mail, Archive, Trash2, AlertCircle, Tag, User, Users, Paperclip,
  Calendar, CheckCircle, Circle,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { formatEmailTime } from '@weldsuite/mobile-ui/utils/dateFormatter';
import appApi from '@/services/app-api';
import { getAvatarColor } from '@/contexts/MailContext';
import type { EmailListItem } from '@/types/mail';

const FILTERS = ['Label', 'From', 'To', 'Attachment', 'Date', 'Is unread'];

const FILTER_OPTIONS: Record<string, { icon: any; label: string }[]> = {
  Label: [
    { icon: Star, label: 'Starred' },
    { icon: Calendar, label: 'Scheduled' },
    { icon: AlertCircle, label: 'Important' },
    { icon: SendHorizontal, label: 'Sent' },
    { icon: Clock, label: 'Snoozed' },
    { icon: File, label: 'Drafts' },
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

export default function SearchScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EmailListItem[]>([]);
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const [filterModalVisible, setFilterModalVisible] = useState(false);
  const [activeFilterType, setActiveFilterType] = useState<string | null>(null);
  const [filterSearchQuery, setFilterSearchQuery] = useState('');
  const searchTimeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!searchQuery.trim()) { setSearchResults([]); return; }

    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const { data: items } = await appApi.mailMessages.list({ search: searchQuery, limit: 50 });
        setSearchResults(items);
      } catch (error) {
        console.error('Search error:', error);
      }
    }, 150);

    return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [searchQuery]);

  const handleBack = () => { Keyboard.dismiss(); router.back(); };
  const handleClearSearch = () => { setSearchQuery(''); setSearchResults([]); inputRef.current?.focus(); };

  const handleEmailPress = useCallback((email: EmailListItem) => {
    router.push(`/${email.id}` as any);
  }, [router]);

  const highlightText = (text: string, query: string) => {
    if (!query.trim()) return <Text>{text}</Text>;
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
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

  const closeFilterModal = () => { setFilterModalVisible(false); setActiveFilterType(null); setFilterSearchQuery(''); };

  const selectFilterOption = (filter: string, option: string) => {
    setActiveFilters(prev => ({ ...prev, [filter]: option }));
    closeFilterModal();
  };

  const getFilteredOptions = () => {
    if (!activeFilterType) return [];
    const options = FILTER_OPTIONS[activeFilterType] || [];
    if (!filterSearchQuery.trim()) return options;
    return options.filter(opt => opt.label.toLowerCase().includes(filterSearchQuery.toLowerCase()));
  };

  const renderFilterChip = (filter: string) => {
    const selectedValue = activeFilters[filter];
    const isActive = !!selectedValue;
    return (
      <TouchableOpacity
        key={filter}
        style={[styles.filterChip, { borderColor: isActive ? '#3B82F6' : '#E5E7EB', backgroundColor: isActive ? '#EFF6FF' : 'transparent' }]}
        onPress={() => openFilterModal(filter)}
        activeOpacity={0.6}
      >
        <Text style={[styles.filterChipText, { color: isActive ? '#3B82F6' : colors.text }]}>
          {isActive ? selectedValue : filter}
        </Text>
        <ChevronDown size={14} color={isActive ? '#3B82F6' : colors.muted} strokeWidth={2} />
      </TouchableOpacity>
    );
  };

  const renderSearchResult = ({ item }: { item: EmailListItem }) => {
    const senderName = item.from?.name || item.from?.email || item.fromName || 'Unknown';
    const avatarColor = getAvatarColor(senderName);

    return (
      <TouchableOpacity
        style={[styles.resultItem, { backgroundColor: colors.background }]}
        onPress={() => handleEmailPress(item)}
        activeOpacity={0.7}
      >
        <View style={[styles.avatar, { backgroundColor: avatarColor + '40' }]}>
          <Text style={[styles.avatarText, { color: avatarColor }]}>
            {senderName.charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={styles.resultContent}>
          <View style={styles.resultTop}>
            <Text style={[
              styles.resultSender,
              { color: item.isRead ? colors.muted : colors.text, fontWeight: item.isRead ? '400' : '600' }
            ]} numberOfLines={1}>
              {highlightText(senderName.split('@')[0].split('<')[0].trim(), searchQuery)}
            </Text>
            <View style={styles.resultMeta}>
              <Text style={[styles.resultDate, { color: colors.muted }]}>
                {item.receivedDate
                  ? formatEmailTime(item.receivedDate)
                  : item.createdAt
                    ? formatEmailTime(item.createdAt)
                    : ''}
              </Text>
              {item.hasAttachments && (
                <Paperclip size={14} color={colors.muted} strokeWidth={2} />
              )}
              {item.isStarred && (
                <Star size={14} color="#F59E0B" fill="#F59E0B" strokeWidth={2} />
              )}
            </View>
          </View>
          <Text style={[
            styles.resultSubject,
            { color: item.isRead ? colors.muted : colors.text, fontWeight: item.isRead ? '400' : '600' }
          ]} numberOfLines={1}>
            {highlightText(item.subject || '(no subject)', searchQuery)}
          </Text>
          <Text style={[styles.resultPreview, { color: colors.muted }]} numberOfLines={1}>
            {highlightText(item.preview || item.snippet || '', searchQuery)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => {
    if (!searchQuery.trim()) {
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
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filtersScroll}>
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
        contentContainerStyle={[styles.resultsList, searchResults.length === 0 && styles.emptyList]}
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
          <View style={styles.modalGrabHandle} />
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>{activeFilterType}</Text>
            <TouchableOpacity style={styles.modalCloseButton} onPress={closeFilterModal}>
              <X size={20} color={colors.muted} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {activeFilters[activeFilterType || ''] && (
            <TouchableOpacity
              style={styles.modalClearButton}
              onPress={() => {
                setActiveFilters(prev => {
                  const next = { ...prev };
                  delete next[activeFilterType || ''];
                  return next;
                });
                closeFilterModal();
              }}
            >
              <Text style={styles.modalClearText}>Clear filter</Text>
            </TouchableOpacity>
          )}

          <ScrollView style={styles.modalOptionsList} showsVerticalScrollIndicator={false}>
            {getFilteredOptions().map((option, index) => {
              const IconComponent = option.icon;
              const isSelected = activeFilters[activeFilterType || ''] === option.label;
              return (
                <TouchableOpacity
                  key={index}
                  style={[styles.modalOption, isSelected && styles.modalOptionSelected]}
                  onPress={() => selectFilterOption(activeFilterType || '', option.label)}
                  activeOpacity={0.6}
                >
                  <IconComponent size={20} color={isSelected ? '#374151' : '#6B7280'} strokeWidth={1.8} />
                  <Text style={[styles.modalOptionText, { color: isSelected ? '#374151' : colors.text }]}>
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
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 6, borderBottomWidth: 0.5 },
  backButton: { padding: 8 },
  searchInputWrapper: { flex: 1, marginLeft: 4 },
  searchInput: { fontSize: 18, fontWeight: '400' },
  clearButton: { padding: 12 },
  filtersContainer: { paddingVertical: 10 },
  filtersScroll: { paddingHorizontal: 12, gap: 8 },
  filterChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, gap: 4 },
  filterChipText: { fontSize: 14, fontWeight: '400' },
  sortOption: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  sortText: { fontSize: 14, fontWeight: '500' },
  resultsList: { paddingBottom: 20 },
  emptyList: { flex: 1 },
  resultItem: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12, gap: 12, borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB' },
  avatar: { width: 30, height: 30, borderRadius: 9, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: 13, fontWeight: '500' },
  resultContent: { flex: 1, gap: 3 },
  resultTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  resultSender: { fontSize: 14, flex: 1, marginRight: 8 },
  resultDate: { fontSize: 12 },
  resultSubject: { fontSize: 14 },
  resultPreview: { fontSize: 13, lineHeight: 16 },
  resultMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  highlight: { backgroundColor: '#FEF08A' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 80, paddingHorizontal: 32, gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '600' },
  emptyText: { fontSize: 14, textAlign: 'center' },
  // Modal styles
  modalContainer: { flex: 1 },
  modalGrabHandle: { width: 36, height: 5, borderRadius: 3, backgroundColor: '#D1D5DB', alignSelf: 'center', marginTop: 8 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  modalCloseButton: { position: 'absolute', right: 20, width: 32, height: 32, borderRadius: 16, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  modalTitle: { fontSize: 18, fontWeight: '600' },
  modalClearButton: { paddingHorizontal: 20, paddingBottom: 12 },
  modalClearText: { fontSize: 14, fontWeight: '500', color: '#3B82F6' },
  modalOptionsList: { flex: 1 },
  modalOption: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14, marginHorizontal: 12, borderRadius: 10 },
  modalOptionSelected: { backgroundColor: '#F3F4F6' },
  modalOptionText: { fontSize: 15, fontWeight: '400' },
});
