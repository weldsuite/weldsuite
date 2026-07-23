import { z } from 'zod';
import { createChannelSchema, updateChannelSchema } from '../../schemas/channels';
import { createChannelMemberSchema, updateChannelMemberSchema } from '../../schemas/channel-members';
import { createChatBookmarkSchema, updateChatBookmarkSchema } from '../../schemas/chat-bookmarks';
import { createChatDraftSchema, updateChatDraftSchema } from '../../schemas/chat-drafts';
import { createChatMessageSchema, updateChatMessageSchema } from '../../schemas/chat-messages';
import { createChatSectionSchema, updateChatSectionSchema } from '../../schemas/chat-sections';
import type { ToolDefinition } from '../registry';

// messageId and channelId are NOT NULL FK columns (chat_messages.id /
// chat_channels.id), so they must be supplied — an empty placeholder would
// violate the foreign key at insert time.
const createChatBookmarkSchemaRequired = createChatBookmarkSchema.extend({
  messageId: z.string().min(1),
  channelId: z.string().min(1),
});

export const chatTools: ToolDefinition[] = [
  // ── Channels ────────────────────────────────────────────────────────────────
  {
    name: 'search_channels',
    scope: 'channels:read',
    description: 'List/search WeldChat channels. Cursor-paginated; filter by name or type.',
    inputSchema: {
      search: z.string().optional().describe('Match against channel name'),
      type: z.string().optional().describe('Filter by channel type (public, private, dm, entity)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/channels',
  },
  {
    name: 'get_channel',
    scope: 'channels:read',
    description: 'Get full details of a WeldChat channel by ID.',
    inputSchema: {
      id: z.string().describe('The channel ID'),
    },
    method: 'GET',
    path: '/v1/channels/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_channel',
    scope: 'channels:write',
    description: 'Create a new WeldChat channel.',
    inputSchema: createChannelSchema.shape,
    method: 'POST',
    path: '/v1/channels',
  },
  {
    name: 'update_channel',
    scope: 'channels:write',
    description: 'Update an existing WeldChat channel by ID.',
    inputSchema: {
      id: z.string().describe('The channel ID'),
      ...updateChannelSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/channels/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_channel',
    scope: 'channels:write',
    description: 'Soft-delete a WeldChat channel by ID.',
    inputSchema: {
      id: z.string().describe('The channel ID'),
    },
    method: 'DELETE',
    path: '/v1/channels/:id',
    pathParams: { id: 'id' },
  },

  // ── Channel members ─────────────────────────────────────────────────────────
  {
    name: 'search_channel_members',
    scope: 'channel_members:read',
    description: 'List/search WeldChat channel members. Cursor-paginated; filter by channelId or userId.',
    inputSchema: {
      channelId: z.string().optional().describe('Filter by channel ID'),
      userId: z.string().optional().describe('Filter by user ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/channel-members',
  },
  {
    name: 'get_channel_member',
    scope: 'channel_members:read',
    description: 'Get full details of a WeldChat channel member by ID.',
    inputSchema: {
      id: z.string().describe('The channel member ID'),
    },
    method: 'GET',
    path: '/v1/channel-members/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_channel_member',
    scope: 'channel_members:write',
    description: 'Add a member to a WeldChat channel.',
    inputSchema: createChannelMemberSchema.shape,
    method: 'POST',
    path: '/v1/channel-members',
  },
  {
    name: 'update_channel_member',
    scope: 'channel_members:write',
    description: 'Update an existing WeldChat channel member by ID.',
    inputSchema: {
      id: z.string().describe('The channel member ID'),
      ...updateChannelMemberSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/channel-members/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_channel_member',
    scope: 'channel_members:write',
    description: 'Hard-delete a WeldChat channel member by ID.',
    inputSchema: {
      id: z.string().describe('The channel member ID'),
    },
    method: 'DELETE',
    path: '/v1/channel-members/:id',
    pathParams: { id: 'id' },
  },

  // ── Chat bookmarks ──────────────────────────────────────────────────────────
  {
    name: 'search_chat_bookmarks',
    scope: 'chat_bookmarks:read',
    description: 'List/search WeldChat bookmarks. Cursor-paginated; filter by userId or channelId.',
    inputSchema: {
      userId: z.string().optional().describe('Filter by user ID'),
      channelId: z.string().optional().describe('Filter by channel ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/chat-bookmarks',
  },
  {
    name: 'get_chat_bookmark',
    scope: 'chat_bookmarks:read',
    description: 'Get full details of a WeldChat bookmark by ID.',
    inputSchema: {
      id: z.string().describe('The chat bookmark ID'),
    },
    method: 'GET',
    path: '/v1/chat-bookmarks/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_chat_bookmark',
    scope: 'chat_bookmarks:write',
    description: 'Create a new WeldChat bookmark.',
    inputSchema: createChatBookmarkSchemaRequired.shape,
    method: 'POST',
    path: '/v1/chat-bookmarks',
  },
  {
    name: 'update_chat_bookmark',
    scope: 'chat_bookmarks:write',
    description: 'Update an existing WeldChat bookmark by ID.',
    inputSchema: {
      id: z.string().describe('The chat bookmark ID'),
      ...updateChatBookmarkSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/chat-bookmarks/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_chat_bookmark',
    scope: 'chat_bookmarks:write',
    description: 'Hard-delete a WeldChat bookmark by ID.',
    inputSchema: {
      id: z.string().describe('The chat bookmark ID'),
    },
    method: 'DELETE',
    path: '/v1/chat-bookmarks/:id',
    pathParams: { id: 'id' },
  },

  // ── Chat drafts ─────────────────────────────────────────────────────────────
  {
    name: 'search_chat_drafts',
    scope: 'chat_drafts:read',
    description: 'List/search WeldChat drafts. Cursor-paginated; filter by channelId or userId.',
    inputSchema: {
      channelId: z.string().optional().describe('Filter by channel ID'),
      userId: z.string().optional().describe('Filter by user ID'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/chat-drafts',
  },
  {
    name: 'get_chat_draft',
    scope: 'chat_drafts:read',
    description: 'Get full details of a WeldChat draft by ID.',
    inputSchema: {
      id: z.string().describe('The chat draft ID'),
    },
    method: 'GET',
    path: '/v1/chat-drafts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_chat_draft',
    scope: 'chat_drafts:write',
    description: 'Create a new WeldChat draft.',
    inputSchema: {
      workspaceId: z.string().describe('The workspace ID (required; not available from token context)'),
      ...createChatDraftSchema.shape,
    },
    method: 'POST',
    path: '/v1/chat-drafts',
  },
  {
    name: 'update_chat_draft',
    scope: 'chat_drafts:write',
    description: 'Update an existing WeldChat draft by ID.',
    inputSchema: {
      id: z.string().describe('The chat draft ID'),
      ...updateChatDraftSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/chat-drafts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_chat_draft',
    scope: 'chat_drafts:write',
    description: 'Hard-delete a WeldChat draft by ID.',
    inputSchema: {
      id: z.string().describe('The chat draft ID'),
    },
    method: 'DELETE',
    path: '/v1/chat-drafts/:id',
    pathParams: { id: 'id' },
  },

  // ── Chat messages ───────────────────────────────────────────────────────────
  {
    name: 'search_chat_messages',
    scope: 'chat_messages:read',
    description: 'List/search WeldChat messages. Cursor-paginated; filter by channelId, parentId, or content search.',
    inputSchema: {
      search: z.string().optional().describe('Match against message content'),
      channelId: z.string().optional().describe('Filter by channel ID'),
      parentId: z.string().optional().describe('Filter by parent message ID (thread replies)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/chat-messages',
  },
  {
    name: 'get_chat_message',
    scope: 'chat_messages:read',
    description: 'Get full details of a WeldChat message by ID.',
    inputSchema: {
      id: z.string().describe('The chat message ID'),
    },
    method: 'GET',
    path: '/v1/chat-messages/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_chat_message',
    scope: 'chat_messages:write',
    description: 'Create a new WeldChat message.',
    inputSchema: createChatMessageSchema.shape,
    method: 'POST',
    path: '/v1/chat-messages',
  },
  {
    name: 'update_chat_message',
    scope: 'chat_messages:write',
    description: 'Update an existing WeldChat message by ID.',
    inputSchema: {
      id: z.string().describe('The chat message ID'),
      ...updateChatMessageSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/chat-messages/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_chat_message',
    scope: 'chat_messages:write',
    description: 'Soft-delete a WeldChat message by ID.',
    inputSchema: {
      id: z.string().describe('The chat message ID'),
    },
    method: 'DELETE',
    path: '/v1/chat-messages/:id',
    pathParams: { id: 'id' },
  },

  // ── Chat sections ───────────────────────────────────────────────────────────
  {
    name: 'search_chat_sections',
    scope: 'chat_sections:read',
    description: 'List/search WeldChat sections. Cursor-paginated; filter by name.',
    inputSchema: {
      search: z.string().optional().describe('Match against section name'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/chat-sections',
  },
  {
    name: 'get_chat_section',
    scope: 'chat_sections:read',
    description: 'Get full details of a WeldChat section by ID.',
    inputSchema: {
      id: z.string().describe('The chat section ID'),
    },
    method: 'GET',
    path: '/v1/chat-sections/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_chat_section',
    scope: 'chat_sections:write',
    description: 'Create a new WeldChat section.',
    inputSchema: createChatSectionSchema.shape,
    method: 'POST',
    path: '/v1/chat-sections',
  },
  {
    name: 'update_chat_section',
    scope: 'chat_sections:write',
    description: 'Update an existing WeldChat section by ID.',
    inputSchema: {
      id: z.string().describe('The chat section ID'),
      ...updateChatSectionSchema.shape,
    },
    method: 'PATCH',
    path: '/v1/chat-sections/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_chat_section',
    scope: 'chat_sections:write',
    description: 'Hard-delete a WeldChat section by ID.',
    inputSchema: {
      id: z.string().describe('The chat section ID'),
    },
    method: 'DELETE',
    path: '/v1/chat-sections/:id',
    pathParams: { id: 'id' },
  },
];
