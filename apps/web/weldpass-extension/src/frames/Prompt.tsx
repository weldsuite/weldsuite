/**
 * The save bar (`prompt.html`), framed into the top of the page after a
 * login was submitted. It shows the site and the username, never the
 * password: that stays with the worker, in memory, until saved or dropped.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { t, type MessageKey } from '../lib/i18n';
import { frameParams, promptRequest } from '../lib/messaging';
import type { PromptContext, PromptOutcome } from '../lib/protocol';
import { Brand, Button, IconButton } from '../popup/ui';
import { useClickGuard } from './guard';

const { nonce } = frameParams();

type Act = (event: { isTrusted: boolean }, run: () => Promise<PromptOutcome>, guarded?: boolean) => Promise<void>;

export function Prompt() {
  const [context, setContext] = useState<PromptContext | null | undefined>(undefined);
  const [vaultId, setVaultId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const { armed, accept } = useClickGuard(root);

  useEffect(() => {
    promptRequest({ type: 'prompt:init', nonce }).then(
      (value) => {
        setContext(value);
        const preferred = value?.vaults.find((vault) => vault.personal) ?? value?.vaults[0];
        if (preferred) setVaultId(preferred.id);
      },
      () => setContext(null),
    );
  }, []);

  const act: Act = async (event, run, guarded = true) => {
    if (busy || (guarded && !accept(event))) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await run();
      if (!outcome.ok) setError(outcome.reason === 'expired' ? 'promptExpired' : 'errorGeneric');
    } catch {
      setError('errorGeneric');
    } finally {
      setBusy(false);
    }
  };

  // Dismissing is always allowed: it only forgets.
  const dismiss = (event: { isTrusted: boolean }) =>
    act(event, () => promptRequest({ type: 'prompt:dismiss', nonce }), false);

  // The frame is its own document: Escape anywhere in it is "not now".
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void dismiss(event);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div ref={root} className="flex h-full flex-col gap-2 bg-background p-3">
      <header className="flex items-center justify-between">
        <Brand />
        <IconButton label={t('promptNotNow')} onClick={dismiss}>
          <X className="size-3.5" aria-hidden />
        </IconButton>
      </header>

      {context === undefined && <output className="block text-xs text-muted-foreground">{t('loading')}</output>}
      {context === null && <p className="text-xs text-muted-foreground">{t('promptExpired')}</p>}
      {context && (
        <PromptForm
          context={context}
          vaultId={vaultId}
          onVaultChange={setVaultId}
          armed={armed}
          busy={busy}
          error={error}
          act={act}
          dismiss={dismiss}
        />
      )}
    </div>
  );
}

function PromptForm({
  context,
  vaultId,
  onVaultChange,
  armed,
  busy,
  error,
  act,
  dismiss,
}: Readonly<{
  context: PromptContext;
  vaultId: string;
  onVaultChange: (vaultId: string) => void;
  armed: boolean;
  busy: boolean;
  error: MessageKey | null;
  act: Act;
  dismiss: (event: { isTrusted: boolean }) => void;
}>) {
  const ids = useId();
  const saving = context.kind === 'save';
  const cannotSave = saving && context.vaults.length === 0;
  const confirm = () =>
    saving ? promptRequest({ type: 'prompt:save', nonce, vaultId }) : promptRequest({ type: 'prompt:update', nonce });

  return (
    <>
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold">
          {saving ? t('promptSaveTitle', context.host) : t('promptUpdateTitle', context.itemTitle ?? context.host)}
        </h1>
        <p className="truncate text-xs text-muted-foreground">{context.username || t('promptNoUsername')}</p>
      </div>

      {saving && context.vaults.length > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <label htmlFor={`${ids}-vault`} className="text-muted-foreground">
            {t('fieldVault')}
          </label>
          <select
            id={`${ids}-vault`}
            value={vaultId}
            onChange={(event) => onVaultChange(event.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border bg-card px-1.5 text-xs"
          >
            {context.vaults.map((vault) => (
              <option key={vault.id} value={vault.id}>
                {vault.personal ? t('personalVault') : vault.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {cannotSave && <p className="text-xs text-warning">{t('noWritableVault')}</p>}

      <div className="mt-auto flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          disabled={busy}
          onClick={(event) => act(event, () => promptRequest({ type: 'prompt:never', nonce }))}
        >
          {t('promptNever')}
        </Button>
        <Button disabled={busy} onClick={dismiss}>
          {t('promptNotNow')}
        </Button>
        <Button
          variant="primary"
          aria-disabled={!armed || undefined}
          disabled={busy || cannotSave}
          className={armed ? undefined : 'opacity-60'}
          onClick={(event) => act(event, confirm)}
        >
          {saving ? t('save') : t('promptUpdate')}
        </Button>
      </div>
      <output aria-live="polite" className="block min-h-4 text-xs text-destructive">
        {error ? t(error) : null}
      </output>
    </>
  );
}
