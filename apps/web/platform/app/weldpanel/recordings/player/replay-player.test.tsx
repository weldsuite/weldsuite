import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { PageVisit, ReplayEvent, TimelineMarker } from '../../lib/replay';
import { ReplayPlayer, type ReplayPlayerHandle } from './replay-player';

const rr = vi.hoisted(() => {
  class FakeReplayer {
    static instances: FakeReplayer[] = [];
    handlers = new Map<string, (payload?: unknown) => void>();
    played: (number | undefined)[] = [];
    paused: (number | undefined)[] = [];
    configs: Record<string, unknown>[] = [];
    destroyed = false;
    time = 0;
    constructor(
      public events: unknown[],
      public config: Record<string, unknown>,
    ) {
      FakeReplayer.instances.push(this);
    }
    on(name: string, handler: (payload?: unknown) => void) {
      this.handlers.set(name, handler);
      return this;
    }
    getMetaData() {
      return { startTime: 0, endTime: 60_000, totalTime: 60_000 };
    }
    getCurrentTime() {
      return this.time;
    }
    play(offset?: number) {
      this.played.push(offset);
      if (offset !== undefined) this.time = offset;
    }
    pause(offset?: number) {
      this.paused.push(offset);
      if (offset !== undefined) this.time = offset;
    }
    setConfig(config: Record<string, unknown>) {
      this.configs.push(config);
    }
    destroy() {
      this.destroyed = true;
    }
    emit(name: string, payload?: unknown) {
      this.handlers.get(name)?.(payload);
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

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

const tp = en.weldpanel.observe.player;
const events: ReplayEvent[] = [
  { type: 4, timestamp: 1000, data: { href: 'https://example.com', width: 1280, height: 800 } },
  { type: 2, timestamp: 1001, data: {} },
  { type: 3, timestamp: 61_000, data: {} },
];
const markers: TimelineMarker[] = [
  { id: 'm1', kind: 'frustration', offsetMs: 20_000, name: '$rageclick', label: 'Buy now', url: null },
  { id: 'm2', kind: 'error', offsetMs: 30_000, name: '$exception', label: 'TypeError', url: null },
];
const visits: PageVisit[] = [
  { offsetMs: 0, path: '/', url: 'https://example.com/', title: null, durationMs: 25_000 },
  { offsetMs: 25_000, path: '/pricing', url: 'https://example.com/pricing', title: null, durationMs: 35_000 },
];

const current = () => rr.FakeReplayer.instances[rr.FakeReplayer.instances.length - 1]!;

function setup(extra: Partial<Parameters<typeof ReplayPlayer>[0]> = {}) {
  return render(<ReplayPlayer events={events} markers={markers} inactive={[{ startMs: 5000, endMs: 15_000 }]} visits={visits} {...extra} />);
}

describe('ReplayPlayer', () => {
  beforeEach(() => {
    rr.FakeReplayer.instances = [];
  });

  it('builds the replayer in its container, skipping inactivity, and starts playing', () => {
    setup();
    const replayer = current();
    expect(replayer.config).toMatchObject({ skipInactive: true, showWarning: false, speed: 1 });
    expect(replayer.config.root).toBeInstanceOf(HTMLElement);
    expect(replayer.played).toEqual([0]);
    expect(screen.getByRole('button', { name: tp.pause })).toBeTruthy();
    expect(screen.getByTestId('player-clock').textContent).toBe('0:00 / 1:00');
  });

  it('pauses and resumes from where it stopped', async () => {
    setup();
    const replayer = current();
    await userEvent.click(screen.getByRole('button', { name: tp.pause }));
    expect(replayer.paused).toEqual([undefined]);
    replayer.time = 12_000;
    await userEvent.click(screen.getByRole('button', { name: tp.play }));
    expect(replayer.played.at(-1)).toBe(0);
  });

  it('seeks from the timeline with the keyboard and by clicking a marker', async () => {
    setup();
    const replayer = current();
    const slider = screen.getByRole('slider', { name: tp.timeline });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(replayer.played.at(-1)).toBe(5000);
    await userEvent.click(screen.getByRole('button', { name: /Frustration 0:20: Buy now/ }));
    // A little before the event, so the cause is on screen.
    expect(replayer.played.at(-1)).toBe(18_500);
  });

  it('seeks while paused without starting to play', async () => {
    setup();
    const replayer = current();
    await userEvent.click(screen.getByRole('button', { name: tp.pause }));
    fireEvent.keyDown(screen.getByRole('slider', { name: tp.timeline }), { key: 'End' });
    expect(replayer.paused.at(-1)).toBe(60_000);
  });

  it('switches skip inactivity and the speed on the replayer', async () => {
    setup();
    const replayer = current();
    await userEvent.click(screen.getByRole('switch', { name: tp.skipInactivity }));
    expect(replayer.configs.at(-1)).toEqual({ skipInactive: false });
    await userEvent.click(screen.getByRole('combobox', { name: tp.speed }));
    await userEvent.click(await screen.findByRole('option', { name: '4x' }));
    expect(replayer.configs.at(-1)).toEqual({ speed: 4 });
  });

  it('shows the page being replayed and the idle stretches', () => {
    setup();
    expect(screen.getByText('https://example.com/')).toBeTruthy();
    expect(screen.getAllByTestId('timeline-idle')).toHaveLength(1);
  });

  it('shows the end of the recording and can replay from the start', async () => {
    setup();
    const replayer = current();
    act(() => replayer.emit('finish'));
    expect(screen.getByText(tp.finished)).toBeTruthy();
    expect(screen.getByRole('button', { name: tp.play })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: tp.restart }));
    expect(replayer.played.at(-1)).toBe(0);
  });

  it('shows when inactivity is being skipped', () => {
    setup();
    act(() => current().emit('skip-start'));
    expect(screen.getByText(tp.skipping)).toBeTruthy();
    act(() => current().emit('skip-end'));
    expect(screen.queryByText(tp.skipping)).toBeNull();
  });

  it('exposes seek to the page and destroys the replayer on unmount', () => {
    const ref = { current: null as ReplayPlayerHandle | null };
    const { unmount } = setup({ ref });
    act(() => ref.current?.seek(25_000));
    expect(current().played.at(-1)).toBe(25_000);
    unmount();
    expect(current().destroyed).toBe(true);
  });

  it('reports a replayer that cannot be built', () => {
    const onError = vi.fn();
    const original = rr.FakeReplayer.prototype.getMetaData;
    rr.FakeReplayer.prototype.getMetaData = () => {
      throw new Error('boom');
    };
    setup({ onError });
    rr.FakeReplayer.prototype.getMetaData = original;
    expect(onError).toHaveBeenCalled();
  });
});
