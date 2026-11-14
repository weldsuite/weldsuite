import { describe, expect, it, vi } from 'vitest';
import { memoryTransport } from '@weldsuite/emails/transports/memory';
import type { Env } from '../types';
import { noticeRecipients, sendUsageNotice, usageUrl } from './usage-mail';
import type { UsageNotice } from './usage-notices';

const env = { PLATFORM_URL: 'https://app-test.weldsuite.org' } as Env;

const notice: UsageNotice = {
  workspaceId: 'ws_alpha',
  workspaceName: 'Acme Staffing',
  clerkOrgId: 'org_alpha',
  kind: 'near',
  month: '2026-11',
  events: { used: 41_000, allowance: 50_000 },
  recordings: { used: 12, allowance: 500 },
};

describe('sendUsageNotice', () => {
  it('mails every owner from WeldPanel with the usage and a link into the workspace', async () => {
    const transport = memoryTransport();
    const sent = await sendUsageNotice(
      { env, transport, recipients: async () => [{ email: 'owner@acme.test', name: 'Olga' }, { email: 'cofounder@acme.test', name: null }] },
      notice,
    );

    expect(sent).toBe(2);
    expect(transport.sent.map((m) => m.to.map((to) => to.email))).toEqual([['owner@acme.test'], ['cofounder@acme.test']]);
    const mail = transport.sent[0]!;
    expect(mail.subject).toBe('Acme Staffing has used 80% of its WeldPanel allowance');
    expect(mail.html).toContain('41,000 of 50,000');
    expect(mail.html).toContain('https://app-test.weldsuite.org/w/org_alpha/weldpanel/settings?tab=usage');
    expect(mail.text).toContain('Events: 41,000 of 50,000');
  });

  it('writes the blocked kinds to the point: what stopped', async () => {
    const transport = memoryTransport();
    await sendUsageNotice({ env, transport, recipients: async () => [{ email: 'o@acme.test', name: null }] }, { ...notice, kind: 'replay_blocked' });
    await sendUsageNotice({ env, transport, recipients: async () => [{ email: 'o@acme.test', name: null }] }, { ...notice, kind: 'events_blocked' });

    expect(transport.sent[0]!.subject).toBe('WeldPanel stopped recording sessions for Acme Staffing');
    expect(transport.sent[1]!.subject).toBe('WeldPanel is dropping events for Acme Staffing');
    expect(transport.sent[1]!.text).toContain('cannot be recovered');
  });

  it('keeps going when one address fails, and counts only what was sent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const transport = memoryTransport();
    const original = transport.send.bind(transport);
    let calls = 0;
    transport.send = async (email) => {
      calls += 1;
      if (calls === 1) throw new Error('rejected');
      return original(email);
    };

    const sent = await sendUsageNotice({ env, transport, recipients: async () => [{ email: 'a@acme.test', name: null }, { email: 'b@acme.test', name: null }] }, notice);

    expect(sent).toBe(1);
    expect(transport.sent).toHaveLength(1);
    error.mockRestore();
  });

  it('sends nothing without a mail binding', async () => {
    expect(await sendUsageNotice({ env, recipients: async () => [{ email: 'a@acme.test', name: null }] }, notice)).toBe(0);
  });
});

describe('recipients and links', () => {
  it('uses the owners when there are any', async () => {
    expect(await noticeRecipients(env, 'ws_alpha', async () => [{ email: 'owner@acme.test', name: null }])).toEqual([{ email: 'owner@acme.test', name: null }]);
  });

  it('links to the workspace by its Clerk org id, and to the platform origin without one', () => {
    expect(usageUrl(env, 'org_alpha')).toBe('https://app-test.weldsuite.org/w/org_alpha/weldpanel/settings?tab=usage');
    expect(usageUrl({} as Env, null)).toBe('https://app.weldsuite.org/weldpanel/settings?tab=usage');
  });
});
