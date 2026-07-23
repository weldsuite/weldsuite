/**
 * Cloudflare provider — wires up send / receive / domain into the registry.
 *
 * Each consuming worker calls one of:
 *
 *   import { registerCloudflareSend } from '@weldsuite/email/providers/cloudflare';
 *   import { EmailMessage } from 'cloudflare:email';
 *
 *   registerCloudflareSend({
 *     sendEmail: env.SEND_EMAIL,
 *     EmailMessage,
 *   });
 *
 * Workers that don't have a `[[send_email]]` binding (mail-inbound-worker,
 * workspace-worker) should only call the receive / domain registration
 * helpers — never `registerCloudflareSend` — so the registry doesn't claim
 * we can send from those workers.
 */

export * from './types';
export * from './send-binding';
export { CloudflareApiClient } from './api-client';
export { CloudflareSendProvider, type CloudflareSendProviderOptions } from './send';
export {
  CloudflareReceiveProvider,
  createCloudflareEmailHandler,
  type ForwardableEmailMessage,
} from './receive';
export { CloudflareDomainProvider, type CloudflareDomainProviderOptions } from './domain';

import {
  registerSendProvider,
  registerReceiveProvider,
  registerDomainProvider,
  setDefaultSendProvider,
  setDefaultReceiveProvider,
  setDefaultDomainProvider,
} from '../../core/registry';
import { CloudflareDomainProvider, type CloudflareDomainProviderOptions } from './domain';
import { CloudflareReceiveProvider } from './receive';
import { CloudflareSendProvider, type CloudflareSendProviderOptions } from './send';

const PROVIDER = 'cloudflare';

export function registerCloudflareSend(opts: CloudflareSendProviderOptions, makeDefault = true): void {
  registerSendProvider(PROVIDER, () => new CloudflareSendProvider(opts));
  if (makeDefault) setDefaultSendProvider(PROVIDER);
}

export function registerCloudflareReceive(makeDefault = true): void {
  registerReceiveProvider(PROVIDER, () => new CloudflareReceiveProvider());
  if (makeDefault) setDefaultReceiveProvider(PROVIDER);
}

export function registerCloudflareDomain(opts: CloudflareDomainProviderOptions, makeDefault = true): void {
  registerDomainProvider(PROVIDER, () => new CloudflareDomainProvider(opts));
  if (makeDefault) setDefaultDomainProvider(PROVIDER);
}

/** Convenience: register all three at once if the worker has every dep. */
export function registerCloudflareAll(args: {
  send?: CloudflareSendProviderOptions;
  domain?: CloudflareDomainProviderOptions;
  receive?: boolean;
}): void {
  if (args.receive ?? true) registerCloudflareReceive();
  if (args.send) registerCloudflareSend(args.send);
  if (args.domain) registerCloudflareDomain(args.domain);
}
