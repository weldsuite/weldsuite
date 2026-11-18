/** The masking levels against the real rrweb: what a full snapshot of a page keeps and what it hides. */

import { record } from '@rrweb/record';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingOptions } from './recorder';
import { resetPage } from './test/harness';

afterEach(resetPage);

const PAGE = `
  <p>Visible text</p>
  <p data-panel-mask>Secret text</p>
  <div data-panel-unmask><p>Unmasked text</p><span data-panel-mask>Masked inside unmasked</span></div>
  <input id="pw" type="password" value="hunter2">
  <input data-panel-unmask type="password" value="unmasked-password">
  <input type="email" value="jane@example.com">
  <input data-panel-unmask value="red shoes">
  <input data-panel-mask value="marked sensitive">
  <input autocomplete="cc-number" value="4242424242424242">
  <textarea>draft message</textarea>
  <img src="https://cdn.example.com/photo.png" alt="">
  <div data-panel-block>Blocked content</div>
  <canvas id="c"></canvas>
`;

function fullSnapshot(level: 'strict' | 'balanced' | 'relaxed'): string {
  document.body.innerHTML = PAGE;
  let full = '';
  const stop = record({
    ...recordingOptions(level),
    emit: (e) => {
      if (e.type === 2) full = JSON.stringify(e);
    },
  });
  if (stop) stop();
  expect(full).not.toBe('');
  return full;
}

const NEVER = ['hunter2', 'unmasked-password', 'Secret text', 'Masked inside unmasked', 'marked sensitive', 'Blocked content'];

describe('masking levels', () => {
  it('strict: all text and every input masked, images blocked; data-panel-unmask shows text and fields', () => {
    const snap = fullSnapshot('strict');
    for (const hidden of [...NEVER, 'Visible text', 'jane@example.com', '4242424242424242', 'draft message', 'photo.png']) {
      expect(snap).not.toContain(hidden);
    }
    expect(snap).toContain('Unmasked text');
    expect(snap).toContain('red shoes');
  });

  it('balanced: page text visible, every input masked', () => {
    const snap = fullSnapshot('balanced');
    for (const hidden of [...NEVER, 'jane@example.com', '4242424242424242', 'draft message']) expect(snap).not.toContain(hidden);
    for (const shown of ['Visible text', 'Unmasked text', 'red shoes', 'photo.png']) expect(snap).toContain(shown);
  });

  it('relaxed: only passwords, card numbers and fields marked sensitive masked', () => {
    const snap = fullSnapshot('relaxed');
    for (const hidden of [...NEVER, '4242424242424242']) expect(snap).not.toContain(hidden);
    for (const shown of ['Visible text', 'jane@example.com', 'draft message', 'red shoes']) expect(snap).toContain(shown);
  });

  it('a password field stays masked after a show-password toggle', async () => {
    document.body.innerHTML = '<input id="pw" type="password" value="hunter2">';
    const events: string[] = [];
    const stop = record({ ...recordingOptions('relaxed'), emit: (e) => void events.push(JSON.stringify(e)) });
    const input = document.getElementById('pw') as HTMLInputElement;
    input.type = 'text';
    // rrweb sees the type change (and marks the field) through its MutationObserver.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.hasAttribute('data-rr-is-password')).toBe(true);
    input.value = 'hunter3';
    record.takeFullSnapshot();
    if (stop) stop();
    expect(events.filter((e) => e.startsWith('{"type":2'))).toHaveLength(2);
    expect(events.join()).not.toMatch(/hunter[23]/);
  });
});
