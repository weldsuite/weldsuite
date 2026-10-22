/**
 * Full-screen picker that lists the workspace's companies with server-side
 * search. Used where a record has to belong to a company: a deal (required) and
 * a new person (optional).
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
import { Building2, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { api, type CompanyRecord } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { initialsOf } from '@/lib/crm';

const SEARCH_DEBOUNCE_MS = 300;

interface CompanyPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (company: CompanyRecord) => void;
}

export function CompanyPicker({ visible, onClose, onSelect }: Readonly<CompanyPickerProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [companies, setCompanies] = useState<CompanyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  // Only the latest request may write state, so a slow earlier search can't overwrite a newer one.
  const requestId = useRef(0);

  const load = useCallback(
    async (term: string) => {
      const current = ++requestId.current;
      setLoading(true);
      const res = await api.getCompanies({ search: term, limit: 50 });
      if (current !== requestId.current) return;
      if (res.success && res.data) {
        setCompanies(res.data.items);
      } else {
        toast.error(t.picker.loadFailed);
      }
      setLoading(false);
    },
    [t, toast],
  );

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => void load(search), search ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [visible, search, load]);

  useEffect(() => {
    if (visible) setSearch('');
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">
            {t.picker.companyTitle}
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
            placeholder={t.picker.searchCompanies}
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>
        {loading && companies.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text} />
          </View>
        ) : (
          <FlatList
            data={companies}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: insets.bottom + 16, flexGrow: 1 }}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={[styles.emptyTitle, { color: colors.text }]}>{t.picker.noCompanies}</Text>
                <Text style={[styles.emptyHint, { color: colors.muted }]}>{t.picker.noCompaniesHint}</Text>
              </View>
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.row, { borderBottomColor: colors.divider }]}
                onPress={() => onSelect(item)}
                accessibilityRole="button"
                accessibilityLabel={item.name}
              >
                <View style={styles.avatar}>
                  {item.name ? (
                    <Text style={styles.avatarText}>{initialsOf(item.name)}</Text>
                  ) : (
                    <Building2 size={16} color="#4F46E5" />
                  )}
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {!!(item.industry || item.email) && (
                    <Text style={[styles.sub, { color: colors.muted }]} numberOfLines={1}>
                      {item.industry || item.email}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            )}
          />
        )}
      </View>
    </Modal>
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
  avatarText: { fontSize: 13, fontWeight: '600', color: '#4F46E5' },
  rowText: { flex: 1 },
  name: { fontSize: 15, fontWeight: '500' },
  sub: { fontSize: 12, marginTop: 2 },
});
