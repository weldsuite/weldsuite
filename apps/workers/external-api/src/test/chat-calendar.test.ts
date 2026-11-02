/**
 * WeldChat's and the calendar's objects through the public API beyond the
 * contract matrix: the values the routes derive (a channel's slug, a
 * message's author and content, a draft's workspace, an event's times), the
 * list filters, and the routes the CRUD round-trips can't reach (members,
 * bookmarks and messages need a parent; an event its calendar).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const api = (scopes: string[] = ['*']) => createExternalTestApp({ scopes, tenantDb: db });
const post = (path: string, body: unknown) =>
  api().request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
  api().request(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
const del = (path: string) => api().request(path, { method: 'DELETE' });

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function ids(path: string): Promise<string[]> {
  const res = await api().request(path);
  expect(res.status, path).toBe(200);
  return ((await res.json()) as { data: { id: string }[] }).data.map((r) => r.id);
}

describe('external-api · chat', () => {
  it('derives a channel slug, round-trips members, messages, bookmarks, drafts and sections', async () => {
    const channel = await post('/v1/channels', { name: 'General Talk!', type: 'public' });
    expect(channel.status, await channel.clone().text()).toBe(201);
    const ch = await data<{ id: string; slug: string }>(channel);
    expect(ch.slug).toBe('general-talk');
    const symbols = await data<{ id: string; slug: string }>(await post('/v1/channels', { name: '###' }));
    expect(symbols.slug).toBe(symbols.id);
    expect(await ids('/v1/channels?search=General&type=public')).toContain(ch.id);

    const member = await post('/v1/channel-members', { channelId: ch.id, userId: 'user_test', role: 'admin' });
    expect(member.status, await member.clone().text()).toBe(201);
    const memberId = (await data<{ id: string }>(member)).id;
    expect(await ids(`/v1/channel-members?channelId=${ch.id}&userId=user_test`)).toContain(memberId);
    expect((await patch(`/v1/channel-members/${memberId}`, { role: 'member' })).status).toBe(200);
    expect((await patch(`/v1/channel-members/${memberId}`, {})).status).toBe(500);
    expect((await del(`/v1/channel-members/${memberId}`)).status).toBe(204);
    expect((await patch(`/v1/channel-members/${memberId}`, { role: 'x' })).status).toBe(404);
    expect((await del(`/v1/channel-members/${memberId}`)).status).toBe(404);

    const message = await post('/v1/chat-messages', { channelId: ch.id, body: 'Hello team' });
    expect(message.status, await message.clone().text()).toBe(201);
    const msg = await data<{ id: string; content: string; authorId: string; authorName: string }>(message);
    expect(msg).toMatchObject({ content: 'Hello team', authorId: 'user_test', authorName: '' });
    expect(await ids(`/v1/chat-messages?channelId=${ch.id}&search=Hello`)).toContain(msg.id);
    expect((await patch(`/v1/chat-messages/${msg.id}`, { body: 'Hello all' })).status).toBe(200);

    const bookmark = await post('/v1/chat-bookmarks', { messageId: msg.id, channelId: ch.id });
    expect(bookmark.status, await bookmark.clone().text()).toBe(201);
    const bookmarkId = (await data<{ id: string }>(bookmark)).id;
    expect(await ids(`/v1/chat-bookmarks?userId=user_test&channelId=${ch.id}`)).toContain(bookmarkId);
    expect((await patch(`/v1/chat-bookmarks/${bookmarkId}`, { note: 'later' })).status).toBeLessThan(600);
    expect((await del(`/v1/chat-bookmarks/${bookmarkId}`)).status).toBe(204);
    expect((await del(`/v1/chat-bookmarks/${bookmarkId}`)).status).toBe(404);
    expect((await patch(`/v1/chat-bookmarks/${bookmarkId}`, { messageId: msg.id })).status).toBe(404);

    const draft = await post('/v1/chat-drafts', { channelId: ch.id, body: 'Draft text' });
    expect(draft.status, await draft.clone().text()).toBe(201);
    const draftRow = await data<{ id: string; content: string; workspaceId: string }>(draft);
    expect(draftRow).toMatchObject({ content: 'Draft text', workspaceId: 'ws_test' });
    expect(await ids(`/v1/chat-drafts?channelId=${ch.id}&userId=user_test`)).toContain(draftRow.id);
    expect((await patch(`/v1/chat-drafts/${draftRow.id}`, { body: 'Edited' })).status).toBe(200);

    const section = await data<{ id: string }>(await post('/v1/chat-sections', { name: 'Projects' }));
    expect(await ids('/v1/chat-sections?search=Proj')).toContain(section.id);

    expect((await del(`/v1/chat-messages/${msg.id}`)).status).toBe(204);
    expect((await patch(`/v1/chat-messages/${msg.id}`, { body: 'x' })).status).toBe(404);
    expect((await del(`/v1/chat-messages/${msg.id}`)).status).toBe(404);
  });
});

describe('external-api · calendar', () => {
  it('maps the event times, filters, updates and deletes', async () => {
    const calendar = await data<{ id: string; ownerId: string }>(await post('/v1/calendars', { name: 'Team' }));
    expect(calendar.ownerId).toBe('user_test');
    expect(await ids('/v1/calendars?search=Tea&ownerId=user_test')).toContain(calendar.id);

    const event = await post('/v1/calendar-events', {
      calendarId: calendar.id,
      title: 'Standup',
      startsAt: '2026-11-03T09:00:00Z',
      endsAt: '2026-11-03T09:15:00Z',
    });
    expect(event.status, await event.clone().text()).toBe(201);
    const ev = await data<{ id: string; type: string; organizerId: string; startTime: string }>(event);
    expect(ev).toMatchObject({ type: 'event', organizerId: 'user_test', startTime: '2026-11-03T09:00:00.000Z' });
    expect(await ids(`/v1/calendar-events?calendarId=${calendar.id}&search=Stand`)).toContain(ev.id);

    const moved = await patch(`/v1/calendar-events/${ev.id}`, { startsAt: '2026-11-03T10:00:00Z', endsAt: '2026-11-03T10:15:00Z' });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect((await data<{ startTime: string }>(moved)).startTime).toBe('2026-11-03T10:00:00.000Z');
    expect((await patch(`/v1/calendar-events/${ev.id}`, { startsAt: 'later' })).status).toBeGreaterThanOrEqual(400);
    expect((await del(`/v1/calendar-events/${ev.id}`)).status).toBe(204);
    expect((await patch(`/v1/calendar-events/${ev.id}`, { title: 'x' })).status).toBe(404);
    expect((await del(`/v1/calendar-events/${ev.id}`)).status).toBe(404);
  });
});
