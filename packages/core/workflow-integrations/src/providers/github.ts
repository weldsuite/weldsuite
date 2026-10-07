/**
 * GitHub integration — create issues/comments, trigger on issue/PR webhooks.
 *
 * Auth: `app_installation`, not a Personal Access Token or a second OAuth
 * app. WeldSuite already has a GitHub App installed per workspace for
 * WeldFlow's issue/PR sync (`github_connections`, one row per workspace,
 * managed from Settings → Integrations → GitHub); WeldConnect reuses that
 * same installation rather than asking the user to authorize a PAT or a
 * second app with overlapping repo access. Connecting from WeldConnect
 * (`POST /api/workflow-integrations/github/link`) just points a
 * `workflow_integrations` row at the existing installation id — see
 * "Provider pattern" in docs/plans/weldconnect.md.
 *
 * Inbound events (`github.issue`, `github.pull_request`) are not wired yet;
 * only the two outbound actions below are activatable yet.
 */

import type { IntegrationDef } from '../types';

export const github: IntegrationDef = {
  id: 'github',
  type: 'github',
  label: 'GitHub',
  description: 'Create issues and comments, and trigger workflows on issue/PR events.',
  category: 'developer',
  icon: 'github',
  auth: {
    kind: 'app_installation',
    appIdEnv: 'GITHUB_APP_ID',
    privateKeyEnv: 'GITHUB_APP_PRIVATE_KEY',
    appSlugEnv: 'GITHUB_APP_SLUG',
  },
  actions: [
    {
      id: 'github.create_issue',
      name: 'Create Issue',
      description: 'Open a new issue in a repository.',
      inputs: [
        {
          key: 'integrationId',
          label: 'Connection',
          type: 'string',
          description: 'Which connected GitHub installation to use, when more than one is connected.',
        },
        { key: 'repo', label: 'Repository', type: 'string', required: true, placeholder: 'owner/repo' },
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'body', label: 'Body', type: 'text', required: false },
        {
          key: 'labels',
          label: 'Labels',
          type: 'string',
          description: 'Comma-separated label names.',
        },
        {
          key: 'assignees',
          label: 'Assignees',
          type: 'string',
          description: 'Comma-separated GitHub usernames.',
        },
      ],
    },
    {
      id: 'github.create_comment',
      name: 'Create Comment',
      description: 'Comment on an issue or pull request.',
      inputs: [
        {
          key: 'integrationId',
          label: 'Connection',
          type: 'string',
          description: 'Which connected GitHub installation to use, when more than one is connected.',
        },
        { key: 'repo', label: 'Repository', type: 'string', required: true, placeholder: 'owner/repo' },
        { key: 'issueNumber', label: 'Issue / PR number', type: 'number', required: true },
        { key: 'body', label: 'Comment', type: 'text', required: true },
      ],
    },
  ],
  triggers: [
    {
      id: 'github.issue',
      name: 'Issue Event',
      description: 'Triggers on issue activity (opened, closed, …).',
      kind: 'webhook',
      outputFields: ['action', 'number', 'title', 'state', 'repository'],
    },
    {
      id: 'github.pull_request',
      name: 'Pull Request Event',
      description: 'Triggers on pull request activity (opened, merged, …).',
      kind: 'webhook',
      outputFields: ['action', 'number', 'title', 'state', 'repository'],
    },
  ],
};
