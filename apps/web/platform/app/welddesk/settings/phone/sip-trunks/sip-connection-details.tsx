/**
 * What the customer enters in their phone system: our SIP host, port and
 * transport, the username and (once) the password of a login trunk, or the
 * addresses to allow-list for an IP trunk.
 */

import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import type { DeskSipConnectionDetails } from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { getTranslations } from '@/lib/i18n';
import { CopyField } from './copy-field';

export interface SipConnectionDetailsProps {
  connection: DeskSipConnectionDetails;
  authMode: 'ip' | 'credentials';
  ipAddresses: ReadonlyArray<{ ip: string; port?: number }>;
  /** The password, only right after it was made. */
  password?: string | null;
}

export function SipConnectionDetails({ connection, authMode, ipAddresses, password }: Readonly<SipConnectionDetailsProps>) {
  const t = getTranslations('deskSipTrunks');
  const d = t.details;
  const transport = (t.transports as Record<string, string>)[connection.transport] ?? connection.transport;
  const regionName = (region: string) => (d.regions as Record<string, string>)[region] ?? region;

  return (
    <div className="space-y-3" data-testid="sip-connection-details">
      <div className="grid gap-3 sm:grid-cols-2">
        <CopyField label={d.sipHost} value={connection.primaryHost} testId="sip-host" />
        <CopyField label={d.port} value={String(connection.port)} testId="sip-port" />
        <CopyField label={d.transport} value={transport} />
        {connection.username && <CopyField label={d.username} value={connection.username} testId="sip-username" />}
      </div>

      {password && (
        <div className="space-y-2" data-testid="sip-password-panel">
          <CopyField label={d.password} value={password} emphasis testId="sip-password" />
          <InfoBanner variant="warning">{d.passwordWarning}</InfoBanner>
        </div>
      )}

      {authMode === 'ip' && ipAddresses.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{d.yourIps}</p>
          <ul className="font-mono text-sm">
            {ipAddresses.map((a) => (
              <li key={`${a.ip}:${a.port ?? ''}`}>{a.port ? `${a.ip}:${a.port}` : a.ip}</li>
            ))}
          </ul>
        </div>
      )}

      {connection.sipHosts.length > 1 && (
        <p className="text-xs text-muted-foreground">
          {d.otherHosts}: {connection.sipHosts.map((h) => `${h.host} (${regionName(h.region)})`).join(', ')}
        </p>
      )}

      {authMode === 'ip' && connection.signalingIps.length > 0 && (
        <div className="space-y-1" data-testid="sip-signaling-ips">
          <p className="text-sm font-medium">{d.signalingIps}</p>
          <p className="text-xs text-muted-foreground">{d.signalingIpsHelp}</p>
          <ul className="grid gap-x-6 font-mono text-sm sm:grid-cols-2">
            {connection.signalingIps.map((i) => (
              <li key={i.ip}>
                {i.ip} <span className="text-xs text-muted-foreground">{regionName(i.region)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
