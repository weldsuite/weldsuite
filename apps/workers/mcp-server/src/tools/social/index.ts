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
    description: 'Get full details of a social post by ID.',
    inputSchema: { id: z.string().describe('The social post ID') },
    method: 'GET',
    path: '/v1/social-posts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_social_post',
    scope: 'social_posts:write',
    description: 'Create a new social post (draft, scheduled, or immediate).',
    inputSchema: createSocialPostSchema.shape,
    method: 'POST',
    path: '/v1/social-posts',
  },
  {
    name: 'update_social_post',
    scope: 'social_posts:write',
    description: 'Update an existing social post by ID.',
    inputSchema: { id: z.string().describe('The social post ID'), ...updateSocialPostSchema.shape },
    method: 'PATCH',
    path: '/v1/social-posts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_social_post',
    scope: 'social_posts:write',
    description: 'Soft-delete a social post by ID.',
    inputSchema: { id: z.string().describe('The social post ID') },
    method: 'DELETE',
    path: '/v1/social-posts/:id',
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
    description: 'Get full details of a connected social account by ID.',
    inputSchema: { id: z.string().describe('The social account ID') },
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
    description: 'Update an existing social account by ID.',
    inputSchema: { id: z.string().describe('The social account ID'), ...createSocialAccountSchema.partial().shape },
    method: 'PATCH',
    path: '/v1/social-accounts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_social_account',
    scope: 'social_accounts:write',
    description: 'Soft-delete (disconnect) a social account by ID.',
    inputSchema: { id: z.string().describe('The social account ID') },
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
    description: 'Get full details of a social campaign by ID.',
    inputSchema: { id: z.string().describe('The social campaign ID') },
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
    description: 'Update an existing social campaign by ID.',
    inputSchema: { id: z.string().describe('The social campaign ID'), ...createSocialCampaignSchema.partial().shape },
    method: 'PATCH',
    path: '/v1/social-campaigns/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_social_campaign',
    scope: 'social_campaigns:write',
    description: 'Soft-delete a social campaign by ID.',
    inputSchema: { id: z.string().describe('The social campaign ID') },
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
