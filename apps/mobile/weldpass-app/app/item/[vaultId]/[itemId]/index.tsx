/**
 * One item. The list's metadata shows straight away; the secret fields stay
 * dots until the person reveals them, which asks Face ID (or the passcode)
 * and is a request the server audits (`useItemSecrets`). Revealed fields
 * are dropped when the app goes to the background and when the screen
 * closes.
 */

import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pencil, Trash2 } from 'lucide-react-native';
import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { canEditVault } from '@weldsuite/app-api-client/schemas/weldpass-items';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { ItemIcon } from '@/components/ItemIcon';
import { CardSection, LoginSection, NoteSection, NotesSection } from '@/components/ItemSections';
import { HeaderButton, Screen } from '@/components/Screen';
import { useItemSecrets } from '@/hooks/use-item-secrets';
import { useDeleteItem, useItems, useVaults } from '@/hooks/use-passwords';
import { passErrorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';
import { usePreventScreenshots } from '@/lib/privacy';
import { vaultLabel } from '@/lib/vaults';

export default function ItemScreen() {
  const { vaultId, itemId } = useLocalSearchParams<{ vaultId: string; itemId: string }>();
  const { t } = useI18n();
  const items = useItems();
  usePreventScreenshots();

  const item = items.data?.find((candidate) => candidate.id === itemId);
  if (!item) {
    return (
      <Screen title="" back>
        {items.isLoading ? null : <EmptyState title={t.item.notFound} />}
      </Screen>
    );
  }
  return <ItemDetail item={item} vaultId={vaultId} itemId={itemId} />;
}

function ItemDetail({ item, vaultId, itemId }: Readonly<{ item: WeldPassItem; vaultId: string; itemId: string }>) {
  const { t, format, intlLocale } = useI18n();
  const { colors } = useTheme();
  const toast = useToast();
  const router = useRouter();
  const vaults = useVaults();
  const remove = useDeleteItem();
  const secrets = useItemSecrets(vaultId, itemId);

  const vault = vaults.data?.find((candidate) => candidate.id === vaultId);
  const writable = canEditVault(vault);
  const updated = new Date(item.updatedAt).toLocaleDateString(intlLocale, { day: 'numeric', month: 'long', year: 'numeric' });
  const meta = [t.types[item.type], vault ? vaultLabel(t, vault) : null].filter(Boolean).join(' · ');

  const confirmDelete = () => {
    Alert.alert(format(t.item.deleteTitle, { title: item.title }), t.item.deleteMessage, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          remove
            .mutateAsync({ vaultId, itemId })
            .then(() => {
              toast.success(t.item.deleted);
              router.back();
            })
            .catch((error: unknown) => toast.error(passErrorMessage(t, error)));
        },
      },
    ]);
  };

  return (
    <Screen
      title={item.title}
      back
      actions={
        writable ? (
          <HeaderButton
            label={t.common.edit}
            onPress={() => router.push({ pathname: '/item/[vaultId]/[itemId]/edit', params: { vaultId, itemId } })}
            testID="edit-item"
          >
            <Pencil size={18} color={colors.text} />
          </HeaderButton>
        ) : null
      }
    >
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.head}>
          <ItemIcon type={item.type} size={56} />
          <View style={styles.headText}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
              {meta}
            </Text>
          </View>
        </View>

        {item.type === 'login' ? <LoginSection item={item} secrets={secrets} /> : null}
        {item.type === 'card' ? <CardSection item={item} secrets={secrets} /> : null}
        {item.type === 'note' ? <NoteSection item={item} secrets={secrets} /> : <NotesSection item={item} secrets={secrets} />}

        <View style={styles.actions}>
          {secrets.fields ? null : (
            <Button
              title={t.item.reveal}
              variant="outline"
              onPress={() => void secrets.revealAll()}
              loading={secrets.revealing}
              testID="reveal-item"
            />
          )}
          {writable ? (
            <Button
              title={t.common.delete}
              variant="ghost"
              leftIcon={<Trash2 size={16} color={colors.destructive} />}
              textStyle={{ color: colors.destructive }}
              onPress={confirmDelete}
              loading={remove.isPending}
              testID="delete-item"
            />
          ) : null}
        </View>

        <Text style={[styles.updated, { color: colors.mutedForeground }]}>{format(t.item.updated, { date: updated })}</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 48 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16 },
  headText: { flex: 1, gap: 2 },
  title: { fontSize: 22, fontWeight: '700' },
  meta: { fontSize: 14 },
  actions: { paddingHorizontal: 16, gap: 8 },
  updated: { textAlign: 'center', fontSize: 13, marginTop: 16 },
});
