import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeHeatmap } from '../observe-fixtures';
import { SnapshotView } from './snapshot-view';

const rr = vi.hoisted(() => {
  class FakeReplayer {
    static instances: FakeReplayer[] = [];
    static doc: Document | null = null;
    static failOnBuild = false;
    iframe = { contentDocument: FakeReplayer.doc, style: {} as Record<string, string> };
    wrapper = { style: {} as Record<string, string> };
    paused: number[] = [];
    destroyed = false;
    constructor(
      public events: { type: number; data: { width?: number; height?: number } }[],
      public config: Record<string, unknown>,
    ) {
      if (FakeReplayer.failOnBuild) throw new Error('bad snapshot');
      FakeReplayer.instances.push(this);
    }
    getMetaData() {
      return { totalTime: 1 };
    }
    pause(offset: number) {
      this.paused.push(offset);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { FakeReplayer };
});

vi.mock('rrweb', () => ({ Replayer: rr.FakeReplayer }));
vi.mock('rrweb/dist/style.css', () => ({}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});

const snapshot = { type: 2, timestamp: 100, data: {} };

function pageDoc(): Document {
  const doc = document.implementation.createHTMLDocument('p');
  doc.body.innerHTML = '<button id="buy"></button>';
  Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 3000 });
  doc.querySelector('#buy')!.getBoundingClientRect = () => ({ left: 100, top: 400, width: 200, height: 50, right: 300, bottom: 450, x: 100, y: 400, toJSON: () => ({}) }) as DOMRect;
  return doc;
}

describe('SnapshotView', () => {
  beforeEach(() => {
    rr.FakeReplayer.instances = [];
    rr.FakeReplayer.doc = pageDoc();
    rr.FakeReplayer.failOnBuild = false;
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  });

  it('rebuilds the snapshot at the device width with a made-up Meta event, stopped on the page', async () => {
    render(<SnapshotView snapshot={snapshot} deviceClass="tablet" heatmap={makeHeatmap()} />);
    const replayer = rr.FakeReplayer.instances[0]!;
    expect(replayer.events[0]).toMatchObject({ type: 4, data: { width: 820 } });
    expect(replayer.events[1]).toMatchObject({ type: 2, timestamp: 101 });
    expect(replayer.paused).toEqual([1]);
    expect(replayer.config).toMatchObject({ showWarning: false, skipInactive: false });
    // The page grows to its full height so the heat layer covers all of it.
    await waitFor(() => expect(replayer.iframe.style.height).toBe('3000px'));
  });

  it('draws areas as boxes over the elements, with their share of the clicks', async () => {
    render(<SnapshotView snapshot={snapshot} deviceClass="desktop" heatmap={makeHeatmap({ type: 'area' })} />);
    const boxes = await screen.findAllByTestId('heatmap-box');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.style.left).toBe('100px');
    expect(boxes[0]!.style.top).toBe('400px');
    expect(boxes[0]!.textContent).toBe('60%');
  });

  it('reports the clicks it cannot place', async () => {
    const onUnresolved = vi.fn();
    render(<SnapshotView snapshot={snapshot} deviceClass="desktop" heatmap={makeHeatmap({ type: 'area' })} onUnresolved={onUnresolved} />);
    await waitFor(() => expect(onUnresolved).toHaveBeenLastCalledWith(60));
  });

  it('draws scroll depth as bands down the page', () => {
    render(<SnapshotView snapshot={snapshot} deviceClass="desktop" heatmap={makeHeatmap({ type: 'scroll' })} />);
    const bands = screen.getAllByTestId('heatmap-band');
    expect(bands).toHaveLength(4);
    expect(bands[1]!.style.top).toBe('25%');
    expect(bands[1]!.textContent).toBe(en.weldpanel.observe.heatmaps.scrollReached.replace('{share}', '70%').replace('{depth}', '25'));
  });

  it('reports a snapshot that cannot be built, and tidies up on unmount', () => {
    const onBroken = vi.fn();
    rr.FakeReplayer.failOnBuild = true;
    render(<SnapshotView snapshot={snapshot} deviceClass="desktop" heatmap={makeHeatmap()} onBroken={onBroken} />);
    expect(onBroken).toHaveBeenCalled();
    rr.FakeReplayer.failOnBuild = false;
    const { unmount } = render(<SnapshotView snapshot={snapshot} deviceClass="desktop" heatmap={makeHeatmap()} />);
    unmount();
    expect(rr.FakeReplayer.instances.at(-1)!.destroyed).toBe(true);
  });
});
