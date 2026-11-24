/**
 * The inline menu (`menu.html`), framed into the page by the content script.
 * The page can't read it: it is an extension page in a cross-origin frame.
 *
 * It lists the saved logins for the field's frame (metadata only), the 2FA
 * codes on a one-time-code field, or a generated password on a sign-up or
 * change-password field. A pick goes to the worker, which reveals the login
 * and sends it to that frame alone; this page never sees a saved password.
 */

import { useEffect, useRef, useState } from 'react';
import { KeyRound, RefreshCw, ShieldCheck, X } from 'lucide-react';
import {
  generatePassword,
  passwordStrength,
} from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { t, type MessageKey } from '../lib/i18n';
import { frameParams, menuRequest } from '../lib/messaging';
import type { MenuContext, MenuItem, MenuOutcome } from '../lib/protocol';
import { serverLabel } from '../lib/server';
import { Brand, IconButton, cx } from '../popup/ui';
import { moveFocus, supportsTrackVisibility, useClickGuard } from './guard';

const { nonce, keyboard } = frameParams();

const OUTCOME: Record<Exclude<MenuOutcome, { ok: true }>['reason'], MessageKey> = {
  expired: 'menuExpired',
  refused: 'fillHostMismatch',
  'no-fields': 'fillNoFields',
  'page-changed': 'fillPageChanged',
  error: 'errorGeneric',
};

export function Menu() {
  const [context, setContext] = useState<MenuContext | null | undefined>(undefined);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const { armed, accept } = useClickGuard(root);

  useEffect(() => {
    menuRequest({ type: 'menu:init', nonce }).then(
      (value) => setContext(value),
      () => setContext(null),
    );
  }, []);

  useEffect(() => {
    if (keyboard && context) list.current?.querySelector<HTMLButtonElement>('button[data-item]')?.focus();
  }, [context]);

  const close = () => void menuRequest({ type: 'menu:close', nonce }).catch(() => undefined);

  async function act(event: { isTrusted: boolean }, run: () => Promise<MenuOutcome>) {
    if (busy || !accept(event)) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await run();
      // Success: the worker closes the menu.
      if (!outcome.ok) setError(OUTCOME[outcome.reason]);
    } catch {
      setError('errorGeneric');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={root}
      className="flex h-full flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
        else moveFocus(event, list.current);
      }}
    >
      <header className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <Brand />
        <IconButton label={t('close')} onClick={close}>
          <X className="size-3.5" aria-hidden />
        </IconButton>
      </header>

      {context?.crossOrigin && (
        <p className="border-b bg-warning/10 px-3 py-1.5 text-xs">
          {t('menuFrameOrigin', serverLabel(context.frameOrigin))}
        </p>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {context === undefined ? (
          <p className="p-2 text-xs text-muted-foreground" role="status">
            {t('loading')}
          </p>
        ) : context === null ? (
          <p className="p-2 text-xs text-muted-foreground">{t('menuExpired')}</p>
        ) : !supportsTrackVisibility() ? (
          <p className="p-2 text-xs text-muted-foreground">{t('menuUnsupported')}</p>
        ) : context.blocked ? (
          <p className="p-2 text-xs text-muted-foreground">{t('fillInsecure')}</p>
        ) : context.kind === 'new-password' ? (
          <Generated
            disabled={!armed || busy}
            onUse={(event, password) =>
              act(event, () => menuRequest({ type: 'menu:generated', nonce, password }))
            }
          />
        ) : context.items.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            {context.kind === 'one-time-code' ? t('menuNoTotp') : t('noMatches')}
          </p>
        ) : (
          <ul ref={list} className="flex flex-col gap-0.5" aria-label={t('menuListLabel')}>
            {context.items.map((item) => (
              <li key={item.id}>
                <ItemButton
                  item={item}
                  totp={context.kind === 'one-time-code'}
                  disabled={!armed || busy}
                  onPick={(event) =>
                    act(event, () =>
                      menuRequest({
                        type: context.kind === 'one-time-code' ? 'menu:totp' : 'menu:fill',
                        nonce,
                        itemId: item.id,
                        vaultId: item.vaultId,
                      }),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer role="status" aria-live="polite" className="min-h-6 border-t px-3 py-1 text-xs text-destructive">
        {error ? t(error) : null}
      </footer>
    </div>
  );
}

function ItemButton({
  item,
  totp,
  disabled,
  onPick,
}: {
  item: MenuItem;
  totp: boolean;
  disabled: boolean;
  onPick: (event: { isTrusted: boolean }) => void;
}) {
  const Icon = totp ? ShieldCheck : KeyRound;
  return (
    <button
      type="button"
      data-item=""
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (!disabled) onPick(event);
      }}
      className={cx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
        'hover:bg-muted focus-visible:bg-muted',
        disabled && 'cursor-default opacity-60',
      )}
    >
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-foreground">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {totp ? t('menuTotpFor', item.username || item.host || '—') : item.username || item.host || '—'}
        </span>
      </span>
    </button>
  );
}

function Generated({
  disabled,
  onUse,
}: {
  disabled: boolean;
  onUse: (event: { isTrusted: boolean }, password: string) => void;
}) {
  // Shown, so held in this page's state until it closes; never stored.
  const [password, setPassword] = useState(() => generatePassword({ length: 20 }));
  const strength = passwordStrength(password);
  return (
    <div className="flex flex-col gap-2 p-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">{t('genPassword')}</span>
        <span className={cx('font-medium', strength === 'strong' ? 'text-success' : 'text-warning')}>
          {t(strength === 'strong' ? 'strengthStrong' : strength === 'fair' ? 'strengthFair' : 'strengthWeak')}
        </span>
      </div>
      <output className="block select-all break-all rounded-md border bg-card px-2.5 py-2 font-mono text-[13px]">
        {password}
      </output>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium hover:bg-muted"
          onClick={() => setPassword(generatePassword({ length: 20 }))}
        >
          <RefreshCw className="size-3.5" aria-hidden />
          {t('genRegenerate')}
        </button>
        <button
          type="button"
          data-item=""
          aria-disabled={disabled || undefined}
          className={cx(
            'inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground',
            disabled ? 'cursor-default opacity-60' : 'hover:opacity-90',
          )}
          onClick={(event) => {
            if (!disabled) onUse(event, password);
          }}
        >
          <KeyRound className="size-3.5" aria-hidden />
          {t('menuUseGenerated')}
        </button>
      </div>
    </div>
  );
}
