/**
 * Stub IMailDomainProvider. Replace with your provider's domain-management
 * API calls.
 */

import { ProviderConfigError } from '../../core/errors';
import type {
  IMailDomainProvider,
  MailDnsRecord,
  ProvisionDomainOptions,
  ProvisionDomainResult,
} from '../../core/types';
import type { TemplateProviderConfig } from './types';

const PROVIDER = 'template';

export class TemplateDomainProvider implements IMailDomainProvider {
  readonly name = PROVIDER;

  constructor(private readonly config: TemplateProviderConfig) {
    if (!config.apiKey) throw new ProviderConfigError(PROVIDER, 'apiKey');
  }

  provisionDomain(_domain: string, _options?: ProvisionDomainOptions): Promise<ProvisionDomainResult> {
    return Promise.reject(new Error('TemplateDomainProvider.provisionDomain() not implemented'));
  }

  deprovisionDomain(_domain: string): Promise<void> {
    return Promise.reject(new Error('TemplateDomainProvider.deprovisionDomain() not implemented'));
  }

  getDnsRecords(_domain: string): Promise<MailDnsRecord[]> {
    return Promise.reject(new Error('TemplateDomainProvider.getDnsRecords() not implemented'));
  }
}
