import { useMemo, useState, type ReactNode } from 'react';
import { Copy, ExternalLink, KeyRound, Plus, Search, ShieldCheck, User } from 'lucide-react';
import type {
  WeldPassItem,
  WeldPassPasswordsApi,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { fillLogin, revealPassword } from '../lib/actions';
import { chromePage, openTab, type ActiveTab } from '../lib/chrome-page';
import { errorMessageKey } from '../lib/errors';
import { evaluateFill, pageContext } from '../lib/fill-policy';
import { t } from '../lib/i18n';
import { blockedMessageKey, fillMessageKey } from '../lib/messages';
import { filterItems } from '../lib/search';
import { safeExternalUrl } from '../lib/urls';
import { useAsync, type Notify } from './hooks';
import { Button, IconButton, Notice, Spinner } from './ui';

interface Props {
  api: WeldPassPasswordsApi;
  /** `undefined` while the active tab is being looked up. */
  tab: ActiveTab | null | undefined;
  notify: Notify;
  revision: number;
  onSave: () => void;
}

export function LoginsView({ api, tab, notify, revision, onSave }: Props) {
  const page = pageContext(tab?.url);
  const origin = page.ok ? page.origin : null;

  // Only the page's origin is sent, never its path or query string: the API
  // matches on the host alone.
  const matches = useAsync(
    async () => (origin ? (await api.matchItems(origin)).data : []),
    `${tab === undefined ? 'pending' : (origin ?? 'none')}|${revision}`,
  );
  const items = useAsync(async () => (await api.listItems({ type: 'login' })).data, `${revision}`);

  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const searching = query.trim() !== '';

  const siteItems = matches.data ?? [];
  const otherItems = useMemo(() => {
    const onSite = new Set((matches.data ?? []).map((item) => item.id));
    return (items.data ?? []).filter((item) => !onSite.has(item.id));
  }, [items.data, matches.data]);
  const results = useMemo(() => filterItems(items.data ?? [], query), [items.data, query]);

  /** One action at a time; an API failure becomes a status line, never an unhandled rejection. */
  async function act(item: WeldPassItem, action: () => Promise<void>) {
    if (busy) return;
    setBusy(item.id);
    try {
      await action();
    } catch (error) {
      notify('error', t(errorMessageKey(error)));
    } finally {
      setBusy(null);
    }
  }

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('ok', done);
    } catch {
      notify('error', t('copyFailed'));
    }
  }

  const fill = (item: WeldPassItem) =>
    act(item, async () => {
      if (!tab) {
        notify('error', t('fillNoPage'));
        return;
      }
      const outcome = await fillLogin(api, chromePage, item, tab.id);
      notify(outcome.ok ? 'ok' : 'error', t(fillMessageKey(outcome)));
      // Done: get out of the way. A username-only fill stays open to explain the next step.
      if (outcome.ok && outcome.password) window.setTimeout(() => window.close(), 700);
    });

  const copyPassword = (item: WeldPassItem) =>
    act(item, async () => {
      const password = await revealPassword(api, item);
      if (password === null) notify('error', t('noPassword'));
      else await copy(password, t('passwordCopied'));
    });

  const copyTotp = (item: WeldPassItem) =>
    act(item, async () => {
      const { code, expiresAt } = (await api.generateTotp(item.vaultId, item.id)).data;
      const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
      await copy(code, t('totpCopied', seconds));
    });

  const row = (item: WeldPassItem) => (
    <ItemRow
      key={item.id}
      item={item}
      canFill={evaluateFill(item, tab?.url).ok}
      disabled={busy !== null}
      onFill={() => fill(item)}
      onCopyUsername={() => copy(item.subtitle ?? '', t('usernameCopied'))}
      onCopyPassword={() => copyPassword(item)}
      onCopyTotp={() => copyTotp(item)}
    />
  );

  const firstFillable = (searching ? results : siteItems).find(
    (item) => evaluateFill(item, tab?.url).ok,
  );

  return (
    <div className="flex flex-col gap-3 p-3">
      <label className="relative block">
        <span className="sr-only">{t('searchLabel')}</span>
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          autoFocus
          value={query}
          placeholder={t('searchLabel')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter fills the first login that belongs on this page.
            if (event.key === 'Enter' && firstFillable) void fill(firstFillable);
          }}
          className="h-8 w-full rounded-md border bg-card pl-7 pr-2 text-[13px] placeholder:text-muted-foreground"
        />
      </label>

      {searching ? (
        <Section title={t('searchResults')}>
          {items.loading ? (
            <Spinner label={t('loading')} />
          ) : items.error ? (
            <LoadError error={items.error} onRetry={items.reload} />
          ) : results.length === 0 ? (
            <Empty>{t('noResults')}</Empty>
          ) : (
            <ul className="flex flex-col gap-1">{results.map(row)}</ul>
          )}
        </Section>
      ) : (
        <>
          <Section
            title={page.ok ? t('forHost', page.host) : t('tabLogins')}
            action={
              <Button variant="ghost" onClick={onSave} className="-mr-1.5 h-6 px-1.5">
                <Plus className="size-3.5" aria-hidden />
                {t('saveForSite')}
              </Button>
            }
          >
            {tab === undefined || matches.loading ? (
              <Spinner label={t('loading')} />
            ) : !page.ok ? (
              <Notice tone={page.reason === 'insecure-page' ? 'warning' : 'info'}>
                {t(blockedMessageKey(page.reason))}
              </Notice>
            ) : matches.error ? (
              <LoadError error={matches.error} onRetry={matches.reload} />
            ) : siteItems.length === 0 ? (
              <Empty>{t('noMatches')}</Empty>
            ) : (
              <ul className="flex flex-col gap-1">{siteItems.map(row)}</ul>
            )}
          </Section>

          <Section title={t('allLogins')}>
            {items.loading ? (
              <Spinner label={t('loading')} />
            ) : items.error ? (
              <LoadError error={items.error} onRetry={items.reload} />
            ) : (items.data ?? []).length === 0 ? (
              <Empty>{t('noItems')}</Empty>
            ) : (
              <ul className="flex flex-col gap-1">{otherItems.map(row)}</ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-1 text-xs text-muted-foreground">{children}</p>;
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <Notice tone="error">{t(errorMessageKey(error))}</Notice>
      <Button onClick={onRetry}>{t('retry')}</Button>
    </div>
  );
}

function ItemRow({
  item,
  canFill,
  disabled,
  onFill,
  onCopyUsername,
  onCopyPassword,
  onCopyTotp,
}: {
  item: WeldPassItem;
  /** Whether this login may go into the current page — decided again when Fill is pressed. */
  canFill: boolean;
  disabled: boolean;
  onFill: () => void;
  onCopyUsername: () => void;
  onCopyPassword: () => void;
  onCopyTotp: () => void;
}) {
  const siteUrl = safeExternalUrl(item.url);

  return (
    <li className="flex items-center gap-1 rounded-md border bg-card px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{item.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {item.subtitle || item.host || '—'}
        </div>
      </div>

      {item.subtitle && (
        <IconButton label={t('copyUsername')} disabled={disabled} onClick={onCopyUsername}>
          <User className="size-3.5" aria-hidden />
        </IconButton>
      )}
      <IconButton label={t('copyPassword')} disabled={disabled} onClick={onCopyPassword}>
        <Copy className="size-3.5" aria-hidden />
      </IconButton>
      {item.hasTotp && (
        <IconButton label={t('copyTotp')} disabled={disabled} onClick={onCopyTotp}>
          <ShieldCheck className="size-3.5" aria-hidden />
        </IconButton>
      )}
      {siteUrl && (
        <IconButton label={t('openSite')} onClick={() => openTab(siteUrl)}>
          <ExternalLink className="size-3.5" aria-hidden />
        </IconButton>
      )}
      {canFill && (
        <Button
          variant="primary"
          disabled={disabled}
          onClick={onFill}
          aria-label={t('fillItem', item.title)}
        >
          <KeyRound className="size-3.5" aria-hidden />
          {t('fill')}
        </Button>
      )}
    </li>
  );
}
