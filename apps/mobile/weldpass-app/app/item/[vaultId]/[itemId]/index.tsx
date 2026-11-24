/**
 * One item. The list's metadata shows straight away; the secret fields stay
 * dots until the person reveals them, which asks Face ID (or the passcode)
 * and is a request the server audits. Revealed fields live in this screen's
 * state only: they are dropped when the app goes to the background and when
 * the screen closes.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pencil, Trash2 } from 'lucide-react-native';
import type { WeldPassItemFields } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { canEditVault, safeHref } from '@weldsuite/app-api-client/schemas/weldpass-items';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useAppLock } from '@weldsuite/mobile-ui/contexts/AppLockContext';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { FieldRow } from '@/components/FieldRow';
import { Group } from '@/components/Group';
import { ItemIcon } from '@/components/ItemIcon';
import { HeaderButton, Screen } from '@/components/Screen';
import { TotpCode } from '@/components/TotpCode';
import { useDeleteItem, useItems, useRevealItem, useVaults } from '@/hooks/use-passwords';
import { copySecret, copyText } from '@/lib/clipboard';
import { passErrorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';
import { usePreventScreenshots } from '@/lib/privacy';
import { vaultLabel } from '@/lib/vaults';

type SecretField = 'password' | 'notes' | 'content' | 'cardholder' | 'number' | 'expiry' | 'cvc';

export default function ItemScreen() {
  const { vaultId, itemId } = useLocalSearchParams<{ vaultId: string; itemId: string }>();
  const { t, format, intlLocale } = useI18n();
  const { colors } = useTheme();
  const toast = useToast();
  const router = useRouter();
  const lock = useAppLock();
  const items = useItems();
  const vaults = useVaults();
  const reveal = useRevealItem();
  const remove = useDeleteItem();
  const [fields, setFields] = useState<WeldPassItemFields | null>(null);
  const [shown, setShown] = useState<ReadonlySet<SecretField>>(new Set());
  usePreventScreenshots();

  const item = items.data?.find((candidate) => candidate.id === itemId);
  const vault = vaults.data?.find((candidate) => candidate.id === vaultId);
  const { reset } = reveal;

  // Back from the background: everything hidden again.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'background') return;
      setFields(null);
      setShown(new Set());
      reset();
    });
    return () => subscription.remove();
  }, [reset]);

  /** The item's fields, revealing them (after a confirmation) the first time. */
  const ensureFields = useCallback(
    async (prompt: string): Promise<WeldPassItemFields | null> => {
      if (fields) return fields;
      if (!(await lock.confirm(prompt))) return null;
      try {
        const revealed = await reveal.mutateAsync({ vaultId, itemId });
        setFields(revealed.fields);
        return revealed.fields;
      } catch (error) {
        toast.error(passErrorMessage(t, error));
        return null;
      }
    },
    [fields, itemId, lock, reveal, t, toast, vaultId],
  );

  const toggle = async (field: SecretField) => {
    if (shown.has(field)) {
      setShown((current) => new Set([...current].filter((name) => name !== field)));
      return;
    }
    if (await ensureFields(t.lock.revealPrompt)) setShown((current) => new Set([...current, field]));
  };

  const revealAll = async () => {
    if (await ensureFields(t.lock.revealPrompt)) {
      setShown(new Set<SecretField>(['password', 'notes', 'content', 'cardholder', 'number', 'expiry', 'cvc']));
    }
  };

  const copyField = async (label: string, pick: (fields: WeldPassItemFields) => string | undefined) => {
    if (!(await lock.confirm(t.lock.copyPrompt))) return;
    const current = await ensureFields(t.lock.copyPrompt);
    const value = current ? pick(current) : undefined;
    if (!value) return;
    await copySecret(value);
    toast.success(format(t.item.copiedSecret, { field: label }));
  };

  const copyPlain = async (label: string, value: string) => {
    await copyText(value);
    toast.success(format(t.item.copied, { field: label }));
  };

  const copyCode = async (code: string) => {
    if (!(await lock.confirm(t.lock.copyPrompt))) return;
    await copySecret(code);
    toast.success(format(t.item.copiedSecret, { field: t.item.totp }));
  };

  const confirmDelete = () => {
    if (!item) return;
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

  if (!item) {
    return (
      <Screen title="" back>
        {items.isLoading ? null : <EmptyState title={t.item.notFound} />}
      </Screen>
    );
  }

  const writable = canEditVault(vault);
  const href = safeHref(item.url);
  const value = (field: SecretField): string | null => {
    if (!fields) return null;
    const raw = (fields as unknown as Record<string, unknown>)[field];
    return typeof raw === 'string' ? raw : null;
  };
  const updated = new Date(item.updatedAt).toLocaleDateString(intlLocale, { day: 'numeric', month: 'long', year: 'numeric' });

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
              {[t.types[item.type], vault ? vaultLabel(t, vault) : null].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </View>

        {item.type === 'login' ? (
          <Group>
            <FieldRow
              label={t.item.username}
              value={item.subtitle}
              onCopy={item.subtitle ? () => void copyPlain(t.item.username, item.subtitle ?? '') : undefined}
              testID="field-username"
            />
            <FieldRow
              label={t.item.password}
              value={value('password')}
              secret
              shown={shown.has('password')}
              monospace
              onToggle={() => void toggle('password')}
              onCopy={() => void copyField(t.item.password, (f) => ('password' in f ? f.password : undefined))}
              testID="field-password"
            />
            {item.url ? (
              <FieldRow
                label={t.item.website}
                value={item.url}
                onOpen={href ? () => void Linking.openURL(href) : undefined}
                onCopy={() => void copyPlain(t.item.website, item.url ?? '')}
                testID="field-website"
              />
            ) : null}
            {item.hasTotp ? (
              <TotpCode vaultId={vaultId} itemId={itemId} onCopy={(code) => void copyCode(code)} />
            ) : null}
          </Group>
        ) : null}

        {item.type === 'card' ? (
          <Group>
            <FieldRow label={t.item.cardholder} value={value('cardholder')} secret shown={shown.has('cardholder')} onToggle={() => void toggle('cardholder')} />
            <FieldRow
              label={t.item.number}
              value={value('number')}
              secret
              shown={shown.has('number')}
              monospace
              onToggle={() => void toggle('number')}
              onCopy={() => void copyField(t.item.number, (f) => ('number' in f ? f.number : undefined))}
            />
            <FieldRow label={t.item.expiry} value={value('expiry')} secret shown={shown.has('expiry')} onToggle={() => void toggle('expiry')} />
            <FieldRow
              label={t.item.cvc}
              value={value('cvc')}
              secret
              shown={shown.has('cvc')}
              onToggle={() => void toggle('cvc')}
              onCopy={() => void copyField(t.item.cvc, (f) => ('cvc' in f ? f.cvc : undefined))}
            />
          </Group>
        ) : null}

        {item.type === 'note' ? (
          <Group>
            <FieldRow
              label={t.item.content}
              value={value('content')}
              secret
              shown={shown.has('content')}
              multiline
              onToggle={() => void toggle('content')}
              onCopy={() => void copyField(t.item.content, (f) => ('content' in f ? f.content : undefined))}
            />
          </Group>
        ) : null}

        {item.type !== 'note' ? (
          <Group>
            <FieldRow label={t.item.notes} value={value('notes')} secret shown={shown.has('notes')} multiline onToggle={() => void toggle('notes')} />
            {fields && 'username' in fields && fields.apps?.length ? (
              <FieldRow label={t.item.apps} value={fields.apps.join('\n')} multiline />
            ) : null}
          </Group>
        ) : null}

        <View style={styles.actions}>
          {!fields ? (
            <Button title={t.item.reveal} variant="outline" onPress={() => void revealAll()} loading={reveal.isPending} testID="reveal-item" />
          ) : null}
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
