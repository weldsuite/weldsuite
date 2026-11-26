import { useEffect, useMemo, useState } from 'react';
import { Copy, KeyRound, Plus, ShieldCheck, User } from 'lucide-react';
import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import type { FilterPill } from '@weldsuite/app-api-client/schemas/weldpass-items';
import { fillLogin, revealPassword } from '../lib/actions';
import { chromePage, openTab, type ActiveTab } from '../lib/chrome-page';
import { errorMessageKey } from '../lib/errors';
import { evaluateFill, pageContext } from '../lib/fill-policy';
import { SquareArrowUpRightExit } from '../lib/icons';
import { t } from '../lib/i18n';
import { VAULT_FILTER, applyListView, isFiltered, type LoginSort } from '../lib/list-view';
import { blockedMessageKey, fillMessageKey } from '../lib/messages';
import { filterItems } from '../lib/search';
import { safeExternalUrl } from '../lib/urls';
import type { PopupApi } from './api';
import { useAsync, type Notify } from './hooks';
import { Empty, IconAction, LoadError, Padded, PopupAlert, Section, SiteIcon } from './list';
import { LoginDetails } from './LoginDetails';
import { LoginsToolbar } from './LoginsToolbar';
import { Button } from '@weldsuite/ui/components/button';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';

interface Props {
  api: PopupApi;
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
  const vaults = useAsync(async () => (await api.listVaults()).data, `${revision}`);

  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  /** The login whose details page is open. */
  const [opened, setOpened] = useState<WeldPassItem | null>(null);
  const [sort, setSort] = useState<LoginSort | null>(null);
  const [filters, setFilters] = useState<FilterPill[]>([]);
  const searching = query.trim() !== '';
  const filtering = isFiltered(filters);

  // A vault pill for a vault that is gone (another workspace, access removed) goes too.
  useEffect(() => {
    if (!vaults.data) return;
    const known = new Set(vaults.data.map((vault) => vault.id));
    setFilters((previous) => {
      const kept = previous.filter(
        (pill) => pill.field !== VAULT_FILTER || pill.value === '' || known.has(pill.value),
      );
      return kept.length === previous.length ? previous : kept;
    });
  }, [vaults.data]);

  const siteItems = useMemo(
    () => applyListView(matches.data ?? [], filters, sort),
    [matches.data, filters, sort],
  );
  const otherItems = useMemo(() => {
    const onSite = new Set((matches.data ?? []).map((item) => item.id));
    return applyListView(
      (items.data ?? []).filter((item) => !onSite.has(item.id)),
      filters,
      sort,
    );
  }, [items.data, matches.data, filters, sort]);
  const results = useMemo(
    () => applyListView(filterItems(items.data ?? [], query), filters, sort),
    [items.data, query, filters, sort],
  );

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
      onOpen={() => setOpened(item)}
    />
  );

  const firstFillable = (searching ? results : siteItems).find(
    (item) => evaluateFill(item, tab?.url).ok,
  );

  const openedVault = opened ? vaults.data?.find((vault) => vault.id === opened.vaultId) : undefined;

  return (
    <div className="flex flex-col">
      {opened && (
        <LoginDetails
          item={opened}
          api={api}
          vaultName={openedVault ? (openedVault.kind === 'personal' ? t('personalVault') : openedVault.name) : null}
          canFill={evaluateFill(opened, tab?.url).ok}
          onFill={() => void fill(opened)}
          onClose={() => setOpened(null)}
          notify={notify}
        />
      )}
      <LoginsToolbar
        query={query}
        onQueryChange={setQuery}
        onSubmit={() => {
          if (firstFillable) void fill(firstFillable);
        }}
        sort={sort}
        onSortChange={setSort}
        filters={filters}
        onFiltersChange={setFilters}
        vaults={vaults.data ?? []}
      />

      {searching ? (
        <Section title={t('searchResults')} count={items.data ? results.length : undefined}>
          {items.loading ? (
            <Padded>
              <InlineSpinner label={t('loading')} className="py-0" />
            </Padded>
          ) : items.error ? (
            <LoadError error={items.error} onRetry={items.reload} />
          ) : results.length === 0 ? (
            <Empty>{t(filtering ? 'noFilterMatches' : 'noResults')}</Empty>
          ) : (
            <ul>{results.map(row)}</ul>
          )}
        </Section>
      ) : (
        <>
          <Section
            title={page.ok ? t('forHost', page.host) : t('tabLogins')}
            count={page.ok && matches.data ? siteItems.length : undefined}
            action={
              <Button variant="ghost" size="xs" onClick={onSave} className="-mr-1.5">
                <Plus className="size-3.5" aria-hidden />
                {t('saveForSite')}
              </Button>
            }
          >
            {tab === undefined || matches.loading ? (
              <Padded>
                <InlineSpinner label={t('loading')} className="py-0" />
              </Padded>
            ) : !page.ok ? (
              <Padded>
                <PopupAlert tone={page.reason === 'insecure-page' ? 'warning' : 'info'}>
                  {t(blockedMessageKey(page.reason))}
                </PopupAlert>
              </Padded>
            ) : matches.error ? (
              <LoadError error={matches.error} onRetry={matches.reload} />
            ) : siteItems.length === 0 ? (
              <Empty>
                {t(filtering && (matches.data ?? []).length > 0 ? 'noFilterMatches' : 'noMatches')}
              </Empty>
            ) : (
              <ul>{siteItems.map(row)}</ul>
            )}
          </Section>

          <Section title={t('allLogins')} count={items.data ? otherItems.length : undefined}>
            {items.loading ? (
              <Padded>
                <InlineSpinner label={t('loading')} className="py-0" />
              </Padded>
            ) : items.error ? (
              <LoadError error={items.error} onRetry={items.reload} />
            ) : (items.data ?? []).length === 0 ? (
              <Empty>{t('noItems')}</Empty>
            ) : filtering && otherItems.length === 0 ? (
              <Empty>{t('noFilterMatches')}</Empty>
            ) : (
              <ul>{otherItems.map(row)}</ul>
            )}
          </Section>
        </>
      )}
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
  onOpen,
}: {
  item: WeldPassItem;
  /** Whether this login may go into the current page — decided again when Fill is pressed. */
  canFill: boolean;
  disabled: boolean;
  onFill: () => void;
  onCopyUsername: () => void;
  onCopyPassword: () => void;
  onCopyTotp: () => void;
  /** Opens the login's details page: a click anywhere on the row that isn't one of its buttons. */
  onOpen: () => void;
}) {
  const siteUrl = safeExternalUrl(item.url);

  // A row in the platform's list style (EntityList): full width, a divider
  // below, a light hover. The copy and open actions show on hover or keyboard
  // focus, and always on touch screens; Fill stays visible. As in the
  // platform's lists, a button stretched over the row opens its details; the
  // row's own buttons sit above it.
  return (
    <li className="group relative flex cursor-pointer items-center gap-2.5 border-b border-border/70 px-3 py-2 transition-colors hover:bg-muted/40">
      <button
        type="button"
        aria-label={t('openLogin', item.title)}
        onClick={onOpen}
        className="absolute inset-0 z-0 cursor-pointer focus-visible:outline-offset-[-2px]"
      />
      <SiteIcon url={item.url} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{item.title}</span>
          {item.hasTotp && <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {item.subtitle || item.host || '—'}
        </div>
      </div>

      <div className="relative z-[1] flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        {item.subtitle && (
          <IconAction label={t('copyUsername')} disabled={disabled} onClick={onCopyUsername}>
            <User className="size-3.5" aria-hidden />
          </IconAction>
        )}
        <IconAction label={t('copyPassword')} disabled={disabled} onClick={onCopyPassword}>
          <Copy className="size-3.5" aria-hidden />
        </IconAction>
        {item.hasTotp && (
          <IconAction label={t('copyTotp')} disabled={disabled} onClick={onCopyTotp}>
            <ShieldCheck className="size-3.5" aria-hidden />
          </IconAction>
        )}
        {siteUrl && (
          <IconAction label={t('openSite')} onClick={() => openTab(siteUrl)}>
            <SquareArrowUpRightExit className="size-3.5" aria-hidden />
          </IconAction>
        )}
      </div>
      {canFill && (
        <Button
          size="sm"
          disabled={disabled}
          onClick={onFill}
          aria-label={t('fillItem', item.title)}
          className="relative z-[1] h-7 gap-1.5 px-2.5 text-xs"
        >
          <KeyRound className="size-3.5" aria-hidden />
          {t('fill')}
        </Button>
      )}
    </li>
  );
}
