import { useMemo } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';

const EMOJI_LIST = [
  '👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👏',
  '🙌', '💯', '🤔', '👀', '🚀', '✅', '❌', '⭐',
  '💪', '🙏', '😍', '🤣', '😅', '🥳', '🤝', '💡',
  '📌', '🎯', '💬', '📎', '🔗', '⚡', '🏆', '🌟',
];

interface EmojiPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

export function EmojiPicker({ visible, onClose, onSelect }: EmojiPickerProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.bottom), [colors, insets.bottom]);

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.container}>
          <Text style={styles.title}>React with emoji</Text>
          <ScrollView>
            <View style={styles.grid}>
              {EMOJI_LIST.map((emoji) => (
                <TouchableOpacity
                  key={emoji}
                  style={styles.emojiBtn}
                  onPress={() => { onSelect(emoji); onClose(); }}
                >
                  <Text style={styles.emoji}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: ColorScheme, bottomInset: number) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    container: {
      backgroundColor: c.bgSecondary,
      borderTopLeftRadius: 16, borderTopRightRadius: 16,
      padding: 16, paddingBottom: 16 + bottomInset, maxHeight: '50%',
    },
    title: { fontSize: 16, fontWeight: '600', color: c.textPrimary, marginBottom: 12, textAlign: 'center' },
    grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 4 },
    emojiBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
    emoji: { fontSize: 24 },
  });
