/**
 * Full-screen pickers that list the workspace's companies or people with
 * server-side search. Used wherever a record has to point at a company or a
 * person: deals, tasks, notes, activities, list members, links.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Building2, User, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { api, type CompanyRecord, type PersonRecord } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { initialsOf } from '@/lib/crm';

const SEARCH_DEBOUNCE_MS = 300;

interface PickerRow {
  id: string;
  name: string;
  sub?: string;
}

interface RecordPickerProps<T extends { id: string }> {
  visible: boolean;
  title: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyHint: string;
  icon: 'company' | 'person';
  /** Ids already chosen; shown but not selectable. */
  excludeIds?: readonly string[];
  load: (search: string) => Promise<T[] | null>;
  toRow: (item: T) => PickerRow;
  onClose: () => void;
  onSelect: (item: T) => void;
}

function RecordPicker<T extends { id: string }>({
  visible,
  title,
  searchPlaceholder,
  emptyTitle,
  emptyHint,
  icon,
  excludeIds,
  load,
  toRow,
  onClose,
  onSelect,
}: Readonly<RecordPickerProps<T>>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  // Only the latest request may write state, so a slow earlier search can't overwrite a newer one.
  const requestId = useRef(0);

  const run = useCallback(
    async (term: string) => {
      const current = ++requestId.current;
      setLoading(true);
      const found = await load(term);
      if (current !== requestId.current) return;
      if (found) {
        setItems(found);
      } else {
        toast.error(t.picker.loadFailed);
      }
      setLoading(false);
    },
    [load, t, toast],
  );

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => void run(search), search ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [visible, search, run]);

  useEffect(() => {
    if (visible) setSearch('');
  }, [visible]);

  const excluded = new Set(excludeIds ?? []);
  const Icon = icon === 'company' ? Building2 : User;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">
            {title}
          </Text>
          <TouchableOpacity
            onPress={onClose}
            style={styles.close}
            accessibilityRole="button"
            accessibilityLabel={t.common.close}
          >
            <X size={22} color={colors.text} />
          </TouchableOpacity>
        </View>
        <View style={[styles.searchBox, { backgroundColor: colors.inputBackground }]}>
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder={searchPlaceholder}
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>
        {loading && items.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text} />
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: insets.bottom + 16, flexGrow: 1 }}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={[styles.emptyTitle, { color: colors.text }]}>{emptyTitle}</Text>
                <Text style={[styles.emptyHint, { color: colors.muted }]}>{emptyHint}</Text>
              </View>
            }
            renderItem={({ item }) => {
              const row = toRow(item);
              const disabled = excluded.has(item.id);
              return (
                <TouchableOpacity
                  style={[styles.row, { borderBottomColor: colors.divider, opacity: disabled ? 0.4 : 1 }]}
                  onPress={() => onSelect(item)}
                  disabled={disabled}
                  testID="picker-row"
                  accessibilityRole="button"
                  accessibilityLabel={row.name}
                  accessibilityState={{ disabled }}
                >
                  <View style={[styles.avatar, icon === 'person' && styles.avatarRound]}>
                    {row.name ? (
                      <Text style={styles.avatarText}>{initialsOf(row.name)}</Text>
                    ) : (
                      <Icon size={16} color="#4F46E5" />
                    )}
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                      {row.name}
                    </Text>
                    {!!row.sub && (
                      <Text style={[styles.sub, { color: colors.muted }]} numberOfLines={1}>
                        {row.sub}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

interface PickerProps<T> {
  visible: boolean;
  onClose: () => void;
  onSelect: (record: T) => void;
  excludeIds?: readonly string[];
}

export function CompanyPicker({ visible, onClose, onSelect, excludeIds }: Readonly<PickerProps<CompanyRecord>>) {
  const { t } = useI18n();
  const load = useCallback(async (search: string) => {
    const res = await api.getCompanies({ search, limit: 50 });
    return res.success && res.data ? res.data.items : null;
  }, []);
  return (
    <RecordPicker<CompanyRecord>
      visible={visible}
      title={t.picker.companyTitle}
      searchPlaceholder={t.picker.searchCompanies}
      emptyTitle={t.picker.noCompanies}
      emptyHint={t.picker.noCompaniesHint}
      icon="company"
      excludeIds={excludeIds}
      load={load}
      toRow={(item) => ({ id: item.id, name: item.name, sub: item.industry || item.email || undefined })}
      onClose={onClose}
      onSelect={onSelect}
    />
  );
}

export function PersonPicker({ visible, onClose, onSelect, excludeIds }: Readonly<PickerProps<PersonRecord>>) {
  const { t } = useI18n();
  const load = useCallback(async (search: string) => {
    const res = await api.getPeople({ search, limit: 50 });
    return res.success && res.data ? res.data.items : null;
  }, []);
  return (
    <RecordPicker<PersonRecord>
      visible={visible}
      title={t.picker.personTitle}
      searchPlaceholder={t.picker.searchPeople}
      emptyTitle={t.picker.noPeople}
      emptyHint={t.picker.noPeopleHint}
      icon="person"
      excludeIds={excludeIds}
      load={load}
      toRow={(item) => ({ id: item.id, name: item.name, sub: item.jobTitle || item.email || undefined })}
      onClose={onClose}
      onSelect={onSelect}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600' },
  close: { padding: 4 },
  searchBox: { margin: 16, borderRadius: 10 },
  searchInput: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginBottom: 6 },
  emptyHint: { fontSize: 13, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#E0E7FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarRound: { borderRadius: 20 },
  avatarText: { fontSize: 13, fontWeight: '600', color: '#4F46E5' },
  rowText: { flex: 1 },
  name: { fontSize: 15, fontWeight: '500' },
  sub: { fontSize: 12, marginTop: 2 },
});
