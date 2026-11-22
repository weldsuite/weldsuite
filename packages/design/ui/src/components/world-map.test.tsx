import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clampView, dotRadius, mainPartsBox, partBoxes, viewBetween, viewCentredOn, WorldMap, zoomAt } from './world-map';

const LABELS = { zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Whole world' };
const ITEMS = [
  { code: 'NL', label: 'Netherlands', value: 16, display: '16' },
  { code: 'US', label: 'United States', value: 10, display: '10' },
];

/** The map's current move: `[x, y, k]` from its transform. */
function view(container: HTMLElement): [number, number, number] {
  const transform = container.querySelector('svg > g')?.getAttribute('transform') ?? '';
  const [, x, y, k] = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(transform) ?? [];
  return [Number(x), Number(y), Number(k)];
}

function prefersLessMotion(less: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: less && query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

describe('partBoxes', () => {
  it('boxes each part of a path, relative and absolute lines alike', () => {
    expect(partBoxes('M10 10l5 0 0 5z M100 100l1 1')).toEqual([
      [10, 10, 15, 15],
      [100, 100, 101, 101],
    ]);
    expect(partBoxes('M0 0L4 0V3H-1z')).toEqual([[-1, 0, 4, 3]]);
    expect(partBoxes('M0 0 2 2 4 1')).toEqual([[0, 0, 4, 2]]);
  });

  it('reads numbers written without a leading zero or a separator', () => {
    expect(partBoxes('M1 1l-.5-.5 .25.25')).toEqual([[0.5, 0.5, 1, 1]]);
  });

  it('moves a relative part from where the last one ended', () => {
    expect(partBoxes('m10 10l2 2m5 0l1 1')).toEqual([
      [10, 10, 12, 12],
      [17, 12, 18, 13],
    ]);
  });

  it('skips commands it does not draw and lines before any part', () => {
    expect(partBoxes('l5 5')).toEqual([]);
    expect(partBoxes('M0 0C1 1 2 2 3 3l1 1')).toEqual([[0, 0, 1, 1]]);
  });
});

describe('mainPartsBox', () => {
  it('keeps the largest part and the big ones next to it, not the small far-off islands', () => {
    const mainland = 'M100 100l100 0 0 50 -100 0z';
    const alaska = 'M10 60l40 0 0 30 -40 0z';
    const island = 'M400 300l2 0 0 2 -2 0z';
    expect(mainPartsBox(`${mainland}${alaska}${island}`)).toEqual({ x: 10, y: 60, width: 190, height: 90 });
  });

  it('is null for a path without parts', () => {
    expect(mainPartsBox('')).toBeNull();
  });
});

describe('views', () => {
  it('centres a map point at a zoom, kept inside the map', () => {
    expect(viewCentredOn(500, 273.5, 1)).toEqual({ k: 1, x: 0, y: 0 });
    expect(viewCentredOn(500, 273.5, 2)).toEqual({ k: 2, x: -500, y: -273.5 });
    // Near the edge the map stops at its border.
    expect(viewCentredOn(0, 0, 4).x).toBe(0);
  });

  it('goes part of the way: the middle in a straight line, the zoom evenly in scale', () => {
    const from = { k: 1, x: 0, y: 0 };
    const to = viewCentredOn(500, 273.5, 4);
    expect(viewBetween(from, to, 0)).toEqual(from);
    expect(viewBetween(from, to, 1)).toEqual(to);
    expect(viewBetween(from, to, 0.5).k).toBeCloseTo(2);
  });

  it('keeps dots, zoom and pan inside their limits', () => {
    expect(dotRadius(0, 10)).toBe(4);
    expect(dotRadius(10, 10)).toBe(12);
    expect(clampView({ k: 100, x: 10, y: 10 }).k).toBe(24);
    expect(zoomAt({ k: 1, x: 0, y: 0 }, 0.5, 0, 0)).toEqual({ k: 1, x: 0, y: 0 });
  });
});

describe('WorldMap', () => {
  beforeEach(() => prefersLessMotion(true));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('flies to a focused country, fitted to its mainland, and lights it up for a moment', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<WorldMap items={ITEMS} valueLabel="Visitors" countryLabel="Country" zoom={LABELS} />);
    expect(view(container)).toEqual([0, 0, 1]);

    rerender(<WorldMap items={ITEMS} valueLabel="Visitors" countryLabel="Country" zoom={LABELS} focus={{ code: 'nl' }} />);
    // The Netherlands is small: the deepest zoom, centred on it.
    expect(view(container)[2]).toBe(24);
    const netherlands = container.querySelector('path[data-code="NL"]') as SVGPathElement;
    expect(netherlands.style.fill).toBe('var(--chart-1)');

    act(() => vi.advanceTimersByTime(600));
    expect(netherlands.style.fill).not.toBe('var(--chart-1)');
  });

  it('fits a big country with its far parts, such as the US with Alaska', () => {
    const { container } = render(<WorldMap items={ITEMS} valueLabel="Visitors" countryLabel="Country" zoom={LABELS} focus={{ code: 'US' }} />);
    const [, , k] = view(container);
    expect(k).toBeGreaterThan(1);
    expect(k).toBeLessThan(3);
  });

  it('ignores a focus on a country it has no shape for', () => {
    const { container } = render(<WorldMap items={ITEMS} valueLabel="Visitors" countryLabel="Country" focus={{ code: 'XX' }} />);
    expect(view(container)).toEqual([0, 0, 1]);
  });

  it('zooms with its buttons and goes back to the whole world', () => {
    const { container } = render(<WorldMap items={ITEMS} valueLabel="Visitors" countryLabel="Country" zoom={LABELS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(view(container)[2]).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(view(container)[2]).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(view(container)[2]).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Whole world' }));
    expect(view(container)).toEqual([0, 0, 1]);
  });

  it('glides there when motion is fine, and a second click zooms on from where the first one goes', () => {
    prefersLessMotion(false);
    let now = 0;
    let lastId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      lastId += 1;
      frames.set(lastId, callback);
      return lastId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const step = (to: number) => {
      now = to;
      const due = [...frames.values()];
      frames.clear();
      act(() => due.forEach((frame) => frame(now)));
    };

    const { container } = render(<WorldMap items={ITEMS} valueLabel="Visitors" countryLabel="Country" zoom={LABELS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    step(150);
    const [, , halfway] = view(container);
    expect(halfway).toBeGreaterThan(1);
    expect(halfway).toBeLessThan(2);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    step(1000);
    step(2000);
    expect(view(container)[2]).toBe(4);
  });

  it('lists the countries for screen readers', () => {
    render(<WorldMap items={ITEMS} valueLabel="Visitors" countryLabel="Country" />);
    expect(screen.getByRole('rowheader', { name: 'Netherlands' })).toBeTruthy();
  });
});
