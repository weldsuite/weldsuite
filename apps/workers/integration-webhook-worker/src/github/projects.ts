/**
 * GitHub Projects (v2) service — GraphQL reads/writes + REST issue create, plus
 * status↔stage mapping helpers. Used by the GitHub sync workflows hosted in this
 * worker. Ported from core-api. Web Crypto / fetch only.
 */

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const GITHUB_API_HEADERS_BASE = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'WeldSuite-Integration-Webhooks',
};

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      ...GITHUB_API_HEADERS_BASE,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (resp.status === 429) throw new Error('GitHub secondary rate limit (429) on GraphQL');
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub GraphQL request failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as GraphqlResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) throw new Error('GitHub GraphQL response missing data');
  return json.data;
}

// ── Read: Project items ──────────────────────────────────────

export interface ProjectItemIssue {
  itemNodeId: string;
  statusOptionId: string | null;
  statusOptionName: string | null;
  issueNodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: 'OPEN' | 'CLOSED';
  stateReason: string | null;
  updatedAt: string;
  url: string;
  labels: string[];
  repoId: number | null;
  repoFullName: string | null;
}

interface ProjectItemsGraphqlResult {
  node: {
    items: {
      nodes: Array<{
        id: string;
        fieldValueByName: { optionId: string; name: string } | null;
        content:
          | {
              __typename: string;
              id?: string;
              number?: number;
              title?: string;
              body?: string | null;
              state?: 'OPEN' | 'CLOSED';
              stateReason?: string | null;
              updatedAt?: string;
              url?: string;
              labels?: { nodes: Array<{ name: string }> };
              repository?: { databaseId: number | null; nameWithOwner: string };
            }
          | null;
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } | null;
  } | null;
}

const PROJECT_ITEMS_QUERY = /* GraphQL */ `
  query ($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          nodes {
            id
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue {
                optionId
                name
              }
            }
            content {
              __typename
              ... on Issue {
                id
                number
                title
                body
                state
                stateReason
                updatedAt
                url
                labels(first: 50) { nodes { name } }
                repository { databaseId nameWithOwner }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export async function fetchProjectItemsPage(
  token: string,
  projectNodeId: string,
  cursor: string | null,
): Promise<{ items: ProjectItemIssue[]; hasNextPage: boolean; endCursor: string | null }> {
  const data: ProjectItemsGraphqlResult = await githubGraphql<ProjectItemsGraphqlResult>(
    token,
    PROJECT_ITEMS_QUERY,
    { id: projectNodeId, cursor },
  );

  const connection = data.node?.items;
  if (!connection) {
    console.log(
      `[GithubProjectSync] fetchProjectItemsPage: node is NULL for project ${projectNodeId} ` +
        `(App can't read this Project — check org Projects permission / project ownership)`,
    );
    return { items: [], hasNextPage: false, endCursor: null };
  }

  const typeCounts: Record<string, number> = {};
  for (const node of connection.nodes) {
    const tn = node.content?.__typename ?? 'NULL_CONTENT';
    typeCounts[tn] = (typeCounts[tn] ?? 0) + 1;
  }
  console.log(
    `[GithubProjectSync] project ${projectNodeId}: rawNodes=${connection.nodes.length} types=${JSON.stringify(typeCounts)}`,
  );

  const items: ProjectItemIssue[] = [];
  for (const node of connection.nodes) {
    const content = node.content;
    if (!content || content.__typename !== 'Issue' || content.id == null || content.number == null) {
      continue;
    }
    items.push({
      itemNodeId: node.id,
      statusOptionId: node.fieldValueByName?.optionId ?? null,
      statusOptionName: node.fieldValueByName?.name ?? null,
      issueNodeId: content.id,
      number: content.number,
      title: content.title ?? '',
      body: content.body ?? null,
      state: content.state ?? 'OPEN',
      stateReason: content.stateReason ?? null,
      updatedAt: content.updatedAt ?? new Date(0).toISOString(),
      url: content.url ?? '',
      labels: content.labels?.nodes.map((l) => l.name) ?? [],
      repoId: content.repository?.databaseId ?? null,
      repoFullName: content.repository?.nameWithOwner ?? null,
    });
  }

  return {
    items,
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: connection.pageInfo.endCursor,
  };
}

// ── Write: Project item Status field ─────────────────────────

const UPDATE_ITEM_STATUS_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }
    ) {
      projectV2Item { id }
    }
  }
`;

export async function updateProjectItemStatus(
  token: string,
  projectNodeId: string,
  itemNodeId: string,
  statusFieldId: string,
  optionId: string,
): Promise<void> {
  await githubGraphql(token, UPDATE_ITEM_STATUS_MUTATION, {
    projectId: projectNodeId,
    itemId: itemNodeId,
    fieldId: statusFieldId,
    optionId,
  });
}

const ADD_ITEM_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }
`;

interface AddItemResult {
  addProjectV2ItemById: { item: { id: string } | null } | null;
}

export async function addIssueToProject(
  token: string,
  projectNodeId: string,
  issueNodeId: string,
): Promise<string> {
  const data = await githubGraphql<AddItemResult>(token, ADD_ITEM_MUTATION, {
    projectId: projectNodeId,
    contentId: issueNodeId,
  });
  const id = data.addProjectV2ItemById?.item?.id;
  if (!id) throw new Error('addProjectV2ItemById returned no item id');
  return id;
}

// ── Write: Issue create (REST) + title/body/state (GraphQL) ──

interface RestIssueResult {
  number: number;
  node_id: string;
  updated_at: string;
  html_url: string;
  state: string;
}

export async function createIssue(
  token: string,
  repoFullName: string,
  input: { title: string; body?: string | null; labels?: string[] },
): Promise<RestIssueResult> {
  const body: Record<string, unknown> = { title: input.title };
  if (input.body) body.body = input.body;
  if (input.labels && input.labels.length > 0) body.labels = input.labels;

  const resp = await fetch(`https://api.github.com/repos/${repoFullName}/issues`, {
    method: 'POST',
    headers: {
      ...GITHUB_API_HEADERS_BASE,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 429) throw new Error('GitHub secondary rate limit (429)');
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub REST error (${resp.status}): ${text}`);
  }
  return (await resp.json()) as RestIssueResult;
}

const UPDATE_ISSUE_MUTATION = /* GraphQL */ `
  mutation ($id: ID!, $title: String, $body: String) {
    updateIssue(input: { id: $id, title: $title, body: $body }) {
      issue { updatedAt }
    }
  }
`;

interface UpdateIssueResult {
  updateIssue: { issue: { updatedAt: string } | null } | null;
}

export async function updateIssueFields(
  token: string,
  issueNodeId: string,
  patch: { title?: string; body?: string | null },
): Promise<string> {
  const data = await githubGraphql<UpdateIssueResult>(token, UPDATE_ISSUE_MUTATION, {
    id: issueNodeId,
    title: patch.title ?? null,
    body: patch.body ?? null,
  });
  return data.updateIssue?.issue?.updatedAt ?? new Date().toISOString();
}

const CLOSE_ISSUE_MUTATION = /* GraphQL */ `
  mutation ($id: ID!, $reason: IssueClosedStateReason!) {
    closeIssue(input: { issueId: $id, stateReason: $reason }) {
      issue { updatedAt }
    }
  }
`;

interface CloseIssueResult {
  closeIssue: { issue: { updatedAt: string } | null } | null;
}

export async function closeIssue(
  token: string,
  issueNodeId: string,
  reason: 'COMPLETED' | 'NOT_PLANNED',
): Promise<string> {
  const data = await githubGraphql<CloseIssueResult>(token, CLOSE_ISSUE_MUTATION, {
    id: issueNodeId,
    reason,
  });
  return data.closeIssue?.issue?.updatedAt ?? new Date().toISOString();
}

const REOPEN_ISSUE_MUTATION = /* GraphQL */ `
  mutation ($id: ID!) {
    reopenIssue(input: { issueId: $id }) {
      issue { updatedAt }
    }
  }
`;

interface ReopenIssueResult {
  reopenIssue: { issue: { updatedAt: string } | null } | null;
}

export async function reopenIssue(token: string, issueNodeId: string): Promise<string> {
  const data = await githubGraphql<ReopenIssueResult>(token, REOPEN_ISSUE_MUTATION, {
    id: issueNodeId,
  });
  return data.reopenIssue?.issue?.updatedAt ?? new Date().toISOString();
}

// ── Status ↔ stage / task-status mapping ─────────────────────

export type StatusOptionMapping = {
  githubOptionId: string;
  githubOptionName: string;
  stageId: string | null;
};

export function stageIdForStatusOption(
  statusOptionMap: StatusOptionMapping[] | null | undefined,
  optionId: string | null,
): string | null {
  if (!statusOptionMap || !optionId) return null;
  return statusOptionMap.find((m) => m.githubOptionId === optionId)?.stageId ?? null;
}

export function statusOptionForStageId(
  statusOptionMap: StatusOptionMapping[] | null | undefined,
  stageId: string | null,
): string | null {
  if (!statusOptionMap || !stageId) return null;
  return statusOptionMap.find((m) => m.stageId === stageId)?.githubOptionId ?? null;
}

export function taskStatusFromIssueState(state: 'OPEN' | 'CLOSED', stateReason: string | null): string {
  if (state === 'OPEN') return 'todo';
  if (stateReason === 'NOT_PLANNED') return 'cancelled';
  return 'done';
}
