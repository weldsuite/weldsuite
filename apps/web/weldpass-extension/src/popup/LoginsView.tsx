import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Copy, KeyRound, Plus, ShieldCheck, User } from 'lucide-react';
import type { WeldPassItem, WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import type { FilterPill } from '@weldsuite/app-api-client/schemas/weldpass-items';
import { Button } from '@weldsuite/ui/components/button';
import { fillLogin, revealPassword } from '../lib/actions';
import { chromePage, openTab, type ActiveTab } from '../lib/chrome-page';
import { errorMessageKey } from '../lib/errors';
import { evaluateFill, pageContext, type PageContext } from '../lib/fill-policy';
import { SquareArrowUpRightExit } from '../lib/icons';
import { t, type MessageKey } from '../lib/i18n';
import { VAULT_FILTER, applyListView, isFiltered, type LoginSort } from '../lib/list-view';
import { blockedMessageKey, fillMessageKey } from '../lib/messages';
import { filterItems } from '../lib/search';
import { safeExternalUrl } from '../lib/urls';
import type { PopupApi } from './api';
import { copyText } from './clipboard';
import { useAsync, type AsyncState, type Notify } from './hooks';
import { Empty, IconAction, LoadError, Loading, Padded, PopupAlert, Section, SiteIcon, vaultLabel } from './list';
import { LoginDetails } from './LoginDetails';
import { LoginsToolbar } from './LoginsToolbar';

interface Props {
  api: PopupApi;
  /** `undefined` while the active tab is being looked up. */
  tab: ActiveTab | null | undefined;
  notify: Notify;
  revision: number;
  onSave: () => void;
}

type Logins = AsyncState<WeldPassItem[]>;
type Row = (item: WeldPassItem) => ReactNode;

/**
 * The popup's home page: the logins saved for the page the popup was opened
 * on, then all the others, or the search's matches. A row opens the login's
 * details page.
 */
export function LoginsView({ api, tab, notify, revision, onSave }: Readonly<Props>) {
  const page = pageContext(tab?.url);
  const origin = page.ok ? page.origin : null;

  // Only the page's origin is sent, never its path or query string: the API
  // matches on the host alone.
  const matchKey = tab === undefined ? 'pending' : (origin ?? 'none');
  const matches = useAsync(async () => (origin ? (await api.matchItems(origin)).data : []), `${matchKey}|${revision}`);
  const items = useAsync(async () => (await api.listItems({ type: 'login' })).data, `${revision}`);
  const vaults = useAsync(async () => (await api.listVaults()).data, `${revision}`);

  const [query, setQuery] = useState('');
  /** The login whose details page is open. */
  const [opened, setOpened] = useState<WeldPassItem | null>(null);
  const { sort, setSort, filters, setFilters } = useListControls(vaults.data);
  const actions = useLoginActions(api, tab, notify);
  const searching = query.trim() !== '';
  const filtering = isFiltered(filters);

  const siteItems = useMemo(() => applyListView(matches.data ?? [], filters, sort), [matches.data, filters, sort]);
  const otherItems = useMemo(
    () => applyListView(withoutItems(items.data, matches.data), filters, sort),
    [items.data, matches.data, filters, sort],
  );
  const results = useMemo(
    () => applyListView(filterItems(items.data ?? [], query), filters, sort),
    [items.data, query, filters, sort],
  );

  const canFill = (item: WeldPassItem) => evaluateFill(item, tab?.url).ok;
  const row: Row = (item) => (
    <ItemRow
      key={item.id}
      item={item}
      canFill={canFill(item)}
      disabled={actions.busy}
      onFill={() => actions.fill(item)}
      onCopyUsername={() => actions.copyUsername(item)}
      onCopyPassword={() => actions.copyPassword(item)}
      onCopyTotp={() => actions.copyTotp(item)}
      onOpen={() => setOpened(item)}
    />
  );

  // Enter in the search field fills the first login that may go into the page.
  const firstFillable = (searching ? results : siteItems).find(canFill);

  return (
    <div className="flex flex-col">
      {opened && (
        <LoginDetails
          item={opened}
          api={api}
          vaultName={openedVaultName(vaults.data, opened)}
          canFill={canFill(opened)}
          onFill={() => void actions.fill(opened)}
          onClose={() => setOpened(null)}
          notify={notify}
        />
      )}
      <LoginsToolbar
        query={query}
        onQueryChange={setQuery}
        onSubmit={() => {
          if (firstFillable) void actions.fill(firstFillable);
        }}
        sort={sort}
        onSortChange={setSort}
        filters={filters}
        onFiltersChange={setFilters}
        vaults={vaults.data ?? []}
        paused={opened !== null}
      />

      {searching ? (
        <SearchResults logins={items} shown={results} filtering={filtering} row={row} />
      ) : (
        <>
          <SiteLogins tab={tab} page={page} logins={matches} shown={siteItems} filtering={filtering} row={row} onSave={onSave} />
          <OtherLogins logins={items} shown={otherItems} filtering={filtering} row={row} />
        </>
      )}
    </div>
  );
}

/** The list's sort and filter pills. A vault pill for a vault that is gone (another workspace, access removed) goes. */
function useListControls(vaults: WeldPassVault[] | undefined) {
  const [sort, setSort] = useState<LoginSort | null>(null);
  const [filters, setFilters] = useState<FilterPill[]>([]);
  useEffect(() => {
    if (vaults) setFilters((previous) => withKnownVaults(previous, vaults));
  }, [vaults]);
  return { sort, setSort, filters, setFilters };
}

function withKnownVaults(pills: FilterPill[], vaults: WeldPassVault[]): FilterPill[] {
  const known = new Set(vaults.map((vault) => vault.id));
  const kept = pills.filter((pill) => pill.field !== VAULT_FILTER || pill.value === '' || known.has(pill.value));
  return kept.length === pills.length ? pills : kept;
}

/** All logins but the ones already listed for the page. */
function withoutItems(all: WeldPassItem[] = [], listed: WeldPassItem[] = []): WeldPassItem[] {
  const ids = new Set(listed.map((item) => item.id));
  return all.filter((item) => !ids.has(item.id));
}

function openedVaultName(vaults: WeldPassVault[] | undefined, item: WeldPassItem): string | null {
  const vault = vaults?.find((candidate) => candidate.id === item.vaultId);
  return vault ? vaultLabel(vault) : null;
}

/** A row's actions, one at a time. An API failure becomes a status line, never an unhandled rejection. */
function useLoginActions(api: PopupApi, tab: ActiveTab | null | undefined, notify: Notify) {
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      notify('error', t(errorMessageKey(error)));
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    fill: (item: WeldPassItem) => act(() => fillInto(api, tab, item, notify)),
    copyUsername: (item: WeldPassItem) => copyText(item.subtitle ?? '', t('usernameCopied'), notify),
    copyPassword: (item: WeldPassItem) => act(() => copyPassword(api, item, notify)),
    copyTotp: (item: WeldPassItem) => act(() => copyTotp(api, item, notify)),
  };
}

async function fillInto(api: PopupApi, tab: ActiveTab | null | undefined, item: WeldPassItem, notify: Notify) {
  if (!tab) {
    notify('error', t('fillNoPage'));
    return;
  }
  const outcome = await fillLogin(api, chromePage, item, tab.id);
  notify(outcome.ok ? 'ok' : 'error', t(fillMessageKey(outcome)));
  // Done: get out of the way. A username-only fill stays open to explain the next step.
  if (outcome.ok && outcome.password) window.setTimeout(() => window.close(), 700);
}

async function copyPassword(api: PopupApi, item: WeldPassItem, notify: Notify) {
  const password = await revealPassword(api, item);
  if (password === null) notify('error', t('noPassword'));
  else await copyText(password, t('passwordCopied'), notify);
}

async function copyTotp(api: PopupApi, item: WeldPassItem, notify: Notify) {
  const { code, expiresAt } = (await api.generateTotp(item.vaultId, item.id)).data;
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
  await copyText(code, t('totpCopied', seconds), notify);
}

/** Why a list shows nothing: the filters hide its logins, or there are none. `null` while it shows some. */
function emptyNote(shown: readonly unknown[], filteredOut: boolean, none: MessageKey): MessageKey | null {
  if (shown.length > 0) return null;
  return filteredOut ? 'noFilterMatches' : none;
}

/** A list's body: its loading state, a load error, why it is empty, or its rows. */
function ListBody({
  logins,
  empty,
  children,
}: Readonly<{ logins: Logins; empty: MessageKey | null; children: ReactNode }>) {
  if (logins.loading) return <Loading />;
  if (logins.error) return <LoadError error={logins.error} onRetry={logins.reload} />;
  if (empty) return <Empty>{t(empty)}</Empty>;
  return <ul>{children}</ul>;
}

interface ListProps {
  logins: Logins;
  /** The logins after search, filters and sort. */
  shown: WeldPassItem[];
  filtering: boolean;
  row: Row;
}

function SearchResults({ logins, shown, filtering, row }: Readonly<ListProps>) {
  return (
    <Section title={t('searchResults')} count={logins.data ? shown.length : undefined}>
      <ListBody logins={logins} empty={emptyNote(shown, filtering, 'noResults')}>
        {shown.map(row)}
      </ListBody>
    </Section>
  );
}

function SiteLogins({
  tab,
  page,
  logins,
  shown,
  filtering,
  row,
  onSave,
}: Readonly<ListProps & { tab: ActiveTab | null | undefined; page: PageContext; onSave: () => void }>) {
  return (
    <Section
      title={page.ok ? t('forHost', page.host) : t('tabLogins')}
      count={page.ok && logins.data ? shown.length : undefined}
      action={
        <Button variant="ghost" size="xs" onClick={onSave} className="-mr-1.5">
          <Plus className="size-3.5" aria-hidden />
          {t('saveForSite')}
        </Button>
      }
    >
      <SiteLoginsBody tab={tab} page={page} logins={logins} shown={shown} filtering={filtering} row={row} />
    </Section>
  );
}

function SiteLoginsBody({
  tab,
  page,
  logins,
  shown,
  filtering,
  row,
}: Readonly<ListProps & { tab: ActiveTab | null | undefined; page: PageContext }>) {
  if (tab === undefined || logins.loading) return <Loading />;
  if (!page.ok) {
    return (
      <Padded>
        <PopupAlert tone={page.reason === 'insecure-page' ? 'warning' : 'info'}>
          {t(blockedMessageKey(page.reason))}
        </PopupAlert>
      </Padded>
    );
  }
  const filteredOut = filtering && (logins.data ?? []).length > 0;
  return (
    <ListBody logins={logins} empty={emptyNote(shown, filteredOut, 'noMatches')}>
      {shown.map(row)}
    </ListBody>
  );
}

function OtherLogins({ logins, shown, filtering, row }: Readonly<ListProps>) {
  return (
    <Section title={t('allLogins')} count={logins.data ? shown.length : undefined}>
      <ListBody logins={logins} empty={otherLoginsNote(logins.data ?? [], shown, filtering)}>
        {shown.map(row)}
      </ListBody>
    </Section>
  );
}

/**
 * No logins at all says so. With the filters on, an empty list says why;
 * without them, every login is already listed for the page, and it says nothing.
 */
function otherLoginsNote(all: WeldPassItem[], shown: WeldPassItem[], filtering: boolean): MessageKey | null {
  if (all.length === 0) return 'noItems';
  return filtering ? emptyNote(shown, true, 'noItems') : null;
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
}: Readonly<{
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
}>) {
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
