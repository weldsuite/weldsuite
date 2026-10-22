import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Edit3, ListChecks, MoreHorizontal, Plus, Trash2, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { StackHeader } from '@/components/headers';
import { InitialsTile, RecordRow } from '@/components/record-row';
import { FormField } from '@/components/form';
import { CompanyPicker, PersonPicker } from '@/components/company-picker';
import { listsApi, type CrmList, type ListKind, type ListMember } from '@/services/lists';
import type { CompanyRecord, PersonRecord } from '@/services/api';
import { interpolate, useI18n } from '@/lib/i18n';

type LoadMode = 'initial' | 'refresh' | 'silent';

const asKind = (value: string | undefined): ListKind | null =>
  value === 'company' || value === 'person' ? value : null;

interface RenameModalProps {
  visible: boolean;
  initialName: string;
  onClose: () => void;
  onRenamed: (list: CrmList) => void;
  listId: string;
}

function RenameModal({ visible, initialName, onClose, onRenamed, listId }: Readonly<RenameModalProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setName(initialName);
      setError(null);
    }
  }, [visible, initialName]);

  const submit = async () => {
    if (saving) return;
    if (!name.trim()) {
      setError(interpolate(t.validation.required, { field: t.lists.nameLabel }));
      return;
    }
    setSaving(true);
    const res = await listsApi.renameList(listId, name);
    setSaving(false);
    if (res.success && res.data) {
      toast.success(t.lists.renamedToast);
      onRenamed(res.data);
    } else {
      toast.error(t.lists.renameFailed);
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
            {t.lists.renameTitle}
          </Text>
          <FormField
            label={t.lists.nameLabel}
            required
            value={name}
            onChangeText={(value) => {
              setName(value);
              setError(null);
            }}
            error={error}
            autoFocus
            maxLength={255}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
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
              accessibilityLabel={t.common.save}
            >
              {saving ? (
                <ActivityIndicator color={colors.background} />
              ) : (
                <Text style={[styles.modalButtonText, { color: colors.background }]}>{t.common.save}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function ListDetailScreen() {
  const { colors } = useTheme();
  const { t, plural } = useI18n();
  const toast = useToast();
  const params = useLocalSearchParams<{ id: string; name?: string; kind?: string }>();
  const id = params.id;
  const kindHint = asKind(params.kind);

  const [list, setList] = useState<CrmList | null>(null);
  const [members, setMembers] = useState<ListMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [picking, setPicking] = useState(false);

  const requestId = useRef(0);
  const loadedOnce = useRef(false);
  const adding = useRef(false);
  const loadRef = useRef<(mode: LoadMode) => Promise<void>>(() => Promise.resolve());

  const load = useCallback(
    async (mode: LoadMode) => {
      const current = ++requestId.current;
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);
      // A list's type never changes, so a hint from the previous screen lets both requests go out together.
      const [listRes, hintedMembers] = await Promise.all([
        listsApi.getList(id),
        kindHint ? listsApi.getMembers(id, kindHint) : Promise.resolve(null),
      ]);
      let membersRes = hintedMembers;
      if (listRes.success && listRes.data && (!membersRes || kindHint !== listRes.data.kind)) {
        membersRes = await listsApi.getMembers(id, listRes.data.kind);
      }
      if (current !== requestId.current) return;
      if (listRes.success && listRes.data && membersRes?.success && membersRes.data) {
        setList(listRes.data);
        setMembers(membersRes.data);
        setError(false);
        loadedOnce.current = true;
      } else if (mode !== 'silent') {
        setError(true);
      }
      setLoading(false);
      setRefreshing(false);
    },
    [id, kindHint],
  );

  useEffect(() => {
    loadRef.current = load;
    void load('initial');
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      // The first focus is the initial load above; later ones (back from a record) refetch quietly.
      if (loadedOnce.current) void loadRef.current('silent');
    }, []),
  );

  useEffect(() => {
    if (error) toast.error(list ? t.lists.membersLoadFailed : t.lists.notFound);
  }, [error, list, t, toast]);

  const kind: ListKind = list?.kind ?? kindHint ?? 'company';
  const title = list?.name ?? params.name ?? t.lists.title;
  const countText = plural(members.length, kind === 'company' ? t.lists.memberCountCompany : t.lists.memberCountPerson);

  const openMember = (member: ListMember) => {
    router.push({
      pathname: member.kind === 'company' ? '/company/[id]' : '/person/[id]',
      params: { id: member.id, name: member.name },
    });
  };

  const addMember = async (member: Omit<ListMember, 'memberId' | 'addedAt'>) => {
    if (adding.current) return;
    adding.current = true;
    const res = await listsApi.addMembers(id, [member.id]);
    adding.current = false;
    if (!res.success || !res.data) {
      toast.error(t.lists.addFailed);
      return;
    }
    if (res.data.added === 0) {
      toast.info(interpolate(t.lists.alreadyInList, { name: member.name }));
      return;
    }
    setMembers((prev) => [{ ...member, memberId: '', addedAt: new Date().toISOString() }, ...prev]);
    toast.success(interpolate(t.lists.addedToast, { name: member.name }));
  };

  const addCompany = (record: CompanyRecord) =>
    addMember({
      id: record.id,
      kind: 'company',
      name: record.name,
      subtitle: record.industry || record.email || undefined,
      email: record.email || undefined,
    });

  const addPerson = (record: PersonRecord) =>
    addMember({
      id: record.id,
      kind: 'person',
      name: record.name,
      subtitle: record.jobTitle || record.email || undefined,
      email: record.email || undefined,
    });

  const removeMember = async (member: ListMember) => {
    const res = await listsApi.removeMember(id, member.id);
    if (!res.success) {
      toast.error(t.lists.removeFailed);
      return;
    }
    setMembers((prev) => prev.filter((item) => item.id !== member.id));
    toast.success(t.lists.removedToast);
  };

  const confirmRemove = (member: ListMember) => {
    Alert.alert(t.lists.removeTitle, interpolate(t.lists.removeMessage, { name: member.name }), [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.common.delete, style: 'destructive', onPress: () => void removeMember(member) },
    ]);
  };

  const confirmDeleteList = () => {
    setMenuOpen(false);
    Alert.alert(t.lists.deleteTitle, interpolate(t.lists.deleteMessage, { name: title }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const res = await listsApi.deleteList(id);
            if (res.success) {
              toast.success(t.lists.deletedToast);
              router.back();
            } else {
              toast.error(t.lists.deleteFailed);
            }
          })();
        },
      },
    ]);
  };

  const renderEmpty = () => {
    const icon = <ListChecks size={32} color={colors.mutedForeground} />;
    if (loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      );
    }
    if (error) {
      return (
        <EmptyState
          icon={icon}
          title={list ? t.lists.membersLoadFailed : t.lists.notFound}
          description={t.common.pullToRetry}
        />
      );
    }
    return (
      <EmptyState
        icon={icon}
        title={kind === 'company' ? t.lists.emptyMembersCompany : t.lists.emptyMembersPerson}
        description={t.lists.emptyMembersHint}
      />
    );
  };

  const renderMember = ({ item }: { item: ListMember }) => (
    <RecordRow
      leading={<InitialsTile name={item.name} round={item.kind === 'person'} />}
      title={item.name}
      subtitle={item.subtitle || undefined}
      badge={
        <IconButton
          icon={<X size={18} color={colors.mutedForeground} />}
          size="sm"
          accessibilityLabel={interpolate(t.lists.removeMember, { name: item.name })}
          onPress={() => confirmRemove(item)}
        />
      }
      onPress={() => openMember(item)}
    />
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={title}
        onBack={() => router.back()}
        right={
          list ? (
            <>
              <IconButton
                icon={<Plus size={24} color={colors.text} />}
                accessibilityLabel={t.lists.addMember}
                onPress={() => setPicking(true)}
              />
              <IconButton
                icon={<MoreHorizontal size={22} color={colors.text} />}
                accessibilityLabel={interpolate(t.lists.actionsFor, { name: title })}
                onPress={() => setMenuOpen(true)}
              />
            </>
          ) : null
        }
      />

      {!!list && (
        <View style={[styles.summary, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.summaryCount, { color: colors.text }]}>{countText}</Text>
          {!!list.description && (
            <Text style={[styles.summaryDescription, { color: colors.mutedForeground }]}>{list.description}</Text>
          )}
        </View>
      )}

      <FlatList
        data={members}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} />}
        ListEmptyComponent={renderEmpty}
        renderItem={renderMember}
      />

      {kind === 'company' ? (
        <CompanyPicker
          visible={picking}
          onClose={() => setPicking(false)}
          onSelect={(record) => void addCompany(record)}
          excludeIds={members.map((member) => member.id)}
        />
      ) : (
        <PersonPicker
          visible={picking}
          onClose={() => setPicking(false)}
          onSelect={(record) => void addPerson(record)}
          excludeIds={members.map((member) => member.id)}
        />
      )}

      <RenameModal
        visible={renaming}
        listId={id}
        initialName={list?.name ?? ''}
        onClose={() => setRenaming(false)}
        onRenamed={(renamed) => {
          setRenaming(false);
          setList((prev) => (prev ? { ...prev, name: renamed.name, updatedAt: renamed.updatedAt } : renamed));
        }}
      />

      <Modal visible={menuOpen} animationType="fade" transparent onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.menuOverlay} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menuCard, { backgroundColor: colors.background }]}>
            <View style={[styles.menuHeader, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.menuName, { color: colors.text }]} numberOfLines={1}>
                {title}
              </Text>
              <TouchableOpacity
                onPress={() => setMenuOpen(false)}
                accessibilityRole="button"
                accessibilityLabel={t.common.close}
              >
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                setRenaming(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={t.lists.rename}
            >
              <Edit3 size={20} color={colors.text} />
              <Text style={[styles.menuItemText, { color: colors.text }]}>{t.lists.rename}</Text>
            </TouchableOpacity>
            <View style={[styles.menuDivider, { backgroundColor: colors.divider }]} />
            <TouchableOpacity
              style={styles.menuItem}
              onPress={confirmDeleteList}
              accessibilityRole="button"
              accessibilityLabel={t.lists.deleteList}
            >
              <Trash2 size={20} color={colors.destructive} />
              <Text style={[styles.menuItemText, { color: colors.destructive }]}>{t.lists.deleteList}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 48 },
  summary: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  summaryCount: { fontSize: 15, fontWeight: '600' },
  summaryDescription: { fontSize: 13, marginTop: 2 },
  listContent: { flexGrow: 1 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'center', padding: 24 },
  modalCard: { borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 17, fontWeight: '600', marginBottom: 16 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 4 },
  modalButton: { flex: 1, paddingVertical: 12, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  modalButtonText: { fontSize: 15, fontWeight: '600' },
  menuOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'flex-end' },
  menuCard: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 34 },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    gap: 12,
  },
  menuName: { flex: 1, fontSize: 16, fontWeight: '600' },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 14 },
  menuItemText: { fontSize: 16 },
  menuDivider: { height: 1, marginVertical: 4, marginHorizontal: 20 },
});
