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
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@clerk/expo';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi } from '@/services/app-api';
import { SearchField } from '@/components/chat/SearchField';
import { SheetHeader } from '@/components/ui/SheetHeader';

interface WorkspaceMember {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  role: string | null;
}

function MemberListSeparator() {
  const { colors } = useTheme();
  return (
    <View
      style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.secondary, marginLeft: 68 }}
    />
  );
}

export default function NewDmScreen() {
  const { t, format } = useI18n();
  // From the DM list's compose card: a group needs at least two people.
  const isGroup = useLocalSearchParams<{ group?: string }>().group === '1';
  const minSelected = isGroup ? 2 : 1;
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
    if (creating || selected.length < minSelected) return;
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
        <SheetHeader
          title={isGroup ? t.dms.newGroup : t.newMessage.title}
          onLeadingPress={() => router.back()}
          leadingLabel={t.newMessage.close}
          action={{
            label:
              selected.length > 1
                ? format(t.newMessage.startWithCount, { count: selected.length })
                : t.newMessage.start,
            onPress: handleCreate,
            disabled: selected.length < minSelected,
            loading: creating,
          }}
        />

        {/* Search */}
        <SearchField
          placeholder={t.invitePeople.search}
          value={search}
          onChangeText={setSearch}
          onClear={() => setSearch('')}
          autoFocus
          style={styles.searchRow}
        />

        {/* Members list */}
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={BRAND} />
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
                {search.trim() ? t.invitePeople.noMatch : t.dms.noOtherMembers}
              </Text>
            }
            ItemSeparatorComponent={MemberListSeparator}
          />
        )}
      </View>
    </>
  );
}

const makeStyles = (c: ThemeColors, _bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
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
      backgroundColor: BRAND,
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
      backgroundColor: BRAND,
      borderColor: BRAND,
    },
    memberInfo: { flex: 1 },
    memberName: { fontSize: 16, fontWeight: '500', color: c.text },
    memberEmail: { fontSize: 13, color: c.muted, marginTop: 1 },
    emptyText: { fontSize: 15, color: c.muted, textAlign: 'center' },
  });
