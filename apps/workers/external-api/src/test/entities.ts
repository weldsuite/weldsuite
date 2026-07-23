/**
 * Registry of every external-api entity, driving the data-driven test
 * matrix. Schemas are imported from the exact same modules the routes use
 * (`@weldsuite/core-api-client/schemas/*` + a few from app-api-client), so
 * the test payloads match what the public API actually validates.
 *
 * `scope` is derived from the segment (hyphens → underscores), matching the
 * `requireScope('<scope>:read'|':write')` calls in the routes.
 */

import type { ZodTypeAny } from 'zod';

// app-api-client schemas
import { createCompanySchema, updateCompanySchema } from '@weldsuite/app-api-client/schemas/companies';
import { createProjectSchema, updateProjectSchema } from '@weldsuite/app-api-client/schemas/projects';
import { createTaskSchema, updateTaskSchema } from '@weldsuite/app-api-client/schemas/tasks';
import { createTicketSchema, updateTicketSchema } from '@weldsuite/app-api-client/schemas/tickets';

// core-api-client schemas
import { createActivitySchema, updateActivitySchema } from '@weldsuite/core-api-client/schemas/activities';
import { createArticleSchema, updateArticleSchema } from '@weldsuite/core-api-client/schemas/articles';
import { createCalendarEventSchema, updateCalendarEventSchema } from '@weldsuite/core-api-client/schemas/calendar-events';
import { createCalendarSchema, updateCalendarSchema } from '@weldsuite/core-api-client/schemas/calendars';
import { createChannelMemberSchema, updateChannelMemberSchema } from '@weldsuite/core-api-client/schemas/channel-members';
import { createChannelSchema, updateChannelSchema } from '@weldsuite/core-api-client/schemas/channels';
import { createChatBookmarkSchema, updateChatBookmarkSchema } from '@weldsuite/core-api-client/schemas/chat-bookmarks';
import { createChatDraftSchema, updateChatDraftSchema } from '@weldsuite/core-api-client/schemas/chat-drafts';
import { createChatMessageSchema, updateChatMessageSchema } from '@weldsuite/core-api-client/schemas/chat-messages';
import { createChatSectionSchema, updateChatSectionSchema } from '@weldsuite/core-api-client/schemas/chat-sections';
import { createConversationSchema, updateConversationSchema } from '@weldsuite/core-api-client/schemas/conversations';
import { createDomainSchema, updateDomainSchema } from '@weldsuite/core-api-client/schemas/domains';
import { createFileSchema, updateFileSchema } from '@weldsuite/core-api-client/schemas/files';
import { createFolderSchema, updateFolderSchema } from '@weldsuite/core-api-client/schemas/folders';
import { createGoalSchema, updateGoalSchema } from '@weldsuite/core-api-client/schemas/goals';
import { createKnowledgeSpaceSchema, updateKnowledgeSpaceSchema } from '@weldsuite/core-api-client/schemas/knowledge';
import { createLeadSchema, updateLeadSchema } from '@weldsuite/core-api-client/schemas/leads';
import { createMilestoneSchema, updateMilestoneSchema } from '@weldsuite/core-api-client/schemas/milestones';
import { createOpportunitySchema, updateOpportunitySchema } from '@weldsuite/core-api-client/schemas/opportunities';
import { createOrderSchema, updateOrderSchema } from '@weldsuite/core-api-client/schemas/orders';
import { createPersonSchema, updatePersonSchema } from '@weldsuite/core-api-client/schemas/people';
import { createPipelineStageSchema, updatePipelineStageSchema } from '@weldsuite/core-api-client/schemas/pipeline-stages';
import { createPipelineSchema, updatePipelineSchema } from '@weldsuite/core-api-client/schemas/pipelines-crm';
import { createProductSchema, updateProductSchema } from '@weldsuite/core-api-client/schemas/products';
import { createProjectDocumentSchema, updateProjectDocumentSchema } from '@weldsuite/core-api-client/schemas/project-documents';
import { createProjectFileSchema, updateProjectFileSchema } from '@weldsuite/core-api-client/schemas/project-files';
import { createProjectLabelSchema, updateProjectLabelSchema } from '@weldsuite/core-api-client/schemas/project-labels';
import { createProjectMemberSchema, updateProjectMemberSchema } from '@weldsuite/core-api-client/schemas/project-members';
import { createProjectMessageSchema, updateProjectMessageSchema } from '@weldsuite/core-api-client/schemas/project-messages';
import { createSprintSchema, updateSprintSchema } from '@weldsuite/core-api-client/schemas/sprints';
import { createTaskCommentSchema, updateTaskCommentSchema } from '@weldsuite/core-api-client/schemas/task-comments';
import { createTaskTagSchema, updateTaskTagSchema } from '@weldsuite/core-api-client/schemas/task-tags';
import { createSocialAccountSchema, updateSocialAccountSchema } from '@weldsuite/core-api-client/schemas/social-accounts';
import { createSocialAnalyticsSchema, updateSocialAnalyticsSchema } from '@weldsuite/core-api-client/schemas/social-analytics';
import { createSocialCampaignSchema, updateSocialCampaignSchema } from '@weldsuite/core-api-client/schemas/social-campaigns';
import { createSocialPostSchema, updateSocialPostSchema } from '@weldsuite/core-api-client/schemas/social-posts';
import { createWhiteboardSchema, updateWhiteboardSchema } from '@weldsuite/core-api-client/schemas/whiteboards';
import { createWorkflowSchema, updateWorkflowSchema } from '@weldsuite/core-api-client/schemas/weldconnect';

export interface CrudEntity {
  /** URL + collection segment under /v1. */
  seg: string;
  /** Scope namespace (hyphens → underscores). */
  scope: string;
  /** Create body schema, or null for routes whose schema is defined inline. */
  create: ZodTypeAny | null;
  /** Update body schema, or null for inline. */
  update: ZodTypeAny | null;
}

function e(seg: string, create: ZodTypeAny | null, update: ZodTypeAny | null): CrudEntity {
  return { seg, scope: seg.replace(/-/g, '_'), create, update };
}

/** All entities exposing the standard CRUD routes (List/Get/Create/Update/Delete). */
export const CRUD_ENTITIES: CrudEntity[] = [
  e('activities', createActivitySchema, updateActivitySchema),
  e('articles', createArticleSchema, updateArticleSchema),
  e('calendar-events', createCalendarEventSchema, updateCalendarEventSchema),
  e('calendars', createCalendarSchema, updateCalendarSchema),
  e('channel-members', createChannelMemberSchema, updateChannelMemberSchema),
  e('channels', createChannelSchema, updateChannelSchema),
  e('chat-bookmarks', createChatBookmarkSchema, updateChatBookmarkSchema),
  e('chat-drafts', createChatDraftSchema, updateChatDraftSchema),
  e('chat-messages', createChatMessageSchema, updateChatMessageSchema),
  e('chat-sections', createChatSectionSchema, updateChatSectionSchema),
  e('companies', createCompanySchema, updateCompanySchema),
  e('conversations', createConversationSchema, updateConversationSchema),
  e('domains', createDomainSchema, updateDomainSchema),
  e('files', createFileSchema, updateFileSchema),
  e('folders', createFolderSchema, updateFolderSchema),
  e('goals', createGoalSchema, updateGoalSchema),
  // Both knowledge segments share the `knowledge` scope namespace, so the
  // seg→scope derivation in e() doesn't apply.
  { seg: 'knowledge-pages', scope: 'knowledge', create: null, update: null }, // inline schema in the route (plain-text `content` variant)
  { seg: 'knowledge-spaces', scope: 'knowledge', create: createKnowledgeSpaceSchema, update: updateKnowledgeSpaceSchema },
  e('leads', createLeadSchema, updateLeadSchema),
  e('milestones', createMilestoneSchema, updateMilestoneSchema),
  e('opportunities', createOpportunitySchema, updateOpportunitySchema),
  e('orders', createOrderSchema, updateOrderSchema),
  e('people', createPersonSchema, updatePersonSchema),
  e('pipeline-stages', createPipelineStageSchema, updatePipelineStageSchema),
  e('pipelines', createPipelineSchema, updatePipelineSchema),
  e('products', createProductSchema, updateProductSchema),
  e('project-documents', createProjectDocumentSchema, updateProjectDocumentSchema),
  e('project-files', createProjectFileSchema, updateProjectFileSchema),
  e('project-labels', createProjectLabelSchema, updateProjectLabelSchema),
  e('project-members', createProjectMemberSchema, updateProjectMemberSchema),
  e('project-messages', createProjectMessageSchema, updateProjectMessageSchema),
  e('projects', createProjectSchema, updateProjectSchema),
  e('quotes', null, null), // inline schema in the route
  e('social-accounts', createSocialAccountSchema, updateSocialAccountSchema),
  e('social-analytics', createSocialAnalyticsSchema, updateSocialAnalyticsSchema),
  e('social-campaigns', createSocialCampaignSchema, updateSocialCampaignSchema),
  e('social-posts', createSocialPostSchema, updateSocialPostSchema),
  e('sprints', createSprintSchema, updateSprintSchema),
  e('task-comments', createTaskCommentSchema, updateTaskCommentSchema),
  e('task-tags', createTaskTagSchema, updateTaskTagSchema),
  e('tasks', createTaskSchema, updateTaskSchema),
  e('tickets', createTicketSchema, updateTicketSchema),
  e('time-entries', null, null), // inline schema in the route
  e('webhooks', null, null), // inline schema in the route
  e('whiteboards', createWhiteboardSchema, updateWhiteboardSchema),
  e('workflows', createWorkflowSchema, updateWorkflowSchema),
];
