/**
 * Workspace members: a hook that loads them (cached per workspace by the data
 * layer) and a picker for owner, manager and assignees, single or multiple.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { api, type Member } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { initialsOf } from '@/lib/crm';

/** All members, plus a lookup from Clerk user id to member. */
export function useMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    let active = true;
    void api.getMembers().then((res) => {
      if (active && res.success && res.data) setMembers(res.data);
    });
    return () => {
      active = false;
    };
  }, []);
  const byId = useMemo(() => new Map(members.map((member) => [member.userId, member])), [members]);
  return { members, byId };
}

interface MemberPickerProps {
  visible: boolean;
  title: string;
  members: readonly Member[];
  selected: readonly string[];
  /** Several members (assignees) or one (owner, manager). */
  multiple?: boolean;
  /** Single mode: offer "None". */
  allowNone?: boolean;
  onChange: (userIds: string[]) => void;
  onClose: () => void;
}

export function MemberPicker({
  visible,
  title,
  members,
  selected,
  multiple,
  allowNone,
  onChange,
  onClose,
}: Readonly<MemberPickerProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (visible) setSearch('');
  }, [visible]);

  const term = search.trim().toLowerCase();
  const filtered = term
    ? members.filter((m) => m.name.toLowerCase().includes(term) || m.email?.toLowerCase().includes(term))
    : members;

  const toggle = (userId: string) => {
    if (!multiple) {
      onChange([userId]);
      onClose();
      return;
    }
    onChange(selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">
            {title}
          </Text>
          <TouchableOpacity onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel={multiple ? t.common.done : t.common.close}>
            {multiple ? (
              <Text style={[styles.done, { color: colors.text }]}>{t.common.done}</Text>
            ) : (
              <X size={22} color={colors.text} />
            )}
          </TouchableOpacity>
        </View>
        <View style={[styles.searchBox, { backgroundColor: colors.inputBackground }]}>
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder={t.members.search}
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.userId}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          ListHeaderComponent={
            allowNone && !multiple ? (
              <TouchableOpacity
                style={[styles.row, { borderBottomColor: colors.divider }]}
                onPress={() => {
                  onChange([]);
                  onClose();
                }}
                accessibilityRole="button"
              >
                <Text style={[styles.name, { color: colors.muted }]}>{t.common.none}</Text>
                {selected.length === 0 ? <Check size={18} color={colors.text} /> : null}
              </TouchableOpacity>
            ) : null
          }
          ListEmptyComponent={<Text style={[styles.empty, { color: colors.muted }]}>{t.members.empty}</Text>}
          renderItem={({ item }) => {
            const isSelected = selected.includes(item.userId);
            return (
              <TouchableOpacity
                style={[styles.row, { borderBottomColor: colors.divider }]}
                onPress={() => toggle(item.userId)}
                accessibilityRole={multiple ? 'checkbox' : 'button'}
                accessibilityState={multiple ? { checked: isSelected } : { selected: isSelected }}
                accessibilityLabel={item.name}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initialsOf(item.name)}</Text>
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.email && item.email !== item.name ? (
                    <Text style={[styles.sub, { color: colors.muted }]} numberOfLines={1}>
                      {item.email}
                    </Text>
                  ) : null}
                </View>
                {isSelected ? <Check size={18} color={colors.text} /> : null}
              </TouchableOpacity>
            );
          }}
        />
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
  done: { fontSize: 15, fontWeight: '600' },
  searchBox: { margin: 16, borderRadius: 10 },
  searchInput: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#EDE9FE', alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 12, fontWeight: '600', color: '#7C3AED' },
  rowText: { flex: 1 },
  name: { fontSize: 15, fontWeight: '500', flex: 1 },
  sub: { fontSize: 12, marginTop: 2 },
  empty: { textAlign: 'center', padding: 32, fontSize: 14 },
});
