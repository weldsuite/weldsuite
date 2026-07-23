import { useEffect, useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Image } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { appApi } from '@/services/app-api';

interface Member {
  userId: string;
  name: string;
  email?: string;
  picture?: string;
}

interface MentionPickerProps {
  query: string;
  visible: boolean;
  onSelect: (member: Member) => void;
}

export function MentionPicker({ query, visible, onSelect }: MentionPickerProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    (async () => {
      try {
        const res = await appApi.chatMembers.list();
        setMembers((res.data ?? []) as unknown as Member[]);
      } catch (err) {
        console.error(err);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    if (!query) return members.slice(0, 8);
    const q = query.toLowerCase();
    return members.filter((m) =>
      m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [members, query]);

  if (!visible || filtered.length === 0) return null;

  return (
    <View style={styles.container}>
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.userId}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.item} onPress={() => onSelect(item)}>
            {item.picture ? (
              <Image source={{ uri: item.picture }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarFallback}>
                <Text style={styles.avatarText}>{(item.name || '?')[0].toUpperCase()}</Text>
              </View>
            )}
            <View style={styles.info}>
              <Text style={styles.name}>{item.name}</Text>
              {item.email && <Text style={styles.email}>{item.email}</Text>}
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const makeStyles = (c: ColorScheme) =>
  StyleSheet.create({
    container: { backgroundColor: c.bgSecondary, borderTopWidth: 1, borderTopColor: c.border, maxHeight: 200 },
    item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 16, gap: 10 },
    avatar: { width: 28, height: 28, borderRadius: 14 },
    avatarFallback: {
      width: 28, height: 28, borderRadius: 14,
      backgroundColor: c.brand, justifyContent: 'center', alignItems: 'center',
    },
    avatarText: { fontSize: 12, fontWeight: '700', color: '#fff' },
    info: { flex: 1 },
    name: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    email: { fontSize: 12, color: c.textMuted },
  });
