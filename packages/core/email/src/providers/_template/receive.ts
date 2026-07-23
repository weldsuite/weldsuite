/**
 * Stub IEmailReceiveProvider. Use `parseRawEmail` from core to keep the
 * downstream pipeline provider-agnostic.
 */

import type { IEmailReceiveProvider, ParsedInboundEmail } from '../../core/types';
import { parseRawEmail } from '../../core/parse';

const PROVIDER = 'template';

/** Whatever shape your transport delivers (HTTP Request, SDK event, raw bytes...). */
export interface TemplateInboundInput {
  raw: ArrayBuffer | string;
}

export class TemplateReceiveProvider implements IEmailReceiveProvider<TemplateInboundInput> {
  readonly name = PROVIDER;

  async parse(input: TemplateInboundInput): Promise<ParsedInboundEmail> {
    return parseRawEmail(input.raw);
  }
}
