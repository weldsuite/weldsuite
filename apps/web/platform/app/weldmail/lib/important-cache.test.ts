import { describe, expect, it } from 'vitest';
import { patchCachedImportant } from './important-cache';

const message = (id: string, labels: string[], isImportant = false) => ({ id, labels, isImportant });

describe('patchCachedImportant', () => {
  it('marks the message in a message detail', () => {
    const cached = { data: message('m1', ['INBOX']) };
    expect(patchCachedImportant(cached, 'm1', true)).toEqual({
      data: { id: 'm1', labels: ['INBOX', 'IMPORTANT'], isImportant: true },
    });
  });

  it('leaves another message alone', () => {
    const cached = { data: message('m2', ['INBOX']) };
    expect(patchCachedImportant(cached, 'm1', true)).toBe(cached);
  });

  it('updates the thread rows of a folder page, label union included', () => {
    const cached = {
      pages: [
        {
          data: {
            threads: [
              { threadId: 't1', labels: ['INBOX', 'IMPORTANT'], messages: [message('m1', ['INBOX', 'IMPORTANT'], true)] },
              { threadId: 't2', labels: ['INBOX'], messages: [message('m2', ['INBOX'])] },
            ],
          },
        },
      ],
    };
    const next = patchCachedImportant(cached, 'm1', false) as typeof cached;
    expect(next.pages[0].data.threads[0].labels).toEqual(['INBOX']);
    expect(next.pages[0].data.threads[0].messages[0]).toEqual({ id: 'm1', labels: ['INBOX'], isImportant: false });
    expect(next.pages[0].data.threads[1]).toBe(cached.pages[0].data.threads[1]);
  });

  it('keeps the thread important while another of its messages is', () => {
    const cached = {
      data: {
        threads: [
          {
            threadId: 't1',
            labels: ['IMPORTANT'],
            messages: [message('m1', ['IMPORTANT'], true), message('m2', ['IMPORTANT'], true)],
          },
        ],
      },
    };
    const next = patchCachedImportant(cached, 'm1', false) as typeof cached;
    expect(next.data.threads[0].labels).toEqual(['IMPORTANT']);
  });

  it('ignores lists and other shapes', () => {
    const labels = { data: [{ id: 'm1' }] };
    expect(patchCachedImportant(labels, 'm1', true)).toBe(labels);
    expect(patchCachedImportant(undefined, 'm1', true)).toBeUndefined();
  });
});
