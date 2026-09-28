import { describe, it, expect } from 'vitest';
import {
  signDeskPhoneToolToken,
  verifyDeskPhoneToolToken,
  bearerTokenFromHeader,
} from './desk-phone-tool-auth';
import { phonesMatch, phoneLookupSuffix, digitsOnly, formatCrmLookupForAssistant } from '../services/desk-phone-crm';
import { parseMessageHistory, extractTranscriptTurns } from '../services/desk-phone-transcript';
import { callerContextInstructions } from './desk-phone-tools';
import type { DeskMessage } from '@weldsuite/db/lib/desk';

const SECRET = 'test-telnyx-secret';

describe('desk-phone-tool-auth', () => {
  it('round-trips a signed token', async () => {
    const token = await signDeskPhoneToolToken(SECRET, {
      org: 'org_abc',
      aid: 'dva_1',
      call: 'vcall_1',
      conv: 'dconv_1',
    }, 1_000_000);
    const claims = await verifyDeskPhoneToolToken(SECRET, token, 1_000_001);
    expect(claims).toMatchObject({
      v: 1,
      org: 'org_abc',
      aid: 'dva_1',
      call: 'vcall_1',
      conv: 'dconv_1',
    });
  });

  it('rejects a tampered token', async () => {
    const token = await signDeskPhoneToolToken(SECRET, { org: 'org_abc', aid: 'dva_1' }, 1_000_000);
    const [body] = token.split('.');
    expect(await verifyDeskPhoneToolToken(SECRET, `${body}.aaaa`, 1_000_001)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signDeskPhoneToolToken(
      SECRET,
      { org: 'org_abc', aid: 'dva_1', exp: 50 },
      40,
    );
    expect(await verifyDeskPhoneToolToken(SECRET, token, 51)).toBeNull();
  });

  it('parses a Bearer header', () => {
    expect(bearerTokenFromHeader('Bearer abc.def')).toBe('abc.def');
    expect(bearerTokenFromHeader('abc.def')).toBeNull();
  });
});

describe('phone matching', () => {
  it('matches E.164 against national formats', () => {
    expect(phonesMatch('+32475123456', '0475123456')).toBe(true);
    expect(phonesMatch('+32475123456', '0032475123456')).toBe(true);
    expect(phonesMatch('+15551230000', '+15559990000')).toBe(false);
  });

  it('extracts a stable suffix', () => {
    expect(phoneLookupSuffix('+32475123456')).toBe('75123456');
    expect(digitsOnly('+32 475 12 34 56')).toBe('32475123456');
  });
});

describe('transcript history', () => {
  it('reads message_history from a Telnyx payload', () => {
    const turns = parseMessageHistory({
      message_history: [
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(turns).toHaveLength(2);
    expect(turns[1]?.role).toBe('user');
  });

  it('indexes existing transcript turns by call', () => {
    const messages = [
      {
        id: 'dmsg_1',
        createdAt: new Date(),
        conversationId: 'dconv_1',
        kind: 'message',
        body: 'Hi',
        authorType: 'bot',
        authorId: 'dva_1',
        attachments: null,
        metadata: { event: 'ai_transcript', callId: 'vcall_1', turnIndex: 0, role: 'assistant' },
      },
    ] as unknown as DeskMessage[];
    const map = extractTranscriptTurns(messages, 'vcall_1');
    expect(map.get(0)?.body).toBe('Hi');
    expect(extractTranscriptTurns(messages, 'vcall_other').size).toBe(0);
  });
});

describe('caller context + CRM format', () => {
  it('injects the matched caller into instructions', () => {
    const text = callerContextInstructions({
      systemPrompt: 'Be helpful.',
      callerPhone: '+15551230000',
      callerName: 'Jane Doe',
      customerName: 'Acme',
    });
    expect(text).toContain('Jane Doe');
    expect(text).toContain('lookup_crm');
  });

  it('formats empty CRM results for the assistant', () => {
    expect(formatCrmLookupForAssistant([])).toMatchObject({ matched: 0 });
  });
});
