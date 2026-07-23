/**
 * Stub IEmailSendProvider. Replace the body with your provider's API call.
 */

import { ProviderConfigError } from '../../core/errors';
import type { IEmailSendProvider, SendCapabilities, SendOptions, SendResult } from '../../core/types';
import type { TemplateProviderConfig } from './types';

const PROVIDER = 'template';

export class TemplateSendProvider implements IEmailSendProvider {
  readonly name = PROVIDER;
  readonly capabilities: SendCapabilities = {
    firstTouchToUnverified: true,
    bulk: false,
    tracking: false,
    attachments: true,
  };

  constructor(private readonly config: TemplateProviderConfig) {
    if (!config.apiKey) throw new ProviderConfigError(PROVIDER, 'apiKey');
  }

  async send(_options: SendOptions): Promise<SendResult> {
    throw new Error('TemplateSendProvider.send() not implemented');
  }
}
