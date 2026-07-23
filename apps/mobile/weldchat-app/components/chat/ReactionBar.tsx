import { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';

interface ReactionBarProps {
  reactions: Record<string, string[]>;
  currentUserId: string;
  onToggle: (emoji: string, hasReacted: boolean) => void;
}

export function ReactionBar({ reactions, currentUserId, onToggle }: ReactionBarProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const entries = Object.entries(reactions).filter(([, users]) => users.length > 0);
  if (entries.length === 0) return null;

  return (
    <View style={styles.container}>
      {entries.map(([emoji, users]) => {
        const hasReacted = users.includes(currentUserId);
        return (
          <TouchableOpacity
            key={emoji}
            style={[styles.pill, hasReacted && styles.pillActive]}
            onPress={() => onToggle(emoji, hasReacted)}
          >
            <Text style={styles.emoji}>{emoji}</Text>
            <Text style={[styles.count, hasReacted && styles.countActive]}>
              {users.length}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const makeStyles = (c: ColorScheme) =>
  StyleSheet.create({
    container: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
    pill: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingHorizontal: 8, paddingVertical: 6, borderRadius: 12,
      backgroundColor: c.bgAccent, borderWidth: 1, borderColor: 'transparent',
      minHeight: 32,
    },
    pillActive: { borderColor: c.brand, backgroundColor: `${c.brand}20` },
    emoji: { fontSize: 14 },
    count: { fontSize: 12, color: c.textMuted, fontWeight: '600' },
    countActive: { color: c.brand },
  });
