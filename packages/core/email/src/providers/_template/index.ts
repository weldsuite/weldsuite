/**
 * Template provider registration. Copy this folder, rename the prefix, and
 * wire up `register<Name>*` to whatever your provider supports.
 *
 * See ./README.md for the full checklist.
 */

import {
  registerSendProvider,
  registerReceiveProvider,
  registerDomainProvider,
} from '../../core/registry';
import { TemplateDomainProvider } from './domain';
import { TemplateReceiveProvider } from './receive';
import { TemplateSendProvider } from './send';
import type { TemplateProviderConfig } from './types';

const PROVIDER = 'template';

export function registerTemplateSend(config: TemplateProviderConfig): void {
  registerSendProvider(PROVIDER, () => new TemplateSendProvider(config));
}

export function registerTemplateReceive(): void {
  registerReceiveProvider(PROVIDER, () => new TemplateReceiveProvider());
}

export function registerTemplateDomain(config: TemplateProviderConfig): void {
  registerDomainProvider(PROVIDER, () => new TemplateDomainProvider(config));
}

export { TemplateSendProvider, TemplateReceiveProvider, TemplateDomainProvider };
export type { TemplateProviderConfig } from './types';
