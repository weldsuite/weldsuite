import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { tableResizeHeadroom, useTableResizeClamp } from './use-table-resize-clamp';

/** jsdom has no layout, so the measured widths are stubbed per element. */
function setWidth(el: HTMLElement, prop: 'clientWidth' | 'offsetWidth', value: number) {
  Object.defineProperty(el, prop, { configurable: true, value });
}

function buildEditor({ tableWidth, resizing }: { tableWidth: number; resizing: boolean }) {
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="bn-editor${resizing ? ' resize-cursor' : ''}">
      <div class="tableWrapper" style="padding-left: 9px; padding-right: 22px;">
        <table><tbody><tr><td>cell</td></tr></tbody></table>
      </div>
    </div>`;
  document.body.appendChild(container);
  const wrapper = container.querySelector<HTMLElement>('.tableWrapper')!;
  const table = container.querySelector<HTMLElement>('table')!;
  // 724px wide wrapper minus 31px of padding leaves 693px for the table.
  setWidth(wrapper, 'clientWidth', 724);
  setWidth(table, 'offsetWidth', tableWidth);
  return { container, wrapper, table, cell: container.querySelector<HTMLElement>('td')! };
}

function mouse(type: string, target: EventTarget, clientX: number, buttons = 1) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, buttons, clientX }));
}

describe('tableResizeHeadroom', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is the room left inside the wrapper content box', () => {
    const { table, wrapper } = buildEditor({ tableWidth: 659, resizing: true });

    expect(tableResizeHeadroom(table, wrapper)).toBe(34);
  });

  it('is zero for a table that already overflows', () => {
    const { table, wrapper } = buildEditor({ tableWidth: 716, resizing: true });

    expect(tableResizeHeadroom(table, wrapper)).toBe(0);
  });
});

describe('useTableResizeClamp', () => {
  // What a later bubble-phase window listener (the resize plugin) reads.
  let seen: number[] = [];
  const record = (event: MouseEvent) => seen.push(event.clientX);

  beforeEach(() => {
    seen = [];
    window.addEventListener('mousemove', record);
    window.addEventListener('mouseup', record);
  });

  afterEach(() => {
    window.removeEventListener('mousemove', record);
    window.removeEventListener('mouseup', record);
    document.body.innerHTML = '';
  });

  it('caps the pointer at the content edge while a column is dragged', () => {
    const { container, cell } = buildEditor({ tableWidth: 659, resizing: true });
    renderHook(() => useTableResizeClamp({ current: container }));

    mouse('mousedown', cell, 1000);
    mouse('mousemove', document.body, 1020);
    mouse('mousemove', document.body, 1500);
    mouse('mouseup', document.body, 1600);

    expect(seen).toEqual([1020, 1034, 1034]);
  });

  it('leaves the pointer alone once the drag has ended', () => {
    const { container, cell } = buildEditor({ tableWidth: 659, resizing: true });
    renderHook(() => useTableResizeClamp({ current: container }));

    mouse('mousedown', cell, 1000);
    mouse('mouseup', document.body, 1600);
    mouse('mousemove', document.body, 1500, 0);

    expect(seen).toEqual([1034, 1500]);
  });

  it('does not let an overflowing table grow, but still lets it shrink', () => {
    const { container, cell } = buildEditor({ tableWidth: 716, resizing: true });
    renderHook(() => useTableResizeClamp({ current: container }));

    mouse('mousedown', cell, 1000);
    mouse('mousemove', document.body, 1200);
    mouse('mousemove', document.body, 900);

    expect(seen).toEqual([1000, 900]);
  });

  it('ignores a mousedown that does not start a column resize', () => {
    const { container, cell } = buildEditor({ tableWidth: 659, resizing: false });
    renderHook(() => useTableResizeClamp({ current: container }));

    mouse('mousedown', cell, 1000);
    mouse('mousemove', document.body, 1500);

    expect(seen).toEqual([1500]);
  });

  it('stops clamping after unmount', () => {
    const { container, cell } = buildEditor({ tableWidth: 659, resizing: true });
    const { unmount } = renderHook(() => useTableResizeClamp({ current: container }));

    mouse('mousedown', cell, 1000);
    unmount();
    mouse('mousemove', document.body, 1500);

    expect(seen).toEqual([1500]);
  });
});
