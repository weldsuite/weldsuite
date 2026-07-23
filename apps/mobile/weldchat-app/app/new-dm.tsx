import { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  Image,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@clerk/expo';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { appApi } from '@/services/app-api';
import { SearchField } from '@/components/chat/SearchField';

interface WorkspaceMember {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  role: string | null;
}

export default function NewDmScreen() {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const styles = useMemo(() => makeStyles(colors, insets.bottom), [colors, insets.bottom]);

  useEffect(() => {
    appApi.chatMembers.list().then((res) => {
      setMembers((res.data || []) as unknown as WorkspaceMember[]);
    }).catch((err) => {
      console.error('Failed to load members:', err);
    }).finally(() => {
      setLoading(false);
    });
  }, []);

  const filtered = useMemo(() => {
    const others = members.filter((m) => m.userId !== userId);
    if (!search.trim()) return others;
    const q = search.toLowerCase();
    return others.filter(
      (m) =>
        m.name?.toLowerCase().includes(q) ||
        m.email?.toLowerCase().includes(q)
    );
  }, [members, search, userId]);

  const toggleMember = (member: WorkspaceMember) => {
    if (creating) return;
    setSelected((prev) =>
      prev.includes(member.userId)
        ? prev.filter((id) => id !== member.userId)
        : [...prev, member.userId],
    );
  };

  // One or more selected → create a 1:1 or group DM (the backend reuses an
  // existing channel with the same participants if one exists).
  const handleCreate = async () => {
    if (creating || selected.length === 0) return;
    setCreating(true);
    try {
      const res = await appApi.chatDm.create({ userIds: selected });
      const channelId = res.data?.id;
      if (channelId) {
        router.replace(`/dm/${channelId}` as any);
      } else {
        setCreating(false);
      }
    } catch (err) {
      console.error('Failed to start DM:', err);
      setCreating(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        {/* Handle */}
        <View style={styles.handleBar}>
          <View style={styles.handle} />
        </View>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerSide}>
            <Text style={styles.cancelBtn}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>New Message</Text>
          <TouchableOpacity
            onPress={handleCreate}
            style={[styles.headerSide, styles.headerSideRight]}
            disabled={selected.length === 0 || creating}
          >
            {creating ? (
              <ActivityIndicator size="small" color={colors.brand} />
            ) : (
              <Text style={[styles.startBtn, selected.length === 0 && styles.startBtnDisabled]}>
                Start{selected.length > 1 ? ` (${selected.length})` : ''}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Search */}
        <SearchField
          placeholder="Search people..."
          value={search}
          onChangeText={setSearch}
          onClear={() => setSearch('')}
          autoFocus
          style={styles.searchRow}
        />

        {/* Members list */}
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.brand} />
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.userId}
            contentContainerStyle={filtered.length === 0 ? styles.center : undefined}
            renderItem={({ item }) => {
              const isSelected = selected.includes(item.userId);
              const displayName = item.name || item.email || 'Unknown';
              return (
                <TouchableOpacity
                  style={styles.memberRow}
                  onPress={() => toggleMember(item)}
                  activeOpacity={0.7}
                >
                  <View style={styles.avatar}>
                    {item.picture ? (
                      <Image source={{ uri: item.picture }} style={styles.avatarImage} />
                    ) : (
                      <Text style={styles.avatarText}>
                        {displayName[0].toUpperCase()}
                      </Text>
                    )}
                  </View>
                  <View style={styles.memberInfo}>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {displayName}
                    </Text>
                  </View>
                  <View style={[styles.checkCircle, isSelected && styles.checkCircleActive]}>
                    {isSelected && <Check size={15} color="#fff" strokeWidth={3} />}
                  </View>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                {search.trim() ? 'No people match your search' : 'No other members in this workspace'}
              </Text>
            }
            ItemSeparatorComponent={() => (
              <View style={styles.separator} />
            )}
          />
        )}
      </View>
    </>
  );
}

const makeStyles = (c: ColorScheme, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    handleBar: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
    handle: { width: 36, height: 5, borderRadius: 3, backgroundColor: c.bgAccent },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: c.bgTertiary,
    },
    headerSide: { width: 60 },
    headerSideRight: { alignItems: 'flex-end' },
    headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    cancelBtn: { fontSize: 16, color: c.textPrimary, fontWeight: '500' },
    startBtn: { fontSize: 16, color: c.brand, fontWeight: '600' },
    startBtnDisabled: { color: c.textMuted },
    // Only outer spacing — the pill look lives in <SearchField>.
    searchRow: {
      marginHorizontal: 16,
      marginVertical: 12,
    },
    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    memberRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      gap: 12,
    },
    avatar: {
      width: 30,
      height: 30,
      borderRadius: 10,
      backgroundColor: c.brand,
      justifyContent: 'center',
      alignItems: 'center',
    },
    avatarText: { fontSize: 13, fontWeight: '700', color: '#fff' },
    avatarImage: { width: 30, height: 30, borderRadius: 10 },
    checkCircle: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: c.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    checkCircleActive: {
      backgroundColor: c.brand,
      borderColor: c.brand,
    },
    memberInfo: { flex: 1 },
    memberName: { fontSize: 16, fontWeight: '500', color: c.textPrimary },
    memberEmail: { fontSize: 13, color: c.textMuted, marginTop: 1 },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.bgTertiary, marginLeft: 68 },
    emptyText: { fontSize: 15, color: c.textMuted, textAlign: 'center' },
  });
