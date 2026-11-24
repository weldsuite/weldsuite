/** Every item the person can open, across vaults, with search. */

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { ItemList } from '@/components/ItemList';
import { NewItemSheet } from '@/components/NewItemSheet';
import { HeaderButton, Screen } from '@/components/Screen';
import { useItems } from '@/hooks/use-passwords';
import { passErrorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

export default function ItemsScreen() {
  const { t } = useI18n();
  const { colors } = useTheme();
  const items = useItems();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    hideAppSplash();
  }, []);

  return (
    <Screen
      title={t.items.title}
      actions={
        <HeaderButton label={t.items.add} onPress={() => setAdding(true)} testID="add-item">
          <Plus size={20} color={colors.text} />
        </HeaderButton>
      }
    >
      <ItemList
        items={items.data}
        loading={items.isLoading}
        refreshing={items.isRefetching}
        onRefresh={() => void items.refetch()}
        error={items.error && !items.data ? passErrorMessage(t, items.error) : null}
        empty={{ title: t.items.empty, description: t.items.emptyDescription }}
      />
      <NewItemSheet visible={adding} onClose={() => setAdding(false)} />
    </Screen>
  );
}
