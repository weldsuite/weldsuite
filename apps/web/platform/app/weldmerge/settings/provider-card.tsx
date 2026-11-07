import { Loader2, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { MergeConnectionDto, MergeConnectionStatus, MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useI18n } from '@/lib/i18n/provider';
import { ProviderLogo } from '../components/provider-logo';
import { fill } from '../lib/format';

function statusTone(status: MergeConnectionStatus): 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success';
  if (status === 'revoked') return 'danger';
  return 'warning';
}

function ConnectionRow({
  connection,
  canManage,
  onReconnect,
  onDisconnect,
  onAddRepositories,
}: Readonly<{
  connection: MergeConnectionDto;
  canManage: boolean;
  onReconnect: (connection: MergeConnectionDto) => void;
  onDisconnect: (connection: MergeConnectionDto) => void;
  onAddRepositories: (connection: MergeConnectionDto) => void;
}>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const ts = tm.sync.providers;
  const providerName = tm.provider[connection.provider];
  const needsOrganization = connection.provider === 'azure_devops' && connection.host === null;
  const attention = connection.status === 'needs_attention' || connection.status === 'revoked' || needsOrganization;

  let detail = connection.accountLogin ?? connection.host ?? providerName;
  if (needsOrganization) detail = ts.noOrganization;

  return (
    <li className="space-y-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {fill(ts.accountLine, { account: detail, count: connection.repositoryCount })}
          </p>
          {connection.host && connection.provider === 'gitlab' && (
            <p className="truncate text-xs text-muted-foreground">{fill(ts.selfManagedHost, { host: connection.host })}</p>
          )}
        </div>
        <SoftBadge tone={statusTone(connection.status)}>{tm.settings.providers.status[connection.status]}</SoftBadge>
      </div>
      {attention && <p className="text-xs text-muted-foreground">{fill(ts.reconnectHint, { provider: providerName })}</p>}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          {connection.status === 'active' && !needsOrganization && (
            <Button size="sm" onClick={() => onAddRepositories(connection)}>
              <Plus />
              {ts.addRepositories}
            </Button>
          )}
          {attention && (
            <Button size="sm" onClick={() => onReconnect(connection)}>
              {ts.reconnect}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => onDisconnect(connection)}>
            {ts.disconnect}
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * One provider: its connections with their status (and a reconnect action when
 * one needs attention), and the way to connect another. GitHub has one
 * connection per workspace; the others can have several (GitLab.com and a
 * self-managed GitLab, for instance).
 */
export function ProviderCard({
  provider,
  connections,
  canManage,
  busy,
  onConnect,
  onConnectSelfManaged,
  onReconnect,
  onDisconnect,
  onAddRepositories,
}: Readonly<{
  provider: MergeProvider;
  connections: readonly MergeConnectionDto[];
  canManage: boolean;
  busy: boolean;
  onConnect: (provider: MergeProvider) => void;
  onConnectSelfManaged: () => void;
  onReconnect: (connection: MergeConnectionDto) => void;
  onDisconnect: (connection: MergeConnectionDto) => void;
  onAddRepositories: (connection: MergeConnectionDto) => void;
}>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const ts = tm.sync.providers;
  const providerName = tm.provider[provider];
  const showConnect = canManage && (provider !== 'github' || connections.length === 0);

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <ProviderLogo provider={provider} />
          {providerName}
        </span>
      }
      action={connections.length === 0 ? <SoftBadge tone="neutral">{ts.noConnection}</SoftBadge> : undefined}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{ts.descriptions[provider]}</p>
        {connections.length > 0 && (
          <ul className="divide-y">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                canManage={canManage}
                onReconnect={onReconnect}
                onDisconnect={onDisconnect}
                onAddRepositories={onAddRepositories}
              />
            ))}
          </ul>
        )}
        {showConnect && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={connections.length > 0 ? 'outline' : 'default'}
              onClick={() => onConnect(provider)}
              disabled={busy}
            >
              {busy && <Loader2 className="animate-spin" />}
              {busy ? ts.connecting : fill(ts.connect, { provider: providerName })}
            </Button>
            {provider === 'gitlab' && (
              <Button size="sm" variant="outline" onClick={onConnectSelfManaged} disabled={busy}>
                {ts.connectSelfManaged}
              </Button>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
