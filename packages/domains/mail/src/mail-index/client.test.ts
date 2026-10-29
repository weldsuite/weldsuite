/**
 * `mailIndexFor`: the EU-jurisdiction lookup and the "binding not wired yet"
 * tolerance workers need while `MAIL_INDEX` isn't bound everywhere.
 */

import { describe, expect, it, vi } from 'vitest';
import { mailIndexFor, mailIndexKeyFor } from './client';
import type { MailIndex } from './mail-index';

describe('mailIndexKeyFor', () => {
  it('is `mbxidx:<workspaceId>`', () => {
    expect(mailIndexKeyFor('ws_abc123')).toBe('mbxidx:ws_abc123');
  });
});

describe('mailIndexFor', () => {
  it('returns null when MAIL_INDEX is not bound', () => {
    expect(mailIndexFor({}, 'ws_1')).toBeNull();
  });

  it('resolves the stub through the EU jurisdiction, named by workspace id', () => {
    const stub = { status: vi.fn() };
    const euNamespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => stub),
    };
    const namespace = { jurisdiction: vi.fn(() => euNamespace) };

    const result = mailIndexFor({ MAIL_INDEX: namespace as unknown as DurableObjectNamespace<MailIndex> }, 'ws_1');

    expect(namespace.jurisdiction).toHaveBeenCalledWith('eu');
    expect(euNamespace.idFromName).toHaveBeenCalledWith('mbxidx:ws_1');
    expect(result).toBe(stub);
  });
});
