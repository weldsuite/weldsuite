/**
 * A login's details page, opened by clicking its row. It is the platform's
 * object panel, as WeldCRM's company and person profiles use it:
 * `EntityDetailView` (in panel mode, which takes the whole popup at its
 * width, as on a phone), `PageTabs` as `ObjectPanelTabs` sets them up, and
 * `PropertyRowLayout` rows on the details tab.
 *
 * - Details: username, password (revealed only when asked, as with Copy),
 *   2FA code, website, vault, when it changed.
 * - History: the login's versions: who changed it when, never a password.
 */

import { useEffect, useState } from 'react';
import {
  Clock,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Globe,
  History,
  KeyRound,
  ShieldCheck,
  User,
  Vault as VaultIcon,
} from 'lucide-react';
import type { WeldPassItem, WeldPassItemVersion } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
import { PropertyRowLayout, PropertyValue } from '@weldsuite/ui/components/property-row';
import { revealPassword } from '../lib/actions';
import { SquareArrowUpRightExit } from '../lib/icons';
import { openTab } from '../lib/chrome-page';
import { errorMessageKey } from '../lib/errors';
import { t, textLanguage, type MessageKey } from '../lib/i18n';
import { safeExternalUrl } from '../lib/urls';
import type { PopupApi } from './api';
import { useAsync, type Notify } from './hooks';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Empty, IconAction, LoadError, Padded, SiteIcon } from './list';

type Tab = 'details' | 'history';

const HISTORY_ACTION: Record<string, MessageKey> = {
  created: 'historyCreated',
  updated: 'historyUpdated',
  restored: 'historyRestored',
  deleted: 'historyDeleted',
};

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(textLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** "123 456": easier to read and type. */
function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export function LoginDetails({
  item,
  api,
  vaultName,
  canFill,
  onFill,
  onClose,
  notify,
}: Readonly<{
  item: WeldPassItem;
  api: PopupApi;
  vaultName: string | null;
  canFill: boolean;
  onFill: () => void;
  onClose: () => void;
  notify: Notify;
}>) {
  const [tab, setTab] = useState<Tab>('details');
  const [password, setPassword] = useState<string | null>(null);
  const [totp, setTotp] = useState<{ code: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const siteUrl = safeExternalUrl(item.url);

  // The 2FA code's countdown; it goes away when the code runs out.
  useEffect(() => {
    if (!totp) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [totp]);
  const totpSeconds = totp ? Math.max(0, Math.round((Date.parse(totp.expiresAt) - now) / 1000)) : 0;
  useEffect(() => {
    if (totp && totpSeconds === 0) setTotp(null);
  }, [totp, totpSeconds]);

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('ok', done);
    } catch {
      notify('error', t('copyFailed'));
    }
  }

  async function attempt(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      notify('error', t(errorMessageKey(error)));
    }
  }

  const togglePassword = () =>
    attempt(async () => {
      if (password !== null) {
        setPassword(null);
        return;
      }
      const revealed = await revealPassword(api, item);
      if (revealed === null) notify('error', t('noPassword'));
      else setPassword(revealed);
    });

  const copyPassword = () =>
    attempt(async () => {
      const value = password ?? (await revealPassword(api, item));
      if (value === null) notify('error', t('noPassword'));
      else await copy(value, t('passwordCopied'));
    });

  const showCode = () =>
    attempt(async () => {
      const { code, expiresAt } = (await api.generateTotp(item.vaultId, item.id)).data;
      setTotp({ code, expiresAt });
    });

  return (
    <EntityDetailView
      defaultMode="panel"
      onBack={onClose}
      backPlacement="above"
      onClose={onClose}
      showCloseButton={false}
      showExpandButton={false}
      avatar={<SiteIcon url={item.url} />}
      title={<span className="truncate">{item.title}</span>}
      // Open site on the back row, above Fill.
      backRowActions={
        siteUrl ? (
          <IconAction label={t('openSite')} onClick={() => openTab(siteUrl)}>
            <SquareArrowUpRightExit className="size-4" />
          </IconAction>
        ) : undefined
      }
      actions={
        canFill ? (
          <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={onFill}>
            <KeyRound className="size-3.5" />
            {t('fill')}
          </Button>
        ) : undefined
      }
      tabs={
        <PageTabs
          tabs={[
            { id: 'details', label: t('detailsTab'), icon: FileText },
            { id: 'history', label: t('historyTab'), icon: History },
          ]}
          activeTab={tab}
          onTabChange={(id) => setTab(id as Tab)}
          overflow="dropdown"
          innerClassName="pl-3 pr-3 pt-2"
        />
      }
    >
      {tab === 'details' ? (
        <div className="space-y-1 p-4">
          <PropertyRowLayout
            icon={User}
            label={t('fieldUsername')}
            accessory={
              item.subtitle ? (
                <IconAction label={t('copyUsername')} onClick={() => void copy(item.subtitle ?? '', t('usernameCopied'))}>
                  <Copy className="size-3.5" />
                </IconAction>
              ) : null
            }
          >
            <PropertyValue>{item.subtitle || '—'}</PropertyValue>
          </PropertyRowLayout>

          <PropertyRowLayout
            icon={KeyRound}
            label={t('fieldPassword')}
            accessory={
              <div className="flex items-center">
                <IconAction label={t(password === null ? 'showPassword' : 'hidePassword')} onClick={() => void togglePassword()}>
                  {password === null ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                </IconAction>
                <IconAction label={t('copyPassword')} onClick={() => void copyPassword()}>
                  <Copy className="size-3.5" />
                </IconAction>
              </div>
            }
          >
            <PropertyValue className="font-mono">{password ?? '••••••••••••'}</PropertyValue>
          </PropertyRowLayout>

          {item.hasTotp && (
            <PropertyRowLayout
              icon={ShieldCheck}
              label={t('filterTotp')}
              accessory={
                totp ? (
                  <IconAction label={t('copyTotp')} onClick={() => void copy(totp.code, t('totpCopied', totpSeconds))}>
                    <Copy className="size-3.5" />
                  </IconAction>
                ) : null
              }
            >
              {totp ? (
                <PropertyValue tabular className="gap-2 font-mono">
                  {formatCode(totp.code)}
                  <span className="ml-2 font-sans text-xs text-muted-foreground">{totpSeconds}s</span>
                </PropertyValue>
              ) : (
                <PropertyValue>
                  <Button variant="link" size="sm" className="h-auto p-0 text-[13px]" onClick={() => void showCode()}>
                    {t('showCode')}
                  </Button>
                </PropertyValue>
              )}
            </PropertyRowLayout>
          )}

          <PropertyRowLayout icon={Globe} label={t('fieldUrl')}>
            <PropertyValue>
              {siteUrl ? (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto min-w-0 max-w-full whitespace-normal break-all p-0 text-left text-[13px] font-normal"
                  onClick={() => openTab(siteUrl)}
                >
                  {item.url}
                </Button>
              ) : (
                '—'
              )}
            </PropertyValue>
          </PropertyRowLayout>

          <PropertyRowLayout icon={VaultIcon} label={t('fieldVault')}>
            <PropertyValue>{vaultName ?? '—'}</PropertyValue>
          </PropertyRowLayout>

          <PropertyRowLayout icon={Clock} label={t('detailsUpdated')}>
            <PropertyValue tabular>{formatDate(item.updatedAt) ?? '—'}</PropertyValue>
          </PropertyRowLayout>

          <PropertyRowLayout icon={History} label={t('detailsPasswordChanged')}>
            <PropertyValue tabular>{formatDate(item.passwordChangedAt) ?? '—'}</PropertyValue>
          </PropertyRowLayout>
        </div>
      ) : (
        <ItemHistory api={api} item={item} />
      )}
    </EntityDetailView>
  );
}

function ItemHistory({ api, item }: Readonly<{ api: PopupApi; item: WeldPassItem }>) {
  const versions = useAsync(
    async () => (await api.itemVersions(item.vaultId, item.id)).data,
    `${item.vaultId}|${item.id}`,
  );

  if (versions.loading) {
    return (
      <Padded>
        <InlineSpinner label={t('loading')} className="py-0" />
      </Padded>
    );
  }
  if (versions.error || !versions.data) return <LoadError error={versions.error} onRetry={versions.reload} />;
  if (versions.data.length === 0) return <Empty>{t('historyEmpty')}</Empty>;

  const newest = Math.max(...versions.data.map((version) => version.version));
  const sorted = [...versions.data].sort((a, b) => b.version - a.version);
  return (
    <ul>
      {sorted.map((version: WeldPassItemVersion) => (
        <li key={version.id} className="flex items-center gap-2.5 border-b border-border/70 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 font-medium">
              {HISTORY_ACTION[version.action] ? t(HISTORY_ACTION[version.action]!) : version.action}
              {version.version === newest && <Badge variant="secondary">{t('historyCurrent')}</Badge>}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">{formatDate(version.createdAt)}</div>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {t('historyVersion', version.version)}
          </span>
        </li>
      ))}
    </ul>
  );
}
