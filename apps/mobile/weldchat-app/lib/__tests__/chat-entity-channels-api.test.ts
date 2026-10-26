import type { ClientApi } from '@weldsuite/app-api-client/types';
import { createChatEntityChannelsApi } from '@weldsuite/app-api-client/domains/chat-entity-channels';

/** A ClientApi that records each call and answers `{ data: [] }`. */
function recordingClient() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const answer = (method: string) => (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return Promise.resolve({ data: [] });
  };
  const api = {
    get: answer('GET'),
    post: answer('POST'),
    put: answer('PUT'),
    patch: answer('PATCH'),
    delete: answer('DELETE'),
  } as unknown as ClientApi;
  return { api, calls };
}

describe('chat entity channels API client', () => {
  it('lists record chats with only the parameters given', async () => {
    const { api, calls } = recordingClient();
    const records = createChatEntityChannelsApi(api);

    await records.list();
    await records.list({ type: 'company', filter: 'unread', search: 'acme corp', cursor: 'ch_9', limit: 25 });

    expect(calls[0]).toEqual({ method: 'GET', path: '/chat-entity-channels', body: undefined });
    expect(calls[1].method).toBe('GET');
    const [path, query] = calls[1].path.split('?');
    expect(path).toBe('/chat-entity-channels');
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      type: 'company',
      filter: 'unread',
      search: 'acme corp',
      cursor: 'ch_9',
      limit: '25',
    });
  });

  it('leaves empty parameters out', async () => {
    const { api, calls } = recordingClient();
    await createChatEntityChannelsApi(api).list({ filter: 'all', search: '' });
    expect(calls[0].path).toBe('/chat-entity-channels?filter=all');
  });

  it('reads the summary', async () => {
    const { api, calls } = recordingClient();
    await createChatEntityChannelsApi(api).summary();
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/chat-entity-channels/summary' });
  });

  it('follows and unfollows a record', async () => {
    const { api, calls } = recordingClient();
    const records = createChatEntityChannelsApi(api);
    await records.follow('company', 'cmp_1');
    await records.unfollow('company', 'cmp_1');
    expect(calls).toEqual([
      { method: 'POST', path: '/chat-entity-channels/company/cmp_1/follow', body: {} },
      { method: 'DELETE', path: '/chat-entity-channels/company/cmp_1/follow', body: undefined },
    ]);
  });

  it('gets the channel and detail of a record, escaping its id', async () => {
    const { api, calls } = recordingClient();
    const records = createChatEntityChannelsApi(api);
    await records.getChannel('task', 'tsk/1');
    await records.getDetail('task', 'tsk/1');
    expect(calls.map((c) => c.path)).toEqual([
      '/chat-entity-channels/task/tsk%2F1/channel',
      '/chat-entity-channels/task/tsk%2F1/detail',
    ]);
  });

  it('posts a message in a record chat', async () => {
    const { api, calls } = recordingClient();
    await createChatEntityChannelsApi(api).sendMessage('project', 'prj_1', { content: 'Hi', mentions: ['usr_2'] });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/chat-entity-channels/project/prj_1/messages',
      body: { content: 'Hi', mentions: ['usr_2'] },
    });
  });
});
