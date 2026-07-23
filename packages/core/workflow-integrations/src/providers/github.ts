/**
 * GitHub integration — create issues/comments, trigger on issue/PR webhooks.
 * Auth: Personal Access Token (repo scope). Inbound events are delivered to a
 * per-connection webhook URL, verified with the X-Hub-Signature-256 secret
 * stored on the connection.
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
    kind: 'api_key',
    fields: [
      { key: 'token', label: 'Personal Access Token', secret: true, placeholder: 'ghp_...' },
      { key: 'webhookSecret', label: 'Webhook secret (for triggers)', secret: true },
    ],
  },
  actions: [
    {
      id: 'github.create_issue',
      name: 'Create Issue',
      description: 'Open a new issue in a repository.',
      inputs: [
        { key: 'owner', label: 'Owner', type: 'string', required: true },
        { key: 'repo', label: 'Repository', type: 'string', required: true },
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'body', label: 'Body', type: 'text', required: false },
      ],
    },
    {
      id: 'github.create_comment',
      name: 'Create Comment',
      description: 'Comment on an issue or pull request.',
      inputs: [
        { key: 'owner', label: 'Owner', type: 'string', required: true },
        { key: 'repo', label: 'Repository', type: 'string', required: true },
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
