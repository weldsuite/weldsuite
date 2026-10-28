/**
 * `mailboxKeyFor`/`mailboxStubFor` (the EU lookup), the transient-error
 * classifier, the retry wrapper, and the op retry-safety classification.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  callStubRead,
  callStubWrite,
  isBatchRetryable,
  isRetryableOp,
  isTransientStubError,
  mailboxKeyFor,
  mailboxStubFor,
} from './stub';
import type { MailboxStoreObject } from '../../mailbox-object/mailbox-object';
import type { MailboxOp } from '../types';

describe('mailboxKeyFor', () => {
  it('is `mbx:<workspaceId>:<accountId>`', () => {
    expect(mailboxKeyFor({ workspaceId: 'ws_1', accountId: 'mail_1' })).toBe('mbx:ws_1:mail_1');
  });
});

describe('mailboxStubFor', () => {
  it('throws when MAILBOX_STORE is not bound', () => {
    expect(() => mailboxStubFor({}, { workspaceId: 'ws_1', accountId: 'mail_1' })).toThrow(/MAILBOX_STORE/);
  });

  it('resolves the stub through the EU jurisdiction, named by workspace + account', () => {
    const stub = { listThreads: vi.fn() };
    const euNamespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => stub),
    };
    const namespace = { jurisdiction: vi.fn(() => euNamespace) };

    const result = mailboxStubFor(
      { MAILBOX_STORE: namespace as unknown as DurableObjectNamespace<MailboxStoreObject> },
      { workspaceId: 'ws_1', accountId: 'mail_1' },
    );

    expect(namespace.jurisdiction).toHaveBeenCalledWith('eu');
    expect(euNamespace.idFromName).toHaveBeenCalledWith('mbx:ws_1:mail_1');
    expect(result).toBe(stub);
  });
});

describe('isTransientStubError', () => {
  it.each(['Durable Object overloaded', 'network connection lost', 'Request timed out', 'fetch failed', 'ECONNRESET'])(
    'treats "%s" as transient',
    (message) => {
      expect(isTransientStubError(new Error(message))).toBe(true);
    },
  );

  it.each(['message not found', 'MAILBOX_DESTROYED', 'validation failed: bad cursor'])(
    'treats "%s" as not transient',
    (message) => {
      expect(isTransientStubError(new Error(message))).toBe(false);
    },
  );

  it('is false for a non-Error throw', () => {
    expect(isTransientStubError('overloaded')).toBe(false);
    expect(isTransientStubError(undefined)).toBe(false);
  });
});

describe('callStubRead', () => {
  it('returns the value on success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(callStubRead(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient error and succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('overloaded')).mockResolvedValueOnce('ok');
    await expect(callStubRead(fn, { baseDelayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured attempt count', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('overloaded'));
    await expect(callStubRead(fn, { attempts: 2, baseDelayMs: 0 })).rejects.toThrow('overloaded');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('message not found'));
    await expect(callStubRead(fn, { baseDelayMs: 0 })).rejects.toThrow('message not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('callStubWrite', () => {
  it('retries when retryable=true', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('network error')).mockResolvedValueOnce('ok');
    await expect(callStubWrite(fn, true, { baseDelayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('never retries when retryable=false, even for a transient error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('overloaded'));
    await expect(callStubWrite(fn, false, { baseDelayMs: 0 })).rejects.toThrow('overloaded');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableOp / isBatchRetryable', () => {
  it('marks ingest as retryable (insert-if-absent by id)', () => {
    const op = { kind: 'ingest', message: {} } as unknown as MailboxOp;
    expect(isRetryableOp(op)).toBe(true);
  });

  it.each<MailboxOp['kind']>([
    'ingest',
    'attachment.create',
    'draft.create',
    'flags',
    'labels.set',
    'labels.add',
    'labels.remove',
    'move',
    'thread.label',
    'thread.read',
    'thread.set',
    'label.rename',
    'label.delete',
    'delete',
    'snooze',
    'resnooze',
    'unsnooze',
    'snooze.wake',
    'scheduled',
    'delivery.match',
    'inbound.finalize',
    'categories',
    'attachment.update',
    'attachment.delete',
    'attachment.associate',
    'subscription.upsert',
    'subscription.status',
    'draft.update',
    'draft.delete',
    'folder.read',
  ])('marks every known op kind (%s) as retryable', (kind) => {
    const op = { kind } as unknown as MailboxOp;
    expect(isRetryableOp(op)).toBe(true);
  });

  it('isBatchRetryable is true for an all-retryable batch', () => {
    const ops = [{ kind: 'ingest' }, { kind: 'flags' }] as unknown as MailboxOp[];
    expect(isBatchRetryable(ops)).toBe(true);
  });

  it('isBatchRetryable is true for a single-op batch (every known kind is retryable today)', () => {
    const ops = [{ kind: 'draft.delete' }] as unknown as MailboxOp[];
    expect(isBatchRetryable(ops)).toBe(true);
  });
});
