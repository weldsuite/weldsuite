/**
 * Invite people to a channel, from the channel's long-press menu: the
 * workspace's people who are not in it yet, pick one or more, Add.
 */
import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, FlatList, Image } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import type { ThemeColors } from '@/lib/theme-colors';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { appApi } from '@/services/app-api';
import { SearchField } from '@/components/chat/SearchField';
import { SheetHeader } from '@/components/ui/SheetHeader';

interface Person {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

function Separator() {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.secondary, marginLeft: 58 }} />;
}

export default function InvitePeopleScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string; name?: string }>();
  const { t, format, plural } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  // Everyone in the workspace, minus who is already in the channel.
  useEffect(() => {
    Promise.all([appApi.chatMembers.list(), appApi.channels.members(channelId)])
      .then(([workspace, channel]) => {
        const inChannel = new Set((channel.data ?? []).map((m) => m.userId));
        const everyone = (workspace.data ?? []) as unknown as Person[];
        setPeople(everyone.filter((p) => !inChannel.has(p.userId)));
      })
      .catch((err) => console.error('[WeldChat] Failed to load people to invite:', err))
      .finally(() => setLoading(false));
  }, [channelId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => p.name?.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q));
  }, [people, search]);

  const toggle = (userId: string) => {
    if (adding) return;
    setSelected((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  };

  const handleAdd = async () => {
    if (adding || selected.length === 0) return;
    setAdding(true);
    try {
      await appApi.channels.addMembers(channelId, selected);
      toast.success(plural(selected.length, t.invitePeople.added));
      router.back();
    } catch (err) {
      console.error('[WeldChat] Failed to invite people:', err);
      toast.error(t.invitePeople.failed);
      setAdding(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SheetHeader
          title={t.invitePeople.title}
          onLeadingPress={() => router.back()}
          leadingLabel={t.newMessage.close}
          action={{
            label:
              selected.length > 1
                ? format(t.invitePeople.addWithCount, { count: selected.length })
                : t.invitePeople.add,
            onPress: handleAdd,
            disabled: selected.length === 0,
            loading: adding,
          }}
        />

        <SearchField
          placeholder={t.invitePeople.search}
          value={search}
          onChangeText={setSearch}
          onClear={() => setSearch('')}
          style={styles.search}
        />

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={BRAND} />
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.userId}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={filtered.length === 0 ? styles.center : undefined}
            ItemSeparatorComponent={Separator}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                {search.trim() ? t.invitePeople.noMatch : t.invitePeople.everyoneIn}
              </Text>
            }
            renderItem={({ item }) => {
              const isSelected = selected.includes(item.userId);
              const displayName = item.name || item.email || '?';
              return (
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => toggle(item.userId)}
                  activeOpacity={0.7}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                >
                  <View style={styles.avatar}>
                    {item.picture ? (
                      <Image source={{ uri: item.picture }} style={styles.avatarImage} />
                    ) : (
                      <Text style={styles.avatarText}>{displayName[0]?.toUpperCase()}</Text>
                    )}
                  </View>
                  <Text style={styles.name} numberOfLines={1}>
                    {displayName}
                  </Text>
                  <View style={[styles.check, isSelected && styles.checkOn]}>
                    {isSelected && <Check size={15} color="#fff" strokeWidth={3} />}
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>
    </>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    search: { marginHorizontal: 16, marginVertical: 12 },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16 },
    avatar: {
      width: 30,
      height: 30,
      borderRadius: 10,
      backgroundColor: BRAND,
      justifyContent: 'center',
      alignItems: 'center',
    },
    avatarImage: { width: 30, height: 30, borderRadius: 10 },
    avatarText: { fontSize: 13, fontWeight: '700', color: '#fff' },
    name: { flex: 1, fontSize: 16, fontWeight: '500', color: c.text },
    check: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: c.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    checkOn: { backgroundColor: BRAND, borderColor: BRAND },
    emptyText: { fontSize: 15, color: c.muted, textAlign: 'center' },
  });
