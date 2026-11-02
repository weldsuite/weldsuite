/**
 * Parity fixtures for the Rust port of this worker's GitHub Workflows
 * (`rust/modules/integrations`, the `integrations.github-project-sync` and
 * `integrations.github-project-outbound` jobs), written by the TypeScript
 * Workflows themselves.
 *
 * Each scenario seeds the tenant database (pglite, the real schema) with
 * SQL, runs the Workflow's `run()` with a `step` that runs each step once,
 * and answers GitHub from a deterministic stub. It records the steps taken,
 * the error a run ended with, every GitHub call with its answer, and the
 * rows left. `rust/modules/integrations/tests/github_jobs_parity.rs` runs the
 * same SQL on Postgres, runs the Rust job with the recorded answers (matched
 * by method, URL and body) and compares.
 *
 *   pnpm rust:integration-fixtures                    write the fixtures
 *   pnpm --filter integration-webhook-worker test     fails when they are stale
 *
 * Generated ids (`tsk_…`, `ghsm_…`) and times written now are placeholders;
 * seeded times and GitHub's (2026-10-0x) stay.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb, pgliteClientOf } from '@weldsuite/worker-kit/testing/pglite';

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getTenantDbForWorkspace: async () => holder.db,
}));

import { GithubProjectSyncWorkflow } from '../workflows/github-project-sync';
import { GithubProjectOutboundSyncWorkflow } from '../workflows/github-project-outbound';

const OUT = path.resolve(import.meta.dirname, '../../../../../rust/modules/integrations/tests/fixtures/github_jobs.json');
const WRITE = process.env.WRITE_RUST_FIXTURES === '1';
const ORG = 'org_gh';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const SEEDED = /^2026-10-0\d/;
const GENERATED = /^(tsk|ghsm)_[0-9a-z]{14,}$/;

function normalise(value: unknown): Json {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => normalise(item));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value).sort()) out[k] = normalise((value as Record<string, unknown>)[k]);
    return out;
  }
  if (typeof value === 'string') {
    if (GENERATED.test(value)) return `<id:${value.split('_')[0]}>`;
    if (ISO.test(value) && !SEEDED.test(value)) return '<ts>';
  }
  return value as Json;
}

const CLEAR = [
  'delete from github_issue_sync_map',
  'delete from github_project_links',
  'delete from github_connections',
  "delete from tasks where project_id like 'prj_%'",
  "delete from project_pipeline_stages where project_id like 'prj_%'",
];

const T0 = "'2026-10-01 09:00:00'";

function connection(id: string, installation: number, status = 'active') {
  return `insert into github_connections (id, workspace_id, installation_id, app_slug, owner_type, owner_login, status, created_at, updated_at)
    values ('${id}', '${ORG}', ${installation}, 'weldsuite', 'Organization', 'acme', '${status}', ${T0}, ${T0})`;
}

function link(id: string, connectionId: string, project: string, opts: { direction?: string; repo?: string | null; syncIssues?: boolean; field?: string | null } = {}) {
  const map = JSON.stringify([
    { githubOptionId: 'opt_todo', githubOptionName: 'Todo', stageId: `stg_${project}_todo` },
    { githubOptionId: 'opt_done', githubOptionName: 'Done', stageId: `stg_${project}_done` },
  ]);
  const repo = opts.repo === undefined ? "'acme/app'" : opts.repo === null ? 'null' : `'${opts.repo}'`;
  const field = opts.field === undefined ? "'PVTSSF_status'" : opts.field === null ? 'null' : `'${opts.field}'`;
  return `insert into github_project_links (id, workspace_id, connection_id, project_id, project_v2_node_id, project_v2_number, owner_type, owner_login,
      repo_full_name, status_field_id, status_option_map, sync_issues, sync_direction, created_at, updated_at)
    values ('${id}', '${ORG}', '${connectionId}', '${project}', 'PVT_${id}', 1, 'Organization', 'acme', ${repo}, ${field}, '${map}'::jsonb,
      ${opts.syncIssues ?? true}, '${opts.direction ?? 'bidirectional'}', ${T0}, ${T0})`;
}

function stages(project: string) {
  return `insert into project_pipeline_stages (id, project_id, name, position, system_status, created_at, updated_at) values
    ('stg_${project}_done', '${project}', 'Done', 2, 'done', ${T0}, ${T0}),
    ('stg_${project}_todo', '${project}', 'Todo', 0, 'todo', ${T0}, ${T0}),
    ('stg_${project}_doing', '${project}', 'Doing', 1, 'in_progress', ${T0}, ${T0})`;
}

function task(id: string, project: string, opts: { status?: string; stage?: string | null; issue?: number | null; updated?: string; labels?: string[] } = {}) {
  const stage = opts.stage ? `'${opts.stage}'` : 'null';
  const issue = opts.issue == null ? 'null' : String(opts.issue);
  const labels = opts.labels ? `'${JSON.stringify(opts.labels)}'::jsonb` : 'null';
  const updated = opts.updated ? `'${opts.updated}'` : T0;
  return `insert into tasks (id, title, description, status, stage_id, project_id, github_issue_number, labels, created_at, updated_at)
    values ('${id}', 'Task ${id}', 'About ${id}', '${opts.status ?? 'todo'}', ${stage}, '${project}', ${issue}, ${labels}, ${T0}, ${updated})`;
}

function syncMap(id: string, linkId: string, taskId: string, item: string, opts: { issueNode?: string | null; number?: number; task?: string; issueAt?: string } = {}) {
  const node = opts.issueNode === null ? 'null' : `'${opts.issueNode ?? `I_${item}`}'`;
  return `insert into github_issue_sync_map (id, workspace_id, project_link_id, task_id, project_item_node_id, issue_node_id, issue_number, repo_id,
      last_synced_task_updated_at, last_synced_issue_updated_at, last_writer_side, created_at, updated_at)
    values ('${id}', '${ORG}', '${linkId}', '${taskId}', '${item}', ${node}, ${opts.number ?? 1}, 99,
      '${opts.task ?? '2026-10-01 09:00:00'}', '${opts.issueAt ?? '2026-10-01 09:00:00'}', 'issue', ${T0}, ${T0})`;
}

interface IssueContent {
  id: string;
  number: number;
  title: string;
  body?: string | null;
  state?: 'OPEN' | 'CLOSED';
  stateReason?: string | null;
  updatedAt: string;
  labels?: string[];
}

function itemNode(itemId: string, content: IssueContent | { __typename: string } | null, option?: string) {
  const isIssue = content && 'number' in content;
  return {
    id: itemId,
    fieldValueByName: option ? { optionId: option, name: option } : null,
    content: isIssue
      ? {
          __typename: 'Issue',
          id: content.id,
          number: content.number,
          title: content.title,
          body: content.body ?? null,
          state: content.state ?? 'OPEN',
          stateReason: content.stateReason ?? null,
          updatedAt: content.updatedAt,
          url: `https://github.com/acme/app/issues/${content.number}`,
          labels: { nodes: (content.labels ?? []).map((name) => ({ name })) },
          repository: { databaseId: 99, nameWithOwner: 'acme/app' },
        }
      : content,
  };
}

interface Scenario {
  name: string;
  job: 'sync' | 'outbound';
  payload: Record<string, unknown>;
  seed: string[];
  /** Items pages by cursor (`''` for the first), for the stub. */
  pages?: Record<string, { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null } | null>;
  /** GraphQL mutations that answer with errors, by operation. */
  failing?: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'sync: pulls the board (two pages), prunes, then creates and re-statuses outbound',
    job: 'sync',
    payload: { workspaceId: ORG, projectLinkId: 'ghpl_a' },
    seed: [
      connection('ghc_a', 1001),
      link('ghpl_a', 'ghc_a', 'prj_a'),
      stages('prj_a'),
      task('tsk_mapped', 'prj_a', { status: 'todo' }),
      task('tsk_stale', 'prj_a'),
      task('tsk_new_done', 'prj_a', { status: 'done', labels: ['bug', 'ui'] }),
      task('tsk_staged', 'prj_a', { stage: 'stg_prj_a_todo' }),
      task('tsk_pushed', 'prj_a', { issue: 12 }),
      task('tsk_on_board', 'prj_a', { status: 'done' }),
      syncMap('ghsm_mapped', 'ghpl_a', 'tsk_mapped', 'PVTI_mapped', { number: 3 }),
      syncMap('ghsm_stale', 'ghpl_a', 'tsk_stale', 'PVTI_gone', { number: 4 }),
      syncMap('ghsm_board', 'ghpl_a', 'tsk_on_board', 'PVTI_board', { number: 5 }),
    ],
    pages: {
      '': {
        nodes: [
          itemNode('PVTI_mapped', { id: 'I_PVTI_mapped', number: 3, title: 'Renamed on GitHub', body: 'New body', updatedAt: '2026-10-05T10:00:00Z', labels: ['p1'] }, 'opt_done'),
          itemNode('PVTI_new', { id: 'I_new', number: 21, title: 'Fresh issue', updatedAt: '2026-10-04T08:00:00Z', state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
          itemNode('PVTI_draft', { __typename: 'DraftIssue' }),
        ],
        hasNextPage: true,
        endCursor: 'cursor-2',
      },
      'cursor-2': {
        nodes: [
          itemNode('PVTI_board', { id: 'I_PVTI_board', number: 5, title: 'Task tsk_on_board', updatedAt: '2026-10-01T09:00:00Z' }, 'opt_todo'),
          itemNode('PVTI_empty', null),
        ],
        hasNextPage: false,
        endCursor: null,
      },
    },
  },
  {
    name: 'sync: a conflict goes to the newer side; an unmapped task is left alone when its issue did not change',
    job: 'sync',
    payload: { workspaceId: ORG, projectLinkId: 'ghpl_c', inboundOnly: true },
    seed: [
      connection('ghc_c', 1002),
      link('ghpl_c', 'ghc_c', 'prj_c'),
      stages('prj_c'),
      task('tsk_task_newer', 'prj_c', { updated: '2026-10-06 12:00:00' }),
      task('tsk_issue_newer', 'prj_c', { updated: '2026-10-03 12:00:00' }),
      task('tsk_quiet_issue', 'prj_c', { updated: '2026-10-03 12:00:00' }),
      syncMap('ghsm_tn', 'ghpl_c', 'tsk_task_newer', 'PVTI_tn', { number: 31 }),
      syncMap('ghsm_in', 'ghpl_c', 'tsk_issue_newer', 'PVTI_in', { number: 32 }),
      syncMap('ghsm_q', 'ghpl_c', 'tsk_quiet_issue', 'PVTI_q', { number: 33, issueAt: '2026-10-05 10:00:00' }),
      syncMap('ghsm_orphan', 'ghpl_c', 'tsk_missing', 'PVTI_orphan', { number: 34 }),
    ],
    pages: {
      '': {
        nodes: [
          itemNode('PVTI_tn', { id: 'I_tn', number: 31, title: 'GitHub title tn', updatedAt: '2026-10-05T10:00:00Z' }),
          itemNode('PVTI_in', { id: 'I_in', number: 32, title: 'GitHub title in', updatedAt: '2026-10-05T10:00:00Z' }, 'opt_todo'),
          itemNode('PVTI_q', { id: 'I_q', number: 33, title: 'GitHub title q', updatedAt: '2026-10-05T10:00:00Z' }),
          itemNode('PVTI_orphan', { id: 'I_orphan', number: 34, title: 'Orphan', updatedAt: '2026-10-05T10:00:00Z' }),
        ],
        hasNextPage: false,
        endCursor: null,
      },
    },
  },
  {
    name: 'sync: a link with issue sync off does nothing after loading',
    job: 'sync',
    payload: { workspaceId: ORG, projectLinkId: 'ghpl_off' },
    seed: [connection('ghc_off', 1003), link('ghpl_off', 'ghc_off', 'prj_off', { syncIssues: false })],
  },
  {
    name: 'sync: an outbound-only link without a repository skips both passes',
    job: 'sync',
    payload: { workspaceId: ORG, projectLinkId: 'ghpl_norepo' },
    seed: [connection('ghc_nr', 1004), link('ghpl_norepo', 'ghc_nr', 'prj_nr', { direction: 'outbound', repo: null }), task('tsk_nr', 'prj_nr')],
  },
  {
    name: 'sync: an unreadable project (node null) is an empty pull',
    job: 'sync',
    payload: { workspaceId: ORG, projectLinkId: 'ghpl_null' },
    seed: [connection('ghc_null', 1005), link('ghpl_null', 'ghc_null', 'prj_null', { direction: 'inbound' })],
    pages: { '': null },
  },
  {
    name: 'sync: an unknown link fails the run',
    job: 'sync',
    payload: { workspaceId: ORG, projectLinkId: 'ghpl_missing' },
    seed: [connection('ghc_m', 1006)],
  },
  {
    name: 'sync: a suspended connection fails the run',
    job: 'sync',
    payload: { workspaceId: ORG, projectLinkId: 'ghpl_s' },
    seed: [connection('ghc_s', 1007, 'suspended'), link('ghpl_s', 'ghc_s', 'prj_s')],
  },
  {
    name: 'outbound: create through the project link, on the board with its status',
    job: 'outbound',
    payload: { workspaceId: ORG, taskId: 'tsk_create', kind: 'create' },
    seed: [connection('ghc_o', 2001), link('ghpl_o', 'ghc_o', 'prj_o'), stages('prj_o'), task('tsk_create', 'prj_o', { status: 'done', labels: ['ops'] })],
  },
  {
    name: 'outbound: update pushes the title and body of a mapped task',
    job: 'outbound',
    payload: { workspaceId: ORG, taskId: 'tsk_upd', kind: 'update' },
    seed: [connection('ghc_u', 2002), link('ghpl_u', 'ghc_u', 'prj_u'), stages('prj_u'), task('tsk_upd', 'prj_u', { stage: 'stg_prj_u_done' }), syncMap('ghsm_u', 'ghpl_u', 'tsk_upd', 'PVTI_u', { number: 41 })],
  },
  {
    name: 'outbound: status done closes the issue',
    job: 'outbound',
    payload: { workspaceId: ORG, taskId: 'tsk_st', kind: 'status' },
    seed: [connection('ghc_st', 2003), link('ghpl_st', 'ghc_st', 'prj_st'), stages('prj_st'), task('tsk_st', 'prj_st', { status: 'done' }), syncMap('ghsm_st', 'ghpl_st', 'tsk_st', 'PVTI_st', { number: 42 })],
  },
  {
    name: 'outbound: status in progress reopens; a refused reopen is skipped',
    job: 'outbound',
    payload: { workspaceId: ORG, taskId: 'tsk_re', kind: 'status' },
    seed: [connection('ghc_re', 2004), link('ghpl_re', 'ghc_re', 'prj_re'), stages('prj_re'), task('tsk_re', 'prj_re', { status: 'in_progress' }), syncMap('ghsm_re', 'ghpl_re', 'tsk_re', 'PVTI_re', { number: 43 })],
    failing: ['reopenIssue'],
  },
  {
    name: 'outbound: delete closes the issue as not planned',
    job: 'outbound',
    payload: { workspaceId: ORG, taskId: 'tsk_del', kind: 'delete' },
    seed: [connection('ghc_d', 2005), link('ghpl_d', 'ghc_d', 'prj_d'), task('tsk_del', 'prj_d'), syncMap('ghsm_d', 'ghpl_d', 'tsk_del', 'PVTI_d', { number: 44 })],
  },
  {
    name: 'outbound: an unmapped task is skipped for an update; an inbound link is a no-op',
    job: 'outbound',
    payload: { workspaceId: ORG, taskId: 'tsk_un', kind: 'update' },
    seed: [connection('ghc_un', 2006), link('ghpl_un', 'ghc_un', 'prj_un'), task('tsk_un', 'prj_un')],
  },
  {
    name: 'outbound: a create on an inbound link is a no-op',
    job: 'outbound',
    payload: { workspaceId: ORG, taskId: 'tsk_in', kind: 'create', projectLinkId: 'ghpl_in' },
    seed: [connection('ghc_in', 2007), link('ghpl_in', 'ghc_in', 'prj_in', { direction: 'inbound' }), task('tsk_in', 'prj_in')],
  },
  {
    name: 'outbound: a missing task fails the run',
    job: 'outbound',
    payload: { workspaceId: ORG, taskId: 'tsk_none', kind: 'status' },
    seed: [connection('ghc_none', 2008)],
  },
];

interface Exchange {
  method: string;
  url: string;
  body: unknown;
  status: number;
  response: unknown;
}

let issueCounter = 0;

function githubAnswer(scenario: Scenario, method: string, url: string, body: Record<string, unknown> | null): { status: number; response: unknown } {
  const installation = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
  if (installation) return { status: 201, response: { token: `ghs_${installation[1]}`, expires_at: '2099-01-01T00:00:00Z' } };
  const repo = /\/repos\/(.+)\/issues$/.exec(url);
  if (repo) {
    issueCounter += 1;
    return { status: 201, response: { number: 100 + issueCounter, node_id: `I_created_${issueCounter}`, updated_at: '2026-10-08T10:00:00Z', html_url: 'x', state: 'open' } };
  }
  if (url === 'https://api.github.com/graphql' && body) {
    const query = String(body.query);
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    if (query.includes('items(first: 100')) {
      const page = scenario.pages?.[String(variables.cursor ?? '')];
      if (page === null || page === undefined) return { status: 200, response: { data: { node: null } } };
      return { status: 200, response: { data: { node: { items: { nodes: page.nodes, pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor } } } } } };
    }
    for (const op of ['updateIssue', 'closeIssue', 'reopenIssue']) {
      if (query.includes(`${op}(input`)) {
        if (scenario.failing?.includes(op)) return { status: 200, response: { errors: [{ message: `${op} refused` }] } };
        return { status: 200, response: { data: { [op]: { issue: { updatedAt: '2026-10-09T10:00:00Z' } } } } };
      }
    }
    if (query.includes('addProjectV2ItemById')) {
      return { status: 200, response: { data: { addProjectV2ItemById: { item: { id: `PVTI_for_${String(variables.contentId)}` } } } } };
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      return { status: 200, response: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } } } };
    }
  }
  return { status: 404, response: { message: 'Not Found' } };
}

let client: NonNullable<ReturnType<typeof pgliteClientOf>>;
let privateKey: string;

beforeAll(async () => {
  const handle = await createPgliteDb();
  holder.db = handle.db;
  client = pgliteClientOf(handle.db)!;
  privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

async function dump(): Promise<Record<string, Json[]>> {
  const out: Record<string, Json[]> = {};
  for (const [table, where] of [
    ['tasks', "project_id like 'prj_%'"],
    ['github_issue_sync_map', 'true'],
    ['github_project_links', 'true'],
    ['github_connections', 'true'],
  ] as const) {
    const { rows } = (await client.query(`select to_jsonb(t) as row from ${table} t where ${where}`)) as { rows: Array<{ row: unknown }> };
    out[table] = rows.map((r) => normalise(r.row)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return out;
}

async function run(scenario: Scenario) {
  for (const statement of [...CLEAR, ...scenario.seed]) await client.exec(statement);
  issueCounter = 0;
  const exchanges: Exchange[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const answer = githubAnswer(scenario, method, url, body);
    exchanges.push({ method, url, body, ...answer });
    return new Response(JSON.stringify(answer.response), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  });
  const steps: string[] = [];
  const step = {
    do: async (name: string, ...rest: unknown[]) => {
      steps.push(name);
      const fn = rest[rest.length - 1] as () => Promise<unknown>;
      return fn();
    },
    sleep: async () => undefined,
  };
  const env = { GITHUB_APP_ID: '424242', GITHUB_APP_PRIVATE_KEY: privateKey };
  const Workflow = scenario.job === 'sync' ? GithubProjectSyncWorkflow : GithubProjectOutboundSyncWorkflow;
  const workflow = new Workflow({} as never, env as never);
  let error: string | null = null;
  try {
    await (workflow.run as (event: unknown, step: unknown) => Promise<void>)({ payload: scenario.payload, timestamp: new Date(), instanceId: 'i' }, step);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  vi.unstubAllGlobals();
  return {
    name: scenario.name,
    job: scenario.job,
    payload: scenario.payload,
    seed: scenario.seed,
    steps,
    error,
    exchanges,
    rows: await dump(),
  };
}

describe('Rust parity fixtures', () => {
  it('GitHub project sync and outbound jobs', async () => {
    const outcomes = [];
    for (const scenario of SCENARIOS) outcomes.push(await run(scenario));
    const text = `${JSON.stringify(outcomes, null, 2)}\n`;
    if (WRITE) {
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(OUT, text);
      return;
    }
    expect(existsSync(OUT), `${OUT} is missing: run pnpm rust:integration-fixtures`).toBe(true);
    expect(JSON.parse(readFileSync(OUT, 'utf8')), 'stale fixtures: run pnpm rust:integration-fixtures').toEqual(JSON.parse(text));
  }, 120_000);
});
