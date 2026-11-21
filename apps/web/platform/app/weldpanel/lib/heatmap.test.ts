import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { averageFold, DEVICE_VIEWPORT, findElement, heatColor, readSnapshot, resolveBoxes, resolvePoints, scrollBands } from './heatmap';

function pageWith(html: string, rects: Record<string, { left: number; top: number; width: number; height: number }>): Document {
  const doc = document.implementation.createHTMLDocument('page');
  doc.body.innerHTML = html;
  for (const [selector, rect] of Object.entries(rects)) {
    const el = doc.querySelector(selector)!;
    el.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
  }
  return doc;
}

describe('heatmap helpers', () => {
  it('has a viewport per device class', () => {
    expect(DEVICE_VIEWPORT.desktop.width).toBe(1280);
    expect(DEVICE_VIEWPORT.tablet.width).toBe(820);
    expect(DEVICE_VIEWPORT.mobile.width).toBe(390);
  });

  it('survives a selector the page cannot parse', () => {
    const doc = pageWith('<a id="x"></a>', {});
    expect(findElement(doc, '###')).toBeNull();
    expect(findElement(doc, '#x')).not.toBeNull();
  });

  it('places click points by their position inside the element', () => {
    const doc = pageWith('<button id="buy"></button><a class="nav"></a>', { '#buy': { left: 100, top: 200, width: 200, height: 40 } });
    const { points, unresolved } = resolvePoints(doc, [
      { selector: '#buy', relX: 0.5, relY: 0.5, count: 90 },
      { selector: '#gone', relX: 0, relY: 0, count: 10 },
      { selector: '.nav', relX: 0, relY: 0, count: 5 },
    ]);
    expect(points).toEqual([{ x: 200, y: 220, intensity: 1, count: 90 }]);
    // Missing from the snapshot, and present but with no size: both are counted, not drawn.
    expect(unresolved).toBe(15);
  });

  it('turns elements into boxes and counts the ones it cannot place', () => {
    const doc = pageWith('<button id="buy"></button>', { '#buy': { left: 10, top: 20, width: 100, height: 30 } });
    const { boxes, unresolved } = resolveBoxes(doc, [
      { selector: '#buy', text: 'Buy', clicks: 60, share: 0.6, relX: 0.5, relY: 0.5 },
      { selector: '#other', text: null, clicks: 40, share: 0.4, relX: 0.5, relY: 0.5 },
    ]);
    expect(boxes).toMatchObject([{ selector: '#buy', x: 10, y: 20, width: 100, height: 30, share: 0.6, text: 'Buy' }]);
    expect(unresolved).toBe(40);
  });

  it('colours from cool to hot and clamps', () => {
    expect(heatColor(0)).toBe('rgba(37, 99, 235, 1)');
    expect(heatColor(1, 0.5)).toBe('rgba(239, 68, 68, 0.5)');
    expect(heatColor(5)).toBe(heatColor(1));
    expect(heatColor(-1)).toBe(heatColor(0));
  });

  it('turns scroll buckets into bands down the page and finds the fold', () => {
    const buckets = [
      { depth: 50, reachedShare: 0.4 },
      { depth: 0, reachedShare: 1 },
      { depth: 25, reachedShare: 0.7 },
    ];
    expect(scrollBands(buckets)).toEqual([
      { fromPercent: 0, toPercent: 25, reachedShare: 1 },
      { fromPercent: 25, toPercent: 50, reachedShare: 0.7 },
      { fromPercent: 50, toPercent: 100, reachedShare: 0.4 },
    ]);
    expect(averageFold(buckets)).toBe(50);
    expect(averageFold([{ depth: 0, reachedShare: 1 }, { depth: 90, reachedShare: 0.9 }])).toBeNull();
  });

  it('reads a gzipped snapshot of one event, or a list', async () => {
    const event = { type: 2, timestamp: 5, data: { node: {} } };
    const toBuffer = (value: unknown): ArrayBuffer => {
      const bytes = gzipSync(Buffer.from(JSON.stringify(value)));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    };
    expect(await readSnapshot(toBuffer(event))).toEqual(event);
    expect(await readSnapshot(toBuffer([event]))).toEqual(event);
    await expect(readSnapshot(toBuffer({ type: 3, timestamp: 1, data: {} }))).rejects.toThrow();
  });
});
