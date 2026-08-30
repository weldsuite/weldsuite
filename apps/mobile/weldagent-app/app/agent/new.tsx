import { useState } from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';

import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import { useI18n } from '@/lib/i18n';
import appApi from '@/services/app-api';

export default function NewAgentScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const res = await appApi.agents.create({ name: trimmed });
      if (res.data?.id) router.replace(`/agent/${res.data.id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen header={<ScreenHeader title={t.agentNew.title} showBack />}>
      <SectionCard title={t.agentDetail.name}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t.agentDetail.namePlaceholder}
          placeholderTextColor={colors.mutedForeground}
          style={[styles.input, { color: colors.text }]}
          autoFocus
        />
      </SectionCard>
      <View style={styles.actions}>
        <Button title={t.agentNew.create} onPress={() => void create()} loading={saving} disabled={!name.trim()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { fontSize: 16, paddingVertical: 8 },
  actions: { padding: 16 },
});
