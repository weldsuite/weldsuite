/**
 * The secret side of the item screen: revealing the fields (after Face ID or
 * the passcode, audited by the server), which ones are shown, and copying.
 * Revealed fields live in this hook's state only and are dropped when the
 * app goes to the background.
 */

import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { WeldPassItemFields } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { useAppLock } from '@weldsuite/mobile-ui/contexts/AppLockContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { useRevealItem } from '@/hooks/use-passwords';
import { copySecret, copyText } from '@/lib/clipboard';
import { passErrorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';

export type SecretField = 'password' | 'notes' | 'content' | 'cardholder' | 'number' | 'expiry' | 'cvc';

const ALL_SECRETS: SecretField[] = ['password', 'notes', 'content', 'cardholder', 'number', 'expiry', 'cvc'];

export interface ItemSecrets {
  fields: WeldPassItemFields | null;
  revealing: boolean;
  /** The field's value once revealed, else null. */
  value: (field: SecretField) => string | null;
  isShown: (field: SecretField) => boolean;
  toggle: (field: SecretField) => Promise<void>;
  revealAll: () => Promise<void>;
  /** Copy a secret field: asks again, cleared from the clipboard after 30 s. */
  copySecretField: (label: string, field: SecretField) => Promise<void>;
  /** Copy a 2FA code the server minted. */
  copyCode: (code: string) => Promise<void>;
  /** Copy a username or a website: no prompt, not cleared. */
  copyPlain: (label: string, text: string) => Promise<void>;
}

export function useItemSecrets(vaultId: string, itemId: string): ItemSecrets {
  const { t, format } = useI18n();
  const toast = useToast();
  const lock = useAppLock();
  const reveal = useRevealItem();
  const [fields, setFields] = useState<WeldPassItemFields | null>(null);
  const [shown, setShown] = useState<ReadonlySet<SecretField>>(new Set());
  const { reset, mutateAsync } = reveal;

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
        const revealed = await mutateAsync({ vaultId, itemId });
        setFields(revealed.fields);
        return revealed.fields;
      } catch (error) {
        toast.error(passErrorMessage(t, error));
        return null;
      }
    },
    [fields, itemId, lock, mutateAsync, t, toast, vaultId],
  );

  const value = (field: SecretField): string | null => {
    const raw = fields ? (fields as unknown as Record<string, unknown>)[field] : null;
    return typeof raw === 'string' ? raw : null;
  };

  const toggle = async (field: SecretField) => {
    if (shown.has(field)) {
      setShown((current) => new Set([...current].filter((name) => name !== field)));
    } else if (await ensureFields(t.lock.revealPrompt)) {
      setShown((current) => new Set([...current, field]));
    }
  };

  const revealAll = async () => {
    if (await ensureFields(t.lock.revealPrompt)) setShown(new Set(ALL_SECRETS));
  };

  const copySecretField = async (label: string, field: SecretField) => {
    if (!(await lock.confirm(t.lock.copyPrompt))) return;
    const current = await ensureFields(t.lock.copyPrompt);
    const raw = current ? (current as unknown as Record<string, unknown>)[field] : null;
    if (typeof raw !== 'string' || !raw) return;
    await copySecret(raw);
    toast.success(format(t.item.copiedSecret, { field: label }));
  };

  const copyCode = async (code: string) => {
    if (!(await lock.confirm(t.lock.copyPrompt))) return;
    await copySecret(code);
    toast.success(format(t.item.copiedSecret, { field: t.item.totp }));
  };

  const copyPlain = async (label: string, text: string) => {
    await copyText(text);
    toast.success(format(t.item.copied, { field: label }));
  };

  return {
    fields,
    revealing: reveal.isPending,
    value,
    isShown: (field) => shown.has(field),
    toggle,
    revealAll,
    copySecretField,
    copyCode,
    copyPlain,
  };
}
