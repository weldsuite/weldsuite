import { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';
import { SheetHeader } from '@/components/ui/SheetHeader';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi } from '@/services/app-api';

/**
 * Create a category (a chat section) from the compose card on Home. Opens
 * like the other create screens (new channel, new message); Home reloads its
 * sections on focus.
 */
export default function NewCategoryScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = name.trim().length > 0 && !saving;

  const handleCreate = async () => {
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    try {
      await appApi.chatSections.create({ name: name.trim() });
      router.back();
    } catch {
      setError(t.newCategory.failed);
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <SheetHeader
        title={t.newCategory.title}
        onLeadingPress={() => router.back()}
        leadingLabel={t.newMessage.close}
        action={{ label: t.newCategory.create, onPress: handleCreate, disabled: !canCreate, loading: saving }}
      />

      <View style={styles.body}>
        <Text style={styles.label}>{t.newCategory.nameLabel}</Text>
        <TextInput
          style={[styles.field, error && styles.fieldError]}
          value={name}
          onChangeText={(text) => {
            setName(text);
            setError(null);
          }}
          placeholder={t.newCategory.namePlaceholder}
          placeholderTextColor={colors.muted}
          autoFocus
          autoCapitalize="sentences"
          returnKeyType="done"
          onSubmitEditing={handleCreate}
          maxLength={80}
          accessibilityLabel={t.newCategory.nameLabel}
        />
        <Text style={[styles.hint, error && styles.hintError]}>{error ?? t.newCategory.hint}</Text>
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    // Same field, label and hint as the name step of a new channel.
    body: { paddingHorizontal: 16, paddingTop: 16 },
    label: {
      fontSize: 13,
      fontWeight: '600',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: c.mutedForeground,
      marginBottom: 8,
    },
    field: {
      height: 48,
      paddingHorizontal: 14,
      borderRadius: 14,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: c.inputBackground,
      fontSize: 17,
      color: c.text,
    },
    fieldError: { borderColor: c.destructive },
    hint: { fontSize: 14, lineHeight: 20, color: c.mutedForeground, marginTop: 10 },
    hintError: { color: c.destructive },
  });
