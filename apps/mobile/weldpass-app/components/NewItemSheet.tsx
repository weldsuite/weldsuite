/** "What do you want to add?": a login, a secure note or a card. */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { WeldPassItemType } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { ItemIcon } from '@/components/ItemIcon';
import { useI18n } from '@/lib/i18n';

const TYPES: WeldPassItemType[] = ['login', 'note', 'card'];

export function NewItemSheet({
  visible,
  onClose,
  vaultId,
}: Readonly<{ visible: boolean; onClose: () => void; vaultId?: string }>) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();

  const choose = (type: WeldPassItemType) => {
    onClose();
    router.push({ pathname: '/item/new', params: vaultId ? { type, vaultId } : { type } });
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t.items.chooseType} heightRatio={0.4}>
      <View style={styles.list}>
        {TYPES.map((type) => (
          <Pressable
            key={type}
            onPress={() => choose(type)}
            accessibilityRole="button"
            testID={`new-${type}`}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : 'transparent' }]}
          >
            <ItemIcon type={type} size={36} />
            <Text style={[styles.label, { color: colors.text }]}>{t.types[type]}</Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 10 },
  label: { fontSize: 17, fontWeight: '500' },
});
