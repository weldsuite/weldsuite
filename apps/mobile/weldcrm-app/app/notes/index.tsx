import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { FileText, Plus, Star } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { StackHeader } from '@/components/headers';
import { useMembers } from '@/components/member-picker';
import { RecordRow } from '@/components/record-row';
import { usePagedList } from '@/hooks/use-paged-list';
import { notesApi, type NoteRecord } from '@/services/notes';
import { useI18n } from '@/lib/i18n';
import { groupNotes } from '@/lib/note-groups';
import { htmlToText } from '@/lib/note-text';

/** Every note in the workspace, pinned first, then by day; like the web's Notes page. */
export default function NotesScreen() {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const { byId } = useMembers();
  const [search, setSearch] = useState('');

  const fetchNotes = useCallback(
    (params: { cursor: string | null; search: string }) => notesApi.list({ ...params, limit: 50 }),
    [],
  );
  const list = usePagedList<NoteRecord>(fetchNotes, { search });

  useEffect(() => {
    if (list.error) toast.error(t.notes.loadFailed);
  }, [list.error, t, toast]);

  const sections = groupNotes(list.items);
  const time = (iso: string) =>
    new Date(iso).toLocaleString(intlLocale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={t.notes.title}
        onBack={() => router.back()}
        right={
          <IconButton
            icon={<Plus size={22} color={colors.text} />}
            accessibilityLabel={t.notes.add}
            onPress={() => router.push({ pathname: '/note/[id]', params: { id: 'new' } })}
          />
        }
      />
      <View style={styles.searchWrap}>
        <SearchBar value={search} onChangeText={setSearch} placeholder={t.notes.search} containerStyle={styles.search} />
      </View>

      {list.loading ? (
        <ActivityIndicator style={styles.loading} size="large" color={colors.text} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={sections.length === 0 ? styles.emptyContainer : undefined}
          stickySectionHeadersEnabled={false}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={() => void list.refresh()} />}
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={list.loadingMore ? <ActivityIndicator style={styles.footer} color={colors.text} /> : null}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>{t.notes.sections[section.key]}</Text>
          )}
          ListEmptyComponent={
            <EmptyState
              icon={<FileText size={32} color={colors.mutedForeground} />}
              title={list.error ? t.notes.loadFailed : t.notes.emptyTitle}
              description={list.error ? t.common.pullToRetry : t.notes.emptyText}
            />
          }
          renderItem={({ item }) => {
            const preview = htmlToText(item.html).split('\n').slice(1).join(' ').trim();
            const author = item.authorId ? byId.get(item.authorId)?.name : undefined;
            return (
              <RecordRow
                testID="note-row"
                title={item.subject}
                subtitle={preview || undefined}
                meta={[item.record?.name, author, time(item.updatedAt)].filter(Boolean).join(' · ')}
                badge={item.isFavorite ? <Star size={14} color="#F59E0B" fill="#F59E0B" /> : undefined}
                onPress={() => router.push({ pathname: '/note/[id]', params: { id: item.id } })}
              />
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchWrap: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  search: { borderRadius: 12 },
  loading: { marginTop: 48 },
  footer: { paddingVertical: 16 },
  sectionLabel: { fontSize: 13, fontWeight: '600', marginTop: 20, marginBottom: 4, paddingHorizontal: 16 },
  emptyContainer: { flexGrow: 1 },
});
