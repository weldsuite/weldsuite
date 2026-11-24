import { EVENTS_PER_UPLOAD, flushEvents, queueEvent, readEvents } from '@/lib/offline/events';

import { memoryStore } from './support/offline-fixtures';

const at = new Date('2026-11-24T10:00:00Z');

describe('uploading what the phone did offline', () => {
  it('sends the queue in batches of 500, oldest first, and empties it', async () => {
    const store = memoryStore();
    const queued = Array.from({ length: EVENTS_PER_UPLOAD + 3 }, (_, i) => ({
      vaultId: 'v1',
      itemId: `i${i}`,
      action: 'revealed',
      at: at.toISOString(),
    }));
    await store.setItem('weldpass:offline-events:ws_1', JSON.stringify(queued));
    const batches: string[][] = [];
    const sent = await flushEvents(store, 'ws_1', async (events) => {
      batches.push(events.map((event) => event.itemId));
    });
    expect(sent).toBe(EVENTS_PER_UPLOAD + 3);
    expect(batches.map((batch) => batch.length)).toEqual([EVENTS_PER_UPLOAD, 3]);
    expect(batches[0]?.[0]).toBe('i0');
    expect(await readEvents(store, 'ws_1')).toEqual([]);
  });

  it('keeps an event recorded while a batch was on its way', async () => {
    const store = memoryStore();
    await queueEvent(store, 'ws_1', { vaultId: 'v1', itemId: 'i1', action: 'copied', at });
    let first = true;
    await flushEvents(store, 'ws_1', async () => {
      if (!first) throw new Error('offline again');
      first = false;
      await queueEvent(store, 'ws_1', { vaultId: 'v1', itemId: 'i2', action: 'revealed', at });
    }).catch(() => 0);
    expect((await readEvents(store, 'ws_1')).map((event) => event.itemId)).toEqual(['i2']);
  });

  it('keeps everything not sent when an upload fails', async () => {
    const store = memoryStore();
    await queueEvent(store, 'ws_1', { vaultId: 'v1', itemId: 'i1', action: 'copied', at });
    await expect(
      flushEvents(store, 'ws_1', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
    expect(await readEvents(store, 'ws_1')).toHaveLength(1);
  });
});
