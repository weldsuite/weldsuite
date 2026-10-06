import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useRouter } from 'expo-router';
import { Search as SearchIcon, X, Hash, MessageSquare, Users, Clock, Image as ImageIcon, Film, Link2, FileText, Music, Sticker, Paperclip } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi } from '@/services/app-api';
import { SearchField } from '@/components/chat/SearchField';
import type { ChatSearchResult } from '@weldsuite/app-api-client/domains/chat-search';

const RECENT_SEARCHES_KEY = 'weldchat_recent_searches';
const MAX_RECENT = 8;

// WhatsApp-style search categories: "Chats"/"People" search by text/name; the
// media categories refine message results to those carrying that attachment
// type (or, for Links, a URL in the text).
type FilterTab = 'all' | 'people' | 'photos' | 'videos' | 'links' | 'gifs' | 'audio' | 'docs';

const TABS: { key: FilterTab; label: string; Icon: typeof SearchIcon | null }[] = [
  { key: 'all', label: 'All', Icon: null },
  { key: 'people', label: 'People', Icon: Users },
  { key: 'photos', label: 'Photos', Icon: ImageIcon },
  { key: 'videos', label: 'Videos', Icon: Film },
  { key: 'links', label: 'Links', Icon: Link2 },
  { key: 'gifs', label: 'GIFs', Icon: Sticker },
  { key: 'audio', label: 'Audio', Icon: Music },
  { key: 'docs', label: 'Documents', Icon: FileText },
];

interface Attachment {
  url?: string;
  fileName?: string;
  mimeType?: string;
}

interface SearchResult {
  id: string;
  content: string;
  authorName: string;
  authorAvatar?: string;
  channelId: string;
  channelName?: string;
  channelType?: string;
  createdAt: string;
  attachments: Attachment[];
}

/** Whether a message result belongs to a media/links category filter. */
function matchesCategory(r: SearchResult, tab: FilterTab): boolean {
  if (tab === 'all' || tab === 'people') return true;
  if (tab === 'links') return /https?:\/\//i.test(r.content);
  const atts = r.attachments ?? [];
  const mt = (a: Attachment) => (a.mimeType ?? '').toLowerCase();
  switch (tab) {
    case 'photos':
      return atts.some((a) => mt(a).startsWith('image/') && mt(a) !== 'image/gif');
    case 'gifs':
      return atts.some((a) => mt(a) === 'image/gif');
    case 'videos':
      return atts.some((a) => mt(a).startsWith('video/'));
    case 'audio':
      return atts.some((a) => mt(a).startsWith('audio/'));
    case 'docs':
      return atts.some((a) => {
        const m = mt(a);
        return !!m && !m.startsWith('image/') && !m.startsWith('video/') && !m.startsWith('audio/');
      });
    default:
      return true;
  }
}

interface MemberResult {
  userId: string;
  name: string;
  email?: string;
  picture?: string;
}

type Styles = ReturnType<typeof makeStyles>;

interface SearchOutcome {
  ok: boolean;
  results: SearchResult[];
  members: MemberResult[];
}

async function loadRecentSearches(): Promise<string[]> {
  const stored = await AsyncStorage.getItem(RECENT_SEARCHES_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

function useRecentSearches() {
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  // Load recent searches on mount
  useEffect(() => {
    loadRecentSearches()
      .then(setRecentSearches)
      // Recent searches are a convenience; unreadable storage just means none.
      .catch(() => setRecentSearches([]));
  }, []);

  const saveRecentSearch = useCallback(async (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    const updated = [trimmed, ...recentSearches.filter((s) => s !== trimmed)].slice(0, MAX_RECENT);
    setRecentSearches(updated);
    await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
  }, [recentSearches]);

  const removeRecentSearch = useCallback(async (term: string) => {
    const updated = recentSearches.filter((s) => s !== term);
    setRecentSearches(updated);
    await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
  }, [recentSearches]);

  const clearAllRecent = useCallback(async () => {
    setRecentSearches([]);
    await AsyncStorage.removeItem(RECENT_SEARCHES_KEY);
  }, []);

  return { recentSearches, saveRecentSearch, removeRecentSearch, clearAllRecent };
}

async function searchMembers(text: string): Promise<MemberResult[]> {
  const res = await appApi.chatMembers.list();
  const all: MemberResult[] = (res.data ?? []) as unknown as MemberResult[];
  const q = text.toLowerCase();
  return all.filter((m) =>
    m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q)
  );
}

function toSearchResult(m: ChatSearchResult): SearchResult {
  return {
    id: m.id,
    content: m.content ?? '',
    authorName: m.authorName ?? 'Unknown',
    authorAvatar: m.authorAvatar ?? undefined,
    channelId: m.channelId,
    channelName: m.channel?.name,
    channelType: m.channel?.type,
    createdAt: m.createdAt,
    attachments: Array.isArray(m.attachments) ? (m.attachments as Attachment[]) : [],
  };
}

async function searchMessages(text: string): Promise<SearchResult[]> {
  const res = await appApi.chatSearch.search({ q: text.trim(), limit: 50 });
  const messages: ChatSearchResult[] = res.data?.messages ?? [];
  return messages.map(toSearchResult);
}

/** Runs the search for the active tab; never throws (`ok` is false on failure). */
async function searchChat(text: string, tab: FilterTab): Promise<SearchOutcome> {
  try {
    if (tab === 'people') {
      return { ok: true, results: [], members: await searchMembers(text) };
    }
    return { ok: true, results: await searchMessages(text), members: [] };
  } catch (err) {
    console.error('Search failed:', err);
    return { ok: false, results: [], members: [] };
  }
}

function resultPath(item: SearchResult): string {
  return item.channelType === 'dm' ? `/dm/${item.channelId}` : `/channel/${item.channelId}`;
}

function FilterTabButton({
  tab,
  active,
  mutedColor,
  styles,
  onPress,
}: {
  tab: (typeof TABS)[number];
  active: boolean;
  mutedColor: string;
  styles: Styles;
  onPress: (key: FilterTab) => void;
}) {
  const Icon = tab.Icon;
  return (
    <TouchableOpacity
      style={[styles.tab, active && styles.tabActive]}
      onPress={() => onPress(tab.key)}
    >
      {Icon && <Icon size={14} color={active ? '#fff' : mutedColor} />}
      <Text style={[styles.tabText, active && styles.tabTextActive]}>
        {tab.label}
      </Text>
    </TouchableOpacity>
  );
}

/** What shows before anything is searched: recent searches, or a prompt. */
function IdleState({
  showRecent,
  recentSearches,
  colors,
  styles,
  onClearAll,
  onTap,
  onRemove,
}: {
  showRecent: boolean;
  recentSearches: string[];
  colors: ThemeColors;
  styles: Styles;
  onClearAll: () => void;
  onTap: (term: string) => void;
  onRemove: (term: string) => void;
}) {
  if (!showRecent) {
    return (
      <View style={styles.emptyState}>
        <SearchIcon size={40} color={colors.muted} />
        <Text style={styles.emptyTitle}>Search your workspace</Text>
        <Text style={styles.emptyText}>
          Find messages, people, files, and more
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.recentContainer}>
      <View style={styles.recentHeader}>
        <Text style={styles.recentTitle}>Recent Searches</Text>
        <TouchableOpacity onPress={onClearAll}>
          <Text style={styles.recentClear}>Clear all</Text>
        </TouchableOpacity>
      </View>
      {recentSearches.map((term) => (
        <TouchableOpacity
          key={term}
          style={styles.recentItem}
          onPress={() => onTap(term)}
          activeOpacity={0.7}
        >
          <Clock size={16} color={colors.muted} />
          <Text style={styles.recentText} numberOfLines={1}>{term}</Text>
          <TouchableOpacity
            onPress={() => onRemove(term)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={14} color={colors.muted} />
          </TouchableOpacity>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function PersonRow({
  item,
  styles,
  onPress,
}: {
  item: MemberResult;
  styles: Styles;
  onPress: (userId: string) => void;
}) {
  return (
    <TouchableOpacity
      style={styles.personItem}
      activeOpacity={0.7}
      onPress={() => onPress(item.userId)}
    >
      <View style={styles.personAvatar}>
        <Text style={styles.personAvatarText}>
          {(item.name || '?')[0].toUpperCase()}
        </Text>
      </View>
      <View style={styles.personInfo}>
        <Text style={styles.personName}>{item.name}</Text>
        {item.email && (
          <Text style={styles.personEmail} numberOfLines={1}>{item.email}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

function PeopleList({
  members,
  showEmpty,
  colors,
  styles,
  onPressPerson,
}: {
  members: MemberResult[];
  showEmpty: boolean;
  colors: ThemeColors;
  styles: Styles;
  onPressPerson: (userId: string) => void;
}) {
  return (
    <FlatList
      data={members}
      keyExtractor={(item) => item.userId}
      contentContainerStyle={members.length === 0 ? styles.emptyListContainer : styles.list}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => (
        <PersonRow item={item} styles={styles} onPress={onPressPerson} />
      )}
      ListEmptyComponent={showEmpty ? (
        <View style={styles.emptyState}>
          <Users size={36} color={colors.muted} />
          <Text style={styles.emptyTitle}>No people found</Text>
        </View>
      ) : null}
    />
  );
}

function ResultRow({
  item,
  colors,
  styles,
  onPress,
}: {
  item: SearchResult;
  colors: ThemeColors;
  styles: Styles;
  onPress: (item: SearchResult) => void;
}) {
  const att = item.attachments?.[0];
  return (
    <TouchableOpacity
      style={styles.resultItem}
      onPress={() => onPress(item)}
      activeOpacity={0.7}
    >
      <View style={styles.resultHeader}>
        <View style={styles.resultChannel}>
          {item.channelType === 'dm' ? (
            <MessageSquare size={12} color={colors.muted} />
          ) : (
            <Hash size={12} color={colors.muted} />
          )}
          <Text style={styles.resultChannelName} numberOfLines={1}>
            {item.channelName || 'Unknown'}
          </Text>
        </View>
        <Text style={styles.resultTime}>
          {new Date(item.createdAt).toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
          })}
        </Text>
      </View>
      <Text style={styles.resultAuthor}>{item.authorName}</Text>
      {item.content ? (
        <Text style={styles.resultContent} numberOfLines={2}>
          {item.content}
        </Text>
      ) : null}
      {att && (
        <View style={styles.resultAttachment}>
          <Paperclip size={12} color={colors.muted} />
          <Text style={styles.resultAttachmentName} numberOfLines={1}>
            {att.fileName || att.mimeType || 'Attachment'}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

function ResultsList({
  results,
  showEmpty,
  colors,
  styles,
  onPressResult,
}: {
  results: SearchResult[];
  showEmpty: boolean;
  colors: ThemeColors;
  styles: Styles;
  onPressResult: (item: SearchResult) => void;
}) {
  return (
    <FlatList
      data={results}
      keyExtractor={(item) => item.id}
      contentContainerStyle={results.length === 0 ? styles.emptyListContainer : styles.list}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => (
        <ResultRow item={item} colors={colors} styles={styles} onPress={onPressResult} />
      )}
      ListEmptyComponent={showEmpty ? (
        <View style={styles.emptyState}>
          <SearchIcon size={36} color={colors.muted} />
          <Text style={styles.emptyTitle}>No results found</Text>
          <Text style={styles.emptyText}>Try a different search term</Text>
        </View>
      ) : null}
    />
  );
}

export default function SearchScreen() {
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [members, setMembers] = useState<MemberResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const { recentSearches, saveRecentSearch, removeRecentSearch, clearAllRecent } = useRecentSearches();
  const inputRef = useRef<TextInput>(null);
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top), [colors, insets.top]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const performSearch = useCallback((text: string, tab: FilterTab) => {
    clearTimeout(debounceRef.current);

    if (!text.trim()) {
      setResults([]);
      setMembers([]);
      setSearched(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      const outcome = await searchChat(text, tab);
      setResults(outcome.results);
      setMembers(outcome.members);
      setLoading(false);
      setSearched(true);
      if (outcome.ok) saveRecentSearch(text.trim());
    }, 400);
  }, [saveRecentSearch]);

  const handleSearch = useCallback((text: string) => {
    setQuery(text);
    performSearch(text, activeTab);
  }, [activeTab, performSearch]);

  const handleRecentTap = useCallback((term: string) => {
    setQuery(term);
    performSearch(term, activeTab);
  }, [activeTab, performSearch]);

  const handleTabChange = useCallback((tab: FilterTab) => {
    setActiveTab(tab);
    setSearched(false);
    performSearch(query, tab);
  }, [query, performSearch]);

  const handleResultPress = useCallback((item: SearchResult) => {
    router.push(resultPath(item) as any);
  }, [router]);

  const handlePersonPress = useCallback((userId: string) => {
    router.push(`/user/${userId}` as any);
  }, [router]);

  const clearSearch = useCallback(() => {
    setQuery('');
    setResults([]);
    setMembers([]);
    setSearched(false);
    inputRef.current?.focus();
  }, []);

  const showPeople = activeTab === 'people';
  // Media / links categories refine the message results client-side.
  const displayResults = useMemo(
    () => results.filter((r) => matchesCategory(r, activeTab)),
    [results, activeTab],
  );
  const hasResults = showPeople ? members.length > 0 : displayResults.length > 0;
  const showEmpty = searched && !loading && !hasResults && query.trim().length > 0;
  const showRecent = !query.trim() && recentSearches.length > 0;

  let content: ReactNode;
  if (!searched && !query.trim()) {
    content = (
      <IdleState
        showRecent={showRecent}
        recentSearches={recentSearches}
        colors={colors}
        styles={styles}
        onClearAll={clearAllRecent}
        onTap={handleRecentTap}
        onRemove={removeRecentSearch}
      />
    );
  } else if (showPeople) {
    content = (
      <PeopleList
        members={members}
        showEmpty={showEmpty}
        colors={colors}
        styles={styles}
        onPressPerson={handlePersonPress}
      />
    );
  } else {
    content = (
      <ResultsList
        results={displayResults}
        showEmpty={showEmpty}
        colors={colors}
        styles={styles}
        onPressResult={handleResultPress}
      />
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <SearchField
            inputRef={inputRef}
            value={query}
            onChangeText={handleSearch}
            placeholder="Search"
            autoFocus
            onClear={clearSearch}
            style={styles.searchFieldFlex}
          />
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.cancelBtn}>Cancel</Text>
          </TouchableOpacity>
        </View>

        {/* Filter tabs */}
        <View style={styles.tabBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabScroll}>
            {TABS.map((tab) => (
              <FilterTabButton
                key={tab.key}
                tab={tab}
                active={activeTab === tab.key}
                mutedColor={colors.muted}
                styles={styles}
                onPress={handleTabChange}
              />
            ))}
          </ScrollView>
        </View>

        {/* Content */}
        {content}
      </View>
    </>
  );
}

const makeStyles = (c: ThemeColors, topInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: topInset + 12,
      paddingHorizontal: 16,
      paddingBottom: 4,
      backgroundColor: c.background,
      gap: 12,
    },
    cancelBtn: { fontSize: 15, color: BRAND, fontWeight: '600' },
    searchFieldFlex: { flex: 1 },
    tabBar: {
      borderBottomWidth: 1,
      borderBottomColor: c.secondary,
    },
    tabScroll: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      gap: 6,
    },
    tab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 18,
      backgroundColor: c.secondary,
    },
    tabActive: {
      backgroundColor: BRAND,
    },
    tabText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.muted,
    },
    tabTextActive: {
      color: '#fff',
    },
    recentContainer: {
      paddingTop: 8,
    },
    recentHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    recentTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: c.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    recentClear: {
      fontSize: 13,
      color: BRAND,
      fontWeight: '600',
    },
    recentItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 11,
      gap: 12,
    },
    recentText: {
      flex: 1,
      fontSize: 15,
      color: c.text,
    },
    list: { paddingVertical: 4 },
    emptyListContainer: { flex: 1 },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
      gap: 8,
    },
    emptyTitle: { fontSize: 18, fontWeight: '600', color: c.text },
    emptyText: { fontSize: 14, color: c.muted, textAlign: 'center' },
    resultItem: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.secondary,
    },
    resultHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    resultChannel: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      flex: 1,
    },
    resultChannelName: { fontSize: 12, color: c.muted, fontWeight: '500' },
    resultTime: { fontSize: 12, color: c.muted },
    resultAuthor: {
      fontSize: 14,
      fontWeight: '600',
      color: c.text,
      marginBottom: 2,
    },
    resultContent: {
      fontSize: 14,
      lineHeight: 20,
      color: c.mutedForeground,
    },
    resultAttachment: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      marginTop: 4,
    },
    resultAttachmentName: {
      flex: 1,
      fontSize: 13,
      color: c.muted,
      fontWeight: '500',
    },
    personItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.secondary,
    },
    personAvatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: BRAND,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    personAvatarText: { fontSize: 16, fontWeight: '700', color: '#fff' },
    personInfo: { flex: 1 },
    personName: { fontSize: 15, fontWeight: '600', color: c.text },
    personEmail: { fontSize: 13, color: c.muted, marginTop: 1 },
  });
