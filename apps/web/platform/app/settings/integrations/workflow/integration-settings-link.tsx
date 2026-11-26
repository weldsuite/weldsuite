/**
 * Integrations are connected in Settings → Integrations, not in WeldConnect
 * (ADR INT-014). The workflow editor and its step forms link there with this
 * link, which remembers the page so the Settings back button returns to it.
 */

import type { ReactNode } from 'react';
import { Link } from '@/lib/router';
import { stripWorkspacePrefix } from '@/lib/workspace-url';
import { workflowProviderSettingsPath } from './providers';

function rememberSettingsReturn(): void {
  try {
    sessionStorage.setItem('settings-return-url', stripWorkspacePrefix(globalThis.location.pathname) || '/');
  } catch {
    // Storage blocked: the Settings back button falls back to its default.
  }
}

export function IntegrationSettingsLink({
  provider,
  className,
  children,
}: Readonly<{
  /** The workflow provider's catalog type; leave out for the integrations list. */
  provider?: string;
  className?: string;
  children: ReactNode;
}>) {
  const href = provider ? workflowProviderSettingsPath(provider) : '/settings/integrations';
  return (
    <Link href={href} onClick={rememberSettingsReturn} className={className}>
      {children}
    </Link>
  );
}
