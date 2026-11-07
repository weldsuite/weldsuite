/**
 * DB-backed tests for the two internal entrypoints of the "Across" area on a
 * real tenant schema (pglite): WeldConnect `merge.*` actions
 * (POST /internal/workflow-action) and WeldAgent tools (POST /internal/agent-tool).
 *
 * What must not regress:
 *   1. Both act as the member the caller names, with that member's permissions
 *      resolved now: a viewer, or someone who left the workspace, is refused with
 *      `ok: false` and nothing is written or published.
 *   2. The writes publish the member routes' entity events; a workflow's events
 *      carry its chain depth, an agent's carry `triggeredByAgentId`.
 *   3. Assigning an agent publishes `merge_issue.agent_assigned`.
 *   4. `merge_open_draft_pull_request` makes the Git Data API calls in order, by
 *      URL and method (stubbed by URL, never by call order).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import internalRoutes from './index';
import { ADMIN, clearEvents, data, events, jsonInit, makeApp, newId, openDb, perRun, resetTables, stubGithub } from '../../test/helpers';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_across_member', userId: 'user_member', role: 'MEMBER' },
    { id: 'wm_across_viewer', userId: 'user_viewer', role: 'VIEWER' },
  ]);
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const internal = () => makeApp(db, '/internal', internalRoutes, { grants: ADMIN });

interface ActionResult {
  ok: boolean;
  issueId: string | null;
  issueKey: string | null;
  commentId: string | null;
  error: string | null;
}
interface ToolResult {
  ok: boolean;
  result: any;
  error: string | null;
}

async function action(userId: string, name: string, input: Record<string, unknown>, chainDepth?: number) {
  const res = await internal().request('/internal/workflow-action', jsonInit({ workspaceId: 'org_alpha', userId, action: name, input, chainDepth }));
  expect(res.status).toBe(200);
  return data<ActionResult>(res);
}

async function tool(userId: string, name: string, input: Record<string, unknown>, agentId: string | null = 'agt_1') {
  const res = await internal().request('/internal/agent-tool', jsonInit({ workspaceId: 'org_alpha', userId, agentId, tool: name, input }));
  expect(res.status).toBe(200);
  return data<ToolResult>(res);
}

const eventLog = () => events.map((e) => e.eventType);

describe('merge.* workflow actions', () => {
  it('creates an issue as the workflow owner and publishes issue:created with the chain depth', async () => {
    const team = await seedTeam(db, 'PLAT');
    clearEvents();
    const result = await action('user_member', 'merge.create_issue', { teamId: team.id, title: 'Customer asked for export', priority: '2', description: '' }, 3);
    expect(result).toEqual({ ok: true, issueId: newId(result.issueId!), issueKey: 'PLAT-1', commentId: null, error: null });

    const [row] = await db.select().from(schema.mergeIssues);
    expect(row).toMatchObject({ title: 'Customer asked for export', priority: 2, description: null, creatorUserId: 'user_member' });
    expect(eventLog()).toEqual(['merge_issue:created']);
    expect(events[0]!.metadata).toMatchObject({ userId: 'user_member', workflowDepth: 3 });
  });

  it('updates an issue by key and publishes issue:updated with the changes', async () => {
    const team = await seedTeam(db, 'PLAT');
    await seedIssue(db, team.id, 209, { title: 'Old', status: 'todo' });
    clearEvents();
    const result = await action('user_member', 'merge.update_issue', { issue: 'PLAT-209', status: 'in_progress', title: 'New' });
    expect(result).toMatchObject({ ok: true, issueKey: 'PLAT-209' });
    const [row] = await db.select().from(schema.mergeIssues);
    expect(row).toMatchObject({ title: 'New', status: 'in_progress' });
    expect(eventLog()).toEqual(['merge_issue:updated']);
    expect(events[0]!.changes).toMatchObject({ status: { old: 'todo', new: 'in_progress' } });
  });

  it('comments on an issue by key', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await seedIssue(db, team.id, 7);
    clearEvents();
    const result = await action('user_member', 'merge.comment_on_issue', { issue: 'PLAT-7', body: 'Shipped in 4.2' });
    expect(result).toMatchObject({ ok: true, issueId: issue.id, issueKey: 'PLAT-7' });
    expect(result.commentId).toBeTruthy();
    const [comment] = await db.select().from(schema.mergeComments);
    expect(comment).toMatchObject({ issueId: issue.id, body: 'Shipped in 4.2', authorUserId: 'user_member' });
    expect(eventLog()).toEqual(['merge_comment:created']);
  });

  it('refuses an owner who lacks the permission, and one who left the workspace, without writing', async () => {
    const team = await seedTeam(db, 'PLAT');
    await seedIssue(db, team.id, 1);
    clearEvents();

    const viewer = await action('user_viewer', 'merge.create_issue', { teamId: team.id, title: 'Nope' });
    expect(viewer).toMatchObject({ ok: false, issueId: null });
    expect(viewer.error).toContain('merge_issues:create');

    const gone = await action('user_gone', 'merge.comment_on_issue', { issue: 'PLAT-1', body: 'hi' });
    expect(gone.ok).toBe(false);
    expect(gone.error).toContain('no longer a member');

    expect(await db.select().from(schema.mergeComments)).toHaveLength(0);
    expect(await db.select().from(schema.mergeIssues)).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('fails a step with a readable reason for bad input or a missing issue', async () => {
    const team = await seedTeam(db, 'PLAT');
    const noTitle = await action('user_member', 'merge.create_issue', { teamId: team.id });
    expect(noTitle.ok).toBe(false);
    expect(noTitle.error).toContain('title');

    const missing = await action('user_member', 'merge.update_issue', { issue: 'PLAT-99', status: 'done' });
    expect(missing).toMatchObject({ ok: false, error: 'Issue PLAT-99 was not found' });

    const noTeam = await action('user_member', 'merge.create_issue', { teamId: 'mtm_missing', title: 'x' });
    expect(noTeam).toMatchObject({ ok: false, error: 'The team does not exist' });
    expect(events).toHaveLength(0);
  });
});

describe('WeldAgent tools', () => {
  it('lists and reads issues, with comments, for a member who may read', async () => {
    const team = await seedTeam(db, 'PLAT');
    const one = await seedIssue(db, team.id, 1, { status: 'todo', title: 'Fix tabs' });
    await seedIssue(db, team.id, 2, { status: 'done', title: 'Ship it' });
    await action('user_member', 'merge.comment_on_issue', { issue: 'PLAT-1', body: 'on it' });

    const listed = await tool('user_viewer', 'merge_list_issues', { status: ['todo'] });
    expect(listed.ok).toBe(true);
    expect(listed.result.issues.map((i: { key: string }) => i.key)).toEqual(['PLAT-1']);

    const detail = await tool('user_viewer', 'merge_get_issue', { issue: 'PLAT-1' });
    expect(detail.result).toMatchObject({ id: one.id, title: 'Fix tabs' });
    expect(detail.result.comments.map((c: { body: string }) => c.body)).toEqual(['on it']);

    const missing = await tool('user_viewer', 'merge_get_issue', { issue: 'PLAT-77' });
    expect(missing).toEqual({ ok: false, result: null, error: 'Issue PLAT-77 was not found' });
  });

  it("gives a linked record's title only where the acting member may read the record", async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await seedIssue(db, team.id, 1);
    await db.delete(schema.chatChannels);
    await db.insert(schema.chatChannels).values([
      { id: 'chc_across_open', name: 'General', slug: 'general', type: 'public' },
      { id: 'chc_across_closed', name: 'Acquisition', slug: 'acquisition', type: 'private' },
    ]);
    await db.insert(schema.mergeRecordLinks).values([
      { id: 'mrk_across_1', issueId: issue.id, recordType: 'chat_channel', recordId: 'chc_across_open', title: 'General' },
      { id: 'mrk_across_2', issueId: issue.id, recordType: 'chat_channel', recordId: 'chc_across_closed', title: 'Acquisition' },
    ]);
    const detail = await tool('user_viewer', 'merge_get_issue', { issue: 'PLAT-1' });
    const titles = Object.fromEntries(detail.result.recordLinks.map((l: { recordId: string; title: string | null }) => [l.recordId, l.title]));
    // A private channel the member is not in stays nameless.
    expect(titles).toEqual({ chc_across_open: 'General', chc_across_closed: null });
    await db.delete(schema.chatChannels);
  });

  it('writes as the acting member and marks its events as the agent’s', async () => {
    const team = await seedTeam(db, 'PLAT');
    clearEvents();
    const created = await tool('user_member', 'merge_create_issue', { teamId: team.id, title: 'From an agent' });
    expect(created.ok).toBe(true);
    expect(created.result.key).toBe('PLAT-1');
    expect(eventLog()).toEqual(['merge_issue:created']);
    expect(events[0]!.data).toMatchObject({ triggeredByAgentId: 'agt_1' });
    expect(events[0]!.metadata.userId).toBe('user_member');

    const commented = await tool('user_member', 'merge_comment_on_issue', { issue: 'PLAT-1', body: 'Done' });
    expect(commented.result).toMatchObject({ body: 'Done', authorUserId: 'user_member' });
  });

  it('assigning an agent also publishes merge_issue:agent_assigned', async () => {
    await db.delete(schema.weldagentAgents);
    await db.insert(schema.weldagentAgents).values({ id: 'agt_2', name: 'Triage', status: 'active', visibility: 'workspace' });
    const team = await seedTeam(db, 'PLAT');
    await seedIssue(db, team.id, 5);
    clearEvents();
    const updated = await tool('user_member', 'merge_update_issue', { issue: 'PLAT-5', agentId: 'agt_2', status: 'in_progress' });
    expect(updated.ok).toBe(true);
    expect(eventLog()).toEqual(['merge_issue:updated', 'merge_issue:agent_assigned']);
    const [row] = await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.agentId, 'agt_2'));
    expect(row).toMatchObject({ status: 'in_progress' });
  });

  it('refuses to assign an agent the acting member cannot use, and writes nothing', async () => {
    await db.delete(schema.weldagentAgents);
    await db.insert(schema.weldagentAgents).values({ id: 'agt_secret', name: 'Secret', status: 'active', visibility: 'private', ownerId: 'user_owner' });
    const team = await seedTeam(db, 'PLAT');
    await seedIssue(db, team.id, 6);
    clearEvents();
    for (const agentId of ['agt_secret', 'agt_unknown']) {
      const result = await tool('user_member', 'merge_update_issue', { issue: 'PLAT-6', agentId, status: 'in_progress' });
      expect(result.ok, agentId).toBe(false);
      expect(result.error, agentId).toContain('cannot use it');
      const outcome = await action('user_member', 'merge.update_issue', { issue: 'PLAT-6', agentId });
      expect(outcome.ok, agentId).toBe(false);
      expect(outcome.error, agentId).toContain('cannot use it');
    }
    const [row] = await db.select().from(schema.mergeIssues);
    expect(row).toMatchObject({ agentId: null, status: 'backlog' });
    expect(events).toHaveLength(0);
  });

  it('refuses a member without the permission and writes nothing', async () => {
    const team = await seedTeam(db, 'PLAT');
    await seedIssue(db, team.id, 1);
    clearEvents();
    const result = await tool('user_viewer', 'merge_update_issue', { issue: 'PLAT-1', status: 'done' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('merge_issues:update');
    expect((await db.select().from(schema.mergeIssues))[0]!.status).toBe('backlog');
    expect(events).toHaveLength(0);

    const pr = await tool('user_viewer', 'merge_open_draft_pull_request', {
      repositoryId: 'mrp_1',
      title: 't',
      branch: 'b',
      commitMessage: 'm',
      files: [{ path: 'a.txt', content: 'x' }],
    });
    expect(pr.error).toContain('merge_pull_requests:review');
  });

  it('rejects input the tool would not take', async () => {
    const result = await tool('user_member', 'merge_create_issue', { title: 'No team' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('teamId');
  });

  it('lists and reads pull requests', async () => {
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const pr = await seedPullRequest(db, repo.id, 12, { title: 'Fix tabs', headRef: 'plat-1-fix-tabs' });

    const listed = await tool('user_viewer', 'merge_list_pull_requests', { q: '#12' });
    expect(listed.result.pullRequests.map((p: { id: string }) => p.id)).toEqual([pr.id]);

    const detail = await tool('user_viewer', 'merge_get_pull_request', { pullRequestId: pr.id });
    expect(detail.result).toMatchObject({ id: pr.id, number: 12, title: 'Fix tabs' });
    expect((await tool('user_viewer', 'merge_get_pull_request', { pullRequestId: 'mpr_nope' })).ok).toBe(false);
  });
});

describe('merge_open_draft_pull_request', () => {
  const files = [
    { path: 'src/a.ts', content: 'export const a = 1;\n' },
    { path: 'README.md', content: '# hi\n' },
  ];

  function stubGitData() {
    return stubGithub({
      'GET /repos/acme/web/git/ref/heads/main': { object: { sha: 'base_sha' } },
      'GET /repos/acme/web/git/commits/base_sha': { tree: { sha: 'base_tree' } },
      'POST /repos/acme/web/git/blobs': { sha: 'blob_sha' },
      'POST /repos/acme/web/git/trees': { sha: 'tree_sha' },
      'POST /repos/acme/web/git/commits': { sha: 'commit_sha' },
      'POST /repos/acme/web/git/refs': { ref: 'refs/heads/agent/plat-1' },
      'POST /repos/acme/web/pulls': { number: 77, html_url: 'https://github.com/acme/web/pull/77' },
    });
  }

  it('commits the files to a new branch and opens a draft pull request', async () => {
    const connection = await seedConnection(db, { externalAccountId: '4242' });
    const repo = await seedRepository(db, connection.id);
    const calls = stubGitData();

    const result = await tool('user_member', 'merge_open_draft_pull_request', {
      repositoryId: repo.id,
      title: 'Fix tabs',
      body: 'Closes the tab bug',
      branch: 'agent/plat-1',
      commitMessage: 'Fix tabs',
      files,
      issueKey: 'PLAT-1',
    });
    expect(result).toEqual({
      ok: true,
      result: { number: 77, url: 'https://github.com/acme/web/pull/77', branch: 'agent/plat-1', baseBranch: 'main', draft: true },
      error: null,
    });
    expect(calls).toEqual(
      perRun([
        { method: 'GET', url: '/repos/acme/web/git/ref/heads/main' },
        { method: 'GET', url: '/repos/acme/web/git/commits/base_sha' },
        { method: 'POST', url: '/repos/acme/web/git/blobs' },
        { method: 'POST', url: '/repos/acme/web/git/blobs' },
        { method: 'POST', url: '/repos/acme/web/git/trees' },
        { method: 'POST', url: '/repos/acme/web/git/commits' },
        { method: 'POST', url: '/repos/acme/web/git/refs' },
        { method: 'POST', url: '/repos/acme/web/pulls' },
      ]),
    );
  });

  it('refuses a repository that is not GitHub, a bad branch name and a GitHub failure', async () => {
    const connection = await seedConnection(db, { externalAccountId: '4242' });
    const github = await seedRepository(db, connection.id);
    const gitlab = await seedRepository(db, connection.id, { provider: 'gitlab', externalId: '901', fullName: 'acme/api' });
    const base = { title: 't', branch: 'agent/x', commitMessage: 'm', files };

    expect((await tool('user_member', 'merge_open_draft_pull_request', { ...base, repositoryId: gitlab.id })).error).toContain('only supported for GitHub');
    expect((await tool('user_member', 'merge_open_draft_pull_request', { ...base, repositoryId: 'mrp_nope' })).error).toContain('was not found');

    stubGitData();
    expect((await tool('user_member', 'merge_open_draft_pull_request', { ...base, repositoryId: github.id, branch: 'bad..name' })).error).toContain('not a usable branch name');

    stubGithub({});
    const failed = await tool('user_member', 'merge_open_draft_pull_request', { ...base, repositoryId: github.id });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('GitHub answered 404');
  });
});
