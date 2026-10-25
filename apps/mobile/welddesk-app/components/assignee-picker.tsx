/**
 * Bottom-sheet style modal to assign a conversation: an "unassign" shortcut on
 * top, then a searchable list of workspace members.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Check, UserMinus, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND, tint } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { useAssignableMembers } from '@/hooks/useAssignableMembers';

interface AssigneePickerProps {
  visible: boolean;
  currentAssigneeId: string | null;
  currentUserId: string | null;
  onClose: () => void;
  /** `null` unassigns. */
  onSelect: (assigneeId: string | null) => void;
}

export function AssigneePicker({
  visible,
  currentAssigneeId,
  currentUserId,
  onClose,
  onSelect,
}: Readonly<AssigneePickerProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { members, loading, error, load } = useAssignableMembers();
  const [search, setSearch] = useState('');

  // Load lazily the first time the picker opens; the roster is cached afterwards.
  useEffect(() => {
    if (visible && members === null && !loading && !error) void load();
    if (!visible) setSearch('');
  }, [visible, members, loading, error, load]);

  const filtered = useMemo(() => {
    if (!members) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return members;
    return members.filter(
      (m) => m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle),
    );
  }, [members, search]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t.common.close} />
      <View style={[styles.sheet, { backgroundColor: colors.background }]}>
        <View style={styles.sheetHeader}>
          <Text style={[styles.sheetTitle, { color: colors.text }]}>{t.conversation.assignTitle}</Text>
          <Pressable onPress={onClose} accessibilityLabel={t.common.close} hitSlop={8}>
            <X size={20} color={colors.text} />
          </Pressable>
        </View>

        {currentAssigneeId ? (
          <Pressable
            onPress={() => onSelect(null)}
            style={[styles.row, { borderBottomColor: colors.border }]}
          >
            <UserMinus size={18} color={colors.mutedForeground} />
            <Text style={[styles.rowName, { color: colors.text }]}>{t.conversation.unassign}</Text>
          </Pressable>
        ) : null}

        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t.conversation.searchMembers}
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.search, { backgroundColor: colors.secondary, color: colors.text }]}
        />

        {loading && !members ? <ActivityIndicator style={styles.state} color={BRAND} /> : null}

        {error && !members ? (
          <Pressable onPress={() => void load(true)} style={styles.state}>
            <Text style={[styles.stateText, { color: colors.mutedForeground }]}>
              {t.conversation.membersError}
            </Text>
            <Text style={[styles.stateText, { color: BRAND, fontWeight: '600' }]}>
              {t.common.tryAgain}
            </Text>
          </Pressable>
        ) : null}

        {members ? (
          <FlatList
            data={filtered}
            keyExtractor={(m) => m.userId}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <Text style={[styles.stateText, styles.state, { color: colors.mutedForeground }]}>
                {t.conversation.noMembers}
              </Text>
            }
            renderItem={({ item }) => {
              const selected = item.userId === currentAssigneeId;
              const isMe = item.userId === currentUserId;
              return (
                <Pressable
                  onPress={() => onSelect(item.userId)}
                  style={[styles.row, { borderBottomColor: colors.border }]}
                >
                  <View style={[styles.avatar, { backgroundColor: tint(BRAND) }]}>
                    <Text style={[styles.avatarText, { color: BRAND }]}>
                      {item.name.slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
                      {item.name}
                      {isMe ? ` (${t.conversation.assignedToYou})` : ''}
                    </Text>
                    {item.email && item.email !== item.name ? (
                      <Text
                        style={[styles.rowEmail, { color: colors.mutedForeground }]}
                        numberOfLines={1}
                      >
                        {item.email}
                      </Text>
                    ) : null}
                  </View>
                  {selected ? <Check size={18} color={BRAND} /> : null}
                </Pressable>
              );
            }}
          />
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '75%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 24,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  search: {
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '500' },
  rowEmail: { fontSize: 12, marginTop: 1 },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 14, fontWeight: '700' },
  state: { alignItems: 'center', padding: 24, gap: 6 },
  stateText: { fontSize: 14, textAlign: 'center' },
});
