import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';
import { downloadChartPng, downloadVisualCsv, inlineSvgStyles } from './download';

const chart: ChatVisual = {
  type: 'chart',
  kind: 'bar',
  title: 'Open tickets',
  labels: ['Open', 'Solved'],
  series: [{ name: 'Tickets', values: [3, 9] }],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A chart surface like recharts draws: a styled svg with text and a bar. */
function chartSurface(): HTMLDivElement {
  const container = document.createElement('div');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'recharts-surface');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('class', 'fill-primary');
  rect.style.fill = 'rgb(38, 109, 240)';
  const text = document.createElementNS(SVG_NS, 'text');
  text.textContent = 'Open';
  svg.append(rect, text);
  container.append(svg);
  document.body.append(container);
  return container;
}

let saved: Array<{ name: string; blob: Blob }>;

beforeEach(() => {
  saved = [];
  let current: Blob | null = null;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      current = blob;
      return 'blob:test';
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (current) saved.push({ name: this.download, blob: current });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('downloadVisualCsv', () => {
  it('saves the data as a CSV file named after the title, with a BOM for Excel', async () => {
    downloadVisualCsv(chart, { label: 'Status' });
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('open-tickets.csv');
    expect(saved[0].blob.type).toBe('text/csv;charset=utf-8');
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(saved[0].blob);
    });
    expect(text.replace(/^\uFEFF/, '')).toBe('Status,Tickets\r\nOpen,3\r\nSolved,9');
  });
});

describe('inlineSvgStyles', () => {
  it('writes each element its computed paint and drops the classes', () => {
    const svg = chartSurface().querySelector('svg')!;
    const copy = inlineSvgStyles(svg);
    expect(copy).not.toBe(svg);
    expect(copy.getAttribute('xmlns')).toBe(SVG_NS);
    const rect = copy.querySelector('rect')!;
    expect(rect.getAttribute('class')).toBeNull();
    expect(rect.getAttribute('style')).toContain('fill:rgb(38, 109, 240)');
    // Text also keeps its font.
    expect(copy.querySelector('text')!.getAttribute('style')).toContain('font-family');
    // The original is untouched.
    expect(svg.querySelector('rect')!.getAttribute('class')).toBe('fill-primary');
  });
});

describe('downloadChartPng', () => {
  it('does nothing without a chart in the container', async () => {
    await downloadChartPng(document.createElement('div'), chart);
    expect(saved).toHaveLength(0);
  });

  it('draws the chart on a canvas at twice its size and saves it as PNG', async () => {
    class LoadingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', LoadingImage);
    const drawImage = vi.fn();
    const context = { scale: vi.fn(), fillRect: vi.fn(), drawImage, fillStyle: '' };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['png'], { type: 'image/png' })),
    );
    const container = chartSurface();
    container.style.backgroundColor = 'rgb(255, 255, 255)';

    await downloadChartPng(container, chart);

    expect(context.scale).toHaveBeenCalledWith(2, 2);
    expect(context.fillStyle).toBe('rgb(255, 255, 255)');
    expect(drawImage).toHaveBeenCalled();
    expect(saved).toEqual([{ name: 'open-tickets.png', blob: expect.any(Blob) }]);
  });

  it('stops when the image cannot be drawn', async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', BrokenImage);
    await expect(downloadChartPng(chartSurface(), chart)).rejects.toThrow('could not be drawn');
    expect(saved).toHaveLength(0);
  });
});
