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

export function Prompt() {
  const ids = useId();
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

  async function act(event: { isTrusted: boolean }, run: () => Promise<PromptOutcome>, guarded = true) {
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
  }

  // Dismissing is always allowed: it only forgets.
  const dismiss = (event: { isTrusted: boolean }) =>
    act(event, () => promptRequest({ type: 'prompt:dismiss', nonce }), false);

  const cannotSave = context?.kind === 'save' && context.vaults.length === 0;

  return (
    <div
      ref={root}
      className="flex h-full flex-col gap-2 bg-background p-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') void dismiss(event);
      }}
    >
      <header className="flex items-center justify-between">
        <Brand />
        <IconButton label={t('promptNotNow')} onClick={dismiss}>
          <X className="size-3.5" aria-hidden />
        </IconButton>
      </header>

      {context === undefined ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t('loading')}
        </p>
      ) : context === null ? (
        <p className="text-xs text-muted-foreground">{t('promptExpired')}</p>
      ) : (
        <>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">
              {context.kind === 'save'
                ? t('promptSaveTitle', context.host)
                : t('promptUpdateTitle', context.itemTitle ?? context.host)}
            </h1>
            <p className="truncate text-xs text-muted-foreground">{context.username || t('promptNoUsername')}</p>
          </div>

          {context.kind === 'save' && context.vaults.length > 1 && (
            <div className="flex items-center gap-2 text-xs">
              <label htmlFor={`${ids}-vault`} className="text-muted-foreground">
                {t('fieldVault')}
              </label>
              <select
                id={`${ids}-vault`}
                value={vaultId}
                onChange={(event) => setVaultId(event.target.value)}
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
              className={!armed ? 'opacity-60' : undefined}
              onClick={(event) =>
                act(event, () =>
                  context.kind === 'save'
                    ? promptRequest({ type: 'prompt:save', nonce, vaultId })
                    : promptRequest({ type: 'prompt:update', nonce }),
                )
              }
            >
              {context.kind === 'save' ? t('save') : t('promptUpdate')}
            </Button>
          </div>
          <p role="status" aria-live="polite" className="min-h-4 text-xs text-destructive">
            {error ? t(error) : null}
          </p>
        </>
      )}
    </div>
  );
}
