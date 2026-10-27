import { useEffect, useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Image } from 'react-native';
import { Bot } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi } from '@/services/app-api';

interface Member {
  userId: string;
  name: string;
  email?: string;
  picture?: string;
  /** A WeldAgent already in the channel, offered above the people roster. */
  isAgent?: boolean;
  /** The agent's emoji icon (not a URL), or null for the bot glyph fallback. */
  agentIcon?: string | null;
}

interface MentionPickerProps {
  query: string;
  visible: boolean;
  onSelect: (member: Member) => void;
  /** The channel to pull agent members from. Omitted where there's no channel yet. */
  channelId?: string;
}

export function MentionPicker({ query, visible, onSelect, channelId }: Readonly<MentionPickerProps>) {
  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<Member[]>([]);
  const { colors } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await appApi.chatMembers.list();
        setMembers((res.data ?? []) as unknown as Member[]);
      } catch (err) {
        console.error(err);
      }
    })();
  }, []);

  // Agents already in this channel — mobile doesn't support inviting one in
  // from the mention picker, only mentioning one that's already a member.
  useEffect(() => {
    if (!channelId) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await appApi.channels.members(channelId);
        const rows = res.data ?? [];
        const agentRows: Member[] = rows
          .filter((m) => m.memberType === 'agent' && m.userId && m.name)
          .map((m) => ({
            userId: m.userId,
            name: m.name as string,
            isAgent: true,
            agentIcon: m.agentIcon ?? null,
          }));
        if (!cancelled) setAgents(agentRows);
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const matchesQuery = (m: Member) =>
      !q || m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q);
    const filteredAgents = agents.filter(matchesQuery).slice(0, 5);
    const filteredPeople = members.filter(matchesQuery).slice(0, 8);
    return [...filteredAgents, ...filteredPeople];
  }, [members, agents, query]);

  const renderAvatar = (item: Member) => {
    if (item.isAgent) {
      return (
        <View style={styles.avatarFallback}>
          {item.agentIcon ? (
            <Text style={styles.avatarEmoji}>{item.agentIcon}</Text>
          ) : (
            <Bot size={14} color="#fff" />
          )}
        </View>
      );
    }
    if (item.picture) return <Image source={{ uri: item.picture }} style={styles.avatar} />;
    return (
      <View style={styles.avatarFallback}>
        <Text style={styles.avatarText}>{(item.name || '?')[0].toUpperCase()}</Text>
      </View>
    );
  };

  if (!visible || filtered.length === 0) return null;

  return (
    <View style={styles.container}>
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.userId}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.item} onPress={() => onSelect(item)}>
            {renderAvatar(item)}
            <View style={styles.info}>
              <Text style={styles.name}>{item.name}</Text>
              {item.email && !item.isAgent && <Text style={styles.email}>{item.email}</Text>}
            </View>
            {item.isAgent && <Text style={styles.agentTag}>{t.channel.agentBadge}</Text>}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { backgroundColor: c.cardBackground, borderTopWidth: 1, borderTopColor: c.border, maxHeight: 200 },
    item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 16, gap: 10 },
    avatar: { width: 28, height: 28, borderRadius: 14 },
    avatarFallback: {
      width: 28, height: 28, borderRadius: 14,
      backgroundColor: BRAND, justifyContent: 'center', alignItems: 'center',
    },
    avatarText: { fontSize: 12, fontWeight: '700', color: '#fff' },
    avatarEmoji: { fontSize: 14 },
    info: { flex: 1 },
    name: { fontSize: 14, fontWeight: '600', color: c.text },
    email: { fontSize: 12, color: c.muted },
    agentTag: { fontSize: 10, fontWeight: '600', color: c.muted, textTransform: 'uppercase' },
  });
