/**
 * The project sub-resource routes the other test files reach only partly:
 * sprints, milestones, goals, whiteboards, project files and folders,
 * project messages, project documents and sheets, document versions and
 * pipeline stages, each read, write and refusal. Runs against the TypeScript
 * worker and, in conformance mode, the Rust backend
 * (rust/conformance/suites.json).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';
import { sprintsRoutes } from './sprints';
import { milestonesRoutes } from './milestones';
import { goalsRoutes } from './goals';
import { whiteboardsRoutes } from './whiteboards';
import { projectFilesRoutes } from './project-files';
import { projectMessagesRoutes } from './project-messages';
import { projectDocumentsRoutes } from './project-documents';
import { projectSheetsRoutes } from './project-sheets';
import { documentsRoutes } from './documents';
import { projectPipelineStagesRoutes } from './project-pipeline-stages';

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/sprints', sprintsRoutes);
router.route('/milestones', milestonesRoutes);
router.route('/goals', goalsRoutes);
router.route('/whiteboards', whiteboardsRoutes);
router.route('/project-files', projectFilesRoutes);
router.route('/project-messages', projectMessagesRoutes);
router.route('/project-documents', projectDocumentsRoutes);
router.route('/project-sheets', projectSheetsRoutes);
router.route('/documents', documentsRoutes);
router.route('/project-pipeline-stages', projectPipelineStagesRoutes);

const PROJECT = 'prj_cv_main';
const OTHER = 'prj_cv_other';
const OWNER = 'user_cv_owner';
const MEMBER = 'user_cv_member';
const OUTSIDER = 'user_cv_outsider';

const ALL = [
  'projects:read',
  'projects:create',
  'projects:update',
  'projects:delete',
  'milestones:read',
  'milestones:create',
  'milestones:update',
  'milestones:delete',
  'files:read',
  'files:create',
  'files:update',
  'files:delete',
  'tasks:read',
];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = ALL): Send {
  const { request } = createTestApp('/api', router, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date('2026-04-01T08:00:00.000Z');
  await db.insert(schema.projects).values([
    { id: PROJECT, name: 'Coverage main', projectManagerId: OWNER, createdAt: at, updatedAt: at },
    { id: OTHER, name: 'Coverage other', projectManagerId: OWNER, createdAt: at, updatedAt: at },
  ]);
  await db.insert(schema.projectMembers).values({
    id: 'pm_cv_member',
    projectId: PROJECT,
    userId: MEMBER,
    role: 'member',
    isActive: true,
    createdAt: at,
    updatedAt: at,
    joinedAt: at,
  });
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_cv_owner', userId: OWNER, name: 'Olga Owner', email: 'olga@example.com', role: 'OWNER' },
    { id: 'wm_cv_member', userId: MEMBER, name: 'Mo Member', email: 'mo@example.com', role: 'MEMBER' },
  ]);
}, 60_000);

describe('sprints', () => {
  it('lists, reads and deletes a sprint; refuses outsiders', async () => {
    const owner = as(OWNER);
    const created = await owner('POST', '/sprints', { name: 'Sprint one', projectId: PROJECT });
    expect(created.status).toBe(201);
    const { id } = await data<{ id: string }>(created);
    await owner('POST', '/sprints', { name: 'Sprint two', projectId: PROJECT, status: 'active' });

    const page = await owner('GET', `/sprints?projectId=${PROJECT}&limit=1`);
    expect(page.status).toBe(200);
    const body = (await page.json()) as { data: unknown[]; pagination: { cursor: string | null } };
    expect(body.data).toHaveLength(1);
    const next = await owner('GET', `/sprints?projectId=${PROJECT}&limit=1&cursor=${body.pagination.cursor}`);
    expect(next.status).toBe(200);
    expect((await owner('GET', '/sprints?search=sprint')).status).toBe(200);
    expect((await as(MEMBER)('GET', '/sprints')).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/sprints?projectId=${PROJECT}`)).status).toBe(403);

    expect((await owner('GET', `/sprints/${id}`)).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/sprints/${id}`)).status).toBe(403);
    expect((await owner('GET', '/sprints/spr_missing')).status).toBe(404);
    expect((await owner('PATCH', `/sprints/${id}`, { status: 'completed' })).status).toBe(200);
    expect((await owner('PATCH', `/sprints/${id}`, { startDate: 'not a date' })).status).toBe(400);
    expect((await owner('DELETE', `/sprints/${id}`)).status).toBe(204);
    expect((await owner('DELETE', `/sprints/${id}`)).status).toBe(404);
  });
});

describe('milestones', () => {
  it('lists with a cursor, reads and deletes a milestone', async () => {
    const owner = as(OWNER);
    const first = await owner('POST', '/milestones', { name: 'M1', projectId: PROJECT, dueDate: '2030-01-01' });
    expect(first.status).toBe(201);
    const { id } = await data<{ id: string }>(first);
    await owner('POST', '/milestones', { name: 'M2', projectId: PROJECT, dueDate: '2030-02-01', status: 'completed' });

    const page = await owner('GET', `/milestones?projectId=${PROJECT}&limit=1`);
    const body = (await page.json()) as { pagination: { cursor: string | null } };
    expect((await owner('GET', `/milestones?projectId=${PROJECT}&limit=1&cursor=${body.pagination.cursor}`)).status).toBe(200);
    expect((await owner('GET', '/milestones?cursor=ms_unknown&status=pending')).status).toBe(200);
    expect((await owner('GET', `/milestones/${id}`)).status).toBe(200);
    expect((await owner('POST', '/milestones', { name: 'No project', dueDate: '2030-01-01' })).status).toBe(400);
    expect((await owner('POST', '/milestones', { name: 'No date', projectId: PROJECT })).status).toBe(400);
    expect((await owner('DELETE', `/milestones/${id}`)).status).toBe(204);
    expect((await owner('DELETE', `/milestones/${id}`)).status).toBe(404);
  });
});

describe('goals', () => {
  it('lists, reads, patches and deletes the canvas row', async () => {
    const owner = as(OWNER);
    const created = await owner('POST', '/goals', { projectId: PROJECT, title: 'Grow', dueDate: '2030-06-30' });
    expect(created.status).toBe(201);
    const { id } = await data<{ id: string }>(created);

    expect((await owner('GET', '/goals')).status).toBe(200);
    expect((await owner('GET', `/goals?projectId=${PROJECT}`)).status).toBe(200);
    expect((await as(MEMBER)('GET', '/goals?cursor=goal_unknown')).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/goals?projectId=${PROJECT}`)).status).toBe(403);
    expect((await owner('GET', `/goals/${id}`)).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/goals/${id}`)).status).toBe(403);
    expect((await owner('GET', '/goals/goal_missing')).status).toBe(404);
    expect((await owner('PATCH', `/goals/${id}`, { mission: null, goals: [] })).status).toBe(200);
    expect((await owner('POST', '/goals', { projectId: PROJECT, status: 'sideways' })).status).toBe(400);
    expect((await owner('DELETE', `/goals/${id}`)).status).toBe(204);
    expect((await owner('DELETE', `/goals/${id}`)).status).toBe(404);
  });
});

describe('whiteboards', () => {
  it('creates, lists, reads, edits and deletes a whiteboard', async () => {
    const owner = as(OWNER);
    const created = await owner('POST', '/whiteboards', { projectId: PROJECT, name: 'Board', elements: [{ id: 'e1' }] });
    expect(created.status).toBe(201);
    const { id } = await data<{ id: string }>(created);
    await owner('POST', '/whiteboards', { projectId: PROJECT });

    const page = await owner('GET', `/whiteboards?projectId=${PROJECT}&limit=1`);
    const body = (await page.json()) as { pagination: { cursor: string | null } };
    expect((await owner('GET', `/whiteboards?projectId=${PROJECT}&limit=1&cursor=${body.pagination.cursor}`)).status).toBe(200);
    expect((await owner('GET', '/whiteboards?search=board&cursor=pwb_unknown')).status).toBe(200);
    expect((await owner('GET', `/whiteboards/${id}`)).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/whiteboards/${id}`)).status).toBe(403);
    expect((await owner('GET', '/whiteboards/pwb_missing')).status).toBe(404);
    expect((await owner('PATCH', `/whiteboards/${id}`, { name: 'Renamed', elements: [] })).status).toBe(200);
    expect((await as(MEMBER)('PATCH', `/whiteboards/${id}`, { name: 'By a member' })).status).toBe(200);
    expect((await owner('DELETE', `/whiteboards/${id}`)).status).toBe(204);
    expect((await owner('DELETE', `/whiteboards/${id}`)).status).toBe(404);
  });
});

describe('project files', () => {
  it('creates folders and files, lists, reads and deletes them', async () => {
    const owner = as(OWNER);
    const folder = await owner('POST', '/project-files/folders', { projectId: PROJECT, name: ' Specs ' });
    expect(folder.status).toBe(201);
    const { id: folderId } = await data<{ id: string }>(folder);
    expect((await owner('POST', '/project-files/folders', { projectId: PROJECT, name: 'Lost', parentId: 'pfile_missing' })).status).toBe(404);
    expect((await as(OUTSIDER)('POST', '/project-files/folders', { projectId: PROJECT, name: 'Nope' })).status).toBe(403);

    const file = await owner('POST', '/project-files', {
      projectId: PROJECT,
      fileName: 'plan.txt',
      mimeType: 'text/plain',
      fileSize: 12,
      storagePath: `workspaces/org_test_default/files/project/${PROJECT}/plan.txt`,
      parentId: folderId,
    });
    expect(file.status).toBe(201);
    const { id: fileId } = await data<{ id: string }>(file);

    const page = await owner('GET', `/project-files?projectId=${PROJECT}&limit=1`);
    expect(page.status).toBe(200);
    const body = (await page.json()) as { pagination: { cursor: string | null } };
    expect((await owner('GET', `/project-files?projectId=${PROJECT}&limit=1&cursor=${body.pagination.cursor}`)).status).toBe(200);
    expect((await owner('GET', `/project-files?parentId=${folderId}`)).status).toBe(200);
    expect((await owner('GET', '/project-files?parentId=root&foldersOnly=true&cursor=pfile_unknown')).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/project-files?projectId=${PROJECT}`)).status).toBe(403);
    expect((await owner('GET', `/project-files/${fileId}`)).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/project-files/${fileId}`)).status).toBe(403);
    expect((await owner('GET', '/project-files/pfile_missing')).status).toBe(404);

    expect((await owner('DELETE', `/project-files/${folderId}`)).status).toBe(204);
    expect((await owner('GET', `/project-files/${fileId}`)).status).toBe(404);
    expect((await owner('DELETE', `/project-files/${folderId}`)).status).toBe(404);
  });
});

describe('project messages', () => {
  it('lists, reads, edits, reacts to and deletes a message', async () => {
    const member = as(MEMBER);
    const created = await member('POST', '/project-messages', { projectId: PROJECT, message: 'Hello' });
    expect(created.status).toBe(201);
    const { id } = await data<{ id: string }>(created);

    expect((await member('GET', `/project-messages?projectId=${PROJECT}`)).status).toBe(200);
    expect((await member('GET', '/project-messages?page=1&limit=5')).status).toBe(200);
    expect((await member('GET', '/project-messages?limit=0')).status).toBe(400);
    expect((await as(OUTSIDER)('GET', `/project-messages?projectId=${PROJECT}`)).status).toBe(403);
    expect((await member('GET', `/project-messages/${id}`)).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/project-messages/${id}`)).status).toBe(403);
    expect((await member('GET', '/project-messages/pmsg_missing')).status).toBe(404);
    expect((await member('PATCH', `/project-messages/${id}`, { message: 'Hello again', isPinned: true })).status).toBe(200);
    expect((await as(OWNER)('PATCH', `/project-messages/${id}`, { message: 'Not mine' })).status).toBe(403);
    expect((await member('POST', `/project-messages/${id}/reactions`, { emoji: '👍' })).status).toBe(200);
    expect((await as(OWNER)('POST', `/project-messages/${id}/reactions`, { emoji: '👍' })).status).toBe(200);
    expect((await member('POST', `/project-messages/${id}/reactions`, { emoji: '👍' })).status).toBe(200);
    expect((await member('POST', '/project-messages/pmsg_missing/reactions', { emoji: '👍' })).status).toBe(404);
    expect((await member('DELETE', `/project-messages/${id}`)).status).toBe(204);
  });
});

describe('project documents, sheets and document versions', () => {
  it('lists documents and sheets, and reads a version', async () => {
    const owner = as(OWNER);
    const created = await owner('POST', `/project-documents/${PROJECT}`, { name: 'Spec' });
    expect(created.status).toBe(201);
    const { id: fileId } = await data<{ id: string }>(created);
    expect((await owner('GET', `/project-documents/${PROJECT}`)).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/project-documents/${PROJECT}`)).status).toBe(403);
    expect((await owner('GET', `/project-sheets/${PROJECT}`)).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/project-sheets/${PROJECT}`)).status).toBe(403);

    expect((await owner('PUT', `/documents/${fileId}/content`, { content: [{ type: 'paragraph' }] })).status).toBe(200);
    const versions = await data<Array<{ id: string }>>(await owner('GET', `/documents/${fileId}/versions`));
    expect(versions.length).toBeGreaterThan(0);
    expect((await owner('GET', `/documents/${fileId}/versions/${versions[0]!.id}`)).status).toBe(200);
    expect((await owner('GET', `/documents/${fileId}/versions/docver_missing`)).status).toBe(404);
    expect((await as(OUTSIDER)('GET', `/documents/${fileId}/versions/${versions[0]!.id}`)).status).toBe(403);
  });

  it('creates a drive document, in a folder only where the caller may add files', async () => {
    const owner = as(OWNER);
    const created = await owner('POST', '/documents', { name: 'Notes.docx' });
    expect(created.status).toBe(201);
    expect((await owner('POST', '/documents', { name: 'Lost', folderId: 'fld_missing' })).status).toBe(404);
  });
});

describe('pipeline stages', () => {
  it('reads a stage and reorders the board', async () => {
    const owner = as(OWNER);
    const stages = await data<Array<{ id: string }>>(await owner('GET', `/project-pipeline-stages?projectId=${OTHER}`));
    expect(stages.length).toBeGreaterThan(1);
    expect((await owner('GET', `/project-pipeline-stages/${stages[0]!.id}`)).status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/project-pipeline-stages/${stages[0]!.id}`)).status).toBe(403);
    expect((await owner('GET', '/project-pipeline-stages/stg_missing')).status).toBe(404);
    const reversed = stages.map((s) => s.id).reverse();
    const res = await owner('PATCH', '/project-pipeline-stages/reorder', { stageIds: reversed });
    expect(res.status).toBe(200);
    expect((await owner('PATCH', '/project-pipeline-stages/reorder', { stageIds: [] })).status).toBe(400);
    expect((await owner('GET', '/project-pipeline-stages')).status).toBe(400);
  });
});
