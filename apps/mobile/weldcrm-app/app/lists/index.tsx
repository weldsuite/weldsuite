import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { Building2, ListChecks, Plus, User } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { StackHeader } from '@/components/headers';
import { RecordRow } from '@/components/record-row';
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
    const icon = <ListChecks size={32} color={colors.mutedForeground} />;
    if (lists.loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      );
    }
    if (lists.error) {
      return <EmptyState icon={icon} title={t.lists.loadFailed} description={t.common.pullToRetry} />;
    }
    const filtered = !!search || kind !== 'all';
    return (
      <EmptyState
        icon={icon}
        title={filtered ? t.lists.emptyFiltered : t.lists.empty}
        description={filtered ? undefined : t.lists.emptyHint}
      />
    );
  };

  const renderItem = ({ item }: { item: CrmList }) => {
    const Icon = item.kind === 'company' ? Building2 : User;
    const count = plural(
      item.memberCount,
      item.kind === 'company' ? t.lists.memberCountCompany : t.lists.memberCountPerson,
    );
    return (
      <RecordRow
        leading={
          <View style={[styles.tile, item.kind === 'person' && styles.tileRound]}>
            <Icon size={20} color="#4F46E5" />
          </View>
        }
        title={item.name}
        subtitle={item.description ? `${count} · ${item.description}` : count}
        onPress={() => openList(item)}
      />
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={t.lists.title}
        onBack={() => router.back()}
        right={
          <IconButton
            icon={<Plus size={24} color={colors.text} />}
            accessibilityLabel={t.lists.add}
            onPress={() => setCreating(true)}
          />
        }
      />

      <View style={styles.controls}>
        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder={t.lists.searchPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={styles.search}
        />
        <View style={styles.chips}>
          {KIND_FILTERS.map((value) => (
            <Chip key={value} label={kindLabel(value)} selected={kind === value} onPress={() => setKind(value)} />
          ))}
        </View>
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
  controls: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, gap: 10 },
  search: { borderRadius: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  listContent: { flexGrow: 1 },
  footerSpinner: { paddingVertical: 16 },
  tile: { width: 38, height: 38, borderRadius: 12, backgroundColor: '#E0E7FF', justifyContent: 'center', alignItems: 'center' },
  tileRound: { borderRadius: 19 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'center', padding: 24 },
  modalCard: { borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 17, fontWeight: '600', marginBottom: 16 },
  modalLabel: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  modalHint: { fontSize: 12, marginTop: 8 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  modalButton: { flex: 1, paddingVertical: 12, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  modalButtonText: { fontSize: 15, fontWeight: '600' },
});
