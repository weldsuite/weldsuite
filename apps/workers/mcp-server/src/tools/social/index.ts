import { z } from 'zod';
import {
  createSocialPostSchema,
  updateSocialPostSchema,
} from '../../schemas/social-posts';
import {
  createSocialAccountSchema,
} from '../../schemas/social-accounts';
import {
  createSocialCampaignSchema,
} from '../../schemas/social-campaigns';
import type { ToolDefinition } from '../registry';

export const socialTools: ToolDefinition[] = [
  // ── Social Posts ──────────────────────────────────────────────────────────
  {
    name: 'search_social_posts',
    scope: 'social_posts:read',
    description: 'List/search social posts. Cursor-paginated; filter by status or campaignId.',
    inputSchema: {
      status: z.string().optional().describe('Filter by post status (draft, scheduled, published, etc.)'),
      campaignId: z.string().optional().describe('Filter by campaign ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.coerce.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
    },
    method: 'GET',
    path: '/v1/social-posts',
  },
  {
    name: 'get_social_post',
    scope: 'social_posts:read',
    description: 'Get full details of a social post.',
    inputSchema: { id: z.string().describe('The social post — its name, or the id from an earlier search') },
    method: 'GET',
    path: '/v1/social-posts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_social_post',
    scope: 'social_posts:write',
    description:
      'Create a new social post. This only stores the post — it does not send it. ' +
      'Follow with publish_social_post to post it now, or schedule_social_post to have it go out later; ' +
      'a post created with status "scheduled" is never delivered on its own.',
    inputSchema: createSocialPostSchema.shape,
    method: 'POST',
    path: '/v1/social-posts',
  },
  {
    name: 'update_social_post',
    scope: 'social_posts:write',
    description: 'Update an existing social post.',
    inputSchema: { id: z.string().describe('The social post — its name, or the id from an earlier search'), ...updateSocialPostSchema.shape },
    method: 'PATCH',
    path: '/v1/social-posts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_social_post',
    scope: 'social_posts:write',
    description: 'Delete a social post.',
    inputSchema: { id: z.string().describe('The social post — its name, or the id from an earlier search') },
    method: 'DELETE',
    path: '/v1/social-posts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'publish_social_post',
    scope: 'social_posts:write',
    description:
      'Publish an existing social post to its target channels now. Required to actually post — ' +
      'create_social_post only stores a draft, it never publishes. The post must have at least one ' +
      'connected target account.',
    inputSchema: { id: z.string().describe('The social post — its name, or the id from an earlier search') },
    method: 'POST',
    path: '/v1/social-posts/:id/publish',
    pathParams: { id: 'id' },
  },
  {
    name: 'schedule_social_post',
    scope: 'social_posts:write',
    description:
      'Schedule an existing social post to go out at a future time. Required for the post to actually ' +
      'be delivered — setting a status or scheduledAt via create_social_post/update_social_post only ' +
      'stores those fields and will never publish. Also use this to move an already-scheduled post to ' +
      'a new time.',
    inputSchema: {
      id: z.string().describe('The social post — its name, or the id from an earlier search'),
      scheduledAt: z
        .string()
        .describe('When to publish, ISO-8601 with UTC offset (e.g. 2026-08-05T09:30:00+02:00). Must be in the future.'),
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone the schedule is interpreted in (e.g. Europe/Amsterdam)'),
    },
    method: 'POST',
    path: '/v1/social-posts/:id/schedule',
    pathParams: { id: 'id' },
  },

  // ── Social Accounts ───────────────────────────────────────────────────────
  {
    name: 'search_social_accounts',
    scope: 'social_accounts:read',
    description: 'List/search connected social accounts. Cursor-paginated; filter by platform or status.',
    inputSchema: {
      platform: z.string().optional().describe('Filter by platform (facebook, instagram, twitter, linkedin, tiktok)'),
      status: z.string().optional().describe('Filter by account status (active, inactive, expired, error, pending_reauth)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.coerce.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
    },
    method: 'GET',
    path: '/v1/social-accounts',
  },
  {
    name: 'get_social_account',
    scope: 'social_accounts:read',
    description: 'Get full details of a connected social account.',
    inputSchema: { id: z.string().describe('The social account — its name, or the id from an earlier search') },
    method: 'GET',
    path: '/v1/social-accounts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_social_account',
    scope: 'social_accounts:write',
    description: 'Register a new connected social account.',
    inputSchema: createSocialAccountSchema.shape,
    method: 'POST',
    path: '/v1/social-accounts',
  },
  {
    name: 'update_social_account',
    scope: 'social_accounts:write',
    description: 'Update an existing social account.',
    inputSchema: { id: z.string().describe('The social account — its name, or the id from an earlier search'), ...createSocialAccountSchema.partial().shape },
    method: 'PATCH',
    path: '/v1/social-accounts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_social_account',
    scope: 'social_accounts:write',
    description: 'Delete (disconnect) a social account.',
    inputSchema: { id: z.string().describe('The social account — its name, or the id from an earlier search') },
    method: 'DELETE',
    path: '/v1/social-accounts/:id',
    pathParams: { id: 'id' },
  },

  // ── Social Campaigns ──────────────────────────────────────────────────────
  {
    name: 'search_social_campaigns',
    scope: 'social_campaigns:read',
    description: 'List/search social campaigns. Cursor-paginated; filter by status.',
    inputSchema: {
      status: z.string().optional().describe('Filter by campaign status (draft, active, paused, completed, archived)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.coerce.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
    },
    method: 'GET',
    path: '/v1/social-campaigns',
  },
  {
    name: 'get_social_campaign',
    scope: 'social_campaigns:read',
    description: 'Get full details of a social campaign.',
    inputSchema: { id: z.string().describe('The social campaign — its name, or the id from an earlier search') },
    method: 'GET',
    path: '/v1/social-campaigns/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_social_campaign',
    scope: 'social_campaigns:write',
    description: 'Create a new social campaign.',
    inputSchema: createSocialCampaignSchema.shape,
    method: 'POST',
    path: '/v1/social-campaigns',
  },
  {
    name: 'update_social_campaign',
    scope: 'social_campaigns:write',
    description: 'Update an existing social campaign.',
    inputSchema: { id: z.string().describe('The social campaign — its name, or the id from an earlier search'), ...createSocialCampaignSchema.partial().shape },
    method: 'PATCH',
    path: '/v1/social-campaigns/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_social_campaign',
    scope: 'social_campaigns:write',
    description: 'Delete a social campaign.',
    inputSchema: { id: z.string().describe('The social campaign — its name, or the id from an earlier search') },
    method: 'DELETE',
    path: '/v1/social-campaigns/:id',
    pathParams: { id: 'id' },
  },

  // ── Social Analytics ──────────────────────────────────────────────────────
  {
    name: 'get_social_analytics',
    scope: 'social_analytics:read',
    description: 'List social analytics snapshots. Cursor-paginated; filter by postId or accountId.',
    inputSchema: {
      postId: z.string().optional().describe('Filter by social post ID'),
      accountId: z.string().optional().describe('Filter by social account ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.coerce.number().min(1).max(200).optional().describe('Page size (1-200, default 25)'),
    },
    method: 'GET',
    path: '/v1/social-analytics',
  },
];
