/**
 * One field of an item: its label, its value (or dots while hidden) and the
 * actions on it. Secrets show dots until the item is revealed.
 */

import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Copy, ExternalLink, Eye, EyeOff } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { useI18n } from '@/lib/i18n';

const DOTS = '••••••••••';

export function FieldRow({
  label,
  value,
  secret = false,
  shown = true,
  multiline = false,
  monospace = false,
  onToggle,
  onCopy,
  onOpen,
  testID,
}: Readonly<{
  label: string;
  /** Null while a secret hasn't been revealed. */
  value: string | null;
  secret?: boolean;
  /** For a secret: show the value rather than dots. */
  shown?: boolean;
  multiline?: boolean;
  monospace?: boolean;
  onToggle?: () => void;
  onCopy?: () => void;
  onOpen?: () => void;
  testID?: string;
}>) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const visible = !secret || (shown && value != null);
  const text = visible ? value || t.common.dash : DOTS;
  const iconColor = colors.mutedForeground;

  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]} testID={testID}>
      <View style={styles.text}>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
        <Text
          style={[styles.value, { color: colors.text }, monospace && visible ? styles.mono : null]}
          numberOfLines={multiline ? undefined : 1}
          selectable={false}
          testID={testID ? `${testID}-value` : undefined}
        >
          {text}
        </Text>
      </View>
      {secret && onToggle ? (
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={visible ? t.item.hide : t.item.show}
          hitSlop={8}
          testID={testID ? `${testID}-toggle` : undefined}
          style={styles.action}
        >
          {visible ? <EyeOff size={20} color={iconColor} /> : <Eye size={20} color={iconColor} />}
        </Pressable>
      ) : null}
      {onOpen ? (
        <Pressable onPress={onOpen} accessibilityRole="link" accessibilityLabel={t.item.openWebsite} hitSlop={8} style={styles.action}>
          <ExternalLink size={20} color={iconColor} />
        </Pressable>
      ) : null}
      {onCopy ? (
        <Pressable
          onPress={onCopy}
          accessibilityRole="button"
          accessibilityLabel={`${t.common.copy} ${label}`}
          hitSlop={8}
          testID={testID ? `${testID}-copy` : undefined}
          style={styles.action}
        >
          <Copy size={20} color={iconColor} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1, gap: 2 },
  label: { fontSize: 13 },
  value: { fontSize: 16 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), letterSpacing: 0.5 },
  action: { padding: 6 },
});
