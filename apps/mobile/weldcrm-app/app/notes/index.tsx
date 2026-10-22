import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { FileText, Plus, Star } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { StackHeader } from '@/components/headers';
import { useMembers } from '@/components/member-picker';
import { usePagedList } from '@/hooks/use-paged-list';
import { notesApi, type NoteRecord } from '@/services/notes';
import { useI18n } from '@/lib/i18n';
import { groupNotes } from '@/lib/note-groups';
import { htmlToText } from '@/lib/note-text';

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
          <TouchableOpacity
            style={[styles.addButton, { borderColor: colors.buttonBorder }]}
            onPress={() => router.push({ pathname: '/note/[id]', params: { id: 'new' } })}
            accessibilityRole="button"
            accessibilityLabel={t.notes.add}
          >
            <Plus size={18} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
        }
      />
      <View style={[styles.searchBar, { backgroundColor: colors.inputBackground }]}>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={t.notes.search}
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      {list.loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={() => void list.refresh()} />}
          onEndReached={() => void list.loadMore()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={list.loadingMore ? <ActivityIndicator style={styles.footer} color={colors.text} /> : null}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.notes.sections[section.key]}</Text>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <FileText size={32} color={colors.muted} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>{list.error ? t.notes.loadFailed : t.notes.emptyTitle}</Text>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                {list.error ? t.common.pullToRetry : t.notes.emptyText}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const preview = htmlToText(item.html).split('\n').slice(1).join(' ').trim();
            const author = item.authorId ? byId.get(item.authorId)?.name : undefined;
            return (
              <TouchableOpacity
                style={[styles.note, { borderColor: colors.divider }]}
                onPress={() => router.push({ pathname: '/note/[id]', params: { id: item.id } })}
                accessibilityRole="button"
                accessibilityLabel={item.subject}
              >
                <View style={styles.noteHeader}>
                  <Text style={[styles.noteTitle, { color: colors.text }]} numberOfLines={1}>
                    {item.subject}
                  </Text>
                  {item.isFavorite && <Star size={14} color="#F59E0B" fill="#F59E0B" />}
                </View>
                {!!preview && (
                  <Text style={[styles.notePreview, { color: colors.muted }]} numberOfLines={2}>
                    {preview}
                  </Text>
                )}
                <Text style={[styles.noteMeta, { color: colors.muted }]} numberOfLines={1}>
                  {[item.record?.name, author, time(item.updatedAt)].filter(Boolean).join(' · ')}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  addButton: { width: 36, height: 36, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  searchBar: { marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 10 },
  searchInput: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  listContent: { padding: 16, paddingTop: 8, flexGrow: 1 },
  footer: { paddingVertical: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '600', marginTop: 12, marginBottom: 8 },
  note: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 10, gap: 6 },
  noteHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noteTitle: { flex: 1, fontSize: 15, fontWeight: '600' },
  notePreview: { fontSize: 13, lineHeight: 18 },
  noteMeta: { fontSize: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80, paddingHorizontal: 40, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptyText: { fontSize: 13, textAlign: 'center' },
});
