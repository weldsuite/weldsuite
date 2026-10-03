import { describe, it, expect } from 'vitest';
import { isInsideQuickCreate } from './quick-create-dismiss';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function pathOf(node: Node): EventTarget[] {
  const path: EventTarget[] = [];
  for (let n: Node | null = node; n; n = n.parentNode) path.push(n);
  return path;
}

describe('isInsideQuickCreate', () => {
  it('counts the card and its descendants as inside', () => {
    const card = el('<div id="card"><button id="b">x</button></div>').querySelector<HTMLElement>('#card')!;
    const button = card.querySelector('#b')!;
    expect(isInsideQuickCreate(pathOf(button), card)).toBe(true);
  });

  it('counts a portaled radix popover (date picker) as inside', () => {
    const card = el('<div id="card"></div>').querySelector<HTMLElement>('#card')!;
    const day = el(
      '<div data-radix-popper-content-wrapper><div data-slot="popover-content"><button id="day">14</button></div></div>',
    ).querySelector('#day')!;
    expect(isInsideQuickCreate(pathOf(day), card)).toBe(true);
  });

  it('counts a dialog or listbox opened from the card as inside', () => {
    const card = el('<div id="card"></div>').querySelector<HTMLElement>('#card')!;
    const ok = el('<div role="dialog"><button id="ok">ok</button></div>').querySelector('#ok')!;
    expect(isInsideQuickCreate(pathOf(ok), card)).toBe(true);
    const option = el('<div role="listbox"><div id="o">o</div></div>').querySelector('#o')!;
    expect(isInsideQuickCreate(pathOf(option), card)).toBe(true);
  });

  it('treats anything else as outside', () => {
    const card = el('<div id="card"></div>').querySelector<HTMLElement>('#card')!;
    const other = el('<div id="other"><span id="s">hi</span></div>').querySelector('#s')!;
    expect(isInsideQuickCreate(pathOf(other), card)).toBe(false);
  });

  it('is outside without a card and without overlay markers', () => {
    expect(isInsideQuickCreate([document.body], null)).toBe(false);
  });
});
