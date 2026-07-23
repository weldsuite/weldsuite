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

  async provisionDomain(_domain: string, _options?: ProvisionDomainOptions): Promise<ProvisionDomainResult> {
    throw new Error('TemplateDomainProvider.provisionDomain() not implemented');
  }

  async deprovisionDomain(_domain: string): Promise<void> {
    throw new Error('TemplateDomainProvider.deprovisionDomain() not implemented');
  }

  async getDnsRecords(_domain: string): Promise<MailDnsRecord[]> {
    throw new Error('TemplateDomainProvider.getDnsRecords() not implemented');
  }
}
