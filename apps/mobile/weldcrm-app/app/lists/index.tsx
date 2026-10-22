import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { Building2, ChevronRight, Plus, User } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { StackHeader } from '@/components/headers';
import { FormField } from '@/components/form';
import { usePagedList } from '@/hooks/use-paged-list';
import { listsApi, type CrmList, type ListKind } from '@/services/lists';
import { interpolate, useI18n } from '@/lib/i18n';

type KindFilter = ListKind | 'all';

const KIND_FILTERS: readonly KindFilter[] = ['all', 'company', 'person'];

interface NewListModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: (list: CrmList) => void;
}

/** Name and type for a new list. The type is fixed once the list exists. */
function NewListModal({ visible, onClose, onCreated }: Readonly<NewListModalProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ListKind>('company');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setName('');
      setKind('company');
      setError(null);
    }
  }, [visible]);

  const submit = async () => {
    if (saving) return;
    if (!name.trim()) {
      setError(interpolate(t.validation.required, { field: t.lists.nameLabel }));
      return;
    }
    setSaving(true);
    const res = await listsApi.createList({ name, kind });
    setSaving(false);
    if (res.success && res.data) {
      toast.success(t.lists.createdToast);
      onCreated(res.data);
    } else {
      toast.error(t.lists.createFailed);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={[styles.modalCard, { backgroundColor: colors.background }]}>
          <Text style={[styles.modalTitle, { color: colors.text }]} accessibilityRole="header">
            {t.lists.createTitle}
          </Text>
          <FormField
            label={t.lists.nameLabel}
            required
            value={name}
            onChangeText={(value) => {
              setName(value);
              setError(null);
            }}
            placeholder={t.lists.namePlaceholder}
            error={error}
            autoFocus
            maxLength={255}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
          <Text style={[styles.modalLabel, { color: colors.muted }]}>{t.lists.kindLabel}</Text>
          <SegmentedControl
            options={[
              { value: 'company', label: t.lists.kindCompany },
              { value: 'person', label: t.lists.kindPerson },
            ]}
            value={kind}
            onValueChange={(value) => setKind(value as ListKind)}
          />
          <Text style={[styles.modalHint, { color: colors.muted }]}>{t.lists.kindHint}</Text>
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalButton, { borderColor: colors.buttonBorder }]}
              onPress={onClose}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel={t.common.cancel}
            >
              <Text style={[styles.modalButtonText, { color: colors.text }]}>{t.common.cancel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modalButton,
                { backgroundColor: colors.text, borderColor: colors.text, opacity: saving ? 0.6 : 1 },
              ]}
              onPress={() => void submit()}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel={t.common.create}
            >
              {saving ? (
                <ActivityIndicator color={colors.background} />
              ) : (
                <Text style={[styles.modalButtonText, { color: colors.background }]}>{t.common.create}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function ListsScreen() {
  const { colors } = useTheme();
  const { t, plural } = useI18n();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [creating, setCreating] = useState(false);

  const fetchLists = useCallback(
    (params: { cursor: string | null; search: string }) =>
      listsApi.getLists({ ...params, kind: kind === 'all' ? undefined : kind }),
    [kind],
  );
  const lists = usePagedList<CrmList>(fetchLists, { search, resetKey: kind });

  useEffect(() => {
    if (lists.error) toast.error(t.lists.loadFailed);
  }, [lists.error, t, toast]);

  const openList = (list: CrmList) => {
    router.push({ pathname: '/lists/[id]', params: { id: list.id, name: list.name, kind: list.kind } });
  };

  const handleCreated = (list: CrmList) => {
    setCreating(false);
    lists.addItem(list);
    openList(list);
  };

  const kindLabel = (value: KindFilter) => {
    if (value === 'company') return t.lists.kindCompany;
    if (value === 'person') return t.lists.kindPerson;
    return t.lists.filterAll;
  };

  const renderEmpty = () => {
    if (lists.loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      );
    }
    if (lists.error) {
      return (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t.lists.loadFailed}</Text>
          <Text style={[styles.emptyText, { color: colors.muted }]}>{t.common.pullToRetry}</Text>
        </View>
      );
    }
    const filtered = !!search || kind !== 'all';
    return (
      <View style={styles.emptyState}>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {filtered ? t.lists.emptyFiltered : t.lists.empty}
        </Text>
        {!filtered && <Text style={[styles.emptyText, { color: colors.muted }]}>{t.lists.emptyHint}</Text>}
      </View>
    );
  };

  const renderItem = ({ item }: { item: CrmList }) => {
    const Icon = item.kind === 'company' ? Building2 : User;
    const count = plural(
      item.memberCount,
      item.kind === 'company' ? t.lists.memberCountCompany : t.lists.memberCountPerson,
    );
    return (
      <TouchableOpacity
        style={[styles.card, { backgroundColor: colors.background, borderColor: colors.divider }]}
        activeOpacity={0.7}
        onPress={() => openList(item)}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${count}`}
      >
        <View style={[styles.avatar, item.kind === 'person' && styles.avatarRound]}>
          <Icon size={20} color="#4F46E5" />
        </View>
        <View style={styles.cardMain}>
          <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={[styles.cardSubtitle, { color: colors.muted }]} numberOfLines={1}>
            {item.description ? `${count} · ${item.description}` : count}
          </Text>
        </View>
        <ChevronRight size={18} color={colors.muted} />
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={t.lists.title}
        onBack={() => router.back()}
        right={
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => setCreating(true)}
            accessibilityRole="button"
            accessibilityLabel={t.lists.add}
          >
            <Plus size={24} color={colors.text} />
          </TouchableOpacity>
        }
      />

      <View style={[styles.searchBar, { backgroundColor: colors.inputBackground }]}>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={t.lists.searchPlaceholder}
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t.lists.searchPlaceholder}
        />
      </View>

      <View style={styles.filterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {KIND_FILTERS.map((value) => {
            const selected = kind === value;
            return (
              <TouchableOpacity
                key={value}
                style={[
                  styles.filterButton,
                  { backgroundColor: selected ? colors.text : 'transparent', borderColor: selected ? colors.text : colors.divider },
                ]}
                onPress={() => setKind(value)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={kindLabel(value)}
              >
                <Text style={[styles.filterButtonText, { color: selected ? colors.background : colors.text }]}>
                  {kindLabel(value)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <FlatList
        data={lists.items}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={lists.refreshing} onRefresh={() => void lists.refresh()} />}
        onEndReached={() => void lists.loadMore()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={lists.loadingMore ? <ActivityIndicator style={styles.footerSpinner} color={colors.text} /> : null}
        renderItem={renderItem}
      />

      <NewListModal visible={creating} onClose={() => setCreating(false)} onCreated={handleCreated} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 48 },
  iconButton: { padding: 8 },
  searchBar: { marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 10 },
  searchInput: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  filterContainer: { paddingTop: 8, paddingBottom: 8 },
  filterList: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  filterButton: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  filterButtonText: { fontSize: 13, fontWeight: '500' },
  listContent: { padding: 16, paddingTop: 8, flexGrow: 1 },
  footerSpinner: { paddingVertical: 16 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 48, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginBottom: 6, textAlign: 'center' },
  emptyText: { fontSize: 13, textAlign: 'center' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 12 },
  avatar: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#E0E7FF', justifyContent: 'center', alignItems: 'center' },
  avatarRound: { borderRadius: 22 },
  cardMain: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardSubtitle: { fontSize: 13, marginTop: 2 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'center', padding: 24 },
  modalCard: { borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 17, fontWeight: '600', marginBottom: 16 },
  modalLabel: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  modalHint: { fontSize: 12, marginTop: 8 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  modalButton: { flex: 1, paddingVertical: 12, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  modalButtonText: { fontSize: 15, fontWeight: '600' },
});
