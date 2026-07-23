import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { HonoEnv } from '../../types';
import { error, success } from '../../lib/response';

import activities from './activities';
import appStorage from './app-storage';
import articles from './articles';
import calendarEvents from './calendar-events';
import calendars from './calendars';
import channelMembers from './channel-members';
import channels from './channels';
import chatBookmarks from './chat-bookmarks';
import chatDrafts from './chat-drafts';
import chatMessages from './chat-messages';
import chatSections from './chat-sections';
import companies from './companies';
import conversations from './conversations';
import domains from './domains';
import drive from './drive';
import files from './files';
import folders from './folders';
import goals from './goals';
import knowledgePages from './knowledge-pages';
import knowledgeSpaces from './knowledge-spaces';
import leads from './leads';
import milestones from './milestones';
import opportunities from './opportunities';
import orders from './orders';
import people from './people';
import pipelines from './pipelines';
import pipelineStages from './pipeline-stages';
import productDocuments from './project-documents';
import projectFiles from './project-files';
import projectLabels from './project-labels';
import projectMembers from './project-members';
import projectMessages from './project-messages';
import projectSheets from './project-sheets';
import products from './products';
import projects from './projects';
import quotes from './quotes';
import settings from './settings';
import sprints from './sprints';
import taskComments from './task-comments';
import taskTags from './task-tags';
import tasks from './tasks';
import tickets from './tickets';
import timeEntries from './time-entries';
import userApps from './user-apps';
import socialAccounts from './social-accounts';
import socialAnalytics from './social-analytics';
import socialCampaigns from './social-campaigns';
import socialPosts from './social-posts';
import webhooks from './webhooks';
import whiteboards from './whiteboards';
import workflows from './workflows';

export const v1 = new Hono<HonoEnv>();

v1.get('/', async (c) => {
  const session = c.get('apiSession');
  return success(c, {
    version: 'v1',
    workspace: { id: session.workspaceId, tier: session.tier },
    endpoints: [
      '/v1/activities',
      '/v1/app-storage',
      '/v1/articles',
      '/v1/calendar-events',
      '/v1/calendars',
      '/v1/channel-members',
      '/v1/channels',
      '/v1/chat-bookmarks',
      '/v1/chat-drafts',
      '/v1/chat-messages',
      '/v1/chat-sections',
      '/v1/companies',
      '/v1/conversations',
      '/v1/domains',
      '/v1/drive/all',
      '/v1/drive/stats',
      '/v1/files',
      '/v1/folders',
      '/v1/goals',
      '/v1/knowledge-pages',
      '/v1/knowledge-spaces',
      '/v1/leads',
      '/v1/milestones',
      '/v1/opportunities',
      '/v1/orders',
      '/v1/people',
      '/v1/pipeline-stages',
      '/v1/pipelines',
      '/v1/products',
      '/v1/project-documents',
      '/v1/project-files',
      '/v1/project-labels',
      '/v1/project-members',
      '/v1/project-messages',
      '/v1/project-sheets',
      '/v1/projects',
      '/v1/quotes',
      '/v1/settings',
      '/v1/social-accounts',
      '/v1/social-analytics',
      '/v1/social-campaigns',
      '/v1/social-posts',
      '/v1/sprints',
      '/v1/task-comments',
      '/v1/task-tags',
      '/v1/tasks',
      '/v1/tickets',
      '/v1/time-entries',
      '/v1/user-apps',
      '/v1/webhooks',
      '/v1/whiteboards',
      '/v1/workflows',
    ],
  });
});

v1.get('/health/db', async (c) => {
  const db = c.get('tenantDb');
  const session = c.get('apiSession');
  try {
    await db.execute(sql`SELECT 1`);
    return success(c, {
      status: 'connected',
      workspace: { id: session.workspaceId, tier: session.tier },
      timestamp: new Date().toISOString(),
    });
  } catch {
    return error.internal(c, 'Database connection failed');
  }
});

v1.route('/activities', activities);
v1.route('/app-storage', appStorage);
v1.route('/articles', articles);
v1.route('/calendar-events', calendarEvents);
v1.route('/calendars', calendars);
v1.route('/channel-members', channelMembers);
v1.route('/channels', channels);
v1.route('/chat-bookmarks', chatBookmarks);
v1.route('/chat-drafts', chatDrafts);
v1.route('/chat-messages', chatMessages);
v1.route('/chat-sections', chatSections);
v1.route('/companies', companies);
v1.route('/conversations', conversations);
v1.route('/domains', domains);
v1.route('/drive', drive);
v1.route('/files', files);
v1.route('/folders', folders);
v1.route('/goals', goals);
v1.route('/knowledge-pages', knowledgePages);
v1.route('/knowledge-spaces', knowledgeSpaces);
v1.route('/leads', leads);
v1.route('/milestones', milestones);
v1.route('/opportunities', opportunities);
v1.route('/orders', orders);
v1.route('/people', people);
v1.route('/pipeline-stages', pipelineStages);
v1.route('/pipelines', pipelines);
v1.route('/products', products);
v1.route('/project-documents', productDocuments);
v1.route('/project-files', projectFiles);
v1.route('/project-labels', projectLabels);
v1.route('/project-members', projectMembers);
v1.route('/project-messages', projectMessages);
v1.route('/project-sheets', projectSheets);
v1.route('/projects', projects);
v1.route('/quotes', quotes);
v1.route('/settings', settings);
v1.route('/social-accounts', socialAccounts);
v1.route('/social-analytics', socialAnalytics);
v1.route('/social-campaigns', socialCampaigns);
v1.route('/social-posts', socialPosts);
v1.route('/sprints', sprints);
v1.route('/task-comments', taskComments);
v1.route('/task-tags', taskTags);
v1.route('/tasks', tasks);
v1.route('/tickets', tickets);
v1.route('/time-entries', timeEntries);
v1.route('/user-apps', userApps);
v1.route('/webhooks', webhooks);
v1.route('/whiteboards', whiteboards);
v1.route('/workflows', workflows);
