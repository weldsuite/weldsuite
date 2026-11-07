/**
 * GitLab's `IssueSyncAdapter` against a stubbed GitLab (by method and URL):
 * what it asks for, what it sends, and how it maps issues and notes. Pure of
 * the database: the context is built by hand.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';
import type { MergeConnectionRow } from '../../db';
import { failure, stubHttp } from '../../../test/fake-http';
import { gitlabIssue } from '../../../test/fake-gitlab';
import type { AdapterContext, RepositoryRef } from '../types';
import { gitlabIssues } from './issues';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = (host: string | null = null): AdapterContext => ({
  env: {} as Env,
  connection: { id: 'mcn_1', provider: 'gitlab', host } as MergeConnectionRow,
  memberToken: 'gl-token',
});
const repo: RepositoryRef = { externalId: '55', fullName: 'acme/web', externalProject: 'acme' };
const P = 'gitlab.com/api/v4/projects/55';

describe('listIssues / getIssue', () => {
  it('lists with the state and window, and maps opened/closed', async () => {
    const calls = stubHttp({
      [`GET ${P}/issues`]: [gitlabIssue({ iid: 1, labels: ['bug'], assignee: 'Alice' }), gitlabIssue({ iid: 2, state: 'closed' })],
    });
    const since = new Date('2026-10-01T00:00:00Z');
    const issues = await gitlabIssues.listIssues(ctx(), repo, { state: 'open', since, limit: 100 });
    expect(issues.map((i) => [i.number, i.state, i.labels, i.assigneeLogin, i.stateReason])).toEqual([
      [1, 'open', ['bug'], 'alice', null],
      [2, 'closed', [], null, null],
    ]);
    expect(calls).toEqual([
      {
        method: 'GET',
        url: `${P}/issues?state=opened&updated_after=${encodeURIComponent(since.toISOString())}&order_by=updated_at&sort=desc&per_page=100&page=1`,
        auth: 'bearer gl-token',
      },
    ]);
  });

  it('reads one issue, null when it is gone', async () => {
    stubHttp({ [`GET ${P}/issues/4`]: gitlabIssue({ iid: 4, description: 'steps' }) });
    expect(await gitlabIssues.getIssue(ctx(), repo, 4)).toMatchObject({ number: 4, body: 'steps', url: 'https://gitlab.com/acme/web/-/issues/4' });
    expect(await gitlabIssues.getIssue(ctx(), repo, 9)).toBeNull();
  });

  it('uses a self-managed host', async () => {
    const calls = stubHttp({ 'GET git.example.com/api/v4/projects/55/issues/1': gitlabIssue({ iid: 1 }) });
    await gitlabIssues.getIssue(ctx('https://git.example.com'), repo, 1);
    expect(calls[0]!.url).toBe('git.example.com/api/v4/projects/55/issues/1');
  });
});

describe('createIssue / updateIssue', () => {
  it('creates with labels and an assignee looked up by login', async () => {
    const calls = stubHttp({
      'GET gitlab.com/api/v4/users': [{ id: 31 }],
      [`POST ${P}/issues`]: gitlabIssue({ iid: 7, title: 'New' }),
    });
    const created = await gitlabIssues.createIssue(ctx(), repo, { title: 'New', body: 'text', labels: ['bug', 'ui'], assigneeLogin: 'alice' });
    expect(created).toMatchObject({ number: 7, state: 'open' });
    expect(calls).toEqual([
      { method: 'GET', url: 'gitlab.com/api/v4/users?username=alice', auth: 'bearer gl-token' },
      { method: 'POST', url: `${P}/issues`, auth: 'bearer gl-token', body: { title: 'New', description: 'text', labels: 'bug,ui', assignee_ids: [31] } },
    ]);
  });

  it('closes a new issue that was born closed', async () => {
    const calls = stubHttp({
      [`POST ${P}/issues`]: gitlabIssue({ iid: 8 }),
      [`PUT ${P}/issues/8`]: gitlabIssue({ iid: 8, state: 'closed' }),
    });
    const created = await gitlabIssues.createIssue(ctx(), repo, { title: 'Done already', state: 'closed' });
    expect(created.state).toBe('closed');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${P}/issues`, `PUT ${P}/issues/8`]);
    expect(calls[1]!.body).toEqual({ state_event: 'close' });
  });

  it('updates title, body, labels and state; clears and skips unknown assignees', async () => {
    const calls = stubHttp({ [`PUT ${P}/issues/5`]: gitlabIssue({ iid: 5, title: 'Changed' }), 'GET gitlab.com/api/v4/users': [] });
    await gitlabIssues.updateIssue(ctx(), repo, 5, { title: 'Changed', body: 'b', labels: [], state: 'open', assigneeLogin: null });
    expect(calls[0]!.body).toEqual({ title: 'Changed', description: 'b', labels: '', state_event: 'reopen', assignee_ids: [] });

    const second = stubHttp({ [`PUT ${P}/issues/5`]: gitlabIssue({ iid: 5 }), 'GET gitlab.com/api/v4/users': [] });
    await gitlabIssues.updateIssue(ctx(), repo, 5, { state: 'closed', assigneeLogin: 'nobody' });
    expect(second.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(second[1]!.body).toEqual({ state_event: 'close' });
  });

  it('passes the provider\'s own message through on a refusal', async () => {
    stubHttp({ [`PUT ${P}/issues/5`]: failure(403, { message: '403 Forbidden' }) });
    await expect(gitlabIssues.updateIssue(ctx(), repo, 5, { title: 'x' })).rejects.toMatchObject({
      name: 'ProviderApiError',
      status: 403,
      message: '403 Forbidden',
    });
  });

  it('refuses without a token', async () => {
    stubHttp({});
    const noToken: AdapterContext = { ...ctx(), memberToken: undefined };
    await expect(gitlabIssues.getIssue(noToken, repo, 1)).rejects.toMatchObject({ status: 401 });
  });
});

describe('comments', () => {
  it('lists notes oldest first and leaves system notes out', async () => {
    const calls = stubHttp({
      [`GET ${P}/issues/4/notes`]: [
        { id: 1, body: 'added label', system: true, author: { username: 'a' }, created_at: '2026-11-01T10:00:00Z' },
        { id: 2, body: 'a real comment', system: false, author: { username: 'Al', avatar_url: 'x' }, created_at: '2026-11-01T11:00:00Z', updated_at: '2026-11-01T12:00:00Z' },
      ],
    });
    const comments = await gitlabIssues.listComments(ctx(), repo, 4);
    expect(comments).toEqual([
      {
        externalId: '2',
        issueNumber: 4,
        body: 'a real comment',
        authorLogin: 'al',
        authorAvatarUrl: 'x',
        createdAt: new Date('2026-11-01T11:00:00Z'),
        updatedAt: new Date('2026-11-01T12:00:00Z'),
      },
    ]);
    expect(calls[0]!.url).toBe(`${P}/issues/4/notes?sort=asc&order_by=created_at&per_page=100&page=1`);
  });

  it('creates a note', async () => {
    const calls = stubHttp({ [`POST ${P}/issues/4/notes`]: { id: 3, body: 'hello', author: { username: 'bot' }, created_at: '2026-11-01T10:00:00Z' } });
    expect(await gitlabIssues.createComment(ctx(), repo, 4, 'hello')).toMatchObject({ externalId: '3', issueNumber: 4, body: 'hello' });
    expect(calls[0]).toEqual({ method: 'POST', url: `${P}/issues/4/notes`, auth: 'bearer gl-token', body: { body: 'hello' } });
  });
});
