/**
 * Which DNS zones WeldHost manages (records editable, delegation polled).
 * Cloudflare zones on every deployment, as on Global. Hetzner zones on the
 * Kubernetes editions, which keep customer zones in Hetzner's Cloud DNS
 * behind branded nameservers (`WELDHOST_DNS_PROVIDER=hetzner`, ADR HOST-008).
 * On Global a `hetzner` row is a zone record kept by hand (the column's
 * default), and host-api answers it as unmanaged.
 */

import { offeredModules } from '@/lib/edition';

/** Whether WeldHost manages zones of this provider on this deployment. */
export function isManagedDnsProvider(
  provider: string | null | undefined,
  kubernetes: boolean = offeredModules() !== null,
): boolean {
  if (provider === 'cloudflare') return true;
  return provider === 'hetzner' && kubernetes;
}
